import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { herdrCall, HerdrError, herdrRun, herdrWorld, panes, place, report, socketRun, tabs, waitFor, workspaces, worldOf } from "../src/herdr.ts";

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

test("RV8-F001: a herdr command cut off by the timeout rejects as killed with its signal, and one that exited rejects with its exit code", { skip: process.platform === "win32" }, async () => {
	const before = process.env.HERDR_BIN_PATH;
	try {
		process.env.HERDR_BIN_PATH = "/bin/sleep";
		await assert.rejects(herdrRun(["30"], 100), (error: { killed?: boolean; signal?: string; code?: unknown }) => error.killed === true && error.signal === "SIGTERM" && typeof error.code !== "number");
		process.env.HERDR_BIN_PATH = "/usr/bin/false";
		await assert.rejects(herdrRun([]), (error: { killed?: boolean; signal?: unknown; code?: unknown }) => error.killed === false && error.signal === undefined && error.code === 1);
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

test("socketRun answers Herdr's listings over the socket in the CLI's reply shape, and leaves every other command to the CLI", async () => {
	const asked: [string, unknown, number | undefined][] = [], cli: string[][] = [];
	const call = async (method: string, params: Record<string, unknown>, timeoutMs?: number) => (asked.push([method, params, timeoutMs]), method === "pane.list" ? { type: "pane_list", panes: [{ pane_id: "wA:p1" }] } : method === "workspace.list" ? { type: "workspace_list", workspaces: [{ workspace_id: "wA" }] } : { type: "tab_list", tabs: [{ tab_id: "wA:t1" }] });
	const run = socketRun(async (args) => (cli.push(args), JSON.stringify({ result: { pane: { pane_id: "wA:p1" } } })), call, "");
	assert.deepEqual(await panes(run), [{ pane_id: "wA:p1" }]);
	await panes(run, "wA");
	assert.deepEqual(await workspaces(run), [{ workspace_id: "wA" }]);
	assert.deepEqual(await tabs(run, "wA"), [{ tab_id: "wA:t1" }]);
	await run(["pane", "list"], 1234);
	assert.deepEqual(asked, [["pane.list", {}, undefined], ["pane.list", { workspace_id: "wA" }, undefined], ["workspace.list", {}, undefined], ["tab.list", { workspace_id: "wA" }, undefined], ["pane.list", {}, 1234]]);
	assert.deepEqual(cli, []);
	// Nothing else is a listing: writes, single reads, and listings the socket form does not cover go to the CLI as they came.
	// `pane current` without HERDR_PANE_ID, and a report-metadata the socket form does not cover (no source, an unknown flag, a token without `=`), too.
	const others = [["pane", "current"], ["tab", "list"], ["workspace", "list", "--workspace", "wA"], ["pane", "list", "--workspace"], ["pane", "list", "--cwd", "x"], ["pane", "list", "wA"], ["pane", "report-metadata", "wA:p1", "--token", "a=b"], ["pane", "report-metadata", "wA:p1", "--source", "s", "--title", "t"], ["pane", "report-metadata", "wA:p1", "--source", "s", "--token", "ab"], ["tab", "report-metadata", "wA:t1", "--source", "s"], ["tab", "close", "wA:t1"]];
	for (const args of others) await run(args);
	assert.deepEqual(cli, others);
	assert.equal(asked.length, 5);
});

test("socketRun sends pane current for the process's pane and report-metadata over the socket, with the tokens, clears, and TTL report() writes", async () => {
	const asked: [string, unknown][] = [];
	const call = async (method: string, params: Record<string, unknown>) => (asked.push([method, params]), method === "pane.current" ? { type: "pane_current", pane: { pane_id: "wA:p2", tab_id: "wA:t1", workspace_id: "wA" } } : { type: "ok" });
	const run = socketRun(async () => assert.fail("the CLI must not run"), call, "wA:p2");
	assert.deepEqual(await place(run), { paneId: "wA:p2", tabId: "wA:t1", workspaceId: "wA" });
	await report(run, "pane", "wA:p2", { sb_role: "main", sb_name: "a=b", sb_tab: null });
	await report(run, "workspace", "wA", { tower: null });
	assert.deepEqual(asked, [
		["pane.current", { caller_pane_id: "wA:p2" }],
		["pane.report_metadata", { pane_id: "wA:p2", source: "straw-boss", tokens: { sb_role: "main", sb_name: "a=b", sb_tab: null }, ttl_ms: 600000 }],
		["workspace.report_metadata", { workspace_id: "wA", source: "straw-boss", tokens: { tower: null } }],
	]);
});

test("a listing that fails over the socket rejects with Herdr's own error and does not fall back to the CLI", async () => {
	const cli: string[][] = [];
	const run = socketRun(async (args) => (cli.push(args), "{}"), async () => { throw new HerdrError("workspace_not_found", "herdr pane.list failed: workspace_not_found workspace wX not found"); });
	await assert.rejects(panes(run, "wX"), (e: HerdrError) => e instanceof HerdrError && e.code === "workspace_not_found" && /workspace wX not found/.test(e.message));
	await assert.rejects(workspaces(run), (e: HerdrError) => e.code === "workspace_not_found");
	assert.deepEqual(cli, []);
});

test("the listings go over a real socket as one request each, with the workspace id Herdr names it by", async () => {
	const seen: { method: string; params: unknown }[] = [];
	const fake = await socket((request, reply) => {
		seen.push({ method: request.method, params: request.params });
		const result = request.method === "pane.list" ? { type: "pane_list", panes: [{ pane_id: "wA:p1", tab_id: "wA:t1", tokens: { sb_role: "main" } }] } : request.method === "session.snapshot" ? { type: "session_snapshot", snapshot: { panes: [{ pane_id: "wA:p1" }], workspaces: [{ workspace_id: "wA" }], tabs: [{ tab_id: "wA:t1", workspace_id: "wA" }, { tab_id: "wB:t1", workspace_id: "wB" }] } } : undefined;
		reply(`${JSON.stringify(result ? { id: request.id, result } : { id: request.id, error: { code: "workspace_not_found", message: "workspace wX not found" } })}\n`);
	});
	try {
		const call = herdrCall(fake.path), run = socketRun(async () => assert.fail("the CLI must not run"), call);
		assert.deepEqual(await panes(run, "wA"), [{ pane_id: "wA:p1", tab_id: "wA:t1", tokens: { sb_role: "main" } }]);
		await assert.rejects(workspaces(run), (e: HerdrError) => e.code === "workspace_not_found");
		assert.deepEqual(await herdrWorld(call)(), { panes: [{ pane_id: "wA:p1" }], workspaces: [{ workspace_id: "wA" }], tabs: [] });
		assert.deepEqual(seen, [{ method: "pane.list", params: { workspace_id: "wA" } }, { method: "workspace.list", params: {} }, { method: "session.snapshot", params: {} }]);
	} finally {
		fake.close();
	}
});

test("the world is the panes, workspaces, and the asked workspace's tabs of one session.snapshot, or of listings asked together; a snapshot without them is an error", async () => {
	const snapshot = { panes: [{ pane_id: "wA:p1" }], workspaces: [{ workspace_id: "wA" }, { workspace_id: "wB" }], tabs: [{ tab_id: "wA:t1", workspace_id: "wA" }, { tab_id: "wB:t1", workspace_id: "wB" }, { tab_id: "wA:t2", workspace_id: "wA" }] };
	const world = herdrWorld(async (method) => (assert.equal(method, "session.snapshot"), { type: "session_snapshot", snapshot }));
	assert.deepEqual(await world(), { ...snapshot, tabs: [] }, "no workspace asked: no tabs");
	assert.deepEqual((await world("wA")).tabs, [snapshot.tabs[0], snapshot.tabs[2]], "the tabs of one workspace, in the snapshot's order");
	for (const bad of [{}, { snapshot: {} }, { snapshot: { panes: [], workspaces: [] } }, { snapshot: { panes: {}, workspaces: [], tabs: [] } }]) await assert.rejects(herdrWorld(async () => bad)(), /session\.snapshot returned no panes, workspaces, or tabs/);
	const order: string[] = [];
	const run = async (args: string[]) => (order.push(`start ${args[0]}`), await Promise.resolve(), order.push(`end ${args[0]}`), JSON.stringify({ result: args[0] === "pane" ? { panes: [] } : args[0] === "tab" ? { tabs: [{ tab_id: "wA:t1" }] } : { workspaces: [] } }));
	assert.deepEqual(await worldOf(run)(), { panes: [], workspaces: [], tabs: [] });
	assert.deepEqual(await worldOf(run)("wA"), { panes: [], workspaces: [], tabs: [{ tab_id: "wA:t1" }] });
	assert.deepEqual(order.slice(0, 6), ["start pane", "start workspace", "end pane", "end workspace", "start pane", "start workspace"], "the listings are in flight together");
});
