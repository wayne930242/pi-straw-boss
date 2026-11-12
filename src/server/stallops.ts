import { statSync } from "node:fs";
import { openCalls } from "../ask.ts";
import { type HerdrRun, isSub, panes as herdrPanes, parentOf, type Session, type Workspace, workspaces as herdrWorkspaces } from "../herdr.ts";
import { createStallWatch, type Flag, readStallWatch, type StallDeps, type StallWatch } from "./stallwatch.ts";
import { inTestRun } from "./testguard.ts";
import { towerRunsEnabled } from "./towerruns.ts";
import type { Towers } from "./towers.ts";

// The server's side of the stall watch (stallwatch.ts): what it reads of this machine (pi-intercom's list, Herdr's panes, the session files) and the tower it tells. Kept out of main.ts, which carries a line budget.

export interface StartStall {
	/** The slot's folder and the state folder (`config.json`). */
	dir: string;
	stateDir: string;
	pid: number;
	platform: NodeJS.Platform;
	now(): number;
	log(event: string, facts: Record<string, number | string | boolean>): void;
	run: HerdrRun;
	/** pi-intercom's list as the server's own connection sees it; rejects while it is not connected. */
	sessions(): Promise<Session[]>;
	towers(): Pick<Towers, "status" | "head" | "runs"> | undefined;
	/** The seams of a test; in a test run there is no watch without them (it would read the panes of a fake Herdr every minute). */
	over?: Partial<StallDeps>;
}

/**
 * The workspace whose tower hears of a session in `workspace`: its own when the server stands in for a tower there, its parent's for a sub workspace (which never has a tower), else the head tower's;
 * none when there is neither.
 */
export function stallTarget(workspace: string | undefined, all: readonly Workspace[], served: readonly string[], head: string | undefined): string | undefined {
	const asked = all.find((w) => w.workspace_id === workspace), target = asked && isSub(asked) ? parentOf([...all], asked) : asked;
	return target && served.includes(target.workspace_id) ? target.workspace_id : head;
}

/** The notice is one event in the tower's queue: a key that is still waiting there is not queued twice. */
export async function tellTower(flag: Flag, run: HerdrRun, towers: ReturnType<StartStall["towers"]>): Promise<boolean> {
	if (!towers) return false;
	const to = stallTarget(flag.workspace, await herdrWorkspaces(run).catch(() => []), towers.status().map((r) => r.workspace), towers.head.status()?.workspace);
	return to !== undefined && towers.runs.notice(to, flag.text, `stall:${flag.pid}:${flag.started}:${flag.kind}:${flag.told}`);
}

/** The watch of this server, or none: on Windows (there is no process table), and in a test run without seams. */
export function startStall(o: StartStall): StallWatch | undefined {
	if (o.platform === "win32" || (inTestRun() && !o.over)) return undefined;
	let noTower = false;
	return createStallWatch({
		dir: o.dir, now: o.now, log: o.log, self: [o.pid], config: () => readStallWatch(o.stateDir),
		sessions: async () => (await o.sessions()).flatMap((s) => {
			// SAFETY: pi-intercom's list carries each session's pid (its `SessionInfo`); herdr.ts names only the fields the net reads.
			const pid = (s as { pid?: unknown }).pid;
			// The pane is the one the broker found the session in at this list (`current`). A location it could not resolve carries the pane the session was started in, which a move has renamed since: no pane then.
			const at = s.herdrLocation?.status === "current" ? s.herdrLocation : undefined;
			return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 ? [{ id: s.id, ...(s.name ? { name: s.name } : {}), pid, ...(at?.paneId ? { pane: at.paneId } : {}), ...(at?.workspace?.id ? { workspace: at.workspace.id } : {}) }] : [];
		}),
		panes: async () => (await herdrPanes(o.run)).map((p) => ({ pane: p.pane_id, ...(p.terminal_id ? { terminal: p.terminal_id } : {}), ...(p.workspace_id ? { workspace: p.workspace_id } : {}), pi: p.agent === "pi", working: p.agent_status === "working", ...(p.agent_session?.value ? { file: p.agent_session.value } : {}), ...(p.tokens?.sb_role ? { role: p.tokens.sb_role } : {}) })),
		paneProcs: async (pane) => {
			const info = (JSON.parse(await o.run(["pane", "process-info", "--pane", pane])) as { result?: { process_info?: { shell_pid?: unknown; foreground_processes?: { pid?: unknown; name?: unknown; argv0?: unknown }[] } } }).result?.process_info;
			if (!info) return undefined;
			const word = (v: unknown) => (typeof v === "string" ? { v } : undefined);
			return { ...(typeof info.shell_pid === "number" ? { shell: info.shell_pid } : {}), foreground: (info.foreground_processes ?? []).flatMap((p) => (typeof p.pid === "number" && p.pid > 1 ? [{ pid: p.pid, ...(word(p.name) ? { name: word(p.name)!.v } : {}), ...(word(p.argv0) ? { argv0: word(p.argv0)!.v } : {}) }] : [])) };
		},
		mtime: (file) => { try { return statSync(file).mtimeMs; } catch { return undefined; } },
		openCalls: async (file) => { const found = await openCalls(file); return found === "cut" ? undefined : found.length; },
		// With `towerRuns.enabled: false` the towers are resident pi sessions and the server stands in for none, so nobody is told: the log says so once, and each incident is in it as `stall-untold`.
		tell: async (flag) => {
			if (towerRunsEnabled(o.stateDir)) return (noTower = false), tellTower(flag, o.run, o.towers());
			if (!noTower) (noTower = true), o.log("stall-no-tower", { text: "towerRuns.enabled is off in config.json, so the server stands in for no tower: the stall watch tells nobody, and its incidents are in this log only" });
			return false;
		},
		...o.over,
	});
}
