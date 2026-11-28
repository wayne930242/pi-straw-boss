import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
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

// The snoozable stale reminder (docs/specs/2026-11-28-stale-snooze.md): the main's open todos and its board_set snoozes reach its capacity file, kept across a /reload; a todo's snooze goes with the todo.
test("board_set snooze: the open todos and the snoozes reach the capacity file; refused without a reason, with another field, on a todo not open, or on a key not watched", async () => {
	const ask = async (r: Record<string, unknown>) => (r.cmd === "watch-list" ? { ok: true, watches: [{ key: "train-a", until: clock + 3600_000 }], snoozes: true } : { ok: false, error: "not in this test" });
	const a = world.agent({ id: "a1", name: "api-main", pane: "wA:p1", tab: "wA:t1", deps: { now, ask } });
	await a.start();
	await a.promote();
	setTodos(a, [{ id: 1, subject: "done", status: "completed" }, { id: 3, subject: "deploy the api", status: "pending" }, { id: 5, subject: "review", status: "in_progress", metadata: { waitsOn: "boss" } }]);
	await a.fire("turn_end");
	assert.deepEqual(capOf("a1")!.todos, [{ id: 3, subject: "deploy the api" }, { id: 5, subject: "review", until: 8.64e15 }]);
	const said = await a.tool("board_set", { snooze: { why: "CI runs", for: "30m" } });
	assert.match((said.content[0] as { text: string }).text, /^Reminder snoozed until \d\d:\d\d \("CI runs"\)\. If your open todos are still unanswered then, sb reminds you again; a new snooze of the main replaces this one\.$/);
	const s = capOf("a1")!.snoozes!;
	assert.deepEqual(s.map((x) => [x.why, x.until - x.at]), [["CI runs", 30 * 60_000]]);
	await a.tool("board_set", { snooze: { why: "lands next", watch: "train-a", todo: 3 } });
	assert.deepEqual(capOf("a1")!.snoozes!.map((x) => [x.why, x.todo, x.watch]), [["CI runs", undefined, undefined], ["lands next", 3, "train-a"]]);
	for (const [input, error] of [[{ snooze: { for: "30m" } }, /why/], [{ snooze: { why: "x", for: "1h" }, now: "x" }, /snooze takes no now, items, auto, or clear/], [{ snooze: { why: "x", for: "1h", todo: 1 } }, /no open todo #1/], [{ snooze: { why: "x", watch: "other" } }, /start boss_watch on it first/]] as const)
		await assert.rejects(a.tool("board_set", input as never), error, JSON.stringify(input));
	const carry = [...a.entries];
	await a.stop("reload");
	const b = await main(carry);
	await b.fire("turn_end");
	assert.equal(capOf("a1")!.snoozes?.length, 2, "a /reload keeps the snoozes");
	setTodos(b, [{ id: 3, subject: "deploy the api", status: "completed" }]);
	await b.fire("turn_end");
	assert.deepEqual(capOf("a1")!.snoozes!.map((x) => x.why), ["CI runs"], "a todo's snooze goes with the todo");
});

// Review snooze-review F003, F004, F006: a server of an older build drops the snoozes it reads, a write that fails keeps nothing, and a todo past the first 100 is still a todo.
test("board_set snooze: refused when no server answers or the server is older than snoozes, and when the file cannot be written; a todo past the 100th is snoozed and kept", async () => {
	let reply: { ok: boolean; [k: string]: unknown } | undefined = { ok: true, watches: [] };
	const ask = async () => (reply ? reply : Promise.reject(new Error("no server")));
	const a = world.agent({ id: "a1", name: "api-main", pane: "wA:p1", tab: "wA:t1", deps: { now, ask } });
	await a.start();
	await a.promote();
	setTodos(a, Array.from({ length: 101 }, (_, i) => ({ id: i + 1, subject: `t${i + 1}`, status: "pending" })));
	await a.fire("turn_end");
	assert.equal(capOf("a1")!.todos?.length, 101, "every open todo reaches the file");
	await assert.rejects(a.tool("board_set", { snooze: { why: "CI runs", for: "30m" } }), /older pi-straw-boss/, "a server without snoozes");
	reply = undefined;
	await assert.rejects(a.tool("board_set", { snooze: { why: "CI runs", for: "30m" } }), /no sb server answers/);
	assert.equal(capOf("a1")!.snoozes, undefined, "nothing was kept");
	reply = { ok: true, watches: [], snoozes: true };
	await a.tool("board_set", { snooze: { why: "the last one", for: "30m", todo: 101 } });
	assert.deepEqual(capOf("a1")!.snoozes!.map((s) => s.todo), [101]);
	const dir = capDir(join(world.stateDir, "board"));
	rmSync(dir, { recursive: true, force: true });
	writeFileSync(dir, "not a folder");
	await assert.rejects(a.tool("board_set", { snooze: { why: "CI runs", for: "30m" } }), /could not be written/);
	rmSync(dir, { force: true });
});
