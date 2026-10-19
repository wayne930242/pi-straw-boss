// What the reaper reaches outside itself with: its state file and locks, the herdr CLI, and git.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyOps, emptyState } from "./decide.mjs";

const run = promisify(execFile);
// A hung herdr or git call must not hold the sweep lock for good; a call that outlasts its timeout is killed and fails.
const HERDR_TIMEOUT_MS = 30_000;
const GIT_TIMEOUT_MS = 60_000;
// Removing a checkout deletes every ignored file in it, `node_modules` among them.
const GIT_REMOVE_TIMEOUT_MS = 5 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` while holding a directory lock, which `mkdir` makes atomic. The holder writes an owner token into it and touches it
 * while it works, so a lock older than staleMs belongs to a run that died. Only one waiter at a time judges and removes a stale
 * lock (a second directory lock guards that), so a waiter cannot remove the fresh lock another one has just made. The holder
 * releases the lock only if the token is still its own.
 * With waitMs of 0 a held lock returns `held` at once instead of waiting.
 */
export async function withLock(dir, name, work, { waitMs = 5000, staleMs = 120_000 } = {}) {
	const lock = join(dir, `${name}.lock`);
	const owner = randomUUID();
	await mkdir(dir, { recursive: true });
	const ageOf = (path) => stat(path).then((info) => Date.now() - info.mtimeMs, () => 0);
	const remove = (path) => rm(path, { recursive: true, force: true });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			await mkdir(lock);
			await writeFile(join(lock, "owner"), owner);
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			if ((await ageOf(lock)) > staleMs) {
				await takeOverStale(lock, staleMs, ageOf, remove);
				continue;
			}
			if (Date.now() >= deadline) return { held: true };
			await sleep(50);
		}
	}
	const heartbeat = setInterval(() => utimes(lock, new Date(), new Date()).catch(() => {}), Math.max(10, staleMs / 4));
	heartbeat.unref();
	try {
		return { held: false, value: await work() };
	} finally {
		clearInterval(heartbeat);
		if ((await readFile(join(lock, "owner"), "utf8").catch(() => null)) === owner) await remove(lock);
	}
}

/** Removes a lock that looked stale, once the stale check has been repeated under the takeover lock. */
async function takeOverStale(lock, staleMs, ageOf, remove) {
	const takeover = `${lock}.takeover`;
	try {
		await mkdir(takeover);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		// Another waiter is judging; a takeover lock that old belongs to a waiter that died.
		if ((await ageOf(takeover)) > staleMs) await remove(takeover);
		await sleep(50);
		return;
	}
	try {
		if ((await ageOf(lock)) > staleMs) await remove(lock);
	} finally {
		await remove(takeover);
	}
}

/** The plugin's state file: read whole, changed only through ops under a short lock so concurrent runs merge. */
export function createStore(dir) {
	const file = join(dir, "state.json");
	// Only a missing file is an empty state. Any other failure throws: an empty state would bring back the first-run rule (every
	// agent-less pane is a leftover) and forget every pin that lives only in this file.
	const read = async () => {
		let text;
		try {
			text = await readFile(file, "utf8");
		} catch (error) {
			if (error.code === "ENOENT") return emptyState();
			throw new Error(`cannot read the state file ${file}: ${error.message}`);
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new Error(`the state file ${file} is damaged (${error.message}); repair or remove it`);
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`the state file ${file} is damaged (not an object); repair or remove it`);
		return { ...emptyState(), ...parsed };
	};
	return {
		dir,
		read,
		async apply(ops) {
			if (ops.length === 0) return;
			const outcome = await withLock(dir, "state", async () => {
				const next = applyOps(await read(), ops);
				await writeFile(`${file}.tmp`, `${JSON.stringify(next, null, "\t")}\n`);
				await rename(`${file}.tmp`, file);
			});
			if (outcome.held) throw new Error("state file is locked");
		},
	};
}

/** Optional `config.json` in the plugin's config directory: `only_under`, a list of directories that limits the plugin to repositories and checkouts below them. */
export async function loadConfig(dir) {
	try {
		return JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return {};
		throw new Error(`cannot read ${join(dir, "config.json")}: ${error.message}`);
	}
}

/** The herdr CLI: every call prints one JSON line whose `result` is returned; an `error` or a failed exit throws. */
export function herdrClient(bin = "herdr") {
	const call = async (args) => {
		let stdout;
		try {
			({ stdout } = await run(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: HERDR_TIMEOUT_MS }));
		} catch (error) {
			if (error.killed) throw new Error(`herdr ${args.join(" ")} failed: no answer within ${HERDR_TIMEOUT_MS / 1000}s`);
			throw new Error(`herdr ${args.join(" ")} failed: ${(error.stderr || error.stdout || error.message).toString().trim().slice(0, 300)}`);
		}
		const reply = stdout.trim() ? JSON.parse(stdout) : {};
		if (reply.error) throw new Error(`herdr ${args.join(" ")} failed: ${reply.error.code} ${reply.error.message}`);
		return reply.result ?? {};
	};
	return {
		call,
		listWorkspaces: async () => (await call(["workspace", "list"])).workspaces ?? [],
		listPanes: async () => (await call(["pane", "list"])).panes ?? [],
		getWorkspace: async (id) => (await call(["workspace", "get", id])).workspace,
		getPane: async (id) => (await call(["pane", "get", id])).pane,
		processInfo: async (id) => (await call(["pane", "process-info", "--pane", id])).process_info,
		closePane: (id) => call(["pane", "close", id]),
		// Never the group form: Herdr refuses to close a workspace that still has worktree children, and that refusal must stand.
		closeWorkspace: (id) => call(["workspace", "close", id]),
		renameWorkspace: (id, label) => call(["workspace", "rename", id, label]),
		setToken: (id, source, name, value) => call(["workspace", "report-metadata", id, "--source", source, "--token", `${name}=${value}`]),
		clearToken: (id, source, name) => call(["workspace", "report-metadata", id, "--source", source, "--clear-token", name]),
	};
}

/**
 * What git itself said when a command failed: its first `fatal:` or `error:` line, else its first stderr line. node's own message
 * starts with a "Command failed: git ..." header that says nothing about why.
 */
export function gitReason(error) {
	const lines = String(error.stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
	const reason = lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0];
	if (reason) return reason.slice(0, 300);
	return String(error.message ?? error).split("\n").find((line) => line.trim() && !line.startsWith("Command failed:"))?.trim() ?? "git failed without a message";
}

const STATUS_ARGS = (checkout) => ["--no-optional-locks", "-C", checkout, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"];

/** Tracked files git is told not to look at: skip-worktree (`S`) and assume-unchanged (lowercase), whose edits status never shows. */
async function hiddenFiles(git, checkout) {
	return (await git(["--no-optional-locks", "-C", checkout, "ls-files", "-v", "-z"]))
		.split("\0")
		.filter((entry) => /^[a-z] /.test(entry) || (entry.startsWith("S ") && existsSync(join(checkout, entry.slice(2)))))
		.map((entry) => entry.slice(2))
		.join("\n");
}

/** git, read-only except `deinitSubmodules` and `removeWorktree`, which never forces. */
export function gitClient() {
	const git = async (args, timeout = GIT_TIMEOUT_MS) => {
		try {
			return (await run("git", args, { maxBuffer: 16 * 1024 * 1024, timeout })).stdout;
		} catch (error) {
			if (error.killed) throw Object.assign(new Error(`git ${args.join(" ")} did not finish within ${timeout / 1000}s`), { timedOut: true });
			throw error;
		}
	};
	return {
		exists: (path) => existsSync(path),
		realpath: (path) => {
			try {
				return realpathSync.native(path);
			} catch {
				return path;
			}
		},
		// Spelled out so a repository's or user's config cannot hide files from it: `status.showUntrackedFiles=no` and submodule
		// ignore settings change what a plain `status` prints, and --no-optional-locks keeps a read from touching the index.
		status: (checkout) => git(STATUS_ARGS(checkout)),
		// Tracked files git is told not to look at: skip-worktree (`S`) and assume-unchanged (lowercase), whose edits status never shows.
		// Skip-worktree files missing on disk are what a sparse checkout leaves out; they hide no edit, so they do not count.
		hidden: (checkout) => hiddenFiles(git, checkout),
		branch: (checkout) => git(["-C", checkout, "symbolic-ref", "--quiet", "--short", "HEAD"]).then((out) => out.trim(), () => null),
		containedBy: (checkout) => git(["-C", checkout, "for-each-ref", "--contains", "HEAD", "refs/heads", "refs/remotes", "refs/tags"]),
		// Every initialized submodule below the checkout (recursively) with what deleting its repository would lose. In a linked worktree
		// that repository lives in the main repository's `.git/worktrees/<id>/modules/...` and goes with the worktree's admin directory,
		// so only a remote-tracking ref, or a ref of the main repository's own copy of the module, keeps a commit.
		submodules: async (checkout) => {
			const listed = await git(["-C", checkout, "submodule", "foreach", "--quiet", "--recursive", 'printf "%s\\0" "$displaypath"']).catch((error) => {
				throw new Error(gitReason(error));
			});
			const found = [];
			for (const path of listed.split("\0").filter(Boolean)) {
				const dir = join(checkout, path);
				const [dirty, hidden, head, gitDir] = await Promise.all([
					git(STATUS_ARGS(dir)),
					hiddenFiles(git, dir),
					git(["-C", dir, "rev-parse", "HEAD"]).then((out) => out.trim()),
					git(["-C", dir, "rev-parse", "--absolute-git-dir"]).then((out) => out.trim()),
				]);
				const refsContaining = (gitArgs, refs) => git([...gitArgs, "for-each-ref", "--contains", head, ...refs]).then((out) => out.trim(), () => "");
				const own = await refsContaining(["-C", dir], ["refs/remotes"]);
				const shared = /^(.*)\/worktrees\/[^/]+\/modules\/(.+)$/.exec(gitDir);
				const main = shared && existsSync(join(shared[1], "modules", shared[2])) ? await refsContaining(["--git-dir", join(shared[1], "modules", shared[2])], ["refs/heads", "refs/remotes", "refs/tags"]) : "";
				// A local branch ahead of every remote-tracking ref is lost with the repository even when HEAD is safe.
				const ahead = (await git(["-C", dir, "rev-list", "--branches", "--not", "--remotes", "--max-count=1"]).catch(() => "")).trim() !== "";
				found.push({ path, dirty, hidden, head, kept: Boolean(own || main), ahead });
			}
			return found;
		},
		// Plain `deinit` (never --force: it refuses a submodule with local modifications, which the checks already ruled out) empties the
		// submodules' directories, but `git worktree remove` still refuses while the worktree's admin directory holds their repositories.
		// Those are what the checks proved safe to lose, so exactly that directory (`.git/worktrees/<id>/modules`) is deleted too.
		deinitSubmodules: async (checkout) => {
			try {
				await git(["-C", checkout, "submodule", "deinit", "--all"], GIT_REMOVE_TIMEOUT_MS);
				const adminDir = (await git(["-C", checkout, "rev-parse", "--absolute-git-dir"])).trim();
				if (!/\/worktrees\/[^/]+$/.test(adminDir)) throw new Error(`${adminDir} is not a linked worktree's admin directory`);
				await rm(join(adminDir, "modules"), { recursive: true, force: true });
			} catch (error) {
				if (error.timedOut) throw error;
				throw Object.assign(new Error(error.stderr === undefined ? error.message : gitReason(error)), { timedOut: false });
			}
		},
		removeWorktree: (repoRoot, checkout) =>
			git(["-C", repoRoot, "worktree", "remove", checkout], GIT_REMOVE_TIMEOUT_MS).catch((error) => {
				throw Object.assign(new Error(error.timedOut ? error.message : gitReason(error)), { timedOut: error.timedOut === true });
			}),
		// What a failed removal left behind. `git worktree remove` deletes the checkout's `.git` file and its admin entry before the
		// files, so a failure partway can leave a directory git no longer knows about. "unknown" when git cannot be asked.
		leftover: async (repoRoot, checkout) => {
			if (!existsSync(checkout)) return "gone";
			if (!existsSync(join(checkout, ".git"))) return "half-removed";
			try {
				const here = realpathSync.native(checkout);
				const registered = (await git(["-C", repoRoot, "worktree", "list", "--porcelain", "-z"])).split("\0").filter((field) => field.startsWith("worktree "));
				const known = registered.some((field) => {
					const path = field.slice("worktree ".length);
					try {
						return realpathSync.native(path) === here;
					} catch {
						return path === checkout;
					}
				});
				return known ? "intact" : "half-removed";
			} catch {
				return "unknown";
			}
		},
	};
}
