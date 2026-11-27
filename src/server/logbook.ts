import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureDir, writeDurable } from "./towerstore.ts";

// The tower's logbook (docs/specs/2026-11-28-tower-quiet.md; boss 2026-11-28 「塔台只要有辦法查帳就好」): the milestones and heads-ups mains send with `call_tower`, recorded by the sb server as they arrive, so
// that a milestone wakes no tower run and a heads-up wakes one only when it overlaps another heads-up or a main's board (towergate.ts). `logbook.json` in the folder of a Herdr slot (record.ts `Slot.dir`: the state
// folder for the default Herdr, `servers/<hash>` for another), one file for every workspace of that slot: each sb server writes only its own slot's (quiet-F001: two servers on one file overwrote each other, and
// two slots' `w1` shared entries and a read mark), and a heads-up is compared with the open heads-ups of every slot's file. Written by the sb server alone (its intake, then the brief's read mark); a session reads
// them for `board_read` and `/boss board log`. An entry is kept 24 h; a heads-up is open until the end its text names (`until 14:30`, `for 2h`, `~10 min`), never past 24 h.

export const LOGBOOK_FILE = "logbook.json";
/** How long an entry is kept, and the longest a heads-up stays open. */
export const BOOK_KEEP_MS = 24 * 3600_000;
const BOOK_MAX = 400, TEXT_MAX = 300;
export type BookKind = "milestone" | "heads-up";
/**
 * One entry. `text` is the sender's message under its header, folded and cut: the sender's own words, never an instruction. A heads-up has `until` and the `resources` read from its text; `woke` marks an entry whose
 * call woke a tower run (it reached the run as an event), and `clash` says what it overlapped. `msg` is the intercom message's base id (a retry's `~r<n>` removed, towerseen.ts `baseId`) and `hash` the SHA-256 of its
 * whole text: a retry of a message whose receipt never went adds no second entry, and the same id with other words is no retry (quiet-F011).
 */
export interface BookEntry { seq: number; kind: BookKind; workspace: string; label: string; at: number; from: { id: string; name: string }; text: string; msg?: string; hash?: string; reply?: true; until?: number; resources?: string[]; woke?: true; clash?: string }
export interface Book { v: 1; seq: number; read: Record<string, number>; entries: BookEntry[] }
/** An entry as a reader of every slot sees it: `slot` is its file's folder. */
export type SlotEntry = BookEntry & { slot: string };

const fold = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
export const cutText = (text: string, max = TEXT_MAX) => ((t) => (Array.from(t).length > max ? `${Array.from(t).slice(0, max - 1).join("")}…` : t))(fold(text));
/** A field the sender controls, cut first and then fenced (quiet-F008): no fence mark inside it, and a cut never drops its end. */
export const fenced = (text: string, max: number) => `«${cutText(text.replace(/[«»]/g, ""), max)}»`;
/** The digest key a brief's logbook rows ride on (`book:<seq>`, the last row it carried): the run that ended well moves its workspace's read mark there (towers.ts `clearDigest`). */
export const BOOK_KEY = "book:";
/** `dir` is a slot's folder (record.ts `Slot.dir`). */
export const bookFile = (dir: string) => join(dir, LOGBOOK_FILE);

/** One slot's book as its file holds it, with what is older than a day left out; a missing or broken file is an empty book. */
export function readBook(dir: string, now: number): Book {
	let raw: Partial<Book> | undefined;
	try { raw = JSON.parse(readFileSync(bookFile(dir), "utf8")) as Partial<Book>; } catch { raw = undefined; }
	const entries = (Array.isArray(raw?.entries) ? raw.entries : []).filter((e): e is BookEntry => typeof e?.seq === "number" && typeof e.at === "number" && typeof e.workspace === "string" && now - e.at <= BOOK_KEEP_MS);
	const read = raw?.read && typeof raw.read === "object" ? Object.fromEntries(Object.entries(raw.read).filter(([, v]) => typeof v === "number")) : {};
	return { v: 1, seq: typeof raw?.seq === "number" ? raw.seq : 0, read, entries };
}
/** The folders of every slot of a state folder: its own (the default Herdr's) and each `servers/<hash>`. */
const slotDirs = (stateDir: string) => [stateDir, ...((): string[] => { try { return readdirSync(join(stateDir, "servers")).filter((h) => /^[0-9a-f]{16}$/.test(h)).map((h) => join(stateDir, "servers", h)); } catch { return []; } })()];
/** The entries of every slot's book, each with its slot's folder. */
export const allEntries = (stateDir: string, now: number): SlotEntry[] => slotDirs(stateDir).flatMap((slot) => readBook(slot, now).entries.map((e) => ({ ...e, slot })));
const writeBook = (dir: string, book: Book) => (ensureDir(dir), writeDurable(bookFile(dir), { ...book, entries: book.entries.slice(-BOOK_MAX) }));

/** Adds an entry under the next number, flushed to disk before it returns; a message already recorded (`msg` from its sender to its workspace's tower) is not added again, and its entry comes back. */
export function addEntry(dir: string, entry: Omit<BookEntry, "seq">, now: number): BookEntry {
	const book = readBook(dir, now), had = entry.msg !== undefined && book.entries.find((e) => e.msg === entry.msg && e.from.id === entry.from.id && e.workspace === entry.workspace);
	if (had) return had;
	const written: BookEntry = { ...entry, seq: book.seq + 1 };
	writeBook(dir, { ...book, seq: written.seq, entries: [...book.entries, written] });
	return written;
}
/** The entries of a workspace that no run of its tower has read: newer than its read mark, and none whose call woke a run. */
export const unreadOf = (book: Book, workspace: string): BookEntry[] => book.entries.filter((e) => e.workspace === workspace && e.seq > (book.read[workspace] ?? 0) && !e.woke);
/** A run that ended well read its brief: the mark moves to the newest entry the brief showed it. */
export function markRead(dir: string, workspace: string, seq: number, now: number): void {
	const book = readBook(dir, now);
	if (seq > (book.read[workspace] ?? 0)) writeBook(dir, { ...book, read: { ...book.read, [workspace]: seq } });
}
/** The heads-ups open now among `entries`. */
export const openHeadsUps = <E extends BookEntry>(entries: E[], now: number): E[] => entries.filter((e) => e.kind === "heads-up" && (e.until ?? e.at + BOOK_KEEP_MS) > now);

// --- what a heads-up names ---------------------------------------------------------------------------------------------------------------------------------------------

/** Hyphenated words of plain English, which name nothing. */
const PLAIN = new Set(["heads-up", "follow-up", "read-only", "re-run", "up-to-date", "long-running", "built-in", "sign-off", "set-up", "check-in", "one-off", "end-to-end", "in-flight", "no-op", "non-blocking", "auto-mode", "auto-fill", "self-check", "boss-approved", "boss-authorized", "add-only", "dry-run", "skip-checks", "e.g", "i.e"]);
/** Times, durations, and small numbers: shared by unrelated heads-ups (`until 01:55`, `~10 min`). */
const NOISE = /^(?:\d{1,2}:\d{2}(?::\d{2})?|~?\d+(?:\.\d+)?(?:s|m|min|mins|h|hr|hrs|d)|\d{1,2})$/;
/** Whether a word names a thing by itself: a letter and a digit, a number of three digits or more, or a word of four or more with a separator inside it. */
const names = (t: string) => {
	if (t.length < 2 || NOISE.test(t) || PLAIN.has(t)) return false;
	const letters = /[a-z]/.test(t), digits = /\d/.test(t);
	return (letters && digits) || /^\d{3,}$/.test(t) || (letters && t.length >= 4 && /[/._:@-]/.test(t));
};
/** The hosts of this computer, whose port is the thing an endpoint names. */
const LOCAL = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
/** An endpoint's host and port: a URL's authority (`postgres://app@ws01:5432/mp`), or a `host:port` (`ws01:5432`, `app@ws01:5432/mp`). */
const endpointOf = (t: string, url: boolean): { host: string; port?: string } | undefined => {
	const m = (url ? /^(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+)(?::(\d{1,5}))?(?:\/|$)/ : /^(?:[^@/:]+@)?([a-z0-9][a-z0-9.-]*):(\d{2,5})(?:\/|$)/).exec(t);
	return m ? { host: m[1]!.replace(/^\[|\]$/g, ""), ...(m[2] ? { port: m[2] } : {}) } : undefined;
};
/**
 * The names a heads-up's text gives the things it touches, as the code compares them: lowercased, a URL's scheme and an `origin/` cut. A word counts when it has a letter and a digit (`ws01`, `v3`, `mp-5827`,
 * `1.62.0-beta.29`), is a number of three digits or more (a port, a migration), or has a separator inside it (`moldplan-center`, `atlas.moldplan.app`, `feat/x`, `~/.herdr/...`). A bare branch or stage word
 * (`main`, `staging`) names nothing alone: every repository has one, and on the field's heads-ups it matched pushes to different repositories. An endpoint names its host too (quiet-F004: `ws01:5432` and a URL on
 * `ws01` are `ws01`), and an endpoint of this computer (`localhost:3000`) its port. Two heads-ups overlap when they share a name; a false match wakes the tower, which is the safe way to be wrong.
 */
export function resourcesOf(text: string): string[] {
	const out = new Set<string>();
	for (const raw of fold(text).toLowerCase().split(/[\s,;()<>[\]{}"'`«»“”|=!?*]+/)) {
		if (raw.startsWith("-")) continue; // a command's flag (`--include-all`), not a thing it touches
		const bare = raw.replace(/^[^a-z0-9~/.[]+|[^a-z0-9/\]]+$/g, ""), url = /^[a-z][a-z0-9+.-]*:\/\//.test(bare);
		const t = bare.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/+$/, "").replace(/^origin\//, "");
		if (names(t)) out.add(t);
		const end = endpointOf(t, url);
		if (end && names(end.host)) out.add(end.host);
		if (end?.port && LOCAL.has(end.host) && names(end.port)) out.add(end.port);
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
/** The most characters an entry's row takes: the brief's row cap (towerbrief.ts `bookRow`), so the brief never cuts one. */
export const ROW_MAX = 280;
/** What a clash a row names may take: a longer one (it is the code's, made of fenced fields) is left at "woke the tower". */
const CLASH_MAX = 140;
/**
 * One entry on one line, at most `max` characters: the sender's name and words each cut first and then fenced as the sender's (quiet-F008), so no cut, here or in a reader, drops a fence's end; the rest is the code's.
 */
export function entryLine(e: BookEntry, now: number, max = ROW_MAX): string {
	const end = e.kind === "heads-up" ? ((e.until ?? 0) > now ? `, open until ${hhmm(e.until!)}` : ", ended") : "";
	const woke = e.woke ? (e.clash && Array.from(e.clash).length <= CLASH_MAX ? `, woke the tower: ${e.clash}` : ", woke the tower") : "";
	const head = `${hhmm(e.at)} ${e.kind} from ${fenced(e.from.name, 40)} (${fold(e.from.id).slice(0, 8)})${end}${woke}: `;
	return head + fenced(e.text, Math.max(8, max - Array.from(head).length - 2));
}

/**
 * `board_read`'s section `logbook`: the entries of the reader's workspace in its slot (`slot`, its folder: the state folder for the default Herdr) of the last day, newest first, and the heads-ups open in every
 * other workspace of every slot.
 */
export function bookSection(stateDir: string, workspace: string, now: number, slot = stateDir): { recent: string[]; elsewhere: string[] } | undefined {
	const all = allEntries(stateDir, now);
	const recent = all.filter((e) => e.slot === slot && e.workspace === workspace).reverse().slice(0, 30).map((e) => entryLine(e, now));
	const elsewhere = openHeadsUps(all, now).filter((e) => e.slot !== slot || e.workspace !== workspace).sort((a, b) => b.at - a.at).slice(0, 20).map((e) => `${cutText(e.label, 40)}: ${entryLine(e, now)}`);
	return recent.length || elsewhere.length ? { recent, elsewhere } : undefined;
}

/** `/boss board log`: every slot's and workspace's entries of the last day, oldest first in each; a workspace of another Herdr than the default names its slot. */
export function bookText(stateDir: string, now: number): string {
	const all = allEntries(stateDir, now);
	if (!all.length) return "Logbook: nothing recorded in the last 24 hours.";
	const groups = Object.values(Object.groupBy(all, (e) => `${e.slot}\n${e.workspace}`));
	const title = (e: SlotEntry) => `${cutText(e.label, 40)} (${e.workspace}${e.slot === stateDir ? "" : ` · ${basename(e.slot).slice(0, 8)}`}):`;
	return ["Logbook (milestones and heads-ups sb recorded for the towers; the last 24 hours, the senders' own words in «»):", ...groups.flatMap((g = []) => [title(g[0]!), ...g.map((e) => `  ${entryLine(e, now, 200)}`)])].join("\n");
}
