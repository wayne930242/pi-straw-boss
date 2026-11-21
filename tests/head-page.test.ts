import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net, TowerService } from "../src/net.ts";
import type { HeadAskRow, HeadUnit } from "../src/nethead.ts";
import { El, sessionGlobals, stored } from "./fake-dom.ts";

// The head page and its entries (docs/specs/2026-11-04-head-tower.md, Standard: the head page and its entries; H4): the header's crown button and its dot, the asks as chips under the conversation box, the state line, the absent state,
// and the head found by the session view as the unit it is. In both languages. The pictures of every state are taken by hand from the demo (`?head=`).

sessionGlobals();
const { askGroups, fillHeadAsks, fillHeadButton, fillHeadLog, fillHeadTitle, groupLine, headDot, headLine, headMemory, remember, seenAt, SEEN, sentLine, towerState } = await import("../gui/headpage.ts");
const { fillHeadActs } = await import("../gui/headacts.ts");
const { locate } = await import("../gui/scene.ts");
const { towerRoute } = await import("../gui/towermodel.ts");
const { formatRoute, parseRoute } = await import("../gui/router.ts");
const { m } = await import("../gui/paraglide/messages.js");
const zh = { locale: "zh-TW" } as const;

const NOW = Date.parse("2026-11-04T10:00:00Z");
const ask = (over: Partial<HeadAskRow> = {}): HeadAskRow => ({ id: "H1", group: "H1", workspace: "wA", label: "MP Center", since: NOW - 12 * 60_000, at: NOW - 12 * 60_000, first: "I am up", state: "waiting", answers: 0, ...over });
const svc = (over: Partial<TowerService> = {}): TowerService => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], ...over });
const head = (over: Partial<HeadUnit> = {}): HeadUnit => ({ key: "sb-head", name: "head tower", mark: "idle", state: "standing", service: svc(), asks: [], ...over });
const btn = () => {
	const b = new El("button"), dot = new El("i");
	dot.className = "dot";
	b.append(dot);
	return { b: b as unknown as HTMLElement, dot };
};

test("the dot is on while the head said something newer than this device has seen, and never for a head that said nothing", () => {
	assert.equal(headDot(head({ said: 2000 }), 1000), true);
	assert.equal(headDot(head({ said: 1000 }), 1000), false, "seen up to it");
	assert.equal(headDot(head({ said: 1000 }), 2000), false);
	assert.equal(headDot(head(), 0), false, "nothing said");
	assert.equal(headDot(undefined, 0), false, "no head on the net");
	assert.equal(seenAt(), 0, "a device that never opened the page has seen nothing");
	remember(5000);
	assert.equal(stored.get(SEEN), "5000");
	assert.equal(seenAt(), 5000);
	remember(3000);
	assert.equal(seenAt(), 5000, "what was seen never goes back");
	stored.set(SEEN, "garbage");
	assert.equal(seenAt(), 0);
	stored.delete(SEEN);
});

test("the header's button is there while the net has a head, carries its state, and shows the dot only when there is news and the page is not the head page", () => {
	const { b, dot } = btn();
	fillHeadButton(b, undefined, 0, false);
	assert.equal(b.hidden, true, "no head on the net (the tower service is off): no button");
	fillHeadButton(b, head({ said: 2000, mark: "working", state: "running" }), 1000, false);
	assert.deepEqual([b.hidden, dot.hidden, b.dataset.mark, b.dataset.state], [false, false, "working", "running"]);
	fillHeadButton(b, head({ said: 2000 }), 1000, true);
	assert.equal(dot.hidden, true, "on the head page what it said is read");
	assert.equal(b.getAttribute("aria-current"), "page");
	fillHeadButton(b, head({ said: 2000 }), 2000, false);
	assert.deepEqual([dot.hidden, b.hasAttribute("aria-current")], [true, false]);
	fillHeadButton(b, head({ state: "absent" }), 0, false);
	assert.deepEqual([b.hidden, b.dataset.state], [false, "absent"], "the button opens the page before the head exists: its first message opens the head");
	assert.match(b.title, /Head tower/);
	assert.doesNotMatch((b as unknown as El).dump(), /\d/, "a dot, never a number");
});

const HOUR = 3_600_000;
const towers = (...ids: string[]) => ({ bases: ids.filter((id) => id !== "wX").map((id) => ({ id, label: id, mark: "idle", tower: { key: `sb-tower-${id}`, name: `tower · ${id}` }, tabs: [], outposts: [], outside: [] })) }) as unknown as Net;
/** Five broadcasts of four workspaces, the way the demo has them (wX has no tower): the newest two are recent, the others older than a day. */
const five = (): HeadAskRow[] => ["I am up", "Going out", "Continue, I am studying", "Back", "Going to sleep"].flatMap((first, g) => ["wA", "wB", "wC", "wX"].map((workspace, i): HeadAskRow => {
	const since = NOW - (g < 2 ? (g + 1) * HOUR : (30 + g * 3) * HOUR), n = g * 4 + i + 1, answered = i === 0 && g !== 3;
	return { id: `H${n}`, group: `H${g * 4 + 1}`, workspace, label: `Label ${workspace}`, since, at: answered ? since + 10 * 60_000 : since, first, state: answered ? "answered" : g < 2 ? "waiting" : "silent", answers: answered ? 1 : 0, ...(answered ? { last: `${workspace} is on it: ${first}` } : {}) };
}));

test("the asks are broadcasts: one group per `group`, newest first, its towers the distinct workspaces, a tower the net does not have has no route, and a group quiet for a day is older", () => {
	const { recent, older } = askGroups(five(), NOW, towers("wA", "wB", "wC"));
	assert.deepEqual(recent.map((g) => [g.id, g.first, g.towers.length, g.handled]), [["H1", "I am up", 4, 1], ["H5", "Going out", 4, 1]]);
	assert.deepEqual(older.map((g) => g.id), ["H9", "H13", "H17"], "newest first among the older too");
	assert.deepEqual(recent[0]!.towers.map((t) => [t.workspace, t.state, t.said, t.route]), [
		["wA", "answered", "wA is on it: I am up", "w/wA/s/sb-tower-wA"], ["wB", "waiting", undefined, "w/wB/s/sb-tower-wB"], ["wC", "waiting", undefined, "w/wC/s/sb-tower-wC"], ["wX", "waiting", undefined, undefined],
	]);
	// a workspace asked twice in one broadcast shows its best state and its newest answer; an old ask with no `group` is its own
	const twice = askGroups([ask({ id: "H1", group: "H1", state: "silent", at: NOW - 5 * HOUR, since: NOW - 5 * HOUR }), ask({ id: "H2", group: "H1", state: "answered", answers: 1, last: "late", since: NOW - 4 * HOUR, at: NOW - HOUR }), { ...ask({ id: "H3" }), group: undefined as never }], NOW, towers("wA")).recent;
	assert.deepEqual(twice.map((g) => [g.id, g.towers.length, g.towers[0]!.state, g.towers[0]!.said, g.since]), [["H3", 1, "waiting", undefined, NOW - 12 * 60_000], ["H1", 1, "answered", "late", NOW - 5 * HOUR]]);
	assert.deepEqual(askGroups([], NOW, undefined), { recent: [], older: [] });
});

test("a group's line reads `age ago · k/N handled` in both languages (a tower that answered or handled counts) (who it went to is a part of its own), and the state words never say answered without an answer", () => {
	const g = askGroups(five(), NOW, towers("wA")).recent[0]!;
	assert.equal(groupLine(g, NOW), "1h ago · 1/4 handled");
	assert.equal(groupLine(g, NOW, zh), "1 小時前・已處理 1/4");
	assert.equal(groupLine(askGroups([ask()], NOW, undefined).recent[0]!, NOW), "12m ago · 0/1 handled");
	assert.deepEqual([m.head_ask_waiting({}, zh), m.head_ask_answered({}, zh), m.head_ask_silent({}, zh), m.head_ask_no_tower({}, zh), m.head_older({ count: 3 }, zh)], ["等回覆", "已回覆", "沒回應", "沒有塔台", "更早（3）"]);
});

test("the asks fill under the conversation box: a row per broadcast that unfolds to each tower's answer as visible text, links where the tower is known, `no tower` muted where not, the older ones in one fold", () => {
	const net = towers("wA", "wB", "wC"), box = new El("div"), el = box as unknown as HTMLElement;
	fillHeadAsks(el, head({ asks: [] }), net, NOW);
	assert.equal(box.hidden, true);
	fillHeadAsks(el, head({ asks: five() }), net, NOW);
	assert.equal(box.hidden, false);
	const rows = box.children;
	assert.deepEqual(rows.map((r) => r.classes.has("ask-group") ? "group" : r.classes.has("ask-older") ? "older" : "?"), ["group", "group", "older"]);
	assert.equal(rows[0]!.find((x) => x.tag === "summary")[0]!.find((x) => x.classes.has("ask-meta"))[0]!.textContent, "1h ago · 1/4 handled");
	assert.equal(rows[2]!.find((x) => x.tag === "summary")[0]!.textContent, "Older (3)");
	assert.equal(rows[2]!.find((x) => x.classes.has("ask-group")).length, 3, "the older groups are rows of their own inside the fold");
	const lines = rows[0]!.find((x) => x.classes.has("ask-tower"));
	assert.deepEqual(lines.map((l) => [l.find((x) => x.classes.has("ask-name"))[0]!.tag, l.find((x) => x.classes.has("ask-state"))[0]?.textContent, l.find((x) => x.classes.has("ask-said"))[0]?.textContent, l.find((x) => x.classes.has("ask-none"))[0]?.textContent]), [
		["a", "answered", "wA is on it: I am up", undefined], ["a", "waiting", undefined, undefined], ["a", "waiting", undefined, undefined], ["b", undefined, undefined, "no tower"],
	]);
	assert.deepEqual(lines.map((l) => l.getAttribute("data-state")), ["answered", "waiting", "waiting", "none"], "a tower the net lost is not gold and not waiting: nothing will answer it");
	assert.equal(lines[0]!.find((x) => x.tag === "a")[0]!.getAttribute("data-route"), "w/wA/s/sb-tower-wA");
	assert.ok(!box.dump().includes("title="), "an answer is text on the page, not a tooltip");
	// the same asks leave the rows as they are; one the boss unfolded stays unfolded across a redraw
	const first = box.children[0];
	fillHeadAsks(el, head({ asks: five() }), net, NOW + 20_000);
	assert.equal(box.children[0], first, "so a click never lands on a replaced row");
	first!.setAttribute("open", "");
	first!.dispatchEvent({ type: "toggle" });
	fillHeadAsks(el, head({ asks: five() }), net, NOW + 120_000);
	assert.equal(box.children[0]!.hasAttribute("open"), true);
	assert.equal(box.children[1]!.hasAttribute("open"), false);
	fillHeadAsks(el, undefined, net, NOW);
	assert.equal(box.hidden, true);
	assert.equal(box.kids.length, 0);
});

test("HM-F002: a row with no tower and no answer says only `no tower` (muted, never waiting, never silent); one that answered before the tower left keeps its answer and says both; the group line still counts every tower asked", () => {
	const net = towers("wA"), box = new El("div"), el = box as unknown as HTMLElement;
	const rows = [ask({ id: "H1", group: "H1", workspace: "wA" }), ask({ id: "H2", group: "H1", workspace: "wX", label: "Gone" }), ask({ id: "H3", group: "H1", workspace: "wY", label: "Left", state: "answered", answers: 1, last: "did it" }), ask({ id: "H4", group: "H1", workspace: "wZ", label: "Quiet", state: "silent" })];
	fillHeadAsks(el, head({ asks: rows }), net, NOW);
	const lines = box.children[0]!.find((x) => x.classes.has("ask-tower"));
	assert.deepEqual(lines.map((l) => [l.find((x) => x.classes.has("ask-name"))[0]!.textContent, l.find((x) => x.classes.has("ask-state"))[0]?.textContent, l.find((x) => x.classes.has("ask-none"))[0]?.textContent, l.getAttribute("data-state")]), [
		["MP Center", "waiting", undefined, "waiting"], ["Gone", undefined, "no tower", "none"], ["Left", "answered", "no tower", "answered"], ["Quiet", undefined, "no tower", "none"],
	]);
	assert.doesNotMatch(lines[1]!.textContent, /waiting|no answer/);
	assert.match(box.children[0]!.find((x) => x.tag === "summary")[0]!.textContent, /12m ago · 1\/4 handled/);
	assert.equal(towerState({ workspace: "wX", label: "Gone", state: "waiting" }, zh), "沒有塔台");
});

test("the head's memory footer is there for a standing instruction, a decision, a pending proposal, or an unreadable file; not for nothing and not for waits alone", () => {
	const mem = (over: Record<string, unknown> = {}) => ({ rev: 1, standing: 0, decisions: 0, waits: 0, bossWaits: [], proposals: [], ...over }) as never;
	assert.equal(headMemory(undefined), undefined);
	assert.equal(headMemory(mem()), undefined, "0 · 0 · 0");
	assert.equal(headMemory(mem({ waits: 2, bossWaits: [{ id: "W1", text: "x", at: "2026-11-06T00:00:00Z" }] })), undefined, "waits alone");
	for (const over of [{ standing: 1 }, { decisions: 2 }, { proposals: [{ id: "P1" }] }, { problem: "unreadable" }]) assert.ok(headMemory(mem(over)), JSON.stringify(over));
});

test("the head's conversation actions are one row: End and New while a conversation is live (End not while it is closing), Close always once the head exists, none before; the result of a click stays", async () => {
	const posted: string[] = [], real = globalThis.fetch;
	globalThis.fetch = (async (url: string) => (posted.push(String(url)), { ok: true, status: 200, json: async () => ({}) })) as never;
	const box = new El("div"), el = box as unknown as HTMLElement, live = { conversation: { since: "2026-11-06T08:00:00Z", resumed: true, turns: 1, idle: false, idleMs: 600_000, capAt: 1 } } as unknown as TowerService;
	const labels = () => box.find((x) => x.tag === "button").map((b) => b.textContent);
	fillHeadActs(el, undefined, false);
	assert.equal(box.hidden, true);
	assert.deepEqual(labels(), []);
	fillHeadActs(el, svc(), true);
	assert.deepEqual([box.hidden, labels()], [false, ["Close"]], "nothing live: only Close");
	fillHeadActs(el, live, true);
	assert.deepEqual(labels(), ["End conversation", "New conversation", "Close"]);
	assert.equal(box.find((x) => x.tag === "button" && x.getAttribute("data-close") === "head").length, 1, "Close is the one quit.ts asks about once");
	assert.equal(box.find((x) => x.classes.has("menu-pop") || x.classes.has("menu-btn")).length, 0, "no ⋯ popover");
	const end = box.find((x) => x.tag === "button")[0]!;
	end.click();
	await new Promise((done) => setTimeout(done, 20));
	assert.deepEqual(posted, ["api/head/leave"], "End is the head's own route, the pi twin of /boss tower leave");
	assert.equal(box.find((x) => x.classes.has("conv-done"))[0]!.textContent, m.conv_left(), "what it said");
	fillHeadActs(el, { ...live, conversation: { ...live.conversation!, closing: true } }, true);
	assert.deepEqual(labels(), ["New conversation", "Close"]);
	assert.equal(box.find((x) => x.classes.has("conv-done"))[0]!.textContent, m.conv_left(), "and it stays across the redraw it caused");
	globalThis.fetch = real;
});

test("the header says Head tower with its state, or that the first message opens it; the title is the same in zh-TW", () => {
	assert.equal(headLine(head({ state: "absent", service: undefined })), m.head_state_absent());
	assert.equal(headLine(head({ state: "absent", service: undefined })), "not open");
	assert.equal(headLine(head({ state: "absent", service: undefined }), zh), "尚未開啟");
	assert.match(headLine(head({ mark: "idle" })), /standing by/);
	assert.equal(m.head_tower(), "Head tower");
	assert.equal(m.head_tower({}, zh), "主塔台");
	const root = new El("div"), icon = new El("use"), title = new El("span"), small = new El("small"), line = new El("p"), absent = new El("p");
	icon.className = "head-icon"; title.className = "head-title"; small.className = "head-kicker"; line.className = "head-line"; absent.className = "head-absent";
	root.append(icon, title, small, line, absent);
	small.dataset.m = "comms"; // the session template's kicker word, which retranslate() would write back on a view switch (RRB2-F001)
	fillHeadTitle(root as unknown as HTMLElement, head({ state: "absent", service: undefined }));
	assert.equal(small.dataset.m, undefined, "the head's kicker stays empty under every view");
	assert.deepEqual([title.textContent, small.textContent, absent.hidden, absent.textContent, icon.getAttribute("href")], ["Head tower", "", false, "The head tower opens with your first message", "#i-crown"]);
	fillHeadTitle(root as unknown as HTMLElement, head({ state: "standing" }));
	assert.equal(absent.hidden, true, "the line is for the head that is not open");
});

test("the session view finds the head by its key as a tower of its own: a stand-in base that is not a base of the net, no Quit tower, and its buttons are api/head/…", () => {
	const net = { bases: [], head: head({ mark: "working", queued: [{ text: "boss: ship it", as: "followUp" }] }) } as unknown as Net;
	const hit = locate(net, "sb-head")!;
	assert.deepEqual([hit.u.key, hit.u.name, hit.u.role, hit.u.mark, hit.u.control], ["sb-head", "head tower", "tower", "working", true]);
	assert.equal(hit.base.id, "@head");
	assert.equal(hit.u.head, true, "the chat names the head's words for it");
	assert.equal(hit.base.tower, null, "no +Main and no Quit tower: the stand-in has no tower of the base's kind");
	assert.deepEqual(hit.u.queued, [{ text: "boss: ship it", as: "followUp" }]);
	assert.equal(locate({ bases: [] } as unknown as Net, "sb-head"), undefined, "no head on the net");
	assert.equal(locate(net, "sb-other"), undefined);
	assert.equal(towerRoute("@head"), "head");
	assert.equal(towerRoute("wA"), "tower/wA");
	assert.equal(towerRoute("a/b"), "tower/a%2Fb");
	assert.equal(formatRoute({ view: "session", ws: "@head", key: "sb-head" }), "head");
	assert.deepEqual(parseRoute("head"), { view: "head" });
});

test("a chapter divider of the head's history is a chapter divider, not a branch summary: when the chapter began and why, in the page's language; the two other dividers read as they did", async () => {
	const { mountChat } = await import("../gui/chat.ts");
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "sb-head", name: "head tower", role: "tower", mark: "idle" as const }), link: () => undefined });
	chat.apply({ key: "sb-head", reset: true, items: [
		{ id: "chapter-1", kind: "divider", type: "chapter", at: "2026-11-01T08:00:00Z", text: "the first conversation" },
		{ id: "k1", kind: "divider", type: "compaction", tokens: 1234, text: "summary" },
		{ id: "b1", kind: "divider", type: "branch", text: "a branch" },
	] });
	const rules = root.find((el) => el.tag === "article" && el.classes.has("rule"));
	assert.equal(rules.length, 3);
	assert.match(rules[0]!.textContent, /^New chapter · .*2026.* · the first conversation$/, rules[0]!.textContent);
	assert.ok(rules[0]!.classes.has("chapter"));
	assert.doesNotMatch(rules[0]!.textContent, /branch summary/);
	assert.equal(rules[0]!.find((el) => el.tag === "details").length, 0, "a chapter marker folds nothing: its why is its line");
	assert.match(rules[1]!.textContent, /context compacted/);
	assert.match(rules[2]!.textContent, /branch summary/);
});

test("the head's words are named for the head, its chapter divider speaks the page's language, and its composer says what it wakes", async () => {
	const { speaker, chapterWhy } = await import("../gui/chat.ts");
	const { placeholderOf } = await import("../gui/composer.ts");
	assert.equal(speaker({ role: "tower", head: true }), m.head_tower());
	assert.equal(speaker({ role: "tower" }), m.role_tower());
	assert.equal(chapterWhy("first"), m.head_why_first());
	assert.equal(chapterWhy("size"), m.head_why_size());
	assert.equal(chapterWhy("later-code", "raw reason"), "raw reason", "a code this page does not know shows the text");
	const unit = { name: "head tower", wakes: true, conversation: true, head: true } as Parameters<typeof placeholderOf>[0];
	assert.equal(placeholderOf({ ...unit, conversation: false }), m.head_wakes(), "an absent or asleep head is woken");
	assert.equal(placeholderOf(unit), m.head_continues(), "a live head continues the conversation, named for the head, never woken");
	assert.match(m.head_continues({}, { locale: "zh-TW" }), /主塔台/);
	assert.match(m.head_continues({}, { locale: "en" }), /head tower/);
});

test("the server's chapter reasons have codes", async () => {
	const { whyCode } = await import("../src/headhistory.ts");
	assert.deepEqual(["the first conversation", "the boss asked for a new conversation", "the last one grew past 8 MB", "the last session file is gone"].map(whyCode), ["first", "new", "size", "unreadable"]);
});

test("the sheet: no self-referencing --c, no head Info, no uppercase chapter line, a news dot on the phone's ⋯ and the drawer row", async () => {
	const { readFileSync } = await import("node:fs");
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
	assert.doesNotMatch(css, /--c:\s*var\(--c\)/);
	assert.match(css, /\.comms-head\[data-head\] \.head-info\s*\{\s*display:\s*none/);
	assert.doesNotMatch(css, /\.tx\.rule\.chapter p \{[^}]*uppercase/);
	assert.match(css, /\.bar-more\[data-news\]::after/);
	assert.match(css, /\.drawer-head\[data-news\]/);
});

test("the head's marks: the map node and the chat avatar carry the crown in the crown's colour, one row of buttons in the conversation box, and no empty ⋯ in the page header", async () => {
	const { readFileSync } = await import("node:fs");
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8"), html = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8"), chat = readFileSync(new URL("../gui/chat.ts", import.meta.url), "utf8");
	assert.match(html, /id="head-node"[^>]*><svg class="head-crown"[^>]*><use data-icon="crown" href="#i-crown"\/>/, "the head band's mark is the crown");
	assert.match(css, /\.head-node \.head-crown, \.tx\.in\.head \.ava \{[^}]*color: var\(--gold\)/);
	assert.match(chat, /icon\(me\.head \? "crown" : me\.role, me\.duty\)/, "the head's messages wear the crown");
	assert.match(css, /\.comms-head\[data-head\] \.head-menu \{ display: none; \}/);
});

test("the session view mounts its chat as a page, so the head's page hides its tool cards, and Zen's two logs of a chat do not", async () => {
	const { readFileSync } = await import("node:fs");
	const src = (f: string) => readFileSync(new URL(`../gui/${f}`, import.meta.url), "utf8");
	assert.match(src("session.ts"), /mountChat\([^;]*\{[^}]*\bpage: true\b[^}]*\}\)/, "the session view passes page: true");
	for (const f of ["zen.ts", "zenhistory.ts"]) for (const call of src(f).match(/mountChat\([^;]*?\}\)/g) ?? []) assert.doesNotMatch(call, /\bpage\b/, `${f} mounts its log without page`);
});

test("the head's page leaves out its tool calls, shell lines, and the sb server's notices and timers, and keeps its words, the boss's lines, and a tower's answer; a workspace tower's page and Zen's companion log of the head show all of them", async () => {
	const { mountChat } = await import("../gui/chat.ts");
	Object.assign(document, { createDocumentFragment: () => new El("#fragment"), createTextNode: (t: string) => t });
	const items = [
		{ id: "u1", kind: "user", text: "tell everyone I am up", at: "2026-11-06T08:00:00Z" },
		{ id: "a1", kind: "assistant", model: "m", at: "2026-11-06T08:00:01Z", text: "Handing it out.", tools: [{ id: "t1", name: "tower_send", summary: "(workspace: wA)", args: "{}" }] },
		{ id: "a2", kind: "assistant", model: "m", at: "2026-11-06T08:00:02Z", tools: [{ id: "t2", name: "tower_done", summary: "(note: 11/06 morning)", args: "{}" }] },
		{ id: "n1", kind: "notice", type: "straw-tower", event: "notice", at: "2026-11-06T08:00:03Z", text: "[notice from the sb server] [event id: 0123456789abcde1]\nThe run has been open for 40 minutes." },
		{ id: "n2", kind: "notice", type: "straw-tower", event: "timer", at: "2026-11-06T08:00:04Z", text: "[your wakeAfter follow-up is due] [event id: 0123456789abcde2]\nCheck." },
		{ id: "n3", kind: "notice", type: "straw-tower", event: "intercom", from: "tower · Alpha", at: "2026-11-06T08:00:05Z", text: "[intercom from tower Alpha (a1)] [event id: 0123456789abcde3]\nDone." },
		{ id: "b1", kind: "bash", command: "ls", exit: 0, at: "2026-11-06T08:00:06Z", text: "x" },
	] as never[];
	const draw = (head: boolean, page = true) => {
		const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
		const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "k", name: "n", role: "tower", mark: "idle" as const, service: { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] }, ...(head ? { head: true } : {}) }), link: () => undefined, page });
		chat.apply({ key: "k", reset: true, items });
		return root;
	};
	const shown = (root: El) => root.find((el) => el.tag === "article" && !el.hasAttribute("hidden")).map((a) => a.textContent);
	const head = draw(true);
	assert.equal(head.find((el) => el.classes.has("act")).length, 0, "no tool card, no shell card");
	const text = shown(head).join("\n");
	assert.match(text, /tell everyone I am up/);
	assert.match(text, /Handing it out\./, "the head's prose stays when its entry also made a call");
	assert.match(text, /Done\./, "a tower's answer stays");
	assert.doesNotMatch(text, /sb server|follow-up|tower_done|tower_send|open for 40|event id:/);
	assert.equal(head.find((el) => el.classes.has("skip")).length, 4, "tool-only entry, two server notices, shell line: hidden, in their place");
	const tower = draw(false);
	assert.equal(tower.find((el) => el.classes.has("act")).length, 3, "a workspace tower's page is as it was");
	assert.match(shown(tower).join("\n"), /open for 40 minutes/);
	// HM-F006: Zen's companion log mounts the same chat for the head without `page`, and draws what it drew on main
	const zen = draw(true, false);
	assert.equal(zen.find((el) => el.classes.has("act")).length, 3, "Zen's head history keeps the tool cards and the shell line");
	assert.equal(zen.find((el) => el.classes.has("skip")).length, 0, "nothing is hidden there");
	assert.match(shown(zen).join("\n"), /open for 40 minutes/);
});


// --- the cards of the head's broadcasts (todo #124, docs/specs/2026-11-07-head-log-cards.md) ------------------------------------------------------------------------------------------------------------------------

const BOSS = "我沒說要道安全點收尾，我只是要確定不會自動休眠。到底為什麼你幫我加了時間限制？";
const SENT = `Boss CORRECTION 2: 「${BOSS}」. My earlier message was wrong: do not add a deadline.\nKeep the caffeinate running until the boss says stop; report the PID.`;
const part = (card: El, name: string) => card.find((x) => x.tag === "summary")[0]!.find((x) => x.classes.has("ask-part") && x.getAttribute("data-part") === name)[0];
const textOf = (el: El | undefined, cls: string) => el?.find((x) => x.classes.has(cls))[0]?.textContent;

test("a card tells what the boss said, what the head sent, to whom, and when with how many replies, as parts of their own with labels, in both languages; the boss's words inside the head's line are left to their own part", () => {
	const net = towers("wA", "wB"), box = new El("div"), el = box as unknown as HTMLElement;
	const rows = [ask({ id: "H5", group: "H5", workspace: "wA", label: "MP Center", boss: BOSS, sent: SENT, first: SENT.split("\n")[0]!.slice(0, 120) }), ask({ id: "H6", group: "H5", workspace: "wB", label: "Agent Root", sent: "Boss said it. Keep the caffeinate running.", first: "Boss said it. Keep the caffeinate running.", state: "answered", answers: 1, last: "PID 55235" })];
	fillHeadAsks(el, head({ asks: rows }), net, NOW);
	const card = box.children[0]!;
	const summary = card.find((x) => x.tag === "summary")[0]!;
	assert.deepEqual(summary.find((x) => x.classes.has("ask-part")).map((x) => x.getAttribute("data-part")), ["boss", "sent", "to"], "three parts, then the line of when and replies");
	assert.deepEqual([textOf(part(card, "boss"), "ask-tag"), textOf(part(card, "boss"), "ask-text")], ["You said", BOSS]);
	assert.deepEqual([textOf(part(card, "sent"), "ask-tag"), textOf(part(card, "sent"), "ask-text")], ["Head sent", "Boss CORRECTION 2: My earlier message was wrong: do not add a deadline."]);
	assert.deepEqual([textOf(part(card, "to"), "ask-tag"), textOf(part(card, "to"), "ask-text")], ["To", "MP Center, Agent Root"]);
	assert.equal(textOf(summary, "ask-meta"), "12m ago · 1/2 handled");
	// the whole of both texts is on the unfolded card, as visible text
	const full = card.find((x) => x.classes.has("ask-full"))[0]!;
	assert.deepEqual(full.find((x) => x.tag === "section").map((x) => [x.getAttribute("data-part"), textOf(x, "ask-tag"), x.find((y) => y.tag === "p")[0]!.textContent]), [["boss", "You said", BOSS], ["sent", "Head sent", SENT]]);
	// a tower sent other words than the first: its line carries them; one sent the same carries nothing more
	const lines = card.find((x) => x.classes.has("ask-tower"));
	assert.deepEqual(lines.map((l) => textOf(l, "ask-sent")), [undefined, "Boss said it. Keep the caffeinate running."]);
	// zh-TW labels, in Taiwan usage
	assert.deepEqual([m.head_part_boss({}, zh), m.head_part_sent({}, zh), m.head_part_to({}, zh), m.head_sep({}, zh)], ["你說", "主塔台送出", "送給", "、"]);
	// without the boss's words (an ask the head opened on its own, or one from before they were kept) there is no part for them: nothing is guessed
	fillHeadAsks(el, head({ asks: [ask({ id: "H7", group: "H7", first: "Going out" })] }), net, NOW);
	assert.deepEqual(box.children[0]!.find((x) => x.tag === "summary")[0]!.find((x) => x.classes.has("ask-part")).map((x) => x.getAttribute("data-part")), ["sent", "to"]);
	assert.equal(textOf(part(box.children[0]!, "sent"), "ask-text"), "Going out");
	assert.equal(box.children[0]!.find((x) => x.classes.has("ask-full"))[0]!.find((x) => x.tag === "section").length, 1, "only what the head sent");
});

test("the head's line with the boss's own words taken out: only an exact copy of them is left to their part; anything else stays as the head wrote it", () => {
	const g = { boss: "電腦重開了", first: "x" };
	assert.equal(sentLine({ ...g, sent: "Boss: 「電腦重開了」. The Mac was restarted." }), "Boss: The Mac was restarted.", "the quotes around the copy and the full stop after it go with it: no 「…」");
	assert.equal(sentLine({ ...g, sent: "Boss: 「電腦又重開了」. The Mac was restarted." }), "Boss: 「電腦又重開了」. The Mac was restarted.", "a paraphrase is not a copy");
	assert.equal(sentLine({ ...g, sent: "電腦重開了" }), "電腦重開了", "the head sent nothing but the boss's words: the line is that");
	assert.equal(sentLine({ boss: undefined, first: "kept first line", sent: undefined as never }), "kept first line", "an ask from before the whole text was kept");
	assert.equal(sentLine({ ...g, sent: "\n\n  Boss: 「電腦重開了」.\nsecond" }), "Boss:", "the first line with words");
	assert.equal(sentLine({ ...g, sent: "\u0007\u2028\nreal text" }), "real text", "a line of control characters only is not the first line");
	assert.equal(sentLine({ boss: "a|b.*", first: "x", sent: "Boss: 「a|b.*」 go" }), "Boss: go", "no pattern is made of the boss's words");
	// one pair of quotation marks around the copy, whichever kind, and one full stop after it: nothing else next to it is touched
	for (const [open, close] of [["「", "」"], ["『", "』"], ["“", "”"], ["\"", "\""], ["'", "'"], ["‘", "’"]]) assert.equal(sentLine({ ...g, sent: `Boss CORRECTION 2: ${open}電腦重開了${close}. Remove the time limit.` }), "Boss CORRECTION 2: Remove the time limit.", open);
	assert.equal(sentLine({ ...g, sent: "Boss: 「電腦重開了」。主塔台請照辦。" }), "Boss: 主塔台請照辦。", "an ideographic full stop too");
	assert.equal(sentLine({ ...g, sent: "Boss: 「電腦重開了」, then \"stop\"." }), "Boss: , then \"stop\".", "a comma is not a full stop, and other quotes stay");
	assert.equal(sentLine({ ...g, sent: "Boss said 「電腦重開了」「。" }), "Boss said 「。", "only the pair around the copy goes; a mark further on is the head's");
	assert.equal(sentLine({ ...g, sent: "Boss: (電腦重開了) go" }), "Boss: (…) go", "with no quotation marks around it the cut is marked with …");
	assert.equal(sentLine({ ...g, sent: "「電腦重開了」." }), "「電腦重開了」.", "nothing but the copy in quotes: the head's line is whole, not empty");
});

test("HLC-R3-F001: a tower whose reply to the head did not reach it is handled with a note of its own, in both languages, not the note of having answered someone else", () => {
	const net = towers("wA", "wB"), box = new El("div"), el = box as unknown as HTMLElement;
	const rows = [ask({ id: "H1", group: "H1", workspace: "wA", label: "Alpha", state: "handled", missed: true }), ask({ id: "H2", group: "H1", workspace: "wB", label: "Beta", state: "handled" })];
	fillHeadAsks(el, head({ asks: rows }), net, NOW);
	const lines = box.children[0]!.find((x) => x.classes.has("ask-tower"));
	assert.deepEqual(lines.map((l) => textOf(l, "ask-note")), ["its reply did not reach the head", "answered someone else, not the head"]);
	assert.equal(m.head_ask_missed_note({}, zh), "回覆沒送到主塔台");
});

test("a tower that took the message or acted on it is not waiting: `received` and `handled` have words of their own, handled counts as a reply and says it answered someone else, and a tower the net lost keeps what it did", () => {
	const net = towers("wA", "wB", "wC", "wD"), box = new El("div"), el = box as unknown as HTMLElement;
	const rows = [
		ask({ id: "H1", group: "H1", workspace: "wA", label: "Alpha", state: "answered", answers: 1, last: "done" }),
		ask({ id: "H2", group: "H1", workspace: "wB", label: "Beta", state: "handled" }),
		ask({ id: "H3", group: "H1", workspace: "wC", label: "Gamma", state: "received" }),
		ask({ id: "H4", group: "H1", workspace: "wD", label: "Delta", state: "waiting" }),
		ask({ id: "H5", group: "H1", workspace: "wX", label: "Gone", state: "handled" }),
	];
	const g = askGroups(rows, NOW, net).recent[0]!;
	assert.equal(g.handled, 3, "answered and handled count as handled; received is not yet");
	assert.equal(groupLine(g, NOW), "12m ago · 3/5 handled");
	assert.equal(groupLine(g, NOW, zh), "12 分鐘前・已處理 3/5", "an answer is a handling: the count never says 回覆 for what a tower only handled");
	fillHeadAsks(el, head({ asks: rows }), net, NOW);
	const lines = box.children[0]!.find((x) => x.classes.has("ask-tower"));
	assert.deepEqual(lines.map((l) => [l.getAttribute("data-state"), textOf(l, "ask-state"), textOf(l, "ask-note"), textOf(l, "ask-none")]), [
		["answered", "answered", undefined, undefined],
		["handled", "handled", "answered someone else, not the head", undefined],
		["received", "received", undefined, undefined],
		["waiting", "waiting", undefined, undefined],
		["handled", "handled", "answered someone else, not the head", "no tower"],
	]);
	assert.deepEqual([m.head_ask_handled({}, zh), m.head_ask_received({}, zh), m.head_ask_handled_note({}, zh)], ["已處理", "已收到", "回給了別人，沒回報主塔台"]);
	assert.equal(towerState({ workspace: "wA", label: "A", state: "received", route: "x" }, zh), "已收到");
	// the best state of a workspace asked twice
	const twice = askGroups([ask({ id: "H1", group: "H1", state: "waiting" }), ask({ id: "H2", group: "H1", state: "handled" }), ask({ id: "H3", group: "H1", state: "received" })], NOW, net).recent[0]!;
	assert.equal(twice.towers[0]!.state, "handled");
});

/** The chain of the boss's screenshot: H1 corrected by H5, corrected again by H9 (each a broadcast of its own). */
const chain = (over: Partial<Record<string, Partial<HeadAskRow>>> = {}): HeadAskRow[] => [
	ask({ id: "H1", group: "H1", workspace: "wA", label: "MP Center", since: NOW - 40 * 60_000, at: NOW - 40 * 60_000, first: "Boss: 「幫我打個咖啡因吧」. Keep working until 06:00", boss: "幫我打個咖啡因吧", sent: "Boss: 「幫我打個咖啡因吧」. Keep working until 06:00", state: "answered", answers: 1, last: "the order is done", ...over.H1 }),
	ask({ id: "H5", group: "H5", workspace: "wA", label: "MP Center", since: NOW - 20 * 60_000, at: NOW - 20 * 60_000, first: "Boss CORRECTION: 「我說晚上六點」", supersedes: "H1", ...over.H5 }),
	ask({ id: "H9", group: "H9", workspace: "wA", label: "MP Center", since: NOW - 11 * 60_000, at: NOW - 11 * 60_000, first: "Boss CORRECTION 2: 「我沒說要道安全點收尾」", supersedes: "H5", ...over.H9 }),
	ask({ id: "H12", group: "H12", workspace: "wA", label: "MP Center", since: NOW - 5 * 60_000, at: NOW - 5 * 60_000, first: "Another topic", ...over.H12 }),
];

test("a correction replaces the order it names: the groups of one chain are one card, the newest on top with the older ones folded under it, and an unrelated broadcast stays its own", () => {
	const { recent, older } = askGroups(chain(), NOW, towers("wA"));
	assert.deepEqual(recent.map((g) => [g.id, g.replaces.map((r) => r.id), g.supersedes]), [["H12", [], undefined], ["H9", ["H5", "H1"], "H5"]], "H1 and H5 are no cards of their own");
	assert.deepEqual(older, []);
	assert.deepEqual(recent[1]!.replaces.map((r) => r.replaces.length), [0, 0], "folded cards fold nothing themselves");
	// two corrections of one order: the newest replaces it, the other stays a card of its own that says what it replaced
	const two = askGroups([...chain(), ask({ id: "H14", group: "H14", since: NOW - 2 * 60_000, at: NOW - 2 * 60_000, first: "second take", supersedes: "H1" })], NOW, towers("wA")).recent;
	assert.deepEqual(two.map((g) => [g.id, g.replaces.map((r) => r.id)]), [["H14", ["H1"]], ["H12", []], ["H9", ["H5"]]], "an order is folded once, under its newest correction");
	// an order the file no longer holds: the card says what it replaces and folds nothing
	const dangling = askGroups([ask({ id: "H9", group: "H9", supersedes: "H1" })], NOW, undefined).recent[0]!;
	assert.deepEqual([dangling.supersedes, dangling.replaces.length], ["H1", 0]);
	// a chain that loops (bad data) neither hangs nor loses a card
	const loop = askGroups([ask({ id: "H1", group: "H1", supersedes: "H2" }), ask({ id: "H2", group: "H2", supersedes: "H1" })], NOW, undefined);
	assert.equal(loop.recent.length + loop.older.length >= 1, true, "something is shown");
	// the bucket is the newest card's: a replaced order that was active later does not pull the chain out of `older`
	const late = askGroups([ask({ id: "H1", group: "H1", since: NOW - 50 * HOUR, at: NOW - 49 * HOUR }), ask({ id: "H2", group: "H2", supersedes: "H1", since: NOW - 40 * HOUR, at: NOW - 40 * HOUR })], NOW, undefined);
	assert.deepEqual([late.recent.length, late.older.map((g) => [g.id, g.replaces.map((r) => r.id)])], [0, [["H2", ["H1"]]]]);
});

test("the chain on the page: the newest card says what it replaces, the older ones are in one fold under it, struck and saying what replaced them; the fold stays open across a redraw", () => {
	const net = towers("wA"), box = new El("div"), el = box as unknown as HTMLElement;
	fillHeadAsks(el, head({ asks: chain() }), net, NOW);
	const cards = box.children;
	assert.deepEqual(cards.map((c) => c.getAttribute("data-id")), ["H12", "H9"]);
	const top = cards[1]!, topSummary = top.find((x) => x.tag === "summary")[0]!;
	assert.equal(textOf(topSummary, "ask-chain"), "corrects 2 earlier", "the count of orders folded under it, never an id");
	const fold = top.find((x) => x.classes.has("ask-replaced"))[0]!;
	assert.equal(fold.find((x) => x.tag === "summary")[0]!.textContent, "Replaced orders (2)");
	const old = fold.find((x) => x.classes.has("ask-group"));
	assert.deepEqual(old.map((c) => [c.getAttribute("data-id"), c.hasAttribute("data-superseded"), textOf(c.find((x) => x.tag === "summary")[0]!, "ask-chain")]), [["H5", true, "corrected by the next"], ["H1", true, "corrected by the next"]]);
	assert.equal(box.find((x) => x.classes.has("ask-group")).length, 4, "four cards, two on the page and two folded");
	assert.equal(cards[0]!.find((x) => x.classes.has("ask-replaced")).length, 0, "an unrelated card has no fold");
	assert.equal(textOf(cards[0]!.find((x) => x.tag === "summary")[0]!, "ask-chain"), undefined);
	assert.deepEqual([m.head_replaces({ count: 2 }, zh), m.head_replaced_by({}, zh), m.head_replaced_fold({ count: 2 }, zh)], ["更正了前 2 則", "已被下一則更正", "被取代的舊指令（2）"]);
	// the ids are for a tooltip and the card's data, not for the boss to read: no visible text of any card carries an H-id
	assert.doesNotMatch(box.textContent, /H\d+/, "no H-id in what the boss reads");
	assert.equal(top.find((x) => x.classes.has("ask-chain"))[0]!.getAttribute("title"), "H5, H1", "the tooltip names the orders this one corrects, newest first");
	assert.deepEqual(old.map((c) => c.find((x) => x.classes.has("ask-chain"))[0]!.getAttribute("title")), ["H9", "H5"], "and the one that corrected each");
	fold.setAttribute("open", "");
	fold.dispatchEvent({ type: "toggle" });
	fillHeadAsks(el, head({ asks: chain() }), net, NOW + 120_000);
	assert.equal(box.children[1]!.find((x) => x.classes.has("ask-replaced"))[0]!.hasAttribute("open"), true, "a fold the boss opened stays open");
});

test("the sheet: the cards' parts, the fold of replaced orders, and the struck cards are styled; every tap target of the cards is 44 px tall; the text of a part is clamped, and the unfolded texts scroll rather than push the page", async () => {
	const { readFileSync } = await import("node:fs");
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8");
	for (const selector of [".ask-group > summary, .ask-older > summary, .ask-replaced > summary"]) assert.match(css.split("\n").find((l) => l.includes(`${selector} {`)) ?? "", /min-height:\s*44px/, selector);
	assert.match(css, /\.ask-text \{[^}]*-webkit-line-clamp:\s*2/);
	assert.match(css, /\.ask-group\[data-superseded\] \.ask-text \{[^}]*line-through/);
	assert.match(css, /\.ask-full p, \.ask-sent \{[^}]*max-height/);
	// the when line sits under the text column: one length for the tag's width and the foot's indent (a tag is 11 px and the foot 12 px, so `em` could not agree)
	assert.match(css, /\.ask-tag \{[^}]*width:\s*var\(--ask-tag\)/);
	assert.match(css, /\.ask-foot \{[^}]*padding-left:\s*calc\(var\(--ask-tag\) \+ 8px\)/);
	assert.match(css, /\.head-asks \{[^}]*--ask-tag:\s*\d+px/);
});

test("the snapshot sends a tower's copy of the message once: a row without `sent` reads as the first tower's, and a card whose texts were not sent shows each tower's first line", () => {
	const net = towers("wA", "wB", "wC"), box = new El("div"), el = box as unknown as HTMLElement;
	const rows = [
		ask({ id: "H1", group: "H1", workspace: "wA", label: "Alpha", boss: BOSS, sent: "Go on, all of you.\nSecond line", first: "Go on, all of you." }),
		ask({ id: "H2", group: "H1", workspace: "wB", label: "Beta", first: "Go on, all of you." }),
		ask({ id: "H3", group: "H1", workspace: "wC", label: "Gamma", sent: "Gamma only: check the log", first: "Gamma only: check the log" }),
	];
	const g = askGroups(rows, NOW, net).recent[0]!;
	assert.deepEqual(g.towers.map((t) => t.sent === g.sent), [true, true, false], "the omitted copy is the first's");
	fillHeadAsks(el, head({ asks: rows }), net, NOW);
	assert.deepEqual(box.children[0]!.find((x) => x.classes.has("ask-tower")).map((l) => textOf(l, "ask-sent")), [undefined, undefined, "Gamma only: check the log"]);
	// a broadcast past the snapshot's text budget has no texts at all: one line each, no "You said" part
	const cut = [ask({ id: "H5", group: "H5", workspace: "wA", label: "Alpha", first: "Same first line" }), ask({ id: "H6", group: "H5", workspace: "wB", label: "Beta", first: "Same first line" }), ask({ id: "H7", group: "H5", workspace: "wC", label: "Gamma", first: "Other first line" })];
	fillHeadAsks(el, head({ asks: cut }), net, NOW);
	assert.deepEqual(box.children[0]!.find((x) => x.tag === "summary")[0]!.find((x) => x.classes.has("ask-part")).map((x) => x.getAttribute("data-part")), ["sent", "to"]);
	assert.equal(textOf(part(box.children[0]!, "sent"), "ask-text"), "Same first line");
	assert.deepEqual(box.children[0]!.find((x) => x.classes.has("ask-tower")).map((l) => textOf(l, "ask-sent")), [undefined, undefined, "Other first line"]);
});

test("HP-F001: the head's log is one folded line under the conversation (its title with the count, the newest order's line), hidden with no orders, and the fold the boss opened stays across a redraw", () => {
	const net = towers("wA", "wB", "wC"), box = new El("div"), el = box as unknown as HTMLElement;
	const log = new El("details"), summary = new El("summary"), title = new El("b"), line = new El("span");
	summary.append(title, line);
	log.append(summary, box);
	const fill = (h: HeadUnit | undefined, now = NOW) => (fillHeadAsks(el, h, net, now), fillHeadLog(log as unknown as HTMLElement, h, net, now));
	fill(head({ asks: [] }));
	assert.equal(log.hidden, true, "no orders, no log");
	fill(head({ asks: five() }));
	assert.equal(log.hidden, false);
	assert.equal(log.hasAttribute("open"), false, "folded until the boss opens it");
	assert.equal(title.textContent, "Orders sent (5)", "five broadcasts, the ones the head folded under a correction not counted twice");
	assert.equal(line.textContent, "I am up", "the newest order's line, so a closed log still says what went out last");
	fillHeadLog(log as unknown as HTMLElement, head({ asks: five() }), net, NOW, zh);
	assert.equal(title.textContent, "送出的指令（5）");
	fill(head({ asks: five() }), NOW + 60_000);
	log.setAttribute("open", "");
	fill(head({ asks: five() }), NOW + 120_000);
	assert.equal(log.hasAttribute("open"), true, "a redraw leaves the fold as the boss left it");
	fill(undefined);
	assert.equal(log.hidden, true);
});

test("HP-F001: the page gives the room to the conversation: the log is a fold with a cap and a scroll of its own, an unfolded card does not say its texts twice, and the notes box looks at the log's wrapper", async () => {
	const { readFileSync } = await import("node:fs");
	const css = readFileSync(new URL("../gui/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	/** What the stylesheet declares on exactly `selector` (one of a rule's comma-separated selectors), all its rules joined. */
	const declared = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, list]) => list!.split(",").some((x) => x.trim() === selector)).map(([, , body]) => body).join(";");
	assert.match(declared(".head-log[open] > .head-asks"), /max-height:\s*calc\(\(var\(--vvh, 100vh\) - var\(--hud, 64px\) - 64px\) \* 0\.3\)/, "a share of the panel, never more than the conversation can spare");
	assert.match(declared(".head-log[open] > .head-asks"), /overflow-y:\s*auto/);
	assert.match(declared(".head-log > summary"), /min-height:\s*44px/, "a tap target on a phone");
	assert.match(declared(".head-log > summary::after"), /font-size:\s*(1[6-9]|2\d)px/, "R-F006: the fold's marker is drawn large enough to read as a control");
	assert.match(declared(".head-log > summary::after"), /color:\s*var\(--text\)/, "R-F006: and in the text colour, not the dim one");
	assert.match(declared(".ask-group[open] > summary > .ask-part"), /display:\s*none/, "the unfolded card shows its texts in full below, so the clamped copy goes");
	assert.match(css, /:not\(:has\(> \.head-log:not\(\[hidden\]\)\)\)/);
	assert.doesNotMatch(css, /:has\(> \.head-asks:not\(\[hidden\]\)\)/);
	assert.match(readFileSync(new URL("../gui/session.ts", import.meta.url), "utf8"), /<details class="head-log" hidden><summary><b><\/b><span><\/span><\/summary><div class="head-asks" role="group"><\/div><\/details>/);
});
