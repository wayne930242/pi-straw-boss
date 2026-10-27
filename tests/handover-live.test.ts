import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { answersLive, startBounded, type GuiRecord } from "../src/handover.ts";
import { createStartOf } from "../src/startof.ts";

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
	assert.equal(await answersLive(record(port), () => "T-1"), true);
	assert.deepEqual(seen, ["/secret-token/"]);
});

test("answersLive sends nothing to a port whose recorded pid is dead, whose start time is unknown or differs, or was not recorded", async () => {
	const { seen, port } = await squatter();
	assert.equal(await answersLive(record(port, { pid: 999_991 }), () => "T-1"), false, "a dead pid");
	assert.equal(await answersLive(record(port), () => undefined), false, "a start time the machine cannot tell yet");
	assert.equal(await answersLive(record(port), () => "T-other"), false, "a start time that differs");
	assert.equal(await answersLive(record(port, { started: undefined }), () => "T-1"), false, "a record without a start time");
	assert.deepEqual(seen, [], "the squatter was sent nothing");
});

/** A Windows start time whose read takes `ms`: the launch of the PowerShell is faked, the cache is the real one. */
const winStart = (ms: number, now?: () => number) => createStartOf({ platform: "win32", launch: ((_f: string, _a: string[], _o: unknown, done: (error: Error | null, out: string) => void) => void setTimeout(() => done(null, "2026-10-27T10:00:00.000Z"), ms)) as never, ...(now ? { now } : {}) });

test("RC3-F001: answersLive on a cold Windows cache waits for the start time read and relays", async () => {
	const { seen, port } = await squatter();
	const cold = winStart(400);
	assert.equal(cold.startOf(process.ppid), undefined, "the cache is cold");
	assert.equal(await answersLive(record(port, { pid: process.ppid, started: "2026-10-27T10:00:00.000Z" }), (pid) => startBounded(pid, 3000, cold.startedLater)), true);
	assert.deepEqual(seen, ["/secret-token/"]);
});

test("RC3-F001: a start time that is not in within the bound stays unknown and nothing is sent", async () => {
	const { seen, port } = await squatter();
	const slow = winStart(2000);
	assert.equal(await answersLive(record(port, { pid: process.ppid, started: "2026-10-27T10:00:00.000Z" }), (pid) => startBounded(pid, 100, slow.startedLater)), false);
	assert.deepEqual(seen, []);
});

test("RC3-F003: after the cached start time expires the dashboard's probe waits for the new read instead of dropping out", async () => {
	const { port } = await squatter();
	let clock = 0;
	const win = winStart(100, () => clock);
	const r = record(port, { pid: process.ppid, started: "2026-10-27T10:00:00.000Z" });
	assert.equal(await answersLive(r, (pid) => startBounded(pid, 3000, win.startedLater)), true);
	clock += 11 * 60_000;
	assert.equal(await answersLive(r, (pid) => startBounded(pid, 3000, win.startedLater)), true, "a cache older than 10 minutes");
});
