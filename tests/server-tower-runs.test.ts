import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { listRuns, readNotes, readRun, readTimer } from "../src/server/towerrunstore.ts";
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
	world.herdr.screen = "the tail of the pane\nerror: boom";
	tower().incoming(from, msg("m3", "while held"));
	await sleep(150);
	assert.equal(world.pis.size, 3, "an intercom message does not wake a held service");
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "boss: go on" });
	await nthRun(4);
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
	world.runTimers = { steerAt: 100, quitAt: 250, quitGrace: 60, signal: 60 };
	const { s } = await setup();
	tower().incoming(from, msg("m1", "slow"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	const seen: string[] = [];
	await until(async () => {
		const got = await poll(s, token, false);
		const command = got.command as { type: string; text?: string } | undefined;
		if (command) seen.push(command.type);
		return seen.includes("quit");
	}, "the quit command", 3000);
	assert.deepEqual(seen, ["steer", "quit"]);
	await until(() => world.herdr.keys.some((k) => k.includes("/quit")), "Escape and /quit through Herdr");
	assert.deepEqual(world.herdr.keys.slice(0, 3).map((k) => k.slice(1)), [["send-keys", ensureedPane(), "esc"], ["send-text", ensureedPane(), "/quit"], ["send-keys", ensureedPane(), "enter"]]);
	await until(() => world.kills.length === 1, "SIGTERM");
	assert.deepEqual(world.kills[0], [world.pis.get(id)!.pid, "SIGTERM"]);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "timeout", "the outcome");
	assert.match(readNotes(world.slot, "wA").at(-1)!.note, /timed out/);
	assert.equal(readQueue(world.slot, "wA")[0]?.flag, "crash", "its events return");
});
const ensureedPane = () => world.herdr.panes.find((p) => p.tokens.sb_role === "tower")!.pane_id;

test("a run idle with nothing pending and no tower_done gets one steer, then is ended with the note (ended without a note)", async () => {
	world.runTimers = { idleSteer: 80, idleEnd: 100 };
	const { s } = await setup();
	tower().incoming(from, msg("m1", "quick"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await poll(s, token)).command, undefined);
	await sleep(120);
	assert.equal(((await poll(s, token)).command as { type: string; text: string }).type, "steer");
	await sleep(130);
	assert.equal(((await poll(s, token)).command as { type: string }).type, "quit");
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "quit", "the outcome");
	assert.equal(readNotes(world.slot, "wA").at(-1)!.note, "(ended without a note)");
	assert.deepEqual(readQueue(world.slot, "wA"), [], "it handled its events: nothing returns");
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
	const second = await nthRun(2);
	const got = await claim(s, second);
	assert.equal(got.ok, true);
	assert.match(String(got.brief), /possibly handled by a run that crashed/);
	assert.equal(((await poll(s, String(got.token))).event as { flag: string }).flag, "crash");
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "herdr-restart");
});

test("pane-role: a pane the server does not list is none; a standing pane that holds a live run is quit; one pi by hand becomes a run that ends on tower_done", async () => {
	const { s, ensured } = await setup();
	assert.equal((await ask(s, { cmd: "pane-role", pane: "wA:p1", pid: 1 })).role, "none");
	const hand = await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 5555, started: "T-5555" });
	assert.equal(hand.role, "hand");
	const token = String((hand.claim as { token: string }).token);
	assert.match(String((hand.claim as { brief: string }).brief), /tower of workspace Alpha/);
	assert.equal((await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 5556 })).role, "quit", "the pane is taken");
	world.live.add(5555);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "by hand" })).ok, true);
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
