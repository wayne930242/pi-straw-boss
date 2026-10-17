import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { herdrCall, HerdrError, herdrRun, place, report, waitFor } from "../src/herdr.ts";

test("report puts the positional id first, adds a TTL only when it sets a token, and clears with --clear-token", async () => {
	const calls: string[][] = [];
	const run = async (args: string[]) => (calls.push(args), "");
	await report(run, "pane", "wA:p1", { sb_role: "main" });
	await report(run, "workspace", "wA", { tower: null });
	await report(run, "pane", "wA:p1", { a: "1", b: null });
	assert.deepEqual(calls, [
		["pane", "report-metadata", "wA:p1", "--source", "straw-boss", "--ttl-ms", "600000", "--token", "sb_role=main"],
		["workspace", "report-metadata", "wA", "--source", "straw-boss", "--clear-token", "tower"],
		["pane", "report-metadata", "wA:p1", "--source", "straw-boss", "--ttl-ms", "600000", "--token", "a=1", "--clear-token", "b"],
	]);
});

test("waitFor returns the first truthy value and gives up after the budget", async () => {
	let calls = 0;
	assert.equal(await waitFor(async () => {}, () => (++calls === 3 ? "ready" : undefined), 1000), "ready");
	calls = 0;
	assert.equal(await waitFor(async () => {}, () => (++calls, undefined), 500, 100), undefined);
	assert.equal(calls, 6);
});

test("a herdr reply that is not JSON, and a herdr binary that fails, name the command", async () => {
	await assert.rejects(place(async () => "not json"), /herdr pane current returned invalid JSON: not json/);
	const before = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = "/nonexistent/herdr";
	try {
		await assert.rejects(herdrRun(["pane", "current"]), /herdr pane current failed/);
	} finally {
		if (before === undefined) delete process.env.HERDR_BIN_PATH;
		else process.env.HERDR_BIN_PATH = before;
	}
});

/** A fake Herdr socket: each connection gets `answer` with the request it read. */
async function socket(answer: (request: { id: string; method: string; params: unknown }, reply: (chunk: Buffer | string) => void, end: () => void) => void) {
	const dir = mkdtempSync(join(tmpdir(), "psb-sock-")), path = join(dir, "herdr.sock");
	const server = createServer((c) => {
		let text = "";
		c.on("data", (chunk) => {
			text += chunk;
			if (text.includes("\n")) answer(JSON.parse(text.split("\n")[0]!), (chunk) => c.write(chunk), () => c.end());
		});
		c.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	return { path, close: () => (server.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("herdrCall returns Herdr's result, even split mid-character across reads, and rejects with Herdr's code", async () => {
	const seen: string[] = [];
	const fake = await socket((request, reply, end) => {
		seen.push(request.method);
		if (request.method === "pane.get") {
			const frame = Buffer.from(`${JSON.stringify({ id: request.id, result: { pane: { label: "測試" } } })}\n`), cut = frame.indexOf(Buffer.from("測")) + 1;
			reply(frame.subarray(0, cut));
			setTimeout(() => reply(frame.subarray(cut)), 20);
		} else if (request.method === "agent.prompt") reply(`${JSON.stringify({ id: request.id, error: { code: "agent_blocked", message: "the agent is blocked" } })}\n`);
		else if (request.method === "pane.close") end();
		else if (request.method === "bad") reply("not json\n");
	});
	try {
		const call = herdrCall(fake.path);
		assert.deepEqual(await call("pane.get", { pane_id: "wA:p1" }), { pane: { label: "測試" } });
		await assert.rejects(call("agent.prompt", { target: "wA:p1", text: "hi" }), (e: HerdrError) => e instanceof HerdrError && e.code === "agent_blocked");
		await assert.rejects(call("pane.close", {}), (e: HerdrError) => e.code === "closed");
		await assert.rejects(call("bad", {}), (e: HerdrError) => e.code === "bad_frame");
		await assert.rejects(call("pane.read", {}, 100), (e: HerdrError) => e.code === "timeout" && /no answer within 100 ms/.test(e.message));
		await assert.rejects(herdrCall(join(tmpdir(), "psb-no-such.sock"))("ping", {}), (e: HerdrError) => e.code === "socket_error");
		assert.deepEqual(seen, ["pane.get", "agent.prompt", "pane.close", "bad", "pane.read"]);
	} finally {
		fake.close();
	}
});
