import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { connect, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, test } from "node:test";
import { fingerprints } from "../src/lan/ca.ts";
import type { InterfaceInfo } from "../src/lan/net.ts";
import type { Ask } from "../src/host.ts";
import type { LanSeams } from "../src/server/lanhost.ts";
import { type Agent, until, World } from "./fakes.ts";
import { type Hosted, startHosted } from "./gui-world.ts";

// `/boss gui lan` from a pi session against the real sb server in this process (docs/specs/2026-10-30-sb-gui-lan.md, Steps L6; the stand-in server of tests/lan-session.test.ts is the unit-level twin): the warning before any certificate, the
// certificate made only after y, the fingerprint on the face, `off` closing the listener, the reset choice, a phone paired by the number the boss types, the mark dropped when the overlay ends. The listeners bind 127.0.0.1 only, on injected interfaces.

const NAME = "weis-mbp", ADDRESS = "10.0.0.5", PEER = "10.0.0.23", ESC = "\x1b";
const v4 = (address: string, prefix: number): InterfaceInfo => ({ address, netmask: "", family: "IPv4", mac: "02:00:00:00:00:00", internal: false, cidr: `${address}/${prefix}` });
const seams = (): LanSeams => ({ interfaces: () => ({ en0: [v4(ADDRESS, 24)] }), bindAddress: () => "127.0.0.1", remoteOf: () => PEER, probe: async () => ADDRESS, localName: () => ({ name: NAME }), exclude: () => {}, bindWaitMs: 0, intervalMs: 600_000 });
const free = () => new Promise<number>((done) => { const s = createNetServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); }); });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const refused = (port: number) => new Promise<boolean>((done) => { const c = connect(port, "127.0.0.1"); c.once("connect", () => (c.destroy(), done(false))); c.once("error", () => done(true)); });

let world = new World();
const hosted: Hosted[] = [];
afterEach(async () => {
	await Promise.all(hosted.splice(0).map((h) => h.stop()));
	await world.stopAll();
	world = new World();
});
async function server() {
	const port = await free();
	writeFileSync(join(world.stateDir, "lan.json"), JSON.stringify({ v: 1, wanted: false, port, token: "", devices: {} }), { mode: 0o600 });
	const h = await startHosted(world, { gui: { lan: seams() } as never });
	hosted.push(h);
	// The server wrote a token of its own at its start; lan.json is bound to it.
	const secrets = JSON.parse(readFileSync(join(world.stateDir, "gui-secrets.json"), "utf8")) as { token: string };
	writeFileSync(join(world.stateDir, "lan.json"), JSON.stringify({ v: 1, wanted: false, port, token: sha(secrets.token), devices: {} }), { mode: 0o600 });
	return { h, port };
}
/** A session whose overlay runs on a clock the test moves and a ticker it fires, and whose requests to the server are recorded with their answers. */
function session(id = "viewer-a", pane = "wA:p1") {
	let t = Date.now();
	const ticks: (() => void)[] = [], log: { request: Record<string, unknown>; reply: Record<string, unknown> }[] = [];
	const ask: Ask = async (request, options) => {
		const reply = await world.ask(request, options);
		log.push({ request, reply });
		return reply;
	};
	const a: Agent = world.agent({ id, pane, tab: "wA:t1", deps: { ask, face: { now: () => t, every: (fn) => (ticks.push(fn), () => void ticks.splice(ticks.indexOf(fn), 1)), reveal: async () => {} } } });
	return {
		a, log, ticks,
		advance: (ms: number) => void (t += ms),
		async renew() {
			const before = log.length;
			for (const fn of [...ticks]) fn();
			await until(() => log.length > before, "a renewal");
		},
		requests: (cmd: string) => log.filter((x) => x.request.cmd === cmd),
		overlay: (n = 0) => a.overlays[n]!,
		screen: (n = 0) => a.overlays[n]!.render(140).join("\n"),
	};
}
const portOf = (h: Hosted) => JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).port as number;
/** The phone: one HTTPS request to the listener with the CA trusted. */
function phone(h: Hosted) {
	const ca = JSON.parse(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8")).cert as string, port = portOf(h);
	return (path: string, { method = "GET", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
		const req = httpsRequest({ host: "127.0.0.1", port, path, method, ca, servername: `${NAME}.local`, agent: false, headers: { host: `${NAME}.local:${port}`, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1", ...headers } }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
		});
		req.on("error", reject).end(body);
	});
}

test("/boss gui lan with no certificate opens the warning and makes nothing; Escape leaves no certificate, no listener, and no mark; y after the 1.5 s makes the certificate and shows its fingerprint", async () => {
	const { h, port } = await server();
	const s = session();
	await s.a.start();
	const command = s.a.command("gui lan");
	await until(() => s.a.overlays.length === 1, "the warning");
	assert.match(s.screen(), /Wi-Fi access needs a certificate this computer makes for itself/);
	assert.match(s.screen(), new RegExp(`as ${NAME}\\.local and as any private-network address`));
	assert.equal(existsSync(join(h.slot.dir, "lan-ca.json")), false, "the warning comes before the certificate");
	s.overlay().handleInput!(ESC);
	await command;
	const face = String(s.requests("gui-lan-face")[0]!.reply.face);
	assert.equal((await h.ask("gui-lan-pending", { face })).error, "unknown_face", "the mark was dropped at the server on Escape");
	assert.equal(existsSync(join(h.slot.dir, "lan-ca.json")), false);
	assert.equal(await refused(port), true, "no listener");

	const again = s.a.command("gui lan");
	await until(() => s.a.overlays.length === 2, "the warning again");
	s.overlay(1).handleInput!("y");
	await new Promise<void>((r) => setTimeout(r, 30));
	assert.equal(existsSync(join(h.slot.dir, "lan-ca.json")), false, "y inside the 1.5 s does nothing");
	s.advance(1500);
	s.overlay(1).handleInput!("y");
	await until(() => /Step 1, once per phone/.test(s.screen(1)), "the certificate face");
	const real = fingerprints({ cert: JSON.parse(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8")).cert });
	assert.ok(s.screen(1).includes(`SHA-256 starting: ${real.sha256}`), "the fingerprint on the face is the certificate's own");
	assert.ok(s.screen(1).includes(real.sha1), "and the Windows thumbprint");
	assert.match(s.screen(1), new RegExp(`Wi-Fi access is on: https://${NAME}\\.local:${port} \\(served: ${ADDRESS} \\(en0\\)\\)`));
	assert.equal(await refused(port), false, "the listener is up");
	assert.match(s.a.notices.at(-1)!.text, new RegExp(`^Wi-Fi access is on: https://${NAME}\\.local:${port}/sb-app/ \\(served: ${ADDRESS} \\(en0\\)\\)\\. Pair in the overlay; you allow each new device here by typing the number its screen shows\\.$`));
	assert.ok(!s.a.notices.some((n) => /\/pair\//.test(n.text)), "no code in the conversation");
	s.overlay(1).handleInput!(ESC);
	await again;
});

test("/boss gui lan off really stops the listeners and keeps the certificate; /boss gui lan then opens on the certificate face, which makes no new certificate", async () => {
	const { h, port } = await server();
	const s = session();
	await s.a.start();
	const first = s.a.command("gui lan");
	await until(() => s.a.overlays.length === 1, "the warning");
	s.advance(1500);
	s.overlay().handleInput!("y");
	await until(() => /Step 1, once per phone/.test(s.screen()), "the certificate face");
	s.overlay().handleInput!(ESC);
	await first;
	const before = readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8");
	assert.equal(await refused(port), false);
	await s.a.command("gui lan off");
	assert.equal(await refused(port), true, "off closes the listener");
	assert.equal(s.a.notices.at(-1)!.text, "Wi-Fi access is off; the devices you allowed stay paired");
	assert.equal(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8"), before, "the certificate stays");
	const again = s.a.command("gui lan");
	await until(() => s.a.overlays.length === 2, "the certificate face");
	assert.match(s.screen(1), /Step 1, once per phone/, "no warning the second time");
	assert.equal(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8"), before);
	assert.equal(await refused(port), false, "on again");
	s.overlay(1).handleInput!(ESC);
	await again;
});

test("/boss gui lan off with no server or no GUI says so and starts nothing", async () => {
	const s = session();
	await s.a.start();
	await s.a.command("gui lan off");
	assert.match(s.a.notices.at(-1)!.text, /Wi-Fi access is off: the straw net GUI is not running/);
	assert.equal(s.a.overlays.length, 0);
});

test("/boss gui lan reset asks first: Escape changes nothing, r makes a new certificate and keeps the devices, u unpairs them; the face then shows the new fingerprint", async () => {
	const { h, port } = await server();
	const s = session();
	await s.a.start();
	const first = s.a.command("gui lan");
	await until(() => s.a.overlays.length === 1, "the warning");
	s.advance(1500);
	s.overlay().handleInput!("y");
	await until(() => /Step 1, once per phone/.test(s.screen()), "the certificate face");
	s.overlay().handleInput!(ESC);
	await first;
	const original = readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8");

	const cancelled = s.a.command("gui lan reset");
	await until(() => s.a.overlays.length === 2, "the reset face");
	assert.match(s.screen(1), /Make a new Wi-Fi access certificate\?/);
	s.advance(1500);
	s.overlay(1).handleInput!(ESC);
	await cancelled;
	assert.equal(readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8"), original, "Escape deletes nothing");
	assert.equal(s.requests("gui-lan-reset").length, 0);

	// A device allowed over Wi-Fi: the number typed in the overlay (the phone's own page shows it).
	const pairing = s.a.command("gui lan");
	await until(() => s.a.overlays.length === 3, "the certificate face");
	s.advance(1500);
	s.overlay(2).handleInput!("p");
	await until(() => /Scan with a phone on this network/.test(s.screen(2)), "the pairing face");
	const url = String(s.requests("gui-lan-pair").at(-1)!.reply.url), code = url.split("/").pop()!;
	const p = phone(h);
	const res = await p("/sb-app/pair", { method: "POST", headers: { origin: `https://${NAME}.local:${port}`, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: `code=${encodeURIComponent(code)}` });
	const number = /class="number">(\d{4})</.exec(res.body)?.[1];
	assert.ok(number, res.body);
	await s.renew();
	assert.match(s.screen(2), /^Pair request: iPhone · Safari from 10\.0\.0\.23 \(en0\)\nType the number your phone shows/);
	assert.ok(!s.screen(2).includes(number), "the overlay does not print the number");
	assert.equal(JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).devices && Object.keys(JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).devices).length, 0, "nothing is allowed until the boss types");
	for (const digit of number) s.overlay(2).handleInput!(digit);
	s.overlay(2).handleInput!("\r");
	await until(() => Object.keys(JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).devices).length === 1, "the device allowed by the typed number");
	await s.renew();
	await until(() => s.a.notices.some((n) => /^Paired over Wi-Fi: iPhone/.test(n.text)), "the notice in the session");
	s.overlay(2).handleInput!(ESC);
	await pairing;

	const renewing = s.a.command("gui lan reset");
	await until(() => s.a.overlays.length === 4, "the reset face");
	s.advance(1500);
	s.overlay(3).handleInput!("r");
	await until(() => /Step 1, once per phone/.test(s.screen(3)), "the certificate face");
	const renewed = readFileSync(join(h.slot.dir, "lan-ca.json"), "utf8");
	assert.notEqual(renewed, original, "a new certificate");
	assert.ok(s.screen(3).includes(`SHA-256 starting: ${fingerprints({ cert: JSON.parse(renewed).cert }).sha256}`), "with its own fingerprint");
	assert.equal(Object.keys(JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).devices).length, 1, "r keeps the device");
	assert.equal(await refused(port), false, "and Wi-Fi access stays on");
	s.overlay(3).handleInput!(ESC);
	await renewing;

	const unpairing = s.a.command("gui lan reset");
	await until(() => s.a.overlays.length === 5, "the reset face");
	s.advance(1500);
	s.overlay(4).handleInput!("u");
	await until(() => /Step 1, once per phone/.test(s.screen(4)), "the certificate face");
	assert.equal(Object.keys(JSON.parse(readFileSync(join(h.slot.dir, "lan.json"), "utf8")).devices).length, 0, "u unpairs every device paired over Wi-Fi");
	s.overlay(4).handleInput!(ESC);
	await unpairing;
});

test("/boss gui lan reset with no certificate says so in the overlay and changes nothing", async () => {
	const { h } = await server();
	const s = session();
	await s.a.start();
	const command = s.a.command("gui lan reset");
	await until(() => s.a.overlays.length === 1, "the reset face");
	s.advance(1500);
	s.overlay().handleInput!("r");
	await until(() => /There is no Wi-Fi certificate to replace/.test(s.screen()), "the refusal");
	assert.equal(existsSync(join(h.slot.dir, "lan-ca.json")), false, "a reset makes no first certificate: only the warning does");
	s.overlay().handleInput!(ESC);
	await command;
});

test("the overlay's mark is the server's own: while it is open the face is live at the server, and the end of the session drops it", async () => {
	const { h } = await server();
	const s = session();
	await s.a.start();
	const command = s.a.command("gui lan");
	await until(() => s.a.overlays.length === 1, "the warning");
	const face = String(s.requests("gui-lan-face")[0]!.reply.face);
	assert.equal(s.requests("gui-lan-face")[0]!.request.pane, "wA:p1", "the mark names this session's pane");
	assert.equal((await h.ask("gui-lan-pending", { face })).ok, true, "live while open");
	await s.renew();
	assert.equal(s.requests("gui-lan-pending").at(-1)!.request.face, face, "the poll renews it");
	await s.a.stop();
	await command;
	assert.equal(s.a.overlays[0]!.render(100).length > 0, true);
	assert.equal((await h.ask("gui-lan-pending", { face })).error, "unknown_face", "the end of the session dropped the mark");
	assert.equal(s.requests("gui-lan-face").at(-1)!.request.open, false);
});

test("Tab completes /boss gui lan, off, and reset", async () => {
	const s = session();
	await s.a.start();
	const complete = (prefix: string) => (s.a.commands.get("boss")!.getArgumentCompletions!(prefix) ?? []).map((x) => x.value);
	assert.deepEqual(complete("gui l"), ["gui lan", "gui lan off", "gui lan reset"]);
	assert.deepEqual(complete("gui lan o"), ["gui lan off"]);
	assert.deepEqual(complete("gui lan r"), ["gui lan reset"]);
	assert.ok(complete("gui").includes("gui lan") && complete("gui").includes("gui remote"));
	assert.ok(complete("").includes("gui lan reset"));
});

test("a stopped server: /boss gui lan starts nothing it should not and tells the boss when the sb server does not answer", async () => {
	const s = session();
	await s.a.start();
	await s.a.command("gui lan");
	assert.deepEqual(s.a.notices.map((n) => [n.level, n.text]).at(-1), ["error", "no server"]);
	assert.equal(s.a.overlays.length, 0, "no overlay without a server");
});
