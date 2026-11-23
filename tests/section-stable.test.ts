import assert from "node:assert/strict";
import { cpSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
	agent.idle = false; // pi streams: a steer waits in its queue (an idle pi stores it at once, as the test of sb2-F003 does)
	return agent;
};

test("a turn before join leaves the section unpinned; role changes after pinning use real labels and keep the bytes", async () => {
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await b.fire("session_start", { reason: "startup" });
	assert.equal((await b.run())["straw-boss"], undefined, "join is still pending");
	await b.fire("agent_settled", { aborted: false });
	await world.quiet();
	const pinned = await section(b);
	assert.match(pinned, /member of tab work/);
	b.idle = false;
	await b.promote();
	assert.equal(await section(b), pinned);
	assert.match(told(b).at(-1)!, /main agent of Herdr tab work/);
});

test("a joined member waits to pin until the first membership refresh supplies its tab label", async () => {
	const run = world.herdr.runFor("wA:p2");
	const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1", deps: { run: async (args) => {
		if (args.join(" ") === "workspace list" && b.tools.has("boss_promote")) {
			entered.resolve();
			await release.promise;
		}
		return run(args);
	} } });
	await b.fire("session_start", { reason: "startup" });
	try {
		await entered.promise;
		assert.equal(await section(b), "", "joined, but labels are not ready");
	} finally {
		release.resolve();
		await world.quiet();
	}
	const pinned = await section(b);
	assert.match(pinned, /member of tab work/);
	b.idle = false;
	await b.promote();
	assert.equal(await section(b), pinned);
	assert.match(told(b).at(-1)!, /main agent of Herdr tab work/);
});

for (const fallback of [false, true]) {
	test(`a tower ${fallback ? "pins without labels after the startup grace period" : "waits to pin until its workspace label arrives"}`, async () => {
		const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
		let now = 0;
		const tower = world.tower("tower-wA", "wA:t7", "wA:p7", false, { now: () => now, sleep: async (ms) => {
			if (ms === 2000) { entered.resolve(); await release.promise; }
		} });
		await tower.fire("session_start", { reason: "startup" });
		let pinned = "";
		try {
			await entered.promise;
			assert.equal(await section(tower), "", "the resident tower role is set, but the Herdr look is pending");
			assert.match(told(tower)[0]!, /tower of Herdr workspace none yet/);
			if (fallback) {
				now += 60_000;
				pinned = await section(tower);
				assert.match(pinned, /tower of Herdr workspace none yet/);
			}
		} finally {
			release.resolve();
			await world.quiet();
		}
		if (!fallback) {
			pinned = await section(tower);
			assert.match(pinned, /tower of Herdr workspace Alpha/);
			assert.match(told(tower).at(-1)!, /tower of Herdr workspace Alpha/, "the first pin supersedes the provisional steer");
		}
		assert.equal(await section(tower), pinned);
	});
}

const memberBrief = { name: "member", duty: "" };
const mainBrief = { name: "main", duty: "engineer" };
const historicSteer = (briefed: typeof memberBrief, base: typeof memberBrief | null, provisional?: true) => ({ type: "custom_message", customType: "straw-boss", details: { briefed, base, provisional } });

test("a resumed member replaces a stale main steer once without rewriting its section", async () => {
	await main("a", "wA:p1", "wA:t1");
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	b.transcript.push(historicSteer(memberBrief, null), historicSteer(mainBrief, null));
	await b.fire("session_start", { reason: "resume" });
	await world.quiet();
	b.idle = false;
	const pinned = await section(b);
	assert.match(pinned, /member of tab work/);
	assert.equal(told(b).length, 1, "the first turn supersedes the history");
	assert.match(told(b)[0]!, /replacing the system section and any earlier role updates[\s\S]*member of tab work/);
	assert.equal(await section(b), pinned);
	assert.equal(told(b).length, 1, "no repeated steer on the next turn");
});

// A whole steer written by 0.81.0 or 0.81.1 carries no signature of its text, a delta may have lost its base to compaction, and a provisional steer may carry missing labels: each is resent.
for (const prior of ["unsigned whole", "delta", "provisional"] as const) {
	test(`a reloaded member replaces the latest matching ${prior} steer`, async () => {
		await main("a", "wA:p1", "wA:t1");
		const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
		b.transcript.push(historicSteer(mainBrief, null), historicSteer(memberBrief, prior === "delta" ? memberBrief : null, prior === "provisional" ? true : undefined));
		await b.fire("session_start", { reason: "reload" });
		await world.quiet();
		const pinned = await section(b);
		assert.match(pinned, /member of tab work/);
		assert.equal(await section(b), pinned);
		assert.equal(told(b).length, 1);
		assert.match(told(b)[0]!, /replacing the system section and any earlier role updates[\s\S]*member of tab work/);
	});
}

/** Writes the session's latest role steer to its transcript, as pi stores a delivered message. */
const keep = (a: Agent, extra: { id?: string } = {}) => {
	const steer = a.sent.filter((m) => m.customType === "straw-boss").at(-1) as unknown as { customType: string; details: unknown };
	a.transcript.push({ type: "custom_message", customType: steer.customType, details: steer.details, ...extra });
};
/** A `/reload` and the run after it: the number of role steers sent so far. */
const reload = async (a: Agent) => {
	await a.fire("session_start", { reason: "reload" });
	await world.quiet();
	await section(a);
	return told(a).length;
};

test("a reloaded member reuses its latest whole steer only while that steer carries the text it would send now", async () => {
	const promptDir = join(world.stateDir, "test-prompts");
	cpSync(PROMPT_DIR, promptDir, { recursive: true });
	await main("a", "wA:p1", "wA:t1");
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1", deps: { promptDir } });
	b.transcript.push(historicSteer(mainBrief, null));
	await b.fire("session_start", { reason: "resume" });
	await world.quiet();
	b.idle = false;
	await section(b);
	assert.equal(told(b).length, 1);
	keep(b);
	assert.equal(await reload(b), 1, "the same text: the steer is reused");
	writeFileSync(join(promptDir, "member.md"), `${readFileSync(join(promptDir, "member.md"), "utf8").trim()}\n\nA rule an upgrade added.`);
	assert.equal(await reload(b), 2, "a changed prompt (an sb upgrade, a custom prompt, the integration switch): the steer is resent");
	assert.match(told(b)[1]!, /replacing the system section and any earlier role updates[\s\S]*A rule an upgrade added\./);
});

// pi's getBranch returns the whole path, while the model sees nothing before the last compaction's first kept entry.
test("a reload resends a whole steer the last compaction summarized away, and reuses one it kept", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	await section(a);
	await a.run();
	await kind(a, "standing");
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	assert.equal(told(a).length, 1);
	keep(a, { id: "s1" });
	assert.equal(await reload(a), 1, "the kind's whole steer carries the text it would send now: reused");
	a.transcript.push({ type: "message", id: "m1", message: { role: "user", content: "go on" } }, { type: "compaction", id: "c1", firstKeptEntryId: "s1" });
	assert.equal(await reload(a), 1, "a compaction that kept the steer: reused");
	a.transcript.push({ type: "message", id: "m2", message: { role: "user", content: "go on" } }, { type: "compaction", id: "c2", firstKeptEntryId: "m2" }); // a /compact while idle: nothing is steered then
	assert.equal(await reload(a), 2, "a compaction that summarized the steer away: resent");
	assert.match(told(a)[1]!, /replacing the system section and any earlier role updates[\s\S]*## Kind: standing/);
});

test("a member that joins during its first run is steered once: the first pin reuses that steer, its labels complete", async () => {
	await main("a", "wA:p1", "wA:t1");
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await b.fire("session_start", { reason: "startup" });
	b.idle = false;
	assert.equal((await b.run())["straw-boss"], undefined, "join is still pending");
	await world.quiet();
	await b.deliver();
	await b.fire("agent_settled", { aborted: false });
	assert.equal(told(b).length, 1);
	assert.match(told(b)[0]!, /member of tab work of workspace Alpha/);
	keep(b);
	const pinned = await section(b);
	assert.match(pinned, /member of tab work/);
	assert.equal(told(b).length, 1, "no second whole steer at the first pin");
	assert.equal(await section(b), pinned);
});

test("a resumed tower does not mistake a details-less digest for a role steer", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	const digest = { type: "custom_message", customType: "straw-boss", content: "Since your last run:\n- A main joined." };
	tower.transcript.push(digest);
	await tower.fire("session_start", { reason: "resume" });
	await world.quiet();
	const pinned = await section(tower);
	assert.match(pinned, /tower of Herdr workspace Alpha/);
	assert.equal(await section(tower), pinned);
	assert.deepEqual(told(tower), [], "a digest does not override the system section");
});

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

// The section is pinned once per session start (docs/specs/2026-11-23-lite-main.md §2): a plan's graph is in no prompt, and a role or kind change, boss_duty included, reaches the model as a steer of the
// whole role prompt (traced before 0.80.12: graph toggles cost 22 + 22 strict cache misses, about 3.9M tokens a day; 0.81.0 to 0.82.x still rewrote the section at boss_duty).
const plan = (a: { entries: { customType: string; data: unknown }[]; toolResult(name: string): Promise<void> }, graph?: string, status = "pending") => {
	a.entries.splice(0, a.entries.length, ...a.entries.filter((e) => e.customType !== "rpiv-todo-state"), { customType: "rpiv-todo-state", data: { nextId: 2, tasks: [{ id: 1, subject: "p", status, metadata: graph ? { graph } : {} }] } });
	return a.toolResult("todo");
};
/** A kind change through boss_duty, as the main's own tool call. */
const kind = (a: Agent, duty: string) => a.tool("boss_duty", { duty, reason: "the work changed" }).then(settle);
const told = (a: { sent: { customType: string; content: string; deliverAs?: string }[] }) => a.sent.filter((m) => m.customType === "straw-boss").map((m) => (assert.equal(m.deliverAs, "steer"), m.content));

test("a session keeps the same section across its own tab rename, graph changes, a kind change, compaction and tree navigation", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	assert.match(first, /^You are the main agent/);
	const changed: string[] = [];
	const check = async (event: string) => { if (await section(a) !== first) changed.push(event); };
	await a.tool("boss_rename", { name: "ledger rounding" });
	await nudge();
	const status = (await a.tool("boss_status")).details as { tabs: { label: string }[] };
	assert.equal(status.tabs[0]?.label, "ledger rounding", "boss_status still names the live tab");
	await check("own rename");
	await a.tool("boss_rename", { name: "work" });
	await nudge();
	await plan(a, "fan-out");
	await check("set graph");
	await plan(a);
	await check("clear graph");
	assert.deepEqual(told(a), [], "a graph steers nothing");
	await a.run();
	await kind(a, "standing");
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	await check("boss_duty");
	await a.fire("session_compact", { reason: "threshold", willRetry: false });
	await check("compact");
	await a.fire("session_tree", { newLeafId: "x", oldLeafId: "y" });
	await check("tree navigation");
	assert.deepEqual(changed, [], "events that rewrote the straw-boss system section");
	const steers = a.sent.filter((m) => m.customType === "straw-boss").map((m) => m.content);
	assert.equal(steers.length, 3);
	assert.match(steers[0]!, /Your kind is now standing\.[\s\S]*## Kind: standing/);
	assert.match(steers[1]!, /replacing the system section and any earlier role updates[\s\S]*## Kind: standing/, "guidance restored after compaction");
	assert.match(steers[2]!, /replacing the system section and any earlier role updates[\s\S]*## Kind: standing/, "guidance restored after tree navigation");
});

test("a main's section is the same bytes while its kind changes; each change reaches the model once, as a steer, at the next run start or during a run", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await kind(a, "standing");
	assert.deepEqual(told(a), [], "an idle session is told at its next run");
	assert.equal(await section(a), first, "a kind declared while idle");
	assert.equal(told(a).length, 1);
	assert.match(told(a)[0]!, /^<straw-boss>\nYour kind is now standing\. Follow only these Straw Boss role instructions[\s\S]*## Kind: standing/);
	assert.equal(await section(a), first, "a run with no change");
	assert.equal(told(a).length, 1, "a change is told once, not at every run");
	await a.run(); // a run in progress: the change is steered at once (rebrief), and the next run start adds nothing
	await kind(a, "integrator");
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	assert.equal(told(a).length, 2);
	assert.match(told(a)[1]!, /Your kind is now integrator\.[\s\S]*# Integrator/);
	assert.equal(await section(a), first, "a kind that changed during a run");
	assert.equal(told(a).length, 2);
	await kind(a, "standing");
	await kind(a, "integrator");
	assert.equal(await section(a), first, "a kind that went and came back between two runs");
	assert.equal(told(a).length, 2, "the model was told integrator, and integrator it is");
});

test("a tree move resends the whole role prompt; each session start renders the kind of that start", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.fire("session_tree", { newLeafId: "x", oldLeafId: "y" });
	assert.equal(await section(a), first);
	assert.match(told(a)[0]!, /replacing the system section and any earlier role updates/);
	assert.doesNotMatch(told(a)[0]!, /## Graph:|## Kind:/);
	await a.run();
	await kind(a, "standing");
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	for (const reason of ["reload", "new", "resume", "fork"]) {
		await plan(a, "fan-out");
		await a.fire("session_start", { reason });
		await world.quiet();
		const pinned = await section(a);
		assert.match(pinned, /of kind standing[\s\S]*## Kind: standing/, `after a session start (${reason})`);
		assert.doesNotMatch(pinned, /## Graph:/);
	}
});

test("a compaction during a run restores guidance as a steer or stored message without rewriting; boss_duty does not rewrite the section either", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await kind(a, "standing");
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	assert.equal(told(a).length, 1);
	assert.equal(await section(a), first, "boss_duty keeps the section's bytes");
	await a.run();
	await a.fire("session_compact", { reason: "overflow", willRetry: true, fromExtension: false });
	assert.equal(told(a).length, 2, "the steer before the compaction may be summarized away");
	assert.match(told(a)[1]!, /replacing the system section and any earlier role updates[\s\S]*## Kind: standing/);
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	assert.equal(await section(a), first, "the run after the compaction keeps the section");
	assert.equal(told(a).length, 2);
	await a.run();
	await kind(a, "integrator");
	assert.equal(told(a).length, 3, "steered during the run");
	await a.deliver();
	await a.fire("session_compact", { reason: "threshold", willRetry: false, fromExtension: false });
	const stored = a.sent.at(-1)!;
	assert.equal(a.sent.length, 4);
	assert.deepEqual([stored.deliverAs, stored.triggerTurn], [undefined, false], "a compaction that retries no turn stores the message: a steer would make pi continue an ended run");
	assert.match(stored.content, /replacing the system section and any earlier role updates[\s\S]*# Integrator/);
	await a.fire("agent_settled", { aborted: false });
	assert.equal(await section(a), first);
	assert.equal(a.sent.length, 4);
});

// What the model was told counts from pi's delivery (the steer's `message_end`), not from the send (cachefix review, sbcache-F001): pi's queue can be cleared before it delivers a steer (Esc restores the queue to the
// editor, as do the dequeue key and the sb GUI's Edit, which presses it), and a steer counted at its send was then never told again.
test("a steer pi's queue drops before delivery (Esc, the dequeue key, the sb GUI's Edit) is not told: the next run start tells it again", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await kind(a, "standing");
	assert.equal(told(a).length, 1);
	a.dropQueue();
	await a.fire("agent_settled", { aborted: true });
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2, "told again at the next run start");
	assert.equal(told(a)[1], told(a)[0]);
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2, "delivered, it is told");
});

test("a dropped kind steer followed by a change back to what the model holds: nothing more is told", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await kind(a, "standing");
	await a.deliver();
	await kind(a, "integrator");
	assert.match(told(a)[1]!, /Your kind is now integrator\./);
	a.dropQueue(); // the dequeue key: the run goes on
	await kind(a, "standing");
	await a.deliver();
	await a.fire("agent_settled", { aborted: false });
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2, "the model holds standing, and standing it is");
});

test("a change made while a steer waits in pi's queue is told once that steer is delivered", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await kind(a, "standing");
	await kind(a, "integrator"); // the same turn: the first steer is still queued
	assert.equal(told(a).length, 1, "one steer in flight");
	await a.deliver();
	assert.equal(told(a).length, 2);
	assert.match(told(a)[1]!, /Your kind is now integrator\.[\s\S]*# Integrator/);
	await a.fire("agent_settled", { aborted: false });
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2);
});

test("a steer an abort left in pi's queue (a compaction during the run, an RPC or SDK abort, a run that failed to start) arrives at the next run's start, before the steer that run wrote: the newest whole prompt wins", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await kind(a, "standing");
	await a.fire("agent_settled", { aborted: true }); // session.compact() during a run aborts without clearing the queue (sb's own ctx.abort clears it in the TUI)
	await kind(a, "integrator");
	assert.equal(await section(a), first);
	const steers = told(a);
	assert.equal(steers.length, 2);
	assert.match(steers[1]!, /Your kind is now integrator\.[\s\S]*# Integrator/, "written at the run start, after the queued steer");
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2, "both delivered in order: the model holds integrator");
});

// pi is idle while it awaits `agent_settled` handlers, and after `_prepareRun` threw past `before_agent_start` (no `agent_settled` then): a steer sent then is stored at once, with no `message_end` (sb2-F003).
test("a steer sent while pi is idle is stored at once and told as it is sent: a kind changed again before the next run is steered at that run's start", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	a.idle = true; // pi awaits the run's agent_settled handlers
	await kind(a, "standing");
	assert.match(told(a)[0]!, /Your kind is now standing\./);
	assert.equal(a.queued().length, 0, "stored, not queued");
	await a.fire("agent_settled", { aborted: false });
	await kind(a, "coordinator");
	a.idle = false;
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 2, "the stored kind is told: the next run start corrects it");
	assert.match(told(a)[1]!, /Your kind is now coordinator\./);
});

// Each compaction can summarize the prior steer away, including a steer added after an earlier compaction in this run.
test("each compaction in a run resends the guidance; the next run keeps the section", async () => {
	const a = await main("a", "wA:p1", "wA:t1");
	const first = await section(a);
	await a.run();
	await kind(a, "standing");
	await a.deliver();
	for (const n of [2, 3]) {
		await a.fire("session_compact", { reason: "overflow", willRetry: true, fromExtension: false });
		await a.deliver();
		assert.equal(told(a).length, n, `compaction ${n - 1}`);
		assert.match(told(a).at(-1)!, /replacing the system section and any earlier role updates[\s\S]*## Kind: standing/);
	}
	await a.fire("agent_settled", { aborted: false });
	assert.equal(await section(a), first);
	assert.equal(told(a).length, 3);
});
