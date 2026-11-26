import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type HerdrRun, panes, result } from "../herdr.ts";
import { type Cwd, readCwds } from "../procs/cwd.ts";
import { type KillReport, reap as realReap } from "../procs/kill.ts";
import { killSet, type Protect } from "../procs/killset.ts";
import { baseName, descendants, named, programOf, type Proc, readTable, type Ref, refOf, sameProc } from "../procs/table.ts";
import { physical, under } from "../procs/worktree.ts";
import type { Ctx } from "./client.ts";
import { protectedSet } from "./procs.ts";
import { askProcs, type Asked } from "./procscli.ts";

// `cli.mjs pane close <pane> [--checkout <path>]` (docs/how-it-works.md#a-checked-pane-close): a pane close that is checked. `herdr pane close` can answer ok and leave the pane listed, and a pane it closes runs no
// session_shutdown, so what its pi started (a monitor, a poll loop) goes on, adopted by init, and holds the checkout. So the pane's process tree is read first; the pane is closed and looked for in `herdr pane list`,
// closed again while it is still there (up to ATTEMPTS closes); once it is gone, what is left of its tree goes through the kill sequence of src/procs (the protected set spared), and the processes of `--checkout`
// through the sb server's `procs reap --checkout`; then what still runs from the tree or in the checkout is `left`. A pane that stays listed is not reaped: its processes are what keeps it. Kept out of cli.ts, which carries a line budget.
// Exit codes: 0 the pane is gone and nothing is left; 1 the pane is still listed, something is left, or a step failed (the JSON on stdout says which, or one line on stderr when nothing was closed); 2 usage.

/** Closes tried while the pane stays listed, and the looks after each close (LOOKS of them, LOOK_MS apart: 2 s per close). */
export const ATTEMPTS = 3, LOOKS = 4, LOOK_MS = 500;

export interface PaneDeps {
	run: HerdrRun;
	sleep(ms: number): Promise<void>;
	now(): number;
	/** The account's processes now; undefined where there is no table (Windows). A failed read throws. */
	read(): Promise<Proc[] | undefined>;
	cwds(pids: readonly number[]): Promise<Map<number, Cwd>>;
	/** What is never signalled: the Herdr server, live panes' shells and foregrounds, sb servers, the intercom broker (procs.ts `protectedSet`). */
	protect(table: readonly Proc[]): Promise<Protect[]>;
	/** The kill sequence (src/procs/kill.ts). */
	reap(refs: readonly Ref[]): Promise<KillReport>;
	/** The sb server's `procs reap --checkout`. */
	reapCheckout(path: string): Promise<Asked>;
	/** The physical path of a folder, as lsof reports a working folder. */
	real(path: string): string;
	/** This process: never a target, and neither it nor what it runs under is ever `left`. */
	self: number;
	/** The pane this command runs in (`HERDR_PANE_ID`), which it never closes. */
	here?: string;
	uid?: number;
	platform: NodeJS.Platform;
}
export interface Left { pid: number; program: string; /** `tree`: started in the pane; `checkout`: works in `--checkout`. */ where: "tree" | "checkout" }
export interface PaneClosed {
	pane: string;
	closed: boolean;
	attempts: number;
	/** Each close after which Herdr still listed the pane, and what ran in its foreground then (for a Herdr issue). */
	noops: { attempt: number; at: string; foreground: string[] }[];
	reaped?: { tree: { targets: number; termed: number; killed: number; spared: number }; checkout?: Record<string, unknown> | { error: string } };
	left: Left[];
	/** A step that could not run; the result is then no proof that nothing is left. */
	error?: string;
}
interface Info { shell_pid?: number; foreground_processes?: { pid?: number; name?: string; argv0?: string }[] }

export async function closePane(pane: string, checkout: string | undefined, d: PaneDeps): Promise<PaneClosed> {
	if (d.platform === "win32") throw new Error("pane close reads the process table, which Windows does not give here: close the pane with herdr pane close and stop what it left by hand");
	if (pane === d.here) throw new Error(`this command runs in pane ${pane}, and does not close its own pane`);
	const listed = async () => (await panes(d.run)).some((p) => p.pane_id === pane);
	if (!(await listed())) throw new Error(`no pane ${pane} in Herdr's list; nothing was closed`);
	const info = async () => (await result(d.run, ["pane", "process-info", "--pane", pane]))?.process_info as Info | undefined;
	// The tree before the close: the pane's shell, its foreground, and everything below them. Without it, what the pane leaves is found only in `--checkout`.
	const before = await d.read(), seen = await info().catch(() => undefined);
	if (!before) throw new Error("the process table could not be read; nothing was closed");
	const roots = [seen?.shell_pid, ...(seen?.foreground_processes ?? []).map((p) => p.pid)].filter((pid): pid is number => typeof pid === "number" && pid > 1);
	const tree = [...before.filter((p) => roots.includes(p.pid)), ...descendants(before, roots)].filter((p) => !p.zombie && p.pid !== d.self).map(refOf);
	const out: PaneClosed = { pane, closed: false, attempts: 0, noops: [], left: [], ...(roots.length ? {} : { error: `Herdr did not show what runs in pane ${pane}, so only --checkout can find what it leaves` }) };
	while (!out.closed && out.attempts < ATTEMPTS) {
		out.attempts++;
		// An error here may be a pane that went meanwhile: the list says.
		await d.run(["pane", "close", pane]).catch(() => undefined);
		for (let look = 0; look < LOOKS && !out.closed; look++) {
			await d.sleep(LOOK_MS);
			out.closed = !(await listed().catch(() => true)); // a list that cannot be read proves nothing
		}
		if (!out.closed) out.noops.push({ attempt: out.attempts, at: new Date(d.now()).toISOString(), foreground: ((await info().catch(() => undefined))?.foreground_processes ?? []).map((p) => String(p.name ?? p.argv0 ?? p.pid)) });
	}
	try {
		return await afterClose(out, tree, checkout, d);
	} catch (error) {
		// What was closed stays said: a step that failed after the close is the result's `error`, not a lost answer.
		return { ...out, error: `${(error as Error).message}; what is left is not known` };
	}
}

/** Once the closes are done: the reap of the pane's tree and of `--checkout` (only when the pane is gone), then what is `left`. */
async function afterClose(out: PaneClosed, tree: readonly Ref[], checkout: string | undefined, d: PaneDeps): Promise<PaneClosed> {
	const leftOf = (table: readonly Proc[], where: Left["where"], keep: (p: Proc) => boolean) => {
		// This process and what it runs under (a shell, the session that ran it) are never `left`, wherever they work.
		const mine = new Set<number>();
		for (let p = table.find((x) => x.pid === d.self); p && !mine.has(p.pid); p = table.find((x) => x.pid === p!.ppid)) mine.add(p.pid);
		for (const p of table) if (!p.zombie && !mine.has(p.pid) && !out.left.some((l) => l.pid === p.pid) && keep(p)) out.left.push({ pid: p.pid, program: programOf(named(p, { platform: d.platform })), where });
	};
	const inTree = (p: Proc) => tree.some((r) => sameProc(refOf(p), r));
	if (!out.closed) {
		// The pane is still there: its processes are what keeps it, and they are not reaped while it stands.
		leftOf((await d.read()) ?? [], "tree", inTree);
		return out;
	}
	const now = await d.read();
	if (!now) return { ...out, error: "the process table could not be read after the close; nothing was signalled" };
	const reapers = d.platform === "linux" ? now.filter((p) => p.ppid === 1 && baseName(p.comm) === "systemd").map((p) => p.pid) : [];
	const decision = killSet({ owner: { id: `(pane ${out.pane})`.slice(0, 64), pid: -1, started: "", roots: [], snapshot: [...tree] }, live: [], table: now, places: new Map(), markers: new Map(), protect: await d.protect(now), reapers, self: [d.self], ...(d.uid !== undefined ? { ownUid: d.uid } : {}) });
	const report: KillReport = decision.targets.length ? await d.reap(decision.targets.map((t) => refOf(t.proc))) : { termed: 0, killed: 0, skipped: 0, groups: 0, left: [] };
	out.reaped = { tree: { targets: decision.targets.length, termed: report.termed, killed: report.killed, spared: decision.spared.length } };
	if (checkout !== undefined) {
		const asked = await d.reapCheckout(checkout);
		out.reaped.checkout = asked.ok ? asked.reply : { error: asked.error };
	}
	const after = await d.read();
	if (!after) return { ...out, error: "the process table could not be read after the reap; what is left is not known" };
	leftOf(after, "tree", inTree);
	if (checkout !== undefined) {
		const root = d.real(checkout), cwds = await d.cwds(after.filter((p) => !p.zombie).map((p) => p.pid));
		leftOf(after, "checkout", (p) => { const at = cwds.get(p.pid); return at !== undefined && under(d.real(at.path), root); });
	}
	return out;
}

export interface PaneIo { out(text: string): void; err(text: string): void; env: NodeJS.ProcessEnv; run: HerdrRun; over?: Partial<PaneDeps> }
export async function runPane(ctx: Ctx, flags: Record<string, string | true>, { out, err, env, run, over }: PaneIo): Promise<number> {
	const checkout = typeof flags.checkout === "string" ? resolve(flags.checkout) : undefined;
	const d: PaneDeps = {
		run, sleep: (ms) => ctx.sleep(ms), now: ctx.now, read: () => readTable(), cwds: (pids) => readCwds(pids), reap: (refs) => realReap(refs), real: physical, self: process.pid, platform: ctx.platform,
		protect: (table) => protectedSet(table, { run: (args) => run(args), stateDir: ctx.slot.stateDir, agentDir: env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), self: process.pid }),
		reapCheckout: (path) => askProcs(ctx, { cmd: "procs-reap", checkout: path }), ...(env.HERDR_PANE_ID ? { here: env.HERDR_PANE_ID } : {}), ...(process.getuid ? { uid: process.getuid() } : {}), ...over,
	};
	let closed: PaneClosed;
	try {
		closed = await closePane(String(flags.pane), checkout, d);
	} catch (error) {
		err(`${(error as Error).message}\n`);
		return 1;
	}
	out(`${JSON.stringify(closed)}\n`);
	return closed.closed && !closed.left.length && !closed.error && !(closed.reaped?.checkout && "error" in closed.reaped.checkout) ? 0 : 1;
}
