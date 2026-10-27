import { request } from "node:http";
import { join } from "node:path";
import { type GuiRecord, readRecord as readGui } from "../src/handover.ts";
import type { GuiLink } from "../src/link/guiport.ts";
import type { Run } from "../src/remote.ts";
import type { HerdrCall } from "../src/herdr.ts";
import { type ServerHandle, type ServerOptions, runServer } from "../src/server/main.ts";
import { readRecord, type ServerRecord, secretDir, slotOf } from "../src/server/record.ts";
import { callControl, type Request } from "../src/server/socket.ts";
import { FakeClient } from "./agent-fakes.ts";
import { bundle, noLink, noTailscale, scratch } from "./gui-fakes.ts";
import type { World } from "./fakes.ts";

export { bundle, fakeTailscale, noLink, noTailscale } from "./gui-fakes.ts";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The sb server with its GUI, running in a test's process against the fake Herdr and the fake broker the `World`'s sessions use (the server's intercom client is a FakeClient on that
// broker), so a session's /boss gui goes over the server's real control socket and its bridge relays to the server's real hub. The state directory is the world's.

export interface HostedOptions {
	tailscale?: Run;
	link?: GuiLink;
	pid?: number;
	version?: string;
	env?: NodeJS.ProcessEnv;
	/** A server that runs under a supervisor. */
	mode?: "detached" | "serve";
	/** Replaces the page's Restart button. */
	restart?: NonNullable<Exclude<ServerOptions["gui"], false | undefined>["restart"]>;
	gui?: false | Exclude<ServerOptions["gui"], false | undefined>;
	/** Herdr's API as the GUI calls it (pane.get answers from the world's panes by default). */
	call?: HerdrCall;
	options?: Partial<ServerOptions>;
}
let pids = 7000;
const live = new Set<number>();
const started: Hosted[] = [];
/** A pid the fake `alive` counts as running (a pi session of an older build that the test plays); `forget` ends it. */
export const markAlive = (pid: number) => void live.add(pid);
export const markGone = (pid: number) => void live.delete(pid);
/** Stops every server a test started; call it after each test. */
export const stopHosted = async () => void (await Promise.all(started.splice(0).map((h) => h.stop())));

export class Hosted {
	readonly world: World;
	readonly handle: ServerHandle;
	readonly client: FakeClient;
	readonly pid: number;
	readonly options: ServerOptions;
	constructor(world: World, handle: ServerHandle, client: FakeClient, pid: number, options: ServerOptions) {
		[this.world, this.handle, this.client, this.pid, this.options] = [world, handle, client, pid, options];
	}
	get slot() { return slotOf(this.world.stateDir, this.options.env); }
	/** server.json. */
	record(): ServerRecord { return readRecord(this.slot)!; }
	/** gui.json, the contract. */
	gui(): GuiRecord { return readGui(this.slot.dir)!; }
	get url() { return `http://127.0.0.1:${this.gui().port}/${this.gui().token}/`; }
	get csrf() { return this.gui().csrf!; }
	/** One control request, as a session or the CLI sends it. */
	ask(cmd: string, more: Record<string, unknown> = {}) {
		return callControl(this.record().socket, this.record().secret, { cmd, ...more } as Request).then((r) => r.reply!);
	}
	/** One POST to the page's API, as this computer's page sends it. */
	post(path: string, body: Record<string, unknown> = {}, over: { origin?: string; port?: number; headers?: Record<string, string> } = {}) {
		const gui = this.gui(), port = over.port ?? gui.port, data = JSON.stringify(body);
		return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port, path: `/${gui.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${port}`, origin: over.origin ?? `http://127.0.0.1:${port}`, "content-type": "application/json", "x-sb-csrf": gui.csrf!, "content-length": Buffer.byteLength(data), ...over.headers } }, (res) => {
				let text = "";
				res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : {} }));
			});
			req.on("error", reject).end(data);
		});
	}
	private stopped = false;
	async stop() {
		if (this.stopped) return;
		this.stopped = true;
		await this.handle.shutdown(0);
		live.delete(this.pid);
	}
}

/** Starts the server with its GUI in the world's state directory and returns once it is ready. A second one in the same directory is a restart: stop the first before. */
export async function startHosted(world: World, over: HostedOptions = {}): Promise<Hosted> {
	const pid = over.pid ?? pids++, env: NodeJS.ProcessEnv = { HOME: join(scratch, "home"), PI_CODING_AGENT_DIR: join(scratch, "agent"), ...over.env }, slot = slotOf(world.stateDir, env);
	const client = new FakeClient(world.broker, "");
	live.add(pid);
	const call: HerdrCall = over.call ?? (async (method, params) => (method === "pane.get" ? { pane: world.herdr.pane(String((params as { pane_id: string }).pane_id)) } : {}) as never);
	const options: ServerOptions = {
		slot, env, mode: over.mode ?? "detached", by: "test", version: over.version ?? "0.45.0", pid, alive: (p) => live.has(p) || p === process.pid, startOf: () => undefined, started: async () => `T-${pid}`,
		intercom: async () => ({ dir: "/fake/pi-intercom", version: "0.18.1", connect: async () => client }),
		acl: async () => {}, prepare: (s) => secretDir(s.dir), herdrUp: async () => true, watch: world.watch, touchMs: 30, brokerMs: 1500, herdrPollMs: 30, herdrGoneMs: 200, sleep,
		herdr: { run: world.herdr.runFor(""), api: world.herdr.api, events: world.herdr.events, watch: world.watch, call, sleep: (ms) => sleep(Math.min(ms, 2)), stateDir: world.stateDir },
		gui: over.gui === false ? false : { bundle, tailscale: over.tailscale ?? noTailscale, link: over.link ?? noLink, bindWaitMs: 300, ...(over.restart ? { restart: over.restart } : {}), ...over.gui },
		...over.options,
	};
	const handle = await runServer(options);
	void handle.done.then(() => live.delete(pid));
	await handle.ready;
	const hosted = new Hosted(world, handle, client, pid, options);
	started.push(hosted);
	// Sessions reach the server's GUI over its real control socket, as server-look does.
	world.ask = async (request, { start }) => {
		const record = readRecord(slot);
		if (!record?.socket || !live.has(record.pid)) return { ok: false, error: start === "never" ? "no server" : "the server is not running" };
		return (await callControl(record.socket, record.secret, { ...request, cmd: String(request.cmd) } as Request, 20_000)).reply as { ok: boolean };
	};
	return hosted;
}
