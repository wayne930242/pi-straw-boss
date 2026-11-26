import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrefs, KEYS, type Name } from "../gui/prefs.ts";

const store = () => {
	const map = new Map<string, string>();
	return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
};
const refusing = { getItem: () => { throw new Error("refused"); }, setItem: () => { throw new Error("refused"); } };

// name, default, a value to set, what it is stored as
const TABLE: [Name, unknown, unknown, string][] = [
	["view", "auto", "raven", "raven"],
	["zen", false, true, "1"],
	["locale", null, "zh-TW", "zh-TW"],
	["effects", false, true, "1"],
	["effectsVolume", 60, 35, "35"],
	["background", false, true, "1"],
	["backgroundVolume", 60, 35, "35"],
	["remind", true, false, "0"],
	["wide", false, true, "1"],
	["zenHint", false, true, "1"],
	["zenMusic", false, true, "1"],
	["zenTrack", null, "zen-rain.mp3", "zen-rain.mp3"],
];

test("every key has its own storage key (the old single Sound and Volume are the legacy of the two classes, sound-split.test.ts)", () => {
	assert.deepEqual(Object.values(KEYS), ["sb.view", "sb.zen", "sb-locale", "sb.effects", "sb.effects.volume", "sb.background", "sb.background.volume", "sb.remind", "sb.dialog-wide", "sb.zen.homehint", "sb.zen.music", "sb.zen.track"]);
	assert.deepEqual(TABLE.map((r) => r[0]), Object.keys(KEYS));
});

test("each key: its default, set then get, and the stored string", () => {
	for (const [name, dflt, value, stored] of TABLE) {
		const s = store(), p = createPrefs(s);
		assert.deepEqual(p.get(name), dflt, `${name} default`);
		assert.equal(p.set(name, value as never), true);
		assert.equal(s.map.get(KEYS[name]), stored, `${name} stored`);
		assert.deepEqual(p.get(name), value, `${name} read back`);
	}
});

test("each key: a refused storage reads as the default (Zen's hint as told) and a refused write says so", () => {
	for (const [name, dflt, value] of TABLE) {
		const p = createPrefs(refusing);
		assert.deepEqual(p.get(name), name === "zenHint" ? true : dflt, `${name} refused`);
		assert.equal(p.set(name, value as never), false);
	}
});

test("the volume is read within 0 to 100, and a damaged one is 0", () => {
	const s = store(), p = createPrefs(s);
	for (const name of ["effectsVolume", "backgroundVolume"] as const) for (const [raw, volume] of [["250", 100], ["-5", 0], ["x", 0], ["42", 42]] as const) (s.map.set(KEYS[name], raw), assert.equal(p.get(name), volume));
});

test("each key: another tab's storage event reaches that key's listener alone", () => {
	const g = globalThis as Record<string, unknown>, saved = g.addEventListener, heard: ((e: { key: string | null }) => void)[] = [];
	g.addEventListener = (type: string, fn: (e: { key: string | null }) => void) => void (type === "storage" && heard.push(fn));
	try {
		const p = createPrefs(store()), told: string[] = [];
		for (const name of Object.keys(KEYS) as Name[]) p.on(name, () => told.push(name));
		assert.equal(heard.length, 1, "one listener on the page");
		for (const name of Object.keys(KEYS) as Name[]) (told.length = 0, heard[0]!({ key: KEYS[name] }), assert.deepEqual(told, [name]));
		told.length = 0;
		heard[0]!({ key: "sb.other" });
		heard[0]!({ key: null }); // storage.clear() names no key
		assert.deepEqual(told, []);
	} finally {
		if (saved === undefined) delete g.addEventListener;
		else g.addEventListener = saved;
	}
});
