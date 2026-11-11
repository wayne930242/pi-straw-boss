import { readlinkSync } from "node:fs";
import { basename } from "node:path";
import { execFileExe } from "../exe.mjs";

// The process table of the account: what `ps` tells about each process, and the relations the reaper decides on. A process is known by (pid, start time), never by pid alone: a pid is reused.
// Nothing here reads or returns a command line or an environment; `comm` is the program's name only (on Linux, where it is a thread name a program may set for itself, `exe` names the program).

export interface Proc {
	pid: number;
	ppid: number;
	pgid: number;
	uid: number;
	/** `ps` lstart text in the C locale and UTC, the same text `startOf` (src/startof.ts) returns, so records from both compare. */
	started: string;
	/** Cpu time used so far, in seconds. */
	cpu: number;
	/** The program as `ps` names it (a path on macOS; on Linux the thread name); `programOf` for display. */
	comm: string;
	/** Linux only, set by `named` (not by `readTable`): the file name of the program, from the link `/proc/<pid>/exe`. There `comm` is the name of the main thread, which a program may set for itself (node 24 sets "MainThread"), so `programOf` prefers this. Absent where the link cannot be read (another account's process, a kernel thread, a zombie). */
	exe?: string;
	zombie: boolean;
}
/** A process as a record keeps it: its pid and the start time that tells it from the next holder of the number. */
export interface Ref { pid: number; started: string }

export const refOf = (p: Proc): Ref => ({ pid: p.pid, started: p.started });
export const sameProc = (a: Ref, b: Ref) => a.pid === b.pid && a.started === b.started;
export const baseName = (comm: string) => (comm.includes("/") ? basename(comm) : comm);
/** The name to show for a process: its executable's file name where Linux tells it, else `comm`. Rules that name a program (shells, herdr, systemd) read `comm`, which a program's own name for itself never replaces. */
export const programOf = (p: Pick<Proc, "comm" | "exe">) => p.exe ?? baseName(p.comm);

export const PS_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,uid=,stat=,lstart=,time=,comm="];
const ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(\S+)\s+(.+?)\s*$/;

/** `[d-][hh:]mm:ss[.cc]` (Linux, macOS) as seconds. */
export function cpuSeconds(text: string): number | undefined {
	const m = /^(?:(\d+)-)?(\d+(?::\d+)*)(\.\d+)?$/.exec(text);
	if (!m) return undefined;
	const parts = m[2]!.split(":").map(Number);
	if (parts.length > 3) return undefined;
	const clock = parts.reduce((total, part) => total * 60 + part, 0);
	return Number(m[1] ?? 0) * 86400 + clock + Number(m[3] ?? 0);
}

/** The rows of `ps -A -o pid=,ppid=,pgid=,uid=,stat=,lstart=,time=,comm=`; a line that does not parse is dropped. */
export function parsePs(text: string): Proc[] {
	const table: Proc[] = [];
	for (const line of text.split("\n")) {
		const m = ROW.exec(line);
		const cpu = m ? cpuSeconds(m[7]!) : undefined;
		if (!m || cpu === undefined) continue;
		table.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), uid: Number(m[4]), started: m[6]!, cpu, comm: m[8]!, zombie: m[5]!.startsWith("Z") });
	}
	return table;
}

/** Runs a program and gives its output; a program that exits non-zero still gives what it printed (lsof does when a pid is gone), one that prints nothing and fails throws. */
export type Run = (file: string, args: string[]) => Promise<string>;
export const run: Run = (file, args) => new Promise((resolve, reject) => {
	execFileExe(file, args, { encoding: "utf8", maxBuffer: 1 << 26, deadline: 15_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => (error && !stdout ? reject(error) : resolve(stdout)));
});

/** The file name behind a `/proc/<pid>/exe` link (a replaced file reads ` (deleted)`); undefined for a name with a control character, which no output may carry. */
export function exeName(link: string): string | undefined {
	const name = basename(link.endsWith(" (deleted)") ? link.slice(0, -" (deleted)".length) : link);
	return name && !/[\u0000-\u001f\u007f-\u009f]/.test(name) ? name : undefined;
}

/** The account's own processes, now (`all`: every account's, which the kill sequence reads so a group with a foreign member is not signalled whole). Undefined on a platform without `ps`; a failed `ps` throws (the caller must not decide on a table it did not get). */
export async function readTable(ask: Run = run, { uid = process.getuid?.(), platform = process.platform, all = false }: { uid?: number; platform?: NodeJS.Platform; all?: boolean } = {}): Promise<Proc[] | undefined> {
	if (platform === "win32") return undefined;
	return parsePs(await ask("ps", PS_ARGS)).filter((p) => all || uid === undefined || p.uid === uid);
}

/** The row with its `exe` on Linux, for a process whose name is about to be shown (the removal guard's refusal, a kill report's `left`). Lazy on purpose: the 10 s tick reads the table for owners and never shows a name, so it must not pay a `readlink` per row. Only the account's own live rows are looked up; a link that cannot be read (gone, EACCES) leaves the row as it is, and this never throws. */
export function named(p: Proc, { uid = process.getuid?.(), platform = process.platform, readlink = (pid: number) => readlinkSync(`/proc/${pid}/exe`) }: { uid?: number; platform?: NodeJS.Platform; readlink?: (pid: number) => string } = {}): Proc {
	if (platform !== "linux" || p.zombie || uid === undefined || p.uid !== uid) return p;
	try {
		const exe = exeName(readlink(p.pid));
		return exe ? { ...p, exe } : p;
	} catch { /* gone, or not readable: comm stands */ }
	return p;
}

/** Whether the parent is the init process or a subreaper (the user's `systemd --user` on Linux): the process lost its starter. A parent the table does not list is another account's, not a dead one. */
export const isOrphan = (p: Proc, reapers: readonly number[]) => p.ppid === 1 || reapers.includes(p.ppid);

/** Everything below `roots` by parent links, once each, without the roots themselves. */
export function descendants(table: readonly Proc[], roots: readonly number[]): Proc[] {
	const kids = new Map<number, Proc[]>();
	for (const p of table) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
	const skip = new Set(roots), seen = new Set<number>(), out: Proc[] = [];
	const walk = (pid: number) => {
		for (const kid of kids.get(pid) ?? []) {
			if (seen.has(kid.pid)) continue;
			seen.add(kid.pid);
			if (!skip.has(kid.pid)) out.push(kid);
			walk(kid.pid);
		}
	};
	for (const root of roots) walk(root);
	return out;
}
