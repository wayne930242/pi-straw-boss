import { execFile } from "node:child_process";
import { alive as pidAlive } from "../remote.ts";
import { powershellPath, system32 } from "../winpath.ts";
import type { Launched, SpawnSpec, Started } from "./client.ts";

// The detached server on Windows, started outside the starter's job object (docs/specs/2026-10-26-sb-backend.md, Process model and lifecycle). Node's `detached: true` does not break away from
// the job the starter is in, and a Herdr pane, an ssh session, or the desk's Electron may hold its children in a kill-on-close job: the one server every session shares would then die with
// whichever pane started it. `Win32_Process.Create` through WMI makes the process a child of the WMI service. Microsoft's documentation of the method: "Unless the CREATE_BREAKAWAY_FROM_JOB
// flag is specified, processes created with the Win32_Process.Create method are limited by the job object", so that flag is set (and left out for a second try in the same script when
// the job does not allow it, which the answer says). The environment is the starter's whole environment, set as `Win32_ProcessStartup.EnvironmentVariables`, which replaces the default block:
// the server has it from its first instruction (`NODE_OPTIONS` and the like are read at process start), and nothing of it is written to disk.

/** Win32_ProcessStartup.CreateFlags, as Microsoft documents them: DETACHED_PROCESS (no console of the parent), CREATE_NEW_PROCESS_GROUP, CREATE_UNICODE_ENVIRONMENT, and CREATE_BREAKAWAY_FROM_JOB. CREATE_NO_WINDOW is not in that list: the window is hidden with `ShowWindow = 0`. */
const CREATE_FLAGS = { detached: 0x8, newGroup: 0x200, unicodeEnv: 0x400, breakaway: 0x01000000 } as const;
const BASE_FLAGS = CREATE_FLAGS.detached | CREATE_FLAGS.newGroup | CREATE_FLAGS.unicodeEnv;

/** One argument as CommandLineToArgvW (and so node) reads it back. */
export function winQuote(arg: string): string {
	if (arg !== "" && !/[\s"]/.test(arg)) return arg;
	let out = '"', slashes = 0;
	for (const char of arg) {
		if (char === "\\") slashes++;
		else if (char === '"') (out += `${"\\".repeat(slashes * 2 + 1)}"`, slashes = 0);
		else (out += `${"\\".repeat(slashes)}${char}`, slashes = 0);
	}
	return `${out}${"\\".repeat(slashes * 2)}"`;
}
/** How the server is told it was started through WMI (`--detach wmi`), which it records in `server.json`. */
export const commandLine = (spec: Pick<SpawnSpec, "command" | "args">) => [spec.command, ...spec.args, "--detach", "wmi"].map(winQuote).join(" ");

/**
 * The PowerShell script: the command line and the folder come in the environment (SB_LAUNCH_CMD, SB_LAUNCH_CWD), never quoted into the script, and so does the environment the server is
 * to get: this process's own, minus SB_LAUNCH_*, `PSModulePath` (PowerShell sets it itself), and the per-drive `=C:` entries. The process is created hidden (`ShowWindow` 0) and with no
 * console (DETACHED_PROCESS). The answer is one JSON line: WMI's return code, the new pid, and whether the process is outside the job.
 */
export const LAUNCH_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
	"$si.ShowWindow = 0",
	"$vars = @()",
	"foreach ($e in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { $k = [string]$e.Key; if ($k -notlike 'SB_LAUNCH_*' -and $k -ne 'PSModulePath' -and -not $k.StartsWith('=')) { $vars += ($k + '=' + [string]$e.Value) } }",
	"$si.EnvironmentVariables = $vars",
	"$wmi = [wmiclass]'Win32_Process'",
	`$si.CreateFlags = ${BASE_FLAGS | CREATE_FLAGS.breakaway}`,
	"$r = $wmi.Create($env:SB_LAUNCH_CMD, $env:SB_LAUNCH_CWD, $si)",
	"$away = $true",
	// A job that does not allow breakaway fails the creation; the same call is made once more without the flag, in this start, and the answer says so.
	`if ($r.ReturnValue -ne 0) { $si.CreateFlags = ${BASE_FLAGS}; $r = $wmi.Create($env:SB_LAUNCH_CMD, $env:SB_LAUNCH_CWD, $si); $away = $false }`,
	"[ordered]@{ rc = [int]$r.ReturnValue; pid = [int]$r.ProcessId; breakaway = $away } | ConvertTo-Json -Compress",
].join("\n");

/** The PowerShell call, by absolute path and from System32; the environment it runs with is the one the server is to get. */
export function launchCommand(spec: SpawnSpec, env: NodeJS.ProcessEnv = process.env, timeout = 30_000) {
	return {
		file: powershellPath(env),
		args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(LAUNCH_SCRIPT, "utf16le").toString("base64")],
		options: { encoding: "utf8" as const, timeout, windowsHide: true, cwd: system32(env), env: { ...spec.env, SB_LAUNCH_CMD: commandLine(spec), SB_LAUNCH_CWD: spec.cwd } as NodeJS.ProcessEnv },
	};
}

export function parseLaunchOutput(stdout: string): { pid: number; breakaway: boolean } {
	const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
	let parsed: { rc?: unknown; pid?: unknown; breakaway?: unknown };
	try {
		parsed = JSON.parse(line) as typeof parsed;
	} catch {
		throw new Error(`PowerShell answered ${line.slice(0, 120) || "nothing"}`);
	}
	if (parsed.rc !== 0 || typeof parsed.pid !== "number" || !(parsed.pid > 0)) throw new Error(`Win32_Process.Create returned ${String(parsed.rc)} (pid ${String(parsed.pid)})`);
	return { pid: parsed.pid, breakaway: parsed.breakaway !== false };
}

export type LaunchExec = (file: string, args: string[], options: ReturnType<typeof launchCommand>["options"], done: (error: (Error & { killed?: boolean; signal?: string | null }) | null, stdout: string) => void) => unknown;
const run: LaunchExec = (file, args, options, done) => execFile(file, args, options, (error, stdout) => done(error, String(stdout)));

export interface BreakawayDeps {
	exec?: LaunchExec;
	alive?: (pid: number) => boolean;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	/** The plain spawn a failed WMI start falls back to; the server is told (`--detach direct --detach-reason …`) and records it. */
	fallback: (spec: SpawnSpec) => Launched;
	pollMs?: number;
}

/**
 * Starts the server outside the starter's job. The pid is known when PowerShell answers; `exited` resolves (with null) when that process is gone. When PowerShell or WMI fails the start
 * falls back to the plain spawn, and says so in `started` and, through the server's `--detach direct`, in its record. A PowerShell that does not answer in time is a failed start with no
 * fallback: WMI may already have created the server, and a second one would race it (`started.via` is `failed`, and the start goes on waiting for a hello that may still come).
 */
export function spawnBreakaway(spec: SpawnSpec, deps: BreakawayDeps): Launched {
	const exec = deps.exec ?? run, alive = deps.alive ?? pidAlive, now = deps.now ?? Date.now, t0 = now();
	let timer: ReturnType<typeof setInterval> | undefined, released = false, resolveExit!: (code: number | null) => void, resolveStarted!: (value: Started) => void;
	const exited = new Promise<number | null>((resolve) => (resolveExit = resolve));
	const started = new Promise<Started>((resolve) => (resolveStarted = resolve));
	const release = () => {
		released = true;
		if (timer) clearInterval(timer);
	};
	const direct = (failure: string) => {
		const plain = deps.fallback({ ...spec, args: [...spec.args, "--detach", "direct", "--detach-reason", failure.slice(0, 200)] });
		void plain.exited.then(resolveExit);
		resolveStarted({ pid: plain.pid ?? 0, ms: now() - t0, via: "direct", failure });
	};
	const { file, args, options } = launchCommand(spec, deps.env, spec.timeoutMs ?? 30_000);
	exec(file, args, options, (error, stdout) => {
		if (released) return;
		if (error && (error.killed || error.signal)) {
			// No answer in time: WMI may have created the server already, so there is no second start.
			resolveStarted({ pid: 0, ms: now() - t0, via: "failed", failure: `PowerShell did not answer within ${Math.round(options.timeout / 1000)} s (Win32_Process.Create may still have started the server)` });
			return;
		}
		let answer: { pid: number; breakaway: boolean };
		try {
			if (error) throw error;
			answer = parseLaunchOutput(stdout);
		} catch (failure) {
			return direct((failure as Error).message);
		}
		resolveStarted({ pid: answer.pid, ms: now() - t0, via: "wmi", breakaway: answer.breakaway });
		timer = setInterval(() => {
			if (alive(answer.pid)) return;
			release();
			resolveExit(null);
		}, deps.pollMs ?? 250);
		timer.unref();
	});
	return { exited, started, release };
}
