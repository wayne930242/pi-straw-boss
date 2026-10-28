import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clean } from "../board.ts";
import type { MemorySummary } from "../net.ts";
import type { Log } from "./log.ts";
import type { Slot } from "./record.ts";
import { ageOf } from "./towerbrief.ts";
import { ensureDir, towerDir, towersDir, writeDurable } from "./towerstore.ts";
import { secretDir } from "./record.ts";

// The tower's memory (docs/specs/2026-10-26-sb-backend.md, Tower memory): `tower/<workspace id>/memory.json`, mode 600, written by rename. It holds the boss's standing instructions and decisions, verbatim,
// and the waits the tower keeps. Standing and decision text is the boss's own typing: from the GUI panel, or quoted from a boss message the run took (`checkQuote`, checked here against the run's boss events);
// what an intercom message, an ally, or a link says can never become one. A quote is whole sentences of the boss's own words: it starts where a sentence starts and ends where one ends, and it is never inside quotation
// marks or text the boss pasted from someone else. Every add or retire a run makes leaves a notice the boss can undo. Waits are the tower's own notes. Only a local run's brief carries any of it; it never reaches an ally run, a board, a link envelope,
// or the log (a log line names the op and the id, never the text).

/** `standingBudget`: the rows of all standing instructions together (an id, the text, a line break), so the brief always shows every one; `rest` is what the waits and decisions get on top of what the standing rows used. */
export const MEM = { standing: 12, decision: 24, wait: 12, text: 300, waitText: 200, outcome: 120, quote: 4, expireMs: 7 * 86_400_000, keepMs: 86_400_000, dueMin: 5, dueMax: 7 * 24 * 60, standingBudget: 2400, rest: 1450, briefCap: 4200, notices: 40 } as const;
export type Kind = "standing" | "decision" | "wait";
export type WaitState = "open" | "answered" | "resolved" | "expired";
export interface Entry {
	id: string;
	kind: Kind;
	text: string;
	by: "boss" | "run";
	via: "gui" | "prompt" | "run";
	at: string;
	/** A run's entry: the run, and the boss event its quote was found in. */
	run?: string;
	event?: string;
	/** A wait: who it waits for, the session it is on, its state and times. */
	for?: "boss" | "agent";
	on?: { id: string; name: string };
	state?: WaitState;
	due?: string;
	answered?: string;
	outcome?: string;
	/** When a resolved or expired wait ended: it is kept 24 h after. */
	ended?: string;
	/** An expired wait a brief has shown once. */
	shown?: true;
}
/** `run`: a change a run made, with the entry as it was kept or retired, so the boss can undo it. */
export interface Notice { id: string; text: string; at: string; run?: { op: "added" | "retired"; entry: Entry } }
export interface Memory { v: 1; rev: number; next: { S: number; D: number; W: number }; entries: Entry[]; notices: Notice[] }
/** Who writes: the boss (the GUI or the tower prompt), or a run, with the boss event it quoted. */
export type Writer = { by: "boss"; via: "gui" | "prompt" } | { by: "run"; run: string; event?: string };
/** A refusal the caller may show as it is: a cap that is full, an entry that is not there. */
export class Refused extends Error {}

export const emptyMemory = (): Memory => ({ v: 1, rev: 0, next: { S: 1, D: 1, W: 1 }, entries: [], notices: [] });
const LETTER = { standing: "S", decision: "D", wait: "W" } as const;
const iso = (ms: number) => new Date(ms).toISOString();
const fold = (text: string) => text.replace(/\s+/gu, " ").trim();
const chars = (text: string) => Array.from(text).length;
const cut = (text: string, max: number) => (chars(text) > max ? `${Array.from(text).slice(0, max - 1).join("").trimEnd()}…` : text);
const hhmm = (at: string) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** One line of cleaned text, as the board cleans it (controls and format characters removed, whitespace folded); refused when empty or over `max`. */
function tidy(what: string, text: unknown, max: number): string {
	if (typeof text !== "string") throw new Error(`${what} has to be text`);
	const out = clean(text, 1_000_000);
	if (!out) throw new Error(`${what} is empty`);
	if (chars(out) > max) throw new Error(`${what} is too long: at most ${max} characters`);
	return out;
}

// --- the file --------------------------------------------------------------------------------------------------------------------------------------------------------

const fileOf = (slot: Slot, workspace: string) => join(towerDir(slot, workspace), "memory.json");
const isEntry = (e: unknown): e is Entry => {
	const v = e as Partial<Entry> | null;
	return typeof v === "object" && v !== null && typeof v.id === "string" && /^[SDW]\d+$/.test(v.id) && v.id[0] === LETTER[v.kind as Kind] && typeof v.text === "string" && (v.by === "boss" || v.by === "run") && typeof v.at === "string" && (v.kind !== "wait" || ["open", "answered", "resolved", "expired"].includes(String(v.state)));
};
/** The workspace's memory; `problem` when the file is there but cannot be read (nothing is written over it then). A missing file is an empty memory. */
export function loadMemory(slot: Slot, workspace: string): { memory: Memory; problem?: string } {
	let text: string;
	try {
		text = readFileSync(fileOf(slot, workspace), "utf8");
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === "ENOENT" ? { memory: emptyMemory() } : { memory: emptyMemory(), problem: `memory.json cannot be read (${(cause as NodeJS.ErrnoException).code ?? "unknown"})` };
	}
	let raw: Partial<Memory> | undefined;
	try {
		raw = JSON.parse(text) as Partial<Memory>;
	} catch { /* reported below */ }
	if (!raw || raw.v !== 1 || !Number.isInteger(raw.rev) || !Array.isArray(raw.entries) || !raw.entries.every(isEntry)) return { memory: emptyMemory(), problem: "memory.json is unreadable (not the format this server writes); fix or remove it" };
	const entries = raw.entries;
	// A counter is never below the largest id in the file, whatever the file says.
	const top = (letter: string) => entries.reduce((n, e) => (e.id[0] === letter ? Math.max(n, Number(e.id.slice(1))) : n), 0) + 1;
	const next = { S: Math.max(raw.next?.S ?? 1, top("S")), D: Math.max(raw.next?.D ?? 1, top("D")), W: Math.max(raw.next?.W ?? 1, top("W")) };
	const notices = (Array.isArray(raw.notices) ? raw.notices : []).filter((n): n is Notice => typeof n?.id === "string" && typeof n.text === "string" && typeof n.at === "string")
		.map((n): Notice => ((n.run?.op === "added" || n.run?.op === "retired") && isEntry(n.run.entry) ? n : { id: n.id, text: n.text, at: n.at }));
	return { memory: { v: 1, rev: raw.rev!, next, entries, notices } };
}

/**
 * Reads, sweeps, applies `change`, and writes the file with the rev one higher, in one synchronous step (no other write can come between). A `rev` the file has moved past is refused (code `rev`, the current
 * memory on the error), and so is a change that throws: nothing is written then. An unreadable file is never written over.
 */
export function updateMemory<T>(slot: Slot, workspace: string, now: number, change: (memory: Memory) => T, rev?: number): { value: T; memory: Memory } {
	const { memory, problem } = loadMemory(slot, workspace);
	if (problem) throw new Error(problem);
	if (rev !== undefined && rev !== memory.rev) throw Object.assign(new Error("The memory changed since you read it"), { code: "rev", memory });
	sweep(memory, now);
	const value = change(memory);
	memory.rev += 1;
	secretDir(towersDir(slot));
	ensureDir(towerDir(slot, workspace));
	writeDurable(fileOf(slot, workspace), memory);
	return { value, memory };
}

// --- the rules ---------------------------------------------------------------------------------------------------------------------------------------------------------

const isOpen = (e: Entry) => e.kind === "wait" && (e.state === "open" || e.state === "answered");
const idFor = (m: Memory, kind: Kind) => `${LETTER[kind]}${m.next[LETTER[kind]]++}`;
const stamp = (who: Writer, now: number): Pick<Entry, "by" | "via" | "at" | "run" | "event"> =>
	who.by === "boss" ? { by: "boss", via: who.via, at: iso(now) } : { by: "run", via: "run", at: iso(now), run: who.run, ...(who.event ? { event: who.event } : {}) };

/** Marks waits expired after 7 days and drops resolved or expired ones 24 h after they ended; true when it changed anything. */
export function sweep(m: Memory, now: number): boolean {
	let changed = false;
	for (const e of m.entries) {
		if (isOpen(e) && now - Date.parse(e.at) >= MEM.expireMs) (Object.assign(e, { state: "expired", ended: iso(Date.parse(e.at) + MEM.expireMs) }), (changed = true));
	}
	const kept = m.entries.filter((e) => e.kind !== "wait" || !e.ended || now - Date.parse(e.ended) <= MEM.keepMs);
	if (kept.length !== m.entries.length) (m.entries = kept, (changed = true));
	return changed;
}

/** A line the boss reads in the GUI until they dismiss it. */
function notify(m: Memory, now: number, text: string, run?: Notice["run"]): void {
	m.notices = [...m.notices, { id: `n-${randomBytes(4).toString("hex")}`, text, at: iso(now), ...(run ? { run } : {}) }].slice(-MEM.notices);
}
const rowCost = (text: string) => 8 + text.length + 1;
/** The standing rows have to fit the brief whole: the budget is checked when one is added or grown. `except` is the entry being edited. */
function fitsBrief(m: Memory, text: string, except?: Entry): void {
	const used = m.entries.filter((e) => e.kind === "standing" && e !== except).reduce((n, e) => n + rowCost(e.text), 0);
	if (used + rowCost(text) > MEM.standingBudget) throw new Refused(`The standing instructions would not fit the brief (${MEM.standingBudget} characters in all): shorten one or drop one`);
}

/**
 * A standing instruction or a decision. The caller has made `text` the boss's: typed by the boss, or checked as a quote of a boss message. The same text twice is the one entry. At the decision cap the boss's add drops
 * the oldest decision; a run's drops the oldest one a run made, and is refused when every decision is the boss's. A run's add leaves a notice the boss can undo. `dropped` collects the ids dropped for the cap.
 */
export function addText(m: Memory, now: number, who: Writer, kind: "standing" | "decision", text: unknown, dropped?: string[]): Entry {
	const line = tidy(kind === "standing" ? "A standing instruction" : "A decision", text, MEM.text);
	const same = m.entries.find((e) => e.kind === kind && e.text === line);
	if (same) return same;
	const have = m.entries.filter((e) => e.kind === kind);
	if (kind === "standing" && have.length >= MEM.standing) throw new Refused(`${MEM.standing} standing instructions are kept already: ask the boss to drop one (/forget or the GUI)`);
	if (kind === "standing") fitsBrief(m, line);
	if (kind === "decision" && have.length >= MEM.decision) {
		const old = who.by === "run" ? have.find((e) => e.by === "run") : have[0];
		if (!old) throw new Refused(`${MEM.decision} decisions are kept and all of them are the boss's: ask the boss to drop one (/forget or the GUI)`);
		m.entries.splice(m.entries.indexOf(old), 1);
		dropped?.push(old.id);
		notify(m, now, `Decision ${old.id} was dropped to keep ${MEM.decision}: ${cut(old.text, 80)}`);
	}
	const entry: Entry = { id: idFor(m, kind), kind, text: line, ...stamp(who, now) };
	m.entries.push(entry);
	if (who.by === "run") notify(m, now, `The tower kept ${entry.id} from your message: ${cut(entry.text, 160)}`, { op: "added", entry: structuredClone(entry) });
	return entry;
}
export interface WaitInput { text: unknown; for: unknown; on?: { id: string; name: string }; dueMin?: unknown }
export function addWait(m: Memory, now: number, who: Writer, input: WaitInput): Entry {
	const text = tidy("A wait", input.text, MEM.waitText);
	if (input.for !== "boss" && input.for !== "agent") throw new Error("for is boss or agent");
	if (input.for === "boss" && input.on) throw new Error("A boss wait names no session");
	if (input.for === "agent" && !input.on) throw new Error("An agent wait names the session it waits on (on)");
	const due = input.dueMin;
	if (due !== undefined && (typeof due !== "number" || !Number.isFinite(due) || due < MEM.dueMin || due > MEM.dueMax)) throw new Error(`due is 5 minutes to 7 days (${MEM.dueMin} to ${MEM.dueMax} minutes)`);
	if (m.entries.filter(isOpen).length >= MEM.wait) throw new Refused(`${MEM.wait} open waits are kept already: resolve or drop one`);
	const entry: Entry = { id: idFor(m, "wait"), kind: "wait", text, ...stamp(who, now), for: input.for, ...(input.on ? { on: { id: input.on.id, name: clean(input.on.name, 40) } } : {}), state: "open", ...(due !== undefined ? { due: iso(now + due * 60_000) } : {}) };
	m.entries.push(entry);
	return entry;
}
const find = (m: Memory, id: unknown, what = "entry"): Entry => {
	const found = typeof id === "string" ? m.entries.find((e) => e.id === id) : undefined;
	if (!found) throw new Refused(`No such ${what} ${String(id)}`);
	return found;
};
const findWait = (m: Memory, id: unknown): Entry => {
	const found = typeof id === "string" ? m.entries.find((e) => e.id === id && e.kind === "wait") : undefined;
	if (!found) throw new Refused(`No such wait ${String(id)}`);
	return found;
};
/** The wait ends well: it stays 24 h with a one-line outcome, struck through in the GUI. */
export function resolveWait(m: Memory, id: unknown, outcome: unknown, now: number): Entry {
	const e = findWait(m, id);
	const line = outcome === undefined || outcome === "" ? undefined : tidy("The outcome", outcome, MEM.outcome);
	if (e.state === "resolved") throw new Refused(`${e.id} is resolved already`);
	Object.assign(e, { state: "resolved", ended: iso(now), ...(line ? { outcome: line } : {}) });
	delete e.shown;
	return e;
}
export function dropWait(m: Memory, id: unknown): Entry {
	const e = findWait(m, id);
	m.entries.splice(m.entries.indexOf(e), 1);
	return e;
}
/** The boss edits an entry's text; from then on it is the boss's own words. */
export function editEntry(m: Memory, id: unknown, text: unknown, via: "gui" | "prompt" = "gui"): Entry {
	const e = find(m, id);
	const line = tidy("The text", text, e.kind === "wait" ? MEM.waitText : MEM.text);
	if (e.kind === "standing") fitsBrief(m, line, e);
	Object.assign(e, { text: line, by: "boss", via });
	delete e.run;
	delete e.event;
	return e;
}
export function removeEntry(m: Memory, id: unknown): Entry {
	const e = find(m, id);
	m.entries.splice(m.entries.indexOf(e), 1);
	return e;
}
/** A run retires a standing instruction or a decision on the boss's words: it leaves a notice with the entry in it, so the boss can bring it back. */
export function retireEntry(m: Memory, now: number, id: string): Entry {
	const e = find(m, id);
	if (e.kind === "wait") throw new Refused("retire removes a standing instruction or a decision; resolve or drop a wait");
	m.entries.splice(m.entries.indexOf(e), 1);
	notify(m, now, `The tower retired ${e.id} on your words: ${cut(e.text, 160)}`, { op: "retired", entry: structuredClone(e) });
	return e;
}
const noticeOf = (m: Memory, id: unknown): Notice => {
	const found = typeof id === "string" ? m.notices.find((n) => n.id === id) : undefined;
	if (!found) throw new Refused(`No such notice ${String(id)}`);
	return found;
};
/** The boss undoes what a run did: the entry it kept is removed (unless the boss has edited it since: those are their words now), the one it retired is put back under its own id. The notice goes. */
export function undoNotice(m: Memory, id: unknown): Entry {
	const n = noticeOf(m, id), run = n.run;
	if (!run) throw new Refused("That notice has nothing to undo: dismiss it");
	const entry = structuredClone(run.entry);
	if (run.op === "added") {
		const now = m.entries.find((e) => e.id === entry.id);
		if (now && (now.by !== "run" || now.text !== entry.text)) throw new Refused(`${now.id} was changed after the run kept it: edit or delete it in the list`);
		if (now) m.entries.splice(m.entries.indexOf(now), 1);
	} else if (!m.entries.some((e) => e.id === entry.id)) {
		const same = m.entries.filter((e) => e.kind === entry.kind);
		if (entry.kind === "standing" && same.length >= MEM.standing) throw new Refused(`${MEM.standing} standing instructions are kept already: drop one first`);
		if (entry.kind === "standing") fitsBrief(m, entry.text);
		if (entry.kind === "decision" && same.length >= MEM.decision) throw new Refused(`${MEM.decision} decisions are kept already: drop one first`);
		const number = Number(entry.id.slice(1)), after = same.find((e) => Number(e.id.slice(1)) > number);
		m.entries.splice(after ? m.entries.indexOf(after) : m.entries.length, 0, entry);
	}
	m.notices = m.notices.filter((x) => x !== n);
	return entry;
}
/** The boss has read one notice. */
export function dismissNotice(m: Memory, id: unknown): void {
	const n = noticeOf(m, id);
	m.notices = m.notices.filter((x) => x !== n);
}
/** A message from `session` arrived: every open wait on it is `answered` (the server does not judge what the message means). Returns the ids. */
export function answerWaits(m: Memory, session: string, now: number): string[] {
	const hit = m.entries.filter((e) => e.kind === "wait" && e.state === "open" && e.for === "agent" && e.on?.id === session);
	for (const e of hit) Object.assign(e, { state: "answered", answered: iso(now) });
	return hit.map((e) => e.id);
}

/** Whether an open wait is on `session` (a read of the file only; an unreadable file has none). */
export function hasWaitOn(slot: Slot, workspace: string, session: string): boolean {
	const { memory, problem } = loadMemory(slot, workspace);
	return !problem && memory.entries.some((e) => e.kind === "wait" && e.state === "open" && e.for === "agent" && e.on?.id === session);
}

/** A message arrived from `session`: the open waits on it become answered, and the file is written only when there is one. Returns the ids. */
export function noteMessage(slot: Slot, workspace: string, now: number, session: string): string[] {
	const { memory, problem } = loadMemory(slot, workspace);
	if (problem || !memory.entries.some((e) => e.kind === "wait" && e.state === "open" && e.for === "agent" && e.on?.id === session)) return [];
	return updateMemory(slot, workspace, now, (m) => answerWaits(m, session, now)).value;
}

// --- the quote rule ------------------------------------------------------------------------------------------------------------------------------------------------------------

const STOP = /[.!?;]/u, STOP_CJK = /[。！？；]/u, BREAK = /[\n\r\u2028\u2029]/u;
const OPENS: Record<string, string> = { '"': '"', "“": "”", "「": "」", "『": "』", "«": "»" };
const PEER = /(?:\b(?:wrote|writes|said|says|replied|replies)\b|寫道|說道|回覆|回信)\s*[:：]/giu;
const HEADER = /\[(?:straw net|from|intercom)\b[^\]\n]*\]/giu;

/** The characters of `text` that are not the boss's own words as far as the text shows it: inside quotation marks, on a `>` line or in a code fence, and from a "wrote:" marker or a message header to the end of its paragraph. */
function pasted(text: string): boolean[] {
	const mask = new Array<boolean>(text.length).fill(false);
	const span = (from: number, to: number) => { for (let i = from; i < Math.min(to, text.length); i++) mask[i] = true; };
	const paragraphEnd = (from: number) => { const hit = /\n[ \t\r]*\n/u.exec(text.slice(from)); return hit ? from + hit.index : text.length; };
	let close: string | undefined, open = 0;
	for (let i = 0; i < text.length; i++) {
		if (close === undefined) { if (OPENS[text[i]!]) (close = OPENS[text[i]!]), (open = i); }
		else if (text[i] === close) (span(open, i + 1), (close = undefined));
	}
	if (close !== undefined) span(open, text.length);
	let at = 0, fenced = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/u.test(line)) (span(at, at + line.length), (fenced = !fenced));
		else if (fenced || /^\s*>/u.test(line)) span(at, at + line.length);
		at += line.length + 1;
	}
	for (const re of [PEER, HEADER]) for (const hit of text.matchAll(re)) span(hit.index, paragraphEnd(hit.index));
	return mask;
}
/** `text` with whitespace folded as `fold` does, and for each character of the result whether it is pasted text and, for a folded space, whether a line break was in it. */
function lay(text: string): { flat: string; masked: boolean[]; breaks: boolean[] } {
	const mask = pasted(text), flat: string[] = [], masked: boolean[] = [], breaks: boolean[] = [];
	let gap = "", gapMasked = false;
	for (let i = 0; i < text.length; i++) {
		if (/\s/u.test(text[i]!)) ((gap += text[i]), (gapMasked ||= mask[i]!));
		else {
			if (gap && flat.length) (flat.push(" "), masked.push(gapMasked), breaks.push(BREAK.test(gap)));
			(gap = ""), (gapMasked = false);
			flat.push(text[i]!), masked.push(mask[i]!), breaks.push(false);
		}
	}
	return { flat: flat.join(""), masked, breaks };
}
/** A sentence ends at the mark: a CJK one always, an ASCII one when a space or the end follows (so `v1.2` ends nothing). */
const stopAt = (flat: string, k: number) => STOP_CJK.test(flat[k]!) || (STOP.test(flat[k]!) && (k + 1 >= flat.length || flat[k + 1] === " "));
const startsSentence = (l: ReturnType<typeof lay>, at: number) => at === 0 || (l.flat[at - 1] === " " ? l.breaks[at - 1]! || stopAt(l.flat, at - 2) : STOP_CJK.test(l.flat[at - 1]!));
const endsSentence = (l: ReturnType<typeof lay>, to: number) => to >= l.flat.length || stopAt(l.flat, to - 1) || (l.flat[to] === " " && l.breaks[to]!);

/**
 * The quote rule: `quote` has to be whole sentences of one boss message this run took, verbatim (whitespace folded), at least 4 and at most 300 characters: it starts where a sentence or a line starts and ends where
 * one ends, so no leading "do not" is dropped and no clause is cut out of its sentence, and no character of it lies inside quotation marks, a `>` line, a code fence, or text after a "wrote:" marker or a message
 * header (what the boss pasted from someone else). The newest message that holds it is the one recorded; `event` limits the search to one message. Returns the quote itself as the text to keep.
 */
export function checkQuote(quote: unknown, events: { id: string; text: string }[], event?: string): { text: string; event: string } {
	if (typeof quote !== "string") throw new Error("quote has to be text");
	const wanted = fold(quote);
	if (chars(wanted) < MEM.quote) throw new Error(`quote has to be at least ${MEM.quote} characters of the boss's words`);
	if (chars(wanted) > MEM.text) throw new Error(`quote is too long: at most ${MEM.text} characters`);
	const pool = event === undefined ? events : events.filter((e) => e.id === event);
	if (event !== undefined && !pool.length) throw new Error(`${event} is not a boss message of this run`);
	let present = false;
	for (const e of [...pool].reverse()) {
		const l = lay(e.text);
		for (let at = l.flat.indexOf(wanted); at >= 0; at = l.flat.indexOf(wanted, at + 1)) {
			present = true;
			const to = at + wanted.length;
			if (!l.masked.slice(at, to).some(Boolean) && startsSentence(l, at) && endsSentence(l, to)) return { text: tidy("quote", wanted, MEM.text), event: e.id };
		}
	}
	throw new Error(present ? "quote whole sentences of the boss's own words: start where a sentence starts, end where it ends, and stay out of quotation marks and of text the boss pasted from someone else" : "quote the boss's words verbatim from a boss message of this run");
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3040-\u30ff\uac00-\ud7af]/u;
const weight = (c: string) => (CJK.test(c) ? 2 : 1);
/** The weight of the longest run of characters two texts share: a CJK character counts double, as it carries about two letters. */
function shared(a: string, b: string): number {
	const x = Array.from(a.toLowerCase()), y = Array.from(b.toLowerCase());
	let best = 0, prev = new Array<number>(y.length + 1).fill(0);
	for (const cx of x) {
		const row = new Array<number>(y.length + 1).fill(0);
		for (let j = 1; j <= y.length; j++) if (cx === y[j - 1]) (row[j] = prev[j - 1]! + weight(cx)), (best = Math.max(best, row[j]!));
		prev = row;
	}
	return best;
}
/** Whether the boss's words are about this entry: they name its id (`S3`, not `S30`), or hold a run of its own words of twelve letters' weight (all of it when it is shorter). */
export function bindsTo(entry: Entry, quote: string): boolean {
	return new RegExp(`(?<![A-Za-z0-9])${entry.id}(?![A-Za-z0-9])`, "iu").test(quote) || shared(entry.text, quote) >= Math.min(12, Array.from(entry.text).reduce((n, c) => n + weight(c), 0));
}

// --- what the brief and the GUI see ---------------------------------------------------------------------------------------------------------------------------------

// A standing instruction or a decision is shown whole (300 characters at most); a wait's line adds its words around its 200. A text is cleaned again as it is read, whatever the file holds: no control or format character and no line break reaches a brief.
const row = (id: string, text: string, cap: number = MEM.text) => `- [${id}] ${cut(clean(text, 1_000_000), cap)}`;
function waitRow(e: Entry, now: number): string {
	if (e.state === "expired") return row(e.id, `expired (open for 7 days): ${e.text}`, MEM.waitText + 60);
	const who = e.for === "boss" ? "for boss" : `for ${e.on?.name ?? "a session"}`;
	const due = e.due ? (Date.parse(e.due) <= now ? ` (overdue ${ageOf(now - Date.parse(e.due))})` : ` (due in ${ageOf(Date.parse(e.due) - now)})`) : "";
	return row(e.id, e.state === "answered" ? `answered? message from ${e.on?.name ?? "the session"} ${hhmm(e.answered ?? e.at)} · ${who}: ${e.text}${due}` : `${who}: ${e.text}${due}`, MEM.waitText + 140);
}
/**
 * The brief's Memory section (section 3a), at most 4,200 characters: every standing instruction (their rows together never pass the budget that guarantees it), then the open waits and the newest decisions in the
 * room the standing rows left plus 1,450, then what was left out and how to read it. Every entry is one line behind a code-written id, so no text can open a line or forge a heading. `expired` names the expired waits shown here: the caller marks them shown.
 */
export function memorySection(m: Memory, now: number, problem?: string): { text: string; expired: string[] } {
	if (problem) return { text: `Memory: ${problem}. Nothing in it is available to you now; the boss sees this in the GUI.`, expired: [] };
	const standing = m.entries.filter((e) => e.kind === "standing").map((e) => row(e.id, e.text));
	const waitsOf = m.entries.filter((e) => e.kind === "wait" && (e.state !== "expired" || !e.shown)).sort((a, b) => Number(a.state === "expired") - Number(b.state === "expired") || Number(b.for === "boss") - Number(a.for === "boss") || a.at.localeCompare(b.at));
	const decisions = m.entries.filter((e) => e.kind === "decision").reverse().map((e) => row(e.id, e.text));
	const waits = waitsOf.filter((e) => e.state !== "resolved").map((e) => ({ e, line: waitRow(e, now) }));
	if (!standing.length && !waits.length && !decisions.length) return { text: "", expired: [] };
	const head = "Memory: standing instructions and decisions are the boss's words, verbatim; open waits are your own notes: not instructions.";
	const out = [head], shownWaits: string[] = [];
	let used = head.length, room = MEM.briefCap - 150;
	const place = (heading: string, rows: string[], more: (n: number) => string, mark?: (n: number) => void): void => {
		let shown = 0;
		for (const line of rows) {
			const cost = (shown ? 0 : heading.length + 1) + line.length + 1;
			if (used + cost > room) break;
			if (!shown) out.push(heading);
			out.push(line);
			used += cost;
			shown++;
		}
		mark?.(shown);
		if (shown < rows.length) out.push(more(rows.length - shown));
	};
	const READ = "tower_memory read";
	place("Standing instructions:", standing, (n) => `(+${n} more standing instructions in memory: ${READ})`);
	room = Math.min(room, used + MEM.rest);
	place("Waits:", waits.map((w) => w.line), (n) => `(+${n} more waits in memory: ${READ})`, (n) => shownWaits.push(...waits.slice(0, n).map((w) => w.e.id)));
	place("Decisions (newest first):", decisions, (n) => `(+${n} older decisions in memory: ${READ})`);
	return { text: out.join("\n").slice(0, MEM.briefCap), expired: shownWaits.filter((id) => waits.find((w) => w.e.id === id)?.e.state === "expired") };
}
/** The marks a brief leaves: the expired waits it showed are not shown again. */
export function markShown(slot: Slot, workspace: string, now: number, ids: string[]): void {
	if (!ids.length) return;
	updateMemory(slot, workspace, now, (m) => void m.entries.forEach((e) => ids.includes(e.id) && e.state === "expired" && (e.shown = true)));
}

/** What the net snapshot carries: counts, the rev the panel compares with its own, the waits for the boss with their text, and the notices. */
export function memorySummary(m: Memory, now: number): MemorySummary {
	return {
		rev: m.rev, standing: m.entries.filter((e) => e.kind === "standing").length, decisions: m.entries.filter((e) => e.kind === "decision").length, waits: m.entries.filter(isOpen).length,
		bossWaits: m.entries.filter((e) => isOpen(e) && e.for === "boss").map((e) => ({ id: e.id, text: e.text, at: e.at })), notices: m.notices.map(({ id, text, run }) => ({ id, text, ...(run ? { run: runView(run) } : {}) })),
	};
}
/** The memory as the panel reads it, swept as of `now`. */
export function readMemory(slot: Slot, workspace: string, now: number): { memory: Memory; problem?: string } {
	const found = loadMemory(slot, workspace);
	sweep(found.memory, now);
	return found;
}
const runView = (run: NonNullable<Notice["run"]>) => ({ op: run.op, entry: run.entry.id, kind: run.entry.kind as "standing" | "decision", text: run.entry.text });
const view = (m: Memory) => ({
	rev: m.rev, notices: m.notices.map((n) => ({ id: n.id, text: n.text, at: n.at, ...(n.run ? { run: runView(n.run) } : {}) })),
	entries: m.entries.map((e) => ({ id: e.id, kind: e.kind, text: e.text, by: e.by, via: e.via, at: e.at, ...(e.for ? { for: e.for } : {}), ...(e.on ? { on: e.on.name } : {}), ...(e.state ? { state: e.state } : {}), ...(e.due ? { due: e.due } : {}), ...(e.answered ? { answered: e.answered } : {}), ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.ended ? { ended: e.ended } : {}) })),
});

/**
 * The GUI panel's request (`POST tower/<workspace>/memory`): read; and as the boss add (standing or decision), edit, delete, resolve a wait, ack the notices, and undo or dismiss one notice (a notice is named by its
 * id, so those two need no rev). Each other write names the rev it read; a file that has moved on is 409 `rev` with the current memory to redraw from. A cap that is full or an entry that is not there is 409 `refused`; a request that is wrong is 400.
 */
export function memoryRequest(slot: Slot, workspace: string, now: number, json: Record<string, unknown>, log?: Log): { status: number; body: Record<string, unknown> } {
	const op = json.op, no = (status: number, error: string, reason: string, extra: Record<string, unknown> = {}) => ({ status, body: { error, reason, ...extra } });
	if (op === "read") {
		const { memory, problem } = readMemory(slot, workspace, now);
		return problem ? no(409, "unreadable", problem) : { status: 200, body: view(memory) };
	}
	const dropped: string[] = [];
	const change: Record<string, (m: Memory) => Entry | void> = {
		add: (m) => {
			if (json.kind !== "standing" && json.kind !== "decision") throw new Error("The boss adds a standing instruction or a decision (kind)");
			return addText(m, now, { by: "boss", via: "gui" }, json.kind, json.text, dropped);
		},
		edit: (m) => editEntry(m, json.id, json.text),
		delete: (m) => removeEntry(m, json.id),
		resolve: (m) => resolveWait(m, json.id, json.outcome, now),
		ack: (m) => void (m.notices = []),
		undo: (m) => undoNotice(m, json.notice),
		dismiss: (m) => void dismissNotice(m, json.notice),
	};
	if (typeof op !== "string" || !Object.hasOwn(change, op)) return no(400, "bad_request", "op is read, add, edit, delete, resolve, ack, undo, or dismiss");
	const byNotice = op === "undo" || op === "dismiss";
	if (!byNotice && (typeof json.rev !== "number" || !Number.isInteger(json.rev))) return no(400, "bad_request", "A change names the rev it read");
	try {
		const done = updateMemory(slot, workspace, now, change[op]!, byNotice ? undefined : (json.rev as number));
		log?.line("tower-memory", { workspace, op, by: "boss", via: "gui", ...(done.value ? { id: done.value.id } : {}) });
		for (const id of dropped) log?.line("tower-memory", { workspace, op: "dropped", id, kind: "decision", by: "boss", via: "gui" });
		return { status: 200, body: { ...view(done.memory), ...(done.value ? { id: done.value.id } : {}) } };
	} catch (cause) {
		const error = cause as Error & { code?: string; memory?: Memory };
		if (error.code === "rev") return no(409, "rev", "The memory changed since you read it; it is shown again.", view(error.memory!));
		return error instanceof Refused ? no(409, "refused", error.message) : no(/memory\.json/.test(error.message) ? 409 : 400, /memory\.json/.test(error.message) ? "unreadable" : "bad_request", error.message);
	}
}

// --- the tool of a run -------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ToolEnv {
	slot: Slot;
	workspace: string;
	run: string;
	now(): number;
	/** The boss messages this run took, oldest first. */
	bossEvents(): { id: string; text: string }[];
	/** The live session named by an id or a name; rejects when there is none or several. */
	session(query: string): Promise<{ id: string; name: string }>;
	log: Log;
}
const str = (args: Record<string, unknown>, name: string): string => {
	const v = args[name];
	if (typeof v !== "string" || !v.trim()) throw new Error(`${name} has to be text`);
	return v;
};
/**
 * `tower_memory`, for a local run. add/retire of a standing instruction or a decision take a `quote` (checked against the boss messages the run took; the quote is stored as the text) and never `text`; a retire's
 * quote has to be about the entry it retires (`bindsTo`); each leaves a notice the boss can undo. A wait is the run's own words and takes no quote. `read` lists the whole memory, for what a brief left out. The server refuses the tool to an ally run by its token's kind (runtools.ts).
 */
export async function memoryTool(env: ToolEnv, args: Record<string, unknown>): Promise<{ text: string; details?: unknown }> {
	const { slot, workspace } = env, now = env.now(), op = args.op, who = (event?: string): Writer => ({ by: "run", run: env.run, ...(event ? { event } : {}) });
	const logged = (what: string, entry: Entry) => env.log.line("tower-memory", { workspace, op: what, id: entry.id, kind: entry.kind, by: "run", run: env.run.slice(0, 8) });
	const asked = typeof args.event === "string" && args.event ? args.event : undefined;
	if (op === "add" && (args.kind === "standing" || args.kind === "decision")) {
		if (args.text !== undefined) throw new Error("A standing instruction or a decision is kept as a quote of the boss's words: give quote, not text");
		const found = checkQuote(args.quote, env.bossEvents(), asked), kind = args.kind, dropped: string[] = [];
		const { value } = updateMemory(slot, workspace, now, (m) => addText(m, now, who(found.event), kind, found.text, dropped));
		logged("add", value);
		for (const id of dropped) env.log.line("tower-memory", { workspace, op: "dropped", id, kind: "decision", by: "run", run: env.run.slice(0, 8) });
		return { text: `Kept [${value.id}] as the boss's ${kind}: ${value.text}`, details: { id: value.id } };
	}
	if (op === "add" && args.kind === "wait") {
		const on = args.on === undefined ? undefined : await env.session(str(args, "on"));
		const { value } = updateMemory(slot, workspace, now, (m) => addWait(m, now, who(), { text: args.text, for: args.for, ...(on ? { on } : {}), dueMin: args.due }));
		logged("add", value);
		return { text: `Noted [${value.id}]: it shows in your brief until you resolve or drop it${value.for === "boss" ? " and tells the boss it waits for them" : ""}.`, details: { id: value.id } };
	}
	if (op === "add") throw new Error("kind is standing, decision, or wait");
	if (op === "retire") {
		const id = str(args, "id");
		const found = checkQuote(args.quote, env.bossEvents());
		const { value } = updateMemory(slot, workspace, now, (m) => {
			const e = find(m, id);
			if (e.kind !== "wait" && !bindsTo(e, found.text)) throw new Refused(`The boss's words do not name ${e.id} and do not hold enough of its own words: quote the boss asking for it by its id, or in its words`);
			return retireEntry(m, now, id);
		});
		logged("retire", value);
		return { text: `Retired [${value.id}] on the boss's words.`, details: { id: value.id } };
	}
	if (op === "read") {
		const { memory, problem } = readMemory(slot, workspace, now);
		if (problem) throw new Error(problem);
		const part = (title: string, rows: string[]) => (rows.length ? [title, ...rows] : []);
		const text = [
			...part("Standing instructions:", memory.entries.filter((e) => e.kind === "standing").map((e) => row(e.id, e.text))),
			...part("Waits:", memory.entries.filter((e) => e.kind === "wait" && e.state !== "resolved").map((e) => waitRow(e, now))),
			...part("Decisions (newest first):", memory.entries.filter((e) => e.kind === "decision").reverse().map((e) => row(e.id, e.text))),
		].join("\n") || "Nothing is kept.";
		env.log.line("tower-memory", { workspace, op: "read", by: "run", run: env.run.slice(0, 8) });
		return { text };
	}
	if (op === "resolve" || op === "drop") {
		const id = str(args, "id");
		const { value } = updateMemory(slot, workspace, now, (m) => (op === "resolve" ? resolveWait(m, id, args.outcome, now) : dropWait(m, id)));
		logged(op, value);
		return { text: op === "resolve" ? `Resolved [${value.id}]; the boss sees it struck through for a day.` : `Dropped [${value.id}].`, details: { id: value.id } };
	}
	throw new Error("op is add, retire, read, resolve, or drop");
}
