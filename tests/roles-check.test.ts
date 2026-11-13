import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { CHILD_ONLY, HOST_PARENT_ONLY, readRoles, rolesCheck, runRolesCheck } from "../src/rolescheck.ts";
import { PARENT_ONLY } from "../src/tools.ts";
import { trainCarTool } from "../src/traincar.ts";
import { until, World } from "./fakes.ts";

// `/boss roles-check` (docs/specs/2026-11-09-agent-kinds.md §9, "Acceptance for the tool sets"): each role's tools: names against the live session's tools, no probe process.

const parentOnly = { ...Object.fromEntries(PARENT_ONLY.map((n) => [n, "sb, outside a child"])), ...HOST_PARENT_ONLY };

test("rolesCheck passes names that are present or child-only, and fails a missing one and a parent-only one with the reason", () => {
	const ok = rolesCheck([{ name: "scout", tools: ["read", "caller_ping", "watch_read"] }, { name: "worker" }], ["read", "bash"], CHILD_ONLY, parentOnly);
	assert.equal(ok.ok, true, ok.lines.join("\n"));
	assert.ok(ok.lines.some((l) => /worker: every tool/.test(l)));
	assert.ok(ok.lines.some((l) => /caller_ping \(pi-herdr-agents/.test(l)));
	const bad = rolesCheck([{ name: "x", tools: ["read", "nope", "boss_status", "worktree_list"] }], ["read", "boss_status", "worktree_list"], CHILD_ONLY, parentOnly);
	assert.equal(bad.ok, false);
	assert.deepEqual(bad.failures, [
		{ role: "x", tool: "nope", reason: "no such tool in this session" },
		{ role: "x", tool: "boss_status", reason: "parent-only: sb, outside a child" },
		{ role: "x", tool: "worktree_list", reason: `parent-only: ${HOST_PARENT_ONLY.worktree_list}` },
	]);
});

test("runRolesCheck refuses a session started with --tools or --exclude-tools, and with no folder reads its own package's roles/", () => {
	const told: string[] = [];
	for (const argv of [["node", "pi", "--tools", "read"], ["node", "pi", "--exclude-tools", "bash"], ["node", "pi", "--tools=read"]]) {
		const r = runRolesCheck("", { argv, tools: () => { throw new Error("must not be read"); } });
		told.push(r.text);
		assert.equal(r.ok, false);
		assert.equal(r.text, "roles-check needs a session started without --tools or --exclude-tools");
	}
	const own = runRolesCheck("", { argv: ["node", "pi"], tools: () => ["read", "grep", "find", "ls", "bash", "write", "edit", "mcp", "subagent", "ask_user_question", "show_doc", "find_roots", "observe_ui", "act_ui", "inspect_ui", "search_ui", "expand_ui", "read_text", "wait_for", "launch_browser", "navigate_browser", "evaluate_browser"] });
	assert.equal(own.ok, true, own.text);
	assert.deepEqual(readRoles().map((r) => r.name).sort(), ["adversarial-reviewer", "planner", "reviewer", "scout", "visual-tester", "worker"]);
	const dir = mkdtempSync(join(tmpdir(), "roles-"));
	writeFileSync(join(dir, "solo.md"), "---\nname: solo\ndescription: d\ntools: read, boss_rename\n---\nbody\n");
	const other = runRolesCheck(dir, { argv: ["node", "pi"], tools: () => ["read", "boss_rename"] });
	assert.equal(other.ok, false);
	assert.match(other.text, /solo: boss_rename — parent-only/);
});

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

test("/boss roles-check runs in the session: it starts no process and answers with the report", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	const before = world.herdr.calls.length;
	await a.command("roles-check");
	await until(() => a.notices.some((n) => /roles-check/.test(n.text)), "the report");
	const note = a.notices.find((n) => /roles-check/.test(n.text))!;
	assert.match(note.text, /scout:/);
	assert.equal(world.herdr.calls.length, before, "nothing ran in Herdr: no pane, tab, or pi started");
});

test("sb's tools registered outside a child, less those in a child, equal PARENT_ONLY", async () => {
	const child = world.agent({ id: "c", pane: "wA:p9", tab: "wA:t1", env: { PI_SUBAGENT_ID: "run-1" } });
	await child.start();
	assert.deepEqual([...child.tools.keys()], [], "a child registers no sb tool");
	assert.ok(!child.tools.has("watch_read") && !child.tools.has("watch_report"), "the watch tools arrive with phase 3");
	const seen = new Set<string>();
	world.herdr.addTab("wA:t7", "🗼 tower", "wA:p7");
	const tower = world.agent({ id: "tower-1", pane: "wA:p7", tab: "wA:t7", env: { STRAW_BOSS_ROLE: "tower" } });
	await tower.start();
	const main = world.agent({ id: "main-1", pane: "wA:p1", tab: "wA:t1" });
	await main.start();
	await main.promote();
	for (const agent of [tower, main]) for (const name of agent.tools.keys()) seen.add(name);
	// The tower runs register theirs (runmode.ts, runhead.ts): a local run and a head run (an ally run registers a subset of a local run's, runmode.ts ALLY_REGISTERED).
	for (const kind of ["local", "head"] as const) {
		const run = world.agent({ id: `run-${kind}`, pane: "wA:p3", tab: "wA:t1", deps: { stateDir: world.stateDir, runSide: { ask: async (request: { cmd?: string }) => request.cmd === "claim" ? { ok: true, token: "T", kind, run: "R", workspace: "wA", identity: "sb-tower-wa", label: "Alpha", brief: "B" } : { ok: true, waits: [], auto: false }, pollMs: 20, claimWaitMs: 300 } } });
		run.flags.set("sb-run", "R");
		await run.start();
		await until(() => run.tools.has("tower_done"), `the ${kind} run's tools`);
		for (const name of run.tools.keys()) seen.add(name);
		await run.stop("quit");
	}
	// `train_car` is added at the join only where an sb server is reachable (traincar.ts, `enabled`), which a fake world has not: recorded through its own registrar.
	trainCarTool({ pi: { on: () => {}, registerTool: (tool: { name: string }) => seen.add(tool.name) }, s: { isTower: false }, cfg: { now: Date.now }, me: () => "main-1" } as never, () => undefined, { client: {}, enabled: () => true, keepRegistering: () => {} } as never, async () => {})();
	assert.deepEqual([...seen].sort(), [...PARENT_ONLY].sort());
});
