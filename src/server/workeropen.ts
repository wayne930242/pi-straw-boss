import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileExe } from "../exe.mjs";
import { OpenLimitError } from "../opener.ts";
import { branchProblem, type WorkerSpec } from "../workerslip.ts";
import type { WorkerOpen } from "../workerhandoff.ts";

// The box's git for a worker opened for a teammate's device (docs/specs/2026-11-26-ally-workers.md, Device side): the config it needs, the branch and base rules, the worktree it makes before pi starts, and the
// cleanup when it closes. Git runs with no shell, argument lists, `GIT_TERMINAL_PROMPT=0`, and a timeout; it fetches from `origin` only. A refusal is an OpenLimitError, which keeps no ledger row, so the same slip may be sent again.

const MODEL = /^[A-Za-z0-9._:/@-]{1,120}$/, HEX40 = /^[0-9a-f]{40}$/, GIT_MS = 30_000, FETCH_MS = 90_000;

/** `workers` of `<state dir>/config.json`: the models a worker may run on (`models`, exact ids). None without the section: the box opens no workers. Read at each open. */
export function readWorkers(stateDir: string): { models: string[] } | undefined {
	let w: unknown;
	try { w = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { workers?: unknown }).workers; } catch { return undefined; }
	if (typeof w !== "object" || w === null) return undefined;
	const models = (w as { models?: unknown }).models;
	return { models: Array.isArray(models) ? models.filter((m): m is string => typeof m === "string" && MODEL.test(m)) : [] };
}
/** Why the model is refused: one off the allowlist (an omitted model is pi's default and always taken). */
export const modelRefusal = (models: readonly string[], model: string | undefined) => (model === undefined || models.includes(model) ? undefined : `model ${model} is not in this box's workers.models (${models.length ? models.join(", ") : "none listed"}); leave it out for pi's default`);

export type Git = (args: string[], cwd: string, timeoutMs?: number) => Promise<string>;
/** git with no shell and no prompt; rejects with git's own words. */
export const runGit: Git = (args, cwd, timeoutMs = GIT_MS) => new Promise((done, fail) => {
	execFileExe("git", args, { cwd, deadline: timeoutMs, maxBuffer: 4 << 20, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" } }, (error, stdout, stderr) => {
		if (error) fail(new Error(`git ${args[0]} failed: ${(stderr || error.message).toString().trim().slice(0, 300)}`));
		else done(stdout.toString().trim());
	});
});
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);

/** The prepared worktree, and whether the branch was made here (a failed open deletes only a branch it made). */
export interface Prepared extends Omit<WorkerOpen, "label" | "points" | "model"> { baseSha: string; repo: string; made: boolean }

/**
 * Makes the worktree for `spec` from the workspace checkout `checkout`: `~/.herdr/worktrees/<repo>/<branch, / as ->`, which must not exist. With `origin/<branch>` the worktree starts from it (a rework); a local branch
 * that origin does not have, or that differs from origin's, is refused. Else the base is `origin/<base>`, a 40-hex commit, or origin's default branch.
 */
export async function prepareWorktree(o: { checkout: string; spec: WorkerSpec; home: string; reserved?: readonly string[]; git?: Git }): Promise<Prepared> {
	const git = o.git ?? runGit, { branch } = o.spec;
	const problem = branchProblem(branch, o.reserved ?? []);
	if (problem) throw new OpenLimitError(`branch ${branch} ${problem}`);
	const refuse = (cause: Error) => { throw new OpenLimitError(cause.message); };
	const { dir, repo } = await worktreeOf({ checkout: o.checkout, branch, home: o.home, git });
	await git(["fetch", "--quiet", "--no-tags", "origin"], o.checkout, FETCH_MS).catch(refuse);
	const sha = (ref: string) => git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], o.checkout).catch(() => "");
	const remote = await sha(`refs/remotes/origin/${branch}`), local = await sha(`refs/heads/${branch}`);
	if (local && !remote) throw new OpenLimitError(`branch ${branch} exists on this box but not on origin: a worker takes a new branch or one origin has`);
	if (local && local !== remote) throw new OpenLimitError(`branch ${branch} on this box differs from origin/${branch}: nothing opens over it`);
	let base: string, baseSha: string;
	if (remote) (base = `origin/${branch}`), (baseSha = remote);
	else if (o.spec.base && HEX40.test(o.spec.base)) {
		if (!(await ok(git(["cat-file", "-e", `${o.spec.base}^{commit}`], o.checkout)))) throw new OpenLimitError(`base ${o.spec.base} is no commit this box has after fetching origin`);
		(base = o.spec.base), (baseSha = o.spec.base);
	} else {
		const name = o.spec.base ? o.spec.base.replace(/^origin\//, "") : (await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], o.checkout).catch(() => "")).replace(/^origin\//, "");
		if (!name) throw new OpenLimitError("origin names no default branch here: give base");
		baseSha = await sha(`refs/remotes/origin/${name}`);
		if (!baseSha) throw new OpenLimitError(`base origin/${name} does not exist`);
		base = `origin/${name}`;
	}
	if (existsSync(dir)) throw new OpenLimitError(`the worktree ${dir} exists already: one worker per branch`);
	const made = !local;
	await git(made ? ["worktree", "add", "--no-track", "-b", branch, "--", dir, baseSha] : ["worktree", "add", "--", dir, branch], o.checkout).catch(refuse);
	return { dir, branch, base, baseSha, repo, made, ...(remote ? { rework: true } : {}) };
}

/** The worktree a branch's worker gets, `~/.herdr/worktrees/<repo>/<branch, / as ->`: derived from the checkout's repository each time, never read from a record. */
export async function worktreeOf(o: { checkout: string; branch: string; home: string; git?: Git }): Promise<{ dir: string; repo: string; common: string }> {
	const git = o.git ?? runGit, refuse = (cause: Error) => { throw new OpenLimitError(cause.message); };
	await git(["check-ref-format", "--branch", o.branch], o.checkout).catch(refuse);
	const common = resolve(o.checkout, await git(["rev-parse", "--git-common-dir"], o.checkout).catch(refuse));
	const repo = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
	return { dir: join(o.home, ".herdr", "worktrees", repo, o.branch.replace(/\//g, "-")), repo, common };
}

/** A failed open: nothing was handed over, so the worktree goes, and the branch if this open made it. */
export async function dropWorktree(o: { checkout: string; prepared: Pick<Prepared, "dir" | "branch" | "made">; git?: Git }): Promise<void> {
	const git = o.git ?? runGit;
	await git(["worktree", "remove", "--force", "--", o.prepared.dir], o.checkout).catch(() => undefined);
	if (o.prepared.made) await git(["branch", "-D", "--", o.prepared.branch], o.checkout).catch(() => undefined);
}

/**
 * The worker closed: its worktree goes only when it is clean and its HEAD is on `origin/<branch>` (pushed) or is still the base (nothing done); its local branch goes with it. Otherwise it is kept, and the reason says why.
 */
export async function closeWorktree(o: { checkout?: string; dir: string; branch: string; baseSha?: string; git?: Git }): Promise<{ removed: true; head: string } | { removed: false; reason: string; head?: string }> {
	const git = o.git ?? runGit;
	if (!existsSync(o.dir)) return { removed: false, reason: "the worktree is gone already" };
	const head = await git(["rev-parse", "HEAD"], o.dir).catch(() => "");
	if (!head) return { removed: false, reason: "its HEAD cannot be read" };
	if ((await git(["status", "--porcelain"], o.dir).catch(() => "?")) !== "") return { removed: false, reason: "it has uncommitted changes", head };
	await git(["fetch", "--quiet", "--no-tags", "origin"], o.dir, FETCH_MS).catch(() => undefined);
	const pushed = await ok(git(["merge-base", "--is-ancestor", head, `refs/remotes/origin/${o.branch}`], o.dir));
	if (!pushed && head !== o.baseSha) return { removed: false, reason: `HEAD ${head.slice(0, 12)} is not on origin/${o.branch}`, head };
	const common = resolve(o.dir, await git(["rev-parse", "--git-common-dir"], o.dir).catch(() => ".git")), checkout = o.checkout ?? (basename(common) === ".git" ? dirname(common) : common);
	await git(["worktree", "remove", "--", o.dir], checkout).catch(() => undefined);
	if (existsSync(o.dir)) return { removed: false, reason: "git worktree remove failed", head };
	// The branch goes only when it points at the HEAD just checked: a branch moved past it in the worktree keeps its commits (RV-F005).
	if ((await git(["rev-parse", "--verify", "--quiet", `refs/heads/${o.branch}`], checkout).catch(() => "")) === head) await git(["branch", "-D", "--", o.branch], checkout).catch(() => undefined);
	return { removed: true, head };
}

/** apps.json's `integration.base` of every app of the checkout: integration branches no worker takes. */
export function integrationBases(checkout: string, read: (dir: string) => { ok: boolean; apps?: Record<string, unknown>[] }): string[] {
	const got = read(checkout);
	return (got.ok ? got.apps ?? [] : []).flatMap((a) => ((i) => (typeof i === "object" && i !== null && typeof (i as { base?: unknown }).base === "string" ? [(i as { base: string }).base] : []))(a.integration));
}
