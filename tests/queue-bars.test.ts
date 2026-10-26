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
const { drawQueued, mountQueueEdit } = await import("../gui/bars.ts");

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

test("the Edit line and its hint have words in both languages, and the hint says what comes back and what cannot", async () => {
	const { readFileSync } = await import("node:fs");
	for (const [file, mustSay] of [["en.json", [/together/, /one text/, /delivered/]], ["zh-TW.json", [/全部/, /一段文字/, /送達/]]] as const) {
		const messages = JSON.parse(readFileSync(new URL(`../gui/messages/${file}`, import.meta.url), "utf8")) as Record<string, string>;
		for (const key of ["queue_edit", "queue_edit_hint", "edit_taking", "edit_taken", "edit_none"]) assert.ok(messages[key], `${file} ${key}`);
		for (const re of mustSay) assert.match(messages.queue_edit_hint!, re, file);
	}
});
