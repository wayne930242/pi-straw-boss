import { mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSyncExe } from "../exe.mjs";
import { inside, inTestRun, refuse, TEST_ROOT } from "../server/testguard.ts";
import { startOf } from "../startof.ts";
import { parseLsofCwd } from "./cwd.ts";

// The kill guard of a test run (the pattern of src/server/testguard.ts): a signal goes only to a process the test itself started, which it noted by pid and start time (`noteOwned`), and only while that
// process works inside the run's root. Anything else is refused, recorded under the root (the process fails when it ends unless a test asserted the refusal and took it with `consumeRefusals`), and thrown.
// Outside a test run every function here does nothing; the guard is the one place every signal of src/procs passes.

export const KILLS_DIR = "kills";

/** The facts about a pid the guard needs; injected so a test of the guard signals nothing and reads nothing. */
export interface GuardDeps {
	proc?: NodeJS.ProcessEnv;
	argv?: string[];
	/** The start time of the process now, undefined when it is gone. */
	startOf?: (pid: number) => string | undefined;
	/** Its working folder now, undefined when it cannot be read. */
	cwdOf?: (pid: number) => string | undefined;
}

const cwdOfSync = (pid: number): string | undefined => {
	try {
		if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
		return parseLsofCwd(String(execFileSyncExe("lsof", ["-a", "-d", "cwd", "-Fpfn", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, killSignal: "SIGKILL" }))).get(pid)?.path;
	} catch {
		return undefined;
	}
};

/**
 * Records that this test run started `pid`, with the start time it has now (undefined when it cannot be told: the note is then not written, and the pid is not signallable). The note holds the pid of the
 * process that wrote it, so the end-of-run check of a process reaps only its own. Returns the start time noted.
 */
export function noteOwned(pid: number | undefined, { proc = process.env, argv = process.argv, startOf: read = startOf }: GuardDeps = {}): string | undefined {
	if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 1 || !inTestRun(proc, argv) || !proc[TEST_ROOT]) return undefined;
	const time = read(pid);
	if (!time) return undefined;
	mkdirSync(join(proc[TEST_ROOT], KILLS_DIR), { recursive: true });
	writeFileSync(join(proc[TEST_ROOT], KILLS_DIR, String(pid)), `${process.pid}\n${time}\n`);
	return time;
}

/** Drops the note of a process that has ended. */
export function forgetOwned(pid: number, proc: NodeJS.ProcessEnv = process.env): void {
	if (proc[TEST_ROOT]) rmSync(join(proc[TEST_ROOT], KILLS_DIR, String(pid)), { force: true });
}

/** Throws unless a signal to `target` (a pid, or `-pgid` for a group) may go out. Does nothing outside a test run. A process that is already gone passes: its signal is an ESRCH. */
export function guardSignal(target: number, signal: string, { proc = process.env, argv = process.argv, startOf: read = startOf, cwdOf = cwdOfSync }: GuardDeps = {}): void {
	if (!inTestRun(proc, argv)) return;
	const root = proc[TEST_ROOT], pid = Math.abs(target), what = `${signal} to ${target < 0 ? "group" : "pid"} ${pid}`;
	if (!root) return refuse(`a test run without tests/setup.ts would send ${what}: run the tests with \`npm test\` or \`npm run test:one -- <file>\``, proc);
	if (!Number.isSafeInteger(pid) || pid <= 1) return refuse(`a test run would send ${what}`, proc);
	let noted: string | undefined;
	try {
		noted = readFileSync(join(root, KILLS_DIR, String(pid)), "utf8").split("\n")[1]?.trim();
	} catch { /* not noted */ }
	if (!noted) return refuse(`a test run would send ${what}, a process this test did not start (note it with noteOwned when it does)`, proc);
	const now = read(pid);
	// A process that is gone passes: its signal is an ESRCH. A group whose leader is gone does not: its other members are unchecked, and a signal to the group would reach them.
	if (now === undefined) return target < 0 ? refuse(`a test run would send ${what}: the group leader is gone, so the other members of the group are not known to be this test's`, proc) : undefined;
	if (now !== noted) return refuse(`a test run would send ${what}: the pid is another process now than the one this test started (start time differs)`, proc);
	const cwd = cwdOf(pid);
	if (cwd === undefined || !inside(cwd, root)) return refuse(`a test run would send ${what}, a process whose working folder is ${cwd === undefined ? "not readable" : "outside the run's temp root"} (${cwd ?? "?"} vs ${root})`, proc);
}

/** The noted processes that still run with the start time noted; `by` limits it to those one process noted. */
export function leftoverOwned(root: string, by?: number, read: (pid: number) => string | undefined = startOf): number[] {
	let names: string[] = [];
	try {
		names = readdirSync(join(root, KILLS_DIR));
	} catch { /* none */ }
	return names.filter((name) => /^\d+$/.test(name)).map(Number).filter((pid) => {
		let owner: string | undefined, noted: string | undefined;
		try {
			[owner, noted] = readFileSync(join(root, KILLS_DIR, String(pid)), "utf8").split("\n");
		} catch {
			return false; // forgotten between the listing and the read (a child that shares the root)
		}
		return (by === undefined || Number(owner) === by) && Boolean(noted?.trim()) && read(pid) === noted!.trim();
	});
}

/** Kills what `leftoverOwned` lists (the group first: a detached one leads its own). The cleanup of a run, not the guarded path. */
export function reapOwned(root: string, by?: number, read?: (pid: number) => string | undefined): number[] {
	const found = leftoverOwned(root, by, read);
	for (const pid of found) for (const target of [-pid, pid]) {
		try { process.kill(target, "SIGKILL"); } catch { /* gone already, or not a group */ }
	}
	return found;
}
