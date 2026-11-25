import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { PAIR_DESCRIPTION } from "../src/bosspair.ts";
import { CAR_OFF_MESSAGE, registerCarOff, slipMessage } from "../src/carslip.ts";
import { withMoment } from "../src/link/waitcall.ts";
import { ACT_ON_IT, BLOCKED_NOTE, CALL_TOWER_DESCRIPTION, CAR_OFF_NOTE, MAIN_CAP_HINT, NUDGE_TEXT, SLIP_NOTE, withNext } from "../src/moments.ts";
import { handoff } from "../src/opener.ts";
import { returnedText } from "../src/server/autotower.ts";
import { STANDING_HINT } from "../src/standinghint.ts";
import { strip } from "../src/trainswitch.ts";
import { PROMPT_DIR, World } from "./fakes.ts";

// Just-in-time prompts (docs/specs/2026-11-26-just-in-time-prompts.md; boss 2026-11-25 「main 的提示好像太多 … 請注意這個原則，提示詞可以逐步交付」, 2026-11-26 「只搬 sb 自己的」): a rule main.md held for one moment
// left it, and the text that arrives at that moment carries it in the same or clearer words. Each row: what main.md no longer says, and where the main reads it now.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const raw = readFileSync(`${PROMPT_DIR}/main.md`, "utf8"), on = strip(raw, false), off = strip(raw, true);
const gone = (...clauses: string[]) => { for (const c of clauses) for (const [t, label] of [[raw, "raw"], [on, "on"], [off, "off"]] as const) assert.ok(!t.includes(c), `main.md (${label}) still says ${c}`); };

test("capacity and idle: the notice to a main's own session and the idle nudge carry the dispatch rule; main.md keeps its shortest form", () => {
	gone("report idle", "A capacity notice on your work", "sb's: board it");
	// RV-F001: under auto mode no nudge comes and, without a capacity budget, no `under` either, so the shortest form stays in main.md.
	assert.ok(raw.includes("Idle with ready todos: dispatch them."));
	assert.ok(MAIN_CAP_HINT.includes("dispatch its ready work now, or say why not (blocked, shared files, the boss) on your board with board_set, and reply to whoever asked"), "RV-F003");
	assert.ok(NUDGE_TEXT.includes("dispatch your ready todos now; none ready, take your next eligible work"));
});

test("pairing, kind, board, and call_tower: the tool descriptions carry the details, main.md the triggers", async () => {
	gone("brief both", "relay nothing", "`boss_duty`", "watching, not finishing tasks", "`board_set`", "Keep secrets", "allies' towers read it", "port, database", "stop on a named clash", "the tower finds them", "`waitsOn`", "reply: false");
	assert.ok(raw.includes("A reviewed change goes through `boss_pair`."), "the pointer stays: without it a main reviews with its own reviewer flow and opens no thread");
	assert.ok(PAIR_DESCRIPTION.includes("you write both briefs") && PAIR_DESCRIPTION.includes("Thread: T<n>") && PAIR_DESCRIPTION.includes("woken only by their two results when the thread closes; do not relay"));
	assert.ok(raw.includes("Your work board fills itself from your todos and name: keep them current."));
	for (const term of ["`milestone` when a task landed or a tower request is done", "`shared` before you change anything outside your tab", "`blocked` when you wait on someone outside your tab", "Progress and incidents go on your board: never call the tower to report them."]) assert.ok(raw.includes(term), term);
	for (const term of ["reply false unless needed", "port, database, shared branch, deploy target, another app's checkout, running service", "say what and for how long", "go ahead at once, and stop only on a clash the tower names", "need a work's owner and do not know who: say what, the tower finds them", "a teammate device: waitsOn"]) assert.ok(CALL_TOWER_DESCRIPTION.includes(term), `call_tower: ${term}`);
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.promote();
	assert.match(a.tools.get("boss_duty")!.description, /standing \(watching, not finishing tasks\) minds one system/);
	assert.ok(STANDING_HINT.includes("`boss_duty standing`"), "the hint at the first boss_watch");
	assert.match(a.tools.get("board_set")!.description, /until your todos move.*no secrets, credentials, customer data, or paths outside the project\. Not a report: the done report still goes to whoever asked\./);
});

test("waits: call_tower's blocked result names the wait_card answer and boss_wait_ask, the wait_card message says to act, wait_returned says how to ask again", () => {
	gone("`wait_card`", "`wait_returned`", "Re-ask a wait");
	const r = withMoment({ text: "Sent to the tower of Alpha. It replies through intercom." }, "need a go", "blocked");
	assert.equal(r.text, `Sent to the tower of Alpha. It replies through intercom. ${BLOCKED_NOTE}`);
	assert.ok(BLOCKED_NOTE.includes("wait_card message: act on it (it says when to call secret_drop)") && BLOCKED_NOTE.includes("only with boss_wait_ask"));
	assert.equal(withMoment({ text: "x" }, "landed", "milestone").text, "x", "a milestone gets no note");
	assert.equal(ACT_ON_IT, "This is the boss's answer to your wait: act on it.");
	assert.match(returnedText("W1", "go?", "2026-11-26T01:00:00Z", "main"), /ask them again now with call_tower why: blocked and boss/);
});

test("a main a tower opened reads its report and close in the brief that opens it", () => {
	gone("If a tower opened your tab", "wait to be closed");
	const brief = handoff("Alpha", { id: "s-1", name: "asker" }, "do x", { id: "t-1", name: "tower" });
	assert.ok(brief.includes("report the outcome to the sender with intercom send and to the tower that opened this tab with call_tower (why: milestone, reply: false). Then wait; the tower closes this tab"));
});

test("integration: main.md keeps the base rule and the slip's route; the slip's result, the car notices, and the slip that reaches a main with integration off say the rest", () => {
	gone("Light checks", "rework a returned car", "a car slip waits for sb's car notice", "sb's car notice says landed", "A `car:` block sent to you");
	assert.ok(on.includes("never merge to its base; never claim a pre-dev branch unless your kind is `integrator`; send its car slip by the Seam bindings at the end of this prompt."));
	const slip = "car: web | tickets: T-1 | branch: feat/x | head: " + "a".repeat(40);
	assert.equal(withMoment({ text: "Sent." }, slip, "shared").text, `Sent. ${SLIP_NOTE}`);
	assert.equal(withMoment({ text: "Sent." }, "port 5432 for 1 h", "shared").text, "Sent.", "a plain heads-up gets no note");
	assert.equal(withNext("received", "received: your car T-1 (aaaaaaaaaaaa) rides train 1106m; it departs next"), "received: your car T-1 (aaaaaaaaaaaa) rides train 1106m; it departs next. Its task has not landed yet: wait for the landed notice.");
	assert.equal(withNext("returned", "returned: your car T-1 (aaaaaaaaaaaa): no accept."), "returned: your car T-1 (aaaaaaaaaaaa): no accept. Rework the car, then send a new car slip.");
	assert.equal(withNext("landed", "landed in 1.2.0, your commit is abc"), "landed in 1.2.0, your commit is abc. Its task has landed: complete its todo.");
	assert.equal(withNext("dropped", "dropped from train 1106m round 1: red; evidence /e"), "dropped from train 1106m round 1: red; evidence /e");
	// A slip that reaches a main with integration off: the main is told once how to answer, since an outbox message cannot answer an ask.
	const handlers: ((e: unknown, ctx: unknown) => void)[] = [], sent: unknown[][] = [];
	let off = true;
	registerCarOff({ on: (name: string, fn: (e: unknown, ctx: unknown) => void) => void (name === "message_end" && handlers.push(fn)), sendMessage: (...args: unknown[]) => void sent.push(args) } as never, () => off);
	const msg = (id: string, body: string) => ({ message: { role: "custom", customType: "intercom_message", content: `**From x**\n\n${body}`, details: { bodyText: body, message: { id } } } });
	const ctx = { isIdle: () => false };
	handlers[0]!(msg("m1", slip), ctx);
	handlers[0]!(msg("m1", slip), ctx);
	handlers[0]!(msg("m2", "no slip here"), ctx);
	handlers[0]!({ message: { role: "user", content: slip } }, ctx);
	assert.deepEqual(sent, [[{ customType: CAR_OFF_MESSAGE, content: CAR_OFF_NOTE, display: true }, { deliverAs: "steer" }]]);
	assert.ok(CAR_OFF_NOTE.includes('answer its sender "integration is off on this computer"'));
	off = false;
	handlers[0]!(msg("m3", slip), ctx);
	assert.equal(sent.length, 1, "integration on: no note");
	assert.equal(slipMessage({ role: "custom", customType: "straw-link", content: slip }), undefined);
});
