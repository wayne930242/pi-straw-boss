import { closeSync, fstatSync, openSync, readSync } from "node:fs";

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
 * The time of the newest entry of `lines` (a session file's, oldest first) that is the main's own move. `cut`: the lines begin inside the file, so a tail that holds no move answers `null`, a move
 * before the tail of unknown time; never the time of a notice or of its answer (r3-F002).
 */
export function workedOf(lines: readonly string[], from: string, cut = false): number | null | undefined {
	let notice = false, worked: number | undefined;
	for (const line of lines) {
		const e = parse(line), at = Date.parse(e?.timestamp);
		if (!e || !Number.isFinite(at)) continue;
		if (staleNotice(e, from)) { notice = true; continue; }
		const m = e.type === "message" ? (e.message as Json | undefined) : undefined;
		// In the notice's turn, only a tool call or real input is a move: a user message (not the wake prompt) or an intercom message that is not the server's notice. Extensions' context
		// (`claude-hook-context` and other custom messages) is no input (r3-F003).
		if (notice && !((m?.role === "assistant" && Array.isArray(m.content) && m.content.some((b: Json) => b?.type === "toolCall")) || (m?.role === "user" && userText(m).trim() !== WAKE) || (e.type === "custom_message" && e.customType === "intercom_message"))) continue;
		notice = false;
		worked = at;
	}
	return worked ?? (cut ? null : undefined);
}

function tail(file: string): { lines: string[]; cut: boolean } {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size, from = Math.max(0, size - TAIL), buf = Buffer.alloc(size - from);
		readSync(fd, buf, 0, buf.length, from);
		const lines = buf.toString("utf8").split("\n");
		if (from > 0) lines.shift(); // a line cut at the start
		return { lines, cut: from > 0 };
	} finally {
		closeSync(fd);
	}
}

/**
 * The reader the capacity watch asks each minute: a file is read again only when its time moved; none when it cannot be read (the caller keeps the file's time). A tail with no move keeps the move
 * this reader knew of the file before the append (r3-F002), else answers `null` (unknown: the watch takes the episode's, capwatch.ts `knownMoves`).
 */
export function createWorked(from: string): (file: string, mtime: number) => number | null | undefined {
	const seen = new Map<string, { mtime: number; at: number | null | undefined }>();
	return (file, mtime) => {
		const had = seen.get(file);
		if (had?.mtime === mtime) return had.at;
		let at: number | null | undefined;
		try { const t = tail(file); at = workedOf(t.lines, from, t.cut); } catch { at = undefined; }
		if (at === null && typeof had?.at === "number") at = had.at;
		if (seen.size >= CACHED) seen.clear();
		seen.set(file, { mtime, at });
		return at;
	};
}
