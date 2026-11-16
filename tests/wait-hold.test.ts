import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fakeClock } from "./fake-clock.ts";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { fieldsOf, header } from "../src/header.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { readQueue } from "../src/server/towerstore.ts";

// The wake hold (docs/specs/2026-11-16-wait-cards-flow.md, A): while the tower prompt's polls say the boss is answering wait cards in the standing pane, no run of that tower wakes, whatever event waits (D2: every event), so a press does
// not take the pane from under the next card. The hold ends `answer` (10 s) after the last poll that said so, at once with a poll that says the boss is done, and `answerMax` (5 min) after the first of a stretch at the latest; then one
// run takes everything that waited. The clock is the test's: the hold is read off it at the watcher's pace (20 ms here), so the times are ones the machine's clock cannot reach while the test runs.

let world: TowerWorld, clock: ReturnType<typeof fakeClock>;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	clock = world.runClock = fakeClock();
	world.runTimers = { answer: 10_000, answerMax: 300_000 };
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string; status?: number; body?: Record<string, unknown> };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const from = { id: "main-1", name: "mp3946-print" };
const msg = (id: string, text: string) => ({ id, content: { text } });
const tower = () => world.client("sb-tower-wa")!;
const MAIN = { id: "main-1", name: "mp3946-print", herdrLocation: { status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "MP-3946" }, paneId: "wA:p1" } };
const setup = async () => {
	world.sessions = [MAIN] as never;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
/** The nth run the server started (1-based), claimed. */
const claim = async (s: Running, n: number) => {
	await until(() => world.pis.size >= n, `run ${n}`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const pi = world.pis.get(id)!;
	let got: Reply | undefined;
	await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	return { id, token: String(got!.token) };
};
const drain = async (s: Running, token: string) => {
	const events: { id: string; kind: string; text: string }[] = [];
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as (typeof events)[number] | undefined;
		if (!event) return events;
		await ask(s, { cmd: "run-taken", token, id: event.id });
		events.push(event);
	}
};
const card = (n: number) => ({ op: "add", kind: "wait", for: "boss", type: "action", from: "main-1", happened: `Thing ${n} happened.`, do: `Do thing ${n}.`, url: "https://example.com/admin", after: `The tower goes on with ${n}.` });
/** A run that took a main's message adds `n` cards and ends, so the queue holds only what comes after. */
const waits = async (s: Running, n: number) => {
	tower().incoming(from, msg("m0", "blocked"));
	const run = await claim(s, 1);
	await drain(s, run.token);
	for (let i = 1; i <= n; i++) { const added = await ask(s, { cmd: "run-tool", token: run.token, tool: "tower_memory", args: card(i) }); assert.equal(added.ok, true, JSON.stringify(added)); }
	assert.equal((await ask(s, { cmd: "run-done", token: run.token, note: "n" })).ok, true);
	world.live.delete(world.pis.get(run.id)!.pid);
	await until(() => readRun(world.slot, "wA", run.id)?.outcome, "the first run to end");
};
const PID = 4321;
const poll = (s: Running, answering?: boolean) => ask(s, { cmd: "prompt-poll", workspace: "wA", pid: PID, ...(answering === undefined ? {} : { answering }) });
const press = (s: Running, id: string) => ask(s, { cmd: "tower-memory", workspace: "wA", json: { op: "press", id, act: "done" }, via: "prompt" });
/** Several looks of the hold at the clock's frozen time: what a look does at that time, it has done. */
const looks = () => sleep(150);
const notices = () => tower().sent.filter((m) => fieldsOf(m.text)?.kind === "wait_card");
/** The service's state: `waking` from the moment a run begins, before its pi is started (the start waits for the prompt to leave the pane). */
const state = async (s: Running) => ((await ask(s, { cmd: "status" })).towers as { service: { state: string } }[])[0]!.service.state;
/** No run began: several looks of the hold went by at the clock's time, and the service still stands by. */
const standing = async (s: Running, why: string) => {
	await looks();
	assert.equal(await state(s), "standing", why);
	assert.equal(world.pis.size, 1, why);
};

test("without an answering poll a press wakes a run at the short wait, as before", async () => {
	const s = await setup();
	await waits(s, 1);
	assert.equal((await poll(s)).holding, undefined);
	assert.equal((await press(s, "W1")).status, 200);
	await until(() => world.pis.size === 2, "the run the press wakes");
});

test("a press while the boss answers wakes no run: three cards are pressed one after another, each raiser's notice goes at its press, and when the prompt says the boss is done one run takes all three events", async () => {
	const s = await setup();
	await waits(s, 3);
	assert.equal((await poll(s, true)).ok, true);
	for (const id of ["W1", "W2", "W3"]) {
		assert.equal((await press(s, id)).status, 200);
		assert.equal(notices().at(-1)?.to, "main-1");
		assert.equal(fieldsOf(notices().at(-1)!.text)?.wait, id, "the raiser is told at the press, not by the run");
		clock.advance(2000);
		const polled = await poll(s, true);
		assert.equal(polled.holding, true, "the poll says the wake is held");
		assert.equal(polled.leave, false);
	}
	await standing(s, "no run began while the boss answered");
	assert.equal(notices().length, 3);
	assert.equal((await poll(s, true)).queued, 3, "the events wait, counted");
	const done = await poll(s, false);
	assert.equal(done.holding, undefined, "a poll that says the boss is done ends the hold");
	const run = await claim(s, 2);
	const events = await drain(s, run.token);
	assert.deepEqual(events.map((e) => /on wait (W\d)/.exec(e.text)?.[1]), ["W1", "W2", "W3"], "one run takes every press");
	await looks();
	assert.equal(world.pis.size, 2, "and only one");
});

test("the hold lapses 10 s after the last answering poll: a prompt that stopped polling holds nothing for longer", async () => {
	const s = await setup();
	await waits(s, 1);
	await poll(s, true);
	await press(s, "W1");
	clock.advance(9000);
	await standing(s, "9 s after the last poll the wake is still held");
	clock.advance(1000);
	await until(() => world.pis.size === 2, "the run once the hold lapsed");
});

test("the hold is renewed by each answering poll but never past 5 min after the first: the run starts then, with the prompt still answering", async () => {
	const s = await setup();
	await waits(s, 1);
	await poll(s, true);
	await press(s, "W1");
	// 4 min 58 s of polls every 2 s: each renews the hold.
	for (let i = 0; i < 149; i++) {
		clock.advance(2000);
		assert.equal((await poll(s, true)).holding, true, `poll ${i}`);
	}
	await standing(s, "held for as long as the polls renew it");
	clock.advance(2000);
	const last = await poll(s, true);
	assert.equal(last.holding, undefined, "5 min after the first answering poll nothing is held, whatever the prompt says");
	await until(() => world.pis.size === 2, "the run at the cap");
});

test("D2: every event is held while the boss answers, not only his presses: a main's message waits too, and wakes at the short wait once the hold ends", async () => {
	const s = await setup();
	await waits(s, 1);
	await poll(s, true);
	tower().incoming(from, msg("m1", "the build is green"));
	await until(() => readQueue(world.slot, "wA").some((e) => e.kind === "intercom" && !e.taken), "the message queued");
	clock.advance(2000);
	assert.equal((await poll(s, true)).holding, true);
	await standing(s, "a main's event does not end the boss's answering");
	await poll(s, false);
	await until(() => world.pis.size === 2, "the run for the message");
});

test("startsWithin follows the hold: a held wake is not a run that starts soon, and it is one in the hold's last seconds", async () => {
	const s = await setup();
	await waits(s, 1);
	const runs = world.expose!.runs;
	await poll(s, true);
	await press(s, "W1");
	assert.equal(runs.startsWithin("wA", 5000), false, "the wake is due when the hold ends, 10 s from now");
	clock.advance(2000);
	await poll(s, true);
	assert.equal(runs.startsWithin("wA", 5000), false, "a renewed hold moves the wake with it");
	clock.advance(6000);
	assert.equal(runs.startsWithin("wA", 5000), true, "4 s before the hold ends the run starts soon");
	assert.equal(await state(s), "standing");
});

test("a hold with nothing waiting holds nothing: the poll says no hold, and a stretch that ended starts its 5 min again", async () => {
	const s = await setup();
	await waits(s, 1);
	assert.equal((await poll(s, true)).holding, undefined, "no event waits");
	// A stretch of answering, ended by the prompt; the next one is counted from its own first poll.
	clock.advance(299_000);
	await poll(s, false);
	await poll(s, true);
	await press(s, "W1");
	clock.advance(2000);
	assert.equal((await poll(s, true)).holding, true, "the cap of the stretch before does not cut this one");
	await standing(s, "held");
	await poll(s, false);
	await until(() => world.pis.size === 2, "the run");
});

test("R-F002: a held wake's timer begins no run before the wake's own time: a milestone waits its hold out after the boss's answering lapsed", async () => {
	const s = await setup();
	await poll(s, true);
	const text = `${header({ from: { name: "mp3946-print", id: "main-1", role: "main" }, kind: "call_tower", scope: "tower", to: [], reply: false, why: "milestone" })} the build is green`;
	tower().incoming(from, msg("m1", text));
	await until(() => readQueue(world.slot, "wA").some((e) => e.kind === "intercom" && !e.taken), "the milestone queued");
	assert.equal((await poll(s, true)).holding, true, "the boss is answering: the wake is held");
	clock.advance(12_000);
	await looks();
	assert.equal(world.pis.size, 0, "the hold lapsed 12 s in, but the milestone's own 30 s wait has not");
	clock.advance(19_000);
	await until(() => world.pis.size === 1, "the run at the milestone's own time");
});
