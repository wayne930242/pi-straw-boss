import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { collectNet } from "../src/net.ts";
import { collect, type Row, render, type Snapshot, startDashboard, subagents, type Tone } from "../src/dashboard.ts";
import { type FakeTui, settle, until, World } from "./fakes.ts";

let world = new World();
const scratch = mkdtempSync(join(tmpdir(), "psb-dash-test-"));
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const plain = (_tone: string, text: string) => text;

const norm = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const row = (group: Row["group"], depth: number, mark: Row["mark"], text: string, kind?: string, note?: string): Row => ({ group, depth, mark, text, kind, note });
const net = (depth: number, mark: Row["mark"], text: string, kind?: string, note?: string) => row("net", depth, mark, text, kind, note);
const snapshot = (rows: Row[], head = true): Snapshot => ({ title: "Alpha", mark: "working", head, rows });
const sample = snapshot([
	net(0, "unknown", "tab work"),
	net(1, "working", "Main One", "main", "tool:edit"),
	net(2, "waiting", "asker", "subagent", "waiting on a question"),
	net(2, "done", "reviewer", "subagent", "finished"),
	net(1, "idle", "Member", "member"),
	net(0, "unknown", "tab docs"),
	net(1, "error", "Docs", "main", "boom"),
	net(0, "working", "Alpha feature", "sub workspace"),
	row("towers", 0, "idle", "Beta", "head tower"),
	row("towers", 0, "done", "Gamma", "tower"),
]);

test("render draws a rounded frame with a title, section headers, a tree, and aligned columns", () => {
	assert.deepEqual(render(sample, 0, 100, plain), [
		"╭─ ⠋ tower · Alpha ─────────────────────────────────────────── head tower ─╮",
		"│ this net                                                                 │",
		"│ ├─ tab work                                                              │",
		"│ │  ├─ ⠋ Main One     main           tool:edit                            │",
		"│ │  │  ├─ ? asker     subagent       waiting on a question                │",
		"│ │  │  └─ ✓ reviewer  subagent       finished                             │",
		"│ │  └─ ○ Member       member                                              │",
		"│ ├─ tab docs                                                              │",
		"│ │  └─ ✗ Docs         main           boom                                 │",
		"│ └─ ⠋ Alpha feature   sub workspace                                       │",
		"│ other towers                                                             │",
		"│ ○ Beta               head tower                                          │",
		"│ ✓ Gamma              tower                                               │",
		"╰──────────────────────────────────────────────────────────────────────────╯",
	]);
});

test("the spinner advances with the frame and nothing else changes; the head tag shows only on the head tower", () => {
	const [a, b] = [render(sample, 0, 100, plain), render(sample, 1, 100, plain)];
	assert.equal(b[0]!.includes("⠙ tower · Alpha"), true);
	assert.deepEqual(b.filter((l, i) => l !== a[i]).length, 3, "the title, the main agent, and the sub workspace animate");
	assert.ok(!render(snapshot(sample.rows, false), 0, 100, plain)[0]!.includes("head tower"));
});

test("each state has one glyph and one theme color, and the frame uses the border and title colors", () => {
	const tagged = (tone: Tone, text: string) => `<${tone}:${text}>`;
	const lines = render(sample, 0, 100, tagged).join("\n");
	for (const expected of ["<accent:⠋>", "<warning:?>", "<dim:○>", "<success:✓>", "<error:✗>", "<title:tower · Alpha>", "<border:╭─>", "<accent:head tower>", "<muted:this net>"]) assert.ok(lines.includes(expected), expected);
});

test("nothing joined yet is said once, and the other-towers section is omitted when there are none", () => {
	const lines = render(snapshot([]), 0, 60, plain);
	assert.deepEqual(lines.slice(1, -1).map((l) => l.replace(/\s+│$/, "")), ["│ this net", "│   nothing has joined yet"]);
});

test("every line fits the width with real ANSI styling, at any width, and the frame stops growing at 76 columns", () => {
	const styled = (tone: Tone, text: string) => `\u001b[1;3${tone.length % 7}m${text}\u001b[0m`;
	const long = snapshot(Array.from({ length: 25 }, (_, i) => net(1, "idle", `a-very-long-session-name-${i} `.repeat(3), "member", "x".repeat(40))));
	for (const width of [12, 20, 40, 76, 77, 200]) {
		const lines = render(long, 2, width, styled);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
		assert.ok(lines.every((line) => visibleWidth(line) <= 76));
	}
	const lines = render(long, 0, 200, plain);
	assert.equal(lines.length, 1 + 1 + 18 + 1 + 1, "top, section header, the shown rows, the count of the rest, bottom");
	assert.match(lines.at(-2)!, /… 7 more/);
});

/** Writes a pi session file's artifacts the way pi-herdr-agents lays them out, and returns the parent session file path. */
function launch(parent: string, children: { id: string; name: string; ageMs?: number; activity?: object }[]): string {
	const sessions = join(scratch, "sessions");
	const file = join(sessions, `2026-10-17T00-00-00-000Z_${parent}.jsonl`);
	const artifacts = join(sessions, "artifacts", parent);
	mkdirSync(join(artifacts, "subagent-activity"), { recursive: true });
	mkdirSync(join(artifacts, "subagent-scripts"), { recursive: true });
	for (const child of children) {
		const activity = join(artifacts, "subagent-activity", `${child.id}.json`);
		writeFileSync(activity, JSON.stringify(child.activity ?? { phase: "active" }));
		writeFileSync(join(artifacts, "subagent-scripts", `${child.name}-${child.id}.sh`), "#!/bin/bash\n");
		const when = new Date(Date.now() - (child.ageMs ?? 0));
		utimesSync(activity, when, when);
	}
	return file;
}

test("a subagent's file comes only from a pane running pi; a reused pane running another agent is not read", () => {
	const file = launch("parent-x", [{ id: "kid-1", name: "kid" }]);
	const parent = { pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA", agent: "pi", agent_session: { value: file } };
	const child = (agent: string) => ({ pane_id: "wA:p30", tab_id: "wA:t1", workspace_id: "wA", agent, agent_status: "working", agent_session: { value: join(scratch, "sessions", "2026_kid-1.jsonl") } });
	assert.equal(subagents(parent, [parent, child("pi")], Date.now())[0]!.file, join(scratch, "sessions", "2026_kid-1.jsonl"));
	assert.deepEqual([subagents(parent, [parent, child("claude")], Date.now())[0]!.file, subagents(parent, [parent, child("claude")], Date.now())[0]!.pane], [undefined, undefined]);
});

test("collect shows this tower's net in detail (joined sessions by tab, subagents under their launcher) and one line per other tower", async () => {
	const file = launch("parent-1", [
		{ id: "c-run", name: "builder", activity: { phase: "active", toolActive: true, toolName: "bash" } },
		{ id: "c-ask", name: "asker" },
		{ id: "c-gone", name: "reviewer", ageMs: 60_000 },
		{ id: "c-old", name: "ancient", ageMs: 3_600_000 },
	]);
	const herdr = world.herdr;
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	const towerB = world.tower("tower-wB", "wB:t7", "wB:p7");
	const main = world.agent({ id: "main-1", name: "Main One", pane: "wA:p1", tab: "wA:t1" });
	const member = world.agent({ id: "member-1", name: "Member", pane: "wA:p2", tab: "wA:t1" });
	const other = world.agent({ id: "main-2", name: "Docs", pane: "wA:p3", tab: "wA:t2" });
	const elsewhere = world.agent({ id: "main-b", name: "Beta Main", pane: "wB:p1", tab: "wB:t1" });
	const loner = world.agent({ id: "loner", name: "Late member", pane: "wA:p4", tab: "wA:t1" });
	await Promise.all([tower.start(), towerB.start(), main.start(), member.start(), other.start(), elsewhere.start(), loner.start()]);
	await Promise.all([main.promote(), member.promote(), other.promote(), elsewhere.promote()]);
	main.status = "tool:edit";
	other.status = "idle";
	herdr.pane("wA:p1").agent_session = { value: file };
	herdr.addPane("wA:p20", "wA:t1").agent_session = { value: join(scratch, "sessions", "2026-10-17T00-00-01-000Z_c-run-aaaa-bbbb.jsonl") };
	Object.assign(herdr.pane("wA:p20"), { agent_status: "working", label: "builder" });
	herdr.addPane("wA:p21", "wA:t1").agent_session = { value: join(scratch, "sessions", "2026-10-17T00-00-02-000Z_c-ask-cccc.jsonl") };
	Object.assign(herdr.pane("wA:p21"), { agent_status: "blocked", label: "asker" });
	herdr.workspace("wA").agent_status = "working";
	herdr.workspace("wB").agent_status = "idle";
	const snap = await collect({ run: herdr.runFor("wA:p7"), sessions: () => world.broker.sessionList(), workspaceId: "wA" });
	assert.deepEqual([snap.title, snap.mark, snap.head], ["Alpha", "waiting", true], "the title shows the most urgent state: a subagent waits on a question");
	assert.deepEqual(norm(snap.rows.map(({ workspace: _w, id: _i, file: _f, pane: _p, ...r }) => r)), norm([
		net(0, "unknown", "tab work"),
		net(1, "working", "Main One", "main", "tool:edit"),
		net(2, "waiting", "asker", "subagent", "waiting on a question"),
		net(2, "working", "builder", "subagent", "bash"),
		net(2, "done", "reviewer", "subagent", "finished"),
		net(1, "idle", "Member", "member"),
		net(1, "idle", "Late member", "member"),
		net(0, "unknown", "tab docs"),
		net(1, "idle", "Docs", "main"),
		row("towers", 0, "idle", "Beta", "tower"),
	]));
});

test("subagents are grouped under the session that launched them wherever they run, and they do not make a workspace's net", async () => {
	const file = launch("parent-2", [{ id: "far", name: "farchild" }, { id: "wt", name: "wtchild" }]);
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
	world.herdr.workspaces.push({ workspace_id: "wS", label: "child-worktree", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.workspaces.push({ workspace_id: "wT", label: "plain-sub", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wB:t5", "elsewhere", "wB:p5");
	world.herdr.addTab("wS:t1", "child", "wS:p1");
	const main = world.agent({ id: "main-1", name: "Main", pane: "wA:p1", tab: "wA:t1" });
	await main.start();
	await main.promote();
	world.herdr.pane("wA:p1").agent_session = { value: file };
	Object.assign(world.herdr.pane("wB:p5"), { agent_session: { value: join(scratch, "sessions", "2026-10-17T00-00-03-000Z_far-1111.jsonl") }, agent_status: "working", label: "farchild" });
	Object.assign(world.herdr.pane("wS:p1"), { agent_session: { value: join(scratch, "sessions", "2026-10-17T00-00-04-000Z_wt-2222.jsonl") }, agent_status: "working", label: "wtchild" });
	const { rows } = await collect({ run: world.herdr.runFor("wA:p1"), sessions: () => world.broker.sessionList(), workspaceId: "wA" });
	assert.deepEqual(rows.map((r) => [r.depth, r.text]), [[0, "tab work"], [1, "Main"], [2, "farchild"], [2, "wtchild"], [0, "plain-sub"]], "children sit under Main; the worktree child's workspace is not listed again; Beta, where a child runs, is not a tower");
});

test("a member that launched subagents keeps them when it is promoted: the dashboard and the GUI net count them under it as main, with no re-registration", async () => {
	const file = launch("parent-3", [{ id: "kid-1", name: "builder", activity: { phase: "active" } }]);
	const member = world.agent({ id: "parent-3", name: "Solo", pane: "wA:p1", tab: "wA:t1" });
	await member.start();
	world.herdr.pane("wA:p1").agent_session = { value: file };
	Object.assign(world.herdr.addPane("wA:p20", "wA:t1"), { agent_status: "working", label: "builder", agent_session: { value: join(scratch, "sessions", "2026-10-17T00-00-01-000Z_kid-1.jsonl") } });
	const read = async () => {
		const [src, sessions] = [world.herdr.runFor("wA:p1"), () => world.broker.sessionList()];
		const rows = (await collect({ run: src, sessions, workspaceId: "wA" })).rows.map((r) => [r.depth, r.text, r.kind]);
		const unit = (await collectNet({ run: src, sessions, sessionDir: join(scratch, "sessions") })).bases[0]!.tabs[0]!.units[0]!;
		return { rows, unit: [unit.name, unit.role, unit.subs.map((u) => [u.name, u.role, u.key])] };
	};
	const subs = [["builder", "subagent", "kid-1"]];
	assert.deepEqual(await read(), { rows: [[0, "tab work", undefined], [1, "Solo", "member"], [2, "builder", "subagent"]], unit: ["Solo", "member", subs] });
	await member.promote();
	assert.deepEqual(await read(), { rows: [[0, "tab work", undefined], [1, "Solo", "main"], [2, "builder", "subagent"]], unit: ["Solo", "main", subs] });
});

test("a blocked pane marks its session as waiting, and pi-herdr-agents workers and towers are not listed as members", async () => {
	const loner = world.agent({ id: "loner", pane: "wA:p4", tab: "wA:t1" });
	const worker = world.agent({ id: "worker", pane: "wA:p5", tab: "wA:t1", env: { PI_SUBAGENT_ID: "run" } });
	const main = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1" });
	await Promise.all([loner.start(), worker.start(), main.start()]);
	await main.promote();
	world.herdr.pane("wA:p1").agent_status = "blocked";
	const { rows } = await collect({ run: world.herdr.runFor("wA:p1"), sessions: () => world.broker.sessionList(), workspaceId: "wA" });
	assert.deepEqual(rows.filter((r) => r.depth === 1).map((r) => [r.text, r.mark]), [["main-1", "waiting"], ["loner", "idle"]], "the main first, then the member that joined at start");
});

test("sub workspaces hang under their parent as one line each, without their sessions, and do not take the head mark", async () => {
	world.herdr.workspaces.unshift({ workspace_id: "wS", label: "Alpha feature", tokens: {}, agent_status: "working", worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
	world.herdr.addTab("wS:t1", "feature", "wS:p1");
	const sub = world.agent({ id: "sub-1", name: "Feature work", pane: "wS:p1" });
	sub.status = "thinking";
	await sub.start();
	const snap = await collect({ run: world.herdr.runFor("wS:p1"), sessions: () => world.broker.sessionList(), workspaceId: "wA" });
	assert.deepEqual(norm([snap.head, snap.rows]), norm([true, [net(0, "working", "Alpha feature", "sub workspace")]]));
});

function fakeUi() {
	const tui: FakeTui = { renders: 0, requestRender: () => void tui.renders++ };
	const state: { factory?: unknown; component?: { render(w: number): string[]; dispose?(): void } } = {};
	const ui = {
		setWidget: (_key: string, factory?: (t: FakeTui, theme: { fg(tone: string, text: string): string; bold(text: string): string }) => { render(w: number): string[]; dispose?(): void }) => {
			state.component?.dispose?.();
			state.component = factory?.(tui, { fg: plain, bold: (text) => text });
			state.factory = factory;
		},
	};
	return { tui, state, ui };
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("the spinner timer runs only while a row is working, and stop() ends every timer and removes the widget", async () => {
	const { tui, state, ui } = fakeUi();
	let snap: Snapshot = snapshot([net(1, "working", "Main One", "main")]);
	let reads = 0;
	const dashboard = startDashboard({ ui: ui as never, collect: async () => (reads++, snap), frameMs: 5, pollMs: 40, minGapMs: 0 });
	const title = () => state.component?.render(80)[0] ?? "";
	await until(() => title().includes("⠋ tower · Alpha"), "first frame");
	const frames = new Set<string>();
	await until(() => (frames.add(title().slice(3, 4)), frames.size >= 3), "animation frames to change");
	// Nothing is working any more: after the next poll the spinner stops asking for renders.
	snap = { ...snapshot([net(1, "idle", "Main One", "main")]), mark: "idle" };
	await until(() => title().includes("○ tower · Alpha"), "idle title");
	await sleep(20);
	const before = tui.renders;
	await sleep(30);
	assert.ok(tui.renders - before <= 1, `rendered ${tui.renders - before} times while idle`);
	dashboard.stop();
	assert.equal(state.component, undefined, "the widget is removed");
	const stopped = reads;
	await sleep(100);
	assert.equal(reads, stopped, "the poll stopped");
});

test("poke re-reads early but not more often than the minimum gap, and a failing read shows an error row instead of throwing", async () => {
	const { state, ui } = fakeUi();
	let reads = 0, fail = false;
	const dashboard = startDashboard({ ui: ui as never, collect: async () => (reads++, fail ? Promise.reject(new Error("herdr is gone")) : snapshot([])), frameMs: 5, pollMs: 100_000, minGapMs: 50 });
	await until(() => reads === 1, "first read");
	dashboard.poke();
	dashboard.poke();
	await settle();
	assert.equal(reads, 1, "pokes inside the gap are ignored");
	await sleep(60);
	fail = true;
	dashboard.poke();
	await until(() => state.component!.render(80).some((line) => /✗ dashboard unavailable: herdr is gone/.test(line)), "error row");
	dashboard.stop();
});

const KEY = "straw-boss-dashboard";

test("a tower with a UI shows the dashboard once it holds the role, and shutdown removes it and stops its polling", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7", true);
	world.herdr.workspace("wA").agent_status = "working";
	await tower.start();
	const component = tower.components.get(KEY);
	assert.ok(component, "the widget is set");
	await until(() => component.render(80)[0]!.includes("tower · Alpha"), "the first reading");
	assert.match(component.render(80)[0]!, /^╭─ ⠋ tower · Alpha ─+ head tower ─╮$/);
	await tower.stop();
	assert.equal(tower.components.has(KEY), false);
	assert.equal(tower.widgets.get(KEY), undefined, "setWidget(key, undefined) removed it");
	const calls = world.herdr.calls.length;
	await sleep(50);
	assert.equal(world.herdr.calls.length, calls, "no polling after shutdown");
});

test("intercom presence and session events re-read at once instead of waiting for the 3 s poll", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7", true);
	const main = world.agent({ id: "main-1", name: "Main One", pane: "wA:p1", tab: "wA:t1" });
	await Promise.all([tower.start(), main.start()]);
	await main.promote();
	const component = tower.components.get(KEY)!;
	const tell = (type: string) => world.broker.sessions.get("tower-wA")!.regs.forEach((registration) => registration.onEvent({ type, session: {} }));
	const sees = (pattern: RegExp) => component.render(80).some((line) => pattern.test(line));
	await sleep(520);
	tell("session_joined");
	await until(() => sees(/Main One +main/), "the joined main agent", 1500);
	main.status = "thinking";
	await sleep(520);
	tell("presence_update");
	await until(() => sees(/Main One +main +thinking/), "the new status", 1500);
});

test("a yielding tower, a headless tower, and a main agent never show the dashboard", async () => {
	const holder = world.tower("holder", "wA:t5", "wA:p5", true);
	const yielding = world.tower("yielding", "wA:t9", "wA:p9", true);
	const headless = world.tower("headless", "wB:t5", "wB:p5");
	const main = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1", ui: true });
	await Promise.all([holder.start(), yielding.start(), headless.start(), main.start()]);
	await main.promote();
	await settle();
	assert.ok(holder.components.has(KEY));
	assert.equal(yielding.components.size, 0);
	assert.equal(headless.components.size, 0);
	assert.equal(main.components.size, 0);
});
