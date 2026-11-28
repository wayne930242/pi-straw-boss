import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LifecycleProjection } from "@nubl/maestro/core/lifecycle";
import { encodeHostValue, HOST_PATH_CHARS } from "@nubl/maestro/core/host-text";
import { formatElapsedDuration, normalizeStatusName } from "@nubl/maestro/core/status";
import type { Locale } from "../locale.ts";

// The done nudge (docs/specs/2026-11-28-done-nudge.md; boss 2026-11-28 「subagent idle/finished 太久，也要提醒他們做 subagent done」): a child of sb's host whose turn has ended
// (Maestro's `waiting` projection) and that has sat `idleMs` without a result is asked to finish, once per idle stretch and `max` times in all; then the parent is told once.
// This is the parent's half, called from the status loop that already looks at every child each second (widgets.ts). The child's own pi delivers the nudge
// (nudge-child.ts), since only the extension that owns the input box can tell a draft is there: the parent writes a request beside the child's session file and reads its ack.

export const NUDGE_SUFFIX = ".sb-nudge", ACK_SUFFIX = ".sb-nudge-ack";
/** A request with no ack this long is one the child's pi cannot take (an older Straw Boss started it). */
export const ACK_MS = 60_000;
/** After a `draft` or `busy` ack, the next request waits this long. */
export const RETRY_MS = 60_000;
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

/** What the child is told: `autoExit` children have no subagent_done and finish by ending a turn normally. */
export function nudgeText(autoExit: boolean, idleMs: number): string {
	const head = `Straw Boss: you have been idle for ${minutes(idleMs)}, and your caller still has no result from you.`;
	const ping = "If you truly wait on your caller (a decision, an access, or an answer only it can give), say so with caller_ping.";
	return autoExit
		? `${head} If your task is done, end this turn with your final report: this session then closes and delivers it. ${ping}`
		: `${head} If your task is done, write your final report now and call subagent_done. ${ping} If you wait on work of your own that will wake you (a monitor, a loop, your own subagents), reply in one line with what it is and when it ends.`;
}

export interface NudgeRequest { v: 1; id: string; idleMs: number }
export type NudgeOutcome = "sent" | "draft" | "busy";
export interface NudgeAck { v: 1; id: string; outcome: NudgeOutcome; at: number }

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

/** What the nudger reads of a running child (Maestro's RunningSubagent). */
export interface NudgeRun { id: string; name: string; sessionFile: string; interactive: boolean; persistent?: boolean; cancelState?: string }

interface RunState {
	n: number;
	/** Nudges the child took. */
	sent: number;
	/** When the last one was taken: it starts a stretch of its own. */
	lastSentAt?: number;
	/** When the idleness the notice reports began: the stretch of the first request. */
	idleFrom?: number;
	pending?: { id: string; at: number };
	retryAt?: number;
	done?: true;
}

export interface Nudger {
	/** One look at a running child: may write a request, and returns the parent's notice when there is one. */
	look(run: NudgeRun, projection: LifecycleProjection, now: number): string | undefined;
	/** Forgets the runs not in `live`, removing their open requests. */
	prune(live: Iterable<string>): void;
}

export interface NudgerDeps { settings(): NudgeSettings; locale(): Locale }

const remove = (file: string) => {
	try { rmSync(file, { force: true }); } catch { /* the next look or the child removes it */ }
};

export function createNudger(deps: NudgerDeps): Nudger {
	const runs = new Map<string, { file: string; state: RunState }>();
	let cached: { at: number; value: NudgeSettings } | undefined;
	const settings = (now: number) => {
		if (!cached || now - cached.at >= CONFIG_MS || now < cached.at) cached = { at: now, value: deps.settings() };
		return cached.value;
	};
	const notice = (run: NudgeRun, s: RunState, now: number, kind: "gave-up" | "unreachable") => {
		const name = encodeHostValue(normalizeStatusName(run.name)), file = encodeHostValue(run.sessionFile, HOST_PATH_CHARS);
		const idle = formatElapsedDuration(Math.max(0, now - (s.idleFrom ?? now)));
		if (deps.locale() === "zh-TW") {
			const next = `請看它的窗格；要停掉它用 subagent_cancel，之後要接著做，用 subagent_resume 帶它的 session 檔（${file}）。`;
			return kind === "gave-up"
				? `${name} 已閒置 ${idle}，還沒交回結果；Straw Boss 已提醒它收尾 ${s.sent} 次，不會再提醒。${next}`
				: `${name} 已閒置 ${idle}，還沒交回結果，而 Straw Boss 無法提醒它：它的 pi 沒有接收提醒（它是較舊版的 Straw Boss 啟動的）。${next}`;
		}
		const next = `Read its pane; subagent_cancel stops it, and subagent_resume with its session file (${file}) continues it later.`;
		return kind === "gave-up"
			? `${name} has been idle ${idle} and has not delivered its result, after ${s.sent} reminder${s.sent === 1 ? "" : "s"} to finish. Straw Boss will not remind it again. ${next}`
			: `${name} has been idle ${idle} and has not delivered its result, and Straw Boss could not remind it: its pi took no reminder (it was started by an older Straw Boss). ${next}`;
	};

	return {
		look(run, projection, now) {
			if (run.interactive || run.persistent || run.cancelState) return undefined;
			let entry = runs.get(run.id);
			if (!entry) runs.set(run.id, (entry = { file: run.sessionFile, state: { n: 0, sent: 0 } }));
			const s = entry.state, file = run.sessionFile;
			if (s.done) return undefined;
			if (s.pending) {
				const ack = readJson<NudgeAck>(file + ACK_SUFFIX);
				if (ack?.id === s.pending.id) {
					// The child consumed the request before it acked; removed here too, so none outlives its answer.
					remove(file + ACK_SUFFIX);
					remove(file + NUDGE_SUFFIX);
					if (ack.outcome === "sent") {
						s.sent++;
						s.lastSentAt = typeof ack.at === "number" && Number.isFinite(ack.at) ? Math.min(ack.at, now) : now;
					} else s.retryAt = now + RETRY_MS;
					s.pending = undefined;
				} else if (now - s.pending.at >= ACK_MS) {
					remove(file + NUDGE_SUFFIX);
					s.pending = undefined;
					s.done = true;
					return notice(run, s, now, "unreachable");
				} else return undefined;
			}
			if (projection.kind !== "waiting") return undefined;
			const cfg = settings(now);
			if (!cfg.idleMs) return undefined;
			const since = projection.stateDurationSince ?? now;
			const quietSince = Math.max(since, s.lastSentAt ?? -Infinity);
			if (now - quietSince < cfg.idleMs) return undefined;
			if (s.sent >= cfg.max) {
				s.done = true;
				return notice(run, s, now, "gave-up");
			}
			if (s.retryAt !== undefined && now < s.retryAt) return undefined;
			s.idleFrom ??= since;
			const id = `${run.id}:${++s.n}`;
			try {
				writeAtomic(file + NUDGE_SUFFIX, { v: 1, id, idleMs: now - quietSince } satisfies NudgeRequest);
			} catch {
				// A request that cannot be written is tried again a minute later.
				s.retryAt = now + RETRY_MS;
				return undefined;
			}
			s.pending = { id, at: now };
			s.retryAt = undefined;
			return undefined;
		},
		prune(live) {
			const keep = new Set(live);
			for (const [id, entry] of runs) {
				if (keep.has(id)) continue;
				if (entry.state.pending) remove(entry.file + NUDGE_SUFFIX);
				runs.delete(id);
			}
		},
	};
}
