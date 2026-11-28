import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clean, safeSession, STALE_MS } from "./board.ts";
import { todoDeadlines } from "./todoledger.ts";
import type { Todo } from "./items.ts";
import { readSnoozes, type Snooze, snoozeEnd, snoozeId, type WatchFact } from "./snooze.ts";

// Device capacity on the work board (docs/specs/2026-11-24-capacity.md): what each main has running and ready in points, and the device row the sb server writes once a minute from them, the
// load and the budget. A main's own session writes its facts (capfill.ts); the server joins them with the subagents it sees running (server/capwatch.ts). Points are the box rule's, kept on the todo
// (`metadata.points`); sb only adds them up. The files sit in `<state dir>/capacity/`: `<session>.json` per main, `_device.json` the server's row, `_sent.json` the events' throttle.

const MIN = 60_000;
/** A todo whose owner runs and that names no points counts this many; so does a running worker no in-progress todo names. */
export const DEFAULT_POINTS = 1;
export const STALE_UNATTENDED_MS = 30 * MIN, UNDER_HOLD_MS = 10 * MIN, SILENT_MS = 30 * MIN, THROTTLE_MS = 30 * MIN, LOAD_SHARE = 0.7;
/** A device row older than this is no reading (the server stopped): readers show nothing. */
export const DEVICE_FRESH_MS = 5 * MIN;
/** The pause seam (shared with pi-agent-basic, which emits it; sb imports nothing from it): one in-process `pi.events` channel. */
export const PAUSE_EVENT = "straw-boss:pause";
const JOBS = 50, DETAIL = 120;

/** A main stopped on its model quota: `until` (epoch ms) when it expects to resume, if known. */
export interface Pause { reason: "quota"; at: number; until?: number; detail?: string }
/** A todo as capacity counts it: its owner, when it names one, and its points. */
export interface Job { owner?: string; points: number; until?: number }
/** An open todo as the stale reminder names it (docs/specs/2026-11-28-stale-snooze.md): `until`, when `metadata.until` or `metadata.waitsOn` defers it (8.64e15 for a wait on a person). */
export interface CapTodo { id: number; subject: string; until?: number }
/** What a main writes: its in-progress todos that have an owner (`doing`), its pending todos whose blockers are all done (`ready`), its open todos (the count, and each: `todos`), its pause, and its snoozes of the stale reminder. */
export interface MainCap { v: 1; session: string; updated: number; doing: Job[]; ready: Job[]; open: number; deadlines?: number[]; pause?: Pause; todos?: CapTodo[]; snoozes?: Snooze[] }

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const pointsOf = (t: Pick<Todo, "points">) => t.points ?? DEFAULT_POINTS;
const job = (t: Pick<Todo, "owner" | "points">): Job => ({ ...(t.owner ? { owner: t.owner } : {}), points: pointsOf(t) });

/** A todo list's capacity facts. A blocker the list no longer holds (deleted) blocks nothing. */
export function capOfTodos(list: readonly Todo[], snapshot?: unknown): Pick<MainCap, "doing" | "ready" | "open" | "deadlines"> {
	const dates = todoDeadlines(snapshot), deadlines = list.flatMap((t) => t.status !== "completed" && dates.has(t.id) ? [dates.get(t.id)!] : []);
	const done = new Set(list.filter((t) => t.status === "completed").map((t) => t.id)), known = new Set(list.map((t) => t.id));
	const free = (t: Todo) => (t.blockedBy ?? []).every((id) => done.has(id) || !known.has(id));
	return {
		doing: list.filter((t) => t.status === "in_progress" && t.owner).slice(0, JOBS).map(job),
		ready: list.filter((t) => t.status === "pending" && free(t)).slice(0, deadlines.length ? 200 : JOBS).map((t) => ({ ...job(t), ...(dates.has(t.id) ? { until: dates.get(t.id)! } : {}) })),
		...(deadlines.length ? { deadlines } : {}),
		open: list.filter((t) => t.status !== "completed").length,
	};
}

/** Open todos a capacity file holds: every one, for the stale reminder decides on the whole list (review F006); the bound only stops a broken file. A row shows `SHOWN` of them. */
const TODOS = 5000, SHOWN = 3, SUBJECT = 80;
/** A todo list's open todos for the stale reminder, each with its deferral's end. */
export function openTodos(list: readonly Todo[], snapshot?: unknown): CapTodo[] {
	const dates = todoDeadlines(snapshot);
	return list.filter((t) => t.status !== "completed").map((t) => ({ id: t.id, subject: clean(t.subject, SUBJECT), ...(dates.has(t.id) ? { until: dates.get(t.id)! } : {}) }));
}

/** The seam's payload checked: `{ v: 1, state: "paused" | "resumed", reason: "quota", until?, detail? }`; anything else is ignored. */
export function pauseOf(data: unknown, now: number): { state: "paused"; pause: Pause } | { state: "resumed" } | undefined {
	const d = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
	if (d.v !== 1 || d.reason !== "quota") return undefined;
	if (d.state === "resumed") return { state: "resumed" };
	if (d.state !== "paused") return undefined;
	const until = num(d.until, 0, 8.64e15), detail = clean(d.detail, DETAIL);
	return { state: "paused", pause: { reason: "quota", at: now, ...(until !== undefined ? { until } : {}), ...(detail ? { detail } : {}) } };
}

/** `<state dir>/capacity`, beside the board folder (whose listing the board's readers and purge own). */
export const capDir = (boardDir: string) => join(dirname(boardDir), "capacity");
/** `capacity.budget` of `<state dir>/config.json`: a number of points over 0 (at most 1000); none when it is unset or not such a number. Read at each call, so a change applies at once. */
export function readBudget(stateDir: string): number | undefined {
	let b: unknown;
	try { b = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { capacity?: { budget?: unknown } }).capacity?.budget; } catch { return undefined; }
	return typeof b === "number" && Number.isFinite(b) && b > 0 && b <= 1000 ? b : undefined;
}
/** How long a main moves nothing before it is stale (docs/specs/2026-11-28-stale-snooze.md): on an attended device and on an unattended one. */
export interface StaleMs { attendedMs: number; unattendedMs: number }
export const STALE_DEFAULTS: StaleMs = { attendedMs: STALE_MS, unattendedMs: STALE_UNATTENDED_MS };
/** `capacity.staleMinutes` and `capacity.staleUnattendedMinutes` of `<state dir>/config.json`: whole minutes, 1 to 1440; anything else keeps today's 120 and 30. Read at each look. */
export function readStale(stateDir: string): StaleMs {
	let c: Record<string, unknown> | undefined;
	try { c = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as { capacity?: Record<string, unknown> }).capacity; } catch { /* none, or not JSON: the defaults */ }
	const minutes = (v: unknown, ms: number) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 1440 ? (v as number) * MIN : ms);
	return { attendedMs: minutes(c?.staleMinutes, STALE_DEFAULTS.attendedMs), unattendedMs: minutes(c?.staleUnattendedMinutes, STALE_DEFAULTS.unattendedMs) };
}
const DEVICE = "_device.json", SENT = "_sent.json";
export function writeJson(dir: string, name: string, value: unknown): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, name), temp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
const readJson = (file: string): Record<string, unknown> | undefined => {
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
};
const jobsOf = (v: unknown, max = JOBS): Job[] => (Array.isArray(v) ? v.slice(0, max).flatMap((j: Record<string, unknown> | null) => {
	const points = num(j?.points, 0, 10), owner = clean(j?.owner, 64);
	return points === undefined ? [] : [{ ...(owner ? { owner } : {}), points, ...(num(j?.until, 0, 8.64e15) !== undefined ? { until: j!.until as number } : {}) }];
}) : []);

export function writeCap(dir: string, cap: MainCap): void {
	if (!safeSession(cap.session)) throw new Error("This session has no id a capacity file can be named for");
	writeJson(dir, `${cap.session}.json`, cap);
}
export const removeCap = (dir: string, session: string) => void (safeSession(session) && rmSync(join(dir, `${session}.json`), { force: true }));
/** Every main's file that passes the check; the server's own files and anything else are skipped. */
export function readCaps(dir: string): MainCap[] {
	let names: string[] = [];
	try { names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("_")); } catch { /* none yet */ }
	return names.flatMap((name): MainCap[] => {
		const raw = readJson(join(dir, name)), session = name.slice(0, -".json".length);
		if (raw?.v !== 1 || raw.session !== session || !safeSession(session) || num(raw.updated, 0, 8.64e15) === undefined) return [];
		const p = raw.pause as Record<string, unknown> | undefined, at = num(p?.at, 0, 8.64e15), until = num(p?.until, 0, 8.64e15), detail = clean(p?.detail, DETAIL);
		const pause = p?.reason === "quota" && at !== undefined ? { reason: "quota" as const, at, ...(until !== undefined ? { until } : {}), ...(detail ? { detail } : {}) } : undefined;
		const todos = Array.isArray(raw.todos) ? raw.todos.slice(0, TODOS).flatMap((t: Record<string, unknown> | null): CapTodo[] => (Number.isInteger(t?.id) && (t!.id as number) >= 1 ? [{ id: t!.id as number, subject: clean(t!.subject, SUBJECT), ...(num(t!.until, 0, 8.64e15) !== undefined ? { until: t!.until as number } : {}) }] : [])) : undefined;
		const snoozes = readSnoozes(raw.snoozes);
		return [{ v: 1, session, updated: raw.updated as number, doing: jobsOf(raw.doing), ready: jobsOf(raw.ready, 200), ...(Array.isArray(raw.deadlines) ? { deadlines: raw.deadlines.slice(0, 200).filter((n) => num(n, 0, 8.64e15) !== undefined) } : {}), open: num(raw.open, 0, TODOS) ?? 0, ...(pause ? { pause } : {}), ...(todos ? { todos } : {}), ...(snoozes.length ? { snoozes } : {}) }];
	});
}
/** The files of sessions that are not live and older than a day go. */
export function purgeCaps(dir: string, live: ReadonlySet<string>, now: number): void {
	for (const c of readCaps(dir)) if (!live.has(c.session) && now - c.updated > 24 * 3600_000) removeCap(dir, c.session);
}

/** The last stale notice told to a main (capwatch.ts): when, its last move then, and its unanswered todos then (`todosKey`). A main that moved since only by taking it is judged as then (review F005). */
export interface Notice { at: number; moved: number; todos: number }
/** How long after a stale notice a write of the main's session file is the delivery's own: the notice it took, its pane working on it. */
export const DELIVERY_MS = 5 * MIN;
/** The open todos of a capacity file as one number: it changes when a todo is answered, done, or added (review F005). */
export function todosKey(c: Pick<MainCap, "open" | "todos"> | undefined): number {
	let h = 2166136261;
	for (const ch of JSON.stringify(c?.todos?.map((t) => [t.id, t.until ?? null]) ?? c?.open ?? 0)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
	return h >>> 0;
}
/** A live main as the server sees it: its workers are the names of the subagents of its pane that run now (and, for any main, the device's live trains). */
export interface MainFacts { session: string; name: string; workspace: string; role: "main" | "train"; state: string; /** Its Herdr pane's `agent_status`. */ paneStatus?: string; commanding?: boolean; duty?: string; workers: string[]; fileMtime?: number; entryUpdated?: number; background?: boolean; /** A main of kind worker opened for a teammate's device: its own points (its route). */ selfPoints?: number; /** Its `boss_watch` watches, which hold the stale reminder until their first change (docs/specs/2026-11-28-stale-snooze.md). */ watches?: WatchFact[]; notice?: Notice }
/** One main's row of the device: points in use, its ready todos (the smallest's points), its open todos, its pause, and whether it is stale. */
export interface MainRow { session: string; name: string; workspace: string; points: number; ready: number; minReady?: number; open: number; paused?: { until?: number; detail?: string }; stale?: true; standing?: true; /** The running workers sampled, folded (workercap.ts matches a launch to them); the local file only, never on the wire. */ workers?: string[]; /** The deployed units by name and points (the head page's supply tray); local only, like `workers`. */ units?: { name: string; points: number }[];
	/** The stale reminder (docs/specs/2026-11-28-stale-snooze.md), local only like `workers`: a stale main's unanswered todos (the first three, and their count), its last move, the snooze whose end woke the reminder (by its identity), and the snoozes that hold. */
	todos?: { id: number; subject: string }[]; unanswered?: number; moved?: number; woke?: { at: number; why: string; id: string }; snoozes?: Snooze[];
	/** The later of its file's and its entry's writes as the stale verdict counts it (a delivery's own write not), and its open todos as one number: what a notice records (capwatch.ts). */
	basis?: number; todosKey?: number }
/** The device row. `under`: since when the device has had room for its smallest ready todo (held 10 minutes before it is flagged). */
export interface DeviceCap { v: 1; at: number; points: number; budget?: number; load1: number; cores: number; ready: number; minReady?: number; open: number; unattended: boolean; under?: number; mains: MainRow[] }

/** A worker's or owner's name as they are matched: case- and space-folded. */ export const nameKey = (name: string) => name.trim().toLowerCase();
const round = (n: number) => Math.round(n * 100) / 100;

/** A main's stale verdict with what the reminder says: the unanswered todos and the snooze that woke it (when stale), its last move, and the snoozes that hold now. */
export interface StaleFacts { stale: boolean; todos?: { id: number; subject: string }[]; moved?: number; basis?: number; woke?: { at: number; why: string; id: string }; snoozes: Snooze[] }
type StaleMain = Pick<MainFacts, "state" | "paneStatus" | "commanding" | "duty" | "fileMtime" | "entryUpdated" | "background" | "watches" | "notice"> & { session?: string; workers?: readonly string[]; points?: number };
/** The first end the server saw of each snooze, by `snoozeId` (review F001): kept in `_sent.json`, so a later watch line, the snooze's own time, or a restart never moves it. */
export type SnoozeEnds = Record<string, number>;

/**
 * Whether a main is stale. On an unattended device: it has open todos, runs nothing (no running worker or train, no points in use: a main commanding work is never stale), is not paused, and neither its session file nor its board entry moved for 30 minutes (whatever its state). Elsewhere the board's own rule: idle,
 * commanding nothing, not standing, and its entry over 2 hours old. A paused main is never stale, nor one whose Herdr pane is working: it is moving (boss 2026-11-26 「herdr state 還在 working 的 agent 不必被詢問」).
 * The two spans are `capacity.staleUnattendedMinutes` and `capacity.staleMinutes` (`o`); see `staleFacts` for the snoozes (docs/specs/2026-11-28-stale-snooze.md).
 */
export const staleOf = (m: StaleMain, c: Pick<MainCap, "open" | "pause" | "deadlines" | "todos" | "snoozes"> | undefined, unattended: boolean, now: number, o: StaleMs = STALE_DEFAULTS, ends?: SnoozeEnds): boolean => staleFacts(m, c, unattended, now, o, ends).stale;

/**
 * `staleOf` with its reasons (docs/specs/2026-11-28-stale-snooze.md). Never stale besides: while one of its watches has sent no line since it started, while a snooze of the whole main holds, or when every open todo is
 * deferred (`metadata.until`, `metadata.waitsOn`) or snoozed on its own. A snooze that ended after the main's last move (the later of its file and its entry) makes it stale at once, without a new span.
 * A main of an older build lists no todos: its open count against its deadlines decides, as before.
 * `ends`: the first end seen of each snooze, read and added to (review F001). `m.notice`: the last stale notice told it; a main whose only moves since are taking it (its session file written within
 * `DELIVERY_MS` of it, its pane working, its entry and open todos as they were) is judged as then, so the episode and its main-only repeats hold (review F005).
 */
export function staleFacts(m: StaleMain, c: Pick<MainCap, "open" | "pause" | "deadlines" | "todos" | "snoozes"> | undefined, unattended: boolean, now: number, o: StaleMs = STALE_DEFAULTS, ends: SnoozeEnds = {}): StaleFacts {
	const ended = (c?.snoozes ?? []).map((s) => {
		const id = snoozeId(m.session ?? "", s), end = ends[id] ?? snoozeEnd(s, m.watches, now);
		if (end !== undefined) ends[id] ??= end;
		return { s, id, end };
	});
	const snoozes = ended.filter((x) => x.end === undefined).map((x) => x.s), no: StaleFacts = { stale: false, snoozes };
	const n = m.notice, delivered = n !== undefined && (m.entryUpdated ?? 0) <= n.at && (m.fileMtime ?? 0) <= n.at + DELIVERY_MS && todosKey(c) === n.todos;
	if (c?.pause || m.background || (m.paneStatus === "working" && !delivered) || m.watches?.some((w) => w.ended === undefined && w.toldAt <= w.added) || snoozes.some((s) => s.todo === undefined)) return no;
	const held = new Set(snoozes.flatMap((s) => (s.todo !== undefined ? [s.todo] : []))), todos = c?.todos?.filter((t) => !(t.until !== undefined && t.until > now) && !held.has(t.id)).map(({ id, subject }) => ({ id, subject }));
	if (c && c.open > 0 && (todos ? !todos.length : (c.deadlines ?? []).filter((at) => at > now).length >= c.open)) return no;
	const moved = delivered ? Math.min(n.moved, Math.max(m.fileMtime ?? 0, m.entryUpdated ?? 0)) : Math.max(m.fileMtime ?? 0, m.entryUpdated ?? 0), woke = ended.filter((x) => x.end !== undefined && x.end > moved).sort((a, b) => b.end! - a.end!)[0];
	const due = (span: number, from: number) => delivered || now - from > span || woke !== undefined;
	const stale = unattended
		? !m.commanding && !m.workers?.length && !m.points && (c?.open ?? 0) > 0 && moved > 0 && due(o.unattendedMs, moved)
		: (m.state === "idle" || delivered) && !m.commanding && m.duty !== "standing" && m.entryUpdated !== undefined && due(o.attendedMs, m.entryUpdated);
	const last = unattended ? (moved > 0 ? moved : undefined) : m.entryUpdated;
	return { stale, snoozes, basis: moved, ...(last !== undefined ? { moved: last } : {}), ...(stale && todos ? { todos } : {}), ...(stale && woke ? { woke: { at: woke.end!, why: woke.s.why, id: woke.id } } : {}) };
}

/**
 * The device row from the live mains and their files. A main's points: each in-progress todo whose owner is one of its running workers counts its points (1 when it names none), and each running
 * worker no such todo names counts 1; the main itself counts nothing. A live train no main's todo names counts 1. Ready: the pending todos whose blockers are done and whose owner does not run.
 */
export function joinCaps(o: { mains: MainFacts[]; caps: MainCap[]; budget?: number | undefined; load1: number; cores: number; unattended: boolean; now: number; stale?: StaleMs; ends?: SnoozeEnds }): DeviceCap {
	const caps = new Map(o.caps.map((c) => [c.session, c])), trains = o.mains.filter((m) => m.role === "train").map((m) => nameKey(m.name)), named = new Set<string>();
	const mains = o.mains.filter((m) => m.role === "main").map((m): MainRow => {
		const c = caps.get(m.session), own = new Set(m.workers.map(nameKey)), runs = (owner?: string) => owner !== undefined && (own.has(nameKey(owner)) || trains.includes(nameKey(owner)));
		const self = m.duty === "worker" ? (m.selfPoints ?? DEFAULT_POINTS) : undefined; // a worker main counts itself, and its own steps are no ready work of the device
		const doing = self !== undefined ? [] : (c?.doing ?? []).filter((j) => runs(j.owner)), ready = self !== undefined ? [] : (c?.ready ?? []).filter((j) => j.until === undefined || j.until <= o.now).slice(0, JOBS).filter((j) => !runs(j.owner));
		doing.forEach((j) => named.add(nameKey(j.owner!)));
		const points = (self ?? 0) + doing.reduce((n, j) => n + j.points, 0) + [...own].filter((w) => !doing.some((j) => nameKey(j.owner!) === w)).length * DEFAULT_POINTS;
		const minReady = ready.length ? Math.min(...ready.map((j) => j.points)) : undefined, units = new Map<string, { name: string; points: number }>();
		for (const j of doing) units.set(nameKey(j.owner!), { name: clean(j.owner, 40), points: round((units.get(nameKey(j.owner!))?.points ?? 0) + j.points) });
		if (self !== undefined) units.set(nameKey(m.name), { name: clean(m.name, 40), points: self });
		const sf = staleFacts({ ...m, points }, c, o.unattended, o.now, o.stale, o.ends);
		for (const w of m.workers) if (!units.has(nameKey(w))) units.set(nameKey(w), { name: clean(w, 40), points: DEFAULT_POINTS });
		return {
			session: m.session, name: clean(m.name, 40), workspace: m.workspace, points: round(points), ready: ready.length, ...(minReady !== undefined ? { minReady } : {}), open: c?.open ?? 0,
			...(c?.pause ? { paused: { ...(c.pause.until !== undefined ? { until: c.pause.until } : {}), ...(c.pause.detail ? { detail: c.pause.detail } : {}) } } : {}),
			...(sf.stale ? { stale: true as const } : {}), ...(m.duty === "standing" ? { standing: true as const } : {}), workers: [...own], units: [...units.values()],
			...(sf.todos ? { todos: sf.todos.slice(0, SHOWN), unanswered: sf.todos.length } : {}), ...(sf.stale ? { basis: sf.basis ?? 0, todosKey: todosKey(c) } : {}), ...(sf.moved !== undefined ? { moved: sf.moved } : {}), ...(sf.woke ? { woke: sf.woke } : {}), ...(sf.snoozes.length ? { snoozes: sf.snoozes } : {}),
		};
	});
	const loose = trains.filter((t) => !named.has(t)).length * DEFAULT_POINTS, smallest = mains.flatMap((r) => (r.minReady !== undefined ? [r.minReady] : []));
	return {
		v: 1, at: o.now, points: round(mains.reduce((n, r) => n + r.points, 0) + loose), ...(o.budget !== undefined ? { budget: o.budget } : {}), load1: round(o.load1), cores: o.cores,
		ready: mains.reduce((n, r) => n + r.ready, 0), ...(smallest.length ? { minReady: Math.min(...smallest) } : {}), open: mains.reduce((n, r) => n + r.open, 0), unattended: o.unattended, mains,
	};
}

/** The device has room: a budget is set, its points and its smallest ready todo fit in it, and the load is under 0.7 per core. Not yet held for 10 minutes; see `DeviceCap.under`. */
export const roomFor = (d: Pick<DeviceCap, "budget" | "points" | "minReady" | "load1" | "cores">): boolean =>
	d.budget !== undefined && d.minReady !== undefined && d.points + d.minReady <= d.budget && d.load1 < LOAD_SHARE * d.cores;
/** Flagged under capacity: room for 10 minutes or more. */
export const underFor = (d: Pick<DeviceCap, "under">, now: number): number | undefined => (d.under !== undefined && now - d.under >= UNDER_HOLD_MS ? now - d.under : undefined);

export const writeDevice = (dir: string, d: DeviceCap) => writeJson(dir, DEVICE, d);
/** The device row the server wrote, when it is under 5 minutes old. */
export function readDevice(dir: string, now: number): DeviceCap | undefined {
	const raw = readJson(join(dir, DEVICE)) as Partial<DeviceCap> | undefined;
	if (raw?.v !== 1 || num(raw.at, 0, 8.64e15) === undefined || now - raw.at! > DEVICE_FRESH_MS || !Array.isArray(raw.mains)) return undefined;
	return raw as DeviceCap;
}
export const readSent = (dir: string): Record<string, number> => Object.fromEntries(Object.entries(readJson(join(dir, SENT)) ?? {}).filter((e): e is [string, number] => typeof e[1] === "number"));
export const writeSent = (dir: string, sent: Record<string, number>) => writeJson(dir, SENT, sent);

const pts = (n: number) => `${round(n)}`;
/** `HH:MM` local, with the date when it is not today. */
export function clock(at: number, now: number): string {
	const d = new Date(at), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
	return d.toDateString() === new Date(now).toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
/** `quota · resumes 16:02`, or `quota` when the time is unknown. */
export const pauseText = (p: { until?: number | undefined }, now: number) => (p.until !== undefined ? `quota · resumes ${clock(p.until, now)}` : "quota");
/** A snooze in words (docs/specs/2026-11-28-stale-snooze.md): `snoozed until 14:30: CI runs`, `#3 snoozed until train-a changes: lands next`. */
export const snoozeLine = (s: Snooze, now: number) => `${s.todo !== undefined ? `#${s.todo} ` : ""}snoozed until ${s.watch !== undefined ? `${s.watch} changes` : clock(s.until, now)}: ${s.why}`;
/** `board_set`'s answer to a snooze: until when, and what replaces it. */
export const snoozeSaid = (s: Snooze, now: number) => `${s.todo !== undefined ? `Todo #${s.todo}'s reminder` : "Reminder"} snoozed until ${s.watch !== undefined ? `watch ${s.watch} sends its next change (${clock(s.until, now)} at the latest)` : clock(s.until, now)} (${JSON.stringify(s.why)}). If your open todos are still unanswered then, sb reminds you again; a new snooze of ${s.todo !== undefined ? `todo #${s.todo}` : "the main"} replaces this one.`;
/** The device line: `capacity 6 / 20 pts · load 0.24 / 32 cores · ready 5 · under 42 min · 1 paused`. */
export function capLine(d: DeviceCap, now: number): string {
	const under = underFor(d, now), paused = d.mains.filter((r) => r.paused).length;
	return [`capacity ${pts(d.points)}${d.budget !== undefined ? ` / ${pts(d.budget)}` : ""} pts`, `load ${pts(d.load1)} / ${d.cores} cores`, `ready ${d.ready}`, ...(under !== undefined ? [`under ${Math.floor(under / MIN)} min`] : []), ...(paused ? [`${paused} paused`] : [])].join(" · ");
}
/** The device row as `board_read` gives it: numbers and times, and the paused mains among `shown` (the sessions of the rows the reader sees) by name. */
export const capSection = (d: DeviceCap, now: number, shown: ReadonlySet<string>) => ({
	points: d.points, ...(d.budget !== undefined ? { budget: d.budget } : {}), load1: d.load1, cores: d.cores, ready: d.ready, ...(d.minReady !== undefined ? { minReady: d.minReady } : {}), open: d.open, unattended: d.unattended,
	...(underFor(d, now) !== undefined ? { underMinutes: Math.floor(underFor(d, now)! / MIN) } : {}), paused: d.mains.filter((r) => r.paused && shown.has(r.session)).map((r) => ({ main: r.name, ...(r.paused!.until !== undefined ? { until: new Date(r.paused!.until).toISOString() } : {}) })), secondsAgo: Math.max(0, Math.round((now - d.at) / 1000)),
});
/** A board row's capacity from the device row: its points and ready todos, its pause (`quota · resumes 16:02`), and the stale mark the server judged, which replaces the board's own (a paused main is never stale). Nothing without a row. */
export function rowCap(d: DeviceCap | undefined, session: string, now: number): { points?: number; ready?: number; paused?: string; stale?: boolean; snoozes?: Snooze[] } {
	const r = d?.mains.find((x) => x.session === session);
	const snoozes = r?.snoozes?.filter((s) => s.until > now); // the row is up to 5 minutes old: a snooze whose time passed since is shown no longer
	return r ? { points: r.points, ready: r.ready, ...(r.paused ? { paused: pauseText(r.paused, now) } : {}), stale: Boolean(r.stale), ...(snoozes?.length ? { snoozes } : {}) } : {};
}
