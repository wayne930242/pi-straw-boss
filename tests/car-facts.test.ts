import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type Board, type BoardStep, type CarRow, carsDir, type Writer, writeBoard, writeYard } from "../src/train/board.ts";
import { KEEP_ENDED_MS, ladderOf } from "../src/train/carfacts.ts";
import { addState, type CarFile, carFileName, type CarView, emptyCar, type Setter } from "../src/train/cars.ts";
import { readYards } from "../src/server/trainyard.ts";
import { SHA_A, SHA_B, SHA_C } from "./train-fixtures.ts";

// Car rows (docs/specs/2026-11-28-car-rows.md): the server joins its book of cars and the trainboards into one fact per car, which the session words for its todo panel and the page for a main's card.
// The ladder is the real train 2026-11-26-zj of rest-api-v3 (11 steps, a review that failed, a second assembly, a merge retried), copied from its board.json.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-carfacts-"))), dirs.at(-1)!);
const MIN = 60_000, NOW = Date.parse("2026-11-27T10:00:00Z");
const iso = (ago: number) => new Date(NOW - ago).toISOString();
const P = "moldplan-center", APP = "rest-api-v3", ZJ = "2026-11-26-zj", L = "2026-11-27-l", J = "2026-11-27-j";
const COORD = "01a21221-b15a-75be-8619-f7ab0167be41", INTEG = "01a207a3-5b88-764f-b60f-cac61f4c150c", OTHER = "01a2aaaa-0000-7000-8000-000000000000";
const SHA_D = "d".repeat(40), SHA_E = "e".repeat(40), SHA_F = "f".repeat(40);
const LIVE = new Set([3214, 3300, 46733]);
const writer = (pid: number, session = `sess-${pid}`): Writer => ({ session, pane: `w15X:p${pid}`, pid, started: "2026-11-27T04:53:43.000Z" });
const car = (over: Partial<CarRow> = {}): CarRow => ({ tickets: ["MP-5303"], branch: "agent/mp-5303", head: SHA_A, coordinator: COORD, departs: "next", accept: "none", accepted: [], ...over });
const s = (id: number, kind: BoardStep["kind"], status: BoardStep["status"], round: number, over: Partial<BoardStep> = {}): BoardStep => ({ id, kind, name: `${kind} ${id}`, status, round, ...over });

/** 2026-11-26-zj as it landed: round 1 assemble, review (failed), full-check; round 2 assemble, review, full-check, merge (failed), merge, ci, deploy-verify, land. */
const ZJ_STEPS: BoardStep[] = [
	s(1, "assemble", "completed", 1, { outcome: "passed" }), s(2, "review", "completed", 1, { outcome: "failed" }), s(3, "full-check", "completed", 1, { outcome: "passed" }),
	s(4, "assemble", "completed", 2, { outcome: "passed" }), s(5, "review", "completed", 2, { outcome: "passed" }), s(6, "full-check", "completed", 2, { outcome: "passed" }),
	s(7, "merge", "completed", 2, { outcome: "failed" }), s(8, "merge", "completed", 2, { outcome: "passed" }), s(9, "ci", "completed", 2, { outcome: "passed" }),
	s(10, "deploy-verify", "completed", 2, { outcome: "passed" }), s(11, "land", "completed", 2, { outcome: "passed" }),
];
const board = (code: string, over: Partial<Board> = {}): Board => ({ v: 1, project: P, app: APP, code, writer: writer(3214), updated: iso(MIN), round: 1, cars: [car()], steps: [], ...over });
const SETTER: Setter = { role: "main", name: "integ moldplan-center", session: INTEG };
function putCar(dir: string, head: string, ticket: string, states: [string, Record<string, unknown>, number][], coordinator = COORD): CarFile {
	let file = emptyCar({ project: P, app: APP, tickets: [ticket], branch: `agent/${ticket.toLowerCase()}`, head, coordinator });
	for (const [name, fields, ago] of states) file = addState(file, { state: name as never, fields, by: SETTER, at: iso(ago) });
	mkdirSync(carsDir(dir, P), { recursive: true });
	writeFileSync(join(carsDir(dir, P), carFileName(APP, head)), JSON.stringify(file));
	return file;
}
const read = (dir: string, over: object = {}) => readYards({ stateDir: dir, now: () => NOW, alive: (w: Writer) => LIVE.has(w.pid), seen: () => NOW - 3 * MIN, ...over }, { trains: [], mains: new Set(), integrators: new Set() });
const carsOf = (dir: string, over: object = {}) => read(dir, over)!.projects.find((p) => p.project === P)!.cars ?? [];

/** zj landed (the ladder), l rides at its second merge, j holds the lane; a forming train waits in the yard; the journal holds the states. */
function world() {
	const dir = state();
	writeBoard(dir, board(ZJ, { writer: writer(9999), updated: iso(20 * 60 * MIN), round: 2, steps: ZJ_STEPS, cars: [car({ head: SHA_F, tickets: ["MP-5303"] })] }));
	writeBoard(dir, board(J, { writer: writer(3300), cars: [car({ tickets: ["MP-5790"], head: SHA_E, coordinator: OTHER })], steps: [s(1, "assemble", "completed", 1, { outcome: "passed", holds: { lane: APP } }), s(2, "merge", "in_progress", 1, { holds: { lane: APP } })] }));
	writeBoard(dir, board(L, {
		cars: [car({ tickets: ["MP-5801"], head: SHA_A })],
		steps: [s(1, "assemble", "completed", 1, { outcome: "passed", holds: { lane: APP } }), s(2, "review", "completed", 1, { outcome: "passed", holds: { lane: APP } }), s(3, "full-check", "completed", 1, { outcome: "passed", holds: { lane: APP } }), s(4, "merge", "completed", 1, { outcome: "failed", holds: { lane: APP } }), s(5, "merge", "in_progress", 1, { holds: { lane: APP } })],
	}));
	writeYard(dir, { v: 1, project: P, writer: writer(46733, INTEG), updated: iso(MIN), trains: [
		{ code: "2026-11-27-m", app: APP, status: "forming", cars: [car({ tickets: ["MP-5803"], head: SHA_B, arrived: iso(37 * MIN) })], departs: { maxCars: 4, maxWaitMin: 60, oldest: iso(37 * MIN) } },
		{ code: L, app: APP, status: "opened", session: "sess-3214", cars: [car({ tickets: ["MP-5801"], head: SHA_A })] },
	] });
	putCar(dir, SHA_A, "MP-5801", [["received", { train: L, departs: "next" }, 90 * MIN]]);
	putCar(dir, SHA_B, "MP-5803", [["received", { train: "2026-11-27-m", departs: "next" }, 37 * MIN]]);
	putCar(dir, SHA_F, "MP-5303", [["received", { train: ZJ, departs: "next" }, 22 * 60 * MIN], ["landed", { version: "1.62.0-beta.24", commit: "1".repeat(40) }, 20 * 60 * MIN]]);
	return dir;
}

test("the ladder of an app is its last landed train's last round, each kind once: zj's 11 steps make 7 stages", () => {
	const yards = read(world())!, trains = yards.projects[0]!.trains;
	assert.deepEqual(ladderOf(trains, APP), ["assemble", "review", "full-check", "merge", "ci", "deploy-verify", "land"]);
	assert.equal(ladderOf(trains, "fe2"), undefined, "an app with no landed train has no ladder");
});

test("a riding car is on its train's step in progress: its place on the ladder, the attempt at a kind run again, what it waits for, and when the step began", () => {
	const dir = world(), facts = carsOf(dir), l = facts.find((c) => c.head === SHA_A)!;
	assert.equal(l.phase, "riding");
	assert.equal(l.train, L);
	assert.equal(l.coordinator, COORD);
	assert.equal(l.integrator, INTEG, "the session that received it");
	assert.deepEqual(l.tickets, ["MP-5801"]);
	assert.deepEqual(l.stage, { kind: "merge", at: 4, of: 7, attempt: 2 }, "the second merge: the ladder does not grow");
	assert.deepEqual(l.waits, [{ lane: { app: APP, holder: J } }], "j, an earlier code, holds the lane");
	assert.equal(l.since, NOW - 3 * MIN, "no gate file: the first time the server saw the step");
	assert.equal(l.id, `${P}/${APP}-${SHA_A.slice(0, 12)}#1`);
});

test("a step whose gate recorded its start begins then; between two steps the last done is shown", () => {
	const dir = world();
	writeFileSync(join(dir, "trainboard", P, L, "gate-5.json"), JSON.stringify({ v: 1, project: P, app: APP, train: L, step: 5, kind: "merge", name: "merge 5", state: "running", since: iso(12 * MIN), updated: iso(MIN), message: "", waits: [], pid: 3214, spec: "0".repeat(64) }));
	assert.equal(carsOf(dir).find((c) => c.head === SHA_A)!.since, NOW - 12 * MIN);
	writeBoard(dir, board(L, { cars: [car({ tickets: ["MP-5801"], head: SHA_A })], steps: [s(1, "assemble", "completed", 1, { outcome: "passed" }), s(2, "review", "completed", 1, { outcome: "passed" })] }));
	assert.deepEqual(carsOf(dir).find((c) => c.head === SHA_A)!.stage, { kind: "review", at: 2, of: 7, attempt: 1, between: true });
});

test("a received car in a forming train waits with the departure rule; a landed car shows its version for 30 minutes, then goes", () => {
	const dir = world(), facts = carsOf(dir);
	const m = facts.find((c) => c.head === SHA_B)!;
	assert.equal(m.phase, "waiting");
	assert.equal(m.train, "2026-11-27-m");
	assert.equal(m.since, NOW - 37 * MIN, "its receipt");
	assert.deepEqual(m.departs, { maxCars: 4, maxWaitMin: 60, oldest: iso(37 * MIN) });
	assert.equal(facts.find((c) => c.head === SHA_F), undefined, "zj landed 20 hours ago: its car shows no more");
	putCar(dir, SHA_F, "MP-5303", [["received", { train: ZJ, departs: "next" }, 60 * MIN], ["landed", { version: "1.62.0-beta.24", commit: "1".repeat(40) }, 10 * MIN]]);
	const zj = carsOf(dir).find((c) => c.head === SHA_F)!;
	assert.deepEqual([zj.phase, zj.version, zj.since, zj.train], ["landed", "1.62.0-beta.24", NOW - 10 * MIN, ZJ]);
	putCar(dir, SHA_F, "MP-5303", [["received", { train: ZJ, departs: "next" }, 60 * MIN], ["landed", { version: "1.62.0-beta.24", commit: "1".repeat(40) }, KEEP_ENDED_MS + MIN]]);
	assert.equal(carsOf(dir).find((c) => c.head === SHA_F), undefined);
});

test("the book speaks before the journal: a car returned at receipt, on no board, shows with the first line of its reason and the count of its lives", () => {
	const dir = world();
	let returned = emptyCar({ project: P, app: APP, tickets: ["MP-5810"], branch: "agent/mp-5810", head: SHA_C, coordinator: COORD });
	returned = addState(returned, { state: "returned", fields: { reason: "head is not the tip of agent/mp-5810\nsecond line" }, by: SETTER, at: iso(5 * MIN) });
	let older = emptyCar({ project: P, app: APP, tickets: ["MP-5810"], branch: "agent/mp-5810", head: SHA_C, coordinator: COORD });
	older = addState(older, { state: "dropped", fields: { round: 1, reason: "unit red", evidence: "/r/x.log" }, by: SETTER, at: iso(50 * MIN) });
	const views: CarView[] = [{ file: older }, { file: returned }];
	const book = { viewOf: () => undefined, read: (project: string) => (project === P ? views : []) };
	const c = carsOf(dir, { book }).find((x) => x.head === SHA_C)!;
	assert.deepEqual([c.phase, c.reason, c.since, c.id], ["returned", "head is not the tip of agent/mp-5810", NOW - 5 * MIN, `${P}/${APP}-${SHA_C.slice(0, 12)}#2`]);
});

test("a dropped car a round left out is told by its own life, and a car another session coordinates names that session", () => {
	const dir = world();
	writeBoard(dir, board(L, { round: 2, removed: [{ ticket: "MP-5473", why: "review P1", head: SHA_D }], cars: [car({ tickets: ["MP-5801"], head: SHA_A })], steps: [s(1, "assemble", "completed", 2, { outcome: "passed" })] }));
	putCar(dir, SHA_D, "MP-5473", [["received", { train: L, departs: "next" }, 90 * MIN], ["dropped", { round: 1, reason: "train review P1 ZJ-F001: truncates", evidence: "/r/review.md" }, 8 * MIN]]);
	const facts = carsOf(dir);
	assert.deepEqual(((c) => [c.phase, c.reason, c.train])(facts.find((x) => x.head === SHA_D)!), ["dropped", "train review P1 ZJ-F001: truncates", L]);
	assert.equal(facts.find((x) => x.head === SHA_E)!.coordinator, OTHER);
});
