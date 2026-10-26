import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get, type IncomingMessage, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { startGui, type Gui } from "../src/gui.ts";
import type { Found } from "../src/net.ts";
import { labelOf } from "../src/devices.ts";
import { createAccess, identity, PORT, type Run, runs, serveOff, serveOn, switchRemote } from "../src/remote.ts";
import { createStartOf, startCommand, startOf } from "../src/startof.ts";
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
	await serveOn(stale.run, HOST, "http://127.0.0.1:5000", ["http://127.0.0.1:4000"]);
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
	const req = (path: string, headers: Record<string, string> = {}) => access.check({ method: "GET", headers: { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.1.2.3", ...headers } } as unknown as IncomingMessage, "remote", 1234, "t".repeat(32), path.split("/"));
	const code = access.pair()!;
	assert.deepEqual(req(`pair/${code}`, { "tailscale-user-login": "other@example.com" }), { status: 403 }, "another user's device is refused and does not use the code up");
	const first = req(`pair/${code}`);
	assert.ok("cookie" in first);
	assert.deepEqual(req(`pair/${code}`), { status: 403 }, "used up");
	assert.deepEqual(req("", { cookie: `sb_remote=${first.cookie}` }), IN(first.cookie));
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

const T = "t".repeat(32), ID = { host: HOST, login: LOGIN };
/** One request on the remote listener as `tailscale serve` forwards it. */
const via = (a: ReturnType<typeof createAccess>, path: string, headers: Record<string, string> = {}, method = "GET") => a.check({ method, headers: { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.1.2.3", ...headers } } as unknown as IncomingMessage, "remote", 1234, T, path.split("/"));
const pairWith = (a: ReturnType<typeof createAccess>, ua?: string) => (via(a, `pair/${a.pair()}`, ua ? { "user-agent": ua } : {}) as { cookie: string }).cookie;
const IN = (cookie: string) => ({ origin: `https://${HOST}`, remote: true, device: createHash("sha256").update(cookie).digest("hex") });

test("a paired device survives remote off and on, a new server, and a takeover, kept as a hash only; another identity voids it", () => {
	const file = join(scratch, "paired.json");
	const first = createAccess(T, () => {}, file);
	first.enable(ID);
	const cookie = pairWith(first);
	assert.ok(!readFileSync(file, "utf8").includes(cookie), "only the cookie's hash is saved");
	assert.equal(statSync(file).mode & 0o777, 0o600);
	first.disable(); // remote off, as /boss gui remote off or the page does
	assert.deepEqual(via(first, "", { cookie: `sb_remote=${cookie}` }), { status: 403 }, "nothing gets in while remote is off");
	const next = createAccess(T, () => {}, file); // a new server on the same file
	assert.deepEqual(via(next, "", { cookie: `sb_remote=${cookie}` }), { status: 403 }, "nothing gets in before remote is on again");
	next.enable(ID);
	assert.deepEqual(via(next, "", { cookie: `sb_remote=${cookie}` }), IN(cookie), "the paired phone is still in");
	next.disable(true); // the server stops (stop, takeover, the session's end)
	const third = createAccess(T, () => {}, file);
	third.enable(ID);
	assert.deepEqual(via(third, "", { cookie: `sb_remote=${cookie}` }), IN(cookie), "and after the next server too");
	third.disable();
	const other = createAccess(T, () => {}, file);
	other.enable({ host: HOST, login: "other@example.com" });
	assert.deepEqual(via(other, "", { cookie: `sb_remote=${cookie}`, "tailscale-user-login": "other@example.com" }), { status: 401 }, "another Tailscale identity voids it");
	other.disable();
	const back = createAccess(T, () => {}, file);
	back.enable(ID);
	assert.deepEqual(via(back, "", { cookie: `sb_remote=${cookie}` }), { status: 401 }, "and it does not come back with the first identity");
	back.disable();
});

test("every use renews a pairing: the expiry slides and the cookie is issued again, at most once an hour; 90 days without use ends it", () => {
	const file = join(scratch, "sliding.json"), DAY = 24 * 3600_000, t0 = Date.now();
	const a = createAccess(T, () => {}, file);
	a.enable(ID);
	const cookie = pairWith(a), jar = { cookie: `sb_remote=${cookie}` };
	const at = (ms: number) => mock.method(Date, "now", () => t0 + ms);
	try {
		at(30 * 60_000);
		assert.deepEqual(via(a, "", jar), IN(cookie), "within the hour: no new cookie");
		at(60 * DAY);
		assert.deepEqual(via(a, "", jar), { ...IN(cookie), reissue: cookie }, "a use after an hour renews it and asks for the cookie again");
		assert.deepEqual(via(a, "", jar), IN(cookie), "once");
		const kept = createAccess(T, () => {}, file); // the renewal is saved
		kept.enable(ID);
		at(149 * DAY);
		assert.deepEqual(via(kept, "", jar), { ...IN(cookie), reissue: cookie }, "149 days after pairing, 89 after its last use: still paired, and renewed again");
		at(149 * DAY + 90 * DAY - 1);
		assert.deepEqual(via(kept, "", jar), { ...IN(cookie), reissue: cookie }, "just inside 90 days of the last use");
		at(149 * DAY + 90 * DAY - 1 + 90 * DAY + 1);
		assert.deepEqual(via(kept, "", jar), { status: 401 }, "90 days unused ends it");
		assert.deepEqual(kept.devices.list(), [], "and it is forgotten");
	} finally {
		mock.restoreAll();
	}
	a.disable();
});

test("the desktop lists paired devices by the name their User-Agent gave and unpairs one or all; an unpaired cookie is refused and its streams end", () => {
	const file = join(scratch, "unpair.json"), ended: (string | undefined)[] = [];
	const a = createAccess(T, (device) => ended.push(device), file);
	a.enable(ID);
	const phone = pairWith(a, "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1");
	const laptop = pairWith(a, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
	const unknown = pairWith(a);
	assert.deepEqual(a.devices.list().map((d) => d.label).sort(), ["", "Mac · Chrome", "iPhone · Safari"]);
	assert.ok(a.devices.list().every((d) => /^[0-9a-f]{16}$/.test(d.id) && d.paired > 0 && d.seen >= d.paired));
	assert.ok(!readFileSync(file, "utf8").includes("Mozilla"), "the raw User-Agent is not kept");
	const id = a.devices.list().find((d) => d.label === "iPhone · Safari")!.id;
	const before = ended.length;
	assert.equal(a.devices.unpair("0".repeat(16)), false, "no such device");
	assert.equal(a.devices.unpair(id.slice(0, 3)), false, "too short a prefix names nothing");
	assert.equal(a.devices.unpair(id), true);
	assert.equal(ended.length, before + 1);
	assert.ok(ended.at(-1), "that device's streams end, not everyone's");
	assert.deepEqual(via(a, "", { cookie: `sb_remote=${phone}` }), { status: 401 });
	assert.deepEqual(via(a, "", { cookie: `sb_remote=${laptop}` }), IN(laptop), "the others stay");
	assert.equal(a.devices.unpairAll(), 2);
	assert.equal(ended.at(-1), undefined, "all streams end");
	for (const c of [laptop, unknown]) assert.deepEqual(via(a, "", { cookie: `sb_remote=${c}` }), { status: 401 });
	const reread = createAccess(T, () => {}, file);
	assert.deepEqual(reread.devices.list(), [], "and the file forgot them");
	a.disable();
});

test("remote access stays wanted across a stopped server and a new one until it is turned off explicitly", () => {
	const file = join(scratch, "wanted.json");
	const a = createAccess(T, () => {}, file);
	assert.equal(a.wanted, false);
	a.enable(ID);
	assert.equal(a.wanted, true);
	a.disable(true); // the server stops: /boss gui stop, a takeover, the end of the session
	const b = createAccess(T, () => {}, file);
	assert.deepEqual([b.wanted, b.remote], [true, undefined], "a new server remembers, and is not on until it turns itself on");
	b.disable(); // remote off
	assert.equal(createAccess(T, () => {}, file).wanted, false);
	assert.equal(existsSync(file), false, "with no device and no wish, nothing is kept");
});

test("a device is named from its User-Agent by platform and browser only", () => {
	assert.equal(labelOf("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1"), "iPhone · Chrome");
	assert.equal(labelOf("Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36 EdgA/140"), "Android · Chrome");
	assert.equal(labelOf("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"), "Linux · Firefox");
	assert.equal(labelOf("curl/8.0"), "");
	assert.equal(labelOf(undefined), "");
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
	assert.deepEqual(access.check({ method: "GET", headers: { host: HOST, "tailscale-user-login": "other@example.com", "x-forwarded-for": "100.1.2.3" } } as unknown as IncomingMessage, "remote", 1234, "t".repeat(32), ["pair", code]), { status: 403 }, "the old identity's code is void");
});

/** A raw request through the server, as tailscale serve would forward it unless told otherwise. */
function remoteGet(gui: Gui, path: string, headers: Record<string, string | undefined> = {}, method = "GET", body?: string, port = gui.remotePort) {
	const all = Object.fromEntries(Object.entries({ host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97", "x-forwarded-proto": "https", "tailscale-headers-info": "https://tailscale.com/s/serve-headers", ...headers }).filter((e): e is [string, string] => e[1] !== undefined));
	return new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: all, agent: false }, (res) => {
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
	const bare = { host: `127.0.0.1:${gui.remotePort}`, "tailscale-user-login": undefined, "x-forwarded-for": undefined, "x-forwarded-proto": undefined, "tailscale-headers-info": undefined };
	assert.equal((await remoteGet(gui, page, bare)).status, 403, "remote is off: nothing on the remote listener gets in, bare or not");
	gui.access.enable({ host: HOST, login: LOGIN });
	assert.equal((await remoteGet(gui, page)).status, 401, "not paired yet");
	// Launching the installed app on Android is a navigation from another site, which leaves the SameSite=Strict cookie behind: the page reloads itself once.
	for (const site of ["cross-site", "same-site", "none"]) {
		const launch = await remoteGet(gui, page, { "sec-fetch-site": site, "sec-fetch-dest": "document" });
		assert.deepEqual([launch.status, launch.headers["content-type"]], [401, "text/html; charset=utf-8"], site);
		assert.match(launch.body, /<meta http-equiv="refresh" content="0">/, `${site}: a page load from outside reloads itself, same-origin, so the cookie can ride along`);
		assert.match(launch.body, /<a href="">/, "and links to itself for a browser that blocks refresh");
	}
	for (const [headers, method] of [[{ "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" }], [{ "sec-fetch-site": "cross-site", "sec-fetch-dest": "script" }], [{ "sec-fetch-dest": "document" }], [{ "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" }, "POST"]] as const) {
		const r = await remoteGet(gui, page, headers, method, method && "{}");
		assert.deepEqual([r.status, r.headers["content-type"]], [401, "text/plain"], `${JSON.stringify(headers)}: the plain refusal, so the reload never loops`);
		assert.match(r.body, /not paired.*camera/);
	}
	for (const headers of [{ "tailscale-user-login": undefined }, { "tailscale-user-login": "other@example.com" }, { "tailscale-funnel-request": "?1" }, { host: "box.tail1.ts.net" }, { host: "evil.example:8443" }]) {
		assert.equal((await remoteGet(gui, page, headers)).status, 403, JSON.stringify(headers));
		assert.equal((await remoteGet(gui, page, { ...headers, "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" })).status, 403, `${JSON.stringify(headers)}: identity is checked before the reload`);
	}
	const code = gui.access.pair()!;
	const paired = await remoteGet(gui, `${page}pair/${code}`);
	assert.equal(paired.status, 200);
	const cookie = String(paired.headers["set-cookie"]);
	assert.match(cookie, new RegExp(`^sb_remote=[0-9a-f]{64}; Path=/${gui.token}/; Max-Age=\\d+; HttpOnly; Secure; SameSite=Strict$`));
	assert.match(paired.body, new RegExp(`http-equiv="refresh" content="0;url=/${gui.token}/"`));
	assert.equal((await remoteGet(gui, `${page}pair/${code}`)).status, 403, "the same QR does not pair twice");
	const jar = cookie.split(";")[0]!;
	assert.equal((await remoteGet(gui, page, { cookie: jar })).status, 200);
	assert.equal((await remoteGet(gui, page, { cookie: jar, "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" })).status, 200, "a page load from outside that carries the cookie goes straight in");
	assert.equal((await remoteGet(gui, page, { cookie: jar, "tailscale-user-login": "other@example.com" })).status, 403, "a cookie alone is not enough");
	const json = (origin: string, csrf = gui.csrf) => ({ cookie: jar, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": csrf });
	const body = JSON.stringify({ text: "from the phone", as: "send" });
	assert.equal((await remoteGet(gui, `${page}api/sessions/sess-1/input`, json(`http://127.0.0.1:${gui.port}`), "POST", body)).status, 403, "a remote page's origin is its https name");
	assert.equal((await remoteGet(gui, `${page}api/sessions/sess-1/input`, json(`https://${HOST}`, "0".repeat(32)), "POST", body)).status, 403, "CSRF applies over remote too");
	assert.equal((await remoteGet(gui, `${page}api/sessions/sess-1/input`, json(`https://${HOST}`), "POST", body)).status, 200);
	assert.deepEqual(calls, ["pane.get", "agent.prompt"]);
	assert.equal((await remoteGet(gui, `${page}api/remote/pair`, json(`https://${HOST}`), "POST", "{}")).status, 403, "pairing a new device is the desktop's: a paired device cannot mint a code");
	let ended = false;
	const stream = get({ host: "127.0.0.1", port: gui.remotePort, path: `${page}events`, headers: { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97", cookie: jar }, agent: false }, (res) => (res.resume(), res.on("close", () => (ended = true))));
	stream.on("error", () => (ended = true));
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(ended, false);
	gui.access.disable();
	await until(() => ended, "the remote stream to end");
	assert.equal((await remoteGet(gui, page, { cookie: jar })).status, 403);
	assert.equal((await remoteGet(gui, page, { host: `127.0.0.1:${gui.port}`, "tailscale-user-login": undefined, "x-forwarded-for": undefined, "x-forwarded-proto": undefined, "tailscale-headers-info": undefined }, "GET", undefined, gui.port)).status, 200, "the local page is unaffected");
});

test("switchRemote turns the entry on with a QR and records it, and off removes it, also one a crashed session left", async () => {
	const dir = join(scratch, "state");
	mkdirSync(dir, { recursive: true });
	const ts = fakeTailscale();
	const gui = { port: 5000, remotePort: 6000, token: "t".repeat(32), access: createAccess("t".repeat(32)) };
	const on = await switchRemote(gui, true, dir, ts.run);
	assert.match(on.text, /Remote access is on for me@example.com, tailnet only/);
	assert.ok(on.lines!.length > 20 && on.lines!.some((l) => l.includes("█")), "a QR to scan");
	assert.deepEqual(JSON.parse(readFileSync(join(dir, "remote.json"), "utf8")), { target: "http://127.0.0.1:6000", pid: process.pid, started: startOf(process.pid) });
	assert.deepEqual(gui.access.remote, { host: HOST, login: LOGIN });
	const off = await switchRemote(gui, false, dir, ts.run);
	assert.deepEqual([off.changed, gui.access.remote, existsSync(join(dir, "remote.json"))], [true, undefined, false]);
	assert.deepEqual(ts.config(), theirs);
	assert.deepEqual(await switchRemote(gui, false, dir, ts.run), { text: "Remote access is off", plain: "Remote access is off", changed: false }, "nothing on, nothing recorded: Tailscale is not asked");
	writeFileSync(join(dir, "remote.json"), JSON.stringify({ target: "http://127.0.0.1:4000" }));
	const crashed = fakeTailscale({ ...theirs, ...entry("http://127.0.0.1:4000") });
	assert.equal((await switchRemote(gui, false, dir, crashed.run)).changed, true);
	assert.deepEqual(crashed.config(), theirs, "the leftover entry is gone, the other one stays");
	const missing: Run = async () => Promise.reject(new Error("Tailscale is not installed (no tailscale command on PATH)"));
	await assert.rejects(switchRemote(gui, true, dir, missing), /not installed/);
	assert.equal(gui.access.remote, undefined);
});

test("an entry that points at the local port is repointed at the remote listener, and when it cannot be, remote stays off", async () => {
	const dir = join(scratch, "migrate");
	mkdirSync(dir, { recursive: true });
	const gui = { port: 5000, remotePort: 6000, token: "t".repeat(32), access: createAccess("t".repeat(32)) };
	// An entry the previous version wrote: it points at the local port and nothing recorded it (no remote.json).
	const old = fakeTailscale({ ...theirs, ...entry("http://127.0.0.1:5000") });
	const on = await switchRemote(gui, true, dir, old.run);
	assert.match(on.text, /Remote access is on/);
	assert.deepEqual(old.changes(), [["serve", "--bg", `--https=${PORT}`, "http://127.0.0.1:6000"]], "serve was told the remote listener's target");
	assert.deepEqual(old.config(), { ...theirs, ...entry("http://127.0.0.1:6000") });
	assert.equal(JSON.parse(readFileSync(join(dir, "remote.json"), "utf8")).target, "http://127.0.0.1:6000");
	assert.equal((await switchRemote(gui, false, dir, old.run)).changed, true);
	assert.deepEqual(old.config(), theirs, "off removes the entry");
	// The same through a leftover entry that still points at the local port while remote is on: off removes that one too.
	const leftover = fakeTailscale({ ...theirs, ...entry("http://127.0.0.1:5000") });
	gui.access.enable({ host: HOST, login: LOGIN });
	assert.equal((await switchRemote(gui, false, dir, leftover.run)).changed, true);
	assert.deepEqual(leftover.config(), theirs);
	// Tailscale keeps the old target: remote stays off (fail closed), nothing is recorded, and the user is told why.
	const stuck: Run = async (args) => (args[0] === "status" ? status() : args.join(" ") === "serve status --json" ? JSON.stringify({ ...theirs, ...entry("http://127.0.0.1:5000") }) : "");
	await assert.rejects(switchRemote(gui, true, dir, stuck), /did not take the entry as asked \(http:\/\/127\.0\.0\.1:5000\); remote access stays off/);
	assert.equal(existsSync(join(dir, "remote.json")), false);
	// Another server's entry (a different port nobody recorded) is still not touched.
	const foreign = fakeTailscale({ ...theirs, ...entry("http://127.0.0.1:7777") });
	await assert.rejects(switchRemote(gui, true, dir, foreign.run), /already serves something else \(http:\/\/127\.0\.0\.1:7777\)/);
	assert.deepEqual(foreign.changes(), []);
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
	const gui = { port: 5000, remotePort: 6000, token: "t".repeat(32), access: createAccess("t".repeat(32)) }, old = "http://127.0.0.1:4000";
	const record = (started?: string) => writeFileSync(join(dir, "remote.json"), JSON.stringify({ target: old, pid: process.ppid, started }));
	// The recorded PID is alive (the test runner's parent) but it is another process than the crashed server was.
	record("Mon Jan  1 00:00:00 2001");
	const crashed = fakeTailscale({ ...theirs, ...entry(old) });
	await switchRemote(gui, true, dir, crashed.run);
	assert.equal(JSON.stringify(crashed.config()).includes("127.0.0.1:6000"), true, "remote came on over the leftover entry");
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

test("a request on the remote listener is remote whatever its Host or headers say, and the local listener lets in only a local-looking one", async () => {
	const gui = await startGui({ read: async () => ({ bases: [] }), dir: join(scratch, "bundle"), pollMs: 50, pingMs: 1000 });
	running.push(gui);
	assert.notEqual(gui.remotePort, gui.port, "two listeners");
	const page = `/${gui.token}/`, none = { "tailscale-user-login": undefined, "x-forwarded-for": undefined, "x-forwarded-proto": undefined, "tailscale-headers-info": undefined };
	const local = (path: string, headers: Record<string, string | undefined> = {}, method = "GET", body?: string) => remoteGet(gui, path, { host: `127.0.0.1:${gui.port}`, ...none, ...headers }, method, body, gui.port);
	const remote = (path: string, headers: Record<string, string | undefined> = {}, method = "GET", body?: string) => remoteGet(gui, path, headers, method, body);
	// The local page answers on the local listener, as it did.
	assert.equal((await local(page)).status, 200);
	// A request that looks as local as can be, sent to the remote listener, is remote: refused while remote is off, and never served as the local page.
	for (const host of [`127.0.0.1:${gui.remotePort}`, `127.0.0.1:${gui.port}`, `localhost:${gui.remotePort}`]) assert.equal((await remote(page, { host, ...none })).status, 403, `remote off, Host ${host}`);
	gui.access.enable({ host: HOST, login: LOGIN });
	for (const host of [`127.0.0.1:${gui.remotePort}`, `127.0.0.1:${gui.port}`]) assert.equal((await remote(page, { host, ...none })).status, 403, `remote on, bare request with Host ${host}`);
	assert.equal((await remote(page, { ...none, host: HOST, "tailscale-user-login": LOGIN })).status, 401, "a request with the right identity is remote: it needs pairing");
	// Pair, then try the actions only this computer's page may do: the remote listener refuses them even with the local Host and no forwarding header besides the identity.
	const cookie = String((await remote(`${page}pair/${gui.access.pair()}`)).headers["set-cookie"]).split(";")[0]!;
	const json = (origin: string) => ({ cookie, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf });
	assert.equal((await remote(`${page}api/remote/on`, json(`https://${HOST}`), "POST", "{}")).status, 403, "remote cannot turn remote on");
	assert.equal((await remote(`${page}api/server/stop`, json(`https://${HOST}`), "POST", JSON.stringify({ by: "x", take: false }))).status, 403, "remote cannot stop the server");
	assert.equal((await local(`${page}api/remote/on`, { origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf }, "POST", "{}")).status, 503, "the local page reaches the action (this test server has no onRemote)");
	// A serve entry that still points at the local port: its requests are forwarded and carry the tailnet Host, so the local listener refuses them, paired or not.
	for (const headers of [{ host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97" }, { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97", cookie }, { "x-forwarded-for": "100.87.7.97" }, { "tailscale-user-login": LOGIN }]) assert.equal((await local(page, headers)).status, 403, JSON.stringify(headers));
	assert.equal((await local(`${page}pair/${gui.access.pair()}`, { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97" })).status, 403, "the old entry cannot pair either");
});

test("the remote listener's port is kept across a restart when free, and two servers never share a port", async () => {
	const read = async () => ({ bases: [] }), dir = join(scratch, "bundle");
	const first = await startGui({ read, dir });
	running.push(first);
	// A second server asking for the first one's ports gets other ones, all four distinct.
	const second = await startGui({ read, dir, port: first.port, remotePort: first.remotePort });
	running.push(second);
	assert.equal(new Set([first.port, first.remotePort, second.port, second.remotePort]).size, 4);
	// A restart on the recorded ports keeps both.
	const [port, remotePort] = [first.port, first.remotePort];
	await first.stop();
	const again = await startGui({ read, dir, port, remotePort });
	running.push(again);
	assert.deepEqual([again.port, again.remotePort], [port, remotePort]);
	// A record that names one port for both (damaged gui.json) still gives two listeners.
	await again.stop();
	const same = await startGui({ read, dir, port, remotePort: port });
	running.push(same);
	assert.deepEqual([same.port, same.remotePort === port], [port, false]);
});

test("the desktop page lists, unpairs one, and unpairs all; a paired device is refused 403 on each, and unpairing ends that device's own streams at once", async () => {
	const gui = await startGui({ read: async () => ({ bases: [] }), dir: join(scratch, "bundle"), pollMs: 50, pingMs: 1000, paired: join(scratch, "gui-paired.json") });
	running.push(gui);
	gui.access.enable({ host: HOST, login: LOGIN });
	const page = `/${gui.token}/`;
	const pairOne = async (ua: string) => String((await remoteGet(gui, `${page}pair/${gui.access.pair()}`, { "user-agent": ua })).headers["set-cookie"]).split(";")[0]!;
	const phone = await pairOne("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"), tablet = await pairOne("Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1");
	const ends = { phone: false, tablet: false };
	for (const [name, jar] of [["phone", phone], ["tablet", tablet]] as const) {
		get({ host: "127.0.0.1", port: gui.remotePort, path: `${page}events`, headers: { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97", cookie: jar }, agent: false }, (res) => (res.resume(), res.on("close", () => (ends[name] = true)))).on("error", () => (ends[name] = true));
	}
	await new Promise((resolve) => setTimeout(resolve, 80));
	const mine = (path: string, payload: unknown = {}) => remoteGet(gui, `${page}api/${path}`, { host: `127.0.0.1:${gui.port}`, "tailscale-user-login": undefined, "x-forwarded-for": undefined, "x-forwarded-proto": undefined, "tailscale-headers-info": undefined, origin: `http://127.0.0.1:${gui.port}`, "content-type": "application/json", "x-sb-csrf": gui.csrf }, "POST", JSON.stringify(payload), gui.port);
	const theirs = (jar: string, path: string, payload: unknown = {}) => remoteGet(gui, `${page}api/${path}`, { cookie: jar, origin: `https://${HOST}`, "content-type": "application/json", "x-sb-csrf": gui.csrf }, "POST", JSON.stringify(payload));
	const listed = JSON.parse((await mine("remote/devices")).body) as { on: boolean; devices: { id: string; label: string; paired: number; seen: number }[] };
	assert.equal(listed.on, true);
	assert.deepEqual(listed.devices.map((d) => d.label).sort(), ["iPad · Safari", "iPhone · Safari"]);
	for (const path of ["remote/devices", "remote/unpair", "remote/unpair-all", "remote/off"]) assert.equal((await theirs(phone, path, { id: listed.devices[0]!.id })).status, 403, `a paired device cannot ${path}`);
	assert.deepEqual(ends, { phone: false, tablet: false });
	assert.equal((await mine("remote/unpair", { id: "f".repeat(16) })).status, 404);
	assert.equal((await mine("remote/unpair", {})).status, 400);
	const phoneId = listed.devices.find((d) => d.label === "iPhone · Safari")!.id;
	assert.equal((await mine("remote/unpair", { id: phoneId })).status, 200);
	await until(() => ends.phone, "the unpaired device's stream to end");
	assert.equal(ends.tablet, false, "the other device's stream stays");
	assert.equal((await remoteGet(gui, page, { cookie: phone })).status, 401, "the unpaired cookie is refused");
	assert.equal((await remoteGet(gui, page, { cookie: tablet })).status, 200);
	assert.deepEqual(JSON.parse((await mine("remote/unpair-all")).body), { unpaired: 1 });
	await until(() => ends.tablet, "the last stream to end");
	assert.equal((await remoteGet(gui, page, { cookie: tablet })).status, 401);
	assert.deepEqual(JSON.parse((await mine("remote/devices")).body).devices, []);
});

test("a paired.json an older build wrote (sessions, no wish) counts as wanted on; one with no sessions and no wish does not", () => {
	const hash = "a".repeat(64), file = join(scratch, "legacy.json");
	writeFileSync(file, JSON.stringify({ host: HOST, login: LOGIN, sessions: { [hash]: Date.now() + 3600_000 } }));
	const legacy = createAccess("t".repeat(32), () => {}, file);
	assert.equal(legacy.wanted, true, "remote was on when the older build's /reload saved its devices");
	assert.deepEqual(legacy.remembered, { host: HOST, login: LOGIN });
	assert.equal(legacy.devices.list().length, 1);
	writeFileSync(file, JSON.stringify({ host: HOST, login: LOGIN, sessions: {} }));
	assert.equal(createAccess("t".repeat(32), () => {}, file).wanted, false);
	writeFileSync(file, JSON.stringify({ host: HOST, login: LOGIN, wanted: false, sessions: { [hash]: Date.now() + 3600_000 } }));
	assert.equal(createAccess("t".repeat(32), () => {}, file).wanted, false, "an explicit no is kept");
});

test("a paired.json that cannot be written does not throw out of a request: the state stays in memory and the failure is reported", () => {
	const file = join(scratch, "no-such-dir", "paired.json"), access = createAccess("t".repeat(32), () => {}, file);
	assert.doesNotThrow(() => access.enable({ host: HOST, login: LOGIN }));
	const req = (path: string[]) => ({ method: "GET", headers: { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.1.2.3" } }) as unknown as IncomingMessage;
	const verdict = access.check(req([]), "remote", 1234, "t".repeat(32), ["pair", access.pair()!]);
	assert.ok("cookie" in verdict, "a code still pairs");
	assert.equal(access.devices.list().length, 1, "the device is kept in memory");
	assert.match(access.saveError ?? "", /no-such-dir|ENOENT/, "and the failure can be read");
	assert.doesNotThrow(() => access.devices.unpairAll());
	assert.equal(existsSync(file), false);
});

test("a failed paired.json save is reported: unpair, unpair all, and remote on/off answer 500 save_failed with the reason, the page and the session hear it, and the revocation stays in memory", async () => {
	const dir = join(scratch, "unwritable"), told: string[] = [];
	mkdirSync(dir);
	const file = join(dir, "paired.json"), ts = fakeTailscale({}), gui = await startGui({ read: async () => ({ bases: [] }), dir: join(scratch, "bundle"), paired: file, onRemote: async () => void (await switchRemote(gui, true, scratch, ts.run)), onRemoteOff: async () => void (await switchRemote(gui, false, scratch, ts.run)), onSaveFailed: (reason) => told.push(reason) });
	running.push(gui);
	const page = `/${gui.token}/`, local = { host: `127.0.0.1:${gui.port}`, "tailscale-user-login": undefined, "x-forwarded-for": undefined, "x-forwarded-proto": undefined, "tailscale-headers-info": undefined, origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf };
	const mine = (path: string, body = "{}") => remoteGet(gui, `${page}api/${path}`, local, "POST", body, gui.port);
	await switchRemote(gui, true, scratch, ts.run);
	const hashes = [1, 2].map(() => {
		const code = gui.access.pair()!;
		return gui.access.check({ method: "GET", headers: { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.1.2.3", "user-agent": "iPhone Safari" } } as unknown as IncomingMessage, "remote", gui.remotePort, gui.token, ["pair", code]);
	});
	assert.ok(hashes.every((v) => "cookie" in v));
	chmodSync(dir, 0o500); // nothing can be created in it now
	try {
		const id = gui.access.devices.list()[0]!.id;
		const one = await mine("remote/unpair", JSON.stringify({ id }));
		assert.equal(one.status, 500);
		assert.equal(JSON.parse(one.body).error, "save_failed");
		assert.match(JSON.parse(one.body).reason, /EACCES|permission|not saved/i);
		assert.equal(gui.access.devices.list().length, 1, "the device is unpaired in memory all the same");
		const all = await mine("remote/unpair-all");
		assert.equal(all.status, 500);
		assert.equal(gui.access.devices.list().length, 0);
		const off = await mine("remote/off");
		assert.equal(off.status, 500, "remote off that cannot persist the wish says so");
		assert.equal(gui.access.remote, undefined, "and is off all the same");
		assert.ok(told.length >= 3 && told.every((t) => /paired\.json|EACCES|permission/i.test(t)), "the session is told too");
	} finally {
		chmodSync(dir, 0o700);
	}
});

test("a legacy paired.json counts as wanted only while one of its sessions is still valid", () => {
	const file = join(scratch, "legacy-expired.json");
	writeFileSync(file, JSON.stringify({ host: HOST, login: LOGIN, sessions: { ["b".repeat(64)]: Date.now() - 1000 } }));
	assert.equal(createAccess("t".repeat(32), () => {}, file).wanted, false);
});

test("remote off keeps remote.json when the entry it records still exists under another host (an identity change), and removes it once nothing of ours is served", async () => {
	const dir = mkdtempSync(join(scratch, "rec-")), file = join(dir, "remote.json");
	const old = { TCP: { [PORT]: { HTTPS: true } }, Web: { "old.tail9.ts.net:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } } } };
	const ts = fakeTailscale(old), gui = { port: 5, remotePort: 6, token: "t".repeat(32), access: createAccess("t".repeat(32)) };
	writeFileSync(file, JSON.stringify({ target: "http://127.0.0.1:1", pid: 1 << 22 }));
	await switchRemote(gui, false, dir, ts.run, true);
	assert.equal(existsSync(file), true, "the old host's entry is still ours to remove later: the record stays");
	const clean = fakeTailscale({});
	await switchRemote(gui, false, dir, clean.run, true);
	assert.equal(existsSync(file), false, "nothing of ours is served any more: the record goes");
});

test("S7: on win32 a start time comes from a PowerShell call that is asynchronous, hidden, and limited to 5 s; nothing waits on it", async () => {
	const calls: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
	let finish: (error: Error | null, stdout: string) => void = () => {};
	const { startOf: start, startedLater } = createStartOf({
		platform: "win32", ps: () => { throw new Error("no ps on Windows"); },
		launch: (file, args, options, done) => (calls.push({ file, args, options }), (finish = done)),
	});
	assert.equal(start(4242), undefined, "the first look does not wait: unknown yet");
	assert.equal(start(4242), undefined);
	assert.equal(calls.length, 1, "one call in flight per PID");
	assert.equal(calls[0]!.file, "powershell.exe");
	assert.deepEqual(calls[0]!.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
	assert.equal(calls[0]!.args[3], "(Get-Process -Id 4242 -ErrorAction Stop).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')");
	assert.equal(calls[0]!.options.windowsHide, true);
	assert.equal(calls[0]!.options.timeout, 5000);
	assert.deepEqual(startCommand(4242).args, calls[0]!.args);
	const later = startedLater(4242);
	finish(null, "2026-10-26T04:21:53.123Z\r\n");
	assert.equal(await later, "2026-10-26T04:21:53.123Z");
	assert.equal(start(4242), "2026-10-26T04:21:53.123Z", "the answer is cached by PID");
	assert.equal(calls.length, 1);
});

test("S7: a PowerShell failure, a timeout, or text that is not an ISO time is undefined; a failed answer is asked again after 5 s, a good one of another PID after ten minutes, this process's own never", async () => {
	let clock = 0, reply: [Error | null, string] = [new Error("timed out"), ""], calls = 0;
	const { startOf: start, startedLater } = createStartOf({
		platform: "win32", now: () => clock,
		launch: (_file, _args, _options, done) => (calls++, queueMicrotask(() => done(...reply))),
	});
	assert.equal(await startedLater(9), undefined, "the call failed");
	assert.equal(start(9), undefined);
	assert.equal(calls, 1, "a failure is not asked again at once");
	reply = [null, "Mon Oct 26 04:21:53 2026"];
	clock += 5001;
	assert.equal(await startedLater(9), undefined, "not an ISO time");
	assert.equal(calls, 2);
	reply = [null, "2026-10-26T04:21:53.000Z"];
	clock += 5001;
	assert.equal(await startedLater(9), "2026-10-26T04:21:53.000Z");
	clock += 9 * 60_000;
	assert.equal(start(9), "2026-10-26T04:21:53.000Z");
	assert.equal(calls, 3);
	clock += 2 * 60_000;
	assert.equal(start(9), undefined, "ten minutes: asked again, so a reused PID is noticed");
	assert.equal(calls, 4);
	assert.equal(await startedLater(process.pid), "2026-10-26T04:21:53.000Z");
	clock += 24 * 3600_000;
	assert.equal(start(process.pid), "2026-10-26T04:21:53.000Z", "this process's own start time is kept for its life");
	assert.equal(calls, 5);
});

test("S7: runs reads the ISO form as it is, with and without a recorded start", () => {
	const wrote = Date.parse("2026-10-26T04:30:00.000Z");
	assert.equal(runs({ pid: process.pid, started: "2026-10-26T04:21:53.123Z" }, wrote, () => "2026-10-26T04:21:53.123Z"), true);
	assert.equal(runs({ pid: process.pid, started: "2026-10-26T04:21:53.123Z" }, wrote, () => "2026-10-26T05:00:00.000Z"), false, "the PID went to a process that started later");
	assert.equal(runs({ pid: process.pid }, wrote, () => "2026-10-26T04:21:53.123Z"), true, "no recorded start: the process is older than the file");
	assert.equal(runs({ pid: process.pid }, wrote, () => "2026-10-26T04:45:00.000Z"), false, "no recorded start: the process started after the file was written");
	assert.equal(runs({ pid: process.pid, started: "2026-10-26T04:21:53.123Z" }, wrote, () => undefined), true, "not known yet: the entry stands");
});
