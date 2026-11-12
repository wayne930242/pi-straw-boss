import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAutoWatch, type Facts, freshWatch, WATCH_MS, type WatchState, watchSection } from "../src/server/autowatch.ts";
import { callControl } from "../src/server/socket.ts";
import { addTold, headDir, purgeAll, readTold } from "../src/server/towerstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// Review round 5 (docs/specs/2026-11-12-auto-watch.md): the told ledger holds the watch's keys alone and goes with the flag (RV5-F001), a reading that ends after the watch stopped tells nothing (RV5-F002), and a
// parked wait of the boss's is named in one place (RV5-F003).

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);

test("RV5-F001: a head notice that is not the watch's stays out of the told ledger, and the flag off removes the ledger", async () => {
	const s = await world.start();
	await s.handle.ready;
	const head = await world.expose!.head.ensure();
	assert.equal(world.expose!.runs.notice(head.workspace, "a late tool failure", "tower_send:boom"), true);
	await until(() => world.pis.size >= 1, "the notice to start a head run");
	const pi = [...world.pis.values()][0]!, id = [...world.pis.keys()][0]!;
	const claim = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(claim.ok, true, JSON.stringify(claim));
	const event = (await ask(s, { cmd: "run-poll", token: String(claim.token), idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: String(claim.token), id: event.id })).ok, true);
	assert.equal((await ask(s, { cmd: "run-done", token: String(claim.token), note: "done" })).ok, true);
	world.live.delete(pi.pid); // the pi leaves, so the run ends done
	await until(() => !world.expose!.runs.noticeState("tower_send:boom").match(/queued|taken/), "the run to end");
	assert.deepEqual(readTold(world.slot), [], "only `auto-watch:` keys are kept");
	addTold(world.slot, "auto-watch:x:1:2");
	assert.equal(existsSync(join(headDir(world.slot), "told.json")), true);
	purgeAll(world.slot);
	assert.equal(existsSync(join(headDir(world.slot), "told.json")), false, "the flag off removes the ledger");
});

test("RV5-F002: a reading whose net read ends after the watch stopped queues no notice", async () => {
	let now = Date.parse("2026-11-12T22:00:00.000Z"), stopped = false, state: WatchState | undefined, release!: (f: Facts) => void;
	const since = new Date(now).toISOString(), woke: string[] = [];
	const facts: Facts = { at: 0, workspaces: [{ id: "wA", label: "Alpha", worked: false, finished: false, waits: [], open: [], parked: [], idle: [], tower: ["held"], trains: [], forwards: [], stalls: [], lines: 0, landed: [], cars: 0, keys: [{ key: "tower:wA:held", line: '"Alpha": its tower: held' }], said: {} } as never], elsewhere: { waits: [], trains: [], stalls: [], keys: [], said: {} } as never, headParked: 0 };
	const watch = createAutoWatch({
		now: () => now, log: () => {}, asks: () => [], head: () => ({ workspace: "head" }), stopped: () => stopped,
		auto: { view: () => ({ on: true, since }), period: () => ({ notes: [] }), watch: () => state ?? freshWatch(), setWatch: (x) => void (state = x) },
		facts: () => new Promise<Facts>((r) => (release = r)),
		wake: (_ws, _text, key) => (woke.push(key), true),
	});
	now += WATCH_MS;
	const tick = watch.tick();
	stopped = true; // the server leaves while the net is read
	release({ ...facts, at: now });
	await tick;
	assert.deepEqual(woke, [], "nothing is queued once the watch stopped");
});

test("RV5-F003: a parked wait of the boss's that no notice told is not also told to nobody", () => {
	const since = "2026-11-12T22:00:00.000Z", at = "2026-11-12T23:00:00.000Z";
	const f = { key: "parked:w1:W3", line: '"api": wait W3 parked for the boss: "x"' };
	const state: WatchState = { ...freshWatch(), readings: 1, last: at, untold: [f], found: { at, items: [f], more: 0 } };
	const w = watchSection(state, since, at, [])!;
	assert.equal(w.untaken, undefined, "the return list's parked section names it");
	assert.equal(w.open, undefined);
});
