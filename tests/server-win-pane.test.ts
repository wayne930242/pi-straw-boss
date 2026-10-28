import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";

// Windows (VM pass B6, x6a-x6i): a pi ended with TerminateProcess leaves the console input mode of its pane broken, and `herdr agent start` into the same pane then types a mangled command and times out. So on Windows
// the server ends a run by asking (the quit command at the run's poll, then Escape and /quit through Herdr) and waits longer, never kills a pi of a stopping server, and does not reuse a pane after a forced kill.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.runPlatform = "win32";
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string; token?: string; command?: { type: string }; tab?: string; pane?: string; opened?: boolean };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const from = { id: "main-1", name: "docs-main" };
const msg = (id: string, text: string) => ({ id, content: { text } });
/** The tower's client: the identity registers again when its pane is renewed, and the newest connection is the live one. */
const tower = () => world.clients.filter((c) => c.sessionId === "sb-tower-wa").at(-1)!;
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, ensured };
};
const nthRun = async (n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
/** The run's claim, once the renewed identity is registered (a claim is held until it is). */
const claimed = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	let token: string | undefined;
	await until(async () => {
		const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
		assert.equal(got.ok, true, JSON.stringify(got));
		token = got.token;
		return Boolean(token);
	}, "the claim to pass");
	return token!;
};
/** Takes every event the run is offered, as a run does before its tower_done. */
const drain = async (s: Running, token: string) => {
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) return;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
};
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);

test("win32: a stop tells the run to quit at its poll and waits for pi to leave; a pi that leaves is not killed", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await until(async () => (await ask(s, { cmd: "run-poll", token, idle: true })).command?.type === "quit", "the quit command at the run's poll");
	exit(id);
	await s.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "quit");
	assert.deepEqual(world.kills, []);
});

test("win32: a pi that stays after the stop's grace is not killed: the run is left unfinished, for the next server to reclaim or for pi to end itself", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await claimed(s, id);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.deepEqual(world.kills, [], "no TerminateProcess: it breaks the pane for the next pi");
	assert.equal(readRun(world.slot, "wA", id)?.outcome, undefined, "no outcome: the next server finds the run and its pi reclaims it");
});

test("elsewhere a pi that stays after the stop's grace is signalled, and the signal is sent before the server exits however long the process table takes", async () => {
	world.runPlatform = undefined;
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await claimed(s, id);
	const pi = world.pis.get(id)!.pid;
	world.procGate = () => sleep(2500);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.deepEqual(world.kills, [[pi, "SIGTERM"]], "the exit waited for the signal");
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "quit");
});

test("win32: a pi that leaves by itself after tower_done leaves the standing pane as it is", async () => {
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	assert.deepEqual(world.herdr.closed, []);
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).pane, ensured.pane);
});

test("win32: after a forced kill the standing pane is closed and a fresh one stands in before the next run, which starts there", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	const pi = world.pis.get(id)!.pid;
	// pi hands in its note and stays: Escape and /quit, then the signal.
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	assert.deepEqual(world.kills, [[pi, "SIGTERM"]]);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	await until(() => world.herdr.closed.includes(ensured.tab!), "the old standing tab to be closed");
	const again = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(again.opened, false, "the service stands: only its pane is new");
	assert.notEqual(again.pane, ensured.pane);
	assert.equal(world.herdr.panes.find((p) => p.pane_id === again.pane)?.tokens.sb_role, "tower");
	tower().incoming(from, msg("m2", "two"));
	const second = await nthRun(2);
	assert.equal(world.pis.get(second)!.pane, again.pane, "the next run starts in the fresh pane");
	assert.ok(!world.herdr.panes.some((p) => p.pane_id === ensured.pane), "the old pane is gone");
});

test("win32: a start that times out is tried once more in a fresh pane, and the first timeout is not counted as a crash", async () => {
	const { s, ensured } = await setup();
	const base = world.herdr.onAgentStart!;
	let first = true;
	world.herdr.onAgentStart = (pane, args) => {
		if (first) {
			first = false;
			throw new Error("herdr agent start failed: timeout: timed out waiting for agent startup");
		}
		base(pane, args);
	};
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	assert.notEqual(world.pis.get(id)!.pane, ensured.pane, "the retry runs in a fresh pane");
	assert.ok(world.herdr.closed.includes(ensured.tab!), "the old tab is closed");
	assert.equal(readRun(world.slot, "wA", id)?.pane, world.pis.get(id)!.pane, "the record names the pane it runs in");
	await claimed(s, id);
	const service = ((await ask(s, { cmd: "status" })).towers as { service: { crashes?: number; notices: { kind: string }[] } }[])[0]!.service;
	assert.equal(service.crashes, undefined);
	assert.ok(!service.notices.some((n) => n.kind === "start"));
});

const status = async (s: Running) => ((await ask(s, { cmd: "status" })).towers as { service: { state: string; crashes?: number } }[])[0]!.service;
const starts = () => world.herdr.commands("agent", "start").length;

test("win32: a start that times out twice is one crash of its run: three runs hold the service after six starts", async () => {
	const { s } = await setup();
	world.herdr.onAgentStart = () => {
		throw new Error("herdr agent start failed: timeout: timed out waiting for agent startup");
	};
	tower().incoming(from, msg("m1", "one"));
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal(starts(), 6, "each run started twice");
	assert.equal((await status(s)).crashes, 3);
});

test("elsewhere a start that times out ends the run as before: one start per run, three runs hold the service, no new pane", async () => {
	world.runPlatform = undefined;
	const { s, ensured } = await setup();
	world.herdr.onAgentStart = () => {
		throw new Error("herdr agent start failed: timeout: timed out waiting for agent startup");
	};
	tower().incoming(from, msg("m1", "one"));
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal(starts(), 3);
	assert.deepEqual(world.herdr.closed, []);
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).pane, ensured.pane);
});

test("win32: the fresh standing pane made after a forced kill gets the tower prompt typed (Herdr gives no foreground group there, so only a pane known fresh is typed into)", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const { s, ensured } = await setup();
	await until(() => world.herdr.typed.some((t) => t.pane === ensured.pane), "the prompt typed into the first standing pane");
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	exit(id);
	await until(() => world.herdr.closed.includes(ensured.tab!), "the old standing tab to be closed");
	const again = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.notEqual(again.pane, ensured.pane);
	await until(() => world.herdr.typed.some((t) => t.pane === again.pane && /prompt --workspace wA/.test(t.text)), "the prompt typed into the renewed pane");
});
