import type { Net } from "../src/net.ts";
import type { Alert } from "./alerts.ts";
import { cardSig } from "./cardalerts.ts";
import { rankOf, unitsOf, waitingOf } from "./units.ts";

// What Zen shows, decided without a page (docs/specs/2026-11-01-zen-view.md): the one current item, the pause, or the companion. The view it hands out never says how many items wait; the cue is the one place that does (Z-D19, `queued`).
// No card ever takes the screen by itself, and a card on the screen is never replaced or pulled away (Z-D20): a card is taken by the boss (`take`) and leaves by the boss's own answer, Not now, or closing it.
// One exception, the boss's own ruling (Z-D22): once he has taken a card and answered it, the next one that was already waiting when the answer was accepted is taken straight after the outcome, with no pause and no breath (`chained`).
export type Sound = "bowl" | "knock" | "low";
/** `outcome`: why the card is no longer answerable. `answered` (the boss's own answer) shows for 1.2 s and then the next card that waits (Z-D22), or the pause when none does; `elsewhere` (the question ended: answered in the terminal, the unit went on), `gone` (the unit left the net or closed: nothing was answered) and `error` (the unit failed) are held: the card stays, saying so, until the boss closes it (`skip`). */
export type Outcome = "answered" | "elsewhere" | "gone" | "error" | "ended" | "expired";
export type Screen = { kind: "item"; item: Alert; outcome?: Outcome } | { kind: "pause" } | { kind: "companion" };
export const REST_MS = 10 * 60_000, OUTCOME_MS = 1200, HOLD_MS = 30_000, PAUSE_MS = 3000;
/** The same tool call that had no relayed dialog when the card was taken and has one now (the relay is a step behind Herdr's `blocked`, src/ask.ts): the same question, now answerable, not another one. */
const gained = (was: Alert, now: Alert) => was.key === now.key && was.pending?.callId !== undefined && was.pending.callId === now.pending?.callId && !was.pending.answer && Boolean(now.pending.answer) && cardSig(was) === cardSig(now);
/** What changes an item's question: its dialog (and digest), else its tool call; a trust question has its digest in its key, a Link confirm its request. An item that changes it is another question: a rest ends, and a card on the screen is settled, not swapped. */
const questionOf = (a: Alert) => `${a.key}|${a.pending?.answer ? `${a.pending.answer.dialog}:${a.pending.answer.digest}` : (a.pending?.callId ?? "")}|${cardSig(a)}`;

/**
 * Whether an item blocks an agent that cannot go on until the boss answers (Z-D18, docs/specs/2026-11-01-zen-view.md, Blocking first): a unit that waits or has a dialog, a trust question, a question a box forwarded, a teammate's confirm. A tower's wait, a pair request, and a memory
 * proposal block no one: they rank below, and the order of the cards that wait is blocking first (Z-D19: the cards wait for Enter, so the rank only says which comes next). A kind of card nobody ranked fails the type check (`unranked`), and one that is unknown at run time blocks: a question that waits is not buried.
 */
const unranked = (_kind: never): true => true;
export function blocks(a: Alert): boolean {
	if (a.wait) return a.wait.asked === true; // a run's boss_wait_ask shows it now: the run's turn holds on it (docs/specs/2026-11-24-zen-f.md ZF-3)
	const kind = a.card?.kind;
	switch (kind) {
		case undefined: case "dialog": case "confirm": case "run": return true;
		case "pair": case "proposal": return false;
		default: return unranked(kind);
	}
}

/** A session Zen keeps company with: its key and its base. */
export interface With { key: string; ws: string }
/** The session for company: the asked one while the net lists it live with control; else none, and the breathing circle shows (Z-D12: no tower stands in). */
export function companionOf(net: Net | undefined, asked: With | undefined): With | undefined {
	const ws = asked && net && unitsOf(net).find(({ unit: u }) => u.key === asked.key && u.control && !("ended" in u && u.ended))?.base.id;
	return asked && ws !== undefined ? { key: asked.key, ws } : undefined;
}

/**
 * `covered`: something the boss opened lies over the card (the terminal layer, the palette, a menu): the card behind it is not followed by another (Z-D22). `endOf`: why a run's dialog (docs/specs/2026-11-24-zen-f.md §2.3) the server stopped listing
 * is gone when it was not answered elsewhere: its run ended (`ended`) or it timed out (`expired`); both ring nothing, as a unit that left does not.
 */
export interface ZenDeps { now(): number; covered?(): boolean; endOf?(item: Alert): "ended" | "expired" | undefined }
export function createZen({ now, covered, endOf }: ZenDeps) {
	let alerts = new Map<string, Alert>(), screen: Screen = { kind: "companion" }, until = 0, hidden = false, quiet = false, knocked = false, back = false, chain = false, left = false;
	let lined = new Set<string>(); // the cards that waited when the boss's answer was accepted: the only ones the chain may take (a card that comes during the outcome waits for Enter)
	const seen = new Map<string, number>(), rests = new Map<string, { until: number; q: string }>();
	let sound: Sound | undefined;
	const items = () => waitingOf(alerts.values()).filter((a) => a.mark !== "error");
	const age = (a: Alert) => a.since ?? seen.get(a.key) ?? now();
	const eligible = () => items().filter((a) => !rests.has(a.key)).sort((a, b) => Number(blocks(b)) - Number(blocks(a)) || age(a) - age(b) || (a.key < b.key ? -1 : 1)); // blocking first, then the one that has waited longest
	const next = () => eligible()[0];
	/** The cards that wait for the boss to take them: the eligible ones but the one on the screen (a card that is shown, even one that has just ended, is not counted behind itself). */
	const queued = () => eligible().filter((a) => screen.kind !== "item" || a.key !== screen.item.key);
	const take = (item: Alert) => ((screen = { kind: "item", item }), (quiet = knocked = false), (sound = "bowl"));
	/** The card the boss's accepted answer is followed by (Z-D22): the next in the order Enter takes among those queued when the answer was accepted (`lined`), never the unit's own next question under the key just answered (it waits for Enter), and none on a page that is hidden, that Zen was left from (`left`: every visit starts at the breath, Z-D16), or that has something opened over the card. */
	const after = () => (hidden || left || covered?.() ? undefined : eligible().find((a) => lined.has(a.key) && a.key !== (screen as Extract<Screen, { kind: "item" }>).item.key));
	const pause = () => ((screen = { kind: "pause" }), (until = now() + PAUSE_MS));
	/** The card on the screen is settled: it stays (`outcome`), and only the boss's answer, Not now, or Esc takes it away. `answered` runs for 1.2 s, the others until closed (`until` 0: no timer). */
	const settled = (outcome: Outcome, snd: Sound | undefined) => ((screen = { ...(screen as Extract<Screen, { kind: "item" }>), outcome }), (until = outcome === "answered" ? now() + OUTCOME_MS : 0), snd && !quiet && !(snd === "knock" && knocked) && ((sound = snd), snd === "knock" ? (knocked = true) : (quiet = true))); // one knock per card: a snapshot that drops it and lists it again (a Link reconnect) does not ring again (ZNI-F002); the low bowl is a new thing (a refusal, a failure) and still rings after a knock (ZNR-F001)
	/** Everything time and data change: the end of an outcome, a rest, or the pause, and a card on the screen whose question ended. Nothing here puts a card on the screen: the boss takes it. */
	function settle() {
		const open = new Map(items().map((x) => [x.key, x] as const));
		for (const [k, r] of rests) if (r.until <= now() || !open.has(k) || questionOf(open.get(k)!) !== r.q) rests.delete(k);
		if (screen.kind === "item") {
			const cur = alerts.get(screen.item.key), live = Boolean(cur && rankOf(cur) === 0 && cur.mark !== "error" && (questionOf(cur) === questionOf(screen.item) || gained(screen.item, cur))); // the same question, still asked
			if (screen.outcome === "answered") { if (back) left = true; // Zen was shown again while the answer's outcome was unsettled: the visit starts at the breath, and the outcome ends in the pause
				if (until <= now()) { const n = after(); n ? (take(n), (chain = true)) : pause(); } } // the boss answered: the next card, as if he had pressed Enter for it, or the pause
			else if (live && screen.outcome !== "error") screen = { kind: "item", item: cur! }; // a held card whose question is listed again (a snapshot that missed it) is live again
			else if (back) screen = { kind: "companion" }; // the item was on the screen when Zen was left and has ended since (answered in Standard, or closed): no card, no knock, and no line about it
			else if (!screen.outcome) {
				const it = screen.item, elsewhere = cur ? !cur.closed : Boolean(it.trust || it.card); // a trust question or a card (a link confirm, a pair request, a proposal) has no unit to leave: when the server stops listing it, it was settled; a unit that left or closed is a silent end
				const left = !it.trust && !it.card && !it.wait && (!cur || cur.closed); // ...and nothing was answered: the card says the unit left, not that it was answered elsewhere (ZNI-F007)
				const over = !cur && it.card?.kind === "run" ? endOf?.(it) : undefined; // a run's dialog whose run ended or that timed out: its words, and no knock
				settled(cur?.mark === "error" ? "error" : over ?? (left ? "gone" : "elsewhere"), cur?.mark === "error" ? "low" : over ? undefined : elsewhere ? "knock" : undefined);
			}
		}
		// A pause is for a boss who is there to breathe: a page that is not shown has none, so an item that waits ends it at once (the page reminds, as on any hidden page). With nothing waiting it is kept until the page is shown.
		if (screen.kind === "pause" && ((until <= now() && !hidden) || (hidden && next()))) screen = { kind: "companion" };
	}
	const out = () => { settle(); const s = sound, chained = chain; sound = undefined; chain = false; return { screen, sound: s, ...(chained ? { chained } : {}) }; };
	return {
		/** A new snapshot's alerts; `returning`: Zen is shown again after Standard had the page, so an item the screen still held from before and the snapshot no longer has is dropped silently. */
		update(a: Map<string, Alert>, returning = false) { back = returning; alerts = a; for (const x of items()) if (!seen.has(x.key)) seen.set(x.key, now()); for (const k of seen.keys()) if (!a.has(k)) seen.delete(k); try { return out(); } finally { back = false; } },
		/** The clock moved. */
		tick: out,
		/** The accepted answer or cancel of the item with this key: the knock, the outcome for 1.2 s, then the next card that waits (Z-D22) or the pause. */
		accepted(key: string) { if (screen.kind !== "item" || screen.item.key !== key) return out(); // a reply that comes after the boss moved on belongs to an item that is no longer on screen
			if (screen.outcome === "elsewhere" || screen.outcome === "gone" || screen.outcome === "ended" || screen.outcome === "expired") (settled("answered", undefined), (lined = new Set(queued().map((x) => x.key))), (left = false)); // the server's snapshot came ahead of its reply: this answer settled it, and the knock already rang
			else if (!screen.outcome) { lined = new Set(queued().map((x) => x.key)); left = false; quiet = knocked = false; settled("answered", "knock"); quiet = true; rests.set(screen.item.key, { until: now() + HOLD_MS, q: questionOf(screen.item) }); } return out(); },
		/** An answer of the item with this key that was refused, stale, busy, or unconfirmed: the low bowl, and the card stays; the item's later exit is silent. */
		refused(key: string) { if (screen.kind === "item" && screen.item.key === key && !screen.outcome && !quiet) { sound = "low"; quiet = true; } return out(); },
		/** Not now, or closing a card that ended (`elsewhere`, `gone`, `error`): the pause starts. A card that is still asked rests; one that ended does not, so the unit's next question (or the same one, listed again) is in the queue. */
		skip() { if (screen.kind === "item" && screen.outcome !== "answered") { if (!screen.outcome) rests.set(screen.item.key, { until: now() + REST_MS, q: questionOf(screen.item) }); pause(); } return out(); },
		/** Enter, or a tap on the cue (Z-D19): the next card takes the screen, the pause ending with it. False (no change) when none waits or one is on the screen. */
		take() { if (screen.kind !== "item") { const n = next(); if (n) take(n); } return out(); },
		/** The cards that wait for Enter, in the order they come (the cue says how many): those behind the card on the screen included. */
		queued,
		/** The keys of every card the server lists as waiting, the one on the screen and the ones set aside included (what a reminder is counted against, so one card is reminded once). */
		listed: () => items().map((x) => x.key),
		/** A tap, Enter, or Space during the pause. */
		tap() { if (screen.kind === "pause") until = 0; return out(); },
		/** The page was hidden or shown: a pause that would have ended ends at once when shown. */
		visible(on: boolean) { hidden = !on; return out(); },
		/** Why the waiting item `key` is not what the screen shows now (the page's console line), or nothing when it is or is no item. */
		why(key: string): string | undefined {
			if (screen.kind === "item" && screen.item.key === key) return undefined;
			if (!items().some((x) => x.key === key)) return undefined;
			if (rests.has(key)) return "it was put aside (Maybe later), or just answered";
			if (screen.kind === "item") return `${screen.item.key} is on the screen`;
			if (screen.kind === "pause") return hidden ? "a pause holds the page, which is hidden" : "the pause after a card is on";
			return "it waits for Enter: no card takes the screen by itself";
		},
		/** The soonest moment ahead at which something may change, for the layer's one timer (a time already past is settled by the call that saw it). */
		due: () => [until, ...[...rests.values()].map((r) => r.until)].filter((t) => t > now()).sort((a, b) => a - b)[0],
	};
}
