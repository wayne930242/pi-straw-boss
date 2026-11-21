import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { World } from "./fakes.ts";

let world: World;
afterEach(() => world.stopAll());

test("a member promoted during a run gets the main prompt as a steer without rewriting the system section", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	const first = (await a1.run())["straw-boss"] ?? "";
	assert.match(first, /member/i, "the run starts with a member's prompt");
	await a1.promote();
	const steer = a1.sent.filter((m) => m.customType === "straw-boss");
	assert.equal(steer.length, 1, "one steer for the change");
	assert.equal(steer[0]!.deliverAs, "steer");
	assert.match(steer[0]!.content, /You are the main agent of Herdr tab/);
	assert.equal((await a1.run())["straw-boss"] === first, true, "promotion must not rewrite the section");
});

test("a role that changes while the session is idle waits for its next run", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	const first = (await a1.run())["straw-boss"];
	await a1.fire("agent_settled", { aborted: false });
	await a1.promote();
	const steers = () => a1.sent.filter((m) => m.customType === "straw-boss");
	assert.deepEqual(steers(), [], "no steer after the run settled");
	assert.equal((await a1.run())["straw-boss"] === first, true, "promotion must not rewrite the section");
	assert.match(steers()[0]!.content, /You are the main agent of Herdr tab/);
});
