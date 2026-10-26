import { execFile } from "node:child_process";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { alive as pidAlive } from "../remote.ts";
import { powershellPath, system32 } from "../winpath.ts";
import { ACL_STEPS, aclMarkerPath, asciiJson, asciiLine, execFailure, POWERSHELL_FLAGS, PROGRESS_OFF, UTF8_OUT } from "./acl.ts";
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
		else if (char === '"') {
			out += `${"\\".repeat(slashes * 2 + 1)}"`;
			slashes = 0;
		} else {
			out += `${"\\".repeat(slashes)}${char}`;
			slashes = 0;
		}
	}
	return `${out}${"\\".repeat(slashes * 2)}"`;
}
/**
 * How the server is told it was started through WMI (`--detach wmi`, or `wmi-in-job` for the second try without breakaway), which it records in `server.json`; and, when the starter makes the ACL check
 * for it, the token of the file the check is left in (`--acl-token`).
 */
export const commandLine = (spec: Pick<SpawnSpec, "command" | "args" | "acl">, how: "wmi" | "wmi-in-job" = "wmi") =>
	[spec.command, ...spec.args, "--detach", how, ...(spec.acl ? ["--acl-token", spec.acl.token] : [])].map(winQuote).join(" ");

/** Printed by the launch script right before the first `Win32_Process.Create`. */
export const BEFORE_CREATE = "sb-before-create";
/**
 * The PowerShell script, the one PowerShell start of a cold start. The command line and the folder come in the environment (SB_LAUNCH_CMD, SB_LAUNCH_CWD, and for the check SB_ACL_DIR and
 * SB_ACL_MARKER), never quoted into the script, and so does the environment the server is to get: this process's own, minus SB_LAUNCH_*, SB_ACL_*, `PSModulePath` (PowerShell sets it itself), and
 * the per-drive `=C:` entries. The process is created hidden (`ShowWindow` 0) and with no console (DETACHED_PROCESS).
 *
 * Then, with the new pid in hand, the script makes the check the server's own PowerShell would make (acl.ts ACL_STEPS: the start time of that pid, the reset of what is in the state folder, every SDDL
 * read back) and leaves it in the marker file, a temporary file moved into place (an error is left there too, as `error`). The server reads the marker and writes its secret only after it has checked
 * the SDDLs itself. The answer is one JSON line: WMI's return code, the new pid, whether the process is outside the job, the server's start time, and the milliseconds the create and the check took.
 */
export const LAUNCH_SCRIPT = [
	UTF8_OUT,
	PROGRESS_OFF,
	"$ErrorActionPreference = 'Stop'",
	// What the answer says is the source of truth for the starter: `created` turns true the moment WMI says it made the process, and from then on nothing in this script may end without the
	// answer line (a failure of the check or of the marker is reported in it as `markerError`), so the starter never starts a second server for a first that exists.
	"$created = $false; $newPid = 0; $away = $true; $started = $null; $createMs = 0; $markerError = $null",
	`function Say($o) { $j = $o | ConvertTo-Json -Compress; ${asciiJson("$j")} }`,
	"try {",
	"  $sw = [Diagnostics.Stopwatch]::StartNew()",
	"  $si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
	"  $si.ShowWindow = 0",
	"  $vars = @()",
	"  foreach ($e in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) { $k = [string]$e.Key; if ($k -notlike 'SB_LAUNCH_*' -and $k -notlike 'SB_ACL_*' -and $k -ne 'SB_STARTER_PID' -and $k -ne 'PSModulePath' -and -not $k.StartsWith('=')) { $vars += ($k + '=' + [string]$e.Value) } }",
	"  $si.EnvironmentVariables = $vars",
	"  $wmi = [wmiclass]'Win32_Process'",
	`  $si.CreateFlags = ${BASE_FLAGS | CREATE_FLAGS.breakaway}`,
	// The folder's exact owner is checked BEFORE anything is created (R7-F001): the answer line of this script cannot be forged by the folder's owner, a marker file can. A folder that another
	// account owns is refused here (rc -2): no server, and the starter fails with `acl` without falling back to a plain spawn (whose own check would refuse it as well).
	"  if ($env:SB_ACL_DIR) {",
	"    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value.ToUpperInvariant()",
	"    $sd = (Get-Acl -LiteralPath $env:SB_ACL_DIR).Sddl",
	"    $o = ''; if ($sd -match '^O:(S-[0-9-]+|[A-Za-z]{2})') { $o = $Matches[1] }",
	"    $c = $o.ToUpperInvariant()",
	"    if ($c -eq 'SY') { $c = 'S-1-5-18' } else { $rid = @{ LA = '-500'; LG = '-501'; DA = '-512'; DU = '-513' }[$c]; if ($rid -and $me.EndsWith($rid)) { $c = $me } }",
	"    if ($c -ne $me) {",
	"      Say ([ordered]@{ rc = -2; pid = 0; markerError = ('the folder belongs to another account (' + $o + '), not to ' + $me) })",
	"      exit 0",
	"    }",
	"  }",
	// The line the starter looks for when PowerShell ends without an answer: without it nothing was created (the script died earlier), with it a server may exist.
	`  Write-Output '${BEFORE_CREATE}'`,
	"  $r = $wmi.Create($env:SB_LAUNCH_CMD, $env:SB_LAUNCH_CWD, $si)",
	"  $created = ($r.ReturnValue -eq 0)",
	// A job that does not allow breakaway fails the creation; the same call is made once more without the flag, in this start, and the answer says so.
	// The server of that second try is told (`--detach wmi-in-job`, its own command line), so it records that it is in the WMI provider host's job and every status says so.
	`  if (-not $created) { $si.CreateFlags = ${BASE_FLAGS}; $r = $wmi.Create($env:SB_LAUNCH_CMD_INJOB, $env:SB_LAUNCH_CWD, $si); $created = ($r.ReturnValue -eq 0); $away = $false }`,
	"  $createMs = $sw.ElapsedMilliseconds",
	"  $newPid = [int]$r.ProcessId",
	"  if ($created -and $env:SB_ACL_DIR) {",
	"    $env:SB_ACL_PID = [string]$newPid",
	"    $aclError = $null",
	"    $out = $null",
	"    try {",
	...ACL_STEPS.map((line) => (line.startsWith("//") ? line : `      ${line}`)),
	"    } catch { $aclError = $_.Exception.Message }",
	"    $m = [ordered]@{ pid = $newPid }",
	"    if ($aclError) { $m['error'] = $aclError } else { foreach ($key in $out.Keys) { $m[$key] = $out[$key] }; $started = $out.started }",
	"    $mj = $m | ConvertTo-Json -Compress -Depth 4",
	`    $mj = ${asciiJson("$mj")}`,
	// The file appears whole, or not at all: written beside its name, then moved. A failure here (a scanner holding the file, the folder gone, a full disk) is only reported: the server exists.
	"    try {",
	"      [IO.File]::WriteAllText($env:SB_ACL_MARKER + '.tmp', $mj, [Text.Encoding]::ASCII)",
	"      [IO.File]::Move($env:SB_ACL_MARKER + '.tmp', $env:SB_ACL_MARKER)",
	"    } catch {",
	"      $markerError = $_.Exception.Message",
	"      Remove-Item -LiteralPath ($env:SB_ACL_MARKER + '.tmp') -Force -ErrorAction SilentlyContinue",
	"    }",
	"  }",
	// The starter's own start time, in this same PowerShell (after the marker, so the server is not kept waiting for it): the starter would otherwise start a PowerShell of its own to read it.
	"  $starterStarted = $null",
	"  if ($env:SB_STARTER_PID) { try { $starterStarted = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$env:SB_STARTER_PID)).CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [cultureinfo]::InvariantCulture) } catch { } }",
	"  Say ([ordered]@{ rc = [int]$r.ReturnValue; pid = $newPid; breakaway = $away; started = $started; starterStarted = $starterStarted; createMs = [int]$createMs; aclMs = [int]($sw.ElapsedMilliseconds - $createMs); markerError = $markerError })",
	"} catch {",
	// Before the process exists the answer says so (rc -1) and the exit code is 1: the starter falls back to the plain spawn. After it, the answer carries the pid and the starter does not.
	"  Say ([ordered]@{ rc = $(if ($created) { 0 } else { -1 }); pid = $newPid; breakaway = $away; started = $started; markerError = $_.Exception.Message })",
	"  if (-not $created) { exit 1 }",
	"}",
].join("\n");

/** The PowerShell call, by absolute path and from System32; the environment it runs with is the one the server is to get. */
export function launchCommand(spec: SpawnSpec, env: NodeJS.ProcessEnv = process.env, timeout = 30_000) {
	return {
		file: powershellPath(env),
		args: [...POWERSHELL_FLAGS, "-EncodedCommand", Buffer.from(LAUNCH_SCRIPT, "utf16le").toString("base64")],
		options: { encoding: "utf8" as const, timeout, windowsHide: true, cwd: system32(env), env: { ...spec.env, SB_LAUNCH_CMD: commandLine(spec), SB_LAUNCH_CMD_INJOB: commandLine(spec, "wmi-in-job"), SB_LAUNCH_CWD: spec.cwd, ...(spec.starterPid ? { SB_STARTER_PID: String(spec.starterPid) } : {}), ...(spec.acl ? { SB_ACL_DIR: spec.acl.dir, SB_ACL_MARKER: aclMarkerPath(spec.acl.dir, spec.acl.token) } : {}) } as NodeJS.ProcessEnv },
	};
}

export interface LaunchAnswer { pid: number; breakaway: boolean; started?: string; starterStarted?: string; createMs?: number; aclMs?: number; markerError?: string }
/** The answer says WMI made no process (a return code other than 0, or a script that ended before the create): a plain spawn is safe. Any other failure to read an answer leaves it open that a server exists. */
class NotCreated extends Error {}
/** The launch script found the state folder owned by another account and made nothing: the start fails with `acl` (exit 3), with no plain-spawn fallback. */
class OwnerRefused extends Error {}
export function parseLaunchOutput(stdout: string): LaunchAnswer {
	const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
	let parsed: { rc?: unknown; pid?: unknown; breakaway?: unknown; started?: unknown; starterStarted?: unknown; createMs?: unknown; aclMs?: unknown; markerError?: unknown };
	try {
		parsed = JSON.parse(line) as typeof parsed;
	} catch {
		throw new Error(`PowerShell answered ${line.slice(0, 120) || "nothing"}`);
	}
	const why = typeof parsed.markerError === "string" && parsed.markerError ? `: ${asciiLine(parsed.markerError)}` : "";
	if (parsed.rc === -2) throw new OwnerRefused(typeof parsed.markerError === "string" && parsed.markerError ? asciiLine(parsed.markerError) : "the folder belongs to another account");
	if (parsed.rc === -1) throw new NotCreated(`the launch script failed before WMI made the process${why}`);
	if (typeof parsed.rc === "number" && parsed.rc !== 0) throw new NotCreated(`Win32_Process.Create returned ${parsed.rc} (pid ${String(parsed.pid)})${why}`);
	if (parsed.rc !== 0 || typeof parsed.pid !== "number" || !(parsed.pid > 0)) throw new Error(`Win32_Process.Create returned ${String(parsed.rc)} (pid ${String(parsed.pid)})${why}`);
	const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? { value: v } : undefined);
	return {
		pid: parsed.pid, breakaway: parsed.breakaway !== false, ...(typeof parsed.started === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed.started) ? { started: parsed.started } : {}),
		...(ms(parsed.createMs) ? { createMs: parsed.createMs as number } : {}), ...(ms(parsed.aclMs) ? { aclMs: parsed.aclMs as number } : {}),
		...(typeof parsed.starterStarted === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed.starterStarted) ? { starterStarted: parsed.starterStarted } : {}),
		...(why ? { markerError: asciiLine(parsed.markerError) } : {}),
	};
}

export type LaunchExec = (file: string, args: string[], options: ReturnType<typeof launchCommand>["options"], done: (error: (Error & { killed?: boolean; signal?: string | null }) | null, stdout: string, stderr?: string) => void) => unknown;
const run: LaunchExec = (file, args, options, done) => execFile(file, args, options, (error, stdout, stderr) => done(error, String(stdout), String(stderr)));

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
	const marker = spec.acl ? aclMarkerPath(spec.acl.dir, spec.acl.token) : undefined;
	/** The check could not be made or never finished: a server that waits for it is told at once (it ends with `acl`), and one that is there by mistake does not wait for nothing. */
	const failMarker = (text: string) => {
		if (!marker || existsSync(marker)) return;
		try {
			// Its own temporary name: the launch script's `<marker>.tmp` may be there still (a write that failed halfway).
			const temp = `${marker}.${process.pid}.tmp`;
			try {
				writeFileSync(temp, JSON.stringify({ error: text.slice(0, 300) }), { flag: "wx" });
				renameSync(temp, marker);
			} catch (error) {
				rmSync(temp, { force: true });
				throw error;
			}
		} catch {
			/* a marker already there stands; a folder that cannot be written leaves the server to its own wait */
		}
	};
	const release = () => {
		released = true;
		if (timer) clearInterval(timer);
		if (marker) rmSync(marker, { force: true });
	};
	const direct = (failure: string) => {
		failMarker(failure);
		const plain = deps.fallback({ ...spec, args: [...spec.args, "--detach", "direct", "--detach-reason", failure.slice(0, 200)] });
		void plain.exited.then(resolveExit);
		resolveStarted({ pid: plain.pid ?? 0, ms: now() - t0, via: "direct", failure });
	};
	const { file, args, options } = launchCommand(spec, deps.env, spec.timeoutMs ?? 30_000);
	/** WMI may have created the server and nothing says it did not: no plain spawn (it would be a second server). The start goes on waiting for a hello that may still come. */
	const unknown = (text: string) => {
		const failure = `${text} (Win32_Process.Create may still have started the server)`;
		failMarker(failure);
		resolveStarted({ pid: 0, ms: now() - t0, via: "failed", failure });
	};
	exec(file, args, options, (error, stdout, stderr) => {
		if (released) return;
		if (error && (error.killed || error.signal)) return unknown(`PowerShell did not answer within ${Math.round(options.timeout / 1000)} s`);
		// PowerShell could not be started at all (ENOENT, EACCES, …): nothing was created.
		if (error && typeof (error as { code?: unknown }).code === "string") return direct(execFailure(error, stderr, stdout));
		let answer: LaunchAnswer;
		try {
			answer = parseLaunchOutput(stdout);
		} catch (failure) {
			// The script's answer is the source of truth, whatever the exit code. A refusal of WMI before anything was created falls back; no answer line at all does not.
			if (failure instanceof OwnerRefused) {
				resolveStarted({ pid: 0, ms: now() - t0, via: "refused", failure: (failure as Error).message });
				return resolveExit(3);
			}
			if (failure instanceof NotCreated) return direct((failure as Error).message);
			// Ended with an error and without the line printed before the create: the script died before it (a method the language mode refuses, an AMSI or EDR block, a parse error), so nothing was
			// created and the plain spawn is safe, visibly. With the line, or with no error at all, a server may exist: no second one.
			if (error && !stdout.includes(BEFORE_CREATE)) return direct(execFailure(error, stderr, stdout));
			return unknown(`PowerShell gave no usable answer${error ? ` (${execFailure(error, stderr, stdout.replace(BEFORE_CREATE, ""))})` : ` (${(failure as Error).message})`}`);
		}
		// The process exists but the check could not be left for it: the server is told at once, so it ends with `acl` instead of waiting out its 70 s.
		if (answer.markerError) failMarker(`could not leave the ACL check: ${answer.markerError}`);
		resolveStarted({ pid: answer.pid, ms: now() - t0, via: "wmi", breakaway: answer.breakaway, ...(answer.started ? { serverStarted: answer.started } : {}), ...(answer.starterStarted ? { starterStarted: answer.starterStarted } : {}), ...(answer.createMs === undefined ? {} : { createMs: answer.createMs }), ...(answer.aclMs === undefined ? {} : { aclMs: answer.aclMs }), ...(answer.markerError ? { markerError: answer.markerError } : {}) });
		timer = setInterval(() => {
			if (alive(answer.pid)) return;
			release();
			resolveExit(null);
		}, deps.pollMs ?? 250);
		timer.unref();
	});
	return { exited, started, release };
}
