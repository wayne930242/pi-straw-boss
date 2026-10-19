import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { World } from "./fakes.ts";

let world: World;
afterEach(() => world.stopAll());

test("boss_rename names the session with its phrase, trimmed", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	await a1.promote();
	await a1.tool("boss_rename", { name: "  MP-3584   cost mask " });
	assert.equal(a1.name, "MP-3584 cost mask");
	assert.ok((await world.broker.sessionList()).some((s) => s.id === "a1" && s.name === "MP-3584 cost mask"), "the net sees the new name");
});

test("boss_rename refuses an empty or overlong name, and a tower keeps its own", async () => {
	world = new World();
	const a1 = world.agent({ id: "a1", pane: "wA:p1", tab: "wA:t1" });
	await a1.start();
	await a1.promote();
	await assert.rejects(a1.tool("boss_rename", { name: "   " }), /empty/);
	await assert.rejects(a1.tool("boss_rename", { name: "長".repeat(41) }), /short phrase/);
	assert.equal(a1.name, "a1");
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await assert.rejects(tower.tool("boss_rename", { name: "busy" }), /has no tool boss_rename/, "a tower keeps its name: the net recognises it by it");
});
