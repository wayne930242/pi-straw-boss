import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StubClient } from "./agent-fakes.ts";
import { FakeHerdr } from "./fakes.ts";
import { ServerWorld } from "./server-world.ts";
import type { Session } from "../src/herdr.ts";
import type { Timers } from "../src/server/runs.ts";

// A world for the tower service's tests: the sb server world with a fake Herdr and one fake pi-intercom client per identity. `towerRuns.enabled` is set in the state directory's config.json.
// Runs: Herdr's `agent start` makes a pi process (a fake PID in the pane's process list) that the test claims and drives over the control socket (`pi`), and the run timers are short.

/** Short run timers: a wake after 40 ms, the watcher every 20 ms. A test overrides what it is about. */
export const FAST_RUNS: Partial<Timers> = { wake: 40, claim: 3000, watch: 20, idleSteer: 60_000, idleEnd: 300_000, steerAt: 600_000, quitAt: 1_200_000, quitGrace: 200, signal: 100, lost: 60_000, refuse: 150, loop: 60_000, restored: 400 };

export class TowerWorld extends ServerWorld {
	herdr = new FakeHerdr();
	clients: StubClient[] = [];
	/** What every client's `listSessions` answers: the live sessions of the broker. */
	sessions: Session[] = [];
	takeovers: (() => void)[] = [];
	/** The pi processes `agent start` made: run id → PID and pane; and the signals the server sent. */
	pis = new Map<string, { pid: number; pane: string; args: string[] }>();
	kills: [number, string][] = [];
	nextPi = 7000;
	/** Set to make the settings check refuse. */
	settingsError: Error | undefined;
	runTimers: Partial<Timers> = {};
	runMax: number | undefined;
	setFlag(enabled: boolean | undefined, max?: number) {
		mkdirSync(this.stateDir, { recursive: true });
		writeFileSync(join(this.stateDir, "config.json"), JSON.stringify(enabled === undefined ? {} : { towerRuns: { enabled, ...(max ? { max } : {}) } }));
	}
	constructor() {
		super();
		this.herdr.onAgentStart = (pane, args) => {
			const id = args[args.indexOf("--sb-run") + 1];
			if (!id) return;
			const pid = this.nextPi++;
			this.live.add(pid);
			this.pis.set(id, { pid, pane: pane.pane_id, args });
			pane.processes = [{ argv0: "pi", name: "node", pid, cmdline: `node pi ${args.slice(args.indexOf("--") + 1).join(" ")}` }];
		};
	}
	override options(over: Parameters<ServerWorld["options"]>[0] = {}) {
		return super.options({
			intercom: async () => ({ dir: "/fake/pi-intercom", version: "0.18.1", connect: async () => {
				const client = new StubClient();
				client.listSessions = async () => this.sessions;
				this.clients.push(client);
				return client;
			} }),
			herdr: { run: this.herdr.runFor("none"), events: this.herdr.events, api: this.herdr.api, watch: (cb: () => void) => (this.takeovers.push(cb), () => {}) },
			towers: {
				recoverMs: 150, registerMs: 500, residentMs: 20, retryMs: [20],
				runs: {
					timers: { ...FAST_RUNS, ...this.runTimers }, alive: (pid) => this.live.has(pid), startOf: (pid) => `T-${pid}`, kill: (pid, signal) => void this.kills.push([pid, signal]),
					settings: async () => { if (this.settingsError) throw this.settingsError; },
					...(this.runMax ? { max: () => this.runMax! } : {}),
				},
			},
			...over,
		});
	}
	/** The client that registered under an id. */
	client(id: string) {
		return this.clients.find((c) => c.sessionId === id);
	}
}
