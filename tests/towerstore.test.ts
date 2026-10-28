import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendEvent, KEEP_MS, MAX_QUEUE, purgeQueues, queueLength, readQueue, type ServiceRecord } from "../src/server/towerstore.ts";
import type { Slot } from "../src/server/record.ts";

const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-tq-")) }) as Slot;
const service = (): ServiceRecord => ({ workspace: "wA", label: "A", id: "sb-tower-wa", name: "tower · A", pane: "wA:p1", tab: "wA:t1", created: "x", seq: 0 });
const event = (n: number) => ({ kind: "intercom" as const, from: { id: "x" }, text: `t${n}`, at: "now", messageId: `m${n}` });

test("B4R-F007: the queue keeps at most MAX_QUEUE events: the oldest go first, the sequence goes on", () => {
	const slot = slotIn(), svc = service();
	for (let n = 0; n < 12; n++) appendEvent(slot, svc, event(n), 10);
	assert.equal(queueLength(slot, "wA"), 10);
	assert.deepEqual(readQueue(slot, "wA").map((e) => e.seq), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	assert.ok(MAX_QUEUE >= 100);
});

test("B4R-F007: events older than a day go while the service lives", () => {
	const slot = slotIn(), svc = service();
	appendEvent(slot, svc, event(1));
	appendEvent(slot, svc, event(2));
	const dir = join(slot.dir, "tower", "wA", "queue"), [first] = readdirSync(dir).sort();
	const old = new Date(Date.now() - KEEP_MS - 60_000);
	utimesSync(join(dir, first!), old, old);
	assert.equal(purgeQueues(slot, Date.now()), 1);
	assert.deepEqual(readQueue(slot, "wA").map((e) => e.seq), [1]);
});

test("B4R-F007: a reopened service numbers past the events still queued, with the count cached per process", () => {
	const slot = slotIn();
	appendEvent(slot, service(), event(1));
	appendEvent(slot, service(), event(2)); // a service record that starts again at 0
	assert.deepEqual(readQueue(slot, "wA").map((e) => e.seq), [0, 1]);
});

test("B5R-F001/F004: an old queue/parked folder does not throw; its old files age out; purgeAll removes parked, runs, notes and the rest", async () => {
	const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
	const { purgeAll } = await import("../src/server/towerstore.ts");
	const slot = slotIn();
	appendEvent(slot, service(), event(1));
	const base = join(slot.dir, "tower", "wA"), parked = join(base, "queue", "parked");
	mkdirSync(parked, { recursive: true });
	writeFileSync(join(parked, "old.json"), "{}");
	writeFileSync(join(parked, "new.json"), "{}");
	const old = new Date(Date.now() - KEEP_MS - 60_000);
	utimesSync(parked, old, old);
	utimesSync(join(parked, "old.json"), old, old);
	assert.equal(purgeQueues(slot, Date.now()), 1);
	assert.deepEqual(readdirSync(parked), ["new.json"]);
	mkdirSync(join(base, "runs"), { recursive: true });
	for (const f of ["runs/r1.json", "notes.jsonl", "expects.json", "timer.json", "seen.jsonl", "ally-routes.json", "ally-answers.json", "ally-opened.json"]) writeFileSync(join(base, f), "x");
	assert.ok(purgeAll(slot) >= 10);
	assert.deepEqual(readdirSync(base), []);
	assert.equal(existsSync(parked), false);
});
