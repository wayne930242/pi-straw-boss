import assert from "node:assert/strict";
import { test } from "node:test";
import { todosOf, type Todo } from "../src/items.ts";
import { todoOfBranch, todoOk, todosOfBranch } from "../src/todo.ts";
import { CODE, result, SHA_A, sb } from "./train-fixtures.ts";

// A todo list in short for the map (docs/specs/2026-11-07-train-workers.md §11.1, task 4): `metadata.sb` of a todo is kept for the page, bounded: known keys only, strings cut to their caps, nothing over 8 KB,
// and a hub checks the wide shape as it checks the narrow one.

const snap = (tasks: unknown[]) => ({ tasks, nextId: tasks.length + 1 });
const task = (id: number, status: string, metadata?: unknown) => ({ id, subject: `step ${id}`, status, ...(metadata === undefined ? {} : { metadata }) });

test("local todo details retain the latest recorded run and prefer metadata points, including zero", () => {
	const run = { command: "npm test", result: "pass", at: "2026-11-24T09:40:00Z", sha: "0123456789" };
	const base = task(1, "pending", { points: 0 });
	assert.deepEqual(todosOf(snap([{ ...base, points: 2, anchor: "suite passes", evidence: [{ ...run, result: "fail" }, run] }])), [{ id: 1, status: "pending", subject: "step 1", points: 0, anchor: "suite passes", evidence: { ...run, sha: "0123456" } }]);
});

test("a todo's `metadata.until` marks a wait only as the ledger reads it: an impossible day, a space, a lowercase t, or hour 24 mark none", () => {
	const untilOf = (until: string) => todosOf(snap([task(1, "pending", { until })]))![0]!.until;
	for (const bad of ["2099-02-30", "2099-12-01 09:00:00Z", "2099-12-01t09:00:00Z", "2099-12-01T24:00", "tomorrow", "2099-12-01T09:00:00Z".padEnd(80, "0")]) assert.equal(untilOf(bad), undefined, bad);
	assert.equal(untilOf("2099-12-01"), "2099-12-01T00:00:00.000Z");
	assert.equal(untilOf("2099-12-01T09:00+08:00"), "2099-12-01T01:00:00.000Z");
});

test("a todo with no metadata is what it was: no `sb` on it, and the short list has no steps", () => {
	const list = todosOf(snap([task(1, "pending"), task(2, "in_progress", { other: "x" })]))!;
	assert.deepEqual(list.map((t) => Object.keys(t).sort()), [["id", "status", "subject"], ["id", "status", "subject"]]);
	const entries = [{ type: "custom", customType: "rpiv-todo-state", data: snap([task(1, "pending")]) }];
	assert.deepEqual(todoOfBranch(entries), { done: 0, total: 1 });
});

test("a step's metadata.sb is kept by its known keys only, with the check type but none of the check's commands or paths", () => {
	const meta = sb({ round: 2, name: "unit" }, { holds: { lane: "web" }, load: { max: 30, weight: 4 }, lock: "heavy", secretish: "dropped" });
	(meta as { extra?: string }).extra = "dropped";
	const [one] = todosOf(snap([task(1, "completed", { sb: { ...meta, result: result({ outcome: "failed", evidence: "exit 1 in 3m" }) } })]))!;
	assert.deepEqual(one!.sb, {
		kind: "full-check", name: "unit", project: "acme", app: "web", train: CODE, round: 2, check: "run", holds: { lane: "web" }, load: { max: 30, weight: 4 }, lock: "heavy", outcome: "failed",
	});
	const json = JSON.stringify(one);
	assert.doesNotMatch(json, /npm test|unit\.log|dropped|exit 1 in 3m/, "the command, the log, unknown keys and the evidence text stay in the session");
});

test("strings are cut to their caps; a value of the wrong type is left out, not carried", () => {
	const long = "x".repeat(500);
	const [one] = todosOf(snap([task(1, "pending", { sb: sb({ name: long, kind: long, app: long }, { holds: { lane: long, target: 7 } }) })]))!;
	assert.equal(one!.sb!.name!.length, 64);
	assert.equal(one!.sb!.kind.length, 32);
	assert.equal(one!.sb!.app!.length, 64);
	assert.equal(one!.sb!.holds?.lane?.length, 64);
	assert.equal(one!.sb!.holds?.target, undefined);
	const [odd] = todosOf(snap([task(1, "pending", { sb: { kind: 7, round: "two", load: { max: "30" }, outcome: "great", spec: { check: { type: 4 } } } })]))!;
	assert.equal(odd!.sb, undefined, "a step with no kind in words is no step");
	const [half] = todosOf(snap([task(1, "pending", { sb: { kind: "merge", round: "two", load: { max: "30" }, holds: [], spec: { check: { type: 4 } } } })]))!;
	assert.deepEqual(half!.sb, { kind: "merge" });
});

test("a metadata.sb over 8 KB, nested over 32 levels, or not an object is cut whole; the todo itself stays", () => {
	const big = sb({}, { check: { type: "run", cwd: "/w", run: "x".repeat(9000), log: "/l" } });
	let deep: Record<string, unknown> = { kind: "merge" };
	for (let i = 0; i < 40; i++) deep = { nested: deep };
	for (const meta of [{ sb: big }, { sb: { kind: "merge", spec: deep } }, { sb: "merge" }, { sb: [sb()] }, { sb: null }]) {
		const [one] = todosOf(snap([task(1, "pending", meta)]))!;
		assert.equal(one!.id, 1);
		assert.equal(one!.sb, undefined, JSON.stringify(meta).slice(0, 40));
	}
	const cyclic: Record<string, unknown> = { kind: "merge" };
	cyclic.self = cyclic;
	assert.equal(todosOf(snap([task(1, "pending", { sb: cyclic })]))![0]!.sb, undefined, "a cycle is too deep, never walked");
});

test("the short list carries the steps of a train: id, kind, name, status, round, outcome; the branch reader and the hub agree on the shape", () => {
	const steps = [
		task(1, "completed", { sb: { ...sb({ kind: "assemble", name: "round 1" }, { check: { type: "git", cwd: "/w", contains: [SHA_A] } }), result: result({ head: SHA_A }) } }),
		task(2, "in_progress", { sb: sb({ name: "unit" }) }),
		task(3, "pending"),
	];
	const entries = [{ type: "custom", customType: "rpiv-todo-state", data: snap(steps) }];
	const sum = todoOfBranch(entries)!;
	assert.deepEqual(sum.steps, [
		{ id: 1, kind: "assemble", name: "round 1", status: "completed", round: 1, outcome: "passed" },
		{ id: 2, kind: "full-check", name: "unit", status: "in_progress", round: 1 },
	]);
	assert.deepEqual([sum.done, sum.total, sum.now], [1, 3, "step 2"]);
	assert.equal(todoOk(sum), true);
	assert.deepEqual((todosOfBranch(entries) as Todo[]).map((t) => t.sb?.kind), ["assemble", "full-check", undefined]);
});

test("todoOk on the wide shape: steps are a list of at most 200 well-formed rows; a bad row refuses the summary", () => {
	const ok = { done: 1, total: 2, steps: [{ id: 1, kind: "merge", status: "completed" }] };
	assert.equal(todoOk(ok), true);
	assert.equal(todoOk({ done: 1, total: 2 }), true, "the narrow shape still passes");
	const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, kind: "merge", status: "pending" }));
	assert.equal(todoOk({ done: 0, total: 200, steps: rows(200) }), true);
	assert.equal(todoOk({ done: 0, total: 200, steps: rows(201) }), false);
	for (const bad of [
		{ id: 0, kind: "merge", status: "pending" }, { id: 1.5, kind: "merge", status: "pending" }, { id: 1, kind: "", status: "pending" }, { id: 1, kind: "x".repeat(33), status: "pending" },
		{ id: 1, kind: "merge", status: "deleted" }, { id: 1, kind: "merge", status: "pending", name: "a\u0000b" }, { id: 1, kind: "merge", status: "pending", name: "x".repeat(65) },
		{ id: 1, kind: "merge", status: "pending", round: 0 }, { id: 1, kind: "merge", status: "pending", outcome: "great" }, { id: 1, kind: "merge", status: "pending", extra: 1 }, null, "merge",
	]) assert.equal(todoOk({ done: 0, total: 1, steps: [bad] }), false, JSON.stringify(bad));
	assert.equal(todoOk({ done: 0, total: 1, steps: "merge" }), false);
	assert.equal(todoOk({ done: 0, total: 0, steps: [] }), false, "an empty list is still no summary");
});
