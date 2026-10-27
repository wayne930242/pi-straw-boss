import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { system32, system32Path } from "../winpath.ts";
import { asciiLine, CLM_CHECK, execFailure, folderProblems, OWNER_OK_SIDS, POWERSHELL_FLAGS, PROGRESS_OFF, SYSTEM_SID } from "./acl.ts";

// The state folder is protected before the first file is created in it (docs/specs/2026-10-26-sb-backend.md, The control socket): a cold start used to leave server.lock, the
// placeholder record, and server.log with the parent's inherited ACEs (Users read, Authenticated Users modify outside the profile) until the server's PowerShell call, 4 to 7 s later.
// Native calls do it, no PowerShell (whose start costs 2 to 5 s on a slow machine): `whoami /user` for the owner's SID (once per process: a user does not change), then `icacls <dir> /save`
// to read the DACL, and `icacls <dir> /inheritance:r /grant:r …` only where it is wrong (a folder that was just made is wrong by construction), and `/save` again to check it. No native call ever
// changes an OWNER (R12-F001): taking the ownership of a folder another account made would make the owner checks pass on a folder whose maker still holds handles to it. The server's own
// PowerShell call still resets what is below the folder and reads every SDDL and owner back; this closes the window before it.

/** Runs a system program (`whoami.exe`, `icacls.exe`) and returns its output; `timeoutMs` bounds it (the time a caller has left). */
export type RunNative = (file: string, args: string[], timeoutMs?: number, env?: Record<string, string>) => string;
export const NATIVE_MS = 15_000;
/** A system program by absolute path, run from System32 (a bare name is looked for in the current folder first, which is a project: nodejs/node#46264). */
export const nativeCommand = (name: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = NATIVE_MS, extraEnv?: Record<string, string>) => ({
	file: system32Path(name, env), args,
	options: { encoding: "utf8" as const, windowsHide: true, timeout, cwd: system32(env), stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[], ...(extraEnv ? { env: { ...env, ...extraEnv } } : {}) },
});
const runNative: RunNative = (name, args, timeoutMs = NATIVE_MS, extraEnv) => {
	const { file, args: argv, options } = nativeCommand(name, args, process.env, Math.max(500, Math.min(timeoutMs, NATIVE_MS)), extraEnv);
	return execFileSync(file, argv, options);
};
/** A native call a pi session does not wait for with its event loop: the owner read is a PowerShell start, 2 to 5 s. A synchronous runner (a test's fake) is accepted too. */
export type RunNativeAsync = (file: string, args: string[], timeoutMs?: number, env?: Record<string, string>) => string | Promise<string>;
/**
 * A program run without the event loop waiting for it (`execFileSync` holds a pi session still for the whole of a PowerShell start). It answers with the output, or fails with an error shaped as
 * `execFileSync`'s is (`status`, `stdout`, `stderr`; a timeout is `ETIMEDOUT` with a `spawn` syscall), so `execFailure` and `explainNative` read both alike. Its input is closed at once (a program
 * that waits for the end of its input would never end), and the child, its pipes and the timer never hold this process open: a read still pending when pi exits is dropped with it.
 */
export function execAsync(file: string, args: string[], { timeout, ...options }: { timeout: number; windowsHide?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }): Promise<string> {
	return new Promise((resolve, reject) => {
		let timedOut = false;
		const child = execFile(file, args, { encoding: "utf8", ...options }, (error, stdout, stderr) => {
			clearTimeout(timer);
			if (!error) return resolve(stdout);
			const code = (error as { code?: unknown }).code;
			// Only the kill this function's own timer made is a timeout: a death by another signal, or a `maxBuffer` kill, keeps the error's own words (F006).
			reject(Object.assign(error, { status: typeof code === "number" ? code : null, stdout, stderr, ...(timedOut ? { code: "ETIMEDOUT", syscall: `spawn ${file}` } : {}) }));
		});
		const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeout);
		timer.unref();
		child.stdin?.on("error", () => {});
		child.stdin?.end();
		for (const handle of [child, child.stdin, child.stdout, child.stderr] as ({ unref?: () => void } | null)[]) handle?.unref?.();
	});
}
const runNativeAsync: RunNativeAsync = (name, args, timeoutMs = NATIVE_MS, extraEnv) => {
	const { file, args: argv, options } = nativeCommand(name, args, process.env, Math.max(500, Math.min(timeoutMs, NATIVE_MS)), extraEnv);
	const { stdio: _stdio, ...rest } = options;
	return execAsync(file, argv, rest);
};

/** The owner's SID in the text `whoami /user /fo csv /nh` prints (`"DOMAIN\name","S-1-5-21-…"`; the CSV layout does not change with the display language). */
const sidIn = (output: string): string => {
	const text = output.trim();
	const sid = /"(S-1-[0-9-]+)"\s*$/.exec(text)?.[1];
	if (!sid) throw new Refused(`whoami did not give a SID: ${text.slice(0, 120) || "nothing"}`);
	return sid;
};
const WHOAMI = ["/user", "/fo", "csv", "/nh"];
export const ownerSid = (run: RunNative = runNative, timeoutMs?: number): string => sidIn(run("whoami.exe", WHOAMI, timeoutMs));

/** Every call carries `/L`: on a link icacls then acts on the link itself, never on its target (the folder is also looked at for a link before the calls). */
/** The icacls call that protects the folder: no inheritance from above, full control to the owner and SYSTEM by SID, passed on to what is created in it. No `/T`: what is already there is reset later. */
export const protectArgs = (dir: string, sid: string) => [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`, "/L"];

/** The DACL of a folder as SDDL, through `icacls <dir> /save <file>` (a UTF-16 file: the name, then the SDDL; no localized text is read). */
export function readDacl(dir: string, run: RunNative, timeoutMs?: number): string {
	const file = join(tmpdir(), `sb-acl-${process.pid}-${randomBytes(4).toString("hex")}.txt`);
	try {
		run("icacls.exe", [dir, "/save", file, "/L", "/Q"], timeoutMs);
		return sddlIn(file);
	} finally {
		rmSync(file, { force: true });
	}
}
/** `readDacl` for a caller that must not hold the event loop (the owner gate). */
async function readDaclAsync(dir: string, run: RunNativeAsync, timeoutMs?: number): Promise<string> {
	const file = join(tmpdir(), `sb-acl-${process.pid}-${randomBytes(4).toString("hex")}.txt`);
	try {
		await run("icacls.exe", [dir, "/save", file, "/L", "/Q"], timeoutMs);
		return sddlIn(file);
	} finally {
		rmSync(file, { force: true });
	}
}
function sddlIn(file: string): string {
	let raw: Buffer;
	try {
		raw = readFileSync(file);
	} catch (error) {
		// icacls ran (it exited 0) and left nothing to read: not a program that is missing.
		throw new Refused(`icacls /save wrote no file: ${asciiLine((error as Error).message)}`);
	}
	const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString("utf16le") : raw.toString("utf8")).replace(/\0/g, "");
	const sddl = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^[OGDS]:/.test(line));
	if (!sddl) throw new Refused(`icacls /save wrote no SDDL: ${text.trim().slice(0, 120) || "nothing"}`);
	return sddl;
}

/**
 * Gives a file of the state folder the folder's ACL again (`icacls <file> /reset`: its explicit ACEs go, it inherits the owner and SYSTEM grant). The owner can, with or without a filtered token,
 * where a file with an empty DACL (`D:PAI`) can be neither read nor deleted by it: the lock of a start that someone damaged is repaired here instead of being waited for as "held".
 */
export function resetFileAcl(file: string, run: RunNative = runNative, timeoutMs?: number): void {
	try {
		run("icacls.exe", [file, "/reset", "/L", "/Q"], timeoutMs);
	} catch (error) {
		throw new Refused(explainNative("protect", file, error as never));
	}
}

/** A folder this module refuses on its own check (a link, a DACL with a foreign ACE), as against a program that failed. */
class Refused extends Error {}
/** Refuses a folder that is a link or a junction (`icacls` without `/L` would act on its target, and what is written there would land elsewhere). */
export function refuseLink(dir: string): void {
	let link = false;
	try {
		link = lstatSync(dir).isSymbolicLink();
	} catch { /* missing: made next */ }
	if (link) throw new Refused(`${dir} is a link or junction, not a folder of its own`);
}

type Step = "whoami" | "protect" | "read-back";
/** A native call that failed, told by a fixed message for the step and the exit code, and the program's own words only as a sanitized ASCII detail. */
class NativeFailed extends Error {}
/**
 * What to tell and what to do when an icacls or whoami call fails. Keyed on the step and the exit code, since the program's text is in the console's code page (CP950, CP932, …), which
 * Node reads as UTF-8: half of it comes out garbled. That text stays as a detail, cut to printable ASCII.
 */
export function explainNative(step: Step, dir: string, error: Error & { stderr?: unknown; stdout?: unknown; status?: unknown; code?: unknown; syscall?: unknown; killed?: boolean; signal?: unknown }): string {
	const status = typeof error.status === "number" ? error.status : undefined;
	const detail = asciiLine(error.stderr) || asciiLine(error.stdout);
	const tail = `${step} step${status !== undefined ? `, exit ${status}` : ""}${detail ? `; detail: ${detail}` : ""}`;
	const advice = `Run pi once as administrator, or delete the folder ${dir}, then start again.`;
	// Only a program that failed to start is "not found" or "too slow": a read of a file icacls wrote has its own message.
	const spawned = typeof error.syscall === "string" && error.syscall.startsWith("spawn");
	if (!spawned && status === undefined && !detail && error.message) return `${step === "whoami" ? "whoami" : "icacls"} failed (${tail}; ${asciiLine(error.message)}).`;
	if (spawned && error.code === "ENOENT") return `${step === "whoami" ? "whoami.exe" : "icacls.exe"} was not found in the Windows System32 folder (${tail}).`;
	if (spawned && (error.code === "ETIMEDOUT" || error.killed || error.signal)) return `${step === "whoami" ? "whoami" : "icacls"} did not finish in time (${tail}). Start again; if it keeps happening, the machine is too busy or a security tool is holding it.`;
	if (step === "protect" && status === 5) return `this process may not change the permissions of the folder ${dir}, which belongs to another account or was made by an administrator's run. ${advice} (${tail}).`;
	if (status === 87) return `icacls did not accept its arguments on this Windows (${tail}). This is a bug in pi-straw-boss: please report it with this text.`;
	return `${step === "whoami" ? "whoami" : "icacls"} failed (${tail}).`;
}

let sid: string | undefined;
const failedStep = (step: Step, dir: string, error: unknown): never => {
	if (error instanceof Refused) throw error;
	throw new NativeFailed(explainNative(step, dir, error as never));
};
const stepOf = <T>(step: Step, dir: string, fn: () => T): T => {
	try {
		return fn();
	} catch (error) {
		return failedStep(step, dir, error);
	}
};
/** Windows PowerShell 5.1, relative to System32 (`nativeCommand` joins it there). */
const POWERSHELL = "WindowsPowerShell\\v1.0\\powershell.exe";
/**
 * The SID that owns a folder, read by one PowerShell start: `GetAccessControl(…Owner).GetOwner([SecurityIdentifier])` prints a SID, never a name that a listing would cut or another account
 * could imitate. The Constrained Language check comes first, so a machine that locks PowerShell down says so (the word is told as a sentence by `execFailure`). Read by `ownerGate` before the
 * first file is created in an existing folder, and by `secure` where a wrong DACL is about to be changed and the folder was not gated yet.
 */
const ownerCall = (paths: string[]) => {
	// One line per path: `<index>:<SID>`, or `<index>:-` for a path that is not there. A folder is read with `Directory`, a file with `File`.
	const script = [PROGRESS_OFF, "$ErrorActionPreference = 'Stop'", CLM_CHECK, "$i = 0", "foreach ($p in ($env:SB_OWNER_DIR -split '\\|')) {",
		// A path that went away between the existence check and the read (however .NET wraps the error) is "not there"; an error on a path that is still there stops the script and is a failed read.
		"  $a = $null", "  try { $a = if ([IO.Directory]::Exists($p)) { [IO.Directory]::GetAccessControl($p, [Security.AccessControl.AccessControlSections]::Owner) } elseif ([IO.File]::Exists($p)) { [IO.File]::GetAccessControl($p, [Security.AccessControl.AccessControlSections]::Owner) } else { $null } } catch { if (Test-Path -LiteralPath $p) { throw } }",
		"  if ($a) { \"$($i):\" + $a.GetOwner([Security.Principal.SecurityIdentifier]).Value } else { \"$($i):-\" }", "  $i++", "}"].join("\n");
	// The paths come in the environment, never quoted into the script: PowerShell reads U+2018 to U+201B as single quotes too, so a path such as `O’Neil` would break (or inject into) the script. `|` cannot be in a Windows path.
	return { file: POWERSHELL, args: [...POWERSHELL_FLAGS, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], env: { SB_OWNER_DIR: paths.join("|") } };
};
/** A native call that ran out of time (not one that failed): `execFileSync`'s timeout and `execAsync`'s own both say `ETIMEDOUT` from a `spawn` call. */
export const isTimeout = (error: unknown) => (error as { code?: unknown })?.code === "ETIMEDOUT" && String((error as { syscall?: unknown }).syscall ?? "").startsWith("spawn");
/** A read that ran out of time: a wait to try again, never a refusal of the folder, and not remembered. */
export class GateTimeout extends Error {}
const ownerUnread = (dir: string, error: unknown) => {
	const failed = error as Error & { stderr?: unknown; stdout?: unknown };
	const text = `the owner of ${dir} could not be read (${execFailure(failed, failed.stderr, failed.stdout)})`;
	return isTimeout(error) ? new GateTimeout(text) : new Refused(text);
};
/** The owners one read answered, by path index (`undefined`: the path was not there). A bare SID line (no index) is the first path's. */
const ownersIn = (dir: string, out: string, count: number): (string | undefined)[] => {
	const owners: (string | undefined)[] = Array.from({ length: count });
	let found = 0;
	for (const line of out.split(/\r?\n/).map((l) => l.trim())) {
		const m = /^(?:(\d+):)?(S-1-[0-9-]+|-)$/i.exec(line);
		if (!m) continue;
		const at = m[1] === undefined ? 0 : Number(m[1]);
		if (at < count) {
			owners[at] = m[2] === "-" ? undefined : m[2];
			found++;
		}
	}
	if (!found) throw new Refused(`the owner of ${dir} could not be read (PowerShell gave no SID: ${asciiLine(out).slice(0, 80) || "nothing"})`);
	if (!owners[0]) throw new Refused(`the owner of ${dir} could not be read (PowerShell gave no SID for it)`);
	return owners;
};
export function ownerOfFolder(dir: string, run: RunNative, timeoutMs?: number): string {
	const { file, args, env } = ownerCall([dir]);
	let out: string;
	try {
		out = run(file, args, timeoutMs, env);
	} catch (error) {
		throw ownerUnread(dir, error);
	}
	return ownersIn(dir, out, 1)[0]!;
}
/** The owners of the folder and of `also` (the slot's folder, the record) in ONE PowerShell start. */
async function ownersAsync(dir: string, also: string[], run: RunNativeAsync, timeoutMs?: number): Promise<(string | undefined)[]> {
	const { file, args, env } = ownerCall([dir, ...also]);
	let out: string;
	try {
		out = await run(file, args, timeoutMs, env);
	} catch (error) {
		throw ownerUnread(dir, error);
	}
	return ownersIn(dir, out, also.length + 1);
}
/** A folder as the file system knows it, so that one made again under the same name is not taken for the one that was checked (the volume and the file index). */
export const fileIdentity = (dir: string): string | undefined => {
	try {
		const info = statSync(dir, { bigint: true });
		return `${info.dev}:${info.ino}`;
	} catch {
		return undefined;
	}
};
/** The folders whose owner this process has read and found acceptable, by identity: a long-lived pi session reads it once, not at every start. */
const verified = new Map<string, string>();
const isVerified = (dir: string) => {
	const id = fileIdentity(dir);
	return id !== undefined && verified.get(dir.toLowerCase()) === id;
};
/** Remembers `dir` only if it is still the folder (`id`) that was read: one swapped in meanwhile was never read (R3-F001). */
const remember = (dir: string, id: string | undefined) => {
	if (id && fileIdentity(dir) === id) verified.set(dir.toLowerCase(), id);
};
/** The folders whose OWNER this process has read and found acceptable, closed or not: `secure` need not read it again before it fixes a wrong DACL. */
const ownerRead = new Map<string, string>();
const isOwnerRead = (dir: string) => {
	const id = fileIdentity(dir);
	return id !== undefined && ownerRead.get(dir.toLowerCase()) === id;
};
const rememberOwner = (dir: string, id: string | undefined) => {
	if (id && fileIdentity(dir) === id) ownerRead.set(dir.toLowerCase(), id);
};
/** Where the "folder stayed open" note goes: a process warning for the CLI; a pi session sets its own (pi silences `process.emitWarning`) so the look tells it once. */
let note: (text: string) => void = (text) => process.emitWarning(text);
export const setNote = (fn: ((text: string) => void) | undefined) => { note = fn ?? ((text) => process.emitWarning(text)); };
/** An open folder the gate could not close: its identity, the records' identities when it was read, and when it is read again (a record that changed is judged at once). */
const open = new Map<string, { id: string; seen: string; retryAt: number }>();
const seenOf = (paths: string[]) => paths.map((p) => fileIdentity(p) ?? "-").join(",");
const acceptableOwner = (owner: string) => owner.toUpperCase() === sid!.toUpperCase() || OWNER_OK_SIDS.includes(owner);
const foreignOwner = (dir: string, owner: string, tail: string) => `the folder ${dir} belongs to another account (${owner}), not to ${sid}. Run pi as that account (an elevated shell for an administrator's), or delete the folder ${dir}, then start again. (${tail})`;
/** How long a read of the owner that failed (Constrained Language Mode, a timeout) is not tried again: a session looks every 2 s, and a read is a blocking PowerShell start. */
export const OWNER_READ_RETRY_MS = 60_000;
/** What this process found out about a folder's owner when it could not be accepted, by the folder's identity: the refusal, and for a read that failed, the time it may be tried again. */
const refused = new Map<string, { id: string; error: Error; retryAt?: number }>();
/** The reads under way, by folder: a request that comes while one runs waits for it and starts none. */
const reading = new Map<string, { id: string | undefined; done: Promise<void> }>();
/**
 * The owner gate: before the FIRST write into an existing state folder (VM pass on f72b184: a refused start had left the lock, the placeholder record, the log and `start-error.json` inside the
 * attacker's folder), and before a record in it is trusted (R13-F003: a request that talks to a record's pipe, or writes in its folder, because of a record another account made there).
 * One PowerShell reads the folder's owner as a SID, and another account's folder is refused with nothing created in it, nothing sent to a pipe. It reads only where nothing has been read for this very
 * folder yet (`remember`, by file identity), so `protectFolder`'s owner read for a wrong DACL and a session's earlier look or start are not repeated; a refusal is remembered the same way (a session
 * looks every 2 s: a foreign folder costs one PowerShell, not one per look), and a read that failed is tried again after `OWNER_READ_RETRY_MS`. A folder that is not there is left to
 * `protectFolder`, which makes it. Called by every path that is about to create a file where no server is known to run, and by `probe` before it trusts a record. Returns whether this call read the owner.
 *
 * The read is asynchronous: a PowerShell start is 2 to 5 s, and a pi session whose event loop waited for it would freeze its screen. Requests that come while it runs (a look, a link request, the GUI)
 * share it, so they cost one PowerShell between them, and all get its verdict. A folder replaced meanwhile is not the one that was read: the read fails and nothing is remembered.
 */
export async function ownerGate(dir: string, run: RunNativeAsync = runNativeAsync, timeoutMs?: number, now: () => number = Date.now, also: string[] = []): Promise<boolean> {
	if (!existsSync(dir)) return false;
	refuseLink(dir);
	if (isVerified(dir)) return false;
	const key = dir.toLowerCase(), id = fileIdentity(dir), before = refused.get(key);
	if (before && before.id === id && (before.retryAt === undefined || now() < before.retryAt)) throw before.error;
	const held = open.get(key);
	if (held && held.id === id && now() < held.retryAt && held.seen === seenOf(also)) return false;
	const under = reading.get(key);
	if (under && under.id === id) {
		await under.done;
		return false;
	}
	const read = readOwner(dir, also, key, id, run, timeoutMs, now);
	reading.set(key, { id, done: read });
	try {
		await read;
		return true;
	} finally {
		if (reading.get(key)?.done === read) reading.delete(key);
	}
}
/** Whether the folder's DACL is exactly the owner's and SYSTEM's (what `secure` checks): a failed read says no. */
async function closed(dir: string, run: RunNativeAsync, timeoutMs: number | undefined): Promise<boolean> {
	try {
		return folderProblems(await readDaclAsync(dir, run, timeoutMs), sid!).length === 0;
	} catch {
		return false;
	}
}
/** Protects an open folder whose owner is acceptable (what `secure` does at a start) and remembers it; when that fails it is told once and read again no more than every `OWNER_READ_RETRY_MS`. */
async function shut(dir: string, id: string | undefined, key: string, seen: string, run: RunNativeAsync, timeoutMs: number | undefined, now: () => number): Promise<void> {
	try {
		if (!id || fileIdentity(dir) !== id) return;
		await run("icacls.exe", protectArgs(dir, sid!), timeoutMs);
		const problems = folderProblems(await readDaclAsync(dir, run, timeoutMs), sid!);
		if (problems.length) throw new Error(problems.join("; "));
		open.delete(key);
		remember(dir, id);
	} catch (error) {
		if (id) {
			if (!open.has(key)) note(`pi-straw-boss could not protect ${dir}: ${asciiLine((error as Error).message).slice(0, 200)}. It is read again at most every ${OWNER_READ_RETRY_MS / 1000} s.`);
			open.set(key, { id, seen, retryAt: now() + OWNER_READ_RETRY_MS });
		}
	}
}
async function readOwner(dir: string, also: string[], key: string, id: string | undefined, run: RunNativeAsync, timeoutMs: number | undefined, now: () => number): Promise<void> {
	let failure: Error, unreadable = false;
	const existed = new Set(also.filter((path) => existsSync(path))), seen = seenOf(also);
	try {
		if (!sid) {
			try {
				sid = sidIn(await run("whoami.exe", WHOAMI, timeoutMs));
			} catch (error) {
				if (isTimeout(error)) throw new GateTimeout(explainNative("whoami", dir, error as never));
				failedStep("whoami", dir, error);
			}
		}
		// The folder, the slot's folder and the record are judged by ONE PowerShell (F002): a record or folder planted by another account inside a folder the user owns is refused too. Judged at this read only:
		// the record's own identity changes on every write, so it is not remembered; a protected folder (B1) keeps others out of it afterwards.
		const owners = await ownersAsync(dir, also, run, timeoutMs);
		// The folder at the name now is the one that was read, or nothing is known of it: it is read again by the next request.
		if (fileIdentity(dir) !== id) throw new Error(`${dir} was replaced while its owner was read`);
		// A path that was there when the read began and reads '-' went away meanwhile: nothing is known of it, and the next request reads again (R2-F003).
		const vanished = also.findIndex((path, at) => owners[at + 1] === undefined && existed.has(path));
		if (vanished >= 0) throw new GateTimeout(`${also[vanished]} went away while its owner was read`);
		const bad = owners.findIndex((owner) => owner !== undefined && !acceptableOwner(owner));
		if (bad < 0) {
			refused.delete(key);
			rememberOwner(dir, id);
			// Remembered only for a folder that others cannot add entries to: a record another account puts into an open folder later is still judged (R2-F003). An open one is protected here, once,
			// so a look every 2 s does not start a PowerShell (R3-F002).
			if (await closed(dir, run, timeoutMs)) remember(dir, id);
			else await shut(dir, id, key, seen, run, timeoutMs, now);
			return;
		}
		const path = bad === 0 ? dir : also[bad - 1]!;
		failure = new Error(`could not check ${dir} before trusting or writing to it: ${foreignOwner(path, owners[bad]!, "owner read before the folder or a record in it is trusted; nothing was written into the folder")}`);
	} catch (error) {
		failure = error instanceof GateTimeout ? new GateTimeout(`could not check ${dir} before trusting or writing to it: ${error.message}`) : new Error(`could not check ${dir} before trusting or writing to it: ${(error as Error).message}`);
		unreadable = true;
		if (fileIdentity(dir) !== id) throw failure;
		// A read that ran out of time says nothing about the folder: the next request reads again (F006).
		if (failure instanceof GateTimeout) throw failure;
	}
	if (id) refused.set(key, { id, error: failure, ...(unreadable ? { retryAt: now() + OWNER_READ_RETRY_MS } : {}) });
	throw failure;
}
/**
 * Protects a folder and reads its DACL back. `fresh` is a folder this process has just made under an unpredictable name: its DACL is the parent's, wrong by construction, and it is protected at once.
 *
 * An EXISTING folder is not touched unless it has to be (R12; VM pass 5b, the decoy). A protect call (`/grant:r user:(OI)(CI)F`) on a folder another account made and granted the user WRITE_DAC
 * gives the user WRITE_OWNER, which is the state any later takeover (a `/setowner`, a repair) needs. So: `/save` first, and a folder whose DACL is already exactly the owner and SYSTEM is left alone
 * (one icacls call fewer on a normal start, and no PowerShell). Only a wrong DACL is acted on, and then only once the folder's owner is known as a SID (`ownerGate` has read it before this runs on
 * a start; otherwise one PowerShell reads it here): the user, BUILTIN\Administrators and SYSTEM go on to the protect call (an elevated run's folder, a folder that was damaged); any other owner, or an
 * owner that cannot be read, is refused with the folder untouched (but for the residual window of one process start between the identity check and the protect call, R4-F001), so nothing of the victim's is added to it and no secret is written. The same owner is gated again by the PowerShell steps before
 * any secret exists. A start gates a folder BEFORE any file is created in it (`ownerGate`, R13), so a refusal writes nothing there.
 */
function secure(target: string, run: RunNative, left: () => number | undefined, fresh = false): void {
	// A junction that took the name since the first look is refused before any call acts on it (`/L` is the second guard).
	refuseLink(target);
	const read = fileIdentity(target);
	if (!fresh) {
		let wrong: boolean;
		try {
			wrong = folderProblems(readDacl(target, run, left()), sid!).length > 0;
		} catch (error) {
			// A folder whose DACL cannot be read by the owner of the process is not the owner's own: it goes to the owner gate like a wrong one; any other failure is told.
			if ((error as { status?: unknown }).status !== 5) throw new NativeFailed(error instanceof Refused ? error.message : explainNative("read-back", target, error as never));
			wrong = true;
		}
		if (!wrong) return;
		// Read already by the gate that runs before `protectFolder` (this start, or an earlier one of this process for this very folder): not asked twice.
		if (!isVerified(target) && !isOwnerRead(target)) {
			const owner = ownerOfFolder(target, run, left());
			if (!acceptableOwner(owner)) throw new Refused(foreignOwner(target, owner, "owner read; its permissions are not the owner's and SYSTEM's; nothing in the folder was changed"));
			rememberOwner(target, read);
		}
	}
	// The folder whose owner was read is the one protected: a different one at the name now is refused (R4-F001; a swap in the process start itself is the residual).
	if (fileIdentity(target) !== read) throw new Refused(`${target} was replaced while its owner was read`);
	stepOf("protect", target, () => run("icacls.exe", protectArgs(target, sid!), left()));
	// The folder could have been swapped for a link between the first look and the calls: looked at again before anything is read from it or written into it.
	refuseLink(target);
	const problems = folderProblems(stepOf("read-back", target, () => readDacl(target, run, left())), sid!);
	if (problems.length) throw new Refused(problems.join("; "));
	// The owner was judged above (or by the gate) and the DACL is closed now: the gate need not read this folder again.
	if (!fresh) remember(target, read);
}
/**
 * Makes a folder that does not exist yet, protected from its first moment on: it is made under an unpredictable name beside its final one and protected, checked to be
 * empty and to have exactly the owner and SYSTEM, and only then renamed to its name. The name it has until then is not one anyone looks for, and the folder that appears at the final name already
 * has its ACL: the 443 ms in which `straw-boss\` carried the parent's Users and Authenticated Users ACEs (an agent folder outside the profile) are gone. When the final name appeared meanwhile
 * (another process made it), the temporary folder is dropped and false is returned: that folder is protected where it is.
 */
export type Rename = (from: string, to: string) => void;
/** Renames the temporary folder; a scanner or the indexer holding it makes the rename fail for a moment on Windows, so EPERM, EBUSY and EACCES are tried again (as `writeJson` does). */
export const RENAME_WAITS_MS = [10, 20, 40, 80, 160, 320, 500, 500, 500];
function renameHeld(from: string, to: string, rename: Rename): void {
	for (let tries = 0; ; tries++) {
		try {
			return rename(from, to);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (existsSync(to) || !["EPERM", "EBUSY", "EACCES"].includes(code)) throw error;
			if (tries >= RENAME_WAITS_MS.length) {
				// A handle that stays open (a security scanner, the indexer, a backup agent): said as that, with what to do. The folder is removed by a later start's sweep if it cannot be removed now.
				const total = Math.round(RENAME_WAITS_MS.reduce((a, b) => a + b, 0) / 100) / 10;
				throw new Refused(`something is holding the new folder ${from} (a security scanner, the indexer, or a backup tool?) and it could not be put in place for ${total} s (${code}). Start again in a moment; if it keeps happening, exclude ${dirname(from)} from that tool`);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_WAITS_MS[tries]!);
		}
	}
}
const TEMP_MAX_MS = 60_000;
/** Removes the temporary folders a crashed start left beside the state folder: a folder (not a link, not a file) of the form `<name>.<16 hex>.tmp` older than a minute (a start holds its temporary folder for well under that: three native calls and the rename). Never fails the start. */
function sweepTemps(dir: string, at: number): void {
	const parent = dirname(dir), prefix = `${basename(dir)}.`;
	try {
		for (const name of readdirSync(parent)) {
			if (!name.startsWith(prefix) || !new RegExp(`^${prefix.replace(/\./g, "\\.")}[0-9a-f]{16}\\.tmp$`).test(name)) continue;
			const path = join(parent, name), info = lstatSync(path);
			if (info.isDirectory() && !info.isSymbolicLink() && at - info.mtimeMs > TEMP_MAX_MS) rmSync(path, { recursive: true, force: true });
		}
	} catch { /* a leftover that cannot be removed is no reason to stop */ }
}
function intoPlace(dir: string, run: RunNative, left: () => number | undefined, rename: Rename): boolean {
	const parent = dirname(dir), temp = join(parent, `${basename(dir)}.${randomBytes(8).toString("hex")}.tmp`);
	mkdirSync(parent, { recursive: true });
	mkdirSync(temp);
	try {
		secure(temp, run, left, true);
		// Something put into it in the moment it was open to the parent's readers would be inside the folder for good.
		if (readdirSync(temp).length) throw new Refused(`something was put into ${temp} before it was protected`);
		try {
			renameHeld(temp, dir, rename);
		} catch (error) {
			if (!existsSync(dir)) throw error;
			rmSync(temp, { recursive: true, force: true });
			return false;
		}
		refuseLink(dir);
		return true;
	} catch (error) {
		try {
			rmSync(temp, { recursive: true, force: true });
		} catch { /* held by whatever held the rename: the next start's sweep removes it */ }
		throw error;
	}
}
/**
 * Makes the folder (and what is above it, as `mkdir -p` does), protects it and reads its DACL back before anything is written into it. A folder that is not there is
 * made protected from its first moment (`intoPlace`). At every start: a folder that was removed and made again by other code, or one another account touched, is protected and checked again
 * (only the SID is kept, a user does not change). Throws with the reason when the folder is a link, is another account's and has to be changed, or is not owner and SYSTEM only afterwards.
 */
export function protectFolder(dir: string, run: RunNative = runNative, timeoutMs?: number, now: () => number = Date.now, rename: Rename = renameSync): void {
	refuseLink(dir);
	sweepTemps(dir, now());
	// One time for all the calls: each gets what is left of it (at least 100 ms), not the whole of it again.
	const end = timeoutMs === undefined ? undefined : now() + timeoutMs, left = () => (end === undefined ? undefined : Math.max(100, end - now()));
	try {
		if (!sid) {
			sid = stepOf("whoami", dir, () => ownerSid(run, left()));
		}
		if (!existsSync(dir) && intoPlace(dir, run, left, rename)) return;
		secure(dir, run, left);
	} catch (error) {
		const text = `could not protect ${dir} before writing to it: ${(error as Error).message}`;
		// A read that ran out of time stays a wait, not a refusal of the folder (F006).
		throw error instanceof GateTimeout ? new GateTimeout(text) : new Error(text);
	}
}
/** For tests: forgets the owner's SID. */
export const forgetSid = () => { sid = undefined; verified.clear(); ownerRead.clear(); open.clear(); refused.clear(); reading.clear(); };
