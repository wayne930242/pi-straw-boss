import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handoverSnapshot, writeHandoverTodos } from "../src/handovertodo.ts";

test("a legacy list normalizes without mutating the branch or reusing a past id", () => {
	const task = { id: 3, subject: "checked", status: "completed", future: { field: true } };
	const snapshot = { nextId: 91, tasks: [{ ...task, blockedBy: [2] }], action: "update" };
	assert.deepEqual(handoverSnapshot(snapshot), { data: { v: 1, nextId: 91, tasks: [task] } });
	assert.deepEqual(snapshot.tasks[0]!.blockedBy, [2]);
});

test("an extensionless handoff gets a sibling file; reusing it with no remaining tasks leaves no stale list", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "psb-handover-todos-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const handoff = join(dir, "handoff"), path = `${handoff}.todos.json`;
	const tasks = [{ id: 1, subject: "one", status: "pending" }];
	assert.deepEqual(writeHandoverTodos(handoff, { tasks, nextId: 1 }), { written: true, path, count: 1 });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { tasks, nextId: 2, v: 1 });
	for (const invalid of [{ tasks: [], nextId: 2 }, { tasks: [{ ...tasks[0], status: "bad" }], nextId: 2 }, { tasks: [...tasks, ...tasks], nextId: 2 }]) {
		writeHandoverTodos(handoff, { tasks, nextId: 2 });
		const result = writeHandoverTodos(handoff, invalid);
		assert.equal(result.written, false);
		assert.match(result.reason!, invalid.tasks.length ? /not.*todo\/v1/ : /no tasks/);
		assert.equal(existsSync(path), false);
	}
});
