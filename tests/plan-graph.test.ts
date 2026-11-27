import assert from "node:assert/strict";
import { test } from "node:test";
import type { Plan, PlanNode } from "../src/boardplan.ts";
import type { BoardViewRow } from "../src/boardview.ts";
import type { Todo } from "../src/items.ts";
import type { Net } from "../src/net.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";

// A main's plan as a graph (gui/plangraph.ts): layers by dependency, the state of each node in words, the owner, the defer with who and until when, the ids it comes after, in progress marked; drawn on the board row of an auto line that
// carries a plan and on the session page's todo box, and the checklist kept where the plan says nothing more (an older main's line, a box whose build sends no graph field).

sessionGlobals();
const { graphed, layersOf, nodeState, planOfTodos, planView, whenText } = await import("../gui/plangraph.ts");
const { fillBoard } = await import("../gui/board.ts");
const { drawTodos } = await import("../gui/bars.ts");
const { m } = await import("../gui/paraglide/messages.js");

const NOW = new Date(2026, 10, 27, 9, 0).getTime();
const node = (id: number, t: string, over: Partial<PlanNode> = {}): PlanNode => ({ id, t, status: "pending", ...over });
const PLAN: Plan = { graph: "fan-out/fan-in", cut: 2, nodes: [
	node(3, "Build web", { status: "in_progress", owner: "worker-web" }),
	node(2, "Build api", { owner: "worker-api" }),
	node(4, "Merge", { after: [2, 3] }),
	node(5, "Boss sign-off", { after: [4], wait: { on: "boss", until: new Date(2026, 10, 27, 14, 0).toISOString() } }),
	node(6, "<img src=x onerror=alert(1)>"),
] };

test("layers: a node sits one step below its deepest shown blocker; a blocker that is not shown and a cycle count as none; in progress leads its layer", () => {
	assert.deepEqual(layersOf(PLAN.nodes).map((l) => l.map((n) => n.id)), [[3, 2, 6], [4], [5]]);
	assert.deepEqual(layersOf([node(1, "a", { after: [2] }), node(2, "b", { after: [1] }), node(3, "c", { after: [99] })]).map((l) => l.map((n) => n.id)).flat().sort(), [1, 2, 3], "a cycle still draws every node");
	assert.deepEqual(layersOf([node(3, "c", { after: [99] })]).map((l) => l.map((n) => n.id)), [[3]]);
	assert.deepEqual(PLAN.nodes.map(nodeState), ["doing", "ready", "blocked", "waiting", "ready"]);
});

test("graphed: a dependency, an owner, a defer, or a graph name make a plan worth drawing; a flat list stays the checklist", () => {
	assert.equal(graphed(PLAN), true);
	assert.equal(graphed({ nodes: [node(1, "a"), node(2, "b")] }), false);
	assert.equal(graphed({ nodes: [node(1, "a")], graph: "single-loop" }), true);
	assert.equal(graphed(undefined), false);
	assert.equal(whenText(new Date(2026, 10, 27, 14, 0).toISOString(), NOW), "14:00");
	assert.equal(whenText(new Date(2026, 10, 28, 8, 5).toISOString(), NOW), "11/28 08:05");
});

test("the view: one step per layer, each node with its state word, id, text, owner, defer, and after; in progress marked; markup stays text; the cut is counted", () => {
	const v = planView(PLAN, NOW) as unknown as El;
	assert.equal(v.getAttribute("aria-label"), m.plan_label());
	assert.equal(v.dataset.graph, "fan-out/fan-in");
	assert.deepEqual(v.querySelectorAll(".plan-layer h5").map((x) => x.textContent), [1, 2, 3].map((n) => m.plan_step({ n: String(n) })));
	const at = (id: number) => v.querySelector(`.plan-node[data-id="${id}"]`)!;
	assert.equal(at(3).dataset.state, "doing");
	assert.deepEqual([at(3).querySelector(".plan-badge")!.textContent, at(3).querySelector(".plan-id")!.textContent, at(3).querySelector(".plan-owner")!.textContent], [m.plan_state_doing(), "#3", "worker-web"]);
	assert.equal(at(4).querySelector(".plan-after")!.textContent, m.plan_after({ ids: "#2, #3" }));
	assert.equal(at(5).querySelector(".plan-wait")!.textContent, `${m.plan_wait_on({ who: "boss" })} · ${m.plan_wait_until({ time: "14:00" })}`);
	assert.equal(at(5).querySelector(".plan-badge")!.textContent, m.plan_state_waiting());
	assert.equal(at(6).querySelector(".plan-text")!.textContent, "<img src=x onerror=alert(1)>");
	assert.equal(at(6).querySelector("img"), null, "a model's text never becomes markup");
	assert.equal(at(6).querySelector(".plan-meta"), null, "a node with nothing more has no meta line");
	assert.equal(v.querySelector(".plan-cut")!.textContent, m.plan_cut({ count: 2 }));
});

const row = (over: Partial<BoardViewRow> & Pick<BoardViewRow, "session">): BoardViewRow => ({ workspace: "Alpha", tab: "api", main: "billing", state: "working", items: [{ t: "Build web", done: false }, { t: "Survey", done: true }], src: "todo", count: { done: 1, total: 7 }, now: "billing: Build web", updated: NOW, ...over });
const unit = (key: string) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "working" as const, subs: [] });
const net = (board: BoardViewRow[]): Net => ({ bases: [{ id: "wA", label: "Alpha", mark: "idle", tower: null, tabs: [{ id: "t1", label: "api", units: board.map((r) => unit(r.session)) }], outposts: [], outside: [] }], board });
const box = () => {
	const b = new El("details"), summary = new El("summary"), body = new El("div");
	body.className = "board-rows";
	summary.append(new El("b"), new El("span"));
	b.append(summary, body);
	return b;
};

test("the board row draws an auto line's plan in the checklist's place, the fold saying done, open, and the graph; a line without a plan (an older main's) and a flat plan keep the checklist", () => {
	page.body.replaceChildren();
	const b = box();
	fillBoard(b as never, net([row({ session: "s-plan", plan: PLAN }), row({ session: "s-old" }), row({ session: "s-flat", plan: { nodes: [node(1, "a"), node(2, "b")] } })]), false, NOW);
	const at = (s: string) => b.querySelector(`.board-row[data-session="${s}"]`)!;
	const fold = at("s-plan").querySelector(".board-plan")!;
	assert.equal(fold.querySelector("summary")!.textContent, `${m.board_done({ done: 1, total: 7 })} · ${m.plan_open({ count: 7 })} · ${m.graph_fan()}`);
	assert.equal(fold.querySelectorAll(".plan-node").length, 5);
	assert.equal(at("s-plan").querySelectorAll(".board-items li").filter((li) => li.dataset.done !== undefined).length, 0, "no checklist beside the plan");
	assert.equal(at("s-old").querySelector(".plan"), null);
	assert.deepEqual(at("s-old").querySelectorAll(".board-items li").map((li) => li.textContent), ["Build web", "Survey"], "the checklist an older main's line carries");
	assert.equal(at("s-flat").querySelector(".plan"), null, "a plan with no graph data is the checklist");
});

const todo = (id: number, subject: string, status: Todo["status"], over: Partial<Todo> = {}): Todo => ({ id, subject, status, ...over });
const todoBox = () => {
	const view = new El("div"), d = new El("details"), summary = new El("summary"), ol = new El("ol");
	d.className = "todos";
	summary.append(new El("b"), new El("span"));
	d.append(summary, ol);
	view.append(d);
	return { view, d, ol };
};

test("the session page's todos: a list with graph data shows the plan with the checklist folded under it (finished tasks, points, anchor, last run); one without (an operate box on an older build) keeps the checklist; a redraw replaces the plan", () => {
	const { view, d, ol } = todoBox();
	const run = { command: "npm test", result: "pass" as const, sha: "abc1234", at: "2026-11-27T08:00:00.000Z" };
	const list = [todo(1, "Survey", "completed", { points: 2, anchor: "survey.md exists", evidence: run }), todo(2, "Build", "in_progress", { owner: "w1", blockedBy: [1] }), todo(3, "Ship", "pending", { blockedBy: [2], waitsOn: "boss" })];
	drawTodos(view as never, list);
	assert.deepEqual(d.querySelectorAll(".plan-node").map((n) => [n.dataset.id, n.dataset.state]), [["2", "doing"], ["3", "waiting"]], "open todos only; a completed blocker no longer holds #2");
	const fold = d.querySelector(".todos-all")!;
	assert.equal(d.children.indexOf(fold), d.children.indexOf(d.querySelector(".plan")!) + 1, "the checklist's fold sits under the plan");
	assert.equal(ol.parent, fold);
	assert.equal(ol.hidden, false);
	assert.equal(fold.querySelector("summary")!.textContent, m.todos_checklist({ count: 3 }));
	assert.deepEqual(ol.children.map((li) => [li.className, li.textContent]), [["completed", `Survey ${m.todos_points({ points: 2 })}`], ["in_progress", "Build"], ["pending", "Ship"]], "the finished task stays, with its points");
	assert.match(ol.children[0]!.title, /survey\.md exists[\s\S]*npm test · pass · abc1234/, "its anchor and last run stay reachable");
	fold.setAttribute("open", "");
	drawTodos(view as never, [...list, todo(4, "Docs", "pending", { blockedBy: [3] })]);
	assert.equal(d.querySelectorAll(".plan").length, 1, "one plan section, redrawn");
	assert.equal(d.querySelectorAll(".todos-all").length, 1, "one fold, kept");
	assert.equal(d.querySelector(".todos-all"), fold);
	assert.equal(fold.hasAttribute("open"), true, "a fold the boss opened stays open on a redraw");
	assert.equal(d.children.indexOf(fold), d.children.indexOf(d.querySelector(".plan")!) + 1);
	assert.equal(d.querySelectorAll(".plan-layer").length, 3);
	assert.equal(ol.children.length, 4);
	drawTodos(view as never, list.map(({ owner: _o, blockedBy: _b, waitsOn: _w, ...t }) => t));
	assert.equal(d.querySelector(".plan"), null);
	assert.equal(d.querySelector(".todos-all"), null, "no fold without a plan");
	assert.equal(ol.parent, d);
	assert.equal(ol.hidden, false);
	assert.deepEqual(ol.children.map((li) => li.textContent), [`Survey ${m.todos_points({ points: 2 })}`, "Build", "Ship"]);
	assert.equal(planOfTodos([todo(1, "x", "completed")]), undefined);
});
