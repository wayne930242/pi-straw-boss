import { createHash, randomBytes } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { herdrSocket } from "../endpoint.ts";
import { alive as pidAlive } from "../remote.ts";
import { startedLater, startOf } from "../startof.ts";

// What the sb server leaves on disk (docs/specs/2026-10-26-sb-backend.md, Process model and lifecycle): `server.json`, the record of the running server;
// `server.lock`, which makes check-and-start atomic; `start-error.json`, why the last start attempt failed. One server serves one (state directory, Herdr socket)
// pair, its slot: the primary slot, for the default Herdr, keeps its files in the state directory itself, any other Herdr's in `servers/<hash>/`.

export const FILES = { record: "server.json", lock: "server.lock", stale: "server.lock.stale", startError: "start-error.json", log: "server.log", socket: "server.sock" } as const;
/** A restart record counts as under way while its `since` is no older than this (the starting server touches it every TOUCH_MS). */
export const FRESH_MS = 10_000;
export const TOUCH_MS = 2000;
/** A lock older than this is taken over even from a live holder: no start or restart may take that long (their budgets are 20 s and 30 s). */
export const LOCK_MAX_MS = 120_000;
const MARKER_MAX_MS = 10_000;

/** The default Herdr of an environment: its socket with `HERDR_SOCKET_PATH` and `HERDR_SESSION` unset, for that environment's home and config folders. */
export const defaultHerdr = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) =>
	herdrSocket({ ...env, HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined }, platform);

export interface Slot {
	stateDir: string;
	/** The Herdr socket this slot's server serves. */
	herdr: string;
	/** The server of the default Herdr: it keeps the contract paths and is the only one that holds the link. */
	primary: boolean;
	/** The first 16 hex of the sha256 of the socket: the name of a secondary slot's folder. */
	hash: string;
	/** The first 8 hex of the hash: in the ids and names of a secondary slot's towers. */
	slot8: string;
	/** The folder of the slot's files. */
	dir: string;
}
export function slotOf(stateDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Slot {
	const herdr = herdrSocket(env, platform), primary = herdr === defaultHerdr(env, platform);
	const hash = createHash("sha256").update(herdr).digest("hex").slice(0, 16);
	return { stateDir, herdr, primary, hash, slot8: hash.slice(0, 8), dir: primary ? stateDir : join(stateDir, "servers", hash) };
}
export const fileOf = (slot: Slot, name: keyof typeof FILES) => join(slot.dir, FILES[name]);
/** The server's own intercom session. */
export const serverId = (slot: Slot) => `sb-server-${slot.slot8}`;
/** A workspace's tower identity: Herdr's workspace ids are short counters, so a secondary server's carry its slot (two Herdr servers on one broker may both have `w1`). */
export const towerId = (slot: Slot, workspace: string) => (slot.primary ? `sb-tower-${workspace.toLowerCase()}` : `sb-tower-${slot.slot8}-${workspace.toLowerCase()}`);
export const towerName = (slot: Slot, label: string) => (slot.primary ? `tower · ${label}` : `tower · ${label} · ${slot.slot8}`);

export interface Restarting { began: string; since: string; reason: string; by: string }
export interface LastError { at: string; code: string; text: string }
export interface IntercomScope { scope?: string; transport?: string; tcp?: string }
/** `server.json`. `socket`, `secret`, `intercom`, and `intercomId` are for sessions and runs; the rest is for a shell too. The file is a secret: never logged. */
export interface ServerRecord {
	pid: number;
	started?: string;
	version: string;
	herdr: string;
	mode: "detached" | "serve";
	desk: boolean;
	intercom: IntercomScope;
	/** Reserved for the GUI that moves into the server with B2; a restart carries it over untouched. */
	gui?: { port: number; token: string; stopped?: boolean };
	stopped?: boolean;
	restarting?: Restarting;
	lastError?: LastError;
	/** The last restart that was asked for, kept across restarts: agents may ask for at most one a minute. */
	lastRestart?: { at: string; reason: string; by: string };
	log: string;
	socket: string;
	secret: string;
	intercomId: string;
}
export interface StartError { at: string; code: "acl" | "loader" | "intercom" | "start"; text: string; sddl?: string }

/** Prepares a folder for secrets: mode 700 (a no-op on Windows, where the ACL does it). */
export function secretDir(dir: string) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

let temps = 0;
/** Writes a JSON file by rename, mode 600: a reader never sees half a file. On Windows a rename onto a file a reader has open fails for a moment, so it is tried a few times. */
export function writeJson(file: string, value: unknown) {
	const temp = `${file}.${process.pid}.${temps++}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
		for (let tries = 0; ; tries++) {
			try {
				return renameSync(temp, file);
			} catch (error) {
				if (tries >= 20 || !["EPERM", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			}
		}
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
const readRaw = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return undefined; } };
const parse = <T>(raw: string | undefined): T | undefined => { try { return raw === undefined ? undefined : (JSON.parse(raw) as T); } catch { return undefined; } };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readRecord(slot: Slot): ServerRecord | undefined {
	const record = parse<Partial<ServerRecord>>(readRaw(fileOf(slot, "record")));
	// SAFETY: a record this code wrote has these fields; the three checked here are the ones every reader needs to reach the server, and a file without them is no record.
	return isObject(record) && typeof record.pid === "number" && typeof record.socket === "string" && typeof record.secret === "string" ? (record as ServerRecord) : undefined;
}
export const writeRecord = (slot: Slot, record: ServerRecord) => writeJson(fileOf(slot, "record"), record);
/** Read, change, and write the record back; `change` returns the new record, or undefined to leave the file as it is. */
export function updateRecord(slot: Slot, change: (record: ServerRecord) => ServerRecord | undefined): ServerRecord | undefined {
	const record = readRecord(slot), next = record && change(record);
	if (next) writeRecord(slot, next);
	return next ?? record;
}

const at = (ms: number) => new Date(ms).toISOString();
/** Whether the record names a restart or start that is under way: its `since` was touched within the last FRESH_MS. */
export function restartingFresh(record: Pick<ServerRecord, "restarting"> | undefined, now: number): boolean {
	const since = record?.restarting ? Date.parse(record.restarting.since) : NaN;
	return Number.isFinite(since) && now - since <= FRESH_MS && since - now <= FRESH_MS;
}
/** The record's `restarting` for a restart that begins now, or the one under way with its `since` moved (its `began`, `reason`, and `by` stay). */
export function restartingNow(found: Restarting | undefined, now: number, fresh: { reason: string; by: string }): Restarting {
	const stale = !found || !Number.isFinite(Date.parse(found.since)) || now - Date.parse(found.since) > FRESH_MS;
	return stale ? { began: at(now), since: at(now), ...fresh } : { ...found, since: at(now) };
}
/**
 * Moves `restarting.since` of the record, only while a `restarting` is there (and `began`, when given, is the one asked for). `expect`: the server whose record the requester
 * keeps fresh (the old one, until the new server writes its own); a record of another pid or secret is a newer server's, and a requester's write of what it read earlier would
 * overwrite it. Returns whether it was touched.
 */
export function touchRestarting(slot: Slot, now: number, began?: string, expect?: { pid: number; secret?: string }): boolean {
	let touched = false;
	updateRecord(slot, (record) => {
		if (!record.restarting || (began && record.restarting.began !== began)) return undefined;
		if (expect && (record.pid !== expect.pid || (expect.secret !== undefined && record.secret !== expect.secret))) return undefined;
		touched = true;
		return { ...record, restarting: { ...record.restarting, since: at(now) } };
	});
	return touched;
}

/**
 * The record of a server that is about to start, written by whoever starts it before it spawns anything (a cold Windows start takes seconds before the new process can write its
 * own): `restarting` with reason `starting`, so a look at the state sees a start under way and not a server that is gone. A record that is there (a dead server's, a restart's) keeps
 * everything it holds and gets the `restarting`; with none, a placeholder holds the place, with no socket and no secret, so nothing connects to it. Returns the `began` of the
 * start, and the pid and secret of the record the starter keeps fresh (`touchRestarting`'s `expect`).
 */
export function markStarting(slot: Slot, now: number, who: { pid: number; version: string; desk: boolean; intercom: IntercomScope; mode: ServerRecord["mode"]; by: string }): { began: string; expect: { pid: number; secret: string } } {
	const fresh = { reason: "starting", by: who.by };
	secretDir(slot.dir);
	const found = readRecord(slot);
	if (found) {
		const restarting = restartingNow(found.restarting, now, fresh);
		writeRecord(slot, { ...found, restarting });
		return { began: restarting.began, expect: { pid: found.pid, secret: found.secret } };
	}
	const restarting = restartingNow(undefined, now, fresh);
	writeRecord(slot, { pid: who.pid, version: who.version, herdr: slot.herdr, mode: who.mode, desk: who.desk, intercom: who.intercom, log: fileOf(slot, "log"), socket: "", secret: "", intercomId: serverId(slot), restarting });
	return { began: restarting.began, expect: { pid: who.pid, secret: "" } };
}
/** Moves the placeholder `markStarting` wrote to the pid of the process that was started for it. Returns the record the starter keeps fresh from now on. */
export function adoptStarting(slot: Slot, from: { pid: number; secret: string }, pid: number): { pid: number; secret: string } {
	if (from.secret !== "") return from;
	const adopted = updateRecord(slot, (record) => (record.pid === from.pid && record.secret === "" ? { ...record, pid } : undefined));
	return adopted?.pid === pid ? { pid, secret: "" } : from;
}
/** A start that failed no longer counts as under way: its `restarting` goes, if the record is still the starter's (a server that took it over keeps its own). */
export function endStarting(slot: Slot, began: string, expect: { pid: number; secret: string }): void {
	updateRecord(slot, (record) => {
		if (!record.restarting || record.restarting.began !== began || record.pid !== expect.pid || record.secret !== expect.secret) return undefined;
		const { restarting: _restarting, ...rest } = record;
		return rest;
	});
}

export const readStartError = (slot: Slot) => parse<StartError>(readRaw(fileOf(slot, "startError")));
export const writeStartError = (slot: Slot, error: Omit<StartError, "at"> & { at?: string }, now: number) => writeJson(fileOf(slot, "startError"), { at: at(now), ...error });
/** Deleted at each start attempt (under the lock, before it spawns) and by the new server once it answers `hello`. */
export const clearStartError = (slot: Slot) => rmSync(fileOf(slot, "startError"), { force: true });

/**
 * Clears `stopped` where the boss's own start does: in `server.json` (and its `gui.stopped`), and in `gui.json` of the primary slot, which straw-boss-desk reads.
 * Returns whether anything changed.
 */
export function clearStopped(slot: Slot): boolean {
	let changed = false;
	updateRecord(slot, (record) => {
		if (!record.stopped && !record.gui?.stopped) return undefined;
		changed = true;
		const { stopped: _stopped, ...rest } = record;
		return { ...rest, ...(record.gui ? { gui: { ...record.gui, stopped: undefined } } : {}) } as ServerRecord;
	});
	if (slot.primary) {
		const file = join(slot.stateDir, "gui.json"), gui = parse<Record<string, unknown>>(readRaw(file));
		if (isObject(gui) && gui.stopped) {
			const { stopped: _stopped, ...rest } = gui;
			writeJson(file, rest);
			changed = true;
		}
	}
	return changed;
}

// --- server.lock ---

export interface LockInfo { pid: number; started?: string; by: string; since: string }
export interface LockDeps {
	now?: () => number;
	alive?: (pid: number) => boolean;
	startOf?: (pid: number) => string | undefined;
	/** This process's pid and start time, as the lock records them. */
	self?: { pid: number; started: () => Promise<string | undefined> };
	sleep?: (ms: number) => Promise<void>;
	/** Told when a lock is taken over from a holder that is dead, or past LOCK_MAX_MS. */
	note?: (event: string, fields: Record<string, string | number>) => void;
}
export class LockBusy extends Error {
	holder: LockInfo | undefined;
	constructor(holder: LockInfo | undefined) {
		super(holder ? `another start or restart is under way (${holder.by}, since ${holder.since})` : "server.lock is held");
		this.holder = holder;
	}
}
export interface Lock { info: LockInfo; release(): void }

/** Whether the process that took the lock still runs: its pid is alive and started when the lock says (a pid reused after a crash started later). When `ps` cannot say, the lock stands. */
export function holderAlive(info: LockInfo, deps: Pick<LockDeps, "alive" | "startOf"> = {}): boolean {
	if (!(deps.alive ?? pidAlive)(info.pid)) return false;
	if (!info.started) return true;
	const now = (deps.startOf ?? startOf)(info.pid);
	return now === undefined || now === info.started;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * Takes `server.lock`, which a start or a restart holds while it decides and carries out (never a running server). It is created whole and linked into place,
 * so it is never seen half written, and only one taker gets it. A lock whose holder is dead (pid gone, or started at another time than recorded) is taken over, and
 * so is one older than LOCK_MAX_MS; a holder that is alive keeps it however long it takes. One looker at a time decides that, through `server.lock.stale`.
 * Waits up to `waitMs` for a busy lock, then throws LockBusy.
 */
export async function takeLock(slot: Slot, by: string, deps: LockDeps = {}, waitMs = 0): Promise<Lock> {
	const now = deps.now ?? Date.now, sleep = deps.sleep ?? pause, lock = fileOf(slot, "lock"), marker = fileOf(slot, "stale");
	const self = deps.self ?? { pid: process.pid, started: () => startedLater(process.pid) };
	// The start time is taken if it is known now (macOS and Linux: always); on Windows it takes seconds (a PowerShell start), and a cold start does not wait for it: the lock is
	// taken without it and written again with it when it arrives. Until then the lock is judged by its pid alone, as one whose start time `ps` cannot tell is.
	let known: string | undefined, settled = false;
	const startedSoon = Promise.resolve(self.started()).then((started) => ((settled = true), (known = started)), () => ((settled = true), undefined));
	await undefined; // one turn of the microtask queue: an answer that is already in has been taken by then
	const first = settled ? known : undefined;
	const info: LockInfo = { pid: self.pid, ...(first ? { started: first } : {}), by, since: at(now()) };
	let body = JSON.stringify(info);
	secretDir(slot.dir);
	const temp = `${lock}.${self.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
	const end = now() + waitMs;
	try {
		for (;;) {
			try {
				linkSync(temp, lock);
				if (!first) void startedSoon.then((started) => (body = completeLock(lock, body, started) ?? body));
				return { info, release: () => (readRaw(lock) === body ? rmSync(lock, { force: true }) : undefined) };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const raw = readRaw(lock), held = parse<LockInfo>(raw);
			// A lock that cannot be read was caught being written, or is garbage a crash left: it is garbage once it is a few seconds old.
			const stale = raw === undefined ? false
				: !held || typeof held.pid !== "number" ? now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0) > MARKER_MAX_MS
				: !holderAlive(held, deps) || now() - Date.parse(held.since) > LOCK_MAX_MS;
			if (stale && raw !== undefined && removeStale(lock, marker, raw, now)) {
				deps.note?.("lock-taken-over", { holder: held?.pid ?? 0, by: held?.by ?? "unknown", since: held?.since ?? "unknown" });
				continue;
			}
			if (now() >= end) throw new LockBusy(held);
			await sleep(Math.min(50, Math.max(1, end - now())));
		}
	} finally {
		rmSync(temp, { force: true });
	}
}
/** Writes the lock again with the holder's start time, by rename, only while the lock still holds `body` (the text this process wrote). Returns the new text, or undefined when it was left as it is. */
function completeLock(lock: string, body: string, started: string | undefined): string | undefined {
	if (!started || readRaw(lock) !== body) return undefined;
	const info = parse<LockInfo>(body);
	if (!info || info.started) return undefined;
	const next = JSON.stringify({ ...info, started }), temp = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, next, { flag: "wx", mode: 0o600 });
		if (readRaw(lock) !== body) return undefined;
		renameSync(temp, lock);
		return next;
	} catch {
		return undefined; // best effort: the lock stands as it was
	} finally {
		rmSync(temp, { force: true });
	}
}
/** Removes the lock `raw` if it still holds that text; lookers take turns at this, so none removes the lock another has just taken. */
function removeStale(lock: string, marker: string, raw: string, now: () => number): boolean {
	try {
		writeFileSync(marker, String(process.pid), { flag: "wx", mode: 0o600 });
	} catch (error) {
		// A looker that died inside this section leaves its marker; one a few seconds old is not at work any more.
		if ((error as NodeJS.ErrnoException).code === "EEXIST" && now() - (statSync(marker, { throwIfNoEntry: false })?.mtimeMs ?? now()) > MARKER_MAX_MS) rmSync(marker, { force: true });
		return false;
	}
	try {
		if (readRaw(lock) !== raw) return false;
		rmSync(lock, { force: true });
		return true;
	} finally {
		rmSync(marker, { force: true });
	}
}
export const readLock = (slot: Slot) => parse<LockInfo>(readRaw(fileOf(slot, "lock")));
