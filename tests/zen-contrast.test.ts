import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrast, declarations, mix, rulesOf } from "./css-rules.ts";

// The Zen ink palette (gui/zen.css, the token block) holds 7 : 1 for text and 3 : 1 for borders and the focus ring on the grounds and on the lofi surfaces the answer card and composer use,
// computed from the values in the stylesheet. No browser runs here.
const css = readFileSync(new URL("../gui/zen.css", import.meta.url), "utf8"), first = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
const block = rulesOf(css).find((r) => r.parts.includes('[data-view="zen"] :is(#zen, .connect)'));
assert.ok(block, "the token block exists");
const tokens = Object.fromEntries(declarations(block.body).filter(([p, v]) => p.startsWith("--zen-") && /^#[0-9a-f]{6}$/i.test(v)).map(([p, v]) => [p.slice(6), v.toLowerCase()])) as Record<string, string>;
const TEXT = ["paper", "ash", "clay"];

test("every text colour is at least 7 : 1 on both grounds, the card's surfaces, and the Send fill (paper on warm)", () => {
	for (const t of TEXT) for (const g of ["ground", "ground-2", "soft", "sunken"]) assert.ok(contrast(tokens[t]!, tokens[g]!) >= 7, `--zen-${t} on --zen-${g}: ${contrast(tokens[t]!, tokens[g]!).toFixed(2)}`);
	assert.ok(contrast(tokens.paper!, tokens.warm!) >= 7, "Send's paper on its warm fill");
	assert.ok(contrast(tokens.paper!, tokens["warm-hi"]!) >= 7, "and on its hover");
	assert.ok(contrast(tokens.moss!, tokens.ground!) >= 3 && contrast(tokens.moss!, tokens["ground-2"]!) >= 3);
});

test("every border and the focus ring is at least 3 : 1 on the grounds and the card's surfaces; the ring's mark stays out of body text", () => {
	for (const b of ["line", "seal"]) for (const g of ["ground", "ground-2", "soft", "sunken"]) assert.ok(contrast(tokens[b]!, tokens[g]!) >= 3, `--zen-${b} on --zen-${g}: ${contrast(tokens[b]!, tokens[g]!).toFixed(2)}`);
	assert.ok(contrast(tokens.line!, tokens.warm!) >= 1.5, "the picked option's border is a hairline on its fill");
	assert.ok(contrast(tokens.paper!, tokens.warm!) >= 7, "and its text is the paper");
	assert.ok(!css.split("\n").some((l) => /(?:^|[\s;{])color: var\(--zen-seal\)/.test(l)), "--zen-seal is never a text colour (a border or a line under a word may be seal)");
});

test("the first frame's ring (style.css) is 3 : 1 on the ground, and the sheet only animates transform, opacity, filter, and the head lines' --fade", () => {
	const ring = /#zen:empty:not\(\[hidden\]\)::after \{[^}]*border: 1px solid (#[0-9a-f]{6})/.exec(first)?.[1];
	assert.ok(ring, "the first-frame ring exists");
	assert.ok(contrast(ring, "#14110e") >= 3);
	for (const [name, source] of [["zen.css", css], ["style.css", first]] as const)
		for (const [, body] of source.matchAll(/@keyframes zen-[\w-]+ \{((?:[^{}]|\{[^}]*\})*)\}/g))
			for (const [, steps] of body!.matchAll(/\{([^}]*)\}/g)) for (const [prop] of declarations(steps!)) assert.ok(["transform", "opacity", "filter", "animation-timing-function", "--fade"].includes(prop), `${name}: a zen keyframe moves ${prop}`);
});

test("text on a coloured fill (`--ink`) is the ground, never the paper: Standard's fills (the confirm's Send Enter, Send, a badge) are paper or ash in Zen and a paper label on them was blank", () => {
	assert.match(block.body, /--ink: var\(--zen-ground\)/);
	for (const fill of ["paper", "ash", "clay", "moss"]) assert.ok(contrast(tokens.ground!, tokens[fill]!) >= 7, `--zen-ground on --zen-${fill}: ${contrast(tokens.ground!, tokens[fill]!).toFixed(2)}`);
	const pair = rulesOf(css).filter((r) => r.parts.some((p) => p.includes(".pad-yes") && p.includes(".pad-no")));
	assert.ok(pair.length, "the confirm's two buttons share one Zen rule");
	const box = declarations(pair[0]!.body);
	assert.ok(box.some(([p, v]) => p === "min-height" && v === "44px"), "a 44 px target");
	assert.ok(box.some(([p, v]) => p === "color" && v === "var(--zen-paper)"), "paper words");
	// The visual language (Z-D15): the pair is two words of one style, the one that sends in paper and the other in ash; neither is filled, so no label sits on a fill.
	assert.match(css, /\.zen-term-host :is\(\.pad-yes, \.tcard-go\) \{ border-color: transparent; background: transparent; color: var\(--zen-paper\);/, "the one that sends is the paper word");
	assert.match(css, /\.zen-term-host :is\(\.pad-no, \.tcard-mask\) \{ border-color: transparent; background: transparent; color: var\(--zen-ash\); \}/, "the other the ash word");
});

// Yellow in Zen: the ink palette has none. Standard's amber and gold are paper and ash here (the token block), and the terminal mirror's yellows (ANSI 33 and 93 as classes, 256-colour and truecolor inline) are an ochre and muted as a whole.
const hsv = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number], max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
	const h = d === 0 ? 0 : (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
	return { h, s: max === 0 ? 0 : d / max, v: max };
};
const MUTED = 0.5; // a Zen colour in the yellow hues (35° to 70°) is at most this saturated (HSV)
const literals = (text: string) => [...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)].map((m) => ("#" + (m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join("") : m[1]!)).toLowerCase());

test("no colour literal in the Zen sheet is a bright yellow, and the first frame's literals are not either", () => {
	for (const [name, text] of [["zen.css", css], ["style.css first frame", first.split("\n").filter((l) => /data-view="zen"|#zen/.test(l)).join("\n")]] as const)
		for (const hex of literals(text)) {
			const { h, s } = hsv(hex);
			assert.ok(!(h >= 35 && h <= 70 && s > MUTED), `${name}: ${hex} is a yellow (hue ${h.toFixed(0)}°, saturation ${s.toFixed(2)})`);
		}
	for (const token of ["--gold", "--amber", "--paper", "--paper-hi", "--paper-edge", "--accent", "--accent-hi"]) assert.match(block.body, new RegExp(`${token}: var\\(--zen-`), `${token} is an ink token in Zen`);
});

test("the terminal's yellows in Zen are the ochre pair, readable (7 : 1 on the sunken ground), and the mirror's rows are muted as a whole", () => {
	const host = '[data-view="zen"] .zen-term-host';
	const palette = Object.fromEntries(declarations(block.body));
	for (const [n, token] of [[3, "ochre"], [11, "ochre-hi"]] as const) {
		const cls = `.c${n}`, ansi = `--ansi-${n}`;
		const ochre = tokens[token];
		assert.ok(ochre, `--zen-${token} is a token`);
		assert.equal(palette[ansi], `var(--zen-${token})`);
		for (const [selector, prop] of [[cls, "color"], [`.k${n}`, "background"]]) {
			const rule = rulesOf(first).find(r => r.selector === selector);
			assert.ok(rule && declarations(rule.body).some(([p, v]) => p === prop && v === `var(${ansi})`), `${selector} takes Zen's ochre`);
		}
		assert.ok(hsv(ochre).s <= MUTED, `${ochre} is muted`);
		assert.ok(contrast(ochre, tokens.sunken!) >= 7, `${cls} on --zen-sunken: ${contrast(ochre, tokens.sunken!).toFixed(2)}`);
		assert.ok(contrast(tokens.sunken!, ochre) >= 7, `the sunken ground as text on the ${cls} fill`);
	}
	const mute = rulesOf(css).find((r) => r.parts.includes(`${host} .term`));
	const sat = declarations(mute?.body ?? "").find(([p]) => p === "filter")?.[1].match(/^saturate\(([\d.]+)\)$/)?.[1];
	assert.ok(sat && Number(sat) <= 0.5, `the mirror's rows are desaturated (filter: ${sat})`);
	assert.ok(!/\.c(3|11)\b|\.k(3|11)\b/.test(first.split("\n").filter((l) => /data-view="zen"/.test(l)).join("\n")), "Standard's own classes are not touched from style.css");
});

// The head tower's strip (docs/specs/2026-11-04-head-tower.md, Zen: the strip under the circle). At clear every line is read at 7 : 1; the rest level is below that on purpose, so it is decoration and never the only way
// to read a line: hover, focus, a tap, the history, and the live region give it whole, and forced colours never fade it.
test("the strip's lines are 7 : 1 at every clear level, paper for the head and ash for the boss; the rest level is below that and is not the only way to read a line", async () => {
	const { CLEAR, REST } = await import("../gui/headlines.ts");
	for (const level of CLEAR) for (const ink of ["paper", "ash"]) for (const ground of ["ground", "ground-2"]) {
		const c = contrast(mix(tokens[ink]!, level, tokens[ground]!), tokens[ground]!);
		assert.ok(c >= 7, `--zen-${ink} at ${level} on --zen-${ground}: ${c.toFixed(2)}`);
	}
	for (const ink of ["paper", "ash"]) assert.ok(contrast(mix(tokens[ink]!, REST, tokens.ground!), tokens.ground!) < 7, `the rest level (${REST}) of --zen-${ink} is decoration`);
});

test("the strip's CSS carries the same numbers: the fade ends at the rest level over 3 minutes after 20 s, ranks step the clear level, and hover, focus, a tap, a held line, and forced colours put every line at 1", async () => {
	const { CLEAR, CLEAR_MS, FADE_MS, REST } = await import("../gui/headlines.ts");
	const fade = /@keyframes zen-head-fade \{\s*to \{ --fade: ([\d.]+); \}\s*\}/.exec(css);
	assert.equal(Number(fade?.[1]), REST, "the keyframes end at the rest level (of --fade: the animation never touches the opacity a hover lifts)");
	const line = rulesOf(css).find((r) => r.parts.includes('[data-view="zen"] .zen-hl'));
	assert.ok(line, "the line's rule");
	const d = declarations(line.body);
	assert.match(d.find(([p]) => p === "animation")![1], new RegExp(`zen-head-fade ${FADE_MS / 1000}s linear both`));
	assert.equal(d.find(([p]) => p === "animation-delay")![1], `${CLEAR_MS / 1000}s`, "clear for 20 s before the fade starts");
	assert.equal(d.find(([p]) => p === "--fade")![1], "var(--clear)", "the fade starts at the rank's clear level");
	assert.equal(d.find(([p]) => p === "--lift")![1], "0", "nothing lifts the line at rest");
	assert.equal(d.find(([p]) => p === "opacity")![1], "calc(var(--fade) + (1 - var(--fade)) * var(--lift))", "a line's opacity is its fade lifted towards 1 by --lift");
	CLEAR.forEach((level, rank) => {
		const r = rulesOf(css).find((x) => x.parts.includes(`[data-view="zen"] .zen-hl[data-rank="${rank}"]`));
		assert.equal(declarations(r!.body).find(([p]) => p === "--clear")?.[1], String(level), `rank ${rank}`);
	});
	const bright = rulesOf(css).find((r) => r.parts.some((p) => p.includes(".zen-head:is([data-bright], :hover, :focus-within) .zen-hl")));
	assert.ok(bright, "hover, focus, and a tap");
	assert.deepEqual(declarations(bright.body), [["--lift", "1"]], "they lift the line to 1 and touch nothing else: the animation (the fade's clock) keeps running");
	const held = rulesOf(css).find((r) => r.parts.includes('[data-view="zen"] .zen-hl[data-held]'));
	assert.deepEqual(declarations(held!.body), [["--lift", "1"]], "a held line stays clear");
	const forced = css.slice(css.indexOf("@media (forced-colors: active)", css.indexOf(".zen-hl")));
	assert.match(forced, /\.zen-hl \{[^}]*animation: none; opacity: 1;/, "forced colours: never faded");
	assert.match(forced, /\.zen-head-hint \{[^}]*border-bottom-color: CanvasText/, "the hairline is a CanvasText border");
});

test("the strip has no boxes: its hairline and box are a transparent border with one line under them (never `border: none`), and the input is a 44 px target", () => {
	const mine = rulesOf(css).filter((r) => r.parts.some((p) => /\.zen-(head|hl)/.test(p)));
	assert.ok(mine.length > 8, "the strip has its rules");
	for (const r of mine) for (const [p, v] of declarations(r.body)) {
		assert.ok(!(p === "border" && v === "none"), `${r.selector}: border: none`);
		assert.ok(!/background(-color)?$/.test(p) || /^(transparent|none)$/.test(v) || /--zen-(glow|tint)/.test(v), `${r.selector}: ${p}: ${v} is a ground for a box`);
	}
	for (const cls of [".zen-head-hint", ".zen-head-history", ".zen-rest"]) {
		const rs = rulesOf(css).filter((x) => x.parts.some((p) => p.includes(cls)));
		assert.ok(rs.some((r) => declarations(r.body).some(([p, v]) => p === "min-height" && v === "44px")), `${cls}: 44 px`);
	}
	assert.ok(!css.split("\n").some((l) => /\.zen-(head|hl)/.test(l) && /color: var\(--zen-seal\)/.test(l) && !/text-decoration|border-bottom-color/.test(l)), "the seal marks only a line under a word, never a text colour");
});

test("ZF (docs/specs/2026-11-24-zen-f.md §8.7): the quiet live text and the target list's state word are --zen-ash, which holds 7 : 1 on both grounds, and nothing of either is in the seal", () => {
	const of = (sel: string) => rulesOf(css).filter((r) => r.parts.some((p) => p.endsWith(sel))).flatMap((r) => declarations(r.body)).filter(([p]) => p === "color").map(([, v]) => v);
	for (const [sel, name] of [[".tx.live-quiet .live-text", "the quiet live text"], [".target-state", "the state word"]] as const) {
		assert.ok(of(sel).includes("var(--zen-ash)"), `${name} is ash`);
		for (const g of ["ground", "ground-2"]) assert.ok(contrast(tokens.ash!, tokens[g]!) >= 7, `${name} on --zen-${g}`);
	}
});
