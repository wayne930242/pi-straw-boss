import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get, type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { startGui, type Gui } from "../src/gui.ts";
import type { Found } from "../src/net.ts";
import { createAccess, identity, PORT, type Run, runs, serveOff, serveOn, startOf, switchRemote } from "../src/remote.ts";
import { copyText } from "../src/pairing.ts";
import { until } from "./fakes.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-remote-test-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const HOST = `box.tail1.ts.net:${PORT}`, LOGIN = "me@example.com";
// Shaped like `tailscale status --json` and `tailscale serve status --json` on Tailscale 1.102.
const status = (extra: Record<string, unknown> = {}) => JSON.stringify({ BackendState: "Running", Self: { DNSName: "Box.tail1.ts.net.", UserID: 7 }, User: { "7": { LoginName: LOGIN } }, ...extra });
const entry = (target: string) => ({ TCP: { [PORT]: { HTTPS: true } }, Web: { [HOST]: { Handlers: { "/": { Proxy: target } } } } });
const theirs = { Foreground: { abc: { TCP: { "443": { HTTPS: true } }, Web: { "box.tail1.ts.net:443": { Handlers: { "/": { Proxy: "http://localhost:61498" } } } } } } };
/** A fake `tailscale`: status answers `ident`, serve status the current config, and serve commands change it the way Tailscale does. */
function fakeTailscale(start: Record<string, unknown> = theirs, ident = status()) {
	let config: Record<string, unknown> = structuredClone(start);
	const calls: string[][] = [];
	const run: Run = async (args) => {
		calls.push(args);
		if (args[0] === "status") return ident;
		if (args.join(" ") === "serve status --json") return JSON.stringify(config);
		if (args[0] === "serve" && args[1] === "--bg") config = { ...config, ...entry(args[3]!) };
		else if (args.join(" ") === `serve --https=${PORT} off`) config = Object.fromEntries(Object.entries(config).filter(([k]) => k === "Foreground"));
		return "";
	};
	return { run, calls, config: () => config, changes: () => calls.filter((c) => c[0] === "serve" && c[1] !== "status") };
}

test("identity is this machine's MagicDNS name on 8443 and its user's login; a stopped, nameless, or tagged node is refused", async () => {
	assert.deepEqual(await identity(async () => status()), { host: HOST, login: LOGIN });
	await assert.rejects(identity(async () => status({ BackendState: "NeedsLogin" })), /not connected/);
	await assert.rejects(identity(async () => status({ Self: { UserID: 7 } })), /MagicDNS/);
	await assert.rejects(identity(async () => status({ Self: { DNSName: "box.ts.net.", UserID: 7, Tags: ["tag:server"] } })), /tagged/);
	await assert.rejects(identity(async () => "Warning: not json"), /did not answer JSON/);
});

test("the serve entry is added only on a free or own 8443, is checked after, and off removes only our own entry", async () => {
	const free = fakeTailscale();
	await serveOn(free.run, HOST, "http://127.0.0.1:5000");
	assert.deepEqual(free.changes(), [["serve", "--bg", `--https=${PORT}`, "http://127.0.0.1:5000"]]);
	assert.deepEqual((free.config() as typeof theirs).Foreground, theirs.Foreground, "the other serve entry is untouched");
	await serveOn(free.run, HOST, "http://127.0.0.1:5000");
	assert.equal(free.changes().length, 1, "already ours: nothing to do");
	assert.equal(await serveOff(free.run, HOST, ["http://127.0.0.1:9999"]), false, "not pointing at us: left alone");
	assert.equal(await serveOff(free.run, HOST, ["http://127.0.0.1:5000"]), true);
	assert.deepEqual(free.config(), theirs, "back to what it was");

	const stale = fakeTailscale({ ...theirs, ...entry("http://127.0.0.1:4000") });
	await serveOn(stale.run, HOST, "http://127.0.0.1:5000", "http://127.0.0.1:4000");
	assert.equal(stale.changes().length, 1, "an entry a crashed session left is taken over");
	for (const [config, why] of [
		[{ ...theirs, ...entry("http://127.0.0.1:4000") }, /already serves something else/],
		[{ ...entry("http://127.0.0.1:5000"), Web: { [HOST]: { Handlers: { "/": { Proxy: "http://127.0.0.1:5000" }, "/notes": { Proxy: "http://127.0.0.1:7" } } } } }, /already serves/],
		[{ Foreground: { x: { TCP: { [PORT]: { HTTPS: true } } } } }, /already serves/],
		[{ TCP: { [PORT]: { TCPForward: "127.0.0.1:22" } } }, /already serves/],
		[{ ...entry("http://127.0.0.1:5000"), AllowFunnel: { [HOST]: true } }, /Funnel/],
	] as const) {
		const other = fakeTailscale(config);
		await assert.rejects(serveOn(other.run, HOST, "http://127.0.0.1:5000"), why);
		assert.deepEqual(other.changes(), [], `${why}: nothing touched`);
		// Off removes only our own entry: one somebody put Funnel on is still ours, and taking it down is what keeps it off the internet.
		assert.equal(await serveOff(other.run, HOST, ["http://127.0.0.1:5000"]), "AllowFunnel" in config);
	}
	// With nothing configured, serve status prints null: 8443 is free.
	let empty: string | undefined;
	const blank: Run = async (args) => (args[1] === "status" ? (empty ?? "null") : ((empty = JSON.stringify(entry(args[3]!))), ""));
	await serveOn(blank, HOST, "http://127.0.0.1:5000");
	assert.equal(empty, JSON.stringify(entry("http://127.0.0.1:5000")));
	const ignored: Run = async (args) => (args[1] === "status" ? JSON.stringify(theirs) : "");
	await assert.rejects(serveOn(ignored, HOST, "http://127.0.0.1:5000"), /did not take the entry/);
});

test("a pairing code works once and only within ten minutes; turning remote off voids codes and sessions", () => {
	const access = createAccess("t".repeat(32));
	assert.equal(access.pair(), undefined, "no codes while remote is off");
	access.enable({ host: HOST, login: LOGIN });
	const req = (path: string, headers: Record<string, string> = {}) => access.check({ method: "GET", headers: { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.1.2.3", ...headers } } as unknown as IncomingMessage, 1234, "t".repeat(32), path.split("/"));
	const code = access.pair()!;
	assert.deepEqual(req(`pair/${code}`, { "tailscale-user-login": "other@example.com" }), { status: 403 }, "another user's device is refused and does not use the code up");
	const first = req(`pair/${code}`);
	assert.ok("cookie" in first);
	assert.deepEqual(req(`pair/${code}`), { status: 403 }, "used up");
	assert.deepEqual(req("", { cookie: `sb_remote=${first.cookie}` }), { origin: `https://${HOST}`, remote: true });
	const late = access.pair()!, now = Date.now();
	mock.method(Date, "now", () => now + 10 * 60_000 + 1);
	try {
		assert.deepEqual(req(`pair/${late}`), { status: 403 }, "expired");
	} finally {
		mock.restoreAll();
	}
	// Expired codes go before live ones: the QR on screen survives fifteen more codes asked for meanwhile.
	const shown = access.pair()!, codeNow = Date.now();
	for (let i = 0; i < 15; i++) access.pair();
	mock.method(Date, "now", () => codeNow + 1);
	try {
		assert.ok("cookie" in req(`pair/${shown}`), "the shown code still pairs");
	} finally {
		mock.restoreAll();
	}
	access.disable();
	assert.deepEqual(req("", { cookie: `sb_remote=${first.cookie}` }), { status: 403 }, "remote off: refused outright");
});

test("turning remote on as another Tailscale identity voids what the old one paired and ends its streams", () => {
	let ended = 0;
	const access = createAccess("t".repeat(32), () => ended++);
	access.enable({ host: HOST, login: LOGIN });
	const code = access.pair()!;
	access.enable({ host: HOST, login: LOGIN });
	assert.equal(ended, 0, "the same identity again keeps paired devices");
	access.enable({ host: HOST, login: "other@example.com" });
	assert.equal(ended, 1);
	assert.deepEqual(access.check({ method: "GET", headers: { host: HOST, "tailscale-user-login": "other@example.com", "x-forwarded-for": "100.1.2.3" } } as unknown as IncomingMessage, 1234, "t".repeat(32), ["pair", code]), { status: 403 }, "the old identity's code is void");
});

/** A raw request through the server, as tailscale serve would forward it unless told otherwise. */
function remoteGet(gui: Gui, path: string, headers: Record<string, string | undefined> = {}, method = "GET", body?: string) {
	const all = Object.fromEntries(Object.entries({ host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97", "x-forwarded-proto": "https", "tailscale-headers-info": "https://tailscale.com/s/serve-headers", ...headers }).filter((e): e is [string, string] => e[1] !== undefined));
	return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: gui.port, path, method, headers: all, agent: false }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
		});
		req.on("error", reject).end(body);
	});
}

test("over the tailnet: only this user's paired devices get in, a code pairs once, and remote off ends their streams", async () => {
	const calls: string[] = [];
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file: "/s/2026_sess-1.jsonl", pane: "wA:p1", live: true } : undefined);
	const call = async (method: string) => (calls.push(method), method === "pane.get" ? { pane: { pane_id: "wA:p1", agent: "pi", agent_status: "idle", agent_session: { value: "/s/2026_sess-1.jsonl" } } } : {});
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, dir: join(scratch, "bundle"), pollMs: 50, pingMs: 1000 });
	running.push(gui);
	const page = `/${gui.token}/`;
	assert.equal((await remoteGet(gui, page)).status, 403, "remote is off: a forwarded request is refused");
	assert.equal((await remoteGet(gui, page, { host: `127.0.0.1:${gui.port}` })).status, 403, "a forwarded request with a local Host is not local");
	gui.access.enable({ host: HOST, login: LOGIN });
	assert.equal((await remoteGet(gui, page)).status, 401, "not paired yet");
	for (const headers of [{ "tailscale-user-login": undefined }, { "tailscale-user-login": "other@example.com" }, { "tailscale-funnel-request": "?1" }, { host: "box.tail1.ts.net" }, { host: "evil.example:8443" }]) assert.equal((await remoteGet(gui, page, headers)).status, 403, JSON.stringify(headers));
	const code = gui.access.pair()!;
	const paired = await remoteGet(gui, `${page}pair/${code}`);
	assert.equal(paired.status, 200);
	const cookie = String(paired.headers["set-cookie"]);
	assert.match(cookie, new RegExp(`^sb_remote=[0-9a-f]{64}; Path=/${gui.token}/; Max-Age=\\d+; HttpOnly; Secure; SameSite=Strict$`));
	assert.match(paired.body, new RegExp(`http-equiv="refresh" content="0;url=/${gui.token}/"`));
	assert.equal((await remoteGet(gui, `${page}pair/${code}`)).status, 403, "the same QR does not pair twice");
	const jar = cookie.split(";")[0]!;
	assert.equal((await remoteGet(gui, page, { cookie: jar })).status, 200);
	assert.equal((await remoteGet(gui, page, { cookie: jar, "tailscale-user-login": "other@example.com" })).status, 403, "a cookie alone is not enough");
	const json = (origin: string, csrf = gui.csrf) => ({ cookie: jar, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": csrf });
	const body = JSON.stringify({ text: "from the phone", as: "send" });
	assert.equal((await remoteGet(gui, `${page}api/sessions/sess-1/input`, json(`http://127.0.0.1:${gui.port}`), "POST", body)).status, 403, "a remote page's origin is its https name");
	assert.equal((await remoteGet(gui, `${page}api/sessions/sess-1/input`, json(`https://${HOST}`, "0".repeat(32)), "POST", body)).status, 403, "CSRF applies over remote too");
	assert.equal((await remoteGet(gui, `${page}api/sessions/sess-1/input`, json(`https://${HOST}`), "POST", body)).status, 200);
	assert.deepEqual(calls, ["pane.get", "agent.prompt"]);
	const pair = await remoteGet(gui, `${page}api/remote/pair`, json(`https://${HOST}`), "POST", "{}");
	assert.equal(pair.status, 200);
	assert.match(JSON.parse(pair.body).url, new RegExp(`^https://${HOST}/${gui.token}/pair/[\\w-]{22}$`));
	let ended = false;
	const stream = get({ host: "127.0.0.1", port: gui.port, path: `${page}events`, headers: { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97", cookie: jar }, agent: false }, (res) => (res.resume(), res.on("close", () => (ended = true))));
	stream.on("error", () => (ended = true));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(ended, false);
	gui.access.disable();
	await until(() => ended, "the remote stream to end");
	assert.equal((await remoteGet(gui, page, { cookie: jar })).status, 403);
	assert.equal((await remoteGet(gui, page, { host: `127.0.0.1:${gui.port}`, "tailscale-user-login": undefined, "x-forwarded-for": undefined, "x-forwarded-proto": undefined, "tailscale-headers-info": undefined })).status, 200, "the local page is unaffected");
});

test("switchRemote turns the entry on with a QR and records it, and off removes it, also one a crashed session left", async () => {
	const dir = join(scratch, "state");
	mkdirSync(dir, { recursive: true });
	const ts = fakeTailscale();
	const gui = { port: 5000, token: "t".repeat(32), access: createAccess("t".repeat(32)) };
	const on = await switchRemote(gui, true, dir, ts.run);
	assert.match(on.text, /Remote access is on for me@example.com, tailnet only/);
	assert.ok(on.lines!.length > 20 && on.lines!.some((l) => l.includes("█")), "a QR to scan");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "remote.json"), "utf8")), { target: "http://127.0.0.1:5000", pid: process.pid, started: startOf(process.pid) });
	assert.deepEqual(gui.access.remote, { host: HOST, login: LOGIN });
	const off = await switchRemote(gui, false, dir, ts.run);
	assert.deepEqual([off.changed, gui.access.remote, existsSync(join(dir, "remote.json"))], [true, undefined, false]);
	assert.deepEqual(ts.config(), theirs);
	assert.deepEqual(await switchRemote(gui, false, dir, ts.run), { text: "Remote access is off", changed: false }, "nothing on, nothing recorded: Tailscale is not asked");
	writeFileSync(join(dir, "remote.json"), JSON.stringify({ target: "http://127.0.0.1:4000" }));
	const crashed = fakeTailscale({ ...theirs, ...entry("http://127.0.0.1:4000") });
	assert.equal((await switchRemote(gui, false, dir, crashed.run)).changed, true);
	assert.deepEqual(crashed.config(), theirs, "the leftover entry is gone, the other one stays");
	const missing: Run = async () => Promise.reject(new Error("Tailscale is not installed (no tailscale command on PATH)"));
	await assert.rejects(switchRemote(gui, true, dir, missing), /not installed/);
	assert.equal(gui.access.remote, undefined);
});

test("a recorded server counts as running only when its PID is alive and that process is the one that wrote the entry", () => {
	const at = Date.parse("Sat Oct 17 22:00:00 2026 UTC"), same = () => "Sat Oct 17 21:00:00 2026";
	assert.equal(runs({ pid: process.pid, started: "Sat Oct 17 21:00:00 2026" }, at, same), true, "same PID, same start time");
	assert.equal(runs({ pid: process.pid, started: "Sat Oct 17 21:00:00 2026" }, at, () => "Sat Oct 17 23:30:00 2026"), false, "the PID went to a process that started later");
	assert.equal(runs({ pid: 2 ** 22 + 1, started: "x" }, at, same), false, "no such process");
	assert.equal(runs({ started: "x" }, at, same), false, "no PID");
	assert.equal(runs({ pid: process.pid }, at, () => "Sat Oct 17 21:00:00 2026"), true, "an entry from before start times: the process is older than the file");
	assert.equal(runs({ pid: process.pid }, at, () => "Sat Oct 17 22:30:00 2026"), false, "an entry from before start times: the process started after the file was written, so it did not write it");
	assert.equal(runs({ pid: process.pid, started: "x" }, at, () => undefined), true, "ps cannot say: another live server's entry is not taken for stale");
	assert.match(startOf(process.pid) ?? "", /\d{4}$/, "ps names this process's start time");
	// Two pi processes with another LANG or TZ write and read the same text, so a live server's entry is not taken for a crashed one's.
	const [lc, tz] = [process.env.LC_ALL, process.env.TZ], here = startOf(process.pid);
	try {
		Object.assign(process.env, { LC_ALL: "zh_TW.UTF-8", TZ: "Asia/Taipei" });
		assert.equal(startOf(process.pid), here, "the recorded start time does not depend on the reader's locale or time zone");
		assert.equal(runs({ pid: process.pid, started: here }, at, startOf), true);
	} finally {
		for (const [key, value] of [["LC_ALL", lc], ["TZ", tz]] as const) value === undefined ? delete process.env[key] : (process.env[key] = value);
	}
	assert.equal(runs({ pid: process.pid }, Date.parse("Sat Oct 17 20:00:00 2026 UTC"), () => "Sat Oct 17 21:00:00 2026"), false, "an older-format entry: the process started after the file (read as UTC) was written");
	assert.equal(startOf(2 ** 22 + 1), undefined);
});

test("an entry whose server crashed and whose PID another process now holds is taken over, while the entry of a server that really runs stays", async () => {
	const dir = join(scratch, "reused");
	mkdirSync(dir, { recursive: true });
	const gui = { port: 5000, token: "t".repeat(32), access: createAccess("t".repeat(32)) }, old = "http://127.0.0.1:4000";
	const record = (started?: string) => writeFileSync(join(dir, "remote.json"), JSON.stringify({ target: old, pid: process.ppid, started }));
	// The recorded PID is alive (the test runner's parent) but it is another process than the crashed server was.
	record("Mon Jan  1 00:00:00 2001");
	const crashed = fakeTailscale({ ...theirs, ...entry(old) });
	await switchRemote(gui, true, dir, crashed.run);
	assert.equal(JSON.stringify(crashed.config()).includes("127.0.0.1:5000"), true, "remote came on over the leftover entry");
	assert.equal(JSON.stringify(crashed.config()).includes("127.0.0.1:4000"), false);
	gui.access.disable();
	record("Mon Jan  1 00:00:00 2001");
	const cleaned = fakeTailscale({ ...theirs, ...entry(old) });
	assert.equal((await switchRemote(gui, false, dir, cleaned.run)).changed, true);
	assert.deepEqual(cleaned.config(), theirs, "off removes the crashed server's leftover entry and nothing else");
	// The same PID with the start time the live process really has: that server runs, its entry is not ours.
	record(startOf(process.ppid));
	const live = fakeTailscale({ ...theirs, ...entry(old) });
	await assert.rejects(switchRemote(gui, true, dir, live.run), /already serves something else/);
	assert.deepEqual(live.changes(), [], "nothing was changed");
	assert.equal(gui.access.remote, undefined);
	assert.deepEqual((await switchRemote(gui, false, dir, live.run)).changed, false, "remote off finds nothing of its own to remove");
	assert.equal(JSON.stringify(live.config()).includes("127.0.0.1:4000"), true, "turning remote off here leaves a live server's entry alone");
});

test("copying with a clipboard command that is missing rejects with the reason and leaves the process running", async () => {
	await assert.rejects(copyText("https://example/pair/x", ["psb-no-such-clipboard-command"]), /Could not copy with psb-no-such-clipboard-command/);
	await new Promise((resolve) => setTimeout(resolve, 50)); // a late EPIPE from the child's stdin would surface here as an uncaught error
});
