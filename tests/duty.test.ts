import assert from "node:assert/strict";
import { test } from "node:test";
import { COORDINATOR_DUTIES, dutyOfAgent, GRAPHS, graphOf } from "../src/duty.ts";
import { todosOf } from "../src/items.ts";
import { planGraph, todoOfBranch, todoOk } from "../src/todo.ts";

// docs/specs/2026-11-09-agent-kinds.md §1 (values) and §2 (the graph is read, never declared).

const snap = (tasks: unknown[]) => ({ tasks, nextId: tasks.length + 1 });
const task = (id: number, status: string, metadata?: unknown) => ({ id, subject: `t${id}`, status, ...(metadata === undefined ? {} : { metadata }) });
const entries = (tasks: unknown[]) => [{ type: "custom", customType: "rpiv-todo-state", data: snap(tasks) }];

test("the three coordinator kinds and the three graphs, in the spec's words", () => {
	assert.deepEqual([...COORDINATOR_DUTIES], ["coordinator", "integrator", "standing"]);
	assert.deepEqual([...GRAPHS], ["single-loop", "fan-out/fan-in", "orchestrator-worker"]);
});

test("graphOf: review 6's live values map to a graph; anything else has none", () => {
	for (const [value, graph] of [["fan-out", "fan-out/fan-in"], ["fan-out/fan-in", "fan-out/fan-in"], ["single", "single-loop"], ["single-loop", "single-loop"], ["single-loop then worker", "single-loop"], ["orchestrator-worker", "orchestrator-worker"]] as const) assert.equal(graphOf(value), graph, value);
	for (const value of ["fanout", "chain", "", undefined, null, 7, {}, ["fan-out"]]) assert.equal(graphOf(value), undefined, JSON.stringify(value));
});

test("dutyOfAgent: the reviewer roles share a kind; unknown names, and names on Object.prototype, have none", () => {
	assert.equal(dutyOfAgent("worker"), "worker");
	for (const name of ["reviewer", "visual-tester", "adversarial-reviewer"]) assert.equal(dutyOfAgent(name), "reviewer", name);
	for (const name of ["constructor", "toString", "__proto__", "nope", "", undefined]) assert.equal(dutyOfAgent(name), undefined, String(name));
});

test("planGraph: the open todo with the highest id that names a graph; finished todos, steps and bare anchors name none", () => {
	const graphs = (...list: unknown[]) => planGraph(todosOf(snap(list))!);
	assert.equal(graphs(task(1, "pending", { graph: "fan-out/fan-in" }), task(2, "in_progress", { graph: "orchestrator-worker" }), task(3, "pending")), "orchestrator-worker", "the newest plan wins");
	assert.equal(graphs(task(1, "completed", { graph: "fan-out" }), task(2, "completed", { graph: "single" })), undefined, "a finished plan has no graph");
	assert.equal(graphs(task(1, "pending", { anchor: "npm test" }), task(2, "pending")), undefined, "an anchor says nothing about a plan");
	assert.equal(graphs(task(1, "pending", { graph: "chain" })), undefined);
	assert.equal(graphs(task(1, "pending", { graph: "fan-out", sb: { kind: "train" } })), undefined, "a train step is no plan");
	assert.equal(graphs(), undefined);
	assert.equal(planGraph([]), undefined);
});

test("the short list carries the graph; the hub accepts only a known one", () => {
	assert.deepEqual(todoOfBranch(entries([task(1, "pending", { graph: "fan-out" })])), { done: 0, total: 1, graph: "fan-out/fan-in" });
	assert.deepEqual(todoOfBranch(entries([task(1, "pending")])), { done: 0, total: 1 });
	assert.equal(todoOk({ done: 0, total: 1, graph: "orchestrator-worker" }), true);
	for (const graph of ["fanout", "fan-out", "", 3]) assert.equal(todoOk({ done: 0, total: 1, graph }), false, String(graph));
});
