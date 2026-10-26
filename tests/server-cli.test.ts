import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { type CliDeps, parseArgs, run, UsageError } from "../src/server/cli.ts";
import { createLog } from "../src/server/log.ts";
import { fileOf, readLock, readRecord, takeLock, writeRecord, writeStartError } from "../src/server/record.ts";
import type { ServerHandle, ServerOptions } from "../src/server/main.ts";
import { callControl } from "../src/server/socket.ts";
import { ServerWorld, sleep, until } from "./server-world.ts";

// docs/specs/2026-10-26-sb-backend.md: `cli.mjs up`, `serve`, `stop`, `status`, `restart`, `logs`: their output, their steps, and their exit codes 0 to 5.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());

interface Out { code: number; out: string; err: string; json: Record<string, unknown> | undefined; errJson: Record<string, unknown> | undefined }
async function cli(argv: string[], over: Partial<CliDeps> & { version?: string; env?: NodeJS.ProcessEnv; herdr?: boolean } = {}): Promise<Out> {
	const version = over.version ?? "0.44.0";
	const { by: _by, ...requester } = world.ctx({ version });
	let out = "", err = "";
	const { herdr = true, ...rest } = over;
	const code = await run(argv, {
		env: world.env, stateDir: world.stateDir, version, cli: "/fake/cli.mjs", ctx: { ...requester, env: over.env ?? world.env, ...over.ctx }, herdrListens: async () => herdr,
		out: (t) => void (out += t), err: (t) => void (err += t), ...rest,
	});
	const parse = (text: string) => { try { return JSON.parse(text.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "") as Record<string, unknown>; } catch { return undefined; } };
	return { code, out, err, json: parse(out), errJson: parse(err) };
}

// --- usage ---

test("a bad command line is exit 2 with the usage; --dir and --label belong to a later step and are refused", async () => {
	for (const argv of [[], ["bogus"], ["up", "--nope"], ["up", "stray"], ["up", "--timeout"], ["up", "--timeout", "-1"], ["logs", "--lines", "0"], ["restart", "--reason"], ["status", "--exact"]]) {
		const r = await cli(argv);
		assert.equal(r.code, 2, argv.join(" "));
		assert.match(r.err, /usage:|--|unknown/);
	}
	const dir = await cli(["up", "--dir", "/x", "--label", "y"]);
	assert.equal(dir.code, 2);
	assert.match(dir.err, /--dir belongs to the desk steps/);
	assert.equal((await cli(["run"])).code, 2, "run is the server's own start");
	assert.throws(() => parseArgs(["up", "--dir", "x"]), UsageError);
	assert.deepEqual(parseArgs(["restart", "--reason", "why", "--downgrade"]), { command: "restart", flags: { reason: "why", downgrade: true } });
});

// --- status ---

test("status says gone with no server, and never prints the secret or the socket", async () => {
	const none = await cli(["status"]);
	assert.equal(none.code, 0);
	assert.equal(none.json?.state, "gone");
	assert.deepEqual([none.json?.towers, none.json?.link], [[], null]);
	assert.equal(none.json?.package, "0.44.0");
	const s = await world.start();
	await s.handle.ready;
	const live = await cli(["status"]);
	assert.equal(live.json?.state, "live");
	assert.equal(live.json?.pid, s.pid);
	assert.equal(live.json?.version, "0.44.0");
	assert.equal(live.json?.mode, "detached");
	assert.equal(live.json?.desk, false);
	assert.equal(typeof live.json?.uptimeMs, "number");
	assert.equal(live.json?.log, fileOf(world.slot, "log"));
	assert.ok(!live.out.includes(world.record()!.secret) && !live.out.includes(world.record()!.socket) && !live.out.includes("secret"));
});

test("status gives the other states of the table: restarting (with its reason), stopped, gone with the last error and the start-error", async () => {
	const base = { pid: 7, started: "T-7", version: "0.44.0", herdr: world.slot.herdr, mode: "detached" as const, desk: false, intercom: {}, log: "/l", socket: "/nowhere", secret: "s".repeat(64), intercomId: "sb-server-00000000" };
	mkdirSync(world.slot.dir, { recursive: true });
	const now = new Date().toISOString();
	writeRecord(world.slot, { ...base, restarting: { began: now, since: now, reason: "upgrade", by: "session main" } });
	const restarting = await cli(["status"]);
	assert.equal(restarting.json?.state, "restarting");
	assert.equal((restarting.json?.restarting as { reason: string }).reason, "upgrade");
	writeRecord(world.slot, { ...base, stopped: true });
	assert.equal((await cli(["status"])).json?.state, "stopped");
	writeRecord(world.slot, { ...base, lastError: { at: now, code: "intercom", text: "no broker" } });
	writeStartError(world.slot, { code: "loader", text: "tsx was not found from /x" }, Date.now());
	const gone = await cli(["status"]);
	assert.equal(gone.json?.state, "gone");
	assert.equal((gone.json?.lastError as { code: string }).code, "intercom");
	assert.equal((gone.json?.startError as { code: string }).code, "loader");
});

// --- up ---

test("up starts a server and prints one JSON line: url, pid, started, version, package, mode, desk, server, log, steps, warnings; a second up finds it", async () => {
	const first = await cli(["up"]);
	assert.equal(first.code, 0, first.err);
	const j = first.json!;
	assert.equal(j.url, null, "no GUI listener in the server yet: the pi sessions host it until the GUI moves in");
	assert.equal(typeof j.pid, "number");
	assert.equal(j.pid, world.record()!.pid);
	assert.equal(typeof j.started, "string");
	assert.equal(j.version, "0.44.0");
	assert.equal(j.package, "0.44.0");
	assert.equal(j.mode, "detached");
	assert.equal(j.desk, false);
	assert.equal(j.server, "started");
	assert.equal(j.log, fileOf(world.slot, "log"));
	assert.deepEqual((j.steps as { name: string; ok: boolean }[]).map((s) => [s.name, s.ok]), [["herdr", true], ["version", true], ["server", true]]);
	assert.ok((j.steps as { ms: number }[]).every((s) => typeof s.ms === "number"));
	assert.deepEqual(j.warnings, []);
	assert.equal(first.out.trim().split("\n").length, 1, "one line");
	const second = await cli(["up"]);
	assert.equal(second.json?.server, "found");
	assert.equal(second.json?.pid, j.pid);
	assert.equal(world.spawned.length, 1);
});

test("up with the desk switch against a server started without it restarts it; without the switch against a desk server it leaves it and warns desk_on", async () => {
	await cli(["up"]);
	const before = world.record()!;
	const desk = await cli(["up"], { env: { ...world.env, STRAW_BOSS_DESK: "1" } });
	assert.equal(desk.json?.server, "restarted");
	assert.equal(desk.json?.desk, true);
	assert.notEqual(desk.json?.pid, before.pid);
	assert.equal(world.record()?.desk, true);
	assert.match(JSON.stringify(desk.json?.steps), /desk switch/);
	const plain = await cli(["up"]);
	assert.equal(plain.json?.server, "found");
	assert.deepEqual((plain.json?.warnings as { code: string }[]).map((w) => w.code), ["desk_on"]);
	assert.equal(plain.json?.pid, desk.json?.pid);
});

test("up from a newer package upgrades an older server; from an older package it warns server_newer and leaves it, or with --exact exits 1 at step version", async () => {
	const s = await world.start({ version: "0.43.0" });
	await s.handle.ready;
	const upgraded = await cli(["up"], { version: "0.44.0" });
	assert.equal(upgraded.json?.server, "upgraded");
	assert.equal(upgraded.json?.version, "0.44.0");
	assert.equal(upgraded.json?.package, "0.44.0");
	const newer = await cli(["up"], { version: "0.43.0" });
	assert.equal(newer.code, 0);
	assert.equal(newer.json?.server, "found");
	assert.equal(newer.json?.version, "0.44.0");
	assert.equal(newer.json?.package, "0.43.0");
	assert.deepEqual(newer.json?.warnings, [{ code: "server_newer", text: "the server runs 0.44.0, this package is 0.43.0" }]);
	const exact = await cli(["up", "--exact"], { version: "0.43.0" });
	assert.equal(exact.code, 1);
	assert.equal(exact.errJson?.step, "version");
	assert.match(String(exact.errJson?.reason), /--exact/);
	assert.equal(world.record()?.version, "0.44.0", "never a downgrade");
});

test("up fails at step herdr, starting nothing, when no Herdr answers or the record serves another socket", async () => {
	const none = await cli(["up"], { herdr: false });
	assert.equal(none.code, 1);
	assert.equal(none.errJson?.step, "herdr");
	assert.match(String(none.errJson?.reason), /no Herdr server answers at/);
	assert.deepEqual((none.errJson?.steps as { name: string; ok: boolean }[]).map((s) => [s.name, s.ok]), [["herdr", false]]);
	mkdirSync(world.slot.dir, { recursive: true });
	writeRecord(world.slot, { pid: 7, version: "0.44.0", herdr: "/elsewhere.sock", mode: "detached", desk: false, intercom: {}, log: "/l", socket: "/nowhere", secret: "s".repeat(64), intercomId: "sb-server-00000000" });
	const other = await cli(["up"]);
	assert.equal(other.code, 1);
	assert.equal(other.errJson?.step, "herdr");
	assert.match(String(other.errJson?.reason), /serves \/elsewhere\.sock/);
	assert.equal(world.spawned.length, 0);
});

test("up is the boss's own start: it clears stopped in server.json and gui.json and starts the server", async () => {
	const s = await world.start();
	await s.handle.ready;
	await callControl(world.record()!.socket, world.record()!.secret, { cmd: "stop", by: "t" });
	await s.handle.done;
	writeFileSync(`${world.stateDir}/gui.json`, JSON.stringify({ pid: 1, port: 5000, token: "t", owner: "o", stopped: true }));
	assert.equal(world.record()?.stopped, true);
	const r = await cli(["up"]);
	assert.equal(r.json?.server, "started");
	assert.equal(world.record()?.stopped, undefined);
	assert.equal(JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(`${world.stateDir}/gui.json`, "utf8"))).stopped, undefined);
});

test("a start that fails: loader, intercom, or acl in start-error.json is exit 3 with the reason; any other failure is exit 1 at step server", async () => {
	world.intercomError = Object.assign(new Error("tsx was not found from /x/dist/server: it is a dependency of pi-straw-boss, so reinstall the package"), { code: "loader" });
	const loader = await cli(["up"]);
	assert.equal(loader.code, 3);
	assert.equal(loader.errJson?.step, "server");
	assert.match(String(loader.errJson?.reason), /tsx was not found from \/x\/dist\/server/);
	assert.equal((loader.errJson?.startError as { code: string }).code, "loader");
	world.intercomError = undefined;
	const failsAcl = { spawn: () => (writeStartError(world.slot, { code: "acl", text: "the ACL of x is not owner and SYSTEM only: BU", sddl: "O:S-1-5-21D:(A;;FA;;;BU)" }, Date.now()), { pid: 1, exited: Promise.resolve(3) }) };
	const acl = await cli(["up"], { ctx: failsAcl });
	assert.equal(acl.code, 3);
	assert.match(String(acl.errJson?.reason), /acl: the ACL of x is not owner and SYSTEM only/);
	assert.equal((acl.errJson?.startError as { sddl: string }).sddl, "O:S-1-5-21D:(A;;FA;;;BU)", "the SDDL it read is in the line");
	world.crashWith = 9;
	const crash = await cli(["up"]);
	assert.equal(crash.code, 1);
	assert.equal(crash.errJson?.step, "server");
	assert.match(String(crash.errJson?.reason), /exited with code 9/);
	assert.equal(crash.errJson?.log, fileOf(world.slot, "log"));
});

test("a second up while one starts waits for it on server.lock and then reports what it finds", async () => {
	world.connectMs = 400;
	const first = cli(["up"]);
	await until(() => readLock(world.slot), "the lock");
	const second = await cli(["up"]);
	assert.equal(second.code, 0);
	assert.equal(second.json?.server, "found");
	assert.equal((await first).json?.server, "started");
	assert.equal(world.spawned.length, 1);
});

test("up gives up on a lock that stays held past --timeout, as a failure at step server", async () => {
	const lock = await takeLock(world.slot, "someone else", { alive: () => true }, 0);
	const r = await cli(["up", "--timeout", "0.3"]);
	lock.release();
	assert.equal(r.code, 1);
	assert.equal(r.errJson?.step, "server");
	assert.match(String(r.errJson?.reason), /another start or restart is under way/);
});

// --- stop, restart, logs ---

test("stop warns on stderr that every workspace loses its tower, stops the server, and prints the outcome; with nothing running it says already-down", async () => {
	await cli(["up"]);
	const r = await cli(["stop"]);
	assert.equal(r.code, 0);
	assert.match(r.err, /every workspace loses its live tower, and mains are demoted 15 s later/);
	assert.deepEqual(r.json, { outcome: "stopped" });
	assert.equal(world.record()?.stopped, true);
	assert.deepEqual((await cli(["stop"])).json, { outcome: "already-down" });
});

test("stop against a serve server is exit 5 and names the supervisor", async () => {
	const s = await world.start({ mode: "serve" });
	await s.handle.ready;
	const r = await cli(["stop"]);
	assert.equal(r.code, 5);
	assert.match(r.err, /stop the supervisor instead/);
	assert.equal((await cli(["status"])).json?.state, "live");
});

test("restart restarts with a reason and says what it did; it refuses a stopped server, and an older package without --downgrade", async () => {
	await cli(["up"]);
	const done = await cli(["restart", "--reason", "from the test"]);
	assert.equal(done.code, 0);
	assert.equal(done.json?.server, "restarted");
	assert.equal(done.json?.version, "0.44.0");
	assert.match(await import("node:fs").then((fs) => fs.readFileSync(fileOf(world.slot, "log"), "utf8")), /restart reason="from the test" by="cli restart"/);
	const old = await cli(["restart"], { version: "0.43.0" });
	assert.equal(old.code, 1);
	assert.match(old.err, /needs --downgrade/);
	assert.equal((await cli(["restart", "--downgrade"], { version: "0.43.0" })).json?.version, "0.43.0");
	await cli(["stop"]);
	const stopped = await cli(["restart"]);
	assert.equal(stopped.code, 1);
	assert.match(stopped.err, /stopped on purpose/);
	assert.equal((await cli(["restart", "--reason", "x\ny"])).code, 2);
});

test("logs prints the last lines (200 by default), and --follow prints what is appended until it is ended", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	const log = createLog(fileOf(world.slot, "log"));
	for (let i = 0; i < 250; i++) log.line("event", { n: i });
	const all = await cli(["logs"]);
	assert.equal(all.out.trim().split("\n").length, 200);
	assert.match(all.out, /n=249/);
	assert.ok(!all.out.includes("n=49 "));
	const few = await cli(["logs", "--lines", "3"]);
	assert.deepEqual(few.out.trim().split("\n").map((l) => /n=(\d+)/.exec(l)![1]), ["247", "248", "249"]);
	const abort = new AbortController();
	const follow = cli(["logs", "--lines", "1", "--follow"], { signal: abort.signal, ctx: { sleep: async () => sleep(20) } });
	await sleep(60);
	appendFileSync(fileOf(world.slot, "log"), "2026-10-26T00:00:00.000Z later event\n");
	await sleep(120);
	abort.abort();
	const followed = await follow;
	assert.match(followed.out, /n=249/);
	assert.match(followed.out, /later event/);
});

// --- run and serve ---

function fakeServer(done = Promise.resolve(0)) {
	const calls: ServerOptions[] = [];
	const handlers: (() => void)[] = [];
	const shutdowns: number[] = [];
	const server = async (options: ServerOptions): Promise<ServerHandle> => {
		calls.push(options);
		return { ready: Promise.resolve(true), done, endpoint: "/x", shutdown: async (code = 0) => void shutdowns.push(code) };
	};
	return { server, calls, signals: (leave: () => void) => void handlers.push(leave), handlers, shutdowns };
}

test("run --detached starts the server in this process as a detached server, with the identity of the shell stripped, and exits with its code", async () => {
	const f = fakeServer(Promise.resolve(3));
	const env = { ...world.env, PI_INTERCOM_SESSION_ID: "someone", HERDR_PANE_ID: "p1", PI_INTERCOM_SCOPE_ID: "team-a" };
	const r = await cli(["run", "--detached", "--by", 'session "main" (3f2a1b9c)'], { env, server: f.server, signals: f.signals });
	assert.equal(r.code, 3);
	assert.equal(f.calls[0]?.mode, "detached");
	assert.equal(f.calls[0]?.by, 'session "main" (3f2a1b9c)');
	assert.equal(f.calls[0]?.env.PI_INTERCOM_SESSION_ID, undefined);
	assert.equal(f.calls[0]?.env.HERDR_PANE_ID, undefined);
	assert.equal(f.calls[0]?.env.PI_INTERCOM_SCOPE_ID, "team-a");
	assert.equal(env.PI_INTERCOM_SESSION_ID, undefined, "the process's own environment is cleaned too, for the broker client that reads it");
	f.handlers[0]?.();
	assert.deepEqual(f.shutdowns, [0], "a signal ends the server without a stop");
});

test("serve with nothing running runs a serve server in the foreground, clears a stopped left by a detached server, and releases the lock once it is ready", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	writeRecord(world.slot, { pid: 7, version: "0.44.0", herdr: world.slot.herdr, mode: "detached", desk: false, intercom: {}, log: "/l", socket: "/nowhere", secret: "s".repeat(64), intercomId: "sb-server-00000000", stopped: true });
	writeStartError(world.slot, { code: "acl", text: "old" }, Date.now());
	const f = fakeServer();
	const r = await cli(["serve"], { server: f.server, signals: f.signals });
	assert.equal(r.code, 0);
	assert.equal(f.calls[0]?.mode, "serve");
	assert.equal(f.calls[0]?.by, "cli serve");
	assert.equal(readRecord(world.slot)?.stopped, undefined);
	assert.equal(readLock(world.slot), undefined);
});

test("serve takes over a live detached server: it asks it to hand over by the restart path, waits for it to leave, then runs, with the record's port and token still there", async () => {
	const s = await world.start();
	await s.handle.ready;
	writeRecord(world.slot, { ...world.record()!, gui: { port: 52662, token: "tok" } });
	const f = fakeServer();
	const r = await cli(["serve"], { server: f.server, signals: f.signals });
	assert.equal(r.code, 0, r.err);
	assert.equal(world.live.has(s.pid), false, "the detached server left");
	assert.equal(f.calls.length, 1);
	assert.deepEqual(readRecord(world.slot)?.gui, { port: 52662, token: "tok" });
	assert.equal(readRecord(world.slot)?.restarting?.reason, "serve takes over");
});

test("sbr-F003: restarting a serve server under a supervisor: the requester lets go of the lock while it waits, so the supervisor's serve takes it and the new server is the supervisor's, with no fallback launch", async () => {
	const s = await world.start({ mode: "serve" });
	await s.handle.ready;
	const { restart } = await import("../src/server/client.ts");
	const asked = restart(world.ctx({ timers: { start: 5000, exit: 2000, supervisor: 3000, touch: 40 } }), { reason: "r" });
	await until(() => world.exitCodes.get(s.pid) === 75, "the old serve server to leave with 75");
	// The supervisor starts `serve` again: it takes server.lock, which the requester no longer holds.
	let back: Awaited<ReturnType<ServerWorld["start"]>> | undefined;
	const supervised = cli(["serve"], { signals: () => {}, server: async () => (back = await world.start({ mode: "serve" })).handle });
	const done = await asked;
	assert.equal(done.record.pid, back?.pid, "the supervisor's server is the one the restart reports");
	assert.equal(done.record.mode, "serve");
	assert.equal(world.spawned.length, 0, "the requester started nothing");
	assert.notEqual(world.record()?.lastRestart?.reason, "serve takes over");
	await back!.handle.shutdown(0);
	assert.equal((await supervised).code, 0);
});

test("sbr-F008: restart --reason with nothing in it is a usage error", async () => {
	const r = await cli(["restart", "--reason", "  "]);
	assert.equal(r.code, 2);
	assert.match(r.err, /--reason is one line of 1 to 200 characters/);
});

test("serve against a live serve server prints that server's record and exits 4", async () => {
	const s = await world.start({ mode: "serve" });
	await s.handle.ready;
	const f = fakeServer();
	const r = await cli(["serve"], { server: f.server, signals: f.signals });
	assert.equal(r.code, 4);
	assert.equal(r.errJson?.pid, s.pid);
	assert.equal(r.errJson?.version, "0.44.0");
	assert.equal(f.calls.length, 0);
	assert.equal(readLock(world.slot), undefined, "the lock is released");
});
