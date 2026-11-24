import assert from "node:assert/strict";
import { test } from "node:test";
import { createWorkerCap, type Room } from "../src/workercap.ts";

// docs/specs/2026-11-24-capacity.md, The cap: with a capacity budget the device's points gate a worker instead of the count of 4.
const REGISTRY = Symbol.for("pi-subagents/runtime");
const registry = (workers: number) => {
	const running = new Map<string, { id: string; agent: string }>();
	for (let i = 0; i < workers; i++) running.set(`w${i}`, { id: `w${i}`, agent: "worker" });
	(globalThis as Record<symbol, unknown>)[REGISTRY] = { runningSubagents: running };
};

test("with a budget, the device's points gate a worker, past the count of 4", () => {
	registry(6);
	let room: Room | undefined = { points: 6, budget: 8 };
	const cap = createWorkerCap(undefined, () => room);
	assert.equal(cap.admit("c1", "worker"), undefined, "6 + 1 fits 8, though 6 workers run");
	assert.equal(cap.admit("c2", "worker"), undefined, "6 + 1 admitted + 1 fits 8");
	assert.match(cap.admit("c3", "worker")?.reason ?? "", /^sb: the device runs 6 of its 8 capacity points \(2 more starting in this message\): wait for a result/);
	assert.equal(cap.admit("c-s", "scout"), undefined, "a scout is no worker");
	cap.settle();
	room = { points: 8, budget: 8 };
	assert.match(cap.admit("c4", "worker")?.reason ?? "", /8 of its 8 capacity points/);
});

test("without a budget, or with no fresh device row, the count of 4 stands", () => {
	registry(4);
	for (const room of [undefined, { points: 0 }]) {
		const cap = createWorkerCap(undefined, () => room);
		assert.match(cap.admit("c1", "worker")?.reason ?? "", /^sb: 4 workers run for this main already/);
	}
	registry(3);
	assert.equal(createWorkerCap(undefined, () => ({ points: 0 })).admit("c1", "worker"), undefined);
});
