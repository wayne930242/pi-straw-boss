import assert from "node:assert/strict";
import { test } from "node:test";
import { CAP, createChat, type Page } from "../gui/chat.ts";
import { createFollow, reach } from "../gui/follow.ts";
import type { Item } from "../src/items.ts";

const msg = (id: string): Item => ({ id, kind: "user", text: id });
const reply = (id: string, ...calls: string[]): Item => ({ id, kind: "assistant", text: id, tools: calls.map((c) => ({ id: c, name: "bash", summary: "ls" })) });
const res = (id: string, callId: string): Item => ({ id, kind: "result", callId, text: "out" });
const ids = (chat: ReturnType<typeof createChat>) => chat.items.map((i) => i.id);

test("a reset replaces everything, and a repeated entry id is ignored", () => {
	const chat = createChat();
	chat.reset({ items: [msg("a"), msg("b")], before: "a" });
	assert.deepEqual([ids(chat), chat.before], [["a", "b"], "a"]);
	const d = chat.append([msg("b"), msg("c")]);
	assert.deepEqual([d.added.map((i) => i.id), ids(chat)], [["c"], ["a", "b", "c"]], "the page and the live stream may both carry an entry");
	chat.reset({ items: [msg("z")] });
	assert.deepEqual([ids(chat), chat.before, chat.detached], [["z"], undefined, false]);
});

test("a tool result attaches to its call by call id, whichever arrives first, and is not an item of its own", () => {
	const chat = createChat();
	chat.reset({ items: [reply("a1", "c1", "c2"), res("r1", "c1")] });
	assert.deepEqual([ids(chat), chat.result("c1")?.id, chat.result("c2")], [["a1"], "r1", undefined]);
	const live = chat.append([res("r2", "c2")]);
	assert.deepEqual([live.added, live.touched, chat.result("c2")?.id], [[], ["a1"], "r2"], "the call that got its result is redrawn");
	const early = createChat();
	early.reset({ items: [res("r9", "c9")] });
	assert.equal(early.result("c9")?.id, "r9", "a result whose call is in an older page waits for it");
	const older = early.prepend({ items: [reply("a9", "c9")] });
	assert.deepEqual([older.added.map((i) => i.id), older.touched, early.result("c9")?.id], [["a9"], [], "r9"]);
});

test("an older page goes to the front and moves the cursor", () => {
	const chat = createChat();
	chat.reset({ items: [msg("c"), msg("d")], before: "c" });
	const d = chat.prepend({ items: [msg("a"), msg("b")], before: undefined });
	assert.deepEqual([d.front, ids(chat), chat.before], [true, ["a", "b", "c", "d"], undefined]);
});

test("past 600 items the oldest drop while following the end, and the newest drop while reading older pages", () => {
	const chat = createChat();
	chat.reset({ items: Array.from({ length: CAP }, (_, i) => msg(`m${i}`)), before: "m0" });
	const d = chat.append([msg("n1"), msg("n2")]);
	assert.deepEqual([chat.items.length, d.dropped, chat.before, ids(chat)[0]], [CAP, ["m0", "m1"], "m2", "m2"], "the cursor follows so scrolling up fetches what was dropped");
	// Dropped ids can come back: fetch the page that precedes the cursor.
	const back = chat.prepend({ items: [msg("m0"), msg("m1")], before: undefined });
	assert.deepEqual([back.dropped, chat.detached, chat.items.length], [["n1", "n2"], true, CAP], "the newest end made room, so the chat no longer follows the live end");
	assert.deepEqual(chat.append([msg("n3")]).added, [], "while detached nothing is appended");
	chat.reset({ items: [msg("fresh")] });
	assert.deepEqual([chat.detached, chat.append([msg("n3")]).added.length], [false, 1], "latest reloads and follows again");
});

test("results and calls of dropped items are forgotten with them", () => {
	const chat = createChat(3);
	chat.reset({ items: [reply("a1", "c1"), res("r1", "c1"), msg("b"), msg("c")] });
	chat.append([msg("d")]);
	assert.deepEqual([ids(chat), chat.result("c1")], [["b", "c", "d"], undefined]);
});

test("the log starts pinned to the newest entry and follows new ones; scrolled up it offers the way back, and jumping pins it again", () => {
	const f = createFollow();
	assert.deepEqual([f.pinned, f.arrived(2), f.button(false)], [true, true, undefined], "opening a session any other way starts at the bottom and stays there");
	f.scrolled(false);
	assert.deepEqual([f.pinned, f.button(false)], [false, "jump to latest"], "not at the bottom: the floating button shows");
	assert.equal(f.arrived(3), false, "new entries do not pull a reader down");
	assert.equal(f.button(false), "3 new");
	f.jump();
	assert.deepEqual([f.pinned, f.button(false), f.arrived(1)], [true, undefined, true], "after the jump new entries keep it at the bottom");
	f.scrolled(false);
	f.arrived(1);
	f.scrolled(true);
	assert.deepEqual([f.pinned, f.button(false)], [true, undefined], "scrolling back to the bottom pins it too");
	f.hold();
	assert.deepEqual([f.pinned, f.button(false)], [false, "jump to latest"], "opening at an anchor reads from there");
	assert.equal(createFollow().button(true), "jump to latest", "a detached log always offers the latest");
});

test("an anchor in an older page is reached by loading older pages, and one that is gone is reported", async () => {
	const history = Array.from({ length: 500 }, (_, i) => msg(`e${i}`));
	const pageOf = (before?: string): Page => {
		const end = before ? history.findIndex((i) => i.id === before) : history.length, start = Math.max(0, end - 150);
		return { items: history.slice(start, end), before: start > 0 ? history[start]!.id : undefined };
	};
	const chat = createChat(), fetched: string[] = [], none: string[] = [];
	chat.reset(pageOf());
	const painted: number[] = [];
	assert.equal(await reach(chat, async (b) => (fetched.push(b), pageOf(b)), "e420", (d) => painted.push(d.added.length)), true);
	assert.deepEqual(fetched, none, "an anchor in the first page needs no fetch");
	assert.equal(await reach(chat, async (b) => (fetched.push(b), pageOf(b)), "e120", (d) => painted.push(d.added.length)), true);
	assert.deepEqual([fetched, painted, chat.items[0]!.id], [["e350", "e200"], [150, 150], "e50"], "two older pages, each painted");
	assert.equal(await reach(chat, async (b) => pageOf(b), "gone", () => {}), false, "an entry no longer in the history: the log opens at the end");
	assert.equal(chat.before, undefined);
});
