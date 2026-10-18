import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { until, World } from "./fakes.ts";

// The tower and the mains go together (index.ts, the guard): a live tower promotes each tab's earliest member, and a tower that quits, or stays
// gone past the grace a /reload gets, clears every main. A main stays while its tower may still be opening, and a tower outlives its last main.
// Herdr's events start the checks (`deps`, no sweep); the tests that move the clock past a grace use `swept`, a fast sweep standing in for the
// timer a check sets, since the fake clock does not move real timers.

let world = new World(), clock = 1_000_000;
afterEach(async () => {
	await world.stopAll();
	world = new World();
	clock = 1_000_000;
});
const deps = { guardMs: 0, now: () => clock }, swept = { guardMs: 50, now: () => clock };
const role = (pane: string) => world.herdr.pane(pane).tokens.sb_role;
async function member(id: string, pane: string, tab: string, d: typeof deps = deps) {
	const a = world.agent({ id, pane, tab, deps: d });
	await a.start();
	return a;
}
const ticks = async (n = 3) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 60));
};

test("a tower that opens promotes the earliest member of each tab, and only that one", async () => {
	await member("a", "wA:p1", "wA:t1");
	await member("b", "wA:p2", "wA:t1");
	await member("c", "wA:p3", "wA:t2");
	await ticks();
	assert.deepEqual(["wA:p1", "wA:p2", "wA:p3"].map(role), ["member", "member", "member"], "no tower, no mains");
	await world.tower("tower-wA", "wA:t7", "wA:p7").start();
	await until(() => role("wA:p1") === "main" && role("wA:p3") === "main", "the earliest member of each tab promoted");
	await ticks();
	assert.equal(role("wA:p2"), "member");
});

test("a tower that quits turns every main back into a member at once, and the tower outlives its last main", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const a = await member("a", "wA:p1", "wA:t1");
	await member("b", "wA:p2", "wA:t1");
	await until(() => role("wA:p1") === "main", "a promoted by the tower");
	await a.stop();
	await until(() => role("wA:p2") === "main", "the next earliest member takes over the tab");
	assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-wA", "the tower stays when a main leaves");
	clock += 61_000; // the main is no longer fresh
	await tower.stop();
	await until(() => role("wA:p2") === "member", "the main is cleared once the tower quit");
});

test("a tower gone for less than the grace (a /reload) keeps the mains; gone past it, they are cleared", async () => {
	await world.tower("tower-wA", "wA:t7", "wA:p7").start();
	await member("a", "wA:p1", "wA:t1", swept);
	await until(() => role("wA:p1") === "main", "a promoted");
	clock += 61_000;
	delete world.herdr.workspace("wA").tokens.tower; // as a reloading tower leaves it, with no quit said
	await ticks();
	clock += 10_000;
	await ticks();
	assert.equal(role("wA:p1"), "main", "within the grace");
	clock += 6_000;
	await until(() => role("wA:p1") === "member", "cleared past the grace");
});

test("a member that promotes in a base without a tower stays main while its tower may still be opening", async () => {
	const a = await member("a", "wA:p1", "wA:t1", swept);
	await a.promote();
	await ticks();
	clock += 30_000;
	await ticks();
	assert.equal(role("wA:p1"), "main");
	clock += 31_000;
	await until(() => role("wA:p1") === "member", "a main whose tower never came is cleared");
});

test("a base with two members opens its tower once another base has one, and not before", async () => {
	world.autoTowers();
	const auto = { ...deps, autoTower: true };
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: auto });
	await a.start();
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t2", deps: auto });
	await b.start();
	await ticks();
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined, "two members, but no other tower yet");
	await world.tower("tower-wB", "wB:t7", "wB:p7").start();
	await until(() => world.herdr.workspace("wA").tokens.tower, "Alpha's tower opened by the rule");
	await until(() => role("wA:p1") === "main" && role("wA:p2") === "main", "the tower promotes the member of each tab");
});

test("a lone member does not open a tower, whatever other bases have", async () => {
	world.autoTowers();
	await world.tower("tower-wB", "wB:t7", "wB:p7").start();
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { ...deps, autoTower: true } });
	await a.start();
	await ticks();
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined);
	assert.equal(role("wA:p1"), "member");
});

test("a tower dispatches no subagent: the call is blocked and points to boss_open_main", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const r = (await tower.fireResult("tool_call", { toolName: "subagent", toolCallId: "x", input: {} })) as { block?: boolean; reason?: string } | undefined;
	assert.equal(r?.block, true);
	assert.match(r!.reason!, /boss_open_main/);
});

test("a tower closed on purpose stays closed while the base keeps its members, and opens again once one more joins", async () => {
	world.autoTowers();
	const auto = { ...deps, autoTower: true };
	await world.tower("tower-wB", "wB:t7", "wB:p7").start();
	for (const [id, pane, tab] of [["a", "wA:p1", "wA:t1"], ["b", "wA:p2", "wA:t2"]]) await world.agent({ id, pane, tab, deps: auto }).start();
	await until(() => world.herdr.workspace("wA").tokens.tower, "Alpha's tower opened by the rule");
	await world.agents.find((x) => x.id === "tower-wA")!.stop();
	assert.equal(world.herdr.workspace("wA").tokens.sb_tower_quit, "2");
	await ticks(4);
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined, "not opened again for the same two members");
	world.herdr.addTab("wA:t3", "three", undefined);
	world.herdr.addPane("wA:p3", "wA:t3");
	await world.agent({ id: "c", pane: "wA:p3", tab: "wA:t3", deps: auto }).start();
	await until(() => world.herdr.workspace("wA").tokens.tower, "a third member opens it again");
});
