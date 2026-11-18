import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Item } from "../src/items.ts";
import { El, page } from "./fake-dom.ts";

// A message the reader selected stays selected (todo: phone copy). On a phone a long press selects a word and the handles move the selection; the browser sends no
// touch event for them, so the log cannot tell it from a finger at rest. What would end the selection is the page's own: an entry arriving while the log follows
// its end (the jump to the bottom), the frame's resize that parks a followed log, and a tool result that redraws the message the selection is in.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") }); // the markdown renderer's two calls, which the fake document lacks
const { mountChat } = await import("../gui/chat.ts");
const { m } = await import("../gui/paraglide/messages.js");

const VIEW = 300, ROW = 100;
const user = (n: number): Item => ({ id: `u${n}`, kind: "user", text: `message ${n}`, at: "2026-11-07T08:00:00.000Z" });

let selected: { node: El; text: string } | undefined;
const select = (node: El | undefined, text = "some words") => ((selected = node && { node, text }), page.on.selectionchange?.forEach((on) => on({ target: page })));
Object.assign(globalThis, {
	getSelection: () => ({ get isCollapsed() { return !selected; }, get rangeCount() { return selected ? 1 : 0; }, get anchorNode() { return selected?.node ?? null; }, get focusNode() { return selected?.node ?? null; }, toString: () => selected?.text ?? "" }),
});
afterEach(() => void (selected = undefined));
Object.assign(page, { removeEventListener: (type: string, on: (e: { target: unknown }) => void) => void (page.on[type] = (page.on[type] ?? []).filter((x) => x !== on)) }); // the fake document has none; a chat that left the page drops its listener

function rig(opts: { entries?: Item[] } = {}) {
	let clock = 0, nextTimer = 1;
	const timers = new Map<number, { at: number; fn: () => void }>(), resizes: (() => void)[] = [];
	const globals = globalThis as unknown as Record<string, unknown>, saved = { setTimeout: globals.setTimeout, clearTimeout: globals.clearTimeout, IntersectionObserver: globals.IntersectionObserver, ResizeObserver: globals.ResizeObserver };
	Object.assign(globals, {
		setTimeout: (fn: () => void, ms = 0) => (timers.set(nextTimer, { at: clock + ms, fn }), nextTimer++),
		clearTimeout: (id: number) => void timers.delete(id),
		IntersectionObserver: class { observe() {} disconnect() {} },
		ResizeObserver: class { constructor(f: () => void) { resizes.push(f); } observe() {} },
	});
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	page.body.append(root);
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "a1", name: "main", role: "main", mark: "idle" as const }), link: () => undefined });
	const log = chat.log as unknown as El, list = log.find((el) => el.className === "chat-list")[0]!;
	let top = 0, content = 1000;
	const writes: number[] = [], end = () => Math.max(0, content - VIEW);
	Object.defineProperty(log, "scrollHeight", { get: () => content });
	Object.defineProperty(log, "clientHeight", { get: () => VIEW });
	Object.defineProperty(log, "scrollTop", { get: () => top, set: (v: number) => void writes.push((top = Math.min(Math.max(v, 0), end()))) });
	let rows = 0;
	const r = {
		chat, log, list, writes,
		get top() { return top; },
		frame: () => resizes.forEach((f) => f()),
		arrive(by = ROW) { content += by; chat.apply({ key: "a1", items: [user(++rows + 100)] }); r.frame(); },
		tick(ms: number) {
			const to = clock + ms;
			for (let next = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]; next; next = [...timers].filter(([, t]) => t.at <= to).sort((a, b) => a[1].at - b[1].at)[0]) (timers.delete(next[0]), (clock = next[1].at), next[1].fn());
			clock = to;
		},
		done: () => (root.remove(), void Object.assign(globals, saved)),
	};
	chat.apply({ key: "a1", reset: true, items: opts.entries ?? [user(1), user(2), user(3)] });
	r.frame();
	assert.equal(top, 700, "it opens at the end");
	writes.length = 0;
	return r;
}

test("an entry arriving while text is selected does not move the log, and the log lands at the end once the selection is gone", () => {
	const r = rig();
	try {
		const bubble = r.list.find((el) => el.className === "bubble")[0]!;
		select(bubble);
		r.arrive();
		r.arrive();
		assert.deepEqual([r.writes, r.top], [[], 700], "nothing scrolled the log under the selection");
		select(undefined);
		assert.deepEqual([r.top, r.writes.length > 0], [900, true], "the selection ended: the followed log lands at its end in one jump");
	} finally {
		r.done();
	}
});

test("entries arriving while the selection holds the log count as unseen: the pill says N new, and clears once the log lands at the end", () => {
	const r = rig();
	try {
		const pill = (r.chat as unknown as { log: El }).log.parent!.find((el) => el.className === "chat-pill")[0]!;
		select(r.list.find((el) => el.className === "bubble")[0]!);
		r.arrive();
		r.arrive();
		assert.deepEqual([pill.hidden, pill.textContent], [false, m.new_entries({ count: 2 })]);
		select(undefined);
		assert.equal(pill.hidden, true, "back at the end: no pill");
	} finally {
		r.done();
	}
});

test("a frame's resize while text is selected does not park the followed log", () => {
	const r = rig();
	try {
		select(r.list.find((el) => el.className === "bubble")[0]!);
		r.arrive(40);
		r.frame();
		r.tick(1000);
		assert.deepEqual(r.writes, [], "no write of the offset, not even after the timers");
	} finally {
		r.done();
	}
});

test("a selection outside the log does not hold it", () => {
	const r = rig();
	try {
		select(new El("p"));
		r.arrive();
		assert.equal(r.top, 800, "the log follows its end as ever");
	} finally {
		r.done();
	}
});

test("a tool result arriving for the message that holds the selection does not replace the message; it is drawn when the selection ends", () => {
	const call: Item = { id: "a1", kind: "assistant", text: "Here is a long answer to select from.", at: "2026-11-07T08:00:00.000Z", tools: [{ id: "t1", name: "bash", summary: "ls" }] };
	const r = rig({ entries: [user(1), call] });
	try {
		const article = r.list.children.find((el) => el.className.includes("tx in"))!, words = article.find((el) => el.className === "md")[0] ?? article;
		select(words);
		r.chat.apply({ key: "a1", items: [{ id: "r1", kind: "result", callId: "t1", text: "file-one\nfile-two" }] });
		assert.ok(article.isConnected, "the message the selection is in stays in the log");
		assert.equal(article.dump().includes("file-one"), false, "its result waits");
		select(undefined);
		const now = r.list.children.find((el) => el.className.includes("tx in"))!;
		assert.ok(now.dump().includes("file-one"), "the result is drawn once the reader let go");
		assert.equal(r.list.children.filter((el) => el.className.includes("tx in")).length, 1);
	} finally {
		r.done();
	}
});

test("a tool result for a message without a selection redraws it at once", () => {
	const call: Item = { id: "a1", kind: "assistant", text: "Working.", at: "2026-11-07T08:00:00.000Z", tools: [{ id: "t1", name: "bash", summary: "ls" }] };
	const r = rig({ entries: [call] });
	try {
		select(new El("p"));
		r.chat.apply({ key: "a1", items: [{ id: "r1", kind: "result", callId: "t1", text: "file-one" }] });
		assert.ok(r.list.children.find((el) => el.className.includes("tx in"))!.dump().includes("file-one"));
	} finally {
		r.done();
	}
});

test("each message has a Copy control that holds the message's own text: the boss's, an agent's, and an incoming notice", () => {
	const r = rig({ entries: [user(1), { id: "a1", kind: "assistant", text: "**agent** words", at: "2026-11-07T08:00:00.000Z" }, { id: "n1", kind: "notice", type: "intercom_message", from: "scout", text: "notice words", at: "2026-11-07T08:00:00.000Z" }, { id: "d1", kind: "divider", type: "compaction", text: "gone" }] });
	try {
		const copies = r.list.find((el) => el.className === "tx-copy");
		assert.equal(copies.length, 3, "the divider has none");
		for (const b of copies) assert.equal(b.getAttribute("aria-label"), m.chat_copy_message());
		const wrote: string[] = [];
		Object.defineProperty(globalThis, "navigator", { value: { clipboard: { writeText: async (s: string) => void wrote.push(s) } }, configurable: true, writable: true });
		copies.forEach((b) => b.click());
		assert.deepEqual(wrote, ["message 1", "**agent** words", "notice words"]);
	} finally {
		Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true, writable: true });
		r.done();
	}
});
