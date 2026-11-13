import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Pane } from "../src/herdr.ts";
import { agentOfSession, subagents } from "../src/netdata.ts";
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
