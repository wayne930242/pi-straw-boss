import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarations, rulesOf } from "./css-rules.ts";

// Raven Keep's status motion (boss, 2026-11-08, option C of scratch/raven-motion/preview.html; spec §1.5 motion): the keep draws a seal, breathes mist, and swells a soul-fire where Standard sweeps a radar, spins a ring,
// pings, and turns a spinner. Nothing in it turns: no rotate, no turn, no conic sweep. It stops under calm, prefers-reduced-motion, and forced colours, and leaves two figures that differ in shape.
const root = fileURLToPath(new URL("..", import.meta.url));
const at = (path: string) => readFileSync(join(root, path), "utf8");
const raven = at("gui/themes/raven/raven.css"), standard = at("gui/style.css");
const ravenRules = rulesOf(raven), standardRules = rulesOf(standard);

/** Every `@keyframes name { ... }` of a sheet: name to body (braces balanced). */
const keyframes = (css: string) => {
	const out = new Map<string, string>();
	for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
		let depth = 1, end = m.index! + m[0].length;
		while (end < css.length && depth > 0) depth += css[end] === "{" ? 1 : css[end] === "}" ? -1 : 0, end++;
		out.set(m[1]!, css.slice(m.index! + m[0].length, end - 1));
	}
	return out;
};
const frames = keyframes(raven);

test("head, map and room motion only transform or fade; the weather clock holds scale at one", () => {
	for (const [name, body] of frames) {
		if (name === "rk-clap") {
			assert.match(body.trim(), /^from, to \{ scale: 1; \}$/);
			continue;
		}
		const properties = [...body.matchAll(/\{([^{}]*)\}/g)].flatMap(m => declarations(m[1]!).map(([p]) => p));
		assert.ok(properties.length, `no stops for ${name}`);
		for (const prop of properties) assert.ok(["transform", "translate", "opacity"].includes(prop), `${name} animates ${prop}`);
	}
	const head = ravenRules.filter(r => r.selector.includes('#stage[data-view="head"]') && r.selector.includes('[data-slot="backdrop"]'));
	for (const name of ["rk-lit-a", "rk-lit-b", "rk-rest", "rk-strike", "rk-mist-a", "rk-mist-b", "rk-bat-first", "rk-bat-last", "rk-flap-a", "rk-flap-b", "rk-raven-map", "rk-raven-glide", "rk-clap"]) {
		assert.ok(frames.has(name) && head.some(r => declarations(r.body).some(([p,v]) => p === "animation" && v.split(",").some(a => a.trim().split(/\s+/)[0] === name))), `${name} runs on the head page`);
	}
});
/** The animation names and cycle lengths (seconds) of one `animation` shorthand: a comma list of `name duration ...`. */
const shorthand = (value: string) => value.split(",").map((one) => one.trim()).filter(Boolean).map((one) => ({ name: /^[a-z][\w-]*/.exec(one)?.[0] ?? one, seconds: Number(/(?:^|\s)(\d*\.?\d+)s\b/.exec(one)?.[1] ?? NaN) }));
const animationOf = (body: string) => declarations(body).filter(([p]) => p === "animation").map(([, v]) => v);

// Standard's six rules (gui/style.css): the ones raven inherits and replaces. Each keeps its text.
const STANDARD: { what: string; rule: RegExp; host: RegExp }[] = [
	{ what: "the tower's working sweep", rule: /^\.tower\[data-mark="working"\] \.sweep \{ opacity: 1; animation: spin 3\.2s linear infinite; \}$/m, host: /\.tower\[data-mark="working"\] > \.sweep(?!::)/ },
	{ what: "the tower's waiting ping", rule: /^\.tower\[data-mark="waiting"\] \.pulse \{ animation: ping 1\.5s ease-out infinite; \}$/m, host: /\.tower\[data-mark="waiting"\] > \.pulse(?!::)/ },
	{ what: "the plate's working ring", rule: /^\.plate\[data-mark="working"\] > \.ring \{ opacity: 1; animation: spin 1\.1s linear infinite; \}$/m, host: /\.plate\[data-mark="working"\] > \.ring(?!::)/ },
	{ what: "the plate's waiting ping", rule: /^\.plate\[data-mark="waiting"\]::after \{ animation: ping 1\.5s ease-out infinite; \}$/m, host: /\.plate\[data-mark="waiting"\]::after/ },
	{ what: "the working badge's spinner", rule: /^\[data-mark="working"\] > \.badge::after \{ content: ""; width: 8px; height: 8px; border-radius: 50%; border: 2px solid var\(--ink\); border-right-color: transparent; animation: spin 0\.8s linear infinite; \}$/m, host: /\[data-mark="working"\] > \.badge::after/ },
	{ what: "the connection ring's spin", rule: /^\.connect-ring \{[^}]*animation: spin 1\.1s linear infinite; \}$/m, host: /\.connect-ring(?!::)/ },
];

test("Standard's six spinning and pinging rules are as they were: raven replaces them in its own sheet, never in style.css", () => {
	for (const s of STANDARD) assert.match(standard, s.rule, s.what);
	assert.match(standard, /@keyframes spin \{ to \{ transform: rotate\(360deg\); \} \}/);
	assert.match(standard, /@keyframes ping \{ 0% \{ transform: scale\(1\); opacity: 0\.6; \} 100% \{ transform: scale\(1\.7\); opacity: 0; \} \}/);
	assert.match(standard, /@keyframes hop \{ 50% \{ transform: translateY\(-3px\); \} \}/);
	assert.ok(standardRules.some((r) => r.selector === ".sweep" && /conic-gradient/.test(r.body)), "Standard's sweep keeps its conic wedge");
});

test("raven overrides each of the six with a rule of its own whose animation is none or a raven keyframe set, never Standard's spin or ping", () => {
	for (const s of STANDARD) {
		const own = ravenRules.filter((r) => r.parts.some((p) => s.host.test(p)) && animationOf(r.body).length);
		assert.ok(own.length > 0, `${s.what}: raven sets its animation`);
		for (const r of own) for (const v of animationOf(r.body)) for (const { name } of shorthand(v)) assert.ok(name === "none" || frames.has(name), `${s.what}: ${name} is none or a keyframe set of raven.css`);
	}
});

test("raven's own status rules are all scoped to the raven view, so Standard, Geek, and Zen keep their rules", () => {
	const status = ravenRules.filter((r) => r.parts.some((p) => /\.(sweep|ring|pulse|connect-ring)\b|\.badge\b|\.plate\[data-mark|\.tower\[data-mark/.test(p)));
	assert.ok(status.length >= 12, `the status rules were read (${status.length})`);
	for (const r of status) for (const p of r.parts) if (/\.(sweep|ring|pulse|connect-ring)\b|\.badge\b|\.plate\[data-mark|\.tower\[data-mark/.test(p)) assert.match(p, /^html\[data-view="raven"\]/, `${p} starts at the raven view`);
	for (const file of ["gui/themes/geek/geek.css", "gui/zen.css"]) assert.ok(!/rk-(seal|dia|mist|soul|dots|wing|bob)/.test(at(file)), `${file} knows nothing of raven's keyframes`);
});

test("no keyframes set of raven.css turns, rotates, or sweeps a conic wedge, and no rule of it animates a conic gradient", () => {
	assert.ok(frames.size >= 12, "the keyframes were read");
	for (const [name, body] of frames) assert.ok(!/rotate|turn|skew|conic|spin/i.test(body), `@keyframes ${name} does not turn`);
	assert.ok(!/conic-gradient/.test(raven), "raven.css draws no conic gradient");
	assert.ok(!/rotate|\d\s*turn\b|\brotate\b/.test(raven.replace(/\/\*[\s\S]*?\*\//g, "")), "raven.css rotates nothing (the head page's rk-perch-turn is a dissolve between two frames, named for the raven's head)");
	for (const name of ["rk-seal", "rk-dia", "rk-mist", "rk-soul", "rk-dots", "rk-wing", "rk-bob"]) assert.ok(frames.has(name), `@keyframes ${name}`);
});

test("every keyframe set a raven status selector uses changes only transform and opacity: nothing a frame repaints (no custom property, mask, background, box-shadow, filter)", () => {
	const status = /\.(sweep|ring|pulse|connect-ring)\b|\.badge\b|\.plate\[data-mark|\.tower\[data-mark/;
	const used = new Set<string>();
	for (const r of ravenRules) if (r.parts.some((p) => status.test(p))) for (const v of animationOf(r.body)) {
		assert.ok(!v.includes("var("), `${r.selector}: a status animation names its keyframes itself, never through var(), so this check reads them (${v})`);
		for (const { name } of shorthand(v)) if (frames.has(name)) used.add(name);
	}
	for (const name of used) {
		const props = new Set<string>();
		for (const m of frames.get(name)!.matchAll(/\{([^{}]*)\}/g)) for (const [prop] of declarations(m[1]!)) props.add(prop);
		assert.ok(props.size > 0, `@keyframes ${name} was read`);
		for (const prop of props) assert.ok(prop === "transform" || prop === "opacity" || prop === "animation-timing-function", `@keyframes ${name} animates ${prop}, which is not compositor-only`);
	}
	for (const name of ["rk-seal", "rk-dia", "rk-mist", "rk-soul", "rk-dots", "rk-wing", "rk-bob"]) assert.ok(used.has(name), `${name} is used by a status selector`);
	assert.ok(!used.has("rk-lit-a") && !used.has("rk-fog"), "the head page's backdrop keyframes are not status keyframes");
	assert.ok(!/@property\s+--rk-(seal|m1|m2)\b/.test(raven), "no registered number is left for a status animation to drive");
});

test("every status animation sits in the no-preference block and outside data-calm; outside it only `animation: none` is declared, and forced colours stop the rest", () => {
	const block = /@media \(prefers-reduced-motion: no-preference\) \{/;
	assert.match(raven, block, "a block for the status motion");
	const marker = block.exec(raven)!;
	let depth = 1, end = marker.index + marker[0].length;
	while (end < raven.length && depth > 0) depth += raven[end] === "{" ? 1 : raven[end] === "}" ? -1 : 0, end++;
	const inside = rulesOf(raven.slice(marker.index + marker[0].length, end - 1)), motion = inside.filter((r) => animationOf(r.body).some((v) => !/^none$/.test(v)));
	assert.ok(motion.length >= 12, `the status animations were read (${motion.length})`);
	for (const r of motion) for (const p of r.parts) assert.match(p, /^html\[data-view="raven"\]:not\(\[data-calm\]\)/, `${p} stops at data-calm`);
	// outside the block (static figures, forced colours) no rule animates anything
	const outside = ravenRules.filter((r) => !inside.some((i) => i.selector === r.selector && i.body === r.body));
	for (const r of outside) for (const v of animationOf(r.body)) assert.ok(/none/.test(v) || /^rk-(lit|bolt|fog|bat|raven|flap|perch)/.test(v) || /rk-/.test(r.selector + r.body), `${r.selector}: ${v}`);
	const staticAnim = outside.filter((r) => /\.(sweep|ring|pulse|connect-ring)\b|\.badge\b|\.plate\[data-mark|\.tower\[data-mark/.test(r.selector)).flatMap((r) => animationOf(r.body));
	for (const v of staticAnim) assert.match(v, /^none( !important)?$/, "outside the block a status rule only stops an animation");
	// forced colours: the status motion stops and Standard's spin is stopped too
	const forced = /@media \(forced-colors: active\) \{\n([\s\S]*?)\n\}/.exec(raven)?.[1] ?? "";
	assert.match(forced, /\.sweep[\s\S]*animation: none !important/, "forced colours stop the sweep's host");
	assert.match(forced, /\.connect-ring/, "forced colours stop the connection ring");
});

test("no status animation is faster than 0.8 s a cycle, and none flashes: opacity never swings to zero and back within a cycle under 1 s", () => {
	const used = new Set<string>(), cycles = new Map<string, number>();
	for (const r of ravenRules) for (const v of animationOf(r.body)) for (const { name, seconds } of shorthand(v)) if (frames.has(name) && name.startsWith("rk-") && !/^rk-(lit|bolt|fog|bat$|raven|flap|perch)/.test(name)) (used.add(name), cycles.set(name, Math.min(cycles.get(name) ?? Infinity, seconds)));
	for (const name of ["rk-seal", "rk-dia", "rk-mist", "rk-soul", "rk-dots", "rk-wing", "rk-bob"]) {
		assert.ok(used.has(name), `${name} is used`);
		assert.ok(cycles.get(name)! >= 0.8, `${name} cycles in ${cycles.get(name)} s, at least 0.8`);
	}
	assert.equal(cycles.get("rk-wing"), 0.9, "the bat flaps in 0.9 s");
	assert.ok(!/white|#fff\b|#ffffff|red\b/.test([...frames].filter(([n]) => /^rk-(seal|dia|mist|soul|dots|wing|bob)/.test(n)).map(([, b]) => b).join("\n")), "no white or red in the status keyframes");
});

test("the still figures stay without motion and differ in shape: working draws a solid seal with its diamond, waiting a dotted ring with a soul-fire", () => {
	const rule = (re: RegExp) => ravenRules.find((r) => r.parts.some((p) => re.test(p)) && !animationOf(r.body).length);
	const sealed = rule(/^html\[data-view="raven"\] \.tower\[data-mark="working"\] > \.sweep(?!::)/), fill = rule(/^html\[data-view="raven"\] \.tower\[data-mark="working"\] > \.sweep::before/), dots = rule(/^html\[data-view="raven"\] \.tower\[data-mark="waiting"\] > \.sweep::before/);
	assert.ok(sealed && fill && dots, "the tower's ring in both states");
	assert.match(sealed!.body, /overflow:\s*hidden/, "the seal's host clips the rising fill");
	assert.match(sealed!.body, /mask:[^;]*radial-gradient\(closest-side/, "the seal is a ring-shaped mask: solid, not dotted");
	assert.match(fill!.body, /linear-gradient\(to bottom, transparent[^;]*var\(--c\)/, "the fill that the mask cuts into the ring");
	assert.match(fill!.body, /transform:\s*translateY\(calc\(-50% \+ 6px\)\)/, "still, the fill rests at the seal's full figure");
	assert.match(dots!.body, /border:[^;]*\bdotted\b/);
	const diamond = rule(/\.tower\[data-mark="working"\] > \.sweep::after/);
	assert.ok(diamond && /clip-path:\s*polygon/.test(diamond.body), "the seal's diamond is a polygon, not a turned square");
	const soul = rule(/\.tower\[data-mark="waiting"\] > \.pulse(?!::)/);
	assert.ok(soul && /radial-gradient/.test(soul.body) && /border-radius:\s*50%/.test(soul.body), "the soul-fire is a round glow inside the disc");
	const layers = [/\.tower\[data-mark="working"\] > \.pulse::before/, /\.tower\[data-mark="working"\] > \.pulse::after/].map((re) => ravenRules.find((r) => r.parts.some((p) => re.test(p)) && /radial-gradient/.test(r.body)));
	for (const layer of layers) assert.ok(layer && (layer.body.match(/radial-gradient/g) ?? []).length === 1, "a mist layer under the disc, each its own pseudo-element so each moves alone");
	const plateMist = ravenRules.find((r) => r.parts.some((p) => /^html\[data-view="raven"\] \.plate\[data-mark="working"\]::after$/.test(p)) && /radial-gradient/.test(r.body));
	assert.ok(plateMist && (plateMist.body.match(/radial-gradient/g) ?? []).length === 2, "the plate's one element draws both mist layers");
	for (const host of [".plate[data-mark=\"working\"] > .ring::before", ".plate[data-mark=\"waiting\"] > .ring::before", ".plate[data-mark=\"working\"]::after", ".plate[data-mark=\"waiting\"]::after"]) assert.ok(ravenRules.some((r) => r.parts.some((p) => p.includes(host))), `the plate's ${host}`);
	const bat = ravenRules.find((r) => r.parts.some((p) => /\[data-mark="working"\] > \.badge::after$/.test(p)) && /mask/.test(r.body));
	assert.ok(bat && /data:image\/svg\+xml/.test(bat.body), "the badge's bat is a mask of a small drawing");
	const bob = ravenRules.find((r) => r.parts.some((p) => /\[data-mark="waiting"\] > \.badge$/.test(p)) && animationOf(r.body).some((v) => /rk-bob/.test(v)));
	assert.ok(bob, "the waiting badge bobs slowly instead of hopping");
});

test("the perch (head page and map) animates only opacity: every keyframes set a .perch rule runs is compositor-only, and the map's strike veil and its perch share one gate", () => {
	const perchRules = ravenRules.filter((r) => r.parts.some((p) => /\.perch\b/.test(p)) && animationOf(r.body).some((v) => !/^none$/.test(v)));
	assert.ok(perchRules.length >= 4, `the perch's animations were read (${perchRules.length})`);
	const used = new Set<string>();
	for (const r of perchRules) for (const v of animationOf(r.body)) for (const { name } of shorthand(v)) used.add(name);
	assert.ok(used.has("rk-perch-dark") && used.has("rk-perch-turn"), "the strike is a fade of the dark copy; the head turn a fade of the turned frame");
	for (const name of used) {
		assert.ok(frames.has(name), `@keyframes ${name}`);
		const props = new Set<string>();
		for (const m of frames.get(name)!.matchAll(/\{([^{}]*)\}/g)) for (const [prop] of declarations(m[1]!)) props.add(prop);
		for (const prop of props) assert.ok(prop === "opacity" || prop === "transform", `@keyframes ${name} animates ${prop}, which is not compositor-only`);
	}
	assert.ok(!frames.has("rk-perch-lit"), "no filter animation is left");
	// one clock: the map's rest veil and its perch wait for the same condition (the band shown), so absent to open restarts neither
	const gate = (name: string) => perchOrVeil(name);
	function perchOrVeil(name: string) { return ravenRules.filter((r) => r.parts.length && animationOf(r.body).some((v) => v.startsWith(name)) && r.parts.some((p) => /data-view="map"/.test(p))).flatMap((r) => r.parts); }
	const veil = gate("rk-rest"), perch = gate("rk-perch-dark");
	assert.ok(veil.length > 0 && perch.length > 0, "both rules were read");
	for (const p of [...veil, ...perch]) { assert.match(p, /\.head-node:not\(\[hidden\]\)/, p); assert.doesNotMatch(p, /\.absent/, p); }
});
