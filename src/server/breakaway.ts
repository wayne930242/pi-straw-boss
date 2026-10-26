import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { alive as pidAlive } from "../remote.ts";
import type { Launched, SpawnSpec } from "./client.ts";

// The detached server on Windows, started outside the starter's job object (docs/specs/2026-10-26-sb-backend.md, Process model and lifecycle). Node's `detached: true` does not break away from
// the job the starter is in, and a Herdr pane, an ssh session, or the desk's Electron may hold its children in a kill-on-close job: the one server every session shares would then die with
// whichever pane started it. `Win32_Process.Create` through WMI makes the process a child of the WMI service, in no job of the starter's. It takes no environment (the process gets the user's
// default one), so the starter writes the environment it would have given to a file in the protected state folder, and the server reads it and deletes it before anything else (`--env-file`).

/** Names that hold a credential are left out of that file: the server needs none of them, and the file is on disk until the server has read it. */
const CREDENTIAL = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|AUTH)/i;
export const launchEnv = (env: NodeJS.ProcessEnv): Record<string, string> => Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string" && !CREDENTIAL.test(e[0])));

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
export const commandLine = (spec: Pick<SpawnSpec, "command" | "args">, envFile: string) => [spec.command, ...spec.args, "--env-file", envFile].map(winQuote).join(" ");

/**
 * The PowerShell script: the command line and the folder come in the environment (SB_LAUNCH_CMD, SB_LAUNCH_CWD), never quoted into the script. The process is created hidden and with no
 * console (CREATE_NO_WINDOW 0x08000000, CREATE_NEW_PROCESS_GROUP 0x200), as `windowsHide` and `detached` did. The answer is one JSON line: WMI's return code and the new pid.
 */
export const LAUNCH_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"$si = ([wmiclass]'Win32_ProcessStartup').CreateInstance()",
	"$si.ShowWindow = 0",
	"$si.CreateFlags = 0x08000200",
	"$r = ([wmiclass]'Win32_Process').Create($env:SB_LAUNCH_CMD, $env:SB_LAUNCH_CWD, $si)",
	"[ordered]@{ rc = [int]$r.ReturnValue; pid = [int]$r.ProcessId } | ConvertTo-Json -Compress",
].join("\n");

export function parseLaunchOutput(stdout: string): number {
	const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
	let parsed: { rc?: unknown; pid?: unknown };
	try {
		parsed = JSON.parse(line) as typeof parsed;
	} catch {
		throw new Error(`PowerShell answered ${line.slice(0, 120) || "nothing"}`);
	}
	if (parsed.rc !== 0 || typeof parsed.pid !== "number" || !(parsed.pid > 0)) throw new Error(`Win32_Process.Create returned ${String(parsed.rc)} (pid ${String(parsed.pid)})`);
	return parsed.pid;
}

export type LaunchExec = (file: string, args: string[], options: { encoding: "utf8"; timeout: number; windowsHide: true; env: NodeJS.ProcessEnv }, done: (error: Error | null, stdout: string) => void) => unknown;
const run: LaunchExec = (file, args, options, done) => execFile(file, args, options, (error, stdout) => done(error, String(stdout)));

type Started = { pid: number; ms: number; via: "wmi" | "direct"; failure?: string };
export interface BreakawayDeps {
	exec?: LaunchExec;
	alive?: (pid: number) => boolean;
	now?: () => number;
	/** The plain spawn a failed WMI start falls back to (it is told: `started` carries the failure). */
	fallback: (spec: SpawnSpec) => Launched;
	pollMs?: number;
	timeoutMs?: number;
}

/** The server's own side: reads the file the starter wrote, puts its variables into `env`, and deletes it. Throws when it cannot be read: a server in the wrong environment must not start. */
export function loadEnvFile(env: NodeJS.ProcessEnv, file: string): void {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("it is not an object");
		for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") env[key] = value;
	} catch (error) {
		throw new Error(`--env-file ${file} cannot be read: ${(error as Error).message}`);
	} finally {
		rmSync(file, { force: true });
	}
}

/** Starts the server outside the starter's job. The pid is known when PowerShell answers; `exited` resolves (with null) when that process is gone. */
export function spawnBreakaway(spec: SpawnSpec, deps: BreakawayDeps): Launched {
	const exec = deps.exec ?? run, alive = deps.alive ?? pidAlive, now = deps.now ?? Date.now, t0 = now();
	const file = join(spec.cwd, `server.env.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	let timer: ReturnType<typeof setInterval> | undefined, released = false, resolveExit!: (code: number | null) => void, resolveStarted!: (value: Started) => void;
	const exited = new Promise<number | null>((resolve) => (resolveExit = resolve));
	const started = new Promise<Started>((resolve) => (resolveStarted = resolve));
	const forget = () => rmSync(file, { force: true });
	const release = () => {
		released = true;
		if (timer) clearInterval(timer);
		forget();
	};
	const direct = (failure: string) => {
		forget();
		const plain = deps.fallback(spec);
		void plain.exited.then(resolveExit);
		resolveStarted({ pid: plain.pid ?? 0, ms: now() - t0, via: "direct", failure });
	};
	try {
		writeFileSync(file, JSON.stringify(launchEnv(spec.env)), { mode: 0o600 });
	} catch (error) {
		direct(`the environment file cannot be written: ${(error as Error).message}`);
		return { exited, started, release };
	}
	const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(LAUNCH_SCRIPT, "utf16le").toString("base64")];
	exec("powershell.exe", args, { encoding: "utf8", timeout: deps.timeoutMs ?? 30_000, windowsHide: true, env: { ...process.env, SB_LAUNCH_CMD: commandLine(spec, file), SB_LAUNCH_CWD: spec.cwd } }, (error, stdout) => {
		if (released) return;
		let pid: number;
		try {
			if (error) throw error;
			pid = parseLaunchOutput(stdout);
		} catch (failure) {
			return direct((failure as Error).message);
		}
		resolveStarted({ pid, ms: now() - t0, via: "wmi" });
		timer = setInterval(() => {
			if (alive(pid)) return;
			release();
			resolveExit(null);
		}, deps.pollMs ?? 250);
		timer.unref();
	});
	return { exited, started, release };
}
