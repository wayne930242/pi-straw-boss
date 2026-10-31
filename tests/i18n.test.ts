import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { match, pageKeys, pick } from "../gui/i18n.ts";
import { m } from "../gui/paraglide/messages.js";

const dir = fileURLToPath(new URL("../gui/messages/", import.meta.url));
const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
/** A message's placeholders, from a plain string or every variant of a complex one. */
const holes = (message: unknown) => new Set([...JSON.stringify(message).matchAll(/(?<!\\)\{(\w+)\}/g)].map((x) => x[1]));

test("every locale has every message of the English base and no other, with the same placeholders", () => {
	const base = read("en.json");
	const files = readdirSync(dir).filter((file) => file.endsWith(".json") && file !== "en.json");
	assert.ok(files.length >= 1, "a translation besides English");
	for (const file of files) {
		const other = read(file);
		assert.deepEqual(Object.keys(other).sort(), Object.keys(base).sort(), `${file} has the base's keys`);
		for (const key of Object.keys(base)) assert.deepEqual(holes(other[key]), holes(base[key]), `${file} ${key} keeps the placeholders`);
	}
});

test("every data-m, data-m-label, data-m-title, and data-m-empty in the page names a message the page maps", () => {
	const html = readFileSync(fileURLToPath(new URL("../gui/index.html", import.meta.url)), "utf8");
	const used = [...html.matchAll(/data-m(?:-label|-title|-empty)?="([^"]+)"/g)].map((x) => x[1]);
	assert.ok(used.length > 20);
	assert.deepEqual(used.filter((key) => !pageKeys.includes(key!)), []);
});

test("the language: the stored choice first, then the browser's first language the page has, a Chinese tag by script or region, else English", () => {
	assert.equal(pick("zh-TW", ["en-US"]), "zh-TW", "the menu's choice wins");
	assert.equal(pick("klingon", ["zh-TW"]), "zh-TW", "a stored value that is no locale is ignored");
	assert.equal(pick(null, ["fr-FR", "zh-HK", "en"]), "zh-TW", "the first language the page has, in the browser's order");
	assert.equal(pick(null, ["en-GB", "zh-TW"]), "en");
	assert.equal(pick(null, ["fr", "de"]), "en", "none it has: English");
	for (const tag of ["zh-TW", "zh-tw", "zh-Hant", "zh-Hant-TW", "zh-HK", "zh-MO"]) assert.equal(match(tag), "zh-TW", tag);
	for (const tag of ["zh-CN", "zh-Hans", "zh-SG", "zh"]) assert.equal(match(tag), undefined, `${tag}: no Simplified Chinese yet`);
});

test("outside a browser the messages read English, with Chinese on request", () => {
	assert.equal(m.unit_count({ count: 1 }), "1 unit");
	assert.equal(m.unit_count({ count: 3 }), "3 units");
	assert.equal(m.unit_count({ count: 3 }, { locale: "zh-TW" }), "3 個單位");
	assert.equal(m.locale_name({}, { locale: "zh-TW" }), "正體中文");
});

test("the Wi-Fi access warning says the limit is not verified in both languages, with no expiry placeholder left over", () => {
	for (const file of ["en.json", "zh-TW.json"]) {
		const messages = read(file);
		assert.match(String(messages.lan_unverified), file === "en.json" ? /Not verified yet.*any website/ : /尚未驗證.*任何網站/, file);
		assert.match(String(messages.lan_risk_short), file === "en.json" ? /not been verified.*any website/ : /沒有驗證過.*任何網站/, file);
		for (const key of ["lan_risk", "lan_risk_noname"]) assert.ok(!String(messages[key]).includes("{expiry_note}"), `${file} ${key}`);
	}
	assert.match(m.lan_unverified({}, { locale: "zh-TW" }), /尚未驗證/);
});
