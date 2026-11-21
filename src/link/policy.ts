import { accessSync, constants, lstatSync, readFileSync, watch as fsWatch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type Delegate, delegateOf, type Level, LEVELS, type LinkConfig, parseTeams, readLinkConfig, type TeamPolicy } from "./config.ts";

// An unattended device reads its policy from a fixed file that its own user cannot write (docs/specs/2026-10-25-straw-link.md, Storage and policy):
// no message or roster entry can change it. The file carries the device's trust levels and its teams, and `readEffectiveConfig` hands them to every reader
// of `link.teams` in place of config.json's. A file that is there but fails the check, or whose `teams` is malformed, refuses unattended mode: no link holder
// runs on that device (service.ts `look`), every sender is at `reply`, and the reason is said once.
// Opening a tower for a controller and the rest of unattended mode is later steps (docs/specs/2026-10-26-sb-backend.md, rebased step 6).

export const POLICY_PATH = "/etc/straw-link/policy.json";

/**
 * What a device may operate on the box (docs/specs/2026-11-07-link-operate.md §3.1): the units of the teams it is a roster admin of (`team`), plus the box's own units (`box`, the box owner's grant). Only meaningful beside `dispatch`
 * in `trust`; the box's check (src/server/operatescope.ts) is what ignores an entry without it.
 */
export type OperateGrant = "team" | "box";
export const OPERATE_GRANTS: readonly OperateGrant[] = ["team", "box"];

export type Policy =
	| { mode: "attended" }
	/** `operate`: who may operate what, empty when the policy has none. `operateRefused`: why a malformed `operate` was dropped (operate is then off for the whole box, `operate` is empty, and the rest of the policy is in force). */
	| { mode: "unattended"; trust: Map<string, Level>; teams: Map<string, TeamPolicy>; operate: Map<string, OperateGrant>; operateRefused?: string; delegate?: Delegate }
	| { mode: "refused"; reason: string };

/** Seams for tests: the file system's answers about owners and write access. */
export interface PolicyDeps {
	path?: string;
	uid?: number;
	stat?: (path: string) => { uid: number; symlink: boolean };
	writable?: (path: string) => boolean;
	read?: (path: string) => string;
	/** For the projects of the policy's teams (`projectProblem` refuses the home folder and the pi folders); default the real ones. */
	home?: string;
	agentDir?: string;
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

/**
 * The `operate` field: a map of device ids to `team` or `box`, or nothing. Anything else (a non-object, a bad id, another value) drops the whole map with the reason: operate fails closed for the box, and nothing else in the policy
 * is touched (`trust` and `teams` keep their own rules, and a bad `teams` still refuses the policy).
 */
function operateOf(raw: unknown, path: string): { operate: Map<string, OperateGrant>; operateRefused?: string } {
	if (raw === undefined) return { operate: new Map() };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { operate: new Map(), operateRefused: `${path}: operate has to be an object of device ids` };
	const out = new Map<string, OperateGrant>();
	for (const [device, grant] of Object.entries(raw)) {
		if (!/^[a-z2-7]{26}$/.test(device)) return { operate: new Map(), operateRefused: `${path}: operate names a key that is no device id` };
		if (!OPERATE_GRANTS.includes(grant as OperateGrant)) return { operate: new Map(), operateRefused: `${path}: operate gives a device something other than "team" or "box"` };
		out.set(device, grant as OperateGrant);
	}
	return { operate: out };
}

/** The devices `operate` names that are not at `dispatch` in `trust`: the grant has no effect on them (docs/specs/2026-11-07-link-operate.md §13). */
export function operateIdle(policy: Extract<Policy, { mode: "unattended" }>): string[] {
	return [...policy.operate.keys()].filter((device) => policy.trust.get(device) !== "dispatch");
}

/**
 * What the service says once about operate in the policy it reads: a refusal and its reason (again when the reason changes, or the refusal comes back after a good read), and the devices that are named with no effect. `log` writes link.log;
 * the policy being refused as a whole is said by the service itself.
 */
export function createOperateNotes(log: (entry: Record<string, unknown>) => void): (policy: Policy) => void {
	let refused = "", idle = "";
	return (policy) => {
		if (policy.mode !== "unattended") return;
		const reason = policy.operateRefused ?? "", devices = operateIdle(policy);
		if (reason !== refused) {
			refused = reason;
			if (reason) log({ event: "policy-operate-refused", reason });
		}
		const key = devices.join(",");
		if (key !== idle) {
			idle = key;
			if (devices.length) log({ event: "policy-operate-idle", devices });
		}
	};
}

/**
 * A string that changes whenever the policy file or its folder is replaced, rewritten, or has its owner or mode changed: inode, size, mtime, ctime, owner, group and mode of both (a mode, group or ACL change moves the ctime and can be what makes the check refuse; a mode change can be what makes the check refuse). A path that cannot be
 * read stamps as `gone`, with its error code, so a vanished file is a change too.
 */
export function policyStamp(path: string): string {
	const one = (p: string) => {
		try {
			const st = lstatSync(p);
			return `${st.ino}:${st.size}:${st.mtimeMs}:${st.uid}:${st.gid}:${st.mode}:${st.ctimeMs}`;
		} catch (error) {
			return `gone:${(error as NodeJS.ErrnoException).code ?? "?"}`;
		}
	};
	return `${one(path)}|${one(dirname(path))}`;
}

export interface PolicyWatchDeps {
	path?: string;
	stamp?: (path: string) => string;
	/** A file watch on a path; it calls `cb` on any event. Default `fs.watch`, with a path that cannot be watched left to the poll. */
	watch?: (path: string, cb: () => void) => { close(): void };
	/** One timer: runs `fn` once after `ms` and returns what cancels it (a test moves a clock of its own). Default `setTimeout`, unref'd. */
	after?: (ms: number, fn: () => void) => () => void;
	pollMs?: number;
}

/**
 * Watches the policy file (docs/specs/2026-11-07-link-operate.md §5.6): `fs.watch` on the file and on its folder, plus a poll of `policyStamp` every `pollMs` (default 2 s), which is what bounds how long an edit goes unseen. `onChange` runs on a watch
 * event and when the stamp differs from the last one seen; it never throws into the watcher. `stop` ends the poll and closes the watches.
 */
export function watchPolicy(onChange: () => void, d: PolicyWatchDeps = {}): { stop(): void } {
	const path = d.path ?? POLICY_PATH, stamp = d.stamp ?? policyStamp, pollMs = d.pollMs ?? 2000;
	const after = d.after ?? ((ms: number, fn: () => void) => {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	});
	const watch = d.watch ?? ((p: string, cb: () => void) => {
		const w = fsWatch(p, () => cb());
		// An error on a watch (the file replaced under it, a permission change) is a change to look at, not a crash.
		w.on("error", () => cb());
		w.unref();
		return w;
	});
	let seen = stamp(path), stopped = false, cancel: (() => void) | undefined;
	const changed = () => {
		if (stopped) return;
		seen = stamp(path);
		try {
			onChange();
		} catch { /* the caller's own failure is its to log */ }
	};
	const watchers: { close(): void }[] = [];
	for (const p of [path, dirname(path)]) {
		try {
			watchers.push(watch(p, changed));
		} catch { /* the poll covers a path that cannot be watched */ }
	}
	const tick = () => {
		if (stopped) return;
		if (stamp(path) !== seen) changed();
		if (!stopped) cancel = after(pollMs, tick);
	};
	cancel = after(pollMs, tick);
	return {
		stop() {
			if (stopped) return;
			stopped = true;
			cancel?.();
			for (const w of watchers) try { w.close(); } catch { /* already closed */ }
		},
	};
}

/** The device's policy: attended when there is no policy file (or it does not say `unattended`), the file's trust and teams when it passes the check, else refused. */
export function readPolicy(d: PolicyDeps = {}): Policy {
	const path = d.path ?? POLICY_PATH, read = d.read ?? ((p: string) => readFileSync(p, "utf8"));
	let text: string;
	try {
		text = read(path);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { mode: "attended" } : { mode: "refused", reason: `${path} cannot be read: ${(error as Error).message}` };
	}
	let json: { unattended?: unknown; trust?: unknown; teams?: unknown; operate?: unknown; delegate?: unknown };
	try {
		json = JSON.parse(text) as typeof json;
	} catch {
		return { mode: "refused", reason: `${path} is not valid JSON` };
	}
	if (json?.unattended !== true) return { mode: "attended" };
	const problem = policyProblem(path, d);
	if (problem) return { mode: "refused", reason: problem };
	// The boss's delegate (D14) is a grant like trust: a file the box's own user can write never names one. A malformed entry names none, and the rest of the policy holds.
	const operate = { ...operateOf(json.operate, path), ...((d) => (d ? { delegate: d } : {}))(delegateOf(json.delegate, () => undefined)) };
	if (json.teams === undefined) return { mode: "unattended", trust: levels(json.trust), teams: new Map(), ...operate };
	if (typeof json.teams !== "object" || json.teams === null || Array.isArray(json.teams)) return { mode: "refused", reason: `${path}: teams has to be an object of team ids` };
	const home = d.home ?? homedir(), bad: string[] = [];
	const teams = parseTeams(json.teams as Record<string, unknown>, { home, agentDir: d.agentDir ?? join(home, ".pi", "agent") }, (reason) => bad.push(reason), false);
	return bad.length ? { mode: "refused", reason: `${path}: ${bad.join("; ")}` } : { mode: "unattended", trust: levels(json.trust), teams, ...operate };
}

/** Whether the policy file says unattended; none while it cannot be read or is refused (the log keeps its last answer then). */
export function unattendedNow(d: PolicyDeps = {}): boolean | undefined {
	const policy = readPolicy(d);
	return policy.mode === "refused" ? undefined : policy.mode === "unattended";
}

/**
 * The teams and trust every reader of `link.teams` sees under `policy`: config.json's `link` section on an attended device; the policy file's trust and teams on an
 * unattended one, which ignores config.json's `link` section entirely (a file its own user can write cannot grant a team); nothing on a refused one, whose holder does not run.
 */
export function readEffectiveConfig(policy: Policy, stateDir: string, dirs: { home: string; agentDir: string }): LinkConfig {
	if (policy.mode === "unattended") return { teams: new Map(policy.teams), trust: new Map(policy.trust), problems: [], ...(policy.delegate ? { delegate: policy.delegate } : {}) };
	if (policy.mode === "refused") return { teams: new Map(), trust: new Map(), problems: [] };
	return readLinkConfig(stateDir, dirs);
}
