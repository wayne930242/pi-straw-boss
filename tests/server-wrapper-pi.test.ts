import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { below, leafOf, parseCim, parsePs, type Proc } from "../src/server/lineage.ts";
import { readRun } from "../src/server/towerrunstore.ts";

// A pi started through a wrapper (VM pass B6: `cmd.exe /c pi.cmd` on Windows, where Herdr lists only the wrapper; `sh -c` or a Volta shim elsewhere). The server establishes from its own process table that the
// claimant is the wrapper's child (the process below the listed one that carries the run id and started after it), never from a PID or parent the pi reports, and ends both when it ends the run.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const from = { id: "main-1", name: "docs-main" };
const msg = (id: string, text: string) => ({ id, content: { text } });
const tower = () => world.client("sb-tower-wa")!;
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};

const WRAPPER_AT = "2026-10-28T09:39:13.271Z", PI_AT = "2026-10-28T09:39:13.311Z";
const proc = (pid: number, ppid: number, name: string, carries: boolean, started?: string): Proc => ({ pid, ppid, name, carries, ...(started ? { started } : {}) });
/** The pi's start time is `T-<pid>`, as the world's `startOf` answers it. `agent start` as Windows does it: Herdr lists the cmd.exe that runs pi.cmd, and the pi (node.exe, with a worker of its own) is its child. `table` shapes the process table the server reads. */
const wrapped = (table?: (wrapper: number, pi: number) => Proc[] | undefined, over: { fail?: boolean } = {}) => {
	const base = world.herdr.onAgentStart!;
	const made: { wrapper: number; pi: number }[] = [];
	world.herdr.onAgentStart = (pane, args) => {
		base(pane, args);
		const id = args[args.indexOf("--sb-run") + 1]!, pi = world.pis.get(id)!.pid, wrapper = pi + 500;
		world.live.add(wrapper);
		made.push({ wrapper, pi });
		pane.processes = [{ name: "cmd.exe", argv0: "cmd.exe", pid: wrapper, cmdline: `cmd.exe /c ""C:\\npm\\pi.cmd" --name "tower run" --sb-run ${id} "` }];
		world.procTable = table ? table(wrapper, pi) : [proc(wrapper, 100, "cmd.exe", true, WRAPPER_AT), proc(pi, wrapper, "node.exe", true, `T-${pi}`), proc(pi + 1000, pi, "powershell.exe", false, "2026-10-28T09:39:16.243Z")];
		if (over.fail) throw new Error("herdr agent start failed: timeout: timed out waiting for agent startup");
	};
	return made;
};
const runOf = async () => {
	await until(() => world.pis.size >= 1, "the run to start");
	return [...world.pis.keys()][0]!;
};
const claim = (s: Running, id: string, over: Record<string, unknown> = {}) => {
	const pi = world.pis.get(id)!;
	return ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}`, ...over });
};

/** Takes every event the run is offered, as a run does before its tower_done. */
const drain = async (s: Running, token: string) => {
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) return;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
};

test("lineage: the pi is the first process below the listed wrappers that carries the run id and is not a wrapper; what pi started is never pi; a link that starts before its parent is not a link", () => {
	const table = [proc(10, 1, "cmd.exe", true, WRAPPER_AT), proc(11, 10, "node.exe", true, PI_AT), proc(12, 11, "powershell.exe", false, "2026-10-28T09:39:20.000Z"), proc(13, 11, "node.exe", true, "2026-10-28T09:39:21.000Z")];
	assert.deepEqual(leafOf(table, 10), { pid: 11, started: PI_AT, via: [10] }, "a node that pi started carries the id too, and does not displace pi (WC-F003)");
	assert.deepEqual(leafOf(table, 11), { pid: 11, started: PI_AT, via: [] }, "a pi Herdr lists itself stays pi, whatever below it carries the id");
	assert.deepEqual(leafOf([proc(10, 1, "cmd.exe", true, WRAPPER_AT), proc(11, 10, "sh", true, PI_AT), proc(12, 11, "node", true, "2026-10-28T09:39:14.000Z"), proc(13, 12, "bash", true, "2026-10-28T09:39:15.000Z")], 10), { pid: 12, started: "2026-10-28T09:39:14.000Z", via: [10, 11] }, "wrappers are passed through to the first pi");
	assert.deepEqual(leafOf([proc(10, 1, "node.exe", true, PI_AT)], 10), { pid: 10, started: PI_AT, via: [] }, "pi listed itself");
	assert.equal(leafOf(table, 99), undefined, "the listed process is not in the table");
	// A ppid outlives its process: a child that started before its "parent" belongs to a PID that was reused.
	assert.deepEqual(leafOf([proc(10, 1, "cmd.exe", true, PI_AT), proc(11, 10, "node.exe", true, WRAPPER_AT)], 10), { pid: 10, started: PI_AT, via: [] });
	assert.equal(below(table, 13, 10), true);
	assert.equal(below(table, 13, 12), false, "a sibling is not an ancestor");
	assert.equal(below([proc(10, 1, "cmd.exe", true, PI_AT), proc(11, 10, "node.exe", true, WRAPPER_AT)], 11, 10), false);
	// A cycle (PID reuse made a process its own ancestor) ends the walk.
	assert.equal(below([proc(10, 11, "a", false), proc(11, 10, "b", false)], 10, 99), false);
	assert.deepEqual(leafOf([proc(10, 11, "cmd", true), proc(11, 10, "cmd", true)], 10)?.pid, 11);
});

test("lineage: the CIM answer (TAB-separated, UTC start) and the ps answer parse; garbage lines are skipped", () => {
	assert.deepEqual(parseCim(["21244\t98312\t2026-10-28T09:40:00.123Z\tcmd.exe\t1", "60408\t21244\t2026-10-28T09:40:00.456Z\tnode.exe\t1", "7\t0\t\tSystem\t0", "junk", "5\tx\t\ta\t0"].join("\r\n")), [
		proc(21244, 98312, "cmd.exe", true, "2026-10-28T09:40:00.123Z"), proc(60408, 21244, "node.exe", true, "2026-10-28T09:40:00.456Z"), proc(7, 0, "System", false),
	]);
	const ps = ["  100     1 Tue Oct 28 09:39:13 2026 sh -c pi --sb-run abc123", "  101   100 Tue Oct 28 09:39:13 2026 /usr/bin/node /x/cli.js --name tower --sb-run abc123", "  102   101 Wed Oct  8 09:39:13 2026 /bin/zsh -i", "bad line"].join("\n");
	assert.deepEqual(parsePs(ps, "abc123"), [
		{ pid: 100, ppid: 1, started: "Tue Oct 28 09:39:13 2026", name: "sh", carries: true },
		{ pid: 101, ppid: 100, started: "Tue Oct 28 09:39:13 2026", name: "node", carries: true },
		{ pid: 102, ppid: 101, started: "Wed Oct  8 09:39:13 2026", name: "zsh", carries: false },
	]);
});

test("a pi started through cmd.exe /c pi.cmd claims its run: the server recorded the process below the listed wrapper, not the wrapper", async () => {
	wrapped();
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	const pi = world.pis.get(id)!.pid;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid to be recorded");
	const rec = readRun(world.slot, "wA", id)!;
	assert.equal(rec.pid, pi, "pi's own PID");
	assert.deepEqual(rec.via, [pi + 500], "the wrapper Herdr listed");
	assert.equal(rec.started, `T-${pi}`, "read from the process table, not reported by the pi");
	// The wrapper's PID is not pi's: a claim with it, or with a process not below it, is refused.
	assert.match(String((await claim(s, id, { pid: pi + 500 })).error), /not the ones the server recorded/);
	assert.match(String((await claim(s, id, { pid: pi + 1000 })).error), /not the ones the server recorded/);
	assert.match(String((await claim(s, id, { started: "2026-10-28T09:00:00.000Z" })).error), /not the ones the server recorded/);
	const got = await claim(s, id);
	assert.equal(got.ok, true, JSON.stringify(got));
	assert.equal(readRun(world.slot, "wA", id)?.claimed, true);
});

test("a wrapper whose pi is not in the process table yet is looked at again; a table nobody can read leaves the listed process, as before", async () => {
	const made = wrapped((wrapper) => [proc(wrapper, 100, "cmd.exe", true, WRAPPER_AT)]);
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	await sleep(150);
	const pi = world.pis.get(id)!.pid;
	world.procTable = [proc(made[0]!.wrapper, 100, "cmd.exe", true, WRAPPER_AT), proc(pi, made[0]!.wrapper, "node.exe", true, `T-${pi}`)];
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid to be recorded");
	assert.equal(readRun(world.slot, "wA", id)?.pid, pi, "the second look found the pi");
	assert.equal((await claim(s, id)).ok, true);
});

test("a pi that Herdr lists itself needs no wrapper: one table read, no via", async () => {
	const s = await setup();
	world.procTable = undefined;
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid to be recorded");
	assert.equal(readRun(world.slot, "wA", id)?.via, undefined);
	const pi = world.pis.get(id)!;
	assert.equal((await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })).ok, true);
});

test("a stop ends the run's pi and then the wrapper Herdr lists (the wrapper does not take its child with it)", async () => {
	wrapped();
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid to be recorded");
	assert.equal((await claim(s, id)).ok, true);
	const pi = world.pis.get(id)!.pid;
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "quit");
	assert.deepEqual(world.kills, [[pi, "SIGTERM"], [pi + 500, "SIGTERM"]]);
});

test("a pi that stays after the quit keys is ended with its wrapper", async () => {
	world.runTimers = { quitAt: 150, steerAt: 100, quitGrace: 60, signal: 60 };
	wrapped();
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid to be recorded");
	assert.equal((await claim(s, id)).ok, true);
	const pi = world.pis.get(id)!.pid;
	await until(() => world.kills.length >= 2, "the pi and the wrapper to be signalled", 15_000);
	assert.deepEqual(world.kills.slice(0, 2), [[pi, "SIGTERM"], [pi + 500, "SIGTERM"]]);
});

test("a start Herdr gave up on (agent start timed out) does not leave pi running in the pane: it is ended with its wrapper", async () => {
	wrapped(undefined, { fail: true });
	await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	const pi = world.pis.get(id)!.pid;
	await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", "the run to end crashed");
	assert.deepEqual(world.kills, [[pi, "SIGTERM"], [pi + 500, "SIGTERM"]]);
});

test("a pi the boss started by hand through a wrapper is matched to the pane by the process table; one that is below nothing listed is turned away", async () => {
	const s = await setup();
	const pane = world.herdr.panes.find((p) => p.tokens.sb_role === "tower")!;
	pane.processes = [{ name: "cmd.exe", argv0: "cmd.exe", pid: 5100, cmdline: "cmd.exe /c pi.cmd" }];
	world.procTable = [proc(5100, 100, "cmd.exe", false, WRAPPER_AT), proc(5101, 5100, "node.exe", false, PI_AT), proc(6000, 1, "node.exe", false, PI_AT)];
	const role = (pid: number) => ask(s, { cmd: "pane-role", pane: pane.pane_id, pid, started: PI_AT });
	const stranger = await role(6000);
	assert.equal(stranger.role, "quit");
	assert.match(String(stranger.reason), /could not match/);
	const hand = await role(5101);
	assert.equal(hand.role, "hand", JSON.stringify(hand));
});

// --- the kill paths (review WC-F001, F002) ---------------------------------------------------------------------------------------------------------------------

test("WC-F001: a start that failed ends no process of the pane that does not carry the run id (a user's node in the busy pane)", async () => {
	const base = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (pane, args) => {
		base(pane, args);
		pane.processes = [{ name: "node", argv0: "node", pid: 4242, cmdline: "node /home/me/devserver.js" }, { name: "pi", argv0: "pi", pid: 4243, cmdline: "pi --session other" }];
		// Not `agent_pane_busy`: Herdr's CLI asks again for that one (a new tab's shell may not be at its prompt yet), and a refused start leaves no agent behind that would make the second ask fail by name.
		throw new Error("herdr agent start failed: not_available: the pane's foreground is not a shell");
	};
	await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", "the run to end crashed");
	assert.deepEqual(world.kills, [], "neither the node nor the hand pi in the pane is the run's");
});

test("a start that failed with the wrapper's own command line in the pane ends the wrapper and the pi below it, and only those", async () => {
	wrapped((wrapper, pi) => [proc(wrapper, 100, "cmd.exe", true, WRAPPER_AT), proc(pi, wrapper, "node.exe", true, `T-${pi}`), proc(pi + 1, pi, "node.exe", true, "2026-10-28T09:39:20.000Z"), proc(4242, 1, "node.exe", false, WRAPPER_AT)], { fail: true });
	await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	const pi = world.pis.get(id)!.pid;
	await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", "the run to end crashed");
	assert.deepEqual(world.kills, [[pi, "SIGTERM"], [pi + 500, "SIGTERM"]], "pi, not what pi started, then the wrapper");
});

test("WC-F002: the kill checks the recorded pi in the process table now: a PID another program holds is not signalled, whatever the throttled liveness check says", async () => {
	wrapped();
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid to be recorded");
	assert.equal((await claim(s, id)).ok, true);
	const pi = world.pis.get(id)!.pid;
	// pi died and its PID went to another program that started later; the process is alive for the liveness check and `startOf` still answers the recorded time.
	world.procTable = [proc(pi + 500, 100, "cmd.exe", true, WRAPPER_AT), proc(pi, pi + 500, "calc.exe", false, "2026-10-28T11:00:00.000Z")];
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.deepEqual(world.kills, [[pi + 500, "SIGTERM"]], "only the wrapper that still carries the run id");
});

test("WC-F002: a PID that is no longer below the process Herdr lists is not signalled either", async () => {
	wrapped();
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await runOf();
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid to be recorded");
	assert.equal((await claim(s, id)).ok, true);
	const pi = world.pis.get(id)!.pid;
	world.procTable = [proc(pi + 500, 100, "cmd.exe", true, WRAPPER_AT), proc(pi, 1, "node.exe", false, `T-${pi}`)];
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.deepEqual(world.kills, [[pi + 500, "SIGTERM"]]);
});

test("WC-F005: the kill of a stuck pi waits for the process table beside the watcher: another run's exit is seen meanwhile", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	wrapped();
	const s = await setup();
	world.herdr.workspaces[1]!.worktree = { checkout_path: "/w/beta" };
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	tower().incoming(from, msg("m1", "a"));
	const a = await runOf();
	await until(() => readRun(world.slot, "wA", a)?.pid, "run A's pid");
	const tokenA = String((await claim(s, a)).token);
	world.client("sb-tower-wb")!.incoming(from, msg("m1", "b"));
	await until(() => world.pis.size === 2, "run B to start");
	const b = [...world.pis.keys()][1]!;
	await until(() => readRun(world.slot, "wB", b)?.pid, "run B's pid");
	assert.equal((await claim(s, b)).ok, true);
	let release!: () => void;
	const gate = new Promise<void>((done) => (release = done));
	let held = false;
	world.procGate = (runId) => (runId === a ? ((held = true), gate) : undefined);
	// A hands in its note and stays: the server asks it to leave, then types /quit, then signals it.
	await drain(s, tokenA);
	const done = await ask(s, { cmd: "run-done", token: tokenA, note: "ok" });
	assert.equal(done.ok, true, JSON.stringify(done));
	await until(() => held, "the table read for the signal stage", 5000);
	world.live.delete(world.pis.get(b)!.pid);
	await until(() => readRun(world.slot, "wB", b)?.outcome === "crashed", "B's exit to be seen while A's table read is held", 3000);
	assert.deepEqual(world.kills, []);
	release();
	await until(() => world.kills.length >= 2, "A's pi and wrapper to be signalled");
});

// --- pane-role (review WC-F004, F005) ---------------------------------------------------------------------------------------------------------------------------

test("WC-F004/F005: a hand pi below a listed wrapper is recorded with the table's start time, not the one it reports; unlisted pi processes that ask together share one table read", async () => {
	const s = await setup();
	const pane = world.herdr.panes.find((p) => p.tokens.sb_role === "tower")!;
	pane.processes = [{ name: "cmd.exe", argv0: "cmd.exe", pid: 5100, cmdline: "cmd.exe /c pi.cmd" }];
	world.procTable = [proc(5100, 100, "cmd.exe", false, WRAPPER_AT), proc(5101, 5100, "node.exe", false, PI_AT), proc(6000, 1, "node.exe", false, PI_AT)];
	const before = world.procReads;
	const role = (pid: number, started: string) => ask(s, { cmd: "pane-role", pane: pane.pane_id, pid, started });
	const [stranger, hand] = await Promise.all([role(6000, PI_AT), role(5101, "2026-10-28T08:00:00.000Z")]);
	assert.equal(stranger.role, "quit");
	assert.equal(hand.role, "hand", JSON.stringify(hand));
	assert.equal(world.procReads - before, 1, "one read for both");
	const run = (hand.claim as { run: string }).run;
	assert.equal(readRun(world.slot, "wA", run)?.started, PI_AT, "the table's start time");
	assert.deepEqual(readRun(world.slot, "wA", run)?.via, [5100]);
});
