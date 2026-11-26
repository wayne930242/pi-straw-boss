import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { El, page } from "./fake-dom.ts";

// Z4's small parts, each on the fake document: the corner menu (gui/zenmenu.ts), the full-screen control (gui/zenfs.ts), the line under the idle circle (gui/zenlines.ts), the shared sound and
// language stores, and the words.
const { mountMenu } = await import("../gui/zenmenu.ts");
const { mountFullscreen, HINT_KEY } = await import("../gui/zenfs.ts");
const { deck, LINES, mountLine, LINE_MS, FADE_MS } = await import("../gui/zenlines.ts");
const { createPrefs, KEYS } = await import("../gui/prefs.ts"); // the sound stores are prefs.ts's now
type St = Parameters<typeof createPrefs>[0];
type Cls = "effects" | "background";
const VOL = { effects: "effectsVolume", background: "backgroundVolume" } as const;
const { setLocale } = await import("../gui/i18n.ts");

/** A clock the test moves: `later` queues, `advance` runs what falls due. */
function clock() {
	let t = 0;
	const q: { at: number; fn: () => void }[] = [];
	return {
		later: (fn: () => void, ms: number) => {
			const e = { at: t + ms, fn };
			q.push(e);
			return () => void (q.includes(e) && q.splice(q.indexOf(e), 1));
		},
		advance(ms: number) {
			t += ms;
			for (;;) {
				const due = q.filter((e) => e.at <= t).sort((a, b) => a.at - b.at)[0];
				if (!due) return;
				q.splice(q.indexOf(due), 1);
				due.fn();
			}
		},
		pending: () => q.length,
	};
}
const store = () => {
	const m = new Map<string, string>();
	return Object.assign(m, { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }) as Map<string, string> & Pick<Storage, "getItem" | "setItem">;
};
const text = (e: El) => e.textContent;

function menuRig(o: { sound?: boolean } = {}) {
	const c = clock(), st = store(), calls: string[] = [], pf = createPrefs(st);
	let lang = "en";
	const state = { effects: { on: o.sound ?? false, volume: 60 }, background: { on: false, volume: 60 } };
	const sw = (cls: Cls) => ({
		on: () => state[cls].on, volume: () => state[cls].volume, onChange() {},
		set: (on: boolean) => ((state[cls].on = on), pf.set(cls, on), calls.push(`${cls}:${on}`)),
		setVolume: (v: number) => ((state[cls].volume = v), pf.set(VOL[cls], v), calls.push(`${cls}-volume:${v}`)),
		try: () => calls.push(`${cls}-try`),
	});
	const m = mountMenu({
		language: { get: () => lang, names: () => [{ id: "en", name: "English" }, { id: "zh-TW", name: "正體中文" }], set: (id) => ((lang = id), calls.push(`lang:${id}`)) },
		sound: { effects: { ...sw("effects"), all: () => calls.push("try-all") }, background: sw("background") },
	}, () => calls.push("leave"));
	page.body.replaceChildren(m.el as unknown as El);
	page.focused = undefined;
	const host = m.el as unknown as El, btn = m.button as unknown as El;
	const by = (label: string) => host.all((e) => e.tagName === "button" && text(e) === label)[0]!;
	/** A class's switch (the effects' is the first On or Off button, Background's the second) and its volume slider (the first and second range). */
	const onOff = () => host.all((e) => e.tagName === "button" && ["On", "Off"].includes(text(e))), ranges = () => host.all((e) => e.tagName === "input");
	const sw$ = (cls: Cls) => onOff()[cls === "effects" ? 0 : 1]!, vol$ = (cls: Cls) => ranges()[cls === "effects" ? 0 : 1]!;
	return { c, st, calls, m, host, btn, by, sw$, vol$, key: (key: string, extra: object = {}) => (page.focused ?? host).bubble("keydown", { key, ...extra }), mouse: (type: string) => host.bubble(type, { pointerType: "mouse" }) };
}

test("the menu never opens by hover, whatever the pointer or the time; a press of its button opens it, a second press, Esc, a press outside, and a choice of language or the way out close it", () => {
	const r = menuRig();
	assert.equal(r.btn.getAttribute("aria-expanded"), "false");
	assert.equal(r.host.handlers.pointerenter, undefined, "no hover handler is listening");
	assert.equal(r.host.handlers.pointerleave, undefined);
	for (const pointerType of ["mouse", "touch", "pen"]) r.host.bubble("pointerenter", { pointerType });
	r.c.advance(60_000);
	assert.equal(r.m.isOpen(), false, "hovering opens nothing");
	assert.equal(r.c.pending(), 0, "and sets no timer");
	r.btn.click(); // a click, a tap, Enter, or Space on the focused button: all are a click
	assert.equal(r.m.isOpen(), true);
	assert.equal(r.btn.getAttribute("aria-expanded"), "true");
	assert.equal(page.focused, r.by("English"), "the focus moves into the menu");
	r.host.bubble("pointerleave", { pointerType: "mouse" });
	r.c.advance(60_000);
	assert.equal(r.m.isOpen(), true, "leaving with the pointer closes nothing");
	r.btn.click();
	assert.equal(r.m.isOpen(), false, "a second press closes it");
	r.btn.click();
	r.key("Escape");
	assert.equal(r.m.isOpen(), false);
	assert.equal(page.focused, r.btn, "Esc returns the focus to the button");
	assert.equal(r.m.close(), false, "closing a closed menu is not Zen's key to take");
	r.btn.click();
	for (const on of page.on.pointerdown ?? []) on({ target: new El("div") });
	assert.equal(r.m.isOpen(), false, "a press outside closes it");
	r.btn.click();
	for (const on of page.on.pointerdown ?? []) on({ target: r.host });
	assert.equal(r.m.isOpen(), false, "so does a press on the veil, which the host draws and takes, so the press never reaches the card under it (ZVL-F002)");
	for (const label of ["正體中文", "Leave Zen"]) {
		r.btn.click();
		(label === "Leave Zen" ? r.host.all((e) => e.getAttribute("class") === "zen-leave")[0]! : r.by(label)).click();
		assert.equal(r.m.isOpen(), false, `choosing ${label} closes it`);
	}
	r.btn.click();
	for (const cls of ["effects", "background"] as const) {
		r.sw$(cls).click();
		assert.equal(r.m.isOpen(), true, `the ${cls} switch leaves it open, so the volume can follow`);
		const vol = r.vol$(cls);
		vol.value = "40";
		vol.oninput?.();
		(vol as unknown as { onchange?: () => void }).onchange?.();
		vol.bubble("change");
		assert.equal(r.m.isOpen(), true, `a ${cls} volume change leaves it open too`);
	}
	for (const type of ["pointerover", "mouseenter", "mouseover", "pointermove"]) {
		r.m.close();
		assert.equal(r.m.isOpen(), false);
		assert.equal(r.host.handlers[type], undefined, `no ${type} handler on the menu`);
		assert.equal(r.btn.handlers[type], undefined, `no ${type} handler on its button`);
		r.host.bubble(type, { pointerType: "mouse" });
		r.btn.bubble(type, { pointerType: "mouse" });
		r.c.advance(60_000);
		assert.equal(r.m.isOpen(), false, `${type} opens nothing`);
	}
});

test("an open menu traps Tab inside, and a press outside closes it", () => {
	const r = menuRig();
	r.btn.click();
	const stops = r.host.all((e) => e.tagName === "button" || e.tagName === "input").filter((e) => e !== r.btn);
	assert.ok(stops.length >= 8, "language, sound effects (switch, Try, volume), background sound (switch, volume), and the way out");
	page.focused = stops.at(-1);
	r.key("Tab");
	assert.equal(page.focused, stops[0], "past the last control it wraps to the first");
	r.key("Tab", { shiftKey: true });
	assert.equal(page.focused, stops.at(-1), "and back");
	for (const on of page.on.pointerdown ?? []) on({ target: new El("div") });
	assert.equal(r.m.isOpen(), false);
});

test("each row acts through the settings page's own function or store: language, each sound class's switch and volume, and the way out; there is no theme row (O4)", () => {
	const r = menuRig();
	r.btn.click();
	r.by("正體中文").click();
	r.sw$("effects").click();
	r.vol$("effects").value = "35";
	r.vol$("effects").oninput?.();
	(r.vol$("effects") as unknown as { onchange?: () => void }).onchange?.();
	r.sw$("background").click();
	r.vol$("background").value = "15";
	r.vol$("background").oninput?.();
	(r.vol$("background") as unknown as { onchange?: () => void }).onchange?.();
	assert.equal(r.host.all((e) => e.tagName === "button" && ["Auto", "Standard", "Geek", "Raven Keep"].includes(text(e))).length, 0, "no theme row");
	r.by("Leave Zen (Esc Esc)").click();
	assert.deepEqual(r.calls.filter((c) => !c.endsWith("-try")), ["lang:zh-TW", "effects:true", "effects-volume:35", "background:true", "background-volume:15", "leave"]);
	assert.deepEqual(r.calls.filter((c) => c.endsWith("-try")), ["effects-try", "background-try"], "a release of either volume plays its class's sample");
	assert.deepEqual([r.st.get(KEYS.effects), r.st.get(KEYS.effectsVolume), r.st.get(KEYS.background), r.st.get(KEYS.backgroundVolume)], ["1", "35", "1", "15"], "each class's own keys");
	const read = createPrefs(r.st);
	assert.deepEqual([read.get("effects"), read.get("effectsVolume"), read.get("background"), read.get("backgroundVolume")], [true, 35, true, 15]);
	r.btn.click();
	r.by("Try the sounds").click();
	assert.equal(r.calls.at(-1), "try-all", "Try plays Zen's three effects; Background has none");
	assert.equal(r.host.all((e) => e.getAttribute("class") === "zen-music")[0]!.getAttribute("hidden"), "", "the music's slot is there and hidden until Z6");
});

test("the language is kept under the settings page's key and the page reloads; a refused store reports it", () => {
	const st = store();
	let reloaded = 0;
	assert.equal(setLocale("zh-TW", st, () => reloaded++), true);
	assert.equal(st.get("sb-locale"), "zh-TW");
	assert.equal(reloaded, 1);
	assert.equal(setLocale("en", { setItem() { throw new Error("refused"); } }, () => reloaded++), false);
	assert.equal(reloaded, 1, "no reload when nothing was kept");
});

function fsRig(o: { enabled?: boolean; standalone?: boolean; touch?: boolean; seen?: boolean } = {}) {
	const c = clock(), st = store(), calls: string[] = [], listeners: Record<string, (() => void)[]> = {};
	if (o.seen) st.setItem(HINT_KEY, "1");
	const doc = {
		fullscreenEnabled: o.enabled ?? true, fullscreenElement: undefined as unknown,
		exitFullscreen: async () => void (calls.push("exit"), (doc.fullscreenElement = undefined)),
		addEventListener: (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn),
		documentElement: { requestFullscreen: async () => void (calls.push("request"), (doc.fullscreenElement = {})) },
	};
	const f = mountFullscreen({ doc, standalone: () => o.standalone ?? false, touch: () => o.touch ?? false, seen: st, later: c.later });
	return { f, doc, calls, c, st, change: () => listeners.fullscreenchange?.forEach((fn) => fn()), button: f.button as unknown as El };
}

test("the full-screen control is shown only where the browser can, toggles the page, and its label follows the state", async () => {
	const r = fsRig();
	assert.equal(r.button.hidden, false);
	assert.equal(r.button.getAttribute("aria-label"), "Full screen");
	r.button.click();
	await Promise.resolve();
	r.change();
	assert.deepEqual(r.calls, ["request"]);
	assert.equal(r.button.getAttribute("aria-label"), "Exit full screen");
	assert.equal(r.button.getAttribute("aria-pressed"), "true");
	r.button.click();
	await Promise.resolve();
	r.change();
	assert.deepEqual(r.calls, ["request", "exit"]);
	assert.equal(r.button.getAttribute("aria-label"), "Full screen");
	assert.equal(fsRig({ enabled: false }).button.hidden, true, "an iPhone's Safari has no API: hidden");
});

test("where full screen is not offered, a touch device that is not an installed app is told once, quietly, to add the page to the Home Screen", () => {
	const r = fsRig({ enabled: false, touch: true });
	assert.ok(r.f.hint, "the hint shows");
	assert.equal((r.f.hint as unknown as El).textContent, "For full screen, add this page to your Home Screen.");
	assert.equal(r.st.get(HINT_KEY), "1", "and is remembered");
	assert.equal(r.c.pending(), 1);
	r.c.advance(20_000);
	assert.equal(r.c.pending(), 0, "it goes by itself");
	assert.equal(fsRig({ enabled: false, touch: true, seen: true }).f.hint, undefined, "never twice");
	assert.equal(fsRig({ enabled: false, touch: true, standalone: true }).f.hint, undefined, "an installed app needs none");
	assert.equal(fsRig({ enabled: false, touch: false }).f.hint, undefined, "a desktop has no Home Screen to suggest");
	assert.equal(fsRig({ enabled: true, touch: true }).f.hint, undefined, "where full screen works, no hint");
});

test("the deck shows every line once, in a random order, before any repeats, and a new round never starts with the last one", () => {
	let seed = 7;
	const random = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
	const d = deck(LINES.length, random);
	let last = -1;
	for (let round = 0; round < 20; round++) {
		const seen = new Set<number>();
		for (let i = 0; i < LINES.length; i++) {
			const n = d.next();
			assert.ok(!seen.has(n), "no repeat inside a round");
			if (i === 0) assert.notEqual(n, last, "the new round does not open with the old round's last");
			seen.add(n);
			last = n;
		}
		assert.equal(seen.size, LINES.length);
	}
	assert.equal(deck(0).next(), -1);
});

// The words no line may carry (zh, en, ja): the boss wants stillness and the Japanese eye for it without religious vocabulary. Names in `by` are as they are known; 走神 (the mind wandering, in the old lines) is not about gods.
const BANNED = [/禪|禅/, /佛|仏/, /菩薩|菩提|涅槃|輪廻|輪迴/, /悟/, /經|経/, /神/, /祈/, /法(?!則)/, /霊|靈|魂|寺|僧|天國|天国/, /\b(?:buddh\w*|zen|dharma|enlighten\w*|pray\w*|prayer|god|gods|divine|holy|sacred|nirvana|sutra|karma|bodhisattva|soul|spirit\w*|heaven\w*|temple\w*|monks?)\b/i];

test("every line is short, attributed, and sourced in a comment; a Japanese original is carried in `ja`", () => {
	assert.equal(LINES.length, 38);
	for (const l of LINES) {
		assert.ok(l.by.length > 0 && l.zh.length > 0 && l.en.length > 0);
		assert.ok([...l.zh.replace(/[，。、；！？]/g, "")].length <= 16, `short: ${l.zh}`);
		for (const [lang, t] of [["zh", l.zh], ["en", l.en], ["ja", l.ja ?? ""]] as const) for (const w of BANNED) assert.ok(!w.test(t.replace(/走神/g, "")), `${lang} of "${l.zh}" holds ${w}`);
		if (l.ja !== undefined) assert.ok(/[\u3040-\u30ff]|[\u4e00-\u9fff]/.test(l.ja) && l.ja.trim() === l.ja && l.ja.length > 0, `a Japanese original: ${l.ja}`);
	}
	const source = readFileSync(new URL("../gui/zenlines.ts", import.meta.url), "utf8");
	assert.equal([...source.matchAll(/^\t\/\/ .*zh: (published|our translation)/gm)].length, LINES.length, "a source and the zh note above each entry");
	assert.equal([...source.matchAll(/^\t\/\/ .*\bja: /gm)].length, LINES.filter((l) => l.ja).length, "a `ja:` note above each original and above no other");
	assert.equal(LINES.filter((l) => l.ja).length, 22, "the Japanese lines");
	assert.equal(new Set(LINES.map((l) => l.zh)).size, LINES.length, "no line twice");
	assert.equal(LINES.slice(0, 14).filter((l) => l.ja).length, 0, "the first 14 are as they were");
	assert.ok(LINES.some((l) => l.ja === "古池や蛙飛びこむ水の音"));
});

test("the line fades to the next every 45 s, stays still under calm or reduced motion, and stops with the layer", () => {
	const c = clock();
	let still = false, n = 0;
	const lines = [{ zh: "甲", en: "a", by: "x" }, { zh: "乙", en: "b", by: "y" }, { zh: "丙", en: "c", by: "z" }];
	const l = mountLine(c.later, () => still, () => ((n = (n + 1) % 7) / 7), lines);
	const el = l.el as unknown as El, shown = () => el.textContent;
	const first = shown();
	assert.ok(first.length > 0 && el.kids.length === 3, "a line, its source, and the place of the original");
	c.advance(LINE_MS - 1);
	assert.equal(shown(), first);
	c.advance(1);
	assert.equal(el.dataset.fading, "", "it fades first");
	c.advance(FADE_MS);
	assert.notEqual(shown(), first);
	assert.equal(el.dataset.fading, undefined);
	still = true;
	const held = shown();
	c.advance(LINE_MS * 5);
	assert.equal(shown(), held, "calm and reduced motion keep it as it is");
	still = false;
	l.stop();
	assert.equal(c.pending(), 0, "stop cancels the timer");
});

test("a line the strip has sent away keeps its words: no swap while away (the original's height would shift the strip), and the cycle goes on after it comes back", () => {
	const c = clock();
	let n = 0;
	const lines = [{ zh: "甲", en: "a", by: "x" }, { zh: "乙", en: "b", by: "y", ja: "原" }, { zh: "丙", en: "c", by: "z" }];
	const l = mountLine(c.later, () => false, () => ((n = (n + 1) % 7) / 7), lines), el = l.el as unknown as El;
	l.away(true);
	const held = el.textContent, cycle = () => (c.advance(LINE_MS), c.advance(FADE_MS)); // the fake clock fires what is due once per advance
	c.advance(LINE_MS);
	assert.equal(el.dataset.fading, undefined, "away, the turn of the cycle does not start a fade it would not use");
	c.advance(FADE_MS);
	for (let i = 0; i < 3; i++) cycle();
	assert.equal(el.textContent, held, "away, four cycles pass and the words stay");
	assert.equal(el.dataset.fading, undefined, "and it does not start a fade it will not finish");
	l.away(false);
	cycle();
	assert.notEqual(el.textContent, held, "back, the next swap comes");
	c.advance(LINE_MS);
	l.away(true);
	const mid = el.textContent;
	c.advance(FADE_MS);
	assert.equal(el.textContent, mid, "sent away in the middle of a fade, it keeps its words");
	assert.equal(el.dataset.fading, undefined);
	l.stop();
});

test("the Japanese original shows under the source when a line has one, in a lang=ja element, and is hidden and empty when it has none", () => {
	const c = clock(), lines = [{ zh: "古池", en: "pond", by: "芭蕉 / Bashō", ja: "古池や蛙飛びこむ水の音" }, { zh: "吸氣", en: "in", by: "x" }];
	let n = 0;
	const l = mountLine(c.later, () => false, () => (n++ === 0 ? 0 : 0.99), lines), el = l.el as unknown as El;
	const ja = el.all((e) => e.getAttribute("class") === "zen-line-ja")[0]!;
	assert.equal(el.kids[2], ja, "the third element, after the source");
	assert.equal(ja.getAttribute("lang"), "ja");
	const seen = new Map<string, [string, boolean]>();
	for (let i = 0; i < 6; i++) {
		seen.set(el.textContent.includes("pond") || el.textContent.includes("古池") ? "with" : "without", [ja.textContent, ja.hidden]);
		c.advance(LINE_MS + FADE_MS);
	}
	assert.deepEqual(seen.get("with"), ["古池や蛙飛びこむ水の音", false], "shown");
	assert.deepEqual(seen.get("without"), ["", true], "hidden and empty");
	l.stop();
});

test("the words: the new keys exist in both languages with the boss's copy, and zen_nothing is gone", () => {
	const read = (f: string) => JSON.parse(readFileSync(new URL(`../gui/messages/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
	const zh = read("zh-TW"), en = read("en");
	const want: Record<string, string> = { zen_back_title: "回到禪", zen_leave_title: "離開禪（Esc Esc）", zen_esc_hint: "再按一次 Esc 離開禪", zen_enter: "禪", zen_enter_title: "進入禪（一次只看一件待辦）", zen_asks: "{name} 想問你", zen_not_now: "晚點再說", zen_open_terminal: "開啟終端機", zen_term_esc_hint: "再按一次 Esc 回到禪", zen_elsewhere: "已經在別處回好了", zen_pause: "吸一口氣", zen_fullscreen: "全螢幕", zen_fullscreen_exit: "離開全螢幕", zen_add_home: "想全螢幕，可以把這頁加入主畫面。" };
	for (const [k, v] of Object.entries(want)) {
		assert.equal(zh[k], v, k);
		assert.ok(en[k] && en[k] !== v, `${k} has its English`);
	}
	for (const k of ["zen_menu"]) assert.ok(zh[k] && en[k]);
	assert.equal(zh.zen_nothing, undefined);
	assert.equal(en.zen_nothing, undefined);
	assert.ok(!/[\u4e00-\u9fff]/.test(Object.entries(en).filter(([k]) => k.startsWith("zen_")).map(([, v]) => v).join("")), "the English words are English");
});

test("Zen's Esc table: the menu first, then a field with text, an item, an empty field, and last the pair that leaves", async () => {
	const { escStep, ESC_MS } = await import("../gui/zenkeys.ts");
	assert.equal(ESC_MS, 600);
	const none = { menu: false, field: "none", item: false, armed: false } as const;
	assert.equal(escStep({ ...none, menu: true, field: "text", item: true, armed: true }), "menu", "an open menu takes it before anything");
	assert.equal(escStep({ ...none, field: "text", item: true }), "blur", "text in a field comes before the card");
	assert.equal(escStep({ ...none, field: "empty", item: true }), "item", "an empty field does not stand in a card's way");
	assert.equal(escStep({ ...none, item: true, armed: true }), "item", "on a card the pair never forms");
	assert.equal(escStep({ ...none, reply: true, field: "text", item: true }), "reply", "a wait card's open answer box folds first, the draft kept, and the card stays");
	assert.equal(escStep({ ...none, reply: true, field: "empty", item: true }), "reply");
	assert.equal(escStep({ ...none, reply: true, menu: true }), "menu", "an open menu is before it");
	assert.equal(escStep({ ...none, reply: true, history: true }), "history");
	assert.equal(escStep({ ...none, reply: true, repeat: true }), "none");
	assert.equal(escStep({ ...none, field: "empty" }), "blur", "on the companion an empty field is let go of");
	assert.equal(escStep(none), "hint");
	assert.equal(escStep({ ...none, armed: true }), "leave");
	assert.equal(escStep({ ...none, armed: true, repeat: true }), "none", "a held key is nothing");
	assert.equal(escStep({ ...none, menu: true, repeat: true }), "none");
});

test("Esc's head row (docs/specs/2026-11-04-head-tower.md): after the menu and the open history, before a field with text or a card; an unfolded input is folded and nothing else happens", async () => {
	const { escStep } = await import("../gui/zenkeys.ts");
	const none = { menu: false, field: "none", item: false, armed: false } as const;
	assert.equal(escStep({ ...none, head: true }), "head", "the input is unfolded: Esc folds it");
	assert.equal(escStep({ ...none, head: true, field: "text" }), "head", "with a draft in the box too: the draft is kept, the box folds, the focus is not just let go of");
	assert.equal(escStep({ ...none, head: true, field: "empty", armed: true }), "head", "and the pair that leaves does not form");
	assert.equal(escStep({ ...none, head: true, history: true, field: "text" }), "history", "the history open on the circle is the history row's, which comes first");
	assert.equal(escStep({ ...none, head: true, menu: true }), "menu", "the menu comes before it");
	assert.equal(escStep({ ...none, head: true, repeat: true }), "none", "a held key is nothing");
	assert.equal(escStep({ ...none, head: false, field: "text" }), "blur", "no input unfolded: the rows are as they were");
});

test("Esc's rest row (docs/specs/2026-11-04-head-tower.md, Resting the strip): after every row that holds something open and an empty field, before the hint and the pair that leaves", async () => {
	const { escStep } = await import("../gui/zenkeys.ts");
	const none = { menu: false, field: "none", item: false, armed: false } as const;
	assert.equal(escStep({ ...none, rest: true }), "rest", "lines are clear under the circle: Esc rests the strip");
	assert.equal(escStep({ ...none, rest: true, armed: true }), "rest", "and the pair that leaves does not form while there is something to rest");
	assert.equal(escStep({ ...none, rest: false }), "hint", "a strip already at rest: the rows are as they were");
	assert.equal(escStep({ ...none, rest: false, armed: true }), "leave");
	assert.equal(escStep({ ...none, rest: true, menu: true }), "menu", "the menu comes first");
	assert.equal(escStep({ ...none, rest: true, history: true }), "history");
	assert.equal(escStep({ ...none, rest: true, head: true }), "head", "an unfolded input folds before the strip rests");
	assert.equal(escStep({ ...none, rest: true, field: "text" }), "blur", "text in a field is let go of first");
	assert.equal(escStep({ ...none, rest: true, field: "empty" }), "blur", "so is an empty field");
	assert.equal(escStep({ ...none, rest: true, item: true }), "item", "an item on the page is not under the circle: its row comes first");
	assert.equal(escStep({ ...none, rest: true, repeat: true }), "none", "a held key is nothing");
});

test("an open menu redraws each class's switch and volume when another tab changes them; a closed one is left alone", () => {
	const told: (() => void)[] = [];
	let sound = false, volume = 60;
	const cls = { on: () => sound, volume: () => volume, set: () => {}, setVolume: () => {}, try: () => {}, onChange: (fn: () => void) => void told.push(fn) };
	const m = mountMenu({ sound: { effects: cls, background: { ...cls, on: () => false, volume: () => 5 } } }, () => {});
	page.body.replaceChildren(m.el as unknown as El);
	const host = m.el as unknown as El, on = host.all((e) => e.getAttribute("class") === "zen-opt")[0]!;
	const vol = host.all((e) => e.tagName === "input")[0]!;
	m.button.click();
	assert.equal(on.getAttribute("aria-pressed"), "false");
	[sound, volume] = [true, 25];
	told.forEach((f) => f());
	assert.equal(on.getAttribute("aria-pressed"), "true");
	assert.equal(vol.value, "25");
	m.close();
	[sound, volume] = [false, 80];
	told.forEach((f) => f());
	assert.equal(on.getAttribute("aria-pressed"), "true", "closed: not redrawn (the next open does)");
});

test("ZNI: the words of the second round exist in both languages: a unit that left, the company that ended or lost control, and the terminal's step notes", () => {
	const read = (f: string) => JSON.parse(readFileSync(new URL(`../gui/messages/${f}.json`, import.meta.url), "utf8")) as Record<string, string>;
	const zh = read("zh-TW"), en = read("en");
	const want: Record<string, [string, string]> = {
		zen_gone: ["這個單位已離開", "This unit has left"], zen_company_ended: ["已結束", "Ended"], zen_company_lost: ["已失去控制", "Lost control"],
		zen_term_sent: ["指令已送出，可以回到禪", "Command sent. You can go back to Zen."], zen_term_working: ["單位繼續工作了，可以回到禪", "The unit is working again. You can go back to Zen."], zen_term_gone: ["這個窗格已關閉，可以回到禪", "This pane has closed. You can go back to Zen."],
	};
	for (const [key, [a, b]] of Object.entries(want)) assert.deepEqual([zh[key], en[key]], [a, b], key);
});
