import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clean } from "../board.ts";
import type { MemorySummary } from "../net.ts";
import type { Locale } from "../towerprompt/messages.ts";
import { checkCard, type Card, DONE_LABEL, isCard, isPress, type Press, type Raiser, refusalText } from "./waitcard.ts";
import { lapsedWait } from "../waitlapse.ts";
import type { Log } from "./log.ts";
import type { Slot } from "./record.ts";
import { ageOf } from "./towerbrief.ts";
import { ensureDir, towerDir, towersDir, writeDurable } from "./towerstore.ts";
import { secretDir } from "./record.ts";
import { BOSS_ONLY_KINDS } from "./delegate.ts";

// The tower's memory (docs/specs/2026-10-26-sb-backend.md, Tower memory): `tower/<workspace id>/memory.json`, mode 600, written by rename. It holds the boss's standing instructions and decisions and the waits the tower keeps.
// Standing and decision text is the boss's: typed by the boss (the GUI, or `/boss memory` in pi), or a run's proposal that the boss confirmed there. A run can only PROPOSE one (or the retiring of one): a proposal
// waits apart from the live entries, expires after 7 days, and takes effect only through `confirmProposal`, which only the boss's route reaches (`memoryRequest`: the GUI's POST and the control socket's `tower-memory`,
// both refused to a run token); what an intercom message, an ally, or a link says can never become an instruction. Waits are the tower's own notes. Only a local run's brief carries any of it; it never reaches an ally
// run, a board, a link envelope, or the log (a log line names the op and the id, never the text).

/** `standingBudget`: the rows of all standing instructions together (an id, the text, a line break), so the brief always shows every one; `rest` is what the waits and decisions get on top of what the standing rows used; `briefCap` adds the room of the pending proposals. */
export const MEM = { standing: 12, decision: 24, wait: 12, proposals: 12, text: 300, waitText: 200, outcome: 120, cites: 300, expireMs: 7 * 86_400_000, keepMs: 86_400_000, dueMin: 5, dueMax: 7 * 24 * 60, standingBudget: 2400, rest: 1450, briefCap: 4900 } as const;
export type Kind = "standing" | "decision" | "wait";
export type WaitState = "open" | "answered" | "resolved" | "expired";
export interface Entry {
	id: string;
	kind: Kind;
	text: string;
	by: "boss" | "run";
	/** The boss's entry: typed by the boss, or confirmed from a run's proposal. A wait is the run's own (`run`). */
	via: "gui" | "proposal" | "run";
	at: string;
	/** A wait: the run that wrote it. */
	run?: string;
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
	/** A wait for the boss recorded as a card (docs/specs/2026-11-07-wait-cards.md); `text` is then the card's `do`. One without it is a legacy wait. */
	card?: Card;
	/** What the boss pressed on the card. */
	press?: Press;
	/** A boss wait recorded (or open) while auto mode is on: silent until they are back (docs/specs/2026-11-09-auto-mode.md, §6). `parkedTold`: its raiser was told once. */
	parked?: true;
	parkedTold?: true;
	/** The return list showed this wait (it was parked when auto mode ended, before 2026-11-21): the panel was its notice, so it raises no alert again. */
	listed?: true;
	/** A parked card that auto mode's end gave back and closed (docs/specs/2026-11-21-auto-return.md, AR-D3, AR-D4): to its raiser, to the tower's own event, or closed because nobody could take it (`gone`). */
	returned?: "raiser" | "tower" | "gone";
}
/** What a run asks of the boss: to keep a standing instruction or a decision (`add`, `text`), or to retire one (`retire`, `target` and the entry's `text` as it was). `event` and `cites`: the boss message it came from, shown to the boss as context. */
export interface Proposal { id: string; op: "add" | "retire"; kind: "standing" | "decision"; text: string; target?: string; run: string; event?: string; cites?: string; at: string }
export interface Memory { v: 1; rev: number; next: { S: number; D: number; W: number; P: number }; entries: Entry[]; proposals: Proposal[] }
/** A refusal the caller may show as it is: a cap that is full, an entry that is not there. */
export class Refused extends Error {}

export const emptyMemory = (): Memory => ({ v: 1, rev: 0, next: { S: 1, D: 1, W: 1, P: 1 }, entries: [], proposals: [] });
const LETTER = { standing: "S", decision: "D", wait: "W" } as const;
export const iso = (ms: number) => new Date(ms).toISOString();
const chars = (text: string) => Array.from(text).length;
export const cut = (text: string, max: number) => (chars(text) > max ? `${Array.from(text).slice(0, max - 1).join("").trimEnd()}…` : text);
export const hhmm = (at: string) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

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
const isProposal = (e: unknown): e is Proposal => {
	const v = e as Partial<Proposal> | null;
	return typeof v === "object" && v !== null && typeof v.id === "string" && /^P\d+$/.test(v.id) && (v.op === "add" || v.op === "retire") && (v.kind === "standing" || v.kind === "decision") && typeof v.text === "string" && typeof v.run === "string" && typeof v.at === "string" && (v.op === "add" || typeof v.target === "string");
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
	const proposals = raw?.proposals ?? [];
	if (!raw || raw.v !== 1 || !Number.isInteger(raw.rev) || !Array.isArray(raw.entries) || !raw.entries.every(isEntry) || !Array.isArray(proposals) || !proposals.every(isProposal)) return { memory: emptyMemory(), problem: "memory.json is unreadable (not the format this server writes); fix or remove it" };
	// An entry a run kept in the branch builds (`by: "run"`, a standing instruction or a decision) was never the boss's word: it comes back as a proposal, to be confirmed or rejected (a wait is a run's own note and stays).
	// A card or a press that fails its check (a newer build's, or damaged) is dropped on read, so the wait reads as a legacy one; nothing is written here.
	for (const e of raw.entries) {
		if (e.card !== undefined && !isCard(e.card)) (delete e.card, delete e.press);
		else if (e.press !== undefined && !isPress(e.press)) delete e.press;
		if (e.kind !== "wait" || e.for !== "boss") (delete e.card, delete e.press);
	}
	const entries = raw.entries.filter((e) => e.kind === "wait" || e.by !== "run");
	const revived = raw.entries.filter((e) => e.kind !== "wait" && e.by === "run");
	// A counter is never below the largest id in the file, whatever the file says.
	const all = raw.entries;
	const high = (letter: string) => [...all, ...proposals].reduce((n, e) => (e.id[0] === letter ? Math.max(n, Number(e.id.slice(1))) : n), 0) + 1;
	const next = { S: Math.max(raw.next?.S ?? 1, high("S")), D: Math.max(raw.next?.D ?? 1, high("D")), W: Math.max(raw.next?.W ?? 1, high("W")), P: Math.max(raw.next?.P ?? 1, high("P")) };
	const asked: Proposal[] = revived.map((e) => ({ id: `P${next.P++}`, op: "add", kind: e.kind as "standing" | "decision", text: e.text, run: e.run ?? "earlier build", at: e.at }));
	// A file an older build wrote may hold a list of notices: they are not read, and the next write leaves them out.
	return { memory: { v: 1, rev: raw.rev!, next, entries, proposals: [...proposals, ...asked] } };
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
	const before = JSON.stringify(memory);
	const value = change(memory);
	// A change that left everything as it was (the same text kept twice, the same proposal made again) writes nothing.
	if (JSON.stringify(memory) === before) return { value, memory };
	memory.rev += 1;
	secretDir(towersDir(slot));
	ensureDir(towerDir(slot, workspace));
	writeDurable(fileOf(slot, workspace), memory);
	return { value, memory };
}

// --- the rules ---------------------------------------------------------------------------------------------------------------------------------------------------------

const isOpen = (e: Entry) => e.kind === "wait" && (e.state === "open" || e.state === "answered");
const idFor = (m: Memory, kind: Kind) => `${LETTER[kind]}${m.next[LETTER[kind]]++}`;

/** Marks waits expired after 7 days, drops resolved or expired ones 24 h after they ended, and drops proposals the boss left 7 days; true when it changed anything. */
export function sweep(m: Memory, now: number): boolean {
	let changed = false;
	for (const e of m.entries) {
		if (isOpen(e) && now - Date.parse(e.at) >= MEM.expireMs) (Object.assign(e, { state: "expired", ended: iso(Date.parse(e.at) + MEM.expireMs) }), (changed = true));
	}
	const kept = m.entries.filter((e) => e.kind !== "wait" || !e.ended || now - Date.parse(e.ended) <= MEM.keepMs);
	if (kept.length !== m.entries.length) (m.entries = kept, (changed = true));
	const open = m.proposals.filter((p) => now - Date.parse(p.at) < MEM.expireMs);
	if (open.length !== m.proposals.length) (m.proposals = open, (changed = true));
	return changed;
}

const rowCost = (text: string) => 8 + text.length + 1;
/** The standing rows have to fit the brief whole: the budget is checked when one is added or grown. `except` is the entry being edited. */
function fitsBrief(m: Memory, text: string, except?: Entry): void {
	const used = m.entries.filter((e) => e.kind === "standing" && e !== except).reduce((n, e) => n + rowCost(e.text), 0);
	if (used + rowCost(text) > MEM.standingBudget) throw new Refused(`The standing instructions would not fit the brief (${MEM.standingBudget} characters in all): shorten one or drop one`);
}

/**
 * A standing instruction or a decision, as the boss's own: typed by the boss (`via` gui) or confirmed from a run's proposal (`via` proposal). The same text twice is the one entry. A cap that is full refuses the add:
 * nothing of the boss's is ever dropped to make room.
 */
export function addText(m: Memory, now: number, via: "gui" | "proposal", kind: "standing" | "decision", text: unknown): Entry {
	const line = tidy(kind === "standing" ? "A standing instruction" : "A decision", text, MEM.text);
	const same = m.entries.find((e) => e.kind === kind && e.text === line);
	if (same) return same;
	const have = m.entries.filter((e) => e.kind === kind).length;
	if (kind === "standing" && have >= MEM.standing) throw new Refused(`${MEM.standing} standing instructions are kept already: delete one first`);
	if (kind === "standing") fitsBrief(m, line);
	if (kind === "decision" && have >= MEM.decision) throw new Refused(`${MEM.decision} decisions are kept already: delete one first`);
	const entry: Entry = { id: idFor(m, kind), kind, text: line, by: "boss", via, at: iso(now) };
	m.entries.push(entry);
	return entry;
}
export interface WaitInput { text: unknown; for: unknown; on?: { id: string; name: string }; dueMin?: unknown }
export function addWait(m: Memory, now: number, run: string, input: WaitInput): Entry {
	const text = tidy("A wait", input.text, MEM.waitText);
	if (input.for !== "boss" && input.for !== "agent") throw new Error("for is boss or agent");
	if (input.for === "boss" && input.on) throw new Error("A boss wait names no session");
	if (input.for === "agent" && !input.on) throw new Error("An agent wait names the session it waits on (on)");
	const due = input.dueMin;
	if (due !== undefined && (typeof due !== "number" || !Number.isFinite(due) || due < MEM.dueMin || due > MEM.dueMax)) throw new Error(`due is 5 minutes to 7 days (${MEM.dueMin} to ${MEM.dueMax} minutes)`);
	// An answered wait is the tower's to resolve (its brief says so) and no longer waits on anyone, so it does not take a place from a new one; it still expires after 7 days.
	if (m.entries.filter((e) => e.kind === "wait" && e.state === "open").length >= MEM.wait) throw new Refused(`${MEM.wait} open waits are kept already: resolve or drop one`);
	const entry: Entry = { id: idFor(m, "wait"), kind: "wait", text, by: "run", via: "run", at: iso(now), run, for: input.for, ...(input.on ? { on: { id: input.on.id, name: clean(input.on.name, 40) } } : {}), state: "open", ...(due !== undefined ? { due: iso(now + due * 60_000) } : {}) };
	m.entries.push(entry);
	return entry;
}
/** A boss wait a run may restate: open or answered, legacy or card. */
export const restatable = (m: Memory, id: string): Entry | undefined => m.entries.find((e) => e.id === id && e.kind === "wait" && e.for === "boss" && (e.state === "open" || e.state === "answered"));
/**
 * A wait for the boss as a card (docs/specs/2026-11-07-wait-cards.md): `checked` is `checkCard`'s pass, `raiser` the session the net named for its `from` (undefined for `self`). `text` is the card's `do`, so every reader of `text` keeps working.
 * A card that `restates` a wait drops the old one in the same write, and the old one's place is free for it under the cap.
 */
export function addCardWait(m: Memory, now: number, run: string, checked: Extract<ReturnType<typeof checkCard>, { ok: true }>, raiser: Raiser | undefined, parked = false): Entry {
	if (checked.restates) {
		const old = restatable(m, checked.restates);
		if (!old) throw new Refused(`No such wait ${checked.restates} to restate`);
		m.entries.splice(m.entries.indexOf(old), 1);
	}
	if (m.entries.filter((e) => e.kind === "wait" && e.state === "open").length >= MEM.wait) throw new Refused(`${MEM.wait} open waits are kept already: resolve or drop one`);
	const from = typeof checked.from === "object" && "carried" in checked.from ? checked.from.carried : raiser;
	const card: Card = { ...checked.card, ...(from ? { from } : {}) };
	const entry: Entry = { id: idFor(m, "wait"), kind: "wait", text: card.do, by: "run", via: "run", at: iso(now), run, for: "boss", state: "open", card, ...(checked.dueMin !== undefined ? { due: iso(now + checked.dueMin * 60_000) } : {}), ...(parked ? { parked: true as const, ...(from && !from.gone ? { parkedTold: true as const } : {}) } : {}) };
	m.entries.push(entry);
	return entry;
}
const find = (m: Memory, id: unknown, what = "entry"): Entry => {
	const found = typeof id === "string" ? m.entries.find((e) => e.id === id) : undefined;
	if (!found) throw new Refused(`No such ${what} ${String(id)}`);
	return found;
};
export const findWait = (m: Memory, id: unknown): Entry => {
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
/** The boss answered a wait for them (their message to the tower named it): `answered`, and when. It stays for the tower, which reads the boss's message and resolves or restates it; a second answer moves the time. */
export function answerBossWait(m: Memory, id: unknown, now: number): Entry {
	const e = findWait(m, id);
	if (e.for !== "boss") throw new Refused(`${e.id} waits for a session, whose own message answers it`);
	if (e.state !== "open" && e.state !== "answered") throw new Refused(`${e.id} is ${e.state} already`);
	Object.assign(e, { state: "answered", answered: iso(now) });
	return e;
}
export function dropWait(m: Memory, id: unknown): Entry {
	const e = findWait(m, id);
	m.entries.splice(m.entries.indexOf(e), 1);
	return e;
}
/** The boss edits an entry's text; from then on it is the boss's own words. */
export function editEntry(m: Memory, id: unknown, text: unknown): Entry {
	const e = find(m, id);
	if (e.card) throw new Refused(`${e.id} is a card: the tower records it again (restate), or answer it, decline it, or drop it`);
	const line = tidy("The text", text, e.kind === "wait" ? MEM.waitText : MEM.text);
	if (e.kind === "standing") fitsBrief(m, line, e);
	Object.assign(e, { text: line, by: "boss", via: "gui" });
	delete e.run;
	return e;
}
export function removeEntry(m: Memory, id: unknown): Entry {
	const e = find(m, id);
	m.entries.splice(m.entries.indexOf(e), 1);
	return e;
}
// --- proposals: all a run can do to the live memory --------------------------------------------------------------------------------------------------------------------------------------

/** Where a proposal came from: the run, and the boss message of that run it cites, if any (its text is context for the boss). */
export interface Origin { run: string; event?: string; cites?: string }
const same = (a: Proposal, b: Pick<Proposal, "op" | "kind" | "text" | "target">) => a.op === b.op && a.kind === b.kind && a.text === b.text && a.target === b.target;
/** The proposal, new or already there: the same proposal twice is one, and a full list refuses a new one (it never drops one of those waiting for the boss). */
function pushProposal(m: Memory, now: number, from: Origin, p: Pick<Proposal, "op" | "kind" | "text" | "target">): Proposal {
	const old = m.proposals.find((x) => same(x, p));
	if (old) return old;
	if (m.proposals.length >= MEM.proposals) throw new Refused(`${MEM.proposals} proposals wait for the boss already: ask the boss to confirm or reject some (the GUI, or /boss memory)`);
	const proposal: Proposal = { id: `P${m.next.P++}`, ...p, run: from.run, ...(from.event ? { event: from.event } : {}), ...(from.cites ? { cites: cut(from.cites, MEM.cites) } : {}), at: iso(now) };
	m.proposals.push(proposal);
	return proposal;
}
/** A run asks the boss to keep a standing instruction or a decision; nothing live changes. */
export function proposeAdd(m: Memory, now: number, from: Origin, kind: "standing" | "decision", text: unknown): Proposal {
	const line = tidy(kind === "standing" ? "A standing instruction" : "A decision", text, MEM.text);
	const kept = m.entries.find((e) => e.kind === kind && e.text === line);
	if (kept) throw new Refused(`That is already kept as ${kept.id}`);
	return pushProposal(m, now, from, { op: "add", kind, text: line });
}
/** A run asks the boss to retire a standing instruction or a decision; the proposal holds the entry as it is now. */
export function proposeRetire(m: Memory, now: number, from: Origin, id: unknown): Proposal {
	const e = find(m, id);
	if (e.kind === "wait") throw new Refused("retire removes a standing instruction or a decision; resolve or drop a wait");
	return pushProposal(m, now, from, { op: "retire", kind: e.kind, text: e.text, target: e.id });
}
const findProposal = (m: Memory, id: unknown): Proposal => {
	const found = typeof id === "string" ? m.proposals.find((p) => p.id === id) : undefined;
	if (!found) throw new Refused(`No such proposal ${String(id)}`);
	return found;
};
/** The boss confirms a proposal: an add becomes the boss's entry (under the caps, which refuse it when full), a retire removes the entry (refused when it is gone or the boss changed it since). The proposal goes. */
export function confirmProposal(m: Memory, now: number, id: unknown): Entry {
	const p = findProposal(m, id);
	let entry: Entry;
	if (p.op === "add") entry = addText(m, now, "proposal", p.kind, p.text);
	else {
		const e = find(m, p.target);
		if (e.text !== p.text) throw new Refused(`${e.id} changed after the tower proposed this: reject the proposal`);
		entry = removeEntry(m, e.id);
	}
	m.proposals = m.proposals.filter((x) => x !== p);
	return entry;
}
/** The boss turns a proposal down. */
export function rejectProposal(m: Memory, id: unknown): Proposal {
	const p = findProposal(m, id);
	m.proposals = m.proposals.filter((x) => x !== p);
	return p;
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

// --- what the brief and the GUI see ---------------------------------------------------------------------------------------------------------------------------------

// A standing instruction or a decision is shown whole (300 characters at most); a wait's line adds its words around its 200. A text is cleaned again as it is read, whatever the file holds: no control or format character and no line break reaches a brief.
const row = (id: string, text: string, cap: number = MEM.text) => `- [${id}] ${cut(clean(text, 1_000_000), cap)}`;
/** A card wait's row: its type and raiser, what the boss is asked to do, or after a press what they did and what to check. */
function cardRow(e: Entry, card: Card, now: number, due: string, open: string): string {
	const who = `for boss (${card.type}, ${card.from ? `from ${card.from.name}` : "self"})`;
	const p = e.press;
	if (e.state === "answered" && p) {
		const at = hhmm(p.at);
		const said = p.act === "choose" && p.option !== undefined && card.options?.[p.option]
			? `chose "${card.options[p.option]!.label}" at ${at}: ${card.options[p.option]!.then}`
			: p.act === "restate" ? `asked you to record it again as a card at ${at}`
			: p.act === "secret" || p.secretAsked ? `ready to enter ${card.secret?.name ?? "the secret"} at ${hhmm(p.secretAsked ?? p.at)}; ${card.from?.name ?? "the raiser"} was told to call secret_drop`
			: `pressed ${DONE_LABEL[card.lang]} at ${at}${card.after ? `; check: ${card.after}` : ""}`;
		return row(e.id, `${who}: ${said}${due}${open}`, CARD_ROW);
	}
	if (e.state === "answered") return row(e.id, `${who}: answered by the boss at ${hhmm(e.answered ?? e.at)}, check their message: ${card.do}${due}${open}`, CARD_ROW);
	if (e.state === "open" && p?.act === "secret") return row(e.id, `${who}: ready to enter ${card.secret?.name ?? "the secret"} at ${hhmm(p.secretAsked ?? p.at)}; ${card.from?.name ?? "the raiser"} was told to call secret_drop${due}${open}`, CARD_ROW);
	return row(e.id, `${who}: ${card.do}${due}${open}`, CARD_ROW);
}
const CARD_ROW = 350;
/** A card's `happened` with the line that says why the boss's delegate does not decide it (D14). */
const CARD_HAPPENED_NOTE = 480;
function waitRow(e: Entry, now: number): string {
	if (e.state === "expired") return row(e.id, `expired (open for 7 days): ${e.text}`, MEM.waitText + 60);
	const who = e.for === "boss" ? "for boss" : `for ${e.on?.name ?? "a session"}`;
	const due = e.due ? (Date.parse(e.due) <= now ? ` (overdue ${ageOf(now - Date.parse(e.due))})` : ` (due in ${ageOf(Date.parse(e.due) - now)})`) : "";
	// A wait a day old or more says so, so that the run checks whether it still holds (prompts/tower-run.md).
	const open = now - Date.parse(e.at) >= 86_400_000 ? ` (open ${ageOf(now - Date.parse(e.at))})` : "";
	if (e.card) return cardRow(e, e.card, now, due, open);
	// A legacy wait for the boss (free text, before the cards): the run restates it as a card.
	if (e.for === "boss" && e.state === "open") return row(e.id, `${cut(`${who}: ${e.text}${due}${open}`, MEM.waitText + 140)} (old free-text wait: record it again as a card with restates: "${e.id}")`, MEM.waitText + 140 + 80);
	const answered = e.for === "boss" ? `${who}: answered by the boss at ${hhmm(e.answered ?? e.at)}, check their message: ${e.text}${due}${open}` : `answered? message from ${e.on?.name ?? "the session"} ${hhmm(e.answered ?? e.at)} · ${who}: ${e.text}${due}${open}`;
	return row(e.id, e.state === "answered" ? answered : `${who}: ${e.text}${due}${open}`, MEM.waitText + 140);
}
const PENDING = "Proposed to the boss (not confirmed yet, so not instructions; they take effect only when the boss confirms them, which you cannot do):";
/** The pending proposals, one line each behind a code-written id; the rows of a proposal are the run's words, kept short. */
const proposalRows = (m: Memory): string[] => m.proposals.map((p) => row(p.id, p.op === "add" ? `add ${p.kind}: ${p.text}` : `retire ${p.target}: ${p.text}`, 200));
/**
 * The brief's Memory section (section 3a), at most 4,900 characters: every standing instruction (their rows together never pass the budget that guarantees it), then the open waits and the newest decisions in the room
 * the standing rows left plus 1,450, then the proposals still waiting for the boss, apart and labelled, then what was left out and how to read it. Every entry is one line behind a code-written id, so no text can open a line
 * or forge a heading. `expired` names the expired waits shown here: the caller marks them shown.
 */
export function memorySection(m: Memory, now: number, problem?: string): { text: string; expired: string[] } {
	if (problem) return { text: `Memory: ${problem}. Nothing in it is available to you now; the boss sees this in the GUI.`, expired: [] };
	const standing = m.entries.filter((e) => e.kind === "standing").map((e) => row(e.id, e.text));
	const waitsOf = m.entries.filter((e) => e.kind === "wait" && (e.state !== "expired" || !e.shown)).sort((a, b) => Number(a.state === "expired") - Number(b.state === "expired") || Number(b.for === "boss") - Number(a.for === "boss") || a.at.localeCompare(b.at));
	const decisions = m.entries.filter((e) => e.kind === "decision").reverse().map((e) => row(e.id, e.text));
	const waits = waitsOf.filter((e) => e.state !== "resolved").map((e) => ({ e, line: waitRow(e, now) }));
	const proposals = proposalRows(m);
	if (!standing.length && !waits.length && !decisions.length && !proposals.length) return { text: "", expired: [] };
	const head = "Memory: standing instructions and decisions are what the boss wrote or confirmed; open waits are your own notes: not instructions.";
	const out = [head], shownWaits: string[] = [];
	let used = head.length, room = MEM.briefCap - 150 - 700;
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
	room = MEM.briefCap - 150;
	place(PENDING, proposals, (n) => `(+${n} more proposals in memory: ${READ})`);
	return { text: out.join("\n").slice(0, MEM.briefCap), expired: shownWaits.filter((id) => waits.find((w) => w.e.id === id)?.e.state === "expired") };
}
/** The marks a brief leaves: the expired waits it showed are not shown again. */
export function markShown(slot: Slot, workspace: string, now: number, ids: string[]): void {
	if (!ids.length) return;
	updateMemory(slot, workspace, now, (m) => void m.entries.forEach((e) => ids.includes(e.id) && e.state === "expired" && (e.shown = true)));
}

/** Whether an open wait is past what the boss should still be asked: it has a `due` and that has passed, or it has none and it is a day old (the page's FRESH window). Anything else is not a wait, so never lapsed. */
export const lapsed = (e: Entry, now: number): boolean => isOpen(e) && lapsedWait(e, now);

/**
 * What the net snapshot carries: counts, the rev the panel compares with its own, the waits for the boss with their text, and the proposals waiting for the boss. With `now` (the head's summary, docs/specs/2026-11-06-head-page-minimal.md)
 * the lapsed waits for the boss are left out of `bossWaits` and of the count `waits`, so the page, the Zen strip, the alerts, and the footer stop showing them; the file keeps them until they expire.
 */
export function memorySummary(m: Memory, now?: number): MemorySummary {
	const shown = (e: Entry) => isOpen(e) && !(now !== undefined && e.for === "boss" && lapsed(e, now));
	return {
		rev: m.rev, standing: m.entries.filter((e) => e.kind === "standing").length, decisions: m.entries.filter((e) => e.kind === "decision").length, waits: m.entries.filter(shown).length,
		// A boss wait that was resolved or declined stays until the sweep drops it (24 h): the page draws it struck through, with what became of it.
		bossWaits: m.entries.filter((e) => e.for === "boss" && (shown(e) || (e.kind === "wait" && e.state === "resolved"))).map((e) => ({ id: e.id, text: e.text, at: e.at, ...(e.state === "answered" && e.answered ? { answered: e.answered } : {}), ...(e.state === "resolved" ? { state: "resolved" as const, ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.ended ? { ended: e.ended } : {}) } : {}), ...(e.card ? { card: e.card } : {}), ...(e.press ? { press: e.press } : {}), ...(e.parked ? { parked: true as const } : {}), ...(e.listed ? { listed: true as const } : {}), ...(e.returned ? { returned: e.returned } : {}) })), proposals: m.proposals.map(proposalView),
	};
}
/** The memory as the panel reads it, swept as of `now`. */
export function readMemory(slot: Slot, workspace: string, now: number): { memory: Memory; problem?: string } {
	const found = loadMemory(slot, workspace);
	sweep(found.memory, now);
	return found;
}
const proposalView = ({ id, op, kind, text, target, cites }: Proposal) => ({ id, op, kind, text, ...(target ? { target } : {}), ...(cites ? { cites } : {}) });
export const memoryView = (m: Memory) => ({
	rev: m.rev, proposals: m.proposals.map((p) => ({ ...proposalView(p), at: p.at })),
	entries: m.entries.map((e) => ({ id: e.id, kind: e.kind, text: e.text, by: e.by, via: e.via, at: e.at, ...(e.for ? { for: e.for } : {}), ...(e.on ? { on: e.on.name } : {}), ...(e.state ? { state: e.state } : {}), ...(e.due ? { due: e.due } : {}), ...(e.answered ? { answered: e.answered } : {}), ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.ended ? { ended: e.ended } : {}), ...(e.card ? { card: e.card } : {}), ...(e.press ? { press: e.press } : {}), ...(e.parked ? { parked: true as const } : {}), ...(e.listed ? { listed: true as const } : {}), ...(e.returned ? { returned: e.returned } : {}) })),
});

/**
 * The boss's request on the memory: the GUI panel's (`POST tower/<workspace>/memory`) and `/boss memory`'s (the control socket's `tower-memory`) are this one function. Read; and as the boss add (standing or decision),
 * edit, delete, resolve a wait, drop one (the boss dismisses a wait for them from the page), answer one (their message to the tower named it: `answered`, still open for the tower), confirm a proposal, and reject one (a proposal and a wait are named by an id that is never reused, so a reject, a drop, and an answer need no rev). Each other write names the rev it read; a file that has moved on is
 * 409 `rev` with the current memory to redraw from. A cap that is full, an entry or proposal that is not there, or a proposal that no longer applies is 409 `refused`; a request that is wrong is 400. A run reaches none of it.
 */
export function memoryRequest(slot: Slot, workspace: string, now: number, json: Record<string, unknown>, log?: Log): { status: number; body: Record<string, unknown> } {
	const op = json.op, no = (status: number, error: string, reason: string, extra: Record<string, unknown> = {}) => ({ status, body: { error, reason, ...extra } });
	if (op === "read") {
		const { memory, problem } = readMemory(slot, workspace, now);
		return problem ? no(409, "unreadable", problem) : { status: 200, body: memoryView(memory) };
	}
	const change: Record<string, (m: Memory) => { id: string } | void> = {
		add: (m) => {
			if (json.kind !== "standing" && json.kind !== "decision") throw new Error("The boss adds a standing instruction or a decision (kind)");
			return addText(m, now, "gui", json.kind, json.text);
		},
		edit: (m) => editEntry(m, json.id, json.text),
		delete: (m) => removeEntry(m, json.id),
		resolve: (m) => resolveWait(m, json.id, json.outcome, now),
		drop: (m) => dropWait(m, json.id),
		answer: (m) => answerBossWait(m, json.id, now),
		confirm: (m) => confirmProposal(m, now, json.proposal),
		reject: (m) => rejectProposal(m, json.proposal),
	};
	if (typeof op !== "string" || !Object.hasOwn(change, op)) return no(400, "bad_request", "op is read, add, edit, delete, resolve, drop, answer, confirm, or reject");
	// A reject, a drop, and an answer name an id that is never reused, so they need no rev.
	const byId = op === "reject" || op === "drop" || op === "answer";
	if (!byId && (typeof json.rev !== "number" || !Number.isInteger(json.rev))) return no(400, "bad_request", "A change names the rev it read");
	try {
		const done = updateMemory(slot, workspace, now, change[op]!, byId ? undefined : (json.rev as number));
		log?.line("tower-memory", { workspace, op, by: "boss", ...(done.value ? { id: done.value.id } : {}), ...(op === "confirm" ? { proposal: String(json.proposal) } : {}) });
		return { status: 200, body: { ...memoryView(done.memory), ...(done.value ? { id: done.value.id } : {}) } };
	} catch (cause) {
		const error = cause as Error & { code?: string; memory?: Memory };
		if (error.code === "rev") return no(409, "rev", "The memory changed since you read it; it is shown again.", memoryView(error.memory!));
		return error instanceof Refused ? no(409, "refused", error.message) : no(/memory\.json/.test(error.message) ? 409 : 400, /memory\.json/.test(error.message) ? "unreadable" : "bad_request", error.message);
	}
}

// --- the tool of a run -------------------------------------------------------------------------------------------------------------------------------------------------------

export interface ToolEnv {
	slot: Slot;
	workspace: string;
	run: string;
	now(): number;
	/** The boss messages this run took, oldest first: a proposal may cite one, as context for the boss. */
	bossEvents(): { id: string; text: string }[];
	/** The live session named by an id or a name; rejects when there is none or several. */
	session(query: string): Promise<{ id: string; name: string }>;
	/** The intercom events this run took, oldest first: the senders a boss wait's `from` may name (the broker's id, as the event's marker shows it). */
	intercomEvents(): { id: string; from: { id: string; name?: string } }[];
	/** The session with this id in the net now (never by name: a subagent shows on intercom under another name, todo #49), with its name, role, workspace, and tab; undefined when it is not live. */
	raiser(id: string): Promise<Raiser | undefined>;
	/** sb's language (src/locale.ts `localeOf`: the `locale` setting, else the server's environment): the language the brief told the run to write a card in, kept on the card. */
	locale(): Locale;
	/** Auto mode (§6): whether it is on (a wait recorded then is parked), and the message to the raiser of a card parked (sent once: the entry was written with `parkedTold`). */
	auto?: { on(): boolean; told(entry: Entry): Promise<void> };
	log: Log;
	/**
	 * The boss's delegate (docs/specs/2026-11-21-box-mac-waits.md §15, D14): a card for the boss goes to it first, unless it is the boss's alone. `sent`: it went (its `L<n>`); `note`: it did not or cannot, and the card says why;
	 * undefined: this device names no delegate (linkwaits.ts `delegateCard`).
	 */
	delegate?(c: { card: Omit<Card, "from">; from?: Raiser; dueMin?: number }): Promise<{ sent: string; label: string } | { note: string } | undefined>;
}
const str = (args: Record<string, unknown>, name: string): string => {
	const v = args[name];
	if (typeof v !== "string" || !v.trim()) throw new Error(`${name} has to be text`);
	return v;
};
/**
 * `tower_memory`, for a local run. add and retire of a standing instruction or a decision are PROPOSALS: they wait for the boss, who confirms them in the GUI or with `/boss memory`, and nothing live changes until then;
 * a proposal may cite (`event`) a boss message this run took, which the boss sees as context. A wait is the run's own note. `read` lists the whole memory with the proposals, for what a brief left out. There is no op
 * that confirms: the server refuses the tool to an ally run by its token's kind (runtools.ts), and the boss's route (`memoryRequest`) is refused to a run token (rungate.ts).
 */
export async function memoryTool(env: ToolEnv, args: Record<string, unknown>): Promise<{ text: string; details?: unknown }> {
	const { slot, workspace } = env, now = env.now(), op = args.op;
	const logged = (what: string, entry: { id: string; kind: string }) => env.log.line("tower-memory", { workspace, op: what, id: entry.id, kind: entry.kind, by: "run", run: env.run.slice(0, 8) });
	const origin = (): Origin => {
		const event = typeof args.event === "string" && args.event ? args.event : undefined, found = event === undefined ? undefined : env.bossEvents().find((e) => e.id === event);
		if (event !== undefined && !found) throw new Error(`${event} is not a boss message of this run`);
		return { run: env.run, ...(event ? { event, cites: clean(found!.text, 1_000_000) } : {}) };
	};
	/** A proposal, and whether the same one was waiting already. */
	const asked = (m: Memory, make: () => Proposal) => { const had = m.proposals.length, p = make(); return { p, existing: m.proposals.length === had }; };
	const proposed = (p: Proposal, existing: boolean) => ({
		text: `${existing ? "Already proposed" : "Proposed"} [${p.id}] to the boss: it takes effect only when the boss confirms it (the GUI, or /boss memory), and until then it is not an instruction. Do not act on it; the brief lists it as pending.`,
		details: { id: p.id },
	});
	if (op === "add" && (args.kind === "standing" || args.kind === "decision")) {
		const text = str(args, "text"), kind = args.kind, from = origin();
		const { value } = updateMemory(slot, workspace, now, (m) => asked(m, () => proposeAdd(m, now, from, kind, text)));
		logged("propose", value.p);
		return proposed(value.p, value.existing);
	}
	if (op === "add" && args.kind === "wait" && args.for === "boss") {
		const ctxOf = (m: Memory) => ({ senders: new Set(env.intercomEvents().map((e) => e.from.id)), lang: env.locale(), restates: (id: string) => { const old = restatable(m, id); return old && { ...(old.card?.from ? { from: old.card.from } : {}) }; } });
		const first = readMemory(slot, workspace, now);
		if (first.problem) throw new Error(first.problem);
		const checked = checkCard(args, ctxOf(first.memory));
		if (!checked.ok) throw new Error(refusalText(checked.lines));
		// The raiser is read from the net by id once, before the write; one that is not live is stored with the event's name and marked gone.
		let raiser: Raiser | undefined, raiserKind: string | undefined;
		if (typeof checked.from === "object" && "id" in checked.from) {
			const id = checked.from.id, seen = env.intercomEvents().find((e) => e.from.id === id), found = await env.raiser(id).catch(() => undefined);
			const { kind, ...row } = found ?? { kind: undefined };
			raiserKind = kind;
			raiser = found ? { ...(row as Raiser), name: clean(found.name, 40) || id, ...(found.workspace ? { workspace: clean(found.workspace, 40) } : {}), ...(found.tab ? { tab: clean(found.tab, 40) } : {}) } : { id, name: clean(seen?.from.name ?? id, 40) || id, role: "session", gone: true };
		}
		// D14: a card goes to the boss's delegate first unless it is the boss's alone: a secret (only the boss enters one), one the run marks bossOnly (a strict train target's auth, a credential, a join), one a train or an
		// integrator raised (their cards are a strict target's approvals), and a restatement of a card already on the boss's list.
		const bossOnly = checked.card.type === "secret" || !!checked.restates || args.bossOnly === true || (raiserKind !== undefined && BOSS_ONLY_KINDS.has(raiserKind));
		let note: string | undefined;
		if (env.delegate && !bossOnly) {
			const tried = await env.delegate({ card: checked.card, ...(raiser ? { from: raiser } : {}), ...(checked.dueMin !== undefined ? { dueMin: checked.dueMin } : {}) });
			if (tried && "sent" in tried) {
				env.log.line("tower-memory", { workspace, op: "delegate", id: tried.sent, kind: "wait", by: "run", run: env.run.slice(0, 8) });
				return { text: `Sent to the boss's delegate on ${tried.label} as ${tried.sent}, not to the boss's list: the delegate may approve it on the boss's behalf. Its answer comes to you as a server notice marked as the delegate's words, not the boss's; if it escalates, declines, or cannot take it, sb puts this card on the boss's list and tells you. Keep ${tried.sent} in your handoff note.`, details: { delegated: tried.sent } };
			}
			note = tried?.note;
		}
		const { value } = updateMemory(slot, workspace, now, (m) => {
			const again = checkCard(args, ctxOf(m));
			if (!again.ok) throw new Error(refusalText(again.lines));
			return addCardWait(m, now, env.run, note ? { ...again, card: { ...again.card, happened: cut(`${again.card.happened} ${note}`, CARD_HAPPENED_NOTE) } } : again, raiser, env.auto?.on() === true);
		});
		logged("add", value);
		if (value.parked && value.parkedTold) await env.auto!.told(value).catch((cause: Error) => env.log.line("error", { code: "wait-parked", text: cause.message.slice(0, 200) }));
		return { text: `Noted [${value.id}]: the boss sees it as a card (${value.card!.type}) and it shows in your brief until you resolve or drop it${checked.restates ? `; ${checked.restates} was replaced` : ""}.`, details: { id: value.id } };
	}
	if (op === "add" && args.kind === "wait") {
		const on = args.on === undefined ? undefined : await env.session(str(args, "on"));
		const parked = env.auto?.on() === true;
		const { value } = updateMemory(slot, workspace, now, (m) => { const e = addWait(m, now, env.run, { text: args.text, for: args.for, ...(on ? { on } : {}), dueMin: args.due }); if (parked && e.for === "boss") e.parked = true; return e; });
		logged("add", value);
		return { text: `Noted [${value.id}]: it shows in your brief until you resolve or drop it${value.for === "boss" ? " and tells the boss it waits for them" : ""}.`, details: { id: value.id } };
	}
	if (op === "add") throw new Error("kind is standing, decision, or wait");
	if (op === "retire") {
		const from = origin();
		const { value } = updateMemory(slot, workspace, now, (m) => asked(m, () => proposeRetire(m, now, from, str(args, "id"))));
		logged("propose", value.p);
		return proposed(value.p, value.existing);
	}
	if (op === "read") {
		const { memory, problem } = readMemory(slot, workspace, now);
		if (problem) throw new Error(problem);
		const part = (title: string, rows: string[]) => (rows.length ? [title, ...rows] : []);
		const text = [
			...part("Standing instructions:", memory.entries.filter((e) => e.kind === "standing").map((e) => row(e.id, e.text))),
			...part("Waits:", memory.entries.filter((e) => e.kind === "wait" && e.state !== "resolved").map((e) => waitRow(e, now))),
			...part("Decisions (newest first):", memory.entries.filter((e) => e.kind === "decision").reverse().map((e) => row(e.id, e.text))),
			...part(PENDING, proposalRows(memory)),
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
