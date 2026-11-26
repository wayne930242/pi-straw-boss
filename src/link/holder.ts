import { Buffer } from "node:buffer";
import { basename } from "node:path";
import { allyLabel } from "../boardauto.ts";
import { cleanText, clean, BOARD, forAllies, purge, readEntries, wireId, type Entry } from "../board.ts";
import { capDir, readDevice } from "../capacity.ts";
import { readHold } from "../hold.ts";
import { endHolds, readHolds } from "./holds.ts";
import { createHoldOps, type HoldOps } from "./holdops.ts";
import type { AllySeen } from "../server/capwatch.ts";
import { MAX_BODY_BYTES } from "./wire.ts";
import { restrictLabel, restrictOwner } from "./text.ts";
import { createHash, randomBytes } from "node:crypto";
import { isHead, isSub, type Session } from "../herdr.ts";
import { type Level, LEVELS, type LinkConfig, type Share } from "./config.ts";
import { shortId, type DeviceKeys } from "./device.ts";
import { buildEnvelope, openEnvelope, parseEnvelope, recordTaken, type Header, type ReceiveState } from "./envelope.ts";
import { PayloadTooLargeError, ProtocolError, RelayError, UnauthorizedError } from "./errors.ts";
import { askIdOk, type Board, type BoardWireEntry, type WireCap, type Caps, type ConfirmAnswer, type ConfirmRequest, type DialogAnswer, type DialogClose, type DialogOpen, encodePlaintext, handleOk, KINDS, kindOk, LIMITS, type MainStatus, type Notice, type OperateMessage, operateDirectionOk, type Presence, type TowerMessage, type TowerReply, type UnitStatus, type UnitStop, type WaitWire, type WireHold, type WorkspaceState } from "./kinds.ts";
import { type AdminRun, type InviteView, type JoinRequestView, type JoinView, type Prefill, TeamAdmin, type TeamView } from "./admin.ts";
import { Outbox, type QueuedEnvelope } from "./outbox.ts";
import { Requests } from "./request.ts";
import type { RelayClient } from "./relay.ts";
import { decodeEntry, encodeEntry, replayEncoded, type Role, type RosterEntry, type RosterState } from "./roster.ts";
import { inside, nearestTeams, oneTeamEach, resolveDevice, towerAt, towersFor, type MemberRef, type NetView } from "./routing.ts";
import type { Backoff, Sleep } from "./retry.ts";
import type { Disposition, EnvelopeEvent, LiveEvent, RelayEvent, RosterEvent } from "./sse.ts";
import { TeamFileError, type InboxItem, type LinkStore, type TeamFile, type ThreadRow } from "./store.ts";
import { type DialogAnswerInput, DialogViews, newAnswerId } from "./dialogs-out.ts";
import { towerRunsEnabled } from "../server/towerruns.ts";

// The link holder's work (docs/specs/2026-10-25-straw-link.md, Link holder). Only the session the election names runs this: it reads the device
// keys, holds the relay stream of each team, and writes the team files; every write is under link/holder.lock. A message the relay delivers is
// checked and decrypted, then written to the inbox (a durable, private staging area), and only then acknowledged, so a crash or a takeover
// delivers it again rather than losing it, and the receive checks drop the second copy. A tower takes it from the inbox when it is idle.

/** The part of the relay client the holder uses; tests swap in the same client over a fake `fetch`, and the live test uses the real one. */
export type RelayPort = Pick<RelayClient, "stream" | "postEnvelope" | "postLive" | "getRoster" | "createTeam" | "appendRoster" | "createInvite" | "join">;

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
	asks?: { take(q: { team: string; device: string; ask: string }): { main: string; mainName: string; tower: string; workspace: string; wait?: string } | undefined };
	/** Told, at each pass of the inbox, that messages wait for a tower identity the sb server runs (src/server/towers.ts): an ally run is woken for them. */
	served?: (identity: string) => void;
	/**
	 * Opens or wakes a tower for the team's project (src/server/opentower.ts) when no tower of it is open. `open` (an unattended device, a `dispatch` sender) takes a workspace of the project or makes one; `wake` (an attended device,
	 * a teammate at `reply` or higher) only gives the tower to a workspace the device already has, and answers `no-workspace` when there is none. Absent: nothing is opened. `from` is the controller whose message found no tower:
	 * a failed `open` is told to it and the admins (docs/specs/2026-11-05-link-shared-box.md).
	 */
	openTower?: (project: string, toWorkspace: string | undefined, from: string, mode: "open" | "wake") => Promise<void | "no-workspace">;
	/** How often `caps` is sent unchanged (default an hour) and the least time between two (default 15 s). */
	capsMs?: number;
	capsMinMs?: number;
	/** An unattended device: where a `dialog-answer` goes once the sender is checked to be attended and at `dispatch` now (src/link/dialogs-out.ts `DialogForwarder.answer`, which checks the rest). */
	dialogAnswer?: (a: DialogAnswerInput) => void | Promise<void>;
	/** Where a taken `operate` message goes. A build with no sink does not list `operate/1` in its caps and drops what it is sent. */
	operate?: (message: OperateIn) => void;
	/**
	 * An unattended device: whether its policy grants anyone `operate` now. `operate/1` is in its caps only while this says so (a box that grants nobody is offered to nobody), and a change is sent as new caps at the next tick. Read at each tick
	 * and when caps are built; one that throws reads as no. Not given: the sink alone decides (an attended device).
	 */
	operateOn?: () => boolean;
	/** Told at the first tick, and at each tick that reads `operateOn` differently than the one before. Must not throw (one that does is logged without its message). */
	operateChanged?: (on: boolean) => void;
	/**
	 * Told right after a team's roster changed on this device (entries applied and stored) and when the team stops (the box removed, a fork): the operate guard rechecks its sessions then (docs/specs/2026-11-07-link-operate.md §5.6).
	 * `member` already answers from the new roster. Called outside the holder's lock, except from a team's stopping; it must not throw, and one that does is logged without its message and ignored.
	 */
	onRoster?: (team: string) => void;
	/** An unattended device: where a `unit-stop` goes once the holder's checks passed (docs/specs/2026-11-07-link-remote-stop.md §4: this device unattended, an attended sender at `dispatch` now, a request no older than 15 minutes, a known mode). The server's checks follow there. */
	unitStop?: (a: UnitStopInput) => void | Promise<void>;
	/** An unattended box that opens workers for its `dispatch` controllers (docs/specs/2026-11-26-ally-workers.md): `tower.worker` is in its caps while this says yes (a `capacity.budget` and `workers` in config.json). Read when caps are built. */
	workers?: () => boolean;
	/**
	 * The wait router of the sb server (src/server/linkwaits.ts, docs/specs/2026-11-21-box-mac-waits.md): with it this device lists `tower.wait` in its caps. `take` gets every inbox message that carries a wait (an open one for this
	 * computer, or a state of one either end holds) with the workspace delivery picks for its project, and answers whether it is taken (it then leaves the inbox) or waits there. `orphan` gets the reply to an ask whose main is gone
	 * or no longer a main (C2): taken, it never reaches an ally run. `notice` gets a box's notice that names an ask (`ref`, C4).
	 */
	waits?: {
		/** True: taken (it leaves the inbox). False: no tower here routes it (none is open, or one the server does not run), so it is a tower message that found no tower. `held`: it stays in the inbox for a later pass. */
		take(item: InboxItem, workspace: string | undefined): Promise<boolean | "held">;
		orphan?(item: InboxItem, mainName: string, workspace: string | undefined): Promise<boolean | "held">;
		notice?(n: { team: string; device: string; label: string; kind: string; text: string; ref: string }): void;
		/** The open waits a device's mains have on this computer, by the main's handle (`L<n>` ids): the ally card's "waiting on" line (item D). */
		openOn?(device: string): Record<string, string[]>;
	};
}

/** An `operate` message the holder took (docs/specs/2026-11-07-link-operate.md §5.1): checked, decrypted and in the right direction for its sender. `dropped` is the relay's resync hint. */
export interface OperateIn { team: string; from: string; fromAttended: boolean; message: OperateMessage; ts: number; dropped: number }
/** Why `sendLive` did not send: the peer (or this end) does not take operate, the relay does not yet, or the send is in the wrong direction. */
export class OperateSendError extends Error {
	readonly reason: "peer" | "relay" | "direction";
	constructor(reason: "peer" | "relay" | "direction", message: string) {
		super(message);
		this.name = "OperateSendError";
		this.reason = reason;
	}
}

/** A `unit-stop` the holder accepted: `at` is its header `ts`. `mode` is one of `STOP_MODES`. */
export interface UnitStopInput { team: string; from: string; stopId: string; handle: string; mode: string; reason: string; at: number }
/** The modes of a stop this build takes, and how old (at the box, by the request's own `ts`) a stop may be. */
export const STOP_MODES = ["quit", "interrupt"] as const;
export const STOP_MAX_AGE_MS = 15 * 60_000;
/** What `requestUnitStop` answers: `sent` when the relay holds the request, `queued` when it does not yet (it is sent again until it does), or why it was not sent. */
export type UnitStopResult = { ok: true; status: "sent" | "queued"; stopId: string; id: string } | { ok: false; error: string };

/** `served`: the server made the request as one of its own runs (main.ts), so a tower identity it runs with no pane may be the sender (routing.ts `towerAt`); nothing a session sends sets it. */
export interface ConfirmRequestInput { fromSession: string; served?: boolean; team: string; device: string; dialogId: string; digest: string; tool: string; args: string; tower: string }
/** A confirm-request another device sent, waiting for this device's boss. */
export interface ConfirmView { dialogId: string; team: string; from: string; fromLabel: string; fromShort: string; digest: string; tool: string; args: string; tower: string; at: number }
const CONFIRM_MAX_MS = 10 * 60_000;
const CONFIRM_MAX = 20;
/** `awaitsReply`: an ask id (32 hex) a local tower made for a main; `inReplyTo`: the ask id of the message this one answers (an ally run's reply). Each is written to the wire only against the peer's `caps` (Replies for a main). */
/** `wait`: a link wait or its state (docs/specs/2026-11-21-box-mac-waits.md §2.3), written as the sixth field to a peer whose `caps` list `tower.wait`; to any other an open wait goes as text whose first line is `[waits on you: <what>]`, and a state is not sent. */
/** `served`: as in `ConfirmRequestInput`. */
export interface SendRequest { fromSession: string; served?: boolean; device: string; workspace?: string; text: string; reply: boolean; awaitsReply?: string; inReplyTo?: string; wait?: WaitWire }
export type SendResult = { ok: true; text: string; details: Record<string, unknown> } | { ok: false; error: string };
/** What the GUI shows as a notice. `data` is plain text and numbers: the page puts them in text nodes. */
export type AlertKind = "join-request" | "confirm" | "dialog" | "fork" | "mismatch" | "unreachable" | "inbox" | "held" | "served" | "notice";
/** A tower the sb server runs (src/server/towers.ts) is an identity, not a session: it takes no offer, so what is for it waits in the inbox until an ally run takes it (B6). */
const SERVED_TOWER = /^sb-tower-/;
const OPEN_BACKOFF_MS = 60_000;
/** A wake that worked hides the notice for this long, counted from the first of the wakes that worked in a row; a tower that has not taken the message by then is the boss's to hear of. */
const WAKE_GRACE_MS = 2 * 60_000;
/**
 * A wake backs off by what it ended in, doubling from a minute for each time in a row it ended the same way: a tower the net never shows and a computer with no workspace to wake are not tried every minute for a week
 * (each try is two Herdr calls and two lines of link.log, which rotates at 1 MiB). A failed wake waits at most 10 minutes, the others 30.
 */
const WAKE_BACKOFF_MS = 60_000;
const WAKE_CAP_MS = { none: 30 * 60_000, woke: 30 * 60_000, failed: 10 * 60_000 } as const;
/** How many towers one sender's messages wake at once: the rest wait their turn (a sender names workspaces, and each wake is a Herdr round trip). */
const WAKES_PER_SENDER = 3;
/** Why a wake failed, in the words the boss reads (the server's own words stay in link.log): the page maps the same three codes. */
type WakeReason = "service" | "project" | "other";
const WAKE_WHY: Record<WakeReason, string> = { service: "the tower service is still starting", project: "the team's project folder is missing or not allowed on this computer", other: "something went wrong; link.log has the details" };
/**
 * How a wake of an existing workspace's tower stands: `queued` waits for one of its sender's wakes to end, `waking` is in flight, `woke` worked; `failed`, `none` (nothing to wake) and `off` (tower runs are switched off, which no wake can change)
 * are what the notice tells. `streak` counts the times in a row it ended the same way; `sig` is the workspaces of the project a `none` saw, to try again when they change.
 */
interface WakeState { at: number; first: number; state: "queued" | "waking" | "woke" | "failed" | "none" | "off"; streak: number; reason?: WakeReason; sig?: string }
/** The pi the server started for a run, which sits in the standing pane while the run lives: the message is the tower's, even if the run's pi is the session found there. */
const SERVED_RUN = /^tower run · /;
/** A message in the inbox that has not reached a tower, as the notices read it: who sent it and when it came, and (once a drain found no tower for it) the workspace label or project the notice names. */
interface Waiting { team: string; from: string; fromId: string; since: number; toWorkspace: string; offered: boolean; served?: boolean; identity?: string; workspace?: string; project?: string; target?: string; wakeKey?: string; local?: "none" | "off" }
export interface LinkAlert { id: string; kind: AlertKind; level: "info" | "warning" | "error"; team: string; teamName: string; data: Record<string, string | number> }
/** A teammate's workspace as the map shows it beside the local bases (spec, GUI). */
/** `unattended`: the device is an unattended box (the roster says so): its card says how many units are online, not its mains; absent for a teammate's computer, whose mains and workers the card lists. */
export interface AllyBase { id: string; team: string; teamName: string; device: string; short: string; label: string; online: boolean; unattended?: true; workspace: string | null; tower: string; tabs: { label: string; state: string }[] }
/** The compact reading the net snapshot carries: it changes only when something worth redrawing does. */
/** What an unattended device last said about its units (`unit-status`, kept in memory): shown beside its ally bases while it keeps saying it. */
/** `at` is when this computer took the status (epoch ms), for the card's clock; `stale` is set when the device has sent no status for `UNITS_FRESH_MS`: what is shown is its last one. */
export interface DeviceUnits {
	team: string;
	device: string;
	units: UnitStatus[];
	/** The mains this computer may stop, when the box sent them (it does so only against this device's `caps`). */
	mains?: MainStatus[];
	/** The box's fresh `caps` list `unit-stop`, so a stop request is worth sending (the page shows a Stop button, `/boss link stop` goes on); absent for a box that takes no stop (a 0.60 box, which sends no `mains` either). */
	canStop?: true;
	/** With `mains`: the dispatchers the mains name (`by`), as this team's roster labels them; this computer's own is `self`. */
	dispatchers?: Record<string, { label: string; self?: true }>;
	/** The open link waits of the device's mains on this computer, by handle (docs/specs/2026-11-21-box-mac-waits.md §5). */
	waiting?: Record<string, string[]>;
	at: number;
	stale?: true;
}
export interface LinkSummary { allies: AllyBase[]; alerts: LinkAlert[]; confirms: ConfirmView[]; units: DeviceUnits[] }
/** Units a peer's `unit-status` may carry that are kept; how long one counts as current; how many notices are kept, and for how long. */
const UNITS_MAX = 32, UNITS_FRESH_MS = 3 * 60_000, UNITS_GONE_MS = 30 * 60_000, NOTICES_KEPT = 20, NOTICE_KEEP_MS = 24 * 3600_000;
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
	/** The boss's delegate this device names (link config `delegate`, D14): its label, the level this device gives it, and whether its fresh caps list `tower.approval`. */
	delegate?: { device: string; short: string; label: string; owner?: string; level: string; approval: boolean };
}
const HEAD_DIFF_MS = 2 * 60_000, DOWN_MS = 2 * 60_000, HELD_MS = 10 * 60_000;
/** A reply for a main that the main has not taken this long after the first offer (an older build never connects to the channel) goes to an ally run, which is told who asked. */
const REPLY_OFFER_MS = 5 * 60_000;
/** With a wait router (C2, docs/specs/2026-11-21-box-mac-waits.md §4) a live main keeps the offer of its reply until the ask itself ends (24 hours, src/server/asks.ts `ASK_KEEP_MS`). */
const REPLY_HOLD_MS = 24 * 3600_000;
/** How long a box lets a message with an ask wait with no run started before it tells the asker (C4). */
export const STUCK_MS = 10 * 60_000;

export interface AllyDevice { id: string; short: string; label: string; online: boolean; unattended?: true; ageMs: number | null; roster: number | null; workspaces: WorkspaceState[] }
export interface AllyTeam { team: string; name: string; devices: AllyDevice[] }
/** An ally's board as a tower reads it: text from the sender, cut and cleaned again; the device's label is the roster's. */
export interface AllyBoardEntry { id: string; workspace: string; tab: string; main: string; now: string; items: { t: string; done: boolean }[]; updatedSecondsAgo?: number }
/** An ally's capacity row as a tower reads it (docs/specs/2026-11-24-capacity.md): points and load in plain numbers, the paused mains by their entry ids with when they resume. */
export interface AllyCapacity { points: number; budget?: number; load1: number; cores: number; ready: number; minReady?: number; open: number; paused: { id: string; until?: string }[] }
/** `holds` and `heldBy` (docs/specs/2026-11-26-device-hold.md): the boxes its board says it holds, and the teammate whose hold its board says it honours. */
export interface AllyBoard { origin: "remote"; team: string; teamId: string; device: { id: string; short: string; label: string }; online: boolean; boardSecondsAgo: number; entries: AllyBoardEntry[]; capacity?: AllyCapacity; holds?: { device: string; short: string; label: string; sinceSecondsAgo: number }[]; heldBy?: { device: string; short: string; label: string; sinceSecondsAgo: number } }
/** A board from a device that has been offline longer than this, or is older than 7 days, is not shown (spec, Holding allies' boards). */
const BOARD_OFFLINE_MS = 2 * 3600_000, BOARD_MAX_AGE_MS = 7 * 24 * 3600_000;
/** The board is sent at most this often per team, and once an hour unchanged; a relay without the kind is left alone for an hour. */
const BOARD_MIN_MS = 15_000, BOARD_REFRESH_MS = 3600_000, BOARD_OFF_MS = 3600_000;
/** A board that carries a capacity row is sent at least this often, so a teammate can tell a silent device (over 30 minutes) from a quiet one. */
const CAP_REFRESH_MS = 10 * 60_000;
/** A hold whose main is missing from pi-intercom's list this long is gone (a /reload or a reconnect is shorter). */
const HOLD_GONE_MS = 2 * 60_000, HOLD_CAPS_WAIT_MS = 90_000;
/** What this build takes (docs/specs/2026-10-26-sb-backend.md, Replies for a main). A `caps` older than 2 hours counts as none. */
export const CAPS_FEATURES = ["tower.awaitsReply", "tower-reply", "unit-stop", "unit-status.mains", "unit-status.kind", "operate/1", "tower.wait", "notice.ref", "tower.standing", "tower.approval", "board.capacity", "tower.note", "tower.worker", "board.holds"] as const;
export const CAPS_STALE_MS = 2 * 3600_000;
/** A live frame is worth nothing late: its post gives up after this, so a stalled relay does not hold the serial chain of sends (spec §11.1, task 5). */
const LIVE_POST_MS = 5000;
/** A live envelope is delivered now: the holder takes none whose `ts` is older than this. */
const LIVE_FRESH_MS = 60_000;
/** The word in this holder's first `caps` after it started (not a feature): see `capsSent`. */
const HELLO = "hello";
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
	/** The last `unit-status` of each unattended peer, in memory only, and the `ts` of the last one this device sent (an ephemeral kind's `ts` has to rise). */
	units: Map<string, { at: number; units: UnitStatus[]; mains?: MainStatus[] }>;
	unitTs: number;
	/** `operate`: the `ts` of the last live envelope sent (it has to rise), what is in flight (sends are serial per team), and until when a relay that refused the kind is not tried. */
	liveTs: number;
	liveChain: Promise<unknown>;
	liveOffUntil: number;
	/**
	 * What this holder last sent as `caps` to the team: when, the `ts` used, and until when a relay that refused the kind is left alone. `due`: a peer that has just started (it said `hello`) or came back after a gap has not heard ours, so one
	 * goes at the next tick the minimum spacing allows. `hello`: the first `caps` after this holder started carries the word `hello` until one is posted.
	 */
	capsSent: { at: number; ts: number; offUntil: number; due: boolean; hello: boolean };
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
	/** A held main's session that pi-intercom's list lacks, since when (`HOLD_GONE_MS`); and when this holder was made (`HOLD_CAPS_WAIT_MS`). */
	private holdMissing = new Map<string, number>();
	private readonly bornAt: number;
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
	/** Dialogs unattended devices forwarded to this one (src/link/dialogs-out.ts). */
	private dialogViews = new DialogViews();
	private draining: Promise<void> | undefined;
	private again = false;
	/** Inbox messages no tower has taken yet: no tower open, or offered and not taken. For the GUI's notices. */
	/** The main whose reply fell back to an ally run, per inbox id: a `taken` of that main that arrives afterwards (it read the item before the rewrite) does not remove the item an ally run is to get. */
	private replyFellBack = new Map<string, string>();
	/** Projects a tower is being opened for, and when an open of a project last ended, whether it worked or not (it is not tried again for `OPEN_BACKOFF_MS`: a tower that is slow to show in the net must not be opened again in a loop). */
	private opening = new Map<string, Promise<void>>();
	private openEnded = new Map<string, number>();
	/** The wakes of an attended device, by project and the id of the workspace asked for (`wakeKey`); who started each one in flight. */
	private wakes = new Map<string, WakeState>();
	private wakingFor = new Map<string, string>();
	private waiting = new Map<string, Waiting>();
	/** C4 (docs/specs/2026-11-21-box-mac-waits.md §4): the inbox messages an ally run took (no longer stuck), and the stuck notices told, once per message and reason. */
	private deliveredIds = new Set<string>();
	private stuckTold = new Set<string>();
	/** When a `tower-reply` last fell back to a plain `tower`, by device, so the log tells it once an hour. */
	private fellBack = new Map<string, number>();
	/** What `operateOn` read at the last tick (nothing before the first). */
	private operateRead: boolean | undefined;
	/** `tower-reply`s that stopped waiting for the relay (they answered "queued"), by envelope id: what to send instead when the relay refuses the kind. */
	private lateReplies = new Map<string, () => void>();
	/** What the GUI does to teams (admin.ts). */
	readonly admin: TeamAdmin;
	/** The link actions agents ask for, waiting for the boss (request.ts). */
	readonly requests: Requests;
	/** Device holds (holdops.ts, docs/specs/2026-11-26-device-hold.md). */
	readonly holds: HoldOps;

	constructor(o: HolderOptions) {
		this.o = o;
		this.now = o.now ?? Date.now;
		this.bornAt = this.now();
		const stateDir = o.stateDir ?? "", me = this;
		this.admin = new TeamAdmin({
			store: o.store, stateDir, home: o.home ?? "", agentDir: o.agentDir ?? "", now: () => this.now(),
			device: () => this.device!, config: o.config, unattended: () => (o.attended ? !o.attended() : false), relayFor: (url, keys) => o.relay(url, keys),
			runs: () => [...this.runs.values()], load: (team) => this.loadTeam(team),
			takeEntries: (run, entries) => this.takeEntries(run as TeamRun, entries), syncRoster: (run) => this.syncRoster(run as TeamRun),
			refresh: () => this.refresh(), stopTeam: async (team) => {
				const run = me.runs.get(team);
				me.runs.delete(team);
				if (run) await me.stopRun(run);
				me.rosterChanged(team);
			},
			notify: (text, level) => o.notify(text, level), log: (entry) => o.store.log(entry),
		});
		this.holds = createHoldOps({
			teams: () => this.admin.teamViews(), caps: (team, device) => this.capsFor(team, device), now: () => this.now(), attended: o.attended ?? (() => true), linkDir: o.store.dir, ...(o.boardDir ? { boardDir: o.boardDir } : {}),
			net: () => o.net(), allies: () => this.allySeen(), notice: (team, device, n) => this.sendDialog(team, device, "notice", n),
		});
		this.requests = new Requests({ admin: this.admin, teams: () => this.admin.teamViews(), now: () => this.now(), attended: o.attended ?? (() => true), home: o.home ?? "", agentDir: o.agentDir ?? "", holds: this.holds });
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
			this.takeJoinFile();
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
		for (const run of runs) this.rosterChanged(run.team);
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

	/** An unattended device's `link/join.txt` (admin.ts `joinFileTick`); the relay call it makes does not hold up the tick. */
	private takeJoinFile(): void {
		void this.admin.joinFileTick().catch((error: Error) => this.o.store.log({ event: "join-file-failed", error: error.message }));
	}

	private async tick(): Promise<void> {
		if (!this.running) return;
		await this.refresh();
		this.takeJoinFile();
		await this.drain();
		await this.sendBoards();
		this.watchOperate();
		await this.sendCaps();
	}

	/** Whether this holder lists `operate/1`: it has a sink, and (an unattended device) its policy grants someone operate now. */
	private operateListed(): boolean {
		if (!this.o.operate) return false;
		if (!this.o.operateOn) return true;
		try {
			return this.o.operateOn();
		} catch {
			return false;
		}
	}
	/** A policy that gained or lost `operate` changes the caps at once (the peers stop or start offering this box), and the operate side is told. */
	private watchOperate(): void {
		if (!this.o.operateOn) return;
		const on = this.operateListed(), first = this.operateRead === undefined;
		if (on === this.operateRead) return;
		this.operateRead = on;
		if (!first) for (const run of this.runs.values()) run.capsSent.due = true;
		try {
			this.o.operateChanged?.(on);
		} catch (error) {
			this.o.store.log({ event: "operate-changed-failed", error: (error as Error)?.name ?? "Error" });
		}
	}

	/** Starts the teams that have a team file and a config entry, stops the ones that lost either, and tells about the rest once. */
	async refresh(): Promise<void> {
		const { store } = this.o, config = this.o.config();
		for (const problem of config.problems) this.tellOnce(`config/${problem}`, `Straw Link: ${problem}`);
		for (const [team, run] of this.runs) {
			if (!config.teams.has(team) || run.dead) {
				this.runs.delete(team);
				void this.stopRun(run);
				if (!run.dead) this.rosterChanged(team);
			}
		}
		for (const team of store.teamIds()) {
			if (this.runs.has(team) || !this.running) continue;
			if (config.teams.has(team) && (await this.stillStopped(team))) continue;
			if (!config.teams.has(team)) {
				if (this.admin.joiningTeam() === team) continue; // a join waiting for its project folder
				this.tellOnce(`noconfig/${team}`, `Straw Link: team ${team.slice(0, 6)} has no entry under link.teams in config.json (or in the policy file on an unattended device), so it takes no messages`, "info");
				continue;
			}
			try {
				await this.startTeam(team);
			} catch (error) {
				this.tellOnce(`start/${team}`, `Straw Link: team ${team.slice(0, 6)} cannot be used: ${(error as Error).message}`);
			}
		}
		for (const policy of config.teams.keys()) {
			if (!store.teamIds().includes(policy)) this.tellOnce(`nofile/${policy}`, `Straw Link: team ${policy.slice(0, 6)} is in the team list (config.json, or the policy file on an unattended device) but this device has no team file for it; join the team again`);
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
		const run: TeamRun = { team, teamId, client, outbox, stream: undefined, presences: new Map(), boards: new Map(), boardSent: { hash: undefined, looked: 0, at: 0, ts: 0, epoch: 0, offUntil: 0, wasEmpty: false }, lastEphemeral: new Map(), caps: new Map(), units: new Map(), unitTs: 0, liveTs: 0, liveChain: Promise.resolve(), liveOffUntil: 0, capsSent: { at: 0, ts: 0, offUntil: 0, due: false, hello: true }, replyOffUntil: 0, presenceTimer: undefined, dead: undefined, settled, haltTimer: undefined, gone, waiters, downSince: undefined, headDiff: new Map() };
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
				if (st.state === "open") (Object.assign(run.boardSent, { hash: undefined, looked: 0 }), (run.capsSent.at = 0), (run.liveOffUntil = 0));
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
		this.rosterChanged(run.team);
	}

	// ---- Receiving ---------------------------------------------------------------------------------------------------------------------

	private async onEvent(run: TeamRun, event: RelayEvent): Promise<Disposition | void> {
		if (!this.running || run.dead) return "keep";
		try {
			switch (event.type) {
				case "envelope": return event.ephemeral ? await this.ephemeral(run, event) : await this.receive(run, event, false);
				case "roster": return await this.onRoster(run, event);
				case "live": return this.live(run, event);
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
		// A live kind never comes as a stored one: a relay that does that keeps what the client sends it, so the envelope is dropped unopened and the drop is the signal.
		if (kindOk(event.envelope.header.kind) && KINDS[event.envelope.header.kind].live) return (this.o.store.log({ event: "drop", team: run.team, reason: "live-on-stored-path", from: event.from, kind: event.envelope.header.kind }), "ack");
		const { tf, state: roster } = this.loadTeam(run.team);
		const opened = openEnvelope(event.envelope, this.state(run, tf, roster));
		if (!opened.ok) {
			this.o.store.log({ event: "drop", team: run.team, reason: opened.reason, from: event.from, kind: event.envelope.header.kind });
			return "ack";
		}
		run.lastEphemeral = recordTaken(this.state(run, tf, roster), opened.header).lastEphemeral;
		if (opened.header.kind === "board") run.boards.set(opened.header.from, { at: this.now(), ts: opened.header.ts, board: opened.message as Board });
		if (opened.header.kind === "unit-status") this.takeUnitStatus(run, roster, opened.header, opened.message as { units: UnitStatus[]; mains?: MainStatus[] });
		if (opened.header.kind === "caps") {
			// The word is the sender's own start, not a feature of it: a peer that just started has missed ours (the relay replays a `caps` only past the cursor it resumes from, and a queued envelope moves that past ours), so ours goes once.
			// The answer has no word, so two devices never answer each other more than once, and it keeps the minimum spacing.
			const features = (opened.message as Caps).features;
			run.caps.set(opened.header.from, { at: this.now(), features: features.filter((f) => f !== HELLO) });
			if (features.includes(HELLO) && opened.header.from !== this.device?.keys.id) run.capsSent.due = true;
		}
		if (opened.header.kind === "presence") {
			const presence = opened.message as Presence;
			// A device that was not here a moment ago (it was away over `PRESENCE_ONLINE_MS`: a stream that was down) may have missed this device's `caps`: they are sent again, once, at the next tick the minimum spacing allows. A device that keeps
			// sending presence does not cause it again. (A device that restarts says `hello`, above.)
			const prior = run.presences.get(opened.header.from);
			if (prior && this.now() - prior.at > PRESENCE_ONLINE_MS) run.capsSent.due = true;
			run.presences.set(opened.header.from, { at: this.now(), presence });
			this.compareHead(run, opened.header.from, presence, roster);
		}
		return "ack";
	}

	/** An `operate` envelope off the live stream: the receive checks of an ephemeral kind, the sender's direction, then the sink. Never acknowledged, never stored. */
	private live(run: TeamRun, event: LiveEvent): Disposition {
		const { tf, state: roster } = this.loadTeam(run.team), header = event.envelope.header;
		if (header.kind !== "operate") return (this.o.store.log({ event: "drop", team: run.team, reason: "live-kind", from: event.from, kind: header.kind }), "ack");
		const sink = this.o.operate;
		if (!sink) return (this.o.store.log({ event: "drop", team: run.team, reason: "operate-unsupported", from: event.from, kind: "operate" }), "ack");
		// One addressee, and delivered now: a live envelope older than a minute is a replay, whatever the 7-day window of the other kinds says.
		if (header.to.length !== 1) return (this.o.store.log({ event: "drop", team: run.team, reason: "operate-addressees", from: event.from, kind: "operate" }), "ack");
		if (header.ts < this.now() - LIVE_FRESH_MS) return (this.o.store.log({ event: "drop", team: run.team, reason: "stale-live", from: event.from, kind: "operate" }), "ack");
		const opened = openEnvelope(event.envelope, this.state(run, tf, roster));
		if (!opened.ok) return (this.o.store.log({ event: "drop", team: run.team, reason: opened.reason, from: event.from, kind: "operate" }), "ack");
		run.lastEphemeral = recordTaken(this.state(run, tf, roster), opened.header).lastEphemeral;
		const message = opened.message as OperateMessage, attended = roster.members.get(header.from)?.attended === true;
		if (!operateDirectionOk(message.type, attended)) return (this.o.store.log({ event: "drop", team: run.team, reason: "operate-direction", from: header.from, kind: "operate", type: message.type }), "ack");
		// The receiving end's role: an `open` is for the unattended box, an `accept` or `refuse` for the attended controller.
		const self = this.o.attended?.() ?? true;
		if ((message.type === "open" && self) || ((message.type === "accept" || message.type === "refuse") && !self)) return (this.o.store.log({ event: "drop", team: run.team, reason: "operate-role", from: header.from, kind: "operate", type: message.type }), "ack");
		try {
			sink({ team: run.team, from: header.from, fromAttended: attended, message, ts: header.ts, dropped: event.dropped });
		} catch (error) {
			this.o.store.log({ event: "operate-sink-failed", team: run.team, error: (error as Error)?.name ?? "Error" }); // the name only: what a sink threw may carry text of a session
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
			else if (header.kind === "dialog-open") this.takeDialogOpen(run, roster, header, opened.message as DialogOpen);
			else if (header.kind === "dialog-close") this.takeDialogClose(run, header, opened.message as DialogClose);
			else if (header.kind === "dialog-answer") this.takeDialogAnswer(run, roster, header, opened.message as DialogAnswer);
			else if (header.kind === "unit-stop") this.takeUnitStop(run, roster, header, opened.message as UnitStop);
			else if (header.kind === "notice") this.takeNotice(run, roster, header, opened.message as Notice);
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
			...(message.awaitsReply !== undefined ? { awaitsReply: message.awaitsReply } : {}), ...(message.wait !== undefined ? { wait: message.wait } : {}),
		};
		this.o.store.putInbox(item);
		this.o.store.log({ event: "tower-in", kind: "tower", team: run.team, from: header.from, id: item.id, ...(message.awaitsReply !== undefined ? { ask: message.awaitsReply } : {}), ...(message.wait !== undefined ? { wait: message.wait.id.slice(0, 8), state: message.wait.state } : {}) });
		this.thread(header.from, { dir: "in", at: item.received, id: item.id, kind: "tower", ...(message.awaitsReply !== undefined ? { awaitsReply: message.awaitsReply } : {}), text: message.text });
	}
	/** An ally run took the inbox message `id` into its session: one `link.log` line names the run, the sender, the team and the ask, never the text (docs/specs/2026-11-05-link-shared-box.md, Audit). */
	delivered(id: string, run: string): void {
		this.deliveredIds.add(id);
		const item = this.o.store.readInbox(id);
		if (item) this.o.store.log({ event: "tower-run", run, team: item.team, from: item.from, id, ...(item.awaitsReply !== undefined ? { ask: item.awaitsReply } : {}) });
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
			...(taken ? { reply: { ask: message.inReplyTo, main: taken.main, mainName: taken.mainName, tower: taken.tower, ...(taken.wait ? { wait: taken.wait } : {}) } } : {}),
		};
		this.o.store.putInbox(item);
		this.o.store.log({ event: "tower-in", kind: "tower-reply", team: run.team, from: header.from, id: item.id, ask: message.inReplyTo });
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
		let applied = false;
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
			applied = true;
		});
		if (applied) this.rosterChanged(run.team);
	}
	/** Tells `o.onRoster` that `team`'s roster changed or the team stopped. A throw is logged by its name only: what a hook threw may carry text of a session. */
	private rosterChanged(team: string): void {
		try {
			this.o.onRoster?.(team);
		} catch (error) {
			this.o.store.log({ event: "operate-roster-hook-failed", team, error: (error as Error)?.name ?? "Error" });
		}
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
		const wanted = new Set([...this.waiting.values()].map((w) => w.wakeKey));
		for (const key of this.wakes.keys()) if (!wanted.has(key) && !this.opening.has(key)) this.wakes.delete(key);
		// The pi notice for ghost names is told again once no ghost message of the team waits.
		const ghostTeams = new Set([...this.waiting.values()].filter((w) => w.target === "?").map((w) => w.team));
		for (const key of [...this.told]) { const m = /^inbox\/(.+)\/ghost$/.exec(key); if (m && !ghostTeams.has(m[1]!)) this.told.delete(key); }
		if (ids.length === 0) return;
		const config = this.o.config(), net = await this.o.net(), servedNow = new Set<string>(), runsOn = towerRunsEnabled(this.o.stateDir ?? "");
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
			this.waiting.set(id, this.waiting.get(id) ?? { team: item.team, from: item.fromLabel, fromId: item.from, since: item.received, toWorkspace: item.toWorkspace, offered: false });
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
			const pickedWs = () => towersFor(net, policy.project, item.toWorkspace)[0]?.workspace.workspace_id;
			if (item.wait && this.o.waits) {
				// A link wait, or a state of one: the router takes it (docs/specs/2026-11-21-box-mac-waits.md §2.2); no ally run ever gets it. One it holds waits here for the next pass. One no tower here routes goes on below as a tower
				// message that found no tower (woken, opened, or told to the boss), or to a tower the server does not run, never to an ally run (BMWR-F002).
				const took = await this.o.waits.take(item, pickedWs()).catch((error: Error) => (store.log({ event: "wait-take-failed", id, error: error.message }), "held" as const));
				if (took === true) {
					this.waiting.delete(id);
					await store.withLock(() => store.removeInbox(id));
				}
				if (took !== false) continue;
			}
			if (item.reply) {
				// An answer to an ask a local tower made for a main goes to that main, as peer data. A main that is gone (not live, or no longer its tab's main) hands it to the wait router, which tells another main of the workspace or the
				// boss's list (C2, docs/specs/2026-11-21-box-mac-waits.md §4); only a build with no router hands it to an ally run, which is told who asked. A live main keeps the offer, again every 30 s, until the ask's 24 hours end.
				const main = net.sessions.find((s) => s.id === item.reply!.main), mainPane = main && net.panes.find((p) => p.pane_id === main.herdrLocation?.paneId);
				const live = !!main && mainPane?.tokens?.sb_role === "main", was = this.offered.get(id), first = live && was?.tower === main.id ? (was.first ?? was.at) : this.now();
				const over = live && !this.o.waits && this.now() - first >= REPLY_OFFER_MS, expired = this.now() - item.received >= REPLY_HOLD_MS;
				if (!live || over || expired) {
					const { reply, ...plain } = item, why = !main ? "gone" : !live ? "not-main" : expired ? "expired" : "not-taken";
					this.offered.delete(id);
					const routed = this.o.waits?.orphan ? await this.o.waits.orphan(item, reply!.mainName, pickedWs()).catch((error: Error) => (store.log({ event: "wait-take-failed", id, error: error.message }), false)) : false;
					if (routed === "held") continue;
					if (routed) {
						store.log({ event: "reply-routed", id, why });
						this.waiting.delete(id);
						await store.withLock(() => store.removeInbox(id));
						continue;
					}
					await store.withLock(() => store.putInbox({ ...plain, askedBy: reply!.mainName }));
					if (main) this.noteReplyFallback(id, main.id);
					store.log({ event: "reply-fallback", id, why });
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
				// The notice names the workspace the sender asked for when it is a workspace of this computer that a tower could be woken in (not the head, not a sub workspace), else the project: an id of a workspace that is gone is no word for the boss.
				const byId = !!item.toWorkspace && net.workspaces.some((w) => w.workspace_id === item.toWorkspace);
				const asked = item.toWorkspace ? net.workspaces.find((w) => !isSub(w) && !isHead(w) && (byId ? w.workspace_id === item.toWorkspace : w.label === item.toWorkspace) && net.panes.some((p) => p.workspace_id === w.workspace_id && p.cwd !== undefined && inside(p.cwd, policy.project))) : undefined;
				const where = asked ? restrictLabel(asked.label) : undefined, project = basename(policy.project) || policy.project, ghost = !!item.toWorkspace && !asked;
				const level = config.trust.get(item.from) ?? "reply", mode = this.towerMode(level);
				if (mode === "open") this.openFor(policy.project, item.from, item.toWorkspace || undefined);
				const ref = mode === "wake" ? this.wakeFor(policy.project, item.from, asked?.workspace_id, ghost, runsOn, net) : undefined;
				const target = ghost ? "?" : (asked?.workspace_id ?? "");
				Object.assign(this.waiting.get(id)!, { offered: false, workspace: where, project, target, wakeKey: ref?.key, local: ref?.local });
				// On an attended device the wake comes first: the boss hears of the message only when it did not work.
				const wake = this.wakeOf(this.waiting.get(id)!);
				if (wake && this.wakeHides(wake, this.now())) continue;
				const why = wake?.state === "none" ? "; no workspace is open for it on this computer (open the project's workspace and it goes through)" : wake?.state === "off" ? "; tower runs are switched off on this computer, so nothing can wake it (switch them on and it goes through)" : wake?.state === "failed" ? `; waking its tower did not work (${WAKE_WHY[wake.reason ?? "other"]}); it is tried again later` : "";
				// Messages for names that are no workspace here make one notice, not one each.
				this.tellOnce(ghost ? `inbox/${item.team}/ghost` : `inbox/${id}`, `Straw Link: a message from ${item.fromLabel} is not delivered yet; it waits for the tower of ${where ? `workspace ${where}` : `project ${project}`}${why}`, "info");
				continue;
			}
			if (SERVED_TOWER.test(first.session.id) || (towerRunsEnabled(this.o.stateDir ?? "") && SERVED_RUN.test(first.session.name ?? ""))) {
				// A wait the router did not take with a tower the server runs (one stopping): it waits for the router's next pass, never for an ally run.
				if (item.wait && this.o.waits) continue;
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
		await this.tellStuck();
	}

	/**
	 * C4 (b), (c) (docs/specs/2026-11-21-box-mac-waits.md §4; boss decision D6): an unattended box tells the asker of a message that carries an ask and has waited 10 minutes with no run started, or whose tower would not open, why, in a
	 * `notice` whose `ref` names the ask (a build that takes no ref gets the notice without it). Once per message and reason; it does not close the ask.
	 */
	private async tellStuck(refused?: string): Promise<void> {
		if (this.o.attended?.() ?? true) return;
		for (const key of [...this.stuckTold]) if (!this.waiting.has(key.split("\n")[0]!)) this.stuckTold.delete(key);
		for (const id of [...this.deliveredIds]) if (!this.waiting.has(id)) this.deliveredIds.delete(id);
		for (const [id, w] of this.waiting) {
			if (this.deliveredIds.has(id) || (!refused && this.now() - w.since < STUCK_MS) || (refused && w.project !== basename(refused))) continue;
			const item = this.o.store.readInbox(id);
			if (!item?.awaitsReply || item.reply || item.wait) continue;
			const reason = refused ? "a tower could not be opened for it here" : w.served ? "it waits for an ally run of the tower here, whose runs are busy, held, or at their limit" : w.offered ? "the tower here was offered it and has not taken it yet" : w.local === "off" ? "tower runs are switched off here" : `no tower here takes messages for project ${w.project ?? "?"} yet`;
			if (this.stuckTold.has(`${id}\n${reason}`)) continue;
			this.stuckTold.add(`${id}\n${reason}`);
			const minutes = Math.max(1, Math.round((this.now() - w.since) / 60_000));
			await this.sendDialog(item.team, item.from, "notice", { kind: refused ? "inbox-refused" : "inbox-stuck", unit: w.workspace ?? w.project ?? "", text: `Your message has waited ${minutes} min here and no run took it yet: ${reason}.`, ref: item.awaitsReply })
				.then(() => this.o.store.log({ event: "stuck-notice", id, to: item.from }), (error: Error) => this.o.store.log({ event: "stuck-notice-failed", id, error: error.message }));
		}
	}

	/** What a message that found no tower may do: an attended device wakes (a teammate at `reply` or higher, every member the roster holds), an unattended one opens (a `dispatch` sender); with no seam, nothing. */
	private towerMode(level: string): "wake" | "open" | undefined {
		if (!this.o.openTower) return undefined;
		return (this.o.attended?.() ?? true) ? (LEVELS.includes(level as Level) ? "wake" : undefined) : level === "dispatch" ? "open" : undefined;
	}

	/**
	 * A message found no tower. On an unattended device a controller at `dispatch` gets one opened for the project (docs/specs/2026-10-26-sb-backend.md, Unattended devices): a workspace of the project, or a new one. One at a time per
	 * project, and not again for 60 s after one ended; the drain runs again when it is done, and the message then finds the tower the server runs.
	 */
	private openFor(project: string, from: string, toWorkspace: string | undefined): void {
		const { openTower, store } = this.o;
		if (!openTower || this.opening.has(project)) return;
		const ended = this.openEnded.get(project);
		if (ended !== undefined && this.now() - ended < OPEN_BACKOFF_MS) return;
		store.log({ event: "tower-open", project, from });
		const attempt = (async () => {
			try {
				await openTower(project, toWorkspace, from, "open");
				store.log({ event: "tower-opened", project });
			} catch (error) {
				store.log({ event: "tower-open-failed", project, error: (error as Error).message });
				await this.tellStuck(project).catch(() => undefined);
			}
		})().finally(() => {
			this.openEnded.set(project, this.now());
			this.opening.delete(project);
			if (this.running) void this.drain();
		});
		this.opening.set(project, attempt);
	}

	/** How long after it ended a wake is not tried again. */
	private wakeBackoff(w: WakeState): number {
		const cap = w.state === "none" || w.state === "woke" || w.state === "failed" ? WAKE_CAP_MS[w.state] : 0;
		return Math.min(cap, WAKE_BACKOFF_MS * 2 ** Math.min(w.streak, 16));
	}

	/** Whether the notice waits for this wake: it is queued or in flight, or it worked less than two minutes ago (counted from the first of the wakes that worked in a row); a tower that has not taken the message by then is the boss's to hear of. */
	private wakeHides(w: WakeState, now: number): boolean {
		return w.state === "queued" || w.state === "waking" || (w.state === "woke" && now - w.first < WAKE_GRACE_MS);
	}

	/** How the wake a message waits on stands: kept under its key, or (for a name that is no workspace here, and for tower runs switched off) read afresh at each drain, as no wake is made. */
	private wakeOf(w: { wakeKey?: string; local?: "none" | "off" }): WakeState | undefined {
		return w.local !== undefined ? { at: 0, first: 0, state: w.local, streak: 0 } : w.wakeKey === undefined ? undefined : this.wakes.get(w.wakeKey);
	}

	/**
	 * A message found no tower on an attended device. The tower of a workspace this device already has is woken, and nothing else is made: no workspace and no base, only (by `ensure-tower`) the tower's tab in that existing workspace, with no
	 * focus and nothing typed into another pane (the boss's rulings of 2026-11-07, No tower service for the team's project). A name that is no workspace here, and tower runs switched off, are answered without a call. One wake at a time per
	 * project and workspace asked for (by id, so no name a sender makes up makes another), at most `WAKES_PER_SENDER` in flight for one sender, and again only after a back-off by outcome (`wakeBackoff`; a `none` also when the workspaces of
	 * the project changed). Returns the key the wake is kept under for the notice, or the answer that needed none; `undefined` when nothing is woken.
	 */
	private wakeFor(project: string, from: string, asked: string | undefined, ghost: boolean, runsOn: boolean, net: NetView): { key?: string; local?: "none" | "off" } {
		if (!runsOn) return { local: "off" };
		if (ghost) return { local: "none" };
		const { openTower, store } = this.o, key = `${project}\n${asked ?? ""}`, now = this.now(), before = this.wakes.get(key), prior = before?.state === "queued" ? undefined : before;
		if (this.opening.has(key)) return { key };
		// The workspaces of the project that could take a tower: when they change, a wake that found none has something new to look at.
		const sig = () => net.workspaces.filter((w) => !isSub(w) && !isHead(w) && (asked === undefined || w.workspace_id === asked) && net.panes.some((p) => p.workspace_id === w.workspace_id && p.cwd !== undefined && inside(p.cwd, project))).map((w) => w.workspace_id).sort().join(",");
		if (prior && now - prior.at < this.wakeBackoff(prior) && !(prior.state === "none" && prior.sig !== sig())) return { key };
		if ([...this.wakingFor.values()].filter((f) => f === from).length >= WAKES_PER_SENDER) {
			if (!before) this.wakes.set(key, { at: now, first: now, state: "queued", streak: 0 });
			return { key };
		}
		// A wake that failed stays on the notice while it is tried again, and one that worked stays as it was (its grace is not restarted); only a first wake shows as in flight. The log has a line when the state changes, not at each try.
		if (!prior) {
			store.log({ event: "tower-wake", project, from, ...(asked ? { workspace: asked } : {}) });
			this.wakes.set(key, { at: now, first: now, state: "waking", streak: 0 });
		}
		const settle = (state: "woke" | "failed" | "none", reason?: WakeReason, error?: string) => {
			const same = prior?.state === state && prior.reason === reason;
			this.wakes.set(key, { at: this.now(), first: state === "woke" && prior?.state === "woke" ? prior.first : this.now(), state, streak: same ? prior!.streak + 1 : 0, ...(reason ? { reason } : {}), ...(state === "none" ? { sig: sig() } : {}) });
			if (!same) store.log(state === "woke" ? { event: "tower-woke", project } : state === "none" ? { event: "tower-wake-none", project } : { event: "tower-wake-failed", project, error });
		};
		const attempt = (async () => {
			try {
				settle((await openTower!(project, asked, from, "wake")) === "no-workspace" ? "none" : "woke");
			} catch (error) {
				const code = (error as { code?: unknown }).code;
				settle("failed", code === "service" || code === "project" ? code : "other", restrictLabel((error as Error).message).slice(0, 200));
			}
		})().finally(() => {
			this.wakingFor.delete(key);
			this.opening.delete(key);
			if (this.running) void this.drain();
		});
		this.opening.set(key, attempt);
		this.wakingFor.set(key, from);
		return { key };
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

	/** The last text a tower of workspace id `workspace` sent to `device`, for the unit report an unattended device gives that controller. In memory only. */
	private lastSent = new Map<string, { text: string; at: number }>();
	lastSentTo(workspace: string, device: string): { text: string; at: number } | undefined {
		return this.lastSent.get(`${workspace}\n${device}`);
	}
	async send(req: SendRequest): Promise<SendResult> {
		const { store } = this.o;
		if (!this.running || !this.device) return { ok: false, error: "This computer's link holder is not running" };
		const bytes = Buffer.byteLength(req.text, "utf8");
		if (bytes > LIMITS.towerText) return { ok: false, error: `The message is ${bytes} bytes; a message over Straw Link may hold at most ${LIMITS.towerText}` };
		const net = await this.o.net();
		const at = towerAt(net, req.fromSession, req.served === true), cwd = at?.cwd, pane = at && { workspace_id: at.workspace };
		if (!cwd || !pane) return { ok: false, error: "Only the tower of a workspace bound to a team can send over Straw Link" };
		const config = this.o.config();
		const teams = nearestTeams(cwd, [...this.runs.values()].filter((run) => !run.dead && config.teams.has(run.team)).map((run) => ({ run, project: config.teams.get(run.team)!.project }))).map((x) => x.run);
		if (teams.length === 0) return { ok: false, error: `This tower's folder (${cwd}) is not inside the project of any team this device belongs to` };
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
		// A wait for the standing main (`kind`, D13) goes as one only to a build that routes it there; to any other it is the plain `tower` it was before 0.81.3, with no lead line.
		// An approval (D14) and its `escalated` go only to a build that lists `tower.approval`: there is no plain form of a card for another device's boss.
		const approval = req.wait?.kind === "approval" || req.wait?.state === "escalated";
		const withAsk = req.awaitsReply !== undefined && peer.includes("tower.awaitsReply"), withWait = req.wait !== undefined && peer.includes("tower.wait") && (req.wait.kind === undefined || peer.includes(approval ? "tower.approval" : "tower.standing")) && (!approval || peer.includes("tower.approval"));
		if (approval && !withWait) return { ok: false, error: "That device's build takes no approvals (tower.approval), so nothing was sent" };
		// A note's wait (`re`, 0.93.0) goes only to a build that lists tower.note; to any other the notice goes without it, to its standing main.
		const wire = req.wait?.re !== undefined && !peer.includes("tower.note") ? (({ re: _re, ...rest }) => rest)(req.wait) : req.wait;
		if (req.wait !== undefined && !withWait && req.wait.state !== "open") return { ok: false, error: "That device's build takes no link waits, so the state of one is not sent" };
		// An open wait to a build that takes none goes as text whose first line says so: its ally run is told to escalate such a message (docs/specs/2026-11-21-box-mac-waits.md §3).
		const text = req.wait !== undefined && !withWait && req.wait.kind === undefined ? `[waits on you: ${req.wait.what}]\n${req.text}` : req.text;
		let kind: "tower" | "tower-reply" = req.inReplyTo !== undefined && peer.includes("tower-reply") && this.now() >= run.replyOffUntil ? "tower-reply" : "tower";
		const submit = (as: "tower" | "tower-reply") => run.outbox.submit((seq) => {
			const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
			if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
			return buildEnvelope({
				team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq, ts: this.now(), kind: as, to: [target.id],
				plaintext: as === "tower-reply"
					? encodePlaintext("tower-reply", { inReplyTo: req.inReplyTo!, text: req.text })
					: encodePlaintext("tower", { fromWorkspace: allyLabel(workspace?.label), toWorkspace: req.workspace ?? "", replyExpected: req.reply, text, ...(withAsk ? { awaitsReply: req.awaitsReply! } : {}), ...(withWait ? { wait: wire! } : {}) }),
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
		this.lastSent.set(`${pane.workspace_id}\n${target.id}`, { text: req.text, at: this.now() });
		while (this.lastSent.size > 64) this.lastSent.delete(this.lastSent.keys().next().value!);
		store.log({ event: "send", team: run.team, to: target.id, id, outcome: outcome === undefined ? "queued" : outcome === "posted" ? "posted" : String(outcome) });
		const details = { team: run.team, device: target.id, id, seq: queued.seq, as: kind, ...(req.awaitsReply !== undefined ? { asked: withAsk } : {}), ...(req.wait !== undefined ? { waited: withWait } : {}) };
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

	/** `caps` goes to each team at a stream start, then once an hour and when they are due (a peer said `hello`, a peer came back after a gap, the operate listing changed), never twice within 15 s; a relay that refuses the kind is left alone for an hour, as the board is. */
	private async sendCaps(): Promise<void> {
		if (!this.running || !this.device) return;
		const now = this.now(), min = this.o.capsMinMs ?? CAPS_MIN_MS, every = this.o.capsMs ?? CAPS_REFRESH_MS, listed = this.operateListed();
		for (const run of [...this.runs.values()]) {
			const sent = run.capsSent;
			if (run.dead || now < sent.offUntil || (sent.at !== 0 && !sent.due && now - sent.at < every) || now - sent.at < min) continue;
			try {
				const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
				if (!key) continue;
				const ts = Math.max(now, sent.ts + 1);
				sent.at = now; // a failed post is tried again after the spacing (`due` is set again by the catch), not at every tick
				sent.due = false;
				const hello = sent.hello;
				const envelope = buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device.keys, seq: 0, ts, kind: "caps", to: [], plaintext: encodePlaintext("caps", { features: (CAPS_FEATURES as readonly string[]).filter((f) => (f !== "unit-stop" || this.o.unitStop) && (f !== "operate/1" || listed) && ((f !== "tower.wait" && f !== "tower.standing" && f !== "tower.approval" && f !== "tower.note") || this.o.waits) && (f !== "tower.worker" || (!!this.o.waits && this.o.workers?.() === true))).concat(hello ? [HELLO] : []) }) });
				await run.client.postEnvelope(run.teamId, envelope);
				sent.ts = ts;
				if (hello) sent.hello = false; // the word goes once: a post that failed carries it in the next
			} catch (error) {
				if (error instanceof RelayError && error.code === "unknown-kind") {
					sent.offUntil = now + CAPS_OFF_MS;
					this.o.store.log({ event: "caps-unsupported", team: run.team });
				} else (sent.due = true, this.o.store.log({ event: "caps-failed", team: run.team, error: String(error) }));
			}
		}
	}

	/** Messages that wait for the tower identity `identity` the sb server runs, oldest received first (an ally run takes them). */
	servedFor(identity: string): InboxItem[] {
		const items: InboxItem[] = [];
		for (const [id, w] of this.waiting) {
			if (!w.served || w.identity !== identity) continue;
			const item = this.o.store.readInbox(id);
			if (item && !item.reply && !item.wait) items.push(item);
		}
		return items.sort((a, b) => a.received - b.received || (a.id < b.id ? -1 : 1));
	}
	/** Whether this holder can tell who is in `team` right now: it runs, the team runs and has not died, and its roster reads. A device is taken as gone only while this is true (the revocation of a controller's mains). */
	rosterKnown(team: string): boolean {
		const run = this.runs.get(team);
		if (!this.running || !run || run.dead) return false;
		try {
			this.loadTeam(team);
			return true;
		} catch {
			return false;
		}
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
		const cwd = towerAt(net, req.fromSession, req.served === true)?.cwd;
		if (!policy || !cwd || !inside(cwd, policy.project)) return { ok: false, error: "Only the tower of a workspace bound to the team can ask a device to confirm" };
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
					plaintext: encodePlaintext("confirm-request", { dialogId: req.dialogId, digest: req.digest, tool: req.tool, args: req.args, tower: allyLabel(req.tower) }),
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
	async answerConfirm(dialogId: string, allow: boolean, digest?: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const c = this.confirms.get(dialogId);
		if (!c || this.now() - c.at > CONFIRM_MAX_MS) return { ok: false, error: "That request is gone or has timed out" };
		// A page that names the digest of the request it showed is refused when the held request carries another digest (a request replaced under the same id since stays open and is shown again). The digest is the one the sender sent, so this catches a changed digest, not changed arguments under the same one.
		if (digest !== undefined && digest !== c.digest) return { ok: false, error: "That request changed; look at it again" };
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

	// ---- Dialogs across devices (Unattended devices, Asking back) ------------------------------------------------------------------------

	/** The project and share of a team in the policy now, or nothing for a team the policy does not name (what the unit status of the sb server is scoped by). */
	policyOf(team: string): { project: string; share: Share } | undefined {
		const policy = this.o.config().teams.get(team);
		return policy && { project: policy.project, share: policy.share };
	}
	/** The attended members of a running team that this unattended device trusts at `dispatch` now: where its dialogs go. Nothing on an attended device. */
	dialogControllers(): { team: string; device: string }[] {
		return this.controllerRead().list;
	}
	/** Whether `device` is an admin of `team`'s roster now (an admin is told every question and notice of the box). False for a team that is not running or a roster that cannot be read. */
	isAdmin(team: string, device: string): boolean {
		try {
			return this.loadTeam(team).state.members.get(device)?.role === "admin";
		} catch {
			return false;
		}
	}
	/**
	 * `device`'s place on `team`'s roster now: its role and whether it is attended; nothing for a device that is not a member, for a team this holder does not run (or has stopped: its roster is no longer trusted), and for a roster
	 * that cannot be read. The operate check asks this on every request (docs/specs/2026-11-07-link-operate.md §3.2).
	 */
	member(team: string, device: string): { role: Role; attended: boolean } | undefined {
		const run = this.runs.get(team);
		if (!run || run.dead) return undefined;
		try {
			const m = this.loadTeam(team).state.members.get(device);
			return m && { role: m.role, attended: m.attended };
		} catch {
			return undefined;
		}
	}
	/** False while the controller list cannot be trusted to be complete (the holder is not running, or a team's roster could not be read): a caller does not withdraw anything then. */
	controllersKnown(): boolean {
		return this.controllerRead().known;
	}
	/** Whether `device` of `team` has sent a presence recently (the same test the device list uses). */
	deviceOnline(team: string, device: string): boolean {
		const seen = this.runs.get(team)?.presences.get(device);
		return seen !== undefined && this.now() - seen.at <= PRESENCE_ONLINE_MS;
	}
	private controllerRead(): { list: { team: string; device: string }[]; known: boolean } {
		if (!this.running || !this.device) return { list: [], known: false };
		if (this.o.attended?.() ?? true) return { list: [], known: true };
		const trust = this.o.config().trust, list: { team: string; device: string }[] = [];
		let known = true;
		for (const run of this.runs.values()) {
			if (run.dead) continue;
			try {
				for (const [id, m] of this.loadTeam(run.team).state.members) if (id !== this.device.keys.id && m.attended && trust.get(id) === "dispatch") list.push({ team: run.team, device: id });
			} catch {
				known = false;
			}
		}
		return { list, known };
	}
	/** A `dialog-open`, `dialog-close`, or `notice` to one device of a team (the forwarder's and the unit reporter's way out). */
	async sendDialog(team: string, device: string, kind: "dialog-open" | "dialog-close" | "notice", payload: DialogOpen | DialogClose | Notice): Promise<void> {
		const run = this.runs.get(team);
		if (!run || run.dead || !this.running || !this.device) throw new Error("That team is not running on this device");
		if (!this.loadTeam(team).state.members.has(device)) throw new Error("That device is not in the team");
		await run.outbox.submit((seq) => {
			const { state } = this.loadTeam(team), key = state.keys.get(state.epoch);
			if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
			// A notice's ref goes only to a device whose caps list it (C4); an older build reads the three fields it knows.
			const body = kind === "notice" && (payload as Notice).ref !== undefined && !this.capsOf(run, device).includes("notice.ref") ? (({ ref: _ref, ...rest }) => rest)(payload as Notice) : payload;
			return buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq, ts: this.now(), kind, to: [device], plaintext: encodePlaintext(kind, body as never) });
		});
	}
	/** A `unit-status` to one device of a team (ephemeral: no queue, no acknowledgement; the receiver keeps the latest). A relay that does not know the kind refuses it, and the reporter's next pass tries again. */
	async sendUnitStatus(team: string, device: string, units: UnitStatus[], mains?: MainStatus[]): Promise<void> {
		const run = this.runs.get(team);
		if (!run || run.dead || !this.running || !this.device) throw new Error("That team is not running on this device");
		const { state } = this.loadTeam(team), key = state.keys.get(state.epoch);
		if (!state.members.has(device)) throw new Error("That device is not in the team");
		if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
		// `ts` rises by at least 1 per status, so a receiver's per-sender guard never drops one for an equal clock reading.
		const ts = (run.unitTs = Math.max(this.now(), run.unitTs + 1));
		await run.client.postEnvelope(run.teamId, buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device.keys, seq: 0, ts, kind: "unit-status", to: [device], plaintext: encodePlaintext("unit-status", { units, ...(mains !== undefined && this.capsOf(run, device).includes("unit-status.mains") ? { mains: this.capsOf(run, device).includes("unit-status.kind") ? mains : mains.map(({ kind: _kind, ...rest }) => rest) } : {}) }) }));
	}
	/**
	 * An `operate` message to one device of a team, as a live envelope (spec §5.1): not queued, not stored, answered with how many streams took it. Sends are serial per team and `ts` rises by
	 * at least 1 ms. Refused up front when this end may not send that type, when the peer's fresh `caps` lack `operate/1`, or while a relay that did not know the kind is left alone.
	 */
	sendLive(team: string, device: string, message: OperateMessage): Promise<{ delivered: number }> {
		const run = this.runs.get(team);
		if (!run || run.dead || !this.running || !this.device) return Promise.reject(new Error("That team is not running on this device"));
		const task = async (): Promise<{ delivered: number }> => {
			if (run.dead || !this.device) throw new Error("That team is not running on this device");
			if (!operateDirectionOk(message.type, this.o.attended?.() ?? true)) throw new OperateSendError("direction", `This device does not send an operate ${message.type} (wrong direction)`);
			const { state } = this.loadTeam(team), key = state.keys.get(state.epoch);
			if (!state.members.has(device)) throw new Error("That device is not in the team");
			if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
			if (!this.capsOf(run, device).includes("operate/1")) throw new OperateSendError("peer", "That device does not take operate yet: it needs a pi-straw-boss that lists operate/1 in its caps");
			const now = this.now();
			if (now < run.liveOffUntil) throw new OperateSendError("relay", "The relay does not take operate yet");
			const ts = (run.liveTs = Math.max(now, run.liveTs + 1));
			const envelope = buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device.keys, seq: 0, ts, kind: "operate", to: [device], plaintext: encodePlaintext("operate", message) });
			try {
				return { delivered: (await run.client.postLive(run.teamId, envelope, AbortSignal.timeout(LIVE_POST_MS))).delivered };
			} catch (error) {
				// A relay that answers without `delivered` stored the envelope as a plain ephemeral kind: fail closed on the first answer, and say so once.
				if (error instanceof ProtocolError) {
					run.liveOffUntil = now + CAPS_OFF_MS;
					this.o.store.log({ event: "operate-relay-not-live", team });
					throw new OperateSendError("relay", "The relay does not take operate as a live kind yet");
				}
				if (error instanceof RelayError && error.code === "unknown-kind") {
					run.liveOffUntil = now + CAPS_OFF_MS;
					this.o.store.log({ event: "operate-unsupported", team });
					throw new OperateSendError("relay", "The relay does not take operate yet");
				}
				throw error;
			}
		};
		const next = run.liveChain.then(task, task);
		run.liveChain = next.catch(() => undefined);
		return next;
	}
	private takeUnitStatus(run: TeamRun, roster: RosterState, header: Header, p: { units: UnitStatus[]; mains?: MainStatus[] }): void {
		const sender = roster.members.get(header.from);
		// Only an attended device shows an unattended one's units; the envelope check enforces the kind's sender rule, this keeps the receiver honest on its own.
		if (!(this.o.attended?.() ?? true) || !sender || sender.attended) return void this.o.store.log({ event: "drop", team: run.team, reason: "unit-status-unexpected", from: header.from, kind: "unit-status" });
		run.units.set(header.from, { at: this.now(), units: p.units.slice(0, UNITS_MAX), ...(p.mains ? { mains: p.mains } : {}) });
	}
	/** A notice from an unattended device, kept in memory (the last `NOTICES_KEPT`, a day each) until the boss clears it on this page; clearing is local. */
	private notices: { id: string; team: string; device: string; at: number; kind: string; unit: string; text: string }[] = [];
	private takeNotice(run: TeamRun, roster: RosterState, header: Header, p: Notice): void {
		const sender = roster.members.get(header.from);
		if (!(this.o.attended?.() ?? true) || !sender || sender.attended) return void this.o.store.log({ event: "drop", team: run.team, reason: "notice-unexpected", from: header.from, kind: "notice" });
		const id = createHash("sha256").update(`${header.from}\n${Buffer.from(header.id).toString("hex")}`).digest("hex").slice(0, 16);
		if (this.notices.some((n) => n.id === id)) return;
		this.notices.push({ id, team: run.team, device: header.from, at: this.now(), kind: p.kind, unit: p.unit, text: p.text });
		// The box's boss ended a hold of this device's there (holdops.ts `endHeld`): it ends here too, and the capacity watch tells its main.
		if (p.kind === "hold-ended") try { endHolds(this.o.store.dir, this.now(), (h) => h.team === run.team && h.device === header.from, "ended-there"); } catch (error) { this.o.store.log({ event: "hold-end-failed", error: (error as Error)?.name ?? "Error" }); }
		while (this.notices.length > NOTICES_KEPT) this.notices.shift();
		// A notice about an ask this computer made goes to the main that asked too (C4), in a line the server writes.
		if (p.ref) try { this.o.waits?.notice?.({ team: run.team, device: header.from, label: sender.label ?? shortId(header.from), kind: p.kind, text: p.text, ref: p.ref }); } catch (error) { this.o.store.log({ event: "notice-ref-failed", error: (error as Error)?.name ?? "Error" }); }
	}
	/** A roster member's label in `team`, or its short id when the roster cannot be read or names no such device. */
	memberLabel(team: string, device: string): string {
		try {
			return this.loadTeam(team).state.members.get(device)?.label ?? shortId(device);
		} catch {
			return shortId(device);
		}
	}
	private takeDialogOpen(run: TeamRun, roster: RosterState, header: Header, p: DialogOpen): void {
		const sender = roster.members.get(header.from);
		// Only an attended device shows a question; only an unattended member of the team asks one (the envelope check enforces the kind's sender rule, this keeps the receiver honest on its own).
		if (!(this.o.attended?.() ?? true) || !sender || sender.attended) return void this.o.store.log({ event: "drop", team: run.team, reason: "dialog-open-unexpected", from: header.from, kind: "dialog-open" });
		const fresh = this.dialogViews.put({ team: run.team, device: header.from, dialogId: p.dialogId, digest: p.digest, owner: p.owner, dialog: p.dialog, at: this.now() });
		this.o.store.log({ event: "dialog-in", team: run.team, from: header.from, dialog: p.dialogId, fresh });
		if (fresh) this.o.notify(`Straw Link: ${sender.label} asks a question (${restrictOwner(p.owner)})`, "warning");
	}
	private takeDialogClose(run: TeamRun, header: Header, p: DialogClose): void {
		// Only the team that holds the card may close it: a withdrawal sent on one team can arrive after the open on another.
		if (this.dialogViews.get(header.from, p.dialogId)?.team !== run.team) return;
		this.dialogViews.close(header.from, p.dialogId, p.by, this.now());
	}
	private takeDialogAnswer(run: TeamRun, roster: RosterState, header: Header, p: DialogAnswer): void {
		const drop = (reason: string) => this.o.store.log({ event: "drop", team: run.team, reason, from: header.from, kind: "dialog-answer", dialog: p.dialogId });
		const sender = roster.members.get(header.from), sink = this.o.dialogAnswer;
		if (this.o.attended?.() ?? true) return drop("dialog-answer-attended-device");
		if (!sender || !sender.attended) return drop("dialog-answer-sender");
		if (this.o.config().trust.get(header.from) !== "dispatch") return drop("dialog-answer-level");
		if (!sink) return drop("dialog-answer-unhandled");
		void Promise.resolve().then(() => sink({ team: run.team, from: header.from, dialogId: p.dialogId, digest: p.digest, answer: p.answer, answerId: p.answerId })).catch((error: Error) => this.o.store.log({ event: "dialog-answer-failed", error: error.message }));
	}
	/**
	 * A `unit-stop` (docs/specs/2026-11-07-link-remote-stop.md §4, the holder's part): this device is unattended, the sender an attended member at `dispatch` now, the request no older than 15 minutes at this device,
	 * and the mode one this build takes. A refusal logs `drop` with `unit-stop-*` and tells an attended sender `unit-stop-refused` with its reason word, never the reason text; an acceptance goes to `o.unitStop`,
	 * where the server decides which main and whose. Every request that gets past the envelope's checks logs `unit-stop-in` with its verdict, and never the reason text.
	 */
	private takeUnitStop(run: TeamRun, roster: RosterState, header: Header, p: UnitStop): void {
		const sender = roster.members.get(header.from), sink = this.o.unitStop, at = header.ts;
		const refuse = (verdict: string, tell?: string) => {
			this.o.store.log({ event: "drop", team: run.team, reason: `unit-stop-${verdict}`, from: header.from, kind: "unit-stop", stop: p.stopId });
			this.o.store.log({ event: "unit-stop-in", team: run.team, from: header.from, stopId: p.stopId, handle: p.handle, verdict });
			if (tell) void this.sendDialog(run.team, header.from, "notice", { kind: "unit-stop-refused", unit: "", text: `Stop ${p.stopId.slice(0, 6)} was refused: ${tell}.` }).catch((error: Error) => this.o.store.log({ event: "unit-stop-notice-failed", error: error.message }));
		};
		if (this.o.attended?.() ?? true) return refuse("attended-device");
		if (!sender || !sender.attended) return refuse("sender");
		if (this.o.config().trust.get(header.from) !== "dispatch") return refuse("level", "level");
		if (this.now() - at > STOP_MAX_AGE_MS) return refuse("stale", "stale");
		if (!(STOP_MODES as readonly string[]).includes(p.mode)) return refuse("mode", "mode");
		if (!sink) return refuse("unhandled");
		this.o.store.log({ event: "unit-stop-in", team: run.team, from: header.from, stopId: p.stopId, handle: p.handle, verdict: "accepted" });
		void Promise.resolve().then(() => sink({ team: run.team, from: header.from, stopId: p.stopId, handle: p.handle, mode: p.mode, reason: p.reason, at })).catch((error: Error) => this.o.store.log({ event: "unit-stop-failed", error: error.message }));
	}
	/**
	 * Asks an unattended box of a team to stop one main (the controller's side; the box decides). Only an attended device asks, only of an unattended member of the team whose fresh `caps` list `unit-stop` (an older
	 * build would drop the kind as unknown without telling anyone). Waits as `send` does for the relay's answer: `sent` once it holds the request, `queued` when it has not answered yet, and a refusal of the relay's as an error.
	 */
	async requestUnitStop(team: string, device: string, req: { handle: string; mode: string; reason?: string }): Promise<UnitStopResult> {
		const run = this.runs.get(team);
		if (!run || run.dead || !this.running || !this.device) return { ok: false, error: "That team is not running on this device" };
		if (!(this.o.attended?.() ?? true)) return { ok: false, error: "An unattended device does not ask another to stop a main" };
		if (!handleOk(req.handle)) return { ok: false, error: "A main's handle is 16 lowercase hex digits" };
		if (!(STOP_MODES as readonly string[]).includes(req.mode)) return { ok: false, error: `mode is ${STOP_MODES.join(" or ")}` };
		let target;
		try {
			target = this.loadTeam(team).state.members.get(device);
		} catch {
			return { ok: false, error: "That team's roster cannot be read" };
		}
		if (!target || device === this.device.keys.id) return { ok: false, error: "That device is not another member of the team" };
		if (target.attended) return { ok: false, error: "Only an unattended box takes a stop request" };
		if (!this.capsOf(run, device).includes("unit-stop")) return { ok: false, error: "That box's build does not take stop requests yet: it needs a pi-straw-boss that lists unit-stop in its caps" };
		if (run.outbox.haltedBy) return { ok: false, error: `The relay is refusing this device (${restrictLabel(run.outbox.haltedBy.code)}), so nothing is sent to team ${run.team.slice(0, 6)} right now` };
		const stopId = randomBytes(16).toString("hex"), reason = req.reason ?? "";
		const queued = await run.outbox.submit((seq) => {
			const { state } = this.loadTeam(team), key = state.keys.get(state.epoch);
			if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
			return buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq, ts: this.now(), kind: "unit-stop", to: [device], plaintext: encodePlaintext("unit-stop", { stopId, handle: req.handle, mode: req.mode, reason }) });
		}), id = queued.id.toString("hex");
		await new Promise<void>((resolve) => {
			if (run.settled.has(id)) return resolve();
			const timer = setTimeout(resolve, this.o.postWaitMs ?? POST_WAIT_MS);
			timer.unref();
			run.waiters.set(id, () => (clearTimeout(timer), resolve()));
		});
		run.waiters.delete(id);
		const outcome = run.settled.get(id);
		run.settled.delete(id);
		if (outcome === undefined || outcome === "halted") run.gone.set(id, `the stop request to ${this.memberLabel(team, device)}`);
		this.o.store.log({ event: "unit-stop-out", team, to: device, stopId, handle: req.handle, outcome: outcome === undefined ? "queued" : outcome === "posted" ? "posted" : String(outcome) });
		if (outcome instanceof Error) return { ok: false, error: outcome instanceof RelayError && outcome.code === "unknown-kind" ? "The relay does not take stop requests yet" : `The stop request was not sent: ${refusal(outcome)}` };
		return { ok: true, status: outcome === "posted" ? "sent" : "queued", stopId, id };
	}
	/** The forwarded dialogs of devices still in their team: those waiting for this device's boss, and with `ended` the ones that closed in the last two minutes (the card says how). */
	dialogRequests(ended = false) {
		const all = this.dialogViews.list((v) => {
			try {
				return this.loadTeam(v.team).state.members.has(v.device);
			} catch {
				return false;
			}
		}, this.now());
		return ended ? all : all.filter((v) => !v.closed);
	}
	/** This device's boss (or a paired phone, through the GUI) answers a forwarded dialog: the answer goes to the device that asked, once per dialog. `answer` is JSON (dialogs-out.ts `RemoteAnswer`). */
	async answerDialog(device: string, dialogId: string, digest: string, answer: string): Promise<{ ok: true } | { ok: false; error: string }> {
		const v = this.dialogViews.get(device, dialogId);
		if (!v || v.closed) return { ok: false, error: "That question is gone" };
		if (v.digest !== digest) return { ok: false, error: "The question changed; look at it again" };
		if (v.answered) return { ok: false, error: "This device already answered that question" };
		if (!(this.o.attended?.() ?? true)) return { ok: false, error: "An unattended device does not answer for others" };
		if (Buffer.byteLength(answer) > LIMITS.dialog) return { ok: false, error: "The answer is too long" };
		const run = this.runs.get(v.team);
		if (!run || run.dead || !this.running || !this.device) return { ok: false, error: "That team is not running on this device" };
		v.answered = true;
		try {
			await run.outbox.submit((seq) => {
				const { state } = this.loadTeam(run.team), key = state.keys.get(state.epoch);
				if (!key) throw new Error(`This device holds no key for epoch ${state.epoch}`);
				return buildEnvelope({
					team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq, ts: this.now(), kind: "dialog-answer", to: [device],
					plaintext: encodePlaintext("dialog-answer", { dialogId, digest, answer, answerId: newAnswerId() }),
				});
			});
		} catch (error) {
			v.answered = false;
			return { ok: false, error: (error as Error).message };
		}
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
			const tabs = net.tabs.filter((t) => t.workspace_id === workspace.workspace_id && t.tab_id !== tower.tab_id && net.panes.some((p) => p.tab_id === t.tab_id && p.cwd && inside(p.cwd, project))).map((t) => {
				const states = net.panes.filter((p) => p.tab_id === t.tab_id).map((p) => p.agent_status ?? "unknown");
				return { label: allyLabel(t.label ?? t.tab_id), state: states.includes("blocked") ? "blocked" : states.includes("working") ? "working" : (states[0] ?? "unknown") };
			});
			return [{ label: allyLabel(workspace.label), tower: tower.agent_status ?? "unknown", tabs }];
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
				return { id, short: shortId(id), label: m.label ?? shortId(id), online: age !== null && age <= PRESENCE_ONLINE_MS, ...(m.attended ? {} : { unattended: true as const }), ageMs: age, roster: seen?.presence.headSeq ?? null, workspaces: seen?.presence.workspaces ?? [] };
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
			const e = byId.get(x.id), shown = e && forAllies(e); // an auto-filled entry leaves as the main's name and done count only (spec, Work board, Sharing)
			return [{ id: wireId(device, x.id), workspace: allyLabel(x.herdrLocation?.workspace?.label), tab: allyLabel(x.herdrLocation?.tab?.label), name: allyLabel(x.name), now: shown?.now ?? "", updated: e?.updated ?? 0, items: shown?.items ?? [] }];
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
		const capacity = policy.share === "status" ? this.capacityFor(run, state, new Set(wanted.map((e) => e.id)), net, device) : undefined;
		const held = policy.share === "status" ? this.holdsFor(run, state, net, device, now) : undefined;
		if (held === null) return; // the caps of a teammate are not back yet (holdsFor)
		const holds = held;
		// The hash leaves out the reading's time and the load, which move at every reading: a board goes when its entries, its counts, or its holds change, and every 10 minutes while it carries capacity or a hold.
		const hash = createHash("sha256").update(JSON.stringify([wanted, capacity && { ...capacity, at: 0, load1: 0 }, holds ?? null])).digest("hex");
		const changed = hash !== sent.hash || state.epoch !== sent.epoch;
		if (!(changed ? now - sent.at >= (this.o.boardMinMs ?? BOARD_MIN_MS) : now - sent.at >= (capacity || holds ? CAP_REFRESH_MS : BOARD_REFRESH_MS))) return;
		// `ts` rises by at least 1 per board, so a receiver's per-sender guard never drops a board for an equal clock reading.
		const ts = Math.max(now, sent.ts + 1);
		sent.at = now; // a failed post is tried again after the spacing, not on every tick
		const envelope = buildEnvelope({ team: run.teamId, epoch: state.epoch, teamKey: key, head: state.head, from: this.device!.keys, seq: 0, ts, kind: "board", to: [], plaintext: encodePlaintext("board", { entries: wanted, ...(capacity ? { capacity } : {}), ...(holds ? { holds } : {}) }) });
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

	/**
	 * This device's capacity row for a team (the sb server's `_device.json`, under 5 minutes old): numbers in hundredths, the paused mains named only by the ids of entries the team gets. None while a teammate on the roster has
	 * no fresh `caps` listing `board.capacity` (an older build refuses a board of two fields), or with no reading.
	 */
	private capacityFor(run: TeamRun, state: RosterState, ids: ReadonlySet<string>, net: NetView, device: string): WireCap | undefined {
		if (!this.o.boardDir || ![...state.members.keys()].every((id) => id === device || this.capsOf(run, id).includes("board.capacity"))) return undefined;
		const d = readDevice(capDir(this.o.boardDir), this.now());
		if (!d) return undefined;
		const live = new Set(net.sessions.map((x) => x.id)), h = (n: number) => Math.max(0, Math.round(n * 100));
		const paused = d.mains.filter((r) => r.paused && live.has(r.session) && ids.has(wireId(device, r.session))).map((r) => ({ id: wireId(device, r.session), ...(r.paused!.until !== undefined ? { until: Math.max(0, Math.round(r.paused!.until)) } : {}) }));
		return { at: Math.round(d.at), points: h(d.points), ...(d.budget !== undefined ? { budget: h(d.budget) } : {}), load1: h(d.load1), cores: Math.max(0, Math.round(d.cores)), ready: Math.max(0, Math.round(d.ready)), ...(d.minReady !== undefined ? { minReady: h(d.minReady) } : {}), open: Math.max(0, Math.round(d.open)), paused };
	}

	/**
	 * This device's holds for a team's board (docs/specs/2026-11-26-device-hold.md): an attended device's `holds` of the boxes its live mains hold (link/holds.json; a hold whose main is gone for 2 minutes or whose hours ran out
	 * ends here), an unattended box's `held` echo of the hold it honours (the capacity watch's `_hold.json`). None while a teammate on the roster has sent no `caps` listing `board.holds` (an older build refuses a board of three fields).
	 */
	private holdsFor(run: TeamRun, state: RosterState, net: NetView, device: string, now: number): WireHold[] | undefined | null {
		// The last caps each member sent, however old: a teammate offline for 2 hours whose build took holds still takes them, so its silence drops no hold (R-F002). A hold is set only against fresh caps (holdops.ts).
		const takes = (id: string) => id === device || (run.caps.get(id)?.features ?? []).includes("board.holds");
		if (![...state.members.keys()].every(takes)) {
			// Just after a start the members' caps are not back yet: a controller that holds a box of this team sends no board for 90 seconds rather than one without its hold, which the box would take as a release.
			const unheard = [...state.members.keys()].some((id) => id !== device && !run.caps.has(id));
			return unheard && this.now() - this.bornAt < HOLD_CAPS_WAIT_MS && (this.o.attended?.() ?? true) && readHolds(this.o.store.dir, now).holds.some((h) => h.team === run.team) ? null : undefined;
		}
		const out: WireHold[] = [];
		if (this.o.attended?.() ?? true) {
			const live = new Set(net.sessions.map((x) => x.id)), dir = this.o.store.dir;
			for (const h of readHolds(dir, now).holds) if (live.has(h.session)) this.holdMissing.delete(h.session); else this.holdMissing.set(h.session, this.holdMissing.get(h.session) ?? now);
			endHolds(dir, now, (h) => h.until !== undefined && h.until <= now, "lapsed");
			endHolds(dir, now, (h) => now - (this.holdMissing.get(h.session) ?? now) >= HOLD_GONE_MS, "gone");
			for (const h of readHolds(dir, now).holds) if (h.team === run.team && state.members.has(h.device)) out.push({ device: h.device, by: wireId(device, h.session), since: h.since, ...(h.until !== undefined ? { until: h.until } : {}), role: "holds" });
		} else if (this.o.boardDir) {
			const h = readHold(capDir(this.o.boardDir), now);
			if (h && h.team === run.team) out.push({ device: h.device, by: h.by, since: h.since, role: "held" });
		}
		return out.length ? out.slice(0, LIMITS.boardHolds) : undefined;
	}

	/**
	 * Every ally device whose board this holder holds, however old (up to 7 days), for the capacity watch's device-silent flag: its board's age, whether it is online, and whether that board had open work (its capacity
	 * row's points, ready or open todos, or a paused main; without one, an item not done or an auto line's count short of its total). Kept on the receiving side: the sender may be the one that went silent.
	 */
	allySeen(): AllySeen[] {
		const now = this.now(), self = this.device?.keys.id, out: AllySeen[] = [];
		for (const run of this.runs.values()) {
			if (run.dead) continue;
			let roster: RosterState;
			try { roster = this.loadTeam(run.team).state; } catch { continue; }
			for (const [id, seen] of run.boards) {
				if (id === self || !roster.members.has(id) || now - seen.ts > BOARD_MAX_AGE_MS) continue;
				const c = seen.board.capacity, presence = run.presences.get(id);
				const open = c ? c.points > 0 || c.ready > 0 || c.open > 0 || c.paused.length > 0 : seen.board.entries.some((e) => e.items.some((i) => !i.done) || ((m) => Boolean(m && Number(m[1]) < Number(m[2])))(/\((\d+)\/(\d+)\)$/.exec(e.now)));
				// A board without capacity comes once an hour unchanged, so its age says nothing under an hour: only going offline counts for it.
				const age = now - seen.at, online = presence !== undefined && now - presence.at <= PRESENCE_ONLINE_MS;
				const mains = seen.board.entries.map((e) => ({ id: clean(e.id, 16), name: restrictLabel(clean(e.name, BOARD.label)) })), paused = (c?.paused ?? []).map((p) => ({ id: clean(p.id, 16), ...(p.until !== undefined ? { until: Math.min(p.until, 8.64e15) } : {}) }));
				// Its holds (docs/specs/2026-11-26-device-hold.md): its claim on this device with what the box judges it by (the sender's roster flag and this device's trust of it, the board's own `ts`), its echo of a hold this device has, and its row's numbers.
				const mine = seen.board.holds?.find((h) => h.role === "holds" && h.device === self), echo = seen.board.holds?.find((h) => h.role === "held" && h.device === self), member = roster.members.get(id);
				const holds = { ...(mine ? { claim: { by: mine.by, since: mine.since, ...(mine.until !== undefined ? { until: mine.until } : {}), ts: seen.ts, attended: Boolean(member?.attended), level: this.o.config().trust.get(id) ?? "none" } } : {}), ...(echo ? { echo: { by: echo.by, since: echo.since } } : {}), ...(c ? { cap: { points: c.points / 100, ...(c.budget !== undefined ? { budget: c.budget / 100 } : {}), load1: c.load1 / 100, cores: c.cores } } : {}) };
				out.push({ key: `${run.team}:${id}`, label: restrictLabel(member?.label ?? shortId(id)), short: shortId(id), online, boardAgeMs: age, timed: c !== undefined, open, mains, ...(paused.length ? { paused } : {}), team: run.team, device: id, ...holds });
			}
		}
		return out;
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
					...((hs) => {
						const who = (d: string, since: number) => ({ device: d, short: shortId(d), label: restrictLabel(roster.members.get(d)?.label ?? shortId(d)), sinceSecondsAgo: Math.max(0, Math.round((now - since) / 1000)) }), echo = hs.find((x) => x.role === "held");
						return { ...(hs.some((x) => x.role === "holds") ? { holds: hs.filter((x) => x.role === "holds").map((x) => who(x.device, x.since)) } : {}), ...(echo ? { heldBy: who(echo.device, echo.since) } : {}) };
					})(seen.board.holds ?? []),
					...((c) => (c ? { capacity: { points: c.points / 100, ...(c.budget !== undefined ? { budget: c.budget / 100 } : {}), load1: c.load1 / 100, cores: c.cores, ready: c.ready, ...(c.minReady !== undefined ? { minReady: c.minReady / 100 } : {}), open: c.open, paused: c.paused.map((p) => ({ id: clean(p.id, 16), ...(p.until !== undefined ? { until: new Date(Math.min(p.until, 8.64e15)).toISOString() } : {}) })) } } : {}))(seen.board.capacity),
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
		for (const v of this.dialogRequests(true)) out.push({ id: `dialog/${v.device}/${v.dialogId}`, kind: "dialog", level: v.closed ? "info" : "warning", team: v.team, teamName: name(v.team), data: { device: v.device, dialogId: v.dialogId, digest: v.digest, owner: v.owner, dialog: v.dialog, label: this.memberLabel(v.team, v.device), short: shortId(v.device), answered: v.answered ? 1 : 0, ...(v.closed ? { closed: v.closed.by } : {}) } });
		this.notices = this.notices.filter((n) => now - n.at < NOTICE_KEEP_MS);
		for (const n of this.notices) out.push({ id: `notice/${n.id}`, kind: "notice", level: "warning", team: n.team, teamName: name(n.team), data: { device: n.device, label: this.memberLabel(n.team, n.device), short: shortId(n.device), what: n.kind, unit: n.unit, text: n.text, at: n.at } });
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
		const waits = new Map<string, { kind: "inbox" | "held" | "served"; team: string; items: Waiting[] }>();
		for (const w of this.waiting.values()) {
			// A message for a tower the server runs waits for an ally run slot: the boss hears of it after 10 minutes.
			const wake = this.wakeOf(w);
			// A wake of an attended device that is queued, in flight, or worked less than two minutes ago, is the answer: no notice until it did not work.
			const kind = w.served ? (now - w.since > HELD_MS ? "served" : undefined) : w.offered ? (now - w.since > HELD_MS ? "held" : undefined) : wake && this.wakeHides(wake, now) ? undefined : "inbox";
			if (!kind) continue;
			// Messages that wait for different towers, or say different things about it, are different notices: what the boss reads names one tower. The tower is the workspace's own id, never the name a sender wrote (a made-up name is no tower).
			const key = kind === "inbox" ? `inbox/${w.team}/${w.target ?? ""}/${wake?.state === "none" || wake?.state === "off" || wake?.state === "failed" ? wake.state : ""}` : `${kind}/${w.team}`, hit = waits.get(key);
			if (hit) hit.items.push(w);
			else waits.set(key, { kind, team: w.team, items: [w] });
		}
		for (const [key, w] of waits) out.push({ id: key, kind: w.kind, level: "info", team: w.team, teamName: name(w.team), data: w.kind === "inbox" ? this.inboxData(w.items, now) : { count: w.items.length } });
		return out;
	}

	/**
	 * What the notice for messages that wait for a tower says: the sender whose message came first (and how many other senders there are), how many messages, the oldest one's arrival,
	 * how long ago that was (whole minutes under an hour, whole hours under a day, else whole days, so the notice changes only when its words do), the tower asked for, and when the oldest goes.
	 */
	private inboxData(items: { from: string; fromId: string; since: number; workspace?: string; project?: string; wakeKey?: string; local?: "none" | "off" }[], now: number): Record<string, string | number> {
		const oldest = [...items].sort((x, y) => x.since - y.since), senders = new Map<string, string>(oldest.map((w) => [w.fromId, w.from]));
		const since = oldest[0]!.since, workspace = items.find((w) => w.workspace !== undefined)?.workspace;
		const minutes = Math.max(1, Math.floor((now - since) / 60_000)), ageMin = minutes < 60 ? minutes : minutes < 1440 ? Math.floor(minutes / 60) * 60 : Math.floor(minutes / 1440) * 1440;
		const wake = this.wakeOf(items[0]!);
		return { count: items.length, from: [...senders.values()][0]!, others: senders.size - 1, since, drop: since + INBOX_MAX_AGE_MS, ageMin, ...(workspace !== undefined ? { workspace } : {}), project: items.find((w) => w.project !== undefined)?.project ?? "", ...(wake?.state === "none" || wake?.state === "off" ? { wake: wake.state } : wake?.state === "failed" ? { wake: "failed", reason: wake.reason ?? "other" } : {}) };
	}

	/** The units unattended peers reported lately; a device that stopped reporting for `UNITS_FRESH_MS` shows its last ones marked stale, and none after `UNITS_GONE_MS`. */
	private deviceUnits(): DeviceUnits[] {
		const now = this.now(), out: DeviceUnits[] = [];
		for (const run of this.runs.values()) {
			if (run.dead) continue;
			for (const [device, seen] of run.units) {
				if (now - seen.at > UNITS_GONE_MS || !seen.units.length) continue;
				const mine = this.device?.keys.id, dispatchers: NonNullable<DeviceUnits["dispatchers"]> = {};
				for (const by of new Set(seen.mains?.map((x) => x.by))) dispatchers[by] = { label: this.memberLabel(run.team, by), ...(by === mine ? { self: true as const } : {}) };
				const waiting = seen.mains ? this.o.waits?.openOn?.(device) : undefined;
				out.push({ team: run.team, device, units: seen.units, ...(seen.mains ? { mains: seen.mains, dispatchers } : {}), ...(waiting && Object.keys(waiting).length ? { waiting } : {}), ...(this.capsOf(run, device).includes("unit-stop") ? { canStop: true as const } : {}), at: seen.at, ...(now - seen.at > UNITS_FRESH_MS ? { stale: true as const } : {}) });
			}
		}
		return out;
	}
	/** The latest `unit-status` of each teammate device with its roster label, for a watch on a `link:` key (src/server/linkwatch.ts); a device silent for 30 minutes is gone. */
	unitsSeen(): (DeviceUnits & { label: string })[] {
		return this.deviceUnits().map((u) => ({ ...u, label: this.memberLabel(u.team, u.device) }));
	}
	/** The compact reading for the net snapshot: ally bases from presence, the notices, and the confirms waiting. */
	summary(): LinkSummary {
		const allies = this.list().flatMap((t) => t.devices.flatMap((d): AllyBase[] => {
			const base = { team: t.team, teamName: t.name, device: d.id, short: d.short, label: d.label, online: d.online, ...(d.unattended ? { unattended: true as const } : {}) };
			if (d.workspaces.length === 0) return [{ ...base, id: `${t.team}/${d.id}`, workspace: null, tower: "unknown", tabs: [] }];
			return d.workspaces.map((w) => ({ ...base, id: `${t.team}/${d.id}/${w.label}`, workspace: w.label, tower: w.tower, tabs: w.tabs.map((x) => ({ label: x.label, state: x.state })) }));
		}));
		return { allies, alerts: this.alerts(), confirms: this.confirmRequests(), units: this.deviceUnits() };
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
		const del = config.delegate, mate = del && this.resolveTeammate(del.device);
		const delegate = del && { device: del.device, short: shortId(del.device), label: mate?.ok ? mate.label : shortId(del.device), ...(del.owner ? { owner: del.owner } : {}), level: config.trust.get(del.device) ?? "reply", approval: !!mate?.ok && this.capsFor(mate.team, del.device).includes("tower.approval") };
		return { ...this.summary(), deviceId: d.keys.id, short: d.keys.shortId, label: d.label, relay: config.relay, teams, invites: this.admin.invites(), joinRequests: this.admin.joinRequests(), join: this.admin.joinView(), prefill: this.admin.prefill && { ...this.admin.prefill }, ...(delegate ? { delegate } : {}) };
	}

	/** This device's id, once the holder runs. */
	get deviceId(): string | undefined {
		return this.device?.keys.id;
	}
	/** This device's own label. */
	get deviceLabel(): string | undefined {
		return this.device?.label;
	}
	/** A teammate device named by a label, a short id, or an id, among every team this holder runs (a main's `waitsOn`, docs/specs/2026-11-21-box-mac-waits.md §2.1): one that fits two, or this device, is refused with the candidates. */
	resolveTeammate(device: string): { ok: true; id: string; short: string; label: string; team: string } | { ok: false; error: string } {
		if (!this.running || !this.device) return { ok: false, error: "This computer's link holder is not running" };
		const members: MemberRef[] = oneTeamEach([...this.runs.values()].filter((run) => !run.dead).flatMap((run) => {
			try {
				return [...this.loadTeam(run.team).state.members].map(([id, m]) => ({ team: run.team, id, ...(m.label !== undefined ? { label: m.label } : {}) }));
			} catch {
				return [];
			}
		}));
		const target = resolveDevice(device, members, this.device.keys.id);
		if (!target.ok) return { ok: false, error: target.error };
		return { ok: true, id: target.id, short: shortId(target.id), label: members.find((m) => m.id === target.id)?.label ?? shortId(target.id), team: target.team };
	}
	/** The label, short id, and team name a header names the sender of an inbox item by. */
	senderOf(item: InboxItem): { label: string; short: string; team: string } {
		return { label: item.fromLabel, short: item.fromShort, team: this.o.config().teams.get(item.team)?.name ?? item.team.slice(0, 6) };
	}
}

/** The roster the relay showed, or the one in the team file, breaks the roster's rules or no longer has this device. */
class RosterFork extends Error {}
