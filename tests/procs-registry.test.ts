import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createProcs, DEFER_MAX, type Procs, ProcsRefusal, type ProcsDeps } from "../src/server/procs.ts";
import { procsReply } from "../src/server/procsops.ts";
import type { KillReport } from "../src/procs/kill.ts";
import type { Proc, Ref } from "../src/procs/table.ts";
import { fakeClock } from "./fake-clock.ts";

// The owner registry (src/server/procs.ts) on a fake process table and the fake clock: an owner ends three ways (bye, its pid gone, a Herdr pane event with a matching terminal), a reused pane id is ignored,
// the snapshots survive a restart, `reap --checkout` refuses while a live owner works there, and the first tick's cost is measured and logged once.

const P = (pid: number, ppid: number, over: Partial<Proc> = {}): Proc => ({ pid, ppid, pgid: pid, uid: 501, started: `t${pid}`, cpu: 0, comm: "/usr/bin/node", zombie: false, ...over });
const dirs: string[] = [];
let dir: string;
beforeEach(() => void dirs.push((dir = mkdtempSync(join(tmpdir(), "psb-procs-")))));
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A world: a table the test edits, a reap that records what it was asked to kill and removes it, a log. */
function world(over: Partial<ProcsDeps> = {}, d = dir) {
	const w = {
		table: [P(100, 1), P(101, 100), P(102, 101), P(200, 1), P(300, 1)] as Proc[], reaped: [] as Ref[][], log: [] as { event: string; facts: Record<string, unknown> }[], clock: fakeClock(), roots: new Map<string, "linked">(),
		panes: [] as { pane_id: string; terminal_id?: string; cwd?: string; workspace_id?: string }[], workspaces: [] as { workspace_id: string; checkout_path: string }[],
		/** What the disk says: a folder is a linked worktree when it is (under) a root of `roots`, a main checkout when it is in `mains`; `gone` is not on disk. */
		mains: new Set<string>(), gone: new Set<string>(),
	};
	const procs = createProcs({
		dir: d, now: w.clock.now, log: (event, facts) => w.log.push({ event, facts }), self: [9000], platform: "darwin",
		read: async () => w.table.map((p) => ({ ...p })),
		startOf: (pid) => w.table.find((p) => p.pid === pid)?.started,
		cwds: async () => new Map(), markers: async () => new Map(), inode: () => "1",
		checkout: (cwd) => {
			const root = [...w.roots.keys()].find((r) => cwd === r || cwd.startsWith(`${r}/`));
			if (root) return { kind: "linked", root, gitdir: `${root}/../.git/worktrees/x` };
			return [...w.mains].some((m) => cwd === m || cwd.startsWith(`${m}/`)) ? { kind: "main", root: cwd } : { kind: "none" };
		},
		real: (path) => path, exists: (path) => !w.gone.has(path),
		panes: async () => w.panes, workspaces: async () => w.workspaces,
		reap: async (refs): Promise<KillReport> => {
			w.reaped.push([...refs]);
			w.table = w.table.filter((p) => !refs.some((r) => r.pid === p.pid && r.started === p.started));
			return { termed: refs.length, killed: 0, skipped: 0, groups: 0, left: [] };
		},
		...over,
	});
	const lines = (event: string) => w.log.filter((l) => l.event === event).map((l) => l.facts);
	return { w, procs, lines };
}
const pids = (refs: Ref[][]) => refs.map((r) => r.map((x) => x.pid).sort((a, b) => a - b));

test("a bye ends the owner: what it started, noted at the last tick, is killed; a process outside its tree is not", async () => {
	const { w, procs, lines } = world();
	await procs.hello({ pid: 100, id: "w1", pane: "p1", terminal: "term-1" });
	await procs.tick();
	assert.equal(procs.list()[0]!.snapshot, 2, "101 and 102 below pid 100");
	assert.equal(procs.bye("w1"), true);
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[101, 102]]);
	assert.deepEqual(procs.list(), [], "an owner with nothing left is forgotten");
	assert.deepEqual(lines("procs-reaped").map((f) => [f.owner, f.reason, f.targets, f.termed, f.left]), [["w1", "bye", 2, 2, 0]]);
	assert.ok(w.table.some((p) => p.pid === 200) && w.table.some((p) => p.pid === 300), "the others are untouched");
});

test("an owner whose pid is gone ends at the next tick, and a child that was adopted by init meanwhile is still found by the snapshot", async () => {
	const { w, procs, lines } = world();
	await procs.hello({ pid: 100, id: "w1" });
	await procs.tick();
	// pid 100 dies; its child 101 is adopted by init (the case a ppid walk misses)
	w.table = w.table.filter((p) => p.pid !== 100).map((p) => (p.pid === 101 ? { ...p, ppid: 1 } : p));
	await procs.tick();
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[101, 102]]);
	assert.deepEqual(lines("procs-owner-ended").map((f) => f.reason), ["pid gone"]);
});

test("a pid that now belongs to another process (reuse) is a pid gone, and the new process is not touched", async () => {
	const { w, procs } = world();
	await procs.hello({ pid: 100, id: "w1" });
	await procs.tick();
	w.table = w.table.map((p) => (p.pid === 100 ? { ...p, started: "reused" } : p));
	await procs.tick();
	await procs.settled();
	assert.ok(w.table.some((p) => p.pid === 100 && p.started === "reused"), "the new holder of 100 was not reaped");
	assert.deepEqual(pids(w.reaped), [[101, 102]]);
});

test("a Herdr pane event ends the owner when it names the owner's terminal; a reused pane id does not", async () => {
	const { w, procs, lines } = world();
	await procs.hello({ pid: 100, id: "w1", pane: "p1", terminal: "term-1" });
	await procs.tick();
	// the id p1 was reused by a pane with another terminal: its exit says nothing about this owner
	await procs.paneEvent({ event: "pane.exited", data: { pane_id: "p1", terminal_id: "term-2" } });
	await procs.paneEvent({ event: "pane.updated", data: { pane_id: "p1", terminal_id: "term-1" } });
	await procs.paneEvent({ event: "pane.closed", data: { pane_id: "other", terminal_id: "term-1" } });
	await procs.settled();
	assert.deepEqual(w.reaped, [], "none of the three ends the owner");
	// an event without a terminal: the pane is still listed with the owner's terminal, so it is the owner's pane still
	w.panes = [{ pane_id: "p1", terminal_id: "term-1" }];
	await procs.paneEvent({ event: "pane.closed", data: { pane_id: "p1" } });
	await procs.settled();
	assert.deepEqual(w.reaped, []);
	// the listed pane has another terminal now: the owner's terminal is gone
	w.panes = [{ pane_id: "p1", terminal_id: "term-9" }];
	await procs.paneEvent({ event: "pane.closed", data: { pane_id: "p1" } });
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[101, 102]]);
	// the matching terminal ends another owner at once
	await procs.hello({ pid: 200, id: "w2", pane: "p2", terminal: "term-2" });
	await procs.paneEvent({ event: "pane.exited", data: { pane_id: "p2", terminal_id: "term-2" } });
	await procs.settled();
	assert.deepEqual(lines("procs-owner-ended").map((f) => [f.owner, f.reason]), [["w1", "pane.closed"], ["w2", "pane.exited"]]);
});

test("replay: Herdr 0.9.5 puts pane_closed and pane_exited on the wire (data without a terminal id); they end the owner and run the no-owner worktree rule like the dotted names", async () => {
	const { w, procs, lines } = world();
	await procs.hello({ pid: 100, id: "w1", pane: "p1", terminal: "term-1" });
	await procs.tick();
	await procs.paneEvent({ event: "pane_closed", data: { pane_id: "p1", type: "pane_closed", workspace_id: "ws1" } });
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[101, 102]], "the owner's pane closed: its tree is reaped");
	assert.deepEqual(lines("procs-owner-ended").map((f) => [f.owner, f.reason]), [["w1", "pane.closed"]], "logged under the dotted name, as the docs and the other events say it");
	// no owner in the pane: a linked worktree's orphans go, as with pane.exited
	const wt = "/tmp/psb-wire/wt";
	const more = world({ cwds: async (ids) => new Map(ids.filter((id) => id === 400).map((id) => [id, { path: `${wt}/pkg` }])) });
	more.w.roots.set(wt, "linked");
	more.w.workspaces = [{ workspace_id: "ws2", checkout_path: wt }];
	more.w.table.push(P(400, 1));
	await more.procs.paneEvent({ event: "pane_exited", data: { pane_id: "p7", type: "pane_exited", workspace_id: "ws2" } });
	assert.deepEqual(pids(more.w.reaped), [[400]], "the orphan in the worktree goes");
});

test("the registry survives a server restart: snapshots are read back, and an owner that ended while the server was down is reaped at start", async () => {
	const first = world();
	await first.procs.hello({ pid: 100, id: "w1", pane: "p1" });
	await first.procs.hello({ pid: 200, id: "w2" });
	await first.procs.tick();
	const file = join(dir, "procs", "owners.json");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(JSON.parse(readFileSync(file, "utf8")).owners.find((o: { id: string }) => o.id === "w1").snapshot.length, 2);
	// the server restarts: a new registry on the same folder; owner w1 died meanwhile, its child 101 now belongs to init
	const second = world({}, dir);
	second.w.table = first.w.table.filter((p) => p.pid !== 100).map((p) => (p.pid === 101 ? { ...p, ppid: 1 } : p));
	await second.procs.start();
	await second.procs.settled();
	assert.deepEqual(pids(second.w.reaped), [[101, 102]]);
	assert.deepEqual(second.procs.list().map((o) => [o.id, o.live]), [["w2", true]]);
	assert.deepEqual(second.lines("procs-owner-ended").map((f) => f.reason), ["gone while the server was down"]);
});

test("reap --checkout refuses while a live owner works there, and kills the orphans of an ended owner's worktree after", async () => {
	const wt = "/tmp/psb-fake-wt";
	const { w, procs } = world({ cwds: async (pids) => new Map(pids.filter((p) => p === 300).map((p) => [p, { path: `${wt}/sub` }])) });
	w.roots.set(wt, "linked");
	await procs.hello({ pid: 100, id: "w1", cwd: wt });
	await assert.rejects(procs.reapCheckout(wt), (error: Error) => error instanceof ProcsRefusal && /live owner works in \/tmp\/psb-fake-wt: w1 \(pid 100\)/.test(error.message));
	await assert.rejects(procs.reapCheckout(`${wt}/sub`), ProcsRefusal, "a folder below the root counts");
	await assert.rejects(procs.reapOwner("w1"), /is alive/);
	assert.deepEqual(w.reaped, []);
	// the owner dies; 300 is an orphan (parent init) working in the worktree
	w.table = w.table.filter((p) => p.pid !== 100 && p.pid !== 101 && p.pid !== 102);
	await procs.tick();
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[300]], "the cwd rule found the orphan of the worktree");
	assert.ok(w.table.some((p) => p.pid === 200), "an orphan elsewhere stays");
	// the same by path, for a checkout no owner is known for
	w.table.push(P(301, 1));
	const again = await procs.reapCheckout(wt);
	assert.equal(again.targets, 0, "301 has no cwd in it");
});

test("a live owner's tree is spared when another owner is reaped, and a worker in the parent checkout gets no cwd rule", async () => {
	const wt = "/tmp/psb-fake-wt2";
	const { w, procs } = world({ cwds: async (pids) => new Map(pids.map((p) => [p, { path: `${wt}/x` }])) });
	w.roots.set(wt, "linked");
	await procs.hello({ pid: 100, id: "w1", cwd: wt });
	await procs.hello({ pid: 200, id: "w2", cwd: "/tmp/parent-checkout" });
	await procs.tick();
	assert.deepEqual(procs.list().map((o) => [o.id, o.roots]), [["w1", [wt]], ["w2", []]]);
	w.table.push(P(400, 200)); // below the live owner w2
	await procs.tick();
	w.table = w.table.filter((p) => p.pid !== 100);
	await procs.tick();
	await procs.settled();
	const hit = pids(w.reaped).flat();
	assert.ok(!hit.includes(400) && !hit.includes(200), "the live owner and its tree are not in the kill set");
});

test("the first tick's cost is measured and logged once; a slow one moves the tick to 30 s", async () => {
	let calls = 0;
	const clock = fakeClock();
	const { procs, lines } = world({ now: clock.now, read: async () => { calls++; clock.advance(calls === 2 ? 1500 : 10); return [P(100, 1)]; } });
	await procs.start();
	await procs.tick();
	await procs.tick();
	assert.equal(lines("procs-tick-cost").length, 1, "once, at start");
	assert.equal(lines("procs-tick-cost")[0]!.ms, 1500, "the first tick's table read took 1.5 s on the clock");
	assert.equal(procs.tickMs(), 30_000);
});

test("hello refuses a pid that is not a process of the account with that start time", async () => {
	const { procs } = world();
	await assert.rejects(procs.hello({ pid: 999 }), ProcsRefusal);
	await assert.rejects(procs.hello({ pid: 100, started: "t-wrong" }), ProcsRefusal);
	await assert.rejects(procs.hello({ pid: 100, id: "bad id" }), ProcsRefusal);
	await assert.rejects(procs.hello({ pid: 1 }), ProcsRefusal);
	assert.deepEqual(procs.list(), []);
});

// --- the findings of the T2 review ---

test("T2R-F001: reap --checkout takes a linked worktree or a removed known root and nothing else: never /, a home folder, a main checkout, a folder above checkouts, or a submodule", async () => {
	const wt = "/tmp/psb-f1/wt";
	const kinds: Record<string, "linked" | "main" | "submodule" | "none"> = { "/": "none", "/Users/u": "none", "/Users/u/repo": "main", "/tmp/psb-f1": "none", "/Users/u/repo/sub": "submodule", [wt]: "linked" };
	const { w, procs } = world({
		checkout: (cwd) => { const kind = kinds[cwd] ?? "none"; return kind === "none" ? { kind } : { kind, root: cwd, ...(kind === "linked" ? { gitdir: `${cwd}/../.git/worktrees/x` } : {}) } as never; },
		cwds: async (pids) => new Map(pids.map((p) => [p, { path: "/Users/u/Library" }])),
	});
	for (const path of ["/", "/Users/u", "/Users/u/repo", "/tmp/psb-f1", "/Users/u/repo/sub"]) {
		await assert.rejects(procs.reapCheckout(path), (error: Error) => error instanceof ProcsRefusal && /reap --checkout takes a linked worktree/.test(error.message), path);
	}
	// a path that is not on disk and was no known owner's root is refused too
	w.gone.add("/tmp/psb-f1/never-known");
	await assert.rejects(procs.reapCheckout("/tmp/psb-f1/never-known"), /gone and no known worker worked in it/);
	assert.deepEqual(w.reaped, [], "no process was asked for in any of the six");
	// a linked worktree is reaped
	assert.equal((await procs.reapCheckout(wt)).targets, 0);
});

test("T2R-F001/F009: the path is made physical first, and a removed checkout is taken only through a root a known owner had", async () => {
	const priv = "/private/tmp/psb-f1b/wt";
	const { w, procs } = world({
		real: (path) => (path.startsWith("/tmp/") ? `/private${path}` : path),
		// like checkoutOf, which resolves the physical path itself
		checkout: (cwd) => { const at = cwd.startsWith("/tmp/") ? `/private${cwd}` : cwd; return at === priv || at.startsWith(`${priv}/`) ? { kind: "linked", root: priv, gitdir: "/r/.git/worktrees/x" } : { kind: "none" }; },
		cwds: async (pids) => new Map(pids.filter((p) => p === 300).map((p) => [p, { path: `${priv}/pkg` }])),
	});
	await procs.hello({ pid: 100, id: "w1", cwd: "/tmp/psb-f1b/wt/src" });
	assert.deepEqual(procs.list()[0]!.roots, [priv], "the root is the physical one lsof reports");
	await assert.rejects(procs.reapCheckout("/tmp/psb-f1b/wt/sub"), /live owner works in/, "the logical path finds the live owner");
	w.table = w.table.filter((p) => p.pid < 100 || p.pid > 102);
	await procs.tick();
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[300]]);
	// a second owner whose reap left a process keeps its record; its checkout is then gone from disk: its known root, and only that, can be reaped
	await procs.hello({ pid: 200, id: "w2", cwd: priv });
	w.gone.add(`${priv}/pkg`).add("/private/tmp/psb-f1b/elsewhere");
	w.table = w.table.filter((p) => p.pid !== 200);
	await procs.tick();
	await procs.settled();
	await assert.rejects(procs.reapCheckout("/tmp/psb-f1b/elsewhere"), /gone and no known worker/);
});

test("T2R-F001: a checkout that is gone is reaped through the known root above it", async () => {
	const priv = "/private/tmp/psb-f1c/wt";
	const { w, procs } = world({
		real: (path) => (path.startsWith("/tmp/") ? `/private${path}` : path),
		checkout: (cwd) => ({ kind: "linked", root: cwd.startsWith("/tmp/") ? `/private${cwd}` : cwd, gitdir: "/r/.git/worktrees/x" }),
		reap: async () => ({ termed: 1, killed: 1, skipped: 0, groups: 0, left: [{ pid: 7, program: "node" }] }),
		cwds: async (pids) => new Map(pids.filter((p) => p === 300).map((p) => [p, { path: `${priv}/pkg` }])),
	});
	await procs.hello({ pid: 200, id: "w2", cwd: "/tmp/psb-f1c/wt" });
	w.table.push(P(201, 200));
	await procs.tick();
	w.table = w.table.filter((p) => p.pid !== 200);
	await procs.tick();
	await procs.settled();
	assert.deepEqual(procs.list().map((o) => [o.id, o.live]), [["w2", false]], "the record stays: something was left");
	w.gone.add(`${priv}/pkg`);
	const result = await procs.reapCheckout("/tmp/psb-f1c/wt/pkg");
	assert.equal(result.owner, "w2", "the known owner's root covers the removed folder");
});

test("T2R-F013 and F006: a subscription that throws is one error line and the registry still starts; a test run reads no table of this machine unless a test gives one", async () => {
	const { startProcs } = await import("../src/server/procsops.ts");
	const logs: { event: string; facts: Record<string, unknown> }[] = [], timers: ReturnType<typeof setInterval>[] = [], stops: (() => void)[] = [];
	const procs = startProcs({
		dir, stateDir: dir, env: {}, pid: 9000, platform: "darwin", now: () => 1, log: (event, facts) => void logs.push({ event, facts }), run: async () => "{}", leaving: () => false, stops, timers,
		events: () => { throw new Error("events.subscribe refused"); }, over: { tickMs: 3_600_000 },
	});
	for (let i = 0; i < 50 && !logs.some((l) => l.event === "procs-tick-cost"); i++) await new Promise((done) => setImmediate(done));
	try {
		assert.equal(logs.filter((l) => l.event === "error").length, 1);
		assert.match(String(logs.find((l) => l.event === "error")!.facts.text), /events\.subscribe refused/);
		assert.deepEqual(stops, [], "no subscription to stop");
		assert.equal(timers.length, 1, "the tick timer is still started");
		assert.equal(logs.find((l) => l.event === "procs-tick-cost")!.facts.procs, 0, "no ps of this machine in a test run");
		assert.deepEqual(procs.list(), []);
	} finally {
		for (const t of timers) clearInterval(t);
	}
});

test("T2R-F002: a reap that a restart cut off is run again by the next start; one that left something stays for `reap`", async () => {
	const first = world({ reap: () => new Promise(() => {}) });
	await first.procs.hello({ pid: 100, id: "w1" });
	await first.procs.hello({ pid: 200, id: "w2" });
	await first.procs.tick();
	first.procs.bye("w1");
	await first.procs.tick(); // the record was saved as ended, and the reap never finishes: the server goes down here
	assert.deepEqual(first.procs.list().map((o) => [o.id, o.live, o.endedReason]), [["w1", false, "bye"], ["w2", true, undefined]]);
	const second = world({}, dir);
	second.w.table = first.w.table.filter((p) => p.pid !== 100).map((p) => (p.pid === 101 ? { ...p, ppid: 1 } : p));
	await second.procs.start();
	await second.procs.settled();
	assert.deepEqual(pids(second.w.reaped), [[101, 102]], "the ended owner's snapshot is reaped after the restart");
	assert.deepEqual(second.procs.list().map((o) => o.id), ["w2"]);
	// a reap that left a process is not repeated at start, and `reap --owner` still works
	const third = world({ reap: async () => ({ termed: 1, killed: 1, skipped: 0, groups: 0, left: [{ pid: 7, program: "node" }] }) }, dir);
	await third.procs.hello({ pid: 300, id: "w3" });
	third.w.table.push(P(301, 300));
	await third.procs.tick();
	third.procs.bye("w3");
	await third.procs.settled();
	const fourth = world({}, dir);
	await fourth.procs.start();
	await fourth.procs.settled();
	assert.deepEqual(fourth.w.reaped, [], "a record marked as left is not reaped again by a restart");
	assert.deepEqual(fourth.procs.list().filter((o) => !o.live).map((o) => o.id), ["w3"]);
});

test("T2R-F003: a slow reap of an ended owner does not delete a newer owner that took the same id", async () => {
	let release!: () => void;
	const held = new Promise<void>((done) => (release = done));
	const { w, procs } = world({ reap: async (refs) => (await held, { termed: refs.length, killed: 0, skipped: 0, groups: 0, left: [] }) });
	await procs.hello({ pid: 100, id: "w1" });
	await procs.tick();
	procs.bye("w1");
	await procs.hello({ pid: 200, id: "w1" }); // the same id again, a new pi
	release();
	await procs.settled();
	assert.deepEqual(procs.list().map((o) => [o.id, o.pid, o.live]), [["w1", 200, true]], "the new owner is still tracked");
	assert.ok(JSON.parse(readFileSync(join(dir, "procs", "owners.json"), "utf8")).owners.some((o: { id: string; pid: number }) => o.id === "w1" && o.pid === 200), "and saved");
	assert.ok(w.table.some((p) => p.pid === 200));
});

test("T2R-F004: a second hello with the id of a live owner is refused and the live owner's tree is not touched; the id of a dead one is taken over", async () => {
	const { w, procs } = world();
	await procs.hello({ pid: 100, id: "sub-7" });
	await procs.tick();
	await assert.rejects(procs.hello({ pid: 200, id: "sub-7" }), (error: Error) => error instanceof ProcsRefusal && /in use by pid 100/.test(error.message));
	await procs.settled();
	assert.deepEqual(w.reaped, [], "nothing of the live owner was killed");
	assert.deepEqual(procs.list().map((o) => [o.id, o.pid, o.live]), [["sub-7", 100, true]]);
	// the same pid says hello again: the same owner, snapshot kept
	await procs.hello({ pid: 100, id: "sub-7" });
	assert.equal(procs.list()[0]!.snapshot, 2);
	// pid 100 is gone: the id is free, the old record is reaped behind the call, and the hello does not wait for it
	w.table = w.table.filter((p) => p.pid !== 100);
	await procs.hello({ pid: 300, id: "sub-7" });
	await procs.settled();
	assert.deepEqual(procs.list().map((o) => [o.id, o.pid, o.live]), [["sub-7", 300, true]]);
	assert.deepEqual(pids(w.reaped), [[101, 102]]);
});

test("T2R-F005: a pane that closes in a linked worktree with no owner gets the cwd rule alone; a live owner or another pane in the worktree, or a main workspace, keeps it off", async () => {
	const wt = "/tmp/psb-f5/wt";
	const { w, procs } = world({ cwds: async (pids) => new Map(pids.filter((p) => p === 300 || p === 301).map((p) => [p, { path: `${wt}/pkg` }])) });
	w.roots.set(wt, "linked");
	w.workspaces = [{ workspace_id: "ws1", checkout_path: wt }];
	// a pane with another live pane in the same worktree
	w.panes = [{ pane_id: "p9", terminal_id: "t9", cwd: `${wt}/x` }];
	await procs.paneEvent({ event: "pane.closed", data: { pane_id: "p1", workspace_id: "ws1" } });
	assert.deepEqual(w.reaped, [], "another pane works there");
	// a live owner in the same worktree
	w.panes = [];
	await procs.hello({ pid: 100, id: "w1", cwd: wt });
	await procs.paneEvent({ event: "pane.closed", data: { pane_id: "p1", workspace_id: "ws1" } });
	assert.deepEqual(w.reaped, [], "a live owner works there");
	w.table = w.table.filter((p) => p.pid < 100 || p.pid > 102);
	procs.bye("w1");
	await procs.settled();
	w.reaped.length = 0;
	w.table.push(P(300, 1), P(301, 1));
	// a workspace that is not a linked worktree (not in the list) reaps nothing
	await procs.paneEvent({ event: "pane.closed", data: { pane_id: "p1", workspace_id: "wsMain" } });
	assert.deepEqual(w.reaped, []);
	// the pane of the linked worktree closes with nothing else there: its orphans go, the other orphans stay
	await procs.paneEvent({ event: "pane.exited", data: { pane_id: "p1", workspace_id: "ws1" } });
	assert.deepEqual(pids(w.reaped), [[300, 301]]);
	assert.ok(w.table.some((p) => p.pid === 200), "an orphan elsewhere stays");
	// an owner's own pane is the owner's: no second path
	w.reaped.length = 0;
	await procs.hello({ pid: 200, id: "w2", pane: "p2", terminal: "t2" });
	await procs.paneEvent({ event: "pane.closed", data: { pane_id: "p2", terminal_id: "t2", workspace_id: "ws1" } });
	await procs.settled();
	assert.ok(pids(w.reaped).every((r) => !r.includes(300)), "the owner's end is the one reap");
});

test("T2R-F008: a pid the table does not list is refused even when a start time can be read for it", async () => {
	const { procs } = world({ startOf: () => "tX" });
	await assert.rejects(procs.hello({ pid: 999 }), ProcsRefusal);
});

test("T2R-F011: the adopted orphans of a full snapshot are the ones kept; a corrupt owners.json is said once and set aside, not overwritten", async () => {
	const { w, procs } = world();
	await procs.hello({ pid: 100, id: "w1" });
	await procs.tick();
	w.table = w.table.filter((p) => p.pid !== 101).concat(P(102, 1, { ppid: 1 }));
	w.table = w.table.map((p) => (p.pid === 102 ? { ...p, ppid: 1 } : p));
	for (let i = 0; i < 3; i++) w.table.push(P(500 + i, 100));
	await procs.tick();
	assert.ok(JSON.parse(readFileSync(join(dir, "procs", "owners.json"), "utf8")).owners[0].snapshot.some((s: Ref) => s.pid === 102), "an adopted orphan is in the snapshot");
	// a corrupt file
	const bad = mkdtempSync(join(tmpdir(), "psb-procs-bad-"));
	dirs.push(bad);
	mkdirSync(join(bad, "procs"));
	writeFileSync(join(bad, "procs", "owners.json"), "{ not json");
	const second = world({}, bad);
	await second.procs.start();
	assert.deepEqual(second.lines("procs-error").map((f) => String(f.text).startsWith("owners.json is not readable")), [true]);
	assert.equal(readFileSync(join(bad, "procs", "owners.json.bad"), "utf8"), "{ not json");
	await second.procs.hello({ pid: 100, id: "w9" });
	assert.equal(readFileSync(join(bad, "procs", "owners.json.bad"), "utf8"), "{ not json", "the first file is kept after the next save");
});

/** A world with a worktree `wt` (linked) where owner w1 (pid 100) works and orphans 300 and 301 have their folder; 301 is in `wt/inner` when `inner` is set. */
function held(over: Partial<ProcsDeps> = {}, inner = false) {
	const wt = "/tmp/psb-rr/wt", where = (pid: number) => (pid === 300 ? `${wt}/pkg` : pid === 301 ? `${wt}/${inner ? "inner/" : ""}pkg` : undefined);
	const made = world({ cwds: async (pids) => new Map(pids.flatMap((pid) => (where(pid) ? [[pid, { path: where(pid)! }] as const] : []))), ...over });
	if (inner) made.w.roots.set(`${wt}/inner`, "linked");
	made.w.roots.set(wt, "linked");
	made.w.table.push(P(301, 1));
	made.w.workspaces = [{ workspace_id: "ws1", checkout_path: wt }];
	return { ...made, wt };
}
const main = (over = {}) => ({ pane_id: "p9", terminal_id: "t9", cwd: "/tmp/psb-rr/wt/x", ...over });

test("RR-F001: when Herdr's panes are not known the cwd rule stays out of the reap, the record waits for the next ticks, and a session's orphans are not killed on a hiccup", async () => {
	let down = true, asked = 0;
	const { w, procs, wt, lines } = held({ panes: async () => { asked++; if (down) throw new Error("herdr timed out"); return w2.panes; } });
	const w2 = w;
	await procs.hello({ pid: 100, id: "w1", cwd: wt });
	await procs.tick();
	assert.ok(procs.bye("w1"));
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[101, 102]], "the snapshot rule ran, the orphans of the worktree (300, 301) were not touched");
	assert.deepEqual(procs.list().map((o) => [o.id, o.live]), [["w1", false]], "the record stays for a retry");
	assert.equal(lines("procs-held-unknown").length, 1);
	assert.deepEqual(lines("procs-reaped").map((f) => f.deferred), [true]);
	// Herdr answers again, and a main session works in the same worktree: the retry spares what is its
	down = false;
	w.panes = [main()];
	await procs.tick();
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[101, 102]], "300 and 301 stay: a session works there");
	assert.deepEqual(procs.list(), [], "the retry finished the reap");
});

test("RR-F001: the retry reaps the orphans once the panes are known and none works in the worktree; it gives up after DEFER_MAX and leaves the record for `reap`", async () => {
	let down = true;
	const { w, procs, wt } = held({ panes: async () => { if (down) throw new Error("down"); return []; } });
	await procs.hello({ pid: 100, id: "w1", cwd: wt });
	await procs.tick();
	procs.bye("w1");
	await procs.settled();
	down = false;
	await procs.tick();
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[101, 102], [300, 301]], "the next tick killed the orphans of the worktree");
	assert.deepEqual(procs.list(), []);

	const gone = held({ panes: async () => { throw new Error("down"); } });
	await gone.procs.hello({ pid: 100, id: "w1", cwd: gone.wt });
	gone.procs.bye("w1");
	await gone.procs.settled();
	for (let i = 0; i < DEFER_MAX + 2; i++) {
		await gone.procs.tick();
		await gone.procs.settled();
	}
	assert.equal(gone.lines("procs-held-unknown").length, DEFER_MAX, "tried DEFER_MAX times, then no more");
	assert.deepEqual(gone.procs.list().map((o) => o.id), ["w1"], "the record stays for `reap`");
	assert.ok(gone.w.table.some((p) => p.pid === 300), "nothing was killed on a guess");
});

test("RR-F001: a pane without a folder is placed by its workspace; one that cannot be placed makes the panes unknown", async () => {
	const run = async (pane: object, workspaces?: () => Promise<{ workspace_id: string; checkout_path: string }[]>) => {
		const made = held({ ...(workspaces ? { workspaces } : {}) });
		made.w.panes = [pane as never];
		await made.procs.hello({ pid: 100, id: "w1", cwd: made.wt });
		made.procs.bye("w1");
		await made.procs.settled();
		return made;
	};
	const inWt = await run({ pane_id: "p9", workspace_id: "ws1" });
	assert.ok(inWt.w.table.some((p) => p.pid === 300), "its workspace is the worktree: a session works there");
	assert.equal(inWt.lines("procs-held-unknown").length, 0);
	const elsewhere = await run({ pane_id: "p9", workspace_id: "wsMain" });
	assert.ok(!elsewhere.w.table.some((p) => p.pid === 300), "its workspace is a main checkout: it holds no worktree");
	const nowhere = await run({ pane_id: "p9" });
	assert.ok(nowhere.w.table.some((p) => p.pid === 300), "no folder and no workspace: unknown, the orphans stay");
	assert.equal(nowhere.lines("procs-held-unknown").length, 1);
	const unreadable = await run({ pane_id: "p9", workspace_id: "wsMain" }, async () => { throw new Error("no workspaces"); });
	assert.ok(unreadable.w.table.some((p) => p.pid === 300), "the workspaces cannot be read: unknown");
});

test("RR-F002: reap --owner keeps the session-held rule; reap --checkout is the caller's word", async () => {
	let down = true;
	const { w, procs, wt } = held({ panes: async () => { if (down) throw new Error("down"); return w.panes; } });
	await procs.hello({ pid: 100, id: "w1", cwd: wt });
	await procs.tick();
	procs.bye("w1");
	await procs.settled();
	down = false;
	w.panes = [main()];
	const result = await procs.reapOwner("w1");
	assert.equal(result.targets, 0, "a main works in w1's root now: its orphan 300 is not w1's");
	assert.ok(w.table.some((p) => p.pid === 300));
	assert.equal(procs.list().length, 0, "the owner is done");
	const forced = await procs.reapCheckout(wt);
	assert.ok(forced.targets >= 2, "the explicit checkout reap does not look at panes");
});

test("RR-F003: a hello is refused for the Herdr server, a pane's shell, this server, an sb server, the broker, a shell, and anything above Herdr or a pane's shell; a pane's foreground (the pi) is accepted", async () => {
	const { w, procs } = world({
		protect: async () => [{ pid: 50, started: "t50", why: "herdr" }, { pid: 51, why: "pane" }, { pid: 52, why: "pane-foreground" }, { pid: 70, why: "sb-server", tree: true }, { pid: 71, why: "intercom-broker", tree: true }],
	});
	w.table = [P(49, 1, { comm: "/Applications/Terminal" }), P(50, 49, { comm: "/usr/local/bin/herdr" }), P(51, 50, { comm: "zsh" }), P(52, 51), P(53, 52), P(54, 53), P(60, 1, { comm: "-zsh" }), P(70, 1), P(71, 1), P(9000, 1), P(80, 1)];
	for (const [pid, what] of [[50, /protected \(herdr\)/], [51, /shell/], [49, /above Herdr/], [60, /a shell/], [70, /sb-server/], [71, /intercom-broker/], [9000, /this server/]] as const) {
		await assert.rejects(procs.hello({ pid, id: `x${pid}` }), (e: Error) => e instanceof ProcsRefusal && what.test(e.message), `pid ${pid}`);
	}
	assert.deepEqual(await procs.hello({ pid: 52, id: "pi" }), { id: "pi" }, "the foreground of a pane is the worker's pi");
	assert.deepEqual(await procs.hello({ pid: 80, id: "pi2" }), { id: "pi2" });
	// the bye of the accepted pi kills only its own tree, never Herdr's
	await procs.tick();
	procs.bye("pi");
	await procs.settled();
	assert.deepEqual(pids(w.reaped), [[53, 54]]);
});

test("FR-F003: a herdr CLI child below a worker's pi does not make the hello refused; only a Herdr server (one with a pane shell below it) counts", async () => {
	const { w, procs } = world({
		protect: async () => [{ pid: 50, started: "t50", why: "herdr" }, { pid: 51, why: "pane" }, { pid: 52, why: "pane-foreground" }, { pid: 53, started: "t53", why: "herdr" }],
	});
	w.table = [P(49, 1, { comm: "/Applications/Terminal" }), P(50, 49, { comm: "/usr/local/bin/herdr" }), P(51, 50, { comm: "zsh" }), P(52, 51), P(53, 52, { comm: "herdr" })];
	assert.deepEqual(await procs.hello({ pid: 52, id: "pi" }), { id: "pi" }, "a herdr CLI child of the worker is no Herdr server");
	await assert.rejects(procs.hello({ pid: 49, id: "term" }), (e: Error) => e instanceof ProcsRefusal && /above Herdr/.test(e.message), "the real server is still above-refused");
});

test("GR-F002: with Herdr silent about its panes, a hello above the Herdr server is still refused", async () => {
	const { w, procs } = world({ protect: async () => [{ pid: 50, started: "t50", why: "herdr" }] });
	w.table = [P(49, 1, { comm: "/Applications/Terminal" }), P(50, 49, { comm: "/usr/local/bin/herdr" }), P(51, 50, { comm: "zsh" }), P(52, 51)];
	await assert.rejects(procs.hello({ pid: 49, id: "term" }), (e: Error) => e instanceof ProcsRefusal && /above Herdr/.test(e.message));
});

test("FR-F006: a hello naming the foreground pi of another pane is refused when it states its own pane", async () => {
	const { w, procs } = world({
		protect: async () => [{ pid: 51, why: "pane" }, { pid: 52, why: "pane-foreground", pane: "p1" }, { pid: 62, why: "pane-foreground", pane: "p2" }],
	});
	w.table = [P(50, 1, { comm: "herdr" }), P(51, 50, { comm: "zsh" }), P(52, 51), P(61, 50, { comm: "zsh" }), P(62, 61)];
	await assert.rejects(procs.hello({ pid: 62, id: "x", pane: "p1" }), (e: Error) => e instanceof ProcsRefusal && /another pane/.test(e.message));
	assert.deepEqual(await procs.hello({ pid: 52, id: "pi", pane: "p1" }), { id: "pi" });
	assert.deepEqual(await procs.hello({ pid: 62, id: "pi2", pane: "p2" }), { id: "pi2" });
});

test("RR-F004: a failed write of owners.json is one log line, not an unhandled rejection that would take the server down", async (t) => {
	if (process.getuid?.() === 0) return t.skip("root writes anywhere");
	const { w, procs, lines } = world({}, dir);
	await procs.hello({ pid: 100, id: "w1" });
	await procs.tick();
	chmodSync(join(dir, "procs"), 0o500); // the folder turns read-only while the reap runs
	try {
		procs.bye("w1");
		await procs.settled();
		await new Promise((done) => setImmediate(done));
		assert.deepEqual(pids(w.reaped), [[101, 102]], "the reap ran");
		assert.ok(lines("procs-error").some((f) => /owners\.json was not written/.test(String(f.text))));
		const again = await procs.hello({ pid: 200, id: "w2" });
		assert.deepEqual(again, { id: "w2" }, "a hello still answers");
	} finally {
		chmodSync(join(dir, "procs"), 0o700);
	}
});

test("RR-F008: a reap with no registered owner uses a name no process can carry as its marker, and a pane event looks at the workspaces again before it trusts the map", async () => {
	const marked = held({ markers: async () => new Map([[400, "checkout"], [401, "pane-p1"]]) });
	marked.w.table.push(P(400, 1), P(401, 1));
	await marked.procs.reapCheckout(marked.wt);
	assert.ok(marked.w.table.some((p) => p.pid === 400), "a process that carries the marker `checkout` is not the synthetic subject's");
	await marked.procs.paneEvent({ event: "pane.closed", data: { pane_id: "p1", workspace_id: "ws1" } });
	assert.ok(marked.w.table.some((p) => p.pid === 401), "`pane-p1` is not the subject of a pane close either");

	// Herdr reused the workspace id for another worktree between two ticks
	const wtA = "/tmp/psb-rr/wtA", wtB = "/tmp/psb-rr/wtB";
	const placeOf = (pid: number) => (pid === 300 ? `${wtA}/p` : pid === 301 ? `${wtB}/p` : undefined);
	const reuse = world({ cwds: async (ids) => new Map<number, { path: string }>(ids.flatMap((pid) => (placeOf(pid) ? [[pid, { path: placeOf(pid)! }] as [number, { path: string }]] : []))) });
	reuse.w.roots.set(wtA, "linked");
	reuse.w.roots.set(wtB, "linked");
	reuse.w.table.push(P(301, 1));
	reuse.w.workspaces = [{ workspace_id: "ws1", checkout_path: wtA }];
	await reuse.procs.tick();
	reuse.w.workspaces = [{ workspace_id: "ws1", checkout_path: wtB }];
	await reuse.procs.paneEvent({ event: "pane.closed", data: { pane_id: "p1", workspace_id: "ws1" } });
	assert.deepEqual(pids(reuse.w.reaped), [[301]], "the pane closed in the worktree the id means now");
	// a workspace that closed with its pane is gone from the list: its last known place is the one
	reuse.w.table.push(P(301, 1));
	reuse.w.reaped.length = 0;
	reuse.w.workspaces = [];
	await reuse.procs.paneEvent({ event: "pane.closed", data: { pane_id: "p1", workspace_id: "ws1" } });
	assert.deepEqual(pids(reuse.w.reaped), [[301]]);
});

test("RR-F008: reap --checkout takes an owner record only when its root is the one asked for, not one that merely overlaps", async () => {
	const { w, procs, wt } = held({ panes: async () => { throw new Error("down"); } }, true);
	await procs.hello({ pid: 100, id: "w1", cwd: wt });
	procs.bye("w1");
	await procs.settled();
	for (let i = 0; i < DEFER_MAX; i++) (await procs.tick(), await procs.settled());
	const result = await procs.reapCheckout(`${wt}/inner`);
	assert.equal(result.targets, 1, "only the orphan in the nested worktree");
	assert.ok(w.table.some((p) => p.pid === 300), "the orphan in the outer root is not the nested worktree's");
});

test("kit2-F003: a pane close's checkout reap takes only what works in the root, never the caller, what it runs under, or an ended owner's old snapshot", async () => {
	const wt = "/tmp/psb-k2/wt";
	const cwdOf: Record<number, string> = { 101: "/else", 102: "/else", 500: wt, 501: wt, 502: wt, 503: "/else", 600: `${wt}/app`, 601: "/tmp", 602: wt };
	let failing = true;
	const options: unknown[] = [];
	const { w, procs } = world({
		cwds: async (asked) => new Map(asked.filter((pid) => cwdOf[pid] !== undefined).map((pid) => [pid, { path: cwdOf[pid]! }])),
		reap: async (refs, opts): Promise<KillReport> => {
			if (!failing) options.push(opts);
			if (failing) throw new Error("the process table could not be read; nothing was signalled");
			w.reaped.push([...refs]);
			w.table = w.table.filter((p) => !refs.some((r) => r.pid === p.pid && r.started === p.started));
			return { termed: refs.length, killed: 0, skipped: 0, groups: 0, left: [] };
		},
	});
	w.roots.set(wt, "linked");
	// 500 is a shell init adopted that works in the checkout, 501 a monitor under it, 502 the caller (the pane close's CLI), 503 another child of 500 that works elsewhere; 600 is the loop the pane left, with
	// a child 601 that works outside the checkout and 602 that works in it.
	w.table.push(P(500, 1), P(501, 500), P(502, 501), P(503, 500), P(600, 1), P(601, 600), P(602, 600));
	await procs.hello({ pid: 100, id: "w1", cwd: wt });
	await procs.tick();
	procs.bye("w1");
	await procs.settled();
	assert.equal(procs.list()[0]?.snapshot, 2, "the ended owner's reap failed: its record keeps a snapshot of 101 and 102, which work elsewhere");
	failing = false;
	const result = await procs.reapCheckout(wt, { caller: { pid: 502, started: "t502" } });
	assert.deepEqual(options, [{ groups: false }], "the bounded reap signals one verified pid at a time, never a group");
	assert.deepEqual(pids(w.reaped), [[600, 602]], "the orphan in the root and its child in the root; not 601 (elsewhere), not the caller or what it runs under, not the old snapshot");
	assert.equal(result.owner, "(checkout)");
	assert.ok(procs.list().some((o) => o.id === "w1"), "the ended owner's record is not the pane close's to drop");
});

test("kit2-F003: a pane close's checkout reap refuses a folder that is not a linked worktree's root, and a caller it cannot verify", async () => {
	const wt = "/tmp/psb-k2b/wt";
	const { w, procs } = world({ cwds: async (asked) => new Map(asked.map((pid) => [pid, { path: wt }])) });
	w.roots.set(wt, "linked");
	w.mains.add("/tmp/psb-k2b/main");
	w.gone.add("/tmp/psb-k2b/gone");
	w.table.push(P(502, 1), P(600, 1));
	const caller = { pid: 502, started: "t502" };
	for (const path of [`${wt}/sub`, "/tmp/psb-k2b/main", "/tmp/psb-k2b/gone", "/tmp/psb-k2b"]) await assert.rejects(procs.reapCheckout(path, { caller }), (error: Error) => error instanceof ProcsRefusal && /the root of a linked worktree/.test(error.message), path);
	await assert.rejects(procs.reapCheckout(wt, { caller: { pid: 502, started: "t999" } }), (error: Error) => error instanceof ProcsRefusal && /caller \(pid 502\) is not in the process table with the start time it gave/.test(error.message));
	assert.deepEqual(w.reaped, []);
});

test("kit2-F003: the bounded reap is a command of its own, procs-reap-bounded, with a checkout and its caller { pid, started }; procs-reap takes no caller", async () => {
	const asked: unknown[] = [];
	const done = { owner: "(checkout)", reason: "pane-close", targets: 0, termed: 0, killed: 0, skipped: 0, left: [], spared: 0 };
	const reg = { reapCheckout: async (path: string, bounded?: unknown) => (asked.push([path, bounded]), done), reapOwner: async () => done } as unknown as Procs;
	assert.deepEqual(await procsReply(reg, { cmd: "procs-reap-bounded", checkout: "/wt", caller: { pid: 502, started: "t502" } }), { ok: true, ...done });
	assert.deepEqual(await procsReply(reg, { cmd: "procs-reap", checkout: "/wt" }), { ok: true, ...done });
	assert.deepEqual(asked, [["/wt", { caller: { pid: 502, started: "t502" } }], ["/wt", undefined]]);
	assert.deepEqual(await procsReply(reg, { cmd: "procs-reap", checkout: "/wt", caller: { pid: 502, started: "t502" } }), { ok: false, error: "procs-reap needs an owner or a checkout, not both, and no caller (a pane close's reap is procs-reap-bounded)" });
	for (const bad of [{ checkout: "/wt", caller: { pid: 1, started: "t1" } }, { checkout: "/wt", caller: { pid: 502 } }, { checkout: "/wt", caller: { pid: "502", started: "t502" } }, { checkout: "/wt", caller: "502" }, { checkout: "/wt" }, { caller: { pid: 502, started: "t502" } }, {}, { owner: "w1", checkout: "/wt", caller: { pid: 502, started: "t502" } }]) {
		assert.deepEqual(await procsReply(reg, { cmd: "procs-reap-bounded", ...bad }), { ok: false, error: "procs-reap-bounded needs a checkout and its caller { pid, started }" }, JSON.stringify(bad));
	}
	assert.equal(asked.length, 2);
});

test("kit2-F003: a plain reap --checkout keeps the kill sequence's group signal", async () => {
	const wt = "/tmp/psb-k2c/wt", options: unknown[] = [];
	const { w, procs } = world({ cwds: async (asked) => new Map(asked.map((pid) => [pid, { path: wt }])), reap: async (refs, opts) => (options.push(opts), { termed: refs.length, killed: 0, skipped: 0, groups: 0, left: [] }) });
	w.roots.set(wt, "linked");
	w.table.push(P(600, 1));
	await procs.reapCheckout(wt);
	assert.deepEqual(options, [undefined]);
});
