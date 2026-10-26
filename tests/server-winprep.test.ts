import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ensure, lockFor, ServerError } from "../src/server/client.ts";
import { markStarting, prepareSlot, takeLock } from "../src/server/record.ts";
import { ownerSid, protectArgs, protectFolder } from "../src/server/winprep.ts";
import { ServerWorld } from "./server-world.ts";

// docs/specs/2026-10-26-sb-backend.md, The control socket: on Windows the state folder is protected before the first file is created in it (the VM's second pass found the lock, the
// placeholder record, and the log with the parent's inherited ACEs for the first 4 to 7 s of a cold start). Windows is not run here: a fake for the two native calls pins what is called, and when.

const OWNER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());

/** The two native calls, recorded with what the state folder held when each ran. */
function native(dir: () => string, over: { icacls?: Error } = {}) {
	const calls: { file: string; args: string[]; entries: string[] }[] = [];
	const run = (file: string, args: string[]) => {
		calls.push({ file, args, entries: existsSync(dir()) ? readdirSync(dir()) : ["(no folder)"] });
		if (file === "icacls.exe" && over.icacls) throw over.icacls;
		return file === "whoami.exe" ? `"PC\\me","${OWNER}"\r\n` : "";
	};
	return { calls, run };
}

test("the owner's SID is read from whoami's CSV by its shape, never by a name; anything else is refused", () => {
	assert.equal(ownerSid(() => `"DESKTOP-1\\許功","${OWNER}"\r\n`), OWNER);
	assert.throws(() => ownerSid(() => "ERROR: nothing"), /did not give a SID/);
	assert.throws(() => ownerSid(() => ""), /nothing/);
});

test("the folder is protected with the same grant the PowerShell step sets (owner and SYSTEM by SID, no inheritance, passed on), without /T", () => {
	assert.deepEqual(protectArgs("C:\\s", OWNER), ["C:\\s", "/inheritance:r", "/grant:r", `*${OWNER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
	assert.ok(!protectArgs("C:\\s", OWNER).includes("/T"));
});

test("protectFolder makes the folder first, then runs whoami and icacls once each; a second call in the process does nothing, and a folder that was removed is protected again", () => {
	const dir = join(world.root, "fresh", "straw-boss");
	const n = native(() => dir);
	protectFolder(dir, n.run);
	assert.deepEqual(n.calls.map((c) => c.file), ["whoami.exe", "icacls.exe"]);
	assert.deepEqual(n.calls.map((c) => c.entries), [[], []], "the folder existed and was empty when each ran");
	assert.equal(n.calls[1]!.args[0], dir);
	protectFolder(dir, n.run);
	assert.equal(n.calls.length, 2, "once per process");
	rmSync(dir, { recursive: true });
	protectFolder(dir, n.run);
	assert.equal(n.calls.length, 4);
});

test("a folder that cannot be protected is an error naming the reason, and is tried again next time", () => {
	const dir = join(world.root, "denied");
	const bad = native(() => dir, { icacls: new Error("Access is denied.") });
	assert.throws(() => protectFolder(dir, bad.run), /could not protect .*denied.*Access is denied/s);
	assert.throws(() => protectFolder(dir, bad.run), /Access is denied/);
	assert.equal(bad.calls.filter((c) => c.file === "icacls.exe").length, 2);
});

test("the lock is written only after the state folder is protected: icacls runs on an empty folder, then server.lock appears", async () => {
	const n = native(() => world.stateDir);
	const prepare = (slot: typeof world.slot) => prepareSlot(slot, "win32", n.run);
	const lock = await takeLock(world.slot, "test", { ...world.ctx().lock, prepare }, 0);
	assert.deepEqual(n.calls.map((c) => c.file), ["whoami.exe", "icacls.exe"]);
	assert.deepEqual(n.calls[1]!.entries, [], "nothing was in the folder when it was protected");
	assert.ok(readdirSync(world.stateDir).includes("server.lock"));
	lock.release();
});

test("the placeholder record is written only after the state folder is protected", () => {
	const n = native(() => world.stateDir);
	markStarting(world.slot, Date.now(), { pid: 1, version: "0.44.0", desk: false, intercom: { transport: "default" }, mode: "detached", by: "test", prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	assert.deepEqual(n.calls[1]!.entries, []);
	assert.ok(readdirSync(world.stateDir).includes("server.json"));
});

test("a secondary slot's folder (servers/<hash>, which inherits) is made after the state folder is protected, not before", () => {
	const n = native(() => world.stateDir);
	const other = { ...world.slot, primary: false, dir: join(world.stateDir, "servers", "abcd") };
	prepareSlot(other, "win32", n.run);
	assert.deepEqual(n.calls[1]!.entries, [], "no servers/ folder yet when the state folder was protected");
	assert.ok(existsSync(other.dir));
});

test("a start (ensure) on Windows protects the folder before the lock, the placeholder, or the server's log; none of them exists until then", async () => {
	const n = native(() => world.stateDir);
	const done = await ensure(world.ctx({ prepare: (slot) => prepareSlot(slot, "win32", n.run) }), { boss: true });
	assert.ok("server" in done && done.server === "started");
	assert.equal(n.calls.filter((c) => c.file === "icacls.exe").length, 1, "once per process, not at each file");
	assert.deepEqual(n.calls[1]!.entries, []);
});

test("a folder that cannot be protected stops the start before anything is written: ServerError start-failed with an acl start error (exit 3), and no file in the folder", async () => {
	const n = native(() => world.stateDir, { icacls: new Error("Access is denied.") });
	const ctx = world.ctx({ prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	await assert.rejects(ensure(ctx, { boss: true }), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && e.startError?.code === "acl" && /Access is denied/.test(e.message));
	assert.equal(world.spawned.length, 0);
	assert.deepEqual(readdirSync(world.stateDir), [], "nothing was written into the folder that could not be protected");
	await assert.rejects(lockFor(ctx, 0), (e: unknown) => e instanceof ServerError && e.startError?.code === "acl");
});

test("the server protects the folder before its log, and when it cannot it leaves with 3 and writes nothing", async () => {
	const n = native(() => world.stateDir);
	const s = await world.start({ prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	assert.equal(await s.handle.ready, true);
	assert.deepEqual(n.calls[1]!.entries, [], "the log did not exist when the folder was protected");
	await s.handle.shutdown(0);
	const w2 = new ServerWorld();
	try {
		const bad = native(() => w2.stateDir, { icacls: new Error("Access is denied.") });
		const failed = await w2.start({ prepare: (slot) => prepareSlot(slot, "win32", bad.run) });
		assert.equal(await failed.handle.ready, false);
		assert.equal(await failed.handle.done, 3);
		assert.deepEqual(readdirSync(w2.stateDir), []);
	} finally {
		await w2.close();
	}
});

test("elsewhere the folder is the 700 folder and no native call is made", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-wp-"));
	try {
		const n = native(() => dir);
		prepareSlot({ ...world.slot, stateDir: dir, dir: join(dir, "x") }, "linux", n.run);
		assert.equal(n.calls.length, 0);
		assert.ok(existsSync(join(dir, "x")));
		mkdirSync(join(dir, "y"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
