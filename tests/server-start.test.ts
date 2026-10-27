import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { launch, stateOf, timersFor } from "../src/server/client.ts";
import { fileOf, readLock, readRecord, takeLock, writeRecord } from "../src/server/record.ts";
import { helloOf } from "../src/server/socket.ts";
import { StubClient } from "./agent-fakes.ts";
import { freePort, ServerWorld, sleep, until } from "./server-world.ts";

// The start of a server on a slow machine (the Windows VM check of B1: a cold `up` took 7 to 26 s, and `status` said `gone` for the first 18 s of it): whoever starts the server
// writes `restarting` before it spawns anything and keeps it fresh, the server does the same from its first line, and the PowerShell starts a cold Windows start pays for are
// folded into one.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");

test("a start writes restarting (reason starting, the starter as by) before it spawns, keeps it fresh while the new process boots, and the state is restarting, never gone", async () => {
	world.spawnMs = 500;
	const ctx = world.ctx({ by: "cli up" });
	let atSpawn: ReturnType<typeof readRecord>;
	const spawn = ctx.spawn;
	ctx.spawn = (spec) => ((atSpawn = readRecord(world.slot)), spawn(spec));
	const states: string[] = [], sinces = new Set<string>();
	const watching = (async () => {
		for (let i = 0; i < 40; i++) {
			const record = readRecord(world.slot);
			if (record?.restarting) {
				sinces.add(record.restarting.since);
				states.push(stateOf(ctx, { record, live: false }));
			}
			await sleep(20);
		}
	})();
	const started = await launch(ctx);
	assert.equal(atSpawn!.restarting?.reason, "starting", "written before the spawn");
	assert.equal(atSpawn!.restarting?.by, "cli up");
	assert.deepEqual([atSpawn!.socket, atSpawn!.secret], ["", ""], "a placeholder: nothing to connect to, no secret");
	assert.equal(stateOf(ctx, { record: atSpawn, live: false }), "restarting");
	await watching;
	assert.ok(states.length > 5 && states.every((s) => s === "restarting"), `restarting throughout: ${states.join()}`);
	assert.ok(sinces.size > 3, `since moved ${sinces.size} times while no server ran yet`);
	assert.equal(readRecord(world.slot)?.restarting, undefined, "ready clears it");
	assert.equal(started.pid, readRecord(world.slot)?.pid);
});

test("the placeholder takes the pid of the process that was started for it, so status names the server that starts", async () => {
	world.spawnMs = 300;
	const ctx = world.ctx();
	let child: number | undefined;
	const spawn = ctx.spawn;
	ctx.spawn = (spec) => {
		const launched = spawn(spec);
		child = launched.pid;
		return launched;
	};
	const done = launch(ctx);
	await until(() => child !== undefined && readRecord(world.slot)?.pid === child && readRecord(world.slot)?.socket === "", "the placeholder to move to the child's pid", 1000);
	await done;
});

test("a start that fails ends restarting at once: the state is gone, not restarting for another 10 s", async () => {
	world.crashWith = 9;
	const ctx = world.ctx();
	await assert.rejects(launch(ctx), /exited with code 9/);
	const record = readRecord(world.slot);
	assert.equal(record?.restarting, undefined);
	assert.equal(stateOf(ctx, { record, live: false }), "gone");
});

test("a start over a dead server's record keeps what the record holds (GUI, last restart) and the new server carries it; its last error, until the new server is ready", async () => {
	const dead = { pid: 4242, version: "0.43.0", herdr: world.slot.herdr, mode: "detached" as const, desk: false, intercom: { transport: "default" }, log: fileOf(world.slot, "log"), socket: "/nowhere.sock", secret: "old", intercomId: "sb-server-x" };
	const port = await freePort();
	await world.start().then((s) => s.handle.shutdown(0));
	writeRecord(world.slot, { ...dead, gui: { port, token: "t" }, lastRestart: { at: "2026-10-26T01:00:00.000Z", reason: "r", by: "b" }, lastError: { at: "2026-10-26T01:00:00.000Z", code: "x", text: "y" } });
	const ctx = world.ctx({ alive: (pid) => world.live.has(pid) });
	let atSpawn: ReturnType<typeof readRecord>;
	const spawn = ctx.spawn;
	ctx.spawn = (spec) => ((atSpawn = readRecord(world.slot)), spawn(spec));
	await launch(ctx);
	assert.equal(atSpawn!.pid, 4242, "the dead server's record, with restarting");
	assert.equal(atSpawn!.restarting?.reason, "starting");
	assert.deepEqual(atSpawn!.gui, { port, token: "t" });
	assert.equal(atSpawn!.lastError?.code, "x", "carried while the new server starts");
	const record = readRecord(world.slot)!;
	assert.deepEqual([record.gui, record.lastRestart?.reason, record.lastError], [{ port, token: "t", stopped: false }, "r", undefined], "and dropped once it is ready");
});

test("the server touches restarting from its first line: during a slow ACL call (a PowerShell start) the record says starting, with since moving and no secret", async () => {
	const seen: { secret: string; since: string; reason: string }[] = [];
	const slow = async () => {
		for (let i = 0; i < 12; i++) {
			const r = readRecord(world.slot);
			if (r?.restarting) seen.push({ secret: r.secret, since: r.restarting.since, reason: r.restarting.reason });
			await sleep(30);
		}
		return {};
	};
	const s = await world.start({ platform: "win32", acl: slow, touchMs: 30 });
	assert.equal(await s.handle.ready, true);
	assert.ok(seen.length >= 10 && seen.every((r) => r.secret === "" && r.reason === "starting"), JSON.stringify(seen));
	assert.ok(new Set(seen.map((r) => r.since)).size > 3, "since moved");
	assert.equal(readRecord(world.slot)?.restarting, undefined);
});

test("the start time that comes with the ACL call is the server's: no second read of it, and it is in the record and in hello", async () => {
	const started = "2026-10-26T04:21:53.000Z";
	let asked = 0;
	const s = await world.start({ platform: "win32", acl: async () => ({ started }), started: async () => (asked++, "never") });
	await s.handle.ready;
	assert.equal(asked, 0);
	const record = readRecord(world.slot)!;
	assert.equal(record.started, started);
	assert.equal((await helloOf(record.socket, record.secret))?.started, started);
});

test("an ACL call that cannot tell the start time falls back to reading it, in the background", async () => {
	const s = await world.start({ platform: "win32", acl: async () => ({}), started: async () => "2026-10-26T05:00:00.000Z" });
	await s.handle.ready;
	await until(() => readRecord(world.slot)?.started === "2026-10-26T05:00:00.000Z", "the start time from the fallback");
});

test("the code loads while the ACL call runs (it needs nothing from it), and no secret is written before the ACL call ends", async () => {
	const order: string[] = [];
	const s = await world.start({
		platform: "win32",
		acl: async () => { order.push("acl begins"); await sleep(100); order.push(world.record()?.secret ? "secret written" : "acl ends"); return {}; },
		intercom: async () => { order.push("loader"); return world.intercom(new StubClient()); },
	});
	await s.handle.ready;
	assert.deepEqual(order.slice(0, 3).sort(), ["acl begins", "acl ends", "loader"], order.join());
	assert.ok(order.indexOf("loader") < order.indexOf("acl ends"), "the loader did not wait for the ACL call");
});

test("the log names each phase of a start with how long it took: loader, acl, listen, the broker, ready", async () => {
	const s = await world.start({ platform: "win32", acl: async () => ({}) });
	await s.handle.ready;
	const text = logText();
	for (const name of ["loader", "acl", "listen"]) assert.match(text, new RegExp(`phase name=${name} ms=\\d+ at=\\d+`), name);
	assert.match(text, /intercom-connected id=\S+ intercom=\S+ ms=\d+/);
	assert.match(text, /ready ms=\d+/);
});

test("the requester logs how long the start took, spawn included", async () => {
	await launch(world.ctx());
	assert.match(logText(), /start-requested by="test requester" version=0\.44\.0 pid=\d+ spawnMs=\d+/);
	assert.match(logText(), /start-answered pid=\d+ ms=\d+/);
});

test("the requester logs a start that went unanswered, with the exit code", async () => {
	world.crashWith = 3;
	await assert.rejects(launch(world.ctx()), /exited with code 3/);
	assert.match(logText(), /start-unanswered ms=\d+ exit=3/);
});

test("the lock does not wait for the holder's start time (a PowerShell start on Windows): it is taken at once, and written again with the time when it arrives", async () => {
	let arrive!: (started: string) => void;
	const late = new Promise<string>((resolve) => (arrive = resolve));
	const lock = await takeLock(world.slot, "cli up", { self: { pid: 777, started: () => late }, alive: () => true });
	assert.equal(readLock(world.slot)?.started, undefined);
	assert.equal(readLock(world.slot)?.pid, 777);
	arrive("2026-10-26T04:21:53.000Z");
	await until(() => readLock(world.slot)?.started === "2026-10-26T04:21:53.000Z", "the lock to carry the start time");
	lock.release();
	assert.ok(!existsSync(fileOf(world.slot, "lock")), "released whatever text it holds now");
});

test("a start time that arrives after the lock was released rewrites nothing, and neither does one that arrives after another took the lock", async () => {
	let arrive!: (started: string) => void;
	const late = new Promise<string>((resolve) => (arrive = resolve));
	const lock = await takeLock(world.slot, "cli up", { self: { pid: 777, started: () => late }, alive: () => true });
	lock.release();
	arrive("2026-10-26T04:21:53.000Z");
	await sleep(30);
	assert.ok(!existsSync(fileOf(world.slot, "lock")), "released: nothing written back");

	let arriveLater!: (started: string) => void;
	const slow = new Promise<string>((resolve) => (arriveLater = resolve));
	await takeLock(world.slot, "cli up", { self: { pid: 778, started: () => slow }, alive: () => true });
	const taker = JSON.stringify({ pid: 999, by: "taker", since: new Date().toISOString() });
	writeFileSync(fileOf(world.slot, "lock"), taker);
	arriveLater("2026-10-26T04:21:53.000Z");
	await sleep(30);
	assert.equal(readFileSync(fileOf(world.slot, "lock"), "utf8"), taker, "another holder's lock is left as it is");
});

test("the lock a start time was already known for is written whole at once, as before", async () => {
	const lock = await takeLock(world.slot, "cli up", { self: { pid: 777, started: async () => "2026-10-26T04:21:53.000Z" }, alive: () => true });
	assert.equal(lock.info.started, "2026-10-26T04:21:53.000Z", "in the text the lock was first written with, not rewritten after it");
	assert.equal(readLock(world.slot)?.started, "2026-10-26T04:21:53.000Z");
	lock.release();
});

test("the requester's wait for hello covers a measured Windows cold start with margin (7.4 to 22.9 s there) and stays 20 s elsewhere", () => {
	assert.ok(timersFor("win32").start >= 45_000);
	assert.equal(timersFor("linux").start, 20_000);
	assert.equal(timersFor("darwin").start, 20_000);
	assert.equal(timersFor("win32").touch, 2000);
});
