// @ts-nocheck: the plugin scripts are plain JavaScript, and the reaper's panes are loose test data.
// What differs on Windows: Herdr's socket is a named pipe behind a marker file, and so is a sidecar's control socket. The pure parts are
// checked for every platform here; the live parts run on the platform the suite runs on (the Windows CI job runs this file).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCheckoutUser, findProcessHolder, findSessionPane } from "../herdr-reaper/decide.mjs";
import { processClient } from "../herdr-reaper/io.mjs";
import { instanceOf, localEndpoint as pluginEndpoint, socketCall } from "../herdr-plugin/net-view.mjs";
import { agentFiles, ask, NoSidecar, socketIsFile } from "../src/agent/paths.ts";
import { herdrSocket, localEndpoint } from "../src/endpoint.ts";
import { herdrCall } from "../src/herdr.ts";
import { herdrEvents } from "../src/server-watch.ts";

test("herdrSocket resolves the socket as Herdr does: HERDR_SOCKET_PATH, then HERDR_SESSION, in the config directory of the platform", () => {
	const win = String.raw`C:\Users\F\AppData\Roaming`;
	assert.equal(herdrSocket({ HERDR_SOCKET_PATH: "/s/h.sock", HERDR_SESSION: "work", HOME: "/h" }, "darwin"), "/s/h.sock");
	assert.equal(herdrSocket({ HOME: "/h" }, "darwin"), "/h/.config/herdr/herdr.sock");
	assert.equal(herdrSocket({ HOME: "/h", XDG_CONFIG_HOME: "/x" }, "linux"), "/x/herdr/herdr.sock");
	assert.equal(herdrSocket({ HOME: "/h", HERDR_SESSION: "work" }, "linux"), "/h/.config/herdr/sessions/work/herdr.sock");
	assert.equal(herdrSocket({ HOME: "/h", HERDR_SESSION: "default" }, "linux"), "/h/.config/herdr/herdr.sock", "the default session is the default socket");
	assert.equal(herdrSocket({ HOME: "/h", HERDR_SESSION: "a/b" }, "linux"), "/h/.config/herdr/herdr.sock", "Herdr ignores a name it would reject");
	assert.equal(herdrSocket({ APPDATA: win, HOME: "/h" }, "win32"), String.raw`C:\Users\F\AppData\Roaming\herdr\herdr.sock`);
	assert.equal(herdrSocket({ USERPROFILE: String.raw`C:\Users\F` }, "win32"), String.raw`C:\Users\F\AppData\Roaming\herdr\herdr.sock`);
	assert.equal(herdrSocket({ APPDATA: win, HERDR_SESSION: "work" }, "win32"), String.raw`C:\Users\F\AppData\Roaming\herdr\sessions\work\herdr.sock`);
	assert.equal(herdrSocket({ APPDATA: win, XDG_CONFIG_HOME: String.raw`D:\cfg` }, "win32"), String.raw`D:\cfg\herdr\herdr.sock`);
});

test("a client connects to the named pipe named by the socket path on Windows, and to the path itself elsewhere; the plugin agrees", () => {
	const path = String.raw`C:\Users\F\AppData\Roaming\herdr\herdr.sock`;
	assert.equal(localEndpoint(path, "win32"), String.raw`\\.\pipe\C:\Users\F\AppData\Roaming\herdr\herdr.sock`);
	assert.equal(localEndpoint("/h/.config/herdr/herdr.sock", "darwin"), "/h/.config/herdr/herdr.sock");
	for (const platform of ["win32", "linux", "darwin"] as const) assert.equal(pluginEndpoint(path, platform), localEndpoint(path, platform));
});

test("a sidecar's control socket is a named pipe on Windows, one per state directory and pane, and a file beside the state file elsewhere", () => {
	const a = agentFiles("/s", "wA:p1", "win32"), b = agentFiles("/t", "wA:p1", "win32"), c = agentFiles("/s", "wA:p2", "win32");
	assert.match(a.socket, /^\\\\\.\\pipe\\straw-boss-[0-9a-f]{16}$/);
	assert.equal(new Set([a.socket, b.socket, c.socket]).size, 3);
	assert.equal(agentFiles("/s", "wA:p1", "darwin").socket, agentFiles("/s", "wA:p1", "darwin").state.replace(/\.json$/, ".sock"));
	assert.deepEqual([socketIsFile("win32"), socketIsFile("linux"), socketIsFile("darwin")], [false, true, true]);
});

/** A fake Herdr on this platform's transport: on Windows the named pipe of the socket path and a marker file at the path, as Herdr makes them. */
async function fakeHerdr() {
	const dir = mkdtempSync(join(tmpdir(), "psb-platform-")), path = join(dir, "herdr.sock");
	const server = createServer((c) => {
		let text = "";
		c.on("data", (chunk) => {
			text += chunk;
			for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n")) {
				const request = JSON.parse(text.slice(0, at)) as { id: string; method: string };
				text = text.slice(at + 1);
				c.write(`${JSON.stringify({ id: request.id, result: request.method === "events.subscribe" ? { type: "subscription_started" } : { type: "pong" } })}\n`);
			}
		});
		c.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(localEndpoint(path), resolve));
	if (process.platform === "win32") writeFileSync(path, `${process.pid}:${Date.now()}`);
	return { path, close: () => (server.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("the extension, its watch, and the plugin reach Herdr over this platform's transport, and the plugin names the server's run", async () => {
	const fake = await fakeHerdr();
	try {
		assert.deepEqual(await herdrCall(fake.path)("ping", {}), { type: "pong" });
		assert.deepEqual(await socketCall(fake.path)("ping", {}), { type: "pong" });
		const got: unknown[] = [];
		const stop = herdrEvents(fake.path, [10])(["pane.closed"], (event) => got.push(event));
		for (const end = Date.now() + 3000; got.length === 0 && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20));
		stop();
		assert.deepEqual(got, [null], "the subscription was acknowledged");
		assert.match(instanceOf(fake.path), /^\d+:[\d.]+$/);
	} finally {
		fake.close();
	}
});

test("a sidecar's control socket answers on this platform, and a closed one reads as no sidecar", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-platform-agent-")), files = agentFiles(dir, "wA:p1");
	const server: Server = createServer((c) => c.on("data", () => c.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`)).on("error", () => {}));
	mkdirSync(files.dir, { recursive: true });
	try {
		await new Promise<void>((resolve) => server.listen(files.socket, resolve));
		assert.deepEqual(await ask(files.socket, { cmd: "hello" }, 3000), { ok: true, pid: process.pid });
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (socketIsFile()) rmSync(files.socket, { force: true });
		await assert.rejects(ask(files.socket, { cmd: "hello" }, 3000), (error) => error instanceof NoSidecar);
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("on Windows the reaper cannot list processes, so it keeps every checkout, and says why", async () => {
	await assert.rejects(processClient("win32").cwds(), /Windows cannot tell which processes work in a checkout, so the reaper keeps every checkout there/);
});

test("the reaper reads Windows paths: a cwd below a checkout, and a session file's name", () => {
	const roots = [String.raw`C:\wt\linked`];
	assert.match(findCheckoutUser(roots, [{ pane_id: "w:p1", workspace_id: "w", cwd: String.raw`C:\wt\linked\src` }], []) ?? "", /pane w:p1/);
	assert.equal(findCheckoutUser(roots, [{ pane_id: "w:p1", workspace_id: "w", cwd: String.raw`C:\wt\linked-2` }], []), null, "a sibling with the same prefix is not inside");
	assert.match(findProcessHolder(roots, [{ pid: 7, name: "node", cwd: String.raw`C:\wt\linked\a` }]) ?? "", /pid 7/);
	const panes = [{ pane_id: "w:p2", agent: "pi", agent_session: { kind: "path", value: String.raw`C:\Users\F\.pi\agent\sessions\x\2026-10-24_abc.jsonl` } }];
	assert.equal(findSessionPane(panes, "abc"), "w:p2");
});
