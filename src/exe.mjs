// Programs by absolute path. A bare name is looked for in the current folder first on Windows (nodejs/node#46264), and a pi session's folder is a project: a `git.exe` or `herdr.exe`
// planted in a repository would run with the user's rights. Every program the package starts by name (herdr, git, tailscale, sh, ps, the clipboard and browser openers) is found here
// instead, by a search of PATH that skips what is not an absolute folder (empty, ".", and relative entries) and never looks in the current folder, and is spawned by the path it found.
// Plain JavaScript on purpose: balance.mjs, which Node runs from node_modules without stripping types, uses it too.
import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { posix, win32 } from "node:path";

/** A program that PATH does not have: `code` is ENOENT, so a caller that tells a missing program apart from a failing one needs no new case. */
export class ExeNotFound extends Error {
	/** @param {string} name @param {string} why */
	constructor(name, why) {
		super(`${name} was not found: ${why}`);
		this.name = "ExeNotFound";
		this.code = "ENOENT";
	}
}

const isFile = (/** @type {string} */ path, /** @type {boolean} */ posixMode) => {
	try {
		if (!statSync(path).isFile()) return false;
		if (posixMode) accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
};
const envKey = (/** @type {NodeJS.ProcessEnv} */ env, /** @type {string} */ name, /** @type {boolean} */ win) => (win ? Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase()) : name in env ? name : undefined);

/**
 * Where `name` is: the first absolute PATH folder that holds it. On Windows a name with no extension is tried with each of PATHEXT's `.exe` and `.com` in PATHEXT's order (a `.cmd` or `.bat` cannot be
 * started without a shell, and Node refuses to). A name that is itself a path must be absolute and is returned as it is. Throws ExeNotFound.
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (path: string) => boolean }} [deps]
 */
export function searchPath(name, deps = {}) {
	const env = deps.env ?? process.env, platform = deps.platform ?? process.platform, win = platform === "win32", path = win ? win32 : posix;
	if (!name) throw new ExeNotFound("an empty program name", "nothing to look for");
	if (/[\\/]/.test(name) || (win && /^[A-Za-z]:/.test(name))) {
		if (!path.isAbsolute(name)) throw new ExeNotFound(name, "a program given as a path must be an absolute path (a relative one would be read against the current folder)");
		return name;
	}
	const exists = deps.isFile ?? ((/** @type {string} */ p) => isFile(p, !win));
	const listed = env[envKey(env, "PATH", win) ?? "PATH"] ?? "";
	const folders = listed.split(win ? ";" : ":").map((entry) => (win ? entry.trim().replace(/^"(.*)"$/, "$1") : entry)).filter((entry) => entry && path.isAbsolute(entry));
	const exts = win ? (/\.[^.\\/]+$/.test(name) ? [""] : (env[envKey(env, "PATHEXT", true) ?? "PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim().toLowerCase()).filter((e) => e === ".exe" || e === ".com")) : [""];
	for (const folder of folders) for (const ext of exts) {
		const candidate = path.join(folder, name + ext);
		if (exists(candidate)) return candidate;
	}
	throw new ExeNotFound(name, `no ${win ? `${name}.exe or ${name}.com` : name} in the ${folders.length} absolute PATH folder${folders.length === 1 ? "" : "s"} (an empty, ".", or relative PATH entry is not searched, and neither is the current folder)`);
}

/** @type {Map<string, { path: string, key: string }>} */
const cache = new Map();
const keyOf = (/** @type {NodeJS.ProcessEnv} */ env, /** @type {boolean} */ win) => `${env[envKey(env, "PATH", win) ?? "PATH"] ?? ""}\0${win ? env[envKey(env, "PATHEXT", true) ?? "PATHEXT"] ?? "" : ""}`;
/**
 * The absolute path of a program, searched once per process for a PATH (the answer is kept while PATH and PATHEXT are the same). Throws ExeNotFound.
 * @param {string} name
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (path: string) => boolean }} [deps]
 */
export function resolveExe(name, deps = {}) {
	const env = deps.env ?? process.env, win = (deps.platform ?? process.platform) === "win32", key = keyOf(env, win), kept = cache.get(name);
	if (kept && kept.key === key && !deps.isFile) return kept.path;
	const found = searchPath(name, deps);
	if (!deps.isFile) cache.set(name, { path: found, key });
	return found;
}
/** Forgets what was found for `name` (all names without one): the next call searches again. @param {string} [name] */
export const forgetExe = (name) => void (name === undefined ? cache.clear() : cache.delete(name));

const GRACE_MS = 2000;
/** Signals the process group `pid` leads; false when no process of it is left. @param {number} pid @param {NodeJS.Signals | 0} signal */
const signalGroup = (pid, signal) => {
	try {
		return process.kill(-pid, signal);
	} catch {
		return false;
	}
};
/**
 * `execFile` with a deadline that holds (`options.deadline`, in ms). execFile's own `timeout` sends one SIGTERM and calls back when the program has ended, so a program that does not end on SIGTERM holds the
 * callback for as long as it lives (todo #155: a `herdr agent start` given 35 s called back 61 minutes later). Here `done` is called at the deadline at the latest. A program that had ended by then, with a copy
 * of its stdout or stderr still open somewhere, is told by its own exit status, as execFile tells it. One still running is cut off: the error is marked as execFile marks a timeout (`killed`, `signal: "SIGTERM"`,
 * no exit code; an overflow of `maxBuffer` is marked as execFile marks that: its code, `killed: false`, no signal), with what was read so far, and the program is ended behind the call by SIGTERM, then SIGKILL after `options.grace` (2 s). Where there are process groups it starts as the leader of its own
 * (`detached`) and both signals go to the group, so what it started ends with it; on Windows they end the program alone. Output is read as UTF-8 text, and more than `maxBuffer` of it cuts the program off too.
 * `options.group: false` is for a program whose children are meant to stay (an opener and the file manager it started): it runs in the caller's group, and the signals end it alone.
 * @param {string} file
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileOptions & { deadline: number, grace?: number, group?: boolean }} options
 * @param {(error: (Error & { code?: string | number | null }) | null, stdout: string, stderr: string) => void} done
 */
function execFileByDeadline(file, args, options, done) {
	const alone = process.platform === "win32" || options.group === false, limit = options.maxBuffer ?? 1024 * 1024, cmd = [file, ...args].join(" ");
	const child = spawn(file, args, { cwd: options.cwd, env: options.env, windowsHide: options.windowsHide, detached: !alone });
	let stdout = "", stderr = "", settled = false;
	/** @type {{ code: number | null, signal: NodeJS.Signals | null } | undefined} */
	let ended;
	/** @param {Error | null} error */
	const settle = (error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
		done(error, stdout, stderr);
	};
	/** @param {string} what @param {Record<string, unknown>} marks */
	const failure = (what, marks) => Object.assign(new Error(`${what}: ${cmd}${stderr ? `\n${stderr}` : ""}`), { cmd, ...marks });
	/** @param {{ code: number | null, signal: NodeJS.Signals | null }} status */
	const byStatus = ({ code, signal }) => settle(code === 0 ? null : failure("Command failed", { code, killed: false, signal }));
	/** @param {string} what @param {string | null} code @param {boolean} timedOut a timeout is marked as execFile marks one; an overflow is marked as execFile marks it (a code, no `killed`, no signal), though the program behind the call is ended too */
	const cutOff = (what, code, timedOut) => {
		if (settled) return;
		settle(failure(what, timedOut ? { code, killed: true, signal: "SIGTERM" } : { code, killed: false, signal: null }));
		if (ended) return; // it left by itself: what it left behind is not signalled, and its group's id may be another program's by now
		/** @param {NodeJS.Signals} signal */
		const send = (signal) => (alone || child.pid === undefined ? child.kill(signal) : signalGroup(child.pid, signal));
		send("SIGTERM");
		const hard = setTimeout(() => (send("SIGKILL"), child.unref()), options.grace ?? GRACE_MS);
		// The leader gone and nothing left in its group: there is nothing to kill at the grace.
		child.once("exit", () => (alone || child.pid === undefined || !signalGroup(child.pid, 0)) && clearTimeout(hard));
	};
	const timer = setTimeout(() => (ended ? byStatus(ended) : cutOff(`Command timed out after ${options.deadline} ms`, null, true)), options.deadline);
	child.stdout?.setEncoding("utf8").on("data", (chunk) => (stdout += chunk).length > limit && cutOff("stdout maxBuffer length exceeded", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", false));
	child.stderr?.setEncoding("utf8").on("data", (chunk) => (stderr += chunk).length > limit && cutOff("stderr maxBuffer length exceeded", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", false));
	child.on("error", settle); // the program could not be started; after the call has ended, a signal that could not be sent
	child.once("exit", (code, signal) => (ended = { code, signal }));
	child.once("close", (code, signal) => byStatus({ code, signal }));
	return child;
}

/**
 * `execFile` of a program found by `resolveExe`. A program that is gone when it is started (ENOENT: it was uninstalled or moved since the search) is searched for again once.
 * A program that is not found at all calls back with ExeNotFound. With `options.deadline` the call ends by that many ms whatever the program does (`execFileByDeadline`), which `options.timeout` does not promise.
 * @param {string} name
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileOptions & { deadline?: number, grace?: number, group?: boolean }} options
 * @param {(error: (Error & { code?: string | number | null }) | null, stdout: string, stderr: string) => void} done
 */
export function execFileExe(name, args, options, done) {
	const env = options.env ?? process.env, { deadline } = options;
	/** @param {boolean} again */
	const start = (again) => {
		let file;
		try {
			file = resolveExe(name, { env });
		} catch (error) {
			process.nextTick(done, /** @type {Error} */ (error), "", "");
			return undefined;
		}
		/** @param {(Error & { code?: string | number | null }) | null} error @param {string | Buffer} stdout @param {string | Buffer} stderr */
		const finish = (error, stdout, stderr) => {
			if (error && error.code === "ENOENT" && again) {
				forgetExe(name);
				let next;
				try {
					next = resolveExe(name, { env });
				} catch (failure) {
					return done(/** @type {Error} */ (failure), "", "");
				}
				if (next !== file) return void start(false);
			}
			done(error, String(stdout), String(stderr));
		};
		return deadline === undefined ? execFile(file, args, options, finish) : execFileByDeadline(file, args, { ...options, deadline }, finish);
	};
	return start(true);
}
/**
 * `execFileSync` of a program found by `resolveExe`, with the same second search. Returns what execFileSync does. A call with a `timeout` passes `killSignal: "SIGKILL"`: execFileSync sends the signal at
 * the timeout and then waits for the program to end, so one that does not end on the default SIGTERM blocks this process for as long as it lives (todo #155).
 * @param {string} name
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileSyncOptions} [options]
 */
export function execFileSyncExe(name, args, options = {}) {
	const env = options.env ?? process.env;
	try {
		return execFileSync(resolveExe(name, { env }), args, options);
	} catch (error) {
		if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") throw error;
		const before = cache.get(name)?.path;
		forgetExe(name);
		const next = resolveExe(name, { env });
		if (next === before) throw error;
		return execFileSync(next, args, options);
	}
}
