import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createDigest } from "../src/digest.ts";
import { World } from "./fakes.ts";

// The tower's digest: joins, subagent launches, and renames in its workspace since its last run, read once into its next run.

let world: World;
afterEach(() => world.stopAll());

const digestOf = (sections: Record<string, string>) => sections["straw-boss"]?.split("Since your last run:")[1] ?? "";

test("the tower's next run reads what happened in its workspace since its last run, once", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	await a1.tool("boss_rename", { name: "MP-1 export" });
	await a1.fire("tool_result", { toolName: "subagent", toolCallId: "c1", input: { name: "lint-sweep", agent: "worker" }, content: [], isError: false });
	await a1.fire("tool_result", { toolName: "subagent", toolCallId: "c2", input: { name: "failed-one" }, content: [], isError: true });
	const b1 = world.agent({ id: "b1", pane: "wB:p1", tab: "wB:t1" });
	await b1.start();
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();

	const first = digestOf(await tower.run());
	assert.match(first, /a1 joined tab/);
	assert.match(first, /a1 renamed itself "MP-1 export"/);
	assert.match(first, /MP-1 export started subagent lint-sweep \(worker\)/);
	assert.doesNotMatch(first, /failed-one/, "a launch that failed started nothing");
	assert.doesNotMatch(first, /b1/, "another workspace's events belong to its own tower");
	assert.equal(digestOf(await tower.run()), "", "the digest is cleared once read");
});

test("a member's run carries no digest", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	assert.equal(digestOf(await a1.run()), "");
});

test("the digest keeps its newest lines within Herdr's token limits and leaves the workspace's other tokens alone", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	const run = world.herdr.runFor("wA:p1");
	await run(["workspace", "report-metadata", "wA", "--source", "other", "--token", "pin=x"]);
	let clock = Date.parse("2026-10-21T10:00:00");
	const digest = createDigest(run, () => clock++);
	await digest.take("wA"); // a1's own join, stamped by the real clock
	for (let i = 1; i <= 25; i++) await digest.note("wA", `event ${i} ${"x".repeat(i === 25 ? 200 : 0)}`);
	const lines = await digest.take("wA");
	assert.equal(lines.length, 20);
	assert.match(lines[0]!, / event 6$/);
	assert.match(lines.at(-1)!, /^\d\d:\d\d event 25 x+$/);
	assert.ok(Array.from(lines.at(-1)!).length <= 80);
	assert.deepEqual(await digest.take("wA"), []);
	assert.equal(world.herdr.workspace("wA").tokens.pin, "x");
});
