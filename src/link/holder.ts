import { Buffer } from "node:buffer";
import type { Session } from "../herdr.ts";
import type { LinkConfig } from "./config.ts";
import { shortId, type DeviceKeys } from "./device.ts";
import { buildEnvelope, openEnvelope, recordTaken, type Header, type ReceiveState } from "./envelope.ts";
import { PayloadTooLargeError, RelayError, UnauthorizedError } from "./errors.ts";
import { encodePlaintext, LIMITS, type Presence, type TowerMessage, type WorkspaceState } from "./kinds.ts";
import { Outbox } from "./outbox.ts";
import type { RelayClient } from "./relay.ts";
import { decodeEntry, encodeEntry, replayEncoded, type RosterEntry, type RosterState } from "./roster.ts";
import { inside, resolveDevice, towerFor, type MemberRef, type NetView } from "./routing.ts";
import type { Backoff, Sleep } from "./retry.ts";
import type { Disposition, EnvelopeEvent, RelayEvent, RosterEvent } from "./sse.ts";
import { TeamFileError, type InboxItem, type LinkStore, type TeamFile } from "./store.ts";

// The link holder's work (docs/specs/2026-10-25-straw-link.md, Link holder). Only the session the election names runs this: it reads the device
// keys, holds the relay stream of each team, and writes the team files; every write is under link/holder.lock. A message the relay delivers is
// checked and decrypted, then written to the inbox (a durable, private staging area), and only then acknowledged, so a crash or a takeover
// delivers it again rather than losing it, and the receive checks drop the second copy. A tower takes it from the inbox when it is idle.

/** The part of the relay client the holder uses; tests swap in the same client over a fake `fetch`, and the live test uses the real one. */
export type RelayPort = Pick<RelayClient, "stream" | "postEnvelope" | "getRoster">;

export interface HolderOptions {
	store: LinkStore;
	/** Whether the election's record names this session; asked under the lock before a relay event is acted on. */
	isHolder: () => boolean;
	/** The user's teams and projects, read fresh. */
	config: () => LinkConfig;
	/** One reading of Herdr and pi-intercom; `withTabs` adds every workspace's tabs (a presence needs them, a delivery does not). */
	net: (withTabs?: boolean) => Promise<NetView>;
	relay: (url: string, device: DeviceKeys) => RelayPort;
	/** Tells a tower a message waits in the inbox for it. The tower takes it when idle and answers with `taken`. */
	offer: (tower: Session, id: string) => void | Promise<void>;
	/** Raises a notice for the boss (the GUI, or the session's own screen). */
	notify: (text: string, level?: "info" | "warning" | "error") => void;
	/** The holder was displaced or its record is gone: the module stops it. */
	onDisplaced?: () => void;
	now?: () => number;
	sleep?: Sleep;
	backoff?: Backoff;
	/** How often the inbox is offered to towers and the config looked at again (default 5 s), and how often a presence goes out (default 30 s). */
	drainMs?: number;
	presenceMs?: number;
	/** How long an offer stands before it is made again (default 30 s). */
	offerAgainMs?: number;
	/** How long `send` waits for the relay to take an envelope before it reports it queued (default 20 s). */
	postWaitMs?: number;
	/** How long a team's outbox stays halted by a 401 before the refused envelope is tried again (default 60 s; a 401 can be a clock that was off). */
	haltRetryMs?: number;
}

export interface SendRequest { fromSession: string; device: string; workspace?: string; text: string; reply: boolean }
export type SendResult = { ok: true; text: string; details: Record<string, unknown> } | { ok: false; error: string };
export interface AllyDevice { id: string; short: string; label: string; online: boolean; ageMs: number | null; roster: number | null; workspaces: WorkspaceState[] }
export interface AllyTeam { team: string; name: string; devices: AllyDevice[] }

const PRESENCE_ONLINE_MS = 90_000;
/** The most devices of one team `list` answers with: the answer has to fit the channel's request size. */
const MAX_LISTED_DEVICES = 100;
const INBOX_MAX_AGE_MS = 7 * 24 * 3600_000;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** What the holder keeps in memory for one team it runs. */
interface TeamRun {
	team: string;
	teamId: Buffer;
	client: RelayPort;
	outbox: Outbox;
	stream: ReturnType<RelayPort["stream"]> | undefined;
	presences: Map<string, { at: number; presence: Presence }>;
	lastEphemeral: Map<string, number>;
	presenceTimer: ReturnType<typeof setInterval> | undefined;
	/** Set when the team can no longer be used (removed, forked, file lost); nothing more is taken from it. */
	dead: string | undefined;
	settled: Map<string, "posted" | "halted" | Error>;
	haltTimer: ReturnType<typeof setTimeout> | undefined;
	/** Ids of sends that stopped waiting (they answered "queued"): a later outcome is not kept for them. */
	gone: Set<string>;
	waiters: Map<string, () => void>;
}

export class LinkHolder {
	private readonly o: HolderOptions;
	private readonly now: () => number;
	private runs = new Map<string, TeamRun>();
	private device: { keys: DeviceKeys; label: string } | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private running = false;
	private told = new Set<string>();
	/** Teams stopped for good (a roster fork, a removed device, a lost team file), with the team file's stamp at that moment. The mark is also on disk, for the next holder. */
	private stopped = new Map<string, string>();
	private offered = new Map<string, { tower: string; at: number }>();
	private draining: Promise<void> | undefined;
	private again = false;

	constructor(o: HolderOptions) {
		this.o = o;
		this.now = o.now ?? Date.now;
	}

	get active(): boolean {
		return this.running;
	}

	// ---- Start and stop ----------------------------------------------------------------------------------------------------------------

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		const { store } = this.o;
		try {
			this.device = await store.withLock(() => store.ensureDevice());
			await this.refresh();
		} catch (error) {
			// `running` stays false after a failed start, so the module sees there is no holder and nothing answers "queued" to a send.
			await this.stop();
			throw error;
		}
		this.timer = setInterval(() => void this.tick().catch((error: Error) => store.log({ event: "tick-failed", error: error.message })), this.o.drainMs ?? 5000);
		this.timer.unref();
	}

	/** Ends every stream and timer; safe to call again, and after a displacement. */
	async stop(): Promise<void> {
		this.running = false;
		clearInterval(this.timer);
		const runs = [...this.runs.values()];
		this.runs.clear();
		await Promise.all(runs.map((run) => this.stopRun(run)));
	}
	private async stopRun(run: TeamRun): Promise<void> {
		clearInterval(run.presenceTimer);
		clearTimeout(run.haltTimer);
		// Envelopes the relay has not taken yet get a moment: a holder that steps down should not drop a message the boss just sent.
		let grace: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([run.outbox.idle(), new Promise<void>((resolve) => (grace = setTimeout(resolve, 2000)))]);
		clearTimeout(grace);
		await run.outbox.stop();
		await run.stream?.stop().catch(() => undefined);
	}

	/** Once per notice key: a repeated notice would fill the screen. */
	private tellOnce(key: string, text: string, level: "info" | "warning" | "error" = "warning"): void {
		if (this.told.has(key)) return;
		this.told.add(key);
		this.o.store.log({ event: "notice", key, text });
		this.o.notify(text, level);
	}

	private async tick(): Promise<void> {
		if (!this.running) return;
		await this.refresh();
		await this.drain();
	}

	/** Starts the teams that have a team file and a config entry, stops the ones that lost either, and tells about the rest once. */
	async refresh(): Promise<void> {
		const { store } = this.o, config = this.o.config();
		for (const problem of config.problems) this.tellOnce(`config/${problem}`, `Straw Link: ${problem}`);
		for (const [team, run] of this.runs) {
			if (!config.teams.has(team) || run.dead) {
				this.runs.delete(team);
				void this.stopRun(run);
			}
		}
		for (const team of store.teamIds()) {
			if (this.runs.has(team) || !this.running) continue;
			if (config.teams.has(team) && (await this.stillStopped(team))) continue;
			if (!config.teams.has(team)) {
				this.tellOnce(`noconfig/${team}`, `Straw Link: team ${team.slice(0, 6)} has no entry under link.teams in config.json, so it takes no messages`, "info");
				continue;
			}
			try {
				await this.startTeam(team);
			} catch (error) {
				this.tellOnce(`start/${team}`, `Straw Link: team ${team.slice(0, 6)} cannot be used: ${(error as Error).message}`);
			}
		}
		for (const policy of config.teams.keys()) {
			if (!store.teamIds().includes(policy)) this.tellOnce(`nofile/${policy}`, `Straw Link: team ${policy.slice(0, 6)} is in config.json but this device has no team file for it; join the team again`);
		}
	}

	/** Whether the team was stopped and its team file is still the one it was stopped with; a file that was replaced (a join again) lifts the mark. */
	private async stillStopped(team: string): Promise<boolean> {
		const { store } = this.o, known = this.stopped.get(team) ?? store.readStopped(team)?.stamp;
		if (known === undefined) return false;
		if (known === store.teamStamp(team)) return true;
		this.stopped.delete(team);
		await store.withLock(() => store.clearStopped(team));
		return false;
	}

	private loadTeam(team: string): { tf: TeamFile; state: RosterState } {
		const tf = this.o.store.readTeam(team), self = this.device!.keys;
		const keys = new Map(Object.entries(tf.keys).map(([epoch, hex]) => [Number(epoch), Buffer.from(hex, "hex")]));
		const replay = replayEncoded(Buffer.from(team, "hex"), tf.entries.map((e) => Buffer.from(e, "base64url")), { self, keys });
		if (!replay.ok) throw new RosterFork(`entry ${replay.seq} is invalid (${replay.reason})`);
		if (!replay.value.members.has(self.id) || replay.value.selfRemoved) throw new RosterFork("this device is not in the roster");
		return { tf, state: replay.value };
	}

	private async startTeam(team: string): Promise<void> {
		const { store } = this.o, device = this.device!;
		const { tf } = this.loadTeam(team);
		const teamId = Buffer.from(team, "hex"), client = this.o.relay(tf.relay, device.keys);
		const gone = new Set<string>(), settled = new Map<string, "posted" | "halted" | Error>(), waiters = new Map<string, () => void>();
		const settle = (id: Buffer, outcome: "posted" | "halted" | Error) => {
			const key = id.toString("hex");
			if (gone.delete(key)) return;
			settled.set(key, outcome);
			waiters.get(key)?.();
		};
		const outbox = new Outbox({
			post: (bytes, signal) => client.postEnvelope(teamId, bytes, signal),
			reserveSeq: () => store.withLock(() => store.reserveSeq()),
			backoff: this.o.backoff, sleep: this.o.sleep,
			onPosted: (item) => settle(item.id, "posted"),
			onRejected: (item, error) => {
				store.log({ event: "send-rejected", team, error: String(error) });
				settle(item.id, error instanceof Error ? error : new Error(String(error)));
			},
			onHalt: (item, error) => {
				this.tellOnce(`halt/${team}`, `Straw Link: the relay refused this device (${error.code}); it is no longer a member of team ${team.slice(0, 6)}, or its clock is off`, "error");
				settle(item.id, "halted");
				// A 401 can be a clock that was off: the refused envelope is tried again after a while, and a send meanwhile is refused up front.
				run.haltTimer = setTimeout(() => this.runs.get(team) === run && !run.dead && run.outbox.resume(), this.o.haltRetryMs ?? 60_000);
				run.haltTimer.unref();
			},
			onRetry: (_item, error) => store.log({ event: "send-retry", team, error: String(error) }),
		});
		const run: TeamRun = { team, teamId, client, outbox, stream: undefined, presences: new Map(), lastEphemeral: new Map(), presenceTimer: undefined, dead: undefined, settled, haltTimer: undefined, gone, waiters };
		this.runs.set(team, run);
		run.stream = client.stream(teamId, {
			onEvent: (event) => this.onEvent(run, event),
			lastEventId: tf.lastEventId || undefined,
			backoff: this.o.backoff, sleep: this.o.sleep,
			onAckError: (error) => store.log({ event: "ack-failed", team, error: String(error) }),
		});
		void run.stream.start();
		void run.stream.done.then((end) => {
			if (end.reason === "refused") this.kill(run, `the relay refused the stream (${end.error.status} ${end.error.code}): this device is no longer a member`, end.error instanceof UnauthorizedError ? "error" : "warning");
			else if (end.reason === "failed") this.kill(run, `the stream failed: ${String(end.error)}`);
		});
		const share = this.o.config().teams.get(team)?.share;
		if (share) {
			run.presenceTimer = setInterval(() => void this.sendPresence(run).catch((error: Error) => store.log({ event: "presence-failed", team, error: error.message })), this.o.presenceMs ?? 30_000);
			run.presenceTimer.unref();
			void this.sendPresence(run).catch((error: Error) => store.log({ event: "presence-failed", team, error: error.message }));
		}
	}

	/** The team can no longer be used; nothing more is taken from it until it is started again by a new holder, or by joining again. */
	private kill(run: TeamRun, why: string, level: "info" | "warning" | "error" = "warning"): void {
		if (run.dead) return;
		run.dead = why;
		const { store } = this.o, stamp = store.teamStamp(run.team);
		this.stopped.set(run.team, stamp);
		// Queued behind whatever holds the lock now (kill is called inside locked sections too); the in-memory mark above covers the gap.
		void store.withLock(() => store.markStopped(run.team, why, stamp)).catch((error: Error) => store.log({ event: "stop-mark-failed", team: run.team, error: error.message }));
		this.o.store.log({ event: "team-stopped", team: run.team, why });
		this.tellOnce(`dead/${run.team}`, `Straw Link: team ${run.team.slice(0, 6)} stopped: ${why}`, level);
		clearInterval(run.presenceTimer);
		clearTimeout(run.haltTimer);
		void run.stream?.stop();
	}

	// ---- Receiving ---------------------------------------------------------------------------------------------------------------------

	private async onEvent(run: TeamRun, event: RelayEvent): Promise<Disposition | void> {
		if (!this.running || run.dead) return "keep";
		try {
			switch (event.type) {
				case "envelope": return event.ephemeral ? await this.ephemeral(run, event) : await this.receive(run, event, false);
				case "roster": return await this.onRoster(run, event);
				case "malformed":
					this.o.store.log({ event: "malformed", team: run.team, name: event.name, reason: event.reason });
					return "ack";
				default: return; // join requests: the GUI's join flow handles them, not this step
			}
		} catch (error) {
			// A handler that throws ends the stream for good; a failure here is told and kept for the next stream instead.
			this.o.store.log({ event: "handler-failed", team: run.team, type: event.type, error: String(error) });
			if (error instanceof TeamFileError || error instanceof RosterFork) this.kill(run, error.message, "error");
			return "keep";
		}
	}

	private state(run: TeamRun, tf: TeamFile, roster: RosterState): ReceiveState {
		return { team: run.teamId, self: this.device!.keys.id, roster, keys: roster.keys, lastSeq: new Map(Object.entries(tf.lastSeq)), lastEphemeral: run.lastEphemeral, now: this.now() };
	}

	/** Presence and the other ephemeral kinds: checked and kept in memory, never queued, never acknowledged. */
	private async ephemeral(run: TeamRun, event: EnvelopeEvent): Promise<Disposition> {
		const { tf, state: roster } = this.loadTeam(run.team);
		const opened = openEnvelope(event.envelope, this.state(run, tf, roster));
		if (!opened.ok) {
			this.o.store.log({ event: "drop", team: run.team, reason: opened.reason, from: event.from, kind: event.envelope.header.kind });
			return "ack";
		}
		run.lastEphemeral = recordTaken(this.state(run, tf, roster), opened.header).lastEphemeral;
		if (opened.header.kind === "presence") run.presences.set(opened.header.from, { at: this.now(), presence: opened.message as Presence });
		return "ack";
	}

	private async receive(run: TeamRun, event: EnvelopeEvent, retried: boolean): Promise<Disposition> {
		const { store } = this.o;
		const outcome = await store.withLock((): { d: Disposition } | { ahead: true } => {
			// A displaced holder must not act: the record is read again under the lock.
			if (!this.o.isHolder()) return (this.displaced(), { d: "keep" });
			const { tf, state: roster } = this.loadTeam(run.team);
			const state = this.state(run, tf, roster), opened = openEnvelope(event.envelope, state), header = event.envelope.header;
			if (!opened.ok) {
				if (opened.reason === "roster-ahead" && !retried) return { ahead: true };
				store.log({ event: "drop", team: run.team, reason: opened.reason, from: header.from, kind: header.kind, seq: header.seq });
				if (opened.reason === "roster-ahead" || opened.reason === "roster-mismatch") this.tellOnce(`mismatch/${run.team}/${header.from}`, `Straw Link: a message from ${shortId(header.from)} names a roster this device cannot match (${opened.reason}); the relay may be showing different rosters`);
				return { d: "ack" };
			}
			if (header.kind === "tower") this.stage(run, roster, header, opened.message as TowerMessage);
			else store.log({ event: "unhandled-kind", team: run.team, kind: header.kind, from: header.from });
			// The sequence guard moves only after the message is in the inbox (or known not to need it), in the same locked write (R-F021).
			const next = recordTaken(state, header);
			tf.lastSeq = Object.fromEntries(next.lastSeq);
			tf.lastEventId = Math.max(tf.lastEventId, event.eid);
			store.writeTeam(tf);
			return { d: "ack" };
		});
		if ("ahead" in outcome) {
			await this.syncRoster(run);
			return this.receive(run, event, true);
		}
		if (outcome.d === "ack") void this.drain();
		return outcome.d;
	}

	/** The message into the inbox, under the lock. */
	private stage(run: TeamRun, roster: RosterState, header: Header, message: TowerMessage): void {
		const sender = roster.members.get(header.from);
		const item: InboxItem = {
			v: 1, id: header.id.toString("hex"), team: run.team, from: header.from, fromLabel: sender?.label ?? shortId(header.from), fromShort: shortId(header.from),
			seq: header.seq, sentAt: header.ts, received: this.now(), fromWorkspace: message.fromWorkspace, toWorkspace: message.toWorkspace, replyExpected: message.replyExpected, text: message.text,
		};
		this.o.store.putInbox(item);
	}

	/** The election's record no longer names this session: nothing is acted on from here, and every stream ends. */
	private displaced(): void {
		void this.stop();
		this.o.onDisplaced?.();
	}

	// ---- The roster --------------------------------------------------------------------------------------------------------------------

	private async onRoster(run: TeamRun, event: RosterEvent): Promise<Disposition> {
		const head = this.loadTeam(run.team).state.head.seq;
		if (event.seq <= head) return "ack";
		if (event.seq > head + 1) await this.syncRoster(run);
		else await this.takeEntries(run, [event.entry]);
		return "ack";
	}
	/** Fetches the entries after this device's head from the relay and applies them. */
	private async syncRoster(run: TeamRun): Promise<void> {
		const head = this.loadTeam(run.team).state.head.seq;
		const { entries } = await run.client.getRoster(run.teamId, head);
		await this.takeEntries(run, entries.map((row) => row.entry));
	}
	/** Appends roster entries under the lock; an entry the rules refuse is a roster fork (the relay is dishonest), and the team stops. */
	private async takeEntries(run: TeamRun, entries: RosterEntry[]): Promise<void> {
		const { store } = this.o;
		const self = this.device!.keys;
		await store.withLock(() => {
			if (!this.o.isHolder()) return void this.displaced();
			const tf = store.readTeam(run.team);
			let head = this.loadTeam(run.team).state.head.seq;
			const fresh = entries.filter((e) => e.seq > head);
			if (fresh.length === 0) return;
			const merged = [...tf.entries, ...fresh.map((e) => b64(encodeEntry(e)))];
			const keys = new Map(Object.entries(tf.keys).map(([epoch, hex]) => [Number(epoch), Buffer.from(hex, "hex")]));
			const replay = replayEncoded(run.teamId, merged.map((e) => Buffer.from(e, "base64url")), { self, keys });
			if (!replay.ok) throw new RosterFork(`entry ${replay.seq} is invalid (${replay.reason}); this is a roster fork`);
			head = replay.value.head.seq;
			if (replay.value.selfRemoved) {
				this.kill(run, "this device was removed from the team", "error");
				return;
			}
			tf.entries = merged;
			tf.keys = Object.fromEntries([...replay.value.keys].map(([epoch, key]) => [String(epoch), key.toString("hex")]));
			store.writeTeam(tf);
		});
	}

	// ---- The inbox and the towers ----------------------------------------------------------------------------------------------------

	/** Offers each waiting message to the tower that may take it; one pass at a time. */
	drain(): Promise<void> {
		if (this.draining) {
			this.again = true;
			return this.draining;
		}
		this.draining = (async () => {
			do {
				this.again = false;
				await this.drainOnce().catch((error: Error) => this.o.store.log({ event: "drain-failed", error: error.message }));
			} while (this.again && this.running);
		})().finally(() => (this.draining = undefined));
		return this.draining;
	}
	private async drainOnce(): Promise<void> {
		const { store } = this.o;
		if (!this.running) return;
		await store.withLock(() => void store.purgeInbox(INBOX_MAX_AGE_MS, this.now()));
		const ids = store.inboxIds();
		if (ids.length === 0) return;
		const config = this.o.config(), net = await this.o.net();
		for (const id of ids) {
			const item = store.readInbox(id);
			if (!item) continue;
			const policy = config.teams.get(item.team), run = this.runs.get(item.team);
			if (!policy || !run || run.dead) continue;
			// The sender's membership is checked again at the moment a tower would get the message.
			let roster: RosterState;
			try {
				roster = this.loadTeam(item.team).state;
			} catch {
				continue;
			}
			if (!roster.members.has(item.from)) {
				store.log({ event: "inbox-dropped", id, reason: "sender-left", from: item.from });
				await store.withLock(() => store.removeInbox(id));
				continue;
			}
			const pick = towerFor(net, policy.project, item.toWorkspace);
			if (!pick) {
				this.tellOnce(`inbox/${id}`, `Straw Link: a message from ${item.fromLabel} waits in the inbox; no tower is open on ${policy.project}${item.toWorkspace ? ` in workspace ${item.toWorkspace}` : ""}`, "info");
				continue;
			}
			const was = this.offered.get(id);
			if (was && was.tower === pick.session.id && this.now() - was.at < (this.o.offerAgainMs ?? 30_000)) continue;
			this.offered.set(id, { tower: pick.session.id, at: this.now() });
			await this.o.offer(pick.session, id);
		}
	}

	/** The tower that was offered a message has put it into its session: it leaves the inbox. */
	async taken(id: string, tower: string): Promise<void> {
		const was = this.offered.get(id);
		if (was && was.tower !== tower) return;
		this.offered.delete(id);
		await this.o.store.withLock(() => this.o.store.removeInbox(id));
	}

	// ---- Sending -----------------------------------------------------------------------------------------------------------------------

	async send(req: SendRequest): Promise<SendResult> {
		const { store } = this.o;
		if (!this.running || !this.device) return { ok: false, error: "This computer's link holder is not running" };
		const bytes = Buffer.byteLength(req.text, "utf8");
		if (bytes > LIMITS.towerText) return { ok: false, error: `The message is ${bytes} bytes; a message over Straw Link may hold at most ${LIMITS.towerText}` };
		const net = await this.o.net();
		const pane = net.panes.find((p) => net.sessions.find((x) => x.id === req.fromSession)?.herdrLocation?.paneId === p.pane_id);
		if (!pane || pane.tokens?.sb_role !== "tower" || !pane.cwd) return { ok: false, error: "Only the tower of a workspace bound to a team can send over Straw Link" };
		const config = this.o.config();
		const teams = [...this.runs.values()].filter((run) => !run.dead && config.teams.has(run.team) && inside(pane.cwd!, config.teams.get(run.team)!.project));
		if (teams.length === 0) return { ok: false, error: `This tower's folder (${pane.cwd}) is not inside the project of any team this device belongs to` };
		const members: MemberRef[] = teams.flatMap((run) => {
			try {
				return [...this.loadTeam(run.team).state.members].map(([id, m]) => ({ team: run.team, id, ...(m.label !== undefined ? { label: m.label } : {}) }));
			} catch {
				return [];
			}
		});
		const target = resolveDevice(req.device, members, this.device.keys.id);
		if (!target.ok) return { ok: false, error: target.error };
		const run = teams.find((r) => r.team === target.team)!;
		if (run.outbox.haltedBy) return { ok: false, error: `The relay is refusing this device (${run.outbox.haltedBy.code}), so nothing is sent to team ${run.team.slice(0, 6)} right now; it is tried again every ${Math.round((this.o.haltRetryMs ?? 60_000) / 1000)} s` };
		const workspace = net.workspaces.find((w) => w.workspace_id === pane.workspace_id);
		const queued = await run.outbox.submit((seq) => {
			const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
			if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
			return buildEnvelope({
				team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq, ts: this.now(), kind: "tower", to: [target.id],
				plaintext: encodePlaintext("tower", { fromWorkspace: workspace?.label ?? "", toWorkspace: req.workspace ?? "", replyExpected: req.reply, text: req.text }),
			});
		});
		const id = queued.id.toString("hex");
		await new Promise<void>((resolve) => {
			if (run.settled.has(id)) return resolve();
			const timer = setTimeout(resolve, this.o.postWaitMs ?? 20_000);
			timer.unref();
			run.waiters.set(id, () => (clearTimeout(timer), resolve()));
		});
		run.waiters.delete(id);
		const outcome = run.settled.get(id);
		run.settled.delete(id);
		if (outcome === undefined || outcome === "halted") run.gone.add(id);
		const who = members.find((m) => m.team === target.team && m.id === target.id);
		const name = `${who?.label ?? "device"} (${shortId(target.id)})`;
		store.log({ event: "send", team: run.team, to: target.id, id, outcome: outcome === undefined ? "queued" : outcome === "posted" ? "posted" : String(outcome) });
		const details = { team: run.team, device: target.id, id, seq: queued.seq };
		if (outcome === "posted") return { ok: true, text: `Sent to the tower of ${name}${req.workspace ? ` (workspace ${req.workspace})` : ""} through the relay. ${req.reply ? "It replies through tower_send." : "It is told no reply is expected."}`, details: { ...details, status: "posted" } };
		if (outcome === "halted") return { ok: true, text: `The relay refused this device just now; the message to ${name} is queued on this computer and tried again within ${Math.round((this.o.haltRetryMs ?? 60_000) / 1000)} s.`, details: { ...details, status: "queued" } };
		if (outcome === undefined) return { ok: true, text: `The relay did not take the message to ${name} yet; it is queued on this computer and retried until it lands.`, details: { ...details, status: "queued" } };
		const refused = outcome instanceof PayloadTooLargeError ? "the relay refuses a message this large" : outcome instanceof RelayError ? `the relay refused it: ${outcome.code}` : outcome.message;
		return { ok: false, error: `The message to ${name} was not sent: ${refused}` };
	}

	// ---- Presence ----------------------------------------------------------------------------------------------------------------------

	private async sendPresence(run: TeamRun): Promise<void> {
		const policy = this.o.config().teams.get(run.team);
		if (!policy || run.dead || !this.running) return;
		const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch), me = state.members.get(this.device!.keys.id);
		if (!key) return;
		const workspaces = policy.share === "status" ? this.statusOf(await this.o.net(true), policy.project) : [];
		const presence: Presence = { label: me?.label ?? this.device!.label, headSeq: state.head.seq, headHash: state.head.hash, workspaces };
		const envelope = buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq: 0, ts: this.now(), kind: "presence", to: [], plaintext: encodePlaintext("presence", presence) });
		await run.client.postEnvelope(run.teamId, envelope);
	}
	/** The bound workspaces (those with a tower inside the project): the tower's state and each tab's. */
	private statusOf(net: NetView, project: string): WorkspaceState[] {
		const towers = net.panes.filter((p) => p.tokens?.sb_role === "tower" && p.cwd && inside(p.cwd, project));
		return towers.flatMap((tower) => {
			const workspace = net.workspaces.find((w) => w.workspace_id === tower.workspace_id);
			if (!workspace) return [];
			const tabs = net.tabs.filter((t) => t.workspace_id === workspace.workspace_id && t.tab_id !== tower.tab_id).map((t) => {
				const states = net.panes.filter((p) => p.tab_id === t.tab_id).map((p) => p.agent_status ?? "unknown");
				return { label: t.label ?? t.tab_id, state: states.includes("blocked") ? "blocked" : states.includes("working") ? "working" : (states[0] ?? "unknown") };
			});
			return [{ label: workspace.label, tower: tower.agent_status ?? "unknown", tabs }];
		});
	}

	/** The devices of every team this holder runs, with what their last presence said. */
	list(): AllyTeam[] {
		const policies = this.o.config().teams;
		return [...this.runs.values()].flatMap((run): AllyTeam[] => {
			if (run.dead) return [];
			let roster: RosterState;
			try {
				roster = this.loadTeam(run.team).state;
			} catch {
				return [];
			}
			const devices = [...roster.members].filter(([id]) => id !== this.device!.keys.id).slice(0, MAX_LISTED_DEVICES).map(([id, m]): AllyDevice => {
				const seen = run.presences.get(id), age = seen ? this.now() - seen.at : null;
				return { id, short: shortId(id), label: m.label ?? shortId(id), online: age !== null && age <= PRESENCE_ONLINE_MS, ageMs: age, roster: seen?.presence.headSeq ?? null, workspaces: seen?.presence.workspaces ?? [] };
			});
			return [{ team: run.team, name: policies.get(run.team)?.name ?? run.team.slice(0, 6), devices }];
		});
	}

	/** This device's id, once the holder runs. */
	get deviceId(): string | undefined {
		return this.device?.keys.id;
	}
	/** The label, short id, and team name a header names the sender of an inbox item by. */
	senderOf(item: InboxItem): { label: string; short: string; team: string } {
		return { label: item.fromLabel, short: item.fromShort, team: this.o.config().teams.get(item.team)?.name ?? item.team.slice(0, 6) };
	}
}

/** The roster the relay showed, or the one in the team file, breaks the roster's rules or no longer has this device. */
class RosterFork extends Error {}
