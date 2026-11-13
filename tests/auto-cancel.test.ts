import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { asBoss } from "../src/autoscope.ts";
import { cancelledText, offNotice, onNotice } from "../src/autotext.ts";
import { createAutoMode } from "../src/server/automode.ts";
import { BACKSTOP_MS, createBackstop } from "../src/server/autoback.ts";
import type { Offer } from "../src/dialogs.ts";
import { questionsDigest, selectOf } from "../src/owners.ts";
import { type Agent, settle, until, World } from "./fakes.ts";

// Cancel at the transition (docs/specs/2026-11-09-auto-mode.md, §1, §4, §5; task 3): after the server's check, an owner that takes a cancel gets one, the rest go with the turn, sb's text replaces the result, command
// dialogs are left alone, and the server's backstop cancels what an older session left, once.

let world: World, clock = 1_800_000_000_000;
const asked: Record<string, unknown>[] = [];
beforeEach(() => {
	world = new World();
	asked.length = 0;
});
afterEach(() => world.stopAll());

const pi = { via: "pi" as const, name: "test" };
/** The server's side: the real module on this world's state directory; the session's `auto-check` is answered by it. */
const server = () => {
	const auto = createAutoMode({ dir: world.stateDir, now: () => clock, log: () => {} });
	auto.start();
	return auto;
};
const member = async (auto: ReturnType<typeof server>, id = "m1", pane = "wA:p1") => {
	const agent = world.agent({ id, pane, tab: "wA:t1", ui: true, deps: { adoptMs: 15, ask: async (request) => (asked.push(request), request.cmd === "auto-check" ? { ok: true, own: auto.check(request.rev, request.hash) } : { ok: false, error: "no server" }) } });
	await agent.start();
	return agent;
};
const sentTexts = (a: Agent) => a.sent.filter((m) => m.customType === "straw-auto");

const QUESTIONS = [{ question: "Which database?", header: "Database", options: [{ label: "pg" }, { label: "mysql" }], multiSelect: false }];
/** rpiv's ask_user_question open in `a`: its prompt, and a listener for the cancel sb sends it (which closes the dialog as the owner does). */
const rpivOpen = (a: Agent, toolCallId = "q1") => {
	const cancels: unknown[] = [];
	void a.fire("tool_execution_start", { toolCallId, toolName: "ask_user_question", args: {} });
	a.on("rpiv:ask-user:answer", (raw) => {
		cancels.push(raw);
		a.emit("rpiv:ask-user:blocked", { active: false, toolCallId });
	});
	a.emit("rpiv:ask-user:prompt", { toolCallId, questions: QUESTIONS });
	return cancels;
};

test("an open ask_user_question is cancelled once the server vouches for the on; the result is sb's text and no Esc note; the session is told once", async () => {
	const auto = server();
	const a = await member(auto);
	const cancels = rpivOpen(a);
	await settle();
	assert.equal(cancels.length, 0);
	auto.switchOn(pi);
	await until(() => cancels.length === 1, "the cancel");
	assert.deepEqual(cancels[0], { toolCallId: "q1", requestId: (cancels[0] as { requestId: string }).requestId, cancel: true });
	assert.match((cancels[0] as { requestId: string }).requestId, /^auto-/);
	const result = (await a.fireResult("tool_result", { toolName: "ask_user_question", toolCallId: "q1", input: {}, content: [{ type: "text", text: "User declined to answer questions" }], details: { cancelled: true }, isError: false })) as { content: { text: string }[] };
	assert.equal(result.content.length, 1);
	assert.match(result.content[0]!.text, /^sb: auto mode started at \d\d:\d\d: this ask_user_question was cancelled by sb, not by the boss, who is away\. Do not ask again or wait\./);
	assert.ok(!result.content[0]!.text.includes("slipped Esc"));
	await until(() => sentTexts(a).length >= 1, "the notice");
	assert.equal(a.aborted, 0, "no turn was aborted");
	const notices = sentTexts(a).filter((m) => m.content.includes(onNotice(auto.state().since).slice(0, 40)));
	assert.equal(notices.length, 1);
	assert.equal(notices[0]!.triggerTurn, undefined, "a notice starts no turn");
	assert.equal(notices[0]!.deliverAs, "nextTurn", "idle: nextTurn");
	await settle();
	await settle();
	assert.equal(sentTexts(a).filter((m) => m.content.includes("auto mode is on since")).length, 1, "once per confirmed rev");
	assert.equal(asked.filter((r) => r.cmd === "auto-note" && r.kind === "cancelled").length, 1);
	assert.equal((asked.find((r) => r.kind === "cancelled") as { gist: string }).gist, "Database");
});

test("a notice while a turn runs is a steer; the end of auto mode tells every session once", async () => {
	const auto = server();
	const a = await member(auto);
	a.idle = false;
	auto.switchOn(pi);
	await until(() => sentTexts(a).length === 1, "the on notice");
	assert.equal(sentTexts(a)[0]!.deliverAs, "steer");
	auto.switchOff(pi);
	await until(() => sentTexts(a).length === 2, "the off message");
	assert.match(sentTexts(a)[1]!.content, new RegExp(offNotice(undefined).replace(/\d\d:\d\d|\?/, ".+").slice(0, 40)));
	assert.match(sentTexts(a)[1]!.content, /do not ask again what you parked/);
	await settle();
	assert.equal(sentTexts(a).length, 2);
});

test("a robot_hand that takes no cancel goes with the turn: the turn is aborted, and once pi has settled the next turn starts with sb's text", async () => {
	const auto = server();
	const a = await member(auto);
	void a.fire("tool_execution_start", { toolCallId: "h1", toolName: "robot_hand", args: {} });
	a.emit("robot-hand:pending", { version: 1, id: "d1", toolCallId: "h1", digest: "x".repeat(64), select: { title: "Robot Hand — List it\n\n  ! ls", choices: [{ label: "Run it in a new Herdr pane" }, { label: "No, thanks" }] } });
	a.idle = false;
	await settle();
	auto.switchOn(pi);
	await until(() => a.aborted === 1, "the abort");
	assert.equal(sentTexts(a).length, 0, "nothing is sent while the turn is still unwinding");
	a.idle = true;
	await a.fire("agent_settled", {});
	const started = sentTexts(a).filter((m) => m.triggerTurn === true);
	assert.equal(started.length, 1);
	assert.match(started[0]!.content, /this robot_hand was cancelled by sb, not by the boss/);
	assert.match(started[0]!.content, /auto mode is on since/, "the first notice rides with it");
	const result = (await a.fireResult("tool_result", { toolName: "robot_hand", toolCallId: "h1", input: {}, content: [{ type: "text", text: "aborted" }], isError: true })) as { content: { text: string }[] };
	assert.match(result.content[0]!.text, /cancelled by sb/);
});

test("RC-F004: a robot_hand whose pending says cancellable gets {cancel: true, digest} under an auto- answerId, the turn is not aborted, sb's text replaces the result, and no Esc note is added", async () => {
	const auto = server();
	const a = await member(auto);
	const heard: Record<string, unknown>[] = [], digest = "d".repeat(64);
	void a.fire("tool_execution_start", { toolCallId: "h3", toolName: "robot_hand", args: {} });
	a.on("robot-hand:answer", (raw) => {
		heard.push(raw as Record<string, unknown>);
		const { id, answerId } = raw as { id: string; answerId: string };
		a.emit("robot-hand:answer-result", { version: 1, id, answerId, accepted: true });
		a.emit("robot-hand:closed", { version: 1, id, by: "cancel", answerId });
	});
	a.emit("robot-hand:pending", { version: 1, id: "d3", toolCallId: "h3", digest, cancellable: true, select: { title: "Robot Hand — List it\n\n  ! ls", choices: [{ label: "Run it in a new Herdr pane" }, { label: "No, thanks" }] } });
	await settle();
	auto.switchOn(pi);
	await until(() => heard.length === 1, "the cancel");
	assert.deepEqual({ ...heard[0], answerId: undefined }, { version: 1, id: "d3", answerId: undefined, digest, cancel: true });
	assert.match(String(heard[0]!.answerId), /^auto-[A-Za-z0-9-]+$/);
	const result = (await a.fireResult("tool_result", { toolName: "robot_hand", toolCallId: "h3", input: {}, content: [{ type: "text", text: "Robot Hand was dismissed" }], isError: false })) as { content: { text: string }[] };
	assert.equal(result.content.length, 1, "sb's text replaces the result");
	assert.match(result.content[0]!.text, /this robot_hand was cancelled by sb, not by the boss/);
	assert.ok(!result.content[0]!.text.includes("slipped Esc"), "no Esc note");
	assert.equal(a.aborted, 0, "the turn was not aborted");
});

test("a wait with nothing to abort and no turn running is told with a message that starts the next turn", async () => {
	const auto = server();
	const a = await member(auto);
	void a.fire("tool_execution_start", { toolCallId: "h2", toolName: "secret_drop", args: {} });
	a.emit("robot-hand:secret:pending", { version: 1, id: "s1", toolCallId: "h2", digest: "y".repeat(64), secret: { label: "token", instructions: ["go"], destination: "env" } });
	await settle();
	auto.switchOn(pi);
	await until(() => sentTexts(a).some((m) => m.triggerTurn === true), "the started turn");
	assert.equal(a.aborted, 0);
	assert.match(sentTexts(a).find((m) => m.triggerTurn)!.content, /this secret_drop was cancelled by sb/);
});

test("a dialog under the boss's own command is left alone at the transition", async () => {
	const auto = server();
	const a = await member(auto);
	await a.fire("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: {} });
	const mine = asBoss(() => (a.ui.confirm as (t: string, m: string) => Promise<unknown>)("Stop api-main?", "Presses Esc there"));
	await settle();
	assert.equal(a.dialogs.length, 1);
	assert.ok(a.emitted.some(([channel]) => channel === "straw-boss:ui:pending"), "the confirm is relayed to the page, so the bridge lists it");
	a.idle = false;
	auto.switchOn(pi);
	await until(() => asked.some((r) => r.cmd === "auto-check"), "the check");
	await settle();
	await settle();
	assert.equal(a.dialogs[0]!.settled, false, "the boss's confirm is still waiting for them");
	assert.equal(a.aborted, 0);
	a.dialogs[0]!.settle(true);
	assert.equal(await mine, true);
});

test("a foreign write cancels nothing, and its put-back (the server's own state, off) cancels nothing either", async () => {
	const auto = server();
	const a = await member(auto);
	const cancels = rpivOpen(a);
	// a forged on, with a valid hash, that the server has not put back yet
	const { seal } = await import("../src/autostate.ts");
	const { writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	writeFileSync(join(world.stateDir, "auto.json"), `${JSON.stringify(seal({ v: 1, rev: 40, on: true, since: new Date().toISOString(), by: { via: "pi", name: "forged" } }))}\n`);
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(cancels.length, 0);
	assert.ok(asked.filter((r) => r.cmd === "auto-check").length >= 1);
	// the server puts it back as what it holds (off): nothing is ever cancelled by a write the server did not make
	auto.tick();
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(cancels.length, 0);
	assert.equal(auto.view().on, false);
});

test("the refusal follows the file at once; the cancel waits for the check (a session asks again each poll while the server is out of reach)", async () => {
	const auto = server();
	let up = false;
	const a = world.agent({ id: "m2", pane: "wA:p2", tab: "wA:t1", ui: true, deps: { adoptMs: 15, ask: async (request) => (request.cmd === "auto-check" ? (up ? { ok: true, own: auto.check(request.rev, request.hash) } : { ok: false, error: "no server" }) : { ok: false }) } });
	await a.start();
	const cancels = rpivOpen(a, "q9");
	auto.switchOn(pi);
	const out = (await a.fireResult("tool_call", { toolName: "robot_hand", toolCallId: "n", input: {} })) as { block?: boolean };
	assert.equal(out.block, true, "refusals follow the file");
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(cancels.length, 0, "no cancel without the server");
	up = true;
	await until(() => cancels.length === 1, "the cancel once the server answers");
});

// --- the backstop ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const offer = (key: string, dialog: string, over: { cancel?: boolean } = {}): Offer => ({
	key, owner: "rpiv", target: { from: key, bridgeId: "b", answer: { dialog, digest: questionsDigest([{ question: "Q", header: "Ship it?", multiple: false, options: [{ title: "yes" }] }]), questions: [{ question: "Q", header: "Ship it?", multiple: false, options: [{ title: "yes" }] }], ...(over.cancel === false ? {} : { cancel: true as const }) } },
});

test("the backstop: a wait older than 30 s gets the GUI's cancel once, with an intercom message; a re-ask is listed, not cancelled again; a dialog with no cancel is listed as still waiting", async () => {
	const auto = server();
	auto.switchOn(pi);
	let offers: Offer[] = [offer("s1", "d1"), offer("s2", "d2", { cancel: false })];
	const sent: { key: string; answer: Record<string, unknown> }[] = [], told: [string, string][] = [];
	const back = createBackstop({ auto, now: () => clock, read: async () => {}, answerable: () => offers, send: async (key, _t, answer) => void sent.push({ key, answer: { ...answer } }), tell: async (to, text) => void told.push([to, text]) });
	await back.tick();
	assert.equal(sent.length, 0, "not before 30 s");
	clock += BACKSTOP_MS - 1;
	await back.tick();
	assert.equal(sent.length, 0);
	clock += 1;
	await back.tick();
	await back.tick();
	assert.equal(sent.length, 1, "once");
	assert.deepEqual([sent[0]!.key, sent[0]!.answer.id, sent[0]!.answer.cancel], ["s1", "d1", true]);
	assert.match(String(sent[0]!.answer.answerId), /^auto-/);
	assert.equal(told.length, 1);
	assert.deepEqual(told[0], ["s1", cancelledText(auto.state().since, "rpiv", "main")]);
	// a re-ask by the same session
	offers = [offer("s1", "d3"), offer("s2", "d2", { cancel: false })];
	await back.tick();
	clock += BACKSTOP_MS;
	await back.tick();
	assert.equal(sent.length, 1, "never cancelled again");
	const kinds = (auto.period()?.notes ?? []).map((n) => `${n.session}:${n.kind}`).sort();
	assert.deepEqual(kinds, ["s1:backstop", "s1:re-asked", "s2:still-waiting"]);
	assert.equal(auto.period()!.notes.find((n) => n.kind === "backstop")!.gist, "Ship it?");
});

test("AMC-F005: the backstop leaves sb's own /boss command confirm to the boss, and words the cancel for the unit's kind", async () => {
	const auto = server();
	auto.switchOn(pi);
	const base = offer("s1", "d1"), command: Offer = { ...base, key: "s9", target: { ...base.target, answer: { ...base.target.answer, dialog: "d9", command: true } } };
	const sent: string[] = [], told: [string, string][] = [];
	const back = createBackstop({ auto, now: () => clock, read: async () => {}, answerable: () => [base, command], send: async (key) => void sent.push(key), tell: async (to, text) => void told.push([to, text]), kindOf: (key) => (key === "s1" ? "subagent" : "main") });
	await back.tick();
	clock += BACKSTOP_MS;
	await back.tick();
	assert.deepEqual(sent, ["s1"], "the command's confirm is not cancelled");
	assert.deepEqual(told, [["s1", cancelledText(auto.state().since, "rpiv", "subagent")]], "the tail fits the unit's kind");
	assert.deepEqual((auto.period()?.notes ?? []).map((n) => n.session), ["s1"], "and not listed either");
});

test("AMC-F005: the relayed /boss confirm carries the command mark to the hub", async () => {
	const auto = server();
	const a = await member(auto);
	await a.fire("tool_execution_start", { toolCallId: "b1", toolName: "bash", args: {} });
	void asBoss(() => (a.ui.confirm as (t: string, m: string) => Promise<unknown>)("Stop api-main?", "x"));
	await settle();
	const pending = a.emitted.find(([channel]) => channel === "straw-boss:ui:pending")?.[1] as { command?: boolean } | undefined;
	assert.equal(pending?.command, true);
	assert.equal(selectOf("straw-boss-ui", pending)?.command, true, "the bridge's dialog keeps it");
	assert.equal(selectOf("straw-boss-ui", { ...(pending as object), command: undefined })?.command, undefined);
	const other = a.emitted.filter(([channel]) => channel === "straw-boss:ui:pending").length;
	assert.equal(other, 1);
});

test("the backstop does nothing while auto mode is off, and forgets its list when a new period starts", async () => {
	const auto = server();
	const sent: unknown[] = [];
	const back = createBackstop({ auto, now: () => clock, read: async () => {}, answerable: () => [offer("s1", "d1")], send: async (_k, _t, a) => void sent.push(a), tell: async () => {} });
	await back.tick();
	clock += 2 * BACKSTOP_MS;
	await back.tick();
	assert.equal(sent.length, 0, "off");
	auto.switchOn(pi);
	await back.tick();
	clock += BACKSTOP_MS;
	await back.tick();
	assert.equal(sent.length, 1);
	auto.switchOff(pi);
	clock += 1000;
	auto.switchOn(pi);
	await back.tick();
	clock += BACKSTOP_MS;
	await back.tick();
	assert.equal(sent.length, 2, "a new period starts the list afresh");
});

test("auto-note keeps a refusal's tool and gist while on, at most 500 a period, and nothing while off", () => {
	const auto = server();
	assert.deepEqual(auto.note({ kind: "refused", tool: "robot_hand", session: "s", gist: "x" }), { ok: false, error: "auto mode is off" });
	auto.switchOn(pi);
	assert.equal(auto.note({ kind: "refused", tool: "robot_hand", session: "s", gist: "x".repeat(300) }).ok, true);
	assert.equal(auto.period()!.notes[0]!.gist.length, 120);
	assert.equal(auto.note({ kind: "nonsense", tool: "t" }).ok, false);
	for (let i = 0; i < 520; i++) auto.note({ kind: "refused", tool: "t", session: "s", gist: String(i) });
	assert.equal(auto.period()!.notes.length, 500);
});

test("AMC-F001: rpiv drawn with ui.custom is cancelled by its owner and the turn is not aborted", async () => {
	const auto = server();
	const a = await member(auto);
	const cancels = rpivOpen(a);
	// the real rpiv draws its questionnaire with ctx.ui.custom
	void (a.ui.custom as (f: () => unknown) => unknown)(() => ({ render: () => [] }));
	a.idle = false;
	await settle();
	auto.switchOn(pi);
	await until(() => cancels.length === 1, "the cancel");
	await settle();
	await settle();
	assert.equal(a.aborted, 0, "an owner that took the cancel costs no turn");
});
