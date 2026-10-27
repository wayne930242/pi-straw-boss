import assert from "node:assert/strict";
import { createServer } from "node:http";
import { afterEach, test } from "node:test";
import { answersLive, type GuiRecord } from "../src/handover.ts";

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
