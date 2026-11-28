import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LifecycleProjection } from "@nubl/maestro/core/lifecycle";
import { encodeHostValue, HOST_PATH_CHARS } from "@nubl/maestro/core/host-text";
import { formatElapsedDuration, normalizeStatusName } from "@nubl/maestro/core/status";
import type { Locale } from "../locale.ts";

// The done nudge (docs/specs/2026-11-28-done-nudge.md; boss 2026-11-28 「subagent idle/finished 太久，也要提醒他們做 subagent done」): a child of sb's host whose turn has ended
// (Maestro's `waiting` projection) and that has sat `idleMs` without a result is asked to finish, once per idle stretch and `max` times in all; then the parent is told once.
// This is the parent's half, called from the status loop that already looks at every child each second (widgets.ts). The child's own pi delivers the nudge
// (nudge-child.ts), since only the extension that owns the input box can tell a draft is there: the parent writes a request into the run's folder beside the
// child's session file and reads its ack. An auto-exit child is never nudged: a fresh turn there makes Maestro deliver it as done, finished or not.

/** The folder beside a child's session file that holds the requests of all its runs, one subfolder per run. */
export const NUDGE_SUFFIX = ".sb-nudge";
/** A request with no ack this long gets none: the parent says so and stops asking. */
export const ACK_MS = 60_000;
/** After an ack that sent nothing (`draft`, `busy`, `stale`), the next request waits this long. */
export const RETRY_MS = 60_000;
/** A request older than this when the child reads it is `stale`: its parent may have revoked it, or gone (F007). */
export const REQUEST_MS = 20_000;
/** A parent's notice that pi has not confirmed is sent again this long after, doubling each time up to 10 minutes, and only while the parent is idle (F009). */
export const RESEND_MS = 30_000;
const CONFIG_MS = 15_000;
const MIN = 60_000;

export interface NudgeSettings { idleMs: number; max: number }
export const DEFAULT_NUDGE: NudgeSettings = { idleMs: 10 * MIN, max: 2 };

/** `subagentNudge` of `<stateDir>/config.json`: `idleMinutes` 0 to 1440 (0 is off), `max` a whole number 1 to 10; anything else, or no readable file, is the default. */
export function readNudgeSettings(stateDir: string): NudgeSettings {
	let raw: { idleMinutes?: unknown; max?: unknown } | undefined;
	try {
		raw = (JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8").replace(/^\uFEFF/, "")) as { subagentNudge?: typeof raw } | null)?.subagentNudge;
	} catch {
		return { ...DEFAULT_NUDGE };
	}
	const idle = raw?.idleMinutes, max = raw?.max;
	return {
		idleMs: typeof idle === "number" && Number.isFinite(idle) && idle >= 0 && idle <= 1440 ? Math.round(idle * MIN) : DEFAULT_NUDGE.idleMs,
		max: typeof max === "number" && Number.isInteger(max) && max >= 1 && max <= 10 ? max : DEFAULT_NUDGE.max,
	};
}

const minutes = (ms: number) => {
	const n = Math.max(1, Math.round(ms / MIN));
	return `${n} minute${n === 1 ? "" : "s"}`;
};

/** The mark of a request in its nudge's text: the child acks `sent` only for a message that carries the mark of the request in flight (F008). */
export const nudgeMark = (id: string) => `reminder ${id.slice(-8)}`;

/** What the child is told, marked with its request. Only a child with subagent_done gets it: an auto-exit child is never nudged. */
export function nudgeText(idleMs: number, id: string): string {
	return `Straw Boss (${nudgeMark(id)}): you have been idle for ${minutes(idleMs)}, and your caller still has no result from you. If your task is done, write your final report now and call subagent_done. If you truly wait on your caller (a decision, an access, or an answer only it can give), say so with caller_ping. If you wait on work of your own that will wake you (a monitor, a loop, your own subagents), reply in one line with what it is and when it ends.`;
}

/** The run's folder: `<session>.sb-nudge/<run id>`, so a resumed run on the same session file never sees another run's request. */
export function nudgeDir(sessionFile: string, runId: string): string {
	return join(sessionFile + NUDGE_SUFFIX, encodeURIComponent(runId).replace(/\./g, "%2E"));
}
export const requestFile = (dir: string, id: string) => join(dir, `${id}.req`);
export const ackFile = (dir: string, id: string) => join(dir, `${id}.ack`);
/** A request id: unique across parent reloads, and safe as a file name. */
export const isRequestId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(id);

/** `at` is when the parent wrote it, on the clock child and parent share: the child refuses it when a turn started since. */
export interface NudgeRequest { v: 2; id: string; runId: string; sessionFile: string; at: number; idleMs: number }
/**
 * `sent`: the child saw the nudge enter its session as a user message. `draft`, `busy`: it sent nothing. `stale`: a turn started after the request was written.
 * `lost`: it sent the nudge but never saw it enter. `auto-exit`: it closes when a turn ends, so it sent nothing and never will.
 */
export type NudgeOutcome = "sent" | "draft" | "busy" | "stale" | "lost" | "auto-exit";
export interface NudgeAck { v: 2; id: string; runId: string; outcome: NudgeOutcome; at: number }
const OUTCOMES: readonly string[] = ["sent", "draft", "busy", "stale", "lost", "auto-exit"] satisfies NudgeOutcome[];

/** Writes `value` as `file` by rename, so a reader never sees half of it. */
export function writeAtomic(file: string, value: unknown): void {
	const temp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

export function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** Removes `file`; true when it was there and is gone, false when it was already gone (or cannot be removed now). */
export function take(file: string): boolean {
	try {
		rmSync(file);
		return true;
	} catch {
		return false;
	}
}

/** Removes the run's folder and the session's once empty; a folder another request still uses stays. */
export function tidy(dir: string): void {
	for (const d of [dir, dirname(dir)]) {
		try {
			rmdirSync(d);
		} catch {
			return;
		}
	}
}

/** What the nudger reads of a running child (Maestro's RunningSubagent). */
export interface NudgeRun { id: string; name: string; sessionFile: string; interactive: boolean; persistent?: boolean; cancelState?: string }

interface RunState {
	/** Nudges the child saw enter its session. */
	sent: number;
	/** Nudges the child sent but never saw enter: no delivery, yet one of the `max` tries, since one may have gone in. */
	lost: number;
	/** When the last one was sent: it starts a stretch of its own. */
	lastSentAt?: number;
	/** When the idleness the notice reports began: the stretch of the first request. */
	idleFrom?: number;
	/** The open request: its id, when it was written, and the idle stretch it was written for. */
	pending?: { id: string; at: number; since: number | undefined };
	retryAt?: number;
	done?: true;
}

/** A notice for the parent: it leaves the queue only once pi confirms the message that carries it started in the parent's session. */
interface Notice { id: string; text: string; sentAt?: number; tries: number }

/**
 * What the nudger keeps, in a process-wide slot (sharedNudgeStore), so a reload's new nudger takes over the counts, the notices not yet confirmed, and
 * the requests the old one revoked (F007, F009).
 */
export interface NudgeStore {
	runs: Map<string, { dir: string; run: NudgeRun; state: RunState }>;
	queue: Notice[];
	/** Requests revoked after the child took them: an ack that still comes is removed, until no child may write one. */
	revoked: { dir: string; id: string; until: number }[];
}

export const newNudgeStore = (): NudgeStore => ({ runs: new Map(), queue: [], revoked: [] });

const STORE_KEY = Symbol.for("pi-straw-boss/done-nudge/v1");
/** The store of this process: it outlives a reload, not a restart. A new shape takes a new key. */
export function sharedNudgeStore(): NudgeStore {
	const slot = globalThis as { [STORE_KEY]?: NudgeStore };
	return (slot[STORE_KEY] ??= newNudgeStore());
}

export interface Nudger {
	/** One look at a running child: may write or revoke a request, and may queue a notice for the parent. */
	look(run: NudgeRun, projection: LifecycleProjection, now: number): void;
	/** The notices to send now, oldest first: those not sent, and those sent that pi has not confirmed when they are due again and `idle` says pi holds no turn that could still take them. Each returned counts as sent at `now`. */
	outbox(now: number, idle: boolean): readonly { id: string; text: string }[];
	/** The send of these threw: they go at the next tick. */
	unsent(ids: readonly string[]): void;
	/** A message started in the parent's session: the notices it carries (`details.nudgeNotices` of a `subagent_status`) leave the queue. */
	accepted(message: unknown): void;
	/** Notices pi has not confirmed yet. */
	undelivered(): number;
	/** Forgets the runs not in `live`, removing their open requests, and removes the late acks of revoked requests. */
	prune(live: Iterable<string>, now: number): void;
	/** The parent stops looking (a reload, a quit): every open request is revoked, an ack already there counted. */
	stop(now: number): void;
}

export interface NudgerDeps { settings(): NudgeSettings; locale(): Locale; newId?: () => string; store?: NudgeStore }

type NoticeKind = "gave-up" | "no-ack" | "auto-exit";
/** No child writes an ack this long after its request was written (nudge-child.ts), so a revoked request's late ack is watched for this long. */
const LATE_MS = 2 * ACK_MS;
const RESEND_MAX_MS = 10 * MIN;

export function createNudger(deps: NudgerDeps): Nudger {
	const store = deps.store ?? newNudgeStore();
	const { runs, queue, revoked } = store;
	const newId = deps.newId ?? randomUUID;
	let cached: { at: number; value: NudgeSettings } | undefined;
	const settings = (now: number) => {
		if (!cached || now - cached.at >= CONFIG_MS || now < cached.at) cached = { at: now, value: deps.settings() };
		return cached.value;
	};
	const notice = (run: NudgeRun, s: RunState, now: number, kind: NoticeKind) => {
		const name = encodeHostValue(normalizeStatusName(run.name)), file = encodeHostValue(run.sessionFile, HOST_PATH_CHARS);
		const idle = formatElapsedDuration(Math.max(0, now - (s.idleFrom ?? now)));
		if (deps.locale() === "zh-TW") {
			const next = `請看它的窗格；要停掉它用 subagent_cancel，之後要接著做，用 subagent_resume 帶它的 session 檔（${file}）。`;
			const lost = s.lost ? `（其中 ${s.lost} 次它的 pi 無法確認已送進它的 session）` : "";
			if (kind === "gave-up") return `${name} 已閒置 ${idle}，還沒交回結果；Straw Boss 已提醒它收尾 ${s.sent + s.lost} 次${lost}，不會再提醒。${next}`;
			if (kind === "auto-exit") return `${name} 已閒置 ${idle}，還沒交回結果。Straw Boss 沒有提醒它：它一輪結束就會關閉，提醒會讓它把沒做完的工作當成結果交回。${next}`;
			return `${name} 還沒交回結果；Straw Boss 要提醒它收尾，但它的 pi 一分鐘內沒有回應這個請求，所以不會再提醒。${next}`;
		}
		const next = `Read its pane; subagent_cancel stops it, and subagent_resume with its session file (${file}) continues it later.`;
		const tries = s.sent + s.lost;
		const lost = s.lost ? ` (its pi could not confirm that ${s.lost === tries ? (tries === 1 ? "it" : "they") : `${s.lost} of them`} entered its session)` : "";
		if (kind === "gave-up")
			return `${name} has been idle ${idle} and has not delivered its result, after ${tries} reminder${tries === 1 ? "" : "s"} to finish${lost}. Straw Boss will not remind it again. ${next}`;
		if (kind === "auto-exit")
			return `${name} has been idle ${idle} and has not delivered its result. Straw Boss did not remind it: it closes when a turn ends, so a reminder would close it and deliver its unfinished work as done. ${next}`;
		return `${name} has not delivered its result, and its pi sent no acknowledgement of Straw Boss's reminder request within a minute, so Straw Boss will not remind it. ${next}`;
	};
	const tell = (run: NudgeRun, s: RunState, now: number, kind: NoticeKind) => {
		s.done = true;
		queue.push({ id: randomUUID(), text: notice(run, s, now, kind), tries: 0 });
	};
	/** Removes the files of the open request, never another's, and forgets it. One the child took and has not acked yet is watched for its late ack (F007). */
	const close = (dir: string, s: RunState): boolean => {
		const p = s.pending;
		if (!p) return false;
		const tookRequest = take(requestFile(dir, p.id));
		const awaited = !take(ackFile(dir, p.id)) && !tookRequest;
		if (awaited) revoked.push({ dir, id: p.id, until: p.at + LATE_MS });
		tidy(dir);
		s.pending = undefined;
		return awaited;
	};
	/** Takes in the open request's ack when it is there; false when there is none to read. */
	const settle = (dir: string, run: NudgeRun, s: RunState, now: number): boolean => {
		const p = s.pending;
		if (!p) return false;
		const ack = readJson<NudgeAck>(ackFile(dir, p.id));
		if (!(ack?.v === 2 && ack.id === p.id && ack.runId === run.id && OUTCOMES.includes(ack.outcome))) return false;
		close(dir, s);
		if (ack.outcome === "auto-exit") tell(run, s, now, "auto-exit");
		else if (ack.outcome === "sent" || ack.outcome === "lost") {
			if (ack.outcome === "sent") s.sent++;
			else s.lost++;
			s.lastSentAt = typeof ack.at === "number" && Number.isFinite(ack.at) ? Math.min(ack.at, now) : now;
		} else s.retryAt = now + RETRY_MS;
		return true;
	};

	return {
		look(run, projection, now) {
			if (run.interactive || run.persistent) return;
			let entry = runs.get(run.id);
			if (!entry) runs.set(run.id, (entry = { dir: nudgeDir(run.sessionFile, run.id), run, state: { sent: 0, lost: 0 } }));
			entry.run = run;
			const s = entry.state, dir = entry.dir;
			// A cancel revokes the open request, so a child that outlives it takes nothing.
			if (run.cancelState) return void close(dir, s);
			if (s.done) return;
			if (s.pending) {
				const p = s.pending;
				if (settle(dir, run, s, now)) {
					if (s.done) return;
				} else if (now - p.at >= ACK_MS) {
					close(dir, s);
					return tell(run, s, now, "no-ack");
				} else if (projection.kind !== "waiting" || projection.stateDurationSince !== p.since) {
					// The idle stretch it was written for ended. Still there: revoked. Gone: the child took it, and its ack is still to come.
					if (!take(requestFile(dir, p.id))) return;
					take(ackFile(dir, p.id));
					tidy(dir);
					s.pending = undefined;
				} else return;
			}
			if (projection.kind !== "waiting") return;
			const cfg = settings(now);
			if (!cfg.idleMs) return;
			const since = projection.stateDurationSince ?? now;
			const quietSince = Math.max(since, s.lastSentAt ?? -Infinity);
			if (now - quietSince < cfg.idleMs) return;
			if (s.sent + s.lost >= cfg.max) return tell(run, s, now, "gave-up");
			if (s.retryAt !== undefined && now < s.retryAt) return;
			s.idleFrom ??= since;
			const id = newId();
			try {
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				writeAtomic(requestFile(dir, id), { v: 2, id, runId: run.id, sessionFile: run.sessionFile, at: now, idleMs: now - quietSince } satisfies NudgeRequest);
			} catch {
				// A request that cannot be written is tried again a minute later.
				s.retryAt = now + RETRY_MS;
				return;
			}
			s.pending = { id, at: now, since: projection.stateDurationSince };
			s.retryAt = undefined;
		},
		outbox(now, idle) {
			const due = queue.filter((n) => n.sentAt === undefined || (idle && now - n.sentAt >= Math.min(RESEND_MS * 2 ** Math.max(0, n.tries - 1), RESEND_MAX_MS)));
			for (const n of due) {
				n.sentAt = now;
				n.tries++;
			}
			return due.map(({ id, text }) => ({ id, text }));
		},
		unsent(ids) {
			for (const n of queue) if (ids.includes(n.id)) n.sentAt = undefined;
		},
		accepted(message) {
			const m = message as { role?: unknown; customType?: unknown; details?: { nudgeNotices?: unknown } } | undefined;
			if (m?.role !== "custom" || m.customType !== "subagent_status" || !Array.isArray(m.details?.nudgeNotices)) return;
			const ids: unknown[] = m.details.nudgeNotices;
			for (let i = queue.length - 1; i >= 0; i--) if (ids.includes(queue[i].id)) queue.splice(i, 1);
		},
		undelivered: () => queue.length,
		prune(live, now) {
			const keep = new Set(live);
			for (const [id, entry] of runs) {
				if (keep.has(id)) continue;
				close(entry.dir, entry.state);
				runs.delete(id);
			}
			for (let i = revoked.length - 1; i >= 0; i--) {
				const r = revoked[i];
				if (take(ackFile(r.dir, r.id))) tidy(r.dir);
				if (now >= r.until) revoked.splice(i, 1);
			}
		},
		stop(now) {
			for (const { dir, run, state: s } of runs.values()) {
				if (!s.pending || settle(dir, run, s, now)) continue;
				// Taken but not acked: the nudge may be in. The next request waits, so a reload does not ask twice in a row.
				if (close(dir, s)) s.retryAt = now + RETRY_MS;
			}
		},
	};
}
