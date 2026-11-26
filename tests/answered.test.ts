import assert from "node:assert/strict";
import { test } from "node:test";
import { chatKey, createAnswered, docKey } from "../src/answered.ts";

// The sb server's record of which blocks were answered (docs/specs/2026-11-07-better-show-host.md, "Answered"): one owned file, bounded and pruned, read by every device and base; an answer is `pending` while it is on its way and
// `done` with the fields that went; a block that is pending or done is never answered again; a storage error never reopens a block silently.

const disk = (initial?: string) => {
	const box = { text: initial, saves: 0, fail: false, failLoad: false };
	return {
		box,
		load: () => { if (box.failLoad) throw new Error("EIO"); return box.text; },
		save: (text: string) => { if (box.fail) throw new Error("ENOSPC"); box.text = text; box.saves++; },
	};
};
const F: [string, string][] = [["store", "SQLite"], ["why", "simple"]];

test("an answer is begun once, pending until it is done, and then answered for good: nobody begins it again", () => {
	const d = disk(), a = createAnswered({ ...d });
	const key = chatKey("S1", "e7", 2);
	assert.equal(a.get(key), undefined);
	assert.equal(a.begin(key), "ok");
	assert.equal(a.get(key)?.state, "pending");
	assert.equal(a.begin(key), "pending", "a second device while the first answer is on its way");
	assert.equal(a.done(key, F), true);
	assert.deepEqual(a.get(key), { state: "done", fields: F, at: a.get(key)!.at });
	assert.equal(a.begin(key), "answered");
	a.cancel(key);
	assert.equal(a.get(key)?.state, "done", "a finished answer is not cancelled");
});

test("two grouped picks whose names share the first 256 characters remain distinct after a restart", () => {
	const d = disk(), store = createAnswered(d), key = docKey("S", "review.md", "0123456789abcdef", 0);
	const prefix = "picked:" + "a".repeat(250), fields: [string, string][] = [[`${prefix}1`, "A"], [`${prefix}2`, "B"]];
	store.begin(key);
	store.done(key, fields);
	const saved = createAnswered(d).get(key);
	assert.deepEqual(saved?.state === "done" && saved.fields, fields);
});

test("a refused or failed delivery is cancelled: the block is open again, on this server and after a restart", () => {
	const d = disk(), a = createAnswered({ ...d });
	const key = chatKey("S1", "e7", 0);
	a.begin(key);
	a.cancel(key);
	assert.equal(a.get(key), undefined);
	assert.equal(createAnswered({ ...d }).get(key), undefined);
	assert.equal(a.begin(key), "ok");
});

test("the record survives a restart of the server: answered and pending both, and a pending one expires", () => {
	const d = disk();
	let now = 1_000_000;
	const a = createAnswered({ ...d, now: () => now, pendingMs: 120_000 });
	const k1 = chatKey("S1", "e1", 0), k2 = docKey("S1", "docs/plan.md", "0123456789abcdef", 3);
	a.begin(k1);
	a.done(k1, F);
	a.begin(k2);
	const again = createAnswered({ ...d, now: () => now, pendingMs: 120_000 });
	assert.deepEqual(again.get(k1), { state: "done", fields: F, at: 1_000_000 });
	assert.equal(again.get(k2)?.state, "pending");
	assert.equal(again.begin(k2), "pending");
	now += 120_001;
	assert.equal(again.get(k2), undefined, "an answer never confirmed within two minutes was not delivered, or was and told the page so");
	assert.equal(again.begin(k2), "ok");
});

test("a document's key is its owner, its name, the text's hash, and the block: it holds no capability, so it outlives a restart and a new capability", () => {
	const k = docKey("S1", "docs/plan.md", "0123456789abcdef", 3);
	assert.equal(k, docKey("S1", "docs/plan.md", "0123456789abcdef", 3));
	for (const other of [docKey("S2", "docs/plan.md", "0123456789abcdef", 3), docKey("S1", "docs/other.md", "0123456789abcdef", 3), docKey("S1", "docs/plan.md", "fedcba9876543210", 3), docKey("S1", "docs/plan.md", "0123456789abcdef", 4), chatKey("S1", "docs/plan.md", 3)]) assert.notEqual(k, other);
	assert.notEqual(chatKey("S1", "a\u001fb", 0), chatKey("S1\u001fa", "b", 0), "a separator inside a part cannot move a boundary");
	assert.notEqual(chatKey("S1", "a", 0), chatKey("S1", "a\u0000", 0));
});

test("the record is bounded and pruned: the oldest go past the limit, old ones go at load, a long answer is cut", () => {
	const d = disk();
	let now = 1_000_000;
	const a = createAnswered({ ...d, now: () => now, max: 3, keepMs: 10_000 });
	for (let i = 0; i < 5; i++) {
		now += 100;
		a.begin(chatKey("S", `e${i}`, 0));
		a.done(chatKey("S", `e${i}`, 0), [["q", String(i)]]);
	}
	assert.deepEqual(a.list("chat", "S").map(([k]) => JSON.parse(k)[2]), ["e2", "e3", "e4"], "three newest");
	const saved = createAnswered({ ...d, now: () => now + 9_950, max: 3, keepMs: 10_000 });
	assert.deepEqual(saved.list("chat", "S").map(([k]) => JSON.parse(k)[2]), ["e4"], "e2 and e3 are older than keepMs at load");
	const long = chatKey("S", "long", 0);
	saved.begin(long);
	saved.done(long, Array.from({ length: 80 }, (_, i) => [`f${i}`, "x".repeat(5000)] as [string, string]));
	const kept = saved.get(long);
	assert.ok(kept?.state === "done" && kept.fields.length <= 65 && kept.fields.every(([n, v]) => n.length <= 256 && v.length <= 1024), "at most 65 fields, values of at most 1024 characters");
	assert.ok((d.box.text ?? "").length < 400_000);
});

test("a file that cannot be written refuses to begin: nothing is sent, and the block stays as the source shows it", () => {
	const d = disk(), a = createAnswered({ ...d });
	d.box.fail = true;
	const key = chatKey("S1", "e1", 0);
	assert.equal(a.begin(key), "unsaved");
	assert.equal(a.get(key), undefined, "not even in memory: the page is told, and the block is as it was");
	d.box.fail = false;
	assert.equal(a.begin(key), "ok");
	d.box.fail = true;
	assert.equal(a.done(key, F), false, "delivered, but the record could not be written");
	assert.equal(a.get(key)?.state, "done", "this server still holds it, so no device reopens it before a restart");
	assert.equal(a.begin(key), "answered");
});

test("BSR-F002: a file that cannot be read starts empty and says so for the life of the process; the first write sets it aside and never replaces it, and the note does not go", () => {
	const bad = disk("{not json"), order: string[] = [];
	const a = createAnswered({ ...bad, aside: () => void order.push("aside"), save: (text) => (order.push("save"), bad.save(text)) });
	assert.equal(a.unreadable, true);
	assert.deepEqual(a.list("chat", "S1"), []);
	const key = chatKey("S1", "e1", 0);
	assert.equal(a.begin(key), "ok");
	assert.equal(a.unreadable, true, "still unreadable after a write: the blocks answered before show a note, not silently open");
	a.done(key, F);
	a.begin(chatKey("S1", "e2", 0));
	assert.deepEqual(order, ["aside", "save", "save", "save"], "the old file is moved aside once, before the first write");
	const gone = disk();
	gone.box.failLoad = true;
	assert.equal(createAnswered({ ...gone }).unreadable, true, "an unreadable file (not a missing one)");
	assert.equal(createAnswered({ ...disk() }).unreadable, false, "a missing file is a new record");
});

test("BSR-F002: when the unreadable file cannot be set aside nothing is written and nothing is sent", () => {
	const bad = disk("{not json"), a = createAnswered({ ...bad, aside: () => { throw new Error("EACCES"); } });
	const key = chatKey("S1", "e1", 0);
	assert.equal(a.begin(key), "unsaved");
	assert.equal(bad.box.saves, 0, "the unreadable file was not replaced");
	assert.equal(bad.box.text, "{not json");
	assert.equal(a.get(key), undefined);
});

test("BSR-F002: the record is held to a strict schema at load: a key, a state, a field, or a time out of shape makes the whole record unreadable, never a partly trusted one", () => {
	const good = chatKey("S", "e", 0), doc = docKey("S", "docs/a.md", "0123456789abcdef", 1);
	const rec = (...entries: unknown[]) => JSON.stringify({ v: 1, entries });
	const done = { state: "done", fields: [["q", "a"]], at: 1_000 };
	assert.equal(createAnswered({ ...disk(rec([good, done], [doc, { state: "pending", at: 1_000 }])), now: () => 2_000 }).unreadable, false, "the control: both key shapes");
	for (const [name, text] of Object.entries({
		"no version": JSON.stringify({ entries: [] }),
		"another version": JSON.stringify({ v: 2, entries: [] }),
		"a key that is not JSON": rec(["nope", done]),
		"a key that is not an array": rec([JSON.stringify({ a: 1 }), done]),
		"a key of another kind": rec([JSON.stringify(["wat", "S", "e", 0]), done]),
		"a chat key with an object for its index": rec([JSON.stringify(["chat", "S", "e", { x: 1 }]), done]),
		"a chat key with a negative index": rec([JSON.stringify(["chat", "S", "e", -1]), done]),
		"a chat key with a fractional index": rec([JSON.stringify(["chat", "S", "e", 1.5]), done]),
		"a chat key with an index past the limit": rec([JSON.stringify(["chat", "S", "e", 4096]), done]),
		"a chat key of five parts": rec([JSON.stringify(["chat", "S", "e", 0, 1]), done]),
		"a doc key with a rev that is not a hash": rec([JSON.stringify(["doc", "S", "n", "XYZ", 0]), done]),
		"a doc key of four parts": rec([JSON.stringify(["doc", "S", "n", 0]), done]),
		"a state of another name": rec([good, { state: "weird", at: 1_000 }]),
		"a done state with no fields": rec([good, { state: "done", at: 1_000 }]),
		"a field that is a triple": rec([good, { state: "done", fields: [["a", "b", "c"]], at: 1_000 }]),
		"a field value that is a number": rec([good, { state: "done", fields: [["a", 1]], at: 1_000 }]),
		"a time that is a string": rec([good, { state: "pending", at: "1000" }]),
		"a negative time": rec([good, { state: "pending", at: -5 }]),
		"an entry that is not a pair": rec([good]),
	})) {
		const a = createAnswered({ ...disk(text), now: () => 2_000 });
		assert.equal(a.unreadable, true, name);
		assert.deepEqual(a.list("chat", "S"), [], name);
	}
});

test("BSR-F002: a time in the future is clamped to now, so a planted entry cannot outlive the keep window", () => {
	const key = chatKey("S", "e", 0);
	let now = 5_000;
	const text = JSON.stringify({ v: 1, entries: [[key, { state: "done", fields: [["q", "a"]], at: 9e15 }]] });
	const a = createAnswered({ ...disk(text), now: () => now, keepMs: 10_000 });
	assert.equal(a.unreadable, false);
	assert.equal(a.get(key)?.at, 5_000, "clamped to the time of the load");
	now += 10_001;
	const later = createAnswered({ ...disk(JSON.stringify({ v: 1, entries: [[key, a.get(key)]] })), now: () => now, keepMs: 10_000 });
	assert.equal(later.get(key), undefined, "and it expires with the rest");
});

test("BSR-F007 A03: a pending entry that was never confirmed within the window is not listed, so a page is not told 'Sending…' for a block the server would take again", () => {
	let now = 1_000;
	const a = createAnswered({ ...disk(), now: () => now, pendingMs: 100 });
	const k = chatKey("S", "e", 0), d = chatKey("S", "e", 1);
	a.begin(k);
	a.begin(d);
	a.done(d, F);
	assert.deepEqual(a.list("chat", "S").map(([key]) => key), [k, d]);
	now += 101;
	assert.deepEqual(a.list("chat", "S").map(([key]) => key), [d], "the expired pending is gone, the done stays");
	assert.equal(a.begin(k), "ok");
});

test("BSR-F007 A08: an entry the loader accepts keeps only what the schema names: fields cut to the limits", () => {
	const key = chatKey("S", "e", 0);
	const long = JSON.stringify({ v: 1, entries: [[key, { state: "done", fields: Array.from({ length: 70 }, (_, i) => [`f${i}`.padEnd(400, "n"), "v".repeat(2000)]), at: 1_000, extra: "x" }]] });
	const state = createAnswered({ ...disk(long), now: () => 2_000 }).get(key);
	assert.ok(state?.state === "done" && state.fields.length === 65 && state.fields.every(([n, v]) => n.length === 256 && v.length === 1024));
	assert.deepEqual(Object.keys(state!).sort(), ["at", "fields", "state"]);
});

test("the file holds only the record: a version, and the entries", () => {
	const d = disk(), a = createAnswered({ ...d });
	const key = chatKey("S1", "e1", 0);
	a.begin(key);
	a.done(key, F);
	const parsed = JSON.parse(d.box.text!) as { v: number; entries: [string, { state: string; fields?: unknown }][] };
	assert.equal(parsed.v, 1);
	assert.deepEqual(parsed.entries.map(([k, s]) => [k, s.state, s.fields]), [[key, "done", F]]);
});

test("pi-better-show 0.5.0: a 64-field form with the reserved `pi-note` is kept whole: the note is the 65th field", () => {
	const a = createAnswered({ load: () => undefined, save: () => {} });
	const fields: [string, string][] = [...Array.from({ length: 64 }, (_, i): [string, string] => [`q${i}`, "x"]), ["pi-note", "late thought"]];
	a.begin(chatKey("S", "e", 0));
	a.done(chatKey("S", "e", 0), fields);
	const kept = a.get(chatKey("S", "e", 0));
	assert.ok(kept?.state === "done" && kept.fields.length === 65 && kept.fields[64]![0] === "pi-note");
});
