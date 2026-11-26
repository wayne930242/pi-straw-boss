import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { THEME } from "../gui/view.ts";
import { contrast, declarations, mix, type Rule, rulesOf } from "./css-rules.ts";

// Storybook's palette (gui/themes/storybook/storybook.css, docs/specs/2026-11-26-storybook-theme/spec.md §B3 and design.md *Palette*): the first light theme. Two token blocks, the day (`[data-view="storybook"]`) and the night
// (`[data-view="storybook"][data-phase="night"]`), and in each every text colour at least 4.5 : 1 on every surface, the state colours used as text included, text on a state's wash, the ink on a state's fill, and every border and the
// hand-drawn line at least 3 : 1. No browser runs here: the blocks are parsed and the arithmetic done on their values.
const css = readFileSync(new URL("../gui/themes/storybook/storybook.css", import.meta.url), "utf8");
const rules = rulesOf(css), entry = rulesOf(readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"));
const must = <T>(value: T | undefined, what: string): T => (assert.ok(value, what), value as T);
const BLOCKS = { day: '[data-view="storybook"]', night: '[data-view="storybook"][data-phase="night"]' } as const;
const blockOf = (phase: keyof typeof BLOCKS) => must(rules.find((r) => r.selector === BLOCKS[phase]), `the ${phase} token block exists`);
const colours = (rule: Rule) =>
	Object.fromEntries(declarations(rule.body).filter(([p, v]) => p.startsWith("--") && /^#[0-9a-f]{6}$/i.test(v)).map(([p, v]) => [p.slice(2), v.toLowerCase()])) as Record<string, string>;
const root = colours(must(entry.find((r) => r.selector === ":root"), "Standard's palette"));
const rgba = (body: string, name: string) => {
	const m = must(new RegExp(`--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`).exec(body) ?? undefined, `--${name} is an rgba()`);
	return { colour: `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`, alpha: Number(m[4]) };
};

const SURFACES = ["bg", "bg-2", "surface-0", "surface-1", "raised", "sunken", "plate", "plate-hi"];
const STATES = ["accent", "working", "gold", "amber", "ok", "err", "err-soft", "violet", "idle", "unknown"];
const TEXT = ["text", "dim", "accent-hi", ...STATES];
const MIN = 4.5;
/** The share a state's wash may take under text: Storybook washes a card at up to 14 percent (storybook.css), Standard mixes up to 22. */
const TINT_MAX = 22;

for (const phase of ["day", "night"] as const) {
	const block = blockOf(phase), c = colours(block);
	/** The translucent page (--panel) over the ground: what a base, the header, and a sheet stand on. */
	const panel = () => {
		const p = rgba(block.body, "panel");
		return mix(p.colour, p.alpha, c.bg!);
	};
	// PIL, RGB extrema by WCAG luminance over all 1280 × 721 shipped pixels. Pin the sample to its file.
	test(`${phase}: notebook text keeps 4.5 : 1 over both extremes of the illustration`, () => {
		const [hash, dark, light] = phase === "day" ? ["68401246086bf79f", "#150600", "#ffffe6"] as const : ["cff03671de253b73", "#140a00", "#fff6a1"] as const;
		const file = readFileSync(new URL(`../gui/themes/storybook/backdrop-${phase}.webp`, import.meta.url));
		assert.ok(file.length <= 100_000);
		assert.equal(createHash("sha256").update(file).digest("hex").slice(0, 16), hash, "resample the shipped picture");
		const veil = rgba(block.body, "panel");
		for (const pixel of [dark, light]) for (const text of TEXT) assert.ok(contrast(c[text]!, mix(veil.colour, veil.alpha, pixel)) >= MIN, `--${text} on veiled ${pixel}`);
	});
	const grounds = () => [...SURFACES.map((s) => c[s]!), panel()];

	test(`${phase}: the block gives every colour token of Standard's palette a value, color-scheme ${phase === "day" ? "light" : "dark"}, and its ground is the theme-color`, () => {
		for (const name of Object.keys(root)) assert.ok(c[name], `--${name} is set in the ${phase} block`);
		for (const name of ["panel", "well", "line"]) assert.ok(declarations(block.body).some(([p]) => p === `--${name}`), `--${name} is set`);
		assert.ok(declarations(block.body).some(([p, v]) => p === "color-scheme" && v === (phase === "day" ? "light" : "dark")));
		assert.equal(c.bg, (THEME.storybook as Record<string, string>)[phase], "gui/view.ts THEME.storybook");
	});

	test(`${phase}: every text token is at least 4.5 : 1 on every surface, the page's translucent panel included`, () => {
		for (const text of TEXT) for (const ground of grounds()) assert.ok(contrast(c[text]!, ground) >= MIN, `--${text} ${c[text]} on ${ground}: ${contrast(c[text]!, ground).toFixed(2)}`);
	});

	test(`${phase}: the ink on a state's fill (a badge, Go, Send) and on the send stamp is at least 4.5 : 1, and the paper's ink on the paper`, () => {
		for (const fill of [...STATES, "send"]) assert.ok(contrast(c.ink!, c[fill]!) >= MIN, `--ink on --${fill}: ${contrast(c.ink!, c[fill]!).toFixed(2)}`);
		for (const paper of ["paper-hi", "paper"]) assert.ok(contrast(c["paper-ink"]!, c[paper]!) >= MIN, `--paper-ink on --${paper}`);
	});

	test(`${phase}: text keeps 4.5 : 1 on a state's wash of up to ${TINT_MAX} percent over each card surface`, () => {
		for (const tint of STATES) for (const surface of ["bg", "surface-0", "surface-1"]) {
			const under = mix(c[tint]!, TINT_MAX / 100, c[surface]!);
			for (const text of ["text", "dim"]) assert.ok(contrast(c[text]!, under) >= MIN, `--${text} on ${TINT_MAX}% --${tint} over --${surface} (${under}): ${contrast(c[text]!, under).toFixed(2)}`);
			// the state's own word on its wash (a waiting chip, an error note)
			assert.ok(contrast(c[tint]!, mix(c[tint]!, 0.14, c[surface]!)) >= MIN, `--${tint} on its 14% wash over --${surface}: ${contrast(c[tint]!, mix(c[tint]!, 0.14, c[surface]!)).toFixed(2)}`);
		}
	});

	test(`${phase}: every border, the hand-drawn line, and the focus ring are at least 3 : 1 on every surface`, () => {
		const stroke = must(/--sb-frame:[^;]*?stroke%3D'%23([0-9a-f]{6})'/i.exec(block.body)?.[1] ?? /--sb-frame:[^;]*?stroke='(?:%23|#)([0-9a-f]{6})'/i.exec(block.body)?.[1], "the frame's stroke colour");
		for (const ground of grounds()) {
			assert.ok(contrast(c["line-c"]!, ground) >= 3, `--line-c on ${ground}: ${contrast(c["line-c"]!, ground).toFixed(2)}`);
			assert.ok(contrast(`#${stroke}`, ground) >= 3, `the hand-drawn line #${stroke} on ${ground}: ${contrast(`#${stroke}`, ground).toFixed(2)}`);
			assert.ok(contrast(c.accent!, ground) >= 3, `the focus ring on ${ground}`);
		}
	});

	test(`${phase}: the terminal keeps a dark well with its own light text`, () => {
		assert.ok(contrast(c["term-fg"]!, c["term-bg"]!) >= 7, `--term-fg on --term-bg: ${contrast(c["term-fg"]!, c["term-bg"]!).toFixed(2)}`);
		assert.ok(contrast("#ffffff", c["term-bg"]!) > 10, "the well is dark in both phases");
	});
}

test("the semantic colours are the spec's: deep plum ink on cream by day, moon-cream on the night sky, honey or lamp gold for waiting, berry for errors, leaf green for working", () => {
	const day = colours(blockOf("day")), night = colours(blockOf("night"));
	const hue = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
		const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
		return d === 0 ? 0 : (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
	};
	assert.ok(contrast(day.text!, day.bg!) >= 10 && contrast(night.text!, night.bg!) >= 10, "the body text is the strongest");
	for (const c of [day, night]) {
		assert.ok(hue(c.amber!) > 25 && hue(c.amber!) < 50, `waiting is honey or lamp gold (${hue(c.amber!).toFixed(0)}°)`);
		assert.ok(hue(c.err!) < 15 || hue(c.err!) > 345, `error is berry red (${hue(c.err!).toFixed(0)}°)`);
		assert.ok(hue(c.working!) > 100 && hue(c.working!) < 170, `working is leaf green (${hue(c.working!).toFixed(0)}°)`);
	}
	assert.ok(hue(night.bg!) > 210 && hue(night.bg!) < 240, "the night is a deep blue sky");
});

test("night cards stand apart from the navy ground (the review's P2): the card surfaces are grey-violet, a step off the sky", () => {
	const night = colours(blockOf("night"));
	for (const s of ["surface-0", "surface-1"]) assert.ok(contrast(night[s]!, night.bg!) >= 1.25, `--${s} against the sky: ${contrast(night[s]!, night.bg!).toFixed(2)}`);
});
