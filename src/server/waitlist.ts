import { clean } from "../board.ts";
import { HEAD_KEY } from "../headkey.ts";
import { tidy, type View, type ViewCard } from "../memorycmd.ts";
import type { Locale } from "../towerprompt/messages.ts";
import type { Slot } from "./record.ts";
import { lapsed, MEM, memoryView, readMemory } from "./towermemory.ts";

// The waits that wait for the boss, as one read (docs/specs/2026-11-10-wait-cards-tui.md, §1): the control command `boss-waits` lists every tower's and the head's open cards for `/boss wait` and the tower prompt's picker, and the polls of
// a standing prompt and of a local or head run carry a short digest of the pane's own tower. Read only. A run token never gets here (the commands are in no list of rungate.ts); the text of a card is cleaned again at this reader
// (`tidy`, as `/boss memory` cleans what it prints), since the model that wrote it may have put an escape or a line break there, and cards are never cut (this is one request, not the snapshot).

/** One wait for the boss that is open or answered. */
export interface WaitRow {
	id: string;
	text: string;
	at: string;
	state: "open" | "answered";
	answered?: string;
	/** The card, cleaned; absent for a legacy free-text wait. */
	card?: ViewCard;
	press?: { act: string; option?: number; reason?: string; at?: string; secretAsked?: string };
	/** Recorded while auto mode was on. */
	parked?: true;
}
export interface TowerWaits {
	/** The workspace id; `HEAD_KEY` for the head, which is the key `tower-memory` takes for it. */
	workspace: string;
	label: string;
	head?: true;
	/** The pane that asked is this tower's own (a session of its workspace, or of the head's); such a tower is listed first. */
	own?: true;
	waits: WaitRow[];
	/** The memory file cannot be read: nothing is listed for this tower. */
	problem?: string;
}
export interface WaitList { auto: { on: boolean; since?: string }; towers: TowerWaits[] }
/** What a poll carries of the pane's own tower: the lines of the block, and whether auto mode is on. */
export interface DigestRow { id: string; type: string; do: string; from?: string; parked?: true; pressed?: string }
export interface WaitDigest { waits: DigestRow[]; auto: boolean }

/** The most a digest line says of what the boss does, and how many cards it carries (the memory's own cap on open waits). */
export const DIGEST_DO = 120;
const cut = (text: string, max: number) => (Array.from(text).length > max ? `${Array.from(text).slice(0, max - 1).join("").trimEnd()}…` : text);

/** What a tower's service is, for the list: the key its memory is read under, and the label shown. */
export interface Target { workspace: string; label: string; head?: true; /** The head's own Herdr workspace id (its service's), which names it for a pane that stands there. */ at?: string }
export interface ListDeps {
	slot: Slot;
	now(): number;
	locale: Locale;
	/** Auto mode's view (autostate.ts): whether it is on, and since when. */
	auto?(): { on: boolean; since?: string };
}

/** The boss's open and answered waits of one memory, newest first, cleaned. A wait the head's page hides as lapsed is left out of the head's list (memorySummary), so the pane never offers what the page does not. */
export function waitRows(slot: Slot, key: string, now: number, head: boolean): { rows: WaitRow[]; problem?: string } {
	const { memory, problem } = readMemory(slot, key, now);
	if (problem) return { rows: [], problem };
	const kept = { ...memory, entries: memory.entries.filter((e) => e.kind === "wait" && e.for === "boss" && (e.state === "open" || e.state === "answered") && !(head && lapsed(e, now))) };
	// SAFETY: the view's entries are what `View` repeats (memorycmd.ts), with `state` and `at` the types of this reader.
	const view = tidy(memoryView(kept) as unknown as View);
	return {
		rows: view.entries.reverse().map((e): WaitRow => ({
			id: e.id, text: e.text, at: clean(e.at, 40), state: e.state === "answered" ? "answered" : "open",
			...(e.answered ? { answered: clean(e.answered, 40) } : {}), ...(e.card ? { card: e.card } : {}),
			...(e.press ? { press: { act: clean(e.press.act, 20), ...(Number.isInteger(e.press.option) ? { option: e.press.option! } : {}), ...(e.press.reason ? { reason: clean(e.press.reason, 1000) } : {}), ...(e.press.at ? { at: clean(e.press.at, 40) } : {}), ...(e.press.secretAsked ? { secretAsked: clean(e.press.secretAsked, 40) } : {}) } } : {}),
			...(e.parked ? { parked: true as const } : {}),
		}))
	};
}

/** The head's label in the server's own words (a pane has no theme). */
export const headLabel = (locale: Locale) => (locale === "zh-TW" ? "主塔台" : "head tower");

/**
 * The list: the head first (when it stands, or has waits of its own), then each tower, each once, newest wait first; the tower of `own` (a workspace id) comes ahead of them, so a pane sees its own first. `only` names one: a workspace id, or `head`.
 * A target nobody serves is an error with the server's usual words.
 */
export function waitList(d: ListDeps, towers: Target[], head: { at?: string } | undefined, only?: string, own?: string): WaitList {
	const want = only === "head" ? HEAD_KEY : only;
	const targets: Target[] = [...(head ? [{ workspace: HEAD_KEY, label: headLabel(d.locale), head: true as const, ...(head.at ? { at: head.at } : {}) }] : []), ...towers.filter((t) => !t.head)];
	const mine = (t: Target) => own !== undefined && (t.workspace === own || t.at === own);
	const found = (want === undefined ? targets : targets.filter((t) => t.workspace === want)).sort((a, b) => Number(mine(b)) - Number(mine(a)));
	if (want !== undefined && !found.length) throw new Error(`The sb server stands in for no tower of workspace ${want}`);
	const now = d.now(), auto = d.auto?.();
	return {
		auto: { on: auto?.on === true, ...(auto?.since ? { since: auto.since } : {}) },
		towers: found.map((t): TowerWaits => {
			const read = waitRows(d.slot, t.workspace, now, t.head === true);
			return { workspace: t.workspace, label: clean(t.label, 200), ...(t.head ? { head: true as const } : {}), ...(mine(t) ? { own: true as const } : {}), waits: read.rows, ...(read.problem ? { problem: read.problem } : {}) };
		}),
	};
}

/** How many of the rows wait for the boss: open, and not pressed (a secret's first step still waits for its entry). */
export const openCards = (rows: readonly WaitRow[]): number => rows.filter((r) => r.state === "open" && (!r.press || r.press.act === "secret")).length;

/** The lines a poll carries for one tower's rows. */
export function digestOf(rows: WaitRow[], auto: boolean): WaitDigest {
	return {
		auto,
		waits: rows.slice(0, MEM.wait).map((r): DigestRow => ({
			id: r.id, type: r.card?.type ?? "legacy", do: cut(r.card?.do ?? r.text, DIGEST_DO),
			...(r.card?.from?.name ? { from: r.card.from.name } : {}), ...(r.parked ? { parked: true as const } : {}), ...(r.press ? { pressed: r.press.act } : {}),
		})),
	};
}
