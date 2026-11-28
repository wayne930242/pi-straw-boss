import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Queued } from "../src/net.ts";

// The queue under the chat (gui/bars.ts drawQueued): each queued message is at most three lines, cut with an ellipsis, with its label inside the clamp
// and the full text on the row (its title). The padding sits on the row and the clamp on the box inside it: padding inside a clamped box shows a sliver
// of the fourth line below the third.
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** What the stylesheet declares for `property` on exactly `selector`, the last rule winning. */
function declared(selector: string, property: string): string | undefined {
	let found: string | undefined;
	for (const [, list, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		if (!list!.split(",").some((s) => s.trim() === selector)) continue;
		const value = body!.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1]?.trim();
		if (value) found = value;
	}
	return found;
}

class El {
	kids: (El | string)[] = [];
	title = "";
	attrs = new Map<string, string>();
	setAttribute(k: string, v: string) { this.attrs.set(k, v); }
	hidden = false;
	textContent = "";
	tag: string;
	constructor(tag: string) {
		this.tag = tag;
	}
	append(...kids: (El | string)[]) {
		this.kids.push(...kids);
	}
	replaceChildren(...kids: (El | string)[]) {
		this.kids = kids;
	}
	get text(): string {
		return this.textContent + this.kids.map((k) => (typeof k === "string" ? k : k.text)).join("");
	}
}
Object.assign(globalThis, { document: { createElement: (tag: string) => new El(tag), createTextNode: (s: string) => s } });
const { drawQueued, foldQueue, mountQueueEdit, mountQueueFold } = await import("../gui/bars.ts");

test("todo details stay off the summary and are both hoverable and accessible", async () => {
	const { drawTodos } = await import("../gui/bars.ts");
	const ol = new El("ol"), label = new El("span"), count = new El("b");
	const box = { querySelector: (s: string) => s === "ol" ? ol : s === "summary span" ? label : count };
	drawTodos({ querySelector: () => box } as unknown as HTMLElement, [{ id: 1, subject: "Round", status: "in_progress", points: 0, anchor: "Rounds", evidence: { command: "test", result: "pass", sha: "abcdef0", at: "2026-11-24T00:00:00Z" }, spend: { tokens: 4800, cost: 0.75, ms: 125_000, runs: 2, models: ["anthropic/claude-opus-5-5"] } }, { id: 2, subject: "Plain", status: "pending" }]);
	const [one, plain] = ol.kids as El[];
	assert.equal(label.text, "Round"); assert.equal(one!.text, "Round 0 pt"); assert.match(one!.title, /Anchor: Rounds\nRecorded: test · pass · abcdef0.*\nSpent: 4,800 tokens · \$0\.75 · 2m · 2 runs · anthropic\/claude-opus-5-5$/); assert.equal(one!.attrs.get("aria-description"), one!.title); assert.equal(plain!.text, "Plain"); assert.equal(plain!.title, "");
});

const draw = (list: Queued[] | undefined) => {
	const box = new El("div");
	drawQueued({ querySelector: () => box } as unknown as HTMLElement, list);
	return box;
};

test("a queued message is clamped to three lines by a box inside the padded row", () => {
	const span = ".queue-list p > span";
	assert.equal(declared(span, "-webkit-line-clamp"), "3");
	assert.equal(declared(span, "display"), "-webkit-box");
	assert.equal(declared(span, "overflow"), "hidden");
	assert.equal(declared(span, "padding"), undefined, "no padding inside the clamp");
	assert.ok(declared(".queue-list p", "padding"), "the row carries the padding");
	assert.equal(declared(".queue-list p", "-webkit-line-clamp"), undefined, "the row is not the clamped box");
});

test("each queued row keeps the full text in its title and the label with the text inside the clamped box", () => {
	const long = "word ".repeat(200).trim();
	const box = draw([{ text: long, as: "steer" }, { text: "later", as: "followUp" }]);
	assert.equal(box.hidden, false);
	const [first, second] = box.kids as El[];
	assert.equal(first!.title, long, "the whole text stays reachable");
	assert.equal(first!.kids.length, 1);
	const body = first!.kids[0] as El;
	assert.equal(body.tag, "span");
	assert.equal((body.kids[0] as El).tag, "b", "the label is inside the clamp, on the first line");
	assert.equal(body.kids[1], long);
	assert.equal(second!.title, "later");
});

test("an empty queue hides the list", () => {
	assert.equal(draw([]).hidden, true);
	assert.equal(draw(undefined).hidden, true);
});

test("an open row shows its full text, and the button semantics only go to rows that overflow", () => {
	assert.equal(declared(".queue-list p[data-open] > span", "display"), "block");
	assert.equal(declared(".queue-list p[data-open] > span", "overflow"), "visible");
	assert.equal(declared(".queue-list p[role=\"button\"]:focus-visible", "outline"), "2px solid var(--accent)");
	assert.equal(declared(".queue-list p[role=\"button\"]", "cursor"), "pointer");
});

test("a click or Enter/Space toggles a cut row; a row that fits has no toggle", () => {
	const els: ElA[] = [];
	class ElA extends El {
		attrs = new Map<string, string>();
		on = new Map<string, (e: unknown) => void>();
		setAttribute(k: string, v: string) { this.attrs.set(k, v); }
		removeAttribute(k: string) { this.attrs.delete(k); }
		getAttribute(k: string) { return this.attrs.get(k) ?? null; }
		addEventListener(t: string, f: (e: unknown) => void) { this.on.set(t, f); }
		scrollHeight = 0;
		clientHeight = 0;
		constructor(tag: string) { super(tag); els.push(this); }
	}
	const frames: (() => void)[] = [];
	Object.assign(globalThis, { document: { createElement: (t: string) => new ElA(t) }, requestAnimationFrame: (f: () => void) => frames.push(f) });
	const box = new ElA("div");
	const run = () => { drawQueued({ querySelector: () => box } as unknown as HTMLElement, [{ text: "long", as: "steer" }, { text: "short", as: "followUp" }]); };
	const measure = () => { const [lp, sp] = box.kids as ElA[]; (lp!.kids[0] as ElA).scrollHeight = 90; (lp!.kids[0] as ElA).clientHeight = 60; frames.splice(0).forEach((f) => f()); return [lp!, sp!] as const; };
	run();
	const [lp, sp] = measure();
	assert.equal(lp.getAttribute("role"), "button");
	assert.equal(lp.getAttribute("aria-expanded"), "false");
	assert.equal(sp.getAttribute("role"), null, "a row that fits has no toggle");
	lp.on.get("click")!({});
	assert.equal(lp.getAttribute("aria-expanded"), "true");
	assert.ok(lp.attrs.has("data-open"));
	run();
	const [lp2] = measure();
	assert.equal(lp2.getAttribute("aria-expanded"), "true", "open survives a redraw of the same item");
	let prevented = false;
	lp2.on.get("keydown")!({ key: " ", preventDefault: () => (prevented = true) });
	assert.ok(prevented);
	assert.equal(lp2.getAttribute("aria-expanded"), "false");
	lp2.on.get("keydown")!({ key: "Enter", preventDefault() {} });
	assert.equal(lp2.getAttribute("aria-expanded"), "true");
	lp2.on.get("keydown")!({ key: "a", preventDefault() { assert.fail(); } });
	assert.equal(lp2.getAttribute("aria-expanded"), "true");
});

test("the queue's Edit line shows with the queue and goes with it; the button runs the take-back once at a time, disabled while it runs", async () => {
	const rows = new El("div"), act = new El("div"), button = Object.assign(new El("button"), { disabled: false, onclick: undefined as undefined | (() => void) });
	const view = { querySelector: (sel: string) => (sel === ".queue-list" ? rows : sel === ".queue-act" ? act : sel === ".queue-act button" ? button : null) } as unknown as HTMLElement;
	drawQueued(view, [{ text: "a", as: "steer" }]);
	assert.equal(act.hidden, false);
	drawQueued(view, []);
	assert.equal(act.hidden, true, "no queue, no Edit");
	let release!: () => void, runs = 0;
	mountQueueEdit(view, () => (runs++, new Promise<void>((r) => (release = r))));
	button.onclick!();
	assert.equal(button.disabled, true);
	release();
	await new Promise((r) => setImmediate(r));
	assert.equal(button.disabled, false);
	assert.equal(runs, 1);
	assert.equal(declared(".queue-act[hidden]", "display"), "none", "the author style would otherwise show a hidden line");
});

test("the Edit button reads \"Edit all steers\" / \"編輯所有插話\" and has no hint line", async () => {
	const { readFileSync } = await import("node:fs");
	for (const [file, label] of [["en.json", "Edit all steers"], ["zh-TW.json", "編輯所有插話"]] as const) {
		const messages = JSON.parse(readFileSync(new URL(`../gui/messages/${file}`, import.meta.url), "utf8")) as Record<string, string>;
		for (const key of ["queue_edit", "edit_taking", "edit_taken", "edit_none", "edit_unsure"]) assert.ok(messages[key], `${file} ${key}`);
		assert.equal(messages.queue_edit, label, file);
		assert.equal(messages.queue_edit_hint, undefined, `${file} keeps no hint`);
	}
});

test("an open row is keyed by its session and, among identical rows, by its place: opening one opens no other (R-F007)", () => {
	class ElB extends El {
		attrs = new Map<string, string>();
		on = new Map<string, (e: unknown) => void>();
		setAttribute(k: string, v: string) { this.attrs.set(k, v); }
		removeAttribute(k: string) { this.attrs.delete(k); }
		getAttribute(k: string) { return this.attrs.get(k) ?? null; }
		addEventListener(t: string, f: (e: unknown) => void) { this.on.set(t, f); }
		scrollHeight = 90;
		clientHeight = 60;
	}
	const frames: (() => void)[] = [];
	Object.assign(globalThis, { document: { createElement: (t: string) => new ElB(t) }, requestAnimationFrame: (f: () => void) => frames.push(f) });
	const run = (box: ElB, list: Queued[], session: string) => {
		drawQueued({ querySelector: () => box } as unknown as HTMLElement, list, session);
		frames.splice(0).forEach((f) => f());
		return box.kids as ElB[];
	};
	const same: Queued[] = [{ text: "same words", as: "steer" }, { text: "same words", as: "steer" }, { text: "same words", as: "followUp" }];
	const [a, b] = [new ElB("div"), new ElB("div")];
	const [a1, a2, a3] = run(a, same, "alpha");
	for (const row of [a1!, a2!, a3!]) (row.kids[0] as ElB).scrollHeight = 90, (row.kids[0] as ElB).clientHeight = 60;
	run(a, same, "alpha").forEach((row) => assert.equal(row.getAttribute("aria-expanded"), "false"));
	const rows = run(a, same, "alpha");
	rows[1]!.on.get("click")!({});
	assert.deepEqual(rows.map((r) => r.getAttribute("aria-expanded")), ["false", "true", "false"], "only the second of two identical rows opens");
	assert.deepEqual(run(a, same, "alpha").map((r) => r.getAttribute("aria-expanded")), ["false", "true", "false"], "and stays open across a redraw");
	assert.deepEqual(run(b, same, "beta").map((r) => r.getAttribute("aria-expanded")), ["false", "false", "false"], "another session's identical queue is not opened with it");
	run(a, same.slice(0, 1), "alpha");
	assert.deepEqual(run(a, same, "alpha").map((r) => r.getAttribute("aria-expanded")), ["false", "false", "false"], "a row that left the queue does not come back open");
});

// A phone folds a queue of more than one to a row, "3 queued" (gui/bars.ts foldQueue, style.css "A phone's menus"); one message stays the bubble it will become. Above 640 px the row is `display: none`.
const fold = () => {
	const label = { textContent: "" }, attrs: Record<string, string> = {}, press = { onclick: undefined as (() => void) | undefined };
	const bar = { hidden: true, dataset: {} as Record<string, string>, querySelector: (s: string) => (s === "b" ? label : { setAttribute: (k: string, v: string) => void (attrs[k] = v), get onclick() { return press.onclick; }, set onclick(f: (() => void) | undefined) { press.onclick = f; } }) };
	const view = { querySelector: (s: string) => (s === ".queue-bar" ? bar : null) } as unknown as HTMLElement;
	return { bar, label, attrs, view, press };
};

test("the fold row shows with two or more queued messages, says how many, and is gone with one or none", () => {
	const f = fold();
	foldQueue(f.view, 3);
	assert.equal(f.bar.hidden, false);
	assert.equal(f.label.textContent, "3 queued");
	foldQueue(f.view, 1);
	assert.equal(f.bar.hidden, true, "one message is the bubble it will become");
	foldQueue(f.view, 0);
	assert.equal(f.bar.hidden, true);
	foldQueue({ querySelector: () => null } as unknown as HTMLElement, 2); // a view with no bar (a terminal tile) is left alone
});

test("the fold row's button opens and shuts the list, says so in aria-expanded, and the fold stays as the user left it while the count changes; a queue that empties closes it", () => {
	const f = fold();
	mountQueueFold(f.view);
	foldQueue(f.view, 3);
	assert.equal(f.attrs["aria-expanded"], "false");
	f.press.onclick!();
	assert.equal(f.bar.dataset.open, "1");
	assert.equal(f.attrs["aria-expanded"], "true");
	foldQueue(f.view, 4);
	assert.equal(f.bar.dataset.open, "1", "a fourth arriving does not shut what the user opened");
	assert.equal(f.label.textContent, "4 queued");
	f.press.onclick!();
	assert.equal(f.bar.dataset.open, undefined);
	assert.equal(f.attrs["aria-expanded"], "false");
	f.press.onclick!();
	foldQueue(f.view, 1);
	assert.equal(f.bar.dataset.open, undefined, "back to one: the next queue starts folded");
});

test("the fold row is in both languages, with its count", async () => {
	const { m } = await import("../gui/paraglide/messages.js");
	assert.equal(m.queue_fold({ count: 3 }), "3 queued");
	assert.equal(m.queue_fold({ count: 3 }, { locale: "zh-TW" }), "排隊中 3 則");
});

test("R-F001: a message that waits with no start under way says why it waits and that it is kept, in both languages", async () => {
	const { m } = await import("../gui/paraglide/messages.js");
	const box = new El("div"), act = new El("div");
	const view = { querySelector: (sel: string) => (sel === ".queue-list" ? box : sel === ".queue-act" ? act : null) } as unknown as HTMLElement;
	const want = { off: /service off/, refused: /could not start/, full: /slots full/, offline: /not live/, unproven: /not ready/ } as const;
	for (const [why, re] of Object.entries(want)) {
		drawQueued(view, [{ text: "x", as: "followUp", why: why as keyof typeof want }], "", true);
		assert.match(box.text, re, why);
		assert.doesNotMatch(box.text, /sent when ready|next run/);
		assert.notEqual(m[`queued_wait_${why as keyof typeof want}`]({}, { locale: "zh-TW" }), m[`queued_wait_${why as keyof typeof want}`]());
	}
	assert.equal(m.queued_wait_off({}, { locale: "zh-TW" }), "塔台服務已關閉・訊息會留著");
	assert.equal(m.queued_wait_full({}, { locale: "zh-TW" }), "執行名額已滿・稍後送出");
});

test("HP-F002: a message that waits for a tower to start is labelled as that, never as a steer, a follow-up, or the next run", () => {
	const box = new El("div"), act = new El("div");
	const view = { querySelector: (sel: string) => (sel === ".queue-list" ? box : sel === ".queue-act" ? act : null) } as unknown as HTMLElement;
	for (const server of [false, true]) {
		drawQueued(view, [{ text: "wake up", as: "start" }], "", server);
		assert.match(box.text, /^Tower starting · sent when ready/, `server=${server}`);
		assert.doesNotMatch(box.text, /steer|follow-up|next run/i);
	}
	drawQueued(view, [{ text: "later", as: "followUp" }], "", true);
	assert.match(box.text, /Queued · next run/, "a running tower's rows keep their word");
});
