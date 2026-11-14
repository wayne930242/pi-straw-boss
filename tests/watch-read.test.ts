import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Monitor } from "../src/monitors.ts";
import type { Found, Net, Unit } from "../src/net.ts";
import { callControl, listenControl, newSecret, type Reply, type Request } from "../src/server/socket.ts";
import { watchdogReply } from "../src/server/watchdogops.ts";
import { createWatchRead, HOLD_MS, type WatchNet } from "../src/server/watchread.ts";
import type { Yards } from "../src/train/yardview.ts";
import { World } from "./fakes.ts";
import { fakeClock } from "./fake-clock.ts";
import { type Hosted, startHosted } from "./gui-world.ts";

// The sb server's `watch-read` route (docs/specs/2026-11-09-agent-kinds.md §10; the wire contract of ~/.local/share/sbd-review/phase3/plan.md §2): one hold on one net unit, answered by the first reading whose verdict is not `unchanged`,
// at the deadline, or by the hold's own timer. Every wait here is on a clock the test moves; the two tests on a real socket wait only for a reply.

const unit = (over: Partial<Unit> = {}): Unit => ({ id: "u1", key: "u1", control: true, name: "coord", role: "main", mark: "working", subs: [], ...over });
const netOf = (units: Unit[], yards?: Yards): Net => ({ bases: [{ id: "w1", label: "w", mark: "working", tower: null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], ...(yards ? { yards } : {}) });
const monitor = (over: Partial<Monitor> = {}): Monitor => ({ id: "m1", what: "npm test", status: "running", lines: 1, at: 0, ...over });
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r)); };
type Answer = Reply & { state?: string; since?: string; now?: number; unit?: Record<string, unknown>; successor?: string };

/** A net the test reads by hand: `beat` is one reading of the GUI host, `feedless` a host that reads nothing (the GUI is stopped), so only the route's own read sees `next`. */
function world(first?: Net, o: { holdMs?: number; feedless?: boolean } = {}) {
	const clock = fakeClock(1_700_000_000_000), listeners = new Set<(net: Net) => void>(), gone = new Map<string, Found>();
	let last = first, next = first, reads = 0;
	const keys = (net: Net | undefined) => (net?.bases ?? []).flatMap((b) => b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs])));
	const net: WatchNet = {
		onRead: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
		last: () => last,
		lookup: (key) => { const u = keys(last).find((x) => x.key === key); return u ? { key, base: "w1", name: u.name, role: u.role, live: true } : gone.get(key); },
		read: async () => { reads++; if (!next) throw new Error("no net"); return (last = next); },
	};
	const timer = (ms: number, fn: () => void) => { let live = true; clock.at(clock.elapsed() + ms, () => live && fn()); return () => void (live = false); };
	const watch = createWatchRead({ net, now: clock.now, timer, ...(o.holdMs ? { holdMs: o.holdMs } : {}) });
	const w = {
		clock, watch, gone, reads: () => reads,
		/** One reading `ms` later. */
		async beat(reading: Net, ms = 2000) { clock.advance(ms); next = reading; if (!o.feedless) { last = reading; for (const cb of listeners) cb(reading); } await settle(); },
		/** Time passes with no reading. */
		async pass(ms: number) { clock.advance(ms); await settle(); },
		set(reading: Net) { next = reading; },
		/** A hold: `reply()` is its answer once it has one. */
		hold(q: Record<string, unknown>) { let got: Answer | undefined; void watch.read({ key: "u1", ...q } as never).then((r) => (got = r as Answer)); return { reply: () => got }; },
		async ask(q: Record<string, unknown> = {}): Promise<Answer> { const h = w.hold(q); await settle(); assert.ok(h.reply(), "answered at once"); return h.reply()!; },
		/** What a client's loop sees: holds with the same query, one after another, with a reading every 2 s that `reading(i)` gives, until a reply is not `unchanged` or `ms` have passed. */
		async follow(q: Record<string, unknown>, reading: (i: number) => Net, ms: number): Promise<Answer | undefined> {
			let since = q.since as string | undefined, h = w.hold({ ...q, since });
			for (let i = 1; i <= ms / 2000; i++) {
				await w.beat(reading(i));
				const r = h.reply();
				if (r && r.state !== "unchanged") return r;
				if (r) h = w.hold({ ...q, since: (since = r.since) });
			}
			return undefined;
		},
	};
	return w;
}

test("a stamp that is absent, not one of this server's, or from another server instance returns `changed` at once with the unit, a stamp, and `now`", async () => {
	const w = world(netOf([unit({ note: "running tests", todo: { done: 1, total: 3, now: "write tests" } })]));
	const first = await w.ask();
	assert.equal(first.ok, true);
	assert.equal(first.state, "changed");
	assert.equal(first.now, w.clock.now());
	assert.deepEqual(first.unit, { mark: "working", note: "running tests", todo: { done: 1, total: 3, now: "write tests" } });
	assert.ok(typeof first.since === "string" && first.since.length > 0 && first.since.length <= 512);
	assert.equal((await w.ask({ since: "garbage" })).state, "changed");
	const other = world(netOf([unit({ note: "running tests", todo: { done: 1, total: 3, now: "write tests" } })]));
	assert.equal((await other.ask({ since: first.since })).state, "changed", "the same facts under another server's stamp");
	const held = w.hold({ since: first.since });
	await settle();
	assert.equal(held.reply(), undefined, "this server's own stamp of the same facts holds");
});

test("a monitor that prints a line a second, a note, ticks, and load readings under the limit do not wake a hold; its own 45 s timer answers `unchanged` with the last reading", async () => {
	const reading = (i: number) => netOf([unit({ note: `step ${i}`, ticks: [{ at: i, mark: "working" }], monitors: [monitor({ lines: i, last: `line ${i}`, at: 1_700_000_000_000 + i * 1000, load: { max: 30, now: i % 20 } })] })]);
	const w = world(reading(0));
	const first = await w.ask();
	const held = w.hold({ since: first.since });
	for (let i = 1; i <= 22; i++) {
		await w.beat(reading(i));
		assert.equal(held.reply(), undefined, `reading ${i} at ${i * 2} s`);
	}
	await w.pass(1000);
	const r = held.reply()!;
	assert.equal(r.state, "unchanged");
	assert.equal(w.clock.elapsed(), HOLD_MS);
	assert.equal(r.now, w.clock.now());
	assert.deepEqual((r.unit!.monitors as { last: string }[])[0]!.last, "line 22", "the last reading");
	assert.equal(w.watch.holds(), 0);
});

test("a monitor's status, a todo completion, a train's step, a subagent's mark, and the unit's own mark each wake a hold with `changed`", async () => {
	const yard = (status: "in_progress" | "completed", waits: unknown[] = []): Yards => ({ projects: [{ project: "p", forming: [], waiting: [], trains: [{ code: "1114-a", state: "live", key: "u1", cars: [], steps: [{ id: 1, kind: "full-check", name: "unit", status, round: 1, waits: waits as never, ...(status === "completed" ? { outcome: "passed" as const } : {}) }, { id: 2, kind: "merge", name: "merge", status: "pending", round: 1, waits: [] }] }] }] });
	const sub = (mark: Unit["mark"]) => unit({ id: "s1", key: "s1", name: "scout-a", role: "subagent", mark });
	const cases: [string, Net, Net][] = [
		["monitor status", netOf([unit({ monitors: [monitor()] })]), netOf([unit({ monitors: [monitor({ status: "error", exit: 1 })] })])],
		["todo completion", netOf([unit({ todo: { done: 1, total: 3 } })]), netOf([unit({ todo: { done: 2, total: 3 } })])],
		["train step", netOf([unit({ role: "train" })], yard("in_progress")), netOf([unit({ role: "train" })], yard("completed"))],
		["train wait", netOf([unit({ role: "train" })], yard("in_progress")), netOf([unit({ role: "train" })], yard("in_progress", [{ lane: { app: "fe2", holder: "1114-b" } }]))],
		["subagent mark", netOf([unit({ subs: [sub("working")] })]), netOf([unit({ subs: [sub("done")] })])],
		["mark", netOf([unit()]), netOf([unit({ mark: "waiting" })])],
	];
	for (const [name, before, after] of cases) {
		const w = world(before), first = await w.ask(), held = w.hold({ since: first.since });
		await w.beat(before);
		assert.equal(held.reply(), undefined, `${name}: the same reading holds`);
		await w.beat(after);
		assert.equal(held.reply()?.state, "changed", name);
		assert.notEqual(held.reply()!.since, first.since, name);
		const again = w.hold({ since: held.reply()!.since });
		await w.beat(after);
		assert.equal(again.reply(), undefined, `${name}: told once`);
	}
	const w = world(netOf([unit({ role: "train" })], yard("in_progress", [{ lane: { app: "fe2", holder: "1114-b" } }])));
	assert.deepEqual((await w.ask()).unit!.train, { status: "live", step: "1 full-check unit in_progress", waits: "waiting: lane fe2 (held by 1114-b)" });
});

test("`stalled` comes once after `quietMs` without a move, and again only after the unit moved and went quiet anew", async () => {
	const quiet = netOf([unit({ note: "a", monitors: [monitor({ lines: 5 })] })]);
	const w = world(quiet), q = { quietMs: 60_000 };
	const first = await w.ask(q);
	const stalled = await w.follow({ ...q, since: first.since }, () => quiet, 120_000);
	assert.equal(stalled?.state, "stalled");
	assert.equal(w.clock.elapsed(), 60_000, "at quietMs");
	assert.equal(await w.follow({ ...q, since: stalled!.since }, () => quiet, 300_000), undefined, "once while nothing moves");
	const began = w.clock.elapsed();
	// A monitor line is a move, and no waking fact: the clock starts again without a `changed`.
	const moved = netOf([unit({ note: "a", monitors: [monitor({ lines: 6 })] })]);
	const again = await w.follow({ ...q, since: stalled!.since }, () => moved, 120_000);
	assert.equal(again?.state, "stalled");
	assert.equal(w.clock.elapsed() - began, 62_000, "quietMs after the reading that saw the move");
	assert.equal(await w.follow({ since: stalled!.since }, () => moved, 120_000), undefined, "no quietMs, no stalled");
});

test("a reading gap of 5 minutes (a sleeping Mac) restarts the quiet clock and gives no `stalled`", async () => {
	const quiet = netOf([unit()]), w = world(quiet), q = { quietMs: 60_000 };
	const first = await w.ask(q);
	assert.equal(await w.follow({ ...q, since: first.since }, () => quiet, 40_000), undefined);
	const held = w.hold({ ...q, since: first.since });
	await w.beat(quiet, 300_000);
	assert.notEqual(held.reply()?.state, "stalled", "the reading after the gap");
	const began = w.clock.elapsed();
	const stalled = await w.follow({ ...q, since: first.since }, () => quiet, 120_000);
	assert.equal(stalled?.state, "stalled");
	assert.equal(w.clock.elapsed() - began, 60_000, "a whole quietMs after the gap");
});

test("a move seen across a reading gap is a move: `stalled` told before it comes again once the unit is quiet anew (RP3-F004)", async () => {
	const quiet = netOf([unit({ monitors: [monitor({ lines: 5 })] })]), w = world(quiet), q = { quietMs: 60_000 };
	const first = await w.ask(q);
	const stalled = await w.follow({ ...q, since: first.since }, () => quiet, 120_000);
	assert.equal(stalled?.state, "stalled");
	// The server stood still for 5 minutes while the unit worked on: the reading after the gap shows more lines.
	const moved = netOf([unit({ monitors: [monitor({ lines: 9 })] })]);
	// No hold is open across the gap, so the route's own read (which this world answers with the reading before) stays out of it.
	await w.beat(moved, 300_000);
	const began = w.clock.elapsed();
	const again = await w.follow({ ...q, since: stalled!.since }, () => moved, 120_000);
	assert.equal(again?.state, "stalled");
	assert.equal(w.clock.elapsed() - began, 60_000, "a whole quietMs after the gap");
	// A gap with no move in it is no move: nothing more is told.
	await w.beat(moved, 300_000);
	assert.equal(await w.follow({ ...q, since: again!.since }, () => moved, 120_000), undefined);
});

test("a subagent target's quiet clock moves on its mark and on its note", async () => {
	const sub = (over: Partial<Unit> = {}) => netOf([unit({ subs: [unit({ id: "s1", key: "s1", name: "worker-a", role: "subagent", mark: "working", note: "a", ...over })] })]);
	const w = world(sub()), q = { key: "s1", quietMs: 60_000 };
	const first = await w.ask(q);
	assert.deepEqual(first.unit, { mark: "working", note: "a" });
	// A new note every 20 s: never 60 s quiet.
	assert.equal(await w.follow({ ...q, since: first.since }, (i) => sub({ note: `n${Math.floor(i / 10)}` }), 200_000), undefined, "the note moves the clock");
	const stalled = await w.follow({ ...q, since: first.since }, () => sub({ note: "n10" }), 120_000);
	assert.equal(stalled?.state, "stalled");
	const marked = await w.follow({ ...q, since: stalled!.since }, () => sub({ note: "n10", mark: "waiting" }), 10_000);
	assert.equal(marked?.state, "changed", "a mark is a waking fact too");
	const again = await w.follow({ ...q, since: marked!.since }, () => sub({ note: "n10", mark: "waiting" }), 120_000);
	assert.equal(again?.state, "stalled", "and a move: stalled comes again");
});

test("a monitor without load lines gives no `load`; a crossing of the limit gives `load` once, and again after the load fell back under; `loadMax` replaces the monitor's own limit", async () => {
	const at = (now?: number) => netOf([unit({ monitors: [monitor(now === undefined ? {} : { load: { max: 30, now } })] })]);
	const w = world(at());
	const first = await w.ask();
	assert.equal(await w.follow({ since: first.since }, () => at(), 60_000), undefined, "no load line");
	assert.equal(await w.follow({ since: first.since }, () => at(29), 20_000), undefined, "under the limit");
	const over = await w.follow({ since: first.since }, () => at(42), 10_000);
	assert.equal(over?.state, "load");
	assert.deepEqual((over!.unit!.monitors as { load?: unknown }[])[0]!.load, { max: 30, now: 42 });
	assert.equal(await w.follow({ since: over!.since }, (i) => at(40 + i), 60_000), undefined, "once while it stays over");
	// Under and over again, inside one hold and across holds.
	const back = w.hold({ since: over!.since });
	await w.beat(at(10));
	assert.equal(back.reply(), undefined, "falling under wakes nothing");
	await w.beat(at(50));
	assert.equal(back.reply()?.state, "load", "the next crossing");
	const low = world(at(12)), start = await low.ask({ loadMax: 10 });
	assert.equal(start.state, "changed");
	const crossed = low.hold({ since: start.since, loadMax: 10 });
	await low.beat(at(12));
	assert.equal(crossed.reply()?.state, "load", "over loadMax, under the monitor's own 30");
});

test("a hold answers `expired` at its deadline, a request past it at once, and every reply carries `now`", async () => {
	const quiet = netOf([unit()]), w = world(quiet);
	const first = await w.ask(), deadline = w.clock.now() + 20_000;
	const held = w.hold({ since: first.since, deadline });
	await w.beat(quiet, 19_000);
	assert.equal(held.reply(), undefined);
	await w.pass(1000);
	assert.equal(held.reply()?.state, "expired");
	assert.equal(held.reply()!.now, deadline);
	assert.deepEqual(held.reply()!.unit, { mark: "working" });
	const late = await w.ask({ since: first.since, deadline });
	assert.equal(late.state, "expired");
	assert.equal(late.now, w.clock.now());
});

test("20 holds at once on one unit are all answered by the reading that changes it, and none is left open", async () => {
	const w = world(netOf([unit()])), first = await w.ask();
	const holds = Array.from({ length: 20 }, () => w.hold({ since: first.since }));
	await w.beat(netOf([unit()]));
	assert.equal(w.watch.holds(), 20);
	await w.beat(netOf([unit({ mark: "idle" })]));
	assert.deepEqual(holds.map((h) => h.reply()?.state), Array(20).fill("changed"));
	assert.equal(w.watch.holds(), 0);
});

test("a unit that left the net is `gone` with its successor; a key the net never had is an error", async () => {
	const w = world(netOf([unit()])), first = await w.ask();
	const held = w.hold({ since: first.since });
	w.gone.set("u1", { key: "u1", base: "w1", name: "coord", role: "main", live: false, successor: "u2" });
	await w.beat(netOf([unit({ id: "u2", key: "u2" })]));
	const r = held.reply()!;
	assert.equal(r.state, "gone");
	assert.equal(r.successor, "u2");
	assert.equal(r.unit, undefined);
	assert.equal(typeof r.now, "number");
	assert.equal((await w.ask({ since: first.since })).state, "gone", "asked again");
	assert.deepEqual(await w.ask({ key: "nope" }), { ok: false, error: "unknown key nope" });
	// A key the registry holds that is no unit of the net (a run's read-only view): one reading more, then the same error.
	w.gone.set("run-1", { key: "run-1", base: "w1", name: "run", role: "run", live: true });
	assert.deepEqual(await w.ask({ key: "run-1" }), { ok: false, error: "unknown key run-1" });
	assert.equal(w.reads(), 1);
});

test("the reply holds no transcript, no path, and no monitor command: only the fields of the contract", async () => {
	const full = { ...unit({ note: "n", duty: "integrator", todo: { done: 1, total: 2, now: "x", steps: [{ id: 1, kind: "gate", status: "pending" }] }, monitors: [monitor({ what: "cat /Users/me/secret.txt", last: "ok", exit: 0, status: "done", ended: 5 })], subs: [unit({ id: "s1", key: "s1", name: "scout-a", role: "subagent", mark: "done", note: "sub note" })] }), file: "/Users/me/.pi/agent/sessions/x.jsonl", documents: [{ path: "/Users/me/doc.md" }], queued: [{ text: "typed text", as: "steer" }], pending: { question: "transcript text" } } as unknown as Unit;
	const w = world(netOf([full])), r = await w.ask();
	assert.deepEqual(Object.keys(r).sort(), ["now", "ok", "since", "state", "unit"]);
	assert.deepEqual(r.unit, { mark: "working", note: "n", duty: "integrator", todo: { done: 1, total: 2, now: "x" }, monitors: [{ id: "m1", status: "done", exit: 0, last: "ok", ageMs: w.clock.now() }], subs: [{ name: "scout-a", mark: "done" }] });
	const text = JSON.stringify(r);
	for (const word of ["/Users", "secret", "transcript", "typed text", "jsonl", "sub note"]) assert.ok(!text.includes(word), word);
});

test("D4: with no reading from the GUI host (the GUI is stopped) the route reads the net itself: at once for the first request, then every 10 s while a hold is open, and not at all with none open", async () => {
	const w = world(undefined, { feedless: true });
	w.set(netOf([unit()]));
	const first = await w.ask();
	assert.equal(first.state, "changed");
	assert.equal(w.reads(), 1, "the first request read the net");
	await w.pass(60_000);
	assert.equal(w.reads(), 1, "no hold, no read");
	const held = w.hold({ since: first.since });
	await settle(); // the request reads the net once more first: its last reading is a minute old
	assert.equal(w.reads(), 2);
	w.set(netOf([unit({ mark: "waiting" })]));
	await w.pass(9000);
	assert.equal(held.reply(), undefined);
	await w.pass(1000);
	assert.equal(held.reply()?.state, "changed", "within one 10 s read");
	assert.deepEqual(held.reply()!.unit, { mark: "waiting" });
	const reads = w.reads();
	await w.pass(60_000);
	assert.equal(w.reads(), reads, "the reads stop with the last hold");
	// While the host does read, the route reads nothing of its own.
	const fed = world(netOf([unit()])), start = await fed.ask(), open = fed.hold({ since: start.since });
	for (let i = 0; i < 20; i++) await fed.beat(netOf([unit()]));
	assert.equal(open.reply(), undefined);
	assert.equal(fed.reads(), 0);
});

test("the request's fields are checked: a key of 1 to 200 characters, quietMs of at least 60000, a deadline and a loadMax that are numbers; another command is not this route's", async () => {
	const w = world(netOf([unit()])), dog = { read: w.watch, report: { report: async () => ({ ok: true }) } };
	const ask = (more: Record<string, unknown>) => watchdogReply(dog, { cmd: "watch-read", ...more } as Request)!;
	assert.equal(watchdogReply(dog, { cmd: "procs-list" }), undefined);
	assert.deepEqual(await watchdogReply(undefined, { cmd: "watch-read", key: "u1" }), { ok: false, error: "the server is still starting" });
	assert.deepEqual(await ask({}), { ok: false, error: "key is 1 to 200 characters" });
	assert.deepEqual(await ask({ key: "k".repeat(201) }), { ok: false, error: "key is 1 to 200 characters" });
	assert.deepEqual(await ask({ key: "u1", quietMs: 59_999 }), { ok: false, error: "quietMs is at least 60000" });
	assert.deepEqual(await ask({ key: "u1", deadline: "soon" }), { ok: false, error: "deadline is a time in epoch ms" });
	assert.deepEqual(await ask({ key: "u1", loadMax: 0 }), { ok: false, error: "loadMax is a number over 0" });
	assert.equal(((await ask({ key: "u1", since: "s".repeat(513) })) as Answer).state, "changed", "a stamp too long is a mismatch");
	assert.equal(((await ask({ key: "u1", quietMs: 60_000, loadMax: 5, deadline: w.clock.now() + 1 })) as Answer).state, "changed");
});

// The real control socket closes a connection after its idle time without traffic; a hold is one request with no traffic until its answer.
const scratch = mkdtempSync(join(tmpdir(), "psb-watch-"));
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => void (await Promise.all(closers.splice(0).map((c) => c()))));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

test("over the real control socket a hold shorter than the idle close is answered, hold after hold on a quiet unit (a client's 5-minute wait), and one longer than the idle close is cut", async () => {
	const serve = async (holdMs: number, idleMs: number) => {
		const listeners = new Set<(net: Net) => void>(), quiet = netOf([unit()]);
		const watch = createWatchRead({ net: { onRead: (cb) => (listeners.add(cb), () => void listeners.delete(cb)), last: () => quiet, lookup: (key) => (key === "u1" ? { key, base: "w1", name: "coord", role: "main", live: true } : undefined), read: async () => quiet }, now: Date.now, holdMs });
		const secret = newSecret(), endpoint = join(scratch, `${holdMs}-${idleMs}.sock`);
		const control = await listenControl({ endpoint, secret, hello: () => ({}), idleMs, handle: (request) => watchdogReply({ read: watch, report: { report: async () => ({ ok: true }) } }, request) ?? { ok: false, error: "unknown" } });
		closers.push(async () => (watch.stop(), control.close()));
		return (more: Record<string, unknown>) => callControl(endpoint, secret, { cmd: "watch-read", key: "u1", ...more }, 30_000).then((r) => r.reply as Answer);
	};
	const ask = await serve(150, 2000);
	let since = (await ask({})).since;
	for (let i = 0; i < 4; i++) {
		const r = await ask({ since });
		assert.equal(r.state, "unchanged", `hold ${i + 1}`);
		since = r.since;
	}
	const cut = await serve(3000, 100);
	const first = await cut({});
	await assert.rejects(cut({ since: first.since }), "the idle close ends a hold that outlasts it");
});

let hostWorld: World | undefined, hosted: Hosted | undefined;
afterEach(async () => { await hosted?.stop(); await hostWorld?.stopAll(); hosted = hostWorld = undefined; });

test("the running server answers `watch-read` and `watch-report` on its control socket, with the GUI running and after it was stopped", async () => {
	hostWorld = new World();
	hostWorld.herdr.addTab("wA:t1", "work");
	hosted = await startHosted(hostWorld, { pid: process.pid });
	const a = hostWorld.agent({ id: "A", pane: "wA:p1", tab: "wA:t1" }), b = hostWorld.agent({ id: "B", pane: "wA:p2", tab: "wA:t1" });
	await a.start();
	await b.start();
	assert.deepEqual(await hosted.ask("watch-read", { key: "nope" }), { ok: false, error: "unknown key nope" });
	// A session of the net, read through the GUI host's source; its stamp holds the next request, which the hold's own timer would answer.
	const seen = (await hosted.ask("watch-read", { key: "B" })) as Answer;
	assert.equal(seen.state, "changed", JSON.stringify(seen));
	assert.equal(typeof (seen.unit as { mark?: unknown }).mark, "string");
	assert.equal(((await hosted.ask("watch-read", { key: "B", since: seen.since, deadline: Date.now() - 1 })) as Answer).state, "expired", "the stamp is this server's: no `changed`");
	assert.deepEqual(await hosted.ask("watch-read", { key: "nope", quietMs: 1 }), { ok: false, error: "quietMs is at least 60000" });
	assert.deepEqual(await hosted.ask("watch-report", { session: "/etc/passwd", child: "c1", activityFile: "/etc/hosts", text: "x" }), { ok: false, error: "outside the sessions folder" });
	assert.equal((await hosted.ask("gui-stop")).ok, true);
	assert.deepEqual(await hosted.ask("watch-read", { key: "nope" }), { ok: false, error: "unknown key nope" });
	assert.equal(((await hosted.ask("watch-read", { key: "B", since: seen.since, deadline: Date.now() - 1 })) as Answer).state, "expired", "the stopped GUI's source still reads");
	// A server that never had a GUI (D4): the route's reading makes the net source.
	await hosted.stop();
	hosted = await startHosted(hostWorld, { gui: false, pid: process.pid });
	const bare = (await hosted.ask("watch-read", { key: "B" })) as Answer;
	assert.equal(bare.state, "changed", JSON.stringify(bare));
	assert.deepEqual(bare.unit, seen.unit);
});
