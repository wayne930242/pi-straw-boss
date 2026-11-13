import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TOWER_LABEL } from "../src/herdr.ts";
import { type Agent, until, World } from "./fakes.ts";

// docs/specs/2026-11-09-agent-kinds.md §6, Phase 2 "The opener": `boss_open_main` takes an optional `duty`; the opener writes `sb_open_duty` beside `sb_open_main`, the new pi consumes both,
// and the duty goes into its entries and its role record, so a Herdr restore before its first message still brings it back with its kind.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const REQUEST = "Mind the nightly backup host.";
const OPENED = { file: "/s/opened.jsonl", pane: "wA:p101", id: "opened-1" };
const tokens = (pane: string) => world.herdr.pane(pane).tokens;

async function pi(options: Parameters<World["agent"]>[0], file: string): Promise<Agent> {
	const agent = world.agent(options);
	agent.file = file;
	await agent.start();
	return agent;
}
async function net() {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7");
	const tower = await pi({ id: "tower-1", pane: "wA:p7", tab: "wA:t7", env: { STRAW_BOSS_ROLE: "tower" } }, "/s/tower.jsonl");
	const sender = await pi({ id: "sender-1", name: "docs-main", pane: "wA:p1", tab: "wA:t1" }, "/s/sender.jsonl");
	await sender.promote();
	world.herdr.onAgentStart = (pane) => void pi({ id: OPENED.id, name: "main · opened", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "main" } }, OPENED.file);
	return { tower, sender };
}
const opened = () => world.agents.find((a) => a.id === OPENED.id)!;
const dutyEntries = (agent: Agent) => agent.entries.filter((e) => e.customType === "straw-boss" && (e.data as { duty?: unknown }).duty !== undefined).map((e) => e.data as { duty: string; dutyFrom: unknown; dutyWhy: string });
const records = () => readdirSync(join(world.stateDir, "roles")).map((name) => JSON.parse(readFileSync(join(world.stateDir, "roles", name), "utf8")) as { role: string; pane: string; duty?: string });

test("boss_open_main with duty standing: sb_open_duty is written beside sb_open_main, consumed with it, and the new main runs as standing from its first turn", async () => {
	const { tower } = await net();
	await tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1", duty: "standing" });
	await until(() => tokens(OPENED.pane).sb_role === "main", "the opened pi is the main");
	assert.equal(tokens(OPENED.pane).sb_open_main, undefined, "the one-time token was consumed");
	assert.equal(tokens(OPENED.pane).sb_open_duty, undefined, "and the duty token with it");
	assert.equal(tokens(OPENED.pane).sb_duty, "standing");
	assert.deepEqual(dutyEntries(opened()).map(({ duty, dutyFrom, dutyWhy }) => ({ duty, dutyFrom, dutyWhy })), [{ duty: "standing", dutyFrom: null, dutyWhy: "opened by tower tower-1 as standing" }]);
	assert.ok(world.herdr.calls.some((args) => args[1] === "report-metadata" && args[2] === OPENED.pane && args.join(" ").includes("sb_open_duty")), "the opener wrote the duty token");
	assert.equal(records().find((r) => r.pane === OPENED.pane)?.duty, "standing", "the role record carries the duty");
	const sections = await opened().run();
	assert.match(sections["straw-boss"] ?? "", /## Kind: standing/, "its first run's prompt is the standing main's");
});

test("a duty with role train, or integrator without the door, opens nothing", async () => {
	const { tower } = await net();
	await assert.rejects(tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1", duty: "integrator" }), /integrator/);
	await assert.rejects(tower.tool("boss_open_main", { request: "project: acme\ncode: 1113a", sender: "sender-1", role: "train", duty: "standing" }), /train/);
	assert.equal(world.herdr.commands("tab", "create").length, 0);
});

test("a main opened as standing that a Herdr restore brings back before its first message gets the duty from its record", async () => {
	const { tower } = await net();
	await tower.tool("boss_open_main", { request: REQUEST, sender: "sender-1", duty: "standing" });
	await until(() => tokens(OPENED.pane).sb_duty === "standing", "the opened main is standing");
	world.herdr.onAgentStart = undefined;
	// Herdr stops; the panes and tabs stay, the tokens go, and the resumed pi has none of its entries (pi wrote no file before a first message).
	const [panes, tabs] = [[...world.herdr.panes], [...world.herdr.tabs]];
	for (const agent of [...world.agents]) await agent.stop("quit");
	[world.herdr.panes, world.herdr.tabs] = [panes, tabs];
	world.herdr.restart();
	await pi({ id: "tower-2", pane: "wA:p7" }, "/s/tower.jsonl");
	const back = await pi({ id: "opened-2", pane: OPENED.pane }, OPENED.file);
	await world.quiet();
	assert.deepEqual(dutyEntries(back), [], "no entry came back");
	await until(() => tokens(OPENED.pane).sb_role === "main", "the opened main is main again");
	await until(() => tokens(OPENED.pane).sb_duty === "standing", "and standing again, from its record");
	assert.match((await back.run())["straw-boss"] ?? "", /## Kind: standing/);
});
