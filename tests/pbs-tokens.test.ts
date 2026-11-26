import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declarations, rulesOf } from "./css-rules.ts";

// docs/specs/2026-11-07-raven-view/spec.md §7: every view maps pi-better-show's tokens (README, Tokens) onto its own palette, so a pbs element in a document or a chat entry follows the active view.
const TOKENS = ["bg", "fg", "muted", "surface", "line", "control", "accent", "on-accent", "note", "ok", "warn", "risk", "radius", "gap", "font", "font-display", "mono", "font-size"].map((t) => `--pbs-${t}`);
const css = (path: string) => rulesOf(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const VIEWS: [string, string, string][] = [
	["standard", "gui/style.css", ":root"],
	["geek", "gui/themes/geek/geek.css", '[data-view="geek"]'],
	["zen", "gui/zen.css", '[data-view="zen"] :is(#zen, .connect)'],
	["raven", "gui/themes/raven/raven.css", '[data-view="raven"]'],
];
/** Storybook's two phases (docs/specs/2026-11-26-storybook-theme/spec.md §B2): light by day, dark at night, each block mapping every token. */
const PHASES: [string, string, string][] = [
	["day", '[data-view="storybook"]', "light"],
	["night", '[data-view="storybook"][data-phase="night"]', "dark"],
];
for (const [phase, selector, scheme] of PHASES) {
	test(`storybook's ${phase} maps every --pbs-* token, color-scheme ${scheme}`, () => {
		const rule = css("gui/themes/storybook/storybook.css").find((r) => r.selector === selector);
		assert.ok(rule, selector);
		const set = new Map(declarations(rule.body));
		for (const token of TOKENS) assert.ok(set.get(token), `${token} is mapped for storybook's ${phase}`);
		assert.equal(set.get("color-scheme"), scheme);
	});
}

for (const [view, path, selector] of VIEWS) {
	test(`${view} maps every --pbs-* token, dark, in ${path}`, () => {
		const rule = css(path).find((r) => r.parts.includes(selector) && declarations(r.body).some(([p]) => p === "--pbs-bg"));
		assert.ok(rule, `a ${selector} rule sets --pbs-bg`);
		const set = new Map(declarations(rule.body));
		for (const token of TOKENS) assert.ok(set.get(token), `${token} is mapped for ${view}`);
		assert.ok(declarations(css(path).filter((r) => r.parts.includes(selector) || (view === "standard" && r.selector === "html")).map((r) => r.body).join(";")).some(([p, v]) => p === "color-scheme" && v === "dark"), `${view} sets color-scheme: dark`);
	});
}

// One source per token: the four view rules above own every `--pbs-*` value, so gui/pbs.css (the block chunk's own sheet) declares none, and no theme re-declares one on the block wrapper.
test("gui/pbs.css declares no --pbs-* token, and no view re-sets one on the block wrapper", () => {
	const owners = ["gui/pbs.css", "gui/style.css", "gui/zen.css", "gui/themes/geek/geek.css", "gui/themes/raven/raven.css", "gui/themes/storybook/storybook.css"];
	for (const path of owners) {
		const own = css(path).filter((r) => declarations(r.body).some(([p]) => p.startsWith("--pbs-")));
		if (path === "gui/pbs.css") assert.deepEqual(own.map((r) => r.selector), [], "pbs.css declares no token");
		else assert.ok(own.every((r) => !r.selector.includes(".pbs-block")), `${path} sets its tokens on the view, not on the wrapper`);
	}
});
