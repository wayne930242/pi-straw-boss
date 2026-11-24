import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clean, safeSession, STALE_MS } from "./board.ts";
import type { Todo } from "./items.ts";

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
export interface Job { owner?: string; points: number }
/** What a main writes: its in-progress todos that have an owner (`doing`), its pending todos whose blockers are all done (`ready`), its open todos, and its pause. */
export interface MainCap { v: 1; session: string; updated: number; doing: Job[]; ready: Job[]; open: number; pause?: Pause }

const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const pointsOf = (t: Pick<Todo, "points">) => t.points ?? DEFAULT_POINTS;
const job = (t: Pick<Todo, "owner" | "points">): Job => ({ ...(t.owner ? { owner: t.owner } : {}), points: pointsOf(t) });

/** A todo list's capacity facts. A blocker the list no longer holds (deleted) blocks nothing. */
export function capOfTodos(list: readonly Todo[]): Pick<MainCap, "doing" | "ready" | "open"> {
	const done = new Set(list.filter((t) => t.status === "completed").map((t) => t.id)), known = new Set(list.map((t) => t.id));
	const free = (t: Todo) => (t.blockedBy ?? []).every((id) => done.has(id) || !known.has(id));
	return {
		doing: list.filter((t) => t.status === "in_progress" && t.owner).slice(0, JOBS).map(job),
		ready: list.filter((t) => t.status === "pending" && free(t)).slice(0, JOBS).map(job),
		open: list.filter((t) => t.status !== "completed").length,
	};
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
const DEVICE = "_device.json", SENT = "_sent.json";
function writeJson(dir: string, name: string, value: unknown): void {
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
const jobsOf = (v: unknown): Job[] => (Array.isArray(v) ? v.slice(0, JOBS).flatMap((j: Record<string, unknown> | null) => {
	const points = num(j?.points, 0, 10), owner = clean(j?.owner, 64);
	return points === undefined ? [] : [{ ...(owner ? { owner } : {}), points }];
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
		return [{ v: 1, session, updated: raw.updated as number, doing: jobsOf(raw.doing), ready: jobsOf(raw.ready), open: num(raw.open, 0, 200) ?? 0, ...(pause ? { pause } : {}) }];
	});
}
/** The files of sessions that are not live and older than a day go. */
export function purgeCaps(dir: string, live: ReadonlySet<string>, now: number): void {
	for (const c of readCaps(dir)) if (!live.has(c.session) && now - c.updated > 24 * 3600_000) removeCap(dir, c.session);
}

/** A live main as the server sees it: its workers are the names of the subagents of its pane that run now (and, for any main, the device's live trains). */
export interface MainFacts { session: string; name: string; workspace: string; role: "main" | "train"; state: string; commanding?: boolean; duty?: string; workers: string[]; fileMtime?: number; entryUpdated?: number }
/** One main's row of the device: points in use, its ready todos (the smallest's points), its open todos, its pause, and whether it is stale. */
export interface MainRow { session: string; name: string; workspace: string; points: number; ready: number; minReady?: number; open: number; paused?: { until?: number; detail?: string }; stale?: true; standing?: true; /** The running workers sampled, folded (workercap.ts matches a launch to them); the local file only, never on the wire. */ workers?: string[] }
/** The device row. `under`: since when the device has had room for its smallest ready todo (held 10 minutes before it is flagged). */
export interface DeviceCap { v: 1; at: number; points: number; budget?: number; load1: number; cores: number; ready: number; minReady?: number; open: number; unattended: boolean; under?: number; mains: MainRow[] }

/** A worker's or owner's name as they are matched: case- and space-folded. */ export const nameKey = (name: string) => name.trim().toLowerCase();
const round = (n: number) => Math.round(n * 100) / 100;

/**
 * Whether a main is stale. On an unattended device: it has open todos, runs nothing (no running worker or train, no points in use: a main commanding work is never stale), is not paused, and neither its session file nor its board entry moved for 30 minutes (whatever its state). Elsewhere the board's own rule: idle,
 * commanding nothing, not standing, and its entry over 2 hours old. A paused main is never stale.
 */
export function staleOf(m: Pick<MainFacts, "state" | "commanding" | "duty" | "fileMtime" | "entryUpdated"> & { workers?: readonly string[]; points?: number }, c: Pick<MainCap, "open" | "pause"> | undefined, unattended: boolean, now: number): boolean {
	if (c?.pause) return false;
	if (unattended) return !m.commanding && !m.workers?.length && !m.points && (c?.open ?? 0) > 0 && Math.max(m.fileMtime ?? 0, m.entryUpdated ?? 0) > 0 && now - Math.max(m.fileMtime ?? 0, m.entryUpdated ?? 0) > STALE_UNATTENDED_MS;
	return m.state === "idle" && !m.commanding && m.duty !== "standing" && m.entryUpdated !== undefined && now - m.entryUpdated > STALE_MS;
}

/**
 * The device row from the live mains and their files. A main's points: each in-progress todo whose owner is one of its running workers counts its points (1 when it names none), and each running
 * worker no such todo names counts 1; the main itself counts nothing. A live train no main's todo names counts 1. Ready: the pending todos whose blockers are done and whose owner does not run.
 */
export function joinCaps(o: { mains: MainFacts[]; caps: MainCap[]; budget?: number | undefined; load1: number; cores: number; unattended: boolean; now: number }): DeviceCap {
	const caps = new Map(o.caps.map((c) => [c.session, c])), trains = o.mains.filter((m) => m.role === "train").map((m) => nameKey(m.name)), named = new Set<string>();
	const mains = o.mains.filter((m) => m.role === "main").map((m): MainRow => {
		const c = caps.get(m.session), own = new Set(m.workers.map(nameKey)), runs = (owner?: string) => owner !== undefined && (own.has(nameKey(owner)) || trains.includes(nameKey(owner)));
		const doing = (c?.doing ?? []).filter((j) => runs(j.owner)), ready = (c?.ready ?? []).filter((j) => !runs(j.owner));
		doing.forEach((j) => named.add(nameKey(j.owner!)));
		const points = doing.reduce((n, j) => n + j.points, 0) + [...own].filter((w) => !doing.some((j) => nameKey(j.owner!) === w)).length * DEFAULT_POINTS;
		const minReady = ready.length ? Math.min(...ready.map((j) => j.points)) : undefined;
		return {
			session: m.session, name: clean(m.name, 40), workspace: m.workspace, points: round(points), ready: ready.length, ...(minReady !== undefined ? { minReady } : {}), open: c?.open ?? 0,
			...(c?.pause ? { paused: { ...(c.pause.until !== undefined ? { until: c.pause.until } : {}), ...(c.pause.detail ? { detail: c.pause.detail } : {}) } } : {}),
			...(staleOf({ ...m, points }, c, o.unattended, o.now) ? { stale: true as const } : {}), ...(m.duty === "standing" ? { standing: true as const } : {}), workers: [...own],
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
export function rowCap(d: DeviceCap | undefined, session: string, now: number): { points?: number; ready?: number; paused?: string; stale?: boolean } {
	const r = d?.mains.find((x) => x.session === session);
	return r ? { points: r.points, ready: r.ready, ...(r.paused ? { paused: pauseText(r.paused, now) } : {}), stale: Boolean(r.stale) } : {};
}
