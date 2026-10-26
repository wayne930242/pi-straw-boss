import { chmodSync, lstatSync, realpathSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { alive as signalled, runs } from "../remote.ts";
import { digestOf, MAX_FOUND, MAX_ITEM, MAX_ITEMS } from "./found.ts";
import { CHOICES, type TrustAnswer, type TrustGroup, type TrustRequest, type TrustResult } from "./types.ts";

// The files the asking pi and the server talk through (<state>/trust/, mode 700, files 600 where the OS has modes). Every read checks that the file is a plain file of
// this user and not a link, is no larger than a request may be, and has the shape and the digest it must; anything else is not there.

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, ANSWER_ID = /^[A-Za-z0-9_-]{16,64}$/, ROLES = ["member", "main", "tower", "subagent", "none"];
export const RESULT_KEEP_MS = 120_000, STALE_MS = 60_000, MAX_FILE = MAX_FOUND + 4096;
export const trustDir = (state: string) => join(state, "trust");
const uid = () => process.getuid?.();
const CONFIRM_MS = 30_000, confirmed = new Map<string, number>();
/**
 * `runs`, but a process once confirmed as the one that wrote a request is afterwards looked at by signal alone for 30 s, not by a `ps` per request on every reading
 * (the server reads twice per request on each tick). After that it is confirmed again, so a number the system gives to another process is not taken for long.
 */
export const lives: typeof runs = (r, wrote, start) => {
	const key = `${r.pid}/${r.started}`, at = confirmed.get(key);
	if (at !== undefined && Date.now() - at < CONFIRM_MS) return signalled(r.pid) || (confirmed.delete(key), false);
	const ok = runs(r, wrote, start);
	ok ? confirmed.set(key, Date.now()) : confirmed.delete(key);
	return ok;
};

/**
 * Makes the directory (700) and says whether it is safe to use: a real directory of this user, not a link, not open to others. Where the system has no user ids (Windows)
 * ownership cannot be told, so the directory must lie in the user's own profile, whose folders are private to the user; anywhere else a pi asks in its terminal as before.
 */
export function ensureDir(dir: string, ids = process.getuid !== undefined, home: string = homedir()): boolean {
	try {
		mkdirSync(join(dir, ".."), { recursive: true, mode: 0o700 });
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const st = lstatSync(dir);
		if (!st.isDirectory() || st.isSymbolicLink() || (ids && st.uid !== uid())) return false;
		if (!ids) {
			const inside = relative(realpathSync.native(home), realpathSync.native(dir)); // native expands an 8.3 short name (C:\Users\RUNNER~1), as the JS realpath does not
			if (inside.startsWith("..") || isAbsolute(inside)) return false;
		}
		if (process.platform !== "win32" && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
		return true;
	} catch {
		return false;
	}
}

let temps = 0;
/** Writes `name` in `dir` by rename (mode 600): a reader never sees half a file. On Windows a rename onto a file a reader has open can fail for a moment, so it is tried a few times. */
export function writeAtomic(dir: string, name: string, value: TrustRequest | TrustAnswer | TrustResult) {
	const temp = join(dir, `${name}.${process.pid}.${temps++}.tmp`);
	try {
		writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
		for (let tries = 0; ; tries++) {
			try {
				return renameSync(temp, join(dir, name));
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

/** A file's JSON, or undefined: absent, a link, someone else's, too large, or not JSON. */
export function readJson(file: string, max = MAX_FILE): { value: unknown; mtime: number } | undefined {
	try {
		const st = lstatSync(file);
		if (!st.isFile() || st.size > max || (uid() !== undefined && st.uid !== uid())) return undefined;
		return { value: JSON.parse(readFileSync(file, "utf8")), mtime: st.mtimeMs };
	} catch {
		return undefined;
	}
}

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const groupOk = (g: unknown): g is TrustGroup => {
	const x = g as TrustGroup | null;
	return x !== null && typeof x === "object" && text(x.kind, 32) && text(x.path, 400) && Array.isArray(x.items) && x.items.length <= MAX_ITEMS && x.items.every((i) => text(i, MAX_ITEM * 2)) && Number.isInteger(x.more) && x.more >= 0 && (x.unreadable === undefined || x.unreadable === true);
};
/** A request as the file says it, when it has every field, is for the file's own id, and its digest is the one its folder and findings give. */
export function requestOf(value: unknown, id: string): TrustRequest | undefined {
	const r = value as TrustRequest | null;
	if (r === null || typeof r !== "object" || r.version !== 1 || r.id !== id || !UUID.test(id)) return;
	if (!Number.isInteger(r.pid) || r.pid <= 0 || !text(r.herdr, 1024) || !text(r.pane, 128) || !text(r.cwd, 4096) || !ROLES.includes(r.role) || !Number.isFinite(r.at)) return;
	if (r.started !== undefined && !text(r.started, 64)) return;
	if (!Array.isArray(r.found) || r.found.length > 64 || !r.found.every(groupOk) || r.digest !== digestOf(r.cwd, r.found)) return;
	return r;
}
export function answerOf(value: unknown, request: Pick<TrustRequest, "id" | "digest">): TrustAnswer | undefined {
	const a = value as TrustAnswer | null;
	return a !== null && typeof a === "object" && a.version === 1 && a.id === request.id && a.digest === request.digest && CHOICES.includes(a.choice) && typeof a.answerId === "string" && ANSWER_ID.test(a.answerId) ? a : undefined;
}
export function resultOf(value: unknown, id: string): TrustResult | undefined {
	const r = value as TrustResult | null;
	return r !== null && typeof r === "object" && r.version === 1 && r.id === id && ["remote", "terminal", "gone", "changed"].includes(r.by) && (r.answerId === undefined || (typeof r.answerId === "string" && ANSWER_ID.test(r.answerId))) ? r : undefined;
}

export const requestFile = (id: string) => `${id}.json`, answerFile = (id: string) => `${id}.answer.json`, resultFile = (id: string) => `${id}.result.json`;
export const readRequest = (dir: string, id: string) => ((f) => (f ? requestOf(f.value, id) : undefined))(readJson(join(dir, requestFile(id))));
export const readResult = (dir: string, id: string) => ((f) => (f ? resultOf(f.value, id) : undefined))(readJson(join(dir, resultFile(id)), 4096));
export const remove = (dir: string, ...names: string[]) => names.forEach((n) => rmSync(join(dir, n), { force: true }));

/** Every valid request in the directory whose process still runs (`runs`, with its start time when it has one), oldest first. */
export function listRequests(dir: string, alive: typeof runs = lives): TrustRequest[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const out: TrustRequest[] = [];
	for (const name of names) {
		const id = /^(.+)\.json$/.exec(name)?.[1];
		if (!id || !UUID.test(id)) continue;
		const file = readJson(join(dir, name)), r = file && requestOf(file.value, id);
		if (r && alive(r, file.mtime)) out.push(r);
	}
	return out.sort((a, b) => a.at - b.at);
}

/**
 * Removes what nobody will read: a request whose process is gone or that is not valid (a minute old), an answer for no request, a result two minutes old, and a temporary file a crash left.
 * A request of a live process is never touched.
 */
export function sweep(dir: string, now = Date.now(), alive: typeof runs = lives) {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return;
	}
	const ids = new Set<string>();
	for (const name of names) {
		const file = readJson(join(dir, name), MAX_FILE), age = now - (file?.mtime ?? lstatMtime(join(dir, name)) ?? now), id = name.split(".")[0] ?? "";
		if (name.endsWith(".tmp")) age > STALE_MS && remove(dir, name);
		else if (!UUID.test(id)) continue;
		else if (name === requestFile(id)) {
			const r = file && requestOf(file.value, id);
			if (r ? !alive(r, file.mtime) : age > STALE_MS) remove(dir, name, answerFile(id));
			else if (r) ids.add(id);
		} else if (name === resultFile(id)) age > RESULT_KEEP_MS && remove(dir, name);
	}
	for (const name of names) {
		const id = /^(.+)\.answer\.json$/.exec(name)?.[1];
		if (id && !ids.has(id) && now - (lstatMtime(join(dir, name)) ?? now) > STALE_MS) remove(dir, name);
	}
}
const lstatMtime = (file: string) => {
	try {
		return lstatSync(file).mtimeMs;
	} catch {
		return undefined;
	}
};
