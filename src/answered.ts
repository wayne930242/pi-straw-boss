import { CONTROL, type Fields, fieldsOk, MAX_ANSWER, MAX_BLOCK, MAX_FIELDS } from "./documents.ts";

// Which blocks were answered (docs/specs/2026-11-07-better-show-host.md, "Answered"). The page used to remember it in its own browser storage, which meant that a restart of the server (a new capability), another device, or another address of
// this computer started again with every block open. The record is the server's now: one owned file (the caller's `save`, mode 600), read by every device. An answer is `pending` from the moment the server begins to send it and `done` with the fields
// that went once the owner took it; a block that is either is never begun again. Bounded (`max` entries, each field list cut) and pruned (`keepMs`; a pending entry never confirmed within `pendingMs` was not delivered, or was and told its page so).
// Nothing here reopens a block silently: a file that cannot be written refuses to begin, so nothing is sent; one that cannot be written after the send keeps the entry in memory and says so. A file that cannot be read (a link, another account's, not JSON, an entry out of the schema) starts the
// record empty and says so for the life of the process; the first write sets that file aside (`aside`) instead of replacing it, and the note stays, so no block answered before is taken for open without a word.

export type State = { state: "pending"; at: number } | { state: "done"; fields: Fields; at: number };
export type Begin = "ok" | "answered" | "pending" | "unsaved";
export interface AnsweredDeps {
	/** The file's text, undefined when there is none yet; it throws when it exists and cannot be read. */
	load(): string | undefined;
	/** Writes the whole file (mode 600, by rename); it throws when it cannot. */
	save(text: string): void;
	/** Moves the file that could not be read out of the way before the first write over it; it throws when it cannot, and then nothing is written. */
	aside?(): void;
	now?(): number;
	max?: number;
	keepMs?: number;
	pendingMs?: number;
}
export interface Answered {
	get(key: string): State | undefined;
	/** Takes a block for sending: `ok`, or why not (`answered`, `pending`, `unsaved`: the file could not be written, so nothing is to be sent). */
	begin(key: string): Begin;
	/** The owner took the answer; false when the record could not be written (it stays in memory). */
	done(key: string, fields: Fields): boolean;
	/** The answer did not go: the block is open again. A finished answer is not cancelled. */
	cancel(key: string): void;
	/** The entries of one session's `chat` or `doc` blocks, oldest first. */
	list(kind: "chat" | "doc", unit: string): [string, State][];
	/** The file could not be read when it was opened (a missing file is a new record, not this); it stays set for the life of the process. */
	readonly unreadable: boolean;
}

export const MAX_ENTRIES = 2000, KEEP_MS = 90 * 24 * 3_600_000, PENDING_MS = 120_000;
/** A key is a JSON array, so no part can move a boundary: a chat block is its session, the message's entry id, and its index; a document block its owner, its name, the hash of the text it was answered in, and its index. */
export const chatKey = (unit: string, entry: string, index: number) => JSON.stringify(["chat", unit, entry, index]);
export const docKey = (unit: string, name: string, rev: string, index: number) => JSON.stringify(["doc", unit, name, rev, index]);
// A grouped review carries its visible group name in the field key; keep the full PBS field length on reload.
const clip = (fields: Fields): Fields => fields.slice(0, MAX_FIELDS).map(([name, value]) => [name.slice(0, name.startsWith("picked:") ? 1024 : 256), value.slice(0, 1024)]);
const HASH = /^[0-9a-f]{16}$/, MAX_PART = 4096;
const part = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_PART;
const index = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_BLOCK;
/** A key of this file's own making: `["chat", unit, entry, index]` or `["doc", unit, name, hash, index]`. */
function keyOk(key: unknown): key is string {
	if (typeof key !== "string") return false;
	let k: unknown;
	try {
		k = JSON.parse(key);
	} catch {
		return false;
	}
	return Array.isArray(k) && ((k[0] === "chat" && k.length === 4 && part(k[1]) && part(k[2]) && index(k[3])) || (k[0] === "doc" && k.length === 5 && part(k[1]) && part(k[2]) && typeof k[3] === "string" && HASH.test(k[3]) && index(k[4])));
}
/** A state as this file writes it, its time clamped to `now` (an entry from the future would never expire); undefined when it is out of shape. */
const stateOf = (v: unknown, now: number): State | undefined => {
	const s = v as Partial<{ state: unknown; fields: unknown; at: unknown }> | null;
	if (typeof s !== "object" || s === null || !Number.isSafeInteger(s.at) || (s.at as number) < 0) return;
	const at = Math.min(s.at as number, now);
	if (s.state === "pending") return { state: "pending", at };
	if (s.state === "done" && Array.isArray(s.fields) && s.fields.every((f) => Array.isArray(f) && f.length === 2 && typeof f[0] === "string" && typeof f[1] === "string")) return { state: "done", fields: clip(s.fields as Fields), at };
};

export function createAnswered({ load, save, aside, now = Date.now, max = MAX_ENTRIES, keepMs = KEEP_MS, pendingMs = PENDING_MS }: AnsweredDeps): Answered {
	const entries = new Map<string, State>();
	let unreadable = false, asided = false;
	try {
		const text = load();
		if (text !== undefined) {
			const parsed = JSON.parse(text) as { v?: unknown; entries?: unknown };
			if (parsed.v !== 1 || !Array.isArray(parsed.entries)) throw new Error("not a record");
			const t = now();
			for (const e of parsed.entries) {
				const state = Array.isArray(e) && e.length === 2 && keyOk(e[0]) ? stateOf(e[1], t) : undefined;
				if (!state) throw new Error("an entry out of shape"); // a record this code wrote has none: it was changed, so none of it is trusted
				if (t - state.at <= keepMs) entries.set((e as [string, unknown])[0], state);
			}
		}
	} catch {
		entries.clear();
		unreadable = true;
	}
	const text = () => JSON.stringify({ v: 1, entries: [...entries] });
	/** Writes the record, after dropping the oldest past `max`. */
	const write = () => {
		for (const key of entries.keys()) if (entries.size > max) entries.delete(key);
		if (unreadable && !asided) (aside?.(), (asided = true)); // the file we could not read is kept, not replaced
		save(text());
	};
	const read = (key: string) => {
		const state = entries.get(key);
		if (state?.state === "pending" && now() - state.at > pendingMs) return void entries.delete(key);
		return state;
	};
	return {
		get: read,
		begin(key) {
			const had = read(key);
			if (had) return had.state === "done" ? "answered" : "pending";
			entries.set(key, { state: "pending", at: now() });
			try {
				write();
			} catch {
				entries.delete(key);
				return "unsaved";
			}
			return "ok";
		},
		done(key, fields) {
			entries.delete(key); // newest last
			entries.set(key, { state: "done", fields: clip(fields), at: now() });
			try {
				write();
				return true;
			} catch {
				return false;
			}
		},
		cancel(key) {
			if (entries.get(key)?.state !== "pending") return;
			entries.delete(key);
			try {
				write();
			} catch {
				// the entry is gone from memory; the file still holds a pending one, which expires
			}
		},
		list(kind, unit) {
			return [...entries].filter(([key, state]) => {
				if (state.state === "pending" && now() - state.at > pendingMs) return false;
				try {
					const k = JSON.parse(key) as unknown[];
					return k[0] === kind && k[1] === unit;
				} catch {
					return false;
				}
			});
		},
		get unreadable() {
			return unreadable;
		},
	};
}

/** GET api/answered/<unit key>: the unit's chat blocks that are answered (`[entry, index, fields]`) or on their way (`[entry, index]`), for the page to lock them with. */
export function answeredOf(store: Answered, unit: string): { status: number; body: unknown } {
	const rows = store.list("chat", unit).map(([key, state]) => [JSON.parse(key) as [string, string, string, number], state] as const);
	return { status: 200, body: { done: rows.flatMap(([k, s]) => (s.state === "done" ? [[k[2], k[3], s.fields]] : [])), pending: rows.filter(([, s]) => s.state === "pending").map(([k]) => [k[2], k[3]]), unreadable: store.unreadable } };
}

type Reply = { status: number; body: unknown };
const refuse = (status: number, error: string, reason: string, extra: object = {}): Reply => ({ status, body: { error, reason, ...extra } });
/**
 * A chat block's answer is the boss's message, posted to `sessions/<key>/input` with `block {entry, index, fields}`: the block is begun in the record before the message goes through `send` (the very request, with every guard it has), done once a
 * 2xx came back, cancelled for any other answer but "not confirmed" (504: it may have gone, so it stays pending until it expires). A block that is answered or on its way is refused, with the fields that went.
 */
export async function recordBlock(store: Answered, unit: string, json: Record<string, unknown>, send: (json: Record<string, unknown>) => Promise<Reply>): Promise<Reply> {
	const { block, ...rest } = json, b = block as { entry?: unknown; index?: unknown; fields?: unknown } | null;
	if (typeof b !== "object" || b === null || typeof b.entry !== "string" || !b.entry || b.entry.length > 128 || CONTROL.test(b.entry) || !Number.isInteger(b.index) || (b.index as number) < 0 || (b.index as number) > 4095 || !fieldsOk(b.fields) || b.fields.some(([name, value]) => CONTROL.test(name) || CONTROL.test(value)) || Buffer.byteLength(JSON.stringify(b.fields)) > MAX_ANSWER)
		return refuse(400, "bad_request", "A block names its message (an entry id) and its index, and the text fields that went: at most 65 (the reserved pi-note counts), under 12 KB, with no control characters.");
	const key = chatKey(unit, b.entry, b.index as number), begun = store.begin(key);
	if (begun === "answered") return refuse(409, "answered", "This block was answered already.", { fields: (store.get(key) as { fields?: Fields } | undefined)?.fields ?? [] });
	if (begun === "pending") return refuse(409, "pending", "This block's answer is on its way.");
	if (begun === "unsaved") return refuse(500, "unsaved", "This server could not write down the answer, so nothing was sent.");
	let reply: Reply;
	try {
		reply = await send(rest);
	} catch (error) {
		store.cancel(key);
		throw error;
	}
	if (reply.status >= 200 && reply.status < 300) return store.done(key, b.fields) ? reply : { ...reply, body: { ...(reply.body as object), unsaved: true } };
	if (reply.status !== 504) store.cancel(key);
	return reply;
}
