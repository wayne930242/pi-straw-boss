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
import type { Pane } from "../src/herdr.ts";
import { withMoment } from "../src/link/waitcall.ts";
import type { IntercomLike } from "../src/server/kit.ts";
import { addEntry, BOOK_KEEP_MS, bookSection, bookText, entryLine, markRead, openHeadsUps, readBook, resourcesOf, shared, unreadOf, untilOf } from "../src/server/logbook.ts";
import type { Slot } from "../src/server/record.ts";
import { buildBrief } from "../src/server/towerbrief.ts";
import { createGate, logbookLockDir, sortCall } from "../src/server/towergate.ts";
import { addText, updateMemory } from "../src/server/towermemory.ts";
import { addExpect, readExpects, readRun } from "../src/server/towerrunstore.ts";
import { putLedger, readQueue, type ServiceRecord } from "../src/server/towerstore.ts";

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
	assert.match(got[0]!, /Heads-up clash, seen by sb: «web-main» \(main-2\).*overlaps the heads-up of «docs-main» \(main-1\).*on «moldplan_staging»/);
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
	assert.match(got[0]!, /overlaps the board of «web-main» \(main-2\), a main of the sender's workspace: «MP-5740 UAT on ws01 · recheck ws01 print», on «ws01»/);
	assert.equal(got[1], "redeploying ws01 for 15 min");
	assert.equal(replies("main-1").length, 0);
});

test("a heads-up that overlaps an open heads-up of another workspace wakes the tower", async () => {
	const s = await setup();
	const a = main("main-1", "docs-main", "wA:p1");
	addEntry(world.stateDir, { kind: "heads-up", workspace: "wB", label: "Beta", at: Date.now(), from: { id: "main-9", name: "ops-main" }, text: "rebooting infra-center for 30 min", resources: ["infra-center"], until: Date.now() + 30 * 60_000 }, Date.now());
	tower().incoming(a, call(a, "h1", "redeploying Prometheus on infra-center ~10 min", "shared", false));
	const id = await runOf(1);
	assert.match((await drain(s, (await claimed(s, id)).token))[0]!, /overlaps the heads-up of «ops-main» \(main-9\) of Beta.*on «infra-center»/);
});

test("blocked, unspecified, a car slip, a train manifest, and a waits-on cancel still wake a run as before", async () => {
	const slip = "car: web | tickets: MP-1\nbase: develop", lines = "car: moldplan-frontend-2\ntickets: MP-5801\nbranch: agent/mp-5801";
	const train = "train:\nproject: mp\ncode: 2026-11-28-a";
	for (const [what, why, text] of [["blocked", "blocked", "need the db owner"], ["unspecified", undefined, "hello"], ["car slip", "shared", slip], ["car slip on lines", "shared", lines], ["train", "shared", train]] as const) {
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
	assert.deepEqual(sortCall(old.replace("why=milestone", "why=shared"), "main-1", { opened: () => false, expects: () => false }), { book: "heads-up", wake: false });
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
	assert.match(lines[at + 1]!, /^- \d\d:\d\d milestone from «docs-main» \(main-1\): «api landed»$/);
	assert.match(lines[at + 2]!, /^- \d\d:\d\d heads-up from «web-main» \(main-2\), open until \d\d:\d\d: «using port 5432 for 1h»$/);
	assert.ok(at < lines.findIndex((l) => l.startsWith("Mains you supervise")), "before the rest of the brief");
	assert.deepEqual(await drain(s, first.token), ["need the db owner"], "the recorded calls are no events");
	assert.equal((await ask(s, { cmd: "run-done", token: first.token, note: "routed" })).ok, true);
	world.live.delete(world.pis.get([...world.pis.keys()][0]!)!.pid); // its pi quits
	await until(() => readRun(world.slot, "wA", [...world.pis.keys()][0]!)?.outcome, "the first run to end");
	assert.equal(readBook(world.slot.dir, Date.now()).read.wA, 2, "the read mark is at the newest entry the brief listed");
	tower().incoming(a, call(a, "b2", "still need the db owner", "blocked", true));
	const second = await claimed(s, await runOf(2));
	assert.doesNotMatch(second.brief, /Logbook since your last run/, "read once");
});

test("the logbook: resources, ends, expiry, and the readers (board_read's section, /boss board log)", () => {
	assert.deepEqual(resourcesOf("deploy v3 1.62.0-beta.29 to ws01 until 01:55, ~40 min; heads-up, port 5432, mig 193, https://atlas.moldplan.app/, origin/feat/x, follow-up 10 tests, push main, --include-all"), ["v3", "1.62.0-beta.29", "ws01", "5432", "193", "atlas.moldplan.app", "feat/x"]);
	// A bare `main` names nothing: on the field's heads-ups (2026-11-26/27) it matched pushes to different repositories.
	assert.deepEqual(resourcesOf("pushing skald main and deploying"), []);
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
	assert.deepEqual(openHeadsUps(readBook(dir, now).entries, now).map((e) => e.from.id), ["main-1"], "an ended heads-up is not open");
	assert.equal(readBook(dir, now).entries.length, 2, "a day-old entry is gone");
	const section = bookSection(dir, "wB", now)!;
	assert.match(section.recent[0]!, /heads-up from «ops-main» \(main-9\), ended: «ws04 acl»/);
	assert.match(section.elsewhere[0]!, /^Alpha: \d\d:\d\d heads-up from «docs-main» \(main-1\), open until/);
	assert.match(bookText(dir, now), /^Logbook \(milestones and heads-ups sb recorded for the towers[^\n]*\nAlpha \(wA\):\n {2}\d\d:\d\d heads-up from «docs-main»/);
});

test("board_read carries section logbook for the reader's workspace, and none in a remote turn", async () => {
	const now = Date.now();
	addEntry(world.stateDir, { kind: "milestone", workspace: "wA", label: "Alpha", at: now, from: { id: "main-1", name: "docs-main" }, text: "api landed" }, now);
	const read = (remote: boolean) => readBoard({ dir: join(world.stateDir, "board"), now, net: { sessions: [], ps: [] }, scope: "local", workspace: "wA", link: { boards: async () => [], remoteScope: () => (remote ? { teams: ["t"], project: undefined } : undefined) } as never });
	assert.match(((await read(false)).logbook as { recent: string[] }).recent[0]!, /milestone from «docs-main» \(main-1\): «api landed»/);
	assert.equal((await read(true)).logbook, undefined, "a peer's turn sees no logbook");
});

// --- the review round (quiet-F001 to F009) -----------------------------------------------------------------------------------------------------------------------------

/** A slot of this world's state folder: the primary (its folder is the state folder) or a secondary (`servers/<hash>`). */
const slotAt = (hash?: string): Slot => ({ stateDir: world.stateDir, herdr: hash ? `/tmp/herdr-${hash}.sock` : "/default.sock", primary: !hash, hash: hash ?? "0".repeat(16), slot8: (hash ?? "0".repeat(16)).slice(0, 8), dir: hash ? join(world.stateDir, "servers", hash) : world.stateDir });
const gateOf = (slot: Slot) => {
	const notices: string[] = [], logs: string[] = [];
	return { notices, logs, gate: createGate({ slot, now: () => Date.now(), log: (event) => void logs.push(event), notice: (_ws, text) => (notices.push(text), true) }) };
};
/** A session of workspace `ws`, placed in pane `pane` by the broker. */
const at = (id: string, name: string, ws: string, pane: string): Session => ({ id, name, herdrLocation: { status: "idle", workspace: { id: ws, label: `L-${ws}` }, tab: { id: `${ws}:t1`, label: "work" }, paneId: pane } });
const pane = (id: string, tokens: Record<string, string> = { sb_role: "main" }) => ({ pane_id: id, tab_id: `${id.split(":")[0]}:t1`, agent: "pi", tokens }) as Pane;
/** One message at a fake intake of the tower of `ws`: what it queued, saw, and sent back. */
const intake = (ws: string, read: () => Promise<{ sessions: Session[]; ps: Pane[] }>) => {
	const sent: { to: string; text: string }[] = [], n = { queued: 0, seen: 0 };
	const record = { workspace: ws, label: `L-${ws}`, name: `tower · L-${ws}`, id: `sb-tower-${ws.toLowerCase()}`, pane: "", tab: "", seq: 0 } as unknown as ServiceRecord;
	const client = { send: async (to: string, o: { text: string }) => (sent.push({ to, text: o.text }), { id: "x", delivered: true }) } as unknown as IntercomLike;
	return { sent, n, i: { record, client, read, queue: () => void n.queued++, seen: () => void n.seen++ } };
};
const netOf = (sessions: Session[], ps: Pane[]) => async () => ({ sessions, ps });

test("quiet-F001: each Herdr slot keeps its own logbook, so two servers never overwrite each other and one's w1 is not the other's; a heads-up still clashes across them", async () => {
	const one = slotAt(), two = slotAt("0123456789abcdef"), g1 = gateOf(one), g2 = gateOf(two);
	const a = at("main-a", "a-main", "w1", "w1:p1"), b = at("main-b", "b-main", "w1", "w1:p1");
	const i1 = intake("w1", netOf([a], [pane("w1:p1")])), i2 = intake("w1", netOf([b], [pane("w1:p1")]));
	await g1.gate.take(i1.i, a, call(a, "m1", "a landed", "milestone", false));
	await g2.gate.take(i2.i, b, call(b, "m1", "b landed", "milestone", false));
	const now = Date.now();
	assert.deepEqual(readBook(one.dir, now).entries.map((e) => e.text), ["a landed"]);
	assert.deepEqual(readBook(two.dir, now).entries.map((e) => e.text), ["b landed"]);
	markRead(one.dir, "w1", 1, now);
	assert.deepEqual(unreadOf(readBook(two.dir, now), "w1").map((e) => e.text), ["b landed"], "the other slot's w1 keeps its unread entry");
	await g1.gate.take(i1.i, a, call(a, "h1", "redeploying ws01 for 1h", "shared", false));
	await g2.gate.take(i2.i, b, call(b, "h2", "restoring ws01 for 30 min", "shared", false));
	assert.deepEqual([i1.n.queued, i2.n.queued], [0, 1], "the second slot's tower wakes on the first slot's heads-up");
	assert.match(g2.notices[0]!, /overlaps the heads-up of «a-main» \(main-a\) of L-w1/);
	assert.match(bookText(world.stateDir, now), /L-w1 \(w1\):[\s\S]*a landed[\s\S]*L-w1 \(w1 · 01234567\):[\s\S]*b landed/, "/boss board log reads both slots, each under its own");
});

test("quiet-F002: the gate classifies and records a call before the intake sees it, and a retry of it records nothing twice", async () => {
	const one = slotAt(), g = gateOf(one), m = at("main-1", "docs-main", "wA", "wA:p1");
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r)), net = { sessions: [m], ps: [pane("wA:p1", { sb_role: "main", sb_opened_by: "main-0" })] };
	const it = intake("wA", async () => (await held, net));
	const taken = g.gate.take(it.i, m, call(m, "m1", "done: api landed", "milestone", false));
	assert.notEqual(taken, false, "the gate takes a milestone");
	await new Promise((r) => setImmediate(r));
	assert.equal(it.n.seen + it.n.queued, 0, "not seen nor queued while the net read is out");
	assert.equal(readBook(one.dir, Date.now()).entries.length, 0, "nothing recorded before it is classified");
	release();
	await taken;
	assert.equal(it.n.queued, 1, "a main a tower opened: queued once classified");
	const again = intake("wA", netOf(net.sessions, net.ps));
	await g.gate.take(again.i, m, call(m, "m1", "done: api landed", "milestone", false));
	assert.equal(readBook(one.dir, Date.now()).entries.length, 1, "the retry of a message whose receipt never went records no second entry");
	assert.equal(again.n.queued, 1, "and it is queued as its first try decided");
});

test("quiet-F002: the sender's receipt goes only once its call is classified and recorded", async () => {
	await setup();
	const m = main("main-1", "docs-main", "wA:p1"), t = tower(), list = t.listSessions;
	let release!: () => void, asked = 0;
	const held = new Promise<void>((r) => (release = r));
	t.listSessions = async () => (asked++, await held, list());
	t.incoming(m, call(m, "m1", "api landed", "milestone", false));
	await until(() => asked > 0, "the gate to read the net");
	assert.equal(t.receipts.filter((r) => r.messageId === "m1").length, 0, "no receipt while the call is not classified");
	t.listSessions = list;
	release();
	await until(() => t.receipts.some((r) => r.messageId === "m1" && r.status === "queued"), "the receipt");
	assert.equal(book().length, 1);
});

test("quiet-F003: a session this tower asked reaches the tower whatever its why, shared included, and the wait on it clears", async () => {
	const s = await setup();
	const m = main("main-1", "docs-main", "wA:p1");
	addExpect(world.slot, "wA", { to: "main-1", name: "docs-main", at: Date.now(), first: "when is the release?" }, Date.now());
	tower().incoming(m, call(m, "h1", "confirmed: release at 14:00", "shared", false));
	const id = await runOf(1);
	assert.deepEqual(await drain(s, (await claimed(s, id)).token), ["confirmed: release at 14:00"]);
	assert.equal(readExpects(world.slot, "wA", Date.now()).length, 0, "the wait on it is cleared");
});

test("quiet-F004: a host and its endpoints (host:port, a URL) are one name, and the board compared is the sender's workspace's", async () => {
	assert.ok(resourcesOf("restoring the database on ws01:5432").includes("ws01"));
	assert.ok(resourcesOf("psql postgres://app@ws01.lan:5432/mp").includes("ws01.lan"));
	assert.deepEqual(shared(resourcesOf("restarting ws01"), resourcesOf("restoring ws01:5432")), ["ws01"]);
	const g = gateOf(slotAt()), a = at("main-1", "ops-main", "wB", "wB:p1"), b = at("main-2", "db-main", "wB", "wB:p2");
	writeEntry(join(world.stateDir, "board"), "main-2", { now: "restoring ws01:5432", items: [] }, Date.now());
	const it = intake("wA", netOf([a, b], [pane("wB:p1"), pane("wB:p2")]));
	await g.gate.take(it.i, a, call(a, "h1", "restarting ws01 for 10 min", "shared", false));
	assert.equal(it.n.queued, 1, "another workspace's main calls this tower: the board of its own workspace is compared");
	assert.match(g.notices[0]!, /overlaps the board of «db-main» \(main-2\), a main of the sender's workspace/);
});

test("quiet-F005: the read mark moves only to the last row a run was shown at its start, not past the rows the brief left out or a refresh added", async () => {
	const s = await setup();
	const a = main("main-1", "docs-main", "wA:p1");
	for (let n = 1; n <= 16; n++) tower().incoming(a, call(a, `m${n}`, `step ${n} landed`, "milestone", false));
	await until(() => quiet() === 16, "the gate to end the calls");
	tower().incoming(a, call(a, "b1", "need the db owner", "blocked", true));
	const first = await claimed(s, await runOf(1));
	assert.match(first.brief, /step 14 landed»\n\(\+2 more: board_read logbook\)/, first.brief);
	tower().incoming(a, call(a, "m17", "step 17 landed", "milestone", false));
	await until(() => quiet() === 17, "the gate to end the call");
	updateMemory(world.slot, "wA", Date.now(), (m) => void addText(m, Date.now(), "gui", "standing", "Never deploy on Fridays"));
	const polled = await ask(s, { cmd: "run-poll", token: first.token });
	assert.match(String(polled.brief), /newest brief, refreshed while you run/);
	await drain(s, first.token);
	assert.equal((await ask(s, { cmd: "run-done", token: first.token, note: "routed" })).ok, true);
	world.live.delete(world.pis.get([...world.pis.keys()][0]!)!.pid);
	await until(() => readRun(world.slot, "wA", [...world.pis.keys()][0]!)?.outcome, "the run to end");
	assert.equal(readBook(world.slot.dir, Date.now()).read.wA, 14, "rows 15 to 17 were not shown at the start: they stay unread");
});

test("quiet-F006: a car slip or a train manifest goes to the tower whatever its why; a malformed manifest is refused with a resend, not recorded as a heads-up", async () => {
	const none = { opened: () => false, expects: () => false };
	const of = (why: Why, text: string) => sortCall(stamp({ from: { name: "a", id: "main-1", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [tower0], reply: false, why }, text), "main-1", none);
	assert.deepEqual(of("milestone", "car: web | tickets: MP-1"), { book: false });
	assert.deepEqual(of("milestone", "car: moldplan-frontend-2\ntickets: MP-5801"), { book: false });
	assert.deepEqual(of("milestone", "train:\nproject: mp\ncode: 2026-11-28-a"), { book: false });
	const bad = of("shared", "train:\nproject: mp\ncode: tomorrow");
	assert.equal(bad.book, "reject");
	assert.match((bad as { why: string }).why, /not a train code/);
	const g = gateOf(slotAt()), m = at("main-1", "integ", "wA", "wA:p1"), it = intake("wA", netOf([m], [pane("wA:p1")]));
	await g.gate.take(it.i, m, call(m, "t1", "train:\nproject: mp\ncode: tomorrow", "shared", false));
	assert.deepEqual([it.n.queued, it.n.seen, readBook(slotAt().dir, Date.now()).entries.length], [0, 1, 0], "seen, nothing queued, nothing recorded");
	assert.match(it.sent[0]!.text, /reads as a train manifest.*not a train code.*send it again/);
});

test("quiet-F007: the handover notice sb writes carries its successor in the header, and the gate queues it", () => {
	const notice = stamp({ from: { name: "a", id: "main-1", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [tower0], reply: false, why: "milestone", handedTo: "opened-wA:p101" }, "handed over");
	assert.equal(fieldsOf(notice)?.["handed-to"], "opened-wA:p101");
	assert.deepEqual(sortCall(notice, "main-1", { opened: () => false, expects: () => false }), { book: false });
});

test("quiet-F008: a row cuts the sender's words before it fences them, and fences the sender's name too; the brief keeps every fence whole", () => {
	const now = Date.now(), long = "x".repeat(400), name = `«evil» ${"n".repeat(60)}`;
	const row = entryLine({ seq: 1, kind: "heads-up", workspace: "wA", label: "Alpha", at: now, from: { id: "main-1", name }, text: `deploying ws01 ${long}`, until: now + 60_000, woke: true, clash: "the heads-up of «b» (main-2) on «ws01»" }, now);
	assert.ok(Array.from(row).length <= 280, `${Array.from(row).length}`);
	assert.match(row, /from «evil n+…» \(main-1\)/, "the name loses its own fence marks and is fenced whole");
	assert.match(row, /: «deploying ws01 x+…»$/);
	const brief = buildBrief({ label: "Alpha", workspace: "wA", head: "", woken: "01:00", counts: {}, identity: "sb-tower-wa", mains: [], obligations: [], digest: [], book: [row], flags: [], tools: [] } as never);
	assert.ok(brief.includes(row), "the row reaches the brief uncut");
});

test("quiet-F009: call_tower's slip note reads a slip on lines as the gate does; a heads-up with no end stays open the day", () => {
	assert.match(withMoment({ text: "Sent." }, "car: moldplan-frontend-2\ntickets: MP-5801\nbranch: agent/mp-5801", "shared").text, /carries a car slip/);
	assert.match(withMoment({ text: "Sent." }, "car: web | tickets: MP-1", "shared").text, /carries a car slip/);
	assert.equal(withMoment({ text: "Sent." }, "deploying ws01", "shared").text, "Sent.");
	assert.equal(untilOf("deploying ws01", 0), BOOK_KEEP_MS);
});

// --- the second review round (quiet-F010, F011; F006 and F007 rest) ---------------------------------------------------------------------------------------------------

test("quiet-F010: two heads-ups whose net reads overlap still see each other's clash: the compare and the write are one step after the reads", async () => {
	const one = slotAt(), g = gateOf(one), a = at("main-1", "ops-main", "wA", "wA:p1"), b = at("main-2", "db-main", "wA", "wA:p2");
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r)), net = { sessions: [a, b], ps: [pane("wA:p1"), pane("wA:p2")] };
	const ia = intake("wA", async () => (await held, net)), ib = intake("wA", async () => (await held, net));
	const ta = g.gate.take(ia.i, a, call(a, "h1", "restarting ws01 for 10 min", "shared", false));
	const tb = g.gate.take(ib.i, b, call(b, "h2", "restoring ws01 for 30 min", "shared", false));
	await new Promise((r) => setImmediate(r));
	release();
	await Promise.all([ta, tb]);
	assert.deepEqual([ia.n.queued, ib.n.queued], [0, 1], "the second to be written wakes the tower");
	assert.match(g.notices[0]!, /«db-main» \(main-2\).*overlaps the heads-up of «ops-main» \(main-1\).*on «ws01»/);
	assert.equal(ia.sent.length + ib.sent.length, 1, "only the first hears go ahead");
});

test("quiet-F010: a heads-up waits while another slot's server holds the logbook lock, and is compared and written once it has it", async () => {
	const { takeLock } = await import("../src/server/trainlock.ts");
	const naps: (() => void)[] = [], one = slotAt(), two = slotAt("0123456789abcdef");
	const notices: string[] = [], g = createGate({ slot: two, now: () => Date.now(), log: () => {}, notice: (_ws, text) => (notices.push(text), true), sleep: () => new Promise<void>((r) => naps.push(r)) });
	const other = takeLock(logbookLockDir(world.stateDir), "logbook", { train: "logbook", step: 0 });
	assert.equal(other.ok, true);
	const b = at("main-2", "db-main", "w1", "w1:p1"), it = intake("w1", netOf([b], [pane("w1:p1")]));
	const taken = g.take(it.i, b, call(b, "h2", "restoring ws01 for 30 min", "shared", false));
	await until(() => naps.length === 1, "the gate to wait for the lock");
	assert.equal(readBook(two.dir, Date.now()).entries.length, 0, "nothing compared or written without the lock");
	// The holder writes its heads-up meanwhile, then lets go.
	addEntry(one.dir, { kind: "heads-up", workspace: "w1", label: "L-w1", at: Date.now(), from: { id: "main-1", name: "ops-main" }, text: "restarting ws01 for 10 min", resources: ["ws01"], until: Date.now() + 600_000 }, Date.now());
	if (other.ok) other.release();
	naps.shift()!();
	await taken;
	assert.equal(it.n.queued, 1, "the heads-up the holder wrote under the lock is seen");
	assert.match(notices[0]!, /overlaps the heads-up of «ops-main» \(main-1\)/);
});

test("quiet-F010: a logbook lock that stays busy past its wait records the heads-up and wakes the tower, the safe way to be wrong", async () => {
	const { takeLock } = await import("../src/server/trainlock.ts");
	let clock = Date.now();
	// The holder's start time is told, not read with ps at each look.
	const lock = { startOf: () => "T-1" }, logs: string[] = [];
	const g = createGate({ slot: slotAt(), now: () => clock, log: (event, facts) => void logs.push(`${event} ${facts.why ?? facts.wake ?? ""}`), notice: () => true, sleep: async (ms) => void (clock += ms), lock });
	const other = takeLock(logbookLockDir(world.stateDir), "logbook", { train: "logbook", step: 0, started: "T-1" }, lock);
	assert.equal(other.ok, true);
	const m = at("main-1", "ops-main", "wA", "wA:p1"), it = intake("wA", netOf([m], [pane("wA:p1")]));
	await g.take(it.i, m, call(m, "h1", "restarting ws01 for 10 min", "shared", false));
	if (other.ok) other.release();
	assert.equal(it.n.queued, 1);
	assert.equal(readBook(world.stateDir, clock).entries[0]?.woke, true);
	assert.ok(logs.some((l) => /^tower-gate-wake .*logbook lock/.test(l)), logs.join("\n"));
});

test("quiet-F011: a retry under its ~rN id joins the call in flight by its base id, per receiving tower and sender; a retry with other words gets no receipt", async () => {
	const one = slotAt(), g = gateOf(one), m = at("main-1", "docs-main", "wA", "wA:p1");
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r)), net = { sessions: [m], ps: [pane("wA:p1", { sb_role: "main", sb_opened_by: "main-0" })] };
	const it = intake("wA", async () => (await held, net));
	const first = g.gate.take(it.i, m, call(m, "m1", "done: api landed", "milestone", false));
	const retry = g.gate.take(it.i, m, call(m, "m1~r1", "done: api landed", "milestone", false));
	const other = g.gate.take(it.i, m, call(m, "m1~r2", "done: something else", "milestone", false));
	release();
	assert.deepEqual(await Promise.all([first, retry, other]), [true, true, false], "the retry shares the receipt; other words under the same base id do not");
	assert.deepEqual([readBook(one.dir, Date.now()).entries.length, it.n.queued], [1, 1], "one entry, queued once");
	assert.equal(readBook(one.dir, Date.now()).entries[0]!.msg, "m1", "the entry keeps the base id");
	// A server that started again has no call in flight: the entry answers for its base id, and its fingerprint for its words.
	const again = gateOf(one), later = intake("wA", netOf(net.sessions, net.ps));
	assert.equal(await again.gate.take(later.i, m, call(m, "m1~r3", "done: api landed", "milestone", false)), true);
	assert.equal(await again.gate.take(later.i, m, call(m, "m1~r4", "done: something else", "milestone", false)), false);
	assert.deepEqual([readBook(one.dir, Date.now()).entries.length, later.n.queued, later.n.seen], [1, 1, 0], "the retry is queued as its first try decided; the other words are dropped");
	// Another tower that got the same id from the sender keeps its own entry.
	const there = intake("wB", netOf(net.sessions, net.ps));
	assert.equal(await again.gate.take(there.i, m, call(m, "m1", "done: api landed", "milestone", false)), true);
	assert.equal(readBook(one.dir, Date.now()).entries.length, 2);
});

test("quiet-F006: a train: block is a manifest before anything else: one that does not read is refused, a car slip in it included; a train's own heads-up is no manifest", () => {
	const none = { opened: () => false, expects: () => false };
	const of = (why: Why, text: string) => sortCall(stamp({ from: { name: "a", id: "main-1", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [tower0], reply: false, why }, text), "main-1", none);
	assert.match(String((of("shared", "train:\napp: web\nbase: develop\nstages: merge, deploy") as { why?: string }).why), /missing project and code/);
	const slip = "car: web | tickets: MP-1\nhead: 0123456789abcdef0123456789abcdef01234567";
	assert.match(String((of("shared", `train:\nproject: mp\ncode: tomorrow\n\n${slip}`) as { why?: string }).why), /not a train code/);
	assert.deepEqual(of("shared", `train:\nproject: mp\ncode: 2026-11-28-a\n\n${slip}`), { book: false });
	assert.deepEqual(of("shared", "train: 2026-11-28-a deploying ws01 for 20 min"), { book: "heads-up", wake: false });
});

test("quiet-F007: the handover notice of a Straw Boss before handed-to (0.99.0's text, the sender's own session in it) is still queued", () => {
	const none = { opened: () => false, expects: () => false };
	const head = "[straw net from=docs-main id=main-1 role=main workspace=Alpha kind=call_tower scope=tower to=\"tower (tower of Alpha)\" reply=none why=milestone]";
	// The text v0.99.0's closemain.ts `handedNotice` writes, word for word.
	const text = (id: string) => `Straw Boss: main docs-main (session ${id}) handed over to its successor in tab wA:t2 (session opened-wA:p101), which took the handoff. docs-main steps down now and closes itself once its successor confirms the takeover and nothing of it runs; if it is still open later while its successor is live and it is idle, close it with boss_close_main with main "${id}".`;
	assert.deepEqual(sortCall(`${head} ${text("main-1")}`, "main-1", none), { book: false });
	assert.deepEqual(sortCall(`${head} ${text("main-9")}`, "main-1", none), { book: "milestone", wake: false }, "the text names another session than its sender: a milestone");
});

test("quiet-F011: at the intake, a retry of a call in flight is receipted with it, and one with other words is not", async () => {
	await setup();
	const m = main("main-1", "docs-main", "wA:p1", { sb_opened_by: "main-0" }), t = tower(), list = t.listSessions;
	let release!: () => void, asked = 0;
	const held = new Promise<void>((r) => (release = r));
	t.listSessions = async () => (asked++, await held, list());
	t.incoming(m, call(m, "m1", "done: api landed", "milestone", false));
	await until(() => asked > 0, "the gate to read the net");
	t.incoming(m, call(m, "m1~r1", "done: api landed", "milestone", false));
	t.incoming(m, call(m, "m1~r2", "done: other words", "milestone", false));
	t.listSessions = list;
	release();
	await until(() => t.receipts.filter((r) => r.status === "queued").length === 2, "the receipts");
	assert.deepEqual(t.receipts.filter((r) => r.status === "queued").map((r) => r.messageId).sort(), ["m1", "m1~r1"]);
	assert.equal(book().length, 1);
	assert.equal(readQueue(world.slot, "wA").filter((e) => e.kind === "intercom").length, 1, "queued once");
});

test("quiet-F012: the logbook lock lives apart from the trains' locks: train status never lists it, and a train step's lock named logbook is free while it is held", async () => {
	const { heldLocks, lockDirOf, takeLock } = await import("../src/server/trainlock.ts");
	let naps = 0;
	const g = createGate({ slot: slotAt(), now: () => Date.now(), log: () => {}, notice: () => true, sleep: async () => void naps++ });
	const m = at("main-1", "ops-main", "wA", "wA:p1"), it = intake("wA", netOf([m], [pane("wA:p1")]));
	// A train step holds a lock named logbook in the trains' folder; the gate does not wait on it.
	const train = takeLock(lockDirOf(world.stateDir), "logbook", { train: "2026-11-28-a", step: 3 });
	assert.equal(train.ok, true);
	await g.take(it.i, m, call(m, "h1", "restarting ws01 for 10 min", "shared", false));
	assert.equal(naps, 0, "the gate never waited on the train's lock");
	if (train.ok) train.release();
	// While the gate holds its own, the trains' folder lists nothing.
	const own = takeLock(logbookLockDir(world.stateDir), "logbook", { train: "logbook", step: 0 });
	assert.equal(own.ok, true);
	assert.deepEqual(heldLocks(lockDirOf(world.stateDir)), [], "train status lists no logbook lock");
	const step = takeLock(lockDirOf(world.stateDir), "logbook", { train: "2026-11-28-b", step: 1 });
	assert.equal(step.ok, true, "a train step's logbook lock does not wait on the gate's");
	if (step.ok) step.release();
	if (own.ok) own.release();
});

test("quiet-F013: other words under the base id of a call in flight are dropped whatever their why, blocked included", async () => {
	const one = slotAt(), g = gateOf(one), m = at("main-1", "docs-main", "wA", "wA:p1");
	let release!: () => void;
	const held = new Promise<void>((r) => (release = r)), net = { sessions: [m], ps: [pane("wA:p1")] };
	const it = intake("wA", async () => (await held, net));
	const first = g.gate.take(it.i, m, call(m, "m1", "done: api landed", "milestone", false));
	const other = g.gate.take(it.i, m, call(m, "m1~r1", "stuck: need the db password", "blocked", false));
	release();
	assert.notEqual(other, false, "not queued as a fresh call");
	assert.deepEqual(await Promise.all([first, other]), [true, false]);
});

test("quiet-F014: an old handover notice is found by its sentence and the sender's id, whatever the length of its title", () => {
	const none = { opened: () => false, expects: () => false };
	const head = "[straw net from=docs-main id=main-1 role=main workspace=Alpha kind=call_tower scope=tower to=\"tower (tower of Alpha)\" reply=none why=milestone]";
	const title = "docs-main ".repeat(25).trim();
	const text = (id: string) => `Straw Boss: main ${title} (session ${id}) handed over to its successor in tab wA:t2 (session opened-wA:p101), which took the handoff. ${title} steps down now.`;
	assert.ok(title.length > 200);
	assert.deepEqual(sortCall(`${head} ${text("main-1")}`, "main-1", none), { book: false });
	assert.deepEqual(sortCall(`${head} ${text("main-9")}`, "main-1", none), { book: "milestone", wake: false });
});
