import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { WATCH_MESSAGE } from "../src/bosswatch.ts";
import { CONTROL } from "../src/closemain.ts";
import { type Agent, until, World } from "./fakes.ts";

// The session's side of `boss_watch` (docs/specs/2026-11-23-lite-b2-d-e-f.md §3.3): the server's line arrives on the `straw-boss/control` channel from the workspace's tower identity and becomes one custom message that waits for
// the end of a busy turn (a follow-up) or starts a turn when the main is idle; it never steers. Any other sender is dropped.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const asked: Record<string, unknown>[] = [];
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");

async function town(watches: unknown[] = [{ key: "u1" }]) {
	asked.length = 0;
	world.ask = async (request) => {
		asked.push(request);
		if (request.cmd === "watch-list") return { ok: true, watches };
		if (request.cmd === "watch-add") return { ok: true, watch: { key: request.key, until: 0, line: `watch ${String(request.key)}: mark working` } };
		return { ok: false, error: "no server" };
	};
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	const other = world.tower("tower-wB", "wB:t7", "wB:p7");
	const m = world.agent({ id: "main-1", name: "box watch", pane: "wA:p1", tab: "wA:t1" });
	const member = world.agent({ id: "mem-1", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all(world.agents.map((a) => a.start()));
	await m.promote();
	await world.quiet();
	return { tower, other, m, member };
}
const watchEvent = (m: Agent, from: string, reqId: string) => m.regs.get(CONTROL)!.onEvent({ type: "message", fromSessionId: from, payload: { version: 1, type: "watch", to: m.id, reqId, key: "u1", state: "changed", text: "watch u1: changed · mark waiting" } });
const result = (reqId: string) => world.broker.published.map((p) => p.payload as { type?: string; reqId?: string; accepted?: boolean }).find((p) => p.type === "watch-result" && p.reqId === reqId);

test("a main the server holds a watch for listens at its start; the tower's line starts a turn when idle and waits as a follow-up when busy, never a steer", async () => {
	const { m } = await town();
	assert.ok(m.regs.get(CONTROL), "registered at the session start");
	watchEvent(m, "tower-wA", "r1");
	await until(() => result("r1") !== undefined, "the answer");
	assert.equal(result("r1")!.accepted, true);
	m.idle = false;
	watchEvent(m, "tower-wA", "r2");
	await until(() => result("r2") !== undefined, "the second answer");
	const lines = m.sent.filter((x) => x.customType === WATCH_MESSAGE);
	assert.equal(lines.length, 2);
	for (const line of lines) {
		assert.equal(line.content, "watch u1: changed · mark waiting");
		assert.equal(line.triggerTurn, true, "an idle main gets a turn");
		assert.equal(line.deliverAs, "followUp", "a busy main gets it after its turn");
	}
	assert.ok(!m.sent.some((x) => x.deliverAs === "steer" && x.customType === WATCH_MESSAGE), "never a steer");
});

test("a watch line from anyone but this workspace's tower is dropped", async () => {
	const { m } = await town();
	watchEvent(m, "tower-wB", "r3");
	await until(() => result("r3") !== undefined, "the answer");
	assert.equal(result("r3")!.accepted, false);
	assert.equal(m.sent.filter((x) => x.customType === WATCH_MESSAGE).length, 0);
});

test("a main with no watch on the server does not listen; boss_watch registers the channel and asks the server; a member and tower runs off are refused", async () => {
	const { m, member } = await town([]);
	assert.equal(m.regs.get(CONTROL), undefined, "no watch on the server, no channel");
	await assert.rejects(m.tool("boss_watch", { key: "u1" }), /tower runs are off/);
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: true } }));
	await assert.rejects(member.tool("boss_watch", { key: "u1" }), /a tab's main or a train/);
	const done = await m.tool("boss_watch", { key: "u1", quiet: "30m", until: "2h" });
	assert.match(textOf(done), /Watching u1/);
	const add = asked.find((r) => r.cmd === "watch-add")!;
	assert.deepEqual([add.session, add.workspace, add.key, add.quietMs, add.untilMs], ["main-1", "wA", "u1", 1_800_000, 7_200_000]);
	assert.ok(m.regs.get(CONTROL), "registered at the first boss_watch");
	await assert.rejects(m.tool("boss_watch", { key: "u1", quiet: "30s" }), /quiet is at least 1m/);
});
