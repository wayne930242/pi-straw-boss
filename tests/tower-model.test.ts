import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { TowerService } from "../src/net.ts";
import type { Mark } from "../src/netdata.ts";
import { actionWhy, guarded, lastLine, noticeRows, queueChip, statusLine, towerWord } from "../gui/towermodel.ts";
import { bossTurn, heard, termHold, towerWhy } from "../gui/towerturns.ts";
import { alertLine } from "../gui/linkmodel.ts";
import { m } from "../gui/paraglide/messages.js";

// How the page reads the sb server's tower service (gui/towermodel.ts): one word per state on the map, the dossier and the comms, the queue and the last run, the notices in the page's
// language, the intercom turns of a run, and the buttons that answer. No DOM here.

const svc = (over: Partial<TowerService> = {}): TowerService => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], ...over });
const word = (mk: Mark) => ({ commanding: "commanding", working: "working", waiting: "waiting", idle: "idle", done: "done", error: "error", unknown: "unknown" })[mk];
const zh = { locale: "zh-TW" } as const;

test("every state of the service has its own word, and a tower with no service keeps the mark's", () => {
	assert.equal(towerWord(undefined, "idle", word), "idle", "a resident tower is idle");
	assert.equal(towerWord(svc(), "idle", word), "standing by");
	assert.equal(towerWord(svc({ state: "waking" }), "idle", word), "waking");
	assert.equal(towerWord(svc({ state: "closing" }), "idle", word), "closing");
	assert.equal(towerWord(svc({ state: "held" }), "idle", word), "held");
	assert.equal(towerWord(svc({ state: "running", run: { id: "r", kind: "local", startedAt: "t" } }), "working", word), "working");
	assert.equal(towerWord(svc({ state: "running", run: { id: "r", kind: "local", startedAt: "t" } }), "waiting", word), "waiting", "a run that waits on a question is waiting");
	assert.equal(towerWord(svc({ state: "running", run: { id: "r", kind: "ally", startedAt: "t" } }), "working", word), "ally run");
	assert.equal(towerWord(svc(), "commanding", word), "commanding", "subagents at work under a standing tower");
	const all = ["standing", "waking", "closing", "held"].map((state) => towerWord(svc({ state: state as TowerService["state"] }), "idle", word));
	assert.equal(new Set(all).size, all.length, "no two states read alike");
});

test("the state in Chinese: the same words everywhere the page names it", () => {
	assert.equal(towerWord(svc({ state: "held" }), "idle", word, zh), "已暫停");
	assert.equal(towerWord(svc(), "idle", word, zh), "待命");
});

test("the last run and the recent failures read as a line; a run that is live has none", () => {
	assert.equal(lastLine(svc()), undefined);
	assert.equal(lastLine(svc({ lastRun: { endedAt: "t", outcome: "done" } })), undefined, "a run that finished well says nothing");
	assert.equal(lastLine(svc({ lastRun: { endedAt: "t", outcome: "crashed" } })), "last run crashed");
	assert.equal(lastLine(svc({ lastRun: { endedAt: "t", outcome: "timeout" } })), "last run timed out");
	assert.equal(lastLine(svc({ lastRun: { endedAt: "t", outcome: "quit" } })), "last run quit");
	assert.equal(lastLine(svc({ lastRun: { endedAt: "t", outcome: "crashed" }, crashes: 1 })), "last run crashed · 1 failed run lately");
	assert.equal(lastLine(svc({ lastRun: { endedAt: "t", outcome: "timeout" }, crashes: 2 })), "last run timed out · 2 failed runs lately");
	assert.equal(lastLine(svc({ lastRun: { endedAt: "t", outcome: "crashed" }, crashes: 2 }), zh), "上一次 run 當機 · 近來有 2 次 run 失敗");
	assert.equal(lastLine(svc({ state: "running", run: { id: "r", kind: "local", startedAt: "t" }, lastRun: { endedAt: "t", outcome: "crashed" } })), undefined, "the run under way is the news");
	assert.equal(statusLine(svc({ lastRun: { endedAt: "t", outcome: "crashed" } }), "idle", word), "standing by · last run crashed");
	assert.equal(statusLine(svc(), "idle", word), "standing by");
});

test("the queue is a count with its plural, and nothing when empty", () => {
	assert.equal(queueChip(svc()), undefined);
	assert.equal(queueChip(svc({ queued: 1 })), "1 message queued");
	assert.equal(queueChip(svc({ queued: 3 })), "3 messages queued");
	assert.equal(queueChip(svc({ queued: 3 }), zh), "3 則排隊中");
	assert.equal(queueChip(undefined), undefined);
});

test("the notices of the service are the page's own words; a parked event has its two buttons; a crash loop its Retry", () => {
	const rows = noticeRows(svc({
		notices: [
			{ id: "loop", level: "error", kind: "loop", text: "3 runs crashed or timed out in 10 minutes, so the tower stops waking.", at: 1 },
			{ id: "settings", level: "error", kind: "settings", text: "A run could not start: pi settings in /a/b/.pi/settings.json refused: untrusted", at: 2 },
			{ id: "start-r9", level: "warning", kind: "start", text: "A run could not start: no such pane", at: 3 },
			{ id: "parked-e1", level: "warning", kind: "late", text: "An event was parked after two runs crashed with it: intercom docs-main", at: 4 },
			{ id: "x", level: "info", kind: "other", text: "kept as the server wrote it", at: 5 },
		],
		parked: [{ id: "e1", kind: "intercom", from: "docs-main", first: "roll it back" }, { id: "e2", kind: "boss", first: "x" }],
	}));
	assert.deepEqual(rows.map((r) => r.id), ["loop", "settings", "start-r9", "x", "parked-e1", "parked-e2"], "the parked notice is not shown twice");
	assert.match(rows[0]!.text, /^Runs crashed or timed out again and again/);
	assert.deepEqual(rows[0]!.actions, ["retry"]);
	assert.equal(rows[1]!.text, "A run could not start: pi settings in /a/b/.pi/settings.json refused: untrusted");
	assert.equal(rows[3]!.text, "kept as the server wrote it");
	assert.equal(rows[4]!.text, "Parked: intercom from docs-main: roll it back");
	assert.equal(rows[5]!.text, "Parked: boss: x", "no sender, no 'from ?'");
	assert.deepEqual(rows[5]!.actions, ["deliver", "drop"]);
	assert.equal(rows[5]!.event, "e2");
	const zhRows = noticeRows(svc({ notices: [{ id: "loop", level: "error", kind: "loop", text: "…", at: 1 }, { id: "s", level: "error", kind: "settings", text: "A run could not start: boom", at: 2 }], parked: [{ id: "e1", kind: "boss", first: "x" }] }), zh);
	assert.match(zhRows[0]!.text, /^run 一再當機或逾時/);
	assert.equal(zhRows[1]!.text, "run 無法啟動：boom");
	assert.equal(zhRows[2]!.text, "已擱置：boss：x");
});

test("the boss's turn in a service tower drops the server's marker line and shows the crash flag as a note", () => {
	assert.deepEqual(bossTurn("[the boss writes to you from the GUI or /boss tower; this is an instruction]\nship it"), { body: "ship it", crashed: false });
	assert.deepEqual(bossTurn("[the boss writes to you from the GUI or /boss tower; this is an instruction]\n[possibly handled by a run that crashed: check before acting]\nship\nit"), { body: "ship\nit", crashed: true });
	assert.equal(bossTurn("[the boss writes to you from the GUI or /boss tower; this is an instruction] x\nhi"), undefined);
	assert.equal(bossTurn("hi\n[the boss writes to you from the GUI or /boss tower; this is an instruction]"), undefined);
	assert.equal(bossTurn(undefined), undefined);
});

test("a run's turn that the server wrote is not the boss's: intercom, server notices and wake-up calls are recognized by their first line, the boss's own are not", () => {
	assert.deepEqual(heard("[intercom from docs-main (m1)]\nplease look"), { kind: "intercom", from: "docs-main (m1)" });
	assert.deepEqual(heard("[intercom from an unknown sender]\nhi"), { kind: "intercom", from: "an unknown sender" });
	assert.deepEqual(heard("[intercom from docs-main (m1)]\n[possibly handled by a run that crashed: check before acting]\nhi"), { kind: "intercom", from: "docs-main (m1)" });
	assert.deepEqual(heard("[notice from the sb server]\nthe send failed"), { kind: "server" });
	assert.deepEqual(heard("[your wakeAfter follow-up is due]\nlook again"), { kind: "timer" });
	assert.equal(heard("[the boss writes to you from the GUI or /boss tower; this is an instruction]\nship it"), undefined);
	assert.equal(heard("hello [intercom from x] there"), undefined, "only the first line counts");
	assert.equal(heard("[intercom from x\ny]"), undefined);
	assert.equal(heard(undefined), undefined);
});

test("what the server refuses is said in the page's language by its code, or by the reasons it is known to give; any other keeps the server's own", () => {
	assert.match(towerWhy({ status: 409, body: { error: "standing", reason: "The tower is standing by: …" } })!, /^The tower is standing by/);
	assert.match(towerWhy({ status: 409, body: { error: "server_queue", reason: "x" } })!, /wait in the sb server's queue/);
	assert.equal(towerWhy({ status: 409, body: { error: "refused", reason: "No such parked event" } }), "No such parked event.");
	assert.equal(towerWhy({ status: 409, body: { error: "refused", reason: "The sb server stands in for no tower of workspace wA" } }), "The sb server runs no tower for this workspace.");
	assert.equal(towerWhy({ status: 409, body: { error: "refused", reason: "No such parked event" } }, zh), "沒有這則已擱置的事件。");
	assert.equal(towerWhy({ status: 409, body: { error: "refused", reason: "something new" } }), undefined);
	assert.equal(towerWhy({ status: 500, body: {} }), undefined);
	// The map's buttons know only the reasons the service gives; the codes of a send are the session view's.
	assert.equal(actionWhy({ status: 409, body: { error: "refused", reason: "No such parked event" } }), "No such parked event.");
	assert.equal(actionWhy({ status: 409, body: { error: "standing", reason: "x" } }), undefined);
});

test("the terminal of a tower with no live run is a sentence, not a pad over an empty box", () => {
	assert.equal(termHold(undefined), undefined, "a resident tower has its terminal");
	assert.equal(termHold(svc({ state: "running", run: { id: "r", kind: "local", startedAt: "t" } })), undefined);
	assert.match(termHold(svc())!, /standing by, so it has no terminal/);
	assert.match(termHold(svc({ state: "waking" }))!, /standing by/);
	assert.match(termHold(svc({ state: "held" }))!, /held after repeated crashes/);
	assert.match(termHold(svc(), zh)!, /待命/);
});

test("a button that asks the server is off and says so while it waits, and comes back with the reason when refused", async () => {
	const button = { disabled: false, textContent: "Retry" };
	const notes: (string | undefined)[] = [], note = (text?: string) => void notes.push(text);
	let answer!: (a: { ok: boolean; status: number; body: { error?: string; reason?: string } }) => void;
	const flight = guarded(button, note, () => new Promise((resolve) => (answer = resolve)));
	assert.equal(button.disabled, true);
	assert.equal(button.textContent, "Working…");
	assert.deepEqual(notes, [undefined], "an old refusal is cleared at the start");
	answer({ ok: false, status: 409, body: { error: "refused", reason: "No such parked event" } });
	await flight;
	assert.equal(button.disabled, false);
	assert.equal(button.textContent, "Retry");
	assert.deepEqual(notes, [undefined, "The tower refused it: No such parked event."]);
	const ok = guarded(button, note, async () => ({ ok: true, status: 200, body: {} }), 0);
	await ok;
	assert.equal(button.disabled, false, "it comes back so a row that stays can be pressed again");
	assert.equal(notes.length, 3);
	assert.equal(notes[2], undefined);
	const lost = guarded(button, note, async () => { throw new Error("network"); });
	await lost;
	assert.equal(button.disabled, false);
	assert.match(String(notes.at(-1)), /The tower refused it/);
});

test("Straw Link notices agree with their number", () => {
	const note = (kind: "inbox" | "held" | "served", count: number) => alertLine({ id: "a", kind, level: "info", team: "t", teamName: "Moldplan", data: { count } } as never);
	assert.match(note("served", 1), /^1 Straw Link message waits in the inbox/);
	assert.match(note("served", 2), /^2 Straw Link messages wait in the inbox/);
	assert.match(note("inbox", 1), /^1 message waits in the inbox/);
	assert.match(note("inbox", 3), /^3 messages wait in the inbox/);
	assert.match(note("held", 1), /^1 message has waited/);
	assert.match(note("held", 4), /^4 messages have waited/);
	assert.match(m.link_a_served({ count: 2, team: "T" }, zh), /^團隊 T 的收件匣有 2 則/);
});

// The stylesheet, where a fix is a rule: no test browser here, so the rules are read as text.
const css = readFileSync(fileURLToPath(new URL("../gui/style.css", import.meta.url)), "utf8");
const rule = (selector: string) => [...css.matchAll(/(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g)].filter((x) => x[2]!.split(",").some((s) => s.trim() === selector)).map((x) => x[3]).join(" ");
const luminance = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => ((x, y) => (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05))(luminance(a), luminance(b));
const token = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)![1]!;

test("a long unbroken text in a notice wraps inside its card", () => {
	const span = rule(".tower-notices .tnote span");
	assert.match(span, /min-width:\s*0/);
	assert.match(span, /overflow-wrap:\s*anywhere/);
	assert.match(rule(".tower-notices .tnote"), /min-width:\s*0/);
	assert.match(rule(".base > .tower-notices"), /min-width:\s*0/);
});

test("notice colours read at AA (4.5:1) on the card's panel and on the page", () => {
	const color = (selector: string) => {
		const v = /color:\s*var\((--[\w-]+)(?:,\s*#[0-9a-fA-F]{6})?\)/.exec(rule(selector));
		assert.ok(v, `${selector} takes a palette colour`);
		return token(v![1]!);
	};
	for (const level of ["error", "warning"]) {
		const fg = color(`.tower-notices .tnote.${level} span`);
		for (const bg of ["--surface-1", "--surface-0", "--bg"]) assert.ok(contrast(fg, token(bg)) >= 4.5, `${level} on ${bg}: ${contrast(fg, token(bg)).toFixed(2)}`);
	}
});
