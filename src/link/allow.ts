import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// What a remote turn at `reply` or `forward` may do without asking (docs/specs/2026-10-25-straw-link.md, Remote turns, Trust levels): the allowlist
// by exact tool name, the deny list that is refused outright, and the filter that keeps the output of grep, find, and ls to tracked files.
// Paths are resolved the way pi's own tools resolve them (a leading `@` is dropped, `~` is the home folder, unusual spaces become spaces) and then
// with realpath, so a symlink cannot lead out of the project; a file counts only when `git ls-files` lists it, so ignored and untracked files
// (secrets, build output, .env copies) are never read without a confirm.

/** The senders of a remote run: a tower_send back to one of them is allowed. */
export interface Sender { id: string; short: string; label: string }
export type Verdict = { kind: "allow" } | { kind: "refuse"; reason: string } | { kind: "gate" };
export interface Scope {
	/** The bound project, as configured. */
	project: string;
	/** The tool's working directory (pi's `ctx.cwd`). */
	cwd: string;
	home: string;
	agentDir: string;
	/** `<state dir>/link`: the device keys and team files. */
	linkDir: string;
	/** The files `git ls-files` lists in the project; a fresh reading is allowed to be cached for a moment. */
	tracked(): Tracked;
}
export interface Tracked { files: Set<string>; dirs: Set<string> }

const SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const NAMES = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_/i, /\.p12$/i];
const HOME_DIRS = [".pi", ".ssh", ".aws", ".config", ".gnupg"];
/** The tools that look at paths and are allowed inside the project, and the ones allowed whatever their arguments. */
const SEARCH = new Set(["grep", "find", "ls"]);
const FREE = new Set(["tower_list", "boss_status", "todo"]);
/** Argument names that hold a path in pi's tools and in the tools of the extensions around it. */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "directory", "dir", "cwd", "paths", "files"];

/** The path a tool would open for `arg`. */
export function resolveArg(arg: string, cwd: string, home: string): string {
	let p = arg.replace(SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = home;
	else if (p.startsWith("~/")) p = join(home, p.slice(2));
	return resolve(cwd, p);
}

/** `p` with every symlink resolved as far as it exists, and the rest of the path as written. */
export function realish(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		const up = dirname(p);
		return up === p ? p : join(realish(up), basename(p));
	}
}
const within = (child: string, dir: string) => child === dir || child.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** Whether `abs` is on the deny list, as written or once its symlinks are resolved: the folders of secrets and this tool's own state, and the names of key files. */
export function pathDenied(abs: string, s: Pick<Scope, "home" | "agentDir" | "linkDir">): boolean {
	const dirs = [...HOME_DIRS.map((d) => join(s.home, d)), s.agentDir, s.linkDir].flatMap((d) => [d, realish(d)]);
	const seen = [abs, realish(abs)];
	return seen.some((p) => NAMES.some((n) => n.test(basename(p))) || dirs.some((d) => within(p, d)));
}

/** A path argument of any tool, as pi would open it. */
function pathArgs(input: Record<string, unknown>, s: Scope): string[] {
	return PATH_KEYS.flatMap((k) => {
		const v = input[k];
		return (typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []).map((a) => resolveArg(a, s.cwd, s.home));
	});
}

/** Where `abs` is under the project once symlinks are resolved, as a project-relative path with `/`; undefined when it is outside or does not exist. */
export function inProject(abs: string, s: Scope): string | undefined {
	let real: string, root: string;
	try {
		real = realpathSync.native(abs);
		root = realpathSync.native(s.project);
	} catch {
		return undefined;
	}
	if (!within(real, root)) return undefined;
	const rel = relative(root, real);
	return rel === "" ? "" : rel.split(sep).join("/");
}

/** The files git tracks in `project`, and the folders that hold them. An unreadable repository tracks nothing. */
export function readTracked(project: string): Tracked {
	const files = new Set<string>(), dirs = new Set<string>([""]);
	try {
		const out = execFileSync("git", ["-c", "core.fsmonitor=false", "-C", project, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 20_000 });
		for (const f of out.split("\0")) {
			if (!f) continue;
			files.add(f);
			for (let d = dirname(f); d !== "." && !dirs.has(d); d = dirname(d)) dirs.add(d);
		}
	} catch { /* not a repository, or git is missing: nothing is tracked */ }
	return { files, dirs };
}

const allowedFile = (abs: string, s: Scope): boolean => {
	const rel = inProject(abs, s);
	return rel !== undefined && s.tracked().files.has(rel) && !pathDenied(abs, s);
};

/**
 * What a call of `tool` with `input` is in a remote turn of senders at `reply` or `forward`: allowed, refused outright, or put to the gate.
 * `link_request` is refused at every level, so the caller asks this at `dispatch` too.
 */
export function decide(tool: string, input: Record<string, unknown>, senders: Sender[], s: Scope): Verdict {
	if (tool === "link_request") return { kind: "refuse", reason: "a remote turn cannot ask for a link action; link_request is the boss's" };
	const bad = pathArgs(input, s).find((p) => pathDenied(p, s));
	if (bad) return { kind: "refuse", reason: "that path is on the deny list of remote turns" };
	if (FREE.has(tool)) return { kind: "allow" };
	if (tool === "read") return typeof input.path === "string" && allowedFile(resolveArg(input.path, s.cwd, s.home), s) ? { kind: "allow" } : { kind: "gate" };
	if (SEARCH.has(tool)) {
		const roots = pathArgs(input, s);
		if (roots.length === 0) roots.push(s.cwd);
		return roots.every((r) => inProject(r, s) !== undefined) ? { kind: "allow" } : { kind: "gate" };
	}
	if (tool === "tower_send") {
		const device = typeof input.device === "string" ? input.device.trim() : "";
		return device && senders.some((x) => device === x.id || device === x.short || device === x.label) ? { kind: "allow" } : { kind: "gate" };
	}
	return { kind: "gate" };
}

/** The directory (or file) a grep, find, or ls call searches. */
export function searchRoot(input: Record<string, unknown>, s: Scope): string {
	return typeof input.path === "string" && input.path ? resolveArg(input.path, s.cwd, s.home) : s.cwd;
}

/**
 * The lines of a grep, find, or ls result that belong to a tracked file outside the deny list (a folder entry when it holds such a file), and
 * nothing else: a line that cannot be attributed to a path, such as a notice, goes too.
 */
export function filterListing(tool: string, root: string, text: string, s: Scope): string {
	const keepFile = (abs: string) => allowedFile(abs, s);
	const keepDir = (abs: string) => {
		const rel = inProject(abs, s);
		return rel !== undefined && s.tracked().dirs.has(rel) && !pathDenied(abs, s);
	};
	const rootIsDir = (() => {
		const rel = inProject(root, s);
		return rel === undefined || rel === "" || s.tracked().dirs.has(rel);
	})();
	const clean = (rel: string) => !isAbsolute(rel) && !rel.split("/").includes("..");
	const keep = (line: string): boolean => {
		if (tool === "grep") {
			for (const m of line.matchAll(/[:-]\d+[:-] /g)) {
				const prefix = line.slice(0, m.index);
				if (!prefix) continue;
				const abs = rootIsDir ? (clean(prefix) ? join(root, prefix) : undefined) : (prefix === basename(root) ? root : undefined);
				if (abs && keepFile(abs)) return true;
			}
			return false;
		}
		const dir = line.endsWith("/"), rel = dir ? line.slice(0, -1) : line;
		if (!rel || !clean(rel)) return false;
		return dir ? keepDir(join(root, rel)) : keepFile(join(root, rel));
	};
	return text.split("\n").filter(keep).join("\n");
}
