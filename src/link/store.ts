import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { startOf } from "../remote.ts";
import { deviceFromSeeds, type DeviceKeys } from "./device.ts";

// Straw Link's state on disk (docs/specs/2026-10-25-straw-link.md, Storage and policy): `<pi agent dir>/straw-boss/link/`, mode 700, files 600
// where the OS has modes. Paths are handled as Unicode paths and never become a shell command.
//
//   device.json, device.id   the device keys, its label, the next sequence number; the id for an infra to read
//   teams/<team>.json        roster copy, team keys by epoch, relay URL, last event id, last sequence number per sender
//   inbox/<envelope id>.json messages waiting for a tower
//   outbox/<team>/<seq>-<envelope id>.bin   envelopes built and not yet taken by the relay
//   holder.json, holder.lock the link holder's record, and the lock every write below goes under
//   link.log                 why an envelope was dropped, and the other things an operator asks about
//
// Every write goes through `withLock`: a write outside it throws, so the rule "every write to a team file happens under the lock" cannot be
// skipped by a new caller. Reads never take the lock; every file is replaced by a rename, so a reader sees the old file or the new one.

export const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const HEX16 = /^[0-9a-f]{32}$/, HEX32 = /^[0-9a-f]{64}$/;

/** The lock could not be taken within the wait. */
export class LockTimeout extends Error {
	constructor(ms: number) {
		super(`Straw Link's lock (link/holder.lock) was not free within ${ms} ms`);
	}
}
/** A team file that is not there (`missing`: join again) or that cannot be trusted (`corrupt`). Either way no envelope of the team is taken: the guard fails closed. */
export class TeamFileError extends Error {
	readonly code: "missing" | "corrupt";
	constructor(code: "missing" | "corrupt", team: string, detail = "") {
		super(`team file ${team}: ${code}${detail ? ` (${detail})` : ""}`);
		this.code = code;
	}
}

/** The link holder: who it is, and the process that has to be alive for the record to stand. */
export interface HolderRecord { session: string; version: string; pid: number; started?: string; tower: boolean; since: number }
export interface DeviceFile { v: 1; signSeed: string; boxSeed: string; label: string; nextSeq: number }
export interface Device { keys: DeviceKeys; label: string }
export interface TeamFile {
	v: 1;
	/** The team id, hex. */
	team: string;
	relay: string;
	/** The roster's entries as the relay serves them, base64url. */
	entries: string[];
	/** Team keys by epoch, hex. */
	keys: Record<string, string>;
	/** The last relay event this device finished with: where a takeover resumes the stream. */
	lastEventId: number;
	/** The last queued `seq` taken from each sender (R-F021). */
	lastSeq: Record<string, number>;
}
/** A message waiting for a tower, as the holder decrypted and checked it. */
export interface InboxItem {
	v: 1;
	/** The envelope id, hex. */
	id: string;
	team: string;
	from: string;
	/** The sender's label and short id as the roster gave them when the message was taken. */
	fromLabel: string;
	fromShort: string;
	seq: number;
	sentAt: number;
	received: number;
	fromWorkspace: string;
	toWorkspace: string;
	replyExpected: boolean;
	text: string;
}

export interface StoreOptions {
	/** Whether a process lives; the lock of one that does not is taken over at once. */
	alive?: (pid: number) => boolean;
	/** When a process started (see `startOf`); undefined when it cannot be told. A lock is kept past its age while its owner is the process that took it. */
	start?: (pid: number) => string | undefined;
	now?: () => number;
	staleMs?: number;
	/** Told after each flush to disk (`file` before a rename, `dir` after it); for tests. */
	synced?: (kind: "file" | "dir", path: string) => void;
	/** The log rotates once it passes this many bytes (default 1 MiB). */
	logMax?: number;
}

const pidAlive = (pid: number) => {
	try {
		return process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const outboxName = (seq: number, id: Buffer) => `${String(seq).padStart(12, "0")}-${id.toString("hex")}.bin`;
const mkdirPrivate = (dir: string) => {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { chmodSync(dir, 0o700); } catch { /* a file system without modes */ }
};

export class LinkStore {
	readonly dir: string;
	private readonly alive: (pid: number) => boolean;
	private readonly start: (pid: number) => string | undefined;
	private ownStart: string | undefined | null = null;
	private readonly now: () => number;
	private readonly staleMs: number;
	private readonly logMax: number;
	private readonly synced: ((kind: "file" | "dir", path: string) => void) | undefined;
	private readonly scope = new AsyncLocalStorage<symbol>();
	private held: symbol | undefined;
	private token: string | undefined;
	private tail: Promise<unknown> = Promise.resolve();

	constructor(dir: string, o: StoreOptions = {}) {
		this.dir = dir;
		this.alive = o.alive ?? pidAlive;
		this.start = o.start ?? startOf;
		this.now = o.now ?? Date.now;
		this.staleMs = o.staleMs ?? LOCK_STALE_MS;
		this.logMax = o.logMax ?? 1024 * 1024;
		this.synced = o.synced;
	}

	private path(...parts: string[]) {
		return join(this.dir, ...parts);
	}
	/** The directory and its subdirectories, private. */
	ensure(): void {
		for (const dir of [this.dir, this.path("teams"), this.path("inbox")]) mkdirPrivate(dir);
	}

	// ---- The lock ------------------------------------------------------------------------------------------------------------------

	/**
	 * Runs `fn` holding `link/holder.lock`, one caller at a time in this process (in call order) and across processes. `fn` may await, but keep it to
	 * a few seconds: a lock older than 10 s is taken over unless its owner is still the process that took it. Not re-entrant. A write checks, right
	 * before it replaces a file, that the lock file still carries this call's token, so a function that lost its lock (a process that was
	 * suspended past the age) fails instead of overwriting what the new owner wrote.
	 */
	withLock<T>(fn: () => T | Promise<T>, waitMs = LOCK_WAIT_MS): Promise<T> {
		const run = this.tail.then(async () => {
			const token = await this.acquire(waitMs), scope = Symbol("lock");
			this.held = scope;
			this.token = token;
			try {
				return await this.scope.run(scope, fn);
			} finally {
				this.held = undefined;
				this.token = undefined;
				this.release(token);
			}
		});
		this.tail = run.catch(() => undefined);
		return run;
	}
	private assertLocked(what: string): void {
		const scope = this.scope.getStore();
		if (!scope || scope !== this.held) throw new Error(`${what} must run under the Straw Link lock`);
	}
	/** The lock file still carries the token of the call that is writing: a lock taken over as stale is no longer ours, and nothing is written under it. */
	private assertOwnsLock(): void {
		let token: unknown;
		try {
			token = (JSON.parse(readFileSync(this.lock, "utf8")) as { token?: unknown }).token;
		} catch { /* unreadable: lost */ }
		if (token !== this.token) throw new Error("The Straw Link lock was taken over while this step ran; nothing was written");
	}
	private get lock() {
		return this.path("holder.lock");
	}
	private async acquire(waitMs: number): Promise<string> {
		this.ensure();
		const token = randomUUID(), end = Date.now() + waitMs;
		for (;;) {
			try {
				writeFileSync(this.lock, JSON.stringify({ pid: process.pid, ...(this.started() ? { started: this.started() } : {}), token, t: this.now() }), { flag: "wx", mode: 0o600 });
				return token;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			const stale = this.stale();
			if (stale !== undefined) {
				this.breakStale(stale);
				continue;
			}
			if (Date.now() >= end) throw new LockTimeout(waitMs);
			await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 20)));
		}
	}
	private started(): string | undefined {
		if (this.ownStart === null) this.ownStart = this.start(process.pid);
		return this.ownStart;
	}
	/** The content of the lock when it is a dead process's or an old one's, else undefined (a lock being written reads empty for a moment and is not stale). */
	private stale(): string | undefined {
		let raw: string, age: number;
		try {
			raw = readFileSync(this.lock, "utf8");
			age = Date.now() - statSync(this.lock).mtimeMs;
		} catch {
			return undefined;
		}
		let info: { pid?: unknown; started?: unknown };
		try {
			info = JSON.parse(raw) as typeof info;
		} catch {
			return age > this.staleMs ? raw : undefined; // partial: wait, unless it never completed
		}
		if (typeof info.pid === "number" && !this.alive(info.pid)) return raw;
		if (age <= this.staleMs) return undefined;
		// Old: the owner is still in it when it is the process that took the lock (a suspended laptop, a long section). Only when that cannot be told is age enough.
		return typeof info.pid === "number" && typeof info.started === "string" && this.start(info.pid) === info.started ? undefined : raw;
	}
	/** Of several processes that find the same stale lock, the one that makes `holder.lock.stale` looks again and removes it, so none removes the fresh lock another has just taken. */
	private breakStale(raw: string): void {
		const guard = `${this.lock}.stale`;
		try {
			mkdirSync(guard);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() - (statSync(guard, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > this.staleMs) rmSync(guard, { recursive: true, force: true });
			return;
		}
		try {
			if (readFileSync(this.lock, "utf8") === raw) rmSync(this.lock, { force: true });
		} catch { /* it went by itself */ } finally {
			rmSync(guard, { recursive: true, force: true });
		}
	}
	private release(token: string): void {
		try {
			if ((JSON.parse(readFileSync(this.lock, "utf8")) as { token?: unknown }).token === token) rmSync(this.lock, { force: true });
		} catch { /* taken over as stale: not ours to remove */ }
	}

	// ---- Files ---------------------------------------------------------------------------------------------------------------------

	private write(path: string, text: string | Uint8Array): void {
		const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			// Flushed before the rename and the directory after it, so a crash of the machine leaves the old file or the new one, never an empty one,
			// and a sequence number or an acknowledged message that was saved stays saved (libuv's fsync is F_FULLFSYNC on macOS).
			const fd = openSync(tmp, "wx", 0o600);
			try {
				const bytes = typeof text === "string" ? Buffer.from(text, "utf8") : text;
				for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			this.synced?.("file", tmp);
			this.assertOwnsLock();
			renameSync(tmp, path);
			this.syncDir(dirname(path));
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
	}
	private syncDir(dir: string): void {
		try {
			const fd = openSync(dir, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		} catch { /* a file system that cannot flush a directory (Windows) */ }
		this.synced?.("dir", dir);
	}
	private read<T>(path: string, parse: (v: unknown) => T | undefined): T | undefined {
		try {
			return parse(JSON.parse(readFileSync(path, "utf8")));
		} catch {
			return undefined;
		}
	}

	// ---- The holder record ---------------------------------------------------------------------------------------------------------

	readHolder(): HolderRecord | undefined {
		return this.read(this.path("holder.json"), (v) => {
			if (!isObject(v) || typeof v.session !== "string" || typeof v.version !== "string" || !count(v.pid) || typeof v.tower !== "boolean" || !count(v.since)) return undefined;
			if (v.started !== undefined && typeof v.started !== "string") return undefined;
			return { session: v.session, version: v.version, pid: v.pid, ...(v.started !== undefined ? { started: v.started } : {}), tower: v.tower, since: v.since };
		});
	}
	writeHolder(record: HolderRecord): void {
		this.assertLocked("Writing holder.json");
		this.write(this.path("holder.json"), JSON.stringify(record));
	}
	/** Removes the record when `match` says it is the caller's; true when it was removed. */
	clearHolder(match: (record: HolderRecord) => boolean): boolean {
		this.assertLocked("Clearing holder.json");
		const record = this.readHolder();
		if (!record || !match(record)) return false;
		rmSync(this.path("holder.json"), { force: true });
		return true;
	}

	// ---- The device ----------------------------------------------------------------------------------------------------------------

	private readDeviceFile(): DeviceFile | undefined {
		const path = this.path("device.json");
		if (!existsSync(path)) return undefined;
		// SAFETY: the guard checks every field of DeviceFile that is read.
		const file = this.read(path, (v) => (isObject(v) && v.v === 1 && typeof v.signSeed === "string" && HEX32.test(v.signSeed) && typeof v.boxSeed === "string" && HEX32.test(v.boxSeed) && typeof v.label === "string" && count(v.nextSeq) && v.nextSeq >= 1 ? (v as unknown as DeviceFile) : undefined));
		if (!file) throw new Error("device.json is damaged; it is never replaced by a new identity, so restore it or remove the device by hand");
		return file;
	}
	private deviceOf(file: DeviceFile): Device {
		return { keys: deviceFromSeeds(Buffer.from(file.signSeed, "hex"), Buffer.from(file.boxSeed, "hex")), label: file.label };
	}
	/** The device, or undefined before the first start. Throws when device.json is damaged: a new identity would silently orphan the team. */
	device(): Device | undefined {
		const file = this.readDeviceFile();
		return file && this.deviceOf(file);
	}
	/** The device; made, with its `device.id`, at the first start. */
	ensureDevice(): Device {
		this.assertLocked("Making the device");
		const file = this.readDeviceFile();
		if (file) return this.deviceOf(file);
		const label = hostname().replace(/[^A-Za-z0-9 ._-]/g, "-").trim().slice(0, 40).trim() || "device";
		const fresh: DeviceFile = { v: 1, signSeed: randomBytes(32).toString("hex"), boxSeed: randomBytes(32).toString("hex"), label, nextSeq: 1 };
		const device = this.deviceOf(fresh);
		this.write(this.path("device.json"), JSON.stringify(fresh));
		this.write(this.path("device.id"), `${device.keys.id}\n`);
		return device;
	}
	/** The next `seq` for a queued envelope, saved before it is used, so a crash never reuses one. */
	reserveSeq(): number {
		this.assertLocked("Reserving a sequence number");
		const file = this.readDeviceFile();
		if (!file) throw new Error("There is no device yet");
		this.write(this.path("device.json"), JSON.stringify({ ...file, nextSeq: file.nextSeq + 1 }));
		return file.nextSeq;
	}

	// ---- Team files ----------------------------------------------------------------------------------------------------------------

	teamIds(): string[] {
		try {
			return readdirSync(this.path("teams")).flatMap((n) => (/^[0-9a-f]{32}\.json$/.test(n) ? [n.slice(0, 32)] : [])).sort();
		} catch {
			return [];
		}
	}
	/** The team file, or a TeamFileError: a missing file is never read as an empty one (R-F021), so a device that lost it takes nothing until it joins again. */
	readTeam(team: string): TeamFile {
		if (!HEX16.test(team)) throw new TeamFileError("missing", team);
		const path = this.path("teams", `${team}.json`);
		if (!existsSync(path)) throw new TeamFileError("missing", team);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			throw new TeamFileError("corrupt", team, "not JSON");
		}
		const bad = (detail: string) => new TeamFileError("corrupt", team, detail);
		if (!isObject(raw) || raw.v !== 1) throw bad("version");
		if (raw.team !== team) throw bad("team id");
		if (typeof raw.relay !== "string") throw bad("relay");
		if (!Array.isArray(raw.entries) || raw.entries.some((e) => typeof e !== "string")) throw bad("entries");
		if (!isObject(raw.keys) || Object.entries(raw.keys).some(([epoch, key]) => !/^[1-9][0-9]*$/.test(epoch) || typeof key !== "string" || !HEX32.test(key))) throw bad("keys");
		if (!count(raw.lastEventId)) throw bad("lastEventId");
		if (!isObject(raw.lastSeq) || Object.values(raw.lastSeq).some((n) => !count(n))) throw bad("lastSeq");
		// SAFETY: each field of TeamFile was checked above.
		return raw as unknown as TeamFile;
	}
	/** A reading of the team file that changes when it is replaced (a join again): its modification time and size, or `missing`. */
	teamStamp(team: string): string {
		const st = statSync(this.path("teams", `${team}.json`), { throwIfNoEntry: false });
		return st ? `${st.mtimeMs}:${st.size}` : "missing";
	}
	/** Why a team was stopped and what the team file looked like then; the next holder refuses the team until the file is another one. */
	readStopped(team: string): { reason: string; stamp: string } | undefined {
		if (!HEX16.test(team)) return undefined;
		return this.read(this.path("teams", `${team}.stopped`), (v) => (isObject(v) && typeof v.reason === "string" && typeof v.stamp === "string" ? { reason: v.reason, stamp: v.stamp } : undefined));
	}
	markStopped(team: string, reason: string, stamp: string): void {
		this.assertLocked("Marking a team stopped");
		if (HEX16.test(team)) this.write(this.path("teams", `${team}.stopped`), JSON.stringify({ reason, stamp }));
	}
	clearStopped(team: string): void {
		this.assertLocked("Clearing a team's stopped mark");
		if (HEX16.test(team)) rmSync(this.path("teams", `${team}.stopped`), { force: true });
	}
	/** A new team file (a join or a create). */
	createTeam(file: TeamFile): void {
		this.assertLocked("Creating a team file");
		if (existsSync(this.path("teams", `${file.team}.json`))) throw new Error(`team file ${file.team} exists`);
		this.write(this.path("teams", `${file.team}.json`), JSON.stringify(file));
	}
	/** Replaces a team file that is there. A file that is not is an error, never recreated: its sequence guard is gone with it. */
	writeTeam(file: TeamFile): void {
		this.assertLocked("Writing a team file");
		this.readTeam(file.team);
		this.write(this.path("teams", `${file.team}.json`), JSON.stringify(file));
	}

	// ---- The inbox -----------------------------------------------------------------------------------------------------------------

	putInbox(item: InboxItem): void {
		this.assertLocked("Writing the inbox");
		if (!HEX16.test(item.id)) throw new Error("an inbox id is the envelope id in hex");
		this.write(this.path("inbox", `${item.id}.json`), JSON.stringify(item));
	}
	readInbox(id: string): InboxItem | undefined {
		if (!HEX16.test(id)) return undefined;
		return this.read(this.path("inbox", `${id}.json`), (v) => {
			if (!isObject(v) || v.v !== 1 || v.id !== id || typeof v.team !== "string" || typeof v.from !== "string" || typeof v.fromLabel !== "string" || typeof v.fromShort !== "string") return undefined;
			if (!count(v.seq) || !count(v.sentAt) || !count(v.received) || typeof v.fromWorkspace !== "string" || typeof v.toWorkspace !== "string" || typeof v.replyExpected !== "boolean" || typeof v.text !== "string") return undefined;
			// SAFETY: each field of InboxItem was checked above.
			return v as unknown as InboxItem;
		});
	}
	/** Ids of the waiting messages, the oldest first (a damaged file sorts last). */
	inboxIds(): string[] {
		let names: string[];
		try {
			names = readdirSync(this.path("inbox"));
		} catch {
			return [];
		}
		return names.flatMap((n) => (/^[0-9a-f]{32}\.json$/.test(n) ? [n.slice(0, 32)] : [])).map((id) => ({ id, at: this.readInbox(id)?.received ?? Infinity })).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)).map((x) => x.id);
	}
	removeInbox(id: string): void {
		this.assertLocked("Removing from the inbox");
		if (HEX16.test(id)) rmSync(this.path("inbox", `${id}.json`), { force: true });
	}
	/** Drops what was received more than `maxAgeMs` ago, damaged files too; returns how many. */
	purgeInbox(maxAgeMs: number, now = this.now()): number {
		this.assertLocked("Purging the inbox");
		let gone = 0;
		for (const id of this.inboxIds()) {
			const item = this.readInbox(id);
			if (!item || now - item.received > maxAgeMs) {
				rmSync(this.path("inbox", `${id}.json`), { force: true });
				gone++;
			}
		}
		return gone;
	}

	// ---- The outbox ----------------------------------------------------------------------------------------------------------------

	/** An envelope built and not yet taken by the relay: kept so a holder that ends, or is replaced, does not lose it. */
	putOutbox(team: string, item: { seq: number; id: Buffer; bytes: Uint8Array }): void {
		this.assertLocked("Writing the outbox");
		if (!HEX16.test(team)) throw new Error("an outbox folder is named by the team id in hex");
		mkdirPrivate(this.path("outbox", team));
		this.write(this.path("outbox", team, outboxName(item.seq, item.id)), item.bytes);
	}
	removeOutbox(team: string, item: { seq: number; id: Buffer }): void {
		this.assertLocked("Removing from the outbox");
		if (HEX16.test(team)) rmSync(this.path("outbox", team, outboxName(item.seq, item.id)), { force: true });
	}
	/** The envelopes of a team still waiting to land, in `seq` order. */
	outboxPending(team: string): { seq: number; id: Buffer; bytes: Buffer }[] {
		if (!HEX16.test(team)) return [];
		let names: string[];
		try {
			names = readdirSync(this.path("outbox", team));
		} catch {
			return [];
		}
		return names.flatMap((name) => {
			const m = /^(\d{12})-([0-9a-f]{32})\.bin$/.exec(name);
			if (!m) return [];
			try {
				return [{ seq: Number(m[1]), id: Buffer.from(m[2]!, "hex"), bytes: readFileSync(this.path("outbox", team, name)) }];
			} catch {
				return [];
			}
		}).sort((a, b) => a.seq - b.seq);
	}

	// ---- The log -------------------------------------------------------------------------------------------------------------------

	/** One JSON line: what was dropped and why, a notice raised. Never throws; the log is for an operator, not for the flow. */
	log(entry: Record<string, unknown>): void {
		try {
			const file = this.path("link.log");
			if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > this.logMax) renameSync(file, `${file}.1`);
			appendFileSync(file, `${JSON.stringify({ t: this.now(), ...entry })}\n`, { mode: 0o600 });
		} catch { /* nothing to do about a log that cannot be written */ }
	}
}
