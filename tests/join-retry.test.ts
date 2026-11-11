import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TOWER_LABEL } from "../src/herdr.ts";
import { settle, until, World } from "./fakes.ts";

// The retry timers are the test's own (`heldTimers`): none runs by itself, so nothing here sleeps to let a timer pass, a start's `world.quiet()` cannot be kept busy by a retry, and
// what a timer would do when its time came is what `fire` does. The delays are the schedule the session is given.
const SCHEDULE = [7001, 7002, 7003];
const HELD = { joinRetryMs: SCHEDULE };
const POLL = 60_000; // an upper bound for a join that polls the broker's connection 150 times at the 2 ms the fake sleeps: it ends as soon as the join has failed, however slow the machine is
let world = new World();
let timers = heldTimers(SCHEDULE);
beforeEach(() => void (timers = heldTimers(SCHEDULE)));
afterEach(async () => {
	await world.stopAll();
	timers.restore();
	world = new World();
});

/** The `setTimeout`s whose delay is one of `delays` are held until `fire` and dropped by a `clearTimeout`; any other timer is the real one. */
function heldTimers(delays: number[]) {
	const real = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
	const held = new Map<object, { ms: number; fn: () => void }>();
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		if (ms === undefined || !delays.includes(ms)) return real.set(fn, ms, ...rest);
		const handle = { unref: () => handle };
		held.set(handle, { ms, fn });
		return handle;
	}) as unknown as typeof setTimeout;
	globalThis.clearTimeout = ((handle?: object) => (handle && held.has(handle) ? held.delete(handle) : real.clear(handle as never))) as typeof clearTimeout;
	return {
		/** The delays of the timers held now, the oldest first. */
		get delays() {
			return [...held.values()].map((timer) => timer.ms);
		},
		get pending() {
			return held.size;
		},
		/** The held timers' functions as they are now: one still run after its timer was cleared shows what its own guard does. */
		callbacks: () => [...held.values()].map((timer) => timer.fn),
		/** Lets the delay of every held timer pass: each runs once, and a timer one of them arms stays held. */
		async fire() {
			for (const [handle, { fn }] of [...held]) (held.delete(handle), fn());
			await settle();
		},
		restore() {
			globalThis.setTimeout = real.set;
			globalThis.clearTimeout = real.clear;
		},
	};
}

const asked = (what: string) => world.herdr.calls.filter((c) => c.join(" ").startsWith(what)).length;

/** Herdr's answer to a command that begins with `what` fails (`times` of them, all by default), once a command that begins with `after` has been answered; `down.on` switches it, `failures` counts. */
function flaky(what: string, { times = Infinity, after = "" }: { times?: number; after?: string } = {}) {
	const down = { on: true, failures: 0, armed: !after };
	const runFor = world.herdr.runFor.bind(world.herdr);
	world.herdr.runFor = (self: string) => async (args: string[]) => {
		const line = args.join(" ");
		if (down.on && down.armed && down.failures < times && line.startsWith(what)) {
			down.failures++;
			throw new Error(`herdr ${what} failed: timed out`);
		}
		const answer = await runFor(self)(args);
		if (after && line.startsWith(after)) down.armed = true;
		return answer;
	};
	return down;
}
/** Holds Herdr's answer to a command that begins with `what` (the first one asked once `after` has been answered) until the test settles it. */
function hold(what: string, { after = "" }: { after?: string } = {}) {
	const gate = { held: false, release: () => {}, fail: (_error: Error) => {} };
	let armed = !after, taken = false;
	const runFor = world.herdr.runFor.bind(world.herdr);
	world.herdr.runFor = (self: string) => async (args: string[]) => {
		const line = args.join(" ");
		if (armed && !taken && line.startsWith(what)) {
			taken = gate.held = true;
			await new Promise<void>((resolve, reject) => ([gate.release, gate.fail] = [resolve, reject]));
		}
		const answer = await runFor(self)(args);
		if (after && line.startsWith(after)) armed = true;
		return answer;
	};
	return gate;
}
const joined = (a: { tokens: Record<string, string>; tools: Map<string, unknown> }) => a.tokens.sb_role === "member" && a.tools.has("boss_promote");
const said = (a: { notices: { text: string; level?: string }[] }, re: RegExp) => a.notices.filter((n) => re.test(n.text));
const errors = (a: { notices: { text: string; level?: string }[] }) => a.notices.filter((n) => n.level === "error");

test("a Herdr that is slow to say where the session runs does not bar it: the check is asked again on the schedule and the session joins once", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.start();
	assert.deepEqual([down.failures, timers.delays, [...a.tools.keys()]], [1, [7001], []], "the first failed check arms the first wait; nothing joined yet");
	for (const [failures, next] of [[2, 7002], [3, 7003], [4, 7003]] as const) {
		await timers.fire();
		assert.deepEqual([down.failures, timers.delays], [failures, [next]], "each wait is the next of the schedule, and the last repeats");
	}
	down.on = false;
	await timers.fire();
	await world.quiet();
	assert.ok(joined(a), "the join once Herdr answers");
	assert.equal(timers.pending, 0, "no retry is left once it joined");
	assert.equal(world.broker.registrations.length, 1, "one join, not two");
	assert.equal(said(a, /could not tell whether this is a sub workspace/).length, 1, "one warning for the first failure, none for the retries");
	assert.equal(said(a, /could not tell/)[0]!.level, "warning");
	assert.equal(errors(a).length, 0, JSON.stringify(a.notices));
	assert.equal(said(a, /joined the net/).length, 1, "one line when it joined after retries");
	assert.equal(said(a, /joined the net/)[0]!.level, "info");
});

test("a Herdr that answers 'sub workspace' bars for good: the check is not asked again", async () => {
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: false, repo_key: "/r/alpha" };
	world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { checkout_path: "/w/af", is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "feature", "wS:p1");
	const a = world.agent({ id: "s", pane: "wS:p1", deps: HELD });
	await a.start();
	assert.equal(timers.pending, 0, "no retry is armed after a definitive answer");
	assert.deepEqual([[...a.tools.keys()], world.broker.registrations, said(a, /sub workspace/).length], [[], [], 1]);
});

test("a session still unplaced joins when the boss uses it: /boss and a subagent call ask Herdr again at once", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.start();
	assert.equal(down.failures, 1);
	await a.command(); // Herdr is still down: the answer is the reason, not a join
	assert.equal(down.failures, 2, "/boss asked again");
	assert.deepEqual([...a.tools.keys()], []);
	down.on = false;
	await a.toolCall("subagent"); // the call asks again, then joins and promotes
	await world.quiet();
	assert.equal(a.tokens.sb_role, "main");
	assert.equal(world.broker.registrations.length, 1, "one join");

	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t2", deps: HELD });
	down.on = true;
	await b.start();
	down.on = false;
	await b.command(); // /boss joins, then takes the tab as its main
	await until(() => b.tokens.sb_role === "main", "/boss joins after Herdr answered");
	assert.equal(world.broker.registrations.filter((r) => r.id === "b").length, 1);
});

test("a join whose own look at the pane fails, before any channel exists, is retried by a timer: no event would come", async () => {
	const look = flaky("pane current", { times: 2, after: "workspace list" });
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.start();
	assert.deepEqual([look.failures, timers.delays], [1, [7001]]);
	await timers.fire();
	assert.deepEqual([look.failures, timers.delays], [2, [7002]]);
	await timers.fire();
	await world.quiet();
	assert.ok(joined(a), "the join by timer");
	assert.equal(world.broker.registrations.length, 1);
	assert.equal(said(a, /joined the net/).length, 1);
	assert.equal(errors(a).length, 1, "the first failure is told once, the retries are quiet");
});

test("a join that failed for want of intercom is retried by a timer when no connection event comes", async () => {
	world.broker.connected = false;
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.start();
	await until(() => a.notices.some((n) => /not connected/.test(n.text)), "the failed join", POLL);
	assert.deepEqual(timers.delays, [7001]);
	world.broker.connected = true; // no `connection` event is fired
	await timers.fire();
	await until(() => joined(a), "the retried join");
	assert.equal(world.broker.registrations.length, 1, "no second registration");
	assert.equal(said(a, /joined the net/).length, 1);
});

test("a shutdown ends the retries: the timer is cleared, and its function does nothing when it runs anyway", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.start();
	await timers.fire();
	assert.deepEqual([down.failures, timers.pending], [2, 1], "a retry is pending");
	const [late] = timers.callbacks();
	await a.stop("reload");
	assert.equal(timers.pending, 0, "the shutdown cleared the timer");
	down.on = false;
	const lists = asked("workspace list");
	late!(); // the timer's function as it would run if the clear were missed
	await settle();
	assert.equal(asked("workspace list"), lists, "and it asks nothing after the shutdown");
	assert.deepEqual([[...a.tools.keys()], world.broker.registrations], [[], []], "so nothing joins");
});

test("a /new that starts another session while the first still retries leaves one join and no stale retry", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.start();
	assert.equal(down.failures, 1);
	const [stale] = timers.callbacks();
	down.on = false;
	await a.fire("session_start", { reason: "new" });
	await world.quiet();
	assert.ok(joined(a), "the join of the new session");
	assert.equal(timers.pending, 0, "the new start cleared the old start's timer");
	const lists = asked("workspace list");
	stale!(); // the old timer's function as it would run if the clear were missed
	await settle();
	assert.equal(asked("workspace list"), lists, "it asks nothing for a start that has ended");
	assert.equal(world.broker.registrations.length, 1, "one join");
	assert.equal(said(a, /joined the net/).length, 0, "the new session never failed: no retry line");
});

test("a stale start's failed join does not cancel the retry of the start that replaced it (JR-F001)", async () => {
	const list = flaky("workspace list");
	list.on = false;
	const look = hold("pane current", { after: "workspace list" }); // the first start's join waits at its look at the pane
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.fire("session_start", { reason: "startup" });
	await until(() => look.held, "the first start's join in flight");
	list.on = true;
	await a.fire("session_shutdown", { reason: "new" });
	await a.fire("session_start", { reason: "new" }); // its check fails under the same load, and arms its retry
	await until(() => list.failures >= 1, "the new start's failed check");
	await settle();
	assert.deepEqual(timers.delays, [7001], "the new start's retry is armed");
	look.fail(new Error("herdr pane current failed: timed out")); // the old start's join fails now
	await settle();
	assert.equal(errors(a).length, 0, "the old start's join error is not told to the new one");
	list.on = false;
	await timers.fire();
	await world.quiet();
	assert.ok(joined(a), "the new start's own retry joined it");
	assert.equal(world.broker.registrations.length, 1);
});

test("a join retry does not run the restore decisions again: the role record of a session that became main while it waited stays (JR-F002)", async () => {
	const look = flaky("pane current", { times: 1, after: "workspace list" });
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	a.file = "/s/a.jsonl";
	await a.start();
	assert.equal(look.failures, 1, "the join failed at start");
	await a.command(); // /boss joins and takes the tab, which writes its record
	await until(() => a.tokens.sb_role === "main", "main by /boss");
	const roles = join(world.stateDir, "roles"), records = () => (existsSync(roles) ? readdirSync(roles) : []);
	assert.equal(records().length, 1, "the main's record");
	await timers.fire(); // the retry of the failed start runs
	await world.quiet();
	assert.equal(records().length, 1, "the retry did not forget it");
});

test("the join error is told even when the check failed first (JR-F003)", async () => {
	const list = flaky("workspace list", { times: 1 });
	const look = flaky("pane current", { times: 1, after: "workspace list" });
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.start();
	assert.equal(list.failures, 1);
	await timers.fire(); // the check answers, and the join's look at the pane fails
	assert.equal(look.failures, 1);
	assert.equal(said(a, /could not tell whether this is a sub workspace/).length, 1, "the check's warning");
	assert.equal(said(a, /pane current failed/).length, 1, "and the join's error");
	assert.equal(said(a, /pane current failed/)[0]!.level, "error");
	await timers.fire();
	await world.quiet();
	assert.ok(joined(a));
	assert.equal(errors(a).length, 1, "each is told once");
});

for (const [name, why, setup] of [
	["pi-intercom is not loaded", /pi-intercom is not loaded/, () => world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", noIntercom: true, deps: HELD })],
	["a tab id too long for a namespace", /too long for an intercom namespace/, () => world.agent({ id: "a", pane: "wA:p1", tab: `wA:${"t".repeat(22)}`, deps: HELD })],
	["a broker without extension-bus-v1", /lacks extension-bus-v1/, () => ((world.broker.supported = false), world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD }))],
] as const)
	test(`a join that waiting cannot fix is told once and not retried: ${name} (JR-F004)`, async () => {
		const a = setup();
		await a.start();
		await until(() => said(a, why).length > 0, "the join error", POLL);
		const looks = asked("pane current");
		assert.equal(timers.pending, 0, "no retry is armed");
		await timers.fire();
		assert.equal(asked("pane current"), looks, "and nothing asks again");
		assert.deepEqual([said(a, why).length, said(a, why)[0]!.level, joined(a)], [1, "error", false]);
	});

test("the warning about a pane without terminal_id is told once per start, not at every check retry (JR-F005)", async () => {
	const down = flaky("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	(world.herdr.pane("wA:p1") as { terminal_id?: string }).terminal_id = "";
	await a.start();
	for (let i = 0; i < 3; i++) await timers.fire();
	assert.equal(down.failures, 4);
	assert.equal(said(a, /no terminal_id/).length, 1, JSON.stringify(a.notices.map((n) => n.text)));
	await a.fire("session_shutdown", { reason: "new" });
	await a.fire("session_start", { reason: "new" });
	await settle();
	assert.equal(said(a, /no terminal_id/).length, 2, "a new start tells it again");
});

test("a check that answers after the shutdown does not join (the quit came while Herdr was asked)", async () => {
	const list = hold("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.fire("session_start", { reason: "startup" });
	await until(() => list.held, "the check in flight");
	await a.stop("quit");
	list.release(); // it answers 'joinable' now
	await world.quiet();
	assert.deepEqual([world.broker.registrations, [...a.tools.keys()], timers.pending], [[], [], 0]);
});

test("a check that fails after the shutdown arms no retry", async () => {
	const list = hold("workspace list");
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.fire("session_start", { reason: "startup" });
	await until(() => list.held, "the check in flight");
	await a.stop("quit");
	list.fail(new Error("herdr workspace list failed: timed out"));
	await world.quiet();
	assert.equal(timers.pending, 0, "no timer outlives the shutdown");
	assert.equal(said(a, /could not tell/).length, 0, "and nothing is told to a session that has ended");
});

test("a /resume into a tower's session file does not keep the unplaced member's bar: a subagent call is blocked as a tower's (D2)", async () => {
	const down = flaky("workspace list");
	// In the tower's own tab: since todo #131 the entry only claims the role, and the glyph tab Herdr lists proves it (in an ordinary tab the resume is a member's, tests/role-proof.test.ts).
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7");
	const a = world.agent({ id: "a", pane: "wA:p7", tab: "wA:t7", deps: HELD });
	await a.start();
	assert.equal(down.failures, 1);
	down.on = false;
	a.entries.push({ customType: "straw-boss", data: { tower: true, workspaceId: "wA" } }); // the file pi resumes was a tower's
	await a.fire("session_shutdown", { reason: "resume" });
	await a.fire("session_start", { reason: "resume" });
	await until(() => a.tokens.sb_role === "tower", "the tower start");
	const lists = asked("workspace list");
	const verdict = await a.fireResult("tool_call", { toolName: "subagent", toolCallId: "call", input: {} });
	assert.equal((verdict as { block?: boolean } | undefined)?.block, true, "a tower dispatches no subagents");
	assert.equal(asked("workspace list"), lists, "and the old start's check is not asked again for it");
});

// todo #131: the proof of a tower's and a train's tab is one more thing Herdr is asked (`tab list`), so it is one more answer that can fail. A failure proves nothing either way.
test("a claimed tower whose tabs Herdr cannot list is neither a tower nor a member: the check is asked again, and the tab then proves it", async () => {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7");
	const down = flaky("tab list");
	const a = world.agent({ id: "a", pane: "wA:p7", tab: "wA:t7", deps: HELD, entries: [{ customType: "straw-boss", data: { tower: true, workspaceId: "wA" } }] });
	await a.start();
	assert.equal(down.failures, 1);
	assert.equal(a.tokens.sb_role, undefined, "no role on a claim Herdr did not answer for");
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined);
	assert.ok(a.notices.some((n) => /could not tell whether this is a sub workspace: .*tab list failed/.test(n.text)), "the boss is told the start is unplaced");
	assert.equal(a.notices.some((n) => /starts as a member/.test(n.text)), false, "and nothing was decided against the claim");
	assert.deepEqual(timers.delays, [SCHEDULE[0]]);
	down.on = false;
	await timers.fire();
	await until(() => a.tokens.sb_role === "tower" && world.herdr.workspace("wA").tokens.tower === "a", "the tower start once Herdr listed the tab");
});

test("a reloaded train whose tabs Herdr cannot list is not settled: a subagent call meanwhile joins nothing as a member, and the retry makes it the train again", async () => {
	world.herdr.addTab("wA:t9", "train 1106m", "wA:p9");
	Object.assign(world.herdr.pane("wA:p9").tokens, { sb_open_main: "1", sb_train: "acme/2026-11-06-m", sb_opened_by: "tower-x" }); // as the tower's open leaves the pane
	const first = world.agent({ id: "t", pane: "wA:p9", tab: "wA:t9", env: { STRAW_BOSS_ROLE: "train" }, deps: HELD });
	await first.start();
	assert.equal(first.tokens.sb_role, "train");
	await first.stop("reload");
	const down = flaky("tab list");
	const again = world.agent({ id: "t", pane: "wA:p9", env: { STRAW_BOSS_ROLE: "train" }, entries: first.entries, deps: HELD });
	await again.fire("session_start", { reason: "reload" });
	await world.quiet();
	assert.ok(down.failures >= 1);
	const roleWrites = () => world.herdr.calls.filter((c) => c[0] === "pane" && c[1] === "report-metadata" && c.join(" ").includes("sb_role")).map((c) => c.join(" "));
	const before = roleWrites().length;
	await again.toolCall("subagent"); // the model dispatches while its own role is not settled
	assert.deepEqual(roleWrites().slice(before), [], "nothing published a role for it: not a member's, and never one that takes the train's tokens off its pane");
	assert.equal(again.tokens.sb_train, "acme/2026-11-06-m", "the pane keeps the tokens the /reload left it");
	assert.equal(again.tools.has("boss_promote"), false, "and it joined nothing");
	down.on = false;
	await timers.fire();
	await until(() => again.tools.has("train_car") || again.regs.size > 0, "the join once Herdr listed the tab");
	assert.equal(again.tokens.sb_role, "train");
	assert.equal(again.tokens.sb_train, "acme/2026-11-06-m");
});

test("the Herdr server watch of a joined session is in place: a takeover makes it publish its tokens again at once", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: HELD });
	await a.start();
	assert.equal(a.tokens.sb_role, "member");
	world.herdr.pane("wA:p1").tokens = {};
	await world.takeover();
	await until(() => a.tokens.sb_role === "member", "the tokens after the takeover");
});
