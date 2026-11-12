import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { freshWatch, WATCH_KEY, watchLines, type WatchState } from "../src/server/autowatch.ts";
import { callControl } from "../src/server/socket.ts";
import { HEAD_KEY, readQueue } from "../src/server/towerstore.ts";
import { reportWatch, watchSwitch } from "../src/server/watchops.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The paths of the auto-watch model (docs/models/auto-watch/) that run through the head tower's real queue and runs (runs.ts): W1 (a notice counts as told only once a head run that took it ended well), W2 (no notice of a
// period survives its switch off, whether or not a head is open), and W6 (a notice a live head run holds is one that waits). The steps a person takes (closing the head, switching auto mode off) are calls here.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const SINCE = "2026-11-12T22:00:00.000Z", AT = "2026-11-12T23:00:00.000Z", KEY = `${WATCH_KEY}${SINCE}:1`;
const FINDING = { key: "tower:wA:held", line: '"Alpha": its tower: held' };
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	const head = await world.expose!.head.ensure();
	assert.equal(world.expose!.runs.notice(head.workspace, "Auto watch 1: something new", KEY), true);
	return { s, ws: head.workspace };
};
/** A head run takes the notice: it claims the pane, is offered the event, and says it is in its session. */
const take = async (s: Running) => {
	await until(() => world.pis.size >= 1, "the notice to start a head run");
	const [id, pi] = [...world.pis.entries()].at(-1)!;
	const claim = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(claim.ok, true, JSON.stringify(claim));
	const event = (await ask(s, { cmd: "run-poll", token: String(claim.token), idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: String(claim.token), id: event.id })).ok, true);
	return { token: String(claim.token), pid: pi.pid };
};
/** The period as the switch off reads it: the notice pending, with its one finding not told yet (both the shape of 1ffea42f and the decided one). */
const period = (ws: string) => {
	const watch = { ...freshWatch(), readings: 1, last: AT, untold: [FINDING], found: { at: AT, items: [FINDING], more: 0 }, pending: { at: AT, items: [FINDING], more: 0, workspace: ws, key: KEY, fresh: [FINDING.key], quiet: {} } } as unknown as WatchState;
	return { since: SINCE, notes: [], foreign: [], decided: [], watch };
};
const report = (ws: string) => reportWatch(world.slot, () => Date.parse(AT) + 60_000, () => world.expose)(period(ws), new Date(Date.parse(AT) + 60_000).toISOString())!;
const switchOff = () => watchSwitch({ towers: () => world.expose, log: () => {} })({ from: { on: true }, to: { on: false } });
const watchNotices = () => [...readQueue(world.slot, HEAD_KEY), ...readQueue(world.slot, HEAD_KEY, true)].filter((e) => e.kind === "notice" && e.messageId?.startsWith(WATCH_KEY));

test("model W1 (RV4-F004): a notice whose head run the server quit is not counted as told; the morning names its finding as told to nobody", async () => {
	const { s, ws } = await setup();
	await take(s);
	await world.expose!.head.close(); // the boss closes the head tower while its run holds the notice: the server quits the run
	assert.equal(watchNotices().length, 0, "the quit run's event left the queue");
	const w = report(ws);
	assert.equal(w.wakes, 0, `a run the server quit did not take the notice to the end (${JSON.stringify(w)})`);
	assert.match(watchLines(w).join("\n"), /- "Alpha": its tower: held/, "its finding is on the morning list");
});

test("model W1 (control): a notice whose head run ended well counts as told", async () => {
	const { s, ws } = await setup();
	const run = await take(s);
	assert.equal((await ask(s, { cmd: "run-done", token: run.token, note: "nudged Alpha's tower" })).ok, true);
	world.live.delete(run.pid); // pi exits after tower_done
	await until(() => watchNotices().length === 0, "the run's end");
	assert.equal(report(ws).wakes, 1);
});

test("model W2 (RV4-F003): auto mode switched off while the head tower is closed drops the period's notice, so a head opened later is not offered it", async () => {
	const { ws } = await setup();
	await world.expose!.head.close();
	assert.equal(world.expose!.head.status(), undefined, "no head is open");
	assert.equal(watchNotices().length, 1, "the untaken notice stays in the head's folder");
	switchOff();
	assert.deepEqual(watchNotices().map((e) => e.messageId), [], "no notice of the period that ended is left for the next head");
	void ws;
});

test("model W2: a notice a live head run holds at the switch off may finish, but a crash of that run does not put it back for a later run", async () => {
	const { s } = await setup();
	const run = await take(s);
	switchOff();
	assert.equal(watchNotices().length, 1, "the live run keeps the notice it holds");
	const before = world.pis.size;
	world.live.delete(run.pid); // its pi dies without tower_done: the run crashed
	await until(() => world.expose!.runs.status(world.expose!.head.status()!.workspace)?.lastRun?.outcome === "crashed", "the crashed run's end");
	assert.deepEqual(watchNotices().map((e) => e.messageId), [], "the notice of the period that ended is gone, not queued again");
	assert.equal(world.pis.size, before, "no run was started for it");
});

test("model W6: a notice a live head run holds is one that waits, so the watch sends none over it even when its own mark of the notice is lost", async () => {
	const { s, ws } = await setup();
	await take(s);
	assert.equal(world.expose!.runs.noticeWaits(ws, WATCH_KEY), true);
});
