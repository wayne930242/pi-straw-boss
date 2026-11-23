import { statSync } from "node:fs";
import { type HerdrRun, type Pane, panes, type Session, workspaces } from "./herdr.ts";
import { ledgerPath, REVIVE_TOKEN } from "./revive.ts";
import { readRecords } from "./roles.ts";

// A tower closes an agent pane whose pi is gone (docs/specs/2026-11-23-tower-close-panes.md §3). Whether it may is decided by one table here, as dead.ts decides a death: the callers gather the facts, and
// `refusal` alone gives the answer. The cheap rows come first, so process-info is asked only of a pane that passed them.
//
// | row       | evidence                                                                                                                              | close |
// |-----------|---------------------------------------------------------------------------------------------------------------------------------------|-------|
// | missing   | Herdr lists no such pane                                                                                                              | no    |
// | elsewhere | the pane is not in the tower's workspace                                                                                             | no    |
// | tower     | the tower's own pane, a pane of its tab, the pane of the workspace's tower session, or a pane marked `sb_role` tower or head (a standing pane waits at its shell between runs) | no    |
// | unmarked  | no `sb_*` or `piha_*` token and no pi session Herdr names: a plain shell, never an agent's                                             | no    |
// | opening   | the one-time claim (`sb_open_main`) or a revive's key waits in it: an open, a revive, or a handover is starting its pi                | no    |
// | reviving  | a revive holds the lock of a session whose role record names this pane                                                                | no    |
// | listed    | the broker lists a session at it: its pi lives                                                                                        | no    |
// | agent     | Herdr reports an agent in it (`agent`): a pi that has not joined the broker, or lost it, still runs                                  | no    |
// | busy      | process-info lists anything but the shell in the foreground (a pi, a dev server), or cannot tell                                       | no    |
// | windows   | the platform is win32: process-info there names the shell alone even while a program runs under it (typegate.ts), so nothing is proven  | no    |
// | dead      | none of the above                                                                                                                     | yes   |

/** How long a revive lock holds (revive.ts `takeLock` takes over an older one). */
const LOCK_MS = 5 * 60_000;
export interface ProcessInfo { shell_pid?: number; foreground_processes?: { pid?: number; name?: string; argv0?: string }[] }
export interface PaneFacts {
	pane?: Pane;
	query: string;
	workspace: string;
	/** The tower's own pane and tab, and the pane of the workspace's tower session. */
	tower: { pane: string; tab?: string; session?: string };
	listed?: Session;
	reviving: boolean;
}
/** A pane's marks of an agent: Straw Boss's tokens, pi-herdr-agents' (`piha_`), or a pi session Herdr's integration named. */
export const marked = (p: Pane) => Object.keys(p.tokens ?? {}).some((k) => k.startsWith("sb_") || k.startsWith("piha_")) || Boolean(p.agent_session?.value);
/** Why the tower may not close the pane, before process-info is asked; undefined when only the foreground is left to prove. */
export function refusal(f: PaneFacts): string | undefined {
	const p = f.pane, id = f.query;
	if (!p) return `No pane ${id} in Herdr's list`;
	if (p.workspace_id !== f.workspace) return `${id} is not in this workspace; a tower closes only its own workspace's panes`;
	const role = p.tokens?.sb_role;
	if (p.pane_id === f.tower.pane || (f.tower.tab !== undefined && p.tab_id === f.tower.tab) || p.pane_id === f.tower.session || role === "tower" || role === "head") return `${id} is a tower's pane; a tower never closes one`;
	if (!marked(p)) return `${id} carries no mark of an agent (no Straw Boss or pi token): it is no agent pane, so the boss closes it`;
	if (p.tokens?.sb_open_main !== undefined || p.tokens?.[REVIVE_TOKEN] !== undefined) return `${id} is being opened right now (an open, a revive, or a handover is starting its pi)`;
	if (f.reviving) return `${id} is being revived right now (a tower holds the revive lock of its session)`;
	if (f.listed) return `${id} is not dead: a live session (${f.listed.name ?? f.listed.id}) is at it`;
	if (p.agent) return `${id} runs ${p.agent}, so it is not dead`;
	return undefined;
}
/** Why the foreground is no bare shell; undefined when the shell alone is there (`process-info` proof, as a revive's D3 takes it). */
export function notBare(id: string, info: ProcessInfo | undefined): string | undefined {
	const fg = info?.foreground_processes ?? [];
	if (typeof info?.shell_pid !== "number" || !fg.length) return `Herdr cannot show what runs in ${id}, so it is not proven dead`;
	if (fg.length === 1 && fg[0]!.pid === info.shell_pid) return undefined;
	const names = [...new Set(fg.filter((x) => x.pid !== info.shell_pid).map((x) => x.name ?? x.argv0 ?? `pid ${x.pid}`))].slice(0, 4).join(", ");
	return `${id} is not at a bare shell: ${names} runs in it`;
}
/** What the pane was, for the list: its role and the name its tokens kept. */
export const paneWhat = (p: Pane) => {
	const t = p.tokens ?? {}, kind = t.sb_role ?? (t.sb_train ? "train" : Object.keys(t).some((k) => k.startsWith("piha_")) ? "subagent" : "pi"), name = t.sb_main_tab ?? t.sb_name ?? t.sb_tab ?? t.sb_member_tab;
	return name ? `${kind} ${name}` : kind;
};
export interface DeadPane { pane: string; tab: string; what: string; /** The tab's only pane: the tab closes with it. */ alone: boolean }
/** The list `boss_close_main` gives with neither main nor pane. */
export const deadList = (rows: DeadPane[]) => ({
	text: rows.length ? `Dead agent panes of this workspace (close one with boss_close_main pane):\n${rows.map((r) => `- ${r.pane} (tab ${r.tab}${r.alone ? ", its only pane" : ""}): ${r.what}`).join("\n")}` : "No dead agent pane in this workspace.",
	details: rows,
});
export interface ClosedPane { text: string; pane: string; tab?: string }
/** `here`: the tower's workspace and own pane, read at each call (a session learns them at its start). */
export interface DeadPaneEnv { run: HerdrRun; sessions(): Promise<Session[]>; here(): { workspace: string; pane: string }; stateDir: string; now(): number; /** `process.platform` unless a test gives one. */ platform?: NodeJS.Platform }
/** The refusal on Windows, before anything is read: no row of the table can prove a bare shell there. */
export const WINDOWS_REFUSAL = "Dead agent panes are listed and closed on macOS and Linux only: on Windows Herdr's process-info names the shell alone even while a program runs under it, so no pane is proven dead; the boss closes it";

export function createDeadPanes(env: DeadPaneEnv) {
	const { run } = env;
	const platform = env.platform ?? process.platform;
	const onWindows = () => {
		if (platform === "win32") throw new Error(WINDOWS_REFUSAL);
	};
	const reviving = (p: Pane) => readRecords(env.stateDir).some(({ record }) => {
		if (record.pane !== p.pane_id || record.workspace !== p.workspace_id) return false;
		try { return env.now() - statSync(`${ledgerPath(env.stateDir, record.file)}.lock`).mtimeMs < LOCK_MS; } catch { return false; }
	});
	const look = async () => {
		const [all, sessions, ws] = await Promise.all([panes(run), env.sessions(), workspaces(run)]);
		const here = env.here(), towerId = ws.find((w) => w.workspace_id === here.workspace)?.tokens?.tower;
		const own = all.find((p) => p.pane_id === here.pane);
		const tower = { pane: here.pane, ...(own ? { tab: own.tab_id } : {}), ...((s) => (s ? { session: s } : {}))(sessions.find((x) => x.id === towerId)?.herdrLocation?.paneId) };
		const facts = (query: string): PaneFacts => {
			const pane = all.find((p) => p.pane_id === query);
			return { query, workspace: here.workspace, tower, reviving: pane ? reviving(pane) : false, ...(pane ? { pane } : {}), ...((x) => (x ? { listed: x } : {}))(sessions.find((x) => x.herdrLocation?.paneId === query)) };
		};
		return { all, facts, workspace: here.workspace };
	};
	const info = async (pane: string) => JSON.parse(await run(["pane", "process-info", "--pane", pane])).result?.process_info as ProcessInfo | undefined;
	const why = async (f: PaneFacts) => refusal(f) ?? notBare(f.query, await info(f.query).catch(() => undefined));
	return {
		/** The dead agent panes of this workspace: each passed every row of the table. */
		async list(): Promise<DeadPane[]> {
			onWindows();
			const { all, facts, workspace } = await look();
			const rows: DeadPane[] = [];
			for (const p of all.filter((x) => x.workspace_id === workspace && marked(x))) {
				if (await why(facts(p.pane_id))) continue;
				rows.push({ pane: p.pane_id, tab: p.tab_id, what: paneWhat(p), alone: all.filter((x) => x.tab_id === p.tab_id).length === 1 });
			}
			return rows;
		},
		/** Closes one dead agent pane, its tab with it when it is the tab's only pane; refused with the table's reason otherwise. */
		async close(query: string): Promise<ClosedPane> {
			onWindows();
			const { all, facts } = await look();
			const f = facts(query), refused = await why(f);
			if (refused) throw new Error(refused);
			const p = f.pane!, alone = all.filter((x) => x.tab_id === p.tab_id).length === 1;
			if (alone) {
				await run(["tab", "close", p.tab_id]);
				return { text: `Closed tab ${p.tab_id} with its only pane ${p.pane_id} (${paneWhat(p)}), whose pi was gone.`, pane: p.pane_id, tab: p.tab_id };
			}
			await run(["pane", "close", p.pane_id]);
			return { text: `Closed pane ${p.pane_id} (${paneWhat(p)}), whose pi was gone; its tab ${p.tab_id} keeps its other panes.`, pane: p.pane_id };
		},
	};
}
export type DeadPanes = ReturnType<typeof createDeadPanes>;
