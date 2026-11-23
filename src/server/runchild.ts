import { type ChildProcess, execFile, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { delimiter, dirname, join, win32 } from "node:path";
import { inTestRun, refuse } from "./testguard.ts";
import { searchPath } from "../exe.mjs";
import { system32Path } from "../winpath.ts";

// A headless tower run (docs/specs/2026-11-23-lite-b2-d-e-f.md §4, behind `towerRuns.headless`): pi started as the server's own child in RPC mode, with no pane and no Herdr. The server is the only writer of
// the child's stdin, and it writes only the three commands below: the boss's words reach the model as a `straw-tower` message through the run's extension, never as pi input, so a line that starts with `/` or `!`
// is text (docs/specs/2026-11-23-f-entry.md §5). stdout is protocol, split on LF only (pi's docs: `readline` also splits on U+2028); stderr goes to a capped file per run.

/** What the server may write to a run's stdin; anything else throws. */
export const STDIN_ALLOWED = ["abort", "extension_ui_response", "get_state"] as const;
export type StdinCommand = { type: "abort" } | { type: "get_state" } | { type: "extension_ui_response"; id: string; value?: string; confirmed?: boolean; cancelled?: true };
/** The most a run's stderr file holds, and how many such files (or how old) a workspace keeps. */
export const STDERR_CAP = 256 * 1024;
export const STDERR_KEEP = 20, STDERR_KEEP_MS = 24 * 3600_000;
/** The prefixes of the environment a run does not inherit: the server's own, Herdr's pane, and an intercom or subagent identity (AGENTS.md: an inherited PI_SUBAGENT_ID makes every pi a subagent). */
const DROPPED = [/^STRAW_BOSS_/, /^HERDR_/, /^PI_SUBAGENT_/, /^PI_INTERCOM_SESSION_ID$/];
export const NONCE_ENV = "STRAW_BOSS_RUN_NONCE";

/**
 * The environment of a run: the server's, less the names above, plus the run's nonce and the Herdr socket of the server's slot (`herdr`), so the run finds its server's folder (record.ts `slotOf`) whatever
 * Herdr session or socket the server was started under. No pane, tab, or workspace of Herdr's goes with it.
 */
export function runEnv(env: NodeJS.ProcessEnv, nonce: string, herdr?: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(env)) if (!DROPPED.some((re) => re.test(k))) out[k] = v;
	if (herdr) out.HERDR_SOCKET_PATH = herdr;
	out[NONCE_ENV] = nonce;
	return out;
}
export const newNonce = () => randomBytes(16).toString("hex");

/** Where `name` is found on `path`, the way a shell finds it (Windows tries the PATHEXT endings). */
function which(name: string, path: string, platform: NodeJS.Platform, ext = ".COM;.EXE;.BAT;.CMD"): string | undefined {
	const ends = platform === "win32" ? ["", ...ext.split(";").map((e) => e.toLowerCase())] : [""];
	for (const dir of path.split(platform === "win32" ? ";" : delimiter).filter(Boolean)) {
		for (const end of ends) {
			const file = join(dir, name + end);
			try { if (statSync(file).isFile()) return file; } catch { /* not here */ }
		}
	}
	return undefined;
}
/** The JS target an npm `.cmd` shim runs (`"%_prog%"  "%dp0%\node_modules\...\cli.js" %*`), resolved against the shim's folder. */
export function shimTarget(shim: string, text: string): string | undefined {
	const found = /"%(?:~?dp0)%\\?([^"]+\.[cm]?js)"/i.exec(text);
	return found ? win32.resolve(win32.dirname(shim), found[1]!) : undefined;
}
export interface PiPath { node: string; cli: string }
/**
 * The node and pi CLI a run starts with: `towerRuns.pi` when set, else the real file behind `pi` on the boss's PATH (on Windows the npm shim's JS target, so node runs it directly with no `cmd.exe /c`), and the `node`
 * on that PATH, the one pi's shebang names (the server's own node may be another nvm version). Throws with the path it looked at when neither is found.
 */
export function resolvePi(env: NodeJS.ProcessEnv, configured: string | undefined, platform: NodeJS.Platform = process.platform): PiPath {
	const path = env.PATH ?? env.Path ?? "";
	let node: string;
	try { node = searchPath("node", { env, platform }); } catch { node = process.execPath; }
	if (configured) return { node, cli: configured };
	const pi = which("pi", path, platform, env.PATHEXT);
	if (!pi) throw new Error(`pi is not on the PATH the sb server has (${path.slice(0, 200)}); set towerRuns.pi in config.json to pi's dist/cli.js`);
	if (platform === "win32" && /\.cmd$/i.test(pi)) {
		const target = shimTarget(pi, readFileSync(pi, "utf8"));
		if (!target) throw new Error(`${pi} is not an npm shim the sb server can read; set towerRuns.pi in config.json to pi's dist/cli.js`);
		return { node, cli: target };
	}
	try { return { node, cli: realpathSync(pi) }; } catch { return { node, cli: pi }; }
}

/** Splits a byte stream into LF-terminated records (a CR before the LF is dropped); U+2028 and U+2029 stay inside a record. */
export function lfSplitter(onLine: (line: string) => void) {
	let rest = "";
	return {
		push(chunk: string) {
			rest += chunk;
			for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
				const line = rest.slice(0, at).replace(/\r$/, "");
				rest = rest.slice(at + 1);
				if (line) onLine(line);
			}
		},
		end() { if (rest) onLine(rest.replace(/\r$/, "")); rest = ""; },
	};
}

/** Writes `cmd` as one record, refusing anything that is not in STDIN_ALLOWED. */
export function stdinRecord(cmd: StdinCommand): string {
	if (!(STDIN_ALLOWED as readonly string[]).includes((cmd as { type?: unknown }).type as string)) throw new Error(`the server writes no ${(cmd as { type?: unknown }).type} to a run`);
	return `${JSON.stringify(cmd)}\n`;
}

/** Keeps a workspace's stderr files to the last `STDERR_KEEP`, none older than a day. */
export function pruneStderr(dir: string, now: number) {
	let names: string[];
	try { names = readdirSync(dir).filter((n) => n.endsWith(".stderr")); } catch { return; }
	const rows = names.flatMap((n) => { try { return [{ n, at: statSync(join(dir, n)).mtimeMs }]; } catch { return []; } }).sort((a, b) => b.at - a.at);
	rows.forEach((r, i) => { if (i >= STDERR_KEEP || now - r.at > STDERR_KEEP_MS) rmSync(join(dir, r.n), { force: true }); });
}

export type Spawn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;
export interface ChildExit { code: number | null; signal: NodeJS.Signals | null }
export interface RunChild {
	pid: number;
	/** Writes one allowed command; false when stdin is closed. */
	write(cmd: StdinCommand): boolean;
	/** Closes stdin: pi shuts down once it settles. */
	close(): void;
	/** Ends the child and what it started: its process group elsewhere, `taskkill /T /F` on Windows. */
	kill(): void;
	exited: Promise<ChildExit>;
	readonly done: boolean;
}
export interface StartChild {
	pi: PiPath;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The run's stderr file, capped at STDERR_CAP. */
	stderr?: string;
	onRecord(record: Record<string, unknown>): void;
	onBad?(): void;
	spawn?: Spawn;
	platform?: NodeJS.Platform;
	/** Signals a process group (POSIX) or runs taskkill (Windows); tests replace both. */
	killGroup?: (pid: number) => void;
	taskkill?: (pid: number) => void;
}
/** Starts a run's pi. A test run that has not given its own spawn is refused: a test never starts a real pi (AGENTS.md, test isolation). */
export function startChild(o: StartChild): RunChild {
	const platform = o.platform ?? process.platform;
	if (!o.spawn && inTestRun()) refuse("a test started a real pi for a tower run; give the runs a fake spawn", process.env);
	const child = (o.spawn ?? nodeSpawn)(o.pi.node, [o.pi.cli, ...o.args], { cwd: o.cwd, env: o.env, stdio: ["pipe", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true });
	if (child.pid === undefined) throw new Error(`pi did not start (${o.pi.node} ${o.pi.cli})`);
	const pid = child.pid;
	let done = false, written = 0;
	const exited = new Promise<ChildExit>((res) => {
		child.once("exit", (code, signal) => ((done = true), res({ code, signal })));
		child.once("error", () => ((done = true), res({ code: null, signal: null })));
	});
	const split = lfSplitter((line) => {
		let rec: unknown;
		try { rec = JSON.parse(line); } catch { return o.onBad?.(); }
		if (rec && typeof rec === "object" && !Array.isArray(rec)) o.onRecord(rec as Record<string, unknown>);
		else o.onBad?.();
	});
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (c: string) => split.push(c));
	child.stdout?.on("end", () => split.end());
	if (o.stderr) {
		try { mkdirSync(dirname(o.stderr), { recursive: true }); } catch { /* the file write fails below */ }
		child.stderr?.on("data", (c: Buffer) => {
			if (written >= STDERR_CAP) return;
			const piece = c.subarray(0, STDERR_CAP - written);
			written += piece.length;
			try { appendFileSync(o.stderr!, piece); } catch { /* a full disk loses the log, not the run */ }
		});
	} else child.stderr?.resume();
	child.stdin?.on("error", () => {});
	const killGroup = o.killGroup ?? ((p: number) => { try { process.kill(-p, "SIGKILL"); } catch { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } } });
	const taskkill = o.taskkill ?? ((p: number) => { const file = system32Path("taskkill.exe"); execFile(file, ["/pid", String(p), "/T", "/F"], { windowsHide: true }, () => {}); });
	return {
		pid,
		write: (cmd) => {
			const line = stdinRecord(cmd);
			if (done || !child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return false;
			child.stdin.write(line);
			return true;
		},
		close: () => void child.stdin?.end(),
		kill: () => (done ? undefined : platform === "win32" ? taskkill(pid) : killGroup(pid)),
		exited,
		get done() { return done; },
	};
}
export const stderrFile = (towerDir: string, run: string) => join(towerDir, "runs", `${run.slice(0, 8)}.stderr`);
