import assert from "node:assert/strict";
import { test } from "node:test";
import { changes } from "../gui/log.ts";
import type { Row } from "../src/dashboard.ts";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { buildNet, type Net } from "../src/net.ts";

const ws = (id: string, label: string, extra: Partial<Workspace> = {}): Workspace => ({ workspace_id: id, label, tokens: {}, ...extra });
const pane = (id: string, tab: string, tokens: Record<string, string> = {}, extra: Partial<Pane> = {}): Pane => ({ pane_id: id, tab_id: tab, tokens, ...extra });
const session = (id: string, name: string, at: { ws: string; tab: string; pane: string }, status = "idle"): Session => ({ id, name, status, herdrLocation: { status: "current", paneId: at.pane, workspace: { id: at.ws, label: at.ws }, tab: { id: at.tab, label: at.tab.split(":")[1]! } } });
const child = (text: string, mark: Row["mark"], extra: Partial<Row> = {}): Row => ({ group: "net", depth: 2, mark, text, kind: "subagent", ...extra });

const workspaces = [
	ws("wA", "Alpha", { tokens: { tower: "tower-a" }, worktree: { repo_key: "r1" } }),
	ws("wA2", "Alpha feature", { agent_status: "working", worktree: { repo_key: "r1", is_linked_worktree: true } }),
	ws("wB", "Beta", { tokens: { tower: "tower-b" } }),
	ws("wC", "Gamma"),
];
const panes = [
	pane("wA:p1", "wA:t1", { sb_role: "main" }, { agent_status: "working" }),
	pane("wA:p2", "wA:t1", { sb_role: "member" }),
	pane("wA:p3", "wA:t2", { sb_role: "main" }, { agent_status: "blocked" }),
	pane("wA:p4", "wA:t1"),
	pane("wA:p5", "wA:t3", { sb_role: "tower" }),
	pane("wB:p1", "wB:t1", { sb_role: "tower" }, { agent_status: "idle" }),
];
const sessions = [
	session("tower-a", "tower · Alpha", { ws: "wA", tab: "wA:t3", pane: "wA:p5" }),
	session("m1", "api-main", { ws: "wA", tab: "wA:t1", pane: "wA:p1" }, "tool:edit"),
	session("mem", "docs-member", { ws: "wA", tab: "wA:t1", pane: "wA:p2" }),
	session("m2", "ops-main", { ws: "wA", tab: "wA:t2", pane: "wA:p3" }),
	session("loner", "not joined", { ws: "wA", tab: "wA:t1", pane: "wA:p4" }),
	session("tower-b", "tower · Beta", { ws: "wB", tab: "wB:t1", pane: "wB:p1" }),
];

test("buildNet shows every workspace as a base with its tower, tabs, agents, subagents, and outposts, and leaves out sessions that did not join", () => {
	const net = buildNet({ sessions, panes, workspaces, children: (p) => (p?.pane_id === "wA:p1" ? [child("lint", "working", { note: "bash" }), child("review", "done", { note: "finished" })] : []) });
	assert.deepEqual(net.bases.map((b) => [b.label, b.head, b.tower?.name ?? null, b.tower?.mark ?? null]), [
		["Alpha", true, "tower · Alpha", "idle"],
		["Beta", false, "tower · Beta", "idle"],
	], "Gamma has no tower and nobody joined, so it is not part of the net");
	const alpha = net.bases[0]!;
	assert.deepEqual(alpha.tabs.map((t) => [t.label, t.units.map((u) => [u.name, u.role, u.mark, u.note ?? null])]), [
		["t1", [["api-main", "main", "working", "tool:edit"], ["docs-member", "member", "idle", null]]],
		["t2", [["ops-main", "main", "waiting", "waiting on a question"]]],
	]);
	assert.deepEqual(alpha.tabs[0]!.units[0]!.subs.map((s) => [s.id, s.name, s.role, s.mark, s.note]), [["m1/lint", "lint", "subagent", "working", "bash"], ["m1/review", "review", "subagent", "done", "finished"]]);
	assert.deepEqual(alpha.outposts, [{ id: "wA2", label: "Alpha feature", mark: "working" }], "the sub workspace hangs under its parent");
	assert.equal(alpha.mark, "waiting", "a base shows its most urgent state");
	assert.ok(!JSON.stringify(net).includes("not joined"), "the session that did not join is absent");
	assert.ok(!net.bases.some((b) => b.label === "Alpha feature"), "a sub workspace is never a base");
});

test("a sub workspace that already shows as a launched subagent is not an outpost as well", () => {
	const net = buildNet({ sessions, panes, workspaces, children: (p) => (p?.pane_id === "wA:p1" ? [child("fix", "working", { workspace: "wA2" })] : []) });
	assert.deepEqual(net.bases[0]!.outposts, []);
	assert.equal(net.bases[0]!.tabs[0]!.units[0]!.subs[0]!.name, "fix");
});

test("the snapshot is plain JSON that round-trips, and an empty Herdr is an empty net", () => {
	const net = buildNet({ sessions, panes, workspaces, children: () => [] });
	assert.equal(JSON.stringify(JSON.parse(JSON.stringify(net))), JSON.stringify(net));
	assert.deepEqual(buildNet({ sessions: [], panes: [], workspaces: [], children: () => [] }), { bases: [] });
});

test("a base with only a tower takes its workspace's own status, and one with only joined agents has no tower", () => {
	const alone = buildNet({ sessions: [session("t", "tower · Solo", { ws: "w1", tab: "w1:t1", pane: "w1:p1" })], panes: [pane("w1:p1", "w1:t1", { sb_role: "tower" })], workspaces: [ws("w1", "Solo", { agent_status: "done", tokens: { tower: "t" } })], children: () => [] });
	assert.deepEqual([alone.bases[0]!.mark, alone.bases[0]!.tower?.name, alone.bases[0]!.tabs], ["done", "tower · Solo", []]);
	const towerless = buildNet({ sessions: sessions.slice(1, 2), panes, workspaces: [workspaces[0]!], children: () => [] });
	assert.deepEqual([towerless.bases.length, towerless.bases[0]!.tower, towerless.bases[0]!.tabs.length], [1, null, 1]);
});

test("workspaces outside the net, and sub workspaces whose parent is outside it, are not shown", () => {
	const net = buildNet({ sessions: [], panes: [], workspaces, children: () => [] });
	assert.deepEqual(net, { bases: [] });
});

test("changes lists joins, leaves, and state changes, and nothing for the first snapshot", () => {
	const before = buildNet({ sessions, panes, workspaces, children: () => [child("lint", "working")] });
	assert.deepEqual(changes(undefined, before), []);
	const after: Net = structuredClone(before);
	const unit = after.bases[0]!.tabs[0]!.units[0]!;
	unit.mark = "waiting";
	unit.subs = [];
	after.bases[0]!.tabs[0]!.units.push({ id: "new", name: "fresh", role: "member", mark: "idle", subs: [] });
	assert.deepEqual(changes(before, after), [
		{ text: "api-main is waiting on a question", mark: "waiting" },
		{ text: "fresh joined", mark: "idle" },
		{ text: "lint left", mark: "idle" },
	]);
	assert.deepEqual(changes(after, after), []);
});
