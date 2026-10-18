import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { settle, World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

async function main(id: string, pane: string, tab: string) {
	const agent = world.agent({ id, name: id, pane, tab });
	await agent.start();
	await agent.promote();
	return agent;
}
const tokens = (pane: string) => world.herdr.pane(pane).tokens;

test("a new Herdr server's takeover makes every session write its tokens again at once, not at the 4 minute refresh", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const a = await main("a", "wA:p1", "wA:t1");
	const b = world.agent({ id: "b", name: "b", pane: "wA:p2", tab: "wA:t1" });
	await b.start();
	const before = [tokens("wA:p7"), tokens("wA:p1"), tokens("wA:p2"), world.herdr.workspace("wA").tokens];
	assert.ok(before.every((t) => Object.keys(t).length >= 1) && before[1]!.sb_role === "main" && before[1]!.sb_order);

	await world.takeover();
	assert.deepEqual([tokens("wA:p7"), tokens("wA:p1"), tokens("wA:p2"), world.herdr.workspace("wA").tokens], before);
	assert.ok(a && tower && b);
});

test("a tower writes the workspace token and its own role first, so no session finds the workspace without a tower", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await main("a", "wA:p1", "wA:t1");
	world.herdr.restart();
	for (const watcher of [...world.watchers]) watcher.onTakeover();
	await world.quiet();
	const writes = world.herdr.calls.filter((args) => args[1] === "report-metadata").map((args) => `${args[0]} ${args[2]}`);
	assert.deepEqual(writes.slice(0, 2).sort(), ["pane wA:p7", "workspace wA"], "the tower's two marks come before anyone's net tokens");
	assert.equal(world.herdr.calls.findIndex((args) => args[0] === "pane" && args[1] === "list"), world.herdr.calls.findIndex((args) => args[1] === "report-metadata") + 2, "and before the reads for the rest");
});

test("after a takeover call_tower still finds the tower instead of opening a second one", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const a = await main("a", "wA:p1", "wA:t1");
	await world.takeover();
	await a.tool("call_tower", { message: "hi" });
	assert.equal(world.herdr.commands("tab", "create").length + world.herdr.commands("agent", "start").length, 0);
	assert.deepEqual(world.broker.delivered.map((d) => d.to), ["tower-wA"]);
});

test("the subagents a session marked get their tokens back too", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-takeover-"));
	try {
		mkdirSync(join(dir, "sessions", "artifacts", "a", "subagent-activity"), { recursive: true });
		writeFileSync(join(dir, "sessions", "artifacts", "a", "subagent-activity", "kid-a.json"), JSON.stringify({ phase: "active" }));
		world.herdr.workspaces.unshift({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
		world.herdr.addTab("wS:t1", "child", "wS:p1");
		const a = world.agent({ id: "a", name: "Solo", pane: "wA:p1", tab: "wA:t1" });
		world.herdr.pane("wA:p1").agent_session = { value: join(dir, "sessions", "2026-10-18T00-00-00-000Z_a.jsonl") };
		Object.assign(world.herdr.pane("wS:p1"), { agent: "pi", agent_status: "working", label: "aaa", agent_session: { value: join(dir, "sessions", "2026-10-18T00-00-01-000Z_kid-a-1a2b3c4d-5e6f7a8b-9c0d.jsonl") } });
		await a.start();
		await a.promote();
		const marked = { ...tokens("wS:p1") };
		assert.deepEqual(Object.keys(marked).sort(), ["sb_indent", "sb_mark", "sb_name", "sb_order"]);
		await world.takeover();
		assert.deepEqual(tokens("wS:p1"), marked);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a session that has not joined, a session that was shut down, and a subagent write nothing on a takeover", async () => {
	const barred = world.agent({ id: "s", pane: "wA:p3", tab: "wA:t2", env: { PI_SUBAGENT_ID: "child" } });
	await barred.start();
	assert.equal(world.watchers.size, 0, "a subagent holds no watch");
	const a = await main("a", "wA:p1", "wA:t1");
	assert.equal(world.watchers.size, 1);
	await a.stop();
	assert.equal(world.watchers.size, 0, "shutdown stops the watch");
	await world.takeover();
	assert.deepEqual(world.herdr.calls, [], "and nothing is written for it");
	assert.deepEqual(tokens("wA:p1"), {});
});

test("a session in a sub workspace holds no watch, a tower's quit stops it, and a failed read of Herdr leaves the takeover quiet", async () => {
	world.herdr.workspaces.push({ workspace_id: "wS", label: "child", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "child", "wS:p1");
	await world.agent({ id: "sub", pane: "wS:p1" }).start();
	assert.equal(world.watchers.size, 0);
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	assert.equal(world.watchers.size, 1);
	world.herdr.failReads = true;
	await assert.doesNotReject(world.takeover());
	assert.deepEqual(world.herdr.workspace("wA").tokens, { tower: "tower-wA" }, "the tower's marks need no read");
	await tower.stop();
	assert.equal(world.watchers.size, 0);
});

test("a reload leaves one watch: the old instance stopped its own, and a session started again in the same instance replaces its watch", async () => {
	const first = world.agent({ id: "a", name: "a", pane: "wA:p1", tab: "wA:t1" });
	await first.start();
	assert.equal(world.watchers.size, 1);
	await first.fire("session_shutdown", { reason: "reload" });
	assert.equal(world.watchers.size, 0);
	const second = world.agent({ id: "a2", name: "a2", pane: "wA:p1", tab: "wA:t1" });
	await second.start();
	assert.equal(world.watchers.size, 1);
	await second.start(); // session_start again in one instance (new, resume, fork)
	assert.equal(world.watchers.size, 1, "the earlier watch is stopped before the new one starts");
	await world.takeover();
	assert.equal(world.herdr.calls.filter((args) => args[0] === "pane" && args[1] === "report-metadata" && args[2] === "wA:p1").length, 1, "one publish for one takeover");
	await settle();
});
