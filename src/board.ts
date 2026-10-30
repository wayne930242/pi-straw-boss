import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The work board (docs/specs/2026-10-25-straw-link.md, Work board): each main writes one small entry about its own work, and towers read them all.
// This file holds the entry rules, the files under `<state dir>/board/`, and the reader's join with the live net. It knows nothing of Straw Link: the
// holder sends the entries to allies (link/holder.ts) and the tower's tool reads them (tools.ts).

export const BOARD = { now: 120, item: 80, items: 8, label: 40 } as const;
/** An entry whose session is gone shows as `ended` for this long after its last update, then not at all. */
export const ENDED_MS = 30 * 60_000;
/** The file of a session that is not live is deleted once its last update is older than this. */
export const DEAD_MS = 24 * 3600_000;
/** A live main that is idle now, and whose entry was last updated this long ago, shows the entry as `stale`: the text is probably not what it works on now. A main that commands work (a subagent of it runs) is never stale. */
export const STALE_MS = 2 * 3600_000;

export interface BoardItem { t: string; done: boolean }
/** What a main writes. */
export interface BoardText { now: string; items: BoardItem[] }
/** Who wrote an entry: the main's `board_set`, or the auto-fill from its todo list (boardfill.ts). Local only: it is in the file, and never on the wire to allies. */
export type Src = "todo" | "set";
/** The todo list's tasks done and in all, kept with an auto entry. */
export interface Count { done: number; total: number }
/** What the file holds. `count` and `who` (the scrubbed session name, the only text an ally gets of an auto entry) go with `src: "todo"` only. */
export interface Entry extends BoardText { v: 1; session: string; updated: number; src: Src; count?: Count; who?: string }

// Control and format characters (escapes, bidi overrides, zero-width joiners) are refused on write and removed on read.
const BAD = /[\p{Cc}\p{Cf}]/u;
const BAD_ALL = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const fold = (text: string) => text.replace(/\s+/gu, " ").trim();

/** `text` with whitespace folded to one space and trimmed; refused with the reason when it is empty, too long, or holds a control or format character. */
export function checkText(what: string, text: unknown, max: number): string {
	if (typeof text !== "string") throw new Error(`${what} has to be text`);
	// Whitespace folds first, so a newline or tab is a space; any other control or format character is refused.
	const folded = fold(text);
	if (BAD.test(folded)) throw new Error(`${what} may not hold control or format characters (escapes, bidi overrides, zero-width marks)`);
	if (!folded) throw new Error(`${what} is empty`);
	const length = Array.from(folded).length;
	if (length > max) throw new Error(`${what} has ${length} characters; at most ${max} fit`);
	return folded;
}
/** The write rules: `now` 1 to 120 characters, 0 to 8 items of 1 to 80. Nothing is cut silently. */
export function checkEntry(input: { now: unknown; items?: unknown }): BoardText {
	const now = checkText("now", input.now, BOARD.now);
	const raw = input.items ?? [];
	if (!Array.isArray(raw)) throw new Error("items has to be a list");
	if (raw.length > BOARD.items) throw new Error(`items has ${raw.length} entries; at most ${BOARD.items} fit`);
	const items = raw.map((item, i) => {
		const x = (typeof item === "object" && item !== null ? item : {}) as { t?: unknown; done?: unknown };
		if (typeof x.done !== "boolean") throw new Error(`item ${i + 1}: done has to be true or false`);
		return { t: checkText(`item ${i + 1}`, x.t, BOARD.item), done: x.done };
	});
	return { now, items };
}

/** What a reader keeps of a text it did not write: control and format characters removed, whitespace folded, cut to `max` characters. */
export function clean(text: unknown, max: number): string {
	if (typeof text !== "string") return "";
	const out = fold(text.replace(/\s+/gu, " ").replace(BAD_ALL, ""));
	return Array.from(out).length > max ? Array.from(out).slice(0, max).join("").trimEnd() : out;
}
/** The reader's second check of an entry or board row: the same caps, applied by cutting. */
export function cleanText(input: { now?: unknown; items?: unknown }): BoardText {
	const items = Array.isArray(input.items) ? input.items.slice(0, BOARD.items).flatMap((i): BoardItem[] => {
		const x = (typeof i === "object" && i !== null ? i : {}) as { t?: unknown; done?: unknown };
		const t = clean(x.t, BOARD.item);
		return t && typeof x.done === "boolean" ? [{ t, done: x.done }] : [];
	}) : [];
	return { now: clean(input.now, BOARD.now), items };
}

export const safeSession = (session: string) => SAFE_SESSION.test(session);
const fileOf = (dir: string, session: string) => join(dir, `${session}.json`);

/** Writes the whole entry of `session`, atomically (a temporary file renamed over it), in a folder only this user can open. A `board_set` entry is `src: "set"`, the default. */
export function writeEntry(dir: string, session: string, text: BoardText, now: number, meta: { src?: Src; count?: Count; who?: string } = {}): Entry {
	if (!safeSession(session)) throw new Error("This session has no id a board file can be named for");
	const src = meta.src ?? "set", entry: Entry = { v: 1, session, now: text.now, items: text.items, updated: now, src, ...(src === "todo" && meta.count ? { count: meta.count } : {}), ...(src === "todo" && meta.who ? { who: meta.who } : {}) };
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try { chmodSync(dir, 0o700); } catch { /* a file system without modes */ }
	const file = fileOf(dir, session), temp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	return entry;
}
/** Deletes the entry of `session`; there is no way to name another file. */
export function removeEntry(dir: string, session: string): void {
	if (safeSession(session)) rmSync(fileOf(dir, session), { force: true });
}

/** Every entry in the folder that passes the structure check, cut again by the reader's rules. A file that fails the check is ignored. */
export function readEntries(dir: string): Entry[] {
	let names: string[] = [];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".json"));
	} catch { /* no board yet */ }
	return names.flatMap((name) => readOne(dir, name));
}
function readOne(dir: string, name: string): Entry[] {
	try {
		const raw = JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
		const session = name.slice(0, -".json".length);
		// The file is named for its session, and says so: a file that disagrees is somebody's copy, not this session's entry.
		if (raw?.v !== 1 || raw.session !== session || !safeSession(session) || typeof raw.updated !== "number" || !Number.isFinite(raw.updated) || typeof raw.now !== "string" || !Array.isArray(raw.items)) return [];
		if (!raw.items.every((i) => typeof i === "object" && i !== null && typeof (i as BoardItem).t === "string" && typeof (i as BoardItem).done === "boolean")) return [];
		const c = raw.count as Partial<Count> | undefined, src: Src = raw.src === "todo" ? "todo" : "set"; // a file without `src` is a board_set entry
		const count = src === "todo" && Number.isSafeInteger(c?.done) && Number.isSafeInteger(c?.total) && c!.done! >= 0 && c!.done! <= c!.total! && c!.total! <= 200 ? { done: c!.done!, total: c!.total! } : undefined;
		const who = src === "todo" ? clean(raw.who, BOARD.label) : "";
		return [{ v: 1, session, updated: raw.updated, src, ...(count ? { count } : {}), ...(who ? { who } : {}), ...cleanText(raw) }];
	} catch {
		return [];
	}
}

/** An auto entry whose todo list is all done (`<name>: done (n/n)`): it is said once, and goes 30 minutes after it was written. */
export const finished = (e: { src: Src; count?: Count | undefined }): boolean => e.src === "todo" && e.count !== undefined && e.count.total > 0 && e.count.done === e.count.total;

/** Deletes the files of sessions that are not live and whose last update is more than 24 hours old, and a finished auto entry older than 30 minutes, live or not: the one write to another session's file, and it only removes what has run out. */
export function purge(dir: string, live: ReadonlySet<string>, now: number): void {
	const due = (e: Entry) => (!live.has(e.session) && now - e.updated > DEAD_MS) || (finished(e) && now - e.updated > ENDED_MS);
	// The owner may write its entry again between the listing and the removal: the file is read once more right before it goes.
	for (const entry of readEntries(dir)) if (due(entry) && readOne(dir, `${entry.session}.json`).every(due)) removeEntry(dir, entry.session);
	// A file the structure check refuses is no entry; one that stays untouched for a day goes too.
	try {
		const known = new Set(readEntries(dir).map((e) => `${e.session}.json`));
		for (const name of readdirSync(dir)) if (name.endsWith(".json") && !known.has(name) && now - statSync(join(dir, name)).mtimeMs > DEAD_MS) rmSync(join(dir, name), { force: true });
		// A temporary file a failed write or a killed process left behind.
		for (const name of readdirSync(dir)) if (name.endsWith(".tmp") && now - statSync(join(dir, name)).mtimeMs > DEAD_MS) rmSync(join(dir, name), { force: true });
	} catch { /* nothing to tidy */ }
}

/**
 * What allies' towers get of an entry (spec, Work board, Sharing; boss decision 2026-10-28): a `board_set` entry whole; an auto entry only the main's name and the done count
 * (`<name> (3/5)`), never a task's text and no items.
 */
export function forAllies(e: { now: string; items: BoardItem[]; src: Src; count?: Count | undefined; who?: string | undefined }): BoardText {
	if (e.src !== "todo") return { now: e.now, items: e.items };
	const tail = e.count ? `(${e.count.done}/${e.count.total})` : "", who = clean(e.who, BOARD.now - tail.length - 1);
	return { now: [who, tail].filter(Boolean).join(" "), items: [] };
}

/** The id an entry has on the wire: the first 8 bytes of sha256(device id ‖ session id), hex. No local session id leaves the computer. */
export const wireId = (device: string, session: string): string => createHash("sha256").update(device).update(session).digest().subarray(0, 8).toString("hex");

/** A live main as the join needs it (the net reading `tower_list` already does). */
export interface LiveMain { session: string; name: string; workspaceId: string; workspace: string; tab: string; state: string; cwd?: string; /** It commands work (a subagent of it runs): its entry is not stale. */ commanding?: boolean }
export interface LocalRow {
	session: string;
	workspaceId?: string;
	workspace: string;
	tab: string;
	main: string;
	state: string;
	now?: string;
	items: BoardItem[];
	updatedSecondsAgo?: number;
	/** A live main idle now whose entry is over 2 hours old: the text may no longer be true. */
	stale?: true;
	cwd?: string;
	src?: Src;
	count?: Count;
	who?: string;
}

/**
 * The local board: the entries joined with the live mains. A live main shows with its name and tab and the entry it wrote, if any; an entry whose session
 * is not a live main shows as `ended` until 30 minutes after its last update, then not at all. A finished auto entry (all todos done) of a live main is not shown
 * 30 minutes after it was written, and the entry of a main that is idle now, and commands nothing, shows as `stale` once it is over 2 hours old.
 */
export function joinLocal(entries: Entry[], mains: LiveMain[], now: number): LocalRow[] {
	const byId = new Map(entries.map((e) => [e.session, e]));
	const live = mains.map((m): LocalRow => {
		const found = byId.get(m.session), e = found && finished(found) && now - found.updated > ENDED_MS ? undefined : found;
		return {
			session: m.session, workspaceId: m.workspaceId, workspace: m.workspace, tab: m.tab, main: m.name, state: m.state, items: e?.items ?? [],
			...(e ? { now: e.now, src: e.src, ...(e.count ? { count: e.count } : {}), ...(e.who ? { who: e.who } : {}), updatedSecondsAgo: Math.max(0, Math.round((now - e.updated) / 1000)), ...(m.state === "idle" && !m.commanding && now - e.updated > STALE_MS ? { stale: true as const } : {}) } : {}), ...(m.cwd ? { cwd: m.cwd } : {}),
		};
	});
	const gone = entries.filter((e) => !mains.some((m) => m.session === e.session) && now - e.updated <= ENDED_MS).map((e): LocalRow => ({
		session: e.session, workspace: "", tab: "", main: "", state: "ended", now: e.now, items: e.items, src: e.src, ...(e.count ? { count: e.count } : {}), ...(e.who ? { who: e.who } : {}), updatedSecondsAgo: Math.max(0, Math.round((now - e.updated) / 1000)),
	}));
	return [...live, ...gone];
}
