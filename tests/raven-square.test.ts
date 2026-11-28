import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarations, rulesOf, split } from "./css-rules.ts";

// Raven Keep round 2 (boss, 2026-11-08: 「不該用圓角卡片，並且可以考慮簡易裝飾線」): in the Raven view every card-like box has square corners, and a gold hairline and corner ticks are the keep's only ornaments.
// The hairline goes all round (boss, 2026-11-28: no card wears a one-sided border, ~/.pi/agent/rules/ui-design.md); it was a 4 px double rule on the top edge before.
// One blanket rule squares everything under `html[data-view="raven"]` except the keep-round set below, which is round by meaning (a ring, a dot, a halo). The test pins that set, so a new round exception needs a change here too.
const root = fileURLToPath(new URL("..", import.meta.url));
const raven = readFileSync(join(root, "gui/themes/raven/raven.css"), "utf8");
const rules = rulesOf(raven);
const radii = (body: string) => declarations(body).filter(([p]) => p === "border-radius");

/** The elements that stay round, with their own pseudo-elements: the status plate and tower and their rings, halos and badges, the avatar, the dots of a link, an ally unit and a timeline mark. */
const KEEP_ELEMENTS = [".plate", ".tower", ".sweep", ".pulse", ".ring", ".badge", ".connect-ring", ".packet", ".ava", ".portrait", ".au-dot", ".au-mdot", ".link i", ".head-btn .dot", '.tl-mark:is([data-mark="done"], .joined, .left)'];
/** The elements that are square themselves and carry a round dot as a pseudo-element (the toggle's dot, the news dot after a drawer name and a bar button's). */
const KEEP_DOTS = [".tog", ".drawer-head .name", ".bar-more[data-news]"];

const blanket = (pseudo: "" | "::before" | "::after") => rules.find((r) => r.parts.length === 1 && r.selector.startsWith('html[data-view="raven"] :not(') && r.selector.endsWith(`)${pseudo}`) && radii(r.body).length > 0);
const notList = (selector: string) => /:not\((.*)\)(?:::\w+)?$/.exec(selector)?.[1];

test("--pbs-radius is 0 in Raven, so pi-better-show's blocks are square too", () => {
	const block = rules.find((r) => r.selector === '[data-view="raven"]')!;
	assert.deepEqual(declarations(block.body).filter(([p]) => p === "--pbs-radius").map(([, v]) => v), ["0"]);
});

test("one blanket rule squares every element, and one each the ::before and ::after of the same, with !important and the keep-round set excepted", () => {
	for (const pseudo of ["", "::before", "::after"] as const) {
		const rule = blanket(pseudo);
		assert.ok(rule, `a blanket rule for ${pseudo || "elements"}`);
		assert.deepEqual(radii(rule.body), [["border-radius", "0 !important"]], `${pseudo || "elements"} get border-radius: 0 !important (a Standard rule of higher specificity, such as .base.remote .box-dev, must not win)`);
		assert.deepEqual(split(notList(rule.selector)!, ",").map((s) => s.trim()), pseudo ? [...KEEP_ELEMENTS, ...KEEP_DOTS] : KEEP_ELEMENTS, `the keep-round set of ${pseudo || "elements"}`);
	}
});

test("no other rule of raven.css gives a card-like selector a radius: a radius outside the blanket is on a keep-round element or is 0", () => {
	const round = [".sweep", ".ring", ".pulse", ".plate", ".tower", ".connect-ring"];
	for (const rule of rules) {
		if (rule === blanket("") || rule === blanket("::before") || rule === blanket("::after")) continue;
		for (const [, value] of radii(rule.body)) {
			if (/^0(px)?( !important)?$/.test(value)) continue;
			for (const part of rule.parts) assert.ok(round.some((k) => part.includes(k)), `${part} keeps a radius (${value}) but is not a keep-round element`);
		}
	}
});

test("the head band, the legend, the crumbs, and the yard's rows and pills have no radius of their own left (they take the blanket's)", () => {
	for (const rule of rules.filter((r) => /\.(head-node|legend|crumbs|yard-row|yard-pill)\b/.test(r.selector) && !r.selector.includes("::"))) {
		assert.deepEqual(radii(rule.body).filter(([, v]) => !/^0/.test(v)), [], `${rule.selector}`);
	}
});

/** The subject (the last compound, without its pseudo-element) of each part of a selector. */
const subjects = (selector: string) => split(selector, ",").map((p) => p.trim().replace(/::[\w-]+$/, "").split(/\s+(?![^(]*\))|\s*[>+~]\s*(?![^(]*\))/).pop()!);
const frames = () => rules.find((r) => r.parts.includes('html[data-view="raven"] .base') && declarations(r.body).some(([p]) => p === "border-color"))!;
/** The rules whose declarations include `prop`, with their parts. */
const setting = (prop: string, from = rules) => from.filter((r) => declarations(r.body).some(([p]) => p === prop));
const ticksRules = () => setting("background-image").filter((r) => /var\(--rk-ticks\)/.test(r.body));

test("the keep's ornament is a gold hairline all round its plain panels; a card whose border says a state keeps its colour", () => {
	const frame = frames();
	assert.ok(frame, "a rule colours the base's border");
	assert.deepEqual(declarations(frame.body), [["border-color", "var(--rk-rule)"]], "the colour only: each panel keeps its 1 px width and its style (a remote base that cannot be reached stays dashed)");
	for (const sel of ["dialog.sheet", ".hud", ".set-group", ".panel", ".comms-in", ".base"]) assert.ok(frame.parts.some((p) => p.endsWith(sel)), `${sel} has the gold hairline`);
	for (const sel of [".dialog", ".tcard", ".ask"]) assert.ok(!frame.parts.some((p) => p.includes(sel)), `${sel} keeps its own border colour (its state)`);
});

test("RS-F001: no Raven rule sets `position` on a dialog or a sheet: a modal dialog sits in the top layer, where `relative` computes to absolute against the document and the sheet opens above a scrolled page", () => {
	const bad = rules.filter((r) => declarations(r.body).some(([p]) => p === "position") && subjects(r.selector).some((s) => /(^|[^\w-])dialog\b|\.sheet\b/.test(s)));
	assert.deepEqual(bad.map((r) => r.selector), []);
});

test("RS-F003: an ask nested in a framed parent (the dock's .dialog, a .link-alert) has no ticks of its own", () => {
	for (const rule of ticksRules()) for (const part of rule.parts.filter((p) => /\.ask\b/.test(p))) {
		assert.match(part, /:not\([^)]*\.dialog \.ask[^)]*\)/, part);
		assert.match(part, /:not\([^)]*\.link-alert \.ask[^)]*\)/, part);
	}
});

test("RS-F004: the corner ticks are background layers of the box itself, not a pseudo-element: a box that scrolls keeps them in its corners; 8 gradients, 8px arms, 1px, 6px in from the edge", () => {
	assert.deepEqual(rules.filter((r) => r.parts.some((p) => /(dialog\.sheet|\.dialog|\.tcard|\.ask)(:not\([^)]*\))*::(before|after)$/.test(p))).map((r) => r.selector), [], "no pseudo-element draws the ticks");
	const vars = rules.find((r) => r.parts.includes('html[data-view="raven"]') && declarations(r.body).some(([p]) => p === "--rk-ticks"))!;
	assert.ok(vars, "the ticks are declared once, on the view's root");
	const d = Object.fromEntries(declarations(vars.body));
	assert.equal((d["--rk-tick"]!.match(/linear-gradient\(/g) ?? []).length, 1, "one line of the rule's colour");
	assert.equal((d["--rk-ticks"]!.match(/var\(--rk-tick\)/g) ?? []).length, 8, "four corners, two arms each");
	assert.equal((d["--rk-tick-at"]!.match(/(left|right) 6px (top|bottom) 6px/g) ?? []).length, 8, "6px in from the edges");
	assert.deepEqual(d["--rk-tick-size"]!.split(",").map((x) => x.trim()), ["8px 1px", "1px 8px", "8px 1px", "1px 8px", "8px 1px", "1px 8px", "8px 1px", "1px 8px"]);
	const on = ticksRules();
	const parts = on.flatMap((r) => r.parts);
	for (const sel of ["dialog.sheet", ".dialog", ".tcard", ".ask"]) assert.ok(parts.some((p) => p.includes(sel)), `${sel} has ticks`);
	for (const r of on) {
		const dd = Object.fromEntries(declarations(r.body));
		assert.match(dd["background-position"]!, /^var\(--rk-tick-at\)/);
		assert.match(dd["background-size"]!, /^var\(--rk-tick-size\)/);
		assert.equal(dd["background-repeat"], "no-repeat");
		assert.equal(dd.background, undefined, "longhands only: the box keeps its own colour");
	}
	// the dialog and the tower card paint a gradient of their own (style.css): the ticks go over it, and it stays
	const own = on.find((r) => r.parts.some((p) => p.endsWith(".tcard")))!;
	assert.match(declarations(own.body).find(([p]) => p === "background-image")![1], /^var\(--rk-ticks\), linear-gradient\(var\(--c1\), var\(--surface-0\) 70%\)$/);
	assert.match(declarations(own.body).find(([p]) => p === "background-position")![1], /^var\(--rk-tick-at\), 0 0$/);
	assert.match(declarations(own.body).find(([p]) => p === "background-size")![1], /^var\(--rk-tick-size\), auto$/);
});

test("RS-F005: the yard has the keep's gold hairline (no border colour of its own beats the sheets') and no ticks (it has no padding: a tick would land on Close)", () => {
	const yard = rules.find((r) => r.parts.includes('[data-view="raven"] dialog.sheet.yard'))!;
	assert.deepEqual(declarations(yard.body).filter(([p]) => p.startsWith("border")), []);
	assert.ok(frames().parts.includes('html[data-view="raven"] dialog.sheet'), "the sheets' hairline reaches the yard");
	for (const r of ticksRules()) for (const p of r.parts.filter((x) => x.includes("dialog.sheet"))) assert.match(p, /:not\(\.yard\)/, p);
});
