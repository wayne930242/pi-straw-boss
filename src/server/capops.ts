import { readFileSync, statSync } from "node:fs";
import { availableParallelism, homedir, loadavg } from "node:os";
import { join } from "node:path";
import { readEntries, safeSession } from "../board.ts";
import { capDir, type MainFacts, readBudget } from "../capacity.ts";
import { type HerdrRun, panes as herdrPanes, type Session, workspaces as herdrWorkspaces } from "../herdr.ts";
import { commanding, sessionMark, subagentsOfAll } from "../netdata.ts";
import { nameOf, netMembers } from "../reach.ts";
import { type AllySeen, type CapDeps, type CapEvent, createCapWatch } from "./capwatch.ts";
import { stallTarget } from "./stallops.ts";
import { inTestRun } from "./testguard.ts";
import type { Towers } from "./towers.ts";

// The server's side of the capacity watch (capwatch.ts): what it reads of this machine (pi-intercom's list, Herdr's panes, the board and capacity files, the load, `capacity.budget`), and whom it tells:
// the tower of the main's workspace (as the stall watch finds it), this device's standing main, and for `under` and `stale` the main itself. Kept out of main.ts, which carries a line budget.

/** pi-loop-monitor persists loops-<pi-session-id>.json. No mutating store import; consume only the active flag and expiry. */
export function armedLoop(dir: string, session: string, now: number): boolean {
	if (!safeSession(session)) return false;
	try {
		const { loops } = JSON.parse(readFileSync(join(dir, `loops-${session}.json`), "utf8"));
		return Array.isArray(loops) && loops.some((l) => l?.status === "active" && typeof l.expiresAt === "number" && l.expiresAt > now);
	} catch { return false; }
}

/** The live mains and trains of one reading, with every running subagent of each main's pane (no dashboard limit), when its session file last moved, and when its board entry was written. */
export function mainFacts(sessions: Session[], ps: Awaited<ReturnType<typeof herdrPanes>>, boardDir: string, now: number, mtime: (file: string) => number | undefined, background?: (session: string, pane: string | undefined) => boolean): MainFacts[] {
	const kids = subagentsOfAll(ps, now, Infinity), entries = new Map(readEntries(boardDir).map((e) => [e.session, e.updated]));
	return netMembers(sessions, ps).filter((m) => m.role === "main" || m.role === "train").map((m): MainFacts => {
		const pane = ps.find((p) => p.pane_id === m.s.herdrLocation?.paneId), subs = m.role === "main" ? kids(pane).filter((r) => !r.ended) : [], mark = sessionMark(m.s, pane), file = pane?.agent_session?.value;
		const moved = file ? mtime(file) : undefined, written = entries.get(m.s.id);
		return {
			session: m.s.id, name: nameOf(m.s), workspace: m.workspace.id, role: m.role === "train" ? "train" : "main", state: mark, commanding: commanding(mark, subs.map((r) => r.mark)) === "commanding",
			...(m.role === "main" && background?.(m.s.id, pane?.pane_id) ? { background: true } : {}), ...(m.duty ? { duty: m.duty } : {}), workers: subs.map((r) => r.text), ...(moved !== undefined ? { fileMtime: moved } : {}), ...(written !== undefined ? { entryUpdated: written } : {}),
		};
	});
}

export interface StartCap {
	stateDir: string;
	now(): number;
	log(event: string, facts: Record<string, string | number | boolean>): void;
	run: HerdrRun;
	sessions(): Promise<Session[]>;
	towers(): Pick<Towers, "status" | "head" | "runs"> | undefined;
	unattended(): boolean;
	monitorPanes(): Set<string>;
	watching(session: string): boolean;
	/** The ally devices the link holder has heard of (none without Straw Link). */
	allies(): AllySeen[];
	/** One intercom message from the server to a live session (boardpanel.ts `tellVia`). */
	tellSession(session: string, text: string): Promise<unknown>;
	/** The seams of a test; in a test run there is no watch without them. */
	over?: Partial<CapDeps>;
	every?: number;
}

/** Tells an event: as a notice to the tower that hears of the main's workspace (the head tower for an ally device), to this device's standing main, and to the event's own main (`under`, `stale`)
 *  unless it is that standing main. True when any took it. */
export async function tellCap(e: CapEvent, o: Pick<StartCap, "run" | "towers" | "tellSession">, at: number): Promise<boolean> {
	const towers = o.towers();
	const to = towers ? stallTarget(e.workspace, await herdrWorkspaces(o.run).catch(() => []), towers.status().map((r) => r.workspace), towers.head.status()?.workspace) : undefined;
	const tower = to !== undefined && towers!.runs.notice(to, e.text, `capacity:${e.kind}:${e.key}:${at}`);
	const tell = (session: string | undefined) => (session ? o.tellSession(session, e.text).then((r) => r === "delivered" || r === "queued", () => false) : Promise.resolve(false));
	const told = await tell(e.standing), own = e.main !== e.standing ? await tell(e.main) : false;
	return tower || told || own;
}

/** The watch of this server, ticking once a minute; none in a test run without seams. Returns its stop. */
export function startCap(o: StartCap): (() => void) | undefined {
	if (inTestRun() && !o.over) return undefined;
	const boardDir = join(o.stateDir, "board");
	const watch = createCapWatch({
		dir: capDir(boardDir), now: o.now, log: o.log, budget: () => readBudget(o.stateDir), unattended: o.unattended, allies: o.allies,
		load: () => ({ load1: loadavg()[0] ?? 0, cores: availableParallelism() }),
		mains: async () => {
			const sessions = await o.sessions(), panes = await herdrPanes(o.run), monitors = o.monitorPanes(), now = o.now();
			return mainFacts(sessions, panes, boardDir, now, (file) => { try { return statSync(file).mtimeMs; } catch { return undefined; } },
				(id, pane) => (pane !== undefined && monitors.has(pane)) || o.watching(id) || armedLoop(join(homedir(), ".pi", "loops"), id, now));
		},
		tell: (e) => tellCap(e, o, o.now()),
		...o.over,
	});
	let busy = false;
	const tick = () => {
		if (busy) return;
		busy = true;
		void watch.tick().catch((error: Error) => o.log("capacity-error", { text: error.message.slice(0, 200) })).finally(() => (busy = false));
	};
	const timer = setInterval(tick, o.every ?? 60_000);
	timer.unref?.();
	tick();
	return () => clearInterval(timer);
}
