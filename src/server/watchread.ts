import { createHash, randomBytes } from "node:crypto";
import { GAP_MS } from "../activity.ts";
import type { Monitor } from "../monitors.ts";
import type { Base, Found, Net, Unit } from "../net.ts";
import { waitMessage } from "../train/waits.ts";
import type { YardTrainRow } from "../train/yardview.ts";
import type { Reply } from "./socket.ts";

// The sb server's `watch-read` route (docs/specs/2026-11-09-agent-kinds.md §10): a watchdog child's long poll on one unit of this computer's net. A request is held until a reading of the net gives a verdict other than `unchanged`, until its
// deadline, or until the hold's own timer (45 s, inside the control socket's 60 s idle close), which answers with the last reading and waits for no further one. A hold costs one compare per reading.
//
// What wakes a hold is state only: the unit's mark, each monitor's status and exit, todo progress, a train's steps and waits, the subagents' marks, and the unit leaving the net. Output lines, a monitor's last line, notes, ticks, and load
// readings wake nothing; they move the quiet clock, which gives `stalled` once per quiet spell when the request names `quietMs`. A monitor whose newest progress line carries a load over the limit gives `load` once per crossing.
//
// The stamp (`since`) is what was already told: this server instance, a hash of the waking facts, the move the last `stalled` was told for, and the monitors whose load was told. It is opaque to the client; one that does not parse, or is of
// another instance, is a mismatch and answers `changed` at once.
//
// The readings are the GUI host's (guihost.ts `watchNet`): it reads the net every 2 s or 10 s while it runs. While it gives none (a GUI stopped on purpose, or one that never started), the route reads the net itself every 10 s, only while a hold is open.

export const HOLD_MS = 45_000, READ_MS = 10_000;
/** A unit nobody asked about for this long is no longer followed; the next request starts its quiet clock afresh. */
const FORGET_MS = 10 * 60_000;
const MAX_TOLD = 12;

/** The server's readings of the net: every reading the GUI host makes is told to `onRead`, `last` is the newest, `lookup` is the registry of the last reading (a unit that left it is found for 10 minutes, with its successor), and `read` makes a reading now. */
export interface WatchNet { onRead(cb: (net: Net) => void): () => void; last(): Net | undefined; lookup(key: string): Found | undefined; read(): Promise<Net> }
export interface WatchQuery { key: string; since?: string; deadline?: number; quietMs?: number; loadMax?: number }
export interface WatchReadDeps {
	net: WatchNet;
	now(): number;
	/** Runs `fn` after `ms` and returns its cancel; a test gives one on a clock it moves. */
	timer?(ms: number, fn: () => void): () => void;
	holdMs?: number;
	readMs?: number;
}
export type State = "changed" | "stalled" | "load" | "unchanged" | "expired" | "gone";

type Holder = Pick<Unit, "mark" | "note" | "todo" | "monitors" | "ticks"> & { key: string; duty?: string; subs?: Unit[] };
interface Seen { unit: Holder; train?: YardTrainRow }
/** What a stamp carries besides the instance: the facts' hash, the move the last `stalled` was told for (0: none), and the short ids of the monitors whose load was told. */
interface Told { hash: string; stalled: number; load: string[] }
/** The quiet clock of one unit: `from` is where the quiet began (the last move, or the reading after a gap), `move` the last move itself, `at` the last reading that had the unit. */
interface Quiet { at: number; from: number; move: number; mark: string; note?: string; tick?: number; lines: Map<string, number>; asked: number }
interface Hold { q: WatchQuery; told: Told; done(reply: Reply): void; cancel(): void }

const short = (text: string, n = 8) => createHash("sha256").update(text).digest("hex").slice(0, n);
const holdersOf = (b: Base): Holder[] => [...(b.tower ? [b.tower, ...b.tower.subs] : []), ...[...b.tabs.flatMap((t) => t.units), ...b.outside].flatMap((u) => [u, ...u.subs])];
const trainOf = (net: Net, key: string) => net.yards?.projects.flatMap((p) => p.trains).find((t) => t.key === key && t.state !== "unreadable");
/** The step a train is at: the one in progress, else the last that is not pending. */
const stepOf = (train: YardTrainRow) => train.steps.find((s) => s.status === "in_progress") ?? train.steps.findLast((s) => s.status !== "pending");
/** A wait without its load reading, which changes with every reading. */
const waitFact = (w: YardTrainRow["steps"][number]["waits"][number]) => ("load" in w ? "load" : JSON.stringify(w));

/** The facts that wake a hold, as one hash. */
function factsOf({ unit, train }: Seen): string {
	return short(JSON.stringify([
		unit.mark, (unit.monitors ?? []).map((m) => [m.id, m.status, m.exit ?? null]), unit.todo ? [unit.todo.done, unit.todo.total, unit.todo.now ?? null] : null,
		train ? [train.state, train.round ?? null, train.steps.map((s) => [s.id, s.status, s.round, s.outcome ?? null, s.status === "in_progress" ? s.waits.map(waitFact) : null])] : null,
		(unit.subs ?? []).map((s) => [s.key, s.mark]),
	]), 16);
}

/** The unit as a reply shows it: no file, no transcript, no monitor command. */
function viewOf({ unit, train }: Seen, now: number): Record<string, unknown> {
	const monitor = (m: Monitor) => ({ id: m.id, status: m.status, ...(m.exit !== undefined ? { exit: m.exit } : {}), ...(m.last !== undefined ? { last: m.last } : {}), ...(m.load ? { load: { max: m.load.max, now: m.load.now } } : {}), ageMs: Math.max(0, now - m.at) });
	const step = train && stepOf(train);
	return {
		mark: unit.mark, ...(unit.note ? { note: unit.note } : {}), ...(unit.duty ? { duty: unit.duty } : {}),
		...(unit.todo ? { todo: { done: unit.todo.done, total: unit.todo.total, ...(unit.todo.now ? { now: unit.todo.now } : {}) } } : {}),
		...(unit.monitors?.length ? { monitors: unit.monitors.map(monitor) } : {}),
		...(train ? { train: { status: train.state, ...(step ? { step: `${step.id} ${step.kind} ${step.name} ${step.status}${step.outcome ? ` ${step.outcome}` : ""}` } : {}), ...(step?.status === "in_progress" && step.waits.length ? { waits: waitMessage(step.waits) } : {}) } } : {}),
		...(unit.subs?.length ? { subs: unit.subs.map((s) => ({ name: s.name, mark: s.mark })) } : {}),
	};
}

export function createWatchRead(d: WatchReadDeps) {
	const instance = randomBytes(4).toString("hex"), holdMs = d.holdMs ?? HOLD_MS, readMs = d.readMs ?? READ_MS;
	const timer = d.timer ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
	const holds = new Set<Hold>(), quiets = new Map<string, Quiet>();
	/** The last reading taken in, by unit key, and when it was taken in. */
	let net: Net | undefined, units = new Map<string, Seen>(), fed = -Infinity, reading: Promise<void> | undefined, poll: (() => void) | undefined;

	const stampOf = (t: Told) => Buffer.from(JSON.stringify([instance, t.hash, t.stalled, t.load])).toString("base64url");
	/** What a stamp of this instance told; none for any other text. */
	const toldOf = (since: string | undefined): Told | undefined => {
		if (!since || since.length > 512) return undefined;
		try {
			const [of, hash, stalled, load] = JSON.parse(Buffer.from(since, "base64url").toString("utf8")) as unknown[];
			return of === instance && typeof hash === "string" && typeof stalled === "number" && Array.isArray(load) && load.every((x) => typeof x === "string") ? { hash, stalled, load: (load as string[]).slice(0, MAX_TOLD) } : undefined;
		} catch {
			return undefined;
		}
	};

	/** A reading moves the quiet clock of each unit that was asked about: a mark, a note, a tick, or a monitor's line count that changed is a move; a reading long after the last one starts the clock again, since what happened in between is unknown. */
	const follow = (key: string, unit: Holder, at: number, asked?: number) => {
		const lines = new Map((unit.monitors ?? []).map((m) => [m.id, m.lines])), tick = unit.ticks?.at(-1)?.at, was = quiets.get(key);
		if (!was) return void (asked !== undefined && quiets.set(key, { at, from: at, move: at, mark: unit.mark, note: unit.note, tick, lines, asked }));
		if (at - was.at > GAP_MS) was.from = at;
		else if (was.mark !== unit.mark || was.note !== unit.note || was.tick !== tick || [...lines].some(([id, n]) => (was.lines.get(id) ?? -1) < n)) was.from = was.move = at;
		Object.assign(was, { at, mark: unit.mark, note: unit.note, tick, lines }, asked !== undefined ? { asked } : {});
	};

	const take = (next: Net) => {
		const at = d.now();
		[net, fed, units] = [next, at, new Map()];
		if (!holds.size && !quiets.size) return;
		for (const b of next.bases) for (const unit of holdersOf(b)) if (!units.has(unit.key)) units.set(unit.key, { unit, ...((train) => (train ? { train } : {}))(trainOf(next, unit.key)) });
		for (const [key, q] of quiets) {
			const seen = units.get(key);
			if (at - q.asked > FORGET_MS) quiets.delete(key);
			else if (seen) follow(key, seen.unit, at);
		}
		for (const hold of [...holds]) {
			const reply = judge(hold, at, false);
			if (reply) hold.done(reply);
		}
	};
	/** The units of the last reading by key; built on demand when the reading came in with nobody asking. */
	const seenOf = (key: string): Seen | undefined => {
		if (net && !units.size) for (const b of net.bases) for (const unit of holdersOf(b)) if (!units.has(unit.key)) units.set(unit.key, { unit, ...((train) => (train ? { train } : {}))(trainOf(net, unit.key)) });
		return units.get(key);
	};

	const answer = (state: State, hold: Hold, at: number, seen?: Seen, more: Record<string, unknown> = {}): Reply => ({ ok: true, state, since: stampOf(hold.told), now: at, ...(seen ? { unit: viewOf(seen, at) } : {}), ...more });
	/**
	 * The verdict of a hold against the last reading, or none while it holds. In order: the unit left the net, the deadline passed, a waking fact differs from the stamp's, a monitor's load crossed its limit, the unit is quiet for `quietMs`.
	 * `arrival`: the request has just come in, and a key the net does not know is an error (later, a unit that is in no reading and no registry has left without a trace).
	 */
	const judge = (hold: Hold, at: number, arrival: boolean): Reply | undefined => {
		const { q, told } = hold, seen = seenOf(q.key);
		if (!seen) {
			const found = d.net.lookup(q.key);
			if (found?.live) return undefined; // the registry has it and the reading does not yet: the next reading tells
			if (!found && arrival) return { ok: false, error: `unknown key ${q.key}` };
			return answer("gone", hold, at, undefined, found?.successor ? { successor: found.successor } : {});
		}
		if (arrival) follow(q.key, seen.unit, fed, at);
		if (q.deadline !== undefined && at >= q.deadline) return answer("expired", hold, at, seen);
		const over = (seen.unit.monitors ?? []).filter((m) => m.load && m.load.now > (q.loadMax ?? m.load.max)).map((m) => short(m.id)).slice(0, MAX_TOLD);
		const fresh = over.filter((id) => !told.load.includes(id)), hash = factsOf(seen);
		// A load that fell back under its limit is forgotten, so its next crossing is told.
		told.load = told.load.filter((id) => over.includes(id));
		if (hash !== told.hash) return (told.hash = hash), answer("changed", hold, at, seen);
		if (fresh.length) return (told.load = over), answer("load", hold, at, seen);
		const quiet = quiets.get(q.key);
		if (q.quietMs !== undefined && quiet && quiet.at - quiet.from >= q.quietMs && told.stalled !== quiet.move) return (told.stalled = quiet.move), answer("stalled", hold, at, seen);
		return undefined;
	};

	/** The route's own reading, while the GUI host gives none. */
	const readNow = () => (reading ??= d.net.read().then((next) => void (next !== net && take(next)), () => {}).finally(() => (reading = undefined)));
	const beat = () => {
		poll = undefined;
		if (!holds.size) return;
		if (d.now() - fed >= readMs) void readNow();
		poll = timer(readMs, beat);
	};
	const stopRead = d.net.onRead((next) => take(next));

	return {
		/** One hold: answered at once when the stamp does not match the last reading, else by a reading, the deadline, or the hold's timer. */
		async read(q: WatchQuery): Promise<Reply> {
			// The GUI host's last reading stands in until the first one comes; one older than two read intervals (the host reads nothing now, and no hold kept the route reading) is read again first.
			const last = net ? undefined : d.net.last();
			if (last) take(last);
			else if (d.now() - fed >= 2 * readMs) await readNow();
			if (!net) return { ok: false, error: "the net could not be read; ask again" };
			const was = toldOf(q.since), hold: Hold = { q, told: was ?? { hash: "", stalled: 0, load: [] }, done() {}, cancel() {} };
			// The registry knows a unit the last reading does not (it joined between two readings): one reading more before the key is called unknown.
			if (!seenOf(q.key) && d.net.lookup(q.key)?.live) await readNow();
			// A key of the registry that is no unit of the net (the head tower, a run's read-only view) has nothing to watch.
			if (!seenOf(q.key) && d.net.lookup(q.key)?.live) return { ok: false, error: `unknown key ${q.key}` };
			const first = judge(hold, d.now(), true);
			if (first) return first;
			return new Promise<Reply>((resolve) => {
				const left = q.deadline !== undefined ? q.deadline - d.now() : Infinity;
				const cancel = timer(Math.min(holdMs, left), () => hold.done(answer(left <= holdMs ? "expired" : "unchanged", hold, d.now(), seenOf(q.key))));
				hold.cancel = cancel;
				hold.done = (reply) => { if (holds.delete(hold)) (cancel(), resolve(reply)); };
				holds.add(hold);
				poll ??= timer(readMs, beat);
			});
		},
		/** How many holds are open. */
		holds: () => holds.size,
		/** The server leaves: the timers stop and the open holds are left to their connections, which close with the socket. */
		stop() {
			stopRead();
			poll?.();
			poll = undefined;
			for (const hold of holds) hold.cancel();
			holds.clear();
		},
	};
}
export type WatchRead = ReturnType<typeof createWatchRead>;
