import { execFileSync } from "node:child_process";
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

/** The owner's SID from `whoami /user /fo csv /nh` (`"DOMAIN\name","S-1-5-21-…"`; the CSV layout does not change with the display language). */
export function ownerSid(run: RunNative = runNative, timeoutMs?: number): string {
	const text = run("whoami.exe", ["/user", "/fo", "csv", "/nh"], timeoutMs).trim();
	const sid = /"(S-1-[0-9-]+)"\s*$/.exec(text)?.[1];
	if (!sid) throw new Refused(`whoami did not give a SID: ${text.slice(0, 120) || "nothing"}`);
	return sid;
}

/** Every call carries `/L`: on a link icacls then acts on the link itself, never on its target (the folder is also looked at for a link before the calls). */
/** The icacls call that protects the folder: no inheritance from above, full control to the owner and SYSTEM by SID, passed on to what is created in it. No `/T`: what is already there is reset later. */
export const protectArgs = (dir: string, sid: string) => [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`, "/L"];

/** The DACL of a folder as SDDL, through `icacls <dir> /save <file>` (a UTF-16 file: the name, then the SDDL; no localized text is read). */
export function readDacl(dir: string, run: RunNative, timeoutMs?: number): string {
	const file = join(tmpdir(), `sb-acl-${process.pid}-${randomBytes(4).toString("hex")}.txt`);
	try {
		run("icacls.exe", [dir, "/save", file, "/L", "/Q"], timeoutMs);
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
	} finally {
		rmSync(file, { force: true });
	}
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
const stepOf = <T>(step: Step, dir: string, fn: () => T): T => {
	try {
		return fn();
	} catch (error) {
		if (error instanceof Refused) throw error;
		throw new NativeFailed(explainNative(step, dir, error as never));
	}
};
/** Windows PowerShell 5.1, relative to System32 (`nativeCommand` joins it there). */
const POWERSHELL = "WindowsPowerShell\\v1.0\\powershell.exe";
/**
 * The SID that owns a folder, read by one PowerShell start: `GetAccessControl(…Owner).GetOwner([SecurityIdentifier])` prints a SID, never a name that a listing would cut or another account
 * could imitate. The Constrained Language check comes first, so a machine that locks PowerShell down says so (the word is told as a sentence by `execFailure`). Read by `ownerGate` before the
 * first file is created in an existing folder, and by `secure` where a wrong DACL is about to be changed and the folder was not gated yet.
 */
export function ownerOfFolder(dir: string, run: RunNative, timeoutMs?: number): string {
	const script = [PROGRESS_OFF, CLM_CHECK, "$d = $env:SB_OWNER_DIR", "[IO.Directory]::GetAccessControl($d, [Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value"].join("\n");
	let out: string;
	try {
		// The folder comes in the environment, never quoted into the script: PowerShell reads U+2018 to U+201B as single quotes too, so a path such as `O’Neil` would break (or inject into) the script.
		out = run(POWERSHELL, [...POWERSHELL_FLAGS, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], timeoutMs, { SB_OWNER_DIR: dir });
	} catch (error) {
		const failed = error as Error & { stderr?: unknown; stdout?: unknown };
		throw new Refused(`the owner of ${dir} could not be read (${execFailure(failed, failed.stderr, failed.stdout)})`);
	}
	const found = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^S-1-[0-9-]+$/i.test(line)).pop();
	if (!found) throw new Refused(`the owner of ${dir} could not be read (PowerShell gave no SID: ${asciiLine(out).slice(0, 80) || "nothing"})`);
	return found;
}
/** A folder as the file system knows it, so that one made again under the same name is not taken for the one that was checked (the volume and the file index). */
const identityOf = (dir: string): string | undefined => {
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
	const id = identityOf(dir);
	return id !== undefined && verified.get(dir.toLowerCase()) === id;
};
const remember = (dir: string) => {
	const id = identityOf(dir);
	if (id) verified.set(dir.toLowerCase(), id);
};
const acceptableOwner = (owner: string) => owner.toUpperCase() === sid!.toUpperCase() || OWNER_OK_SIDS.includes(owner);
const foreignOwner = (dir: string, owner: string, tail: string) => `the folder ${dir} belongs to another account (${owner}), not to ${sid}. Run pi as that account (an elevated shell for an administrator's), or delete the folder ${dir}, then start again. (${tail})`;
/**
 * The gate before the FIRST write into an existing state folder (VM pass on f72b184: a refused start left the lock, the placeholder record, the log and `start-error.json` inside the attacker's folder):
 * one PowerShell reads the folder's owner as a SID, and another account's folder is refused with nothing created in it. It reads only where nothing has been read for this very folder yet
 * (`remember`, by file identity), so `protectFolder`'s owner read for a wrong DACL and a session's earlier start are not repeated. A folder that is not there is left to \`protectFolder\`, which makes it.
 * Called by every path that is about to create a file where no server is known to run (a cold start, a stop of a server that is down); a request that finds a live server writes nothing of its own
 * and runs no PowerShell. Returns whether the owner was read.
 */
export function ownerGate(dir: string, run: RunNative = runNative, timeoutMs?: number): boolean {
	if (!existsSync(dir)) return false;
	refuseLink(dir);
	if (isVerified(dir)) return false;
	try {
		if (!sid) sid = stepOf("whoami", dir, () => ownerSid(run, timeoutMs));
		const owner = ownerOfFolder(dir, run, timeoutMs);
		if (!acceptableOwner(owner)) throw new Refused(foreignOwner(dir, owner, "owner read before the first write; nothing was written into the folder"));
		remember(dir);
		return true;
	} catch (error) {
		throw new Error(`could not check ${dir} before writing to it: ${(error as Error).message}`);
	}
}
/**
 * Protects a folder and reads its DACL back. `fresh` is a folder this process has just made under an unpredictable name: its DACL is the parent's, wrong by construction, and it is protected at once.
 *
 * An EXISTING folder is not touched unless it has to be (R12; VM pass 5b, the decoy). A protect call (`/grant:r user:(OI)(CI)F`) on a folder another account made and granted the user WRITE_DAC
 * gives the user WRITE_OWNER, which is the state any later takeover (a `/setowner`, a repair) needs. So: `/save` first, and a folder whose DACL is already exactly the owner and SYSTEM is left alone
 * (one icacls call fewer on a normal start, and no PowerShell). Only a wrong DACL is acted on, and then only once the folder's owner is known as a SID (`ownerGate` has read it before this runs on
 * a start; otherwise one PowerShell reads it here): the user, BUILTIN\Administrators and SYSTEM go on to the protect call (an elevated run's folder, a folder that was damaged); any other owner, or an
 * owner that cannot be read, is refused with the folder untouched, so nothing of the victim's is added to it and no secret is written. The same owner is gated again by the PowerShell steps before
 * any secret exists. A start gates a folder BEFORE any file is created in it (`ownerGate`, R13), so a refusal writes nothing there.
 */
function secure(target: string, run: RunNative, left: () => number | undefined, fresh = false): void {
	// A junction that took the name since the first look is refused before any call acts on it (`/L` is the second guard).
	refuseLink(target);
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
		if (!isVerified(target)) {
			const owner = ownerOfFolder(target, run, left());
			if (!acceptableOwner(owner)) throw new Refused(foreignOwner(target, owner, "owner read; its permissions are not the owner's and SYSTEM's; nothing in the folder was changed"));
			remember(target);
		}
	}
	stepOf("protect", target, () => run("icacls.exe", protectArgs(target, sid!), left()));
	// The folder could have been swapped for a link between the first look and the calls: looked at again before anything is read from it or written into it.
	refuseLink(target);
	const problems = folderProblems(stepOf("read-back", target, () => readDacl(target, run, left())), sid!);
	if (problems.length) throw new Refused(problems.join("; "));
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
		throw new Error(`could not protect ${dir} before writing to it: ${(error as Error).message}`);
	}
}
/** For tests: forgets the owner's SID. */
export const forgetSid = () => { sid = undefined; verified.clear(); };
