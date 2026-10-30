import assert from "node:assert/strict";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after as afterAll, afterEach, mock, test } from "node:test";
import { createEntry } from "../src/appentry.ts";
import { LAN_COOKIE, type LanAt } from "../src/lan/access.ts";
import { createAccess } from "../src/remote.ts";
import { fakeClock } from "./fake-clock.ts";

// The installed app's fixed entry over Wi-Fi access (docs/specs/2026-10-30-sb-gui-lan.md, "Codes on screen", "Approval on this computer"; Steps L4): the token-free pair page, the waiting page, and the redemption, through real HTTP so the
// headers and bodies a phone would see are what is asserted. The `At` is the one the LAN listener would build; the peer comes from a test header since every client here is 127.0.0.1.

const T = "t".repeat(32), NAME = "weis-mbp", PORT = 8445;
const AT: LanAt = { address: "192.168.1.5", iface: "en0", port: PORT, name: NAME, host: `${NAME}.local`, origin: `https://${NAME}.local:${PORT}`, peer: "192.168.1.23" };
const HEADERS = { "content-security-policy": "default-src 'none'; frame-ancestors 'none'", "cache-control": "no-store", "referrer-policy": "no-referrer" };
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

const servers: Server[] = [];
afterEach(() => mock.restoreAll());
afterAll(() => Promise.all(servers.map((s) => new Promise((done) => s.close(done)))));

async function world() {
	const clock = fakeClock(Date.now());
	mock.method(Date, "now", clock.now);
	const timers = (fn: () => void, ms: number) => {
		let live = true;
		clock.at(clock.elapsed() + ms, () => live && fn());
		return () => void (live = false);
	};
	const access = createAccess(T, () => {}, undefined, { after: timers });
	access.lan.enable();
	const entry = createEntry(access, T, HEADERS);
	const server = createServer((req, res) => {
		const parts = (req.url ?? "").split("?")[0]!.split("/"); // ["", "sb-app", ...]
		const byAddress = String(req.headers.host).startsWith(AT.address), host = byAddress ? AT.address : AT.host; // the listener says which of its two allowed hosts matched
		entry(req, res, parts.slice(2), { ...AT, host, origin: `https://${host}:${PORT}`, peer: String(req.headers["x-peer"] ?? AT.peer) });
	});
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as AddressInfo).port;
	type Res = { status: number; headers: IncomingMessage["headers"]; body: string; text: string };
	const send = (path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Res>((resolve, reject) => {
		const r = request({ host: "127.0.0.1", port, path, method, agent: false, headers: { host: `${AT.host}:${PORT}`, "user-agent": IPHONE, ...headers } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text, text: `${JSON.stringify(res.headers)}\n${text}` }));
		});
		r.on("error", reject).end(body);
	});
	/** The entry's own form post, as the pair page's button or the typed field sends it. */
	const redeem = (code: string, headers: Record<string, string> = {}) => send("/sb-app/pair", { method: "POST", headers: { origin: AT.origin, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", ...headers }, body: `code=${encodeURIComponent(code)}` });
	const cookieOf = (res: Res) => new RegExp(`${LAN_COOKIE}=([0-9a-f]{64})`).exec(String(res.headers["set-cookie"]))?.[1];
	return { access, clock, send, redeem, cookieOf };
}

test("the QR's link carries a code and no token, and its GET shows a Pair button without using the code up", async () => {
	const w = await world();
	const code = w.access.pair("lan", "overlay-1")!;
	const page = await w.send(`/sb-app/pair/${code}`, { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" } });
	assert.equal(page.status, 200);
	assert.match(page.body, /Pair this device with Straw Boss on weis-mbp\.local\?/);
	assert.match(page.body, new RegExp(`<form method="post" action="/sb-app/pair"><input type="hidden" name="code" value="${code}">`));
	assert.ok(!page.text.includes(T), "no token on the page");
	assert.equal(page.headers["set-cookie"], undefined, "and no cookie");
	assert.match(String(page.headers["content-security-policy"]), /form-action 'self'/);
	// A prefetcher or link preview fetching the URL, any number of times, uses nothing up.
	for (let i = 0; i < 3; i++) assert.equal((await w.send(`/sb-app/pair/${code}`)).status, 200);
	assert.equal(w.access.lan.pending().length, 0);
	const zh = await w.send(`/sb-app/pair/${code}`, { headers: { "accept-language": "zh-TW,zh;q=0.9" } });
	assert.match(zh.body, /lang="zh-Hant"/);
	assert.match(zh.body, /要把這個裝置與以下電腦上的 Straw Boss 配對嗎/);
	// The page's button redeems it.
	const done = await w.redeem(code);
	assert.equal(done.status, 200);
	assert.equal(w.access.lan.pending().length, 1);
	// A code that is not shaped like one, or a host that is not allow-listed, gets no page.
	assert.equal((await w.send("/sb-app/pair/short")).status, 403);
	assert.equal((await w.send(`/sb-app/pair/${code}`, { headers: { host: "evil.example:8445" } })).status, 403);
	assert.equal((await w.send("/sb-app/pair/%3Cscript%3E%3Cscript%3E%3Cscript%3E")).status, 403, "markup in the code is never drawn");
});

test("a redeemed code gives the device the entry's cookie alone and a waiting page with the number; no response carries the token", async () => {
	const w = await world();
	const res = await w.redeem(w.access.pair("lan", "t1")!);
	assert.equal(res.status, 200);
	const cookies = res.headers["set-cookie"] as string[];
	assert.equal(cookies.length, 1, "one cookie");
	assert.match(cookies[0]!, new RegExp(`^${LAN_COOKIE}=[0-9a-f]{64}; Path=/sb-app/; Max-Age=\\d+; HttpOnly; Secure; SameSite=Strict$`), "scoped to the entry's path only, nothing for the token's");
	assert.ok(!res.text.includes(T), "the token is in neither a header nor the body");
	assert.equal(res.headers.location, undefined);
	const [pending] = w.access.lan.pending();
	assert.ok(pending);
	const number = /class="number">(\d{4})</.exec(res.body)?.[1];
	assert.ok(number, "the page shows the number to type on the computer");
	assert.match(res.body, /Waiting for the computer to allow this device/);
	assert.match(res.body, /<meta http-equiv="refresh" content="2;url=\/sb-app\/pair\/wait">/, "it reloads the waiting URL, not this POST");
	assert.deepEqual(Object.keys(pending), ["id", "label", "peer", "iface", "since"]);
	const jar = { cookie: `${LAN_COOKIE}=${w.cookieOf(res)}` };
	// Every route a pending device uses leads to the waiting page, with no token and no new cookie.
	const entry = await w.send("/sb-app/", { headers: jar });
	assert.deepEqual([entry.status, entry.headers.location, entry.headers["set-cookie"]], [302, "/sb-app/pair/wait", undefined]);
	const wait = await w.send("/sb-app/pair/wait", { headers: jar });
	assert.equal(wait.status, 200);
	assert.match(wait.body, new RegExp(`class="number">${number}<`));
	assert.ok(!wait.text.includes(T));
	// The page's other reaches stay shut: the page itself is not served by this handler, and a GET to the token path is not the entry's.
	assert.equal((await w.send(`/sb-app/${T}/`, { headers: jar })).status, 404);
});

test("once the boss types the number, the device's next /sb-app/ gets the token-path cookie and goes on; a denied or late one is told", async () => {
	const w = await world();
	const first = await w.redeem(w.access.pair("lan", "a")!), number = /class="number">(\d{4})</.exec(first.body)![1]!;
	const jar = { cookie: `${LAN_COOKIE}=${w.cookieOf(first)}` };
	const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
	assert.equal((await w.send("/sb-app/pair/wait", { headers: jar })).status, 200);
	assert.ok(w.access.lan.approve(number));
	const wait = await w.send("/sb-app/pair/wait", { headers: jar });
	assert.deepEqual([wait.status, wait.headers.location], [302, "/sb-app/"], "the waiting page moves on once it is allowed");
	const entry = await w.send("/sb-app/", { headers: { ...jar, ...nav } });
	assert.deepEqual([entry.status, entry.headers.location], [302, `/${T}/`], "and only now is the token given");
	const cookies = entry.headers["set-cookie"] as string[];
	assert.deepEqual(cookies.map((c) => /Path=([^;]+)/.exec(c)![1]), [`/${T}/`, "/sb-app/"], "both copies of the cookie");
	assert.ok(cookies.every((c) => c.startsWith(`${LAN_COOKIE}=${w.cookieOf(first)};`) && c.includes("HttpOnly; Secure; SameSite=Strict")));
	// A script's fetch (not a navigation) is not handed the token.
	assert.equal((await w.send("/sb-app/", { headers: { ...jar, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" } })).status, 403);
	// Denied.
	const b = await w.redeem(w.access.pair("lan", "b")!, { "x-peer": "192.168.1.31" }), jb = { cookie: `${LAN_COOKIE}=${w.cookieOf(b)}` };
	w.access.lan.deny("all");
	const denied = await w.send("/sb-app/pair/wait", { headers: jb });
	assert.match(denied.body, /The computer did not allow this device/);
	assert.equal((await w.send("/sb-app/", { headers: jb })).status, 200, "its entry asks for a code again");
	// Late.
	const c = await w.redeem(w.access.pair("lan", "c")!, { "x-peer": "192.168.1.32" }), jc = { cookie: `${LAN_COOKIE}=${w.cookieOf(c)}` };
	w.clock.advance(2 * 60_000);
	assert.match((await w.send("/sb-app/pair/wait", { headers: { ...jc, "accept-language": "en" } })).body, /Not allowed in time\. Ask the computer for a new code/);
	assert.match((await w.send("/sb-app/pair/wait", { headers: { ...jc, "accept-language": "zh-TW" } })).body, /沒有及時允許/);
	// A device with no cookie at all has no waiting page to see.
	assert.match((await w.send("/sb-app/pair/wait")).body, /This device is not paired/);
});

test("an unpaired device is asked for a code that names /boss gui lan; a Tailscale cookie is no pairing here; the cross-site launch reloads once", async () => {
	const w = await world();
	const page = await w.send("/sb-app/");
	assert.equal(page.status, 200);
	assert.match(page.body, /run \/boss gui lan \(or open Phone, Same Wi-Fi, in the page\)/);
	assert.match(page.body, /<form method="post" action="\/sb-app\/pair">/);
	assert.ok(!page.text.includes(T) && !/boss gui remote/.test(page.body), "no token, and the LAN page does not send a phone to the tailnet's command");
	assert.match((await w.send("/sb-app/", { headers: { "accept-language": "zh-TW" } })).body, /\/boss gui lan（或在頁面開啟「手機」>「同一個 Wi-Fi」）/);
	const tail = await w.send("/sb-app/", { headers: { cookie: `sb_remote=${"a".repeat(64)}`, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } });
	assert.equal(tail.status, 200, "a Tailscale device's cookie name is not read on the LAN");
	const bounce = await w.send("/sb-app/", { headers: { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" } });
	assert.match(bounce.body, /<meta http-equiv="refresh" content="0">/);
	assert.equal((await w.send("/sb-app")).status, 308);
	assert.equal((await w.send("/sb-app/nothing")).status, 404);
	assert.equal((await w.send("/sb-app/", { method: "DELETE" })).status, 403);
});

test("a wrong code is announced as a count and told as 'did not work'; five lock that address (429); the form post is the entry's own", async () => {
	const w = await world();
	const w1 = await w.redeem("ZZZZ-ZZZZ");
	assert.equal(w1.status, 403);
	assert.match(w1.body, /That code did not work/);
	assert.equal(w1.headers["set-cookie"], undefined);
	const typed = w.access.pairCode("lan", "t")!;
	for (let i = 0; i < 5; i++) await w.redeem("ZZZZ-ZZZZ"); // a new code gave the tries back, so five more lock it
	const locked = await w.redeem(typed);
	assert.equal(locked.status, 429);
	assert.match(locked.body, /Too many wrong codes from this device/);
	assert.ok(!locked.body.includes('name="code"'), "no field to type into");
	const other = await w.redeem(typed, { "x-peer": "192.168.1.77" });
	assert.equal(other.status, 200, "another address is not locked");
	assert.match(other.body, /class="number"/);
	assert.equal((await w.redeem(w.access.pair("lan", "q")!, { origin: "https://evil.example" })).status, 403, "another Origin");
	assert.equal((await w.redeem("x", { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await w.send("/sb-app/pair", { method: "POST", headers: { origin: AT.origin, "content-type": "application/x-www-form-urlencoded" }, body: "code=" + "a".repeat(2000) })).status, 413);
});

test("a fifth request is told the computer is busy and its code stays unused; a noisy peer gets 429", async () => {
	const w = await world();
	for (const peer of ["192.168.1.81", "192.168.1.82", "192.168.1.83", "192.168.1.84"]) assert.equal((await w.redeem(w.access.pair("lan", peer)!, { "x-peer": peer })).status, 200);
	const code = w.access.pair("lan", "late")!;
	const busy = await w.redeem(code, { "x-peer": "192.168.1.85" });
	assert.equal(busy.status, 503);
	assert.match(busy.body, /busy with other pair requests; try again in a minute/);
	assert.equal(busy.headers["set-cookie"], undefined);
	w.access.lan.deny("all");
	assert.equal((await w.redeem(code, { "x-peer": "192.168.1.85" })).status, 200, "the code was not used up");
	// 20 refusals in ten minutes from one address.
	for (let i = 0; i < 20; i++) assert.equal((await w.send("/sb-app/", { headers: { host: "evil.example:8445", "x-peer": "192.168.1.90" } })).status, 403);
	const limited = await w.send("/sb-app/", { headers: { "x-peer": "192.168.1.90" } });
	assert.equal(limited.status, 429);
	assert.match(limited.body, /Too many requests from this device/);
	assert.equal((await w.send("/sb-app/", { headers: { "x-peer": "192.168.1.91" } })).status, 200);
});

test("every route refuses a Host that is not on the listener's allow-list", async () => {
	const w = await world();
	const bad = { host: "attacker.example:8445" };
	for (const [method, path] of [["GET", "/sb-app"], ["GET", "/sb-app/"], ["GET", "/sb-app/pair/wait"], ["GET", `/sb-app/pair/${"a".repeat(22)}`], ["POST", "/sb-app/pair"]] as const)
		assert.equal((await w.send(path, { method, headers: { ...bad, origin: AT.origin, "content-type": "application/x-www-form-urlencoded" }, body: method === "POST" ? "code=x" : undefined })).status, 403, `${method} ${path}`);
	assert.equal((await w.send("/sb-app/", { headers: { host: `${NAME}.local` } })).status, 403, "no port");
	assert.equal((await w.send("/sb-app/", { headers: { host: `192.168.1.5:${PORT}` } })).status, 200, "the listener's own address is allowed");
});
