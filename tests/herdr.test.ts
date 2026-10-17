import assert from "node:assert/strict";
import { test } from "node:test";
import { herdrRun, place, report, waitFor } from "../src/herdr.ts";

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
