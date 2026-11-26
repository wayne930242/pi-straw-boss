import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { notBare, refusal, revivingAt } from "../deadpane.ts";
import { herdrSocket } from "../endpoint.ts";
import { type HerdrRun, type Pane, panes, result } from "../herdr.ts";
import { type Cwd, readCwds } from "../procs/cwd.ts";
import { type KillReport, probeStart, reap as realReap } from "../procs/kill.ts";
import { killSet, type Protect } from "../procs/killset.ts";
import { baseName, descendants, named, programOf, type Proc, readTable, type Ref, refOf, sameProc } from "../procs/table.ts";
import { type Checkout, checkoutOf, physical, under } from "../procs/worktree.ts";
import type { Ctx } from "./client.ts";
import { protectedSet } from "./procs.ts";
import { askProcs, type Asked } from "./procscli.ts";

// `cli.mjs pane close <pane> [--checkout <root>] [--force]` (docs/how-it-works.md#a-checked-pane-close): a pane close that is checked. `herdr pane close` can answer ok and leave the pane listed, and a pane it closes
// runs no session_shutdown, so what its pi started (a monitor, a poll loop) goes on, adopted by init, and holds the checkout. Kept out of cli.ts, which carries a line budget.
// Before anything is closed: the close is authorized by the table of deadpane.ts (the pane is in the caller's workspace, an agent's, at a bare shell, not opening or reviving) unless the operator says `--force`;
// `--checkout` must be the root of a linked worktree; and the pane's tree is read from its shell, whose identity (pid and start time) is read between two process-info answers that name the same shell. The target is
// bound to the Herdr socket, its workspace, its terminal and that shell, and checked again before each retry. Once the pane is gone, its tree goes through the kill sequence one verified pid at a time (no group
// signal), and the checkout through the sb server's bounded `procs reap --checkout`, which spares this command and what it runs under; what survives either reap, a process of the tree, or one that works in the checkout is `left`.
// Exit codes: 0 the pane is gone and nothing is left; 1 the pane is still listed, something is left, or a step failed (the JSON on stdout says which, or one line on stderr when nothing was closed); 2 usage.

/** Closes tried while the pane stays listed, and the looks after each close (LOOKS of them, LOOK_MS apart: 2 s per close). */
export const ATTEMPTS = 3, LOOKS = 4, LOOK_MS = 500;
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "nu", "elvish", "xonsh"]);

export interface PaneDeps {
	run: HerdrRun;
	sleep(ms: number): Promise<void>;
	now(): number;
	/** The account's processes now; undefined where there is no table (Windows). A failed read throws. */
	read(): Promise<Proc[] | undefined>;
	cwds(pids: readonly number[]): Promise<Map<number, Cwd>>;
	/** The start time of a pid now, undefined when it is gone. */
	probe(pid: number): string | undefined;
	/** What is never signalled: the Herdr server, live panes' shells and foregrounds, sb servers, the intercom broker (procs.ts `protectedSet`). */
	protect(table: readonly Proc[]): Promise<Protect[]>;
	/** The kill sequence (src/procs/kill.ts), with no group signal. */
	reap(refs: readonly Ref[]): Promise<KillReport>;
	/** The sb server's bounded checkout reap (`procs-reap-bounded`), which spares `caller` and what it runs under. */
	reapCheckout(root: string, caller: Ref): Promise<Asked>;
	/** Whether the running sb server is too old for that reap (asked before the close, with `--checkout`). */
	oldServer(): Promise<boolean>;
	/** The physical path of a folder, as lsof reports a working folder. */
	real(path: string): string;
	/** Which checkout a folder is in (procs/worktree.ts). */
	checkout(path: string): Checkout;
	/** Whether a tower holds the revive lock of the pane's session (deadpane.ts `revivingAt`). */
	reviving(pane: Pane): boolean;
	/** The Herdr socket every call of this command goes to. */
	socket: string;
	/** This process: never a target, and neither it nor what it runs under is ever `left`. */
	self: number;
	/** The pane this command runs in (`HERDR_PANE_ID`), which it never closes, and whose workspace is the one it may close in. */
	here?: string;
	uid?: number;
	platform: NodeJS.Platform;
}
export interface Left { pid: number; program: string; /** `tree`: started in the pane; `checkout`: works in `--checkout`, or the server's reap of it left it. */ where: "tree" | "checkout" }
export interface PaneClosed {
	pane: string;
	/** What was closed: the socket, workspace and terminal, and the pane's shell; a retry goes only to the same. */
	target: { socket: string; workspace?: string; terminal?: string; shell: Ref };
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
const refused = (why: string) => new Error(`${why}; nothing was closed`);

export async function closePane(pane: string, { checkout, force = false }: { checkout?: string; force?: boolean }, d: PaneDeps): Promise<PaneClosed> {
	if (d.platform === "win32") throw new Error("pane close reads the process table, which Windows does not give here: close the pane with herdr pane close and stop what it left by hand");
	if (pane === d.here) throw new Error(`this command runs in pane ${pane}, and does not close its own pane`);
	const all = await panes(d.run), target = all.find((p) => p.pane_id === pane);
	if (!target) throw refused(`no pane ${pane} in Herdr's list`);
	// The checkout is checked before the close: a reap of `/`, a home folder or a main checkout is refused by the server too, but only after the pane is gone (kit2-F003).
	const root = checkout === undefined ? undefined : d.real(checkout);
	if (root !== undefined && ((c) => c.kind !== "linked" || c.root !== root)(d.checkout(root))) throw refused(`${checkout} is not the root of a linked worktree: --checkout takes the root of the worktree the pane worked in`);
	if (root !== undefined && (await d.oldServer())) throw refused(OLD_SERVER_TEXT);
	// The close is the deadpane.ts table's to allow (kit2-F001): only the operator's --force closes a pane of another workspace, one whose pi or program runs, or one a tower is opening or reviving.
	const own = d.here ? all.find((p) => p.pane_id === d.here) : undefined;
	if (!force && !own?.workspace_id) throw refused("this command runs in no pane Herdr lists, so the workspace it may close panes in is not known (the boss closes it with --force)");
	const why = force ? undefined : refusal({ pane: target, query: pane, workspace: own!.workspace_id!, tower: { pane: own!.pane_id }, reviving: d.reviving(target) });
	if (why) throw refused(`${why} (--force, the boss's, closes it anyway)`);
	const info = async () => (await result(d.run, ["pane", "process-info", "--pane", pane]))?.process_info as Info | undefined;
	// The tree is read from the pane's shell, never from a bare foreground pid (kit2-F002): the shell is the same in the process-info answers before and after the table, so the row the table has for it is that shell.
	const first = await info().catch(() => undefined), table = await d.read(), second = await info().catch(() => undefined);
	if (!table) throw refused("the process table could not be read");
	const shellPid = first?.shell_pid, shell = table.find((p) => p.pid === shellPid && !p.zombie);
	if (typeof shellPid !== "number" || second?.shell_pid !== shellPid || !shell) throw refused(`the shell of pane ${pane} could not be verified (Herdr named ${typeof shellPid === "number" ? `pid ${shellPid}, ${shell ? "then another" : "which the process table does not have"}` : "none"}), so what it leaves could not be known`);
	if (!force) {
		const busy = notBare(pane, second) ?? (SHELLS.has(baseName(shell.comm).replace(/^-/, "")) ? undefined : `${pane} runs ${programOf(named(shell, { platform: d.platform }))} in place of a shell`);
		if (busy) throw refused(`${busy} (--force, the boss's, closes it anyway)`);
	}
	const mine = lineage(table, d.self), self = table.find((p) => p.pid === d.self);
	if (root !== undefined && !self) throw refused("this command is not in the process table, so the server could not spare it in the checkout's reap");
	const tree = [shell, ...descendants(table, [shell.pid])].filter((p) => !p.zombie && !mine.has(p.pid)).map(refOf);
	const out: PaneClosed = { pane, target: { socket: d.socket, ...(target.workspace_id ? { workspace: target.workspace_id } : {}), ...(target.terminal_id ? { terminal: target.terminal_id } : {}), shell: refOf(shell) }, closed: false, attempts: 0, noops: [], left: [] };
	// Where the pane is now: still the one read above (`ours`), gone, or its id names another terminal or workspace (`other`, which is ours gone). A list that cannot be read proves nothing.
	const where = async () => {
		const p = (await panes(d.run)).find((x) => x.pane_id === pane);
		return !p ? "gone" : p.workspace_id !== target.workspace_id || p.terminal_id !== target.terminal_id ? "other" : "ours";
	};
	while (!out.closed && out.attempts < ATTEMPTS) {
		if (out.attempts > 0) {
			// Before a retry the target is checked again: the same terminal in the same workspace, running the same shell (pid and start time).
			const now = await info().catch(() => undefined);
			if (now?.shell_pid !== shell.pid || d.probe(shell.pid) !== shell.started) {
				out.error = `pane ${pane} no longer runs the shell it ran (pid ${shell.pid}), so it was not closed again`;
				break;
			}
		}
		out.attempts++;
		// An error here may be a pane that went meanwhile: the list says.
		await d.run(["pane", "close", pane]).catch(() => undefined);
		for (let look = 0; look < LOOKS && !out.closed; look++) {
			await d.sleep(LOOK_MS);
			out.closed = (await where().catch(() => "ours")) !== "ours";
		}
		if (!out.closed) out.noops.push({ attempt: out.attempts, at: new Date(d.now()).toISOString(), foreground: ((await info().catch(() => undefined))?.foreground_processes ?? []).map((p) => String(p.name ?? p.argv0 ?? p.pid)) });
	}
	try {
		return await afterClose(out, tree, root && self ? { root, caller: refOf(self) } : undefined, d);
	} catch (error) {
		// What was closed stays said: a step that failed after the close is the result's `error`, not a lost answer.
		return { ...out, error: `${(error as Error).message}; what is left is not known` };
	}
}

/** This process and what it runs under, up the parent links. */
function lineage(table: readonly Proc[], self: number): Set<number> {
	const mine = new Set<number>();
	for (let p = table.find((x) => x.pid === self); p && p.pid > 1 && !mine.has(p.pid); p = table.find((x) => x.pid === p!.ppid)) mine.add(p.pid);
	return mine;
}

/** Once the closes are done: the reap of the pane's tree and of `--checkout` (only when the pane is gone), then what is `left`. */
async function afterClose(out: PaneClosed, tree: readonly Ref[], checkout: { root: string; caller: Ref } | undefined, d: PaneDeps): Promise<PaneClosed> {
	const leftOf = (table: readonly Proc[], where: Left["where"], keep: (p: Proc) => boolean) => {
		// This process and what it runs under (a shell, the session that ran it) are never `left`, wherever they work.
		const mine = lineage(table, d.self);
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
	const decision = killSet({ owner: { id: `(pane ${out.pane})`.slice(0, 64), pid: -1, started: "", roots: [], snapshot: [...tree] }, live: [], table: now, places: new Map(), markers: new Map(), protect: await d.protect(now), reapers, self: [...lineage(now, d.self), d.self], ...(d.uid !== undefined ? { ownUid: d.uid } : {}) });
	const report: KillReport = decision.targets.length ? await d.reap(decision.targets.map((t) => refOf(t.proc))) : { termed: 0, killed: 0, skipped: 0, groups: 0, left: [] };
	out.reaped = { tree: { targets: decision.targets.length, termed: report.termed, killed: report.killed, spared: decision.spared.length } };
	const survivors: { pid: number; where: Left["where"] }[] = report.left.map((l) => ({ pid: l.pid, where: "tree" }));
	if (checkout) {
		const asked = await d.reapCheckout(checkout.root, checkout.caller);
		out.reaped.checkout = asked.ok ? asked.reply : { error: asked.error };
		if (asked.ok && Array.isArray(asked.reply.left)) for (const l of asked.reply.left as { pid?: unknown }[]) if (typeof l?.pid === "number") survivors.push({ pid: l.pid, where: "checkout" });
	}
	const after = await d.read();
	if (!after) return { ...out, error: "the process table could not be read after the reap; what is left is not known" };
	// What a reap said it left, while a process of that pid still runs (kit2-F004): a child the tree started after its snapshot, or one the server's reap left, is no less left for working elsewhere.
	for (const where of ["tree", "checkout"] as const) leftOf(after, where, (p) => survivors.some((s) => s.pid === p.pid && s.where === where));
	leftOf(after, "tree", inTree);
	if (checkout) {
		const cwds = await d.cwds(after.filter((p) => !p.zombie).map((p) => p.pid));
		leftOf(after, "checkout", (p) => { const at = cwds.get(p.pid); return at !== undefined && under(d.real(at.path), checkout.root); });
	}
	return out;
}

type Ask = (request: { cmd: string } & Record<string, unknown>) => Promise<Asked>;
/** What a server older than the bounded reap answers: it runs nothing then, and never the unbounded `procs-reap` in its place (kit2-F003). */
const OLD_SERVER = "unknown command procs-reap-bounded";
export const OLD_SERVER_TEXT = "the running sb server has no bounded checkout reap (procs-reap-bounded), so it cannot reap the checkout for pane close: restart it with cli.mjs restart";
/** The server's bounded reap of a checkout; an old server's answer is said plainly. */
export async function askBounded(ask: Ask, root: string, caller: Ref): Promise<Asked> {
	const asked = await ask({ cmd: "procs-reap-bounded", checkout: root, caller });
	return !asked.ok && asked.error === OLD_SERVER ? { ok: false, error: `${OLD_SERVER_TEXT}; nothing in the checkout was signalled` } : asked;
}
/** Before the close: whether the running server lacks the bounded reap. The request carries no checkout, so a server that has it refuses it and runs nothing; no server at all is the reap's error later. */
export const serverLacksBounded = async (ask: Ask) => ((asked) => !asked.ok && asked.error === OLD_SERVER)(await ask({ cmd: "procs-reap-bounded" }));

export interface PaneIo { out(text: string): void; err(text: string): void; env: NodeJS.ProcessEnv; run: HerdrRun; over?: Partial<PaneDeps> }
export async function runPane(ctx: Ctx, flags: Record<string, string | true>, { out, err, env, run, over }: PaneIo): Promise<number> {
	const checkout = typeof flags.checkout === "string" ? resolve(flags.checkout) : undefined;
	const d: PaneDeps = {
		run, sleep: (ms) => ctx.sleep(ms), now: ctx.now, read: () => readTable(), cwds: (pids) => readCwds(pids), probe: probeStart, reap: (refs) => realReap(refs, { groups: false }), real: physical, checkout: (path) => checkoutOf(path),
		reviving: (p) => revivingAt(ctx.slot.stateDir, ctx.now(), p), socket: herdrSocket(env), self: process.pid, platform: ctx.platform,
		protect: (table) => protectedSet(table, { run: (args) => run(args), stateDir: ctx.slot.stateDir, agentDir: env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), self: process.pid }),
		reapCheckout: (root, caller) => askBounded((request) => askProcs(ctx, request), root, caller), oldServer: () => serverLacksBounded((request) => askProcs(ctx, request)), ...(env.HERDR_PANE_ID ? { here: env.HERDR_PANE_ID } : {}), ...(process.getuid ? { uid: process.getuid() } : {}), ...over,
	};
	let closed: PaneClosed;
	try {
		closed = await closePane(String(flags.pane), { ...(checkout !== undefined ? { checkout } : {}), force: flags.force === true }, d);
	} catch (error) {
		err(`${(error as Error).message}\n`);
		return 1;
	}
	out(`${JSON.stringify(closed)}\n`);
	return closed.closed && !closed.left.length && !closed.error && !(closed.reaped?.checkout && "error" in closed.reaped.checkout) ? 0 : 1;
}
