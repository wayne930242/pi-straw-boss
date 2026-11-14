import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { checkStages, parseAppAccept } from "./accept.ts";
import { isName, isObject } from "./spec.ts";

// What the code reads of an app in `.straw-boss/apps.json` before it lets a car depart (docs/specs/2026-11-07-train-workers.md §14, TB-F001, TB-F002): the kinds of acceptance the app requires (`integration.accept`) and its `stages`, which may no longer list
// `uat`. The integrator's guard, the train's manifest check, the train open and `train check` all read it here, so the requirement is the file's and not a flag a model passes. A file or an app that cannot be read is a refusal naming the file, never an empty list.

const MIGRATION = "see docs/how-it-works.md, Moving a project to 0.65.0";

/** The git root of `dir` (the nearest folder at or above it holding `.git`), else `dir` itself. */
function gitRoot(dir: string): string {
	for (let d = dir; ; d = dirname(d)) {
		if (existsSync(join(d, ".git"))) return d;
		if (dirname(d) === d) return dir;
	}
}

/** The apps.json of the project at `dir`, in the order `prompts/apps-config.md` gives: `<root>/.straw-boss/apps.json`, else `<root>/.claude/straw-boss/apps.json`. When neither exists the first is returned, and `both` names the two for the refusal. */
export function appsFile(dir: string): { file: string; exists: boolean; both: string } {
	const root = gitRoot(dir), first = join(root, ".straw-boss", "apps.json"), second = join(root, ".claude", "straw-boss", "apps.json");
	const file = existsSync(first) || !existsSync(second) ? first : second;
	return { file, exists: existsSync(file), both: `${first} or ${second}` };
}

export type Apps = { ok: true; file: string; apps: Record<string, unknown>[]; missing?: undefined } | { ok: false; file: string; refusal: string; missing?: true };

/** The `apps` list of `<dir>/.straw-boss/apps.json` (empty when the file names none). A file that is not there is `missing`; one that cannot be read or parsed, or whose `apps` is no list, is a refusal. */
export function readApps(dir: string): Apps {
	const { file, both } = appsFile(dir);
	let text: string;
	try { text = readFileSync(file, "utf8"); } catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		return { ok: false, file: missing ? both : file, refusal: `${missing ? both : file} ${missing ? "is not there" : `cannot be read (${(error as Error).message})`}, so integration.accept of the app is unknown`, ...(missing ? { missing: true as const } : {}) };
	}
	let config: unknown;
	try { config = JSON.parse(text.replace(/^\uFEFF/, "")); } catch (error) { return { ok: false, file, refusal: `${file} cannot be parsed (${(error as Error).message}), so integration.accept of the app is unknown` }; }
	const apps = isObject(config) ? config.apps : undefined;
	if (apps !== undefined && !Array.isArray(apps)) return { ok: false, file, refusal: `${file}: apps must be a list, so integration.accept of the app is unknown` };
	return { ok: true, file, apps: (apps ?? []).filter(isObject) };
}

/** The refusals of one app's `integration`: `stages` that list `uat` (or are otherwise wrong) and an `accept` that is not a list of kind names. */
function integrationRefusals(file: string, name: string, integration: Record<string, unknown>): string[] {
	const out = checkStages(integration.stages).map((r) => `${file}: app ${name}: ${r.replace(/^sb: /, "")} (${MIGRATION}, step 2)`);
	const accept = parseAppAccept(integration.accept);
	if (!accept.ok) out.push(`${file}: app ${name}: ${accept.refusal.replace(/^sb: /, "")}`);
	return out;
}

export type AppIntegration = { ok: true; accept: string[] } | { ok: false; refusal: string };

/** `integration.accept` of the app `app` in `<dir>/.straw-boss/apps.json`, after its `stages` and `accept` passed. Fails closed: a file, an app, or an `integration` that is not there is a refusal. */
export function readAppIntegration(dir: string, app: string): AppIntegration {
	const read = readApps(dir);
	if (!read.ok) return { ok: false, refusal: `sb: ${read.refusal}` };
	const entry = read.apps.find((a) => a.name === app);
	if (!entry) return { ok: false, refusal: `sb: ${read.file} has no app named ${app}, so integration.accept of the app is unknown` };
	if (!isObject(entry.integration)) return { ok: false, refusal: `sb: ${read.file}: app ${app} has no integration, so it takes no train` };
	const refusals = integrationRefusals(read.file, app, entry.integration), accept = parseAppAccept(entry.integration.accept);
	return refusals.length || !accept.ok ? { ok: false, refusal: `sb: ${refusals.join("; ")}` } : { ok: true, accept: accept.accept };
}

/** The refusal of a car slip's apps for the merge train: an `apps.json` that is not there or cannot be read, an app it does not name, and an app with no `integration` (it keeps today's flow, and takes no integrator). Fails closed. */
export function noTrainRefusal(dir: string, apps: readonly string[]): string | undefined {
	const read = readApps(dir);
	if (!read.ok) return `sb: ${read.refusal.replace(/, so integration\.accept of the app is unknown$/, "")}, so no app here takes the merge train`;
	for (const app of apps) {
		const entry = read.apps.find((a) => a.name === app);
		if (!entry) return `sb: ${read.file} has no app named ${app}, so its car takes no train (the slip's car: names the car's app as apps.json names it, not a ticket)`;
		if (!isObject(entry.integration)) return `sb: ${read.file}: app ${app} has no integration, so it takes no train`;
	}
	return undefined;
}

/**
 * The refusal of a train open (§14.2): the `stages` or `accept` of the manifest's app, or of every app with an `integration` when the manifest names none. A file that is not there refuses nothing here (the open reads `maxTrains` the same way, and
 * the guard of the integrator refuses a car whose app it cannot read); one that exists and cannot be read or parsed refuses.
 */
export function openRefusal(dir: string, app: string | undefined): string | undefined {
	const read = readApps(dir);
	if (!read.ok) return read.missing ? undefined : `sb: ${read.refusal}`;
	const named = app === undefined ? read.apps : read.apps.filter((a) => a.name === app);
	const out = named.flatMap((a) => (isObject(a.integration) ? integrationRefusals(read.file, String(a.name), a.integration) : []));
	return out.length ? `sb: ${out.join("; ")}` : undefined;
}

/**
 * The folder whose apps.json speaks for the project at `dir`: `dir` when its git root has one, else the main checkout of its repository when that has one (a linked worktree of a coordinator often lacks an untracked
 * `.claude/straw-boss/apps.json` the main checkout keeps, and the tower reads the project's), else undefined: no apps.json is found, and nothing that needs one can be checked.
 */
export function projectAppsDir(dir: string): string | undefined {
	if (appsFile(dir).exists) return dir;
	const main = repoRoot(dir);
	return appsFile(main).exists ? main : undefined;
}

/** The repository `dir` is a checkout of, as its main checkout's real folder: a linked worktree's `.git` is a file naming its git dir, whose `commondir` leads to the repository's own `.git`. Two worktrees of one repository answer the same; anything else answers its git root. */
export function repoRoot(dir: string): string {
	const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
	const root = gitRoot(dir), dot = join(root, ".git");
	try {
		if (!statSync(dot).isFile()) return real(root);
		const gitdir = resolve(root, /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))![1]!.trim()), common = resolve(gitdir, readFileSync(join(gitdir, "commondir"), "utf8").trim());
		return real(basename(common) === ".git" ? dirname(common) : common);
	} catch { return real(root); }
}

/** The git dir of the checkout at `root` and the common dir that one names, as real paths: its `.git` when that is a folder, else the git dir its `.git` file names (a linked worktree, a submodule of another repository, `--separate-git-dir`). None when it cannot be read. */
function gitDirs(root: string): string[] {
	try {
		const dot = join(root, ".git"), named = statSync(dot).isFile() ? /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))![1]!.trim() : dot, gitdir = realpathSync(resolve(root, named));
		return [gitdir, commonOf(gitdir)];
	} catch { return []; }
}
/** The common dir of a git dir, as a real path: what its `commondir` file names, else the git dir itself. git reads the objects and refs there. */
function commonOf(gitdir: string): string {
	const file = join(gitdir, "commondir");
	return existsSync(file) ? realpathSync(resolve(gitdir, readFileSync(file, "utf8").trim())) : gitdir;
}

/**
 * The folders of the repository of `app` when the app is a repository of its own (a git submodule of the project, or a clone inside it), none when its commits are the project's (0.80.1, 0.80.2). They are the nearest folder holding a `.git`, from the app's `dir` of the
 * apps.json of `dir` up to below the root (R0801-F002: an app may be a folder inside a submodule), under the git root of `dir` and under the main checkout of that repository: in a linked worktree of the project the submodule may not be checked out, or keeps objects of
 * its own. No folder outside the project answers (R0801-F001, RD0801-F001, RD0801-F002): the folder is inside the root after realpath; the git dir its `.git` is or names (a folder, a `gitdir:` file, or a symlink to one), and the common dir that one names, are after realpath inside the checkout,
 * the main checkout, or the project's own git dir or common dir (a project that is itself a submodule, or was cloned with `--separate-git-dir`, keeps its submodules' git dirs there and not in its folder). A `.git` that is no git dir (it holds no `HEAD`: git walks past it
 * to the project's) and a git dir whose common dir is the project's own (a linked worktree of the project inside it: its commits and its remote are the project's) answer none (R0802-F004).
 */
export function appRepos(dir: string, app: string | undefined): string[] {
	const read = readApps(dir), at = read.ok ? read.apps.find((a) => a.name === app)?.dir : undefined;
	if (typeof at !== "string") return [];
	const top = resolve(gitRoot(dir)), home = repoRoot(dir);
	const inside = (path: string, root: string) => path.startsWith(root + sep);
	const own = (root: string): string[] => {
		const folder = resolve(root, at);
		if (!inside(folder, root)) return [];
		try {
			const real = realpathSync(root), mine = gitDirs(top), allowed = [real, home, ...mine], within = (path: string) => allowed.some((a) => path === a || inside(path, a));
			for (let d = realpathSync(folder); inside(d, real); d = dirname(d)) {
				const dot = join(d, ".git"), stat = statSync(dot, { throwIfNoEntry: false });
				if (!stat) continue;
				const named = stat.isDirectory() ? dot : stat.isFile() ? /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim() : undefined;
				if (named === undefined) return [];
				const gitdir = realpathSync(resolve(d, named)), common = commonOf(gitdir);
				if (common === mine[1] || !existsSync(join(gitdir, "HEAD"))) return [];
				return within(gitdir) && within(common) ? [d] : [];
			}
		} catch { /* a folder or a git dir that is not there answers nothing */ }
		return [];
	};
	return [...new Set([...own(top), ...own(home)])];
}

/**
 * Where the project's own git would hold a gitlink for `app` (R0802-F002): the git root of `dir`, and the app's `dir` of its apps.json with every folder above it below that root, as the index names them (relative, with `/`). None when the app names no folder inside the root, or the root itself.
 * A submodule that is not checked out has no `.git` for `appRepos` to find, and the index (mode 160000) and `.gitmodules` still say that the app's commits are not the project's.
 */
export function appLinkPaths(dir: string, app: string | undefined): { root: string; paths: string[] } {
	const read = readApps(dir), at = read.ok ? read.apps.find((a) => a.name === app)?.dir : undefined, root = resolve(gitRoot(dir)), paths: string[] = [];
	if (typeof at !== "string") return { root, paths };
	for (let d = resolve(root, at); d.startsWith(root + sep); d = dirname(d)) paths.push(relative(root, d).split(sep).join("/"));
	return { root, paths };
}
/** The `path` of each submodule the `.gitmodules` of the checkout at `root` names; none when the file is not there or cannot be read. */
export function gitmodulesPaths(root: string): string[] {
	let text: string;
	try { text = readFileSync(join(root, ".gitmodules"), "utf8"); } catch { return []; }
	return [...text.matchAll(/^[ \t]*path[ \t]*=[ \t]*(.*?)[ \t]*$/gm)].map((m) => m[1]!.replace(/^"(.*)"$/, "$1").replace(/\/+$/, "")).filter(Boolean);
}

/**
 * The folders git is asked in about the commits of a car of `app` (0.80.1): the app's own repository when it is one (`appRepos`), else `fallback`, where git was asked before, because the app's commits are then the project's (its folder holds no `.git` of its own, is the
 * root, or leaves it; no app is named). Whether a delta's `on.head` is an ancestor of the car's head was asked in the project's root, where a submodule's commits do not exist. Which folder answers decides only whether git knows the two commits: a commit's ancestors are
 * fixed by its hash, and the callers ask with replace refs off (`--no-replace-objects`), no graft file (`GIT_GRAFT_FILE` is the null device; R0802-F003) and no commit-graph (`core.commitGraph=false`; R0802D-F002), the three ways a repository can give a commit other parents.
 */
export function carRepos(dir: string, app: string | undefined, fallback = dir): string[] {
	const found = appRepos(dir, app);
	return found.length ? found : [fallback];
}

export type CheckoutProject = { ok: true; project: string; /** Where the name is from, in words. */ from: string; file: string } | { ok: false; refusal: string };

/**
 * The project of the checkout at `dir`, as its integrator is named (`integ <project>`): the top-level `integration.project` of its apps.json, else the folder name of its repository (R151-F002). The code reads it, so a checkout
 * has one project whatever a caller words, and a slip of its apps reaches no other project's integrator. Fails closed: a file that cannot be read, a `project` that is no path-safe name, and a folder name that is none are refusals.
 */
export function checkoutProject(dir: string): CheckoutProject {
	const { file } = appsFile(dir);
	let config: unknown;
	try { config = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); } catch (error) { return { ok: false, refusal: `sb: ${file} cannot be read (${(error as Error).message}), so the project of this checkout is unknown` }; }
	const integration = isObject(config) ? config.integration : undefined, named: unknown = isObject(integration) ? integration.project : undefined, shown = String(JSON.stringify(named)).slice(0, 80);
	if (named !== undefined) return isName(named) ? { ok: true, project: named, from: `integration.project in ${file}`, file } : { ok: false, refusal: `sb: ${file}: integration.project must be a path-safe name, not ${shown}` };
	const folder = basename(repoRoot(dir)), odd = folder.slice(0, 80);
	return isName(folder) ? { ok: true, project: folder, from: `the folder name of its repository; ${file} names no integration.project`, file } : { ok: false, refusal: `sb: ${file} names no integration.project, and the folder name of its repository (${odd}) is not a path-safe name: set integration.project` };
}
