import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { classifyCwd, inodeOnDisk, readCwds, type Cwd } from "../procs/cwd.ts";
import { reap as realReap, type KillReport } from "../procs/kill.ts";
import { killSet, type Owned, type Place, type Protect } from "../procs/killset.ts";
import { readOwners } from "../procs/marker.ts";
import { baseName, descendants, isOrphan, readTable, refOf, sameProc, type Proc, type Ref } from "../procs/table.ts";
import { type Checkout, checkoutOf, physical, under } from "../procs/worktree.ts";
import { startOf } from "../startof.ts";
import { writeJson } from "./record.ts";

// The owner registry and the reaper of the server (docs/specs/2026-11-04-procs.md B, C; plan sb-procs-plan.md): a worker's pi says hello with its pid and start time, the worktree it works in, and its pane; every
// tick the server writes down the descendants of each live owner by (pid, start time); when an owner ends (bye, its pid gone or reused, or Herdr says its pane and terminal closed) what it left is killed by
// the kill sequence of src/procs/kill.ts: the snapshot, the processes that carry its marker, and the orphans that work in its worktree, minus the protected set. Records survive a server restart in
// `<slot dir>/procs/owners.json` (mode 600), so a worker that ended while the server was down is still reaped.
// Nothing here logs or returns a command line or an environment. Every signal goes through the kill sequence, and so through the test kill guard.

export const OWNERS_FILE = "owners.json";
export const TICK_MS = 10_000, SLOW_TICK_MS = 30_000, SLOW_AFTER_MS = 1000;
const ID = /^[A-Za-z0-9._-]{1,64}$/;
/** How many times a reap whose cwd rule was left out (Herdr's panes unknown) is tried again at a tick. */
export const DEFER_MAX = 3;
/** Programs that are never a worker's pi. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh"]);
/** The most descendants one owner's snapshot keeps. */
const SNAPSHOT_MAX = 2000;

/** What a worker's pi says about itself. */
export interface Hello { pid: number; started?: string; id?: string; subagentId?: string; /** "train": the pi of a train, an owner like a worker's (docs/specs/2026-11-07-train-workers.md §3.3). */ role?: "train"; sessionFile?: string; pane?: string; terminal?: string; cwd?: string }
export interface OwnerRecord {
	id: string; pid: number; started: string; roots: string[]; snapshot: Ref[]; subagentId?: string; role?: "train"; pane?: string; terminal?: string; cwd?: string; helloAt: number; seenAt: number;
	/** Set when the owner ends. `left`: the reap ran and something stayed alive, so the record stays for `reap`; without it the reap has not finished (a restart resumes it). */
	ended?: { at: number; reason: string; left?: boolean; /** The cwd rule was left out of the reap because the live panes were not known: tries so far; the next ticks try again until `DEFER_MAX`. */ retry?: number };
}
export interface PaneEvent { event: string; data: Record<string, unknown> }
export interface ProcsDeps {
	/** The folder of the slot (`slot.dir`); the registry keeps its files in `procs/` below it. */
	dir: string;
	now(): number;
	log(event: string, facts: Record<string, number | string | boolean>): void;
	/** The process table now (the account's own processes); undefined where there is none. A failed read throws. */
	read?: () => Promise<Proc[] | undefined>;
	cwds?: (pids: readonly number[]) => Promise<Map<number, Cwd>>;
	markers?: (pids: readonly number[]) => Promise<Map<number, string>>;
	inode?: (path: string) => string | null;
	checkout?: (cwd: string) => Checkout;
	/** The start time of a pid now (the identity of an owner). */
	startOf?: (pid: number) => string | undefined;
	/** What is never signalled besides the other live owners: the Herdr server, live panes' shells and foregrounds, sb servers, the intercom broker. Read at each reap. */
	protect?: (table: readonly Proc[]) => Promise<Protect[]>;
	/** The panes Herdr lists now with their terminal and working folder: how a pane event without a terminal is told from a reused id, and which linked worktrees a live session (not an owner) works in. Throwing means unknown. */
	panes?: () => Promise<{ pane_id: string; terminal_id?: string; cwd?: string; workspace_id?: string }[]>;
	/** The workspaces of Herdr that are linked worktrees, with their checkout folder (a pane that closes in one with no owner gets the cwd rule). Throwing means unknown. */
	workspaces?: () => Promise<{ workspace_id: string; checkout_path: string }[]>;
	/** The physical path of a folder (symlinks resolved), and whether it is there. */
	real?: (path: string) => string;
	exists?: (path: string) => boolean;
	/** The kill sequence. */
	reap?: (refs: readonly Ref[]) => Promise<KillReport>;
	/** Pids that must outlive any reap: this server. */
	self?: number[];
	/** Gets the table of each tick (the stall watch, stallwatch.ts): it runs behind the tick, which never waits for it. */
	watch?: (table: readonly Proc[]) => Promise<void>;
	ownUid?: number;
	platform?: NodeJS.Platform;
}
export interface ReapResult { owner: string; reason: string; targets: number; termed: number; killed: number; skipped: number; left: { pid: number; program: string }[]; spared: number; /** The cwd rule was left out: the live panes of Herdr were not known, so the reap did not risk a session's orphans. */ deferred?: boolean }
export interface OwnerRow { id: string; pid: number; started: string; live: boolean; roots: string[]; snapshot: number; pane?: string; subagentId?: string; role?: "train"; endedReason?: string }
export interface Procs {
	/** Loads the records, reaps the owners that ended while the server was down, and takes the first tick (its cost is logged once). */
	start(): Promise<void>;
	hello(hello: Hello): Promise<{ id: string }>;
	beat(id: string): boolean;
	/** The owner says it is leaving: it ends now and its reap runs behind this call (`settled()` waits for it). */
	bye(id: string): boolean;
	tick(): Promise<void>;
	/** A Herdr pane event (`pane.exited`, `pane.closed`); anything else is ignored. */
	paneEvent(event: PaneEvent): Promise<void>;
	list(): OwnerRow[];
	reapOwner(id: string): Promise<ReapResult>;
	/** Reaps what is left in a checkout; refuses while a live owner works there. */
	reapCheckout(path: string): Promise<ReapResult>;
	/** How long the next tick should wait: 10 s, or 30 s after a first tick that cost more than a second. */
	tickMs(): number;
	/** Resolves once every reap started so far has finished. */
	settled(): Promise<void>;
}

export class ProcsRefusal extends Error {}

export function createProcs(d: ProcsDeps): Procs {
	const folder = join(d.dir, "procs"), file = join(folder, OWNERS_FILE);
	const read = d.read ?? (() => readTable()), cwdsOf = d.cwds ?? ((pids) => readCwds(pids)), markersOf = d.markers ?? ((pids) => readOwners(pids));
	const inode = d.inode ?? inodeOnDisk, checkout = d.checkout ?? checkoutOf, probe = d.startOf ?? startOf, reap = d.reap ?? ((refs) => realReap(refs));
	const platform = d.platform ?? process.platform, self = d.self ?? [process.pid], real = d.real ?? physical, exists = d.exists ?? existsSync;
	const owners = new Map<string, OwnerRecord>();
	const pending = new Set<Promise<unknown>>();
	/** The linked worktrees of Herdr's workspaces as the last look saw them: a workspace that closes with its last pane is gone from the next list. */
	const linked = new Map<string, string>();
	/** The roots a pane-close reap is running for, so the pane.exited and pane.closed of one pane do not run it twice. */
	const busy = new Set<string>();
	/** The ended owners whose reap is running now. */
	const running = new Set<OwnerRecord>();
	let tickEvery = TICK_MS, ticking: Promise<void> | undefined;

	// A write that fails (no space, the folder gone) is one log line: the registry goes on in memory, and nothing of the server depends on this file.
	const save = () => {
		try {
			mkdirSync(folder, { recursive: true, mode: 0o700 });
			writeJson(file, { v: 1, owners: [...owners.values()] });
		} catch (error) {
			d.log("procs-error", { text: `owners.json was not written (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})` });
		}
	};
	const load = () => {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as { owners?: unknown };
			for (const r of Array.isArray(parsed.owners) ? parsed.owners : []) {
				const o = r as Partial<OwnerRecord>;
				if (typeof o?.id === "string" && ID.test(o.id) && Number.isSafeInteger(o.pid) && typeof o.started === "string" && Array.isArray(o.roots) && Array.isArray(o.snapshot)) {
					owners.set(o.id, { ...(o as OwnerRecord), snapshot: o.snapshot.filter((s: Ref) => Number.isSafeInteger(s?.pid) && typeof s?.started === "string") });
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // none yet: the next hello makes the file
			// A file that is there but does not parse is kept aside (the next save would overwrite every ended record in it) and said once.
			d.log("procs-error", { text: `owners.json is not readable (${(error as Error).name}); starting empty` });
			try { renameSync(file, `${file}.bad`); } catch { /* the save below replaces it */ }
		}
	};
	const owned = (r: OwnerRecord): Owned => ({ id: r.id, pid: r.pid, started: r.started, roots: r.roots, snapshot: r.snapshot });
	const alive = (table: readonly Proc[], r: Pick<OwnerRecord, "pid" | "started">) => table.some((p) => !p.zombie && sameProc(refOf(p), r));
	const rootsOf = (cwd: string | undefined): string[] => {
		// Only a linked worktree has roots: a worker in the parent checkout gets no cwd rule (a main's long-lived processes live there). The root is physical, as lsof reports a working folder.
		const c = cwd ? checkout(cwd) : undefined;
		return c?.kind === "linked" ? [c.root] : [];
	};
	const overlap = (a: string, b: string) => under(a, b) || under(b, a);

	/**
	 * The linked worktrees where a live pane of Herdr works that is not `subject`'s, and whether that is known. A pane without a folder is placed by its workspace's checkout; one that cannot be placed
	 * (no workspace, or the workspaces cannot be read) makes the answer unknown.
	 */
	async function heldRoots(subject: OwnerRecord): Promise<{ roots: string[]; unknown: boolean }> {
		if (!d.panes) return { roots: [], unknown: false };
		let panes: Awaited<ReturnType<NonNullable<ProcsDeps["panes"]>>> | undefined;
		try {
			panes = await d.panes();
		} catch { /* unknown */ }
		if (!Array.isArray(panes)) return { roots: [], unknown: true };
		const roots: string[] = [];
		let unknown = false, looked: boolean | undefined;
		for (const p of panes) {
			if (p.pane_id === subject.pane) continue;
			if (p.cwd) {
				roots.push(...rootsOf(p.cwd));
				continue;
			}
			if (!p.workspace_id) {
				unknown = true;
				continue;
			}
			looked ??= await lookAtWorkspaces();
			const place = linked.get(p.workspace_id);
			if (place) roots.push(...rootsOf(place));
			else if (!looked) unknown = true;
		}
		return { roots, unknown };
	}
	/**
	 * A hello is a pi's word about itself, and its snapshot later becomes a kill list: so a pid that is the Herdr server, a pane's shell, this server, an sb server or the intercom broker, a shell, or a process that has
	 * Herdr or a pane's shell below it (a terminal app, tmux) is refused. A pane's foreground is not on this list: the worker's pi is that.
	 */
	async function refuseProtected(pid: number, table: readonly Proc[], pane?: string): Promise<void> {
		const proc = table.find((p) => p.pid === pid && !p.zombie);
		if (!proc) return;
		const no = (what: string) => new ProcsRefusal(`procs-hello: pid ${pid} is ${what}, not a pi`);
		if (SHELLS.has(baseName(proc.comm).replace(/^-/, ""))) throw no("a shell");
		if (self.includes(pid)) throw no("this server");
		const all = (await d.protect?.(table)) ?? [];
		const named = all.filter((p) => p.why !== "pane-foreground");
		const hit = named.find((p) => p.pid === pid && (p.started === undefined || p.started === proc.started));
		if (hit) throw no(`protected (${hit.why})`);
		// The foreground of another pane than the one the hello names is that pane's pi.
		if (pane && all.some((p) => p.why === "pane-foreground" && p.pid === pid && p.pane !== undefined && p.pane !== pane)) throw no("the foreground of another pane");
		const below = new Set(descendants(table, [pid]).map((p) => p.pid));
		const shells = new Set(named.filter((p) => p.why === "pane").map((p) => p.pid));
		// A `herdr` CLI call below a worker's pi is no Herdr server: only a herdr with a pane's shell below it is (or any herdr when Herdr listed no pane).
		const server = (p: Protect) => p.why === "herdr" && (shells.size === 0 || descendants(table, [p.pid]).some((c) => shells.has(c.pid)));
		if (named.some((p) => (server(p) || p.why === "pane") && below.has(p.pid))) throw no("above Herdr or a pane's shell");
	}
	/** The kill set of one owner on a fresh table, and the kill sequence over it. */
	async function reapSet(subject: OwnerRecord, reason: string, explicit = false): Promise<ReapResult> {
		const table = await read();
		if (!table) throw new Error("the process table could not be read; nothing was signalled");
		// By record, not by id: a new hello under the id of the ended owner is a live owner this reap must spare.
		const live = [...owners.values()].filter((o) => !o.ended && o !== subject && alive(table, o)).map(owned);
		// The linked worktrees where a pane works that is no owner's (a main, Claude Code, Codex): the cwd rule keeps out of them. An explicit `reap --checkout` is the caller's word and skips this. When the panes are not
		// known (Herdr does not answer, a pane's place cannot be told) the cwd rule is left out of this reap: unknown is not "no session there".
		const { roots: held, unknown } = explicit || !subject.roots.length ? { roots: [], unknown: false } : await heldRoots(subject);
		if (unknown) d.log("procs-held-unknown", { owner: subject.id, reason });
		const owner = unknown ? { ...owned(subject), roots: [] } : owned(subject);
		const orphans = owner.roots.length ? table.filter((p) => !p.zombie && isOrphan(p, reapersOf(table))) : [];
		const found = await cwdsOf(orphans.map((p) => p.pid));
		const places = new Map<number, Place>();
		for (const [pid, cwd] of found) places.set(pid, { path: cwd.path, removed: classifyCwd(cwd, inode(cwd.path)) === "removed" });
		const markers = await markersOf(table.filter((p) => !p.zombie).map((p) => p.pid));
		const protect = (await d.protect?.(table)) ?? [];
		const { targets, spared } = killSet({ owner, live, table, places, markers, protect, reapers: reapersOf(table), self, held, ...(d.ownUid !== undefined ? { ownUid: d.ownUid } : {}) });
		const report: KillReport = targets.length ? await reap(targets.map((t) => refOf(t.proc))) : { termed: 0, killed: 0, skipped: 0, groups: 0, left: [] };
		const result: ReapResult = { owner: subject.id, reason, targets: targets.length, termed: report.termed, killed: report.killed, skipped: report.skipped, left: report.left, spared: spared.length, ...(unknown ? { deferred: true } : {}) };
		d.log("procs-reaped", { owner: subject.id, reason, targets: targets.length, termed: report.termed, killed: report.killed, left: report.left.length, protected: spared.length, ...(unknown ? { deferred: true } : {}) });
		return result;
	}
	/** The user's `systemd --user` adopts orphans on Linux (a subreaper): a process named systemd whose parent is init. */
	const reapersOf = (table: readonly Proc[]) => (platform === "linux" ? table.filter((p) => p.ppid === 1 && baseName(p.comm) === "systemd").map((p) => p.pid) : []);

	/** The owner ends: its record is closed and its reap runs; a record with something left alive stays marked `ended` for a later `reap`. */
	function end(record: OwnerRecord, reason: string): Promise<void> {
		if (record.ended) return Promise.resolve();
		record.ended = { at: d.now(), reason };
		save();
		d.log("procs-owner-ended", { owner: record.id, reason, pid: record.pid });
		return reapEnded(record, reason);
	}
	/** The reap of an ended owner. What it does to the registry is keyed by the record: the id may belong to a newer owner by the time a slow reap ends. */
	function reapEnded(record: OwnerRecord, reason: string): Promise<void> {
		running.add(record);
		const work = reapSet(record, reason).then(
			(result) => {
				const current = owners.get(record.id) === record;
				if (result.left.length) {
					d.log("procs-left", { owner: record.id, count: result.left.length, programs: result.left.map((l) => l.program).slice(0, 5).join(",") });
					record.snapshot = [];
					if (record.ended) record.ended.left = true;
				} else if (result.deferred) {
					// The snapshot and marker rules ran; the cwd rule waits for the panes to be known. The record stays for the next ticks, and then for `reap`.
					if (record.ended) {
						record.ended.retry = (record.ended.retry ?? 0) + 1;
						if (record.ended.retry >= DEFER_MAX) (record.ended.left = true, d.log("procs-error", { owner: record.id, text: "the live panes of Herdr stayed unknown; orphans in its worktree are left for procs reap" }));
					}
				} else if (current) owners.delete(record.id);
				if (current) save();
			},
			(error: Error) => {
				// The reap could not run (no table): the record stays, `ended`, and the next tick or a `reap` tries again.
				d.log("procs-error", { owner: record.id, text: error.message.slice(0, 200) });
				record.ended = { at: d.now(), reason: `${reason}; reap failed` };
				if (owners.get(record.id) === record) save();
			},
		).finally(() => void running.delete(record));
		pending.add(work);
		work.finally(() => pending.delete(work)).catch(() => undefined);
		return work;
	}
	/** A pane closed in a linked worktree with no owner: the orphans that work in the checkout (and what they started) are killed, unless a live owner or pane works there too. */
	async function reapWorkspace(ws: string | undefined, pane: string, reason: string): Promise<void> {
		// The workspace is looked at on every such event: Herdr may reuse an id, and a workspace that closed with its pane is gone from the list (its last known place is then the one).
		const before = ws ? linked.get(ws) : undefined;
		if (ws) await lookAtWorkspaces();
		const root = ws ? rootsOf((ws ? linked.get(ws) : undefined) ?? before)[0] : undefined;
		if (!root || busy.has(root)) return;
		busy.add(root);
		// The id is outside what an owner may be called, so the marker rule never matches a process that carries a name like it.
		const subject: OwnerRecord = { id: `(pane ${pane})`.slice(0, 64), pid: -1, started: "", roots: [root], snapshot: [], pane, helloAt: d.now(), seenAt: d.now() };
		const work = reapSet(subject, reason).then((result) => void (result.deferred && d.log("procs-error", { owner: subject.id, text: "the live panes of Herdr are unknown; orphans in the worktree are left for procs reap" })), (error: Error) => d.log("procs-error", { owner: subject.id, text: error.message.slice(0, 200) })).finally(() => void busy.delete(root));
		pending.add(work);
		work.finally(() => pending.delete(work)).catch(() => undefined);
		await work;
	}
	/** Whether Herdr's workspaces were read; the map keeps its last state when they were not. */
	const lookAtWorkspaces = async (): Promise<boolean> => {
		const found = await d.workspaces?.().catch(() => undefined);
		if (!found) return false;
		linked.clear();
		for (const w of found) linked.set(w.workspace_id, w.checkout_path);
		return true;
	};

	async function takeTick(): Promise<void> {
		const table = await read();
		if (!table) return;
		void d.watch?.(table).catch((error: Error) => d.log("procs-error", { text: `the tick's watch failed: ${String(error?.message).slice(0, 160)}` }));
		await lookAtWorkspaces();
		let changed = false;
		for (const r of [...owners.values()]) {
			if (r.ended) continue;
			if (!alive(table, r)) {
				void end(r, "pid gone");
				continue;
			}
			// What the owner has started: everything below it now, plus what an earlier tick saw that is still alive with the same identity (it may have been adopted by init since).
			const below = descendants(table, [r.pid]).filter((p) => !p.zombie).map(refOf);
			const kept = r.snapshot.filter((s) => table.some((p) => !p.zombie && sameProc(refOf(p), s)) && !below.some((b) => sameProc(b, s)));
			// The adopted orphans (kept) go first: they are what the snapshot exists for, and the cap drops the tail.
			const next = [...kept, ...below].slice(0, SNAPSHOT_MAX);
			if (next.length !== r.snapshot.length || next.some((s, i) => !sameProc(s, r.snapshot[i] ?? { pid: -1, started: "" }))) (r.snapshot = next, changed = true);
			r.seenAt = d.now();
		}
		// An owner whose reap could not run (no table) is tried again, and so is one whose cwd rule was left out because Herdr's panes were not known.
		for (const r of owners.values()) {
			if (r.ended?.reason.endsWith("; reap failed")) {
				const reason = r.ended.reason.slice(0, -"; reap failed".length);
				r.ended = undefined;
				void end(r, reason);
			} else if (r.ended && r.ended.retry !== undefined && !r.ended.left && !running.has(r)) void reapEnded(r, r.ended.reason);
		}
		if (changed) save();
	}

	return {
		async start() {
			load();
			const table = await read();
			for (const r of [...owners.values()]) {
				// A reap that a restart cut off (the record is ended but not finished) is run again; one that left something stays for `reap`.
				if (r.ended) {
					if (!r.ended.left && r.ended.retry === undefined && !r.ended.reason.endsWith("; reap failed")) void reapEnded(r, r.ended.reason);
					continue;
				}
				if (table && !alive(table, r)) void end(r, "gone while the server was down");
			}
			d.log("procs-start", { owners: owners.size });
			const began = d.now();
			await takeTick();
			const cost = d.now() - began;
			if (cost > SLOW_AFTER_MS) tickEvery = SLOW_TICK_MS;
			d.log("procs-tick-cost", { ms: cost, owners: owners.size, procs: table?.length ?? 0, everyMs: tickEvery });
		},
		async hello(h) {
			if (!Number.isSafeInteger(h.pid) || h.pid <= 1) throw new ProcsRefusal("procs-hello needs the pid of the pi");
			const id = h.id ?? `p${h.pid}`;
			if (!ID.test(id)) throw new ProcsRefusal("procs-hello: the owner id is 1 to 64 letters, digits, and . _ -");
			// The pid must be a process of this account that has the start time the pi gave (or, without one, the one it has now). Where there is no table (Windows) the start time is asked of the pid.
			const table = await read();
			const started = table ? table.find((p) => p.pid === h.pid && !p.zombie)?.started : probe(h.pid);
			if (!started || (h.started !== undefined && h.started !== started)) throw new ProcsRefusal("procs-hello: that pid is not a process of this account with that start time");
			if (table) await refuseProtected(h.pid, table, h.pane);
			const known = owners.get(id);
			if (known && !known.ended && (known.pid !== h.pid || known.started !== started)) {
				// Another pi under the id of a live one: an id collision (a nested pi inherits its parent's subagent id) must not end the live owner and kill its tree.
				if (table ? alive(table, known) : probe(known.pid) === known.started) throw new ProcsRefusal(`procs-hello: the owner id ${id} is in use by pid ${known.pid}; an id needs the pid or the session in it`);
				void end(known, "replaced by a new hello");
			}
			const cwd = typeof h.cwd === "string" && h.cwd.length <= 4096 ? h.cwd : undefined;
			const text = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
			const keep = known && !known.ended && known.pid === h.pid && known.started === started ? known : undefined;
			const record: OwnerRecord = {
				id, pid: h.pid, started, roots: rootsOf(cwd), snapshot: keep?.snapshot ?? [], helloAt: keep?.helloAt ?? d.now(), seenAt: d.now(),
				...(text(h.subagentId) ? { subagentId: text(h.subagentId)! } : {}), ...(h.role === "train" ? { role: "train" as const } : {}), ...(text(h.pane) ? { pane: text(h.pane)! } : {}), ...(text(h.terminal) ? { terminal: text(h.terminal)! } : {}), ...(cwd ? { cwd } : {}),
			};
			owners.set(id, record);
			save();
			d.log("procs-hello", { owner: id, pid: h.pid, worktree: record.roots.length > 0 });
			return { id };
		},
		beat(id) {
			const r = owners.get(id);
			if (!r || r.ended) return false;
			r.seenAt = d.now();
			return true;
		},
		bye(id) {
			const r = owners.get(id);
			if (!r || r.ended) return false;
			void end(r, "bye");
			return true;
		},
		async tick() {
			// One tick at a time: a slow table read never stacks a second one behind it.
			if (ticking) return ticking;
			ticking = takeTick().finally(() => void (ticking = undefined));
			return ticking;
		},
		async paneEvent(raw) { const event = { ...raw, event: raw.event.replace("_", ".") }; // Herdr 0.9.5 puts `pane_exited` and `pane_closed` on the wire (T4 replay), though the subscription asks for the dotted names; the log keeps the dotted ones
			if (event.event !== "pane.exited" && event.event !== "pane.closed") return;
			const pane = typeof event.data.pane_id === "string" ? event.data.pane_id : undefined, terminal = typeof event.data.terminal_id === "string" ? event.data.terminal_id : undefined;
			if (!pane) return;
			let theirs = false;
			for (const r of [...owners.values()]) {
				if (r.pane !== pane) continue;
				// A pane id is reused by Herdr: the event is the owner's only when it names the owner's terminal, or (without one) when the owner's terminal is no longer the one in that pane.
				if (terminal !== undefined && r.terminal !== undefined && terminal !== r.terminal) continue;
				if (terminal === undefined && r.terminal !== undefined) {
					const now = await d.panes?.().catch(() => undefined);
					const same = now?.find((p) => p.pane_id === pane);
					if (!now || (same && (same.terminal_id === undefined || same.terminal_id === r.terminal))) continue;
				}
				theirs = true;
				if (!r.ended) void end(r, event.event);
			}
			// No owner of this pane: an agent that is not pi closed it. In a linked worktree it gets the cwd-orphan rule alone.
			const ws = typeof event.data.workspace_id === "string" ? event.data.workspace_id : typeof (event.data.pane as { workspace_id?: unknown } | undefined)?.workspace_id === "string" ? (event.data.pane as { workspace_id: string }).workspace_id : undefined;
			if (!theirs) await reapWorkspace(ws, pane, event.event);
		},
		list() {
			return [...owners.values()].map((r) => ({ id: r.id, pid: r.pid, started: r.started, live: !r.ended, roots: r.roots, snapshot: r.snapshot.length, ...(r.pane ? { pane: r.pane } : {}), ...(r.subagentId ? { subagentId: r.subagentId } : {}), ...(r.role ? { role: r.role } : {}), ...(r.ended ? { endedReason: r.ended.reason } : {}) }));
		},
		async reapOwner(id) {
			const r = owners.get(id);
			if (!r) throw new ProcsRefusal(`no owner ${id}`);
			if (!r.ended) {
				const table = await read();
				if (table && alive(table, r)) throw new ProcsRefusal(`owner ${id} (pid ${r.pid}) is alive; reap works on an owner that has ended`);
			}
			// Not explicit: an owner is named, not a checkout, and its caller does not know whether a session works in that root now.
			const result = await reapSet(r, "reap");
			if (!result.left.length && !result.deferred && owners.get(id) === r) (owners.delete(id), save());
			return result;
		},
		async reapCheckout(path) {
			// Only a linked worktree, or a checkout that is gone and was a known owner's, is reaped: never `/`, a home folder, a main checkout, or a folder above checkouts.
			const physicalPath = real(path), table = await read();
			const holders = (where: string) => [...owners.values()].filter((r) => !r.ended && table && alive(table, r) && r.roots.some((root) => overlap(where, root)));
			let root: string | undefined;
			if (exists(physicalPath)) {
				const c = checkout(physicalPath);
				if (c.kind !== "linked") throw new ProcsRefusal(`${path} is ${c.kind === "none" ? "in no checkout" : `in a ${c.kind} checkout`}: reap --checkout takes a linked worktree (or a removed one a worker was known to work in)`);
				root = c.root;
			} else {
				root = [...owners.values()].flatMap((r) => r.roots).filter((known) => under(physicalPath, known)).sort((a, b) => b.length - a.length)[0];
				if (!root) throw new ProcsRefusal(`${path} is gone and no known worker worked in it: reap --checkout takes a linked worktree (or a removed one a worker was known to work in)`);
			}
			const live = [...holders(physicalPath), ...holders(root)];
			if (live.length) throw new ProcsRefusal(`a live owner works in ${path}: ${[...new Set(live)].map((h) => `${h.id} (pid ${h.pid})`).join(", ")}`);
			const known = [...owners.values()].find((r) => r.roots.some((r2) => r2 === root));
			const subject: OwnerRecord = known ?? { id: "(checkout)", pid: -1, started: "", roots: [root], snapshot: [], helloAt: d.now(), seenAt: d.now() };
			const result = await reapSet(subject, "reap", true);
			if (known && !result.left.length && owners.get(known.id) === known) (owners.delete(known.id), save());
			return result;
		},
		tickMs: () => tickEvery,
		settled: async () => void (await Promise.allSettled([...pending])),
	};
}

/** The pids (with the start time the record gives, when it has one) of the sb servers that `server.json` files under a state folder name (this slot's and the secondary slots'). */
export function serverPids(stateDir: string): { pid: number; started?: string }[] {
	const files = [join(stateDir, "server.json")];
	try {
		for (const hash of readdirSync(join(stateDir, "servers"))) files.push(join(stateDir, "servers", hash, "server.json"));
	} catch { /* no secondary slots */ }
	const found: { pid: number; started?: string }[] = [];
	for (const f of files) {
		try {
			const { pid, started } = JSON.parse(readFileSync(f, "utf8")) as { pid?: unknown; started?: unknown };
			if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1) found.push({ pid, ...(typeof started === "string" && started ? { started } : {}) });
		} catch { /* none, or not a record */ }
	}
	return found;
}

export interface ProtectSources {
	/** `herdr` CLI/API runner (a pane list and each pane's process-info). */
	run?: (args: string[]) => Promise<string>;
	stateDir: string;
	/** The folder of pi's agent state: the intercom broker's pid file is `<agentDir>/intercom/broker.pid`. */
	agentDir: string;
	self: number;
}
/**
 * The protected set (plan C): the Herdr server, every live pane's shell and foreground, the sb servers named in a `server.json` (with what they started), the intercom broker, and this server.
 * Read at each reap, not each tick. A source that cannot be read protects nothing it would have named: the reap then rests on the kill set's own rules (a pane's pi is a live owner, spared as one).
 */
export async function protectedSet(table: readonly Proc[], { run, stateDir, agentDir, self }: ProtectSources): Promise<Protect[]> {
	const out: Protect[] = [{ pid: self, why: "sb-server", tree: true }];
	for (const p of table) if (baseName(p.comm) === "herdr") out.push({ pid: p.pid, started: p.started, why: "herdr" });
	// The start time the record names limits the protection to that process: a pid reused since is not spared.
	for (const server of serverPids(stateDir)) out.push({ ...server, why: "sb-server", tree: true });
	try {
		const pid = Number(readFileSync(join(agentDir, "intercom", "broker.pid"), "utf8").trim());
		if (Number.isSafeInteger(pid) && pid > 1) out.push({ pid, why: "intercom-broker", tree: true });
	} catch { /* no broker */ }
	if (run) {
		try {
			const listed = (JSON.parse(await run(["pane", "list"])) as { result?: { panes?: { pane_id: string }[] } }).result?.panes ?? [];
			for (const pane of listed) {
				try {
					const info = (JSON.parse(await run(["pane", "process-info", "--pane", pane.pane_id])) as { result?: { process_info?: { shell_pid?: number; foreground_processes?: { pid?: number }[] } } }).result?.process_info;
					// The shell and the foreground are told apart: a worker's pi is its pane's foreground, and a hello may not name a shell.
					if (typeof info?.shell_pid === "number" && info.shell_pid > 1) out.push({ pid: info.shell_pid, why: "pane" });
					for (const f of info?.foreground_processes ?? []) if (typeof f.pid === "number" && f.pid > 1) out.push({ pid: f.pid, why: "pane-foreground", pane: pane.pane_id });
				} catch { /* the pane closed meanwhile */ }
			}
		} catch { /* Herdr does not answer */ }
	}
	return out;
}
