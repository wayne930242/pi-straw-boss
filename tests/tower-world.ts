import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StubClient } from "./agent-fakes.ts";
import { FakeHerdr } from "./fakes.ts";
import { ServerWorld } from "./server-world.ts";
import type { Session } from "../src/herdr.ts";

// A world for the tower service's tests: the sb server world with a fake Herdr and one fake pi-intercom client per identity. `towerRuns.enabled` is set in the state directory's config.json.

export class TowerWorld extends ServerWorld {
	herdr = new FakeHerdr();
	clients: StubClient[] = [];
	/** What every client's `listSessions` answers: the live sessions of the broker. */
	sessions: Session[] = [];
	takeovers: (() => void)[] = [];
	setFlag(enabled: boolean | undefined) {
		mkdirSync(this.stateDir, { recursive: true });
		writeFileSync(join(this.stateDir, "config.json"), JSON.stringify(enabled === undefined ? {} : { towerRuns: { enabled } }));
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
			towers: { recoverMs: 150, registerMs: 500, residentMs: 20, retryMs: [20] },
			...over,
		});
	}
	/** The client that registered under an id. */
	client(id: string) {
		return this.clients.find((c) => c.sessionId === id);
	}
}
