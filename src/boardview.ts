import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type BoardItem, clean, type Count, type Entry, joinLocal, type LiveMain, readEntries, type Src } from "./board.ts";
import { isCoordinatorDuty } from "./duty.ts";
import type { Net } from "./net.ts";

type Keyed = { key: string; subs: Keyed[] };

// The work board on the boss's own page and in `/boss board` (docs/specs/2026-11-09-board-view.md): the rows of THIS computer's board, built with the code a tower's `board_read` uses (`readEntries` and `joinLocal`), unscrubbed (the boss's own
// view keeps raw text, as `board_read` does outside a remote turn) and cut to the board's caps by the reader. An ended entry stays while its file exists. Allies' boards are never an input here: the rows come from the files of this computer and its live mains.

/**
 * One row. `updated` (epoch ms) is when the line was written, not how long ago: the snapshot carries it so a page is sent only when the board moved, and the page counts the age itself. `stale`: a live main that is idle, whose line is over 2 hours old
 * (as `board_read`); `clearable`: the row is `ended` or `stale`, which is all the Clear button needs (and the server decides again at the click, from its own reading); `open`: see below. A live main with no line is a row with its name and tab only.
 */
export interface BoardViewRow {
	session: string;
	workspace: string;
	tab: string;
	/** The main's name; an ended row has the name an auto line kept (`who`), else none. */
	main: string;
	role?: "train";
	/** The net mark of a live main (`working`, `waiting`, `idle`, `commanding`, `done`, `error`, `unknown`), or `ended`. */
	state: string;
	now?: string;
	items: BoardItem[];
	src?: Src;
	count?: Count;
	updated?: number;
	stale?: true;
	clearable?: true;
	/** An ended row whose session is still open: it is not a main now (a takeover made it a member, or Herdr missed its pane for a reading). Clear tells it (B5: unless the agent is closed). */
	open?: true;
}

/** The ended rows shown are the newest this many (a folder that kept a hundred dead lines shows the latest); live mains are all shown. */
export const MAX_ENDED = 100;

/** The live mains of the net snapshot the server already built (units of this computer's own bases; a box this computer operates is another computer's board). */
export function mainsOfNet(net: Pick<Net, "bases">): LiveMain[] {
	return net.bases.filter((b) => !b.box).flatMap((b) => b.tabs.flatMap((t) => t.units.filter((u) => u.role === "main" || u.role === "train").map((u): LiveMain => ({
		session: u.key, ...(u.role === "train" ? { role: "train" as const } : {}), name: clean(u.name, 40), workspaceId: b.id, workspace: clean(b.label, 40), tab: clean(t.label, 40), state: u.mark, commanding: u.mark === "commanding", ...(u.role === "main" && isCoordinatorDuty(u.duty) ? { duty: u.duty } : {}),
	}))));
}

/** The session ids of every unit of this computer's own bases (any role, subagents too): the sessions that are open. */
export function openSessions(net: Pick<Net, "bases">): Set<string> {
	const keys = new Set<string>(), add = (u: Keyed): void => (keys.add(u.key), u.subs.forEach(add));
	for (const b of net.bases.filter((x) => !x.box)) (b.tower && add(b.tower), b.tabs.forEach((t) => t.units.forEach(add)), b.outside.forEach(add));
	return keys;
}

/** The rows: every live main in net order (the entry it wrote, if any), then the ended entries, newest first. `open`: the sessions that are open; an ended row among them is marked `open`. */
export function boardRows(entries: Entry[], mains: LiveMain[], now: number, open: ReadonlySet<string> = new Set()): BoardViewRow[] {
	const written = new Map(entries.map((e) => [e.session, e.updated])), all = joinLocal(entries, mains, now, { keepEnded: true });
	const live = all.filter((r) => r.state !== "ended"), ended = all.filter((r) => r.state === "ended").sort((a, b) => (written.get(b.session) ?? 0) - (written.get(a.session) ?? 0)).slice(0, MAX_ENDED);
	return [...live, ...ended].map((r): BoardViewRow => {
		const updated = r.now === undefined ? undefined : written.get(r.session);
		return {
			session: r.session, workspace: r.workspace, tab: r.tab, main: r.main || r.who || "", ...(r.role ? { role: r.role } : {}), state: r.state, ...(r.now !== undefined ? { now: r.now } : {}), items: r.items,
			...(r.src ? { src: r.src } : {}), ...(r.count ? { count: r.count } : {}), ...(updated !== undefined ? { updated } : {}), ...(r.stale ? { stale: true as const } : {}), ...(r.state === "ended" || r.stale ? { clearable: true as const } : {}), ...(r.state === "ended" && open.has(r.session) ? { open: true as const } : {}),
		};
	});
}

/**
 * The entries of the board folder, parsed again only when the folder changed: the listing with each file's name, size, modified time and inode (a writer replaces a file by rename, so a rewrite is a new inode even at the same size and millisecond). The signature costs a
 * `stat` per file, not a parse, and the net reads the board at every poll. A file that cannot be statted leaves nothing cached.
 */
export function cachedEntries(read: (dir: string) => Entry[] = readEntries) {
	let last: { dir: string; sig: string; entries: Entry[] } | undefined;
	return (dir: string): Entry[] => {
		let sig: string | undefined;
		try {
			sig = readdirSync(dir).filter((n) => n.endsWith(".json")).sort().map((n) => { const st = statSync(join(dir, n)); return `${n}:${st.size}:${st.mtimeMs}:${st.ino}`; }).join("|");
		} catch { /* no folder yet, or a file went away between the listing and the stat: read it plainly */ }
		if (sig !== undefined && last?.dir === dir && last.sig === sig) return last.entries;
		const entries = read(dir);
		last = sig === undefined ? undefined : { dir, sig, entries };
		return entries;
	};
}

/** What the net reads the board through (`netSource`'s `board`): nothing when there is no row, so an empty computer's snapshot has no `board`. A failed read leaves the board out and the net up. `entries`: how the folder is parsed (a test counts it). */
export function boardSeam(o: { dir: string; now(): number; entries?: (dir: string) => Entry[] }) {
	const entries = cachedEntries(o.entries);
	return {
		/** `live`: the session ids the broker lists now; a session it lists is open even when Herdr's reading has no pane for it (BV2-F002, the rule `/boss board` uses). */
		rows(net: Pick<Net, "bases">, live: readonly string[] = []): BoardViewRow[] | undefined {
			try {
				const open = openSessions(net);
				for (const id of live) open.add(id);
				const rows = boardRows(entries(o.dir), mainsOfNet(net), o.now(), open);
				return rows.length ? rows : undefined;
			} catch {
				return undefined;
			}
		},
	};
}
export type BoardSeam = ReturnType<typeof boardSeam>;

const MIN = 60_000;
/** `12 min ago`, `3 h ago`, `2 d ago`. */
export function agoText(ms: number): string {
	const n = Math.max(0, ms);
	return n < MIN ? "under 1 min ago" : n < 60 * MIN ? `${Math.floor(n / MIN)} min ago` : n < 24 * 60 * MIN ? `${Math.floor(n / (60 * MIN))} h ago` : `${Math.floor(n / (24 * 60 * MIN))} d ago`;
}
/** The done count of a row: an auto line's own count, else its items. None when there is nothing to count. */
export function doneCount(r: Pick<BoardViewRow, "items" | "count">): { done: number; total: number } | undefined {
	if (r.count) return r.count;
	return r.items.length ? { done: r.items.filter((i) => i.done).length, total: r.items.length } : undefined;
}

/** `/boss board`: the rows as text, one line each: `workspace › tab · main · state · now · n/m · age`, with `stale` marked (an ended row says so as its state). */
export function boardText(rows: BoardViewRow[], now: number): string {
	if (!rows.length) return "The work board is empty: no main has joined and no line is left.";
	const stale = rows.filter((r) => r.stale).length, ended = rows.filter((r) => r.state === "ended").length, bare = rows.filter((r) => r.now === undefined && r.state !== "ended").length;
	const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`, notes = [stale && `${stale} idle over 2 h`, ended && `${ended} ended`, bare && `${plural(bare, "main")} wrote none`].filter(Boolean);
	const head = `Work board: ${plural(rows.length - bare, "line")}${notes.length ? ` (${notes.join(", ")})` : ""}`;
	const lines = rows.map((r) => {
		const count = doneCount(r);
		return [[r.workspace, r.tab].filter(Boolean).join(" › "), r.main || r.session.slice(0, 8), ...(r.role ? ["train"] : []), r.open ? "not a main" : r.state, r.now ?? "no line", ...(count ? [`${count.done}/${count.total}`] : []), ...(r.updated !== undefined ? [agoText(now - r.updated)] : []), ...(r.stale ? ["stale"] : [])].filter(Boolean).join(" · ");
	});
	return [head, ...lines].join("\n");
}
