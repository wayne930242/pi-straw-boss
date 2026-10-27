import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { answersLive, writeRecordFile, type GuiRecord } from "../src/handover.ts";
import { TOWER_LABEL } from "../src/herdr.ts";
import { createStartOf } from "../src/startof.ts";
import { guiUp, registerTrust, warmServerStart } from "../src/trust/ask.ts";
import { trustDir } from "../src/trust/files.ts";
import { until, World } from "./fakes.ts";

// The tower's dashboard and the trust question probe the recorded GUI through answersLive: the token goes to the port only when the process that recorded it is shown to be the one that runs (RC2-F001).

const closers: (() => Promise<void>)[] = [];
afterEach(async () => void (await Promise.all(closers.splice(0).map((c) => c()))));

/** A web server that answers 200 to every path and keeps the paths it was sent. */
async function squatter() {
	const seen: string[] = [];
	const server = createServer((req, res) => (seen.push(req.url!), req.resume(), res.writeHead(200).end("page")));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	closers.push(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
	return { seen, port: (server.address() as { port: number }).port };
}
const record = (port: number, over: Partial<GuiRecord> = {}): GuiRecord => ({ pid: process.pid, started: "T-1", port, token: "secret-token", owner: "sb server", ...over });

test("answersLive sends the token to a port whose recorded process runs with the recorded start time", async () => {
	const { seen, port } = await squatter();
	assert.equal(await answersLive(record(port), { later: async () => "T-1" }), true);
	assert.deepEqual(seen, ["/secret-token/"]);
});

test("answersLive sends nothing to a port whose recorded pid is dead, whose start time is unknown or differs, or was not recorded", async () => {
	const { seen, port } = await squatter();
	assert.equal(await answersLive(record(port, { pid: 999_991 }), { later: async () => "T-1" }), false, "a dead pid");
	assert.equal(await answersLive(record(port), { later: async () => undefined }), false, "a start time the machine cannot tell yet");
	assert.equal(await answersLive(record(port), { later: async () => "T-other" }), false, "a start time that differs");
	assert.equal(await answersLive(record(port, { started: undefined }), { later: async () => "T-1" }), false, "a record without a start time");
	assert.deepEqual(seen, [], "the squatter was sent nothing");
});

/** A Windows start time whose read takes `ms`: the launch of the PowerShell is faked, the cache is the real one. */
const winStart = (ms: number, now?: () => number) => createStartOf({ platform: "win32", launch: ((_f: string, _a: string[], _o: unknown, done: (error: Error | null, out: string) => void) => void setTimeout(() => done(null, "2026-10-27T10:00:00.000Z"), ms)) as never, ...(now ? { now } : {}) });

test("RC3-F001: answersLive on a cold Windows cache waits for the start time read and relays", async () => {
	const { seen, port } = await squatter();
	const cold = winStart(400);
	assert.equal(cold.startOf(process.ppid), undefined, "the cache is cold");
	assert.equal(await answersLive(record(port, { pid: process.ppid, started: "2026-10-27T10:00:00.000Z" }), { later: cold.startedLater, waitMs: 3000 }), true);
	assert.deepEqual(seen, ["/secret-token/"]);
});

test("RC3-F001: a start time that is not in within the bound stays unknown and nothing is sent", async () => {
	const { seen, port } = await squatter();
	const slow = winStart(2000);
	assert.equal(await answersLive(record(port, { pid: process.ppid, started: "2026-10-27T10:00:00.000Z" }), { later: slow.startedLater, waitMs: 100 }), false);
	assert.deepEqual(seen, []);
});

test("RC3-F003: after the cached start time expires the dashboard's probe waits for the new read instead of dropping out", async () => {
	const { port } = await squatter();
	let clock = 0;
	const win = winStart(100, () => clock);
	const r = record(port, { pid: process.ppid, started: "2026-10-27T10:00:00.000Z" });
	assert.equal(await answersLive(r, { later: win.startedLater, waitMs: 3000 }), true);
	clock += 11 * 60_000;
	assert.equal(await answersLive(r, { later: win.startedLater, waitMs: 3000 }), true, "a cache older than 10 minutes");
});

// What tower and trust do with it: they call answersLive through the session's own `startRead` (cfg.startRead; the process's cache and 6 s when a test leaves it out), so a cold Windows
// source reaches them as it does in production. RC3-F001 came back with no test failing when this path was cache-only (RC4-F001).

const T0 = "2026-10-27T10:00:00.000Z", SOCKET = "/tmp/herdr-test.sock", ENV = { HERDR_SOCKET_PATH: SOCKET, HERDR_PANE_ID: "w1-1" } as NodeJS.ProcessEnv;
const scratch = mkdtempSync(join(tmpdir(), "psb-live-"));
/** A state directory whose gui.json names a server that reads trust requests for this Herdr, running as process.ppid since T0 unless said otherwise. */
const stateWith = (port: number, over: Partial<GuiRecord> | null = {}) => {
	const dir = mkdtempSync(join(scratch, "state-"));
	if (over) writeRecordFile(dir, record(port, { pid: process.ppid, started: T0, trust: 1, herdr: SOCKET, ...over }));
	return dir;
};
/** A Windows source whose PowerShell starts are counted. */
const counted = (ms: number) => {
	const reads: number[] = [];
	const source = createStartOf({ platform: "win32", launch: ((_f: string, _a: string[], _o: unknown, done: (error: Error | null, out: string) => void) => (reads.push(reads.length), void setTimeout(() => done(null, T0), ms))) as never });
	return { reads, ...source };
};

test("RC4-F001: the trust question's `up` on a cold Windows source waits for the read and relays; past the bound it sends nothing", async () => {
	const { seen, port } = await squatter();
	const cold = counted(300);
	assert.equal(await guiUp(stateWith(port), ENV, { later: cold.startedLater, waitMs: 3000 })(), true);
	assert.deepEqual(seen, ["/secret-token/"]);
	const slow = counted(2000), before = seen.length;
	assert.equal(await guiUp(stateWith(port), ENV, { later: slow.startedLater, waitMs: 100 })(), false);
	assert.equal(seen.length, before, "nothing was sent after the bound");
});

test("RC4-F001: `up` is false, without reading a start time, for a stopped server, one without trust, another Herdr's, or no record", async () => {
	const { seen, port } = await squatter();
	const cold = counted(10);
	for (const [name, dir] of [["stopped", stateWith(port, { stopped: true })], ["no trust", stateWith(port, { trust: undefined })], ["another Herdr", stateWith(port, { herdr: "/tmp/other.sock" })], ["no record", stateWith(port, null)]] as const) {
		assert.equal(await guiUp(dir, ENV, { later: cold.startedLater, waitMs: 3000 })(), false, name);
	}
	assert.deepEqual([cold.reads.length, seen], [0, []]);
});

test("RC4-F002: the early read starts for a live server that reads trust requests, and only then", async () => {
	const { port } = await squatter();
	const live = counted(10);
	warmServerStart(stateWith(port), ENV, { later: live.startedLater });
	assert.equal(live.reads.length, 1, "a live server: the read is under way");
	await until(() => live.startOf(process.ppid) === T0, "the read to land in the cache");
	for (const [name, dir] of [["a stale gui.json (dead pid)", stateWith(port, { pid: 999_991 })], ["a stopped server", stateWith(port, { stopped: true })], ["no trust", stateWith(port, { trust: undefined })], ["another Herdr", stateWith(port, { herdr: "/tmp/other.sock" })], ["no start time recorded", stateWith(port, { started: undefined })], ["no gui.json", stateWith(port, null)]] as const) {
		const cold = counted(10);
		warmServerStart(dir, ENV, { later: cold.startedLater });
		assert.equal(cold.reads.length, 0, `${name}: no read, no PowerShell`);
	}
});

test("RC4-F001/F002: registerTrust starts the early read at load, and its handler asks the GUI through the session's own source", async () => {
	const { seen, port } = await squatter();
	const guiDir = stateWith(port), cwd = mkdtempSync(join(scratch, "cwd-")), cold = counted(300);
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = { on: (type: string, handler: (event: unknown, ctx: unknown) => unknown) => void handlers.set(type, handler) } as never;
	let keyed = () => {};
	const stdin = { isTTY: true, isRaw: false, setRawMode: () => {}, resume: () => {}, pause: () => {}, on: (_e: string, cb: () => void) => void (keyed = cb), off: () => {} };
	const proc = { pid: process.pid, on: () => {}, off: () => {}, listenerCount: () => 1, kill: () => {} };
	const out: string[] = [];
	registerTrust(pi, { cfg: { env: ENV, now: Date.now, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), startRead: { later: cold.startedLater, waitMs: 3000 } } as never, guiDir }, { stdin, proc, write: (text) => void out.push(text) });
	assert.equal(cold.reads.length, 1, "the read started when the extension loaded");
	const decided = handlers.get("project_trust")!({ cwd }, { mode: "tui", hasUI: true }) as Promise<{ trusted: string }>;
	await until(() => existsSync(trustDir(guiDir)) && readdirSync(trustDir(guiDir)).some((f) => /^[0-9a-f-]{36}\.json$/.test(f)), "the request file: the GUI was found live through the cold source");
	assert.deepEqual(seen, ["/secret-token/"], "the token went to the port once the start time matched");
	assert.equal(cold.reads.length, 1, "the question used the read that was under way");
	keyed();
	assert.deepEqual(await decided, { trusted: "undecided" }, "a key in the terminal hands over to pi's prompt");
});

test("RC4-F001: a start time that is not in within the bound leaves registerTrust's question to the terminal and sends nothing", async () => {
	const { seen, port } = await squatter();
	const guiDir = stateWith(port), cwd = mkdtempSync(join(scratch, "cwd-")), slow = counted(2000);
	let handler: ((event: unknown, ctx: unknown) => unknown) | undefined;
	const pi = { on: (type: string, h: (event: unknown, ctx: unknown) => unknown) => void (type === "project_trust" && (handler = h)) } as never;
	const stdin = { isTTY: true, isRaw: false, setRawMode: () => {}, resume: () => {}, pause: () => {}, on: () => {}, off: () => {} };
	registerTrust(pi, { cfg: { env: ENV, now: Date.now, sleep: async () => {}, startRead: { later: slow.startedLater, waitMs: 100 } } as never, guiDir }, { stdin, proc: { pid: process.pid, on: () => {}, off: () => {}, listenerCount: () => 1, kill: () => {} }, write: () => {} });
	assert.deepEqual(await handler!({ cwd }, { mode: "tui", hasUI: true }), { trusted: "undecided" });
	assert.deepEqual(seen, []);
	assert.equal(existsSync(trustDir(guiDir)), false, "no request was written");
});

test("RC4-F001: the tower's dashboard finds the GUI through the session's own source, and shows none past the bound", async () => {
	const world = new World();
	try {
		const { seen, port } = await squatter();
		const cold = counted(300), tower = world.tower("tower-cold", "wA:t7", "wA:p7", true, { stateDir: stateWith(port), startRead: { later: cold.startedLater, waitMs: 3000 } });
		await tower.start();
		const component = tower.components.get("straw-boss-dashboard")!;
		// The first reading already carries the line: the probe waited for the start time. A cache-only probe shows "GUI not running" first and the URL only at a later refresh.
		await until(() => component.render(80)[0]!.includes(`${TOWER_LABEL} Alpha`), "the first reading", 5000);
		assert.ok(component.render(80).some((line) => line.includes(`http://127.0.0.1:${port}/secret-token/`)), "the GUI line is in the first reading");
		assert.deepEqual(seen.slice(0, 1), ["/secret-token/"]);
		const slow = counted(2000), late = new World();
		try {
			const before = seen.length, other = late.tower("tower-slow", "wA:t7", "wA:p7", true, { stateDir: stateWith(port), startRead: { later: slow.startedLater, waitMs: 100 } });
			await other.start();
			await until(() => other.components.get("straw-boss-dashboard")?.render(80)[0]?.includes(`${TOWER_LABEL} Alpha`), "the first reading");
			assert.ok(other.components.get("straw-boss-dashboard")!.render(80).some((line) => line.includes("GUI not running")), "no GUI line: the start time was not in within the bound");
			assert.equal(seen.length, before, "nothing was sent after the bound");
			await other.stop();
		} finally {
			await late.stopAll();
		}
	} finally {
		await world.stopAll();
	}
});
