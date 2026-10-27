import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BEFORE_CREATE, commandLine, LAUNCH_SCRIPT, launchCommand, type LaunchExec, parseLaunchOutput, spawnBreakaway, winQuote } from "../src/server/breakaway.ts";
import { detachWarning, describe, launch, makeCtx, ServerError, type SpawnSpec, spawnDetached, type Started } from "../src/server/client.ts";
import { run } from "../src/server/cli.ts";
import { fileOf, readStartError, writeRecord } from "../src/server/record.ts";
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
	assert.deepEqual(ps.seen[0]!.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand"]);
	assert.equal(Buffer.from(ps.seen[0]!.args[5]!, "base64").toString("utf16le"), LAUNCH_SCRIPT);
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
	for (const answer of [Object.assign(new Error("spawn powershell.exe ENOENT"), { code: "ENOENT", killed: false, signal: null }), '{"rc":21,"pid":0}']) {
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

test("N3: a failing PowerShell is told by its own words and exit code, not by Node's message that starts with the command line and its base64", async () => {
	const b64 = "A".repeat(2400);
	const failing = Object.assign(new Error(`Command failed: C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile -NonInteractive -EncodedCommand ${b64}\nCannot invoke method.`), { code: 1, killed: false, signal: null });
	// The script caught the failure before anything was created and said so: that reason is the one that is recorded, and the plain spawn is told it.
	const before: LaunchExec = (_f, _a, _o, done) => setImmediate(() => done(failing, '{"rc":-1,"pid":0,"markerError":"Cannot index into a null array."}\r\n', "At line:1 char:1\r\n+ [wmiclass]'Win32_Process'\r\n"));
	const plain: SpawnSpec[] = [];
	const launched = spawnBreakaway(spec(), { exec: before, fallback: (s) => (plain.push(s), { pid: 9, exited: Promise.resolve(0) }) });
	const { failure, via } = await launched.started!;
	assert.equal(via, "direct");
	assert.equal(failure, "the launch script failed before WMI made the process: Cannot index into a null array.");
	assert.ok(!failure!.includes("AAAA") && !/Command failed/.test(failure!));
	assert.equal(plain[0]!.args.at(-1), failure, "the reason that is recorded is that line");
	// No answer at all: PowerShell's message line (not its error id) and the exit code, in a failed start with no second server.
	const none: LaunchExec = (_f, _a, _o, done) => setImmediate(() => done(failing, `${BEFORE_CREATE}\r\n`, "Cannot index into a null array.\r\nAt line:1 char:1\r\n+ [wmiclass]'Win32_Process'\r\n    + FullyQualifiedErrorId : CannotCreateTypeConstrainedLanguage\r\n"));
	const second: SpawnSpec[] = [];
	const silent = await spawnBreakaway(spec(), { exec: none, fallback: (s) => (second.push(s), { pid: 9, exited: Promise.resolve(0) }) }).started!;
	assert.equal(silent.via, "failed");
	assert.match(silent.failure!, /^PowerShell gave no usable answer \(Cannot index into a null array\., exit code 1\) \(Win32_Process\.Create may still have started the server\)$/);
	assert.ok(!silent.failure!.includes("AAAA"));
	assert.equal(second.length, 0);
});

test("N4: the second try without breakaway has its own command line, --detach wmi-in-job, so the server records that it is in the WMI provider's job", () => {
	assert.match(LAUNCH_SCRIPT, /\$wmi\.Create\(\$env:SB_LAUNCH_CMD, \$env:SB_LAUNCH_CWD, \$si\)/);
	assert.match(LAUNCH_SCRIPT, /-not \$created\) \{ \$si\.CreateFlags = \d+; \$r = \$wmi\.Create\(\$env:SB_LAUNCH_CMD_INJOB, \$env:SB_LAUNCH_CWD, \$si\)/);
	const { options } = launchCommand(spec(), { SystemRoot: "C:\\Windows" });
	assert.match(options.env.SB_LAUNCH_CMD!, /--detach wmi$/);
	assert.match(options.env.SB_LAUNCH_CMD_INJOB!, /--detach wmi-in-job$/);
	assert.equal(options.env.SB_LAUNCH_CMD!.replace(/ --detach wmi$/, ""), options.env.SB_LAUNCH_CMD_INJOB!.replace(/ --detach wmi-in-job$/, ""));
	assert.ok(!Object.keys(options.env).some((k) => k !== "SB_LAUNCH_CMD" && k.startsWith("SB_LAUNCH_CMD") && k !== "SB_LAUNCH_CMD_INJOB"));
});

test("N4: wmi-in-job is recorded and warned about everywhere a direct fallback is: status, describe, the up warning, and the /boss server line", async () => {
	const d = await world.start({ detach: { via: "wmi-in-job" } });
	await d.handle.ready;
	assert.equal(world.record()?.detach, "wmi-in-job");
	const text = detachWarning(world.record())!;
	assert.match(text, /through WMI, but the job it is in did not allow it to break away/);
	const status = await describe(world.ctx());
	assert.equal(status.detach, "wmi-in-job");
	assert.equal(status.warning, text);
	let out = "";
	assert.equal(await run(["up"], { env: world.env, stateDir: world.stateDir, version: "0.44.0", cli: "/c", ctx: world.ctx(), herdrListens: async () => true, out: (t) => void (out += t), err: () => {} }), 0);
	const warnings = (JSON.parse(out.trim().split("\n").at(-1)!) as { warnings: { code: string }[] }).warnings;
	assert.ok(warnings.some((w) => w.code === "breakaway_failed"));
	let seen = undefined as { detach?: { via: string } } | undefined;
	const got = () => seen;
	const server = async (options: object) => ((seen = options), { ready: Promise.resolve(true), done: Promise.resolve(0), endpoint: "", shutdown: async () => {} });
	await d.handle.shutdown(0);
	const env: NodeJS.ProcessEnv = { HOME: world.env.HOME, PI_CODING_AGENT_DIR: world.env.PI_CODING_AGENT_DIR };
	assert.equal(await run(["run", "--detached", "--detach", "wmi-in-job"], { env, stateDir: world.stateDir, version: "0.44.0", cli: "/c", server: server as never, signals: () => {}, err: () => {}, ctx: world.ctx() }), 0);
	assert.equal(got()?.detach?.via, "wmi-in-job");
});

test("cosmetic: a PowerShell timeout that comes with the end of the wait still names the WMI start in the error (the `started` word arrives just after the wait ends)", async () => {
	const ctx = world.ctx({
		timers: { start: 200, exit: 100, supervisor: 50, touch: 30 },
		spawn: () => ({ pid: undefined, exited: new Promise(() => {}), started: new Promise<Started>((resolve) => setTimeout(() => resolve({ pid: 0, ms: 200, via: "failed", failure: "PowerShell did not answer within 0 s (Win32_Process.Create may still have started the server)" }), 230)) }),
	});
	await assert.rejects(launch(ctx), (e: unknown) => e instanceof ServerError && /start through WMI: PowerShell did not answer.*may still have started the server/.test(e.message));
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

// --- one PowerShell start for the create and the ACL check (VM pass 3, P3) ---

const TOKEN = "c".repeat(32);
const withAcl = (over: Partial<SpawnSpec> = {}) => spec({ acl: { dir: dir, token: TOKEN }, ...over });

test("with an ACL check to make, the command line carries the token, the call's environment carries the folder and the marker, and the server never sees them", () => {
	const s = withAcl();
	assert.ok(commandLine(s).endsWith(` --detach wmi --acl-token ${TOKEN}`));
	assert.ok(commandLine(s, "wmi-in-job").endsWith(` --detach wmi-in-job --acl-token ${TOKEN}`));
	assert.ok(!commandLine(spec()).includes("--acl-token"), "no token without a check");
	const { options } = launchCommand(s, { SystemRoot: "C:\\Windows" });
	assert.equal(options.env.SB_ACL_DIR, dir);
	assert.equal(options.env.SB_ACL_MARKER, join(dir, `acl.${TOKEN}.json`));
	assert.match(LAUNCH_SCRIPT, /\$k -notlike 'SB_ACL_\*'/, "the check's own variables are not passed on to the server");
});

test("the launch script makes the ACL check in the same PowerShell start: after the create, for the new pid, with the same steps the server's script runs, and leaves the marker whole (written beside, then moved)", () => {
	const at = (needle: RegExp) => LAUNCH_SCRIPT.search(needle);
	assert.ok(at(/\$wmi\.Create\(\$env:SB_LAUNCH_CMD, /) > 0);
	assert.ok(at(/\$env:SB_ACL_PID = \[string\]\$newPid/) > at(/\$wmi\.Create\(\$env:SB_LAUNCH_CMD, /), "the pid is the new one");
	assert.ok(at(/Get-Acl -LiteralPath \$dir/) > at(/SB_ACL_PID = /));
	assert.ok(at(/icacls\.exe/) > at(/SB_ACL_PID = /) && at(/\/reset/) > 0, "the same reset and read-back as the server's script");
	assert.match(LAUNCH_SCRIPT, /if \(\$created -and \$env:SB_ACL_DIR\)/, "no check when nothing was created, or when no check was asked for");
	assert.match(LAUNCH_SCRIPT, /\$m\['error'\] = \$aclError/, "a failure of the check is left in the marker, for the server to end with");
	assert.match(LAUNCH_SCRIPT, /\[IO\.File\]::WriteAllText\(\$env:SB_ACL_MARKER \+ '\.tmp'/);
	assert.match(LAUNCH_SCRIPT, /\[IO\.File\]::Move\(\$env:SB_ACL_MARKER \+ '\.tmp', \$env:SB_ACL_MARKER\)/);
	assert.match(LAUNCH_SCRIPT, /\[regex\]::Replace\(\$mj, '\[\^\\x00-\\x7F\]'/, "sbr-F007: the marker is pure ASCII, \\uXXXX for the rest");
	assert.match(LAUNCH_SCRIPT, /\[Console\]::OutputEncoding/);
	assert.equal(LAUNCH_SCRIPT.match(/powershell/gi)?.length ?? 0, 0, "no second PowerShell");
});

test("the answer carries the server's start time and the milliseconds of the create and of the check; they are logged as a phase and the start time is remembered", () => {
	const answer = parseLaunchOutput('{"rc":0,"pid":4321,"breakaway":true,"started":"2026-10-26T08:00:00.000Z","createMs":1500,"aclMs":2200}');
	assert.deepEqual(answer, { pid: 4321, breakaway: true, started: "2026-10-26T08:00:00.000Z", createMs: 1500, aclMs: 2200 });
	assert.deepEqual(parseLaunchOutput('{"rc":0,"pid":4321,"started":"yesterday","createMs":"x"}'), { pid: 4321, breakaway: true }, "only a start time in the one form is kept");
});

test("a failed start leaves an error marker the waiting server reads (PowerShell failed, timed out, or WMI refused); a marker already there is left alone; release removes the marker", async () => {
	for (const answer of [Object.assign(new Error("powershell.exe ENOENT"), { killed: false, signal: null }), '{"rc":21,"pid":0}', Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" })]) {
		rmSync(join(dir, `acl.${TOKEN}.json`), { force: true });
		const ps = fakePowershell(answer);
		const launched = spawnBreakaway(withAcl(), { exec: ps.exec, fallback: () => ({ pid: 5, exited: new Promise(() => {}) }) });
		await launched.started!;
		const text = readFileSync(join(dir, `acl.${TOKEN}.json`), "utf8");
		assert.match(JSON.parse(text).error, /./, String(answer));
		launched.release!();
	}
	const ps = fakePowershell('{"rc":21,"pid":0}');
	writeFileSync(join(dir, `acl.${TOKEN}.json`), '{"pid":1}');
	const launched = spawnBreakaway(withAcl(), { exec: ps.exec, fallback: () => ({ pid: 5, exited: new Promise(() => {}) }) });
	await launched.started!;
	assert.equal(readFileSync(join(dir, `acl.${TOKEN}.json`), "utf8"), '{"pid":1}', "an answer already there stands");
	launched.release!();
	assert.throws(() => readFileSync(join(dir, `acl.${TOKEN}.json`)), "release removes the marker");
});

test("the fallback to a plain spawn is not given a token: the server it starts makes its own check", async () => {
	const ps = fakePowershell('{"rc":21,"pid":0}');
	const plain: SpawnSpec[] = [];
	const launched = spawnBreakaway(withAcl(), { exec: ps.exec, fallback: (s) => (plain.push(s), { pid: 9, exited: new Promise(() => {}) }) });
	await launched.started!;
	assert.ok(!plain[0]!.args.includes("--acl-token"), "the plain spawn's server must not wait for a marker nobody makes");
	launched.release!();
});

// --- review N-F001: once WMI made the process, nothing ends the start with a plain spawn ---

const markerFile = () => join(dir, `acl.${TOKEN}.json`);
const others = (): string[] => readdirSync(dir).filter((f) => f.startsWith("acl."));

test("N-F001 (the reviewer's repro): PowerShell exits 1 after the create (the marker could not be moved) with an empty stdout: no plain spawn, a failed start, and the error marker is written for the server that is waiting", async () => {
	const move = Object.assign(new Error("Command failed: powershell.exe -EncodedCommand AAAA"), { code: 1, killed: false, signal: null });
	const exec: LaunchExec = (_f, _a, _o, done) => setImmediate(() => done(move, `${BEFORE_CREATE}\r\n`, 'Exception calling "Move" with "2" argument(s): "Access to the path is denied."\r\nAt line:49 char:7\r\n+ [IO.File]::Move($env:SB_ACL_MARKER + \'.tmp\', $env:SB_ACL_MARKER)\r\n'));
	const plain: SpawnSpec[] = [];
	// PowerShell's own leftover tmp is there, as it is after a failed move: the error marker uses a name of its own.
	writeFileSync(`${markerFile()}.tmp`, "{}");
	const launched = spawnBreakaway(withAcl(), { exec, fallback: (s) => (plain.push(s), { pid: 9, exited: new Promise(() => {}) }) });
	const started = await launched.started!;
	assert.equal(started.via, "failed");
	assert.match(started.failure!, /may still have started the server/);
	assert.equal(plain.length, 0, "a second server is not started");
	assert.match(JSON.parse(readFileSync(markerFile(), "utf8")).error, /Access to the path is denied/);
	assert.ok(!others().some((f) => f.endsWith(`.${process.pid}.tmp`)), "its temporary file is gone");
	launched.release!();
});

test("N-F001: an answer line is the source of truth whatever the exit code; one that says a marker failed leaves an error marker, keeps the pid, and does not fall back", async () => {
	for (const [code, exit] of [[null, 0], [1, 1]] as const) {
		rmSync(markerFile(), { force: true });
		const error = code === null ? null : Object.assign(new Error("Command failed: x"), { code, killed: false, signal: null });
		const exec: LaunchExec = (_f, _a, _o, done) => setImmediate(() => done(error, '{"rc":0,"pid":4321,"breakaway":true,"started":"2026-10-26T08:00:00.000Z","createMs":900,"aclMs":0,"markerError":"Access to the path is denied."}\r\n', ""));
		const plain: SpawnSpec[] = [];
		const launched = spawnBreakaway(withAcl(), { exec, alive: () => true, pollMs: 1000, fallback: (s) => (plain.push(s), { pid: 9, exited: new Promise(() => {}) }) });
		const started = await launched.started!;
		assert.deepEqual([started.via, started.pid, started.markerError, plain.length], ["wmi", 4321, "Access to the path is denied.", 0], `exit ${exit}`);
		assert.match(JSON.parse(readFileSync(markerFile(), "utf8")).error, /could not leave the ACL check: Access to the path is denied\./);
		launched.release!();
	}
});

test("N-F001: rc 0 with no usable pid, a half answer, and garbage are failed starts with no plain spawn; only a refusal before the create (rc other than 0, or the script's rc -1) and a PowerShell that could not start fall back", async () => {
	for (const [answer, fellBack] of [['{"rc":0,"pid":0}', false], ['{"rc":0}', false], ["garbage", false], ["", false], ['{"rc":21,"pid":0}', true], ['{"rc":-1,"pid":0,"markerError":"WMI is blocked"}', true]] as const) {
		const plain: SpawnSpec[] = [];
		const launched = spawnBreakaway(withAcl(), { exec: fakePowershell(answer).exec, fallback: (s) => (plain.push(s), { pid: 9, exited: new Promise(() => {}) }) });
		const started = await launched.started!;
		assert.equal(plain.length, fellBack ? 1 : 0, answer);
		assert.equal(started.via, fellBack ? "direct" : "failed", answer);
		launched.release!();
	}
});

test("N-F001: the script reports a failure of the marker and any failure after the create in its answer (`created` decides the exit code), and removes its own temporary marker", () => {
	assert.match(LAUNCH_SCRIPT, /\$created = \(\$r\.ReturnValue -eq 0\)\n/, "set the moment the first create returns, before anything else can fail");
	assert.match(LAUNCH_SCRIPT, /try \{\n\s+\[IO\.File\]::WriteAllText\(\$env:SB_ACL_MARKER \+ '\.tmp'[^\n]*\n\s+\[IO\.File\]::Move[^\n]*\n\s+\} catch \{\n\s+\$markerError = \$_\.Exception\.Message\n\s+Remove-Item -LiteralPath \(\$env:SB_ACL_MARKER \+ '\.tmp'\)/);
	assert.match(LAUNCH_SCRIPT, /markerError = \$markerError \}\)/, "the answer line carries it");
	assert.match(LAUNCH_SCRIPT, /\} catch \{\n\s+Say \(\[ordered\]@\{ rc = \$\(if \(\$created\) \{ 0 \} else \{ -1 \}\)/, "a failure after the create still prints the answer with rc 0 and the pid");
	assert.match(LAUNCH_SCRIPT, /if \(-not \$created\) \{ exit 1 \}/, "and only a failure before it exits 1");
	assert.match(LAUNCH_SCRIPT, /function Say\(\$o\)[^\n]*\[regex\]::Replace\(\$j, /, "the answer line is pure ASCII too (sbr-F007)");
});

test("N-F001: the error marker has a temporary name of its own and does not replace one that is there", async () => {
	writeFileSync(markerFile(), '{"pid":1}');
	const launched = spawnBreakaway(withAcl(), { exec: fakePowershell("garbage").exec, fallback: () => ({ pid: 9, exited: new Promise(() => {}) }) });
	await launched.started!;
	assert.equal(readFileSync(markerFile(), "utf8"), '{"pid":1}');
	assert.deepEqual(others().filter((f) => f.endsWith(".tmp")), []);
	launched.release!();
});

// --- re-check N2-F001: a PowerShell that dies before the create falls back; one that dies after it does not ---

test("N2-F001: the script prints a fixed line right before the first Win32_Process.Create, and its stopwatch is inside the try (so a refused method is caught before the create)", () => {
	const lines = LAUNCH_SCRIPT.split("\n");
	const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
	assert.equal(BEFORE_CREATE, "sb-before-create");
	const before = at(/Write-Output 'sb-before-create'/), create = at(/^\s+\$r = \$wmi\.Create\(\$env:SB_LAUNCH_CMD, /), tryAt = lines.indexOf("try {"), watch = at(/Stopwatch/);
	assert.ok(before > 0 && create === before + 1, "immediately before the first create");
	assert.ok(watch > tryAt && tryAt > 0, "the stopwatch is inside the try");
	assert.equal(lines.filter((l) => /Write-Output 'sb-before-create'/.test(l)).length, 1);
});

test("N2-F001: a PowerShell that exits non-zero without the line in its stdout did not reach the create: the plain spawn, visibly (a refused method, an AMSI or EDR block, a parse error)", async () => {
	for (const stdout of ["", "something else\r\n"]) {
		const died = Object.assign(new Error("Command failed: powershell.exe -EncodedCommand AAAA"), { code: 1, killed: false, signal: null });
		const exec: LaunchExec = (_f, _a, _o, done) => setImmediate(() => done(died, stdout, "Method invocation is not supported in this language mode.\r\nAt line:3 char:1\r\n"));
		const plain: SpawnSpec[] = [];
		const started = await spawnBreakaway(withAcl(), { exec, fallback: (s) => (plain.push(s), { pid: 9, exited: new Promise(() => {}) }) }).started!;
		assert.equal(started.via, "direct", JSON.stringify(stdout));
		assert.equal(started.failure, "Method invocation is not supported in this language mode., exit code 1");
		assert.equal(plain.length, 1);
		assert.equal(plain[0]!.args.at(-1), started.failure);
		assert.ok(!plain[0]!.args.includes("--acl-token"));
	}
});

test("N2-F001: with the line in stdout and no answer the server may exist: a failed start, no plain spawn, an error marker for the waiting server", async () => {
	const died = Object.assign(new Error("Command failed: powershell.exe -EncodedCommand AAAA"), { code: 1, killed: false, signal: null });
	const exec: LaunchExec = (_f, _a, _o, done) => setImmediate(() => done(died, `${BEFORE_CREATE}\r\n`, "The RPC server is unavailable.\r\n"));
	const plain: SpawnSpec[] = [];
	const launched = spawnBreakaway(withAcl(), { exec, fallback: (s) => (plain.push(s), { pid: 9, exited: new Promise(() => {}) }) });
	const started = await launched.started!;
	assert.equal(started.via, "failed");
	assert.match(started.failure!, /The RPC server is unavailable\., exit code 1\) \(Win32_Process\.Create may still have started the server\)$/);
	assert.equal(plain.length, 0);
	assert.match(JSON.parse(readFileSync(markerFile(), "utf8")).error, /may still have started/);
	launched.release!();
});

test("a CLIXML stderr never reaches a failure text: the error record's message, or stdout, with the exit code", async () => {
	const clixml = `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">Access is denied._x000D__x000A_</S><S S="Error">At line:1 char:1_x000D__x000A_</S></Objs>`;
	const progress = `#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><MS><PR N="Record"><AV>Preparing modules for first use.</AV></PR></MS></Obj></Objs>`;
	for (const [stderr, text] of [[clixml, "Access is denied., exit code 1"], [progress, "exit code 1"]] as const) {
		const died = Object.assign(new Error("Command failed: x"), { code: 1, killed: false, signal: null });
		const exec: LaunchExec = (_f, _a, _o, done) => setImmediate(() => done(died, "", stderr));
		const started = await spawnBreakaway(spec(), { exec, fallback: () => ({ pid: 9, exited: Promise.resolve(0) }) }).started!;
		assert.equal(started.failure, text);
	}
});

// --- R7-F001: the owner is checked in the launch PowerShell before anything is created ---

test("R7-F001: the launch script checks the folder's exact owner before the create and before the line that says a server may exist; a foreign owner is rc -2 and `exit 0` with nothing created", () => {
	const lines = LAUNCH_SCRIPT.split("\n");
	const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
	const sddl = at(/Get-Acl -LiteralPath \$env:SB_ACL_DIR/), refuse = at(/rc = -2/), exit = at(/^\s+exit 0$/), line = at(/Write-Output 'sb-before-create'/), create = at(/\$wmi\.Create\(\$env:SB_LAUNCH_CMD, /);
	assert.ok(sddl > 0 && sddl < refuse && refuse < exit && exit < line && line < create, `${sddl} ${refuse} ${exit} ${line} ${create}`);
	assert.match(LAUNCH_SCRIPT, /\^O:\(S-\[0-9-\]\+\|\[A-Za-z\]\{2\}\)/, "the owner is the O: of the SDDL");
	assert.ok(lines.includes("    $c = $o.ToUpperInvariant()") && lines.indexOf("    $c = $o.ToUpperInvariant()") > sddl, "the owner that is compared is the one read from the folder's SDDL");
	assert.ok(lines.some((l) => /\$sd = \(Get-Acl -LiteralPath \$env:SB_ACL_DIR\)\.Sddl/.test(l)) && lines.some((l) => l.includes("$o = ''; if ($sd -match '^O:")), "$o comes from $sd, $sd from the folder");
	assert.match(LAUNCH_SCRIPT, /\$c -eq 'SY'\) \{ \$c = 'S-1-5-18' \}/);
	assert.match(LAUNCH_SCRIPT, /LA = '-500'; LG = '-501'; DA = '-512'; DU = '-513'/, "the aliases of ownerProblems");
	assert.match(LAUNCH_SCRIPT, /if \(\$env:SB_ACL_DIR\) \{\n\s+\$me = /, "only when a check is asked for");
	assert.match(LAUNCH_SCRIPT, /if \(\$c -ne \$me -and @\('S-1-5-18','S-1-5-32-544'\) -notcontains \$c\) \{\n\s+Say \(\[ordered\]@\{ rc = -2;/, "a different owner is the refusal, unless it is SYSTEM or BUILTIN\\Administrators (the one rule of ownerProblems and the scripts' owner walks, R11-F004)");
	assert.match(LAUNCH_SCRIPT, /elseif \(\$c -eq 'BA'\) \{ \$c = 'S-1-5-32-544' \}/);
});

test("R7-F001: an answer of rc -2 is a refusal: the start fails with the reason, no plain spawn, no marker, and exited says 3", async () => {
	const plain: SpawnSpec[] = [];
	const text = "the folder belongs to another account (S-1-5-21-9-9-9-1002), not to S-1-5-21-1-2-3-1001";
	const launched = spawnBreakaway(withAcl(), { exec: fakePowershell(`{"rc":-2,"pid":0,"markerError":"${text}"}\r\n`).exec, fallback: (s) => (plain.push(s), { pid: 9, exited: new Promise(() => {}) }) });
	const started = await launched.started!;
	assert.deepEqual([started.via, started.failure, plain.length], ["refused", text, 0]);
	assert.equal(await launched.exited, 3);
	assert.deepEqual(others(), [], "no marker");
	launched.release!();
	assert.throws(() => parseLaunchOutput(`{"rc":-2,"pid":0,"markerError":"x"}`), /^Error: x$/);
});

test("R7-F001: launch turns a refusal into ServerError start-failed with an acl start error (exit 3) and does not wait for a hello", async () => {
	const w = new ServerWorld();
	try {
		const text = "the folder belongs to another account (S-1-5-21-9-9-9-1002), not to S-1-5-21-1-2-3-1001";
		const ctx = w.ctx({ spawn: () => ({ pid: undefined, exited: Promise.resolve(3), started: Promise.resolve({ pid: 0, ms: 5, via: "refused" as const, failure: text }) }) });
		const began = Date.now();
		await assert.rejects(launch(ctx, {}), (e: unknown) => e instanceof ServerError && e.code === "start-failed" && e.startError?.code === "acl" && e.startError.text === text && e.message === `acl: ${text}`);
		assert.ok(Date.now() - began < 2000);
		assert.equal(readStartError(w.slot), undefined, "R13-F004: nothing is written into the folder that was just found foreign; the reason is in the error");
	} finally {
		await w.close();
	}
});

test("F12: a launch script that stops on Constrained Language Mode (exit 1, no sb-before-create) falls back with the sentence as the reason; the server's own check then says it the same way", async () => {
	const died = Object.assign(new Error("Command failed: powershell.exe -EncodedCommand AAAA"), { code: 1, killed: false, signal: null });
	const exec: LaunchExec = (_f, _a, _o, done) => setImmediate(() => done(died, "", "sb-constrained-language\r\nAt line:1 char:1\r\n"));
	const plain: SpawnSpec[] = [];
	const started = await spawnBreakaway(spec(), { exec, fallback: (s) => (plain.push(s), { pid: 9, exited: new Promise(() => {}) }) }).started!;
	assert.equal(started.via, "direct");
	assert.equal(started.failure, "PowerShell runs in Constrained Language Mode (likely a policy); pi-straw-boss needs FullLanguage for its permission check, exit code 1");
	assert.equal(plain[0]!.args.at(-1), started.failure);
});
