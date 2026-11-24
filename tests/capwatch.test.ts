import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { capDir, type MainCap, type MainFacts, readDevice, writeCap } from "../src/capacity.ts";
import { type AllySeen, type CapEvent, createCapWatch } from "../src/server/capwatch.ts";
import { fakeClock } from "./fake-clock.ts";

// The capacity watch (src/server/capwatch.ts) on a world the test edits, with the fake clock: a flag is told once when it is entered, at most once per main per kind per 30 minutes, never when
// it clears except a quota that resumed; under capacity is held 10 minutes first; the throttle outlives a server restart.

const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world(o: { budget?: number; unattended?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "psb-capw-")), dir = capDir(join(root, "board"));
	dirs.push(root);
	const clock = fakeClock(Date.parse("2026-11-24T10:00:00Z"));
	const w = {
		dir, clock, told: [] as CapEvent[], reach: true, budget: o.budget as number | undefined, unattended: o.unattended ?? false, load1: 0.2,
		mains: [{ session: "s-a", name: "api", workspace: "w1", role: "main", state: "working", workers: ["w1"], fileMtime: clock.now(), entryUpdated: clock.now() }, { session: "s-st", name: "standing", workspace: "w0", role: "main", state: "idle", duty: "standing", workers: [], fileMtime: clock.now(), entryUpdated: clock.now() }] as MainFacts[],
		allies: [] as AllySeen[],
		cap: (session: string, over: Partial<MainCap> = {}) => writeCap(dir, { v: 1, session, updated: clock.now(), doing: [], ready: [], open: 0, ...over }),
	};
	const make = () => createCapWatch({
		dir, now: clock.now, log: () => {}, budget: () => w.budget, load: () => ({ load1: w.load1, cores: 8 }), unattended: () => w.unattended,
		mains: async () => w.mains, allies: () => w.allies, tell: async (e) => (w.reach ? (w.told.push(e), true) : false),
	});
	return { w, make };
}
/** Ticks once a minute for `minutes`. */
async function run(watch: ReturnType<typeof createCapWatch>, clock: ReturnType<typeof fakeClock>, minutes: number) {
	for (let i = 0; i < minutes; i++) (await watch.tick(), clock.advance(MIN));
}

test("under capacity: told after 10 minutes held, once per main, to its tower and the standing main; nothing on clear; again only 30 minutes after the last", async () => {
	const { w, make } = world({ budget: 4 });
	w.cap("s-a", { doing: [{ owner: "w1", points: 2 }], ready: [{ points: 1 }, { points: 2 }], open: 3 });
	const watch = make();
	await run(watch, w.clock, 10);
	assert.equal(w.told.length, 0, "held under 10 minutes");
	await run(watch, w.clock, 1);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key, e.workspace, e.standing]), [["under", "s-a", "w1", "s-st"]]);
	assert.match(w.told[0]!.text, /^capacity under · main "api" · 2 ready \(smallest 1 pt\) · capacity 2 \/ 4 pts · load 0\.2 \/ 8 cores · ready 2 · under 10 min · held 10 min$/);
	await run(watch, w.clock, 5);
	assert.equal(w.told.length, 1, "told once while it holds");
	w.load1 = 7; // the load clears it: nothing is said
	await run(watch, w.clock, 2);
	w.load1 = 0.2;
	await run(watch, w.clock, 12);
	assert.equal(w.told.length, 1, "entered again within 30 minutes of the last: held");
	w.load1 = 7;
	await run(watch, w.clock, 10);
	w.load1 = 0.2;
	await run(watch, w.clock, 11);
	assert.equal(w.told.length, 2, "entered again after 30 minutes: told");
	assert.equal(readDevice(w.dir, w.clock.now())?.points, 2, "the device row is written at every look");
});

test("no budget: the numbers are written, under is never flagged", async () => {
	const { w, make } = world();
	w.cap("s-a", { ready: [{ points: 0.5 }], open: 1 });
	await run(make(), w.clock, 30);
	assert.deepEqual(w.told, []);
	const d = readDevice(w.dir, w.clock.now())!;
	assert.equal(d.budget, undefined);
	assert.equal(d.ready, 1);
});

test("quota: told when it is entered, its resume told once, and the next pause within 30 minutes held", async () => {
	const { w, make } = world();
	const watch = make(), until = w.clock.now() + 3 * 3600_000;
	w.cap("s-a", { open: 2, pause: { reason: "quota", at: w.clock.now(), until, detail: "weekly limit" } });
	await run(watch, w.clock, 3);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key]), [["quota", "s-a"]]);
	assert.match(w.told[0]!.text, /^capacity quota · main "api" · quota · resumes (\d+\/\d+ )?\d\d:\d\d · weekly limit$/);
	w.cap("s-a", { open: 2 });
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.map((e) => e.kind), ["quota", "resumed"]);
	assert.equal(w.told[1]!.text, 'capacity quota resumed · main "api"');
	w.cap("s-a", { open: 2, pause: { reason: "quota", at: w.clock.now() } });
	await run(watch, w.clock, 2);
	assert.equal(w.told.length, 2, "a second pause 5 minutes later is held");
});

test("stale on an unattended device: a main with open todos unmoved 30 minutes is told once; a paused one never", async () => {
	const { w, make } = world({ unattended: true });
	const t0 = w.clock.now();
	w.mains[0] = { ...w.mains[0]!, fileMtime: t0, entryUpdated: t0 };
	w.cap("s-a", { open: 2 });
	const watch = make();
	await run(watch, w.clock, 31);
	assert.equal(w.told.length, 0);
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key]), [["stale", "s-a"]]);
	const { w: w2, make: make2 } = world({ unattended: true });
	w2.mains[0] = { ...w2.mains[0]!, fileMtime: w2.clock.now(), entryUpdated: w2.clock.now() };
	w2.cap("s-a", { open: 2, pause: { reason: "quota", at: w2.clock.now() } });
	await run(make2(), w2.clock, 60);
	assert.deepEqual(w2.told.map((e) => e.kind), ["quota"], "paused: quota only, never stale");
});

test("device-silent: an ally with open work whose board is over 30 minutes old or that is offline; none without open work", async () => {
	const { w, make } = world();
	w.allies = [
		{ key: "t:d1", label: "box 1", short: "d1", online: true, boardAgeMs: 31 * MIN, timed: true, open: true },
		{ key: "t:d2", label: "box 2", short: "d2", online: false, boardAgeMs: MIN, timed: true, open: false },
		{ key: "t:d3", label: "box 3", short: "d3", online: true, boardAgeMs: 5 * MIN, timed: true, open: true },
		{ key: "t:d4", label: "old box", short: "d4", online: true, boardAgeMs: 50 * MIN, timed: false, open: true }, // an older build's board: an hour unchanged is normal
		{ key: "t:d5", label: "old box 2", short: "d5", online: false, boardAgeMs: 50 * MIN, timed: false, open: true },
	];
	await run(make(), w.clock, 3);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key, e.standing]), [["silent", "t:d1", "s-st"], ["silent", "t:d5", "s-st"]]);
	assert.equal(w.told[0]!.text, 'capacity device-silent · device "box 1" (d1) · last board 31 min ago · online · its last board had open work');
});

test("the throttle outlives a restart of the server, and an event nobody took is tried again at the next look", async () => {
	const { w, make } = world();
	w.cap("s-a", { open: 1, pause: { reason: "quota", at: w.clock.now() } });
	w.reach = false;
	const first = make();
	await run(first, w.clock, 1);
	assert.equal(w.told.length, 0);
	w.reach = true;
	await run(first, w.clock, 1);
	assert.equal(w.told.length, 1, "the next look tells it");
	await run(make(), w.clock, 10); // another restart within 30 minutes: held by the file
	assert.equal(w.told.length, 1);
});
