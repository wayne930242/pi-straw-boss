import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { writeEntry } from "../src/board.ts";
import { readBoard } from "../src/boardread.ts";
import type { Pane, Session } from "../src/herdr.ts";
import { agentOfSession, scriptReads, subagents, subagentsOfAll } from "../src/netdata.ts";
import { World } from "./fakes.ts";

// docs/specs/2026-11-09-agent-kinds.md §8, Phase 2 "The role read": a child records its role in its session file at its first turn, and the net links a resumed child (new id, a
// `-resume-` script with no role) by the script that carries its id, then its session file, then the pane that runs that file.

const scratch = mkdtempSync(join(tmpdir(), "psb-kinds-net-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const sessions = join(scratch, "sessions");
const pane = (id: string, extra: Partial<Pane> = {}): Pane => ({ pane_id: id, tab_id: "wA:t1", workspace_id: "wA", agent: "pi", ...extra });
const kidFile = (id: string) => join(sessions, `2026-11-13T00-00-01-000Z_${id}-1a2b3c4d-5e6f7a8b-9c0d.jsonl`);
const header = (id: string) => JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-11-13T00:00:01.000Z", cwd: "/x" });
const entry = (data: object) => JSON.stringify({ type: "custom", customType: "straw-boss", data, id: Math.random().toString(16).slice(2, 10), parentId: null, timestamp: "2026-11-13T00:00:02.000Z" });
const message = (text: string) => JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-11-13T00:00:03.000Z", message: { role: "user", content: text } });
/** A launch script the way pi-herdr-agents writes one: the first launch carries the role, a resume does not. */
const script = (o: { id: string; session: string; agent?: string; name: string }) => `#!/bin/bash\ncd '/x' && PI_SUBAGENT_ID='${o.id}' PI_SUBAGENT_NAME='${o.name}' ${o.agent ? `PI_SUBAGENT_AGENT='${o.agent}' ` : ""}PI_SUBAGENT_SESSION='${o.session}' PI_SUBAGENT_ACTIVITY_FILE='/x/${o.id}.json' pi\n`;
/** Lays out a parent's artifacts: each child's activity file and its launch script under `scriptName`. */
function artifacts(parent: string, kids: { id: string; scriptName: string; session: string; agent?: string; name: string; phase?: string }[]) {
	const art = join(sessions, "artifacts", parent);
	mkdirSync(join(art, "subagent-activity"), { recursive: true });
	mkdirSync(join(art, "subagent-scripts"), { recursive: true });
	for (const k of kids) {
		writeFileSync(join(art, "subagent-activity", `${k.id}.json`), JSON.stringify({ phase: k.phase ?? "active" }));
		writeFileSync(join(art, "subagent-scripts", k.scriptName), script(k));
	}
	return pane(`wA:p-${parent}`, { agent_session: { value: join(sessions, `2026-11-13T00-00-00-000Z_${parent}.jsonl`) } });
}

test("a child with PI_SUBAGENT_AGENT=scout writes { agent: \"scout\" } at its first turn_start, once, and never over an entry it already has", async () => {
	const world = new World();
	try {
		world.herdr.addPane("wA:p9", "wA:t1");
		const child = world.agent({ id: "kid-scout", pane: "wA:p9", env: { PI_SUBAGENT_ID: "kid-scout", PI_SUBAGENT_AGENT: "scout" } });
		assert.deepEqual(child.entries, [], "nothing before the first turn: pi has no session file yet");
		await child.fire("turn_start");
		await child.fire("turn_start");
		assert.deepEqual(child.entries, [{ customType: "straw-boss", data: { agent: "scout" } }]);
		// A resume keeps the file and its entry; a resume script carries no role, and a second child process of the same file writes nothing new.
		const resumed = world.agent({ id: "kid-scout-r", pane: "wA:p9", env: { PI_SUBAGENT_ID: "kid-scout-r", PI_SUBAGENT_AGENT: "worker" }, entries: [{ customType: "straw-boss", data: { agent: "scout" } }] });
		await resumed.fire("turn_start");
		assert.equal(resumed.entries.length, 1, "the first { agent } entry is kept; none is added beside it");
		const bare = world.agent({ id: "kid-bare", pane: "wA:p9", env: { PI_SUBAGENT_ID: "kid-bare" } });
		await bare.fire("turn_start");
		assert.deepEqual(bare.entries, [], "a bare spawn or a handoff has no role to write");
	} finally {
		await world.stopAll();
	}
});

test("the net reads the role from the first { agent } entry of the session file, and a later one does not change it", () => {
	const file = kidFile("k1");
	mkdirSync(sessions, { recursive: true });
	writeFileSync(file, [header("k1"), entry({ agent: "scout" }), message("go"), entry({ agent: "worker" })].join("\n") + "\n");
	assert.equal(agentOfSession(file), "scout");
	const parent = artifacts("pa", [{ id: "k1", scriptName: "look-k1.sh", session: file, name: "look" }]);
	const [row] = subagents(parent, [parent, pane("wA:p1", { agent_status: "working", label: "look", agent_session: { value: file } })], Date.now());
	assert.equal(row!.duty, "scout", "the entry labels it; the launch script named no role");
	assert.equal(agentOfSession(join(sessions, "nope.jsonl")), undefined);
});

test("only the first 64 KB are read: an entry after them is not seen", () => {
	const file = kidFile("k64");
	writeFileSync(file, [header("k64"), message("x".repeat(70_000)), entry({ agent: "reviewer" })].join("\n") + "\n");
	assert.equal(agentOfSession(file), undefined);
});

test("before its first turn_start the launch script that names the session stands in for the entry", () => {
	const file = kidFile("k2"); // pi has not written it yet
	const parent = artifacts("pb", [{ id: "k2", scriptName: "plan-k2.sh", session: file, agent: "planner", name: "plan" }]);
	const [row] = subagents(parent, [parent, pane("wA:p2", { agent_status: "working", label: "plan", agent_session: { value: file } })], Date.now());
	assert.equal(row!.duty, "planner");
});

test("a resumed child (new id, a -resume- script with no role, the same session file) is linked by the script that carries its id: its file, its pane, its live mark, its name, its label", () => {
	const file = kidFile("orig1");
	writeFileSync(file, [header("orig1"), entry({ agent: "reviewer" }), message("review")].join("\n") + "\n");
	const parent = artifacts("pc", [
		{ id: "orig1", scriptName: "rev-orig1.sh", session: file, agent: "reviewer", name: "rev", phase: "done" },
		{ id: "fresh9", scriptName: "rev-resume-1731456000000.sh", session: file, name: "rev" },
	]);
	const live = pane("wA:p3", { agent_status: "working", agent_session: { value: file } }); // Herdr gives the resumed pane no label
	const rows = subagents(parent, [parent, live], Date.now());
	const row = rows.find((r) => r.id === "fresh9")!;
	assert.equal(row.file, file, "the row's file is the session file the script names");
	assert.equal(row.pane, "wA:p3", "its pane is the one whose agent_session is that file");
	assert.equal(row.mark, "working", "its mark is the pane's, not done");
	assert.equal(row.text, "rev", "its name is the script's, not the hex id");
	assert.equal(row.duty, "reviewer");
	assert.equal(rows.filter((r) => r.file === file).length, 1, "the earlier launch of the same session file is not shown beside it");
});

test("a child resumed by another parent keeps its label from its entry", () => {
	const file = kidFile("orig2");
	writeFileSync(file, [header("orig2"), entry({ agent: "worker" }), message("work")].join("\n") + "\n");
	const other = artifacts("pd", [{ id: "fresh2", scriptName: "fix-resume-1731456000001.sh", session: file, name: "fix" }]);
	const [row] = subagents(other, [other, pane("wA:p4", { agent_status: "working", agent_session: { value: file } })], Date.now());
	assert.deepEqual([row!.duty, row!.pane, row!.mark, row!.text], ["worker", "wA:p4", "working", "fix"]);
});

test("an unknown role name, a handoff, and a bare spawn get no duty", () => {
	const named = kidFile("u1"), handoff = kidFile("u2"), bare = kidFile("u3");
	writeFileSync(named, [header("u1"), entry({ agent: "constructor" }), message("x")].join("\n") + "\n");
	writeFileSync(handoff, [header("u2"), message("x")].join("\n") + "\n");
	const parent = artifacts("pe", [
		{ id: "u1", scriptName: "a-u1.sh", session: named, agent: "nope", name: "a" },
		{ id: "u2", scriptName: "b-u2.sh", session: handoff, name: "b" },
		{ id: "u3", scriptName: "c-u3.sh", session: bare, name: "c" },
	]);
	const rows = subagents(parent, [parent], Date.now());
	assert.deepEqual(Object.fromEntries(rows.map((r) => [r.text, r.duty])), { a: undefined, b: undefined, c: undefined });
});

// Review R0790-F001: a parent with hundreds of launches read every script on every net read (27 ms to 4.8 s for 983 scripts and 60 resumes).
test("a parent's old launches cost no script read: only the resumes are read, once, and another parent's many launches do not evict them", () => {
	const old = Date.now() / 1000 - 3600;
	const many = (parent: string, n: number, resumes: number) => {
		const kids = Array.from({ length: n }, (_, i) => {
			const id = `${parent}k${i}`, resumed = i < resumes;
			return { id, scriptName: resumed ? `w${i}-resume-17${i}.sh` : `w${i}-${id}.sh`, session: kidFile(id), ...(resumed ? {} : { agent: "worker" }), name: `w${i}`, phase: "done" };
		});
		const p = artifacts(parent, kids);
		for (const k of kids) utimesSync(join(sessions, "artifacts", parent, "subagent-activity", `${k.id}.json`), old, old);
		return p;
	};
	const a = many("pbig", 600, 60), b = many("pother", 600, 0), panes = [a, b];
	// Past the racy window, so the listings are kept from one call to the next.
	const until = Date.now() + 2100;
	while (Date.now() < until) { /* wait */ }
	scriptReads.count = 0;
	assert.deepEqual(subagents(a, panes, Date.now()), [], "no child of it is live or recent");
	assert.ok(scriptReads.count <= 60, `the first read reads only the 60 resumes, not ${scriptReads.count}`);
	scriptReads.count = 0;
	subagents(b, panes, Date.now());
	subagents(a, panes, Date.now());
	assert.equal(scriptReads.count, 0, "nothing is read again, and the other parent's 600 launches evicted nothing");
});

// Review R0790-F002: a first launch and its resume with the same activity time showed the child twice.
test("a first launch and its resume of one session file, with the same activity time, show as one row: the resume", () => {
	const file = kidFile("ktie");
	const parent = artifacts("ptie", [
		{ id: "ktie", scriptName: "fix-ktie.sh", session: file, agent: "worker", name: "fix" },
		{ id: "ktie-r", scriptName: "fix-resume-1700.sh", session: file, name: "fix" },
	]);
	const at = Date.now() / 1000 - 60;
	for (const id of ["ktie", "ktie-r"]) utimesSync(join(sessions, "artifacts", "ptie", "subagent-activity", `${id}.json`), at, at);
	const rows = subagents(parent, [parent, pane("wA:pt", { agent_status: "working", agent_session: { value: file } })], Date.now());
	assert.equal(rows.length, 1, JSON.stringify(rows));
	assert.equal(rows[0]!.id, "ktie-r");
	assert.equal(rows[0]!.duty, "worker", "the first launch's script names the role");
});

// Review R0790-D001: a resume script listed while still being written names no id yet; the index of resumes must not keep that miss once the script is whole.
test("a resume script read before it names its id is read again once it does: the resumed child gets its file, pane and name", () => {
	const file = kidFile("dorig");
	const parent = artifacts("pdrace", [
		{ id: "dorig", scriptName: "rev-dorig.sh", session: file, agent: "reviewer", name: "rev", phase: "done" },
		{ id: "dfresh", scriptName: "rev-resume-1731456000009.sh", session: file, name: "rev" },
	]);
	const path = join(sessions, "artifacts", "pdrace", "subagent-scripts", "rev-resume-1731456000009.sh"), whole = readFileSync(path, "utf8");
	writeFileSync(path, "#!/bin/bash\ncd '/x' && ");
	const t1 = Date.now() / 1000 - 30;
	utimesSync(path, t1, t1);
	const live = pane("wD:p3", { agent_status: "working", agent_session: { value: file } });
	assert.equal(subagents(parent, [parent, live], Date.now()).find((r) => r.id === "dfresh")?.text, "dfresh".slice(0, 8), "while the script is partial the child has no name from it");
	writeFileSync(path, whole);
	utimesSync(path, t1 + 10, t1 + 10);
	const row = subagents(parent, [parent, live], Date.now()).find((r) => r.id === "dfresh")!;
	assert.equal(row.text, "rev", "its name is the script's once the script is whole");
	assert.equal(row.pane, "wD:p3");
});

// Shared contract 8 (docs/specs/2026-11-09-agent-kinds.md): `board_read` rows show each main's kind, read from the pane's `sb_duty` as tower_list and boss_status read it.
test("board_read rows carry each main's kind: coordinator, integrator, standing, and null for a main with none, a train, and an ended entry", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-kinds-board-")), NOW = 1_800_000_000_000;
	try {
		const live = (id: string, tab: string, tokens: Record<string, string>) => ({
			s: { id, name: id, status: "idle", herdrLocation: { status: "current", paneId: `p-${id}`, workspace: { id: "wA", label: "Alpha" }, tab: { id: tab, label: tab } } } as Session,
			pane: { pane_id: `p-${id}`, tab_id: tab, workspace_id: "wA", cwd: dir, tokens } as Pane,
		});
		const members = [live("coord", "t1", { sb_role: "main", sb_duty: "coordinator" }), live("integ", "t2", { sb_role: "main", sb_duty: "integrator" }), live("watch", "t3", { sb_role: "main", sb_duty: "standing" }), live("old", "t4", { sb_role: "main" }), live("odd", "t5", { sb_role: "main", sb_duty: "wizard" }), live("tr", "t6", { sb_role: "train", sb_duty: "integrator" }), live("kid", "t7", { sb_role: "member", sb_duty: "standing" })];
		writeEntry(dir, "gone", { now: "left half done", items: [] }, NOW - 5 * 60_000);
		const net = { sessions: members.map((m) => m.s), ps: members.map((m) => m.pane) };
		const out = await readBoard({ dir, now: NOW, net, link: { boards: async () => [], remoteScope: () => undefined }, scope: "local" }) as { local: { main: string; kind?: unknown; role?: string; state: string }[] };
		const rows = Object.fromEntries(out.local.map((r) => [r.main || r.state, r.kind]));
		assert.deepEqual(rows, { coord: "coordinator", integ: "integrator", watch: "standing", old: null, odd: null, tr: null, ended: null }, "a member is no row; a value the net does not know is null, as tower_list reads it");
		assert.ok(out.local.every((r) => "kind" in r), "the key is on every row, null when unknown");
		assert.equal(out.local.find((r) => r.main === "tr")!.role, "train", "a train keeps its role and has no kind");
		// A remote turn gets the same word tower_list gives it, on the rows it may see.
		const remote = await readBoard({ dir, now: NOW, net, link: { boards: async () => [], remoteScope: () => ({ teams: ["t"], project: dir }) }, scope: "local" }) as { local: { main: string; kind?: unknown }[] };
		assert.deepEqual(Object.fromEntries(remote.local.map((r) => [r.main, r.kind])), { coord: "coordinator", integ: "integrator", watch: "standing", old: null, odd: null, tr: null });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// A session file resumed by another parent (agent kinds phase 2 leftover): the resume lives in the other parent's artifacts, so the first launch stays in the original parent's, recorded done, beside a pane that runs on.
/** A child launched by `first` and resumed by `second`: one session file, two launches in two parents' artifacts. `at`: seconds ago each launch last wrote its activity. */
function resumedAcross(tag: string, at: { first: number; second: number }) {
	const file = kidFile(`${tag}o`), now = Date.now() / 1000;
	writeFileSync(file, [header(`${tag}o`), entry({ agent: "worker" }), message("work")].join("\n") + "\n");
	const first = artifacts(`${tag}a`, [{ id: `${tag}o`, scriptName: `fix-${tag}o.sh`, session: file, agent: "worker", name: "fix", phase: "done" }]);
	const second = artifacts(`${tag}b`, [{ id: `${tag}r`, scriptName: "fix-resume-1731456000100.sh", session: file, name: "fix" }]);
	for (const [parent, id, ago] of [[`${tag}a`, `${tag}o`, at.first], [`${tag}b`, `${tag}r`, at.second]] as const) utimesSync(join(sessions, "artifacts", parent, "subagent-activity", `${id}.json`), now - ago, now - ago);
	const live = pane(`wA:p-${tag}`, { agent_status: "working", agent_session: { value: file } });
	return { file, first, second, all: [first, second, live] };
}
const ofFile = (rows: ReturnType<typeof subagents>, file: string) => rows.filter((r) => r.file === file);

test("a session file resumed by another parent shows once across parents: the launch with the newest activity wins, and the old parent no longer shows it as done", () => {
	const { file, first, second, all } = resumedAcross("xp1", { first: 300, second: 5 });
	const now = Date.now();
	// Alone, each parent still sees its own launch: the original shows it ended (recorded done beside a pane that runs on), the resumer shows it working.
	assert.deepEqual(ofFile(subagents(first, all, now), file).map((r) => [r.id, r.mark]), [["xp1o", "done"]], "the per-parent reading is unchanged");
	assert.deepEqual(ofFile(subagents(second, all, now), file).map((r) => [r.id, r.mark]), [["xp1r", "working"]]);
	const kids = subagentsOfAll(all, now);
	assert.deepEqual(ofFile(kids(first), file), [], "the original parent shows no stale `done` beside the resumer's running row");
	assert.deepEqual(ofFile(kids(second), file).map((r) => [r.id, r.mark, r.text, r.duty]), [["xp1r", "working", "fix", "worker"]]);
});

test("across parents the newer activity wins whichever parent it is, and on a tie the resume", () => {
	const older = resumedAcross("xp2", { first: 5, second: 300 }), now = Date.now();
	const kids = subagentsOfAll(older.all, now);
	assert.deepEqual(ofFile(kids(older.first), older.file).map((r) => r.id), ["xp2o"], "the original's launch is the newest: the resumer's older launch is the one hidden");
	assert.deepEqual(ofFile(kids(older.second), older.file), []);
	const tie = resumedAcross("xp3", { first: 60, second: 60 }), kidsTie = subagentsOfAll(tie.all, now);
	assert.deepEqual([ofFile(kidsTie(tie.first), tie.file).length, ofFile(kidsTie(tie.second), tie.file).map((r) => r.id)], [0, ["xp3r"]], "a tie goes to the resume");
});

test("two panes of one parent's session file show its children twice, as before: only different launches of one session file compete", () => {
	const file = kidFile("xp4o");
	const parent = artifacts("xp4a", [{ id: "xp4o", scriptName: "fix-xp4o.sh", session: file, agent: "worker", name: "fix" }]);
	const twin = pane("wA:p-xp4twin", { agent_session: parent.agent_session });
	const live = pane("wA:p-xp4", { agent_status: "working", agent_session: { value: file } });
	const kids = subagentsOfAll([parent, twin, live], Date.now());
	assert.deepEqual([kids(parent).length, kids(twin).length], [1, 1]);
});

test("the across-parents join drops a loser before the limit, and a parent's own rows are as `subagents` gives them when no file is shared", () => {
	const file = kidFile("xp5o");
	const first = artifacts("xp5a", [{ id: "xp5o", scriptName: "fix-xp5o.sh", session: file, agent: "worker", name: "fix", phase: "active" }, { id: "xp5x", scriptName: "other-xp5x.sh", session: kidFile("xp5x"), agent: "scout", name: "other" }]);
	const second = artifacts("xp5b", [{ id: "xp5r", scriptName: "fix-resume-1731456000200.sh", session: file, name: "fix" }]);
	const now = Date.now() / 1000;
	utimesSync(join(sessions, "artifacts", "xp5a", "subagent-activity", "xp5o.json"), now - 120, now - 120);
	const all = [first, second, pane("wA:p-xp5", { agent_status: "working", agent_session: { value: file } }), pane("wA:p-xp5x", { agent_status: "working", label: "other", agent_session: { value: kidFile("xp5x") } })];
	assert.deepEqual(subagentsOfAll(all, Date.now(), 1)(first).map((r) => r.text), ["other"], "the loser does not take the one slot of its parent's limit");
	assert.deepEqual(subagentsOfAll(all, Date.now())(first).map((r) => r.text), subagents(first, all, Date.now()).filter((r) => r.file !== file).map((r) => r.text));
});

test("a child's full launch name (PI_SUBAGENT_NAME, spaces, capitals, and a quote) is the row's alias when the row shows the script's file name; none when they agree", () => {
	const file = kidFile("k-alias");
	const parent = artifacts("palias", [{ id: "k-alias", scriptName: "api-worker-k-alias.sh", session: file, name: "API worker'\\''s run" }, { id: "k-same", scriptName: "look-k-same.sh", session: kidFile("k-same"), name: "look" }]);
	const rows = subagents(parent, [parent, pane("wA:pa", { agent_status: "working", agent_session: { value: file } }), pane("wA:pb", { agent_status: "working", agent_session: { value: kidFile("k-same") } })], Date.now());
	const by = new Map(rows.map((r) => [r.id, r]));
	assert.deepEqual([by.get("k-alias")!.text, by.get("k-alias")!.alias], ["api-worker", "API worker's run"]);
	assert.equal(by.get("k-same")!.alias, undefined);
});
