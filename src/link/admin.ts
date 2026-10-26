import { Buffer } from "node:buffer";
import { randomBytes, randomInt } from "node:crypto";
import { basename, isAbsolute } from "node:path";
import { BIP39_ENGLISH } from "./bip39-english.ts";
import { editLinkConfig, type Level, LEVELS, type LinkConfig, type Share } from "./config.ts";
import { type DeviceKeys, idOk, keyRecordHash, labelOk, recordOf, shortId } from "./device.ts";
import { ConflictError, NetworkError, NotFoundError, RateLimitedError, type RelayError, UnauthorizedError, UnprocessableError } from "./errors.ts";
import { decodeInvite, encodeInvite, inviteHash, openJoinRequest, relayOk, buildJoinRequest, checkJoiner, safetyWords, type Invite } from "./join.ts";
import type { RelayPort } from "./holder.ts";
import { addEntry, createEntry, encodeEntry, removeEntry, roleEntry, rotateEntry, type Role, type RosterEntry, type RosterState } from "./roster.ts";
import { projectProblem } from "./routing.ts";
import type { InviteFile, LinkStore, TeamFile } from "./store.ts";
import type { Presence } from "./kinds.ts";

// What the GUI (and an approved `link_request`) does to teams (docs/specs/2026-10-25-straw-link.md, GUI, Joining with a QR code, Roster): create a
// team, invite a computer, take its join request and compare the safety words, join a team, change the roster, set trust, and leave. Every one of
// them runs in the link holder, which alone holds the keys and writes the team files; the page and the requesting session only ask. The spec is
// the authority on each rule; where it left a choice, the build record at its end says what this code chose.

export interface Fail { ok: false; error: string }
export type Done<T = object> = ({ ok: true } & T) | Fail;
const no = (error: string): Fail => ({ ok: false, error });

/** The part of a running team the admin needs; the holder's `TeamRun` has all of it. */
export interface AdminRun { team: string; teamId: Buffer; client: RelayPort; dead: string | undefined; presences: Map<string, { at: number; presence: Presence }>; downSince: number | undefined }

/** What the holder lends the admin: its files, its device, its teams, and the few of its steps an admin op needs. */
export interface AdminHost {
	store: LinkStore;
	stateDir: string;
	home: string;
	agentDir: string;
	now(): number;
	device(): { keys: DeviceKeys; label: string };
	config(): LinkConfig;
	relayFor(url: string, device: DeviceKeys): RelayPort;
	runs(): AdminRun[];
	load(team: string): { tf: TeamFile; state: RosterState };
	takeEntries(run: AdminRun, entries: RosterEntry[]): Promise<void>;
	syncRoster(run: AdminRun): Promise<void>;
	refresh(): Promise<void>;
	stopTeam(team: string): Promise<void>;
	notify(text: string, level?: "info" | "warning" | "error"): void;
	log(entry: Record<string, unknown>): void;
}

/** The invite lasts 10 minutes, or up to 24 hours for an unattended device's pinned id (the relay's own limit is 24 hours of its clock). */
export const INVITE_MS = 10 * 60_000, PINNED_INVITE_MS = 24 * 3600_000 - 5 * 60_000;
const JOIN_WAIT_MS = 11 * 60_000;
const MAX_JOIN_REQUESTS = 10;

/** A relay refusal in words the boss can act on. */
export function relayText(error: unknown, url = ""): string {
	if (error instanceof NetworkError) return `Could not reach the relay${url ? ` at ${url}` : ""}: ${error.message}`;
	if (error instanceof UnauthorizedError) return error.code === "bad-token" ? "The relay did not accept the team token. A token works once: ask the relay's operator for another" : `The relay refused this device (${error.code}); it may not be a member, or its clock is off`;
	if (error instanceof NotFoundError) return "The relay does not know this invite: it lapsed, or it is not from this relay";
	if (error instanceof ConflictError) return error.code === "invite-used" ? "The invite was used already; ask for a new one" : error.code === "team-exists" ? "The relay has this team already" : `The relay answered a conflict (${error.code})`;
	if (error instanceof RateLimitedError) return `The relay is busy or full (${error.code}); try again later`;
	if (error instanceof UnprocessableError) return `The relay refused it: ${error.code}`;
	return (error as RelayError).code ? `The relay answered ${(error as RelayError).status} ${(error as RelayError).code}` : (error as Error).message;
}

/** The relay URL as an origin, or undefined when it is not one a team can use (https, or http on this computer; no path, query, or fragment). */
function originOf(raw: string): string | undefined {
	try {
		const url = new URL(raw.trim());
		return relayOk(raw.trim()) && url.pathname === "/" && !url.search && !url.hash ? url.origin : undefined;
	} catch {
		return undefined;
	}
}

const wordsOf = (): string[] => Array.from({ length: 4 }, () => BIP39_ENGLISH[randomInt(BIP39_ENGLISH.length)]!);
const shuffle = <T>(items: T[]): T[] => {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

interface JoinReq {
	hash: string;
	team: string;
	record: ReturnType<typeof recordOf>;
	label: string;
	unattended: boolean;
	sets: string[][];
	correct: number;
	at: number;
	expires: number;
}
interface Joining {
	id: string;
	invite: Invite;
	label: string;
	words: string[];
	startedAt: number;
	expires: number;
	state: "waiting" | "verified" | "done" | "failed";
	error?: string;
	project?: string;
	share: Share;
	team?: string;
	file?: TeamFile;
	abort: AbortController;
}

export interface JoinRequestView { id: string; team: string; teamName: string; label: string; short: string; unattended: boolean; sets: string[][]; expires: number }
export interface JoinView { id: string; state: Joining["state"]; label: string; words: string[]; expires: number; pinned: boolean; error?: string; team?: string; needsProject: boolean }
export interface InviteView { hash: string; team: string; teamName: string; forDevice: string; created: number; expires: number }
export interface MemberView { id: string; short: string; label: string; labelKnown: boolean; duplicate: boolean; role: Role; attended: boolean; self: boolean; online: boolean; seenAgoMs: number | null; headSeq: number | null; trust: Level }
export interface TeamView {
	team: string;
	name: string;
	project: string;
	share: Share;
	relay: string;
	epoch: number;
	headSeq: number;
	self: { role: Role; attended: boolean };
	members: MemberView[];
	status: "running" | "stopped";
	stoppedWhy?: string;
	relayDown: boolean;
	/** Attended members an admin could make a second attended admin: set when this device is the team's only attended admin and the team has another attended device. */
	secondAdmin: string[];
	onlyAdmin: boolean;
}
export interface Prefill { kind: "join" | "create"; text?: string; relay?: string; project?: string; share?: Share; reason: string; session: string }

/** `a.b` ids and labels the page shows are data: it puts them in text nodes only. */
export class TeamAdmin {
	private readonly h: AdminHost;
	private requests = new Map<string, JoinReq>();
	private joining: Joining | undefined;
	prefill: Prefill | undefined;

	constructor(host: AdminHost) {
		this.h = host;
	}

	private get self(): DeviceKeys {
		return this.h.device().keys;
	}
	private run(team: string): AdminRun | Fail {
		const run = this.h.runs().find((r) => r.team === team);
		return run && !run.dead ? run : no(run?.dead ? `Team ${team.slice(0, 6)} is stopped: ${run.dead}` : "That team is not running on this computer");
	}
	private teamName(team: string): string {
		return this.h.config().teams.get(team)?.name ?? team.slice(0, 6);
	}

	// ---- Create ------------------------------------------------------------------------------------------------------------------

	async createTeam(i: { relay: string; token: string; project: string; share?: Share; label?: string }): Promise<Done<{ team: string; name: string }>> {
		const dev = this.h.device(), label = (i.label ?? dev.label).trim();
		const origin = originOf(i.relay);
		if (!origin) return no("The relay has to be an https origin like https://relay.example, without a path (http only for this computer)");
		if (!i.token.trim()) return no("The relay's operator gives a team token; paste it");
		if (!labelOk(label)) return no("A label is 1 to 40 letters, digits, spaces, and . _ - with no space at either end");
		if (!isAbsolute(i.project)) return no("Pick the project folder");
		const problem = projectProblem(i.project, { home: this.h.home, agentDir: this.h.agentDir });
		if (problem) return no(problem);
		if (i.share !== undefined && i.share !== "presence" && i.share !== "status") return no('Share is "presence" or "status"');
		const team = randomBytes(16), teamKey = randomBytes(32), id = team.toString("hex");
		const entry = createEntry({ team, founder: dev.keys, label, teamKey });
		try {
			await this.h.relayFor(origin, dev.keys).createTeam({ team, token: i.token.trim(), entry });
		} catch (error) {
			return no(relayText(error, origin));
		}
		const file: TeamFile = { v: 1, team: id, relay: origin, entries: [b64(encodeEntry(entry))], keys: { "1": teamKey.toString("hex") }, lastEventId: 0, lastSeq: {} };
		await this.h.store.withLock(() => {
			this.h.store.createTeam(file);
			this.saveTeam(id, i.project, i.share ?? "status", origin);
		});
		await this.h.refresh();
		this.h.log({ event: "team-created", team: id });
		return { ok: true, team: id, name: basename(i.project) };
	}

	private saveTeam(team: string, project: string, share: Share, relay?: string) {
		editLinkConfig(this.h.stateDir, (link) => {
			const teams = (typeof link.teams === "object" && link.teams !== null && !Array.isArray(link.teams) ? link.teams : {}) as Record<string, unknown>;
			teams[team] = { project, share };
			link.teams = teams;
			if (relay && typeof link.relay !== "string") link.relay = relay;
		});
	}

	// ---- Invite and the join request ---------------------------------------------------------------------------------------------

	async invite(i: { team: string; forDevice?: string }): Promise<Done<{ text: string; expires: number; hash: string }>> {
		const run = this.run(i.team);
		if ("ok" in run) return run;
		const { state, tf } = this.h.load(i.team), me = state.members.get(this.self.id);
		if (!me?.attended) return no("Only an attended member of the team can invite");
		const forDevice = (i.forDevice ?? "").trim().toLowerCase();
		if (forDevice) {
			if (!idOk(forDevice)) return no("A device id is 26 characters (a to z, 2 to 7), the one in the unattended device's link/device.id");
			if (state.members.has(forDevice)) return no("That device is in the team already");
			if (state.banned.has(forDevice)) return no("That device was removed from the team and may not come back with the same keys");
		}
		const secret = randomBytes(32), hash = inviteHash(secret), now = this.h.now(), expires = now + (forDevice ? PINNED_INVITE_MS : INVITE_MS);
		try {
			await run.client.createInvite({ team: run.teamId, hash, expires });
		} catch (error) {
			return no(relayText(error, tf.relay));
		}
		const file: InviteFile = { v: 1, hash: hash.toString("hex"), secret: secret.toString("hex"), team: i.team, forDevice, created: now, expires };
		await this.h.store.withLock(() => this.h.store.putInvite(file));
		return { ok: true, text: this.textOf(file, tf.relay), expires, hash: file.hash };
	}
	private textOf(file: InviteFile, relay: string): string {
		return encodeInvite({ relay, team: Buffer.from(file.team, "hex"), secret: Buffer.from(file.secret, "hex"), inviterId: this.self.id, inviterKeyHash: keyRecordHash(this.self), forDevice: file.forDevice });
	}
	/** The text of an invite still on disk, for the page that was reloaded; never part of the shared state. */
	inviteText(hash: string): Done<{ text: string; expires: number }> {
		const file = this.h.store.readInvite(hash);
		if (!file || file.expires <= this.h.now()) return no("That invite has lapsed");
		try {
			return { ok: true, text: this.textOf(file, this.h.load(file.team).tf.relay), expires: file.expires };
		} catch (error) {
			return no((error as Error).message);
		}
	}
	async cancelInvite(hash: string): Promise<Done> {
		await this.h.store.withLock(() => this.h.store.removeInvite(hash));
		return { ok: true };
	}

	/** A join request for one of this device's invites arrived on a team's stream. */
	async onJoin(run: AdminRun, event: { hash: Buffer; request: Buffer }): Promise<void> {
		const hex = event.hash.toString("hex"), file = this.h.store.readInvite(hex);
		if (!file || file.team !== run.team) return void this.h.log({ event: "join-unknown", team: run.team, hash: hex.slice(0, 8) });
		if (this.requests.has(hex)) return;
		const end = async (why: string) => {
			this.h.log({ event: "join-refused", team: run.team, why });
			this.h.notify(`Straw Link: a join request for your invite was refused (${why}); ask for a new one`, "warning");
			await this.h.store.withLock(() => this.h.store.removeInvite(hex));
		};
		if (file.expires <= this.h.now()) return void (await end("the invite had lapsed"));
		let state: RosterState;
		try {
			state = this.h.load(run.team).state;
		} catch (error) {
			return void this.h.log({ event: "join-failed", team: run.team, error: String(error) });
		}
		const me = state.members.get(this.self.id);
		if (!me?.attended) return void (await end("this device is not an attended member"));
		const opened = openJoinRequest({ team: run.teamId, secret: Buffer.from(file.secret, "hex"), blob: event.request, forDevice: file.forDevice, roster: state });
		if (!opened.ok) return void (await end(opened.reason));
		if (this.requests.size >= MAX_JOIN_REQUESTS) return void (await end("too many requests wait"));
		const words = safetyWords({ team: run.teamId, inviterKeyHash: keyRecordHash(this.self), joiner: opened.record, secret: Buffer.from(file.secret, "hex") });
		const pool = [words];
		while (pool.length < 3) {
			const decoy = wordsOf();
			if (!pool.some((p) => p.join(" ") === decoy.join(" "))) pool.push(decoy);
		}
		const sets = shuffle(pool);
		this.requests.set(hex, { hash: hex, team: run.team, record: opened.record, label: opened.label, unattended: file.forDevice !== "", sets, correct: sets.findIndex((s) => s.join(" ") === words.join(" ")), at: this.h.now(), expires: file.expires });
		this.h.notify(`Straw Link: ${opened.label} (${shortId(opened.record.id)}) asks to join team ${this.teamName(run.team)}`, "warning");
	}

	/** The boss decides a join request: an attended joiner by tapping the set of words its screen shows, an unattended one by approving. */
	async decide(i: { id: string; pick?: number; approve?: boolean }): Promise<Done<{ joined: boolean }>> {
		const req = this.requests.get(i.id);
		if (!req) return no("That join request is gone: it was decided, or the invite lapsed");
		const drop = async () => {
			this.requests.delete(i.id);
			await this.h.store.withLock(() => this.h.store.removeInvite(i.id));
		};
		if (req.expires <= this.h.now()) return (await drop(), no("The invite lapsed"));
		if (req.unattended ? i.approve !== true : i.pick !== req.correct) {
			await drop();
			this.h.log({ event: "join-declined", team: req.team, unattended: req.unattended });
			return req.unattended || i.approve === false || i.pick === undefined ? { ok: true, joined: false } : no("Those were not the words on the new computer's screen, so the invite is ended and nobody joined. If the words looked right, ask for a new invite; if not, someone else may have seen this one");
		}
		const run = this.run(req.team);
		if ("ok" in run) return run;
		try {
			await this.append(run, (state) => addEntry({ state, signer: this.self, record: req.record, label: req.label, attended: !req.unattended }));
		} catch (error) {
			await drop();
			return no(error instanceof Error && !(error as RelayError).code ? error.message : relayText(error));
		}
		await drop();
		this.h.log({ event: "joined", team: req.team, device: req.record.id });
		return { ok: true, joined: true };
	}

	/** Posts an entry built on the current head; a moved head is fetched and the entry built again. */
	private async append(run: AdminRun, build: (state: RosterState) => RosterEntry): Promise<RosterEntry> {
		for (let attempt = 0; attempt < 4; attempt++) {
			const entry = build(this.h.load(run.team).state);
			try {
				await run.client.appendRoster(run.teamId, entry);
			} catch (error) {
				if (error instanceof ConflictError) {
					await this.h.syncRoster(run);
					continue;
				}
				throw error;
			}
			await this.h.takeEntries(run, [entry]);
			return entry;
		}
		throw new Error("The roster kept changing under this request; try again");
	}

	// ---- Join ------------------------------------------------------------------------------------------------------------------

	async joinStart(i: { text: string; label?: string }): Promise<Done<{ words: string[]; expires: number; pinned: boolean }>> {
		const invite = decodeInvite(i.text);
		if (!invite) return no("That is not a Straw Link invite: it starts with strawlink1:");
		const dev = this.h.device(), label = (i.label ?? dev.label).trim();
		if (!labelOk(label)) return no("A label is 1 to 40 letters, digits, spaces, and . _ - with no space at either end");
		const id = invite.team.toString("hex");
		if (this.h.store.teamIds().includes(id)) return no("This computer is in that team already");
		if (invite.forDevice && invite.forDevice !== dev.keys.id) return no(`This invite is for another device (${shortId(invite.forDevice)}), not this one (${dev.keys.shortId})`);
		this.joining?.abort.abort();
		const relay = this.h.relayFor(invite.relay, dev.keys), pinned = invite.forDevice !== "";
		try {
			await relay.join(inviteHash(invite.secret), buildJoinRequest({ team: invite.team, secret: invite.secret, record: recordOf(dev.keys), label }));
		} catch (error) {
			return no(relayText(error, invite.relay));
		}
		const words = safetyWords({ team: invite.team, inviterKeyHash: invite.inviterKeyHash, joiner: recordOf(dev.keys), secret: invite.secret });
		const startedAt = this.h.now(), joining: Joining = { id: randomBytes(8).toString("hex"), invite, label, words, startedAt, expires: startedAt + (pinned ? PINNED_INVITE_MS : JOIN_WAIT_MS), state: "waiting", share: "status", abort: new AbortController() };
		this.joining = joining;
		void this.awaitMembership(joining, relay, dev.keys).catch((error: Error) => this.failJoin(joining, error.message));
		return { ok: true, words, expires: joining.expires, pinned };
	}
	private failJoin(j: Joining, error: string) {
		if (j.state === "done") return;
		j.state = "failed";
		j.error = error;
	}
	private async awaitMembership(j: Joining, relay: RelayPort, keys: DeviceKeys): Promise<void> {
		const { signal } = j.abort;
		let delay = 1500;
		while (!signal.aborted) {
			if (this.h.now() > j.expires) return this.failJoin(j, "Nobody confirmed the words in time: the invite lapsed. Ask for a new one");
			try {
				const { entries } = await relay.getRoster(j.invite.team, undefined, signal);
				const checked = checkJoiner({ invite: j.invite, self: keys, entries: entries.map((e) => e.entry), label: j.label });
				if (!checked.ok) return this.failJoin(j, `The roster the relay showed is not the inviter's (${checked.reason}); this computer did not join`);
				const state = checked.state;
				j.file = { v: 1, team: j.invite.team.toString("hex"), relay: j.invite.relay, entries: entries.map((e) => b64(encodeEntry(e.entry))), keys: Object.fromEntries([...state.keys].map(([epoch, key]) => [String(epoch), key.toString("hex")])), lastEventId: 0, lastSeq: {} };
				j.team = j.file.team;
				j.state = "verified";
				return void (await this.finishJoin(j));
			} catch (error) {
				if (signal.aborted) return;
				const notYet = error instanceof UnauthorizedError && error.code === "not-member";
				if (!notYet && !(error instanceof NetworkError) && !(error instanceof RateLimitedError) && !(error as RelayError).status?.toString().startsWith("5")) return this.failJoin(j, relayText(error, j.invite.relay));
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delay);
				timer.unref();
				signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
			});
			delay = Math.min(delay + 500, 4000);
		}
	}
	/** The project folder and share of a team being joined, picked on the join screen; the join completes once both it and the roster check are in. */
	async joinProject(i: { project: string; share?: Share }): Promise<Done> {
		const j = this.joining;
		if (!j || j.state === "failed" || j.state === "done") return no("There is no join in progress");
		if (!isAbsolute(i.project)) return no("Pick the project folder");
		const problem = projectProblem(i.project, { home: this.h.home, agentDir: this.h.agentDir });
		if (problem) return no(problem);
		if (i.share !== undefined && i.share !== "presence" && i.share !== "status") return no('Share is "presence" or "status"');
		j.project = i.project;
		j.share = i.share ?? "status";
		if (j.state === "verified") await this.finishJoin(j);
		return { ok: true };
	}
	private async finishJoin(j: Joining): Promise<void> {
		if (j.state === "done" || !j.file) return;
		if (j.project === undefined) return void this.h.notify(`Straw Link: you were added to team ${j.file.team.slice(0, 6)}; pick its project folder on the join screen to finish`, "info");
		const file = j.file, project = j.project;
		await this.h.store.withLock(() => {
			if (!this.h.store.teamIds().includes(file.team)) this.h.store.createTeam(file);
			this.saveTeam(file.team, project, j.share, j.invite.relay);
		});
		j.state = "done";
		await this.h.refresh();
		this.h.log({ event: "joined-team", team: file.team });
	}
	cancelJoin(): void {
		this.joining?.abort.abort();
		this.joining = undefined;
	}
	/** True while a join waits for its project folder, so the holder does not nag about a team file that has no config entry yet. */
	joiningTeam(): string | undefined {
		return this.joining && this.joining.state !== "done" && this.joining.state !== "failed" ? this.joining.file?.team : undefined;
	}

	// ---- Roster ------------------------------------------------------------------------------------------------------------------

	private async admin(team: string, what: string, build: (state: RosterState, me: NonNullable<ReturnType<RosterState["members"]["get"]>>) => RosterEntry): Promise<Done> {
		const run = this.run(team);
		if ("ok" in run) return run;
		try {
			const mine = this.h.load(team).state.members.get(this.self.id);
			if (mine?.role !== "admin") return no(`Only an admin of the team can ${what}`);
			await this.append(run, (state) => build(state, state.members.get(this.self.id)!));
		} catch (error) {
			return no(error instanceof UnprocessableError ? relayText(error) : (error as RelayError).code ? relayText(error) : (error as Error).message);
		}
		return { ok: true };
	}
	private attendedAdmins(state: RosterState, without?: string, role?: [string, Role]) {
		return [...state.members].filter(([id, m]) => id !== without && (role?.[0] === id ? role[1] : m.role) === "admin" && m.attended).length;
	}
	remove(i: { team: string; device: string }): Promise<Done> {
		return this.admin(i.team, "remove a device", (state) => {
			if (i.device === this.self.id) throw new Error("This device cannot remove itself; leave the team instead");
			if (!state.members.has(i.device)) throw new Error("That device is not in the team");
			if (this.attendedAdmins(state, i.device) === 0) throw new Error("That would leave the team without an attended admin");
			return removeEntry({ state, signer: this.self, subjectId: i.device, newKey: randomBytes(32) });
		});
	}
	role(i: { team: string; device: string; role: Role }): Promise<Done> {
		return this.admin(i.team, "change a role", (state) => {
			const m = state.members.get(i.device);
			if (i.role !== "admin" && i.role !== "member") throw new Error("A role is admin or member");
			if (!m) throw new Error("That device is not in the team");
			if (m.role === i.role) throw new Error(`That device is a ${i.role} already`);
			if (i.role === "admin" && !m.attended) throw new Error("An unattended device never becomes an admin");
			if (this.attendedAdmins(state, undefined, [i.device, i.role]) === 0) throw new Error("That would leave the team without an attended admin");
			return roleEntry({ state, signer: this.self, subjectId: i.device, role: i.role });
		});
	}
	rotate(i: { team: string }): Promise<Done> {
		return this.admin(i.team, "rotate the key", (state) => rotateEntry({ state, signer: this.self, newKey: randomBytes(32) }));
	}

	// ---- Trust and leaving -------------------------------------------------------------------------------------------------------

	async trust(i: { device: string; level: Level }): Promise<Done> {
		if (!LEVELS.includes(i.level)) return no("A trust level is reply, forward, or dispatch");
		const id = i.device.trim().toLowerCase();
		if (id === this.self.id) return no("Trust names other devices");
		const known = this.h.runs().some((r) => !r.dead && this.h.load(r.team).state.members.has(id));
		if (!known) return no("That device is in none of this computer's teams");
		await this.h.store.withLock(() => editLinkConfig(this.h.stateDir, (link) => {
			const trust = (typeof link.trust === "object" && link.trust !== null && !Array.isArray(link.trust) ? link.trust : {}) as Record<string, unknown>;
			if (i.level === "reply") delete trust[id];
			else trust[id] = i.level;
			link.trust = trust;
		}));
		return { ok: true };
	}

	async leave(i: { team: string; force?: boolean }): Promise<Done> {
		const policy = this.h.config().teams.get(i.team);
		if (!policy && !this.h.store.teamIds().includes(i.team)) return no("That team is not on this computer");
		let others = 0, onlyAdmin = false;
		try {
			const { state } = this.h.load(i.team), me = state.members.get(this.self.id);
			others = state.members.size - 1;
			onlyAdmin = Boolean(me?.role === "admin" && me.attended && this.attendedAdmins(state, this.self.id) === 0);
		} catch { /* a team file that cannot be read can still be left */ }
		if (onlyAdmin && others > 0 && i.force !== true) return no("This device is the team's only attended admin. If it leaves, nobody can remove a device or rotate the key; make a second admin first, or leave anyway");
		await this.h.stopTeam(i.team);
		await this.h.store.withLock(() => {
			this.h.store.removeTeam(i.team);
			editLinkConfig(this.h.stateDir, (link) => {
				if (typeof link.teams === "object" && link.teams !== null && !Array.isArray(link.teams)) delete (link.teams as Record<string, unknown>)[i.team];
			});
		});
		for (const [id, r] of this.requests) if (r.team === i.team) this.requests.delete(id);
		this.h.log({ event: "left", team: i.team });
		return { ok: true };
	}

	// ---- What the page shows ---------------------------------------------------------------------------------------------------------

	teamViews(): TeamView[] {
		const config = this.h.config(), now = this.h.now();
		return this.h.runs().flatMap((run): TeamView[] => {
			let loaded: ReturnType<AdminHost["load"]>;
			try {
				loaded = this.h.load(run.team);
			} catch {
				return [];
			}
			const { state, tf } = loaded, policy = config.teams.get(run.team), me = state.members.get(this.self.id);
			const counts = new Map<string, number>();
			for (const m of state.members.values()) if (m.label !== undefined) counts.set(m.label, (counts.get(m.label) ?? 0) + 1);
			const members = [...state.members].map(([id, m]): MemberView => {
				const seen = run.presences.get(id), age = seen ? now - seen.at : null;
				return {
					id, short: shortId(id), label: m.label ?? shortId(id), labelKnown: m.label !== undefined, duplicate: m.label !== undefined && (counts.get(m.label) ?? 0) > 1,
					role: m.role, attended: m.attended, self: id === this.self.id, online: age !== null && age <= 90_000, seenAgoMs: age, headSeq: seen?.presence.headSeq ?? null, trust: config.trust.get(id) ?? "reply",
				};
			}).sort((a, b) => Number(b.self) - Number(a.self) || a.label.localeCompare(b.label));
			const admins = this.attendedAdmins(state), attended = [...state.members].filter(([, m]) => m.attended);
			const onlyAdmin = Boolean(me?.role === "admin" && me.attended && admins === 1);
			return [{
				team: run.team, name: policy?.name ?? run.team.slice(0, 6), project: policy?.project ?? "", share: policy?.share ?? "status", relay: tf.relay, epoch: state.epoch, headSeq: state.head.seq,
				self: { role: me?.role ?? "member", attended: me?.attended ?? true }, members, status: "running", relayDown: run.downSince !== undefined && now - run.downSince > 120_000,
				secondAdmin: onlyAdmin && attended.length >= 2 ? attended.filter(([id, m]) => id !== this.self.id && m.role !== "admin").map(([id]) => id) : [], onlyAdmin,
			}];
		});
	}
	invites(): InviteView[] {
		const now = this.h.now();
		return this.h.store.invites().filter((i) => i.expires > now).map((i) => ({ hash: i.hash, team: i.team, teamName: this.teamName(i.team), forDevice: i.forDevice, created: i.created, expires: i.expires }));
	}
	joinRequests(): JoinRequestView[] {
		const now = this.h.now();
		for (const [id, r] of this.requests) if (r.expires <= now) this.requests.delete(id);
		return [...this.requests.values()].map((r) => ({ id: r.hash, team: r.team, teamName: this.teamName(r.team), label: r.label, short: shortId(r.record.id), unattended: r.unattended, sets: r.unattended ? [] : r.sets.map((s) => [...s]), expires: r.expires }));
	}
	joinView(): JoinView | undefined {
		const j = this.joining;
		return j && { id: j.id, state: j.state, label: j.label, words: j.words, expires: j.expires, pinned: j.invite.forDevice !== "", ...(j.error ? { error: j.error } : {}), ...(j.team ? { team: j.team } : {}), needsProject: j.project === undefined && j.state !== "failed" && j.state !== "done" };
	}
	/** A request for the user to look at in the GUI (an approved `link_request` of `join` or `create`): the screen opens prefilled. */
	setPrefill(p: Prefill | undefined) {
		this.prefill = p;
	}
}
