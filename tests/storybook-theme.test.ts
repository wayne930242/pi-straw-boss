/// <reference types="vite/client" />
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { CHOICES, VIEWS } from "../src/views.ts";
import { VIEW_ARGUMENTS } from "../src/bossviews.ts";
import { rulesOf } from "./css-rules.ts";

// The Storybook view (繪本, docs/specs/2026-11-26-storybook-theme/spec.md §B1, §B2, §B3, SB-D4): one more name in src/views.ts and a folder under gui/themes/, with no words of its own; its waiting badge follows the phase; the
// look is the boss's pick B (washi tape, paper grain, a hand-drawn line, ruled lines on the question card), drawn by static pictures and never by a moving filter.
// The theme's entry imports its stylesheet: a stylesheet is an empty module here (no browser runs), so the entry's exports can be read.
registerHooks({ load(url, context, next) {
	if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
	if (url.endsWith(".svg?raw")) return { format: "module", source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))}`, shortCircuit: true };
	return next(url, context);
} });
const at = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const css = at("gui/themes/storybook/storybook.css");

test("storybook is a view: in the one list, the server's completions, the settings control, the names, and the theme registry", () => {
	assert.ok((VIEWS as readonly string[]).includes("storybook") && (CHOICES as readonly string[]).includes("storybook"));
	assert.equal(VIEW_ARGUMENTS["gui view storybook"], "Default view: Storybook (a picture-book skin of Standard: watercolour by day, a starry night after dark) for devices that follow the server");
	assert.match(at("gui/index.html"), /data-choice="storybook" aria-pressed="false" data-m="view_storybook">Storybook<\/button>/);
	assert.equal(JSON.parse(at("gui/messages/en.json")).view_storybook, "Storybook");
	assert.equal(JSON.parse(at("gui/messages/zh-TW.json")).view_storybook, "繪本");
	assert.match(at("gui/themes/registry.ts"), /storybook: \(\) => import\("\.\/storybook\/index\.ts"\)/);
	assert.match(at("gui/faces.ts"), /storybook: standard/, "Standard's rules");
});

test("the theme brings no nouns and no sentences (every word is Standard's), and its badge follows the phase", async () => {
	const { theme } = await import("../gui/themes/storybook/index.ts");
	assert.equal(theme.nouns, undefined);
	assert.equal(theme.sentences, undefined);
	assert.equal(theme.sprite, at("gui/themes/storybook/sprite.svg"));
	assert.ok(Buffer.byteLength(theme.sprite) <= 30_000);
	assert.deepEqual([...theme.sprite.matchAll(/<symbol id="storybook-([^"]+)" viewBox="[^"]+" fill="currentColor">/g)].map(m => m[1]).sort(),
		["comms", "crown", "doc", "main", "member", "outpost", "outside", "subagent", "tower", "user"]);
	assert.equal(typeof theme.badge, "function");
	assert.deepEqual((theme.badge as () => unknown)(), { dot: "#e0902b", ring: "#fbf5e9", text: "#3a3150" }, "no page here: the day's");
	assert.equal(typeof theme.onShift, "function");
	assert.equal(typeof theme.recheck, "function");
	const src = at("gui/themes/storybook/index.ts");
	assert.match(src, /night: \{ dot: "#ffd37e", ring: "#111a35", text: "#111a35" \}/);
});

test("the favicon is a plum line drawing on a cream disc, small", () => {
	const icon = at("gui/themes/storybook/favicon.svg");
	assert.match(icon, /<circle cx="16" cy="16" r="15.5" fill="#fbf5e9"\/>/);
	assert.match(icon, /<use href="#storybook-user"/);
	assert.match(icon, /stroke="#3a3150"/);
	assert.ok(icon.length < 4000, `${icon.length} bytes`);
});

test("the notebook look: washi tape, paper grain, a hand-drawn line per phase, ruled lines on the question card, a rounded heading face; no web font", () => {
	for (const block of ['[data-view="storybook"] {', '[data-view="storybook"][data-phase="night"] {']) {
		const body = css.slice(css.indexOf(block), css.indexOf("}", css.indexOf(block)));
		for (const token of ["--sb-frame", "--sb-rule", "--sb-grain", "--sb-tape", "--sb-ruled"]) assert.ok(body.includes(`${token}:`), `${block} sets ${token}`);
	}
	assert.match(css, /--sb-frame: url\("data:image\/svg\+xml,%3Csvg xmlns='http:\/\/www\.w3\.org\/2000\/svg' width='48' height='48'/, "the frame has a size of its own, so border-image slices it 1 : 1");
	assert.match(css, /border-image: var\(--sb-frame\) 14 \/ 14px round/);
	assert.match(css, /\.ask \{[^}]*repeating-linear-gradient\(transparent 0 23px, var\(--sb-ruled\) 23px 24px\)/, "the question card is ruled");
	assert.match(css, /:is\(\.base, \.dialog, \.head-node\)::after \{ content: ""[^}]*clip-path: polygon/, "the tape has torn ends");
	assert.match(css, /--sb-round: ui-rounded, "SF Pro Rounded", system-ui/);
	assert.ok(!/@font-face|@import|https?:\/\/(?!www\.w3\.org)/.test(css), "nothing fetched from elsewhere");
	for (const grain of css.matchAll(/--sb-grain: (url\("[^"]+"\))/g)) assert.ok(grain[1]!.length < 2048, `the grain is under 2 KB (${grain[1]!.length})`);
});

test("no picture, figure, or filter moves: the sheet has no animation, no keyframes, and no transition of a filter (B-4 brings the status figures under its rules)", () => {
	assert.ok(!/@keyframes|animation\s*:/.test(css), "nothing animates in B-1");
	assert.ok(!/transition[^;]*filter/.test(css));
	assert.ok(!/(?<![-\w])filter:\s*url/.test(css), "no SVG filter on a page element: the grain's filter lives inside its own static image");
});

test("every rule hangs on the view (the phase only refines it), so another view never takes one", () => {
	for (const rule of rulesOf(css)) for (const part of rule.parts) assert.match(part, /^(html)?\[data-view="storybook"\]/, part);
});

test("only a wide Storybook map makes room beside the bases for the treehouse", () => {
	const gutters = rulesOf(css).filter((rule) => rule.selector.includes(".map") && /margin-left:/.test(rule.body));
	assert.deepEqual(gutters.map((rule) => rule.selector), ['html[data-view="storybook"] #stage[data-view="map"] .map']);
	assert.match(css, /@media \(min-width: 1280px\)\s*\{\s*html\[data-view="storybook"\] #stage\[data-view="map"\] \.map \{[^}]*margin-left:/);
});

test("forced colours draw no tape and no hand-drawn line", () => {
	const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
	assert.match(forced, /border-image: none !important/);
	assert.match(forced, /::after \{ display: none; \}/);
});

test("the theme folder holds its entry, stylesheet, favicon, and phase clock", () => {
	for (const file of ["index.ts", "storybook.css", "favicon.svg", "phase.ts"]) assert.ok(existsSync(new URL(`../gui/themes/storybook/${file}`, import.meta.url)), file);
});
