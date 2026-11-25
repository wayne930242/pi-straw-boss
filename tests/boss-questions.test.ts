import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AUTO_FILE, seal } from "../src/autostate.ts";
import { refusedText } from "../src/autotext.ts";
import { createAutoMode } from "../src/server/automode.ts";
import { createBossAsk, OWN_ANSWER } from "../src/bossask.ts";
import { CALL_TOWER_DESCRIPTION } from "../src/link/waitcall.ts";
import type { Kit } from "../src/state.ts";
import { strip } from "../src/trainswitch.ts";
import { type Agent, PROMPT_DIR, settle, until, World } from "./fakes.ts";

// The boss question drawn by code (docs/specs/2026-11-25-idle-wrap-up.md part 2, as rewritten for 0.91.0; boss 2026-11-25: 「「自己問我」應該做成程式碼，直接從程式碼發出」). `call_tower` with `why: blocked` and
// `boss` draws the question in the main's own pane, and the answer is the result; nothing goes to the tower. Under auto mode, in a teammate's turn, on an unattended device, without a terminal, and for a session that is
// no tab's main, the question goes to the tower as `blocked`, as before. The standing prompts carry no rule about it (0.90.0's sentences are gone).

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const read = (file: string) => readFileSync(join(PROMPT_DIR, file), "utf8");
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text).join("");
const auto = (on: boolean, rev: number) => writeFileSync(join(world.stateDir, AUTO_FILE), `${JSON.stringify(seal({ v: 1, rev, on, ...(on ? { since: "2026-11-25T00:00:00Z" } : {}), by: { via: "pi", name: "test" } }))}\n`);
const toTower = () => world.broker.delivered.filter((d) => d.to === "tower-wA");

/** A promoted main with a terminal and a tower; the dialog's watch of auto mode runs when the test calls `tick`. */
async function rig() {
	const ticks: (() => void)[] = [];
	const tower = world.tower("tower-wA", "wA:t9", "wA:p9");
	await tower.start();
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1", ui: true, deps: { face: { every: (fn) => (ticks.push(fn), () => void ticks.splice(ticks.indexOf(fn), 1)) } } });
	await a.start();
	await a.promote();
	return { a, tick: () => ticks.forEach((fn) => fn()), watching: () => ticks.length };
}
const ask = (a: Agent, boss: Record<string, unknown>, extra: Record<string, unknown> = {}) => a.tool("call_tower", { message: "deploy MP-1 to prod needs a go", why: "blocked", boss, ...extra });

test("the standing prompts carry none of 0.90.0's sentences: main.md's blocked covers a decision again, tower-run.md routes it as in 0.89.0; call_tower names boss in one clause", () => {
	const main = read("main.md");
	for (const gone of ["ask him yourself with `ask_user_question`", "other than the boss", "parks it and it returns as `wait_returned` when he is back", "call `boss_wrap`", "daily memory entry"]) assert.ok(!main.includes(gone), `main.md: ${gone}`);
	assert.ok(main.includes("`blocked` when you wait on someone outside your tab or on a decision your authorizations do not cover, or need a work's owner and do not know who"));
	assert.ok(main.includes("its worktree is removed, and your board is cleared."));
	for (const off of [false, true]) {
		const run = strip(read("tower-run.md"), off);
		for (const gone of ["A local main's decision only the boss can make", "ask the boss itself with `ask_user_question`", "Any other decision only the boss can make"]) assert.ok(!run.includes(gone), `tower-run.md: ${gone}`);
		assert.ok(run.includes("`blocked` or unspecified: route it to its owner. A decision only the boss can make is not sent back to the caller: record a wait for the boss in your memory"));
	}
	assert.match(CALL_TOWER_DESCRIPTION, /blocked \(you wait on someone outside your tab, or on a decision your authorizations do not cover; the boss's own decision: boss, asked in your pane\)/);
	assert.doesNotMatch(CALL_TOWER_DESCRIPTION, /ask_user_question/);
});

test("auto mode off: the question is drawn in this pane with the options and a typed answer, the boss's choice is the result, and nothing goes to the tower", async () => {
	const r = await rig();
	const pending = ask(r.a, { question: "Deploy  MP-1\nto prod now?", options: ["Deploy", "Wait for QA"] });
	await until(() => r.a.dialogs.length === 1, "drawn in the pane");
	assert.deepEqual([r.a.dialogs[0]!.kind, r.a.dialogs[0]!.title, r.a.dialogs[0]!.second], ["select", "The boss decides: Deploy MP-1 to prod now?", ["Deploy", "Wait for QA", OWN_ANSWER]]);
	assert.equal(r.watching(), 1, "auto mode is watched while the dialog is open");
	r.a.dialogs[0]!.settle("Wait for QA");
	const done = await pending;
	assert.equal(textOf(done), 'The boss chose: "Wait for QA". This is the boss\'s answer, asked in this pane; nothing was sent to the tower.');
	assert.deepEqual(done.details, { boss: "answered" });
	assert.equal(r.watching(), 0, "the watch ends with the dialog");
	// The typed answer: the select's last row, or no options at all.
	r.a.ui.input = (async () => "  only after the 3 pm backup ") as never;
	const typed = ask(r.a, { question: "Deploy now?", options: ["Deploy"] });
	await until(() => r.a.dialogs.length === 2, "drawn again");
	r.a.dialogs[1]!.settle(OWN_ANSWER);
	assert.match(textOf(await typed), /^The boss answered: "only after the 3 pm backup"\./);
	assert.match(textOf(await ask(r.a, { question: "Which window?" })), /^The boss answered: "only after the 3 pm backup"\./);
	await settle();
	assert.equal(toTower().length, 0, "no intercom to the tower");
});

test("Esc: the boss did not answer, and nothing is sent", async () => {
	const r = await rig();
	const pending = ask(r.a, { question: "Deploy now?", options: ["Deploy", "Wait"] });
	await until(() => r.a.dialogs.length === 1, "drawn");
	r.a.dialogs[0]!.settle(undefined);
	assert.match(textOf(await pending), /^The boss did not answer \(Esc\): nothing was sent to the tower\./);
	r.a.ui.input = (async () => undefined) as never;
	assert.match(textOf(await ask(r.a, { question: "Which window?" })), /did not answer \(Esc\)/);
	await settle();
	assert.equal(toTower().length, 0);
});

test("auto mode on: no dialog; the question goes to the tower as blocked, and the result says it comes back as wait_returned", async () => {
	const r = await rig();
	auto(true, 1);
	const done = await ask(r.a, { question: "Deploy MP-1 to prod?", options: ["Deploy", "Wait"] });
	assert.equal(r.a.dialogs.length, 0, "nothing drawn");
	assert.match(textOf(done), /^Sent to the tower of .*Auto mode is on \(the boss is away\): the tower parks it, and it comes back to you as a wait_returned message when he is back\. Ask him again then, with call_tower boss\.$/);
	const sent = toTower();
	assert.equal(sent.length, 1);
	assert.match(sent[0]!.message, /why=blocked/);
	assert.match(sent[0]!.message, /deploy MP-1 to prod needs a go\nFor the boss: Deploy MP-1 to prod\?\nOptions: Deploy \| Wait$/);
});

test("auto mode starting while the dialog is open: the dialog closes and the question goes to the tower as blocked", async () => {
	const r = await rig();
	const pending = ask(r.a, { question: "Deploy now?", options: ["Deploy", "Wait"] });
	await until(() => r.a.dialogs.length === 1, "drawn");
	r.tick();
	assert.equal(r.a.dialogs[0]!.settled, false, "auto mode off: the dialog stays");
	auto(true, 1);
	r.tick();
	assert.equal(r.a.dialogs[0]!.settled, true, "dismissed");
	assert.match(textOf(await pending), /Auto mode started while the boss was asked, so the dialog closed\. Auto mode is on/);
	assert.equal(toTower().length, 1);
	assert.match(toTower()[0]!.message, /why=blocked[\s\S]*For the boss: Deploy now\?/);
});

test("boss goes with why blocked alone, and is refused beside waitsOn, linkWait, or standing; a member's question goes to the tower with no dialog", async () => {
	const r = await rig();
	await assert.rejects(ask(r.a, { question: "Deploy?" }, { why: "milestone" }), /boss goes with why blocked/);
	await assert.rejects(ask(r.a, { question: "Deploy?" }, { standing: { device: "mac" } }), /do not go together/);
	await assert.rejects(ask(r.a, { question: " " }), /boss\.question is required/);
	const m = world.agent({ id: "mem-1", pane: "wA:p2", tab: "wA:t1", ui: true });
	await m.start();
	await ask(m, { question: "Deploy?", options: ["Yes"] });
	assert.equal(m.dialogs.length + r.a.dialogs.length, 0, "nothing drawn");
	assert.match(toTower().at(-1)!.message, /For the boss: Deploy\?\nOptions: Yes$/);
});

test("a teammate's turn, an unattended device, no terminal, a train or a tower: no dialog, the question goes to the tower", async () => {
	const kit = (s: Record<string, unknown>, role = "main") => ({ cfg: { face: { every: () => () => {} } }, s: { autoOn: () => false, isTrain: false, isTower: false, ...s }, role: () => role }) as unknown as Kit;
	const ui = { select: async () => { throw new Error("drawn"); }, input: async () => { throw new Error("drawn"); } } as never;
	const q = { question: "Deploy?" }, attended = () => true, local = () => false;
	assert.deepEqual(await createBossAsk(kit({ remoteOrigin: "bob" }), { attended, remote: local })(q, undefined, { hasUI: true, ui }), { kind: "tower" });
	assert.deepEqual(await createBossAsk(kit({}), { attended, remote: () => true })(q, undefined, { hasUI: true, ui }), { kind: "tower" }, "a remote scope");
	assert.deepEqual(await createBossAsk(kit({}), { attended: () => false, remote: local })(q, undefined, { hasUI: true, ui }), { kind: "tower" }, "unattended");
	assert.deepEqual(await createBossAsk(kit({}), { attended, remote: local })(q, undefined, { hasUI: false, ui }), { kind: "tower" }, "no terminal");
	assert.deepEqual(await createBossAsk(kit({ isTrain: true }, "train"), { attended, remote: local })(q, undefined, { hasUI: true, ui }), { kind: "tower" }, "a train");
	assert.deepEqual(await createBossAsk(kit({ isTower: true }, "tower"), { attended, remote: local })(q, undefined, { hasUI: true, ui }), { kind: "tower" }, "a tower");
});

test("under auto mode, a main's ask_user_question is refused with the way to park it: call_tower blocked with the decision in boss", () => {
	assert.match(refusedText("2026-11-25T00:00:00Z", "ask_user_question", "main"), /park it: call_tower why: blocked with the decision in boss and what you need/);
});

test("auto mode's own transition cancelling the relayed dialog first: the question still goes to the tower, and the call keeps its result (with the parking line), not sb's cancel text", async () => {
	const mode = createAutoMode({ dir: world.stateDir, now: Date.now, log: () => {} });
	mode.start();
	const tower = world.tower("tower-wA", "wA:t9", "wA:p9");
	await tower.start();
	const a = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1", ui: true, deps: { adoptMs: 15, face: { every: () => () => {} }, ask: (request, o) => (request.cmd === "auto-check" ? Promise.resolve({ ok: true, own: mode.check(request.rev as number, request.hash as string) }) : world.ask(request, o)) } });
	await a.start();
	await a.promote();
	await a.fire("tool_execution_start", { toolCallId: "c1", toolName: "call_tower", args: {} }); // the wrap of ctx.ui relays the select as the call's dialog
	const pending = a.tool("call_tower", { message: "deploy needs a go", why: "blocked", boss: { question: "Deploy now?", options: ["Deploy", "Wait"] } }, { id: "c1" });
	await until(() => a.dialogs.length === 1, "drawn");
	mode.switchOn({ via: "pi", name: "test" });
	const done = await pending;
	assert.equal(a.dialogs[0]!.settled, true, "the transition cancelled it");
	assert.match(textOf(done), /Auto mode started while the boss was asked/);
	assert.match(toTower().at(-1)!.message, /For the boss: Deploy now\?/);
	const result = (await a.fireResult("tool_result", { toolName: "call_tower", toolCallId: "c1", input: { why: "blocked" }, content: done.content, isError: false })) as { content: { text: string }[] };
	assert.equal(result.content[0]!.text, textOf(done), "its own result stays");
	assert.match(result.content[1]!.text, /^Auto mode: no answer from the boss before it ends\./);
});
