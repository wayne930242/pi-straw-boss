// The shapes the Asks of docs/specs/2026-11-28-boss-asks.md show in: the probe's row (a contract: pi-todo-ledger reads it) and the page's view (the net's `asks`, this computer only). Free of Node, so the page imports it.

export type AskKind = "boss" | "dialog" | "wait" | "link";
/** The todo an Ask blocks: the session whose list holds it, its id there, and its uid when the binding knew it (a reader checks it: `clear` lets a new todo take the id). */
export interface AskItem { session: string; id: number; uid?: string }
export const ASK_ROWS_EVENT = "straw-boss:ask-rows:v1";
/** One row of `straw-boss:ask-rows:v1`. */
export interface AskRowV1 { id: string; subject: string; asker: string; where: string; kind: AskKind; since: number; mine: boolean; item?: AskItem }
/** The probe's answer: `session` is the id `item.session` names this session by (an older sb leaves it out). */
export interface AskRowsAnswerV1 { version: 1; session: string; rows: AskRowV1[] }
/**
 * An open Ask as the page draws it: `unit` is the unit on the net whose plate counts it (the asker, or the tower for a wait whose raiser is not on the net), `ws` its workspace, `wait` the W id of a wait card (its
 * alert is the card), `pane` whether the asker has a pane the page can open.
 */
export interface AskView { id: string; n: number; kind: AskKind; subject: string; asker: string; where: string; since: number; ws?: string; unit?: string; wait?: string; pane?: true; item?: AskItem }
