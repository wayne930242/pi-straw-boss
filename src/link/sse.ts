import { Buffer } from "node:buffer";
import { CanonError } from "./canon.ts";
import { parseEnvelope, type Envelope } from "./envelope.ts";
import { ProtocolError, RelayError } from "./errors.ts";
import { entryHash, decodeEntry, type RosterEntry } from "./roster.ts";
import { exponentialBackoff, retryAfterMs, sleep as realSleep, type Backoff, type Sleep } from "./retry.ts";

// The server-sent event stream of a team (docs/specs/2026-10-25-straw-link.md, Relay; the relay's README, Events): a parser for the wire
// format, and a reader that keeps one stream open on fetch, resumes it with Last-Event-ID, reconnects with backoff, gives up on a dead
// connection when the keepalive stops, and ends cleanly on abort.

export interface SseMessage { id?: string; event: string; data: string }

/** The most a line, or the data of an event not yet dispatched, may hold: the relay's events are well under it, and a stream that sends more is broken or hostile. */
const MAX_EVENT_CHARS = 1024 * 1024;

/**
 * The SSE line format (WHATWG HTML, Server-sent events): `field: value` lines, a blank line dispatches (when there is data), `:` lines are
 * comments. Feed it text in any chunking. The `retry:` field is ignored: reconnection timing is this client's backoff. `push` throws a
 * `ProtocolError` (`event-too-large`) when a line or an event's data passes 1 MiB, so the reader drops the connection and reconnects.
 */
export class SseParser {
	private buf = "";
	private started = false;
	private skipLf = false;
	private data: string[] = [];
	private dataChars = 0;
	private event = "";
	private id: string | undefined;

	/** The messages completed by `text`, and whether it carried a comment (a keepalive). */
	push(text: string): { messages: SseMessage[]; comments: number } {
		let chunk = text;
		if (!this.started && chunk.length > 0) {
			this.started = true;
			if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
		}
		// A CR at the end of the last chunk ended a line; the LF of its CRLF, if it comes, is the first byte of this one.
		if (this.skipLf && chunk.length > 0) {
			this.skipLf = false;
			if (chunk.startsWith("\n")) chunk = chunk.slice(1);
		}
		this.buf += chunk;
		const out = { messages: [] as SseMessage[], comments: 0 }, ends = /\r\n|\r|\n/g;
		let at = 0;
		for (let m = ends.exec(this.buf); m; m = ends.exec(this.buf)) {
			this.line(this.buf.slice(at, m.index), out);
			at = m.index + m[0].length;
			if (m[0] === "\r" && at === this.buf.length) this.skipLf = true;
		}
		this.buf = this.buf.slice(at);
		if (this.buf.length + this.dataChars > MAX_EVENT_CHARS) throw new ProtocolError(200, "event-too-large");
		return out;
	}

	private line(line: string, out: { messages: SseMessage[]; comments: number }) {
		if (line === "") {
			if (this.data.length > 0) out.messages.push({ ...(this.id !== undefined ? { id: this.id } : {}), event: this.event || "message", data: this.data.join("\n") });
			this.data = [];
			this.dataChars = 0;
			this.event = "";
			return;
		}
		if (line.startsWith(":")) {
			out.comments++;
			return;
		}
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "data") {
			this.data.push(value);
			this.dataChars += value.length + 1;
		}
		else if (field === "event") this.event = value;
		else if (field === "id" && !value.includes("\0")) this.id = value;
	}
}

// ---- Relay events --------------------------------------------------------------------------------------------------------------------

/** A roster entry the relay streams. */
export interface RosterEvent { type: "roster"; eid: number; seq: number; hash: Buffer; entry: RosterEntry }
/** An envelope addressed to this device; `ephemeral` ones (presence, unit status) are never queued and never acknowledged. */
export interface EnvelopeEvent { type: "envelope"; eid: number; id: Buffer; from: string; ephemeral: boolean; envelope: Envelope }
/** A join request for one of this device's invites; `request` is the sealed blob for `openJoinRequest`. */
export interface JoinEvent { type: "join"; eid: number; hash: Buffer; request: Buffer }
/**
 * An event the relay framed wrongly: not JSON, a field out of shape, an entry or envelope that does not decode, a hash or id that does not match
 * its bytes. `id` is the envelope id when it was readable, so the handler can acknowledge garbage it will never use.
 */
export interface MalformedEvent { type: "malformed"; eid: number; name: string; reason: string; id?: Buffer }
export type RelayEvent = RosterEvent | EnvelopeEvent | JoinEvent | MalformedEvent;

/**
 * What a handler says about an event. For an envelope, `ack` means it is delivered to a tower or written to the inbox (or deliberately dropped by
 * the receive checks): only then does the reader queue an acknowledgement. `keep` means it cannot be delivered now, so stop taking from that sender: it
 * stays queued at the relay and comes again on the next stream. A later envelope from the same sender that is taken makes the kept one drop by the
 * seq guard when it returns.
 */
export type Disposition = "ack" | "keep";

const HEX16 = /^[0-9a-f]{32}$/, HEX32 = /^[0-9a-f]{64}$/;
const b64 = (s: unknown): Buffer | null => {
	if (typeof s !== "string") return null;
	const raw = Buffer.from(s, "base64url");
	return raw.toString("base64url") === s ? raw : null;
};
const malformed = (eid: number, name: string, reason: string, id?: Buffer): MalformedEvent => ({ type: "malformed", eid, name, reason, ...(id ? { id } : {}) });

/** The typed event of one SSE message, or null for a name this client does not know (a newer relay may add some). */
export function decodeRelayEvent(m: SseMessage): RelayEvent | null {
	if (m.event !== "roster" && m.event !== "envelope" && m.event !== "join") return null;
	const eid = m.id !== undefined && /^[0-9]+$/.test(m.id) ? Number(m.id) : NaN;
	if (!Number.isSafeInteger(eid)) return malformed(0, m.event, "no numeric id");
	let d: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(m.data);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return malformed(eid, m.event, "data is not an object");
		d = parsed as Record<string, unknown>;
	} catch {
		return malformed(eid, m.event, "data is not JSON");
	}
	if (m.event === "join") {
		const request = b64(d.request);
		return typeof d.hash === "string" && HEX32.test(d.hash) && request ? { type: "join", eid, hash: Buffer.from(d.hash, "hex"), request } : malformed(eid, "join", "fields out of shape");
	}
	if (m.event === "roster") {
		const raw = b64(d.entry);
		if (!raw || typeof d.hash !== "string" || !HEX32.test(d.hash) || !Number.isSafeInteger(d.seq)) return malformed(eid, "roster", "fields out of shape");
		try {
			const entry = decodeEntry(raw), hash = entryHash(entry);
			if (entry.seq !== d.seq) return malformed(eid, "roster", "seq does not match the entry");
			if (hash.toString("hex") !== d.hash) return malformed(eid, "roster", "hash does not match the entry");
			return { type: "roster", eid, seq: entry.seq, hash, entry };
		} catch (error) {
			if (error instanceof CanonError || error instanceof RangeError) return malformed(eid, "roster", "entry does not decode");
			throw error;
		}
	}
	const raw = b64(d.envelope), id = typeof d.id === "string" && HEX16.test(d.id) ? Buffer.from(d.id, "hex") : undefined;
	if (!raw || !id || typeof d.from !== "string" || typeof d.ephemeral !== "boolean") return malformed(eid, "envelope", "fields out of shape", id);
	const envelope = parseEnvelope(raw);
	if (!envelope) return malformed(eid, "envelope", "envelope does not decode", id);
	if (!envelope.header.id.equals(id)) return malformed(eid, "envelope", "id does not match the envelope", id);
	if (envelope.header.from !== d.from || envelope.header.ephemeral !== d.ephemeral) return malformed(eid, "envelope", "from or ephemeral flag does not match the envelope", id);
	return { type: "envelope", eid, id, from: d.from, ephemeral: d.ephemeral, envelope };
}

// ---- The reader ----------------------------------------------------------------------------------------------------------------------

export type StreamState =
	| { state: "connecting" }
	| { state: "open" }
	/** The connection ended or could not be made; the next try is in `delayMs`. */
	| { state: "retrying"; error: unknown; delayMs: number }
	| { state: "closed" };
/** Why a stream ended for good: the caller stopped it, the relay refused it (401: removed or not a member; 400, 403, 404), or its handler threw. */
export type StreamEnd = { reason: "stopped" } | { reason: "refused"; error: RelayError } | { reason: "failed"; error: unknown };

export interface EventStreamOptions {
	/** Opens one connection (the relay client's signed GET of the events URL) and throws a typed error on a non-2xx answer. */
	open: (lastEventId: number | undefined, signal: AbortSignal) => Promise<Response>;
	/** Called for each event in order, one at a time; the reader waits for it. */
	onEvent: (event: RelayEvent) => Disposition | void | Promise<Disposition | void>;
	/** Called with the id of an envelope the handler answered `ack` to. */
	onAck?: (id: Buffer) => void;
	/** Resume after this event id (the team file's last one). */
	lastEventId?: number;
	/** A connection with no bytes, not even a keepalive comment, for this long is dropped and reopened. The relay sends one every 25 s. */
	keepaliveTimeoutMs?: number;
	backoff?: Backoff;
	/** A connection that stayed open this long starts the backoff over. */
	stableMs?: number;
	sleep?: Sleep;
	onState?: (state: StreamState) => void;
}

const KEEPALIVE_TIMEOUT_MS = 70_000, STABLE_MS = 10_000;

export class EventStream {
	private readonly o: EventStreamOptions;
	private readonly controller = new AbortController();
	private cursor: number | undefined;
	private started: Promise<StreamEnd> | undefined;
	private doneBeforeStart: Promise<StreamEnd> | undefined;
	private settleDone: ((end: Promise<StreamEnd>) => void) | undefined;

	constructor(options: EventStreamOptions) {
		this.o = options;
		this.cursor = options.lastEventId;
	}

	/** The id of the last event the handler finished with: what the team file saves, and what the next connection resumes from. */
	get lastEventId(): number | undefined {
		return this.cursor;
	}

	/** Settles once, with why the stream ended; never rejects. Reading it does not open the stream: if `start()` has not run, it settles after it does. */
	get done(): Promise<StreamEnd> {
		if (this.started) return this.started;
		this.doneBeforeStart ??= new Promise((resolve) => {
			this.settleDone = resolve;
		});
		return this.doneBeforeStart;
	}

	/** Opens the stream; calling it again returns the same run. */
	start(): Promise<StreamEnd> {
		if (!this.started) {
			this.started = this.run();
			this.settleDone?.(this.started);
		}
		return this.started;
	}

	/** Aborts the connection and any wait, and resolves when the loop has ended. */
	async stop(): Promise<StreamEnd> {
		this.controller.abort();
		return this.start();
	}

	private state(s: StreamState) {
		this.o.onState?.(s);
	}

	private async run(): Promise<StreamEnd> {
		const { signal } = this.controller, backoff = this.o.backoff ?? exponentialBackoff(), sleep = this.o.sleep ?? realSleep;
		let attempt = 0;
		try {
			while (!signal.aborted) {
				this.state({ state: "connecting" });
				const openedAt = Date.now();
				let error: unknown;
				try {
					await this.connection();
				} catch (e) {
					if (signal.aborted) break;
					if (e instanceof HandlerFailure) return this.finish({ reason: "failed", error: e.cause });
					if (refused(e)) return this.finish({ reason: "refused", error: e });
					error = e;
				}
				if (signal.aborted) break;
				attempt = Date.now() - openedAt >= (this.o.stableMs ?? STABLE_MS) ? 1 : attempt + 1;
				const delayMs = Math.max(backoff(attempt), retryAfterMs(error) ?? 0);
				this.state({ state: "retrying", error: error ?? new Error("the relay closed the stream"), delayMs });
				await sleep(delayMs, signal);
			}
			return this.finish({ reason: "stopped" });
		} catch (error) {
			return this.finish({ reason: "failed", error });
		}
	}

	private finish(end: StreamEnd): StreamEnd {
		this.controller.abort();
		this.state({ state: "closed" });
		return end;
	}

	/** One connection, to its end: the relay closed it (returns), it went quiet, it broke, or the caller aborted (throws). */
	private async connection(): Promise<void> {
		const outer = this.controller.signal, inner = new AbortController();
		const abort = () => inner.abort();
		outer.addEventListener("abort", abort, { once: true });
		const quiet = this.o.keepaliveTimeoutMs ?? KEEPALIVE_TIMEOUT_MS;
		let timer: NodeJS.Timeout | undefined;
		let timedOut = false;
		const arm = () => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				timedOut = true;
				inner.abort();
			}, quiet);
		};
		const disarm = () => clearTimeout(timer);
		try {
			arm();
			const response = await this.o.open(this.cursor, inner.signal);
			if (!response.body) throw new RelayError(response.status, "no-body");
			this.state({ state: "open" });
			const reader = response.body.getReader(), decoder = new TextDecoder("utf-8"), parser = new SseParser();
			try {
				for (;;) {
					arm();
					const { done, value } = await reader.read();
					disarm();
					if (done) return;
					const { messages } = parser.push(decoder.decode(value, { stream: true }));
					for (const message of messages) await this.dispatch(message);
				}
			} finally {
				disarm();
				reader.cancel().catch(() => undefined);
			}
		} catch (error) {
			if (timedOut && !outer.aborted) throw new RelayError(0, "keepalive-timeout", undefined, { cause: error });
			throw error;
		} finally {
			disarm();
			outer.removeEventListener("abort", abort);
			inner.abort();
		}
	}

	private async dispatch(message: SseMessage): Promise<void> {
		const event = decodeRelayEvent(message);
		if (!event) {
			this.advance(message.id);
			return;
		}
		let verdict: Disposition | void;
		try {
			verdict = await this.o.onEvent(event);
		} catch (cause) {
			throw new HandlerFailure(cause);
		}
		if (verdict === "ack") {
			if (event.type === "envelope" && !event.ephemeral) this.o.onAck?.(event.id);
			else if (event.type === "malformed" && event.id) this.o.onAck?.(event.id);
		}
		if (event.eid > 0) this.cursor = event.eid;
	}

	private advance(id: string | undefined) {
		if (id !== undefined && /^[0-9]+$/.test(id) && Number.isSafeInteger(Number(id))) this.cursor = Number(id);
	}
}

/** The handler threw: the stream ends rather than skip an event nobody handled. The handler's error is the `cause`. */
class HandlerFailure extends Error {
	constructor(cause: unknown) {
		super("event handler failed", { cause });
	}
}

/** An answer to the open that reconnecting cannot change: a client error other than a cap or a timeout (401 removed or not a member, 400, 403, 404). */
const refused = (error: unknown): error is RelayError => error instanceof RelayError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
