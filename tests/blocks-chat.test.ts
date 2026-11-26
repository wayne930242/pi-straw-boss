import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { Item } from "../src/items.ts";
import { El, page, stored } from "./fake-dom.ts";
import "./pbs-loader.ts";

// An agent's message in the comms log draws its blocks with pi-better-show's elements, whichever base shows the log (Standard, Geek, Zen, a phone, an operate base: they all mount gui/chat.ts). A submitted block is the
// boss's message to that unit through the composer's input route and its guards; the element locks once the unit took it, and the server's record (read when the log is drawn) keeps it locked after a reload and on every device.

Object.assign(page, { createTextNode: (text: string) => String(text), createDocumentFragment: () => new El("#fragment") });
const { INTERACTIVE_KINDS } = await import("pi-better-show");
const { mountChat } = await import("../gui/chat.ts");
const { whenDrawn, drawing } = await import("../gui/mdbody.ts");
const { answeredHooks, forgetAnswered } = await import("../gui/answered.ts");
const { forgetLocks } = await import("../gui/blocklock.ts");
const { DEMO_CHAT_BLOCKS } = await import("../gui/demo-blocks.ts");
let record: { done: [string, number, [string, string][]][]; pending: [string, number][]; unreadable?: boolean } = { done: [], pending: [] };
let reading: (() => Promise<unknown>) | undefined;
beforeEach(() => {
	stored.clear();
	forgetLocks();
	forgetAnswered();
	record = { done: [], pending: [] };
	reading = undefined;
	answeredHooks.get = async () => (reading ? reading() : record) as never;
});
type Posted = { ok: boolean; status: number; body: Record<string, unknown> };
type Sent = [string, Record<string, unknown>];

const mount = (key: string, answer: (body: Record<string, unknown>) => Posted = () => ({ ok: true, status: 200, body: { accepted: true } })) => {
	const root = new El("div"), sent: Sent[] = [];
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async (action: string, body: Record<string, unknown>) => (sent.push([action, body]), answer(body)) };
	const chat = mountChat(root as unknown as HTMLElement, data as never, { who: () => ({ key, name: "billing-main", role: "main", mark: "idle" as const }), link: () => undefined });
	const show = async (...items: Item[]) => (chat.apply({ key, reset: true, items }), await whenDrawn(), root);
	return { root, sent, show };
};
const reply = (text: string, id = "a1"): Item => ({ id, kind: "assistant", text, model: "m" });
const fire = (el: El, answer: unknown) => {
	let refused = false;
	for (const on of el.handlers["pbs-answer"] ?? []) on({ type: "pbs-answer", detail: answer, preventDefault: () => (refused = true) });
	return refused;
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); await whenDrawn(); };
type Locked = El & { answered?: unknown; data?: unknown };
const find = (root: El, tag: string) => root.find((el) => el.tagName === tag) as Locked[];

test("an agent's message with blocks draws a form, chips, a table, and a tree with their elements, compact, in the message's own body", async () => {
	const { show } = mount("S1");
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const body = root.find((el) => el.className === "md")[0]!;
	assert.deepEqual(body.find((el) => el.tagName.startsWith("pbs-")).map((el) => el.tagName), ["pbs-form", "pbs-suggest", "pbs-table", "pbs-tree"]);
	for (const el of body.find((el) => el.tagName.startsWith("pbs-"))) assert.equal(el.getAttribute("density"), "compact");
	assert.match(body.textContent, /I can ship the ledger fix today/, "the prose is still the page's own Markdown");
});

test("a message whose only block is a tree loads the block code and draws pbs-tree: the hint knows the kind", async () => {
	const { show } = mount("S1");
	const root = await show(reply("What the change touches:\n\n```tree\nledger/\n  src/ {focus}\n    fix.ts {changed} # the fix\n  tests/\n```\n\nShall I go on?"));
	const [tree] = find(root, "pbs-tree");
	assert.ok(tree, "drawn");
	assert.equal(tree!.getAttribute("density"), "compact");
	assert.equal((tree!.data as { root: { name: string } }).root.name, "ledger");
	assert.match(root.find((el) => el.className === "md")[0]!.textContent, /Shall I go on\?/, "the prose around it is the page's own Markdown");
});

test("a message with no block never loads the block code", async () => {
	const { show } = mount("S1");
	const root = await show(reply("Just **words**.\n\n```js\nlet a = 1\n```"), { id: "u1", kind: "user", text: "```form\nquestions: []\n```" });
	assert.equal(drawing(), 0, "nothing was imported for it");
	assert.equal(root.find((el) => el.tagName.startsWith("pbs-")).length, 0);
});

test("a block's answer is the boss's message to that unit: the composer's input route, sent as a message, held to the remote guards; the element locks once the unit took it", async () => {
	const { show, sent } = mount("S1");
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const [chips] = find(root, "pbs-suggest");
	assert.equal(fire(chips!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } }), true);
	await settle();
	assert.deepEqual(sent, [["input", { text: "Go ahead", as: "send", guarded: true, block: { entry: "a1", index: 1, fields: [["text", "Go ahead"]] } }]], "the block names itself, so the server records that it was answered");
	assert.deepEqual(chips!.answered, [["text", "Go ahead"]]);
	const [form] = find(root, "pbs-form");
	fire(form!, { kind: "form", title: "Ship the ledger fix", fields: [["when", "now"], ["note", "watch refunds"]], ref: { block: 0 } });
	await settle();
	assert.equal(sent.length, 1, "BSR-F001: the form's names are not its labels (when/When?, now/Today): the exact text is shown first and nothing goes until Send");
	const step = root.find((el) => el.getAttribute("class") === "pbs-confirm");
	assert.equal(step.length, 1);
	assert.equal(step[0]!.find((el) => el.tagName === "pre")[0]!.textContent, "User submitted a form in the HTML review pane:\n- when: now\n- note: watch refunds");
	for (const on of step[0]!.find((el) => el.getAttribute("class") === "pbs-confirm-send")[0]!.handlers.click ?? []) on({ type: "click" });
	await settle();
	assert.equal(sent[1]![1].text, "User submitted a form in the HTML review pane:\n- when: now\n- note: watch refunds", "the text the agent reads is encodeAnswer's");
	assert.deepEqual(form!.answered, [["when", "now"], ["note", "watch refunds"]]);
});

test("a multi review previews a Markdown item's outgoing name, then sends and locks both picks", async () => {
	const { show, sent } = mount("S1");
	const root = await show(reply('```review\npickMode: multi\nitems: [{name: A}, {name: B, label: "[docs](https://example.org/runbook)"}]\n```'));
	const [review] = find(root, "pbs-review");
	const fields = [["picked", "A"], ["picked", "B ([docs](https://example.org/runbook))"]];
	fire(review!, { kind: "review", fields });
	await settle();
	assert.equal(sent.length, 0, "the heading shows docs but the reply also contains its URL");
	const text = 'User reviewed "":\nPicked: A\nPicked: B ([docs](https://example.org/runbook))';
	assert.equal(root.find((el) => el.className === "pbs-confirm-text")[0]?.textContent, text);
	for (const on of root.find((el) => el.className === "pbs-confirm-send")[0]!.handlers.click ?? []) on({ type: "click" });
	await settle();
	assert.deepEqual(sent, [["input", { text, as: "send", guarded: true, block: { entry: "a1", index: 0, fields } }]]);
	assert.deepEqual(review!.answered, fields);
});

test("the lock survives a reload and shows on every device: the server's record is read when the log is drawn, per session, entry, and block", async () => {
	const first = mount("S1");
	const root = await first.show(reply(DEMO_CHAT_BLOCKS));
	fire(find(root, "pbs-suggest")[0]!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	await settle();
	assert.equal(stored.size, 0, "the page keeps nothing of its own");
	forgetLocks(); // a reload: the page's memory is gone
	forgetAnswered();
	record = { done: [["a1", 1, [["text", "Go ahead"]]]], pending: [] };
	const again = await mount("S1").show(reply(DEMO_CHAT_BLOCKS));
	assert.deepEqual(find(again, "pbs-suggest")[0]!.answered, [["text", "Go ahead"]], "locked after a reload");
	assert.equal(find(again, "pbs-form")[0]!.answered, undefined, "only the block that was answered");
	forgetLocks();
	forgetAnswered();
	const elsewhere = await mount("S2").show(reply(DEMO_CHAT_BLOCKS, "a9"));
	assert.equal(find(elsewhere, "pbs-suggest")[0]!.answered, undefined, "another session or entry: the record names none");
});

test("the record asked for is the session's: one request, shared by every message drawn at once, and the key is the session's", async () => {
	const asked: string[] = [];
	answeredHooks.get = async (key) => (asked.push(key), record) as never;
	const { show } = mount("S 1/x");
	await show(reply(DEMO_CHAT_BLOCKS, "a1"), reply(DEMO_CHAT_BLOCKS, "a2"), reply(DEMO_CHAT_BLOCKS, "a3"));
	assert.deepEqual(asked, ["S 1/x"]);
});

test("a block the record says is on its way comes up locked and pending, one it could not read comes up open with a note, and answering still works", async () => {
	record = { done: [], pending: [["a1", 1]] };
	const pending = await mount("S1").show(reply(DEMO_CHAT_BLOCKS));
	assert.equal(pending.find((el) => el.getAttribute("class") === "pbs-block" && el.hasAttribute("inert")).length, 1);
	forgetLocks();
	forgetAnswered();
	reading = async () => { throw new Error("offline"); };
	const { show, sent } = mount("S1");
	const unsure = await show(reply(DEMO_CHAT_BLOCKS));
	unsureNotes(unsure);
	fire(find(unsure, "pbs-suggest")[0]!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	await settle();
	assert.equal(sent.length, 1);
	assert.deepEqual(find(unsure, "pbs-suggest")[0]!.answered, [["text", "Go ahead"]]);
});

test("a display block gets no 'could not be read' note: nothing in it can have been answered (PT-F002)", async () => {
	record = { done: [], pending: [], unreadable: true };
	const root = await mount("S1").show(reply("A snapshot:\n\n```tree\nroot/\n  a.ts {new}\n```\n"));
	assert.equal(find(root, "pbs-tree").length, 1, "the tree is drawn");
	assert.ok(root.find((el) => el.getAttribute("class") === "pbs-note").every((el) => !/could not be read/i.test(el.textContent)), "no note under the tree");
});

test("a record the server marks unreadable comes up open with the note, even though the request itself went through", async () => {
	record = { done: [], pending: [], unreadable: true };
	const root = await mount("S1").show(reply(DEMO_CHAT_BLOCKS));
	unsureNotes(root);
});

test("a message redrawn while its answer is on its way (a tool result, a reconnect) comes up locked, and locks with the fields when the unit has taken the message", async () => {
	let release!: (r: Posted) => void, started = false;
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async () => ((started = true), await new Promise<Posted>((r) => (release = r))) };
	const holder = new El("div");
	const chat = mountChat(holder as unknown as HTMLElement, data as never, { who: () => ({ key: "S1", name: "billing-main", role: "main", mark: "idle" as const }), link: () => undefined });
	chat.apply({ key: "S1", reset: true, items: [reply(DEMO_CHAT_BLOCKS)] });
	await whenDrawn();
	fire(find(holder, "pbs-suggest")[0]!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	await settle();
	assert.equal(started, true);
	chat.apply({ key: "S1", reset: true, items: [reply(DEMO_CHAT_BLOCKS)] }); // the redraw
	await whenDrawn();
	assert.equal(holder.find((el) => el.getAttribute("class") === "pbs-block" && el.hasAttribute("inert")).length, 1, "the new drawing of the block in flight is locked");
	release({ ok: true, status: 200, body: {} });
	await settle();
	assert.deepEqual(find(holder, "pbs-suggest")[0]!.answered, [["text", "Go ahead"]]);
	assert.equal(holder.find((el) => el.hasAttribute("inert")).length, 0);
});

test("a unit that refuses the message leaves the block open with the server's reason under it, and nothing is kept", async () => {
	const { show, sent } = mount("S1", () => ({ ok: false, status: 403, body: { error: "local_only", reason: "A /boss send is held to the guards of a remote write." } }));
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const [chips] = find(root, "pbs-suggest");
	fire(chips!, { kind: "suggest", fields: [["text", "Go ahead"]] });
	await settle();
	assert.equal(sent.length, 1);
	assert.equal(chips!.answered, undefined);
	assert.match(root.find((el) => el.className === "pbs-note").map((el) => el.textContent).join(""), /remote write/);
	assert.equal(stored.size, 0, "nothing was kept");
});

test("a chip whose text is a command line is not sent: the page says so and posts nothing", async () => {
	const { show, sent } = mount("S1");
	const root = await show(reply("```suggest\n- {label: Looks fine, text: '/quit'}\n- {label: Cleanup, text: '!rm -rf ~'}\n```"));
	const [chips] = find(root, "pbs-suggest");
	fire(chips!, { kind: "suggest", fields: [["text", "/quit"]] });
	fire(chips!, { kind: "suggest", fields: [["text", "!rm -rf ~"]] });
	await settle();
	assert.deepEqual(sent, []);
	assert.equal(chips!.answered, undefined);
	assert.ok(root.find((el) => el.className === "pbs-note")[0]!.textContent.length > 0);
});

// A unit of a remote base whose box is unreachable or ended takes no answer: its blocks in the log are off with the reason, nothing is posted, and they follow the box back (todo #121 task 7 fix round 4, R-F001).
const { m } = await import("../gui/paraglide/messages.js");
const mountAway = (key: string, gate: { away: boolean }) => {
	const root = new El("div"), sent: Sent[] = [];
	const data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined, post: async (action: string, body: Record<string, unknown>) => (sent.push([action, body]), { ok: true, status: 200, body: { accepted: true } }) };
	const chat = mountChat(root as unknown as HTMLElement, data as never, { who: () => ({ key, name: "billing-main", role: "main", mark: "idle" as const }), link: () => undefined, away: () => gate.away });
	return { root, sent, chat, show: async (...items: Item[]) => (chat.apply({ key, reset: true, items }), await whenDrawn(), root) };
};
const notes = (root: El) => root.find((el) => el.className === "pbs-note").map((el) => el.textContent);

test("R-F001: a block in the log of a unit whose box is away cannot be submitted: off with box_answer_blocked, nothing posted, and the box coming back turns it on", async () => {
	const gate = { away: true }, { show, sent, chat } = mountAway("S1", gate);
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const [chips] = find(root, "pbs-suggest"), [form] = find(root, "pbs-form");
	assert.equal(chips!.hasAttribute("inert") && form!.hasAttribute("inert"), true, "drawn off");
	assert.deepEqual(notes(root), [m.box_answer_blocked(), m.box_answer_blocked(), "", ""], "with the reason under the form and the chips, and none under the table or the tree, which have nothing to submit");
	assert.equal(find(root, "pbs-table")[0]!.hasAttribute("inert"), false);
	assert.equal(find(root, "pbs-tree")[0]!.hasAttribute("inert"), false, "a tree stays readable (its folders open and close) while the box is away");
	fire(chips!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	fire(form!, { kind: "form", fields: [["when", "now"]], ref: { block: 0 } });
	await settle();
	assert.deepEqual(sent, [], "nothing is posted");
	assert.equal(chips!.answered, undefined);
	gate.away = false;
	chat.box();
	assert.equal(chips!.hasAttribute("inert") || form!.hasAttribute("inert"), false, "back: on");
	assert.deepEqual(notes(root).filter(Boolean), []);
	fire(chips!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	await settle();
	assert.equal(sent.length, 1);
	assert.deepEqual(chips!.answered, [["text", "Go ahead"]]);
});

test("RR-F001: the focus a block's control loses by the block going off with the box comes back when the box does, unless the boss went elsewhere meanwhile", async () => {
	const gate = { away: false }, { show, chat } = mountAway("S1", gate);
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const [form] = find(root, "pbs-form");
	const dropped = () => void (page.focused = undefined); // a browser moves the focus off what became inert, to the body
	form!.focus();
	gate.away = true;
	chat.box();
	dropped();
	gate.away = false;
	chat.box();
	assert.equal(page.focused, form, "the control has the focus back");
	form!.focus();
	gate.away = true;
	chat.box();
	dropped();
	for (const on of page.on.pointerdown ?? []) on({ target: page.body });
	gate.away = false;
	chat.box();
	assert.equal(page.focused, undefined, "the boss went elsewhere: the focus stays where he put it");
});

test("R-F001: a box going away turns the blocks already drawn off at the next box() call, and a block answered before stays answered", async () => {
	const gate = { away: false }, { show, chat } = mountAway("S1", gate);
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const [chips] = find(root, "pbs-suggest");
	fire(chips!, { kind: "suggest", fields: [["text", "Go ahead"]], ref: { block: 1 } });
	await settle();
	gate.away = true;
	chat.box();
	assert.equal(find(root, "pbs-form")[0]!.hasAttribute("inert"), true, "the open form is off");
	assert.equal(chips!.hasAttribute("inert"), false, "the answered chips stay as they are");
	assert.deepEqual(chips!.answered, [["text", "Go ahead"]]);
	for (const away of [false, true, false, true]) {
		gate.away = away;
		chat.box();
		assert.equal(find(root, "pbs-form")[0]!.hasAttribute("inert"), away, `box() again, away ${away}: each call reads the box anew`);
	}
});

/** With the record unreadable, the note under each answerable block says so and a display block's says nothing (PT-F002). */
function unsureNotes(root: El) {
	const blocks = root.find((el) => el.getAttribute("class") === "pbs-block"), notes = root.find((el) => el.getAttribute("class") === "pbs-note");
	assert.equal(notes.length, blocks.length);
	assert.ok(blocks.some((b) => (INTERACTIVE_KINDS as readonly string[]).includes(b.getAttribute("data-kind") ?? "")), "an answerable block is in the fixture");
	blocks.forEach((b, i) => assert.equal(/could not be read/i.test(notes[i]!.textContent), (INTERACTIVE_KINDS as readonly string[]).includes(b.getAttribute("data-kind") ?? ""), `the note under ${b.getAttribute("data-kind")}`));
}

test("pi-better-show 0.5.0: a chat block answered with the reserved `pi-note` field reaches the unit with the note, is recorded with it, and the locked element shows it", async () => {
	const { show, sent } = mount("S1");
	const root = await show(reply(DEMO_CHAT_BLOCKS));
	const [chips] = find(root, "pbs-suggest");
	const fields = [["text", "Go ahead"], ["pi-note", "but mind refunds"]];
	fire(chips!, { kind: "suggest", fields, ref: { block: 1 } });
	await settle();
	assert.equal(sent.length, 1);
	assert.match(String(sent[0]![1].text), /Other comments: but mind refunds/, "encodeAnswer appends the note to the text the unit reads");
	assert.deepEqual((sent[0]![1].block as { fields: unknown }).fields, fields, "the block names the full fields, note included");
	assert.deepEqual(chips!.answered, fields);
});
