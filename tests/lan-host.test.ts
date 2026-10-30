import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createHash } from "node:crypto";
import type { LanSeams } from "../src/server/lanhost.ts";
import type { InterfaceInfo } from "../src/lan/net.ts";
import { readCa } from "../src/lan/ca.ts";
import { fileOf } from "../src/server/record.ts";
import { until, World } from "./fakes.ts";
import { bundle, fakeTailscale, Hosted, startHosted } from "./gui-world.ts";

// Wi-Fi access inside the sb server (docs/specs/2026-10-30-sb-gui-lan.md, Steps L5): the LAN listeners wired to the GUI's handler of kind "lan", the control requests, the face-gated answers, the lifecycle, and what `status` and `up` say.
// The server runs in this process against the fake Herdr; its listeners bind 127.0.0.1 only, on injected interfaces that make 10.0.0.5 eligible, with the peer made up (10.0.0.23). No real LAN address, firewall, or port 8445 is touched.

const NAME = "weis-mbp", ADDRESS = "10.0.0.5", PEER = "10.0.0.23", PANE = "wA:p9";
const v4 = (address: string, prefix: number): InterfaceInfo => ({ address, netmask: "", family: "IPv4", mac: "02:00:00:00:00:00", internal: false, cidr: `${address}/${prefix}` });
const seams = (over: Partial<LanSeams> = {}): LanSeams => ({
	interfaces: () => ({ en0: [v4(ADDRESS, 24)] }), bindAddress: () => "127.0.0.1", remoteOf: () => PEER, probe: async () => ADDRESS, localName: () => ({ name: NAME }), exclude: () => {}, bindWaitMs: 0, intervalMs: 600_000, ...over,
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const free = () => new Promise<number>((done) => { const s = createNetServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); }); });

let world = new World();
const hosted: Hosted[] = [];
afterEach(async () => {
	await Promise.all(hosted.splice(0).map((h) => h.stop()));
	await world.stopAll();
	world = new World();
});
/** A server whose Wi-Fi access listens on a free port (lan.json names it, as a remembered port does): never 8445. */
async function host(over: { seams?: Partial<LanSeams>; port?: number | null; wanted?: boolean; pid?: number; bundle?: string; tailscale?: ReturnType<typeof fakeTailscale>["run"] } = {}) {
	const port = over.port === undefined ? await free() : over.port;
	if (port !== null && !existsSync(join(world.stateDir, "lan.json"))) {
		const secrets = existsSync(join(world.stateDir, "gui-secrets.json")) ? JSON.parse(readFileSync(join(world.stateDir, "gui-secrets.json"), "utf8")) : undefined;
		writeFileSync(join(world.stateDir, "lan.json"), JSON.stringify({ v: 1, wanted: over.wanted ?? false, port, token: secrets ? sha(secrets.token) : "", devices: {} }), { mode: 0o600 });
	}
	const h = await startHosted(world, { gui: { lan: seams(over.seams), ...(over.bundle ? { bundle: over.bundle } : {}) } as never, ...(over.tailscale ? { tailscale: over.tailscale } : {}), ...(over.pid ? { pid: over.pid } : {}) });
	hosted.push(h);
	return h;
}
const lanOf = async (h: Hosted) => ((await h.ask("status")).gui as { lan: Record<string, any> }).lan;
const face = async (h: Hosted, pane: string | null = PANE) => String((await h.ask("gui-lan-face", { pane, open: true })).face);
/** The risk accepted from a live face and Wi-Fi access on. */
async function turnOn(h: Hosted, f?: string) {
	const id = f ?? (await face(h));
	const r = await h.ask("gui-lan", { on: true, accept_risk: true, face: id });
	assert.equal(r.ok, true, JSON.stringify(r));
	return { face: id, reply: r };
}
const portOf = (h: Hosted) => JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).port as number;

/** One HTTPS request to the LAN listener as the phone makes it: the CA trusted, the name's SNI, the allow-listed Host. */
function phone(h: Hosted, over: { host?: string } = {}) {
	const ca = JSON.parse(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8")).cert as string, port = portOf(h), hostHeader = over.host ?? `${NAME}.local:${port}`;
	return (path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
		const req = httpsRequest({ host: "127.0.0.1", port, path, method, ca, servername: `${NAME}.local`, agent: false, headers: { host: hostHeader, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1", ...headers } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
		});
		req.on("error", reject).end(body);
	});
}
const NAV = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
/** The phone pairs: redeems a QR code and shows the number; returns its cookie and number. */
async function redeem(h: Hosted, f: string, form: "name" | "address" = "name") {
	const p = phone(h), made = await h.ask("gui-lan-pair", { face: f, form });
	assert.equal(made.ok, true, JSON.stringify(made));
	const code = String(made.url).split("/").pop()!, port = portOf(h), host = form === "name" ? `${NAME}.local` : ADDRESS;
	const res = await p("/sb-app/pair", { method: "POST", headers: { origin: `https://${host}:${port}`, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", host: `${host}:${port}` }, body: `code=${encodeURIComponent(code)}` });
	const cookie = /__Secure-sb_lan=([0-9a-f]{64})/.exec(String(res.headers["set-cookie"]))?.[1], number = /class="number">(\d{4})</.exec(res.body)?.[1];
	return { res, cookie, number, made, p };
}
/** A paired phone: redeemed, and allowed by the number typed in a live face. */
async function pairedPhone(h: Hosted, f: string) {
	const r = await redeem(h, f);
	assert.ok(r.cookie && r.number, r.res.body);
	const ok = await h.ask("gui-lan-approve", { face: f, number: r.number });
	assert.equal(ok.ok, true, JSON.stringify(ok));
	return { ...r, jar: { cookie: `__Secure-sb_lan=${r.cookie}` } };
}

test("nothing binds by default: a server with no lan.json lists no Wi-Fi access and binds no LAN address, and a GUI start does not change that", async () => {
	let binds = 0;
	const h = await host({ port: null, seams: { listen: async () => void binds++ } });
	assert.equal(binds, 0);
	const lan = await lanOf(h);
	assert.deepEqual([lan.wanted, lan.on, lan.addresses, lan.pending], [false, false, [], 0]);
	assert.equal(existsSync(join(h.slot.dir, "lan-ca.json")), false);
	assert.equal(existsSync(join(h.slot.dir, "lan.json")), false);
});

test("gui-lan on with no certificate answers lan_risk and makes nothing; with the risk accepted from no live face, a lapsed face, or no face id it is refused and still makes nothing", async () => {
	const h = await host();
	const first = await h.ask("gui-lan", { on: true });
	assert.deepEqual([first.ok, first.error, first.name], [false, "lan_risk", NAME], "the warning comes first");
	for (const more of [{}, { face: "0".repeat(32) }, { face: "wA:p9" }, { face: undefined }]) {
		const r = await h.ask("gui-lan", { on: true, accept_risk: true, ...more });
		assert.deepEqual([r.ok, r.error], [false, "unknown_face"], JSON.stringify(more));
	}
	assert.equal(existsSync(join(h.slot.dir, "lan-ca.json")), false, "no certificate was made");
	assert.equal((await lanOf(h)).on, false);
});

test("accepting the risk from a live face makes the certificate (mode 600), binds the address on the remembered port, and logs it without a key; the plain line names the entry and the served address", async () => {
	const h = await host(), port = portOf(h), f = await face(h);
	const { reply } = await turnOn(h, f);
	assert.match(String(reply.text), new RegExp(`^Wi-Fi access is on: https://${NAME}\\.local:${port}/sb-app/`));
	const file = join(h.slot.dir, "lan-ca.json");
	assert.ok(existsSync(file));
	if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
	const lan = await lanOf(h);
	assert.deepEqual([lan.wanted, lan.on, lan.port, lan.url, lan.addresses], [true, true, port, `https://${NAME}.local:${port}/sb-app/`, [{ address: ADDRESS, interface: "en0" }]]);
	assert.equal(JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).wanted, true);
	const log = readFileSync(fileOf(h.slot, "log"), "utf8");
	assert.match(log, /lan-ca-created fp8=[0-9a-f]{8}/);
	assert.match(log, /lan-on port=\d+/);
	assert.ok(!log.includes("PRIVATE KEY") && !log.includes(h.gui().token), "no key or token in the log");
	// The phone reaches the page's entry over TLS under that certificate.
	const entry = await phone(h)("/sb-app/");
	assert.equal(entry.status, 200);
	assert.match(entry.body, /run \/boss gui lan/);
});

test("the certificate is made only when the name can be read: an unreadable name makes none and says so; an invalid name makes a name-less one", async () => {
	const down = await host({ seams: { localName: () => ({ unreadable: "scutil exited 1" }) } });
	const r = await down.ask("gui-lan", { on: true, accept_risk: true, face: await face(down) });
	assert.deepEqual([r.ok, r.error], [false, "lan_name_unreadable"]);
	assert.equal(existsSync(join(down.slot.dir, "lan-ca.json")), false);
	await down.stop();
	rmSync(join(world.stateDir, "lan.json"), { force: true });
	const odd = await host({ seams: { localName: () => ({ invalid: "Wei's MacBook" }) }, pid: 7101 });
	await turnOn(odd);
	const ca = readCa(odd.slot.dir);
	assert.ok("ca" in ca && ca.ca.name === null, "name-less");
	assert.equal((await lanOf(odd)).url, `https://${ADDRESS}:${portOf(odd)}/sb-app/`, "and the entry is the address's: there is no name to point a phone at");
	const made = await odd.ask("gui-lan-pair", { face: await face(odd), form: "name" });
	assert.deepEqual([made.form, made.host], ["address", ADDRESS], "a QR asked for by name falls back to the address form");
});

test("pairing end to end: a face mints the QR, the phone redeems it and shows a number, only that number typed in a live face allows it, and then the phone gets the token and the page", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-lan-bundle-"));
	writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
	writeFileSync(join(dir, "manifest.webmanifest"), JSON.stringify({ name: "Straw Net", start_url: "/", scope: "/" }));
	const h = await host({ bundle: dir }), f = (await turnOn(h)).face;
	const { res, cookie, number, made } = await redeem(h, f);
	assert.equal(res.status, 200);
	assert.ok(cookie && number);
	assert.match(String(made.url), new RegExp(`^https://${NAME}\\.local:${portOf(h)}/sb-app/pair/[A-Za-z0-9_-]{20,}$`), "the QR carries a code and no token");
	assert.ok(!String(made.url).includes(h.gui().token));
	assert.ok(Array.isArray(made.rows) && (made.rows as string[]).length > 10, "and the rows to draw it");
	const jar = { cookie: `__Secure-sb_lan=${cookie}` }, p = phone(h);
	// Nothing about it reaches the phone but the waiting page.
	assert.equal((await p(`/${h.gui().token}/`, { headers: jar })).status, 401);
	const pending = await h.ask("gui-lan-pending", { face: f });
	assert.deepEqual([pending.ok, (pending.pending as unknown[]).length], [true, 1]);
	assert.ok(!JSON.stringify(pending).includes(number!), "the number is not on the computer's side");
	const wrong = await h.ask("gui-lan-approve", { face: f, number: number === "0000" ? "1111" : "0000" });
	assert.deepEqual([wrong.ok, wrong.error], [false, "no_match"]);
	assert.equal((await h.ask("gui-lan-approve", { face: f, id: (pending.pending as { id: string }[])[0]!.id, allow: true })).ok, false, "a listed request is never allowed by its id");
	assert.equal((await h.ask("gui-lan-approve", { face: f, number: Number(number) })).ok, false, "nor by a number that is not four digits as text");
	const ok = await h.ask("gui-lan-approve", { face: f, number });
	assert.deepEqual([ok.ok, (ok.paired as { label: string }).label], [true, "iPhone · Safari"]);
	assert.match(readFileSync(join(h.slot.dir, "lan.json"), "utf8"), new RegExp(sha(cookie!)), "the allowed device is kept by its cookie's hash");
	assert.ok(!readFileSync(join(h.slot.dir, "lan.json"), "utf8").includes(cookie!));
	const entry = await p("/sb-app/", { headers: { ...jar, ...NAV } });
	assert.deepEqual([entry.status, entry.headers.location], [302, `/${h.gui().token}/`]);
	assert.equal((entry.headers["set-cookie"] as string[]).length, 2, "both copies of the cookie, with the LAN cookie's name");
	assert.ok((entry.headers["set-cookie"] as string[]).every((c) => c.startsWith("__Secure-sb_lan=")));
	const page = await p(`/${h.gui().token}/`, { headers: jar });
	assert.equal(page.status, 200);
	assert.match(page.body, /<meta name="sb-csrf"/);
	const manifest = await p(`/${h.gui().token}/manifest.webmanifest`, { headers: jar });
	assert.equal(JSON.parse(manifest.body).start_url, "/sb-app/", "the installed app's start URL is the fixed entry");
	const log = readFileSync(fileOf(h.slot, "log"), "utf8");
	assert.match(log, /lan-pair-pending/);
	assert.match(log, /lan-paired label=/);
	assert.ok(!log.includes(number!) && !log.includes(cookie!), "no number or cookie in the log");
});

test("a paired phone has a paired device's reach and no more: lan/*, server/*, and remote/* are local_only (403) for it, with the page's own origin and CSRF", async () => {
	const h = await host(), f = (await turnOn(h)).face, ph = await pairedPhone(h, f), port = portOf(h), token = h.gui().token;
	const post = (path: string) => ph.p(`/${token}/api/${path}`, { method: "POST", headers: { ...ph.jar, origin: `https://${NAME}.local:${port}`, "content-type": "application/json", "x-sb-csrf": h.csrf, "sec-fetch-site": "same-origin" }, body: "{}" });
	for (const path of ["lan/on", "lan/off", "lan/pair", "lan/approve", "lan/ca", "server/status", "remote/off", "remote/unpair-all"]) {
		const r = await post(path);
		assert.deepEqual([r.status, JSON.parse(r.body).error], [403, "local_only"], path);
	}
	for (const path of ["lan/pending", "lan/ca/straw-boss-lan-ca.crt", "lan/ca/straw-boss.mobileconfig"]) {
		const r = await ph.p(`/${token}/api/${path}`, { headers: ph.jar });
		assert.deepEqual([r.status, JSON.parse(r.body).error], [403, "local_only"], path);
	}
	// This computer's page may.
	const own = await h.post("lan/pair", { surface: "tile-aaaa", form: "typed" });
	assert.deepEqual([own.status, typeof own.body.code], [200, "string"]);
	assert.equal((await h.post("lan/approve", { id: "x", allow: true })).status, 400, "no body but a number or a deny decides");
	assert.equal((await h.post("lan/approve", { number: "0000", extra: 1 })).status, 400);
});

test("the tile's reads and writes: pending lists no number, approve takes the number alone, deny leaves the device unallowed, and the certificate files and fingerprints come from the computer's page only", async () => {
	const h = await host(), f = (await turnOn(h)).face;
	const r = await redeem(h, f);
	const listed = await h.post("lan/pair", { surface: "tile-bbbb", form: "address", address: ADDRESS });
	assert.equal(listed.status, 200);
	assert.match(String(listed.body.url), new RegExp(`^https://${ADDRESS.replaceAll(".", "\\.")}:${portOf(h)}/sb-app/pair/`));
	const get = (path: string) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
		void import("node:http").then(({ request }) => request({ host: "127.0.0.1", port: h.gui().port, path: `/${h.gui().token}/api/${path}`, agent: false, headers: { host: `127.0.0.1:${h.gui().port}` } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
		}).on("error", reject).end());
	});
	const pending = JSON.parse((await get("lan/pending")).body) as { pending: Record<string, unknown>[] };
	assert.equal(pending.pending.length, 1);
	assert.ok(!JSON.stringify(pending).includes(r.number!), "the tile shows no number");
	assert.deepEqual(Object.keys(pending.pending[0]!).sort(), ["age", "ageMs", "iface", "id", "label", "peer", "since"].sort());
	const ca = await h.post("lan/ca");
	assert.equal(ca.status, 200);
	assert.match(String(ca.body.sha256), /^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
	assert.match(String(ca.body.url), new RegExp(`^http://${NAME}\\.local:${portOf(h)}/sb-ca/$`));
	const crt = await get("lan/ca/straw-boss-lan-ca.crt"), profile = await get("lan/ca/straw-boss.mobileconfig");
	assert.deepEqual([crt.status, profile.status], [200, 200]);
	assert.equal(crt.headers["content-type"], "application/x-x509-ca-cert");
	assert.match(profile.body, /com\.apple\.security\.root/);
	assert.ok(!crt.body.includes("PRIVATE KEY") && !profile.body.includes("PRIVATE KEY"), "public files only");
	assert.equal((await get("lan/ca/anything-else")).status, 404);
	const none = await h.post("lan/approve", { number: r.number === "9999" ? "9998" : "9999" });
	assert.deepEqual([none.status, none.body.error], [404, "no_match"]);
	assert.equal((await h.post("lan/approve", { number: r.number })).status, 200);
	const second = await redeem(h, f);
	assert.equal((await h.post("lan/approve", { deny: "all" })).body.denied, 1);
	assert.match((await phone(h)("/sb-app/pair/wait", { headers: { cookie: `__Secure-sb_lan=${second.cookie}` } })).body, /did not allow this device/);
});

test("a face's answers need a live face: an approval, a pair mint, and a reset are refused for a made-up id or none, a closed face is unknown, and a renewal of an unknown face says so", async () => {
	const h = await host(), { face: f } = await turnOn(h);
	for (const cmd of ["gui-lan-pair", "gui-lan-approve", "gui-lan-reset"] as const) {
		const r = await h.ask(cmd, { face: "0".repeat(32), form: "name", number: "0000", unpair: false });
		assert.deepEqual([r.ok, r.error], [false, "unknown_face"], cmd);
		const none = await h.ask(cmd, { form: "name", number: "0000", unpair: false });
		assert.deepEqual([none.ok, none.error], [false, "unknown_face"], `${cmd} with no face`);
	}
	assert.equal((await h.ask("gui-lan-pair", { face: f, form: "name" })).ok, true, "a live face may");
	assert.equal((await h.ask("gui-lan-pending", { face: "0".repeat(32) })).error, "unknown_face", "a renewal of an unknown face says so, and the overlay opens a new one");
	assert.equal((await h.ask("gui-lan-face", { face: f, open: false })).closed, true);
	assert.equal((await h.ask("gui-lan-pair", { face: f, form: "name" })).error, "unknown_face", "closed");
});

test("one live code per surface: a face's new QR voids its old one, and the typed code is minted only by a request for it", async () => {
	const h = await host(), { face: f } = await turnOn(h);
	const first = await h.ask("gui-lan-pair", { face: f, form: "name" }), second = await h.ask("gui-lan-pair", { face: f, form: "address", address: ADDRESS });
	assert.notEqual(first.url, second.url);
	assert.equal(second.form, "address");
	const old = await redeem0(h, String(first.url));
	assert.match(old.body, /That code did not work/);
	const typed = await h.ask("gui-lan-pair", { face: f, form: "typed" });
	assert.match(String(typed.code), /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
	assert.equal(typed.url, undefined, "a typed code is not a link");
	assert.match((await redeem0(h, String(second.url))).body, /That code did not work/, "and the QR before it is void");
	assert.equal((await h.ask("gui-lan-pair", { face: f, form: "elsewhere" })).error, "bad_request");
});
const redeem0 = (h: Hosted, url: string) => {
	const code = url.split("/").pop()!, port = portOf(h), host = new URL(url).hostname;
	return phone(h)("/sb-app/pair", { method: "POST", headers: { origin: `https://${host}:${port}`, host: `${host}:${port}`, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: `code=${encodeURIComponent(code)}` });
};

test("a request waiting with no overlay or tile open becomes a notice every session shows (the record), and it goes when it is answered", async () => {
	const h = await host(), { face: f } = await turnOn(h);
	const made = await h.ask("gui-lan-pair", { face: f, form: "name" });
	await h.ask("gui-lan-face", { face: f, open: false }); // the overlay is closed, the tile never was open
	const r = await redeem0(h, String(made.url));
	assert.equal(r.status, 200);
	await until(() => h.record().lanNotice?.length === 1, "the record names the waiting request");
	assert.deepEqual(Object.keys(h.record().lanNotice![0]!).sort(), ["id", "peer"]);
	assert.equal(h.record().lanNotice![0]!.peer, PEER);
	const open = await face(h);
	const number = /class="number">(\d{4})</.exec(r.body)![1];
	assert.equal((await h.ask("gui-lan-approve", { face: open, number })).ok, true);
	await until(() => h.record().lanNotice === undefined, "and it goes when the request is answered");
	// With an overlay open when the request arrives, no notice is raised.
	const again = await h.ask("gui-lan-pair", { face: open, form: "name" });
	await redeem0(h, String(again.url)).catch(() => undefined);
	assert.equal(h.record().lanNotice, undefined);
});

/** A GET of the page's API as this computer's page makes it. */
const getApi = (h: Hosted, path: string) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
	void import("node:http").then(({ request }) => request({ host: "127.0.0.1", port: h.gui().port, path: `/${h.gui().token}/api/${path}`, agent: false, headers: { host: `127.0.0.1:${h.gui().port}` } }, (res) => {
		let text = "";
		res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
	}).on("error", reject).end());
});

test("RVL7 the tile's words travel as codes: events and notes carry a code with params beside the English text, a request has its age in ms, no_ca carries the name, and the third wrong number says it denied the rest", async () => {
	const h = await host();
	const none = await h.post("lan/ca");
	assert.deepEqual([none.status, none.body.error, none.body.name], [409, "no_ca", NAME], "the off page words the risk from this answer, with no write to find the name");
	const { face: f } = await turnOn(h);
	const r = await redeem(h, f);
	const listed = (await getApi(h, "lan/pending")).body;
	assert.equal(typeof listed.pending[0].ageMs, "number");
	assert.equal(listed.pending[0].age.endsWith(" s"), true, "the English age stays for the overlay");
	assert.ok(Array.isArray(listed.noteList) && Array.isArray(listed.eventList));
	assert.equal((await h.ask("gui-lan-approve", { face: f, number: r.number })).ok, true);
	const after = (await getApi(h, "lan/pending")).body;
	const paired = after.eventList.at(-1);
	assert.deepEqual([paired.code, paired.params, paired.text, typeof paired.at], ["paired", { label: "iPhone · Safari", peer: PEER }, `Paired over Wi-Fi: iPhone · Safari (${PEER})`, "number"]);
	assert.equal(after.events.at(-1), paired.text, "`events` stays the English list the overlay shows");
	// Three wrong numbers deny everything that waits; the third answer says how many.
	await redeem(h, f);
	const wrong = async () => h.post("lan/approve", { number: "0000" });
	assert.equal((await wrong()).body.denied, undefined);
	assert.equal((await wrong()).body.denied, undefined);
	const third = await wrong();
	assert.deepEqual([third.status, third.body.error, third.body.denied], [404, "no_match", 1]);
	assert.equal(((await getApi(h, "lan/pending")).body.pending as unknown[]).length, 0);
	const void_ = (await getApi(h, "lan/pending")).body.eventList.find((e: { code: string }) => e.code === "refused");
	assert.deepEqual([void_.code, void_.params], ["refused", { peer: PEER }]);
});

test("RVL7 a peek at the waiting requests does not count as an open tile, so the sessions still get their notice; a read of the tile does", async () => {
	const h = await host(), { face: f } = await turnOn(h);
	const made = await h.ask("gui-lan-pair", { face: f, form: "name" });
	await h.ask("gui-lan-face", { face: f, open: false });
	assert.equal((await getApi(h, "lan/pending?peek=1")).status, 200);
	await redeem0(h, String(made.url));
	await until(() => h.record().lanNotice?.length === 1, "the peek left the notice to the sessions");
	await h.post("lan/approve", { deny: "all" });
	await until(() => h.record().lanNotice === undefined, "and it goes with the answer");
	const open = await face(h), again = await h.ask("gui-lan-pair", { face: open, form: "name" });
	await h.ask("gui-lan-face", { face: open, open: false });
	assert.equal((await getApi(h, "lan/pending")).status, 200); // the open tile's own poll
	await redeem0(h, String(again.url)).catch(() => undefined);
	assert.equal(h.record().lanNotice, undefined, "a tile that polled is open: no notice");
});

test("/boss gui lan while it is already serving leaves the listeners and the paired phone's connections alone (it restarts only to move a taken port)", async () => {
	const h = await host(), { face: f } = await turnOn(h);
	const lines = () => (readFileSync(fileOf(h.slot, "log"), "utf8").match(/ lan-on /g) ?? []).length;
	assert.equal(lines(), 1);
	const again = await h.ask("gui-lan", { on: true });
	assert.equal(again.ok, true);
	assert.match(String(again.text), /^Wi-Fi access is on: https:/);
	assert.equal(lines(), 1, "no second start");
	assert.equal((await h.ask("gui-lan", { on: true, accept_risk: true, face: f })).ok, true);
	assert.equal(lines(), 1);
});

test("off keeps the devices and forgets the wish; a restart without the wish binds nothing; turning it on again with the certificate made needs no warning", async () => {
	const h = await host(), { face: f } = await turnOn(h), ph = await pairedPhone(h, f), port = portOf(h);
	const off = await h.ask("gui-lan", { on: false });
	assert.equal(off.ok, true);
	const lan = await lanOf(h);
	assert.deepEqual([lan.wanted, lan.on, lan.addresses], [false, false, []]);
	const file = JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8"));
	assert.deepEqual([file.wanted, Object.keys(file.devices).length, file.port], [false, 1, port], "the allowed device and the port stay, the wish does not");
	await assert.rejects(phone(h)("/sb-app/"), /ECONNREFUSED|socket hang up|ECONNRESET/, "nothing listens");
	const on = await h.ask("gui-lan", { on: true });
	assert.equal(on.ok, true, "the certificate exists, so there is no warning");
	assert.equal((await phone(h)(`/${h.gui().token}/`, { headers: ph.jar })).status, 200, "and the phone is still paired");
});

test("a restart with the wish brings it back on the same port under the same certificate with the same devices; /boss gui stop keeps the wish, and the listeners are closed while it is stopped", async () => {
	const h = await host(), { face: f } = await turnOn(h), ph = await pairedPhone(h, f), port = portOf(h), ca = readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8");
	await h.ask("restart", { reason: "test", by: "test" });
	await h.handle.done;
	const next = await host({ pid: 7102 });
	await until(async () => (await lanOf(next)).on === true, "Wi-Fi access comes back");
	assert.equal(portOf(next), port);
	assert.equal(readFileSync(join(next.slot.dir, "lan-ca.json"), "utf8"), ca, "the same certificate");
	assert.equal((await phone(next)(`/${next.gui().token}/`, { headers: ph.jar })).status, 200, "the allowed device survived (D27)");
	assert.equal((await next.ask("gui-stop")).ok, true);
	await assert.rejects(phone(next)("/sb-app/"), /ECONNREFUSED|socket hang up|ECONNRESET/);
	assert.equal(JSON.parse(readFileSync(join(next.slot.dir, "lan.json"), "utf8")).wanted, true, "the wish stays");
	assert.equal((await next.ask("gui", { boss: true })).ok, true);
	await until(async () => (await lanOf(next)).on === true, "and comes back with the GUI");
});

test("a rotation unpairs every Wi-Fi device and keeps the certificate and the port; a start that does not keep the token does the same", async () => {
	const h = await host(), { face: f } = await turnOn(h), ph = await pairedPhone(h, f), port = portOf(h), ca = readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8");
	const before = h.gui().token;
	const rotated = await h.ask("gui-rotate");
	assert.equal(rotated.ok, true);
	assert.notEqual(h.gui().token, before);
	await until(async () => (await lanOf(h)).on === true, "Wi-Fi access is on again after the rotation");
	assert.equal(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8"), ca);
	assert.equal(portOf(h), port);
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).devices), [], "no device is paired");
	assert.equal((await phone(h)(`/${h.gui().token}/`, { headers: ph.jar })).status, 401);
});

test("reset: renew keeps the devices and makes a new certificate; unpair also clears them; both need a live face; the old certificate is replaced and the public files go", async () => {
	const h = await host(), { face: f } = await turnOn(h), ph = await pairedPhone(h, f), before = JSON.parse(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8")).cert;
	const files = await h.ask("gui-lan-files");
	assert.equal(files.ok, true);
	assert.ok((files.files as string[]).every((p) => existsSync(p)));
	assert.equal((await h.ask("gui-lan-reset", { face: f })).error, "bad_request", "renew or unpair is named");
	const renew = await h.ask("gui-lan-reset", { face: f, unpair: false });
	assert.equal(renew.ok, true, JSON.stringify(renew));
	assert.notEqual(JSON.parse(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8")).cert, before);
	assert.ok((files.files as string[]).every((p) => !existsSync(p)), "the public files of the old certificate are gone");
	assert.equal((await phone(h)(`/${h.gui().token}/`, { headers: ph.jar })).status, 200, "renew: the phone is still paired (and trusts the new certificate)");
	assert.match(readFileSync(fileOf(h.slot, "log"), "utf8"), /lan-ca-renewed fp8=[0-9a-f]{8} unpaired=false/);
	const unpair = await h.ask("gui-lan-reset", { face: f, unpair: true });
	assert.equal(unpair.ok, true);
	assert.equal((await phone(h)(`/${h.gui().token}/`, { headers: ph.jar })).status, 401, "unpair: the device is gone");
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).devices), []);
	assert.match(readFileSync(fileOf(h.slot, "log"), "utf8"), /unpaired=true/);
});

test("a taken port: the boss's command moves it to a free one and says so; a resume leaves that address unserved with the note, and with every address taken stays off", async () => {
	const busy = (taken: number) => async (server: import("node:net").Server, port: number, host: string) =>
		new Promise<void>((done, fail) => {
			if (port === taken) return fail(Object.assign(new Error("in use"), { code: "EADDRINUSE" }));
			server.once("error", fail);
			server.listen(port, host, () => (server.off("error", fail), done()));
		});
	const taken = await free();
	const h = await host({ port: taken, seams: { listen: busy(taken) } }), f = await face(h);
	const r = await h.ask("gui-lan", { on: true, accept_risk: true, face: f });
	assert.equal(r.ok, true, JSON.stringify(r));
	const moved = portOf(h);
	assert.notEqual(moved, taken, "the system picked a free port and it was recorded");
	assert.match(String((await lanOf(h)).note), new RegExp(`Port ${taken} was taken on this computer; Wi-Fi access moved to ${moved}`));
	assert.deepEqual(((await getApi(h, "lan/pending")).body.noteList as { code: string; params?: unknown }[]).find((n) => n.code === "moved")?.params, { from: taken, to: moved });
	await h.stop();
	// A resume does not move it: with the remembered port taken, the address is unserved, the server stays up, and the note says what to do.
	rmSync(join(world.stateDir, "lan.json"), { force: true });
	const stuck = await free();
	writeFileSync(join(world.stateDir, "lan.json"), JSON.stringify({ v: 1, wanted: true, port: stuck, token: "", devices: {} }), { mode: 0o600 });
	const next = await host({ port: null, pid: 7103, seams: { listen: busy(stuck) } });
	await until(async () => /stays off/.test(String((await lanOf(next)).note)), "the note");
	const lan = await lanOf(next);
	assert.deepEqual([lan.wanted, lan.on, lan.addresses], [true, false, []]);
	assert.match(String(lan.note), new RegExp(`Port ${stuck} is taken on ${ADDRESS} by another program; Wi-Fi access does not serve that address\\. Run /boss gui lan to move to a free port`));
	assert.equal((await next.ask("gui", { boss: true })).lanNote, lan.note, "`up` and /boss gui carry it");
	const stays = ((await getApi(next, "lan/pending")).body.noteList as { code: string; of?: { code: string; params?: Record<string, unknown> }[] }[]).find((n) => n.code === "stays_off");
	assert.ok(stays?.of?.some((n) => n.code === "taken" && n.params?.address === ADDRESS && n.params?.port === stuck), "the page words the held note from the codes inside it");
});

test("resume with the certificate missing or unreadable stays off with a note and makes no certificate; a corrupt store is not replaced by `gui-lan on`", async () => {
	const missing = await host({ wanted: true });
	await until(async () => /missing/.test(String((await lanOf(missing)).note)), "the missing note");
	assert.equal(existsSync(join(missing.slot.dir, "lan-ca.json")), false, "a resume never makes the certificate");
	assert.deepEqual([(await lanOf(missing)).wanted, (await lanOf(missing)).on], [true, false]);
	await missing.stop();
	if (process.platform === "win32") return;
	writeFileSync(join(world.stateDir, "lan-ca.json"), "{ not json", { mode: 0o600 });
	const bad = await host({ pid: 7104, port: null });
	await until(async () => /unreadable or readable by other accounts/.test(String((await lanOf(bad)).note)), "the corrupt note");
	const on = await bad.ask("gui-lan", { on: true, accept_risk: true, face: await face(bad) });
	assert.deepEqual([on.ok, on.error], [false, "lan_ca_corrupt"]);
	assert.equal(readFileSync(join(bad.slot.dir, "lan-ca.json"), "utf8"), "{ not json", "nothing replaced it");
});

test("a CA that has ended: a start stays off with the note, `gui-lan on` says so, and renew turns Wi-Fi access back on", async () => {
	const h = await host(), { face: f } = await turnOn(h);
	await h.stop();
	// The certificate is rewritten as one that ended long ago.
	const { createCa, writeCa } = await import("../src/lan/ca.ts");
	writeCa(world.stateDir, createCa(NAME, Date.now() - 3 * 365 * 24 * 3_600_000), { exclude: () => {} });
	const next = await host({ pid: 7105, port: null });
	await until(async () => /has ended/.test(String((await lanOf(next)).note)), "the ended note");
	assert.deepEqual([(await lanOf(next)).on, (await lanOf(next)).wanted], [false, true]);
	assert.equal((await next.ask("gui-lan", { on: true })).error, "lan_ca_ended");
	const renewed = await next.ask("gui-lan-reset", { face: await face(next), unpair: false });
	assert.equal(renewed.ok, true, JSON.stringify(renewed));
	assert.equal((await lanOf(next)).on, true, "renew turns it back on");
	void f;
});

test("a secondary slot's server refuses every gui-lan request in words, binds nothing, and writes neither lan.json nor lan-ca.json", async () => {
	const h = hosted[hosted.push(await startHosted(world, { env: { HERDR_SOCKET_PATH: join(world.stateDir, "other-herdr.sock") }, gui: { lan: seams({ listen: async () => assert.fail("a secondary server binds no LAN address") }) } as never })) - 1]!;
	assert.equal(h.options.slot.primary, false);
	for (const cmd of ["gui-lan", "gui-lan-face", "gui-lan-pair", "gui-lan-pending", "gui-lan-approve", "gui-lan-reset", "gui-lan-files"]) {
		const r = await h.ask(cmd, { on: true, face: "0".repeat(32), pane: PANE, open: true });
		assert.deepEqual([r.ok, r.error], [false, "Wi-Fi access is served by the default Herdr's sb server"], cmd);
	}
	const route = await h.post("lan/on", { accept_risk: true });
	assert.deepEqual([route.status, route.body.error], [409, "secondary"]);
	assert.equal((await h.post("lan/pair", { surface: "tile-cccc", form: "name" })).status, 409);
	for (const name of ["lan.json", "lan-ca.json"]) assert.equal(existsSync(join(h.slot.dir, name)) || existsSync(join(world.stateDir, name)), false, name);
	const lan = ((await h.ask("status")).gui as { lan: Record<string, unknown> }).lan;
	assert.deepEqual([lan.wanted, lan.on, lan.note], [false, false, "Wi-Fi access is served by the default Herdr's sb server"]);
});

test("a face's answer is refused after a paired device typed into its pane as it opened: the host's faces note the write, the approval, the risk, and the reset see it", async () => {
	const { createLanHost } = await import("../src/server/lanhost.ts");
	const dir = join(world.stateDir, "unit");
	const log = { line() {}, hide() {} };
	const lan = createLanHost({ dir, primary: true, log });
	const f = lan.faces.open(PANE)!;
	lan.faces.wrote(PANE);
	for (const request of [{ cmd: "gui-lan-approve", face: f, number: "4821" }, { cmd: "gui-lan-approve", face: f, deny: "all" }, { cmd: "gui-lan", on: true, accept_risk: true, face: f }, { cmd: "gui-lan-reset", face: f, unpair: true }, { cmd: "gui-lan-pair", face: f, form: "name" }]) {
		const r = await lan.handle(request);
		assert.deepEqual([r.ok, r.error], [false, "typed_into"], request.cmd);
		assert.match(String(r.reason), /typed into this session as this screen opened/);
	}
});

test("a run token is refused every gui-lan request, and so is a control request with no face where one is needed", async () => {
	const h = await host();
	for (const cmd of ["gui-lan", "gui-lan-face", "gui-lan-pair", "gui-lan-pending", "gui-lan-approve", "gui-lan-reset", "gui-lan-files"]) {
		const r = await h.ask(cmd, { token: "0".repeat(32), on: true });
		assert.equal(r.ok, false, cmd);
		assert.match(String(r.error), /unknown_token|token/, cmd);
	}
});

test("Tailscale access is unchanged: with both on, turning Wi-Fi access off ends only Wi-Fi streams, and remote's stays", async () => {
	const ts = fakeTailscale();
	const h = await host({ tailscale: ts.run });
	assert.equal((await h.ask("gui-remote", { on: true })).ok, true);
	const { face: f } = await turnOn(h), ph = await pairedPhone(h, f);
	const ended = { lan: false };
	const stream = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
		const port = portOf(h), ca = JSON.parse(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8")).cert as string;
		httpsRequest({ host: "127.0.0.1", port, path: `/${h.gui().token}/events`, ca, servername: `${NAME}.local`, agent: false, headers: { host: `${NAME}.local:${port}`, ...ph.jar } }, resolve).on("error", reject).end();
	});
	stream.on("close", () => (ended.lan = true));
	stream.resume();
	assert.equal(stream.statusCode, 200);
	assert.equal((await h.ask("gui-lan", { on: false })).ok, true);
	await until(() => ended.lan, "the Wi-Fi stream ended with Wi-Fi access");
	assert.equal(Boolean(h.gui()), true);
	assert.equal(h.record().gui?.stopped, false);
	assert.equal(((await h.ask("status")).gui as { remote: { on: boolean } }).remote.on, true, "remote access stays on");
	void bundle;
});
