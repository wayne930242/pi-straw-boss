import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PIDS_DIR, TEST_ROOT } from "../src/server/testguard.ts";
import { startOf } from "../src/startof.ts";

// A test process never touches the developer's machine (tests/setup.ts installs this before any module loads; a test file is a process of its own, so each has a root): HOME, USERPROFILE, the agent folder, and the temp folder point into a root made for the
// run (the temp folder too, so the folders a test makes go with it and a socket path in one stays short), nothing of the session the run was started from (its Herdr pane, its intercom identity, its subagent role) is inherited, and the Herdr socket is a path nobody listens on. The root is
// short on purpose (a unix socket path is limited to about 100 characters). The process that made the root removes it at exit; every process kills the servers it noted in `pids/` and, when
// one was still running, makes the run fail.

/** What a test must not inherit from the shell or the pi session that started it. */
export const INHERITED = /^(PI_(INTERCOM|SUBAGENT|HERDR_AGENTS)_.*|PI_SESSION_(FILE|ID)|STRAW_BOSS_.*|HERDR_.*|SB_TEST_REAL_SERVER)$/;

export interface Isolation { root: string; owner: boolean }

export function installIsolation(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Isolation {
	const given = env[TEST_ROOT];
	if (given && existsSync(given)) return { root: given, owner: false };
	// Read before HOME changes: a checkout and a Go toolchain that the account has and a test uses (link-relay-live.test.ts) stay where they are.
	const home = env.HOME ?? homedir(), relay = join(home, "projects", "straw-relay");
	if (!env.STRAW_RELAY_DIR && existsSync(join(relay, ".git"))) env.STRAW_RELAY_DIR = relay;
	if (!env.GOCACHE && !env.GOMODCACHE && !env.GOPATH) {
		const go = spawnSync("go", ["env", "GOCACHE", "GOMODCACHE", "GOPATH"], { encoding: "utf8", timeout: 10_000 });
		const [cache, mods, path] = go.status === 0 ? go.stdout.split("\n") : [];
		if (cache && mods && path) Object.assign(env, { GOCACHE: cache, GOMODCACHE: mods, GOPATH: path });
	}
	env.SB_TEST_REAL_HOME = home;
	const root = mkdtempSync(join(platform === "win32" ? tmpdir() : "/tmp", "sbt-")), fake = join(root, "h");
	for (const key of Object.keys(env)) if (INHERITED.test(key)) delete env[key];
	const agent = join(fake, ".pi", "agent");
	mkdirSync(agent, { recursive: true });
	Object.assign(env, {
		[TEST_ROOT]: root, HOME: fake, USERPROFILE: fake, PI_CODING_AGENT_DIR: agent, APPDATA: join(fake, "AppData", "Roaming"), LOCALAPPDATA: join(fake, "AppData", "Local"),
		XDG_CONFIG_HOME: join(fake, ".config"), XDG_DATA_HOME: join(fake, ".local", "share"), XDG_STATE_HOME: join(fake, ".local", "state"), HERDR_SOCKET_PATH: join(root, "herdr.sock"), TMPDIR: root, TEMP: root, TMP: root,
	});
	return { root, owner: true };
}

/** The environment for the go toolchain: the home the run started from, where go keeps its telemetry (a child of `go` outlives the command, and would write into the root after it is removed). */
export const goEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => (env.SB_TEST_REAL_HOME ? { ...env, HOME: env.SB_TEST_REAL_HOME, USERPROFILE: env.SB_TEST_REAL_HOME } : env);

/** Whether the process noted for `pid` still runs: the pid answers, it is one this account may signal (EPERM is another account's process), and its start time is the one noted when it is known. */
const alive = (pid: number, root: string) => {
	try {
		process.kill(pid, 0);
	} catch {
		return false;
	}
	try {
		const noted = readFileSync(join(root, PIDS_DIR, String(pid)), "utf8").split("\n")[1]?.trim();
		return !noted || startOf(pid) === noted;
	} catch {
		return false; // forgotten meanwhile: the process ended
	}
};
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The servers the run noted that still run; `by` limits it to those one process started. */
export function leftover(root: string, by?: number): number[] {
	const dir = join(root, PIDS_DIR);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => /^\d+$/.test(name) && (by === undefined || Number(readFileSync(join(dir, name), "utf8").split("\n")[0]) === by)).map(Number).filter((pid) => alive(pid, root));
}

/** Kills what `leftover` lists (its process group first: a detached server leads its own) and waits up to a second for it to go. Returns the pids that were running. */
export function reap(root: string, by?: number): number[] {
	const found = leftover(root, by);
	for (const pid of found) {
		for (const target of [-pid, pid]) {
			try { process.kill(target, "SIGKILL"); } catch { /* gone already, or not a group */ }
		}
	}
	for (let waited = 0; waited < 1000 && found.some((pid) => alive(pid, root)); waited += 20) pause(20);
	return found;
}

/** Ends the run's part in this process: kills its servers, fails the process when any still ran, and, in the process that made the root, removes it. */
export function finish({ root, owner }: Isolation): number[] {
	const left = reap(root, owner ? undefined : process.pid);
	if (left.length) {
		process.stderr.write(`test isolation: the run left sb server processes running (${left.join(", ")}); they were killed\n`);
		process.exitCode = 1;
	}
	if (owner) rmSync(root, { recursive: true, force: true });
	return left;
}

/** Installs the isolation and the exit check, once per process. */
export function setup(): Isolation {
	const isolation = installIsolation();
	process.once("exit", () => void finish(isolation));
	for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) process.once(signal, () => process.exit(code));
	return isolation;
}
