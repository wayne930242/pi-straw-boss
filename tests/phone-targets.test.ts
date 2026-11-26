import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sheetRules } from "./css-rules.ts";

// The phone layout's tap targets (gui/style.css, "A phone's tap targets"): 44 px each way (Apple HIG), the composer's own row 48. They live in one
// `@media (max-width: 640px)` block, so the desktop layout is untouched. No browser runs here: this guards the declared sizes. The measured ones (every
// visible control under 44 px at 390 × 844 and 360 × 740 on the demo page) are in the change's report.
const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const MEDIA = "@media (max-width: 640px) {";
/** The rules of the `@media (max-width: 640px)` block that follows `marker` (a comment in style.css) as [selector, declarations]; the block ends at the brace that closes the query. */
function rulesAfter(marker: string): [string, string][] {
	const open = css.indexOf(MEDIA, css.indexOf(marker));
	assert.ok(open > 0, `${marker} has its phone block`);
	const found: [string, string][] = [];
	let depth = 0, from = open + MEDIA.length, selector = "";
	for (let at = from; at < css.length && depth >= 0; at++) {
		if (css[at] === "{") {
			if (depth === 0) selector = css.slice(from, at).replace(/\/\*[\s\S]*?\*\//g, "").trim();
			depth++;
			from = at + 1;
		} else if (css[at] === "}") {
			depth--;
			if (depth === 0) found.push([selector, css.slice(from, at)]);
			from = at + 1;
		}
	}
	return found;
}
const rules = rulesAfter("/* A phone's tap targets");
const bodyIn = (list: [string, string][], selector: string) => list.filter(([s]) => s === selector).map(([, b]) => b).join(";");
const body = (selector: string) => bodyIn(rules, selector);
const size = (selector: string, property: string) => Number(body(selector).match(new RegExp(`${property}:\\s*(\\d+)px`))?.[1]);

test("the phone block gives the controls the audit found small a 44 px box", () => {
	assert.ok(rules.length > 20, `the block's rules were read (${rules.length})`);
	const set = rules.find(([s]) => s.startsWith(":is(.pair-btn, .alerts")) as [string, string];
	assert.ok(set, "the shared min-height rule");
	for (const name of [".pair-btn", ".quit-btn", ".later", ".x", ".ask-send", ".ask-cancel", ".ask-opt", ".sheet-yes"]) assert.ok(set[0].includes(name), `${name} is in it`);
	assert.match(set[1], /min-height:\s*44px/);
	assert.match(body(":is(.pair-btn, .quit-btn, .later, .go, .x, .tab-add, .ask-send, .ask-cancel, .sheet-yes, .cmp-yes)"), /min-width:\s*44px/);
	for (const selector of [".head-back", ".prefs-btn"]) assert.deepEqual([size(selector, "width"), size(selector, "height")], [44, 44], selector);
	assert.equal(size(".modes button", "min-height"), 44);
	assert.equal(size(".brand", "min-height"), 44);
	assert.match(body(":is(.act > summary, .notice > summary, .rule summary, .todos summary, .monitors summary, .timeline summary)"), /min-height:\s*44px/);
	assert.match(body(":is(.head-info, .head-main:not([hidden]), .head-quit:not([hidden]), .ally-asks-btn)"), /min-height:\s*44px/, "the head's buttons and the ally card's question button");
	assert.match(body(":is(.ask, .term-bar, .doc-acts, .composer) :is(button, .cmp-link)"), /min-height:\s*44px/);
});

test("the folds of an ally card's unit (its report, a crash's notice) are 44 px tall on a phone", () => {
	assert.equal(size(".ally-unit summary", "min-height"), 44);
});

test("a main's Stop and its row in the Mains fold are 44 px each way on a phone, and the sheet's buttons (Stop, Interrupt and stop, Cancel) keep their 44 px and wrap", () => {
	assert.deepEqual([size(".au-stop", "min-height"), size(".au-stop", "min-width"), size(".au-main", "min-height")], [44, 44, 44]);
	assert.ok(rules.some(([sel]) => sel.includes(".sheet-yes") && sel.includes(".later")), "the sheet's buttons are in the phone rule");
	assert.match(css, /\.sheet-row\s*\{\s*flex-wrap:\s*wrap;/, "three buttons wrap on a narrow screen");
});

// The cascade at phone width (USC-F001): the phone block's `.au-stop { min-height: 44px }` lost to a later top-level `.au-stop { min-height: 32px }` of the same specificity, and the declarations test above read only the block.
// This reads every rule in source order (the top level and the phone query; other queries are skipped), keeps the declarations of rules whose selector ends in the class, and applies specificity, then order.
/** The style rules that apply at a phone's width, in source order: [selector list, declarations]. */
function phoneRules(): [string, string][] {
	const out: [string, string][] = [];
	const walk = (text: string) => {
		for (const { prelude, body } of sheetRules(text)) {
			if (body === undefined) continue;
			if ([MEDIA.slice(0, -2), "@layer standard", "@media all"].includes(prelude)) walk(body);
			else if (!prelude.startsWith("@")) out.push([prelude, body]);
		}
	};
	walk(css);
	return out;
}
/** A selector's weight as (ids, classes + attributes + pseudo-classes): `:where()` is nothing, other pseudo-classes count one, a `::pseudo-element` none. */
const weight = (selector: string) => {
	const bare = selector.replace(/:where\((?:[^()]|\([^()]*\))*\)/g, "").replace(/::[\w-]+/g, "");
	return (bare.match(/#[\w-]+/g)?.length ?? 0) * 100 + (bare.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g)?.length ?? 0);
};
/** A selector list as single selectors: split at top-level commas, and a selector that is one `:is(...)` is its members (it weighs what its heaviest member weighs). */
const members = (list: string): string[] => list.split(/,(?![^(]*\))/).map((x) => x.trim()).flatMap((x) => { const is = /^:is\(((?:[^()]|\([^()]*\))*)\)$/.exec(x); return is ? members(is[1]!) : [x]; });
/** The value a property has at phone width on an element whose own class is `cls`: the rules with a selector whose last compound names the class (inside `:where()` too), the heaviest first, the later one among equals. */
function phoneValue(cls: string, property: string): string | undefined {
	let best: { w: number; value: string } | undefined;
	for (const [list, decls] of phoneRules()) {
		const value = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+)`).exec(decls)?.[1]?.trim();
		if (!value) continue;
		for (const sel of members(list)) {
			const last = sel.split(/[\s>+~]+(?![^(]*\))/).pop()!;
			if (!new RegExp(`\\.${cls}(?![\\w-])`).test(last)) continue;
			const w = weight(sel);
			if (!best || w >= best.w) best = { w, value };
		}
	}
	return best?.value;
}

test("USC-F001: at phone width a main's Stop is 44 px tall and wide after the cascade, not only inside the phone block", () => {
	assert.equal(phoneValue("au-stop", "min-height"), "44px");
	assert.equal(phoneValue("au-stop", "min-width"), "44px");
	assert.equal(phoneValue("au-main", "min-height"), "44px");
	assert.equal(phoneValue("sheet-yes", "min-height"), "44px", "the check reads the sheet's buttons the same way");
	assert.equal(phoneValue("quit-btn", "min-height"), "44px");
});

test("the map's head band is 44 px tall, so a tap on a phone lands (the whole band is the link)", () => {
	const band = topRule(".head-node");
	assert.match(band, /height:\s*44px/);
	assert.match(band, /box-sizing:\s*border-box/);
	assert.doesNotMatch(body(".head-node::before") || "", /position:\s*absolute/, "no hit-box trick: the band itself is the target");
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

test("the home list's base name is a 23 px link, but its ::after stretches over the whole header, so a tap anywhere on the title row (outside the quit buttons) hits it", () => {
	const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
	assert.match(rule(".base > header"), /position:\s*relative/, "the header is what the link's ::after is sized against");
	assert.match(rule(".hit, .enter-base::after"), /position:\s*absolute;\s*inset:\s*0/);
	assert.match(rule(".enter-base::after"), /content:\s*""/);
	assert.doesNotMatch(rule(".title h2"), /position/, "the clipping h2 does not become the containing block");
	assert.match(body(".tl-mark"), /pointer-events:\s*none/, "and the 10 px activity marks take no taps at all");
});

// The phone's layout block ("A phone's menus and layout"): the `⋯` menus (gui/menu.ts), the one-line conversation bar, the queue fold, and what leaves the screen so the log gets 55 % of it.
const layout = rulesAfter("/* A phone's menus and layout");
const inLayout = (selector: string) => bodyIn(layout, selector);
const topRule = (selector: string) => css.match(new RegExp(`(?:^|\\n|\\}\\s)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

test("the `⋯` button is a 44 px box on a phone and not there above 640 px; its wrapper and panel are display: contents there, so the controls keep their row", () => {
	assert.ok(layout.length > 15, `the layout block's rules were read (${layout.length})`);
	assert.deepEqual([".width", ".min-width", ".height"].map((p) => Number(inLayout(".menu-btn").match(new RegExp(`(?:^|[;\\s])${p.slice(1)}:\\s*(\\d+)px`))?.[1])), [44, 44, 44]);
	assert.match(inLayout(".menu-btn"), /display:\s*grid/);
	assert.match(topRule(".menu, .menu-pop"), /display:\s*contents/, "above 640 px the wrapper and the panel add no box");
	assert.match(topRule(".menu-btn"), /display:\s*none/, "and no button");
	assert.match(inLayout(".menu-pop:not(:popover-open)"), /display:\s*none/, "a closed panel on a phone shows nothing");
	assert.match(inLayout(".menu-pop:popover-open"), /display:\s*grid/);
	// What the panel holds is a 44 px control already: the shared rule names .pair-btn and .quit-btn, and the head's + Main and Quit tower.
	assert.match(inLayout(".menu-pop :is(.pair-btn, .quit-btn)"), /width:\s*100%/);
});

test("a unit's Quit is only in its comms header on a phone map; a base's and a squad's are behind their `⋯`; the head's `⋯` is a tower's alone", () => {
	assert.match(inLayout(".base :is(.card > .quit-btn[data-close=\"unit\"], .tower-quit)"), /display:\s*none/, "no Quit on a unit's card or the base's Quit tower line");
	assert.match(inLayout(".comms-head:not([data-tower]) .menu-btn"), /display:\s*none/, "another unit's header keeps its own Quit in the row, with no `⋯`");
	assert.match(inLayout(".comms-head:not([data-tower]) .menu-pop"), /display:\s*contents/);
});

test("the log gets the screen: no crumbs on the map, no avatar gutter on an assistant's message, the conversation bar one line with its `⋯`", () => {
	assert.match(inLayout("body[data-route=\"map\"] .crumbs"), /display:\s*none/);
	assert.match(inLayout(".tx.in"), /grid-template-columns:\s*minmax\(0, 1fr\)/);
	assert.match(inLayout(".tx.in > .ava"), /display:\s*none/);
	assert.match(inLayout(".tower-conv .conv-line"), /white-space:\s*nowrap/);
	assert.match(inLayout(".tower-conv .conv-line"), /text-overflow:\s*ellipsis/);
	assert.match(inLayout(".tower-conv .conv-line > :is(.conv-began, .conv-cap, .conv-sep)"), /display:\s*none/, "the line keeps its title and the state; the rest is in the menu");
	assert.match(topRule(".tower-conv :is(.conv-facts, .conv-runs-bar)"), /display:\s*none/, "and what only the phone says is hidden above 640 px");
});

test("the queue's fold row is a 44 px button; the list and Edit wait behind it until it is opened, and show as they did above 640 px", () => {
	assert.match(inLayout(".queue-fold"), /min-height:\s*44px/);
	assert.match(inLayout(".queue-fold"), /width:\s*100%/);
	assert.match(inLayout(".queue-bar:not([hidden]):not([data-open]) ~ :is(.queue-list, .queue-act)"), /display:\s*none/);
	assert.match(topRule(".queue-bar"), /display:\s*none/, "the row is a phone's: no row above 640 px");
});

test("a squad's units are rows on a phone (the plate beside the name), and the workspace's totals one row of four", () => {
	assert.match(inLayout(".tally"), /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/);
	assert.match(inLayout(".col > .token"), /grid-template-columns:\s*auto minmax\(0, 1fr\)/);
});

test("the settings page's controls are 44 px on a phone: the rows, the sections' headings, the back arrow, the volume, and the Details folds; its text never widens the page", () => {
	const whole = (selector: string) => topRule(selector);
	assert.match(whole(".set-row"), /min-height:\s*44px/);
	assert.match(whole("details.set-group > summary"), /min-height:\s*44px/);
	assert.deepEqual([size(".set-head .head-back", "width"), size(".set-head .head-back", "min-height")], [44, 44]);
	assert.equal(size(".set-ctl input[type=\"range\"]", "min-height"), 44);
	assert.match(body(".lan summary"), /padding-block:\s*13px/, "the Wi-Fi tab's Details fold: 18 px of text and 13 px above and below");
	assert.match(body(".link-form summary"), /padding-block:\s*13px/, "and the Teams forms' folds");
	// The sections are grids whose one track takes the width and never the longest unbroken line (a fingerprint, an address), so a phone does not scroll sideways.
	assert.match(css, /\n\.settings\.view \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
	assert.match(css, /\n\.set-group \{ display: grid; grid-template-columns: minmax\(0, 1fr\);/);
	assert.match(css, /\.lan, \.lan-main, \.lan-board, \.lan-pair, \.pair, \.devices \{ grid-template-columns: minmax\(0, 1fr\); \}/);
	assert.match(topRule(".lan"), /overflow-wrap:\s*anywhere/);
});

test("the head page's rows are tap targets of 44 px: the log's fold line, each broadcast's row, the older fold, a tower's line and its link, and the buttons beside the composer (the shared phone rule covers `.pair-btn` and `.quit-btn`)", () => {
	const rule = (selector: string) => css.split("\n").flatMap((l) => (l.startsWith(`${selector} {`) ? [l] : [])).join(" ");
	for (const selector of [".ask-group > summary, .ask-older > summary, .ask-replaced > summary", ".ask-line", "a.ask-name", ".head-log > summary"]) assert.match(rule(selector) || css.split("\n").find((l) => l.includes(`${selector} {`)) || "", /min-height:\s*44px/, selector);
	const shared = rules.find(([s]) => s.startsWith(":is(.pair-btn, .alerts"))!;
	assert.ok(shared[0].includes(".pair-btn") && shared[0].includes(".quit-btn") && /min-height:\s*44px/.test(shared[1]), "End and New are `.pair-btn`, Close is `.quit-btn`");
	assert.match(css, /\.head-acts \{[^}]*flex-wrap:\s*wrap/, "the row wraps instead of cutting a button off a 360 px screen");
});

// A wait card (gui/waitcard.ts; docs/specs/2026-11-10-wait-cards-tui.md, section 4, Phone): it is the question panel, so every row, Send, link, the folded line and the More toggle are 44 px each way with 8 px between targets (in Standard, Geek, and Raven by the one block below, in Zen by
// its own), a URL wraps anywhere, a command wraps whole (it never scrolls sideways: nothing of it may hide). The behavior tests are in wait-card-gui.test.ts; this guards the same block this file reads.
const zen = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8");
test("a wait card's rows, Send and links are 44 px each way on a phone, 8 px apart, in every view", () => {
	const set = ".wait-card :is(.ask-opt, .ask-send, .cmp-link, .pair-btn, .wc-fold, .wc-more)";
	assert.equal(size(set, "min-height"), 44);
	assert.equal(size(set, "min-width"), 44);
	assert.match(body(".wait-card :is(.ask-opts, .ask-acts)"), /gap:\s*8px/);
	assert.match(body(".wait-card .wc-url"), /overflow-wrap:\s*anywhere/);
	assert.doesNotMatch(css.slice(css.indexOf("/* A phone's tap targets")), /\.wait-card \.wc-cmd \{[^}]*overflow-x/, "a command wraps on a phone too");
	assert.match(body(".wait-card :is(.wc-open, .wc-copy)"), /justify-self:\s*stretch/, "Open link and Copy sit below their text at the full width");
	assert.match(zen, /\[data-view="zen"\] \.wait-card :is\(\.ask-opt, \.ask-send, \.cmp-link, \.pair-btn\) \{[^}]*min-height: 44px; min-width: 44px/, "Zen's skin of the same targets");
	assert.match(zen, /\[data-view="zen"\] \.wait-card :is\(\.ask-opts, \.ask-acts\) \{ gap: 8px; \}/, "and its rows and Send are 8 px apart");
	assert.ok(zen.indexOf('[data-view="zen"] .wait-card :is(.ask-opts, .ask-acts)') > zen.indexOf('[data-view="zen"] .zen-card .ask-opts { gap: 2px'), "after the panel's own 2px gap, which it must win by order");
});

// wg-F001 / wg-F002 (review wait-gui): a wait card unfolded in a tower's comms or on the head page sits in `.comms-in`, whose question rules cap `.ask-ctx` and `.ask-why` at 5em and `.ask` at 55% of the room with its own scroll. The card's parts are its whole text and its Send must stay in view,
// so a card is not clamped there. No browser runs here: this resolves the cascade at phone width for the card's elements (descendant and child selectors, classes, `:not`, `:is`, attributes), the heaviest selector first, the later one among equals.
interface Node { classes: string[]; attrs?: Record<string, string> }
const compound = (text: string, el: Node): boolean => {
	let rest = text.trim().replace(/^[a-z][\w-]*|^\*/, "");
	while (rest) {
		let hit: RegExpExecArray | null;
		if ((hit = /^\.([\w-]+)/.exec(rest))) { if (!el.classes.includes(hit[1]!)) return false; }
		else if ((hit = /^:not\(((?:[^()]|\([^()]*\))*)\)/.exec(rest))) { if (members(hit[1]!).some((s) => compound(s, el))) return false; }
		else if ((hit = /^:(?:is|where)\(((?:[^()]|\([^()]*\))*)\)/.exec(rest))) { if (!members(hit[1]!).some((s) => compound(s, el))) return false; }
		else if ((hit = /^\[([\w-]+)(?:="([^"]*)")?\]/.exec(rest))) { const v = el.attrs?.[hit[1]!]; if (v === undefined || (hit[2] !== undefined && v !== hit[2])) return false; }
		else return false; // a pseudo-class this reader does not know (`:has`, `:hover`): not matched
		rest = rest.slice(hit[0].length);
	}
	return true;
};
/** `chain` is the element's ancestors from the root, the element itself last. */
const selects = (selector: string, chain: Node[]): boolean => {
	if (selector.includes("::") || /[+~]/.test(selector.replace(/\[[^\]]*\]|\([^)]*\)/g, ""))) return false;
	const parts = selector.replace(/\s*>\s*/g, " > ").split(/\s+(?![^(]*\))/).filter(Boolean);
	const up = (at: number, from: number): boolean => {
		if (at < 0) return true;
		if (parts[at] === ">") return from >= 0 && compound(parts[at - 1]!, chain[from]!) && up(at - 2, from - 1);
		for (let i = from; i >= 0; i--) if (compound(parts[at]!, chain[i]!) && up(at - 1, i - 1)) return true;
		return false;
	};
	return compound(parts[parts.length - 1]!, chain[chain.length - 1]!) && up(parts.length - 2, chain.length - 2);
};
function phoneComputed(chain: Node[], property: string): string | undefined {
	let best: { w: number; value: string } | undefined;
	for (const [list, decls] of phoneRules()) {
		const value = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+)`).exec(decls)?.[1]?.trim();
		if (!value) continue;
		for (const sel of list.split(/,(?![^(]*\))/).map((x) => x.trim())) if (selects(sel, chain)) { const w = weight(sel); if (!best || w >= best.w) best = { w, value }; }
	}
	return best?.value;
}
const askCard: Node = { classes: ["ask", "wait-card"], attrs: { "data-host": "row" } };
const inComms: Node[] = [{ classes: ["comms-in"] }, { classes: ["tower-notices"] }, { classes: ["tnote"] }, askCard];

test("wg-F001: in the comms (a tower's, the head page's) a wait card's parts and its why line are not height-capped on a phone, so the rows never draw over its text", () => {
	for (const cls of ["ask-ctx", "ask-why"]) assert.equal(phoneComputed([...inComms, { classes: [cls, "wc-parts"] }], "max-height"), "none", `${cls} of a wait card in .comms-in`);
	// The same reader sees the cap where it belongs: a question card in the comms keeps its 5em.
	assert.equal(phoneComputed([{ classes: ["comms-in"] }, { classes: ["ask"] }, { classes: ["ask-ctx"] }], "max-height"), "5em");
});

test("wg-F002: in the comms a wait card is no scroll box of its own (its Send is never below its edge), and its Send row is not the question's sticky bar on a phone", () => {
	const card = [{ classes: ["comms-in"] }, { classes: ["tower-notices"] }, askCard];
	assert.equal(phoneComputed(card, "max-height"), "none");
	assert.equal(phoneComputed(card, "overflow"), "visible");
	assert.ok(css.indexOf(".comms-in .wait-card {") > css.indexOf(".comms-in .ask {"), "after the question's own cap, which it ties on weight and so must win by order");
	const acts = [...card, { classes: ["ask-acts"] }];
	assert.equal(phoneComputed(acts, "position"), "static");
	assert.equal(phoneComputed([{ classes: ["comms-in"] }, { classes: ["ask"] }, { classes: ["ask-acts"] }], "position"), "sticky", "a question card keeps its sticky Send");
});
