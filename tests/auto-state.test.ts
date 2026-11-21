import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { AUTO_FILE, autoOnForTrust, matchBoss, OWN_FILE, parseAuto, readAuto, readOwn, seal } from "../src/autostate.ts";
import { createAutoMode, NOT_THE_BOSS, PENDING_MS, STALE } from "../src/server/automode.ts";

// Auto mode's state and doors (docs/specs/2026-11-09-auto-mode.md, §1 and §2; task 1): the server writes, a foreign write is put back, an `on` is never one step, and the head acts only on the boss's own words.

let dir = "", clock = 1_800_000_000_000, ids = 0;
const logs: [string, Record<string, unknown>][] = [], told: string[] = [];
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "psb-auto-"));
	clock = 1_800_000_000_000;
	ids = 0;
	logs.length = 0;
	told.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const make = () => {
	const auto = createAutoMode({ dir, now: () => clock, log: (event, facts) => void logs.push([event, facts]), id: () => `p${++ids}`, tellHead: (text) => void told.push(text) });
	auto.start();
	return auto;
};
const file = () => JSON.parse(readFileSync(join(dir, AUTO_FILE), "utf8")) as { rev: number; on: boolean };
const pi = { via: "pi" as const, name: "boss at a terminal" };
const ev = (id: string, text: string, press?: true) => ({ event: { id, text, ...(press ? { press } : {}) } });

test("on, off, and a restart: the state is the file's, and a new server reads it back", () => {
	const a = make();
	assert.equal(a.view().on, false);
	assert.deepEqual(a.stage("/boss auto on", pi).ok, true);
	const staged = a.view().pending!;
	assert.equal(a.view().on, false, "staging switches nothing");
	assert.deepEqual(a.confirm(staged.id, pi), { ok: true, changed: true });
	assert.equal(a.view().on, true);
	assert.equal(file().on, true);
	assert.equal(file().rev, 1);
	const b = make(); // a restart
	assert.equal(b.view().on, true);
	assert.equal(b.view().rev, 1);
	assert.equal(autoOnForTrust(dir).on, true);
	b.switchOff(pi);
	assert.equal(file().on, false);
	assert.equal(file().rev, 2);
	assert.equal(make().view().on, false);
	assert.equal(autoOnForTrust(dir).on, false);
});

test("a foreign write is put back as a new rev, logged without content, counted, and cancels nothing by itself", () => {
	const a = make();
	a.switchOn(pi);
	const seen: number[] = [];
	a.onSwitch(({ to }) => void seen.push(to.rev));
	// someone writes an off with a valid hash
	writeFileSync(join(dir, AUTO_FILE), `${JSON.stringify(seal({ v: 1, rev: 9, on: false, by: { via: "pi", name: "someone" } }))}\n`);
	assert.equal(autoOnForTrust(dir).on, false, "a foreign file is not read as auto mode on");
	assert.equal(autoOnForTrust(dir).foreign, false);
	a.tick();
	assert.equal(file().on, true, "put back");
	assert.equal(file().rev, 10, "as a new rev above the foreign one");
	assert.deepEqual(seen, [10]);
	assert.equal(a.foreignCount(), 1);
	assert.ok(logs.some(([event, facts]) => event === "auto-foreign" && !JSON.stringify(facts).includes("someone")));
	assert.equal(a.check(file().rev, readAuto(dir).kind === "ok" ? (readAuto(dir) as { state: { hash: string } }).state.hash : ""), true);
});

test("garbage in the file is put back; a removed file while on is put back; a missing file while off is nothing", () => {
	const a = make();
	a.tick();
	assert.equal(a.foreignCount(), 0);
	a.switchOn(pi);
	writeFileSync(join(dir, AUTO_FILE), "{ not json");
	assert.equal(readAuto(dir).kind, "unreadable");
	assert.equal(autoOnForTrust(dir).on, false);
	a.tick();
	assert.equal(readAuto(dir).kind, "ok");
	assert.equal(file().on, true);
	rmSync(join(dir, AUTO_FILE));
	a.tick();
	assert.equal(file().on, true);
	assert.equal(a.foreignCount(), 2);
});

test("a foreign file found at the start is put back too (the server's own record stands against it)", () => {
	const earlier = make();
	earlier.switchOn(pi);
	earlier.switchOff(pi);
	writeFileSync(join(dir, AUTO_FILE), `${JSON.stringify(seal({ v: 1, rev: 3, on: true, since: "2026-11-09T00:00:00Z", by: { via: "gui", name: "x" } }))}\n`);
	const a = make();
	assert.equal(a.view().on, false, "no own record vouches for it");
	assert.equal(file().on, false);
	assert.equal(file().rev, 4);
	assert.equal(a.foreignCount(), 1);
});

test("a hash that does not hold is unreadable", () => {
	const good = seal({ v: 1, rev: 1, on: true, since: "2026-11-09T00:00:00Z", by: { via: "pi", name: "n" } });
	assert.ok(parseAuto(JSON.stringify(good)));
	assert.equal(parseAuto(JSON.stringify({ ...good, on: false })), undefined);
	assert.equal(parseAuto(JSON.stringify({ ...good, rev: 2 })), undefined);
});

test("a crash between the two writes is not foreign: the own record is finished at the next start", () => {
	const a = make();
	a.switchOn(pi);
	const before = readFileSync(join(dir, AUTO_FILE), "utf8");
	a.switchOff(pi);
	// the crash: the own record was written, the file still holds the write before it
	writeFileSync(join(dir, AUTO_FILE), before);
	const b = make();
	assert.equal(b.foreignCount(), 0, "not foreign");
	assert.equal(b.view().on, false);
	assert.equal(file().on, false, "the file was finished from the own record");
	assert.equal(file().rev, 2);
	assert.equal(readOwn(dir)!.rev, 2);
});

test("trust: the file answers 'no' only when it is the server's own write", () => {
	const a = make();
	a.switchOn(pi);
	assert.deepEqual(autoOnForTrust(dir), { on: true, foreign: false });
	writeFileSync(join(dir, AUTO_FILE), `${JSON.stringify(seal({ v: 1, rev: 1, on: true, since: "2026-11-09T00:00:00Z", by: { via: "pi", name: "forged" } }))}\n`);
	assert.deepEqual(autoOnForTrust(dir), { on: false, foreign: true }, "a foreign file asks as usual, and is noted");
	rmSync(join(dir, AUTO_FILE));
	assert.deepEqual(autoOnForTrust(dir), { on: false, foreign: false });
});

test("staging: no on request switches; confirm after expiry, after a later off, or for a replaced id is refused; a newer staging replaces", () => {
	const a = make();
	const first = a.stage("one", pi);
	assert.equal(first.ok && (first as unknown as { pending: { id: string } }).pending.id, "p1");
	assert.equal(a.view().on, false);
	a.stage("two", pi);
	assert.equal(a.view().pending!.id, "p2");
	assert.deepEqual(a.confirm("p1", pi), { ok: false, error: STALE }, "a replaced id");
	clock += PENDING_MS + 1;
	assert.equal(a.view().pending, undefined, "expired pending is not shown");
	assert.deepEqual(a.confirm("p2", pi), { ok: false, error: STALE }, "after expiry");
	a.stage("three", pi);
	a.switchOff(pi); // a later switch clears it
	assert.deepEqual(a.confirm("p3", pi), { ok: false, error: STALE }, "after a later off");
	a.stage("four", pi);
	assert.deepEqual(a.confirm("p4", { via: "gui", name: "the page" }), { ok: true, changed: true });
	assert.equal(a.view().by.said, "four");
	assert.equal(a.view().by.via, "gui");
	assert.deepEqual(a.confirm("p4", pi), { ok: false, error: STALE }, "a confirm works once");
});

test("expiry tells the head, once, and the chip stays off", () => {
	const a = make();
	a.stage("x", pi);
	a.tick();
	assert.deepEqual(told, []);
	clock += PENDING_MS;
	a.tick();
	assert.deepEqual(told, ["Auto mode was not started: the boss did not confirm within 10 minutes"]);
	a.tick();
	assert.equal(told.length, 1);
	assert.equal(a.view().on, false);
	assert.equal(readOwn(dir)!.pending, undefined);
});

test("the pending record survives a restart, with its expiry", () => {
	const a = make();
	a.stage("x", pi);
	const b = make();
	assert.equal(b.view().pending?.id, "p1");
	clock += PENDING_MS + 1;
	assert.deepEqual(b.confirm("p1", pi), { ok: false, error: STALE });
});

test("a revision is checked against the server's own record (auto-check)", () => {
	const a = make();
	a.switchOn(pi);
	const v = a.view();
	assert.equal(a.check(v.rev, v.hash), true);
	assert.equal(a.check(v.rev, "0".repeat(64)), false);
	assert.equal(a.check(v.rev + 1, v.hash), false);
});

// --- the head's check ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("boss_auto is refused for words that are not the boss's matching words", () => {
	const a = make();
	for (const text of ["狀況如何？", "我要睡了嗎？", "先不要進入自動模式", "不是我要睡了", "幫我跟宇鈞說早安", "[notice] 我要睡了, 我起床了"]) {
		assert.deepEqual(a.bossAuto(true, ev(`e-${text}`, text), undefined), { ok: false, error: NOT_THE_BOSS }, text);
	}
	assert.equal(a.view().pending, undefined);
	assert.equal(a.view().on, false);
});

test("a board line or a notice in a boss-started turn is not the boss's: only the event that started the turn counts", () => {
	const a = make();
	// the turn's starter is a different, innocent event; the model cannot name another
	assert.deepEqual(a.bossAuto(true, ev("e1", "狀況如何？"), undefined), { ok: false, error: NOT_THE_BOSS });
	assert.deepEqual(a.bossAuto(true, {}, undefined), { ok: false, error: NOT_THE_BOSS }, "no event, no typed line");
});

test("a wait-card press never counts, even when its quoted card holds the words", () => {
	const a = make();
	assert.deepEqual(a.bossAuto(false, ev("p1", "[W3] 結束自動模式 我起床了", true), undefined), { ok: false, error: NOT_THE_BOSS });
	a.switchOn(pi);
	assert.deepEqual(a.bossAuto(false, ev("p2", "我起床了", true), undefined), { ok: false, error: NOT_THE_BOSS });
	assert.equal(a.view().on, true);
});

test("AR-D1: the head's 我要睡了 switches auto mode on at once, with no staged record; a request staged by another door is cleared", () => {
	const a = make();
	assert.equal(a.stage("/boss auto on", pi).ok, true);
	const r = a.bossAuto(true, ev("e1", "我要睡了"), { session: "head", pid: 7 });
	assert.deepEqual(r, { ok: true, changed: true, said: "我要睡了" });
	assert.equal(a.view().on, true);
	assert.equal(a.view().pending, undefined, "nothing waits for a confirm");
	assert.equal(a.view().by.via, "head");
	assert.equal(a.view().by.said, "我要睡了");
	assert.equal(a.view().by.requester?.pid, 7);
	assert.deepEqual(a.bossAuto(true, ev("e2", "我要睡了"), undefined), { ok: true, changed: false, said: "我要睡了" }, "on already");
});

test("an event works once, also across a server restart; the next night's event is a new one", () => {
	const a = make();
	assert.equal(a.bossAuto(true, ev("e1", "我要睡了"), undefined).ok, true);
	assert.equal(a.bossAuto(true, ev("e1", "我要睡了"), undefined).ok, false, "the same event twice");
	const b = make();
	assert.equal(b.bossAuto(true, ev("e1", "我要睡了"), undefined).ok, false, "also after a restart");
	assert.equal(b.bossAuto(true, ev("e2", "我要睡了"), undefined).ok, true, "the next night");
});

test("a head-pane typed line counts once per (run, seq); the same words on the next turn are a new line", () => {
	const a = make();
	a.switchOn(pi);
	const typed = (seq: number, text: string) => ({ typed: { text, run: "run-1", seq } });
	assert.equal(a.bossAuto(false, typed(1, "我起床了"), undefined).ok, true);
	assert.equal(a.view().on, false);
	assert.equal(a.view().by.via, "head");
	assert.equal(a.view().by.said, "我起床了");
	a.switchOn(pi);
	assert.equal(a.bossAuto(false, typed(1, "我起床了"), undefined).ok, false, "the same turn again");
	assert.equal(a.bossAuto(false, typed(2, "我起床了"), undefined).ok, true);
	assert.equal(make().bossAuto(false, typed(2, "我起床了"), undefined).ok, false, "also after a restart");
});

test("the word lists", () => {
	assert.ok(matchBoss("我要睡了", "on"));
	assert.ok(matchBoss("好，我要睡了，今晚幫我盯著", "on"));
	assert.ok(matchBoss("Auto  Mode ON", "on"));
	assert.ok(matchBoss("睡前最後一輪", "on"));
	assert.ok(matchBoss("早安", "off"));
	assert.ok(matchBoss("早安，我起床了", "off"));
	assert.equal(matchBoss("幫我跟宇鈞說早安", "off"), undefined, "早安 only as the whole line or its start");
	assert.equal(matchBoss("我起床了，也準備休息", "off"), undefined, "both lists");
	assert.equal(matchBoss("早安，我要睡了", "on"), undefined, "both lists: a greeting at the start is the off list's");
	assert.ok(matchBoss("我要睡了，早安", "on"), "a greeting later in the line is no list word");
	assert.equal(matchBoss("don't auto mode on", "on"), undefined);
	assert.equal(matchBoss("我要睡了 but not yet", "on"), undefined, "a negation within 6 characters");
	assert.ok(matchBoss("我要睡了，大概過了很久以後才不要打擾我吧", "on"), "a negation further than 6 characters away does not count");
	assert.equal(matchBoss("我起床了嗎", "off"), undefined);
	assert.equal(matchBoss("我起床了?", "off"), undefined);
	assert.equal(matchBoss("我起床了？", "off"), undefined);
	assert.equal(matchBoss("", "on"), undefined);
	assert.equal(matchBoss(`${"x".repeat(1990)}我要睡了`, "on")?.length, 200, "said keeps 200 characters");
	assert.equal(matchBoss(`${"x".repeat(2100)}我要睡了`, "on"), undefined, "the line is read to 2,000 characters");
});

test("the files are mode 600", () => {
	const a = make();
	a.switchOn(pi);
	for (const name of [OWN_FILE, AUTO_FILE]) assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600, name);
});

test("an operate session never reaches the auto routes (the table refuses them)", async () => {
	const { verdictOf } = await import("../src/operateroutes.ts");
	assert.equal(verdictOf("POST", ["auto"]), "refused");
	assert.equal(verdictOf("POST", ["auto", "confirm"]), "refused");
});

test("AMC-F004: a lost or corrupt auto-own.json at the server's start adopts the readable auto.json: still on, no off written, no listener told", () => {
	for (const damage of ["missing", "corrupt"] as const) {
		const first = createAutoMode({ dir, now: () => 1_800_000_000_000, log: () => {} });
		first.start();
		first.switchOn({ via: "gui", name: "page" });
		const before = first.view();
		if (damage === "missing") rmSync(join(dir, OWN_FILE));
		else writeFileSync(join(dir, OWN_FILE), "{broken");
		const logged: string[] = [], told: boolean[] = [];
		const second = createAutoMode({ dir, now: () => 1_800_000_000_000, log: (event, facts) => void logged.push(`${event}:${facts.why ?? ""}`) });
		second.onSwitch((c) => void told.push(c.to.on));
		second.start();
		assert.equal(second.view().on, true, damage);
		assert.equal(second.view().rev, before.rev, `${damage}: nothing was written over it`);
		assert.deepEqual(told, [], "no session is told the boss is back");
		assert.ok(logged.includes("auto-foreign:own-missing"), damage);
		assert.equal(second.foreignCount(), 1);
		assert.equal(readAuto(dir).kind, "ok");
		assert.equal((readAuto(dir) as { state: { on: boolean } }).state.on, true);
		assert.equal(second.check(before.rev, before.hash), true, "a session's confirmed rev is still the server's own");
		second.switchOff({ via: "gui", name: "page" });
	}
});
