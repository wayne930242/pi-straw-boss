import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { type Agent, settle, World } from "./fakes.ts";
import { ServerWorld } from "./server-world.ts";

// docs/specs/2026-11-23-lite-main.md: what Straw Boss gives a main is lighter. The plan's graph steers nothing and gates nothing (§1), the role section is the same bytes for the whole session,
// boss_duty included (§2), a main runs at most 4 workers at once (§3), and train_car and link_request are registered only where they can be used (§4).

let world: World | undefined, sw: ServerWorld | undefined;
const dirs: string[] = [];
afterEach(async () => {
	await world?.stopAll();
	await sw?.close();
	[world, sw] = [undefined, undefined];
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	delete (globalThis as Record<symbol, unknown>)[REGISTRY];
});
const REGISTRY = Symbol.for("pi-subagents/runtime");
const snap = (...tasks: { id: number; status?: string; graph?: string }[]) => ({ customType: "rpiv-todo-state", data: { nextId: tasks.length + 1, tasks: tasks.map((t) => ({ id: t.id, subject: `t${t.id}`, status: t.status ?? "pending", metadata: t.graph ? { graph: t.graph } : {} })) } });
const main = async (env: Record<string, string> = {}): Promise<Agent> => {
	world = new World();
	const a = world.agent({ id: "m-docs", name: "Docs", pane: "wA:p1", tab: "wA:t1", env });
	await a.start();
	await a.promote();
	return a;
};
const section = async (a: Agent) => (await a.run())["straw-boss"] ?? "";
const steers = (a: Agent) => a.sent.filter((m) => m.customType === "straw-boss").map((m) => m.content);
const todo = async (a: Agent, ...tasks: Parameters<typeof snap>) => {
	a.entries.splice(0, a.entries.length, ...a.entries.filter((e) => e.customType !== "rpiv-todo-state"), snap(...tasks));
	await a.toolResult("todo");
	await a.deliver();
};
const dispatch = (a: Agent, input: Record<string, unknown>, toolCallId = "c1") => a.fireResult("tool_call", { toolName: "subagent", toolCallId, input }) as Promise<{ block?: boolean; reason?: string } | undefined>;

test("a todo call that sets, changes, or clears a plan's graph posts no steer, and the section stays the same bytes", async () => {
	const a = await main();
	const first = await section(a);
	for (const tasks of [[{ id: 1, graph: "fan-out" }], [{ id: 1, graph: "orchestrator-worker" }], [{ id: 1, graph: "single-loop" }], [{ id: 1, graph: "single-loop", status: "completed" }], []] as Parameters<typeof snap>[]) {
		await todo(a, ...tasks);
		assert.equal(await section(a), first);
	}
	await settle();
	assert.deepEqual(steers(a), [], "no graph steer");
	assert.doesNotMatch(first, /## Graph:/);
});

test("the section carries the dispatch rules from the first run, with no graph and no plan-first wording", async () => {
	for (const env of [{}, { STRAW_BOSS_INTEGRATION: "off" }] as Record<string, string>[]) {
		const t = await section(await main(env));
		for (const term of ["owning app", "worktree", "`blockedBy`", "todo", "4 workers"]) assert.ok(t.includes(term), `${JSON.stringify(env)}: names ${term}`);
		assert.doesNotMatch(t, /plan first|metadata\.graph|## Graph:/);
		await world!.stopAll();
	}
});

test("a coordinator dispatches a worker with no plan and no todo: no plan-first block", async () => {
	const a = await main();
	await section(a);
	assert.equal(await dispatch(a, { agent: "worker", task: "x" }), undefined);
	assert.equal(await dispatch(a, { task: "x" }), undefined, "a bare spawn");
});

test("boss_duty does not rewrite the section: the new kind arrives once, as a steer, and the section keeps its bytes", async () => {
	const a = await main();
	const first = await section(a);
	await a.tool("boss_duty", { duty: "standing", reason: "minds the v1 redis" });
	await settle();
	await a.deliver();
	assert.equal(steers(a).length, 1);
	assert.match(steers(a)[0]!, /Your kind is now standing[\s\S]*## Kind: standing/);
	assert.equal(await section(a), first, "same bytes after boss_duty");
	await todo(a, { id: 1, graph: "fan-out" });
	assert.equal(await section(a), first);
	assert.equal(steers(a).length, 1, "nothing more");
});

test("a main runs at most 4 workers at once: a fifth is refused, other roles pass, and the calls of one message count before the registry holds them", async () => {
	const a = await main();
	await section(a);
	const running = new Map<string, { id: string; agent?: string }>();
	(globalThis as Record<symbol, unknown>)[REGISTRY] = { runningSubagents: running };
	for (let i = 0; i < 3; i++) running.set(`w${i}`, { id: `w${i}`, agent: "worker" });
	running.set("s0", { id: "s0", agent: "scout" });
	assert.equal(await dispatch(a, { agent: "worker" }, "c4"), undefined, "the fourth");
	assert.match((await dispatch(a, { agent: "worker" }, "c5"))?.reason ?? "", /^sb: 4 workers run for this main already/, "a fifth in the same message");
	for (const agent of ["scout", "planner", "reviewer", "watchdog"]) assert.equal(await dispatch(a, { agent }, `c-${agent}`), undefined, agent);
	// The fourth's tool ran: the registry holds it and the call no longer counts twice.
	running.set("w3", { id: "w3", agent: "worker" });
	await a.fire("tool_result", { toolName: "subagent", toolCallId: "c4", input: { agent: "worker" }, content: [], isError: false });
	assert.match((await dispatch(a, { agent: "worker" }, "c6"))?.reason ?? "", /4 workers/);
	running.delete("w0"); // a result was delivered
	assert.equal(await dispatch(a, { agent: "worker" }, "c7"), undefined);
});

/** A project folder whose apps.json names one app, with or without `integration`. */
const project = (integration: boolean) => {
	const dir = mkdtempSync(join(tmpdir(), "psb-lite-"));
	dirs.push(dir);
	mkdirSync(join(dir, ".git"));
	mkdirSync(join(dir, ".straw-boss"));
	writeFileSync(join(dir, ".straw-boss", "apps.json"), JSON.stringify({ apps: [{ name: "web", path: ".", ...(integration ? { integration: { base: "develop", skill: "x" } } : {}) }] }));
	return dir;
};
const SB = ["board_read", "board_set", "boss_broadcast", "boss_duty", "boss_handover", "boss_promote", "boss_rename", "boss_server", "boss_status", "boss_wait_ask", "call_tower", "link_request", "train_car"];
async function toolsOf(o: { integrationOff: boolean; integrationApp: boolean; link: boolean }): Promise<string[]> {
	world = new World();
	sw ??= new ServerWorld(); // one for the four setups: its close waits out a start in flight (5 s)
	const { slot: _slot, version: _version, by: _by, env: _env, cli: _cli, now: _now, log: _log, ...reach } = sw.ctx({ version: "0.44.0" });
	if (o.link) {
		mkdirSync(join(world.stateDir, "link"), { recursive: true });
		writeFileSync(join(world.stateDir, "link", "enabled"), JSON.stringify({ v: 1, at: 1 }));
	}
	const cwd = project(o.integrationApp);
	const a = world.agent({ id: "m", name: "Docs", pane: "wA:p1", tab: "wA:t1", ui: true, env: { HOME: sw.env.HOME!, ...(o.integrationOff ? { STRAW_BOSS_INTEGRATION: "off" } : {}) }, deps: { stateDir: world.stateDir, version: "0.44.0", adoptMs: 30, cwd: () => cwd, server: sw.server(reach) } });
	await a.start();
	await a.promote();
	await section(a);
	return [...a.tools.keys()].filter((name) => SB.includes(name)).sort();
}

test("a main's tool list: train_car only with integration on and an app with `integration`, link_request only with Straw Link set up; boss_server stays", async () => {
	const base = SB.filter((name) => name !== "train_car" && name !== "link_request");
	assert.deepEqual(await toolsOf({ integrationOff: true, integrationApp: true, link: true }), [...base, "link_request"].sort(), "integration off");
	await world!.stopAll();
	assert.deepEqual(await toolsOf({ integrationOff: false, integrationApp: true, link: false }), [...base, "train_car"].sort(), "no link");
	await world!.stopAll();
	assert.deepEqual(await toolsOf({ integrationOff: false, integrationApp: false, link: true }), [...base, "link_request"].sort(), "no app with integration");
	await world!.stopAll();
	assert.deepEqual(await toolsOf({ integrationOff: false, integrationApp: true, link: true }), [...SB].sort(), "both on");
});

/** Turns integration (config.json of the state folder) and Straw Link (`link/enabled`) on or off, as the boss's GUI or an edit would. */
const setState = (stateDir: string, on: boolean) => {
	writeFileSync(join(stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, integration: on ? "on" : "off" }));
	mkdirSync(join(stateDir, "link"), { recursive: true });
	if (on) writeFileSync(join(stateDir, "link", "enabled"), JSON.stringify({ v: 1, at: 1 }));
	else rmSync(join(stateDir, "link", "enabled"), { force: true });
};

// The tool set is part of the cached prompt as the section is: train_car and link_request are decided at the session start, and a change of the integration switch or of Straw Link before the join
// (a slow Herdr holds it back) or after it changes nothing until the next session start (docs/specs/2026-11-23-lite-main.md §4, L8).
for (const on of [false, true]) {
	test(`the tool list stays as the session start found it when integration and Straw Link turn ${on ? "off" : "on"} inside the session`, async () => {
		world = new World();
		sw ??= new ServerWorld();
		const { slot: _slot, version: _version, by: _by, env: _env, cli: _cli, now: _now, log: _log, ...reach } = sw.ctx({ version: "0.44.0" });
		setState(world.stateDir, on);
		const cwd = project(true), herdr = world.herdr.runFor("wA:p1");
		world.herdr.addPane("wA:p1", "wA:t1");
		const held = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
		let first = true;
		const a = world.agent({ id: "m", name: "Docs", pane: "wA:p1", ui: true, env: { HOME: sw.env.HOME! }, deps: { stateDir: world.stateDir, version: "0.44.0", adoptMs: 30, cwd: () => cwd, server: sw.server(reach), run: async (args) => {
			if (first && args.join(" ") === "workspace list") { first = false; entered.resolve(); await held.promise; } // the sub workspace check, before the join
			return herdr(args);
		} } });
		await a.fire("session_start", { reason: "startup" });
		await entered.promise;
		setState(world.stateDir, !on); // before the join
		held.resolve();
		await world.quiet();
		await a.promote();
		await section(a);
		const tools = () => [...a.tools.keys()].filter((name) => name === "train_car" || name === "link_request").sort();
		assert.deepEqual(tools(), on ? ["link_request", "train_car"] : [], "as the session start found it");
		setState(world.stateDir, on); // after the join, and a /new in the same process
		await a.fire("session_start", { reason: "new" });
		await world.quiet();
		await section(a);
		assert.deepEqual(tools(), on ? ["link_request", "train_car"] : []);
	});
}
