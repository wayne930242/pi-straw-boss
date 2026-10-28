import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../src/items.ts";
import type { TowerService } from "../src/net.ts";
import { El } from "./chat-dom.ts";

// How the page says the boss conversation (gui/towermodel.ts, towerconv.ts, chat.ts, composer.ts): the state word that is not "working" while the boss is the one being waited for, the line with how it began and
// when it ends, Leave and New, the chips of the event runs, the divider that opens each run in the log, and a composer that does not ask to confirm `/quit` in a tower. In both languages.

const { mountChat } = await import("../gui/chat.ts");
const { fillConversation } = await import("../gui/towerconv.ts");
const { conversationDivider, conversationFacts, conversationWord, statusLine, towerWord } = await import("../gui/towermodel.ts");
const { endsSession } = await import("../gui/composer.ts");
const { m } = await import("../gui/paraglide/messages.js");

const word = (mk: string) => mk;
const zh = { locale: "zh-TW" } as const;
const conv = (over: Partial<NonNullable<TowerService["conversation"]>> = {}): NonNullable<TowerService["conversation"]> => ({ since: "2026-10-28T10:00:00Z", resumed: true, turns: 14, idle: false, idleMs: 600_000, capAt: Date.parse("2026-10-28T14:00:00Z"), ...over });
const svc = (over: Partial<TowerService> = {}): TowerService => ({ state: "running", queued: 0, run: { id: "r1", kind: "local", startedAt: "2026-10-28T10:00:00Z" }, allyRuns: [], notices: [], parked: [], conversation: conv(), ...over });

test("the conversation's state word says whose it is and when it ends; waiting for the boss is not working; closing says so; a question it waits on is the news; zh-TW has its own", () => {
	assert.equal(towerWord(svc(), "working", word), "boss conversation · ends after 10 min idle");
	assert.equal(statusLine(svc(), "working", word), "boss conversation · ends after 10 min idle", "the map, the header, and the dossier say it through this line");
	assert.equal(towerWord(svc({ conversation: conv({ idle: true }) }), "idle", word), "boss conversation · waiting for you · ends after 10 min idle");
	assert.equal(towerWord(svc({ state: "closing", conversation: conv({ closing: true }) }), "working", word), "closing", "the service's own closing state comes first");
	assert.equal(conversationWord(conv({ closing: true })), "boss conversation · closing");
	assert.equal(towerWord(svc(), "waiting", word), "waiting", "a question to the boss is what the page says");
	assert.equal(towerWord(svc({ conversation: undefined }), "working", word), "working", "an event run is just working");
	assert.equal(towerWord(svc(), "working", word, zh), "老闆對話・閒置 10 分鐘後結束");
	assert.equal(conversationWord(conv({ idle: true }), zh), "老闆對話・等你說話・閒置 10 分鐘後結束");
	assert.equal(conversationWord(conv({ closing: true }), zh), "老闆對話・收尾中");
	assert.equal(conversationWord(conv({ idleMs: 90_000 })), "boss conversation · ends after 2 min idle", "a short wait still names a whole minute");
});

test("the facts: how it began (resumed with turns, or new with the server's reason kept as the tooltip), what it does now with the deadline, and the hard cap", () => {
	const resumed = conversationFacts(conv());
	assert.equal(resumed.began, "resumed session · boss turns: 14");
	assert.equal(resumed.now, "working; it ends after 10 min idle");
	assert.match(resumed.cap, /^hard cap \d\d:\d\d$/);
	assert.equal(resumed.why, undefined);
	const fresh = conversationFacts(conv({ resumed: false, why: "the boss asked for a new one (/new)", turns: 0, idle: true, idleAt: Date.parse("2026-10-28T10:20:00Z") }));
	assert.equal(fresh.began, "new session · the boss asked for a new one (/new)");
	assert.equal(fresh.why, "the boss asked for a new one (/new)");
	assert.match(fresh.now, /^waiting for you; it ends at \d\d:\d\d if you stay quiet$/);
	assert.equal(conversationFacts(conv({ closing: true })).now, "closing");
	assert.equal(conversationFacts(conv({ resumed: false, turns: 0 })).began, "new session");
	assert.equal(conversationFacts(conv(), zh).began, "接續舊工作階段・老闆輪數 14");
	assert.match(conversationFacts(conv(), zh).cap, /^上限 \d\d:\d\d$/);
});

test("the boss in an event run: the box says so in place of the conversation row, with no Leave or New", () => {
	const el = box(svc({ conversation: undefined, bossIn: { id: "e3", since: "2026-10-28T10:05:00Z" }, run: { id: "e3", kind: "local", startedAt: "2026-10-28T10:00:00Z" } }));
	assert.equal(el.hidden, false);
	assert.match(el.textContent, /^You are in event run e3 · started \d\d:\d\d/);
	assert.doesNotMatch(el.textContent, /Boss conversation/);
	assert.deepEqual(buttons(el), []);
});

test("a run's divider: resumed or new with its start, and how it ended with its note once it has", () => {
	const run = { id: "c1", kind: "conversation" as const, resumed: true, startedAt: "2026-10-28T10:00:00Z" };
	assert.match(conversationDivider(run).title, /^Boss conversation · resumed · \d\d:\d\d$/);
	assert.equal(conversationDivider(run).ended, undefined, "a live run has not ended");
	assert.match(conversationDivider({ ...run, resumed: false }).title, /^Boss conversation · new session · /);
	assert.match(conversationDivider({ ...run, endedAt: "2026-10-28T10:30:00Z", note: "(boss quit)" }).ended!, /^ended \d\d:\d\d · \(boss quit\)$/);
	assert.match(conversationDivider({ ...run, endedAt: "2026-10-28T10:30:00Z" }, zh).ended!, /^\d\d:\d\d 結束$/);
	assert.match(conversationDivider(run, zh).title, /^老闆對話・接續・/);
});

const box = (service: TowerService | undefined) => {
	const el = new El("div");
	fillConversation(el as unknown as HTMLElement, "wA", service);
	return el;
};
const buttons = (el: El) => el.find((x) => x.tag === "button").map((b) => b.textContent);

test("the conversation box: hidden with no conversation and no event runs; Leave and New while it lasts; New alone when it is closing; chips for event runs that link when their session is known", () => {
	assert.equal(box(undefined).hidden, true);
	assert.equal(box(svc({ conversation: undefined, state: "standing", run: undefined })).hidden, true);
	const live = box(svc());
	assert.equal(live.hidden, false);
	assert.deepEqual(buttons(live), [m.conv_leave(), m.conv_new_button()]);
	assert.match(live.textContent, /Boss conversation resumed session · boss turns: 14 · working; it ends after 10 min idle · hard cap \d\d:\d\d/);
	assert.deepEqual(buttons(box(svc({ conversation: conv({ closing: true }) }))), [m.conv_new_button()], "a closing conversation cannot be left again");
	const runs = [
		{ id: "e1", kind: "event" as const, startedAt: "2026-10-28T09:00:00Z", outcome: "done", note: "routed it", key: "run-e1" },
		{ id: "e2", kind: "event" as const, startedAt: "2026-10-28T09:10:00Z", outcome: "crashed" },
		{ id: "c1", kind: "conversation" as const, resumed: true, startedAt: "2026-10-28T08:00:00Z" },
	];
	const standing = box(svc({ conversation: undefined, state: "standing", run: undefined, localRuns: runs }));
	assert.equal(standing.hidden, false);
	assert.deepEqual(buttons(standing), [], "no conversation, nothing to leave or restart here");
	const chips = standing.find((x) => x.classes.has("ally-chip"));
	assert.equal(chips.length, 2, "only the event runs are chips; a conversation's run is in the log");
	assert.equal(chips[0]!.tag, "a");
	assert.equal(chips[0]!.attrs.get("title"), "done: routed it");
	assert.match(chips[0]!.attrs.get("data-route") ?? "", /run-e1/);
	assert.equal(chips[1]!.tag, "span", "a run whose session is not known yet is not a link");
});

test("the log: a divider opens each conversation run before the first entry written since, a live run's divider waits at the end, and one that began before the mounted part of the log is left out", () => {
	const root = new El("div"), data = { older: async () => ({ items: [] }), latest: async () => ({ items: [] }), entry: async () => undefined };
	const chat = mountChat(root as unknown as HTMLElement, data, { who: () => ({ key: "t1", name: "tower", role: "tower", mark: "idle" as const, service: svc() }), link: () => undefined });
	const items: Item[] = [10, 20, 30, 40].map((min, i) => ({ id: `u${i}`, kind: "user", text: `talk ${i}`, at: `2026-10-28T10:${min}:00Z` }));
	chat.apply({ key: "t1", reset: true, items });
	assert.match(root.find((el) => el.classList.contains("conv-rule") === false && el.tag === "b").length ? "" : "", /^$/);
	const rows = [
		{ id: "c1", kind: "conversation" as const, resumed: false, why: "no earlier boss session", startedAt: "2026-10-28T10:05:00Z", endedAt: "2026-10-28T10:25:00Z", outcome: "done", note: "(boss quit)" },
		{ id: "c2", kind: "conversation" as const, resumed: true, startedAt: "2026-10-28T10:35:00Z" },
		{ id: "c3", kind: "conversation" as const, resumed: true, startedAt: "2026-10-28T11:00:00Z" },
	];
	chat.runs(rows);
	const list = root.find((el) => el.attrs.get("class") === "chat-list")[0]!;
	const order = () => list.kids.map((k) => (typeof k === "string" ? k : k.classes.has("conv-rule") ? `rule:${k.textContent.slice(0, 40)}` : k.find((x) => x.tag === "div" && x.classes.has("bubble"))[0]?.textContent ?? "?"));
	const shown = order();
	assert.equal(shown.length, 7);
	assert.match(shown[0]!, /^rule:Boss conversation · new session · \d\d:\d\d/, "the first run began before the first entry");
	assert.deepEqual(shown.slice(1, 4), ["talk 0", "talk 1", "talk 2"]);
	assert.match(shown[4]!, /^rule:Boss conversation · resumed/);
	assert.equal(shown[5], "talk 3");
	assert.match(shown[6]!, /^rule:Boss conversation · resumed/, "no entry since the third run began: its divider waits at the end");
	// New talk lands after the waiting divider, and a redraw with the same rows moves nothing.
	chat.apply({ key: "t1", reset: false, items: [{ id: "u4", kind: "user", text: "talk 4", at: "2026-10-28T11:01:00Z" }] });
	chat.runs(rows);
	assert.deepEqual(order().slice(-2).map((x) => x.slice(0, 6)), ["rule:B", "talk 4"]);
	// The run that ended gets its end shown without a second divider.
	chat.runs([{ ...rows[0]!, endedAt: "2026-10-28T10:26:00Z" }, ...rows.slice(1)]);
	assert.equal(order().filter((x) => x.startsWith("rule:")).length, 3);
});

test("a tower's composer asks nothing before /quit or /new (they leave and start over); any other composer asks as before", () => {
	assert.equal(endsSession("/quit", { wakes: true }), undefined);
	assert.equal(endsSession(" /new now", { wakes: true }), undefined);
	assert.equal(endsSession("/quit", { wakes: false }), "/quit");
	assert.equal(endsSession("/new", {}), "/new");
	assert.equal(endsSession("hello", { wakes: false }), undefined);
});
