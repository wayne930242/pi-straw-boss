import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Reply } from "./socket.ts";
import { WARD_LOOK_MS, type WardRec, wardOf } from "./ward.ts";
import type { WatchQuery } from "./watchread.ts";

// The server-owned watches behind a main's `boss_watch` (docs/specs/2026-11-23-lite-b2-d-e-f.md §3.3), which replace the watchdog subagent. Each watch runs watch-read's verdict (watchread.ts) over the server's own readings, chaining
// `since` inside the server as the retired `cli.mjs watch` did over the socket, and wakes the main that asked with one line written here: no transcript, path, or monitor command (watch-read's unit view excludes them).
//
// Rate: at most one message per watch a minute, the newest state only (a pending line is replaced by a newer one, and one equal to the line last sent is dropped), at most 12 messages a session an hour across its watches; the changes
// after those come as one summary line when the hour turns. A held change is counted once, on its pending line (`heldBy`), whether a reading or the watch's minute brought it to the cap, and it counts as told only once the session took the summary; a summary
// not taken sends the changes on their own. `gone` and `expired` end the watch and always go out, counted. The session decides how a line lands (a follow-up while it is busy, a turn when idle: bosswatch.ts).
//
// Lifetime: the watches are kept in `watches.json` of the server's folder with what each last told, so a restart neither loses them nor repeats a change (a server's first stamp never matches, so its first verdict is a `changed` that
// carries the same facts). A watch ends at `gone`, `expired`, or a stop, or when its session has been off the net for 15 minutes (a revived main keeps its session id, and its watches with it).

export const RATE_MS = 60_000, HOUR_MS = 3_600_000, PER_HOUR = 12, PER_SESSION = 8, PER_SERVER = 64, MIN_MS = 60_000, UNTIL_MS = 6 * HOUR_MS, UNTIL_MAX_MS = 48 * HOUR_MS, OWNER_GRACE_MS = 15 * 60_000;
// A ward (ward.ts) is a watch whose key is `ward:<pane>`: its own read, its own line, and two more ends, `finished` and `dead`.
const RETRY_MS = 10_000, MAX_LINE = 600, ENDS = new Set(["gone", "expired", "finished", "dead"]);
/** What changes with every reading and is no state: a monitor's age, last line and load reading, and the note. */
const VOLATILE = new Set(["ageMs", "last", "note", "load"]);

export interface WatchAdd { session: string; workspace: string; key: string; quietMs?: number; idleMs?: number; untilMs?: number; ward?: WardRec }
export interface WatchesDeps {
	/** One hold of watch-read (watchread.ts `read`). */
	read(q: WatchQuery & { ward?: WardRec }): Promise<Reply>;
	now(): number;
	/** Runs `fn` after `ms` and returns its cancel; a test gives one on a clock it moves. */
	timer(ms: number, fn: () => void): () => void;
	/** Sends one line to the session as its workspace's tower identity: true when the session took it, false when it did not answer or refused (tried again a minute later). `id`: the change's own id, the same on every send of it, so a session drops one it took already (a send whose answer a restart lost). */
	send(to: { session: string; workspace: string }, text: string, facts: { key: string; state: string; id?: string }): Promise<boolean>;
	/** Whether the session is on the net now, and its workspace; none while the server has not read it. */
	owner(session: string): { live: boolean; workspace?: string } | undefined;
	/** `watches.json`; none keeps the watches in memory only. */
	file?: string;
	log?(event: string, facts: Record<string, string | number | boolean>): void;
}
interface Told { state: string; facts: string; at: number }
interface Watch extends WatchAdd { deadline: number; added: number; since?: string; told?: Told; sentAt: number; pending?: Told & { line: string; id: string; heldBy?: Bucket }; newest?: { state: string; line: string; at: number }; away?: number; fails: number; ended: boolean; sending?: boolean; timer?: () => void; restarted?: boolean }
interface Bucket { from: number; count: number; held: number; keys: Map<string, string>; timer?: () => void }

const no = (error: string): Reply => ({ ok: false, error });
const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const plain = (value: unknown, max = 80) => String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const span = (ms: number) => (ms % HOUR_MS === 0 ? `${ms / HOUR_MS}h` : `${Math.round(ms / 60_000)}m`);
const idOf = (session: string, key: string) => `${session}\n${key}`;
/** The facts of a verdict: the unit view and the waits without what moves at every reading. */
const factsOf = (r: Reply) => hash(JSON.stringify({ unit: r.unit ?? null, waits: r.waits ?? null, successor: r.successor ?? null }, (k, v) => (VOLATILE.has(k) ? undefined : v)));

/** The one line a main gets: `watch <key>: <state> · mark … · todo … · monitor …`. */
export function lineOf(key: string, r: Reply, w?: Pick<WatchAdd, "quietMs" | "idleMs">): string {
	if (typeof r.ward === "string") return plain(r.ward, MAX_LINE);
	const u = (r.unit ?? {}) as Record<string, unknown>, state = String(r.state);
	const head = state === "stalled" && w?.quietMs ? `stalled (quiet ${span(w.quietMs)})` : state === "idle" && w?.idleMs ? `idle (for ${span(w.idleMs)})` : state === "gone" && r.successor ? `gone (successor ${plain(r.successor)})` : state;
	const parts = [head];
	if (typeof u.mark === "string") parts.push(`mark ${u.mark}`);
	if (typeof u.state === "string") parts.push(`state ${plain(u.state)}`);
	const todo = u.todo as { done: number; total: number; now?: string } | undefined;
	if (todo) parts.push(`todo ${todo.done}/${todo.total}${todo.now ? ` ${plain(todo.now)}` : ""}`);
	for (const m of ((u.monitors ?? []) as ({ id: string; status: string; exit?: number; load?: { now: number; max: number } } | string)[]).slice(0, 3)) parts.push(typeof m === "string" ? `monitor ${plain(m, 60)}` : `monitor ${plain(m.id, 40)}: ${m.status}${m.exit !== undefined ? ` exit ${m.exit}` : ""}${m.load ? `, load ${m.load.now}/${m.load.max}` : ""}`);
	// A teammate device (linkwatch.ts): its mains' states and its board, so the line says what a change was about.
	const mains = Array.isArray(u.mains) ? (u.mains as { state: string }[]) : undefined, board = u.board as { online: boolean; entries: number; capacity?: { points: number; budget?: number; paused: number } } | undefined;
	if (mains?.length) parts.push(`mains ${mains.length} (${[...new Set(mains.map((m) => plain(m.state, 20)))].map((s) => `${mains.filter((m) => plain(m.state, 20) === s).length} ${s}`).join(", ")})`);
	if (board) parts.push(`board ${board.entries} entr${board.entries === 1 ? "y" : "ies"}${board.online ? "" : ", offline"}${board.capacity ? ` · capacity ${board.capacity.points}${board.capacity.budget !== undefined ? `/${board.capacity.budget}` : ""} pts${board.capacity.paused ? `, ${board.capacity.paused} paused` : ""}` : ""}`);
	const train = u.train as { status: string; step?: string } | undefined;
	if (train) parts.push(`train ${train.status}${train.step ? ` at ${plain(train.step)}` : ""}`);
	const subs = (u.subs ?? []) as { name: string; mark: string }[];
	if (subs.length) parts.push(`subagents ${subs.slice(0, 4).map((s) => `${plain(s.name, 30)} ${s.mark}`).join(", ")}${subs.length > 4 ? ` +${subs.length - 4}` : ""}`);
	if (Array.isArray(r.waits) && r.waits.length) parts.push(`${r.waits.length} link wait${r.waits.length > 1 ? "s" : ""}`);
	return `watch ${plain(key, 200)}: ${parts.join(" · ")}`.slice(0, MAX_LINE);
}

export function createWatches(d: WatchesDeps) {
	const watches = new Map<string, Watch>(), buckets = new Map<string, Bucket>();
	let stopped = false;
	const pause = (ms: number) => new Promise<void>((resolve) => void d.timer(ms, resolve));
	/** The wards are kept apart, in `wards.json` beside `watches.json` (ward-review F005): a server of an older build reads only `watches.json`, so it never takes a ward for a plain watch that is gone and drops it from the file. */
	const write = (file: string, rows: unknown[]) => {
		writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, watches: rows }), { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	};
	const wardsFile = (file: string) => join(dirname(file), "wards.json");
	const save = () => {
		if (!d.file) return;
		// A change not taken yet is kept with the `since` that found it (ward-review F004): a restart sends it, where the read's next verdict would say `unchanged`.
		const rows = [...watches.values()].map(({ session, workspace, key, quietMs, idleMs, deadline, added, since, told, sentAt, ward, pending }) => ({ session, workspace, key, quietMs, idleMs, deadline, added, since, told, sentAt, ward, ...(pending ? { pending: { state: pending.state, facts: pending.facts, at: pending.at, line: pending.line, id: pending.id } } : {}) }));
		try {
			write(d.file, rows.filter((r) => !r.ward));
			write(wardsFile(d.file), rows.filter((r) => r.ward));
		} catch (error) {
			d.log?.("watch-save-failed", { text: plain((error as Error).message, 200) });
		}
	};
	const end = (w: Watch, why: string) => {
		if (w.ended) return;
		w.ended = true;
		w.timer?.();
		if (watches.get(idOf(w.session, w.key)) === w) watches.delete(idOf(w.session, w.key));
		save();
		d.log?.("watch-end", { session: w.session.slice(0, 8), key: plain(w.key, 80), why });
	};
	const bucketOf = (session: string, at: number) => {
		let b = buckets.get(session);
		// An hour with changes held stays until its summary went out, which a timer late under load runs after the hour: a new bucket in its place would drop the summary.
		if (!b || (at - b.from >= HOUR_MS && !b.timer)) buckets.set(session, (b = { from: at, count: 0, held: 0, keys: new Map() }));
		return b;
	};
	/** The hour of a session turned with changes held: one line names how many and the newest state of each watch they were on. */
	const turn = async (session: string, b: Bucket) => {
		if (buckets.get(session) !== b) return;
		buckets.delete(session);
		const mine = [...watches.values()].filter((w) => w.session === session && !w.ended), held = mine.flatMap((w) => (w.pending?.heldBy === b ? [[w, w.pending] as const] : []));
		const to = mine[0];
		if (!to || !b.held) return;
		const text = `watch: ${b.held} more watch change${b.held > 1 ? "s" : ""} in the last hour were held (at most ${PER_HOUR} messages an hour); newest: ${[...b.keys].map(([key, state]) => `${plain(key, 60)} ${state}`).join("; ")}. boss_watch with no key lists every watch.`.slice(0, MAX_LINE);
		const next = bucketOf(session, d.now());
		next.count++;
		const sent = await d.send({ session, workspace: to.workspace }, text, { key: "*", state: "summary" }).catch(() => false);
		if (!sent) (next.count--, d.log?.("watch-undelivered", { session: session.slice(0, 8), key: "*" }));
		// A change still waiting for its watch's minute was not held and goes out when the minute ends; one replaced while the summary went out is the newer line's to send.
		for (const [w, p] of held) {
			if (w.ended || w.pending !== p) continue;
			if (sent) (w.told = { state: p.state, facts: p.facts, at: d.now() }), (w.pending = undefined);
			else (p.heldBy = undefined), flush(w);
		}
		save();
	};
	const flush = (w: Watch): void => {
		if (w.ended || !w.pending || w.sending || stopped) return;
		const at = d.now(), wait = w.sentAt + RATE_MS - at;
		if (wait > 0) return void (w.timer ??= d.timer(wait, () => ((w.timer = undefined), flush(w))));
		const b = bucketOf(w.session, at);
		if (!ENDS.has(w.pending.state) && b.count >= PER_HOUR) {
			if (w.pending.heldBy !== b) ((w.pending.heldBy = b), b.held++);
			b.keys.set(w.key, w.pending.state);
			b.timer ??= d.timer(b.from + HOUR_MS - at, () => void turn(w.session, b));
			return;
		}
		void deliver(w, b);
	};
	const deliver = async (w: Watch, b: Bucket) => {
		const p = w.pending!;
		[w.sending, w.sentAt] = [true, d.now()];
		b.count++;
		const sent = await d.send({ session: w.session, workspace: w.workspace }, p.line, { key: w.key, state: p.state, id: p.id }).catch(() => false);
		w.sending = false;
		if (!sent) {
			b.count--;
			d.log?.("watch-undelivered", { session: w.session.slice(0, 8), key: plain(w.key, 80), state: p.state });
			if (ENDS.has(p.state) && ++w.fails >= 3) return end(w, `${p.state}, undelivered`);
			return flush(w);
		}
		w.fails = 0;
		w.told = { state: p.state, facts: p.facts, at: w.sentAt };
		if (w.pending === p) w.pending = undefined;
		save();
		if (ENDS.has(p.state)) return end(w, p.state);
		flush(w);
	};
	/** A verdict other than `unchanged`: the newest state, sent when the rate allows unless it is what was told last. */
	const note = (w: Watch, r: Reply) => {
		const state = String(r.state), facts = factsOf(r), line = lineOf(w.key, r, w), at = d.now();
		w.newest = { state, line, at };
		// A `changed` that carries the facts told last is no change (a state that came and went, or a restarted server's first verdict); after a restart a repeat of the last state is none either.
		if (w.told && w.told.facts === facts && (state === "changed" || (w.restarted && w.told.state === state))) return void ((w.pending = undefined), save());
		w.restarted = false;
		w.pending = { state, facts, line, at, id: hash(`${w.session}\n${w.key}\n${state}\n${facts}\n${at}`) };
		save();
		flush(w);
	};
	const owned = (w: Watch) => {
		const o = d.owner(w.session), at = d.now();
		if (o?.live) return void ((w.away = undefined), o.workspace && (w.workspace = o.workspace));
		w.away ??= at;
		if (at - w.away >= OWNER_GRACE_MS) end(w, "session left the net");
	};
	const loop = async (w: Watch) => {
		while (!w.ended && !stopped) {
			const began = d.now();
			const r = await d.read({ key: w.key, ...(w.since ? { since: w.since } : {}), ...(w.quietMs ? { quietMs: w.quietMs } : {}), ...(w.idleMs ? { idleMs: w.idleMs } : {}), deadline: w.deadline, ...(w.ward ? { ward: w.ward } : {}) }).catch((error: Error): Reply => no(error.message));
			if (w.ended || stopped) return;
			owned(w);
			if (w.ended) return;
			if (!r.ok) {
				if (String(r.error).startsWith("unknown key")) return note(w, { ok: true, state: "gone" });
				await pause(RETRY_MS);
				continue;
			}
			// The new `since` and the change it found are saved together (note saves), so a restart between them loses no change.
			const moved = typeof r.since === "string" && r.since !== w.since;
			if (moved) w.since = r.since as string;
			if (r.state !== "unchanged") note(w, r);
			else if (moved) save();
			if (ENDS.has(String(r.state))) return;
			if (r.state === "unchanged" && (w.ward || d.now() - began < 1000)) await pause(w.ward ? WARD_LOOK_MS : 2000); // a hold that answers at once is not asked in a tight loop; a ward looks every 20 s
		}
	};
	const span1 = (v: unknown, name: string, min: number, max: number): string | undefined => (v === undefined ? undefined : typeof v !== "number" || !Number.isFinite(v) || v < min ? `${name} is at least ${span(min)}` : v > max ? `${name} is at most ${span(max)}` : undefined);

	return {
		/** One watch of a session on a key; the same key again replaces it. Answers with the unit's state now, which is what the first change is measured against. */
		async add(q: WatchAdd): Promise<Reply> {
			if (typeof q.session !== "string" || !q.session || q.session.length > 128 || typeof q.workspace !== "string" || !q.workspace) return no("watch-add needs session and workspace");
			if (typeof q.key !== "string" || q.key.length < 1 || q.key.length > 200) return no("key is 1 to 200 characters");
			const bad = span1(q.quietMs, "quiet", MIN_MS, UNTIL_MAX_MS) ?? span1(q.idleMs, "idle", MIN_MS, UNTIL_MAX_MS) ?? span1(q.untilMs, "until", MIN_MS, UNTIL_MAX_MS);
			if (bad) return no(bad);
			const id = idOf(q.session, q.key), all = [...watches.values()];
			if (all.filter((w) => w.session === q.session && w.key !== q.key).length >= PER_SESSION) return no(`at most ${PER_SESSION} watches per session: stop one first (boss_watch with stop)`);
			if (all.length - (watches.has(id) ? 1 : 0) >= PER_SERVER) return no(`at most ${PER_SERVER} watches on this server`);
			const at = d.now(), deadline = at + (q.untilMs ?? UNTIL_MS);
			const first = await d.read({ key: q.key, ...(q.quietMs ? { quietMs: q.quietMs } : {}), ...(q.idleMs ? { idleMs: q.idleMs } : {}), deadline, ...(q.ward ? { ward: q.ward } : {}) }).catch((error: Error): Reply => no(error.message));
			if (!first.ok) return first;
			if (ENDS.has(String(first.state))) return no(`${q.key} is ${String(first.state)}: there is nothing to watch`);
			const old = watches.get(id);
			if (old) end(old, "replaced");
			const w: Watch = { session: q.session, workspace: q.workspace, key: q.key, ...(q.quietMs ? { quietMs: q.quietMs } : {}), ...(q.idleMs ? { idleMs: q.idleMs } : {}), ...(q.ward ? { ward: q.ward } : {}), deadline, added: at, ...(typeof first.since === "string" ? { since: first.since } : {}), told: { state: String(first.state), facts: factsOf(first), at }, sentAt: 0, fails: 0, ended: false };
			w.newest = { state: String(first.state), line: lineOf(q.key, first, w), at };
			watches.set(id, w);
			save();
			void loop(w);
			return { ok: true, watch: { key: q.key, until: deadline, line: w.newest.line } };
		},
		stop(session: string, key: string): Reply {
			const w = watches.get(idOf(session, key));
			if (!w) return no(`no watch of this session on ${key}`);
			end(w, "stop");
			return { ok: true };
		},
		/** A session's watches: each with its options, its newest state, and what was last sent. */
		list(session: string): Reply {
			const rows = [...watches.values()].filter((w) => w.session === session).map((w) => ({ key: w.key, ...(w.ward ? { ward: { pane: w.ward.pane, file: w.ward.file, ...(w.ward.item ? { item: w.ward.item } : {}) } } : {}), ...(w.quietMs ? { quietMs: w.quietMs } : {}), ...(w.idleMs ? { idleMs: w.idleMs } : {}), until: w.deadline, ...(w.newest ? { newest: w.newest } : {}), ...(w.told && w.sentAt ? { sent: { state: w.told.state, at: w.sentAt } } : {}), ...(w.pending ? { pending: w.pending.state } : {}) }));
			return { ok: true, watches: rows };
		},
		has: (session: string) => [...watches.values()].some((w) => w.session === session),
		/** The server's start: the watches of the last one come back and their loops resume. */
		start() {
			if (!d.file) return;
			const rows = [d.file, wardsFile(d.file)].flatMap((file) => { try { return (JSON.parse(readFileSync(file, "utf8")) as { watches?: unknown[] }).watches ?? []; } catch { return []; } }); // none yet, or unreadable: no watches
			for (const row of rows.slice(0, PER_SERVER) as Partial<Watch>[]) {
				if (typeof row.session !== "string" || typeof row.workspace !== "string" || typeof row.key !== "string" || typeof row.deadline !== "number" || watches.has(idOf(row.session, row.key))) continue;
				const told = row.told && typeof row.told.facts === "string" && typeof row.told.state === "string" ? row.told : undefined;
				const ward = wardOf(row.ward);
				if (row.key.startsWith("ward:") && !ward) continue;
				const p = row.pending, pending = p && typeof p.state === "string" && typeof p.facts === "string" && typeof p.line === "string" && typeof p.id === "string" && typeof p.at === "number" ? { state: p.state, facts: p.facts, line: p.line, id: p.id, at: p.at } : undefined;
				const w: Watch = { session: row.session, workspace: row.workspace, key: row.key, ...(ward ? { ward } : {}), ...(pending ? { pending } : {}), ...(typeof row.quietMs === "number" ? { quietMs: row.quietMs } : {}), ...(typeof row.idleMs === "number" ? { idleMs: row.idleMs } : {}), deadline: row.deadline, added: typeof row.added === "number" ? row.added : d.now(), ...(typeof row.since === "string" ? { since: row.since } : {}), ...(told ? { told } : {}), sentAt: typeof row.sentAt === "number" ? row.sentAt : 0, fails: 0, ended: false, restarted: true };
				watches.set(idOf(w.session, w.key), w);
				void loop(w);
				flush(w);
			}
		},
		/** The server leaves: the loops and timers stop, and the file keeps the watches for the next one. */
		stopAll() {
			stopped = true;
			for (const w of watches.values()) w.timer?.();
			for (const b of buckets.values()) b.timer?.();
		},
	};
}
export type Watches = ReturnType<typeof createWatches>;
