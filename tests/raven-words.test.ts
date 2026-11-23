import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { m as base } from "../gui/paraglide/messages.js";
import { getLocale, overwriteGetLocale } from "../gui/paraglide/runtime.js";
import { NOUN_KEYS, noun, usePack } from "../gui/nouns.ts";
import { m } from "../gui/sentences.ts";
import { useSentences, type SentenceId } from "../gui/sentencepack.ts";
import { NOUNS } from "../gui/themes/raven/nouns.ts";
import { SENTENCES } from "../gui/themes/raven/sentences.ts";

// Raven Keep says the tower as the steward (管家) and the head tower as the keep (鴉閣) in every Traditional Chinese sentence, not only in the role words (docs/specs/2026-11-07-raven-view/spec.md §1.5, boss 2026-11-08).
// The sentences come with the theme's chunk (gui/themes/raven/sentences.ts), through the page's one `m` (gui/sentences.ts).

overwriteGetLocale(() => "zh-TW");
const root = fileURLToPath(new URL("..", import.meta.url));
const zh = JSON.parse(readFileSync(join(root, "gui/messages/zh-TW.json"), "utf8")) as Record<SentenceId, string>;
const ids = Object.keys(zh).filter((id) => !id.startsWith("$")) as SentenceId[]; // the file's "$schema" is not a message
const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!).sort();
/** Every input of a message as a marker word, so a sentence is rendered whole. */
const render = (id: SentenceId): string => {
	if ((NOUN_KEYS as readonly string[]).includes(id)) return noun(id as (typeof NOUN_KEYS)[number]); // a role word is read through the noun chokepoint, never as a message (the test below)
	return (m[id] as (inputs: Record<string, string>) => string)(Object.fromEntries(holes(zh[id]).map((h) => [h, `‹${h}›`])));
};
const raven = () => (usePack(NOUNS), useSentences(SENTENCES, getLocale));
const standard = () => (usePack(undefined), useSentences(undefined, getLocale));

/** Messages that say 塔台 and never show in Raven, with why. Nothing else may. */
const ZEN_ONLY = "the Zen view's own head strip (gui/zenhead.ts, mounted only in Zen)";
const NEVER: Record<string, string> = {
	zen_head_label: ZEN_ONLY, zen_head_hint: ZEN_ONLY, zen_head_hint_click: ZEN_ONLY, zen_head_placeholder: ZEN_ONLY, zen_head_working: ZEN_ONLY, zen_head_refused: ZEN_ONLY, zen_head_off: ZEN_ONLY, zen_head_sent: ZEN_ONLY, zen_run_who: ZEN_ONLY, zen_no_tower_yet: ZEN_ONLY, zen_target_placeholder: ZEN_ONLY,
	palette_head_talk: "Zen's command palette (gui/paletteentries.ts, opened only in Zen)", palette_head_history: "Zen's command palette", palette_head_page: "Zen's command palette",
};

test("in Raven Traditional Chinese no message says 塔台, except the ones that never show in Raven", () => {
	raven();
	const offenders = ids.filter((id) => render(id).includes("塔台") && !(id in NEVER));
	assert.deepEqual(offenders, [], "these still say 塔台 in Raven");
});

/** Messages that say 智慧體 and show in Raven anyway, with why. Nothing else may (boss 2026-11-08: a main is a 血僕, agents in general are 眷屬). */
const AGENT_OK: Record<string, string> = {};

test("in Raven Traditional Chinese no message says 智慧體, except the ones allow-listed with a reason", () => {
	raven();
	const offenders = ids.filter((id) => render(id).includes("智慧體") && !(id in AGENT_OK));
	assert.deepEqual(offenders, [], "these still say 智慧體 in Raven");
	for (const id of Object.keys(AGENT_OK)) assert.ok(AGENT_OK[id]!.length > 10, `${id} names why`);
});

test("Raven's agent words: a main is a 血僕, agents in general are 眷屬", () => {
	raven();
	assert.equal(m.open_main(), "＋血僕");
	assert.equal(m.stat_agents(), "眷屬");
	assert.equal(m.link_mains({ count: "3" }), "血僕（3）");
	standard();
	assert.equal(m.open_main(), "＋主智慧體");
	assert.equal(m.stat_agents(), "智慧體");
});

test("the allow-list lists real messages that say 塔台 in the base, and nothing a Raven sentence could cover is parked on it", () => {
	for (const id of Object.keys(NEVER)) assert.ok(zh[id as SentenceId]?.includes("塔台"), `${id} is a message that says 塔台`);
	for (const id of Object.keys(NEVER)) assert.ok(!(id in (SENTENCES["zh-TW"] ?? {})), `${id} is allowed, so it has no Raven sentence`);
	for (const id of Object.keys(NEVER)) assert.match(NEVER[id]!, /Zen/, `${id} names why`);
});

test("a Raven sentence answers a message of the base with the same inputs, and only where the base said 塔台 or 智慧體", () => {
	raven();
	const pack = SENTENCES["zh-TW"] ?? {};
	assert.ok(Object.keys(pack).length >= 80, "the pack covers the sentences");
	assert.deepEqual(Object.keys(SENTENCES), ["zh-TW"], "English keeps the base messages: the pack has no en entry");
	for (const [id, text] of Object.entries(pack)) {
		assert.ok(id in zh, `${id} is a message`);
		assert.ok(/塔台|智慧體/.test(zh[id as SentenceId]), `${id} said 塔台 or 智慧體 in the base`);
		assert.deepEqual(holes(text), holes(zh[id as SentenceId]), `${id} keeps the inputs`);
		assert.ok(text.length > 0 && !/\{\w*[^\w}]/.test(text), `${id} is a plain sentence`);
	}
});

test("every message a pack names is a `say` module in the page's `m`, and the rest are Paraglide's own", () => {
	const named = Object.values(SENTENCES).flatMap((pack) => Object.keys(pack!));
	const said = (id: string) => readFileSync(join(root, "gui/paraglide/said", `${id}.js`), "utf8");
	for (const id of named) assert.match(said(id), /\bsay\(/, `${id} calls say`);
	const plain = ids.filter((id) => !named.includes(id));
	assert.ok(plain.length > 900, "the other messages stay many");
	assert.deepEqual(plain.filter((id) => !said(id).includes(`export { ${id} } from "../messages/${id}.js"`)), [], "and are re-exported as they are");
});

test("Raven English and every message a pack does not name stay the base's, byte for byte", () => {
	raven();
	const pack = SENTENCES["zh-TW"] ?? {};
	for (const id of ids) {
		const inputs = Object.fromEntries(holes(zh[id]).map((h) => [h, `‹${h}›`]));
		const say = (name: string, options?: { locale: "en" | "zh-TW" }) => (base as unknown as Record<string, (i: object, o?: object) => string>)[name]!(inputs, options);
		const through = (m as unknown as Record<string, (i: object, o?: object) => string>)[id]!;
		assert.equal(through(inputs, { locale: "en" }), say(id, { locale: "en" }), `${id} in English`);
		if (!(id in pack)) assert.equal(through(inputs), say(id), `${id} is untouched`);
	}
});

test("the words the boss named: the map card says 管家 and a base with no tower says 自主活動; the head tower is 鴉閣 in a sentence and the steward is 管家", () => {
	raven();
	assert.equal(m.control_tower({ state: "忙碌" }), "管家 · 忙碌");
	assert.equal(m.no_tower(), "自主活動");
	assert.equal(noun("role_tower"), "管家");
	assert.equal(noun("head_tower"), "鴉閣");
	assert.equal(m.head_wakes(), "叫醒鴉閣");
	assert.equal(m.head_close(), "關閉鴉閣");
	assert.equal(m.head_close_ask(), "要關閉鴉閣嗎？對話和記憶都會保留。");
	assert.equal(m.tower_name({ label: "A" }), "A 管家");
});

test("a wait card names the tower it is about (Q3): a head card says 主塔台 in Standard and 鴉閣 in Raven, a workspace's says 塔台 and 管家, and no Raven wait word says 塔台", () => {
	const TWINS = ["wc_tag_legacy", "wc_raised_self", "wc_p_words", "wc_b_restate", "wc_b_reply", "wc_skip_tells", "wc_skip_tells_tower", "wc_pressed_restate", "wc_told_both", "wc_told_tower", "wc_told_gone", "wc_told_failed", "wc_ended", "wc_ended_plain", "zen_wait_placeholder", "wait_sent"] as const;
	for (const id of TWINS) assert.ok(`${id}_head` in zh, `${id} has its head twin`);
	assert.equal(zh["wc_b_reply_head" as SentenceId], "回覆主塔台");
	standard();
	for (const id of TWINS) {
		assert.ok(render(`${id}_head` as SentenceId).includes("主塔台"), `${id}_head says 主塔台 in Standard`);
		assert.ok(!render(id as SentenceId).includes("主塔台"), `${id} (a workspace's tower) never says the head`);
		assert.ok(render(id as SentenceId).includes("塔台"), `${id} says 塔台`);
		assert.deepEqual(holes(zh[`${id}_head` as SentenceId]), holes(zh[id as SentenceId]), `${id}_head takes the inputs its base takes`);
	}
	raven();
	for (const id of TWINS) {
		assert.ok(render(`${id}_head` as SentenceId).includes("鴉閣"), `${id}_head says 鴉閣 in Raven`);
		assert.ok(render(id as SentenceId).includes("管家"), `${id} says 管家 in Raven`);
		for (const name of [id, `${id}_head`]) assert.ok(!render(name as SentenceId).includes("塔台"), `${name} says no 塔台 in Raven`);
	}
	assert.equal(m.wc_b_reply_head(), "回覆鴉閣");
	assert.equal(m.wc_ended_head({ outcome: "‹outcome›" }), "鴉閣已確認：‹outcome›");
	standard();
	assert.equal(m.wc_b_reply_head(), "回覆主塔台");
	assert.equal(m.wc_b_reply(), "回覆塔台");
});

test("Standard to Raven to Standard: the sentences swap both ways, and Standard's words come back whole", () => {
	standard();
	const before = ids.map((id) => [id, render(id)] as const);
	assert.equal(m.control_tower({ state: "忙碌" }), "塔台 · 忙碌");
	assert.equal(m.no_tower(), "尚無塔台");
	raven();
	assert.equal(m.control_tower({ state: "忙碌" }), "管家 · 忙碌");
	assert.equal(m.no_tower(), "自主活動");
	assert.equal(noun("role_tower"), "管家");
	standard();
	assert.equal(m.control_tower({ state: "忙碌" }), "塔台 · 忙碌");
	assert.equal(m.no_tower(), "尚無塔台");
	assert.equal(noun("role_tower"), "塔台");
	assert.deepEqual(ids.map((id) => [id, render(id)] as const), before, "every message reads as before the visit");
	assert.ok(before.filter(([, text]) => text.includes("塔台")).length >= 90, "Standard keeps saying 塔台");
});

test("the page swaps its sentences with the theme: the registry takes them before it retranslates, and the entry carries no theme string", () => {
	const registry = readFileSync(join(root, "gui/themes/registry.ts"), "utf8");
	assert.ok(registry.indexOf("useSentences(parts?.sentences, getLocale)") > 0 && registry.indexOf("useSentences(parts?.sentences, getLocale)") < registry.indexOf("retranslate()"), "sentences first, then the static text is translated");
	assert.match(readFileSync(join(root, "gui/themes/raven/index.ts"), "utf8"), /\bsentences: SENTENCES\b/);
	const entry = readFileSync(join(root, "gui/sentences.ts"), "utf8");
	assert.ok(!entry.includes("管家") && !/from "\.\/themes/.test(entry), "the chokepoint holds no theme's words");
});

test("every page file reads its messages through the sentence chokepoint, so a theme's pack can reach them (the pack module itself reads only the type of the ids)", () => {
	const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (dir === "gui" && e.name === "paraglide" ? [] : walk(`${dir}/${e.name}`)) : e.name.endsWith(".ts") ? [`${dir}/${e.name}`] : []);
	const files = walk("gui");
	assert.ok(files.some((f) => f.startsWith("gui/themes/")), "the scan reaches the theme folders");
	const offenders = files.filter((f) => f !== "gui/sentences.ts" && f !== "gui/sentencepack.ts").filter((f) => /paraglide\/messages\.js/.test(readFileSync(join(root, f), "utf8")));
	assert.deepEqual(offenders, [], "import { m } from the sentences chokepoint instead");
});

test("gui-sentences removes a said/ module whose message is gone", () => {
	const out = mkdtempSync(join(tmpdir(), "said-"));
	try {
		mkdirSync(join(out, "messages"));
		copyFileSync(join(root, "gui/paraglide/messages/_index.js"), join(out, "messages/_index.js"));
		mkdirSync(join(out, "said"));
		for (const f of ["gone_message.js", "gone_message.d.ts"]) writeFileSync(join(out, "said", f), "");
		execFileSync(process.execPath, [join(root, "scripts/gui-sentences.mjs"), out]);
		const left = readdirSync(join(out, "said"));
		assert.ok(!left.includes("gone_message.js") && !left.includes("gone_message.d.ts"), "stale modules are removed");
		assert.ok(left.includes("_index.js") && left.length > 100, "the current ones are written");
	} finally { rmSync(out, { recursive: true, force: true }); }
});
