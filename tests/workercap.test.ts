import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createReservations, RES_EXPIRE_MS, RES_MARGIN_MS } from "../src/capres.ts";
import { createWorkerCap, type Room } from "../src/workercap.ts";
import { fakeClock } from "./fake-clock.ts";

// docs/specs/2026-11-24-capacity.md, The cap: with a capacity budget the device's points gate a worker instead of the count of 4, and a launch holds its points in a reservation every main of the
// device sees until a device row sampled after it counts the worker, its call fails, or it expires.
const REGISTRY = Symbol.for("pi-subagents/runtime");
const MIN = 60_000;
const registry = (workers: number) => {
	const running = new Map<string, { id: string; agent: string }>();
	for (let i = 0; i < workers; i++) running.set(`w${i}`, { id: `w${i}`, agent: "worker" });
	(globalThis as Record<symbol, unknown>)[REGISTRY] = { runningSubagents: running };
};
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
/** One device: its capacity folder, a clock, and the device row every main reads (`row`, which the test replaces as the server would). */
function device(row: Room) {
	const dir = mkdtempSync(join(tmpdir(), "psb-wcap-")), clock = fakeClock(Date.parse("2026-11-24T10:00:00Z"));
	dirs.push(dir);
	const d = { dir, clock, row: { ...row, at: row.at ?? clock.now() } as Room };
	/** A main: its own cap and its own store over the shared folder, as a second process would have. */
	const main = () => createWorkerCap(undefined, { room: () => d.row, store: createReservations(dir, clock.now) });
	return { d, main, held: () => readdirSync(join(dir, "_reserved")).filter((n) => n.endsWith(".json")).length };
}
const worker = (name?: string) => ({ agent: "worker", ...(name ? { name } : {}) });
const _todos = (tasks: { id: number; owner?: string; status?: string; points?: number }[]) => () => [{ type: "custom", customType: "rpiv-todo-state", data: { nextId: 99, tasks: tasks.map((t) => ({ id: t.id, subject: `t${t.id}`, status: t.status ?? "pending", ...(t.owner ? { owner: t.owner } : {}), ...(t.points !== undefined ? { metadata: { points: t.points } } : {}) })) } }];

test("with a budget, the device's points gate a worker, past the count of 4", () => {
	registry(6);
	const { d, main } = device({ points: 6, budget: 8 });
	const cap = main();
	assert.equal(cap.admit("c1", worker()), undefined, "6 + 1 fits 8, though 6 workers run");
	assert.equal(cap.admit("c2", worker()), undefined, "6 + 1 held + 1 fits 8");
	assert.match(cap.admit("c3", worker())?.reason ?? "", /^sb: the device runs 6 of its 8 capacity points, 2 more held by launches it does not count yet: this worker needs 1\. Wait for a result/);
	assert.equal(cap.admit("c-s", { agent: "scout" }), undefined, "a scout is no worker");
	cap.settle();
	d.row = { points: 8, budget: 8, at: d.clock.now() };
	assert.match(cap.admit("c4", worker())?.reason ?? "", /8 of its 8 capacity points/);
});

test("without a budget, or with no fresh device row, the count of 4 stands", () => {
	registry(4);
	const { d } = device({ points: 0 }), store = createReservations(d.dir, Date.now);
	for (const room of [undefined, { points: 0 }]) {
		const cap = createWorkerCap(undefined, { room: () => room, store });
		assert.match(cap.admit("c1", worker())?.reason ?? "", /^sb: 4 workers run for this main already/);
	}
	registry(3);
	assert.equal(createWorkerCap(undefined, { room: () => ({ points: 0 }), store }).admit("c1", worker()), undefined);
});

// Review prompts-review F001: one device row (sampled once a minute, usable for 5) let every launch through, turn after turn and main after main, because a launch that returned forgot its points.
test("two mains, several turns, one snapshot: the device's reservations hold the budget until a later row counts them, a failed call frees its points, an unlaunched one goes at the turn's end, and one expires", () => {
	registry(0);
	const { d, main, held } = device({ points: 0, budget: 2 }), a = main(), b = main();
	for (const id of ["a1", "a2"]) {
		assert.equal(a.admit(id, worker()), undefined, `${id} fits`);
		a.ran(id, false);
		a.settle();
		d.clock.advance(10_000);
	}
	assert.match(a.admit("a3", worker())?.reason ?? "", /runs 0 of its 2 capacity points, 2 more held/, "a third launch of the same main in a later turn");
	assert.match(b.admit("b1", worker())?.reason ?? "", /runs 0 of its 2 capacity points, 2 more held/, "another main sees the same reservations");
	assert.equal(held(), 2);

	d.row = { points: 2, budget: 2, at: d.clock.now() + RES_MARGIN_MS + 1 }; // the server's next row, sampled after both launches, counts both workers
	d.clock.advance(RES_MARGIN_MS + 1);
	assert.match(b.admit("b2", worker())?.reason ?? "", /runs 2 of its 2 capacity points, 0 more held/);
	assert.equal(held(), 0, "the reservations a later row counts are gone");

	d.row = { points: 1, budget: 2, at: d.clock.now() }; // one worker ended
	assert.equal(b.admit("b3", worker()), undefined);
	b.ran("b3", true); // its call failed: no worker started
	assert.equal(held(), 0, "a failed call frees its points");
	assert.equal(b.admit("b4", worker()), undefined);
	assert.match(a.admit("a4", worker())?.reason ?? "", /runs 1 of its 2 capacity points, 1 more held/, "b4 holds its point while its call runs");
	b.settle(); // b4's turn ended without its result (another extension blocked it)
	assert.equal(a.admit("a5", worker()), undefined, "an unlaunched reservation goes with its turn");
	a.ran("a5", false);
	a.settle();
	assert.match(b.admit("b5", worker())?.reason ?? "", /1 more held/, "the row is older than a5's launch: it holds");
	d.clock.advance(RES_EXPIRE_MS + 1);
	assert.equal(b.admit("b6", worker()), undefined, "a reservation no row counted expires after 10 minutes");
});
