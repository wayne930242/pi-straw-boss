import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { SYSTEM_SID } from "./acl.ts";

// The state folder is protected before the first file is created in it (docs/specs/2026-10-26-sb-backend.md, The control socket): a cold start used to leave server.lock, the
// placeholder record, and server.log with the parent's inherited ACEs (Users read, Authenticated Users modify outside the profile) until the server's PowerShell call, 4 to 7 s later.
// Two native calls do it, no PowerShell (whose start costs 2 to 5 s on a slow machine): `whoami /user` for the owner's SID, and `icacls <dir> /inheritance:r /grant:r`. The server's own
// PowerShell call still resets what is below the folder and reads every SDDL back; this only closes the window before it.

export type RunNative = (file: string, args: string[]) => string;
const runNative: RunNative = (file, args) => execFileSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });

/** The owner's SID from `whoami /user /fo csv /nh` (`"DOMAIN\name","S-1-5-21-…"`; the CSV layout does not change with the display language). */
export function ownerSid(run: RunNative = runNative): string {
	const text = run("whoami.exe", ["/user", "/fo", "csv", "/nh"]);
	const sid = /"(S-1-[0-9-]+)"\s*$/.exec(text.trim())?.[1];
	if (!sid) throw new Error(`whoami did not give a SID: ${text.trim().slice(0, 120) || "nothing"}`);
	return sid;
}
/** The icacls arguments that protect a folder: no inheritance from above, full control to the owner and SYSTEM by SID, passed on to what is created in it. No `/T`: what is already there is reset later. */
export const protectArgs = (dir: string, sid: string) => [dir, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`, `*${SYSTEM_SID}:(OI)(CI)F`];

const protectedDirs = new Set<string>();
/** Makes the folder (and what is above it, as `mkdir -p` does) and protects it, once per process; a folder that was removed since is protected again. Throws with the reason when it cannot. */
export function protectFolder(dir: string, run: RunNative = runNative): void {
	if (protectedDirs.has(dir) && existsSync(dir)) return;
	mkdirSync(dir, { recursive: true });
	try {
		run("icacls.exe", protectArgs(dir, ownerSid(run)));
	} catch (error) {
		throw new Error(`could not protect ${dir} before writing to it: ${(error as Error).message}`);
	}
	protectedDirs.add(dir);
}
