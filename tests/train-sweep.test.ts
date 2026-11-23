import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type Board, type BoardStep, type CarRow, carsDir, type Writer, writeBoard, writeYard } from "../src/train/board.ts";
import { addState, carFileName, emptyCar } from "../src/train/cars.ts";
import { sweepTrainboards } from "../src/server/trainsweep.ts";
import { TowerWorld } from "./tower-world.ts";
import { until } from "./server-world.ts";
import { SHA_A, SHA_B, SHA_C } from "./train-fixtures.ts";

// Only an ended train past 30 days with no live writer is eligible.

const ROOT = process.env.SB_TEST_ROOT!, dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = () => (dirs.push(mkdtempSync(join(ROOT, "sw-"))), dirs.at(-1)!);
const DAY = 24 * 60 * 60_000, NOW = Date.parse("2026-11-20T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const writer: Writer = { session: "s1", pane: "p", pid: 4001, started: "2026-11-01T07:00:00Z" };
const car = (head: string): CarRow => ({ tickets: [`T-${head[0]}`], branch: "b", head, coordinator: "c", departs: "next", accept: "none" });
const step = (id: number, kind: BoardStep["kind"], status: BoardStep["status"], over: Partial<BoardStep> = {}): BoardStep => ({ id, kind, name: `${kind} ${id}`, status, round: 1, ...over });
const ended = (steps: BoardStep[] = [step(1, "land", "completed", { outcome: "passed" })]) => steps;
const board = (project: string, code: string, updated: string, heads: string[], steps: BoardStep[], over: Partial<Board> = {}): Board => ({ v: 1, project, app: "web", code, writer, updated, round: 1, cars: heads.map(car), steps, ...over });

function plantCar(dir: string, project: string, head: string) {
	let file = emptyCar({ project, app: "web", tickets: [`T-${head[0]}`], branch: "b", head, coordinator: "c" });
	file = addState(file, { state: "returned", fields: { reason: "no" }, by: { role: "main", name: "i", session: "s" }, at: ago(DAY) });
	const folder = carsDir(dir, project), name = carFileName("web", head);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, name), JSON.stringify(file));
	writeFileSync(join(folder, name.replace(/\.json$/, ".notice.json")), JSON.stringify({ v: 1, states: {} }));
	return name;
}
const folderOf = (dir: string, project: string, code: string) => join(dir, "trainboard", project, code);
const carFiles = (dir: string, project: string) => (existsSync(carsDir(dir, project)) ? readdirSync(carsDir(dir, project)).sort() : []);
const sweep = (dir: string, alive = false) => sweepTrainboards({ stateDir: dir, now: () => NOW, alive: () => alive });

test("an ended train is deleted 30 days after its last update, with its car files; before then it stays", () => {
	const dir = state();
	writeBoard(dir, board("acme", "2026-11-01-a", ago(30 * DAY), [SHA_A, SHA_B], ended()));
	writeBoard(dir, board("acme", "2026-11-02-b", ago(30 * DAY - 1), [SHA_C], ended()));
	writeFileSync(join(folderOf(dir, "acme", "2026-11-01-a"), "step-1.json"), "{}");
	for (const head of [SHA_A, SHA_B, SHA_C]) plantCar(dir, "acme", head);
	const result = sweep(dir);
	assert.deepEqual(result.removed.map((r) => [r.project, r.code]), [["acme", "2026-11-01-a"]]);
	assert.ok(!existsSync(folderOf(dir, "acme", "2026-11-01-a")), "the folder with its board and step files is gone");
	assert.ok(existsSync(folderOf(dir, "acme", "2026-11-02-b")), "one millisecond before the cutoff: not yet");
	assert.deepEqual(carFiles(dir, "acme"), [carFileName("web", SHA_C), carFileName("web", SHA_C).replace(/\.json$/, ".notice.json")].sort(), "only the cars of the deleted train lose their files");
});

test("open trains (even if cleared) and ended trains with live writers keep their files", () => {
	const dir = state();
	const running = [step(1, "merge", "in_progress", { holds: { lane: "web" } })];
	writeBoard(dir, board("acme", "2026-11-01-a", ago(30 * DAY), [], running));
	writeBoard(dir, board("acme", "2026-11-02-b", ago(30 * DAY), [], running));
	writeBoard(dir, board("acme", "2026-11-03-c", ago(30 * DAY), [], running, { clears: [{ lane: "web", reason: "gone", by: "cli", at: ago(3 * DAY) }] }));
	writeBoard(dir, board("acme", "2026-11-04-d", ago(30 * DAY), [], running, { clears: [{ lane: "web", reason: "gone", by: "cli", at: ago(8 * DAY) }] }));
	writeBoard(dir, board("acme", "2026-11-05-e", ago(38 * DAY), [], ended()));
	assert.deepEqual(sweep(dir, true).removed, [], "a live writer's board stays, ended or not");
	assert.deepEqual(sweep(dir, false).removed.map((r) => r.code), ["2026-11-05-e"], "only the ended train");
	assert.deepEqual(readdirSync(join(dir, "trainboard", "acme")).sort(), ["2026-11-01-a", "2026-11-02-b", "2026-11-03-c", "2026-11-04-d"]);
});

test("a car file another train still carries, a car in a yard, a car no train names, an unreadable board, and a link are left alone", () => {
	const dir = state();
	writeBoard(dir, board("acme", "2026-11-01-a", ago(39 * DAY), [SHA_A, SHA_B, SHA_C], ended()));
	writeBoard(dir, board("acme", "2026-11-02-b", ago(1 * DAY), [SHA_A], [step(1, "merge", "in_progress")]));
	writeYard(dir, { v: 1, project: "acme", writer, updated: ago(DAY), trains: [{ code: "2026-11-09-z", app: "web", status: "forming", cars: [car(SHA_B)] }] });
	const other = "d".repeat(40);
	for (const head of [SHA_A, SHA_B, SHA_C, other]) plantCar(dir, "acme", head);
	mkdirSync(folderOf(dir, "beta", "2026-11-03-c"), { recursive: true });
	writeFileSync(join(folderOf(dir, "beta", "2026-11-03-c"), "board.json"), "{not json");
	mkdirSync(join(dir, "elsewhere", "2026-11-04-d"), { recursive: true });
	writeFileSync(join(dir, "elsewhere", "2026-11-04-d", "board.json"), JSON.stringify(board("acme", "2026-11-04-d", ago(30 * DAY), [], ended())));
	symlinkSync(join(dir, "elsewhere", "2026-11-04-d"), folderOf(dir, "acme", "2026-11-04-d"));
	const result = sweep(dir);
	assert.deepEqual(result.removed.map((r) => r.code), ["2026-11-01-a"]);
	assert.deepEqual(carFiles(dir, "acme").filter((n) => !n.endsWith(".notice.json")), [SHA_A, SHA_B, other].map((h) => carFileName("web", h)).sort(), "A is on a live train, B in the yard, `other` on no board; C only went with its train");
	assert.ok(existsSync(folderOf(dir, "beta", "2026-11-03-c")), "an unreadable board is not guessed to be ended");
	assert.ok(existsSync(join(dir, "elsewhere", "2026-11-04-d", "board.json")), "a link to a folder is not followed");
});

test("in a project where a board does not read, no car file is deleted: what that board carries is unknown", () => {
	const dir = state();
	writeBoard(dir, board("acme", "2026-11-01-a", ago(39 * DAY), [SHA_A], ended()));
	mkdirSync(folderOf(dir, "acme", "2026-11-03-c"), { recursive: true });
	writeFileSync(join(folderOf(dir, "acme", "2026-11-03-c"), "board.json"), "{not json");
	plantCar(dir, "acme", SHA_A);
	assert.deepEqual(sweep(dir).removed, [{ project: "acme", code: "2026-11-01-a", cars: 0 }]);
	assert.ok(!existsSync(folderOf(dir, "acme", "2026-11-01-a")), "the expired board itself goes");
	assert.equal(carFiles(dir, "acme").length, 2, "its car file and notice stay");
});

test("nothing to sweep (no trainboard folder) is no error", () => {
	const dir = state();
	assert.deepEqual(sweep(dir), { removed: [], boards: 0, files: 0, ledgerFiles: 0, problems: [] });
});

test("the integrator index protects its train files, including legacy short codes, without keeping derived boards", () => {
	const dir = state(), ledger = join(dir, "trains", "acme", "web");
	mkdirSync(ledger, { recursive: true });
	const indexed = join(ledger, "2026-10-01-a.json"), unindexed = join(ledger, "2026-10-02-b.json"), index = join(ledger, "..", "web.json");
	for (const file of [indexed, unindexed]) {
		writeFileSync(file, "{}");
		utimesSync(file, (NOW - 40 * DAY) / 1000, (NOW - 40 * DAY) / 1000);
	}
	writeFileSync(index, JSON.stringify({ trains: [{ code: "1001a" }], evidence: "trainboard/acme/2026-10-03-c/step-1.json" }));
	for (const code of ["2026-10-01-a", "2026-10-02-b", "2026-10-03-c"])  writeBoard(dir, board("acme", code, ago(38 * DAY), [], ended()));
	const preview = sweepTrainboards({ stateDir: dir, now: () => NOW, alive: () => false, dryRun: true });
	assert.equal(preview.ledgerFiles, 1);
	assert.ok(existsSync(unindexed));
	assert.deepEqual(sweep(dir), { ...preview });
	assert.ok(existsSync(index));
	assert.ok(existsSync(indexed));
	assert.ok(!existsSync(unindexed));
	assert.ok(existsSync(folderOf(dir, "acme", "2026-10-03-c")), "the index explicitly references that board folder");
});

// ---- the server

/** A server whose sweep timer is a callback the test calls itself: `tick()` is the slow timer firing, `asked` the interval it was set for. */
const served = async (env: NodeJS.ProcessEnv, plant: (stateDir: string) => void) => {
	const w = new TowerWorld(), timer = { tick: async () => {}, asked: [] as number[] };
	Object.assign(w.env, env);
	plant(w.slot.stateDir);
	await w.start({ gui: false, prune: { every: (fn: () => Promise<void>, ms: number) => ((timer.tick = fn), timer.asked.push(ms), () => {}) } });
	return { w, timer };
};
const old = () => new Date(Date.now() - 38 * DAY).toISOString();

test("the server sweeps when it starts and then on a daily timer: an expired train and its car files go", async () => {
	const { w, timer } = await served({}, (dir) => {
		writeBoard(dir, board("acme", "2026-11-01-a", old(), [SHA_A], ended()));
		plantCar(dir, "acme", SHA_A);
	});
	try {
		await until(() => !existsSync(folderOf(w.slot.stateDir, "acme", "2026-11-01-a")), "initial prune deletes the ended board");
		assert.deepEqual(carFiles(w.slot.stateDir, "acme"), []);
		assert.deepEqual(timer.asked, [DAY]);
		writeBoard(w.slot.stateDir, board("acme", "2026-11-02-b", old(), [], ended()));
		await timer.tick();
		assert.ok(!existsSync(folderOf(w.slot.stateDir, "acme", "2026-11-02-b")), "the timer's sweep");
	} finally { await w.close(); }
});

test("with the merge train off the server deletes nothing, at its start or on the timer", async () => {
	const { w, timer } = await served({ STRAW_BOSS_INTEGRATION: "off" }, (dir) => { writeBoard(dir, board("acme", "2026-11-01-a", old(), [], ended())); });
	try {
		await timer.tick();
		assert.ok(existsSync(folderOf(w.slot.stateDir, "acme", "2026-11-01-a")));
	} finally { await w.close(); }
});

test("TB-F004: the car files of the cars a round removed go with the board that names them, unless another board still carries the car", () => {
	const dir = state();
	writeBoard(dir, board("acme", "2026-11-01-a", ago(38 * DAY), [SHA_A], ended(), { removed: [{ ticket: "T-B", why: "unit red", head: SHA_B }, { ticket: "T-C", why: "lint", head: SHA_C }] }));
	writeBoard(dir, board("acme", "2026-11-02-b", ago(DAY), [SHA_C], [step(1, "merge", "in_progress")]));
	for (const head of [SHA_A, SHA_B, SHA_C]) plantCar(dir, "acme", head);
	const result = sweep(dir);
	assert.deepEqual(result.removed, [{ project: "acme", code: "2026-11-01-a", cars: 2 }]);
	assert.deepEqual(carFiles(dir, "acme"), [carFileName("web", SHA_C), carFileName("web", SHA_C).replace(/\.json$/, ".notice.json")].sort(), "the removed car another board carries stays");
});
