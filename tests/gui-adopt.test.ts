import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { markStopped, ownerGone, readRecord } from "../src/handover.ts";
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

test("markStopped marks only the server it names", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-stopped-test-"));
	try {
		writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid: 1, port: 5, token: "t", owner: "x" }));
		markStopped(dir, { port: 6, token: "t" });
		markStopped(dir, { port: 5, token: "other" });
		assert.equal(readRecord(dir)!.stopped, undefined, "another server's record is left alone");
		markStopped(dir, { port: 5, token: "t" });
		assert.equal(readRecord(dir)!.stopped, true);
		rmSync(join(dir, "gui.json"));
		markStopped(dir, { port: 5, token: "t" });
		assert.equal(existsSync(join(dir, "gui.json")), false, "no record, nothing written");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
