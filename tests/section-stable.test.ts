import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { PROMPT_DIR, settle, World } from "./fakes.ts";

// A session's `straw-boss` system section holds nothing of another session: no name of a tower or a main, no state. Such a value rewrote the section whenever that session renamed, left, or came back, and a
// rewritten section reads the whole context uncached (measured 2026-11-13 to 11-16: 27 strict cache misses, 4.1M tokens, on coordinator mains whose tower line flipped between the tower's name and "none yet").
// The live values come from `boss_status`.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

const section = async (agent: { run(): Promise<Record<string, string>>; fire(type: string, event?: Record<string, unknown>): Promise<void> }) => {
	const text = (await agent.run())["straw-boss"] ?? "";
	await agent.fire("agent_settled", { aborted: false });
	return text;
};
/** A session's facts are read again when a session leaves the broker (membership.ts `sync`): one that comes and goes in another workspace makes every session read them now. */
let nudges = 0;
const nudge = async () => {
	const passer = world.agent({ id: `passer-${++nudges}`, pane: `wB:n${nudges}`, tab: "wB:t1" });
	await passer.start();
	await passer.stop();
	await settle();
};
const main = async (id: string, pane: string, tab: string) => {
	const agent = world.agent({ id, pane, tab });
	await agent.start();
	await agent.promote();
	return agent;
};

test("a main's section is the same bytes with no tower, with its workspace's tower live, and after that tower left", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const none = await section(a);
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await nudge();
	assert.equal(((await a.tool("boss_status")).details as { tower: { id: string } }).tower.id, "tower-wA", "the session knows the tower: boss_status names it");
	const live = await section(a);
	await tower.stop();
	await nudge();
	const gone = await section(a);
	assert.match(none, /^You are the main agent of Herdr tab work, of kind coordinator:/);
	assert.equal(live, none, "a tower that opened");
	assert.equal(gone, none, "a tower that left");
	assert.doesNotMatch(none, /tower-wA|none yet/);
});

test("a main's section is the same bytes while another main works, goes idle, renames itself, and leaves", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const b = await main("b", "wA:p2", "wA:t2");
	const before = await section(a);
	world.herdr.pane("wA:p2").agent_status = "working";
	b.status = "working";
	await nudge();
	assert.equal(await section(a), before, "another main working");
	world.herdr.pane("wA:p2").agent_status = "idle";
	b.status = "idle";
	await nudge();
	assert.equal(await section(a), before, "another main idle");
	await b.tool("boss_rename", { name: "ledger rounding" });
	await nudge();
	assert.equal(await section(a), before, "another main renamed");
	await b.stop();
	await nudge();
	assert.equal(await section(a), before, "another main gone");
});

test("a member's section names neither its tab's main nor the tower: it is the same bytes when the main renames its session or the tower comes and goes", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await b.start();
	const before = await section(b);
	assert.match(before, /^Straw Boss: you are a member of tab work of workspace Alpha, and the tab has a main agent \(`boss_status` names it\)\./);
	const status = (await b.tool("boss_status")).details as { tabs: { main: string }[] };
	assert.equal(status.tabs[0]!.main, "a", "the live name is boss_status's");
	a.name = "ledger rounding"; // a `/name`: the session's name moves and its tab's label stays
	await nudge();
	assert.equal(await section(b), before, "the main renamed");
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await nudge();
	assert.equal(await section(b), before, "a tower opened");
	await tower.stop();
	await nudge();
	assert.equal(await section(b), before, "the tower left");
});

test("the role prompts a session renders name only this session's own facts: no placeholder for another session's name or state", () => {
	const allowed = new Set(["tab", "duty", "workspace", "head", "dir", "state", "cli"]);
	for (const file of readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".md"))) {
		for (const [, key] of readFileSync(`${PROMPT_DIR}/${file}`, "utf8").matchAll(/\{\{(\w+)\}\}/g)) assert.ok(allowed.has(key!), `${file} uses {{${key}}}`);
	}
});
