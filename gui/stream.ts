import type { Net } from "../src/net.ts";
import { m } from "./paraglide/messages.js";

// The page's connection to the net: one live stream that is judged by what it delivers, not by its readyState, because a
// background tab can be throttled or frozen and the stream may drop without an error. The server sends the full snapshot on
// connect and a `ping` event every 15 s; the page treats 45 s of silence as dead, and on coming back to the foreground
// reconnects when the stream is closed or has been quiet for 20 s, to get a fresh full snapshot instead of replaying what it missed.

export const WATCHDOG_MS = 45_000;
export const STALE_MS = 20_000;
export const BASE_MS = 1000;
export const MAX_MS = 30_000;
export const MAX_ATTEMPTS = 8;

/** The part of EventSource the stream uses, so tests and the dev fixture can stand in for it. */
export interface Source {
	onError(handler: () => void): void;
	listen(type: string, handler: (data: string) => void): void;
	close(): void;
}
export interface Status {
	/** connecting: first attempt; live: messages arrive; reconnecting: waiting to retry; offline: gave up until the page is used again. */
	state: "connecting" | "live" | "reconnecting" | "offline";
	attempt: number;
	/** When the server was last heard from (a snapshot or a ping). */
	lastContact?: number;
	/** The server's reason when the stream is up but the net cannot be read. */
	problem?: string;
}
export interface Deps {
	open(): Source;
	now(): number;
	setTimeout(run: () => void, ms: number): number;
	clearTimeout(id: number | undefined): void;
	random(): number;
	hidden(): boolean;
	onNet(net: Net): void;
	onStatus(status: Status): void;
}
export interface Stream { start(): void; resume(): void; restart(): void; hide(): void; stop(): void }

/** The delay before retry number `attempt` (1-based): 1 s doubling to 30 s, spread by ±20 % so tabs do not retry in step. */
export const backoff = (attempt: number, random: number) => Math.min(MAX_MS, BASE_MS * 2 ** (attempt - 1)) * (0.8 + 0.4 * random);

function parse<T>(data: string): T | undefined {
	try {
		return JSON.parse(data) as T;
	} catch {
		return undefined;
	}
}

export function createStream(deps: Deps): Stream {
	let source: Source | undefined, retry: number | undefined, watchdog: number | undefined, startedAt = 0;
	let status: Status = { state: "connecting", attempt: 0 };
	const set = (next: Partial<Status>) => deps.onStatus((status = { ...status, ...next }));
	const clear = () => (deps.clearTimeout(retry), deps.clearTimeout(watchdog), (retry = watchdog = undefined));
	const close = () => {
		const old = source;
		source = undefined;
		old?.close();
	};
	const heard = () => {
		deps.clearTimeout(watchdog);
		watchdog = deps.setTimeout(() => lost(), WATCHDOG_MS);
		set({ state: "live", attempt: 0, lastContact: deps.now() });
	};
	// The stream is gone: retry with backoff, or give up past the limit. A hidden page waits for resume() instead of holding a retry timer.
	const lost = () => {
		close();
		clear();
		const attempt = status.attempt + 1;
		if (attempt > MAX_ATTEMPTS) return set({ state: "offline", attempt });
		set({ state: "reconnecting", attempt });
		if (!deps.hidden()) retry = deps.setTimeout(connect, backoff(attempt, deps.random()));
	};
	const connect = () => {
		close();
		clear();
		startedAt = deps.now();
		const mine = (source = deps.open());
		mine.onError(() => source === mine && lost());
		mine.listen("message", (data) => {
			if (source !== mine) return;
			const net = parse<Net>(data);
			if (net) deps.onNet(net);
			set({ problem: net ? undefined : m.problem_snapshot() });
			heard();
		});
		mine.listen("ping", () => source === mine && heard());
		mine.listen("problem", (data) => {
			if (source !== mine) return;
			set({ problem: parse<string>(data) ?? m.problem_unknown() });
			heard();
		});
		// A first attempt that never answers is caught by the same watchdog.
		watchdog = deps.setTimeout(() => lost(), WATCHDOG_MS);
	};
	return {
		start() {
			set({ state: "connecting", attempt: 0 });
			connect();
		},
		// Focus, visible, pageshow, and online all land here, often together. Reconnect at once with a fresh attempt count unless
		// the stream is healthy (heard from within 20 s) or an attempt only just began.
		resume() {
			const fresh = deps.now() - startedAt < 2000 || (status.lastContact !== undefined && deps.now() - status.lastContact <= STALE_MS);
			if (source && fresh) return;
			set({ attempt: 0, state: status.state === "live" ? "reconnecting" : status.state });
			connect();
		},
		// A route that watches something else, or a history that has to be fetched again, opens a new connection at once.
		restart: connect,
		// A hidden page keeps the watchdog but no retry timer.
		hide() {
			deps.clearTimeout(retry);
			retry = undefined;
		},
		stop() {
			close();
			clear();
		},
	};
}
