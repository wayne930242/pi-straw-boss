// @ts-nocheck: the plugin script is plain JavaScript.
// What differs on Windows: Herdr's socket is a named pipe behind a marker file, and a sidecar's control socket is a named pipe. The pure parts are
// checked for every platform here; the live parts run on the platform the suite runs on (the Windows CI job runs this file).
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { instanceOf, localEndpoint as pluginEndpoint, socketCall } from "../herdr-plugin/net-view.mjs";
import { agentFiles, ask, newPipe, NoSidecar, socketIsFile, socketOf } from "../src/agent/paths.ts";
import { herdrSocket, localEndpoint } from "../src/endpoint.ts";
import { markReload, readRecord, writeRecord, writeRecordFile } from "../src/handover.ts";
import { herdrCall } from "../src/herdr.ts";
import { cmdHidden } from "../src/hidden.ts";
import { listDirs, pickable } from "../src/spawn.ts";
import { startedLater, startOf } from "../src/startof.ts";
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

// S7: Windows has no `ps`, so a start time comes from PowerShell, in the background (one call took 2 to 3 s on the Windows 11 ARM VM). The ISO form is Windows-only; the rest holds on every platform.
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
test("S7: this process's start time is known after the background read, the same on every call, and asking never waits on PowerShell", async () => {
	const t0 = Date.now(), first = startOf(process.pid);
	assert.ok(Date.now() - t0 < 500, "the first call returns at once (on Windows undefined, with the read going on in the background)");
	const known = await startedLater(process.pid);
	assert.ok(known, "startOf(process.pid) is defined once the read is in");
	assert.equal(startOf(process.pid), known);
	assert.equal(startOf(process.pid), known, "the same on two calls");
	if (first) assert.equal(first, known);
	if (process.platform === "win32") assert.match(known!, ISO);
	assert.equal(await startedLater(2 ** 22 + 1), undefined, "no such process");
});

test("S7: another process's start time is told, not earlier than this process's, and cached by PID", async () => {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
	try {
		const mine = await startedLater(process.pid), theirs = await startedLater(child.pid!);
		assert.ok(theirs, "a live process's start time");
		if (process.platform === "win32") assert.match(theirs!, ISO);
		assert.ok(Date.parse(/Z$/.test(theirs!) ? theirs! : `${theirs} UTC`) >= Date.parse(/Z$/.test(mine!) ? mine! : `${mine} UTC`) - 1000, "the child started after this process");
		assert.equal(startOf(child.pid!), theirs, "answered from the cache");
	} finally {
		child.kill();
	}
});

test("S7 (R1-F003): a protected process's (services.exe, lsass.exe) start time is told without elevation", { skip: process.platform !== "win32" }, async () => {
	const told: string[] = [];
	for (const image of ["services.exe", "lsass.exe"]) {
		const csv = spawnSync("tasklist", ["/FI", `IMAGENAME eq ${image}`, "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout, pid = Number(/^"[^"]*","(\d+)"/m.exec(csv)?.[1]);
		if (!pid) continue; // not listed to this user
		const started = await startedLater(pid);
		assert.ok(started, `${image} (${pid}) has a start time`);
		assert.match(started!, ISO);
		assert.equal(startOf(pid), started, "answered from the cache");
		told.push(image);
	}
	assert.ok(told.length > 0, "tasklist listed at least one of services.exe and lsass.exe");
});

test("S7: a gui.json written by this process carries `started` once the background read is in, and survives the writes of a stop mark and a reload mark", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-platform-gui-"));
	try {
		const gui = { port: 5000, remotePort: 5001, token: "t".repeat(32), csrf: "c".repeat(32) } as never;
		const written = writeRecord(dir, gui, ["owner", "session"], "0.43.0", "/h.sock") as { late?: Promise<boolean> };
		if (written.late) assert.equal(await written.late, true, "the record was written again with the start time");
		assert.equal(readRecord(dir)!.started, await startedLater(process.pid));
		assert.ok(readRecord(dir)!.started);
		markReload(dir);
		assert.equal(readRecord(dir)!.reload, true);
		assert.equal(readRecord(dir)!.started, await startedLater(process.pid), "kept");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// S4 on Windows: a rename onto a file that a reader has open can fail for a moment (EPERM, EBUSY); the writer tries again.
test("S4: gui.json is replaced by rename while another process reads it in a loop, and no read fails to parse", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-platform-rename-"));
	try {
		const record = (port: number) => ({ pid: process.pid, port, token: "t".repeat(32), owner: "o" });
		writeRecordFile(dir, record(1));
		const reader = spawn(process.execPath, ["-e", `
			const { readFileSync } = require("node:fs");
			let reads = 0, bad = 0, stop = false;
			process.stdin.on("data", () => (stop = true));
			process.stdout.write("ready\\n");
			const loop = () => {
				for (let i = 0; i < 50; i++) { reads++; try { JSON.parse(readFileSync(process.argv[1], "utf8")); } catch { bad++; } }
				if (stop) return process.stdout.write(JSON.stringify({ reads, bad }) + "\\n", () => process.exit(0));
				setImmediate(loop);
			};
			loop();
		`, join(dir, "gui.json")], { stdio: ["pipe", "pipe", "inherit"] });
		let out = "";
		reader.stdout.on("data", (chunk) => (out += chunk));
		for (const end = Date.now() + 10_000; !out.includes("ready") && Date.now() < end; ) await new Promise((resolve) => setTimeout(resolve, 20));
		for (let i = 0; i < 300; i++) writeRecordFile(dir, record(i));
		const done = new Promise<void>((resolve) => reader.on("exit", () => resolve()));
		reader.stdin.end("stop");
		await done;
		const { reads, bad } = JSON.parse(out.split("\n").find((line) => line.startsWith("{"))!) as { reads: number; bad: number };
		assert.ok(reads > 0);
		assert.equal(bad, 0);
		assert.deepEqual(readdirSync(dir), ["gui.json"], "no temporary file is left");
		assert.equal(existsSync(join(dir, "gui.json")), true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
