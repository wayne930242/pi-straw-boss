import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { ENDED_MS, joinLocal, readEntries, STALE_MS, writeEntry } from "../src/board.ts";
import { boardRows, boardSeam, boardText, mainsOfNet } from "../src/boardview.ts";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { type Net, netSource } from "../src/net.ts";
import { sliceNet } from "../src/operateslice.ts";

// The work board on the boss's own page (docs/specs/2026-11-09-board-view.md, Data): the rows the server builds for the net snapshot and for `/boss board`. Ended entries stay while their file exists, the flags that make a row
// clearable come from the server's reading, a live main with no line is a row, and no ally row is ever made.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const state = () => (dirs.push(mkdtempSync(join(tmpdir(), "sb-boardview-"))), dirs.at(-1)!);
const MIN = 60_000, HOUR = 60 * MIN, NOW = Date.parse("2026-11-09T10:00:00Z");

const ws = (id: string, label: string, tokens: Record<string, string> = {}): Workspace => ({ workspace_id: id, label, tokens });
const pane = (id: string, workspace: string, tab: string, tokens: Record<string, string>): Pane => ({ pane_id: id, tab_id: tab, workspace_id: workspace, tokens });
const session = (id: string, name: string, p: string, workspace: string, tab: string, status = "idle"): Session => ({ id, name, status, herdrLocation: { status: "current", paneId: p, workspace: { id: workspace, label: workspace }, tab: { id: tab, label: `tab ${tab}` } } } as Session);
const workspaces = [ws("wA", "Alpha", { tower: "tower-a" }), ws("wB", "Beta")];
const panes = [
	pane("wA:p1", "wA", "wA:t1", { sb_role: "main" }), pane("wA:p2", "wA", "wA:t2", { sb_role: "main" }), pane("wA:p3", "wA", "wA:t3", { sb_role: "train", sb_train: "acme/2026-11-09-a" }),
	pane("wA:p5", "wA", "wA:t9", { sb_role: "tower" }), pane("wB:p1", "wB", "wB:t1", { sb_role: "main" }), pane("wA:p6", "wA", "wA:t1", { sb_role: "member" }),
];
const sessions = (status: Record<string, string> = {}) => [
	session("tower-a", "tower", "wA:p5", "wA", "wA:t9"), session("main-1", "billing", "wA:p1", "wA", "wA:t1", status["main-1"]), session("main-2", "reports", "wA:p2", "wA", "wA:t2", status["main-2"]),
	session("train-1", "train 1109a", "wA:p3", "wA", "wA:t3", status["train-1"]), session("main-b", "mobile", "wB:p1", "wB", "wB:t1", status["main-b"]), session("member-1", "helper", "wA:p6", "wA", "wA:t1"),
];
const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes } : { workspaces } });
const read = async (dir: string, status: Record<string, string> = {}, now = NOW) => netSource({ run: herdr, sessions: async () => sessions(status), sessionDir: "/s", board: boardSeam({ dir, now: () => now }) }).read();
const write = (dir: string, id: string, now: string, age: number, meta: Parameters<typeof writeEntry>[4] = {}, items = [{ t: "a", done: true }, { t: "b", done: false }]) => writeEntry(dir, id, { now, items }, NOW - age, meta);

test("the net snapshot carries the local board: a row per live main in tab order, the entry it wrote, and a main with no line as a row with its name and tab only", async () => {
	const dir = state();
	write(dir, "main-1", "MP-1 export", 12 * MIN);
	const net = await read(dir);
	const rows = net.board!;
	assert.deepEqual(rows.map((r) => [r.workspace, r.tab, r.main, r.session]), [["Alpha", "tab wA:t1", "billing", "main-1"], ["Alpha", "tab wA:t2", "reports", "main-2"], ["Alpha", "tab wA:t3", "train 1109a", "train-1"], ["Beta", "tab wB:t1", "mobile", "main-b"]], "the tower is no main; a train is");
	assert.deepEqual([rows[0]!.now, rows[0]!.items, rows[0]!.src, rows[0]!.updated, rows[0]!.state], ["MP-1 export", [{ t: "a", done: true }, { t: "b", done: false }], "set", NOW - 12 * MIN, "idle"]);
	assert.deepEqual(rows[1], { session: "main-2", workspace: "Alpha", tab: "tab wA:t2", main: "reports", state: "idle", items: [] }, "a live main with no line: name and tab only");
	assert.equal(rows[2]!.role, "train");
	assert.ok(!rows.some((r) => r.clearable), "nothing is clearable yet");
});

test("an ended entry stays listed while its file exists, however old: that is the point of the view (a tower's board_read hides it after 30 minutes)", async () => {
	const dir = state();
	write(dir, "gone-1", "old work", 5 * HOUR);
	write(dir, "gone-2", "newer", 2 * MIN);
	const rows = (await read(dir)).board!;
	const gone = rows.filter((r) => r.state === "ended");
	assert.deepEqual(gone.map((r) => [r.session, r.now, r.clearable]).sort(), [["gone-1", "old work", true], ["gone-2", "newer", true]]);
	assert.ok(gone.every((r) => r.workspace === "" && r.main === "" && r.updated !== undefined));
	// What towers get is unchanged.
	assert.equal(joinLocal(readEntries(dir), [], NOW).filter((r) => r.session === "gone-1").length, 0, "the routing join still lets an ended entry go after 30 minutes");
	assert.equal(joinLocal(readEntries(dir), [], NOW).filter((r) => r.session === "gone-2").length, 1);
	assert.ok(5 * HOUR > ENDED_MS);
});

test("stale and clearable: a live idle main whose line is over 2 hours old; never a working, waiting, or commanding one, or a fresh line", async () => {
	const dir = state();
	write(dir, "main-1", "idle and old", STALE_MS + MIN);
	write(dir, "main-2", "idle and fresh", STALE_MS - MIN);
	write(dir, "train-1", "working and old", STALE_MS + MIN);
	write(dir, "main-b", "waiting and old", STALE_MS + MIN);
	const rows = (await read(dir, { "train-1": "working" })).board!;
	const by = Object.fromEntries(rows.map((r) => [r.session, r]));
	assert.deepEqual([by["main-1"]!.stale, by["main-1"]!.clearable], [true, true]);
	assert.deepEqual([by["main-2"]!.stale, by["main-2"]!.clearable], [undefined, undefined]);
	assert.deepEqual([by["train-1"]!.state, by["train-1"]!.stale, by["train-1"]!.clearable], ["working", undefined, undefined]);
	const asked = (await netSource({ run: async (args) => JSON.stringify({ result: args[0] === "pane" ? { panes: panes.map((p) => (p.pane_id === "wB:p1" ? { ...p, agent_status: "blocked" } : p)) } : { workspaces } }), sessions: async () => sessions(), sessionDir: "/s", board: boardSeam({ dir, now: () => NOW }) }).read()).board!;
	assert.deepEqual([asked.find((r) => r.session === "main-b")!.state, asked.find((r) => r.session === "main-b")!.clearable], ["waiting", undefined], "a main that waits on a question is not idle");
});

test("the page's board takes a main's kind from its unit: a standing main's old line is not stale", () => {
	const unit = (key: string, duty: string) => ({ id: key, key, control: true, name: key, role: "main", duty, mark: "idle", subs: [] });
	const net = { bases: [{ id: "wA", label: "Alpha", mark: "idle", tower: null, tabs: [{ id: "wA:t1", label: "api", units: [unit("s1", "standing"), unit("c1", "coordinator")] }], outposts: [], outside: [] }] } as unknown as Net;
	const entries = ["s1", "c1"].map((id) => ({ v: 1 as const, session: id, now: "old", items: [], updated: NOW - 5 * HOUR, src: "set" as const }));
	assert.deepEqual(boardRows(entries, mainsOfNet(net), NOW).map((r) => [r.session, r.stale]), [["s1", undefined], ["c1", true]]);
});

test("an idle main that commands work (a subagent of it runs) is never stale, however old its line", () => {
	const mains = [{ session: "m1", name: "billing", workspaceId: "wA", workspace: "Alpha", tab: "api", state: "commanding", commanding: true }, { session: "m2", name: "reports", workspaceId: "wA", workspace: "Alpha", tab: "ui", state: "idle" }];
	const entries = ["m1", "m2"].map((id) => ({ v: 1 as const, session: id, now: "old", items: [], updated: NOW - 5 * HOUR, src: "set" as const }));
	assert.deepEqual(boardRows(entries, mains, NOW).map((r) => [r.session, r.state, r.stale, r.clearable]), [["m1", "commanding", undefined, undefined], ["m2", "idle", true, true]]);
});

test("the snapshot does not change with the clock: a row carries when the line was written, not how long ago, so the page is sent only when the board moved", async () => {
	const dir = state();
	write(dir, "main-1", "work", 10 * MIN);
	write(dir, "gone-1", "done", 40 * MIN);
	const first = JSON.stringify((await read(dir, {}, NOW)).board), later = JSON.stringify((await read(dir, {}, NOW + 30_000)).board);
	assert.equal(later, first);
	assert.notEqual(JSON.stringify((await read(dir, {}, NOW + 2 * HOUR)).board), first, "the stale flag turns on once, when the line passes 2 hours");
});

test("no board field when the seam is not given, and none from a net with no mains and no entries", async () => {
	const dir = state();
	assert.ok(!("board" in (await netSource({ run: herdr, sessions: async () => sessions(), sessionDir: "/s" }).read())));
	assert.ok(!("board" in (await netSource({ run: async (args) => JSON.stringify({ result: args[0] === "pane" ? { panes: [] } : { workspaces: [] } }), sessions: async () => [], sessionDir: "/s", board: boardSeam({ dir, now: () => NOW }) }).read())));
});

test("model-written text is raw in the row (the boss's own view keeps it as board_read does outside a remote turn) but cut to the board's caps; markup stays a string", async () => {
	const dir = state();
	write(dir, "main-1", `<img src=x onerror=alert(1)> ${"y".repeat(200)}`, MIN);
	const row = (await read(dir)).board!.find((r) => r.session === "main-1")!;
	assert.ok(row.now!.startsWith("<img src=x onerror=alert(1)> y"));
	assert.equal(Array.from(row.now!).length, 120);
});

test("allies' boards never reach the rows: a net that carries ally boards in its link gives the same rows as the same net without it, and an operate slice carries no board", async () => {
	const dir = state();
	write(dir, "main-1", "mine", MIN);
	const net = await read(dir);
	const allies = { allies: [{ id: "ally", label: "Ally", boards: [{ main: "theirs", now: "their work" }] }], alerts: [], confirms: [], units: [] };
	const withLink = { ...net, link: allies } as unknown as Net;
	const seam = boardSeam({ dir, now: () => NOW });
	const plain = seam.rows(net), linked = seam.rows(withLink);
	assert.ok(plain && plain.length > 0);
	assert.deepEqual(linked, plain, "the link summary changes nothing in the rows");
	assert.ok(!JSON.stringify(linked).includes("their work") && !JSON.stringify(linked).includes("theirs"));
	assert.deepEqual(plain.map((r) => r.session).sort(), ["main-1", "main-2", "main-b", "train-1"], "the rows come from this computer's files and mains only");
	assert.ok(!("board" in sliceNet(net, { box: true, has: () => true })), "the operate slice is an allow list that does not name the board");
});

test("a box this computer operates is another computer's board: its mains add no row and no Ask target", () => {
	const dir = state();
	const unit = (key: string) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "idle" as const, subs: [] });
	const base = (id: string, box?: object) => ({ id, label: id, mark: "idle" as const, tower: null, tabs: [{ id: `${id}:t`, label: "tab", units: [unit(`${id}-main`)] }], outposts: [], outside: [], ...(box ? { box } : {}) });
	const box = { device: "d1", short: "d1", label: "Box", team: "t", scope: "box", can: [], state: "live" };
	const seam = boardSeam({ dir, now: () => NOW });
	assert.deepEqual(seam.rows({ bases: [base("local"), base("remote", box)] as never })?.map((r) => r.session), ["local-main"]);
	assert.equal(seam.rows({ bases: [base("remote", box)] as never }), undefined, "a box's mains alone leave no board");
});

test("a line whose session is still open but is no longer a main is an ended row that says it is open (it is told on Clear); a session that is not live at all is not", async () => {
	const dir = state();
	write(dir, "member-1", "was a main once", 40 * MIN);
	write(dir, "gone-1", "closed", 40 * MIN);
	const rows = (await read(dir)).board!;
	const by = Object.fromEntries(rows.filter((r) => r.state === "ended").map((r) => [r.session, r]));
	assert.deepEqual([by["member-1"]!.open, by["member-1"]!.clearable], [true, true]);
	assert.deepEqual([by["gone-1"]!.open, by["gone-1"]!.clearable], [undefined, true]);
});

test("a session the broker lists but Herdr's reading has no pane for is open too: its ended row says so, as `/boss board` does (BV2-F002)", async () => {
	const dir = state();
	write(dir, "paneless-1", "between panes", 40 * MIN);
	write(dir, "gone-1", "closed", 40 * MIN);
	const paneless = { id: "paneless-1", name: "paneless", status: "idle" } as Session;
	const net = await netSource({ run: herdr, sessions: async () => [...sessions(), paneless], sessionDir: "/s", board: boardSeam({ dir, now: () => NOW }) }).read();
	const by = Object.fromEntries(net.board!.filter((r) => r.state === "ended").map((r) => [r.session, r]));
	assert.equal(by["paneless-1"]!.open, true, "a live broker session is not closed");
	assert.equal(by["gone-1"]!.open, undefined);
});

test("the entries are not parsed again while the folder and its files are unchanged; a new, rewritten, or removed file is read", async () => {
	const dir = state();
	write(dir, "main-1", "one", MIN);
	let parsed = 0;
	const seam = boardSeam({ dir, now: () => NOW, entries: (d) => (parsed++, readEntries(d)) });
	const net = await read(dir);
	const first = seam.rows(net);
	for (let i = 0; i < 5; i++) assert.deepEqual(seam.rows(net), first);
	assert.equal(parsed, 1, "six reads of an unchanged folder parse it once");
	write(dir, "gone-1", "two", MIN);
	assert.ok(seam.rows(net)!.some((r) => r.session === "gone-1"));
	assert.equal(parsed, 2, "a new file");
	write(dir, "gone-1", "two, longer than before", 2 * MIN);
	assert.equal(seam.rows(net)!.find((r) => r.session === "gone-1")!.now, "two, longer than before");
	assert.equal(parsed, 3, "a rewritten file");
	rmSync(join(dir, "gone-1.json"));
	assert.ok(!seam.rows(net)!.some((r) => r.session === "gone-1"));
	assert.equal(parsed, 4, "a removed file");
	// A rewrite that keeps the size and the modified time still changes the file (a new inode from the atomic rename), so it is read.
	const file = join(dir, "main-1.json"), again = (text: string) => writeEntry(dir, "main-1", { now: text, items: [{ t: "a", done: true }, { t: "b", done: false }] }, NOW - MIN);
	const fixed = new Date(NOW), pin = () => utimesSync(file, fixed, fixed);
	again("aaa");
	pin();
	seam.rows(net);
	const before = parsed, was = statSync(file);
	again("bbb");
	pin();
	assert.deepEqual([statSync(file).size, statSync(file).mtimeMs], [was.size, was.mtimeMs], "same size, same modified time");
	assert.equal(seam.rows(net)!.find((r) => r.session === "main-1")!.now, "bbb");
	assert.equal(parsed, before + 1, "still read");
});

test("/boss board: one line per row, grouped by workspace, with the state, the line, the done count, the age, and stale and ended marked in words", () => {
	const rows = boardRows(
		[...[["main-1", "MP-1 export", 12 * MIN], ["main-2", "idle for long", 3 * HOUR]].map(([id, now, age]) => writeEntryRow(id as string, now as string, age as number)), writeEntryRow("gone-1", "left behind", 6 * HOUR)],
		[{ session: "main-1", name: "billing", workspaceId: "wA", workspace: "Alpha", tab: "api", state: "working" }, { session: "main-2", name: "reports", workspaceId: "wA", workspace: "Alpha", tab: "ui", state: "idle" }, { session: "main-3", name: "quiet", workspaceId: "wA", workspace: "Alpha", tab: "ops", state: "idle" }],
		NOW,
	);
	const text = boardText(rows, NOW);
	assert.match(text, /Alpha › api · billing · working · MP-1 export · 1\/2 · 12 min ago/);
	assert.match(text, /Alpha › ui · reports · idle · idle for long · 1\/2 · 3 h ago · stale/);
	assert.match(text, /Alpha › ops · quiet · idle · no line/);
	assert.match(text, /^gone-1 · ended · left behind · 1\/2 · 6 h ago$/m);
	assert.match(text, /^Work board: 3 lines \(1 idle over 2 h, 1 ended, 1 main wrote none\)$/m);
	assert.equal(boardText([], NOW), "The work board is empty: no main has joined and no line is left.");
});
function writeEntryRow(session: string, now: string, age: number) {
	return { v: 1 as const, session, now, items: [{ t: "a", done: true }, { t: "b", done: false }], updated: NOW - age, src: "set" as const };
}

test("the files keep their age: a utimes change does not matter, the entry's own updated does", async () => {
	const dir = state();
	write(dir, "gone-1", "x", STALE_MS + HOUR);
	utimesSync(join(dir, "gone-1.json"), new Date(NOW), new Date(NOW));
	assert.equal((await read(dir)).board!.find((r) => r.session === "gone-1")!.updated, NOW - STALE_MS - HOUR);
});
