import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { World } from "./fakes.ts";

// B2 (docs/specs/2026-11-23-lite-b2-d-e-f.md §1.5, boss decision b2_scope=trim): the main's tools keep their names, their descriptions are trimmed, and boss_status is folded into board_read. Tool size is what the provider receives
// on every turn: description plus the JSON of the parameters. Measured 2026-11-23 on a promoted main with no Straw Link and no train: 11 tools, 11,594 characters before; 8,753 after (boss_watch, 1,140, is new).
// D, review threads (0.84.0, §2.3; measured): 12 tools and 9,601 characters: boss_pair (698) is new, and board_read 680 to 830 for its `thread` and section `threads`.
// Idle wrap-up (docs/specs/2026-11-25-idle-wrap-up.md, part 1; measured): 13 tools and 10,131 characters: boss_wrap (530) is new, kept out of the trimmed set as the other new ones are.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const size = (t: { description?: string; parameters?: unknown }) => (t.description ?? "").length + JSON.stringify(t.parameters ?? {}).length;

test("a main's always-on sb tools stay within their budget, and boss_status is gone", async () => {
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1", deps: { server: {} as never } });
	await a.start();
	await a.promote();
	const tools = [...a.tools.values()].filter((t) => t.name !== "ask_user_question");
	assert.ok(!a.tools.has("boss_status"), "folded into board_read");
	const trimmed = tools.filter((t) => t.name !== "boss_server" && t.name !== "boss_watch" && t.name !== "boss_pair" && t.name !== "boss_wrap").reduce((n, t) => n + size(t), 0);
	assert.ok(trimmed <= 7_000, `the trimmed tools hold ${trimmed} characters (10,634 before B2)`);
	const all = tools.reduce((n, t) => n + size(t), 0);
	assert.ok(all <= 10_131, `all of sb's tools hold ${all} characters (11,594 before B2 and E; 8,753 before D; 9,601 before boss_wrap)`);
});

test("the trimmed descriptions keep the sentences that carry a rule: board_set's privacy line, call_tower's three points, boss_wait_ask over ask_user_question", async () => {
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.promote();
	assert.match(a.tools.get("board_set")!.description, /no secrets, credentials, customer data, or paths outside the project/);
	assert.match(a.tools.get("call_tower")!.description, /at three points only: why milestone .*shared .*blocked/);
	assert.match(a.tools.get("boss_wait_ask")!.description, /never ask_user_question/);
	assert.match(a.tools.get("board_read")!.description, /never the boss's instruction/);
});

test("board_read carries the towers section boss_status gave, and a member gets that section alone", async () => {
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1" }), m = world.agent({ id: "mem-1", pane: "wA:p2", tab: "wA:t1" });
	await a.start();
	await m.start();
	await a.promote();
	const main = (await a.tool("board_read")).details as { towers: { me: { id: string }; tabs: { main: string | null }[] }; local?: unknown };
	assert.equal(main.towers.me.id, "main-1");
	assert.ok(main.local !== undefined, "the board itself");
	const member = (await m.tool("board_read")).details as { towers: { tabs: { main: string | null }[] }; local?: unknown };
	assert.deepEqual(Object.keys(member), ["towers"]);
	assert.equal(member.towers.tabs.find((t) => t.main)?.main, "main-1", "the member finds its main");
});
