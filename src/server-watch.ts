import { createConnection, type Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";
import { herdrSocket, localEndpoint } from "./endpoint.ts";

/** Starts watching the Herdr server; `onTakeover` runs each time a server answers again after the one watched went away, and `onLost` when a server that had answered stops (its connection closes). Returns the stop function. */
export type HerdrWatch = (onTakeover: () => void, onLost?: () => void) => () => void;

const RETRY_MS = [250, 500, 1000, 2000];
const ACK_MS = 5000;

/**
 * One `events.subscribe` connection kept open on Herdr's socket, for what its closing says: the server it was open to has stopped, and the
 * tokens it held in memory are gone. The subscription asks for `workspace.renamed`, which almost never happens, so the open connection carries
 * no traffic. When it closes (or the first attempt finds no server) the watch reconnects after 0.25 s, 0.5 s, 1 s, then every 2 s, and when a server
 * acknowledges the subscription it calls `onTakeover` once. The first connection of a watch, which finds the server the session started in, does not.
 * The socket and the retry timer never keep pi alive; `stop` ends both.
 */
export const herdrWatch = (socketPath = herdrSocket(), retryMs = RETRY_MS): HerdrWatch => (onTakeover, onLost) => {
	let socket: Socket | undefined, timer: ReturnType<typeof setTimeout> | undefined, stopped = false, initial = true, retries = 0;
	const attempt = () => {
		const first = initial, text = new StringDecoder("utf8");
		let acked = false, ended = false, head = "";
		initial = false;
		const end = () => {
			if (ended) return;
			ended = true;
			current.destroy();
			if (acked && !stopped) onLost?.();
			if (!stopped) timer = setTimeout(attempt, retryMs[Math.min(retries++, retryMs.length - 1)]).unref();
		};
		const current = (socket = createConnection(localEndpoint(socketPath)).setTimeout(ACK_MS));
		current.unref();
		current.on("connect", () => current.write(`${JSON.stringify({ id: `straw-boss-watch-${Date.now()}`, method: "events.subscribe", params: { subscriptions: [{ type: "workspace.renamed" }] } })}\n`));
		current.on("data", (chunk) => {
			if (acked || ended) return; // events after the acknowledgement are not wanted: read them off the socket and drop them
			head += text.write(chunk);
			if (!head.includes("\n")) return;
			try {
				if ((JSON.parse(head.split("\n")[0]!) as { result?: { type?: string } }).result?.type !== "subscription_started") return end();
			} catch {
				return end();
			}
			acked = true;
			retries = 0;
			current.setTimeout(0);
			if (!first) onTakeover();
		});
		current.on("timeout", end);
		current.on("error", end);
		current.on("close", end);
	};
	attempt();
	return () => {
		stopped = true;
		clearTimeout(timer);
		socket?.destroy();
	};
};

/** Herdr's events of the given types, `onEvent` for each and `null` after every (re)connection, when some may have been missed. Returns the stop function. */
export type HerdrEvents = (types: string[], onEvent: (event: { event: string; data: Record<string, unknown> } | null) => void) => () => void;

/** One `events.subscribe` connection that reconnects like the watch above (0.25 s, 0.5 s, 1 s, then every 2 s) and never keeps pi alive. */
export const herdrEvents = (socketPath = herdrSocket(), retryMs = RETRY_MS): HerdrEvents => (types, onEvent) => {
	let socket: Socket | undefined, timer: ReturnType<typeof setTimeout> | undefined, stopped = false, retries = 0;
	const attempt = () => {
		const text = new StringDecoder("utf8");
		let acked = false, ended = false, buffer = "";
		const end = () => {
			if (ended) return;
			ended = true;
			current.destroy();
			if (!stopped) timer = setTimeout(attempt, retryMs[Math.min(retries++, retryMs.length - 1)]).unref();
		};
		const current = (socket = createConnection(localEndpoint(socketPath)).setTimeout(ACK_MS));
		current.unref();
		current.on("connect", () => current.write(`${JSON.stringify({ id: `straw-boss-events-${Date.now()}`, method: "events.subscribe", params: { subscriptions: types.map((type) => ({ type })) } })}\n`));
		current.on("data", (chunk) => {
			buffer += text.write(chunk);
			for (let at = buffer.indexOf("\n"); at >= 0 && !ended; at = buffer.indexOf("\n")) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				try {
					const frame = JSON.parse(line) as { result?: { type?: string }; event?: string; data?: Record<string, unknown> };
					if (!acked) {
						if (frame.result?.type !== "subscription_started") return end();
						[acked, retries] = [true, 0];
						current.setTimeout(0);
						onEvent(null);
					} else if (typeof frame.event === "string" && frame.data) onEvent({ event: frame.event, data: frame.data });
				} catch {
					return end();
				}
			}
		});
		current.on("timeout", end);
		current.on("error", end);
		current.on("close", end);
	};
	attempt();
	return () => {
		stopped = true;
		clearTimeout(timer);
		socket?.destroy();
	};
};
