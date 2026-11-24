import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { capLine, capOfTodos, type DeviceCap, joinCaps, type MainCap, type MainFacts, pauseOf, pauseText, readCaps, readDevice, roomFor, staleOf, underFor, writeCap, writeDevice } from "../src/capacity.ts";
import { todosOf } from "../src/items.ts";

// Device capacity (docs/specs/2026-11-24-capacity.md): the todo list's facts, the join with the workers that run, the device row's flags, and the files.

const MIN = 60_000, NOW = Date.parse("2026-11-24T10:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "psb-cap-")); dirs.push(d); return d; };

test("rpiv-todo's owner, blockedBy and metadata.points come through todosOf; points outside 0 to 10 are none", () => {
	const list = todosOf({ nextId: 5, tasks: [
		{ id: 1, subject: "api", status: "in_progress", owner: " cap-api ", metadata: { points: 2 } },
		{ id: 2, subject: "page", status: "pending", blockedBy: [1], metadata: { points: 0.5 } },
		{ id: 3, subject: "big", status: "pending", metadata: { points: 11 } },
		{ id: 4, subject: "gone", status: "deleted" },
	] })!;
	assert.deepEqual(list.map((t) => [t.id, t.owner, t.blockedBy, t.points]), [[1, "cap-api", undefined, 2], [2, undefined, [1], 0.5], [3, undefined, undefined, undefined]]);
});

test("capOfTodos: in-progress todos with an owner are doing, pending todos whose blockers are done (or deleted) are ready, missing points are 1", () => {
	const t = (id: number, status: "pending" | "in_progress" | "completed", more: object = {}) => ({ id, subject: `t${id}`, status, ...more });
	const cases: [string, Parameters<typeof capOfTodos>[0], ReturnType<typeof capOfTodos>][] = [
		["empty", [], { doing: [], ready: [], open: 0 }],
		["owned and unowned work", [t(1, "in_progress", { owner: "w1", points: 2 }), t(2, "in_progress")], { doing: [{ owner: "w1", points: 2 }], ready: [], open: 2 }],
		["blocked by an open todo", [t(1, "in_progress"), t(2, "pending", { blockedBy: [1] })], { doing: [], ready: [], open: 2 }],
		["blocker done", [t(1, "completed"), t(2, "pending", { blockedBy: [1], points: 0.5 })], { doing: [], ready: [{ points: 0.5 }], open: 1 }],
		["blocker deleted", [t(2, "pending", { blockedBy: [9], owner: "w2" })], { doing: [], ready: [{ owner: "w2", points: 1 }], open: 1 }],
	];
	for (const [name, list, want] of cases) assert.deepEqual(capOfTodos(list), want, name);
});

test("the pause seam takes v1 quota payloads only", () => {
	assert.deepEqual(pauseOf({ v: 1, state: "paused", reason: "quota", until: NOW + 3600_000, detail: "weekly limit\n· resets 4pm" }, NOW), { state: "paused", pause: { reason: "quota", at: NOW, until: NOW + 3600_000, detail: "weekly limit · resets 4pm" } });
	assert.deepEqual(pauseOf({ v: 1, state: "resumed", reason: "quota" }, NOW), { state: "resumed" });
	assert.deepEqual(pauseOf({ v: 1, state: "paused", reason: "quota", until: "soon", detail: "x".repeat(300) }, NOW)?.state, "paused");
	assert.equal((pauseOf({ v: 1, state: "paused", reason: "quota", detail: "x".repeat(300) }, NOW) as { pause: { detail: string } }).pause.detail.length, 120);
	for (const bad of [undefined, null, {}, { v: 2, state: "paused", reason: "quota" }, { v: 1, state: "paused", reason: "crash" }, { v: 1, state: "maybe", reason: "quota" }]) assert.equal(pauseOf(bad, NOW), undefined);
});

const main = (session: string, over: Partial<MainFacts> = {}): MainFacts => ({ session, name: session, workspace: "w1", role: "main", state: "working", workers: [], fileMtime: NOW, entryUpdated: NOW, ...over });
const cap = (session: string, over: Partial<MainCap> = {}): MainCap => ({ v: 1, session, updated: NOW, doing: [], ready: [], open: 0, ...over });
const join_ = (mains: MainFacts[], caps: MainCap[], o: Partial<{ budget: number; load1: number; cores: number; unattended: boolean }> = {}) => joinCaps({ mains, caps, budget: o.budget, load1: o.load1 ?? 0.2, cores: o.cores ?? 32, unattended: o.unattended ?? false, now: NOW });

test("joinCaps: points are the running owners' todos, each running worker no todo names counts 1, the main itself and a finished owner nothing", () => {
	const cases: [string, MainFacts[], MainCap[], { points: number; ready: number; minReady?: number }][] = [
		["no worker runs: an owned todo counts nothing", [main("a")], [cap("a", { doing: [{ owner: "w1", points: 2 }] })], { points: 0, ready: 0 }],
		["owner runs (case and space folded)", [main("a", { workers: ["W1 "] })], [cap("a", { doing: [{ owner: "w1", points: 2 }] })], { points: 2, ready: 0 }],
		["a worker no todo names counts 1", [main("a", { workers: ["w1", "rev"] })], [cap("a", { doing: [{ owner: "w1", points: 0.5 }] })], { points: 1.5, ready: 0 }],
		["no capacity file: each worker 1", [main("a", { workers: ["x", "y"] })], [], { points: 2, ready: 0 }],
		["ready skips a todo whose owner runs", [main("a", { workers: ["w1"] })], [cap("a", { ready: [{ owner: "w1", points: 2 }, { points: 0.5 }, { points: 2 }] })], { points: 1, ready: 2, minReady: 0.5 }],
		["a live train no todo names counts 1", [main("a"), main("t", { role: "train" })], [], { points: 1, ready: 0 }],
		["a train an owned todo names counts its points", [main("a"), main("t", { role: "train", name: "Train T" })], [cap("a", { doing: [{ owner: "train t", points: 2 }] })], { points: 2, ready: 0 }],
	];
	for (const [name, mains, caps, want] of cases) {
		const d = join_(mains, caps, { budget: 10 });
		assert.deepEqual({ points: d.points, ready: d.ready, ...(d.minReady !== undefined ? { minReady: d.minReady } : {}) }, want, name);
		assert.equal(d.mains.every((r) => r.session !== "t"), true, `${name}: a train is no main row`);
	}
});

test("joinCaps: each main row lists its deployed units by name with their points (the supply tray, docs/specs/2026-11-24-capacity-supply/spec.md), summing to the main's points", () => {
	const d = join_([main("a", { workers: ["API-build ", "rev"] }), main("t", { role: "train", name: "Train T" })], [cap("a", { doing: [{ owner: "api-build", points: 1.5 }, { owner: "api-build", points: 0.5 }, { owner: "train t", points: 2 }, { owner: "gone", points: 3 }] })], { budget: 10 });
	assert.deepEqual(d.mains[0]!.units, [{ name: "api-build", points: 2 }, { name: "train t", points: 2 }, { name: "rev", points: 1 }]);
	assert.equal(d.mains[0]!.units!.reduce((n, u) => n + u.points, 0), d.mains[0]!.points);
	assert.deepEqual(join_([main("b")], []).mains[0]!.units, [], "nothing deployed");
});

test("roomFor and underFor: a budget, the smallest ready todo fitting, the load under 0.7 per core, held 10 minutes", () => {
	const base = { budget: 10, points: 8, minReady: 2, load1: 1, cores: 4 };
	const cases: [string, Partial<typeof base> & { budget?: number | undefined }, boolean][] = [
		["fits exactly", {}, true],
		["no budget: never", { budget: undefined }, false],
		["no ready work: never", { minReady: undefined }, false],
		["does not fit", { points: 8.5 }, false],
		["load at 0.7 per core", { load1: 2.8 }, false],
		["load just under", { load1: 2.79 }, true],
	];
	for (const [name, over, want] of cases) assert.equal(roomFor({ ...base, ...over }), want, name);
	assert.equal(underFor({ under: NOW - 9 * MIN }, NOW), undefined);
	assert.equal(underFor({ under: NOW - 10 * MIN }, NOW), 10 * MIN);
	assert.equal(underFor({}, NOW), undefined);
});

test("staleOf: 30 minutes of no move with open todos and nothing running on an unattended device (any state), else the 2-hour idle rule; a paused main is never stale", () => {
	const old = (ms: number) => ({ fileMtime: NOW - ms, entryUpdated: NOW - ms });
	const cases: [string, Parameters<typeof staleOf>[0], Parameters<typeof staleOf>[1], boolean, boolean][] = [
		["unattended, 31 min, open", { state: "working", workers: [], ...old(31 * MIN) }, { open: 2 }, true, true],
		["unattended, commanding a worker", { state: "commanding", commanding: true, workers: ["w1"], ...old(31 * MIN) }, { open: 2 }, true, false],
		["unattended, a worker runs", { state: "idle", workers: ["w1"], ...old(31 * MIN) }, { open: 2 }, true, false],
		["unattended, points in use (a train)", { state: "idle", workers: [], points: 1, ...old(31 * MIN) }, { open: 2 }, true, false],
		["unattended, 29 min", { state: "idle", ...old(29 * MIN) }, { open: 2 }, true, false],
		["unattended, file moved", { state: "idle", fileMtime: NOW - MIN, entryUpdated: NOW - 3 * 3600_000 }, { open: 2 }, true, false],
		["unattended, nothing open", { state: "idle", ...old(3 * 3600_000) }, { open: 0 }, true, false],
		["unattended, standing too", { state: "idle", duty: "standing", ...old(31 * MIN) }, { open: 1 }, true, true],
		["unattended, paused", { state: "idle", ...old(5 * 3600_000) }, { open: 2, pause: { reason: "quota", at: NOW } }, true, false],
		["attended, idle 2 h+", { state: "idle", ...old(121 * MIN) }, { open: 0 }, false, true],
		["attended, idle 1 h", { state: "idle", ...old(60 * MIN) }, { open: 3 }, false, false],
		["attended, commanding", { state: "idle", commanding: true, ...old(5 * 3600_000) }, { open: 3 }, false, false],
		["attended, paused", { state: "idle", ...old(5 * 3600_000) }, { open: 3, pause: { reason: "quota", at: NOW } }, false, false],
	];
	for (const [name, m, c, unattended, want] of cases) assert.equal(staleOf(m, c, unattended, NOW), want, name);
});

test("the device row: rows carry pause and stale; the line and the files", () => {
	const d = join_([main("a", { workers: ["w1"], name: "api" }), main("b", { state: "idle", ...{ fileMtime: NOW - 40 * MIN, entryUpdated: NOW - 40 * MIN } })], [cap("a", { doing: [{ owner: "w1", points: 2 }], ready: [{ points: 1 }], open: 3 }), cap("b", { open: 1, pause: { reason: "quota", at: NOW, until: NOW + 90 * MIN, detail: "weekly" } })], { budget: 20, unattended: true });
	assert.deepEqual(d.mains.map((r) => [r.session, r.points, r.ready, r.open, r.paused, r.stale]), [["a", 2, 1, 3, undefined, undefined], ["b", 0, 0, 1, { until: NOW + 90 * MIN, detail: "weekly" }, undefined]]);
	assert.match(capLine({ ...d, under: NOW - 12 * MIN }, NOW), /^capacity 2 \/ 20 pts · load 0\.2 \/ 32 cores · ready 1 · under 12 min · 1 paused$/);
	assert.match(pauseText({ until: NOW + 90 * MIN }, NOW), /^quota · resumes (\d{1,2}\/\d{1,2} )?\d\d:\d\d$/);
	assert.equal(pauseText({}, NOW), "quota");
	const dir = tmp();
	writeDevice(dir, d);
	assert.deepEqual(readDevice(dir, NOW + 4 * MIN), d);
	assert.equal(readDevice(dir, NOW + 6 * MIN), undefined, "a row over 5 minutes old is no reading");
	writeCap(dir, cap("s-1", { open: 2, ready: [{ points: 2 }] }));
	mkdirSync(join(dir, "x"), { recursive: true });
	writeFileSync(join(dir, "other.json"), JSON.stringify({ v: 1, session: "s-2", updated: NOW, doing: [], ready: [], open: 0 }));
	assert.deepEqual(readCaps(dir).map((c) => c.session), ["s-1"], "the device row, a folder and a file that names another session are no main's");
	assert.equal(capLine({ ...(d as DeviceCap), budget: undefined }, NOW).includes(" / 20"), false);
});
