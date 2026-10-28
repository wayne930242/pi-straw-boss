import { execFile } from "node:child_process";
import { execFileExe } from "../exe.mjs";
import { POWERSHELL_FLAGS, PROGRESS_OFF } from "./acl.ts";
import { powershellPath, system32 } from "../winpath.ts";

// Which process is pi. `herdr pane process-info` lists what runs in a pane's foreground, and when pi is started through a wrapper (`cmd.exe /c pi.cmd` on Windows, a `sh -c` or Volta shim elsewhere)
// that is the wrapper, not pi: pi claims its run with its own PID, which is a child of the wrapper's. The server settles the relation itself, from the process table (CIM on Windows, `ps`
// elsewhere), and never from a PID or parent a pi reports: the pi of a run is the first process below the listed one that carries the run's `--sb-run <id>` and is not itself a wrapper, reached through wrappers
// only, and it started no earlier than its parent.

/** One process of the table: its parent, start time (UTC ISO on Windows, `ps` lstart text elsewhere), program name, and whether its command line carries the run's `--sb-run <id>`. */
export interface Proc { pid: number; ppid: number; started?: string; name: string; carries: boolean }
/** The process table, with `carries` set for the run id; undefined when it cannot be read. */
export type Procs = (runId: string) => Promise<Proc[] | undefined>;
/** pi's process below a listed one: its PID and start time, and the processes between (the listed one first), which a kill must also take. */
export interface Lineage { pid: number; started?: string; via: number[] }

const RUN_ID = /^[0-9a-f]{1,64}$/i;
const READ_MS = 15_000, MAX_DEPTH = 8;
/** Programs that start another program and wait for it: a listed process of one of these has a pi below it, possibly one that is not there yet. */
const WRAPPER = /^(cmd|sh|bash|dash|zsh|fish|env|npm|npx|pnpm|yarn|volta|powershell|pwsh)(\.exe)?$/i;
export const isWrapper = (name: string) => WRAPPER.test(name);

const ms = (text: string | undefined) => (text === undefined ? NaN : Date.parse(text));
/** Whether `child` can be a child of `parent`: it did not start before it (a PID is reused, and a ppid outlives its process). Unknown times pass. */
const after = (child: Proc, parent: Proc) => {
	const a = ms(child.started), b = ms(parent.started);
	return Number.isNaN(a) || Number.isNaN(b) || a >= b;
};

/**
 * The pi below `root` (the PID Herdr lists): the first process below it that carries the run id and is not a wrapper, reached only through wrappers (a process of pi's own, such as a tool that carries the id
 * in its command line, is never taken for pi); the deepest wrapper that carries the id when no pi is there yet, the earliest started among equals; `root` itself when none does. Undefined when `root` is
 * not in the table. Only parent links that agree with the start times count.
 */
export function leafOf(table: Proc[], root: number): Lineage | undefined {
	const byParent = new Map<number, Proc[]>();
	for (const p of table) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
	const top = table.find((p) => p.pid === root);
	if (!top) return undefined;
	let best: { proc: Proc; path: Proc[] } = { proc: top, path: [top] };
	const seen = new Set<number>([root]);
	const walk = (path: Proc[]) => {
		const here = path[path.length - 1]!;
		if (path.length > 1 && here.carries && (path.length > best.path.length || (path.length === best.path.length && (ms(here.started) < ms(best.proc.started) || here.pid < best.proc.pid && Number.isNaN(ms(here.started)))))) best = { proc: here, path };
		// Only a wrapper has a pi below it: what a pi started is not pi.
		if (path.length > MAX_DEPTH || !isWrapper(here.name)) return;
		for (const kid of byParent.get(here.pid) ?? []) {
			if (seen.has(kid.pid) || !after(kid, here)) continue;
			seen.add(kid.pid);
			walk([...path, kid]);
		}
	};
	walk([top]);
	return { pid: best.proc.pid, ...(best.proc.started ? { started: best.proc.started } : {}), via: best.path.slice(0, -1).map((p) => p.pid) };
}

/** The processes from `pid` up to `root` in the table (`pid` first), or undefined when `pid` is not `root` or below it (the walk is bounded, and each link must agree with the start times). */
export function chain(table: Proc[], pid: number, root: number): number[] | undefined {
	const by = new Map(table.map((p) => [p.pid, p]));
	const path: number[] = [];
	let here = by.get(pid);
	for (let hops = 0; here && hops <= MAX_DEPTH; hops++) {
		path.push(here.pid);
		if (here.pid === root) return path;
		const up = by.get(here.ppid);
		if (!up || !after(here, up)) return undefined;
		here = up;
	}
	return undefined;
}
/** Whether `pid` is `root` or has it as an ancestor in the table. */
export const below = (table: Proc[], pid: number, root: number): boolean => chain(table, pid, root) !== undefined;

const TAB = "\t";
const ISO_START = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** The Windows command: every process as `pid TAB ppid TAB UTC start TAB name TAB 1|0` (1: its command line holds `--sb-run <id>`). One PowerShell start. */
export const cimCommand = (runId: string, env: NodeJS.ProcessEnv = process.env) => ({
	file: powershellPath(env),
	args: [...POWERSHELL_FLAGS, "-Command", `${PROGRESS_OFF}; $ErrorActionPreference='Stop'; $id='${runId}'; $inv=[cultureinfo]::InvariantCulture; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name,CommandLine | ForEach-Object { $d=''; if ($_.CreationDate) { $d=$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ',$inv) }; $c='0'; if ($_.CommandLine -and $_.CommandLine.Contains('--sb-run ' + $id)) { $c='1' }; (@($_.ProcessId,$_.ParentProcessId,$d,$_.Name,$c) -join [char]9) }`],
	options: { encoding: "utf8" as const, timeout: READ_MS, windowsHide: true, cwd: system32(env), maxBuffer: 16 * 1024 * 1024 },
});
export function parseCim(text: string): Proc[] {
	return text.split(/\r?\n/).flatMap((line) => {
		const [pid, ppid, started, name, carries] = line.split(TAB);
		const a = Number(pid), b = Number(ppid);
		if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || name === undefined || carries === undefined) return [];
		return [{ pid: a, ppid: b, ...(started && ISO_START.test(started) ? { started } : {}), name, carries: carries === "1" }];
	});
}
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/;
/** `ps -A -ww -o pid=,ppid=,lstart=,command=` (C locale, UTC: the same text `startOf` reads for one PID). */
export function parsePs(text: string, runId: string): Proc[] {
	return text.split("\n").flatMap((line) => {
		const m = PS_LINE.exec(line);
		if (!m) return [];
		const command = m[4]!, program = command.split(/\s+/)[0] ?? "";
		return [{ pid: Number(m[1]), ppid: Number(m[2]), started: m[3]!, name: program.slice(program.lastIndexOf("/") + 1), carries: command.includes(`--sb-run ${runId}`) }];
	});
}

/** The process table as the server reads it. Windows: one PowerShell; elsewhere: `ps`. Undefined on any failure (the caller falls back to the listed process). */
export const readProcs = (platform: NodeJS.Platform = process.platform): Procs => (runId) => {
	if (!RUN_ID.test(runId)) return Promise.resolve(undefined);
	return new Promise((done) => {
		try {
			if (platform === "win32") {
				const { file, args, options } = cimCommand(runId);
				execFile(file, args, options, (error, stdout) => done(error ? undefined : parseCim(String(stdout))));
			} else {
				execFileExe("ps", ["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="], { encoding: "utf8", timeout: 5000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }, (error, stdout) => done(error ? undefined : parsePs(String(stdout), runId)));
			}
		} catch {
			done(undefined);
		}
	});
};
