import { closeSync, openSync, readSync, statSync } from "node:fs";
import { type Json, parse, toItem } from "../items.ts";
import type { HeadAskRow, HeadSeam } from "../nethead.ts";
import { groupsOf, type HeadAsk, openAsks, readAsks } from "./headasks.ts";
import { readChapters } from "./headchapters.ts";
import { headId, type Slot } from "./record.ts";

// What the net needs of the server to show the head tower (docs/specs/2026-11-04-head-tower.md, The GUI channel, Snapshot): its key, its asks, its chapters, and when it last said something.

/** The most asks the snapshot carries: the newest whole broadcasts (the page folds a group into one row, so a group is never cut). */
const ASKS = 60;
/**
 * The most whole text (`sent` and `boss`, in UTF-16 units) one snapshot carries (docs/specs/2026-11-07-head-log-cards.md, Data): every page and paired phone gets the whole snapshot on every net change, so the cards' texts are bounded as the rows are.
 * The newest broadcasts take it first, whole; the first one that does not fit and every older one ship without them, and their cards show the first line. A tower's copy of the message that equals the first tower's is not sent twice.
 */
export const TEXTS = 24_000;
/** How far from the end of a conversation file the newest assistant text is looked for. */
const TAIL = 65_536;

/** The longest the newest line is (in UTF-16 units); a longer one ends in an ellipsis. */
const LINE = 160;

/**
 * The newest assistant message with text in the last bytes of a session file, by the head page's log filter (items.ts `toItem`: an assistant item whose text is not empty; tool-only, user, and notice entries are not the head's words):
 * its own time, and the first non-empty line of its text. Both undefined when there is none or the file cannot be read.
 */
function lastWords(file: string): { at?: number; line?: string } {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const { size } = statSync(file), start = Math.max(0, size - TAIL), buf = Buffer.alloc(size - start);
		readSync(fd, buf, 0, buf.length, start);
		const rows = buf.toString("utf8").split("\n");
		if (start) rows.shift();
		for (const raw of rows.reverse()) {
			if (!raw.includes('"assistant"')) continue;
			const entry: Json | undefined = parse(raw), item = entry && toItem(entry, raw.length), at = item?.kind === "assistant" && item.text ? Date.parse(item.at ?? "") : NaN;
			if (!Number.isFinite(at)) continue;
			// a fence line is no words; a heading's, quote's, or list's marks and bold go; the cut counts characters, so an emoji is never split
			const first = item!.text!.split("\n").map((l) => l.trim()).filter((l) => !l.startsWith("```")).map((l) => l.replace(/^(?:[#>]+\s*|[-*+]\s+)+/, "").replaceAll("**", "").trim()).find(Boolean), chars = first ? Array.from(first) : [];
			return { at, ...(first ? { line: chars.length > LINE ? `${chars.slice(0, LINE - 1).join("")}…` : first } : {}) };
		}
	} catch {
		// a file that is not there yet, or that cannot be read, has said nothing
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	return {};
}

export function headSeam(slot: Slot, now: () => number): HeadSeam {
	// The conversation file is read again only when it changed: the net is read every two seconds.
	const seen = new Map<string, { sig: string; words: { at?: number; line?: string } }>();
	const words = (file: string | undefined) => {
		if (!file) return {};
		try {
			const s = statSync(file), sig = `${s.size}:${s.mtimeMs}`, kept = seen.get(file);
			if (kept?.sig === sig) return kept.words;
			const read = lastWords(file);
			seen.set(file, { sig, words: read });
			return read;
		} catch {
			return {};
		}
	};
	return {
		key: headId(slot),
		asks: (): HeadAskRow[] => {
			const open = new Set(openAsks(slot, now()).map((a) => a.id)), all = readAsks(slot, now()), groups = groupsOf(all), kept = new Set<string>();
			// The newest groups, whole, while they fit (the newest one always does).
			let used = 0;
			const sizes = new Map<string, number>();
			for (const a of all) sizes.set(groups.get(a.id)!, (sizes.get(groups.get(a.id)!) ?? 0) + 1);
			for (const g of [...new Set(all.map((a) => groups.get(a.id)!))].reverse()) {
				if (used && used + sizes.get(g)! > ASKS) break;
				used += sizes.get(g)!;
				kept.add(g);
			}
			// The newest broadcasts' whole texts, while they fit: a copy of the message that equals the broadcast's first is left out (the page falls back to the first's).
			const byGroup = new Map<string, HeadAsk[]>(), whole = new Set<string>();
			for (const a of all) byGroup.set(groups.get(a.id)!, [...(byGroup.get(groups.get(a.id)!) ?? []), a]);
			const cost = (rows: HeadAsk[]) => rows.reduce((n, a, i) => n + (a.boss?.length ?? 0) + (a.sent && (i === 0 || a.sent !== rows[0]!.sent) ? a.sent.length : 0), 0);
			let spent = 0;
			for (const g of [...byGroup.keys()].reverse()) {
				if (!kept.has(g)) continue;
				const c = cost(byGroup.get(g)!);
				if (spent + c > TEXTS) break;
				spent += c;
				whole.add(g);
			}
			return all.filter((a) => kept.has(groups.get(a.id)!)).map((a) => {
				const group = groups.get(a.id)!, replaced = a.supersedes ? groups.get(a.supersedes) ?? a.supersedes : undefined, state: HeadAskRow["state"] = a.answers.length ? "answered" : a.acted !== undefined ? "handled" : a.read !== undefined ? "received" : a.parked !== undefined && open.has(a.id) ? "parked" : open.has(a.id) ? "waiting" : "silent";
				const texts = whole.has(group), lead = byGroup.get(group)![0]!;
				return { id: a.id, group, workspace: a.workspace, label: a.label, since: a.at, at: a.last, first: a.first, state, answers: a.answers.length, ...(a.answers.at(-1) ? { last: a.answers.at(-1)!.first } : {}), ...(texts && a.sent && (a === lead || a.sent !== lead.sent) ? { sent: a.sent } : {}), ...(texts && a.boss ? { boss: a.boss } : {}), ...(replaced && replaced !== group ? { supersedes: replaced } : {}), ...(state === "handled" && a.missed !== undefined ? { missed: true as const } : {}) };
			});
		},
		chapters: () => readChapters(slot),
		said: (file) => words(file).at,
		line: (file) => words(file).line,
	};
}
