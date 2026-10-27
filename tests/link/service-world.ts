import { headlessConfig } from "../../src/agent/config.ts";
import { createHeadlessKit } from "../../src/agent/kit.ts";
import { createLinkService, type LinkService, type ServiceDeps } from "../../src/link/service.ts";
import { FakeClient } from "../agent-fakes.ts";
import type { World } from "../fakes.ts";

// The sb server's part of Straw Link for the tests that run pi sessions in a `World`: the link service of src/link/service.ts on a headless kit, connected to the world's
// intercom broker by a `FakeClient` under an id of its own, as the server connects. The sessions of the world reach it through `ask` (in place of the control socket,
// which tests/server-link.test.ts exercises for real).

/** A session's way to the holder in a test: the request, the asking session's id, and the time it may take. */
export type LinkServiceAsk = (op: Record<string, unknown>, from: string, ms?: number) => Promise<{ ok: boolean; error?: string; [key: string]: unknown }>;

export interface LinkServer {
	id: string;
	service: LinkService;
	client: FakeClient;
	notices: { text: string; level?: string }[];
	/** What a session's `link.ask` seam is: the request goes to the service as the session's id. */
	ask: LinkServiceAsk;
	/** Resolves once the service has looked once (the election has run; the holder is starting). */
	ready: Promise<void>;
	/** Disconnects from the broker and ends the service, as the server's shutdown does. */
	stop(): Promise<void>;
}

/** Builds the service and connects it (the fake client connects without waiting); `start` false leaves the election and the channel to the test (`server.service.start()`). */
export function linkServer(world: World, o: { id?: string; deps?: ServiceDeps; version?: string; start?: boolean; started?: () => string | undefined } = {}): LinkServer {
	const id = o.id ?? "sb-server-test", client = new FakeClient(world.broker, "");
	const env = { PI_INTERCOM_SESSION_ID: id } as NodeJS.ProcessEnv;
	const cfg = headlessConfig({ run: world.herdr.runFor(""), api: world.herdr.api, events: world.herdr.events, watch: world.watch, stateDir: world.stateDir, sleep: async () => undefined }, env);
	const kit = createHeadlessKit({ client, env, cfg });
	kit.attach(client);
	void client.connect({ name: "sb server", cwd: world.stateDir, model: "straw-boss-server", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() }, id);
	const notices: { text: string; level?: string }[] = [];
	const service = createLinkService({ kit, stateDir: world.stateDir, version: o.version ?? "0.46.0", ...(o.started ? { started: o.started } : {}), notify: (text, level) => void notices.push({ text, level }), deps: o.deps });
	const server: LinkServer = {
		id, service, client, notices, ready: Promise.resolve(),
		ask: (op, from) => service.request(op, from),
		stop: async () => {
			await service.stop();
			await client.disconnect();
		},
	};
	world.stoppers.push(server.stop);
	if (o.start !== false) server.ready = service.start();
	return server;
}
