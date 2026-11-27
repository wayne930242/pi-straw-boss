import assert from "node:assert/strict";
import { test } from "node:test";
import { todosOf } from "../src/items.ts";
import { snapshotOfBranch, snapshotScan, todoOfBranch, todosOfBranch } from "../src/todo.ts";
import { isSnapshotV1, TODO_V1 } from "../src/todoledger.ts";

// sb reads a session's todo list through pi-todo-ledger's public contract (docs/specs/2026-11-24-todo-ledger.md): the newest valid `todo/v1` entry on the branch wins; without one, rpiv-todo's records are read as before.

const task = (id: number, status: string, over: Record<string, unknown> = {}) => ({ id, subject: `task ${id}`, status, ...over });
const v1 = (tasks: unknown[], data: Record<string, unknown> = {}) => ({ type: "custom", customType: TODO_V1, data: { v: 1, tasks, nextId: tasks.length + 1, ...data } });
const rpiv = (tasks: unknown[]) => ({ type: "custom", customType: "rpiv-todo-state", data: { action: "update", params: {}, tasks, nextId: tasks.length + 1 } });
const result = (tasks: unknown[]) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { action: "create", params: {}, tasks, nextId: tasks.length + 1 } } });
const subjects = (entries: unknown[]) => todosOfBranch(entries)?.map((t) => t.subject);

test("a todo/v1 entry wins over rpiv-todo's records, even an rpiv entry later on the branch; the newest valid v1 entry is the list", () => {
	assert.deepEqual(subjects([rpiv([task(1, "pending")]), v1([task(2, "pending")]), rpiv([task(3, "pending")]), result([task(4, "pending")])]), ["task 2"]);
	assert.deepEqual(subjects([v1([task(1, "pending")]), v1([task(5, "in_progress")])]), ["task 5"]);
	assert.deepEqual(todoOfBranch([v1([task(1, "completed"), task(2, "in_progress", { activeForm: "doing 2" }), task(3, "deleted")])]), { done: 1, total: 2, now: "doing 2", doing: 2 }, "a tombstone is no task; the summary names the todo in progress (docs/specs/2026-11-28-boss-asks.md)");
	assert.deepEqual(snapshotOfBranch([v1([])]), { v: 1, tasks: [], nextId: 1 }, "an empty v1 list is a list: an older rpiv record does not come back");
	assert.deepEqual(subjects([rpiv([task(1, "pending")]), v1([])]), []);
});

test("an invalid todo/v1 entry is skipped: the newer valid one before it, else rpiv-todo's records", () => {
	const bad = [
		{ type: "custom", customType: TODO_V1, data: { v: 2, tasks: [], nextId: 1 } },
		v1([task(9, "pending")], { nextId: 0 }),
		v1([task(0, "pending")]),
		v1([task(9, "paused")]),
		v1([{ id: 9, status: "pending" }]),
		v1([task(9, "pending", { points: 11 })]),
		v1([task(9, "pending", { anchor: "" })]),
		v1([task(9, "pending", { metadata: [] })]),
		v1([task(9, "pending", { blockedBy: [0] })]),
		v1([task(9, "pending", { evidence: [{ command: "npm test", result: "green", at: "2026-11-24T00:00:00.000Z" }] })]),
		{ type: "custom", customType: TODO_V1, data: "not an object" },
		{ type: "message", customType: TODO_V1, data: { v: 1, tasks: [task(9, "pending")], nextId: 2 } },
	];
	for (const entry of bad) assert.deepEqual(subjects([v1([task(1, "pending")]), entry]), ["task 1"], JSON.stringify(entry));
	for (const entry of bad) assert.deepEqual(subjects([rpiv([task(2, "pending")]), entry]), ["task 2"], `falls back to rpiv: ${JSON.stringify(entry)}`);
	assert.deepEqual(subjects([result([task(3, "pending")]), bad[0]!]), ["task 3"], "and to rpiv's tool results");
	assert.equal(todosOfBranch([bad[0]!]), undefined);
});

test("a v1 entry with properties the reader does not know is valid (readers ignore them within v1), and every v1 field the schema names is checked", () => {
	assert.equal(isSnapshotV1({ v: 1, tasks: [task(1, "pending", { future: { x: 1 } })], nextId: 2, more: true }), true);
	const full = task(1, "in_progress", { description: "d", activeForm: "a", blockedBy: [2], owner: "w", metadata: { sb: { kind: "merge" } }, points: 2.5, anchor: "npm test", evidence: [{ command: "npm test", sha: "abc", result: "pass", at: "2026-11-24T00:00:00.000Z" }] });
	assert.equal(isSnapshotV1({ v: 1, tasks: [full, task(2, "pending")], nextId: 3 }), true);
	assert.equal(isSnapshotV1({ v: 1, tasks: [{ ...full, owner: 3 }], nextId: 3 }), false);
	assert.equal(isSnapshotV1({ v: 1, tasks: [{ ...full, evidence: [{ result: "pass", at: "x" }] }], nextId: 3 }), false);
});

test("the incremental scan of the work board reads the same: v1 first, an invalid v1 skipped, rpiv as the fallback, and a later v1 entry takes over", () => {
	const scan = snapshotScan(), branch: unknown[] = [rpiv([task(1, "pending")])];
	assert.deepEqual(todosOf(scan(branch))?.map((t) => t.subject), ["task 1"]);
	branch.push({ type: "custom", customType: TODO_V1, data: { v: 1, tasks: "no", nextId: 1 } });
	assert.deepEqual(todosOf(scan(branch))?.map((t) => t.subject), ["task 1"]);
	branch.push(v1([task(2, "pending")]), rpiv([task(3, "pending")]));
	assert.deepEqual(todosOf(scan(branch))?.map((t) => t.subject), ["task 2"]);
	assert.deepEqual(todosOf(scan([rpiv([task(4, "pending")])]))?.map((t) => t.subject), ["task 4"], "another branch is read whole");
});

test("a task's points: metadata.points as before, the ledger's top-level points when it has none, metadata winning when both are set", () => {
	const points = (over: Record<string, unknown>) => todosOf({ tasks: [task(1, "pending", over)], nextId: 2 })![0]!.points;
	assert.equal(points({ metadata: { points: 3 } }), 3);
	assert.equal(points({ points: 2 }), 2);
	assert.equal(points({ points: 2, metadata: { points: 5 } }), 5);
	assert.equal(points({ points: 2, metadata: { points: 50 } }), 2, "an invalid metadata.points is no value, so the field is read");
	assert.equal(points({ points: 12 }), undefined);
	assert.equal(points({ points: "2" }), undefined);
});
