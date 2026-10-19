// What the reaper reaches outside itself with: its state file and locks, the herdr CLI, and git.
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { applyOps, emptyState } from "./decide.mjs";

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` while holding a directory lock, which `mkdir` makes atomic. A lock older than staleMs belongs to a run that died.
 * With waitMs of 0 a held lock returns `held` at once instead of waiting.
 */
export async function withLock(dir, name, work, { waitMs = 5000, staleMs = 120_000 } = {}) {
	const lock = join(dir, `${name}.lock`);
	await mkdir(dir, { recursive: true });
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			await mkdir(lock);
			break;
		} catch (error) {
			if (error.code !== "EEXIST") throw error;
			const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
			if (age > staleMs) {
				await rmdir(lock).catch(() => {});
				continue;
			}
			if (Date.now() >= deadline) return { held: true };
			await sleep(50);
		}
	}
	try {
		return { held: false, value: await work() };
	} finally {
		await rmdir(lock).catch(() => {});
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
			({ stdout } = await run(bin, args, { maxBuffer: 16 * 1024 * 1024 }));
		} catch (error) {
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
		renameWorkspace: (id, label) => call(["workspace", "rename", id, label]),
		setToken: (id, source, name, value) => call(["workspace", "report-metadata", id, "--source", source, "--token", `${name}=${value}`]),
		clearToken: (id, source, name) => call(["workspace", "report-metadata", id, "--source", source, "--clear-token", name]),
	};
}

/** git, read-only except `removeWorktree`, which never forces. */
export function gitClient() {
	const git = async (args) => (await run("git", args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
	return {
		exists: (path) => existsSync(path),
		realpath: (path) => {
			try {
				return realpathSync(path);
			} catch {
				return path;
			}
		},
		// Spelled out so a repository's or user's config cannot hide files from it: `status.showUntrackedFiles=no` and submodule
		// ignore settings change what a plain `status` prints, and --no-optional-locks keeps a read from touching the index.
		status: (checkout) => git(["--no-optional-locks", "-C", checkout, "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"]),
		// Tracked files git is told not to look at: skip-worktree (`S`) and assume-unchanged (lowercase), whose edits status never shows.
		hidden: async (checkout) =>
			(await git(["--no-optional-locks", "-C", checkout, "ls-files", "-v", "-z"]))
				.split("\0")
				.filter((entry) => /^[a-zS] /.test(entry))
				.map((entry) => entry.slice(2))
				.join("\n"),
		branch: (checkout) => git(["-C", checkout, "symbolic-ref", "--quiet", "--short", "HEAD"]).then((out) => out.trim(), () => null),
		containedBy: (checkout) => git(["-C", checkout, "for-each-ref", "--contains", "HEAD", "refs/heads", "refs/remotes", "refs/tags"]),
		removeWorktree: (repoRoot, checkout) => git(["-C", repoRoot, "worktree", "remove", checkout]),
	};
}
