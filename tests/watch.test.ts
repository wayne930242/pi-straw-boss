import assert from "node:assert/strict";
import { test } from "node:test";
import type { Change, Reader } from "../src/history.ts";
import type { Found } from "../src/net.ts";
import { type Hub, watchSession } from "../src/watch.ts";

/** A hub whose readers are fakes: `fail` makes the next first page of a file throw, and `log` records acquire and release. */
function hub(found: Found) {
	const log: string[] = [], fail = new Set<string>(), subs = new Map<string, Set<(c: Change) => void>>();
	const reader = (file: string): Reader => ({
		ready: Promise.resolve(),
		header: () => ({ id: file }),
		unreadable: () => 0,
		page: async () => {
			if (fail.delete(file)) throw new Error("vanished");
			return { items: [{ id: `${file}-1`, kind: "user", text: file }] };
		},
		entry: async () => undefined,
		subscribe: (fn) => (subs.get(file)?.add(fn) ?? subs.set(file, new Set([fn])), () => void subs.get(file)!.delete(fn)),
		start() {},
		stop() {},
	});
	const h: Hub = { lookup: () => found, workspace: () => [], readers: { acquire: (file) => (log.push(`+${file}`), reader(file)), release: (file) => void log.push(`-${file}`) } };
	return { h, log, fail, listeners: (file: string) => subs.get(file)?.size ?? 0 };
}
const sent = () => {
	const out: { reset?: boolean; items?: { id: string }[] }[] = [];
	return { out, send: (_: string, data: unknown) => void out.push(data as (typeof out)[number]) };
};

test("a first page that fails releases the reader, and the next refresh attaches again", async () => {
	const { h, log, fail, listeners } = hub({ key: "k", base: "w", name: "n", role: "main", file: "A", live: true });
	const { out, send } = sent();
	const w = watchSession(h, "k", send);
	fail.add("A");
	await w.refresh();
	assert.deepEqual([log, out, listeners("A")], [["+A", "-A"], [], 0], "nothing sent, nothing held, nothing queued");
	await w.refresh();
	assert.deepEqual([log, out.map((o) => o.items?.map((i) => i.id))], [["+A", "-A", "+A"], [["A-1"]]]);
	w.stop();
	assert.deepEqual([log.at(-1), listeners("A")], ["-A", 0], "stopping releases the reader and unsubscribes");
});

test("a key whose file changes re-attaches to the new file and resets the page", async () => {
	const found: Found = { key: "k", base: "w", name: "n", role: "main", file: "A", live: true };
	const { h, log, listeners } = hub(found);
	const { out, send } = sent();
	const w = watchSession(h, "k", send);
	await w.refresh();
	found.file = "B";
	await w.refresh();
	assert.deepEqual(log, ["+A", "-A", "+B"]);
	assert.deepEqual(out.map((o) => [o.reset, o.items?.map((i) => i.id)]), [[true, ["A-1"]], [true, ["B-1"]]]);
	assert.deepEqual([listeners("A"), listeners("B")], [0, 1]);
	w.stop();
	assert.deepEqual([log.at(-1), listeners("B")], ["-B", 0]);
});
