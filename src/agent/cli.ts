import { spawn as spawnProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, statSync, truncateSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentFiles, ask, findIntercom, holder, NoSidecar, readHeld, type Reply, socketOf, stateDirOf, tsxLoader } from "./paths.ts";
import { startSidecar } from "./sidecar.ts";

// `cli.ts` is what straw-boss runs: `join` at a session's start (it starts the sidecar of the pane, detached), and the commands of straw-net.py, each of which
// sends one request to the sidecar of this pane over its socket and prints the answer. Exit codes: 0 ok, 1 refused or failed or not answered in time (the reason on
// stderr), 2 a usage error, or no sidecar for this pane.

export class UsageError extends Error {}
/** How long a command waits for the sidecar's answer, in ms. `call-tower` may have to open a tower tab first, which takes up to a minute and a half. */
export const ASK_MS: Record<string, number> = { default: 60_000, "call-tower": 120_000 };
const USAGE = `usage: cli.ts join --pane P --kind claude|codex --session S [--record FILE] [--cli straw-net.py]
       cli.ts status | promote | stop [--pane P]
       cli.ts call-tower --message M [--workspace W] [--pane P]
       cli.ts broadcast --message M [--scope tab|workspace|towers|all] [--pane P]
       cli.ts send --to ID --message M [--pane P]
       cli.ts rename --name N [--pane P]`;
const NEEDS: Record<string, string[]> = { join: ["kind", "session"], serve: ["kind", "session"], status: [], promote: [], stop: [], "call-tower": ["message"], broadcast: ["message"], send: ["to", "message"], rename: ["name"] };
const FLAGS = ["pane", "kind", "session", "record", "cli", "message", "workspace", "scope", "to", "name"];

export type Args = { command: string; pane: string } & Partial<Record<string, string>>;
/** The command line as options. The pane is `--pane`, else the one the process runs in (HERDR_PANE_ID). */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): Args {
	const [command, ...rest] = argv;
	if (!command) throw new UsageError(USAGE);
	if (!Object.hasOwn(NEEDS, command)) throw new UsageError(`unknown command ${command}\n${USAGE}`);
	const given: Record<string, string> = {};
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i]!.replace(/^--/, "");
		if (!rest[i]!.startsWith("--") || !FLAGS.includes(flag)) throw new UsageError(`unknown option ${rest[i]}`);
		if (rest[i + 1] === undefined) throw new UsageError(`--${flag} needs a value`);
		given[flag] = rest[i + 1]!;
	}
	const pane = given.pane ?? env.HERDR_PANE_ID;
	if (!pane) throw new UsageError("--pane or HERDR_PANE_ID is required");
	for (const need of NEEDS[command]!) {
		if (!given[need]) throw new UsageError(`--${need} is required`);
	}
	if (given.kind && given.kind !== "claude" && given.kind !== "codex") throw new UsageError("--kind must be claude or codex");
	if (given.scope && !["tab", "workspace", "towers", "all"].includes(given.scope)) throw new UsageError("--scope must be tab, workspace, towers, or all");
	const { pane: _pane, ...options } = given;
	const wanted = { join: ["kind", "session", "record", "cli"], serve: ["kind", "session", "record", "cli"], "call-tower": ["message", "workspace"], broadcast: ["message", "scope"], send: ["to", "message"], rename: ["name"] }[command] ?? [];
	return { command, pane, ...Object.fromEntries(wanted.map((key) => [key, options[key]]).filter(([, value]) => value !== undefined)) };
}

/** What `join` runs: the Node that runs this file with the tsx loader (the sidecar is TypeScript under node_modules, which Node alone refuses), the pane in its environment, its output in the pane's log. */
export interface SpawnSpec { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; log: string }
export interface CliDeps {
	env?: NodeJS.ProcessEnv;
	stateDir?: string;
	out?: (text: string) => void;
	err?: (text: string) => void;
	spawn?: (spec: SpawnSpec) => { exited: Promise<number | null> };
	/** The tsx loader; found beside pi-intercom when not given. */
	loader?: string;
	/** How long join waits for the state file, and how long it waits for a sidecar it asked to stop. */
	joinMs?: number;
	stopMs?: number;
	/** How long a command waits for an answer, whatever it is (replaces ASK_MS). */
	askMs?: number;
}
const LOG_MAX = 256 * 1024;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const detached = ({ command, args, env, cwd, log }: SpawnSpec) => {
	try { if (statSync(log).size > LOG_MAX) truncateSync(log); } catch { /* no log yet */ }
	const fd = openSync(log, "a", 0o600);
	const child = spawnProcess(command, args, { detached: true, stdio: ["ignore", fd, fd], env, cwd, windowsHide: true });
	closeSync(fd);
	child.unref();
	return { exited: new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))) };
};
async function until(check: () => boolean | Promise<boolean>, ms: number) {
	for (const end = Date.now() + ms; Date.now() < end; await pause(50)) if (await check()) return true;
	return check();
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<number> {
	const env = deps.env ?? process.env, out = deps.out ?? ((text) => void process.stdout.write(text)), err = deps.err ?? ((text) => void process.stderr.write(text));
	let args: Args;
	try {
		args = parseArgs(argv, env);
	} catch (error) {
		if (!(error instanceof UsageError)) throw error;
		err(`${error.message}\n`);
		return 2;
	}
	const files = agentFiles(deps.stateDir ?? stateDirOf(env), args.pane);
	if (args.command === "serve") return serve(args);
	if (args.command === "join") return join(args);
	const { command, pane: _pane, ...request } = args;
	let reply: Reply;
	try {
		reply = await ask(socketOf(files, readHeld(files)), { cmd: command, ...Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined)) }, deps.askMs ?? ASK_MS[command] ?? ASK_MS.default);
	} catch (error) {
		// Nothing listening is no sidecar. A sidecar that was reached and did not answer in time may still carry the request out: it is not "no sidecar", so a caller does not send it twice.
		if (error instanceof NoSidecar) return (err(`no net sidecar for pane ${args.pane}: it joins when the session starts, if pi-straw-boss and pi-intercom are installed\n`), 2);
		return (err(`${(error as Error).message} (pane ${args.pane}); the request may still be carried out, so check before sending it again\n`), 1);
	}
	if (!reply.ok) return (err(`${reply.error}\n`), 1);
	const { ok: _ok, ...body } = reply;
	out(command === "status" ? `${JSON.stringify(body, null, 2)}\n` : `${reply.text ?? ""}\n`);
	return 0;

	async function join(a: Args) {
		const started = async (session: string) => ((h) => h?.held.session === session && h.state !== "leaving")(await holder(files));
		const old = await holder(files);
		if (old && old.held.session === a.session && old.state !== "leaving") return (out(`already joined as ${old.held.id}\n`), 0);
		if (old) {
			// Another session in the pane (a /clear, or a resume), or this one on its way out: the sidecar of the one before leaves first, so the pane never has two.
			if (old.state !== "leaving") await ask(socketOf(files, old.held), { cmd: "stop" }, 15_000).catch(() => {});
			if (!(await until(async () => !(await holder(files)), deps.stopMs ?? 10_000))) {
				// Only a process that answered on the sidecar's own socket is signalled: a pid in a state file may belong to anything by now.
				const stuck = await holder(files);
				if (stuck && stuck.state !== "starting" && stuck.held.pid !== process.pid) {
					try { process.kill(stuck.held.pid, "SIGTERM"); } catch { /* gone meanwhile */ }
					await until(async () => !(await holder(files)), 3000);
				}
				if (await holder(files)) return (err(`the net sidecar of session ${old.held.session} (pid ${old.held.pid}) did not leave\n`), 1);
			}
		}
		let loader: string;
		try {
			loader = deps.loader ?? tsxLoader(findIntercom(env));
		} catch (error) {
			return (err(`${(error as Error).message}\n`), 1);
		}
		mkdirSync(files.dir, { recursive: true, mode: 0o700 });
		const flags = ["record", "cli"].flatMap((key) => (a[key] ? [`--${key}`, a[key]!] : []));
		const child = (deps.spawn ?? detached)({ command: process.execPath, args: ["--import", pathToFileURL(loader).href, fileURLToPath(import.meta.url), "serve", "--pane", a.pane, "--kind", a.kind!, "--session", a.session!, ...flags], env: { ...env, HERDR_PANE_ID: a.pane }, cwd: process.cwd(), log: files.log });
		const waitMs = deps.joinMs ?? 3000;
		const outcome = await Promise.race([until(() => started(a.session!), waitMs).then((ok) => (ok ? "up" : "slow")), child.exited.then((code) => `exited with code ${code}`)]);
		if (outcome === "up") return (out(`joining as ${(await holder(files))!.held.id}\n`), 0);
		return (err(`the net sidecar ${outcome === "slow" ? `did not start within ${waitMs / 1000} s` : outcome}; see ${files.log}\n`), 1);
	}

	/** The sidecar itself, as `join` starts it: runs until it has left the net. */
	async function serve(a: Args) {
		let sidecar;
		try {
			sidecar = await startSidecar({ pane: a.pane, kind: a.kind as "claude" | "codex", session: a.session!, record: a.record, cli: a.cli, deps: { env, stateDir: deps.stateDir } });
		} catch (error) {
			return (err(`${(error as Error).message}\n`), 1);
		}
		const stop = (why: string) => void sidecar.stop(why);
		for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, () => stop(`${signal}`));
		process.on("uncaughtException", (error) => (err(`${error.stack ?? error.message}\n`), stop("an uncaught exception")));
		process.on("unhandledRejection", (error) => err(`unhandled rejection: ${String(error)}\n`));
		await sidecar.done;
		await pause(300); // the stop request's answer is on its way out
		return 0;
	}
}

// Run as a script (the loader may add a query to the module URL, and the path to this file may reach it through a symlink).
const script = (path: string) => { try { return realpathSync(path); } catch { return path; } };
if (process.argv[1] && script(fileURLToPath(import.meta.url.split("?")[0]!)) === script(process.argv[1])) process.exit(await run(process.argv.slice(2)));
