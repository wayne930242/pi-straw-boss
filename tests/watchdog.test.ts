import assert from "node:assert/strict";
import { test } from "node:test";
import { createStrawBoss } from "../src/index.ts";
import type { Reply } from "../src/server/socket.ts";
import { EMPTY_REPLY, isWatchdog, registerWatchdog, WATCHDOG_BLOCK, WATCHDOG_TOOLS, type WatchdogDeps } from "../src/watchdog.ts";
import { fakeClock } from "./fake-clock.ts";

// The watchdog's side in a child (docs/specs/2026-11-09-agent-kinds.md §10, D3): the two tools, which child is a watchdog, the block, the narrowing, and the refusal to start.

type Entry = { type: string; customType?: string; data?: unknown };
interface Tool { name: string; defaultActive?: boolean; execute?: (id: string, params: never, signal: AbortSignal | undefined, onUpdate: ((partial: unknown) => void) | undefined, ctx: unknown) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }> }
const entry = (agent: string): Entry => ({ type: "custom", customType: "straw-boss", data: { agent } });
const WATCHDOG_ENV = { PI_SUBAGENT_ID: "run-1", PI_SUBAGENT_NAME: "dog-ci", PI_SUBAGENT_AGENT: "watchdog", PI_SUBAGENT_SESSION: "/s/sessions/x/child.jsonl", PI_SUBAGENT_ACTIVITY_FILE: "/s/sessions/x/artifacts/p/subagent-activity/run-1.json" };

/**
 * A child pi as the watchdog module sees it. Its tool registry follows pi 1.3.0 (agent-session.js `_refreshToolRegistry`): with `--tools` (`allow`), a tool the list does not name stays out of the
 * registry and every registered one is active again after each registration; with none, a tool is active unless it says `defaultActive: false`.
 */
function child({ env = WATCHDOG_ENV as Record<string, string>, entries = [] as Entry[], allow, deps, others = ["read", "bash", "write", "intercom", "caller_ping"], through }: { env?: Record<string, string>; entries?: Entry[]; allow?: string[]; deps?: WatchdogDeps; others?: string[]; through?: "index" } = {}) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>(), registry = new Map<string, Tool>();
	const state = { active: [] as string[], pending: false, aborted: 0, shutdown: 0, entries: [...entries], narrowed: 0 };
	const register = (tool: Tool) => {
		if (allow && !allow.includes(tool.name)) return;
		registry.set(tool.name, tool);
		state.active = allow ? [...registry.keys()] : [...new Set([...state.active, ...(tool.defaultActive === false ? [] : [tool.name])])];
	};
	const pi = {
		on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => void handlers.set(type, [...(handlers.get(type) ?? []), handler]),
		registerTool: register,
		getAllTools: () => [...registry.values()].map((tool) => ({ name: tool.name })),
		getActiveTools: () => [...state.active],
		setActiveTools: (names: string[]) => ((state.active = names.filter((name) => registry.has(name))), void state.narrowed++),
		appendEntry: (customType: string, data: unknown) => void state.entries.push({ type: "custom", customType, data }),
	};
	const ctx = { hasPendingMessages: () => state.pending, abort: () => void state.aborted++, shutdown: () => void state.shutdown++, sessionManager: { getEntries: () => state.entries } };
	for (const name of others) register({ name }); // pi's own tools and the other extensions'
	if (through === "index") createStrawBoss({ env })(pi as never);
	else registerWatchdog(pi as never, env, deps);
	const fire = async (type: string, event: Record<string, unknown> = {}) => {
		let last: unknown;
		for (const handler of handlers.get(type) ?? []) last = (await handler({ type, ...event }, ctx)) ?? last;
		return last;
	};
	return {
		state, registry, register, fire, handlers,
		start: () => fire("session_start", { reason: "startup" }),
		run: () => fire("before_agent_start", { prompt: "task" }) as Promise<{ systemPrompt?: string } | undefined>,
		toolCall: (toolName: string, more: Record<string, unknown> = {}) => fire("tool_call", { toolName, toolCallId: "c1", input: {}, ...more }) as Promise<{ block?: boolean; reason?: string } | undefined>,
		tool: (name: string, params: Record<string, unknown>, signal?: AbortSignal, onUpdate?: (partial: unknown) => void) => registry.get(name)!.execute!("c1", params as never, signal, onUpdate, ctx),
	};
}

/** A scripted sb server on a clock the test owns: each request takes `after` ms (a hold), or the request's own timeout when that is shorter, which answers nothing. */
function server(script: (request: Record<string, unknown>, n: number, at: number) => { after?: number; reply?: Reply }, start = 1_000_000) {
	const clock = fakeClock(start), calls: { request: Record<string, unknown>; timeoutMs: number; at: number }[] = [];
	const call = async (request: Record<string, unknown>, timeoutMs: number) => {
		calls.push({ request, timeoutMs, at: clock.elapsed() });
		const { after = 0, reply } = script(request, calls.length - 1, clock.now());
		clock.advance(Math.min(after, timeoutMs));
		return after > timeoutMs ? undefined : reply;
	};
	return { clock, calls, deps: { call, now: clock.now, sleep: clock.sleep } satisfies WatchdogDeps };
}
const HOLD = 45_000;
const unchanged = (since: string, at: number): Reply => ({ ok: true, state: "unchanged", since, now: at, unit: { mark: "working" } });

test("isWatchdog: the first launch's role or the session's first agent entry, never a tool list", () => {
	const table: [string | undefined, Entry[], boolean, string][] = [
		["watchdog", [], true, "a first launch"],
		[undefined, [entry("watchdog")], true, "a resume: no role in the environment, the entry in its session"],
		["worker", [], false, "a worker"],
		["scout", [], false, "a scout"],
		["reviewer", [], false, "a reviewer"],
		[undefined, [], false, "a bare or handoff spawn: no role anywhere"],
		[undefined, [entry("scout")], false, "a resumed scout"],
		[undefined, [entry("worker"), entry("watchdog")], false, "the first entry counts, as the net reads it"],
		[undefined, [{ type: "custom", customType: "straw-boss", data: { duty: "standing" } }, entry("watchdog")], true, "an entry with no agent is not an agent entry"],
		[undefined, [{ type: "custom", customType: "other", data: { agent: "watchdog" } }], false, "another extension's entry"],
		[undefined, [{ type: "message", data: { agent: "watchdog" } }], false, "a message"],
		["", [], false, "an empty role"],
	];
	for (const [agent, entries, want, what] of table) assert.equal(isWatchdog(agent, entries), want, what);
});

test("the watch tools are registered inactive in every child, and a worker, a scout, and a reviewer are not held: their bash runs and nothing narrows their tools", async () => {
	for (const [agent, allow] of [["worker", undefined], ["scout", ["read", "bash", "caller_ping"]], ["reviewer", ["read", "bash", "write", "caller_ping"]], [undefined, undefined]] as const) {
		const c = child({ env: { PI_SUBAGENT_ID: "run-2", ...(agent ? { PI_SUBAGENT_AGENT: agent } : {}) }, ...(allow ? { allow: [...allow] } : {}) });
		await c.start();
		const before = [...c.state.active];
		assert.ok(!c.state.active.includes("watch_read") && !c.state.active.includes("watch_report"), `${agent}: the watch tools are not active`);
		if (!allow) assert.deepEqual([c.registry.get("watch_read")?.defaultActive, c.registry.get("watch_report")?.defaultActive], [false, false], `${agent}: registered, inactive by default`);
		assert.equal(await c.run(), undefined, `${agent}: its run is left alone`);
		for (const name of ["bash", "write", "intercom", "subagent", "mcp", "read"]) assert.equal(await c.toolCall(name), undefined, `${agent}: ${name} is not blocked`);
		assert.deepEqual(c.state.active, before);
		assert.equal(c.state.narrowed + c.state.aborted + c.state.shutdown, 0, `${agent}: nothing narrowed, aborted, or shut down`);
	}
});

test("a scout spawned with watch_read in its tools is not a watchdog: unnarrowed, and its bash runs", async () => {
	const c = child({ env: { PI_SUBAGENT_ID: "run-3", PI_SUBAGENT_AGENT: "scout" }, allow: ["read", "bash", "watch_read", "watch_report", "caller_ping"] });
	await c.start();
	assert.equal(await c.run(), undefined);
	assert.ok(c.state.active.includes("watch_read") && c.state.active.includes("bash"));
	assert.equal(await c.toolCall("bash"), undefined);
	assert.equal(c.state.narrowed, 0);
});

test("holding D3: a first launch with a widened tool list is blocked outside read, watch_read, watch_report, caller_ping, subagent_done, codemode's calls too, and its view is narrowed", async () => {
	const c = child({ allow: ["read", "bash", "intercom", "write", "watch_read", "watch_report", "caller_ping"] });
	await c.start();
	assert.equal(await c.run(), undefined, "it starts: both watch tools are there");
	assert.deepEqual([...c.state.active].sort(), ["caller_ping", "read", "watch_read", "watch_report"]);
	for (const name of ["bash", "intercom", "write", "edit", "subagent", "codemode", "mcp", "todo"]) assert.deepEqual(await c.toolCall(name), { block: true, reason: WATCHDOG_BLOCK }, name);
	assert.deepEqual(await c.toolCall("bash", { parentToolCallId: "code-1" }), { block: true, reason: "sb: a watchdog only reads and reports" }, "a call from a codemode script");
	for (const name of WATCHDOG_TOOLS) assert.equal(await c.toolCall(name), undefined, name);
	assert.deepEqual([...WATCHDOG_TOOLS].sort(), ["caller_ping", "read", "subagent_done", "watch_read", "watch_report"]);
	assert.equal(c.state.aborted + c.state.shutdown, 0);
});

test("holding D3: a late registerTool re-widens the view; the block still holds, and the next run narrows again", async () => {
	const c = child({ allow: ["read", "bash", "late_tool", "watch_read", "watch_report", "caller_ping"] });
	await c.start();
	await c.run();
	assert.ok(!c.state.active.includes("bash"));
	c.register({ name: "late_tool" }); // an MCP server that connects after the first run
	assert.ok(c.state.active.includes("bash") && c.state.active.includes("late_tool"), "pi activates every listed tool again");
	assert.equal((await c.toolCall("bash"))?.block, true);
	assert.equal((await c.toolCall("late_tool"))?.block, true);
	await c.run();
	assert.deepEqual([...c.state.active].sort(), ["caller_ping", "read", "watch_read", "watch_report"]);
	const narrowed = c.state.narrowed;
	await c.run();
	assert.equal(c.state.narrowed, narrowed, "a view already narrow is left alone");
});

test("holding D3: a resume names no role and is known by its session's entry", async () => {
	const { PI_SUBAGENT_AGENT: _agent, ...resumed } = WATCHDOG_ENV;
	const c = child({ env: { ...resumed, PI_SUBAGENT_ID: "run-9" }, entries: [entry("watchdog")], allow: ["read", "bash", "watch_read", "watch_report", "caller_ping"] });
	await c.start();
	assert.equal((await c.toolCall("bash"))?.reason, WATCHDOG_BLOCK);
	assert.equal(await c.run(), undefined);
	assert.ok(!c.state.active.includes("bash"));
	// Another session in the same process (a /new, a fork) is read again.
	c.state.entries = [];
	await c.fire("session_start", { reason: "new" });
	assert.equal(await c.toolCall("bash"), undefined);
});

test("a watchdog that cannot watch: a spawn tools override without the watch tools tells the dispatcher `cannot start`, ends the child, and leaves at most one blocked turn", async () => {
	for (const allow of [["read", "bash", "caller_ping"], ["read", "watch_read", "caller_ping"], ["read", "watch_report", "caller_ping"]]) {
		const s = server(() => ({ reply: { ok: true, delivery: "delivered" } }));
		const c = child({ allow, deps: s.deps });
		await c.start();
		assert.equal(s.calls.length, 0, "nothing is sent before the first run: the activity file is written by then");
		const result = await c.run();
		assert.deepEqual(s.calls.map((x) => x.request), [{ cmd: "watch-report", session: WATCHDOG_ENV.PI_SUBAGENT_SESSION, child: "run-1", activityFile: WATCHDOG_ENV.PI_SUBAGENT_ACTIVITY_FILE, text: "sb: watchdog dog-ci cannot start: its tool list lacks watch_read/watch_report (a spawn tools override?)" }], allow.join());
		assert.deepEqual([c.state.aborted, c.state.shutdown], [1, 1], "the run is aborted and pi shut down");
		assert.equal(result?.systemPrompt, EMPTY_REPLY);
		assert.match(EMPTY_REPLY, /Reply with nothing/);
		assert.equal((await c.toolCall("bash"))?.block, true, "if pi runs the turn anyway, its tools are blocked");
		assert.equal((await c.run())?.systemPrompt, EMPTY_REPLY, "a second run is refused the same way");
		assert.equal(s.calls.length, 1, "and told once");
	}
	// The dispatcher cannot be reached (no sb server): the child still ends.
	const c = child({ allow: ["read", "bash"], deps: { call: async () => undefined } });
	await c.start();
	assert.equal((await c.run())?.systemPrompt, EMPTY_REPLY);
	assert.equal(c.state.shutdown, 1);
});

test("watch_read returns the server's verdict as it is, less `ok`, and sends only what the call names", async () => {
	const s = server((_request, _n, at) => ({ after: 3_000, reply: { ok: true, state: "changed", since: "s1", now: at + 3_000, unit: { mark: "waiting", monitors: [{ id: "m1", status: "running", ageMs: 10 }] } } }));
	const c = child({ deps: s.deps });
	const result = await c.tool("watch_read", { key: "wA:p3", since: "s0", quietMs: 120_000, loadMax: 8, deadline: 9_000_000 });
	assert.deepEqual(result.details, { state: "changed", since: "s1", now: 1_003_000, unit: { mark: "waiting", monitors: [{ id: "m1", status: "running", ageMs: 10 }] } });
	assert.deepEqual(JSON.parse(result.content[0]!.text), result.details);
	assert.deepEqual(s.calls, [{ request: { cmd: "watch-read", key: "wA:p3", since: "s0", deadline: 9_000_000, quietMs: 120_000, loadMax: 8 }, timeoutMs: 55_000, at: 0 }]);
	const first = await c.tool("watch_read", { key: "wA:p3" });
	assert.equal(first.details.state, "changed");
	assert.deepEqual(s.calls[1]!.request, { cmd: "watch-read", key: "wA:p3" }, "a first call sends no stamp");
	for (const state of ["stalled", "load", "expired", "gone"]) {
		const one = server(() => ({ reply: { ok: true, state, since: "s2", now: 5, ...(state === "gone" ? { successor: "wA:p7" } : {}) } }));
		const got = await child({ deps: one.deps }).tool("watch_read", { key: "k", since: "s1" });
		assert.equal(got.details.state, state);
		assert.equal(one.calls.length, 1, `${state} ends the call`);
		if (state === "gone") assert.equal(got.details.successor, "wA:p7");
	}
});

test("watch_read re-polls until waitMs: unchanged at 600 s by default, each re-poll with an onUpdate, the newest stamp sent on", async () => {
	const s = server((request, n, at) => ({ after: HOLD, reply: unchanged(n < 3 ? String(request.since) : "s1", at + HOLD) }));
	const c = child({ deps: s.deps }), updates: unknown[] = [];
	const result = await c.tool("watch_read", { key: "wA:p3", since: "s0" }, undefined, (partial) => updates.push(partial));
	assert.equal(s.clock.elapsed(), 600_000, "the default wait, by the clock");
	assert.equal(s.calls.length, 14, "one hold of 45 s after another; the last is cut at the wait's end");
	assert.equal(s.calls.at(-1)!.timeoutMs, 15_000);
	assert.ok(s.calls.slice(0, -1).every((x) => x.timeoutMs === 55_000), "the request timeout is 55 s");
	assert.equal(updates.length, 13, "every re-poll moves the activity file");
	assert.deepEqual(s.calls.map((x) => x.request.since), ["s0", "s0", "s0", "s0", ...Array.from({ length: 10 }, () => "s1")]);
	assert.deepEqual(result.details, { state: "unchanged", since: "s1", now: 1_600_000, unit: { mark: "working" } });
	const short = server((_request, _n, at) => ({ after: HOLD, reply: unchanged("s0", at + HOLD) }));
	await child({ deps: short.deps }).tool("watch_read", { key: "k", since: "s0", waitMs: 100_000 });
	assert.equal(short.clock.elapsed(), 100_000);
	assert.deepEqual(short.calls.map((x) => x.at), [0, 45_000, 90_000]);
	// A server that answers `unchanged` at once (it holds nothing) is asked every 2 s, not in a tight loop.
	const eager = server((_request, _n, at) => ({ after: 0, reply: unchanged("s0", at) }));
	await child({ deps: eager.deps }).tool("watch_read", { key: "k", since: "s0", waitMs: 10_000 });
	assert.deepEqual(eager.calls.map((x) => x.at), [0, 2_000, 4_000, 6_000, 8_000]);
});

test("watch_read: a waitMs over 3000000 is refused before anything is asked", async () => {
	const s = server(() => ({ reply: { ok: true, state: "changed", since: "s", now: 1 } }));
	const c = child({ deps: s.deps });
	await assert.rejects(c.tool("watch_read", { key: "k", waitMs: 3_000_001 }), /waitMs is at most 3000000/);
	assert.equal(s.calls.length, 0);
	assert.equal((await c.tool("watch_read", { key: "k", waitMs: 3_000_000 })).details.state, "changed");
	const schema = (c.registry.get("watch_read") as unknown as { parameters: { properties: Record<string, { maximum?: number; minimum?: number; maxLength?: number }> } }).parameters.properties;
	assert.deepEqual([schema.waitMs!.maximum, schema.quietMs!.minimum, schema.key!.maxLength, schema.since!.maxLength], [3_000_000, 60_000, 200, 512]);
});

test("watch_read: a message that arrives during the call ends it early as unchanged; one already waiting at its start does not", async () => {
	let c: ReturnType<typeof child>;
	const s = server((_request, n, at) => {
		if (n === 1) c.state.pending = true; // a steer lands during the second hold
		return { after: HOLD, reply: unchanged("s0", at + HOLD) };
	});
	c = child({ deps: s.deps });
	const early = await c.tool("watch_read", { key: "k", since: "s0" });
	assert.equal(early.details.state, "unchanged");
	assert.equal(s.clock.elapsed(), 90_000, "it returns with the hold the message arrived in");
	assert.equal(early.details.server, undefined);
	// The steer is consumed at the turn boundary; a follow-up still waits when the next call starts, and that call runs its whole wait.
	const again = await c.tool("watch_read", { key: "k", since: "s0", waitMs: 200_000 });
	assert.equal(again.details.state, "unchanged");
	assert.equal(s.clock.elapsed(), 290_000, "no quick second return");
});

test("watch_read: a server that restarts during a hold is asked again after 2 s, and the verdict still comes", async () => {
	const s = server((request, n, at) => (n === 1 ? { after: 20_000 } : n === 2 ? { after: 0 } : n === 3 ? { after: 1_000, reply: { ok: true, state: "changed", since: "s9", now: at + 1_000 } } : { after: HOLD, reply: unchanged(String(request.since), at + HOLD) }));
	const c = child({ deps: s.deps }), updates: unknown[] = [];
	const result = await c.tool("watch_read", { key: "k", since: "s0" }, undefined, (partial) => updates.push(partial));
	assert.deepEqual(s.calls.map((x) => x.at), [0, 45_000, 67_000, 69_000], "the hold cut off at 65 s, then 2 s apart");
	assert.deepEqual(result.details, { state: "changed", since: "s9", now: 1_070_000 });
	assert.equal(updates.length, 3);
});

test("watch_read: a server still down at waitMs gives unchanged with server: unreachable; an older server, server: outdated; neither fails the call", async () => {
	const down = server(() => ({ after: 0 }));
	const gone = await child({ deps: down.deps }).tool("watch_read", { key: "k", since: "s0", waitMs: 60_000 });
	assert.deepEqual(gone.details, { state: "unchanged", since: "s0", now: 1_060_000, server: "unreachable" });
	assert.equal(down.calls.length, 30, "asked every 2 s");
	const old = server(() => ({ reply: { ok: false, error: "unknown command watch-read" } }));
	const outdated = await child({ deps: old.deps }).tool("watch_read", { key: "k", waitMs: 60_000 });
	assert.deepEqual(outdated.details, { state: "unchanged", now: 1_060_000, server: "outdated" });
	// A reading the server could not make is a failed hold too, and its word is kept.
	const sick = server(() => ({ reply: { ok: false, error: "the net could not be read; ask again" } }));
	assert.deepEqual((await child({ deps: sick.deps }).tool("watch_read", { key: "k", since: "s0", waitMs: 10_000 })).details, { state: "unchanged", since: "s0", now: 1_010_000, server: "unreachable", error: "the net could not be read; ask again" });
	// A server that comes back is no longer `unreachable` in the answer.
	const back = server((_request, n, at) => (n < 3 ? { after: 0 } : { after: HOLD, reply: unchanged("s0", at + HOLD) }));
	assert.deepEqual((await child({ deps: back.deps }).tool("watch_read", { key: "k", since: "s0", waitMs: 120_000 })).details, { state: "unchanged", since: "s0", now: 1_120_000, unit: { mark: "working" } });
	// A hang with no answer for the whole request timeout counts as down.
	const hung = server(() => ({ after: 600_000 }));
	assert.equal((await child({ deps: hung.deps }).tool("watch_read", { key: "k", waitMs: 120_000 })).details.server, "unreachable");
});

test("watch_read: the deadline is judged by the clock even with no server: expired, with now", async () => {
	const down = server(() => ({ after: 0 }));
	const result = await child({ deps: down.deps }).tool("watch_read", { key: "k", since: "s0", deadline: 1_030_000 });
	assert.deepEqual(result.details, { state: "expired", since: "s0", now: 1_030_000, server: "unreachable" });
	const past = await child({ deps: down.deps }).tool("watch_read", { key: "k", deadline: 5 });
	assert.equal(past.details.state, "expired", "a deadline already past asks nothing more");
});

test("watch_read fails only for an unknown key and an abort", async () => {
	const s = server(() => ({ reply: { ok: false, error: "unknown key wZ:p1" } }));
	await assert.rejects(child({ deps: s.deps }).tool("watch_read", { key: "wZ:p1" }), /^Error: unknown key wZ:p1$/);
	assert.equal(s.calls.length, 1);
	// An abort ends a call whose hold never answers, at once.
	const abort = new AbortController();
	const pending = child({ deps: { call: () => new Promise<Reply | undefined>(() => {}), now: Date.now } }).tool("watch_read", { key: "k" }, abort.signal);
	abort.abort();
	await assert.rejects(pending, /Operation aborted/);
	await assert.rejects(child({ deps: s.deps }).tool("watch_read", { key: "k" }, abort.signal), /Operation aborted/, "a call under a signal already aborted");
});

test("watch_report sends the child's own session, id, and activity file with the text, and no target; it answers the delivery, and a refusal is the call's error", async () => {
	const s = server((request) => (request.text === "again" ? { reply: { ok: false, error: "rate: one report every 30 s" } } : request.text === "lost" ? { reply: { ok: false, error: "not delivered: pi-intercom is not connected" } } : request.text === "old" ? { reply: { ok: false, error: "unknown command watch-report" } } : { reply: { ok: true, delivery: request.text === "late" ? "gone" : "delivered" } }));
	const c = child({ deps: s.deps });
	const result = await c.tool("watch_report", { text: "tests stalled since 10:02 (mark working, no line for 12 min)", to: "someone-else" });
	assert.deepEqual(result.details, { delivery: "delivered" });
	assert.deepEqual(s.calls[0]!.request, { cmd: "watch-report", session: WATCHDOG_ENV.PI_SUBAGENT_SESSION, child: "run-1", activityFile: WATCHDOG_ENV.PI_SUBAGENT_ACTIVITY_FILE, text: "tests stalled since 10:02 (mark working, no line for 12 min)" });
	assert.equal((await c.tool("watch_report", { text: "late" })).details.delivery, "gone");
	await assert.rejects(c.tool("watch_report", { text: "again" }), /^Error: rate: one report every 30 s$/);
	await assert.rejects(c.tool("watch_report", { text: "lost" }), /^Error: not delivered: pi-intercom is not connected$/, "a report that did not go out says why");
	await assert.rejects(c.tool("watch_report", { text: "old" }), /older than this watchdog/);
	await assert.rejects(child({ deps: { call: async () => undefined } }).tool("watch_report", { text: "x" }), /did not answer/);
	const schema = (c.registry.get("watch_report") as unknown as { parameters: { properties: Record<string, { minLength?: number; maxLength?: number }> } }).parameters.properties;
	assert.deepEqual([Object.keys(schema), schema.text!.minLength, schema.text!.maxLength], [["text"], 1, 2000]);
});

test("the extension registers the watchdog's side in every child, outside Herdr too (a Core-launched child has no pane), and nothing outside a child", async () => {
	const top = child({ env: {}, through: "index", others: [] });
	assert.deepEqual([[...top.registry.keys()], [...top.handlers.keys()]], [[], []], "no child: nothing");
	// A watchdog outside Herdr is held, and records its role at its first turn so that its resume is known.
	const c = child({ env: WATCHDOG_ENV, through: "index", allow: ["read", "bash", "watch_read", "watch_report", "caller_ping"] });
	assert.deepEqual([...c.registry.keys()].filter((name) => name.startsWith("watch_")), ["watch_read", "watch_report"]);
	await c.start();
	assert.equal((await c.toolCall("bash"))?.reason, WATCHDOG_BLOCK);
	await c.fire("turn_start");
	await c.fire("turn_start");
	assert.deepEqual(c.state.entries, [entry("watchdog")]);
	// A worker outside Herdr gets the inactive tools and nothing else: no entry, no block.
	const w = child({ env: { PI_SUBAGENT_ID: "run-5", PI_SUBAGENT_AGENT: "worker" }, through: "index" });
	await w.start();
	await w.fire("turn_start");
	assert.equal(await w.toolCall("bash"), undefined);
	assert.deepEqual(w.state.entries, []);
	assert.ok(!w.state.active.includes("watch_read"));
});
