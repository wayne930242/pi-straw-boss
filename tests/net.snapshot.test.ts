import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { changes } from "../gui/log.ts";
import type { Row } from "../src/dashboard.ts";
import type { Pane, Session, Workspace } from "../src/herdr.ts";
import { buildNet, type Net, netSource, type Ref } from "../src/net.ts";

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

test("a tower's subagents hang under the tower, count toward its base, and are neither outside the net nor an outpost", () => {
	const known = [...panes.map((p) => (p.pane_id === "wA:p5" ? { ...p, workspace_id: "wA", agent: "pi" } : p)), pane("wA:p9", "wA:t3", {}, { workspace_id: "wA", agent: "pi", agent_status: "blocked" })];
	const refs = new Map<string, Ref>();
	const net = buildNet({ sessions: sessions.filter((s) => s.id !== "m2"), panes: known, workspaces, children: (p) => (p?.pane_id === "wA:p5" ? [child("scout", "waiting", { id: "tc-1", pane: "wA:p9" }), child("fix", "working", { id: "tc-2", workspace: "wA2" })] : []) }, refs);
	const alpha = net.bases[0]!;
	assert.deepEqual(alpha.tower?.subs.map((s) => [s.key, s.name, s.role, s.mark, s.control]), [["tc-1", "scout", "subagent", "waiting", true], ["tc-2", "fix", "subagent", "working", false]]);
	assert.deepEqual(alpha.outside, [], "the tower's subagent pane belongs to the net");
	assert.deepEqual(alpha.outposts, [], "a sub workspace the tower launched is its subagent, not an outpost");
	assert.equal(alpha.mark, "waiting", "a tower's waiting subagent raises its base");
	assert.equal(refs.get("tc-1")?.role, "subagent");
	assert.deepEqual(net.bases[1]!.tower?.subs, []);
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
	after.bases[0]!.tabs[0]!.units.push({ id: "new", key: "new", control: false, name: "fresh", role: "member", mark: "idle", subs: [] });
	assert.deepEqual(changes(before, after), [
		{ text: "api-main is waiting on a question", mark: "waiting" },
		{ text: "fresh joined", mark: "idle" },
		{ text: "lint left", mark: "idle" },
	]);
	assert.deepEqual(changes(after, after), []);
});

test("units carry a route key and say whether a live pi pane backs them; the registry holds exactly the keys the snapshot shows", () => {
	const withFiles = panes.map((p) => (p.pane_id === "wA:p1" ? { ...p, agent: "pi", agent_session: { value: "/s/2026_m1.jsonl" } } : p.pane_id === "wA:p5" ? { ...p, agent: "pi", agent_session: { value: "/s/2026_tower-a.jsonl" } } : p));
	const refs = new Map<string, Ref>();
	const net = buildNet({ sessions, panes: withFiles, workspaces, sessionDir: "/s", children: (p) => (p?.pane_id === "wA:p1" ? [child("lint", "working", { id: "child-1", file: "/s/2026_child-1.jsonl", pane: "wA:p9" }), child("old", "done", { id: "child-2", file: "/s/2026_child-2.jsonl" })] : []) }, refs);
	const [main, member] = net.bases[0]!.tabs[0]!.units;
	assert.deepEqual([main!.key, main!.control, member!.key, member!.control], ["m1", true, "mem", false], "only a pane running pi can be typed into");
	assert.deepEqual(main!.subs.map((u) => [u.id, u.key, u.control]), [["child-1", "child-1", true], ["child-2", "child-2", false]], "a subagent is keyed by its child id, not by its name");
	assert.deepEqual([net.bases[0]!.tower?.key, net.bases[0]!.tower?.control], ["tower-a", true]);
	assert.deepEqual([...refs.keys()].sort(), ["child-1", "child-2", "m1", "m2", "mem", "tower-a", "tower-b"]);
	assert.deepEqual(refs.get("m1"), { key: "m1", base: "wA", name: "api-main", role: "main", file: "/s/2026_m1.jsonl", pane: "wA:p1" });
	assert.equal(refs.get("child-2")!.file, "/s/2026_child-2.jsonl", "a finished subagent keeps its file");
});

test("a base also lists its other pi panes as outside the net (D1), keyed by intercom session or by file; panes the net holds are not repeated", () => {
	const more = [...panes, pane("wA:p6", "wA:t1", {}, { workspace_id: "wA", agent: "pi", agent_status: "working", agent_session: { value: "/s/2026-10-17T00-00-00Z_sess-6.jsonl" }, label: "scratch" }),
		pane("wA:p7", "wA:t1", {}, { workspace_id: "wA", agent: "pi", agent_session: { value: "/s/2026_loner-file.jsonl" } }),
		pane("wA:p8", "wA:t1", {}, { workspace_id: "wA", agent: "pi" }),
		pane("wA:p1x", "wA:t1", { sb_role: "main" }, { workspace_id: "wA", agent: "pi", agent_session: { value: "/s/2026_other.jsonl" } }),
		pane("wA:p9", "wA:t1", {}, { workspace_id: "wA", agent: "pi", agent_session: { value: "/s/2026_child-1.jsonl" } })];
	const known = more.map((p) => (p.pane_id === "wA:p1" ? { ...p, workspace_id: "wA" } : p.pane_id === "wA:p5" ? { ...p, workspace_id: "wA", agent: "pi" } : p));
	const refs = new Map<string, Ref>();
	const net = buildNet({ sessions: [...sessions, session("loner2", "intercom-only", { ws: "wA", tab: "wA:t1", pane: "wA:p7" })], panes: known, workspaces, sessionDir: "/s", children: (p) => (p?.pane_id === "wA:p1" ? [child("lint", "working", { id: "child-1", pane: "wA:p9" })] : []) }, refs);
	const outside = net.bases[0]!.outside;
	assert.deepEqual(outside.map((u) => [u.key, u.name, u.role, u.mark, u.control]), [["sess-6", "scratch", "outside", "working", true], ["loner2", "intercom-only", "outside", "idle", true], ["other", "other", "outside", "unknown", true]]);
	assert.equal(refs.get("sess-6")!.file, "/s/2026-10-17T00-00-00Z_sess-6.jsonl");
	assert.ok(!outside.some((u) => ["m1", "tower-a", "child-1"].includes(u.key)), "the tower, joined sessions and subagent panes belong to the net");
	assert.deepEqual(net.bases[1]!.outside, []);
});

test("a file is recorded only for a pi pane, as a .jsonl under the sessions directory, and named for its intercom session", () => {
	const at = (id: string, value: string, agent = "pi") => (p: Pane) => (p.pane_id === id ? { ...p, agent, agent_session: { value } } : p);
	const read = (...edits: ((p: Pane) => Pane)[]) => {
		const refs = new Map<string, Ref>();
		buildNet({ sessions, panes: panes.map((p) => edits.reduce((q, e) => e(q), p)), workspaces, sessionDir: "/s", children: (p) => (p?.pane_id === "wA:p1" ? [child("c", "working", { id: "child-1", file: "/tmp/x_child-1.jsonl" })] : []) }, refs);
		return [refs.get("m1")?.file, refs.get("tower-a")?.file, refs.get("child-1")?.file];
	};
	assert.deepEqual(read(at("wA:p1", "/s/d/2026_m1.jsonl"), at("wA:p5", "/s/2026_tower-a.jsonl")), ["/s/d/2026_m1.jsonl", "/s/2026_tower-a.jsonl", undefined], "a subagent file outside the directory is dropped");
	assert.deepEqual(read(at("wA:p1", "/s/2026_next-session.jsonl")), [undefined, undefined, undefined], "during /new the pane names the next session's file: not paired with the old id");
	assert.deepEqual(read(at("wA:p1", "/s/2026_m1.jsonl", "claude")), [undefined, undefined, undefined], "a pane running another agent is not read");
	assert.deepEqual(read(at("wA:p1", "/etc/2026_m1.jsonl"), at("wA:p5", "/s/../etc/2026_tower-a.jsonl")), [undefined, undefined, undefined], "outside the directory, also through ..");
	assert.deepEqual(read(at("wA:p1", "/s/2026_m1.txt")), [undefined, undefined, undefined], "only .jsonl files");
});

test("the registry keeps a key that left the net for ten minutes, names the pane's new session as its successor, and then forgets it", async () => {
	let live: Session[] = [session("s1", "one", { ws: "wA", tab: "wA:t1", pane: "wA:p1" }), session("tower-a", "tower", { ws: "wA", tab: "wA:t3", pane: "wA:p5" })];
	const ps = panes.map((p) => (p.pane_id === "wA:p1" ? { ...p, agent: "pi", agent_session: { value: "/s/2026_s1.jsonl" } } : p));
	const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes: ps } : { workspaces } });
	const source = netSource({ run: herdr, sessions: async () => live, sessionDir: "/s" });
	await source.read();
	assert.deepEqual([source.lookup("s1")?.live, source.lookup("s1")?.file, source.lookup("nope")], [true, "/s/2026_s1.jsonl", undefined]);
	assert.deepEqual(source.workspace("wA").map((r) => r.key).sort(), ["s1", "tower-a"]);
	live = [session("s2", "one again", { ws: "wA", tab: "wA:t1", pane: "wA:p1" }), live[1]!];
	await source.read();
	assert.deepEqual([source.lookup("s1")?.live, source.lookup("s1")?.successor, source.lookup("s2")?.live], [false, "s2", true], "the old key stays readable and points at the pane's new session");
	const realNow = Date.now;
	Date.now = () => realNow() + 11 * 60_000;
	try {
		await source.read();
		assert.equal(source.lookup("s1"), undefined, "after ten minutes the key is no longer in the allow list");
	} finally {
		Date.now = realNow;
	}
});

test("a dismissed finished subagent is hidden on the next read until it leaves the net; a live one cannot be dismissed", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-net-dismiss-")));
	try {
		const dir = join(root, "sessions"), file = join(dir, "2026_s1.jsonl"), activity = join(dir, "artifacts", "s1", "subagent-activity");
		mkdirSync(activity, { recursive: true });
		writeFileSync(file, "");
		writeFileSync(join(activity, "kid-done.json"), JSON.stringify({ phase: "done" }));
		writeFileSync(join(activity, "kid-live.json"), JSON.stringify({ phase: "active" }));
		const ps = [...panes.map((p) => (p.pane_id === "wA:p1" ? { ...p, agent: "pi", agent_session: { value: file } } : p)), { pane_id: "wA:p9", workspace_id: "wA", tab_id: "wA:t1", agent: "pi", agent_status: "working", label: "kid-live" } as Pane];
		ps.find((p) => p.pane_id === "wA:p9")!.agent_session = { value: join(dir, "2026_kid-live.jsonl") };
		const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes: ps } : { workspaces } });
		const source = netSource({ run: herdr, sessions: async () => [session("s1", "one", { ws: "wA", tab: "wA:t1", pane: "wA:p1" })], sessionDir: dir });
		const kids = async () => (await source.read()).bases[0]!.tabs[0]!.units[0]!.subs.map((c) => [c.key, Boolean(c.ended)]);
		const before = await kids();
		assert.ok(before.some(([k, e]) => k === "kid-done" && e), JSON.stringify(before));
		assert.equal(source.dismiss("kid-live"), false, "a running subagent stays");
		assert.equal(source.dismiss("kid-done"), true);
		assert.ok(!(await kids()).some(([k]) => k === "kid-done"), "hidden from the next read");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a finished subagent says whether a pi still runs in its pane: ended with no pane has no control, ended with its pi alive keeps it", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-net-ended-")));
	try {
		const dir = join(root, "sessions"), file = join(dir, "2026_s1.jsonl"), activity = join(dir, "artifacts", "s1", "subagent-activity");
		mkdirSync(activity, { recursive: true });
		writeFileSync(file, "");
		for (const name of ["kid-gone", "kid-open"]) writeFileSync(join(activity, `${name}.json`), JSON.stringify({ phase: "done" }));
		const open = { pane_id: "wA:p9", workspace_id: "wA", tab_id: "wA:t1", agent: "pi", agent_status: "idle", label: "kid-open", agent_session: { value: join(dir, "2026_kid-open.jsonl") } } as Pane;
		const ps = [...panes.map((p) => (p.pane_id === "wA:p1" ? { ...p, agent: "pi", agent_session: { value: file } } : p)), open];
		const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes: ps } : { workspaces } });
		const source = netSource({ run: herdr, sessions: async () => [session("s1", "one", { ws: "wA", tab: "wA:t1", pane: "wA:p1" })], sessionDir: dir });
		const kids = (await source.read()).bases[0]!.tabs[0]!.units[0]!.subs.map((c) => [c.key, Boolean(c.ended), c.control]);
		assert.deepEqual(kids.toSorted(), [["kid-gone", true, false], ["kid-open", true, true]]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("dismiss all hides every finished subagent at once and only those; a running one stays, and a second call finds nothing", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-net-dismiss-all-")));
	try {
		const dir = join(root, "sessions"), file = join(dir, "2026_s1.jsonl"), activity = join(dir, "artifacts", "s1", "subagent-activity");
		mkdirSync(activity, { recursive: true });
		writeFileSync(file, "");
		for (const [name, phase] of [["kid-done", "done"], ["kid-done-too", "done"], ["kid-live", "active"]]) writeFileSync(join(activity, `${name}.json`), JSON.stringify({ phase }));
		const ps = [...panes.map((p) => (p.pane_id === "wA:p1" ? { ...p, agent: "pi", agent_session: { value: file } } : p)), { pane_id: "wA:p9", workspace_id: "wA", tab_id: "wA:t1", agent: "pi", agent_status: "working", label: "kid-live" } as Pane];
		ps.find((p) => p.pane_id === "wA:p9")!.agent_session = { value: join(dir, "2026_kid-live.jsonl") };
		const herdr = async (args: string[]) => JSON.stringify({ result: args[0] === "pane" ? { panes: ps } : { workspaces } });
		const source = netSource({ run: herdr, sessions: async () => [session("s1", "one", { ws: "wA", tab: "wA:t1", pane: "wA:p1" })], sessionDir: dir });
		const kids = async () => (await source.read()).bases[0]!.tabs[0]!.units[0]!.subs.map((c) => [c.key, Boolean(c.ended)]);
		const before = await kids();
		assert.deepEqual(before.filter(([, e]) => e).map(([k]) => k).sort(), ["kid-done", "kid-done-too"], JSON.stringify(before));
		assert.equal(source.dismissAll(), 2);
		const after = await kids();
		assert.deepEqual(after.map(([k]) => k), before.map(([k]) => k).filter((k) => k !== "kid-done" && k !== "kid-done-too"), "only the finished ones are hidden");
		assert.ok(after.some(([k]) => k === "kid-live"), "a running subagent stays");
		assert.equal(source.dismissAll(), 0, "nothing finished is left");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the sessions-directory check resolves symlinks: a linked sessions directory works, a link that leads out does not", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-net-links-")));
	try {
		const real = join(root, "real-sessions"), outside = join(root, "elsewhere");
		mkdirSync(join(real, "--work--"), { recursive: true });
		mkdirSync(outside);
		symlinkSync(real, join(root, "sessions"));
		writeFileSync(join(real, "--work--", "2026_m1.jsonl"), "");
		writeFileSync(join(outside, "2026_tower-a.jsonl"), "");
		symlinkSync(join(outside, "2026_tower-a.jsonl"), join(real, "--work--", "2026_tower-a.jsonl"));
		const at = (id: string, value: string) => (p: Pane) => (p.pane_id === id ? { ...p, agent: "pi", agent_session: { value } } : p);
		const refs = new Map<string, Ref>();
		const edits = [at("wA:p1", join(root, "sessions", "--work--", "2026_m1.jsonl")), at("wA:p5", join(real, "--work--", "2026_tower-a.jsonl")), at("wB:p1", join(root, "sessions", "--work--", "2026_tower-b.jsonl"))];
		buildNet({ sessions, panes: panes.map((p) => edits.reduce((q, e) => e(q), p)), workspaces, sessionDir: join(root, "sessions"), children: () => [] }, refs);
		assert.equal(refs.get("m1")?.file, join(real, "--work--", "2026_m1.jsonl"), "reached through the linked directory, kept as its real path");
		assert.equal(refs.get("tower-a")?.file, undefined, "a link inside the directory that points outside it is not readable");
		assert.equal(refs.get("tower-b")?.file, join(real, "--work--", "2026_tower-b.jsonl"), "a file not written yet resolves through its directory");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
