import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { connect, createServer as createNetServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { createHash } from "node:crypto";
import type { LanSeams } from "../src/server/lanhost.ts";
import type { InterfaceInfo } from "../src/lan/net.ts";
import { type ServerOptions, runServer } from "../src/server/main.ts";
import { readRecord, secretDir, slotOf } from "../src/server/record.ts";
import { callControl, type Request } from "../src/server/socket.ts";
import { FakeClient } from "./agent-fakes.ts";
import { until, World } from "./fakes.ts";
import { bundle, noLink, noTailscale, scratch } from "./gui-fakes.ts";
import { startHosted, stopHosted } from "./gui-world.ts";

// RVLF: a deterministic hold of the RVL6-F005 window. The startup GUI start reads lan.json (createAccess) before it binds; a held preferred port keeps it in its bind wait (bindWaitMs), so an off sent then lands inside begin().
const NAME = "weis-mbp", ADDRESS = "10.0.0.5";
const v4 = (address: string, prefix: number): InterfaceInfo => ({ address, netmask: "", family: "IPv4", mac: "02:00:00:00:00:00", internal: false, cidr: `${address}/${prefix}` });
const seams = (): LanSeams => ({ interfaces: () => ({ en0: [v4(ADDRESS, 24)] }), bindAddress: () => "127.0.0.1", remoteOf: () => "10.0.0.23", probe: async () => ADDRESS, localName: () => ({ name: NAME }), exclude: () => {}, bindWaitMs: 0, intervalMs: 600_000 });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const free = () => new Promise<number>((done) => { const s = createNetServer().listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => done(port)); }); });
const refused = (port: number) => new Promise<boolean>((done) => { const c = connect(port, "127.0.0.1"); c.once("connect", () => (c.destroy(), done(false))); c.once("error", () => done(true)); });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let world = new World();
afterEach(async () => {
	await stopHosted();
	await world.stopAll();
	world = new World();
});

test("RVL6-F005: an off sent while the startup GUI start sits in its bind wait (lan.json already read) waits for the start, and the wish ends cleared with nothing bound", { timeout: 60_000 }, async () => {
	const lanPort = await free();
	writeFileSync(join(world.stateDir, "lan.json"), JSON.stringify({ v: 1, wanted: false, port: lanPort, token: "", devices: {} }), { mode: 0o600 });
	// First run: the CA is made and the wish is on.
	const first = await startHosted(world, { gui: { lan: seams() } as never });
	const face = String((await first.ask("gui-lan-face", { pane: null, open: true })).face);
	assert.equal((await first.ask("gui-lan", { on: true, accept_risk: true, face })).ok, true);
	assert.equal(await refused(lanPort), false);
	await first.stop();
	const secrets = JSON.parse(readFileSync(join(world.stateDir, "gui-secrets.json"), "utf8")) as { token: string; port: number };
	assert.equal(JSON.parse(readFileSync(join(world.stateDir, "lan.json"), "utf8")).wanted, true);
	assert.equal(JSON.parse(readFileSync(join(world.stateDir, "lan.json"), "utf8")).token, sha(secrets.token));
	// Hold the GUI's recorded local port, so the next start waits in startGui's bind loop after createAccess read lan.json.
	const holder: Server = await new Promise((done) => { const s = createNetServer().listen(secrets.port, "127.0.0.1", () => done(s)); });
	const pid = 7300, env: NodeJS.ProcessEnv = { HOME: join(scratch, "home"), PI_CODING_AGENT_DIR: join(scratch, "agent") }, slot = slotOf(world.stateDir, env);
	const client = new FakeClient(world.broker, "");
	const options: ServerOptions = {
		slot, env, mode: "detached", by: "test", version: "0.45.0", pid, alive: (p) => p === pid || p === process.pid, startOf: () => undefined, started: async () => `T-${pid}`,
		intercom: async () => ({ dir: "/fake/pi-intercom", version: "0.18.1", connect: async () => client }),
		acl: async () => {}, prepare: (s) => secretDir(s.dir), herdrUp: async () => true, watch: world.watch, touchMs: 30, brokerMs: 1500, herdrPollMs: 30, herdrGoneMs: 200, sleep,
		herdr: { run: world.herdr.runFor(""), api: world.herdr.api, events: world.herdr.events, watch: world.watch, call: (async () => ({})) as never, sleep: (ms) => sleep(Math.min(ms, 2)), stateDir: world.stateDir },
		gui: { bundle, tailscale: noTailscale, link: noLink, bindWaitMs: 20_000, lan: seams() },
	};
	const handleP = runServer(options);
	let handle: Awaited<typeof handleP> | undefined;
	try {
		// The control socket answers while the GUI start waits for its port.
		await until(() => Boolean(readRecord(slot)?.socket && readRecord(slot)?.pid === pid), "the record names the new server's socket");
		const ask = (cmd: string, more: Record<string, unknown> = {}) => callControl(readRecord(slot)!.socket, readRecord(slot)!.secret, { cmd, ...more } as Request, 30_000).then((r) => r.reply!);
		await sleep(800);
		await sleep(300);
		let settled = false;
		const off = ask("gui-lan", { on: false }).then((r) => ((settled = true), r));
		await sleep(500);
		const waited = !settled;
		holder.close();
		const reply = await off;
		handle = await handleP;
		await handle.ready;
		await sleep(300);
		const file = JSON.parse(readFileSync(join(world.stateDir, "lan.json"), "utf8"));
		const lan = ((await ask("status")).gui as { lan: { wanted: boolean; on: boolean } }).lan;
		assert.equal(reply.ok, true);
		assert.equal(waited, true, "the off waited for the start in flight");
		assert.equal(file.wanted, false, "lan.json: wish cleared");
		assert.deepEqual([lan.wanted, lan.on], [false, false]);
		assert.equal(await refused(lanPort), true, "nothing bound");
	} finally {
		holder.close();
		await (handle ?? (await handleP)).shutdown(0);
	}
});
