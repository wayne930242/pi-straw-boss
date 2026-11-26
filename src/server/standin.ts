// The stand-in's Herdr state and message (docs/how-it-works.md, The standing pane): what the server reports on a standing pane is decided here, at every look, and nowhere else.
//
// The order the boss set (2026-11-26): `working` while the tower handles something (a run of its workspace is waking, or live and not idle at its last poll: an event run at work, a boss conversation's turn, an ally run on a teammate's message),
// `blocked` only while wait cards wait for him, and `idle` otherwise. A card that waits outranks the run's work, as Herdr's pi integration ranks a dialog above a turn. The stand-in never reports `done`: Herdr 0.9.5
// shows `done` by itself after working → idle or blocked → idle on a pane the boss is not looking at, and `idle` once he focuses it, so `idle` after the handling reads "finished" until he has seen it.
//
// Who reports: the stand-in stands only while the tower prompt is in the pane: between runs, and under headless runs during one too, since the run is the server's child and the prompt (the viewer) stays. While a
// run's pi holds the pane (pane runs), Herdr's pi integration reports that pi (source `herdr:pi`, agent `pi`: working, idle, or blocked on a dialog), Herdr keeps no report of another label over it, and the server
// reports nothing: one source on a pane at a time, so the two never flap.

import type { Locale } from "../locale.ts";
import type { ServiceStatus } from "./runs.ts";
import type { NoReason } from "./typegate.ts";

export type StandinState = "working" | "blocked" | "idle";
/** What the stand-in is reported as: its Herdr state and the short message. */
export interface Standin { state: StandinState; message: string }

/** What a look knows that decides the stand-in's state. */
export interface StandinFacts {
	/** The rule of the typing gate (typegate.ts) that said no at this look. Only `prompt` (the prompt polls, no run) and `run` (a run holds the pane or is about to) can leave the pane to the stand-in. */
	verdict: NoReason;
	/** A run is about to start pi in the pane: the stand-in was released and the prompt told to leave (standing.ts `yieldPane`). */
	leaving: boolean;
	/** The prompt polled lately: it is in the pane. */
	prompt: boolean;
	/** The agent Herdr shows on the pane: none, the stand-in, or another (a run's pi, a pi of the boss's own). */
	agent: "none" | "stand-in" | "other";
	/** A run of the workspace handles something: its local run waking, or live and not idle at its last poll, or an ally run live and not idle (runs.ts `working`). */
	working: boolean;
	/** The wait cards that wait for the boss here (a tower's own; the head's own at the head), parked ones under auto mode included. */
	cards: number;
	/** A person is at this device: an unattended one has nobody to answer a card. */
	attended: boolean;
}

/** The stand-in's state at a look, or undefined when the server reports none: the prompt is not in the pane, a run is taking it, or another agent holds it. */
export function standinState(f: StandinFacts): StandinState | undefined {
	if ((f.verdict !== "prompt" && f.verdict !== "run") || f.leaving || !f.prompt || f.agent === "other") return undefined;
	if (f.cards > 0 && f.attended) return "blocked";
	return f.working ? "working" : "idle";
}

const WORDS = {
	en: { standing: "standing by", working: "working", held: "held", queued: (n: number) => `${n} queued`, cards: (n: number) => (n === 1 ? "1 card waits" : `${n} cards wait`), elsewhere: (n: number) => (n === 1 ? "1 card waits at another tower" : `${n} cards wait at other towers`) },
	"zh-TW": { standing: "待命中", working: "處理中", held: "已擱置", queued: (n: number) => `${n} 則待處理`, cards: (n: number) => `${n} 張卡片等你`, elsewhere: (n: number) => `其他塔台有 ${n} 張卡片等你` },
};
export interface StandinWords { cards?: number; working?: boolean; elsewhere?: number; locale?: Locale }
/**
 * The message, in sb's language: the cards first, then what the tower does (`working`; `standing by` when nothing but the other towers' cards would be said), then at the head the cards of the other towers (a note
 * that never blocks: a tower's wait is not the head's, AR-D2), then `held` or the queue: `2 cards wait · working · 1 queued`, `standing by · 3 cards wait at other towers`, `standing by`.
 */
export function standinMessage(status: Pick<ServiceStatus, "state" | "queued"> | undefined, { cards = 0, working = false, elsewhere = 0, locale = "en" }: StandinWords = {}): string {
	const w = WORDS[locale], tail = status?.state === "held" ? w.held : status && status.queued > 0 ? w.queued(status.queued) : undefined;
	const lead = working ? w.working : cards === 0 && !tail ? w.standing : undefined;
	return [...(cards > 0 ? [w.cards(cards)] : []), ...(lead ? [lead] : []), ...(elsewhere > 0 ? [w.elsewhere(elsewhere)] : []), ...(tail ? [tail] : [])].join(" · ");
}

/** The stand-in at a look: its state (`standinState`) and its message, or undefined when the server reports none. */
export function standinReport(f: StandinFacts & { status: Pick<ServiceStatus, "state" | "queued"> | undefined; elsewhere?: number; locale?: Locale }): Standin | undefined {
	const state = standinState(f);
	return state && { state, message: standinMessage(f.status, { cards: f.cards, working: f.working, elsewhere: f.elsewhere ?? 0, locale: f.locale ?? "en" }) };
}
