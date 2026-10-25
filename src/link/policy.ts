import { accessSync, constants, lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Level, LEVELS } from "./config.ts";

// An unattended device reads its policy from a fixed file that its own user cannot write (docs/specs/2026-10-25-straw-link.md, Storage and policy):
// no message or roster entry can change it. This step reads it and checks it; opening a tower for a controller and the rest of unattended mode is
// step 6. A file that is there but fails the check refuses unattended mode: the caller treats every sender as `reply` and says why.

export const POLICY_PATH = "/etc/straw-link/policy.json";

export type Policy =
	| { mode: "attended" }
	| { mode: "unattended"; trust: Map<string, Level> }
	| { mode: "refused"; reason: string };

/** Seams for tests: the file system's answers about owners and write access. */
export interface PolicyDeps {
	path?: string;
	uid?: number;
	stat?: (path: string) => { uid: number; symlink: boolean };
	writable?: (path: string) => boolean;
	read?: (path: string) => string;
}

const realStat = (path: string) => {
	const st = lstatSync(path);
	return { uid: st.uid, symlink: st.isSymbolicLink() };
};
const realWritable = (path: string) => {
	try {
		accessSync(path, constants.W_OK);
		return true;
	} catch {
		return false;
	}
};

/** The owner and write check for the policy file and its directory: both owned by another user, neither a symlink, neither writable by this user. */
export function policyProblem(path: string, d: PolicyDeps = {}): string | undefined {
	const uid = d.uid ?? process.getuid?.(), stat = d.stat ?? realStat, writable = d.writable ?? realWritable;
	if (uid === undefined) return "this platform has no user ids, so the policy file's owner cannot be checked";
	for (const p of [path, dirname(path)]) {
		let st: { uid: number; symlink: boolean };
		try {
			st = stat(p);
		} catch (error) {
			return `${p} cannot be read: ${(error as Error).message}`;
		}
		if (st.symlink) return `${p} is a symlink`;
		if (st.uid === uid) return `${p} is owned by this device's own user`;
		if (writable(p)) return `${p} is writable by this device's own user`;
	}
	return undefined;
}

/** `true` stands for the level `dispatch`; anything else that is not a level is left out. */
function levels(raw: unknown): Map<string, Level> {
	const out = new Map<string, Level>();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	for (const [device, level] of Object.entries(raw)) {
		if (!/^[a-z2-7]{26}$/.test(device)) continue;
		if (level === true) out.set(device, "dispatch");
		else if (LEVELS.includes(level as Level)) out.set(device, level as Level);
	}
	return out;
}

/** The device's policy: attended when there is no policy file (or it does not say `unattended`), the file's trust when it passes the check, else refused. */
export function readPolicy(d: PolicyDeps = {}): Policy {
	const path = d.path ?? POLICY_PATH, read = d.read ?? ((p: string) => readFileSync(p, "utf8"));
	let text: string;
	try {
		text = read(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { mode: "attended" } : { mode: "refused", reason: `${path} cannot be read: ${(error as Error).message}` };
	}
	let json: { unattended?: unknown; trust?: unknown };
	try {
		json = JSON.parse(text) as typeof json;
	} catch {
		return { mode: "refused", reason: `${path} is not valid JSON` };
	}
	if (json?.unattended !== true) return { mode: "attended" };
	const problem = policyProblem(path, d);
	return problem ? { mode: "refused", reason: problem } : { mode: "unattended", trust: levels(json.trust) };
}
