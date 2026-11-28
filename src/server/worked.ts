import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

// The main's own last move as the stale reminder counts it (docs/specs/2026-11-28-stale-snooze.md, review r2-F003): the time of the newest entry of its session file that is not its taking of a stale
// notice. Taking one is the notice's own entry (the server's intercom message: its sender, `kind=capacity_notice`, `capacity stale`), pi-intercom's wake prompt, and what the main writes in that turn
// before it calls a tool or another input comes: a text answer, the extensions' entries. A tool call in the turn is work, and so is everything after another input. No time window: a write is
// discounted by what it is, never by when.

/** How much of a session file's end is read: a stale notice and its answer are a few kilobytes. */
const TAIL = 256 * 1024, CACHED = 256, WAKE = "New intercom message above.";
type Json = { [key: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any -- session entries are untrusted JSON, read defensively
const parse = (line: string): Json | undefined => { try { const v = JSON.parse(line) as unknown; return typeof v === "object" && v !== null ? (v as Json) : undefined; } catch { return undefined; } };
const bodyOf = (d: Json | undefined) => (typeof d?.message?.content?.text === "string" ? (d.message.content.text as string) : typeof d?.bodyText === "string" ? (d.bodyText as string) : "");
const NOTICE = /^\[straw net [^\n]*?\bkind=capacity_notice\b[^\n]*?\] capacity stale · /;

/** Whether an entry is the server's stale notice: an intercom message from `from` (the server's intercom id) whose text is the code-written header and a `capacity stale` line. */
export const staleNotice = (e: Json, from: string): boolean => e.type === "custom_message" && e.customType === "intercom_message" && e.details?.from?.id === from && NOTICE.test(bodyOf(e.details));
const userText = (m: Json) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.filter((b: Json) => b?.type === "text").map((b: Json) => String(b.text)).join("\n") : "");

/**
 * The time of the newest entry of `lines` (a session file's, oldest first) that is the main's own move. `cut`: the lines begin inside the file. A cut tail with no move answers `null` (a move before
 * the tail, of unknown time) only when it proves what follows that move: it holds a notice and, after it, nothing that is a move (r3-F002). Else it answers `undefined`, and the file's time
 * counts: a real input too large for the tail is a move (r4-F002). Never the time of a notice or of its answer.
 */
export function workedOf(lines: readonly string[], from: string, cut = false): number | null | undefined {
	const r = scan(lines, from, false);
	return r.worked ?? (cut && r.seen ? null : undefined);
}
/** `workedOf`'s pass: `notice` whether the lines begin inside a notice's turn; it answers whether they end in one. */
function scan(lines: readonly string[], from: string, notice: boolean): { worked?: number; seen: boolean; notice: boolean } {
	let seen = false, worked: number | undefined;
	for (const line of lines) {
		const e = parse(line), at = Date.parse(e?.timestamp);
		if (!e || !Number.isFinite(at)) continue;
		if (staleNotice(e, from)) { notice = seen = true; continue; }
		const m = e.type === "message" ? (e.message as Json | undefined) : undefined;
		// In the notice's turn, only a tool call or real input is a move: a user message (not the wake prompt) or an intercom message that is not the server's notice. Extensions' context
		// (`claude-hook-context` and other custom messages) is no input (r3-F003).
		if (notice && !((m?.role === "assistant" && Array.isArray(m.content) && m.content.some((b: Json) => b?.type === "toolCall")) || (m?.role === "user" && userText(m).trim() !== WAKE) || (e.type === "custom_message" && e.customType === "intercom_message"))) continue;
		notice = false;
		worked = at;
	}
	return { ...(worked !== undefined ? { worked } : {}), seen, notice };
}

/** A session file's end: from `since` (a line's start this reader read up to) when the append fits in the tail, else its last 256 KiB. `end`: just past its last whole line. */
function tail(file: string, since = -1): { lines: string[]; cut: boolean; end: number } {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size, fits = since >= 0 && since <= size && size - since <= TAIL, from = fits ? since : Math.max(0, size - TAIL), buf = Buffer.alloc(size - from);
		readSync(fd, buf, 0, buf.length, from);
		const nl = buf.lastIndexOf(10), lines = buf.subarray(0, nl + 1).toString("utf8").split("\n");
		if (from > 0 && !fits) lines.shift(); // a line cut at the start
		return { lines, cut: from > 0 && !fits, end: from + nl + 1 };
	} finally {
		closeSync(fd);
	}
}

/** A full re-read at least this often, whatever the file's stat says (r4-F001). */
export const REVALIDATE_MS = 10 * 60_000;
const statOf = (file: string) => {
	try { const s = statSync(file, { bigint: true }); return { id: `${s.dev}:${s.ino}`, key: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`, size: Number(s.size) }; } catch { return undefined; }
};
type Seen = { id: string; key: string; end: number; notice: boolean; checked: number; at: number | null | undefined };

/**
 * The reader the capacity watch asks each minute: a file is read again only when its stat moved (its identity, size, and times to the nanosecond, r4-F001) or ten minutes passed since its last full
 * read; none when it cannot be read (the caller keeps the file's time). An append that fits in the tail is read alone, carrying whether the file ended in a notice's turn: with no move in it, the
 * move this reader knew stands, the append being proven to hold none. A larger one, or a new reader, is judged by the tail (`workedOf`): `null` (unknown: the watch takes the episode's,
 * capwatch.ts `knownMoves`) only when the tail proves it, else `undefined` (the file's time counts, r4-F002).
 */
export function createWorked(from: string, now: () => number = Date.now, read: typeof tail = tail): (file: string, mtime: number) => number | null | undefined {
	const seen = new Map<string, Seen>();
	return (file) => {
		// A stat, and at most 256 KiB of its end, never the whole file (Performance in the stale-snooze spec).
		const had = seen.get(file), st = statOf(file), t0 = now(), fresh = had !== undefined && t0 - had.checked < REVALIDATE_MS;
		if (fresh && st && had.key === st.key) return had.at;
		const grown = fresh && st !== undefined && had.id === st.id && st.size > had.end ? had : undefined;
		let next: Seen | undefined;
		try {
			const t = read(file, grown ? grown.end : -1);
			if (grown && !t.cut) {
				const r = scan(t.lines, from, grown.notice);
				next = { ...grown, end: t.end, notice: r.notice, at: r.worked ?? grown.at };
			} else {
				const r = scan(t.lines, from, false);
				next = { id: st?.id ?? "", key: "", end: t.end, notice: r.notice, checked: t0, at: r.worked ?? (t.cut && r.seen ? null : undefined) };
			}
		} catch { next = undefined; }
		if (seen.size >= CACHED) seen.clear();
		if (st && next) seen.set(file, { ...next, key: st.key });
		else seen.delete(file);
		return next?.at;
	};
}
