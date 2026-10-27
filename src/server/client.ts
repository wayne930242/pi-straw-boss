import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { localEndpoint } from "../endpoint.ts";
import { alive as pidAlive } from "../remote.ts";
import { newer } from "../semver.ts";
import { rememberStart, startedLater, startOf } from "../startof.ts";
import { spawnBreakaway } from "./breakaway.ts";
import { createLog, type Log } from "./log.ts";
import {
	adoptStarting, clearStartError, clearStopped, endStarting, fileOf, type IntercomScope, type LockDeps, LockUnreadable, markStarting, prepareSlot, readRecord, recordFileId, secretDir, readStartError, restartingFresh, type ServerRecord,
	type Slot, type StartError, takeLock, TOUCH_MS, touchRestarting, uidGate, updateRecord,
} from "./record.ts";
import { guarded, guardHome, guardSpawn, noteStarted } from "./testguard.ts";
import { fileIdentity, GateTimeout, ownerGate, resetFileAcl } from "./winprep.ts";
import { callControl, helloWhy, type Reply } from "./socket.ts";

// What reaches the server from outside it (docs/specs/2026-10-26-sb-backend.md, Starting, Stopping, Restarts and upgrades): a pi session's look, the shell's `cli.mjs`, a
// supervisor's `serve`. All of them judge liveness the same way, take `server.lock` before they start or restart anything, and start the server from their own package.

/** How long a start waits for the new server to answer hello, a restart's old server to exit, and a supervisor to start a `serve` server again (the budgets the guard's 30 s rule is built on). */
export interface Timers { start: number; exit: number; supervisor: number; touch: number }
/**
 * A cold start on Windows (a Windows 11 ARM VM, x64 emulation) took 7.4 to 22.9 s to answer hello, three starts in a row went past 20 s, and every PowerShell start in it takes 2 to 3 s:
 * the wait there is 60 s (the requester touches `restarting` the whole time, so nothing counts it as gone), 20 s elsewhere.
 */
export const START_MS = { win32: 60_000, other: 20_000 } as const;
export const timersFor = (platform: NodeJS.Platform = process.platform): Timers => ({ start: platform === "win32" ? START_MS.win32 : START_MS.other, exit: 10_000, supervisor: 10_000, touch: TOUCH_MS });
export const TIMERS: Timers = timersFor();
const HELLO_MS = 2000;
/** `ms`, cut to what is left before `deadline` (at least 100 ms, so a call still has a chance to answer). */
export const within = (ctx: Pick<Ctx, "now">, deadline: number | undefined, ms: number) => (deadline === undefined ? ms : Math.max(100, Math.min(ms, deadline - ctx.now())));
/**
 * How long a request waits for a `server.lock` that a start, a restart, or a stop holds: that one's start wait plus its exit wait (a restart waits for the old server to go, then starts
 * the new one). It follows the timers, so the 60 s start wait of a cold Windows start is waited out (70 s) and not turned into `busy` at a fixed 10 or 20 s.
 */
export const lockWaitFor = (ctx: Pick<Ctx, "timers">) => ctx.timers.start + ctx.timers.exit;

export type Refusal = "stopped" | "older" | "scope" | "herdr" | "busy" | "serve" | "start-failed" | "exit-timeout" | "restarting" | "unreachable" | "rate";
/** An agent's restarts are taken once a minute at most, for the whole machine (the server records the last one that counts). */
export const RESTART_EVERY_MS = 60_000;
/** A request the server's state turns down, or a start that failed; `startError` is what the new server wrote when it could not run. */
export class ServerError extends Error {
	code: Refusal;
	startError: StartError | undefined;
	/** Which wait ran out, when one did: `lock` (server.lock held by another start or restart), `start` (this requester's own start did not answer hello), `hello` (another requester's start did not), `exit` (the old server did not leave). */
	wait: Wait | undefined;
	constructor(code: Refusal, message: string, startError?: StartError, wait?: Wait) {
		super(message);
		this.code = code;
		this.startError = startError;
		this.wait = wait;
	}
}
export type Wait = "lock" | "start" | "hello" | "exit";

export interface SpawnSpec {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** Windows: the state folder, and the token of the file in it where the starter leaves the ACL check for the server it starts (the token goes on the server's command line only when it was started through WMI). */
	acl?: { dir: string; token: string };
	/** Windows: the starter's own pid; the launch PowerShell reads its start time too, so the starter needs no PowerShell start of its own for it. */
	starterPid?: number;
	/** How long the start may take to give a pid (Windows: the PowerShell call through WMI); the time the requester has left. */
	timeoutMs?: number;
	/** Detached so the server outlives the starter, no stdio so it holds none of the starter's, and no console window on Windows. */
	options: { detached: true; stdio: "ignore"; windowsHide: true };
}
/** How a start outside the starter's job went: `wmi` (the pid, and whether the process is outside the job), `direct` (a plain spawn after a failure, which `failure` names), or `failed` (PowerShell did not answer in time: no second start). */
export interface Started {
	pid: number; ms: number; via: "wmi" | "direct" | "failed" | "refused"; failure?: string; breakaway?: boolean;
	/** The server's start time, which the launch PowerShell read in its one start (the starter's cache of start times has it without a PowerShell of its own). */
	serverStarted?: string;
	/** Of `ms`, the milliseconds of the create and of the ACL check that followed in the same PowerShell start. */
	createMs?: number; aclMs?: number;
	/** The starter's own start time, read in the same PowerShell start. */
	starterStarted?: string;
	/** The process exists but the ACL check could not be left for it (the marker file); the server was told with an error marker. */
	markerError?: string;
}
export interface Launched {
	pid?: number;
	/** Resolves when the process is gone (its code, or null when it is not known). */
	exited: Promise<number | null>;
	/** A start that learns its pid late (Windows: through WMI): how long that took and how it went; `via: "direct"` with a `failure` is the fallback to a plain spawn. */
	started?: Promise<Started>;
	/** Called when the requester no longer needs `exited`. */
	release?(): void;
}
export const SPAWN_OPTIONS = { detached: true, stdio: "ignore", windowsHide: true } as const;
export const spawnDetached = (spec: SpawnSpec): Launched => {
	guardSpawn(spec);
	const child = spawn(spec.command, spec.args, { ...spec.options, env: spec.env, cwd: spec.cwd });
	child.unref();
	noteStarted(child.pid);
	return { pid: child.pid, exited: new Promise<number | null>((resolve) => (child.once("exit", (code) => resolve(code)), child.once("error", () => resolve(-1)))) };
};

/** What a session's own environment sets and the server must not inherit: its intercom identity and subagent role, the tower role, and the pane it runs in. */
export const isIdentity = (key: string) => IDENTITY.test(key);
const IDENTITY = /^(PI_INTERCOM_SESSION_ID|PI_INTERCOM_STABLE_ID|PI_SUBAGENT_.*|STRAW_BOSS_ROLE|HERDR_PANE_ID|HERDR_TAB_ID|HERDR_WORKSPACE_ID)$/;
/**
 * The environment the detached server gets: the starter's own minus its identity. `PI_INTERCOM_SCOPE_ID`, `PI_INTERCOM_TRANSPORT`, and `PI_INTERCOM_TCP` stay, so the
 * server registers in the same broker scope as the sessions (it records them in server.json).
 */
export const serverEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([key]) => !isIdentity(key)));

/** The broker routing an environment selects: sessions in another scope or on another transport cannot see this server's identities. */
export function intercomOf(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): IntercomScope {
	const scope = env.PI_INTERCOM_SCOPE_ID?.trim(), tcp = env.PI_INTERCOM_TCP?.trim(), transport = env.PI_INTERCOM_TRANSPORT?.trim().toLowerCase();
	// On Windows PI_INTERCOM_TRANSPORT=tcp, or the legacy PI_INTERCOM_TCP=1|true, selects the TCP transport; elsewhere there is only the socket.
	const tcpOn = platform === "win32" && (transport === "tcp" || tcp?.toLowerCase() === "1" || tcp?.toLowerCase() === "true");
	return { ...(scope ? { scope } : {}), transport: tcpOn ? "tcp" : "default", ...(tcp ? { tcp } : {}) };
}
export const sameBroker = (a: IntercomScope, b: IntercomScope) => (a.scope ?? "") === (b.scope ?? "") && (a.transport ?? "default") === (b.transport ?? "default");

export interface Ctx {
	env: NodeJS.ProcessEnv;
	slot: Slot;
	/** The version of the package the requester runs from. */
	version: string;
	/** The `cli.mjs` (or `cli.ts`) of that package: the server is started from it. */
	cli: string;
	/** Who asks, for `restarting.by`, the lock, and the log: `session "main" (3f2a1b9c)`, `cli up`. */
	by: string;
	platform: NodeJS.Platform;
	now(): number;
	sleep(ms: number): Promise<void>;
	alive(pid: number): boolean;
	startOf(pid: number): string | undefined;
	/** The start time of a process once it is known (a bounded wait on Windows, where it takes a PowerShell start); `startOf` by default when a test replaces that. */
	startedLater(pid: number): Promise<string | undefined>;
	spawn(spec: SpawnSpec): Launched;
	kill(pid: number, signal: NodeJS.Signals): void;
	lock: LockDeps;
	/** Makes the slot's folder ready before the first file is created in it (on Windows, protects it); `ms` is the time its native calls may take. `gate`, when given, is called right after the state folder is protected and before anything else is made in it (a secondary slot's `servers\\<hash>` folders), so a folder that landed foreign gets nothing. It may be asynchronous, and then so is the answer. */
	prepare(slot: Slot, ms?: number, gate?: () => void | Promise<void>): void | Promise<void>;
	/**
	 * The gate before a record in the state folder is trusted and before the first file is created in it: on Windows one owner read (`ownerGate`, asynchronous: a pi session's event loop does not wait
	 * for a PowerShell start), elsewhere a stat of the owner (`uidGate`); another account's folder is refused with nothing written in it. Returns whether it read an owner with a process.
	 */
	gate(slot: Slot, ms?: number): boolean | Promise<boolean>;
	log: Log;
	node: string;
	timers: Timers;
}
export function makeCtx(over: Partial<Ctx> & Pick<Ctx, "slot" | "version" | "cli" | "by">): Ctx {
	const now = over.now ?? Date.now, alive = over.alive ?? pidAlive, start = over.startOf ?? startOf;
	const sleep = over.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const log = over.log ?? createLog(fileOf(over.slot, "log"), { now });
	// A test run is refused here, before a lock or a placeholder record is written, when its real spawn would start a server outside the run's temp root.
	if (!over.spawn) guardHome({ cwd: over.slot.dir, env: over.env ?? process.env });
	const platform = over.platform ?? process.platform, prepare = over.prepare ?? ((slot: Slot, ms?: number, gate?: () => void | Promise<void>) => prepareSlot(slot, platform, undefined, ms, gate));
	return {
		env: process.env, platform: process.platform, node: process.execPath, spawn: platform === "win32" ? guarded((spec) => spawnBreakaway(spec, { fallback: spawnDetached })) : spawnDetached, timers: timersFor(over.platform),
		kill: (pid, signal) => void process.kill(pid, signal), prepare,
		gate: over.gate ?? (platform !== "win32" ? (slot: Slot) => uidGate(slot) : over.prepare ? () => false : (slot: Slot, ms?: number) => ownerGate(slot.stateDir, undefined, ms, undefined, ownedBesides(slot))),
		// This process holds the locks it takes: it is alive however the liveness check is replaced.
		lock: { now, alive: (pid) => pid === process.pid || alive(pid), startOf: start, sleep, note: (event, fields) => log.line(event, fields), prepare, ...(platform === "win32" ? { repair: (file: string) => resetFileAcl(file, undefined, 15_000) } : {}) },
		startedLater: over.startedLater ?? (over.startOf ? async (pid: number) => over.startOf!(pid) : (pid: number) => startedLater(pid, { hold: false })),
		...over, now, sleep, alive, startOf: start, log,
	};
}

/** What the Windows owner read judges besides the state folder, in the same PowerShell: the slot's own folder (a secondary slot's) and the record. */
const ownedBesides = (slot: Slot): string[] => [...new Set([slot.dir, fileOf(slot, "record")])].filter((path) => path !== slot.stateDir && existsSync(path));

export interface Probe {
	record: ServerRecord | undefined;
	/** The process of the record runs, started when the record says, and answers hello. */
	live: boolean;
	/** The record's process runs (pid alive, started when the record says) whether or not it answered hello in time: a server that is slow to answer still has its broker scope. */
	runs?: boolean;
	/** The record's process runs but its control endpoint refused this process for lack of permission (a server started from an elevated shell, a filtered token now): alive, not reachable, never gone. */
	denied?: boolean;
	hello: Reply | undefined;
}
/** Whether the process that wrote the record still runs: its pid is alive and started when the record says (a pid reused after a crash started later). */
export function runsAs(ctx: Pick<Ctx, "alive" | "startOf">, record: Pick<ServerRecord, "pid" | "started">, startKnownElsewhere = false): boolean {
	if (!ctx.alive(record.pid)) return false;
	// `startKnownElsewhere`: a start through the launch PowerShell is under way and this record is the server's own (its start time came from that PowerShell): asking for it here would be a
	// second PowerShell start, and the launch answer remembers it in a moment (VM pass 4, F2).
	if (!record.started || startKnownElsewhere) return true;
	const now = ctx.startOf(record.pid);
	return now === undefined || now === record.started;
}
/** A server counts as live when its PID is alive, started at the recorded time, and answers hello on the control socket within 2 s: a PID alone is not enough. */
const DENIED_START_MS = 3000;
export async function probe(ctx: Ctx, deadline?: number, startKnownElsewhere = false): Promise<Probe> {
	const record = await trusted(ctx, deadline);
	// A record with no socket is a start that has not got far enough to listen (`markStarting`): there is nothing to ask.
	if (!record || !record.socket || !ctx.alive(record.pid)) return { record, live: false, runs: false, hello: undefined };
	// The hello comes first: a server that answers it with the secret and its pid is that server, and no start time has to be asked for (on Windows that is a PowerShell start for a process that
	// is not this one: `stop` and `status` made one each; VM pass 5, F13). The start time is looked at only when it did not answer.
	const { hello, denied } = await helloWhy(record.socket, record.secret, within(ctx, deadline, HELLO_MS));
	const live = Boolean(hello && hello.pid === record.pid);
	if (live) return { record, live, runs: true, hello };
	if (!runsAs(ctx, record, startKnownElsewhere)) return { record, live: false, runs: false, hello: undefined };
	// `runs` pins the broker scope for a server that is slow to answer: only on positive evidence that this is that server (the start time the record names is the one the pid has now), so a pid
	// reused after a crash, or a record with no start time, pins nothing. A refusal for lack of permission is a running server that cannot be reached: it is told as that, never as gone.
	const confirmed = Boolean(record.started) && ctx.startOf(record.pid) === record.started;
	if (!denied) return { record, live: false, runs: confirmed, hello: undefined };
	// Refused for lack of permission: a running server that cannot be reached, told as that and never as gone (F11). Only POSITIVE evidence that the process under the pid is not the one the record names
	// makes it gone (R8-F004: a pipe name is free when its server is gone, and something else can refuse there): a start time that is known and different. The time is waited for, a few seconds at most;
	// one that is unknown (the read is slower than the wait, which on Windows it is: the CIM read takes 3.5 s and more; it failed; the record has none) stays denied (R9-F001).
	const when = confirmed || !record.started ? record.started : await Promise.race([ctx.startedLater(record.pid).catch(() => undefined), ctx.sleep(within(ctx, deadline, DENIED_START_MS)).then(() => undefined)]);
	const other = Boolean(record.started) && when !== undefined && when !== record.started;
	return other ? { record, live: false, runs: false, hello: undefined } : { record, live: false, runs: true, denied: true, hello: undefined };
}

/**
 * R13-F003: a record is what another account's folder can hold too, and everything that follows trusts it (a pipe to talk to, a secret, the state `status` tells, a record to write back). The record is
 * read FIRST, and a record that was read is used only once the folder's owner is judged (b1f-F001: a gate that asks "is there a record?" before reading it is passed by a record that appears, and
 * disappears, in between). On Windows the judgement is once per process for the folder, without the event loop waiting for the PowerShell (the memo of the other gates, shared by the requests that come
 * together); elsewhere a stat. Nothing is judged where there is no record. A foreign folder is the `acl` refusal of a start, and nothing was sent or written. Returns the record.
 */
export async function trusted(ctx: Ctx, deadline?: number): Promise<ServerRecord | undefined> {
	// The server rewrites its own record (temp + rename: a new file identity) while the gate runs, so a mismatch is read again, gate included, up to 3 times before it is a wait (R5-F001).
	for (let attempt = 0; ; attempt++) {
		const record = readRecord(ctx.slot);
		// A record file that was not read (another uid's, a link) is judged too: the answer is then "none", and the refusal says why.
		if (record || existsSync(fileOf(ctx.slot, "record"))) await passGate(ctx, deadline);
		// The gate judged the file at the path when PowerShell read it, 2 to 5 s after the content was read: a different file there now is not the one that was read (nothing trusted).
		const read = record && recordFileId(record);
		if (!read || ctx.platform !== "win32" || fileIdentity(fileOf(ctx.slot, "record")) === read) return record;
		if (attempt >= 3) throw new ServerError("start-failed", "the record changed while the folder was checked; try again", undefined, "start");
	}
}
/** The gate with no regard to a record: before any file of the slot is read (a log, `start-error.json`; b1f-F004), which another account's folder can hold as well. */
export async function passGate(ctx: Ctx, deadline?: number): Promise<void> {
	try {
		await ctx.gate(ctx.slot, deadline === undefined ? undefined : within(ctx, deadline, 15_000));
	} catch (error) {
		throw aclRefusal(ctx, error as Error);
	}
}
/** A gate that ran out of time is a wait (exit 1), not a refusal of the folder; anything else is `acl`. */
const aclRefusal = (ctx: Pick<Ctx, "now">, error: Error) => error instanceof GateTimeout ? new ServerError("start-failed", error.message, undefined, "start") : new ServerError("start-failed", `acl: ${error.message}`, { at: new Date(ctx.now()).toISOString(), code: "acl", text: error.message });

/** Whether Herdr listens at the slot's socket. */
export const herdrListens = (ctx: Pick<Ctx, "slot" | "platform">, ms = 2000) => new Promise<boolean>((resolve) => {
	const conn = createConnection(localEndpoint(ctx.slot.herdr, ctx.platform)).setTimeout(ms);
	conn.on("connect", () => (conn.destroy(), resolve(true)));
	conn.on("timeout", () => (conn.destroy(), resolve(false)));
	conn.on("error", () => resolve(false));
});

/** What a session's look does about the server. */
export type Verdict =
	| { do: "nothing"; why: "live" | "stopped" | "restarting" | "starting" }
	| { do: "start" }
	| { do: "upgrade" }
	| { do: "refuse"; why: "older" | "scope" | "herdr"; text: string };
/**
 * A session starts a server only when none is live, `server.json` is not `stopped`, no fresh `restarting` is there, its own package is not older than the record's `version`,
 * and, while that server is live, its broker scope and transport are the record's: a record of a server that is gone (stopped, or crashed) does not pin the scope, and the next start
 * runs in the scope of whoever starts it (VM pass 4, F6). A live server on an older version than the session's is upgraded.
 */
export function decide(ctx: Pick<Ctx, "version" | "env" | "platform" | "now" | "slot">, seen: Pick<Probe, "record" | "live" | "runs" | "denied">): Verdict {
	const { record } = seen, live = seen.live;
	if (record && record.herdr !== ctx.slot.herdr) return { do: "refuse", why: "herdr", text: `the sb server record in ${ctx.slot.dir} names another Herdr socket (${record.herdr}), not ${ctx.slot.herdr}` };
	// The scope is pinned while the record's process runs (live, or alive and slow to answer): a stopped or dead record pins nothing.
	if (record && (live || seen.runs === true) && !sameBroker(record.intercom, intercomOf(ctx.env, ctx.platform))) return { do: "refuse", why: "scope", text: "the sb server runs in another pi-intercom scope or transport than this session, so this session uses none" };
	// A server that runs but refused this process for lack of permission (started from an elevated shell, reached from a filtered token) is there: no second one is started over it, and it is not upgraded from here.
	if (seen.denied) return { do: "nothing", why: "live" };
	if (live) return record && newer(ctx.version, record.version) ? { do: "upgrade" } : { do: "nothing", why: "live" };
	if (record?.stopped) return { do: "nothing", why: "stopped" };
	if (restartingFresh(record, ctx.now())) return { do: "nothing", why: "restarting" };
	if (record && newer(record.version, ctx.version)) return { do: "refuse", why: "older", text: `the sb server is down and its record is from pi-straw-boss ${record.version}, newer than this session's ${ctx.version}; a session on an older package never starts a server` };
	return { do: "start" };
}

const specOf = (ctx: Ctx): SpawnSpec => ({
	command: ctx.node, args: [ctx.cli, "run", "--detached", "--by", ctx.by], env: serverEnv(ctx.env), cwd: ctx.slot.dir, options: SPAWN_OPTIONS,
	// Windows: the starter makes the ACL check for the server in its launch PowerShell, and leaves it in a file only this token names.
	...(ctx.platform === "win32" ? { acl: { dir: ctx.slot.stateDir, token: randomBytes(16).toString("hex") }, starterPid: process.pid } : {}),
});

/** The server a restart replaces: its record is the one the requester keeps fresh until the new server writes its own. */
export interface Replaced { pid: number; secret: string }
/**
 * Waits until a new server (not `old`) answers hello and is ready, touching `restarting.since` while it waits (`keeps`: the record whose `restarting` it touches, `old` by default),
 * or the child exits, or `ms` pass.
 */
export async function waitReady(ctx: Ctx, ms: number, { old, keeps = old, exited, began, deadline, pidUnknown }: { /** True while the pid of a start through the launch PowerShell is not told yet: the record's start time is then not asked for. */ pidUnknown?: () => boolean; old?: Replaced; keeps?: Replaced; exited?: Promise<number | null>; began?: string; /** The time the whole call must end by; `ms` is cut to it. */ deadline?: number } = {}): Promise<ServerRecord | { exit: number | null } | undefined> {
	const end = Math.min(ctx.now() + ms, deadline ?? Infinity);
	let gone: number | null | undefined, touched = ctx.now();
	void exited?.then((code) => (gone = code));
	for (;;) {
		const found = await probe(ctx, end, pidUnknown?.() === true);
		if (found.live && found.hello?.ready === true && found.record && found.record.pid !== old?.pid) return found.record;
		// A child that exited is told once the probe has had a last look at the record it may have written.
		if (gone !== undefined) return { exit: gone };
		if (ctx.now() >= end) return undefined;
		if (began && ctx.now() - touched >= ctx.timers.touch) {
			touched = ctx.now();
			touchRestarting(ctx.slot, ctx.now(), began, keeps);
		}
		await ctx.sleep(100);
	}
}
/** The reason the last start attempt gave for failing, as a ServerError. */
function failed(ctx: Ctx, outcome: { exit: number | null } | undefined, waitedMs = ctx.timers.start, note?: string): ServerError {
	const startError = readStartError(ctx.slot);
	const exit = outcome?.exit === null ? "the server exited before it answered" : `the server exited with code ${outcome?.exit} before it answered`;
	const why = startError ? `${startError.code}: ${startError.text}` : outcome ? `${exit} (see ${fileOf(ctx.slot, "log")})` : `the server did not answer hello within ${Math.round(waitedMs / 100) / 10} s (see ${fileOf(ctx.slot, "log")})`;
	return new ServerError("start-failed", note ? `${why}; the start through WMI: ${note}` : why, startError, !startError && !outcome ? "start" : undefined);
}

/**
 * Starts a detached server from this package and waits for it. The caller holds `server.lock`. `start-error.json` of an earlier attempt is deleted first. A start that is not a
 * restart (`began` is the restart's) writes `restarting` before it spawns anything and keeps it fresh until the server answers or the start fails, so a cold start is never taken for a
 * server that is gone.
 */
export async function launch(ctx: Ctx, { began, old, deadline }: { began?: string; old?: Replaced; /** The time the requester's whole call must end by (`up --timeout`); the start wait is cut to it. */ deadline?: number } = {}): Promise<ServerRecord> {
	const t0 = ctx.now(), waitMs = deadline === undefined ? ctx.timers.start : Math.max(0, Math.min(ctx.timers.start, deadline - t0));
	// Nothing left of the time given: no server is started, since the call would report a failure while the server it started kept starting.
	if (waitMs <= 0) throw new ServerError("start-failed", "the time given ran out before the server was started", undefined, "start");
	// A start that is not a restart creates files (the placeholder, the log): where `lockFor` was told a server runs and it has gone since, the gate is passed here, before the first of them.
	if (!began) try {
		await ctx.gate(ctx.slot, waitMs);
	} catch (error) {
		throw aclRefusal(ctx, error as Error);
	}
	clearStartError(ctx.slot);
	let keeps = old, mine: { began: string; expect: Replaced } | undefined;
	if (!began) {
		// The caller holds the lock, which `lockFor` took after the state folder was made safe at this very start: the folder is only made again here, with no second round of native calls.
		const marked = markStarting(ctx.slot, ctx.now(), { pid: process.pid, version: ctx.version, desk: ctx.env.STRAW_BOSS_DESK === "1", intercom: intercomOf(ctx.env, ctx.platform), mode: "detached", by: ctx.by, prepare: (slot) => secretDir(slot.dir, dirname(slot.stateDir)) });
		mine = { began: marked.began, expect: marked.expect };
		keeps = marked.expect;
	}
	const child = ctx.spawn({ ...specOf(ctx), timeoutMs: waitMs });
	if (mine && child.pid !== undefined) {
		mine.expect = adoptStarting(ctx.slot, mine.expect, child.pid);
		keeps = mine.expect;
	}
	ctx.log.line("start-requested", { by: ctx.by, version: ctx.version, pid: child.pid, spawnMs: ctx.now() - t0 });
	// A start outside the starter's job object learns its pid late; how long that took is a phase of its own, and a fallback to a plain spawn is told.
	let note: string | undefined, refusal: string | undefined, pidUnknown = child.pid === undefined && child.started !== undefined;
	void child.started?.then((s) => {
		ctx.log.line("phase", { name: "breakaway", ms: s.ms, via: s.via, pid: s.pid, ...(s.breakaway === undefined ? {} : { outsideJob: s.breakaway }), createMs: s.createMs, aclMs: s.aclMs });
		// The launch PowerShell read the server's start time: this process knows it without a PowerShell of its own when it looks at that server.
		if (s.serverStarted && s.pid > 0) rememberStart(s.pid, s.serverStarted);
		if (s.starterStarted) rememberStart(process.pid, s.starterStarted);
		if (s.markerError) ctx.log.line("error", { code: "acl-marker", text: s.markerError });
		if (s.failure) ctx.log.line("breakaway-failed", { via: s.via, text: s.failure });
		if (s.via === "failed") note = s.failure;
		if (s.via === "refused") refusal = s.failure;
		pidUnknown = false; // after the start times above are remembered
	}, () => void (pidUnknown = false));
	try {
		const outcome = await waitReady(ctx, waitMs, { exited: child.exited, began: began ?? mine?.began, old, keeps, deadline, pidUnknown: () => pidUnknown });
		if (outcome && "pid" in outcome) {
			ctx.log.line("start-answered", { pid: outcome.pid, ms: ctx.now() - t0 });
			// A server that was live all along answered (the look missed its hello, and the child found it and left): it does not clear the mark this start put on its record, so this start does.
			if (mine && outcome.pid !== child.pid) endStarting(ctx.slot, mine.began, mine.expect);
			return outcome;
		}
		if (mine) endStarting(ctx.slot, mine.began, mine.expect);
		// A PowerShell that timed out at the same moment as the wait: its word is in a moment, and the error is not without the sentence that says WMI may still have started the server.
		if (!outcome && !note && child.started) await Promise.race([child.started, ctx.sleep(100)]);
		// The launch script found the folder owned by another account and created nothing: told as an `acl` start error (exit 3), not as a server that did not answer.
		if (refusal) {
			ctx.log.line("start-failed", { code: "acl", text: refusal });
			const startError = { at: new Date(ctx.now()).toISOString(), code: "acl" as const, text: refusal };
			// Not written to `start-error.json` (R13-F004): the folder is the one just found to be another account's, and nothing is created in it. The refusal is in the error and the JSON of `up`.
			throw new ServerError("start-failed", `acl: ${refusal}`, startError);
		}
		ctx.log.line("start-unanswered", { ms: ctx.now() - t0, exit: outcome ? String(outcome.exit) : "none" });
		throw failed(ctx, outcome, waitMs, note);
	} finally {
		child.release?.();
	}
}

/** Whether a request must pass the owner gate before it writes: not when a server is known to run in the folder (it wrote nothing of its own to get there, and a stop or a second `up` runs no PowerShell). */
export const needsGate = (seen: Probe) => !(seen.live || seen.denied || seen.runs === true);
/**
 * Takes `server.lock`, after the slot's folder is ready (on Windows protected: no file is created in an unprotected folder, nor in a folder another account owns: `gate`, R13). A folder that
 * cannot be protected is a start that cannot run here (`acl`, told with exit 3, and not written to a file: there is no protected folder to write it in); a busy lock is `busy`, whose `wait` is `lock`.
 */
export async function lockFor(ctx: Ctx, waitMs: number, deadline?: number, gate = true) {
	try {
		const ms = deadline === undefined ? undefined : within(ctx, deadline, 15_000);
		// R13: nothing is created or changed in a folder that is another account's. An existing folder is gated BEFORE anything is made or changed in it (the owner is read once, and not again by
		// `prepare` for a wrong DACL); a folder `prepare` has just made (the first start ever) is gated right after it, before the lock, the placeholder, the log or `start-error.json`. Both are
		// no-ops where the owner was read for this folder already, and where a server is known to run (`gate` false).
		// The phase times the gate's own reads (R13-F006), not the folder preparation around them.
		let read = false, gateMs = 0;
		const gated = async () => {
			const t = ctx.now();
			try {
				if (await ctx.gate(ctx.slot, ms)) read = true;
			} finally {
				gateMs += ctx.now() - t;
			}
		};
		if (gate) await gated();
		// The gate is also passed inside `prepare`, between the protect call and the mkdirs of a secondary slot; a no-op when the folder was read already.
		await ctx.prepare(ctx.slot, ms, gate ? gated : undefined);
		if (gate) await gated();
		if (read) ctx.log.line("phase", { name: "owner-gate", ms: gateMs });
	} catch (error) {
		throw aclRefusal(ctx, error as Error);
	}
	// Prepared just above: the lock only makes the folder again, with no second round of native calls.
	return takeLock(ctx.slot, ctx.by, { ...ctx.lock, prepare: (slot) => secretDir(slot.dir, dirname(slot.stateDir)) }, waitMs).catch((error) => {
		// A lock that cannot be opened is a start that cannot run here, said as it is (exit 3, `acl`): not a lock another start holds.
		if (error instanceof LockUnreadable) throw new ServerError("start-failed", `acl: ${error.message}`, { at: new Date(ctx.now()).toISOString(), code: "acl", text: error.message });
		throw new ServerError("busy", (error as Error).message, undefined, "lock");
	});
}
/** The wait for a lock that ends at `deadline`, and the error when the deadline came while the lock was being taken. */
const lockUntil = async (ctx: Ctx, deadline: number, gate = true) => {
	const lock = await lockFor(ctx, Math.max(0, deadline - ctx.now()), deadline, gate);
	if (ctx.now() >= deadline) {
		lock.release();
		throw new ServerError("busy", "the time given ran out while another start or restart held server.lock", undefined, "lock");
	}
	return lock;
};

export interface Ensured { server: "found" | "started"; record: ServerRecord }
/**
 * Makes sure a server runs, for a session's look and for `up`: under `server.lock`, it looks again and starts one when `decide` says to. `boss`: the boss's own start
 * (`up`), which clears `stopped` first; a start that no one asked for leaves a stopped server alone.
 */
export async function ensure(ctx: Ctx, { boss = false, lockWaitMs = 0, deadline }: { boss?: boolean; lockWaitMs?: number; /** One time limit for the lock wait and the start wait together (`up --timeout`). */ deadline?: number } = {}): Promise<Ensured | { skipped: Verdict }> {
	// A server that is live is looked at without writing anything or reading an owner: the lock below needs no gate then, and a second `up` runs no PowerShell.
	const gate = needsGate(await probe(ctx, deadline));
	const lock = await (deadline === undefined ? lockFor(ctx, lockWaitMs, undefined, gate) : lockUntil(ctx, deadline, gate));
	try {
		let seen = await probe(ctx, deadline);
		if (boss && seen.record?.stopped && !seen.live && !seen.denied && clearStopped(ctx.slot, true)) seen = { ...seen, record: readRecord(ctx.slot) };
		const verdict = decide(ctx, seen);
		if (verdict.do === "nothing" && verdict.why === "live") return { server: "found", record: seen.record! };
		if (verdict.do !== "start") return { skipped: verdict };
		return { server: "started", record: await launch(ctx, { deadline }) };
	} finally {
		lock.release();
	}
}

/** Asks the live server to restart, touches `restarting.since` while it goes, and waits for it to exit. The caller holds `server.lock`. Returns the `began` of the restart. */
async function retire(ctx: Ctx, old: ServerRecord, reason: string, counts: boolean, deadline?: number): Promise<string> {
	let reply: Reply | undefined;
	try {
		// `counts`: whether this restart is one the once-a-minute limit counts (an agent's, the boss's, a shell's; not an upgrade or a serve takeover).
		reply = (await callControl(old.socket, old.secret, { cmd: "restart", reason, by: ctx.by, counts }, within(ctx, deadline, 5000))).reply;
	} catch (error) {
		throw new ServerError("unreachable", `the sb server did not take the restart: ${(error as Error).message}`);
	}
	if (!reply?.ok) throw new ServerError(reply?.error === "restarting" ? "restarting" : "unreachable", `the sb server refused the restart: ${String(reply?.error ?? "no answer")}`);
	const began = readRecord(ctx.slot)?.restarting?.began ?? new Date(ctx.now()).toISOString();
	const end = Math.min(ctx.now() + ctx.timers.exit, deadline ?? Infinity);
	let touched = ctx.now(), termed = false;
	while (ctx.alive(old.pid)) {
		if (ctx.now() - touched >= ctx.timers.touch) {
			touched = ctx.now();
			touchRestarting(ctx.slot, ctx.now(), began, old);
		}
		if (deadline !== undefined && ctx.now() >= deadline) throw new ServerError("exit-timeout", `the old sb server (pid ${old.pid}) did not exit before the time given ran out`, undefined, "exit");
		if (ctx.now() >= end) {
			// It said it would exit within 10 s: a server that does not is stuck, and a signal is the way a supervisor would stop it too.
			if (termed) throw new ServerError("exit-timeout", `the old sb server (pid ${old.pid}) did not exit after the restart was asked`);
			termed = true;
			ctx.log.line("restart-term", { pid: old.pid, by: ctx.by });
			try { ctx.kill(old.pid, "SIGTERM"); } catch { /* gone meanwhile */ }
			await ctx.sleep(ctx.timers.exit / 2);
			continue;
		}
		await ctx.sleep(50);
	}
	return began;
}

export interface Restarted { server: "started" | "restarted" | "upgraded"; record: ServerRecord }
/** What a restart holds `server.lock` with: it lets go while it waits for a supervisor, and takes the lock again for the launch that follows. */
interface Hold { release(): void; retake(): Promise<void> }
export interface RestartOptions {
	reason: string;
	downgrade?: boolean;
	upgrade?: boolean;
	lockWaitMs?: number;
	/** One time limit for the lock wait, the old server's exit, and the start wait together (`up --timeout`); it replaces `lockWaitMs`. */
	deadline?: number;
	boss?: boolean;
	/** An agent's restart: refused under the lock when the last restart that counts was less than a minute ago. */
	limit?: boolean;
	/** Whether this restart counts for that limit; an upgrade does not by default. */
	counts?: boolean;
}
/**
 * Every restart goes the same way (`restart`, `upgrade`, `up`'s desk restart): the requester takes `server.lock` and holds it until the new server answers hello; asks the old
 * server to restart with a reason; touches `restarting.since` every 2 s; and starts the new server from its own package, never from one older than the recorded `version`
 * (unless `downgrade`). A server that is down is started instead. The new one keeps the GUI port and token of the record (B2), registers its identities, and clears `restarting`.
 */
export async function restart(ctx: Ctx, { reason, downgrade = false, upgrade = false, lockWaitMs = lockWaitFor(ctx), deadline, boss = false, limit = false, counts = !upgrade }: RestartOptions): Promise<Restarted> {
	const gate = needsGate(await probe(ctx, deadline));
	let lock = await (deadline === undefined ? lockFor(ctx, lockWaitMs, undefined, gate) : lockUntil(ctx, deadline, gate));
	const hold: Hold = { release: () => lock.release(), retake: async () => void (lock = await lockFor(ctx, deadline === undefined ? ctx.timers.start : Math.max(0, Math.min(ctx.timers.start, deadline - ctx.now())), deadline)) };
	try {
		return await restartLocked(ctx, { reason, downgrade, upgrade, boss, limit, counts, deadline }, hold);
	} finally {
		lock.release();
	}
}
/** The restart itself; the caller holds `server.lock`. */
async function restartLocked(ctx: Ctx, { reason, downgrade, upgrade, boss, limit, counts, deadline }: Required<Omit<RestartOptions, "lockWaitMs" | "deadline">> & { deadline?: number }, hold: Hold): Promise<Restarted> {
	const seen = await probe(ctx, deadline), record = seen.record;
	if (record && record.herdr !== ctx.slot.herdr) throw new ServerError("herdr", `the sb server record names another Herdr socket (${record.herdr}), not ${ctx.slot.herdr}`);
	// The server runs in the broker scope it was started in, and a requester in another one would move it there: it uses none, and restarts none.
	if (record && (seen.live || seen.runs === true) && !sameBroker(record.intercom, intercomOf(ctx.env, ctx.platform))) throw new ServerError("scope", "the sb server runs in another pi-intercom scope or transport than this process, so this process does not restart it");
	if (seen.denied) throw new ServerError("unreachable", unreachableText(record!));
	if (record?.stopped && !seen.live && !boss) throw new ServerError("stopped", "the sb server was stopped on purpose; /boss server or `cli.mjs up` starts it again");
	if (record && newer(record.version, ctx.version) && !downgrade) throw new ServerError("older", `the sb server runs pi-straw-boss ${record.version}, newer than this package's ${ctx.version}; a restart from an older package needs --downgrade`);
	if (boss) clearStopped(ctx.slot, true); // the server's own stop only: a GUI stopped on purpose stays so until /boss gui or `cli.mjs up`
	const done = (found: ServerRecord): Restarted => ({ server: upgrade ? "upgraded" : "restarted", record: found });
	const old = record && { pid: record.pid, secret: record.secret };
	// A server that is down starts, whatever the limit says. A `serve` server down with a fresh `restarting` is between two lives of a supervisor, which another requester is
	// waiting on: this one waits for that serve as well, and launches a detached server only when none came.
	if (!seen.live || !record) {
		if (record?.mode === "serve" && restartingFresh(record, ctx.now())) {
			const back = await supervised(ctx, hold, old!, undefined, deadline);
			if (back) return done(back);
		}
		return { server: "started", record: await launch(ctx, { deadline }) };
	}
	if (limit && !boss && record.lastRestart) {
		const last = Date.parse(record.lastRestart.at);
		if (Number.isFinite(last) && ctx.now() - last < RESTART_EVERY_MS) throw new ServerError("rate", `The sb server was restarted ${Math.round((ctx.now() - last) / 1000)} s ago (${record.lastRestart.reason}, by ${record.lastRestart.by}); restarts are taken once a minute at most.`);
	}
	const began = await retire(ctx, record, reason, counts, deadline);
	if (record.mode === "serve") {
		const back = await supervised(ctx, hold, old!, began, deadline);
		if (back) return done(back);
	}
	return { server: upgrade ? "upgraded" : "restarted", record: await launch(ctx, { began, old, deadline }) };
}
/**
 * A supervisor starts a `serve` server again (it exited with the code it restarts on), and that `serve` takes `server.lock` to run: the requester lets go of the lock for the
 * wait, keeps `restarting` fresh (`began` is the restart it asked for; a requester that only waits touches nothing), and takes the lock again only to start a server itself when
 * none came. Gives the server that came, or undefined with the lock held again.
 */
async function supervised(ctx: Ctx, hold: Hold, old: Replaced, began: string | undefined, deadline?: number): Promise<ServerRecord | undefined> {
	hold.release();
	const back = await waitReady(ctx, ctx.timers.supervisor, { old, began, deadline });
	if (back && "pid" in back) return back;
	try {
		await hold.retake();
	} catch (error) {
		// A `serve` that took the lock holds it while it starts, and may hold it past the budget: the restart has worked if the server it starts answers.
		if (!(error instanceof ServerError && error.code === "busy")) throw error;
		const started = await waitReady(ctx, ctx.timers.start, { old, deadline });
		if (started && "pid" in started) return started;
		throw error;
	}
	const again = await probe(ctx, deadline);
	if (again.live && again.record && again.record.pid !== old.pid) {
		// A `serve` that took the lock in the gap is starting: wait for it as for any new server.
		const started = await waitReady(ctx, ctx.timers.start, { old, began, deadline });
		if (started && "pid" in started) return started;
	}
	return undefined;
}

export interface Stopped { outcome: "stopped" | "already-down" }
/**
 * A stop on purpose: under the lock, the server writes `stopped`, ends its work, and exits. A `serve` server refuses (its supervisor is what stops it). With no server
 * running, a record that is not yet marked is marked, so no session starts the server again unasked.
 */
export async function stop(ctx: Ctx): Promise<Stopped> {
	const t0 = ctx.now();
	// A state folder that is not the caller's (made by an elevated run, say) cannot be protected or locked from here, and a stop cannot be made without the lock: it says so, and where the server can be
	// stopped from, instead of leaving only the ACL text (VM pass 4, F8).
	// A server that is down is marked stopped, which writes into the folder: the owner gate comes first. A live one is stopped with no PowerShell.
	const gate = needsGate(await probe(ctx));
	const lock = await lockFor(ctx, lockWaitFor(ctx), undefined, gate).catch((error: unknown) => {
		// Only for the refusals that say the folder is another account's (the owner read, or the protect step's exit 5); a link, a foreign ACE, an unreadable lock or a timeout keep their own words.
		if (error instanceof ServerError && error.code === "start-failed" && error.startError?.code === "acl" && /\(protect step, exit (?:5|1307|1314)\b|belongs to another account/.test(error.startError.text)) {
			throw new ServerError("start-failed", `${error.message} (the stop needs the folder: a server that runs in it was started by another account, so stop it from that account, an elevated shell for an elevated run, or end its process)`, error.startError);
		}
		throw error;
	});
	const locked = ctx.now();
	try {
		const seen = await probe(ctx);
		const probed = ctx.now();
		// As for a restart: the server runs in the broker scope it was started in, and a stop from another one is not its requester's to give.
		if (seen.record && (seen.live || seen.runs === true) && !sameBroker(seen.record.intercom, intercomOf(ctx.env, ctx.platform))) throw new ServerError("scope", "the sb server runs in another pi-intercom scope or transport than this process, so this process does not stop it");
		// Running but refused for lack of permission: not down, and not marked stopped.
		if (seen.denied && seen.record) throw new ServerError("unreachable", unreachableText(seen.record));
		if (!seen.live || !seen.record) {
			if (seen.record && !seen.record.stopped) updateRecord(ctx.slot, (r) => ({ ...r, stopped: true }));
			return { outcome: "already-down" };
		}
		if (seen.record.mode === "serve") throw new ServerError("serve", "the sb server runs under a supervisor (cli.mjs serve): stop the supervisor instead (launchctl bootout …, systemctl --user stop …)");
		let reply: Reply | undefined;
		try {
			reply = (await callControl(seen.record.socket, seen.record.secret, { cmd: "stop", by: ctx.by }, 5000)).reply;
		} catch (error) {
			throw new ServerError("unreachable", `the sb server did not take the stop: ${(error as Error).message}`);
		}
		if (reply && !reply.ok) throw new ServerError(reply.error === "serve" ? "serve" : "unreachable", `the sb server refused the stop: ${String(reply.error)}`);
		const replied = ctx.now(), end = replied + ctx.timers.exit;
		while (ctx.alive(seen.record.pid) && ctx.now() < end) await ctx.sleep(50);
		if (ctx.alive(seen.record.pid)) throw new ServerError("exit-timeout", `the sb server (pid ${seen.record.pid}) did not exit after the stop was asked`);
		// The server marks it itself on its way out; a server that died first leaves the mark to this requester.
		updateRecord(ctx.slot, (r) => (r.stopped ? undefined : { ...r, stopped: true }));
		// Where a stop spends its time (a slow one on Windows was 7 to 12 s): the lock, the look at the server, the request, and the wait for the process to be gone.
		ctx.log.line("stop-done", { lockMs: locked - t0, probeMs: probed - locked, replyMs: replied - probed, exitMs: ctx.now() - replied });
		return { outcome: "stopped" };
	} finally {
		lock.release();
	}
}

/**
 * What `serve` does with a live detached server: hands over by the restart path and waits for it to leave. The caller holds `server.lock` and goes on to run as the server.
 * It never replaces a server of a newer package, nor one in another broker scope, as no other restart does.
 */
export async function takeOver(ctx: Ctx, old: ServerRecord): Promise<void> {
	if (!sameBroker(old.intercom, intercomOf(ctx.env, ctx.platform))) throw new ServerError("scope", "the sb server runs in another pi-intercom scope or transport than this serve, so serve does not take it over");
	if (newer(old.version, ctx.version)) throw new ServerError("older", `the sb server runs pi-straw-boss ${old.version}, newer than this serve's ${ctx.version}; serve never replaces a newer server`);
	await retire(ctx, old, "serve takes over", false);
}

/** What is said of a server that runs and refused this process (VM pass 5, F11). */
export const unreachableText = (record: Pick<ServerRecord, "pid" | "detach">) =>
	`the sb server (pid ${record.pid}) runs but this process may not reach it: it was probably started from an elevated pi or shell, and this one is not elevated; stop or restart it from an elevated shell`;

/** The state of the server for a shell, from the files and a hello (docs/specs/2026-10-26-sb-backend.md, States for a shell). */
export type State = "live" | "restarting" | "stopped" | "gui-stopped" | "gone";
export function stateOf(ctx: Pick<Ctx, "now">, seen: Pick<Probe, "record" | "live" | "denied">): State {
	const { record } = seen, live = seen.live || seen.denied === true;
	if (!record) return "gone";
	if (record.stopped) return "stopped";
	if (restartingFresh(record, ctx.now())) return "restarting";
	// A server that runs with its GUI stopped on purpose (`/boss gui stop`) is still live, but its URL does not answer: a shell runs `up`, which starts the GUI again.
	return live ? (record.gui?.stopped ? "gui-stopped" : "live") : "gone";
}

/**
 * What `cli.mjs status` prints and `boss_server status` answers: the state, the record's facts a shell may read (never the secret or the socket), the live server's own account
 * of its work, and, for a server that is gone, the start-error of the last attempt. Works with the server down, from the files.
 */
export async function describe(ctx: Ctx): Promise<Record<string, unknown>> {
	const seen = await probe(ctx), record = seen.record, state = stateOf(ctx, seen);
	// The last start's error is a file of the folder: read only once the folder is judged, and not at all when it was not there to be judged for (b1f-F004, R2-F002).
	let startError: StartError | undefined;
	if (existsSync(fileOf(ctx.slot, "startError"))) {
		await passGate(ctx);
		startError = readStartError(ctx.slot);
	}
	let more: Record<string, unknown> = { towers: [], link: null };
	if (seen.live && record) {
		try {
			const { reply } = await callControl(record.socket, record.secret, { cmd: "status" }, 3000);
			const remote = (reply?.gui as { remote?: unknown } | undefined)?.remote;
			if (reply?.ok) more = { uptimeMs: reply.uptimeMs, towers: reply.towers ?? [], link: reply.link ?? null, ...(remote ? { remote } : {}) };
		} catch { /* the server went while it was asked */ }
	}
	return {
		state, package: ctx.version, primary: ctx.slot.primary, herdr: ctx.slot.herdr, log: fileOf(ctx.slot, "log"),
		...(record ? {
			pid: record.pid, ...(record.started ? { started: record.started } : {}), version: record.version, mode: record.mode, desk: record.desk,
			...(record.stopped ? { stopped: true } : {}), ...(record.restarting ? { restarting: record.restarting } : {}), ...(record.lastError ? { lastError: record.lastError } : {}),
			...(record.lastRestart ? { lastRestart: record.lastRestart } : {}), ...(record.gui ? { gui: record.gui, url: guiUrl(record) } : {}),
			...(record.detach ? { detach: record.detach, ...(record.detachFailure ? { detachFailure: record.detachFailure } : {}) } : {}), ...(detachWarning(record) ? { warning: detachWarning(record) } : {}),
			...(seen.denied ? { reachable: false, warning: unreachableText(record) } : {}),
		} : {}),
		...(state === "gone" && startError ? { startError } : {}), ...more,
	};
}
/** What to tell about a server that was started by a plain spawn after the start outside the starter's job failed: it dies with the pane or ssh session that started it. */
export function detachWarning(record: Pick<ServerRecord, "detach" | "detachFailure"> | undefined): string | undefined {
	if (record?.detach === "direct") return `the sb server was started without leaving its starter's job (${record.detachFailure ?? "WMI did not start it"}), so it ends with the pane or ssh session that started it`;
	if (record?.detach === "wmi-in-job") return "the sb server was started through WMI, but the job it is in did not allow it to break away, so it stays in the WMI provider host's job and ends with that job's limits";
	return undefined;
}
/** The GUI's URL; null while the server has not started one. */
export const guiUrl = (record: ServerRecord | undefined) => (record?.gui ? `http://127.0.0.1:${record.gui.port}/${record.gui.token}/` : null);
