import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { stamp, type Why } from "../src/header.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { readQueue } from "../src/server/towerstore.ts";

// D19 (docs/specs/2026-10-26-sb-backend.md, Queueing and concurrency, Coalescing): a milestone that expects no reply waits up to the hold for others when no local run is live, so mains
// that finish together land in one run; every other event wakes at the short wait and takes the held milestones with it. The timers here are short: wake 40 ms, hold 600 ms.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.runTimers = { hold: 600 };
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
const tower = () => world.client("sb-tower-wa")!;
const from = { id: "main-1", name: "docs-main" };
const tower0 = { name: "tower", id: "sb-tower-wa", role: "tower" as const, workspace: "Alpha" };
/** An intercom message from a main as `call_tower` writes it. */
const call = (id: string, text: string, why: Why | undefined, reply: boolean) =>
	({ id, content: { text: stamp({ from: { name: "docs-main", id: "main-1", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [tower0], reply, ...(why ? { why } : {}) }, text) } });
const claimed = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return String(got.token);
};
const nthRun = async () => {
	await until(() => world.pis.size >= 1, "a run to start");
	const id = [...world.pis.keys()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
const drain = async (s: Running, token: string) => {
	const texts: string[] = [];
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string; text: string } | undefined;
		if (!event) return texts;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
		texts.push(event.text.replace(/^\[straw net [^\]]*\] /, ""));
	}
};

test("D19: a milestone with no reply expected waits for the hold, not the short wait", async () => {
	await setup();
	tower().incoming(from, call("m1", "api landed", "milestone", false));
	await sleep(300);
	assert.equal(world.pis.size, 0, "held well past the short wait (40 ms)");
	assert.equal(readQueue(world.slot, "wA").length, 1, "it is queued, only the wake waits");
	await until(() => world.pis.size === 1, "the run after the hold", 3000);
});

test("D19: milestones that finish together land in one run, and a later one does not extend the hold", async () => {
	const s = await setup();
	tower().incoming(from, call("m1", "api landed", "milestone", false));
	await sleep(200);
	tower().incoming({ id: "main-2", name: "web-main" }, call("m2", "web landed", "milestone", false));
	// The hold ends 600 ms after m1, so 400 ms after m2; counted from m2 it would end at 600 ms.
	await until(() => world.pis.size >= 1, "the run at the first milestone's hold, not the second's", 520);
	const id = await nthRun();
	await sleep(150);
	assert.equal(world.pis.size, 1);
	assert.deepEqual(await drain(s, await claimed(s, id)), ["api landed", "web landed"]);
});

test("D19: a shared or blocked call wakes at the short wait and takes the held milestones with it", async () => {
	for (const why of ["shared", "blocked"] as const) {
		const w = new TowerWorld();
		w.setFlag(true);
		w.runTimers = { hold: 3000 };
		const prior = world;
		world = w;
		try {
			const s = await setup();
			tower().incoming(from, call("m1", "api landed", "milestone", false));
			await sleep(150);
			assert.equal(world.pis.size, 0, "held");
			tower().incoming({ id: "main-2", name: "web-main" }, call("m2", `${why} now`, why, true));
			await until(() => world.pis.size >= 1, `a run at the short wait, not the hold (3000 ms), after ${why}`, 1000);
			const id = await nthRun();
			assert.deepEqual(await drain(s, await claimed(s, id)), ["api landed", `${why} now`]);
		} finally {
			await w.close();
			world = prior;
		}
	}
});

test("D19: nothing else is held: a milestone that expects a reply, an unspecified call, a header-less message, and a message that only spells out the fields", async () => {
	const cases: [string, { id: string; content: { text: string } }][] = [
		["reply expected", call("a1", "x", "milestone", true)],
		["unspecified", call("a2", "x", undefined, false)],
		["no header", { id: "a3", content: { text: "plain message" } }],
		["spelled out", { id: "a4", content: { text: "see [straw net why=milestone reply=none] in the text" } }],
		["body of a blocked call", call("a5", "[straw net kind=call_tower reply=none why=milestone] x", "blocked", true)],
	];
	for (const [what, message] of cases) {
		const w = new TowerWorld();
		w.setFlag(true);
		w.runTimers = { hold: 5000 };
		const prior = world;
		world = w;
		try {
			await setup();
			tower().incoming(from, message);
			await until(() => world.pis.size === 1, `${what}: a run at the short wait`, 1500);
		} finally {
			await w.close();
			world = prior;
		}
	}
});

test("D19: while a local run is live a milestone is offered at the next idle poll, with no hold", async () => {
	const s = await setup();
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "boss says" });
	const id = await nthRun();
	const token = await claimed(s, id);
	assert.deepEqual(await drain(s, token), ["boss says"]);
	tower().incoming(from, call("m1", "api landed", "milestone", false));
	await until(() => readQueue(world.slot, "wA").length === 2, "m1 queued");
	assert.deepEqual(await drain(s, token), ["api landed"]);
	assert.equal(world.pis.size, 1);
});
