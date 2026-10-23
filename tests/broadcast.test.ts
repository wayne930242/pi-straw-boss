import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Agent, bare, World } from "./fakes.ts";

let world: World;
let a1: Agent;
let tower: Agent;
beforeEach(async () => {
	world = new World();
	a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	const a2 = world.agent({ id: "a2", pane: "wA:p2", tab: "wA:t1" });
	// a3 sits in a sub workspace of Alpha, so it never joins.
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
	world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { checkout_path: "/w/f", is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "feature", "wS:p3");
	world.agent({ id: "a3", pane: "wS:p3" });
	const c = world.agent({ id: "c", pane: "wA:p4", tab: "wA:t2" });
	const d = world.agent({ id: "d", pane: "wB:p1", tab: "wB:t1" });
	tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	const towerB = world.tower("tower-wB", "wB:t7", "wB:p7");
	world.agent({ id: "worker", pane: "wA:p5", tab: "wA:t1", env: { PI_SUBAGENT_ID: "run-1" } });
	world.agent({ id: "outside", pane: "none", outsideHerdr: true });
	await Promise.all(world.agents.map((agent) => agent.start()));
	for (const agent of [a1, a2, c, d]) await agent.promote();
	assert.ok(tower && towerB);
	world.broker.delivered.length = 0;
});
afterEach(() => world.stopAll());

const sent = async (agent: Agent, scope?: string) => {
	world.broker.delivered.length = 0;
	await agent.tool("boss_broadcast", { message: "lunch", ...(scope ? { scope } : {}) });
	return world.broker.delivered.map((d) => d.to).sort();
};

test("tab, workspace, and towers reach only sessions that joined the net and skip the sender; a session that joined as a member is reached", async () => {
	assert.deepEqual(await sent(a1, "tab"), ["a2"]);
	assert.deepEqual(await sent(a1, "workspace"), ["a2", "c", "tower-wA"]);
	assert.deepEqual(await sent(a1), ["a2", "c", "tower-wA"], "workspace is the default scope");
	assert.deepEqual(await sent(a1, "towers"), ["tower-wA", "tower-wB"]);
});

test("a tower broadcasts to the mains of its workspace and never to itself", async () => {
	assert.deepEqual(await sent(tower, "workspace"), ["a1", "a2", "c"]);
	assert.deepEqual(await sent(tower, "towers"), ["tower-wB"]);
});

test("scope all reaches every other pi session on the machine, joined or not, workers and non-Herdr sessions included", async () => {
	assert.deepEqual(await sent(a1, "all"), ["a2", "a3", "c", "d", "outside", "tower-wA", "tower-wB", "worker"]);
});

test("one failed recipient fails the call after the others were reported, and the message is sent once each", async () => {
	world.broker.failing.add("c");
	await assert.rejects(a1.tool("boss_broadcast", { message: "lunch" }), /Not every recipient received it:\n.*c: failed \(delivery_failed\)/s);
	assert.deepEqual(world.broker.delivered.map((d) => d.to).sort(), ["a2", "tower-wA"]);
	assert.deepEqual(world.broker.delivered.map((d) => bare(d.message)), ["lunch", "lunch"]);
});

test("a broadcast with no recipients succeeds and says so", async () => {
	const lonely = world.agent({ id: "lonely", pane: "wB:p5", tab: "wB:t1" });
	await lonely.start();
	await lonely.promote();
	const result = await lonely.tool("boss_broadcast", { message: "anyone?", scope: "tab" });
	assert.match(result.content.map((c) => (c.type === "text" ? c.text : "")).join(""), /Broadcast to 1 session\(s\)/);
});

test("a restarted pi keeps its session id, and what it sends carries a message id the broker has not seen from that session", async () => {
	world.broker.delivered.length = 0;
	await a1.tool("boss_broadcast", { message: "one", scope: "tab" });
	await a1.stop();
	const again = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await again.start();
	await again.tool("boss_broadcast", { message: "two", scope: "tab" });
	assert.deepEqual(world.broker.delivered.map((d) => [d.to, bare(d.message)]), [["a2", "one"], ["a2", "two"]]);
});
