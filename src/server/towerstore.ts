import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { LedgerRow } from "../opener.ts";
import { renameInto, secretDir, type Slot } from "./record.ts";

// What the tower service keeps on disk (docs/specs/2026-10-26-sb-backend.md, State): `tower/<workspace id>/` in the server's slot, mode 700, each file written by rename, mode 600.
// `service.json` (the identity, its pane and tab, and the next event sequence number), `queue/` (events that arrived for the identity, `queue/parked/` the ones a crash parked),
// `seen.jsonl` (the intercom messages taken, for dedupe), `runs/<run id>.json`, `notes.jsonl` (handoff notes), and `opened.json` (the opener's ledger).

/** A tower service that has no tab for 24 h is forgotten with its queue; events and ledger entries are kept this long. */
export const KEEP_MS = 24 * 3600_000;
/** The most events a workspace's queue holds: past it the oldest go first. B4 queues and nothing reads; B5 reads it (see the spec, Queueing and concurrency, B4's backlog). */
export const MAX_QUEUE = 1000;

export interface ServiceRecord {
	workspace: string;
	label: string;
	/** The tower identity's intercom id and name. */
	id: string;
	name: string;
	/** The standing pane and its tab. */
	pane: string;
	tab: string;
	/** The standing pane's folder: where a main the opener starts runs when the workspace has no checkout path. */
	cwd?: string;
	created: string;
	/** The next event sequence number. */
	seq: number;
	/** Set while a resident tower of an older build still holds the workspace: the identity is registered once that session leaves. */
	waiting?: true;
}
/** What wakes a run (the spec, Wake triggers): an intercom message, the boss typing into the tower, a notice the server raises, a follow-up the last run asked for. */
export type EventKind = "intercom" | "boss" | "notice" | "timer";
/** One event the service queued. */
export interface QueuedEvent {
	id: string;
	seq: number;
	kind: EventKind;
	/** The sender of an intercom message, or the boss. */
	from?: { id: string; name?: string };
	/** The text as received, its header included. */
	text: string;
	at: string;
	/** The broker's message id (intercom events). */
	messageId?: string;
	/** The run that has it in its session; it stays here until that run ends well, so a crash can give it back. */
	taken?: { run: string; at: string };
	/** Runs that crashed or timed out holding it: two park it. */
	crashes?: number;
	/** `crash` once a run that had it died: the next brief says so. */
	flag?: "crash";
}

/** A file name for a Herdr id: ids are short counters, but nothing a caller sends may leave the folder. */
export const safe = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, (c) => `.${c.charCodeAt(0).toString(16)}`);
export const towersDir = (slot: Slot) => join(slot.dir, "tower");
export const towerDir = (slot: Slot, workspace: string) => join(towersDir(slot), safe(workspace));
const SERVICE = "service.json", OPENED = "opened.json";

const readJson = <T>(file: string): T | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};
/** Written whole by rename, flushed to disk first: a reader never sees half a file, and a crash after the call loses nothing. */
export const writeDurable = (file: string, value: unknown): void => writeDurableText(file, JSON.stringify(value));
export function writeDurableText(file: string, text: string): void {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameInto(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
export const ensureDir = (dir: string) => {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
};

const isService = (value: unknown): value is ServiceRecord => {
	const v = value as Partial<ServiceRecord> | undefined;
	return typeof v === "object" && v !== null && typeof v.workspace === "string" && typeof v.id === "string" && typeof v.pane === "string" && typeof v.tab === "string" && typeof v.seq === "number";
};
export function readService(slot: Slot, workspace: string): ServiceRecord | undefined {
	const found = readJson<unknown>(join(towerDir(slot, workspace), SERVICE));
	return isService(found) ? found : undefined;
}
export function writeService(slot: Slot, service: ServiceRecord): void {
	secretDir(towersDir(slot));
	ensureDir(towerDir(slot, service.workspace));
	writeDurable(join(towerDir(slot, service.workspace), SERVICE), service);
}
/** Deletes `service.json` only: the queue stays for 24 h, so a tower reopened in that time gets it. */
export const deleteService = (slot: Slot, workspace: string) => rmSync(join(towerDir(slot, workspace), SERVICE), { force: true });
/** Every workspace that has a service record. */
export function listServices(slot: Slot): ServiceRecord[] {
	let names: string[] = [];
	try {
		names = readdirSync(towersDir(slot));
	} catch { /* none yet */ }
	return names.flatMap((name) => {
		const found = readJson<unknown>(join(towersDir(slot), name, SERVICE));
		return isService(found) ? [found] : [];
	});
}

const queueDir = (slot: Slot, workspace: string) => join(towerDir(slot, workspace), "queue");
const PAD = 10;
const seqOf = (name: string) => Number(/^(\d+)-/.exec(name)?.[1] ?? NaN);
const parkedDir = (slot: Slot, workspace: string) => join(queueDir(slot, workspace), "parked");
const nameOf = (event: Pick<QueuedEvent, "seq" | "id">) => `${String(event.seq).padStart(PAD, "0")}-${event.id}.json`;
/** The queued events of a workspace, oldest first; with `parked`, the ones a crash parked instead (`queue/parked/`). */
export function readQueue(slot: Slot, workspace: string, parked = false): QueuedEvent[] {
	const dir = parked ? parkedDir(slot, workspace) : queueDir(slot, workspace);
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
	} catch { /* empty */ }
	return names.flatMap((name) => {
		const event = readJson<QueuedEvent>(join(dir, name));
		return event && typeof event.text === "string" ? [event] : [];
	});
}
/** Writes an event's file again (its `taken` mark, a crash count), flushed. */
export function updateEvent(slot: Slot, workspace: string, event: QueuedEvent): void {
	writeDurable(join(queueDir(slot, workspace), nameOf(event)), event);
}
/** Removes an event that is done (or dropped). */
export function removeEvent(slot: Slot, workspace: string, event: Pick<QueuedEvent, "seq" | "id">): void {
	rmSync(join(queueDir(slot, workspace), nameOf(event)), { force: true });
	const state = known.get(queueDir(slot, workspace));
	if (state && state.count > 0) state.count--;
}
/** Moves an event to `queue/parked/`: it is no longer offered. */
export function parkEvent(slot: Slot, workspace: string, event: QueuedEvent): void {
	ensureDir(parkedDir(slot, workspace));
	writeDurable(join(parkedDir(slot, workspace), nameOf(event)), event);
	removeEvent(slot, workspace, event);
}
/** Puts a parked event back in the queue (Deliver again). */
export function unparkEvent(slot: Slot, workspace: string, event: QueuedEvent): void {
	rmSync(join(parkedDir(slot, workspace), nameOf(event)), { force: true });
	const { taken: _taken, crashes: _crashes, ...rest } = event;
	writeDurable(join(queueDir(slot, workspace), nameOf(event)), rest);
	const state = known.get(queueDir(slot, workspace));
	if (state) state.count++;
}
export function dropParked(slot: Slot, workspace: string, event: Pick<QueuedEvent, "seq" | "id">): void {
	rmSync(join(parkedDir(slot, workspace), nameOf(event)), { force: true });
}
export function queueLength(slot: Slot, workspace: string): number {
	try {
		return readdirSync(queueDir(slot, workspace)).filter((name) => name.endsWith(".json")).length;
	} catch {
		return 0;
	}
}
/** Per queue folder, what this process knows of it: the newest sequence number and the count, so an append reads the folder once, not at every event. */
const known = new Map<string, { top: number; count: number }>();
const look = (dir: string) => {
	const found = known.get(dir);
	if (found && statSync(dir, { throwIfNoEntry: false })) return found;
	let top = -1, count = 0;
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".json")) continue;
		count++;
		top = Math.max(top, Number.isFinite(seqOf(name)) ? seqOf(name) : -1);
	}
	const fresh = { top, count };
	known.set(dir, fresh);
	return fresh;
};
/**
 * Queues one event: the sequence number is the service's next one (or past the newest file still there, since a reopened tower's service starts again at 0 beside a kept queue),
 * the file is flushed before the call returns, and the service record carries the next number. A queue past `max` events drops its oldest. Returns the event as written.
 */
export function appendEvent(slot: Slot, service: ServiceRecord, event: Omit<QueuedEvent, "seq" | "id">, max = MAX_QUEUE): QueuedEvent {
	const dir = queueDir(slot, service.workspace);
	ensureDir(towerDir(slot, service.workspace));
	ensureDir(dir);
	const state = look(dir);
	const seq = Math.max(service.seq, state.top + 1);
	const id = createHash("sha256").update(`${event.from?.id ?? ""}\n${event.messageId ?? randomBytes(8).toString("hex")}\n${event.text}`).digest("hex").slice(0, 16);
	const written: QueuedEvent = { id, seq, ...event };
	writeDurable(join(dir, nameOf(written)), written);
	state.top = seq;
	state.count++;
	for (const name of state.count > max ? readdirSync(dir).filter((n) => n.endsWith(".json")).sort().slice(0, state.count - max) : []) {
		rmSync(join(dir, name), { force: true });
		state.count--;
	}
	service.seq = seq + 1;
	writeDurable(join(towerDir(slot, service.workspace), SERVICE), service);
	return written;
}
/** Removes queued events older than KEEP_MS (their files' mtime) from every workspace folder, `queue/parked/` included (a folder inside `queue/` is never removed as a file). Returns how many went. */
export function purgeQueues(slot: Slot, now: number): number {
	let gone = 0, names: string[] = [];
	try {
		names = readdirSync(towersDir(slot));
	} catch { /* none */ }
	for (const name of names) {
		const queue = join(towersDir(slot), name, "queue");
		for (const dir of [queue, join(queue, "parked")]) {
			let files: string[] = [];
			try {
				files = readdirSync(dir);
			} catch { continue; }
			for (const file of files) {
				const stat = statSync(join(dir, file), { throwIfNoEntry: false });
				if (!stat || stat.isDirectory() || now - stat.mtimeMs <= KEEP_MS) continue;
				rmSync(join(dir, file), { force: true });
				known.delete(queue);
				gone++;
			}
		}
	}
	return gone;
}
const countFiles = (dir: string): number => {
	let n = 0;
	for (const e of readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? countFiles(join(dir, e.name)) : 1;
	return n;
};
/** The flag is off: every workspace's `service.json`, queue (parked events too), runs, notes, expectations, timer, dedupe ledger and opener's ledger go (message text stays on disk with no time limit otherwise). Returns how many files went. */
export function purgeAll(slot: Slot): number {
	let gone = 0, names: string[] = [];
	try {
		names = readdirSync(towersDir(slot));
	} catch { return 0; }
	for (const name of names) {
		const dir = join(towersDir(slot), name);
		for (const entry of ["queue", "runs", SERVICE, OPENED, "notes.jsonl", "expects.json", "timer.json", "seen.jsonl"]) {
			const path = join(dir, entry), stat = statSync(path, { throwIfNoEntry: false });
			if (!stat) continue;
			gone += stat.isDirectory() ? countFiles(path) : 1;
			rmSync(path, { recursive: true, force: true });
		}
		known.delete(join(dir, "queue"));
	}
	return gone;
}

/** The opener's ledger of one workspace: the entries of the last 24 h. */
export function readLedger(slot: Slot, workspace: string, now: number): LedgerRow[] {
	const found = readJson<{ entries?: LedgerRow[] }>(join(towerDir(slot, workspace), OPENED));
	return (Array.isArray(found?.entries) ? found.entries : []).filter((e) => typeof e?.key === "string" && typeof e.at === "number" && now - e.at <= KEEP_MS);
}
export function putLedger(slot: Slot, workspace: string, entry: LedgerRow, now: number): void {
	const entries = [...readLedger(slot, workspace, now).filter((e) => e.key !== entry.key), entry];
	ensureDir(towerDir(slot, workspace));
	writeDurable(join(towerDir(slot, workspace), OPENED), { entries });
}
