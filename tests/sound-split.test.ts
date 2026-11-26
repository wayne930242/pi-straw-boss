import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createAudio } from "../gui/audio.ts";
import { musicBus } from "../gui/audiobus.ts";
import { createPrefs, KEYS, LEGACY } from "../gui/prefs.ts";
import { createZenSound } from "../gui/zensound.ts";

// Todo #139: background sound and sound effects are two classes with a switch and a volume each. This file holds the page-wide rules (the classification, the migration of the old single setting,
// the playback core's two gains); the sources' own tests (notify, zen-sound, zen-music, raven-weather, zen-extras, palette) hold what each does with its class.

const root = fileURLToPath(new URL("..", import.meta.url));

// --- classification -----------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Every sound source of the page and the class it plays in (docs/specs/2026-11-09-sound-split.md, Classification). A source is a file that makes sound; the file must ask the core for its class by name.
const SOURCES: [file: string, what: string, cls: "effects" | "background"][] = [
	["audio.ts", "the clip played by `play`: the question cue (Standard's or Raven's bell; a finish and a failure have none), the link notices' chime, the settings' Try", "effects"],
	["zensound.ts", "Zen's bowl, knock, and low bowl, and the Try buttons", "effects"],
	["zensound.ts", "Zen's duck node, the way the music reaches the core", "background"],
	["audiobus.ts", "Zen's music bus", "background"],
	["zenmusic.ts", "Zen's music files", "background"],
	["themes/storybook/ambience.ts", "Storybook's birds and cricket loops", "background"],
	["themes/raven/weather.ts", "Raven's recorded rain loop and its thunder", "background"],
];

test("every source asks the playback core for its class by name, and no file besides the core makes an audio context", () => {
	for (const [file, what, cls] of SOURCES) {
		const code = readFileSync(join(root, "gui", file), "utf8");
		assert.ok(code.includes(`out("${cls}")`) || (file === "audio.ts" && code.includes(`out("effects")`)), `${file} (${what}) takes ${cls}`);
	}
	const files = (dir: string): string[] => readdirSync(join(root, "gui", dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() && e.name !== "paraglide" && e.name !== "fonts" ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
	const listed = new Set(SOURCES.map(([file]) => file));
	for (const file of files("")) {
		const code = readFileSync(join(root, "gui", file), "utf8"), allowed = new Set(SOURCES.filter(([f]) => f === file).map(([, , cls]) => cls));
		for (const [, arg] of code.matchAll(/\.out\(([^)]*)\)/g)) {
			assert.match(arg!, /^"(effects|background)"$/, `${file} names a class at every out()`);
			assert.ok(allowed.has(JSON.parse(arg!)), `${file} asks for ${arg}, a class it is not classified in`);
		}
		if (/new AudioContext|createMediaElementSource|createBufferSource\(/.test(code) && !file.endsWith("audio.ts")) assert.ok(listed.has(file) || file === "link.ts", `${file} makes sound and is not in the classification`);
		if (/new AudioContext/.test(code)) assert.equal(file, "audio.ts", "one context, the core's");
	}
});

// --- the core -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
interface Node { kind: string; to?: Node | undefined; gain: { value: number } }
function core() {
	const nodes: Node[] = [];
	const destination = { kind: "destination", gain: { value: 1 } } as Node;
	const ac = {
		destination, state: "running", sampleRate: 8000, currentTime: 0,
		createGain: () => { const n: Node = { kind: "gain", gain: { value: 1 } }; (n as unknown as { connect(t: Node): void }).connect = (t) => void (n.to = t); return (nodes.push(n), n); },
		createBufferSource: () => { const n = { kind: "source", gain: { value: 1 }, buffer: null as unknown, to: undefined as Node | undefined, connect(t: Node) { n.to = t; }, start() {} }; return (nodes.push(n as Node), n); },
		resume: async () => {}, decodeAudioData: async (b: ArrayBuffer) => ({ b }),
	};
	const a = createAudio(() => ac as never, async () => new ArrayBuffer(1));
	/** The product of the gains from `from` to the output. */
	const level = (from: Node | undefined) => { let v = 1; for (let n = from; n && n !== destination; n = n.to) v *= n.gain.value; return v; };
	return { a, ac, nodes, destination, level };
}

test("the core has a gain for each class, both reaching the output", () => {
	const r = core();
	const [e, b] = [r.a.out("effects"), r.a.out("background")];
	assert.notEqual(e.g, b.g);
	assert.equal(e.c, b.c, "one context");
	assert.equal((e.g as unknown as Node).to, r.destination);
	assert.equal((b.g as unknown as Node).to, r.destination);
	assert.equal(r.a.out("effects").g, e.g, "the same node after");
});

test("a volume scales its class only: the square of the fraction, before the gain exists and after", () => {
	const r = core();
	r.a.volume("effects", 50);
	r.a.volume("background", 20);
	assert.equal(r.a.out("effects").g.gain.value, 0.25);
	assert.ok(Math.abs(r.a.out("background").g.gain.value - 0.04) < 1e-12);
	r.a.volume("effects", 100);
	assert.equal(r.a.out("effects").g.gain.value, 1);
	assert.ok(Math.abs(r.a.out("background").g.gain.value - 0.04) < 1e-12, "the other class stays");
	r.a.volume("background", 0);
	assert.equal(r.a.out("effects").g.gain.value, 1);
	assert.equal(r.a.out("background").g.gain.value, 0);
});

test("a clip is an effect: its source reaches the output through the effects gain, at the effects volume and not the background's", async () => {
	const r = core();
	r.a.volume("effects", 50);
	r.a.volume("background", 10);
	r.a.play("a.mp3");
	await new Promise((x) => setTimeout(x, 0));
	const src = r.nodes.find((n) => n.kind === "source")!;
	assert.equal(src.to, r.a.out("effects").g as unknown as Node);
	assert.equal(r.level(src), 0.25);
});

test("Zen's music bus is background: it reaches the output through the background gain only, so the effects volume leaves it alone", () => {
	const r = core();
	r.a.volume("effects", 10);
	r.a.volume("background", 50);
	const bus = musicBus(r.a);
	assert.equal(r.level(bus as unknown as Node), 0.5 * 0.25);
});

test("Zen's effects are effects and its duck node is background: an effects volume of 0 silences the bowl and leaves the music's path alone", () => {
	const r = core();
	const env: Record<string, unknown> = r.ac;
	env.createOscillator = () => ({ type: "", frequency: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} });
	const gains: Node[] = [];
	const make = r.ac.createGain;
	env.createGain = () => { const g = make() as Node & { gain: Record<string, unknown> }; g.gain.setValueAtTime = () => {}; g.gain.linearRampToValueAtTime = () => {}; g.gain.setTargetAtTime = () => {}; g.gain.cancelScheduledValues = () => {}; return (gains.push(g), g); };
	const z = createZenSound(r.a, { on: () => true }, () => ({}) as never, { addEventListener() {}, removeEventListener() {} } as never);
	r.a.out("effects"); // the page's context exists (a first press made it)
	r.a.volume("effects", 0);
	r.a.volume("background", 100);
	z.play("bowl");
	const envelopes = gains.filter((g) => g.to === (r.a.out("effects").g as unknown as Node));
	assert.ok(envelopes.length >= 8, "every partial's envelope ends at the effects gain");
	assert.ok(envelopes.every((g) => r.level(g) === 0));
	const duck = z.bus() as unknown as Node;
	assert.equal(duck.to, r.a.out("background").g as unknown as Node, "the duck node feeds the background gain");
	assert.equal(r.level(duck), 1);
});

// --- migration ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
function store(seed: Record<string, string> = {}) {
	const map = new Map(Object.entries(seed));
	return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
}

test("the old Sound and Volume are the legacy keys of both classes", () => {
	assert.deepEqual(LEGACY, { zen: "sb.view", effects: "sb.sound", background: "sb.sound", effectsVolume: "sb.volume", backgroundVolume: "sb.volume" });
	assert.deepEqual([KEYS.effects, KEYS.effectsVolume, KEYS.background, KEYS.backgroundVolume], ["sb.effects", "sb.effects.volume", "sb.background", "sb.background.volume"]);
	assert.equal("sound" in KEYS || "volume" in KEYS, false, "the single setting is gone from the store's names");
});

test("migration: the old Sound on is both classes on at the old Volume", () => {
	const p = createPrefs(store({ "sb.sound": "1", "sb.volume": "35" }));
	assert.deepEqual([p.get("effects"), p.get("background"), p.get("effectsVolume"), p.get("backgroundVolume")], [true, true, 35, 35]);
});

test("migration: the old Sound off is both classes off, and the old Volume is kept for when they are turned on", () => {
	const p = createPrefs(store({ "sb.sound": "0", "sb.volume": "35" }));
	assert.deepEqual([p.get("effects"), p.get("background"), p.get("effectsVolume"), p.get("backgroundVolume")], [false, false, 35, 35]);
});

test("migration: nothing stored is both off at 60, and a page that stored only the old Volume reads it", () => {
	const p = createPrefs(store());
	assert.deepEqual([p.get("effects"), p.get("background"), p.get("effectsVolume"), p.get("backgroundVolume")], [false, false, 60, 60]);
	assert.equal(createPrefs(store({ "sb.volume": "20" })).get("effectsVolume"), 20);
});

test("after migration each class is its own: a new value wins over the old one and changes only its class", () => {
	const s = store({ "sb.sound": "1", "sb.volume": "35" });
	const p = createPrefs(s);
	p.set("effects", false);
	p.set("backgroundVolume", 80);
	assert.deepEqual([p.get("effects"), p.get("background"), p.get("effectsVolume"), p.get("backgroundVolume")], [false, true, 35, 80]);
	p.set("effects", true);
	p.set("background", false);
	assert.deepEqual([p.get("effects"), p.get("background")], [true, false]);
	assert.equal(s.map.get("sb.sound"), "1", "the old keys are never written: an older page on this device still reads its own");
});

test("a refused storage reads as the defaults for the new keys too, and another tab's write of a new key is heard", () => {
	const p = createPrefs({ getItem: () => { throw new Error("refused"); } });
	assert.deepEqual([p.get("effects"), p.get("background"), p.get("effectsVolume")], [false, false, 60]);
	const heard: string[] = [];
	const hear: ((e: { key: string | null }) => void)[] = [];
	Object.assign(globalThis, { addEventListener: (type: string, f: (e: { key: string | null }) => void) => type === "storage" && hear.push(f) });
	const q = createPrefs(store());
	for (const name of ["effects", "effectsVolume", "background", "backgroundVolume"] as const) q.on(name, () => void heard.push(name));
	for (const key of ["sb.background.volume", "sb.effects", "sb.sound"]) hear.forEach((f) => f({ key }));
	assert.deepEqual(heard, ["backgroundVolume", "effects"], "the old keys are not listened to");
});

// --- the settings page and the words -------------------------------------------------------------------------------------------------------------------------------------------------------
const html = readFileSync(join(root, "gui/index.html"), "utf8");

test("the settings page has a row for each class: a labelled switch, and under it a volume slider whose controls are the 44 px classes of the phone rules; Try is the effects' only", () => {
	for (const cls of ["effects", "background"]) {
		assert.match(html, new RegExp(`<div class="set-row"><span id="${cls}-label" data-m="sound_${cls}">[^<]+</span><button class="pair-btn tog" id="${cls}" type="button" aria-pressed="false" aria-labelledby="${cls}-label" data-m-title="sound_${cls}_title"></button></div>`), `${cls} switch`);
		assert.match(html, new RegExp(`<div class="set-row set-sub"><label for="${cls}-vol" id="${cls}-vol-label" data-m="sound_volume">Volume</label><span class="set-ctl"><input type="range" id="${cls}-vol" min="0" max="100" step="5"><output id="${cls}-vol-out" for="${cls}-vol"></output>`), `${cls} volume`);
	}
	assert.ok(html.includes('id="effects-try"') && !html.includes('id="background-try"'));
	assert.doesNotMatch(html, /id="sound(-vol|-try|-label)?"/, "the single Sound row is gone");
	const css = readFileSync(join(root, "gui/style.css"), "utf8");
	assert.match(css, /\.set-ctl input\[type="range"\] \{ min-height: 44px; \}/);
	assert.match(css, /:is\(\.pair-btn, [^)]*\) \{ min-height: 44px; \}/);
});

test("the words exist in both languages and the page's static text knows them; the single Sound words are gone", () => {
	const read = (f: string) => JSON.parse(readFileSync(join(root, `gui/messages/${f}.json`), "utf8")) as Record<string, string>;
	const keys = ["sound_effects", "sound_background", "sound_effects_title", "sound_background_title", "pal_effects_louder", "pal_effects_quieter", "pal_background_louder", "pal_background_quieter", "zen_music_muted", "sound_volume"];
	for (const f of ["en", "zh-TW"]) {
		const words = read(f);
		for (const k of keys) assert.ok(words[k], `${f} has ${k}`);
		for (const k of ["sound", "sound_title", "pal_louder", "pal_quieter"]) assert.equal(k in words, false, `${f} no longer has ${k}`);
	}
	const [en, zh] = [read("en"), read("zh-TW")];
	assert.deepEqual([zh.sound_effects, zh.sound_background], ["音效", "背景音"]);
	assert.deepEqual([en.sound_effects, en.sound_background], ["Sound effects", "Background sound"]);
	const i18n = readFileSync(join(root, "gui/i18n.ts"), "utf8");
	for (const k of ["sound_effects", "sound_background", "sound_effects_title", "sound_background_title", "sound_volume", "sound_try"]) assert.ok(i18n.includes(`${k}: m.${k}`), `i18n.ts lists ${k}`);
	for (const [, k] of html.matchAll(/data-m(?:-title)?="(sound_[a-z_]+)"/g)) assert.ok(i18n.includes(`${k}: m.${k}`), `index.html uses ${k}`);
});

test("Zen's corner menu rows and the theme CSS: the new rows are the menu's 44 px classes, the menu scrolls on a short screen, and the palette starts its sound group at the effects", () => {
	const zen = readFileSync(join(root, "gui/zen.css"), "utf8");
	assert.match(zen, /\.zen-row \{[^}]*min-height: 44px/);
	assert.match(zen, /\.zen-opt, \[data-view="zen"\] \.zen-leave \{ min-width: 44px; min-height: 44px;/);
	assert.match(zen, /\.zen-menu input\[type="range"\] \{[^}]*min-height: 44px/);
	assert.match(zen, /\.zen-menu \{[^}]*max-height: calc\(100dvh - 72px\); overflow-y: auto;/);
	assert.match(zen, /\[data-id="effects"\], \[data-id="music"\]:not\(\[data-id="background-quieter"\] \+ \*\)/);
	assert.match(zen, /\.zen-music-btn:is\(\[data-state="off"\], \[data-state="muted"\]\)/);
});
