import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { settle, World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

const tokens = (pane: string) => world.herdr.pane(pane).tokens;
const writes = (pane: string) => world.herdr.calls.filter((args) => args[0] === "pane" && args[1] === "report-metadata" && args[2] === pane).length;
const KID = "2026-10-18T00-00-01-000Z_kid-a-1a2b3c4d-5e6f7a8b-9c0d.jsonl";

/**
 * A main agent in wA:p1 whose launch records name one subagent that runs in the pane of a sub workspace (wS:p1), the way pi-herdr-agents leaves them.
 * The pane starts as a shell with the subagent's session file (pi at its trust prompt); `kid` changes what Herdr shows of it.
 */
async function launcher(kid: Record<string, unknown> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "psb-detect-"));
	mkdirSync(join(dir, "sessions", "artifacts", "a", "subagent-activity"), { recursive: true });
	writeFileSync(join(dir, "sessions", "artifacts", "a", "subagent-activity", "kid-a.json"), JSON.stringify({ phase: "active" }));
	world.herdr.workspaces.unshift({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "child", "wS:p1");
	const a = world.agent({ id: "a", name: "Solo", pane: "wA:p1", tab: "wA:t1", deps: { detectMs: 5 } });
	world.herdr.pane("wA:p1").agent_session = { value: join(dir, "sessions", "2026-10-18T00-00-00-000Z_a.jsonl") };
	const session = join(dir, "sessions", KID);
	Object.assign(world.herdr.pane("wS:p1"), { label: "aaa", agent: undefined, agent_session: { value: session }, ...kid });
	await a.start();
	await a.promote();
	await world.quiet();
	return { dir, session };
}

test("a launched subagent whose pane turns pi after the launch publish is marked as soon as Herdr detects it, not at the 4 minute refresh", async () => {
	const { dir } = await launcher();
	try {
		assert.deepEqual(tokens("wS:p1"), {}, "a pane at pi's trust prompt carries nothing yet");
		assert.equal(world.herdr.listening("pane.updated"), 1, "the launcher waits for it");
		Object.assign(world.herdr.pane("wS:p1"), { agent: "pi", agent_status: "working" });
		world.herdr.emit("pane.agent_detected", "pane_agent_detected", { pane_id: "wS:p1", workspace_id: "wS", agent: "pi" });
		await world.quiet();
		assert.deepEqual(Object.keys(tokens("wS:p1")).sort(), ["sb_indent", "sb_mark", "sb_name", "sb_order"]);
		assert.equal(tokens("wS:p1").sb_name, "aaa");
		assert.equal(world.herdr.listening("pane.updated"), 0, "and stops once nothing waits");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a pane that gets its session file after pi is detected is marked on the update that shows it", async () => {
	const { dir, session } = await launcher({ agent: "pi", agent_status: "working", agent_session: undefined });
	try {
		assert.deepEqual(tokens("wS:p1"), {}, "without a session file the pane cannot be tied to the subagent");
		world.herdr.pane("wS:p1").agent_session = { value: session };
		world.herdr.emit("pane.updated", "pane_updated", { pane: { pane_id: "wS:p1", workspace_id: "wS" } });
		await world.quiet();
		assert.ok(tokens("wS:p1").sb_order);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("while a subagent waits, events that change nothing write nothing, and a pane already marked is not looked at again", async () => {
	const { dir } = await launcher();
	try {
		for (let i = 0; i < 5; i++) world.herdr.emit("pane.updated", "pane_updated", { pane: { pane_id: "wA:p1", workspace_id: "wA" } });
		for (let i = 0; i < 5; i++) world.herdr.emit("pane.agent_detected", "pane_agent_detected", { pane_id: "wA:p2", workspace_id: "wA", agent: "pi" });
		await world.quiet();
		assert.equal(writes("wS:p1"), 0, "nothing is written for the subagent");
		Object.assign(world.herdr.pane("wS:p1"), { agent: "pi", agent_status: "working" });
		world.herdr.emit("pane.agent_detected", "pane_agent_detected", { pane_id: "wS:p1", agent: "pi" });
		await world.quiet();
		const marked = writes("wS:p1");
		assert.equal(marked, 1);
		world.herdr.emit("pane.agent_detected", "pane_agent_detected", { pane_id: "wS:p1", agent: "pi" });
		world.herdr.emit("pane.updated", "pane_updated", { pane: { pane_id: "wS:p1" } });
		await world.quiet();
		assert.equal(writes("wS:p1"), marked, "no listener is left for it");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a session that launched no subagent holds no event subscription for them, and shutdown drops the one it has", async () => {
	const a = world.agent({ id: "a", name: "Solo", pane: "wA:p1", tab: "wA:t1", deps: { detectMs: 5 } });
	await a.start();
	await a.promote();
	await world.quiet();
	assert.equal(world.herdr.listening("pane.updated"), 0);
	await a.stop();
	await settle();
	const { dir } = await launcher();
	try {
		assert.equal(world.herdr.listening("pane.updated"), 1);
		await world.agents[world.agents.length - 1]!.stop();
		assert.equal(world.herdr.listening("pane.updated"), 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
