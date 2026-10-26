import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ensure, launch, lockFor, restart, ServerError, stop } from "../src/server/client.ts";
import { markStarting, prepareSlot, takeLock } from "../src/server/record.ts";
import { explainNative, forgetSid, RENAME_WAITS_MS, ownerGate, ownerOfFolder, ownerSid, protectArgs, protectFolder, readDacl, refuseLink, resetFileAcl } from "../src/server/winprep.ts";
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
interface Fake { owner?: string | Error; icacls?: Error & { status?: number; stderr?: string }; failOn?: "owner" | "protect"; dacl?: string; whoami?: string; during?: (call: Call) => void }
/**
 * The native calls, recorded with the folder they act on and whether the final folder `final` exists at that moment; `/save` writes the DACL the folder "has" (`dacl`) the way icacls does, in UTF-16.
 * `during` runs inside a call, to do what another process would do meanwhile.
 */
function native(final: () => string, over: Fake = {}) {
	const calls: Call[] = [];
	const run = (file: string, args: string[], timeoutMs?: number, _env?: Record<string, string>) => {
		const call: Call = { file, args, target: args[0]!, finalExists: existsSync(final()), timeoutMs };
		calls.push(call);
		if (file === "whoami.exe") return over.whoami ?? `"PC\\me","${OWNER}"\r\n`;
		// The owner read of a folder whose /setowner was refused: one PowerShell start that prints a SID.
		if (file.endsWith("powershell.exe")) {
			if (over.owner instanceof Error) throw over.owner;
			return `${over.owner ?? OWNER}\r\n`;
		}
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

test("N1, R12-F001: the folder is protected by one documented icacls form, /inheritance:r /grant:r (owner and SYSTEM by SID, passed on), without /T; no native call sets an owner", () => {
	assert.deepEqual(protectArgs("C:\\s", OWNER), ["C:\\s", "/inheritance:r", "/grant:r", `*${OWNER}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/L"]);
	assert.ok(!protectArgs("C:\\s", OWNER).includes("/T"));
	assert.ok(!protectArgs("C:\\s", OWNER).includes("/setowner"));
	assert.ok(!existsSync("/nonexistent") && !("ownerArgs" in (globalThis as object)), "there is no owner call to build");
});

// --- a folder that is not there is born protected ---

test("a new folder is made under an unpredictable name beside its own, protected, and read back there; it takes its name only then, and the final name does not exist while any call runs", () => {
	const dir = join(world.root, "agent", "straw-boss");
	const n = native(() => dir);
	protectFolder(dir, n.run);
	assert.deepEqual(n.files(), ["whoami.exe", "icacls.exe", "icacls.exe"]);
	const temp = n.calls[1]!.target;
	assert.equal(dirname(temp), dirname(dir), "beside the final name, so the rename stays on one volume");
	assert.match(basename(temp), /^straw-boss\.[0-9a-f]{16}\.tmp$/);
	assert.deepEqual(n.icacls().map((c) => c.target), [temp, temp]);
	assert.deepEqual(n.calls.map((c) => c.finalExists), [false, false, false], "nothing stood at the final name until the folder was ready");
	assert.deepEqual(n.calls[1]!.args, protectArgs(temp, OWNER));
	assert.deepEqual(n.calls[2]!.args.slice(0, 2), [temp, "/save"]);
	assert.deepEqual(n.calls[2]!.args.slice(3), ["/L", "/Q"]);
	assert.ok(!n.icacls().some((c) => c.args.includes("/setowner")), "R12-F001: not even on a folder this process just made");
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
	assert.deepEqual(n.icacls().map((c) => basename(c.target)).map((t) => (t === "straw-boss" ? "final" : "temp")), ["temp", "temp", "final"]);
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

test("an existing folder whose DACL is already right is left alone (one /save per start, no PowerShell); one whose DACL is wrong and whose owner is the user is protected and read back; none is ever given an owner (R11-F001, R12)", () => {
	const dir = join(world.root, "again", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const n = native(() => dir);
	protectFolder(dir, n.run);
	protectFolder(dir, n.run);
	assert.deepEqual(n.files(), ["whoami.exe", "icacls.exe", "icacls.exe"], "whoami once, then one /save per start and nothing else");
	assert.ok(n.icacls().every((c) => c.args.includes("/save") && c.target === dir));
	// A DACL that is wrong (the parent's inherited ACE came back): one PowerShell reads the owner, then protect and read-back.
	forgetSid();
	const damaged = native(() => dir, { dacl: "D:PAI(A;OICIID;FA;;;WD)" });
	assert.throws(() => protectFolder(dir, damaged.run), /not owner and SYSTEM only|inherit|ACE/, "the fake keeps the DACL wrong after the protect call, so the read-back refuses");
	assert.deepEqual(damaged.calls.map((c) => c.file.endsWith("powershell.exe") ? "powershell" : c.file === "whoami.exe" ? "whoami" : c.args[1]!), ["whoami", "/save", "powershell", "/inheritance:r", "/save"]);
	rmSync(dir, { recursive: true });
	const born = native(() => dir);
	protectFolder(dir, born.run);
	assert.equal(born.icacls().length, 2, "removed and made again: born protected under a temporary name (protect and read-back)");
	assert.ok(born.icacls().every((c) => c.target !== dir));
	assert.ok(![...n.icacls(), ...damaged.icacls(), ...born.icacls()].some((c) => c.args.includes("/setowner")));
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
	assert.deepEqual(n.calls.map((c) => c.timeoutMs), [1000, 600, 200]);
	forgetSid();
	const plain = native(() => dir);
	protectFolder(dir, plain.run, undefined, () => t);
	assert.deepEqual(plain.calls.map((c) => c.timeoutMs), [undefined, undefined], "no time given, no bound (the folder is there now: whoami and one /save)");
});

// --- what a failure says (P2) ---

test("a failing call is told by a fixed message for its step and exit code, with what to do, and the program's own words only as printable ASCII", () => {
	const dir = "C:\\Users\\許功\\.pi\\agent\\straw-boss";
	const quoted = dir.replace(/[\\.]/g, "\\$&");
	const protect = explainNative("protect", dir, denied(5));
	assert.match(protect, new RegExp(`^this process may not change the permissions of the folder ${quoted}, which belongs to another account or was made by an administrator's run\\. Run pi once as administrator, or delete the folder ${quoted}, then start again\\. \\(protect step, exit 5; detail: `));
	for (const text of [protect]) assert.ok(/^[\x20-\x7E]*$/.test(text.replaceAll(dir, "")), "ASCII apart from the path");
	assert.match(explainNative("protect", dir, denied(5)), /may not change the permissions of the folder .*Run pi once as administrator, or delete the folder/);
	assert.match(explainNative("protect", dir, denied(87, "Invalid parameter")), /did not accept its arguments.*exit 87.*detail: Invalid parameter.*bug in pi-straw-boss/);
	assert.match(explainNative("protect", dir, Object.assign(new Error("x"), { code: "ENOENT", syscall: "spawnSync icacls.exe" })), /icacls\.exe was not found in the Windows System32 folder/);
	assert.match(explainNative("whoami", dir, Object.assign(new Error("x"), { code: "ENOENT", syscall: "spawnSync whoami.exe" })), /whoami\.exe was not found/);
	assert.match(explainNative("read-back", dir, Object.assign(new Error("x"), { code: "ETIMEDOUT", killed: true, syscall: "spawnSync icacls.exe" })), /icacls did not finish in time/);
	assert.match(explainNative("read-back", dir, denied(3, "")), /^icacls failed \(read-back step, exit 3\)\.$/);
	assert.ok(!/Command failed/.test(explainNative("protect", dir, denied(5))));
});

test("a folder an elevated run made (every icacls call refused with exit 5) is the actionable message end to end, from the protect step, and nothing was written", () => {
	const dir = join(world.root, "agent", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const bad = native(() => dir, { icacls: denied(5), dacl: 'D:PAI(A;OICIID;FA;;;WD)' });
	assert.throws(() => protectFolder(dir, bad.run), (e: unknown) => {
		const text = (e as Error).message;
		return text.startsWith(`could not protect ${dir} before writing to it: this process may not change the permissions of the folder ${dir}`) && text.includes("Run pi once as administrator, or delete the folder") && /protect step, exit 5; detail: \?s\?Q\?C\)\.$/.test(text);
	});
	assert.ok(bad.calls.some((c) => c.args.includes("/inheritance:r")), "the owner (the user) is read, then the protect call is tried");
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
	assert.deepEqual(n.calls.map((c) => c.finalExists), [false, false, false]);
	assert.ok(readdirSync(world.stateDir).includes("server.lock"));
	lock.release();
});

test("the placeholder record is written only after the state folder is protected and in place", () => {
	const n = native(() => world.stateDir);
	markStarting(world.slot, Date.now(), { pid: 1, version: "0.44.0", desk: false, intercom: { transport: "default" }, mode: "detached", by: "test", prepare: (slot) => prepareSlot(slot, "win32", n.run) });
	assert.deepEqual(n.calls.map((c) => c.finalExists), [false, false, false]);
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
	assert.equal(n.calls.filter((c) => c.args.includes("/inheritance:r")).length, 1, "the lock's call; the placeholder inside the same start does not run the native calls again");
	assert.ok(!n.calls.some((c) => c.args.includes("/setowner")));
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
	assert.ok(protectArgs("C:\\s", OWNER).includes("/L"));
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
	const timeout = explainNative("protect", dir, Object.assign(new Error("slow"), { killed: true, signal: "SIGTERM" }));
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

// --- R12: no native call changes an owner; an existing folder is touched only when its DACL is wrong, and only after its owner is read ---

const FOREIGN = "S-1-5-21-9-9-9-1002";
const BA = "S-1-5-32-544";
const WRONG = "D:PAI(A;OICIID;FA;;;WD)";
const called = (n: ReturnType<typeof native>) => n.calls.map((c) => (c.file.endsWith("powershell.exe") ? "powershell" : c.file === "whoami.exe" ? "whoami" : c.args[1]!));
const changing = (n: ReturnType<typeof native>) => n.icacls().filter((c) => c.args.includes("/inheritance:r") || c.args.includes("/grant:r") || c.args.includes("/setowner") || c.args.includes("/reset"));

test("R12-F001: no start ever calls /setowner, on a new folder (born under a temporary name), an existing one, or after any refusal; the temp folder's protect and read-back are all it gets", () => {
	for (const code of [5, 1307, 1314, 87]) {
		forgetSid();
		const dir = join(world.root, `fresh-${code}`, "straw-boss");
		const n = native(() => dir, { icacls: denied(code), failOn: "protect" });
		assert.throws(() => protectFolder(dir, n.run));
		assert.ok(!n.icacls().some((c) => c.args.includes("/setowner")), String(code));
		assert.deepEqual(readdirSync(dirname(dir)), [], "the temporary folder is removed");
	}
	forgetSid();
	const fresh = join(world.root, "fresh", "straw-boss");
	const n = native(() => fresh);
	protectFolder(fresh, n.run);
	assert.deepEqual(called(n), ["whoami", "/inheritance:r", "/save"]);
	assert.ok(n.icacls().every((c) => c.target !== fresh));
});

test("R12-F001: a temporary folder swapped for another account's is never taken over: it lands in place still theirs, protect and read-back touch no owner, and the PowerShell gates are what refuse it", () => {
	const dir = join(world.root, "swap", "straw-boss");
	forgetSid();
	// The swap happens during the protect call; nothing in this module reads or changes an owner on the temporary folder.
	const n = native(() => dir, { during: (c) => { if (c.args.includes("/inheritance:r")) { rmSync(c.target, { recursive: true }); mkdirSync(c.target); } } });
	protectFolder(dir, n.run);
	assert.ok(existsSync(dir));
	assert.ok(!n.icacls().some((c) => c.args.includes("/setowner")) && !n.calls.some((c) => c.file.endsWith("powershell.exe")));
});

test("R12: an existing folder whose DACL is right is left alone: one /save, nothing changed, no PowerShell, whoever owns it (the PowerShell gates read the owner before any secret)", () => {
	for (const label of ["attacker-owned", "user-owned", "BA-owned"]) {
		forgetSid();
		const dir = join(world.root, label, "straw-boss");
		mkdirSync(dir, { recursive: true });
		const n = native(() => dir, { owner: label === "attacker-owned" ? FOREIGN : label === "BA-owned" ? BA : OWNER });
		protectFolder(dir, n.run);
		assert.deepEqual(called(n), ["whoami", "/save"], label);
		assert.deepEqual(changing(n), [], label);
	}
});

test("R12: an existing folder with a wrong DACL and a FOREIGN owner is refused with one PowerShell read and no protect, no grant, no reset: nothing in the folder changes", () => {
	for (const code of [0, 5]) {
		forgetSid();
		const dir = join(world.root, `decoy-${code}`, "straw-boss");
		mkdirSync(dir, { recursive: true });
		// code 5: the user cannot even read the DACL of the attacker's folder, which counts as a wrong one.
		const n = native(() => dir, { owner: FOREIGN, dacl: WRONG, ...(code === 5 ? { icacls: denied(5) } : {}) });
		const run = code === 5 ? (file: string, args: string[], ms?: number) => { if (args.includes("/save")) { n.calls.push({ file, args, target: args[0]!, finalExists: true, timeoutMs: ms }); throw denied(5); } return n.run(file, args, ms); } : n.run;
		assert.throws(() => protectFolder(dir, run), (e: unknown) => /belongs to another account \(S-1-5-21-9-9-9-1002\)/.test((e as Error).message) && /Run pi as that account/.test((e as Error).message) && /nothing in the folder was changed/.test((e as Error).message));
		assert.deepEqual(changing(n), [], `${code}: no change`);
		assert.equal(n.calls.filter((c) => c.file.endsWith("powershell.exe")).length, 1);
		assert.ok(existsSync(dir), "the folder is not removed");
	}
});

test("R12: an existing folder with a wrong DACL and the user, Administrators or SYSTEM as owner is protected and read back (one PowerShell for the owner); an unreadable owner is refused untouched; Constrained Language Mode is told as that", () => {
	for (const owner of [OWNER, OWNER.toLowerCase(), BA, "S-1-5-18"]) {
		forgetSid();
		const dir = join(world.root, `repair-${owner}`, "straw-boss");
		mkdirSync(dir, { recursive: true });
		let healed = false;
		const n = native(() => dir, { owner, dacl: WRONG, during: (c) => { if (c.args.includes("/inheritance:r")) healed = true; } });
		const run = (file: string, args: string[], ms?: number) => {
			const out = n.run(file, args, ms);
			if (healed && args.includes("/save")) writeFileSync(args[args.indexOf("/save") + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\n${GOOD}\r\n`, "utf16le")]));
			return out;
		};
		protectFolder(dir, run);
		assert.deepEqual(called(n), ["whoami", "/save", "powershell", "/inheritance:r", "/save"], owner);
		assert.equal(changing(n).length, 1, "only the protect call changes anything");
	}
	const clm = Object.assign(new Error("Command failed: powershell"), { status: 1, stderr: "sb-constrained-language\r\nAt line:1" });
	for (const [owner, expected] of [
		[clm, /Constrained Language Mode \(likely a policy\)/],
		[Object.assign(new Error("Command failed: powershell"), { status: 1, stderr: "boom" }), /owner of .* could not be read \(boom, exit code 1\)/],
		["\r\n", /gave no SID/],
	] as const) {
		forgetSid();
		const dir = join(world.root, "unreadable", "straw-boss");
		mkdirSync(dir, { recursive: true });
		const n = native(() => dir, { owner: owner as string | Error, dacl: WRONG });
		assert.throws(() => protectFolder(dir, n.run), expected);
		assert.deepEqual(changing(n), []);
		rmSync(dir, { recursive: true, force: true });
	}
	// Another exit code from the first /save is a failure of that call, told as such.
	forgetSid();
	const dir = join(world.root, "odd", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const odd = (file: string, args: string[]) => { if (file === "whoami.exe") return `"PC\\me","${OWNER}"\r\n`; throw denied(87, "Invalid parameter"); };
	assert.throws(() => protectFolder(dir, odd), /did not accept its arguments/);
});

test("R12, R13-F001: the owner read is one -EncodedCommand PowerShell that checks the language mode first and prints the owner as a SID; the folder comes in the environment, never quoted into the script, whatever quote characters its name has", () => {
	for (const dir of ["C:\\Users\\o'brien\\straw-boss", "C:\\Users\\O\u2019Neil\\straw-boss", "C:\\a\u2018b\\c\u201Ad\\e\u201Bf\\straw-boss", "C:\\x\"; Remove-Item *\\straw-boss"]) {
		const seen: { file: string; args: string[]; env?: Record<string, string> }[] = [];
		const run = (file: string, args: string[], _ms?: number, env?: Record<string, string>) => { seen.push({ file, args, ...(env ? { env } : {}) }); return `${FOREIGN}\r\n`; };
		assert.equal(ownerOfFolder(dir, run), FOREIGN);
		assert.equal(seen.length, 1);
		assert.match(seen[0]!.file, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
		assert.deepEqual(seen[0]!.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text"]);
		const script = Buffer.from(seen[0]!.args[seen[0]!.args.indexOf("-EncodedCommand") + 1]!, "base64").toString("utf16le");
		const lines = script.split("\n");
		assert.match(lines[0]!, /ProgressPreference/);
		assert.match(lines[1]!, /LanguageMode -ne 'FullLanguage'.*sb-constrained-language/, "the language mode is checked before any .NET call");
		assert.deepEqual(seen[0]!.env, { SB_OWNER_DIR: dir }, "the folder is in the environment");
		assert.ok(lines.includes("$d = $env:SB_OWNER_DIR"));
		assert.ok(!script.includes(dir) && !/[\u2018-\u201B]/.test(script) && !script.includes("brien"), "no part of the path is in the script");
		assert.match(script, /\[IO\.Directory\]::GetAccessControl\(\$d, \[Security\.AccessControl\.AccessControlSections\]::Owner\)\.GetOwner\(\[Security\.Principal\.SecurityIdentifier\]\)\.Value/);
	}
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


// --- R13: nothing is created or written under a foreign-owned state folder; the gate costs one owner read only where a file is about to be created ---

const tree = (dir: string) => readdirSync(dir, { recursive: true, withFileTypes: false }).map(String).sort();
const gated = (n: ReturnType<typeof native>) => ({
	prepare: (slot: typeof world.slot, ms?: number) => prepareSlot(slot, "win32", n.run, ms),
	gate: (slot: typeof world.slot, ms?: number) => ownerGate(slot.stateDir, n.run, ms),
});
const powershells = (n: ReturnType<typeof native>) => n.calls.filter((c) => c.file.endsWith("powershell.exe")).length;

test("R13: a start (up, restart, a launch) or a stop of a server that is down, in a folder another account owns whose DACL is already exactly owner+SYSTEM, is refused with NO file or folder created or written anywhere under it", async () => {
	for (const what of ["ensure", "restart", "stop", "launch"] as const) {
		forgetSid();
		const w = new ServerWorld();
		try {
			mkdirSync(w.stateDir, { recursive: true });
			const before = statSync(w.stateDir).mtimeMs;
			const n = native(() => w.stateDir, { owner: FOREIGN });
			const ctx = w.ctx({ platform: "win32", ...gated(n) });
			const run = what === "ensure" ? () => ensure(ctx, { boss: true }) : what === "restart" ? () => restart(ctx, { reason: "r", boss: true }) : what === "stop" ? () => stop(ctx) : () => launch(ctx);
			await assert.rejects(run(), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && e.startError?.code === "acl" && /belongs to another account \(S-1-5-21-9-9-9-1002\)/.test(e.message) && /Run pi as that account/.test(e.message), what);
			assert.deepEqual(tree(w.stateDir), [], `${what}: the tree is unchanged`);
			assert.equal(statSync(w.stateDir).mtimeMs, before, `${what}: not even a timestamp moved`);
			assert.equal(w.spawned.length, 0);
			assert.deepEqual(changing(n), [], `${what}: nothing was changed natively either`);
			assert.equal(powershells(n), 1, `${what}: one owner read`);
		} finally {
			await w.close();
		}
	}
});

test("R13: a foreign folder with a WRONG DACL is refused by the gate before protectFolder changes anything (one owner read, not two)", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	const n = native(() => world.stateDir, { owner: FOREIGN, dacl: WRONG });
	await assert.rejects(ensure(world.ctx({ platform: "win32", ...gated(n) }), { boss: true }), /belongs to another account/);
	assert.deepEqual(called(n), ["whoami", "powershell"], "no /save, no protect: the gate came first");
	assert.deepEqual(tree(world.stateDir), []);
});

test("R13: a start in a folder the user owns reads the owner ONCE (the gate before prepare), not again for a wrong DACL, and writes after it; the next start of the same process reads none", async () => {
	forgetSid();
	mkdirSync(world.stateDir, { recursive: true });
	let healed = false;
	const n = native(() => world.stateDir, { owner: OWNER, dacl: WRONG, during: (c) => { if (c.args.includes("/inheritance:r")) healed = true; } });
	const run = (file: string, args: string[], ms?: number) => {
		const out = n.run(file, args, ms);
		if (healed && args.includes("/save")) writeFileSync(args[args.indexOf("/save") + 1]!, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`straw-boss\r\n${GOOD}\r\n`, "utf16le")]));
		return out;
	};
	const ctx = world.ctx({ platform: "win32", prepare: (slot, ms) => prepareSlot(slot, "win32", run, ms), gate: (slot, ms) => ownerGate(slot.stateDir, run, ms) });
	const done = await ensure(ctx, { boss: true });
	assert.ok("server" in done && done.server === "started");
	assert.equal(powershells(n), 1, "one owner read for the whole start");
	assert.deepEqual(called(n).slice(0, 4), ["whoami", "powershell", "/save", "/inheritance:r"]);
	assert.ok(readFileSync(join(world.stateDir, "server.log"), "utf8").includes("phase name=owner-gate"), "the cost is a phase in the log (written after the gate passed)");
	const again = powershells(n);
	assert.equal(ownerGate(world.stateDir, run), false, "the same folder, the same process: no read");
	assert.equal(powershells(n), again);
	// The folder made again under its name is another folder: read again.
	rmSync(world.stateDir, { recursive: true });
	mkdirSync(world.stateDir, { recursive: true });
	assert.equal(ownerGate(world.stateDir, run), true);
	assert.equal(powershells(n), again + 1);
});

test("R13: a request that finds a server running runs no PowerShell and calls no gate (a second up, a stop of a live server); a stop of one that is down does", async () => {
	forgetSid();
	const s = await world.start();
	await s.handle.ready;
	let gates = 0;
	const ctx = world.ctx({ gate: () => (gates++, false) });
	const found = await ensure(ctx, { boss: true });
	assert.ok("server" in found && found.server === "found");
	assert.equal(gates, 0, "a second up");
	assert.equal((await stop(ctx)).outcome, "stopped");
	assert.equal(gates, 0, "a stop of a live server");
	assert.equal((await stop(ctx)).outcome, "already-down");
	assert.ok(gates >= 1, "a stop of a server that is down writes `stopped`, so it passes the gate first");
});

test("R13: a folder made by this start (the first ever) is gated right after it is made, before the lock and the placeholder; a swapped one that lands foreign is refused with no file written", async () => {
	forgetSid();
	const n = native(() => world.stateDir, { owner: FOREIGN });
	await assert.rejects(ensure(world.ctx({ platform: "win32", ...gated(n) }), { boss: true }), /belongs to another account/);
	assert.ok(existsSync(world.stateDir), "the folder is in place");
	assert.deepEqual(tree(world.stateDir), [], "and nothing was written into it");
	assert.equal(powershells(n), 1);
});

test("R13-F002: a secondary slot's folder that lands foreign right after the protect step is refused BEFORE its servers\\<hash> folders are made: the tree stays empty", async () => {
	forgetSid();
	const w = new ServerWorld();
	try {
		const slot = { ...w.slot, primary: false, dir: join(w.stateDir, "servers", "0123456789abcdef") };
		const n = native(() => w.stateDir, { owner: FOREIGN });
		// The first gate finds no folder (nothing to read); the folder is made by protectFolder, and the gate inside prepareSlot refuses it before the mkdirs.
		const ctx = w.ctx({ platform: "win32", slot, prepare: (s, ms, g) => prepareSlot(s, "win32", n.run, ms, g), gate: (s, ms) => ownerGate(s.stateDir, n.run, ms) });
		await assert.rejects(ensure(ctx, { boss: true }), /belongs to another account/);
		assert.deepEqual(tree(w.stateDir), [], "no servers\\ and no servers\\<hash>\\ in the foreign folder");
		assert.equal(powershells(n), 1);
	} finally {
		await w.close();
	}
});

test("R13-F006: the owner-gate phase times the gate's own reads, not the protect and read-back around them", async () => {
	forgetSid();
	let t = 1_000;
	const n = native(() => world.stateDir);
	const ctx = world.ctx({
		platform: "win32", now: () => t,
		prepare: (s, ms, g) => { t += 5_000; prepareSlot(s, "win32", n.run, ms, g); },
		gate: (s, ms) => { t += 40; return ownerGate(s.stateDir, (f, a, m, e) => (f.endsWith("powershell.exe") ? (t += 300, n.run(f, a, m, e)) : n.run(f, a, m, e)), ms); },
	});
	const lock = await lockFor(ctx, 0);
	lock.release();
	const phase = readFileSync(join(world.stateDir, "server.log"), "utf8").split("\n").find((l) => l.includes("phase name=owner-gate"));
	assert.ok(phase, "logged");
	assert.match(phase!, /ms=\d+/);
	const ms = Number(/ms=(\d+)/.exec(phase!)![1]);
	assert.ok(ms < 5_000, `the 5 s of prepare are not in it (${ms})`);
	assert.ok(ms >= 40, `the gate's own time is (${ms})`);
});
