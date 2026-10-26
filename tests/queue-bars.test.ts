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
const { drawQueued } = await import("../gui/bars.ts");

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
