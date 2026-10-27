import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer as createHttpServer, get, request } from "node:http";
import { createServer } from "node:net";
import { afterEach, test } from "node:test";
import { startGui } from "../src/gui.ts";
import { writeRecordFile } from "../src/handover.ts";
import { switchRemote } from "../src/remote.ts";
import { fileOf, readRecord, writeRecord } from "../src/server/record.ts";
import { until, World } from "./fakes.ts";
import { bundle, fakeTailscale, Hosted, markAlive, markGone, startHosted } from "./gui-world.ts";

// The GUI in the sb server (docs/specs/2026-10-26-sb-backend.md, GUI, `gui.json` and its successor): where it starts, what it records, what a restart keeps, and what stops it.

let world = new World();
const hosted: Hosted[] = [];
/** What a test started besides servers (an older host's GUI, a squatter): stopped after the test, so a failing assertion ends the file instead of leaving a listener open. */
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map(async (c) => c()));
	markGone(4242);
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

/** The status a POST to the page's API answers, with the token in the path and the CSRF secret in the header: what an open page of an earlier GUI sends. */
const posted = (port: number, token: string, csrf: string) => new Promise<number>((resolve) => {
	const body = "{}", req = request({ host: "127.0.0.1", port, path: `/${token}/api/server/stop`, method: "POST", agent: false, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-sb-csrf": csrf, "content-length": body.length } }, (res) => (res.resume(), resolve(res.statusCode!)));
	req.end(body);
});

test("RC3-F002: a restart binds the recorded port again but under a new token and CSRF secret: the old ones open nothing, both records carry the new ones, and the token is in no log", async () => {
	const h = await host();
	const before = h.gui(), oldUrl = h.url;
	assert.equal(await status(oldUrl), 200);
	const next = await restart(h);
	const after = next.gui();
	assert.deepEqual([after.port, after.remotePort], [before.port, before.remotePort], "the ports are got back");
	assert.notEqual(after.token, before.token);
	assert.notEqual(after.csrf, before.csrf);
	assert.match(after.token, /^[0-9a-f]{32}$/);
	assert.notEqual(next.url, oldUrl);
	assert.equal(next.record().gui?.token, after.token, "server.json carries the new token as gui.json does");
	assert.deepEqual(next.record().gui, { port: before.port, token: after.token, stopped: false });
	assert.equal(await status(next.url), 200);
	assert.equal(await status(oldUrl), 403, "the token an open page (or a squatter that took the port in the gap) holds opens nothing");
	assert.equal(await posted(after.port, after.token, before.csrf!), 403, "nor does the old CSRF secret");
	assert.equal(await posted(after.port, before.token, after.csrf!), 403, "nor does the old token with the new secret");
	const log = readFileSync(fileOf(next.slot, "log"), "utf8");
	assert.ok(log.indexOf("intercom-connected") < log.indexOf("gui-start"), "the server's ids first, then the GUI's ports");
	assert.ok(log.split("\n").some((l) => l.includes("gui-start") && l.includes("newToken")), "the start says it is a new token");
	for (const secret of [before.token, before.csrf!, after.token, after.csrf!]) assert.ok(!log.includes(secret), "no token or secret in the log");
});

test("RC3-F002: a server that crashed (its records left as it wrote them, no clean leave) is followed by a GUI on the recorded port under a new token", async () => {
	const h = await host();
	const before = h.gui(), dir = h.slot.dir, oldUrl = h.url;
	await h.stop();
	writeRecordFile(dir, before);
	assert.equal(h.gui().started, `T-${h.pid}`, "gui.json is as a crash leaves it, with the dead server's start time");
	const next = await host();
	assert.equal(next.gui().port, before.port);
	assert.notEqual(next.gui().token, before.token);
	assert.notEqual(next.gui().csrf, before.csrf);
	assert.equal(next.record().gui?.token, next.gui().token);
	assert.equal(await status(next.url), 200);
	assert.equal(await status(oldUrl), 403);
});

test("RC3-F002: the token lasts as long as the listener does: asks while the GUI runs give the same URL, and a stop and a start is a new listener", async () => {
	const h = await host();
	const first = await h.ask("gui", { boss: true }), again = await h.ask("gui", { boss: false });
	assert.deepEqual([first.port, first.token], [h.gui().port, h.gui().token]);
	assert.deepEqual([again.port, again.token], [first.port, first.token], "the same listener keeps its token");
	await h.ask("gui-stop");
	const started = await h.ask("gui", { boss: true });
	assert.equal(started.port, first.port);
	assert.notEqual(started.token, first.token);
	assert.equal(h.record().gui?.token, started.token);
});

test("RC3-F004: a squatter on the remote port alone moves only the remote port, and the token and CSRF secret still change", async () => {
	const h = await host();
	const before = h.gui();
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	const seen = await squatter(before.remotePort!);
	const next = await host();
	const after = next.gui();
	assert.equal(after.port, before.port, "the local port is kept");
	assert.notEqual(after.remotePort, before.remotePort);
	assert.notEqual(after.token, before.token, "a shell that compares only `port` must also compare `token`");
	assert.notEqual(after.csrf, before.csrf);
	assert.equal(next.record().gui?.token, after.token);
	assert.deepEqual(seen, [], "the squatter was sent nothing by the server");
});

test("RC2-F001: a port another process took meanwhile moves the GUI to a new token and CSRF secret: what an open page sends to its old origin (the squatter) is no good on the new port, and both records carry the new ones", async () => {
	const h = await host();
	const before = h.gui();
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	// A web server of another account: an open page of the old GUI reconnects to it (its event stream with the token in the path, its POSTs with the CSRF secret), and it keeps what it is sent.
	const seen = await squatter(before.port);
	const next = await host();
	const after = next.gui();
	assert.notEqual(after.port, before.port);
	assert.notEqual(after.token, before.token);
	assert.notEqual(after.csrf, before.csrf);
	assert.equal(next.record().gui?.token, after.token);
	assert.deepEqual(next.record().gui, { port: after.port, token: after.token, stopped: false });
	assert.equal(await status(next.url), 200);
	assert.equal(await status(`http://127.0.0.1:${after.port}/${before.token}/`), 403, "the token the squatter was sent opens nothing on the new port");
	assert.deepEqual(seen, [], "and the squatter was sent nothing by the server");
	assert.equal(await posted(after.port, after.token, before.csrf!), 403, "nor does the old CSRF secret");
});

test("gui-stop stops the listeners and marks the GUI stopped on purpose in both records while the server runs on; a restart leaves it stopped; an automatic ask is refused, and the boss's own starts it on the same port under a new token and clears both marks", async () => {
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
	assert.notEqual(started.token, before.token, "a GUI that starts again is a new listener");
	assert.equal(await status(`http://127.0.0.1:${started.port}/${started.token}/`), 200);
	assert.equal(await status(url), 403, "the old token opens nothing");
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

test("RC3-F002: a restart with remote on re-points the serve entry at the new listener, and a phone's old pairing link or an old token on the remote listener is refused", async () => {
	const ts = fakeTailscale();
	const h = await host({ tailscale: ts.run });
	await h.ask("gui-remote", { on: true });
	const before = h.gui(), oldLink = String((await h.ask("gui-pair")).url);
	assert.ok(oldLink.includes(`/${before.token}/pair/`));
	const next = await restart(h, { tailscale: ts.run });
	const after = next.gui(), proxy = () => (ts.config() as { Web: Record<string, { Handlers: { "/": { Proxy: string } } }> }).Web["box.tail1.ts.net:8443"]!.Handlers["/"].Proxy;
	assert.notEqual(after.token, before.token);
	assert.equal(proxy(), `http://127.0.0.1:${after.remotePort}`, "the entry points at the new server's remote listener");
	const link = String((await next.ask("gui-pair")).url);
	assert.ok(link.includes(`/${after.token}/pair/`) && !link.includes(before.token), "a new pairing link carries the new token");
	const remote = (path: string) => new Promise<number>((resolve, reject) => void get({ host: "127.0.0.1", port: after.remotePort, path, agent: false, headers: { host: "box.tail1.ts.net:8443", "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.87.7.97" } }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject));
	assert.equal(await remote(new URL(oldLink).pathname), 403, "the old pairing link opens nothing");
	assert.equal(await remote(`/${before.token}/`), 403, "nor does the old token");
	assert.equal(await remote(new URL(link).pathname), 200, "the new link pairs");
});

test("R-F004: a restart that gives the GUI a new token unpairs the devices of the old one (identity and the wish stay), and logs how many", async () => {
	const ts = fakeTailscale();
	const h = await host({ tailscale: ts.run });
	await h.ask("gui-remote", { on: true });
	const link = new URL(String((await h.ask("gui-pair")).url));
	const first = await new Promise<number>((resolve, reject) => void get({ host: "127.0.0.1", port: h.gui().remotePort, path: link.pathname, agent: false, headers: { host: "box.tail1.ts.net:8443", "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.87.7.97", "user-agent": "Mozilla/5.0 (iPhone)" } }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject));
	assert.equal(first, 200);
	const paired = (x: Hosted) => Object.keys((JSON.parse(readFileSync(join(x.slot.dir, "paired.json"), "utf8")) as { devices: object }).devices).length;
	assert.equal(paired(h), 1, "one device paired");
	const next = await restart(h, { tailscale: ts.run });
	assert.equal(paired(next), 0, "the old pairing is dead with the old token, so it is not kept");
	assert.equal(((await next.ask("status")).gui as { remote: { wanted: boolean } }).remote.wanted, true, "the wish stays");
	assert.match(readFileSync(fileOf(next.slot, "log"), "utf8"), /devices-cleared n=1/);
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

// --- A 0.45 session still hosts the GUI (B2R-F001, B2R-F002) ---

/** What a pi session before 0.46.0 runs at gui.ts's level: the page on the recorded ports, a serve entry of its own, and a stop that takes its entry down first (host.ts `onStop`). */
async function olderHost(h: Hosted, ts: ReturnType<typeof fakeTailscale>, over: { refuse?: boolean } = {}) {
	const first = h.gui(), dir = h.slot.dir, stops: { by: string; take: boolean }[] = [];
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	let old!: Awaited<ReturnType<typeof startGui>>;
	old = await startGui({
		read: async () => ({ bases: [] }), dir: bundle, paired: join(dir, "paired.json"), port: first.port, remotePort: first.remotePort, bindWaitMs: 2000,
		onStop: (asked) => { stops.push(asked); void switchRemote(old, false, dir, ts.run, true).then(() => old.stop()); },
	});
	cleanups.push(() => old.stop());
	markAlive(4242);
	// The older host serves the first server's ports under a token of its own, which is what gui.json records.
	assert.deepEqual([old.port, old.remotePort], [first.port, first.remotePort]);
	const before = { ...first, token: old.token, csrf: old.csrf };
	// What 0.45 wrote: gui.json names the session (a live pid that is not the server's), with its start time.
	writeRecordFile(dir, { ...before, pid: 4242, started: "T-old", owner: "pi session (pid 4242)", ownerSession: "pi-old", version: "0.45.0" });
	if (!over.refuse) await switchRemote(old, true, dir, ts.run);
	return { before, old, stops, dir };
}

test("the first server after an upgrade takes the GUI from the 0.45 session that still hosts it: it asks for the hand-over, binds the same ports under a new token, and remote comes back on its listener", async () => {
	const ts = fakeTailscale(), h = await host({ tailscale: ts.run });
	const { before, old, stops } = await olderHost(h, ts);
	assert.equal(await status(`http://127.0.0.1:${before.port}/${before.token}/`), 200, "the older host answers");
	assert.equal(JSON.parse(JSON.stringify(ts.config())).Web["box.tail1.ts.net:8443"].Handlers["/"].Proxy, `http://127.0.0.1:${old.remotePort}`);
	const next = await host({ tailscale: ts.run, options: { startOf: (p) => (p === 4242 ? "T-old" : undefined) } });
	assert.deepEqual(stops, [{ by: `sb server (pid ${next.pid})`, take: true }]);
	const after = next.gui();
	assert.deepEqual([after.port, after.remotePort, after.pid], [before.port, before.remotePort, next.pid], "the ports are kept");
	assert.notEqual(after.token, before.token, "a listener that starts after another one has a token of its own");
	assert.notEqual(after.csrf, before.csrf);
	assert.equal(await status(next.url), 200);
	assert.equal(await status(`http://127.0.0.1:${before.port}/${before.token}/`), 403, "the page the older host served opens nothing");
	assert.deepEqual(next.record().gui, { port: before.port, token: after.token, stopped: false });
	assert.deepEqual(((await next.ask("status")).gui as { remote: unknown }).remote, { wanted: true, on: true }, "remote is back");
	assert.equal((ts.config() as { Web: Record<string, { Handlers: { "/": { Proxy: string } } }> }).Web["box.tail1.ts.net:8443"]!.Handlers["/"].Proxy, `http://127.0.0.1:${next.gui().remotePort}`);
	assert.ok(readFileSync(fileOf(next.slot, "log"), "utf8").includes("gui-reclaim"));
});

test("a live host that does not hand over is left alone: the server's GUI moves to another port with a new token", async () => {
	const ts = fakeTailscale(), h = await host({ tailscale: ts.run });
	const { before, old, dir } = await olderHost(h, ts, { refuse: true });
	// An older host that is a sb server answers the takeover with 409 (below); a host that gives no 202 is the same here: nothing is waited for.
	const asked: unknown[] = [];
	await old.stop();
	markAlive(4243);
	cleanups.push(() => markGone(4243));
	const stubborn = await startGui({ read: async () => ({ bases: [] }), dir: bundle, port: before.port, remotePort: before.remotePort, refuseTake: true, onStop: (a) => void asked.push(a) });
	cleanups.push(() => stubborn.stop());
	writeRecordFile(dir, { ...before, token: stubborn.token, csrf: stubborn.csrf, port: stubborn.port, remotePort: stubborn.remotePort, pid: 4243, started: "T-other", owner: "sb server (pid 4243)", version: "0.46.0" });
	{
		const next = await host({ tailscale: ts.run, options: { startOf: (p) => (p === 4243 ? "T-other" : undefined) } });
		assert.equal(await status(`http://127.0.0.1:${stubborn.port}/${stubborn.token}/`), 200, "the other GUI still answers");
		assert.notEqual(next.gui().port, before.port);
		assert.notEqual(next.gui().token, stubborn.token);
		assert.equal(await status(next.url), 200);
		assert.deepEqual(asked, [], "nothing stopped it");
	}
});

/** A foreign process that answers 200 to every path on a port, and keeps what it was sent. */
async function squatter(port: number) {
	const seen: { method: string; path: string; csrf: boolean }[] = [];
	const server = createHttpServer((req, res) => {
		seen.push({ method: req.method!, path: req.url!, csrf: Boolean(req.headers["x-sb-csrf"]) });
		req.resume();
		res.writeHead(200, { "content-type": "text/html" }).end("<html>any path 200</html>");
	});
	await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
	cleanups.push(() => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
	return seen;
}

test("a process that took the port of a server that is gone is sent nothing: a restart and a gui.json that names a dead pid or another process's pid send no request to the recorded port", async () => {
	const h = await host(), before = h.gui();
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	const seen = await squatter(before.port);
	const next = await host();
	assert.deepEqual(seen, [], "restart: the old server is dead, so nothing reaches the port");
	assert.notEqual(next.gui().port, before.port);
	assert.notEqual(next.gui().token, before.token, "a moved port is a new token");
	// A 0.45 session that died: its pid is not alive.
	await next.ask("restart", { reason: "test", by: "test" });
	await next.handle.done;
	writeRecordFile(next.slot.dir, { ...before, pid: 999_991, started: "T-dead", owner: "pi session (pid 999991)", version: "0.45.0" });
	const dead = await host();
	assert.deepEqual(seen, [], "a dead 0.45 pid");
	await dead.ask("restart", { reason: "test", by: "test" });
	await dead.handle.done;
	// A pid that runs but started at another time (the number was reused after a crash).
	markAlive(4244);
	cleanups.push(() => markGone(4244));
	writeRecordFile(dead.slot.dir, { ...before, pid: 4244, started: "T-recorded", owner: "pi session (pid 4244)", version: "0.45.0" });
	const reused = await host({ options: { startOf: (p) => (p === 4244 ? "T-other" : undefined) } });
	assert.deepEqual(seen, [], "a reused pid");
	assert.equal(reused.gui().pid, reused.pid);
});

/**
 * sec-F001: on Windows another pid's start time is unknown until a background read answers (3.5 s and more), and a pid that a crashed host left is often another process's by then. The page's token and its CSRF secret
 * go only to a process whose start time is KNOWN and equal to gui.json's: an alive pid is not enough.
 */
async function crashedHost(over: { started?: string; pid?: number } = {}) {
	const h = await host(), before = h.gui(), pid = over.pid ?? 4246;
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	const seen = await squatter(before.port);
	markAlive(pid);
	cleanups.push(() => markGone(pid));
	const plant = (started: string | undefined) => writeRecordFile(h.slot.dir, { ...before, pid, started, owner: `pi session (pid ${pid})`, ownerSession: "pi-old", version: "0.45.0" });
	plant("started" in over ? over.started : "T-recorded");
	return { before, seen, plant, dir: h.slot.dir };
}

test("sec-F001: a squatter on the recorded port is sent nothing while the recorded pid's start time is not known (a cold cache), never comes within the wait, or was not recorded", async () => {
	const cold = await crashedHost();
	const a = await host({ gui: { startedLater: async () => undefined } });
	assert.deepEqual(cold.seen, [], "a start time that cannot be told");
	assert.equal(a.gui().pid, a.pid);
	await a.ask("restart", { reason: "test", by: "test" });
	await a.handle.done;
	cold.plant("T-recorded");
	const slow = await host({ gui: { startedLater: () => new Promise<string | undefined>(() => {}), startWaitMs: 150 } });
	assert.deepEqual(cold.seen, [], "a start time that does not arrive within the wait");
	assert.equal(slow.gui().pid, slow.pid);
	await slow.ask("restart", { reason: "test", by: "test" });
	await slow.handle.done;
	cold.plant(undefined);
	const bare = await host({ options: { startOf: (p) => (p === 4246 ? "T-recorded" : undefined) } });
	assert.deepEqual(cold.seen, [], "a record without a start time, though the process answers one");
	assert.ok(readFileSync(fileOf(bare.slot, "log"), "utf8").includes("gui-reclaim-skipped"), "and the skip is logged");
});

test("sec-F001: a start time that arrives late is waited for, and one that equals the record's lets the hand-over go ahead", async () => {
	const ts = fakeTailscale(), h = await host({ tailscale: ts.run });
	const { before, old, stops } = await olderHost(h, ts);
	const next = await host({ tailscale: ts.run, gui: { startedLater: async (p) => (await new Promise((r) => setTimeout(r, 250)), p === 4242 ? "T-old" : undefined) } });
	assert.deepEqual(stops, [{ by: `sb server (pid ${next.pid})`, take: true }], "the older host was asked once the time came");
	assert.equal(next.gui().port, before.port);
	assert.equal(await status(next.url), 200);
	void old;
});

test("RC2-F001: a squatter that binds the port the old host just freed is sent nothing during the reclaim wait: the GUI moves to a new token and the squatter is never asked", async () => {
	const ts = fakeTailscale(), h = await host({ tailscale: ts.run });
	const before = h.gui(), dir = h.slot.dir;
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	let seen: { method: string; path: string; csrf: boolean }[] = [];
	let old!: Awaited<ReturnType<typeof startGui>>;
	// The older host lets go of its port on the take, and a foreign web server binds that port at once.
	old = await startGui({
		read: async () => ({ bases: [] }), dir: bundle, paired: join(dir, "paired.json"), port: before.port, remotePort: before.remotePort, bindWaitMs: 2000,
		onStop: () => void old.stop().then(async () => void (seen = await squatter(before.port))),
	});
	cleanups.push(() => old.stop());
	markAlive(4242);
	cleanups.push(() => markGone(4242));
	writeRecordFile(dir, { ...before, token: old.token, csrf: old.csrf, pid: 4242, started: "T-old", owner: "pi session (pid 4242)", ownerSession: "pi-old", version: "0.45.0" });
	const next = await host({ tailscale: ts.run, options: { startOf: (p) => (p === 4242 ? "T-old" : undefined) } });
	assert.notEqual(next.gui().port, before.port, "the port is taken, so the GUI moves");
	assert.notEqual(next.gui().token, old.token);
	assert.equal(await status(next.url), 200);
	assert.deepEqual(seen, [], "the squatter received no request, so no token");
});

test("sec-F003: the GUI of a secondary server answers Straw Link calls with the no_link text (the holder is the default Herdr's server's), not the refusal of a holder session that is not its host", async () => {
	const h = await host({ env: { HERDR_SOCKET_PATH: join(world.stateDir, "other-herdr.sock") }, gui: { link: undefined } });
	assert.equal(h.options.slot.primary, false);
	const state = await h.post("link/state");
	assert.deepEqual([state.status, state.body.error], [409, "no_link"]);
	assert.match(String(state.body.reason), /runs in the sb server of the default Herdr only/);
	const create = await h.post("link/create", { name: "x" });
	assert.deepEqual([create.status, create.body.error], [409, "no_link"]);
	const enable = await h.post("link/enable");
	assert.equal(enable.status, 502);
	assert.match(String(enable.body.reason), /default Herdr only/);
	assert.equal(existsSync(join(world.stateDir, "link")), false, "and nothing is written to the primary's link folder");
});

test("a takeover asked of the server is refused with 409 and the GUI stays; an older build's plain stop still stops it, on purpose", async () => {
	const h = await host(), gui = h.gui();
	const stop = (take: boolean) => h.post("server/stop", { by: "pi session (pid 4242)", take });
	const taken = await stop(true);
	assert.equal(taken.status, 409);
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(await status(h.url), 200, "the GUI is still up");
	assert.equal(h.record().gui?.stopped, false, "and not marked stopped");
	assert.equal(h.gui().pid, h.pid);
	assert.equal((await stop(false)).status, 202);
	await until(() => h.record().gui?.stopped === true, "the stop");
	await assert.rejects(status(`http://127.0.0.1:${gui.port}/${gui.token}/`), /ECONNREFUSED/);
});

test("an old-build session neither adopts the GUI nor takes it: a restart leaves gui.json without a start time (which 0.45 never adopts) and a takeover is refused", async () => {
	const h = await host(), before = h.gui();
	// 0.45's adoptable(): a record is adopted only with `started` and on its own Herdr.
	const adoptable = (r: { started?: string; herdr?: string }) => Boolean(r.started) && r.herdr === h.slot.herdr;
	assert.equal(adoptable(before), true, "while the server runs the record names it with its start time");
	assert.equal((await h.post("server/stop", { by: "pi session", take: true })).status, 409);
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	assert.equal(h.gui().pid, h.pid, "it still names the server that left");
	assert.equal(h.gui().started, undefined);
	assert.equal(adoptable(h.gui()), false, "so no 0.45 session adopts it during the restart");
	assert.equal(h.gui().stopped, undefined, "and it is not a stop");
	const next = await host();
	assert.equal(next.gui().started, `T-${next.pid}`, "the next server writes its start time again");
	assert.equal(adoptable(next.gui()), true);
	assert.equal(next.gui().port, before.port);
	assert.notEqual(next.gui().token, before.token, "a new listener has a new token");
});

// --- The paired device's limits, GUI commands while leaving, and the record (B2R-F003, F007) ---

test("a paired device on the remote listener is refused with 403 local_only on the server panel's status, log, and restart, and the restart is never called", async () => {
	const restarts: string[] = [], ts = fakeTailscale();
	const h = await host({ tailscale: ts.run, restart: (reason) => (restarts.push(reason), { status: 202, body: { restarting: true } }) });
	await h.ask("gui-remote", { on: true });
	const gui = h.gui(), HOST = "box.tail1.ts.net:8443";
	const send = (path: string, headers: Record<string, string> = {}, method = "GET", body?: string) => new Promise<{ status: number; headers: Record<string, unknown>; body: Record<string, unknown> }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: gui.remotePort, path, method, agent: false, headers: { host: HOST, "tailscale-user-login": "me@example.com", "x-forwarded-for": "100.87.7.97", "x-forwarded-proto": "https", ...headers } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text.startsWith("{") ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(body);
	});
	const link = new URL(String((await h.ask("gui-pair")).url));
	const cookie = String((await send(link.pathname)).headers["set-cookie"]).split(";")[0]!;
	const json = { cookie, origin: `https://${HOST}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf! };
	for (const [action, body] of [["status", {}], ["log", { lines: 5 }], ["restart", { reason: "from a phone" }], ["stop", { by: "x", take: false }]] as const) {
		const reply = await send(`/${gui.token}/api/server/${action}`, json, "POST", JSON.stringify(body));
		assert.equal(reply.status, 403, action);
		assert.equal(reply.body.error, "local_only", action);
	}
	assert.deepEqual(restarts, [], "the restart was never called");
	assert.equal((await h.post("server/status")).status, 200, "this computer's own page still gets it");
});

test("GUI commands are refused while the server leaves, also when it leaves by a signal and no restart or stop began", async () => {
	// Taking the serve entry down is slow, so the server is still answering on its control socket while it leaves.
	const ts = fakeTailscale(), slow = { release: () => {} }, gate = new Promise<void>((resolve) => (slow.release = resolve));
	const h = await host({ tailscale: async (args) => (args.join(" ") === "serve --https=8443 off" ? (await gate, ts.run(args)) : ts.run(args)) });
	await h.ask("gui-remote", { on: true });
	const leaving = h.handle.shutdown(0);
	try {
		assert.deepEqual(await h.ask("gui", { boss: true }), { ok: false, error: "restarting" });
		assert.deepEqual(await h.ask("gui-stop"), { ok: false, error: "restarting" });
	} finally {
		slow.release();
		await leaving;
	}
});

test("a record touch that restores the server's own record keeps the GUI it holds: server.json's port and token, and the url status gives", async () => {
	const h = await host({ options: { touchMs: 30 } });
	const record = h.record(), gui = record.gui!;
	// Another secret under the same pid: the touch writes the record again as its own.
	writeRecord(h.slot, { ...record, secret: "0".repeat(64) });
	await until(() => readFileSync(fileOf(h.slot, "log"), "utf8").includes("record-restored"), "the record restored");
	assert.deepEqual(readRecord(h.slot)?.gui, gui);
	assert.equal(readRecord(h.slot)?.secret, record.secret);
	assert.equal(((await h.ask("status")).gui as { port: number }).port, gui.port);
});

test("the port of the server that is just leaving is waited for: a holder that lets go within bindWaitMs does not move the GUI", async () => {
	const h = await host({ gui: { bindWaitMs: 5000 } }), before = h.gui();
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	// The old server's page, a moment from letting go (it answers 503, so the new server sees at once that it is not the GUI to take over).
	const holder = createHttpServer((_req, res) => res.writeHead(503).end());
	await new Promise<void>((resolve) => holder.listen(before.port, "127.0.0.1", resolve));
	const letGo = Date.now() + 1500;
	setTimeout(() => holder.close(), 1500);
	const next = await host({ gui: { bindWaitMs: 5000 } });
	assert.ok(Date.now() >= letGo, "the new server bound after the holder let go");
	assert.equal(next.gui().port, before.port, "the port was retried until free");
	assert.equal(await status(next.url), 200);
});

test("gui.json is created by a temporary file under a random name, created new: one planted under the old predictable name is not written to", async () => {
	const h = await host(), dir = h.slot.dir;
	const planted = join(dir, `gui.json.${process.pid}.0.tmp`);
	writeFileSync(planted, "planted");
	writeRecordFile(dir, { ...h.gui() });
	assert.equal(readFileSync(planted, "utf8"), "planted");
	assert.equal(existsSync(join(dir, "gui.json")), true);
	assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith("gui.json.") && f !== planted.split("/").pop()), [], "no temporary file is left");
});
