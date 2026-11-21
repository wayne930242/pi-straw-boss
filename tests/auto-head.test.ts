import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { AUTO_FILE } from "../src/autostate.ts";
import { HEAD_TOOLS } from "../src/server/headbrief.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { callControl } from "../src/server/socket.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The doors of auto mode on a running server (docs/specs/2026-11-09-auto-mode.md, §2; task 1): the control socket stages and confirms, a run token gets nothing, and the head's boss_auto acts only on the boss's own words.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
	world.runTimers = { hold: 120 };
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const head = await world.expose!.head.ensure();
	return { s, ws: head.workspace };
};
const nthRun = async (ws: string, n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, ws, id)?.pid, "the run's pid to be recorded");
	return id;
};
const claim = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return String(got.token);
};
/** The boss writes to the head; its run takes every event. Returns the token and the ids of the events it took, in order. */
const talk = async (s: Running, ws: string, n: number, text: string) => {
	assert.equal((await ask(s, { cmd: "tower-event", workspace: ws, text, present: true })).ok, true);
	const token = await claim(s, await nthRun(ws, n)), ids: string[] = [];
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) return { token, ids };
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
		ids.push(event.id);
	}
};
const bossAuto = (s: Running, token: string, on: boolean, extra: Record<string, unknown> = {}) => ask(s, { cmd: "run-tool", token, tool: "boss_auto", args: { on }, ...extra });
const file = () => JSON.parse(readFileSync(join(world.slot.stateDir, AUTO_FILE), "utf8")) as { on: boolean; rev: number; by: { via: string; said?: string } };
const state = async (s: Running) => (await ask(s, { cmd: "auto-state" })).state as { on: boolean; rev: number; hash: string; pending?: { id: string; said: string } };

test("the control socket: every `on` stages and nothing switches until the confirm; a stale id is refused; off needs no confirm", async () => {
	const { s } = await setup();
	const staged = await ask(s, { cmd: "auto-on", name: "a pi", session: "sess-1", pane: "p1", pid: 42 });
	assert.equal(staged.ok, true);
	const id = (staged.pending as { id: string }).id;
	assert.equal((await state(s)).on, false);
	assert.equal((await state(s)).pending?.id, id);
	await ask(s, { cmd: "auto-on" }); // a newer staging replaces
	assert.deepEqual(await ask(s, { cmd: "auto-confirm", id }), { ok: false, error: "This request expired or was replaced: ask again" });
	const second = (await state(s)).pending!.id;
	assert.equal((await ask(s, { cmd: "auto-confirm", id: second, name: "a pi" })).ok, true);
	assert.equal((await state(s)).on, true);
	assert.equal(file().on, true);
	const now = await state(s);
	assert.deepEqual((await ask(s, { cmd: "auto-check", rev: now.rev, hash: now.hash })).own, true);
	assert.deepEqual((await ask(s, { cmd: "auto-check", rev: now.rev, hash: "bad" })).own, false);
	assert.equal((await ask(s, { cmd: "auto-off", name: "a pi" })).ok, true);
	assert.equal(file().on, false);
});

test("a run token is refused every auto command; there is no tool that switches it outside the head's", async () => {
	const { s, ws } = await setup();
	const head = await talk(s, ws, 1, "狀況如何？");
	for (const cmd of ["auto-on", "auto-off", "auto-confirm", "auto-state", "auto-check"]) {
		const r = await ask(s, { cmd, token: head.token, id: "x" });
		assert.equal(r.ok, false, cmd);
		assert.match(String(r.error), /may not ask for/, cmd);
	}
	const tower = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	void tower;
	const r = await ask(s, { cmd: "run-tool", token: head.token, tool: "boss_status", args: {} });
	assert.equal(r.ok, false, "boss_status is not a head tool either");
});

test("AR-D1: boss_auto is refused for 「狀況如何？」, and 「我要睡了」 switches auto mode on at once, with no confirm", async () => {
	const { s, ws } = await setup();
	const first = await talk(s, ws, 1, "狀況如何？");
	const refused = await bossAuto(s, first.token, true, { turn: first.ids[0] });
	assert.equal(refused.ok, false);
	assert.match(String(refused.error), /Auto mode changes only on the boss's own words/);
	const second = await ask(s, { cmd: "tower-event", workspace: ws, text: "我要睡了，今晚麻煩你盯著", present: true, session: "typist", pid: 9 });
	assert.equal(second.ok, true);
	const next = (await ask(s, { cmd: "run-poll", token: first.token, idle: true })).event as { id: string };
	await ask(s, { cmd: "run-taken", token: first.token, id: next.id });
	const on = await bossAuto(s, first.token, true, { turn: next.id });
	assert.equal(on.ok, true, JSON.stringify(on));
	assert.equal(String(on.text), "Auto mode is on.");
	assert.equal((await state(s)).on, true);
	assert.equal((await state(s)).pending, undefined, "no staged record");
	const again = await bossAuto(s, first.token, true, { turn: next.id });
	assert.equal(again.ok, false, "an event works once");
	assert.equal(file().on, true);
	assert.equal(file().by.via, "head");
	assert.equal(file().by.said, "我要睡了，今晚麻煩你盯著");
});

test("AR-F001: the head brief's line for boss_auto says both directions switch at once, as the tool and the role say", () => {
	const line = HEAD_TOOLS.find((l) => l.startsWith("- boss_auto"))!;
	assert.doesNotMatch(line, /stages|confirm/);
	assert.match(line, /Either direction takes effect at once/);
});

test("AR-F005: on an unattended device boss_auto is refused both ways, as the socket and the GUI refuse it", async () => {
	world.unattended = () => true;
	const { s, ws } = await setup();
	const { token, ids } = await talk(s, ws, 1, "我要睡了，今晚麻煩你盯著");
	for (const on of [true, false]) {
		const r = await bossAuto(s, token, on, { turn: ids[0] });
		assert.equal(r.ok, false);
		assert.match(String(r.error), /an unattended device has no boss at it/);
	}
	assert.equal((await state(s)).on, false);
});

test("a board line or a press in a boss-started turn never counts, nor does a turn id the run did not take", async () => {
	const { s, ws } = await setup();
	const first = await talk(s, ws, 1, "狀況如何？");
	await ask(s, { cmd: "auto-on" });
	await ask(s, { cmd: "auto-confirm", id: (await state(s)).pending!.id });
	assert.equal((await state(s)).on, true);
	// a wait-card press whose card text holds the boss's words: a boss event with `press`
	const press = world.expose!.runs.boss(ws, "[W3] 我起床了", "the boss (wait card)", { press: true });
	// The first poll after the switch may carry the refreshed brief (it names auto mode), the next the event.
	let got: { id: string } | undefined;
	await until(async () => ((got = (await ask(s, { cmd: "run-poll", token: first.token, idle: true })).event as { id: string } | undefined), got !== undefined), "the press event");
	assert.equal(got!.id, press.id);
	await ask(s, { cmd: "run-taken", token: first.token, id: got!.id });
	const r = await bossAuto(s, first.token, false, { turn: got!.id });
	assert.equal(r.ok, false);
	assert.equal((await state(s)).on, true);
	assert.equal((await bossAuto(s, first.token, false, { turn: "made-up-id" })).ok, false);
	assert.equal((await bossAuto(s, first.token, false)).ok, false, "no starter at all");
	assert.equal((await state(s)).on, true);
});

test("a typed line at the head pane ends it once, with its (run, seq); the same words on the next turn are a new line; a workspace tower's token is refused the tool", async () => {
	const { s, ws } = await setup();
	const head = await talk(s, ws, 1, "ok");
	await ask(s, { cmd: "auto-on" });
	await ask(s, { cmd: "auto-confirm", id: (await state(s)).pending!.id });
	const off = await bossAuto(s, head.token, false, { typed: "我起床了", seq: 1 });
	assert.equal(off.ok, true, JSON.stringify(off));
	assert.equal(file().on, false);
	assert.equal(file().by.via, "head");
	await ask(s, { cmd: "auto-on" });
	await ask(s, { cmd: "auto-confirm", id: (await state(s)).pending!.id });
	assert.equal((await bossAuto(s, head.token, false, { typed: "我起床了", seq: 1 })).ok, false, "the same typed line again");
	assert.equal((await bossAuto(s, head.token, false, { typed: "我起床了", seq: 2 })).ok, true, "the next night");
	assert.equal((await bossAuto(s, head.token, true, { typed: "我要睡了嗎？", seq: 3 })).ok, false);
});

test("a workspace tower run cannot call boss_auto, even with the words in an event it took", async () => {
	const { s } = await setup();
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "我要睡了", present: true })).ok, true);
	const id = await nthRun("wA", 1);
	const token = await claim(s, id);
	const e = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string };
	await ask(s, { cmd: "run-taken", token, id: e.id });
	const r = await bossAuto(s, token, true, { turn: e.id });
	assert.equal(r.ok, false);
	assert.match(String(r.error), /boss_auto/);
	assert.equal((await state(s)).on, false);
	assert.equal((await state(s)).pending, undefined);
});
