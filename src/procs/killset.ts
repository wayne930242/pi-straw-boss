import { descendants, isOrphan, refOf, sameProc, type Proc, type Ref } from "./table.ts";
import { rootOfRemoved, under } from "./worktree.ts";

// What dies when an owner ends, and what never does. Pure: the caller gathers the table, the working folder and marker of each process, and the protected processes; this decides.
// Kill set = (the owner's snapshot descendants still alive with the same identity) ∪ (processes that carry its marker) ∪ (orphans with their cwd under its worktree root, or in a removed checkout last seen as that root),
// plus whatever those started that is still below them, minus the protected set.

/** A registered owner (a worker's pi): its identity, the worktree roots it worked in, and the descendants a tick last saw. */
export interface Owned { id: string; pid: number; started: string; roots: string[]; snapshot: Ref[] }
/** Where a process works: the path, and whether that folder is gone. */
export interface Place { path: string; removed: boolean }
/** A process that is never signalled: the Herdr server, a live pane's shell or foreground, an sb server, the intercom broker. `tree` spares what it started too. `started` limits it to that process (a reused pid is not spared). */
export interface Protect { pid: number; started?: string; why: string; tree?: boolean; /** The pane a `pane-foreground` entry is the foreground of. */ pane?: string }

export interface KillInput {
	owner: Owned;
	/** The other live registered owners. */
	live: readonly Owned[];
	table: readonly Proc[];
	places: ReadonlyMap<number, Place>;
	/** The owner id each process carries. */
	markers: ReadonlyMap<number, string>;
	protect: readonly Protect[];
	/** Pids that adopt orphans besides pid 1 (the user's `systemd --user` on Linux). */
	reapers: readonly number[];
	/** This process and whatever must outlive it. */
	self: readonly number[];
	/** Roots of linked worktrees where a live session works that is not a registered owner (a pane of a main, Claude Code, Codex): the cwd rule does not reach into them. */
	held?: readonly string[];
	/** Only this account's processes can be targets; the table is already limited to it, this is the second check. */
	ownUid?: number;
	/** `placed`: a target's child is a target only when it works in the owner's roots itself, and the walk stops at one that does not (a pane close's checkout reap, which takes only what shows that root). Default `all`. */
	children?: "all" | "placed";
}
export type Why = "snapshot" | "marker" | "cwd" | "child";
export interface Target { proc: Proc; why: Why }
export interface Spared { proc: Proc; why: string }
export interface Decision { targets: Target[]; spared: Spared[] }

const overlaps = (a: string, b: string) => under(a, b) || under(b, a);

export function killSet({ owner, live, table, places, markers, protect, reapers, self, held = [], ownUid, children = "all" }: KillInput): Decision {
	const byPid = new Map(table.map((p) => [p.pid, p]));
	// The protected set first: what it holds is never reached, neither as a candidate nor through a parent link.
	const spare = new Map<number, string>();
	const hold = (p: Proc | undefined, why: string) => p && !spare.has(p.pid) && spare.set(p.pid, why);
	hold(byPid.get(1), "init");
	for (const pid of self) hold(byPid.get(pid), "self");
	for (const r of reapers) hold(byPid.get(r), "reaper");
	for (const p of protect) {
		const proc = byPid.get(p.pid);
		if (!proc || (p.started !== undefined && p.started !== proc.started)) continue;
		hold(proc, p.why);
		if (p.tree) for (const kid of descendants(table, [p.pid])) hold(kid, p.why);
	}
	for (const other of live) {
		const proc = byPid.get(other.pid);
		if (proc && proc.started === other.started) {
			hold(proc, "live-owner");
			for (const kid of descendants(table, [other.pid])) hold(kid, "live-owner");
		}
		for (const ref of other.snapshot) {
			const alive = byPid.get(ref.pid);
			if (alive && sameProc(refOf(alive), ref) && !alive.zombie) hold(alive, "live-owner");
		}
	}
	const liveIds = new Set(live.map((o) => o.id));
	for (const p of table) {
		const marker = markers.get(p.pid);
		// Also the owner's own id when a live owner has taken it (a new hello under the same id): the marker no longer tells the two apart.
		if (marker !== undefined && liveIds.has(marker)) hold(p, "live-owner");
	}
	// The cwd rule does not reach into a root that a live owner, or a live session that is not an owner, works in as well: its orphans there are that side's.
	const others = [...live.flatMap((o) => o.roots), ...held];
	const roots = owner.roots.filter((root) => !others.some((other) => overlaps(root, other)));
	const inRoot = (place: Place) => (place.removed ? rootOfRemoved(place.path, roots) !== undefined : roots.some((root) => under(place.path, root)));

	const why = new Map<number, Why>();
	const add = (p: Proc | undefined, reason: Why) => {
		if (!p || p.zombie || why.has(p.pid) || (ownUid !== undefined && p.uid !== ownUid)) return;
		if (spare.has(p.pid)) return;
		why.set(p.pid, reason);
	};
	for (const ref of owner.snapshot) {
		const p = byPid.get(ref.pid);
		if (p && sameProc(refOf(p), ref)) add(p, "snapshot");
	}
	for (const p of table) if (markers.get(p.pid) === owner.id) add(p, "marker");
	for (const p of table) {
		const place = places.get(p.pid);
		if (!place || !isOrphan(p, reapers)) continue;
		if (inRoot(place)) add(p, "cwd");
	}
	// What the targets started and still run, down the parent links, never through a spared process.
	const kids = new Map<number, Proc[]>();
	for (const p of table) if (p.pid !== p.ppid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
	const walked = new Set<number>();
	const walk = (pid: number) => {
		for (const kid of kids.get(pid) ?? []) {
			if (walked.has(kid.pid) || spare.has(kid.pid)) continue;
			if (children === "placed" && !((place) => place && inRoot(place))(places.get(kid.pid))) continue;
			walked.add(kid.pid);
			add(kid, "child");
			walk(kid.pid);
		}
	};
	for (const pid of [...why.keys()]) walk(pid);

	const targets = [...why].sort(([a], [b]) => a - b).map(([pid, reason]) => ({ proc: byPid.get(pid)!, why: reason }));
	// A spared process is reported when something would otherwise have reached it: a candidate by identity, marker, or place, or a child of a target.
	const reached = new Set<number>();
	for (const ref of owner.snapshot) reached.add(ref.pid);
	for (const p of table) {
		if (markers.get(p.pid) === owner.id) reached.add(p.pid);
		const place = places.get(p.pid);
		if (place && isOrphan(p, reapers) && inRoot(place)) reached.add(p.pid);
		if (why.has(p.ppid)) reached.add(p.pid);
	}
	const spared = [...spare].filter(([pid]) => reached.has(pid)).sort(([a], [b]) => a - b).map(([pid, reason]) => ({ proc: byPid.get(pid)!, why: reason }));
	return { targets, spared };
}
