import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { El, page, stored } from "./fake-dom.ts";

// gui/notify.ts on the fake document: the Sound switch and Volume follow another tab's write (the `storage` event), and the first read of the three switches comes from the store.
// The sound clips are .mp3 imports the bundler turns into URLs; here a hook gives each one a string.
register("data:text/javascript," + encodeURIComponent(`export const load = (url, ctx, next) => url.endsWith(".mp3") ? { format: "module", source: "export default " + JSON.stringify(url), shortCircuit: true } : next(url, ctx);`));
const heard: ((e: { key: string | null }) => void)[] = [];
Object.assign(globalThis, { addEventListener: (type: string, on: (e: { key: string | null }) => void) => type === "storage" && heard.push(on) });
const { KEYS } = await import("../gui/prefs.ts");
const { mountNotify } = await import("../gui/notify.ts");
const { audio } = await import("../gui/audio.ts");
const { useSounds } = await import("../gui/themesounds.ts");
// The page's one playback core is replaced by recorders: what notify asks of it is what these tests read.
const played: string[] = [], volumes: [string, number][] = [];
const fallbacks: (string | undefined)[] = [];
audio.play = (url, fallback) => void (played.push(url), fallbacks.push(fallback));
audio.volume = (cls, v) => void volumes.push([cls, v]);
const lastVolume = (cls: string) => volumes.filter(([c]) => c === cls).at(-1)?.[1];

const ids = ["remind", "remind-note", "effects", "effects-vol", "effects-vol-out", "effects-try", "background", "background-vol", "background-vol-out"];
function rig(seed: Record<string, string> = {}) {
	stored.clear();
	played.length = volumes.length = 0;
	for (const [k, v] of Object.entries(seed)) stored.set(k, v);
	const els = Object.fromEntries(ids.map((id) => [id, new El(id.endsWith("-vol") ? "input" : id.endsWith("-vol-out") ? "output" : "button")]));
	Object.assign(page, { getElementById: (id: string) => els[id] });
	const n = mountNotify(() => {});
	// Another tab writes `key`: the store changes, then the event arrives (a tab's own write fires none in itself).
	const other = (key: string, value: string) => (stored.set(key, value), heard.forEach((f) => f({ key })));
	return { n, els, other };
}

test("the first read: each class's switch and volume from the store, Remind on unless stored off", () => {
	const r = rig({ [KEYS.effects]: "1", [KEYS.effectsVolume]: "35", [KEYS.background]: "0", [KEYS.backgroundVolume]: "80", [KEYS.remind]: "0" });
	assert.deepEqual([r.n.sound.effects.on(), r.n.sound.effects.volume(), r.n.sound.background.on(), r.n.sound.background.volume()], [true, 35, false, 80]);
	assert.equal(r.els.effects!.getAttribute("aria-pressed"), "true");
	assert.equal(r.els.background!.getAttribute("aria-pressed"), "false");
	assert.equal(r.els["effects-vol"]!.value, "35");
	assert.equal(r.els["background-vol"]!.value, "80");
	assert.equal(r.els.remind!.getAttribute("aria-pressed"), "false");
	const d = rig();
	assert.deepEqual([d.n.sound.effects.on(), d.n.sound.effects.volume(), d.n.sound.background.on(), d.n.sound.background.volume()], [false, 60, false, 60]);
	assert.equal(d.els.remind!.getAttribute("aria-pressed"), "true");
});

test("migration on the page: the old Sound on at Volume 35 draws both classes on at 35, and the old Sound off both off", () => {
	const on = rig({ "sb.sound": "1", "sb.volume": "35" });
	assert.deepEqual([on.els.effects!.dataset.state, on.els.background!.dataset.state, on.els["effects-vol"]!.value, on.els["background-vol"]!.value], ["on", "on", "35", "35"]);
	assert.deepEqual([lastVolume("effects"), lastVolume("background")], [35, 35], "the core gets both");
	const off = rig({ "sb.sound": "0", "sb.volume": "35" });
	assert.deepEqual([off.els.effects!.dataset.state, off.els.background!.dataset.state], ["off", "off"]);
});

test("each switch changes its class only: the press, the API, and the store", () => {
	const r = rig();
	r.els.effects!.onclick!();
	assert.deepEqual([r.n.sound.effects.on(), r.n.sound.background.on()], [true, false]);
	assert.deepEqual([stored.get(KEYS.effects), stored.get(KEYS.background)], ["1", undefined]);
	r.els.background!.onclick!();
	r.n.sound.effects.set(false);
	assert.deepEqual([r.n.sound.effects.on(), r.n.sound.background.on()], [false, true]);
	assert.deepEqual([r.els.effects!.dataset.state, r.els.background!.dataset.state], ["off", "on"]);
	assert.deepEqual([stored.get(KEYS.effects), stored.get(KEYS.background)], ["0", "1"]);
});

test("each volume reaches the playback core for its class only, at mount, on the slider, from the API, and from another tab", () => {
	const r = rig({ [KEYS.effectsVolume]: "35", [KEYS.backgroundVolume]: "70" });
	assert.deepEqual([lastVolume("effects"), lastVolume("background")], [35, 70], "the stored volumes at mount");
	volumes.length = 0;
	r.n.sound.effects.setVolume(80);
	assert.deepEqual(volumes, [["effects", 80]], "only the effects' gain moved");
	volumes.length = 0;
	r.els["background-vol"]!.value = "15";
	r.els["background-vol"]!.oninput!();
	assert.deepEqual(volumes, [["background", 15]], "the slider moves its class's gain only");
	assert.equal(stored.get(KEYS.backgroundVolume), "15");
	assert.equal(stored.get(KEYS.effectsVolume), "80");
	volumes.length = 0;
	r.other(KEYS.effectsVolume, "25");
	assert.deepEqual([...new Set(volumes.map(([c, v]) => `${c} ${v}`))], ["effects 25"], "another tab (earlier mounts of this file listen too, so each answer repeats)");
	assert.equal(r.els["effects-vol-out"]!.value, "25");
	assert.equal(r.els["background-vol-out"]!.value, "15");
});

test("another tab's switch applies here: the button and the answer follow, the class that changed is told, and nothing is written back", () => {
	const r = rig();
	const told = { effects: 0, background: 0 };
	r.n.sound.effects.onChange(() => told.effects++);
	r.n.sound.background.onChange(() => told.background++);
	const writes: string[] = [], set = localStorage.setItem;
	localStorage.setItem = (k, v) => (writes.push(k), set(k, v));
	r.other(KEYS.background, "1");
	localStorage.setItem = set;
	assert.deepEqual([r.n.sound.background.on(), r.n.sound.effects.on()], [true, false]);
	assert.equal(r.els.background!.getAttribute("aria-pressed"), "true");
	assert.equal(r.els.background!.dataset.state, "on");
	assert.equal(r.els.effects!.dataset.state, "off");
	assert.deepEqual(writes, [], "no echo");
	assert.deepEqual(told, { effects: 0, background: 1 }, "the Zen menu and the music are told for the class that changed");
	r.other(KEYS.effectsVolume, "25");
	assert.deepEqual(told, { effects: 1, background: 1 });
	r.other(KEYS.view, "zen"); // another key: ignored
	r.other("sb.sound", "0"); // the old key is no class's
	assert.deepEqual(told, { effects: 1, background: 1 });
});

test("a change made here is told too (the music stops when Background is switched off from the Zen menu)", () => {
	const r = rig();
	let told = 0;
	r.n.sound.background.onChange(() => told++);
	r.n.sound.background.set(true);
	r.n.sound.background.setVolume(10);
	r.n.sound.effects.set(true);
	assert.equal(told, 2, "the background's own two, not the effects'");
});

const alert = (mark: string, over: Record<string, unknown> = {}) => ({ key: mark, name: mark, mark, ...over }) as never;

// Only what waits on the boss rings (boss, 2026-11-24: 「我們應該只需要 需要使用者注意 的時候放音效（背景音）除外」, 「我甚至覺得 finished 的音效拿掉」): a question, a dialog pending, a trust prompt. A finish and a failure play no clip.
test("a batch rings the question clip only when it holds an alert that waits on the boss, and only with Sound effects on; a finish or a failure alone is silent", () => {
	const off = rig();
	off.n.signal([alert("waiting")]);
	assert.deepEqual(played, [], "Sound effects off: silent");
	const r = rig({ [KEYS.effects]: "1" });
	r.n.signal([alert("done"), alert("waiting"), alert("error")]);
	assert.equal(played.length, 1);
	assert.match(played[0]!, /waiting\.mp3$/);
	r.n.signal([alert("done"), alert("error")]);
	r.n.signal([alert("done")]);
	r.n.signal([alert("error")]);
	assert.equal(played.length, 1, "no clip for a finish or a failure");
	r.n.signal([alert("working", { pending: { id: "d1" } })]);
	r.n.signal([alert("waiting", { trust: { folder: "/p" } })]);
	assert.equal(played.length, 3, "a pending dialog and a trust prompt ring");
	assert.ok(played.every((u) => /waiting\.mp3$/.test(u)));
});

test("a finish and a failure keep their silent system notification while the page is hidden; only a question's may sound", () => {
	const made: { title: string; silent: boolean }[] = [];
	class Note { static permission = "granted"; onclick?: () => void; constructor(title: string, o: { silent: boolean }) { made.push({ title, silent: o.silent }); } close() {} }
	const keep = { N: (globalThis as { Notification?: unknown }).Notification, hidden: page.hidden };
	Object.assign(globalThis, { Notification: Note });
	page.hidden = true;
	try {
		const r = rig({ [KEYS.effects]: "1" });
		r.n.signal([alert("done"), alert("error"), alert("waiting")]);
		assert.deepEqual(made.map((n) => [n.title, n.silent]), [["done", true], ["error", true], ["waiting", false]]);
		assert.equal(played.length, 1, "one clip: the question's");
	} finally {
		Object.assign(globalThis, { Notification: keep.N });
		page.hidden = keep.hidden;
	}
});

test("the cues are effects: Background on with Effects off is silent, and Effects on with Background off plays", () => {
	const bgOnly = rig({ [KEYS.background]: "1" });
	bgOnly.n.signal([alert("waiting"), alert("error")]);
	bgOnly.n.chime();
	assert.deepEqual(played, []);
	const fxOnly = rig({ [KEYS.effects]: "1" });
	fxOnly.n.signal([alert("waiting")]);
	fxOnly.n.chime();
	assert.equal(played.length, 2);
	fxOnly.n.sound.effects.set(false);
	fxOnly.n.sound.background.set(true);
	fxOnly.n.signal([alert("waiting")]);
	assert.equal(played.length, 2, "switched off from the Zen menu: silent at once");
});

test("chime (a new link notice that needs the boss) plays the question clip with Sound effects on and nothing with it off", () => {
	const off = rig();
	off.n.chime();
	assert.deepEqual(played, []);
	const r = rig({ [KEYS.effects]: "1" });
	r.n.chime();
	assert.equal(played.length, 1);
	assert.match(played[0]!, /waiting\.mp3$/);
	r.other(KEYS.effects, "0");
	r.n.chime();
	assert.equal(played.length, 1, "another tab's Off silences it");
});

test("Try and turning Sound effects on play the question clip, the one sound the effects make; Background has no clip to try or to say it is on", () => {
	const r = rig();
	r.n.sound.effects.try();
	assert.match(played.at(-1)!, /waiting\.mp3$/);
	played.length = 0;
	r.n.sound.effects.set(true);
	assert.equal(played.length, 1, "on: one clip to say so");
	r.n.sound.effects.set(false);
	assert.equal(played.length, 1, "off: none");
	r.els["effects-try"]!.onclick!();
	assert.equal(played.length, 2, "the Try button");
	r.els.effects!.onclick!();
	assert.equal(played.length, 3, "and the settings' switch pressed on says it too");
	r.n.sound.background.try();
	r.n.sound.background.set(true);
	assert.equal(played.length, 3, "Background plays no clip");
});

test("a theme's question clip replaces the base one while it is the view, the settings' try and the chime included, and the base clip comes back with Standard", () => {
	const r = rig({ [KEYS.effects]: "1" });
	useSounds({ waiting: "/themes/raven/ask-1.mp3" });
	try {
		r.n.signal([alert("waiting")]);
		r.n.signal([alert("error")]);
		r.n.signal([alert("done")]);
		r.n.chime();
		r.n.sound.effects.try();
		assert.deepEqual(played, ["/themes/raven/ask-1.mp3", "/themes/raven/ask-1.mp3", "/themes/raven/ask-1.mp3"]);
	} finally {
		useSounds(undefined);
	}
	played.length = 0;
	r.n.chime();
	assert.match(played[0]!, /waiting\.mp3$/);
	assert.ok(!played[0]!.includes("themes/"), "Standard's own clip again");
});

test("a theme's clip is played with Standard's question clip as its fallback", () => {
	const r = rig({ [KEYS.effects]: "1" });
	fallbacks.length = 0;
	useSounds({ waiting: "/themes/raven/ask-1.mp3" });
	try {
		r.n.chime();
		assert.match(fallbacks[0]!, /waiting\.mp3$/);
		assert.ok(!fallbacks[0]!.includes("themes/"));
	} finally {
		useSounds(undefined);
	}
});
