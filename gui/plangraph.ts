import { type Plan, type PlanNode, planOf } from "../src/boardplan.ts";
import type { Todo } from "../src/items.ts";
import { h } from "./dom.ts";
import { m } from "./sentences.ts";

// A main's plan as a graph (src/boardplan.ts): its open todos in layers by dependency (a node sits one step below the deepest open todo it waits on), each with its state in words and a tint, its owner, its defer (who, until when),
// and the ids it comes after, so the layers read on a phone without lines between boxes. The board row draws an auto line's plan (gui/board.ts); the session page draws the plan of the todo list it has, an operate box's too (gui/bars.ts).
// A plan with no graph data (no dependency, owner, defer, or graph name) stays the checklist. Every field is a model's text: drawn as text only.

export type NodeState = "doing" | "ready" | "blocked" | "waiting";
/** In progress wins; a deferred todo waits; one with an open blocker is blocked; else it is ready to start. */
export const nodeState = (n: PlanNode): NodeState => (n.status === "in_progress" ? "doing" : n.wait ? "waiting" : n.after?.length ? "blocked" : "ready");
/** Whether the plan says more than the checklist: a dependency, an owner, a defer, or the plan's graph. */
export const graphed = (p: Plan | undefined): p is Plan => Boolean(p && (p.graph || p.nodes.some((n) => n.after?.length || n.owner || n.wait)));
/** A session's todo list as a plan, its text as the session page shows it. */
export const planOfTodos = (list: readonly Todo[] | null | undefined): Plan | undefined => (list?.length ? planOf(list, (t) => t) : undefined);

/** The layers: depth 0 for a node that waits on no shown node, else one more than its deepest shown blocker (a cycle counts as no blocker); in progress first, then by id, inside a layer. */
export function layersOf(nodes: readonly PlanNode[]): PlanNode[][] {
	const byId = new Map(nodes.map((n) => [n.id, n])), depth = new Map<number, number>();
	const of = (n: PlanNode, seen: Set<number>): number => {
		const known = depth.get(n.id);
		if (known !== undefined) return known;
		seen.add(n.id);
		const d = Math.max(-1, ...(n.after ?? []).flatMap((id) => { const b = byId.get(id); return b && !seen.has(id) ? [of(b, seen)] : []; })) + 1;
		seen.delete(n.id);
		depth.set(n.id, d);
		return d;
	};
	const layers: PlanNode[][] = [];
	for (const n of nodes) (layers[of(n, new Set())] ??= []).push(n);
	return layers.filter(Boolean).map((l) => l.sort((a, b) => (a.status === b.status ? a.id - b.id : a.status === "in_progress" ? -1 : 1)));
}

const GRAPH: Record<string, () => string> = { "single-loop": m.graph_single, "fan-out/fan-in": m.graph_fan, "orchestrator-worker": m.graph_orch };
const STATE: Record<NodeState, () => string> = { doing: m.plan_state_doing, ready: m.plan_state_ready, blocked: m.plan_state_blocked, waiting: m.plan_state_waiting };
/** A time as the page's clock reads it: `14:00` today, `11/28 14:00` another day. */
export function whenText(iso: string, now: number): string {
	const at = new Date(iso), today = new Date(now), hm = at.toTimeString().slice(0, 5);
	return at.toDateString() === today.toDateString() ? hm : `${at.getMonth() + 1}/${at.getDate()} ${hm}`;
}
/** The plan's one line for a fold: `3 open · fan-out`. */
export const planLine = (p: Plan): string => [m.plan_open({ count: p.nodes.length + (p.cut ?? 0) }), ...(p.graph && GRAPH[p.graph] ? [GRAPH[p.graph]!()] : [])].join(" · ");

function nodeOf(n: PlanNode, now: number): HTMLElement {
	const state = nodeState(n), wait = n.wait && [n.wait.on && m.plan_wait_on({ who: n.wait.on }), n.wait.until && m.plan_wait_until({ time: whenText(n.wait.until, now) })].filter(Boolean).join(" · ");
	return h("li", { class: "plan-node", "data-state": state, "data-id": String(n.id) },
		h("p", { class: "plan-top" }, h("span", { class: "plan-badge" }, STATE[state]()), h("small", { class: "plan-id" }, `#${n.id}`)),
		h("p", { class: "plan-text" }, n.t),
		...(n.owner || wait || n.after?.length ? [h("p", { class: "plan-meta" },
			...(n.owner ? [h("span", { class: "plan-owner", title: m.plan_owner({ owner: n.owner }) }, n.owner)] : []),
			...(wait ? [h("span", { class: "plan-wait" }, wait)] : []),
			...(n.after?.length ? [h("span", { class: "plan-after" }, m.plan_after({ ids: n.after.map((id) => `#${id}`).join(", ") }))] : []))] : []));
}
/** The plan's section: the layers top to bottom, each a step with its nodes side by side as the width allows, and the count of what was cut. `now`: the page's clock, for a defer's time. */
export function planView(p: Plan, now = Date.now()): HTMLElement {
	return h("section", { class: "plan", "aria-label": m.plan_label(), ...(p.graph ? { "data-graph": p.graph } : {}) },
		h("ol", { class: "plan-layers" }, ...layersOf(p.nodes).map((layer, i) => h("li", { class: "plan-layer" }, h("h5", null, m.plan_step({ n: String(i + 1) })), h("ul", { class: "plan-nodes" }, ...layer.map((n) => nodeOf(n, now)))))),
		...(p.cut ? [h("p", { class: "plan-cut" }, m.plan_cut({ count: p.cut }))] : []));
}
