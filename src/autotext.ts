import { clock } from "./autostate.ts";

// What an agent is told under auto mode (docs/specs/2026-11-09-auto-mode.md, §4): written by code, in English, and shaped by the kind of session. The model never writes any of it.

export type AgentKind = "main" | "subagent" | "train" | "run";
const KIND: Record<AgentKind, string> = {
	main: "Decide yourself only where the boss's words in your brief or this session cover it, quoting them; else park it: call_tower why: blocked with the decision and what you need, then go on with work that does not need it, or stop this line and say so on your board.",
	subagent: "Decide within your brief; else caller_ping your dispatcher with the decision and stop.",
	train: "call_tower blocked with reply: false naming what needs the boss, then end.",
	run: "Record a wait for the boss with tower_memory; it is parked.",
};
/** The tail of a refusal or a cancel: it opens with "Do not ask again or wait." and ends with who ends auto mode. */
export const tailOf = (kind: AgentKind, tool: string): string => ["Do not ask again or wait.", KIND[kind], tool === "secret_drop" ? "Name the secret, never its value." : "", "Only the boss or the head tower ends auto mode."].filter(Boolean).join(" ");
export const refusedText = (since: string | undefined, tool: string, kind: AgentKind) => `sb: auto mode is on (since ${clock(since)}; the boss is away): ${tool} waits for the boss and is refused. ${tailOf(kind, tool)}`;
export const cancelledText = (since: string | undefined, tool: string, kind: AgentKind) => `sb: auto mode started at ${clock(since)}: this ${tool} was cancelled by sb, not by the boss, who is away. ${tailOf(kind, tool)}`;
/** The transition notice, once per confirmed rev (a steer while a turn runs, `nextTurn` while idle). */
export const onNotice = (since: string | undefined) => `sb: auto mode is on since ${clock(since)}: the boss is away until they end it. Nothing that waits for them runs; decide only where the boss's words cover it, or park it; never wait for the boss.`;
export const offNotice = (at: string | undefined, kind: AgentKind) => `sb: auto mode ended at ${clock(at)}: the boss is back. Parked waits go to them in one list, and their answers reach you as wait_card messages. Never re-ask a parked wait with ask_user_question.${kind === "main" || kind === "run" ? " When the boss is with you and the answer cannot wait, call boss_wait_ask (its id, or none for every card you raised): sb shows the card and his answer resolves it everywhere." : ""}`; // a parked wait is asked again only through the card sb draws (waitask.ts); a session with no such tool (a subagent, a train) is told only not to re-ask
export const CALL_TOWER_LINE = "Auto mode: no answer from the boss before it ends. Do not wait on this call: the tower parks it; go on with work that does not need it, or stop this line and say so on your board.";
export const SHOW_DOC_LINE = "Auto mode: the boss sees this when they are back; do not wait for its form.";
/** A Straw Link gate's denial and the trust question's answer under auto mode (D3, AM-F011): neutral, since a teammate is not told of auto mode (D5). */
export const NO_CONFIRM = "no one can confirm this here now";
/** The once-per-session hint on the boss's first typed input (D2). */
export const typedHint = (since: string | undefined) => `Auto mode is on since ${clock(since)}: agents cannot ask you. /boss auto off ends it.`;
