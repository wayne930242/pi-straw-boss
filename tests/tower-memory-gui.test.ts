import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { MemorySummary, TowerService } from "../src/net.ts";
import { El } from "./chat-dom.ts";

// The tower's memory in its comms (gui/towermemory.ts, gui/towermodel.ts): the closed line from the snapshot's summary, the panel read when it opens, the boss's adds, edits, deletes and resolves each
// naming the rev they read, a memory that moved on shown again, a wait for the boss as a notice with an Answer link, and every text set as text.

const { fillMemory } = await import("../gui/towermemory.ts");
const { fillNotices } = await import("../gui/towernotes.ts");
const { memoryChip, memoryGroups, memoryMeta, memoryWhy, noticeRows } = await import("../gui/towermodel.ts");
const { m } = await import("../gui/paraglide/messages.js");

interface Sent { path: string; body: Record<string, unknown>; csrf: string }
type Entry = { id: string; kind: string; text: string; by: string; via: string; at: string; for?: string; on?: string; state?: string; outcome?: string };
let memory: { rev: number; entries: Entry[]; notices: { id: string; text: string; at: string }[] };
let sent: Sent[];
let lag: "rev" | undefined;
const entry = (id: string, kind: string, text: string, over: Partial<Entry> = {}): Entry => ({ id, kind, text, by: "boss", via: "gui", at: "2026-10-28T10:00:00Z", ...over });
const answer = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => structuredClone(body) });
Object.assign(globalThis.document, { querySelector: () => ({ content: "CSRF" }) });
Object.assign(globalThis, {
	fetch: async (path: string, init: { body: string; headers: Record<string, string> }) => {
		const body = JSON.parse(init.body) as Record<string, unknown>;
		sent.push({ path, body, csrf: init.headers["x-sb-csrf"]! });
		if (body.op === "read") return answer(200, memory);
		if (lag === "rev" || body.rev !== memory.rev) return answer(409, { error: "rev", reason: "The memory changed since you read it", ...memory });
		if (body.op === "add") memory.entries.push(entry(`${body.kind === "standing" ? "S" : "D"}${memory.entries.length + 1}`, String(body.kind), String(body.text).trim()));
		if (body.op === "delete") memory.entries = memory.entries.filter((e) => e.id !== body.id);
		if (body.op === "edit") memory.entries = memory.entries.map((e) => (e.id === body.id ? { ...e, text: String(body.text) } : e));
		if (body.op === "resolve") memory.entries = memory.entries.map((e) => (e.id === body.id ? { ...e, state: "resolved", outcome: String(body.outcome ?? "") } : e));
		if (body.op === "ack") memory.notices = [];
		memory.rev++;
		return answer(200, memory);
	},
});
afterEach(() => void (sent = []));
const reset = () => ((sent = []), (lag = undefined), (memory = { rev: 3, entries: [entry("S1", "standing", "部署發版都授權"), entry("D1", "decision", "ws01 先上 beta.67"), entry("D2", "decision", "正式區等週一", { by: "run" }), entry("W1", "wait", "api-fix asks: deploy?", { by: "run", via: "run", for: "boss", state: "open" })], notices: [] }));
const summary = (over: Partial<MemorySummary> = {}): MemorySummary => ({ rev: 3, standing: 1, decisions: 2, waits: 1, bossWaits: [], notices: [], ...over });
const settle = () => new Promise((done) => setTimeout(done, 5));
const open = async (box: El) => {
	const details = box.find((el) => el.tag === "details")[0]!;
	(details as unknown as { open: boolean }).open = true;
	(details.listeners.get("toggle") as () => void)();
	await settle();
	return details;
};
const draw = (box: El, s?: MemorySummary) => fillMemory(box as unknown as HTMLElement, "wA", s);
const texts = (box: El, cls: string) => box.find((el) => el.attrs.get("class") === cls).map((e) => e.textContent);
const click = (box: El, label: string) => (box.find((el) => el.tag === "button" && el.textContent === label)[0] as unknown as { onclick(): void }).onclick();

test("the closed panel is one line of counts from the snapshot's summary, nothing is read yet, and a tower without memory hides it", () => {
	reset();
	const box = new El("div");
	draw(box, summary());
	assert.equal(box.hidden, false);
	assert.equal(box.find((el) => el.attrs.get("class") === "tmem-counts")[0]!.textContent, m.memory_counts({ standing: 1, decisions: 2, waits: 1 }));
	assert.equal(sent.length, 0);
	draw(box, undefined);
	assert.equal(box.hidden, true);
});

test("opening reads the memory: standing in the order kept, decisions newest first, waits; the caps beside the lists; each text only text; a run's entry says it is the boss's words kept by a run", async () => {
	reset();
	memory.entries.push(entry("S2", "standing", "<img src=x onerror=alert(1)>"));
	const box = new El("div");
	draw(box, summary());
	await open(box);
	assert.deepEqual(sent.map((s) => [s.path, s.body, s.csrf]), [["api/tower/wA/memory", { op: "read" }, "CSRF"]]);
	assert.deepEqual(texts(box, "tmem-text"), ["部署發版都授權", "<img src=x onerror=alert(1)>", "正式區等週一", "ws01 先上 beta.67", "api-fix asks: deploy?"]);
	assert.equal(box.find((el) => el.tag === "img").length, 0, "no markup from a text");
	assert.deepEqual(box.find((el) => el.tag === "h4").map((h) => h.textContent), [`${m.memory_standing()}2/12`, `${m.memory_decisions()}2/24`, m.memory_waits()]);
	const meta = box.find((el) => el.tag === "small" && el.kids.length === 1 && /·|your|你/.test(el.textContent)).map((e) => e.textContent);
	assert.ok(meta.includes(m.memory_by_run()), "the quote a run kept is marked");
});

test("a change names the rev the panel read and the panel shows what the server answered", async () => {
	reset();
	const box = new El("div");
	draw(box, summary());
	await open(box);
	const input = box.find((el) => el.tag === "input")[0] as unknown as { value: string };
	input.value = "  新的常駐指示  ";
	click(box, m.memory_add());
	await settle();
	assert.deepEqual(sent.at(-1)!.body, { op: "add", kind: "standing", text: "  新的常駐指示  ", rev: 3 });
	assert.ok(texts(box, "tmem-text").includes("新的常駐指示"));
	click(box, m.memory_delete());
	await settle();
	assert.deepEqual([sent.at(-1)!.body.op, sent.at(-1)!.body.id, sent.at(-1)!.body.rev], ["delete", "S1", 4]);
	click(box, m.memory_resolve());
	await settle();
	assert.equal(sent.at(-1)!.body.op, "resolve");
	assert.ok(box.find((el) => el.attrs.get("class") === "tmem-ended").length >= 1, "a resolved wait is struck through");
});

test("an edit swaps the row for an input and saves it with the rev; Cancel puts the row back with nothing sent", async () => {
	reset();
	const box = new El("div");
	draw(box, summary());
	await open(box);
	click(box, m.memory_edit());
	const input = box.find((el) => el.tag === "input" && (el as unknown as { value: string }).value === "部署發版都授權")[0] as unknown as { value: string };
	assert.ok(input, "the row is an input holding the text");
	click(box, m.memory_cancel());
	assert.equal(sent.filter((s) => s.body.op === "edit").length, 0);
	click(box, m.memory_edit());
	const again = box.find((el) => el.tag === "input" && (el as unknown as { value: string }).value === "部署發版都授權")[0] as unknown as { value: string };
	again.value = "部署發版都授權（週一除外）";
	click(box, m.memory_save());
	await settle();
	assert.deepEqual(sent.at(-1)!.body, { op: "edit", id: "S1", text: "部署發版都授權（週一除外）", rev: 3 });
});

test("a memory that moved on is shown again with the page's sentence, and the next change uses the new rev", async () => {
	reset();
	const box = new El("div");
	draw(box, summary());
	await open(box);
	memory.rev = 9;
	memory.entries.push(entry("S2", "standing", "someone else added this"));
	const input = box.find((el) => el.tag === "input")[0] as unknown as { value: string };
	input.value = "mine";
	click(box, m.memory_add());
	await settle();
	assert.equal(box.find((el) => el.tag === "small" && el.attrs.get("class") === "tnote-fail")[0]!.textContent, m.memory_failed({ reason: m.memory_rev() }));
	assert.ok(texts(box, "tmem-text").includes("someone else added this"));
	click(box, m.memory_delete());
	await settle();
	assert.equal(sent.at(-1)!.body.rev, 9);
});

test("while it is open the panel reads again only when the snapshot's rev moved", async () => {
	reset();
	const box = new El("div");
	draw(box, summary());
	await open(box);
	draw(box, summary());
	await settle();
	assert.equal(sent.length, 1);
	memory.rev = 4;
	memory.entries.push(entry("D3", "decision", "from the terminal"));
	draw(box, summary({ rev: 4, decisions: 3 }));
	await settle();
	assert.equal(sent.length, 2);
	assert.ok(texts(box, "tmem-text").includes("from the terminal"));
});

test("a dropped decision's notice shows with a button that dismisses it", async () => {
	reset();
	memory.notices = [{ id: "D1", text: "Decision D1 was dropped to keep 24: old", at: "2026-10-28T10:00:00Z" }];
	const box = new El("div");
	draw(box, summary({ notices: ["Decision D1 was dropped to keep 24: old"] }));
	await open(box);
	assert.ok(box.find((el) => el.attrs.get("class") === "tmem-note")[0]!.textContent.includes("Decision D1 was dropped"));
	click(box, m.memory_ack());
	await settle();
	assert.deepEqual(sent.at(-1)!.body, { op: "ack", rev: 3 });
	assert.equal(box.find((el) => el.attrs.get("class") === "tmem-note").length, 0);
});

test("a wait for the boss is a notice on the tower card with an Answer link to the comms; waits for agents are not", () => {
	const service: TowerService = { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: summary({ bossWaits: [{ id: "W1", text: "api-fix asks: deploy ws01?", at: "t" }] }) };
	assert.deepEqual(noticeRows(service).map((r) => [r.id, r.text, r.actions]), [["wait-W1", m.tower_waits_for_you({ text: "api-fix asks: deploy ws01?" }), ["answer"]]]);
	assert.equal(noticeRows({ ...service, memory: summary() }).length, 0);
	assert.equal(noticeRows({ ...service, memory: undefined }).length, 0);
	const box = new El("div");
	fillNotices(box as unknown as HTMLElement, "wA", service, "sb-tower-wa");
	const link = box.find((el) => el.tag === "a")[0]!;
	assert.equal(link.attrs.get("data-route"), "w/wA/s/sb-tower-wa");
	assert.equal(link.textContent, m.tower_answer());
	assert.equal(noticeRows(service, { locale: "zh-TW" })[0]!.text, "等你決定：api-fix asks: deploy ws01?");
});

test("the model: groups, the chip, the words for where an entry came from, and the reasons for a refusal in both languages", () => {
	const groups = memoryGroups([entry("S1", "standing", "a") as never, entry("D1", "decision", "b") as never, entry("D2", "decision", "c") as never, entry("W1", "wait", "d", { state: "resolved" }) as never, entry("W2", "wait", "e", { state: "open" }) as never]);
	assert.deepEqual([groups.standing.length, groups.decisions.map((e) => e.id), groups.waits.map((e) => e.id)], [1, ["D2", "D1"], ["W2", "W1"]]);
	assert.equal(memoryChip(summary(), { locale: "zh-TW" }), "1 常駐指示・2 決定・1 等待");
	assert.equal(memoryMeta(entry("S1", "standing", "a") as never), "your words");
	assert.equal(memoryMeta(entry("D1", "decision", "a", { by: "run" }) as never, { locale: "zh-TW" }), "run 引述你的原話保存");
	assert.match(memoryMeta(entry("W1", "wait", "a", { for: "agent", on: "docs-main", state: "answered" }) as never), /the tower's note · waits for docs-main · answered\? a message came from docs-main/);
	assert.equal(memoryWhy({ status: 409, body: { error: "rev", reason: "x" } }), m.memory_rev());
	assert.equal(memoryWhy({ status: 409, body: { error: "refused", reason: "12 standing instructions are kept already" } }), "12 standing instructions are kept already");
});
