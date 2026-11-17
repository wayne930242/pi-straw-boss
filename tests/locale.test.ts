import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { envLocale, localeCommand, localeOf, localeSetting, writeLocale } from "../src/locale.ts";
import { localeOf as promptLocale } from "../src/towerprompt/messages.ts";
import { headLabel } from "../src/server/head.ts";

// sb's one language (src/locale.ts): `locale` in the state folder's config.json, else the environment, else the system's.

const dir = () => mkdtempSync(join(tmpdir(), "sb-locale-"));
const config = (d: string) => JSON.parse(readFileSync(join(d, "config.json"), "utf8")) as Record<string, unknown>;

test("the environment: zh-TW, zh-HK, zh-MO or a Traditional script is Traditional Chinese; every other language, Simplified Chinese included, is English; LC_ALL wins", () => {
	assert.equal(envLocale({ LANG: "zh_TW.UTF-8" }), "zh-TW");
	assert.equal(envLocale({ LC_ALL: "zh_HK.UTF-8", LANG: "en_US.UTF-8" }), "zh-TW");
	assert.equal(envLocale({ LC_MESSAGES: "zh-Hant-TW" }), "zh-TW");
	assert.equal(envLocale({ LANG: "en_US.UTF-8" }), "en");
	assert.equal(envLocale({ LANG: "zh_CN.UTF-8" }), "en");
	assert.equal(envLocale({ LC_ALL: "C", LANG: "zh_TW.UTF-8" }), "en");
	assert.ok(["en", "zh-TW"].includes(envLocale({})), "without a variable the system's language");
});

test("`locale` in config.json overrides the environment for every reader; an absent, unknown or unreadable setting leaves it to the environment", () => {
	const d = dir();
	assert.equal(localeOf({ LANG: "en_US.UTF-8" }, d), "en", "no config.json");
	writeFileSync(join(d, "config.json"), JSON.stringify({ towerModel: "m", locale: "zh-TW" }));
	assert.equal(localeSetting(d), "zh-TW");
	assert.equal(localeOf({ LANG: "en_US.UTF-8" }, d), "zh-TW");
	assert.equal(promptLocale({ LANG: "en_US.UTF-8" }, d), "zh-TW", "the tower prompt reads the same");
	assert.equal(headLabel({ LANG: "en_US.UTF-8" }, d), "主塔台", "and the head's label");
	writeFileSync(join(d, "config.json"), `\uFEFF${JSON.stringify({ locale: "en" })}`);
	assert.equal(localeOf({ LANG: "zh_TW.UTF-8" }, d), "en", "a BOM is ignored; en beats a zh-TW shell");
	writeFileSync(join(d, "config.json"), JSON.stringify({ locale: "zh-CN" }));
	assert.equal(localeOf({ LANG: "zh_TW.UTF-8" }, d), "zh-TW", "a value this build does not know is no setting");
	writeFileSync(join(d, "config.json"), "{ not json");
	assert.equal(localeOf({ LANG: "en_US.UTF-8" }, d), "en");
	assert.equal(localeOf({ LANG: "zh_TW.UTF-8" }), "zh-TW", "no state folder: the environment");
});

test("writeLocale keeps every other key, `auto` removes the setting, and a config.json that cannot be parsed is refused and left as it is", () => {
	const d = dir();
	assert.equal(writeLocale(d, "zh-TW"), "zh-TW");
	assert.deepEqual(config(d), { locale: "zh-TW" }, "made when missing");
	writeFileSync(join(d, "config.json"), JSON.stringify({ towerModel: "m", towerRuns: { max: 2 }, locale: "en" }));
	writeLocale(d, "zh-TW");
	assert.deepEqual(config(d), { towerModel: "m", towerRuns: { max: 2 }, locale: "zh-TW" });
	assert.match(readFileSync(join(d, "config.json"), "utf8"), /^\{\n {2}"towerModel"/, "2-space JSON");
	assert.equal(writeLocale(d, "auto"), undefined);
	assert.deepEqual(config(d), { towerModel: "m", towerRuns: { max: 2 } });
	writeFileSync(join(d, "config.json"), "{ broken");
	assert.throws(() => writeLocale(d, "en"), /cannot be parsed/);
	assert.equal(readFileSync(join(d, "config.json"), "utf8"), "{ broken");
	writeFileSync(join(d, "config.json"), "[1]");
	assert.throws(() => writeLocale(d, "en"), /no JSON object/);
});

test("/boss locale shows the language and its source, sets zh-TW, en or auto, and answers anything else with its usage", () => {
	const d = dir(), shell = { LANG: "en_US.UTF-8" };
	assert.match(localeCommand("", shell, d).text, /English \(en\), from the environment/);
	const set = localeCommand("zh-tw", shell, d);
	assert.equal(set.warn, undefined);
	assert.match(set.text, /^sb 的語言改為繁體中文（zh-TW）：/, "said in the new language");
	assert.equal(config(d).locale, "zh-TW");
	assert.match(localeCommand("", shell, d).text, /由 config\.json 的 locale 設定/);
	assert.deepEqual(localeCommand("fr", shell, d), { text: "用法：/boss locale [zh-TW | en | auto]", warn: true });
	assert.match(localeCommand("auto", shell, d).text, /English \(en\), from the environment/);
	assert.equal(config(d).locale, undefined);
});
