import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { every } from "./lanface.ts";
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
export type BossAsk = (q: BossQuestion, signal: AbortSignal | undefined, ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined) => Promise<Asked>;
const AUTO_NOTE = "Auto mode is on (the boss is away): the tower parks it, and it comes back to you as a wait_returned message when he is back. Ask him again then, with call_tower boss.";

export function createBossAsk({ cfg, s, role }: Kit, d: { attended(): boolean; remote(): boolean }): BossAsk {
	const watch = cfg.face?.every ?? every;
	return async (q, signal, ctx) => {
		if (role() !== "main" || s.isTrain || s.isTower || s.remoteOrigin || d.remote() || !d.attended() || !ctx?.hasUI) return { kind: "tower" };
		if (s.autoOn()) return { kind: "tower", note: AUTO_NOTE };
		const ac = new AbortController(), stop = watch(() => void (s.autoOn() && ac.abort()), WATCH_MS);
		const opts = { signal: signal ? AbortSignal.any([signal, ac.signal]) : ac.signal };
		let answer: string | undefined, typed = false;
		try {
			const pick = q.options ? await ctx.ui.select(`The boss decides: ${q.question}`, [...q.options, OWN_ANSWER], opts) : OWN_ANSWER;
			if (pick === OWN_ANSWER && !opts.signal.aborted) (typed = true), (answer = await ctx.ui.input(`The boss decides: ${q.question}`, "Your answer", opts));
			else answer = pick;
		} finally {
			stop();
		}
		if (ac.signal.aborted || s.autoOn()) return { kind: "tower", note: `Auto mode started while the boss was asked, so the dialog closed. ${AUTO_NOTE}` };
		const said = answer?.trim();
		if (signal?.aborted || !said) return { kind: "none", text: `The boss did not answer (${signal?.aborted ? "the turn was stopped" : "Esc"}): nothing was sent to the tower. Go on with work that does not need it; ask again only if it still blocks you.` };
		return { kind: "answered", text: `The boss ${typed ? "answered" : "chose"}: ${JSON.stringify(said)}. This is the boss's answer, asked in this pane; nothing was sent to the tower.` };
	};
}
