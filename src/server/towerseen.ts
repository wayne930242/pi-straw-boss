import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Slot } from "./record.ts";
import { ensureDir, readQueue, type QueuedEvent, towerDir, writeDurableText } from "./towerstore.ts";

// The intercom messages a tower service has taken, for dedupe (docs/specs/2026-10-26-sb-backend.md, Queueing and concurrency, Dedupe). `seen.jsonl` keeps, per taken message, the sender id, the base
// message id (a retry's `~r<n>` removed: Straw Boss's sender retries every failed send to a tower identity under `<request id>~r<n>`), and the SHA-256 of its text. Entries are kept 48 h, longer than the
// broker's mailbox, and at most 5,000 per workspace, oldest out first.
//   - a message whose sender, base id, and hash are there is a retry already taken: it is not queued again, and still gets its `queued` receipt so the sender's retry ends;
//   - the same sender and base id with another hash is not a retry (pi-intercom refuses an exact id reused with other content, but `x~r1` is another id to it): it is dropped and logged.
// B4 wrote no `seen.jsonl`, kept the `~r<n>` in the ids it queued, and may hold events a day old, so the file is seeded from the queue when the service starts.

export const SEEN_KEEP_MS = 48 * 3600_000;
export const SEEN_MAX = 5000;
/** The file may hold this many lines more than the cap before it is rewritten (the memory is exact at once): a rewrite of 5,000 lines at every message past the cap would cost a flush of the whole file each time. */
const SLACK = 500;
const FILE = "seen.jsonl";

/** The id a retry's `~r<n>` is taken from. */
export const baseId = (messageId: string) => messageId.replace(/~r\d+$/, "");
export const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");
export interface SeenRow { from: string; base: string; hash: string; at: number }
export type Verdict = "new" | "seen" | "conflict";

export interface Seen {
	/** Whether a message is new, a retry of one taken, or the same id with other content. */
	check(from: string, messageId: string, text: string): Verdict;
	/** Records a message as taken (after its event is on disk). */
	add(from: string, messageId: string, text: string, at?: number): void;
	size(): number;
}

const key = (from: string, base: string) => `${from}\n${base}`;
const parse = (line: string): SeenRow | undefined => {
	try {
		const v = JSON.parse(line) as Partial<SeenRow>;
		return typeof v.from === "string" && typeof v.base === "string" && typeof v.hash === "string" && typeof v.at === "number" ? { from: v.from, base: v.base, hash: v.hash, at: v.at } : undefined;
	} catch {
		return undefined;
	}
};

/** The dedupe state of one workspace: the file read, the queue's intercom events added to it, old and surplus entries dropped. */
export function openSeen(slot: Slot, workspace: string, now: () => number): Seen {
	const file = join(towerDir(slot, workspace), FILE);
	const rows = new Map<string, SeenRow>();
	let text = "", lines = 0;
	try {
		text = readFileSync(file, "utf8");
	} catch { /* none yet */ }
	for (const line of text.split("\n")) {
		const row = line ? parse(line) : undefined;
		if (row) (rows.set(key(row.from, row.base), row), lines++);
	}
	// What the queue holds was taken whether or not a line says so (B4 wrote none; a crash between the event and its line leaves none).
	let added = false;
	for (const event of [...readQueue(slot, workspace), ...readQueue(slot, workspace, true)]) {
		if (event.kind !== "intercom" || !event.messageId || !event.from) continue;
		const base = baseId(event.messageId), k = key(event.from.id, base);
		if (rows.has(k)) continue;
		rows.set(k, { from: event.from.id, base, hash: hashOf(event.text), at: Date.parse(event.at) || now() });
		added = true;
	}
	const trim = () => {
		let dropped = false;
		for (const [k, row] of rows) if (now() - row.at > SEEN_KEEP_MS) (rows.delete(k), (dropped = true));
		while (rows.size > SEEN_MAX) (rows.delete(rows.keys().next().value!), (dropped = true));
		return dropped;
	};
	const rewrite = () => {
		ensureDir(towerDir(slot, workspace));
		writeDurableText(file, [...rows.values()].map((r) => JSON.stringify(r)).join("\n") + (rows.size ? "\n" : ""));
		lines = rows.size;
	};
	if (trim() || added) {
		try {
			rewrite();
		} catch { /* the next add writes it again */ }
	}
	return {
		check(from, messageId, body) {
			const found = rows.get(key(from, baseId(messageId)));
			return !found ? "new" : found.hash === hashOf(body) ? "seen" : "conflict";
		},
		add(from, messageId, body, at = now()) {
			const row: SeenRow = { from, base: baseId(messageId), hash: hashOf(body), at };
			rows.delete(key(from, row.base));
			rows.set(key(from, row.base), row);
			trim();
			if (lines >= SEEN_MAX + SLACK) return rewrite();
			lines++;
			ensureDir(towerDir(slot, workspace));
			// Not flushed: the event itself was (the queue file is what a crash must not lose, and `openSeen` seeds this file from it), and a process that is killed leaves the write in the kernel's cache.
			appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
		},
		size: () => rows.size,
	};
}
export type { QueuedEvent };
