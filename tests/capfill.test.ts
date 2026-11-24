import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { capDir, PAUSE_EVENT, readCaps } from "../src/capacity.ts";
import { World } from "./fakes.ts";

// A main's capacity file (src/capfill.ts): written from its todo list and the pause seam, the pause cleared by `resumed` or a new turn and kept across a /reload, the file gone at the quit.

let world = new World();
afterEach(async () => { await world.stopAll(); world = new World(); });
let clock = 1_800_000_000_000;
const now = () => (clock += 1000);
const capOf = (id: string) => readCaps(capDir(join(world.stateDir, "board"))).find((c) => c.session === id);
async function main(carry?: unknown[]) {
	const a = world.agent({ id: "a1", name: "api-main", pane: "wA:p1", tab: "wA:t1", deps: { now } });
	if (carry) a.entries.push(...(carry as never[]));
	await a.start();
	await a.promote();
	return a;
}
const setTodos = (a: { entries: unknown[] }, tasks: unknown[]) => a.entries.push({ customType: "rpiv-todo-state", data: { tasks, nextId: tasks.length + 1 } });

test("the todo list's points and the pause seam reach the capacity file; a new turn clears the pause, a /reload keeps it, the quit removes the file", async () => {
	const a = await main();
	setTodos(a, [
		{ id: 1, subject: "api", status: "in_progress", owner: "w-api", metadata: { points: 2 } },
		{ id: 2, subject: "page", status: "pending", blockedBy: [1] },
		{ id: 3, subject: "docs", status: "pending", metadata: { points: 0.5 } },
	]);
	await a.fire("turn_end");
	assert.deepEqual((({ doing, ready, open, pause }) => ({ doing, ready, open, pause }))(capOf("a1")!), { doing: [{ owner: "w-api", points: 2 }], ready: [{ points: 0.5 }], open: 3, pause: undefined });
	const until = Date.parse("2026-11-24T16:02:00Z");
	a.emit(PAUSE_EVENT, { v: 1, state: "paused", reason: "quota", until, detail: "weekly limit · resets Nov 24, 4pm" });
	assert.deepEqual((({ reason, until: u, detail }) => ({ reason, until: u, detail }))(capOf("a1")!.pause!), { reason: "quota", until, detail: "weekly limit · resets Nov 24, 4pm" });
	a.emit(PAUSE_EVENT, { v: 2, state: "resumed", reason: "quota" });
	assert.ok(capOf("a1")!.pause, "a payload of another version is ignored");
	const carry = [...a.entries];
	await a.stop("reload");
	const b = await main(carry);
	await b.fire("turn_end");
	assert.equal(capOf("a1")!.pause?.until, until, "a /reload keeps the pause");
	await b.fire("turn_start");
	assert.equal(capOf("a1")!.pause, undefined, "a new turn clears it");
	b.emit(PAUSE_EVENT, { v: 1, state: "paused", reason: "quota" });
	assert.ok(capOf("a1")!.pause);
	b.emit(PAUSE_EVENT, { v: 1, state: "resumed", reason: "quota" });
	assert.equal(capOf("a1")!.pause, undefined, "resumed clears it");
	await b.stop("quit");
	assert.equal(capOf("a1"), undefined, "the quit removes the file");
});

test("a member writes no capacity file", async () => {
	const a = world.agent({ id: "m1", name: "member", pane: "wA:p1", tab: "wA:t1", deps: { now } });
	await a.start();
	setTodos(a, [{ id: 1, subject: "x", status: "pending" }]);
	await a.fire("turn_end");
	a.emit(PAUSE_EVENT, { v: 1, state: "paused", reason: "quota" });
	assert.equal(capOf("m1"), undefined);
});
