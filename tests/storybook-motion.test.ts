import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { declarations, rulesOf, split } from "./css-rules.ts";

// Storybook's motion (docs/specs/2026-11-26-storybook-theme/spec.md §B3 status figures, §B6 ambient motion; the raven precedent, docs/specs/2026-11-07-raven-view/spec.md §1.5 and tests/raven-motion.test.ts). Where Standard sweeps a radar, spins a
// ring, pings, hops, and turns a spinner, the notebook draws a small figure on the badge (a short pencil, an envelope, a little flag, a crescent moon) that writes, lifts, sways, or naps; the map and head page carry clouds and butterflies by day and
// stars, fireflies, the moon's halo, and the lamplight by night. All of it moves or fades a fixed picture (transform and opacity), nothing cycles under 0.8 s, nothing turns, and calm, reduced motion, and forced colours stop it and keep still figures.
const root = fileURLToPath(new URL("..", import.meta.url));
const at = (path: string) => readFileSync(join(root, path), "utf8");
const css = at("gui/themes/storybook/storybook.css"), standard = at("gui/style.css");
const rules = rulesOf(css);
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every `@keyframes name { ... }` of a sheet: name to body (braces balanced). */
const keyframes = (sheet: string) => {
	const out = new Map<string, string>();
	for (const m of sheet.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
		let depth = 1, end = m.index! + m[0].length;
		while (end < sheet.length && depth > 0) depth += sheet[end] === "{" ? 1 : sheet[end] === "}" ? -1 : 0, end++;
		out.set(m[1]!, sheet.slice(m.index! + m[0].length, end - 1));
	}
	return out;
};
const frames = keyframes(strip(css));
/** The steps of a keyframe set in order: [percentages, declarations]. */
const steps = (body: string) => [...body.matchAll(/([\d.%,\sfromto]+)\{([^{}]*)\}/g)].map((m) => ({ at: m[1]!.split(",").map((p) => (p.trim() === "from" ? 0 : p.trim() === "to" ? 100 : Number.parseFloat(p))), decls: declarations(m[2]!) }));
/** The animations of one `animation` value: name, duration and delay (seconds). */
const shorthand = (value: string) => split(value.replace(/\s*!important$/, ""), ",").map((one) => one.trim()).filter(Boolean).map((one) => {
	const times = [...one.matchAll(/(?:^|\s)(-?\d*\.?\d+)s\b/g)].map((t) => Number(t[1]));
	return { name: /^[a-z][\w-]*/.exec(one)?.[0] ?? one, seconds: times[0] ?? NaN, delay: times[1] ?? 0 };
});
const animationOf = (body: string) => declarations(body).filter(([p]) => p === "animation").map(([, v]) => v);
/** The text inside the first `@media <query> {` block of the sheet (comments stripped). */
const block = (query: string) => {
	const text = strip(css), from = text.indexOf(`@media ${query} {`);
	assert.ok(from >= 0, `a ${query} block`);
	let depth = 1, end = text.indexOf("{", from) + 1;
	const start = end;
	while (end < text.length && depth > 0) depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0, end++;
	return text.slice(start, end - 1);
};
const motion = rulesOf(block("(prefers-reduced-motion: no-preference)"));
const inMotion = (r: { selector: string; body: string }) => motion.some((m) => m.selector === r.selector && m.body === r.body);
const GATE = ':has(#stage[data-stale]:is([data-view="head"], [data-view="map"]))';

// Standard's inherited status rules (gui/style.css): the six the spec names, and the waiting badge's hop. Each keeps its text.
const STANDARD: { what: string; rule: RegExp; host: RegExp }[] = [
	{ what: "the tower's working sweep", rule: /^\.tower\[data-mark="working"\] \.sweep \{ opacity: 1; animation: spin 3\.2s linear infinite; \}$/m, host: /\.tower\[data-mark="working"\] > \.sweep(?!::)/ },
	{ what: "the tower's waiting ping", rule: /^\.tower\[data-mark="waiting"\] \.pulse \{ animation: ping 1\.5s ease-out infinite; \}$/m, host: /\.tower\[data-mark="waiting"\] > \.pulse(?!::)/ },
	{ what: "the plate's working ring", rule: /^\.plate\[data-mark="working"\] > \.ring \{ opacity: 1; animation: spin 1\.1s linear infinite; \}$/m, host: /\.plate\[data-mark="working"\] > \.ring(?!::)/ },
	{ what: "the plate's waiting ping", rule: /^\.plate\[data-mark="waiting"\]::after \{ animation: ping 1\.5s ease-out infinite; \}$/m, host: /\.plate\[data-mark="waiting"\]::after/ },
	{ what: "the working badge's spinner", rule: /^\[data-mark="working"\] > \.badge::after \{ content: ""; width: 8px; height: 8px; border-radius: 50%; border: 2px solid var\(--ink\); border-right-color: transparent; animation: spin 0\.8s linear infinite; \}$/m, host: /\[data-mark="working"\] > \.badge::after|:is\(\[data-mark="working"\][^)]*\) > \.badge::after/ },
	{ what: "the connection ring's spin", rule: /^\.connect-ring \{[^}]*animation: spin 1\.1s linear infinite; \}$/m, host: /\.connect-ring(?!::)/ },
	{ what: "the waiting badge's hop", rule: /^\[data-mark="waiting"\] > \.badge \{ animation: hop 1\.2s ease-in-out infinite; \}$/m, host: /\[data-mark="waiting"\] > \.badge(?!::)/ },
];

test("Standard's spinning, pinging, and hopping rules are as they were: Storybook replaces them in its own sheet, never in style.css", () => {
	for (const s of STANDARD) assert.match(standard, s.rule, s.what);
	assert.match(standard, /@keyframes spin \{ to \{ transform: rotate\(360deg\); \} \}/);
});

test("Storybook overrides each of them with a rule of its own whose animation is none or a Storybook keyframe set, never Standard's spin, ping, or hop", () => {
	for (const s of STANDARD) {
		const own = rules.filter((r) => r.parts.some((p) => s.host.test(p)) && animationOf(r.body).length);
		assert.ok(own.length > 0, `${s.what}: Storybook sets its animation`);
		assert.ok(own.some((r) => !inMotion(r) && animationOf(r.body).every((v) => v === "none")), `${s.what}: a still rule stops it`);
		for (const r of own) for (const v of animationOf(r.body)) for (const { name } of shorthand(v)) assert.ok(name === "none" || frames.has(name), `${s.what}: ${name} is none or a keyframe set of storybook.css`);
	}
	assert.ok(!/\b(spin|ping|hop)\s+\d/.test(strip(css)), "no Standard keyframes named in the sheet");
});

test("every rule of the motion is scoped to the Storybook view, and no other view's sheet names a Storybook keyframe set", () => {
	for (const r of rules) for (const p of r.parts) assert.match(p, /^(html)?\[data-view="storybook"\]/, p);
	// a list that mixes an id with a tag (`:is(body, #stage)`) takes the id's weight, and the layer rules after it lose their pictures
	for (const r of rules) for (const p of r.parts) for (const m of p.matchAll(/:is\(([^()]*)\)/g)) assert.ok(!/#/.test(m[1]!) || m[1]!.split(",").every((a) => a.includes("#")), `${p}: an :is() that mixes an id with weaker selectors`);
	for (const file of ["gui/style.css", "gui/themes/geek/geek.css", "gui/zen.css", "gui/themes/raven/raven.css"]) assert.ok(!/\bsb-(write|mail|flag|nap|cloud|cross|wing|leaf|glint|halo|lamp|flick)\b/.test(at(file)), `${file} knows nothing of Storybook's keyframes`);
});

test("every keyframe set changes only transform and opacity, and nothing turns: no conic sweep, no full spin, a sway of at most 15 degrees", () => {
	assert.ok(frames.size >= 14, `the keyframes were read (${frames.size})`);
	for (const [name, body] of frames) {
		const props = new Set(steps(body).flatMap((s) => s.decls.map(([p]) => p)));
		assert.ok(props.size > 0, `@keyframes ${name} was read`);
		for (const prop of props) assert.ok(prop === "transform" || prop === "opacity" || prop === "animation-timing-function", `@keyframes ${name} animates ${prop}, which is not compositor-only`);
		assert.ok(!/conic|turn\b|skew|var\(--sb-(?!w\))/.test(body), `@keyframes ${name}: no conic, turn, skew, or custom property but the picture's width`);
		for (const deg of body.matchAll(/rotate\((-?\d*\.?\d+)deg\)/g)) assert.ok(Math.abs(Number(deg[1])) <= 15, `@keyframes ${name} sways ${deg[1]}deg, at most 15`);
	}
	assert.ok(!/conic-gradient|@property/.test(strip(css)), "no conic wedge and no registered property");
	// What moves is a fixed picture: no rule animates a background, mask, filter, or shadow through a transition either.
	for (const r of rules) for (const [p, v] of declarations(r.body)) if (p === "transition") assert.doesNotMatch(v, /background|mask|filter|shadow|all/, r.selector);
});

test("every animation sits in the no-preference block and stops at data-calm; outside it a rule only declares `animation: none`; forced colours stop the rest", () => {
	const moving = motion.filter((r) => animationOf(r.body).some((v) => v !== "none"));
	assert.ok(moving.length >= 18, `the animations were read (${moving.length})`);
	for (const r of moving) for (const p of r.parts) assert.match(p, /^html\[data-view="storybook"\](\[data-phase="(day|night)"\])?:not\(\[data-calm\]\)/, `${p} stops at data-calm`);
	for (const r of rules.filter((r) => !inMotion(r))) for (const v of animationOf(r.body)) assert.match(v, /^none( !important)?$/, `${r.selector}: outside the block only none (${v})`);
	const forced = block("(forced-colors: active)") + strip(css).split("@media (forced-colors: active) {").slice(2).join("");
	assert.match(forced, /\.badge, \.sweep, \.pulse, \.ring, \.connect-ring\)[^{]*\{ animation: none !important; \}/, "forced colours stop the figures and Standard's hosts");
	// the ambient layers exist only where no forced colours are
	const ambient = rules.filter((r) => r.parts.some((p) => p.includes(GATE)) && /content:\s*""/.test(r.body));
	assert.ok(ambient.length >= 6, `the ambient layers were read (${ambient.length})`);
	const unforced = [...strip(css).matchAll(/@media \(forced-colors: none\) \{/g)].flatMap((m) => {
		let depth = 1, end = m.index! + m[0].length;
		const text = strip(css);
		while (end < text.length && depth > 0) depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0, end++;
		return rulesOf(text.slice(m.index! + m[0].length, end - 1));
	});
	for (const r of ambient) assert.ok(unforced.some((u) => u.selector === r.selector && u.body === r.body), `${r.selector} draws only without forced colours`);
});

/** A selector's specificity as [ids, classes, types]: `:is`, `:not`, and `:has` count their most specific argument, `:where` nothing. */
function specificity(selector: string): [number, number, number] {
	let ids = 0, classes = 0, types = 0, rest = selector;
	const add = (s: [number, number, number]) => ((ids += s[0]), (classes += s[1]), (types += s[2]));
	for (;;) {
		const m = /:(is|not|has|where)\(/.exec(rest);
		if (!m) break;
		let depth = 1, end = m.index + m[0].length;
		while (depth > 0) depth += rest[end] === "(" ? 1 : rest[end] === ")" ? -1 : 0, end++;
		if (m[1] !== "where") add(split(rest.slice(m.index + m[0].length, end - 1), ",").map((a) => specificity(a.trim())).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0]!);
		rest = rest.slice(0, m.index) + " " + rest.slice(end);
	}
	ids += (rest.match(/#[\w-]+/g) ?? []).length;
	classes += (rest.match(/\.[\w-]+|\[[^\]]+\]|(?<!:):(?!:)[\w-]+/g) ?? []).length;
	types += (rest.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length + (rest.match(/::[\w-]+/g) ?? []).length;
	return [ids, classes, types];
}
const beats = (a: number[], b: number[]) => a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! > b[2]!;

test("each figure's motion outranks every still rule that stops the same layer, so the motion is never silently overridden", () => {
	assert.deepEqual(specificity('html[data-view="storybook"] :is([data-mark="a"], [data-mark="b"]:not(:where(.x .y))) > .badge::after'), [0, 3, 2]);
	for (const layer of ["> .badge::after", "> .badge::before", ".connect-ring::after"]) {
		const moving = motion.flatMap((r) => r.parts.filter((p) => p.endsWith(layer)));
		assert.ok(moving.length > 0, `the motion of ${layer} was read`);
		const stills = rules.filter((r) => !inMotion(r) && animationOf(r.body).length).flatMap((r) => r.parts.filter((p) => p.endsWith(layer)));
		for (const m of moving) for (const s of stills) assert.ok(beats(specificity(m), specificity(s)), `${m} (${specificity(m)}) outranks ${s} (${specificity(s)})`);
	}
});

test("no cycle is under 0.8 s, and nothing flashes more than 3 times a second", () => {
	const used = new Map<string, number>();
	for (const r of rules) for (const v of animationOf(r.body)) for (const { name, seconds } of shorthand(v)) if (name !== "none") used.set(name, Math.min(used.get(name) ?? Infinity, seconds));
	for (const name of frames.keys()) assert.ok(used.has(name), `@keyframes ${name} is used`);
	for (const [name, seconds] of used) {
		assert.ok(frames.has(name), `${name} is a keyframe set of the sheet`);
		assert.ok(seconds >= 0.8, `${name} cycles in ${seconds} s, at least 0.8`);
		// the opacity's peaks in a cycle, over the cycle's length
		const opacity = steps(frames.get(name)!).flatMap((s) => s.decls.filter(([p]) => p === "opacity").map(([, v]) => s.at.map((p) => [p, Number(v)] as const))).flat().sort((a, b) => a[0] - b[0]).map(([, v]) => v);
		const peaks = opacity.filter((v, i) => i > 0 && i < opacity.length - 1 && v > opacity[i - 1]! && v >= opacity[i + 1]!).length || (opacity.length ? 1 : 0);
		assert.ok(peaks / seconds <= 3, `${name}: ${peaks} flashes in ${seconds} s`);
	}
	assert.equal(used.get("sb-write"), 3.8, "the pencil writes in 3.8 s");
	assert.equal(used.get("sb-mail"), 4.2, "the envelope lifts in 4.2 s");
	assert.equal(used.get("sb-flag"), 4.8, "the flag sways in 4.8 s");
	assert.equal(used.get("sb-nap"), 6.4, "the moon's stars rise in 6.4 s");
});

test("the still figures: each state's badge draws a figure of its own shape in the state's colour, the state word repeats it, and the radar's layers are not drawn", () => {
	const fig = (mark: string) => rules.find((r) => r.parts.some((p) => p === `html[data-view="storybook"] [data-mark="${mark}"]`))?.body.match(/--sb-fig:\s*var\((--sb-[a-z]+)\)/)?.[1];
	const figures = ["working", "waiting", "error", "idle"].map(fig);
	assert.deepEqual(figures, ["--sb-pencil", "--sb-envelope", "--sb-flag", "--sb-moon"]);
	const pictures = figures.map((f) => new RegExp(`${f}:\\s*(url\\("[^"]+"\\))`).exec(css)?.[1]);
	for (const p of pictures) assert.ok(p && p.length < 600, "a small drawing for each figure");
	assert.equal(new Set(pictures).size, 4, "four different drawings: the states differ in shape, not hue alone");
	const still = rules.find((r) => !inMotion(r) && r.parts.some((p) => /> \.badge::after$/.test(p) && p.includes('[data-mark="idle"]')));
	assert.ok(still && /mask: var\(--sb-fig\)/.test(still.body) && /background: var\(--c\)/.test(still.body) && /animation: none/.test(still.body), "the badge's figure is a still mask in the state's colour");
	assert.ok(rules.some((r) => !inMotion(r) && r.parts.some((p) => /\.card :is\(\.note, \.dstate\)::before$/.test(p)) && /mask: var\(--sb-fig\)/.test(r.body)), "the card's state word carries the figure (review P2)");
	for (const mark of ["working", "waiting", "error", "idle"]) assert.ok(rules.some((r) => r.parts.some((p) => p.endsWith(`.tower[data-mark="${mark}"] + .title .tstate::after`)) && /--sb-fig:/.test(r.body)), `a tower's line carries the ${mark} figure`);
	const radar = rules.find((r) => r.parts.some((p) => /\.tower\[data-mark="working"\] > \.sweep$/.test(p)) && /opacity: 0/.test(r.body));
	assert.ok(radar && radar.parts.length === 4, "the sweep, the ping, the ring, and the plate's ping are stopped and hidden together");
	assert.match(css, /\.connect:is\(\[data-state="offline"\], \[data-state="replaced"\]\) \.connect-ring::after \{[^}]*mask-image: var\(--sb-flag\)/, "a stream that gave up shows the flag, not the envelope");
	assert.ok(motion.every((r) => !/train-wait/.test(r.selector) || /:not\(li, \.unit\[data-train-wait\] \.plate\)/.test(r.selector)), "a train's waiting idle keeps its own badge");
});

test("the ambient layers (§B6): on the map and the head page only, timed as the spec says, fewer on a phone, and the ephemeral ones drawn only while they move", () => {
	const gated = rules.filter((r) => r.parts.some((p) => p.includes(":has(#stage") && /::(before|after)$/.test(p) && !/comms-head/.test(p)));
	for (const r of gated) for (const p of r.parts) assert.ok(p.includes(GATE), `${p} waits for the routed map or head page`);
	const anim = (re: RegExp) => motion.filter((r) => r.parts.some((p) => re.test(p))).flatMap((r) => animationOf(r.body).flatMap(shorthand));
	const day = (tail: string) => new RegExp(`^html\\[data-view="storybook"\\]\\[data-phase="day"\\].*${tail}$`), night = (tail: string) => new RegExp(`^html\\[data-view="storybook"\\]\\[data-phase="night"\\].*${tail}$`);
	assert.deepEqual([...anim(day("\\)\\)::before")), ...anim(day("\\)\\)::after"))].map((a) => a.seconds), [150, 210], "two cloud strips, 150 s and 210 s");
	const crossings = [...anim(day(" body::before")), ...anim(day(" #stage::before"))].filter((a) => a.name === "sb-cross");
	assert.equal(crossings.length, 2, "two butterflies");
	const gap = Math.abs(crossings[0]!.delay - crossings[1]!.delay) % 88;
	assert.ok(crossings.every((c) => c.seconds === 88) && Math.min(gap, 88 - gap) >= 40, "at most one crossing per 40 s");
	for (const tail of [" body::after", " #stage::after"]) assert.deepEqual(anim(day(tail)).map((a) => a.name).sort(), ["sb-cross-wings", "sb-wing"], "the wings are a second layer that swaps by opacity on the body's path");
	assert.equal(anim(day(" #work::before"))[0]?.name, "sb-leaf", "a leaf drifts down");
	const stars = [" body::before", " body::after", " #stage::before"].map((t) => anim(night(t))[0]!);
	for (const s of stars) assert.ok(s.name === "sb-glint" && s.seconds >= 4 && s.seconds <= 7, "stars twinkle on 4 to 7 s");
	assert.equal(new Set(stars.map((s) => `${s.seconds}/${s.delay}`)).size, 3, "three groups out of phase");
	const flies = [" #stage::after", " #work::before", " #work::after"].map((t) => anim(night(t))[0]!);
	for (const f of flies) assert.ok(f.name === "sb-flick" && f.seconds >= 9 && f.seconds <= 14, "fireflies wander on 9 to 14 s");
	assert.equal(new Set(flies.map((f) => f.seconds)).size, 3, "out of phase");
	assert.deepEqual([anim(night("\\)\\)::after"))[0]?.seconds, anim(night("\\)\\)::before"))[0]?.seconds], [8, 5.3], "the halo breathes in 8 s, the lamplight in 5.3 s");
	const lamp = rules.find((r) => !inMotion(r) && r.parts.some((p) => night("\\)\\)::before").test(p)))!;
	for (const a of lamp.body.matchAll(/rgb\(\d+ \d+ \d+ \/ ([\d.]+)\)/g)) assert.ok(Number(a[1]) <= 0.16, "the lamplight is at most 16 percent alpha");
	// the butterflies, the leaf, and the fireflies exist only in the motion block: calm and reduced motion draw the still picture
	for (const r of rules.filter((r) => !inMotion(r) && r.parts.some((p) => p.includes(GATE)))) for (const p of r.parts) assert.ok(!/(#work::|data-phase="day".*(body|#stage)::|data-phase="night".*#stage::after)/.test(p), `${p}: an ephemeral layer outside the motion block`);
	// a phone: one butterfly, three fireflies (one radial pair each)
	const phone = rulesOf(/@media \(max-width: 600px\) \{([\s\S]*?)\n\t\t\}/.exec(block("(prefers-reduced-motion: no-preference)"))?.[1] ?? "");
	assert.ok(phone.some((r) => r.parts.every((p) => /#stage::(before|after)$/.test(p) && p.includes('data-phase="day"')) && /content: none/.test(r.body)), "a phone has one butterfly");
	const onPhone = phone.filter((r) => r.parts.some((p) => p.includes('data-phase="night"')));
	assert.equal(onPhone.length, 3);
	for (const r of onPhone) assert.equal((r.body.match(/radial-gradient/g) ?? []).length, 2, "one firefly per layer on a phone");
	// no IntersectionObserver runs beside them (a frame every vsync, raven's measurement)
	for (const name of readdirSync(join(root, "gui/themes/storybook")).filter((n) => n.endsWith(".ts"))) assert.doesNotMatch(at(`gui/themes/storybook/${name}`), /IntersectionObserver/, name);
});
