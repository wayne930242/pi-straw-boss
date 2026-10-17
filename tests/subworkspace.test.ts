import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");

/** wA (Alpha) owns repo /r/alpha; wS is a linked worktree of it that Herdr opened as its own workspace. */
function withSub(options: { firstInList?: boolean; parent?: boolean } = {}) {
	const { firstInList = false, parent = true } = options;
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: parent ? "/r/alpha" : "/r/other" };
	const sub = { workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { checkout_path: "/w/alpha-feature", is_linked_worktree: true, repo_key: "/r/alpha" } };
	if (firstInList) world.herdr.workspaces.unshift(sub);
	else world.herdr.workspaces.push(sub);
	world.herdr.addTab("wS:t1", "feature", "wS:p1");
}

test("a session in a sub workspace gets no reminder, no boss_join, and cannot join or take over with /boss", async () => {
	withSub();
	const s = world.agent({ id: "sub-1", pane: "wS:p1" });
	await s.start();
	assert.deepEqual([...s.tools.keys()], []);
	assert.deepEqual(await s.run(), {}, "no join reminder");
	assert.deepEqual(s.entries, [], "not even the asked entry");
	await s.command();
	await s.command("tower");
	assert.equal(s.notices.filter((n) => n.level === "error" && /Alpha feature is a sub workspace/.test(n.text)).length, 2);
	assert.deepEqual(world.broker.registrations, []);
	assert.deepEqual(s.tokens, {});
});

test("a sub workspace session that had joined before does not rejoin on resume", async () => {
	withSub();
	const s = world.agent({ id: "sub-1", pane: "wS:p1", entries: [{ customType: "straw-boss", data: { asked: true, joined: true } }] });
	await s.start();
	assert.deepEqual(world.broker.registrations, []);
	assert.deepEqual(s.tokens, {});
});

test("when Herdr cannot say whether the workspace is a sub workspace the session is barred and says why", async () => {
	const runFor = world.herdr.runFor.bind(world.herdr);
	world.herdr.runFor = (self: string) => async (args: string[]) => {
		if (args[0] === "workspace") throw new Error("herdr workspace list failed: socket closed");
		return runFor(self)(args);
	};
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await b.start();
	assert.deepEqual([...b.tools.keys()], []);
	assert.ok(b.notices.some((n) => n.level === "error" && /could not tell whether this is a sub workspace: .*socket closed/.test(n.text)), JSON.stringify(b.notices));
	assert.deepEqual(await b.run(), {});
});

test("broadcast scopes tab, workspace, and towers skip sub workspace sessions; scope all reaches them", async () => {
	withSub();
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const s = world.agent({ id: "sub-1", pane: "wS:p1" });
	await Promise.all([tower.start(), a.start(), s.start()]);
	await a.promote();
	await a.tool("boss_broadcast", { message: "net", scope: "workspace" });
	assert.deepEqual(world.broker.delivered.map((d) => d.to), ["tower-wA"]);
	await a.tool("boss_broadcast", { message: "everyone", scope: "all" });
	assert.deepEqual(world.broker.delivered.slice(1).map((d) => d.to).sort(), ["sub-1", "tower-wA"]);
});

test("call_tower for a sub workspace routes to its parent's tower, opening it on demand", async () => {
	withSub();
	world.autoTowers();
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.promote();
	const result = await a.tool("call_tower", { message: "the feature branch needs port 3000", workspace: "Alpha feature" });
	assert.equal(world.broker.delivered[0]?.to, "tower-wA");
	assert.match(textOf(result), /Sent to the tower of Alpha \(Alpha feature is a sub workspace\) \(opened it\)/);
	assert.deepEqual(world.herdr.commands("tab", "create").map((c) => c[3]), ["wA"], "no tab was created in the sub workspace");
	assert.equal(world.herdr.workspace("wS").tokens.tower, undefined);
	assert.deepEqual((result.details as { workspace: string }).workspace, "wA");
});

test("call_tower for a sub workspace whose parent workspace is not open is an error, and opens nothing", async () => {
	withSub({ parent: false });
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.promote();
	await assert.rejects(a.tool("call_tower", { message: "hi", workspace: "wS" }), /Alpha feature is a sub workspace with no open parent workspace/);
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
});

test("the head tower is the tower of the first workspace that is not a sub workspace", async () => {
	withSub({ firstInList: true });
	const towerA = world.tower("tower-wA", "wA:t7", "wA:p7");
	const towerB = world.tower("tower-wB", "wB:t7", "wB:p7");
	await Promise.all([towerA.start(), towerB.start()]);
	const status = JSON.parse((await towerB.tool("boss_status")).content.map((c) => (c as { text: string }).text).join(""));
	assert.equal(status.head, "wA");
	assert.deepEqual([status.towers[0].id, status.towers[0].head], ["tower-wA", true]);
	assert.match((await towerB.run())["straw-boss"]!, /head tower, the tower of workspace Alpha/);
});
