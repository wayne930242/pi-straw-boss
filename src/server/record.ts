import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { herdrSocket } from "../endpoint.ts";
import { alive as pidAlive } from "../remote.ts";
import { startedOrWait, startOf } from "../startof.ts";
import { protectFolder, refuseLink, resetFileAcl, type RunNative } from "./winprep.ts";

// What the sb server leaves on disk (docs/specs/2026-10-26-sb-backend.md, Process model and lifecycle): `server.json`, the record of the running server;
// `server.lock`, which makes check-and-start atomic; `start-error.json`, why the last start attempt failed. One server serves one (state directory, Herdr socket)
// pair, its slot: the primary slot, for the default Herdr, keeps its files in the state directory itself, any other Herdr's in `servers/<hash>/`.

export const FILES = { record: "server.json", lock: "server.lock", stale: "server.lock.stale", startError: "start-error.json", log: "server.log", socket: "server.sock" } as const;
/** A restart record counts as under way while its `since` is no older than this (the starting server touches it every TOUCH_MS). */
export const FRESH_MS = 10_000;
export const TOUCH_MS = 2000;
/** A lock older than this is taken over even from a live holder: no start or restart may take that long (a start waits 20 s for hello, 60 s on Windows, and a restart waits up to 15 s for the old server first). */
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

export type Detach = "wmi" | "wmi-in-job" | "direct";
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
	/** Windows: how the server was started: `wmi` (outside the starter's job), `wmi-in-job` (through WMI, but the job did not allow breakaway: it is in the WMI provider host's job), or `direct` (a plain spawn, after `detachFailure`: it dies with the pane or ssh session that started it). */
	detach?: Detach;
	detachFailure?: string;
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
export function secretDir(dir: string, own?: string) {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
	} catch (error) {
		throw rootMade(dir, error, own);
	}
}
/** A folder a `sudo` run made cannot be written or changed by the user afterwards: told as that, with what to do (uid 0 is accepted as an owner, so this is the one place it shows). */
function rootMade(dir: string, error: unknown, own?: string): unknown {
	const code = (error as NodeJS.ErrnoException).code;
	if (own === undefined || (code !== "EPERM" && code !== "EACCES") || !process.getuid || process.getuid() === 0) return error;
	// Only the agent folder, the state folder and what is below them are pi's: a system folder above them is not told to be chowned or removed.
	for (let at = dir; at === own || at.startsWith(own + sep); at = dirname(at)) {
		try {
			if (lstatSync(at).uid === 0) return new Error(`${at} belongs to root; it was made by a sudo run: sudo chown -R it to your account, or remove it with sudo, then start again (${code}).`);
			return error;
		} catch {
			if (dirname(at) === at) return error;
		}
	}
	return error;
}
/**
 * Makes the slot's folder ready for the first file in it. On Windows the state folder is protected (owner and SYSTEM, no inheritance) first, before the lock, the placeholder record, or
 * the log is created, by two native calls and once per process; the slot's own folder (below it, for a secondary slot) then inherits that. Elsewhere it is the 700 folder.
 * `gate` may be asynchronous (the owner read is a PowerShell start a pi session must not wait for with its event loop): then the answer is a promise that ends when the rest is done.
 */
export function prepareSlot(slot: Slot, platform: NodeJS.Platform = process.platform, run?: RunNative, ms?: number, gate?: () => void | Promise<void>): void | Promise<void> {
	if (platform !== "win32") {
		// The gate comes before the folder is made or changed: a folder that landed foreign between two gates gets nothing (R13-F002's POSIX twin).
		const gated = gate?.();
		return gated ? gated.then(() => secretDir(slot.dir, dirname(slot.stateDir))) : secretDir(slot.dir, dirname(slot.stateDir));
	}
	protectFolder(slot.stateDir, run, ms);
	const rest = () => {
		// A secondary slot's folders inherit the protected one: none of them may be a link or junction that sends what is written into them elsewhere.
		if (!slot.primary) for (const dir of [join(slot.stateDir, "servers"), slot.dir]) {
			mkdirSync(dir, { recursive: true });
			refuseLink(dir);
		}
		secretDir(slot.dir, dirname(slot.stateDir));
	};
	// The owner gate (R13-F002) comes before anything else is made in the folder, so a folder that landed foreign (a swapped temporary folder) gets not even a secondary slot's empty `servers\` in it.
	const gated = gate?.();
	return gated ? gated.then(rest) : rest();
}

/** What `stat` and `lstat` answer that the uid gate reads. */
export type UidStat = (path: string) => { uid: number; isSymbolicLink?: () => boolean };
/**
 * The owner gate where there is no ACL (docs/specs/2026-10-26-sb-backend.md, The control socket): a state folder, a secondary slot's folder and the record in it that another uid owns are refused before
 * the record is read, a hello is sent, or anything is written, with the words of the Windows gate. A stat each, no process. A link is judged twice: its own owner (`lstat`: a link another account made
 * is that account's, whatever it points to), then the target's (`stat`). uid 0 is accepted as an owner, as BUILTIN\Administrators and SYSTEM are on Windows: root is no adversary to the user (its folder is
 * told by `secretDir` when the user cannot use it). A path that is not there is nothing to refuse; a stat that fails for any other reason is a refusal that says so. `uid` is null where there is no
 * `getuid`. Returns false, as the Windows gate does when it read nothing.
 */
export function uidGate(slot: Slot, stat: UidStat = statSync, uid: number | null = process.getuid?.() ?? null, lstat: UidStat = stat === statSync ? lstatSync : stat): boolean {
	if (uid === null) return false;
	const paths = [...new Set([slot.stateDir, slot.dir, fileOf(slot, "record")])];
	const refuse = (path: string, kind: string, owner: number, what = "") => new Error(`could not check ${slot.stateDir} before trusting or writing to it: the ${kind} ${path}${what} belongs to another account (uid ${owner}), not to uid ${uid}. Run pi as that account, or delete the ${kind} ${path}, then start again.`);
	for (const path of paths) {
		const kind = path === paths.at(-1) ? "file" : "folder";
		for (const [look, what] of [[lstat, " (a link)"], [stat, ""]] as const) {
			let info: ReturnType<UidStat>;
			try {
				info = look(path);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT" || code === "ENOTDIR") break;
				throw new Error(`could not check ${slot.stateDir} before trusting or writing to it: ${(error as Error).message}`);
			}
			if (info.uid !== uid && info.uid !== 0) throw refuse(path, kind, info.uid, look === lstat && info.isSymbolicLink?.() ? what : "");
			// Not a link: the target is the path itself, judged already.
			if (look === lstat && !info.isSymbolicLink?.()) break;
		}
	}
	return false;
}

let temps = 0;
/** Writes a JSON file by rename, mode 600: a reader never sees half a file. On Windows a rename onto a file a reader has open fails for a moment, so it is tried a few times. */
export function writeJson(file: string, value: unknown) {
	// Created new (`wx`) under a name no earlier file has: a temporary file that was already there (another account's, with its owner) is never written to and renamed into place (R8-F002).
	const temp = `${file}.${process.pid}.${temps++}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
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
/** The record's text, read from the file this open handle names: a link is not followed (`O_NOFOLLOW`) and a file another uid owns is not read, so what was stat-ed is what is read (F005c). */
function readOwned(file: string): string | undefined {
	if (process.platform === "win32" || !process.getuid) return readRaw(file);
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		const owner = fstatSync(fd).uid;
		return owner === process.getuid() || owner === 0 ? readFileSync(fd, "utf8") : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
const parse = <T>(raw: string | undefined): T | undefined => { try { return raw === undefined ? undefined : (JSON.parse(raw) as T); } catch { return undefined; } };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readRecord(slot: Slot): ServerRecord | undefined {
	const record = parse<Partial<ServerRecord>>(readOwned(fileOf(slot, "record")));
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
export function markStarting(slot: Slot, now: number, who: { pid: number; version: string; desk: boolean; intercom: IntercomScope; mode: ServerRecord["mode"]; by: string; prepare?: (slot: Slot) => void }): { began: string; expect: { pid: number; secret: string } } {
	const fresh = { reason: "starting", by: who.by };
	(who.prepare ?? prepareSlot)(slot);
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
	/** Makes the slot's folder ready before the lock is written into it (the Windows ACL, before any file); `prepareSlot` by default. */
	prepare?: (slot: Slot, ms?: number) => void;
	/** Gives a lock file the folder's ACL again when it cannot be read (access denied); `resetFileAcl` on Windows, none elsewhere. Without one an unreadable lock is an error. */
	repair?: (file: string) => void;
	/** Whether a file exists (`existsSync`); a seam for the delete-pending case. */
	exists?: (file: string) => boolean;
}
/** `server.lock` cannot be opened (access denied): not a start under way. Told as it is, never waited for as a held lock. */
export class LockUnreadable extends Error {
	constructor(file: string, code: string, detail?: string) {
		super(`${file} cannot be read (${code}) and its permissions could not be repaired${detail ? `: ${detail}` : ""}; delete it, or reset them (icacls "${file}" /reset), then start again`);
	}
}
/** The error code when the file exists and cannot be read for lack of permission, else undefined. */
function deniedCode(file: string): string | undefined {
	try {
		readFileSync(file);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code ?? "";
		return code === "EACCES" || code === "EPERM" ? code : undefined;
	}
	return undefined;
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

const SELF_START_GRACE_MS = 20_000;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * Takes `server.lock`, which a start or a restart holds while it decides and carries out (never a running server). It is created whole and linked into place,
 * so it is never seen half written, and only one taker gets it. A lock whose holder is dead (pid gone, or started at another time than recorded) is taken over, and
 * so is one older than LOCK_MAX_MS; a holder that is alive keeps it however long it takes. One looker at a time decides that, through `server.lock.stale`.
 * Waits up to `waitMs` for a busy lock, then throws LockBusy.
 */
export async function takeLock(slot: Slot, by: string, deps: LockDeps = {}, waitMs = 0): Promise<Lock> {
	const now = deps.now ?? Date.now, sleep = deps.sleep ?? pause, lock = fileOf(slot, "lock"), marker = fileOf(slot, "stale");
	// Waits a few seconds for the launch PowerShell to tell this process's start time (a cold start on Windows makes one PowerShell start, not two) before reading it with one of its own.
	const self = deps.self ?? { pid: process.pid, started: () => startedOrWait(process.pid, SELF_START_GRACE_MS) };
	// The start time is taken if it is known now (macOS and Linux: always); on Windows it takes seconds (a PowerShell start), and a cold start does not wait for it: the lock is
	// taken without it and written again with it when it arrives. Until then the lock is judged by its pid alone, as one whose start time `ps` cannot tell is.
	let known: string | undefined, settled = false;
	const startedSoon = Promise.resolve(self.started()).then((started) => ((settled = true), (known = started)), () => ((settled = true), undefined));
	await undefined; // one turn of the microtask queue: an answer that is already in has been taken by then
	const first = settled ? known : undefined;
	const info: LockInfo = { pid: self.pid, ...(first ? { started: first } : {}), by, since: at(now()) };
	let body = JSON.stringify(info);
	(deps.prepare ?? prepareSlot)(slot);
	const temp = `${lock}.${self.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(temp, body, { flag: "wx", mode: 0o600 });
	const end = now() + waitMs;
	let repaired = false, deniedTries = 0, failure: string | undefined;
	try {
		for (;;) {
			try {
				linkSync(temp, lock);
				if (!first) void startedSoon.then((started) => (body = completeLock(lock, body, started) ?? body));
				return { info, release: () => (readRaw(lock) === body ? rmSync(lock, { force: true }) : undefined) };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			// A lock that is there and cannot be opened was damaged by someone (an empty DACL): its permissions are repaired once, and then it is read; never waited for as "held".
			const denied = deniedCode(lock);
			if (denied) {
				// A lock that is gone by now (released while it was opened, delete-pending on a file system without POSIX delete) is a free lock; one that is still there gets its permissions repaired
				// once, and a denial that outlives the repair is retried for about 100 ms before it is told as what it is.
				// Not at once the second time: a lock that stays "there" for the link and "gone" for the read (delete-pending) is not spun on, but waited for briefly and then told busy.
				if (!(deps.exists ?? existsSync)(lock)) {
					if (deniedTries++ >= 5 || (deniedTries > 1 && now() >= end)) throw new LockBusy(undefined);
					if (deniedTries > 1) await sleep(20);
					continue;
				}
				if (!repaired && deps.repair) {
					repaired = true;
					try {
						deps.repair(lock);
						continue;
					} catch (error) {
						failure = (error as Error).message;
					}
				}
				if (deniedTries++ < 5) {
					await sleep(20);
					continue;
				}
				throw new LockUnreadable(lock, denied, failure);
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
