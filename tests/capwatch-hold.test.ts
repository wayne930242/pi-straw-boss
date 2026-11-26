import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { capDir, type MainCap, type MainFacts, writeCap } from "../src/capacity.ts";
import { addIgnored, readHold } from "../src/hold.ts";
import type { EndedHold, Hold } from "../src/link/holds.ts";
import { tellCap } from "../src/server/capops.ts";
import { type AllySeen, type CapEvent, createCapWatch } from "../src/server/capwatch.ts";
import { fakeClock } from "./fake-clock.ts";

// The capacity watch under a device hold (docs/specs/2026-11-26-device-hold.md, Consumers), with the fake clock. The box: its judge's file each minute, `held` and `hold-ended` told once each to the head tower, the
// standing main and the coordinators (not again after a restart), no `under` for its own mains, a `stale` with the held hints. The controller: `held-room` to the holding main alone, and `silent` to it too.

const MIN = 60_000, TEAM = "0f".repeat(16), MAC = "a".repeat(26), BOX = "c".repeat(26), BY = "0123456789abcdef";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function world(o: { unattended: boolean; budget?: number }) {
	const root = mkdtempSync(join(tmpdir(), "psb-capw-hold-")), dir = capDir(join(root, "board"));
	dirs.push(root);
	const clock = fakeClock(Date.parse("2026-11-26T02:00:00Z"));
	const w = {
		dir, clock, told: [] as CapEvent[], load1: 0.2,
		mains: [
			{ session: "s-a", name: "api", workspace: "w1", role: "main", state: "idle", workers: [], fileMtime: clock.now(), entryUpdated: clock.now() },
			{ session: "s-st", name: "standing", workspace: "w0", role: "main", state: "idle", duty: "standing", workers: [], fileMtime: clock.now(), entryUpdated: clock.now() },
			{ session: "s-w", name: "worker", workspace: "w1", role: "main", state: "working", duty: "worker", workers: [], fileMtime: clock.now(), entryUpdated: clock.now() },
		] as MainFacts[],
		allies: [] as AllySeen[], holds: [] as Hold[], ended: [] as EndedHold[],
		cap: (session: string, over: Partial<MainCap> = {}) => writeCap(dir, { v: 1, session, updated: clock.now(), doing: [], ready: [], open: 0, ...over }),
	};
	const make = () => createCapWatch({
		dir, now: clock.now, log: () => {}, budget: () => o.budget, load: () => ({ load1: w.load1, cores: 8 }), unattended: () => o.unattended,
		mains: async () => w.mains, allies: () => w.allies, tell: async (e) => (w.told.push(e), true), holds: () => ({ holds: w.holds, ended: w.ended }),
	});
	return { w, make };
}
async function run(watch: ReturnType<typeof createCapWatch>, clock: ReturnType<typeof fakeClock>, minutes: number) {
	for (let i = 0; i < minutes; i++) (await watch.tick(), clock.advance(MIN));
}
const mac = (now: number, claim?: Partial<NonNullable<AllySeen["claim"]>>): AllySeen => ({
	key: `${TEAM}:${MAC}`, label: "mac", short: MAC.slice(0, 6), online: true, boardAgeMs: 0, timed: true, open: false, team: TEAM, device: MAC, mains: [{ id: BY, name: "work-on" }],
	...(claim ? { claim: { by: BY, since: now - MIN, ts: now, attended: true, level: "dispatch", ...claim } } : {}),
});

test("a held box: told once to the head tower, the standing main and the coordinators; no under for its mains; ended once with its reason; neither repeated after a restart", async () => {
	const { w, make } = world({ unattended: true, budget: 4 });
	w.cap("s-a", { ready: [{ points: 1 }], open: 2 });
	const since = w.clock.now() - MIN;
	w.allies = [mac(w.clock.now(), { since })];
	let watch = make();
	await run(watch, w.clock, 15);
	const held = w.told.filter((e) => e.kind === "held");
	assert.equal(held.length, 1);
	assert.deepEqual([held[0]!.standing, held[0]!.also, held[0]!.workspace], ["s-st", ["s-a"], undefined], "the standing main, the coordinators (not the worker), the head tower");
	assert.match(held[0]!.text, /^sb: this device is held by main "work-on" on "mac" \(aaaaaa\) since \d\d:\d\d; .*start no new work of your own/);
	assert.equal(w.told.filter((e) => e.kind === "under").length, 0, "no under while held (D5)");
	assert.equal(readHold(w.dir, w.clock.now())?.device, MAC);
	watch = make(); // a restart
	await run(watch, w.clock, 3);
	assert.equal(w.told.filter((e) => e.kind === "held").length, 1, "not told again after a restart");
	w.mains.push({ session: "s-b", name: "new", workspace: "w1", role: "main", state: "idle", workers: [], fileMtime: w.clock.now(), entryUpdated: w.clock.now() });
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.filter((e) => e.kind === "held").slice(1).map((e) => [e.main, e.mainOnly]), [["s-b", true]], "a coordinator that starts on the held box is told once");
	w.mains.pop();
	w.allies = [mac(w.clock.now())]; // the controller's board no longer holds it
	await run(watch, w.clock, 1);
	const ended = w.told.filter((e) => e.kind === "hold-ended");
	assert.equal(ended.length, 1);
	assert.match(ended[0]!.text, /ended \(released\): resume your own intake/);
	assert.equal(readHold(w.dir, w.clock.now()), undefined);
	watch = make();
	await run(watch, w.clock, 11);
	assert.equal(w.told.filter((e) => e.kind === "hold-ended").length, 1, "the end is not repeated either");
	assert.equal(w.told.filter((e) => e.kind === "under").length, 1, "under again once the hold ended");
});

test("a hold the box's boss ended here ends as `ended here`; a stale main of a held box gets the held hints", async () => {
	const { w, make } = world({ unattended: true });
	const since = w.clock.now() - MIN;
	w.mains[0]!.fileMtime = w.mains[0]!.entryUpdated = w.clock.now() - 40 * MIN;
	w.cap("s-a", { open: 2 });
	w.allies = [mac(w.clock.now(), { since })];
	const watch = make();
	await run(watch, w.clock, 1);
	const stale = w.told.find((e) => e.kind === "stale")!;
	assert.equal(stale.held, true);
	const sent: Record<string, string> = {};
	await tellCap(stale, { run: (async () => "") as never, towers: () => undefined, tellSession: async (session, text) => ((sent[session] = text), "delivered") }, 0);
	assert.match(sent["s-a"]!, /this device is held: finish the item in hand or report it blocked; start no new work/);
	assert.match(sent["s-st"]!, /this device is held: do not dispatch new work here$/);
	addIgnored(w.dir, w.clock.now(), { device: MAC, since });
	w.allies = [mac(w.clock.now(), { since })];
	await run(watch, w.clock, 1);
	assert.match(w.told.find((e) => e.kind === "hold-ended")!.text, /ended \(ended here\)/);
});

test("the controller: held-room to the holding main alone after 10 minutes of room on an honoured hold; silent goes to it too", async () => {
	const { w, make } = world({ unattended: false });
	const since = w.clock.now() - MIN;
	w.holds = [{ team: TEAM, device: BOX, session: "s-a", since }];
	const box = (o: Partial<AllySeen> = {}): AllySeen => ({ key: `${TEAM}:${BOX}`, label: "box 2", short: BOX.slice(0, 6), online: true, boardAgeMs: 0, timed: true, open: true, team: TEAM, device: BOX, echo: { by: BY, since }, cap: { points: 6, budget: 16, load1: 3.1, cores: 32 }, ...o });
	w.allies = [box({ echo: { by: BY, since: since - 1 } })];
	const watch = make();
	await run(watch, w.clock, 12);
	assert.equal(w.told.filter((e) => e.kind === "held-room").length, 0, "not honoured: no room notice");
	w.allies = [box()];
	await run(watch, w.clock, 10);
	assert.equal(w.told.filter((e) => e.kind === "held-room").length, 0, "held 10 minutes first");
	await run(watch, w.clock, 1);
	const room = w.told.filter((e) => e.kind === "held-room");
	assert.deepEqual(room.map((e) => [e.main, e.mainOnly, e.text]), [["s-a", true, 'capacity held-room · device "box 2" (cccccc) · 6 / 16 pts · load 3.1 / 32 cores · you hold it: send worker slips or release it']]);
	w.allies = [box({ boardAgeMs: 40 * MIN })];
	await run(watch, w.clock, 1);
	const silent = w.told.find((e) => e.kind === "silent")!;
	assert.equal(silent.main, "s-a");
	assert.match(silent.mainText!, /you hold this device: move its work elsewhere or release it$/);
	w.ended = [{ team: TEAM, device: BOX, session: "s-a", since, at: w.clock.now(), reason: "ended-there" }];
	await run(watch, w.clock, 2);
	assert.deepEqual(w.told.filter((e) => e.kind === "hold-ended").map((e) => [e.main, e.mainOnly]), [["s-a", true]], "the box's boss ended it there: told once");
});
