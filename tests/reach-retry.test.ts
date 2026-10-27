import assert from "node:assert/strict";
import { test } from "node:test";
import { createReach } from "../src/reach.ts";
import type { Kit } from "../src/state.ts";

// Straw Boss's sender retries every failed send to a tower identity (`sb-tower-*`) for up to 30 s (docs/specs/2026-10-26-sb-backend.md, Queueing and concurrency, Retrying sends to a tower): the broker
// never sends a message again by itself, and pi-intercom's outbox cannot say whether an outcome is unknown. A retry goes under `<request id>~r<n>`, n up to 4, because the outbox refuses a request id
// it already used; the tower service's dedupe makes a retry safe.

interface Scripted { to: string; message: string; requestId: string }
function world(results: ("sent" | "failed" | "blocked" | "rejected")[], live: (slept: number[]) => boolean = () => false) {
	const handlers = new Set<(data: unknown) => void>(), sends: Scripted[] = [], slept: number[] = [];
	const events = {
		on: (channel: string, handler: (data: unknown) => void) => (channel === "intercom:outbox-result" ? (handlers.add(handler), () => handlers.delete(handler)) : () => {}),
		emit: (channel: string, data: unknown) => {
			if (channel !== "intercom:outbox-request") return;
			const request = data as Scripted;
			sends.push(request);
			const status = results[Math.min(sends.length - 1, results.length - 1)]!;
			queueMicrotask(() => [...handlers].forEach((h) => h({ requestId: request.requestId, status, ...(status === "failed" ? { code: "delivery_failed", detail: "Session x is not connected" } : {}) })));
		},
	};
	const kit = {
		pi: { events }, cfg: { run: async () => "{}", api: async () => {}, sleep: async (ms: number) => void slept.push(ms) }, guiDir: "/x", me: () => "main-1", role: () => "main", tell: () => {},
		s: { c: { listSessions: async () => (live(slept) ? [{ id: "sb-tower-wa" }] : []) }, at: {}, ownName: "m" },
	} as unknown as Kit;
	return { reach: createReach(kit), sends, slept };
}

test("a failed send to a tower identity is retried under <request id>~r<n>, whatever the reason, and stops at the first that is sent", async () => {
	const { reach, sends } = world(["failed", "blocked", "sent"]);
	const result = await reach.send("sb-tower-wa", "hello");
	assert.equal(result.status, "sent");
	assert.equal(sends.length, 3);
	assert.equal(sends[1]!.requestId, `${sends[0]!.requestId}~r1`);
	assert.equal(sends[2]!.requestId, `${sends[0]!.requestId}~r2`);
	assert.deepEqual(new Set(sends.map((s) => s.message)), new Set(["hello"]));
});

test("at most 4 retries, at 2, 5, 10 and 20 s after the first failure (inside the 30 s budget), and the last failure is the answer", async () => {
	const { reach, sends, slept } = world(["failed"]);
	const result = await reach.send("sb-tower-wa", "hello");
	assert.equal(result.status, "failed");
	assert.equal(sends.length, 5);
	assert.deepEqual(sends.map((s) => s.requestId.match(/~r(\d)$/)?.[1] ?? "0"), ["0", "1", "2", "3", "4"]);
	assert.equal(slept.reduce((a, b) => a + b, 0), 20_000, "the last retry is at 20 s");
});

test("a retry comes as soon as the identity is live again", async () => {
	const { reach, sends, slept } = world(["failed", "sent"], (waits) => waits.length >= 2);
	assert.equal((await reach.send("sb-tower-wa", "hello")).status, "sent");
	assert.equal(sends.length, 2);
	assert.deepEqual(slept, [500, 500], "retried at 1 s, not at the 2 s step");
});

test("a send to any other target is not retried, and a rejected request is not retried either", async () => {
	const other = world(["failed"]);
	assert.equal((await other.reach.send("main-2", "hello")).status, "failed");
	assert.equal(other.sends.length, 1);
	const rejected = world(["rejected"]);
	assert.equal((await rejected.reach.send("sb-tower-wa", "hello")).status, "rejected");
	assert.equal(rejected.sends.length, 1);
});
