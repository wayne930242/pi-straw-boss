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

test("lineage: the pi is the deepest process below the listed one that carries the run id; a link that starts before its parent is not a link", () => {
	const table = [proc(10, 1, "cmd.exe", true, WRAPPER_AT), proc(11, 10, "node.exe", true, PI_AT), proc(12, 11, "powershell.exe", false, "2026-10-28T09:39:20.000Z"), proc(13, 11, "node.exe", true, "2026-10-28T09:39:21.000Z")];
	assert.deepEqual(leafOf(table, 10), { pid: 13, started: "2026-10-28T09:39:21.000Z", via: [10, 11] }, "the deepest carrier");
	assert.deepEqual(leafOf(table, 11), { pid: 13, started: "2026-10-28T09:39:21.000Z", via: [11] });
	assert.deepEqual(leafOf([proc(10, 1, "node.exe", true, PI_AT)], 10), { pid: 10, started: PI_AT, via: [] }, "pi listed itself");
	assert.equal(leafOf(table, 99), undefined, "the listed process is not in the table");
	// A ppid outlives its process: a child that started before its "parent" belongs to a PID that was reused.
	assert.deepEqual(leafOf([proc(10, 1, "cmd.exe", true, PI_AT), proc(11, 10, "node.exe", true, WRAPPER_AT)], 10), { pid: 10, started: PI_AT, via: [] });
	assert.equal(below(table, 13, 10), true);
	assert.equal(below(table, 13, 12), false, "a sibling is not an ancestor");
	assert.equal(below([proc(10, 1, "cmd.exe", true, PI_AT), proc(11, 10, "node.exe", true, WRAPPER_AT)], 11, 10), false);
	// A cycle (PID reuse made a process its own ancestor) ends the walk.
	assert.equal(below([proc(10, 11, "a", false), proc(11, 10, "b", false)], 10, 99), false);
	assert.deepEqual(leafOf([proc(10, 11, "a", true), proc(11, 10, "b", true)], 10)?.pid, 11);
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
