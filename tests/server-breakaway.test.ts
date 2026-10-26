import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { commandLine, LAUNCH_SCRIPT, launchCommand, type LaunchExec, parseLaunchOutput, spawnBreakaway, winQuote } from "../src/server/breakaway.ts";
import { detachWarning, describe, launch, makeCtx, type SpawnSpec, spawnDetached, ServerError } from "../src/server/client.ts";
import { run } from "../src/server/cli.ts";
import { fileOf, writeRecord } from "../src/server/record.ts";
import { ServerWorld, sleep, until } from "./server-world.ts";

// docs/specs/2026-10-26-sb-backend.md, Process model and lifecycle: the detached server on Windows starts outside the starter's job object (WMI Win32_Process.Create), because Node's
// `detached: true` does not break away from a kill-on-close job; elsewhere it starts in a session of its own. Windows is not run here: a fake for PowerShell pins the call and what is done with its answer.

let world: ServerWorld;
let dir: string;
beforeEach(() => {
	world = new ServerWorld();
	dir = mkdtempSync(join(tmpdir(), "psb-ba-"));
});
afterEach(async () => {
	await world.close();
	rmSync(dir, { recursive: true, force: true });
});

const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\pkg\\cli.mjs", "run", "--detached", "--by", 'session "main" (3f2a1b9c)'], env: { PATH: "C:\\bin", PI_INTERCOM_SCOPE_ID: "team-a", NODE_OPTIONS: "--use-system-ca", HOME: "C:\\Users\\許功", ANTHROPIC_API_KEY: "sk-secret" }, cwd: dir, options: { detached: true, stdio: "ignore", windowsHide: true }, ...over });

test("arguments are quoted as CommandLineToArgvW reads them back: spaces, quotes, and the backslashes before them", () => {
	assert.equal(winQuote("plain"), "plain");
	assert.equal(winQuote("C:\\Program Files\\node.exe"), '"C:\\Program Files\\node.exe"');
	assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
	assert.equal(winQuote("C:\\dir with space\\"), '"C:\\dir with space\\\\"');
	assert.equal(winQuote('a\\"b'), '"a\\\\\\"b"');
	assert.equal(winQuote(""), '""');
	assert.equal(commandLine(spec()), '"C:\\Program Files\\nodejs\\node.exe" C:\\pkg\\cli.mjs run --detached --by "session \\"main\\" (3f2a1b9c)" --detach wmi');
});

test("F003: the process gets the starter's whole environment through Win32_ProcessStartup.EnvironmentVariables, which replaces the default block, and no file holds it", () => {
	assert.match(LAUNCH_SCRIPT, /\$si\.EnvironmentVariables = \$vars/);
	assert.match(LAUNCH_SCRIPT, /GetEnvironmentVariables\('Process'\)/);
	assert.match(LAUNCH_SCRIPT, /\$k -notlike 'SB_LAUNCH_\*'/, "the call's own variables are not passed on");
	assert.ok(!/KEY|TOKEN|SECRET|PASSWORD|AUTH/.test(LAUNCH_SCRIPT), "no filter by name: GIT_AUTHOR_NAME and an API key reach the server like any other variable");
	// The PowerShell that makes the call runs with the starter's environment (plus the two it reads), so that is the block it copies.
	const { options } = launchCommand(spec(), { SystemRoot: "C:\\Windows" });
	assert.equal(options.env.NODE_OPTIONS, "--use-system-ca", "a variable node reads at start (NODE_OPTIONS) is in the block");
	assert.equal(options.env.PI_INTERCOM_SCOPE_ID, "team-a");
	assert.equal(options.env.ANTHROPIC_API_KEY, "sk-secret");
	assert.equal(options.env.SB_LAUNCH_CWD, dir);
	assert.match(options.env.SB_LAUNCH_CMD!, /--detach wmi$/);
	assert.ok(!/env-file/.test(LAUNCH_SCRIPT + options.env.SB_LAUNCH_CMD));
});

test("F002: the flags are the documented ones (DETACHED_PROCESS, new process group, unicode environment, breakaway); CREATE_NO_WINDOW is not set, the window is hidden by ShowWindow 0", () => {
	assert.match(LAUNCH_SCRIPT, /\$si\.ShowWindow = 0/);
	const first = /\$si\.CreateFlags = (\d+)\n/.exec(LAUNCH_SCRIPT);
	const second = /\$si\.CreateFlags = (\d+);/.exec(LAUNCH_SCRIPT);
	assert.equal(Number(first![1]), 0x8 | 0x200 | 0x400 | 0x01000000, "DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT | CREATE_BREAKAWAY_FROM_JOB");
	assert.equal(Number(second![1]), 0x8 | 0x200 | 0x400, "the second try, for a job that does not allow breakaway, drops only that flag");
	assert.equal(Number(first![1]) & 0x08000000, 0, "CREATE_NO_WINDOW is not in Microsoft's list of CreateFlags");
	assert.match(LAUNCH_SCRIPT, /\$wmi = \[wmiclass\]'Win32_Process'/);
	assert.match(LAUNCH_SCRIPT, /\$wmi\.Create\(\$env:SB_LAUNCH_CMD, \$env:SB_LAUNCH_CWD, \$si\)/);
	assert.ok(!/Start-Process|Invoke-Expression|node\.exe|straw-boss/i.test(LAUNCH_SCRIPT), "a Start-Process child would be in the starter's job; no path is quoted into the script");
	assert.match(LAUNCH_SCRIPT, /\$away = \$false/);
	assert.match(LAUNCH_SCRIPT, /ConvertTo-Json -Compress/);
});

test("the launch answer: the pid and whether the process is outside the job when WMI returned 0, an error with its code otherwise", () => {
	assert.deepEqual(parseLaunchOutput('{"rc":0,"pid":4321,"breakaway":true}\r\n'), { pid: 4321, breakaway: true });
	assert.deepEqual(parseLaunchOutput('{"rc":0,"pid":4321,"breakaway":false}'), { pid: 4321, breakaway: false });
	assert.throws(() => parseLaunchOutput('{"rc":21,"pid":0}'), /returned 21/);
	assert.throws(() => parseLaunchOutput("boom"), /answered boom/);
	assert.throws(() => parseLaunchOutput(""), /nothing/);
});

function fakePowershell(answer: string | (Error & { killed?: boolean; signal?: string | null })) {
	const seen: { file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string | undefined; timeout: number }[] = [];
	const exec: LaunchExec = (file, args, options, done) => {
		seen.push({ file, args, env: options.env, cwd: options.cwd, timeout: options.timeout });
		setImmediate(() => (typeof answer === "string" ? done(null, answer) : done(answer, "")));
	};
	return { seen, exec };
}
const noFallback = () => ({ exited: new Promise<number | null>(() => {}) });

test("a start runs one PowerShell by absolute path from System32 with the command line in its environment; the pid comes with its answer, and exited fires when it is gone", async () => {
	const ps = fakePowershell('{"rc":0,"pid":777,"breakaway":true}');
	let up = true;
	const launched = spawnBreakaway(spec(), { exec: ps.exec, alive: () => up, pollMs: 10, env: { SystemRoot: "C:\\Windows" }, fallback: noFallback });
	assert.equal(launched.pid, undefined, "the pid is not known when the call returns");
	const started = await launched.started!;
	assert.deepEqual([started.pid, started.via, started.failure, started.breakaway], [777, "wmi", undefined, true]);
	assert.equal(ps.seen.length, 1);
	assert.equal(ps.seen[0]!.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
	assert.equal(ps.seen[0]!.cwd, "C:\\Windows\\System32");
	assert.deepEqual(ps.seen[0]!.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
	assert.equal(Buffer.from(ps.seen[0]!.args[3]!, "base64").toString("utf16le"), LAUNCH_SCRIPT);
	let exited: unknown = "pending";
	void launched.exited.then((c) => (exited = c));
	await sleep(40);
	assert.equal(exited, "pending", "the process runs");
	up = false;
	await until(() => exited === null, "exited when the pid is gone");
});

test("release stops the watch of the pid", async () => {
	const ps = fakePowershell('{"rc":0,"pid":778,"breakaway":false}');
	let polls = 0;
	const launched = spawnBreakaway(spec(), { exec: ps.exec, alive: () => (polls++, true), pollMs: 10, fallback: noFallback });
	assert.equal((await launched.started!).breakaway, false, "a job that does not allow breakaway is told");
	await sleep(50);
	launched.release!();
	const after = polls;
	await sleep(60);
	assert.equal(polls, after);
});

test("F002: when PowerShell or WMI fails the start falls back to a plain spawn that is told to the server (--detach direct, with the reason), and `started` and the log say so", async () => {
	for (const answer of [Object.assign(new Error("powershell.exe ENOENT"), { killed: false, signal: null }), '{"rc":21,"pid":0}', "garbage"]) {
		const ps = fakePowershell(answer);
		const plain: SpawnSpec[] = [];
		const launched = spawnBreakaway(spec(), { exec: ps.exec, fallback: (s) => (plain.push(s), { pid: 99, exited: Promise.resolve(0) }) });
		const started = await launched.started!;
		assert.equal(started.via, "direct");
		assert.ok(started.failure, String(answer));
		assert.equal(plain.length, 1);
		assert.equal(plain[0]!.env.PI_INTERCOM_SCOPE_ID, "team-a");
		assert.deepEqual(plain[0]!.args.slice(-4, -2), ["--detach", "direct"]);
		assert.equal(plain[0]!.args.at(-1), started.failure!.slice(0, 200));
		assert.equal(await launched.exited, 0);
	}
});

test("F002: a PowerShell that does not answer in time is a failed start with no fallback (WMI may already have created the server), and the start goes on waiting for a hello", async () => {
	const ps = fakePowershell(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" }));
	let fell = false;
	const launched = spawnBreakaway(spec({ timeoutMs: 5000 }), { exec: ps.exec, fallback: () => ((fell = true), noFallback()) });
	const started = await launched.started!;
	assert.equal(started.via, "failed");
	assert.match(started.failure!, /did not answer within 5 s.*may still have started the server/);
	assert.equal(fell, false);
	assert.equal(ps.seen[0]!.timeout, 5000, "the PowerShell's timeout is the time the requester has left");
	let exited = "pending";
	void launched.exited.then(() => (exited = "gone"));
	await sleep(30);
	assert.equal(exited, "pending");
});

test("F002: a start that failed through WMI and then never answered names that in its error", async () => {
	const ctx = world.ctx({
		timers: { start: 300, exit: 100, supervisor: 50, touch: 30 },
		spawn: () => ({ pid: undefined, exited: new Promise(() => {}), started: Promise.resolve({ pid: 0, ms: 5, via: "failed" as const, failure: "PowerShell did not answer within 30 s" }) }),
	});
	await assert.rejects(launch(ctx), (e: unknown) => e instanceof ServerError && /did not answer hello/.test(e.message) && /start through WMI: PowerShell did not answer within 30 s/.test(e.message));
});

test("a requester on Windows spawns through the breakaway start, anywhere else through a plain detached spawn", () => {
	const plain = makeCtx({ slot: world.slot, version: "0.44.0", cli: "/c", by: "t", platform: "linux" }).spawn;
	assert.equal(plain, spawnDetached);
	assert.notEqual(makeCtx({ slot: world.slot, version: "0.44.0", cli: "/c", by: "t", platform: "win32" }).spawn, spawnDetached);
});

test("launch logs the late pid as the phase `breakaway` with how long it took and whether it is outside the job, tells a fallback, and lets the start's watch go when it is done", async () => {
	let released = 0;
	const inner = world.ctx();
	const ctx = world.ctx({
		spawn: (s) => {
			const real = inner.spawn(s);
			return { ...real, started: Promise.resolve({ pid: 4242, ms: 2750, via: "direct" as const, failure: "Win32_Process.Create returned 21 (pid 0)" }), release: () => void released++ };
		},
	});
	await launch(ctx);
	await until(() => readFileSync(fileOf(world.slot, "log"), "utf8").includes("breakaway-failed"), "the log lines");
	const log = readFileSync(fileOf(world.slot, "log"), "utf8");
	assert.match(log, /phase name=breakaway ms=2750 via=direct pid=4242/);
	assert.match(log, /breakaway-failed via=direct text="Win32_Process.Create returned 21 \(pid 0\)"/);
	assert.equal(released, 1);
});

// --- a start that fell back says so everywhere (F002) ---

test("F002: run --detached --detach direct records detach and its reason in server.json, which status, describe, the up warning, and the /boss server line all show; wmi records it without a warning", async () => {
	const d = await world.start({ detach: { via: "direct", failure: "Win32_Process.Create returned 21 (pid 0)" } });
	await d.handle.ready;
	const record = world.record()!;
	assert.equal(record.detach, "direct");
	assert.equal(record.detachFailure, "Win32_Process.Create returned 21 (pid 0)");
	assert.match(detachWarning(record)!, /without leaving its starter's job \(Win32_Process.Create returned 21 \(pid 0\)\).*ends with the pane or ssh session/);
	const status = await describe(world.ctx());
	assert.equal(status.detach, "direct");
	assert.equal(status.detachFailure, "Win32_Process.Create returned 21 (pid 0)");
	assert.match(String(status.warning), /without leaving its starter's job/);
	let out = "";
	const code = await run(["up"], { env: world.env, stateDir: world.stateDir, version: "0.44.0", cli: "/c", ctx: world.ctx(), herdrListens: async () => true, out: (t) => void (out += t), err: () => {} });
	assert.equal(code, 0);
	const warnings = (JSON.parse(out.trim().split("\n").at(-1)!) as { warnings: { code: string; text: string }[] }).warnings;
	assert.ok(warnings.some((w) => w.code === "breakaway_failed" && /without leaving its starter's job/.test(w.text)), JSON.stringify(warnings));
	await d.handle.shutdown(0);
	const w = await world.start({ detach: { via: "wmi" } });
	await w.handle.ready;
	assert.equal(world.record()?.detach, "wmi");
	assert.equal(detachWarning(world.record()), undefined);
	assert.equal((await describe(world.ctx())).warning, undefined);
});

test("F002: the run flags --detach and --detach-reason reach the server; anything but wmi or direct is a usage error", async () => {
	let seen = undefined as { detach?: { via: string; failure?: string } } | undefined;
	const got = () => seen;
	const server = async (options: object) => ((seen = options), { ready: Promise.resolve(true), done: Promise.resolve(0), endpoint: "", shutdown: async () => {} });
	const env: NodeJS.ProcessEnv = { HOME: world.env.HOME, PI_CODING_AGENT_DIR: world.env.PI_CODING_AGENT_DIR };
	const base = { env, stateDir: world.stateDir, version: "0.44.0", cli: "/c", server: server as never, signals: () => {}, err: () => {}, ctx: world.ctx() };
	assert.equal(await run(["run", "--detached", "--detach", "direct", "--detach-reason", "WMI said 21"], base), 0);
	assert.deepEqual(got()?.detach, { via: "direct", failure: "WMI said 21" });
	seen = undefined;
	assert.equal(await run(["run", "--detached", "--detach", "wmi"], base), 0);
	assert.deepEqual(got()?.detach, { via: "wmi" });
	seen = undefined;
	assert.equal(await run(["run", "--detached"], base), 0);
	assert.equal(got()?.detach, undefined);
	assert.equal(await run(["run", "--detached", "--detach", "bogus"], base), 2);
});

// POSIX: the server starts in a session of its own, so killing its starter's process group (a pane closing, an ssh session ending) does not take it down.
test("POSIX: a detached server survives its starter's process group being killed", { skip: process.platform === "win32" }, async () => {
	mkdirSync(dir, { recursive: true });
	const script = join(dir, "starter.mjs");
	const client = new URL("../src/server/client.ts", import.meta.url).href;
	writeFileSync(script, `import { spawnDetached, SPAWN_OPTIONS } from ${JSON.stringify(client)};
const child = spawnDetached({ command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], env: process.env, cwd: process.cwd(), options: SPAWN_OPTIONS });
process.stdout.write(child.pid + "\\n");
setInterval(() => {}, 1000);
`);
	// The starter leads a process group of its own, as a pane's shell does.
	const starter = spawn(process.execPath, ["--experimental-strip-types", script], { detached: true, stdio: ["ignore", "pipe", "inherit"] });
	let child = 0;
	try {
		child = await new Promise<number>((resolve, reject) => {
			starter.stdout.once("data", (d) => resolve(Number(String(d).trim())));
			starter.once("exit", () => reject(new Error("the starter exited first")));
		});
		assert.ok(child > 0);
		process.kill(-starter.pid!, "SIGKILL");
		await new Promise((resolve) => starter.once("exit", resolve));
		await sleep(300);
		assert.doesNotThrow(() => process.kill(child, 0), "the detached server is still running");
	} finally {
		if (child) try { process.kill(child, "SIGKILL"); } catch { /* gone */ }
		try { process.kill(-starter.pid!, "SIGKILL"); } catch { /* gone */ }
	}
});
