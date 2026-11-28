// A snooze of the stale reminder (docs/specs/2026-11-28-stale-snooze.md): a main says, with `board_set { snooze }`, that its reminder waits for a time or for the next change of one of its `boss_watch`
// watches, for the whole main or for one todo. Its own session keeps the snoozes in its capacity file (capfill.ts); the sb server's capacity watch reads them there and judges each against the watches it holds.

const MIN = 60_000;
export const SNOOZE_MAX_MS = 24 * 60 * MIN, WHY_MAX = 120, SNOOZES_MAX = 20;
/** `until` is always set: `at` plus its `for`, else 24 hours after `at` (a snooze on a watch alone). `todo`: the one todo it holds, else the whole main; `watch`: a key of the main's own watches. */
export interface Snooze { at: number; why: string; until: number; todo?: number; watch?: string }
/** One of the main's watches as the sb server holds it: when it started and when its last line reached the main (`told.at` of server/watches.ts; the start when none has). */
export interface WatchFact { key: string; added: number; toldAt: number }

const fold = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim() : "");
/** A length as `boss_watch` takes one: `90s`, `30m`, `2h`, or plain milliseconds. */
export function lengthMs(text: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text.trim());
	return m ? Math.round(Number(m[1]) * { ms: 1, s: 1000, m: MIN, h: 60 * MIN }[(m[2] ?? "ms") as "ms"]) : undefined;
}

/** `board_set`'s `snooze`, checked: `why`, then `for`, `watch` (one of `watches`, the keys of the main's own watches), and `todo` (one of `open`). Throws with what to fix. */
export function snoozeOf(input: unknown, o: { now: number; watches: readonly string[]; open: readonly number[] }): Snooze {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("snooze takes { why, for?, watch?, todo? }");
	const i = input as Record<string, unknown>, why = fold(i.why);
	if (!why) throw new Error("snooze needs why: one line saying what the reminder waits for");
	if (Array.from(why).length > WHY_MAX) throw new Error(`snooze's why is at most ${WHY_MAX} characters`);
	if (i.for === undefined && i.watch === undefined) throw new Error("snooze needs for or watch: for a length (30m, 2h), watch a key you watch with boss_watch, until its next change");
	let ms = SNOOZE_MAX_MS;
	if (i.for !== undefined) {
		const len = typeof i.for === "string" ? lengthMs(i.for) : undefined;
		if (len === undefined) throw new Error("for is a length: 30m, 90s, 2h");
		if (len < MIN) throw new Error("for is at least 1m");
		if (len > SNOOZE_MAX_MS) throw new Error("for is at most 24h");
		ms = len;
	}
	const watch = i.watch === undefined ? undefined : typeof i.watch === "string" ? i.watch.trim() : "";
	if (watch !== undefined && !o.watches.includes(watch)) throw new Error(`you watch no ${JSON.stringify(watch.slice(0, 200))}: start boss_watch on it first (your watches: ${o.watches.map((k) => JSON.stringify(k)).join(", ") || "none"})`);
	if (i.todo !== undefined && !(Number.isInteger(i.todo) && o.open.includes(i.todo as number))) throw new Error(`you have no open todo #${String(i.todo)}: todo is the id of one of your open todos, or leave it out to snooze the whole main`);
	return { at: o.now, why, until: o.now + ms, ...(watch !== undefined ? { watch } : {}), ...(i.todo !== undefined ? { todo: i.todo as number } : {}) };
}

/** The list with `s` in place of the snooze of its scope (the main, or its todo); at most 20, the oldest todo's going first. */
export function withSnooze(list: readonly Snooze[], s: Snooze): Snooze[] {
	const next = [...list.filter((x) => x.todo !== s.todo), s];
	while (next.length > SNOOZES_MAX) next.splice(next.findIndex((x) => x.todo !== undefined), 1);
	return next;
}

/** The snoozes of a capacity file, each checked; anything else is dropped. */
export function readSnoozes(v: unknown): Snooze[] {
	const n = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 8.64e15;
	return (Array.isArray(v) ? v.slice(0, SNOOZES_MAX) : []).flatMap((r: Record<string, unknown> | null): Snooze[] => {
		const why = fold(r?.why).slice(0, WHY_MAX);
		if (!why || !n(r?.at) || !n(r?.until) || (r!.todo !== undefined && !(Number.isInteger(r!.todo) && (r!.todo as number) >= 1)) || (r!.watch !== undefined && (typeof r!.watch !== "string" || !r!.watch || r!.watch.length > 200))) return [];
		return [{ at: r!.at as number, why, until: r!.until as number, ...(r!.todo !== undefined ? { todo: r!.todo as number } : {}), ...(r!.watch !== undefined ? { watch: r!.watch as string } : {}) }];
	});
}

/**
 * When a snooze ended; none while it holds. Its time; else, for a watch, the time of the watch's first line after the snooze was set, or the snooze's own time when the watch is gone (it ended with a
 * line the main took, or the main stopped it). `watches` unknown (none given): it holds until its time.
 */
export function snoozeEnd(s: Snooze, watches: readonly WatchFact[] | undefined, now: number): number | undefined {
	if (s.until <= now) return s.until;
	if (s.watch === undefined || !watches) return undefined;
	const w = watches.find((x) => x.key === s.watch);
	return !w ? s.at : w.toldAt > s.at ? w.toldAt : undefined;
}
