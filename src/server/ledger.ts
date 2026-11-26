import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// The event ledger (docs/specs/2026-11-26-event-ledger.md): `<state folder>/ledger/<YYYY-MM-DD>.jsonl` (the UTC day of the event), one JSON line per event, appended and never pruned by sb, so a reader such as pi-evals can
// say later where a work item waited and on whom after the wait cards, the tower's queue, and the boards have dropped or overwritten their own records. The process that owns the event writes it: the sb server for the waits,
// the link waits, and the review threads; a session's extension for call_tower, boss_wrap, and boss_handover. A line holds ids, kinds, and times only: no message, question, card, note, or summary text ever (an id that is not
// id-shaped is written as null). A write that fails never fails the act it records: it is told once per state folder and process, and the act goes on.

export const KINDS = ["wait_raised", "wait_answered", "wait_returned", "wait_parked", "link_wait_open", "link_wait_done", "thread_open", "thread_close", "call_tower", "wrap", "handover"] as const;
export type LedgerKind = (typeof KINDS)[number];
/** Where a boss wait's answer came in: a terminal (pi's `/boss wait` or `/boss memory`, the tower prompt, a run's pane, the dialog of `boss_wait_ask`), this computer's page, a paired phone, or a message the tower took that names it. */
export type AnsweredBy = "terminal" | "gui" | "phone" | "tower";
/** The `why` each kind may carry; the others carry none. */
const WHYS: Partial<Record<LedgerKind, readonly string[]>> = { thread_close: ["done", "blocked", "abandoned"], call_tower: ["milestone", "shared", "blocked"], wrap: ["wrapped", "refused", "auto"] };
const BYS: readonly string[] = ["terminal", "gui", "phone", "tower"];
export interface LedgerEvent { kind: LedgerKind; id: string; session?: string | null; workspace?: string | null; why?: string; item?: string; by?: AnsweredBy }
export interface LedgerRow { v: 1; at: number; kind: LedgerKind; id: string; session: string | null; workspace: string | null; why?: string; item?: string; by?: AnsweredBy }

/** An id as the ledger keeps it: letters, digits, and `_.:#@+=|-`, at most 160 characters (the pi-evals attribute rule); anything else is no id. */
const ID = /^[A-Za-z0-9_.:#@+=|-]{1,160}$/;
export const ledgerId = (v: unknown): string | null => (typeof v === "string" && ID.test(v) ? v : null);
/** A work item `boss_pair` may name: a todo uid (`t_` and 10 base32 characters) or `<session8>#<id>`. */
export const ITEM = /^(?:t_[A-Za-z2-7]{10}|[A-Za-z0-9_-]{1,64}#[1-9][0-9]{0,5})$/;
export const ledgerFile = (stateDir: string, at: number) => join(stateDir, "ledger", `${new Date(at).toISOString().slice(0, 10)}.jsonl`);

/** The row of an event, or undefined when its id is not id-shaped; a `why` or `by` outside its kind's set and an item that is not an item are left out. */
export function ledgerRow(e: LedgerEvent, at: number): LedgerRow | undefined {
	const id = ledgerId(e.id);
	if (!id || !KINDS.includes(e.kind)) return undefined;
	const why = e.why !== undefined && WHYS[e.kind]?.includes(e.why) ? e.why : undefined, item = typeof e.item === "string" && ITEM.test(e.item) ? e.item : undefined;
	const by = e.kind === "wait_answered" && e.by !== undefined && BYS.includes(e.by) ? e.by : undefined;
	return { v: 1, at, kind: e.kind, id, session: ledgerId(e.session), workspace: ledgerId(e.workspace), ...(why ? { why } : {}), ...(item ? { item } : {}), ...(by ? { by } : {}) };
}

const warned = new Set<string>();
/** The warning of a process that passes none (the sb server sets its log here when it starts). */
export const ledgerSink: { warn?(text: string): void } = {};
/** Appends one event to the day's file: one append, and the folder made only when the first append finds it missing. Never throws. */
export function noteLedger(stateDir: string | undefined, e: LedgerEvent, at: number = Date.now(), warn: ((text: string) => void) | undefined = ledgerSink.warn): void {
	if (!stateDir) return;
	const row = ledgerRow(e, at);
	if (!row) return;
	const file = ledgerFile(stateDir, at), line = `${JSON.stringify(row)}\n`;
	try {
		try { appendFileSync(file, line, { mode: 0o600 }); } catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			appendFileSync(file, line, { mode: 0o600 });
		}
	} catch (error) {
		if (warned.has(stateDir) || !warn) return;
		warned.add(stateDir);
		try { warn(`Straw Boss: the event ledger (${dirname(file)}) cannot be written (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); what it records goes on unrecorded.`); } catch { /* the warning's own sink failed */ }
	}
}
