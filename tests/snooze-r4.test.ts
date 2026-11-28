import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { deriveBoard, moreOf } from "../src/boardauto.ts";
import { capDir, capTasksOf, type MainCap, openOf, readCaps, staleFacts, writeCap } from "../src/capacity.ts";
import { todosOf } from "../src/items.ts";
import { createWorked, REVALIDATE_MS } from "../src/server/worked.ts";

// The fourth review of the stale snooze (docs/specs/2026-11-28-stale-snooze.md, r3-F004's rest and r4-F001 to r4-F004).

const SERVER = "sb-server-1", T = Date.parse("2026-11-28T10:00:00Z"), MIN = 60_000, SESSION = "01900000-0000-7000-8000-000000000001";
const at = (s: number) => new Date(T + s * 1000).toISOString();
const notice = (s: number) => ({ type: "custom_message", customType: "intercom_message", timestamp: at(s), content: "x", details: { from: { id: SERVER }, bodyText: `[straw net from="straw boss" id=${SERVER} role=session kind=capacity_notice scope=session to=api reply=none] capacity stale · main "api" · 1 open todo unanswered` } });
const said = (s: number, text = "Still waiting.") => ({ type: "message", timestamp: at(s), message: { role: "assistant", content: [{ type: "text", text }] } });
const input = (s: number, text: string) => ({ type: "message", timestamp: at(s), message: { role: "user", content: text } });
const body = (...e: unknown[]) => `${e.map((x) => JSON.stringify(x)).join("\n")}\n`;
const dirs: string[] = [];
const scratch = () => ((d) => (dirs.push(d), d))(mkdtempSync(join(tmpdir(), "psb-r4-")));
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("r3-F004: a deferred todo the bound leaves out is not unanswered; a snooze on the only actionable one holds", () => {
	const later = new Date(T + 24 * 3600_000).toISOString();
	const snapshot = { tasks: [...Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, subject: `t${i + 1}`, status: "pending", metadata: { until: later } })), { id: 5001, subject: "the one", status: "pending" }], nextId: 5002 };
	const list = capTasksOf(snapshot), open = openOf(list, snapshot, new Set([5001]));
	assert.equal(open.todos.length, 5000);
	assert.equal(open.rest, Date.parse(later), "what was left out is deferred until then");
	const snooze = { at: T - 60 * MIN, why: "waits on CI", until: T + 60 * MIN, todo: 5001 };
	const c: Pick<MainCap, "open" | "todos" | "rest" | "snoozes"> = { open: 5001, ...open, snoozes: [snooze] };
	const m = { session: "a", state: "idle", fileMtime: T - 3 * 3600_000 };
	assert.equal(staleFacts(m, c, true, T).stale, false, "no reminder while the snooze lasts");
	assert.equal(staleFacts(m, { ...c, snoozes: [] }, true, T).stale, true, "without the snooze the one is unanswered");
	const due = staleFacts(m, { ...c, snoozes: [] }, true, Date.parse(later) + 1);
	assert.equal(due.unanswered, 5001, "once their deferral passes, the unlisted count again");
	assert.equal(openOf(capTasksOf({ tasks: Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, subject: "x", status: "pending" })), nextId: 1 })).rest, 0, "an unlisted todo not deferred: due now");
	// Written and read back through the file.
	const dir = capDir(join(scratch(), "board"));
	writeCap(dir, { v: 1, session: SESSION, updated: T, doing: [], ready: [], ...c });
	assert.equal(readCaps(dir)[0]!.rest, Date.parse(later));
});

test("r4-F001: a rewrite at the same size and mtime, or a new file at the same path, is read again", () => {
	const root = scratch(), file = join(root, "s.jsonl"), stamp = new Date(T);
	writeFileSync(file, body(said(1)));
	utimesSync(file, stamp, stamp);
	const worked = createWorked(SERVER);
	assert.equal(worked(file, T), T + 1000);
	writeFileSync(file, body(said(2)));
	utimesSync(file, stamp, stamp);
	assert.equal(worked(file, T), T + 2000, "same size, same mtime: its ctime moved");
	writeFileSync(join(root, "n.jsonl"), body(said(3)));
	utimesSync(join(root, "n.jsonl"), stamp, stamp);
	renameSync(join(root, "n.jsonl"), file);
	assert.equal(worked(file, T), T + 3000, "another file");

	const dir = capDir(join(root, "board")), cap = (id: number): MainCap => ({ v: 1, session: SESSION, updated: T, doing: [], ready: [], open: 1, todos: [{ id, subject: "a" }] });
	writeCap(dir, cap(1));
	const capFile = join(dir, `${SESSION}.json`);
	utimesSync(capFile, stamp, stamp);
	assert.deepEqual(readCaps(dir, T)[0]!.todos, [{ id: 1, subject: "a" }]);
	writeFileSync(capFile, `${JSON.stringify(cap(2))}\n`);
	utimesSync(capFile, stamp, stamp);
	assert.deepEqual(readCaps(dir, T)[0]!.todos, [{ id: 2, subject: "a" }], "same size, same mtime, same inode: its ctime moved");
});

test("r4-F001: an unchanged file is read again after ten minutes, not before", () => {
	const file = join(scratch(), "s.jsonl");
	writeFileSync(file, body(said(1)));
	let now = T, reads = 0;
	const worked = createWorked(SERVER, () => now, () => (reads++, { lines: [JSON.stringify(said(1))], cut: false, end: 1 }));
	worked(file, T);
	now += 5 * MIN;
	worked(file, T);
	assert.equal(reads, 1, "an unchanged stat within ten minutes: no read");
	now += REVALIDATE_MS;
	worked(file, T);
	assert.equal(reads, 2, "past ten minutes: read again");

	const dir = capDir(join(scratch(), "board"));
	writeCap(dir, { v: 1, session: SESSION, updated: T, doing: [], ready: [], open: 0 });
	const a = readCaps(dir, T)[0];
	assert.equal(readCaps(dir, T + 5 * MIN)[0], a, "the same reading");
	assert.notEqual(readCaps(dir, T + 5 * MIN + REVALIDATE_MS)[0], a, "parsed again");
});

test("r4-F002: real input too large for the tail is a move; the episode's old move is not taken", () => {
	const file = join(scratch(), "s.jsonl");
	writeFileSync(file, body(said(0), notice(60), said(70)));
	const worked = createWorked(SERVER);
	assert.equal(worked(file, 1), T);
	writeFileSync(file, body(said(0), notice(60), said(70), input(3600, "x".repeat(300 * 1024))));
	assert.equal(worked(file, 2), undefined, "unknown in memory too: the file's time counts");
	assert.equal(createWorked(SERVER)(file, 2), undefined, "a new reader: the file's time counts, never `notice-moved`");
	// A notice and its answer appended since: proven, the known move stands; a fresh reader whose tail shows the notice answers unknown (the episode's move).
	const two = join(scratch(), "t.jsonl");
	writeFileSync(two, body(said(0)));
	const w2 = createWorked(SERVER);
	assert.equal(w2(two, 1), T);
	writeFileSync(two, body(said(0), notice(60), said(70)));
	assert.equal(w2(two, 2), T, "the append holds no move");
	writeFileSync(two, body(said(0), notice(60), said(70), said(80, "Later.")));
	assert.equal(w2(two, 3), T, "the answer's turn carries over reads");
	writeFileSync(two, body(input(0, "y".repeat(300 * 1024)), notice(60), said(70)));
	assert.equal(createWorked(SERVER)(two, 4), null, "the tail proves only the notice and its answer follow");
});

test("r4-F003: when every shown row is deleted, open work past them still makes a line", () => {
	const snap = { tasks: [...Array.from({ length: 200 }, (_, i) => ({ id: i + 1, subject: `t${i + 1}`, status: "deleted" })), { id: 201, subject: "the last one", status: "pending" }], nextId: 202 };
	const d = deriveBoard({ name: "api", todos: todosOf(snap), more: moreOf(snap) });
	assert.equal(d?.text.now, "api: next the last one");
	assert.equal(d?.count, undefined, "no done count");
	assert.equal(deriveBoard({ name: "api", todos: [], more: undefined }), undefined, "no work: nothing");
});

test("r4-F004: moreOf answers a snapshot once", () => {
	const snap = { tasks: [...Array.from({ length: 200 }, (_, i) => ({ id: i + 1, subject: "x", status: "completed" })), { id: 201, subject: "first", status: "pending" }], nextId: 202 };
	assert.equal(moreOf(snap)?.subject, "first");
	snap.tasks[200]!.subject = "changed in place";
	assert.equal(moreOf(snap)?.subject, "first", "kept by the snapshot's identity");
	assert.equal(moreOf({ ...snap, tasks: [...snap.tasks] })?.subject, "changed in place", "a new snapshot is scanned");
});
