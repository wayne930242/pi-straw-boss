import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AUTO_FILE, seal } from "../src/autostate.ts";
import { createRemoteTurns } from "../src/link/hooks.ts";
import { MESSAGE_TYPE } from "../src/link/turn.ts";
import { IDLE_MS, idleClock, NUDGE_TEXT, WRAP_DESCRIPTION, WRAP_MESSAGE } from "../src/wrapup.ts";
import { type Agent, PROMPT_DIR, settle, until, World } from "./fakes.ts";
import { bob, TEAM_HEX } from "./link/holder-world.ts";

// Idle wrap-up (docs/specs/2026-11-25-idle-wrap-up.md, part 1): a coordinator or integrator main idle 30 minutes is asked once whether its work is done, and boss_wrap asks the boss in its pane before it
// reports to the tower, clears the board, and closes the session. The clock is the test's own (`now`), and the look runs when the test calls it (`idleLook`).

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text).join("");

test("the clock: due once after 30 idle minutes, the nudge's own turn is no new work, a new turn opens a new period", () => {
	let t = 0;
	const c = idleClock(() => t);
	t = IDLE_MS - 1;
	assert.equal(c.due(false), false);
	t = IDLE_MS;
	assert.equal(c.due(false), true);
	c.sent();
	assert.equal(c.due(false), false);
	c.start(); // the turn the nudge started
	assert.equal(c.due(false), false, "not while a turn runs");
	t += 5000;
	c.settle();
	t += 3 * IDLE_MS;
	assert.equal(c.due(false), false, "once per idle period");
	c.start(); // new work
	c.settle();
	t += IDLE_MS - 1;
	assert.equal(c.due(false), false);
	t += 1;
	assert.equal(c.due(false), true, "a new period after new work");
});

test("the clock: auto mode stops it and it starts again when the boss is back; the boss's no holds it until new work", () => {
	let t = 0;
	const c = idleClock(() => t);
	t = 2 * IDLE_MS;
	assert.equal(c.due(true), false, "no nudge while the boss is away");
	assert.equal(c.due(false), false, "the clock starts again when he is back");
	t += IDLE_MS;
	assert.equal(c.due(false), true);
	c.hold();
	t += IDLE_MS;
	assert.equal(c.due(false), false, "the boss said not yet");
	c.start();
	c.settle();
	t += IDLE_MS;
	assert.equal(c.due(false), true);
});

/** A session whose clock and look the test drives. */
function rig(options: { id: string; pane: string; tab: string; env?: Record<string, string> }) {
	let off = 0;
	const looks: (() => Promise<void>)[] = [];
	const a = world.agent({ ...options, ui: true, deps: { now: () => Date.now() + off, idleLook: (fn) => (looks.push(fn), () => {}) } });
	return {
		a,
		advance: (ms: number) => void (off += ms),
		look: async () => (await looks.at(-1)!(), await settle()),
		nudges: () => a.sent.filter((m) => m.customType === WRAP_MESSAGE),
	};
}
async function mainRig() {
	const r = rig({ id: "main-1", pane: "wA:p1", tab: "wA:t1" });
	await r.a.start();
	await r.a.promote();
	return r;
}
const turn = async (a: Agent) => (await a.fire("agent_start"), await a.fire("agent_settled"));
const auto = (on: boolean, rev: number) => writeFileSync(join(world.stateDir, AUTO_FILE), `${JSON.stringify(seal({ v: 1, rev, on, ...(on ? { since: "2026-11-25T00:00:00Z" } : {}), by: { via: "pi", name: "test" } }))}\n`);

test("a coordinator main idle 30 minutes gets one nudge; its own turn does not count, a new turn does", async () => {
	const r = await mainRig();
	r.advance(IDLE_MS - 60_000);
	await r.look();
	assert.equal(r.nudges().length, 0, "not before 30 minutes");
	r.advance(60_000);
	await r.look();
	assert.deepEqual(r.nudges().map((m) => [m.content, m.triggerTurn]), [[NUDGE_TEXT, true]]);
	for (const term of ["metadata.waitsOn", "boss_wrap", "daily memory entry", "clean up stale todos"]) assert.ok(NUDGE_TEXT.includes(term), term);
	await turn(r.a); // the nudge's turn
	r.advance(2 * IDLE_MS);
	await r.look();
	assert.equal(r.nudges().length, 1, "once per idle period");
	await turn(r.a); // new work
	r.advance(IDLE_MS);
	await r.look();
	assert.equal(r.nudges().length, 2);
});

test("no nudge under auto mode; the clock starts again when it ends", async () => {
	const r = await mainRig();
	auto(true, 1);
	r.advance(2 * IDLE_MS);
	await r.look();
	assert.equal(r.nudges().length, 0);
	auto(false, 2);
	await r.look();
	assert.equal(r.nudges().length, 0, "the clock restarted");
	r.advance(IDLE_MS);
	await r.look();
	assert.equal(r.nudges().length, 1);
});

test("no nudge for a standing main, a member, or a tower", async () => {
	const r = await mainRig();
	await r.a.tool("boss_duty", { duty: "standing", reason: "it minds the box" });
	const m = rig({ id: "mem-1", pane: "wA:p2", tab: "wA:t1" });
	await m.a.start();
	const t = rig({ id: "tower-wA", pane: "wA:p9", tab: "wA:t9", env: { STRAW_BOSS_ROLE: "tower" } });
	await t.a.start();
	for (const x of [r, m, t]) (x.advance(2 * IDLE_MS), await x.look());
	assert.deepEqual([r, m, t].map((x) => x.nudges().length), [0, 0, 0]);
});

test("no nudge while a monitor, a loop, or a subagent runs", async () => {
	const r = await mainRig();
	r.advance(IDLE_MS);
	r.a.emit("monitor:started", { monitorId: "1", command: "npm test" });
	await r.look();
	assert.equal(r.nudges().length, 0, "a monitor");
	r.a.emit("monitor:finished", { monitorId: "1", status: "done", exitCode: 0 });
	const loops = join(homedir(), ".pi", "loops"), loopFile = join(loops, "loops-main-1.json");
	mkdirSync(loops, { recursive: true });
	writeFileSync(loopFile, JSON.stringify({ loops: [{ status: "active", expiresAt: Date.now() + 10 * IDLE_MS }] }));
	await r.look();
	assert.equal(r.nudges().length, 0, "a loop");
	writeFileSync(loopFile, JSON.stringify({ loops: [] }));
	// A subagent that works: pi-herdr-agents' activity file under the main's session artifacts, and a pane running the child.
	const dir = mkdtempSync(join(tmpdir(), "psb-wrap-")), art = join(dir, "artifacts", "main1", "subagent-activity");
	mkdirSync(art, { recursive: true });
	writeFileSync(join(art, "kid1.json"), JSON.stringify({ phase: "working" }));
	world.herdr.pane("wA:p1").agent_session = { value: join(dir, "main_main1.jsonl") };
	world.herdr.addTab("wA:t55", "kid", "wA:p55");
	Object.assign(world.herdr.pane("wA:p55"), { agent: "pi", agent_session: { value: join(dir, "kid_kid1.jsonl") }, agent_status: "working" });
	await r.look();
	assert.equal(r.nudges().length, 0, "a subagent");
	writeFileSync(join(art, "kid1.json"), JSON.stringify({ phase: "done" }));
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== "wA:p55");
	await r.look();
	assert.equal(r.nudges().length, 1, "nothing runs any more");
});

test("boss_wrap refuses with an open todo, a running monitor, under auto mode, for a standing main, a member, and a tower", async () => {
	const r = await mainRig();
	const wrap = (a: Agent) => a.tool("boss_wrap", { summary: "Shipped MP-1." });
	r.a.entries.push({ customType: "todo/v1", data: { v: 1, nextId: 4, tasks: [{ id: 1, subject: "done", status: "completed" }, { id: 2, subject: "gone", status: "deleted" }, { id: 3, subject: "open", status: "pending" }] } });
	await assert.rejects(wrap(r.a), /Not ready to wrap up: open todos #3: complete or delete each/);
	r.a.entries.push({ customType: "todo/v1", data: { v: 1, nextId: 4, tasks: [{ id: 3, subject: "open", status: "completed" }] } });
	r.a.emit("monitor:started", { monitorId: "1", command: "npm test" });
	await assert.rejects(wrap(r.a), /Not ready to wrap up: a background monitor is running/);
	r.a.emit("monitor:finished", { monitorId: "1", status: "done", exitCode: 0 });
	auto(true, 1);
	await assert.rejects(wrap(r.a), /auto mode: the boss is away; wrap up when he is back/);
	auto(false, 2);
	await assert.rejects(r.a.tool("boss_wrap", { summary: " " }), /summary is required/);
	assert.equal(r.a.dialogs.length, 0, "the boss is not asked for any of these");
	await r.a.tool("boss_duty", { duty: "standing", reason: "it minds the box" });
	await assert.rejects(wrap(r.a), /A standing main has no end: only the boss closes it/);
	const m = world.agent({ id: "mem-1", pane: "wA:p2", tab: "wA:t1" });
	await m.start();
	await assert.rejects(wrap(m), /Only a tab's main agent wraps up/);
	const t = world.tower("tower-wA", "wA:t9", "wA:p9");
	await t.start();
	assert.ok(!t.tools.has("boss_wrap"), "a tower has no boss_wrap");
});

test("boss_wrap in a teammate's remote turn is refused before the tool runs", async () => {
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const root = mkdtempSync(join(tmpdir(), "psb-wrap-remote-"));
	const pi = { events: { on: () => () => {}, emit: () => {} }, on: (t: string, h: (e: unknown, ctx: unknown) => unknown) => void handlers.set(t, h) } as unknown as ExtensionAPI;
	createRemoteTurns({
		pi, now: Date.now, config: () => ({ teams: new Map([[TEAM_HEX, { project: root, share: "status" as const, name: "t" }]]), trust: new Map([[bob.id, "dispatch" as const]]), problems: [] }),
		policy: { read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } }, home: root, agentDir: root, linkDir: root, gateMs: 40,
		setOrigin: () => {}, tower: () => "tower", log: () => {}, tell: () => {}, ask: async () => ({ ok: false, error: "none" }),
	});
	handlers.get("message_start")!({ message: { role: "custom", customType: MESSAGE_TYPE, details: { id: bob.id.padStart(32, "0"), team: TEAM_HEX, from: bob.id, label: "bob", short: bob.id.slice(0, 6) } } }, {});
	const blocked = (await handlers.get("tool_call")!({ toolName: "boss_wrap", toolCallId: "c", input: { summary: "x" } }, { cwd: root, hasUI: false })) as { block?: boolean; reason?: string };
	assert.equal(blocked.block, true);
	assert.match(String(blocked.reason), /a remote turn cannot wrap up this main/);
});

test("boss_wrap asks the boss in the pane: no closes nothing and holds the nudge; yes tells the tower, clears the board, and closes the pane", async () => {
	const tower = world.tower("tower-wA", "wA:t9", "wA:p9");
	await tower.start();
	const r = await mainRig();
	await r.a.tool("board_set", { now: "shipping MP-1" });
	const entry = join(world.stateDir, "board", "main-1.json");
	assert.ok(existsSync(entry));
	const first = r.a.tool("boss_wrap", { summary: "Shipped MP-1:\n the fix and its test." });
	await until(() => r.a.dialogs.length === 1, "the boss is asked");
	assert.deepEqual([r.a.dialogs[0]!.kind, r.a.dialogs[0]!.title, r.a.dialogs[0]!.second], ["confirm", "Wrap up main-1?", "Shipped MP-1: the fix and its test."]);
	r.a.dialogs[0]!.settle(false);
	assert.match(textOf(await first), /The boss said not now: nothing closed/);
	assert.equal(r.a.stopped, false);
	assert.equal(world.broker.delivered.filter((d) => d.to === "tower-wA").length, 0, "nothing sent on a no");
	r.advance(2 * IDLE_MS);
	await r.look();
	assert.equal(r.nudges().length, 0, "no nudge this idle period after the boss's no");
	const second = r.a.tool("boss_wrap", { summary: "Shipped MP-1." });
	await until(() => r.a.dialogs.length === 2, "asked again");
	r.a.dialogs[1]!.settle(true);
	assert.match(textOf(await second), /Wrapped up: the tower has your summary, and your board is cleared\. This session quits when this turn ends/);
	const told = world.broker.delivered.filter((d) => d.to === "tower-wA");
	assert.equal(told.length, 1);
	assert.match(told[0]!.message, /why=milestone/);
	assert.match(told[0]!.message, /main-1 \(session main-1\) wrapped up, the boss agreeing: Shipped MP-1\./);
	assert.ok(!existsSync(entry), "the board entry is gone");
	await until(() => r.a.stopped, "the session quit");
	await until(() => world.herdr.calls.some((c) => c[0] === "pane" && c[1] === "close" && c[2] === "wA:p1"), "its pane closed");
});

test("RV-F001: a message queued or a monitor started while the boss was asked: his yes closes nothing and sends nothing", async () => {
	const tower = world.tower("tower-wA", "wA:t9", "wA:p9");
	await tower.start();
	const r = await mainRig();
	r.a.pending = true;
	await assert.rejects(r.a.tool("boss_wrap", { summary: "Shipped MP-1." }), /Not ready to wrap up: messages wait in your queue: read them first/);
	r.a.pending = false;
	const first = r.a.tool("boss_wrap", { summary: "Shipped MP-1." });
	await until(() => r.a.dialogs.length === 1, "the boss is asked");
	r.a.pending = true; // an intercom request arrived meanwhile
	r.a.dialogs[0]!.settle(true);
	assert.match(textOf(await first), /The boss said yes, but while he was asked: messages wait in your queue: read them first\. Nothing closed and nothing was sent/);
	r.a.pending = false;
	const second = r.a.tool("boss_wrap", { summary: "Shipped MP-1." });
	await until(() => r.a.dialogs.length === 2, "asked again");
	r.a.emit("monitor:started", { monitorId: "7", command: "npm test" }); // a parallel call started one
	r.a.dialogs[1]!.settle(true);
	assert.match(textOf(await second), /while he was asked: a background monitor is running\. Nothing closed/);
	await settle();
	assert.equal(world.broker.delivered.filter((d) => d.to === "tower-wA").length, 0, "no milestone");
	assert.equal(r.a.stopped, false);
});

// 0.91.0 (boss 2026-11-25: 「收工規則也可以在提示收工的時候再給」): the wrap-up steps reach the main with the nudge and boss_wrap's own description and results; main.md's done line is 0.89.0's again.
test("main.md holds no wrap-up rule: the nudge carries every step, and boss_wrap's description says what it does", () => {
	const main = readFileSync(join(PROMPT_DIR, "main.md"), "utf8");
	assert.ok(!main.includes("boss_wrap") && !main.includes("daily memory entry"));
	assert.ok(main.includes("its worktree is removed, and your board is cleared."));
	for (const step of ["answer the intercom asks you owe", "remove the worktrees you made", "complete or delete every todo", "stop your monitors and loops", "write a daily memory entry if you have a memory tool", "call boss_wrap with a summary"]) assert.ok(NUDGE_TEXT.includes(step), step);
	assert.match(WRAP_DESCRIPTION, /asks the boss here whether to wrap up; on yes it sends your summary to the tower/);
});
