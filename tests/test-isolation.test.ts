import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnDetached } from "../src/server/client.ts";
import { consumeRefusals, guarded, guardHome, guardSpawn, inside, inTestRun, noteStarted, PIDS_DIR, stateDirFor, TEST_ROOT } from "../src/server/testguard.ts";
import { startOf } from "../src/startof.ts";
import { until, World } from "./fakes.ts";
import { goEnv, INHERITED, installIsolation, leftover, reap, unjudged } from "./isolation.ts";
import { ServerWorld } from "./server-world.ts";

// A run of the tests never touches the developer's machine (tests/isolation.ts, src/server/testguard.ts): the home, the agent folder, and the Herdr socket are the run's own, no sb server starts
// outside the run's root, and nothing the run starts is left running. The scenario at the end is the leak itself: a session of a test, with a screen and a real spawn, and a "real home" of its own.

const root = process.env[TEST_ROOT]!, outside = dirname(root); // a sibling of the root: the account's real home in these tests
const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const undo of cleanup.splice(0)) undo();
});
const isolate = (dir: string) => {
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

test("the run is isolated: home, the agent folder, and the Herdr socket are below the run's root, and nothing of the session that started the run is inherited", () => {
	assert.ok(root && existsSync(root), "tests/setup.ts made a root and named it in SB_TEST_ROOT");
	for (const [name, value] of Object.entries({ HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH, "os.homedir()": homedir() })) {
		assert.ok(value && inside(value, root), `${name} is ${value}, not below ${root}`);
	}
	assert.ok(inside(tmpdir(), root), "so is the temp folder");
	assert.ok(!existsSync(process.env.HERDR_SOCKET_PATH!), "nobody listens on the Herdr socket");
	assert.deepEqual(Object.keys(process.env).filter((key) => INHERITED.test(key) && key !== "HERDR_SOCKET_PATH"), [], "no pane, intercom identity, or subagent role of the starting session");
	assert.ok(inTestRun());
});

test("installIsolation makes the root, points the environment into it, and scrubs the inherited session; a second call in a process that inherited the root reuses it", () => {
	const env: NodeJS.ProcessEnv = { HOME: "/Users/someone", PI_INTERCOM_SESSION_ID: "x", PI_SUBAGENT_ID: "y", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/bin/herdr", STRAW_BOSS_ROLE: "tower", PATH: "/usr/bin", GOCACHE: "/c", STRAW_RELAY_DIR: "/r" };
	const made = installIsolation(env);
	cleanup.push(() => rmSync(made.root, { recursive: true, force: true }));
	assert.ok(made.owner);
	assert.equal(env[TEST_ROOT], made.root);
	assert.ok(made.root.length < 24, `a short root keeps socket paths under the limit: ${made.root}`);
	for (const key of ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "APPDATA", "XDG_CONFIG_HOME", "HERDR_SOCKET_PATH", "TMPDIR"]) assert.ok(inside(env[key]!, made.root), key);
	for (const key of ["PI_INTERCOM_SESSION_ID", "PI_SUBAGENT_ID", "HERDR_PANE_ID", "HERDR_BIN_PATH", "STRAW_BOSS_ROLE"]) assert.equal(env[key], undefined, key);
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.STRAW_RELAY_DIR, "/r", "a checkout the account named is kept");
	assert.deepEqual(installIsolation(env), { root: made.root, owner: false });
});

test("the guard refuses a server whose folders are outside the run's root, one that would use the account's home, and a run that has no root; a real spawn needs SB_TEST_REAL_SERVER=1", () => {
	const proc = { [TEST_ROOT]: root }, real = { ...proc, SB_TEST_REAL_SERVER: "1" };
	const inRoot = join(root, "h", ".pi", "agent"), spec = { cwd: join(inRoot, "straw-boss"), env: { PI_CODING_AGENT_DIR: inRoot } };
	guardHome(spec, proc);
	guardSpawn(spec, real);
	assert.throws(() => guardSpawn(spec, proc), /through the sb server's spawn/);
	assert.throws(() => guardSpawn({ ...spec, cwd: join(outside, "elsewhere") }, real), /working folder .* outside the run's temp root/);
	assert.throws(() => guardHome({ ...spec, env: { PI_CODING_AGENT_DIR: join(outside, "somebody", ".pi", "agent") } }, proc), /state folder .* outside/);
	// An environment with no home: the server would get the account's.
	assert.equal(stateDirFor({}, "linux"), join(userInfo().homedir, ".pi", "agent", "straw-boss"));
	assert.throws(() => guardHome({ ...spec, env: {} }, proc), /state folder .* outside/);
	assert.throws(() => guardHome(spec, {}, ["node", "tests/x.test.ts"]), /without tests\/setup\.ts/);
	// R-F001: a pi (or `cli.mjs`) started below a `node --test` process inherits NODE_TEST_CONTEXT, and is no test run.
	assert.ok(!inTestRun({ NODE_TEST_CONTEXT: "child-v8" }, ["node", "/opt/pi/cli.js"]));
	guardHome({ cwd: "/anywhere", env: {} }, { NODE_TEST_CONTEXT: "child-v8" }, ["node", "/opt/pi/cli.js"]);
	guardSpawn({ cwd: "/anywhere", env: {} }, { NODE_TEST_CONTEXT: "child-v8" }, ["node", "/opt/pi/cli.js"]);
	// Not a test run: nothing is checked.
	guardSpawn({ cwd: "/anywhere", env: {} }, {}, ["node", "/usr/bin/cli.mjs"]);
	assert.ok(inTestRun({}, ["node", "tests/x.test.ts"]), "a test file run by hand counts");
	assert.ok(!inTestRun({}, ["node", "cli.mjs"]));
	assert.equal(consumeRefusals().length, 4, "each refusal above was recorded, and this test, which asserted them, took them");
});

test("a server a test run starts is noted by pid, and reap kills what still runs and says which", async () => {
	const dir = isolate(mkdtempSync(join(tmpdir(), "psb-iso-")));
	const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	child.unref();
	cleanup.push(() => void child.kill("SIGKILL"));
	noteStarted(child.pid, {}, ["node", "cli.mjs"]);
	assert.ok(!existsSync(join(dir, PIDS_DIR)), "no root: nothing is written");
	noteStarted(child.pid, { [TEST_ROOT]: dir });
	assert.deepEqual(leftover(dir), [child.pid]);
	assert.deepEqual(leftover(dir, process.pid + 1), [], "limited to those one process started");
	assert.deepEqual(leftover(dir, process.pid), [child.pid]);
	assert.deepEqual(reap(dir), [child.pid]);
	await until(() => leftover(dir).length === 0, "the process to be gone");
	assert.deepEqual(reap(dir), []);
});

test("RC2-F005: on Windows a timed note is never judged against the cached start time: the pid a server left may be another process's, so reap kills nothing on a timed note there", () => {
	const dir = isolate(mkdtempSync(join(tmpdir(), "psb-iso-")));
	const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	child.unref();
	cleanup.push(() => void child.kill("SIGKILL"));
	const time = startOf(child.pid!);
	assert.ok(time, "the start time is known (ps) and cached");
	noteStarted(child.pid, { [TEST_ROOT]: dir }, ["node", "x.test.ts"], () => time);
	assert.deepEqual(leftover(dir, undefined, "win32"), [], "the cache would have said the same process");
	assert.deepEqual(reap(dir, undefined, "win32"), []);
	assert.deepEqual(unjudged(dir, undefined, "win32"), [child.pid], "RC3-F005: reported, not killed");
	assert.deepEqual(unjudged(dir, undefined, "darwin"), [], "only Windows cannot judge it");
	process.kill(child.pid!, 0);
	assert.deepEqual(reap(dir, undefined, "darwin"), [child.pid], "elsewhere the start time is read at once and matches");
});

/** A launch as the Windows breakaway gives it: no pid at first, `started` answering with the pid (and the server's own start time, when WMI told it), `release` called when the start no longer needs it. */
const breakaway = (child: { pid?: number }, told: { serverStarted?: string }) => {
	let released = 0;
	const launch = () => ({ exited: new Promise<number | null>(() => {}), started: Promise.resolve({ pid: child.pid!, ...told }), release: () => void released++ });
	return { launch, released: () => released };
};

test("SBIR-F002: a server started through WMI is noted with the start time WMI told, and a note with no start time to check goes when the start lets go of it", async () => {
	const dir = isolate(mkdtempSync(join(tmpdir(), "psb-iso-")));
	const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	child.unref();
	cleanup.push(() => void child.kill("SIGKILL"));
	const proc = { [TEST_ROOT]: dir, SB_TEST_REAL_SERVER: "1" }, spec = { cwd: join(dir, "h"), env: { PI_CODING_AGENT_DIR: join(dir, "h", ".pi", "agent") } };
	// The time WMI told is the one noted: a pid that has another start time now is another process's, and is left alone.
	const told = breakaway(child, { serverStarted: "a time this pid has not got" });
	const launched = guarded(told.launch, { proc, argv: ["node", "cli.mjs"] })(spec);
	await launched.started;
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(readFileSync(join(dir, PIDS_DIR, String(child.pid)), "utf8").split("\n")[1], "a time this pid has not got");
	assert.deepEqual(leftover(dir), [], "the pid's process started at another time than the one noted");
	launched.release?.();
	assert.equal(told.released(), 1, "release still reaches the launch");
	// With the time of the process itself, the note stands after release and the server is still seen.
	const own = breakaway(child, { serverStarted: startOf(child.pid!)! });
	const kept = guarded(own.launch, { proc, argv: ["node", "cli.mjs"] })(spec);
	await kept.started;
	await new Promise((resolve) => setImmediate(resolve));
	kept.release?.();
	assert.deepEqual(leftover(dir), [child.pid]);
	// No time told and none to read (Windows, a cold cache): nothing can tell the process from another that takes the pid, so release forgets the note.
	rmSync(join(dir, PIDS_DIR), { recursive: true, force: true });
	const unknown = breakaway(child, {});
	const blind = guarded(unknown.launch, { proc, argv: ["node", "cli.mjs"], startOf: () => undefined })(spec);
	await blind.started;
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(existsSync(join(dir, PIDS_DIR, String(child.pid))), "noted while the start runs");
	blind.release?.();
	assert.ok(!existsSync(join(dir, PIDS_DIR, String(child.pid))), "forgotten at release: no pid is killed on a guess");
});

test("a pid that is no process's (0, a failed start) is never noted: reaping it would signal this process's own group", () => {
	const dir = isolate(mkdtempSync(join(tmpdir(), "psb-iso-")));
	noteStarted(0, { [TEST_ROOT]: dir });
	assert.ok(!existsSync(join(dir, PIDS_DIR, "0")));
});

test("a process that leaves a noted server running fails when it ends, and the server is killed", () => {
	const source = fileURLToPath(new URL("./isolation.ts", import.meta.url));
	const script = `
		import { spawn } from "node:child_process";
		import { noteStarted } from ${JSON.stringify(fileURLToPath(new URL("../src/server/testguard.ts", import.meta.url)))};
		import { setup } from ${JSON.stringify(source)};
		setup();
		const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
		child.unref();
		noteStarted(child.pid);
		console.log(child.pid);`;
	const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: process.env });
	const pid = Number(ran.stdout.trim());
	assert.ok(pid > 1, ran.stderr);
	assert.equal(ran.status, 1, "the run fails");
	assert.match(ran.stderr, /left sb server processes running/);
	assert.throws(() => process.kill(pid, 0), "the server is gone");
});

test("the test script and the one-file script load the isolation, and AGENTS.md says so", () => {
	const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
	assert.match(manifest.scripts.test!, /^node --import \.\/tests\/setup\.ts --test /);
	assert.match(manifest.scripts["test:one"]!, /^node --import \.\/tests\/setup\.ts --test$/);
	assert.match(readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8"), /npm run test:one/);
});

// The leak: a session with a screen and the real spawn (no `ctx` given), whose environment names a home of its own: the "account's real home" of this scenario. Before the guard, the look started
// a detached server there (server.json and server.log appear in it); now the look is refused, says so once, and nothing is written or noted.
test("a session's look in a test run starts no server in a real home, whatever environment the session gives", async () => {
	const realHome = isolate(mkdtempSync(join(outside, "psb-realhome-")));
	const agentDir = join(realHome, ".pi", "agent"), stateDir = join(agentDir, "straw-boss");
	mkdirSync(stateDir, { recursive: true });
	cleanup.push(() => {
		const pid = (() => {
			try { return (JSON.parse(readFileSync(join(stateDir, "server.json"), "utf8")) as { pid: number }).pid; } catch { return undefined; }
		})();
		if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
	});
	const world = new World(), looks: Promise<unknown>[] = [];
	const a = world.agent({ id: "tower-wA", pane: "wA:p1", tab: "wA:t1", ui: true, env: { HOME: realHome, PI_CODING_AGENT_DIR: agentDir }, deps: { stateDir, adoptMs: 20, server: { track: (done) => void looks.push(done) } } });
	await a.start();
	try {
		await until(() => a.notices.some((n) => /sb server (could not start|was not looked at)/.test(n.text)), "the look to be refused");
		assert.match(a.notices.find((n) => /could not start|was not looked at/.test(n.text))!.text, /outside the run's temp root/);
		await Promise.allSettled(looks);
		assert.deepEqual([existsSync(join(stateDir, "server.json")), existsSync(join(stateDir, "server.log")), existsSync(join(stateDir, "server.lock"))], [false, false, false], "nothing was written in the real home");
		assert.deepEqual(leftover(root), []);
		assert.ok(consumeRefusals().length >= 1, "the refusal was recorded; this test asserted it");
	} finally {
		await world.stopAll();
		await Promise.allSettled(looks);
	}
});

// The same session inside the run's root (the temp folders of ServerWorld and the sessions' state folders are there): the folders are allowed, but a real detached start still needs the opt-in, so a
// test that forgot to give its session a fake spawn fails at once and says so, instead of leaving a server behind.
test("a session's look inside the root with the real spawn is refused too: a test must give it the fake spawn", async () => {
	const world = new World(), looks: Promise<unknown>[] = [];
	const a = world.agent({ id: "tower-wA", pane: "wA:p1", tab: "wA:t1", ui: true, env: { HOME: process.env.HOME!, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR! }, deps: { adoptMs: 20, server: { track: (done) => void looks.push(done) } } });
	await a.start();
	try {
		await until(() => a.notices.some((n) => /sb server (could not start|was not looked at)/.test(n.text)), "the look to be refused");
		assert.match(a.notices.find((n) => /could not start|was not looked at/.test(n.text))!.text, /real detached process .* fake spawn/);
		await Promise.allSettled(looks);
		assert.deepEqual(leftover(root), []);
		assert.ok(consumeRefusals().length >= 1, "the refusal was recorded; this test asserted it");
	} finally {
		await world.stopAll();
		await Promise.allSettled(looks);
	}
});

// R-F003: the pid list names a process by its start time too, and a process that ended is not listed.
test("a noted pid is killed only while it is the process that was noted: its start time must match, a pid that ended is forgotten, and EPERM is not alive", async () => {
	const dir = isolate(mkdtempSync(join(tmpdir(), "psb-iso-")));
	const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	child.unref();
	cleanup.push(() => void child.kill("SIGKILL"));
	noteStarted(child.pid, { [TEST_ROOT]: dir });
	const [by, start] = readFileSync(join(dir, PIDS_DIR, String(child.pid)), "utf8").split("\n");
	assert.equal(by, String(process.pid));
	assert.equal(start, startOf(child.pid!), "the start time is stored with the pid");
	// The pid now belongs to another process (reused): same number, other start time.
	writeFileSync(join(dir, PIDS_DIR, String(child.pid)), `${process.pid}\nsome other start\n`);
	assert.deepEqual(leftover(dir), [], "not the noted process");
	assert.deepEqual(reap(dir), []);
	process.kill(child.pid!, 0); // and it was not killed
	// pid 1 answers EPERM to a user process: another account's process is not a server this run started.
	if (process.getuid?.() !== 0) {
		writeFileSync(join(dir, PIDS_DIR, "1"), `${process.pid}\n\n`);
		assert.deepEqual(leftover(dir).filter((pid) => pid === 1), []);
	}
});

test("the real spawn forgets a pid when its process ends, so a reused pid is never killed", async () => {
	const dir = isolate(mkdtempSync(join(tmpdir(), "psb-iso-")));
	const env = process.env, before = { real: env.SB_TEST_REAL_SERVER };
	env.SB_TEST_REAL_SERVER = "1";
	cleanup.push(() => (before.real === undefined ? delete env.SB_TEST_REAL_SERVER : (env.SB_TEST_REAL_SERVER = before.real)));
	const launched = spawnDetached({ command: process.execPath, args: ["-e", "0"], options: { stdio: "ignore" }, env: { ...env, HOME: join(root, "h"), PI_CODING_AGENT_DIR: join(root, "h", ".pi", "agent") }, cwd: join(root, "h") } as never);
	assert.ok(existsSync(join(root, PIDS_DIR, String(launched.pid))), "noted at the start");
	await launched.exited;
	await until(() => !existsSync(join(root, PIDS_DIR, String(launched.pid))), "the entry to go with the process");
	assert.deepEqual(leftover(root), []);
});

test("the go toolchain is run with the home the run started from, and the inherited-variable scrub clears SB_TEST_REAL_SERVER", () => {
	const env: NodeJS.ProcessEnv = { HOME: "/Users/someone", PATH: "/usr/bin", SB_TEST_REAL_SERVER: "1", APPDATA: "/real/appdata", LOCALAPPDATA: "/real/local", XDG_CONFIG_HOME: "/real/config" };
	const made = installIsolation(env);
	cleanup.push(() => rmSync(made.root, { recursive: true, force: true }));
	assert.equal(env.SB_TEST_REAL_SERVER, undefined, "a shell that exported it does not open every real spawn");
	assert.notEqual(env.HOME, "/Users/someone");
	assert.equal(goEnv(env).HOME, "/Users/someone", "go writes its telemetry where it always did, not into the root that is removed at the end");
	assert.equal(goEnv(env).PATH, "/usr/bin");
	assert.deepEqual([goEnv(env).APPDATA, goEnv(env).LOCALAPPDATA, goEnv(env).XDG_CONFIG_HOME], ["/real/appdata", "/real/local", "/real/config"], "go's build cache and telemetry folders are the real ones");
	assert.equal(goEnv(env).XDG_CACHE_HOME, undefined, "one the shell never set is not set for go either");
	assert.ok(inside(env.APPDATA!, made.root) && inside(env.XDG_CACHE_HOME!, made.root), "the process's own stay in the root");
	assert.ok(INHERITED.test("SB_TEST_REAL_SERVER"));
});

test("SBIR-F002: installIsolation starts no process: every test process runs it before its first test, and a synchronous `go env` in each held the machine (100 ms to 1.6 s on a loaded one, 150 times in a full run)", () => {
	const bin = isolate(mkdtempSync(join(tmpdir(), "psb-iso-"))), asked = join(bin, "asked");
	writeFileSync(join(bin, "go"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(asked)}\n`, { mode: 0o755 });
	const real = process.env.PATH;
	process.env.PATH = `${bin}:${real}`;
	cleanup.push(() => void (process.env.PATH = real));
	const env: NodeJS.ProcessEnv = { HOME: "/Users/someone", PATH: process.env.PATH };
	const made = installIsolation(env);
	cleanup.push(() => rmSync(made.root, { recursive: true, force: true }));
	assert.ok(!existsSync(asked), "go was not run");
	assert.equal(env.GOCACHE, undefined);
	assert.equal(goEnv(env).HOME, "/Users/someone", "go still finds its own caches and telemetry under the home the run started from");
});

test("ServerWorld.server() gives a session the world's requester when no context is given", async () => {
	const sw = new ServerWorld();
	try {
		const deps = sw.server() as { ctx: { spawn?: unknown } };
		assert.equal(typeof deps.ctx.spawn, "function", "the world's fake spawn, not the real one the guard refuses");
	} finally {
		await sw.close();
	}
});

// A refusal of the guard inside a test process fails the run, unless the test asserted it on purpose and took the record: a session that is refused by accident otherwise "passes" with a notice nobody reads.
test("a guard refusal a test did not take fails its process when it ends; one it took (consumeRefusals) does not", () => {
	const script = (take: boolean) => `
		import { guardSpawn, consumeRefusals } from ${JSON.stringify(fileURLToPath(new URL("../src/server/testguard.ts", import.meta.url)))};
		import { setup } from ${JSON.stringify(fileURLToPath(new URL("./isolation.ts", import.meta.url)))};
		setup();
		try { guardSpawn({ cwd: "/elsewhere", env: {} }); } catch { /* refused */ }
		${take ? "console.log(consumeRefusals().length);" : ""}`;
	const run = (take: boolean) => spawnSync(process.execPath, ["--input-type=module", "-e", script(take)], { encoding: "utf8", env: { ...process.env, SB_TEST_ROOT: "" } });
	const forgotten = run(false);
	assert.equal(forgotten.status, 1, forgotten.stderr);
	assert.match(forgotten.stderr, /guard refused 1 .*outside the run's temp root/s);
	const taken = run(true);
	assert.equal(taken.status, 0, taken.stderr);
	assert.equal(taken.stdout.trim(), "1");
});
