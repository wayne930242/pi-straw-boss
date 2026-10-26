import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { system32, system32Path } from "../winpath.ts";
import { asciiLine, folderProblems, SYSTEM_SID } from "./acl.ts";

// The state folder is protected before the first file is created in it (docs/specs/2026-10-26-sb-backend.md, The control socket): a cold start used to leave server.lock, the
// placeholder record, and server.log with the parent's inherited ACEs (Users read, Authenticated Users modify outside the profile) until the server's PowerShell call, 4 to 7 s later.
// Native calls do it, no PowerShell (whose start costs 2 to 5 s on a slow machine): `whoami /user` for the owner's SID (once per process: a user does not change), then at every
// start `icacls <dir> /setowner … /inheritance:r /grant:r …` and `icacls <dir> /save` to read the DACL back and check it. The server's own PowerShell call still resets what is
// below the folder and reads every SDDL back; this closes the window before it, and refuses a folder it cannot make the owner's.

/** Runs a system program (`whoami.exe`, `icacls.exe`) and returns its output; `timeoutMs` bounds it (the time a caller has left). */
export type RunNative = (file: string, args: string[], timeoutMs?: number) => string;
export const NATIVE_MS = 15_000;
/** A system program by absolute path, run from System32 (a bare name is looked for in the current folder first, which is a project: nodejs/node#46264). */
export const nativeCommand = (name: string, args: string[], env: NodeJS.ProcessEnv = process.env, timeout = NATIVE_MS) => ({
	file: system32Path(name, env), args,
	options: { encoding: "utf8" as const, windowsHide: true, timeout, cwd: system32(env), stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[] },
});
const runNative: RunNative = (name, args, timeoutMs = NATIVE_MS) => {
	const { file, args: argv, options } = nativeCommand(name, args, process.env, Math.max(500, Math.min(timeoutMs, NATIVE_MS)));
	return execFileSync(file, argv, options);
};

/** The owner's SID from `whoami /user /fo csv /nh` (`"DOMAIN\name","S-1-5-21-…"`; the CSV layout does not change with the display language). */
export function ownerSid(run: RunNative = runNative, timeoutMs?: number): string {
	const text = run("whoami.exe", ["/user", "/fo", "csv", "/nh"], timeoutMs);
	const sid = /"(S-1-[0-9-]+)"\s*$/.exec(text.trim())?.[1];
	if (!sid) throw new Error(`whoami did not give a SID: ${text.trim().slice(0, 120) || "nothing"}`);
	return sid;
}
/** The icacls call that makes the owner the folder's owner (it fails fast where that is not allowed, on a folder another account owns). `/setowner` is a form of its own in icacls' syntax: it is not combined with the grant. */
export const ownerArgs = (dir: string, sid: string) => [dir, "/setowner", `*${sid}`, "/Q"];
/** The icacls call that protects the folder: no inheritance from above, full control to the owner and SYSTEM by SID, passed on to what is created in it. No `/T`: what is already there is reset later. */
export const protectArgs = (dir: string, sid: string) => [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`];

/** The DACL of a folder as SDDL, through `icacls <dir> /save <file>` (a UTF-16 file: the name, then the SDDL; no localized text is read). */
export function readDacl(dir: string, run: RunNative, timeoutMs?: number): string {
	const file = join(tmpdir(), `sb-acl-${process.pid}-${randomBytes(4).toString("hex")}.txt`);
	try {
		run("icacls.exe", [dir, "/save", file, "/Q"], timeoutMs);
		const raw = readFileSync(file);
		const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString("utf16le") : raw.toString("utf8")).replace(/\0/g, "");
		const sddl = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^[OGDS]:/.test(line));
		if (!sddl) throw new Refused(`icacls /save wrote no SDDL: ${text.trim().slice(0, 120) || "nothing"}`);
		return sddl;
	} finally {
		rmSync(file, { force: true });
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

type Step = "whoami" | "owner" | "protect" | "read-back";
/** A native call that failed, told by a fixed message for the step and the exit code, and the program's own words only as a sanitized ASCII detail. */
class NativeFailed extends Error {}
const OWNER_REFUSED = new Set([5, 1307, 1314]);
/**
 * What to tell and what to do when an icacls or whoami call fails. Keyed on the step and the exit code, since the program's text is in the console's code page (CP950, CP932, …), which
 * Node reads as UTF-8: half of it comes out garbled. That text stays as a detail, cut to printable ASCII.
 */
export function explainNative(step: Step, dir: string, error: Error & { stderr?: unknown; stdout?: unknown; status?: unknown; code?: unknown; killed?: boolean; signal?: unknown }): string {
	const status = typeof error.status === "number" ? error.status : undefined;
	const detail = asciiLine(error.stderr) || asciiLine(error.stdout);
	const tail = `${step} step${status !== undefined ? `, exit ${status}` : ""}${detail ? `; detail: ${detail}` : ""}`;
	const advice = `Run pi once as administrator, or delete the folder ${dir}, then start again.`;
	if (error.code === "ENOENT") return `${step === "whoami" ? "whoami.exe" : "icacls.exe"} was not found in the Windows System32 folder (${tail}).`;
	if (error.code === "ETIMEDOUT" || error.killed || error.signal) return `${step === "whoami" ? "whoami" : "icacls"} did not finish in time (${tail}). Start again; if it keeps happening, the machine is too busy or a security tool is holding it.`;
	if (step === "owner" && status !== undefined && OWNER_REFUSED.has(status)) return `the folder ${dir} belongs to another account, usually Administrators from a run of pi as administrator, and this process may not take it over. ${advice} (${tail}).`;
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
/** Makes the folder the owner's, protects it, and reads its DACL back; the folder is `target`, which holds nothing yet. */
function secure(target: string, run: RunNative, left: () => number | undefined): void {
	stepOf("owner", target, () => run("icacls.exe", ownerArgs(target, sid!), left()));
	stepOf("protect", target, () => run("icacls.exe", protectArgs(target, sid!), left()));
	// The folder could have been swapped for a link between the first look and the calls: looked at again before anything is read from it or written into it.
	refuseLink(target);
	const problems = folderProblems(stepOf("read-back", target, () => readDacl(target, run, left())), sid!);
	if (problems.length) throw new Refused(problems.join("; "));
}
/**
 * Makes a folder that does not exist yet, protected from its first moment on: it is made under an unpredictable name beside its final one, made the owner's and protected, checked to be
 * empty and to have exactly the owner and SYSTEM, and only then renamed to its name. The name it has until then is not one anyone looks for, and the folder that appears at the final name already
 * has its ACL: the 443 ms in which `straw-boss\` carried the parent's Users and Authenticated Users ACEs (an agent folder outside the profile) are gone. When the final name appeared meanwhile
 * (another process made it), the temporary folder is dropped and false is returned: that folder is protected where it is.
 */
function intoPlace(dir: string, run: RunNative, left: () => number | undefined): boolean {
	const parent = dirname(dir), temp = join(parent, `${basename(dir)}.${randomBytes(8).toString("hex")}.tmp`);
	mkdirSync(parent, { recursive: true });
	mkdirSync(temp);
	try {
		secure(temp, run, left);
		// Something put into it in the moment it was open to the parent's readers would be inside the folder for good.
		if (readdirSync(temp).length) throw new Refused(`something was put into ${temp} before it was protected`);
		try {
			renameSync(temp, dir);
		} catch (error) {
			if (!existsSync(dir)) throw error;
			rmSync(temp, { recursive: true, force: true });
			return false;
		}
		refuseLink(dir);
		return true;
	} catch (error) {
		rmSync(temp, { recursive: true, force: true });
		throw error;
	}
}
/**
 * Makes the folder (and what is above it, as `mkdir -p` does), makes it the owner's and protected, and reads its DACL back before anything is written into it. A folder that is not there is
 * made protected from its first moment (`intoPlace`). At every start: a folder that was removed and made again by other code, or one another account touched, is protected and checked again
 * (only the SID is kept, a user does not change). Throws with the reason when the folder is a link, cannot be made the owner's, or is not owner and SYSTEM only afterwards.
 */
export function protectFolder(dir: string, run: RunNative = runNative, timeoutMs?: number, now: () => number = Date.now): void {
	refuseLink(dir);
	// One time for all the calls: each gets what is left of it (at least 100 ms), not the whole of it again.
	const end = timeoutMs === undefined ? undefined : now() + timeoutMs, left = () => (end === undefined ? undefined : Math.max(100, end - now()));
	try {
		sid ??= stepOf("whoami", dir, () => ownerSid(run, left()));
		if (!existsSync(dir) && intoPlace(dir, run, left)) return;
		secure(dir, run, left);
	} catch (error) {
		throw new Error(`could not protect ${dir} before writing to it: ${(error as Error).message}`);
	}
}
/** For tests: forgets the owner's SID. */
export const forgetSid = () => { sid = undefined; };
