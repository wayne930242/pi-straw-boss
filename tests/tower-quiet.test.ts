import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { fieldsOf, stamp, type Why } from "../src/header.ts";
import { writeEntry } from "../src/board.ts";
import { readBoard } from "../src/boardread.ts";
import type { Session } from "../src/herdr.ts";
import { addEntry, BOOK_KEEP_MS, bookSection, bookText, openHeadsUps, readBook, resourcesOf, untilOf } from "../src/server/logbook.ts";
import { sortCall } from "../src/server/towergate.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { putLedger, readQueue } from "../src/server/towerstore.ts";

// The quiet tower (docs/specs/2026-11-28-tower-quiet.md; boss 2026-11-28 「塔台只要有辦法查帳就好」): a milestone is recorded in the logbook and wakes no run unless it answers the tower's request; a heads-up is recorded and
// wakes a run only when it overlaps another open heads-up or a board of the workspace, else its sender hears "recorded, no clash seen"; blocked wakes as before. A woken run's brief lists what it has not read.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.runTimers = { hold: 400 };
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
const tower = () => world.client("sb-tower-wa")!;
const tower0 = { name: "tower", id: "sb-tower-wa", role: "tower" as const, workspace: "Alpha" };
/** A main of workspace Alpha (wA), live in the broker with its pane in Herdr. */
const main = (id: string, name: string, pane: string, tokens: Record<string, string> = {}): Session => {
	world.herdr.addPane(pane, "wA:t1").tokens = { sb_role: "main", ...tokens };
	const s = { id, name, herdrLocation: { status: "idle", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId: pane } };
	world.sessions.push(s);
	return s;
};
/** An intercom message from a main as `call_tower` writes it (the header of every Straw Boss since D19, 0.99.0 included). */
const call = (from: Session, id: string, text: string, why: Why | undefined, reply: boolean) =>
	({ id, content: { text: stamp({ from: { name: from.name!, id: from.id, role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [tower0], reply, ...(why ? { why } : {}) }, text) } });
const claimed = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return { token: String(got.token), brief: String(got.brief) };
};
const runOf = async (n: number) => {
	await until(() => world.pis.size >= n, `run ${n} to start`, 3000);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
const drain = async (s: Running, token: string) => {
	const texts: string[] = [];
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string; text: string } | undefined;
		if (!event) return texts;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
		texts.push(event.text.replace(/^\[straw net [^\]]*\] /, ""));
	}
};
const book = () => readBook(world.stateDir, Date.now()).entries;
/** The calls the gate ended with nothing woken (its `tower-gate-quiet` log line): nothing is queued for them, so no run can start for them. */
const quiet = () => { try { return readFileSync(join(world.stateDir, "server.log"), "utf8").split("\n").filter((l) => l.includes(" tower-gate-quiet ")).length; } catch { return 0; } };
const replies = (to: string) => tower().sent.filter((m) => m.to === to && fieldsOf(m.text)?.kind === "tower_reply");

test("a milestone that expects no reply is recorded in the logbook and wakes no run", async () => {
	await setup();
	const m = main("main-1", "docs-main", "wA:p1");
	tower().incoming(m, call(m, "m1", "api landed", "milestone", false));
	await until(() => quiet() === 1, "the gate to end the call");
	assert.equal(world.pis.size, 0, "no run woke");
	assert.equal(readQueue(world.slot, "wA").length, 0, "nothing queued");
	assert.deepEqual(book().map((e) => [e.kind, e.from.id, e.text, e.woke ?? false]), [["milestone", "main-1", "api landed", false]]);
	assert.ok(tower().receipts.some((r) => r.messageId === "m1" && r.status === "queued"), "the sender's send is receipted");
	assert.equal(replies("main-1").length, 0, "a notice that expects no reply gets none");
});

test("a milestone that expects a reply is recorded and its sender is told no answer comes, waking it; no run", async () => {
	await setup();
	const m = main("main-1", "docs-main", "wA:p1");
	tower().incoming(m, call(m, "m1", "api landed; anything else?", "milestone", true));
	await until(() => replies("main-1").length === 1, "the code's reply");
	assert.match(replies("main-1")[0]!.text, /recorded your milestone.*no answer comes.*why blocked/);
	assert.equal(replies("main-1")[0]!.noWake, undefined, "a sender that expects a reply is woken by it");
	await until(() => quiet() === 1, "the gate to end the call");
	assert.equal(readQueue(world.slot, "wA").length, 0, "nothing queued, so no run");
});

test("a milestone that answers the tower's request wakes a run: a main a tower opened (its pane token or the opener's ledger), or a session this tower asked", async () => {
	for (const how of ["token", "ledger", "expect"] as const) {
		const w = new TowerWorld();
		w.setFlag(true);
		w.runTimers = { hold: 100 };
		const prior = world;
		world = w;
		try {
			const s = await setup();
			const m = main("main-1", "docs-main", "wA:p1", how === "token" ? { sb_opened_by: "main-0" } : {});
			if (how === "ledger") putLedger(world.slot, "wA", { key: "k1", sender: "main-0", outcome: "opened", at: Date.now(), opened: { tab: "wA:t1", pane: "wA:p1", main: "main-1", sender: "main-0" } }, Date.now());
			if (how === "expect") await import("../src/server/towerrunstore.ts").then((x) => x.addExpect(world.slot, "wA", { to: "main-1", name: "docs-main", at: Date.now(), first: "please check" }, Date.now()));
			tower().incoming(m, call(m, "m1", "done: api landed", "milestone", false));
			const id = await runOf(1);
			assert.deepEqual(await drain(s, (await claimed(s, id)).token), ["done: api landed"], how);
			assert.equal(book()[0]?.woke, true, `${how}: the entry says it woke the tower`);
		} finally {
			await w.close();
			world = prior;
		}
	}
});

test("a heads-up that overlaps nothing is recorded with its resources and end, and its sender hears recorded, no clash seen, without being woken", async () => {
	await setup();
	const m = main("main-1", "docs-main", "wA:p1");
	tower().incoming(m, call(m, "h1", "deploying v3 1.62.0-beta.30 to ws01, ~20 min", "shared", false));
	await until(() => replies("main-1").length === 1, "the code's reply");
	assert.match(replies("main-1")[0]!.text, /recorded your heads-up.*no clash seen/);
	assert.equal(replies("main-1")[0]!.noWake, true);
	const [e] = book();
	assert.equal(e!.kind, "heads-up");
	assert.deepEqual(e!.resources, ["v3", "1.62.0-beta.30", "ws01"]);
	assert.ok(Math.abs(e!.until! - (e!.at + 20 * 60_000)) < 1000, "open for the 20 minutes it named");
	await until(() => quiet() === 1, "the gate to end the call");
	assert.equal(readQueue(world.slot, "wA").length, 0, "nothing queued, so no run");
});

test("a reply to an expected heads-up wakes the sender; the gate still answers it, and no run starts", async () => {
	await setup();
	const m = main("main-1", "docs-main", "wA:p1");
	tower().incoming(m, call(m, "h1", "using port 5432 for 1h", "shared", true));
	await until(() => replies("main-1").length === 1, "the code's reply");
	assert.equal(replies("main-1")[0]!.noWake, undefined);
	await until(() => quiet() === 1, "the gate to end the call");
	assert.equal(readQueue(world.slot, "wA").length, 0);
});

test("a second heads-up on the same resource from another main wakes the tower with a notice that names both", async () => {
	const s = await setup();
	const a = main("main-1", "docs-main", "wA:p1"), b = main("main-2", "web-main", "wA:p2");
	tower().incoming(a, call(a, "h1", "migrating database moldplan_staging for 1h", "shared", false));
	await until(() => replies("main-1").length === 1, "the first heads-up answered");
	tower().incoming(b, call(b, "h2", "restoring moldplan_staging from backup until 23:59", "shared", false));
	const id = await runOf(1);
	const got = await drain(s, (await claimed(s, id)).token);
	assert.equal(got.length, 2, JSON.stringify(got));
	assert.match(got[0]!, /Heads-up clash, seen by sb: web-main \(main-2\).*overlaps the heads-up of docs-main \(main-1\).*on moldplan_staging/);
	assert.equal(got[1], "restoring moldplan_staging from backup until 23:59");
	assert.equal(replies("main-2").length, 0, "the tower answers a clash, not the code");
	assert.equal(book().find((e) => e.from.id === "main-2")?.woke, true);
});

test("a heads-up from the same main again, or after the other one ended, is no clash", async () => {
	await setup();
	const a = main("main-1", "docs-main", "wA:p1");
	main("main-2", "web-main", "wA:p2");
	addEntry(world.stateDir, { kind: "heads-up", workspace: "wA", label: "Alpha", at: Date.now() - 3 * 3600_000, from: { id: "main-2", name: "web-main" }, text: "port 4321 for 1h", resources: ["4321"], until: Date.now() - 2 * 3600_000 }, Date.now());
	tower().incoming(a, call(a, "h1", "GUI demo on port 4321 for 30 min", "shared", false));
	tower().incoming(a, call(a, "h2", "GUI demo on port 4321 again, 10 min", "shared", false));
	await until(() => quiet() === 2, "the gate to end both calls");
	assert.equal(replies("main-1").length, 2);
	assert.equal(readQueue(world.slot, "wA").length, 0);
});

test("a heads-up that names what another main of the workspace has on its board wakes the tower", async () => {
	const s = await setup();
	const a = main("main-1", "docs-main", "wA:p1");
	main("main-2", "web-main", "wA:p2");
	writeEntry(join(world.stateDir, "board"), "main-2", { now: "MP-5740 UAT on ws01", items: [{ t: "recheck ws01 print", done: false }] }, Date.now());
	tower().incoming(a, call(a, "h1", "redeploying ws01 for 15 min", "shared", false));
	const id = await runOf(1);
	const got = await drain(s, (await claimed(s, id)).token);
	assert.match(got[0]!, /overlaps the board of web-main \(main-2\), a main of this workspace: «MP-5740 UAT on ws01 · recheck ws01 print», on ws01/);
	assert.equal(got[1], "redeploying ws01 for 15 min");
	assert.equal(replies("main-1").length, 0);
});

test("a heads-up that overlaps an open heads-up of another workspace wakes the tower", async () => {
	const s = await setup();
	const a = main("main-1", "docs-main", "wA:p1");
	addEntry(world.stateDir, { kind: "heads-up", workspace: "wB", label: "Beta", at: Date.now(), from: { id: "main-9", name: "ops-main" }, text: "rebooting infra-center for 30 min", resources: ["infra-center"], until: Date.now() + 30 * 60_000 }, Date.now());
	tower().incoming(a, call(a, "h1", "redeploying Prometheus on infra-center ~10 min", "shared", false));
	const id = await runOf(1);
	assert.match((await drain(s, (await claimed(s, id)).token))[0]!, /overlaps the heads-up of ops-main \(main-9\) of Beta.*on infra-center/);
});

test("blocked, unspecified, a car slip, a train manifest, and a waits-on cancel still wake a run as before", async () => {
	const slip = "car: web | tickets: MP-1\nbase: develop";
	const train = "train:\nproject: mp\ncode: 2026-11-28-a";
	for (const [what, why, text] of [["blocked", "blocked", "need the db owner"], ["unspecified", undefined, "hello"], ["car slip", "shared", slip], ["train", "shared", train]] as const) {
		const w = new TowerWorld();
		w.setFlag(true);
		w.runTimers = { hold: 3000 };
		const prior = world;
		world = w;
		try {
			await setup();
			const m = main("main-1", "docs-main", "wA:p1");
			tower().incoming(m, call(m, "x1", text, why, what === "blocked"));
			await until(() => world.pis.size === 1, `${what}: a run at the short wait`, 1500);
			assert.equal(book().length, 0, `${what}: not a logbook entry`);
		} finally {
			await w.close();
			world = prior;
		}
	}
	const cancel = stamp({ from: { name: "a", id: "main-1", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [tower0], reply: false, why: "milestone", waitsOn: { short: "abcdef", cancel: true } }, "withdrawn");
	assert.deepEqual(sortCall(cancel, "main-1", { opened: () => false, expects: () => false }), { book: false });
});

test("an old main's call (Straw Boss 0.99.0, the same header) goes through the same gate", () => {
	const old = '[straw net from=docs-main id=main-1 role=main workspace=Alpha kind=call_tower scope=tower to="tower (tower of Alpha)" reply=none why=milestone] api landed';
	assert.deepEqual(sortCall(old, "main-1", { opened: () => false, expects: () => false }), { book: "milestone", wake: false });
	assert.deepEqual(sortCall(old.replace("why=milestone", "why=shared"), "main-1", { opened: () => false, expects: () => false }), { book: "heads-up" });
	assert.deepEqual(sortCall(old.replace("why=milestone", "why=blocked"), "main-1", { opened: () => false, expects: () => false }), { book: false });
	assert.deepEqual(sortCall("plain text", "main-1", { opened: () => false, expects: () => false }), { book: false });
});

test("a woken run's brief lists the logbook entries no run read, oldest first; a run that ended well marks them read", async () => {
	const s = await setup();
	const a = main("main-1", "docs-main", "wA:p1"), b = main("main-2", "web-main", "wA:p2");
	tower().incoming(a, call(a, "m1", "api landed", "milestone", false));
	tower().incoming(b, call(b, "h1", "using port 5432 for 1h", "shared", false));
	await until(() => replies("main-2").length === 1, "the heads-up answered");
	tower().incoming(a, call(a, "b1", "need the db owner", "blocked", true));
	const first = await claimed(s, await runOf(1));
	const lines = first.brief.split("\n"), at = lines.findIndex((l) => l.startsWith("Logbook since your last run"));
	assert.ok(at >= 0, first.brief);
	assert.match(lines[at + 1]!, /^- \d\d:\d\d milestone from docs-main \(main-1\): «api landed»$/);
	assert.match(lines[at + 2]!, /^- \d\d:\d\d heads-up from web-main \(main-2\), open until \d\d:\d\d: «using port 5432 for 1h»$/);
	assert.ok(at < lines.findIndex((l) => l.startsWith("Mains you supervise")), "before the rest of the brief");
	assert.deepEqual(await drain(s, first.token), ["need the db owner"], "the recorded calls are no events");
	assert.equal((await ask(s, { cmd: "run-done", token: first.token, note: "routed" })).ok, true);
	world.live.delete(world.pis.get([...world.pis.keys()][0]!)!.pid); // its pi quits
	await until(() => readRun(world.slot, "wA", [...world.pis.keys()][0]!)?.outcome, "the first run to end");
	assert.equal(readBook(world.stateDir, Date.now()).read.wA, 2, "the read mark is at the newest entry the brief listed");
	tower().incoming(a, call(a, "b2", "still need the db owner", "blocked", true));
	const second = await claimed(s, await runOf(2));
	assert.doesNotMatch(second.brief, /Logbook since your last run/, "read once");
});

test("the logbook: resources, ends, expiry, and the readers (board_read's section, /boss board log)", () => {
	assert.deepEqual(resourcesOf("deploy v3 1.62.0-beta.29 to ws01 until 01:55, ~40 min; heads-up, port 5432, mig 193, https://atlas.moldplan.app/, origin/develop, follow-up 10 tests"), ["v3", "1.62.0-beta.29", "ws01", "5432", "193", "atlas.moldplan.app", "develop"]);
	assert.deepEqual(resourcesOf("nothing in particular, just a note"), []);
	const at = new Date(2026, 10, 28, 1, 0).getTime();
	assert.equal(untilOf("until ~01:55", at), new Date(2026, 10, 28, 1, 55).getTime());
	assert.equal(untilOf("until 00:30", at), new Date(2026, 10, 29, 0, 30).getTime(), "a time already past is tomorrow's");
	assert.equal(untilOf("for 2h", at), at + 2 * 3600_000);
	assert.equal(untilOf("(~10 min)", at), at + 10 * 60_000);
	assert.equal(untilOf("for 30 hours", at), at + BOOK_KEEP_MS, "never past 24 h");
	assert.equal(untilOf("no end named", at), at + BOOK_KEEP_MS);
	const dir = world.stateDir, now = Date.now();
	addEntry(dir, { kind: "heads-up", workspace: "wA", label: "Alpha", at: now - 60_000, from: { id: "main-1", name: "docs-main" }, text: "port 5432 for 1h", resources: ["5432"], until: now + 3600_000 }, now);
	addEntry(dir, { kind: "heads-up", workspace: "wB", label: "Beta", at: now - 60_000, from: { id: "main-9", name: "ops-main" }, text: "ws04 acl", resources: ["ws04"], until: now - 1 }, now);
	addEntry(dir, { kind: "milestone", workspace: "wB", label: "Beta", at: now - BOOK_KEEP_MS - 1, from: { id: "main-9", name: "ops-main" }, text: "old" }, now);
	assert.deepEqual(openHeadsUps(readBook(dir, now), now).map((e) => e.from.id), ["main-1"], "an ended heads-up is not open");
	assert.equal(readBook(dir, now).entries.length, 2, "a day-old entry is gone");
	const section = bookSection(dir, "wB", now)!;
	assert.match(section.recent[0]!, /heads-up from ops-main \(main-9\), ended: «ws04 acl»/);
	assert.match(section.elsewhere[0]!, /^Alpha: \d\d:\d\d heads-up from docs-main \(main-1\), open until/);
	assert.match(bookText(dir, now), /^Logbook \(milestones and heads-ups sb recorded for the towers[^\n]*\nAlpha \(wA\):\n {2}\d\d:\d\d heads-up from docs-main/);
});

test("board_read carries section logbook for the reader's workspace, and none in a remote turn", async () => {
	const now = Date.now();
	addEntry(world.stateDir, { kind: "milestone", workspace: "wA", label: "Alpha", at: now, from: { id: "main-1", name: "docs-main" }, text: "api landed" }, now);
	const read = (remote: boolean) => readBoard({ dir: join(world.stateDir, "board"), now, net: { sessions: [], ps: [] }, scope: "local", workspace: "wA", link: { boards: async () => [], remoteScope: () => (remote ? { teams: ["t"], project: undefined } : undefined) } as never });
	assert.match(((await read(false)).logbook as { recent: string[] }).recent[0]!, /milestone from docs-main \(main-1\): «api landed»/);
	assert.equal((await read(true)).logbook, undefined, "a peer's turn sees no logbook");
});
