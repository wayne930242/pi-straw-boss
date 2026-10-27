import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { get } from "node:http";
import { createServer } from "node:net";
import { afterEach, test } from "node:test";
import { fileOf } from "../src/server/record.ts";
import { World } from "./fakes.ts";
import { fakeTailscale, Hosted, startHosted } from "./gui-world.ts";

// The GUI in the sb server (docs/specs/2026-10-26-sb-backend.md, GUI, `gui.json` and its successor): where it starts, what it records, what a restart keeps, and what stops it.

let world = new World();
const hosted: Hosted[] = [];
afterEach(async () => {
	await Promise.all(hosted.splice(0).map((h) => h.stop()));
	await world.stopAll();
	world = new World();
});
const host = async (over: Parameters<typeof startHosted>[1] = {}) => {
	const h = await startHosted(world, over);
	hosted.push(h);
	return h;
};
const status = (url: string) => new Promise<number>((resolve, reject) => void get(url, { agent: false }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject));

test("the server serves the page from its start: server.json says where (gui: port and token), gui.json is the unchanged contract naming the server, and the log has no token", async () => {
	const h = await host();
	assert.equal(await status(h.url), 200);
	const gui = h.gui(), record = h.record();
	assert.deepEqual(record.gui, { port: gui.port, token: gui.token, stopped: false });
	assert.equal(record.restarting, undefined, "the GUI is bound before restarting is cleared");
	assert.deepEqual({ ...gui, port: 0, remotePort: 0, token: "", csrf: "" }, { pid: h.pid, started: `T-${h.pid}`, port: 0, remotePort: 0, token: "", csrf: "", owner: `sb server (pid ${h.pid})`, ownerSession: record.intercomId, version: "0.45.0", herdr: h.slot.herdr, trust: 1 });
	assert.ok(gui.remotePort && gui.remotePort !== gui.port);
	assert.match(gui.token, /^[0-9a-f]{32}$/);
	assert.ok(existsSync(fileOf(h.slot, "log")));
	const log = readFileSync(fileOf(h.slot, "log"), "utf8");
	assert.ok(log.includes("gui-start") && !log.includes(gui.token) && !log.includes(gui.csrf!), "the token and the CSRF secret never reach the log");
});

/** The server leaves as a restart makes it leave; the next one is the "new server", started by the test. */
async function restart(h: Hosted, over: Parameters<typeof startHosted>[1] = {}) {
	const reply = await h.ask("restart", { reason: "test", by: "test" });
	assert.equal(reply.ok, true);
	await h.handle.done;
	return host(over);
}

test("a restart keeps the URL an open page has: the new server binds the recorded port, token, and CSRF secret, rewrites gui.json for its own pid, and binds only after its intercom id is registered", async () => {
	const h = await host();
	const before = h.gui(), url = h.url;
	const next = await restart(h);
	const after = next.gui();
	assert.deepEqual([after.port, after.remotePort, after.token, after.csrf], [before.port, before.remotePort, before.token, before.csrf]);
	assert.equal(next.url, url);
	assert.notEqual(after.pid, before.pid);
	assert.deepEqual(next.record().gui, { port: before.port, token: before.token, stopped: false });
	assert.equal(await status(url), 200);
	const log = readFileSync(fileOf(next.slot, "log"), "utf8");
	assert.ok(log.indexOf("intercom-connected") < log.indexOf("gui-start"), "the server's ids first, then the GUI's ports");
});

test("a port another process took meanwhile moves only the port: the token and CSRF secret stay, and both records say where it is", async () => {
	const h = await host();
	const before = h.gui();
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	const thief = createServer();
	await new Promise<void>((resolve) => thief.listen(before.port, "127.0.0.1", resolve));
	try {
		const next = await host();
		const after = next.gui();
		assert.notEqual(after.port, before.port);
		assert.deepEqual([after.token, after.csrf], [before.token, before.csrf]);
		assert.deepEqual(next.record().gui, { port: after.port, token: before.token, stopped: false });
		assert.equal(await status(next.url), 200);
	} finally {
		await new Promise((resolve) => thief.close(resolve));
	}
});

test("gui-stop stops the listeners and marks the GUI stopped on purpose in both records while the server runs on; a restart leaves it stopped; an automatic ask is refused, and the boss's own starts it on the same URL and clears both marks", async () => {
	const h = await host();
	const url = h.url, before = h.gui();
	assert.deepEqual(await h.ask("gui-stop"), { ok: true, was: true });
	await assert.rejects(status(url), /ECONNREFUSED/);
	assert.equal(h.record().gui?.stopped, true);
	assert.equal(h.gui().stopped, true);
	assert.equal(h.record().stopped, undefined, "the server itself is not stopped");
	assert.deepEqual(await h.ask("gui-stop"), { ok: true, was: false }, "stopping a stopped GUI is told as such");
	assert.deepEqual(await h.ask("gui", { boss: false }), { ok: false, error: "stopped" }, "an automatic ask does not start it");
	const next = await restart(h);
	assert.equal(next.record().gui?.stopped, true, "a restart keeps the stop");
	assert.equal(next.gui().stopped, true);
	assert.equal(next.gui().pid, next.pid, "and gui.json says whose it is now");
	await assert.rejects(status(url), /ECONNREFUSED/);
	const started = await next.ask("gui", { boss: true });
	assert.equal(started.ok, true);
	assert.equal(started.port, before.port);
	assert.equal(started.token, before.token);
	assert.equal(await status(url), 200);
	assert.equal(next.record().gui?.stopped, false);
	assert.equal(next.gui().stopped, undefined);
});

test("two asks for the GUI at once share one start; an ask when it runs gives its URL again", async () => {
	const h = await host({ gui: { restart: undefined } });
	await h.ask("gui-stop");
	const [a, b] = await Promise.all([h.ask("gui", { boss: true }), h.ask("gui", { boss: true })]);
	assert.deepEqual([a.port, a.token], [b.port, b.token]);
	assert.equal((await h.ask("gui", { boss: false })).port, a.port);
	assert.equal(readFileSync(fileOf(h.slot, "log"), "utf8").split("\n").filter((l) => l.includes("gui-start")).length, 2, "the first start and the one after the stop");
});

test("remote access: gui-remote turns it on and answers the QR's lines, gui-pair mints a new one-time link each time, off removes the serve entry and keeps the devices; pairing is refused while it is off", async () => {
	const ts = fakeTailscale();
	const h = await host({ tailscale: ts.run });
	assert.deepEqual(await h.ask("gui-pair"), { ok: false, error: "remote_off" });
	const on = await h.ask("gui-remote", { on: true });
	assert.equal(on.ok, true);
	assert.match(String(on.text), /Remote access is on for me@example\.com, tailnet only: https:\/\/box\.tail1\.ts\.net:8443\//);
	assert.ok(Array.isArray(on.lines) && (on.lines as string[]).some((l) => l.includes("Scan with a device signed in to Tailscale as")), "the pairing screen's lines");
	assert.deepEqual(Object.keys((ts.config() as { Web: object }).Web), ["box.tail1.ts.net:8443"]);
	const [one, two] = [await h.ask("gui-pair"), await h.ask("gui-pair")];
	assert.match(String(one.url), new RegExp(`^https://box\\.tail1\\.ts\\.net:8443/${h.gui().token}/pair/[\\w-]{20,}$`));
	assert.notEqual(one.url, two.url);
	assert.equal(((await h.ask("status")).gui as { remote: { on: boolean } }).remote.on, true);
	const off = await h.ask("gui-remote", { on: false });
	assert.equal(off.ok, true);
	assert.deepEqual(ts.config(), {});
	assert.deepEqual(await h.ask("gui-pair"), { ok: false, error: "remote_off" });
});

test("a server that starts again turns remote on by itself when it was wanted (no QR), takes the entry down when it stops, and keeps the wish", async () => {
	const ts = fakeTailscale();
	const h = await host({ tailscale: ts.run });
	await h.ask("gui-remote", { on: true });
	const next = await restart(h, { tailscale: ts.run });
	const remote = ((await next.ask("status")).gui as { remote: { wanted: boolean; on: boolean; note?: string } }).remote;
	assert.deepEqual(remote, { wanted: true, on: true });
	assert.deepEqual(Object.keys((ts.config() as { Web: object }).Web), ["box.tail1.ts.net:8443"]);
	await next.ask("stop", { by: "test" });
	await next.handle.done;
	assert.deepEqual(ts.config(), {}, "a stop takes the serve entry down");
	const again = await host({ tailscale: ts.run });
	assert.equal(((await again.ask("status")).gui as { remote: { on: boolean } }).remote.on, true, "and the wish was kept");
	await again.ask("gui-remote", { on: false });
	await again.ask("restart", { reason: "test", by: "test" });
	await again.handle.done;
	const last = await host({ tailscale: ts.run });
	assert.deepEqual(((await last.ask("status")).gui as { remote: unknown }).remote, { wanted: false, on: false }, "turned off, it stays off");
});

test("remote access that cannot resume says why in the server's status and leaves the wish; another Tailscale identity leaves it off and keeps the old devices' wish", async () => {
	const ts = fakeTailscale();
	const h = await host({ tailscale: ts.run });
	await h.ask("gui-remote", { on: true });
	const down = await restart(h);
	const broken = ((await down.ask("status")).gui as { remote: { wanted: boolean; on: boolean; note: string } }).remote;
	assert.deepEqual([broken.wanted, broken.on], [true, false]);
	assert.match(broken.note, /Remote access stays off: Tailscale is not installed.*tried again when the server next starts/);
	assert.match((await down.ask("gui", { boss: true })).remoteNote as string, /stays off: Tailscale is not installed/, "and `gui` carries it for `up`'s warning");
	await down.ask("restart", { reason: "test", by: "test" });
	await down.handle.done;
	const other = await host({ tailscale: fakeTailscale("someone@else.example").run });
	const moved = ((await other.ask("status")).gui as { remote: { wanted: boolean; on: boolean; note: string } }).remote;
	assert.deepEqual([moved.wanted, moved.on], [true, false]);
	assert.match(moved.note, /the Tailscale identity is now someone@else\.example on box\.tail1\.ts\.net:8443, not me@example\.com/);
});

test("a whole stop on purpose marks gui.json stopped for the readers of the contract; a crash or a restart does not", async () => {
	const h = await host();
	await h.ask("stop", { by: "cli stop" });
	await h.handle.done;
	assert.equal(h.gui().stopped, true);
	assert.equal(h.record().stopped, true);
	const next = await host();
	assert.equal(next.gui().stopped, undefined, "a server started again writes a gui.json that is not stopped");
	await next.handle.shutdown(0);
	await next.handle.done;
	assert.equal(next.gui().stopped, undefined, "a server that was killed or signalled is not a stop");
});

test("the server panel answers this computer's page: status, the log (at most 200 lines), and a restart that asks for the server to restart with its reason, or from the GUI by default", async () => {
	const restarts: string[] = [];
	const h = await host({ restart: (reason) => (restarts.push(reason), { status: 202, body: { restarting: true } }) });
	const status = await h.post("server/status");
	assert.equal(status.status, 200);
	assert.deepEqual([status.body.state, status.body.version, status.body.pid, status.body.mode, typeof status.body.uptimeMs], ["live", "0.45.0", h.pid, "detached", "number"]);
	const log = await h.post("server/log", { lines: 5 });
	assert.equal((log.body.lines as string[]).length, 5);
	assert.ok((log.body.lines as string[]).every((line) => !line.includes(h.gui().token)));
	assert.equal((await h.post("server/log", { lines: 201 })).status, 400);
	assert.equal((await h.post("server/log", { lines: 0 })).status, 400);
	assert.deepEqual((await h.post("server/restart", { reason: "stuck dialog" })).body, { restarting: true });
	assert.deepEqual((await h.post("server/restart")).body, { restarting: true });
	assert.equal((await h.post("server/restart", { reason: "a\nb" })).status, 400);
	assert.equal((await h.post("server/restart", { reason: "x".repeat(201) })).status, 400);
	assert.deepEqual(restarts, ["stuck dialog", "from the GUI"]);
});

const proxyOf = (config: unknown) => (config as { Web?: Record<string, { Handlers: { "/": { Proxy: string } } }> }).Web?.["box.tail1.ts.net:8443"]?.Handlers["/"].Proxy;

test("an upgrade: a serve entry that still points at the old local port is repointed at the remote listener when remote goes on, and removed when it goes off", async () => {
	const ts = fakeTailscale(), h = await host({ tailscale: ts.run }), gui = h.gui();
	// What the version before the remote listener left: serve points at the GUI's local port, and remote.json records it.
	await ts.run(["serve", "--bg", "--https=8443", `http://127.0.0.1:${gui.port}`]);
	writeFileSync(join(h.slot.dir, "remote.json"), JSON.stringify({ target: `http://127.0.0.1:${gui.port}`, pid: process.pid }));
	assert.equal((await h.ask("gui-remote", { on: true })).ok, true);
	assert.equal(proxyOf(ts.config()), `http://127.0.0.1:${gui.remotePort}`, "serve now targets the remote listener");
	assert.equal(JSON.parse(readFileSync(join(h.slot.dir, "remote.json"), "utf8")).target, `http://127.0.0.1:${gui.remotePort}`);
	await h.ask("gui-remote", { on: false });
	assert.deepEqual(ts.config(), {});
});

test("a serve entry a crashed server left is removed when the next server starts and remote is wanted, and an entry that points elsewhere now is left alone", async () => {
	const ts = fakeTailscale();
	const first = await host({ tailscale: ts.run });
	await first.ask("gui-remote", { on: true });
	await first.ask("restart", { reason: "test", by: "test" });
	await first.handle.done;
	// The crashed server's entry: serve still points at a port nobody listens on, recorded in remote.json.
	await ts.run(["serve", "--bg", "--https=8443", "http://127.0.0.1:1"]);
	writeFileSync(join(first.slot.dir, "remote.json"), JSON.stringify({ target: "http://127.0.0.1:1" }));
	const next = await host({ tailscale: ts.run });
	assert.equal(proxyOf(ts.config()), `http://127.0.0.1:${next.gui().remotePort}`, "the new server's remote replaced the stale entry");
	await next.ask("gui-remote", { on: false });
	assert.deepEqual(ts.config(), {});
	// An entry that points somewhere else now is not ours to remove or take.
	await ts.run(["serve", "--bg", "--https=8443", "http://127.0.0.1:2"]);
	writeFileSync(join(next.slot.dir, "remote.json"), JSON.stringify({ target: "http://127.0.0.1:1" }));
	const reply = await next.ask("gui-remote", { on: true });
	assert.equal(reply.ok, false);
	assert.equal(JSON.stringify(ts.config()).includes("127.0.0.1:2"), true);
});

test("how-it-works carries States for a shell with each state `status` can give, and says gui.json now names the sb server", () => {
	const text = readFileSync(new URL("../docs/how-it-works.md", import.meta.url), "utf8");
	const section = text.slice(text.indexOf("### States for a shell"), text.indexOf("\n## Tools"));
	assert.ok(section.length > 500);
	for (const state of ["live", "moved", "restarting", "gui stopped", "server stopped", "gone"]) assert.match(section, new RegExp(`\\| ${state} \\|`), state);
	for (const word of ["gui-stopped", "`stopped`", "`gone`"]) assert.ok(section.includes(word), word);
	assert.match(text, /`owner` is `sb server \(pid N\)`/);
});
