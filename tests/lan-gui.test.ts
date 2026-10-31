import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after as afterAll, afterEach, mock, test } from "node:test";
import { startGui, type Gui } from "../src/gui.ts";
import type { Doc } from "../src/documents.ts";
import { LAN_COOKIE, type LanAt } from "../src/lan/access.ts";
import { fakeClock } from "./fake-clock.ts";

// The GUI's handler of kind "lan" (docs/specs/2026-10-30-sb-gui-lan.md, Steps L5): what gui.ts does with a request a LAN listener hands it. The LAN listener itself is tested on its own (lan-listener.test.ts); here a plain loopback server stands in for it
// and gives each request the `At` the listener would build, so the handler's wiring (entry, verdicts, cookies, documents, routes, the streams of each network) is what is asserted, through real HTTP.

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "psb-lan-gui-")));
const bundle = join(scratch, "bundle"), docsDir = join(scratch, "docs");
mkdirSync(bundle, { recursive: true });
mkdirSync(docsDir, { recursive: true });
writeFileSync(join(bundle, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
writeFileSync(join(bundle, "manifest.webmanifest"), JSON.stringify({ name: "Straw Net", start_url: "/", scope: "/" }));
writeFileSync(join(docsDir, "plan.html"), `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><img src="pic.png"></body></html>`);
writeFileSync(join(docsDir, "style.css"), "body{color:red}");
writeFileSync(join(docsDir, "notes.md"), "# notes");
const CAP = "1".repeat(32), TEXT = "2".repeat(32);
const docs: Record<string, Doc> = { [TEXT]: { id: "text-1", path: join(docsDir, "notes.md"), kind: "text", display: "docs/notes.md", reason: "Notes", revision: 1, onScreen: true }, [CAP]: { id: "html-1", path: join(docsDir, "plan.html"), kind: "html", display: "docs/plan.html", reason: "Plan", revision: 1, onScreen: true } };
const hub = { doc: (cap: string) => (docs[cap] ? { doc: docs[cap]!, key: "S" } : undefined), form: async () => ({ accepted: true }), start() {}, stop() {}, has: () => false } as never;

const NAME = "weis-mbp", PORT = 8445;
const AT: LanAt = { address: "192.168.1.5", iface: "en0", port: PORT, name: NAME, host: `${NAME}.local`, origin: `https://${NAME}.local:${PORT}`, peer: "192.168.1.23" };
const HEADERS = { host: `${NAME}.local:${PORT}`, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const running: Gui[] = [], servers: Server[] = [];
afterEach(() => mock.restoreAll());
afterAll(async () => {
	await Promise.all(running.map((g) => g.stop()));
	await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
	rmSync(scratch, { recursive: true, force: true });
});

type Res = { status: number; headers: IncomingMessage["headers"]; body: string };
/** A GUI with Wi-Fi access wired, a stand-in LAN listener in front of its `lan` handler, and a device the boss allowed. */
async function world() {
	const log: [string, Record<string, unknown>][] = [], seen: unknown[] = [];
	const gui = await startGui({
		read: async () => ({ bases: [] }), hub, dir: bundle, paired: join(scratch, `paired-${Math.random().toString(36).slice(2)}.json`), pollMs: 50, idleMs: 600_000,
		lan: { panel: { on: async () => ({ status: 200, body: {} }), off: async () => ({ status: 200, body: {} }), pair: () => ({ status: 200, body: { code: "x" } }), approve: () => ({ status: 200, body: {} }), ca: () => ({ status: 200, body: {} }), pending: () => ({ status: 200, body: { pending: [] } }), file: (name) => (name === "straw-boss-lan-ca.crt" ? { type: "application/x-x509-ca-cert", bytes: Buffer.from("PUBLIC") } : undefined) }, overlay: { marked: () => false, wrote: () => {} }, notify: (e) => void seen.push(e), log: (event, fields) => void log.push([event, fields]) },
	});
	running.push(gui);
	gui.access.lan.enable();
	const server = createServer((req, res) => gui.lan(req, res, { ...AT, peer: String(req.headers["x-peer"] ?? AT.peer) }));
	servers.push(server);
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const port = (server.address() as AddressInfo).port;
	const send = (path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Res>((resolve, reject) => {
		request({ host: "127.0.0.1", port, path, method, agent: false, headers: { ...HEADERS, ...headers } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
		}).on("error", reject).end(body);
	});
	/** An allowed device: redeemed on the entry's form, the number typed on the computer. */
	const pair = async (peer = "192.168.1.23") => {
		const code = gui.access.pair("lan", `s-${peer}`)!;
		const res = await send("/sb-app/pair", { method: "POST", headers: { origin: AT.origin, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "x-peer": peer }, body: `code=${code}` });
		const cookie = new RegExp(`${LAN_COOKIE}=([0-9a-f]{64})`).exec(String(res.headers["set-cookie"]))![1]!, number = /class="number">(\d{4})</.exec(res.body)![1]!;
		assert.ok(gui.access.lan.approve(number));
		return { cookie, jar: { cookie: `${LAN_COOKIE}=${cookie}`, "x-peer": peer } };
	};
	return { gui, send, pair, log, seen, token: gui.token };
}

test("the installed app's entry answers on a LAN listener; a Wi-Fi 401 and a dead address name /boss gui lan, never the tailnet's command", async () => {
	const w = await world();
	assert.equal((await w.send("/sb-app/")).status, 200, "the entry is served to the LAN");
	assert.match((await w.send("/sb-app/")).body, /run \/boss gui lan/);
	const nobody = await w.send(`/${w.token}/`, { headers: { "sec-fetch-dest": "empty" } });
	assert.equal(nobody.status, 401);
	assert.match(nobody.body, /\/boss gui lan/);
	assert.ok(!/gui remote/.test(nobody.body), "no Tailscale command for a phone on Wi-Fi");
	const dead = await w.send(`/${"0".repeat(32)}/`, { headers: { "sec-fetch-dest": "document" } });
	assert.equal(dead.status, 302, "a document load at a dead address of an allow-listed host goes on to the entry");
	assert.equal(dead.headers.location, "/sb-app/");
	const evil = await w.send(`/${w.token}/`, { headers: { host: "evil.example:8445", "sec-fetch-dest": "document" } });
	assert.equal(evil.status, 403);
	assert.match(evil.body, /does not work here/);
	const bounce = await w.send(`/${w.token}/`, { headers: { "sec-fetch-dest": "document", "sec-fetch-site": "cross-site" } });
	assert.equal(bounce.status, 401);
	assert.match(bounce.body, /scan a new QR code from \/boss gui lan/);
	for (let i = 0; i < 20; i++) await w.send(`/${w.token}/`, { headers: { host: "evil.example:8445", "x-peer": "192.168.1.99" } });
	assert.equal((await w.send(`/${w.token}/`, { headers: { "x-peer": "192.168.1.99" } })).status, 429, "a noisy peer is told 429, in plain text");
});

test("a waiting phone's own favicon and touch-icon fetches are not refusals: 60 s of polling stays 200, while the same paths on a host off the allow-list still count", async () => {
	const clock = fakeClock(Date.now());
	mock.method(Date, "now", clock.now);
	const w = await world();
	const res = await w.send("/sb-app/pair", { method: "POST", headers: { origin: AT.origin, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: `code=${w.gui.access.pair("lan", "wait")}` });
	const jar = { cookie: `${LAN_COOKIE}=${new RegExp(`${LAN_COOKIE}=([0-9a-f]{64})`).exec(String(res.headers["set-cookie"]))![1]}` };
	for (let t = 0; t < 30; t++) {
		clock.advance(2000);
		for (const icon of ["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/apple-touch-icon-120x120.png"]) {
			const r = await w.send(icon, { headers: jar });
			assert.equal(r.status, 404, icon);
			assert.equal(r.headers["content-type"], "text/plain");
		}
		assert.equal((await w.send("/favicon.ico", { method: "HEAD", headers: jar })).status, 404);
		assert.equal((await w.send("/sb-app/pair/wait", { headers: jar })).status, 200, `poll ${t}`);
	}
	assert.match((await w.send("/sb-app/", { headers: jar })).headers.location ?? "", /pair\/wait/);
	// Off the allow-list the icon is just another refused path, and it counts.
	for (let i = 0; i < 20; i++) assert.equal((await w.send("/favicon.ico", { headers: { host: "evil.example:8445" } })).status, 403);
	assert.equal((await w.send("/favicon.ico", { headers: { host: "evil.example:8445" } })).status, 429);
});

test("a request without the LAN cookie is never let in on the strength of a Tailscale cookie, and an allowed device's page, manifest, and stream are served with the entry as the app's start URL", async () => {
	const w = await world(), ph = await w.pair();
	assert.equal((await w.send(`/${w.token}/`, { headers: { cookie: `sb_remote=${"a".repeat(64)}`, "x-peer": "192.168.1.60" } })).status, 401);
	const page = await w.send(`/${w.token}/`, { headers: ph.jar });
	assert.equal(page.status, 200);
	assert.match(page.body, new RegExp(`<base href="/${w.token}/">`));
	const manifest = await w.send(`/${w.token}/manifest.webmanifest`, { headers: ph.jar });
	assert.deepEqual([JSON.parse(manifest.body).start_url, JSON.parse(manifest.body).scope], ["/sb-app/", "/"]);
	assert.equal((await w.send(`/${w.token}/api/lan/pending`, { headers: ph.jar })).status, 403, "lan/* is this computer's page only");
	const no = JSON.parse((await w.send(`/${w.token}/api/lan/pending`, { headers: ph.jar })).body);
	assert.equal(no.error, "local_only");
});

test("a use that renews the pairing sets the LAN cookie for both paths, never sb_remote", async () => {
	const clock = fakeClock(Date.now());
	mock.method(Date, "now", clock.now);
	const w = await world(), ph = await w.pair();
	clock.advance(2 * 3_600_000);
	const renewed = await w.send(`/${w.token}/`, { headers: ph.jar });
	assert.equal(renewed.status, 200);
	const cookies = renewed.headers["set-cookie"] as string[];
	assert.deepEqual(cookies?.map((c) => /Path=([^;]+)/.exec(c)![1]), [`/${w.token}/`, "/sb-app/"]);
	assert.ok(cookies.every((c) => c.startsWith(`${LAN_COOKIE}=${ph.cookie};`) && c.includes("HttpOnly; Secure; SameSite=Strict")));
	assert.ok(!cookies.some((c) => c.startsWith("sb_remote")));
});

test("documents on a LAN listener: the load needs the cookie and hands a ticket in its <base>, the subresource goes through the ticket, the ticketless form is 401, and api/doc needs the cookie", async () => {
	const w = await world(), ph = await w.pair();
	assert.equal((await w.send(`/${w.token}/doc/${CAP}/`, { headers: { "sec-fetch-dest": "iframe" } })).status, 401, "no cookie, no document");
	const load = await w.send(`/${w.token}/doc/${CAP}/`, { headers: { ...ph.jar, "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" } });
	assert.equal(load.status, 200);
	const base = /<base href="(\/[0-9a-f]{32}\/doc\/[0-9a-f]{32}\/r\/([0-9a-f]{32})\/)" target="_blank">/.exec(load.body);
	assert.ok(base, load.body);
	assert.equal((await w.send(`${base![1]}style.css`, { headers: { "sec-fetch-dest": "style" } })).status, 200, "the ticket stands in for the cookie, which a sandboxed frame does not send");
	assert.equal((await w.send(`/${w.token}/doc/${CAP}/style.css`, { headers: { "sec-fetch-dest": "style" } })).status, 401, "and without it a sibling file is not served");
	assert.equal((await w.send(`/${w.token}/api/doc/${TEXT}`)).status, 401);
	const api = await w.send(`/${w.token}/api/doc/${TEXT}`, { headers: ph.jar });
	assert.deepEqual([api.status, JSON.parse(api.body).text], [200, "# notes"], "the document's text for the page, with the cookie");
});

test("a document's tickets end with the device whose load handed them out (Unpair), and with every device when Wi-Fi access goes off; another device's stay", async () => {
	const w = await world(), a = await w.pair("192.168.1.23"), b = await w.pair("192.168.1.24");
	const ticketOf = async (jar: Record<string, string>) => {
		const load = await w.send(`/${w.token}/doc/${CAP}/`, { headers: { ...jar, "sec-fetch-dest": "iframe", "sec-fetch-site": "same-origin" } });
		return /<base href="(\/[0-9a-f]{32}\/doc\/[0-9a-f]{32}\/r\/[0-9a-f]{32}\/)"/.exec(load.body)![1]!;
	};
	const [ta, tb] = [await ticketOf(a.jar), await ticketOf(b.jar)];
	const style = (base: string) => w.send(`${base}style.css`, { headers: { "sec-fetch-dest": "style" } }).then((r) => r.status);
	assert.deepEqual([await style(ta), await style(tb)], [200, 200]);
	assert.equal(w.gui.access.devices.unpair(sha(a.cookie).slice(0, 16)), true);
	assert.deepEqual([await style(ta), await style(tb)], [401, 200], "Unpair ends that device's tickets only");
	w.gui.access.lan.disable();
	w.gui.access.lan.enable(); // (while it is off every request is refused anyway: on again, the ticket must be gone)
	assert.equal(await style(tb), 401, "Wi-Fi access off ends the rest");
});

test("a paired device's LAN streams end with their network or device alone: Wi-Fi off ends Wi-Fi streams and leaves the tailnet's; unpairing one device ends that device's", async () => {
	const w = await world(), a = await w.pair("192.168.1.23"), b = await w.pair("192.168.1.24");
	const HOST = "box.tail1.ts.net:8443", LOGIN = "me@example.com", tailnet = { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97" };
	w.gui.access.enable({ host: HOST, login: LOGIN });
	const ask = (path: string, headers: Record<string, string>) => new Promise<IncomingMessage>((resolve, reject) => void get({ host: "127.0.0.1", port: w.gui.remotePort, path, headers, agent: false }, resolve).on("error", reject));
	const paired = await ask(`/${w.token}/pair/${w.gui.access.pair()}`, tailnet);
	paired.resume();
	const remote = { ...tailnet, cookie: String(paired.headers["set-cookie"]).split(";")[0]! };
	const open = async (path: string, headers: Record<string, string>, through: "lan" | "tailnet") => {
		const closed = { done: false };
		const res = through === "lan"
			? await new Promise<IncomingMessage>((resolve, reject) => void get({ host: "127.0.0.1", port: (servers[servers.length - 1]!.address() as AddressInfo).port, path, headers: { ...HEADERS, ...headers }, agent: false }, resolve).on("error", reject))
			: await ask(path, headers);
		assert.equal(res.statusCode, 200);
		res.on("close", () => (closed.done = true)).on("error", () => {}).resume();
		return closed;
	};
	const [lanA, lanB, tail] = [await open(`/${w.token}/events`, a.jar, "lan"), await open(`/${w.token}/events`, b.jar, "lan"), await open(`/${w.token}/events`, remote, "tailnet")];
	const settle = () => new Promise((done) => setTimeout(done, 60));
	// One device: the LAN device a is unpaired, and only its stream ends.
	const id = w.gui.access.devices.list().find((d) => d.net === "lan" && d.id === sha(a.cookie).slice(0, 16))!.id;
	assert.equal(w.gui.access.devices.unpair(id), true);
	await settle();
	assert.deepEqual([lanA.done, lanB.done, tail.done], [true, false, false], "one device's streams");
	// Wi-Fi off: every LAN stream, not the tailnet's.
	w.gui.access.lan.disable();
	await settle();
	assert.deepEqual([lanB.done, tail.done], [true, false], "Wi-Fi access off leaves Tailscale streams alone");
	// Remote off ends the tailnet's.
	w.gui.access.disable();
	await settle();
	assert.equal(tail.done, true);
});

test("lan/* GETs: the pending list and the public files are this computer's page's; the LAN listener's handler never serves them", async () => {
	const w = await world();
	const local = (path: string) => new Promise<Res>((resolve, reject) => void get({ host: "127.0.0.1", port: w.gui.port, path: `/${w.token}/api/${path}`, headers: { host: `127.0.0.1:${w.gui.port}` }, agent: false }, (res) => {
		let text = "";
		res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
	}).on("error", reject));
	const files = await local("lan/ca/straw-boss-lan-ca.crt");
	assert.deepEqual([files.status, files.body, files.headers["content-disposition"]], [200, "PUBLIC", 'attachment; filename="straw-boss-lan-ca.crt"']);
	assert.equal((await local("lan/ca/not-a-file")).status, 404);
	assert.equal((await local("lan/pending")).status, 200);
	const ph = await w.pair();
	assert.equal((await w.send(`/${w.token}/api/lan/ca/straw-boss-lan-ca.crt`, { headers: ph.jar })).status, 403);
});
