import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rulesOf } from "./css-rules.ts";

// The chat page's rooms in Raven Keep (boss, 2026-11-08: 「管家書房、血僕大廳不錯，蝙蝠可以給墓穴」; spec §1.5 "On the chat page"): the unit's page behind its comms shows a quiet picture by the unit's role, under a dark veil, and no other view or page has one.
// The page marks its unit's role (`#session-view[data-role]`, gui/session.ts); the stylesheet picks the picture from it, so only the shown role's file is ever fetched.
const root = fileURLToPath(new URL("..", import.meta.url));
const dir = join(root, "gui/themes/raven");
const raw = readFileSync(join(dir, "raven.css"), "utf8"), css = rulesOf(raw);
const body = (selector: string) => css.filter((r) => r.parts.includes(selector)).map((r) => r.body).join(";");
const ROOMS = { tower: "room-study.webp", main: "room-hall.webp", subagent: "room-crypt.webp", other: "room-library.webp" } as const;
const PAGE = 'html[data-view="raven"]:has(#stage[data-view="session"] #session-view[data-role';
const room = (role: keyof typeof ROOMS, part: "before" | "after") => (role === "other" ? `${PAGE}]:not([data-role="tower"], [data-role="main"], [data-role="subagent"]))::${part}` : `${PAGE}="${role}"])::${part}`);
const ANY = (part: "before" | "after") => `${PAGE}])::${part}`;

/** A lossy WebP's size, read from its VP8 frame header. */
const sizeOf = (file: Buffer) => {
	assert.equal(file.subarray(0, 4).toString(), "RIFF");
	assert.equal(file.subarray(8, 12).toString(), "WEBP");
	assert.equal(file.subarray(12, 16).toString(), "VP8 ", "a lossy WebP");
	return { width: file.readUInt16LE(26) & 0x3fff, height: file.readUInt16LE(28) & 0x3fff };
};

test("the four rooms are WebP pictures of 1280 by 800 and at most 44 KB each, and the theme folder's source stays within its cap (the built folder holds the spec's 450 KB)", () => {
	for (const name of Object.values(ROOMS)) {
		const file = readFileSync(join(dir, name));
		assert.ok(file.length <= 44_000, `${name} is ${file.length} bytes`);
		assert.deepEqual(sizeOf(file), { width: 1280, height: 800 }, name);
	}
	const total = (path: string): number => readdirSync(path, { withFileTypes: true }).reduce((sum, e) => sum + (e.isDirectory() ? total(join(path, e.name)) : statSync(join(path, e.name)).size), 0);
	// The source folder holds the stylesheet with its comments, which the build strips: the spec's 450 KB is the built folder's (tests/imports.test.ts caps it, 425,889 bytes measured). The source folder was 449,505 bytes before the glass (todo #138: +8,064, raven.css's glass, phone frame and strike blocks with their reasons) and 457,569 after round 1; round 2 (the lit head turn, the head page's thin glass and backings, the phone's strip) measured 461,146 (+3,577); round 3 (the bolt layer, the perch's place, the backings, with their reasons) measured 466,807 (+5,661); the head turn as a swap and the flyer at one speed (boss, 2026-11-09) measured 468,594 (+1,787, most of it the reasons). Cap = measured + 500.
	// Wait cards on the question panel (todo #144 task 5; measured): 469,094 to 469,670 (+576: the 15 `_head` sentences in sentences.ts, and the ornament exclusions for a card nested in the tower card in raven.css). Cap = measured.
	// Wait-card review fixes (todo #145): 469,670 to 469,710 (+40: the `wait_sent_head` sentence). Cap = measured.
	// Supply board (2026-11-24, docs/specs/2026-11-24-capacity-supply/spec.md; measured): 469,710 to 478,004 (+8,294: the crypt's rules in raven.css with their reasons, the supply words in sentences.ts in both languages, and six sprite symbols). The built folder stays under the spec's 450 KB (tests/imports.test.ts). Cap = measured.
	// Sounds only for what waits on the boss, and Raven's recorded weather (2026-11-24, docs/specs/2026-11-24-capacity-supply/spec.md, Sound; measured): 478,004 to 487,809 (+9,805: the clips go from 21,300 bytes (bell, caw, door) to 29,786 (Casper's bell, rain, thunder), and weather.ts's clip loader and its reasons replace the synthesized rain and thunder). The built folder stays under the spec's 450 KB (446,985 bytes, tests/imports.test.ts). Cap = measured. The seven kind icons (2026-11-26, fde71e0e, boss-accepted) add 2,298: 490,107; built folder 449,283.
	assert.ok(total(dir) <= 490_107, `the raven folder is ${total(dir)} bytes`);
});

test("the sprite's blood goblet (血僕) and keep (鴉閣) are bold shapes, not traced engravings: each symbol is at most 3 KB, so no thorn or tracery detail is left to blur at 16 px", () => {
	const sprite = readFileSync(join(dir, "sprite.svg"), "utf8");
	for (const id of ["raven-main", "raven-crown"]) {
		const symbol = new RegExp(`<symbol id="${id}"[\\s\\S]*?</symbol>`).exec(sprite)?.[0] ?? "";
		assert.ok(symbol.length > 0 && symbol.length <= 3_000, `${id} is ${symbol.length} bytes`);
		assert.ok(!/<g transform/.test(symbol), `${id} is a path drawn upright, not a flipped trace`);
	}
});

test("each role has its room, and each room is named by exactly one rule: tower the study, main the great hall, subagent the crypt, every other role the library, the picture and its veil on ::before", () => {
	for (const [role, file] of Object.entries(ROOMS) as [keyof typeof ROOMS, string][]) {
		const rule = body(room(role, "before"));
		assert.ok(rule.includes(`url("./${file}")`), `${role}: ${file}`);
		assert.match(rule, /var\(--rk-veil\)/, `${role} draws its veil over the picture`);
		for (const other of Object.values(ROOMS).filter((f) => f !== file)) assert.ok(!rule.includes(other), `${role} names no other room (${other})`);
	}
	for (const file of Object.values(ROOMS)) assert.equal([...raw.matchAll(new RegExp(`url\\("\\./${file}"\\)`, "g"))].length, 1, `${file} is named once, in its role's rule`);
	// a page whose role is not yet known (the comms are opening) fetches nothing
	assert.ok(!body(ANY("before")).includes("url("), "the shared rule names no picture");
	});

test("the rooms belong to the chat page alone: every room rule starts at the raven view and the session stage, and the head page, the map, and the other pages name none", () => {
	const rules = css.filter((r) => /session-view\[data-role/.test(r.selector));
	assert.ok(rules.length >= 8, `${rules.length} room rules`);
	for (const r of rules) for (const p of r.parts.filter((x) => /session-view\[data-role/.test(x))) assert.match(p, /^html\[data-view="raven"\](?::not\(\[data-calm\]\))?:has\(#stage\[data-view="session"\] #session-view\[data-role/, `${p} is scoped to the raven view and the session stage`);
	for (const r of css.filter((x) => /data-view="(head|map|workspace|settings)"/.test(x.selector))) assert.ok(!/room-/.test(r.body), `${r.selector} names no room`);
	assert.ok(!/data-view="(workspace|settings)"/.test(raw), "the workspace and settings pages stay plain");
});

test("the veil is #0d0a10 at 55 percent at the top, 62 at 70 percent, and 80 at the foot, over a picture that covers the page; the page's text keeps its own grounds", () => {
	const shared = body(ANY("before"));
	assert.match(shared, /position:\s*fixed/);
	assert.match(shared, /inset:\s*0/);
	assert.match(shared, /z-index:\s*-1/);
	assert.match(shared, /--rk-veil:\s*linear-gradient\(rgb\(13 10 16 \/ 0\.55\), rgb\(13 10 16 \/ 0\.62\) 70%, rgb\(13 10 16 \/ 0\.8\)\)/);
	assert.match(shared, /background-size:\s*cover, cover/, "the picture and its veil cover the page");
	// the crumbs sit on the picture itself: they take the keep's ground like the map's legend; a phone's full-screen comms take the translucent ground instead of the opaque one
	assert.match(body(`${PAGE}]) .crumbs`), /background:\s*var\(--rk-well\)/);
	assert.match(body(`${PAGE}]) .comms-in`), /background:\s*var\(--well\)/);
});

test("the candle light breathes by opacity alone, in the no-preference block outside data-calm; calm, reduced motion, and forced colours keep still light or none, and no lightning is in a room", () => {
	const light = body(ANY("after"));
	assert.match(light, /position:\s*fixed/);
	const peak = Math.max(...[...raw.matchAll(/session-view\[data-role[^{]*::after\s*\{[^}]*\}/g)].flatMap((m) => [...m[0].matchAll(/rgb\(255 190 92 \/ ([\d.]+)\)/g)].map((x) => Number(x[1]))));
	assert.ok(peak > 0 && peak <= 0.16, `the light's peak alpha is ${peak}`);
	const frames = /@keyframes rk-room-candle \{((?:[^{}]|\{[^{}]*\})*)\}/.exec(raw)?.[1] ?? "";
	assert.ok(frames.length > 0, "the candle keyframes exist");
	assert.ok(!/(?:^|[{;\s])(?!opacity\b)[a-z-]+\s*:/.test(frames.replace(/\d[\d.%,\s]*\{/g, "{").replace(/\{\s*opacity:\s*[\d.]+\s*;?\s*\}/g, "{}")), "the keyframes set opacity and nothing else");
	const inMotion = [...raw.matchAll(/@media \(prefers-reduced-motion: no-preference\) \{((?:[^{}]|\{[^{}]*\})*)\}/g)].map((m) => m[1]).join("\n");
	const animated = rulesOf(inMotion).filter((r) => /rk-room-candle/.test(r.body));
	assert.ok(animated.length >= 1, "the candle runs in the no-preference block");
	for (const r of animated) for (const p of r.parts) assert.match(p, /:not\(\[data-calm\]\)/, `${p} stops at data-calm`);
	assert.ok(!/animation[^;}]*rk-room-candle/.test(raw.replace(inMotion, "")), "no candle animation outside the block");
	assert.match(light, /opacity:\s*0?\.[5-9]/, "the still light holds a middle opacity");
	assert.ok(!/rk-bolt|rk-rest/.test(rulesOf(inMotion).filter((r) => /session-view/.test(r.selector)).map((r) => r.body).join(";")), "no lightning in a room");
	const forced = [...raw.matchAll(/@media \(forced-colors: active\) \{([^\n]*)\}/g)].map((m) => m[1]).join("\n");
	for (const part of ["before", "after"] as const) assert.ok(forced.includes(ANY(part)), `forced colours hide ${ANY(part)}`);
});
