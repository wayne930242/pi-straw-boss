import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { followLabel } from "../gui/viewlabel.ts";
import { boot } from "./bootrun.ts";
import { autoView, mountZenEnter, choiceOf, KEY, mountPick, mountView, resolve, THEME, type ViewEnv } from "../gui/view.ts";

// The page's view (gui/view.ts): Auto, Standard, or Geek from the device's storage and the OS's contrast preference, set on <html> before the first render.

test("the stored choice and prefers-contrast resolve to a view: an explicit choice wins, anything else is Auto", () => {
	const table: [string | null, boolean, "standard" | "geek" | "raven"][] = [
		[null, false, "standard"], [null, true, "geek"],
		["auto", false, "standard"], ["auto", true, "geek"],
		["standard", false, "standard"], ["standard", true, "standard"],
		["geek", false, "geek"], ["geek", true, "geek"],
		["", false, "standard"], ["", true, "geek"],
		["zen", false, "standard"], ["zen", true, "geek"], ["ZEN", false, "standard"], // a legacy zen is Auto: Zen is a mode (mode.ts)
		["raven", false, "raven"], ["raven", true, "raven"], ["RAVEN", false, "standard"],
		["GEEK", false, "standard"], ["dark", true, "geek"], ["1", false, "standard"], ["{}", true, "geek"], ["undefined", false, "standard"],
	];
	for (const [stored, contrast, expected] of table) assert.equal(resolve(choiceOf(stored), contrast), expected, `${JSON.stringify(stored)} with prefers-contrast ${contrast ? "more" : "no-preference"}`);
	assert.equal(choiceOf("dark"), "auto", "an invalid stored value reads as Auto");
});

/** The page's parts as plain objects: storage, the contrast query, the root, and the theme-color meta. */
function world(stored: string | null, more: boolean, opts: { refuse?: boolean; server?: string } = {}) {
	let listener: (() => void) | undefined;
	const written: string[] = [];
	const media = { matches: more, addEventListener: (_: "change", fn: () => void) => (listener = fn) };
	const env: ViewEnv = {
		root: { dataset: {} },
		meta: { content: "#1a1b26" },
		...(opts.server !== undefined ? { server: { content: opts.server } } : {}),
		media,
		storage: {
			getItem: () => {
				if (opts.refuse) throw new Error("denied");
				return stored;
			},
			setItem: (key: string, value: string) => {
				if (opts.refuse) throw new Error("denied");
				written.push(`${key}=${value}`);
				stored = value;
			},
		},
	};
	return { env, written, flip: (next: boolean) => ((media.matches = next), listener?.()) };
}

test("the view is on <html> and the theme color follows it, as soon as it is mounted", () => {
	const w = world("geek", false);
	const view = mountView(w.env);
	assert.equal(w.env.root.dataset.view, "geek");
	assert.equal(w.env.meta?.content, THEME.geek);
	assert.deepEqual([view.choice(), view.view()], ["geek", "geek"]);
	const plain = world(null, false);
	mountView(plain.env);
	assert.equal(plain.env.root.dataset.view, "standard");
	assert.equal(plain.env.meta?.content, "#1a1b26", "the page's own color stays for Standard");
});

test("Auto follows prefers-contrast live; an explicit choice does not", () => {
	const auto = world(null, false);
	mountView(auto.env);
	auto.flip(true);
	assert.equal(auto.env.root.dataset.view, "geek");
	assert.equal(auto.env.meta?.content, THEME.geek);
	auto.flip(false);
	assert.equal(auto.env.root.dataset.view, "standard");
	assert.equal(auto.env.meta?.content, "#1a1b26", "back to the color the page came with");
	const fixed = world("standard", false);
	mountView(fixed.env);
	fixed.flip(true);
	assert.equal(fixed.env.root.dataset.view, "standard");
});

test("choosing stores the choice under sb.view and switches at once; a refused storage still switches for this page", () => {
	const w = world(null, false);
	const seen: string[] = [];
	const view = mountView(w.env);
	view.onChange((v: string) => seen.push(v));
	view.set("geek");
	assert.deepEqual(w.written, [`${KEY}=geek`]);
	assert.equal(w.env.root.dataset.view, "geek");
	view.set("auto");
	assert.equal(w.env.root.dataset.view, "standard");
	assert.deepEqual(seen, ["geek", "standard"]);
	const refused = world(null, true, { refuse: true });
	const v = mountView(refused.env);
	assert.equal(refused.env.root.dataset.view, "geek", "storage refused: Auto reads the OS");
	v.set("standard");
	assert.equal(refused.env.root.dataset.view, "standard");
	assert.deepEqual([v.choice(), v.view()], ["standard", "standard"]);
});

test("an invalid stored value is Auto and is left as it is until the person chooses", () => {
	const w = world("sparkly", true);
	const view = mountView(w.env);
	assert.deepEqual([view.choice(), view.view()], ["auto", "geek"]);
	assert.deepEqual(w.written, []);
});

test("the settings' control is five words (Auto, Standard, Geek, Raven Keep, Storybook; no Zen, which is a mode) in a group, one of them pressed, each a pair-btn so a phone gives it 44 px", () => {
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	const group = /<div class="view-pick" id="view-pick"[^>]*>([\s\S]*?)<\/div><\/div>/.exec(html)?.[1] ?? "";
	const buttons = [...group.matchAll(/<button class="pair-btn" type="button" data-choice="(\w+)" aria-pressed="(\w+)" data-m="(\w+)">/g)].map((x) => x.slice(1));
	assert.deepEqual(buttons, [["auto", "true", "view_auto"], ["standard", "false", "view_standard"], ["geek", "false", "view_geek"], ["raven", "false", "view_raven"], ["storybook", "false", "view_storybook"]]);
	assert.match(html, /role="group" aria-labelledby="view-label"/);
});

test("the control presses a button for the stored choice, switches on a click, and follows another tab's write", () => {
	const g = globalThis as Record<string, unknown>, saved = g.addEventListener;
	const heard: Record<string, ((e: { key: string }) => void)[]> = {};
	g.addEventListener = (type: string, fn: (e: { key: string }) => void) => void (heard[type] ??= []).push(fn);
	try {
		const w = world("geek", false);
		const view = mountView(w.env);
		const make = (choice: string) => {
			const attrs: Record<string, string> = {}, click: (() => void)[] = [];
			return { dataset: { choice }, attrs, click, setAttribute: (k: string, v: string) => (attrs[k] = v), addEventListener: (_: string, fn: () => void) => click.push(fn) };
		};
		const buttons = ["auto", "standard", "geek"].map(make);
		mountPick({ querySelectorAll: () => buttons } as unknown as HTMLElement, view);
		assert.deepEqual(buttons.map((b) => b.attrs["aria-pressed"]), ["false", "false", "true"]);
		buttons[1]!.click[0]!();
		assert.deepEqual(buttons.map((b) => b.attrs["aria-pressed"]), ["false", "true", "false"]);
		assert.equal(w.env.root.dataset.view, "standard");
		assert.deepEqual(w.written, [`${KEY}=standard`]);
		w.env.storage.setItem(KEY, "geek"); // another tab of this device chose Geek
		heard.storage![0]!({ key: KEY });
		assert.equal(w.env.root.dataset.view, "geek");
		assert.deepEqual(buttons.map((b) => b.attrs["aria-pressed"]), ["false", "false", "true"]);
		heard.storage![0]!({ key: "sb.sound" });
		assert.equal(w.env.root.dataset.view, "geek", "another key is none of ours");
	} finally {
		if (saved === undefined) delete g.addEventListener;
		else g.addEventListener = saved;
	}
});

test("the server's default slots in under Auto: an explicit device choice wins over it, and with the server on auto prefers-contrast decides", () => {
	const table: [string | null, string, boolean, "standard" | "geek"][] = [
		// device choice, server default, prefers-contrast more, view
		[null, "geek", false, "geek"], [null, "geek", true, "geek"], [null, "standard", false, "standard"], [null, "standard", true, "standard"],
		[null, "auto", false, "standard"], [null, "auto", true, "geek"],
		["auto", "geek", false, "geek"], ["auto", "standard", true, "standard"],
		["standard", "geek", false, "standard"], ["standard", "geek", true, "standard"],
		["geek", "standard", false, "geek"], ["geek", "standard", true, "geek"], ["geek", "auto", false, "geek"],
		["sparkly", "geek", false, "geek"], // an invalid stored value is Auto, so it follows the server
		[null, "sparkly", true, "geek"], [null, "GEEK", false, "standard"], [null, "", true, "geek"], // an invalid server value is Auto too
	];
	for (const [stored, server, contrast, expected] of table) assert.equal(resolve(choiceOf(stored), contrast, choiceOf(server)), expected, `device ${JSON.stringify(stored)}, server ${JSON.stringify(server)}, contrast ${contrast}`);
	assert.equal(autoView(true), "geek");
	assert.equal(autoView(true, "standard"), "standard");
});

test("the page starts in the server's default from the meta the server wrote, before the first render, and a device that chose keeps its choice", () => {
	const follower = world(null, false, { server: "geek" });
	const view = mountView(follower.env);
	assert.equal(follower.env.root.dataset.view, "geek", "the first thing the page does paints the default: no frame in the other view");
	assert.equal(follower.env.meta?.content, THEME.geek);
	assert.deepEqual([view.choice(), view.server(), view.view()], ["auto", "geek", "geek"]);
	const chose = world("standard", true, { server: "geek" });
	mountView(chose.env);
	assert.equal(chose.env.root.dataset.view, "standard");
	const none = world(null, true);
	assert.equal(mountView(none.env).server(), "auto", "a page without the meta (an older server, the demo) follows the screen");
	assert.equal(none.env.root.dataset.view, "geek");
});

test("a new server default switches a following page live and tells it, and leaves a page with its own choice alone; a repeat is not a change", () => {
	const w = world(null, false, { server: "auto" });
	const view = mountView(w.env);
	const seen: string[] = [], servers: string[] = [];
	view.onChange((v: string) => seen.push(v));
	view.onServer((s: string) => servers.push(s));
	view.setServer("geek");
	assert.equal(w.env.root.dataset.view, "geek");
	assert.equal(w.env.meta?.content, THEME.geek);
	view.setServer("geek");
	view.setServer("standard");
	view.setServer("sparkly"); // not a view: reads as auto, like a bad stored value
	assert.deepEqual(seen, ["geek", "standard"], "the screen's contrast preference (off here) decides again at the last one");
	assert.deepEqual(servers, ["geek", "standard", "auto"]);
	assert.deepEqual(w.written, [], "the server's default is never written to the device's storage");
	const own = world("standard", false, { server: "auto" });
	const mine = mountView(own.env);
	mine.setServer("geek");
	assert.equal(own.env.root.dataset.view, "standard", "a device's own choice wins");
	assert.equal(mine.server(), "geek", "and still knows the server's default for its Follow label");
});

test("the Auto button reads as the server's default when there is one (Follow server (geek)) and as Auto when there is not, and follows a change", () => {
	const g = globalThis as Record<string, unknown>, saved = g.addEventListener;
	g.addEventListener = () => {};
	try {
		const w = world(null, false, { server: "geek" });
		const view = mountView(w.env);
		const make = (choice: string) => ({ dataset: { choice }, textContent: "", setAttribute() {}, addEventListener() {} });
		const buttons = ["auto", "standard", "geek"].map(make);
		const flags: Record<string, boolean> = {};
		const group = { dataset: {}, querySelectorAll: () => buttons, toggleAttribute: (name: string, on: boolean) => (flags[name] = on) };
		mountPick(group as unknown as HTMLElement, view, (server) => (server === "auto" ? "Auto" : `Follow server (${server})`));
		assert.equal(buttons[0]!.textContent, "Follow server (geek)");
		assert.equal(flags["data-following"], true, "the long label gets a row of its own");
		assert.equal(buttons[1]!.textContent, "", "the other two keep their own words");
		view.setServer("standard");
		assert.equal(buttons[0]!.textContent, "Follow server (standard)");
		view.setServer("auto");
		assert.equal(buttons[0]!.textContent, "Auto");
		assert.equal(flags["data-following"], false);
	} finally {
		if (saved === undefined) delete g.addEventListener;
		else g.addEventListener = saved;
	}
});

test("main.ts feeds the server's default from the page's meta, each hello, and the view event, and index.html carries no sb-view of its own (the server writes it)", () => {
	const main = readFileSync(new URL("../gui/main.ts", import.meta.url), "utf8");
	assert.match(main, /source\.listen\("view"/);
	assert.match(main, /\.setServer\(/);
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	assert.ok(!html.includes('name="sb-view"'));
});

test("zen is no view: a stored or served `zen` reads as Auto (Zen is a mode, mode.ts), and THEME.zen is the mode's ink ground", () => {
	assert.equal(choiceOf("zen"), "auto");
	for (const contrast of [false, true]) {
		assert.equal(resolve(choiceOf("zen"), contrast), contrast ? "geek" : "standard", "a device's legacy zen is Auto");
		assert.equal(resolve("auto", contrast, choiceOf("zen")), contrast ? "geek" : "standard", "an older server's zen is Auto");
	}
	assert.equal(THEME.zen, "#14110e");
	const w = world("zen", false, { server: "zen" });
	const view = mountView(w.env);
	assert.deepEqual([view.choice(), view.server(), view.view(), w.env.root.dataset.view], ["auto", "auto", "standard", "standard"]);
});

test("raven is a view: a device's choice that holds against prefers-contrast, a server default that wins over it, never picked by Auto alone; the theme color is the keep's ground", () => {
	assert.equal(THEME.raven, "#0d0a10");
	assert.equal(choiceOf("raven"), "raven");
	for (const contrast of [false, true]) {
		assert.equal(resolve("auto", contrast, "raven"), "raven", `a server default of raven wins (contrast ${contrast})`);
		assert.equal(resolve("raven", contrast, "standard"), "raven");
		assert.equal(resolve("geek", contrast, "raven"), "geek", "a device's own choice wins over the server");
		assert.notEqual(resolve("auto", contrast), "raven", "Auto with no default never resolves to raven");
	}
	assert.equal(autoView(true), "geek", "Auto with more contrast and no default is still Geek");
	assert.equal(resolve("raven", true), "raven", "an explicit raven stays raven under more contrast");
	const w = world(null, true, { server: "raven" });
	const view = mountView(w.env);
	assert.deepEqual([view.choice(), view.view(), w.env.root.dataset.view, w.env.meta?.content], ["auto", "raven", "raven", THEME.raven]);
	view.set("standard");
	assert.equal(w.env.meta?.content, "#1a1b26", "Standard's colour comes back");
	view.set("raven");
	assert.deepEqual([w.env.root.dataset.view, w.env.meta?.content, w.written.at(-1)], ["raven", THEME.raven, `${KEY}=raven`]);
});

test("a page on a following Auto switches to a server default of raven; a page showing Zen keeps its face and takes the theme underneath (Z-D20)", () => {
	const follow = world(null, false);
	const f = mountView(follow.env);
	f.setServer("raven");
	assert.equal(follow.env.root.dataset.view, "raven");
	const zen = world(null, false);
	const z = mountView(zen.env, () => true);
	z.setServer("raven");
	assert.deepEqual([zen.env.root.dataset.view, z.face(), z.view(), zen.env.meta?.content], ["zen", "zen", "raven", THEME.zen], "the page showing Zen stays in it; its theme is raven now");
});

test("the page's Auto label names raven's default, and the name is Raven Keep", () => {
	assert.equal(followLabel("raven"), "Follow server (Raven Keep)");
});

test("the page's Auto label names the server's default", () => {
	assert.equal(followLabel("auto"), "Auto");
	assert.equal(followLabel("geek"), "Follow server (Geek)");
	assert.equal(followLabel("standard"), "Follow server (Standard)");
});

test("the header's Zen button is always there; a press calls enter", () => {
	let click: () => void = () => {}, entered = 0;
	mountZenEnter({ addEventListener: (_: string, fn: () => void) => (click = fn) } as unknown as HTMLElement, () => void entered++);
	click();
	click();
	assert.equal(entered, 2);
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	const button = /<button class="pair-btn zen-enter" id="zen-enter"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
	assert.ok(button && !/\shidden\b/.test(button), "never hidden in the markup");
	assert.match(button, /data-m-label="zen_enter_title"/);
	assert.match(button, /<use data-icon="zen" href="#i-zen"\/>/, "the ensō glyph a phone shows");
	assert.match(button, /<span data-m="zen_enter">Zen<\/span>/);
	assert.match(html, /<symbol id="i-zen" /, "the glyph is a symbol of Standard's inline sprite");
	assert.ok(!html.includes("zen-back"), "the old way back is gone");
});

test("the face is Zen while the page shows Zen and the theme otherwise: the theme color follows the face, the device's choice and storage stay", () => {
	let zen = true;
	const w = world("raven", false);
	const view = mountView(w.env, () => zen);
	assert.deepEqual([w.env.root.dataset.view, w.env.meta?.content, view.face(), view.view()], ["zen", THEME.zen, "zen", "raven"]);
	zen = false;
	view.refresh();
	assert.deepEqual([w.env.root.dataset.view, w.env.meta?.content, view.choice(), w.written], ["raven", THEME.raven, "raven", []], "leaving shows the device's theme, not Standard");
	w.flip(true); // an OS change re-applies the face: it brings no Zen back
	assert.equal(w.env.root.dataset.view, "raven");
	zen = true;
	view.refresh();
	assert.equal(w.env.root.dataset.view, "zen");
	const std = world(null, false);
	const s = mountView(std.env, () => zen);
	zen = false;
	s.refresh();
	assert.deepEqual([std.env.root.dataset.view, std.env.meta?.content], ["standard", "#1a1b26"], "Standard's own colour comes back");
});

test("a listener that draws the view again meets no second change: the new view is noted before the listeners run", () => {
	const w = world("standard", false);
	const view = mountView(w.env);
	let calls = 0;
	view.onChange(() => (calls++, view.refresh()));
	view.set("geek");
	assert.equal(calls, 1);
	assert.equal(w.env.root.dataset.view, "geek");
});

test("Z-D20: a change of the server's default never switches a page that is showing Zen out of it; the theme moves underneath and shows when the boss leaves", () => {
	let zen = true;
	const w = world(null, false, { server: "standard" });
	const view = mountView(w.env, () => zen);
	const seen: string[] = [], servers: string[] = [];
	view.onChange((v: string) => seen.push(v));
	view.onServer((s: string) => servers.push(s));
	view.setServer("geek");
	view.setServer("raven");
	assert.deepEqual([w.env.root.dataset.view, view.face(), view.view()], ["zen", "zen", "raven"], "the page showing Zen stays in it");
	assert.deepEqual([seen, servers, w.written], [["geek", "raven"], ["geek", "raven"], []], "the theme's listeners hear it (viewface.ts: the mode is not touched); nothing is stored");
	zen = false; // the boss left Zen (viewface.ts `leave`)
	view.refresh();
	assert.equal(w.env.root.dataset.view, "raven", "the new default shows on leaving");
});

// boot.js (gui/boot.js) resolves the first frame's view before the page entry runs; it must agree with `resolve` of view.ts for every stored value, contrast, and server default (tests/bootrun.ts runs it; tests/zen-mode.test.ts adds the mode).
test("boot.js resolves the view as view.ts does: every stored value, contrast, and server default", () => {
	const stored = [null, "", "auto", "standard", "geek", "zen", "ZEN", "Geek", "dark", "1", "{}", "constructor", "__proto__", "raven"];
	const servers = [null, "auto", "standard", "geek", "zen", "raven", "nope"];
	for (const s of stored) for (const server of servers) for (const contrast of [false, true]) {
		const run = boot(s, contrast, server, { zen: "0" }); // the mode off: the face is the theme (tests/zen-mode.test.ts walks the mode)
		const expected = resolve(choiceOf(s), contrast, choiceOf(server ?? undefined));
		assert.equal(run.view, expected, `boot: stored ${JSON.stringify(s)}, server ${JSON.stringify(server)}, contrast ${contrast}`);
		assert.equal(run.resolve.resolve(s, contrast, server), expected, `sbBoot.resolve: stored ${JSON.stringify(s)}, server ${JSON.stringify(server)}, contrast ${contrast}`);
	}
});

test("boot.js sets the theme-color view.ts names, links the theme's stylesheet once, and leaves Standard alone", () => {
	const geek = boot("geek", false, null);
	assert.deepEqual([geek.color, geek.icon, geek.standard], [THEME.geek, "icon.svg", "./icon.svg"]);
	assert.deepEqual(geek.wrote, ['<link rel="stylesheet" data-theme="geek" href="themes/geek/geek-x.css">']);
	assert.deepEqual(boot("standard", false, null, { zen: "1" }).wrote, ['<link rel="stylesheet" data-theme="zen" href="themes/zen/zen-x.css">'], "the mode on: Zen's sheet");
	assert.equal(boot("standard", false, null, { zen: "1" }).color, THEME.zen);
	assert.deepEqual(boot("geek", false, null, { linked: true }).wrote, [], "a theme the server already linked is not linked twice");
	const standard = boot("standard", true, "geek");
	assert.deepEqual([standard.view, standard.color, standard.icon, standard.wrote], ["standard", "#1a1b26", "./icon.svg", []], "a device on Standard gets no theme link");
	assert.deepEqual(boot(null, true, null).wrote.length, 1, "Auto with more contrast is Geek");
	assert.equal(boot(null, false, "geek", { refuse: true }).view, "geek", "storage refused: the server's default decides");
	assert.equal(boot(null, false, "zen").view, "standard", "an older server's zen is no view (the map marks it a mode): Auto");
	assert.deepEqual(JSON.parse(JSON.stringify(boot(null, false, null).resolve.colors)), THEME, "the colours are view.ts's");
});

test("boot.js restores Standard's icon from data-standard when the server wrote a theme's icon and the device's view has none", () => {
	const run = boot("standard", false, "geek", { standardMark: "./icon.svg", icon: "themes/geek/favicon-x.svg" });
	assert.equal(run.icon, "./icon.svg");
	assert.equal(boot("geek", false, null, { standardMark: "./icon.svg", icon: "themes/geek/favicon-x.svg" }).icon, "icon.svg", "a themed view still takes its own");
});

// RV-F002: boot.js paints Zen's ink (or a theme's colour) over the theme-color before view.ts reads Standard's, so leaving Zen on a Standard device kept Zen's ink. boot.js keeps the page's own colour in the meta's data-standard,
// and view.ts reads Standard's colour there.
test("leaving Zen on a Standard device paints Standard's theme-color, not Zen's ink that boot.js put on the first frame (RV-F002)", () => {
	const first = boot("standard", false, null, { zen: "1" });
	assert.deepEqual([first.view, first.color, first.colorStandard], ["zen", THEME.zen, "#1a1b26"], "boot.js keeps the page's own colour before it paints Zen's");
	assert.equal(boot("standard", false, null, { zen: "0" }).colorStandard, undefined, "Standard's first frame paints nothing and marks nothing");
	let zen = true;
	const root = { dataset: { view: first.view } as Record<string, string | undefined> }, meta = { content: first.color, dataset: { standard: first.colorStandard } as Record<string, string | undefined> };
	const view = mountView({ root, meta, media: { matches: false, addEventListener() {} }, storage: { getItem: (k) => (k === "sb.view" ? "standard" : null), setItem() {} } }, () => zen);
	assert.equal(meta.content, THEME.zen);
	zen = false;
	view.refresh();
	assert.deepEqual([root.dataset.view, meta.content], ["standard", "#1a1b26"]);
});
