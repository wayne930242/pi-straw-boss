import { Buffer } from "node:buffer";
import { CanonError } from "./canon.ts";
import { requestBytes, signBytes } from "./crypto.ts";
import type { DeviceKeys } from "./device.ts";
import { encodeEnvelope, type Envelope } from "./envelope.ts";
import { errorFor, NetworkError, ProtocolError, RelayError, UnauthorizedError, type Head } from "./errors.ts";
import { AckQueue } from "./outbox.ts";
import { sleep as realSleep, type Backoff, type Sleep } from "./retry.ts";
import { decodeEntry, encodeEntry, entryHash, type RosterEntry } from "./roster.ts";
import { EventStream, type Disposition, type RelayEvent, type StreamState } from "./sse.ts";

export * from "./errors.ts";

// The relay's HTTP API (docs/specs/2026-10-25-straw-link.md, Relay; ~/projects/straw-relay/README.md for the wire format). Every request but a
// join is signed with this device's key over `straw-link/request/1 ‖ team ‖ canonical(method, path with query, time, sha256(body))`. Fixed-size
// values (team ids, hashes, envelope ids) are hex on the wire; roster entries, envelopes, and join requests are base64url without padding.

export interface RelayClientOptions {
	/** The relay's origin, e.g. `https://link.example.org`. A path is refused: the relay verifies the request target it sees. */
	url: string;
	device: DeviceKeys;
	fetch?: typeof globalThis.fetch;
	/** Milliseconds since the epoch; the signature carries it and the relay accepts ±5 minutes. */
	now?: () => number;
	/** Longest a request (not a stream) may take, default 30 s. */
	timeoutMs?: number;
}

/** A roster entry as the relay lists it. */
export interface RosterRow { seq: number; hash: Buffer; entry: RosterEntry }
export interface PostResult {
	id: Buffer;
	/** The relay already had this envelope (a retry that landed twice). */
	duplicate: boolean;
	/** An ephemeral envelope no newer than the one the relay keeps. */
	stale: boolean;
}

const MAX_ACK_IDS = 500;
/** The most of an answer this client reads: the relay's ordinary and error bodies are tiny; a roster read can carry a whole team's log. */
const MAX_BODY_BYTES = 64 * 1024, MAX_ROSTER_BYTES = 16 * 1024 * 1024;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export class RelayClient {
	readonly url: string;
	readonly device: DeviceKeys;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly now: () => number;
	private readonly timeoutMs: number;

	constructor(o: RelayClientOptions) {
		const u = new URL(o.url);
		if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("the relay URL has to be http or https");
		if (u.pathname !== "/" || u.search || u.hash) throw new Error("the relay URL has to be an origin, without a path");
		this.url = u.origin;
		this.device = o.device;
		this.fetchFn = o.fetch ?? globalThis.fetch;
		this.now = o.now ?? Date.now;
		this.timeoutMs = o.timeoutMs ?? 30_000;
	}

	// ---- Teams and the roster ------------------------------------------------------------------------------------------------------------

	/** `POST /v1/teams`: a team from its `create` entry and the operator's token. Signed by the founder, so this client's device has to be the entry's signer. */
	async createTeam(o: { team: Uint8Array; token: string; entry: RosterEntry }, signal?: AbortSignal): Promise<Head> {
		const body = { team: hex(o.team), token: o.token, entry: b64(encodeEntry(o.entry)) };
		const out = await this.json("POST", "/v1/teams", o.team, body, signal);
		return this.head(out.head);
	}

	/** `GET …/roster?after=seq`: the entries after `after` (all when absent) and the head. Entries are decoded and their hashes and seqs checked. */
	async getRoster(team: Uint8Array, after?: number, signal?: AbortSignal): Promise<{ head: Head; entries: RosterRow[] }> {
		const target = `/v1/teams/${hex(team)}/roster${after === undefined ? "" : `?after=${after}`}`;
		const out = await this.json("GET", target, team, undefined, signal, MAX_ROSTER_BYTES);
		if (!Array.isArray(out.entries)) throw this.bad("entries is not a list");
		const entries = out.entries.map((row: unknown): RosterRow => {
			const r = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
			const raw = this.bytes(r.entry, "entry");
			try {
				const entry = decodeEntry(raw), hash = entryHash(entry);
				if (entry.seq !== r.seq) throw this.bad("an entry's seq does not match its bytes");
				if (hex(hash) !== r.hash) throw this.bad("an entry's hash does not match its bytes");
				return { seq: entry.seq, hash, entry };
			} catch (error) {
				if (error instanceof CanonError || error instanceof RangeError) throw this.bad("an entry does not decode", error);
				throw error;
			}
		});
		return { head: this.head(out.head), entries };
	}

	/**
	 * `POST …/roster`: an entry by compare and set on `prev`. A moved head is a `ConflictError` whose `head` says where the roster is; the caller
	 * fetches what it missed, rebuilds the entry on the new head, and posts again. A rule the relay checks is an `UnprocessableError` with the reason.
	 */
	async appendRoster(team: Uint8Array, entry: RosterEntry, signal?: AbortSignal): Promise<Head> {
		const out = await this.json("POST", `/v1/teams/${hex(team)}/roster`, team, { entry: b64(encodeEntry(entry)) }, signal);
		return this.head(out);
	}

	/**
	 * Polls the roster until this device is a member. A joiner is not one until the inviter's `add` lands, so the relay answers 401 `not-member`
	 * until then; any other refusal (a bad signature, a clock off by minutes) ends the wait with its error.
	 */
	async waitForMembership(team: Uint8Array, o: { intervalMs?: number; signal?: AbortSignal; sleep?: Sleep } = {}): Promise<{ head: Head; entries: RosterRow[] }> {
		const sleep = o.sleep ?? realSleep;
		for (;;) {
			try {
				return await this.getRoster(team, undefined, o.signal);
			} catch (error) {
				if (!(error instanceof UnauthorizedError && error.code === "not-member")) throw error;
			}
			await sleep(o.intervalMs ?? 2000, o.signal);
			o.signal?.throwIfAborted();
		}
	}

	// ---- Envelopes and acks --------------------------------------------------------------------------------------------------------------

	/** `POST …/envelopes`: an envelope (or its encoded bytes). 201, or 200 for an id the relay already holds. */
	async postEnvelope(team: Uint8Array, envelope: Envelope | Uint8Array, signal?: AbortSignal): Promise<PostResult> {
		const bytes = envelope instanceof Uint8Array ? envelope : encodeEnvelope(envelope);
		const out = await this.json("POST", `/v1/teams/${hex(team)}/envelopes`, team, { envelope: b64(bytes) }, signal);
		if (typeof out.id !== "string" || !/^[0-9a-f]{32}$/.test(out.id) || typeof out.duplicate !== "boolean") throw this.bad("an envelope answer out of shape");
		return { id: Buffer.from(out.id, "hex"), duplicate: out.duplicate, stale: out.stale === true };
	}

	/** `POST …/acks`: marks envelopes read by this device, 500 ids to a request. Returns how many deliveries the relay cleared. */
	async ack(team: Uint8Array, ids: Uint8Array[], signal?: AbortSignal): Promise<number> {
		let cleared = 0;
		for (let i = 0; i < ids.length; i += MAX_ACK_IDS) {
			const out = await this.json("POST", `/v1/teams/${hex(team)}/acks`, team, { ids: ids.slice(i, i + MAX_ACK_IDS).map(hex) }, signal);
			if (!Number.isSafeInteger(out.acked)) throw this.bad("an ack answer out of shape");
			cleared += out.acked as number;
		}
		return cleared;
	}

	// ---- Invites -------------------------------------------------------------------------------------------------------------------------

	/** `POST /v1/invites`: holds `sha256(invite secret)` until `expires` (ms), signed by an attended member. Returns the expiry. */
	async createInvite(o: { team: Uint8Array; hash: Uint8Array; expires: number }, signal?: AbortSignal): Promise<number> {
		const out = await this.json("POST", "/v1/invites", o.team, { team: hex(o.team), h: hex(o.hash), expires: o.expires }, signal);
		if (!Number.isSafeInteger(out.expires)) throw this.bad("an invite answer out of shape");
		return out.expires as number;
	}

	/** `POST /v1/invites/{h}/join`: a join request (`buildJoinRequest`'s bytes) for the invite whose hash is `hash`. Unsigned: the joiner is not a member yet. */
	async join(hash: Uint8Array, request: Uint8Array, signal?: AbortSignal): Promise<void> {
		await this.json("POST", `/v1/invites/${hex(hash)}/join`, undefined, { request: b64(request) }, signal);
	}

	async health(signal?: AbortSignal): Promise<boolean> {
		const out = await this.json("GET", "/healthz", undefined, undefined, signal);
		return out.ok === true;
	}

	// ---- Events --------------------------------------------------------------------------------------------------------------------------

	/** `GET …/events`: one signed connection, resumed after `lastEventId`. Throws the typed error for a non-2xx answer; the body is the open stream. */
	async openEvents(team: Uint8Array, lastEventId: number | undefined, signal: AbortSignal): Promise<Response> {
		const extra: Record<string, string> = lastEventId === undefined ? {} : { "Last-Event-ID": String(lastEventId) };
		const response = await this.send("GET", `/v1/teams/${hex(team)}/events`, team, undefined, signal, extra, false);
		if (!response.ok) throw await this.failure(response);
		return response;
	}

	/**
	 * The team's event stream with reconnection, and acknowledgements queued for what the handler says it delivered. `onEvent` is called in order,
	 * one event at a time; return `"ack"` for an envelope only once it is delivered to a tower or written to the inbox. Call `start()`, and `stop()`
	 * (which also flushes the acks it can) when done.
	 */
	stream(team: Uint8Array, o: {
		onEvent: (event: RelayEvent) => Disposition | void | Promise<Disposition | void>;
		lastEventId?: number;
		keepaliveTimeoutMs?: number;
		backoff?: Backoff;
		sleep?: Sleep;
		onState?: (state: StreamState) => void;
		onAckError?: (error: unknown) => void;
	}): ManagedStream {
		const acks = new AckQueue({ ack: (ids, signal) => this.ack(team, ids, signal).then(() => undefined), backoff: o.backoff, sleep: o.sleep, onError: o.onAckError });
		const events = new EventStream({ open: (id, signal) => this.openEvents(team, id, signal), onEvent: o.onEvent, onAck: (id) => acks.add(id), lastEventId: o.lastEventId, keepaliveTimeoutMs: o.keepaliveTimeoutMs, backoff: o.backoff, sleep: o.sleep, onState: o.onState });
		return new ManagedStream(events, acks);
	}

	// ---- Plumbing ------------------------------------------------------------------------------------------------------------------------

	/**
	 * One request. With a `team` it is signed (the signature binds that team, so a request meant for one team cannot be replayed at another); the
	 * body bytes signed are the bytes sent. `timed` bounds everything but a stream, whose open connection has no end.
	 */
	private async send(method: string, target: string, team: Uint8Array | undefined, body: unknown, signal: AbortSignal | undefined, extra: Record<string, string> = {}, timed = true): Promise<Response> {
		const bytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
		const headers: Record<string, string> = { ...extra };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (team) {
			const time = this.now();
			headers["X-Straw-Device"] = this.device.id;
			headers["X-Straw-Time"] = String(time);
			headers["X-Straw-Sig"] = signBytes(this.device.signKey, requestBytes({ team, method, path: target, time, body: bytes })).toString("hex");
		}
		const limit = timed ? AbortSignal.timeout(this.timeoutMs) : undefined;
		const both = [signal, limit].filter((s): s is AbortSignal => s !== undefined);
		const combined = both.length === 0 ? undefined : both.length === 1 ? both[0] : AbortSignal.any(both);
		try {
			return await this.fetchFn(this.url + target, { method, headers, body: bytes.length ? bytes : undefined, signal: combined });
		} catch (error) {
			if (signal?.aborted) throw signal.reason ?? error;
			throw new NetworkError(limit?.aborted ? `no answer within ${this.timeoutMs} ms` : `could not reach the relay: ${error instanceof Error ? error.message : String(error)}`, error);
		}
	}

	private async failure(response: Response): Promise<RelayError> {
		let body: unknown;
		try {
			body = JSON.parse(await this.text(response, MAX_BODY_BYTES));
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			body = undefined;
		}
		return errorFor(response.status, body, response.headers.get("retry-after"));
	}

	/** A request whose answer is a JSON object; a non-2xx answer throws its typed error. */
	private async json(method: string, target: string, team: Uint8Array | undefined, body: unknown, signal: AbortSignal | undefined, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
		const response = await this.send(method, target, team, body, signal);
		if (!response.ok) throw await this.failure(response);
		let text: string;
		try {
			text = await this.text(response, maxBytes);
		} catch (error) {
			if (error instanceof ProtocolError) throw error;
			if (signal?.aborted) throw signal.reason ?? error;
			throw new NetworkError("the answer was cut off", error);
		}
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		} catch {
			/* falls through */
		}
		throw this.bad("the answer is not a JSON object", undefined, response.status);
	}

	/** The body as text, read through a counter: past `max` bytes the read stops and the answer is a ProtocolError. */
	private async text(response: Response, max: number): Promise<string> {
		if (!response.body) return "";
		const reader = response.body.getReader(), chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				if (total > max) throw this.bad(`the answer is over ${max} bytes`, undefined, response.status);
				chunks.push(value);
			}
		} finally {
			reader.cancel().catch(() => undefined);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	private bad(message: string, cause?: unknown, status = 200): ProtocolError {
		return new ProtocolError(status, message, undefined, { cause });
	}

	private head(v: unknown): Head {
		const h = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
		if (!Number.isSafeInteger(h.seq) || typeof h.hash !== "string" || !/^[0-9a-f]{64}$/.test(h.hash)) throw this.bad("a head out of shape");
		return { seq: h.seq as number, hash: Buffer.from(h.hash, "hex") };
	}

	private bytes(v: unknown, what: string): Buffer {
		if (typeof v === "string") {
			const raw = Buffer.from(v, "base64url");
			if (raw.toString("base64url") === v) return raw;
		}
		throw this.bad(`${what} is not canonical base64url`);
	}
}

/** An event stream with its acknowledgement queue. */
export class ManagedStream {
	readonly events: EventStream;
	readonly acks: AckQueue;
	constructor(events: EventStream, acks: AckQueue) {
		this.events = events;
		this.acks = acks;
	}
	get lastEventId() {
		return this.events.lastEventId;
	}
	get done() {
		return this.events.done;
	}
	start() {
		return this.events.start();
	}
	/** Ends the stream, then sends the acknowledgements still waiting (once, no retries) so a clean stop does not redeliver what was handled. */
	async stop() {
		const end = await this.events.stop();
		await this.acks.stop();
		return end;
	}
}
