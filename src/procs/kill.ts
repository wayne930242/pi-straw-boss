import { guardSignal } from "./killguard.ts";
import { named, programOf, readTable, refOf, sameProc, type Proc, type Ref } from "./table.ts";
import { startOf } from "../startof.ts";

// The kill sequence: SIGTERM to each target group and then to each target pid, 10 s later SIGKILL to what is left, then a last look. Every signal is preceded by a check that the pid still has the start time
// that made it a target (a pid is reused), a group is signalled only when every member of it is a target, and the clock, the table, the start-time probe, and the signal are injected.
// What it reports names pids and the program (`comm`) and counts; never a command line or an environment.

export type Signal = "SIGTERM" | "SIGKILL";
export interface KillDeps {
	/** A fresh table, of every account's processes (a group is whole only when no foreign member is in it); a failed read throws (no signal goes out on a table that was not read). */
	read(): Promise<Proc[] | undefined>;
	/** The start time of the pid now, undefined when it is gone. */
	probe(pid: number): string | undefined;
	/** Sends `signal` to a pid, or to the group `-pgid`. */
	signal(target: number, signal: Signal): void;
	sleep(ms: number): Promise<void>;
	/** This process's pid: never signalled, nor the group it is in. */
	self?: number;
	/** False: no group is signalled whole, each target gets its own signal after its own identity check (a pane close, whose group membership was read off an older table). Default true. */
	groups?: boolean;
	graceMs?: number;
	/** The last look: up to `tries` reads, `stepMs` apart, until nothing is left. */
	settle?: { tries: number; stepMs: number };
}
export interface KillReport {
	/** Targets that were alive with their identity when SIGTERM went out. */
	termed: number;
	/** Targets still alive after the grace, that got SIGKILL. */
	killed: number;
	/** Targets whose identity changed or that were gone before their signal could go out. */
	skipped: number;
	groups: number;
	/** The processes still there; `program` is the display name (the executable on Linux), not `ps` comm. */
	left: { pid: number; program: string }[];
}

/** The groups that may be signalled whole: a group led by a target (its pgid is a target's pid) whose every member in `table` is a target. Others get their members signalled one by one. */
export function wholeGroups(targets: readonly Proc[], table: readonly Proc[], self: { pid: number; pgid: number }): number[] {
	const want = new Set(targets.map((t) => t.pid));
	const members = new Map<number, Proc[]>();
	for (const p of table) members.set(p.pgid, [...(members.get(p.pgid) ?? []), p]);
	return [...new Set(targets.map((t) => t.pgid))].filter((g) => g > 1 && g !== self.pgid && want.has(g) && (members.get(g) ?? []).every((m) => want.has(m.pid) && m.pid !== self.pid));
}

const refuses = (target: number, self: { pid: number; pgid: number }) => {
	const id = Math.abs(target);
	if (!Number.isSafeInteger(target) || id <= 1 || (target > 0 ? id === self.pid : id === self.pgid)) throw new Error(`refusing to signal ${target}`);
};

/** The default signal: the test guard first (it refuses what a test did not start), then the kernel. */
export const sendSignal = (target: number, signal: Signal): void => {
	guardSignal(target, signal);
	process.kill(target, signal);
};
export const probeStart = (pid: number) => startOf(pid);

export async function killSequence(refs: readonly Ref[], deps: KillDeps): Promise<KillReport> {
	const { read, probe, sleep } = deps, me = deps.self ?? process.pid, grace = deps.graceMs ?? 10_000, settle = deps.settle ?? { tries: 20, stepMs: 50 };
	const table = async () => {
		const t = await read();
		if (!t) throw new Error("the process table could not be read; nothing was signalled");
		return t;
	};
	// The group this process is in is read off the table; a group with this process in it is never signalled whole (wholeGroups).
	let self = { pid: me, pgid: -1 };
	const alive = (t: readonly Proc[]) => t.filter((p) => !p.zombie && refs.some((r) => sameProc(refOf(p), r)) && p.pid !== me);
	const report: KillReport = { termed: 0, killed: 0, skipped: 0, groups: 0, left: [] };
	const send = (targets: readonly Proc[], all: readonly Proc[], signal: Signal): number => {
		let sent = 0;
		const send1 = (target: number, check: readonly Proc[]) => {
			// Each member's identity is read again right before the signal; one that changed or went leaves this signal out.
			if (check.some((p) => probe(p.pid) !== p.started)) return false;
			refuses(target, self);
			try {
				deps.signal(target, signal);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH" || (error as NodeJS.ErrnoException).code === "EPERM") return false;
				throw error;
			}
		};
		const covered = new Set<number>();
		for (const group of deps.groups === false ? [] : wholeGroups(targets, all, self)) {
			const members = all.filter((p) => p.pgid === group);
			if (send1(-group, members)) (report.groups += signal === "SIGTERM" ? 1 : 0, members.forEach((m) => covered.add(m.pid)));
		}
		for (const target of targets) {
			if (covered.has(target.pid)) { sent++; continue; }
			if (send1(target.pid, [target])) sent++;
			else report.skipped++;
		}
		return sent;
	};

	const first = await table(), first1 = alive(first);
	self = { pid: me, pgid: first.find((p) => p.pid === me)?.pgid ?? -1 };
	report.termed = send(first1, first, "SIGTERM");
	await sleep(grace);
	const second = await table(), rest = alive(second);
	if (rest.length) report.killed = send(rest, second, "SIGKILL");
	let left = rest;
	for (let tries = 0; left.length && tries < settle.tries; tries++) {
		await sleep(settle.stepMs);
		left = alive(await table());
	}
	report.left = left.map((p) => ({ pid: p.pid, program: programOf(named(p)) }));
	return report;
}

/** The sequence with the real table, probe, and guarded signal: what the server runs. */
export const reap = (refs: readonly Ref[], over: Partial<KillDeps> = {}) =>
	killSequence(refs, { read: () => readTable(undefined, { all: true }), probe: probeStart, signal: sendSignal, sleep: (ms) => new Promise((done) => setTimeout(done, ms)), ...over });
