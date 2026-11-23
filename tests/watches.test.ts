import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Found, Net, Unit } from "../src/net.ts";
import { createWatches, HOUR_MS, OWNER_GRACE_MS, PER_HOUR, RATE_MS } from "../src/server/watches.ts";
import { createWatchRead, type WatchNet } from "../src/server/watchread.ts";
import { fakeClock } from "./fake-clock.ts";

// The server-owned watches behind `boss_watch` (docs/specs/2026-11-23-lite-b2-d-e-f.md §3.3): each watch runs watch-read's verdict over the server's own readings and wakes its main with one line, at most one a minute per watch, the
// newest state only, 12 an hour per session. Every wait is on a clock the test moves.

const unit = (over: Partial<Unit> = {}): Unit => ({ id: "u1", key: "u1", control: true, name: "build", role: "main", mark: "working", subs: [], ...over });
const netOf = (units: Unit[]): Net => ({ bases: [{ id: "w1", label: "w", mark: "working", tower: null, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }] });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r)); };
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function world(o: { file?: string; clock?: ReturnType<typeof fakeClock>; net?: Net } = {}) {
	const clock = o.clock ?? fakeClock(1_700_000_000_000), listeners = new Set<(net: Net) => void>(), gone = new Map<string, Found>();
	let last: Net | undefined = o.net ?? netOf([unit()]);
	const keys = (net: Net | undefined) => (net?.bases ?? []).flatMap((b) => b.tabs.flatMap((t) => t.units.flatMap((u) => [u, ...u.subs])));
	const net: WatchNet = {
		onRead: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
		last: () => last,
		lookup: (key) => { const u = keys(last).find((x) => x.key === key); return u ? { key, base: "w1", name: u.name, role: u.role, live: true } : gone.get(key); },
		read: async () => last!,
	};
	const timer = (ms: number, fn: () => void) => { let live = true; clock.at(clock.elapsed() + ms, () => live && fn()); return () => void (live = false); };
	const read = createWatchRead({ net, now: clock.now, timer });
	const sent: { session: string; workspace: string; text: string; key: string; state: string }[] = [];
	const owners = new Map<string, boolean>();
	let accept = true;
	const watches = createWatches({
		read: (q) => read.read(q), now: clock.now, timer,
		send: async (to, text, facts) => (accept ? (sent.push({ ...to, text, ...facts }), true) : false),
		owner: (session) => ({ live: owners.get(session) ?? true, workspace: "w1" }),
		...(o.file ? { file: o.file } : {}),
	});
	return {
		clock, watches, sent, owners, gone, read,
		accept: (yes: boolean) => void (accept = yes),
		/** One reading of the GUI host `ms` later. */
		async beat(reading: Net, ms = 2000) { clock.advance(ms); last = reading; for (const cb of listeners) cb(reading); await settle(); },
		async pass(ms: number) { clock.advance(ms); await settle(); },
		async add(over: Record<string, unknown> = {}) { const r = await watches.add({ session: "s1", workspace: "w1", key: "u1", ...over } as never); await settle(); return r; },
	};
}

test("adding a watch reads the unit once and sends nothing; a change is sent at once, a second within the minute waits and only the newest goes out", async () => {
	const w = world();
	const added = await w.add();
	assert.equal(added.ok, true, JSON.stringify(added));
	assert.match(String((added.watch as { line: string }).line), /^watch u1: .*mark working/);
	assert.equal(w.sent.length, 0, "the state at the add is the baseline");
	await w.beat(netOf([unit({ mark: "waiting" })]));
	assert.equal(w.sent.length, 1);
	assert.match(w.sent[0]!.text, /^watch u1: changed .*mark waiting/);
	assert.deepEqual([w.sent[0]!.session, w.sent[0]!.workspace, w.sent[0]!.key, w.sent[0]!.state], ["s1", "w1", "u1", "changed"]);
	await w.beat(netOf([unit({ mark: "error" })]));
	await w.beat(netOf([unit({ mark: "done" })]));
	assert.equal(w.sent.length, 1, "within the minute nothing more goes out");
	await w.pass(RATE_MS);
	assert.equal(w.sent.length, 2, "one message when the minute is up");
	assert.match(w.sent[1]!.text, /mark done/);
	assert.ok(!w.sent.some((m) => /mark error/.test(m.text)), "a state that was overtaken is never sent");
});

test("a state equal to the one last sent is not sent again", async () => {
	const w = world();
	await w.add();
	await w.beat(netOf([unit({ mark: "waiting" })]));
	await w.beat(netOf([unit({ mark: "working" })]));
	await w.beat(netOf([unit({ mark: "waiting" })]));
	await w.pass(RATE_MS * 2);
	assert.deepEqual(w.sent.map((m) => /mark (\w+)/.exec(m.text)?.[1]), ["waiting"], "the newest state is what was sent already");
});

test(`at most ${PER_HOUR} messages an hour per session; the changes after them come as one summary line when the hour turns`, async () => {
	const w = world();
	await w.add();
	const marks = ["waiting", "error", "working"] as const;
	for (let i = 0; i < PER_HOUR + 2; i++) await w.beat(netOf([unit({ mark: marks[i % 3] })]), RATE_MS + 1000);
	assert.equal(w.sent.length, PER_HOUR, "the 13th and 14th changes are held");
	const first = w.sent.length;
	await w.pass(HOUR_MS);
	assert.equal(w.sent.length, first + 1, "one summary line");
	assert.match(w.sent.at(-1)!.text, /2 more watch changes/);
	assert.match(w.sent.at(-1)!.text, /boss_watch/);
	assert.match(w.sent.at(-1)!.text, /u1 changed/, "the summary names the newest state of each watch it held");
});

test("a unit that leaves the net is sent as gone, and the watch ends", async () => {
	const w = world();
	await w.add();
	await w.beat(netOf([]));
	assert.equal(w.sent.length, 1);
	assert.match(w.sent[0]!.text, /^watch u1: gone/);
	assert.deepEqual((w.watches.list("s1").watches as unknown[]).length, 0);
	await w.beat(netOf([unit({ mark: "waiting" })]), RATE_MS);
	assert.equal(w.sent.length, 1);
});

test("stop ends a watch; the same key added again replaces the old watch", async () => {
	const w = world();
	await w.add();
	await w.add({ quietMs: 120_000 });
	assert.equal((w.watches.list("s1").watches as unknown[]).length, 1, "one watch per session and key");
	assert.equal(w.watches.stop("s1", "u1").ok, true);
	await w.beat(netOf([unit({ mark: "waiting" })]));
	await w.pass(RATE_MS);
	assert.equal(w.sent.length, 0);
	assert.equal(w.watches.stop("s1", "u1").ok, false, "no such watch now");
});

test("a session that leaves the net loses its watches once it has been gone for the grace", async () => {
	const w = world();
	await w.add();
	w.owners.set("s1", false);
	for (let t = 0; t < OWNER_GRACE_MS; t += 60_000) await w.beat(netOf([unit()]), 60_000);
	await w.beat(netOf([unit({ mark: "waiting" })]), 60_000);
	assert.equal((w.watches.list("s1").watches as unknown[]).length, 0);
	assert.equal(w.sent.length, 0);
});

test("a restart of the server keeps the watches and sends no duplicate of what was told", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-watches-")), file = join(dir, "watches.json");
	dirs.push(dir);
	const a = world({ file });
	await a.add({ quietMs: 120_000 });
	await a.beat(netOf([unit({ mark: "waiting" })]));
	assert.equal(a.sent.length, 1);
	a.watches.stopAll();
	a.read.stop();
	const b = world({ file, clock: a.clock, net: netOf([unit({ mark: "waiting" })]) });
	b.watches.start();
	await b.beat(netOf([unit({ mark: "waiting" })]));
	await b.pass(RATE_MS);
	assert.equal(b.sent.length, 0, "the same facts after a restart are no change");
	assert.equal((b.watches.list("s1").watches as { key: string; quietMs?: number }[])[0]?.quietMs, 120_000);
	await b.beat(netOf([unit({ mark: "done" })]));
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0]!.text, /mark done/);
});

test("an unknown key is refused at once; the 9th watch of a session is refused", async () => {
	const w = world();
	assert.match(String((await w.add({ key: "nope" })).error), /unknown key nope/);
	const units = Array.from({ length: 9 }, (_, i) => unit({ id: `u${i}`, key: `u${i}` }));
	await w.beat(netOf(units));
	for (let i = 0; i < 8; i++) assert.equal((await w.add({ key: `u${i}` })).ok, true, `watch ${i}`);
	assert.match(String((await w.add({ key: "u8" })).error), /at most 8 watches/);
	assert.match(String((await w.add({ key: "u1", untilMs: 49 * 3_600_000 })).error), /until is at most 48h/);
});

test("a message the session did not take is tried again a minute later", async () => {
	const w = world();
	await w.add();
	w.accept(false);
	await w.beat(netOf([unit({ mark: "waiting" })]));
	assert.equal(w.sent.length, 0);
	w.accept(true);
	await w.pass(RATE_MS);
	assert.equal(w.sent.length, 1);
	assert.match(w.sent[0]!.text, /mark waiting/);
});
