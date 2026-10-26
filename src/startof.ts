import { execFile, execFileSync } from "node:child_process";

// A process's start time, which tells a PID another process now holds from the process that wrote a record (remote.ts `runs`, the GUI and link records).

const OWN_MS = 15_000, OTHERS_MS = 10 * 60_000, FIRST_FAIL_MS = 5000, MAX_FAIL_MS = 60_000, OWN_RETRY_MS = [1000, 2000, 4000, 8000, 15_000];
/**
 * The command that tells a Windows process's start time as stable text (UTC, ISO 8601, milliseconds); `windowsHide` keeps its console off the desktop.
 * `Win32_Process.CreationDate` answers for a service or an elevated process, whose `Get-Process` StartTime needs elevation.
 */
export const startCommand = (pid: number, timeout = 5000) => ({
	file: "powershell.exe",
	args: ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; (Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [cultureinfo]::InvariantCulture)`],
	options: { encoding: "utf8" as const, timeout, windowsHide: true },
});
const ISO_START = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
type Launch = (file: string, args: string[], options: ReturnType<typeof startCommand>["options"], done: (error: Error | null, stdout: string) => void) => unknown;
type Unrefable = { unref?: () => void };
/** `execFile` whose child, pipes, and timeout timer never hold this process open: a read still pending when pi exits is dropped with it. */
const spawnQuietly: Launch = (file, args, { timeout, ...options }, done) => {
	const child = execFile(file, args, options, (error, stdout) => done(error, String(stdout)));
	const timer = setTimeout(() => child.kill(), timeout);
	timer.unref();
	child.once("exit", () => clearTimeout(timer));
	for (const handle of [child, child.stdin, child.stdout, child.stderr] as Unrefable[]) handle?.unref?.();
	return child;
};
const laterBy = (ms: number) => new Promise<void>((done) => setTimeout(done, ms).unref());

/**
 * Process start times. On macOS and Linux `ps` answers at once, in the C locale and UTC (so two pi processes with other LANG or TZ write and read the same text).
 * Windows has no `ps`: one PowerShell call took 2 to 3 s, so there the answer comes from a cache that a background call fills, and nothing waits on PowerShell. `startOf`
 * is undefined until the answer is in (callers already treat undefined as "cannot be told"); `startedLater` is the same answer as a promise, for a caller that
 * wrote a record meanwhile and writes it again when it arrives. This process's own start time is kept for its life and read patiently (a long timeout, retried with
 * a growing wait, because session start is when the machine is busiest); another PID's answer is kept for ten minutes, a failed one for 5 s, then 10 s, 20 s, up to 60 s
 * while it keeps failing (a PID that PowerShell cannot answer for is not asked every few seconds). A PID known to be dead is forgotten (`forget`).
 */
export function createStartOf({ platform = process.platform, ps = (pid: number) => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }), launch = spawnQuietly, now = Date.now, wait = laterBy } = {}) {
	const known = new Map<number, { value: string | undefined; at: number; fails: number }>(), asking = new Map<number, Promise<string | undefined>>();
	const valid = (pid: number) => Number.isSafeInteger(pid) && pid > 0;
	const failedFor = (pid: number, fails: number) => (pid === process.pid ? MAX_FAIL_MS : Math.min(FIRST_FAIL_MS * 2 ** (fails - 1), MAX_FAIL_MS));
	const fresh = (pid: number) => {
		const seen = known.get(pid);
		return seen && now() - seen.at < (seen.value === undefined ? failedFor(pid, seen.fails) : pid === process.pid ? Infinity : OTHERS_MS) ? seen : undefined;
	};
	const once = (pid: number, timeout: number) => new Promise<string | undefined>((done) => {
		try {
			const { file, args, options } = startCommand(pid, timeout);
			launch(file, args, options, (error, stdout) => done(error ? undefined : ISO_START.test(String(stdout).trim()) ? String(stdout).trim() : undefined));
		} catch {
			done(undefined);
		}
	});
	const read = async (pid: number) => {
		if (pid !== process.pid) return once(pid, 5000);
		for (let attempt = 0; ; attempt++) {
			const value = await once(pid, OWN_MS);
			if (value || attempt === OWN_RETRY_MS.length) return value;
			await wait(OWN_RETRY_MS[attempt]!);
		}
	};
	const ask = (pid: number): Promise<string | undefined> => {
		if (!valid(pid)) return Promise.resolve(undefined);
		let pending = asking.get(pid);
		if (!pending) {
			pending = read(pid).then((value) => (known.set(pid, { value, at: now(), fails: value ? 0 : (known.get(pid)?.fails ?? 0) + 1 }), asking.delete(pid), value));
			asking.set(pid, pending);
		}
		return pending;
	};
	const startOf = (pid: number): string | undefined => {
		if (!valid(pid)) return undefined;
		if (platform === "win32") {
			const seen = fresh(pid);
			if (!seen) void ask(pid);
			return seen?.value;
		}
		try {
			return ps(pid).trim() || undefined;
		} catch {
			return undefined;
		}
	};
	const startedLater = (pid: number): Promise<string | undefined> => {
		if (platform !== "win32") return Promise.resolve(startOf(pid));
		const seen = fresh(pid);
		return seen ? Promise.resolve(seen.value) : ask(pid);
	};
	const forget = (pid: number) => void known.delete(pid);
	return { startOf, startedLater, forget };
}
const shared = createStartOf();
/** When a process started; undefined when it cannot be told (yet, on Windows). A PID reused after a crash belongs to a process that started later. */
export const startOf = shared.startOf;
/** This process's, or another's, start time once it is known: for a record that was written before it was. */
export const startedLater = shared.startedLater;
/** Drops what is cached for a PID that is seen dead, so a process that takes the number later is read afresh. */
export const forgetStart = shared.forget;
/** Starts reading this process's own start time in the background (Windows; `ps` is instant elsewhere), so the first record it writes already has it. */
export const warmStart = () => void startedLater(process.pid);
