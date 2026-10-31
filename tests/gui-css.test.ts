import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// What the page's style sheet must keep (no browser runs here): the hidden slash menu stays hidden, the selected pair tab is shown by more than colour,
// and text boxes and menus are themed.
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const rule = (selector: string) => css.split("\n").flatMap((line) => (line.includes(selector) ? [line] : [])).join("\n");

test("`.slash[hidden]` is display none", () => {
	assert.match(css, /\.slash\[hidden\]\s*\{\s*display:\s*none/);
});

test("the selected pair tab has a fill and a heavier weight, for `.on` and `aria-selected`", () => {
	const line = rule('.pair-tabs .later[aria-selected="true"]');
	assert.match(line, /\.pair-tabs \.later\.on/);
	assert.match(line, /font-weight:\s*700/);
	assert.match(line, /background:\s*color-mix/);
});

test("the server's facts are a two-column grid and text boxes and menus are themed", () => {
	assert.match(rule(".server-facts {"), /display:\s*grid;\s*grid-template-columns:\s*max-content/);
	assert.match(css, /:where\(input:not\([^)]*\), select\)\s*\{[^}]*background:\s*var\(--surface-0\)/);
});

test("the boss-conversation bar has padding and its phrases wrap as units", () => {
	assert.match(rule(".tower-conv { display: grid"), /padding:\s*8px 10px/);
	assert.match(rule(".tower-conv .conv-line > span"), /display:\s*inline-block/);
});
