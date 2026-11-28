import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { capDir, clock, joinCaps, type MainCap, type MainFacts, readCaps, readDevice, readStale, snoozeLine, staleFacts, staleOf, writeCap } from "../src/capacity.ts";
import { HELD_CAP_HINT, MAIN_CAP_HINT, SNOOZE_HINT } from "../src/moments.ts";
import { tellCap } from "../src/server/capops.ts";
import { type CapEvent, createCapWatch } from "../src/server/capwatch.ts";
import { readSnoozes, type Snooze, snoozeEnd, snoozeOf, withSnooze } from "../src/snooze.ts";
import { fakeClock } from "./fake-clock.ts";

// The snoozable stale reminder (docs/specs/2026-11-28-stale-snooze.md): the interval from config.json, the unanswered todos the notice names, a snooze of the main or of one todo for a time
// or until a watch's next change, a watch that holds the reminder only until its first change, the repeat to the main alone each interval, and a snooze that ends reminding at the next look.

const MIN = 60_000, NOW = Date.parse("2026-11-28T10:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "psb-snooze-")); dirs.push(d); return d; };

test("snoozeOf: why, and for or watch; for 1 minute to 24 hours; a watch must be one of the main's, a todo one of its open ones", () => {
	const o = { now: NOW, watches: ["train-a"], open: [3, 5] };
	assert.deepEqual(snoozeOf({ why: "  CI\nruns ", for: "30m" }, o), { at: NOW, why: "CI runs", until: NOW + 30 * MIN });
	assert.deepEqual(snoozeOf({ why: "lands next", watch: "train-a" }, o), { at: NOW, why: "lands next", until: NOW + 24 * 60 * MIN, watch: "train-a" }, "a watch alone ends 24 hours after at the latest");
	assert.deepEqual(snoozeOf({ why: "x", watch: "train-a", for: "2h", todo: 3 }, o), { at: NOW, why: "x", until: NOW + 120 * MIN, watch: "train-a", todo: 3 });
	const refused: [unknown, RegExp][] = [
		[{ for: "30m" }, /why/], [{ why: "", for: "30m" }, /why/], [{ why: "x".repeat(121), for: "30m" }, /120/],
		[{ why: "x" }, /for or watch/], [{ why: "x", for: "30s" }, /at least 1m/], [{ why: "x", for: "25h" }, /at most 24h/], [{ why: "x", for: "soon" }, /for is a length/],
		[{ why: "x", watch: "other" }, /start boss_watch on it first/], [{ why: "x", for: "1h", todo: 9 }, /no open todo #9/], [{ why: "x", for: "1h", todo: 1.5 }, /no open todo/],
		[null, /snooze takes/],
	];
	for (const [input, error] of refused) assert.throws(() => snoozeOf(input, o), error, JSON.stringify(input));
});

test("withSnooze: one snooze for the main and one per todo, a new one replaces its scope; at most 20, the oldest todo snooze goes", () => {
	const a: Snooze = { at: 1, why: "a", until: 10 }, b: Snooze = { at: 2, why: "b", until: 20 }, t3: Snooze = { at: 3, why: "t", until: 30, todo: 3 };
	assert.deepEqual(withSnooze([a, t3], b), [t3, b]);
	assert.deepEqual(withSnooze([a, t3], { ...t3, at: 4, why: "t2" }), [a, { ...t3, at: 4, why: "t2" }]);
	const many = Array.from({ length: 20 }, (_, i): Snooze => ({ at: i, why: "x", until: 99, todo: i + 1 }));
	const next = withSnooze(many, { at: 50, why: "y", until: 99, todo: 50 });
	assert.equal(next.length, 20);
	assert.equal(next.some((s) => s.todo === 1), false, "the oldest went");
});

test("snoozeEnd: active until its time, its watch's first line after it was set, or its watch gone", () => {
	const s: Snooze = { at: NOW, why: "w", until: NOW + 60 * MIN, watch: "train-a" };
	const fresh = [{ key: "train-a", added: NOW - MIN, toldAt: NOW - MIN }];
	assert.equal(snoozeEnd(s, fresh, NOW + 10 * MIN), undefined, "no line since: active");
	assert.equal(snoozeEnd(s, [{ key: "train-a", added: NOW - MIN, toldAt: NOW + 7 * MIN }], NOW + 10 * MIN), NOW + 7 * MIN, "ended at the line");
	assert.equal(snoozeEnd(s, [], NOW + 10 * MIN), NOW, "the watch is gone: ended when it was set");
	assert.equal(snoozeEnd(s, undefined, NOW + 10 * MIN), undefined, "watches unknown: active until its time");
	assert.equal(snoozeEnd(s, fresh, NOW + 60 * MIN), NOW + 60 * MIN, "its time passed");
	assert.equal(snoozeEnd({ at: NOW, why: "t", until: NOW + 30 * MIN }, undefined, NOW + 29 * MIN), undefined);
});

test("readSnoozes takes the checked rows only; snoozeLine says what and until when", () => {
	assert.deepEqual(readSnoozes([{ at: 1, why: "a", until: 2 }, { at: 1, why: "", until: 2 }, { at: 1, why: "b" }, { at: 1, why: "c", until: 2, todo: -1 }, { at: 1, why: "d", until: 2, watch: 7 }, "x", { at: 1, why: "e", until: 2, todo: 4, watch: "k" }]), [{ at: 1, why: "a", until: 2 }, { at: 1, why: "e", until: 2, todo: 4, watch: "k" }]);
	assert.equal(readSnoozes("nope").length, 0);
	assert.equal(snoozeLine({ at: NOW, why: "CI runs", until: NOW + 30 * MIN }, NOW), `snoozed until ${clock(NOW + 30 * MIN, NOW)}: CI runs`);
	assert.equal(snoozeLine({ at: NOW, why: "lands next", until: NOW + 30 * MIN, watch: "train-a", todo: 3 }, NOW), "#3 snoozed until train-a changes: lands next");
});

test("readStale: capacity.staleMinutes and staleUnattendedMinutes, whole minutes 1 to 1440, else today's 120 and 30", () => {
	const dir = tmp();
	assert.deepEqual(readStale(dir), { attendedMs: 120 * MIN, unattendedMs: 30 * MIN }, "no config.json");
	writeFileSync(join(dir, "config.json"), JSON.stringify({ capacity: { budget: 4, staleMinutes: 30, staleUnattendedMinutes: 15 } }));
	assert.deepEqual(readStale(dir), { attendedMs: 30 * MIN, unattendedMs: 15 * MIN });
	for (const bad of [0, -5, 1441, 2.5, "30", null]) {
		writeFileSync(join(dir, "config.json"), JSON.stringify({ capacity: { staleMinutes: bad, staleUnattendedMinutes: bad } }));
		assert.deepEqual(readStale(dir), { attendedMs: 120 * MIN, unattendedMs: 30 * MIN }, String(bad));
	}
	writeFileSync(join(dir, "config.json"), "{ not json");
	assert.deepEqual(readStale(dir), { attendedMs: 120 * MIN, unattendedMs: 30 * MIN });
});

const idle = (ms: number, over: Partial<MainFacts> = {}) => ({ state: "idle", workers: [], fileMtime: NOW - ms, entryUpdated: NOW - ms, ...over });
const todos = [{ id: 3, subject: "deploy the api" }, { id: 5, subject: "review the docs" }];
const c = (over: Partial<MainCap> = {}) => ({ open: 2, todos, ...over });

test("staleFacts: the interval from the options, the unanswered todos, a snooze of the main or of a todo, a watch until its first change", () => {
	const thirty = { attendedMs: 30 * MIN, unattendedMs: 10 * MIN };
	assert.equal(staleOf(idle(31 * MIN), c(), false, NOW), false, "today's 2 hours by default");
	assert.equal(staleOf(idle(31 * MIN), c(), false, NOW, thirty), true, "staleMinutes 30");
	assert.equal(staleOf(idle(11 * MIN), c(), true, NOW, thirty), true, "staleUnattendedMinutes 10");
	assert.deepEqual(staleFacts(idle(31 * MIN), c(), false, NOW, thirty).todos, todos, "it names the unanswered todos");
	const deferred = c({ todos: [{ id: 3, subject: "deploy the api", until: NOW + MIN }, { id: 5, subject: "review the docs", until: 8.64e15 }] });
	assert.equal(staleOf(idle(31 * MIN), deferred, false, NOW, thirty), false, "metadata.until and metadata.waitsOn answer a todo, as today");
	const main = (until: number, over: Partial<Snooze> = {}): Snooze => ({ at: NOW - 40 * MIN, why: "CI runs", until, ...over });
	assert.equal(staleOf(idle(31 * MIN), c({ snoozes: [main(NOW + MIN)] }), false, NOW, thirty), false, "a snooze of the main");
	const one = staleFacts(idle(31 * MIN), c({ snoozes: [main(NOW + MIN, { todo: 3 })] }), false, NOW, thirty);
	assert.deepEqual([one.stale, one.todos], [true, [todos[1]]], "a snoozed todo is not named; the other still is");
	assert.equal(staleOf(idle(31 * MIN), c({ snoozes: [main(NOW + MIN, { todo: 3 }), main(NOW + MIN, { todo: 5 })] }), false, NOW, thirty), false, "every open todo snoozed");
	const watched = (toldAt: number) => idle(31 * MIN, { watches: [{ key: "train-a", added: NOW - 40 * MIN, toldAt }] });
	assert.equal(staleOf(watched(NOW - 40 * MIN), c(), false, NOW, thirty), false, "a watch with no change yet holds it, as a running watch did");
	assert.equal(staleOf(watched(NOW - 35 * MIN), c(), false, NOW, thirty), true, "after its first change it no longer does");
	assert.equal(staleOf(watched(NOW - 35 * MIN), c({ snoozes: [main(NOW + 60 * MIN, { at: NOW - 34 * MIN, watch: "train-a" })] }), false, NOW, thirty), false, "snoozed again on it: until its next change");
	assert.equal(staleOf(idle(31 * MIN, { duty: "standing" }), c(), false, NOW, thirty), false, "a standing main on an attended device, as today");
});

test("staleFacts: a snooze that ended after the last move wakes the reminder at once; a move after it does not", () => {
	const s: Snooze = { at: NOW - 30 * MIN, why: "CI runs", until: NOW - MIN };
	const woke = staleFacts(idle(30 * MIN), c({ snoozes: [s] }), true, NOW, { attendedMs: 120 * MIN, unattendedMs: 60 * MIN });
	assert.deepEqual([woke.stale, woke.woke], [true, { at: NOW - MIN, why: "CI runs", id: `:main@${NOW - 30 * MIN}` }], "nothing moved since it ended: due, inside the interval");
	assert.equal(staleOf(idle(30 * MIN, { fileMtime: NOW - 30_000 }), c({ snoozes: [s] }), true, NOW, { attendedMs: 120 * MIN, unattendedMs: 60 * MIN }), false, "it moved after: the interval runs from that move");
	assert.equal(staleOf(idle(30 * MIN, { state: "working" }), c({ snoozes: [s] }), false, NOW), false, "a working main is not reminded");
});

/** The watch on a world the test edits (as tests/capwatch.test.ts). */
function world(unattended: boolean, stale = { attendedMs: 120 * MIN, unattendedMs: 30 * MIN }) {
	const root = tmp(), dir = capDir(join(root, "board")), clk = fakeClock(NOW), t0 = clk.now();
	const w = {
		dir, clock: clk, told: [] as CapEvent[], stale,
		mains: [{ session: "s-a", name: "api", workspace: "w1", role: "main", state: "idle", workers: [], fileMtime: t0, entryUpdated: t0 }, { session: "s-st", name: "standing", workspace: "w0", role: "main", state: "idle", duty: "standing", workers: [], fileMtime: t0, entryUpdated: t0 }] as MainFacts[],
		cap: (over: Partial<MainCap> = {}) => writeCap(dir, { v: 1, session: "s-a", updated: clk.now(), doing: [], ready: [], open: 2, todos, ...over }),
	};
	const make = () => createCapWatch({
		dir, now: clk.now, log: () => {}, budget: () => undefined, load: () => ({ load1: 0.2, cores: 8 }), unattended: () => unattended, stale: () => w.stale,
		mains: async () => w.mains, allies: () => [], tell: async (e) => (w.told.push(e), true),
	});
	return { w, make };
}
async function run(watch: ReturnType<typeof createCapWatch>, clk: ReturnType<typeof fakeClock>, minutes: number) {
	for (let i = 0; i < minutes; i++) (await watch.tick(), clk.advance(MIN));
}
const kinds = (told: CapEvent[]) => told.map((e) => [e.kind, e.mainOnly ? "main only" : "all"]);

test("the notice names the unanswered todos and how long nothing moved; it comes back to the main alone each interval while nothing moves, across a restart", async () => {
	const { w, make } = world(false, { attendedMs: 30 * MIN, unattendedMs: 30 * MIN });
	w.cap();
	const watch = make();
	await run(watch, w.clock, 32);
	assert.deepEqual(kinds(w.told), [["stale", "all"]]);
	assert.match(w.told[0]!.text, /^capacity stale · main "api" · 2 open todos unanswered: #3 "deploy the api", #5 "review the docs" · no move for 3\d min · state of the device: capacity 0 pts · load 0\.2 \/ 8 cores · ready 0$/);
	assert.equal(w.told[0]!.main, "s-a");
	await run(watch, w.clock, 29);
	assert.equal(w.told.length, 1, "inside the interval: once");
	await run(watch, w.clock, 2);
	assert.deepEqual(kinds(w.told), [["stale", "all"], ["stale", "main only"]], "an interval after the last notice: the main alone again");
	assert.equal(w.told[1]!.main, "s-a");
	await make().tick();
	assert.equal(w.told.length, 2, "a restart neither repeats it nor drops the clock");
	w.mains[0]!.entryUpdated = w.clock.now(); // it answered on its board
	await run(make(), w.clock, 29);
	assert.equal(w.told.length, 2, "a move ends the episode");
});

test("a snooze holds the reminder; when it ends with nothing moved, the main is reminded at the next look, naming the snooze", async () => {
	const { w, make } = world(true);
	w.cap();
	const watch = make();
	await run(watch, w.clock, 32);
	assert.equal(w.told.length, 1);
	const at = w.clock.now();
	w.mains[0]!.fileMtime = at; // the turn that snoozed
	w.cap({ snoozes: [{ at, why: "CI runs", until: at + 10 * MIN }] });
	await run(watch, w.clock, 10);
	assert.equal(w.told.length, 1, "snoozed");
	assert.equal(readDevice(w.dir, w.clock.now())?.mains[0]?.snoozes?.[0]?.why, "CI runs", "the device row shows the snooze");
	await run(watch, w.clock, 1);
	assert.deepEqual(kinds(w.told), [["stale", "all"], ["stale", "all"]], "ended, inside the 30 minutes: reminded at once");
	assert.match(w.told[1]!.text, new RegExp(`^capacity stale · main "api" · its snooze ended at ${clock(at + 10 * MIN, w.clock.now())} \\("CI runs"\\) · 2 open todos unanswered: `));
});

test("a snooze until a watch's next change ends at that change; a todo's own snooze leaves the other named", async () => {
	const { w, make } = world(true);
	const at = w.clock.now();
	w.mains[0] = { ...w.mains[0]!, watches: [{ key: "train-a", added: at - 5 * MIN, toldAt: at - MIN }] };
	w.cap({ snoozes: [{ at, why: "lands next", until: at + 24 * 60 * MIN, watch: "train-a" }, { at, why: "after the train", until: at + 24 * 60 * MIN, todo: 5 }] });
	const watch = make();
	await run(watch, w.clock, 40);
	assert.equal(w.told.length, 0, "the watch sent nothing since");
	w.mains[0]!.watches = [{ key: "train-a", added: at - 5 * MIN, toldAt: w.clock.now() }];
	await run(watch, w.clock, 1);
	assert.equal(w.told.length, 1, "its change ended the snooze, and nothing moved since");
	assert.match(w.told[0]!.text, /1 open todo unanswered: #3 "deploy the api" · /);
});

test("the main's own stale copy offers the snooze in the same line; the tower's and the standing main's do not", async () => {
	const told: [string, string][] = [], o = { run: async () => JSON.stringify({ result: { workspaces: [] } }), towers: () => undefined, tellSession: async (session: string, text: string) => (told.push([session, text]), "delivered") };
	await tellCap({ kind: "stale", key: "s-a", text: "s", subject: "s-a", workspace: "w1", standing: "s-st", main: "s-a" }, o, 1);
	await tellCap({ kind: "stale", key: "s-a", text: "h", subject: "s-a", workspace: "w1", main: "s-a", held: true }, o, 2);
	await tellCap({ kind: "under", key: "s-a", text: "u", subject: "s-a", workspace: "w1", main: "s-a" }, o, 3);
	assert.deepEqual(told, [["s-st", "s"], ["s-a", `s${MAIN_CAP_HINT}${SNOOZE_HINT}`], ["s-a", `h${HELD_CAP_HINT}${SNOOZE_HINT}`], ["s-a", `u${MAIN_CAP_HINT}`]]);
	assert.ok(SNOOZE_HINT.startsWith(" · or snooze this reminder: board_set {snooze: {why, for: \"30m\"}}"), SNOOZE_HINT);
	assert.ok(!SNOOZE_HINT.includes("\n"));
	for (const term of ["watch:", "boss_watch", "todo:"]) assert.ok(SNOOZE_HINT.includes(term), term);
	const d = joinCaps({ mains: [{ session: "a", name: "a", workspace: "w", role: "main", state: "idle", workers: [], fileMtime: 1, entryUpdated: 1 }], caps: [{ v: 1, session: "a", updated: NOW, doing: [], ready: [], open: 1, snoozes: [{ at: NOW, why: "CI", until: NOW + MIN }] }], load1: 0, cores: 1, unattended: true, now: NOW });
	assert.deepEqual(d.mains[0]!.snoozes, [{ at: NOW, why: "CI", until: NOW + MIN }]);
	assert.equal(d.mains[0]!.stale, undefined);
});

// Review snooze-review F001: the snooze's end was taken from the watch's latest line, so each line (and then its time) started a new episode told to everyone.
test("one snooze wakes the reminder once: its first end holds across later lines, its time, and a restart; then the main alone each interval", async () => {
	const { w, make } = world(true);
	const at = w.clock.now();
	w.mains[0] = { ...w.mains[0]!, fileMtime: at, entryUpdated: at, watches: [{ key: "train-a", added: at - 5 * MIN, toldAt: at - MIN }] };
	w.cap({ snoozes: [{ at, why: "lands next", until: at + 20 * MIN, watch: "train-a" }] });
	const watch = make();
	const line = () => void (w.mains[0]!.watches = [{ key: "train-a", added: at - 5 * MIN, toldAt: w.clock.now() }]);
	await run(watch, w.clock, 2);
	line();
	await run(watch, w.clock, 2);
	line();
	await run(watch, w.clock, 2);
	assert.deepEqual(kinds(w.told), [["stale", "all"]], "the first line woke it; the second is no new wake");
	await make().tick();
	await run(make(), w.clock, 20);
	assert.deepEqual(kinds(w.told), [["stale", "all"]], "nor its time, nor a restart");
	await run(watch, w.clock, 12);
	assert.deepEqual(kinds(w.told), [["stale", "all"], ["stale", "main only"]], "an interval after the wake: the main alone");
});

// F002: a watch that ended dropped out of the facts, and its snooze was taken to have ended when it was set, before the main's last move.
test("a snooze on a watch that ended ends when the watch ended, so a main unmoved since is reminded at the next look", async () => {
	const s: Snooze = { at: NOW, why: "w", until: NOW + 60 * MIN, watch: "train-a" };
	assert.equal(snoozeEnd(s, [{ key: "train-a", added: NOW - MIN, toldAt: NOW - MIN, ended: NOW + 5 * MIN }], NOW + 10 * MIN), NOW + 5 * MIN, "stopped: its stop");
	assert.equal(snoozeEnd(s, [{ key: "train-a", added: NOW - MIN, toldAt: NOW + 4 * MIN, ended: NOW + 5 * MIN }], NOW + 10 * MIN), NOW + 4 * MIN, "ended with a line: that line");
	const f = staleFacts(idle(MIN, { fileMtime: NOW + 3 * MIN, entryUpdated: NOW + 3 * MIN, watches: [{ key: "train-a", added: NOW - MIN, toldAt: NOW - MIN, ended: NOW + 5 * MIN }] }), c({ snoozes: [s] }), true, NOW + 6 * MIN);
	assert.deepEqual([f.stale, f.woke?.at], [true, NOW + 5 * MIN], "moved after the snooze, not after the end: due at once, and an ended watch shields nothing");
});

// F005, r2-F003: the delivery of a notice writes the main's session file. Only that write and the main's text-only answer to it are discounted (server/worked.ts gives `worked`, the main's own last
// move); a time window around the notice also hid real work, and the pane's working state is a guard of its own, never bookkeeping.
test("the delivery's own writes keep the episode: the repeats stay the main's alone; real work right after a notice resets the clock, and a working pane is never reminded", async () => {
	const { w, make } = world(true);
	w.cap();
	const watch = make(), t0 = w.clock.now();
	w.mains[0] = { ...w.mains[0]!, worked: t0 };
	const take = () => (w.mains[0] = { ...w.mains[0]!, fileMtime: w.clock.now() + 20_000, paneStatus: "working" }); // the delivery: its file moves, its pane works, its own move does not
	for (let i = 0; i < 70; i++) {
		const before = w.told.length;
		await watch.tick();
		if (w.told.length > before) take();
		else if (w.mains[0]!.paneStatus) w.mains[0] = { ...w.mains[0]!, paneStatus: "idle" };
		w.clock.advance(MIN);
	}
	assert.deepEqual(kinds(w.told), [["stale", "all"], ["stale", "main only"]], "the first to all, the repeat an interval later to the main alone");
	// Real work a minute after the notice, while the main's todo snooze runs out: its pane works, so nothing is told, and the work resets the clock.
	const at = w.clock.now();
	w.cap({ snoozes: [{ at: at - 10 * MIN, why: "after the build", until: at + 5 * MIN, todo: 3 }] });
	w.mains[0] = { ...w.mains[0]!, worked: at + MIN, fileMtime: at + MIN, paneStatus: "working" };
	await run(watch, w.clock, 10);
	assert.equal(w.told.length, 2, "a working pane is not reminded, a snooze's end or not");
	w.mains[0] = { ...w.mains[0]!, worked: at + 9 * MIN, fileMtime: at + 9 * MIN, paneStatus: "idle" }; // its last tool call, after the snooze ended
	await run(watch, w.clock, 29);
	assert.equal(w.told.length, 2, "the work reset the clock");
	await run(watch, w.clock, 2);
	assert.deepEqual(kinds(w.told).slice(2), [["stale", "all"]], "an interval after the work: a new episode, told to all");
});

// r2-F002: a retained wake mark brought the wake's routing back for a new episode of a main that had not moved, so the same notice went to everyone again, after a restart too.
test("a wake told once routes no later notice: an unchanged main gets its repeats alone, after a tick it was not stale and after a restart", async () => {
	const { w, make } = world(true);
	const t0 = w.clock.now();
	w.mains[0] = { ...w.mains[0]!, worked: t0 };
	w.cap({ snoozes: [{ at: t0, why: "CI runs", until: t0 + 10 * MIN }] });
	await run(make(), w.clock, 11);
	assert.deepEqual(kinds(w.told), [["stale", "all"]], "the snooze's end woke it");
	await run(make(), w.clock, 31);
	assert.deepEqual(kinds(w.told), [["stale", "all"], ["stale", "main only"]], "an interval later, the main alone");
	w.mains[0] = { ...w.mains[0]!, background: true }; // a monitor ran in its pane for a minute: one look sees no stale main, and nothing moved
	await run(make(), w.clock, 1);
	w.mains[0] = { ...w.mains[0]!, background: false };
	await run(make(), w.clock, 15);
	await run(make(), w.clock, 15);
	assert.deepEqual(kinds(w.told), [["stale", "all"], ["stale", "main only"], ["stale", "main only"]], "the throttle past, nothing moved: the main's alone again, across restarts");
});

// F006: the capacity file held the first 100 open todos, so a 101st unanswered todo made nothing stale.
test("eligibility reads every open todo; only the notice's summary is cut", () => {
	const many = [...Array.from({ length: 100 }, (_, i) => ({ id: i + 1, subject: `t${i + 1}`, until: NOW + 60 * MIN })), { id: 101, subject: "the last one" }];
	const f = staleFacts(idle(31 * MIN), c({ open: 101, todos: many }), true, NOW);
	assert.deepEqual([f.stale, f.todos], [true, [{ id: 101, subject: "the last one" }]]);
	const root = tmp(), dir = capDir(join(root, "board"));
	writeCap(dir, { v: 1, session: "s-a", updated: NOW, doing: [], ready: [], open: 301, todos: Array.from({ length: 301 }, (_, i) => ({ id: i + 1, subject: `t${i + 1}` })) });
	const back = readCaps(dir)[0]!;
	assert.deepEqual([back.open, back.todos?.length], [301, 301], "the file keeps them all");
	const d = joinCaps({ mains: [{ session: "s-a", name: "a", workspace: "w", role: "main", state: "idle", workers: [], fileMtime: NOW - 40 * MIN, entryUpdated: NOW - 40 * MIN }], caps: [back], load1: 0, cores: 1, unattended: true, now: NOW });
	assert.deepEqual([d.mains[0]!.stale, d.mains[0]!.unanswered, d.mains[0]!.todos?.length], [true, 301, 3], "the row carries the count and the three the notice names");
});

// snooze-review2 F001: a file of more open todos than the reader keeps decoded to open 0, which is "no work".
test("an overflow of open todos is work: the reader keeps the count, and todos beyond the list are unanswered", () => {
	const root = tmp(), dir = capDir(join(root, "board"));
	writeCap(dir, { v: 1, session: "s-a", updated: NOW, doing: [], ready: [], open: 5001, todos: Array.from({ length: 5001 }, (_, i) => ({ id: i + 1, subject: `t${i + 1}`, until: NOW + 60 * MIN })) });
	const back = readCaps(dir)[0]!;
	assert.deepEqual([back.open, back.todos?.length], [5001, 5000], "the count is kept, the list is cut");
	const f = staleFacts(idle(31 * MIN), back, true, NOW);
	assert.deepEqual([f.stale, f.unanswered], [true, 1], "the one the list could not hold counts as unanswered");
});
