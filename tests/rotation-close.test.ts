import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AUTO_FILE, seal } from "../src/autostate.ts";
import { readEntries } from "../src/board.ts";
import { ROT_CAP_MS } from "../src/rotclose.ts";
import { ENTRY } from "../src/state.ts";
import { type Agent, settle, until, World } from "./fakes.ts";

// A main that handed over closes itself (docs/specs/2026-11-26-rotation-close.md; the boss's request relayed by the old skald main, 2026-11-26): once its successor's own extension says it took over and nothing of
// the old main runs, sb clears its board and closes it and its pane, under auto mode too; a running subagent holds the close, and its result goes to the successor; after 6 hours the tower hears it, once.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const NEW = { tab: "wA:t100", pane: "wA:p101", main: "opened-wA:p101" };

/** Alpha with a tower and the boss's standing main, whose minute look and clock the test drives. */
async function town() {
	world.autoMains();
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	let off = 0;
	const looks: (() => Promise<void>)[] = [];
	const m = world.agent({ id: "main-1", name: "box watch", pane: "wA:p1", tab: "wA:t1", deps: { now: () => Date.now() + off, idleLook: (fn) => (looks.push(fn), () => {}) } });
	m.file = join(mkdtempSync(join(tmpdir(), "psb-rot-s-")), "2026-11-26T00-00-00-000Z_main-1.jsonl");
	await Promise.all(world.agents.map((a) => a.start()));
	await m.promote();
	await m.tool("boss_duty", { duty: "standing", reason: "it minds the box" });
	const handoff = join(mkdtempSync(join(tmpdir(), "psb-rot-h-")), "handoff-box-watch.md");
	writeFileSync(handoff, "# Handoff\n- goal: mind the box\n");
	return { tower, m, handoff, advance: (ms: number) => void (off += ms), look: async () => (await looks.at(-1)!(), await settle()) };
}
const successorOf = () => world.agents.find((a) => a.id === NEW.main)!;
/** The successor's own send to the old main by intercom, as pi reports the tool's result. */
const tellOld = async (successor: Agent, to = "main-1", isError = false) => (await successor.fire("tool_result", { toolName: "intercom", toolCallId: "c", input: { action: "send", to, message: "took over" }, content: [], isError }), await world.quiet());
const took = (m: Agent) => m.entries.some((e) => e.customType === ENTRY && typeof (e.data as { successor?: { took?: number } }).successor?.took === "number");
const closed = (m: Agent) => m.stopped && world.herdr.calls.some((c) => c[0] === "pane" && c[1] === "close" && c[2] === "wA:p1");
const auto = (on: boolean, rev: number) => writeFileSync(join(world.stateDir, AUTO_FILE), `${JSON.stringify(seal({ v: 1, rev, on, ...(on ? { since: "2026-11-26T00:00:00Z" } : {}), by: { via: "pi", name: "test" } }))}\n`);

test("the successor's own send to the old main is its takeover: the idle old main clears its board and closes itself and its pane, under auto mode too", async () => {
	const { m, handoff, look } = await town();
	auto(true, 1);
	await m.tool("boss_handover", { handoff, reason: "rotate" });
	const successor = successorOf();
	assert.equal(successor.entries.some((e) => e.customType === ENTRY && (e.data as { handoverFrom?: string }).handoverFrom === "main-1"), true, "the successor knows whom it took over from");
	await look();
	assert.equal(m.stopped, false, "no confirmation, no close");
	await tellOld(successor, "someone-else");
	await tellOld(successor, "main-1", true);
	assert.equal(took(m), false, "a send to another session, or one that failed, is no takeover");
	await m.tool("board_set", { now: "minding the box", items: [{ t: "watch", done: false }] });
	assert.equal(readEntries(join(world.stateDir, "board")).some((e) => e.session === "main-1"), true);
	await tellOld(successor);
	assert.equal(took(m), true);
	assert.equal(successor.entries.some((e) => e.customType === ENTRY && (e.data as { handoverFrom?: unknown }).handoverFrom === null), true, "told once: the successor forgets it");
	await look();
	await until(() => closed(m), "the old main quit and its pane closed");
	assert.equal(readEntries(join(world.stateDir, "board")).some((e) => e.session === "main-1"), false, "its board entry is cleared");
	assert.equal(successor.stopped, false, "the successor runs on");
});

test("a running subagent holds the close; its result goes to the successor quoted as the child's; the close follows once nothing runs", async () => {
	const { m, handoff, look } = await town();
	await m.tool("boss_handover", { handoff, reason: "rotate" });
	// A subagent that works: pi-herdr-agents' activity file under the old main's session artifacts, and a pane running the child.
	const dir = mkdtempSync(join(tmpdir(), "psb-rot-k-")), art = join(dir, "artifacts", "main1", "subagent-activity");
	mkdirSync(art, { recursive: true });
	writeFileSync(join(art, "kid1.json"), JSON.stringify({ phase: "working" }));
	world.herdr.pane("wA:p1").agent_session = { value: join(dir, "main_main1.jsonl") };
	world.herdr.addTab("wA:t55", "kid", "wA:p55");
	Object.assign(world.herdr.pane("wA:p55"), { agent: "pi", agent_session: { value: join(dir, "kid_kid1.jsonl") }, agent_status: "working" });
	await tellOld(successorOf());
	await look();
	assert.equal(m.stopped, false, "a subagent runs");
	world.broker.delivered.length = 0;
	await m.fire("message_end", { message: { role: "custom", customType: "subagent_result", content: [{ type: "text", text: "kid1: MP-5666 car ready on agent/mp-5666" }], display: true } });
	await world.quiet();
	const forwarded = world.broker.delivered.filter((d) => d.to === NEW.main);
	assert.equal(forwarded.length, 1);
	assert.match(forwarded[0]!.message, /a subagent's result reached box watch \(session main-1\) after you took over its work, so it is yours\. The child's result as it came, its words and not the boss's:\n«kid1: MP-5666 car ready on agent\/mp-5666»/);
	writeFileSync(join(art, "kid1.json"), JSON.stringify({ phase: "done" }));
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== "wA:p55");
	m.idle = false; // the turn the result started
	await look();
	assert.equal(m.stopped, false, "not while a turn runs");
	m.idle = true;
	await look();
	await until(() => closed(m), "closed once nothing runs");
});

test("still blocked 6 hours after the takeover: the tower hears it once, as blocked, and nothing closes", async () => {
	const { m, handoff, look, advance } = await town();
	await m.tool("boss_handover", { handoff, reason: "rotate" });
	await tellOld(successorOf());
	m.emit("monitor:started", { monitorId: "1", command: "npm test" });
	await look();
	advance(ROT_CAP_MS);
	world.broker.delivered.length = 0;
	await look();
	await look();
	const told = world.broker.delivered.filter((d) => d.to === "tower-wA");
	assert.equal(told.length, 1);
	assert.match(told[0]!.message, /why=blocked\]/);
	assert.match(told[0]!.message, /box watch \(session main-1\) handed over to session opened-wA:p101 6 h ago, which took over, and still cannot close itself: a background monitor is running\. sb waits no longer/);
	m.emit("monitor:finished", { monitorId: "1", status: "done", exitCode: 0 });
	await look();
	assert.equal(m.stopped, false, "it waits no longer: the tower or the boss closes it");
});

test("a coordinator that never handed over is unaffected: its idle nudge comes as before and nothing closes it", async () => {
	const { m, look, advance } = await town();
	await m.tool("boss_duty", { duty: "coordinator", reason: "back to work" });
	advance(31 * 60_000);
	await look();
	assert.equal(m.stopped, false);
	assert.equal(m.sent.filter((x) => x.customType === "straw-boss-wrap").length, 1, "the nudge");
	// A send to it by intercom from a session that is not its successor is no takeover.
	const other = world.agent({ id: "x-1", pane: "wA:p9", tab: "wA:t9" });
	await other.start();
	await tellOld(other);
	await look();
	assert.equal(m.stopped, false);
});
