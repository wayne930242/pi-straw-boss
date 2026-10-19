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
