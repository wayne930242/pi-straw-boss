// Programs by absolute path. A bare name is looked for in the current folder first on Windows (nodejs/node#46264), and a pi session's folder is a project: a `git.exe` or `herdr.exe`
// planted in a repository would run with the user's rights. Every program the package starts by name (herdr, git, tailscale, sh, ps, the clipboard and browser openers) is found here
// instead, by a search of PATH that skips what is not an absolute folder (empty, ".", and relative entries) and never looks in the current folder, and is spawned by the path it found.
// Plain JavaScript on purpose: balance.mjs, which Node runs from node_modules without stripping types, uses it too.
import { execFile, execFileSync } from "node:child_process";
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

/**
 * `execFile` of a program found by `resolveExe`. A program that is gone when it is started (ENOENT: it was uninstalled or moved since the search) is searched for again once.
 * A program that is not found at all calls back with ExeNotFound.
 * @param {string} name
 * @param {string[]} args
 * @param {import("node:child_process").ExecFileOptions} options
 * @param {(error: (Error & { code?: string | number }) | null, stdout: string, stderr: string) => void} done
 */
export function execFileExe(name, args, options, done) {
	const env = options.env ?? process.env;
	/** @param {boolean} again */
	const start = (again) => {
		let file;
		try {
			file = resolveExe(name, { env });
		} catch (error) {
			process.nextTick(done, /** @type {Error} */ (error), "", "");
			return undefined;
		}
		return execFile(file, args, options, (error, stdout, stderr) => {
			if (error && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT" && again) {
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
		});
	};
	return start(true);
}
/**
 * `execFileSync` of a program found by `resolveExe`, with the same second search. Returns what execFileSync does.
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
