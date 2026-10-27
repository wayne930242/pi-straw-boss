import "./setup.ts"; // a run without --import ./tests/setup.ts is isolated too, as long as a world is built (setup.ts)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntercomLike } from "../src/agent/kit.ts";
import { type Ctx, makeCtx, type SpawnSpec, type Timers } from "../src/server/client.ts";
import type { IntercomModule } from "../src/server/intercom.ts";
import { runServer, type ServerHandle, type ServerOptions } from "../src/server/main.ts";
import { readRecord, type ServerRecord, secretDir, slotOf } from "../src/server/record.ts";
import { StubClient } from "./agent-fakes.ts";

// A world for the sb server's tests: one state directory, servers that run in this process under fake pids (each with a fake pi-intercom client, no Herdr, no ACL), and
// requesters (`Ctx`) whose spawn starts one of those servers, so a start, a restart, and a stop go through the real control socket, record, and lock.

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function until(check: () => unknown, what: string, ms = 5000): Promise<void> {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(5)) if (await check()) return;
	throw new Error(`Timed out waiting for ${what}`);
}
export const FAST: Timers = { start: 5000, exit: 2000, supervisor: 400, touch: 40 };

export interface Running { pid: number; handle: ServerHandle; options: ServerOptions; client: StubClient }
export class ServerWorld {
	root = mkdtempSync(join(tmpdir(), "psb-sw-"));
	/** The environment of a shell on this computer; a test adds what it needs (scope, the desk switch). */
	env: NodeJS.ProcessEnv = { HOME: join(this.root, "home"), PI_CODING_AGENT_DIR: join(this.root, "agent") };
	pids = 1000;
	live = new Set<number>();
	running: Running[] = [];
	spawned: SpawnSpec[] = [];
	/** What a server's start does: how long its broker connection takes, whether the pi-intercom check fails, what the ACL check says. */
	connectMs = 0;
	intercomError: Error | undefined;
	aclError: Error | undefined;
	acls: string[] = [];
	exitCodes = new Map<number, number>();
	/** Set to make the next spawned process exit at once with this code instead of becoming a server. */
	crashWith: number | undefined;
	/** How long a spawned process takes to start running the server (a cold Windows start): nothing but the requester touches `restarting` meanwhile. */
	spawnMs = 0;
	/** Servers still starting when a test ends are waited for and shut down with the rest: a start in flight must not leave a server's timers behind. */
	private starting: Promise<unknown>[] = [];
	/** The looks of the sessions given `server()` below: one in flight when a test ends would make files in the folder again after it is removed. */
	private looks: Promise<unknown>[] = [];
	private closed = false;

	get stateDir() { return join(this.root, "agent", "straw-boss"); }
	get slot() { return slotOf(this.stateDir, this.env); }
	record(): ServerRecord | undefined { return readRecord(this.slot); }

	intercom(client: StubClient): IntercomModule {
		return { dir: "/fake/pi-intercom", version: "0.18.1", connect: async () => { await sleep(this.connectMs); return client as IntercomLike; } };
	}
	/** Options for a server in this world; the fakes replace everything that would touch the machine. */
	options(over: Partial<ServerOptions> & { client?: StubClient } = {}): { options: ServerOptions; client: StubClient; pid: number } {
		const pid = over.pid ?? this.pids++, client = over.client ?? new StubClient();
		this.live.add(pid);
		const options: ServerOptions = {
			slot: this.slot, env: this.env, mode: "detached", by: "test", version: "0.44.0", pid, alive: (p) => this.live.has(p), startOf: () => undefined, started: async () => `T-${pid}`,
			intercom: async () => { if (this.intercomError) throw this.intercomError; return this.intercom(client); },
			acl: async (dir) => { this.acls.push(dir); if (this.aclError) throw this.aclError; },
			// The folder's own ACL step is not run here (it needs Windows); its order is pinned in server-winprep.test.ts.
			prepare: (slot) => secretDir(slot.dir),
			herdrUp: async () => true, watch: () => () => {}, touchMs: 30, brokerMs: 1500, herdrPollMs: 30, herdrGoneMs: 200, sleep, ...over,
		};
		return { options, client, pid };
	}
	/** Runs a server directly, as `run --detached` would, and returns once it has started (ready or not). */
	async start(over: Partial<ServerOptions> & { client?: StubClient } = {}): Promise<Running> {
		const { options, client, pid } = this.options(over);
		const handle = await runServer(options);
		const running = { pid, handle, options, client };
		this.running.push(running);
		void handle.done.then((code) => (this.live.delete(pid), this.exitCodes.set(pid, code)));
		return running;
	}
	/** The server deps of a session whose look reaches this world: `ctx` (the requester of `ctx()` by default) and a fake cli, with its looks tracked for `close()`. */
	server(ctx: Partial<Ctx> = {}, over: object = {}) {
		return { ctx, cli: "/fake/cli.mjs", track: (done: Promise<unknown>) => void this.looks.push(done), ...over };
	}
	/** A requester: its spawn starts a server in this process from "its package" (`version`). */
	ctx(over: Partial<Ctx> = {}): Ctx {
		const version = over.version ?? "0.44.0";
		return makeCtx({
			slot: this.slot, cli: "/fake/cli.mjs", by: "test requester", env: this.env, platform: "linux", node: "node", timers: FAST, alive: (p) => this.live.has(p), startOf: () => undefined,
			kill: (pid) => void this.running.find((r) => r.pid === pid)?.handle.shutdown(0), prepare: (slot) => secretDir(slot.dir),
			spawn: (spec) => {
				this.spawned.push(spec);
				const by = spec.args[spec.args.indexOf("--by") + 1] ?? "?";
				if (this.crashWith !== undefined || this.closed) return { pid: this.pids++, exited: Promise.resolve(this.crashWith ?? 1) };
				const { options, client, pid } = this.options({ env: spec.env, by, version });
				const started = sleep(this.spawnMs).then(() => runServer(options)).then((handle) => {
					this.running.push({ pid, handle, options, client });
					void handle.done.then((code) => (this.live.delete(pid), this.exitCodes.set(pid, code)));
					return handle;
				});
				this.starting.push(started);
				return { pid, exited: started.then((handle) => handle.done) };
			},
			...over,
			version,
		});
	}
	async close() {
		this.closed = true;
		// A look that began before the test ended may begin a start; the start is awaited after the looks, then both are done before anything is removed.
		await Promise.allSettled(this.looks);
		await Promise.allSettled(this.starting);
		await Promise.all(this.running.map((r) => r.handle.shutdown(0)));
		rmSync(this.root, { recursive: true, force: true });
	}
}
