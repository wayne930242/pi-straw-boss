import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { boardPath, boardState, type Board, capBoard, carsDir, expired, factsOf, MAX_BOARD_BYTES, MAX_TRAINS, readBoard, readTrainboards, readYard, validateBoard, validateTrainTodo, validateYard, writeBoard, writeYard, yardPath, type Yard } from "../src/train/board.ts";
import { buildBoard } from "../src/trainboard.ts";
import { CODE, SHA_A } from "./train-fixtures.ts";

// §10 and §11.1: the trainboard Straw Boss derives from a train's todos, how it is written (atomic, private) and read (bounded, strict, never guessed).

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-trainboard-"))), dirs.at(-1)!);
const MIN = 60_000, DAY = 24 * 60 * MIN, T0 = Date.parse("2026-11-07T08:00:00Z");

const board = (over: Partial<Board> = {}): Board => ({
	v: 1, project: "acme", app: "web", code: CODE, writer: { session: "sess-train-1", pane: "w1-2", pid: 4242, started: "2026-11-07T07:00:00Z" }, updated: "2026-11-07T08:00:00Z", round: 1,
	cars: [{ tickets: ["T-15"], branch: "fix/t-15", head: SHA_A, coordinator: "sess-coord-1", departs: "next", accept: "/r/accept.json", arrived: "2026-11-07T06:00:00Z", accepted: ["e2e"] }],
	steps: [
		{ id: 1, kind: "assemble", name: "assemble", status: "completed", round: 1, holds: { lane: "web" }, outcome: "passed" },
		{ id: 2, kind: "full-check", name: "unit", status: "in_progress", round: 1, load: { max: 30, weight: 4 }, lock: "heavy", waits: [{ load: { max: 30, now: 42 } }] },
		{ id: 3, kind: "land", name: "land", status: "pending", round: 1 },
	],
	...over,
});
const yard = (over: Partial<Yard> = {}): Yard => ({
	v: 1, project: "acme", writer: { session: "sess-integ-1", pid: 4300, started: "2026-11-07T06:00:00Z" }, updated: "2026-11-07T08:00:00Z",
	trains: [{ code: CODE, app: "web", status: "forming", cars: board().cars, departs: { maxCars: 4, maxWaitMin: 60, oldest: "2026-11-07T06:00:00Z" } }, { code: "2026-11-06-n", app: "web", status: "opened", session: "sess-train-2", cars: [] }],
	...over,
});

test("a car row keeps its whole ticket list up to the bound of a car (24 tickets pass, capBoard keeps them, 65 are refused)", () => {
	const row = (n: number) => ({ ...board().cars[0]!, tickets: Array.from({ length: n }, (_, i) => `MP-${3600 + i}`) });
	const b = { ...board(), cars: [row(24)] };
	assert.deepEqual(validateBoard(b), []);
	assert.deepEqual(capBoard(b).cars[0]!.tickets, row(24).tickets);
	assert.match(validateBoard({ ...board(), cars: [row(65)] }).join("\n"), /cars\[0\]\.tickets must be a list of 1 to 64 tickets/);
});

test("a board validates, and a missing or foreign field is a refusal in the board's own words", () => {
	assert.deepEqual(validateBoard(board()), []);
	const bad: [unknown, RegExp][] = [
		["x", /board must be an object/], [{ ...board(), v: 2 }, /board\.v must be 1/], [{ ...board(), project: "a/b" }, /board\.project/], [{ ...board(), code: "x" }, /board\.code/],
		[{ ...board(), writer: undefined }, /board\.writer/], [{ ...board(), writer: { session: "", pid: 1, started: "2026-11-07T07:00:00Z" } }, /writer\.session/], [{ ...board(), writer: { session: "s", pid: -1, started: "2026-11-07T07:00:00Z" } }, /writer\.pid/],
		[{ ...board(), updated: "now" }, /board\.updated must be an ISO time/], [{ ...board(), round: 0 }, /board\.round/], [{ ...board(), cars: "T-15" }, /board\.cars must be an array/],
		[{ ...board(), cars: [{ tickets: [], branch: "b", head: SHA_A, coordinator: "c", departs: "next", accept: "none" }] }, /cars\[0\]\.tickets/],
		[{ ...board(), cars: [{ tickets: ["T"], branch: "b", head: "x", coordinator: "c", departs: "next", accept: "none" }] }, /cars\[0\]\.head must be 40 hex/],
		[{ ...board(), steps: [{ id: 1, kind: "uat", name: "n", status: "pending", round: 1 }] }, /steps\[0\]\.kind/],
		[{ ...board(), steps: [{ id: 1, kind: "merge", name: "n", status: "weird", round: 1 }] }, /steps\[0\]\.status/],
		[{ ...board(), steps: [{ id: 1, kind: "merge", name: "n", status: "pending", round: 1 }, { id: 1, kind: "merge", name: "m", status: "pending", round: 1 }] }, /steps\[1\]\.id 1 twice/],
		[{ ...board(), steps: [{ id: 1, kind: "merge", name: "n", status: "pending", round: 1, waits: [{ person: "boss" }] }] }, /steps\[0\]\.waits\[0\]/],
		[{ ...board(), steps: [{ id: 1, kind: "merge", name: "n", status: "pending", round: 1, outcome: "meh" }] }, /steps\[0\]\.outcome/],
		[{ ...board(), clears: [{ lane: "web" }] }, /clears\[0\]/], [{ ...board(), extra: 1 }, /board\.extra is not a field/],
		[{ ...board(), steps: Array.from({ length: 257 }, (_, i) => ({ id: i + 1, kind: "merge", name: "n", status: "pending", round: 1 })) }, /board\.steps has more than 256/],
		[{ ...board(), cars: Array.from({ length: 33 }, () => board().cars[0]) }, /board\.cars has more than 32/],
	];
	for (const [value, pattern] of bad) {
		const refusals = validateBoard(value);
		assert.ok(refusals.some((r) => pattern.test(r)), `${pattern}: ${JSON.stringify(refusals)}`);
	}
});

test("every field of a board has its own refusal: the writer, each car field, each step field, each clear field", () => {
	const b = board(), w = b.writer, car = b.cars[0]!, st = b.steps[1]!;
	const withWriter = (over: object) => ({ ...b, writer: { ...w, ...over } });
	const withCar = (over: object) => ({ ...b, cars: [{ ...car, ...over }] });
	const withStep = (over: object) => ({ ...b, steps: [{ ...st, ...over }] });
	const clear = { lane: "web", reason: "read back", by: "boss", at: "2026-11-07T08:00:00Z" };
	const withClear = (over: object) => ({ ...b, clears: [{ ...clear, ...over }] });
	const table: [unknown, RegExp][] = [
		[withWriter({ pane: "" }), /writer\.pane/], [withWriter({ started: "x" }), /writer\.started must be an ISO time/], [withWriter({ extra: 1 }), /writer\.extra is not a field/],
		[withCar({ branch: "" }), /cars\[0\]\.branch/], [withCar({ coordinator: "" }), /cars\[0\]\.coordinator/], [withCar({ departs: "" }), /cars\[0\]\.departs/], [withCar({ accept: "" }), /cars\[0\]\.accept/],
		[withCar({ arrived: "x" }), /cars\[0\]\.arrived must be an ISO time/], [withCar({ accepted: [1] }), /cars\[0\]\.accepted must be a list of kind names/], [withCar({ extra: 1 }), /cars\[0\]\.extra is not a field/], [{ ...b, cars: ["x"] }, /cars\[0\] must be an object/],
		[withStep({ id: 0 }), /steps\[0\]\.id/], [withStep({ name: "" }), /steps\[0\]\.name/], [withStep({ round: 0 }), /steps\[0\]\.round/], [withStep({ holds: { lane: "../x" } }), /steps\[0\]\.holds/], [withStep({ holds: { other: "x" } }), /steps\[0\]\.holds/],
		[withStep({ load: { max: "30" } }), /steps\[0\]\.load/], [withStep({ load: { speed: 1 } }), /steps\[0\]\.load/], [withStep({ lock: "Heavy" }), /steps\[0\]\.lock/], [withStep({ waits: Array.from({ length: 9 }, () => ({ load: { max: 1, now: 2 } })) }), /steps\[0\]\.waits must be a list of at most 8/],
		[withStep({ waits: "x" }), /steps\[0\]\.waits must be a list/], [withStep({ why: "boredom" }), /steps\[0\]\.why/], [withStep({ extra: 1 }), /steps\[0\]\.extra is not a field/], [{ ...b, steps: [7] }, /steps\[0\] must be an object/],
		[withStep({ waits: [{ load: { max: "x", now: 1 } }] }), /waits\[0\]/], [withStep({ waits: [{ lock: { name: "" } }] }), /waits\[0\]/], [withStep({ waits: [{ lock: { name: "heavy", holder: { train: "t", step: 0 } } }] }), /waits\[0\]/],
		[withStep({ waits: [{ lane: { app: "web", holder: "x", why: "bored" } }] }), /waits\[0\]/], [withStep({ waits: [{ target: { target: "", holder: "x" } }] }), /waits\[0\]/], [withStep({ waits: [{ load: 1 }] }), /waits\[0\]/], [withStep({ waits: [{ load: { max: 1, now: 2 }, lane: {} }] }), /waits\[0\]/],
		[withClear({ lane: "web", target: "t1" }), /clears\[0\] needs lane or target, one of them/], [withClear({ lane: undefined }), /clears\[0\] needs lane or target/], [withClear({ lane: "" }), /clears\[0\]\.lane/], [withClear({ reason: "" }), /clears\[0\] needs reason/],
		[withClear({ by: "" }), /clears\[0\] needs by/], [withClear({ at: "x" }), /clears\[0\]\.at must be an ISO time/], [withClear({ extra: 1 }), /clears\[0\]\.extra is not a field/], [{ ...b, clears: "x" }, /board\.clears must be a list/], [{ ...b, clears: ["x"] }, /clears\[0\] must be an object/],
	];
	for (const [value, pattern] of table) assert.ok(validateBoard(value).some((r) => pattern.test(r)), `${pattern}: ${JSON.stringify(validateBoard(value))}`);
	assert.deepEqual(validateBoard({ ...b, clears: [clear] }), []);
	assert.deepEqual(validateBoard(withStep({ waits: [{ load: { max: 30, now: 42 } }, { lock: { name: "heavy", holder: { train: CODE, step: 3 } } }, { lane: { app: "web", holder: CODE, why: "stale" } }, { target: { target: "t1", holder: CODE, why: "unreadable" } }], holds: { lane: "web", target: "t1" }, outcome: "void", why: "skipped" })), []);
});

test("every field of a yard has its own refusal", () => {
	const y = yard(), t = y.trains[0]!;
	const withTrain = (over: object) => ({ ...y, trains: [{ ...t, ...over }] });
	const table: [unknown, RegExp][] = [
		["x", /yard must be an object/], [{ ...y, v: 2 }, /yard\.v must be 1/], [{ ...y, project: "../x" }, /yard\.project/], [{ ...y, project: ".." }, /yard\.project/], [{ ...y, writer: undefined }, /yard\.writer/], [{ ...y, updated: "x" }, /yard\.updated must be an ISO time/],
		[{ ...y, trains: "x" }, /yard\.trains must be an array/], [{ ...y, trains: ["x"] }, /trains\[0\] must be an object/], [withTrain({ app: "../x" }), /trains\[0\]\.app/], [withTrain({ app: ".." }), /trains\[0\]\.app/],
		[withTrain({ session: "" }), /trains\[0\]\.session must be a non-empty string/], [withTrain({ cars: "x" }), /trains\[0\]\.cars must be a list/], [withTrain({ cars: Array.from({ length: 33 }, () => t.cars[0]) }), /trains\[0\]\.cars must be a list of at most 32/],
		[withTrain({ departs: { maxCars: 0, maxWaitMin: 60, oldest: "2026-11-07T06:00:00Z" } }), /trains\[0\]\.departs/], [withTrain({ departs: { maxCars: 4, maxWaitMin: 60, oldest: "x" } }), /trains\[0\]\.departs/], [withTrain({ departs: { maxCars: 4, maxWaitMin: 60, oldest: "2026-11-07T06:00:00Z", more: 1 } }), /trains\[0\]\.departs/],
		[withTrain({ extra: 1 }), /trains\[0\]\.extra is not a field/], [{ ...y, trains: [{ ...t, cars: [{ ...t.cars[0], head: "x" }] }] }, /trains\[0\]\.cars\[0\]\.head must be 40 hex/],
	];
	for (const [value, pattern] of table) assert.ok(validateYard(value).some((r) => pattern.test(r)), `${pattern}: ${JSON.stringify(validateYard(value))}`);
	assert.ok(validateBoard({ ...board(), project: ".." }).some((r) => /board\.project/.test(r)), "dots are no project");
	assert.ok(validateBoard({ ...board(), app: ".." }).some((r) => /board\.app/.test(r)));
});

test("a yard validates: each forming train's cars and departure, and an opened train's session", () => {
	assert.deepEqual(validateYard(yard()), []);
	assert.ok(validateYard({ ...yard(), trains: [{ code: "x", app: "web", status: "forming", cars: [] }] }).some((r) => /trains\[0\]\.code/.test(r)));
	assert.ok(validateYard({ ...yard(), trains: [{ code: CODE, app: "web", status: "boarding", cars: [] }] }).some((r) => /trains\[0\]\.status must be forming, departing, opened or refused/.test(r)));
	assert.ok(validateYard({ ...yard(), trains: [{ code: CODE, app: "web", status: "opened", cars: [] }] }).some((r) => /trains\[0\]\.session/.test(r)), "an opened train names its session");
	assert.ok(validateYard({ ...yard(), trains: [{ code: CODE, app: "web", status: "forming", cars: [] }, { code: CODE, app: "web", status: "forming", cars: [] }] }).some((r) => /code .* twice/.test(r)));
	assert.ok(validateYard({ ...yard(), trains: Array.from({ length: 65 }, (_, i) => ({ code: `2026-11-06-${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`, app: "web", status: "forming", cars: [] })) }).some((r) => /yard\.trains has more than 64/.test(r)));
	assert.ok(validateYard({ ...yard(), extra: 1 }).some((r) => /yard\.extra is not a field/.test(r)));
});

test("writing is atomic and private: the folder 700, the file 600, no temp file left, the content what was written", () => {
	const root = state(), file = writeBoard(root, board());
	assert.equal(file, boardPath(root, "acme", CODE));
	assert.equal(file, join(root, "trainboard", "acme", CODE, "board.json"));
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), board());
	if (process.platform !== "win32") {
		assert.equal(lstatSync(file).mode & 0o777, 0o600);
		for (const dir of [join(root, "trainboard", "acme", CODE), join(root, "trainboard", "acme"), join(root, "trainboard")]) assert.equal(lstatSync(dir).mode & 0o777, 0o700, dir);
	}
	assert.deepEqual(readdirSync(join(root, "trainboard", "acme", CODE)), ["board.json"]);
	writeBoard(root, board({ round: 2 }));
	assert.equal(JSON.parse(readFileSync(file, "utf8")).round, 2, "a second write replaces the first");
	assert.deepEqual(readdirSync(join(root, "trainboard", "acme", CODE)), ["board.json"]);
	const ywhere = writeYard(root, yard());
	assert.equal(ywhere, yardPath(root, "acme"));
	assert.equal(ywhere, join(root, "trainboard", "acme", "yard.json"));
	if (process.platform !== "win32") assert.equal(lstatSync(ywhere).mode & 0o777, 0o600);
	assert.equal(carsDir(root, "acme"), join(root, "trainboard", "acme", "cars"));
});

test("a folder that already exists is made private too, and a train's temp file never outlives the write", () => {
	if (process.platform === "win32") return;
	const root = state();
	mkdirSync(join(root, "trainboard", "acme", CODE), { recursive: true, mode: 0o755 });
	chmodSync(join(root, "trainboard"), 0o755), chmodSync(join(root, "trainboard", "acme"), 0o755), chmodSync(join(root, "trainboard", "acme", CODE), 0o755);
	writeBoard(root, board());
	for (const dir of [join(root, "trainboard"), join(root, "trainboard", "acme"), join(root, "trainboard", "acme", CODE)]) assert.equal(lstatSync(dir).mode & 0o777, 0o700, dir);
});

test("a write that would not read back is refused and leaves the old file: an invalid board, one over 64 KB, a path-unsafe name", () => {
	const root = state();
	writeBoard(root, board());
	const before = readFileSync(boardPath(root, "acme", CODE), "utf8");
	assert.throws(() => writeBoard(root, { ...board(), round: 0 }), /board\.round/);
	assert.throws(() => writeBoard(root, board({ cars: Array.from({ length: 32 }, () => ({ ...board().cars[0]!, branch: "b".repeat(4000) })) })), new RegExp(`board is .* KB, more than ${MAX_BOARD_BYTES / 1024}`));
	assert.throws(() => writeBoard(root, { ...board(), project: "../x" }), /board\.project/);
	assert.equal(readFileSync(boardPath(root, "acme", CODE), "utf8"), before);
	assert.throws(() => boardPath(root, "..", CODE), /project/);
	assert.throws(() => boardPath(root, "acme", "../x"), /code/);
	assert.deepEqual(readdirSync(join(root, "trainboard", "acme", CODE)), ["board.json"]);
});

test("capBoard cuts long strings and long lists to their caps so a writer never fails on size, and keeps a valid board whole", () => {
	assert.deepEqual(capBoard(board()), board());
	const big = capBoard({ ...board(), steps: Array.from({ length: 300 }, (_, i) => ({ id: i + 1, kind: "merge" as const, name: "n".repeat(500), status: "pending" as const, round: 1 })), cars: [{ ...board().cars[0]!, branch: "b".repeat(5000), departs: "d".repeat(5000) }] });
	assert.deepEqual(validateBoard(big), []);
	assert.equal(big.steps.length, 256);
	assert.ok(big.steps[0]!.name.length <= 64);
	assert.ok(JSON.stringify(big).length <= MAX_BOARD_BYTES);
	const waits = Array.from({ length: 8 }, (_, i) => ({ lane: { app: `application-number-${i}`, holder: "2026-11-06-zz", why: "unreadable" as const } }));
	const heavy = capBoard({ ...board(), steps: Array.from({ length: 256 }, (_, i) => ({ id: i + 1, kind: "merge" as const, name: "n", status: "pending" as const, round: 1, waits })) });
	assert.deepEqual(validateBoard(heavy), [], "a board whose derived waits are too much loses them, not the write");
	assert.equal(heavy.steps.length, 256);
	assert.equal(heavy.steps[0]!.waits, undefined);
	assert.equal(capBoard({ ...board(), cars: Array.from({ length: 40 }, () => board().cars[0]!) }).cars.length, 32);
	assert.equal(capBoard({ ...board(), clears: Array.from({ length: 70 }, () => ({ lane: "web", reason: "r".repeat(900), by: "b", at: "2026-11-07T08:00:00Z" })) }).clears!.length, 64);
	assert.deepEqual(validateBoard(capBoard({ ...board(), clears: [{ lane: "web", reason: "r".repeat(900), by: "b", at: "2026-11-07T08:00:00Z" }] })), []);
});

test("reading is strict: a regular file within 64 KB, JSON, the writer's validator, and the folder it sits in names its project and code", () => {
	const root = state(), file = writeBoard(root, board());
	const ok = readBoard(file);
	assert.deepEqual(ok, { ok: true, board: board() });
	const missing = readBoard(join(root, "nope.json"));
	assert.equal(missing.ok, false);
	const dir = join(root, "trainboard", "acme", "2026-11-06-q");
	mkdirSync(dir, { recursive: true });
	const refused = (name: string, content: string | (() => string), pattern: RegExp) => {
		const path = join(dir, name);
		const text = typeof content === "function" ? content() : content;
		writeFileSync(path, text);
		const out = readBoard(path);
		assert.equal(out.ok, false, name);
		assert.match(out.ok ? "" : out.reason, pattern, name);
	};
	refused("a.json", "{nope", /not JSON/);
	refused("b.json", "[]", /board must be an object/);
	refused("c.json", JSON.stringify({ ...board(), steps: "x" }), /board\.steps must be an array/);
	refused("d.json", JSON.stringify({ ...board(), extra: 1 }), /board\.extra is not a field/);
	refused("e.json", "x".repeat(MAX_BOARD_BYTES + 1), /more than 64 KB/);
	refused("f.json", JSON.stringify(board()), /code 2026-11-06-m is not the folder's 2026-11-06-q/);
	refused("h.json", JSON.stringify(board({ code: "2026-11-06-q", project: "other" })), /project other is not the folder's acme/);
	refused("g.json", '{"__proto__":{"polluted":true},"v":1}', /board\./);
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
	if (process.platform !== "win32") {
		symlinkSync(file, join(dir, "link.json"));
		const out = readBoard(join(dir, "link.json"));
		assert.equal(out.ok, false);
		assert.match(out.ok ? "" : out.reason, /not a regular file/);
	}
	mkdirSync(join(dir, "folder.json"));
	assert.match((readBoard(join(dir, "folder.json")) as { reason: string }).reason, /not a regular file/);
});

test("a yard is read the same way", () => {
	const root = state(), file = writeYard(root, yard());
	assert.deepEqual(readYard(file), { ok: true, yard: yard() });
	writeFileSync(file, JSON.stringify({ ...yard(), project: "other" }));
	assert.match((readYard(file) as { reason: string }).reason, /project other is not the folder's acme/);
	writeFileSync(file, "x".repeat(MAX_BOARD_BYTES + 1));
	assert.match((readYard(file) as { reason: string }).reason, /more than 64 KB/);
});

test("readTrainboards lists every train of every project in project and code order, shows an unreadable one as such, and skips the yard and the car files", () => {
	const root = state();
	writeBoard(root, board({ project: "zeta", code: "2026-11-06-a" } as Partial<Board>));
	writeBoard(root, board({ code: "2026-11-06-b" }));
	writeBoard(root, board());
	writeYard(root, yard());
	mkdirSync(carsDir(root, "acme"), { recursive: true });
	writeFileSync(join(carsDir(root, "acme"), "web-aaaaaaaaaaaa.json"), "{}");
	mkdirSync(join(root, "trainboard", "acme", "2026-11-06-bad"), { recursive: true });
	writeFileSync(join(root, "trainboard", "acme", "2026-11-06-bad", "board.json"), "{nope");
	mkdirSync(join(root, "trainboard", "acme", "not-a-code"), { recursive: true });
	writeFileSync(join(root, "trainboard", "acme", "2026-11-06-file"), "a file named like a train");
	writeFileSync(join(root, "trainboard", "stray-file"), "not a project");
	if (process.platform !== "win32") {
		mkdirSync(join(root, "elsewhere", "2026-11-06-x"), { recursive: true });
		symlinkSync(join(root, "elsewhere", "2026-11-06-x"), join(root, "trainboard", "acme", "2026-11-06-linked"));
		symlinkSync(join(root, "elsewhere"), join(root, "trainboard", "linked-project"));
	}
	mkdirSync(join(root, "trainboard", "acme", "2026-11-06-empty"), { recursive: true });
	const all = readTrainboards(root);
	assert.deepEqual(all.trains.map((t) => `${t.project}/${t.code}/${t.ok}`), ["acme/2026-11-06-b/true", "acme/2026-11-06-m/true", "acme/2026-11-06-bad/false", "acme/2026-11-06-empty/false", "zeta/2026-11-06-a/true"]);
	assert.equal(all.truncated, false);
	const bad = all.trains.find((t) => t.code === "2026-11-06-bad")!;
	assert.equal(bad.ok, false);
	assert.match(bad.ok ? "" : bad.reason, /not JSON/);
	assert.match((all.trains.find((t) => t.code === "2026-11-06-empty") as { reason: string }).reason, /no board\.json|cannot read/);
	assert.deepEqual(readTrainboards(root, { project: "zeta" }).trains.map((t) => t.code), ["2026-11-06-a"]);
	assert.deepEqual(readTrainboards(root, { project: "..%2f" }).trains, []);
	assert.deepEqual(readTrainboards(join(root, "nothing")), { trains: [], truncated: false, unlisted: [] });
});

test("at most 64 trains are read, the rest said to be left out", () => {
	const root = state();
	for (let i = 0; i < MAX_TRAINS + 3; i++) {
		const code = `2026-11-06-${String.fromCharCode(97 + (i % 26))}${i >= 26 ? String.fromCharCode(97 + Math.floor(i / 26) - 1) : ""}`;
		mkdirSync(join(root, "trainboard", "acme", code), { recursive: true });
	}
	const out = readTrainboards(root);
	assert.equal(out.trains.length, MAX_TRAINS);
	assert.equal(out.truncated, true);
});

test("a train is ended when its land step completed, stale when its writer is gone and 10 minutes have passed, live otherwise", () => {
	const b = (over: Partial<Board> = {}) => board({ updated: new Date(T0).toISOString(), ...over });
	const landed = b({ steps: [...board().steps.slice(0, 2), { id: 3, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] });
	assert.equal(boardState(landed, { now: T0 + 30 * DAY, alive: false }), "ended", "ended wherever the writer is");
	assert.equal(boardState(b(), { now: T0 + 5 * MIN, alive: false }), "live", "gone for under 10 minutes");
	assert.equal(boardState(b(), { now: T0 + 10 * MIN, alive: false }), "stale");
	assert.equal(boardState(b(), { now: T0 + 3 * DAY, alive: true }), "live", "a live writer is never stale");
	assert.equal(boardState(b({ steps: [{ id: 1, kind: "land", name: "land", status: "completed", round: 1, outcome: "void", why: "superseded" }] }), { now: T0, alive: true }), "live", "a voided land is not an end");
});

test("an ended train is deleted 7 days after its last update; a stale one only after a clear and the same 7 days; a live one never", () => {
	const upd = new Date(T0).toISOString();
	const landed = board({ updated: upd, steps: [{ id: 1, kind: "land", name: "land", status: "completed", round: 1, outcome: "passed" }] });
	assert.equal(expired(landed, { now: T0 + 7 * DAY - 1, alive: false }), false);
	assert.equal(expired(landed, { now: T0 + 7 * DAY, alive: false }), true);
	const stale = board({ updated: upd });
	assert.equal(expired(stale, { now: T0 + 30 * DAY, alive: false }), false, "a stale board holds until cleared");
	const clear = { lane: "web", reason: "read back", by: "boss", at: new Date(T0 + 1 * DAY).toISOString() };
	assert.equal(expired({ ...stale, clears: [clear] }, { now: T0 + 7 * DAY, alive: false }), false, "7 days after the last update, but the clear is newer");
	assert.equal(expired({ ...stale, clears: [clear], updated: new Date(T0 + 1 * DAY).toISOString() }, { now: T0 + 8 * DAY, alive: false }), true);
	assert.equal(expired(stale, { now: T0 + 30 * DAY, alive: true }), false);
	assert.equal(expired({ ...stale, clears: [clear] }, { now: T0 + 30 * DAY, alive: true }), false, "a live writer's board is never deleted, cleared or not");
	assert.equal(expired({ ...stale, clears: [clear] }, { now: T0 + 30 * DAY, alive: false }), true);
});

test("facts: a read board becomes the facts waits reads, and an unreadable one holds everything", () => {
	const root = state();
	writeBoard(root, board({ steps: [{ id: 1, kind: "merge", name: "merge", status: "in_progress", round: 1, holds: { lane: "web" } }], updated: new Date(T0).toISOString() }));
	mkdirSync(join(root, "trainboard", "acme", "2026-11-06-bad"), { recursive: true });
	writeFileSync(join(root, "trainboard", "acme", "2026-11-06-bad", "board.json"), "{nope");
	const [good, bad] = readTrainboards(root).trains.map((t) => factsOf(t, { now: T0 + 20 * MIN, alive: () => false }));
	assert.deepEqual(bad, { project: "acme", code: "2026-11-06-bad", state: "unreadable", steps: [] });
	assert.equal(good!.state, "stale");
	assert.deepEqual(good!.steps, [{ id: 1, kind: "merge", status: "in_progress", round: 1, holds: { lane: "web" } }]);
	assert.ok(existsSync(root));
});

const deep = (levels: number) => `${"[".repeat(levels)}${"]".repeat(levels)}`;

test("F003: a nested board or yard is an unreadable one, never a throw, and the other boards still read", () => {
	const root = state();
	writeBoard(root, board({ code: "2026-11-06-b" }));
	const folder = join(root, "trainboard", "acme", "2026-11-06-a");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "board.json"), `{"v":1,"x":${deep(30_000)}}`);
	const read = readBoard(join(folder, "board.json"));
	assert.equal(read.ok, false);
	assert.match(read.ok ? "" : read.reason, /nested more than 32 levels/);
	const all = readTrainboards(root);
	assert.deepEqual(all.trains.map((t) => `${t.code}/${t.ok}`), ["2026-11-06-a/false", "2026-11-06-b/true"]);
	assert.doesNotThrow(() => factsOf(all.trains[0]!, { now: T0, alive: () => false }));
	writeFileSync(yardPath(root, "acme"), `{"v":1,"x":${deep(30_000)}}`);
	assert.match((readYard(yardPath(root, "acme")) as { reason: string }).reason, /nested more than 32 levels/);
	for (const check of [() => validateBoard({ ...board(), extra: JSON.parse(deep(20_000)) }), () => validateYard({ ...yard(), extra: JSON.parse(deep(20_000)) })]) {
		const out = check();
		assert.equal(out.length, 1);
		assert.match(out[0]!, /nested more than 32 levels/);
	}
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	assert.match(validateBoard({ ...board(), extra: cyclic })[0]!, /nested more than 32 levels/);
});

test("F004: capBoard of a board at every cap still writes; clears' lane and target and a step's waits are cut too", () => {
	const cars = Array.from({ length: 40 }, (_, i) => ({ tickets: Array.from({ length: 20 }, (_, j) => `T-${i}-${j}-${"t".repeat(80)}`), branch: "b".repeat(300), head: SHA_A, coordinator: "c".repeat(200), departs: "d".repeat(400), accept: "a".repeat(1100), arrived: "2026-11-07T06:00:00Z", accepted: Array.from({ length: 8 }, () => "k".repeat(32)) }));
	const clears = Array.from({ length: 70 }, () => ({ lane: "l".repeat(500), reason: "r".repeat(900), by: "b".repeat(200), at: "2026-11-07T08:00:00Z" }));
	const waits = Array.from({ length: 12 }, () => ({ lane: { app: "a".repeat(64), holder: "2026-11-06-zz", why: "unreadable" as const } }));
	const steps = Array.from({ length: 256 }, (_, i) => ({ id: i + 1, kind: "full-check" as const, name: "n".repeat(64), status: "pending" as const, round: 1, holds: { lane: "l".repeat(20) }, lock: "k".repeat(32), load: { max: 30, weight: 4 }, waits }));
	const capped = capBoard({ ...board(), cars, clears, steps });
	assert.deepEqual(validateBoard(capped), []);
	assert.ok(capped.cars.length >= 1, "some car stays");
	assert.equal(capped.steps.length, 256);
	assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= MAX_BOARD_BYTES);
	const root = state();
	assert.doesNotThrow(() => writeBoard(root, capped));
	const small = capBoard({ ...board(), clears: [{ lane: "l".repeat(500), reason: "r", by: "b", at: "2026-11-07T08:00:00Z" }], steps: [{ id: 1, kind: "merge", name: "n", status: "pending", round: 1, waits }] });
	assert.deepEqual(validateBoard(small), []);
	assert.equal(small.clears![0]!.lane!.length, 128);
	assert.equal(small.steps[0]!.waits!.length, 8);
	const onlyWaits = capBoard({ ...board(), cars: [{ ...board().cars[0]!, branch: "b".repeat(255) }], steps: Array.from({ length: 256 }, (_, i) => ({ id: i + 1, kind: "merge" as const, name: "n", status: "pending" as const, round: 1, waits })) });
	assert.equal(onlyWaits.steps[0]!.waits, undefined, "the waits go first");
	assert.equal(onlyWaits.cars[0]!.branch.length, 255, "and a board that fits without them keeps its car text");
});

test("F007: the integrator's train todo (§7.4) has its own validator", () => {
	const train = (over: Record<string, unknown> = {}, spec: Record<string, unknown> = {}) => ({
		v: 1, project: "acme", app: "web", train: CODE, kind: "train",
		spec: { cars: board().cars, departs: { maxCars: 4, maxWaitMin: 60, oldest: "2026-11-07T06:00:00Z" }, ...spec }, ...over,
	});
	assert.deepEqual(validateTrainTodo(train()), []);
	assert.deepEqual(validateTrainTodo(train({}, { departs: undefined })), []);
	const bad: [unknown, RegExp][] = [
		["x", /metadata\.sb must be an object/], [train({ v: 2 }), /metadata\.sb\.v must be 1/], [train({ kind: "merge" }), /kind must be train/], [train({ project: "a/b" }), /metadata\.sb\.project/],
		[train({ app: "" }), /metadata\.sb\.app/], [train({ train: "x" }), /metadata\.sb\.train must be YYYY-MM-DD/], [train({ round: 1 }), /round is not a field/],
		[train({ spec: undefined }), /metadata\.sb\.spec must be an object/], [train({}, { cars: [] }), /spec\.cars must be a list of 1 to 32 cars/], [train({}, { cars: [{ ...board().cars[0], head: "x" }] }), /spec\.cars\[0\]\.head must be 40 hex/],
		[train({}, { cars: Array.from({ length: 33 }, () => board().cars[0]) }), /spec\.cars must be a list of 1 to 32 cars/], [train({}, { departs: { maxCars: 0, maxWaitMin: 1, oldest: "2026-11-07T06:00:00Z" } }), /spec\.departs must be maxCars, maxWaitMin and oldest/],
		[train({}, { extra: 1 }), /spec\.extra is not a field/], [train({ extra: JSON.parse(deep(5000)) }), /nested more than 32 levels/],
	];
	for (const [value, pattern] of bad) {
		const out = validateTrainTodo(value);
		assert.ok(out.some((r) => pattern.test(r)), `${pattern} not in ${JSON.stringify(out)}`);
		for (const r of out) assert.match(r, /^sb: /);
	}
	const done = { outcome: "passed", session: "sess-train-1", at: "2026-11-07T08:00:00Z" };
	assert.deepEqual(validateTrainTodo(train({ result: done }), { status: "completed", id: 7 }), []);
	assert.deepEqual(validateTrainTodo(train({ result: { outcome: "failed", refusal: "sb: no", at: done.at } }), { status: "completed" }), []);
	const need: [Record<string, unknown>, string, RegExp][] = [
		[{}, "completed", /completed needs a result/], [{ result: done }, "pending", /result is set only on completed/], [{ result: { ...done, session: undefined } }, "completed", /passed needs result\.session/],
		[{ result: { outcome: "failed", at: done.at } }, "completed", /failed needs result\.refusal/], [{ result: { ...done, outcome: "void" } }, "completed", /outcome must be passed or failed/], [{ result: { ...done, at: "now" } }, "completed", /result\.at must be an ISO time/],
		[{ result: { ...done, extra: 1 } }, "completed", /result\.extra is not a field/],
	];
	for (const [over, status, pattern] of need) assert.ok(validateTrainTodo(train(over), { status }).some((r) => pattern.test(r)), `${status} ${pattern}`);
	assert.ok(validateTrainTodo(train(), { project: "other" }).some((r) => /names project acme; this integrator's is other/.test(r)));
});

// ---- task 7: the cars a round left out (§3.5, §11.2)

const REMOVED = [{ ticket: "T-12", why: "unit red: 3 tests failed" }];

test("T7: a board may name the cars its round left out; a board without them stays valid; each field has its own refusal", () => {
	assert.deepEqual(validateBoard(board({ round: 2, removed: REMOVED })), []);
	assert.deepEqual(validateBoard(board()), [], "a board without removed is as valid as before");
	assert.deepEqual(validateBoard(board({ round: 2, removed: [] })), []);
	const bad: [unknown, RegExp][] = [
		["T-12", /board\.removed must be a list of at most 32/], [Array.from({ length: 33 }, () => REMOVED[0]), /board\.removed must be a list of at most 32/],
		[[1], /removed\[0\] must be an object/], [[{ ticket: "T 12", why: "x" }], /removed\[0\]\.ticket/], [[{ ticket: "", why: "x" }], /removed\[0\]\.ticket/], [[{ ticket: "T".repeat(65), why: "x" }], /removed\[0\]\.ticket/],
		[[{ ticket: "T-12", why: "" }], /removed\[0\]\.why/], [[{ ticket: "T-12", why: "w".repeat(601) }], /removed\[0\]\.why/], [[{ ticket: "T-12", why: "x", evidence: "/p" }], /removed\[0\]\.evidence is not a field/],
	];
	for (const [removed, pattern] of bad) {
		const refusals = validateBoard({ ...board({ round: 2 }), removed });
		assert.ok(refusals.some((r) => pattern.test(r)), `${pattern}: ${JSON.stringify(refusals)}`);
	}
});

/** A row of a train's todo list the way the guard keeps it. */
const row = (id: number, status: string, sb: object) => ({ id, status, metadata: { sb: { v: 1, project: "acme", app: "web", train: CODE, name: "step", ...sb } } });
const built = (rows: ReturnType<typeof row>[]) => buildBoard({ project: "acme", code: CODE, app: "web", rows, cars: board().cars, writer: board().writer, now: T0 });

test("T7: buildBoard carries the current round's assemble removed cars as ticket and why, and nothing from an older round or another kind", () => {
	const round1 = row(1, "completed", { kind: "assemble", round: 1, spec: { cars: ["T-12", "T-15"], removed: [{ ticket: "T-OLD", why: "an older round's" }] } });
	const void1 = row(2, "completed", { kind: "full-check", round: 1, result: { outcome: "void", why: "superseded" } });
	const round2 = row(3, "in_progress", { kind: "assemble", round: 2, spec: { cars: ["T-15"], removed: [{ ticket: "T-12", why: "unit red", evidence: "/logs/unit.log" }] } });
	const merge2 = row(4, "pending", { kind: "merge", round: 2, spec: {} });
	assert.deepEqual(built([round1, void1, round2, merge2]).removed, [{ ticket: "T-12", why: "unit red" }], "the evidence path stays with the train, the page gets the ticket and the reason");
	assert.deepEqual(validateBoard(built([round1, void1, round2, merge2])), []);
	assert.deepEqual(built([round1]).removed, [{ ticket: "T-OLD", why: "an older round's" }], "round 1 may leave a car out too: a manifest car that asked for acceptance (§5.4)");
	assert.equal("removed" in built([row(1, "completed", { kind: "assemble", round: 1, spec: { cars: ["T-12", "T-15"] } })]), false, "a round 1 that left nothing out has none");
	assert.equal("removed" in built([row(1, "pending", { kind: "assemble", round: 1, spec: { cars: ["T-15"] } })]), false);
	assert.equal("removed" in built([round1, row(3, "in_progress", { kind: "assemble", round: 2, spec: { cars: ["T-15"] } })]), false, "a round 2 assemble that removes nothing has none");
	assert.equal("removed" in built([row(1, "pending", { kind: "merge", round: 1, spec: { removed: [{ ticket: "T-1", why: "x" }] } })]), false, "only an assemble step carries it");
});

test("T7: buildBoard keeps well-formed removed cars only, at most 32, each reason cut to 600; a train todo that lies cannot spoil the board", () => {
	const mk = (removed: unknown) => built([row(1, "in_progress", { kind: "assemble", round: 2, spec: { removed } })]);
	const odd = [{ ticket: "T-1", why: "ok" }, { ticket: "has space", why: "x" }, { ticket: "T-2", why: "" }, { ticket: "T-3" }, "T-4", null, { ticket: "T-5", why: "w".repeat(900) }];
	const out = mk(odd).removed!;
	assert.deepEqual(out.map((r) => r.ticket), ["T-1", "T-5"]);
	assert.equal(out[1]!.why.length, 600);
	assert.equal(mk(Array.from({ length: 40 }, (_, i) => ({ ticket: `T-${i}`, why: "x" }))).removed!.length, 32);
	for (const lie of ["T-1", 7, { ticket: "T-1", why: "x" }, []]) assert.equal("removed" in mk(lie), false, JSON.stringify(lie));
	assert.deepEqual(validateBoard(mk(odd)), []);
});

test("T7: capBoard keeps removed within the board's size: the reasons shrink with the tiers, a board with 32 long reasons and full cars still writes", () => {
	const removed = Array.from({ length: 32 }, (_, i) => ({ ticket: `T-${i}-${"t".repeat(50)}`, why: "w".repeat(600) }));
	assert.deepEqual(capBoard({ ...board({ round: 2 }), removed }).removed, removed, "a board that fits is kept whole");
	const cars = Array.from({ length: 32 }, (_, i) => ({ tickets: Array.from({ length: 16 }, (_, j) => `T-${i}-${j}-${"t".repeat(40)}`), branch: "b".repeat(255), head: SHA_A, coordinator: "c".repeat(128), departs: "d".repeat(300), accept: "a".repeat(1000), arrived: "2026-11-07T06:00:00Z", accepted: ["e2e"] }));
	const capped = capBoard({ ...board({ round: 2 }), cars, removed });
	assert.deepEqual(validateBoard(capped), []);
	assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= MAX_BOARD_BYTES);
	assert.doesNotThrow(() => writeBoard(state(), capped));
	assert.ok(capped.removed!.length >= 1 && capped.removed!.every((r) => r.why.length <= 600 && r.ticket.length <= 64));
});
