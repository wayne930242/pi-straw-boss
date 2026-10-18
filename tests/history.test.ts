import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { type Change, openReader, type Reader, readers } from "../src/history.ts";
import { type Item, toItem } from "../src/items.ts";
import { until } from "./fakes.ts";
import { assistant, call, compaction, custom, header, lines, message, result, text, user } from "./sessions.ts";

const dir = mkdtempSync(join(tmpdir(), "psb-history-test-"));
const open: Reader[] = [];
after(() => {
	open.forEach((r) => r.stop());
	rmSync(dir, { recursive: true, force: true });
});
let n = 0;
const file = () => join(dir, `s${n++}.jsonl`);
const reader = (path: string, poll = 20) => {
	const r = openReader(path, poll);
	open.push(r);
	return r;
};
const ids = (items: Item[]) => items.map((i) => i.id);
/** A reference reading: parse every line, follow the last entry up through parentId, map each entry. */
function reference(path: string, text: string) {
	const entries = text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id: string; parentId: string | null; type: string });
	const byId = new Map(entries.filter((e) => e.type !== "session").map((e) => [e.id, e]));
	const chain: typeof entries = [];
	for (let e = entries.at(-1); e; e = e.parentId === null ? undefined : byId.get(e.parentId)) chain.unshift(e);
	return chain.map((e) => toItem(e as never, 0)).filter(Boolean).map((i) => i!.id);
}

test("the index agrees with a full parse on a file with every kind of entry, a 1.5 MB line, and lines across chunk boundaries", async () => {
	const path = file();
	const entries: unknown[] = [header(), { type: "model_change", id: "m0", parentId: null, timestamp: "t", provider: "p", modelId: "x" }, user("u1", "m0", "hi")];
	let parent = "u1";
	for (let i = 0; i < 30; i++) {
		entries.push(assistant(`a${i}`, parent, [text(`reply ${i}`), call(`c${i}`, "bash", { command: `echo ${i}` })]), result(`r${i}`, `a${i}`, `c${i}`, i === 7 ? "y".repeat(1_500_000) : `out ${i}`));
		parent = `r${i}`;
		if (i === 10) (entries.push(custom("n1", parent, "intercom_message", "m", true, { from: { name: "ops" } })), (parent = "n1"));
		if (i === 11) (entries.push(custom("n2", parent, "memory-context", "hidden", false)), (parent = "n2"));
		if (i === 15) (entries.push(compaction("k1", parent, "sum"), { type: "custom", customType: "x", data: { a: 1 }, id: "cu1", parentId: "k1", timestamp: "t" }), (parent = "cu1"));
		if (i === 20) (entries.push({ type: "branch_summary", id: "bs", parentId: parent, timestamp: "t", summary: "s", fromId: parent }), (parent = "bs"));
	}
	writeFileSync(path, lines(entries));
	const r = reader(path);
	const { items } = await r.page(undefined, 1000);
	assert.deepEqual(ids(items), reference(path, lines(entries)));
	assert.ok(statSync(path).size > 1 << 20, "the file spans more than one 1 MB chunk");
	assert.deepEqual([r.header(), r.unreadable()], [{ id: "sess-1", cwd: "/work/demo" }, 0]);
	const big = items.find((i) => i.id === "r7")!;
	assert.deepEqual([big.text!.length, big.more, big.callId, big.isError, big.bytes! > 1_500_000], [2048, true, "c7", false, true], "a huge result reads a preview, not the line");
	assert.equal((await r.entry("r7"))!.text!.length, 1 << 20, "the entry fetch returns at most 1 MB");
});

test("the view is the path from the last entry in file order; entries on other branches are not shown", async () => {
	const path = file();
	// u1 > a1 > (a2 > a3) and (a1 > b2): the file ends with b2, so the leaf is b2 and a2, a3 are another branch.
	writeFileSync(path, lines([header(), user("u1", null, "q"), assistant("a1", "u1", [text("one")]), assistant("a2", "a1", [text("two")]), assistant("a3", "a2", [text("three")]), assistant("b2", "a1", [text("other")])]));
	assert.deepEqual(ids((await reader(path).page()).items), ["u1", "a1", "b2"]);
});

test("pages walk back from a cursor, newest first, and name the cursor for the next older page", async () => {
	const path = file();
	const entries: unknown[] = [header()];
	for (let i = 0; i < 25; i++) entries.push(user(`u${i}`, i ? `u${i - 1}` : null, `m${i}`));
	writeFileSync(path, lines(entries));
	const r = reader(path);
	const newest = await r.page(undefined, 10);
	assert.deepEqual([ids(newest.items)[0], ids(newest.items).at(-1), newest.before], ["u15", "u24", "u15"]);
	const older = await r.page(newest.before, 10);
	assert.deepEqual([ids(older.items)[0], ids(older.items).at(-1), older.before], ["u5", "u14", "u5"]);
	const last = await r.page(older.before, 10);
	assert.deepEqual([ids(last.items).length, last.before], [5, undefined], "no cursor when nothing is older");
	assert.deepEqual((await r.page("missing")).items, []);
});

test("appends arrive as items; a line split across two writes waits for its newline; a skipped line is counted", async () => {
	const path = file();
	writeFileSync(path, lines([header(), user("u1", null, "first")]));
	const r = reader(path);
	await r.page();
	r.start();
	const changes: Change[] = [];
	r.subscribe((c) => changes.push(c));
	const next = JSON.stringify(assistant("a1", "u1", [text("answer")])) + "\n";
	appendFileSync(path, next.slice(0, 40));
	await new Promise((resolve) => setTimeout(resolve, 120));
	assert.equal(changes.length, 0, "half a line shows nothing");
	appendFileSync(path, next.slice(40));
	await until(() => changes.length === 1, "the finished line");
	assert.deepEqual([changes[0]!.reset, ids(changes[0]!.items)], [false, ["a1"]]);
	appendFileSync(path, "{this is not json}\n" + lines([user("u2", "a1", "again")]));
	await until(() => changes.length === 2, "the next entry");
	assert.deepEqual([ids(changes[1]!.items), r.unreadable()], [["u2"], 1]);
});

test("a rewritten or truncated file is re-indexed and the page is reset", async () => {
	const path = file();
	writeFileSync(path, lines([header("old"), user("u1", null, "one"), user("u2", "u1", "two")]));
	const r = reader(path);
	await r.page();
	r.start();
	const changes: Change[] = [];
	r.subscribe((c) => changes.push(c));
	truncateSync(path, 0);
	writeFileSync(path, lines([header("new"), user("x1", null, "fresh")]));
	await until(() => changes.length >= 1, "the reset");
	assert.deepEqual([changes[0]!.reset, ids(changes[0]!.items), r.header()?.id], [true, ["x1"], "new"]);
	// Same size is not enough to hide a rewrite: a different file moved into place is a new inode, and a new header is a rewrite.
	const other = join(dir, "other.jsonl");
	writeFileSync(other, lines([header("third"), user("y1", null, "swapped"), user("y2", "y1", "more entries so it grows")]));
	renameSync(other, path);
	await until(() => changes.length >= 2, "the swap");
	assert.deepEqual([changes.at(-1)!.reset, ids(changes.at(-1)!.items)], [true, ["y1", "y2"]]);
	writeFileSync(path, lines([header("fourth"), user("z1", null, "in place rewrite that is larger than before to keep growing"), user("z2", "z1", "x"), user("z3", "z2", "y")]));
	await until(() => changes.length >= 3, "the in-place rewrite");
	assert.deepEqual([changes.at(-1)!.reset, r.header()?.id], [true, "fourth"]);
});

test("an entry whose parent is not the current leaf moves the branch and resets the page; a plain append does not", async () => {
	const path = file();
	writeFileSync(path, lines([header(), user("u1", null, "q"), assistant("a1", "u1", [text("one")]), assistant("a2", "a1", [text("two")])]));
	const r = reader(path);
	await r.page();
	r.start();
	const changes: Change[] = [];
	r.subscribe((c) => changes.push(c));
	appendFileSync(path, lines([assistant("a3", "a2", [text("three")])]));
	await until(() => changes.length === 1, "a plain append");
	assert.deepEqual([changes[0]!.reset, ids(changes[0]!.items)], [false, ["a3"]]);
	// /tree back to a1: the next entry names a1 as its parent, so a2 and a3 leave the view.
	appendFileSync(path, lines([user("u2", "a1", "different direction")]));
	await until(() => changes.length === 2, "the branch move");
	assert.deepEqual([changes[1]!.reset, ids(changes[1]!.items)], [true, ["u1", "a1", "u2"]]);
});

test("a session with no file yet shows nothing, and the page fills in when the file is created", async () => {
	const path = file();
	const r = reader(path);
	assert.deepEqual(await r.page(), { items: [], before: undefined });
	r.start();
	const changes: Change[] = [];
	r.subscribe((c) => changes.push(c));
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(changes.length, 0);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, lines([header(), user("u1", null, "born")]));
	await until(() => changes.length >= 1, "the created file");
	assert.deepEqual([changes[0]!.reset, ids(changes[0]!.items)], [true, ["u1"]]);
});

test("readers are shared per file, stop watching when released, and keep at most the last eight idle", async () => {
	const made: string[] = [];
	const stopped: string[] = [];
	const pool = readers(2, (path) => {
		const real = openReader(path);
		made.push(path);
		return { ...real, stop: () => (stopped.push(path), real.stop()) };
	});
	const paths = [file(), file(), file(), file()];
	paths.forEach((p) => writeFileSync(p, lines([header(), user("u1", null, "x")])));
	const a = pool.acquire(paths[0]!), b = pool.acquire(paths[0]!);
	assert.equal(a, b, "one reader per file");
	pool.release(paths[0]!);
	assert.deepEqual(stopped, [], "still watched by the other page");
	pool.release(paths[0]!);
	assert.deepEqual(stopped, [paths[0]]);
	for (const p of paths.slice(1)) (pool.acquire(p), pool.release(p));
	assert.equal(pool.acquire(paths[0]!) === a, false, "the oldest idle reader was dropped past the keep limit");
	assert.equal(made.length, 5);
});

/** Every id on the path, walking the pages back from the newest. */
async function walk(r: Reader) {
	const all: string[] = [];
	for (let page = await r.page(undefined, 300); ; page = await r.page(page.before, 300)) {
		all.unshift(...ids(page.items));
		if (!page.before) return all;
	}
}

test("entries appended while a multi-MB file is first indexed wait for the index, so the whole path is kept", async () => {
	const path = file(), count = 5000, pad = "x".repeat(2000);
	writeFileSync(path, lines([header(), ...Array.from({ length: count }, (_, i) => user(`e${i}`, i ? `e${i - 1}` : null, `${i} ${pad}`))]));
	assert.ok(statSync(path).size > 9_000_000);
	const r = reader(path, 5);
	r.start();
	await new Promise((resolve) => setTimeout(resolve, 5));
	appendFileSync(path, lines([user(`e${count}`, `e${count - 1}`, "live 1")]));
	await new Promise((resolve) => setTimeout(resolve, 10));
	appendFileSync(path, lines([user(`e${count + 1}`, `e${count}`, "live 2")]));
	await until(async () => (await r.page(undefined, 1)).items[0]?.id === `e${count + 1}`, "the appended entries");
	const all = await walk(r);
	assert.equal(r.unreadable(), 0);
	assert.equal(all.length, count + 2, "no entry is cut off or skipped");
	assert.deepEqual(all, Array.from({ length: count + 2 }, (_, i) => `e${i}`));
});

test("a read after a rewrite never uses the old index: the file is re-indexed first, and a cursor of the old file finds nothing", async () => {
	const path = file(), next = `${path}.next`, pad = "y".repeat(2000);
	writeFileSync(path, lines([header(), ...Array.from({ length: 3000 }, (_, i) => user(`o${i}`, i ? `o${i - 1}` : null, pad))]));
	writeFileSync(next, lines([header("sess-2"), ...Array.from({ length: 3000 }, (_, i) => user(`n${i}`, i ? `n${i - 1}` : null, pad))]));
	const r = reader(path, 5);
	r.start();
	await r.ready;
	const reads = Array.from({ length: 20 }, (_, i) => r.page(`o${2900 - i * 100}`, 50));
	renameSync(next, path);
	// A read looks at the file first: the cursor of the replaced file is gone, so the page is empty instead of read at stale offsets.
	for (const page of await Promise.all(reads)) assert.deepEqual([page.items.length, page.before], [0, undefined], "nothing read at the old offsets");
	await until(async () => (await r.page(undefined, 1)).items[0]?.id === "n2999", "the rewritten file");
	assert.equal((await walk(r)).length, 3000);
});

test("a 50 MB session indexes inside the budget and its first page is quick", { skip: !process.env.PERF && "set PERF=1" }, async () => {
	const path = file();
	const chunk = lines(Array.from({ length: 200 }, (_, i) => result(`p${i}`, i ? `p${i - 1}` : null, `c${i}`, "z".repeat(5000))));
	writeFileSync(path, lines([header()]));
	for (let i = 0; i < 50; i++) appendFileSync(path, chunk.replaceAll(/"id":"p(\d+)"/g, (_, d) => `"id":"p${i}-${d}"`).replaceAll(/"parentId":"p(\d+)"/g, (_, d) => `"parentId":"p${i}-${d}"`));
	const started = performance.now();
	const r = reader(path);
	await r.ready;
	const indexed = performance.now() - started;
	const first = await r.page();
	assert.ok(indexed <= 100 || process.env.PERF_LOOSE, `indexing took ${indexed.toFixed(0)} ms`);
	assert.ok(performance.now() - started <= 300, "first page within 300 ms");
	assert.equal(first.items.length, 150);
});

test("the todo list is the newest rpiv-todo snapshot on the branch: its own entries first, else its tool's results; it comes with the change that adds one", async () => {
	const path = file();
	const tasks = (n: number, done = 0) => Array.from({ length: n }, (_, i) => ({ id: i + 1, subject: `task ${i + 1}`, status: i < done ? "completed" : i === done ? "in_progress" : "pending", ...(i === done && { activeForm: `doing ${i + 1}` }) }));
	const todoResult = (id: string, parentId: string, list: unknown[]) => message(id, parentId, { role: "toolResult", toolCallId: `c-${id}`, toolName: "todo", content: [text("ok")], details: { action: "create", params: {}, tasks: list, nextId: list.length + 1 }, isError: false, timestamp: 1 });
	// rpiv-todo writes `type` and `customType` before `id`, as the real entries do.
	const snapshot = (id: string, parentId: string, list: unknown[]) => ({ type: "custom", customType: "rpiv-todo-state", data: { action: "update", params: {}, tasks: list, nextId: list.length + 1 }, id, parentId, timestamp: "2026-10-17T08:00:02.000Z" });
	writeFileSync(path, lines([header(), user("u1", null, "go"), todoResult("r1", "u1", tasks(2))]));
	const r = reader(path);
	await r.ready;
	assert.deepEqual((await r.todos())?.map((t) => [t.subject, t.status]), [["task 1", "in_progress"], ["task 2", "pending"]], "an older session: the tool's result");
	const changes: Change[] = [];
	r.subscribe((c) => changes.push(c));
	r.start();
	appendFileSync(path, lines([snapshot("s1", "r1", [...tasks(3, 1), { id: 9, subject: "gone", status: "deleted" }]), todoResult("r2", "s1", tasks(1))]));
	await until(() => changes.some((c) => c.todos), "a change with the list");
	assert.deepEqual(changes.find((c) => c.todos)!.todos!.map((t) => t.status), ["completed", "in_progress", "pending"], "the entry wins over a later result, and a deleted task is left out");
	assert.equal(changes.find((c) => c.todos)!.todos![1]!.activeForm, "doing 2");
	changes.length = 0;
	appendFileSync(path, lines([user("u2", "r2", "more")]));
	await until(() => changes.length, "the next change");
	assert.equal(changes[0]!.todos, undefined, "a change without a snapshot carries no list");
	const empty = file();
	writeFileSync(empty, lines([header(), user("u1", null, "hi")]));
	assert.equal(await reader(empty).todos(), null);
});
