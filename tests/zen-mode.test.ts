import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { VIEW_ARGUMENTS } from "../src/bossviews.ts";
import { MODES, VIEWS } from "../src/views.ts";
import { mountMode } from "../gui/mode.ts";
import { manifests, THEME } from "./theme-fixture.ts";
import { choiceOf, mountView, resolve, type ViewEnv } from "../gui/view.ts";
import { mountFace, zenShows } from "../gui/viewface.ts";
import { boot } from "./bootrun.ts";
import { World } from "./fakes.ts";
import { startHosted, stopHosted } from "./gui-world.ts";

// Zen as a mode (docs/specs/2026-11-26-storybook-theme/spec.md Part A): the storage and its migration (A2), entering, leaving and the settings route, no live switch from another tab, the first frame (A3), and the server,
// which can no longer default a page into Zen.

/** A device's storage: `sb.view` and `sb.zen` as stored (null: none). */
function device(view: string | null, zen: string | null) {
	const kept = new Map<string, string>();
	if (view !== null) kept.set("sb.view", view);
	if (zen !== null) kept.set("sb.zen", zen);
	const writes: string[] = [];
	return { kept, writes, storage: { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void (writes.push(`${k}=${v}`), kept.set(k, v)) } };
}
/** A page of the device as main.ts builds it: the mode, the view whose face follows it, and the face's moves on a route that is settings or not. */
function page(d: ReturnType<typeof device>, o: { contrast?: boolean; server?: string; settings?: boolean } = {}) {
	const route = { settings: o.settings ?? false, left: 0 }, mode = mountMode(d.storage);
	const env: ViewEnv = { themes: manifests, root: { dataset: {} }, meta: { content: "#1a1b26" }, ...(o.server !== undefined ? { server: { content: o.server } } : {}), media: { matches: o.contrast ?? false, addEventListener: () => {} }, storage: d.storage };
	const view = mountView(env, () => zenShows({ mode: mode.on(), settings: route.settings }));
	const face = mountFace({ view, mode, settings: () => route.settings, leaveSettings: () => ((route.left += 1), (route.settings = false), face.route(false)), draw: () => {} });
	return { mode, view, face, route, shows: () => env.root.dataset.view, color: () => env.meta!.content };
}

test("A2: the storage table: sb.zen says, a legacy sb.view zen with none means on and reads as Auto, and the legacy key is never written", () => {
	const rows: [string | null, string | null, string, boolean][] = [
		// sb.view, sb.zen, theme choice, mode
		["zen", null, "auto", true], // a device that was on the Zen view
		["zen", "0", "auto", false], // it left Zen on the new build
		["raven", "1", "raven", true], // leaving shows Raven Keep
		["storybook", null, "storybook", false], // a theme of this build
		["meadow", null, "auto", false], // a theme this build does not know (an older build reading a newer one's)
		[null, null, "auto", false],
		["geek", "0", "geek", false],
		["1", null, "auto", false], // only zen means on: any other legacy value is off
		["zen", "zen", "auto", false], // sb.zen is 1 or 0; anything else is off
	];
	for (const [v, z, choice, on] of rows) {
		const d = device(v, z), p = page(d);
		assert.deepEqual([p.view.choice(), p.mode.on(), p.shows()], [choice, on, on ? "zen" : resolve(choiceOf(v), false)], `sb.view ${v}, sb.zen ${z}`);
		assert.deepEqual(d.writes, v === "zen" && z === null ? ["sb.zen=1"] : [], "loading writes nothing, but a legacy Zen device's mode under its own key");
	}
	const legacy = device("zen", null), p = page(legacy);
	p.face.leave();
	assert.deepEqual([legacy.writes, legacy.kept.get("sb.view")], [["sb.zen=1", "sb.zen=0"], "zen"], "leaving writes sb.zen only: an older build on this browser still finds its Zen");
	const refused = page({ kept: new Map(), writes: [], storage: { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } });
	assert.equal(refused.mode.on(), false, "a refused storage reads off");
	refused.face.enter();
	assert.deepEqual([refused.mode.on(), refused.shows()], [true, "zen"], "a refused write is dropped: the mode holds until the page closes");
});

test("A2 (RV-F001): a legacy Zen device that picks a theme before it ever leaves Zen still opens in Zen on its next load", () => {
	const d = device("zen", null), first = page(d);
	assert.equal(first.shows(), "zen");
	first.view.set("raven");
	assert.deepEqual([first.shows(), d.kept.get("sb.view"), d.kept.get("sb.zen")], ["zen", "raven", "1"]);
	assert.equal(page(d).shows(), "zen", "the reload is still in Zen");
});

test("persistence: a page that entered Zen leaves sb.zen on, and the device's next page opens in Zen; leaving turns it off for the next page", () => {
	const d = device("raven", null), first = page(d);
	assert.equal(first.shows(), "raven");
	first.face.enter();
	assert.deepEqual([first.shows(), first.color(), d.kept.get("sb.zen")], ["zen", THEME.zen, "1"]);
	const reload = page(d);
	assert.equal(reload.shows(), "zen", "a reload, a new page of the device, and the build-change reload open in Zen");
	reload.face.leave();
	assert.deepEqual([reload.shows(), reload.color(), d.kept.get("sb.zen")], ["raven", THEME.raven, "0"], "leaving shows the device's theme");
	assert.equal(page(d).shows(), "raven");
});

test("no live switch from another tab: the mode is read at load only, with no storage listener, so an open page is never pulled into Zen or out of it", () => {
	const g = globalThis as Record<string, unknown>, saved = g.addEventListener, heard: string[] = [];
	g.addEventListener = (type: string) => void heard.push(type);
	try {
		const d = device("standard", "0"), here = page(d), there = page(d);
		there.face.enter();
		assert.deepEqual([d.kept.get("sb.zen"), here.shows(), here.mode.on()], ["1", "standard", false], "the other tab's entering changes nothing here");
		here.view.reread(); // another tab picked a theme: a storage event for sb.view reads the theme again
		assert.equal(here.shows(), "standard", "a theme's reread never reads the mode");
		there.face.leave();
		assert.equal(there.shows(), "standard");
		assert.ok(!heard.includes("storage"), "mountMode and mountView register no storage listener");
	} finally {
		if (saved === undefined) delete g.addEventListener;
		else g.addEventListener = saved;
	}
	const main = readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8"), mode = readFileSync(new URL("../gui/mode.ts", import.meta.url), "utf8");
	assert.ok(!/\.on\("zen"/.test(main + mode) && !/addEventListener\("storage"/.test(main + mode), "nobody listens for sb.zen");
});

test("enter, leave, and the settings route: Zen shows at once from any theme; the settings page suspends it and shows the theme's page; leaving it shows Zen again", () => {
	for (const theme of VIEWS) {
		const p = page(device(theme, null));
		p.face.enter();
		assert.equal(p.shows(), "zen", `${theme}: entered`);
		p.route.settings = true;
		p.face.route(true);
		assert.deepEqual([p.shows(), p.mode.on()], [theme, true], `${theme}: the settings page suspends Zen and does not end it`);
		p.route.settings = false;
		p.face.route(false);
		assert.equal(p.shows(), "zen", `${theme}: leaving the settings page shows Zen again`);
		p.face.leave();
		assert.equal(p.shows(), theme, `${theme}: leaving Zen shows the theme`);
	}
	const onSettings = page(device("geek", "0"), { settings: true });
	onSettings.face.enter();
	assert.deepEqual([onSettings.route.left, onSettings.shows()], [1, "zen"], "the Zen button on the settings page leaves the page first");
	const contrast = page(device(null, "1"), { contrast: true });
	contrast.face.leave();
	assert.equal(contrast.shows(), "geek", "Auto with prefers-contrast: more leaves for Geek");
});

test("A3: boot.js's first frame is the face mode.ts and view.ts make, for every stored sb.view × sb.zen × contrast × server default", () => {
	const views = [null, "", "auto", "standard", "geek", "raven", "zen", "ZEN", "1", "storybook", "__proto__", "constructor"];
	const zens = [null, "1", "0", "zen", "", "true"];
	const servers = [null, "auto", "standard", "geek", "raven", "zen", "nope"];
	let cells = 0;
	for (const v of views) for (const z of zens) for (const server of servers) for (const contrast of [false, true]) {
		const run = boot(v, contrast, server, { zen: z });
		const p = page(device(v, z), { contrast, ...(server !== null ? { server } : {}) });
		const at = `sb.view ${JSON.stringify(v)}, sb.zen ${JSON.stringify(z)}, server ${JSON.stringify(server)}, contrast ${contrast}`;
		assert.equal(run.view, p.shows(), at);
		assert.equal(run.resolve.face(v, z, contrast, server), p.shows(), `sbBoot.face: ${at}`);
		assert.equal(run.color, p.color(), `the theme-color: ${at}`);
		cells++;
	}
	assert.ok(cells > 1000, `${cells} cells`);
	const zen = boot("raven", false, null, { zen: "1" });
	assert.deepEqual([zen.view, zen.icon, zen.wrote], ["zen", "themes/zen/favicon-x.svg", ['<link rel="stylesheet" data-theme="zen" href="themes/zen/zen-x.css">']], "with the mode on: the ink, Zen's icon and sheet");
	assert.deepEqual(boot("raven", false, null, { zen: "1", linked: true }).wrote, [], "a sheet already linked is not linked twice");
});

test("the lists: Zen is a mode, not a view; the completions and the build's theme folders follow", () => {
	assert.ok(!(VIEWS as readonly string[]).includes("zen"));
	assert.deepEqual([...MODES], ["zen"]);
	assert.ok(!("gui view zen" in VIEW_ARGUMENTS), "no completion for gui view zen");
	assert.deepEqual(Object.keys(VIEW_ARGUMENTS), ["gui view auto", "gui view standard", "gui view geek", "gui view raven", "gui view storybook"]);
});

test("the Zen button's look: the word beside the gear, the ensō alone on a 44 px target on a phone, and [Zen] in Geek", () => {
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), geek = readFileSync(new URL("../gui/themes/geek/geek.css", import.meta.url), "utf8");
	assert.match(css, /^\.zen-enter \{ display: inline-flex;[^}]*\} \.zen-enter svg \{ display: none;/m, "the word on a wide screen, in every theme");
	const phone = css.slice(css.indexOf("A phone's tap targets"));
	assert.match(phone, /\.zen-enter \{ width: 44px; height: 44px; padding: 0; \} \.zen-enter svg \{ display: block; \} \.zen-enter span \{ display: none; \}/, "the ensō alone on a phone, 44 px");
	assert.ok(!/zen-back|data-zen-away/.test(css), "the old way back and its mark are gone");
	assert.match(geek, /\[data-view="geek"\] \.zen-enter span::before \{ content: "\["; \} \[data-view="geek"\] \.zen-enter span::after \{ content: "\]"; \}/);
	assert.match(geek, /\[data-view="geek"\] \.zen-enter svg \{ display: none; \}/, "Geek keeps the word on a phone");
});

let world = new World();
afterEach(async () => {
	await stopHosted();
	await world.stopAll();
	world = new World();
});
const prefs = (dir: string) => join(dir, "gui-prefs.json");

test("the server cannot put a page into Zen: gui-view zen is refused with the way in and changes nothing; gui.json never says zen", async () => {
	const h = await startHosted(world);
	await h.ask("gui-view", { view: "raven" });
	const reply = await h.ask("gui-view", { view: "zen" });
	assert.deepEqual(reply, { ok: false, error: "Zen is a mode now: enter it with the Zen button in the page's header. The default view is auto, standard, geek, raven, or storybook" });
	assert.deepEqual(JSON.parse(readFileSync(prefs(h.slot.dir), "utf8")), { v: 1, view: "raven" }, "the file is untouched");
	assert.equal(h.gui().view, "raven", "gui.json keeps the theme");
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps: { openUrl: async () => {} } });
	await viewer.start();
	await viewer.command("gui view zen");
	assert.equal(viewer.notices.at(-1)!.level, "error");
	assert.equal(viewer.notices.at(-1)!.text, "Straw net GUI: Zen is a mode now: enter it with the Zen button in the page's header. The default view is auto, standard, geek, raven, or storybook");
});

test("a gui-prefs.json that still says zen reads as auto, the tell adds one line, and nothing rewrites the file until the boss sets a default", async () => {
	const h = await startHosted(world);
	writeFileSync(prefs(h.slot.dir), JSON.stringify({ v: 1, view: "zen" })); // what a build where Zen was a view wrote
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	const next = await startHosted(world);
	assert.deepEqual(await next.ask("gui-view"), { ok: true, view: "auto", note: "gui-prefs.json still says zen, which is now a mode; the default reads as auto" });
	assert.equal(next.gui().view, undefined, "gui.json carries no view for auto");
	const viewer = world.agent({ id: "viewer", pane: "wA:p1", tab: "wA:t1", deps: { openUrl: async () => {} } });
	await viewer.start();
	await viewer.command("gui view");
	assert.equal(viewer.notices.at(-1)!.text, "The straw net GUI's default view is Auto (each device follows its own screen's contrast setting)\ngui-prefs.json still says zen, which is now a mode; the default reads as auto");
	assert.deepEqual(JSON.parse(readFileSync(prefs(next.slot.dir), "utf8")), { v: 1, view: "zen" }, "telling rewrites nothing");
	assert.deepEqual(await next.ask("gui-view", { view: "auto" }), { ok: true, view: "auto", changed: false });
	assert.deepEqual(JSON.parse(readFileSync(prefs(next.slot.dir), "utf8")), { v: 1, view: "auto" }, "an explicit set replaces it");
	assert.deepEqual(await next.ask("gui-view"), { ok: true, view: "auto" }, "and the note is gone");
});
