import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fieldsOf } from "../src/header.ts";
import { createStrawBoss } from "../src/index.ts";
import { EMPTY_REPLY, WATCHDOG_BLOCK } from "../src/watchdog.ts";
import { type Agent, World } from "./fakes.ts";
import { type Hosted, startHosted } from "./gui-world.ts";
import { until } from "./server-world.ts";

// The watchdog end to end (docs/specs/2026-11-09-agent-kinds.md §10, Phase 3): a coordinator's dispatch passes the gate, the child's own module (src/watchdog.ts, loaded as pi loads it, through src/index.ts) asks the running sb server over
// its real control socket (`callServer`: the record, the gate, the secret), the server's routes (src/server/watchread.ts, watchreport.ts) read the net of a fake Herdr and tie the child to its dispatcher by pi-herdr-agents' files, and the
// report reaches the dispatcher through the broker under a `watch_report` header. Nothing between the tool call and the broker is replaced. The child has no pane (a Core-launched child, D3), so its role entry is the watchdog module's own.
// No wait here is on the clock: each ends with the server's answer, with the tool's own `waitMs`, or when the server is seen to hold the request.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-dog-")));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
let world: World | undefined, hosted: Hosted | undefined, n = 0;
afterEach(async () => { await hosted?.stop(); await world?.stopAll(); hosted = world = undefined; });

/** The role's own tool list as pi-herdr-agents passes it to a child: the `tools:` line of roles/watchdog.md, and `caller_ping` (an auto-exit role gets no `subagent_done`). */
const ROLE_TOOLS = [...(/^tools: (.+)$/m.exec(readFileSync(new URL("../roles/watchdog.md", import.meta.url), "utf8"))?.[1] ?? "").split(",").map((t) => t.trim()), "caller_ping"];

/** A computer: an sb server (its GUI, its control socket) over a fake Herdr and broker, a coordinator `P` and a member `T` in one tab, and pi's agent folder, where the server's state folder is the one a child's `callServer` looks in. */
async function computer() {
	const agent = join(scratch, `agent-${++n}`), env = { HOME: join(scratch, `home-${n}`), PI_CODING_AGENT_DIR: agent };
	world = new World();
	world.stateDir = join(agent, "straw-boss");
	mkdirSync(world.stateDir, { recursive: true });
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false } }));
	world.herdr.addTab("wA:t1", "work");
	// The route reads the net itself every 25 ms while a hold is open (10 s in production, where the page's readings come every 2 s), so a change is seen without a wait on the clock. A hold arms its own timer (45 s) as it opens, which
	// is how the test sees that the server holds a request.
	let holds = 0;
	const timer = (ms: number, fn: () => void) => { if (ms >= 1000) holds++; const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };
	hosted = await startHosted(world, { pid: process.pid, env, options: { watchdog: { readMs: 25, timer } } });
	const parent = world.agent({ id: "P", name: "docs", pane: "wA:p1", tab: "wA:t1" }), target = world.agent({ id: "T", name: "build", pane: "wA:p2", tab: "wA:t1" });
	await parent.start();
	await parent.promote();
	await target.start();
	return { env, parent, target, holds: () => holds, art: join(agent, "sessions", "--Users-me-proj--", "artifacts", parent.id), reports: () => world!.broker.delivered.filter((d) => d.to === parent.id && fieldsOf(d.message)?.kind === "watch_report") };
}
type Computer = Awaited<ReturnType<typeof computer>>;

interface Tool { name: string; execute?: (id: string, params: never, signal: AbortSignal | undefined, onUpdate: ((partial: unknown) => void) | undefined, ctx: unknown) => Promise<{ details: Record<string, unknown> }> }
/**
 * A child pi that pi-herdr-agents launched from `P`, with the files it leaves (the launch or resume script, the activity file) and the session file as pi writes it: none before the first turn. Its tool registry follows pi 1.3.0
 * (agent-session.js `_refreshToolRegistry`): with `--tools`, a tool the list does not name stays out of the registry, and every registered one is active again after each registration.
 */
function launch(c: Computer, o: { id: string; name: string; allow: string[]; session?: string; resume?: boolean }) {
	const session = o.session ?? join(dirname(dirname(c.art)), `2026-11-14T00-00-00-000Z_${o.id}.jsonl`), activity = join(c.art, "subagent-activity", `${o.id}.json`), scripts = join(c.art, "subagent-scripts");
	mkdirSync(scripts, { recursive: true });
	mkdirSync(dirname(activity), { recursive: true });
	writeFileSync(activity, JSON.stringify({ version: 1, id: o.id, phase: "active", updatedAt: Date.now() }));
	// A resume script carries a new id and the same session file, and names no role (pi-herdr-agents `launch-resume.ts`).
	const role = o.resume ? "" : "export PI_SUBAGENT_AGENT='watchdog'\n";
	writeFileSync(join(scripts, o.resume ? `${o.name}-resume-1763078400000.sh` : `${o.name}-${o.id}.sh`), `#!/bin/sh\nexport PI_SUBAGENT_ID='${o.id}'\nexport PI_SUBAGENT_NAME='${o.name}'\nexport PI_SUBAGENT_SESSION='${session}'\n${role}exec pi\n`);
	const env = { ...c.env, PI_SUBAGENT_ID: o.id, PI_SUBAGENT_NAME: o.name, PI_SUBAGENT_SESSION: session, PI_SUBAGENT_ACTIVITY_FILE: activity, ...(o.resume ? {} : { PI_SUBAGENT_AGENT: "watchdog" }) };
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>(), registry = new Map<string, Tool>();
	const entries: { type: string; customType?: string; data?: unknown }[] = existsSync(session) ? readFileSync(session, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
	const state = { active: [] as string[], aborted: 0, shutdown: 0 };
	const register = (tool: Tool) => {
		if (!o.allow.includes(tool.name)) return;
		registry.set(tool.name, tool);
		state.active = [...registry.keys()];
	};
	const pi = {
		on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => void handlers.set(type, [...(handlers.get(type) ?? []), handler]),
		registerTool: register,
		getAllTools: () => [...registry.values()].map((tool) => ({ name: tool.name })),
		getActiveTools: () => [...state.active],
		setActiveTools: (names: string[]) => void (state.active = names.filter((name) => registry.has(name))),
		// pi writes the session file with the first message, and an entry as a line of it.
		appendEntry: (customType: string, data: unknown) => {
			const entry = { type: "custom", customType, data };
			entries.push(entry);
			if (!existsSync(session)) writeFileSync(session, `${JSON.stringify({ type: "session", id: o.id })}\n`);
			appendFileSync(session, `${JSON.stringify(entry)}\n`);
		},
	};
	const ctx = { hasPendingMessages: () => false, abort: () => void state.aborted++, shutdown: () => void state.shutdown++, sessionManager: { getEntries: () => entries } };
	for (const name of ["read", "bash", "write", "intercom", "caller_ping"]) register({ name }); // pi's own tools and the other extensions'
	createStrawBoss({ env })(pi as never);
	const fire = async (type: string, event: Record<string, unknown> = {}) => {
		let last: unknown;
		for (const handler of handlers.get(type) ?? []) last = (await handler({ type, ...event }, ctx)) ?? last;
		return last;
	};
	return {
		state, session,
		start: () => fire("session_start", { reason: o.resume ? "resume" : "startup" }),
		run: () => fire("before_agent_start", { prompt: "task" }) as Promise<{ systemPrompt?: string } | undefined>,
		turn: () => fire("turn_start"),
		toolCall: (toolName: string) => fire("tool_call", { toolName, toolCallId: "c1", input: {} }) as Promise<{ block?: boolean; reason?: string } | undefined>,
		tool: async (name: string, params: Record<string, unknown>) => {
			assert.ok(registry.get(name)?.execute, `the child has the tool ${name}`);
			return (await registry.get(name)!.execute!("c1", params as never, undefined, undefined, ctx)).details as Record<string, unknown> & { unit?: { mark?: string } };
		},
	};
}
const dispatch = (a: Agent, input: Record<string, unknown>) => a.fireResult("tool_call", { toolName: "subagent", toolCallId: "c1", input });

test("a coordinator with no plan dispatches a watchdog; it reads its unit through the sb server, a mark change wakes its hold with `changed`, and its report reaches the coordinator under kind=watch_report; resumed, it is still held and still its dispatcher's", async () => {
	const c = await computer();
	assert.equal(await dispatch(c.parent, { agent: "watchdog", name: "dog-build", task: "Watch T until its build ends." }), undefined, "the gate lets a watchdog through without a plan");
	const dog = launch(c, { id: "kid1", name: "dog-build", allow: ROLE_TOOLS });
	await dog.start();
	assert.equal(await dog.run(), undefined, "a watchdog with its tools runs");
	await dog.turn();
	assert.deepEqual(dog.state.active.sort(), ["caller_ping", "read", "watch_read", "watch_report"], "the role's tools and the one pi-herdr-agents adds, the watch tools active because the role names them");
	assert.deepEqual(await dog.toolCall("bash"), { block: true, reason: WATCHDOG_BLOCK });

	// The first read has no stamp: the unit as it is now.
	const first = await dog.tool("watch_read", { key: "T", waitMs: 20_000 });
	assert.equal(first.state, "changed", JSON.stringify(first));
	assert.equal(first.unit?.mark, "idle");
	assert.equal(typeof first.now, "number");
	// With the server's stamp and nothing moving, the wait ends by itself, unchanged, under the same stamp.
	const quiet = await dog.tool("watch_read", { key: "T", since: first.since, waitMs: 300 });
	assert.equal(quiet.state, "unchanged", JSON.stringify(quiet));
	assert.equal(quiet.since, first.since);
	assert.equal(c.holds(), 1, "the server held that request: the stamp is its own");
	// The server holds the next request when the unit's mark changes, and the reading that sees the change answers it (the hold's own timer would answer after 45 s, past this wait).
	const held = dog.tool("watch_read", { key: "T", since: quiet.since, quietMs: 60_000, waitMs: 30_000 });
	await until(() => c.holds() === 2, "the server to hold the request", 20_000);
	c.target.status = "working";
	const woke = await held;
	assert.equal(woke.state, "changed", JSON.stringify(woke));
	assert.equal(woke.unit?.mark, "working");
	assert.notEqual(woke.since, first.since);
	assert.equal(woke.server, undefined, "the server answered");

	assert.deepEqual(await dog.tool("watch_report", { text: "build (T) went to work: mark working", to: "T" }), { delivery: "delivered" });
	assert.equal(c.reports().length, 1);
	assert.equal(world!.broker.delivered.filter((d) => d.message.includes("went to work")).length, 1, "the dispatcher and nobody else");
	const f = fieldsOf(c.reports()[0]!.message)!;
	assert.deepEqual([f.kind, f.from, f.id, f.role, f.reply], ["watch_report", "watchdog dog-build", "kid1", "session", "none"]);
	assert.ok(c.reports()[0]!.message.endsWith("] build (T) went to work: mark working"), c.reports()[0]!.message);

	// A resume: a new id, a script that names no role, the same session file. The entry the first launch wrote there (by the watchdog module: this child has no pane) is what the child and the server both know it by.
	assert.match(existsSync(dog.session) ? readFileSync(dog.session, "utf8") : "", /"customType":"straw-boss","data":\{"agent":"watchdog"\}/, "the first launch recorded its role");
	const again = launch(c, { id: "kid2", name: "dog-build", allow: [...ROLE_TOOLS, "bash"], session: dog.session, resume: true });
	await again.start();
	await again.run();
	assert.deepEqual(await again.toolCall("bash"), { block: true, reason: WATCHDOG_BLOCK }, "held by its entry, whatever tool list the resume passed");
	assert.ok(!again.state.active.includes("bash"), "and its view is narrowed");
	assert.equal((await again.tool("watch_read", { key: "T", since: woke.since, waitMs: 300 })).state, "unchanged", "the server still knows the stamp");
	// The server took the resumed child for the same watchdog: its checks passed, and the limit of one report every 30 s is the session's, across the resume.
	await assert.rejects(again.tool("watch_report", { text: "still working" }), /rate: one report every 30 s/);
	assert.equal(c.reports().length, 1);
});

test("a watchdog whose spawn passed a tool list without the watch tools tells its dispatcher it cannot start, before its session file exists, and ends", async () => {
	const c = await computer();
	const dog = launch(c, { id: "kid3", name: "dog-ci", allow: ["read", "bash", "caller_ping"] });
	await dog.start();
	assert.deepEqual(await dog.run(), { systemPrompt: EMPTY_REPLY });
	assert.deepEqual([dog.state.aborted, dog.state.shutdown], [1, 1], "the child ends");
	assert.equal(existsSync(dog.session), false, "pi has written no session file: the server took the report by the launch script");
	assert.equal(c.reports().length, 1);
	const f = fieldsOf(c.reports()[0]!.message)!;
	assert.deepEqual([f.kind, f.from, f.id, f.reply], ["watch_report", "watchdog dog-ci", "kid3", "none"]);
	assert.ok(c.reports()[0]!.message.endsWith("] sb: watchdog dog-ci cannot start: its tool list lacks watch_read/watch_report (a spawn tools override?)"), c.reports()[0]!.message);
	assert.deepEqual(await dog.toolCall("bash"), { block: true, reason: WATCHDOG_BLOCK }, "and a turn pi starts anyway reaches no tool");
});
