import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { every } from "./lanface.ts";
import { BOSS_PREFIX, type Bus, type Question, questionsDigest } from "./owners.ts";
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
type Got = { answer: string; typed: boolean; by: "remote" | "local" } | { cancel: true };

export function createBossAsk({ pi, cfg, s, role }: Kit, d: { attended(): boolean; remote(): boolean }): BossAsk {
	const watch = cfg.face?.every ?? every, bus = pi.events as unknown as Bus;
	return async (q, signal, ctx, callId) => {
		if (role() !== "main" || s.isTrain || s.isTower || s.remoteOrigin || d.remote() || !d.attended() || !ctx?.hasUI) return { kind: "tower" };
		if (s.autoOn()) return { kind: "tower", note: AUTO_NOTE };
		const title = `The boss decides: ${q.question}`, ac = new AbortController(), stop = watch(() => void (s.autoOn() && ac.abort()), WATCH_MS);
		const opts = { signal: signal ? AbortSignal.any([signal, ac.signal]) : ac.signal };
		// The same question relayed as sb's own questionnaire (owners.ts `bossQuestion`): the page or a paired device picks an option or types an answer, or cancels; the first answer, here or there, wins.
		const id = randomUUID(), questions: Question[] = [{ question: title, multiple: false, options: (q.options ?? []).map((title) => ({ title })) }], digest = questionsDigest(questions);
		let got: Got | undefined;
		const off = bus.on(`${BOSS_PREFIX}:answer`, (raw) => {
			const a = raw as { version?: unknown; id?: unknown; answerId?: unknown; digest?: unknown; answers?: { choices?: unknown; text?: unknown }[]; cancel?: unknown };
			if (a?.version !== 1 || a.id !== id) return;
			const r = Array.isArray(a.answers) && a.answers.length === 1 ? a.answers[0] : undefined, pick = Array.isArray(r?.choices) && r.choices.length === 1 ? q.options?.[Number(r.choices[0])] : undefined, text = typeof r?.text === "string" ? r.text.trim() : "";
			const reason = got ? "closed" : a.digest !== digest ? "digest" : a.cancel === true || pick || text ? undefined : "malformed";
			if (!reason) (got = a.cancel === true ? { cancel: true } : { answer: pick ?? text, typed: !pick, by: "remote" }), ac.abort();
			bus.emit(`${BOSS_PREFIX}:answer-result`, { version: 1, id, answerId: a.answerId, accepted: !reason, ...(reason ? { reason } : {}) });
		});
		if (callId) bus.emit(`${BOSS_PREFIX}:pending`, { version: 1, id, toolCallId: callId, digest, questions });
		try {
			const pick = q.options ? await ctx.ui.select(title, [...q.options, OWN_ANSWER], opts) : OWN_ANSWER;
			// Auto mode starting between the pick and the typed answer opens no input (it would be answered as Escape and marked refused).
			const typed = pick === OWN_ANSWER, answer = typed && !opts.signal.aborted && !s.autoOn() ? await ctx.ui.input(title, "Your answer", opts) : typed ? undefined : pick;
			if (!got && answer?.trim()) got = { answer: answer.trim(), typed, by: "local" };
		} finally {
			stop();
			off();
			if (callId) bus.emit(`${BOSS_PREFIX}:closed`, { version: 1, id, by: got && "by" in got ? got.by : got ? "cancel" : signal?.aborted ? "abort" : "local" });
		}
		if (got && "answer" in got) return { kind: "answered", text: `The boss ${got.typed ? "answered" : "chose"}: ${JSON.stringify(got.answer)}. This is the boss's answer, asked in this pane; nothing was sent to the tower.` };
		if (s.autoOn()) return { kind: "tower", note: `Auto mode started while the boss was asked, so the dialog closed. ${AUTO_NOTE}` };
		return { kind: "none", text: `The boss did not answer (${signal?.aborted ? "the turn was stopped" : "Esc"}): nothing was sent to the tower. Go on with work that does not need it; ask again only if it still blocks you.` };
	};
}
