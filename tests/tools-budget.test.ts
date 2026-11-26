import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { World } from "./fakes.ts";

// B2 (docs/specs/2026-11-23-lite-b2-d-e-f.md §1.5, boss decision b2_scope=trim): the main's tools keep their names, their descriptions are trimmed, and boss_status is folded into board_read. Tool size is what the provider receives
// on every turn: description plus the JSON of the parameters. Measured 2026-11-23 on a promoted main with no Straw Link and no train: 11 tools, 11,594 characters before; 8,753 after (boss_watch, 1,140, is new).
// D, review threads (0.84.0, §2.3; measured): 12 tools and 9,601 characters: boss_pair (698) is new, and board_read 680 to 830 for its `thread` and section `threads`.
// Idle wrap-up (docs/specs/2026-11-25-idle-wrap-up.md, part 1; measured): 13 tools and 10,131 characters: boss_wrap (530) is new, kept out of the trimmed set as the other new ones are.
// Boss questions asked by the main (same spec, part 2; measured): 10,131 to 10,161: call_tower's `blocked` names the boss's own decision (ask_user_question, or call_tower under auto mode).
// The boss question drawn by code (0.91.0, same spec part 2 as rewritten; measured): 10,161 to 10,328: call_tower's `blocked` is 0.89.0's again plus one clause naming `boss`, and `boss` itself ({question, options}, no descriptions:
// its limits are checked in bossask.ts); the trimmed set is 7,000 exactly.
// Just-in-time prompts (0.92.0, docs/specs/2026-11-26-just-in-time-prompts.md; boss 2026-11-25 「提示詞可以逐步交付」; measured): trimmed 7,000 to 7,336 and all 10,328 to 10,664 (+336), against main.md's -1,646 characters:
// call_tower takes main.md's shared and blocked details (what counts as outside your tab, what and how long, go ahead at once and stop only on a named clash, the owner the tower finds, waitsOn), board_set
// "the done report still goes to whoever asked", boss_duty "watching, not finishing tasks" for standing.
// A standing main of its own (docs/specs/2026-11-26-standing-prompt.md, item 6; measured): trimmed 7,336 to 7,443 and all 10,664 to 10,771 (+107): call_tower's `standing` tells the sender, when it sends, that a notice about another
// main's work goes in that wait's thread (linkWait) or as waitsOn with its owner (field: about 20 a day reached a standing main naming no owner).
// A note in a wait's thread (same spec, item 8; measured): trimmed 7,443 to 7,473 and all 10,771 to 10,801 (+30): `linkWait` state `note` (its literal and a clause), `message` naming note, and `standing` saying a notice on a wait
// you hold goes as linkWait note (the waitsOn clause dropped: it opened a fresh wait).

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
	await a.run();
	// What the provider receives is the active set: call_peer (tests/call-peer.test.ts) is registered for every joined session and active for a member only, so a main's figure holds 0 bytes of it.
	const active = (t: { name: string; defaultActive?: boolean }) => (a.active ? a.active.includes(t.name) : t.defaultActive !== false);
	const tools = [...a.tools.values()].filter((t) => t.name !== "ask_user_question" && active(t as { name: string; defaultActive?: boolean }));
	assert.ok(!a.active?.includes("call_peer"), "a main does not carry call_peer");
	assert.ok(!a.tools.has("boss_status"), "folded into board_read");
	const trimmed = tools.filter((t) => t.name !== "boss_server" && t.name !== "boss_watch" && t.name !== "boss_pair" && t.name !== "boss_wrap").reduce((n, t) => n + size(t), 0);
	assert.ok(trimmed <= 7_473, `the trimmed tools hold ${trimmed} characters (10,634 before B2)`);
	const all = tools.reduce((n, t) => n + size(t), 0);
	assert.ok(all <= 10_801, `all of sb's tools hold ${all} characters (11,594 before B2 and E; 8,753 before D; 9,601 before boss_wrap; 10,161 before call_tower boss; 10,328 before 0.92.0; 10,664 before standing.md; 10,771 before note)`);
});

test("the trimmed descriptions keep the sentences that carry a rule: board_set's privacy line, call_tower's three points, boss_wait_ask over ask_user_question", async () => {
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.promote();
	assert.match(a.tools.get("board_set")!.description, /no secrets, credentials, customer data, or paths outside the project/);
	assert.match(a.tools.get("call_tower")!.description, /at three points only: why milestone .*shared .*blocked/);
	assert.match(a.tools.get("boss_wait_ask")!.description, /never ask_user_question/);
	assert.match(a.tools.get("board_read")!.description, /never the boss's instruction/);
	// The sender's half of the standing main's relay rule (docs/specs/2026-11-26-standing-prompt.md, items 6 and 8), said where a notice to a device's standing main is sent.
	assert.ok(JSON.stringify(a.tools.get("call_tower")!.parameters).includes("A notice on a wait you hold from that device: linkWait note."));
	const tower = world.tower("tower-wA", "wA:t9", "wA:p9");
	await tower.start();
	assert.ok(JSON.stringify(tower.tools.get("tower_send")!.parameters).includes("A notice about another main's work: reply in that ask's thread (inReplyTo), or name its owner"));
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
