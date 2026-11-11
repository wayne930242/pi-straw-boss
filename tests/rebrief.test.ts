import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { World } from "./fakes.ts";

let world: World;
afterEach(() => world.stopAll());

test("a member promoted during a run gets the main prompt as a steer; the next run carries it in the system prompt", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	assert.match((await a1.run())["straw-boss"] ?? "", /member/i, "the run starts with a member's prompt");
	await a1.promote();
	const steer = a1.sent.filter((m) => m.customType === "straw-boss");
	assert.equal(steer.length, 1, "one steer for the change");
	assert.equal(steer[0]!.deliverAs, "steer");
	assert.match(steer[0]!.content, /You are the main agent of Herdr tab/);
	assert.match((await a1.run())["straw-boss"] ?? "", /You are the main agent of Herdr tab/);
});

test("only superseded, owned role steers leave the provider context after a full prompt rebuild", async (t) => {
	world = new World();
	const a = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.run();
	await a.promote();
	await a.tool("boss_duty", { duty: "standing", reason: "watch one service" });
	const steers = a.sent.filter((m) => m.customType === "straw-boss").map((m) => ({ role: "custom", ...m }));
	assert.equal(steers.length, 2);
	assert.equal(await a.fireResult("context_with_system", { messages: steers }), undefined, "same-run incremental steers stay, preserving the unchanged transcript");

	const system = { role: "system", content: "Keep every safety rule and tool declaration.", tools: [{ name: "read" }] };
	const patch = { role: "system", content: "Updated current prompt sections" };
	const user = { role: "user", content: "Do not deploy." };
	const result = { role: "toolResult", toolCallId: "t1", content: "Evidence" };
	const legacy = { role: "custom", customType: "straw-boss", content: "Unmarked legacy notice" };
	const foreign = { role: "custom", customType: "intercom-message", content: "Task handoff", details: steers[0]!.details };
	const messages = [system, user, ...steers, patch, result, legacy, foreign];
	const original = structuredClone(messages);
	assert.match((await a.run())["straw-boss"] ?? "", /standing|on watch/i, "the rebuilt prompt carries the current kind");
	const projected = await a.fireResult("context_with_system", { messages }) as { messages: unknown[] };
	assert.deepEqual(projected?.messages, [system, user, patch, result, legacy, foreign]);
	assert.deepEqual(messages, original, "the saved transcript is not mutated");
	assert.equal(a.sent.filter((m) => m.customType === "straw-boss").length, 2, "the visible history is retained");
	const removed = steers.reduce((n, m) => n + m.content.length, 0);
	assert.ok(removed > 500, `the real role steers removed ${removed} characters, not user evidence`);
	t.diagnostic(`Context fixture: ${steers.length} superseded role steers, ${removed} content characters removed; all user/tool/system/foreign messages retained. This is not a tokenizer or billing benchmark.`);
});

test("restored role steers are retired only after a current prompt exists; unknown formats stay", async () => {
	world = new World();
	const a = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.run();
	await a.promote();
	const old = { role: "custom", ...structuredClone(a.sent.find((m) => m.customType === "straw-boss")!) };
	const b = world.agent({ id: "a2", pane: "wA:p2", tab: "wA:t2" });
	await b.start();
	assert.equal(await b.fireResult("context_with_system", { messages: [old] }), undefined, "no full prompt yet: preserve everything");
	await b.run();
	const future = { ...old, details: { strawBossRoleBrief: { version: 2, generation: "future" } } };
	const malformed = { ...old, details: { strawBossRoleBrief: null } };
	const projected = await b.fireResult("context_with_system", { messages: [old, future, malformed] }) as { messages: unknown[] };
	assert.deepEqual(projected?.messages, [future, malformed]);
});

test("a role that changes while the session is idle waits for its next run", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	await a1.run();
	await a1.fire("agent_settled", { aborted: false });
	await a1.promote();
	assert.deepEqual(a1.sent.filter((m) => m.customType === "straw-boss"), [], "no steer after the run settled");
	assert.match((await a1.run())["straw-boss"] ?? "", /You are the main agent of Herdr tab/);
});
