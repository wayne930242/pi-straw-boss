import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { every } from "./lanface.ts";
import { type Got, hubRelay } from "./bossrelay.ts";
import type { Bus } from "./owners.ts";
import type { Kit } from "./state.ts";

// A decision only the boss can make, asked by code (docs/specs/2026-11-25-idle-wrap-up.md part 2; boss 2026-11-25: 「「自己問我」應該做成程式碼，直接從程式碼發出」). `call_tower` with `why: blocked` and `boss` draws
// the question in this main's own pane with pi's dialog (a select with the options and a typed answer, or an input), so Herdr shows the pane waiting and the GUI relays the select as any dialog; the answer is the tool's
// result and nothing goes to the tower. Under auto mode, in a teammate's turn, on an unattended device, without a terminal, and for any session that is no tab's main (a member, a train, a tower), nothing is drawn:
// the question goes to the tower as `blocked`, as before 0.91.0. A dialog open when auto mode starts is ended here, and the question goes to the tower: the watch looks at auto.json more often than auto mode's
// own transition does, so the dialog is usually gone before that transition would cancel it (auto.ts leaves a cancelled `call_tower` its own result).

export interface BossQuestion { question: string; options?: string[] }
const QUESTION_MAX = 500, OPTION_MAX = 120, OPTIONS_MAX = 8, WATCH_MS = 500;
/** The select's last row: the boss types his own answer instead. */
export const OWN_ANSWER = "Type another answer…";
/** No descriptions: `call_tower`'s own clause names it, and the limits are checked here (a tool's size is paid on every turn: tests/tools-budget.test.ts). */
export const bossParameter = () => Type.Optional(Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }));

/** The question checked and folded: one line each, the options without blanks or repeats. */
export function bossOf(raw: BossQuestion): BossQuestion {
	const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
	const question = line(raw.question);
	if (!question || question.length > QUESTION_MAX) throw new Error(`boss.question is required: one question of 1 to ${QUESTION_MAX} characters`);
	const options = [...new Set((raw.options ?? []).map(line).filter((o) => o && o !== OWN_ANSWER))];
	if (options.length > OPTIONS_MAX || options.some((o) => o.length > OPTION_MAX)) throw new Error(`boss.options: at most ${OPTIONS_MAX}, each at most ${OPTION_MAX} characters`);
	return { question, ...(options.length ? { options } : {}) };
}
/** What the tower gets when the boss is not asked here: the message, then the question and its options. */
export const withBoss = (message: string, q: BossQuestion) => `${message}\nFor the boss: ${q.question}${q.options ? `\nOptions: ${q.options.join(" | ")}` : ""}`;

export type Asked = { kind: "answered"; text: string } | { kind: "none"; text: string } | { kind: "tower"; note?: string };
export type BossAsk = (q: BossQuestion, signal: AbortSignal | undefined, ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, callId?: string) => Promise<Asked>;
const AUTO_NOTE = "Auto mode is on (the boss is away): the tower parks it, and it comes back to you as a wait_returned message when he is back. Ask him again then, with call_tower boss.";
type Opts = { signal: AbortSignal };

/** The dialog in this pane: a select with the options and a typed answer, or an input. Auto mode starting between the pick and the typed answer opens no input (it would be answered as Escape and marked refused). */
async function paneDialog(ui: ExtensionContext["ui"], q: BossQuestion, title: string, opts: Opts, away: () => boolean): Promise<Got | undefined> {
	const pick = q.options ? await ui.select(title, [...q.options, OWN_ANSWER], opts) : OWN_ANSWER;
	const typed = pick === OWN_ANSWER;
	const answer = !typed ? pick : opts.signal.aborted || away() ? undefined : await ui.input(title, "Your answer", opts);
	return answer?.trim() ? { answer: answer.trim(), typed, by: "local" } : undefined;
}

export function createBossAsk({ pi, cfg, s, role }: Kit, d: { attended(): boolean; remote(): boolean }): BossAsk {
	const watch = cfg.face?.every ?? every, bus = pi.events as unknown as Bus;
	return async (q, signal, ctx, callId) => {
		if (role() !== "main" || s.isTrain || s.isTower || s.remoteOrigin || d.remote() || !d.attended() || !ctx?.hasUI) return { kind: "tower" };
		if (s.autoOn()) return { kind: "tower", note: AUTO_NOTE };
		const title = `The boss decides: ${q.question}`, ac = new AbortController(), stop = watch(() => void (s.autoOn() && ac.abort()), WATCH_MS);
		const opts = { signal: signal ? AbortSignal.any([signal, ac.signal]) : ac.signal };
		// The first answer, here or there, wins: one from the page or a paired device ends the dialog here.
		let got: Got | undefined;
		const relay = hubRelay(bus, q, title, callId, () => got !== undefined, (g) => ((got = g), ac.abort()));
		try {
			const local = await paneDialog(ctx.ui, q, title, opts, () => s.autoOn());
			if (!got && local) got = local;
		} finally {
			stop();
			relay.close(got && "by" in got ? got.by : got ? "cancel" : signal?.aborted ? "abort" : s.autoOn() ? "auto" : "local");
		}
		if (got && "answer" in got) return { kind: "answered", text: `The boss ${got.typed ? "answered" : "chose"}: ${JSON.stringify(got.answer)}${got.note ? `. His note: ${JSON.stringify(got.note)}` : ""}. This is the boss's answer, asked in this pane; nothing was sent to the tower.` };
		if (s.autoOn()) return { kind: "tower", note: `Auto mode started while the boss was asked, so the dialog closed. ${AUTO_NOTE}` };
		return { kind: "none", text: `The boss did not answer (${signal?.aborted ? "the turn was stopped" : "Esc"}): nothing was sent to the tower. Go on with work that does not need it; ask again only if it still blocks you.` };
	};
}
