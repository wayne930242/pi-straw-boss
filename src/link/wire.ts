import { Buffer } from "node:buffer";

// What the sessions of one computer say to each other on the intercom extension channel `straw-boss/link` (docs/specs/2026-10-25-straw-link.md,
// Link holder). pi-intercom's broker refuses an extension payload over 16 KiB, so a request or answer that can be longer travels in chunks of
// base64 text; a delivery is only a pointer to an inbox file, because a message may hold 192 KB.
//
//   offer   holder → tower   {type, to: tower session, id: inbox id}        a message waits for you
//   taken   tower → holder   {type, to: holder session, id}                 it is in your session now: remove it from the inbox
//   req     tower → holder   {type, to, reqId, i, n, data}                  chunks of a JSON request ({op: "send" | "list", …})
//   res     holder → tower   {type, to, reqId, i, n, data}                  chunks of the JSON answer

export const NAMESPACE = "straw-boss/link";
/** Base64 characters per chunk: 9 KB of bytes, well under the 16 KiB payload limit with the envelope around it. */
export const CHUNK = 12_000;
/** The most a reassembled request or answer may hold, as base64 text: 192 KB of message text with its JSON around it. */
const MAX_TOTAL = 300_000, MAX_CHUNKS = 40;

export interface Chunk { type: "req" | "res"; version: 1; to: string; reqId: string; i: number; n: number; data: string }

/** The chunks of `body` as one JSON document. */
export function chunks(type: "req" | "res", to: string, reqId: string, body: unknown): Chunk[] {
	const text = Buffer.from(JSON.stringify(body), "utf8").toString("base64");
	const n = Math.max(1, Math.ceil(text.length / CHUNK));
	if (n > MAX_CHUNKS || text.length > MAX_TOTAL) throw new Error("The request is too large to hand to the link holder");
	return Array.from({ length: n }, (_, i) => ({ type, version: 1, to, reqId, i, n, data: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
}

const isChunk = (p: unknown): p is Chunk => {
	const c = p as Partial<Chunk> | undefined;
	return typeof c === "object" && c !== null && typeof c.reqId === "string" && c.reqId.length <= 80 && Number.isSafeInteger(c.i) && Number.isSafeInteger(c.n) && c.n! >= 1 && c.n! <= MAX_CHUNKS && c.i! >= 0 && c.i! < c.n! && typeof c.data === "string" && c.data.length <= CHUNK;
};

/** Collects chunks per sender and request; the last one gives the body. Incomplete requests older than `ttlMs` are forgotten. */
export class Reassembler {
	private readonly parts = new Map<string, { at: number; n: number; got: Map<number, string> }>();
	private readonly ttlMs: number;
	constructor(ttlMs = 60_000) {
		this.ttlMs = ttlMs;
	}
	/** The decoded body when this chunk completes a request; undefined while more are due or when the chunk is not well formed. */
	push(from: string, payload: unknown, now = Date.now()): { reqId: string; body: unknown } | undefined {
		for (const [key, entry] of this.parts) if (now - entry.at > this.ttlMs) this.parts.delete(key);
		if (!isChunk(payload)) return undefined;
		const key = `${from}/${payload.reqId}`, entry = this.parts.get(key) ?? { at: now, n: payload.n, got: new Map() };
		if (entry.n !== payload.n) return (this.parts.delete(key), undefined);
		entry.got.set(payload.i, payload.data);
		this.parts.set(key, entry);
		if (entry.got.size < entry.n) return undefined;
		this.parts.delete(key);
		const text = [...entry.got.entries()].sort(([a], [b]) => a - b).map(([, d]) => d).join("");
		if (text.length > MAX_TOTAL) return undefined;
		try {
			return { reqId: payload.reqId, body: JSON.parse(Buffer.from(text, "base64").toString("utf8")) as unknown };
		} catch {
			return undefined;
		}
	}
}
