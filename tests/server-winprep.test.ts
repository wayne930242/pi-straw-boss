import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ensure, lockFor, ServerError } from "../src/server/client.ts";
import { markStarting, prepareSlot, takeLock } from "../src/server/record.ts";
import { forgetSid, ownerArgs, ownerSid, protectArgs, protectFolder, readDacl, refuseLink } from "../src/server/winprep.ts";
import { ServerWorld } from "./server-world.ts";

// docs/specs/2026-10-26-sb-backend.md, The control socket: on Windows the state folder is protected before the first file is created in it (the VM's second pass found the lock, the
// placeholder record, and the log with the parent's inherited ACEs for the first 4 to 7 s of a cold start), at every start, and its DACL is read back before anything is written.
// Windows is not run here: a fake for the native calls pins what is called, and when.

const OWNER = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const GOOD = `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})`;
let world: ServerWorld;
beforeEach(() => {
	world = new ServerWorld();
	forgetSid();
});
afterEach(() => world.close());

interface Call { file: string; args: string[]; entries: string[]; timeoutMs: number | undefined }
/** The native calls, recorded with what the state folder held when each ran; `/save` writes the DACL the folder "has" (`dacl`) the way icacls does, in UTF-16. */
function native(dir: () => string, over: { icacls?: Error; dacl?: string; whoami?: string } = {}) {
	const calls: Call[] = [];
	const run = (file: string, args: string[], timeoutMs?: number) => {
		calls.push({ file, args, entries: existsSync(dir()) ? readdirSync(dir()) : ["(no folder)"], timeoutMs });
		if (file === "whoami.exe") return over.whoami ?? `"PC\\me","${OWNER}"\r\n`;
		if (over.icacls && !args.includes("/save")) throw over.icacls;
		if (args.includes("/save")) writeFileSync(args[args.indexOf("/save") + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\n${over.dacl ?? GOOD}\r\n`, "utf16le")]));
		return "";
	};
	return { calls, run, files: () => calls.map((c) => c.file) };
}

test("the owner's SID is read from whoami's CSV by its shape, never by a name; anything else is refused", () => {
	assert.equal(ownerSid(() => `"DESKTOP-1\\許功","${OWNER}"\r\n`), OWNER);
	assert.throws(() => ownerSid(() => "ERROR: nothing"), /did not give a SID/);
	assert.throws(() => ownerSid(() => ""), /nothing/);
});

test("N1: the owner is set and the folder protected in two calls, each a documented icacls form: /setowner alone, then /inheritance:r /grant:r (owner and SYSTEM by SID, passed on), without /T", () => {
	assert.deepEqual(ownerArgs("C:\\s", OWNER), ["C:\\s", "/setowner", `*${OWNER}`, "/Q"]);
	assert.deepEqual(protectArgs("C:\\s", OWNER), ["C:\\s", "/inheritance:r", "/grant:r", `*${OWNER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"]);
	for (const args of [ownerArgs("C:\\s", OWNER), protectArgs("C:\\s", OWNER)]) assert.ok(!args.includes("/T"));
	assert.ok(!protectArgs("C:\\s", OWNER).includes("/setowner"), "the grant form never carries /setowner");
});

test("protectFolder makes the folder, protects it, and reads the DACL back, all before anything is written; every call finds the folder empty", () => {
	const dir = join(world.root, "fresh", "straw-boss");
	const n = native(() => dir);
	protectFolder(dir, n.run);
	assert.deepEqual(n.files(), ["whoami.exe", "icacls.exe", "icacls.exe", "icacls.exe"]);
	assert.deepEqual(n.calls.map((c) => c.entries), [[], [], [], []]);
	assert.deepEqual(n.calls[1]!.args, ownerArgs(dir, OWNER));
	assert.deepEqual(n.calls[2]!.args, protectArgs(dir, OWNER));
	assert.deepEqual(n.calls[3]!.args.slice(0, 2), [dir, "/save"]);
});

test("F006: only the SID is kept between starts: the folder is protected and read back at every start, also one that was removed and made again by other code", () => {
	const dir = join(world.root, "again", "straw-boss");
	const n = native(() => dir);
	protectFolder(dir, n.run);
	protectFolder(dir, n.run);
	assert.deepEqual(n.files(), ["whoami.exe", "icacls.exe", "icacls.exe", "icacls.exe", "icacls.exe", "icacls.exe", "icacls.exe"], "whoami once, then icacls three times per start");
	rmSync(dir, { recursive: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "planted.txt"), "x");
	protectFolder(dir, n.run);
	assert.equal(n.calls.filter((c) => c.file === "icacls.exe").length, 9);
	assert.deepEqual(n.calls.at(-2)!.entries, ["planted.txt"], "what other code put there is not ours to hide: the check is of the DACL");
});

test("F006: a folder whose DACL has a foreign ACE, is not protected, or is not readable after the call is refused (folderProblems), before anything is written", () => {
	const dir = join(world.root, "foreign", "straw-boss");
	for (const [dacl, text] of [
		[`D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})(A;OICI;0x1200a9;;;BU)`, /BU/],
		[`D:(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})`, /not protected/],
		[`D:P(A;OICI;FA;;;SY)`, /grants nothing to/],
		["not sddl", /cannot be read|no SDDL/],
	] as const) {
		forgetSid();
		const bad = native(() => dir, { dacl });
		assert.throws(() => protectFolder(dir, bad.run), (e: unknown) => text.test((e as Error).message) && /could not protect/.test((e as Error).message), dacl);
	}
});

test("F006: /save's file is UTF-16 with a byte-order mark or plain, and the temporary file is removed", () => {
	const dir = join(world.root, "d");
	const n = native(() => dir);
	assert.equal(readDacl(dir, n.run), GOOD);
	const before = readdirSync(tmpdir()).filter((f) => f.startsWith("sb-acl-")).length;
	readDacl(dir, n.run);
	assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith("sb-acl-")).length, before, "the file is gone");
	assert.throws(() => readDacl(dir, (_f, args) => (writeFileSync(args[args.indexOf("/save") + 1]!, "nothing here"), "")), /wrote no SDDL/);
});

test("F006: a folder that is a link or junction is refused, and so are servers/ and servers/<hash> of a secondary slot", () => {
	const real = mkdtempSync(join(tmpdir(), "psb-link-"));
	try {
		const link = join(world.root, "link-to-elsewhere");
		symlinkSync(real, link);
		assert.throws(() => refuseLink(link), /link or junction/);
		assert.doesNotThrow(() => refuseLink(real));
		assert.doesNotThrow(() => refuseLink(join(real, "missing")));
		const n = native(() => link);
		assert.throws(() => protectFolder(link, n.run), /link or junction/);
		assert.equal(n.calls.length, 0, "nothing is run against a link's target");
		const other = { ...world.slot, primary: false, dir: join(world.stateDir, "servers", "abcd") };
		mkdirSync(join(world.stateDir, "servers"), { recursive: true });
		symlinkSync(real, other.dir);
		assert.throws(() => prepareSlot(other, "win32", native(() => world.stateDir).run), /link or junction/);
	} finally {
		rmSync(real, { recursive: true, force: true });
	}
});

test("a failing native call is an error naming the reason, and the next start tries again", () => {
	const dir = join(world.root, "denied");
	const bad = native(() => dir, { icacls: new Error("Access is denied.") });
	assert.throws(() => protectFolder(dir, bad.run), /could not protect .*denied.*Access is denied/s);
	assert.throws(() => protectFolder(dir, bad.run), /Access is denied/);
	assert.equal(bad.calls.filter((c) => c.file === "icacls.exe").length, 2);
});

test("F004: the native calls share one time: each gets what is left of it (at least 100 ms), not the whole of it again", () => {
	const dir = join(world.root, "timed", "straw-boss");
	let t = 0;
	const n = native(() => dir);
	const slow = (file: string, args: string[], ms?: number) => { const out = n.run(file, args, ms); t += 400; return out; };
	protectFolder(dir, slow, 1000, () => t);
	assert.deepEqual(n.calls.map((c) => c.timeoutMs), [1000, 600, 200, 100]);
	forgetSid();
	const plain = native(() => dir);
	protectFolder(dir, plain.run, undefined, () => t);
	assert.deepEqual(plain.calls.map((c) => c.timeoutMs), [undefined, undefined, undefined, undefined], "no time given, no bound");
});

test("N1: a folder swapped for a link while the icacls calls ran is refused before its DACL is read or anything is written", () => {
	const real = mkdtempSync(join(tmpdir(), "psb-swap-"));
	const dir = join(world.root, "swapped", "straw-boss");
	try {
		const n = native(() => dir);
		const swapping = (file: string, args: string[], ms?: number) => {
			const out = n.run(file, args, ms);
			if (args.includes("/inheritance:r")) { rmSync(dir, { recursive: true }); symlinkSync(real, dir); }
			return out;
		};
		assert.throws(() => protectFolder(dir, swapping), /link or junction/);
		assert.ok(!n.calls.some((c) => c.args.includes("/save")), "the DACL was not read through the link");
	} finally {
		rmSync(real, { recursive: true, force: true });
	}
});

test("N3: a failing icacls is told by its stderr's last line and exit code, not by the command line in the error's message", () => {
	const dir = join(world.root, "failing", "straw-boss");
	const run = (file: string) => {
		if (file === "whoami.exe") return `"PC\\me","${OWNER}"`;
		throw Object.assign(new Error(`Command failed: C:\\Windows\\System32\\icacls.exe ${dir} /setowner`), { stderr: "\r\nSuccessfully processed 0 files; Failed processing 1 files\r\nAccess is denied.\r\n", status: 5 });
	};
	assert.throws(() => protectFolder(dir, run as never), (e: unknown) => /: Access is denied\., exit code 5$/.test((e as Error).message) && !/Command failed/.test((e as Error).message));
});

test("the lock is written only after the state folder is protected: icacls runs on an empty folder, then server.lock appears", async () => {
	const n = native(() => world.stateDir);
	const prepare = (slot: typeof world.slot) => prepareSlot(slot, "win32", n.run);
	const lock = await takeLock(world.slot, "test", { ...world.ctx().lock, prepare }, 0);
	assert.deepEqual(n.calls.map((c) => c.entries), [[], [], [], []]);
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

test("a start (ensure) on Windows protects the folder before the lock, the placeholder, or the server's log, once for the requester's whole start", async () => {
	const n = native(() => world.stateDir);
	const done = await ensure(world.ctx({ prepare: (slot, ms) => prepareSlot(slot, "win32", n.run, ms) }), { boss: true });
	assert.ok("server" in done && done.server === "started");
	assert.equal(n.calls.filter((c) => c.args.includes("/setowner")).length, 1, "the lock's call; the placeholder inside the same start does not run the native calls again");
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
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
