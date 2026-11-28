import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LifecycleProjection } from "@nubl/maestro/core/lifecycle";
import { ACK_MS, NUDGE_SUFFIX, REQUEST_MS, RESEND_MS, RETRY_MS, ackFile, createNudger, newNudgeStore, nudgeDir, nudgeText, readNudgeSettings, requestFile, sharedNudgeStore, type NudgeOutcome, type NudgeSettings, type NudgeStore } from "../src/host/nudge.ts";
import { ACCEPT_MS, createInbox, nudgeInbox } from "../src/host/nudge-child.ts";
import { createWidgetController } from "../src/host/widgets.ts";

// The done nudge (docs/specs/2026-11-28-done-nudge.md): a child of sb's host whose turn has ended and that sits idle without a result is asked to
// finish, through its own pi; after `max` nudges the parent is told once. An auto-exit child is never nudged: its parent is told instead.

const MIN = 60_000;
const dir = () => mkdtempSync(join(tmpdir(), "nudge-"));
const waiting = (since: number): LifecycleProjection => ({ kind: "waiting", stateDurationSince: since }) as LifecycleProjection;
const active = (since: number): LifecycleProjection => ({ kind: "active", label: "bash", stateDurationSince: since }) as LifecycleProjection;
const blocked = (since: number): LifecycleProjection => ({ kind: "blocked", stateDurationSince: since }) as LifecycleProjection;
type Run = { id: string; name: string; sessionFile: string; interactive: boolean; persistent?: boolean; cancelState?: string };

/** The `subagent_status` message as pi starts it in the parent's session. */
const statusMessage = (nudgeNotices: string[]) => ({ role: "custom", customType: "subagent_status", content: "", display: true, details: { lines: [], overflow: 0, nudgeNotices } });

function ids(prefix: string) {
	let n = 0;
	return () => `${prefix}-${String(++n).padStart(8, "0")}`;
}

function world(settings: NudgeSettings = { idleMs: 10 * MIN, max: 2 }, locale: "en" | "zh-TW" = "en", sessionFile = join(dir(), "kid.jsonl")) {
	const run: Run = { id: "r1", name: "build-api", sessionFile, interactive: false };
	const make = (prefix = "aaaa") => createNudger({ settings: () => settings, locale: () => locale, newId: ids(prefix) });
	const nudger = make();
	const runDir = (r: Run = run) => nudgeDir(r.sessionFile, r.id);
	const requests = (r: Run = run) => (existsSync(runDir(r)) ? readdirSync(runDir(r)).filter((n) => n.endsWith(".req")) : []);
	const request = (r: Run = run) => {
		const [name] = requests(r);
		return name ? JSON.parse(readFileSync(join(runDir(r), name), "utf8")) : undefined;
	};
	const ack = (outcome: NudgeOutcome, at: number, id = request()?.id, runId = run.id) => {
		const req = requestFile(runDir(), id);
		rmSync(req, { force: true }); // the child consumed it before it acked
		writeFileSync(ackFile(runDir(), id), JSON.stringify({ v: 2, id, runId, outcome, at }));
	};
	/** The notices the parent would send now; pi confirms each at once. */
	const told = (n = nudger) => {
		const out = n.outbox(0, false);
		n.accepted(statusMessage(out.map((o) => o.id)));
		return out.map((o) => o.text);
	};
	return { run, nudger, make, request, requests, ack, told, runDir, sessionFile };
}

test("a child idle the full threshold gets one request in its run's folder; before it, nothing", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN - 1);
	assert.equal(w.request(), undefined, "not yet");
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	assert.deepEqual(w.told(), [], "a request tells the parent nothing");
	assert.equal(w.runDir(), join(w.sessionFile + NUDGE_SUFFIX, "r1"));
	assert.deepEqual(w.request(), { v: 2, id: "aaaa-00000001", runId: "r1", sessionFile: w.sessionFile, at: 10 * MIN, idleMs: 10 * MIN });
	w.nudger.look(w.run, waiting(0), 10 * MIN + 5000);
	assert.deepEqual(w.requests(), ["aaaa-00000001.req"], "one request at a time");
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
		w.nudger.look(w.run, projection, 60 * MIN);
		assert.equal(w.request(), undefined, JSON.stringify({ extra, kind: projection.kind }));
		assert.deepEqual(w.told(), []);
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
	w.nudger.look(w.run, waiting(0), 10 * MIN + 3000);
	assert.equal(existsSync(w.runDir()), false, "the parent removes the ack it read, and the run's folder with it");
	// The reply turn ended between two looks: the projection's stretch start did not move, but the nudge starts a stretch of its own.
	w.nudger.look(w.run, waiting(0), 15 * MIN);
	assert.equal(w.request(), undefined, "no second nudge in the stretch the first one opened");
	w.nudger.look(w.run, waiting(0), 20 * MIN + 2000);
	assert.equal(w.request().id, "aaaa-00000002", "the next stretch gets the next nudge");
	w.ack("sent", 20 * MIN + 3000);
	w.nudger.look(w.run, waiting(21 * MIN), 21 * MIN);
	w.nudger.look(w.run, waiting(21 * MIN), 31 * MIN - 1);
	assert.deepEqual(w.told(), []);
	w.nudger.look(w.run, waiting(21 * MIN), 31 * MIN);
	assert.equal(w.request(), undefined, "no third nudge");
	assert.deepEqual(w.told(), [
		`build-api has been idle 31m and has not delivered its result, after 2 reminders to finish. Straw Boss will not remind it again. Read its pane; subagent_cancel stops it, and subagent_resume with its session file (${w.sessionFile}) continues it later.`,
	]);
	w.nudger.look(w.run, waiting(21 * MIN), 90 * MIN);
	assert.deepEqual(w.told(), [], "told once");
});

test("a turn of the child's own starts a new stretch", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 9 * MIN);
	w.nudger.look(w.run, active(9 * MIN), 9 * MIN + 1000);
	w.nudger.look(w.run, waiting(12 * MIN), 12 * MIN);
	w.nudger.look(w.run, waiting(12 * MIN), 21 * MIN);
	assert.equal(w.request(), undefined);
	w.nudger.look(w.run, waiting(12 * MIN), 22 * MIN);
	assert.equal(w.request().id, "aaaa-00000001");
});

test("an ack that sent nothing (draft, busy, stale) counts nothing and is asked again a minute later", () => {
	for (const outcome of ["draft", "busy", "stale"] as const) {
		const w = world({ idleMs: 10 * MIN, max: 1 });
		w.nudger.look(w.run, waiting(0), 10 * MIN);
		w.ack(outcome, 10 * MIN + 1000);
		w.nudger.look(w.run, waiting(0), 10 * MIN + 2000);
		assert.equal(w.request(), undefined, outcome);
		w.nudger.look(w.run, waiting(0), 10 * MIN + 2000 + RETRY_MS - 1);
		assert.equal(w.request(), undefined, `${outcome}: not before the retry`);
		w.nudger.look(w.run, waiting(0), 10 * MIN + 2000 + RETRY_MS);
		assert.equal(w.request().id, "aaaa-00000002", `${outcome}: asked again`);
		w.ack("sent", 12 * MIN);
		w.nudger.look(w.run, waiting(0), 12 * MIN + 1);
		w.nudger.look(w.run, waiting(0), 22 * MIN);
		assert.match(w.told()[0] ?? "", /after 1 reminder to finish/, `${outcome}: only the sent one counted`);
	}
});

test("F006: a nudge the child sent but never saw enter is no delivery, yet one of the max tries, and the notice says so", () => {
	const w = world({ idleMs: 10 * MIN, max: 2 });
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	w.ack("lost", 10 * MIN + 31_000);
	w.nudger.look(w.run, waiting(0), 10 * MIN + 32_000);
	w.nudger.look(w.run, waiting(0), 20 * MIN + 30_000);
	assert.equal(w.request(), undefined, "a new stretch starts with the send, since it may have gone in");
	w.nudger.look(w.run, waiting(0), 20 * MIN + 31_000);
	w.ack("sent", 20 * MIN + 32_000);
	w.nudger.look(w.run, waiting(0), 20 * MIN + 33_000);
	w.nudger.look(w.run, waiting(0), 30 * MIN + 32_000);
	assert.match(w.told()[0] ?? "", /^build-api has been idle 30m and has not delivered its result, after 2 reminders to finish \(its pi could not confirm that 1 of them entered its session\)\. Straw Boss will not remind it again\./);
	const z = world({ idleMs: 10 * MIN, max: 1 }, "zh-TW");
	z.nudger.look(z.run, waiting(0), 10 * MIN);
	z.ack("lost", 10 * MIN + 31_000);
	z.nudger.look(z.run, waiting(0), 10 * MIN + 32_000);
	z.nudger.look(z.run, waiting(0), 20 * MIN + 31_000);
	assert.match(z.told()[0] ?? "", /^build-api 已閒置 20m，還沒交回結果；Straw Boss 已提醒它收尾 1 次（其中 1 次它的 pi 無法確認已送進它的 session），不會再提醒。/);
});

test("an ack for another request or another run is not this one's answer", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	const id = w.request().id;
	writeFileSync(ackFile(w.runDir(), id), JSON.stringify({ v: 2, id, runId: "r0", outcome: "sent", at: 10 * MIN }));
	w.nudger.look(w.run, waiting(0), 10 * MIN + 2000);
	assert.equal(w.request().id, id, "still open");
	writeFileSync(ackFile(w.runDir(), id), JSON.stringify({ v: 1, id, outcome: "sent", at: 10 * MIN }));
	w.nudger.look(w.run, waiting(0), 10 * MIN + 3000);
	assert.equal(w.request().id, id, "an ack of the old format is no answer either");
});

test("F006: a request no child acknowledges within a minute: removed, and the parent told once of no acknowledgement, guessing neither version nor activity", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	w.nudger.look(w.run, waiting(0), 10 * MIN + ACK_MS - 1);
	assert.deepEqual(w.told(), []);
	w.nudger.look(w.run, waiting(0), 10 * MIN + ACK_MS);
	assert.equal(w.request(), undefined, "removed");
	assert.deepEqual(w.told(), [
		`build-api has not delivered its result, and its pi sent no acknowledgement of Straw Boss's reminder request within a minute, so Straw Boss will not remind it. Read its pane; subagent_cancel stops it, and subagent_resume with its session file (${w.sessionFile}) continues it later.`,
	]);
	w.nudger.look(w.run, waiting(0), 100 * MIN);
	assert.deepEqual(w.told(), [], "told once, never asked again");
	assert.equal(w.request(), undefined);
});

test("F001: an auto-exit child answers that it closes by itself: the parent is told once, in plain words, and it is never asked again", () => {
	for (const [locale, words] of [
		["en", "build-api has been idle 10m and has not delivered its result. Straw Boss did not remind it: it closes when a turn ends, so a reminder would close it and deliver its unfinished work as done. Read its pane;"],
		["zh-TW", "build-api 已閒置 10m，還沒交回結果。Straw Boss 沒有提醒它：它一輪結束就會關閉，提醒會讓它把沒做完的工作當成結果交回。請看它的窗格；"],
	] as const) {
		const w = world(undefined, locale);
		w.nudger.look(w.run, waiting(0), 10 * MIN);
		w.ack("auto-exit", 10 * MIN + 1000);
		w.nudger.look(w.run, waiting(0), 10 * MIN + 2000);
		const t = w.told();
		assert.equal(t.length, 1, locale);
		assert.ok(t[0].startsWith(words), t[0]);
		w.nudger.look(w.run, waiting(0), 60 * MIN);
		assert.equal(w.request(), undefined, "never asked again");
		assert.deepEqual(w.told(), []);
	}
});

test("F001: the auto-exit child sends no nudge and acks auto-exit, whatever its state", () => {
	const c = child({ autoExit: true });
	c.put();
	assert.deepEqual(c.inbox.poll(), ["auto-exit"]);
	assert.deepEqual(c.sent, [], "nothing goes into its session");
	assert.equal(c.ack().outcome, "auto-exit");
});

test("F002: request ids stay unique across parent reloads, so a stale ack of the old parent counts nothing", () => {
	const sessionFile = join(dir(), "kid.jsonl");
	const w = world(undefined, "en", sessionFile);
	const real = createNudger({ settings: () => ({ idleMs: 10 * MIN, max: 2 }), locale: () => "en" });
	real.look(w.run, waiting(0), 10 * MIN);
	const first = w.request().id;
	real.prune([], 10 * MIN);
	const reloaded = createNudger({ settings: () => ({ idleMs: 10 * MIN, max: 2 }), locale: () => "en" });
	reloaded.look(w.run, waiting(0), 10 * MIN);
	const second = w.request().id;
	assert.notEqual(first, second, "a fresh parent never reuses an id");
	// The old request's ack arrives late: it is not the new request's answer, and the new request stays.
	writeFileSync(ackFile(w.runDir(), first), JSON.stringify({ v: 2, id: first, runId: "r1", outcome: "sent", at: 10 * MIN }));
	reloaded.look(w.run, waiting(0), 10 * MIN + 1000);
	assert.equal(w.request()?.id, second);
	assert.equal(existsSync(ackFile(w.runDir(), first)), true, "and another request's ack is not this parent's to remove");
});

test("F002: a parent removes only the files of its own request", () => {
	const w = world();
	const older = w.make("oldp");
	older.look(w.run, waiting(0), 10 * MIN);
	const newer = w.make("newp");
	newer.look(w.run, waiting(0), 10 * MIN);
	assert.deepEqual(w.requests().sort(), ["newp-00000001.req", "oldp-00000001.req"]);
	older.prune([], 10 * MIN);
	assert.deepEqual(w.requests(), ["newp-00000001.req"], "the older parent's cleanup leaves the newer one's request");
	newer.look(w.run, waiting(0), 10 * MIN + ACK_MS);
	assert.deepEqual(w.requests(), []);
});

test("F002: a child resumed on the same session file never takes the previous run's request, nor one naming another session", () => {
	const c = child({ runId: "r2" });
	const w = world(undefined, "en", c.file);
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	assert.deepEqual(c.inbox.poll(), [], "r1's request is in r1's folder");
	assert.deepEqual(c.sent, []);
	assert.ok(w.request(), "and stays there for r1's parent to time out");
	// A request in r2's folder that names another run or another session file is not r2's.
	c.put("bbbb-00000001", { runId: "r1" });
	c.put("bbbb-00000002", { sessionFile: "/other.jsonl" });
	assert.deepEqual(c.inbox.poll(), []);
	assert.deepEqual(c.sent, []);
});

test("F003: the child's inbox stands still while its session is not the launch file", () => {
	const c = child();
	c.current = "/elsewhere/other.jsonl";
	c.put();
	assert.deepEqual(c.inbox.poll(), []);
	assert.deepEqual(c.sent, []);
	assert.ok(existsSync(requestFile(c.dir, "bbbb-00000001")), "the request is left for the parent to time out");
	c.current = undefined;
	assert.deepEqual(c.inbox.poll(), [], "no session file: no inbox");
	c.current = c.file;
	assert.deepEqual(c.inbox.poll(), ["sent"], "back on the launch file: it answers");
});

test("F004: a cancel revokes the open request", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	assert.ok(w.request());
	w.run.cancelState = "requested";
	w.nudger.look(w.run, waiting(0), 10 * MIN + 1000);
	assert.equal(w.request(), undefined);
	assert.deepEqual(w.told(), []);
});

test("F004: a request whose idle stretch ended is revoked; one the child already took waits for its ack", () => {
	const w = world({ idleMs: 10 * MIN, max: 1 });
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	w.nudger.look(w.run, active(10 * MIN + 500), 10 * MIN + 1000);
	assert.equal(w.request(), undefined, "revoked: a turn started");
	w.nudger.look(w.run, waiting(10 * MIN + 1500), 10 * MIN + 2000);
	assert.equal(w.request(), undefined, "a new stretch waits its full threshold");
	w.nudger.look(w.run, waiting(10 * MIN + 1500), 20 * MIN + 1500);
	const id = w.request().id;
	assert.equal(id, "aaaa-00000002");
	// The child took it and sent the nudge; its own turn starts before its ack is read.
	w.ack("sent", 20 * MIN + 1600);
	w.nudger.look(w.run, active(20 * MIN + 1700), 20 * MIN + 1800);
	w.nudger.look(w.run, waiting(21 * MIN), 31 * MIN);
	assert.match(w.told()[0] ?? "", /after 1 reminder to finish/, "the nudge in flight still counted");
});

test("F004: the child rejects a request written before its latest turn", () => {
	const c = child();
	c.clock = 5000;
	c.inbox.turnStarted();
	c.put("bbbb-00000001", { at: 4999 });
	assert.deepEqual(c.inbox.poll(), ["stale"]);
	assert.deepEqual(c.sent, []);
	assert.equal(c.ack().outcome, "stale");
	c.put("bbbb-00000002", { at: 5001 });
	assert.deepEqual(c.inbox.poll(), ["sent"]);
});

test("zh-TW: the parent's notices in Traditional Chinese", () => {
	const w = world({ idleMs: 10 * MIN, max: 1 }, "zh-TW");
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	w.ack("sent", 10 * MIN);
	w.nudger.look(w.run, waiting(0), 10 * MIN + 1);
	w.nudger.look(w.run, waiting(0), 20 * MIN);
	assert.deepEqual(w.told(), [
		`build-api 已閒置 20m，還沒交回結果；Straw Boss 已提醒它收尾 1 次，不會再提醒。請看它的窗格；要停掉它用 subagent_cancel，之後要接著做，用 subagent_resume 帶它的 session 檔（${w.sessionFile}）。`,
	]);
	const u = world({ idleMs: 10 * MIN, max: 1 }, "zh-TW");
	u.nudger.look(u.run, waiting(0), 10 * MIN);
	u.nudger.look(u.run, waiting(0), 11 * MIN);
	assert.match(u.told()[0] ?? "", /^build-api 還沒交回結果；Straw Boss 要提醒它收尾，但它的 pi 一分鐘內沒有回應這個請求，所以不會再提醒。請看它的窗格；/);
});

test("prune: a run gone from the registry takes its open request with it", () => {
	const w = world();
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	assert.ok(w.request());
	w.nudger.prune(["other"], 10 * MIN);
	assert.equal(w.request(), undefined);
	assert.equal(existsSync(w.sessionFile + NUDGE_SUFFIX), false, "the folders go once empty");
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

test("the nudge text: write the report and call subagent_done, or caller_ping, or name the wait", () => {
	assert.equal(
		nudgeText(10 * MIN, "0f3c2a9e-4b1d-4c8e-9a7f-5d2e8b6c1a90"),
		"Straw Boss (reminder 8b6c1a90): you have been idle for 10 minutes, and your caller still has no result from you. If your task is done, write your final report now and call subagent_done. If you truly wait on your caller (a decision, an access, or an answer only it can give), say so with caller_ping. If you wait on work of your own that will wake you (a monitor, a loop, your own subagents), reply in one line with what it is and when it ends.",
	);
	assert.match(nudgeText(30_000, "aaaa-00000001"), /^Straw Boss \(reminder 00000001\): you have been idle for 1 minute,/);
});

// ── the child's side ──

function child(opts: { idle?: boolean; pending?: boolean; draft?: string; undelivered?: boolean; autoExit?: boolean; runId?: string; throws?: boolean } = {}) {
	const d = dir(), file = join(d, "kid.jsonl"), runId = opts.runId ?? "r1";
	const sent: { text: unknown; options: unknown }[] = [];
	const pi = {
		sendUserMessage: (text: unknown, options: unknown) => {
			if (opts.throws) throw new Error("no");
			sent.push({ text, options });
		},
	};
	const state = { current: file as string | undefined, clock: 0 };
	const ctx = {
		isIdle: () => opts.idle ?? true,
		hasPendingMessages: () => opts.pending ?? false,
		ui: { getEditorText: () => opts.draft ?? "" },
		sessionManager: { getSessionFile: () => state.current },
	};
	const runDir = nudgeDir(file, runId);
	const calls = { stat: 0, readdir: 0 };
	const fs = {
		statSync: (p: string, o: { throwIfNoEntry: false }) => (calls.stat++, statSync(p, o)),
		readdirSync: (p: string) => (calls.readdir++, readdirSync(p)),
	};
	const inbox = createInbox({ file, runId, autoExit: opts.autoExit ?? false, ctx: () => ctx, pi, undelivered: () => opts.undelivered ?? false, now: () => state.clock, fs });
	const put = (id = "bbbb-00000001", over: Record<string, unknown> = {}) => {
		mkdirSync(runDir, { recursive: true });
		writeFileSync(requestFile(runDir, id), JSON.stringify({ v: 2, id, runId, sessionFile: file, at: 1, idleMs: 10 * MIN, ...over }));
	};
	const ack = (id?: string) => {
		const names = readdirSync(runDir).filter((n) => n.endsWith(".ack")).sort();
		const name = id ? `${id}.ack` : names.at(-1);
		if (!name || !existsSync(join(runDir, name))) return undefined;
		return JSON.parse(readFileSync(join(runDir, name), "utf8"));
	};
	return {
		file, dir: runDir, pi, ctx, sent, put, ack, inbox, calls,
		get current() { return state.current; }, set current(v) { state.current = v; },
		get clock() { return state.clock; }, set clock(v) { state.clock = v; },
	};
}

test("child: an idle child with an empty input box takes the request and sends the nudge; it acks sent only once the nudge enters its session (F006)", () => {
	const c = child();
	c.clock = 7;
	c.put();
	assert.deepEqual(c.inbox.poll(), ["sent"]);
	assert.deepEqual(c.sent, [{ text: nudgeText(10 * MIN, "bbbb-00000001"), options: { deliverAs: "followUp" } }]);
	assert.equal(existsSync(requestFile(c.dir, "bbbb-00000001")), false, "the request is consumed");
	assert.equal(c.ack(), undefined, "the call alone proves nothing: no ack yet");
	c.inbox.messageStarted({ role: "user", content: "something else" });
	c.inbox.messageStarted({ role: "assistant", content: [{ type: "text", text: nudgeText(10 * MIN, "bbbb-00000001") }] });
	assert.equal(c.ack(), undefined, "another message is not the nudge");
	c.clock = 9;
	c.inbox.messageStarted({ role: "user", content: [{ type: "text", text: nudgeText(10 * MIN, "bbbb-00000001") }] });
	assert.deepEqual(c.ack(), { v: 2, id: "bbbb-00000001", runId: "r1", outcome: "sent", at: 9 });
	assert.deepEqual(c.inbox.poll(), [], "nothing open: nothing done");
	assert.equal(c.sent.length, 1);
});

test("child (F006): a nudge that never enters the session is acked lost; one whose send throws, at once", () => {
	const c = child();
	c.put();
	c.inbox.poll();
	c.clock = ACCEPT_MS - 1;
	c.inbox.poll();
	assert.equal(c.ack(), undefined);
	c.clock = ACCEPT_MS;
	c.inbox.poll();
	assert.equal(c.ack().outcome, "lost");
	c.inbox.messageStarted({ role: "user", content: nudgeText(10 * MIN, "bbbb-00000001") });
	assert.equal(c.ack().outcome, "lost", "a late entry does not turn it into sent");
	const t = child({ throws: true });
	t.put();
	assert.deepEqual(t.inbox.poll(), ["lost"]);
	assert.equal(t.ack().outcome, "lost");
});

test("child: unsent text in the input box, a running turn, a queued message, its own undelivered subagents, or a nudge in flight: nothing sent, the reason acked", () => {
	for (const [opts, outcome] of [
		[{ draft: "half a sentence" }, "draft"],
		[{ idle: false }, "busy"],
		[{ pending: true }, "busy"],
		[{ undelivered: true }, "busy"],
	] as const) {
		const c = child(opts);
		c.put();
		assert.deepEqual(c.inbox.poll(), [outcome], JSON.stringify(opts));
		assert.deepEqual(c.sent, []);
		assert.equal(c.ack().outcome, outcome);
	}
	const c = child();
	c.put("bbbb-00000001");
	c.put("bbbb-00000002");
	assert.deepEqual(c.inbox.poll(), ["sent", "busy"], "one nudge at a time");
	assert.equal(c.sent.length, 1);
});

test("child: the inbox runs only in a subagent with a session file and a run id, never in a persistent specialist", () => {
	const on: string[] = [];
	const pi = { on: (event: string) => void on.push(event), sendUserMessage() {} };
	assert.equal(nudgeInbox(pi as never, { env: {} }), undefined, "no subagent session");
	assert.equal(nudgeInbox(pi as never, { env: { PI_SUBAGENT_SESSION: "/x.jsonl" } }), undefined, "no run id");
	assert.equal(nudgeInbox(pi as never, { env: { PI_SUBAGENT_SESSION: "/x.jsonl", PI_SUBAGENT_ID: "r1", PI_SUBAGENT_PERSISTENT: "1" } }), undefined, "persistent");
	assert.deepEqual(on, []);
	assert.ok(nudgeInbox(pi as never, { env: { PI_SUBAGENT_SESSION: "/x.jsonl", PI_SUBAGENT_ID: "r1", PI_SUBAGENT_AUTO_EXIT: "1" } }), "an auto-exit child answers, to say it takes no nudge");
	assert.deepEqual(on.sort(), ["message_start", "session_shutdown", "session_start", "turn_start"]);
});

test("child: the inbox polls once the session starts, follows turns and messages, and stops at shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const c = child();
	const handlers = new Map<string, (e: unknown, ctx: unknown) => void>();
	const pi = { on: (event: string, h: (e: unknown, ctx: unknown) => void) => void handlers.set(event, h), sendUserMessage: c.pi.sendUserMessage };
	let clock = 100;
	nudgeInbox(pi as never, { env: { PI_SUBAGENT_SESSION: c.file, PI_SUBAGENT_ID: "r1" }, undelivered: () => false, now: () => clock });
	handlers.get("session_start")!({}, c.ctx);
	c.put("bbbb-00000001", { at: 50 });
	t.mock.timers.tick(2000);
	assert.equal(c.sent.length, 1, "taken at the next poll");
	handlers.get("message_start")!({ message: { role: "user", content: c.sent[0].text } }, c.ctx);
	assert.equal(c.ack("bbbb-00000001").outcome, "sent");
	clock = 200;
	handlers.get("turn_start")!({}, c.ctx);
	c.put("bbbb-00000002", { at: 150 });
	t.mock.timers.tick(2000);
	assert.equal(c.ack("bbbb-00000002").outcome, "stale", "written before the turn that started");
	handlers.get("session_shutdown")!({}, c.ctx);
	c.put("bbbb-00000003", { at: 300 });
	t.mock.timers.tick(10_000);
	assert.equal(c.sent.length, 1, "no poll after shutdown");
	assert.equal(c.ack("bbbb-00000003"), undefined);
});

test("parent and child together: the request, the nudge, its entry, and the counted ack", () => {
	const c = child();
	const w = world({ idleMs: 10 * MIN, max: 1 }, "en", c.file);
	c.clock = 10 * MIN + 500;
	w.nudger.look(w.run, waiting(0), 10 * MIN);
	assert.deepEqual(c.inbox.poll(), ["sent"]);
	// Another extension's input handler wrapped it: still the nudge.
	c.inbox.messageStarted({ role: "user", content: [{ type: "text", text: `<context>\n${c.sent[0].text}` }] });
	w.nudger.look(w.run, active(10 * MIN + 600), 10 * MIN + 1000);
	assert.equal(existsSync(c.file + NUDGE_SUFFIX), false, "nothing left beside the session file");
	w.nudger.look(w.run, waiting(11 * MIN), 21 * MIN);
	assert.match(w.told()[0] ?? "", /after 1 reminder to finish/);
});

// ── F007: a stop revokes, the child refuses old requests, a late ack is removed ──

function parents(sessionFile: string, store = newNudgeStore()) {
	const run: Run = { id: "r1", name: "build-api", sessionFile, interactive: false };
	const make = (prefix: string) => createNudger({ settings: () => ({ idleMs: 10 * MIN, max: 2 }), locale: () => "en", newId: ids(prefix), store });
	return { run, store, make };
}

test("F007: a stop revokes the open request, so the child finds nothing", () => {
	const c = child();
	const p = parents(c.file);
	const a = p.make("aaaa");
	a.look(p.run, waiting(0), 10 * MIN);
	assert.ok(existsSync(requestFile(c.dir, "aaaa-00000001")));
	a.stop(10 * MIN + 500);
	c.clock = 10 * MIN + 1000;
	assert.deepEqual(c.inbox.poll(), []);
	assert.deepEqual(c.sent, []);
	assert.equal(existsSync(c.file + NUDGE_SUFFIX), false, "nothing left beside the session file");
});

test("F007: a request the child took before a reload: its late ack does not survive the next load's cleanup, and the next load waits before asking again", () => {
	const c = child();
	const p = parents(c.file);
	const a = p.make("aaaa");
	a.look(p.run, waiting(0), 10 * MIN);
	c.clock = 10 * MIN + 500;
	assert.deepEqual(c.inbox.poll(), ["sent"]);
	a.stop(10 * MIN + 1000);
	assert.equal(existsSync(c.file + NUDGE_SUFFIX), false, "revoked: the folder went with it");
	const b = p.make("bbbb");
	mkdirSync(c.dir, { recursive: true }); // it stands again, say for a request of another load
	c.clock = 10 * MIN + 1500;
	c.inbox.messageStarted({ role: "user", content: c.sent[0].text });
	assert.equal(c.ack("aaaa-00000001").outcome, "sent", "the ack arrives after the revoke");
	b.prune(["r1"], 10 * MIN + 2000);
	assert.equal(existsSync(c.file + NUDGE_SUFFIX), false, "the late ack and its folders are gone");
	b.look(p.run, waiting(0), 10 * MIN + 2000);
	assert.equal(existsSync(c.file + NUDGE_SUFFIX), false, "the nudge may be in: no second request at once");
	b.look(p.run, waiting(0), 10 * MIN + 1000 + RETRY_MS);
	assert.ok(existsSync(requestFile(c.dir, "bbbb-00000001")), "asked again a minute later");
});

test("F007: an ack already there at the stop is counted, and the next load keeps the count", () => {
	const c = child();
	const p = parents(c.file);
	const a = p.make("aaaa");
	a.look(p.run, waiting(0), 10 * MIN);
	c.clock = 10 * MIN + 500;
	c.inbox.poll();
	c.inbox.messageStarted({ role: "user", content: c.sent[0].text });
	a.stop(10 * MIN + 1000);
	assert.equal(existsSync(c.file + NUDGE_SUFFIX), false);
	const b = p.make("bbbb");
	b.look(p.run, waiting(0), 20 * MIN + 500);
	b.look(p.run, waiting(0), 20 * MIN + 600);
	c.ack("bbbb-00000001");
	writeFileSync(ackFile(c.dir, "bbbb-00000001"), JSON.stringify({ v: 2, id: "bbbb-00000001", runId: "r1", outcome: "sent", at: 20 * MIN + 600 }));
	rmSync(requestFile(c.dir, "bbbb-00000001"));
	b.look(p.run, waiting(0), 20 * MIN + 700);
	b.look(p.run, waiting(0), 30 * MIN + 600);
	const out = b.outbox(30 * MIN + 600, false);
	assert.match(out[0]?.text ?? "", /after 2 reminders to finish/, "the first load's nudge counted");
});

test("F007: a revoked request the child had taken (a cancel, no ack in time): its late ack is removed", () => {
	for (const revoke of ["cancel", "no-ack"] as const) {
		const w = world();
		w.nudger.look(w.run, waiting(0), 10 * MIN);
		const id = w.request().id;
		rmSync(requestFile(w.runDir(), id)); // the child took it
		if (revoke === "cancel") {
			w.run.cancelState = "requested";
			w.nudger.look(w.run, waiting(0), 10 * MIN + 1000);
		} else w.nudger.look(w.run, waiting(0), 10 * MIN + ACK_MS);
		mkdirSync(w.runDir(), { recursive: true });
		writeFileSync(ackFile(w.runDir(), id), JSON.stringify({ v: 2, id, runId: "r1", outcome: "sent", at: 10 * MIN + ACK_MS - 1 }));
		w.nudger.prune(revoke === "cancel" ? ["r1"] : [], 10 * MIN + ACK_MS + 1);
		assert.equal(existsSync(w.sessionFile + NUDGE_SUFFIX), false, revoke);
	}
});

test("F007: the child refuses a request past its expiry, and writes no ack once its parent stopped waiting", () => {
	const c = child();
	c.put("bbbb-00000001", { at: 0 });
	c.clock = REQUEST_MS + 1;
	assert.deepEqual(c.inbox.poll(), ["stale"]);
	assert.deepEqual(c.sent, []);
	assert.equal(c.ack("bbbb-00000001").outcome, "stale");
	c.put("bbbb-00000002", { at: 0 });
	c.clock = ACK_MS;
	assert.deepEqual(c.inbox.poll(), ["stale"]);
	assert.equal(c.ack("bbbb-00000002"), undefined, "its parent gave up on it: no ack is left behind");
	const d = child();
	d.put("bbbb-00000001", { at: 0 });
	assert.deepEqual(d.inbox.poll(), ["sent"]);
	d.clock = ACK_MS;
	d.inbox.poll();
	assert.equal(d.ack("bbbb-00000001"), undefined, "a nudge lost past the parent's wait: no ack either");
});

// ── F008: `sent` only for the marked nudge, and only in time ──

test("F008: the nudge carries its request's mark, so a message quoting another reminder is not it", () => {
	const c = child();
	c.put();
	assert.deepEqual(c.inbox.poll(), ["sent"]);
	assert.match(String(c.sent[0].text), /^Straw Boss \(reminder 00000001\): /);
	c.inbox.messageStarted({ role: "user", content: `You said: ${nudgeText(10 * MIN, "bbbb-00000000")}` });
	assert.equal(c.ack(), undefined, "a quote of an earlier reminder");
	c.inbox.messageStarted({ role: "user", content: c.sent[0].text });
	assert.equal(c.ack().outcome, "sent");
});

test("F008: a nudge that enters after ACCEPT_MS is lost, even before the next poll", () => {
	const c = child();
	c.put();
	c.inbox.poll();
	c.clock = ACCEPT_MS;
	c.inbox.messageStarted({ role: "user", content: c.sent[0].text });
	assert.equal(c.ack().outcome, "lost");
});

// ── F009: a notice stays until pi confirms it ──

test("F009: a notice leaves the queue only once its message starts; unconfirmed, it goes again only while the parent is idle, later each time", () => {
	const store = newNudgeStore();
	const n = createNudger({ settings: () => ({ idleMs: 10 * MIN, max: 2 }), locale: () => "en", store });
	store.queue.push({ id: "n1", text: "told", tries: 0 });
	assert.deepEqual(n.outbox(0, false), [{ id: "n1", text: "told" }]);
	assert.deepEqual(n.outbox(1000, true), [], "in flight");
	assert.deepEqual(n.outbox(RESEND_MS, false), [], "pi may still hold it in a turn");
	assert.deepEqual(n.outbox(RESEND_MS, true), [{ id: "n1", text: "told" }], "idle and unconfirmed: pi dropped it");
	assert.deepEqual(n.outbox(2 * RESEND_MS, true), []);
	assert.deepEqual(n.outbox(3 * RESEND_MS, true), [{ id: "n1", text: "told" }], "twice the wait the next time");
	n.unsent(["n1"]);
	assert.deepEqual(n.outbox(3 * RESEND_MS, false), [{ id: "n1", text: "told" }], "a send that threw goes at the next tick");
	n.accepted({ role: "custom", customType: "other", details: { nudgeNotices: ["n1"] } });
	n.accepted({ role: "user", content: "n1" });
	assert.equal(n.undelivered(), 1, "only a subagent_status message confirms");
	n.accepted(statusMessage(["n1"]));
	assert.equal(n.undelivered(), 0);
	assert.deepEqual(n.outbox(100 * MIN, true), []);
});

test("F009: the store outlives a reload: the next load has the notices not yet confirmed and the counts", () => {
	assert.equal(sharedNudgeStore(), sharedNudgeStore(), "one per process");
	const p = parents(join(dir(), "kid.jsonl"));
	const a = p.make("aaaa");
	a.look(p.run, waiting(0), 10 * MIN);
	a.look(p.run, waiting(0), 10 * MIN + ACK_MS);
	assert.equal(a.outbox(10 * MIN + ACK_MS, false).length, 1, "sent; pi never confirms it");
	a.stop(10 * MIN + ACK_MS + 1);
	const b = p.make("bbbb");
	assert.equal(b.undelivered(), 1);
	b.look(p.run, waiting(0), 60 * MIN);
	assert.equal(existsSync(p.run.sessionFile + NUDGE_SUFFIX), false, "the child it gave up on is not asked again");
	assert.match(b.outbox(60 * MIN, true)[0]?.text ?? "", /sent no acknowledgement/);
});

// ── the status loop carries the notices ──

type LoopT = { mock: { timers: { enable(o: unknown): void; tick(ms: number): void } }; after(f: () => void): void };

function loop(t: LoopT, lineLimit: number, nudger: unknown, opts: { failFirst?: boolean; runs?: string[] } = {}) {
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 100 * MIN });
	const d = dir();
	const make = (id: string) => ({ id, name: `w-${id}`, sessionFile: join(d, `${id}.jsonl`), interactive: false, startTime: 0, lifecycle: { process: { kind: "running", startedAt: 0, confirmedAt: 0 }, turn: { kind: "waiting", startedAt: 0 }, activityHealth: { kind: "unseen" }, activityDetail: null, pane: { kind: "unknown" }, hasWorked: true, lastActivitySequence: null, delivery: "pending" } });
	const parent = { idle: false };
	const runtime = { runningSubagents: new Map((opts.runs ?? ["r1", "r2"]).map((id) => [id, make(id)])), latestCtx: { isIdle: () => parent.idle } };
	const messages: { message: { customType: string; content: string; display: boolean; details: { nudgeNotices?: string[] } }; options: unknown }[] = [];
	const started: ((event: unknown) => void)[] = [];
	let fail = opts.failFirst ?? false;
	const pi = {
		on: (event: string, handler: (event: unknown) => void) => void (event === "message_start" && started.push(handler)),
		sendMessage: (message: (typeof messages)[number]["message"], options: unknown) => {
			if (fail) {
				fail = false;
				throw new Error("not now");
			}
			messages.push({ message, options });
		},
	};
	/** Pi starts the message in the parent's session, the way sendCustomMessage builds it. */
	const start = (i: number) => {
		for (const h of started) h({ type: "message_start", message: { role: "custom", ...messages[i].message, timestamp: 0 } });
	};
	const controller = createWidgetController(
		{ runtime, statusConfig: { enabled: true, lineLimit }, supervisionConfig: { hangWarningMinutes: 0 }, observeRunningSubagent() {}, evaluateNoProgressAdvisory: () => ({ notify: true, kind: "advisory", classification: "generic", idleMs: MIN, lastEntryKind: "assistant" }) } as never,
		undefined,
		nudger as never,
	);
	t.after(() => controller.stopRefresh());
	return { runtime, messages, start, parent, pi, controller, content: (i: number) => messages[i].message.content };
}

/** A real nudger on its own store whose looks and prunes are recorded; `onLook` may queue a notice. */
function spied(onLook: (run: { id: string }, store: NudgeStore) => void = () => {}) {
	const store = newNudgeStore();
	const real = createNudger({ settings: () => ({ idleMs: 0, max: 2 }), locale: () => "en", store });
	const looked: string[] = [], pruned: string[][] = [];
	let stops = 0;
	const nudger = {
		...real,
		look: (run: { id: string }, projection: LifecycleProjection) => {
			looked.push(`${run.id}:${projection.kind}`);
			onLook(run, store);
		},
		prune: (live: Iterable<string>, now: number) => {
			pruned.push([...live]);
			real.prune(live, now);
		},
		stop: (now: number) => {
			stops++;
			real.stop(now);
		},
	};
	return { store, nudger, looked, pruned, get stops() { return stops; } };
}
const notice = (store: NudgeStore, id: string, text: string) => store.queue.push({ id, text, tries: 0 });

test("the status loop asks the nudger about each child and sends its notices in subagent_status, marked so pi's start of the message confirms them", (t) => {
	const s = spied((run, store) => run.id === "r1" && !store.queue.length && notice(store, "n1", "w-r1 told"));
	const l = loop(t, 10, s.nudger);
	l.controller.startStatusRefresh(l.pi as never);
	t.mock.timers.tick(1000);
	assert.deepEqual(s.looked, ["r1:waiting", "r2:waiting"]);
	assert.deepEqual(s.pruned, [["r1", "r2"]]);
	assert.equal(l.messages.length, 1);
	assert.match(l.content(0), /^Subagent status:\n• w-r1 told\n/);
	assert.deepEqual(l.messages[0].message.details.nudgeNotices, ["n1"]);
	assert.deepEqual(l.messages[0].options, { triggerTurn: true, deliverAs: "steer" });
	assert.equal(s.store.queue.length, 1, "sent, not yet confirmed");
	l.start(0);
	assert.equal(s.store.queue.length, 0, "confirmed, so dequeued");
	l.runtime.runningSubagents.clear();
	t.mock.timers.tick(1000);
	assert.deepEqual(s.pruned.at(-1), [], "the last run gone: pruned before the loop stops");
	t.mock.timers.tick(5000);
	assert.equal(s.pruned.length, 2, "stopped");
	l.controller.stopRefresh();
	assert.equal(s.stops, 1, "a stop reaches the nudger");
});

test("F005, F009: the line cap never drops a notice; a send or a look that throws inside the tick waits for the next tick", (t) => {
	let looks = 0;
	const s = spied((run, store) => {
		if (++looks === 1) throw new Error("look failed");
		if (looks <= 3) notice(store, `n-${run.id}`, `${run.id} told`);
	});
	const l = loop(t, 1, s.nudger, { failFirst: true });
	l.controller.startStatusRefresh(l.pi as never);
	assert.doesNotThrow(() => t.mock.timers.tick(1000), "the look's throw stays in the tick");
	assert.doesNotThrow(() => t.mock.timers.tick(1000), "so does the send's");
	assert.equal(l.messages.length, 0, "the first send failed");
	assert.deepEqual(s.store.queue.map((n) => [n.text, n.sentAt]), [["r1 told", undefined], ["r2 told", undefined]], "kept, as not sent");
	t.mock.timers.tick(1000);
	assert.ok(l.messages.length >= 1, "sent at the next tick");
	const lines = l.content(0).split("\n");
	assert.deepEqual(lines.slice(1, 3), ["• r1 told", "• r2 told"], "both notices, with lineLimit 1");
	assert.equal(lines.length, 5, "then the capped status lines: one, and the count of the rest");
	assert.match(lines[4], /^• \+1 more running\.$/);
	l.start(0);
	assert.equal(s.store.queue.length, 0);
	t.mock.timers.tick(1000);
	assert.ok(l.messages.slice(1).every((m) => !m.message.content.includes("told")), "each notice once");
});

test("F009: a notice pi never confirms goes again while the parent is idle, and the loop outlives the last run until one is confirmed", (t) => {
	const s = spied();
	notice(s.store, "n1", "w-r1 told");
	const l = loop(t, 10, s.nudger, { runs: [] });
	l.controller.startStatusRefresh(l.pi as never);
	t.mock.timers.tick(1000);
	assert.equal(l.messages.length, 1, "sent with no run left");
	t.mock.timers.tick(RESEND_MS);
	assert.equal(l.messages.length, 1, "the parent's turn may still take it");
	l.parent.idle = true;
	t.mock.timers.tick(1000);
	assert.equal(l.messages.length, 2, "idle and unconfirmed: pi rejected it, so it goes again");
	assert.deepEqual(l.messages[1].message.details.nudgeNotices, ["n1"]);
	l.start(1);
	t.mock.timers.tick(1000);
	const ticks = s.pruned.length;
	t.mock.timers.tick(30 * MIN);
	assert.equal(s.pruned.length, ticks, "confirmed: the loop stopped");
	assert.equal(l.messages.length, 2);
});

test("F009: after a reload, resumeNotices sends the last load's unconfirmed notices with no run to start the loop", (t) => {
	const p = parents(join(dir(), "kid.jsonl"));
	const a = p.make("aaaa");
	a.look(p.run, waiting(0), 10 * MIN);
	a.look(p.run, waiting(0), 10 * MIN + ACK_MS);
	a.outbox(10 * MIN + ACK_MS, false);
	a.stop(10 * MIN + ACK_MS);
	const b = p.make("bbbb");
	const l = loop(t, 10, b, { runs: [] });
	l.parent.idle = true;
	l.controller.resumeNotices(l.pi as never);
	t.mock.timers.tick(1000);
	assert.equal(l.messages.length, 1);
	assert.match(l.content(0), /build-api has not delivered its result/);
	l.start(0);
	assert.equal(b.undelivered(), 0);
});

test("F009: resumeNotices with nothing unconfirmed starts nothing", (t) => {
	const s = spied();
	const l = loop(t, 10, s.nudger, { runs: [] });
	l.controller.resumeNotices(l.pi as never);
	t.mock.timers.tick(5000);
	assert.equal(s.pruned.length, 0);
	assert.equal(l.messages.length, 0);
});

// ── the cost of an idle poll ──

test("an idle child's poll is one stat of its run's folder: it lists the folder only when its mtime moved, or moved too recently to trust", () => {
	const c = child();
	c.inbox.poll();
	assert.deepEqual(c.calls, { stat: 1, readdir: 0 }, "no folder: one stat");
	mkdirSync(c.dir, { recursive: true });
	const old = new Date(Date.now() - 60_000);
	utimesSync(c.dir, old, old);
	c.inbox.poll();
	assert.deepEqual(c.calls, { stat: 2, readdir: 1 }, "a folder not seen before is listed");
	c.inbox.poll();
	c.inbox.poll();
	assert.deepEqual(c.calls, { stat: 4, readdir: 1 }, "unchanged since: one stat each");
	c.put();
	c.clock = 1;
	assert.deepEqual(c.inbox.poll(), ["sent"], "a request moves the mtime");
	assert.equal(c.calls.readdir, 2);
	c.inbox.poll();
	assert.equal(c.calls.readdir, 3, "a change too recent to trust: listed again");
	utimesSync(c.dir, old, old);
	c.inbox.poll();
	c.inbox.poll();
	assert.equal(c.calls.readdir, 4, "then once, and no more");
});
