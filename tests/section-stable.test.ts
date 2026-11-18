import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { type Agent, PROMPT_DIR, settle, World } from "./fakes.ts";

// A session's `straw-boss` system section holds nothing of another session: no name of a tower or a main, no state. Such a value rewrote the section whenever that session renamed, left, or came back, and a
// rewritten section reads the whole context uncached (measured 2026-11-13 to 11-16: 27 strict cache misses, 4.1M tokens, on coordinator mains whose tower line flipped between the tower's name and "none yet").
// The live values come from `boss_status`.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

/** One run: its section, and the steers it sent, delivered as pi's loop delivers them before the run settles. */
const section = async (agent: Agent) => {
	const text = (await agent.run())["straw-boss"] ?? "";
	await agent.deliver();
	await agent.fire("agent_settled", { aborted: false });
	return text;
};
/** A session's facts are read again when a session leaves the broker (membership.ts `sync`): one that comes and goes in another workspace makes every session read them now. */
let nudges = 0;
const nudge = async () => {
	const passer = world.agent({ id: `passer-${++nudges}`, pane: `wB:n${nudges}`, tab: "wB:t1" });
	await passer.start();
	await passer.stop();
	await settle();
};
const main = async (id: string, pane: string, tab: string) => {
	const agent = world.agent({ id, pane, tab });
	await agent.start();
	await agent.promote();
	return agent;
};

test("a main's section is the same bytes with no tower, with its workspace's tower live, and after that tower left", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const none = await section(a);
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await nudge();
	assert.equal(((await a.tool("boss_status")).details as { tower: { id: string } }).tower.id, "tower-wA", "the session knows the tower: boss_status names it");
	const live = await section(a);
	await tower.stop();
	await nudge();
	const gone = await section(a);
	assert.match(none, /^You are the main agent of Herdr tab work, of kind coordinator:/);
	assert.equal(live, none, "a tower that opened");
	assert.equal(gone, none, "a tower that left");
	assert.doesNotMatch(none, /tower-wA|none yet/);
});

test("a main's section is the same bytes while another main works, goes idle, renames itself, and leaves", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const b = await main("b", "wA:p2", "wA:t2");
	const before = await section(a);
	world.herdr.pane("wA:p2").agent_status = "working";
	b.status = "working";
	await nudge();
	assert.equal(await section(a), before, "another main working");
	world.herdr.pane("wA:p2").agent_status = "idle";
	b.status = "idle";
	await nudge();
	assert.equal(await section(a), before, "another main idle");
	await b.tool("boss_rename", { name: "ledger rounding" });
	await nudge();
	assert.equal(await section(a), before, "another main renamed");
	await b.stop();
	await nudge();
	assert.equal(await section(a), before, "another main gone");
});

test("a member's section names neither its tab's main nor the tower: it is the same bytes when the main renames its session or the tower comes and goes", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await b.start();
	const before = await section(b);
	assert.match(before, /^Straw Boss: you are a member of tab work of workspace Alpha, and the tab has a main agent \(`boss_status` names it\)\./);
	const status = (await b.tool("boss_status")).details as { tabs: { main: string }[] };
	assert.equal(status.tabs[0]!.main, "a", "the live name is boss_status's");
	a.name = "ledger rounding"; // a `/name`: the session's name moves and its tab's label stays
	await nudge();
	assert.equal(await section(b), before, "the main renamed");
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await nudge();
	assert.equal(await section(b), before, "a tower opened");
	await tower.stop();
	await nudge();
	assert.equal(await section(b), before, "the tower left");
});

test("the role prompts a session renders name only this session's own facts: no placeholder for another session's name or state", () => {
	const allowed = new Set(["tab", "duty", "workspace", "head", "dir", "state", "cli"]);
	for (const file of readdirSync(PROMPT_DIR).filter((f) => f.endsWith(".md"))) {
		for (const [, key] of readFileSync(`${PROMPT_DIR}/${file}`, "utf8").matchAll(/\{\{(\w+)\}\}/g)) assert.ok(allowed.has(key!), `${file} uses {{${key}}}`);
	}
});

// A coordinator's plan graph (docs/specs/2026-11-09-agent-kinds.md §2a) toggled "## Dispatch" and "## Graph:" in the section at every run start that followed a todo call (traced before 0.80.12: 22 + 22 strict cache misses, about
// 3.9M tokens a day). The section keeps the graph it was rendered with for the session; a graph that changed since reaches the model once, as rebrief's steer, at the next run start or during a run.
const plan = (a: { entries: { customType: string; data: unknown }[]; toolResult(name: string): Promise<void> }, graph?: string, status = "pending") => {
	a.entries.splice(0, a.entries.length, ...a.entries.filter((e) => e.customType !== "rpiv-todo-state"), { customType: "rpiv-todo-state", data: { nextId: 2, tasks: [{ id: 1, subject: "p", status, metadata: graph ? { graph } : {} }] } });
	return a.toolResult("todo");
};
const told = (a: { sent: { customType: string; content: string; deliverAs?: string }[] }) => a.sent.filter((m) => m.customType === "straw-boss").map((m) => (assert.equal(m.deliverAs, "steer"), m.content));

test("a coordinator's section is the same bytes while its plan's graph comes, changes, and goes; each change reaches the model once, as a steer, at the next run start or during a run", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	assert.doesNotMatch(first, /## Dispatch|## Graph:/);
	await plan(a, "fan-out");
	assert.deepEqual(told(a), [], "an idle session is told at its next run");
	assert.equal(await section(a), first, "a graph that appeared while idle");
	assert.equal(told(a).length, 1);
	assert.match(told(a)[0]!, /^<straw-boss>\nYour plan's graph is now fan-out\/fan-in\. Add to your instructions:[\s\S]*## Dispatch[\s\S]*## Graph: fan-out\/fan-in/);
	assert.equal(await section(a), first, "a run with no change");
	assert.equal(told(a).length, 1, "a change is told once, not at every run");
	await a.run(); // a run in progress: the change is steered at once (rebrief), and the next run start adds nothing
	await plan(a, "single-loop");
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	assert.equal(told(a).length, 2);
	assert.match(told(a)[1]!, /Your plan's graph is now single-loop\. Drop your "## Graph:" section\./);
	assert.equal(await section(a), first, "a graph that changed during a run");
	assert.equal(told(a).length, 2);
	await plan(a, "orchestrator-worker");
	assert.equal(await section(a), first, "a graph that changed while idle");
	assert.match(told(a)[2]!, /Your plan's graph is now orchestrator-worker\. Add to your instructions:[\s\S]*## Graph: orchestrator-worker/);
	await plan(a, "orchestrator-worker", "completed");
	assert.equal(await section(a), first, "a plan that ended while idle");
	assert.equal(told(a).length, 4);
	assert.match(told(a)[3]!, /Your plan has no open graph: drop your "## Dispatch" and "## Graph:" sections\./);
	await plan(a, "fan-out");
	await plan(a, undefined);
	assert.equal(await section(a), first, "a graph that came and went between two runs");
	assert.equal(told(a).length, 4, "the model was told no graph, and no graph it is");
});

test("the section is rendered anew with the plan's graph where the cache or the steers are gone: a compaction, a tree move, and every session start (startup, /reload, /new, /resume, /fork)", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	assert.doesNotMatch(await section(a), /## Dispatch/);
	await plan(a, "fan-out");
	await a.fire("session_compact", { reason: "threshold", willRetry: false, fromExtension: false });
	assert.match(await section(a), /## Dispatch[\s\S]*## Graph: fan-out\/fan-in/, "after a compaction");
	assert.deepEqual(told(a), [], "the section carries the graph: no steer");
	await plan(a, "single-loop");
	await a.fire("session_tree", { newLeafId: "x", oldLeafId: "y" });
	const tree = await section(a);
	assert.match(tree, /## Dispatch/);
	assert.doesNotMatch(tree, /## Graph:/, "after a tree move");
	for (const reason of ["reload", "new", "resume", "fork"]) {
		await plan(a, reason === "new" || reason === "fork" ? "orchestrator-worker" : "fan-out");
		await a.fire("session_start", { reason });
		await world.quiet();
		assert.match(await section(a), reason === "new" || reason === "fork" ? /## Graph: orchestrator-worker/ : /## Graph: fan-out\/fan-in/, `after a session start (${reason})`);
	}
	assert.deepEqual(told(a), []);
});

test("a compaction during a run tells the rest of the run what its section lacks (a steer when the turn is retried, a stored message when not); the next run renders the section anew; so does a kind change", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	await section(a);
	await plan(a, "fan-out");
	await section(a);
	assert.equal(told(a).length, 1);
	await a.run();
	await a.fire("session_compact", { reason: "overflow", willRetry: true, fromExtension: false });
	assert.equal(told(a).length, 2, "the steer before the compaction may be summarized away");
	assert.equal(told(a)[1], told(a)[0]);
	await a.fire("agent_settled", { aborted: false });
	assert.match(await section(a), /## Graph: fan-out\/fan-in/, "the run after the compaction renders the section anew");
	assert.equal(told(a).length, 2);
	await a.run();
	await plan(a, "single-loop");
	assert.equal(told(a).length, 3, "steered during the run");
	await a.deliver();
	await a.fire("session_compact", { reason: "threshold", willRetry: false, fromExtension: false });
	const stored = a.sent.at(-1)!;
	assert.equal(a.sent.length, 4);
	assert.deepEqual([stored.deliverAs, stored.triggerTurn], [undefined, false], "a compaction that retries no turn stores the message: a steer would make pi continue an ended run");
	assert.match(stored.content, /^<straw-boss>\nYour plan's graph is now single-loop\. Drop your "## Graph:" section\.\n<\/straw-boss>$/, "told against the section, rendered with fan-out/fan-in");
	await a.fire("agent_settled", { aborted: false });
	const next = await section(a);
	assert.match(next, /## Dispatch/);
	assert.doesNotMatch(next, /## Graph:/);
	assert.equal(a.sent.length, 4);
	await a.tool("boss_duty", { duty: "standing", reason: "minds the v1 redis" });
	await settle();
	assert.match(await section(a), /of kind standing[\s\S]*## Kind: standing/, "a kind change renders the section anew (and is steered as before when it comes during a run)");
	assert.equal(a.sent.length, 4);
});

// What the model was told counts from pi's delivery (the steer's `message_end`), not from the send (cachefix review, sbcache-F001): pi's queue can be cleared before it delivers a steer (Esc restores the queue to the
// editor, as do the dequeue key and the sb GUI's Edit, which presses it), and a steer counted at its send was then never told again, or the next one was written against a section part the model never dropped.
test("a steer pi's queue drops before delivery (Esc, the dequeue key, the sb GUI's Edit) is not told: the next run start tells it again", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await plan(a, "fan-out");
	assert.equal(told(a).length, 1);
	a.dropQueue();
	await a.fire("agent_settled", { aborted: true });
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2, "told again at the next run start");
	assert.equal(told(a)[1], told(a)[0]);
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2, "delivered, it is told");
});

test("a dropped steer that dropped the graph, then a new graph in the same run: the newest steer replaces the section's graph, and none adds a second", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	await plan(a, "fan-out");
	const first = await section(a);
	assert.match(first, /## Dispatch[\s\S]*## Graph: fan-out\/fan-in/);
	await a.run();
	await plan(a, "fan-out", "completed");
	assert.match(told(a)[0]!, /Your plan has no open graph: drop your "## Dispatch" and "## Graph:" sections\./);
	a.dropQueue(); // the dequeue key: the run goes on
	await plan(a, "orchestrator-worker");
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	assert.equal(await section(a), first);
	assert.match(told(a).at(-1)!, /^<straw-boss>\nYour plan's graph is now orchestrator-worker\. Replace your "## Graph:" section with:[\s\S]*## Graph: orchestrator-worker/);
	assert.doesNotMatch(told(a).join("\n"), /Add to your instructions/);
});

test("a change made while a steer waits in pi's queue is told once that steer is delivered, against what it told", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await plan(a, "fan-out");
	await plan(a, "orchestrator-worker"); // the same turn: the first steer is still queued
	assert.equal(told(a).length, 1, "one steer in flight");
	await a.deliver();
	assert.equal(told(a).length, 2);
	assert.match(told(a)[1]!, /Your plan's graph is now orchestrator-worker\. Replace your "## Graph:" section with:[\s\S]*## Graph: orchestrator-worker/);
	await a.fire("agent_settled", { aborted: false });
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2);
});

test("a steer an abort left in pi's queue (ctx.abort clears none) arrives at the next run's start, before the steer that run wrote against the older state: the model then gets the whole role prompt", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await plan(a, "fan-out");
	await a.fire("agent_settled", { aborted: true }); // sb's own aborts (watchdog, auto, closemain) call ctx.abort: pi keeps the steer queued
	await plan(a, "orchestrator-worker");
	assert.equal(await section(a), first);
	const steers = told(a);
	assert.equal(steers.length, 3);
	assert.match(steers[1]!, /Your plan's graph is now orchestrator-worker\. Add to your instructions:/, "written against the section, before the queued steer arrived");
	assert.match(steers[2]!, /^<straw-boss>\nSome of your Straw Boss role updates were lost or reached you out of order\. This replaces the role instructions in your system prompt:\n\nYou are the main agent[\s\S]*## Dispatch[\s\S]*## Graph: orchestrator-worker/);
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 3);
});

// pi keeps a run's section through a compaction in it (`_runSystemPromptOptions`), so every compaction of the run tells it again what its section lacks (sbcache-F002: the second told nothing).
test("each compaction in a run tells it again what its section lacks; the next run renders the section anew", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	await section(a);
	await a.run();
	await plan(a, "fan-out");
	await a.deliver();
	for (const n of [2, 3]) {
		await a.fire("session_compact", { reason: "overflow", willRetry: true, fromExtension: false });
		await a.deliver();
		assert.equal(told(a).length, n, `compaction ${n - 1}`);
		assert.equal(told(a).at(-1), told(a)[0], "told against the run's section, rendered with no graph");
	}
	await a.fire("agent_settled", { aborted: false });
	assert.match(await section(a), /## Graph: fan-out\/fan-in/);
	assert.equal(told(a).length, 3);
});
