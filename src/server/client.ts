import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { localEndpoint } from "../endpoint.ts";
import { alive as pidAlive } from "../remote.ts";
import { newer } from "../semver.ts";
import { startOf } from "../startof.ts";
import { createLog, type Log } from "./log.ts";
import {
	adoptStarting, clearStartError, clearStopped, endStarting, fileOf, type IntercomScope, type LockDeps, markStarting, readRecord, readStartError, restartingFresh, type ServerRecord,
	type Slot, type StartError, takeLock, TOUCH_MS, touchRestarting, updateRecord,
} from "./record.ts";
import { callControl, ControlError, helloOf, type Reply } from "./socket.ts";

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
	constructor(code: Refusal, message: string, startError?: StartError) {
		super(message);
		this.code = code;
		this.startError = startError;
	}
}

export interface SpawnSpec {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string;
	/** Detached so the server outlives the starter, no stdio so it holds none of the starter's, and no console window on Windows. */
	options: { detached: true; stdio: "ignore"; windowsHide: true };
}
export interface Launched { pid?: number; exited: Promise<number | null> }
export const SPAWN_OPTIONS = { detached: true, stdio: "ignore", windowsHide: true } as const;
export const spawnDetached = (spec: SpawnSpec): Launched => {
	const child = spawn(spec.command, spec.args, { ...spec.options, env: spec.env, cwd: spec.cwd });
	child.unref();
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
	spawn(spec: SpawnSpec): Launched;
	kill(pid: number, signal: NodeJS.Signals): void;
	lock: LockDeps;
	log: Log;
	node: string;
	timers: Timers;
}
export function makeCtx(over: Partial<Ctx> & Pick<Ctx, "slot" | "version" | "cli" | "by">): Ctx {
	const now = over.now ?? Date.now, alive = over.alive ?? pidAlive, start = over.startOf ?? startOf;
	const sleep = over.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const log = over.log ?? createLog(fileOf(over.slot, "log"), { now });
	return {
		env: process.env, platform: process.platform, node: process.execPath, spawn: spawnDetached, timers: timersFor(over.platform),
		kill: (pid, signal) => void process.kill(pid, signal),
		// This process holds the locks it takes: it is alive however the liveness check is replaced.
		lock: { now, alive: (pid) => pid === process.pid || alive(pid), startOf: start, sleep, note: (event, fields) => log.line(event, fields) },
		...over, now, sleep, alive, startOf: start, log,
	};
}

export interface Probe {
	record: ServerRecord | undefined;
	/** The process of the record runs, started when the record says, and answers hello. */
	live: boolean;
	hello: Reply | undefined;
}
/** Whether the process that wrote the record still runs: its pid is alive and started when the record says (a pid reused after a crash started later). */
export function runsAs(ctx: Pick<Ctx, "alive" | "startOf">, record: Pick<ServerRecord, "pid" | "started">): boolean {
	if (!ctx.alive(record.pid)) return false;
	if (!record.started) return true;
	const now = ctx.startOf(record.pid);
	return now === undefined || now === record.started;
}
/** A server counts as live when its PID is alive, started at the recorded time, and answers hello on the control socket within 2 s: a PID alone is not enough. */
export async function probe(ctx: Ctx): Promise<Probe> {
	const record = readRecord(ctx.slot);
	// A record with no socket is a start that has not got far enough to listen (`markStarting`): there is nothing to ask.
	if (!record || !record.socket || !runsAs(ctx, record)) return { record, live: false, hello: undefined };
	const hello = await helloOf(record.socket, record.secret, HELLO_MS);
	return { record, live: Boolean(hello && hello.pid === record.pid), hello };
}

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
 * and its broker scope and transport are the record's (or there is no record). A live server on an older version than the session's is upgraded.
 */
export function decide(ctx: Pick<Ctx, "version" | "env" | "platform" | "now" | "slot">, seen: Pick<Probe, "record" | "live">): Verdict {
	const { record, live } = seen;
	if (record && record.herdr !== ctx.slot.herdr) return { do: "refuse", why: "herdr", text: `the sb server record in ${ctx.slot.dir} names another Herdr socket (${record.herdr}), not ${ctx.slot.herdr}` };
	if (record && !sameBroker(record.intercom, intercomOf(ctx.env, ctx.platform))) return { do: "refuse", why: "scope", text: "the sb server runs in another pi-intercom scope or transport than this session, so this session uses none" };
	if (live) return record && newer(ctx.version, record.version) ? { do: "upgrade" } : { do: "nothing", why: "live" };
	if (record?.stopped) return { do: "nothing", why: "stopped" };
	if (restartingFresh(record, ctx.now())) return { do: "nothing", why: "restarting" };
	if (record && newer(record.version, ctx.version)) return { do: "refuse", why: "older", text: `the sb server is down and its record is from pi-straw-boss ${record.version}, newer than this session's ${ctx.version}; a session on an older package never starts a server` };
	return { do: "start" };
}

const specOf = (ctx: Ctx): SpawnSpec => ({ command: ctx.node, args: [ctx.cli, "run", "--detached", "--by", ctx.by], env: serverEnv(ctx.env), cwd: ctx.slot.dir, options: SPAWN_OPTIONS });

/** The server a restart replaces: its record is the one the requester keeps fresh until the new server writes its own. */
export interface Replaced { pid: number; secret: string }
/**
 * Waits until a new server (not `old`) answers hello and is ready, touching `restarting.since` while it waits (`keeps`: the record whose `restarting` it touches, `old` by default),
 * or the child exits, or `ms` pass.
 */
export async function waitReady(ctx: Ctx, ms: number, { old, keeps = old, exited, began }: { old?: Replaced; keeps?: Replaced; exited?: Promise<number | null>; began?: string } = {}): Promise<ServerRecord | { exit: number | null } | undefined> {
	const end = ctx.now() + ms;
	let gone: number | null | undefined, touched = ctx.now();
	void exited?.then((code) => (gone = code));
	for (;;) {
		const found = await probe(ctx);
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
function failed(ctx: Ctx, outcome: { exit: number | null } | undefined): ServerError {
	const startError = readStartError(ctx.slot);
	const why = startError ? `${startError.code}: ${startError.text}` : outcome ? `the server exited with code ${outcome.exit} before it answered (see ${fileOf(ctx.slot, "log")})` : `the server did not answer hello within ${ctx.timers.start / 1000} s (see ${fileOf(ctx.slot, "log")})`;
	return new ServerError("start-failed", why, startError);
}

/**
 * Starts a detached server from this package and waits for it. The caller holds `server.lock`. `start-error.json` of an earlier attempt is deleted first. A start that is not a
 * restart (`began` is the restart's) writes `restarting` before it spawns anything and keeps it fresh until the server answers or the start fails, so a cold start is never taken for a
 * server that is gone.
 */
export async function launch(ctx: Ctx, { began, old }: { began?: string; old?: Replaced } = {}): Promise<ServerRecord> {
	clearStartError(ctx.slot);
	const t0 = ctx.now();
	let keeps = old, mine: { began: string; expect: Replaced } | undefined;
	if (!began) {
		const marked = markStarting(ctx.slot, ctx.now(), { pid: process.pid, version: ctx.version, desk: ctx.env.STRAW_BOSS_DESK === "1", intercom: intercomOf(ctx.env, ctx.platform), mode: "detached", by: ctx.by });
		mine = { began: marked.began, expect: marked.expect };
		keeps = marked.expect;
	}
	const child = ctx.spawn(specOf(ctx));
	if (mine && child.pid !== undefined) {
		mine.expect = adoptStarting(ctx.slot, mine.expect, child.pid);
		keeps = mine.expect;
	}
	ctx.log.line("start-requested", { by: ctx.by, version: ctx.version, pid: child.pid, spawnMs: ctx.now() - t0 });
	const outcome = await waitReady(ctx, ctx.timers.start, { exited: child.exited, began: began ?? mine?.began, old, keeps });
	if (outcome && "pid" in outcome) {
		ctx.log.line("start-answered", { pid: outcome.pid, ms: ctx.now() - t0 });
		// A server that was live all along answered (the look missed its hello, and the child found it and left): it does not clear the mark this start put on its record, so this start does.
		if (mine && outcome.pid !== child.pid) endStarting(ctx.slot, mine.began, mine.expect);
		return outcome;
	}
	if (mine) endStarting(ctx.slot, mine.began, mine.expect);
	ctx.log.line("start-unanswered", { ms: ctx.now() - t0, exit: outcome ? String(outcome.exit) : "none" });
	throw failed(ctx, outcome);
}

const lockFor = (ctx: Ctx, waitMs: number) => takeLock(ctx.slot, ctx.by, ctx.lock, waitMs).catch((error) => {
	throw new ServerError("busy", (error as Error).message);
});

export interface Ensured { server: "found" | "started"; record: ServerRecord }
/**
 * Makes sure a server runs, for a session's look and for `up`: under `server.lock`, it looks again and starts one when `decide` says to. `boss`: the boss's own start
 * (`up`), which clears `stopped` first; a start that no one asked for leaves a stopped server alone.
 */
export async function ensure(ctx: Ctx, { boss = false, lockWaitMs = 0 }: { boss?: boolean; lockWaitMs?: number } = {}): Promise<Ensured | { skipped: Verdict }> {
	const lock = await lockFor(ctx, lockWaitMs);
	try {
		let seen = await probe(ctx);
		if (boss && seen.record?.stopped && !seen.live && clearStopped(ctx.slot)) seen = { ...seen, record: readRecord(ctx.slot) };
		const verdict = decide(ctx, seen);
		if (verdict.do === "nothing" && verdict.why === "live") return { server: "found", record: seen.record! };
		if (verdict.do !== "start") return { skipped: verdict };
		return { server: "started", record: await launch(ctx) };
	} finally {
		lock.release();
	}
}

/** Asks the live server to restart, touches `restarting.since` while it goes, and waits for it to exit. The caller holds `server.lock`. Returns the `began` of the restart. */
async function retire(ctx: Ctx, old: ServerRecord, reason: string, counts: boolean): Promise<string> {
	let reply: Reply | undefined;
	try {
		// `counts`: whether this restart is one the once-a-minute limit counts (an agent's, the boss's, a shell's; not an upgrade or a serve takeover).
		reply = (await callControl(old.socket, old.secret, { cmd: "restart", reason, by: ctx.by, counts }, 5000)).reply;
	} catch (error) {
		throw new ServerError("unreachable", `the sb server did not take the restart: ${(error as Error).message}`);
	}
	if (!reply?.ok) throw new ServerError(reply?.error === "restarting" ? "restarting" : "unreachable", `the sb server refused the restart: ${String(reply?.error ?? "no answer")}`);
	const began = readRecord(ctx.slot)?.restarting?.began ?? new Date(ctx.now()).toISOString();
	const end = ctx.now() + ctx.timers.exit;
	let touched = ctx.now(), termed = false;
	while (ctx.alive(old.pid)) {
		if (ctx.now() - touched >= ctx.timers.touch) {
			touched = ctx.now();
			touchRestarting(ctx.slot, ctx.now(), began, old);
		}
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
export async function restart(ctx: Ctx, { reason, downgrade = false, upgrade = false, lockWaitMs = lockWaitFor(ctx), boss = false, limit = false, counts = !upgrade }: RestartOptions): Promise<Restarted> {
	let lock = await lockFor(ctx, lockWaitMs);
	const hold: Hold = { release: () => lock.release(), retake: async () => void (lock = await lockFor(ctx, ctx.timers.start)) };
	try {
		return await restartLocked(ctx, { reason, downgrade, upgrade, boss, limit, counts }, hold);
	} finally {
		lock.release();
	}
}
/** The restart itself; the caller holds `server.lock`. */
async function restartLocked(ctx: Ctx, { reason, downgrade, upgrade, boss, limit, counts }: Required<Omit<RestartOptions, "lockWaitMs">>, hold: Hold): Promise<Restarted> {
	const seen = await probe(ctx), record = seen.record;
	if (record && record.herdr !== ctx.slot.herdr) throw new ServerError("herdr", `the sb server record names another Herdr socket (${record.herdr}), not ${ctx.slot.herdr}`);
	// The server runs in the broker scope it was started in, and a requester in another one would move it there: it uses none, and restarts none.
	if (record && !sameBroker(record.intercom, intercomOf(ctx.env, ctx.platform))) throw new ServerError("scope", "the sb server runs in another pi-intercom scope or transport than this process, so this process does not restart it");
	if (record?.stopped && !seen.live && !boss) throw new ServerError("stopped", "the sb server was stopped on purpose; /boss server or `cli.mjs up` starts it again");
	if (record && newer(record.version, ctx.version) && !downgrade) throw new ServerError("older", `the sb server runs pi-straw-boss ${record.version}, newer than this package's ${ctx.version}; a restart from an older package needs --downgrade`);
	if (boss) clearStopped(ctx.slot);
	const done = (found: ServerRecord): Restarted => ({ server: upgrade ? "upgraded" : "restarted", record: found });
	const old = record && { pid: record.pid, secret: record.secret };
	// A server that is down starts, whatever the limit says. A `serve` server down with a fresh `restarting` is between two lives of a supervisor, which another requester is
	// waiting on: this one waits for that serve as well, and launches a detached server only when none came.
	if (!seen.live || !record) {
		if (record?.mode === "serve" && restartingFresh(record, ctx.now())) {
			const back = await supervised(ctx, hold, old!, undefined);
			if (back) return done(back);
		}
		return { server: "started", record: await launch(ctx) };
	}
	if (limit && !boss && record.lastRestart) {
		const last = Date.parse(record.lastRestart.at);
		if (Number.isFinite(last) && ctx.now() - last < RESTART_EVERY_MS) throw new ServerError("rate", `The sb server was restarted ${Math.round((ctx.now() - last) / 1000)} s ago (${record.lastRestart.reason}, by ${record.lastRestart.by}); restarts are taken once a minute at most.`);
	}
	const began = await retire(ctx, record, reason, counts);
	if (record.mode === "serve") {
		const back = await supervised(ctx, hold, old!, began);
		if (back) return done(back);
	}
	return { server: upgrade ? "upgraded" : "restarted", record: await launch(ctx, { began, old }) };
}
/**
 * A supervisor starts a `serve` server again (it exited with the code it restarts on), and that `serve` takes `server.lock` to run: the requester lets go of the lock for the
 * wait, keeps `restarting` fresh (`began` is the restart it asked for; a requester that only waits touches nothing), and takes the lock again only to start a server itself when
 * none came. Gives the server that came, or undefined with the lock held again.
 */
async function supervised(ctx: Ctx, hold: Hold, old: Replaced, began: string | undefined): Promise<ServerRecord | undefined> {
	hold.release();
	const back = await waitReady(ctx, ctx.timers.supervisor, { old, began });
	if (back && "pid" in back) return back;
	try {
		await hold.retake();
	} catch (error) {
		// A `serve` that took the lock holds it while it starts, and may hold it past the budget: the restart has worked if the server it starts answers.
		if (!(error instanceof ServerError && error.code === "busy")) throw error;
		const started = await waitReady(ctx, ctx.timers.start, { old });
		if (started && "pid" in started) return started;
		throw error;
	}
	const again = await probe(ctx);
	if (again.live && again.record && again.record.pid !== old.pid) {
		// A `serve` that took the lock in the gap is starting: wait for it as for any new server.
		const started = await waitReady(ctx, ctx.timers.start, { old, began });
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
	const lock = await lockFor(ctx, lockWaitFor(ctx));
	const locked = ctx.now();
	try {
		const seen = await probe(ctx);
		const probed = ctx.now();
		// As for a restart: the server runs in the broker scope it was started in, and a stop from another one is not its requester's to give.
		if (seen.record && !sameBroker(seen.record.intercom, intercomOf(ctx.env, ctx.platform))) throw new ServerError("scope", "the sb server runs in another pi-intercom scope or transport than this process, so this process does not stop it");
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

/** The state of the server for a shell, from the files and a hello (docs/specs/2026-10-26-sb-backend.md, States for a shell). */
export type State = "live" | "restarting" | "stopped" | "gone";
export function stateOf(ctx: Pick<Ctx, "now">, seen: Pick<Probe, "record" | "live">): State {
	const { record, live } = seen;
	if (!record) return "gone";
	if (record.stopped) return "stopped";
	if (restartingFresh(record, ctx.now())) return "restarting";
	return live ? "live" : "gone";
}

/**
 * What `cli.mjs status` prints and `boss_server status` answers: the state, the record's facts a shell may read (never the secret or the socket), the live server's own account
 * of its work, and, for a server that is gone, the start-error of the last attempt. Works with the server down, from the files.
 */
export async function describe(ctx: Ctx): Promise<Record<string, unknown>> {
	const seen = await probe(ctx), record = seen.record, state = stateOf(ctx, seen), startError = readStartError(ctx.slot);
	let more: Record<string, unknown> = { towers: [], link: null };
	if (seen.live && record) {
		try {
			const { reply } = await callControl(record.socket, record.secret, { cmd: "status" }, 3000);
			if (reply?.ok) more = { uptimeMs: reply.uptimeMs, towers: reply.towers ?? [], link: reply.link ?? null };
		} catch { /* the server went while it was asked */ }
	}
	return {
		state, package: ctx.version, primary: ctx.slot.primary, herdr: ctx.slot.herdr, log: fileOf(ctx.slot, "log"),
		...(record ? {
			pid: record.pid, ...(record.started ? { started: record.started } : {}), version: record.version, mode: record.mode, desk: record.desk,
			...(record.stopped ? { stopped: true } : {}), ...(record.restarting ? { restarting: record.restarting } : {}), ...(record.lastError ? { lastError: record.lastError } : {}),
			...(record.lastRestart ? { lastRestart: record.lastRestart } : {}), ...(record.gui ? { gui: record.gui, url: guiUrl(record) } : {}),
		} : {}),
		...(state === "gone" && startError ? { startError } : {}), ...more,
	};
}
/** The GUI's URL, once the server hosts the GUI (B2); null while the pi sessions do. */
export const guiUrl = (record: ServerRecord | undefined) => (record?.gui ? `http://127.0.0.1:${record.gui.port}/${record.gui.token}/` : null);
