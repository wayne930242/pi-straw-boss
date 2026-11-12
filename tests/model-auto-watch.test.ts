import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { BoardViewRow } from "../src/boardview.ts";
import type { Base, Net, TowerService, Unit } from "../src/net.ts";
import { createAutoMode, PERIOD_FILE } from "../src/server/automode.ts";
import { createAutoWatch, factsOf, WATCH_MS, type WatchDeps, watchOf, watchSection } from "../src/server/autowatch.ts";
import { fakeClock } from "./fake-clock.ts";

// The paths of the auto-watch model (docs/models/auto-watch/) replayed on the watch's code, one per rule W3 to W5 (W1, W2 and W6 run on the real queue in model-auto-watch-queue.test.ts). Each asserts its rule at the end
// of the path in the reader's words. The head tower's queue is the seam `noticeState`: what runs.ts reads of the notice at each reading and at the switch off.

const T0 = 1_800_000_000_000, HOUR = 3600_000;
let dir = "", clock = fakeClock(T0);
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psb-model-watch-"));
	clock = fakeClock(T0);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pi = { via: "pi" as const, name: "boss at a terminal" };
type Where = ReturnType<NonNullable<WatchDeps["noticeState"]>>;
const unit = (key: string, name: string, over: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name, role: "main", mark: "working", subs: [], ...over });
const service = (over: Partial<TowerService> = {}): TowerService => ({ state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], ...over });
const base = (id: string, label: string, units: Unit[], tower: Partial<TowerService> = {}): Base => ({
	id, label, mark: "working", tabs: [{ id: `${id}-t1`, label: "work", units }], outposts: [], outside: [], tower: { name: `tower ${label}`, mark: "idle", key: `sb-tower-${id}`, control: true, service: service(tower), subs: [] },
});
const row = (session: string, over: Partial<BoardViewRow> = {}): BoardViewRow => ({ session, workspace: "x", tab: "work", main: session, state: "working", items: [], ...over });
/** A workspace whose tower is held and whose train's writer is gone: two findings that last until the test clears them. */
const troubleNet = (): Net => ({
	bases: [base("wA", "Alpha", [unit("m1", "docs-main"), unit("t1", "train 1112a", { role: "train", train: { project: "acme", code: "1112a" } })], { state: "held" })],
	board: [],
	yards: { projects: [{ project: "acme", forming: [], waiting: [], trains: [{ code: "1112a", app: "web", state: "stale", key: "t1", updated: new Date(T0 - HOUR).toISOString(), steps: [], cars: [] }] }] },
});
const calmNet = (): Net => ({ bases: [base("wA", "Alpha", [unit("m1", "docs-main")])], board: [] });
let shown: Net = { bases: [] };

/** One server's life over the state folder, as main.ts wires auto mode and its watch: the head keeps what it was sent, and `where` says where each notice is in its queue. */
function server(o: { where?: (key: string) => Where; head?: () => { workspace: string } | undefined } = {}) {
	const sent: { text: string; key: string }[] = [];
	const where = (key: string) => o.where?.(key) ?? "queued";
	const auto = createAutoMode({ dir, now: clock.now, log: () => {}, watch: (p, until) => watchSection(p.watch, p.since, until, [], (x) => where(x.key)) });
	auto.start();
	const watch = createAutoWatch({
		now: clock.now, log: () => {}, auto, head: o.head ?? (() => ({ workspace: "w-head" })), asks: () => [],
		facts: async (input) => factsOf(shown, { ...input, stalls: [] }), wake: (_ws, text, key) => (sent.push({ text, key }), true), noticeState: (_ws, key) => where(key),
	});
	const run = async (ms: number) => { for (let t = 0; t < ms; t += 30_000) (clock.advance(30_000), await watch.tick()); };
	const refused = (gist = "Which database?") => (clock.advance(1), assert.equal(auto.note({ session: "m1", tool: "ask_user_question", kind: "refused", gist, at: new Date(clock.now()).toISOString() }).ok, true));
	const off = () => (auto.switchOff(pi) as { report?: string }).report!;
	return { auto, sent, run, refused, off, state: () => auto.watch()! };
}

test("model W3 (RV4-F001): a notice the head takes after the last reading still leaves its findings on the morning list, as still open", async () => {
	shown = troubleNet();
	let where: Where = "queued";
	const s = server({ where: () => where });
	s.auto.switchOn(pi);
	await s.run(WATCH_MS); // the last reading sends the notice
	assert.equal(s.sent.length, 1);
	where = "told"; // a head run took it and ended well before the boss is back
	const report = s.off();
	assert.match(report, /: 1 reading, 0 calm \(nobody woken\), 1 wake;/);
	assert.match(report, /\nStill open at the last reading \(\d\d:\d\d\):\n- "Alpha": its tower: held \(it starts no run\)\n- "Alpha": train "1112a" \("acme"\): its writer is gone and it has not ended/, `the findings the head was told and that were still there at the last reading are on the morning list:\n${report}`);
});

test("model W3: a finding seen at a reading that woke nobody and gone by the last reading is named as told to nobody", async () => {
	shown = troubleNet();
	let open = false;
	const s = server({ head: () => (open ? { workspace: "w-head" } : undefined) });
	s.auto.switchOn(pi);
	await s.run(WATCH_MS); // no head tower is open: the reading is skipped
	shown = calmNet(); // the tower takes runs again and the train ended
	open = true;
	await s.run(WATCH_MS);
	assert.equal(s.sent.length, 0, "nothing new at the second reading");
	const report = s.off();
	assert.match(report, /\nTold to nobody \(2 findings no head run took\):\n- "Alpha": its tower: held \(it starts no run\) \(gone by the last reading\)\n- "Alpha": train "1112a" \("acme"\): its writer is gone and it has not ended \(gone by the last reading\)/, `every finding of the night is on the morning list:\n${report}`);
});

test("model W4 (RV4-F002): after two notices in a row were parked, the watch sends no more until the head tower is opened again; the morning names the parked notices and their findings", async () => {
	shown = troubleNet();
	let head = "w-head";
	const s = server({ where: () => "parked", head: () => ({ workspace: head }) });
	s.auto.switchOn(pi);
	await s.run(8 * WATCH_MS);
	assert.equal(s.sent.length, 2, `a head that crashes on every notice gets two, not one a reading (${s.sent.length} sent)`);
	assert.deepEqual([s.state().readings, s.state().wakes, s.state().skipped], [8, 0, 6]);
	head = "w-head-2"; // the boss opened the head tower again
	await s.run(WATCH_MS);
	assert.equal(s.sent.length, 3, "a head opened again gets the next notice");
	await s.run(3 * WATCH_MS);
	assert.equal(s.sent.length, 4, "and the bound holds again after two more in a row");
	const report = s.off();
	assert.match(report, /\n4 notices were parked after two head runs crashed with each \(the last at \d\d:\d\d\); they told 2 findings to nobody:\n- "Alpha": its tower: held \(it starts no run\)\n- "Alpha": train "1112a"[^\n]*\nAfter two notices in a row were parked the watch sent no more; it sends again once the head tower is opened again\./, report);
});

test("model W5 (RV4-F005): a parked count in a period file whose parked notice is broken is kept, and no notice key of the period is used twice", async () => {
	shown = troubleNet();
	const where = new Map<string, Where>();
	let s = server({ where: (key) => where.get(key) ?? "queued" });
	s.auto.switchOn(pi);
	await s.run(WATCH_MS);
	where.set(s.sent[0]!.key, "parked");
	await s.run(WATCH_MS);
	assert.equal(s.sent.length, 2, "a parked notice no longer blocks the watch: its findings go out again");
	where.set(s.sent[1]!.key, "told");
	// A hand edit breaks the parked notice's time and lines; the server starts again over the file.
	const file = join(dir, PERIOD_FILE), period = JSON.parse(readFileSync(file, "utf8"));
	period.watch.parked = { ...period.watch.parked, at: "not a time", items: "broken" };
	writeFileSync(file, JSON.stringify(period));
	const keys = s.sent.map((x) => x.key);
	s = server({ where: (key) => where.get(key) ?? "queued" });
	assert.equal(s.state().parked?.count, 1, "the count of parked notices is kept");
	s.refused(); // something new for the next reading
	await s.run(WATCH_MS);
	assert.equal(s.sent.length, 1);
	assert.equal(keys.includes(s.sent[0]!.key), false, `the key ${s.sent[0]!.key} was used before in this period (${keys.join(", ")})`);
	assert.equal(watchOf({ readings: 1, calm: 0, wakes: 0, skipped: 0, nudges: 0, sent: [], out: {}, shown: [], parked: { count: 3, inRow: 2, at: 5, items: null } })?.parked?.count, 3, "watchOf keeps the count of a broken parked field");
});

test("model W5 (RV4-F005 wording): a parked notice that held only a refused wait does not say it told nothing new", async () => {
	shown = calmNet();
	const s = server({ where: () => "parked" });
	s.auto.switchOn(pi);
	s.refused();
	await s.run(WATCH_MS);
	assert.equal(s.sent.length, 1);
	await s.run(WATCH_MS);
	const report = s.off();
	assert.doesNotMatch(report, /told nothing new/, report);
	assert.match(report, /\nCancelled or refused \(1\):\n- m1: ask_user_question refused "Which database\?"/, "the wait it named is on the list");
	assert.match(report, /\n2 notices were parked after two head runs crashed with each \(the last at \d\d:\d\d\); they hold no finding left untold; the waits and quiet workspaces they named are in the lists above\./, report);
});

test("model W6: a reading with nothing new wakes nobody, and a notice that waits is never sent over (pinned: these held on 1ffea42f too)", async () => {
	shown = calmNet();
	shown.board = [row("m1", { updated: T0 })];
	const s = server();
	s.auto.switchOn(pi);
	await s.run(3 * WATCH_MS);
	assert.equal(s.sent.length, 0, "calm readings");
	s.refused();
	await s.run(3 * WATCH_MS);
	s.refused();
	await s.run(WATCH_MS);
	assert.equal(s.sent.length, 1, "the notice waits: the readings behind it are skipped, never sent over it");
	assert.equal(s.state().skipped, 3);
});
