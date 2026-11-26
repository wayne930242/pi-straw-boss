import assert from "node:assert/strict";
import { test } from "node:test";
import { El, page } from "./fake-dom.ts";

// The command palette (gui/palette.ts, the shared component) and the entries Zen gives it (gui/paletteentries.ts): filtering, the keys in its box, what a pick does, focus in and out, and the list of actions and preferences.
const { filterEntries, mountPalette } = await import("../gui/palette.ts");
const { entriesOf } = await import("../gui/paletteentries.ts");
type Entry = import("../gui/palette.ts").Entry;

const entry = (id: string, label: string, o: Partial<Entry> = {}): Entry => ({ id, label, run: () => {}, ...o });

test("filterEntries: every word of the query must be in the label, in any case and any order; an empty query keeps all in order", () => {
	const all = [entry("a", "Back to the Standard view"), entry("b", "View: Zen"), entry("c", "Sound"), entry("d", "Volume up")];
	assert.deepEqual(filterEntries(all, "").map((e) => e.id), ["a", "b", "c", "d"]);
	assert.deepEqual(filterEntries(all, "  ").map((e) => e.id), ["a", "b", "c", "d"]);
	assert.deepEqual(filterEntries(all, "VIEW").map((e) => e.id), ["a", "b"]);
	assert.deepEqual(filterEntries(all, "zen view").map((e) => e.id), ["b"]);
	assert.deepEqual(filterEntries(all, "up vol").map((e) => e.id), ["d"]);
	assert.deepEqual(filterEntries(all, "nothing"), []);
});

function rig(list: () => Entry[]) {
	const root = new El("section");
	page.body.replaceChildren(root);
	page.focused = undefined;
	const inert: boolean[] = [];
	const p = mountPalette({ entries: list, inert: (on) => inert.push(on) });
	root.append(p.el as unknown as El);
	const el = p.el as unknown as El, box = el.querySelector("input")!;
	const options = () => el.querySelectorAll('[role="option"]');
	const key = (k: string, over: object = {}) => {
		const e = { type: "keydown", key: k, isComposing: false, taken: false, preventDefault() { this.taken = true; }, ...over };
		box.dispatchEvent(e);
		return e.taken;
	};
	return { p, el, box, options, key, inert, root };
}

test("opening shows the list and puts the focus in its box; closing hides it and gives the focus back to where it was; the page behind is inert while it is open", () => {
	const r = rig(() => [entry("a", "Alpha"), entry("b", "Beta")]);
	const before = new El("textarea");
	page.body.append(before);
	before.focus();
	assert.equal(r.p.isOpen(), false);
	assert.equal(r.p.close(), false, "closing a closed palette is not the key's to take");
	r.p.open();
	assert.equal(r.p.isOpen(), true);
	assert.equal(r.el.hidden, false);
	assert.equal(page.focused, r.box);
	assert.deepEqual(r.options().map((o) => o.textContent), ["Alpha", "Beta"]);
	assert.equal(r.el.getAttribute("role"), "dialog");
	assert.equal(r.el.getAttribute("aria-modal"), "true");
	assert.equal(r.box.getAttribute("role"), "combobox");
	assert.deepEqual(r.inert, [true]);
	assert.equal(r.p.close(), true);
	assert.equal(r.el.hidden, true);
	assert.equal(page.focused, before, "the composer gets its focus back");
	assert.deepEqual(r.inert, [true, false]);
});

test("toggle opens and closes; a second open does not stack", () => {
	const r = rig(() => [entry("a", "Alpha")]);
	r.p.toggle();
	r.p.open();
	assert.deepEqual(r.inert, [true]);
	r.p.toggle();
	assert.equal(r.p.isOpen(), false);
});

test("typing narrows the list and the first match is active; the list is read fresh at each opening", () => {
	let list = [entry("a", "Alpha"), entry("b", "Beta"), entry("c", "Gamma")];
	const r = rig(() => list);
	r.p.open();
	r.box.type("a");
	assert.deepEqual(r.options().map((o) => o.textContent), ["Alpha", "Beta", "Gamma"]);
	r.box.type("bet");
	assert.deepEqual(r.options().map((o) => o.textContent), ["Beta"]);
	assert.equal(r.options()[0]!.getAttribute("aria-selected"), "true");
	r.box.type("zzz");
	assert.equal(r.options().length, 0);
	assert.ok(r.el.textContent.includes("Nothing matches"));
	r.p.close();
	list = [entry("d", "Delta")];
	r.p.open();
	assert.equal(r.box.value, "", "the box starts empty");
	assert.deepEqual(r.options().map((o) => o.textContent), ["Delta"]);
});

test("ArrowDown and ArrowUp move the active entry and wrap; Enter runs it and closes; the keys are taken", () => {
	const ran: string[] = [];
	const r = rig(() => ["a", "b", "c"].map((id) => entry(id, id.toUpperCase(), { run: () => void ran.push(id) })));
	r.p.open();
	const active = () => r.options().findIndex((o) => o.getAttribute("aria-selected") === "true");
	assert.equal(active(), 0);
	assert.equal(r.box.getAttribute("aria-activedescendant"), r.options()[0]!.getAttribute("id"));
	assert.equal(r.key("ArrowDown"), true);
	assert.equal(active(), 1);
	r.key("ArrowDown");
	r.key("ArrowDown");
	assert.equal(active(), 0, "wraps past the last");
	r.key("ArrowUp");
	assert.equal(active(), 2, "and past the first");
	assert.equal(r.key("Enter"), true);
	assert.deepEqual(ran, ["c"]);
	assert.equal(r.p.isOpen(), false);
});

test("Enter while an input method composes does not run an entry, and Enter with nothing matching does nothing", () => {
	const ran: string[] = [];
	const r = rig(() => [entry("a", "Alpha", { run: () => void ran.push("a") })]);
	r.p.open();
	assert.equal(r.key("Enter", { isComposing: true }), false);
	assert.deepEqual(ran, []);
	assert.equal(r.p.isOpen(), true);
	r.box.type("zzz");
	r.key("Enter");
	assert.deepEqual(ran, []);
	assert.equal(r.p.isOpen(), true);
});

test("a click on an entry runs it and closes; the focus is back before it runs, so an entry that moves the focus keeps it", () => {
	const seen: unknown[] = [];
	const target = new El("button"), before = new El("textarea");
	const r = rig(() => [entry("a", "Alpha", { run: () => (target.focus(), seen.push(page.focused)) })]);
	page.body.append(before, target);
	before.focus();
	r.p.open();
	r.options()[0]!.click();
	assert.equal(r.p.isOpen(), false);
	assert.deepEqual(seen, [target]);
	assert.equal(page.focused, target, "closing did not take it back");
});

test("an entry that keeps the palette open runs and the list is drawn again with fresh labels and hints, the query and the active entry kept", () => {
	let n = 50;
	const r = rig(() => [entry("up", "Volume up", { keep: true, hint: String(n), run: () => void (n += 10) }), entry("x", "Other")]);
	r.p.open();
	r.box.type("vol");
	r.key("Enter");
	assert.equal(r.p.isOpen(), true);
	assert.equal(r.box.value, "vol");
	assert.equal(r.options()[0]!.dump().includes("60"), true, "the hint follows");
	assert.equal(page.focused, r.box);
});

test("a hint is shown beside the label; the label stays the option's name for a reader", () => {
	const r = rig(() => [entry("a", "Sound", { hint: "On" })]);
	r.p.open();
	const o = r.options()[0]!;
	assert.ok(o.textContent.includes("Sound") && o.textContent.includes("On"));
});

test("a press inside the palette does not reach the page behind it (the pause's tap)", () => {
	const r = rig(() => [entry("a", "Alpha")]);
	let reached = 0;
	r.root.addEventListener("pointerdown", () => void reached++);
	r.p.open();
	let stopped = 0;
	for (const on of r.el.handlers.pointerdown ?? []) on({ stopPropagation: () => void stopped++ });
	assert.equal(stopped, 1);
	assert.equal(reached, 0);
});

test("a click on the backdrop closes", () => {
	const r = rig(() => [entry("a", "Alpha")]);
	r.p.open();
	r.el.querySelector(".palette-back")!.click();
	assert.equal(r.p.isOpen(), false);
});

// The entries.
const acts = () => {
	const calls: string[] = [];
	return {
		calls,
		acts: {
			leave: () => void calls.push("leave"), settings: () => void calls.push("settings"),
			companion: { name: "Harbor", session: () => void calls.push("session"), terminal: () => void calls.push("terminal"), rest: () => void calls.push("rest") },
			cycle: { prev: () => void calls.push("prev"), next: () => void calls.push("next") },
		},
	};
};
const labels = (list: Entry[]) => list.map((e) => e.label);

const cls = (st: { on: boolean; volume: number; tries?: number }) => ({ on: () => st.on, volume: () => st.volume, set: (on: boolean) => void (st.on = on), setVolume: (v: number) => void (st.volume = v), try: () => void (st.tries = (st.tries ?? 0) + 1), onChange() {} });

test("entriesOf lists the page's actions, then the preferences the menu has: language, and each sound class's switch and two volume steps (no theme: O4); a row without its dep is left out", () => {
	const a = acts(), langs: string[] = [];
	const fx = { on: false, volume: 50, tries: 0 }, bg = { on: false, volume: 20, tries: 0 };
	const prefs = {
		language: { get: () => "en", names: () => [{ id: "en", name: "English" }, { id: "zh-TW", name: "繁體中文" }], set: (id: string) => void langs.push(id) },
		sound: { effects: cls(fx), background: cls(bg) },
	};
	const list = entriesOf(a.acts, prefs as never);
	assert.deepEqual(labels(list), [
		"Open Harbor's session", "Open Harbor's terminal", "Back to the breath", "Previous companion", "Next companion", "Settings", "Leave Zen (Esc Esc)",
		"Language: English", "Language: 繁體中文",
		"Sound effects", "Sound effects volume up", "Sound effects volume down", "Background sound", "Background volume up", "Background volume down",
	]);
	assert.equal(new Set(list.map((e) => e.id)).size, list.length, "ids are unique");
	const by = (label: string) => list.find((e) => e.label === label)!;
	for (const label of ["Open Harbor's session", "Open Harbor's terminal", "Back to the breath", "Previous companion", "Next companion", "Settings", "Leave Zen (Esc Esc)"]) by(label).run();
	assert.deepEqual(a.calls, ["session", "terminal", "rest", "prev", "next", "settings", "leave"]);
	assert.ok(!list.some((e) => e.id.startsWith("view:")), "no theme entry: a theme picked in Zen would show only after leaving");
	by("Language: 繁體中文").run();
	assert.deepEqual(langs, ["zh-TW"]);
	assert.equal(by("Language: English").hint, "current");
	for (const label of ["Sound effects", "Background sound"]) (assert.equal(by(label).hint, "Off"), assert.equal(by(label).keep, true));
	by("Sound effects").run();
	assert.deepEqual([fx.on, bg.on], [true, false], "each switch changes its class only");
	by("Background sound").run();
	assert.deepEqual([fx.on, bg.on], [true, true]);
	assert.equal(entriesOf(a.acts, prefs as never).find((e) => e.label === "Sound effects")!.hint, "On", "read fresh");
	by("Sound effects volume up").run();
	by("Sound effects volume up").run();
	assert.deepEqual([fx.volume, bg.volume, fx.tries, bg.tries], [70, 20, 2, 0], "the effects volume moves the effects only, with a sample after each step");
	by("Background volume up").run();
	assert.deepEqual([fx.volume, bg.volume], [70, 30], "and the background volume the background only");
	assert.equal(entriesOf(a.acts, prefs as never).find((e) => e.label === "Sound effects volume up")!.hint, "70", "read fresh");
	assert.equal(entriesOf(a.acts, prefs as never).find((e) => e.label === "Background volume up")!.hint, "30");
	for (let i = 0; i < 20; i++) by("Sound effects volume down").run();
	assert.equal(fx.volume, 0, "clamped at 0");
	for (let i = 0; i < 20; i++) by("Background volume up").run();
	assert.equal(bg.volume, 100, "clamped at 100");
	assert.equal(fx.volume, 0, "the other class stays");
});

test("entriesOf leaves out what the page cannot do now: no companion, no cycle, no settings, and no preferences given", () => {
	assert.deepEqual(labels(entriesOf({ leave: () => {} }, {})), ["Leave Zen (Esc Esc)"]);
	const one = entriesOf({ leave: () => {}, settings: () => {} }, {});
	assert.deepEqual(labels(one), ["Settings", "Leave Zen (Esc Esc)"]);
});

test("entriesOf lists Music only when a music switch is given", () => {
	let on = false;
	const list = entriesOf({ leave: () => {} }, { music: { on: () => on, set: (v) => void (on = v) } });
	const music = list.find((e) => e.label === "Music")!;
	assert.equal(music.hint, "Off");
	assert.equal(music.keep, true);
	music.run();
	assert.equal(on, true);
	assert.equal(entriesOf({ leave: () => {} }, {}).some((e) => e.label === "Music"), false);
});
