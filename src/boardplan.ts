import type { Graph } from "./duty.ts";
import type { Todo } from "./items.ts";

// The plan an auto entry carries beside its checklist (boardauto.ts): the main's open todos as a graph, so the boss's page can draw who waits on whom. Pure, and free of Node, so the page derives the same from a session's todo list
// (gui/plangraph.ts). On the board the text goes through the entry's own gate (`say`, boardauto.ts), so a subject, an owner, and a waits-on name leave as the checklist's items do; the reader checks it again (`cleanPlan`, board.ts).
// Local only: `forAllies` sends allies none of it (docs/specs/2026-10-25-straw-link.md, Sharing with allies).

/** One open todo of a plan: its id, its subject (cut to a board item's 80), `in_progress` or `pending`, who works on it (`owner`, and `agent`, the Herdr child's run id, the net's key: src/planowner.ts finds it; never a pane id), the open todos it waits on (`after`), and its defer (who it waits on, until when, as ISO). */
export interface PlanNode { id: number; t: string; status: "pending" | "in_progress"; owner?: string; agent?: string; after?: number[]; wait?: { on?: string; until?: string } }
/** At most `PLAN.nodes` open todos, the plan's graph, and `cut`, the open todos left out. */
export interface Plan { nodes: PlanNode[]; graph?: Graph; cut?: number }
/** `text` is a board item's cap (`BOARD.item`). */
export const PLAN = { nodes: 20, after: 8, label: 40, text: 80 } as const;

/** The graph of the newest plan: that of the open todo (pending or in progress, not a train step) with the highest id that names one. A finished plan, a bare anchor, and a train step name none. */
export const planGraph = (list: readonly Todo[]): Graph | undefined => list.filter((t) => t.status !== "completed" && !t.sb && t.graph).reduce<Todo | undefined>((top, t) => (!top || t.id > top.id ? t : top), undefined)?.graph;

/**
 * The open todos (in progress first, then pending, each in id order), at most `PLAN.nodes`; `cut` counts the open ones left out. `after` is a node's open blockers (a completed one no longer holds it), shown or cut, so a node
 * whose blocker was cut still reads as blocked; `wait` is its defer (`metadata.waitsOn`, `metadata.until`). None with nothing open.
 */
export function planOf(todos: readonly Todo[], say: (text: string, max: number) => string): Plan | undefined {
	const open = todos.filter((t) => t.status !== "completed"), ids = new Set(open.map((t) => t.id));
	const shown = [...open].sort((a, b) => (a.status === b.status ? a.id - b.id : a.status === "in_progress" ? -1 : 1)).slice(0, PLAN.nodes), graph = planGraph(todos);
	if (!shown.length) return undefined;
	const nodes = shown.map((t): PlanNode => {
		const owner = t.owner ? say(t.owner, PLAN.label) : "", on = t.waitsOn ? say(t.waitsOn, PLAN.label) : "", after = [...new Set((t.blockedBy ?? []).filter((b) => b !== t.id && ids.has(b)))].slice(0, PLAN.after);
		return { id: t.id, t: say(t.subject, PLAN.text), status: t.status as PlanNode["status"], ...(owner ? { owner } : {}), ...(t.agent ? { agent: t.agent } : {}), ...(after.length ? { after } : {}), ...(on || t.until ? { wait: { ...(on ? { on } : {}), ...(t.until ? { until: t.until } : {}) } } : {}) };
	});
	return { nodes, ...(graph ? { graph } : {}), ...(open.length > shown.length ? { cut: open.length - shown.length } : {}) };
}
