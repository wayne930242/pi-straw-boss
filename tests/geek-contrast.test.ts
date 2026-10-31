import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrast, declarations, mix, type Rule, rulesOf, split } from "./css-rules.ts";

// The Geek view's palette (gui/style.css, the `[data-view="geek"]` block) must hold WCAG AAA for text (7 : 1) on every surface, and 3 : 1 for borders
// (non-text), including text on a state tint as the CSS mixes it. No browser runs here: the block is parsed and the arithmetic done on its values.
const GEEK = '[data-view="geek"]';
const rules = rulesOf(readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"));
const must = <T>(value: T | undefined, what: string): T => (assert.ok(value, what), value as T);
const block = must(rules.find((r) => r.selector === GEEK), "the Geek token block exists");
const root = must(rules.find((r) => r.selector === ":root"), "the palette block exists");
const colours = (rule: Rule) =>
	Object.fromEntries(declarations(rule.body).filter(([p, v]) => p.startsWith("--") && /^#[0-9a-f]{6}$/i.test(v)).map(([p, v]) => [p.slice(2), v.toLowerCase()])) as Record<string, string>;
const geek = colours(block);

const SURFACES = ["bg", "bg-2", "surface-0", "surface-1", "raised", "sunken", "plate", "plate-hi", "panel", "well", "term-bg"];
const STATES = ["accent", "working", "gold", "amber", "ok", "err", "err-soft", "violet", "idle", "unknown"];
const TEXT = ["text", "dim", "accent-hi", "term-fg", ...STATES];
/** The share a state tint may take: the contrast below holds at it, so it holds under it. A white veil (--hi) is a lighter tint: 8. */
const TINT_MAX = 12;
const capOf = (tint: string) => (tint === "hi" ? 8 : TINT_MAX);
const geekOnly = (r: Rule) => r.parts.every((p) => p.includes(GEEK));
/** A selector part with each `:is(a, b)` written out as the parts it stands for, so `[data-view="geek"] :is(.x, .y)` is found as `[data-view="geek"] .x`. */
const expand = (part: string): string[] => {
	const at = part.indexOf(":is(");
	if (at < 0) return [part];
	let depth = 0, end = at + 3;
	for (; end < part.length; end++) if ((depth += part[end] === "(" ? 1 : part[end] === ")" ? -1 : 0) === 0) break;
	return split(part.slice(at + 4, end), ",").flatMap((alt) => expand(`${part.slice(0, at)}${alt.trim()}${part.slice(end + 1)}`));
};

test("the Geek block gives every colour token of the palette its own value", () => {
	for (const name of Object.keys(colours(root))) assert.ok(geek[name], `--${name} is set in the Geek block`);
	for (const name of ["panel", "well", "line"]) assert.ok(declarations(block.body).some(([p]) => p === `--${name}`), `--${name} is set (a translucent value is solid here)`);
});

test("every text token is at least 7 : 1 on every surface", () => {
	for (const text of TEXT) for (const surface of SURFACES) assert.ok(contrast(geek[text]!, geek[surface]!) >= 7, `--${text} ${geek[text]} on --${surface} ${geek[surface]}: ${contrast(geek[text]!, geek[surface]!).toFixed(2)}`);
});

test("the ink on a state's fill (a badge, Go, Send) is at least 7 : 1, and the paper's ink on the paper", () => {
	for (const state of STATES) assert.ok(contrast(geek.ink!, geek[state]!) >= 7, `--ink on --${state}: ${contrast(geek.ink!, geek[state]!).toFixed(2)}`);
	for (const paper of ["paper-hi", "paper"]) assert.ok(contrast(geek["paper-ink"]!, geek[paper]!) >= 7, `--paper-ink on --${paper}`);
});

test("every border and ring is at least 3 : 1 on every surface", () => {
	for (const line of ["line", "line-c"]) for (const surface of SURFACES) assert.ok(contrast(geek[line]!, geek[surface]!) >= 3, `--${line} on --${surface}: ${contrast(geek[line]!, geek[surface]!).toFixed(2)}`);
	assert.ok(contrast(geek.accent!, geek.bg!) >= 3, "the focus ring (--accent)");
});

test("text keeps 7 : 1 on a state tint of up to TINT_MAX percent (a white veil, 8), over each of the cards' surfaces", () => {
	for (const tint of [...STATES, "hi"]) for (const surface of ["bg", "surface-0", "surface-1"]) {
		const under = mix(geek[tint]!, capOf(tint) / 100, geek[surface]!);
		for (const text of ["text", "dim", ...STATES]) assert.ok(contrast(geek[text]!, under) >= 7, `--${text} on ${capOf(tint)}% of --${tint} over --${surface} (${under}): ${contrast(geek[text]!, under).toFixed(2)}`);
	}
	const marked = rules.find((r) => r.parts.includes(`${GEEK} [data-mark]`));
	const c1 = must(declarations(`${block.body};${marked?.body ?? ""}`).find(([p]) => p === "--c1"), "--c1 (a state's tint) is set for the Geek view");
	assert.ok(Number(/var\(--c\) ([\d.]+)%/.exec(c1[1])?.[1]) <= TINT_MAX, c1[1]);
});

test("a background tint above TINT_MAX in the sheet is replaced by a Geek rule of the same selector, or is no text's ground", () => {
	const NO_TEXT = new Set([".sweep", ".mm-in i", ".plate", ".tower::before", ".lit::after", ".ring"]);
	const over: string[] = [];
	for (const rule of rules.filter((r) => !geekOnly(r) && !r.parts.every((p) => NO_TEXT.has(p)))) {
		for (const [prop, value] of declarations(rule.body)) {
			if (!/^background(-color|-image)?$/.test(prop) && prop !== "--c1") continue;
			const big = [...value.matchAll(/color-mix\(in srgb,\s*var\(--([\w-]+)\)\s+([\d.]+)%/g)].filter(([, name, p]) => [...STATES, "hi", "c"].includes(name!) && Number(p) > capOf(name!));
			if (!big.length) continue;
			const replaced = rule.parts.every((part) => rules.some((g) => geekOnly(g) && g.parts.flatMap(expand).some((gp) => gp.endsWith(` ${part}`) || gp === `${GEEK} ${part}`) && declarations(g.body).some(([p]) => p === prop || p === "background")));
			if (!replaced) over.push(`${rule.selector} { ${prop}: ${big.map((b) => b[0]).join(", ")} }`);
		}
	}
	assert.deepEqual(over, []);
});

test("the Geek view draws no coloured or one-sided border, and no motion, glow or gradient survives its rules", () => {
	const mine = rules.filter(geekOnly);
	assert.ok(mine.length > 10, "the Geek rules exist");
	for (const rule of mine) for (const [prop, value] of declarations(rule.body)) {
		const sided = /^border-(top|right|bottom|left|inline|block)(-\w+)*$/.test(prop);
		if (sided && !(prop.endsWith("-width") && /^(0|1px)$/.test(value)) && !/^(0|none)$/.test(value)) assert.fail(`${rule.selector}: one-sided ${prop}: ${value}`);
		if (/^border(-color)?$/.test(prop) && /(#|rgb|var\(--(?!line\b|text\b))/.test(value)) assert.fail(`${rule.selector}: ${prop}: ${value} is not the plain line`);
	}
	const text = mine.map((r) => `${r.selector} { ${r.body} }`).join("\n");
	assert.match(text, /animation:\s*none\s*!important/);
	assert.match(text, /transition:\s*none\s*!important/);
	assert.match(text, /box-shadow:\s*none\s*!important/);
});

test("each state has a text tag before the unit's name in the Geek view, so the state reads without colour", () => {
	const tags = Object.fromEntries(
		rules.filter((r) => geekOnly(r) && /^\[data-view="geek"\] \[data-mark="(\w+)"\]$/.test(r.selector)).map((r) => [/data-mark="(\w+)"/.exec(r.selector)![1]!, /--tag:\s*"([^"]*)"/.exec(r.body)?.[1]]),
	);
	assert.deepEqual(tags, { working: "[WORK]", waiting: "[WAIT?]", commanding: "[CMD◈]", idle: "[IDLE]", done: "[DONE✓]", error: "[ERR!]", unknown: "[UNKN]" });
	const name = rules.find((r) => geekOnly(r) && r.parts.some((p) => p.endsWith(".name::before")));
	assert.ok(name && /content:\s*var\(--tag\)/.test(name.body), "the tag is the name's ::before");
});

test("a forced-colors block keeps the state shapes and leaves the QR and the terminal their own colours", () => {
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
	const at = css.indexOf("@media (forced-colors: active)");
	assert.ok(at > 0, "the forced-colors block exists");
	const forced = css.slice(at);
	assert.match(forced, /\.badge[^{}]*\{[^}]*border:\s*1px solid/);
	assert.match(forced, /\.qr[^{}]*\{[^}]*forced-color-adjust:\s*none/);
	assert.match(forced, /\.term-scroll[^{}]*\{[^}]*forced-color-adjust:\s*none/);
});
