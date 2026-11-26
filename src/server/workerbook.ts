import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SESSION_ID } from "../workerslip.ts";
import { writeDurable } from "./towerstore.ts";

// The box's book of the workers its ally runs opened (docs/specs/2026-11-26-ally-workers.md, Resume): `<state>/workers-opened.json`. An entry is written at the open and renewed at each end and each resume, and kept
// 7 days after its last mark. It holds the ask a slip came with (so the same slip handed to the door again opens nothing, RV-F001) and what a resume needs: the device it is bound to, the branch, the base, the model,
// the points, the session file and the last head. A local process can write it, so it authorises nothing alone: the resume door re-derives the worktree and checks the session file itself (workerresume.ts).

const BOOK_FILE = "workers-opened.json", BOOK_MAX = 200;
export const BOOK_KEEP_MS = 7 * 24 * 3600_000;
export type EndHow = "report" | "idle" | "gone";
export interface BookEntry {
	ask: string;
	main: string;
	at: number;
	/** The asks of earlier opens or resumes of this session: a repeat of any of them opens nothing. */
	prior?: string[];
	device?: string;
	team?: string;
	workspace?: string;
	branch?: string;
	label?: string;
	path?: string;
	base?: string;
	baseSha?: string;
	points?: number;
	model?: string;
	file?: string;
	head?: string;
	ended?: { at: number; how: EndHow };
}

export function readBook(stateDir: string, now: number): BookEntry[] {
	try {
		const e = (JSON.parse(readFileSync(join(stateDir, BOOK_FILE), "utf8")) as { entries?: unknown }).entries;
		return (Array.isArray(e) ? e : []).filter((x): x is BookEntry => typeof x?.ask === "string" && typeof x.main === "string" && typeof x.at === "number" && now - x.at <= BOOK_KEEP_MS);
	} catch { return []; }
}
const writeBook = (stateDir: string, entries: BookEntry[]) => writeDurable(join(stateDir, BOOK_FILE), { entries: entries.slice(-BOOK_MAX) });

/** The entry an ask belongs to, as its open or a later resume. */
export const bookOfAsk = (stateDir: string, now: number, ask: string) => readBook(stateDir, now).find((x) => x.ask === ask || x.prior?.includes(ask));
/** The entry of a session for the device `device` (the run's own `link:` sender, without the prefix): another device's entry reads as none. */
export const bookOf = (stateDir: string, now: number, main: string, device: string) => readBook(stateDir, now).find((x) => x.main === main && x.device === device);

/** Writes the entry of a session anew (an open, a resume): one entry per session, the newest last. */
export function putBook(stateDir: string, now: number, entry: BookEntry): void {
	const rest = readBook(stateDir, now), old = rest.find((x) => x.main === entry.main);
	const prior = old ? [...(old.prior ?? []), old.ask].filter((a) => a !== entry.ask).slice(-20) : undefined;
	writeBook(stateDir, [...rest.filter((x) => x.main !== entry.main), { ...entry, ...(prior?.length ? { prior } : {}) }]);
}
/** Marks of the sweep and the relay on the session's entry: its file, its last head, its end; `renew` moves its 7 days on (an end). Nothing when the session has no entry. */
export function markBook(stateDir: string, now: number, main: string, patch: Pick<BookEntry, "file" | "head" | "ended">, renew = false): void {
	const all = readBook(stateDir, now), i = all.findIndex((x) => x.main === main);
	if (i < 0) return;
	const was = all[i]!, next = { ...was, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), ...(renew ? { at: now } : {}) };
	if (JSON.stringify(next) === JSON.stringify(was)) return;
	all[i] = next;
	writeBook(stateDir, all);
}

/** The line a receipt ends with, by code: the session to name for a follow-up. None for an id that is no uuid (nothing could resume it). */
export const sessionLine = (session: string) => (SESSION_ID.test(session) ? `\nSession: ${session} · resume: call_tower worker {device: <this box>, resume: "${session}", message: <the follow-up>} (kept 7 days)` : "");
