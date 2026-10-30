import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect, type Server as NetServer, type Socket } from "node:net";
import { Duplex } from "node:stream";
import { checkServerIdentity, connect as tlsConnect, type PeerCertificate } from "node:tls";
import { afterEach, test } from "node:test";
import { CA_FILES, createCa, crt, issueLeafFor as issueLeaf, mobileconfig, type LanCa } from "../src/lan/ca.ts";
import { createLanListener, type At, type ListenerOptions, type ListenerStatus } from "../src/lan/listener.ts";
import type { InterfaceInfo, Interfaces } from "../src/lan/net.ts";
import { fakeClock } from "./fake-clock.ts";

// The LAN listener (docs/specs/2026-10-30-sb-gui-lan.md, "The LAN listeners", "One port, two protocols", "Address changes", "Leaves", "The certificate page", and Tests, "Listener"). Everything binds 127.0.0.1 and nothing else: the
// interfaces handed in make 10.0.0.5 eligible, `bindAddress` maps it to loopback, and `remoteOf` says what peer a connection counts as, so the real gate runs on a made-up peer. No test binds a real LAN address.

const ADDRESS = "10.0.0.5", OTHER = "10.0.0.6", NAME = "weis-mbp";
const DAY = 24 * 3_600_000;
const MAC = "02:00:00:00:00:00";
const v4 = (address: string, prefix: number, o: Partial<InterfaceInfo> = {}): InterfaceInfo => ({ address, netmask: "", family: "IPv4", mac: MAC, internal: false, cidr: `${address}/${prefix}`, ...o });
const ca = createCa(NAME, Date.now());
const nameless = createCa(undefined, Date.now());

/** The clock's timers: a wait of N ms takes none, and the connection timers (first byte, handshake, log lines) fire when the test moves the clock. */
function timers(clock: ReturnType<typeof fakeClock>) {
	return {
		now: clock.now,
		after: (fn: () => void, ms: number) => {
			let live = true;
			clock.at(clock.elapsed() + ms, () => live && fn());
			return () => void (live = false);
		},
		sleep: async (ms: number) => clock.advance(ms),
	};
}

const open: { stop(): Promise<void> }[] = [];
const sockets = new Set<Socket>();
afterEach(async () => {
	for (const socket of sockets) socket.destroy();
	sockets.clear();
	for (const l of open.splice(0)) await l.stop();
});
const raw = (port: number) => {
	const socket = netConnect(port, "127.0.0.1");
	socket.on("error", () => {});
	socket.resume(); // a socket nobody reads from never sees the server's close behind the bytes it was sent
	sockets.add(socket);
	return socket;
};
const closed = (socket: Socket) => new Promise<void>((done) => (socket.destroyed ? done() : void socket.once("close", () => done())));
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface World {
	clock: ReturnType<typeof fakeClock>;
	state: { interfaces: Interfaces; peer: string };
	logs: [string, Record<string, unknown>][];
	calls: { url: string; host: string; at: At; paired: boolean }[];
	statuses: ListenerStatus[];
	listens: { host: string; port: number; server: NetServer }[];
	listener: ReturnType<typeof createLanListener>;
	port: number;
	hostName: string;
	hostAddress: string;
}
async function world(o: Partial<ListenerOptions> & { start?: boolean; address?: string } = {}): Promise<World> {
	const clock = fakeClock(), address = o.address ?? ADDRESS, { start = true, address: _address, ...rest } = o;
	const state = { interfaces: { en0: [v4(address, 24)] } as Interfaces, peer: "10.0.0.7" };
	const logs: World["logs"] = [], calls: World["calls"] = [], statuses: ListenerStatus[] = [], listens: World["listens"] = [];
	const listener = createLanListener({
		ca, port: 0, ...timers(clock),
		interfaces: () => state.interfaces, probe: async () => undefined, every: () => () => {},
		bindAddress: () => "127.0.0.1", remoteOf: () => state.peer,
		listen: (server, port, host) => new Promise<void>((done, fail) => {
			listens.push({ host, port, server });
			server.once("error", fail);
			server.listen(port, host, () => (server.off("error", fail), done()));
		}),
		isPaired: (req) => req.headers["x-paired"] === "1",
		handler: (req, res, at) => {
			calls.push({ url: req.url ?? "", host: req.headers.host ?? "", at, paired: req.headers["x-paired"] === "1" });
			res.writeHead(200, { "content-type": "text/plain" }).end("gui");
		},
		log: (event, fields) => logs.push([event, fields]), onStatus: (s) => statuses.push(s),
		...rest,
	});
	open.push(listener);
	if (start) await listener.start();
	const port = listener.portOf(address) ?? 0;
	return { clock, state, logs, calls, statuses, listens, listener, port, hostName: `${NAME}.local:${port}`, hostAddress: `${address}:${port}` };
}

interface Reply { status: number; headers: IncomingMessage["headers"]; body: string; cert?: PeerCertificate; socket: Socket }
const collect = (res: IncomingMessage, socket: Socket, cert: PeerCertificate | undefined) => new Promise<Reply>((done, fail) => {
	const chunks: Buffer[] = [];
	res.on("data", (c: Buffer) => chunks.push(c)).on("error", fail).on("end", () => done({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString("utf8"), cert, socket }));
});
interface Ask { host?: string; path?: string; headers?: Record<string, string>; agent?: HttpsAgent | false; trust?: boolean; ca?: LanCa; method?: string; tls?: Record<string, unknown> }
/** An HTTPS request to the listener's port, verified against the CA unless `trust` is false; `Host` is what the test says. */
function secure(port: number, ask: Ask = {}): Promise<Reply> {
	return new Promise((done, fail) => {
		const req = httpsRequest({
			host: "127.0.0.1", port, servername: `${NAME}.local`, path: ask.path ?? "/", method: ask.method ?? "GET", agent: ask.agent ?? false,
			ca: (ask.ca ?? ca).cert, rejectUnauthorized: ask.trust !== false, headers: { host: ask.host ?? `${NAME}.local:${port}`, ...ask.headers }, ...ask.tls,
		}, (res) => void collect(res, res.socket as Socket, (res.socket as import("node:tls").TLSSocket).getPeerCertificate()).then(done, fail));
		req.on("error", fail).end();
	});
}
function plain(port: number, ask: { host?: string; path?: string; method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
	return new Promise((done, fail) => {
		const req = httpRequest({ host: "127.0.0.1", port, path: ask.path ?? "/", method: ask.method ?? "GET", agent: false, headers: { host: ask.host ?? `${NAME}.local:${port}`, ...ask.headers } }, (res) => void collect(res, res.socket, undefined).then(done, fail));
		req.on("error", fail).end();
	});
}
const rejected = (p: Promise<unknown>) => p.then(() => undefined, (error: Error) => error);
/** The ClientHello of a verified TLS client, delivered to `real` in two pieces: its first byte alone, then (after a pause) the rest. */
function splitHello(port: number): Promise<string> {
	return new Promise((done, fail) => {
		const real = netConnect(port, "127.0.0.1");
		sockets.add(real);
		real.on("error", fail);
		let first = true;
		const duplex = new Duplex({
			read() {},
			write(chunk: Buffer, _enc, cb) {
				if (!first) return void real.write(chunk, () => cb());
				first = false;
				real.write(chunk.subarray(0, 1), () => void pause(40).then(() => real.write(chunk.subarray(1), () => cb())));
			},
		});
		real.on("data", (d) => duplex.push(d)).on("end", () => duplex.push(null));
		const client = tlsConnect({ socket: duplex, servername: `${NAME}.local`, ca: ca.cert }, () => client.write(`GET /x HTTP/1.1\r\nHost: ${NAME}.local:${port}\r\nConnection: close\r\n\r\n`));
		const chunks: Buffer[] = [];
		client.on("data", (c: Buffer) => chunks.push(c)).on("error", fail).on("end", () => done(Buffer.concat(chunks).toString("utf8")));
	});
}

// The gate ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("the gate closes a peer that is public, on another subnet, loopback, or IPv6 before any byte is answered, and counts the refusals into one line a minute", async () => {
	const w = await world();
	for (const peer of ["8.8.8.8", "10.0.1.7", "127.0.0.1", "::1", "100.64.0.9", "169.254.1.1", "172.32.0.1", "192.168.0.7", "::ffff:10.0.0.7"]) {
		w.state.peer = peer;
		const socket = raw(w.port);
		socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05])); // a handshake record's start, which an open listener would take on
		const received: Buffer[] = [];
		socket.on("data", (d: Buffer) => received.push(d));
		await closed(socket);
		assert.equal(Buffer.concat(received).length, 0, `${peer} got bytes back`);
	}
	assert.equal(w.calls.length, 0);
	assert.deepEqual(w.logs.filter(([e]) => e === "lan-refused"), [], "counted, not logged per connection");
	w.clock.advance(60_000);
	assert.deepEqual(w.logs.filter(([e]) => e === "lan-refused"), [["lan-refused", { n: 9 }]]);
	w.state.peer = "10.0.0.77";
	assert.equal((await secure(w.port)).status, 200, "a private peer on the subnet is let in");
	assert.equal((await plain(w.port, { path: "/sb-ca/" })).status, 200);
});

test("the subnet the gate holds follows the watch: a prefix change closes out a peer that was in", async () => {
	const w = await world();
	w.state.peer = "10.0.0.77";
	assert.equal((await secure(w.port)).status, 200);
	w.state.interfaces = { en0: [v4(ADDRESS, 28)] };
	await w.listener.tick();
	const socket = raw(w.port);
	socket.write("GET /sb-ca/ HTTP/1.1\r\n");
	await closed(socket);
	assert.equal(w.listener.portOf(ADDRESS), w.port, "the listener itself stayed");
	w.state.peer = "10.0.0.9";
	assert.equal((await secure(w.port)).status, 200);
});

// One port, two protocols ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("TLS reaches the GUI's handler with what the listener knows; plain HTTP reaches only the certificate pages and gets 400 for the rest", async () => {
	const w = await world();
	const gui = await secure(w.port, { path: "/token/state", headers: { cookie: "a=b" } });
	assert.equal(gui.status, 200);
	assert.equal(gui.body, "gui");
	assert.deepEqual(w.calls.map((c) => [c.url, c.at.address, c.at.iface, c.at.port, c.at.host, c.at.origin, c.at.peer, c.at.name]), [["/token/state", ADDRESS, "en0", w.port, `${NAME}.local`, `https://${NAME}.local:${w.port}`, "10.0.0.7", NAME]]);
	for (const path of ["/", "/sb-app/", "/token/state", "/sb-app/pair/ABCD", "/sb-ca", "/sb-ca/x", "/sb-ca/ok.svg", "/sb-ca/%2e%2e/", "//sb-ca/"]) {
		const r = await plain(w.port, { path, headers: { cookie: "sb_remote=1; __Secure-sb_lan=2" } });
		assert.equal(r.status, 400, path);
		assert.equal(r.headers["set-cookie"], undefined, "the plain side sets no cookie");
	}
	for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await plain(w.port, { path: "/sb-ca/", method })).status, 400, method);
	assert.equal(w.calls.length, 1, "nothing but the one TLS request reached the handler");
});

test("the Host allow-list: plain says 400 and TLS says 403 for any host that is neither the name nor the address with the bound port, before the handler is read", async () => {
	const w = await world();
	for (const host of ["evil.example:" + w.port, `${NAME}.local`, `${NAME}.local:${w.port + 1}`, `${ADDRESS}`, `${OTHER}:${w.port}`, "127.0.0.1:" + w.port, `${NAME}.local.evil.example:${w.port}`, "", `${NAME}.local:${w.port}, evil`]) {
		const p = await plain(w.port, { path: "/sb-ca/", host });
		assert.equal(p.status, 400, `plain ${host}`);
		assert.ok(!p.body.includes(NAME) && !p.body.includes(ADDRESS), "the refusal names nothing of the computer");
		const s = await secure(w.port, { path: "/token/state", host });
		assert.equal(s.status, 403, `tls ${host}`);
		assert.equal(s.body, "forbidden");
	}
	assert.equal(w.calls.length, 0);
	for (const host of [w.hostName, w.hostAddress, w.hostName.toUpperCase()]) {
		assert.equal((await plain(w.port, { path: "/sb-ca/", host })).status, 200, host);
		assert.equal((await secure(w.port, { path: "/x", host })).status, 200, host);
	}
});

test("a CA with no name allow-lists only the address, and the leaf names only that address", async () => {
	const w = await world({ ca: nameless });
	const bare = (host: string, path = "/sb-ca/check") => plain(w.port, { path, host });
	assert.equal((await bare(`${ADDRESS}:${w.port}`)).status, 200);
	assert.equal((await bare(`weis-mbp.local:${w.port}`)).status, 400);
	const reply = await secure(w.port, { ca: nameless, host: `${ADDRESS}:${w.port}`, path: "/x", tls: { servername: "", checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(ADDRESS, cert) } });
	assert.equal(reply.status, 200);
	assert.equal(reply.cert?.subjectaltname, `IP Address:${ADDRESS}`);
	assert.ok(!(await bare(`${ADDRESS}:${w.port}`, "/sb-ca/")).body.includes(".local"));
});

test("the leaf names the computer and its own address, and nothing else", async () => {
	const w = await world();
	const { cert } = await secure(w.port);
	assert.equal(cert?.subjectaltname, `DNS:${NAME}.local, IP Address:${ADDRESS}`);
	assert.ok(w.logs.some(([e, f]) => e === "lan-leaf" && f.address === ADDRESS && f.why === "start" && JSON.stringify(f.san) === JSON.stringify([`DNS:${NAME}.local`, `IP:${ADDRESS}`])), "the SAN list is in the line");
});

test("the certificate pages: the page is for the platform in the browser's language and shows no fingerprint; the files are exactly one certificate", async () => {
	const w = await world();
	const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
	const ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
	const page = (ua: string, extra: Record<string, string> = {}, path = "/sb-ca/") => plain(w.port, { path, headers: { "user-agent": ua, ...extra } });
	const ios = await page(IOS), android = await page(ANDROID), zh = await page(IOS, { "accept-language": "zh-TW,zh;q=0.9" });
	assert.equal(ios.status, 200);
	assert.match(ios.headers["content-type"]!, /^text\/html/);
	assert.ok(ios.body.includes(`/sb-ca/${CA_FILES.profile}`) && !ios.body.includes(`href="/sb-ca/${CA_FILES.crt}"`), "the iPhone is offered the profile");
	assert.ok(android.body.includes(`href="/sb-ca/${CA_FILES.crt}"`) && !android.body.includes(`/sb-ca/${CA_FILES.profile}`), "Android is offered the certificate");
	assert.ok(android.body.includes("not secure") && !ios.body.includes("not secure"));
	assert.ok(zh.body.includes("信任這台電腦的憑證") && ios.body.includes("Trust this computer's certificate"));
	assert.ok((await page(IOS.replace("Version/18.0 Mobile/15E148 Safari/604.1", "CriOS/130 Mobile/15E148 Safari/604.1"))).body.includes("Open this page in Safari"));
	assert.ok(!ios.body.includes("Open this page in Safari"));
	assert.ok((await page(ANDROID.replace("Chrome/130.0.0.0", "Firefox/130"))).body.includes("Use Chrome"));
	assert.ok((await plain(w.port, { path: "/sb-ca/?p=android", headers: { "user-agent": IOS } })).body.includes("straw-boss-lan-ca.crt"), "every platform's steps are one link away");
	for (const html of [ios.body, android.body, zh.body]) {
		assert.ok(!/[0-9A-F]{2}( [0-9A-F]{2}){7}/i.test(html) && !/\b[0-9a-f]{32,}\b/i.test(html), "no fingerprint or check value anywhere");
		assert.ok(!/<script/i.test(html));
		assert.ok(!html.includes("sha"), "nothing to compare");
	}
	assert.match(String(ios.headers["content-security-policy"]), new RegExp(`^default-src 'none'; style-src 'unsafe-inline'; img-src https://${NAME}\\.local:${w.port}; form-action 'none'`));
	assert.equal(ios.headers["cache-control"], "no-store");
	const profile = await page(IOS, {}, `/sb-ca/${CA_FILES.profile}`);
	for (const r of [ios, android, zh, profile, await page(IOS, {}, "/sb-ca/check")]) assert.equal(r.headers["set-cookie"], undefined, "the plain side sets no cookie");
	assert.equal(profile.headers["content-type"], "application/x-apple-aspen-config");
	assert.equal(profile.body, mobileconfig(ca));
	assert.equal((profile.body.match(/<key>PayloadType<\/key>\s*<string>com\.apple\.security\.root<\/string>/g) ?? []).length, 1);
	const file = await new Promise<Buffer>((done, fail) => {
		httpRequest({ host: "127.0.0.1", port: w.port, path: `/sb-ca/${CA_FILES.crt}`, agent: false, headers: { host: w.hostName } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c)).on("end", () => {
				assert.equal(res.headers["content-type"], "application/x-x509-ca-cert");
				assert.match(String(res.headers["content-disposition"]), /attachment; filename="straw-boss-lan-ca\.crt"/);
				done(Buffer.concat(chunks));
			});
		}).on("error", fail).end();
	});
	assert.deepEqual(file, crt(ca));
	assert.equal(new X509Certificate(file).fingerprint256, new X509Certificate(ca.cert).fingerprint256);
	const check = await page(IOS, {}, "/sb-ca/check");
	assert.ok(check.body.includes(`<img src="https://${NAME}.local:${w.port}/sb-ca/ok.svg" alt="Not trusted yet">`));
	assert.ok(!/<script/i.test(check.body));
	const byAddress = await plain(w.port, { path: "/sb-ca/check", host: w.hostAddress });
	assert.ok(byAddress.body.includes(`src="https://${ADDRESS}:${w.port}/sb-ca/ok.svg"`) && /img-src https:\/\/10\.0\.0\.5:/.test(String(byAddress.headers["content-security-policy"])), "the image host is the allow-listed value");
	assert.equal(w.calls.length, 0);
});

test("the HTTPS side answers the trusted image and page itself, with no cookie", async () => {
	const w = await world();
	const svg = await secure(w.port, { path: "/sb-ca/ok.svg" });
	assert.equal(svg.headers["content-type"], "image/svg+xml");
	assert.ok(svg.body.includes(">Trusted<"));
	assert.ok((await secure(w.port, { path: "/sb-ca/ok.svg", headers: { "accept-language": "zh-TW" } })).body.includes(">已信任<"));
	const page = await secure(w.port, { path: "/sb-ca/" });
	assert.ok(page.body.includes('href="/sb-app/"'));
	assert.equal(w.calls.length, 0, "the handler is not asked");
	assert.equal((await secure(w.port, { path: "/sb-ca/ok.svg", host: "evil:1" })).status, 403);
});

// The first-byte split ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("a TLS handshake completes when the ClientHello's first byte arrives alone, and so does a plain request", async () => {
	const w = await world();
	const reply = await splitHello(w.port);
	assert.match(reply, /^HTTP\/1\.1 200/);
	assert.ok(reply.includes("gui"));
	assert.equal(w.calls.at(-1)?.url, "/x");
	const socket = raw(w.port), out: Buffer[] = [];
	socket.on("data", (d: Buffer) => out.push(d));
	socket.write("G");
	await pause(40);
	socket.write(`ET /sb-ca/check HTTP/1.1\r\nHost: ${w.hostName}\r\nConnection: close\r\n\r\n`);
	await closed(socket);
	assert.match(Buffer.concat(out).toString("utf8"), /^HTTP\/1\.1 200/);
});

test("a reset or a silent close during the peek raises nothing and frees the slot", async () => {
	const w = await world({ limits: { unpairedPerPeer: 1 } });
	const reset = netConnect(w.port, "127.0.0.1");
	sockets.add(reset);
	reset.on("error", () => {});
	await new Promise((done) => reset.once("connect", done));
	reset.resetAndDestroy();
	const quiet = raw(w.port);
	await new Promise((done) => quiet.once("connect", done));
	quiet.end(); // a FIN before any byte: the peek reads nothing
	await closed(quiet);
	for (let i = 0; ; i++) {
		const socket = raw(w.port);
		socket.write(`GET /sb-ca/check HTTP/1.1\r\nHost: ${w.hostName}\r\nConnection: close\r\n\r\n`);
		const out: Buffer[] = [];
		socket.on("data", (d: Buffer) => out.push(d));
		await closed(socket);
		if (Buffer.concat(out).toString("utf8").startsWith("HTTP/1.1 200")) break;
		assert.ok(i < 50, "the slot of the reset connection was never freed");
		await pause(20);
	}
});

test("a connection that sends no byte is closed at 10 s, and a peer that stops mid-handshake at 10 s", async () => {
	const w = await world();
	const silent = raw(w.port);
	await new Promise((done) => silent.once("connect", done));
	const stalled = raw(w.port);
	stalled.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0xc8, 0x01])); // a ClientHello that never finishes
	await pause(60);
	w.clock.advance(9_999);
	assert.ok(!silent.destroyed && !stalled.destroyed);
	w.clock.advance(1);
	await Promise.all([closed(silent), closed(stalled)]);
	assert.equal((await secure(w.port)).status, 200, "the listener went on");
});

test("a handshake that completes in time is not cut by its timer", async () => {
	const w = await world();
	const agent = new HttpsAgent({ keepAlive: true });
	const first = await secure(w.port, { agent });
	w.clock.advance(30_000);
	const second = await secure(w.port, { agent, path: "/again" });
	assert.equal(second.status, 200);
	assert.equal(second.socket, first.socket, "the same connection");
	agent.destroy();
});

test("a TLS 1.1 client is refused; TLS 1.2 is served", async () => {
	const w = await world();
	const old = await rejected(secure(w.port, { tls: { minVersion: "TLSv1", maxVersion: "TLSv1.1", ciphers: "DEFAULT:@SECLEVEL=0" } }));
	assert.ok(old instanceof Error, "TLS 1.1 got an answer");
	assert.equal((await secure(w.port, { tls: { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" } })).status, 200);
	assert.equal(w.calls.length, 1);
});

test("the request and header timeouts cut a client that dribbles a request, on both sides", async () => {
	const w = await world({ timeouts: { headersMs: 300, requestMs: 600 } });
	const slowPlain = raw(w.port);
	slowPlain.write("GET /sb-ca/ HT");
	await closed(slowPlain);
	const slowTls = tlsConnect({ host: "127.0.0.1", port: w.port, servername: `${NAME}.local`, ca: ca.cert }, () => slowTls.write("GET / HT"));
	slowTls.on("error", () => {}).resume();
	await new Promise<void>((done) => slowTls.once("close", () => done()));
	assert.equal(w.calls.length, 0);
});

// Leaves -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("a leaf with under 30 days left is reissued once, on the fake clock, without dropping an open connection", async () => {
	const issued: string[] = [];
	const w = await world({ wakeMs: 1e12, issue: (c, a, n) => (issued.push(a), issueLeaf(c, a, n)) }); // a jump of months on the fake clock is no wake here
	const agent = new HttpsAgent({ keepAlive: true });
	const before = await secure(w.port, { agent });
	assert.equal(issued.length, 1);
	w.clock.advance(59 * DAY);
	await w.listener.tick();
	assert.equal(issued.length, 1, "60 days still left");
	w.clock.advance(31 * DAY - 3_600_000 * 2);
	await Promise.all([w.listener.tick(), w.listener.tick()]);
	await w.listener.tick();
	assert.equal(issued.length, 2, "two ticks at once and a third after make one leaf");
	assert.ok(w.logs.some(([e, f]) => e === "lan-leaf" && f.why === "renew" && f.address === ADDRESS));
	const same = await secure(w.port, { agent, path: "/still" });
	assert.equal(same.socket, before.socket, "the open connection was not dropped");
	assert.equal(same.status, 200);
	const fresh = await secure(w.port, { trust: false });
	assert.notEqual(fresh.cert?.serialNumber, before.cert?.serialNumber, "a new connection gets the new leaf");
	assert.ok(new Date(fresh.cert!.valid_to).getTime() > new Date(before.cert!.valid_to).getTime());
	agent.destroy();
});

test("in the CA's last 30 days a leaf is issued once and not again every tick, and at the CA's end the listeners close", async () => {
	const dying = createCa(NAME, Date.now() - 705 * DAY);
	const issued: number[] = [];
	const w = await world({ ca: dying, wakeMs: 1e12, issue: (c, a, n) => (issued.push(n), issueLeaf(c, a, n)) });
	assert.equal(issued.length, 1);
	for (let day = 1; day <= 20; day++) {
		w.clock.advance(DAY);
		await w.listener.tick();
	}
	assert.equal(issued.length, 1, "the new leaf would end with the CA, no later than the old one");
	assert.equal(w.listener.status().on, true);
	w.clock.advance(6 * DAY);
	await w.listener.tick();
	const status = w.listener.status();
	assert.equal(status.caEnded, true);
	assert.equal(status.on, false);
	assert.deepEqual(w.logs.filter(([e]) => e === "lan-off"), [["lan-off", { why: "ca-ended" }]]);
	await w.listener.tick();
	assert.equal(w.logs.filter(([e]) => e === "lan-off").length, 1, "said once");
	const refused = await rejected(secure(w.port));
	assert.match(String((refused as NodeJS.ErrnoException).code), /ECONNREFUSED/);
	assert.equal(issued.length, 1);
});

test("a start with an ended CA binds nothing", async () => {
	const ended = createCa(NAME, Date.now() - 800 * DAY);
	const w = await world({ ca: ended });
	assert.equal(w.listener.status().caEnded, true);
	assert.equal(w.listener.status().on, false);
	assert.equal(w.listens.length, 0);
	assert.equal(w.listener.portOf(ADDRESS), undefined);
});

test("a new CA ends every connection, reissues the leaves on the same port, and turns an ended listener back on", async () => {
	const w = await world();
	const agent = new HttpsAgent({ keepAlive: true });
	const old = await secure(w.port, { agent });
	const next = createCa(NAME, Date.now() + 1000);
	await w.listener.setCa(next);
	assert.ok(old.socket.destroyed || (await closed(old.socket), true), "the old connection ended");
	assert.equal(w.listener.portOf(ADDRESS), w.port);
	assert.equal((await secure(w.port, { ca: next })).status, 200);
	assert.ok(await rejected(secure(w.port)), "the old CA no longer verifies the listener");
	assert.equal(w.logs.filter(([e, f]) => e === "lan-leaf" && f.why === "start").length, 2);
	agent.destroy();
	// an ended CA: nothing bound until a live one arrives
	const ended = createCa(NAME, Date.now() - 800 * DAY);
	await w.listener.setCa(ended);
	assert.equal(w.listener.status().on, false);
	assert.ok(await rejected(secure(w.port, { ca: next })));
	await w.listener.setCa(next);
	assert.equal(w.listener.status().on, true);
	assert.equal(w.listener.status().caEnded, false);
	assert.equal((await secure(w.port, { ca: next })).status, 200);
});

// Addresses --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("a new address gets its leaf before its listener, and a gone address's listener closes and its connections end", async () => {
	const order: string[] = [];
	const w = await world({
		issue: (c, a, n) => (order.push(`issue ${a}`), issueLeaf(c, a, n)),
		listen: (server, port, host) => new Promise<void>((done, fail) => {
			order.push(`listen ${host}:${port === 0 ? "any" : "port"}`);
			server.once("error", fail);
			server.listen(port, host, () => (server.off("error", fail), done()));
		}),
	});
	assert.deepEqual(order, [`issue ${ADDRESS}`, "listen 127.0.0.1:any"]);
	const agent = new HttpsAgent({ keepAlive: true });
	const first = await secure(w.port, { agent });
	assert.equal(first.cert?.subjectaltname, `DNS:${NAME}.local, IP Address:${ADDRESS}`);
	// the address moves: the old listener closes (and its connection with it), the new one comes up on the same port with its own leaf
	w.state.interfaces = { en0: [v4(OTHER, 24)] };
	await w.listener.tick();
	assert.deepEqual(order.slice(2), [`issue ${OTHER}`, "listen 127.0.0.1:port"]);
	assert.equal(w.listener.portOf(ADDRESS), undefined);
	assert.equal(w.listener.portOf(OTHER), w.port);
	assert.ok(first.socket.destroyed || (await closed(first.socket), true));
	const second = await secure(w.port, { host: `${OTHER}:${w.port}` });
	assert.equal(second.cert?.subjectaltname, `DNS:${NAME}.local, IP Address:${OTHER}`);
	assert.deepEqual(w.listener.status().addresses.map((a) => [a.address, a.state]), [[OTHER, "open"]]);
	// no address left
	w.state.interfaces = {};
	await w.listener.tick();
	const status = w.listener.status();
	assert.deepEqual([status.addresses, status.noAddress, status.on], [[], true, false]);
	assert.match(String(((await rejected(secure(w.port))) as NodeJS.ErrnoException).code), /ECONNREFUSED/);
	assert.ok(w.logs.filter(([e]) => e === "lan-addresses").length >= 3, "each change is logged");
	agent.destroy();
});

test("a taken port: EADDRINUSE is waited out at a start, then the address is not served and says so; the next watch tries again", async () => {
	const w = await world({ start: false });
	w.state.interfaces = { en0: [v4(ADDRESS, 24), v4(OTHER, 24)] };
	await w.listener.start();
	const status = w.listener.status();
	// both map to 127.0.0.1 on one port: the second bind is a real EADDRINUSE
	assert.deepEqual(status.addresses.map((a) => [a.address, a.state, a.code]), [[ADDRESS, "open", undefined], [OTHER, "taken", "EADDRINUSE"]]);
	assert.ok(w.clock.elapsed() >= 5000, `waited ${w.clock.elapsed()} ms`);
	const binds = w.listens.length;
	await w.listener.tick();
	assert.equal(w.listens.length, binds + 1, "one more try at the next watch, without a wait");
	assert.ok(w.clock.elapsed() < 6000);
	assert.equal(w.logs.filter(([e, f]) => e === "lan-leaf" && f.why === "start" && f.address === OTHER).length, 1, "the leaf is kept, not issued again at every watch");
	// the port is free again: the address comes up at the next watch
	w.state.interfaces = { en0: [v4(OTHER, 24)] };
	await w.listener.tick();
	assert.deepEqual(w.listener.status().addresses.map((a) => [a.address, a.state]), [[OTHER, "open"]]);
});

test("EADDRNOTAVAIL is retried at the next watch without a note; any other bind error is logged", async () => {
	let code: string | undefined = "EADDRNOTAVAIL";
	const w = await world({
		start: false,
		listen: (server, port, host) => new Promise<void>((done, fail) => {
			if (code) return void fail(Object.assign(new Error(code), { code }));
			server.once("error", fail);
			server.listen(port, host, () => (server.off("error", fail), done()));
		}),
	});
	await w.listener.start();
	assert.deepEqual(w.listener.status().addresses.map((a) => a.state), ["retry"]);
	assert.equal(w.clock.elapsed(), 0, "not waited for");
	assert.deepEqual(w.logs.filter(([e, f]) => e === "lan-leaf" && f.why === "bind"), []);
	code = "EACCES";
	await w.listener.tick();
	assert.deepEqual(w.listener.status().addresses.map((a) => [a.state, a.code]), [["error", "EACCES"]]);
	assert.deepEqual(w.logs.filter(([e, f]) => e === "lan-leaf" && f.why === "bind"), [["lan-leaf", { address: ADDRESS, why: "bind", code: "EACCES" }]]);
	code = undefined;
	await w.listener.tick();
	assert.deepEqual(w.listener.status().addresses.map((a) => a.state), ["open"]);
	assert.equal((await secure(w.listener.portOf(ADDRESS)!)).status, 200);
});

test("a listener that closes without being asked is bound again at once; a wake (a clock jump over 30 s) binds them all again", async () => {
	const w = await world();
	const events = () => new Promise<void>((done) => {
		const seen = w.statuses.length;
		const poll = setInterval(() => w.statuses.length > seen && w.listener.status().addresses[0]?.state === "open" ? (clearInterval(poll), done()) : undefined, 10);
	});
	const before = w.listens.length;
	const back = events();
	w.listens[0]!.server.close(); // nobody asked
	await back;
	assert.equal(w.listens.length, before + 1, "rebound by itself, before any watch");
	assert.equal((await secure(w.port)).status, 200);
	const agent = new HttpsAgent({ keepAlive: true });
	const live = await secure(w.port, { agent });
	w.clock.advance(40_000);
	await w.listener.tick();
	assert.equal(w.listens.length, before + 2, "a wake rebinds every listener");
	assert.ok(live.socket.destroyed || (await closed(live.socket), true));
	assert.equal((await secure(w.port)).status, 200);
	w.clock.advance(20_000);
	await w.listener.tick();
	assert.equal(w.listens.length, before + 2, "a jump under 30 s is no wake");
	agent.destroy();
});

// Pools and the log ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("at most 8 unpaired connections per peer and 64 in all (here 2 and 3); past them a new one is closed, and a closed one frees its slot", async () => {
	const peers: string[] = [];
	const w = await world({ limits: { unpairedPerPeer: 2, unpairedAll: 3 }, remoteOf: () => peers.shift() ?? "10.0.0.7" });
	const hold = async (peer: string) => {
		peers.push(peer);
		const socket = raw(w.port);
		await new Promise((done) => socket.once("connect", done));
		socket.write(Buffer.from([0x16, 0x03, 0x01])); // counted from accept, whether or not it ever finishes
		await pause(40);
		return socket;
	};
	const a1 = await hold("10.0.0.7"), a2 = await hold("10.0.0.7");
	const a3 = await hold("10.0.0.7");
	await closed(a3);
	assert.ok(!a1.destroyed && !a2.destroyed);
	const b1 = await hold("10.0.0.8");
	const b2 = await hold("10.0.0.9");
	await closed(b2);
	assert.ok(!b1.destroyed);
	a1.destroy();
	await closed(a1);
	await pause(40);
	const c1 = await hold("10.0.0.9");
	assert.ok(!c1.destroyed, "the freed slot is usable");
	assert.deepEqual(w.logs.filter(([e]) => e === "lan-limited"), []);
	w.clock.advance(60_000);
	assert.deepEqual(w.logs.filter(([e]) => e === "lan-limited"), [["lan-limited", { closed: 2, peers: 2 }]]);
	assert.equal(w.logs.filter(([e]) => e === "lan-limited").length, 1, "one line a minute");
	w.clock.advance(120_000);
	assert.equal(w.logs.filter(([e]) => e === "lan-limited").length, 1, "nothing to say, nothing said");
});

test("a flood of unpaired connections does not cut or crowd out a connection that carries an allowed device's cookie", async () => {
	const w = await world({ limits: { unpairedPerPeer: 8, unpairedAll: 2 } });
	const agent = new HttpsAgent({ keepAlive: true });
	const paired = await secure(w.port, { agent, headers: { "x-paired": "1" } });
	assert.equal(paired.status, 200);
	const flood = [raw(w.port), raw(w.port)];
	for (const s of flood) s.write(Buffer.from([0x16]));
	await pause(60);
	const refused = raw(w.port);
	await closed(refused);
	assert.ok(flood.every((s) => !s.destroyed), "two unpaired fill the pool, the paired one is not among them");
	const again = await secure(w.port, { agent, headers: { "x-paired": "1" }, path: "/more" });
	assert.equal(again.socket, paired.socket);
	assert.equal(again.status, 200);
	agent.destroy();
});

test("a connection becomes paired only on a request the handler's test accepts, and the paired pool has limits of its own", async () => {
	const w = await world({ limits: { unpairedAll: 1, pairedPerPeer: 1, pairedAll: 5 } });
	const a1 = new HttpsAgent({ keepAlive: true }), a2 = new HttpsAgent({ keepAlive: true });
	const first = await secure(w.port, { agent: a1, headers: { "x-paired": "1" } });
	assert.equal(w.calls.at(-1)?.paired, true);
	// the first connection is paired now, so another one fits the unpaired pool of one
	const plainKeep = await secure(w.port, { agent: a2 });
	assert.equal(plainKeep.status, 200);
	assert.notEqual(plainKeep.socket, first.socket);
	// a second paired connection from the same peer is over the paired per-peer limit: it stays in the unpaired pool, which is full
	const third = raw(w.port);
	await closed(third);
	a1.destroy();
	a2.destroy();
});

// Stop -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("stop closes every listener and connection and says what is left in the log", async () => {
	const w = await world();
	w.state.peer = "8.8.8.8";
	const gone = raw(w.port);
	await closed(gone);
	const agent = new HttpsAgent({ keepAlive: true });
	w.state.peer = "10.0.0.7";
	const live = await secure(w.port, { agent });
	await w.listener.stop();
	assert.ok(live.socket.destroyed || (await closed(live.socket), true));
	assert.match(String(((await rejected(secure(w.port))) as NodeJS.ErrnoException).code), /ECONNREFUSED/);
	assert.deepEqual(w.logs.filter(([e]) => e === "lan-refused"), [["lan-refused", { n: 1 }]], "a count not yet said is said at the end");
	agent.destroy();
});

test("start schedules the watch every 5 s, and stop cancels it", async () => {
	const ticks: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	const w = await world({ every: (fn, ms) => (ticks.push({ fn, ms, cancelled: false }), () => void (ticks[0]!.cancelled = true)) });
	assert.deepEqual(ticks.map((t) => t.ms), [5000]);
	w.state.interfaces = { en0: [v4(OTHER, 24)] };
	ticks[0]!.fn();
	for (let i = 0; i < 100 && w.listener.portOf(OTHER) === undefined; i++) await pause(10);
	assert.equal(w.listener.portOf(OTHER), w.port, "the timer's tick moved the listener to the new address");
	await w.listener.stop();
	assert.equal(ticks[0]!.cancelled, true);
});

test("the status carries what the overlay and `status` need: state per address, the port, and the VPN fact", async () => {
	const w = await world({ probe: async () => "172.16.0.2" });
	w.state.interfaces = { en0: [v4(ADDRESS, 24)], utun4: [v4("172.16.0.2", 32, { mac: "00:00:00:00:00:00" })] };
	await w.listener.tick();
	const status = w.listener.status();
	assert.deepEqual([status.on, status.port, status.vpn, status.caEnded, status.noAddress], [true, w.port, true, false, false]);
	assert.deepEqual(status.addresses, [{ address: ADDRESS, iface: "en0", prefix: 24, state: "open" }]);
	assert.ok(w.statuses.length >= 1);
	void HttpAgent;
});
