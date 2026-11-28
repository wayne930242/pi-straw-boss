import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarations, scopedRulesOf, split } from "./css-rules.ts";

// No card or panel of the page wears a stripe (boss, 2026-11-28, on the car cards: 「這居然是 single border card，我說過我超討厭這個設計」; his rule in ~/.pi/agent/rules/ui-design.md):
// a card or panel has one border on all four sides, or none, and a state, a kind, or an emphasis shows through a badge, an icon, a heading, or a tint, never through a thicker or coloured border on one side.
// Every sheet of the GUI (gui/*.css and each theme's) is read: a declaration that draws one side (border-left, border-top-color, border-inline-start, border-bottom-width, …), a border-width, -color or
// -style whose sides differ, and an inset box-shadow with an offset (a stripe painted inside the box) fail, unless the selector is a divider or a control listed below with why it is not a card.

const root = fileURLToPath(new URL("..", import.meta.url));
const gui = join(root, "gui");
const sheets = (readdirSync(gui, { recursive: true }) as string[]).filter((f) => f.endsWith(".css") && !f.split(/[\\/]/).includes("paraglide")).map((f) => join(gui, f)).sort();

/** The selectors that may draw one side, each with why it is not a card. Keyed by the sheet (under gui/) and the selector part as css-rules.ts reads it (whitespace collapsed). */
const ALLOWED: Record<string, string> = {
	// Dividers: a hairline between two parts of one card, a column, a list, or a bar, not the edge of a card.
	"style.css .devices": "the hairline above the device list inside the pairing panel",
	"style.css .lan hr": "a rule between two parts of the Wi-Fi panel",
	"style.css .todos-all": "the hairline above the folded checklist inside the todo box",
	"style.css .picker-places": "the column divider between the places and the folders of the picker (a row divider on a phone)",
	"style.css .pcol": "the divider between two folder columns of the picker",
	"style.css .tower-notices .tnote + .tnote": "the hairline between two notes in a tower's list",
	"style.css .tl-lanes": "the dashed time axis of the timeline",
	"style.css .composer": "the hairline between the log and the composer",
	"style.css .comms-in > .chat-root": "the hairline between the log and the composer inside the comms panel",
	"style.css .drawer": "the inner edge of the drawer, flush with the screen on its other three sides",
	"style.css .drawer-foot": "the hairline above the drawer's foot",
	"style.css .base.remote > :is(.box-runs, .box-truns, .box-ally)": "the hairline above a remote base's folds, inside the base",
	"style.css .ally-unit details": "the hairline above a unit's folded report, inside the unit",
	"style.css .link-roster tr": "the row divider of the roster table on a phone",
	"style.css .tx.conv-rule > div": "the rule that marks a new conversation in the log, a line with words",
	"style.css .supply-barracks": "the column divider between the supply cells and the barracks",
	"style.css .ask-full": "the dashed hairline above a question's full text, inside the question",
	"style.css .yard-bar": "the hairline under the yard's toolbar",
	"style.css .auto-back .auto-back-rest": "the hairline above the folded rest of the Auto mode report",
	"themes/raven/raven.css html[data-view=\"raven\"] .supply-tray .supply-cells": "the gold rule under the supply cells in the tray, a divider",
	// Shapes drawn with a border, not a card's edge.
	"style.css .subs > .unit > .card::after": "the arrowhead of a sub's link line, a CSS triangle",
	"style.css [data-mark=\"working\"] > .badge::after": "the spinner's open arc",
	"style.css .connect-ring": "the connecting spinner's bright arc",
	// Controls drawn as a key or an underlined field.
	"style.css .pad-key": "a key of the on-screen keypad: its deeper bottom edge is the key's travel, a button, not a card",
	"style.css .pad-key:active:not(:disabled)": "the pressed key",
	"themes/geek/geek.css [data-view=\"geek\"] .pad-key": "Geek's flat key",
};
/** Zen's fields and buttons are a line under the words, the way Zen draws every input; the target button's inset line is the divider between it and the field beside it. */
const ZEN_FIELDS = [".zen-company .composer textarea", ".zen-head-hint", ".zen-head-box", ".palette-box", ".target-btn", ".target-find", "#zen :is(.zen-card .ask-own, .composer textarea, .tcard-input, .palette-box):focus-visible", "#zen .zen-head-box:focus-visible", "#zen .target-btn:focus-visible", "#zen .target-find:focus-visible", ".target-find:focus-visible", ".palette-box:focus", ":is(.zen-card .ask-own, .composer textarea, .tcard-input)"];
const zenField = (sheet: string, part: string) => (sheet === "zen.css" ? ZEN_FIELDS.find((f) => part === `[data-view="zen"] ${f}`) : undefined);

const NONE = /^(0|0px|none|0 none|none 0|initial|unset)( !important)?$/;
const SIDE = /^border-(top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end)(-(width|color|style))?$/;
/** Why a declaration draws one side, or undefined. */
function sided(prop: string, value: string): string | undefined {
	if (SIDE.test(prop)) return NONE.test(value) ? undefined : "draws one side";
	if (/^border-(width|color|style)$/.test(prop)) {
		const sides = split(value.replace(/\s*!important$/, ""), " ").filter(Boolean);
		return new Set(sides).size > 1 ? "sets the sides differently" : undefined;
	}
	if (prop === "box-shadow") {
		for (const layer of split(value, ",")) {
			const words = layer.trim().split(/\s+(?![^(]*\))/);
			if (!words.includes("inset")) continue;
			const lengths = words.filter((w) => /^-?[\d.]+(px|em|rem)?$/.test(w));
			if (lengths.slice(0, 2).some((l) => Number.parseFloat(l) !== 0)) return "paints a stripe inside the box (an inset shadow with an offset)";
		}
	}
	return undefined;
}

function offenders() {
	const out: string[] = [];
	const used = new Set<string>();
	for (const file of sheets) {
		const sheet = relative(gui, file).split("\\").join("/");
		for (const rule of scopedRulesOf(readFileSync(file, "utf8"))) {
			for (const [prop, value] of declarations(rule.body)) {
				const why = sided(prop, value);
				if (!why) continue;
				for (const part of rule.parts) {
					const key = `${sheet} ${part}`;
					const zen = zenField(sheet, part);
					if (key in ALLOWED || zen) { used.add(zen ? `zen ${zen}` : key); continue; }
					out.push(`${key} { ${prop}: ${value} } ${why}`);
				}
			}
		}
	}
	return { out, used };
}

test("no card or panel in any sheet of the GUI draws a border on one side: a uniform border, or none", () => {
	assert.ok(sheets.some((f) => f.endsWith("style.css")) && sheets.some((f) => f.includes("storybook")), "the sheets are found");
	assert.deepEqual(offenders().out, []);
});

test("each allowed selector still draws its one side: a divider that went away leaves the list", () => {
	const { used } = offenders();
	assert.deepEqual([...Object.keys(ALLOWED), ...ZEN_FIELDS.map((f) => `zen ${f}`)].filter((k) => !used.has(k)), []);
});

test("the reader catches a stripe in each of its forms, and passes a uniform border, a reset, and a ring", () => {
	for (const [p, v] of [["border-left", "3px solid var(--c)"], ["border-inline-start", "2px solid red"], ["border-top-color", "var(--gold)"], ["border-bottom-width", "3px"], ["border-width", "1px 1px 1px 3px"], ["border-color", "var(--line) var(--line) var(--line) var(--err)"], ["box-shadow", "0 2px 4px #000, inset 3px 0 0 var(--accent)"]] as const) assert.ok(sided(p, v), `${p}: ${v}`);
	for (const [p, v] of [["border", "1px solid var(--line)"], ["border-left", "0"], ["border-inline", "0"], ["border-width", "1px"], ["border-color", "var(--line)"], ["box-shadow", "inset 0 0 0 1px var(--c)"], ["box-shadow", "0 18px 40px #000, inset 0 0 0 999px rgb(0 0 0 / 4%)"]] as const) assert.equal(sided(p, v), undefined, `${p}: ${v}`);
});
