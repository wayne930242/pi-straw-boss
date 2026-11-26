import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { contrast, declarations, mix, type Rule, rulesOf } from "./css-rules.ts";

// Raven Keep's palette (gui/themes/raven/raven.css, the `[data-view="raven"]` block; docs/specs/2026-11-07-raven-view/spec.md §1.5): dark only, and every text colour at least 4.5 : 1 on every surface it can sit on,
// every border and the focus ring at least 3 : 1, including text on a state tint as the CSS mixes it. No browser runs here: the block is parsed and the arithmetic done on its values.
const RAVEN = '[data-view="raven"]';
const rules = rulesOf(readFileSync(new URL("../gui/themes/raven/raven.css", import.meta.url), "utf8")), entryRules = rulesOf(readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"));
const must = <T>(value: T | undefined, what: string): T => (assert.ok(value, what), value as T);
const block = must(rules.find((r) => r.selector === RAVEN), "the raven token block exists");
const root = must(entryRules.find((r) => r.selector === ":root"), "the palette block exists");
const colours = (rule: Rule) =>
	Object.fromEntries(declarations(rule.body).filter(([p, v]) => p.startsWith("--") && /^#[0-9a-f]{6}$/i.test(v)).map(([p, v]) => [p.slice(2), v.toLowerCase()])) as Record<string, string>;
const raven = colours(block);

const SURFACES = ["bg", "bg-2", "surface-0", "surface-1", "raised", "sunken", "plate", "plate-hi", "term-bg"]; // --panel and --well are translucent: they sit over these;
const STATES = ["accent", "working", "gold", "amber", "ok", "err", "err-soft", "violet", "idle", "unknown"];
const TEXT = ["text", "dim", "accent-hi", "term-fg", ...STATES];
const MIN = 4.5;
/** The share a state tint may take: the contrast below holds at it, so it holds under it (style.css mixes a state at up to 22 percent; the card's own tint is `--c1`). */
const TINT_MAX = 22;

test("the raven block gives every colour token of the palette its own value, and is dark", () => {
	// The optional terminal palette is inherited (§4.1).
	for (const name of Object.keys(colours(root)).filter(n => !/^ansi-(?:\d|1[0-5])$/.test(n))) assert.ok(raven[name], `--${name} is set in the raven block`);
	for (const name of ["panel", "well", "line"]) assert.ok(declarations(block.body).some(([p]) => p === `--${name}`), `--${name} is set`);
	assert.ok(declarations(block.body).some(([p, v]) => p === "color-scheme" && v === "dark"), "color-scheme: dark");
	assert.equal(raven.bg, "#0d0a10", "the ground is the theme-color (gui/view.ts THEME.raven)");
});

test("every text token is at least 4.5 : 1 on every surface", () => {
	for (const text of TEXT) for (const surface of SURFACES) assert.ok(contrast(raven[text]!, raven[surface]!) >= MIN, `--${text} ${raven[text]} on --${surface} ${raven[surface]}: ${contrast(raven[text]!, raven[surface]!).toFixed(2)}`);
});

test("the ink on a state's fill (a badge, Go, Send) is at least 4.5 : 1, and the paper's ink on the paper", () => {
	for (const state of STATES) assert.ok(contrast(raven.ink!, raven[state]!) >= MIN, `--ink on --${state}: ${contrast(raven.ink!, raven[state]!).toFixed(2)}`);
	for (const paper of ["paper-hi", "paper"]) assert.ok(contrast(raven["paper-ink"]!, raven[paper]!) >= MIN, `--paper-ink on --${paper}`);
});

test("every border and ring is at least 3 : 1 on every surface", () => {
	for (const surface of SURFACES) assert.ok(contrast(raven["line-c"]!, raven[surface]!) >= 3, `--line-c on --${surface}: ${contrast(raven["line-c"]!, raven[surface]!).toFixed(2)}`);
	assert.ok(contrast(raven.accent!, raven.bg!) >= 3, "the focus ring (--accent)");
});

test("text keeps 4.5 : 1 on a state tint of up to TINT_MAX percent over each of the cards' surfaces", () => {
	for (const tint of STATES) for (const surface of ["bg", "surface-0", "surface-1"]) {
		const under = mix(raven[tint]!, TINT_MAX / 100, raven[surface]!);
		for (const text of ["text", "dim"]) assert.ok(contrast(raven[text]!, under) >= MIN, `--${text} on ${TINT_MAX}% of --${tint} over --${surface} (${under}): ${contrast(raven[text]!, under).toFixed(2)}`);
	}
});

test("the semantic colours are the ones the spec names: bone text, candle gold for waiting, blood crimson for errors, fog grey for idle, on a violet-cast near-black", () => {
	const hue = (hex: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
		const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
		return d === 0 ? 0 : (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
	};
	assert.ok(hue(raven.bg!) > 240 && hue(raven.bg!) < 300, `the ground has a cold violet cast (${hue(raven.bg!).toFixed(0)}°)`);
	assert.ok(hue(raven.gold!) > 30 && hue(raven.gold!) < 50, "candle gold");
	assert.ok(hue(raven.err!) < 10 || hue(raven.err!) > 350, "blood crimson");
	assert.ok(contrast(raven.text!, raven.bg!) >= 10, "bone text is the brightest, the page's body");
});

test("nothing in the raven rules hides the page's text under the backdrop: every panel keeps a translucent solid ground", () => {
	assert.match(block.body, /--well:\s*rgba\(/);
});

test("the head band's text holds 4.5 : 1 on the band as Raven Keep paints it: the name and the newest line on its gold wash over --surface-0, the waits chip's amber on its 16% amber wash (docs/specs/2026-11-07-head-band.md)", () => {
	const band = must(rules.find((r) => r.selector === `${RAVEN} .head-node`), "the keep's band rule");
	const bg = must(declarations(band.body).find(([p]) => p === "background")?.[1], "the band's background");
	const gold = Number(must(/color-mix\(in srgb, var\(--gold\) ([\d.]+)%/.exec(bg) ?? undefined, "the band's gold wash")[1]);
	assert.ok(bg.endsWith("var(--surface-0)"), `the wash sits on --surface-0: ${bg}`);
	const ground = mix(raven.gold!, gold / 100, raven["surface-0"]!);
	for (const text of ["text", "dim"]) for (const under of [ground, raven["surface-0"]!]) assert.ok(contrast(raven[text]!, under) >= MIN, `--${text} on the band (${under}): ${contrast(raven[text]!, under).toFixed(2)}`);
	const chip = must(entryRules.find((r) => r.selector === ".head-node .head-waits"), "the waits chip rule");
	const share = Number(must(/color-mix\(in srgb, var\(--amber\) ([\d.]+)%/.exec(declarations(chip.body).find(([p]) => p === "background")?.[1] ?? "") ?? undefined, "the chip's amber wash")[1]);
	const pill = mix(raven.amber!, share / 100, ground);
	assert.ok(contrast(raven.amber!, pill) >= MIN, `the chip's --amber on ${share}% of itself over the band (${pill}): ${contrast(raven.amber!, pill).toFixed(2)}`);
});

/** The map's picture layers that both samples below (the brightest lit pixel, and the same after the glass's blur) took, as CSS writes them. */
const SAMPLED_LAYERS = ["radial-gradient(ellipse calc(var(--rk-w) * 0.17) calc(var(--rk-w) * 0.1) at 16.4% 17%, rgb(13 10 16 / 0.62) 55%, transparent)", "linear-gradient(rgb(190 170 255 / 0.16), transparent 60%)", "linear-gradient(transparent 40%, rgb(3 2 5 / 0.3))", "linear-gradient(rgb(13 10 16 / 0.68), rgb(13 10 16 / 0.3) 45%, rgb(13 10 16 / 0.3))", "mask-image: linear-gradient(#000 62%, transparent)"];
// The map's backdrop (spec §1.5 "On the map"): the map has the picture behind a translucent ground, and the legend sits in the bar above it. At the brightest lightning frame the rest veil is gone and the picture shows through its plain veil, the strike's wash and foot veil, and the lit windows at their peak.
// The brightest pixel of that composite below the header strip (y from 80 of 721) was sampled with PIL at the picture's full 1280 x 721, the layers as CSS paints them (the mask included): rgb(179 154 129), a wall lit by a window at the peak of its glow. The layer values that sampling used are asserted first;
// a change to any of them (or to the picture) makes this test ask for a new sample instead of passing on old arithmetic.
test("under the brightest lightning frame the map's ground and the legend's keep --text and --dim at 4.5 : 1, and --panel does too", () => {
	const raw = readFileSync(new URL("../gui/themes/raven/raven.css", import.meta.url), "utf8");
	const sheet = rulesOf(raw), body = (selector: string) => sheet.filter((r) => r.parts.includes(selector)).map((r) => r.body).join(";");
	const MAP = 'html[data-view="raven"]:has(#stage[data-view="map"])', STAGE = 'html[data-view="raven"] .stage[data-view="map"]';
	const picture = body(`${MAP} [data-slot="backdrop"] > :nth-child(1)`);
	for (const layer of SAMPLED_LAYERS) assert.ok(picture.includes(layer), `the sampled layer is still there: ${layer}`);
	const alphas = [...body(`${MAP} [data-slot="backdrop"] > :nth-child(3)`).matchAll(/rgb\(255 190 92 \/ ([\d.]+)\)/g)].map((m) => Number(m[1]));
	assert.equal(alphas.length, 11, "eleven lit windows and lanterns");
	assert.ok(Math.max(...alphas) <= 0.7125 + 1e-9, `the lights' peak alpha is ${Math.max(...alphas)}; the sample took 0.7125`);
	assert.match(body(`${MAP} [data-slot="backdrop"] > :nth-child(3)`), /opacity:\s*0\.75/);
	const candle = [...(/@keyframes rk-candle \{(.*)\}\n/.exec(raw)?.[1] ?? "").matchAll(/opacity:\s*([\d.]+)/g)].map((m) => Number(m[1]));
	assert.ok(candle.length >= 4 && Math.max(...candle) <= 1, "the lights breathe at most to full");
	assert.match(raw, /@keyframes rk-rest \{.*94\.4% \{ opacity: 0; \}/, "the rest veil is gone at the flash");
	const worst = "#b39a81"; // rgb(179 154 129)
	const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
	const grounds = (token: string) => {
		const m = new RegExp(`--${token}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`).exec(raw);
		assert.ok(m, `--${token} is set`);
		return mix(`#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`, Number(m[4]), worst);
	};
	for (const token of ["rk-well", "panel"]) for (const text of ["text", "dim"]) assert.ok(contrast(raven[text]!, grounds(token)) >= MIN, `--${text} on --${token} over the brightest lit pixel (${grounds(token)}): ${contrast(raven[text]!, grounds(token)).toFixed(2)}`);
	// who takes the ground: the map and the legend (the cards, the band, and the buttons have grounds of their own)
	assert.match(body(`${STAGE} .map`), /background:\s*var\(--rk-well\)/);
	assert.match(body('html[data-view="raven"] .legend'), /background:\s*var\(--rk-well\)/);
});

const ROOMS = { tower: "room-study.webp", main: "room-hall.webp", subagent: "room-crypt.webp", other: "room-library.webp" } as const; // the chat page's rooms (tests/raven-rooms.test.ts)
const ravenCss = readFileSync(new URL("../gui/themes/raven/raven.css", import.meta.url), "utf8");
// The brightest pixel of each picture, sampled with PIL on the shipped file (RGB, max of the channel sum), and the file's hash: a new picture makes this test ask for a new sample instead of passing on old arithmetic.
// Text that sits on the page over a room has a ground of its own: the comms and the dossier take --well, the crumbs --rk-well. The worst case is that pixel under the veil's lightest alpha (the top), then the candle light at its peak, then the ground.
const SAMPLES: Record<keyof typeof ROOMS, { sha: string; worst: [number, number, number] }> = {
	tower: { sha: "e50c5f65157fe764", worst: [247, 245, 244] },
	main: { sha: "d81fa11c515221da", worst: [255, 255, 255] },
	subagent: { sha: "e8b69ac07429704b", worst: [255, 253, 239] },
	other: { sha: "61da59b3599a3852", worst: [255, 245, 200] },
};
test("under the lightest veil, the candle light at its peak, and the comms' or crumbs' ground, each room's brightest pixel still keeps --text and --dim at 4.5 : 1", () => {
	const token = (name: string) => {
		const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(ravenCss);
		assert.ok(m, `--${name}`);
		return m[1]!.toLowerCase();
	};
	const veil = /--rk-veil:\s*linear-gradient\(rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/.exec(ravenCss);
	assert.ok(veil, "the veil is a gradient of rgb()");
	const hex = (r: string, g: string, b: string) => `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
	const lightest = Number(veil[4]), veilColour = hex(veil[1]!, veil[2]!, veil[3]!);
	const peak = Math.max(...[...ravenCss.matchAll(/session-view\[data-role[^{]*:nth-child\(7\)\s*\{[^}]*\}/g)].flatMap((m) => [...m[0].matchAll(/rgb\(255 190 92 \/ ([\d.]+)\)/g)].map((x) => Number(x[1]))));
	const grounds = (name: string) => {
		const m = new RegExp(`--${name}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`).exec(ravenCss);
		assert.ok(m, `--${name}`);
		return { colour: hex(m[1]!, m[2]!, m[3]!), alpha: Number(m[4]) };
	};
	for (const [role, file] of Object.entries(ROOMS) as [keyof typeof ROOMS, string][]) {
		const sample = SAMPLES[role];
		assert.equal(createHash("sha256").update(readFileSync(new URL(`../gui/themes/raven/${file}`, import.meta.url))).digest("hex").slice(0, 16), sample.sha, `${file} changed: sample its brightest pixel again`);
		const under = mix("#ffbe5c", peak, mix(veilColour, lightest, hex(...(sample.worst.map(String) as [string, string, string]))));
		for (const name of ["well", "rk-well"]) {
			const g = grounds(name), ground = mix(g.colour, g.alpha, under);
			for (const text of ["text", "dim"]) assert.ok(contrast(token(text), ground) >= MIN, `${role}: --${text} on --${name} over ${file}'s brightest pixel (${ground}): ${contrast(token(text), ground).toFixed(2)}`);
		}
	}
});

// scratch/theme-contract/err/summary.md and history.py: Chrome 157, DPR 1, bolt and candle at full opacity, rest veil clear.
// Hide the UI, not the art: leave [data-slot=backdrop], its children (including the candle), and [data-slot=map] visible.
// PIL GaussianBlur(8), then max per channel from floor(0.3 * height) to the bottom: 153/113/104 at 1600×901, 150/111/102 at 390×844.
// The previous capture hid the candle along with .shell. These maxima bound the glass; they are not a pixel sampled under a label.
const GLASS_SAMPLE = { sha: "65a27813b776dc77", blur: 8, worst: "#997168", bolt: "95bb6d83a03b8ee6" };
test("text on glass, including soft crimson for card errors, keeps 4.5 : 1 at the bolt and candle peak", () => {
	const sheet = rulesOf(ravenCss), body = (selector: string) => sheet.filter((r) => r.parts.includes(selector)).map((r) => r.body).join(";");
	const picture = body('html[data-view="raven"]:has(#stage[data-view="map"]) [data-slot="backdrop"] > :nth-child(1)');
	for (const layer of SAMPLED_LAYERS) assert.ok(picture.includes(layer), `the sampled layer is still there: ${layer}`);
	assert.equal(createHash("sha256").update(readFileSync(new URL("../gui/themes/raven/backdrop.webp", import.meta.url))).digest("hex").slice(0, 16), GLASS_SAMPLE.sha, "the backdrop changed: sample its blurred brightest pixel again");
	const boltRule = sheet.find((r) => r.parts.includes('html[data-view="raven"] [data-slot="map"]') && /data:image\/svg/.test(r.body));
	assert.ok(boltRule, "the bolt's layer is in the sheet");
	const paint = declarations(boltRule.body).filter(([name]) => name !== "display" && name !== "content");
	assert.equal(createHash("sha256").update(JSON.stringify(paint)).digest("hex").slice(0, 16), GLASS_SAMPLE.bolt, "the bolt's layer changed: sample the picture's layers at the strike's peak again");
	const blur = Number(/--rk-blur:\s*([\d.]+)px/.exec(ravenCss)?.[1]);
	assert.ok(blur >= GLASS_SAMPLE.blur, `the blur is ${blur} px; the sample took ${GLASS_SAMPLE.blur} (a narrower blur leaves a brighter peak)`);
	const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
	assert.ok(Number(/--rk-glass:\s*rgba\([^)]*,\s*([\d.]+)\)/.exec(ravenCss)?.[1]) <= 0.6, "the glass fill is 0.6 or lighter, so the castle reads through the bases (RGV-F003)");
	for (const token of ["rk-glass", "rk-glass-sheet"]) {
		const m = new RegExp(`--${token}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`).exec(ravenCss);
		assert.ok(m, `--${token} is set`);
		const ground = mix(`#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`, Number(m[4]), GLASS_SAMPLE.worst);
		// Blood crimson is badge fill, not bare card ink. The more opaque sheet still supports it as text.
		for (const text of TEXT.filter(t => token !== "rk-glass" || t !== "err")) assert.ok(contrast(raven[text]!, ground) >= MIN, `--${text} on --${token} over the brightest blurred pixel (${ground}): ${contrast(raven[text]!, ground).toFixed(2)}`);
	}
	// who takes the glass: the large panels, inside @supports, with a blur; the rows inside them take no blur (a backdrop-filter box is its children's backdrop root)
	const supports = /@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) \{((?:[^{}]|\{[^{}]*\})*)\}/.exec(ravenCss)?.[1] ?? "";
	assert.match(supports, /:is\(\.base, \.comms-in, \.panel, \.set-group\) \{ background: var\(--rk-glass\); \}/);
	assert.ok(supports.includes('.comms-in:where(:not(:has(> .target-veil:not([hidden])))) { -webkit-backdrop-filter: blur(var(--rk-blur)); backdrop-filter: blur(var(--rk-blur)); }'), "the comms glass cannot confine its open target picker");
	assert.match(supports, /dialog\.sheet:not\(\.yard\) \{ background-color: var\(--rk-glass-sheet\)/);
	assert.ok(!/backdrop-filter/.test(ravenCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/@supports[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, "")), "no backdrop-filter outside the @supports block (the fallback keeps the opaque fills)");
	for (const small of [".card", ".d-doc", ".tx-body", ".head-node"]) assert.ok(!new RegExp(`${small.replace(".", "\\.")}[^{]*\\{[^}]*backdrop-filter`).test(ravenCss), `${small} does not blur`);
});

// The head page's thin glass (--rk-glass 0.18, blur 2 px, raven.css "The head page's glass is thinner") shows the castle, so no text may stand on it bare: every text-bearing row carries --rk-backing (an rgba with no blur) or --panel. A backing is unblurred, so the worst case under it is the brightest unblurred pixel the map's test sampled, rgb(179 154 129), a wall lit by a window at the peak of the strike; the head page paints the same layers (the strike's wash and veils, the lights' peak 0.7125), which that test pins.
// The tints a row lays over the backing (a bubble's 8 percent gold, a notice's 7 percent violet) are on it too. In a browser the same was checked by walking every text element of the head page's comms and requiring the ground below it to be --panel or --rk-backing (r2 notes in the report); this is the arithmetic.
test("text on the head page's backing keeps 4.5 : 1 over the brightest unblurred pixel, with a bubble's and a notice's tint on it too", () => {
	const m = /--rk-backing:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(ravenCss);
	assert.ok(m, "--rk-backing is set");
	const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
	const backing = mix(`#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`, Number(m[4]), "#b39a81");
	assert.ok(Number(m[4]) >= 0.8, `--rk-backing is ${m[4]}`);
	for (const text of TEXT) assert.ok(contrast(raven[text]!, backing) >= MIN, `--${text} on the backing over the brightest pixel (${backing}): ${contrast(raven[text]!, backing).toFixed(2)}`);
	for (const [tint, share] of [["gold", 8], ["violet", 7]] as const) {
		assert.match(ravenCss, new RegExp(`color-mix\\(in srgb, var\\(--${tint}\\) ${share}%, transparent\\) 0 0\\), var\\(--rk-backing\\)`), `the ${tint} tint is ${share} percent over the backing`);
		const under = mix(raven[tint]!, share / 100, backing);
		for (const text of ["text", "dim"]) assert.ok(contrast(raven[text]!, under) >= MIN, `--${text} on ${share}% ${tint} over the backing (${under}): ${contrast(raven[text]!, under).toFixed(2)}`);
	}
});

// Keep the CSS protections paired with the rendered scenes in err/summary.md and err/tower/. The RGB bound above
// cannot account for an ancestor fading its text together with its glass, or for a missing message backing.
const skin = `:where(html${RAVEN})`;
// Compare declarations for the same selector within its layer: importance first, then source order.
function takes(sheet: Rule[], selector: string, property: string, value: string) {
	const values = sheet.filter(r => r.parts.includes(selector)).flatMap(r => declarations(r.body)).filter(([p]) => p === property).map(([, v]) => v);
	const important = /\s*!important\s*$/i;
	const winner = values.findLast(v => important.test(v)) ?? values.at(-1);
	assert.equal(winner?.replace(important, ""), value, `${selector} needs ${property}: ${value}`);
}

test("desktop refusal over the bolt: only a nonempty toolbar reason gets the well", () => {
	takes(rules, `${skin} .auto-sw-note:not(:empty)`, "background", "var(--rk-well)");
});

test("phone offline + stale: keep crash details and status readable through both ancestors", () => {
	const offline = `${skin} .base.ally.offline:has(.au-crash:not([hidden]), [data-tone="crashed"])`;
	takes(rules, offline, "border-style", "dashed");
	takes(rules, offline, "opacity", "1");
	takes(rules, `${skin} .ally-unit.stale:is([data-tone="crashed"], :has(.au-crash:not([hidden])))`, "opacity", "1");
	for (const label of ['.ally-unit[data-tone="crashed"] .au-word', '.au-crash:not([data-trust]) summary b']) takes(rules, `${skin} ${label}`, "color", "var(--err-soft)");
});

test("unreachable error card: role and monitor use soft crimson, neither the card nor its age fades", () => {
	const base = `${skin} .base.remote[data-box="unreachable"]:has(.unit[data-mark="error"], [data-monitoring])`;
	takes(rules, base, "border-style", "dashed");
	takes(rules, base, "opacity", "1");
	takes(rules, `${skin} .unit[data-mark="error"] > .card .age`, "opacity", "1");
	for (const label of ['.base [data-monitoring]', '.unit[data-mark="error"] > .card .role']) takes(rules, `${skin} ${label}`, "color", "var(--err-soft)");
});

test("unreachable base with a retained tower error but no errored or watching units: the notice stays readable", () => {
	// fillNotices (gui/towernotes.ts) writes the row's severity even in a retained snapshot.
	const base = `${skin} .base.remote[data-box="unreachable"]:has(.tower-notices > .error)`;
	takes(rules, base, "opacity", "1");
	takes(rules, base, "border-style", "dashed");
	takes(entryRules, ".tower-notices .tnote.error span", "color", "var(--err-soft)");
});

test("head chat: the stop badge and failure reason keep their message panel over the thin glass", () => {
	takes(entryRules, ".tx-body", "background", "var(--panel)");
	takes(entryRules, ".stop", "color", "var(--c)");
	takes(entryRules, ".stop", "background", "var(--c1)");
	takes(entryRules, '[data-mark="error"]', "--c", "var(--err)");
	takes(entryRules, ".fault", "color", "var(--err-soft)");
	takes(rules, `${RAVEN} [data-mark]`, "--c1", "color-mix(in srgb, var(--c) 13%, transparent)");
	// Use the message panel over the lit wall (the unblurred sample above), then the badge's state tint.
	const panel = /--panel:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(block.body);
	assert.ok(panel, "the message has Raven's translucent panel");
	const fill = `#${panel.slice(1, 4).map(n => Number(n).toString(16).padStart(2, "0")).join("")}`;
	const ground = mix(fill, Number(panel[4]), "#b39a81");
	assert.ok(contrast(raven.err!, mix(raven.err!, 0.13, ground)) >= MIN);
	assert.ok(contrast(raven["err-soft"]!, ground) >= MIN);
});

// What stands bare on the picture (the crumbs, the bar's buttons, the legend, the new-base button, and the head page's rows over the thin glass) has an unblurred ground, and the bolt's core is pure white: nothing about it is sampled, the arithmetic is the bound. Every text colour keeps 4.5 : 1 on each ground over a pure white pixel, and the bare rows were walked in a browser at the strike's peak
// (desktop 1440, 1024, phone 390, map, scrolled map and head page: 4.99 : 1 at the lowest, r3 notes). This is why --rk-well is 0.86 and not the 0.66 it was, and --rk-backing 0.86 and not 0.8.
test("under a bolt's pure white core, the unblurred grounds (--rk-well and --rk-backing) keep every text colour at 4.5 : 1", () => {
	const hex = (n: string) => Number(n).toString(16).padStart(2, "0");
	for (const token of ["rk-well", "rk-backing"]) {
		const m = new RegExp(`--${token}:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`).exec(ravenCss);
		assert.ok(m, `--${token} is set`);
		const ground = mix(`#${hex(m[1]!)}${hex(m[2]!)}${hex(m[3]!)}`, Number(m[4]), "#ffffff");
		for (const text of TEXT) assert.ok(contrast(raven[text]!, ground) >= MIN, `--${text} on --${token} over pure white (${ground}): ${contrast(raven[text]!, ground).toFixed(2)}`);
	}
	for (const bare of [".bar .crumbs", ".bar-acts .pair-btn", ".new-base", ".legend"]) assert.ok(rules.some((r) => r.parts.some((p) => p.includes(bare)) && /background:\s*var\(--rk-well\)/.test(r.body)), `${bare} takes --rk-well`);
});
