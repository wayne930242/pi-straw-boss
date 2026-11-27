import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, writeDurable } from "./towerstore.ts";

// The tower's logbook (docs/specs/2026-11-28-tower-quiet.md; boss 2026-11-28 「塔台只要有辦法查帳就好」): the milestones and heads-ups mains send with `call_tower`, recorded by the sb server as they arrive, so
// that a milestone wakes no tower run and a heads-up wakes one only when it overlaps another heads-up or a main's board (towergate.ts). `<state folder>/logbook.json`, one file for every workspace of this computer:
// a heads-up is compared across workspaces. Written by the sb server alone (its intake, then the brief's read mark); a session reads it for `board_read` and `/boss board log`. An entry is kept 24 h; a heads-up is
// open until the end its text names (`until 14:30`, `for 2h`, `~10 min`), never past 24 h.

export const LOGBOOK_FILE = "logbook.json";
/** How long an entry is kept, and the longest a heads-up stays open. */
export const BOOK_KEEP_MS = 24 * 3600_000;
const BOOK_MAX = 400, TEXT_MAX = 300;
export type BookKind = "milestone" | "heads-up";
/**
 * One entry. `text` is the sender's message under its header, folded and cut: the sender's own words, never an instruction. A heads-up has `until` and the `resources` read from its text; `woke` marks an entry whose
 * call woke a tower run (it reached the run as an event), and `clash` says what it overlapped.
 */
export interface BookEntry { seq: number; kind: BookKind; workspace: string; label: string; at: number; from: { id: string; name: string }; text: string; reply?: true; until?: number; resources?: string[]; woke?: true; clash?: string }
export interface Book { v: 1; seq: number; read: Record<string, number>; entries: BookEntry[] }

const fold = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
export const cutText = (text: string, max = TEXT_MAX) => ((t) => (Array.from(t).length > max ? `${Array.from(t).slice(0, max - 1).join("")}…` : t))(fold(text));
export const bookFile = (stateDir: string) => join(stateDir, LOGBOOK_FILE);

/** The book as the file holds it, with what is older than a day left out; a missing or broken file is an empty book. */
export function readBook(stateDir: string, now: number): Book {
	let raw: Partial<Book> | undefined;
	try { raw = JSON.parse(readFileSync(bookFile(stateDir), "utf8")) as Partial<Book>; } catch { raw = undefined; }
	const entries = (Array.isArray(raw?.entries) ? raw.entries : []).filter((e): e is BookEntry => typeof e?.seq === "number" && typeof e.at === "number" && typeof e.workspace === "string" && now - e.at <= BOOK_KEEP_MS);
	const read = raw?.read && typeof raw.read === "object" ? Object.fromEntries(Object.entries(raw.read).filter(([, v]) => typeof v === "number")) : {};
	return { v: 1, seq: typeof raw?.seq === "number" ? raw.seq : 0, read, entries };
}
const writeBook = (stateDir: string, book: Book) => (ensureDir(stateDir), writeDurable(bookFile(stateDir), { ...book, entries: book.entries.slice(-BOOK_MAX) }));

/** Adds an entry under the next number, flushed to disk before it returns (the intake receipts the message after it). */
export function addEntry(stateDir: string, entry: Omit<BookEntry, "seq">, now: number): BookEntry {
	const book = readBook(stateDir, now), written: BookEntry = { ...entry, seq: book.seq + 1 };
	writeBook(stateDir, { ...book, seq: written.seq, entries: [...book.entries, written] });
	return written;
}
/** Marks an entry as one whose call woke a tower run, with what it overlapped. */
export function markWoke(stateDir: string, seq: number, now: number, clash?: string): void {
	const book = readBook(stateDir, now);
	if (book.entries.some((e) => e.seq === seq)) writeBook(stateDir, { ...book, entries: book.entries.map((e) => (e.seq === seq ? { ...e, woke: true as const, ...(clash ? { clash } : {}) } : e)) });
}
/** The entries of a workspace that no run of its tower has read: newer than its read mark, and none whose call woke a run. */
export const unreadOf = (book: Book, workspace: string): BookEntry[] => book.entries.filter((e) => e.workspace === workspace && e.seq > (book.read[workspace] ?? 0) && !e.woke);
/** A run that ended well read its brief: the mark moves to the newest entry the brief listed. */
export function markRead(stateDir: string, workspace: string, seq: number, now: number): void {
	const book = readBook(stateDir, now);
	if (seq > (book.read[workspace] ?? 0)) writeBook(stateDir, { ...book, read: { ...book.read, [workspace]: seq } });
}
/** The heads-ups open now, of every workspace. */
export const openHeadsUps = (book: Book, now: number): BookEntry[] => book.entries.filter((e) => e.kind === "heads-up" && (e.until ?? e.at + BOOK_KEEP_MS) > now);

// --- what a heads-up names ---------------------------------------------------------------------------------------------------------------------------------------------

/** Hyphenated words of plain English, which name nothing. */
const PLAIN = new Set(["heads-up", "follow-up", "read-only", "re-run", "up-to-date", "long-running", "built-in", "sign-off", "set-up", "check-in", "one-off", "end-to-end", "in-flight", "no-op", "non-blocking", "auto-mode", "auto-fill", "self-check", "boss-approved", "boss-authorized", "add-only", "dry-run", "skip-checks", "e.g", "i.e"]);
/** Times, durations, and small numbers: shared by unrelated heads-ups (`until 01:55`, `~10 min`). */
const NOISE = /^(?:\d{1,2}:\d{2}(?::\d{2})?|~?\d+(?:\.\d+)?(?:s|m|min|mins|h|hr|hrs|d)|\d{1,2})$/;
/**
 * The names a heads-up's text gives the things it touches, as the code compares them: lowercased, a URL's scheme and an `origin/` cut. A word counts when it has a letter and a digit (`ws01`, `v3`, `mp-5827`,
 * `1.62.0-beta.29`), is a number of three digits or more (a port, a migration), or has a separator inside it (`moldplan-center`, `atlas.moldplan.app`, `feat/x`, `~/.herdr/...`). A bare branch or stage word
 * (`main`, `staging`) names nothing alone: every repository has one, and on the field's heads-ups it matched pushes to different repositories. Two heads-ups overlap when they share a name; a false match wakes the tower,
 * which is the safe way to be wrong.
 */
export function resourcesOf(text: string): string[] {
	const out = new Set<string>();
	for (const raw of fold(text).toLowerCase().split(/[\s,;()<>[\]{}"'`«»“”|=!?*]+/)) {
		if (raw.startsWith("-")) continue; // a command's flag (`--include-all`), not a thing it touches
		const t = raw.replace(/^[^a-z0-9~/.]+|[^a-z0-9/]+$/g, "").replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/+$/, "").replace(/^origin\//, "");
		if (t.length < 2 || NOISE.test(t) || PLAIN.has(t)) continue;
		const letters = /[a-z]/.test(t), digits = /\d/.test(t);
		if ((letters && digits) || /^\d{3,}$/.test(t) || (letters && t.length >= 4 && /[/._:@-]/.test(t))) out.add(t);
	}
	return [...out].slice(0, 40);
}

/**
 * When a heads-up ends, as its text says: `until 14:30` (the next such time of day here), `for 2h`, `~10 min`, `about 1 hour`; else, and never later than, 24 h after it came.
 */
export function untilOf(text: string, at: number): number {
	const max = at + BOOK_KEEP_MS, t = fold(text);
	const clock = /\b(?:until|till|by)\s*(?:about\s*|around\s*|~\s*|ca\.?\s*)?(\d{1,2}):(\d{2})\b/i.exec(t);
	if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) {
		const day = new Date(at);
		day.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
		const end = day.getTime() <= at ? day.getTime() + 24 * 3600_000 : day.getTime();
		return Math.min(end, max);
	}
	const span = /(?:\bfor\s+(?:about\s+|around\s+|~\s*)?|~\s*|\babout\s+|\baround\s+)(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?)\b/i.exec(t);
	if (span) return Math.min(at + Number(span[1]) * (/^h/i.test(span[2]!) ? 3600_000 : 60_000), max);
	return max;
}

/** The tokens two texts share: the overlap of a heads-up with another, or with a main's board. */
export const shared = (a: readonly string[], b: readonly string[]): string[] => ((set) => a.filter((t) => set.has(t)))(new Set(b));

// --- how it is read ----------------------------------------------------------------------------------------------------------------------------------------------------

const hhmm = (ms: number) => ((d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`)(new Date(ms));
/** One entry on one line, its text fenced as the sender's words. */
export const entryLine = (e: BookEntry, now: number, max = 200): string =>
	`${hhmm(e.at)} ${e.kind} from ${cutText(e.from.name, 40)} (${e.from.id.slice(0, 8)})${e.kind === "heads-up" ? ((e.until ?? 0) > now ? `, open until ${hhmm(e.until!)}` : ", ended") : ""}${e.woke ? (e.clash ? `, woke the tower: ${cutText(e.clash, 120)}` : ", woke the tower") : ""}: «${cutText(e.text, max).replace(/[«»]/g, "")}»`;

/** `board_read`'s section `logbook`: this workspace's entries of the last day, newest first, and the heads-ups open in the other workspaces. */
export function bookSection(stateDir: string, workspace: string, now: number): { recent: string[]; elsewhere: string[] } | undefined {
	const book = readBook(stateDir, now);
	const recent = book.entries.filter((e) => e.workspace === workspace).reverse().slice(0, 30).map((e) => entryLine(e, now));
	const elsewhere = openHeadsUps(book, now).filter((e) => e.workspace !== workspace).reverse().slice(0, 20).map((e) => `${cutText(e.label, 40)}: ${entryLine(e, now)}`);
	return recent.length || elsewhere.length ? { recent, elsewhere } : undefined;
}

/** `/boss board log`: every workspace's entries of the last day, oldest first per workspace. */
export function bookText(stateDir: string, now: number): string {
	const book = readBook(stateDir, now);
	if (!book.entries.length) return "Logbook: nothing recorded in the last 24 hours.";
	const groups = Object.values(Object.groupBy(book.entries, (e) => e.workspace));
	return ["Logbook (milestones and heads-ups sb recorded for the towers; the last 24 hours, the senders' own words):", ...groups.flatMap((g = []) => [`${cutText(g[0]!.label, 40)} (${g[0]!.workspace}):`, ...g.map((e) => `  ${entryLine(e, now, 160)}`)])].join("\n");
}
