import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { freshWatch, watchLines, type WatchState } from "../src/server/autowatch.ts";
import { callControl } from "../src/server/socket.ts";
import { unbindDir } from "../src/server/towerstore.ts";
import { reportWatch } from "../src/server/watchops.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// Where the watch's notice is, read from the head's real queue (docs/specs/2026-11-12-auto-watch.md, AW-D18): a head that closes does not make its untaken notice read as taken (RV3-F001), and a notice a head run holds
// when auto mode ends is named as taken by a run in flight, not as told to nobody (RV3-F004).

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const SINCE = "2026-11-12T22:00:00.000Z", AT = "2026-11-12T23:00:00.000Z", KEY = `auto-watch:${SINCE}:1`;
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	const head = await world.expose!.head.ensure();
	assert.equal(world.expose!.runs.notice(head.workspace, "Auto watch: something new", KEY), true);
	return { s, ws: head.workspace };
};
/** The period as the switch off reads it: one notice pending with one finding. */
const period = (ws: string) => {
	const watch: WatchState = { ...freshWatch(), readings: 1, last: AT, pending: { at: AT, items: [{ key: "tower:wA:held", line: '"Alpha": its tower: held' }], more: 0, workspace: ws, key: KEY, fresh: ["tower:wA:held"], quiet: {} } };
	return { since: SINCE, notes: [], foreign: [], decided: [], watch };
};
const report = (ws: string) => reportWatch(world.slot, () => Date.parse(AT) + 60_000, () => world.expose)(period(ws), new Date(Date.parse(AT) + 60_000).toISOString())!;

test("RV3-F001: a notice no run took still reads as queued once the head closed and its workspace is unbound, and the morning names it as not taken", async () => {
	const { ws } = await setup();
	assert.equal(world.expose!.runs.noticeState(ws, KEY), "queued");
	unbindDir(world.slot, ws); // as `lose`, `towers.stop`, and the head's close do
	assert.equal(world.expose!.runs.noticeState(ws, KEY), "queued", "unbound, the head's queue is still read");
	const w = report(ws);
	assert.equal(w.wakes, 0, "not counted as a wake");
	assert.match(watchLines(w).join("\n"), /The last notice \(\d\d:\d\d\) was not taken by the head tower: 1 finding told to nobody:\n- "Alpha": its tower: held/);
});

test("RV3-F004: a notice held by a head run still in flight is `taken`; the morning says so, and does not count it as a wake", async () => {
	const { s, ws } = await setup();
	await until(() => world.pis.size >= 1, "the notice to start a head run");
	const pi = [...world.pis.values()][0]!, id = [...world.pis.keys()][0]!;
	const claim = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(claim.ok, true, JSON.stringify(claim));
	const event = (await ask(s, { cmd: "run-poll", token: String(claim.token), idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: String(claim.token), id: event.id })).ok, true);
	assert.equal(world.expose!.runs.noticeState(ws, KEY), "taken");
	const w = report(ws);
	assert.equal(w.wakes, 0);
	const text = watchLines(w).join("\n");
	assert.match(text, /The last notice \(\d\d:\d\d\) is taken by a head run still in flight: 1 finding:\n- "Alpha": its tower: held/);
	assert.doesNotMatch(text, /told to nobody/);
});
