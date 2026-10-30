import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { TOWER_LABEL } from "../src/herdr.ts";
import { until, World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const tower = { autoTower: true };
const towerTabs = () => world.herdr.commands("tab", "create").filter((c) => c.includes("STRAW_BOSS_ROLE=tower"));

test("a member that dispatches a subagent in a tab with no main is promoted before the call runs, and the tower opens", async () => {
	world.autoTowers();
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: tower });
	await a.start();
	assert.equal(a.tokens.sb_role, "member");
	await a.toolCall("read");
	assert.equal(a.tokens.sb_role, "member", "only the subagent tool promotes");
	await a.toolCall("subagent");
	assert.equal(a.tokens.sb_role, "main");
	assert.ok(a.notices.some((n) => n.text === "This session is now the main agent of work"));
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-wA", "the workspace tower");
	assert.equal(towerTabs().length, 1);
	assert.equal(world.herdr.tabs[0]?.label, TOWER_LABEL, "the tower tab is first");
	await world.quiet(); // the opening in flight settles before the next test (the in-flight guard is per process)
});

test("a member whose tab already has a main is not promoted by a subagent call, and boss_promote is refused", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	await a.promote();
	await b.toolCall("subagent");
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "main" }, { sb_role: "member" }]);
	await assert.rejects(b.tool("boss_promote"), /already has a main agent, a\..*tell a through intercom first/);
	assert.deepEqual(b.notices, [], "a refusal is silent for the automatic path");
});

test("resuming a subagent promotes like dispatching one, and a tab that has a main refuses it the same way", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	await a.toolCall("subagent_resume");
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "main" }, { sb_role: "member" }]);
	await b.toolCall("subagent_resume");
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "main" }, { sb_role: "member" }], "a live main is never taken over");
	assert.deepEqual(b.notices, []);
	await a.toolCall("subagent_send");
	await b.toolCall("subagents_list");
	assert.equal(b.tokens.sb_role, "member", "only subagent and subagent_resume promote");
});

test("each tab has its own main: members of two tabs both promote, and they share one tower in the workspace", async () => {
	world.autoTowers();
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: tower });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t2", deps: tower });
	await Promise.all([a.start(), b.start()]);
	await Promise.all([a.promote(), b.promote()]);
	await until(() => world.herdr.workspace("wA").tokens.tower, "the tower");
	await world.quiet();
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "main" }, { sb_role: "main" }]);
	assert.equal(towerTabs().length, 1, "later mains find the tower open");
	assert.equal(world.herdr.commands("agent", "start").length, 1);
});

test("the tower stays open when the main leaves, and the next main finds it", async () => {
	world.autoTowers();
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: tower });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1", deps: tower });
	await Promise.all([a.start(), b.start()]);
	await a.promote();
	await until(() => world.herdr.workspace("wA").tokens.tower, "the tower");
	await world.quiet();
	await a.stop();
	await world.quiet();
	assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-wA");
	await b.promote();
	await world.quiet();
	assert.equal(towerTabs().length, 1);
});

test("a main in a tab of another workspace opens that workspace's own tower, and a failed tower open is only a warning", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: tower });
	await a.start();
	await a.promote();
	await until(() => a.notices.some((n) => n.level === "warning" && /could not open the tower/.test(n.text)), "the warning");
	assert.equal(a.tokens.sb_role, "main", "the promotion stands");
	assert.deepEqual(towerTabs().map((c) => c[3]), ["wA"], "in its own workspace only");
});

test("sessions that never join do not promote: a subagent call in a sub workspace, a tower, or outside Herdr changes nothing", async () => {
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
	world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { checkout_path: "/w/f", is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "feature", "wS:p1");
	const sub = world.agent({ id: "sub-1", pane: "wS:p1", deps: tower });
	const t = world.tower("tower-wA", "wA:t7", "wA:p7");
	await Promise.all([sub.start(), t.start()]);
	await sub.toolCall("subagent");
	await t.toolCall("subagent");
	assert.deepEqual(sub.tokens, {});
	assert.deepEqual(t.tokens, { sb_role: "tower" });
	assert.deepEqual(world.broker.registrations.map((r) => r.id), ["tower-wA", "tower-wA"]);
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
});

test("Tab after /boss completes its subcommands as whole argument lines, and nothing for text that matches none", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	const complete = (prefix: string) => a.commands.get("boss")!.getArgumentCompletions!(prefix)?.map((item) => item.value) ?? null;
	assert.deepEqual(complete(""), ["status", "close", "close all", "tower", "tower status", "tower parked", "tower retry", "tower leave", "tower new", "gui", "gui stop", "gui rotate", "gui remote", "gui remote off", "gui lan", "gui lan off", "gui lan reset", "server", "server stop", "server restart", "memory", "memory confirm", "memory reject", "memory add standing", "memory add decision", "stash", "pop"]);
	assert.deepEqual(complete("memory a"), ["memory add standing", "memory add decision"]);
	assert.deepEqual(complete("gui r"), ["gui rotate", "gui remote", "gui remote off"]);
	assert.deepEqual(complete("t"), ["tower", "tower status", "tower parked", "tower retry", "tower leave", "tower new"]);
	assert.equal(complete("x"), null);
});
