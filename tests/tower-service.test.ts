import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { until, World } from "./fakes.ts";
import { TowerWorld } from "./tower-world.ts";
import { stop } from "../src/server/client.ts";
import { readRecord, slotOf, writeRecord } from "../src/server/record.ts";
import { ensureTowerVia, STOPPED } from "../src/server/towerclient.ts";
import { readQueue, readService } from "../src/server/towerstore.ts";
import { readTowerRuns, towerRunsEnabled } from "../src/server/towerruns.ts";

// The session side of the tower service (docs/specs/2026-10-26-sb-backend.md, A workspace gets one, Migration from resident towers, Restarts and upgrades): openTower asks the
// server, a resident tower of this build hands over, and the guard counts a tower identity as live through its own server's restart. The server in these tests is the real one
// (src/server/main.ts, in this process, with a fake Herdr and fake pi-intercom clients); the sessions are the fakes of tests/fakes.ts with a Herdr of their own.

let sw: TowerWorld, world: World, clock = 1_000_000;
beforeEach(() => {
	sw = new TowerWorld();
	sw.setFlag(true);
	world = new World();
	world.stateDir = sw.stateDir; // the sessions and the server share one state directory, as on a computer
	clock = 1_000_000;
});
afterEach(async () => {
	await world.stopAll();
	await sw.close();
});
/** The shell's environment as the sessions get it: the server world's, without the unset entries. */
const envOf = () => Object.fromEntries(Object.entries(sw.env).filter((e): e is [string, string] => e[1] !== undefined));
const server = () => ({ ctx: sw.ctx(), cli: "/fake/cli.mjs" });
const deps = { guardMs: 0, now: () => clock };
/** The deps of a resident tower that no server takes (the fake spawn fails, so the hand-over fails): it stays the workspace's tower, as the tests that need a live tower want. */
const resident = () => ({ server: { ctx: sw.ctx({ spawn: () => ({ pid: 99_999, exited: Promise.resolve(1) }) }), cli: "/fake/cli.mjs" } });

test("/boss tower with the flag on asks the server for the tower: the server makes the tab, and the session starts no pi and makes no tab", async () => {
	const a = world.agent({ id: "a", name: "docs", pane: "wA:p1", tab: "wA:t1", env: envOf(), deps: { server: server() } });
	await a.start();
	await a.command("tower");
	assert.deepEqual(world.herdr.commands("agent", "start"), [], "the session starts no tower");
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
	assert.deepEqual(sw.herdr.commands("tab", "create").length, 1, "the server made the tower tab");
	assert.deepEqual(sw.herdr.commands("agent", "start"), []);
	assert.equal(sw.herdr.workspace("wA").tokens.tower, "sb-tower-wa");
	assert.equal(a.notices.filter((n) => n.level === "error").length, 0, JSON.stringify(a.notices));
	assert.equal(readService(sw.slot, "wA")?.id, "sb-tower-wa");
});

test("/boss tower <prompt> (D15) ensures the tower, posts the prompt as a boss event, says it was handed over, and changes no focus; a bare /boss tower still focuses", async () => {
	const a = world.agent({ id: "a", name: "docs", pane: "wA:p1", tab: "wA:t1", env: envOf(), deps: { server: server() } });
	await a.start();
	await a.command("tower check the deploy of mp-3900 and tell me");
	assert.equal(sw.herdr.commands("tab", "create").length, 1, "the tower was ensured");
	assert.deepEqual(world.herdr.commands("tab", "focus"), [], "no focus change");
	const events = readQueue(sw.slot, "wA");
	assert.equal(events.length, 1);
	assert.equal(events[0]!.kind, "boss");
	assert.equal(events[0]!.text, "check the deploy of mp-3900 and tell me");
	assert.match(a.notices.map((n) => n.text).join("\n"), /Handed to the tower/);
	assert.equal(a.notices.filter((n) => n.level === "error").length, 0, JSON.stringify(a.notices));
});

test("/boss tower <prompt> with the flag off says what it needs and writes nothing", async () => {
	sw.setFlag(false);
	const a = world.agent({ id: "a", name: "docs", pane: "wA:p1", tab: "wA:t1", env: envOf(), deps: { server: server() } });
	await a.start();
	await a.command("tower do it");
	assert.match(a.notices.map((n) => n.text).join("\n"), /needs the tower runs/);
	assert.deepEqual(sw.running, []);
});

test("a live tower is the tower: a session does not ask the server for it", async () => {
	world.herdr.workspace("wA").tokens.tower = "tower-wA";
	await world.tower("tower-wA", "wA:t7", "wA:p7", false, resident()).start();
	const a = world.agent({ id: "a", name: "docs", pane: "wA:p1", tab: "wA:t1", env: envOf(), deps: { server: server() } });
	await a.start();
	await a.command("tower");
	assert.deepEqual(sw.running, [], "no server was started");
});

test("with the flag off a session opens the tower as before, and never asks the server", async () => {
	sw.setFlag(false);
	world.autoTowers();
	const a = world.agent({ id: "a", name: "docs", pane: "wA:p1", tab: "wA:t1", env: envOf(), deps: { server: server() } });
	await a.start();
	await a.command("tower");
	assert.equal(world.herdr.commands("agent", "start").length, 1);
	assert.deepEqual(sw.running, []);
});

test("ensureTowerVia: a server that is down is started for an automatic open, a stopped one is not, and the boss's own command starts it", async () => {
	const ask = { workspace: "wA" };
	const ctx = sw.ctx();
	const first = await ensureTowerVia(ctx, ask);
	assert.deepEqual({ id: first.id, opened: first.opened }, { id: "sb-tower-wa", opened: true }, "started the server and asked it");
	assert.equal(sw.running.length, 1);
	assert.equal((await stop(ctx)).outcome, "stopped");
	assert.equal(readRecord(sw.slot)?.stopped, true);
	await assert.rejects(ensureTowerVia(ctx, ask), { message: STOPPED });
	assert.equal(sw.running.length, 1, "a stopped server stays stopped for anything but the boss's command");
	const again = await ensureTowerVia(ctx, { ...ask, boss: true });
	assert.equal(again.id, "sb-tower-wa");
	assert.equal(readRecord(sw.slot)?.stopped, undefined);
	assert.equal(sw.running.length, 2);
});

test("ensureTowerVia gives the server's own words when it refuses", async () => {
	const ctx = sw.ctx();
	await ensureTowerVia(ctx, { workspace: "wA" });
	await assert.rejects(ensureTowerVia(ctx, { workspace: "nowhere" }), /No workspace matches "nowhere"/);
	sw.setFlag(false);
	await assert.rejects(ensureTowerVia(ctx, { workspace: "wA" }), /towerRuns\.enabled is off/);
});

test("a resident tower of this build hands its pane to the server at its start and quits, leaving the pane and clearing nothing", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7", false, { server: server() });
	sw.herdr.addTab("wA:t7", "work", "wA:p7", "pi"); // the same pane in the server's Herdr
	await tower.start();
	await until(() => tower.stopped, "the resident tower to quit");
	assert.equal(readService(sw.slot, "wA")?.pane, "wA:p7", "the server took the pane");
	assert.equal(sw.herdr.workspace("wA").tokens.tower, "sb-tower-wa");
	assert.equal(sw.herdr.pane("wA:p7").tokens.sb_role, "tower");
	assert.ok(!world.herdr.closed.includes("wA:p7"), "its pane stays");
	assert.deepEqual(world.herdr.commands("pane", "close"), []);
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined, "it published no token of its own");
	assert.ok(tower.notices.some((n) => /sb server stands in for this workspace's tower/.test(n.text)));
});

for (const how of ["undecided", "plain"] as const) {
	test(`B6 VM review RV7-F002: a /quit of a pi in a standing pane that never became a normal session (${how === "undecided" ? "the pane-role answer is still awaited" : "no answer came"}) leaves the server's pane open`, async () => {
		// STRAW_BOSS_ROLE=tower stays in a migrated standing pane's tab: the boss typed pi there, and the pane is the server's.
		let fail!: (cause: Error) => void;
		const hang = new Promise<never>((_resolve, reject) => (fail = reject));
		const pi = world.tower("tower-wA", "wA:t7", "wA:p7", false, { runSide: { ask: () => hang, exitWaitMs: 1 } });
		await pi.start();
		console.error("DBG", JSON.stringify(pi.notices), pi.stopped);
		await until(() => pi.notices.some((n) => /has not said yet whether this pane is the tower's/.test(n.text)), "the ask to pass its bound");
		if (how === "plain") fail(new Error("no server"));
		if (how === "plain") await until(() => pi.notices.some((n) => /did not answer, so this session stays a plain session/.test(n.text)), "the ask to end without an answer");
		await pi.stop("quit");
		await world.quiet();
		assert.deepEqual(world.herdr.commands("pane", "close"), [], "the standing pane is left as it was found");
	});
}

test("B6 VM review RV7-F005: a resident whose pane-role answer is late starts its tower session only when the answer is none: nothing is published before it, and the tower role is taken after it", async () => {
	let answer!: (reply: { ok: boolean; role: string }) => void;
	const gate = new Promise<{ ok: boolean; role: string }>((resolve) => (answer = resolve));
	sw.crashWith = 1; // no server can be started: the resident stays resident after its hand-over fails
	const pi = world.tower("tower-wA", "wA:t7", "wA:p7", false, { server: server(), runSide: { ask: () => gate } });
	await pi.start();
	await until(() => pi.notices.some((n) => /has not said yet whether this pane is the tower's/.test(n.text)), "the ask to pass its bound");
	await world.quiet();
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined, "undecided: the session start has not run, so no tower role is published");
	answer({ ok: true, role: "none" });
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-wA", "the session start to run after the late none");
	assert.equal(pi.stopped, false);
});

test("a resident tower the server cannot take stays resident, and says why", async () => {
	sw.crashWith = 1; // no server can be started
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7", false, { server: server() });
	await tower.start();
	assert.equal(tower.stopped, false);
	assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-wA", "it published as a tower always did");
	assert.ok(tower.notices.some((n) => /stays resident/.test(n.text)), JSON.stringify(tower.notices));
});

for (const reason of ["reload", "resume", "new", "fork"]) {
	test(`a live resident tower is retired by its own ${reason}: with the service on, session_start asks the server, which takes the pane, and the tower quits`, async () => {
		sw.setFlag(false);
		const tower = world.tower("tower-wA", "wA:t7", "wA:p7", false, { server: server() });
		sw.herdr.addTab("wA:t7", "work", "wA:p7", "pi");
		await tower.start();
		assert.equal(tower.stopped, false, "resident while the service is off");
		assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-wA");
		sw.setFlag(true);
		await tower.stop(reason); // pi ends the old session with this reason and starts the new one in the same process
		await tower.fire("session_start", { reason });
		await until(() => readService(sw.slot, "wA")?.pane === "wA:p7", `the server to take the pane on ${reason}`);
		await until(() => tower.notices.some((n) => /sb server stands in for this workspace's tower/.test(n.text)), "the resident tower to say it quits");
		assert.equal(sw.herdr.workspace("wA").tokens.tower, "sb-tower-wa");
		assert.deepEqual(world.herdr.commands("pane", "close"), [], "its pane stays");
	});
}

test("with the service on, call_tower and a broadcast to towers open no resident tower: the server stands in, and no pi starts in a tower tab", async () => {
	const main = world.agent({ id: "m", name: "docs", pane: "wA:p1", tab: "wA:t1", env: envOf(), deps: { server: server() } });
	await main.start();
	await main.promote();
	await main.tool("call_tower", { message: "status?", reply: false }).catch(() => undefined);
	await main.tool("boss_broadcast", { scope: "towers", message: "heads up" }).catch(() => undefined);
	await world.quiet();
	assert.deepEqual(world.herdr.commands("agent", "start"), [], "no pi started in this Herdr");
	assert.deepEqual(world.herdr.commands("tab", "create"), [], "and no tower tab made by the session");
	assert.deepEqual(sw.herdr.commands("agent", "start"), [], "the server starts no pi either, until an event wakes a run");
});

test("a towerRuns section without enabled, and no config file at all, mean the service is on; only an explicit false keeps towers resident", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-towerruns-"));
	try {
		assert.equal(towerRunsEnabled(dir), true, "no config.json");
		writeFileSync(join(dir, "config.json"), "{ not json");
		assert.equal(towerRunsEnabled(dir), true, "an unreadable config.json");
		writeFileSync(join(dir, "config.json"), JSON.stringify({ towerRuns: { max: 2 } }));
		assert.deepEqual(readTowerRuns(dir), { enabled: true, max: 2 });
		writeFileSync(join(dir, "config.json"), JSON.stringify({ towerRuns: { enabled: false } }));
		assert.equal(towerRunsEnabled(dir), false);
		writeFileSync(join(dir, "config.json"), JSON.stringify({ towerRuns: { enabled: "no" } }));
		assert.equal(towerRunsEnabled(dir), true, "only the boolean false turns it off");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("with the flag off a resident tower runs as before and asks nothing", async () => {
	sw.setFlag(false);
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7", false, { server: server() });
	await tower.start();
	assert.equal(tower.stopped, false);
	assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-wA");
	assert.deepEqual(sw.running, []);
});

// The guard: a workspace whose `tower` token names the server's identity counts as having a live tower while that server restarts (docs/specs/2026-10-26-sb-backend.md, Restarts and upgrades).
const restarting = (agentEnv: Record<string, string | undefined>, began: number, since = clock, id = "sb-tower-wa") => {
	const slot = slotOf(world.stateDir, agentEnv);
	writeRecord(slot, { pid: 7, version: "0.45.0", herdr: slot.herdr, mode: "detached", desk: false, intercom: {}, log: "/l", socket: "/nowhere", secret: "s".repeat(64), intercomId: "sb-server-x", restarting: { began: new Date(began).toISOString(), since: new Date(since).toISOString(), reason: "upgrade", by: "test" } });
	world.herdr.workspace("wA").tokens.tower = id;
	return slot;
};
async function mainUnder(token: string) {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { ...deps, guardMs: 50, server: server() } });
	await a.start();
	// A resident tower that no server takes: it stays the workspace's tower, which is what promotes the main.
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7", false, { ...deps, ...resident() });
	await tower.start();
	await until(() => world.herdr.pane("wA:p1").tokens.sb_role === "main", "a promoted");
	await tower.stop("new");
	clock += 61_000;
	return { a, token };
}
const role = () => world.herdr.pane("wA:p1").tokens.sb_role;
const ticks = async (n = 3) => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 70));
};

test("the guard keeps a main while its server's tower identity is covered by a fresh restart that began less than 30 s ago, and demotes it once the restart is stale or too old", async () => {
	const { a } = await mainUnder("sb-tower-wa");
	restarting(a.env!, clock - 5000);
	await ticks();
	clock += 14_000; // past the 15 s grace a missing tower gets, but inside the restart's 30 s
	restarting(a.env!, clock - 19_000);
	await ticks();
	assert.equal(role(), "main", "kept through the restart");
	// The restart went on past 30 s: the grace applies again.
	clock += 20_000;
	restarting(a.env!, clock - 39_000);
	await ticks(); // the grace of a missing tower starts when the guard first finds the tower missing
	assert.equal(role(), "main");
	clock += 16_000;
	await until(() => role() === "member", "demoted once the restart ran past 30 s and the grace is over");
});

test("a restart whose touches stopped (a stale since) covers nothing, and neither does another slot's identity", async () => {
	const { a } = await mainUnder("sb-tower-wa");
	restarting(a.env!, clock - 5000, clock - 12_000);
	clock += 16_000;
	restarting(a.env!, clock - 20_000, clock - 12_000);
	await until(() => role() === "member", "a stale restart covers no tower");
});

test("a secondary slot's identity (sb-tower-<slot8>-<ws>) is not covered by the primary slot's restart", async () => {
	const { a } = await mainUnder("x");
	restarting(a.env!, clock - 5000, clock, "sb-tower-deadbeef-wa");
	clock += 16_000;
	restarting(a.env!, clock - 6000, clock, "sb-tower-deadbeef-wa");
	await until(() => role() === "member", "only this Herdr's own identity is covered");
});

// --- the review of B4 (B4R-F002, F005, F008) --------------------------------------------------------------------------------------------------------------------------

test("B4R-F002: a hand-over whose first ask failed asks once more before the tower stays resident", async () => {
	let spawns = 0;
	const base = sw.ctx();
	const ctx = { ...base, spawn: (spec: Parameters<typeof base.spawn>[0]) => (spawns++ === 0 ? { pid: 99_999, exited: Promise.resolve(1) } : base.spawn(spec)) };
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7", false, { server: { ctx, cli: "/fake/cli.mjs" } });
	sw.herdr.addTab("wA:t7", "work", "wA:p7", "pi");
	await tower.start();
	await until(() => tower.stopped, "the resident tower to quit after the second ask");
	assert.ok(spawns >= 2, `the second ask started a server (${spawns})`);
	assert.equal(readService(sw.slot, "wA")?.pane, "wA:p7");
});

test("B4R-F005: a server on an older package is upgraded by the ask, and the ask goes to the new server's record", async () => {
	const first = await ensureTowerVia(sw.ctx({ version: "0.44.0" }), { workspace: "wA" });
	assert.equal(first.id, "sb-tower-wa");
	const upgraded = await ensureTowerVia(sw.ctx({ version: "0.45.0" }), { workspace: "wA" });
	assert.equal(upgraded.id, "sb-tower-wa");
	assert.equal(readRecord(sw.slot)?.version, "0.45.0");
	assert.equal(sw.running.length, 2);
});

test("B4R-F008: a server stopped on purpose is told once, by one notice", async () => {
	const ctx = sw.ctx();
	await ensureTowerVia(ctx, { workspace: "wA" });
	assert.equal((await stop(ctx)).outcome, "stopped");
	const a = world.agent({ id: "a", name: "docs", pane: "wA:p1", tab: "wA:t1", env: envOf(), deps: { server: server(), guardMs: 0, now: () => clock, autoTower: true } });
	await a.start();
	await a.command("promote").catch(() => {});
	await ticks(5);
	assert.equal(a.notices.filter((n) => /stopped on purpose/.test(n.text)).length, 1, JSON.stringify(a.notices));
});
