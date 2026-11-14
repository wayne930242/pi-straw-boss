import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
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

/**
 * The folders git is asked in about the commits of a car of `app` (0.80.1). When the app is a repository of its own (a git submodule of the project, or a clone inside it), they are the app's `dir` of the apps.json of `dir`, under the git root of `dir` and under the
 * main checkout of that repository: in a linked worktree of the project the submodule may not be checked out, or keeps objects of its own. Otherwise (the app's folder holds no `.git` of its own, is the root, or leaves it; no app is named) the app's commits are the
 * project's, and the one folder is `fallback`, where git was asked before. Whether a delta's `on.head` is an ancestor of the car's head was asked in the project's root, where a submodule's commits do not exist. Which folder answers decides only whether git knows
 * the two commits: a commit's ancestors are fixed by its hash.
 */
export function carRepos(dir: string, app: string | undefined, fallback = dir): string[] {
	const read = readApps(dir), at = read.ok ? read.apps.find((a) => a.name === app)?.dir : undefined;
	if (typeof at !== "string") return [fallback];
	const home = repoRoot(dir);
	// R0801-F001: inside the root after realpath, and its git dir (a submodule's `.git` file names one under the repository's `.git`) inside the repository, so a symlink or a `gitdir:` pointer leads git to no folder outside the project.
	const inside = (path: string, root: string) => path.startsWith(root + sep);
	const ownGitDir = (folder: string): boolean => {
		const dot = join(folder, ".git");
		if (statSync(dot).isDirectory()) return true;
		const named = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim();
		return named !== undefined && inside(realpathSync(resolve(folder, named)), home);
	};
	const own = (root: string): string[] => {
		const folder = resolve(root, at);
		if (!inside(folder, root) || !existsSync(join(folder, ".git"))) return [];
		try { const real = realpathSync(folder); return inside(real, realpathSync(root)) && ownGitDir(real) ? [real] : []; } catch { return []; }
	};
	const found = [...new Set([...own(resolve(gitRoot(dir))), ...own(home)])];
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
