import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { commandLine, LAUNCH_SCRIPT, launchEnv, loadEnvFile, parseLaunchOutput, spawnBreakaway, winQuote, type LaunchExec } from "../src/server/breakaway.ts";
import { launch, makeCtx, type SpawnSpec, spawnDetached } from "../src/server/client.ts";
import { run } from "../src/server/cli.ts";
import { fileOf } from "../src/server/record.ts";
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

const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({ command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\pkg\\cli.mjs", "run", "--detached", "--by", 'session "main" (3f2a1b9c)'], env: { PATH: "C:\\bin", PI_INTERCOM_SCOPE_ID: "team-a", HOME: "C:\\Users\\許功", ANTHROPIC_API_KEY: "sk-secret", GH_TOKEN: "t" }, cwd: dir, options: { detached: true, stdio: "ignore", windowsHide: true }, ...over });

test("arguments are quoted as CommandLineToArgvW reads them back: spaces, quotes, and the backslashes before them", () => {
	assert.equal(winQuote("plain"), "plain");
	assert.equal(winQuote("C:\\Program Files\\node.exe"), '"C:\\Program Files\\node.exe"');
	assert.equal(winQuote('say "hi"'), '"say \\"hi\\""');
	assert.equal(winQuote("C:\\dir with space\\"), '"C:\\dir with space\\\\"');
	assert.equal(winQuote('a\\"b'), '"a\\\\\\"b"');
	assert.equal(winQuote(""), '""');
	assert.equal(commandLine(spec(), "C:\\s\\env.tmp"), '"C:\\Program Files\\nodejs\\node.exe" C:\\pkg\\cli.mjs run --detached --by "session \\"main\\" (3f2a1b9c)" --env-file C:\\s\\env.tmp');
});

test("the environment file leaves out what holds a credential", () => {
	const env = launchEnv({ PATH: "p", PI_INTERCOM_SCOPE_ID: "a", ANTHROPIC_API_KEY: "k", GH_TOKEN: "t", MY_PASSWORD: "x", AWS_SECRET_ACCESS_KEY: "s", SSH_AUTH_SOCK: "z", UNSET: undefined });
	assert.deepEqual(env, { PATH: "p", PI_INTERCOM_SCOPE_ID: "a" });
});

test("the script creates the process through WMI (outside the starter's job), hidden and with no console, from the environment, and answers one JSON line", () => {
	assert.match(LAUNCH_SCRIPT, /\(\[wmiclass\]'Win32_Process'\)\.Create\(\$env:SB_LAUNCH_CMD, \$env:SB_LAUNCH_CWD, \$si\)/);
	assert.match(LAUNCH_SCRIPT, /\$si\.ShowWindow = 0/);
	assert.match(LAUNCH_SCRIPT, /\$si\.CreateFlags = 0x08000200/, "CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP");
	assert.ok(!/Start-Process|Invoke-Expression|node\.exe|straw-boss/i.test(LAUNCH_SCRIPT), "a Start-Process child would be in the starter's job; no path is quoted into the script");
	assert.match(LAUNCH_SCRIPT, /ConvertTo-Json -Compress/);
});

test("the launch answer: the pid when WMI returned 0, an error with its code otherwise", () => {
	assert.equal(parseLaunchOutput('{"rc":0,"pid":4321}\r\n'), 4321);
	assert.throws(() => parseLaunchOutput('{"rc":21,"pid":0}'), /returned 21/);
	assert.throws(() => parseLaunchOutput("boom"), /answered boom/);
	assert.throws(() => parseLaunchOutput(""), /nothing/);
});

function fakePowershell(answer: string | Error) {
	const seen: { file: string; args: string[]; env: NodeJS.ProcessEnv; files: string[] }[] = [];
	const exec: LaunchExec = (file, args, options, done) => {
		seen.push({ file, args, env: options.env, files: readdirSync(dir) });
		setImmediate(() => (answer instanceof Error ? done(answer, "") : done(null, answer)));
	};
	return { seen, exec };
}

test("a start writes the environment to a file in the folder first, then runs one PowerShell with the command line in the environment; the pid comes with its answer, and exited fires when it is gone", async () => {
	const ps = fakePowershell('{"rc":0,"pid":777}');
	let up = true, fell = false;
	const launched = spawnBreakaway(spec(), { exec: ps.exec, alive: () => up, pollMs: 10, fallback: () => ((fell = true), { exited: new Promise(() => {}) }) });
	assert.equal(launched.pid, undefined, "the pid is not known when the call returns");
	const started = await launched.started!;
	assert.deepEqual([started.pid, started.via, started.failure], [777, "wmi", undefined]);
	assert.equal(ps.seen.length, 1);
	assert.equal(ps.seen[0]!.file, "powershell.exe");
	assert.deepEqual(ps.seen[0]!.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-EncodedCommand"]);
	assert.equal(Buffer.from(ps.seen[0]!.args[3]!, "base64").toString("utf16le"), LAUNCH_SCRIPT);
	assert.equal(ps.seen[0]!.env.SB_LAUNCH_CWD, dir);
	const cmd = ps.seen[0]!.env.SB_LAUNCH_CMD!;
	const file = /--env-file (\S+)$/.exec(cmd)![1]!;
	assert.equal(file.startsWith(dir), true);
	assert.equal(ps.seen[0]!.files.length, 1, "the environment file was there before PowerShell ran");
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { PATH: "C:\\bin", PI_INTERCOM_SCOPE_ID: "team-a", HOME: "C:\\Users\\許功" });
	let exited: unknown = "pending";
	void launched.exited.then((c) => (exited = c));
	await sleep(40);
	assert.equal(exited, "pending", "the process runs");
	up = false;
	await until(() => exited === null, "exited when the pid is gone");
	assert.ok(!existsSync(file), "the file goes with it if the server never read it");
	assert.equal(fell, false);
});

test("release stops the watch and removes the file", async () => {
	const ps = fakePowershell('{"rc":0,"pid":778}');
	const launched = spawnBreakaway(spec(), { exec: ps.exec, alive: () => true, pollMs: 10, fallback: () => ({ exited: new Promise(() => {}) }) });
	await launched.started;
	assert.equal(readdirSync(dir).length, 1);
	launched.release!();
	assert.deepEqual(readdirSync(dir), []);
});

test("when PowerShell or WMI fails the start falls back to a plain spawn, said in `started` (and so in the log), with the file removed and the environment passed directly", async () => {
	for (const answer of [new Error("powershell.exe ENOENT"), '{"rc":21,"pid":0}', "garbage"]) {
		const ps = fakePowershell(answer);
		const plain: SpawnSpec[] = [];
		const launched = spawnBreakaway(spec(), { exec: ps.exec, fallback: (s) => (plain.push(s), { pid: 99, exited: Promise.resolve(0) }) });
		const started = await launched.started!;
		assert.equal(started.via, "direct");
		assert.ok(started.failure, String(answer));
		assert.equal(plain.length, 1);
		assert.equal(plain[0]!.env.PI_INTERCOM_SCOPE_ID, "team-a");
		assert.equal(await launched.exited, 0);
		assert.deepEqual(readdirSync(dir), []);
	}
});

test("a folder the file cannot be written in falls back too", async () => {
	const ps = fakePowershell('{"rc":0,"pid":1}');
	const launched = spawnBreakaway(spec({ cwd: join(dir, "missing") }), { exec: ps.exec, fallback: () => ({ pid: 5, exited: Promise.resolve(0) }) });
	assert.match((await launched.started!).failure ?? "", /cannot be written/);
	assert.equal(ps.seen.length, 0);
});

test("the server reads the file before anything else: its variables are set, and the file is deleted, also when it cannot be read (then the start fails and says so)", async () => {
	const file = join(dir, "e.json");
	writeFileSync(file, JSON.stringify({ PI_INTERCOM_SCOPE_ID: "team-z", HERDR_SOCKET_PATH: "C:\\h", N: 5 }));
	const env: NodeJS.ProcessEnv = { PATH: "p" };
	loadEnvFile(env, file);
	assert.deepEqual(env, { PATH: "p", PI_INTERCOM_SCOPE_ID: "team-z", HERDR_SOCKET_PATH: "C:\\h" });
	assert.ok(!existsSync(file));
	writeFileSync(file, "not json");
	assert.throws(() => loadEnvFile(env, file), /cannot be read/);
	assert.ok(!existsSync(file));
	assert.throws(() => loadEnvFile(env, join(dir, "gone.json")), /cannot be read/);
});

test("run --detached --env-file gives the server the starter's environment and deletes the file; an unreadable file is exit 1 and no server starts", async () => {
	const file = join(dir, "env.json");
	writeFileSync(file, JSON.stringify({ PI_INTERCOM_SCOPE_ID: "team-a", HERDR_SOCKET_PATH: "/h/s" }));
	let seen: NodeJS.ProcessEnv | undefined;
	const server = async (options: { env: NodeJS.ProcessEnv }) => ((seen = options.env), { ready: Promise.resolve(true), done: Promise.resolve(0), endpoint: "", shutdown: async () => {} });
	let err = "";
	const env: NodeJS.ProcessEnv = { HOME: world.env.HOME, PI_CODING_AGENT_DIR: world.env.PI_CODING_AGENT_DIR };
	const code = await run(["run", "--detached", "--by", "x", "--env-file", file], { env, stateDir: world.stateDir, version: "0.44.0", cli: "/c", server: server as never, signals: () => {}, err: (t) => void (err += t), ctx: world.ctx() });
	assert.equal(code, 0);
	assert.equal(seen?.PI_INTERCOM_SCOPE_ID, "team-a");
	assert.ok(!existsSync(file));
	seen = undefined;
	assert.equal(await run(["run", "--detached", "--env-file", file], { env, stateDir: world.stateDir, version: "0.44.0", cli: "/c", server: server as never, signals: () => {}, err: (t) => void (err += t), ctx: world.ctx() }), 1);
	assert.equal(seen, undefined);
	assert.match(err, /--env-file .* cannot be read/);
});

test("a requester on Windows spawns through the breakaway start, anywhere else through a plain detached spawn", () => {
	const plain = makeCtx({ slot: world.slot, version: "0.44.0", cli: "/c", by: "t", platform: "linux" }).spawn;
	assert.equal(plain, spawnDetached);
	assert.notEqual(makeCtx({ slot: world.slot, version: "0.44.0", cli: "/c", by: "t", platform: "win32" }).spawn, spawnDetached);
});

test("launch logs the late pid as the phase `breakaway` with how long it took, tells a fallback, and lets the start's watch go when it is done", async () => {
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
	assert.match(log, /breakaway-failed text="Win32_Process.Create returned 21 \(pid 0\)"/);
	assert.equal(released, 1);
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
