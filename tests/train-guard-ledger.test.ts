import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, LEDGER_GUARD, rig, run, SESSION_ID } from "./train-guard-rig.ts";
import { CODE, result, SHA_A } from "./train-fixtures.ts";

// The train guard on pi-todo-ledger's path (docs/specs/2026-11-24-todo-ledger.md): the whole train-guard suite runs again with the list kept by the ledger's contract, so the rules sb checks as the ledger's `todo:guard` are the ones it
// checks at `tool_call` beside rpiv-todo; the tests below cover what only this path has.

process.env.SB_TEST_TODO_PATH = "ledger";
await import("./train-guard.test.ts");

afterEach(cleanup);
const STEP_REQUIRED = /^sb: every todo of a train is a step/;

test("sb registers its guard with a ledger that loads after it (on todo:ready) or before it (at once), and stands its tool_call path down: a refusal comes once, as the ledger's error text", async () => {
	for (const ledgerFirst of [false, true]) {
		const r = rig({ todo: "ledger", ledgerFirst });
		assert.deepEqual([...r.guards.keys()], [LEDGER_GUARD], `registered (ledger first: ${ledgerFirst})`);
		const blocked = await r.fire("tool_call", { toolName: "todo", toolCallId: "x", input: { action: "create", subject: "no sb" } });
		assert.equal(blocked, undefined, "the tool_call path stood down");
		const refused = await r.todo({ action: "create", subject: "no sb" });
		assert.equal(refused.ok, false);
		assert.match(refused.reason ?? "", STEP_REQUIRED, "the reason is the ledger's `Error: guard sb-train refused: <reason>`, unwrapped by the rig");
		assert.equal(r.list.tasks.length, 0);
		assert.equal((await r.create(run(r))).ok, true);
		assert.deepEqual(r.entries.filter((e) => e.customType !== undefined).map((e) => e.customType), ["todo/v1"], "one change, one snapshot entry");
	}
});

test("a ledger sb never heard of yet (loaded first, no list restored) is learned from its first check: that call is judged on both paths, every later one by the ledger alone", async () => {
	const r = rig({ todo: "ledger", ledgerFirst: true, quiet: true });
	const first = await r.fire("tool_call", { toolName: "todo", toolCallId: "x", input: { action: "create", subject: "no sb" } });
	assert.equal(first?.block, true, "nothing says the ledger is there: the tool_call path judges");
	assert.equal((await r.create(run(r))).ok, true);
	assert.equal(r.changes.length, 1, "the ledger asked sb's guard");
	assert.equal(await r.fire("tool_call", { toolName: "todo", toolCallId: "y", input: { action: "create", subject: "no sb" } }), undefined, "its check proved the ledger: the tool_call path stands down");
	assert.match((await r.todo({ action: "create", subject: "no sb" })).reason ?? "", STEP_REQUIRED);
});

test("a no-op update after a /reload reaches the guard flagged noop and starts the step's clock again, as the same update does at tool_call", async () => {
	const r = rig({ todo: "ledger" });
	const id = await r.begin(run(r));
	await r.runStep(id);
	const again = rig({ reuse: r, todo: "ledger" });
	assert.match((await again.complete(id, result())).reason ?? "", /has no passed run of its spec \(last: none\)/);
	const entriesBefore = again.entries.length;
	assert.equal((await again.update(id, "in_progress")).ok, true);
	assert.equal(again.changes.at(-1)!.noop, true);
	assert.equal(again.entries.length, entriesBefore, "a no-op writes no entry");
	await again.runStep(id);
	assert.equal((await again.complete(id, result())).ok, true);
});

test("the ledger import guard checks the proposed list for this role and duty", async () => {
	const plain = { id: 1, subject: "ordinary work", status: "pending" };
	const train = { v: 1, kind: "train", project: "acme", app: "web", train: CODE, spec: { cars: [{ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: "none" }] } };
	const task = { ...plain, id: 2, metadata: { sb: train } };
	const check = (r: ReturnType<typeof rig>, ...after: unknown[]) => r.guards.get(LEDGER_GUARD)!({ op: "create", params: { action: "import", path: "/handoff.todos.json" }, before: [], after, sessionId: SESSION_ID, cwd: r.cwd });
	assert.match(String(await check(rig(), plain)), /a train's list is never imported/);
	const coordinator = rig({ train: false, main: true, duty: "coordinator" });
	assert.equal(await check(coordinator, plain), undefined);
	assert.match(String(await check(coordinator, plain, task)), /a train todo is the integrator's/);
	const opts = { train: false, main: true, duty: "integrator" }, integrator = rig(opts);
	assert.equal(await check(integrator, plain, task), undefined);
	assert.equal(await check(integrator, { ...task, status: "in_progress" }), undefined, "restoring an existing departure does not require forwards on the new branch");
	const withCar = (patch: Record<string, unknown>) => ({ ...task, metadata: { sb: { ...train, spec: { cars: [{ ...train.spec.cars[0], ...patch }] } } } });
	assert.match(String(await check(integrator, withCar({ accepted: ["uat"] }))), /leave accepted and unverified out/);
	assert.match(String(await check(rig({ ...opts, appAccept: ["e2e"] }), task)), /this app requires e2e/);
	assert.match(String(await check(integrator, withCar({ accept: "missing.json" }))), /cannot read the evidence file/);
	assert.match(String(await check(integrator, plain, task, { ...task, id: 3, status: "completed" })), /completed needs a result/);
	assert.equal(await check(rig({ ...opts, contract: { ok: false, refusal: "skill contract mismatch" } }), task), "skill contract mismatch");
});

test("a change of a session sb has not seen fails closed in a train: the guard cannot read its branch", async () => {
	const r = rig({ todo: "ledger" });
	const check = r.guards.get(LEDGER_GUARD)!;
	const reason = await check({ op: "create", params: { action: "create", subject: "s", metadata: { sb: run(r) } }, before: [], after: [{ id: 1, subject: "s", status: "pending" }], sessionId: "another", cwd: r.cwd });
	assert.match(String(reason), /^sb: the train guard could not check this call \(sb has not seen session another\); try again/);
	assert.equal(await check({ op: "create", params: { action: "create", subject: "s", metadata: { sb: run(r) } }, before: [], after: [{ id: 1, subject: "s", status: "pending" }], sessionId: SESSION_ID, cwd: r.cwd }), undefined);
	const member = rig({ todo: "ledger", train: false, main: false });
	assert.equal(await member.guards.get(LEDGER_GUARD)!({ op: "clear", params: { action: "clear" }, before: [], after: [], sessionId: "another", cwd: member.cwd }), undefined, "a session that is neither a train nor a main is not checked");
});
