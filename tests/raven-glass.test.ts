import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { declarations, rulesOf } from "./css-rules.ts";

// The glass, the phone's cover frame, and the strike's early start are Raven's alone (boss, 2026-11-09: Standard and Geek change only by a boss decision). Raven's stylesheet is loaded the first time a page shows the view and stays in the document after a switch back, so every selector of it must name the raven view; Standard's and Geek's stylesheets are not touched by this work.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const raven = read("gui/themes/raven/raven.css"), rules = rulesOf(raven);

test("every selector of raven.css names the raven view, so its glass, frame, and animations reach no other view even once the file is loaded", () => {
	for (const rule of rules) for (const part of rule.parts) assert.match(part, /^(?:(?:html)?\[data-view="raven"\]|:where\(html\[data-view="raven"\]\))/, `${part} is scoped to the raven view`);
});

test("the glass is inside @supports and the phone frame inside a 600 px query, so a browser without backdrop-filter keeps the opaque fills and a wide screen the frame it had", () => {
	const supports = /@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) \{((?:[^{}]|\{[^{}]*\})*)\}/.exec(raven)?.[1] ?? "";
	const inside = rulesOf(supports);
	assert.ok(inside.length >= 5, "the glass rules are in the block");
	for (const r of inside) assert.ok(r.parts.every((p) => /^html\[data-view="raven"\]/.test(p)), `${r.selector} is scoped`);
	const phone = /@media \(max-width: 600px\) \{\s*html\[data-view="raven"\] \{ --rk-w: max\(100vw, calc\(100vh \* 1\.7753\)\); --rk-w: max\(100vw, calc\(100svh \* 1\.7753\)\); \}([^@]*)\}/.exec(raven);
	assert.ok(phone, "the phone frame: the screen's height times 1280 / 721, never narrower than the screen, with a vh fallback for the svh");
	assert.match(phone[1]!, /\{ left: 0; translate: none; \}/, "pinned to the left edge, where the castle is");
	assert.ok(Math.abs(1280 / 721 - 1.7753) < 1e-4, "the picture's aspect");
	// the wide-screen frame is what it was
	const token = declarations(rules.find((r) => r.selector === '[data-view="raven"]')!.body).find(([p]) => p === "--rk-w")![1];
	assert.equal(token, "min(100vw, 1600px)");
});

test("Standard's and Geek's stylesheets carry no raven glass: neither names a raven token", () => {
	for (const file of ["gui/style.css", "gui/themes/geek/geek.css"]) assert.ok(!/--rk-/.test(read(file)), `${file} has no raven rule`);
});

test("a phone keeps the map's perched raven (56 px, on the band, taking no tap) and the head page's stays off it", () => {
	const phone = /@media \(max-width: 600px\) \{ (html\[data-view="raven"\]:has\(#stage\[data-view="map"\]\) \[data-slot="backdrop"\] > :nth-child\(6\)[^\n]*)\n/.exec(raven)?.[1] ?? "";
	assert.ok(phone.length > 0, "the map's phone block");
	assert.ok(!/\.head-node > \.perch \{ display: none/.test(phone) && !/\.head-node > \.perch,? ?\{? ?display/.test(phone), "the band's perch is not hidden");
	assert.match(phone, /\.head-node \{ --rk-pw: 56px; margin-top: calc\(var\(--rk-pw\) \* 0\.806 - 8px\); \}/);
	assert.match(raven, /\.head-node > \.perch \{\s*display: block; position: absolute; pointer-events: none;/);
	assert.match(raven, /@media \(max-width: 600px\) \{ html\[data-view="raven"\]:has\(#stage\[data-view="head"\]\) \[data-slot="backdrop"\] > :nth-child\(6\)[^\n]*\.stage\[data-view="head"\] > \.perch \{ display: none; \}/, "the head page's perch is on the gate, off a phone's visible part of the frame");
});

test("the head turn is lit: the turned frame is lifted from the profile's resting dark, rimmed in cool moonlight, and has a glint in its eye, all static so only its opacity animates", () => {
	const turn = (selector: string) => rules.filter((r) => r.parts.includes(`html[data-view="raven"] ${selector}`)).map((r) => r.body).join(";");
	const element = turn(".perch-turn");
	assert.match(element, /opacity:\s*0/, "it dissolves in");
	assert.match(element, /filter:\s*drop-shadow\(0 0 1px rgb\(205 222 255 \/ 0\.95\)\) drop-shadow\(0 0 calc\(var\(--rk-pw\) \* 0\.06\) rgb\(120 150 255 \/ 0\.55\)\)/, "a cool moonlight rim: a hairline and a halo");
	assert.ok(!/animation/.test(element), "the rim is static: the element's only animation is the opacity keyframes in the motion block");
	const lit = (layer: string) => Number(/brightness\(([\d.]+)\)/.exec(turn(`.perch-turn::${layer}`))?.[1]);
	assert.ok(lit("after") >= 1, `the turned frame rests at ${lit("after")}, not the profile's 0.34`);
	assert.ok(lit("before") > lit("after"), "and brighter again under a strike");
	assert.match(turn(".perch-turn::after"), /radial-gradient\(circle calc\(var\(--rk-pw\) \* 0\.05\) at 27\.2% 10%, #fff 0/, "the eye's glint, a white-cored dot where the eye is in the turned frame");
	const dark = Number(/\.perch::after\s*\{[^}]*brightness\(([\d.]+)\)/.exec(raven)?.[1]);
	assert.equal(dark, 0.34, "the profile keeps its resting dark");
	// the hold: opaque 65 to 89 percent of the 17 s cycle, 4.08 s, reached and left in 0.17 s (boss, 2026-11-09: the 0.7 s dissolves drew two heads)
	const keys = /@keyframes rk-perch-turn \{([^\n]*)\}\n/.exec(raven)?.[1] ?? "";
	assert.match(keys, /0%, 64% \{ opacity: 0; \} 65%, 89% \{ opacity: 1; \} 90%, 100% \{ opacity: 0; \}/);
	assert.ok(((89 - 65) / 100) * 17 >= 4, "it holds the turned frame for about 4 s");
	// the profile goes out as the turned frame comes in, on the same clock, so the profile's beak never shows beside the turned head
	assert.match(raven, /@keyframes rk-perch-profile \{ 0%, 64% \{ opacity: 1; \} 65%, 89% \{ opacity: 0; \} 90%, 100% \{ opacity: 1; \} \}/);
	const turns = raven.split("\n").filter((l) => /> \.perch-turn \{ animation: rk-perch-turn 17s linear -7\.5s infinite; \}/.test(l));
	const profiles = raven.split("\n").filter((l) => /> \.perch:not\(\.perch-turn\) \{ animation: rk-perch-profile 17s linear -7\.5s infinite; \}/.test(l));
	assert.equal(turns.length, 4, "the turn runs on the head page and the map, in motion and in a fine pointer's calm");
	assert.deepEqual(profiles.map((l) => l.replace(/ > .*/, "")), turns.map((l) => l.replace(/ > .*/, "")), "each turn has its profile swap under the same selector");
	assert.match(raven, /\.head-node \{ --rk-pw: clamp\(52px, calc\(var\(--rk-w\) \* 0\.07\), 100px\)/, "a desktop's perch is 100 px wide");
});

test("the head page's glass is thin (so the castle shows) and its bare text has a backing; a phone hides the page's header behind the comms and leaves a strip of the picture above the log", () => {
	const token = (name: string, scope: string) => {
		const rule = rules.find((r) => r.parts.includes(scope) && new RegExp(`--${name}:`).test(r.body));
		assert.ok(rule, `${name} on ${scope}`);
		return declarations(rule.body).find(([p]) => p === `--${name}`)![1];
	};
	const HEAD = 'html[data-view="raven"]:has(#stage[data-view="head"]) .comms-in', ALL = 'html[data-view="raven"]';
	const alpha = (v: string) => Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(v)?.[1]);
	assert.ok(alpha(token("rk-glass", HEAD)) <= 0.2 && alpha(token("rk-glass", HEAD)) < alpha(token("rk-glass", ALL)) / 3, `the head page's fill is ${token("rk-glass", HEAD)} against ${token("rk-glass", ALL)}`);
	assert.ok(parseFloat(token("rk-blur", HEAD)) <= 2 && parseFloat(token("rk-blur", HEAD)) < parseFloat(token("rk-blur", ALL)), "and its blur is no wider than 2 px");
	const supports = /@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) \{((?:[^{}]|\{[^{}]*\})*)\}/.exec(raven)?.[1] ?? "";
	const backed = rulesOf(supports).filter((r) => r.parts.some((p) => p.startsWith(HEAD.replace(" .comms-in", ""))) && /var\(--rk-backing\)/.test(r.body)).map((r) => r.selector).join(" ");
	for (const part of [".tx.rule > p", ".tx.rule > details", ".tx.rule > div", ".tx.you > header", ".tx.note", ".act", ".tower-notes", ".queue-bar", ".queue-list", ".queue-act", ".bubble", ".notice"]) assert.ok(backed.includes(part), `${part} has the backing on the head page`);
	const phone = /@media \(max-width: 640px\) \{\s*@supports \(backdrop-filter: blur\(1px\)\) or \(-webkit-backdrop-filter: blur\(1px\)\) \{([^@]*)\}\s*\}/.exec(raven)?.[1] ?? "";
	assert.match(phone, /:is\(\.hud, \.bar, \.foot\) \{ visibility: hidden; \}/, "the page's header, crumbs, and foot do not ghost through");
	assert.match(phone, /\.comms-head \{ margin-bottom: clamp\(0px, calc\(var\(--vvh, 100dvh\) - 520px\), 120px\); \}/, "a strip up to 120 px, none when the screen is short");
});

// Round 3 (todo #138): the strike draws a bolt. The boss saw a 17 to 29 of 255 brightening, not lightning (「鴉閣我好像還是都沒看到雷聲和閃電」). The layer below is an opacity only, in the picture's frame, on the same 61 s clock and 7 s first strike as the picture's own light.
const strike = (selector: string) => rules.filter((r) => r.parts.includes(selector)).map((r) => r.body).join(";");
const LAYERS = ['html[data-view="raven"] [data-slot="map"]', 'html[data-view="raven"]:has(#stage[data-view="head"]) [data-slot="backdrop"] > :nth-child(3)'];
test("the strike's bolt is one fixed layer in the picture's frame on the map and on the head page: hidden at rest, a small SVG of the painting's own size, a wash, and nothing that takes a tap", () => {
	for (const layer of LAYERS) {
		const rule = rules.find((r) => r.parts.includes(layer) && /url\("data:image\/svg\+xml/.test(r.body));
		assert.ok(rule, `${layer} draws the bolt`);
		const body = rule.body;
		assert.match(body, /position:\s*fixed/);
		assert.match(body, /pointer-events:\s*none/);
		assert.match(body, /opacity:\s*0\b/, "at rest, and under reduced motion (which has no animation), it is not drawn");
		assert.match(body, /width:\s*var\(--rk-w\);\s*aspect-ratio:\s*1280 \/ 721/, "in the picture's frame");
		const uri = /url\("data:image\/svg\+xml,([^"]*)"\)/.exec(body)![1]!;
		assert.ok(uri.length < 4_000, `the bolt is ${uri.length} bytes (a raster would cost more than 20 KB)`);
		assert.match(decodeURIComponent(uri), /viewBox='0 0 1280 721'/, "its coordinates are the painting's, so a stroke lies where the sky is");
		assert.match(body, /linear-gradient\(rgb\(176 158 255 \/ 0\.\d+\)/, "and a wash of the sky");
		assert.match(body, /mask-image:\s*linear-gradient\(#000 16%, transparent 42%\)/, "it fades into the glass below the bar (the glass's contrast is sampled with that fade)");
	}
	assert.match(strike(LAYERS[0]!), /z-index:\s*-1/, "above the backdrop but behind the map");
	assert.match(strike(LAYERS[1]!), /z-index:\s*-1/);
});

test("the bolt is a double pulse 0.3 s long at most, on the picture's own instants, so the flash, the bolt, and the thunder are one moment", () => {
	const frames = (name: string) => [...(new RegExp(`@keyframes ${name} \\{([^\\n]*)\\}\\n`).exec(raven)?.[1] ?? "").matchAll(/([\d.%,\s]+?)\s*\{\s*(?:--rk-bolt|opacity):\s*([\d.]+);\s*\}/g)].flatMap((m) => m[1]!.split(",").map((t) => ({ at: parseFloat(t), v: Number(m[2]) })));
	const bolt = frames("rk-strike"), cycle = 61;
	assert.ok(bolt.length >= 6, "the keyframes were read");
	const peaks = bolt.filter((f, i) => f.v === 1 && (bolt[i - 1]?.v ?? 0) <= 1 && (bolt[i + 1]?.v ?? 0) < 1);
	assert.equal(peaks.length, 2, "two pulses");
	const sec = (at: number) => (at / 100) * cycle, end = bolt.find((f) => f.at > peaks[1]!.at && f.v === 0)!;
	assert.ok(sec(end.at) - sec(peaks[0]!.at) <= 0.3, `the pair lasts ${(sec(end.at) - sec(peaks[0]!.at)).toFixed(2)} s from its first peak`);
	assert.ok(bolt.some((f) => f.at > peaks[0]!.at && f.at < peaks[1]!.at && f.v > 0 && f.v < 0.5), "it dips between the pulses");
	// the picture's own light and the raven's go to the same two peaks and fade over 1 to 2 s: nothing else flashes in a strike (at most 2 flashes, one strike per 61 s)
	for (const name of ["rk-bolt", "rk-rest", "rk-perch-dark"]) {
		const other = frames(name).filter((f) => f.at >= 94 && f.at <= 94.7).map((f) => f.at);
		assert.deepEqual(other.slice(0, 4), [94.3, 94.4, 94.5, 94.6], `${name} peaks where the bolt's do`);
	}
	assert.equal(peaks[0]!.at, 94.4, "the first peak is the instant rk-clap (the thunder's clock) is aligned to: 7 s after the layer shows, whose strike layers start 50.584 s into the cycle");
	assert.ok(Math.abs(sec(94.4) - 50.584 - 7) < 0.01, "7 s after the layer is shown");
});

test("the bolt runs where the strike runs, and nowhere else: on the map once the head band is shown, on the head page, in calm only on a fine pointer, with the same clock as the picture's light", () => {
	const clock = "rk-strike 61s linear -50.584s infinite";
	const motion = /@media \(prefers-reduced-motion: no-preference\) \{((?:[^{}]|\{[^{}]*\})*)\}\s*\/\* Calm on a fine pointer/.exec(raven)?.[1] ?? "";
	const fine = /@media \(prefers-reduced-motion: no-preference\) and \(pointer: fine\) \{((?:[^{}]|\{[^{}]*\})*)\}/.exec(raven)?.[1] ?? "";
	for (const [source, name] of [[motion, "motion"], [fine, "calm"]] as const) {
		const mine = rulesOf(source).filter((r) => r.body.includes(clock));
		assert.equal(mine.length, 2, `${name}: the head page's and the map's bolt`);
		assert.ok(mine.some((r) => /:has\(#stage\[data-view="head"\]\) \[data-slot="backdrop"\] > :nth-child\(3\)$/.test(r.selector)), `${name}: the head page`);
		assert.ok(mine.some((r) => /:has\(#stage\[data-view="map"\] \.head-node:not\(\[hidden\]\)\) \[data-slot="map"\]$/.test(r.selector)), `${name}: the map, once the band is shown (the rest veil's gate)`);
		for (const r of mine) assert.match(r.selector, name === "motion" ? /:not\(\[data-calm\]\)/ : /\[data-calm\]/);
	}
	// the picture's own animations of the strike run on the same clock, so bolt and flash start together
	assert.match(raven, /rk-rest 61s linear -50\.584s infinite, rk-clap 61s linear 7s infinite/);
	assert.ok(!/animation[^;]*rk-strike/.test(raven.replace(/@media \(prefers-reduced-motion: no-preference\)(?: and \(pointer: fine\))? \{(?:[^{}]|\{[^{}]*\})*\}/g, "")), "no rk-strike outside the no-preference blocks: under reduced motion there is no bolt and no wash");
	// forced colours draw no picture, and so no bolt; a phone pins it to the left edge like the picture
	assert.match(raven, /html\[data-view="raven"\] \[data-slot="map"\], html\[data-view="raven"\]:has\(#stage\[data-view="head"\]\) \[data-slot="backdrop"\] > :nth-child\(3\) \{ left: 0; translate: none; \}/, "pinned left on a phone, where the castle is");
});

test("the head page's perch stands in the margin left of the log column: it clears the 1040 px column wherever it is drawn (1381 px and up) and is not drawn where no margin fits", () => {
	const perch = rules.find((r) => r.selector === 'html[data-view="raven"] .stage[data-view="head"] > .perch')!;
	const left = /left:\s*calc\(50% - var\(--rk-w\) \* 0\.5 \+ var\(--rk-w\) \* ([\d.]+) - var\(--rk-pw\) \* ([\d.]+)\)/.exec(perch.body);
	assert.ok(left, "its left edge is laid in the picture's frame");
	const [claw, back] = [Number(left[1]), Number(left[2])], width = Number(/--rk-pw:\s*calc\(var\(--rk-w\) \* ([\d.]+)\)/.exec(perch.body)![1]);
	assert.match(perch.body, /transform:\s*scaleX\(-1\)/, "mirrored, to look at the log");
	assert.ok(Math.abs(claw - 97 / 1280) < 0.001, "its claws are on the painting's left cross");
	assert.ok(Math.abs(back - (1 - 0.435)) < 1e-9, "the claws are at 43.5 percent of the strip, so at 56.5 from the left once it is mirrored");
	const hidden = /@media \(max-width: (\d+)px\) \{ html\[data-view="raven"\] \.stage\[data-view="head"\] > \.perch \{ display: none; \} \}/.exec(raven);
	assert.ok(hidden, "hidden where no margin fits");
	for (let w = Number(hidden[1]) + 1; w <= 3840; w += 1) {
		const frame = Math.min(w, 1600), right = (w - frame) / 2 + frame * (claw - back * width + width), column = w / 2 - 520;
		assert.ok(right + 8 <= column, `at ${w} px the perch ends at ${right.toFixed(0)} and the log column starts at ${column}`);
	}
	assert.ok(Number(hidden[1]) >= 1300 && Number(hidden[1]) <= 1400, `the perch is hidden at ${hidden[1]} px and under`);
});

test("a theme switch updates the header's height for the comms: render.ts watches the header's border box (tests/hud-observer.test.ts) and the comms' height is calc'd from --hud", () => {
	assert.match(read("gui/style.css"), /\.comms-in[^{]*\{[^}]*var\(--hud, 64px\)/);
});
