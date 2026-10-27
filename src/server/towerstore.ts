import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { LedgerRow } from "../opener.ts";
import { secretDir, type Slot } from "./record.ts";

// What the tower service keeps on disk (docs/specs/2026-10-26-sb-backend.md, State): `tower/<workspace id>/` in the server's slot, mode 700, each file written by rename, mode 600.
// B4 writes `service.json` (the identity, its pane and tab, and the next event sequence number), `queue/` (events that arrived for the identity), and `opened.json` (the opener's
// ledger). The run records, the handoff notes, and the rest come with the runs (B5).

/** A tower service that has no tab for 24 h is forgotten with its queue; events and ledger entries are kept this long. */
export const KEEP_MS = 24 * 3600_000;

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
/** One event the service queued: an intercom message to the identity. Nothing wakes a run from it before B5. */
export interface QueuedEvent {
	id: string;
	seq: number;
	kind: "intercom";
	from: { id: string; name?: string };
	/** The text as received, its header included. */
	text: string;
	at: string;
	/** The broker's message id. */
	messageId: string;
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
function writeDurable(file: string, value: unknown): void {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, JSON.stringify(value));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
const ensureDir = (dir: string) => {
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
/** The queued events of a workspace, oldest first. */
export function readQueue(slot: Slot, workspace: string): QueuedEvent[] {
	let names: string[] = [];
	try {
		names = readdirSync(queueDir(slot, workspace)).filter((name) => name.endsWith(".json")).sort();
	} catch { /* empty */ }
	return names.flatMap((name) => {
		const event = readJson<QueuedEvent>(join(queueDir(slot, workspace), name));
		return event && typeof event.text === "string" ? [event] : [];
	});
}
export function queueLength(slot: Slot, workspace: string): number {
	try {
		return readdirSync(queueDir(slot, workspace)).filter((name) => name.endsWith(".json")).length;
	} catch {
		return 0;
	}
}
/**
 * Queues one event: the sequence number is the service's next one (or past the newest file still there, since a reopened tower's service starts again at 0 beside a kept queue),
 * the file is flushed before the call returns, and the service record carries the next number. Returns the event as written.
 */
export function appendEvent(slot: Slot, service: ServiceRecord, event: Omit<QueuedEvent, "seq" | "id">): QueuedEvent {
	const dir = queueDir(slot, service.workspace);
	ensureDir(towerDir(slot, service.workspace));
	ensureDir(dir);
	let top = -1;
	for (const name of readdirSync(dir)) top = Math.max(top, Number.isFinite(seqOf(name)) ? seqOf(name) : -1);
	const seq = Math.max(service.seq, top + 1);
	const id = createHash("sha256").update(`${event.from.id}\n${event.messageId}\n${event.text}`).digest("hex").slice(0, 16);
	const written: QueuedEvent = { id, seq, ...event };
	writeDurable(join(dir, `${String(seq).padStart(PAD, "0")}-${id}.json`), written);
	service.seq = seq + 1;
	writeDurable(join(towerDir(slot, service.workspace), SERVICE), service);
	return written;
}
/** Removes queued events older than KEEP_MS (their files' mtime) from every workspace folder that has no service. Returns how many went. */
export function purgeQueues(slot: Slot, now: number, live: (workspace: string) => boolean): number {
	let gone = 0, names: string[] = [];
	try {
		names = readdirSync(towersDir(slot));
	} catch { /* none */ }
	for (const name of names) {
		const queue = join(towersDir(slot), name, "queue");
		let files: string[] = [];
		try {
			files = readdirSync(queue);
		} catch { continue; }
		for (const file of files) {
			const stat = statSync(join(queue, file), { throwIfNoEntry: false });
			if (!stat || now - stat.mtimeMs <= KEEP_MS || live(name)) continue;
			rmSync(join(queue, file), { force: true });
			gone++;
		}
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
