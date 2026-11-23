import { join, sep } from "node:path";
import { pathDenied, realish, resolveArg } from "./link/allow.ts";

// What a local tower run may call (docs/how-it-works.md, Tower runs: no shell). The sb server starts the run's pi with `--tools` naming exactly these (runs.ts), so a tool off the list is not even registered; the run
// mode's `tool_call` hook (runmode.ts) refuses the same names again, as a backstop for an extension that re-enables a tool, and refuses the file tools a path of the state folder or of a secret folder.

/** The file tools a run keeps, read-only: the merge-train routing reads a project's `.straw-boss/apps.json`, and an answer about where work stands may need a file. */
export const RUN_FILE_TOOLS = ["read", "grep", "find", "ls"] as const;
/** The tower tools of a local run: the ones its extension registers in `registerTools` (runmode.ts) and the server's brief names (towerbrief.ts, LOCAL_TOOLS), plus the boss-approved `link_request` and `boss_wait_ask`, whose dialog sb draws for the boss (waitask.ts). */
export const RUN_TOWER_TOOLS = ["boss_status", "call_tower", "boss_server", "tower_list", "board_read", "tower_send", "boss_open_main", "boss_close_main", "boss_revive_main", "tower_memory", "tower_reply", "tower_done", "link_request", "boss_wait_ask"] as const;
/** The `--tools` value of a local run's pi. */
export const LOCAL_RUN_TOOLS: readonly string[] = [...RUN_FILE_TOOLS, ...RUN_TOWER_TOOLS];
/** The tower tools of the head tower's run (docs/specs/2026-11-04-head-tower.md, Tools and limits): it lists, reads the board, forwards, keeps its memory, ends its run, and sees the server; it opens no tab, routes inside no workspace, and writes to no peer. */
export const HEAD_TOWER_TOOLS = ["tower_list", "board_read", "tower_send", "tower_memory", "tower_done", "boss_server", "boss_auto", "boss_wait_ask", "ledger_sweep"] as const;
/** The `--tools` value of the head tower's run. */
export const HEAD_RUN_TOOLS: readonly string[] = [...RUN_FILE_TOOLS, ...HEAD_TOWER_TOOLS];
const ALLOWED = new Set(LOCAL_RUN_TOOLS);
export const toolAllowed = (name: string, list: ReadonlySet<string> = ALLOWED) => list.has(name);
const HEAD_ALLOWED = new Set(HEAD_RUN_TOOLS);

export interface RunScope {
	cwd: string;
	home: string;
	agentDir: string;
	/** The state folder of the sb server (`server.json`, `gui.json`, `tower/<workspace>/memory.json`, the LAN, pairing, remote, and link files): everything in it is refused. */
	stateDir: string;
}
const within = (child: string, dir: string) => child === dir || child.startsWith(dir.endsWith(sep) ? dir : dir + sep);
/** Folders a search must not descend into: the state folder, the agent folder, and the secret folders of the home folder. */
const guarded = (s: RunScope) => [join(s.home, ".pi"), join(s.home, ".ssh"), join(s.home, ".aws"), join(s.home, ".config"), join(s.home, ".gnupg"), s.agentDir, s.stateDir].flatMap((d) => [d, realish(d)]);
/** Argument names that hold a path or a glob, by tool: `path` in all four, `pattern` in find only (in grep it is a regex), `glob` in grep only. */
const pathArgs = (tool: string) => (tool === "find" ? ["path", "pattern"] : tool === "grep" ? ["path", "glob"] : ["path"]);

/**
 * Why a call of `tool` with `input` may not go ahead, or undefined. A path argument is refused when it is on the deny list as written or once its symlinks are resolved (`pathDenied`, the deny list of ally runs with
 * the state folder added), and a search root (and a read of a directory by its parent) is refused too when it holds a guarded folder: `grep -r` from the home folder would read `server.json` without naming it.
 * `read` names one file, so only the first check applies to it.
 */
export function refusedPath(tool: string, input: Record<string, unknown>, s: RunScope): string | undefined {
	if (!(RUN_FILE_TOOLS as readonly string[]).includes(tool)) return undefined;
	const deny = { home: s.home, agentDir: s.agentDir, linkDir: s.stateDir };
	const search = tool !== "read";
	const roots: string[] = [];
	for (const key of pathArgs(tool)) {
		const v = input[key];
		if (typeof v !== "string" || !v) continue;
		// A glob is relative to the search root; only one that is absolute or starts at the home folder names a place of its own.
		if (key !== "path" && !/^(?:[a-zA-Z]:[\\/]|[\\/]|~|@)/.test(v)) continue;
		roots.push(resolveArg(key === "path" ? v : v.replace(/[*?[{].*$/, ""), s.cwd, s.home));
	}
	if (search && input.path === undefined) roots.push(s.cwd);
	const dirs = guarded(s);
	for (const p of roots) {
		// A UNC path (the admin share `\\\\localhost\\C$`) cannot be matched against the folders by name: refused.
		if (process.platform === "win32" && /^[\\/]{2}/.test(p)) return "a network path cannot be checked against the sb server's state; a tower run does not read it";
		if (pathDenied(p, deny)) return "that path holds the sb server's state or a secret; a tower run does not read it";
		if (search && [p, realish(p)].some((r) => dirs.some((d) => within(d, r)))) return "that search would descend into the sb server's state or a secret folder; a tower run searches below a project only";
	}
	return undefined;
}

/** The check of a run's call: `full` (a local run that is not a hand run) holds it to the list as well, any other run (ally, hand) to the path denial only. A check that fails refuses. */
export function refusedForRun(full: boolean | "head", tool: string, input: Record<string, unknown>, s: RunScope): string | undefined {
	if (full) return refusedInRun(tool, input, s, full === "head");
	try {
		return refusedPath(tool, input, s);
	} catch (error) {
		return `the path could not be checked (${(error as Error).message}); a run does not read it`;
	}
}

/** Why a local run's call of `tool` may not go ahead (it is not on the list, or its path is refused), or undefined. A check that fails refuses: a throw out of a tool_call hook blocks the call in pi too, but without a reason. */
function refusedInRun(tool: string, input: Record<string, unknown>, s: RunScope, head = false): string | undefined {
	if (head && !toolAllowed(tool, HEAD_ALLOWED)) return `${tool} is not available to the head tower: it has the tower tools tower_list, board_read, tower_send, tower_memory, tower_done, boss_server, boss_auto, boss_wait_ask, and ledger_sweep (on its scheduled notice only), and read-only file access (read, grep, find, ls). It does no work and opens no tabs: forward the work to the tower that owns it with tower_send.`;
	if (!head && !toolAllowed(tool)) return `${tool} is not available in a tower run: a run has the tower tools and read-only file access (read, grep, find, ls). Route work to the main that owns it, or open one with boss_open_main (the boss's own turn in a hand run has every tool).`;
	try {
		return refusedPath(tool, input, s);
	} catch (error) {
		return `the path could not be checked (${(error as Error).message}); a tower run does not read it`;
	}
}
