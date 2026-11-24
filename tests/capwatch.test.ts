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
		dir, clock, told: [] as CapEvent[], logs: [] as string[], reach: true, budget: o.budget as number | undefined, unattended: o.unattended ?? false, load1: 0.2,
		mains: [{ session: "s-a", name: "api", workspace: "w1", role: "main", state: "working", workers: ["w1"], fileMtime: clock.now(), entryUpdated: clock.now() }, { session: "s-st", name: "standing", workspace: "w0", role: "main", state: "idle", duty: "standing", workers: [], fileMtime: clock.now(), entryUpdated: clock.now() }] as MainFacts[],
		allies: [] as AllySeen[],
		cap: (session: string, over: Partial<MainCap> = {}) => writeCap(dir, { v: 1, session, updated: clock.now(), doing: [], ready: [], open: 0, ...over }),
	};
	const make = () => createCapWatch({
		dir, now: clock.now, log: (event) => void w.logs.push(event), budget: () => w.budget, load: () => ({ load1: w.load1, cores: 8 }), unattended: () => w.unattended,
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

test("quota: told when it is entered, its resume told once, the next pause to the same resume time within 30 minutes held, one to another time told", async () => {
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
	w.cap("s-a", { open: 2, pause: { reason: "quota", at: w.clock.now(), until } });
	await run(watch, w.clock, 2);
	assert.equal(w.told.length, 2, "a second pause 5 minutes later, to the same resume time, is held");
	w.cap("s-a", { open: 2 });
	await run(watch, w.clock, 1);
	w.cap("s-a", { open: 2, pause: { reason: "quota", at: w.clock.now(), until: until + 24 * 3600_000 } });
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.map((e) => e.kind), ["quota", "resumed", "quota"], "a new pause to another resume time is told inside the 30 minutes");
	w.cap("s-a", { open: 2, pause: { reason: "quota", at: w.clock.now(), until: until + 48 * 3600_000 } });
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.map((e) => e.kind), ["quota", "resumed", "quota", "quota"], "a pause whose resume time moves while it holds is told again");
});

test("stale on an unattended device: a main with open todos unmoved 30 minutes is told once; a paused one never", async () => {
	const { w, make } = world({ unattended: true });
	const t0 = w.clock.now();
	w.mains[0] = { ...w.mains[0]!, workers: [], fileMtime: t0, entryUpdated: t0 }; // nothing running: a main commanding work is never stale
	w.cap("s-a", { open: 2 });
	const watch = make();
	await run(watch, w.clock, 31);
	assert.equal(w.told.length, 0);
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key]), [["stale", "s-a"]]);
	await run(watch, w.clock, 61);
	await make().tick();
	assert.equal(w.told.length, 1, "a restart does not repeat the same stale episode");
	w.mains[0]!.background = true;
	await make().tick();
	w.mains[0]!.background = false;
	await make().tick();
	assert.equal(w.told.length, 2, "a new episode after background work ends can notify again");
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
	await run(first, w.clock, 5);
	assert.equal(w.told.length, 0);
	assert.equal(w.logs.filter((l) => l === "capacity-untold").length, 1, "an untold flag is logged once while it is tried every minute");
	w.reach = true;
	await run(first, w.clock, 1);
	assert.equal(w.told.length, 1, "the next look tells it");
	await run(make(), w.clock, 10); // another restart within 30 minutes: held by the file
	assert.equal(w.told.length, 1);
});

// Review prompts-review F003: a device that stays silent is escalated by sb, once, 2 hours after its first notice, routed as that notice; no prompt keeps a timer of its own.
test("device-silent-2h: one escalation 2 hours after the first notice, not again while it stays silent (a restart included), retried while untold, and again after the device came back and went silent anew", async () => {
	const { w, make } = world();
	const t0 = w.clock.now(), off: AllySeen = { key: "t:d1", label: "box 1", short: "d1", online: false, boardAgeMs: 40 * MIN, timed: true, open: true };
	w.allies = [off];
	const watch = make();
	await run(watch, w.clock, 119);
	assert.deepEqual(w.told.map((e) => e.kind), ["silent"], "nothing more inside the 2 hours");
	w.reach = false; // nobody takes the escalation at first: tried again at the next look
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.map((e) => e.kind), ["silent"]);
	w.reach = true;
	await run(watch, w.clock, 1);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key, e.workspace, e.standing]), [["silent", "t:d1", undefined, "s-st"], ["silent-2h", "t:d1", undefined, "s-st"]]);
	assert.match(w.told[1]!.text, /^capacity device-silent-2h · device "box 1" \(d1\) · still silent 2 h after the first notice at \d\d:\d\d · last board 40 min ago · offline · needs the boss$/);
	await run(watch, w.clock, 60);
	await run(make(), w.clock, 60); // a restart: the first notice's time and the escalation are kept in _sent.json
	assert.equal(w.told.filter((e) => e.kind === "silent-2h").length, 1, "one escalation per silence");
	w.allies = [{ ...off, online: true, boardAgeMs: MIN }]; // back
	const again = make();
	await run(again, w.clock, 2);
	w.allies = [off]; // silent anew
	await run(again, w.clock, 121);
	assert.equal(w.told.filter((e) => e.kind === "silent-2h").length, 2, "a new silence is escalated again");
	assert.ok(w.clock.now() - t0 > 5 * 3600_000);
});

// Field, MP Center box 2 (2026-11-24): 3 notices to the standing main and the tower over 2.5 h started nothing, and the main holding the ready work was never told. `under` and `stale` now go to
// that main's own session too; quota and an ally's silence do not (the main is the one paused, a device has no main here).
test("under and stale are told to the subject main itself as well; quota and device-silent are not", async () => {
	const { w, make } = world({ budget: 4, unattended: true });
	w.cap("s-a", { doing: [{ owner: "w1", points: 2 }], ready: [{ points: 1 }], open: 2 });
	await run(make(), w.clock, 11);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key, e.workspace, e.standing, e.main]), [["under", "s-a", "w1", "s-st", "s-a"]]);
	const { w: w2, make: make2 } = world({ unattended: true });
	w2.mains[0] = { ...w2.mains[0]!, workers: [] };
	w2.mains.push({ session: "s-b", name: "web", workspace: "w2", role: "main", state: "idle", workers: [], fileMtime: w2.clock.now(), entryUpdated: w2.clock.now() });
	w2.cap("s-a", { open: 2 });
	w2.cap("s-b", { open: 1, pause: { reason: "quota", at: w2.clock.now() } });
	w2.allies = [{ key: "t:d1", label: "box 1", short: "d1", online: false, boardAgeMs: 40 * MIN, timed: true, open: true }];
	await run(make2(), w2.clock, 33);
	assert.deepEqual(w2.told.map((e) => [e.kind, e.key, e.main]).sort(), [["quota", "s-b", undefined], ["silent", "t:d1", undefined], ["stale", "s-a", "s-a"]]);
});

test("under of the standing main itself: told to it as the subject, and to no other standing main", async () => {
	const { w, make } = world({ budget: 4 });
	w.cap("s-st", { ready: [{ points: 1 }], open: 1 });
	await run(make(), w.clock, 11);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key, e.standing, e.main]), [["under", "s-st", undefined, "s-st"]]);
});

// sb's follow-up: a main still under 30 minutes after its own notice is escalated once per episode, to its tower and the standing main, naming it; no prompt keeps a timer.
test("under-30m: one escalation 30 minutes after the main's own notice while it stays under, not again in that episode (a restart included), retried while untold, none when it dispatched, anew in a new episode", async () => {
	const { w, make } = world({ budget: 4 });
	w.cap("s-a", { doing: [{ owner: "w1", points: 2 }], ready: [{ points: 1 }], open: 2 });
	const watch = make();
	await run(watch, w.clock, 11);
	assert.deepEqual(w.told.map((e) => e.kind), ["under"]);
	await run(watch, w.clock, 29);
	assert.deepEqual(w.told.map((e) => e.kind), ["under"], "nothing more inside the 30 minutes");
	w.reach = false; // nobody takes the escalation at first: tried again at the next look
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.map((e) => e.kind), ["under"]);
	w.reach = true;
	await run(watch, w.clock, 1);
	assert.deepEqual(w.told.map((e) => [e.kind, e.key, e.workspace, e.standing, e.main]), [["under", "s-a", "w1", "s-st", "s-a"], ["under-30m", "s-a", "w1", "s-st", undefined]]);
	assert.match(w.told[1]!.text, /^capacity under-30m · main "api" · still under 30 min after its notice at \d\d:\d\d · 1 ready \(smallest 1 pt\) · capacity 2 \/ 4 pts · load 0\.2 \/ 8 cores · ready 1 · under \d+ min · ask it to dispatch or say why$/);
	await run(watch, w.clock, 40);
	await run(make(), w.clock, 60); // a restart: the hold and the episode's marks are read back
	assert.equal(w.told.filter((e) => e.kind === "under-30m").length, 1, "one escalation per episode");
	const again = make(), before = w.told.length;
	w.load1 = 7; // the episode ends
	await run(again, w.clock, 2);
	w.load1 = 0.2; // a new one: under once its 10 minutes are held, the escalation 30 minutes after that
	await run(again, w.clock, 11);
	assert.deepEqual(w.told.slice(before).map((e) => e.kind), ["under"]);
	await run(again, w.clock, 31);
	assert.deepEqual(w.told.slice(before).map((e) => e.kind), ["under", "under-30m"]);
	// A main that dispatched within the 30 minutes is no longer under: no escalation.
	const { w: w2, make: make2 } = world({ budget: 4 });
	w2.cap("s-a", { ready: [{ points: 1 }], open: 1 });
	const watch2 = make2();
	await run(watch2, w2.clock, 20);
	w2.cap("s-a", { doing: [{ owner: "w1", points: 1 }], open: 1 });
	await run(watch2, w2.clock, 60);
	assert.deepEqual(w2.told.map((e) => e.kind), ["under"]);
});
