import assert from "node:assert/strict";
import { test } from "node:test";
import { anchorProblem, createPreflight, preflightOf } from "../src/preflight.ts";

// The todo preflight (docs/specs/2026-11-28-todo-preflight.md; boss 2026-11-28 「todo 驗收檢查」): before sb dispatches for a todo (`subagent` with `item`, `boss_pair` with `item`), it checks the
// todo's anchor and its blockedBy graph. A missing or vague anchor and a deleted or unknown blocker warn on the result; a cycle refuses the launch, since that todo never becomes ready.

const SESSION = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
type Task = { id: number; subject?: string; status?: string; uid?: string; anchor?: string; blockedBy?: number[] };
const snapshot = (tasks: Task[]) => ({ v: 1, nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1, tasks: tasks.map((t) => ({ subject: `t${t.id}`, status: "pending", ...t })) });
const entry = (tasks: Task[]) => ({ type: "custom", customType: "todo/v1", data: snapshot(tasks) });
const local = (id: number) => `0a1b2c3d#${id}`;

test("an anchor is missing, vague, or a runnable check: a command or a concrete observable", () => {
	for (const a of [undefined, "", "   "]) assert.equal(anchorProblem(a), "missing", JSON.stringify(a));
	for (const a of ["tests pass", "works", "Done.", "it works", "LGTM", "verified", "TBD", "完成", "測試通過", "all green", "check it"]) assert.equal(anchorProblem(a), "vague", a);
	for (const a of ["npm test", "npm run test:one -- tests/preflight.test.ts", "`go test ./...` passes", "uv run pytest tests/unit", "the page lists 3 rows", "GET /api/asks returns 409", "Credit notes round before tax", "a red test shows the 0.01 drift", "紅燈測試重現 0.01 誤差", "結帳頁顯示折扣後的總額與稅額"]) assert.equal(anchorProblem(a), undefined, a);
});

test("a todo with a runnable anchor and done blockers passes with nothing to say", () => {
	const s = snapshot([{ id: 1, status: "completed", anchor: "npm test" }, { id: 2, anchor: "npm run check", blockedBy: [1] }]);
	assert.deepEqual(preflightOf(s, local(2), SESSION), { warnings: [] });
	assert.deepEqual(preflightOf(s, "t_abcdefghij", SESSION), { warnings: ["sb preflight: item t_abcdefghij names no todo in your list, so this launch is bound to no todo."] });
});

test("a missing or vague anchor warns and names the fix; the launch is not refused", () => {
	const missing = preflightOf(snapshot([{ id: 4, uid: "t_aaaaaaaaaa" }]), "t_aaaaaaaaaa", SESSION)!;
	assert.equal(missing.refusal, undefined);
	assert.match(missing.warnings.join("\n"), /todo #4 has no anchor.*todo update.*anchor/);
	const vague = preflightOf(snapshot([{ id: 4, anchor: "tests pass" }]), local(4), SESSION)!;
	assert.match(vague.warnings.join("\n"), /todo #4's anchor "tests pass" names no runnable check/);
});

test("a cycle in the todo's blockedBy closure refuses, with the cycle's path", () => {
	const s = snapshot([{ id: 1, anchor: "npm test", blockedBy: [2] }, { id: 2, anchor: "npm test", blockedBy: [3] }, { id: 3, anchor: "npm test", blockedBy: [2] }]);
	const r = preflightOf(s, local(1), SESSION)!;
	assert.match(r.refusal ?? "", /todo #1 .*cycle \(#2 → #3 → #2\).*never becomes ready.*removeBlockedBy/);
	const self = preflightOf(snapshot([{ id: 5, anchor: "npm test", blockedBy: [5] }]), local(5), SESSION)!;
	assert.match(self.refusal ?? "", /cycle \(#5 → #5\)/);
	// A cycle elsewhere in the list, which this todo does not wait on, is not this launch's business.
	assert.equal(preflightOf(s, local(9), SESSION)?.refusal, undefined);
	assert.equal(preflightOf(snapshot([...s.tasks, { id: 9, anchor: "npm test" }] as Task[]), local(9), SESSION)?.refusal, undefined);
});

test("a deleted or unknown blocker warns: the dependency it records is gone", () => {
	const r = preflightOf(snapshot([{ id: 1, status: "deleted" }, { id: 2, anchor: "npm test", blockedBy: [1, 7] }]), local(2), SESSION)!;
	assert.equal(r.refusal, undefined);
	assert.match(r.warnings.join("\n"), /todo #2 waits on deleted #1 and unknown #7/);
});

test("an item of another session, a tombstoned todo, and a list that is no ledger's", () => {
	assert.equal(preflightOf(snapshot([{ id: 2 }]), "ffffffff#2", SESSION), undefined, "another session's todo: its own main checks it");
	assert.match(preflightOf(snapshot([{ id: 2, status: "deleted" }]), local(2), SESSION)!.warnings[0]!, /todo #2 is deleted/);
	assert.match(preflightOf(undefined, local(2), SESSION)!.warnings[0]!, /names no todo/, "no list at all binds nothing");
	assert.equal(preflightOf({ tasks: [{ id: 2, subject: "x", status: "pending" }], nextId: 3 }, local(2), SESSION)?.warnings.length, 0, "rpiv-todo keeps no anchor: nothing to warn of");
	assert.equal(preflightOf(snapshot([{ id: 2 }]), "not an item", SESSION), undefined);
});

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;
function world(entries: unknown[]) {
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (type: string, h: Handler) => void handlers.set(type, [...(handlers.get(type) ?? []), h]) };
	const pf = createPreflight(pi as never);
	const ctx = { sessionManager: { getBranch: () => entries, getSessionId: () => SESSION } };
	const call = (id: string, input: Record<string, unknown>) => pf.admit(id, "subagent", input, ctx as never);
	const result = (id: string, isError = false) => (handlers.get("tool_result") ?? []).map((h) => h({ toolName: "subagent", toolCallId: id, input: {}, content: [{ type: "text", text: "started" }], isError })).find((x) => x !== undefined) as { content: { text: string }[] } | undefined;
	return { call, result, turnEnd: () => (handlers.get("turn_end") ?? []).forEach((h) => h({})), entries };
}

test("the subagent call: a cycle blocks it; a warning rides on its result once; a launch without item is not looked at", () => {
	const w = world([entry([{ id: 1, blockedBy: [1] }, { id: 2 }, { id: 3, anchor: "npm test" }])]);
	assert.match((w.call("c1", { item: local(1) }) as { block: true; reason: string }).reason, /cycle/);
	assert.equal(w.call("c2", { item: local(2) }), undefined);
	const out = w.result("c2");
	assert.equal(out?.content[0]!.text, "started");
	assert.match(out!.content[1]!.text, /todo #2 has no anchor/);
	assert.equal(w.result("c2"), undefined, "said once");
	assert.equal(w.call("c3", { item: local(3) }), undefined);
	assert.equal(w.result("c3"), undefined, "nothing to say");
	assert.equal(w.call("c4", { name: "scout" }), undefined);
	assert.equal(w.call("c5", { item: local(2) }), undefined);
	w.turnEnd();
	assert.equal(w.result("c5"), undefined, "a call the turn ended without a result leaves nothing behind");
});

// The claim (spec P8): the preflight's CPU median is ≤ 5 ms a launch on a 5,000-row ledger with ≤ 12 blockers a todo, each launch after a todo call wrote a new snapshot, read through pi's
// own SessionManager (its getBranch walks the tree from the leaf at every call). It is this process's CPU time, so a loaded machine that deschedules the test does not count, and it is a
// median, not a bound on every launch: the p95 and max are reported, not asserted (an all-open list's p95 ran about 10 ms in review F007).
for (const [label, blockers, done] of [["a chain", 2, 4000], ["12 blockers a todo", 12, 4000], ["12 blockers a todo, every row open", 12, 0]] as const) {
	test(`the preflight's CPU median on a 5000-row ledger is at most 5 ms a launch: ${label}`, async () => {
		const { SessionManager } = await import("@earendil-works/pi-coding-agent");
		const tasks: Task[] = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, anchor: "npm test", status: i < done ? "completed" : "pending", blockedBy: Array.from({ length: Math.min(i, blockers) }, (_, k) => i - k) }));
		const sm = SessionManager.inMemory("/w");
		for (let i = 0; i < 2000; i++) sm.appendMessage({ role: "user", content: "x", timestamp: 0 } as never);
		const pf = createPreflight(), ctx = { sessionManager: { getBranch: () => sm.getBranch(), getSessionId: () => SESSION } };
		const runs: number[] = [];
		for (let i = 0; i < 31; i++) {
			sm.appendCustomEntry("todo/v1", snapshot(tasks)); // a todo call before each launch
			const began = process.cpuUsage();
			assert.equal(pf.admit(`p${i}`, "subagent", { item: local(5000) }, ctx as never), undefined);
			const used = process.cpuUsage(began);
			if (i) runs.push((used.user + used.system) / 1000); // the first warms the JIT
		}
		runs.sort((a, b) => a - b);
		const median = runs[runs.length >> 1]!, p95 = runs[Math.floor(runs.length * 0.95)]!;
		console.log(`preflight on 5000 rows, ${label}: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${runs.at(-1)!.toFixed(2)} ms of CPU`);
		assert.ok(median <= 5, `median ${median} ms`);
	});
}

test("boss_pair with item: a cycle refuses before the thread opens; a warning follows its text", async () => {
	const { createBossPair } = await import("../src/bosspair.ts");
	type Tool = { name: string; execute(id: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<{ content: { text: string }[] }> };
	const tools = new Map<string, Tool>(), asked: unknown[] = [];
	const kit = { pi: { registerTool: (t: Tool) => tools.set(t.name, t) }, s: { isTower: false }, me: () => "P", role: () => "main" };
	createBossPair(kit as never, { ask: async (r: Record<string, unknown>) => (asked.push(r), { ok: true, thread: "T1", rounds: 3, worker: "w", reviewer: "r" }), remote: () => false }).addTool();
	const ctx = { sessionManager: { getBranch: () => [entry([{ id: 1, blockedBy: [2] }, { id: 2, blockedBy: [1] }, { id: 3 }])], getSessionId: () => SESSION } };
	await assert.rejects(tools.get("boss_pair")!.execute("c1", { worker: "w", reviewer: "r", item: local(1) }, undefined, undefined, ctx), /cycle \(#1 → #2 → #1\)/);
	assert.deepEqual(asked, [], "no thread opened");
	const out = await tools.get("boss_pair")!.execute("c2", { worker: "w", reviewer: "r", item: local(3) }, undefined, undefined, ctx);
	assert.match(out.content[0]!.text, /^Thread T1: [\s\S]*\nsb preflight: todo #3 has no anchor/);
	assert.equal(asked.length, 1);
});

test("a session that may not join the net (a sub workspace's) still has its launch's todo looked at", async () => {
	const { World } = await import("./fakes.ts");
	const world = new World();
	try {
		world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
		world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { checkout_path: "/w/f", is_linked_worktree: true, repo_key: "/r/alpha" } });
		world.herdr.addTab("wS:t1", "feature", "wS:p1");
		const sub = world.agent({ id: "sub-1", pane: "wS:p1", entries: [{ customType: "todo/v1", data: snapshot([{ id: 1, anchor: "npm test", blockedBy: [1] }]) }] });
		await sub.start();
		assert.deepEqual(sub.tokens, {}, "it joined nothing");
		const out = await sub.fireResult("tool_call", { toolName: "subagent", toolCallId: "c1", input: { name: "w", task: "t", item: "sub-1#1" } }) as { block?: boolean; reason?: string } | undefined;
		assert.match(out?.reason ?? "", /cycle \(#1 → #1\)/);
	} finally { await world.stopAll(); }
});

test("a blocker already done frees the todo: a cycle past it is not this launch's, as capacity counts readiness", () => {
	const s = snapshot([{ id: 1, anchor: "npm test", blockedBy: [2] }, { id: 2, status: "completed", blockedBy: [3] }, { id: 3, blockedBy: [2] }]);
	assert.equal(preflightOf(s, local(1), SESSION)?.refusal, undefined);
});

test("a known empty phrase is vague even when it starts with a command word; a local item with no list at all is still told", () => {
	for (const a of ["test passes", "tests pass", "test", "make it work"]) assert.equal(anchorProblem(a), "vague", a);
	assert.match(preflightOf(undefined, local(2), SESSION)?.warnings[0] ?? "", /names no todo in your list/);
	assert.match(preflightOf(undefined, "t_abcdefghij", SESSION)?.warnings[0] ?? "", /names no todo in your list/);
	assert.equal(preflightOf(undefined, "ffffffff#2", SESSION), undefined, "another session's item: its own main checks it");
});
