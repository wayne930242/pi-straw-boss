import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { AUTO_FILE, seal } from "../src/autostate.ts";
import { readEntries } from "../src/board.ts";
import { createRotationClose, ROT_CAP_MS } from "../src/rotclose.ts";
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
	// The sb server's watch list answers (none): one that does not answer holds the close (RV6-F001).
	const ask = async (r: Record<string, unknown>) => (r.cmd === "watch-list" ? { ok: true, watches: [] } : { ok: false, error: "not in this test" });
	const m = world.agent({ id: "main-1", name: "box watch", pane: "wA:p1", tab: "wA:t1", deps: { now: () => Date.now() + off, idleLook: (fn) => (looks.push(fn), () => {}), ask } });
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
const closing = () => world.herdr.calls.some((c) => c[1] === "report-metadata" && c[2] === "wA:p1" && c.includes("sb_closing=1"));
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
	await successor.fire("tool_result", { toolName: "intercom", toolCallId: "c", input: { action: "ask", to: "main-1", message: "where is the train record?" }, content: [], isError: false });
	await world.quiet();
	assert.equal(took(m), false, "a send to another session, one that failed, or an ask (a question before the takeover; RV6-F004) is no takeover");
	await m.tool("board_set", { now: "minding the box", items: [{ t: "watch", done: false }] });
	assert.equal(readEntries(join(world.stateDir, "board")).some((e) => e.session === "main-1"), true);
	const { readHolds, setHold } = await import("../src/link/holds.ts"), linkDir = join(world.stateDir, "link");
	setHold(linkDir, Date.now(), { team: "0f".repeat(16), device: "a".repeat(26), session: "main-1", since: 5 });
	await tellOld(successor);
	assert.equal(took(m), true);
	assert.deepEqual(readHolds(linkDir, Date.now()).holds.map((h) => [h.session, h.since]), [[successor.id, 5]], "the boxes it held are the successor's (docs/specs/2026-11-26-device-hold.md)");
	assert.equal(successor.entries.some((e) => e.customType === ENTRY && (e.data as { handoverFrom?: unknown }).handoverFrom === null), true, "told once: the successor forgets it");
	await look();
	await until(() => closed(m), "the old main quit and its pane closed");
	assert.equal(readEntries(join(world.stateDir, "board")).some((e) => e.session === "main-1"), false, "its board entry is cleared");
	assert.equal(successor.stopped, false, "the successor runs on");
});

test("the successor's call_peer to its caller, the old main, is its takeover too; a call_peer ask, or one to another session, is not", async () => {
	const { m, handoff } = await town();
	await m.tool("boss_handover", { handoff, reason: "rotate" });
	const successor = successorOf();
	const sent = (await successor.tool("call_peer", { to: "caller", message: "took over" })) as { content: unknown[]; details: { id: string } };
	assert.equal(sent.details.id, "main-1", "the caller of a successor is the main that handed over");
	const result = async (input: Record<string, unknown>, details: unknown) => (await successor.fire("tool_result", { toolName: "call_peer", toolCallId: "c", input, content: [], details, isError: false }), await world.quiet());
	await result({ to: "caller", ask: true, message: "where?" }, sent.details);
	await result({ to: "sender", message: "x" }, { id: "someone-else" });
	assert.equal(took(m), false);
	await result({ to: "caller", message: "took over" }, sent.details);
	assert.equal(took(m), true);
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
	world.herdr.failPanes = true; // RV6-F001: a pane list that fails says nothing of the subagent: no close
	await look();
	await world.quiet();
	assert.equal(closing(), false, "a failed read is no proof that nothing runs");
	world.herdr.failPanes = false;
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

test("a took-over from a session that is not the successor is refused, and the boss's reopen of the old session is never closed by it", async () => {
	const { m, handoff, look } = await town();
	await m.tool("boss_handover", { handoff, reason: "rotate" });
	// A session that claims to be a successor of main-1: its extension sends took-over, and main-1 refuses it.
	const forger = world.agent({ id: "x-1", pane: "wA:p9", tab: "wA:t9", entries: [{ customType: ENTRY, data: { handoverFrom: "main-1" } }] });
	await forger.start();
	await tellOld(forger);
	assert.equal(took(m), false, "only the successor its own entry names");
	await tellOld(successorOf());
	assert.equal(took(m), true);
	// RV6-F003: the old file opened again by the boss (`pi --session`, a fork, a resume) is his session: it starts with took in its entries and is never closed by this.
	const looks: (() => Promise<void>)[] = [];
	const ask = async (r: Record<string, unknown>) => (r.cmd === "watch-list" ? { ok: true, watches: [] } : { ok: false, error: "not in this test" });
	const again = world.agent({ id: "main-1b", name: "box watch", pane: "wA:p3", tab: "wA:t3", entries: m.entries.filter((e) => e.customType === ENTRY), deps: { idleLook: (fn) => (looks.push(fn), () => {}), ask } });
	await again.start();
	await again.promote();
	await looks.at(-1)!();
	await settle();
	assert.equal(again.stopped, false);
	// The old main's own /reload keeps it armed.
	await m.fire("session_start", { reason: "reload" });
	await world.quiet();
	await look();
	await until(() => closed(m), "the reloaded old main closes");
});

test("RV6-F002: the successor's send in a teammate's turn is no takeover", async () => {
	const handlers = new Map<string, (event: unknown) => void>(), notified: string[] = [];
	const s = { saved: { handoverFrom: "main-1" } as Record<string, unknown>, remoteOrigin: undefined as string | undefined, isTower: false, closing: undefined, ownName: "" };
	const pi = { on: (type: string, h: (event: unknown) => void) => void handlers.set(type, h), appendEntry: () => {}, getSessionName: () => "box watch" };
	let remote = true;
	createRotationClose({ pi, cfg: { now: Date.now }, s, me: () => "succ" } as never, { control: { register() {}, onTook() {}, notify: async (to: string) => (notified.push(to), true) } as never, running: async () => [], reach: {} as never, boardFill: { clear() {} }, closeSelf: () => undefined, remote: () => remote });
	const send = async () => (handlers.get("tool_result")!({ toolName: "intercom", input: { action: "send", to: "main-1" }, isError: false }), await settle());
	await send();
	s.remoteOrigin = "link:bob";
	remote = false;
	await send();
	assert.deepEqual(notified, [], "a remote turn, by the link's scope or the session's origin");
	s.remoteOrigin = undefined;
	await send();
	assert.deepEqual(notified, ["main-1"], "its own turn");
});
