import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { choiceOf, KEY, mountPick, mountView, resolve, THEME, type ViewEnv } from "../gui/view.ts";

// The page's view (gui/view.ts): Auto, Standard, or Geek from the device's storage and the OS's contrast preference, set on <html> before the first render.

test("the stored choice and prefers-contrast resolve to a view: an explicit choice wins, anything else is Auto", () => {
	const table: [string | null, boolean, "standard" | "geek"][] = [
		[null, false, "standard"], [null, true, "geek"],
		["auto", false, "standard"], ["auto", true, "geek"],
		["standard", false, "standard"], ["standard", true, "standard"],
		["geek", false, "geek"], ["geek", true, "geek"],
		["", false, "standard"], ["", true, "geek"],
		["GEEK", false, "standard"], ["dark", true, "geek"], ["1", false, "standard"], ["{}", true, "geek"], ["undefined", false, "standard"],
	];
	for (const [stored, contrast, expected] of table) assert.equal(resolve(choiceOf(stored), contrast), expected, `${JSON.stringify(stored)} with prefers-contrast ${contrast ? "more" : "no-preference"}`);
	assert.equal(choiceOf("dark"), "auto", "an invalid stored value reads as Auto");
});

/** The page's parts as plain objects: storage, the contrast query, the root, and the theme-color meta. */
function world(stored: string | null, more: boolean, opts: { refuse?: boolean } = {}) {
	let listener: (() => void) | undefined;
	const written: string[] = [];
	const media = { matches: more, addEventListener: (_: "change", fn: () => void) => (listener = fn) };
	const env: ViewEnv = {
		root: { dataset: {} },
		meta: { content: "#1a1b26" },
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

test("the settings' control is three words (Auto, Standard, Geek) in a group, one of them pressed, each a pair-btn so a phone gives it 44 px", () => {
	const html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	const group = /<div class="view-pick" id="view-pick"[^>]*>([\s\S]*?)<\/div><\/div>/.exec(html)?.[1] ?? "";
	const buttons = [...group.matchAll(/<button class="pair-btn" type="button" data-choice="(\w+)" aria-pressed="(\w+)" data-m="(\w+)">/g)].map((x) => x.slice(1));
	assert.deepEqual(buttons, [["auto", "true", "view_auto"], ["standard", "false", "view_standard"], ["geek", "false", "view_geek"]]);
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
