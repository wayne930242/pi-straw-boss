import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { system32, system32Path } from "../winpath.ts";
import { folderProblems, SYSTEM_SID } from "./acl.ts";

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
/**
 * The icacls arguments that make a folder the owner's: the owner set (this fails fast where it is not allowed, on a folder another account owns), no inheritance from above, full control
 * to the owner and SYSTEM by SID, passed on to what is created in it. No `/T`: what is already there is reset later.
 */
export const protectArgs = (dir: string, sid: string) => [dir, "/setowner", `*${sid}`, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`];

/** The DACL of a folder as SDDL, through `icacls <dir> /save <file>` (a UTF-16 file: the name, then the SDDL; no localized text is read). */
export function readDacl(dir: string, run: RunNative, timeoutMs?: number): string {
	const file = join(tmpdir(), `sb-acl-${process.pid}-${randomBytes(4).toString("hex")}.txt`);
	try {
		run("icacls.exe", [dir, "/save", file, "/Q"], timeoutMs);
		const raw = readFileSync(file);
		const text = (raw[0] === 0xff && raw[1] === 0xfe ? raw.subarray(2).toString("utf16le") : raw.toString("utf8")).replace(/\0/g, "");
		const sddl = text.split(/\r?\n/).map((line) => line.trim()).find((line) => /^[OGDS]:/.test(line));
		if (!sddl) throw new Error(`icacls /save wrote no SDDL: ${text.trim().slice(0, 120) || "nothing"}`);
		return sddl;
	} finally {
		rmSync(file, { force: true });
	}
}

/** Refuses a folder that is a link or a junction (`icacls` without `/L` would act on its target, and what is written there would land elsewhere). */
export function refuseLink(dir: string): void {
	let link = false;
	try {
		link = lstatSync(dir).isSymbolicLink();
	} catch { /* missing: made next */ }
	if (link) throw new Error(`${dir} is a link or junction, not a folder of its own`);
}

let sid: string | undefined;
/**
 * Makes the folder (and what is above it, as `mkdir -p` does), makes it the owner's and protected, and reads its DACL back before anything is written into it. At every start: a folder that
 * was removed and made again by other code, or one another account touched, is protected and checked again (only the SID is kept, a user does not change). Throws with the reason when
 * the folder is a link, cannot be made the owner's, or is not owner and SYSTEM only afterwards.
 */
export function protectFolder(dir: string, run: RunNative = runNative, timeoutMs?: number): void {
	mkdirSync(dir, { recursive: true });
	refuseLink(dir);
	try {
		sid ??= ownerSid(run, timeoutMs);
		run("icacls.exe", protectArgs(dir, sid), timeoutMs);
		const problems = folderProblems(readDacl(dir, run, timeoutMs), sid);
		if (problems.length) throw new Error(problems.join("; "));
	} catch (error) {
		throw new Error(`could not protect ${dir} before writing to it: ${(error as Error).message}`);
	}
}
/** For tests: forgets the owner's SID. */
export const forgetSid = () => { sid = undefined; };
