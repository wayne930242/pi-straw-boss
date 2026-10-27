import { mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { startOf } from "../startof.ts";

// The one place a test run is kept off the developer's machine: a run of the tests starts no sb server in a folder outside the run's own temp root. tests/setup.ts makes the root, points
// HOME and the agent folder into it, and names it in SB_TEST_ROOT; the spawn that starts a detached server (client.ts `makeCtx`) asks here first and records the pid it got, so the
// run can see afterwards that nothing it started still runs. Outside a test run (no runner, no marker) every function here does nothing.

export const TEST_ROOT = "SB_TEST_ROOT";
export const PIDS_DIR = "pids";
export const REFUSALS_DIR = "refusals";

/**
 * Whether this process is part of a test run: under tests/setup.ts (it names the root) or running a `*.test.ts` file. `NODE_TEST_CONTEXT` is not a sign: `node --test` passes it to everything a test
 * starts, so a pi or `cli.mjs` below a test run would be refused as one.
 */
export const inTestRun = (env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv) => Boolean(env[TEST_ROOT] || /\.test\.[cm]?[jt]s$/.test(argv[1] ?? ""));

/** The state folder a server started with `env` writes to: its own `stateDirOf`, with the home it would get (the account's, when the environment names none). */
export function stateDirFor(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
	const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || userInfo().homedir;
	return join(env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent"), "straw-boss");
}

const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};
/** Whether `dir` is `root` or below it (a link in either is followed, so /tmp and /private/tmp agree). */
export function inside(dir: string, root: string): boolean {
	return [resolve(dir), real(dir)].some((d) => [resolve(root), real(root)].some((r) => {
		const rel = relative(r, d);
		return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
	}));
}

let refused = 0;
/** A refusal of the guard: recorded under the run's root (the process fails when it ends unless a test asserted it and took the record, `consumeRefusals`), then thrown. */
function refuse(message: string, proc: NodeJS.ProcessEnv): never {
	if (proc[TEST_ROOT]) {
		mkdirSync(join(proc[TEST_ROOT], REFUSALS_DIR), { recursive: true });
		writeFileSync(join(proc[TEST_ROOT], REFUSALS_DIR, `${process.pid}-${refused++}`), message);
	}
	throw new Error(message);
}
/** The refusals this process recorded (those of any process with `by` undefined), with their records removed: a test that asserts a refusal on purpose takes it. */
export function consumeRefusals(root = process.env[TEST_ROOT], by: number | undefined = process.pid): string[] {
	if (!root) return [];
	const dir = join(root, REFUSALS_DIR), taken: string[] = [];
	try {
		for (const name of readdirSync(dir)) {
			if (by !== undefined && !name.startsWith(`${by}-`)) continue;
			taken.push(readFileSync(join(dir, name), "utf8"));
			rmSync(join(dir, name), { force: true });
		}
	} catch { /* no refusals */ }
	return taken;
}

/** Throws when a test run would work in a folder outside the run's temp root (a session whose real spawn would put a server's lock, record, and log there), or when the run has no root. */
export function guardHome({ cwd, env }: { cwd: string; env: NodeJS.ProcessEnv }, proc: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): void {
	if (!inTestRun(proc, argv)) return;
	const root = proc[TEST_ROOT];
	if (!root) return refuse("a test run started without tests/setup.ts would start a real sb server in the account's real state folder: run the tests with `npm test` or `npm run test:one -- <file>`", proc);
	for (const [what, dir] of [["working folder", cwd], ["state folder", stateDirFor(env)]] as const) {
		if (!inside(dir, root)) refuse(`a test run would start an sb server with its ${what} at ${dir}, outside the run's temp root ${root}: give the session an environment with HOME and PI_CODING_AGENT_DIR below the root`, proc);
	}
}

/** Throws unless the test run said it really starts servers (SB_TEST_REAL_SERVER=1): a test gives the session the fake spawn of tests/server-world.ts, and what it really starts is noted by pid. */
export function guardSpawn(spec: { cwd: string; env: NodeJS.ProcessEnv }, proc: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): void {
	guardHome(spec, proc, argv);
	if (inTestRun(proc, argv) && proc.SB_TEST_REAL_SERVER !== "1") refuse("a test run started a real detached process through the sb server's spawn: give the session a context with the fake spawn (sw.ctx() in tests/server-world.ts), or set SB_TEST_REAL_SERVER=1 in a test that starts a real one on purpose", proc);
}

/**
 * Records the pid of a server a test run started, for the check at the end of the run that nothing it started remains. The file holds the pid of the process that started it and, on the next line,
 * the start time of the server (empty when it is not known yet): the check kills a pid only while it is still that process. `read` tells the start time (the process's own by default); it returns
 * what was noted, undefined when nothing is known. A pid that is no process's (0: a start that failed) is never noted: reaping it would signal this process's own group.
 */
export function noteStarted(pid: number | undefined, proc: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv, read: (pid: number) => string | undefined = startOf): string | undefined {
	if (pid === undefined || pid <= 0 || !inTestRun(proc, argv) || !proc[TEST_ROOT]) return undefined;
	const time = read(pid);
	mkdirSync(join(proc[TEST_ROOT], PIDS_DIR), { recursive: true });
	writeFileSync(join(proc[TEST_ROOT], PIDS_DIR, String(pid)), `${process.pid}\n${time ?? ""}\n`);
	return time;
}

/** Drops the note of a server that has ended: its pid may be another process's by the end of the run. */
export function forgetStarted(pid: number | undefined, proc: NodeJS.ProcessEnv = process.env): void {
	if (pid !== undefined && proc[TEST_ROOT]) rmSync(join(proc[TEST_ROOT], PIDS_DIR, String(pid)), { force: true });
}

/**
 * A spawn that is checked before it starts and noted after, also when the pid is told late (Windows: through WMI, whose answer carries the server's own start time, `serverStarted`, which is what
 * is noted: a read of the pid's start time is a PowerShell start that has not answered yet). A launch that is let go (`release`: the start no longer needs it, and its watch for the exit stops, so
 * `exited` never comes) leaves the note only when it has a start time to check against; one without could be another process's by the end of the run, and is forgotten.
 */
export const guarded = <S extends { cwd: string; env: NodeJS.ProcessEnv }, L extends { pid?: number; exited: Promise<unknown>; started?: Promise<{ pid: number; serverStarted?: string }>; release?(): void }>(base: (spec: S) => L, { proc = process.env, argv = process.argv, startOf: read = startOf }: { proc?: NodeJS.ProcessEnv; argv?: string[]; startOf?: (pid: number) => string | undefined } = {}) => (spec: S): L => {
	guardSpawn(spec, proc, argv);
	const launched = base(spec);
	let unchecked: number | undefined;
	const note = (pid: number | undefined, told?: string) => {
		const time = noteStarted(pid, proc, argv, (p) => told ?? read(p));
		unchecked = time === undefined ? pid : unchecked === pid ? undefined : unchecked;
		void launched.exited.then(() => forgetStarted(pid, proc));
	};
	note(launched.pid);
	void launched.started?.then((started) => note(started.pid, started.serverStarted), () => {});
	return { ...launched, release: () => (launched.release?.(), unchecked === undefined ? undefined : forgetStarted(unchecked, proc)) };
};
