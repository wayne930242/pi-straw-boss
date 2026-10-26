import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ensure, lockFor, ServerError, stop } from "../src/server/client.ts";
import { markStarting, prepareSlot, takeLock } from "../src/server/record.ts";
import { explainNative, forgetSid, RENAME_WAITS_MS, ownerArgs, ownerSid, protectArgs, protectFolder, readDacl, refuseLink, resetFileAcl } from "../src/server/winprep.ts";
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

interface Call { file: string; args: string[]; target: string; finalExists: boolean; timeoutMs: number | undefined }
interface Fake { icacls?: Error & { status?: number; stderr?: string }; failOn?: "owner" | "protect"; dacl?: string; whoami?: string; during?: (call: Call) => void }
/**
 * The native calls, recorded with the folder they act on and whether the final folder `final` exists at that moment; `/save` writes the DACL the folder "has" (`dacl`) the way icacls does, in UTF-16.
 * `during` runs inside a call, to do what another process would do meanwhile.
 */
function native(final: () => string, over: Fake = {}) {
	const calls: Call[] = [];
	const run = (file: string, args: string[], timeoutMs?: number) => {
		const call: Call = { file, args, target: args[0]!, finalExists: existsSync(final()), timeoutMs };
		calls.push(call);
		if (file === "whoami.exe") return over.whoami ?? `"PC\\me","${OWNER}"\r\n`;
		over.during?.(call);
		const failing = over.icacls && !args.includes("/save") && (!over.failOn || (over.failOn === "owner" ? args.includes("/setowner") : args.includes("/inheritance:r")));
		if (failing) throw over.icacls;
		if (args.includes("/save")) writeFileSync(args[args.indexOf("/save") + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\n${over.dacl ?? GOOD}\r\n`, "utf16le")]));
		return "";
	};
	return { calls, run, files: () => calls.map((c) => c.file), icacls: () => calls.filter((c) => c.file === "icacls.exe") };
}
const denied = (status = 5, stderr = "\r\n�s���Q�ڡC\r\n") => Object.assign(new Error("Command failed: C:\\Windows\\System32\\icacls.exe x\n" + stderr), { status, stderr });
const leftovers = (dir: string) => readdirSync(dirname(dir)).filter((n) => n !== basename(dir));

test("the owner's SID is read from whoami's CSV by its shape, never by a name; anything else is refused", () => {
	assert.equal(ownerSid(() => `"DESKTOP-1\\許功","${OWNER}"\r\n`), OWNER);
	assert.throws(() => ownerSid(() => "ERROR: nothing"), /did not give a SID/);
	assert.throws(() => ownerSid(() => ""), /nothing/);
});

test("N1: the owner is set and the folder protected in two calls, each a documented icacls form: /setowner alone, then /inheritance:r /grant:r (owner and SYSTEM by SID, passed on), without /T", () => {
	assert.deepEqual(ownerArgs("C:\\s", OWNER), ["C:\\s", "/setowner", `*${OWNER}`, "/L", "/Q"]);
	assert.deepEqual(protectArgs("C:\\s", OWNER), ["C:\\s", "/inheritance:r", "/grant:r", `*${OWNER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/L"]);
	for (const args of [ownerArgs("C:\\s", OWNER), protectArgs("C:\\s", OWNER)]) assert.ok(!args.includes("/T"));
	assert.ok(!protectArgs("C:\\s", OWNER).includes("/setowner"), "the grant form never carries /setowner");
});

// --- a folder that is not there is born protected ---

test("a new folder is made under an unpredictable name beside its own, made the owner's, protected, and read back there; it takes its name only then, and the final name does not exist while any call runs", () => {
	const dir = join(world.root, "agent", "straw-boss");
	const n = native(() => dir);
	protectFolder(dir, n.run);
	assert.deepEqual(n.files(), ["whoami.exe", "icacls.exe", "icacls.exe", "icacls.exe"]);
	const temp = n.calls[1]!.target;
	assert.equal(dirname(temp), dirname(dir), "beside the final name, so the rename stays on one volume");
	assert.match(basename(temp), /^straw-boss\.[0-9a-f]{16}\.tmp$/);
	assert.deepEqual(n.icacls().map((c) => c.target), [temp, temp, temp]);
	assert.deepEqual(n.calls.map((c) => c.finalExists), [false, false, false, false], "nothing stood at the final name until the folder was ready");
	assert.deepEqual(n.calls[1]!.args, ownerArgs(temp, OWNER));
	assert.deepEqual(n.calls[2]!.args, protectArgs(temp, OWNER));
	assert.deepEqual(n.calls[3]!.args.slice(0, 2), [temp, "/save"]);
	assert.deepEqual(n.calls[3]!.args.slice(3), ["/L", "/Q"]);
	assert.ok(existsSync(dir) && statSync(dir).isDirectory(), "the folder is in place");
	assert.deepEqual(leftovers(dir), [], "the temporary folder is gone");
});

test("the temporary names are not the same twice", () => {
	const names = new Set<string>();
	for (let i = 0; i < 5; i++) {
		forgetSid();
		const dir = join(world.root, `agent${i}`, "straw-boss");
		const n = native(() => dir);
		protectFolder(dir, n.run);
		names.add(basename(n.calls[1]!.target));
	}
	assert.equal(names.size, 5);
});

test("a temporary folder that something was put into before it was protected is refused and removed, and nothing takes the final name", () => {
	const dir = join(world.root, "agent", "straw-boss");
	const n = native(() => dir, { during: (c) => c.args.includes("/inheritance:r") && writeFileSync(join(c.target, "planted.txt"), "x") });
	assert.throws(() => protectFolder(dir, n.run), /something was put into .* before it was protected/);
	assert.equal(existsSync(dir), false);
	assert.deepEqual(readdirSync(dirname(dir)), []);
});

test("when the final name appeared meanwhile, the temporary folder is dropped and the folder that is there is protected and read back where it is", () => {
	const dir = join(world.root, "agent", "straw-boss");
	const n = native(() => dir, { during: (c) => { if (c.args.includes("/save") && !existsSync(dir)) { mkdirSync(dir); writeFileSync(join(dir, "other.txt"), "x"); } } });
	protectFolder(dir, n.run);
	assert.deepEqual(n.icacls().map((c) => basename(c.target)).map((t) => (t === "straw-boss" ? "final" : "temp")), ["temp", "temp", "temp", "final", "final", "final"]);
	assert.deepEqual(readdirSync(dir), ["other.txt"], "the folder that was there is kept");
	assert.deepEqual(leftovers(dir), [], "the temporary folder is gone");
});

test("a temporary folder swapped for a link is refused before its DACL is read, and nothing takes the final name", () => {
	const real = mkdtempSync(join(tmpdir(), "psb-swap-"));
	const dir = join(world.root, "agent", "straw-boss");
	try {
		const n = native(() => dir, { during: (c) => { if (c.args.includes("/inheritance:r")) { rmSync(c.target, { recursive: true }); symlinkSync(real, c.target); } } });
		assert.throws(() => protectFolder(dir, n.run), /link or junction/);
		assert.ok(!n.calls.some((c) => c.args.includes("/save")), "the DACL was not read through the link");
		assert.equal(existsSync(dir), false);
		assert.ok(existsSync(real), "the target of the link is untouched");
	} finally {
		rmSync(real, { recursive: true, force: true });
	}
});

test("a folder whose DACL has a foreign ACE, is not protected, or is not readable after the calls is refused, the temporary folder is removed, and nothing takes the final name", () => {
	for (const [dacl, text] of [
		[`D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})(A;OICI;0x1200a9;;;BU)`, /BU/],
		[`D:(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})`, /not protected/],
		[`D:P(A;OICI;FA;;;SY)`, /grants nothing to/],
		["not sddl", /cannot be read|no SDDL/],
	] as const) {
		forgetSid();
		const dir = join(world.root, "foreign", "straw-boss");
		const bad = native(() => dir, { dacl });
		assert.throws(() => protectFolder(dir, bad.run), (e: unknown) => text.test((e as Error).message) && /could not protect/.test((e as Error).message), dacl);
		assert.equal(existsSync(dir), false);
		assert.deepEqual(readdirSync(dirname(dir)), []);
	}
});

// --- a folder that is there ---

test("a folder that is there is made the owner's, protected, and read back where it is; only the SID is kept between starts, and the folder is looked at again at every start", () => {
	const dir = join(world.root, "again", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const n = native(() => dir);
	protectFolder(dir, n.run);
	protectFolder(dir, n.run);
	assert.deepEqual(n.files(), ["whoami.exe", "icacls.exe", "icacls.exe", "icacls.exe", "icacls.exe", "icacls.exe", "icacls.exe"], "whoami once, then icacls three times per start");
	assert.ok(n.icacls().every((c) => c.target === dir));
	rmSync(dir, { recursive: true });
	protectFolder(dir, n.run);
	assert.equal(n.icacls().length, 9, "removed and made again: protected again, at birth this time");
	assert.ok(n.icacls().slice(6).every((c) => c.target !== dir), "the new one was born under a temporary name");
});

test("a folder that is there and a foreign DACL on it is refused (nothing is written into it)", () => {
	const dir = join(world.root, "there", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const bad = native(() => dir, { dacl: `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})(A;OICI;FA;;;WD)` });
	assert.throws(() => protectFolder(dir, bad.run), /WD/);
	assert.deepEqual(readdirSync(dir), []);
});

test("/save's file is UTF-16 with a byte-order mark or plain, and the temporary file is removed", () => {
	const dir = join(world.root, "d");
	const n = native(() => dir);
	assert.equal(readDacl(dir, n.run), GOOD);
	const before = readdirSync(tmpdir()).filter((f) => f.startsWith("sb-acl-")).length;
	readDacl(dir, n.run);
	assert.equal(readdirSync(tmpdir()).filter((f) => f.startsWith("sb-acl-")).length, before, "the file is gone");
	assert.throws(() => readDacl(dir, (_f, args) => (writeFileSync(args[args.indexOf("/save") + 1]!, "nothing here"), "")), /wrote no SDDL/);
});

test("a folder that is a link or junction is refused, and so are servers/ and servers/<hash> of a secondary slot", () => {
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

// --- what a failure says (P2) ---

test("a failing call is told by a fixed message for its step and exit code, with what to do, and the program's own words only as printable ASCII", () => {
	const dir = "C:\\Users\\許功\\.pi\\agent\\straw-boss";
	const garbled = denied(5);
	const owner = explainNative("owner", dir, Object.assign(garbled, { ownerKnown: true }));
	const quoted = dir.replace(/[\\.]/g, "\\$&");
	assert.match(owner, new RegExp(`^the folder ${quoted} belongs to another account, usually Administrators from a run of pi as administrator, and this process may not take it over\\. Run pi once as administrator, or delete the folder ${quoted}, then start again\\. \\(owner step, exit 5; detail: \\?s\\?Q\\?C\\)\\.$`));
	for (const text of [owner]) assert.ok(/^[\x20-\x7E]*$/.test(text.replaceAll(dir, "")), "ASCII apart from the path");
	assert.match(explainNative("owner", dir, Object.assign(denied(1314), { ownerKnown: true })), /belongs to another account/);
	assert.match(explainNative("owner", dir, Object.assign(denied(1307), { ownerKnown: true })), /belongs to another account/);
	assert.match(explainNative("protect", dir, denied(5)), /may not change the permissions of the folder .*Run pi once as administrator, or delete the folder/);
	assert.match(explainNative("protect", dir, denied(87, "Invalid parameter")), /did not accept its arguments.*exit 87.*detail: Invalid parameter.*bug in pi-straw-boss/);
	assert.match(explainNative("owner", dir, Object.assign(new Error("x"), { code: "ENOENT", syscall: "spawnSync icacls.exe" })), /icacls\.exe was not found in the Windows System32 folder/);
	assert.match(explainNative("whoami", dir, Object.assign(new Error("x"), { code: "ENOENT", syscall: "spawnSync whoami.exe" })), /whoami\.exe was not found/);
	assert.match(explainNative("read-back", dir, Object.assign(new Error("x"), { code: "ETIMEDOUT", killed: true, syscall: "spawnSync icacls.exe" })), /icacls did not finish in time/);
	assert.match(explainNative("read-back", dir, denied(3, "")), /^icacls failed \(read-back step, exit 3\)\.$/);
	assert.ok(!/Command failed/.test(explainNative("owner", dir, denied(5))));
});

test("a folder an elevated run made (every icacls call refused with exit 5) is the actionable message end to end, from the protect step, and nothing was written", () => {
	const dir = join(world.root, "agent", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const bad = native(() => dir, { icacls: denied(5) });
	assert.throws(() => protectFolder(dir, bad.run), (e: unknown) => {
		const text = (e as Error).message;
		return text.startsWith(`could not protect ${dir} before writing to it: this process may not change the permissions of the folder ${dir}`) && text.includes("Run pi once as administrator, or delete the folder") && /protect step, exit 5; detail: \?s\?Q\?C\)\.$/.test(text);
	});
	assert.ok(bad.calls.some((c) => c.args.includes("/inheritance:r")), "the owner step does not stop the protect call");
	assert.deepEqual(readdirSync(dir), []);
});

test("a failing call on a new folder removes the temporary folder and leaves nothing at the final name", () => {
	const dir = join(world.root, "agent", "straw-boss");
	const bad = native(() => dir, { icacls: denied(5) });
	assert.throws(() => protectFolder(dir, bad.run), /may not change the permissions/);
	assert.equal(existsSync(dir), false);
	assert.deepEqual(readdirSync(dirname(dir)), []);
});

// --- the order, for every file that is written ---

test("the lock is written only after the state folder is protected and in place: icacls works on a temporary folder, and server.lock appears in the final one", async () => {
	const n = native(() => world.stateDir);
	const prepare = (slot: typeof world.slot) => prepareSlot(slot, "win32", n.run);
	const lock = await takeLock(world.slot, "test", { ...world.ctx().lock, prepare }, 0);
	assert.deepEqual(n.calls.map((c) => c.finalExists), [false, false, false, false]);
	assert.ok(readdirSync(world.stateDir).includes("server.lock"));
	lock.release();
});

test("the placeholder record is written only after the state folder is protected and in place", () => {
	const n = native(() => world.stateDir);
	markStarting(world.slot, Date.now(), { pid: 1, version: "0.44.0", desk: false, intercom: { transport: "default" }, mode: "detached", by: "test", prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	assert.deepEqual(n.calls.map((c) => c.finalExists), [false, false, false, false]);
	assert.ok(readdirSync(world.stateDir).includes("server.json"));
});

test("a secondary slot's folder (servers/<hash>, which inherits the protected one) is made after the state folder is in place", () => {
	const n = native(() => world.stateDir);
	const other = { ...world.slot, primary: false, dir: join(world.stateDir, "servers", "abcd") };
	prepareSlot(other, "win32", n.run);
	assert.ok(n.calls.every((c) => !c.finalExists), "the state folder did not exist while it was protected");
	assert.ok(existsSync(other.dir));
});

test("a start (ensure) on Windows protects the folder before the lock, the placeholder, or the server's log, once for the requester's whole start", async () => {
	const n = native(() => world.stateDir);
	const done = await ensure(world.ctx({ prepare: (slot, ms) => prepareSlot(slot, "win32", n.run, ms) }), { boss: true });
	assert.ok("server" in done && done.server === "started");
	assert.equal(n.calls.filter((c) => c.args.includes("/setowner")).length, 1, "the lock's call; the placeholder inside the same start does not run the native calls again");
	assert.ok(n.calls.every((c) => !c.finalExists));
});

test("a folder that cannot be protected stops the start before anything is written: ServerError start-failed with an acl start error (exit 3), and no file and no folder", async () => {
	const n = native(() => world.stateDir, { icacls: denied(5) });
	const ctx = world.ctx({ prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	await assert.rejects(ensure(ctx, { boss: true }), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && e.startError?.code === "acl" && /may not change the permissions/.test(e.message) && /Run pi once as administrator/.test(e.startError.text));
	assert.equal(world.spawned.length, 0);
	assert.equal(existsSync(world.stateDir), false, "nothing was made at the final name");
	assert.deepEqual(readdirSync(dirname(world.stateDir)), []);
	await assert.rejects(lockFor(ctx, 0), (e: unknown) => e instanceof ServerError && e.startError?.code === "acl");
});

test("the server protects the folder before its log, and when it cannot it leaves with 3 and writes nothing", async () => {
	const n = native(() => world.stateDir);
	const s = await world.start({ prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	assert.equal(await s.handle.ready, true);
	assert.ok(n.calls.every((c) => !c.finalExists), "the log did not exist when the folder was protected");
	await s.handle.shutdown(0);
	const w2 = new ServerWorld();
	try {
		const bad = native(() => w2.stateDir, { icacls: denied(5) });
		const failed = await w2.start({ prepare: (slot) => prepareSlot(slot, "win32", bad.run) });
		assert.equal(await failed.handle.ready, false);
		assert.equal(await failed.handle.done, 3);
		assert.equal(existsSync(w2.stateDir), false);
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

// --- review N-F002, N-F003, N-F005 ---

test("N-F002: every icacls call carries /L (a link is acted on itself, never its target), and the folder is looked at for a link before the first call of `secure`", () => {
	for (const args of [ownerArgs("C:\\s", OWNER), protectArgs("C:\\s", OWNER)]) assert.ok(args.includes("/L"), args.join(" "));
	const dir = join(world.root, "agent", "straw-boss");
	const real = mkdtempSync(join(tmpdir(), "psb-final-"));
	try {
		// The final name becomes a junction while the three calls on the temporary folder run: the rename fails, and the folder at the final name is a link.
		const n = native(() => dir, { during: (c) => { if (c.args.includes("/save") && !existsSync(dir)) symlinkSync(real, dir); } });
		assert.throws(() => protectFolder(dir, n.run), /link or junction/);
		assert.ok(!n.icacls().some((c) => c.target === dir), "no icacls call was made on the link");
		assert.ok(existsSync(real));
	} finally {
		rmSync(real, { recursive: true, force: true });
	}
});

test("N-F003: ENOENT and a timeout are told as a program that was not found or did not finish only when the program failed to start; any other error keeps its own message, as ASCII", () => {
	const dir = "C:\\s";
	const local = explainNative("read-back", dir, Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\tmp\\sb-acl-1.txt'"), { code: "ENOENT", syscall: "open" }));
	assert.ok(!/System32|not found in/.test(local), local);
	assert.match(local, /read-back step.*no such file/);
	const timeout = explainNative("owner", dir, Object.assign(new Error("slow"), { killed: true, signal: "SIGTERM" }));
	assert.ok(!/did not finish in time/.test(timeout), "a killed flag without a spawn error is not a timeout of icacls");
});

test("N-F003: icacls exits 0 but /save left no file: the message names that, not a missing icacls.exe; and whoami's own text is kept when it gave no SID", () => {
	const dir = join(world.root, "agent", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const silent = (file: string) => (file === "whoami.exe" ? `"PC\\me","${OWNER}"\r\n` : "");
	assert.throws(() => protectFolder(dir, silent), (e: unknown) => /wrote no file/.test((e as Error).message) && !/System32/.test((e as Error).message));
	forgetSid();
	assert.throws(() => protectFolder(dir, () => "ERROR: Access is denied.\r\n"), /whoami did not give a SID: ERROR: Access is denied\./);
});

test("N-F005: renaming the temporary folder is tried again on EPERM, EBUSY and EACCES (a scanner or the indexer holds it for a moment), not on another error", () => {
	for (const code of ["EPERM", "EBUSY", "EACCES"]) {
		forgetSid();
		const dir = join(world.root, `r-${code}`, "straw-boss");
		let failures = 3;
		const rename = (from: string, to: string) => {
			if (failures-- > 0) throw Object.assign(new Error(`${code}: busy`), { code });
			renameSync(from, to);
		};
		protectFolder(dir, native(() => dir).run, undefined, Date.now, rename);
		assert.ok(statSync(dir).isDirectory(), code);
		assert.equal(failures, -1);
		assert.deepEqual(leftovers(dir), []);
	}
	forgetSid();
	const dir = join(world.root, "r-never", "straw-boss");
	let calls = 0;
	assert.throws(() => protectFolder(dir, native(() => dir).run, undefined, Date.now, () => { calls++; throw Object.assign(new Error("EPERM: held"), { code: "EPERM" }); }), /something is holding the new folder .* \(EPERM\)\. Start again in a moment/);
	assert.equal(calls, RENAME_WAITS_MS.length + 1, "every wait is used, then the error");
	assert.ok(RENAME_WAITS_MS.reduce((a, b) => a + b, 0) >= 2000, "about two seconds in all, for an indexer or a scanner");
	assert.deepEqual(readdirSync(dirname(dir)), [], "the temporary folder is removed");
	forgetSid();
	const other = join(world.root, "r-exdev", "straw-boss");
	calls = 0;
	assert.throws(() => protectFolder(other, native(() => other).run, undefined, Date.now, () => { calls++; throw Object.assign(new Error("EXDEV"), { code: "EXDEV" }); }), /EXDEV/);
	assert.equal(calls, 1, "no retry");
});

test("N-F005: a temporary folder a crashed start left beside the state folder is removed once it is older than a minute; a younger one, a link, a file, and other names are left", () => {
	const dir = join(world.root, "agent", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const parent = dirname(dir), old = new Date(Date.now() - 2 * 60_000), real = mkdtempSync(join(tmpdir(), "psb-sweep-"));
	const made = (name: string, kind: "dir" | "file" | "link", date: Date) => {
		const path = join(parent, name);
		if (kind === "dir") { mkdirSync(path); writeFileSync(join(path, "x"), "1"); } else if (kind === "file") writeFileSync(path, "1"); else symlinkSync(real, path);
		if (kind !== "link") utimesSync(path, date, date);
		return path;
	};
	try {
		const stale = made("straw-boss.0123456789abcdef.tmp", "dir", old);
		const young = made("straw-boss.fedcba9876543210.tmp", "dir", new Date());
		const file = made("straw-boss.aaaaaaaaaaaaaaaa.tmp", "file", old);
		const link = made("straw-boss.bbbbbbbbbbbbbbbb.tmp", "link", old);
		const other = made("straw-boss.cccccccccccccccc.bak", "dir", old);
		const foreign = made("other.0123456789abcdef.tmp", "dir", old);
		protectFolder(dir, native(() => dir).run);
		assert.equal(existsSync(stale), false);
		for (const kept of [young, file, other, foreign]) assert.ok(existsSync(kept), kept);
		assert.ok(lstatSync(link).isSymbolicLink() && existsSync(real), "a link is not followed or removed");
		assert.ok(statSync(dir).isDirectory());
	} finally {
		rmSync(real, { recursive: true, force: true });
	}
});

// --- VM pass 4, F1: a filtered (UAC) token cannot /setowner outside its profile, on a folder it already owns ---

test("R7-F003: /setowner refused (5, 1307, 1314) is never final: the protect call and the exact O: check decide, with no owner listing; a refusal with another code is raised", () => {
	for (const existing of [false, true]) for (const code of [5, 1307, 1314]) {
		forgetSid();
		const dir = join(world.root, `${existing ? "own-there" : "own-new"}-${code}`, "straw-boss");
		if (existing) mkdirSync(dir, { recursive: true });
		const n = native(() => dir, { icacls: denied(code), failOn: "owner" });
		protectFolder(dir, n.run);
		assert.ok(statSync(dir).isDirectory());
		assert.ok(!n.calls.some((c) => c.file === "cmd.exe"), "no owner listing");
		assert.ok(n.icacls().some((c) => c.args.includes("/inheritance:r")) && n.icacls().some((c) => c.args.includes("/save")), `${code} ${existing}`);
		assert.deepEqual(leftovers(dir), []);
	}
	const dir = join(world.root, "agent", "straw-boss");
	mkdirSync(dir, { recursive: true });
	// A folder that is another account's and grants nothing to the user fails at the protect call, told as that.
	forgetSid();
	const foreign = native(() => dir, { icacls: denied(5) });
	assert.throws(() => protectFolder(dir, foreign.run), /\(protect step, exit 5/);
	forgetSid();
	const odd = native(() => dir, { icacls: denied(87, "Invalid parameter"), failOn: "owner" });
	assert.throws(() => protectFolder(dir, odd.run), /did not accept its arguments/);
});

test("F4: a temporary folder that cannot be removed after a failed rename does not hide why the start failed, and a later start sweeps it", () => {
	forgetSid();
	const dir = join(world.root, "held", "straw-boss");
	const held = () => { throw Object.assign(new Error("EPERM: held"), { code: "EPERM" }); };
	assert.throws(() => protectFolder(dir, native(() => dir).run, undefined, Date.now, held), /something is holding the new folder/);
});

test("F5: a lock file gets the folder's ACL again with one icacls /reset /L /Q on that file; a failure says what to do", () => {
	const lock = join(world.root, "server.lock");
	const n = native(() => lock);
	resetFileAcl(lock, n.run);
	assert.deepEqual(n.calls.map((c) => [c.file, c.args]), [["icacls.exe", [lock, "/reset", "/L", "/Q"]]]);
	assert.throws(() => resetFileAcl(lock, native(() => lock, { icacls: denied(5) }).run), /may not change the permissions of the folder .*Run pi once as administrator/);
});

test("F5: on Windows a start with an unreadable server.lock repairs it through icacls and goes on (lockFor)", async () => {
	forgetSid();
	const n = native(() => world.stateDir);
	const reset: string[] = [];
	let first = true;
	const ctx = world.ctx({ platform: "win32", prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	// The damaged lock is there before the start.
	mkdirSync(world.stateDir, { recursive: true });
	writeFileSync(join(world.stateDir, "server.lock"), JSON.stringify({ pid: 999999, by: "damaged", since: new Date(0).toISOString() }));
	chmodSync(join(world.stateDir, "server.lock"), 0o000);
	const lock = await lockFor({ ...ctx, lock: { ...ctx.lock, repair: (f) => { reset.push(f); chmodSync(f, 0o600); first = false; } } }, 500);
	assert.deepEqual(reset, [join(world.stateDir, "server.lock")]);
	assert.equal(first, false);
	lock.release();
	chmodSync(world.stateDir, 0o700);
});

test("F5: an unreadable lock that cannot be repaired is a start that cannot run here: ServerError start-failed with an acl start error, not `busy`", async () => {
	forgetSid();
	const n = native(() => world.stateDir);
	const ctx = world.ctx({ platform: "win32", prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	mkdirSync(world.stateDir, { recursive: true });
	const lockFile = join(world.stateDir, "server.lock");
	writeFileSync(lockFile, "{}");
	chmodSync(lockFile, 0o000);
	try {
		await assert.rejects(lockFor({ ...ctx, lock: { ...ctx.lock, repair: undefined } }, 500), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && e.startError?.code === "acl" && /server\.lock/.test(e.message));
	} finally {
		chmodSync(lockFile, 0o600);
	}
});

test("F8: a stop that cannot protect or lock the folder (not the caller's) says where the server can be stopped from, with the ACL text and the acl start error kept", async () => {
	forgetSid();
	const bad = native(() => world.stateDir, { icacls: denied(5) });
	const ctx = world.ctx({ platform: "win32", prepare: (slot) => prepareSlot(slot, "win32", bad.run) });
	await assert.rejects(stop(ctx), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && e.startError?.code === "acl" && /may not change the permissions/.test(e.message) && /stop it from that account/.test(e.message));
	assert.equal(existsSync(world.stateDir), false, "nothing was written");
});

test("R6-F005: the stop message about another account's server is added only to the owner and protect refusals (exit 5, 1307, 1314); other acl failures keep their own words", async () => {
	for (const [bad, expected] of [
		[{ icacls: denied(5) }, true],
		[{ icacls: denied(1314) }, true],
		[{ icacls: denied(5), failOn: "protect" as const }, true],
		[{ icacls: denied(3, ""), failOn: "protect" as const }, false],
		[{ icacls: Object.assign(new Error("timeout"), { code: "ETIMEDOUT", killed: true, syscall: "spawnSync icacls.exe" }), failOn: "protect" as const }, false],
		[{ dacl: `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;${OWNER})(A;OICI;FA;;;WD)` }, false],
	] as const) {
		forgetSid();
		const w = new ServerWorld();
		try {
			const n = native(() => w.stateDir, bad);
			await assert.rejects(stop(w.ctx({ platform: "win32", prepare: (slot) => prepareSlot(slot, "win32", n.run) })), (e: unknown) => e instanceof ServerError && e.startError?.code === "acl" && /stop it from that account/.test(e.message) === expected, JSON.stringify(Object.keys(bad)));
		} finally {
			await w.close();
		}
	}
});
