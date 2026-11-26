import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { killSequence, probeStart, sendSignal, wholeGroups, type KillDeps, type Signal } from "../src/procs/kill.ts";
import { forgetOwned, noteOwned, reapOwned } from "../src/procs/killguard.ts";
import { readTable, refOf, type Proc } from "../src/procs/table.ts";
import { TEST_ROOT } from "../src/server/testguard.ts";
import { fakeClock } from "./fake-clock.ts";

// The kill sequence: a fake world first (identity re-checks, group safety, the grace on the clock), then a real tree of processes that ignore SIGTERM, started inside the test root and killed on the fake clock.

const P = (pid: number, ppid: number, over: Partial<Proc> = {}): Proc => ({ pid, ppid, pgid: pid, uid: 501, started: `t${pid}`, cpu: 0, comm: "/usr/bin/node", zombie: false, ...over });

/** A table the test owns: `onSignal` decides what a signal does to it. */
function fakeWorld(table: Proc[], behave: (target: number, signal: Signal, world: { table: Proc[] }) => void) {
	const world = { table: [...table] }, sent: [number, Signal][] = [], clock = fakeClock();
	const deps: KillDeps = {
		read: async () => world.table.map((p) => ({ ...p })),
		probe: (pid) => world.table.find((p) => p.pid === pid)?.started,
		signal: (target, signal) => (sent.push([target, signal]), behave(target, signal, world)),
		sleep: clock.sleep,
		self: 9000,
	};
	return { world, sent, clock, deps };
}
const dies = (target: number, world: { table: Proc[] }) => void (world.table = world.table.filter((p) => (target < 0 ? p.pgid !== -target : p.pid !== target)));

test("SIGTERM first to each whole group and each pid, then 10 s later SIGKILL to what is left: the identity of each is read before each signal", async () => {
	const table = [P(10, 1), P(11, 10, { pgid: 10 }), P(20, 1), P(30, 1)];
	// 20 obeys SIGTERM; 10's group and 30 ignore it
	const w = fakeWorld(table, (target, signal, world) => { if (signal === "SIGKILL" || target === -20 || target === 20) dies(target, world); });
	const report = await killSequence(table.filter((p) => p.pid !== 11).concat(table[1]!).map(refOf), w.deps);
	assert.deepEqual(w.sent, [[-10, "SIGTERM"], [-20, "SIGTERM"], [-30, "SIGTERM"], [-10, "SIGKILL"], [-30, "SIGKILL"]]);
	assert.deepEqual(report, { termed: 4, killed: 3, skipped: 0, groups: 3, left: [] });
	assert.ok(w.clock.elapsed() >= 10_000, "the grace is 10 s on the clock");
});

test("kit2-F002: with groups off, every signal goes to one pid whose identity was read right before it, never to a group", async () => {
	const table = [P(10, 1), P(11, 10, { pgid: 10 }), P(20, 1)];
	const w = fakeWorld(table, (target, signal, world) => { if (signal === "SIGKILL") dies(target, world); });
	const report = await killSequence(table.map(refOf), { ...w.deps, groups: false });
	assert.deepEqual(w.sent, [[10, "SIGTERM"], [11, "SIGTERM"], [20, "SIGTERM"], [10, "SIGKILL"], [11, "SIGKILL"], [20, "SIGKILL"]]);
	assert.deepEqual(report, { termed: 3, killed: 3, skipped: 0, groups: 0, left: [] });
});

test("a pid that now has another start time is not signalled: not in the first look, not in the second", async () => {
	const table = [P(10, 1), P(20, 1)];
	const w = fakeWorld(table, () => {});
	// 10 is reused during the grace: the same pid, another process
	const sleep = w.deps.sleep;
	w.deps.sleep = async (ms) => { await sleep(ms); w.world.table = w.world.table.map((p) => (p.pid === 10 ? { ...p, started: "reused" } : p)); };
	const report = await killSequence([{ pid: 10, started: "t10" }, { pid: 20, started: "t20" }, { pid: 30, started: "t30" }], w.deps);
	assert.deepEqual(w.sent.filter(([, s]) => s === "SIGKILL"), [[-20, "SIGKILL"]], "only 20 is hit the second time");
	assert.deepEqual(report.left, [{ pid: 20, program: "node" }], "20 survives (the fake world ignores signals) and is reported by program name");
});

test("the identity check happens right before the signal: a pid that changes between the table and the signal is skipped", async () => {
	const table = [P(10, 1), P(20, 1)];
	const w = fakeWorld(table, () => {});
	const probe = w.deps.probe;
	w.deps.probe = (pid) => (pid === 20 ? "someone-else" : probe(pid));
	const report = await killSequence(table.map(refOf), { ...w.deps, graceMs: 1, settle: { tries: 0, stepMs: 1 } });
	assert.deepEqual(w.sent.filter(([, s]) => s === "SIGTERM"), [[-10, "SIGTERM"]]);
	assert.deepEqual(w.sent.filter(([t]) => t === 20 || t === -20), [], "20 was never signalled, as a group or as a pid");
	assert.equal(report.skipped, 2, "once in each phase");
});

test("a group that holds a process that is not a target is not signalled whole: its targets are signalled one by one", async () => {
	const table = [P(10, 1), P(11, 10, { pgid: 10 }), P(12, 10, { pgid: 10 })];
	const w = fakeWorld(table, () => {});
	await killSequence([refOf(table[0]!), refOf(table[1]!)], { ...w.deps, settle: { tries: 0, stepMs: 1 } });
	assert.deepEqual(w.sent.filter(([, s]) => s === "SIGTERM"), [[10, "SIGTERM"], [11, "SIGTERM"]]);
	assert.deepEqual(wholeGroups(table.slice(0, 2), table, { pid: 9000, pgid: 1 }), []);
	assert.deepEqual(wholeGroups(table, table, { pid: 9000, pgid: 1 }), [10]);
	assert.deepEqual(wholeGroups(table, table, { pid: 12, pgid: 1 }), [], "the group this process is in is never signalled whole");
});

test("this process, pid 1, a zombie, and a failed table read never get a signal", async () => {
	const table = [P(1, 0, { uid: 0 }), P(9000, 1), P(40, 1, { zombie: true })];
	const w = fakeWorld(table, () => {});
	await assert.rejects(killSequence(table.map(refOf), w.deps), /refusing to signal 1|refusing to signal -1/);
	assert.deepEqual(w.sent.filter(([t]) => t === 9000 || t === -9000 || t === 40), []);
	const none = fakeWorld(table, () => {});
	none.deps.read = async () => undefined;
	await assert.rejects(killSequence([{ pid: 40, started: "t40" }], none.deps), /could not be read/);
	assert.deepEqual(none.sent, []);
	const ok = fakeWorld(table.slice(1), () => {});
	await killSequence(table.slice(1).map(refOf), { ...ok.deps, settle: { tries: 0, stepMs: 1 } });
	assert.deepEqual(ok.sent, [], "this process and a zombie: nothing to signal");
});

test("a process that is gone when its signal arrives (ESRCH) is skipped; any other error stops the sequence", async () => {
	const table = [P(10, 1), P(20, 1)];
	const gone = fakeWorld(table, (target) => { if (target === -10 || target === 10) throw Object.assign(new Error("no such process"), { code: "ESRCH" }); });
	const report = await killSequence(table.map(refOf), { ...gone.deps, settle: { tries: 0, stepMs: 1 } });
	assert.equal(report.skipped, 2, "10 is skipped in each phase");
	const bad = fakeWorld(table, () => { throw new Error("guard refused"); });
	await assert.rejects(killSequence(table.map(refOf), bad.deps), /guard refused/);
});

// --- a real tree -------------------------------------------------------------------------------

const root = process.env[TEST_ROOT]!;
const children: ChildProcess[] = [], dirs: string[] = [];
afterEach(() => {
	for (const child of children.splice(0)) { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } try { child.kill("SIGKILL"); } catch { /* gone */ } }
	reapOwned(root, process.pid);
	for (const dir of dirs.splice(0)) rmdirSync(dir);
});
const stubborn = join(dirname(fileURLToPath(import.meta.url)), "procs-stubborn.mjs");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a tree that ignores SIGTERM, in new sessions, one of them an orphan under pid 1, is gone after the grace on the fake clock; a process not in the set survives", { skip: process.platform === "win32" }, async () => {
	const cwd = mkdtempSync(join(root, "tree-"));
	dirs.push(cwd);
	const start = (kind: string) => {
		const child = spawn(process.execPath, [stubborn, kind], { detached: true, cwd, stdio: ["ignore", "pipe", "ignore"] });
		children.push(child);
		return child;
	};
	const rootProc = start("root"), bystander = start("leaf");
	const pids = await new Promise<{ a: number; b: number; m: number; c: number }>((resolve, reject) => {
		let text = "";
		rootProc.stdout!.on("data", (d) => { text += d; if (text.includes("\n")) resolve(JSON.parse(text)); });
		rootProc.on("exit", () => reject(new Error("the root ended before it told its tree")));
	});
	const tree = [rootProc.pid!, pids.a, pids.b, pids.c];
	for (const pid of [...tree, bystander.pid!]) assert.ok(noteOwned(pid), `noted ${pid}`);
	const table = (await readTable())!;
	assert.notEqual(table.find((p) => p.pid === pids.c)!.ppid, pids.m, "the middle one is gone, so its leaf was adopted by init (or a subreaper)");
	const refs = tree.map((pid) => refOf(table.find((p) => p.pid === pid)!));

	const clock = fakeClock(), seen: { at: number; alive: boolean[] }[] = [];
	const report = await killSequence(refs, {
		read: () => readTable(),
		probe: probeStart,
		signal: sendSignal,
		sleep: async (ms) => {
			clock.advance(ms);
			if (ms === 10_000) seen.push({ at: clock.elapsed(), alive: tree.map(alive) });
			await new Promise((done) => setImmediate(done));
		},
		settle: { tries: 4000, stepMs: 50 },
	});
	assert.deepEqual(seen, [{ at: 10_000, alive: [true, true, true, true] }], "SIGTERM killed none of them; the grace ran out on the clock");
	assert.equal(report.termed, 4);
	assert.equal(report.killed, 4);
	assert.deepEqual(report.left, []);
	if (rootProc.exitCode === null && rootProc.signalCode === null) await new Promise((done) => rootProc.once("exit", done));
	assert.deepEqual(tree.map(alive), [false, false, false, false]);
	assert.ok(alive(bystander.pid!), "a process outside the set was not touched");
	forgetOwned(bystander.pid!);
});
