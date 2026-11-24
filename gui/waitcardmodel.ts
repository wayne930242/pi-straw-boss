import type { BossWait, WaitCardView, WaitPressView } from "../src/net.ts";
import { noun } from "./nouns.ts";
import { m } from "./sentences.ts";

// What a wait card shows (docs/specs/2026-11-07-wait-cards.md, The card in the GUI): which parts, which buttons, which words, decided from the wait as the snapshot carries it and the few facts of the page (a paired device, what the stream is doing, what
// the boss just pressed). Pure: waitcard.ts draws it and holds the DOM, and every host (the dock's dialog, the tower's rows, Zen) draws the same model.

type Opts = { locale?: "en" | "zh-TW"; /** The wait is the head tower's: its words name the head tower (`_head` twins, Q3 of docs/specs/2026-11-10-wait-cards-tui.md). */ head?: boolean };
type Msg = (inputs: never, options?: { locale?: "en" | "zh-TW" }) => string; // a message takes its own inputs, which the card passes by name
/** A message of the card that names the tower, or its twin that names the head tower. */
const word = (base: Msg, twin: Msg, o?: Opts) => (o?.head ? twin : base) as (inputs: object, options?: Opts) => string;
export type Kind = "action" | "choice" | "secret" | "legacy";
/** `open`; `sending` (a press is on its way); `pressed` (the wait carries the press); `refused` (the server said no: the buttons are on again); `stale` (the stream is down); `ended` (the tower resolved it, or the boss declined it). */
export type Phase = "open" | "sending" | "pressed" | "refused" | "stale" | "ended";
export type ButtonId = "done" | "choose" | "secret" | "entered" | "restate" | "main" | "reply" | "skip";
export interface Button { id: ButtonId; label: string; primary?: boolean; /** `choose`: the option's index; `then` is its small line. */ option?: number; then?: string; disabled?: boolean; picked?: boolean }
export interface Part { id: "happened" | "do" | "where" | "after" | "words"; label: string; text: string; url?: string; command?: string }
export interface CardModel {
	kind: Kind;
	tag: string;
	/** Who raised it, when, in the page's language. */
	raised: string;
	parts: Part[];
	buttons: Button[];
	/** The state in words: what the boss pressed and who was told, the secret's second step, or that the stream is down / the tower closed it. */
	line: string;
	/** Instead of a start button on a device that cannot enter a secret (WC-D4), or while auto mode parks the card and refuses a secret's press (auto-mode spec AM-F013). */
	remote?: string;
	/** The card is parked for the boss's return (auto mode is on): its mark. */
	parked?: string;
	/** The secret card's step: 1 before the start button is pressed, 2 after the raiser was asked. */
	step?: 1 | 2;
	/** Whether the whole card was read (a cut card has only its text until the page reads it). */
	whole: boolean;
}
export interface CardInput {
	wait: BossWait;
	phase: Phase;
	/** A paired device (WC-D4): it cannot start the secret flow. */
	remote: boolean;
	/** The press on its way: its button says it. */
	sending?: { id: ButtonId; option?: number };
	/** The host can open the raiser's session (the card is not on the raiser's own page, and the host knows its route). */
	open: boolean;
	/** The raiser's unit has a `secret_drop` dialog pending now. */
	secretOpen?: boolean;
	/** The card is off because its unit's box is away, not because the stream is down: the reason, which the status line says in place of the connection words. */
	blocked?: string;
	/** The wait is the head tower's. */
	head?: boolean;
	now: number;
}

export const kindOf = (w: BossWait): Kind => (w.card ? w.card.type : "legacy");
const AGE: [number, (o: { n: string }, x?: Opts) => string][] = [[86_400, m.age_d], [3600, m.age_h], [60, m.age_m]];
/** `12 min ago` in the page's language; under a minute, seconds. */
export function ago(at: string, now: number, o?: Opts): string {
	const s = Math.max(0, (now - Date.parse(at)) / 1000);
	if (!Number.isFinite(s)) return "";
	for (const [size, say] of AGE) if (s >= size) return m.wc_ago({ age: say({ n: String(Math.floor(s / size)) }, o) }, o);
	return m.wc_ago({ age: m.age_s({ n: String(Math.floor(s)) }, o) }, o);
}
const tagOf = (k: Kind, o?: Opts) => ({ action: m.wc_tag_action, choice: m.wc_tag_choice, secret: m.wc_tag_secret, legacy: word(m.wc_tag_legacy, m.wc_tag_legacy_head, o) })[k]({}, o);
/** The raiser's line: who, where (the workspace and tab the net gave), and how long ago. A tower's own wait says so; a raiser that left says so. */
export function raisedLine(w: BossWait, now: number, o?: Opts): string {
	const f = w.card?.from, since = ago(w.at, now, o);
	if (!w.card) return since;
	if (!f) return [word(m.wc_raised_self, m.wc_raised_self_head, o)({}, o), since].filter(Boolean).join(" · ");
	const where = [f.workspace, f.tab].filter(Boolean).join(" › ");
	return [m.wc_raised({ name: f.gone ? `${f.name} ${m.wc_raised_gone({}, o)}` : f.name }, o), where, since].filter(Boolean).join(" · ");
}
const told = (card: WaitCardView | undefined, press: WaitPressView, o?: Opts): string => {
	const f = card?.from;
	if (!f || !press.main) return word(m.wc_told_tower, m.wc_told_tower_head, o)({}, o);
	return (press.main.status === "gone" ? word(m.wc_told_gone, m.wc_told_gone_head, o) : press.main.status === "failed" ? word(m.wc_told_failed, m.wc_told_failed_head, o) : word(m.wc_told_both, m.wc_told_both_head, o))({ name: f.name }, o);
};
/** The line a press leaves: what the boss did and who was told. The secret card's first step is not a press line (it has its own words). */
export function pressedLine(w: BossWait, o?: Opts, compact = false): string {
	const p = w.press;
	if (!p || p.act === "secret") return "";
	const said = p.act === "done" ? m.wc_pressed_done({}, o) : p.act === "choose" ? m.wc_pressed_choose({ label: w.card?.options?.[p.option ?? -1]?.label ?? "" }, o) : p.act === "decline" ? m.wc_pressed_decline({}, o) : word(m.wc_pressed_restate, m.wc_pressed_restate_head, o)({}, o);
	if (compact) return m.wc_pending({ answer: said, tower: noun(o?.head ? "head_tower" : "role_tower") }, o);
	return p.act === "restate" ? said : `${said}${m.wc_sep({}, o)}${told(w.card, p, o)}`;
}
const secretLine = (w: BossWait, secretOpen: boolean | undefined, o?: Opts): string => {
	const f = w.card?.from;
	if (secretOpen) return m.wc_secret_open({}, o);
	const name = f?.name ?? "";
	return f?.tab ? m.wc_secret_asked({ name, tab: f.tab }, o) : m.wc_secret_asked_plain({ name }, o);
};

export function cardModel(i: CardInput, opts?: Opts): CardModel {
	const o: Opts | undefined = i.head ? { ...opts, head: true } : opts;
	const { wait: w, phase } = i, kind = kindOf(w), card = w.card, step = kind === "secret" && w.press?.act === "secret" ? 2 : kind === "secret" ? 1 : undefined;
	const parts: Part[] = [];
	if (!card) parts.push({ id: "words", label: word(m.wc_p_words, m.wc_p_words_head, o)({}, o), text: w.text });
	else {
		parts.push({ id: "happened", label: m.wc_p_happened({}, o), text: card.happened }, { id: "do", label: (card.type === "choice" ? m.wc_p_decide : m.wc_p_do)({}, o), text: card.do });
		if (card.url || card.command) parts.push({ id: "where", label: m.wc_p_where({}, o), text: card.url ?? card.command ?? "", ...(card.url ? { url: card.url } : {}), ...(card.command ? { command: card.command } : {}) });
		if (card.after) parts.push({ id: "after", label: m.wc_p_after({}, o), text: card.after });
	}
	const pressed = Boolean(w.press && w.press.act !== "secret"), off = phase === "sending" || phase === "stale" || phase === "ended";
	const sendingOf = (id: ButtonId, option?: number) => phase === "sending" && i.sending?.id === id && i.sending.option === option;
	const buttons: Button[] = [];
	const say = (b: Button): Button => ({ ...b, ...(sendingOf(b.id, b.option) ? { label: m.wc_sending({}, o) } : {}), ...(off || (pressed && b.id !== "reply" && b.id !== "skip") ? { disabled: true } : {}) });
	const act = (b: Button) => {
		if (phase !== "ended") buttons.push(say(b));
	};
	let remote: string | undefined, parkedLine = "";
	if (phase !== "ended") {
		if (kind === "action" && !pressed) act({ id: "done", label: m.wc_b_done({}, o), primary: true });
		else if (kind === "choice") card!.options?.forEach((opt, k) => act({ id: "choose", label: opt.label, then: opt.then, option: k, ...(pressed && w.press?.option === k ? { picked: true } : {}) }));
		else if (kind === "secret" && !pressed) {
			if (step === 1) (w.parked ? (parkedLine = m.wc_secret_parked({}, o)) : i.remote ? (remote = m.wc_at_computer({}, o)) : act({ id: "secret", label: m.wc_b_start({}, o), primary: true }));
			else act({ id: "entered", label: m.wc_b_entered({}, o), primary: true });
		} else if (kind === "legacy" && !pressed && !w.cut) act({ id: "restate", label: word(m.wc_b_restate, m.wc_b_restate_head, o)({}, o), primary: true });
		if (card?.from && !card.from.gone && card.from.key && i.open) buttons.push({ id: "main", label: m.wc_b_main({ name: card.from.name }, o), ...(off ? { disabled: true } : {}) });
		buttons.push({ id: "reply", label: word(m.wc_b_reply, m.wc_b_reply_head, o)({}, o) }); // the reply fold keeps its own state (waitpanel.ts): an offline page keeps it and says so in the box
		if (!(w.press?.act === "decline")) buttons.push({ id: "skip", label: m.wc_b_skip({}, o), ...(phase === "stale" || phase === "sending" ? { disabled: true } : {}) });
	}
	// A card auto mode's end gave back (docs/specs/2026-11-21-auto-return.md, AR-D3) was not confirmed by a tower: its line says it was returned.
	const line = phase === "ended" ? (w.outcome && w.returned ? m.wc_returned({ outcome: w.outcome }, o) : w.outcome ? word(m.wc_ended, m.wc_ended_head, o)({ outcome: w.outcome }, o) : word(m.wc_ended_plain, m.wc_ended_plain_head, o)({}, o)) : phase === "stale" ? (i.blocked ?? m.wc_stale({}, o)) : pressed ? pressedLine(w, o) : step === 2 ? secretLine(w, i.secretOpen, o) : parkedLine; // a parked secret card says to end auto mode first in the status line, in place of its start row (spec wait-cards-tui, section 4)
	return { kind, tag: tagOf(kind, o), raised: raisedLine(w, i.now, o), parts, buttons, line, ...(remote ? { remote } : {}), ...(w.parked && phase !== "ended" ? { parked: m.wait_parked({}, o) } : {}), ...(step ? { step } : {}), whole: !w.cut };
}
