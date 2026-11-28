import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net, Unit } from "../src/net.ts";
import { asksOfNet } from "../src/server/askmirror.ts";
import { todoOfBranch, todoOk } from "../src/todo.ts";

// carrows-review-F001: an Ask's todo is bound once, by its id and the todo's uid, so a reader can tell the todo it blocks from a new todo that took the same id after `clear` (pi-todo-ledger reuses ids).

const A = "t_aaaaaaaaab", B = "t_aaaaaaaaac";
const result = (tasks: unknown[]) => ({ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: 9 } } });

test("a bridge's todo summary carries the uid of the todo in progress and of each run's todo, which the hub takes; a malformed uid is refused", () => {
	const sum = todoOfBranch([result([
		{ id: 2, uid: A, subject: "build", status: "in_progress" },
		{ id: 3, uid: B, subject: "review", status: "pending", owner: "w3", metadata: { herdr: { id: "run-w3", name: "w3" } } },
	])])!;
	assert.equal(sum.doingUid, A);
	assert.deepEqual(sum.runs, [{ id: 3, run: "run-w3", uid: B }]);
	assert.equal(todoOk(sum), true);
	assert.equal(todoOk({ ...sum, doingUid: "t_BAD" }), false);
	assert.equal(todoOk({ ...sum, runs: [{ id: 3, run: "run-w3", uid: 7 }] }), false);
});

const unit = (over: Partial<Unit>): Unit => ({ id: over.key!, key: "k", control: true, name: "n", role: "main", mark: "idle", subs: [], ...over });
test("a mirror is bound with the uid of the todo it blocks: the launcher's run todo, the todo in progress, an explicit item that is one of those", () => {
	const ask = (question: string) => ({ question, options: [], multiple: false, freeform: true });
	const worker = unit({ key: "run-w3", name: "w3", role: "subagent", mark: "waiting", since: 1, pending: { callId: "c1", tool: "ask_user_question", ask: ask("A?") } });
	const main = unit({ key: "main-1", mark: "waiting", since: 2, subs: [worker], todo: { done: 0, total: 2, doing: 2, doingUid: A, runs: [{ id: 3, run: "run-w3", uid: B }] }, pending: { callId: "c2", tool: "ask_user_question", ask: ask("B?") } });
	const other = unit({ key: "main-2", mark: "waiting", since: 3, todo: { done: 0, total: 2, doing: 2, doingUid: A }, pending: { callId: "c3", tool: "ask_user_question", item: 5, ask: ask("C?") } });
	const n: Net = { bases: [{ id: "wA", label: "Alpha", mark: "waiting", outposts: [], outside: [], tabs: [{ id: "wA:t1", label: "docs", units: [main, other] }] }] } as unknown as Net;
	const by = Object.fromEntries(asksOfNet(n, { now: 9 }).entries.map((e) => [e.mirror, e.item]));
	assert.deepEqual(by["dialog:run-w3:c1"], { session: "main-1", id: 3, uid: B });
	assert.deepEqual(by["dialog:main-1:c2"], { session: "main-1", id: 2, uid: A });
	assert.deepEqual(by["dialog:main-2:c3"], { session: "main-2", id: 5 }, "an explicit item whose uid the summary does not hold has none");
});
