import assert from "node:assert/strict";
import { test } from "node:test";
import { type Choice, mountView, resolve, type ViewEnv } from "../gui/view.ts";
import { mountMode } from "../gui/mode.ts";
import { type At, faceAfter, type Move, mountFace, zenShows } from "../gui/viewface.ts";

// The page's face when something moves it (gui/viewface.ts, docs/specs/2026-11-26-storybook-theme/spec.md Part A): every control that moves it (the header's Zen button, Esc Esc and the exits, the settings page's picks,
// another tab's pick, the settings route, a new server default, the OS) walked from every start (mode × route × theme), against a plain statement of what the person should see.

const CHOICES: Choice[] = ["auto", "standard", "geek", "raven"];
const SERVERS: Choice[] = ["auto", "standard", "geek", "raven"];

/** The page as the main module wires it: a real view and mode on a fake storage and root, the face coordinator, and a route that is settings or not. */
function page(stored: Choice, server: Choice, start: At, contrast = false) {
	const root: ViewEnv["root"] = { dataset: {} };
	let listener: (() => void) | undefined;
	const kept = new Map([["sb.view", stored as string], ["sb.zen", start.mode ? "1" : "0"]]);
	const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
	const world = { settings: start.settings, draws: 0, left: 0 };
	const mode = mountMode(storage), shows = () => zenShows({ mode: mode.on(), settings: world.settings });
	const env: ViewEnv = { root, meta: { content: "#1a1b26" }, server: { content: server }, media: { matches: contrast, addEventListener: (_: "change", fn: () => void) => (listener = fn) }, storage };
	const view = mountView(env, shows);
	const face = mountFace({
		view, mode, settings: () => world.settings,
		leaveSettings: () => ((world.left += 1), (world.settings = false), face.route(false)), // the page's Back, then the router's navigate
		draw: () => void (world.draws += 1),
	});
	return { view, mode, face, world, root, kept, shows, flip: (v: boolean) => ((env.media.matches = v), listener?.()), pick: (c: Choice) => view.set(c) };
}

const starts = () => CHOICES.flatMap((stored) => SERVERS.flatMap((server) => [false, true].flatMap((mode) => [false, true].map((settings) => ({ stored, server, mode, settings })))));
const label = (s: { stored: Choice; server: Choice; mode: boolean; settings: boolean }) => `theme ${s.stored}, server ${s.server}, mode ${s.mode ? "on" : "off"}, ${s.settings ? "on settings" : "on a page"}`;
/** What the person should see: Zen while the mode is on off the settings page, else the device's theme. */
const want = (theme: string, at: At) => (at.mode && !at.settings ? "zen" : theme);

test("every move from every start: the mode and the theme are two axes, and the face is Zen exactly while the mode is on off the settings page", () => {
	const moves: [string, (p: ReturnType<typeof page>) => void, (s: At) => At][] = [
		["enter", (p) => p.face.enter(), () => ({ mode: true, settings: false })], // from the settings page the page leaves it first
		["leave", (p) => p.face.leave(), (s) => ({ mode: false, settings: s.settings })],
		["route on", (p) => ((p.world.settings = true), p.face.route(true)), (s) => ({ mode: s.mode, settings: true })],
		["route off", (p) => ((p.world.settings = false), p.face.route(false)), (s) => ({ mode: s.mode, settings: false })],
		...CHOICES.map((c): [string, (p: ReturnType<typeof page>) => void, (s: At) => At] => [`pick ${c}`, (p) => p.pick(c), (s) => s]),
		["follow (contrast)", (p) => p.flip(true), (s) => s],
		["follow (server geek)", (p) => p.view.setServer("geek"), (s) => s],
	];
	let cells = 0;
	for (const s of starts()) for (const [name, run, after] of moves) {
		const p = page(s.stored, s.server, s);
		run(p);
		const at = `${label(s)} → ${name}`, now = after(s), theme = p.view.view();
		cells++;
		assert.deepEqual([p.mode.on(), p.world.settings], [now.mode, now.settings], `${at}: mode and route`);
		assert.equal(p.root.dataset.view, want(theme, now), `${at}: the face`);
		assert.equal(p.kept.get("sb.zen"), now.mode !== s.mode ? (now.mode ? "1" : "0") : s.mode ? "1" : "0", `${at}: sb.zen is written only when the mode moved`);
		if (!name.startsWith("pick")) assert.equal(p.kept.get("sb.view"), s.stored, `${at}: the theme's choice is untouched`);
		if (name === "enter") assert.equal(p.world.left, s.settings ? 1 : 0, `${at}: the settings page is left by its Back`);
	}
	assert.ok(cells > 500, `${cells} cells walked`);
});

test("leaving Zen shows the device's theme, Raven Keep or Geek included, never Standard by itself", () => {
	for (const [stored, server, contrast, expected] of [["raven", "auto", false, "raven"], ["auto", "auto", true, "geek"], ["auto", "raven", false, "raven"], ["geek", "standard", false, "geek"], ["auto", "auto", false, "standard"]] as const) {
		const p = page(stored, server, { mode: true, settings: false }, contrast);
		assert.equal(p.root.dataset.view, "zen");
		p.face.leave();
		assert.equal(p.root.dataset.view, expected, `${stored}/${server}/${contrast}`);
		assert.equal(resolve(stored, contrast, server), expected);
	}
});

test("the settings route suspends Zen and does not end it; a theme picked there stays on the page and the mode stays on", () => {
	const p = page("standard", "auto", { mode: true, settings: false });
	p.world.settings = true;
	p.face.route(true);
	assert.deepEqual([p.root.dataset.view, p.mode.on()], ["standard", true]);
	p.pick("raven");
	assert.deepEqual([p.root.dataset.view, p.world.settings, p.mode.on(), p.world.left], ["raven", true, true, 0], "the pick shows its theme on the settings page");
	p.world.settings = false;
	p.face.route(false);
	assert.equal(p.root.dataset.view, "zen", "leaving the settings page shows Zen again");
	p.face.leave();
	assert.equal(p.root.dataset.view, "raven", "and leaving Zen the theme picked there");
});

test("the Zen button on the settings page leaves the page and shows Zen", () => {
	const p = page("geek", "auto", { mode: false, settings: true });
	p.face.enter();
	assert.deepEqual([p.world.left, p.world.settings, p.mode.on(), p.root.dataset.view], [1, false, true, "zen"]);
});

test("a theme change under a page in Zen never touches its face (Z-D20): a pick, another tab's pick, the server's default, the screen", () => {
	const p = page("auto", "auto", { mode: true, settings: false });
	p.pick("geek");
	p.kept.set("sb.view", "raven");
	p.view.reread();
	p.view.setServer("standard");
	p.flip(true);
	assert.deepEqual([p.root.dataset.view, p.mode.on(), p.view.view()], ["zen", true, "raven"]);
});

test("the table itself, stated", () => {
	const at = (mode: boolean, settings: boolean): At => ({ mode, settings });
	const rows: [Move, At, ReturnType<typeof faceAfter>][] = [
		[{ on: "enter" }, at(false, false), { mode: true, settings: false, leaveSettings: false }],
		[{ on: "enter" }, at(false, true), { mode: true, settings: true, leaveSettings: true }],
		[{ on: "enter" }, at(true, true), { mode: true, settings: true, leaveSettings: true }],
		[{ on: "leave" }, at(true, false), { mode: false, settings: false, leaveSettings: false }],
		[{ on: "pick" }, at(true, false), { mode: true, settings: false, leaveSettings: false }],
		[{ on: "follow" }, at(true, true), { mode: true, settings: true, leaveSettings: false }],
		[{ on: "route", settings: true }, at(true, false), { mode: true, settings: true, leaveSettings: false }],
		[{ on: "route", settings: false }, at(true, true), { mode: true, settings: false, leaveSettings: false }],
	];
	for (const [move, from, to] of rows) assert.deepEqual(faceAfter(move, from), to, `${JSON.stringify(move)} from ${JSON.stringify(from)}`);
	assert.deepEqual([zenShows(at(true, false)), zenShows(at(true, true)), zenShows(at(false, false))], [true, false, false]);
});
