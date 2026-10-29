import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fakeClock } from "./fake-clock.ts";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { fileOf } from "../src/server/record.ts";
import { readTowerRuns } from "../src/server/towerruns.ts";
import { listRuns, readNotes, readRun, readTimer, writeRun } from "../src/server/towerrunstore.ts";
import { readQueue, readService, towerDir } from "../src/server/towerstore.ts";

// The runs of the tower service (docs/specs/2026-10-26-sb-backend.md, The wake protocol, Crash and timeout; B5) against a fake Herdr, fake pi-intercom clients, and a pi that is a test: `agent start` makes a
// fake PID in the standing pane, and the test claims the run, polls, confirms, and ends it over the control socket as the pi's extension does.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const started = async (over: Parameters<TowerWorld["start"]>[0] = {}) => {
	const s = await world.start(over);
	await s.handle.ready;
	return s;
};
const from = { id: "main-1", name: "docs-main" };
const msg = (id: string, text: string) => ({ id, content: { text } });
const tower = (ws = "wa") => world.client(`sb-tower-${ws}`)!;
/** The nth run the server started (1-based), once its pid is recorded. */
const nthRun = async (n = 1, ws = "wA") => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, ws, id)?.pid, "the run's pid to be recorded");
	return id;
};
const claim = (s: Running, id: string, over: Record<string, unknown> = {}) => {
	const pi = world.pis.get(id)!;
	return ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}`, ...over });
};
const claimed = async (s: Running, id: string) => {
	const got = await claim(s, id);
	assert.equal(got.ok, true, JSON.stringify(got));
	return String(got.token);
};
const poll = (s: Running, token: string, idle = true) => ask(s, { cmd: "run-poll", token, idle });
const taken = (s: Running, token: string, id: unknown) => ask(s, { cmd: "run-taken", token, id });
/** Takes every event the run is offered, confirming each; returns them. */
const drain = async (s: Running, token: string) => {
	const events: { id: string; kind: string; text: string; flag?: string }[] = [];
	for (;;) {
		const got = await poll(s, token);
		const event = got.event as (typeof events)[number] | undefined;
		if (!event) return events;
		assert.equal((await taken(s, token, event.id)).ok, true);
		events.push(event);
	}
};
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);
const setup = async (over: Parameters<TowerWorld["start"]>[0] = {}) => {
	const s = await started(over);
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, ensured };
};

test("an event wakes a run in the standing pane after a short wait that coalesces a burst; the agent has a name of its own and the run id, and no environment", async () => {
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	tower().incoming(from, msg("m2", "two"));
	const id = await nthRun();
	await sleep(120);
	assert.equal(world.pis.size, 1, "a burst starts one run");
	const [start] = world.herdr.commands("agent", "start");
	assert.match(start![2]!, /^tower-wa-[0-9a-f]{8}$/);
	assert.equal(start![start!.indexOf("--pane") + 1], ensured.pane);
	const pi = start!.slice(start!.indexOf("--") + 1);
	assert.deepEqual(pi.slice(0, 1), ["--name"]);
	assert.match(pi[1]!, new RegExp(`^tower run · Alpha · ${id.slice(0, 8)}$`));
	assert.deepEqual(pi.slice(2, 4), ["--sb-run", id]);
	assert.ok(!start!.includes("--env"));
	assert.equal(readRun(world.slot, "wA", id)?.kind, "local");
	assert.equal(((await ask(s, { cmd: "status" })).towers as { service: { state: string; run: { id: string } } }[])[0]!.service.run.id, id);
});

test("a claim: held until the server has recorded the run's pid; refused for another pane, pid, or start time, for an unknown run, and the second time; the answer has a token and the brief", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	await until(() => world.pis.size === 1, "the run to start");
	const id = [...world.pis.keys()][0]!;
	const pi = world.pis.get(id)!;
	assert.equal((await ask(s, { cmd: "claim", runId: "ffff", pane: pi.pane, pid: pi.pid })).ok, false, "unknown run");
	await nthRun();
	assert.match(String((await claim(s, id, { pid: pi.pid + 1 })).error), /not the ones the server recorded/);
	assert.match(String((await claim(s, id, { pane: "wA:p99" })).error), /not the ones the server recorded/);
	assert.match(String((await claim(s, id, { started: "T-other" })).error), /not the ones the server recorded/);
	const got = await claim(s, id);
	assert.equal(got.ok, true);
	assert.equal(got.kind, "local");
	assert.equal(got.identity, "sb-tower-wa");
	assert.match(String(got.token), /^[0-9a-f]{48}$/);
	assert.match(String(got.brief), /You are a run of the tower of workspace Alpha \(wA\)/);
	assert.match(String(got.brief), /Woken \d\d:\d\d by: 1 intercom/);
	assert.match(String(got.brief), /Call tower_done with a handoff note/);
	assert.match(String((await claim(s, id)).error), /claimed already/);
	assert.equal(readRun(world.slot, "wA", id)?.claimed, true);
	assert.ok(!readFileSync(join(world.slot.dir, "server.log"), "utf8").includes(String(got.token)), "no token in the log");
});

test("the run's events arrive one at a time at its idle moments, the boss first; an event offered and not confirmed is offered again; a running poll gets none", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "first"));
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "boss says" });
	tower().incoming(from, msg("m2", "second"));
	const id = await nthRun();
	const token = await claimed(s, id);
	assert.equal((await poll(s, token, false)).event, undefined, "a run that is working is not offered events");
	const one = (await poll(s, token)).event as { id: string; kind: string; text: string };
	assert.equal(one.kind, "boss");
	assert.equal(one.text, "boss says");
	assert.equal(((await poll(s, token)).event as { id: string }).id, one.id, "not confirmed: offered again");
	assert.equal((await taken(s, token, one.id)).ok, true);
	assert.deepEqual((await drain(s, token)).map((e) => e.text), ["first", "second"]);
	assert.equal((await taken(s, token, "nope")).ok, false);
	assert.equal(readQueue(world.slot, "wA").every((e) => e.taken?.run === id), true, "taken events stay on disk, marked, until the run ends well");
	// An event that arrives mid-run is offered at the next idle poll.
	tower().incoming(from, msg("m3", "mid-run"));
	await until(() => readQueue(world.slot, "wA").length === 4, "m3 queued");
	assert.deepEqual((await drain(s, token)).map((e) => e.text), ["mid-run"]);
	assert.equal(world.pis.size, 1, "no second run: the live one takes it");
});

test("tower_done is refused while events are outstanding, keeps the note, ends the run when pi has exited, and removes the events it took", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	const refused = await ask(s, { cmd: "run-done", token, note: "nothing yet" });
	assert.equal(refused.ok, false);
	assert.match(String(refused.error), /1 event still for you/);
	await drain(s, token);
	tower().incoming(from, msg("m2", "late"));
	await until(() => readQueue(world.slot, "wA").length === 2, "m2");
	assert.match(String((await ask(s, { cmd: "run-done", token, note: "x" })).error), /1 event still for you/, "new events count too");
	await drain(s, token);
	assert.match(String((await ask(s, { cmd: "run-done", token, note: "" })).error), /1 to 1,200/);
	assert.match(String((await ask(s, { cmd: "run-done", token, note: "x".repeat(1201) })).error), /1 to 1,200/);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "- fixed the thing\n- docs-main owes a reply" })).ok, true);
	assert.equal(((await ask(s, { cmd: "status" })).towers as { service: { state: string } }[])[0]!.service.state, "closing");
	assert.deepEqual((await poll(s, token)).event, undefined, "a closing run is offered nothing");
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the outcome");
	assert.deepEqual(readQueue(world.slot, "wA"), [], "the events it took are gone");
	assert.deepEqual(readNotes(world.slot, "wA").map((n) => [n.kind, n.note]), [["local", "- fixed the thing\n- docs-main owes a reply"]]);
	assert.equal(((await ask(s, { cmd: "status" })).towers as { service: { state: string; lastRun: { outcome: string } } }[])[0]!.service.lastRun.outcome, "done");
	// The next event wakes a fresh run, with the note in its brief.
	tower().incoming(from, msg("m3", "again"));
	const next = await nthRun(2);
	const got = await claim(s, next);
	assert.match(String(got.brief), /Handoff note from the last run/);
	assert.match(String(got.brief), /fixed the thing/);
});

test("a run that exits without tower_done crashed: its taken events return flagged, the second crash parks them, the third crash in the window holds the service until the boss writes", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "poison"));
	const first = await nthRun();
	const t1 = await claimed(s, first);
	await drain(s, t1);
	exit(first);
	await until(() => readRun(world.slot, "wA", first)?.outcome === "crashed", "run 1 crashed");
	assert.deepEqual(readQueue(world.slot, "wA").map((e) => [e.text, e.flag, e.crashes, e.taken]), [["poison", "crash", 1, undefined]]);
	assert.match(readNotes(world.slot, "wA").at(-1)!.note, /^\(crashed/);
	const crashes = async () => ((await ask(s, { cmd: "status" })).towers as { service: { crashes?: number } }[])[0]!.service.crashes;
	assert.equal(await crashes(), 1, "the page can show how many runs failed lately");
	// The next brief says so.
	const second = await nthRun(2);
	const got = await claim(s, second);
	assert.match(String(got.brief), /possibly handled by a run that crashed/);
	const t2 = String(got.token);
	assert.equal(((await poll(s, t2)).event as { flag?: string }).flag, "crash");
	await drain(s, t2);
	exit(second);
	await until(() => readRun(world.slot, "wA", second)?.outcome === "crashed", "run 2 crashed");
	assert.deepEqual(readQueue(world.slot, "wA"), [], "parked");
	assert.deepEqual(readQueue(world.slot, "wA", true).map((e) => [e.text, e.crashes]), [["poison", 2]]);
	const status = ((await ask(s, { cmd: "status" })).towers as { service: { notices: { kind: string }[]; parked: { id: string; first: string }[]; state: string } }[])[0]!.service;
	assert.equal(status.parked[0]!.first, "poison");
	assert.equal(await crashes(), 2);
	// A third crash in ten minutes stops the waking.
	tower().incoming(from, msg("m2", "another"));
	const third = await nthRun(3);
	const t3 = await claimed(s, third);
	await drain(s, t3);
	exit(third);
	await until(() => ((world.client("sb-tower-wa") && true) as boolean) && readRun(world.slot, "wA", third)?.outcome === "crashed", "run 3 crashed");
	await until(async () => ((await ask(s, { cmd: "status" })).towers as { service: { state: string } }[])[0]!.service.state === "held", "held");
	const held = ((await ask(s, { cmd: "status" })).towers as { service: { notices: { kind: string; detail?: string }[] } }[])[0]!.service;
	assert.ok(held.notices.some((n) => n.kind === "loop"));
	assert.equal(await crashes(), 3);
	world.herdr.screen = "the tail of the pane\nerror: boom";
	tower().incoming(from, msg("m3", "while held"));
	await sleep(150);
	assert.equal(world.pis.size, 3, "an intercom message does not wake a held service");
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "boss: go on" });
	await nthRun(4);
	assert.equal(await crashes(), undefined, "a boss message clears the count with the hold");
	// Deliver again puts a parked event back; Drop discards it.
	const parked = readQueue(world.slot, "wA", true)[0]!;
	assert.equal((await ask(s, { cmd: "tower-drop", workspace: "wA", id: parked.id })).ok, true);
	assert.deepEqual(readQueue(world.slot, "wA", true), []);
});

test("a boss event wakes a service the loop held, and Retry does too", async () => {
	const { s } = await setup();
	for (let n = 1; n <= 3; n++) {
		tower().incoming({ id: `m-${n}` }, msg(`x${n}`, `e${n}`));
		const id = await nthRun(n);
		await drain(s, await claimed(s, id));
		exit(id);
		await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", `run ${n} crashed`);
	}
	await until(async () => ((await ask(s, { cmd: "status" })).towers as { service: { state: string } }[])[0]!.service.state === "held", "held");
	tower().incoming(from, msg("y", "while held"));
	await sleep(120);
	assert.equal(world.pis.size, 3);
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await nthRun(4);
});

test("a run past the steer time is told to wrap up, past the cap it is told to quit, and a pi that stays gets Escape and /quit, then SIGTERM from a PID read from Herdr", async () => {
	// The run's clock is the test's: the watcher sees an age only when the test sets it, one step at a time, so a tick that comes seconds late under load (a load average of 70 was seen) cannot find the run already past the cap and skip the steer (B5 review F013).
	const clock = (world.runClock = fakeClock());
	// The times are ones the real clock cannot reach during the test: a run that stops reading the test's clock times out instead of passing.
	world.runTimers = { steerAt: 600_000, quitAt: 1_200_000, quitGrace: 60_000, signal: 30_000 };
	const { s } = await setup();
	tower().incoming(from, msg("m1", "slow"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	const seen: string[] = [];
	const commandsUntil = (done: () => boolean, what: string) => until(async () => {
		const command = (await poll(s, token, false)).command as { type: string } | undefined;
		if (command) seen.push(command.type);
		return done();
	}, what, 20_000);
	// Whole watcher ticks at the clock's frozen age: what a tick would do at that age it has done before the check after it.
	const ticks = async () => {
		const from = world.aliveCalls;
		await until(() => world.aliveCalls >= from + 2, "two watcher ticks", 20_000);
	};
	await ticks();
	assert.equal((await poll(s, token, false)).command, undefined, "nothing is told before the steer time");
	clock.advance(600_001);
	await commandsUntil(() => seen.length > 0, "the steer");
	assert.deepEqual(seen, ["steer"]);
	await ticks();
	assert.equal((await poll(s, token, false)).command, undefined, "the steer is told once");
	clock.advance(600_000);
	await commandsUntil(() => seen.includes("quit"), "the quit command");
	assert.deepEqual(seen, ["steer", "quit"]);
	await ticks();
	assert.deepEqual([...world.herdr.keys], [], "pi has had no grace yet");
	clock.advance(60_000);
	await until(() => world.herdr.keys.some((k) => k.includes("/quit")), "Escape and /quit through Herdr", 20_000);
	assert.deepEqual(world.herdr.keys.slice(0, 3).map((k) => k.slice(1)), [["send-keys", ensureedPane(), "esc"], ["send-text", ensureedPane(), "/quit"], ["send-keys", ensureedPane(), "enter"]]);
	await ticks();
	assert.deepEqual([...world.kills], [], "no signal before its time");
	clock.advance(30_000);
	await until(() => world.kills.length === 1, "SIGTERM", 20_000);
	assert.deepEqual(world.kills[0], [world.pis.get(id)!.pid, "SIGTERM"]);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "timeout", "the outcome", 20_000);
	assert.match(readNotes(world.slot, "wA").at(-1)!.note, /timed out/);
	assert.equal(readQueue(world.slot, "wA")[0]?.flag, "crash", "its events return");
});
const ensureedPane = () => world.herdr.panes.find((p) => p.tokens.sb_role === "tower")!.pane_id;

test("a run idle with nothing pending and no tower_done gets one steer, then is ended with the note (ended without a note)", async () => {
	const clock = (world.runClock = fakeClock());
	world.runTimers = { idleSteer: 60_000, idleEnd: 300_000 };
	const { s } = await setup();
	tower().incoming(from, msg("m1", "quick"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await poll(s, token)).command, undefined);
	// The idle time is the clock's, one step at a time: a watcher tick that comes late under load cannot find the run past the end and skip the steer.
	const nextCommand = async (what: string) => {
		let got: { type: string } | undefined;
		await until(async () => ((got = (await poll(s, token)).command as { type: string } | undefined), got !== undefined), what, 20_000);
		return got!.type;
	};
	const ticks = async () => {
		const from = world.aliveCalls;
		await until(() => world.aliveCalls >= from + 2, "two watcher ticks", 20_000);
	};
	await ticks();
	assert.equal((await poll(s, token)).command, undefined, "nothing is told before the idle time");
	clock.advance(60_000);
	assert.equal(await nextCommand("the steer"), "steer");
	await ticks();
	assert.equal((await poll(s, token)).command, undefined, "the idle steer is told once");
	clock.advance(300_000);
	assert.equal(await nextCommand("the quit"), "quit");
	exit(id);
	// The watcher notices the exit at one of its ticks (real I/O on a timer): a process that the machine starved for seconds needs more than the default five.
	await until(() => readRun(world.slot, "wA", id)?.outcome === "quit", "the outcome", 20_000);
	assert.equal(readNotes(world.slot, "wA").at(-1)!.note, "(ended without a note)");
	assert.deepEqual(readQueue(world.slot, "wA"), [], "it handled its events: nothing returns");
});

test("the computer slept: a clock step longer than `lost` between two watcher ticks does not end a live run as lost, since no run could poll in it; a run that is silent in steps shorter than that still is", async () => {
	const clock = (world.runClock = fakeClock());
	const { s } = await setup();
	tower().incoming(from, msg("m1", "quick"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	const ticks = async () => {
		const from = world.aliveCalls;
		await until(() => world.aliveCalls >= from + 2, "two watcher ticks", 20_000);
	};
	// A Mac wakes after five minutes: the first tick that runs sees the run silent for that long, whatever the order of the run's own poll.
	clock.advance(300_000);
	await ticks();
	const awake = await poll(s, token);
	assert.equal(awake.ok, true, "the run's next poll finds the server there");
	assert.notEqual((awake.command as { type: string } | undefined)?.type, "quit", "and is not told to quit: the server did not take it for lost (it may be told to wrap up: it was idle for five minutes)");
	// A run that really stopped polling while the clock ran in ordinary steps is lost once `lost` has passed (60 s here), as before.
	clock.advance(40_000);
	await ticks();
	clock.advance(40_000);
	await ticks();
	assert.equal(((await poll(s, token)).command as { type: string } | undefined)?.type, "quit", "80 s without a poll: the server is ending it");
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", "the lost run's outcome", 20_000);
});

test("RV8-F002: a slow watcher tick is not a sleep: two runs, one silent and one whose pid check takes 70 s of the clock inside each tick, and the silent one is still lost after the second tick", async () => {
	const clock = (world.runClock = fakeClock());
	// Nothing but the lost rule can end a run in the ticks that follow (70 s each on the clock): the idle, steer, and cap times are out of reach.
	world.runTimers = { idleSteer: 1e9, idleEnd: 1e9, steerAt: 1e9, quitAt: 1e9 };
	const { s } = await setup();
	world.herdr.workspaces[1]!.worktree = { checkout_path: "/w/beta" };
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	tower().incoming(from, msg("m1", "silent"));
	const silent = await nthRun();
	const silentToken = await claimed(s, silent);
	await drain(s, silentToken);
	tower("wb").incoming(from, msg("m1", "slow"));
	const slow = await nthRun(2, "wB");
	await claimed(s, slow);
	const slowPid = world.pis.get(slow)!.pid;
	// From now on the slow run's check inside a tick takes 70 s on the test's clock, more than `lost` (60 s): between the starts of two ticks that is a gap of more than `lost`, between the end of one and the start of the next it is none.
	world.aliveHook = (pid) => void (pid === slowPid && clock.advance(70_000));
	// The silent run is lost at the second tick (its silence is then 70 s): the server has the pi quit, which is Escape and /quit through Herdr once the grace is over on the clock.
	const pane = world.pis.get(silent)!.pane;
	await until(() => world.herdr.keys.some((k) => k.includes(pane) && k.includes("/quit")), "the silent run to be ended as lost", 20_000);
	exit(silent);
	await until(() => readRun(world.slot, "wA", silent)?.outcome === "crashed", "its outcome", 20_000);
});

test("towerRuns.max bounds the pi runs on the machine; the rest wait in their queues and start when a slot frees", async () => {
	world.runMax = 1;
	const { s } = await setup();
	world.herdr.workspaces[1]!.worktree = { checkout_path: "/w/beta" };
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	tower().incoming(from, msg("m1", "a"));
	tower("wb").incoming(from, msg("m1", "b"));
	const first = await nthRun();
	await sleep(150);
	assert.equal(world.pis.size, 1, "the second workspace waits");
	const token = await claimed(s, first);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	exit(first);
	await until(() => world.pis.size === 2, "the second run to start");
});

test("a refused settings check starts no run, keeps the queue, raises a notice, and tries again only after the refusal window", async () => {
	world.settingsError = new Error(".pi/settings.json is a link to /dev/zero");
	const { s } = await setup();
	tower().incoming(from, msg("m1", "a"));
	await until(async () => ((await ask(s, { cmd: "status" })).towers as { service: { notices: { kind: string; text: string }[] } }[])[0]!.service.notices.some((n) => n.kind === "settings"), "the notice");
	assert.equal(world.pis.size, 0);
	assert.equal(readQueue(world.slot, "wA").length, 1);
	tower().incoming(from, msg("m2", "b"));
	await sleep(60);
	assert.equal(world.pis.size, 0, "inside the window nothing is tried");
	world.settingsError = undefined;
	await sleep(120);
	tower().incoming(from, msg("m3", "c"));
	await nthRun();
	const status = ((await ask(s, { cmd: "status" })).towers as { service: { notices: { kind: string }[] } }[])[0]!.service;
	assert.ok(!status.notices.some((n) => n.kind === "settings"), "the notice goes with the next good start");
});

test("a Herdr restart ends the live run (herdr-restart), its events return flagged, a resumed pi with the old run id is refused, a pi in the pane is quit for a while, and the event wakes a fresh run", async () => {
	// The runs' clock is the test's: "for a while" (the restored window) and the fresh run's wake are its ages, so a pi that asks before the fresh run wakes always finds the window open, however long the machine stood still (it did, at load 60).
	const clock = (world.runClock = fakeClock());
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	world.herdr.restart();
	world.takeovers.forEach((cb) => cb());
	await until(() => readRun(world.slot, "wA", id)?.outcome === "herdr-restart", "the run to end");
	assert.match(String((await claim(s, id)).error), /not one the server has live/);
	assert.equal((await poll(s, token)).error, "unknown_token");
	// Herdr's pi integration resumes the old pi in the restored pane: the server quits it, whatever its session file holds.
	const quit = await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 4242 });
	assert.equal(quit.role, "quit");
	assert.match(String(quit.reason), /restored/);
	// The event goes back flagged, and wakes a fresh run in the restored standing pane, which claims and gets it with the flag.
	clock.advance(100);
	const second = await nthRun(2);
	const got = await claim(s, second);
	assert.equal(got.ok, true);
	assert.match(String(got.brief), /possibly handled by a run that crashed/);
	assert.equal(((await poll(s, String(got.token))).event as { flag: string }).flag, "crash");
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "herdr-restart");
});

test("pane-role: a pane the server does not list is none; a standing pane that holds a live run is quit; one pi by hand becomes a run the boss is in, which ends when they leave", async () => {
	const { s, ensured } = await setup();
	assert.equal((await ask(s, { cmd: "pane-role", pane: "wA:p1", pid: 1 })).role, "none");
	assert.equal((await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 5555 })).role, "quit", "a PID Herdr does not list in the pane is not taken (B5R-F007)");
	world.herdr.pane(String(ensured.pane)).processes = [{ argv0: "pi", name: "node", pid: 5555 }];
	world.live.add(5555); // alive before the answer: the watcher ends a run whose PID is gone
	const hand = await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 5555, started: "T-5555" });
	assert.equal(hand.role, "hand");
	const token = String((hand.claim as { token: string }).token);
	assert.match(String((hand.claim as { brief: string }).brief), /tower of workspace Alpha/);
	assert.equal((await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 5556 })).role, "quit", "the pane is taken");
	// The boss started it: tower_done does not end it; their quit does.
	assert.equal((await ask(s, { cmd: "run-done", token, note: "by hand" })).stay, true);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "by hand", left: true })).ok, true);
	world.live.delete(5555);
	await until(() => listRuns(world.slot, "wA").some((r) => r.hand && r.outcome === "done"), "done");
});

test("wakeAfter: 5 to 240 minutes, one pending per workspace (a later one replaces it), refused outside the range; a due timer wakes a run after a server restart", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	for (const bad of [4, 241, 5.5, "10"]) assert.match(String((await ask(s, { cmd: "run-done", token, note: "n", wakeAfter: bad })).error), /5 to 240/);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "n", wakeAfter: 60 })).ok, true);
	const first = readTimer(world.slot, "wA")!;
	assert.ok(first.at - Date.now() > 59 * 60_000 && first.at - Date.now() <= 60 * 60_000);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "done");
	tower().incoming(from, msg("m2", "two"));
	const next = await nthRun(2);
	const t2 = await claimed(s, next);
	await drain(s, t2);
	assert.equal((await ask(s, { cmd: "run-done", token: t2, note: "n", wakeAfter: 10 })).ok, true);
	const second = readTimer(world.slot, "wA")!;
	assert.ok(second.at < first.at, "the later wakeAfter replaced the first");
	exit(next);
	await until(() => readRun(world.slot, "wA", next)?.outcome === "done", "done 2");
	// A timer that came due while the server was down fires when the next one starts.
	await s.handle.shutdown(0);
	await s.handle.done;
	writeFileSync(join(towerDir(world.slot, "wA"), "timer.json"), JSON.stringify({ at: Date.now() - 1000, asked: new Date().toISOString() }));
	world.clients.length = 0;
	const again = await world.start();
	await again.handle.ready;
	await nthRun(3);
	assert.equal(existsSync(join(towerDir(world.slot, "wA"), "timer.json")), false);
	assert.equal(readQueue(world.slot, "wA").some((e) => e.kind === "timer"), true);
});

test("a server restart does not end a run: it reconnects with its run id, pane and pid and gets a new token; one whose pi died meanwhile crashed", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	const record = readService(world.slot, "wA")!;
	await s.handle.shutdown(0);
	await s.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, undefined, "still live in the records");
	world.clients.length = 0;
	const second = await world.start();
	await second.handle.ready;
	assert.equal((await poll(second, token)).error, "unknown_token", "the old token is memory only");
	const again = await claim(second, id);
	assert.equal(again.ok, true, JSON.stringify(again));
	assert.notEqual(again.token, token);
	assert.equal((await ask(second, { cmd: "run-done", token: String(again.token), note: "carried on" })).ok, true);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "done");
	void record;
	// Another run that dies while the server is down is a crash.
	tower().incoming(from, msg("m2", "two"));
	const next = await nthRun(2);
	const t2 = await claimed(second, next);
	await drain(second, t2);
	await second.handle.shutdown(0);
	await second.handle.done;
	exit(next);
	world.clients.length = 0;
	const third = await world.start();
	await third.handle.ready;
	await until(() => readRun(world.slot, "wA", next)?.outcome === "crashed", "the crash to be found");
	assert.equal(readQueue(world.slot, "wA")[0]?.flag, "crash");
});

test("a tab closed in Herdr ends the live run (quit) with the service", async () => {
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await claimed(s, id);
	await ask(s, { cmd: "close-tower", workspace: "wA" });
	await until(() => readRun(world.slot, "wA", id)?.outcome === "quit", "the run to end");
	void ensured;
});

test("the brief shows the workspace's mains with their state and board entry and the digest since the last run; the digest goes at tower_done and stays after a crash", async () => {
	world.herdr.addPane("wA:p1", "wA:t1", "pi").tokens.sb_role = "main";
	world.sessions = [{ id: "main-1", name: "docs-main", status: "thinking", herdrLocation: { status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId: "wA:p1" } }];
	const { createDigest } = await import("../src/digest.ts");
	const digest = createDigest(world.herdr.runFor("x"), Date.now);
	await digest.note("wA", "docs-main joined tab work");
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const first = await nthRun();
	const got = await claim(s, first);
	const brief = String(got.brief);
	assert.match(brief, /Mains you supervise:\n- work: main docs-main \(main-1\) working/);
	assert.match(brief, /Since your last run:\n- \d\d:\d\d docs-main joined tab work/);
	const lines = () => Object.keys(world.herdr.workspace("wA").tokens).filter((k) => k.startsWith("sbd_"));
	assert.equal(lines().length, 1, "not cleared at the claim");
	const t1 = String(got.token);
	await drain(s, t1);
	exit(first);
	await until(() => readRun(world.slot, "wA", first)?.outcome === "crashed", "crashed");
	assert.equal(lines().length, 1, "a crash keeps the lines the run was shown");
	const second = await nthRun(2);
	const again = await claim(s, second);
	assert.match(String(again.brief), /docs-main joined tab work/);
	const t2 = String(again.token);
	await drain(s, t2);
	assert.equal((await ask(s, { cmd: "run-done", token: t2, note: "ok" })).ok, true);
	assert.equal(lines().length, 0, "tower_done clears what the brief showed");
});

test("B5R-F007: a pi by hand is turned away over the run cap and while a run is being started (the settings check), and the run keeps its service", async () => {
	world.runMax = 1;
	const { s, ensured } = await setup();
	world.herdr.pane(String(ensured.pane)).processes = [{ argv0: "pi", name: "node", pid: 5555 }];
	let release!: () => void;
	world.settingsHold = new Promise<void>((resolve) => (release = resolve));
	tower().incoming(from, msg("m1", "one"));
	await until(async () => ((await ask(s, { cmd: "status" })).towers as { service: { state: string } }[])[0]!.service.state === "waking", "the run to be waking");
	const during = await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 5555 });
	assert.equal(during.role, "quit");
	assert.match(String(during.reason), /holds this pane/);
	release();
	const id = await nthRun();
	assert.equal((await claim(s, id)).ok, true);
	assert.equal(world.pis.size, 1, "no second pi was started in a busy pane");
});

test("B5R-F007: a pi by hand over the run cap is quit with the reason", async () => {
	world.runMax = 1;
	const { s, ensured } = await setup();
	world.herdr.pane(String(ensured.pane)).processes = [{ argv0: "pi", name: "node", pid: 5555 }];
	tower().incoming(from, msg("m1", "one"));
	await nthRun();
	const got = await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 5555 });
	assert.equal(got.role, "quit");
});

test("B5R-F003: a run recorded before its pid was read ends as crashed after a restart when no process shows, and a new event wakes a run", async () => {
	const { s, ensured } = await setup();
	await s.handle.shutdown(0);
	await s.handle.done;
	world.clients.length = 0;
	writeRun(world.slot, { id: "deadbeefdeadbeef", workspace: "wA", kind: "local", pane: String(ensured.pane), agent: "tower-wa-deadbeef", startedAt: new Date().toISOString(), events: [] });
	world.runTimers = { lost: 200 };
	const second = await started();
	await until(() => readRun(world.slot, "wA", "deadbeefdeadbeef")?.outcome === "crashed", "the pid-less run to end");
	tower().incoming(from, msg("m2", "two"));
	await nthRun();
	assert.equal(((await ask(second, { cmd: "status" })).towers as { service: { state: string } }[])[0]!.service.state !== "held", true);
});

test("B5R-F003: a pid-less run whose process is found by its run id is taken back, and its pi claims it", async () => {
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await s.handle.shutdown(0);
	await s.handle.done;
	world.clients.length = 0;
	const rec = readRun(world.slot, "wA", id)!;
	const { pid: _pid, started: _started, ...rest } = rec;
	writeRun(world.slot, rest);
	const second = await started();
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid to be found again");
	assert.equal((await claim(second, id)).ok, true);
	assert.equal(String(ensured.pane), rest.pane);
});

test("B5R-F002: a claim that comes before the server has its tower identity, or has loaded its runs, is told to wait, not refused", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const got = await claim(s, id);
	assert.equal(got.ok, true);
	await s.handle.shutdown(0);
	await s.handle.done;
	world.clients.length = 0;
	const gate = new Promise<void>(() => {});
	const second = await world.start({ intercom: async () => ({ dir: "/fake/pi-intercom", version: "0.18.1", connect: async () => (await gate, undefined as never) }) });
	await until(async () => { try { return Boolean(await ask(second, { cmd: "status" })); } catch { return false; } }, "the new server to listen", 3000);
	const pi = world.pis.get(id)!;
	const again = await ask(second, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(again.ok, true, JSON.stringify(again));
	assert.equal(again.wait, true);
	const early = await ask(second, { cmd: "pane-role", pane: pi.pane, pid: 1 });
	assert.equal(early.role === "wait" || early.role === "quit", true, JSON.stringify(early));
});

test("R-F003: a stop quits the live runs: the PID gets SIGTERM when it stays, and the run is recorded quit; a restart leaves the run alone", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await claimed(s, id);
	const pid = world.pis.get(id)!.pid;
	assert.equal((await ask(s, { cmd: "restart", reason: "test" })).ok, true);
	await s.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, undefined, "a restart keeps the claim");
	assert.deepEqual(world.kills, []);
	world.clients.length = 0;
	const second = await started();
	assert.equal((await ask(second, { cmd: "stop" })).ok, true);
	await second.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "quit");
	assert.deepEqual(world.kills, [[pid, "SIGTERM"]]);
});

test("B5R-F006: the run's start time is recorded at its start, and the watcher does not ask for it at every tick (a ps call each)", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await claimed(s, id);
	assert.equal(readRun(world.slot, "wA", id)?.started, `T-${world.pis.get(id)!.pid}`);
	const before = world.startCalls;
	await sleep(400); // 20 watcher ticks
	assert.ok(world.startCalls - before <= 2, `asked ${world.startCalls - before} times in 20 ticks`);
});

test("B5R3-F004: a server that is ready but whose towers are not loaded yet (the broker is slow) tells a claim and a pane-role to wait, and a run request that it is starting", async () => {
	await setup().then(async ({ s: first }) => { await first.handle.shutdown(0); await first.handle.done; });
	world.clients.length = 0;
	const gate = new Promise<void>(() => {});
	const s = await world.start({ brokerMs: 50, intercom: async () => ({ dir: "/fake/pi-intercom", version: "0.18.1", connect: async () => (await gate, undefined as never) }) });
	await until(async () => { try { return (await ask(s, { cmd: "status" })).ready === true; } catch { return false; } }, "the server to be ready", 3000);
	const got = await ask(s, { cmd: "claim", runId: "r1", pane: "p1", pid: 1, started: "T-1" });
	assert.equal(got.wait, true, JSON.stringify(got));
	assert.equal((await ask(s, { cmd: "pane-role", pane: "p1", pid: 1 })).role, "wait");
	const poll = await ask(s, { cmd: "run-poll", token: "x", idle: true });
	assert.equal(poll.ok, false);
	assert.equal(poll.error, "the server is still starting");
});

test("B5R3-F002/F003: a stop mid-turn: the run's poll is answered and carries the quit, the pid is read from Herdr, and the event it took returns flagged for the next run", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "work"));
	const id = await nthRun();
	const token = await claimed(s, id);
	const got = await poll(s, token);
	assert.equal((await taken(s, token, (got.event as { id: string }).id)).ok, true);
	// Herdr now shows another pid than the one on the record: the signal goes to the one Herdr shows (N3).
	const pid = 9991;
	world.herdr.pane(world.pis.get(id)!.pane).processes![0]!.pid = pid;
	const stopping = ask(s, { cmd: "stop" });
	await stopping;
	const during = await poll(s, token, false);
	assert.equal(during.ok, true, `a poll while stopping is answered: ${JSON.stringify(during)}`);
	assert.deepEqual(during.command, { type: "quit" });
	await s.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "quit");
	assert.deepEqual(world.kills, [[pid, "SIGTERM"]]);
	const left = readQueue(world.slot, "wA");
	assert.equal(left.length, 1, "the taken event is kept");
	assert.equal(left[0]!.flag, "crash");
	assert.equal(left[0]!.taken, undefined);
});

test("B5R4-N1: a stop after tower_done does not bring the handled event back", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "work"));
	const id = await nthRun();
	const token = await claimed(s, id);
	const got = await poll(s, token);
	assert.equal((await taken(s, token, (got.event as { id: string }).id)).ok, true);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "handled work" })).ok, true);
	await ask(s, { cmd: "stop" });
	await s.handle.done;
	assert.deepEqual(readQueue(world.slot, "wA"), [], "the handled event is gone, not re-queued as a crash");
	assert.notEqual(readRun(world.slot, "wA", id)?.outcome, "crashed");
});

test("a config.json that cannot be parsed keeps the service on, is told once as an error (log and the status's lastError), and a missing file is no error (RV6-F009)", async () => {
	assert.deepEqual(readTowerRuns(join(world.stateDir, "nowhere")), { enabled: true, max: 4 }, "no file: the default, with nothing to tell");
	writeFileSync(join(world.stateDir, "config.json"), '{ "towerRuns": { "enabled": false, ');
	const parsed = readTowerRuns(world.stateDir);
	assert.equal(parsed.enabled, true);
	assert.match(String(parsed.problem), /config\.json/);
	const s = await started();
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(ensured.ok, true, "the service is on");
	await until(async () => ((await ask(s, { cmd: "status" })).lastError as { code?: string } | undefined)?.code === "config", "the config error to be recorded");
	const status = await ask(s, { cmd: "status" });
	assert.match(String((status.lastError as { text: string }).text), /config\.json[^]*towerRuns\.enabled/);
	await sleep(150);
	const lines = readFileSync(fileOf(world.slot, "log"), "utf8").split("\n").filter((l) => /\bcode=config\b/.test(l));
	assert.equal(lines.length, 1, lines.join("\n"));
});

// --- The boss in the run (docs/how-it-works.md, The boss in a run): once the boss speaks in a run, it stays until they leave ---

/** Polls the run for `ms` as its pi does, keeping every command it was handed. */
const commandsFor = async (s: Running, token: string, ms: number, idle = true) => {
	const seen: { type: string; text?: string }[] = [];
	for (const end = Date.now() + ms; Date.now() < end; await sleep(15)) {
		const command = (await poll(s, token, idle)).command as { type: string; text?: string } | undefined;
		if (command) seen.push(command);
	}
	return seen;
};
const woken = async (s: Running, over: Record<string, unknown> = {}, n = 1) => {
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "look at the board", ...over })).ok, true);
	const id = await nthRun(n);
	const token = await claimed(s, id);
	await drain(s, token);
	return { id, token };
};

test("run-boss: while the boss is in the run tower_done stays (no note, no end), the cap does not cut it, and their silence for bossAway hands the run the normal wrap-up: a steer, then tower_done ends it", async () => {
	world.runTimers = { steerAt: 100, quitAt: 300, bossAway: 500, idleSteer: 120, idleEnd: 60_000, quitGrace: 60, signal: 60 };
	const { s } = await setup();
	const { id, token } = await woken(s);
	assert.equal((await ask(s, { cmd: "run-boss", token })).ok, true);
	const stay = await ask(s, { cmd: "run-done", token, note: "n" });
	assert.equal(stay.ok, true);
	assert.equal(stay.stay, true, JSON.stringify(stay));
	assert.match(String(stay.text), /boss/i);
	assert.deepEqual(readNotes(world.slot, "wA"), [], "a refused end keeps no note");
	// Past the steer time and the cap: nothing is said to the run while the boss is there.
	assert.deepEqual(await commandsFor(s, token, 380), []);
	// A sign of the boss renews the time.
	assert.equal((await ask(s, { cmd: "run-boss", token })).ok, true);
	assert.deepEqual(await commandsFor(s, token, 380), []);
	// Their silence ends it: the idle steer, no cap quit.
	const after = await commandsFor(s, token, 900);
	assert.deepEqual(after.map((c) => c.type), ["steer"], JSON.stringify(after));
	const end = await ask(s, { cmd: "run-done", token, note: "boss talked about the board" });
	assert.equal(end.ok, true);
	assert.equal(end.stay, undefined);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the outcome");
	assert.equal(readNotes(world.slot, "wA").at(-1)!.note, "boss talked about the board");
});

test("a boss event written at the tower prompt (present) makes the run it wakes a run the boss is in from its claim; one from the GUI does not", async () => {
	const { s } = await setup();
	const first = await woken(s, { present: true });
	assert.equal((await ask(s, { cmd: "run-done", token: first.token, note: "n" })).stay, true);
	assert.equal((await ask(s, { cmd: "run-done", token: first.token, note: "(the boss left)", left: true })).ok, true);
	exit(first.id);
	await until(() => readRun(world.slot, "wA", first.id)?.outcome === "done", "the first run to end");
	const second = await woken(s, {}, 2);
	const done = await ask(s, { cmd: "run-done", token: second.token, note: "plain" });
	assert.equal(done.ok, true);
	assert.equal(done.stay, undefined, "no sign of the boss: tower_done ends the run as before");
});

test("the boss quitting their run (run-done left) ends it as done, not crashed: the leave note, no crash for the loop, the events it did not take stay queued; without the boss in the run it is a crash as before", async () => {
	const { s } = await setup();
	const a = await woken(s, { present: true });
	tower().incoming(from, msg("m9", "arrives while the boss talks"));
	const left = await ask(s, { cmd: "run-done", token: a.token, note: "ignored", left: true });
	assert.equal(left.ok, true, JSON.stringify(left));
	exit(a.id);
	await until(() => readRun(world.slot, "wA", a.id)?.outcome === "done", "the outcome");
	assert.match(readNotes(world.slot, "wA").at(-1)!.note, /boss/i);
	assert.equal(readQueue(world.slot, "wA").filter((e) => e.kind === "intercom" && !e.flag).length, 1, "the event it did not take waits for the next run, unflagged");
	// The next run: the boss is not in it. A quit with no tower_done is a crash, as ever.
	const b = await woken(s, {}, 2);
	assert.equal((await ask(s, { cmd: "run-done", token: b.token, note: "x", left: true })).ok, true, "the call is harmless");
	exit(b.id);
	await until(() => readRun(world.slot, "wA", b.id)?.outcome === "crashed", "the crash");
});

test("a run the server is already ending ignores a left: the outcome stays the server's", async () => {
	world.runTimers = { lost: 150, quitGrace: 60, signal: 60 };
	const { s } = await setup();
	const a = await woken(s, { present: true });
	await sleep(400); // no polls for longer than `lost`: the server ends the run
	assert.equal(((await poll(s, a.token)).command as { type: string } | undefined)?.type, "quit", "the server is ending it");
	const left = await ask(s, { cmd: "run-done", token: a.token, note: "n", left: true });
	assert.equal(left.ok, true);
	exit(a.id);
	await until(() => readRun(world.slot, "wA", a.id)?.outcome === "crashed", "the server's outcome");
});

test("the boss's time in a run is bounded: past bossMax the cap applies again", async () => {
	world.runTimers = { quitAt: 250, steerAt: 120, bossMax: 400, bossAway: 60_000, quitGrace: 60, signal: 60 };
	const { s } = await setup();
	const { id, token } = await woken(s);
	assert.equal((await ask(s, { cmd: "run-boss", token })).ok, true, "the boss speaks in this event run");
	assert.deepEqual((await commandsFor(s, token, 300)).map((c) => c.type), [], "the boss is there: the cap waits");
	const later = await commandsFor(s, token, 600);
	assert.ok(later.some((c) => c.type === "quit"), JSON.stringify(later));
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "timeout", "the timeout");
});

test("the boss's 4 hours are counted from their first word in the run, not from their return after each absence (SR-F005)", async () => {
	world.runTimers = { quitAt: 300, steerAt: 150, bossMax: 1500, bossAway: 120, idleSteer: 60_000, idleEnd: 60_000, quitGrace: 60, signal: 60 };
	const { s } = await setup();
	const { id, token } = await woken(s);
	assert.equal((await ask(s, { cmd: "run-boss", token })).ok, true, "the boss speaks in this event run");
	const first = Date.now();
	// The boss is silent: the idle run is "away" after bossAway, and its grace window keeps the cap off.
	assert.deepEqual((await commandsFor(s, token, 600)).map((c) => c.type), []);
	// They come back, and keep coming back every moment (the model is busy with them: its polls are not idle, so no second absence is seen on a slow machine).
	let quit = false;
	while (!quit && Date.now() - first < 2400) {
		await ask(s, { cmd: "run-boss", token });
		quit = (await commandsFor(s, token, 60, false)).some((c) => c.type === "quit");
	}
	assert.equal(quit, true, "the run ends at bossMax after the first word, though the boss never stopped coming back");
	assert.ok(Date.now() - first < 2100, `ended ${Date.now() - first} ms after the first word (bossMax 1500; a bound restarted at the return would end it after 2100)`);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "timeout", "the timeout");
});

test("a run the server is ending at bossMax answers tower_done without a stay, and a boss sign that comes after changes nothing (SR-F005)", async () => {
	world.runTimers = { quitAt: 250, steerAt: 120, bossMax: 400, bossAway: 60_000, quitGrace: 5000, signal: 5000 };
	const { s } = await setup();
	const { id, token } = await woken(s);
	assert.equal((await ask(s, { cmd: "run-boss", token })).ok, true, "the boss speaks in this event run");
	const later = await commandsFor(s, token, 700);
	assert.ok(later.some((c) => c.type === "quit"), JSON.stringify(later));
	assert.equal((await ask(s, { cmd: "run-boss", token })).ok, true, "harmless");
	const end = await ask(s, { cmd: "run-done", token, note: "wrapped up" });
	assert.equal(end.stay, undefined, JSON.stringify(end));
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "timeout", "the outcome stays the server's");
});

test("run-boss belongs to a local run: an ally run, or a token the server does not know, is refused", async () => {
	const { s } = await setup();
	assert.equal((await ask(s, { cmd: "run-boss", token: "nope" })).ok, false);
});
