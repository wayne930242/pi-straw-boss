import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { basename } from "node:path";
import { fieldsOf } from "../header.ts";
import { type HerdrRun, panes, report, result, type Sleep, startPi } from "../herdr.ts";
import { allyKids, clearOrder } from "../order.ts";
import { alive as pidAlive } from "../remote.ts";
import { rememberStart, startOf as processStartOf, startedLater as processStartedLater } from "../startof.ts";
import { assertSettingsSafe } from "../trust/settings.ts";
import { waitPastTrust } from "../trust/wait.ts";
import type { MemorySummary, TowerView } from "../net.ts";
import { type BossPointer, type ConversationInfo, readPointer, resumable, sessionsRoot, underRoot, writePointer } from "./bossconv.ts";
import { herdrCode } from "./herdrcode.ts";
import { chain, isWrapper, leafOf, type Proc, type Procs, readProcs } from "./lineage.ts";
import type { Log } from "./log.ts";
import type { Slot } from "./record.ts";
import { addNote, clearTimer, listRuns, pruneRuns, readNotes, readTimer, type Outcome, type RunRecord, writeRun, writeTimer } from "./towerrunstore.ts";
import { appendEvent, dropParked, parkEvent, type QueuedEvent, readQueue, removeEvent, type ServiceRecord, unparkEvent, updateEvent } from "./towerstore.ts";
import { RUN_CAP_MINUTES } from "./towerbrief.ts";
import type { RunWho } from "./rungate.ts";

// The runs of the tower service (docs/specs/2026-10-26-sb-backend.md, The wake protocol, Crash and timeout, Queueing and concurrency). An event wakes a run: a new pi started in the tower tab's standing pane
// with `--sb-run <run id>`. The run claims itself over the control socket (a run token, kept in memory only), gets the brief, takes its events one at a time when it is idle, and ends with `tower_done`
// and a handoff note. The server watches it: too long, idle without a note, crashed, or gone with a Herdr restart. One local run per workspace; at most `towerRuns.max` runs on the machine.
// This file holds no pi dependency: it runs in the server's bundle.

export interface Timers {
	/** Events are coalesced: a wake waits this long after the first. */
	wake: number;
	/** A milestone that expects no reply (`why=milestone`, `reply=none`) waits this long for others when no local run is live (D19); any other event ends the wait at `wake`. */
	hold: number;
	/** How long a started pi may take to claim (a trust question the boss answers is not counted). */
	claim: number;
	/** How often the server looks at its live runs. */
	watch: number;
	/** Idle without `tower_done`: a steer after this, the end after `idleEnd` more. */
	idleSteer: number;
	idleEnd: number;
	/** A steer to wrap up, and the end. */
	steerAt: number;
	quitAt: number;
	/** pi has not exited this long after `quit`: Escape and /quit through Herdr, then (after `signal`) SIGTERM. */
	quitGrace: number;
	signal: number;
	/** A run that has not polled for this long is lost: dead, or an orphan that gets quit. Also how long a run of a restarted server has to reconnect. */
	lost: number;
	/** After a refused settings check the next attempt comes no sooner than this. */
	refuse: number;
	/** Three crashed or timed-out runs in this window hold the service. */
	loop: number;
	/** A pi resumed in a pane that held a live run when Herdr went away is quit for this long after the restart. */
	restored: number;
	/** How long a stopping server waits for its runs to quit after telling them. */
	stopGrace: number;
	/** The boss's silence (no input in the run's session, no turn) after which a run they were in goes back to the normal wrap-up. */
	bossAway: number;
	/** The most a boss's time in one run holds off the run cap; then the cap applies again. */
	bossMax: number;
}
export const TIMERS: Timers = { wake: 1000, hold: 30_000, claim: 60_000, watch: 2000, idleSteer: 60_000, idleEnd: 300_000, steerAt: 18 * 60_000, quitAt: RUN_CAP_MINUTES * 60_000, quitGrace: 10_000, signal: 5000, lost: 30_000, refuse: 60_000, loop: 600_000, restored: 120_000, stopGrace: 1500, bossAway: 10 * 60_000, bossMax: 4 * 3_600_000 };
/**
 * Windows ends nothing by force if it can help it: a pi ended with TerminateProcess leaves its pane's console in a mode where the next `agent start` there types a mangled command and times out (VM pass B6,
 * x6a-x6i; 0 of 5 starts failed after a graceful /quit, 5 of 5 after a kill). So the quit command, and Escape and /quit after it, get a longer wait before any signal, and a stopping server waits longer for its runs.
 */
export const runTimersFor = (platform: NodeJS.Platform = process.platform): Timers => (platform === "win32" ? { ...TIMERS, quitGrace: 30_000, signal: 20_000, stopGrace: 8000 } : TIMERS);
/** The most a stopping server spends on its runs after the quit: the grace, and then a process table read and the signal (elsewhere than Windows; Windows signals nothing). The server's exit waits this long beyond its usual leave time. */
export const runsStopMs = (platform: NodeJS.Platform = process.platform) => runTimersFor(platform).stopGrace + (platform === "win32" ? 1000 : 6000);
const LOOP_MAX = 3;
/** A wrapper Herdr lists whose child is not in the process table yet is looked at again, this many times, this far apart. */
const WRAPPER_TRIES = 3, WRAPPER_WAIT_MS = 400;
/** How long a process table read for `pane-role` answers the requests that follow it. */
const ROLE_TABLE_MS = 500;
const LEVELS = ["reply", "forward", "dispatch"];
/** The lower of two trust levels (an unknown one counts as `reply`). */
const lower = (a: string, b: string) => LEVELS[Math.min(Math.max(LEVELS.indexOf(a), 0), Math.max(LEVELS.indexOf(b), 0))]!;
/** The most messages an ally run is given at its start; the rest wait for the next run. */
const ALLY_BATCH = 5;
/** How long after the boss wrote at the tower prompt the run it woke still counts as the one they are in (a run waits for a free slot, a settings check, and its claim). */
const PROMPT_WAKE_MS = 5 * 60_000;

/** A boss conversation as the GUI and `/boss tower status` say it. Times are epoch milliseconds. */
export interface ConversationStatus {
	since: string;
	resumed: boolean;
	/** Why a new session was started (a resumed one has none). */
	why?: string;
	turns: number;
	/** The run waits for the boss: its last poll was idle with nothing queued. */
	idle: boolean;
	/** The boss counts as gone at this time if they stay silent (only while the run is idle). */
	idleAt?: number;
	/** How long the boss may be silent, and when the hard cap ends the conversation. */
	idleMs: number;
	capAt: number;
	/** The boss left or the server is ending it: it is closing. */
	closing?: true;
}
/** One of the last local runs: `conversation` when a boss conversation, else an event run. */
export interface LocalRunRow { id: string; kind: "conversation" | "event"; resumed?: boolean; why?: string; startedAt: string; endedAt?: string; outcome?: Outcome; /** The first line of its handoff note. */ note?: string }
export const RUNS_SHOWN = 6;
export type ServiceState = "standing" | "waking" | "running" | "closing" | "held";
export interface Notice { id: string; level: "info" | "warning" | "error"; kind: "settings" | "loop" | "start" | "late"; text: string; at: number; detail?: string }
/** What the GUI and `status` show of a service's runs. */
export interface ServiceStatus {
	state: ServiceState;
	queued: number;
	run?: { id: string; kind: "local" | "ally"; startedAt: string };
	/** The live local run is a boss conversation (bossconv.ts): how it began, and when it ends if the boss goes quiet. */
	conversation?: ConversationStatus;
	/** The live local run is an event run the boss spoke into (`bossIn`, when): it answers them, in place of a conversation. */
	bossIn?: { id: string; since: string };
	/** The last local runs, oldest first (at most `RUNS_SHOWN`): the conversations and the event runs, with the handoff note each left. */
	localRuns?: LocalRunRow[];
	/** `id` and `label` name the run and its device for the GUI (the label is the roster's, cut to the label character set); `device` is the device id. */
	allyRuns: { id: string; device: string; label: string; startedAt: string }[];
	lastRun?: { endedAt: string; outcome: Outcome };
	/** Runs that crashed or timed out inside the loop window, while there are any (the service is held at three). */
	crashes?: number;
	notices: Notice[];
	parked: { id: string; kind: string; from?: string; first: string }[];
}

/** One message of a teammate's device waiting in the link inbox for a tower identity the server runs (src/link/holder.ts `servedFor`): an ally run takes it. */
export interface AllyItem { id: string; device: string; label: string; short: string; team: string; teamName: string; fromWorkspace: string; replyExpected: boolean; text: string; at: number; awaitsReply?: string; askedBy?: string; /** An answer a local session gave to what an ally run asked or opened (allyroute.ts), not a message from the device: the session that said it. */ local?: { id: string; name: string } }
/** What the hub needs of the link holder to run allies (towers.ts builds it from the link service; main.ts gives it). */
export interface AllyPort {
	/** The messages waiting for the tower identity, oldest first. */
	waiting(identity: string): AllyItem[];
	/** The message is in a run's session (or dropped): it leaves the inbox. */
	taken(id: string, identity: string): Promise<void>;
	/** The level this computer gives the device, or undefined when the device is no longer a member of the team (its messages are dropped). */
	standing(device: string, team: string): { level: string } | undefined;
	/** The project folder the device's team binds on this computer: the workspaces an ally run's sender may see lie inside it. */
	project(team: string): string | undefined;
	/** The last messages of the device's thread with this computer's towers (both directions, oldest first), for the brief. */
	thread(device: string): { dir: "in" | "out"; at: number; kind: string; text: string }[];
}

/** What the hub needs of a tower service (towers.ts implements it). */
export interface ServiceRef {
	workspace: string;
	record(): ServiceRecord;
	/** Whether the identity is registered with pi-intercom: runs reply under it. */
	live(): boolean;
	/** The folder the settings check looks at: the standing pane's, else the workspace's checkout path. */
	cwd(): Promise<string>;
	/** The tower's `sb_order` key, which the panes of its ally runs are keyed after; undefined when Herdr cannot place the tower. */
	towerKey(): Promise<string | undefined>;
	/** A local run is about to start pi in the standing pane: the stand-in goes and the tower prompt leaves (standing.ts); resolves once the pane is free. */
	yieldPane(): Promise<void>;
	/** A local run ended: the pane is free for the prompt again. */
	freed(): void;
	/** The brief for a run: the server builds it from the net, the opener's ledger, the digest, and the last note. `refresh`: a live run is given the newest, not a new one. */
	brief(input: { events: QueuedEvent[]; woken: number; run: RunRecord; refresh?: true }): Promise<{ text: string; digestKeys: string[]; expired?: string[] }>;
	/** What a refreshed brief would differ by, cheap to compute: a live run is given a new brief when it moves (the memory, a handoff note). */
	briefVersion?(): string;
	/** The session files the live panes report (Herdr's `agent_session`): the boss conversation does not resume one another pi has open. */
	liveSessions?(): Promise<string[]>;
	/** The expired waits a brief showed are shown now: the run took its first poll. */
	shown?(ids: string[]): void;
	/** Drops the digest lines a run's brief showed. */
	clearDigest(keys: string[]): Promise<void>;
	/** The brief for an ally run: the server builds it from the sender, what the sender may see, the device's last ally note, the run's asks, and the thread with the device. */
	allyBrief(input: { run: RunRecord; items: AllyItem[]; woken: number }): Promise<{ text: string }>;
	/** The message as an ally run reads it: the verified header the server writes, then the peer's text. */
	allyLine(item: AllyItem): string;
	/** A fresh standing pane for the service, the old one closed (Windows, after a pi in it was ended by force); the new pane's id, or undefined when it could not be made. */
	renewPane?(runId: string): Promise<string | undefined>;
	/** Whether the standing pane is being replaced: a pi that turns up in it meanwhile is not admitted. */
	renewing?(): boolean;
	/** The tower's memory in counts for the GUI's snapshot (towermemory.ts). */
	memory?(): MemorySummary;
}

/** Whether anything is at `file` yet (pi writes a new session's file at its first assistant message). */
const onDisk = (file: string) => {
	try {
		lstatSync(file);
		return true;
	} catch {
		return false;
	}
};
interface Active {
	rec: RunRecord;
	svc: Svc;
	token?: string;
	/** Commands for the run, handed out at its next poll. */
	commands: ({ type: "steer"; text: string } | { type: "quit" } | { type: "confirmed"; dialogId: string; allow: boolean })[];
	lastPoll: number;
	idleSince?: number;
	started: number;
	closing?: number;
	steeredLong?: boolean;
	steeredIdle?: boolean;
	/** The outcome the run gets when it is gone, if it is not `done`/`crashed` by its own course. */
	pending?: Outcome;
	terminating?: number;
	escalated?: number;
	signalled?: boolean;
	/** A signal was sent to the run's processes: on Windows its pane is not used again. */
	forced?: boolean;
	/** A Windows stop left this run's pi alone (it was told to quit and stayed): the next server records it `quit` when the pi is gone. */
	left?: boolean;
	/** A process table read for the run that is under way (recovery after a server restart). */
	resolving?: Promise<void>;
	/** When the process start time was last compared with the recorded one (a `ps` call on macOS and Linux): once at first, then every `lost`. */
	startChecked?: number;
	digestKeys: string[];
	/** The expired waits of memory its brief showed, marked shown at its first poll (towermemory.ts). */
	expired?: string[];
	/** Events handed to the run and not yet confirmed `taken`. */
	offered: Map<string, QueuedEvent>;
	/** A run found on disk after a server restart that has not reconnected yet. */
	recovering?: number;
	ended?: boolean;
	/** The boss is in this run: when they last showed it (they spoke in its session, or woke it from the tower prompt). Memory only: a server restart forgets it, and their next word tells it again. */
	boss?: number;
	/** When the boss first showed it, for `bossMax`: kept for the life of the run (their absences do not restart it). */
	bossSince?: number;
	/** After the boss's silence ended their time here, the run has the idle wrap-up window to itself: the cap does not cut it short until then. */
	graceUntil?: number;
	/** A boss conversation: the boss turns its session has had (the pointer's, and this run's). */
	turns?: number;
	/** A conversation's session file the run reported before pi wrote it (pi creates a new session's file at its first assistant message): kept as the boss session once it is on disk (`settlePointer`). */
	pendingFile?: string;
	/** A boss conversation ended at its hard cap (the wrap-up note says so). */
	capped?: boolean;
	/** The boss asked for a new session (`/new`) while this conversation had not reported its file yet: the pointer is marked when it does. */
	fresh?: boolean;
	/** The brief version the run has (`briefVersion`), and a refresh under way. */
	briefV?: string;
	refreshing?: boolean;
}
interface Svc {
	ref: ServiceRef;
	state: ServiceState;
	run?: Active;
	wake?: ReturnType<typeof setTimeout>;
	/** When `wake` fires. */
	wakeAt?: number;
	timer?: ReturnType<typeof setTimeout>;
	crashes: number[];
	notices: Notice[];
	lastRun?: { endedAt: string; outcome: Outcome };
	refusedAt?: number;
	/** Events a pending slot wait is for. */
	waiting?: boolean;
	/** The boss wrote at the tower prompt: the run these events wake is one they are in. */
	bossAt?: number;
	/** The ally runs of the service: one per device. */
	allies: Map<string, Active>;
	allyWake?: ReturnType<typeof setTimeout>;
	/** Crashes and timeouts of a device's ally runs inside the loop window: three hold that device. */
	allyCrashes: Map<string, number[]>;
}

export interface RunsOptions {
	slot: Slot;
	run: HerdrRun;
	sleep: Sleep;
	now: () => number;
	log: Log;
	enabled(): boolean;
	max(): number;
	/** `<state dir>/trust`, where a pi that waits on a trust question leaves its request. */
	trustDir?: string;
	model(): string | undefined;
	timers?: Partial<Timers>;
	// Seams for tests: starting pi, the settings check, process liveness, the start time of a process, signals, and run ids.
	startPi?: typeof startPi;
	settings?: (dirs: string[]) => Promise<void>;
	alive?: (pid: number) => boolean;
	startOf?: (pid: number) => string | undefined;
	/** The process table, to find the pi below a wrapper that Herdr lists instead of it (`cmd.exe /c pi.cmd`); defaults to CIM on Windows and `ps` elsewhere. */
	procs?: Procs;
	/** The platform the runs are ended for (tests set it): Windows is never signalled where it can be avoided, and a pane is not reused after a signal. */
	platform?: NodeJS.Platform;
	/** The start time of a process once it is known (Windows reads it in the background); defaults to `startOf` when a test supplies that. */
	startedLater?: (pid: number) => Promise<string | undefined>;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	newId?: () => string;
	/** Events are appended with this, so a test can watch the store. */
	append?: typeof appendEvent;
	/** The link holder's messages for tower identities (B6): without it a service runs local runs only. */
	ally?: AllyPort;
	/** Where pi keeps its session files, for the boss conversation's pointer (bossconv.ts); defaults to the agent folder's `sessions`. */
	sessions?: string;
}

const phrase = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const iso = (ms: number) => new Date(ms).toISOString();
const PRIORITY: Record<string, number> = { boss: 0, notice: 1, timer: 1, intercom: 1 };

export type ClaimRequest = Record<string, unknown>
/** The sender an ally run serves, as its claim names it: the run's remote-turn hooks pin the turn to it. */
export interface Peer { device: string; label: string; short: string; team: string; teamName: string }
export type ClaimReply = { ok: true; wait: true } | { ok: false; error: string } | { ok: true; token: string; kind: "local" | "ally"; level?: string; peer?: Peer; run: string; workspace: string; identity: string; label: string; brief: string; hand?: true };

export function createRuns(o: RunsOptions) {
	const platform = o.platform ?? process.platform, win = platform === "win32";
	const t: Timers = { ...runTimersFor(platform), ...o.timers };
	const { slot, log, now } = o;
	const alive = o.alive ?? pidAlive, startOf = o.startOf ?? processStartOf, kill = o.kill ?? ((pid, signal) => void process.kill(pid, signal));
	const start = o.startPi ?? startPi, settings = o.settings ?? ((dirs: string[]) => assertSettingsSafe(dirs)), append = o.append ?? appendEvent;
	const startedLater = o.startedLater ?? (o.startOf ? (pid: number) => Promise.resolve(startOf(pid)) : processStartedLater);
	const procs = o.procs ?? readProcs();
	const newId = o.newId ?? (() => randomBytes(8).toString("hex"));
	const services = new Map<string, Svc>(), byToken = new Map<string, Active>(), byRun = new Map<string, Active>(), blocked = new Set<Svc>();
	/** The `forward` confirms an ally run waits for: dialog id → run id. */
	const confirms = new Map<string, string>();
	let slots = 0, pendingTakeovers = 0, watcher: ReturnType<typeof setInterval> | undefined, stopped = false;
	/** Panes that held a live run when Herdr went away, with when a resumed pi there stops being the old run. */
	const restored = new Map<string, number>();
	const error = (code: string, text: string) => log.line("error", { code, text: phrase(text, 300) });

	// --- events -----------------------------------------------------------------------------------------------------------------------------------------------------

	/** Events waiting for a run: not taken, not offered, a timer only when due; the boss first, then in the order the server received them. */
	const waitingOf = (svc: Svc, offered: ReadonlySet<string> = new Set()): QueuedEvent[] =>
		readQueue(slot, svc.ref.workspace).filter((e) => !e.taken && !offered.has(e.id)).sort((a, b) => (PRIORITY[a.kind] ?? 1) - (PRIORITY[b.kind] ?? 1) || a.seq - b.seq);
	const noticeOf = (svc: Svc, n: Omit<Notice, "at">) => {
		svc.notices = [...svc.notices.filter((x) => x.id !== n.id), { ...n, at: now() }].slice(-10);
	};

	// --- wake -------------------------------------------------------------------------------------------------------------------------------------------------------

	/** A milestone that expects no reply: a main's notice that something landed, which can wait for others (D19). The header is the code's, read at the very start of the text only. */
	const holdable = (e: QueuedEvent) => {
		if (e.kind !== "intercom") return false;
		const fields = fieldsOf(e.text);
		return fields?.why === "milestone" && fields.reply === "none";
	};
	/**
	 * The wake comes `wake` after an event that cannot wait, and for events that can (`holdable`) `hold` after the first of them, so mains that finish together land in one run. A burst of milestones does not
	 * extend the hold, and an event that arrives during it ends it at `wake`: the run takes every event that waits.
	 */
	const poke = (svc: Svc) => {
		pokeAlly(svc);
		if (stopped || svc.run || svc.state === "held" || !o.enabled()) return;
		if (svc.refusedAt !== undefined && now() - svc.refusedAt < t.refuse) return;
		const waiting = waitingOf(svc);
		if (!waiting.length) return;
		const at = now(), first = Math.min(...waiting.filter(holdable).map((e) => Date.parse(e.at)).filter(Number.isFinite), at);
		const due = waiting.some((e) => !holdable(e)) ? at + t.wake : Math.max(at + t.wake, first + t.hold);
		if (svc.wake && svc.wakeAt! <= due) return;
		clearTimeout(svc.wake);
		svc.wakeAt = due;
		svc.wake = setTimeout(() => ((svc.wake = undefined), void begin(svc).catch((cause: Error) => (error("run-begin", cause.message), (svc.state = "standing")))), due - at);
		svc.wake.unref();
	};
	const release = () => {
		for (const svc of [...blocked]) (blocked.delete(svc), poke(svc));
	};
	const begin = async (svc: Svc) => {
		if (stopped || svc.run || svc.state !== "standing" || !o.enabled() || !waitingOf(svc).length) return;
		if (!svc.ref.live()) return; // the identity registers first: runs reply under it. The service pokes again when it is live.
		if (slots >= o.max()) return void blocked.add(svc);
		slots++;
		svc.state = "waking";
		const id = newId(), woken = now();
		const rec: RunRecord = { id, workspace: svc.ref.workspace, kind: "local", pane: svc.ref.record().pane, agent: agentName(slot, svc.ref.workspace, id), startedAt: iso(woken), events: [] };
		const active: Active = { rec, svc, commands: [], lastPoll: woken, started: woken, digestKeys: [], offered: new Map() };
		// The service holds the run before the settings check: a pi the boss starts by hand meanwhile asks `pane-role` and is turned away, not given a run this one overwrites (B5R-F007).
		svc.run = active;
		try {
			await settings([await svc.ref.cwd()]);
		} catch (cause) {
			if (active.ended) return;
			slots--;
			svc.run = undefined;
			svc.state = "standing";
			svc.refusedAt = now();
			noticeOf(svc, { id: "settings", level: "error", kind: "settings", text: `A run could not start: ${(cause as Error).message}` });
			log.line("run-refused", { workspace: svc.ref.workspace, why: "settings" });
			return;
		}
		if (active.ended) return; // the service was detached during the check
		svc.refusedAt = undefined;
		svc.notices = svc.notices.filter((n) => n.id !== "settings");
		// A boss event written at the tower prompt (or the GUI's composer) with no local run live starts the boss conversation: it resumes the boss session when bossconv.ts says it may, else begins a new one.
		const resume = bossWake(svc) ? await conversationOf(svc) : undefined;
		if (active.ended) return;
		if (resume) (rec.conversation = resume.info, active.turns = resume.info.turns);
		byRun.set(id, active);
		writeRun(slot, rec);
		log.line("run-start", { workspace: svc.ref.workspace, run: id, kind: "local", ...(resume ? { conversation: resume.file ? "resumed" : "new" } : {}) });
		ensureWatcher();
		await launch(active, resume ? `tower · boss · ${svc.ref.record().label}` : `tower run · ${svc.ref.record().label} · ${id.slice(0, 8)}`, resume?.file ? ["--session", resume.file] : []);
	};
	/** The boss wrote at the tower prompt (or the GUI) a short while ago and no run was live: the run these events wake is their conversation. */
	const bossWake = (svc: Svc) => svc.bossAt !== undefined && now() - svc.bossAt <= PROMPT_WAKE_MS;
	/** Whether the boss's last session may be resumed, and the record of how the conversation begins. */
	const conversationOf = async (svc: Svc): Promise<{ info: ConversationInfo; file?: string }> => {
		const ws = svc.ref.workspace, pointer = readPointer(slot, ws);
		const live = await svc.ref.liveSessions?.().catch(() => [] as string[]) ?? [];
		const got = resumable(pointer, { now: now(), root: o.sessions ?? sessionsRoot(), live, ...(win || process.getuid === undefined ? {} : { uid: process.getuid() }) });
		const base = pointer ? { from: pointer.startedAt, after: pointer.lastAt } : {};
		return got.ok ? { file: got.file, info: { resumed: true, ...base, turns: pointer!.turns } } : { info: { resumed: false, ...(pointer ? { after: pointer.lastAt } : {}), turns: 0, why: got.why } };
	};
	/** Starts pi in the run's pane, finds its process, and waits for its claim; a start that fails ends the run as crashed. */
	const launch = async (active: Active, name: string, extra: string[] = []) => {
		const { rec, svc } = active, id = rec.id;
		for (let attempt = 1; ; attempt++) {
			let started = false;
			try {
				// The standing pane shows the tower prompt between runs; Herdr starts an agent only in an available shell, so the prompt leaves first. An ally run has a pane of its own.
				if (rec.kind === "local") await svc.ref.yieldPane().catch((cause: Error) => error("run-yield", `${rec.id}: ${cause.message}`));
				await start(o.run, o.sleep, rec.agent, rec.pane, ["--name", name, "--sb-run", id, ...extra, ...(o.model() ? ["--model", o.model()!] : [])]);
				started = true;
				const found = await procOf(rec.pane, id);
				if (!found) throw new Error("pi's process was not found in the pane");
				// A claim is held until the record has pi's own PID: Herdr may list the wrapper that started it.
				Object.assign(rec, await resolve(found, id));
				writeRun(slot, rec);
				const claimed = await waitPastTrust(o.sleep, () => active.token || active.ended, t.claim, 200, o.trustDir ? { dir: o.trustDir, pane: rec.pane } : undefined);
				if (!claimed) throw new Error(`pi did not claim the run within ${t.claim / 1000} s`);
				return;
			} catch (cause) {
				if (active.ended) return;
				// Windows, the standing pane: a start that timed out is taken for the pane's doing (a console a killed pi left in a mode that mangles what Herdr types), so the run is tried once more in a fresh pane and the
				// first timeout is not counted. A second timeout is the run's own failure.
				if (attempt === 1 && win && rec.kind === "local" && !started && herdrCode(cause) === "timeout") {
					log.line("run-start-retry", { run: id, why: phrase((cause as Error).message, 120) });
					await reap(active).catch(() => {});
					const pane = await svc.ref.renewPane?.(id).catch(() => undefined);
					if (pane && !active.ended) {
						active.forced = false; // the pane it was signalled in is the one just replaced
						rec.pane = pane;
						writeRun(slot, rec);
						continue;
					}
				}
				error("run-start", `${rec.id}: ${(cause as Error).message}`);
				noticeOf(svc, { id: `start-${rec.id}`, level: "warning", kind: "start", text: `A run could not start: ${(cause as Error).message}` });
				terminate(active, "crashed");
				// The tick does not type /quit into a pane whose pi never claimed: what the pane holds of this run is ended below.
				active.escalated ??= now();
				active.signalled = true;
				// Herdr may have given up on a pi that is running: it is ended with its wrapper, or it stays in the pane for the next run to meet. What the pane held is logged, for the next start that times out.
				log.line("run-start-pane", { run: rec.id, foreground: ((await foreground(rec.pane)) ?? []).map((p) => `${p.name ?? p.argv0 ?? "?"} ${p.pid ?? "?"}`).join(", ") });
				await reap(active).catch(() => {});
				await finish(active, "crashed", (cause as Error).message);
				return;
			}
		}
	};

	// --- ally runs --------------------------------------------------------------------------------------------------------------------------------------------------

	/** A message a teammate's device sent waits for an ally run: one run per device, started in a pane split off the tower's tab, with the messages that wait when it starts (5 at most, oldest first). */
	const pokeAlly = (svc: Svc) => {
		if (stopped || svc.allyWake || !o.ally || !o.enabled() || !devicesWaiting(svc).length) return;
		svc.allyWake = setTimeout(() => ((svc.allyWake = undefined), void beginAllies(svc).catch((cause: Error) => error("ally-begin", cause.message))), t.wake);
		svc.allyWake.unref();
	};
	const heldDevice = (svc: Svc, device: string) => (svc.allyCrashes.get(device) ?? []).filter((x) => x > now() - t.loop).length >= LOOP_MAX;
	/** The devices with messages waiting that have no ally run and are not held by a crash loop, oldest message first. */
	const devicesWaiting = (svc: Svc): { device: string; items: AllyItem[] }[] => {
		const groups = new Map<string, AllyItem[]>();
		for (const item of o.ally?.waiting(svc.ref.record().id) ?? []) groups.set(item.device, [...(groups.get(item.device) ?? []), item]);
		return [...groups].filter(([device]) => !svc.allies.has(device) && !heldDevice(svc, device)).map(([device, items]) => ({ device, items }));
	};
	const beginAllies = async (svc: Svc) => {
		for (const { device, items } of devicesWaiting(svc)) {
			if (stopped || !o.enabled() || svc.refusedAt !== undefined && now() - svc.refusedAt < t.refuse) return;
			if (!svc.ref.live()) return; // the identity registers first; the service pokes again when it is live
			if (slots >= o.max()) return void blocked.add(svc);
			await beginAlly(svc, device, items).catch((cause: Error) => error("ally-begin", cause.message));
		}
	};
	const beginAlly = async (svc: Svc, device: string, waiting: AllyItem[]) => {
		const identity = svc.ref.record().id, first = waiting[0]!;
		const standing = o.ally!.standing(device, first.team);
		if (!standing) {
			// The sender left the roster (or the team): its messages are dropped, as a tower of the previous build drops them.
			for (const item of waiting) await o.ally!.taken(item.id, identity).catch(() => {});
			log.line("ally-dropped", { workspace: svc.ref.workspace, device, why: "not a member", n: waiting.length });
			return;
		}
		const items = waiting.slice(0, ALLY_BATCH), id = newId(), woken = now();
		slots++;
		const rec: RunRecord = { id, workspace: svc.ref.workspace, kind: "ally", device, deviceLabel: first.label, deviceShort: first.short, team: first.team, teamName: first.teamName, level: standing.level, pane: "", agent: agentName(slot, svc.ref.workspace, id, "ally"), startedAt: iso(woken), events: [], admitted: items.map((x) => x.id) };
		const active: Active = { rec, svc, commands: [], lastPoll: woken, started: woken, digestKeys: [], offered: new Map() };
		svc.allies.set(device, active);
		try {
			await settings([await svc.ref.cwd()]);
		} catch (cause) {
			if (active.ended) return;
			slots--;
			svc.allies.delete(device);
			svc.refusedAt = now();
			noticeOf(svc, { id: "settings", level: "error", kind: "settings", text: `A run could not start: ${(cause as Error).message}` });
			log.line("run-refused", { workspace: svc.ref.workspace, why: "settings", kind: "ally" });
			return;
		}
		if (active.ended) return;
		svc.refusedAt = undefined;
		svc.notices = svc.notices.filter((n) => n.id !== "settings");
		try {
			const lead = svc.ref.record().pane, dir = await svc.ref.cwd();
			const made = await result(o.run, ["pane", "split", lead, "--direction", "right", "--cwd", dir, "--no-focus"]);
			rec.pane = made.pane.pane_id as string;
			await markAllies(svc);
		} catch (cause) {
			if (active.ended) return;
			error("run-start", `${rec.id}: the pane could not be split: ${(cause as Error).message}`);
			noticeOf(svc, { id: `start-${rec.id}`, level: "warning", kind: "start", text: `An ally run could not start: ${(cause as Error).message}` });
			await finish(active, "crashed", (cause as Error).message);
			return;
		}
		byRun.set(id, active);
		writeRun(slot, rec);
		log.line("run-start", { workspace: svc.ref.workspace, run: id, kind: "ally", device });
		ensureWatcher();
		// The claim is waited for in the background: the next device's run starts meanwhile.
		void launch(active, `ally run · ${first.label} · ${id.slice(0, 8)}`).catch((cause: Error) => error("run-start", `${id}: ${cause.message}`));
	};
	/**
	 * Writes the tokens of the panes the service's ally runs live in (order.ts `allyKids`): `sb_role`, and the row's place, mark, branch and name in the net view. The tokens last 10 minutes and a run may last 20, so the
	 * tower's publish writes them again (`markAllies`); a pane that cannot be placed (Herdr does not know the tower) keeps its role alone. A failed write waits for the next one.
	 */
	const markAllies = async (svc: Svc, towerKey?: string | null) => {
		const live = [...svc.allies.values()].filter((a) => a.rec.pane && !a.ended);
		if (!live.length) return;
		const key = towerKey === undefined ? await svc.ref.towerKey().catch(() => undefined) : towerKey ?? undefined;
		const kids = key ? allyKids(key, live.map((a) => ({ pane: a.rec.pane, label: a.rec.deviceLabel ?? a.rec.device ?? "?" }))) : [];
		for (const a of live) {
			const kid = kids.find((k) => k.pane === a.rec.pane);
			await report(o.run, "pane", a.rec.pane, { sb_role: "ally", sb_order: kid?.order ?? null, sb_mark: kid?.mark ?? null, sb_indent: kid?.indent ?? null, sb_name: kid?.name ?? null }).catch(() => {});
		}
	};
	/** A Herdr agent name is lowercase, up to 32 characters, and unique per run. */
	const agentName = (s: Slot, workspace: string, id: string, prefix = "tower") => `${prefix}-${s.primary ? "" : `${s.slot8}-`}${workspace.toLowerCase().replace(/[^a-z0-9_-]/g, "")}-${id.slice(0, 8)}`.slice(0, 32).replace(/[-_]+$/, "");
	/** What Herdr lists in the pane's foreground. On Windows that is one process: the wrapper (`cmd.exe /c pi.cmd`) when pi was started through one. */
	const foreground = async (pane: string): Promise<{ pid?: number; argv0?: string; name?: string; cmdline?: string }[] | undefined> => {
		try {
			return JSON.parse(await o.run(["pane", "process-info", "--pane", pane])).result?.process_info?.foreground_processes;
		} catch {
			return undefined;
		}
	};
	const pidsOf = async (pane: string): Promise<number[] | undefined> => (await foreground(pane))?.flatMap((p) => (typeof p.pid === "number" ? [p.pid] : []));
	/** The process Herdr lists for the run: the one whose command line holds the run id, else the one named pi. It may be a wrapper that started pi (`resolve`). */
	const procOf = async (pane: string, runId?: string): Promise<number | undefined> => {
		const info = await foreground(pane);
		const pick = (info ?? []).find((p) => runId && p.cmdline?.includes(runId)) ?? (info ?? []).find((p) => p.argv0 === "pi") ?? (info ?? []).filter((p) => p.name === "node")[0];
		return typeof pick?.pid === "number" ? pick.pid : undefined;
	};
	/**
	 * pi's own process for the one Herdr lists. A claim carries pi's PID (a pi cannot be started with any other), and the wrapper (`cmd.exe /c pi.cmd`, a `sh -c` or Volta shim) is a different one, so the
	 * server reads the process table itself and takes the process below the listed one that carries the run id and started after it: the table answers, never a PID or parent that pi reports. A wrapper whose
	 * child is not there yet is asked again; a table that cannot be read leaves the listed process, as before.
	 */
	const resolve = async (listed: number, runId: string): Promise<{ pid: number; started: string | undefined; via?: number[] }> => {
		for (let attempt = 1; attempt <= WRAPPER_TRIES; attempt++) {
			const table = await procs(runId);
			const hit = table && leafOf(table, listed);
			if (!hit) break;
			const own = hit.pid === listed;
			if (own && attempt < WRAPPER_TRIES && isWrapper(table.find((p) => p.pid === listed)?.name ?? "")) {
				await o.sleep(WRAPPER_WAIT_MS);
				continue;
			}
			if (hit.started && !o.startOf) rememberStart(hit.pid, hit.started);
			return { pid: hit.pid, started: hit.started ?? (await startedLater(hit.pid)), ...(hit.via.length ? { via: hit.via } : {}) };
		}
		return { pid: listed, started: await startedLater(listed) };
	};
	/**
	 * The listed process that `pid` runs below (a wrapper pi was started through), if any, and the start time the table gives `pid`; "0" is no run id, so no process is taken for the run's. A request that finds the
	 * table read in flight shares it, and one that comes within `ROLE_TABLE_MS` of a read uses its answer, so a burst of unlisted pi processes costs one read, not one each.
	 */
	let roleRead: Promise<Proc[] | undefined> | undefined, roleTable: { at: number; table: Proc[] | undefined } | undefined;
	const roleProcs = (): Promise<Proc[] | undefined> => {
		if (roleTable && now() - roleTable.at < ROLE_TABLE_MS) return Promise.resolve(roleTable.table);
		roleRead ??= procs("0").catch(() => undefined).then((table) => ((roleTable = { at: now(), table }), table)).finally(() => { roleRead = undefined; });
		return roleRead;
	};
	const wrapperOf = async (listed: number[], pid: number): Promise<{ wrapper: number; started?: string } | undefined> => {
		if (!listed.length) return undefined;
		const table = await roleProcs();
		const wrapper = table && listed.find((l) => l !== pid && chain(table, pid, l));
		const started = table?.find((p) => p.pid === pid)?.started;
		return wrapper === undefined ? undefined : { wrapper, ...(started ? { started } : {}) };
	};
	/**
	 * Ends the processes of a run's pi: pi's own first, then the ones between it and the one Herdr lists (a wrapper does not take its child with it). Each PID is verified at this moment, from Herdr's list and a
	 * process table read now, and never taken from a record alone: the recorded pi is signalled only while it is in the table with the start time recorded and below the process Herdr lists (a reused PID shows
	 * by its start time, whatever `gone` last said). Without a recorded pi (the start failed, the record is stale), only a listed process whose command line carries `--sb-run <id>` is ended, with the
	 * wrappers down to the pi below it: whatever else the pane holds is not the run's. Returns the PIDs signalled.
	 */
	const reap = async (a: Active): Promise<number[]> => {
		const id = a.rec.id, known = a.rec.pid, info = (await foreground(a.rec.pane)) ?? [];
		const listed = info.flatMap((p) => (typeof p.pid === "number" ? [p.pid] : []));
		const carried = info.flatMap((p) => (typeof p.pid === "number" && p.cmdline?.includes(`--sb-run ${id}`) ? [p.pid] : []));
		if (!listed.length) return [];
		const table = await procs(id);
		const root = known === undefined ? undefined : listed.find((l) => l === known || (a.rec.via ?? []).includes(l));
		let pids: number[] = [];
		if (known !== undefined && root !== undefined) {
			if (table) {
				const row = table.find((p) => p.pid === known), up = chain(table, known, root);
				if (row && up && (a.rec.started === undefined || row.started === undefined || row.started === a.rec.started)) pids = up;
			} else if (root === known && alive(known) && (a.rec.started === undefined || startOf(known) === a.rec.started)) {
				// The table cannot be read: a pi Herdr lists itself is checked against its start time alone, one a wrapper started is not signalled.
				pids = [known];
			}
		}
		if (!pids.length) {
			for (const top of carried) {
				// A table that was read must still show the listed carrier as the run's (its PID may be another program's by now); only an unreadable table leaves it to Herdr's list.
				if (table && !table.find((p) => p.pid === top)?.carries) continue;
				const hit = table && leafOf(table, top);
				pids.push(...(hit ? [hit.pid, ...[...hit.via].reverse()] : [top]));
			}
		}
		pids = [...new Set(pids)];
		if (!pids.length) log.line("run-sigterm-none", { run: id, listed: listed.length, table: table ? "read" : "unreadable" });
		for (const pid of pids) {
			log.line("run-sigterm", { run: id, pid });
			a.forced = true;
			try { kill(pid, "SIGTERM"); } catch { /* gone */ }
		}
		return pids;
	};

	// --- the end of a run ---------------------------------------------------------------------------------------------------------------------------------------------

	/** Asks a run to leave (a command at its next poll), and falls back to Herdr's keys and then a signal if pi has not exited. */
	function terminate(a: Active, outcome?: Outcome) {
		if (a.ended) return;
		if (outcome && !a.pending) a.pending = outcome;
		a.terminating ??= now();
		if (!a.commands.some((c) => c.type === "quit")) a.commands.push({ type: "quit" });
	}
	const escalate = async (a: Active) => {
		const pane = a.rec.pane;
		if (a.escalated === undefined) {
			a.escalated = now();
			log.line("run-quit-keys", { run: a.rec.id });
			// pi has not exited: Escape and /quit through Herdr.
			for (const args of [["pane", "send-keys", pane, "esc"], ["pane", "send-text", pane, "/quit"], ["pane", "send-keys", pane, "enter"]]) await o.run(args).catch(() => {});
			return;
		}
		if (!a.signalled && now() - a.escalated >= t.signal) {
			a.signalled = true;
			// In the background: a process table read (a PowerShell on Windows) must not hold the watcher's tick, which every run's watch waits on.
			void reap(a).catch((cause: Error) => error("run-reap", `${a.rec.id}: ${cause.message}`));
		}
	};
	const gone = (a: Active) => {
		const pid = a.rec.pid;
		if (pid === undefined) return false;
		if (!alive(pid)) return true;
		// A PID taken by another process after pi died shows by its start time; asking costs a `ps` call, so it is asked once and then every `lost`, not at every tick (B5R-F006).
		if (a.rec.started === undefined || (a.startChecked !== undefined && now() - a.startChecked < t.lost)) return false;
		a.startChecked = now();
		const current = startOf(pid);
		return current !== undefined && current !== a.rec.started;
	};

	/** Ends a run in the records: its events, its note, the crash rules, and the service goes back to standing (the next wake comes 1 s later). */
	async function finish(a: Active, outcome: Outcome, detail?: string, keepTaken = false) {
		if (a.ended) return;
		settlePointer(a);
		a.ended = true;
		const svc = a.svc, ws = svc.ref.workspace;
		a.rec.outcome = outcome;
		a.rec.endedAt = iso(now());
		if (detail) a.rec.detail = phrase(detail, 200);
		try { writeRun(slot, a.rec); pruneRuns(slot, ws); } catch (cause) { error("run-record", (cause as Error).message); }
		if (a.token) byToken.delete(a.token);
		byRun.delete(a.rec.id);
		for (const [dialogId, run] of confirms) if (run === a.rec.id) confirms.delete(dialogId);
		slots = Math.max(0, slots - 1);
		if (svc.run === a) svc.run = undefined;
		const ally = a.rec.kind === "ally";
		if (ally && a.rec.device && svc.allies.get(a.rec.device) === a) svc.allies.delete(a.rec.device);
		const taken = ally ? [] : readQueue(slot, ws).filter((e) => e.taken?.run === a.rec.id);
		const failed = outcome === "crashed" || outcome === "timeout";
		if (ally) await finishAlly(a, outcome, failed, keepTaken);
		for (const e of taken) {
			try {
				if (!failed && outcome !== "herdr-restart" && !keepTaken) removeEvent(slot, ws, e);
				else if (outcome === "herdr-restart" || keepTaken) updateEvent(slot, ws, { ...withoutTaken(e), flag: "crash" });
				else if ((e.crashes ?? 0) + 1 >= 2) (parkEvent(slot, ws, { ...withoutTaken(e), crashes: (e.crashes ?? 0) + 1, flag: "crash" }), noticeOf(svc, { id: `parked-${e.id}`, level: "warning", kind: "late", text: `An event was parked after two runs crashed with it: ${e.kind} ${e.from?.name ?? e.from?.id ?? ""}`.trim() }));
				else updateEvent(slot, ws, { ...withoutTaken(e), crashes: (e.crashes ?? 0) + 1, flag: "crash" });
			} catch (cause) { error("run-events", (cause as Error).message); }
		}
		if (failed) {
			try { addNote(slot, ws, { kind: a.rec.kind, ...(a.rec.device ? { device: a.rec.device } : {}), run: a.rec.id, at: iso(now()), note: `(${outcome === "timeout" ? "timed out" : "crashed"}: ${detail ?? outcome})` }); } catch (cause) { error("run-note", (cause as Error).message); }
		}
		if (!ally) {
			svc.lastRun = { endedAt: a.rec.endedAt, outcome };
			svc.state = svc.state === "held" ? "held" : "standing";
			svc.ref.freed();
		}
		log.line("run-end", { workspace: ws, run: a.rec.id, kind: a.rec.kind, outcome, ...(detail ? { detail: phrase(detail, 120) } : {}) });
		if (failed && ally) {
			const device = a.rec.device ?? "?", cutoff = now() - t.loop, list = [...(svc.allyCrashes.get(device) ?? []).filter((x) => x > cutoff), now()];
			svc.allyCrashes.set(device, list);
			if (list.length >= LOOP_MAX) {
				noticeOf(svc, { id: `ally-loop-${device}`, level: "error", kind: "loop", text: `${LOOP_MAX} ally runs for one device crashed or timed out in ${Math.round(t.loop / 60_000)} minutes, so that device's messages wait. They wake again when the window has passed.` });
				log.line("run-loop", { workspace: ws, device, kind: "ally" });
			}
		} else if (failed) {
			const cutoff = now() - t.loop;
			svc.crashes = [...svc.crashes.filter((x) => x > cutoff), now()];
			if (svc.crashes.length >= LOOP_MAX) {
				svc.state = "held";
				const tail = await o.run(["pane", "read", a.rec.pane, "--lines", "20"]).then((x) => x.trim().split("\n").slice(-20).join("\n"), () => "");
				noticeOf(svc, { id: "loop", level: "error", kind: "loop", text: `${LOOP_MAX} runs crashed or timed out in ${Math.round(t.loop / 60_000)} minutes, so the tower stops waking. The queue is kept; Retry, or a message from the boss, wakes it again.`, ...(tail ? { detail: tail } : {}) });
				log.line("run-loop", { workspace: ws });
			}
		}
		// Windows: a pane whose pi was ended by force is not used again. The service is told before it can wake a run (the pane renews at once, and the wake finds the identity not live until the new pane has registered).
		if (a.forced && win && !ally) void svc.ref.renewPane?.(a.rec.id).catch((cause: Error) => error("run-renew", cause.message));
		release();
		poke(svc);
	}
	/** The end of an ally run: the messages it took leave the inbox when it ended well; after a crash they stay for the next run, and two crashes with one message drop it. */
	const poison = new Map<string, number>();
	async function finishAlly(a: Active, outcome: Outcome, failed: boolean, keepTaken: boolean) {
		const svc = a.svc, identity = svc.ref.record().id;
		// The pane is closed once pi has exited: a pane that pi leaves returns to its shell and would stay (a started pi that is still there goes with it).
		if (a.rec.pane) {
			await clearOrder(o.run, [a.rec.pane]);
			await o.run(["pane", "close", a.rec.pane]).catch(() => {});
			// The panes of the device's siblings move up in the order, and the branch of the last one is drawn.
			await markAllies(svc);
		}
		for (const id of a.rec.events) {
			try {
				if (!failed && outcome !== "herdr-restart" && !keepTaken) {
					await o.ally?.taken(id, identity);
					poison.delete(id);
				} else if (outcome === "herdr-restart" || keepTaken) continue;
				else {
					const n = (poison.get(id) ?? 0) + 1;
					poison.set(id, n);
					if (n >= 2) {
						await o.ally?.taken(id, identity);
						poison.delete(id);
						noticeOf(svc, { id: `parked-${id}`, level: "warning", kind: "late", text: `A message from ${a.rec.device ?? "a device"} was dropped after two ally runs crashed with it` });
					}
				}
			} catch (cause) { error("run-events", (cause as Error).message); }
		}
	}
	const withoutTaken = (e: QueuedEvent): QueuedEvent => {
		const { taken: _taken, ...rest } = e;
		return rest;
	};

	/** What this computer gives an ally run's sender now (undefined: the sender is no longer a member of the team). The server holds a run to the lower of this and the level it was claimed at. */
	const standingOf = (a: Active): { level: string } | undefined => {
		if (!o.ally || !a.rec.device || !a.rec.team) return undefined;
		const current = o.ally.standing(a.rec.device, a.rec.team);
		return current && { level: lower(a.rec.level ?? "reply", current.level) };
	};

	// --- watching ---------------------------------------------------------------------------------------------------------------------------------------------------

	const ensureWatcher = () => {
		if (watcher || stopped) return;
		watcher = setInterval(() => void tick().catch((cause: Error) => error("run-watch", cause.message)), t.watch);
		watcher.unref();
	};
	let ticking = false;
	const tick = async () => {
		if (ticking) return;
		ticking = true;
		try {
			for (const a of [...byRun.values()]) {
				if (a.ended) continue;
				const age = now() - a.started;
				const exited = gone(a) || (a.rec.pid === undefined && a.token !== undefined && (await panes(o.run, a.rec.workspace).catch(() => undefined))?.every((p) => p.pane_id !== a.rec.pane) === true);
				if (exited) {
					const outcome = a.pending ?? (a.closing !== undefined ? "done" : "crashed");
					await finish(a, outcome, outcome === "crashed" ? "pi exited without tower_done" : undefined, a.left === true);
					continue;
				}
				if (a.recovering !== undefined) {
					if (a.rec.pid === undefined) {
						// The server went away while pi was starting, before the record had its PID: the process is looked for by the run id, and a run that shows no process within `lost` is over (B5R-F003).
						const found = await procOf(a.rec.pane, a.rec.id);
						if (found !== undefined) {
							// The table reads (3 at most, a PowerShell each on Windows) run beside the tick, one at a time per run.
							a.resolving ??= resolve(found, a.rec.id).then((got) => { if (!a.ended) (Object.assign(a.rec, got), writeRun(slot, a.rec)); }).catch((cause: Error) => error("run-resolve", `${a.rec.id}: ${cause.message}`)).finally(() => { a.resolving = undefined; });
						} else if (now() - a.recovering > t.lost) await finish(a, "crashed", "pi was not running after the server restarted");
						continue;
					}
					if (now() - a.recovering > t.lost) (terminate(a, "crashed"), void escalate(a));
					continue;
				}
				if (a.terminating !== undefined) {
					if (now() - a.terminating >= t.quitGrace) await escalate(a);
					continue;
				}
				if (a.closing !== undefined) {
					if (now() - a.closing >= t.quitGrace) await escalate(a);
					continue;
				}
				if (!a.token) continue;
				if (a.rec.kind === "ally" && !standingOf(a)) {
					log.line("ally-ended", { workspace: a.rec.workspace, run: a.rec.id, why: "the sender left the roster" });
					terminate(a, "quit");
					continue;
				}
				if (now() - a.lastPoll > t.lost) {
					log.line("run-lost", { run: a.rec.id });
					terminate(a, "crashed");
					continue;
				}
				// The boss is in the run (docs/how-it-works.md, The boss in a run): the cap and the idle wrap-up wait for them. Their silence for `bossAway` while the run is idle, or `bossMax` in all, ends it.
				if (a.boss !== undefined && (now() - (a.bossSince ?? a.boss) >= t.bossMax || (a.idleSince !== undefined && now() - Math.max(a.boss, a.idleSince) >= t.bossAway))) {
					const away = now() - (a.bossSince ?? a.boss) < t.bossMax;
					a.boss = undefined;
					// A conversation that reaches its hard cap is wrapped up like one the boss left: a timeout would count against the loop rule, and the boss did nothing wrong.
					if (!away && a.rec.conversation) a.capped = true;
					if (away || a.rec.conversation) {
						// The boss left without quitting: the run gets the normal wrap-up (an idle steer, then the end with a note), and the cap does not cut it short meanwhile.
						a.idleSince = now();
						a.steeredIdle = false;
						a.graceUntil = now() + t.idleSteer + t.idleEnd + t.quitGrace;
						log.line(away ? "run-boss-away" : "run-boss-cap", { workspace: a.rec.workspace, run: a.rec.id });
					}
				}
				const bossHere = a.boss !== undefined, grace = a.graceUntil !== undefined && now() < a.graceUntil;
				if (age >= t.quitAt && !bossHere && !grace) {
					a.pending = "timeout";
					terminate(a, "timeout");
				} else if (age >= t.steerAt && !a.steeredLong && !bossHere && !grace) {
					a.steeredLong = true;
					a.commands.push({ type: "steer", text: `You have run for ${Math.round(age / 60_000)} minutes and the cap is ${RUN_CAP_MINUTES}. Wrap up now and call tower_done with your handoff note.` });
				}
				if (a.idleSince !== undefined && !bossHere) {
					const idle = now() - a.idleSince;
					if (idle >= t.idleSteer + t.idleEnd) {
						try { addNote(slot, a.rec.workspace, { kind: a.rec.kind, ...(a.rec.device ? { device: a.rec.device } : {}), run: a.rec.id, at: iso(now()), note: a.rec.conversation ? (a.capped ? "(ended at the 4 h cap)" : "(ended idle)") : "(ended without a note)" }); } catch (cause) { error("run-note", (cause as Error).message); }
						terminate(a, "quit");
					} else if (idle >= t.idleSteer && !a.steeredIdle) {
						a.steeredIdle = true;
						a.commands.push({ type: "steer", text: a.rec.conversation ? "The boss has left: call tower_done with your handoff note." : "You are idle with nothing pending. Call tower_done with your handoff note." });
					}
				}
			}
			if (!byRun.size) (clearInterval(watcher), (watcher = undefined));
		} finally {
			ticking = false;
		}
	};

	// --- claims -----------------------------------------------------------------------------------------------------------------------------------------------------

	const refuse = (error: string): ClaimReply => ({ ok: false, error });
	/** Issues the run's token and its brief. */
	const issue = async (a: Active, hand?: true): Promise<ClaimReply> => {
		const svc = a.svc, ally = a.rec.kind === "ally";
		const built = ally ? { ...(await svc.ref.allyBrief({ run: a.rec, items: itemsOf(a, true), woken: a.started })), digestKeys: [] as string[], expired: [] as string[] } : await svc.ref.brief({ events: waitingOf(svc), woken: a.started, run: a.rec });
		a.digestKeys = built.digestKeys;
		a.expired = built.expired?.length ? built.expired : undefined;
		a.briefV = ally ? undefined : svc.ref.briefVersion?.();
		a.token = randomBytes(24).toString("hex");
		a.lastPoll = now();
		a.recovering = undefined;
		// A pi a stop left that reclaims its run is a live run again.
		if (a.left) {
			a.left = undefined;
			a.pending = undefined;
			delete a.rec.left;
		}
		a.rec.claimed = true;
		writeRun(slot, a.rec);
		byToken.set(a.token, a);
		if (!ally) svc.state = "running";
		// A pi the boss started by hand is a run they are in; so is the run a boss event from the tower prompt wakes (they are at the pane).
		if (!ally && (hand || a.rec.conversation || bossWake(svc))) {
			a.boss = now();
			a.bossSince = a.boss;
			if (hand) markBossIn(a);
		}
		if (!ally) svc.bossAt = undefined;
		log.line("run-claim", { workspace: a.rec.workspace, run: a.rec.id, ...(hand ? { hand: true } : {}) });
		const r = svc.ref.record();
		const peer: Peer | undefined = ally && a.rec.device && a.rec.team ? { device: a.rec.device, label: a.rec.deviceLabel ?? a.rec.device.slice(0, 6), short: a.rec.deviceShort ?? a.rec.device.slice(0, 6), team: a.rec.team, teamName: a.rec.teamName ?? a.rec.team.slice(0, 6) } : undefined;
		return { ok: true, token: a.token, kind: a.rec.kind, ...(a.rec.level ? { level: a.rec.level } : {}), ...(peer ? { peer } : {}), run: a.rec.id, workspace: a.rec.workspace, identity: r.id, label: r.label, brief: built.text, ...(hand ? { hand } : {}) };
	};
	const heldReply = (): ClaimReply => ({ ok: true, wait: true });

	/** `--sb-run`: the pi the server started claims its run. */
	async function claim(req: ClaimRequest): Promise<ClaimReply> {
		const runId = phrase(req.runId, 64), pane = phrase(req.pane, 64), pid = req.pid, started = typeof req.started === "string" ? req.started : undefined;
		if (!runId || !pane || typeof pid !== "number" || !Number.isInteger(pid)) return refuse("a claim needs the run id, the pane, and the PID");
		// Until every Herdr takeover the server has seen is processed, a claim is held: a pi that Herdr's integration resumed meets a run that is already ended.
		if (pendingTakeovers > 0) return heldReply();
		const a = byRun.get(runId);
		if (!a || a.ended) return refuse("this run is not one the server has live (it ended, or it never started)");
		if (a.rec.pid === undefined) return a.rec.claimed ? refuse("this run cannot be matched") : heldReply();
		if (a.rec.pane !== pane || a.rec.pid !== pid || (a.rec.started !== undefined && started !== undefined && started !== a.rec.started)) return refuse("the pane, PID, or start time are not the ones the server recorded for this run");
		if (a.token) return refuse("this run was claimed already");
		// The identity is not registered with pi-intercom yet (a server that has just started): the brief cannot be built, so the run is told to wait, not refused (B5R-F002).
		if (!a.svc.ref.live()) return heldReply();
		return issue(a);
	}
	/** A pi without the flag in a pane the server lists as a standing pane (or an ally pane): quit, or take the pane as a run of the boss's own. */
	async function paneRole(req: Record<string, unknown>): Promise<{ ok: true; role: "none" | "quit" | "wait" | "hand"; reason?: string; claim?: ClaimReply }> {
		const pane = phrase(req.pane, 64), pid = req.pid;
		// An ally pane is the server's: it starts pi there itself, so a pi without the flag has no business in it.
		if ([...byRun.values()].some((a) => a.rec.kind === "ally" && a.rec.pane === pane)) return { ok: true, role: "quit", reason: "this pane belongs to an ally run; only the sb server starts pi there" };
		const svc = [...services.values()].find((s) => s.ref.record().pane === pane);
		if (!svc || typeof pid !== "number") return { ok: true, role: "none" };
		if (pendingTakeovers > 0) return { ok: true, role: "wait" };
		// The pane is being replaced: a pi typed into it now would be admitted and then lose its pane.
		if (svc.ref.renewing?.()) return { ok: true, role: "quit", reason: "the standing pane is being replaced; try again in the new one" };
		if ((restored.get(pane) ?? 0) > now()) return { ok: true, role: "quit", reason: "Herdr restored this pane after a restart and resumed the old run's pi; the server starts its runs itself" };
		if (svc.run && !svc.run.ended) return { ok: true, role: "quit", reason: "a run of the tower service holds this pane" };
		// The boss started pi by hand in the standing pane: a local run with the brief and no events, under the run cap, and only for a PID Herdr lists in that pane (B5R-F007).
		if (slots >= o.max()) return { ok: true, role: "quit", reason: "the server's run limit is reached; try again when a run has ended" };
		const listed = await pidsOf(pane);
		// Herdr may list the wrapper pi was started through (`cmd.exe /c pi.cmd`): the pi is then the one below a listed process in the process table the server reads, whatever parent it reports.
		const via = listed?.includes(pid) ? undefined : await wrapperOf(listed ?? [], pid);
		if (!listed?.includes(pid) && via === undefined) return { ok: true, role: "quit", reason: "the server could not match this pi to the pane" };
		if (svc.run && !svc.run.ended) return { ok: true, role: "quit", reason: "a run of the tower service holds this pane" };
		slots++;
		const woken = now(), id = newId();
		// The start time is the table's when a wrapper listed it, never the pi's own report (F004).
		const started = via?.started ?? (typeof req.started === "string" ? req.started : undefined);
		const rec: RunRecord = { id, workspace: svc.ref.workspace, kind: "local", pane, agent: "hand", pid, ...(started ? { started } : {}), startedAt: iso(woken), events: [], hand: true, ...(via ? { via: [via.wrapper] } : {}) };
		const a: Active = { rec, svc, commands: [], lastPoll: woken, started: woken, digestKeys: [], offered: new Map() };
		svc.run = a;
		byRun.set(id, a);
		writeRun(slot, rec);
		ensureWatcher();
		return { ok: true, role: "hand", claim: await issue(a, true) };
	}

	// --- the run's requests -------------------------------------------------------------------------------------------------------------------------------------------

	const of = (token: unknown): Active | undefined => (typeof token === "string" ? byToken.get(token) : undefined);
	/** The messages an ally run was given at its start that it has not taken yet, oldest first (read from the inbox each time, so a server restart loses none). */
	const itemsOf = (a: Active, all = false): AllyItem[] => {
		const given = new Set(a.rec.admitted ?? []), took = new Set(a.rec.events);
		return (o.ally?.waiting(a.svc.ref.record().id) ?? []).filter((i) => i.device === a.rec.device && given.has(i.id) && (all || !took.has(i.id)));
	};
	/** The events of an ally run, as the poll offers them: `link` events whose text the tower service wrote, with the sender's verified header. */
	const allyEvents = (a: Active): QueuedEvent[] => itemsOf(a).map((i, n) => ({ id: i.id, seq: n, kind: "link" as const, from: { id: i.device, name: i.label }, text: o.ally ? allyText(a, i) : "", at: iso(i.at) }));
	/** The line an ally run reads for a message: the verified header (device, team, the ask it carries) and the peer's text. */
	const allyText = (a: Active, i: AllyItem): string => a.svc.ref.allyLine(i);
	const unknown = { ok: false as const, error: "unknown_token" };
	/** The newest brief for a live local run whose brief version moved since it had one, else undefined. A brief that cannot be built is tried again at the next change. */
	const refreshed = async (a: Active): Promise<string | undefined> => {
		const version = a.rec.kind === "local" ? a.svc.ref.briefVersion?.() : undefined;
		if (version === undefined || version === a.briefV || a.refreshing) return undefined;
		a.refreshing = true;
		try {
			const built = await a.svc.ref.brief({ events: [], woken: a.started, run: a.rec, refresh: true });
			a.briefV = version;
			a.digestKeys = built.digestKeys;
			if (built.expired?.length) a.expired = built.expired;
			return built.text;
		} catch (cause) {
			a.briefV = version;
			error("run-brief", `${a.rec.id}: ${(cause as Error).message}`);
			return undefined;
		} finally {
			a.refreshing = false;
		}
	};
	/** The run's poll: its heartbeat, and at idle the next event; or a command (steer, quit). */
	async function poll(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		a.lastPoll = now();
		settlePointer(a);
		// The run is up and asking: what its brief showed as expired is shown (a run that never gets here shows it again to the next).
		// Marking them shown moves the memory, which is the brief's own doing: the run has that brief already.
		if (a.expired) (a.svc.ref.shown?.(a.expired), (a.expired = undefined), (a.briefV = a.svc.ref.briefVersion?.() ?? a.briefV));
		const command = a.commands.shift();
		if (command) return { ok: true as const, command };
		if (a.terminating !== undefined || a.closing !== undefined) return { ok: true as const };
		// A long-lived run (a conversation may last an hour) is given a new brief when what it is made of moved: it reads the newest at its next turn (runmode.ts `before_agent_start`).
		const fresh = await refreshed(a);
		if (fresh) return { ok: true as const, brief: fresh };
		if (req.idle !== true) return (a.idleSince = undefined, { ok: true as const });
		// An event offered and not yet taken is offered again (the run did not confirm it); then the next one waiting.
		const again = [...a.offered.values()][0], next = again ?? (a.rec.kind === "ally" ? allyEvents(a).find((e) => !a.offered.has(e.id)) : waitingOf(a.svc, new Set(a.offered.keys()))[0]);
		if (!next) return (a.idleSince ??= now(), { ok: true as const });
		a.idleSince = undefined;
		a.steeredIdle = false;
		a.offered.set(next.id, next);
		return { ok: true as const, event: { id: next.id, kind: next.kind, text: next.text, from: next.from, at: next.at, ...(next.flag ? { flag: next.flag } : {}) } };
	}
	/** The run says an event is in its session. */
	function taken(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		const event = typeof req.id === "string" ? a.offered.get(req.id) : undefined;
		if (!event) return { ok: false as const, error: "that event was not offered to this run" };
		if (a.rec.kind === "local") updateEvent(slot, a.rec.workspace, { ...event, taken: { run: a.rec.id, at: iso(now()) } });
		a.offered.delete(event.id);
		a.rec.events.push(event.id);
		writeRun(slot, a.rec);
		if (event.kind === "boss") bossTurn(a);
		return { ok: true as const };
	}
	/** `tower_done`: refused while events are outstanding; otherwise the note is kept, the digest lines it showed are cleared, and the run is told to leave. */
	async function done(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		if (a.closing !== undefined) return { ok: true as const };
		if (req.left === true) return bossLeft(a);
		// The boss is in this run: it is not the model's to end. It answers them, and the run ends when they quit it or are silent for `bossAway` (the idle wrap-up then asks for the note).
		if (a.boss !== undefined && a.terminating === undefined) return { ok: true as const, stay: true as const, text: `The boss is in this session: they spoke here, or woke you from the tower prompt. Stay and answer them; do not end the run. It ends when they quit it, or when they have been silent for ${Math.round(t.bossAway / 60_000)} minutes and you are asked to wrap up. Then call tower_done with your handoff note.` };
		const note = typeof req.note === "string" ? req.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029]/g, "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n") : "";
		if (!note || note.length > 1200) return { ok: false as const, error: "the handoff note is 1 to 1,200 characters, one item per line" };
		if (req.wakeAfter !== undefined && a.rec.kind !== "local") return { ok: false as const, error: "an ally run schedules no wake" };
		const wake = req.wakeAfter;
		if (wake !== undefined && (typeof wake !== "number" || !Number.isInteger(wake) || wake < 5 || wake > 240)) return { ok: false as const, error: "wakeAfter is 5 to 240 minutes" };
		const outstanding = a.rec.kind === "ally" ? allyEvents(a).length : a.offered.size + waitingOf(a.svc, new Set(a.offered.keys())).length;
		if (outstanding) return { ok: false as const, error: `${outstanding} event${outstanding > 1 ? "s" : ""} still for you: they come to you at your next idle moment; handle them, then call tower_done again` };
		addNote(slot, a.rec.workspace, { kind: a.rec.kind, ...(a.rec.device ? { device: a.rec.device } : {}), run: a.rec.id, at: iso(now()), note });
		if (a.rec.kind === "local") await a.svc.ref.clearDigest(a.digestKeys).catch(() => {});
		if (wake !== undefined) schedule(a.svc, now() + wake * 60_000, iso(now()));
		a.closing = now();
		if (a.rec.kind === "local") a.svc.state = "closing";
		a.commands.length = 0;
		return { ok: true as const };
	}
	/** The boss quit a run they were in: it ends as done, with a note of its own; the events it did not take wait for the next run. A quit of any other run, or of one the server is already ending, changes nothing. */
	async function bossLeft(a: Active) {
		// A conversation is the boss's even when they have been quiet past `bossAway`: their quit is theirs, not a crash.
		if ((a.boss === undefined && !a.rec.conversation) || a.rec.kind !== "local" || a.terminating !== undefined || a.pending !== undefined) return { ok: true as const };
		await closeBossRun(a, a.rec.conversation ? "(boss quit)" : "(the boss left the run)");
		return { ok: true as const };
	}
	/** The boss's leave, from their own pi (`/quit`) or from a command: the run ends as done with a note of the server's. */
	async function closeBossRun(a: Active, note: string) {
		addNote(slot, a.rec.workspace, { kind: "local", run: a.rec.id, at: iso(now()), note });
		await a.svc.ref.clearDigest(a.digestKeys).catch(() => {});
		a.boss = undefined;
		a.closing = now();
		a.svc.state = "closing";
		a.commands.length = 0;
	}
	/** The boss wrote in a conversation: its turn count and the pointer's `lastAt` move (the pointer is the run's own once its file is reported). */
	function bossTurn(a: Active) {
		if (!a.rec.conversation) return;
		settlePointer(a);
		a.turns = (a.turns ?? 0) + 1;
		try {
			const was = readPointer(slot, a.rec.workspace);
			if (was?.run === a.rec.id) writePointer(slot, a.rec.workspace, { ...was, lastAt: iso(now()), turns: a.turns });
		} catch (cause) { error("conversation", (cause as Error).message); }
	}
	/** The conversation's session file is known: it becomes the boss session (only a conversation moves the pointer, and only a file under pi's sessions folder). */
	function keepPointer(a: Active, file: string) {
		const path = underRoot(file, o.sessions ?? sessionsRoot());
		if (!path) return error("conversation", `${a.rec.id}: the session file is not under pi's sessions folder, so it is not kept as the boss session`);
		const was = readPointer(slot, a.rec.workspace), same = was?.file === path;
		const next: BossPointer = { file: path, run: a.rec.id, startedAt: same ? was!.startedAt : iso(now()), lastAt: iso(now()), turns: same ? Math.max(a.turns ?? 0, was!.turns) : a.rec.conversation?.resumed ? 0 : a.turns ?? 0, ...(a.fresh ? { fresh: true as const } : {}) };
		a.turns = next.turns;
		try { writePointer(slot, a.rec.workspace, next); } catch (cause) { error("conversation", (cause as Error).message); }
	}
	/** A reported session file that was not on disk yet is kept as the boss session once it is (every check of `keepPointer` then applies); a file that never appears is no pointer and no error. */
	function settlePointer(a: Active) {
		const file = a.pendingFile;
		if (file === undefined || !onDisk(file)) return;
		a.pendingFile = undefined;
		keepPointer(a, file);
	}
	/** The boss asked for a new session: the pointer says so, so the next conversation does not resume. */
	function markFresh(workspace: string) {
		const was = readPointer(slot, workspace);
		if (was) writePointer(slot, workspace, { ...was, fresh: true });
	}
	/** The boss is in an event run (not a conversation): the record says when, so the next conversation's brief can name the run and what it left. */
	function markBossIn(a: Active) {
		if (a.rec.conversation || a.rec.bossIn) return;
		a.rec.bossIn = iso(now());
		writeRun(slot, a.rec);
	}
	/** The boss spoke in the run's session (its extension saw input from the keyboard): they are in the run. */
	function present(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		if (a.rec.kind !== "local") return { ok: false as const, error: "an ally run has no boss in it" };
		settlePointer(a);
		if (bossOver(a)) return { ok: true as const };
		a.boss = now();
		a.bossSince ??= a.boss;
		a.graceUntil = undefined;
		markBossIn(a);
		bossTurn(a);
		return { ok: true as const };
	}
	/** The server is ending the run, or the boss's `bossMax` since their first word is spent: a sign of them changes nothing. */
	function bossOver(a: Active) {
		return a.terminating !== undefined || (a.bossSince !== undefined && now() - a.bossSince >= t.bossMax);
	}
	/** `/new`, `/resume`, or `/fork` in a run end its claim: the next event wakes a fresh run. */
	async function releaseRun(req: Record<string, unknown>) {
		const a = of(req.token);
		if (!a || a.ended) return unknown;
		// `/new` in a conversation's pi starts the boss over: the next conversation is a new session.
		// A file pi has not written yet is not the pointer's: the earlier boss session is marked too, and the new one when it is kept.
		if (a.rec.conversation && req.reason === "new") a.rec.file && !a.pendingFile ? markFresh(a.rec.workspace) : (a.fresh = true, markFresh(a.rec.workspace));
		a.pending = "quit";
		await finish(a, "quit", phrase(req.reason, 60) || "the session was replaced");
		return { ok: true as const };
	}

	// --- timers (`wakeAfter`) -----------------------------------------------------------------------------------------------------------------------------------------

	/** One pending timer per workspace: a later one replaces it. */
	function schedule(svc: Svc, at: number, asked: string) {
		clearTimeout(svc.timer);
		writeTimer(slot, svc.ref.workspace, { at, asked });
		svc.timer = setTimeout(() => fire(svc), Math.max(0, at - now()));
		svc.timer.unref();
	}
	const fire = (svc: Svc) => {
		svc.timer = undefined;
		clearTimer(slot, svc.ref.workspace);
		try {
			append(slot, svc.ref.record(), { kind: "timer", text: "The follow-up you asked for with wakeAfter is due.", at: iso(now()) });
		} catch (cause) { return error("timer", (cause as Error).message); }
		poke(svc);
	};

	// --- services ---------------------------------------------------------------------------------------------------------------------------------------------------

	/** A service with a tower of its own: reads what the last server left (live runs to take back, events a dead run held, the pending timer). */
	function attach(ref: ServiceRef): Svc {
		const prior = services.get(ref.workspace);
		if (prior) return (prior.ref = ref, prior);
		const svc: Svc = { ref, state: "standing", crashes: [], notices: [], allies: new Map(), allyCrashes: new Map() };
		services.set(ref.workspace, svc);
		const ws = ref.workspace, live = new Set<string>();
		for (const rec of listRuns(slot, ws).filter((r) => !r.outcome)) {
			// A run of a server that went away: it has `lost` to reconnect with its run id; until then it is the service's run.
			// A conversation of the last server is still the boss's: its time counts from its start (the boss's presence is memory only, and their next word tells it again).
			const a: Active = { rec, svc, commands: [], lastPoll: now(), started: Date.parse(rec.startedAt) || now(), digestKeys: [], offered: new Map(), recovering: now(), ...(rec.left ? { left: true, pending: "quit" as Outcome } : {}), ...(rec.conversation ? { boss: now(), bossSince: Date.parse(rec.startedAt) || now(), turns: ((p) => (p?.run === rec.id ? p.turns : rec.conversation!.turns))(readPointer(slot, ws)), ...(rec.file && readPointer(slot, ws)?.run !== rec.id ? { pendingFile: rec.file } : {}) } : {}) };
			if (rec.kind === "ally" && rec.device) svc.allies.set(rec.device, a);
			else {
				svc.run = svc.run ?? a;
				svc.state = "running";
			}
			byRun.set(rec.id, a);
			slots++;
			live.add(rec.id);
		}
		if (live.size) ensureWatcher();
		// Events a dead run held (the server was down when it ended): handled as a crash.
		for (const e of readQueue(slot, ws)) if (e.taken && !live.has(e.taken.run)) {
			try { updateEvent(slot, ws, { ...withoutTaken(e), crashes: (e.crashes ?? 0) + 1, flag: "crash" }); } catch (cause) { error("run-events", (cause as Error).message); }
		}
		const timer = readTimer(slot, ws);
		if (timer) schedule(svc, timer.at, timer.asked);
		poke(svc);
		return svc;
	}
	/** The service is gone (the boss closed the tower, its tab is gone, the flag went off): its runs end. */
	async function detach(workspace: string, why = "the tower service ended") {
		const svc = services.get(workspace);
		if (!svc) return;
		services.delete(workspace);
		clearTimeout(svc.wake);
		clearTimeout(svc.allyWake);
		clearTimeout(svc.timer);
		blocked.delete(svc);
		for (const a of [svc.run, ...svc.allies.values()]) {
			if (a && !a.ended) {
				terminate(a, "quit");
				await finish(a, "quit", why);
			}
		}
	}
	const find = (workspace: string) => services.get(workspace);
	const conversationStatus = (a: Active): ConversationStatus => {
		const c = a.rec.conversation!, idle = a.idleSince !== undefined;
		return {
			since: a.rec.startedAt, resumed: c.resumed, ...(c.why ? { why: c.why } : {}), turns: a.turns ?? c.turns, idle,
			...(idle && a.boss !== undefined ? { idleAt: Math.max(a.boss, a.idleSince!) + t.bossAway } : {}),
			idleMs: t.bossAway, capAt: (a.bossSince ?? a.started) + t.bossMax,
			...(a.closing !== undefined || a.terminating !== undefined ? { closing: true as const } : {}),
		};
	};
	/** The last local runs with the first line of the note each left. */
	const localRunRows = (workspace: string): LocalRunRow[] => {
		const notes = new Map(readNotes(slot, workspace).filter((n) => n.kind === "local").map((n) => [n.run, n.note.split("\n")[0]!]));
		return listRuns(slot, workspace).filter((r) => r.kind === "local").slice(-RUNS_SHOWN).map((r): LocalRunRow => ({
			id: r.id, kind: r.conversation ? "conversation" : "event", ...(r.conversation ? { resumed: r.conversation.resumed, ...(r.conversation.why ? { why: r.conversation.why } : {}) } : {}),
			startedAt: r.startedAt, ...(r.endedAt ? { endedAt: r.endedAt } : {}), ...(r.outcome ? { outcome: r.outcome } : {}), ...(notes.has(r.id) ? { note: phrase(notes.get(r.id), 200) } : {}),
		}));
	};

	const api = {
		attach, detach, poke: (workspace: string) => { const s = services.get(workspace); if (s) poke(s); },
		/** An ally run asked its sender's device to confirm a call at `forward`: the answer is handed to it at its next poll. */
		watchConfirm(token: unknown, dialogId: string) {
			const a = of(token);
			if (a && !a.ended) confirms.set(dialogId, a.rec.id);
		},
		/** The run forgets a confirm it asked for (the dialog ended another way, or the holder refused the request): false when this run did not ask for it. */
		forgetConfirm(token: unknown, dialogId: string): boolean {
			const a = of(token);
			if (!a || a.ended || confirms.get(dialogId) !== a.rec.id) return false;
			confirms.delete(dialogId);
			return true;
		},
		/** The sender's device answered a `forward` confirm: true when an ally run was waiting for it. */
		confirmed(dialogId: string, allow: boolean): boolean {
			const run = confirms.get(dialogId), a = run ? byRun.get(run) : undefined;
			confirms.delete(dialogId);
			if (!a || a.ended) return false;
			a.commands.push({ type: "confirmed", dialogId, allow });
			return true;
		},
		/** Messages wait in the link inbox for the tower identity: the service of that identity starts ally runs for them. */
		pokeAllies: (identity: string) => { for (const s of services.values()) if (s.ref.record().id === identity) pokeAlly(s); },
		claim, paneRole, poll, taken, done, present, release: releaseRun,
		/** Writes the tokens of the service's ally panes again (the tower's publish, with its own `sb_order` as the key). */
		markAllies: (workspace: string, towerKey?: string | null) => { const s = services.get(workspace); return s ? markAllies(s, towerKey) : Promise.resolve(); },
		/** The run behind a token, or undefined. */
		runOf: (token: unknown): RunWho | undefined => {
			const a = of(token);
			if (a && !a.ended && a.rec.kind === "ally") {
				// A sender that left the roster ends the run now, not at the next tick; the level is the lower of the claimed one and the device's now.
				const standing = standingOf(a);
				if (!standing) terminate(a, "quit");
				return { id: a.rec.id, workspace: a.rec.workspace, kind: "ally", ...(standing ? { level: standing.level } : { gone: true as const }), ...(a.rec.device ? { device: a.rec.device } : {}), ...(a.rec.deviceLabel ? { deviceLabel: a.rec.deviceLabel } : {}), ...(a.rec.deviceShort ? { deviceShort: a.rec.deviceShort } : {}), ...(a.rec.team ? { team: a.rec.team } : {}), ...(a.rec.teamName ? { teamName: a.rec.teamName } : {}), pane: a.rec.pane, asks: itemsOf(a, true).flatMap((i) => (i.awaitsReply ? [i.awaitsReply] : [])) };
			}
			return a && !a.ended ? { id: a.rec.id, workspace: a.rec.workspace, kind: a.rec.kind, ...(a.rec.level ? { level: a.rec.level } : {}), ...(a.rec.device ? { device: a.rec.device } : {}), ...(a.rec.deviceLabel ? { deviceLabel: a.rec.deviceLabel } : {}), ...(a.rec.team ? { team: a.rec.team } : {}), pane: a.rec.pane, asks: itemsOf(a, true).flatMap((i) => (i.awaitsReply ? [i.awaitsReply] : [])) } : undefined;
		},
		/** A new Herdr server took over: the takeover is counted until `settled` (claims are held meanwhile), and every live run ends with outcome `herdr-restart`. */
		takeoverBegin() {
			pendingTakeovers++;
			for (const a of [...byRun.values()]) restored.set(a.rec.pane, now() + t.restored);
		},
		async takeoverEnd() {
			const runs = [...byRun.values()];
			for (const a of runs) await finish(a, "herdr-restart");
			pendingTakeovers = Math.max(0, pendingTakeovers - 1);
		},
		/** The boss writes to the tower (the GUI's composer, `/boss tower <prompt>`, the tower prompt): an event ahead of the rest; a held service wakes again. */
		boss(workspace: string, text: string, from = "the boss", opts: { present?: boolean } = {}): QueuedEvent {
			const svc = services.get(workspace);
			if (!svc) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			const written = append(slot, svc.ref.record(), { kind: "boss", from: { id: "boss", name: from }, text, at: iso(now()) });
			if (svc.state === "held") (svc.state = svc.run ? "running" : "standing", (svc.crashes = []), (svc.notices = svc.notices.filter((n) => n.id !== "loop")));
			// At the tower prompt the boss is at the pane: the run this wakes is one they are in, from its claim (or from now, when a run is live already).
			if (opts.present) {
				svc.bossAt = now();
				if (svc.run?.token && !svc.run.ended && svc.run.rec.kind === "local" && svc.run.closing === undefined && !bossOver(svc.run)) (svc.run.boss = now(), (svc.run.bossSince ??= svc.run.boss), markBossIn(svc.run));
			}
			poke(svc);
			return written;
		},
		/** A late outcome of something a run sent after the run ended: a notice event for the next run. */
		notice(workspace: string, text: string, key: string) {
			const svc = services.get(workspace);
			if (!svc) return;
			if (waitingOf(svc).some((e) => e.kind === "notice" && e.messageId === key)) return;
			append(slot, svc.ref.record(), { kind: "notice", text, at: iso(now()), messageId: key });
			poke(svc);
		},
		/** Retry on the crash-loop notice. */
		retry(workspace: string) {
			const svc = services.get(workspace);
			if (!svc) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			svc.crashes = [];
			svc.notices = svc.notices.filter((n) => n.id !== "loop");
			if (svc.state === "held") svc.state = "standing";
			poke(svc);
		},
		/**
		 * The boss leaves the conversation (`/boss tower leave`, the GUI's Leave, the tower prompt's `/quit`): it ends as done with the note `(boss quit)`; what it did not take waits for the next run. Refused when no
		 * conversation is live, or it has not claimed yet. A pi's own `/quit` reaches the same end through `run-done left`.
		 */
		async leave(workspace: string) {
			const svc = services.get(workspace);
			if (!svc) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			const a = svc.run;
			if (!a || a.ended || !a.rec.conversation) throw new Error("No boss conversation is live in this tower.");
			if (a.closing !== undefined || a.terminating !== undefined) return { left: true as const, already: true as const };
			if (!a.token) throw new Error("The boss conversation has not started yet; try again in a moment.");
			await closeBossRun(a, "(boss quit)");
			a.commands.push({ type: "quit" });
			log.line("run-boss-left", { workspace, run: a.rec.id, by: "command" });
			return { left: true as const };
		},
		/** The boss starts over (`/boss tower new`, the GUI's New, the tower prompt's `/new`): the next conversation is a new session, and a live one ends as `leave` ends it. */
		async fresh(workspace: string) {
			const svc = services.get(workspace);
			if (!svc) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			const a = svc.run, live = a && !a.ended && a.rec.conversation ? a : undefined;
			markFresh(workspace);
			if (live && !live.rec.file) live.fresh = true;
			const left = Boolean(live?.token && live.closing === undefined && live.terminating === undefined);
			if (left) await api.leave(workspace);
			return { fresh: true as const, left };
		},
		deliverAgain(workspace: string, id: string) {
			const svc = services.get(workspace), e = readQueue(slot, workspace, true).find((x) => x.id === id);
			if (!svc || !e) throw new Error("No such parked event");
			unparkEvent(slot, workspace, e);
			svc.notices = svc.notices.filter((n) => n.id !== `parked-${id}`);
			poke(svc);
		},
		dropParked(workspace: string, id: string) {
			const svc = services.get(workspace), e = readQueue(slot, workspace, true).find((x) => x.id === id);
			if (!svc || !e) throw new Error("No such parked event");
			dropParked(slot, workspace, e);
			svc.notices = svc.notices.filter((n) => n.id !== `parked-${id}`);
		},
		status(workspace: string): ServiceStatus | undefined {
			const svc = find(workspace);
			if (!svc) return undefined;
			const run = svc.run, recent = svc.crashes.filter((x) => x > now() - t.loop).length;
			return {
				state: svc.state,
				queued: waitingOf(svc, new Set(run?.offered.keys() ?? [])).length,
				...(run ? { run: { id: run.rec.id, kind: run.rec.kind, startedAt: run.rec.startedAt } } : {}),
				...(run && !run.ended && run.rec.conversation ? { conversation: conversationStatus(run) } : {}),
				...(run && !run.ended && run.rec.kind === "local" && !run.rec.conversation && run.rec.bossIn ? { bossIn: { id: run.rec.id, since: run.rec.bossIn } } : {}),
				...(localRunRows(workspace).length ? { localRuns: localRunRows(workspace) } : {}),
				allyRuns: [...svc.allies.values()].map((a) => ({ id: a.rec.id, device: a.rec.device ?? "?", label: a.rec.deviceLabel ?? a.rec.deviceShort ?? (a.rec.device ?? "?").slice(0, 6), startedAt: a.rec.startedAt })),
				...(svc.lastRun ? { lastRun: svc.lastRun } : {}),
				...(recent ? { crashes: recent } : {}),
				notices: svc.notices,
				parked: readQueue(slot, workspace, true).map((e) => ({ id: e.id, kind: e.kind, ...(e.from?.name ?? e.from?.id ? { from: e.from?.name ?? e.from?.id } : {}), first: phrase(e.text.split("\n").find((l) => l.trim()) ?? "", 120) })),
			};
		},
		/** The waiting events of a workspace for the GUI's queue rows. */
		queue: (workspace: string) => { const s = find(workspace); return s ? waitingOf(s, new Set(s.run?.offered.keys() ?? [])) : []; },
		/**
		 * The session file the tower unit's comms show: the live conversation's, or the event run the boss is in (they spoke to it while it ran), else the boss session's (bossconv.ts), which an event run does not move, so the log stays one line of talk with the boss. With no boss
		 * session yet it is the live run's, else the last local run's, as before.
		 */
		file: (workspace: string): string | undefined => {
			const svc = find(workspace), run = svc?.run, live = run && !run.ended && run.rec.kind === "local" && (run.rec.conversation || run.rec.bossIn !== undefined || run.boss !== undefined) ? run.rec.file : undefined;
			return live ?? readPointer(slot, workspace)?.file ?? svc?.run?.rec.file ?? listRuns(slot, workspace).filter((r) => r.kind === "local" && r.file).at(-1)?.file;
		},
		/** The boss messages a local run took, oldest first: the ones a memory proposal may cite (towermemory.ts). A message offered and not confirmed is not one. */
		bossEvents(token: unknown): { id: string; text: string }[] {
			const a = of(token);
			if (!a || a.ended || a.rec.kind !== "local") return [];
			return readQueue(slot, a.rec.workspace).filter((e) => e.kind === "boss" && e.taken?.run === a.rec.id).map((e) => ({ id: e.id, text: e.text }));
		},
		/**
		 * The pi session file the run's pane reports, kept in the record. An ally run's file is kept only when it is named for the pi session the run reports (`<time>_<session id>.jsonl`, as pi names it), so a run cannot
		 * hand the GUI another session's file; the same-user residual (the run reports both) is in docs/how-it-works.md.
		 */
		setFile(token: unknown, file: unknown, session?: unknown) {
			const a = of(token);
			if (!a || typeof file !== "string" || file.length > 4096) return;
			if (a.rec.kind === "ally" && !(typeof session === "string" && /^[\w-]{1,128}$/.test(session) && basename(file).endsWith(`_${session}.jsonl`))) return;
			a.rec.file = file;
			if (a.rec.conversation && a.rec.kind === "local") {
				a.pendingFile = onDisk(file) ? undefined : file;
				if (a.pendingFile === undefined) keepPointer(a, file);
			}
			writeRun(slot, a.rec);
		},
		/**
		 * A run token for a run the server did not start through pi: B6 issues an ally run's token this way once it has started its pane, and the tests use it to hold an ally token to its kind. It has no pane
		 * or PID, so the watcher leaves it alone (`release` ends it).
		 */
		mint(workspace: string, who: { kind: "local" | "ally"; device?: string; level?: string; team?: string }): string {
			const svc = services.get(workspace);
			if (!svc) throw new Error(`The sb server stands in for no tower of workspace ${workspace}`);
			const rec: RunRecord = { id: newId(), workspace, kind: who.kind, ...(who.device ? { device: who.device } : {}), ...(who.level ? { level: who.level } : {}), ...(who.team ? { team: who.team } : {}), pane: svc.ref.record().pane, agent: "minted", startedAt: iso(now()), events: [] };
			const a: Active = { rec, svc, commands: [], lastPoll: now(), started: now(), digestKeys: [], offered: new Map(), token: randomBytes(24).toString("hex") };
			byToken.set(a.token!, a);
			return a.token!;
		},
		/** The server leaves: timers stop. With `quitRuns` (a stop, not a restart) every live run is told to quit and given a moment, then ended by its PID if it stays, and recorded `quit` (B5R / R-F003). */
		async stop({ quitRuns = false }: { quitRuns?: boolean } = {}) {
			stopped = true;
			clearInterval(watcher);
			watcher = undefined;
			for (const svc of services.values()) (clearTimeout(svc.wake), clearTimeout(svc.allyWake), clearTimeout(svc.timer));
			if (!quitRuns) return;
			const live = [...byRun.values()].filter((a) => !a.ended && a.rec.pid !== undefined);
			for (const a of live) terminate(a, "quit");
			for (let waited = 0; waited < t.stopGrace && live.some((a) => !gone(a)); waited += 200) await o.sleep(200);
			for (const a of live) {
				if (!gone(a)) {
					// Windows: a pi that stays is not ended by force (it breaks the pane for the next pi). A run that has handed in its note is recorded done and its pi leaves by itself; any other is left unfinished, as a restart leaves it: its pi
					// reclaims it from the next server, or ends itself when the server stays away.
					if (win && a.closing === undefined) {
						log.line("run-left", { run: a.rec.id });
						a.rec.left = true;
						writeRun(slot, a.rec);
						continue;
					}
					if (!win) await reap(a);
				}
				// A run cut off mid-turn may have handled what it took: the events come back flagged, as after a Herdr restart (B5R3-F002).
				// A run that already handed in its tower_done handled what it took: the events are removed.
				if (a.closing !== undefined) await finish(a, "done");
				else await finish(a, "quit", "the sb server stopped", true);
			}
		},
		/** The notes of a service, for the brief. */
		notes: (workspace: string) => readNotes(slot, workspace),
		running: () => slots,
		tick,
		/** What the GUI shows of a tower the server runs: the service's state, its waiting events as queued rows (kind, sender, first line), the session file of its comms, and the files of its live ally runs (by run id; the net turns each into a read-only unit and keeps the path off the page). */
		view(workspace: string): TowerView | undefined {
			const status = api.status(workspace);
			if (!status) return undefined;
			const rows = api.queue(workspace).map((e) => ({ text: phrase(`${e.kind}${e.from?.name ?? e.from?.id ? ` · ${e.from?.name ?? e.from?.id}` : ""}: ${e.text.split("\n").find((l) => l.trim()) ?? ""}`, 240), as: "followUp" as const }));
			const file = api.file(workspace), allyFiles = Object.fromEntries([...(find(workspace)?.allies.values() ?? [])].flatMap((a) => (a.rec.file ? [[a.rec.id, a.rec.file]] : [])));
			// The event runs among the last local runs are read-only units of their own; the conversation's file is the tower unit's.
			const eventFiles = Object.fromEntries(listRuns(slot, workspace).filter((r) => r.kind === "local" && !r.conversation && r.file).slice(-RUNS_SHOWN).map((r) => [r.id, r.file!]));
			const memory = find(workspace)?.ref.memory?.();
			return { ...status, ...(memory ? { memory } : {}), queue: rows, ...(file ? { file } : {}), ...(Object.keys(allyFiles).length ? { allyFiles } : {}), ...(Object.keys(eventFiles).length ? { eventFiles } : {}) };
		},
	};
	return api;
}
export type Runs = ReturnType<typeof createRuns>;
