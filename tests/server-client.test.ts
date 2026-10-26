import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { decide, ensure, intercomOf, launch, lockWaitFor, probe, restart, sameBroker, serverEnv, ServerError, SPAWN_OPTIONS, stateOf, stop, takeOver, timersFor } from "../src/server/client.ts";
import { fileOf, readLock, readRecord, readStartError, type ServerRecord, takeLock, writeRecord, writeStartError } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { ServerWorld, sleep, until } from "./server-world.ts";

// What reaches the server from outside (docs/specs/2026-10-26-sb-backend.md, Starting, Stopping, Restarts and upgrades): liveness, the session look's rules, the start, the
// restart path, the stop, and the version rules.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());

const record = (over: Partial<ServerRecord> = {}): ServerRecord => ({
	pid: 7, started: "T-7", version: "0.44.0", herdr: world.slot.herdr, mode: "detached", desk: false, intercom: { transport: "default" }, log: "/l", socket: "/nowhere.sock", secret: "s".repeat(64), intercomId: "sb-server-00000000", ...over,
});
const plant = (over: Partial<ServerRecord> = {}) => (mkdirSync(world.slot.dir, { recursive: true }), writeRecord(world.slot, record(over)));
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");

// --- liveness ---

test("a server is live when its pid runs, started when the record says, and answers hello: a dead pid, a reused pid, and a pid that does not answer are not", async () => {
	assert.equal((await probe(world.ctx())).live, false, "no record");
	const s = await world.start();
	await s.handle.ready;
	assert.equal((await probe(world.ctx())).live, true);
	assert.equal((await probe(world.ctx({ startOf: () => "T-other" }))).live, false, "the pid now belongs to a process that started at another time");
	assert.equal((await probe(world.ctx({ startOf: () => `T-${s.pid}` }))).live, true);
	assert.equal((await probe(world.ctx({ startOf: () => undefined }))).live, true, "when ps cannot say the record stands");
	world.live.delete(s.pid);
	assert.equal((await probe(world.ctx())).live, false, "dead pid");
	world.live.add(s.pid);
	plant({ pid: s.pid, socket: world.record()!.socket, secret: "0".repeat(64), started: `T-${s.pid}` });
	assert.equal((await probe(world.ctx())).live, false, "alive pid whose socket refuses its secret");
});

test("stateOf gives each state a shell sees: live, restarting, stopped, gone", async () => {
	const ctx = world.ctx();
	assert.equal(stateOf(ctx, { record: undefined, live: false }), "gone");
	const s = await world.start();
	await s.handle.ready;
	assert.equal(stateOf(ctx, await probe(ctx)), "live");
	const fresh = { began: new Date().toISOString(), since: new Date().toISOString(), reason: "r", by: "b" };
	assert.equal(stateOf(ctx, { record: record({ restarting: fresh }), live: false }), "restarting");
	assert.equal(stateOf(ctx, { record: record({ restarting: { ...fresh, since: new Date(Date.now() - 11_000).toISOString() } }), live: false }), "gone", "no touch for 10 s: gone");
	assert.equal(stateOf(ctx, { record: record({ stopped: true }), live: false }), "stopped");
	assert.equal(stateOf(ctx, { record: record(), live: false }), "gone");
});

// --- the session look ---

const look = (over: Partial<Parameters<typeof decide>[0]> = {}, seen: Parameters<typeof decide>[1] = { record: undefined, live: false }) =>
	decide({ version: "0.44.0", env: {}, platform: "linux", now: () => Date.now(), slot: world.slot, ...over }, seen);

test("a session starts a server only when none is live, none is stopped on purpose, no fresh restarting is there, its package is not older, and its broker is the record's", () => {
	assert.deepEqual(look(), { do: "start" });
	assert.deepEqual(look({}, { record: record(), live: false }), { do: "start" });
	assert.deepEqual(look({}, { record: record(), live: true }), { do: "nothing", why: "live" });
	assert.deepEqual(look({}, { record: record({ stopped: true }), live: false }), { do: "nothing", why: "stopped" });
	const fresh = { began: new Date().toISOString(), since: new Date().toISOString(), reason: "r", by: "b" };
	assert.deepEqual(look({}, { record: record({ restarting: fresh }), live: false }), { do: "nothing", why: "restarting" });
	assert.deepEqual(look({}, { record: record({ restarting: { ...fresh, since: new Date(Date.now() - 11_000).toISOString() } }), live: false }), { do: "start" }, "a stale restarting counts as gone");
});

test("a session on an older package never starts a server, and never downgrades a live one; a newer one upgrades it", () => {
	const older = look({ version: "0.43.0" }, { record: record({ version: "0.44.0" }), live: false });
	assert.equal(older.do, "refuse");
	assert.equal(older.do === "refuse" && older.why, "older");
	assert.deepEqual(look({ version: "0.43.0" }, { record: record({ version: "0.44.0" }), live: true }), { do: "nothing", why: "live" });
	assert.deepEqual(look({ version: "0.45.0" }, { record: record({ version: "0.44.0" }), live: true }), { do: "upgrade" });
	assert.deepEqual(look({ version: "0.45.0" }, { record: record({ version: "0.44.0" }), live: false }), { do: "start" });
});

test("a session on another broker scope or transport uses no server; one on the record's, or with no record, does", () => {
	const scoped = record({ intercom: { scope: "team-a", transport: "default" } });
	const other = look({ env: { PI_INTERCOM_SCOPE_ID: "team-b" } }, { record: scoped, live: true });
	assert.equal(other.do === "refuse" && other.why, "scope");
	assert.deepEqual(look({ env: { PI_INTERCOM_SCOPE_ID: "team-a" } }, { record: scoped, live: true }), { do: "nothing", why: "live" });
	assert.equal(look({ env: {} }, { record: scoped, live: false }).do, "refuse");
	assert.deepEqual(look({ env: { PI_INTERCOM_SCOPE_ID: "anything" } }), { do: "start" }, "no record: the first session defines it");
	const tcp = look({ env: { PI_INTERCOM_TRANSPORT: "tcp" }, platform: "win32" }, { record: record(), live: true });
	assert.equal(tcp.do === "refuse" && tcp.why, "scope");
	assert.equal(intercomOf({ PI_INTERCOM_TCP: "1" }, "win32").transport, "tcp", "the legacy opt-in");
	assert.equal(intercomOf({ PI_INTERCOM_TCP: "1" }, "linux").transport, "default");
	assert.ok(sameBroker(intercomOf({ PI_INTERCOM_SCOPE_ID: " a " }), { scope: "a", transport: "default" }));
});

test("a record that names another Herdr socket than the slot's is refused by the look", () => {
	const other = look({}, { record: record({ herdr: "/elsewhere.sock" }), live: false });
	assert.equal(other.do === "refuse" && other.why, "herdr");
});

// --- the detached start ---

test("the detached spawn: detached, no stdio, windowsHide; the starter's own identity stripped, the broker scope and transport kept; cwd the slot's folder", async () => {
	const env = {
		...world.env, PI_INTERCOM_SESSION_ID: "me", PI_INTERCOM_STABLE_ID: "stable", PI_SUBAGENT_ID: "sub", PI_SUBAGENT_X: "y", STRAW_BOSS_ROLE: "tower", HERDR_PANE_ID: "p1", HERDR_TAB_ID: "t1", HERDR_WORKSPACE_ID: "w1",
		PI_INTERCOM_SCOPE_ID: "team-a", PI_INTERCOM_TRANSPORT: "tcp", PI_INTERCOM_TCP: "1", HERDR_SOCKET_PATH: "/my/herdr.sock", STRAW_BOSS_DESK: "1",
	};
	assert.deepEqual(SPAWN_OPTIONS, { detached: true, stdio: "ignore", windowsHide: true });
	const slot = world.ctx({ env }).slot;
	const ctx = world.ctx({ env, slot, by: 'session "main" (3f2a1b9c)' });
	const outcome = await ensure(ctx);
	assert.ok("record" in outcome);
	const spec = world.spawned[0]!;
	assert.deepEqual(spec.options, { detached: true, stdio: "ignore", windowsHide: true });
	assert.deepEqual(spec.args, ["/fake/cli.mjs", "run", "--detached", "--by", 'session "main" (3f2a1b9c)']);
	assert.equal(spec.cwd, slot.dir);
	for (const gone of ["PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID", "PI_SUBAGENT_ID", "PI_SUBAGENT_X", "STRAW_BOSS_ROLE", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) assert.ok(!(gone in spec.env), gone);
	for (const kept of ["PI_INTERCOM_SCOPE_ID", "PI_INTERCOM_TRANSPORT", "PI_INTERCOM_TCP", "PI_CODING_AGENT_DIR", "HERDR_SOCKET_PATH", "STRAW_BOSS_DESK"]) assert.ok(kept in spec.env, kept);
	assert.deepEqual(serverEnv({ A: "1", PI_INTERCOM_SESSION_ID: "x" }), { A: "1" });
});

test("two starts at once start one server: the lock turns the second away, which finds the first's server on its next look", async () => {
	world.connectMs = 250;
	const [a, b] = await Promise.allSettled([ensure(world.ctx({ by: "a" }), { lockWaitMs: 0 }), (async () => (await sleep(20), ensure(world.ctx({ by: "b" }), { lockWaitMs: 0 })))()]);
	assert.equal(a.status, "fulfilled");
	assert.equal(b.status, "rejected");
	assert.ok(b.status === "rejected" && b.reason instanceof ServerError && b.reason.code === "busy");
	assert.equal(world.spawned.length, 1);
	assert.equal(existsSync(fileOf(world.slot, "lock")), false, "the lock is released once the server answers hello");
	const again = await ensure(world.ctx({ by: "b" }));
	assert.ok("server" in again && again.server === "found");
	assert.equal(world.spawned.length, 1);
});

test("the starter holds server.lock until the new server answers hello, however long that takes, and a slow server is not raced", async () => {
	world.connectMs = 600;
	const first = ensure(world.ctx({ by: "slow starter" }));
	await until(() => readLock(world.slot), "the lock");
	assert.equal(readLock(world.slot)?.by, "slow starter");
	await sleep(300);
	assert.equal(readLock(world.slot)?.by, "slow starter", "still held while the server starts");
	await assert.rejects(ensure(world.ctx({ by: "racer" })), (e: unknown) => e instanceof ServerError && e.code === "busy");
	const done = await first;
	assert.ok("server" in done && done.server === "started");
	assert.equal(readLock(world.slot), undefined);
});

test("start-error.json of an earlier attempt is deleted before the new attempt spawns; a start that fails reports the reason the server gave", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	writeStartError(world.slot, { code: "acl", text: "an earlier attempt" }, Date.now());
	let seenAtSpawn: unknown = "unset";
	const ctx = world.ctx({ spawn: (spec) => ((seenAtSpawn = readStartError(world.slot)), world.ctx().spawn(spec)) });
	world.intercomError = Object.assign(new Error("pi-intercom 0.17.1 is older than 0.18.1"), { code: "intercom" });
	await assert.rejects(launch(ctx), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && e.startError?.code === "loader" && /0\.17\.1/.test(e.message));
	assert.equal(seenAtSpawn, undefined);
});

test("a spawned process that exits before it answers fails the start at once, naming its exit code and the log", async () => {
	world.crashWith = 9;
	await assert.rejects(launch(world.ctx()), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && /exited with code 9/.test(e.message) && e.message.includes(fileOf(world.slot, "log")));
});

test("a server that never answers fails the start after the budget", async () => {
	const ctx = world.ctx({ timers: { start: 300, exit: 200, supervisor: 50, touch: 30 }, spawn: () => ({ pid: 5, exited: new Promise(() => {}) }) });
	await assert.rejects(launch(ctx), (e: unknown) => e instanceof ServerError && /did not answer hello within 0\.3 s/.test(e.message));
});

test("R-F002: a start that finds a live server (the look missed its hello) leaves no restarting on that server's record", async () => {
	const s = await world.start();
	await s.handle.ready;
	const done = await launch(world.ctx({ by: "late starter" }));
	assert.equal(done.pid, s.pid, "the live server is the one the start returns");
	assert.equal(world.spawned.length, 1, "a child was started, found the server, and left");
	assert.equal(world.record()?.pid, s.pid);
	assert.equal(world.record()?.restarting, undefined, "the mark the starter put on the live record is gone");
	assert.equal(stateOf(world.ctx(), await probe(world.ctx())), "live");
});

test("R-F004: the wait for the lock a start or restart holds is that start's wait plus the exit wait, from the same timers: 70 s on Windows, 30 s elsewhere", () => {
	assert.equal(lockWaitFor({ timers: timersFor("win32") }), 70_000);
	assert.equal(lockWaitFor({ timers: timersFor("linux") }), 30_000);
	assert.equal(lockWaitFor({ timers: { start: 600, exit: 200, supervisor: 100, touch: 40 } }), 800);
});

test("R-F004: stop and restart wait for a busy lock as long as lockWaitFor says, no more and no less (not a fixed 10 s or 20 s)", async () => {
	const timers = { start: 600, exit: 200, supervisor: 100, touch: 40 };
	for (const [name, run] of [["stop", (ctx: Parameters<typeof stop>[0]) => stop(ctx)], ["restart", (ctx: Parameters<typeof stop>[0]) => restart(ctx, { reason: "r" })]] as const) {
		// Released inside the wait: the request gets the lock and goes on.
		let held = await takeLock(world.slot, "a start", world.ctx().lock, 0);
		setTimeout(() => held.release(), 400);
		await run(world.ctx({ timers }));
		// Held past the wait: busy, at the wait and not at a fixed 10 s.
		held = await takeLock(world.slot, "a start", world.ctx().lock, 0);
		const began = Date.now();
		await assert.rejects(run(world.ctx({ timers })), (e: unknown) => e instanceof ServerError && e.code === "busy", name);
		const waited = Date.now() - began;
		held.release();
		assert.ok(waited >= 700 && waited < 1600, `${name} waited ${waited} ms for a wait of 800 ms`);
		rmSync(fileOf(world.slot, "record"), { force: true });
	}
});

// --- one deadline for the whole call (`up --timeout`) ---

test("a deadline cuts the lock wait: a lock that stays held is busy, naming the wait `lock`, at the deadline", async () => {
	const held = await takeLock(world.slot, "a start", world.ctx().lock, 0);
	const began = Date.now();
	await assert.rejects(ensure(world.ctx(), { boss: true, deadline: Date.now() + 300 }), (e: unknown) => e instanceof ServerError && e.code === "busy" && e.wait === "lock");
	held.release();
	const waited = Date.now() - began;
	assert.ok(waited >= 250 && waited < 1500, `waited ${waited} ms`);
});

test("a deadline cuts the start wait too: a server that never answers fails at the deadline, naming the wait `start`, not after the 5 s the timers give", async () => {
	const ctx = world.ctx({ spawn: () => ({ pid: 5, exited: new Promise(() => {}) }) });
	const began = Date.now();
	await assert.rejects(launch(ctx, { deadline: Date.now() + 300 }), (e: unknown) => e instanceof ServerError && e.wait === "start" && /within 0\.3 s/.test(e.message));
	assert.ok(Date.now() - began < 1500);
	// With no deadline the wait is the timers', and it names itself the same way.
	const short = world.ctx({ timers: { start: 200, exit: 100, supervisor: 50, touch: 30 }, spawn: () => ({ pid: 5, exited: new Promise(() => {}) }) });
	await assert.rejects(launch(short), (e: unknown) => e instanceof ServerError && e.wait === "start");
});

test("the lock wait and the start wait share the deadline: a lock held for 250 ms leaves the start the rest of 700 ms, so the whole call ends at the deadline", async () => {
	const held = await takeLock(world.slot, "a start", world.ctx().lock, 0);
	setTimeout(() => held.release(), 250);
	const ctx = world.ctx({ spawn: () => ({ pid: 5, exited: new Promise(() => {}) }) });
	const began = Date.now();
	await assert.rejects(ensure(ctx, { boss: true, deadline: began + 700 }), (e: unknown) => e instanceof ServerError && e.wait === "start");
	const total = Date.now() - began;
	assert.ok(total >= 650 && total < 1500, `the whole call took ${total} ms`);
});

test("a restart under a deadline stops waiting for the old server to leave at the deadline, naming the wait `exit`", async () => {
	const s = await world.start();
	await s.handle.ready;
	const ctx = world.ctx({ alive: (p) => p === s.pid || world.live.has(p), kill: () => {}, timers: { start: 5000, exit: 5000, supervisor: 400, touch: 40 } });
	const began = Date.now();
	await assert.rejects(restart(ctx, { reason: "r", deadline: began + 400 }), (e: unknown) => e instanceof ServerError && e.code === "exit-timeout" && e.wait === "exit");
	assert.ok(Date.now() - began < 2000);
});

test("a stopped server is not started by an automatic start; the boss's own start clears the mark in server.json and gui.json and starts it", async () => {
	plant({ stopped: true, gui: { port: 5000, token: "t", stopped: true } });
	writeFileSync(`${world.stateDir}/gui.json`, JSON.stringify({ pid: 1, port: 5000, token: "t", owner: "o", stopped: true }));
	const auto = await ensure(world.ctx());
	assert.ok("skipped" in auto && auto.skipped.do === "nothing" && auto.skipped.why === "stopped");
	assert.equal(world.spawned.length, 0);
	const boss = await ensure(world.ctx(), { boss: true });
	assert.ok("server" in boss && boss.server === "started");
	assert.equal(world.record()?.stopped, undefined);
	assert.equal(JSON.parse(readFileSync(`${world.stateDir}/gui.json`, "utf8")).stopped, undefined);
	assert.equal(world.record()?.gui?.stopped, undefined);
	assert.equal(world.record()?.gui?.port, 5000, "the page's port is kept");
});

// --- restarts ---

test("a restart keeps the record's port and token, holds the lock until hello, and the new server is a new process with a new secret", async () => {
	const s = await world.start();
	await s.handle.ready;
	const before = world.record()!;
	writeRecord(world.slot, { ...before, gui: { port: 52662, token: "tok-xyz" } });
	await sleep(100); // the old server's record heals only when it is not its own; here it is, so it keeps the gui block it did not write
	const done = await restart(world.ctx({ by: "cli restart" }), { reason: "for testing" });
	assert.equal(done.server, "restarted");
	assert.notEqual(done.record.pid, before.pid);
	assert.notEqual(done.record.secret, before.secret, "the secret is made anew at each start");
	assert.equal(await s.handle.done, 0);
	assert.equal(readLock(world.slot), undefined);
	assert.equal(world.record()?.pid, done.record.pid);
	assert.equal(world.record()?.restarting, undefined, "cleared by the new server's hello");
	assert.match(logText(), /restart reason="for testing" by="cli restart"/);
});

test("every kind of restart keeps the gui port and token: restart, upgrade, and the desk switch", async () => {
	for (const how of [{ reason: "restart" }, { reason: "upgrade", upgrade: true }, { reason: "desk switch", boss: true }] as const) {
		const s = await world.start({ version: "0.43.0" });
		await s.handle.ready;
		writeRecord(world.slot, { ...world.record()!, gui: { port: 52662, token: "tok-xyz" } });
		const done = await restart(world.ctx({ version: "0.44.0" }), how);
		assert.deepEqual(done.record.gui, { port: 52662, token: "tok-xyz" }, how.reason);
		assert.equal(done.server, "upgrade" in how ? "upgraded" : "restarted");
		await world.running.find((r) => r.pid === done.record.pid)!.handle.shutdown(0);
		rmSync(fileOf(world.slot, "record"), { force: true });
	}
});

test("the requester touches restarting.since from its ask until hello, so a slow new server leaves the record fresh", async () => {
	const s = await world.start();
	await s.handle.ready;
	world.connectMs = 700;
	const seen: { since: string; began: string; reason: string; by: string }[] = [];
	const sampler = setInterval(() => { const r = world.record()?.restarting; if (r) seen.push({ ...r }); }, 20);
	const done = await restart(world.ctx({ by: "session main (aaaa1111)" }), { reason: "slow one" });
	clearInterval(sampler);
	assert.equal(done.server, "restarted");
	const sinces = [...new Set(seen.map((r) => r.since))];
	assert.ok(sinces.length >= 4, `since moved ${sinces.length} times`);
	assert.ok(seen.every((r) => r.began === seen[0]!.began), "began never changes");
	assert.ok(seen.every((r) => r.reason === "slow one" && r.by === "session main (aaaa1111)" || r.reason === "starting" || r.reason === "slow one"), "a touch keeps reason and by");
	assert.equal(seen[0]!.reason, "slow one");
	const gaps = sinces.slice(1).map((t, i) => Date.parse(t) - Date.parse(sinces[i]!));
	assert.ok(gaps.every((g) => g < 200), "the record never went stale while the server started");
});

test("in the gap before the new server runs, only the requester keeps restarting.since fresh, and it stops once the new server is ready", async () => {
	const s = await world.start();
	await s.handle.ready;
	world.spawnMs = 600;
	const seen: string[] = [];
	const sampler = setInterval(() => { const since = world.record()?.restarting?.since; if (since && !seen.includes(since)) seen.push(since); }, 10);
	await restart(world.ctx(), { reason: "cold start" });
	clearInterval(sampler);
	const gaps = seen.slice(1).map((t, i) => Date.parse(t) - Date.parse(seen[i]!));
	assert.ok(seen.length >= 5, `touched ${seen.length} times over a 600 ms gap`);
	assert.ok(gaps.every((g) => g < 250), `the record was never stale: ${gaps.join(", ")}`);
	const last = seen.at(-1)!;
	await sleep(150);
	assert.equal(world.record()?.restarting, undefined);
	assert.equal(world.record()?.pid === s.pid, false);
	assert.ok(Date.now() - Date.parse(last) < 2000);
});

test("a restart of a down server starts it; of a stopped one it refuses unless it is the boss's", async () => {
	const down = await restart(world.ctx(), { reason: "r" });
	assert.equal(down.server, "started");
	const s = world.running.at(-1)!;
	await callStop(s);
	assert.equal(world.record()?.stopped, true);
	await assert.rejects(restart(world.ctx(), { reason: "from an agent" }), (e: unknown) => e instanceof ServerError && e.code === "stopped");
	const boss = await restart(world.ctx(), { reason: "the boss", boss: true });
	assert.equal(boss.server, "started");
	assert.equal(world.record()?.stopped, undefined);
});
async function callStop(s: { handle: { endpoint: string; done: Promise<number> } }) {
	await callControl(s.handle.endpoint, world.record()!.secret, { cmd: "stop", by: "t" });
	await s.handle.done;
}

test("version rules: a restart from an older package is refused unless --downgrade; an upgrade from a newer one is reported as upgraded", async () => {
	const s = await world.start({ version: "0.44.0" });
	await s.handle.ready;
	await assert.rejects(restart(world.ctx({ version: "0.43.0" }), { reason: "r" }), (e: unknown) => e instanceof ServerError && e.code === "older");
	assert.equal((await probe(world.ctx())).live, true, "the server was left alone");
	const down = await restart(world.ctx({ version: "0.43.0" }), { reason: "downgrade", downgrade: true });
	assert.equal(down.record.version, "0.43.0");
	const up = await restart(world.ctx({ version: "0.45.0" }), { reason: "upgrade", upgrade: true });
	assert.equal(up.server, "upgraded");
	assert.equal(up.record.version, "0.45.0");
});

test("a down server whose record is from a newer package is not started by an older package", async () => {
	plant({ version: "0.45.0" });
	await assert.rejects(restart(world.ctx({ version: "0.44.0" }), { reason: "r" }), (e: unknown) => e instanceof ServerError && e.code === "older");
	assert.equal(world.spawned.length, 0);
});

test("a restart against a record that names another Herdr socket fails and starts nothing", async () => {
	plant({ herdr: "/elsewhere.sock" });
	await assert.rejects(restart(world.ctx(), { reason: "r" }), (e: unknown) => e instanceof ServerError && e.code === "herdr");
	assert.equal(world.spawned.length, 0);
});

test("restarting a serve server: its supervisor starts it again; when none does the requester starts a detached one", async () => {
	const s = await world.start({ mode: "serve" });
	await s.handle.ready;
	// A supervisor that starts it again within the budget.
	const supervised = restart(world.ctx(), { reason: "r" });
	await until(() => world.exitCodes.get(s.pid) === 75, "the old serve server to leave with 75");
	const back = await world.start({ mode: "serve" });
	const done = await supervised;
	assert.equal(done.record.pid, back.pid);
	assert.equal(world.spawned.length, 0, "the requester started nothing");
	// No supervisor: the requester starts one itself.
	const alone = await restart(world.ctx(), { reason: "again" });
	assert.equal(alone.record.mode, "detached");
	assert.equal(world.spawned.length, 1);
});

test("sbr-F005: a restart from another broker scope or transport is refused, and the record keeps its scope; so is a serve takeover", async () => {
	const s = await world.start();
	await s.handle.ready;
	const scope = { env: { ...world.env, PI_INTERCOM_SCOPE_ID: "other" } };
	await assert.rejects(restart(world.ctx(scope), { reason: "r" }), (e: unknown) => e instanceof ServerError && e.code === "scope");
	assert.equal(world.live.has(s.pid), true, "the server was not asked to restart");
	assert.deepEqual(world.record()?.intercom, { transport: "default" });
	await assert.rejects(takeOver(world.ctx({ ...scope, by: "cli serve" }), world.record()!), (e: unknown) => e instanceof ServerError && e.code === "scope");
	assert.equal(world.live.has(s.pid), true);
	// Another transport is another broker as well.
	await assert.rejects(restart(world.ctx({ platform: "win32", env: { ...world.env, PI_INTERCOM_TRANSPORT: "tcp" } }), { reason: "r" }), (e: unknown) => e instanceof ServerError && e.code === "scope");
});

test("sbr-F012: serve never replaces a server of a newer package", async () => {
	const s = await world.start({ version: "0.45.0" });
	await s.handle.ready;
	await assert.rejects(takeOver(world.ctx({ version: "0.44.0", by: "cli serve" }), world.record()!), (e: unknown) => e instanceof ServerError && e.code === "older");
	assert.equal(world.live.has(s.pid), true);
});

test("sbr-F011: only restarts someone asked for count for the once-a-minute limit, not an upgrade or a serve takeover; the limit is judged under the lock", async () => {
	const s = await world.start({ version: "0.43.0" });
	await s.handle.ready;
	await restart(world.ctx({ version: "0.44.0" }), { reason: "upgrade", upgrade: true });
	assert.equal(world.record()?.lastRestart, undefined, "an upgrade does not count");
	await restart(world.ctx(), { reason: "first", limit: true });
	assert.equal(world.record()?.lastRestart?.reason, "first");
	await assert.rejects(restart(world.ctx(), { reason: "second", limit: true }), (e: unknown) => e instanceof ServerError && e.code === ("rate") && /once a minute at most/.test(e.message));
	await restart(world.ctx(), { reason: "the boss", boss: true, limit: true });
	await takeOver(world.ctx({ by: "cli serve" }), world.record()!);
	assert.equal(world.record()?.lastRestart?.reason, "the boss", "a takeover does not count either");
});

test("an old server that does not exit after it took the restart is sent SIGTERM, and a stuck one fails the restart", async () => {
	const s = await world.start();
	await s.handle.ready;
	const killed: number[] = [];
	// The server answers but, as far as the requester can tell, never exits: the fake kill records the signal.
	const ctx = world.ctx({ timers: { start: 1000, exit: 200, supervisor: 50, touch: 30 }, alive: () => true, kill: (pid) => void killed.push(pid) });
	await assert.rejects(restart(ctx, { reason: "r" }), (e: unknown) => e instanceof ServerError && e.code === "exit-timeout");
	assert.deepEqual(killed, [s.pid]);
});

// --- stop ---

test("stop: the server leaves marked stopped; a session's look then leaves it down, and an automatic start is refused", async () => {
	const s = await world.start();
	await s.handle.ready;
	assert.deepEqual(await stop(world.ctx({ by: "cli stop" })), { outcome: "stopped" });
	assert.equal(world.record()?.stopped, true);
	assert.equal(world.live.has(s.pid), false);
	const seen = await probe(world.ctx());
	assert.deepEqual(look({}, seen), { do: "nothing", why: "stopped" });
	const auto = await ensure(world.ctx());
	assert.ok("skipped" in auto);
});

test("stop against a serve server is refused, and the server runs on", async () => {
	const s = await world.start({ mode: "serve" });
	await s.handle.ready;
	await assert.rejects(stop(world.ctx()), (e: unknown) => e instanceof ServerError && e.code === "serve");
	assert.equal((await probe(world.ctx())).live, true);
});

test("stop with no server marks a record that is not yet marked, so no session starts the server unasked; with no record it does nothing", async () => {
	assert.deepEqual(await stop(world.ctx()), { outcome: "already-down" });
	assert.equal(world.record(), undefined);
	plant({ pid: 99 });
	assert.deepEqual(await stop(world.ctx()), { outcome: "already-down" });
	assert.equal(world.record()?.stopped, true);
});

test("serve takes over a live detached server by the restart path and waits for it to leave", async () => {
	const s = await world.start();
	await s.handle.ready;
	writeRecord(world.slot, { ...world.record()!, gui: { port: 4242, token: "t" } });
	await takeOver(world.ctx({ by: "cli serve" }), world.record()!);
	assert.equal(world.live.has(s.pid), false);
	assert.equal(world.record()?.restarting?.reason, "serve takes over");
	assert.equal(world.record()?.restarting?.by, "cli serve");
	assert.deepEqual(world.record()?.gui, { port: 4242, token: "t" }, "the record the serve server starts from still holds the port and token");
});

test("sbr-NEW-2: a stop from another broker scope or transport is refused with the restart's refusal, and the server runs on; a stop on the record's scope goes through", async () => {
	const s = await world.start();
	await s.handle.ready;
	await assert.rejects(stop(world.ctx({ env: { ...world.env, PI_INTERCOM_SCOPE_ID: "other" } })), (e: unknown) => e instanceof ServerError && e.code === "scope");
	await assert.rejects(stop(world.ctx({ platform: "win32", env: { ...world.env, PI_INTERCOM_TRANSPORT: "tcp" } })), (e: unknown) => e instanceof ServerError && e.code === "scope");
	assert.equal(world.live.has(s.pid), true, "the server was not asked to stop");
	assert.notEqual(world.record()?.stopped, true);
	assert.deepEqual(await stop(world.ctx({ by: "boss" })), { outcome: "stopped" });
});

test("sbr-NEW-3: a restart that finds the serve server down with a fresh restarting waits for the supervisor's serve and starts no detached one", async () => {
	const s = await world.start({ mode: "serve" });
	await s.handle.ready;
	const first = restart(world.ctx(), { reason: "first" });
	await until(() => world.exitCodes.get(s.pid) === 75, "the old serve server to leave with 75");
	const second = restart(world.ctx({ by: "second requester" }), { reason: "second" });
	await sleep(120);
	const back = await world.start({ mode: "serve" });
	const [a, b] = await Promise.all([first, second]);
	assert.equal(a.record.pid, back.pid);
	assert.equal(b.record.pid, back.pid);
	assert.equal(world.spawned.length, 0, "neither requester launched a detached server");
});

test("sbr-NEW-3: a retake that waits out the budget while a serve starts reports the restart, not busy", async () => {
	const s = await world.start({ mode: "serve" });
	await s.handle.ready;
	const ctx = world.ctx({ timers: { start: 300, exit: 2000, supervisor: 200, touch: 40 } });
	const requested = restart(ctx, { reason: "r" });
	await until(() => world.exitCodes.get(s.pid) === 75, "the old serve server to leave with 75");
	// A serve that took the lock holds it while it starts, longer than the retake's budget.
	const held = await takeLock(world.slot, "serve", world.ctx().lock, 2000);
	await sleep(250);
	const back = await world.start({ mode: "serve" });
	const done = await requested;
	held.release();
	assert.equal(done.record.pid, back.pid);
	assert.equal(world.spawned.length, 0);
});

test("sbr-NEW-4: a down server always starts, whatever the once-a-minute limit says; a live one is still held to it", async () => {
	plant({ pid: 99, lastRestart: { at: new Date().toISOString(), reason: "a moment ago", by: "someone" } });
	const down = await restart(world.ctx(), { reason: "it is down", limit: true });
	assert.equal(down.server, "started");
	const s = await world.start({ mode: "detached" });
	await s.handle.ready;
	writeRecord(world.slot, { ...world.record()!, lastRestart: { at: new Date().toISOString(), reason: "a moment ago", by: "someone" } });
	await assert.rejects(restart(world.ctx(), { reason: "again", limit: true }), (e: unknown) => e instanceof ServerError && e.code === "rate");
});
