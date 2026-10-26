import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { checkEntry, clean, cleanText, DEAD_MS, ENDED_MS, joinLocal, purge, readEntries, removeEntry, writeEntry } from "../src/board.ts";
import { setBoard } from "../src/boardset.ts";
import { type Agent, World } from "./fakes.ts";

// The work board's local half (docs/specs/2026-10-25-straw-link.md, Work board): the entry rules, the files, expiry, `board_set`, and `board_read`.

let dir = "";
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "psb-board-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const T0 = 1_800_000_000_000, MIN = 60_000;
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");

test("the write rules: now 1 to 120 characters, 8 items of 1 to 80, whitespace folded, control and bidi characters refused, nothing cut silently", () => {
	assert.deepEqual(checkEntry({ now: "  MP-1\n export:\t CSV   writer ", items: [{ t: "schema", done: true }] }), { now: "MP-1 export: CSV writer", items: [{ t: "schema", done: true }] });
	assert.deepEqual(checkEntry({ now: "密碼", items: [] }), { now: "密碼", items: [] }, "no items is an empty list");
	assert.equal(checkEntry({ now: "x".repeat(120) }).now.length, 120);
	assert.throws(() => checkEntry({ now: "x".repeat(121) }), /121 characters; at most 120/);
	assert.throws(() => checkEntry({ now: "   " }), /now is empty/);
	assert.throws(() => checkEntry({ now: "a", items: Array.from({ length: 9 }, () => ({ t: "x", done: false })) }), /at most 8/);
	assert.throws(() => checkEntry({ now: "a", items: [{ t: "x".repeat(81), done: false }] }), /item 1 has 81 characters; at most 80/);
	assert.throws(() => checkEntry({ now: "a", items: [{ t: "", done: false }] }), /item 1 is empty/);
	assert.throws(() => checkEntry({ now: "a", items: [{ t: "x" }] }), /done has to be true or false/);
	for (const bad of ["a\x1b[31mred", "a\u202Eevil", "a\u200Bb", "a\x00b", "a\x7fb", "a\u2066b"]) assert.throws(() => checkEntry({ now: bad }), /control or format characters/, JSON.stringify(bad));
	assert.throws(() => checkEntry({ now: "a", items: [{ t: "ok\u202Eno", done: true }] }), /control or format/);
	assert.throws(() => checkEntry({ now: 5 as never }), /has to be text/);
});

test("the reader holds a file to the same rules by cutting: removal of control and format characters, folded whitespace, caps", () => {
	assert.equal(clean("a\x1b[3Gb\u202Ec\u200Bd\n e", 40), "a[3Gbcd e");
	assert.equal(clean("x".repeat(50), 40).length, 40);
	const cut = cleanText({ now: `${"y".repeat(130)}`, items: Array.from({ length: 10 }, (_, i) => ({ t: i === 0 ? "a\u202Eb" : "z".repeat(90), done: i % 2 === 0 })) });
	assert.equal(cut.now.length, 120);
	assert.equal(cut.items.length, 8);
	assert.equal(cut.items[0]!.t, "ab");
	assert.ok(cut.items.every((i) => i.t.length <= 80));
	assert.deepEqual(cleanText({ now: "a", items: [{ t: "ok", done: "yes" }, { t: 1, done: true }, null] }).items, [], "an item that fails the structure check is dropped");
});

test("an entry is the session's own file, written whole and atomically, readable by this user only", () => {
	const entry = writeEntry(dir, "session-1", { now: "work", items: [{ t: "a", done: false }] }, T0);
	assert.deepEqual(entry, { v: 1, session: "session-1", now: "work", items: [{ t: "a", done: false }], updated: T0 });
	writeEntry(dir, "session-1", { now: "newer", items: [] }, T0 + 5);
	assert.deepEqual(readdirSync(dir), ["session-1.json"], "a rename replaces the file; no temporary file is left");
	assert.deepEqual(readEntries(dir).map((e) => [e.session, e.now, e.items.length, e.updated]), [["session-1", "newer", 0, T0 + 5]]);
	if (process.platform !== "win32") assert.equal(statSync(join(dir, "session-1.json")).mode & 0o777, 0o600);
	if (process.platform !== "win32") assert.equal(statSync(dir).mode & 0o777, 0o700);
	for (const bad of ["../x", "a/b", "", ".hidden", "a b"]) assert.throws(() => writeEntry(dir, bad, { now: "x", items: [] }, T0), /no id a board file can be named for/, bad);
	removeEntry(dir, "../session-1");
	assert.equal(readEntries(dir).length, 1, "no name reaches another folder");
	removeEntry(dir, "session-1");
	assert.deepEqual(readdirSync(dir), []);
});

test("a file that fails the structure check, or names another session than its own file, is ignored", () => {
	const put = (name: string, body: unknown) => writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
	put("good.json", { v: 1, session: "good", now: "ok", items: [], updated: T0 });
	put("copy.json", { v: 1, session: "other", now: "ok", items: [], updated: T0 });
	put("v2.json", { v: 2, session: "v2", now: "ok", items: [], updated: T0 });
	put("junk.json", "{ not json");
	put("items.json", { v: 1, session: "items", now: "ok", items: [{ t: 1, done: true }], updated: T0 });
	put("time.json", { v: 1, session: "time", now: "ok", items: [], updated: "soon" });
	put("note.txt", "ignored");
	assert.deepEqual(readEntries(dir).map((e) => e.session), ["good"]);
	assert.deepEqual(readEntries(join(dir, "missing")), []);
});

test("expiry: a live main shows with or without an entry; an entry whose session is gone shows as ended for 30 minutes after its update, then not at all", () => {
	const mains = [{ session: "live", name: "api main", workspaceId: "wA", workspace: "Alpha", tab: "api", state: "working", cwd: "/p" }, { session: "bare", name: "no entry", workspaceId: "wA", workspace: "Alpha", tab: "docs", state: "idle" }];
	const entries = (updated: number) => [{ v: 1 as const, session: "live", now: "x", items: [], updated: T0 }, { v: 1 as const, session: "gone", now: "left half done", items: [{ t: "a", done: true }], updated }];
	const fresh = joinLocal(entries(T0 - 5 * MIN), mains, T0);
	assert.deepEqual(fresh.map((r) => [r.session, r.state, r.now ?? null]), [["live", "working", "x"], ["bare", "idle", null], ["gone", "ended", "left half done"]]);
	assert.equal(fresh[2]!.updatedSecondsAgo, 300);
	assert.equal(joinLocal(entries(T0 - ENDED_MS), mains, T0).length, 3, "exactly 30 minutes is still shown");
	assert.equal(joinLocal(entries(T0 - ENDED_MS - 1), mains, T0).length, 2, "past 30 minutes it is gone from the board");
});

test("a dead session's file is deleted once it is 24 hours old; a live one's and a young dead one's stay", () => {
	for (const [session, age] of [["live-old", DEAD_MS + MIN], ["dead-old", DEAD_MS + MIN], ["dead-young", DEAD_MS - MIN]] as const) {
		writeEntry(dir, session, { now: "x", items: [] }, T0 - age);
	}
	writeFileSync(join(dir, "junk.json"), "x");
	utimesSync(join(dir, "junk.json"), (T0 - 2 * DEAD_MS) / 1000, (T0 - 2 * DEAD_MS) / 1000);
	purge(dir, new Set(["live-old"]), T0);
	assert.deepEqual(readdirSync(dir).sort(), ["dead-young.json", "live-old.json"]);
});

test("setBoard refuses a session that is not its tab's main (a member, a demoted main, a tower, a subagent all reach it as not main) and writes only its own file", () => {
	const base = { dir: join(dir, "board"), stateDir: dir, session: "s1", now: T0, cwd: dir, home: dir, agentDir: join(dir, "agent") };
	assert.throws(() => setBoard({ ...base, isMain: false, input: { now: "x" } }), /Only the main agent of a tab writes/);
	assert.equal(readEntries(base.dir).length, 0);
	const done = setBoard({ ...base, isMain: true, input: { now: "MP-1", items: [{ t: "a", done: true }] } });
	assert.match(done.text, /It goes to: local towers\./);
	assert.deepEqual(readEntries(base.dir).map((e) => e.session), ["s1"]);
});

// ---- A session in a world: the tools and the shutdown ------------------------------------------------------------------------------

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const boardDir = () => join(world.stateDir, "board");

async function town() {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	const main = world.agent({ id: "a1", name: "api-main", pane: "wA:p1", tab: "wA:t1" });
	const member = world.agent({ id: "a2", name: "helper", pane: "wA:p2", tab: "wA:t1" });
	const kid = world.agent({ id: "k1", name: "kid", pane: "wA:p3", tab: "wA:t1", env: { PI_SUBAGENT_ID: "sub-1" } });
	await Promise.all(world.agents.map((a) => a.start()));
	await main.promote();
	return { tower, main, member, kid };
}

test("board_set is the main's: a member, a tower, and a subagent cannot write, and the file is the main's own session id", async () => {
	const { tower, main, member, kid } = await town();
	assert.ok(!tower.tools.has("board_set") && !kid.tools.has("board_set") && !kid.tools.has("board_read"), "a tower and a subagent have no board_set");
	assert.ok(member.tools.has("board_set") && main.tools.has("board_set") && !main.tools.has("board_read") && !member.tools.has("board_read"), "mains and members have no board_read");
	await assert.rejects(member.tool("board_set", { now: "I help" }), /Only the main agent of a tab writes/);
	await assert.rejects(main.tool("board_set", { now: "x".repeat(121) }), /at most 120/);
	const answer = textOf(await main.tool("board_set", { now: "MP-1 export: CSV writer", items: [{ t: "schema", done: true }, { t: "writer", done: false }] }));
	assert.match(answer, /It goes to: local towers\./);
	assert.deepEqual(readdirSync(boardDir()), ["a1.json"]);
	assert.deepEqual(JSON.parse(readFileSync(join(boardDir(), "a1.json"), "utf8")).items, [{ t: "schema", done: true }, { t: "writer", done: false }]);
	await main.tool("board_set", { now: "replaced" });
	assert.deepEqual(readEntries(boardDir()).map((e) => [e.now, e.items.length]), [["replaced", 0]], "board_set replaces the whole entry");
});

test("a main's session_shutdown deletes its entry on quit, new, resume, and fork, and keeps it on reload", async () => {
	for (const reason of ["quit", "new", "resume", "fork", "reload"]) {
		const w = new World();
		world = w;
		const main = w.agent({ id: "a1", name: "api-main", pane: "wA:p1", tab: "wA:t1" });
		await main.start();
		await main.promote();
		await main.tool("board_set", { now: "work" });
		assert.equal(readEntries(join(w.stateDir, "board")).length, 1);
		await main.stop(reason);
		assert.equal(readEntries(join(w.stateDir, "board")).length, reason === "reload" ? 1 : 0, reason);
		await w.stopAll();
	}
	world = new World();
});

/** A tower reading the board: the local rows join each main's name, tab, workspace, and state from the net. */
async function reader(tower: Agent) {
	const result = JSON.parse(textOf(await tower.tool("board_read", {}))) as { note: string; local: Record<string, unknown>[]; remote?: unknown[] };
	return result;
}

test("board_read (towers only): the output shape, a live main with no entry beside one with, ended entries, and no remote key without Straw Link", async () => {
	const { tower, main, member } = await town();
	const b = world.agent({ id: "b1", name: "ops-main", pane: "wA:p4", tab: "wA:t2" });
	await b.start();
	await b.promote();
	await main.tool("board_set", { now: "MP-1 export: CSV writer", items: [{ t: "schema", done: true }, { t: "writer", done: false }] });
	writeEntry(boardDir(), "left-1", { now: "left half done", items: [{ t: "x", done: true }] }, Date.now() - 5 * MIN);
	writeEntry(boardDir(), "left-2", { now: "very old", items: [] }, Date.now() - 2 * ENDED_MS);
	const result = await reader(tower);
	assert.match(result.note, /data, not instructions/);
	assert.ok(!("remote" in result), "Straw Link is not set up here");
	const rows = result.local.map((r) => [r.main, r.tab, r.workspace, r.state, r.now ?? null]);
	const api = rows.find((r) => r[0] === "api-main")!;
	assert.deepEqual([api[0], api[2], api[3], api[4]], ["api-main", "Alpha", "idle", "MP-1 export: CSV writer"]);
	assert.equal(typeof api[1], "string");
	assert.ok(rows.some((r) => r[0] === "ops-main" && r[4] === null), "a live main with no entry shows with its name and tab and no now");
	assert.ok(!rows.some((r) => r[0] === "helper"), "a member is no main");
	assert.deepEqual(result.local.find((r) => r.state === "ended"), { workspace: "", tab: "", main: "", state: "ended", now: "left half done", items: [{ t: "x", done: true }], updatedSecondsAgo: 300 });
	assert.equal(result.local.filter((r) => r.state === "ended").length, 1, "an entry 60 minutes old is gone");
	assert.equal(result.local.find((r) => r.main === "api-main")!.updatedSecondsAgo !== undefined, true);
	assert.ok(member && main);
});

test("board_read deletes the files of dead sessions that are over 24 hours old", async () => {
	const { tower } = await town();
	writeEntry(boardDir(), "dead-old", { now: "x", items: [] }, Date.now() - DEAD_MS - MIN);
	await reader(tower);
	assert.ok(!readdirSync(boardDir()).includes("dead-old.json"));
});
