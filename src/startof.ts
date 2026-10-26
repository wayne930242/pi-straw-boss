import { execFile, execFileSync } from "node:child_process";

// A process's start time, which tells a PID another process now holds from the process that wrote a record (remote.ts `runs`, the GUI and link records).

/** The command that tells a Windows process's start time as stable text (UTC, ISO 8601, milliseconds); `windowsHide` keeps its console off the desktop. */
export const startCommand = (pid: number) => ({
	file: "powershell.exe",
	args: ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')`],
	options: { encoding: "utf8" as const, timeout: 5000, windowsHide: true },
});
const ISO_START = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
type Launch = (file: string, args: string[], options: ReturnType<typeof startCommand>["options"], done: (error: Error | null, stdout: string) => void) => unknown;
const OTHERS_MS = 10 * 60_000, FAILED_MS = 5000;

/**
 * Process start times. On macOS and Linux `ps` answers at once, in the C locale and UTC (so two pi processes with other LANG or TZ write and read the same text).
 * Windows has no `ps`: one PowerShell call took 2 to 3 s, so there the answer comes from a cache that a background call fills, and nothing waits on PowerShell. `startOf`
 * is undefined until the answer is in (callers already treat undefined as "cannot be told"); `startedLater` is the same answer as a promise, for a caller that
 * wrote a record meanwhile and writes it again when it arrives. This process's own start time is kept for its life, another PID's answer for ten minutes (a failed one for 5 s).
 */
export function createStartOf({ platform = process.platform, ps = (pid: number) => execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }), launch = execFile as unknown as Launch, now = Date.now } = {}) {
	const known = new Map<number, { value: string | undefined; at: number }>(), asking = new Map<number, Promise<string | undefined>>();
	const fresh = (pid: number) => {
		const seen = known.get(pid);
		return seen && now() - seen.at < (seen.value === undefined ? FAILED_MS : pid === process.pid ? Infinity : OTHERS_MS) ? seen : undefined;
	};
	const ask = (pid: number): Promise<string | undefined> => {
		let pending = asking.get(pid);
		if (!pending) {
			const { file, args, options } = startCommand(pid);
			pending = new Promise<string | undefined>((done) => {
				try {
					launch(file, args, options, (error, stdout) => done(error ? undefined : ISO_START.test(String(stdout).trim()) ? String(stdout).trim() : undefined));
				} catch {
					done(undefined);
				}
			}).then((value) => (known.set(pid, { value, at: now() }), asking.delete(pid), value));
			asking.set(pid, pending);
		}
		return pending;
	};
	const startOf = (pid: number): string | undefined => {
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
	return { startOf, startedLater };
}
const shared = createStartOf();
/** When a process started; undefined when it cannot be told (yet, on Windows). A PID reused after a crash belongs to a process that started later. */
export const startOf = shared.startOf;
/** This process's, or another's, start time once it is known: for a record that was written before it was. */
export const startedLater = shared.startedLater;
/** Starts reading this process's own start time in the background (Windows; `ps` is instant elsewhere), so the first record it writes already has it. */
export const warmStart = () => void startedLater(process.pid);
