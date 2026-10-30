import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { type CliDeps, parseArgs, run, UsageError } from "../src/server/cli.ts";
import { createLog } from "../src/server/log.ts";
import { fileOf, readLock, readRecord, readStartError, takeLock, writeRecord, writeStartError } from "../src/server/record.ts";
import type { ServerHandle, ServerOptions } from "../src/server/main.ts";
import { callControl } from "../src/server/socket.ts";
import { GateTimeout } from "../src/server/winprep.ts";
import { fakeClock } from "./fake-clock.ts";
import { ServerWorld, sleep, stallWatch, until } from "./server-world.ts";

// docs/specs/2026-10-26-sb-backend.md: `cli.mjs up`, `serve`, `stop`, `status`, `restart`, `logs`: their output, their steps, and their exit codes 0 to 5.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());

interface Out { code: number; out: string; err: string; json: Record<string, unknown> | undefined; errJson: Record<string, unknown> | undefined }
async function cli(argv: string[], over: Partial<CliDeps> & { version?: string; env?: NodeJS.ProcessEnv; herdr?: boolean } = {}): Promise<Out> {
	const version = over.version ?? "0.44.0";
	const { by: _by, ...requester } = world.ctx({ version });
	let out = "", err = "";
	const { herdr = true, ctx: more, ...rest } = over;
	const code = await run(argv, {
		env: world.env, stateDir: world.stateDir, version, cli: "/fake/cli.mjs", ctx: { ...requester, env: over.env ?? world.env, ...more }, herdrListens: async () => herdr,
		out: (t) => void (out += t), err: (t) => void (err += t), ...rest,
	});
	const parse = (text: string) => { try { return JSON.parse(text.trim().split("\n").filter((l) => l.startsWith("{")).at(-1) ?? "") as Record<string, unknown>; } catch { return undefined; } };
	return { code, out, err, json: parse(out), errJson: parse(err) };
}

// --- usage ---

test("a bad command line is exit 2 with the usage; --dir and --label go together and need the desk switch", async () => {
	for (const argv of [[], ["bogus"], ["up", "--nope"], ["up", "stray"], ["up", "--timeout"], ["up", "--timeout", "-1"], ["logs", "--lines", "0"], ["restart", "--reason"], ["status", "--exact"]]) {
		const r = await cli(argv);
		assert.equal(r.code, 2, argv.join(" "));
		assert.match(r.err, /usage:|--|unknown/);
	}
	const dir = await cli(["up", "--dir", "/x", "--label", "y"]);
	assert.equal(dir.code, 2, "the desk steps need the switch (tests/server-desk.test.ts runs them)");
	assert.match(dir.err, /STRAW_BOSS_DESK=1/);
	assert.equal((await cli(["run"])).code, 2, "run is the server's own start");
	assert.throws(() => parseArgs(["up", "--dir", "x"]), UsageError, "--dir without --label");
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

test("status carries the GUI's url from the record; a GUI stopped on purpose is gui-stopped while the server runs, and up starts it again on the same port under the same token and it answers 200", async () => {
	const s = await world.start();
	await s.handle.ready;
	const gui = world.record()!.gui!, url = `http://127.0.0.1:${gui.port}/${gui.token}/`;
	assert.equal((await cli(["status"])).json?.url, url);
	const record = world.record()!;
	assert.equal((await callControl(record.socket, record.secret, { cmd: "gui-stop" })).reply?.ok, true);
	const stopped = await cli(["status"]);
	assert.deepEqual([stopped.json?.state, stopped.json?.url], ["gui-stopped", url]);
	await assert.rejects(fetch(url), "the page is down");
	const up = await cli(["up"]);
	assert.equal(up.code, 0, up.err);
	const again = world.record()!.gui!, fresh = `http://127.0.0.1:${gui.port}/${again.token}/`;
	assert.deepEqual([up.json?.server, up.json?.url, again.port], ["found", fresh, gui.port]);
	assert.equal(again.token, gui.token, "a stop on purpose does not rotate (D27)");
	assert.equal((await fetch(fresh)).status, 200);
	assert.equal((await fetch(url)).status, 200, "the address from before the stop opens again");
	assert.equal((await cli(["status"])).json?.state, "live");
	assert.equal(world.record()?.gui?.stopped, false);
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
	const gui = world.record()!.gui!;
	assert.equal(j.url, `http://127.0.0.1:${gui.port}/${gui.token}/`, "the server's own GUI");
	assert.equal(typeof j.pid, "number");
	assert.equal(j.pid, world.record()!.pid);
	assert.equal(typeof j.started, "string");
	assert.equal(j.version, "0.44.0");
	assert.equal(j.package, "0.44.0");
	assert.equal(j.mode, "detached");
	assert.equal(j.desk, false);
	assert.equal(j.server, "started");
	assert.equal(j.log, fileOf(world.slot, "log"));
	assert.deepEqual((j.steps as { name: string; ok: boolean }[]).map((s) => [s.name, s.ok]), [["herdr", true], ["version", true], ["server", true], ["gui", true]]);
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

test("up warns remote_off with the reason when remote access was wanted and cannot come back, and still prints the URL", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	writeFileSync(`${world.slot.dir}/paired.json`, JSON.stringify({ host: "box.tail1.ts.net:8443", login: "me@example.com", wanted: true, sessions: {} }));
	const up = await cli(["up"]);
	assert.equal(up.code, 0, up.err);
	const warning = (up.json?.warnings as { code: string; text: string }[]).find((w) => w.code === "remote_off");
	assert.match(warning?.text ?? "", /Remote access stays off: Tailscale is not installed/);
	const gui = world.record()!.gui!;
	assert.equal(up.json?.url, `http://127.0.0.1:${gui.port}/${gui.token}/`);
});

test("up warns lan_off with the reason when Wi-Fi access was wanted and cannot come back, and binds nothing", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	writeFileSync(`${world.slot.dir}/lan.json`, JSON.stringify({ v: 1, wanted: true, port: 8445, token: "", devices: {} }), { mode: 0o600 });
	const up = await cli(["up"]);
	assert.equal(up.code, 0, up.err);
	const warning = (up.json?.warnings as { code: string; text: string }[]).find((w) => w.code === "lan_off");
	assert.match(warning?.text ?? "", /Wi-Fi access stays off: this computer's Wi-Fi certificate is missing; run \/boss gui lan/);
});

test("up waits for the GUI's URL to answer 200 before it prints it, and fails at step gui when it never does", async () => {
	const s = await world.start();
	await s.handle.ready;
	const seen: { port: number; token: string }[] = [];
	const slow = async (gui: { port: number; token: string }) => (seen.push(gui), seen.length >= 3);
	const up = await cli(["up"], { pageAnswers: slow });
	assert.equal(up.code, 0, up.err);
	assert.equal(seen.length, 3, "asked until it answered");
	const gui = world.record()!.gui!;
	assert.deepEqual(seen[0], { port: gui.port, token: gui.token });
	assert.equal(up.json?.url, `http://127.0.0.1:${gui.port}/${gui.token}/`);
	const never = await cli(["up", "--timeout", "1"], { pageAnswers: async () => false });
	assert.equal(never.code, 1);
	assert.equal(never.errJson?.step, "gui");
	assert.match(String(never.errJson?.reason), /did not answer/);
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

test("--timeout bounds the whole up, and the failure names which wait ran out beside the step: lock, start, or hello", async () => {
	// lock: another start holds server.lock.
	const lock = await takeLock(world.slot, "someone else", { alive: () => true }, 0);
	const locked = await cli(["up", "--timeout", "0.3"]);
	lock.release();
	assert.equal(locked.errJson?.wait, "lock");
	// start: this up starts the server and it does not answer; the start wait is cut to what --timeout leaves. The clock is the test's, so the lock and the folder check take none of the time given.
	const clock = fakeClock();
	const silent = await cli(["up", "--timeout", "0.5"], { ctx: { now: clock.now, sleep: clock.sleep, spawn: () => ({ pid: 5, exited: new Promise(() => {}) }) } });
	assert.equal(silent.code, 1);
	assert.equal(silent.errJson?.step, "server");
	assert.equal(silent.errJson?.wait, "start");
	assert.match(String(silent.errJson?.reason), /did not answer hello within 0\.5 s/);
	assert.ok(clock.elapsed() >= 500 && clock.elapsed() <= 500 + 100, `the start wait took ${clock.elapsed()} ms: --timeout, not the 5 s the start timer gives`);
	// hello: another requester's start is under way (a fresh restarting, no lock held) and no hello comes.
	mkdirSync(world.slot.dir, { recursive: true });
	writeRecord(world.slot, { pid: 4_000_000, version: "0.44.0", herdr: world.slot.herdr, mode: "detached", desk: false, intercom: { transport: "default" }, log: "/l", socket: "", secret: "", intercomId: "x", restarting: { began: new Date().toISOString(), since: new Date().toISOString(), reason: "starting", by: "someone" } });
	const waiting = await cli(["up", "--timeout", "0.3"]);
	assert.equal(waiting.errJson?.step, "server");
	assert.equal(waiting.errJson?.wait, "hello");
	// A failure that is not a wait names none.
	const herdr = await cli(["up"], { herdr: false });
	assert.equal(herdr.errJson?.wait, undefined);
});

test("F005: when the state folder cannot be protected, up exits 3 and its JSON carries the startError (acl and the reason), though no start-error.json could be written", async () => {
	const prepare = () => { throw new Error("could not protect the folder before writing to it: Access is denied."); };
	const r = await cli(["up"], { ctx: { prepare } });
	assert.equal(r.code, 3);
	assert.equal(r.errJson?.step, "server");
	assert.equal((r.errJson?.startError as { code: string } | undefined)?.code, "acl");
	assert.match(String((r.errJson?.startError as { text: string } | undefined)?.text), /Access is denied/);
	assert.match(String(r.errJson?.reason), /^acl: /);
	assert.equal(readStartError(world.slot), undefined, "no file: there is no protected folder to write one in");
	assert.equal(world.spawned.length, 0);
});

test("F004: the Herdr check of up is cut to the time given (--timeout), at most its 2 s", async () => {
	const seen: (number | undefined)[] = [];
	await cli(["up", "--timeout", "1"], { herdrListens: async (_ctx: unknown, ms?: number) => (seen.push(ms), true) });
	assert.ok(seen[0] !== undefined && seen[0] <= 1000 && seen[0] > 0, String(seen[0]));
	await cli(["up", "--timeout", "30"], { herdrListens: async (_ctx: unknown, ms?: number) => (seen.push(ms), true) });
	assert.equal(seen.at(-1), 2000);
});

test("up's default time is 90 s on Windows and 30 s elsewhere, for the lock wait and the start wait together", async () => {
	for (const [platform, seconds] of [["win32", 90], ["linux", 30], ["darwin", 30]] as const) {
		const lock = await takeLock(world.slot, "someone else", { alive: () => true }, 0);
		let t = Date.now();
		const t0 = t, now = () => t, sleep = async (ms: number) => void (t += ms);
		const r = await cli(["up"], { ctx: { platform, now, sleep, lock: { now, sleep, alive: () => true, startOf: () => undefined, prepare: () => {} } } });
		lock.release();
		assert.equal(r.errJson?.wait, "lock", `${platform}: ${r.err}`);
		assert.ok(Math.abs(t - t0 - seconds * 1000) <= 100, `${platform}: waited ${(t - t0) / 1000} s, expected ${seconds}`);
	}
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
	const fatals: ((error: unknown) => void)[] = [];
	return { server, calls, signals: (leave: () => void) => void handlers.push(leave), fatal: (leave: (error: unknown) => void) => void fatals.push(leave), fatals, handlers, shutdowns };
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

test("RVD27-F002: a fatal JavaScript error (an uncaught exception or an unhandled rejection) makes the server leave with code 1, which takes the remote serve entry down, in the detached server and in serve", async () => {
	for (const argv of [["run", "--detached"], ["serve"]]) {
		const f = fakeServer();
		let said = "";
		const r = await cli(argv, { server: f.server, signals: f.signals, fatal: f.fatal, err: (t) => (said += t) });
		assert.equal(r.code, 0);
		assert.equal(f.fatals.length, 1, `${argv[0]}: the server listens for fatal errors`);
		f.fatals[0]?.(new Error("boom"));
		assert.deepEqual(f.shutdowns, [1], `${argv[0]}: it leaves with code 1`);
		assert.match(said, /fatal: Error: boom/);
	}
});

test("RVD27B-F002/F003: onFatal listens to both events, leaves once, arms the exit timer before leaving (so a leave that throws is still bounded), and the cli handler survives a reason it cannot print", async () => {
	const { onFatal } = await import("../src/server/fatal.ts");
	const { EventEmitter } = await import("node:events");
	const proc = new EventEmitter(), left: unknown[] = [], timers: number[] = [], exits: number[] = [];
	onFatal((e) => (left.push(e), assert.equal(timers.length, 1, "the timer is armed before leave")), { proc: proc as never, exit: (c) => exits.push(c), after: (run, ms) => (timers.push(ms), run()) });
	proc.emit("unhandledRejection", "a");
	proc.emit("uncaughtException", "b");
	assert.deepEqual(left, ["a"], "once");
	assert.equal(timers.length, 1);
	assert.deepEqual(exits, [1]);
	const thrower = new EventEmitter(), tm: number[] = [];
	onFatal(() => { throw new Error("x"); }, { proc: thrower as never, exit() {}, after: (_r, ms) => void tm.push(ms) });
	assert.throws(() => thrower.emit("uncaughtException", 1));
	assert.equal(tm.length, 1, "armed although leave threw");
	const f = fakeServer();
	let said = "";
	await cli(["serve"], { server: f.server, signals: f.signals, fatal: f.fatal, err: (t) => (said += t) });
	f.fatals[0]?.(Object.create(null));
	assert.deepEqual(f.shutdowns, [1], "the shutdown starts although the reason cannot be printed");
	assert.match(said, /fatal: <unprintable>/);
});

test("RVD27C-F002: without a fatal dependency cli listens through onFatal on the process, and onFatal's own defaults end the process with code 1 after the bound", async (t) => {
	const before = { x: process.listenerCount("uncaughtException"), r: process.listenerCount("unhandledRejection") };
	const f = fakeServer();
	await cli(["serve"], { server: f.server, signals: f.signals, err: () => {} });
	assert.equal(process.listenerCount("uncaughtException"), before.x + 1, "the default wiring listens for uncaught exceptions");
	assert.equal(process.listenerCount("unhandledRejection"), before.r + 1, "and for unhandled rejections");
	for (const event of ["uncaughtException", "unhandledRejection"] as const) process.removeListener(event, process.listeners(event).at(-1)!);
	const { onFatal } = await import("../src/server/fatal.ts");
	const { EventEmitter } = await import("node:events");
	const proc = new EventEmitter(), exits: unknown[] = [], realExit = process.exit;
	t.mock.timers.enable({ apis: ["setTimeout"] });
	process.exit = ((code?: number) => void exits.push(code)) as never;
	try {
		onFatal(() => {}, { proc: proc as never });
		proc.emit("uncaughtException", new Error("x"));
		t.mock.timers.tick(19_999);
		assert.deepEqual(exits, [], "not before the bound");
		t.mock.timers.tick(1);
		assert.deepEqual(exits, [1], "the process ends with code 1 at the bound");
	} finally {
		process.exit = realExit;
	}
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

test("serve clears the server's stop but leaves a GUI stopped on purpose stopped", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	writeRecord(world.slot, { pid: 7, version: "0.44.0", herdr: world.slot.herdr, mode: "detached", desk: false, intercom: {}, log: "/l", socket: "/nowhere", secret: "s".repeat(64), intercomId: "sb-server-00000000", stopped: true, gui: { port: 5000, token: "t".repeat(32), stopped: true } });
	writeFileSync(`${world.slot.dir}/gui.json`, JSON.stringify({ pid: 7, port: 5000, token: "t".repeat(32), owner: "o", stopped: true }));
	const f = fakeServer();
	assert.equal((await cli(["serve"], { server: f.server, signals: f.signals })).code, 0);
	assert.equal(readRecord(world.slot)?.stopped, undefined);
	assert.equal(readRecord(world.slot)?.gui?.stopped, true);
	assert.equal(JSON.parse(readFileSync(`${world.slot.dir}/gui.json`, "utf8")).stopped, true);
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

// --- the desk's items from the Windows VM pass of 0.45.0 (tiny --timeout values) ---

test("up --timeout 1: an owner read that runs out of time is exit 1 with wait start, never exit 3 acl, whether the gate honours the time or ignores it", async () => {
	const s = await world.start();
	await s.handle.ready;
	const honours = async (_slot: unknown, ms?: number) => { await sleep(ms ?? 5000); throw new GateTimeout("the owner of the state folder could not be read (timed out)"); };
	const ignores = async () => { await sleep(3000); return true; };
	for (const gate of [honours, ignores]) {
		const began = Date.now(), stalls = stallWatch();
		const r = await cli(["up", "--timeout", "1"], { ctx: { gate } });
		stalls.stop();
		assert.equal(r.code, 1, r.err);
		assert.equal(r.errJson?.wait, "start");
		assert.equal(r.errJson?.startError, undefined, "no acl refusal");
		assert.doesNotMatch(String(r.errJson?.reason), /^acl:/);
		assert.ok(Date.now() - began < 1500 + stalls.worst(), `within the time given and a margin: ${Date.now() - began} ms (this process stood still for ${stalls.worst()} ms)`);
	}
});

test("up --timeout: the time spent preparing the folder with no one holding server.lock is not reported as a lock wait, and the call ends within 0.5 s of the deadline", async () => {
	// The clock is the test's: preparing the folder takes 400 ms of it, and what the call waited is read off it.
	let clock = fakeClock();
	const prepare = async () => void (await clock.sleep(400));
	const r = await cli(["up", "--timeout", "0.3"], { ctx: { prepare, now: clock.now, sleep: clock.sleep } });
	assert.equal(r.code, 1, r.err);
	assert.notEqual(r.errJson?.wait, "lock", "no one held the lock");
	assert.equal(r.errJson?.wait, "start");
	assert.equal(readLock(world.slot), undefined, "and it left no lock behind");
	assert.equal(clock.elapsed(), 400, "the deadline passed during the 400 ms of preparing, and nothing waited after it");
	// With a real holder the wait is the lock's, and it ends at the deadline too.
	const lock = await takeLock(world.slot, "someone else", { alive: () => true }, 0);
	clock = fakeClock();
	const busy = await cli(["up", "--timeout", "0.3"], { ctx: { now: clock.now, sleep: clock.sleep, lock: { now: clock.now, sleep: clock.sleep, alive: () => true, startOf: () => undefined, prepare: () => {} } } });
	lock.release();
	assert.equal(busy.errJson?.wait, "lock");
	assert.equal(clock.elapsed(), 300, "the lock wait ended at the deadline");
});

test("status drops lastError once the server is ready: a failure of an earlier attempt does not survive a successful start", async () => {
	world.intercomError = new Error("broker down");
	const s = await world.start();
	await s.handle.ready.catch(() => {});
	world.intercomError = undefined;
	const first = await cli(["status"]);
	assert.ok(world.record()?.lastError, "the first server's failure is in the record before the second starts");
	assert.ok(first.json?.lastError, "and status tells it");
	const again = await world.start();
	await again.handle.ready;
	await until(() => world.record()?.pid === again.pid, "the second server's record");
	const live = await cli(["status"]);
	assert.equal(live.json?.state, "live");
	assert.equal(live.json?.lastError, undefined, JSON.stringify(live.json));
	assert.equal(world.record()?.lastError, undefined);
});
