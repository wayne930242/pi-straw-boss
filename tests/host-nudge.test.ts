import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LifecycleProjection } from "@nubl/maestro/core/lifecycle";
import { ACK_SUFFIX, ACK_MS, NUDGE_SUFFIX, RETRY_MS, createNudger, nudgeText, readNudgeSettings, type NudgeSettings } from "../src/host/nudge.ts";
import { answerNudge, nudgeInbox } from "../src/host/nudge-child.ts";
import { createWidgetController } from "../src/host/widgets.ts";

// The done nudge (docs/specs/2026-11-28-done-nudge.md): a child of sb's host whose turn has ended and that sits idle without a result is asked to
// finish, through its own pi; after `max` nudges the parent is told once.

const MIN = 60_000;
const dir = () => mkdtempSync(join(tmpdir(), "nudge-"));
const waiting = (since: number): LifecycleProjection => ({ kind: "waiting", stateDurationSince: since }) as LifecycleProjection;
const active = (since: number): LifecycleProjection => ({ kind: "active", label: "bash", stateDurationSince: since }) as LifecycleProjection;
const blocked = (since: number): LifecycleProjection => ({ kind: "blocked", stateDurationSince: since }) as LifecycleProjection;

function world(settings: NudgeSettings = { idleMs: 10 * MIN, max: 2 }, locale: "en" | "zh-TW" = "en") {
	const d = dir(), sessionFile = join(d, "kid.jsonl");
	const run = { id: "r1", name: "build-api", sessionFile, interactive: false } as { id: string; name: string; sessionFile: string; interactive: boolean; persistent?: boolean; cancelState?: string };
	const nudger = createNudger({ settings: () => settings, locale: () => locale });
	const request = () => (existsSync(sessionFile + NUDGE_SUFFIX) ? JSON.parse(readFileSync(sessionFile + NUDGE_SUFFIX, "utf8")) : undefined);
	const ack = (outcome: "sent" | "draft" | "busy", at: number, id = request()?.id) => writeFileSync(sessionFile + ACK_SUFFIX, JSON.stringify({ v: 1, id, outcome, at }));
	return { run, nudger, request, ack, sessionFile };
}

test("a child idle the full threshold gets one request; before it, nothing", () => {
	const w = world();
	assert.equal(w.nudger.look(w.run, waiting(0), 10 * MIN - 1), undefined);
	assert.equal(w.request(), undefined, "not yet");
	assert.equal(w.nudger.look(w.run, waiting(0), 10 * MIN), undefined, "a request tells the parent nothing");
	assert.deepEqual(w.request(), { v: 1, id: "r1:1", idleMs: 10 * MIN });
	w.nudger.look(w.run, waiting(0), 10 * MIN + 5000);
	assert.equal(w.request().id, "r1:1", "one request at a time");
});

test("never nudged: an interactive child, a persistent one, one being cancelled, one whose turn runs (a long tool call too) or is blocked", () => {
	for (const [extra, projection] of [
		[{ interactive: true }, waiting(0)],
		[{ persistent: true }, waiting(0)],
		[{ cancelState: "requested" }, waiting(0)],
		[{}, active(0)],
		[{}, blocked(0)],
	] as const) {
		const w = world();
		Object.assign(w.run, extra);
		assert.equal(w.nudger.look(w.run, projection, 60 * MIN), undefined);
		assert.equal(w.request(), undefined, JSON.stringify({ extra, kind: projection.kind }));
	}
});

test("off: idleMs 0 sends nothing", () => {
	const w = world({ idleMs: 0, max: 2 });
	w.nudger.look(w.run, waiting(0), 600 * MIN);
	assert.equal(w.request(), undefined);
});

test("one nudge per idle stretch, max in all, then the parent is told once", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	w.ack("sent", 10 * MIN + 2000);
	assert.equal(w.nudger.look(w.run, waiting(0), 10 * MIN + 3000), undefined);
	assert.equal(existsSync(w.sessionFile + ACK_SUFFIX), false, "the parent removes the ack it read");
	// The reply turn ended between two looks: the projection's stretch start did not move, but the nudge starts a stretch of its own.
	w.nudger.look(w.run, waiting(0), 15 * MIN);
	assert.equal(w.request(), undefined, "no second nudge in the stretch the first one opened");
	w.nudger.look(w.run, waiting(0), 20 * MIN + 2000);
	assert.equal(w.request().id, "r1:2", "the next stretch gets the next nudge");
	w.ack("sent", 20 * MIN + 3000);
	assert.equal(w.nudger.look(w.run, waiting(21 * MIN), 21 * MIN), undefined);
	assert.equal(w.nudger.look(w.run, waiting(21 * MIN), 31 * MIN - 1), undefined);
	const told = w.nudger.look(w.run, waiting(21 * MIN), 31 * MIN);
	assert.equal(w.request(), undefined, "no third nudge");
	assert.equal(
		told,
		`build-api has been idle 31m and has not delivered its result, after 2 reminders to finish. Straw Boss will not remind it again. Read its pane; subagent_cancel stops it, and subagent_resume with its session file (${w.sessionFile}) continues it later.`,
	);
	assert.equal(w.nudger.look(w.run, waiting(21 * MIN), 90 * MIN), undefined, "told once");
});

test("a turn of the child's own starts a new stretch", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 9 * MIN);
	w.nudger.look(w.run, active(9 * MIN), 9 * MIN + 1000);
	w.nudger.look(w.run, waiting(12 * MIN), 12 * MIN);
	w.nudger.look(w.run, waiting(12 * MIN), 21 * MIN);
	assert.equal(w.request(), undefined);
	w.nudger.look(w.run, waiting(12 * MIN), 22 * MIN);
	assert.equal(w.request().id, "r1:1");
});

test("draft or busy counts nothing and is asked again a minute later", () => {
	for (const outcome of ["draft", "busy"] as const) {
		const w = world({ idleMs: 10 * MIN, max: 1 });
		w.nudger.look(w.run, waiting(0), 10 * MIN);
		w.ack(outcome, 10 * MIN + 1000);
		w.nudger.look(w.run, waiting(0), 10 * MIN + 2000);
		assert.equal(w.request(), undefined, outcome);
		w.nudger.look(w.run, waiting(0), 10 * MIN + 2000 + RETRY_MS - 1);
		assert.equal(w.request(), undefined, `${outcome}: not before the retry`);
		w.nudger.look(w.run, waiting(0), 10 * MIN + 2000 + RETRY_MS);
		assert.equal(w.request().id, "r1:2", `${outcome}: asked again`);
		w.ack("sent", 12 * MIN);
		w.nudger.look(w.run, waiting(0), 12 * MIN + 1);
		assert.match(w.nudger.look(w.run, waiting(0), 22 * MIN) ?? "", /after 1 reminder to finish/, `${outcome}: only the sent one counted`);
	}
});

test("an ack for another request is not this one's answer", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	w.ack("sent", 10 * MIN + 1000, "old-run:4");
	w.nudger.look(w.run, waiting(0), 10 * MIN + 2000);
	assert.equal(w.request().id, "r1:1", "still open");
});

test("a request no child takes within a minute: removed, the parent told once that it cannot be asked", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	assert.equal(w.nudger.look(w.run, waiting(0), 10 * MIN + ACK_MS - 1), undefined);
	const told = w.nudger.look(w.run, waiting(0), 10 * MIN + ACK_MS);
	assert.equal(w.request(), undefined, "removed");
	assert.match(told ?? "", /^build-api has been idle 11m and has not delivered its result, and Straw Boss could not remind it: its pi took no reminder \(it was started by an older Straw Boss\)\. Read its pane;/);
	assert.equal(w.nudger.look(w.run, waiting(0), 100 * MIN), undefined, "told once, never asked again");
});

test("zh-TW: the parent's notices in Traditional Chinese", () => {
	const w = world({ idleMs: 10 * MIN, max: 1 }, "zh-TW");
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	w.ack("sent", 10 * MIN);
	w.nudger.look(w.run, waiting(0), 10 * MIN + 1);
	assert.equal(
		w.nudger.look(w.run, waiting(0), 20 * MIN),
		`build-api 已閒置 20m，還沒交回結果；Straw Boss 已提醒它收尾 1 次，不會再提醒。請看它的窗格；要停掉它用 subagent_cancel，之後要接著做，用 subagent_resume 帶它的 session 檔（${w.sessionFile}）。`,
	);
	const u = world({ idleMs: 10 * MIN, max: 1 }, "zh-TW");
	u.nudger.look(u.run, waiting(0), 10 * MIN);
	assert.match(u.nudger.look(u.run, waiting(0), 11 * MIN) ?? "", /^build-api 已閒置 11m，還沒交回結果，而 Straw Boss 無法提醒它：它的 pi 沒有接收提醒（它是較舊版的 Straw Boss 啟動的）。請看它的窗格；/);
});

test("prune: a run gone from the registry takes its open request with it", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	assert.ok(w.request());
	w.nudger.prune(["other"]);
	assert.equal(w.request(), undefined);
});

test("settings: subagentNudge in config.json, defaults for anything missing or out of range", () => {
	const d = dir();
	assert.deepEqual(readNudgeSettings(d), { idleMs: 10 * MIN, max: 2 }, "no file");
	const put = (v: unknown) => writeFileSync(join(d, "config.json"), typeof v === "string" ? v : JSON.stringify(v));
	put({ subagentNudge: { idleMinutes: 0.5, max: 4 } });
	assert.deepEqual(readNudgeSettings(d), { idleMs: 30_000, max: 4 });
	put({ subagentNudge: { idleMinutes: 0 } });
	assert.deepEqual(readNudgeSettings(d), { idleMs: 0, max: 2 }, "0 turns it off");
	put({ subagentNudge: { idleMinutes: -1, max: 0 } });
	assert.deepEqual(readNudgeSettings(d), { idleMs: 10 * MIN, max: 2 });
	put({ subagentNudge: { idleMinutes: 2000, max: 2.5 } });
	assert.deepEqual(readNudgeSettings(d), { idleMs: 10 * MIN, max: 2 });
	put("\uFEFF{ \"subagentNudge\": { \"max\": 3 } }");
	assert.deepEqual(readNudgeSettings(d), { idleMs: 10 * MIN, max: 3 }, "a BOM is ignored");
	put("{ broken");
	assert.deepEqual(readNudgeSettings(d), { idleMs: 10 * MIN, max: 2 });
});

test("the nudge text: subagent_done for a child that has it, a final turn for an auto-exit one, caller_ping for both", () => {
	assert.equal(
		nudgeText(false, 10 * MIN),
		"Straw Boss: you have been idle for 10 minutes, and your caller still has no result from you. If your task is done, write your final report now and call subagent_done. If you truly wait on your caller (a decision, an access, or an answer only it can give), say so with caller_ping. If you wait on work of your own that will wake you (a monitor, a loop, your own subagents), reply in one line with what it is and when it ends.",
	);
	assert.equal(
		nudgeText(true, 30_000),
		"Straw Boss: you have been idle for 1 minute, and your caller still has no result from you. If your task is done, end this turn with your final report: this session then closes and delivers it. If you truly wait on your caller (a decision, an access, or an answer only it can give), say so with caller_ping.",
	);
});

// ── the child's side ──

function child(opts: { idle?: boolean; pending?: boolean; draft?: string; undelivered?: boolean } = {}) {
	const d = dir(), file = join(d, "kid.jsonl");
	const sent: { text: unknown; options: unknown }[] = [];
	const pi = { sendUserMessage: (text: unknown, options: unknown) => void sent.push({ text, options }) };
	const ctx = { isIdle: () => opts.idle ?? true, hasPendingMessages: () => opts.pending ?? false, ui: { getEditorText: () => opts.draft ?? "" } };
	const put = (id = "r1:1", idleMs = 10 * MIN) => writeFileSync(file + NUDGE_SUFFIX, JSON.stringify({ v: 1, id, idleMs }));
	const ack = () => (existsSync(file + ACK_SUFFIX) ? JSON.parse(readFileSync(file + ACK_SUFFIX, "utf8")) : undefined);
	return { file, pi, ctx, sent, put, ack, undelivered: () => opts.undelivered ?? false };
}

test("child: an idle child with an empty input box takes the request, sends the nudge into its own session, and acks sent", () => {
	const c = child();
	c.put();
	assert.equal(answerNudge({ file: c.file, autoExit: false, ctx: c.ctx as never, pi: c.pi as never, undelivered: c.undelivered, now: () => 7 }), "sent");
	assert.deepEqual(c.sent, [{ text: nudgeText(false, 10 * MIN), options: { deliverAs: "followUp" } }]);
	assert.deepEqual(c.ack(), { v: 1, id: "r1:1", outcome: "sent", at: 7 });
	assert.equal(existsSync(c.file + NUDGE_SUFFIX), false, "the request is consumed");
	assert.equal(answerNudge({ file: c.file, autoExit: false, ctx: c.ctx as never, pi: c.pi as never, undelivered: c.undelivered }), undefined, "nothing open: nothing done");
	assert.equal(c.sent.length, 1);
});

test("child: unsent text in the input box, a running turn, a queued message, or its own undelivered subagents: nothing sent, the reason acked", () => {
	for (const [opts, outcome] of [
		[{ draft: "half a sentence" }, "draft"],
		[{ idle: false }, "busy"],
		[{ pending: true }, "busy"],
		[{ undelivered: true }, "busy"],
	] as const) {
		const c = child(opts);
		c.put();
		assert.equal(answerNudge({ file: c.file, autoExit: false, ctx: c.ctx as never, pi: c.pi as never, undelivered: c.undelivered, now: () => 1 }), outcome, JSON.stringify(opts));
		assert.deepEqual(c.sent, []);
		assert.equal(c.ack().outcome, outcome);
	}
});

test("child: an auto-exit child gets the final-turn wording", () => {
	const c = child();
	c.put("r1:1", 30_000);
	answerNudge({ file: c.file, autoExit: true, ctx: c.ctx as never, pi: c.pi as never, undelivered: c.undelivered });
	assert.equal(c.sent[0].text, nudgeText(true, 30_000));
});

test("child: the inbox runs only in a subagent with a session file, never in a persistent specialist", () => {
	const on: string[] = [];
	const pi = { on: (event: string) => void on.push(event), sendUserMessage() {} };
	nudgeInbox(pi as never, { env: {} });
	assert.deepEqual(on, [], "no subagent session");
	nudgeInbox(pi as never, { env: { PI_SUBAGENT_SESSION: "/x.jsonl", PI_SUBAGENT_PERSISTENT: "1" } });
	assert.deepEqual(on, [], "persistent");
	nudgeInbox(pi as never, { env: { PI_SUBAGENT_SESSION: "/x.jsonl", PI_SUBAGENT_AUTO_EXIT: "1" } });
	assert.deepEqual(on.sort(), ["session_shutdown", "session_start"]);
});

test("child: the inbox polls once the session starts and stops at shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const c = child();
	const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
	const pi = { on: (event: string, h: (e: unknown, ctx: unknown) => void) => void handlers.set(event, h), sendUserMessage: c.pi.sendUserMessage };
	nudgeInbox(pi as never, { env: { PI_SUBAGENT_SESSION: c.file }, undelivered: c.undelivered });
	handlers.get("session_start")!({}, c.ctx);
	c.put();
	t.mock.timers.tick(2000);
	assert.equal(c.sent.length, 1, "taken at the next poll");
	handlers.get("session_shutdown")!({}, c.ctx);
	c.put("r1:2");
	t.mock.timers.tick(10_000);
	assert.equal(c.sent.length, 1, "no poll after shutdown");
});

// ── the status loop carries the notice ──

test("the status loop asks the nudger about each child and sends what it says in subagent_status", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100 * MIN });
	const d = dir();
	mkdirSync(d, { recursive: true });
	const running = { id: "r1", name: "build-api", sessionFile: join(d, "k.jsonl"), interactive: false, startTime: 0, lifecycle: { process: { kind: "running", startedAt: 0, confirmedAt: 0 }, turn: { kind: "waiting", startedAt: 0 }, activityHealth: { kind: "unseen" }, activityDetail: null, pane: { kind: "unknown" }, hasWorked: true, lastActivitySequence: null, delivery: "pending" } };
	const runtime = { runningSubagents: new Map([["r1", running]]) };
	const looked: string[] = [], pruned: string[][] = [];
	const nudger = { look: (run: { id: string }, projection: LifecycleProjection) => (looked.push(`${run.id}:${projection.kind}`), "build-api told"), prune: (ids: Iterable<string>) => void pruned.push([...ids]) };
	const messages: { content: string; options: unknown }[] = [];
	const pi = { sendMessage: (m: { content: string }, options: unknown) => void messages.push({ content: m.content, options }) };
	const controller = createWidgetController(
		{ runtime, statusConfig: { enabled: true, lineLimit: 10 }, supervisionConfig: { hangWarningMinutes: 0 }, observeRunningSubagent() {}, evaluateNoProgressAdvisory: () => undefined } as never,
		undefined,
		nudger,
	);
	controller.startStatusRefresh(pi as never);
	t.after(() => controller.stopRefresh());
	t.mock.timers.tick(1000);
	assert.deepEqual(looked, ["r1:waiting"]);
	assert.deepEqual(pruned, [["r1"]]);
	assert.equal(messages.length, 1);
	assert.match(messages[0].content, /• build-api told/);
	assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "steer" });
	runtime.runningSubagents.clear();
	t.mock.timers.tick(1000);
	assert.deepEqual(pruned.at(-1), [], "the last run gone: pruned before the loop stops");
});
