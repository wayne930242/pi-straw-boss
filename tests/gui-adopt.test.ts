import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { clearStale, markStopped, ownerGone, readRecord, sharedGui, stopRecorded } from "../src/handover.ts";
import { type Agent, until, World } from "./fakes.ts";

// One GUI server per machine, whichever session hosts it: when the session that runs it ends without a stop, a survivor starts it again on the same URL.

let world = new World();
const scratch = mkdtempSync(join(tmpdir(), "psb-adopt-test-"));
const bundle = join(scratch, "bundle");
mkdirSync(bundle);
writeFileSync(join(bundle, "index.html"), "<title>Straw Net</title>");
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const opened: string[] = [];
// The survivors look every 20 ms here (every 2 s in production), so a quiet stretch of 300 ms is about fifteen looks.
const deps = { bundle, openUrl: async (url: string) => void opened.push(url), adoptMs: 20 };
const pause = (ms = 300) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const urlOf = (a: Agent) => a.notices.map((n) => /Straw net GUI: (\S+)/.exec(n.text)?.[1]).filter(Boolean).at(-1)!;
const status = (url: string) =>
	new Promise<number>((resolve, reject) => {
		get(url, { agent: false }, (res) => (res.resume(), resolve(res.statusCode!))).on("error", reject);
	});
const serving = (url: string) => status(url).then((code) => code === 200, () => false);
const hosts = (a: Agent) => a.notices.filter((n) => /now hosts the straw net GUI/.test(n.text));
/** A session that takes the server over when its owner is gone: an interactive one. */
const survivor = (id: string, pane: string, tab: string, extra: Record<string, unknown> = {}) => world.agent({ id, name: id, pane, tab, ui: true, deps: { ...deps, ...extra } });

test("the session that runs the server ends: exactly one survivor starts it again on the same URL, token and CSRF secret, opens no browser, and says so", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const others = [survivor("viewer-b", "wB:p1", "wB:t1"), survivor("viewer-c", "wC:p1", "wC:t1"), survivor("viewer-d", "wD:p1", "wD:t1")];
	await Promise.all([a, ...others].map((who) => who.start()));
	await a.command("gui");
	const url = urlOf(a), before = readRecord(world.stateDir)!, shown = opened.length;
	await a.stop();
	await until(() => serving(url), "a survivor serving the URL again");
	await pause();
	const after = readRecord(world.stateDir)!;
	assert.deepEqual([after.port, after.remotePort, after.token, after.csrf], [before.port, before.remotePort, before.token, before.csrf], "the same URL, so an open page reconnects by itself");
	assert.ok(others.some((who) => who.id === after.ownerSession), "a survivor owns it");
	assert.equal(after.stopped, undefined, "and its record is a running server's");
	const told = others.filter((who) => hosts(who).length);
	assert.deepEqual(told.map((who) => who.id), [after.ownerSession], "one survivor started it, and it alone says so");
	assert.equal(hosts(told[0]!).length, 1, "in one line");
	assert.match(hosts(told[0]!)[0]!.text, /viewer-a \(pane wA:p1\)/, "naming the session that ended");
	assert.match(hosts(told[0]!)[0]!.text, /the URL is unchanged$/);
	assert.equal(opened.length, shown, "no browser opens by itself");
});

test("a closed pane is not a stop: /boss close in the owner leaves the server to a survivor, and its end leaves it to the next", async () => {
	const a = survivor("viewer-a", "wA:p1", "wA:t1"), b = survivor("viewer-b", "wB:p1", "wB:t1");
	await Promise.all([a.start(), b.start()]);
	await a.command("gui");
	const url = urlOf(a);
	await a.command("close");
	await until(() => readRecord(world.stateDir)?.ownerSession === "viewer-b" && serving(url), "viewer-b hosting");
	assert.equal(hosts(b).length, 1);
	const c = survivor("viewer-c", "wC:p1", "wC:t1");
	await c.start();
	await b.stop();
	await until(() => readRecord(world.stateDir)?.ownerSession === "viewer-c" && serving(url), "viewer-c hosting");
	assert.equal(hosts(c).length, 1);
});

test("a deliberate stop stays stopped: from the owner or from another session, no survivor starts it again, not even when the owner ends afterwards", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const b = survivor("viewer-b", "wB:p1", "wB:t1"), c = survivor("viewer-c", "wC:p1", "wC:t1");
	await Promise.all([a.start(), b.start(), c.start()]);
	await a.command("gui");
	const url = urlOf(a);
	await b.command("gui stop"); // another session's stop
	assert.match(b.notices.at(-1)!.text, /^Straw net GUI stopped \(it ran in session viewer-a/);
	assert.equal(readRecord(world.stateDir)!.stopped, true, "the record says the end was on purpose");
	await pause();
	assert.equal(await serving(url), false, "nobody restarts it");
	await a.stop(); // the owner ends later, with the stop on record
	await pause();
	assert.equal(await serving(url), false);
	assert.deepEqual([b, c].map((who) => hosts(who).length), [0, 0]);
	// A session that starts afterwards does not restart it either; /boss gui does, on the same URL, from any session.
	const d = survivor("viewer-d", "wD:p1", "wD:t1");
	await d.start();
	await pause();
	assert.equal(await serving(url), false);
	await c.command("gui");
	assert.equal(urlOf(c), url);
	assert.equal(await serving(url), true);
	assert.equal(readRecord(world.stateDir)!.stopped, undefined, "a started server clears the mark");
	// The owner's own stop is the same.
	await c.command("gui stop");
	assert.equal(readRecord(world.stateDir)!.stopped, true);
	await pause();
	assert.equal(await serving(url), false);
	await c.stop();
	await pause(150);
	assert.equal(await serving(url), false, "and its end changes nothing");
	assert.equal(hosts(d).length, 0);
});

test("a stop typed after the owner died and before a survivor looked is a stop too", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const slow = survivor("viewer-b", "wB:p1", "wB:t1", { adoptMs: 600_000 });
	await Promise.all([a.start(), slow.start()]);
	await a.command("gui");
	const url = urlOf(a);
	await a.stop();
	await slow.command("gui stop");
	assert.match(slow.notices.at(-1)!.text, /not running/);
	assert.equal(readRecord(world.stateDir)!.stopped, true);
	const quick = survivor("viewer-c", "wC:p1", "wC:t1");
	await quick.start();
	await pause();
	assert.equal(await serving(url), false);
	assert.equal(hosts(quick).length, 0);
});

test("the owner's /reload, /new, or /resume: survivors leave the window alone, and the reloaded owner brings the server back on its URL", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const others = [survivor("viewer-b", "wB:p1", "wB:t1"), survivor("viewer-c", "wC:p1", "wC:t1")];
	await Promise.all([a, ...others].map((who) => who.start()));
	await a.command("gui");
	const url = urlOf(a), before = readRecord(world.stateDir)!;
	await a.stop("reload");
	assert.equal(readRecord(world.stateDir)!.reload, true);
	await pause(); // a slow reload: many looks while the owner's process lives and its server is down
	assert.equal(await serving(url), false, "no survivor took it");
	assert.deepEqual(others.map((who) => hosts(who).length), [0, 0]);
	const reloaded = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	await reloaded.fire("session_start", { reason: "reload" });
	await until(() => serving(url), "the reloaded owner's server");
	await pause();
	const after = readRecord(world.stateDir)!;
	assert.deepEqual([after.ownerSession, after.port, after.token, after.reload], ["viewer-a", before.port, before.token, undefined], "one server, the owner's, on the same URL");
	assert.deepEqual(others.map((who) => hosts(who).length), [0, 0]);
	// A /new gives the process another session; the server follows it, still with no survivor involved.
	await reloaded.stop("new");
	await pause(100);
	assert.deepEqual(others.map((who) => hosts(who).length), [0, 0]);
	const fresh = world.agent({ id: "viewer-new", pane: "wA:p1", tab: "wA:t1", deps });
	await fresh.fire("session_start", { reason: "new" });
	await until(() => readRecord(world.stateDir)?.ownerSession === "viewer-new" && serving(url), "the server under the new session");
	assert.deepEqual(others.map((who) => hosts(who).length), [0, 0]);
});

test("a session that cannot host does not take it over (a pi-herdr-agents subagent, a session without a screen); an interactive one does", async () => {
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", deps });
	const sub = world.agent({ id: "kid", pane: "wK:p1", tab: "wK:t1", ui: true, env: { PI_SUBAGENT_ID: "kid-1" }, deps });
	const headless = world.agent({ id: "print", pane: "wP:p1", tab: "wP:t1", deps }); // hasUI false
	await Promise.all([a, sub, headless].map((who) => who.start()));
	await a.command("gui");
	const url = urlOf(a);
	await a.stop();
	await pause();
	assert.equal(await serving(url), false);
	assert.deepEqual([sub, headless].map((who) => hosts(who).length), [0, 0]);
	const live = survivor("viewer-b", "wB:p1", "wB:t1");
	await live.start();
	await until(() => serving(url), "the interactive session hosting");
	assert.equal(hosts(live).length, 1);
	assert.deepEqual([sub, headless].map((who) => hosts(who).length), [0, 0]);
});

test("remote access comes back with the adopted server when it was wanted, with no QR, and stays off when it was turned off", async () => {
	let config: Record<string, unknown> = {};
	const tailscale = async (args: string[]) => {
		if (args[0] === "status") return JSON.stringify({ BackendState: "Running", Self: { DNSName: "box.tail1.ts.net.", UserID: 7 }, User: { "7": { LoginName: "me@example.com" } } });
		if (args.join(" ") === "serve status --json") return JSON.stringify(config);
		if (args[1] === "--bg") config = { TCP: { "8443": { HTTPS: true } }, Web: { "box.tail1.ts.net:8443": { Handlers: { "/": { Proxy: args[3] } } } } };
		if (args.join(" ") === "serve --https=8443 off") config = {};
		return "";
	};
	const proxy = () => (config as { Web?: Record<string, { Handlers: { "/": { Proxy: string } } }> }).Web?.["box.tail1.ts.net:8443"]?.Handlers["/"].Proxy;
	const a = survivor("viewer-a", "wA:p1", "wA:t1", { tailscale });
	const b = survivor("viewer-b", "wB:p1", "wB:t1", { tailscale });
	await Promise.all([a.start(), b.start()]);
	await a.command("gui");
	const pairing = a.command("gui remote");
	await until(() => a.overlays.length === 1, "the QR overlay");
	a.overlays[0]!.handleInput!("q");
	await pairing;
	assert.ok(proxy());
	await a.stop(); // the end of the session takes the entry down and keeps the wish
	await until(() => readRecord(world.stateDir)?.ownerSession === "viewer-b" && proxy() !== undefined, "remote on again at the adopted server");
	const record = readRecord(world.stateDir)!;
	assert.equal(proxy(), `http://127.0.0.1:${record.remotePort}`, "pointed at the adopted server's remote listener");
	assert.equal(b.overlays.length, 0, "no pairing QR");
	assert.ok(b.notices.some((n) => /^Remote access is on for me@example.com/.test(n.text)));
	assert.ok(!b.notices.some((n) => /scan the QR/.test(n.text)), "and it does not tell the user to scan a QR that was not shown");
	// Turned off, it stays off through the next adoption.
	await b.command("gui remote off");
	await b.stop();
	assert.equal(proxy(), undefined);
	const c = survivor("viewer-c", "wC:p1", "wC:t1", { tailscale });
	await c.start();
	await until(() => readRecord(world.stateDir)?.ownerSession === "viewer-c", "viewer-c hosting");
	assert.equal(proxy(), undefined);
});

test("ownerGone: a dead pid, or a live one that started at another time, is gone; the process that wrote the record is not, and is asked about once", async () => {
	const child = spawn("sleep", ["30"], { stdio: "ignore" });
	try {
		const asked: number[] = [], start = (pid: number) => (asked.push(pid), "Mon Oct 23 10:00:00 2026");
		const record = { pid: child.pid!, started: "Mon Oct 23 10:00:00 2026" } as never, wrote = Date.now();
		const gone = ownerGone(start);
		assert.equal(gone(record, wrote), false, "its pid lives and started when the record says");
		assert.equal(gone(record, wrote), false);
		assert.equal(asked.length, 1, "the second look is a signal, not a ps");
		assert.equal(ownerGone(start)({ pid: child.pid!, started: "Mon Jan  1 00:00:00 2001" } as never, wrote), true, "a live pid that started at another time is another process");
		assert.equal(ownerGone(() => "Mon Oct 23 10:00:00 2026")({ pid: child.pid! } as never, Date.parse("2026-10-23T09:00:00Z")), true, "an old record without a start time: a process that started after it is not its writer");
		assert.equal(ownerGone(() => "Mon Oct 23 10:00:00 2026")({ pid: child.pid! } as never, Date.parse("2026-10-23T11:00:00Z")), false, "and one that started before it may be");
		assert.equal(ownerGone(() => undefined)({ pid: child.pid!, started: "x" } as never, wrote), false, "when ps cannot say, a live pid counts as the owner");
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode ? resolve() : child.once("exit", () => resolve())));
		assert.equal(gone(record, wrote), true, "the owner died after it was confirmed");
		assert.equal(ownerGone(start)(record, wrote), true);
	} finally {
		child.kill("SIGKILL");
	}
});

test("a server stopped under a build before the takeover is never adopted: its record has no `started`, so a stop and a quit cannot be told apart", async () => {
	const a = survivor("viewer-a", "wA:p1", "wA:t1");
	await a.start();
	await a.command("gui");
	const url = urlOf(a);
	await a.stop();
	const { started: _, ...old } = readRecord(world.stateDir)!; // what that build leaves after a stop and after a quit alike
	writeFileSync(join(world.stateDir, "gui.json"), JSON.stringify(old));
	const b = survivor("viewer-b", "wB:p1", "wB:t1");
	await b.start();
	await pause();
	assert.equal(await serving(url), false, "nobody starts it, so the stop holds");
	assert.deepEqual(hosts(b).length, 0);
	await b.command("gui");
	assert.equal(await serving(url), true, "/boss gui still starts it on the same URL");
});

test("a session on another Herdr server does not adopt: gui.json names the socket the server's net is read from, and only a session on it takes over", async () => {
	const home = { HERDR_SOCKET_PATH: join(scratch, "home.sock") }, scratchHerdr = { HERDR_SOCKET_PATH: join(scratch, "scratch.sock") };
	const a = world.agent({ id: "viewer-a", pane: "wA:p1", tab: "wA:t1", ui: true, env: home, deps });
	const elsewhere = world.agent({ id: "scratch-b", pane: "wB:p1", tab: "wB:t1", ui: true, env: scratchHerdr, deps });
	await Promise.all([a.start(), elsewhere.start()]);
	await a.command("gui");
	assert.equal(readRecord(world.stateDir)!.herdr, home.HERDR_SOCKET_PATH, "the record says which Herdr it serves");
	const url = urlOf(a);
	await a.stop();
	await pause();
	assert.equal(await serving(url), false, "a session of another Herdr leaves it alone");
	assert.equal(hosts(elsewhere).length, 0);
	const same = world.agent({ id: "viewer-c", pane: "wC:p1", tab: "wC:t1", ui: true, env: home, deps });
	await same.start();
	await until(() => serving(url), "a session of the same Herdr hosting");
	assert.equal(hosts(same).length, 1);
	assert.equal(readRecord(world.stateDir)!.herdr, home.HERDR_SOCKET_PATH);
});

test("when the recorded port is taken meanwhile, the adopting session prints the URL it got instead of saying it is unchanged", async () => {
	const a = survivor("viewer-a", "wA:p1", "wA:t1");
	await a.start();
	await a.command("gui");
	const before = readRecord(world.stateDir)!;
	await a.stop();
	const holder = createServer((_req, res) => res.writeHead(503).end()); // something else that took the port
	await new Promise<void>((resolve) => holder.listen(before.port, "127.0.0.1", resolve));
	try {
		const b = survivor("viewer-b", "wB:p1", "wB:t1");
		await b.start();
		await until(() => hosts(b).length === 1, "viewer-b hosting");
		const after = readRecord(world.stateDir)!, text = hosts(b)[0]!.text;
		assert.notEqual(after.port, before.port, "another port");
		assert.ok(text.includes(`http://127.0.0.1:${after.port}/${after.token}/`), "the notice carries the new URL");
		assert.doesNotMatch(text, /unchanged/);
	} finally {
		holder.closeAllConnections();
		await new Promise<void>((resolve) => holder.close(() => resolve()));
	}
});

test("a build older than the server does not adopt it, so it cannot downgrade the server; one as new does", async () => {
	const a = survivor("viewer-a", "wA:p1", "wA:t1", { version: "99.0.0" }), old = survivor("viewer-b", "wB:p1", "wB:t1", { version: "0.0.1" });
	await Promise.all([a.start(), old.start()]);
	await a.command("gui");
	const url = urlOf(a);
	await a.stop();
	await pause();
	assert.equal(await serving(url), false);
	assert.equal(hosts(old).length, 0);
	const current = survivor("viewer-c", "wC:p1", "wC:t1", { version: "99.0.0" });
	await current.start();
	await until(() => serving(url), "a build as new hosting");
	assert.equal(readRecord(world.stateDir)!.version, "99.0.0");
});

test("a session without a screen does not take the server over for being newer; one with a screen does", async () => {
	const a = survivor("viewer-a", "wA:p1", "wA:t1");
	await a.start();
	await a.command("gui");
	const headless = world.agent({ id: "print", pane: "wP:p1", tab: "wP:t1", deps: { ...deps, version: "99.0.0" } }); // hasUI false
	await headless.start();
	await pause();
	assert.equal(readRecord(world.stateDir)!.ownerSession, "viewer-a", "a print run is not a host, however new it is");
	const screen = survivor("viewer-n", "wN:p1", "wN:t1", { version: "99.0.0" });
	await screen.start();
	await until(() => readRecord(world.stateDir)?.ownerSession === "viewer-n", "the takeover by a session with a screen");
});

test("markStopped marks only the server it names: the process and its start time, not just the port and token that a successor reuses", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-stopped-test-"));
	try {
		const server = { pid: 1, started: "Mon Oct 23 10:00:00 2026", port: 5, token: "t" };
		writeFileSync(join(dir, "gui.json"), JSON.stringify({ ...server, owner: "x" }));
		for (const other of [{ port: 6 }, { token: "other" }, { pid: 2 }, { started: "Mon Oct 23 11:00:00 2026" }]) markStopped(dir, { ...server, ...other });
		assert.equal(readRecord(dir)!.stopped, undefined, "a record of another server, or the same ports under another process, is left alone");
		markStopped(dir, server);
		assert.equal(readRecord(dir)!.stopped, true);
		rmSync(join(dir, "gui.json"));
		markStopped(dir, server);
		assert.equal(existsSync(join(dir, "gui.json")), false, "no record, nothing written");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stop typed in a session that does not run the server waits for gui.lock, then marks the record a start in progress wrote, not the one it replaced", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-stoplock-test-"));
	try {
		const record = (pid: number) => JSON.stringify({ pid, started: "Mon Oct 23 10:00:00 2026", port: 5, token: "t", owner: `x${pid}` }); // nothing answers on port 5
		writeFileSync(join(dir, "gui.json"), record(1));
		writeFileSync(join(dir, "gui.lock"), "99999"); // a survivor is starting the server
		let waits = 0;
		const sleep = async () => {
			if (++waits === 3) { // the survivor is done: it wrote its record and let go of the lock
				writeFileSync(join(dir, "gui.json"), record(2));
				rmSync(join(dir, "gui.lock"));
			}
		};
		const { state, record: seen } = await stopRecorded(dir, "viewer-b (pane wB:p1)", sleep);
		assert.ok(waits >= 3, "it waited");
		assert.deepEqual([state, seen?.pid], ["down", 2], "it read the record after the lock was free");
		assert.deepEqual([readRecord(dir)!.pid, readRecord(dir)!.stopped], [2, true], "and its mark is on that one, which the survivor's write cannot overwrite any more");
		assert.equal(existsSync(join(dir, "gui.lock")), false, "the lock is let go");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stop typed right after the owner died, while survivors are taking over, holds whoever got there first", async () => {
	const a = survivor("viewer-a", "wA:p1", "wA:t1"), others = [survivor("viewer-b", "wB:p1", "wB:t1"), survivor("viewer-c", "wC:p1", "wC:t1")];
	await Promise.all([a, ...others].map((who) => who.start()));
	await a.command("gui");
	const url = urlOf(a), typist = survivor("viewer-d", "wD:p1", "wD:t1", { adoptMs: 600_000 });
	await typist.start();
	await a.stop();
	await typist.command("gui stop");
	await pause();
	assert.equal(await serving(url), false, "nobody has it up");
	assert.equal(readRecord(world.stateDir)!.stopped, true, "and the record says the end was on purpose");
});

test("clearStale takes a dead session's lock away once: a lock another session has just taken, or one being looked at, is left alone", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-stale-test-"));
	try {
		const lock = join(dir, "gui.lock"), old = new Date(Date.now() - 20_000);
		writeFileSync(lock, "1");
		assert.equal(clearStale(lock), true);
		assert.equal(existsSync(lock), true, "a fresh lock is not stale, even for a session that saw an older one a moment ago");
		utimesSync(lock, old, old);
		mkdirSync(`${lock}.stale`);
		assert.equal(clearStale(lock), false, "another session is looking at it");
		assert.equal(existsSync(lock), true);
		utimesSync(`${lock}.stale`, old, old); // left by a session that died while looking
		assert.equal(clearStale(lock), false);
		assert.equal(existsSync(`${lock}.stale`), false, "an old mark goes");
		assert.equal(clearStale(lock), true);
		assert.deepEqual([existsSync(lock), existsSync(`${lock}.stale`)], [false, false], "now the stale lock goes, and the mark with it");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("sessions that find the same dead session's lock start one server at a time", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-stale-start-test-"));
	try {
		const old = new Date(Date.now() - 20_000);
		writeFileSync(join(dir, "gui.lock"), "99999");
		utimesSync(join(dir, "gui.lock"), old, old);
		let running = 0, most = 0;
		const start = async () => {
			most = Math.max(most, ++running);
			await new Promise((resolve) => setTimeout(resolve, 20));
			running--;
			return { url: "http://127.0.0.1:1/t/", port: 1, remotePort: 2, token: "t", csrf: "c" } as never;
		};
		const quick = async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 5)));
		await Promise.all([1, 2, 3, 4].map((n) => sharedGui(dir, [`s${n}`, `s${n}`], start, quick)));
		assert.equal(most, 1);
		assert.equal(existsSync(join(dir, "gui.lock")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
