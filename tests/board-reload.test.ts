import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ENDED_MS, purge, readEntries, writeEntry } from "../src/board.ts";
import type { Todo } from "../src/items.ts";
import { buildAllyBrief, buildBrief } from "../src/server/towerbrief.ts";
import { World } from "./fakes.ts";

// A /reload keeps what the work board decided before it (RV-F001, RV-F003), the purge does not delete a line its owner just wrote (RV-F006), and a stale marker survives the brief's row cap (RV-F004).

const todo = (id: number, subject: string, status: Todo["status"]): Todo => ({ id, subject, status });
let world = new World();
afterEach(async () => { await world.stopAll(); world = new World(); });
const boardDir = () => join(world.stateDir, "board");
let clock = 1_800_000_000_000;
const now = () => (clock += 1000);
const setTodos = (a: { entries: unknown[] }, list: Todo[]) => a.entries.push({ customType: "rpiv-todo-state", data: { tasks: list, nextId: list.length + 1 } });
const entryOf = (id: string) => readEntries(boardDir()).find((e) => e.session === id);
async function main(carry?: unknown[]) {
	const a = world.agent({ id: "a1", name: "api-main", pane: "wA:p1", tab: "wA:t1", deps: { now } });
	if (carry) a.entries.push(...(carry as never[]));
	await a.start();
	await a.promote();
	return a;
}
const SHELVED = [todo(1, "Done part", "completed"), todo(2, "Shelved part", "pending")];
const DONE = [todo(1, "x", "completed"), todo(2, "y", "completed")];
const kept = (a: { entries: { customType: string }[] }) => a.entries.filter((e) => e.customType === "straw-boss-board");

test("RV-F001 R1: a cleared line stays cleared across /reload", async () => {
	const a = await main();
	setTodos(a, SHELVED);
	await a.fire("turn_end");
	assert.ok(entryOf("a1"));
	await a.tool("board_set", { clear: true });
	assert.equal(entryOf("a1"), undefined);
	const carry = [...a.entries];
	await a.stop("reload");
	const b = await main(carry);
	await b.fire("turn_end");
	assert.equal(entryOf("a1"), undefined, "same todos after the reload: nothing is written again");
	setTodos(b, [...SHELVED, todo(3, "New", "pending")]);
	await b.fire("turn_end");
	assert.ok(entryOf("a1"), "a moved todo list writes it again");
});

test("RV-F001 R2: a finished line removed after 30 minutes does not come back on /reload", async () => {
	const a = await main();
	setTodos(a, DONE);
	await a.fire("turn_end");
	assert.ok(entryOf("a1"));
	clock += ENDED_MS + 10_000;
	await a.fire("turn_end");
	assert.equal(entryOf("a1"), undefined);
	assert.equal(kept(a).length, 1);
	const carry = [...a.entries];
	await a.stop("reload");
	const b = await main(carry);
	await b.fire("turn_end");
	assert.equal(entryOf("a1"), undefined);
});

test("RV-F001: a finished line still on file at /reload keeps its own age", async () => {
	const a = await main();
	setTodos(a, DONE);
	await a.fire("turn_end");
	const written = entryOf("a1")!.updated;
	const carry = [...a.entries];
	await a.stop("reload");
	const b = await main(carry);
	await b.fire("turn_end");
	assert.equal(entryOf("a1")!.updated, written, "not rewritten with a fresh time");
	clock += ENDED_MS + 10_000;
	await b.fire("turn_end");
	assert.equal(entryOf("a1"), undefined, "its 30 minutes run from the first write");
});

test("RV-F003: reload then quit with no turn removes the file the old instance left", async () => {
	mkdirSync(boardDir(), { recursive: true });
	writeEntry(boardDir(), "a1", { now: "left by the old instance", items: [] }, 5);
	const a = await main();
	await a.stop("quit");
	assert.equal(entryOf("a1"), undefined);
});

test("RV-F006: purge leaves a finished line its owner rewrote after the listing", () => {
	const dir = join(world.stateDir, "board-purge"), T = 1_800_000_000_000;
	writeEntry(dir, "m", { now: "m: done (2/2)", items: [] }, T - ENDED_MS - 1, { src: "todo", count: { done: 2, total: 2 } });
	writeEntry(dir, "m", { now: "m: Ship", items: [] }, T, { src: "todo", count: { done: 1, total: 2 } });
	purge(dir, new Set(["m"]), T);
	assert.equal(readEntries(dir).length, 1);
});

test("RV-F004: the stale marker comes before the long now text, so a row cap keeps it", () => {
	const now = "宇鈞 PM-1074 v3 batch: final gate on WebAPITests + three builds, then push develop and watch ws01 swap".padEnd(110, ".");
	const row = { tab: "PM-1074 v3 batch", main: { name: "PM-1074 v3 batch", id: "01a185f1abcdef", state: "idle", openedBy: "tower-wA", now, open: 4, stale: true as const }, members: 1 };
	const b = buildBrief({ label: "Alpha", workspace: "wA", head: "Alpha", woken: "10:00", counts: { intercom: 1 }, identity: "tower", mains: [row], obligations: [], digest: [], flags: [], tools: ["- x"] });
	assert.match(b.split("\n").find((l) => l.startsWith("- PM-1074"))!, /\[stale: idle/);
	const a = buildAllyBrief({ device: { label: "d", short: "s", team: "t", level: "status" }, workspace: "wA", label: "Alpha", woken: "10:00", seen: [{ ...row, main: { ...row.main, now: "x".repeat(300) } }], asks: [], thread: [], tools: ["- x"] } as never);
	assert.match(a.split("\n").find((l) => l.startsWith("- PM-1074"))!, /\[stale: idle/);
});

test("RV2-F001: a finished line purged by a tower's read while the main idles is not rewritten after /reload", async () => {
	const a = await main();
	setTodos(a, [todo(1, "x", "completed"), todo(2, "y", "completed")]);
	await a.fire("turn_end");
	assert.ok(entryOf("a1"));
	clock += ENDED_MS + 10_000;
	purge(boardDir(), new Set(["a1"]), clock);
	assert.equal(entryOf("a1"), undefined);
	const carry = [...a.entries];
	await a.stop("reload");
	const b = await main(carry);
	await b.fire("turn_end");
	assert.equal(entryOf("a1"), undefined);
	setTodos(b, [todo(1, "x", "completed"), todo(2, "y", "pending")]); // the list moves: the line is back
	await b.fire("turn_end");
	assert.ok(entryOf("a1"));
});
