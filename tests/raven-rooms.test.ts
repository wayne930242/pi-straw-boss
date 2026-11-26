import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const room = (role: keyof typeof ROOMS, part: "before" | "after") => (role === "other" ? `${PAGE}]:not([data-role="tower"], [data-role="main"], [data-role="subagent"])) [data-slot="backdrop"] > :nth-child(${part === "before" ? 1 : 7})` : `${PAGE}="${role}"]) [data-slot="backdrop"] > :nth-child(${part === "before" ? 1 : 7})`);
const ANY = (part: "before" | "after") => `${PAGE}]) [data-slot="backdrop"] > :nth-child(${part === "before" ? 1 : 7})`;

/** A lossy WebP's size, read from its VP8 frame header. */
const sizeOf = (file: Buffer) => {
	assert.equal(file.subarray(0, 4).toString(), "RIFF");
	assert.equal(file.subarray(8, 12).toString(), "WEBP");
	assert.equal(file.subarray(12, 16).toString(), "VP8 ", "a lossy WebP");
	return { width: file.readUInt16LE(26) & 0x3fff, height: file.readUInt16LE(28) & 0x3fff };
};

test("the four rooms are WebP pictures of 1280 by 800 and at most 44 KB each", () => {
	for (const name of Object.values(ROOMS)) {
		const file = readFileSync(join(dir, name));
		assert.ok(file.length <= 44_000, `${name} is ${file.length} bytes`);
		assert.deepEqual(sizeOf(file), { width: 1280, height: 800 }, name);
	}
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
	const peak = Math.max(...[...raw.matchAll(/session-view\[data-role[^{]*:nth-child\(7\)\s*\{[^}]*\}/g)].flatMap((m) => [...m[0].matchAll(/rgb\(255 190 92 \/ ([\d.]+)\)/g)].map((x) => Number(x[1]))));
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
	assert.match(readFileSync(join(root, "gui/style.css"), "utf8"), /@media \(forced-colors: active\) \{ \[data-slot\] \{ display: none !important;/, "the whole backdrop is hidden");
});
