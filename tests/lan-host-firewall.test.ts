import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { FirewallInput, FirewallRead } from "../src/lan/firewall.ts";
import type { InterfaceInfo } from "../src/lan/net.ts";
import type { LanSeams } from "../src/server/lanhost.ts";
import { until, World } from "./fakes.ts";
import { type Hosted, startHosted } from "./gui-world.ts";

// Where the firewall read meets the server (docs/specs/2026-10-30-sb-gui-lan.md, Windows "PowerShell cost"; Steps L8): the read starts once the listeners are up and never holds the switch, its notes join the Wi-Fi notes
// when it is done, they go when the listeners close, and the read of listeners that are gone is dropped. The read itself is a stand-in here (tests/lan-firewall.test.ts covers it); the listeners bind 127.0.0.1 only.

const NAME = "weis-mbp", ADDRESS = "10.0.0.5", PEER = "10.0.0.23", PANE = "wA:p9";
const v4 = (address: string, prefix: number): InterfaceInfo => ({ address, netmask: "", family: "IPv4", mac: "02:00:00:00:00:00", internal: false, cidr: `${address}/${prefix}` });
const free = () => new Promise<number>((done) => { const s = createNetServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); }); });

let world = new World();
const hosted: Hosted[] = [];
afterEach(async () => {
	await Promise.all(hosted.splice(0).map((h) => h.stop()));
	await world.stopAll();
	world = new World();
});
async function host(firewall?: LanSeams["firewall"]) {
	const port = await free();
	const secrets = existsSync(join(world.stateDir, "gui-secrets.json")) ? JSON.parse(readFileSync(join(world.stateDir, "gui-secrets.json"), "utf8")) : undefined;
	writeFileSync(join(world.stateDir, "lan.json"), JSON.stringify({ v: 1, wanted: false, port, token: secrets ? createHash("sha256").update(secrets.token).digest("hex") : "", devices: {} }), { mode: 0o600 });
	const seams: LanSeams = { interfaces: () => ({ en0: [v4(ADDRESS, 24)] }), bindAddress: () => "127.0.0.1", remoteOf: () => PEER, probe: async () => ADDRESS, localName: () => ({ name: NAME }), exclude: () => {}, bindWaitMs: 0, intervalMs: 600_000, ...(firewall ? { firewall } : {}) };
	const h = await startHosted(world, { gui: { lan: seams } as never });
	hosted.push(h);
	return { h, port };
}
const lanOf = async (h: Hosted) => ((await h.ask("status")).gui as { lan: Record<string, any> }).lan;
async function on(h: Hosted) {
	const face = String((await h.ask("gui-lan-face", { pane: PANE, open: true })).face);
	const r = await h.ask("gui-lan", { on: true, accept_risk: true, face });
	assert.equal(r.ok, true, JSON.stringify(r));
	return face;
}
const read = (notes: string[]): FirewallRead => ({ notes, summary: `${notes.length} notes` });

test("the read starts with the listeners, is told the port and the served addresses with their interfaces, and its notes join the Wi-Fi access notes when it is done", async () => {
	const calls: FirewallInput[] = [];
	let release!: (r: FirewallRead) => void;
	const { h, port } = await host((input) => (calls.push(input), new Promise((resolve) => (release = resolve))));
	await on(h);
	// The switch has answered while the read is still running: it never holds the switch.
	assert.equal((await lanOf(h)).on, true);
	assert.equal((await lanOf(h)).note, undefined);
	await until(async () => calls.length === 1, "the read");
	assert.deepEqual(calls[0], { port: (await lanOf(h)).port, served: [{ address: ADDRESS, iface: "en0" }] });
	assert.equal(calls[0]!.port, port);
	release(read(["macOS firewall blocks node: allow it in System Settings, Network, Firewall, Options."]));
	await until(async () => /macOS firewall blocks node/.test(String((await lanOf(h)).note)), "the note");
	assert.equal(calls.length, 1, "one read per start of the listeners");
	assert.ok(/lan-firewall/.test(readFileSync(join(world.stateDir, "server.log"), "utf8")), "the summary is logged");
});

test("the notes go when Wi-Fi access is turned off, and a read that finishes after the listeners closed is dropped", async () => {
	const pending: ((r: FirewallRead) => void)[] = [];
	const { h } = await host(() => new Promise((resolve) => pending.push(resolve)));
	const off = async () => assert.equal((await h.ask("gui-lan", { on: false })).ok, true);
	const face = await on(h);
	await until(async () => pending.length === 1, "the first read");
	pending[0]!(read(["note A"]));
	await until(async () => (await lanOf(h)).note === "note A", "note A");
	await off();
	assert.equal((await lanOf(h)).note, undefined, "off clears the notes");
	await h.ask("gui-lan", { on: true, accept_risk: true, face });
	await until(async () => pending.length === 2, "a read for the new listeners");
	assert.equal((await lanOf(h)).note, undefined, "the old note does not come back before the new read is done");
	await off();
	pending[1]!(read(["stale note from listeners that are gone"]));
	await h.ask("gui-lan", { on: true, accept_risk: true, face });
	await until(async () => pending.length === 3, "a third read");
	assert.equal((await lanOf(h)).note, undefined, "a read of listeners that are gone is dropped");
	pending[2]!(read(["fresh note"]));
	await until(async () => (await lanOf(h)).note === "fresh note", "the fresh note");
});

test("a read that fails leaves Wi-Fi access on and no note, and says so in the log", async () => {
	const { h } = await host(async () => { throw new Error("socketfilterfw exploded"); });
	await on(h);
	await until(async () => /the read failed: socketfilterfw exploded/.test(readFileSync(join(world.stateDir, "server.log"), "utf8")), "the log line");
	const lan = await lanOf(h);
	assert.equal(lan.on, true);
	assert.equal(lan.note, undefined);
});
