import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Slot } from "../src/server/record.ts";
import { addCardWait, addWait, emptyMemory, loadMemory, type Memory, memorySection, memorySummary, memoryTool, updateMemory } from "../src/server/towermemory.ts";
import { buildNet, type MemorySummary, type TowerView } from "../src/net.ts";
import { CARD_TEXTS, cardTexts, cutCards } from "../src/waitbudget.ts";
import { checkCard, CARD, type Raiser } from "../src/server/waitcard.ts";
import { HEAD_TOOLS, headTools } from "../src/server/headbrief.ts";
import { localTools } from "../src/server/towerbrief.ts";
import { MEMORY_DESCRIPTION } from "../src/memorytool.ts";

// Wait cards, tasks 1 to 3 (docs/specs/2026-11-07-wait-cards.md): the boss wait as a card with fields, the refusals, the stored entry, and how old free-text waits read.

const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-wc-")) }) as Slot;
const NOW = Date.parse("2026-11-07T10:41:00Z");
const SENDER = "4f1c9a20-1111-4222-8333-444455556666";
const OTHER = "9b2e0000-aaaa-4bbb-8ccc-ddddeeeeffff";
const raiser: Raiser = { id: SENDER, name: "mp3946-print", role: "main", workspace: "MP Center", tab: "MP-3946" };

const FONSTAR_ZH = {
	op: "add", kind: "wait", for: "boss", type: "action", from: SENDER,
	happened: "fonstar-staging 這台機器的 Tailscale 登入金鑰約 10:30 過期，它現在離線。MP-3946 的列印功能已經部署到那台，但連不上，沒辦法測。",
	do: "到 Tailscale 管理頁重新授權 fonstar-staging，或把它的金鑰設成不會過期。",
	url: "https://login.tailscale.com/admin/machines",
	after: "機器連回來後，塔台會請 MP-3946 的 main 驗證列印功能。",
};
const FONSTAR_EN = {
	op: "add", kind: "wait", for: "boss", type: "action", from: SENDER,
	happened: "The Tailscale login key of fonstar-staging expired about 10:30, so that machine is offline. The print feature of MP-3946 is deployed there but unreachable.",
	do: "Open the Tailscale admin page and re-authorize fonstar-staging, or set its key to never expire.",
	url: "https://login.tailscale.com/admin/machines",
	after: "Once the machine is back, the tower asks the main of MP-3946 to check the print feature.",
};
const toolEnv = (slot: Slot, over: Partial<Parameters<typeof memoryTool>[0]> = {}) => ({
	slot, workspace: "wA", run: "r1", now: () => NOW, bossEvents: () => [], session: async (q: string) => ({ id: `id-${q}`, name: q }), log: { line() {}, hide() {} },
	intercomEvents: () => [{ id: "e1", from: { id: SENDER, name: "mp3946-print" } }],
	raiser: async (id: string): Promise<Raiser | undefined> => (id === SENDER ? raiser : undefined),
	locale: () => "zh-TW" as const, ...over,
});
const tool = (slot: Slot, args: Record<string, unknown>, over: Partial<Parameters<typeof memoryTool>[0]> = {}) => memoryTool(toolEnv(slot, over), args);
const live = (slot: Slot) => loadMemory(slot, "wA").memory.entries;
const refusal = async (slot: Slot, args: Record<string, unknown>, over = {}): Promise<string> => { try { await tool(slot, args, over); } catch (cause) { return (cause as Error).message; } throw new Error("expected a refusal"); };

// --- the pure checks: a table of every refusal line ----------------------------------------------------------------------------------------------------------------------

const ctx = (over: Partial<Parameters<typeof checkCard>[1]> = {}) => ({ senders: new Set([SENDER]), restates: () => undefined, ...over });
const base = { type: "action", happened: "The key expired and the machine is offline.", do: "Re-authorize the machine in the admin page.", url: "https://example.org/admin", after: "The tower asks the main to test again.", from: SENDER };
const lines = (args: Record<string, unknown>, over = {}) => {
	const got = checkCard({ ...base, ...args }, ctx(over));
	return got.ok ? [] : got.lines;
};
const without = (...names: string[]) => Object.fromEntries(Object.entries(base).filter(([k]) => !names.includes(k)));

test("a good card passes, in Chinese or English, whatever the locale: sb never judges the language", () => {
	for (const args of [FONSTAR_ZH, FONSTAR_EN]) for (const lang of ["zh-TW", "en"] as const) {
		const got = checkCard(args, ctx({ lang }));
		assert.equal(got.ok, true, JSON.stringify(got));
		if (got.ok) assert.equal(got.card.lang, lang, "lang is the locale the brief named, for display only");
	}
});

const TABLE: [string, Record<string, unknown>, RegExp][] = [
	["happened missing", { happened: undefined }, /^- happened: missing\. Say what happened in one or two plain sentences\.$/],
	["do missing", { do: "" }, /^- do: missing\. /],
	["happened over the cap", { happened: "x".repeat(161) }, /^- happened: too long: at most 160 characters$/],
	["do over the cap", { do: "y".repeat(161) }, /^- do: too long: at most 160 characters$/],
	["after over the cap", { after: "z".repeat(161) }, /^- after: too long: at most 160 characters$/],
	["do says the same as happened", { do: "The key expired and the machine is offline." }, /^- do: says the same as happened: say what the boss does$/],
	["type missing", { type: undefined }, /^- type: missing\. /],
	["type unknown", { type: "alert" }, /^- type: .*not action, choice, or secret/],
	["an action with no place to act", { url: undefined }, /^- url: missing\. .*url.*command/],
	["after missing on an action", { after: undefined }, /^- after: missing\. /],
	["javascript url", { url: "javascript:alert(1)" }, /^- url: "javascript:alert\(1\)" is not an http\(s\) address\. Give the page's https address, or a command instead\.$/],
	["ftp url", { url: "ftp://example.org/x" }, /^- url: .*is not an http\(s\) address/],
	["url with userinfo", { url: "https://u:p@example.org/" }, /^- url: .*user name or password/],
	["url that does not parse", { url: "https://" }, /^- url: .*is not an http\(s\) address/],
	["url over 300", { url: `https://example.org/${"a/".repeat(150)}` }, /^- url: too long: at most 300 characters$/],
	["command with a control character", { url: undefined, command: "echo hi\u001b[2J" }, /^- command: a command is plain text of at most 4 lines$/],
	["command of five lines", { url: undefined, command: "a\nb\nc\nd\ne" }, /^- command: a command is plain text of at most 4 lines$/],
	["command over 300", { url: undefined, command: "c".repeat(301) }, /^- command: too long: at most 300 characters$/],
	["options on an action", { options: [{ label: "A", then: "a" }, { label: "B", then: "b" }] }, /^- options: only a choice card has options$/],
	["secret on an action", { secret: { name: "a key" } }, /^- secret: only a secret card has secret$/],
	["sk key in happened", { happened: "The key is sk-abcdefghijklmnop1234 and it is bad." }, /^- happened: looks like a secret or a key\. A wait never carries one: name it in secret\.name and use type secret$/],
	["a 40-character mixed run in do", { do: "Paste aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF3hJ6 into the page." }, /^- do: looks like a secret or a key\./],
	["a key in the url", { url: "https://example.org/?k=sk-abcdefghijklmnop1234" }, /^- url: looks like a secret or a key\./],
	["a key in a command", { url: undefined, command: "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789' x" }, /^- command: looks like a secret or a key\./],
	["a key in after", { after: "token=abcdefg12345" }, /^- after: looks like a secret or a key\./],
	["from missing", { from: undefined }, /^- from: missing\. Name the session id from the \[intercom from …\] line/],
	["url of 301 characters that normalizes shorter", { url: `https://example.org:443/${"a/".repeat(138)}a` }, /^- url: too long: at most 300 characters$/],
	["from of a session that sent nothing", { from: OTHER }, new RegExp(`^- from: ${OTHER} sent you nothing in this run\\. Name the session id from the \\[intercom from …\\] line of the message that raised it, or "self" when you raised it yourself$`)],
	["text on a boss wait", { text: "do the thing" }, /^- text: a wait for the boss takes the card fields \(happened, do, …\), not text$/],
	["on on a boss wait", { on: "docs-main" }, /^- on: a wait for the boss names no session$/],
	["due out of range", { due: 3 }, /^- due: /],
	["restates that is no wait", { restates: "W7" }, /^- restates: No such wait W7 to restate$/],
];
for (const [name, patch, re] of TABLE) {
	test(`refusal: ${name}`, () => {
		const got = lines(patch);
		assert.ok(got.some((l) => re.test(l)), `${JSON.stringify(got)} should hold a line matching ${re}`);
	});
}

test("choice cards: 2 to 4 options with unique labels, a label of 24 and a then of 120, no secret; after is optional", () => {
	const choice = { ...without("url", "after"), type: "choice", options: [{ label: "Deploy now", then: "The tower deploys to ws01 at once." }, { label: "Wait", then: "The tower waits for Monday." }] };
	assert.equal(checkCard(choice, ctx()).ok, true);
	const bad = (options: unknown) => (checkCard({ ...choice, options }, ctx()) as { lines: string[] }).lines.join("\n");
	assert.match(bad(undefined), /^- options: a choice has 2 to 4 options/m);
	assert.match(bad([{ label: "A", then: "a" }]), /^- options: a choice has 2 to 4 options/m);
	assert.match(bad([1, 2, 3, 4, 5].map((n) => ({ label: `L${n}`, then: "t" }))), /^- options: a choice has 2 to 4 options/m);
	assert.match(bad([{ label: "Same", then: "a" }, { label: "Same", then: "b" }]), /^- options: .*Same.* twice/m);
	assert.match(bad([{ label: "L".repeat(25), then: "a" }, { label: "B", then: "b" }]), /^- options: option 1 label too long: at most 24 characters$/m);
	assert.match(bad([{ label: "A", then: "t".repeat(121) }, { label: "B", then: "b" }]), /^- options: option 1 then too long: at most 120 characters$/m);
	assert.match(bad([{ label: "A" }, { label: "B", then: "b" }]), /^- options: option 1 needs a label and a then$/m);
	assert.match((checkCard({ ...choice, secret: { name: "x" } }, ctx()) as { lines: string[] }).lines.join("\n"), /^- secret: only a secret card has secret$/m);
});

test("secret cards: secret.name is required and capped, after is required, self is refused", () => {
	const secret = { ...without("url"), type: "secret", secret: { name: "the Tailscale auth key for fonstar-staging" } };
	assert.equal(checkCard(secret, ctx()).ok, true, "url is optional on a secret");
	const text = (patch: Record<string, unknown>) => ((checkCard({ ...secret, ...patch }, ctx()) as { lines: string[] }).lines ?? []).join("\n");
	assert.match(text({ secret: undefined }), /^- secret: missing\. /m);
	assert.match(text({ secret: { name: "n".repeat(CARD.name + 1) } }), /^- secret: name too long: at most 60 characters$/m);
	assert.match(text({ secret: { name: "sk-abcdefghijklmnop1234" } }), /^- secret: looks like a secret or a key\./m);
	assert.match(text({ after: undefined }), /^- after: missing\./m);
	assert.match(text({ from: "self" }), /^- from: .*self.*secret_drop/m);
});

test("restates carries from; every failing field is listed in one refusal with the count", async () => {
	const carried = checkCard({ ...without("from"), restates: "W3" }, ctx({ restates: (id) => (id === "W3" ? { from: raiser } : undefined) }));
	assert.equal(carried.ok, true, JSON.stringify(carried));
	if (carried.ok) assert.deepEqual([carried.restates, carried.from], ["W3", { carried: raiser }]);
	const legacy = checkCard({ ...without("from"), restates: "W4" }, ctx({ restates: () => ({}) }));
	assert.ok(!legacy.ok && legacy.lines.some((l) => /^- from: missing\. The wait you restate has no raiser to carry/.test(l)), "a wait with no raiser to carry needs a from");
	const slot = slotIn();
	const message = await refusal(slot, { op: "add", kind: "wait", for: "boss", type: "action", from: "javascript:x", url: "javascript:alert(1)", text: "old style" });
	assert.match(message, /^Not recorded: a wait for the boss is a card they act on, and 6 fields need a fix \(nothing was kept; call tower_memory again with every field\)\.\n- /);
	for (const field of ["happened", "do", "url", "text", "from"]) assert.match(message, new RegExp(`^- ${field}: `, "m"));
	assert.deepEqual(live(slot), [], "nothing was kept");
	const one = await refusal(slot, { ...FONSTAR_ZH, happened: undefined });
	assert.match(one, /and 1 field needs a fix/);
});

// --- the tool: stored entry, from against the run's events, restates ------------------------------------------------------------------------------------------------------

test("the fonstar card is stored with text = do, the card, lang, and the raiser the net named; the brief row and read show it", async () => {
	const slot = slotIn();
	const got = await tool(slot, FONSTAR_ZH);
	assert.match(got.text, /Noted \[W1\]/);
	const [w] = live(slot);
	assert.equal(w!.text, FONSTAR_ZH.do, "text is do, so every reader of text keeps working");
	assert.deepEqual(w!.card, { type: "action", lang: "zh-TW", happened: FONSTAR_ZH.happened, do: FONSTAR_ZH.do, url: FONSTAR_ZH.url, after: FONSTAR_ZH.after, from: raiser });
	const section = memorySection(loadMemory(slot, "wA").memory, NOW).text;
	assert.match(section, /^- \[W1\] for boss \(action, from mp3946-print\): 到 Tailscale 管理頁重新授權/m);
	for (const line of section.split("\n")) assert.ok(line.length <= 360, `${line.length}`);
	assert.match((await tool(slot, { op: "read" })).text, /\[W1\] for boss \(action, from mp3946-print\)/);
});

test("an English card under the zh-TW locale and a Chinese card under en are both accepted; lang is the brief's locale", async () => {
	const slot = slotIn();
	await tool(slot, FONSTAR_EN, { locale: () => "zh-TW" });
	await tool(slot, FONSTAR_ZH, { locale: () => "en" });
	assert.deepEqual(live(slot).map((e) => e.card?.lang), ["zh-TW", "en"]);
});

test("self stores no raiser; a raiser that left the net is stored gone with the event's name; a session id the run was not sent is refused", async () => {
	const slot = slotIn();
	await tool(slot, { ...FONSTAR_ZH, from: "self" });
	assert.equal(live(slot)[0]!.card!.from, undefined);
	await tool(slot, FONSTAR_ZH, { raiser: async () => undefined });
	assert.deepEqual(live(slot)[1]!.card!.from, { id: SENDER, name: "mp3946-print", role: "session", gone: true });
	assert.match(await refusal(slot, { ...FONSTAR_ZH, from: OTHER }), /sent you nothing in this run/);
	assert.match(await refusal(slot, { ...FONSTAR_ZH, from: OTHER }, { intercomEvents: () => [{ id: "e9", from: { id: OTHER } }, { id: "e1", from: { id: SENDER } }] }).catch(() => "accepted"), /accepted/, "an event of this run makes the id good");
});

test("restates drops the old wait (legacy or card) in the same write and carries its from", async () => {
	const slot = slotIn();
	updateMemory(slot, "wA", NOW, (m) => addWait(m, NOW, "r0", { text: "Re-auth fonstar-staging (old text)", for: "boss" }));
	await tool(slot, { ...FONSTAR_ZH, from: undefined, restates: "W1" }).catch((e) => assert.match(e.message, /from: missing/));
	assert.equal(live(slot).length, 1, "a legacy wait has no from to carry: from is still needed");
	await tool(slot, { ...FONSTAR_ZH, restates: "W1" });
	assert.deepEqual(live(slot).map((e) => [e.id, e.card?.type]), [["W2", "action"]], "the old one went in the same write");
	await tool(slot, { ...FONSTAR_ZH, from: undefined, restates: "W2", url: "https://example.org/other" });
	assert.deepEqual(live(slot).map((e) => [e.id, e.card?.from?.id]), [["W3", SENDER]], "the card's from is carried");
	assert.match(await refusal(slot, { ...FONSTAR_ZH, restates: "W99" }), /No such wait W99 to restate/);
	assert.equal(live(slot).length, 1);
});

test("a wait for an agent keeps text, on, and due; the cap of 12 open waits is unchanged", async () => {
	const slot = slotIn();
	await tool(slot, { op: "add", kind: "wait", for: "agent", text: "docs to answer", on: "docs-main", due: 30 });
	assert.equal(live(slot)[0]!.card, undefined);
	for (let n = 0; n < 11; n++) await tool(slot, FONSTAR_ZH);
	await assert.rejects(tool(slot, FONSTAR_ZH), /12 open waits/);
});

// --- reading the file -----------------------------------------------------------------------------------------------------------------------------------------------

const fileOf = (slot: Slot) => join(slot.dir, "tower", "wA", "memory.json");
const entry = (id: string, extra: Record<string, unknown>) => ({ id, kind: "wait", text: "Boss token needed", by: "run", via: "run", at: "2026-11-07T09:00:00Z", run: "r1", for: "boss", state: "open", ...extra });
const writeFile = (slot: Slot, entries: unknown[]) => {
	mkdirSync(join(slot.dir, "tower", "wA"), { recursive: true });
	writeFileSync(fileOf(slot), JSON.stringify({ v: 1, rev: 4, next: { S: 1, D: 1, W: 9, P: 1 }, entries, proposals: [] }));
};

test("a file with a legacy wait and one with a bad card both read, nothing is written, and the legacy brief row says to restate it", () => {
	const slot = slotIn();
	writeFile(slot, [entry("W1", {}), entry("W2", { card: { type: "action", happened: 5 } }), entry("W3", { card: { type: "teleport" } })]);
	const before = readFileSync(fileOf(slot), "utf8");
	const { memory, problem } = loadMemory(slot, "wA");
	assert.equal(problem, undefined);
	assert.deepEqual(memory.entries.map((e) => [e.id, e.card]), [["W1", undefined], ["W2", undefined], ["W3", undefined]], "a card that fails its check reads as legacy");
	assert.equal(readFileSync(fileOf(slot), "utf8"), before, "reading wrote nothing");
	const section = memorySection(memory, NOW).text;
	assert.match(section, /\[W1\] for boss: Boss token needed.*\(old free-text wait: record it again as a card with restates: "W1"\)/);
});

test("the brief row after a press reads what the boss did", () => {
	const slot = slotIn();
	const card = { type: "action", lang: "zh-TW", happened: "h", do: "到管理頁重新授權", after: "塔台會請 main 驗證", url: "https://example.org/", from: raiser };
	writeFile(slot, [entry("W1", { text: card.do, card, state: "answered", answered: "2026-11-07T09:58:00Z", press: { act: "done", at: "2026-11-07T09:58:00Z" } })]);
	const text = memorySection(loadMemory(slot, "wA").memory, NOW).text;
	assert.match(text, /\[W1\] .*pressed .+ at \d\d:\d\d; check: 塔台會請 main 驗證/);
});

// --- the brief names the locale; the tool says so ------------------------------------------------------------------------------------------------------------------------

test("the brief's tower_memory line ends with the locale sentence, in both briefs, and the tools block stays inside 900 characters", () => {
	const zh = localTools("zh-TW"), en = localTools("en");
	assert.match(zh.find((l) => l.startsWith("- tower_memory"))!, /Write a wait for the boss in Traditional Chinese \(sb's locale is zh-TW\)\.$/);
	assert.match(en.find((l) => l.startsWith("- tower_memory"))!, /Write a wait for the boss in English \(sb's locale is en\)\.$/);
	assert.match(headTools("zh-TW").find((l) => l.startsWith("- tower_memory"))!, /in Traditional Chinese \(sb's locale is zh-TW\)\.$/);
	for (const tools of [zh, en]) assert.ok(["Tools:", ...tools, "Call tower_done with a handoff note when nothing is left for you."].join("\n").length <= 900, "the tools block cap");
	assert.ok(HEAD_TOOLS.length > 0);
	assert.match(MEMORY_DESCRIPTION, /language your brief names/);
	assert.match(MEMORY_DESCRIPTION, /happened/);
});

// --- the snapshot: bossWaits carry the card and the press, the raiser's unit key, and a budget across towers -----------------------------------------------------------------------

const memWith = (n: number, fill: (i: number) => Record<string, unknown>, at = NOW): Memory => {
	const m = emptyMemory();
	for (let i = 0; i < n; i++) {
		const checked = checkCard(fill(i), { senders: new Set([SENDER]), restates: () => undefined, lang: "zh-TW" });
		if (!checked.ok) throw new Error(checked.lines.join("\n"));
		addCardWait(m, at + i * 1000, "r1", checked, checked.from === "self" ? undefined : raiser);
	}
	return m;
};
/** Plain words up to exactly `n` characters (a run of one letter would look like a key). */
const words = (n: number, head = ""): string => `${head} ${"word ".repeat(Math.ceil(n / 5))}`.slice(0, n).trimEnd().padEnd(n, ".");
const FULL = (i: number) => ({
	type: "choice", from: SENDER, happened: words(CARD.happened, `H${i}`), do: words(CARD.do, `D${i}`), url: `https://example.org/${"u-".repeat(30)}/${i}`, command: Array.from({ length: 4 }, (_, n) => `echo ${words(60)} ${n}`).join("\n"), after: words(CARD.after),
	options: Array.from({ length: 4 }, (_, n) => ({ label: words(CARD.label, `L${n}`), then: words(CARD.then) })),
});

test("memorySummary: a card wait carries its card and, after a press, the press; a legacy wait has neither", () => {
	const m = memWith(1, () => base);
	addWait(m, NOW, "r0", { text: "an old one", for: "boss" });
	m.entries[0]!.press = { act: "done", at: new Date(NOW).toISOString(), main: { status: "delivered", at: new Date(NOW).toISOString() } };
	m.entries[0]!.state = "answered";
	m.entries[0]!.answered = new Date(NOW).toISOString();
	const [card, legacy] = memorySummary(m).bossWaits;
	assert.equal(card!.card!.type, "action");
	assert.deepEqual(card!.card!.from, { id: SENDER, name: "mp3946-print", role: "main", workspace: "MP Center", tab: "MP-3946" });
	assert.equal(card!.press!.act, "done");
	assert.deepEqual([legacy!.card, legacy!.press, legacy!.cut], [undefined, undefined, undefined]);
});

test("a card the budget cuts keeps the auto mode flags: a parked or listed wait stays silent (AG-F003)", () => {
	const sums: MemorySummary[] = Array.from({ length: 4 }, (_, t) => memorySummary(memWith(12, FULL, NOW + t * 100_000)));
	sums.flatMap((s) => s.bossWaits).forEach((w, i) => void Object.assign(w, i % 2 ? { parked: true } : { listed: true }));
	const cutOnes = cutCards(sums).flatMap((s) => s.bossWaits).filter((w) => w.cut);
	assert.ok(cutOnes.length > 0);
	for (const w of cutOnes) assert.equal(Boolean(w.parked) !== Boolean(w.listed), true, `${w.id} keeps exactly its flag`);
});

test("AR-F006: a returned card the budget cuts keeps `returned`, so the page still says auto mode's end closed it", () => {
	const sums: MemorySummary[] = Array.from({ length: 4 }, (_, t) => memorySummary(memWith(12, FULL, NOW + t * 100_000)));
	sums.flatMap((s) => s.bossWaits).forEach((w) => void Object.assign(w, { state: "resolved", outcome: "returned to docs-main to ask the boss again (auto mode ended)", ended: w.at, returned: "raiser" }));
	const cutOnes = cutCards(sums).flatMap((s) => s.bossWaits).filter((w) => w.cut);
	assert.ok(cutOnes.length > 0);
	for (const w of cutOnes) assert.deepEqual([w.state, w.returned], ["resolved", "raiser"], `${w.id} keeps where it went`);
});

test("the budget: whole cards newest first across towers while their text sum is at most CARD_TEXTS; the rest go as { id, text, at, cut } and a cut card has its text; measured on 12 waits x 10 towers at every cap", () => {
	const sums: MemorySummary[] = Array.from({ length: 10 }, (_, t) => memorySummary(memWith(12, FULL, NOW + t * 100_000)));
	const raw = JSON.stringify(sums).length;
	const cutSums = cutCards(sums);
	const all = cutSums.flatMap((s) => s.bossWaits);
	const whole = all.filter((w) => w.card), cutOnes = all.filter((w) => w.cut);
	assert.equal(whole.length + cutOnes.length, 120);
	assert.ok(whole.length > 0 && cutOnes.length > 0, "both kinds are there");
	assert.ok(whole.reduce((n, w) => n + cardTexts(w.card!), 0) <= CARD_TEXTS, "the whole cards fit the budget");
	for (const w of cutOnes) assert.deepEqual(Object.keys(w).sort(), ["at", "cut", "id", "text"], "a cut card is its id, text, time, and the mark");
	const newestWhole = Math.min(...whole.map((w) => Date.parse(w.at))), newestCut = Math.max(...cutOnes.map((w) => Date.parse(w.at)));
	assert.ok(newestWhole >= newestCut, "newest first: a cut card is never newer than a whole one");
	const size = JSON.stringify(cutSums).length;
	// Measured: 120 cards at every cap are 234,701 characters raw; with the budget the waits are 55,389 (16 whole cards of about 1,500 units, 104 cut rows). The bound is that, rounded up.
	assert.ok(size < 60_000, `the snapshot is ${size} characters (raw ${raw})`);
	assert.deepEqual(sums[0]!.bossWaits.every((w) => w.card), true, "the input is not changed");
});

test("a card that fits is not cut, and a legacy wait is never counted against the budget", () => {
	const small = memorySummary(memWith(3, () => base));
	addWait(emptyMemory(), NOW, "r", { text: "x", for: "boss" });
	const out = cutCards([small])[0]!.bossWaits;
	assert.deepEqual(out.map((w) => w.cut), [undefined, undefined, undefined]);
});

test("buildNet: the raiser's unit key is set on a card whose raiser is a unit of the net, and the session id does not reach the page", () => {
	const SESSIONS = [
		{ id: "sb-tower-wa", name: "tower · Alpha", herdrLocation: { status: "ok", paneId: "wA:p1", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "T" } } },
		{ id: SENDER, name: "mp3946-print", herdrLocation: { status: "ok", paneId: "wA:p2", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t2", label: "MP-3946" } } },
	];
	const view = (): TowerView => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], queue: [], memory: memorySummary(memWith(2, (i) => ({ ...base, from: i ? "self" : SENDER }))) });
	const net = buildNet({
		sessions: SESSIONS as never,
		panes: [{ pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA", tokens: { sb_role: "tower" } }, { pane_id: "wA:p2", tab_id: "wA:t2", workspace_id: "wA", tokens: { sb_role: "main" } }] as never,
		workspaces: [{ workspace_id: "wA", label: "Alpha", tokens: { tower: "sb-tower-wa" } }] as never, children: () => [], services: () => view(), sessionDir: tmpdir(),
	});
	const main = net.bases[0]!.tabs.flatMap((t) => t.units).find((u) => u.id === SENDER)!;
	const waits = net.bases[0]!.tower!.service!.memory!.bossWaits;
	assert.equal(waits[0]!.card!.from!.key, main.key);
	assert.equal("id" in waits[0]!.card!.from!, false, "the session id stays on the server");
	assert.equal(waits[1]!.card!.from, undefined, "self has no raiser");
});
