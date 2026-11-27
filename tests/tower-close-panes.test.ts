import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTROL, remoteCloseTarget } from "../src/closemain.ts";
import { createDeadPanes } from "../src/deadpane.ts";
import { createRemoteTurns } from "../src/link/hooks.ts";
import { MESSAGE_TYPE } from "../src/link/turn.ts";
import { ledgerPath } from "../src/revive.ts";
import { recordPath } from "../src/roles.ts";
import { runTool, type ToolHost } from "../src/server/runtools.ts";
import { type Agent, until, World } from "./fakes.ts";
import { bob, TEAM_HEX } from "./link/holder-world.ts";

// The tower closes agent panes (docs/specs/2026-11-23-tower-close-panes.md): a main that handed over once its successor is live, whoever opened it, and a dead agent pane of its workspace (sb or pi marks, no pi,
// no broker session, a bare shell). The refusals of a live main the boss opened and of a standing main stay.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");
const NEW = { tab: "wA:t100", pane: "wA:p101", main: "opened-wA:p101" };

/** Alpha has a tower and a main the boss opened (standing, with a session file); Beta has a tower and a main. */
async function town() {
	world.autoMains();
	world.herdr.shellPids = true; // process-info answers as on macOS: the shell's pid and the foreground
	const towerA = world.tower("tower-wA", "wA:t7", "wA:p7");
	const towerB = world.tower("tower-wB", "wB:t7", "wB:p7");
	const m = world.agent({ id: "main-1", name: "box watch", pane: "wA:p1", tab: "wA:t1" });
	m.file = join(mkdtempSync(join(tmpdir(), "psb-close-s-")), "2026-11-23T00-00-00-000Z_main-1.jsonl");
	const b1 = world.agent({ id: "b1", name: "ops-main", pane: "wB:p1", tab: "wB:t1" });
	await Promise.all(world.agents.map((a) => a.start()));
	for (const a of [m, b1]) await a.promote();
	await m.tool("boss_duty", { duty: "standing", reason: "it minds the box" });
	world.herdr.pane("wA:p1").agent_status = "idle";
	const handoff = join(mkdtempSync(join(tmpdir(), "psb-close-h-")), "handoff-box-watch.md");
	writeFileSync(handoff, "# Handoff\n- goal: mind the box\n");
	world.broker.delivered.length = 0;
	return { towerA, towerB, m, b1, handoff };
}
const handOver = async (m: Agent, handoff: string) => {
	const result = await m.tool("boss_handover", { handoff, reason: "pi-session-doctor measured repeated stalls" });
	world.herdr.pane("wA:p1").agent_status = "idle";
	return result;
};
const closeAsks = () => world.broker.published.filter((p) => (p.payload as { type?: string }).type === "close-main").length;

// --- case 1: a main that handed over --------------------------------------------------------------------------------------------------------------------

test("the tower closes a main the boss opened once it handed over and its successor is live; the old main ran its own check and quit", async () => {
	const { towerA, m, handoff } = await town();
	await handOver(m, handoff);
	const result = await towerA.tool("boss_close_main", { main: "main-1" });
	await until(() => m.stopped && world.herdr.closed.includes("wA:p1"), "the old main quit and its pane closed");
	assert.match(textOf(result), /quit|shutting down/);
	const successor = world.agents.find((a) => a.id === NEW.main)!;
	assert.equal(successor.stopped, false, "the successor runs on");
});

test("the tower refuses a handed-over main while its successor is not live, and asks it nothing", async () => {
	const { towerA, m, handoff } = await town();
	await handOver(m, handoff);
	await world.agents.find((a) => a.id === NEW.main)!.stop("quit");
	world.herdr.pane(NEW.pane).agent = undefined;
	await assert.rejects(towerA.tool("boss_close_main", { main: "main-1" }), /box watch handed over to session opened-w\S* \(tab wA:t100\), which is not live/);
	assert.equal(closeAsks(), 0);
	assert.equal(m.stopped, false);
});

test("a handed-over main still refuses a close asked by another workspace's tower", async () => {
	const { m, handoff } = await town();
	await handOver(m, handoff);
	world.broker.published.length = 0;
	const reg = m.regs.get("straw-boss/control");
	assert.ok(reg, "a main that handed over listens on the control channel");
	reg!.onEvent({ type: "message", fromSessionId: "tower-wB", payload: { version: 1, type: "close-main", to: "main-1", reqId: "r1" } });
	await until(() => world.broker.published.some((p) => (p.payload as { type?: string }).type === "close-main-result"), "the answer");
	const answer = world.broker.published.map((p) => p.payload as { type: string; accepted: boolean; reason?: string }).find((p) => p.type === "close-main-result")!;
	assert.equal(answer.accepted, false);
	assert.match(answer.reason!, /not from the tower of this workspace/);
	assert.equal(m.stopped, false);
});

// --- case 3: the refusals that stay ---------------------------------------------------------------------------------------------------------------------

test("a live main the boss opened that has not handed over, and a standing main that has not, are still refused with the same words", async () => {
	const { towerA, m } = await town();
	await assert.rejects(towerA.tool("boss_close_main", { main: "main-1" }), /box watch is a standing main: it has no end and sends no done report, so only the boss closes it/);
	await m.tool("boss_duty", { duty: "coordinator", reason: "back to plain work" });
	await world.quiet();
	await assert.rejects(towerA.tool("boss_close_main", { main: "main-1" }), /box watch was not opened by a tower \(the boss opened it\), so only the boss closes it/);
	assert.equal(closeAsks(), 0);
	assert.equal(m.stopped, false);
});

// --- case 5: the tower hears of the handover ------------------------------------------------------------------------------------------------------------

test("when the successor takes the handoff, the old main's workspace tower gets a milestone notice naming both, and the result says the tower closes the old main", async () => {
	const { m, handoff } = await town();
	const result = await handOver(m, handoff);
	const told = world.broker.delivered.filter((d) => d.to === "tower-wA");
	assert.equal(told.length, 1);
	assert.match(told[0]!.message, /^\[straw net from="box watch" id=main-1 role=main workspace=Alpha kind=call_tower scope=tower to="tower · tower-wA \(tower of Alpha\)" reply=none why=milestone handed-to=opened-wA:p101\]/, "the header names the successor: the tower's gate queues the notice (quiet-F007)");
	assert.match(told[0]!.message, /box watch \(session main-1\) handed over to its successor in tab wA:t100 \(session opened-wA:p101\)/);
	assert.match(told[0]!.message, /boss_close_main with main "main-1"/);
	assert.equal(world.broker.delivered.filter((d) => d.to === "tower-wB").length, 0, "another workspace's tower hears nothing");
	assert.match(textOf(result), /sb then closes this session and its pane once nothing of yours runs .* \(your workspace's tower was told too\)/);
});

// --- case 2: a dead agent pane --------------------------------------------------------------------------------------------------------------------------

/** A pane whose pi is gone: the marks it left, no pi, no broker session, the shell alone in its foreground. */
const deadPane = (tab: string, pane: string, tokens: Record<string, string>, label = "dead") => {
	if (!world.herdr.tabs.some((t) => t.tab_id === tab)) world.herdr.addTab(tab, label, undefined);
	world.herdr.addPane(pane, tab, undefined as never);
	Object.assign(world.herdr.pane(pane), { agent: undefined, agent_status: undefined, tokens: { ...tokens } });
};

test("the tower closes a dead agent pane (sb marks, no pi): the pane alone, never its tab; Herdr closes a tab its last pane leaves", async () => {
	const { towerA } = await town();
	deadPane("wA:t40", "wA:p40", { sb_role: "main", sb_duty: "coordinator", sb_main_tab: "old work" });
	deadPane("wA:t41", "wA:p41", { piha_delegated_v1: "live", sb_name: "kid-review" });
	world.herdr.addPane("wA:p42", "wA:t41", "shell"); // the boss's own shell beside it
	world.herdr.pane("wA:p42").agent = undefined;
	const listed = textOf(await towerA.tool("boss_close_main", {}));
	assert.match(listed, /wA:p40/);
	assert.match(listed, /wA:p41/);
	assert.doesNotMatch(listed, /wA:p42|wA:p1\b|wA:p7/);
	const one = await towerA.tool("boss_close_main", { pane: "wA:p40" });
	assert.deepEqual(world.herdr.commands("pane", "close").map((c) => c[2]), ["wA:p40"], "the pane alone is closed");
	assert.ok(!world.herdr.tabs.some((t) => t.tab_id === "wA:t40"), "Herdr closed the emptied tab");
	assert.match(textOf(one), /Closed pane wA:p40 .*its tab wA:t40 closes with it/);
	const two = await towerA.tool("boss_close_main", { pane: "wA:p41" });
	assert.deepEqual(world.herdr.commands("pane", "close").map((c) => c[2]), ["wA:p40", "wA:p41"]);
	assert.deepEqual(world.herdr.commands("tab", "close"), [], "no tab is closed by sb");
	assert.ok(world.herdr.tabs.some((t) => t.tab_id === "wA:t41"), "the tab with another pane stays");
	assert.ok(world.herdr.panes.some((p) => p.pane_id === "wA:p42"));
	assert.match(textOf(two), /Closed pane wA:p41/);
});

test("the tower refuses a pane with a live pi, its own pane, a pane of another workspace, a pane mid-revive, and a pane no agent marked", async () => {
	const { towerA } = await town();
	const closes = () => world.herdr.commands("pane", "close").length + world.herdr.commands("tab", "close").length;
	// A live pi: the broker lists it.
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wA:p1" }), /wA:p1 is not dead: a live session \(box watch\) is at it/);
	// A pi whose process runs but which the broker does not list (starting, or stuck).
	deadPane("wA:t43", "wA:p43", { sb_role: "member" });
	world.herdr.pane("wA:p43").processes = [{ pid: 4242, name: "node", argv0: "node" }];
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wA:p43" }), /wA:p43 is not at a bare shell: node runs in it/);
	// The tower's own pane, and a tower's pane at its shell between runs.
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wA:p7" }), /wA:p7 is a tower's pane/);
	// Another workspace.
	deadPane("wB:t40", "wB:p40", { sb_role: "main" });
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wB:p40" }), /wB:p40 is not in this workspace/);
	// Mid-revive or mid-open: the one-time claim waits in the pane.
	deadPane("wA:t44", "wA:p44", { sb_open_main: "1", sb_revive: "k".repeat(32) });
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wA:p44" }), /wA:p44 is being opened right now/);
	// A revive holds the lock of the session the pane last ran.
	deadPane("wA:t45", "wA:p45", { sb_role: "main" });
	const file = join(mkdtempSync(join(tmpdir(), "psb-close-r-")), "2026-11-23T00-00-00-000Z_dead-1.jsonl");
	mkdirSync(dirname(recordPath(world.stateDir, file)), { recursive: true });
	writeFileSync(recordPath(world.stateDir, file), JSON.stringify({ role: "main", pane: "wA:p45", tab: "wA:t45", workspace: "wA", file, at: Date.now() }));
	mkdirSync(dirname(ledgerPath(world.stateDir, file)), { recursive: true });
	writeFileSync(`${ledgerPath(world.stateDir, file)}.lock`, String(process.pid));
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wA:p45" }), /wA:p45 is being revived right now/);
	// A plain shell no agent ever marked.
	world.herdr.addTab("wA:t46", "shell", "wA:p46", "shell");
	Object.assign(world.herdr.pane("wA:p46"), { agent: undefined, tokens: {} });
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wA:p46" }), /wA:p46 carries no mark of an agent/);
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wA:p99" }), /No pane wA:p99/);
	await assert.rejects(towerA.tool("boss_close_main", { main: "main-1", pane: "wA:p40" }), /main or pane, not both/);
	assert.equal(closes(), 0, "nothing closed");
});

// --- the run's side: the same tool through the server ----------------------------------------------------------------------------------------------------

test("a tower run's boss_close_main takes pane and lists dead panes through the server's tower; an ally run is refused both", async () => {
	const calls: string[] = [];
	const host = {
		reach: { read: async () => ({ sessions: [], ps: [] }) },
		closeMain: async (q: string) => (calls.push(`main ${q}`), { text: "closed", main: q }),
		closePane: async (p: string) => (calls.push(`pane ${p}`), { text: `Closed pane ${p}.`, pane: p }),
		deadPanes: async () => (calls.push("list"), [{ pane: "wA:p40", tab: "wA:t40", what: "main old work", alone: true }]),
		allow: async () => ({ ok: true }),
		who: { device: "d".repeat(26), team: "1".repeat(32), level: "dispatch", pane: "px" },
		openedFor: () => "d".repeat(26),
	} as unknown as ToolHost;
	assert.equal((await runTool(host, "local", "boss_close_main", { pane: "wA:p40" })).text, "Closed pane wA:p40.");
	assert.match((await runTool(host, "local", "boss_close_main", {})).text, /- wA:p40 \(tab wA:t40, its only pane\): main old work/);
	assert.deepEqual(calls, ["pane wA:p40", "list"]);
	await assert.rejects(runTool(host, "ally", "boss_close_main", { pane: "wA:p40" }, { toolCallId: "c1" }), /An ally run closes only a main opened for its own device/);
	assert.deepEqual(calls, ["pane wA:p40", "list"], "the ally run reached nothing");
});

// --- fix round (close-review.md) ----------------------------------------------------------------------------------------------------------------------------

test("CLR-F001: a pane Herdr reports an agent in is not dead, though no broker session is at it and its foreground is the shell", async () => {
	const { towerA } = await town();
	deadPane("wA:t47", "wA:p47", { sb_role: "main" });
	world.herdr.pane("wA:p47").agent = "pi"; // a pi that has not joined the broker, or lost it
	await assert.rejects(towerA.tool("boss_close_main", { pane: "wA:p47" }), /wA:p47 runs pi, so it is not dead/);
	assert.doesNotMatch(textOf(await towerA.tool("boss_close_main", {})), /wA:p47/);
	assert.equal(world.herdr.commands("pane", "close").length + world.herdr.commands("tab", "close").length, 0);
});

test("CLR-F001: on Windows no dead pane is listed or closed, before Herdr is asked anything: process-info there cannot prove a bare shell", async () => {
	const asked: string[][] = [];
	const dead = createDeadPanes({ run: async (args) => (asked.push(args), "{}"), sessions: async () => [], here: () => ({ workspace: "wA", pane: "wA:p7" }), stateDir: mkdtempSync(join(tmpdir(), "psb-close-w-")), now: Date.now, platform: "win32" });
	await assert.rejects(dead.list(), /macOS and Linux only/);
	await assert.rejects(dead.close("wA:p40"), /macOS and Linux only/);
	assert.deepEqual(asked, []);
});

test("CLR-F002: a remote turn of a pi tower closes only a main opened for its senders' device: no dead pane, no list, no main the boss opened though it handed over", () => {
	const net = {
		sessions: [{ id: "peer-1", name: "peer work", herdrLocation: { paneId: "wA:p5" } }, { id: "main-1", name: "box watch", herdrLocation: { paneId: "wA:p1" } }],
		ps: [{ pane_id: "wA:p5", tokens: { sb_opened_by: "link:DEVICE01" } }, { pane_id: "wA:p1", tokens: {} as Record<string, string> }],
	};
	assert.throws(() => remoteCloseTarget(net, { pane: "wA:p40" }, ["DEVICE01"]), /dead panes and their list are the local tower's/);
	assert.throws(() => remoteCloseTarget(net, {}, ["DEVICE01"]), /dead panes and their list are the local tower's/);
	assert.throws(() => remoteCloseTarget(net, { main: "main-1" }, ["DEVICE01"]), /main-1 was not opened for the device of this remote turn/);
	assert.throws(() => remoteCloseTarget(net, { main: "peer work" }, ["DEVICE02"]), /was not opened for the device/);
	assert.throws(() => remoteCloseTarget(net, { main: "peer work" }, ["DEVICE01", "DEVICE02"]), /was not opened for the device/, "every sender's device must be the one it was opened for");
	assert.throws(() => remoteCloseTarget(net, { main: "peer work" }, []), /was not opened for the device/);
	assert.equal(remoteCloseTarget(net, { main: "peer work" }, ["DEVICE01"]), "peer-1");
});

test("CLR-F002: the remote-turn hook refuses a dead pane and the list before any gate, whatever the sender's level", async () => {
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const root = mkdtempSync(join(tmpdir(), "psb-close-remote-"));
	const pi = { events: { on: () => () => {}, emit: () => {} }, on: (t: string, h: (e: unknown, ctx: unknown) => unknown) => void handlers.set(t, h) } as unknown as ExtensionAPI;
	const turns = createRemoteTurns({
		pi, now: Date.now, config: () => ({ teams: new Map([[TEAM_HEX, { project: root, share: "status" as const, name: "t" }]]), trust: new Map([[bob.id, "dispatch" as const]]), problems: [] }),
		policy: { read: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } }, home: root, agentDir: root, linkDir: root, gateMs: 40,
		setOrigin: () => {}, tower: () => "tower", log: () => {}, tell: () => {}, ask: async () => ({ ok: false, error: "none" }),
	});
	const call = (input: Record<string, unknown>) => handlers.get("tool_call")!({ toolName: "boss_close_main", toolCallId: "c", input }, { cwd: root, hasUI: false }) as Promise<{ block?: boolean; reason?: string } | undefined>;
	assert.equal(await call({}), undefined, "a local turn is let through");
	handlers.get("message_start")!({ message: { role: "custom", customType: MESSAGE_TYPE, details: { id: bob.id.padStart(32, "0"), team: TEAM_HEX, from: bob.id, label: "bob", short: bob.id.slice(0, 6) } } }, {});
	for (const input of [{}, { pane: "wA:p40" }]) assert.match(String((await call(input))?.reason), /dead panes and their list are the local tower's/);
	assert.equal(await call({ main: "peer work" }), undefined, "a main goes on to the tool's own check (dispatch: no gate)");
	assert.deepEqual(turns.scope()?.devices, [bob.id], "the tool learns the senders' devices");
});

test("CLR-F004: a handed-over main started anew with `pi --session` registers no control channel; a /reload of it does", async () => {
	const { m, handoff } = await town();
	await handOver(m, handoff);
	await m.stop("reload");
	for (const reason of ["startup", "reload"] as const) {
		const again = world.agent({ id: `main-1-${reason}`, name: "box watch", pane: "wA:p1", tab: "wA:t1", entries: m.entries });
		await again.fire("session_start", { reason });
		await world.quiet();
		assert.equal(world.broker.registrations.some((r) => r.id === again.id && r.namespace === CONTROL), reason === "reload", reason);
		await again.stop("reload");
	}
});
