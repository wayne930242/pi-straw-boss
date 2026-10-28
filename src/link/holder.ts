import { Buffer } from "node:buffer";
import { cleanText, clean, BOARD, forAllies, purge, readEntries, wireId, type Entry } from "../board.ts";
import { MAX_BODY_BYTES } from "./wire.ts";
import { restrictLabel } from "./text.ts";
import { createHash, randomBytes } from "node:crypto";
import type { Session } from "../herdr.ts";
import type { LinkConfig } from "./config.ts";
import { shortId, type DeviceKeys } from "./device.ts";
import { buildEnvelope, openEnvelope, parseEnvelope, recordTaken, type Header, type ReceiveState } from "./envelope.ts";
import { PayloadTooLargeError, RelayError, UnauthorizedError } from "./errors.ts";
import { askIdOk, type Board, type BoardWireEntry, type Caps, type ConfirmAnswer, type ConfirmRequest, encodePlaintext, LIMITS, type Presence, type TowerMessage, type TowerReply, type WorkspaceState } from "./kinds.ts";
import { type AdminRun, type InviteView, type JoinRequestView, type JoinView, type Prefill, TeamAdmin, type TeamView } from "./admin.ts";
import { Outbox, type QueuedEnvelope } from "./outbox.ts";
import { Requests } from "./request.ts";
import type { RelayClient } from "./relay.ts";
import { decodeEntry, encodeEntry, replayEncoded, type RosterEntry, type RosterState } from "./roster.ts";
import { inside, nearestTeams, oneTeamEach, resolveDevice, towersFor, type MemberRef, type NetView } from "./routing.ts";
import type { Backoff, Sleep } from "./retry.ts";
import type { Disposition, EnvelopeEvent, RelayEvent, RosterEvent } from "./sse.ts";
import { TeamFileError, type InboxItem, type LinkStore, type TeamFile, type ThreadRow } from "./store.ts";
import { towerRunsEnabled } from "../server/towerruns.ts";

// The link holder's work (docs/specs/2026-10-25-straw-link.md, Link holder). Only the session the election names runs this: it reads the device
// keys, holds the relay stream of each team, and writes the team files; every write is under link/holder.lock. A message the relay delivers is
// checked and decrypted, then written to the inbox (a durable, private staging area), and only then acknowledged, so a crash or a takeover
// delivers it again rather than losing it, and the receive checks drop the second copy. A tower takes it from the inbox when it is idle.

/** The part of the relay client the holder uses; tests swap in the same client over a fake `fetch`, and the live test uses the real one. */
export type RelayPort = Pick<RelayClient, "stream" | "postEnvelope" | "getRoster" | "createTeam" | "appendRoster" | "createInvite" | "join">;

export interface HolderOptions {
	store: LinkStore;
	/** Whether the election's record names this session; asked under the lock before a relay event is acted on. */
	isHolder: () => boolean;
	/** The user's teams and projects, read fresh. */
	config: () => LinkConfig;
	/** The state directory (config.json lives there), the home folder, and the pi agent folder: the GUI's team changes write config.json and check a project against the last two. */
	stateDir?: string;
	home?: string;
	agentDir?: string;
	/** Whether this computer is attended (no policy file makes it unattended): `link_request` and the GUI's team changes are refused otherwise. Default true. */
	attended?: () => boolean;
	/** One reading of Herdr and pi-intercom; `withTabs` adds every workspace's tabs (a presence needs them, a delivery does not). */
	net: (withTabs?: boolean) => Promise<NetView>;
	relay: (url: string, device: DeviceKeys) => RelayPort;
	/** Tells a tower a message waits in the inbox for it. The tower takes it when idle and answers with `taken`. */
	offer: (tower: Session, id: string) => void | Promise<void>;
	/** Raises a notice for the boss (the GUI, or the session's own screen). */
	notify: (text: string, level?: "info" | "warning" | "error") => void;
	/** The holder was displaced or its record is gone: the module stops it. */
	onDisplaced?: () => void;
	/** A confirm-answer for a dialog this device's tower put to a sender's device (Remote turns, `forward`): the device, digest, and once were checked. */
	confirmed?: (tower: string, dialogId: string, allow: boolean) => void;
	now?: () => number;
	sleep?: Sleep;
	backoff?: Backoff;
	/** How often the inbox is offered to towers and the config looked at again (default 5 s), and how often a presence goes out (default 30 s). */
	drainMs?: number;
	presenceMs?: number;
	/** How long an offer stands before it is made again (default 30 s). */
	offerAgainMs?: number;
	/** How long `send` waits for the relay to take an envelope before it reports it queued (default 10 s). */
	postWaitMs?: number;
	/** How long a team's outbox stays halted by a 401 before the refused envelope is tried again (default 60 s; a 401 can be a clock that was off). */
	haltRetryMs?: number;
	/** Where the mains' work board entries are (`<state dir>/board`); without it no board is sent. */
	boardDir?: string;
	/** The least time between two boards to one team (default 15 s); a test shortens it. */
	boardMinMs?: number;
	/** The most messages kept in the inbox from one sender (default 100) and in all (default 500); past that the relay keeps the envelope. */
	inboxPerSender?: number;
	inboxMax?: number;
	/** The asks local towers made for their mains and have not had answered (src/server/asks.ts): a `tower-reply` is taken as a reply only against one, once, from the device asked. */
	asks?: { take(q: { team: string; device: string; ask: string }): { main: string; mainName: string; tower: string; workspace: string } | undefined };
	/** Told, at each pass of the inbox, that messages wait for a tower identity the sb server runs (src/server/towers.ts): an ally run is woken for them. */
	served?: (identity: string) => void;
	/** How often `caps` is sent unchanged (default an hour) and the least time between two (default 15 s). */
	capsMs?: number;
	capsMinMs?: number;
}

export interface ConfirmRequestInput { fromSession: string; team: string; device: string; dialogId: string; digest: string; tool: string; args: string; tower: string }
/** A confirm-request another device sent, waiting for this device's boss. */
export interface ConfirmView { dialogId: string; team: string; from: string; fromLabel: string; fromShort: string; digest: string; tool: string; args: string; tower: string; at: number }
const CONFIRM_MAX_MS = 10 * 60_000;
const CONFIRM_MAX = 20;
/** `awaitsReply`: an ask id (32 hex) a local tower made for a main; `inReplyTo`: the ask id of the message this one answers (an ally run's reply). Each is written to the wire only against the peer's `caps` (Replies for a main). */
export interface SendRequest { fromSession: string; device: string; workspace?: string; text: string; reply: boolean; awaitsReply?: string; inReplyTo?: string }
export type SendResult = { ok: true; text: string; details: Record<string, unknown> } | { ok: false; error: string };
/** What the GUI shows as a notice. `data` is plain text and numbers: the page puts them in text nodes. */
export type AlertKind = "join-request" | "confirm" | "fork" | "mismatch" | "unreachable" | "inbox" | "held" | "served";
/** A tower the sb server runs (src/server/towers.ts) is an identity, not a session: it takes no offer, so what is for it waits in the inbox until an ally run takes it (B6). */
const SERVED_TOWER = /^sb-tower-/;
/** The pi the server started for a run, which sits in the standing pane while the run lives: the message is the tower's, even if the run's pi is the session found there. */
const SERVED_RUN = /^tower run · /;
export interface LinkAlert { id: string; kind: AlertKind; level: "info" | "warning" | "error"; team: string; teamName: string; data: Record<string, string | number> }
/** A teammate's workspace as the map shows it beside the local bases (spec, GUI). */
export interface AllyBase { id: string; team: string; teamName: string; device: string; short: string; label: string; online: boolean; workspace: string | null; tower: string; tabs: { label: string; state: string }[] }
/** The compact reading the net snapshot carries: it changes only when something worth redrawing does. */
export interface LinkSummary { allies: AllyBase[]; alerts: LinkAlert[]; confirms: ConfirmView[] }
/** The whole state the team settings page draws. */
export interface LinkView extends LinkSummary {
	deviceId: string;
	short: string;
	label: string;
	relay: string | undefined;
	teams: TeamView[];
	invites: InviteView[];
	joinRequests: JoinRequestView[];
	join: JoinView | undefined;
	prefill: Prefill | undefined;
}
const HEAD_DIFF_MS = 2 * 60_000, DOWN_MS = 2 * 60_000, HELD_MS = 10 * 60_000;
/** A reply for a main that the main has not taken this long after the first offer (an older build never connects to the channel) goes to an ally run, which is told who asked. */
const REPLY_OFFER_MS = 5 * 60_000;

export interface AllyDevice { id: string; short: string; label: string; online: boolean; ageMs: number | null; roster: number | null; workspaces: WorkspaceState[] }
export interface AllyTeam { team: string; name: string; devices: AllyDevice[] }
/** An ally's board as a tower reads it: text from the sender, cut and cleaned again; the device's label is the roster's. */
export interface AllyBoardEntry { id: string; workspace: string; tab: string; main: string; now: string; items: { t: string; done: boolean }[]; updatedSecondsAgo?: number }
export interface AllyBoard { origin: "remote"; team: string; teamId: string; device: { id: string; short: string; label: string }; online: boolean; boardSecondsAgo: number; entries: AllyBoardEntry[] }
/** A board from a device that has been offline longer than this, or is older than 7 days, is not shown (spec, Holding allies' boards). */
const BOARD_OFFLINE_MS = 2 * 3600_000, BOARD_MAX_AGE_MS = 7 * 24 * 3600_000;
/** The board is sent at most this often per team, and once an hour unchanged; a relay without the kind is left alone for an hour. */
const BOARD_MIN_MS = 15_000, BOARD_REFRESH_MS = 3600_000, BOARD_OFF_MS = 3600_000;
/** What this build takes (docs/specs/2026-10-26-sb-backend.md, Replies for a main). A `caps` older than 2 hours counts as none. */
export const CAPS_FEATURES = ["tower.awaitsReply", "tower-reply"] as const;
export const CAPS_STALE_MS = 2 * 3600_000;
const CAPS_REFRESH_MS = 3600_000, CAPS_MIN_MS = 15_000, CAPS_OFF_MS = 3600_000, REPLY_OFF_MS = 3600_000, FALLBACK_LOG_MS = 3600_000;

/** The default wait for the relay in `send`; the tower waits for the holder's answer longer than this plus the lock wait (runtime.ts `ASK_MS`), or it would give up on a message that was sent. */
export const POST_WAIT_MS = 10_000;
const PRESENCE_ONLINE_MS = 90_000;
/** The most devices of one team `list` answers with: the answer has to fit the channel's request size. */
const MAX_LISTED_DEVICES = 100;
const INBOX_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Why the relay refused an envelope for good. */
export const refusal = (error: Error) => (error instanceof PayloadTooLargeError ? "the relay refuses a message this large" : error instanceof RelayError ? `the relay refused it: ${restrictLabel(error.code)}` : error.message);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** What the holder keeps in memory for one team it runs. */
interface TeamRun {
	team: string;
	teamId: Buffer;
	client: RelayPort;
	outbox: Outbox;
	stream: ReturnType<RelayPort["stream"]> | undefined;
	presences: Map<string, { at: number; presence: Presence }>;
	/** The last board of each ally device, in memory only: the relay gives it back on the next stream. */
	boards: Map<string, { at: number; ts: number; board: Board }>;
	/** What this holder last sent as a board to the team: the hash (without `ts`), when, the `ts` used, the epoch it was built for, and until when a relay that refused the kind is left alone. */
	boardSent: { hash: string | undefined; looked: number; at: number; ts: number; epoch: number; offUntil: number; wasEmpty: boolean };
	lastEphemeral: Map<string, number>;
	/** The last `caps` of each peer, in memory only: the relay gives it back on the next stream. */
	caps: Map<string, { at: number; features: string[] }>;
	/** What this holder last sent as `caps` to the team: when, the `ts` used, and until when a relay that refused the kind is left alone. */
	capsSent: { at: number; ts: number; offUntil: number };
	/** Until when a relay that refused `tower-reply` is not sent one (a plain `tower` goes instead). */
	replyOffUntil: number;
	presenceTimer: ReturnType<typeof setInterval> | undefined;
	/** Set when the team can no longer be used (removed, forked, file lost); nothing more is taken from it. */
	dead: string | undefined;
	settled: Map<string, "posted" | "halted" | Error>;
	haltTimer: ReturnType<typeof setTimeout> | undefined;
	/** Sends that stopped waiting (they answered "queued") and messages restored from disk, by id, with how to name them: a later refusal is told to the boss, and no outcome is kept for them. */
	gone: Map<string, string>;
	waiters: Map<string, () => void>;
	/** Since when the relay stream has been failing (undefined while it is open): a notice after 2 minutes. */
	downSince: number | undefined;
	/** Teammates seen on another roster head than ours, and since when: a notice after 2 minutes (spec, Presence). */
	headDiff: Map<string, number>;
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
	private offered = new Map<string, { tower: string; at: number; /** When the first offer of this reply went to this main. */ first?: number }>();
	/** Dialogs this device's towers put to other devices at `forward`, by dialog id: who may answer, and what the answer has to carry. */
	private asked = new Map<string, { team: string; device: string; digest: string; tower: string; at: number }>();
	/** Confirm requests other devices put to this one. */
	private confirms = new Map<string, ConfirmView>();
	private draining: Promise<void> | undefined;
	private again = false;
	/** Inbox messages no tower has taken yet: no tower open, or offered and not taken. For the GUI's notices. */
	/** The main whose reply fell back to an ally run, per inbox id: a `taken` of that main that arrives afterwards (it read the item before the rewrite) does not remove the item an ally run is to get. */
	private replyFellBack = new Map<string, string>();
	private waiting = new Map<string, { team: string; from: string; since: number; offered: boolean; served?: boolean; identity?: string }>();
	/** When a `tower-reply` last fell back to a plain `tower`, by device, so the log tells it once an hour. */
	private fellBack = new Map<string, number>();
	/** `tower-reply`s that stopped waiting for the relay (they answered "queued"), by envelope id: what to send instead when the relay refuses the kind. */
	private lateReplies = new Map<string, () => void>();
	/** What the GUI does to teams (admin.ts). */
	readonly admin: TeamAdmin;
	/** The link actions agents ask for, waiting for the boss (request.ts). */
	readonly requests: Requests;

	constructor(o: HolderOptions) {
		this.o = o;
		this.now = o.now ?? Date.now;
		const stateDir = o.stateDir ?? "", me = this;
		this.admin = new TeamAdmin({
			store: o.store, stateDir, home: o.home ?? "", agentDir: o.agentDir ?? "", now: () => this.now(),
			device: () => this.device!, config: o.config, relayFor: (url, keys) => o.relay(url, keys),
			runs: () => [...this.runs.values()], load: (team) => this.loadTeam(team),
			takeEntries: (run, entries) => this.takeEntries(run as TeamRun, entries), syncRoster: (run) => this.syncRoster(run as TeamRun),
			refresh: () => this.refresh(), stopTeam: async (team) => {
				const run = me.runs.get(team);
				me.runs.delete(team);
				if (run) await me.stopRun(run);
			},
			notify: (text, level) => o.notify(text, level), log: (entry) => o.store.log(entry),
		});
		this.requests = new Requests({ admin: this.admin, teams: () => this.admin.teamViews(), now: () => this.now(), attended: o.attended ?? (() => true), home: o.home ?? "", agentDir: o.agentDir ?? "" });
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
		await this.sendBoards();
		await this.sendCaps();
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
				if (this.admin.joiningTeam() === team) continue; // a join waiting for its project folder
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
		const gone = new Map<string, string>(), settled = new Map<string, "posted" | "halted" | Error>(), waiters = new Map<string, () => void>();
		const settle = (id: Buffer, outcome: "posted" | "halted" | Error) => {
			const key = id.toString("hex");
			const who = gone.get(key);
			if (who !== undefined) {
				if (outcome === "halted") return;
				gone.delete(key);
				// A `tower-reply` the relay refused after the send stopped waiting goes again as the plain `tower` it falls back to.
				const again = this.lateReplies.get(key);
				this.lateReplies.delete(key);
				if (again && outcome instanceof RelayError && outcome.code === "unknown-kind") return void again();
				if (outcome instanceof Error) this.o.notify(`Straw Link: the relay refused ${who}: ${refusal(outcome)}`, "warning");
				return;
			}
			settled.set(key, outcome);
			waiters.get(key)?.();
		};
		// The envelope leaves the disk once the relay holds it or refused it for good; a crash before this reposts it, and the relay dedupes on the id.
		const forget = (item: QueuedEnvelope) => void store.withLock(() => store.removeOutbox(team, item)).catch((error: Error) => store.log({ event: "outbox-remove-failed", team, error: error.message }));
		const outbox = new Outbox({
			post: (bytes, signal) => client.postEnvelope(teamId, bytes, signal),
			// Reserve the seq, build the envelope, and write it to disk under one lock: another holder that takes over never sees a number without its file.
			reserveSeq: () => store.reserveSeq(),
			atomically: (step) => store.withLock(step),
			save: (item) => store.putOutbox(team, item),
			backoff: this.o.backoff, sleep: this.o.sleep,
			onPosted: (item) => {
				forget(item);
				settle(item.id, "posted");
			},
			onRejected: (item, error) => {
				store.log({ event: "send-rejected", team, error: String(error) });
				forget(item);
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
		const run: TeamRun = { team, teamId, client, outbox, stream: undefined, presences: new Map(), boards: new Map(), boardSent: { hash: undefined, looked: 0, at: 0, ts: 0, epoch: 0, offUntil: 0, wasEmpty: false }, lastEphemeral: new Map(), caps: new Map(), capsSent: { at: 0, ts: 0, offUntil: 0 }, replyOffUntil: 0, presenceTimer: undefined, dead: undefined, settled, haltTimer: undefined, gone, waiters, downSince: undefined, headDiff: new Map() };
		this.runs.set(team, run);
		// What an earlier holder (or this one before a restart) built and did not see land goes first, in order, before anything new is accepted.
		for (const item of store.outboxPending(team)) {
			const sealed = parseEnvelope(item.bytes);
			if (!sealed || sealed.header.seq !== item.seq || !Buffer.from(sealed.header.id).equals(item.id) || sealed.header.from !== device.keys.id) {
				store.log({ event: "outbox-skipped", team, seq: item.seq, id: item.id.toString("hex") });
				continue;
			}
			gone.set(item.id.toString("hex"), `a message queued earlier (seq ${item.seq})`);
			outbox.enqueue(item);
		}
		run.stream = client.stream(teamId, {
			onEvent: (event) => this.onEvent(run, event),
			lastEventId: tf.lastEventId || undefined,
			backoff: this.o.backoff, sleep: this.o.sleep,
			onAckError: (error) => store.log({ event: "ack-failed", team, error: String(error) }),
			onState: (st) => {
				run.downSince = st.state === "open" ? undefined : st.state === "retrying" ? (run.downSince ?? this.now()) : run.downSince;
				// A stream that (re)starts is a reason to send the board once more (the 15 second spacing still holds).
				if (st.state === "open") (Object.assign(run.boardSent, { hash: undefined, looked: 0 }), (run.capsSent.at = 0));
			},
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
				case "join":
					await this.admin.onJoin(run, event);
					return;
				default: return;
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
		if (opened.header.kind === "board") run.boards.set(opened.header.from, { at: this.now(), ts: opened.header.ts, board: opened.message as Board });
		if (opened.header.kind === "caps") run.caps.set(opened.header.from, { at: this.now(), features: (opened.message as Caps).features });
		if (opened.header.kind === "presence") {
			const presence = opened.message as Presence;
			run.presences.set(opened.header.from, { at: this.now(), presence });
			this.compareHead(run, opened.header.from, presence, roster);
		}
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
			if ((header.kind === "tower" || header.kind === "tower-reply") && this.inboxFull(run.team, header.from)) {
				this.tellOnce(`full/${run.team}/${header.from}`, `Straw Link: the inbox holds too many messages from ${shortId(header.from)}; the relay keeps the rest until some are taken`);
				return { d: "keep" };
			}
			if (header.kind === "tower") this.stage(run, roster, header, opened.message as TowerMessage);
			else if (header.kind === "tower-reply") this.takeReply(run, roster, header, opened.message as TowerReply);
			else if (header.kind === "confirm-request") this.takeConfirmRequest(run, roster, header, opened.message as ConfirmRequest);
			else if (header.kind === "confirm-answer") this.takeConfirmAnswer(run, roster, header, opened.message as ConfirmAnswer);
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

	/** Whether the inbox has no room for another message from `from`: the files are counted, and opened only when there are enough to matter. */
	private inboxFull(team: string, from: string): boolean {
		const { store } = this.o, each = this.o.inboxPerSender ?? 100, all = this.o.inboxMax ?? 500, held = store.inboxIds().length;
		return held >= all || (held >= each && store.inboxFrom(team, from) >= each);
	}
	/** The message into the inbox, under the lock. */
	private stage(run: TeamRun, roster: RosterState, header: Header, message: TowerMessage): void {
		const sender = roster.members.get(header.from);
		const item: InboxItem = {
			v: 1, id: header.id.toString("hex"), team: run.team, from: header.from, fromLabel: sender?.label ?? shortId(header.from), fromShort: shortId(header.from),
			seq: header.seq, sentAt: header.ts, received: this.now(), fromWorkspace: message.fromWorkspace, toWorkspace: message.toWorkspace, replyExpected: message.replyExpected, text: message.text,
			...(message.awaitsReply !== undefined ? { awaitsReply: message.awaitsReply } : {}),
		};
		this.o.store.putInbox(item);
		this.thread(header.from, { dir: "in", at: item.received, id: item.id, kind: "tower", ...(message.awaitsReply !== undefined ? { awaitsReply: message.awaitsReply } : {}), text: message.text });
	}
	/** A row of a device's thread, under the lock; a store that cannot write it does not lose the message. */
	private thread(device: string, row: ThreadRow): void {
		try {
			this.o.store.appendThread(device, row);
		} catch (error) {
			this.o.store.log({ event: "thread-failed", error: String(error) });
		}
	}
	/**
	 * A `tower-reply` is the reply to an ask a local tower made for a main only when its `inReplyTo` names an open ask, the envelope comes from the device asked, and the ask was not used:
	 * the text then waits in the inbox as a reply for that main. Anything else (no ask, another device, used, expired) is handled as the plain `tower` it falls back to.
	 */
	private takeReply(run: TeamRun, roster: RosterState, header: Header, message: TowerReply): void {
		const taken = this.o.asks?.take({ team: run.team, device: header.from, ask: message.inReplyTo });
		const sender = roster.members.get(header.from);
		const item: InboxItem = {
			v: 1, id: header.id.toString("hex"), team: run.team, from: header.from, fromLabel: sender?.label ?? shortId(header.from), fromShort: shortId(header.from),
			seq: header.seq, sentAt: header.ts, received: this.now(), fromWorkspace: "", toWorkspace: taken?.workspace ?? "", replyExpected: false, text: message.text,
			...(taken ? { reply: { ask: message.inReplyTo, main: taken.main, mainName: taken.mainName, tower: taken.tower } } : {}),
		};
		this.o.store.putInbox(item);
		this.thread(header.from, { dir: "in", at: item.received, id: item.id, kind: "tower-reply", inReplyTo: message.inReplyTo, text: message.text });
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
		await store.withLock(() => void (store.purgeInbox(INBOX_MAX_AGE_MS, this.now()), this.admin.purgeInvites(), this.purgeThreads()));
		const ids = store.inboxIds();
		for (const id of this.waiting.keys()) if (!ids.includes(id)) this.waiting.delete(id);
		if (ids.length === 0) return;
		const config = this.o.config(), net = await this.o.net(), servedNow = new Set<string>();
		for (const id of ids) {
			const item = store.readInbox(id);
			if (!item) {
				// A file that cannot be read as a message (damaged by hand or by a full disk) is dropped, not kept for seven days.
				store.log({ event: "inbox-dropped", id, reason: "damaged" });
				await store.withLock(() => store.removeInbox(id));
				continue;
			}
			const policy = config.teams.get(item.team), run = this.runs.get(item.team);
			if (!policy || !run || run.dead) continue;
			this.waiting.set(id, this.waiting.get(id) ?? { team: item.team, from: item.fromLabel, since: item.received, offered: false });
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
			if (item.reply) {
				// An answer to an ask a local tower made for a main goes to that main, as peer data; a main that is gone (not live, or no longer its tab's main) hands it to an ally run, which is told who asked.
				const main = net.sessions.find((s) => s.id === item.reply!.main), mainPane = main && net.panes.find((p) => p.pane_id === main.herdrLocation?.paneId);
				if (!main || mainPane?.tokens?.sb_role !== "main") {
					const { reply, ...plain } = item;
					await store.withLock(() => store.putInbox({ ...plain, askedBy: reply!.mainName }));
					if (main) this.noteReplyFallback(id, main.id);
					store.log({ event: "reply-fallback", id, why: main ? "not-main" : "gone" });
					this.again = true;
					continue;
				}
				const was = this.offered.get(id), first = was?.tower === main.id ? (was.first ?? was.at) : this.now();
				if (this.now() - first >= REPLY_OFFER_MS) {
					const { reply, ...plain } = item;
					this.offered.delete(id);
					await store.withLock(() => store.putInbox({ ...plain, askedBy: reply!.mainName }));
					this.noteReplyFallback(id, main.id);
					store.log({ event: "reply-fallback", id, why: "not-taken" });
					this.again = true;
					continue;
				}
				if (was && was.tower === main.id && this.now() - was.at < (this.o.offerAgainMs ?? 30_000)) continue;
				this.offered.set(id, { tower: main.id, at: this.now(), first });
				this.waiting.get(id)!.offered = true;
				await this.o.offer(main, id);
				continue;
			}
			const picks = towersFor(net, policy.project, item.toWorkspace), first = picks[0];
			if (!first) {
				this.waiting.get(id)!.offered = false;
				this.tellOnce(`inbox/${id}`, `Straw Link: a message from ${item.fromLabel} waits in the inbox; no tower is open on ${policy.project}${item.toWorkspace ? ` in workspace ${restrictLabel(item.toWorkspace)}` : ""}`, "info");
				continue;
			}
			if (SERVED_TOWER.test(first.session.id) || (towerRunsEnabled(this.o.stateDir ?? "") && SERVED_RUN.test(first.session.name ?? ""))) {
				// The sb server stands in for this tower: the message stays in the inbox until an ally run has it, and the server is told one waits (`servedFor`).
				Object.assign(this.waiting.get(id)!, { offered: false, served: true, identity: first.session.id });
				servedNow.add(first.session.id);
				continue;
			}
			// An offer is sticky: the tower that has it keeps it while it is still a tower of the project, so a tower that opens nearer the root,
			// or a changed workspace order, never gives the same message to a second one while the first still holds it.
			const was = this.offered.get(id), pick = (was && picks.find((p) => p.session.id === was.tower)) || first;
			if (was && was.tower === pick.session.id && this.now() - was.at < (this.o.offerAgainMs ?? 30_000)) continue;
			this.offered.set(id, { tower: pick.session.id, at: this.now() });
			this.waiting.get(id)!.offered = true;
			await this.o.offer(pick.session, id);
		}
		for (const identity of servedNow) {
			try {
				this.o.served?.(identity);
			} catch (error) {
				store.log({ event: "served-failed", error: String(error) });
			}
		}
	}

	/** Threads older than 7 days go, and so does the thread of a device that is no member of any team this computer still has a file for (it left, was removed, or this computer left the team). Under the lock. */
	private purgeThreads(): void {
		const { store } = this.o;
		store.purgeThreads(this.now());
		const members = new Set<string>();
		for (const team of store.teamIds()) {
			try {
				for (const id of this.loadTeam(team).state.members.keys()) members.add(id);
			} catch {
				return; // a team file that cannot be read says nothing about who left
			}
		}
		for (const device of store.threadDevices()) if (!members.has(device)) store.removeThread(device);
	}

	private noteReplyFallback(id: string, main: string): void {
		this.replyFellBack.set(id, main);
		for (const old of this.replyFellBack.keys()) if (this.replyFellBack.size > 200) this.replyFellBack.delete(old); else break;
	}

	/** The tower that was offered a message has put it into its session: it leaves the inbox. */
	async taken(id: string, tower: string): Promise<void> {
		const was = this.offered.get(id);
		if (was && was.tower !== tower) return;
		if (!was && this.replyFellBack.get(id) === tower) return;
		this.replyFellBack.delete(id);
		this.offered.delete(id);
		this.waiting.delete(id);
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
		const teams = nearestTeams(pane.cwd, [...this.runs.values()].filter((run) => !run.dead && config.teams.has(run.team)).map((run) => ({ run, project: config.teams.get(run.team)!.project }))).map((x) => x.run);
		if (teams.length === 0) return { ok: false, error: `This tower's folder (${pane.cwd}) is not inside the project of any team this device belongs to` };
		const members: MemberRef[] = oneTeamEach(teams.flatMap((run) => {
			try {
				return [...this.loadTeam(run.team).state.members].map(([id, m]) => ({ team: run.team, id, ...(m.label !== undefined ? { label: m.label } : {}) }));
			} catch {
				return [];
			}
		}));
		const target = resolveDevice(req.device, members, this.device.keys.id);
		if (!target.ok) return { ok: false, error: target.error };
		const run = teams.find((r) => r.team === target.team)!;
		if (run.outbox.haltedBy) return { ok: false, error: `The relay is refusing this device (${restrictLabel(run.outbox.haltedBy.code)}), so nothing is sent to team ${run.team.slice(0, 6)} right now; it is tried again every ${Math.round((this.o.haltRetryMs ?? 60_000) / 1000)} s` };
		const workspace = net.workspaces.find((w) => w.workspace_id === pane.workspace_id);
		// A field or a kind this peer's build may not take goes to it only against its last `caps`; otherwise the message is the plain `tower` an older build reads (Replies for a main).
		const peer = this.capsOf(run, target.id);
		if ((req.awaitsReply !== undefined && !askIdOk(req.awaitsReply)) || (req.inReplyTo !== undefined && !askIdOk(req.inReplyTo))) return { ok: false, error: "An ask id is 32 lowercase hex digits" };
		const withAsk = req.awaitsReply !== undefined && peer.includes("tower.awaitsReply");
		let kind: "tower" | "tower-reply" = req.inReplyTo !== undefined && peer.includes("tower-reply") && this.now() >= run.replyOffUntil ? "tower-reply" : "tower";
		const submit = (as: "tower" | "tower-reply") => run.outbox.submit((seq) => {
			const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
			if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
			return buildEnvelope({
				team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq, ts: this.now(), kind: as, to: [target.id],
				plaintext: as === "tower-reply"
					? encodePlaintext("tower-reply", { inReplyTo: req.inReplyTo!, text: req.text })
					: encodePlaintext("tower", { fromWorkspace: workspace?.label ?? "", toWorkspace: req.workspace ?? "", replyExpected: req.reply, text: req.text, ...(withAsk ? { awaitsReply: req.awaitsReply! } : {}) }),
			});
		});
		const post = async (as: "tower" | "tower-reply") => {
			const queued = await submit(as), id = queued.id.toString("hex");
			await new Promise<void>((resolve) => {
				if (run.settled.has(id)) return resolve();
				const timer = setTimeout(resolve, this.o.postWaitMs ?? POST_WAIT_MS);
				timer.unref();
				run.waiters.set(id, () => (clearTimeout(timer), resolve()));
			});
			run.waiters.delete(id);
			const outcome = run.settled.get(id);
			run.settled.delete(id);
			return { queued, id, outcome };
		};
		let { queued, id, outcome } = await post(kind);
		if (kind === "tower-reply" && outcome instanceof RelayError && outcome.code === "unknown-kind") {
			// The relay does not know the kind yet: for an hour replies go as the plain `tower` they fall back to, and this one goes again now.
			run.replyOffUntil = this.now() + REPLY_OFF_MS;
			this.logFallback(target.id, "the relay refused the kind");
			kind = "tower";
			({ queued, id, outcome } = await post("tower"));
		} else if (kind === "tower-reply" && outcome === undefined) {
			this.lateReplies.set(id, () => {
				run.replyOffUntil = this.now() + REPLY_OFF_MS;
				this.logFallback(target.id, "the relay refused the kind");
				void submit("tower").catch((error: Error) => this.o.store.log({ event: "fallback-failed", team: run.team, error: error.message }));
			});
		}
		if (outcome === undefined || outcome === "posted") await store.withLock(() => this.thread(target.id, { dir: "out", at: this.now(), id, kind, ...(withAsk ? { awaitsReply: req.awaitsReply! } : {}), ...(kind === "tower-reply" ? { inReplyTo: req.inReplyTo! } : {}), text: req.text })).catch(() => undefined);
		const who = members.find((m) => m.team === target.team && m.id === target.id);
		const name = `${who?.label ?? "device"} (${shortId(target.id)})`;
		if (outcome === undefined || outcome === "halted") run.gone.set(id, `the message to ${name}`);
		store.log({ event: "send", team: run.team, to: target.id, id, outcome: outcome === undefined ? "queued" : outcome === "posted" ? "posted" : String(outcome) });
		const details = { team: run.team, device: target.id, id, seq: queued.seq, as: kind, ...(req.awaitsReply !== undefined ? { asked: withAsk } : {}) };
		const how = req.awaitsReply !== undefined ? (withAsk ? " It carries your ask id, so its answer comes back to the main that asked." : " That device\'s build does not take ask ids, so it went as a plain message and the answer will reach a fresh ally run here, not the main.") : req.inReplyTo !== undefined ? (kind === "tower-reply" ? " Sent as a reply to the ask." : " Sent as a plain message: that device\'s build takes no replies to an ask.") : "";
		if (outcome === "posted") return { ok: true, text: `Sent to the tower of ${name}${req.workspace ? ` (workspace ${req.workspace})` : ""} through the relay. ${req.reply ? "It replies through tower_send." : "It is told no reply is expected."}${how}`, details: { ...details, status: "posted" } };
		if (outcome === "halted") return { ok: true, text: `The relay refused this device just now; the message to ${name} is saved on this computer and tried again within ${Math.round((this.o.haltRetryMs ?? 60_000) / 1000)} s.`, details: { ...details, status: "queued" } };
		if (outcome === undefined) return { ok: true, text: `The relay did not take the message to ${name} yet; it is saved on this computer and sent again until the relay takes it.${how}`, details: { ...details, status: "queued" } };
		return { ok: false, error: `The message to ${name} was not sent: ${refusal(outcome)}` };
	}

	/** The features a peer's last `caps` listed; none when it sent none or the last one is older than 2 hours (the relay keeps a `caps` after its sender downgrades). */
	private capsOf(run: TeamRun, device: string): string[] {
		const seen = run.caps.get(device);
		return seen && this.now() - seen.at <= CAPS_STALE_MS ? seen.features : [];
	}
	/** What `device` takes, as its last fresh `caps` said (for the sb server's ask: it says in its answer whether the ask id was written). */
	capsFor(team: string, device: string): string[] {
		const run = this.runs.get(team);
		return run ? this.capsOf(run, device) : [];
	}
	/** The fallback of a `tower-reply` to a plain `tower` is logged once per device and hour. */
	private logFallback(device: string, why: string): void {
		const last = this.fellBack.get(device);
		if (last !== undefined && this.now() - last < FALLBACK_LOG_MS) return;
		this.fellBack.set(device, this.now());
		this.o.store.log({ event: "tower-reply-fallback", device, why });
	}

	// ---- Caps (Replies for a main) ------------------------------------------------------------------------------------------------------

	/** `caps` goes to each team at a stream start, then once an hour (never twice within 15 s); a relay that refuses the kind is left alone for an hour, as the board is. */
	private async sendCaps(): Promise<void> {
		if (!this.running || !this.device) return;
		const now = this.now(), min = this.o.capsMinMs ?? CAPS_MIN_MS, every = this.o.capsMs ?? CAPS_REFRESH_MS;
		for (const run of [...this.runs.values()]) {
			const sent = run.capsSent;
			if (run.dead || now < sent.offUntil || (sent.at !== 0 && now - sent.at < every) || now - sent.at < min) continue;
			try {
				const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
				if (!key) continue;
				const ts = Math.max(now, sent.ts + 1);
				sent.at = now; // a failed post is tried again after the spacing, not at every tick
				const envelope = buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device.keys, seq: 0, ts, kind: "caps", to: [], plaintext: encodePlaintext("caps", { features: [...CAPS_FEATURES] }) });
				await run.client.postEnvelope(run.teamId, envelope);
				sent.ts = ts;
			} catch (error) {
				if (error instanceof RelayError && error.code === "unknown-kind") {
					sent.offUntil = now + CAPS_OFF_MS;
					this.o.store.log({ event: "caps-unsupported", team: run.team });
				} else this.o.store.log({ event: "caps-failed", team: run.team, error: String(error) });
			}
		}
	}

	/** Messages that wait for the tower identity `identity` the sb server runs, oldest received first (an ally run takes them). */
	servedFor(identity: string): InboxItem[] {
		const items: InboxItem[] = [];
		for (const [id, w] of this.waiting) {
			if (!w.served || w.identity !== identity) continue;
			const item = this.o.store.readInbox(id);
			if (item && !item.reply) items.push(item);
		}
		return items.sort((a, b) => a.received - b.received || (a.id < b.id ? -1 : 1));
	}
	/** Whether `device` is a member of `team` on this computer's roster (a run whose sender left is ended). */
	isMember(team: string, device: string): boolean {
		try {
			return this.loadTeam(team).state.members.has(device);
		} catch {
			return false;
		}
	}

	// ---- Confirms across devices (Remote turns, `forward`) ------------------------------------------------------------------------------

	/** A tower of this device asks `device` to confirm a tool call of a remote turn. Only a tower of a bound workspace may, and only of a team's own member. */
	async requestConfirm(req: ConfirmRequestInput): Promise<{ ok: true } | { ok: false; error: string }> {
		if (!this.running || !this.device) return { ok: false, error: "This computer's link holder is not running" };
		const run = this.runs.get(req.team);
		if (!run || run.dead) return { ok: false, error: "That team is not running on this device" };
		const policy = this.o.config().teams.get(req.team);
		const net = await this.o.net();
		const pane = net.panes.find((p) => net.sessions.find((x) => x.id === req.fromSession)?.herdrLocation?.paneId === p.pane_id);
		if (!policy || !pane || pane.tokens?.sb_role !== "tower" || !pane.cwd || !inside(pane.cwd, policy.project)) return { ok: false, error: "Only the tower of a workspace bound to the team can ask a device to confirm" };
		if (!this.loadTeam(run.team).state.members.has(req.device)) return { ok: false, error: "That device is not in the team" };
		// Written down before the request goes out: an answer can come back before submit returns.
		const now = this.now();
		for (const [id, a] of this.asked) if (now - a.at > CONFIRM_MAX_MS) this.asked.delete(id);
		this.asked.set(req.dialogId, { team: req.team, device: req.device, digest: req.digest, tower: req.fromSession, at: now });
		try {
			await run.outbox.submit((seq) => {
				const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
				if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
				return buildEnvelope({
					team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq, ts: this.now(), kind: "confirm-request", to: [req.device],
					plaintext: encodePlaintext("confirm-request", { dialogId: req.dialogId, digest: req.digest, tool: req.tool, args: req.args, tower: req.tower }),
				});
			});
		} catch (error) {
			this.asked.delete(req.dialogId);
			return { ok: false, error: (error as Error).message };
		}
		return { ok: true };
	}
	/** The tower no longer waits (the dialog ended another way): a late answer is dropped. */
	forgetConfirm(dialogId: string): void {
		this.asked.delete(dialogId);
	}
	private takeConfirmRequest(run: TeamRun, roster: RosterState, header: Header, p: ConfirmRequest): void {
		const from = header.from, sender = roster.members.get(from), now = this.now();
		for (const [id, c] of this.confirms) if (now - c.at > CONFIRM_MAX_MS) this.confirms.delete(id);
		// answerConfirm takes the dialog id alone, so one id held for another device must not be replaced (its answer would go to the wrong requester).
		const held = this.confirms.get(p.dialogId);
		if (held && held.from !== from) return void this.o.store.log({ event: "drop", team: run.team, reason: "confirm-request-id-taken", from, kind: "confirm-request" });
		while (this.confirms.size >= CONFIRM_MAX) this.confirms.delete(this.confirms.keys().next().value!);
		this.confirms.set(p.dialogId, { dialogId: p.dialogId, team: run.team, from, fromLabel: sender?.label ?? shortId(from), fromShort: shortId(from), digest: p.digest, tool: p.tool, args: p.args, tower: p.tower, at: now });
		this.o.notify(`Straw Link: ${sender?.label ?? shortId(from)} asks you to confirm a ${restrictLabel(p.tool)} call from its tower`, "warning");
	}
	private takeConfirmAnswer(run: TeamRun, roster: RosterState, header: Header, p: ConfirmAnswer): void {
		const ask = this.asked.get(p.dialogId);
		// Only the device the request went to (and still a member of the roster), with the dialog's digest, and only once; anything else is dropped without using the dialog up.
		if (!ask || !roster.members.has(header.from) || ask.team !== run.team || ask.device !== header.from || ask.digest !== p.digest) return void this.o.store.log({ event: "drop", team: run.team, reason: "confirm-answer-unexpected", from: header.from, kind: "confirm-answer" });
		this.asked.delete(p.dialogId);
		try {
			this.o.confirmed?.(ask.tower, p.dialogId, p.allow);
		} catch (error) {
			this.o.store.log({ event: "confirmed-failed", error: String(error) });
		}
	}
	/** The confirm requests waiting for this device's boss, newest last (for the GUI). */
	confirmRequests(): ConfirmView[] {
		const now = this.now();
		return [...this.confirms.values()].filter((c) => now - c.at <= CONFIRM_MAX_MS);
	}
	/** This device's boss answers a confirm request: allow or deny goes back to the requesting device, and the request is used up. */
	async answerConfirm(dialogId: string, allow: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
		const c = this.confirms.get(dialogId);
		if (!c || this.now() - c.at > CONFIRM_MAX_MS) return { ok: false, error: "That request is gone or has timed out" };
		const run = this.runs.get(c.team);
		if (!run || run.dead || !this.running || !this.device) return { ok: false, error: "That team is not running on this device" };
		this.confirms.delete(dialogId);
		await run.outbox.submit((seq) => {
			const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
			if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
			return buildEnvelope({
				team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq, ts: this.now(), kind: "confirm-answer", to: [c.from],
				plaintext: encodePlaintext("confirm-answer", { dialogId, digest: c.digest, allow, answerId: randomBytes(16).toString("hex") }),
			});
		});
		return { ok: true };
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
	list(only?: readonly string[]): AllyTeam[] {
		const policies = this.o.config().teams;
		return [...this.runs.values()].flatMap((run): AllyTeam[] => {
			if (run.dead || (only && !only.includes(run.team))) return [];
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

	// ---- The work board -----------------------------------------------------------------------------------------------------------------

	/** The entries this team gets: live mains whose pane's directory is inside the team's project, joined with the entries they wrote (newest first, at most 24). */
	private async boardFor(project: string, device: string, net: NetView, entries: Entry[]): Promise<BoardWireEntry[]> {
		const panes = new Map(net.panes.map((p) => [p.pane_id, p]));
		const byId = new Map(entries.map((e) => [e.session, e]));
		return net.sessions.flatMap((x): BoardWireEntry[] => {
			const pane = panes.get(x.herdrLocation?.paneId ?? "");
			if (pane?.tokens?.sb_role !== "main" || !pane.cwd || !inside(pane.cwd, project)) return [];
			const e = byId.get(x.id), shown = e && forAllies(e); // an auto-filled entry leaves as its line and done count only (spec, Work board, Sharing)
			return [{ id: wireId(device, x.id), workspace: x.herdrLocation?.workspace?.label ?? "", tab: x.herdrLocation?.tab?.label ?? "", name: x.name ?? "", now: shown?.now ?? "", updated: e?.updated ?? 0, items: shown?.items ?? [] }];
		}).sort((a, b) => b.updated - a.updated).slice(0, LIMITS.boardEntries);
	}

	/** One look at the board folder per tick: each team gets its own board when it changed (at most once per 15 s), once at a stream start, and once an hour unchanged. */
	private async sendBoards(): Promise<void> {
		const dir = this.o.boardDir;
		if (!dir || !this.running || !this.device) return;
		const now = this.now();
		// A team is looked at once per 15 s: a change inside the window goes out at its end, and a quiet computer does not read Herdr on every tick.
		const due = [...this.runs.values()].filter((run) => !run.dead && now >= run.boardSent.offUntil && now - run.boardSent.looked >= (this.o.boardMinMs ?? BOARD_MIN_MS));
		if (due.length === 0) return;
		// Marked before the awaits, so a tick that starts while this one waits does not look again.
		for (const run of due) run.boardSent.looked = now;
		const config = this.o.config(), entries = readEntries(dir), net = await this.o.net();
		purge(dir, new Set(net.sessions.map((x) => x.id)), now);
		for (const run of due) {
			try {
				await this.sendBoard(run, config.teams.get(run.team), net, entries);
			} catch (error) {
				this.o.store.log({ event: "board-failed", team: run.team, error: String(error) });
			}
		}
	}
	private async sendBoard(run: TeamRun, policy: { project: string; share: string } | undefined, net: NetView, entries: Entry[]): Promise<void> {
		if (!policy) return;
		const sent = run.boardSent, now = this.now(), device = this.device!.keys.id;
		// With `presence` a team gets no board; one that had a board and was then set to `presence` gets one empty board, so its allies' copy clears.
		const wanted = policy.share === "status" ? await this.boardFor(policy.project, device, net, entries) : [];
		if (policy.share !== "status" && sent.wasEmpty) return;
		const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
		if (!key) return;
		const hash = createHash("sha256").update(JSON.stringify(wanted)).digest("hex");
		const changed = hash !== sent.hash || state.epoch !== sent.epoch;
		if (!(changed ? now - sent.at >= (this.o.boardMinMs ?? BOARD_MIN_MS) : now - sent.at >= BOARD_REFRESH_MS)) return;
		// `ts` rises by at least 1 per board, so a receiver's per-sender guard never drops a board for an equal clock reading.
		const ts = Math.max(now, sent.ts + 1);
		sent.at = now; // a failed post is tried again after the spacing, not on every tick
		const envelope = buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq: 0, ts, kind: "board", to: [], plaintext: encodePlaintext("board", { entries: wanted }) });
		try {
			await run.client.postEnvelope(run.teamId, envelope);
		} catch (error) {
			if (error instanceof RelayError && error.code === "unknown-kind") {
				// A relay older than the board kind: told once in the log, no board to this team for an hour, nobody else told.
				sent.offUntil = now + BOARD_OFF_MS;
				this.o.store.log({ event: "board-unsupported", team: run.team });
				return;
			}
			throw error;
		}
		Object.assign(sent, { hash, ts, epoch: state.epoch, wasEmpty: wanted.length === 0 });
	}

	/** The boards of the allies of `only` teams (all when omitted), or of one device (an id, short id, or label as `tower_send` takes it). Text is cut and cleaned again; labels are the roster's. */
	boards(o: { only?: readonly string[]; device?: string } = {}): { ok: true; boards: AllyBoard[] } | { ok: false; error: string } {
		const policies = this.o.config().teams, now = this.now();
		const rows: AllyBoard[] = [], members: MemberRef[] = [];
		const eligible = [...this.runs.values()].filter((run) => !run.dead && (!o.only || o.only.includes(run.team)));
		const rosters = new Map<string, RosterState>();
		for (const run of eligible) {
			try {
				const { state } = this.loadTeam(run.team);
				rosters.set(run.team, state);
				for (const [id, m] of state.members) members.push({ team: run.team, id, label: m.label ?? shortId(id) });
			} catch { /* a team file that cannot be read has no board to show */ }
		}
		let only: { team: string; id: string } | undefined;
		if (o.device !== undefined) {
			const picked = resolveDevice(o.device, oneTeamEach(members), this.device?.keys.id ?? "");
			if (!picked.ok) return { ok: false, error: picked.error };
			only = picked;
		}
		for (const run of eligible) {
			const roster = rosters.get(run.team);
			if (!roster) continue;
			// A device that left the roster loses its board at once.
			for (const id of [...run.boards.keys()]) if (!roster.members.has(id)) run.boards.delete(id);
			for (const [id, seen] of run.boards) {
				if (only && (only.team !== run.team || only.id !== id)) continue;
				const presence = run.presences.get(id), lastSeen = presence?.at ?? seen.at;
				if (now - lastSeen > BOARD_OFFLINE_MS || now - seen.ts > BOARD_MAX_AGE_MS) continue;
				const label = roster.members.get(id)?.label ?? shortId(id);
				rows.push({
					origin: "remote", team: policies.get(run.team)?.name ?? run.team.slice(0, 6), teamId: run.team, device: { id, short: shortId(id), label },
					online: presence !== undefined && now - presence.at <= PRESENCE_ONLINE_MS, boardSecondsAgo: Math.max(0, Math.round((now - seen.at) / 1000)),
					entries: seen.board.entries.slice(0, LIMITS.boardEntries).map((e): AllyBoardEntry => ({
						id: clean(e.id, 16), workspace: clean(e.workspace, BOARD.label), tab: clean(e.tab, BOARD.label), main: clean(e.name, BOARD.label), ...cleanText(e),
						...(e.updated > 0 ? { updatedSecondsAgo: Math.max(0, Math.round((now - e.updated) / 1000)) } : {}),
					})),
				});
			}
		}
		// The answer has to fit the channel: devices are kept while their JSON fits.
		const out: AllyBoard[] = [];
		let size = 0;
		for (const row of rows) {
			size += Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
			if (size > MAX_BODY_BYTES) break;
			out.push(row);
		}
		return { ok: true, boards: out };
	}

	/** A teammate on another roster head than ours is noted; the notice comes only if it stays so for 2 minutes (Presence). */
	private compareHead(run: TeamRun, from: string, presence: Presence, roster: RosterState): void {
		const same = presence.headSeq === roster.head.seq && Buffer.from(presence.headHash).equals(roster.head.hash);
		if (same) run.headDiff.delete(from);
		else if (!run.headDiff.has(from)) run.headDiff.set(from, this.now());
	}

	private alerts(): LinkAlert[] {
		const now = this.now(), name = (team: string) => this.o.config().teams.get(team)?.name ?? team.slice(0, 6), out: LinkAlert[] = [];
		for (const r of this.admin.joinRequests()) out.push({ id: `join/${r.id}`, kind: "join-request", level: "warning", team: r.team, teamName: r.teamName, data: { label: r.label, short: r.short, unattended: r.unattended ? 1 : 0 } });
		for (const c of this.confirmRequests()) out.push({ id: `confirm/${c.dialogId}`, kind: "confirm", level: "warning", team: c.team, teamName: name(c.team), data: { label: c.fromLabel, short: c.fromShort, tool: restrictLabel(c.tool) } });
		for (const team of this.o.store.teamIds()) {
			const why = this.stopped.has(team) ? (this.o.store.readStopped(team)?.reason ?? "stopped") : this.o.store.readStopped(team)?.reason;
			const run = this.runs.get(team);
			const reason = run?.dead ?? why;
			if (reason) out.push({ id: `fork/${team}`, kind: "fork", level: "error", team, teamName: name(team), data: { reason } });
		}
		for (const run of this.runs.values()) {
			if (run.dead) continue;
			if (run.downSince !== undefined && now - run.downSince > DOWN_MS) out.push({ id: `down/${run.team}`, kind: "unreachable", level: "warning", team: run.team, teamName: name(run.team), data: { minutes: Math.floor((now - run.downSince) / 60_000) } });
			for (const [device, since] of run.headDiff) {
				const seen = run.presences.get(device);
				if (now - since > HEAD_DIFF_MS && seen && now - seen.at <= PRESENCE_ONLINE_MS) out.push({ id: `heads/${run.team}/${device}`, kind: "mismatch", level: "error", team: run.team, teamName: name(run.team), data: { label: seen.presence.label, short: shortId(device) } });
			}
		}
		const waits = new Map<string, { kind: "inbox" | "held" | "served"; team: string; n: number }>();
		for (const w of this.waiting.values()) {
			// A message for a tower the server runs waits for an ally run slot: the boss hears of it after 10 minutes.
			const kind = w.served ? (now - w.since > HELD_MS ? "served" : undefined) : w.offered ? (now - w.since > HELD_MS ? "held" : undefined) : "inbox";
			if (!kind) continue;
			const key = `${kind}/${w.team}`, hit = waits.get(key);
			waits.set(key, { kind, team: w.team, n: (hit?.n ?? 0) + 1 });
		}
		for (const [key, w] of waits) out.push({ id: key, kind: w.kind, level: "info", team: w.team, teamName: name(w.team), data: { count: w.n } });
		return out;
	}

	/** The compact reading for the net snapshot: ally bases from presence, the notices, and the confirms waiting. */
	summary(): LinkSummary {
		const allies = this.list().flatMap((t) => t.devices.flatMap((d): AllyBase[] => {
			const base = { team: t.team, teamName: t.name, device: d.id, short: d.short, label: d.label, online: d.online };
			if (d.workspaces.length === 0) return [{ ...base, id: `${t.team}/${d.id}`, workspace: null, tower: "unknown", tabs: [] }];
			return d.workspaces.map((w) => ({ ...base, id: `${t.team}/${d.id}/${w.label}`, workspace: w.label, tower: w.tower, tabs: w.tabs.map((x) => ({ label: x.label, state: x.state })) }));
		}));
		return { allies, alerts: this.alerts(), confirms: this.confirmRequests() };
	}

	/** Everything the team settings page draws. */
	view(): LinkView {
		const d = this.device!, config = this.o.config();
		const teams = this.admin.teamViews();
		for (const team of this.o.store.teamIds()) {
			if (teams.some((t) => t.team === team)) continue;
			const reason = this.o.store.readStopped(team)?.reason ?? this.runs.get(team)?.dead ?? "not running";
			const policy = config.teams.get(team);
			teams.push({ team, name: policy?.name ?? team.slice(0, 6), project: policy?.project ?? "", share: policy?.share ?? "status", relay: "", epoch: 0, headSeq: 0, self: { role: "member", attended: true }, members: [], status: "stopped", stoppedWhy: reason, relayDown: false, secondAdmin: [], onlyAdmin: false });
		}
		return { ...this.summary(), deviceId: d.keys.id, short: d.keys.shortId, label: d.label, relay: config.relay, teams, invites: this.admin.invites(), joinRequests: this.admin.joinRequests(), join: this.admin.joinView(), prefill: this.admin.prefill && { ...this.admin.prefill } };
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
