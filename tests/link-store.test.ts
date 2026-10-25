import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LinkStore, LockTimeout, TeamFileError, type InboxItem, type TeamFile } from "../src/link/store.ts";

// Straw Link's files (docs/specs/2026-10-25-straw-link.md, Storage and policy): modes, the lock, the holder record, device keys and the saved
// sequence number, team files (R-F021 fails closed), and the inbox.

let root = "";
const POSIX = process.platform !== "win32";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-link-store-測試-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));
const open = (opts: ConstructorParameters<typeof LinkStore>[1] = {}) => {
	const store = new LinkStore(join(root, "link"), opts);
	store.ensure();
	return store;
};
const mode = (path: string) => statSync(path).mode & 0o777;
const TEAM = "0f".repeat(16);
const team = (over: Partial<TeamFile> = {}): TeamFile => ({ v: 1, team: TEAM, relay: "http://127.0.0.1:1", entries: [], keys: {}, lastEventId: 0, lastSeq: {}, ...over });
const item = (over: Partial<InboxItem> = {}): InboxItem => ({ v: 1, id: "ab".repeat(16), team: TEAM, from: "a".repeat(26), fromLabel: "bob-mac", fromShort: "aaaaaa", seq: 1, sentAt: 1000, received: 2000, fromWorkspace: "api", toWorkspace: "", replyExpected: false, text: "hi", ...over });

test("the link directory, its subdirectories, and every file it writes are private (700 and 600), under a path with non-ASCII characters", { skip: !POSIX && "no modes" }, async () => {
	const store = open();
	await store.withLock(() => {
		store.ensureDevice();
		store.createTeam(team());
		store.putInbox(item());
		store.writeHolder({ session: "s1", version: "1.0.0", pid: process.pid, tower: true, since: 1 });
	});
	for (const dir of [store.dir, join(store.dir, "teams"), join(store.dir, "inbox")]) assert.equal(mode(dir), 0o700, dir);
	for (const file of ["device.json", "device.id", "holder.json", join("teams", `${TEAM}.json`), join("inbox", `${"ab".repeat(16)}.json`)]) assert.equal(mode(join(store.dir, file)), 0o600, file);
	assert.ok(!readdirSync(store.dir).some((n) => n.endsWith(".tmp")), "no temp file left behind");
});

test("withLock runs one function at a time within a process, in call order, and a throw releases the lock", async () => {
	const store = open(), order: string[] = [];
	const a = store.withLock(async () => (order.push("a1"), await new Promise((r) => setTimeout(r, 30)), order.push("a2")));
	const b = store.withLock(() => void order.push("b"));
	await Promise.all([a, b]);
	assert.deepEqual(order, ["a1", "a2", "b"]);
	await assert.rejects(store.withLock(() => { throw new Error("boom"); }), /boom/);
	assert.ok(!existsSync(join(store.dir, "holder.lock")));
	await store.withLock(() => void order.push("after"));
	assert.equal(order.at(-1), "after");
});

test("two processes updating one file under the lock lose no update", async () => {
	const dir = join(root, "link");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "counter.txt"), "0");
	const run = () => new Promise<number | null>((resolve) => spawn(process.execPath, [new URL("./link/lock-child.ts", import.meta.url).pathname, dir, "40"], { stdio: "inherit" }).on("exit", resolve));
	assert.deepEqual(await Promise.all([run(), run(), run()]), [0, 0, 0]);
	assert.equal(readFileSync(join(dir, "counter.txt"), "utf8"), "120");
});

test("a lock whose owner is gone is taken over at once; a live owner's fresh lock blocks until the wait runs out; an old lock of a live pid is stale", async () => {
	const dead = open({ alive: () => false });
	writeFileSync(join(dead.dir, "holder.lock"), JSON.stringify({ pid: 99999999, token: "x", t: Date.now() }));
	await dead.withLock(() => undefined);

	const live = open({ alive: () => true });
	writeFileSync(join(live.dir, "holder.lock"), JSON.stringify({ pid: 1, token: "x", t: Date.now() }));
	await assert.rejects(live.withLock(() => undefined, 150), LockTimeout);
	const old = new Date(Date.now() - 60_000);
	utimesSync(join(live.dir, "holder.lock"), old, old);
	await live.withLock(() => undefined, 150);
});

test("a write to the holder record, a team file, the inbox, or the device file outside the lock is refused, so no write can skip it", async () => {
	const store = open();
	assert.throws(() => store.writeHolder({ session: "s", version: "1", pid: 1, tower: false, since: 1 }), /lock/);
	assert.throws(() => store.createTeam(team()), /lock/);
	assert.throws(() => store.putInbox(item()), /lock/);
	assert.throws(() => store.ensureDevice(), /lock/);
	assert.throws(() => store.reserveSeq(), /lock/);
	await store.withLock(() => store.createTeam(team()));
	assert.throws(() => store.writeTeam(team({ lastEventId: 5 })), /lock/);
	// A function that outlives its lock cannot write either.
	let late: (() => void) | undefined;
	await store.withLock(() => void (late = () => store.writeTeam(team({ lastEventId: 9 }))));
	assert.throws(() => late!(), /lock/);
	assert.equal(store.readTeam(TEAM).lastEventId, 0);
});

test("the holder record round-trips, a damaged one reads as none, and it clears only when it matches", async () => {
	const store = open();
	assert.equal(store.readHolder(), undefined);
	const rec = { session: "s1", version: "0.43.0", pid: 4242, started: "Mon Oct 26 00:00:00 2026", tower: true, since: 1700 };
	await store.withLock(() => store.writeHolder(rec));
	assert.deepEqual(store.readHolder(), rec);
	await store.withLock(() => assert.equal(store.clearHolder((r) => r.session === "other"), false));
	assert.ok(store.readHolder());
	await store.withLock(() => assert.equal(store.clearHolder((r) => r.session === "s1"), true));
	assert.equal(store.readHolder(), undefined);
	writeFileSync(join(store.dir, "holder.json"), "{not json");
	assert.equal(store.readHolder(), undefined);
	writeFileSync(join(store.dir, "holder.json"), JSON.stringify({ session: 5 }));
	assert.equal(store.readHolder(), undefined);
});

test("the device is made once, its id is written for an infra to read, and the next sequence number is saved before it is used", async () => {
	const store = open();
	assert.equal(store.device(), undefined, "reading never creates");
	const made = await store.withLock(() => store.ensureDevice());
	assert.match(made.keys.id, /^[a-z2-7]{26}$/);
	assert.equal(readFileSync(join(store.dir, "device.id"), "utf8").trim(), made.keys.id);
	assert.match(made.label, /^[A-Za-z0-9 ._-]{1,40}$/);
	const again = await store.withLock(() => store.ensureDevice());
	assert.equal(again.keys.id, made.keys.id);
	assert.deepEqual(await store.withLock(() => [store.reserveSeq(), store.reserveSeq(), store.reserveSeq()]), [1, 2, 3]);
	// A new process (a new store on the same directory) goes on from the saved number, and the keys are the same.
	const next = new LinkStore(store.dir);
	assert.equal(await next.withLock(() => next.reserveSeq()), 4);
	assert.equal(next.device()!.keys.id, made.keys.id);
	assert.deepEqual(next.device()!.keys.signSeed, made.keys.signSeed);
	// A device file that is damaged is an error, never a fresh identity.
	writeFileSync(join(store.dir, "device.json"), "{broken");
	assert.throws(() => next.device(), /device\.json/);
	await assert.rejects(next.withLock(() => next.ensureDevice()), /device\.json/);
});

test("R-F021: a team file keeps the per-sender high-water mark; a missing file or a file without it fails closed, and nothing creates a file by writing", async () => {
	const store = open();
	assert.throws(() => store.readTeam(TEAM), (e: unknown) => e instanceof TeamFileError && e.code === "missing");
	await assert.rejects(store.withLock(() => store.writeTeam(team())), (e: unknown) => e instanceof TeamFileError && e.code === "missing");
	assert.ok(!existsSync(join(store.dir, "teams", `${TEAM}.json`)), "a write never makes the file: a lost file means joining again");
	await store.withLock(() => store.createTeam(team({ lastSeq: { [`${"a".repeat(26)}`]: 7 }, lastEventId: 12, keys: { "1": "11".repeat(32) } })));
	assert.deepEqual(store.readTeam(TEAM).lastSeq, { ["a".repeat(26)]: 7 });
	assert.equal(store.readTeam(TEAM).lastEventId, 12);
	assert.deepEqual(store.teamIds(), [TEAM]);
	await assert.rejects(store.withLock(() => store.createTeam(team())), /exists/);
	const path = join(store.dir, "teams", `${TEAM}.json`);
	for (const bad of [{ ...team(), lastSeq: undefined }, { ...team(), lastSeq: { x: -1 } }, { ...team(), lastSeq: { x: "7" } }, { ...team(), lastEventId: -1 }, { ...team(), entries: "no" }, { ...team(), team: "zz" }, { ...team(), keys: { "1": "short" } }]) {
		writeFileSync(path, JSON.stringify(bad));
		assert.throws(() => store.readTeam(TEAM), (e: unknown) => e instanceof TeamFileError && e.code === "corrupt", JSON.stringify(bad));
	}
	writeFileSync(path, "not json");
	assert.throws(() => store.readTeam(TEAM), (e: unknown) => e instanceof TeamFileError && e.code === "corrupt");
});

test("the inbox holds a message once per envelope id, lists oldest first, removes, and purges what is older than 7 days", async () => {
	const store = open(), day = 86_400_000;
	const [a, b, c] = ["01", "02", "03"].map((n) => n.repeat(16));
	await store.withLock(() => {
		store.putInbox(item({ id: a, received: 3000 }));
		store.putInbox(item({ id: b, received: 1000 }));
		store.putInbox(item({ id: c, received: 2000, text: "once" }));
		store.putInbox(item({ id: c, received: 2000, text: "once" }));
	});
	assert.deepEqual(store.inboxIds(), [b, c, a]);
	assert.equal(store.readInbox(c)?.text, "once");
	await store.withLock(() => {
		assert.equal(store.purgeInbox(7 * day, 1000 + 7 * day + 1), 1, "only the one received at 1000");
		store.removeInbox(a);
	});
	assert.deepEqual(store.inboxIds(), [c]);
	assert.equal(store.readInbox(a), undefined);
	writeFileSync(join(store.dir, "inbox", `${"09".repeat(16)}.json`), "garbage");
	assert.equal(store.readInbox("09".repeat(16)), undefined, "a damaged item reads as none");
	assert.equal(store.readInbox("../../x"), undefined, "an id is hex, never a path");
});

test("the link log appends one JSON line per entry and keeps itself bounded", async () => {
	const store = open({ logMax: 400 });
	for (let i = 0; i < 30; i++) store.log({ event: "drop", reason: "stale-seq", i });
	const lines = readFileSync(join(store.dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { event: string; reason: string; t: number; i: number });
	assert.equal(lines.at(-1)!.i, 29);
	assert.ok(lines.every((l) => l.event === "drop" && typeof l.t === "number"));
	assert.ok(existsSync(join(store.dir, "link.log.1")), "rotated once past the cap");
	assert.ok(statSync(join(store.dir, "link.log")).size <= 400 + 120);
});

test("SLH-F005: the outbox keeps envelopes private, one file per envelope, listed in seq order, written and removed only under the lock", { skip: !POSIX && "no modes" }, async () => {
	const store = open(), id = (n: number) => Buffer.alloc(16, n);
	assert.deepEqual(store.outboxPending(TEAM), []);
	assert.throws(() => store.putOutbox(TEAM, { seq: 1, id: id(1), bytes: Buffer.from("x") }), /under the Straw Link lock/);
	await store.withLock(() => {
		store.putOutbox(TEAM, { seq: 10, id: id(2), bytes: Buffer.from("ten") });
		store.putOutbox(TEAM, { seq: 9, id: id(1), bytes: Buffer.from("nine") });
	});
	assert.equal(mode(join(store.dir, "outbox", TEAM)), 0o700);
	for (const name of readdirSync(join(store.dir, "outbox", TEAM))) assert.equal(mode(join(store.dir, "outbox", TEAM, name)), 0o600, name);
	assert.deepEqual(store.outboxPending(TEAM).map((e) => [e.seq, e.bytes.toString()]), [[9, "nine"], [10, "ten"]], "numeric order, not the order written");
	await store.withLock(() => store.removeOutbox(TEAM, { seq: 9, id: id(1) }));
	assert.deepEqual(store.outboxPending(TEAM).map((e) => e.seq), [10]);
});
