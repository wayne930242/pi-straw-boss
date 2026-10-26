// @ts-nocheck: the plugin script is plain JavaScript.
// What differs on Windows: Herdr's socket is a named pipe behind a marker file, and a sidecar's control socket is a named pipe. The pure parts are
// checked for every platform here; the live parts run on the platform the suite runs on (the Windows CI job runs this file).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { instanceOf, localEndpoint as pluginEndpoint, socketCall } from "../herdr-plugin/net-view.mjs";
import { agentFiles, ask, newPipe, NoSidecar, socketIsFile, socketOf } from "../src/agent/paths.ts";
import { herdrSocket, localEndpoint } from "../src/endpoint.ts";
import { herdrCall } from "../src/herdr.ts";
import { cmdHidden } from "../src/hidden.ts";
import { listDirs, pickable } from "../src/spawn.ts";
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

test("a sidecar's control socket is a file beside its state file, or on Windows a named pipe of random name that its state file records", () => {
	const files = agentFiles("/s", "wA:p1");
	assert.equal(files.socket, files.state.replace(/\.json$/, ".sock"));
	const [a, b] = [newPipe(), newPipe()];
	assert.match(a, /^\\\\\.\\pipe\\straw-boss-[0-9a-f]{32}$/);
	assert.notEqual(a, b, "no other account can know the name before the sidecar makes it");
	const held = { pid: 1, session: "s", kind: "claude", pane: "wA:p1", id: "i", name: "n", startedAt: 0 };
	assert.equal(socketOf(files, { ...held, pipe: a }), a);
	assert.equal(socketOf(files, held), files.socket);
	assert.equal(socketOf(files, undefined), files.socket);
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
	const dir = mkdtempSync(join(tmpdir(), "psb-platform-agent-")), files = agentFiles(dir, "wA:p1"), socket = socketIsFile() ? files.socket : newPipe();
	const server: Server = createServer((c) => c.on("data", () => c.end(`${JSON.stringify({ ok: true, pid: process.pid })}\n`)).on("error", () => {}));
	mkdirSync(files.dir, { recursive: true });
	try {
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		assert.deepEqual(await ask(socket, { cmd: "hello" }, 3000), { ok: true, pid: process.pid });
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (socketIsFile()) rmSync(socket, { force: true });
		await assert.rejects(ask(socket, { cmd: "hello" }, 3000), (error) => error instanceof NoSidecar);
	} finally {
		server.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every module a Windows session or sidecar loads links on this platform (a named import Windows lacks fails before any code runs)", async () => {
	for (const path of ["../src/index.ts", "../src/closing.ts", "../src/agent/sidecar.ts", "../src/agent/cli.ts", "../herdr-plugin/net-view.mjs"]) await import(path);
});

// The folder picker on a real Windows profile layout (src/hidden.ts): attributes set with attrib, junctions made as the old profile layout has them, and the
// default reader (cmd.exe) in between. The names are not the localised ones of a real profile, but a Chinese one is there to check the encoding.
test("the folder picker leaves out what Windows hides (Hidden or System, junctions among them) and keeps the other folders", { skip: process.platform !== "win32" }, async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "psb-platform-home-")));
	try {
		for (const name of ["Desktop", "Documents", "AppData", "HiddenOnly", "SystemOnly", "\u9801\u9762", "\u300c\u958b\u59cb\u300d\u529f\u80fd\u8868"]) mkdirSync(join(home, name));
		symlinkSync(join(home, "Documents"), join(home, "My Documents"), "junction");
		symlinkSync(join(home, "Documents"), join(home, "Plain Link"), "junction");
		execFileSync("attrib", ["+h", join(home, "AppData")]);
		execFileSync("attrib", ["+h", join(home, "HiddenOnly")]);
		execFileSync("attrib", ["+s", join(home, "SystemOnly")]);
		execFileSync("attrib", ["+h", "+s", join(home, "\u300c\u958b\u59cb\u300d\u529f\u80fd\u8868")]);
		execFileSync("attrib", ["+h", "+s", "/L", join(home, "My Documents")]); // the junction itself, as the profile's compatibility links have it
		assert.deepEqual((await listDirs(home, home)).dirs.sort(), ["Desktop", "Documents", "Plain Link", "\u9801\u9762"].sort());
		for (const refused of ["AppData", "HiddenOnly", "SystemOnly", "My Documents", "\u300c\u958b\u59cb\u300d\u529f\u80fd\u8868"]) assert.equal(await pickable(join(home, refused), home), undefined, refused);
		for (const ok of ["Desktop", "Documents", "Plain Link", "\u9801\u9762"]) assert.ok(await pickable(join(home, ok), home), ok);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

// The folder name reaches cmd.exe through an environment variable inside quotes: the characters cmd treats as syntax must stay text, and a folder that cannot be
// read must fail instead of reading as "nothing hidden".
test("the cmd reader takes a folder named with cmd's own syntax literally, and fails on one it cannot read", { skip: process.platform !== "win32" }, async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-platform-cmd-")));
	try {
		for (const name of ["a & b", "c ^ d", "100%", "%PATH%", "wow!", "paren)", "(open", "x & echo pwned & y"]) {
			const dir = join(root, name);
			mkdirSync(join(dir, "Hid"), { recursive: true });
			mkdirSync(join(dir, "Sys"));
			mkdirSync(join(dir, "Plain"));
			execFileSync("attrib", ["+h", join(dir, "Hid")]);
			execFileSync("attrib", ["+s", join(dir, "Sys")]);
			assert.deepEqual([...await cmdHidden(dir)].sort(), ["hid", "sys"], name);
		}
		assert.deepEqual([...await cmdHidden(root)], [], "no match is an empty answer");
		await assert.rejects(cmdHidden(join(root, "missing")), /could not say/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
