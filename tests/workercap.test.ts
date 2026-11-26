import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { capDir, writeDevice } from "../src/capacity.ts";
import { createReservations, RES_EXPIRE_MS, type Reservations } from "../src/capres.ts";
import { admitPoints, createWorkerCap, deviceRoom, type Room } from "../src/workercap.ts";
import { fakeClock } from "./fake-clock.ts";

// docs/specs/2026-11-24-capacity.md, The cap: sb holds back no worker by count. On an attended device (the boss's own) nothing gates a worker; on an unattended one the device's points gate it,
// against `capacity.budget` read from config.json at each admission (none set: no cap), and a launch holds its points in a reservation every main of the device sees until a device row sampled
// after its launch shows that worker under its main, its call fails, or it expires.
const REGISTRY = Symbol.for("pi-subagents/runtime");
const MIN = 60_000;
/** pi-herdr-agents' registry of this process: `n` running workers named w0, w1, ..., or the names given. */
const registry = (workers: number | string[]) => {
	const running = new Map<string, { id: string; agent: string; name: string }>();
	for (const name of typeof workers === "number" ? Array.from({ length: workers }, (_, i) => `w${i}`) : workers) running.set(name, { id: name, agent: "worker", name });
	(globalThis as Record<symbol, unknown>)[REGISTRY] = { runningSubagents: running };
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** The mains the server sampled, with the running workers it saw: `s-a` and `s-b` unless named. */
const sampled = (a: string[] = [], b: string[] = []) => [{ session: "s-a", workers: a }, { session: "s-b", workers: b }];
/** One unattended device: its capacity folder, a clock, its budget, and the device row every main reads (`row`, which the test replaces as the server would; undefined: no fresh row). */
function device(row: (Partial<Room> & { points: number }) | undefined, given: number | "none" = 2) {
	const dir = mkdtempSync(join(tmpdir(), "psb-wcap-")), clock = fakeClock(Date.parse("2026-11-24T10:00:00Z"));
	dirs.push(dir);
	const d = { dir, clock, budget: given === "none" ? undefined : given, attended: false, row: row && ({ mains: sampled(), ...row, at: row.at ?? clock.now() } as Room | undefined) };
	/** A main: its own cap and its own store over the shared folder, as a second process would have; `room` is its own read of the row (a test may lag it). */
	const main = (session = "s-a", room = () => d.row, store: Reservations = createReservations(dir, clock.now)) => createWorkerCap({ room, store, session: () => session, budget: () => d.budget, attended: () => d.attended });
	return { d, main, held: () => { try { return readdirSync(join(dir, "_reserved")).filter((n) => n.endsWith(".json")).length; } catch { return 0; } } };
}
const worker = (name?: string) => ({ agent: "worker", ...(name ? { name } : {}) });
const todos = (tasks: { id: number; owner?: string; status?: string; points?: number }[]) => () => [{ type: "custom", customType: "rpiv-todo-state", data: { nextId: 99, tasks: tasks.map((t) => ({ id: t.id, subject: `t${t.id}`, status: t.status ?? "pending", ...(t.owner ? { owner: t.owner } : {}), ...(t.points !== undefined ? { metadata: { points: t.points } } : {}) })) } }];

// Boss 2026-11-24: 「本來就不該有上限，我自己盯。只有無人塔台要有點數上限，而且不該寫死」.
test("an attended device caps no worker, with or without a budget: the budget there is for the board only", () => {
	registry(10);
	for (const budget of ["none", 2] as const) {
		const { d, main, held } = device({ points: 10 }, budget);
		d.attended = true;
		const cap = main();
		for (let i = 0; i < 8; i++) assert.equal(cap.admit(`c${i}`, worker(`x${i}`)), undefined, `worker ${i + 11} with budget ${budget}`);
		assert.equal(held(), 0, "no reservation");
	}
	assert.equal(createWorkerCap().admit("c1", worker()), undefined, "no device side: no cap");
});

test("an unattended device with no budget configured caps no worker and reserves nothing", () => {
	registry(10);
	const { main, held } = device({ points: 10 }, "none"), cap = main();
	for (let i = 0; i < 8; i++) assert.equal(cap.admit(`c${i}`, worker(`x${i}`)), undefined);
	assert.equal(held(), 0);
});

test("on an unattended device the device's points gate a worker, whatever their count, and a light worker weighs its 0.25", () => {
	registry(6);
	const { d, main } = device({ points: 6 }, 8), cap = main();
	assert.equal(cap.admit("c1", worker()), undefined, "6 + 1 fits 8, though 6 workers run");
	assert.equal(cap.admit("c2", worker()), undefined, "6 + 1 held + 1 fits 8");
	assert.match(cap.admit("c3", worker())?.reason ?? "", /^sb: the device runs 6 of its 8 capacity points, 2 more held by launches it does not count yet: this worker needs 1\. Wait for a result/);
	assert.equal(cap.admit("c-s", { agent: "scout" }), undefined, "a scout is no worker");
	cap.settle();
	d.row = { points: 8, at: d.clock.now(), mains: sampled() };
	assert.match(cap.admit("c4", worker())?.reason ?? "", /8 of its 8 capacity points/);

	registry(0);
	const light = device({ points: 0 }, 2).main(), names = Array.from({ length: 9 }, (_, i) => `api${i}`);
	const branch = todos(names.map((owner, i) => ({ id: i + 1, owner, points: 0.25 })));
	for (const name of names.slice(0, 8)) assert.equal(light.admit(name, worker(name), branch), undefined, `${name}: 0.25 each, 8 of them fit 2`);
	assert.match(light.admit("api8", worker("api8"), branch)?.reason ?? "", /runs 0 of its 2 capacity points, 2 more held by launches it does not count yet: this worker needs 0\.25\./);
});

test("the budget is read at each admission: a change in config.json applies without a restart", () => {
	registry(0);
	const dir = mkdtempSync(join(tmpdir(), "psb-wcap-cfg-"));
	dirs.push(dir);
	const config = (budget?: number) => writeFileSync(join(dir, "config.json"), JSON.stringify(budget === undefined ? {} : { capacity: { budget } }));
	writeDevice(capDir(join(dir, "board")), { v: 1, at: Date.now(), points: 1, load1: 0, cores: 8, ready: 0, open: 0, unattended: true, mains: [{ session: "s-a", name: "a", workspace: "w", points: 1, ready: 0, open: 0, workers: [] }] });
	const cap = createWorkerCap(deviceRoom(dir, () => "s-a", () => false));
	config(1);
	assert.match(cap.admit("c1", worker("x"))?.reason ?? "", /runs 1 of its 1 capacity points/);
	config(3);
	assert.equal(cap.admit("c2", worker("y")), undefined, "the raised budget applies at once");
	assert.equal(cap.admit("c3", worker("z")), undefined);
	assert.match(cap.admit("c4", worker("w"))?.reason ?? "", /runs 1 of its 3 capacity points, 2 more held/);
	config();
	assert.equal(cap.admit("c5", worker("v")), undefined, "the budget removed: no cap");
	assert.equal(createWorkerCap(deviceRoom(dir, () => "s-a", () => true)).admit("c6", worker("u")), undefined, "attended");
});

// Review prompts-review F001: one device row (sampled once a minute, usable for 5) let every launch through, turn after turn and main after main, because a launch that returned forgot its points.
test("two mains, several turns, one snapshot: the device's reservations hold the budget until a later row shows their workers, a failed call frees its points, an unlaunched one goes at the turn's end, and one expires", () => {
	registry(0);
	const { d, main, held } = device({ points: 0 }), a = main("s-a"), b = main("s-b");
	for (const id of ["a1", "a2"]) {
		assert.equal(a.admit(id, worker(id)), undefined, `${id} fits`);
		a.ran(id, false);
		a.settle();
		d.clock.advance(10_000);
	}
	assert.match(a.admit("a3", worker("a3"))?.reason ?? "", /runs 0 of its 2 capacity points, 2 more held/, "a third launch of the same main in a later turn");
	assert.match(b.admit("b1", worker("b1"))?.reason ?? "", /runs 0 of its 2 capacity points, 2 more held/, "another main sees the same reservations");
	assert.equal(held(), 2);

	d.row = { points: 2, at: d.clock.now(), mains: sampled([" A1", "a2"]) }; // the server's next row, sampled after both launches, shows both workers under main s-a
	assert.match(b.admit("b2", worker("b2"))?.reason ?? "", /runs 2 of its 2 capacity points, 0 more held/);

	d.row = { points: 1, at: d.clock.now(), mains: sampled(["a1"]) }; // a2 ended
	assert.equal(b.admit("b3", worker("b3")), undefined, "a2's reservation, shown by an earlier row, is not counted again by a newer one");
	b.ran("b3", true); // its call failed: no worker started
	assert.equal(b.admit("b4", worker("b4")), undefined, "a failed call frees its points");
	assert.match(a.admit("a4", worker("a4"))?.reason ?? "", /runs 1 of its 2 capacity points, 1 more held/, "b4 holds its point while its call runs");
	b.settle(); // b4's turn ended without its result (another extension blocked it)
	assert.equal(a.admit("a5", worker("a5")), undefined, "an unlaunched reservation goes with its turn");
	a.ran("a5", false);
	a.settle();
	d.clock.advance(MIN);
	d.row = { ...d.row, at: d.clock.now(), mains: sampled(["a1"]) }; // sampled after a5's launch, without a5 (its pane not marked yet)
	assert.match(b.admit("b5", worker("b5"))?.reason ?? "", /1 more held/, "a newer row that does not show a5 retires nothing: a timestamp alone never does");
	d.clock.advance(RES_EXPIRE_MS + 1);
	assert.equal(b.admit("b6", worker("b6")), undefined, "a reservation no row showed expires after 10 minutes");
});

// Re-review of F001, hole 1: a reader whose row lags must still count a launch a newer row showed to another reader; and the row is read after the reservation is published.
test("a lagging reader counts a launch only a newer row shows, and admission reads the row after it published its reservation", () => {
	registry(0);
	const { d, main } = device({ points: 0 }), lagging = d.row;
	const a = main("s-a", () => lagging), b = main("s-b");
	assert.equal(a.admit("a1", worker("a1")), undefined);
	a.ran("a1", false);
	a.settle();
	d.clock.advance(MIN);
	d.row = { points: 1, at: d.clock.now(), mains: sampled(["a1"]) }; // B reads the server's newer row, which counts a1
	assert.equal(b.admit("b1", worker("b1")), undefined, "1 used (a1) + b1 fits 2");
	assert.match(a.admit("a2", worker("a2"))?.reason ?? "", /runs 0 of its 2 capacity points, 2 more held/, "A's row predates a1: a1 and b1 both count");

	const { d: d2, main: main2, held } = device({ points: 0 });
	const store = createReservations(d2.dir, d2.clock.now);
	// The server writes a newer row between the first read and the reservation: the admission must decide on the row read after it published.
	const racing: Reservations = { ...store, add: (points, who) => ((d2.row = { points: 2, at: d2.clock.now(), mains: sampled() }), store.add(points, who)) };
	const c = main2("s-a", undefined, racing);
	assert.match(c.admit("c1", worker("c1"))?.reason ?? "", /runs 2 of its 2 capacity points/, "decided on the row read after publishing");
	assert.equal(held(), 0, "the refused launch leaves nothing");
});

// Re-review of F001, hole 2: only the primary server's Herdr slot is sampled. A main the row does not list (another slot, or not sampled yet), and every main while no fresh row exists, takes the
// points path all the same: it reserves device-wide, and counts its own running workers from its registry (no row counts them) in place of its own launched reservations.
test("a main the device row does not list, or no fresh row at all, takes the points path: device-wide reservations plus its own running workers", () => {
	registry(0);
	const { d, main, held } = device({ points: 1 }, 3), other = main("s-other"), a = main("s-a");
	assert.equal(other.admit("o1", worker("o1")), undefined, "1 used + o1 fits 3");
	assert.equal(held(), 1, "it reserves device-wide");
	assert.equal(a.admit("a1", worker("a1")), undefined, "1 used + o1 + a1 fits 3");
	assert.match(other.admit("o2", worker("o2"))?.reason ?? "", /^sb: the device runs 1 of its 3 capacity points, 2 more held by launches it does not count yet: this worker needs 1\./);
	other.ran("o1", false);
	other.settle();
	a.settle();
	registry(["o1"]); // s-other's registry holds o1 now; no row will ever show it
	assert.equal(other.admit("o3", worker("o3")), undefined, "o1 counts once, by the registry: 1 + 1 + o3 fits 3");
	other.settle();
	d.clock.advance(RES_EXPIRE_MS + 1);
	assert.equal(other.admit("o4", worker("o4")), undefined, "o1's reservation expired");
	assert.match(other.admit("o5", worker("o5"))?.reason ?? "", /runs 2 of its 3 capacity points, 1 more held/, "o1 still counts, from the registry");

	registry(0);
	const none = device(undefined, 1).main("s-a");
	assert.equal(none.admit("n1", worker("n1")), undefined, "no fresh row: 0 + n1 fits 1");
	assert.match(none.admit("n2", worker("n2"))?.reason ?? "", /runs 0 of its 1 capacity points, 1 more held/, "not the count: the points");
});

// Review prompts-review F002: the board's headroom weighs the ready todo's points, so admission weighs the todo the subagent's name owns, not 1 per worker.
test("admission weighs the todo whose owner is the subagent's name (case- and space-folded), else 1", () => {
	registry(0);
	const { d, main } = device({ points: 1.5 }), cap = main();
	const branch = todos([{ id: 1, owner: "Ready One", points: 0.5 }, { id: 2, owner: "big", points: 2 }, { id: 3, owner: "done one", status: "completed", points: 0.5 }]);
	assert.equal(cap.admit("c1", worker(" ready one"), branch), undefined, "1.5 used + 0.5 ready fits 2");
	assert.match(cap.admit("c1b", worker("x"), branch)?.reason ?? "", /runs 1\.5 of its 2 capacity points, 0\.5 more held by launches it does not count yet: this worker needs 1\./, "c1 holds its 0.5");
	cap.settle();
	d.row = { points: 1, at: d.clock.now(), mains: sampled() };
	assert.match(cap.admit("c2", worker("BIG"), branch)?.reason ?? "", /runs 1 of its 2 capacity points, 0 more held by launches it does not count yet: this worker needs 2\./, "a 2-point ticket at 1 point of headroom");
	assert.equal(cap.admit("c3", worker("done one"), branch), undefined, "a completed todo weighs nothing: the default 1 fits");
	assert.match(cap.admit("c4", worker(), branch)?.reason ?? "", /1 more held by launches it does not count yet: this worker needs 1\./, "no name: 1");
});

test("a worker main's self reservation counts until a row lists its session, whatever workers that row shows (docs/specs/2026-11-26-ally-workers.md)", () => {
	const { d, main } = device({ points: 0 }, 3);
	const store = createReservations(d.dir, d.clock.now);
	const got = admitPoints({ room: () => d.row, store }, 3, 2, { session: "", worker: "", self: true });
	assert.ok("id" in got);
	assert.ok(main().admit("c1", worker("u")) === undefined, "1 more fits beside the 2 held");
	assert.ok(main().admit("c2", worker("v")), "a third point does not fit");
	store.claim(got.id, "w-1");
	d.clock.advance(MIN);
	d.row = { points: 2, at: d.clock.now(), mains: [{ session: "w-1", workers: [] }] };
	assert.deepEqual(store.live(d.row.at!, (h) => h.self === true && d.row!.mains!.some((m) => m.session === h.session)).map((r) => r.session), ["s-a"], "the worker's row shows it: only s-a's launch still counts");
	assert.ok("refusal" in admitPoints({ room: () => d.row, store }, 3, 1, { session: "", worker: "", self: true }), "the row's 2 and s-a's 1 fill the budget");
});
