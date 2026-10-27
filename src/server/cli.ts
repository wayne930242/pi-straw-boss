import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stateDirOf } from "../agent/paths.ts";
import { answers as pageAnswers } from "../handover.ts";
import { newer } from "../semver.ts";
import {
	type Ctx, unreachableText, describe, ensure, guiUrl, herdrListens, isIdentity, detachWarning, lockFor, lockWaitFor, makeCtx, passGate, probe, restart, ServerError, serverEnv, stop, takeOver, trusted, type Wait, waitReady, within,
} from "./client.ts";
import { ACL_TOKEN } from "./acl.ts";
import { callControl, ControlError } from "./socket.ts";
import { logSize, readFrom, tailLog } from "./log.ts";
import { clearStartError, clearStopped, fileOf, readRecord, readStartError, type ServerRecord, slotOf, type StartError } from "./record.ts";
import type { ServerHandle, ServerOptions } from "./main.ts";
import { VERSION } from "./version.ts";

// `cli.mjs` is what shells, supervisors, and the server's own start run (docs/specs/2026-10-26-sb-backend.md, Process model and lifecycle): `up`, `serve`, `stop`, `status`,
// `restart`, `logs`, and the internal `run --detached` that every detached start spawns. Exit codes: 0 done; 1 a step failed (one JSON line on stderr); 2 usage; 3 the server
// cannot run (`start-error.json` says `loader`, `intercom`, or `acl`); 4 `serve` found a live `serve` server; 5 `stop` found a `serve` server (stop its supervisor).

const USAGE = `usage: cli.mjs up [--timeout SECONDS] [--exact]
       cli.mjs serve
       cli.mjs stop | status
       cli.mjs restart [--reason TEXT] [--by TEXT] [--downgrade]
       cli.mjs logs [--lines N] [--follow]`;
export class UsageError extends Error {}
const FLAGS: Record<string, { value: string[]; switch: string[] }> = {
	up: { value: ["timeout"], switch: ["exact"] }, serve: { value: [], switch: [] }, stop: { value: [], switch: [] }, status: { value: [], switch: [] },
	restart: { value: ["reason", "by"], switch: ["downgrade"] }, logs: { value: ["lines"], switch: ["follow"] }, run: { value: ["by", "detach", "detach-reason", "acl-token"], switch: ["detached"] },
};
export interface Args { command: string; flags: Record<string, string | true> }
export function parseArgs(argv: string[]): Args {
	const [command, ...rest] = argv;
	if (!command) throw new UsageError(USAGE);
	const allowed = FLAGS[command];
	if (!allowed) throw new UsageError(`unknown command ${command}\n${USAGE}`);
	const flags: Record<string, string | true> = {};
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i]!.replace(/^--/, "");
		if (!rest[i]!.startsWith("--")) throw new UsageError(`unexpected argument ${rest[i]}\n${USAGE}`);
		if (flag === "dir" || flag === "label") throw new UsageError(`--${flag} belongs to the desk steps of up, which come with a later step of the sb server (B7); this build's up only makes sure the server runs`);
		if (allowed.switch.includes(flag)) flags[flag] = true;
		else if (allowed.value.includes(flag)) {
			if (rest[i + 1] === undefined || rest[i + 1]!.startsWith("--")) throw new UsageError(`--${flag} needs a value`);
			flags[flag] = rest[++i]!;
		} else throw new UsageError(`unknown option ${rest[i]}\n${USAGE}`);
	}
	if (flags.timeout !== undefined && !(Number(flags.timeout) > 0)) throw new UsageError("--timeout is a number of seconds");
	if (flags.lines !== undefined && !(Number.isInteger(Number(flags.lines)) && Number(flags.lines) > 0)) throw new UsageError("--lines is a positive whole number");
	return { command, flags };
}

export interface CliDeps {
	env?: NodeJS.ProcessEnv;
	/** Replaces the context requesters work in (clock, spawn, liveness); the slot and package are filled in. */
	ctx?: Partial<Ctx>;
	stateDir?: string;
	version?: string;
	cli?: string; // the file the server is started from; this file by default
	out?: (text: string) => void;
	err?: (text: string) => void;
	/** The server process itself, which `run` and `serve` start in this process. */
	server?: (options: ServerOptions) => Promise<ServerHandle>;
	signal?: AbortSignal; // ends a `logs --follow`
	/** Where the server in this process hears that it is asked to end (SIGTERM, SIGINT, SIGHUP); a kill or a reboot is not a stop, so it only leaves. */
	signals?: (leave: () => void) => void;
	herdrListens?: (ctx: Ctx, ms?: number) => Promise<boolean>;
	/** Whether the GUI's page answers 200, which `up` waits for. */
	pageAnswers?: (gui: { port: number; token: string }) => Promise<boolean>;
}

interface Step { name: string; ok: boolean; ms: number; detail?: string }
interface Warning { code: string; text: string }
class StepError extends Error {
	step: string;
	exit: number;
	/** Why a start failed, when a start did (`start-error.json`'s shape): also when the failure left no file, as when the state folder could not be protected. */
	startError: StartError | undefined;
	/** The wait that ran out, when one did (`lock`, `start`, `hello`, `exit`): the JSON on stderr names it beside `step`. */
	wait: Wait | undefined;
	constructor(step: string, message: string, exit = 1, wait?: Wait, startError?: StartError) {
		super(message);
		this.step = step;
		this.exit = exit;
		this.wait = wait;
		this.startError = startError;
	}
}
/** How long `up` may take in all (the lock wait and the start wait together): the start wait of the platform and the lock wait of a start under way ahead of it (60 + 30 s on Windows, 20 + 10 s elsewhere). */
export const UP_SECONDS = { win32: 90, other: 30 } as const;
const CANNOT_RUN = new Set(["acl", "loader", "intercom"]);

/** Runs one command; resolves with its exit code. */
export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
	const env = deps.env ?? process.env, out = deps.out ?? ((text) => void process.stdout.write(text)), err = deps.err ?? ((text) => void process.stderr.write(text));
	let args: Args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		err(`${error.message}\n`);
		return 2;
	}
	const { command, flags } = args;
	if (command === "run" && flags["acl-token"] !== undefined && !ACL_TOKEN.test(String(flags["acl-token"]))) {
		err(`--acl-token is 32 hex digits\n${USAGE}\n`);
		return 2;
	}
	if (command === "run" && flags.detach !== undefined && flags.detach !== "wmi" && flags.detach !== "wmi-in-job" && flags.detach !== "direct") {
		err(`--detach is wmi, wmi-in-job, or direct\n${USAGE}\n`);
		return 2;
	}
	const slot = slotOf(deps.stateDir ?? stateDirOf(env), env);
	const version = deps.version ?? VERSION;
	// `restart --by` is how the GUI's Restart button names itself (the server starts this CLI as the requester of its own restart).
	const by = command === "run" ? String(flags.by ?? "detached start") : command === "restart" && typeof flags.by === "string" ? flags.by.replace(/[\r\n]+/g, " ").slice(0, 120) : `cli ${command}`;
	const ctx = makeCtx({ env, slot, version, cli: deps.cli ?? selfPath(), by, ...deps.ctx });
	const json = (value: unknown) => out(`${JSON.stringify(value)}\n`);
	const server = deps.server ?? (async (options) => (await loadMain()).runServer(options));

	try {
		switch (command) {
			case "status": return await status();
			case "logs": return await logs();
			case "stop": return await stopCommand();
			case "restart": return await restartCommand();
			case "up": return await up();
			case "serve": return await serve();
			case "run": return await runDetached();
		}
	} catch (error) {
		if (error instanceof ServerError) return fail(error);
		if (error instanceof UsageError) return (err(`${error.message}\n`), 2);
		throw error;
	}
	return 2;

	function fail(error: ServerError) {
		err(`${error.message}\n`);
		return error.startError && CANNOT_RUN.has(error.startError.code) ? 3 : 1;
	}

	async function status() {
		json(await describe(ctx));
		return 0;
	}

	/** The folder's `start-error.json`, read once the folder is judged; nothing where it cannot be judged. */
	async function filed(): Promise<StartError | undefined> {
		if (!existsSync(fileOf(slot, "startError"))) return undefined;
		try {
			await passGate(ctx);
		} catch {
			return undefined;
		}
		return readStartError(slot);
	}

	async function logs() {
		const file = fileOf(slot, "log"), lines = Number(flags.lines ?? 200);
		// The log (and the rotated ones) are files of the folder: read only once the folder is judged, which is once it exists, not once server.log does (b1f-F004, R2-F001).
		let gated = false;
		const gate = async () => {
			if (gated || !existsSync(slot.dir)) return;
			await passGate(ctx);
			gated = true;
		};
		await gate();
		if (gated) for (const line of tailLog(file, lines)) out(`${line}\n`);
		if (!flags.follow) return 0;
		let at = gated ? logSize(file) : 0;
		while (!deps.signal?.aborted) {
			await ctx.sleep(500);
			await gate();
			if (!gated) continue;
			const more = readFrom(file, at);
			at = more.size;
			if (more.text) out(more.text);
		}
		return 0;
	}

	async function stopCommand() {
		// A shell quitting has nobody to ask, so the warning goes on stderr and the stop goes on.
		err("Stopping the sb server on purpose: every workspace loses its live tower, and mains are demoted 15 s later.\n");
		try {
			json(await stop(ctx));
			return 0;
		} catch (error) {
			if (error instanceof ServerError && error.code === "serve") return (err(`${error.message}\n`), 5);
			throw error;
		}
	}

	async function restartCommand() {
		const reason = String(flags.reason ?? "restart from the command line");
		if (!reason.trim() || reason.length > 200 || /[\r\n]/.test(reason)) throw new UsageError("--reason is one line of 1 to 200 characters");
		const done = await restart(ctx, { reason, downgrade: flags.downgrade === true });
		json({ server: done.server, pid: done.record.pid, version: done.record.version, url: guiUrl(done.record) });
		return 0;
	}

	async function up() {
		// One time limit for the whole call: the lock wait, the start wait, and the wait for another's start together (the start wait itself is the platform's, 60 s on Windows and 20 s elsewhere, within it).
		const steps: Step[] = [], warnings: Warning[] = [], timeoutMs = Number(flags.timeout ?? UP_SECONDS[ctx.platform === "win32" ? "win32" : "other"]) * 1000, deadline = ctx.now() + timeoutMs, desk = env.STRAW_BOSS_DESK === "1";
		const stepOf = async <T>(name: string, body: () => Promise<{ value: T; detail?: string }>): Promise<T> => {
			const began = ctx.now();
			try {
				const { value, detail } = await body();
				steps.push({ name, ok: true, ms: ctx.now() - began, ...(detail ? { detail } : {}) });
				return value;
			} catch (error) {
				steps.push({ name, ok: false, ms: ctx.now() - began });
				throw error instanceof StepError ? error : new StepError(name, (error as Error).message, error instanceof ServerError && error.startError && CANNOT_RUN.has(error.startError.code) ? 3 : 1, error instanceof ServerError ? error.wait : undefined, error instanceof ServerError ? error.startError : undefined);
			}
		};
		try {
			await stepOf("herdr", async () => {
				if (!(await (deps.herdrListens ?? herdrListens)(ctx, within(ctx, deadline, 2000)))) throw new StepError("herdr", `no Herdr server answers at ${slot.herdr}`);
				// The folder's owner is judged before its record is read (R13-F003).
				const found = await trusted(ctx, deadline);
				if (found && found.herdr !== slot.herdr) throw new StepError("herdr", `the record in ${slot.dir} serves ${found.herdr}, not ${slot.herdr}`);
				return { value: undefined };
			});
			const plan = await stepOf("version", async () => {
				const seen = await probe(ctx, deadline), record = seen.record;
				if (seen.denied && record) {
					warnings.push({ code: "server_unreachable", text: unreachableText(record) });
					return { value: "ensure" as const, detail: "a server runs and refused this process" };
				}
				if (!seen.live || !record) return { value: "ensure" as const, detail: "no server runs" };
				if (newer(version, record.version)) return { value: "upgrade" as const, detail: `server ${record.version}, package ${version}` };
				if (newer(record.version, version)) {
					if (flags.exact) throw new StepError("version", `the server runs ${record.version}, newer than this package's ${version}, and --exact was given`);
					warnings.push({ code: "server_newer", text: `the server runs ${record.version}, this package is ${version}` });
				}
				if (desk && !record.desk) return { value: "desk" as const, detail: "the server runs without the desk switch" };
				if (!desk && record.desk) warnings.push({ code: "desk_on", text: "the server runs with the desk switch (STRAW_BOSS_DESK=1)" });
				return { value: "ensure" as const };
			});
			const { server: how, record } = await stepOf<{ server: "found" | "started" | "restarted" | "upgraded"; record: ServerRecord }>("server", async () => {
				if (plan === "upgrade" || plan === "desk") {
					const done = await restart(ctx, { reason: plan === "upgrade" ? "upgrade" : "desk switch", upgrade: plan === "upgrade", boss: true, deadline, counts: false });
					return { value: { server: done.server, record: done.record }, detail: `${done.server}: ${plan === "upgrade" ? "upgrade" : "desk switch"}` };
				}
				const done = await ensure(ctx, { boss: true, deadline });
				if ("record" in done) return { value: { server: done.server, record: done.record } };
				if (done.skipped.do === "nothing") {
					// A start or restart is under way (its requester held the lock): wait for it.
					const ready = await waitReady(ctx, Math.max(0, deadline - ctx.now()));
					if (ready && "pid" in ready) return { value: { server: "found" as const, record: ready } };
					throw new StepError("server", "a start of the server is under way and did not finish in time", 1, "hello");
				}
				throw new StepError("server", done.skipped.do === "refuse" ? done.skipped.text : "the server was not started");
			});
			const loud = detachWarning(record);
			if (loud) warnings.push({ code: "breakaway_failed", text: loud });
			const url = await stepOf("gui", async () => ({ value: await guiStep(record, warnings, deadline) }));
			json({
				url, pid: record.pid, started: record.started, version: record.version, package: version, mode: record.mode, desk: record.desk, server: how, log: record.log, steps, warnings,
			});
			return 0;
		} catch (error) {
			if (!(error instanceof StepError)) throw error;
			// A refusal of the folder (`acl`) is the reason; the folder's own `start-error.json` is not read then, and is read otherwise only once the folder is judged (b1f-F004).
			const startError = error.startError?.code === "acl" ? error.startError : (await filed()) ?? error.startError;
			err(`${JSON.stringify({ step: error.step, ...(error.wait ? { wait: error.wait } : {}), reason: error.message, steps, warnings, log: fileOf(slot, "log"), ...(startError ? { startError } : {}) })}\n`);
			return error.exit;
		}
	}

	/**
	 * The GUI of the server: `up` is the boss's own start, so it starts a GUI that was stopped on purpose, then waits for the URL to answer 200. The URL comes from the server's own answer
	 * (it knows the port it bound); a server that cannot be asked (it refused this process) has the one its record names.
	 */
	async function guiStep(record: ServerRecord, warnings: Warning[], deadline: number): Promise<string> {
		let reply: Awaited<ReturnType<typeof callControl>>["reply"];
		try {
			reply = (await callControl(record.socket, record.secret, { cmd: "gui", boss: true }, within(ctx, deadline, 15_000))).reply;
		} catch (error) {
			const known = guiUrl(readRecord(slot));
			if (known && error instanceof ControlError && error.failure === "denied") return known;
			throw new StepError("gui", `the server did not take the request for its GUI: ${(error as Error).message}`);
		}
		if (!reply?.ok) {
			const last = readRecord(slot)?.lastError, tail = tailLog(fileOf(slot, "log"), 20);
			throw new StepError("gui", `the GUI did not start: ${String(reply?.error ?? "no answer")}${last ? ` (${last.code}: ${last.text})` : ""}\n${tail.join("\n")}`);
		}
		// SAFETY: a reply with ok set and no error is the server's answer to gui-start, which carries the port and token.
		const { port, token } = reply as unknown as { port: number; token: string };
		for (;;) {
			if (await (deps.pageAnswers ?? ((gui) => pageAnswers(gui as Parameters<typeof pageAnswers>[0])))({ port, token })) break;
			if (ctx.now() >= deadline) throw new StepError("gui", `the GUI's URL did not answer within the time given`, 1, "start");
			await ctx.sleep(100);
		}
		if (typeof reply.remoteNote === "string") warnings.push({ code: "remote_off", text: reply.remoteNote });
		return String(reply.url);
	}

	async function serve() {
		const lock = await lockFor(ctx, lockWaitFor(ctx));
		let released = false;
		const release = () => { if (!released) { released = true; lock.release(); } };
		try {
			const seen = await probe(ctx);
			if (seen.live && seen.record) {
				if (seen.record.mode === "serve") {
					release();
					err(`${JSON.stringify({ error: "a serve server already runs", pid: seen.record.pid, version: seen.record.version, log: seen.record.log })}\n`);
					return 4;
				}
				// A live detached server hands over by the restart path, and this process runs in the foreground in its place: exiting instead would make a supervisor
				// start it again and again while the server that runs is one no supervisor watches.
				await takeOver(ctx, seen.record);
			}
			// A supervisor's start is the infra's explicit choice, and a stop is never left on a `serve` server, so a `stopped` found here is an earlier detached server's.
			clearStopped(slot, true); // the server's stop only: a GUI stopped on purpose stays so
			clearStartError(slot);
			scrubIdentity();
			const handle = await server({ slot, env: serverEnv(env), mode: "serve", by: ctx.by, version });
			const code = await foreground(handle, release);
			return code;
		} finally {
			release();
		}
	}

	async function runDetached() {
		if (flags.detached !== true) throw new UsageError("run is the server's own start: use `up`, or `serve` in the foreground");
		scrubIdentity();
		const via = flags.detach === "wmi" ? "wmi" as const : flags.detach === "wmi-in-job" ? "wmi-in-job" as const : flags.detach === "direct" ? "direct" as const : undefined;
		const detach = via ? { via, ...(typeof flags["detach-reason"] === "string" ? { failure: flags["detach-reason"] } : {}) } : undefined;
		const aclToken = typeof flags["acl-token"] === "string" ? flags["acl-token"] : undefined;
		const handle = await server({ slot, env: serverEnv(env), mode: "detached", by: ctx.by, version, ...(detach ? { detach } : {}), ...(aclToken ? { aclToken } : {}) });
		return foreground(handle, () => {});
	}
	/** The server in this process: signals end it without marking a stop (a kill or a reboot is not a stop), and the exit code is its own. */
	async function foreground(handle: ServerHandle, ready: () => void) {
		(deps.signals ?? ((leave) => (["SIGTERM", "SIGINT", "SIGHUP"] as const).forEach((signal) => process.once(signal, leave))))(() => void handle.shutdown(0).catch(() => {}));
		void handle.ready.then(ready);
		return handle.done;
	}
	/** What the starter's shell may have set and the server must not carry: its intercom identity, so the broker client registers the server's own. */
	function scrubIdentity() {
		for (const key of Object.keys(env)) if (isIdentity(key)) delete env[key];
	}
}

let main: Promise<typeof import("./main.ts")> | undefined;
// SAFETY: main.mjs sits beside cli.mjs in dist/server (main.ts beside cli.ts in a checkout) and exports what main.ts does.
const loadMain = () => (main ??= import(new URL(import.meta.url.endsWith(".ts") ? "./main.ts" : "./main.mjs", import.meta.url).href) as Promise<typeof import("./main.ts")>);
const selfPath = () => fileURLToPath(import.meta.url.split("?")[0]!);

// Run as a script (the path to this file may reach it through a symlink).
const realpath = (path: string) => { try { return realpathSync(path); } catch { return path; } };
if (process.argv[1] && realpath(selfPath()) === realpath(process.argv[1])) {
	// On Windows the reads this process waits on (a PowerShell child for a start time) are unref'd so that pi may leave with one pending, and a process that only waits on them
	// runs out of work and ends with its top-level await unsettled (exit 13, seen in the VM). A timer that is not unref'd holds it until `run` has an answer; `process.exit` ends it.
	setInterval(() => {}, 2 ** 30);
	const code = await run(process.argv.slice(2));
	await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
	process.exit(code);
}
