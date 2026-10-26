import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	clearStartError, clearStopped, defaultHerdr, fileOf, FRESH_MS, holderAlive, LOCK_MAX_MS, LockBusy, type LockInfo, readLock, readRecord, readStartError, restartingFresh,
	restartingNow, type ServerRecord, serverId, slotOf, takeLock, touchRestarting, towerId, towerName, updateRecord, writeRecord, writeStartError,
} from "../src/server/record.ts";

// docs/specs/2026-10-26-sb-backend.md, Process model and lifecycle: one server per (state directory, Herdr socket), server.json, server.lock, start-error.json.

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-server-record-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const HOME = "/home/boss";
const env = (extra: Record<string, string> = {}) => ({ HOME: HOME, ...extra });
const record = (over: Partial<ServerRecord> = {}): ServerRecord => ({
	pid: 4242, started: "T0", version: "0.44.0", herdr: "/h/herdr.sock", mode: "detached", desk: false, intercom: {}, log: "/s/server.log", socket: "/s/server.sock", secret: "s".repeat(64), intercomId: "sb-server-12345678", ...over,
});

// --- slots ---

test("the default Herdr is the primary slot and keeps its files in the state directory; its tower ids carry no slot", () => {
	const slot = slotOf(root, env(), "linux");
	assert.equal(slot.herdr, `${HOME}/.config/herdr/herdr.sock`);
	assert.equal(slot.primary, true);
	assert.equal(slot.dir, root);
	assert.equal(towerId(slot, "W1"), "sb-tower-w1");
	assert.equal(towerName(slot, "Alpha"), "tower · Alpha");
	// A shell that sets HERDR_SOCKET_PATH to the default socket's own path is on the default Herdr too.
	assert.equal(slotOf(root, env({ HERDR_SOCKET_PATH: `${HOME}/.config/herdr/herdr.sock` }), "linux").primary, true);
	assert.equal(defaultHerdr(env({ HERDR_SESSION: "scratch" }), "linux"), `${HOME}/.config/herdr/herdr.sock`);
});

test("any other Herdr socket is a secondary slot under servers/<hash>/ whose tower ids and names carry the slot (two Herdr servers that both have w1)", () => {
	const primary = slotOf(root, env(), "linux"), named = slotOf(root, env({ HERDR_SESSION: "scratch" }), "linux"), custom = slotOf(root, env({ HERDR_SOCKET_PATH: "/tmp/other.sock" }), "linux");
	for (const slot of [named, custom]) {
		assert.equal(slot.primary, false);
		assert.match(slot.hash, /^[0-9a-f]{16}$/);
		assert.equal(slot.slot8, slot.hash.slice(0, 8));
		assert.equal(slot.dir, join(root, "servers", slot.hash));
		assert.equal(towerId(slot, "w1"), `sb-tower-${slot.slot8}-w1`);
		assert.equal(towerName(slot, "Alpha"), `tower · Alpha · ${slot.slot8}`);
		assert.notEqual(towerId(slot, "w1"), towerId(primary, "w1"));
	}
	assert.notEqual(named.hash, custom.hash);
	assert.notEqual(serverId(named), serverId(primary));
	assert.match(serverId(named), /^sb-server-[0-9a-f]{8}$/);
	// The same socket always gives the same slot, so a restart finds its files.
	assert.deepEqual(slotOf(root, env({ HERDR_SOCKET_PATH: "/tmp/other.sock" }), "linux"), custom);
});

test("on Windows the default Herdr is the one under the APPDATA of the environment", () => {
	const e = { APPDATA: "C:\\Users\\boss\\AppData\\Roaming" };
	assert.equal(slotOf(root, e, "win32").primary, true);
	assert.equal(slotOf(root, { ...e, HERDR_SESSION: "x" }, "win32").primary, false);
});

// --- server.json ---

test("server.json is written by rename, mode 600, and read back; a file without pid, socket, and secret is no record", () => {
	const slot = slotOf(root, env(), "linux");
	assert.equal(readRecord(slot), undefined);
	writeRecord(slot, record());
	assert.deepEqual(readRecord(slot), record());
	assert.equal(statSync(fileOf(slot, "record")).mode & 0o777, 0o600);
	writeFileSync(fileOf(slot, "record"), JSON.stringify({ pid: 1 }));
	assert.equal(readRecord(slot), undefined);
	writeFileSync(fileOf(slot, "record"), "{ half");
	assert.equal(readRecord(slot), undefined);
});

test("restarting: a fresh one is within 10 s of its last touch; a start keeps began, reason, and by and moves only since", () => {
	const t0 = Date.parse("2026-10-26T08:00:00.000Z");
	const under = { began: "2026-10-26T08:00:00.000Z", since: "2026-10-26T08:00:04.000Z", reason: "upgrade", by: "session main" };
	assert.equal(restartingFresh(record({ restarting: under }), t0 + 4000 + FRESH_MS), true);
	assert.equal(restartingFresh(record({ restarting: under }), t0 + 4000 + FRESH_MS + 1), false, "no touch for 10 s: the record counts as gone");
	assert.equal(restartingFresh(record(), t0), false);
	assert.deepEqual(restartingNow(under, t0 + 6000, { reason: "starting", by: "cli" }), { ...under, since: "2026-10-26T08:00:06.000Z" });
	// A stale one is a leftover: a start that finds it begins its own.
	assert.deepEqual(restartingNow(under, t0 + 60_000, { reason: "starting", by: "cli" }), { began: "2026-10-26T08:01:00.000Z", since: "2026-10-26T08:01:00.000Z", reason: "starting", by: "cli" });
	assert.deepEqual(restartingNow(undefined, t0, { reason: "starting", by: "cli" }), { began: "2026-10-26T08:00:00.000Z", since: "2026-10-26T08:00:00.000Z", reason: "starting", by: "cli" });
});

test("touchRestarting moves only since, only while a restarting is there, and only the one asked for", () => {
	const slot = slotOf(root, env(), "linux");
	writeRecord(slot, record());
	assert.equal(touchRestarting(slot, Date.parse("2026-10-26T08:00:09.000Z")), false, "nothing under way: nothing written");
	const under = { began: "2026-10-26T08:00:00.000Z", since: "2026-10-26T08:00:00.000Z", reason: "restart for a reason", by: "main (id 1)" };
	writeRecord(slot, record({ restarting: under }));
	assert.equal(touchRestarting(slot, Date.parse("2026-10-26T08:00:02.000Z"), "2026-10-26T07:00:00.000Z"), false, "another restart's began");
	assert.equal(touchRestarting(slot, Date.parse("2026-10-26T08:00:02.000Z"), under.began), true);
	assert.deepEqual(readRecord(slot)?.restarting, { ...under, since: "2026-10-26T08:00:02.000Z" });
	assert.equal(readRecord(slot)?.pid, 4242);
});

test("sbr-F002: touchRestarting writes only when the record is the one the requester expects (pid and secret), so a stale read never overwrites a newer server's record", () => {
	const slot = slotOf(root, env(), "linux");
	const under = { began: "2026-10-26T08:00:00.000Z", since: "2026-10-26T08:00:00.000Z", reason: "r", by: "b" };
	writeRecord(slot, record({ restarting: under }));
	const t = Date.parse("2026-10-26T08:00:02.000Z");
	assert.equal(touchRestarting(slot, t, under.began, { pid: 4242, secret: "s".repeat(64) }), true, "the old server's record");
	// The new server wrote its own record meanwhile (another pid and secret): the requester's touch is not applied.
	writeRecord(slot, record({ pid: 5151, secret: "n".repeat(64), restarting: under }));
	assert.equal(touchRestarting(slot, t + 2000, under.began, { pid: 4242, secret: "s".repeat(64) }), false);
	assert.equal(readRecord(slot)?.pid, 5151);
	assert.equal(readRecord(slot)?.restarting?.since, under.since);
});

test("start-error.json belongs to one attempt: written, read, and cleared", () => {
	const slot = slotOf(root, env(), "linux");
	assert.equal(readStartError(slot), undefined);
	mkdirSync(slot.dir, { recursive: true });
	writeStartError(slot, { code: "loader", text: "tsx was not found from /x" }, Date.parse("2026-10-26T08:00:00.000Z"));
	assert.deepEqual(readStartError(slot), { at: "2026-10-26T08:00:00.000Z", code: "loader", text: "tsx was not found from /x" });
	clearStartError(slot);
	assert.equal(readStartError(slot), undefined);
	assert.doesNotThrow(() => clearStartError(slot));
});

test("clearStopped clears stopped in server.json and gui.stopped, and in gui.json of the primary slot only", () => {
	const primary = slotOf(root, env(), "linux");
	writeRecord(primary, record({ stopped: true, gui: { port: 5000, token: "t", stopped: true } }));
	writeFileSync(join(root, "gui.json"), JSON.stringify({ pid: 1, port: 5000, token: "t", owner: "o", stopped: true }));
	assert.equal(clearStopped(primary), true);
	assert.deepEqual(readRecord(primary)?.stopped, undefined);
	assert.equal(readRecord(primary)?.gui?.stopped, undefined);
	assert.equal(readRecord(primary)?.gui?.port, 5000);
	assert.equal(JSON.parse(readFileSync(join(root, "gui.json"), "utf8")).stopped, undefined);
	assert.equal(JSON.parse(readFileSync(join(root, "gui.json"), "utf8")).port, 5000);
	assert.equal(clearStopped(primary), false, "nothing left to clear");
	// A secondary slot has no gui.json of the contract: its own folder is left alone and the primary's file is not touched.
	writeFileSync(join(root, "gui.json"), JSON.stringify({ pid: 1, port: 5000, token: "t", owner: "o", stopped: true }));
	const secondary = slotOf(root, env({ HERDR_SESSION: "scratch" }), "linux");
	mkdirSync(secondary.dir, { recursive: true });
	writeRecord(secondary, record({ stopped: true }));
	assert.equal(clearStopped(secondary), true);
	assert.equal(JSON.parse(readFileSync(join(root, "gui.json"), "utf8")).stopped, true);
});

test("updateRecord leaves the file alone when the change answers nothing", () => {
	const slot = slotOf(root, env(), "linux");
	writeRecord(slot, record());
	const before = statSync(fileOf(slot, "record")).mtimeMs;
	assert.equal(updateRecord(slot, () => undefined)?.pid, 4242);
	assert.equal(statSync(fileOf(slot, "record")).mtimeMs, before);
	assert.equal(updateRecord(slotOf(join(root, "nothing"), env(), "linux"), () => record()), undefined);
});

// --- server.lock ---

const ME = { pid: process.pid, started: async () => "T-me" };
function lockWorld() {
	const w = { now: 1_000_000, dead: new Set<number>(), starts: new Map<number, string>(), notes: [] as string[] };
	const deps = {
		now: () => w.now, alive: (pid: number) => !w.dead.has(pid), startOf: (pid: number) => w.starts.get(pid), self: ME,
		sleep: async (ms: number) => void (w.now += ms), note: (event: string) => void w.notes.push(event),
	};
	return { w, deps };
}
const lockOf = (slot: ReturnType<typeof slotOf>) => readLock(slot)!;
function plant(slot: ReturnType<typeof slotOf>, info: LockInfo) {
	mkdirSync(slot.dir, { recursive: true });
	writeFileSync(fileOf(slot, "lock"), JSON.stringify(info));
}

test("two starts at once start one: the second finds the lock held and, with no wait, is told so", async () => {
	const slot = slotOf(root, env(), "linux"), { deps } = lockWorld();
	const first = await takeLock(slot, "session a", deps);
	assert.equal(lockOf(slot).by, "session a");
	assert.equal(lockOf(slot).pid, process.pid);
	await assert.rejects(takeLock(slot, "session b", deps), (e: unknown) => e instanceof LockBusy && e.holder?.by === "session a");
	first.release();
	assert.equal(existsSync(fileOf(slot, "lock")), false);
	const second = await takeLock(slot, "session b", deps);
	second.release();
});

test("a lock whose holder is alive is kept however long it takes, even past 10 s and a minute", async () => {
	const slot = slotOf(root, env(), "linux"), { w, deps } = lockWorld();
	plant(slot, { pid: 777, started: "T-777", by: "up", since: new Date(w.now - 90_000).toISOString() });
	w.starts.set(777, "T-777");
	await assert.rejects(takeLock(slot, "session", deps, 200), LockBusy);
	assert.equal(lockOf(slot).pid, 777, "a start that takes 25 s (or 90 s) is not raced");
});

test("a lock whose holder is dead, or whose pid now belongs to a process that started at another time, is taken over", async () => {
	const slot = slotOf(root, env(), "linux"), { w, deps } = lockWorld();
	plant(slot, { pid: 777, started: "T-777", by: "up", since: new Date(w.now - 1000).toISOString() });
	w.dead.add(777);
	const dead = await takeLock(slot, "session", deps);
	assert.equal(lockOf(slot).pid, process.pid);
	assert.deepEqual(w.notes, ["lock-taken-over"]);
	dead.release();
	plant(slot, { pid: 778, started: "T-old", by: "up", since: new Date(w.now - 1000).toISOString() });
	w.starts.set(778, "T-new");
	(await takeLock(slot, "session", deps)).release();
	assert.equal(w.notes.length, 2, "a reused pid is not the holder");
});

test("a lock older than 120 s is taken over even from a live holder, and the taker says so", async () => {
	const slot = slotOf(root, env(), "linux"), { w, deps } = lockWorld();
	plant(slot, { pid: 777, started: "T-777", by: "up", since: new Date(w.now - LOCK_MAX_MS - 1).toISOString() });
	w.starts.set(777, "T-777");
	const lock = await takeLock(slot, "session", deps);
	assert.equal(lockOf(slot).by, "session");
	assert.deepEqual(w.notes, ["lock-taken-over"]);
	lock.release();
});

test("a lock that cannot be read is left while it is young (it is being written) and taken once it is garbage", async () => {
	const slot = slotOf(root, env(), "linux"), { deps } = lockWorld();
	mkdirSync(slot.dir, { recursive: true });
	writeFileSync(fileOf(slot, "lock"), "{ half");
	await assert.rejects(takeLock(slot, "session", { ...deps, now: () => Date.now() }, 0), LockBusy);
	const old = new Date(Date.now() - 60_000);
	utimesSync(fileOf(slot, "lock"), old, old);
	(await takeLock(slot, "session", { ...deps, now: () => Date.now() })).release();
});

test("one looker decides a takeover at a time: a looker that finds server.lock.stale held leaves the lock alone", async () => {
	const slot = slotOf(root, env(), "linux"), { w, deps } = lockWorld();
	plant(slot, { pid: 777, started: "T-777", by: "up", since: new Date(w.now - 1000).toISOString() });
	w.dead.add(777);
	writeFileSync(fileOf(slot, "stale"), "999", { mode: 0o600 });
	await assert.rejects(takeLock(slot, "session", deps, 100), LockBusy);
	assert.equal(lockOf(slot).pid, 777);
	// A looker that died inside the section leaves its marker; one a few seconds old is not at work any more.
	const old = new Date(Date.now() - 60_000);
	utimesSync(fileOf(slot, "stale"), old, old);
	(await takeLock(slot, "session", { ...deps, now: () => Date.now() + 0 }, 1000)).release();
});

test("release removes only the lock it took", async () => {
	const slot = slotOf(root, env(), "linux"), { w, deps } = lockWorld();
	const mine = await takeLock(slot, "a", deps);
	w.dead.add(process.pid);
	w.now += LOCK_MAX_MS + 10;
	const other = await takeLock(slot, "b", { ...deps, alive: () => true });
	mine.release();
	assert.equal(lockOf(slot).by, "b", "a holder that lost its lock does not remove the new holder's");
	other.release();
});

test("a lock wait ends when the lock is released", async () => {
	const slot = slotOf(root, env(), "linux"), { w, deps } = lockWorld();
	const first = await takeLock(slot, "a", deps);
	let slept = 0;
	const second = await takeLock(slot, "b", { ...deps, sleep: async () => { if (++slept === 3) first.release(); w.now += 10; } }, 5000);
	assert.equal(slept, 3);
	second.release();
});

test("holderAlive: a dead pid is not a holder; an unknown start time lets the record stand", () => {
	const info = { pid: 5, started: "T", by: "x", since: "s" };
	assert.equal(holderAlive(info, { alive: () => false }), false);
	assert.equal(holderAlive(info, { alive: () => true, startOf: () => undefined }), true);
	assert.equal(holderAlive(info, { alive: () => true, startOf: () => "T" }), true);
	assert.equal(holderAlive(info, { alive: () => true, startOf: () => "U" }), false);
	assert.equal(holderAlive({ ...info, started: undefined }, { alive: () => true, startOf: () => "U" }), true);
});
