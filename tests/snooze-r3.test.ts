import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { deriveBoard, moreOf } from "../src/boardauto.ts";
import { finished } from "../src/board.ts";
import { capDir, capTasksOf, openTodos, readCaps, staleFacts, writeCap } from "../src/capacity.ts";
import { todosOf } from "../src/items.ts";
import { knownMoves } from "../src/server/capwatch.ts";
import { createWorked, workedOf } from "../src/server/worked.ts";

// The third review of the stale snooze (docs/specs/2026-11-28-stale-snooze.md, r3-F001 to r3-F004).

const SERVER = "sb-server-1", T = Date.parse("2026-11-28T10:00:00Z"), MIN = 60_000;
const at = (s: number) => new Date(T + s * 1000).toISOString();
const notice = (s: number) => ({ type: "custom_message", customType: "intercom_message", timestamp: at(s), content: "x", details: { from: { id: SERVER }, bodyText: `[straw net from="straw boss" id=${SERVER} role=session kind=capacity_notice scope=session to=api reply=none] capacity stale · main "api" · 1 open todo unanswered` } });
const said = (s: number) => ({ type: "message", timestamp: at(s), message: { role: "assistant", content: [{ type: "text", text: "Still waiting." }] } });
const hook = (s: number) => ({ type: "custom_message", customType: "claude-hook-context", timestamp: at(s), content: "ctx" });
const peer = (s: number) => ({ type: "custom_message", customType: "intercom_message", timestamp: at(s), content: "x", details: { from: { id: "peer-1" }, bodyText: "please deploy" } });
const lines = (...e: unknown[]) => e.map((x) => JSON.stringify(x));
const big = (n: number) => ({ tasks: [...Array.from({ length: n }, (_, i) => ({ id: i + 1, subject: `t${i + 1}`, status: "completed" })), { id: n + 1, subject: "the last one", status: "pending" }], nextId: n + 2 });

test("r3-F001: 200 completed todos and one pending past the display are not done", () => {
	const snap = big(200), d = deriveBoard({ name: "api", todos: todosOf(snap), more: moreOf(snap) })!;
	assert.equal(d.text.now, "api: next the last one");
	assert.equal(finished({ src: "todo", ...(d.count ? { count: d.count } : {}) }), false, "no done count the board would purge");
	assert.equal(d.text.items.length <= 8, true, "the display is not expanded");
	assert.equal(deriveBoard({ name: "api", todos: todosOf(big(3)), more: moreOf(big(3)) })!.text.now, "api: next the last one", "a short list as before");
});

test("r3-F001: an attended main with open work and no board entry is reminded by its last move", () => {
	const c = { open: 1, todos: [{ id: 201, subject: "x" }] };
	const f = staleFacts({ session: "a", state: "idle", fileMtime: T - 3 * 3600_000 }, c, false, T);
	assert.equal(f.stale, true);
	assert.equal(staleFacts({ session: "a", state: "idle", fileMtime: T - 60 * MIN }, c, false, T).stale, false, "an hour is not two");
	assert.equal(staleFacts({ session: "a", state: "idle", fileMtime: T - 3 * 3600_000 }, { open: 0, todos: [] }, false, T).stale, false, "no open work, no entry: nothing");
});

test("r3-F003: automatic turn context is no move; an intercom message of another sender is", () => {
	assert.equal(workedOf(lines(said(0), notice(60), hook(61), said(70)), SERVER), T);
	assert.equal(workedOf(lines(said(0), notice(60), peer(61), said(70)), SERVER), T + 70_000);
});

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("r3-F002: a tail that holds only the notice and its answer is no move; the last known one stands", () => {
	assert.equal(workedOf(lines(notice(60), said(70)), SERVER, true), null, "unknown, never the notice's time");
	const dir = mkdtempSync(join(tmpdir(), "psb-r3-")), file = join(dir, "s.jsonl");
	dirs.push(dir);
	writeFileSync(file, `${lines(said(0)).join("\n")}\n`);
	const worked = createWorked(SERVER);
	assert.equal(worked(file, 1), T);
	writeFileSync(file, `${JSON.stringify({ type: "message", timestamp: at(1), message: { role: "toolResult", content: "x".repeat(300 * 1024) } })}\n${lines(notice(60), said(70)).join("\n")}\n`);
	assert.equal(worked(file, 2), T, "the move known before the append");
	assert.equal(createWorked(SERVER)(file, 2), null, "a new reader does not know it");
	const facts = knownMoves<{ session: string; worked?: number; movedUnknown?: true }>([{ session: "a", movedUnknown: true }, { session: "b", movedUnknown: true }], { "notice-moved:a": T });
	assert.equal(facts[0]!.worked, T, "the episode's move, kept across a restart");
	assert.equal(facts[1]!.worked, undefined);
});

test("r3-F004: a snoozed todo past the projection's bound stays in it", () => {
	const list = capTasksOf({ tasks: Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, subject: `t${i + 1}`, status: "pending" })), nextId: 5002 });
	assert.equal(openTodos(list).some((t) => t.id === 5001), false);
	const kept = openTodos(list, undefined, new Set([5001]));
	assert.equal(kept.length, 5000);
	assert.equal(kept.some((t) => t.id === 5001), true);
});

test("performance: an unchanged capacity file is not parsed again, a rewritten one is", () => {
	const root = mkdtempSync(join(tmpdir(), "psb-r3-")), dir = capDir(join(root, "board")), session = "01900000-0000-7000-8000-000000000001";
	dirs.push(root);
	writeCap(dir, { v: 1, session, updated: T, doing: [], ready: [], open: 1, todos: [{ id: 1, subject: "a" }] });
	const a = readCaps(dir)[0];
	assert.equal(readCaps(dir)[0], a, "the same reading");
	writeCap(dir, { v: 1, session, updated: T, doing: [], ready: [], open: 1, todos: [{ id: 2, subject: "a" }] });
	assert.deepEqual(readCaps(dir)[0]!.todos, [{ id: 2, subject: "a" }], "a write of the same size is read again");
});

test("performance: a session file is read again only when its time or size moved", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-r3-")), file = join(dir, "s.jsonl"), stamp = new Date(T);
	dirs.push(dir);
	writeFileSync(file, `${lines(said(0)).join("\n")}\n`);
	utimesSync(file, stamp, stamp);
	const worked = createWorked(SERVER);
	assert.equal(worked(file, T), T);
	writeFileSync(file, `${lines(said(1)).join("\n")}\n`);
	utimesSync(file, stamp, stamp);
	assert.equal(worked(file, T), T, "same time, same size: not read");
	writeFileSync(file, `${lines(said(0), said(9)).join("\n")}\n`);
	utimesSync(file, stamp, stamp);
	assert.equal(worked(file, T), T + 9000, "same time, new size: read");
});
