import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The phone layout's tap targets (gui/style.css, "A phone's tap targets"): 44 px each way (Apple HIG), the composer's own row 48. They live in one
// `@media (max-width: 640px)` block, so the desktop layout is untouched. No browser runs here: this guards the declared sizes. The measured ones (every
// visible control under 44 px at 390 × 844 and 360 × 740 on the demo page) are in the change's report.
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const MEDIA = "@media (max-width: 640px) {";
const open = css.indexOf(MEDIA, css.indexOf("/* A phone's tap targets"));
assert.ok(open > 0, "the phone tap-target block exists");

/** The media query's rules as [selector, declarations]; the block ends at the brace that closes the query. */
const rules: [string, string][] = [];
let depth = 0, from = open + MEDIA.length, selector = "";
for (let at = from; at < css.length && depth >= 0; at++) {
	if (css[at] === "{") {
		if (depth === 0) selector = css.slice(from, at).replace(/\/\*[\s\S]*?\*\//g, "").trim();
		depth++;
		from = at + 1;
	} else if (css[at] === "}") {
		depth--;
		if (depth === 0) rules.push([selector, css.slice(from, at)]);
		from = at + 1;
	}
}
const body = (selector: string) => rules.filter(([s]) => s === selector).map(([, b]) => b).join(";");
const size = (selector: string, property: string) => Number(body(selector).match(new RegExp(`${property}:\\s*(\\d+)px`))?.[1]);

test("the phone block gives the controls the audit found small a 44 px box", () => {
	assert.ok(rules.length > 20, `the block's rules were read (${rules.length})`);
	const set = rules.find(([s]) => s.startsWith(":is(.pair-btn, .alerts")) as [string, string];
	assert.ok(set, "the shared min-height rule");
	for (const name of [".pair-btn", ".quit-btn", ".later", ".x", ".ask-send", ".ask-opt", ".sheet-yes"]) assert.ok(set[0].includes(name), `${name} is in it`);
	assert.match(set[1], /min-height:\s*44px/);
	assert.match(body(":is(.pair-btn, .quit-btn, .later, .x, .tab-add, .ask-send, .sheet-yes, .cmp-yes)"), /min-width:\s*44px/);
	for (const selector of [".head-back", ".prefs-btn"]) assert.deepEqual([size(selector, "width"), size(selector, "height")], [44, 44], selector);
	assert.equal(size(".modes button", "min-height"), 44);
	assert.equal(size(".brand", "min-height"), 44);
	assert.match(body(":is(.act > summary, .notice > summary, .rule summary, .todos summary, .monitors summary, .timeline summary)"), /min-height:\s*44px/);
	assert.match(body(":is(.head-info, .head-main:not([hidden]), .head-quit:not([hidden]))"), /min-height:\s*44px/);
	assert.match(body(":is(.ask, .term-bar, .doc-acts, .composer) :is(button, .cmp-link)"), /min-height:\s*44px/);
});

test("the composer's key row is 48 px and Send is wide enough to hit", () => {
	assert.equal(size(".composer :is(.cmp-alt, .cmp-send)", "min-height"), 48);
	assert.equal(size(".composer .cmp-alt", "min-width"), 48);
	assert.ok(size(".composer .cmp-send", "min-width") >= 48);
});

test("a chip keeps its look: its pill is drawn in ::before inside a 44 px box", () => {
	const chips = ":is(.tab-add, .thought, .more, .tab-btn)";
	assert.equal(size(chips, "min-height"), 44);
	assert.match(body(chips), /border:\s*0/, "the chip itself has no border, so its box is not the pill");
	const pill = body(`${chips}::before`);
	assert.match(pill, /inset:\s*11px 0/, "a 22 px pill in a 44 px box");
	assert.match(pill, /border:\s*1px solid var\(--line\)/, "the one border, on all four sides");
});

test("the queue's Edit is a 44 px button beside its hint, not alone on a row", () => {
	assert.match(body(".queue-act"), /flex-wrap:\s*nowrap/);
	assert.equal(size(".queue-act button", "min-height"), 44);
});

test("the trust question's three choices fill the width: Trust on its own row, the other two side by side", () => {
	assert.match(body(".trust .ask-acts"), /grid-template-columns:\s*1fr 1fr/);
	assert.match(body(".trust .ask-send"), /grid-column:\s*1 \/ -1/);
});

test("the timeline's marks, too small and too close to be 44 px, take no taps on a phone", () => {
	assert.match(body(".tl-mark"), /pointer-events:\s*none/);
});
