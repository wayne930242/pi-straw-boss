import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { herdrWatch } from "../src/server-watch.ts";
import { until } from "./fakes.ts";

const dir = mkdtempSync(join(tmpdir(), "psb-watch-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const FAST = [5, 10];
const ack = (id: string) => `${JSON.stringify({ id, result: { type: "subscription_started" } })}\n`;

/** A fake Herdr server on a socket path: it answers `events.subscribe` as Herdr does and keeps the connection open. `stop` is a server stop, `start` a new server on the same path. */
class FakeServer {
	path = join(dir, `herdr-${Math.random().toString(36).slice(2)}.sock`);
	requests: { method: string; params: unknown }[] = [];
	sockets = new Set<Socket>();
	answer = (id: string, socket: Socket) => void socket.write(ack(id));
	private server?: Server;
	start(): Promise<void> {
		this.server = createServer((socket) => {
			this.sockets.add(socket);
			let text = "";
			socket.on("data", (chunk) => {
				text += chunk;
				if (!text.includes("\n")) return;
				const request = JSON.parse(text.split("\n")[0]!);
				text = "";
				this.requests.push({ method: request.method, params: request.params });
				this.answer(request.id, socket);
			});
			socket.on("close", () => this.sockets.delete(socket));
			socket.on("error", () => {});
		});
		return new Promise((resolve) => this.server!.listen(this.path, resolve));
	}
	async stop(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise<void>((resolve) => this.server!.close(() => resolve()));
	}
}

let server = new FakeServer();
const stops: (() => void)[] = [];
afterEach(async () => {
	stops.splice(0).forEach((stop) => stop());
	await server.stop().catch(() => {});
	server = new FakeServer();
});
const watch = (onTakeover: () => void, retry = FAST) => (stops.push(herdrWatch(server.path, retry)(onTakeover)), stops.at(-1)!);

test("the first connection subscribes to a rare event and is not a takeover; the open connection then stays quiet", async () => {
	await server.start();
	let takeovers = 0;
	watch(() => takeovers++);
	await until(() => server.requests.length === 1, "the subscription");
	assert.deepEqual(server.requests, [{ method: "events.subscribe", params: { subscriptions: [{ type: "workspace.renamed" }] } }]);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual([takeovers, server.requests.length, server.sockets.size], [0, 1, 1]);
});

test("a server that stops and starts again is a takeover, once, however long the new one takes to come up", async () => {
	await server.start();
	let takeovers = 0;
	watch(() => takeovers++);
	await until(() => server.requests.length === 1, "the subscription");
	await server.stop();
	await new Promise((resolve) => setTimeout(resolve, 60)); // several refused attempts: the path has no server
	assert.equal(takeovers, 0, "no server, no takeover");
	await server.start();
	await until(() => takeovers === 1, "the takeover");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual([takeovers, server.requests.length], [1, 2], "one more subscription, and no further attempts");
});

test("a watch whose first attempt found no server calls the takeover when one appears", async () => {
	let takeovers = 0;
	watch(() => takeovers++);
	await new Promise((resolve) => setTimeout(resolve, 30));
	await server.start();
	await until(() => takeovers === 1, "the takeover");
});

test("an acknowledgement split across reads counts, events after it are dropped, and an error reply or a bad frame retries", async () => {
	let attempts = 0, takeovers = 0;
	server.answer = (id, socket) => {
		attempts++;
		if (attempts === 1) socket.write(`${JSON.stringify({ id, error: { code: "unknown_method", message: "no" } })}\n`);
		else if (attempts === 2) socket.write("not json\n");
		else {
			const frame = ack(id);
			socket.write(frame.slice(0, 20));
			setTimeout(() => socket.write(`${frame.slice(20)}${JSON.stringify({ event: "workspace_renamed", data: {} })}\n`), 10);
		}
	};
	await server.start();
	watch(() => takeovers++);
	await until(() => attempts === 3, "the third attempt");
	await new Promise((resolve) => setTimeout(resolve, 60));
	// The first attempt (an error reply) was the watch's first, so the acknowledged one is a takeover: the watch cannot tell a refusal from a server it has not yet heard.
	assert.deepEqual([takeovers, attempts, server.sockets.size], [1, 3, 1]);
});

test("stop closes the connection, cancels the retry, and a later server sees nothing", async () => {
	await server.start();
	let takeovers = 0;
	const stop = watch(() => takeovers++);
	await until(() => server.requests.length === 1, "the subscription");
	await server.stop();
	stop();
	stop(); // idempotent
	await server.start();
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.deepEqual([takeovers, server.requests.length, server.sockets.size], [0, 1, 0], "the new server was never asked");
});

test("stop while connected closes the socket on the server's side", async () => {
	await server.start();
	const stop = watch(() => {});
	await until(() => server.sockets.size === 1, "the connection");
	stop();
	await until(() => server.sockets.size === 0, "the connection to close");
});

test("a watch does not keep the process alive: neither its socket nor its retry timer", async () => {
	await server.start();
	const { execFileSync } = await import("node:child_process");
	const src = new URL("../src/server-watch.ts", import.meta.url).pathname;
	const script = `import { herdrWatch } from ${JSON.stringify(src)}; herdrWatch(${JSON.stringify(server.path)})(() => {}); await new Promise((r) => setTimeout(r, 100));`;
	execFileSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 });
	await server.stop();
	const down = `import { herdrWatch } from ${JSON.stringify(src)}; herdrWatch(${JSON.stringify(server.path)})(() => {});`;
	execFileSync(process.execPath, ["--input-type=module", "-e", down], { timeout: 5000 });
});
