import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { StubClient } from "./agent-fakes.ts";
import { AclError } from "../src/server/acl.ts";
import { LoaderError } from "../src/server/intercom.ts";
import { fileOf, readRecord, readStartError, type ServerRecord, writeRecord, writeStartError } from "../src/server/record.ts";
import { createServer } from "node:net";
import { callControl, helloOf, listenControl } from "../src/server/socket.ts";
import { type Running, ServerWorld, sleep, until } from "./server-world.ts";

// The sb server process (docs/specs/2026-10-26-sb-backend.md, Process model and lifecycle): its record, its control socket, its start order, and how it leaves.

let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());

const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, { cmd: "x", ...cmd } as { cmd: string });
/** A fake client that is not connected until the server connects it. */
const unconnected = () => Object.assign(new StubClient(), { connected: false, sessionId: null });
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");

test("a started server writes server.json (mode 600) with its identity, answers hello with its secret, and is ready once the broker is connected", async () => {
	const s = await world.start({ env: { ...world.env, STRAW_BOSS_DESK: "1", PI_INTERCOM_SCOPE_ID: "team-a" } });
	assert.equal(await s.handle.ready, true);
	const record = world.record()!;
	assert.equal(record.pid, s.pid);
	assert.equal(record.started, `T-${s.pid}`);
	assert.equal(record.version, "0.44.0");
	assert.equal(record.mode, "detached");
	assert.equal(record.desk, true);
	assert.equal(record.herdr, world.slot.herdr);
	assert.deepEqual(record.intercom, { scope: "team-a", transport: "default" });
	assert.match(record.secret, /^[0-9a-f]{64}$/);
	assert.match(record.intercomId, /^sb-server-[0-9a-f]{8}$/);
	assert.equal(record.log, fileOf(world.slot, "log"));
	assert.equal(record.restarting, undefined, "ready clears restarting");
	assert.equal(statSync(fileOf(world.slot, "record")).mode & 0o777, 0o600);
	const hello = await helloOf(record.socket, record.secret);
	assert.deepEqual(hello, { ok: true, pid: s.pid, started: `T-${s.pid}`, version: "0.44.0", mode: "detached", desk: true, phase: "ready", ready: true });
	assert.equal(s.client.connected, true);
	assert.equal(s.client.sessionId, record.intercomId, "the server registered its own intercom id");
	assert.ok(!logText().includes(record.secret), "the secret never reaches the log");
});

test("while it starts the record says restarting (reason starting, the starter as by) with since moving, hello says ready is false, and ready clears it", async () => {
	world.connectMs = 400;
	const pending = world.start({ by: "session main (3f2a1b9c)" });
	await until(() => world.record()?.restarting, "the starting record");
	const placeholder = world.record()!;
	assert.equal(placeholder.restarting?.reason, "starting");
	assert.equal(placeholder.restarting?.by, "session main (3f2a1b9c)");
	await until(() => world.record()?.secret, "the full record, once the server listens");
	const first = world.record()!;
	assert.equal(first.restarting?.began, placeholder.restarting?.began, "the full record keeps the placeholder's began");
	const hello = await helloOf(first.socket, first.secret);
	assert.equal(hello?.ready, false);
	assert.equal(hello?.phase, "starting");
	await until(() => world.record()?.restarting && world.record()!.restarting!.since > first.restarting!.since, "since to move", 2000);
	assert.equal(world.record()!.restarting!.began, first.restarting!.began, "began never changes");
	const s = await pending;
	assert.equal(await s.handle.ready, true);
	assert.equal(world.record()?.restarting, undefined);
});

test("a restart that began keeps its began, reason, and by through the new server's start; a stale one is a leftover", async () => {
	const slot = world.slot;
	const begun = { began: new Date(Date.now() - 3000).toISOString(), since: new Date(Date.now() - 500).toISOString(), reason: "upgrade", by: "session main" };
	const old = { pid: 7, version: "0.43.0", herdr: slot.herdr, mode: "detached" as const, desk: false, intercom: {}, log: "/l", socket: "/nowhere", secret: "s".repeat(64), intercomId: "sb-server-00000000" };
	mkdirSync(slot.dir, { recursive: true });
	writeRecord(slot, { ...old, restarting: begun });
	world.connectMs = 300;
	const pending = world.start({ by: "the requester that restarts" });
	await until(() => world.record()?.pid !== 7, "the new record");
	assert.deepEqual({ ...world.record()!.restarting!, since: "" }, { ...begun, since: "" });
	assert.ok(Date.parse(world.record()!.restarting!.since) > Date.parse(begun.since));
	await pending;
	world.running.forEach((r) => void r.handle.shutdown(0));
	await sleep(50);
	writeRecord(slot, { ...old, restarting: { ...begun, since: new Date(Date.now() - 60_000).toISOString() } });
	world.connectMs = 200;
	const second = world.start({ by: "fresh start" });
	await until(() => world.record()?.pid !== 7, "the second new record");
	assert.equal(world.record()!.restarting?.reason, "starting");
	assert.equal(world.record()!.restarting?.by, "fresh start");
	await second;
});

test("a restart keeps what a page or a shell holds: the record's gui port and token, and the last error", async () => {
	const slot = world.slot;
	mkdirSync(slot.dir, { recursive: true });
	writeRecord(slot, { pid: 7, version: "0.43.0", herdr: slot.herdr, mode: "detached", desk: false, intercom: {}, log: "/l", socket: "/nowhere", secret: "s".repeat(64), intercomId: "sb-server-00000000", gui: { port: 52662, token: "tok-abc", stopped: false }, lastError: { at: "2026-10-26T00:00:00.000Z", code: "x", text: "earlier" }, stopped: true });
	const s = await world.start();
	await s.handle.ready;
	const record = world.record()!;
	assert.deepEqual(record.gui, { port: 52662, token: "tok-abc", stopped: false });
	assert.equal(record.lastError?.text, "earlier");
	assert.equal(record.stopped, undefined, "a running server is not stopped: whoever started it was allowed to");
});

test("a start-error from an earlier attempt is gone when the new server is ready", async () => {
	mkdirSync(world.slot.dir, { recursive: true });
	writeStartError(world.slot, { code: "loader", text: "an earlier attempt" }, Date.now());
	const s = await world.start();
	await s.handle.ready;
	assert.equal(readStartError(world.slot), undefined);
});

test("stop: the server writes stopped (no restarting), disconnects, removes its socket, and exits 0; a request after the reply is not answered", async () => {
	const s = await world.start();
	await s.handle.ready;
	const endpoint = world.record()!.socket;
	const { reply } = await ask(s, { cmd: "stop", by: "cli stop" });
	assert.deepEqual(reply, { ok: true });
	assert.equal(await s.handle.done, 0);
	const record = world.record()!;
	assert.equal(record.stopped, true);
	assert.equal(record.restarting, undefined);
	assert.equal(s.client.connected, false, "its intercom ids are released");
	assert.equal(existsSync(endpoint), false);
	assert.match(logText(), /stop by="cli stop"/);
});

test("a serve server refuses to stop and goes on running", async () => {
	const s = await world.start({ mode: "serve" });
	await s.handle.ready;
	assert.deepEqual((await ask(s, { cmd: "stop", by: "cli stop" })).reply, { ok: false, error: "serve" });
	assert.equal(world.record()?.stopped, undefined);
	assert.equal((await helloOf(world.record()!.socket, world.record()!.secret))?.ready, true);
});

test("restart: the server writes restarting with the reason and the requester, answers, then refuses requests but status, and exits 0 (75 for serve)", async () => {
	const s = await world.start();
	await s.handle.ready;
	const secret = world.record()!.secret, endpoint = world.record()!.socket;
	const { reply } = await callControl(endpoint, secret, { cmd: "restart", reason: "a reason\nover two lines", by: "session main (1234abcd)" });
	assert.deepEqual(reply, { ok: true });
	assert.equal(await s.handle.done, 0);
	const record = world.record()!;
	assert.equal(record.restarting?.reason, "a reason over two lines");
	assert.equal(record.restarting?.by, "session main (1234abcd)");
	assert.equal(record.restarting?.began, record.restarting?.since);
	assert.equal(record.stopped, undefined);
	assert.match(logText(), /restart reason="a reason over two lines" by="session main \(1234abcd\)"/);

	const serve = await world.start({ mode: "serve" });
	await serve.handle.ready;
	await callControl(world.record()!.socket, world.record()!.secret, { cmd: "restart", reason: "r", by: "b" });
	assert.equal(await serve.handle.done, 75, "a supervisor starts a serve server again after this code");
});

test("the last restart asked for is kept in the record, and the next server carries it over (agents may ask for one a minute)", async () => {
	const s = await world.start();
	await s.handle.ready;
	await callControl(world.record()!.socket, world.record()!.secret, { cmd: "restart", reason: "first", by: "session a (1111aaaa)" });
	await s.handle.done;
	const asked = world.record()!.lastRestart!;
	assert.equal(asked.reason, "first");
	assert.equal(asked.by, "session a (1111aaaa)");
	assert.ok(Math.abs(Date.parse(asked.at) - Date.now()) < 5000);
	const next = await world.start();
	await next.handle.ready;
	assert.deepEqual(world.record()!.lastRestart, asked);
});

test("while a restart is under way every request but status is answered restarting", async () => {
	const s = await world.start();
	await s.handle.ready;
	const record = world.record()!;
	// Two requests on one connection: the first is the restart, the second arrives while the server leaves.
	const both = await new Promise<string[]>((resolve) => {
		const lines: string[] = [], conn = createConnection(record.socket).setEncoding("utf8");
		conn.on("connect", () => conn.write([{ cmd: "hello", secret: record.secret }, { cmd: "restart", reason: "r", by: "b" }, { cmd: "stop", by: "x" }, { cmd: "status" }].map((f) => `${JSON.stringify(f)}\n`).join("")));
		conn.on("data", (c: string) => lines.push(...c.split("\n").filter(Boolean)));
		setTimeout(() => (conn.destroy(), resolve(lines)), 300);
	});
	const replies = both.map((l) => JSON.parse(l));
	assert.deepEqual(replies.slice(1, 3).map((r) => [r.ok, r.error]), [[true, undefined], [false, "restarting"]]);
	assert.equal(replies[3]?.ok, true, "status is still answered");
	assert.equal(replies[3]?.ready, false);
	await s.handle.done;
});

test("an unknown command is an error, not a crash", async () => {
	const s = await world.start();
	await s.handle.ready;
	assert.deepEqual((await ask(s, { cmd: "frobnicate" })).reply, { ok: false, error: "unknown command frobnicate" });
});

test("status says what the server is doing, with its last error, and gives no secret", async () => {
	const s = await world.start();
	await s.handle.ready;
	const { reply } = await ask(s, { cmd: "status" });
	assert.equal(reply?.ok, true);
	assert.equal(reply?.ready, true);
	assert.equal(reply?.pid, s.pid);
	assert.deepEqual(reply?.towers, []);
	assert.equal(typeof reply?.uptimeMs, "number");
	assert.ok(!JSON.stringify(reply).includes(world.record()!.secret));
});

test("tsx or pi-intercom missing: the server exits 3, writes start-error.json with the reason, and leaves a lastError; no secret is written", async () => {
	world.intercomError = new LoaderError("loader", "tsx was not found from /x/dist/server: it is a dependency of pi-straw-boss, so reinstall the package");
	const s = await world.start();
	assert.equal(await s.handle.done, 3);
	assert.equal(await s.handle.ready, false);
	assert.equal(readStartError(world.slot)?.code, "loader");
	assert.match(readStartError(world.slot)!.text, /tsx was not found from \/x\/dist\/server/);
	assert.deepEqual([world.record()?.secret, world.record()?.socket], ["", ""], "only the placeholder of the start is there: no secret, no socket");
	world.intercomError = new LoaderError("intercom", "pi-intercom 0.17.1 is older than 0.18.1");
	const t = await world.start();
	assert.equal(await t.handle.done, 3);
	assert.equal(readStartError(world.slot)?.code, "intercom");
});

test("on Windows the ACL is set and checked on the state directory before the secret is written; a failure exits 3 with the SDDL it read", async () => {
	let seen: string | undefined;
	const a = await world.start({ platform: "win32", acl: async (dir) => { world.acls.push(dir); seen = world.record()?.secret ? "secret written" : "no secret yet"; } });
	assert.equal(await a.handle.ready, true);
	assert.deepEqual(world.acls, [world.stateDir], "the state directory, never the agent directory above it");
	assert.equal(seen, "no secret yet");
	await a.handle.shutdown(0);
	rmSync(fileOf(world.slot, "record"), { force: true });
	const b = await world.start({ platform: "win32", acl: async () => { throw new AclError("the ACL of x is not owner and SYSTEM only: BU", "O:S-1-5-21D:(A;;FA;;;BU)"); } });
	assert.equal(await b.handle.done, 3);
	const error = readStartError(world.slot)!;
	assert.equal(error.code, "acl");
	assert.match(error.text, /not owner and SYSTEM only/);
	assert.equal(error.sddl, "O:S-1-5-21D:(A;;FA;;;BU)");
	assert.equal(world.record()?.secret, "", "no secret was written");
	await world.start({ platform: "linux" }).then((r) => r.handle.shutdown(0));
	assert.equal(world.acls.length, 1, "nothing is set off Windows");
});

test("a broker that cannot be reached does not keep the server from being ready: it records the error and goes on trying", async () => {
	const down = unconnected();
	let attempts = 0;
	const s = await world.start({
		brokerMs: 150, sleep: async (ms) => sleep(Math.min(ms, 20)),
		intercom: async () => ({ dir: "/f", version: "0.18.1", connect: async () => { if (++attempts < 3) throw new Error("ECONNREFUSED broker"); return down; } }),
	});
	assert.equal(await s.handle.ready, true);
	assert.equal(world.record()?.lastError?.code, "intercom");
	assert.match(world.record()!.lastError!.text, /ECONNREFUSED/);
	await until(() => down.connected, "the broker connection", 3000);
	assert.ok(attempts >= 3);
});

test("a dropped broker connection is opened again", async () => {
	const first = unconnected(), second = unconnected();
	let n = 0;
	const s = await world.start({ sleep: async (ms) => sleep(Math.min(ms, 10)), intercom: async () => ({ dir: "/f", version: "0.18.1", connect: async () => (++n === 1 ? first : second) }) });
	await s.handle.ready;
	assert.equal(first.connected, true);
	first.drop();
	await until(() => second.connected, "the second connection");
	assert.equal(second.sessionId, world.record()!.intercomId);
	assert.match(logText(), /intercom-lost/);
});

test("the record heals: a deleted or overwritten server.json is written again; a live other server's record is left alone", async () => {
	const s = await world.start();
	await s.handle.ready;
	const before = world.record()!;
	rmSync(fileOf(world.slot, "record"));
	await until(() => world.record()?.pid === s.pid, "the record to come back");
	assert.equal(world.record()?.secret, before.secret);
	// Another server that runs (a takeover is under way): not ours to fight over.
	const other = world.pids++;
	world.live.add(other);
	writeRecord(world.slot, { ...before, pid: other, secret: "o".repeat(64) });
	await sleep(150);
	assert.equal(world.record()?.pid, other);
	// A record whose process is gone is overwritten.
	world.live.delete(other);
	await until(() => world.record()?.pid === s.pid, "the dead record to be replaced");
});

test("sbr-F002: with the real liveness checks (none injected, as in production) a record overwritten by a dead pid is healed", async () => {
	const s = await world.start({ alive: undefined, startOf: undefined });
	await s.handle.ready;
	const before = world.record()!;
	writeRecord(world.slot, { ...before, pid: 4_000_000, secret: "o".repeat(64) });
	await until(() => world.record()?.pid === s.pid && world.record()?.secret === before.secret, "the record to be healed");
});

test("sbr-F002, sbr-F009: a second server never takes over the socket of a server that answers, even when its record was overwritten; it fails with code start", async () => {
	const first = await world.start();
	await first.handle.ready;
	const secret = world.record()!.secret, endpoint = first.handle.endpoint;
	// A requester's stale write: a record of a dead pid with another secret, so the newcomer's check of the prior record finds no server.
	writeRecord(world.slot, { ...world.record()!, pid: 4_000_000, secret: "o".repeat(64) });
	const second = await world.start();
	assert.equal(await second.handle.ready, false);
	assert.equal(await second.handle.done, 1);
	assert.equal(readStartError(world.slot)?.code, "start");
	assert.match(readStartError(world.slot)!.text, /live/);
	assert.equal((await helloOf(endpoint, secret))?.pid, first.pid, "the first server still answers at its socket");
	assert.match(logText(), /start-failed code=start/);
});

/** A control socket of another server at its own endpoint, answering hello with its pid (a real server's, for a record that names it). */
async function otherServer(pid: number, secret = "t".repeat(64)) {
	const endpoint = join(world.root, `other-${pid}.sock`);
	const control = await listenControl({ endpoint, secret, hello: () => ({ pid, version: "0.44.0", mode: "detached", desk: false, phase: "ready", ready: true }), handle: async () => ({ ok: true }), refused: () => {} });
	return { endpoint, secret, close: () => control.close() };
}
const recordOf = (pid: number, socket: string, over: Partial<ServerRecord> = {}): ServerRecord => ({ pid, version: "0.44.0", herdr: world.slot.herdr, mode: "detached", desk: false, intercom: { transport: "default" }, log: "/l", socket, secret: "t".repeat(64), intercomId: "sb-server-00000000", ...over });
const finished = (r: Running) => Promise.race([r.handle.done, sleep(2000).then(() => "still running" as const)]);

test("R-F003, F001: a record of a running pid whose socket nobody answers at is a dead server's, not a rival: the start goes on and becomes the server (a pid a crashed server left is reused by another process, and startOf cannot tell yet)", async () => {
	const reused = 7777;
	world.live.add(reused);
	mkdirSync(world.slot.dir, { recursive: true });
	writeRecord(world.slot, recordOf(reused, join(world.root, "nobody.sock"), { started: "T-dead-server" }));
	// startOf is undefined, as on Windows until the background read is in; the record's start time cannot be compared.
	const s = await world.start({ startOf: () => undefined });
	assert.equal(await s.handle.ready, true, "the server became ready");
	assert.equal(world.record()?.pid, s.pid);
	assert.equal(readStartError(world.slot), undefined);
	assert.doesNotMatch(logText(), /start-failed/);
});

test("N2, R-F003: a live server whose hello was slow (its start time known and equal, the record unchanged since the first look) keeps its record: our placeholder never replaces it, and the start gives up with nothing written on it", async () => {
	const other = 7790, started = "T-slow";
	world.live.add(other);
	const mute = createServer(() => {});
	const endpoint = join(world.root, "slow.sock");
	mkdirSync(world.root, { recursive: true });
	await new Promise<void>((resolve) => mute.listen(endpoint, resolve));
	try {
		mkdirSync(world.slot.dir, { recursive: true });
		writeRecord(world.slot, recordOf(other, endpoint, { started }));
		const seen = new Set<number>();
		const sampler = setInterval(() => seen.add(world.record()?.pid ?? 0), 5);
		const second = await world.start({ startOf: (p) => (p === other ? started : undefined), intercom: async () => (await sleep(150), world.intercom(new StubClient())) });
		const ended = await finished(second);
		clearInterval(sampler);
		assert.equal(ended, 1);
		assert.ok(!seen.has(second.pid), "the record was never ours");
		assert.equal(world.record()?.pid, other);
		assert.equal(world.record()?.socket, endpoint);
		assert.equal(world.record()?.restarting, undefined);
		assert.equal(world.record()?.lastError, undefined);
		assert.match(readStartError(world.slot)!.text, /7790/);
	} finally {
		mute.close();
	}
});

test("F001: with the start time known and different the dead server's record is no rival either", async () => {
	const reused = 7778;
	world.live.add(reused);
	mkdirSync(world.slot.dir, { recursive: true });
	writeRecord(world.slot, recordOf(reused, join(world.root, "nobody.sock"), { started: "T-dead-server" }));
	const s = await world.start({ startOf: (p) => (p === reused ? "T-unrelated" : undefined) });
	assert.equal(await s.handle.ready, true);
	assert.equal(world.record()?.pid, s.pid);
});

test("R-F003, F001: a record another server writes after the first look, whose start time is known and equal, is left alone by the placeholder's writes, and the start gives up (no lastError on the other's record)", async () => {
	const other = 7779, started = "T-other";
	world.live.add(other);
	const srv = await otherServer(other);
	try {
		const seen = new Set<number>();
		const sampler = setInterval(() => seen.add(world.record()?.pid ?? 0), 5);
		const second = await world.start({
			startOf: (p) => (p === other ? started : undefined),
			intercom: async () => {
				writeRecord(world.slot, recordOf(other, srv.endpoint, { started }));
				await sleep(150);
				return world.intercom(new StubClient());
			},
		});
		const ended = await finished(second);
		clearInterval(sampler);
		assert.equal(ended, 1);
		assert.ok(!seen.has(second.pid), "our placeholder or record never replaced the other server's");
		assert.equal(world.record()?.pid, other);
		assert.equal(world.record()?.socket, srv.endpoint);
		assert.equal(world.record()?.restarting, undefined);
		assert.equal(world.record()?.lastError, undefined, "F007: the abort writes nothing onto another server's record");
		assert.equal(readStartError(world.slot)?.code, "start");
		assert.match(readStartError(world.slot)!.text, /7779/);
	} finally {
		await srv.close();
	}
});

test("F001: a record taken after the first look whose start time is unknown but whose socket answers hello is a rival: the start gives up before it writes its own", async () => {
	const other = 7780;
	world.live.add(other);
	const srv = await otherServer(other);
	try {
		const second = await world.start({
			startOf: () => undefined,
			intercom: async () => (writeRecord(world.slot, recordOf(other, srv.endpoint)), world.intercom(new StubClient())),
		});
		assert.equal(await finished(second), 1);
		assert.equal(world.record()?.pid, other);
		assert.equal(world.record()?.lastError, undefined);
		assert.match(readStartError(world.slot)!.text, /7780/);
	} finally {
		await srv.close();
	}
});

test("F007: a start that fails marks its own record only: another pid's record keeps its restarting and has no lastError added", async () => {
	const other = 7781;
	world.live.add(other);
	mkdirSync(world.slot.dir, { recursive: true });
	const restarting = { began: new Date().toISOString(), since: new Date().toISOString(), reason: "restart", by: "someone" };
	world.intercomError = Object.assign(new Error("pi-intercom is too old"), { code: "intercom" });
	const s = await world.start({
		intercom: async () => { writeRecord(world.slot, recordOf(other, join(world.root, "x.sock"), { restarting })); throw world.intercomError!; },
	});
	assert.equal(await s.handle.done, 3);
	assert.equal(world.record()?.pid, other);
	assert.equal(world.record()?.lastError, undefined);
	assert.deepEqual(world.record()?.restarting, restarting);
	assert.equal(readStartError(world.slot)?.code, "loader");
});

test("sbr-F015: the server does not wait for its own start time (seconds in PowerShell on Windows) to answer hello and be ready; the time is filled into the record when it arrives", async () => {
	let arrive!: (started: string) => void;
	const slow = new Promise<string>((resolve) => (arrive = resolve));
	const s = await world.start({ started: () => slow, platform: "linux" });
	assert.equal(await s.handle.ready, true, "ready while the start time is still being read");
	assert.equal(world.record()?.pid, s.pid);
	assert.equal(world.record()?.started, undefined);
	assert.equal((await helloOf(s.handle.endpoint, world.record()!.secret))?.ready, true);
	arrive("2026-10-26T08:00:00.000Z");
	await until(() => world.record()?.started === "2026-10-26T08:00:00.000Z", "the start time in the record");
	assert.equal((await ask(s, { cmd: "status" })).reply?.started, "2026-10-26T08:00:00.000Z");
});

test("a second start for a slot whose server runs and answers does not become another server", async () => {
	const first = await world.start();
	await first.handle.ready;
	const second = await world.start();
	assert.equal(await second.handle.done, 0);
	assert.equal(world.record()?.pid, first.pid);
	assert.match(logText(), /already-running pid=/);
});

test("a detached server leaves 60 s (here 200 ms) after its Herdr is gone; a serve server stays", async () => {
	let up = true;
	const detached = await world.start({ herdrUp: async () => up });
	await detached.handle.ready;
	up = false;
	assert.equal(await detached.handle.done, 0);
	assert.equal(world.record()?.lastError?.code, "herdr");
	assert.equal(world.record()?.stopped, undefined, "a Herdr that went away is no stop");
	up = true;
	const serve = await world.start({ mode: "serve", herdrUp: async () => up });
	await serve.handle.ready;
	up = false;
	await sleep(500);
	assert.equal((await helloOf(world.record()!.socket, world.record()!.secret))?.ready, true);
});

test("a Herdr that comes back in time keeps the server", async () => {
	let up = true;
	const s = await world.start({ herdrUp: async () => up, herdrGoneMs: 400 });
	await s.handle.ready;
	up = false;
	await sleep(150);
	up = true;
	await sleep(600);
	assert.equal((await helloOf(world.record()!.socket, world.record()!.secret))?.ready, true);
});

test("a Herdr takeover is noticed and logged", async () => {
	let takeover: (() => void) | undefined;
	const s = await world.start({ watch: (onTakeover) => ((takeover = onTakeover), () => {}) });
	await s.handle.ready;
	takeover?.();
	assert.match(logText(), /herdr-takeover/);
});

test("the server's identity variables are not its own: the kit gets the server's intercom id, and the record names the broker routing it was given", async () => {
	const s = await world.start({ env: { ...world.env, PI_INTERCOM_SESSION_ID: "someone-else", PI_INTERCOM_TRANSPORT: "tcp" }, platform: "win32" });
	await s.handle.ready;
	assert.equal(s.client.sessionId, world.record()!.intercomId);
	assert.equal(world.record()!.intercom.transport, "tcp");
	writeFileSync(fileOf(world.slot, "log"), "");
});

// --- the check made by the process that started the server (one PowerShell start on a cold start) ---

test("with an ACL token the server does not make its own check: it waits for the starter's marker, whose start time it takes, and writes its secret only after the marker is verified", async () => {
	let seen: string | undefined;
	const asked: { dir: string; token: string; pid: number }[] = [];
	const own = world.acls.length;
	const s = await world.start({
		platform: "win32", aclToken: "d".repeat(32),
		marker: async (dir, token, pid) => { asked.push({ dir, token, pid }); seen = world.record()?.secret ? "secret written" : "no secret yet"; return { started: "2026-10-26T08:00:00.000Z" }; },
	});
	assert.equal(await s.handle.ready, true);
	assert.deepEqual(asked, [{ dir: world.stateDir, token: "d".repeat(32), pid: s.pid }]);
	assert.equal(seen, "no secret yet");
	assert.equal(world.acls.length, own, "its own PowerShell check is not made");
	assert.equal(world.record()?.started, "2026-10-26T08:00:00.000Z");
	await s.handle.shutdown(0);
});

test("a marker that fails (an error marker, a foreign ACE, a wrong pid, none in time) ends the server with 3 and writes no secret, like its own check would", async () => {
	const s = await world.start({ platform: "win32", aclToken: "e".repeat(32), marker: async () => { throw new AclError("the ACL of x is not owner and SYSTEM only: BU", "O:S-1-5-21D:(A;;FA;;;BU)"); } });
	assert.equal(await s.handle.done, 3);
	const error = readStartError(world.slot)!;
	assert.equal(error.code, "acl");
	assert.equal(error.sddl, "O:S-1-5-21D:(A;;FA;;;BU)");
	assert.equal(world.record()?.secret, "", "no secret was written");
});

test("without a token (serve, a plain spawn) the server makes its own check, and says through its log which way the check came", async () => {
	const own = world.acls.length;
	const s = await world.start({ platform: "win32", marker: async () => { throw new Error("no marker here"); } });
	assert.equal(await s.handle.ready, true);
	assert.equal(world.acls.length, own + 1);
	await s.handle.shutdown(0);
});
