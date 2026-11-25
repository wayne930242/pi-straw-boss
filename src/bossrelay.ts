import { randomUUID } from "node:crypto";
import type { BossQuestion } from "./bossask.ts";
import { BOSS_PREFIX, type Bus, type Question, questionsDigest } from "./owners.ts";

// The hub's half of the boss question (bossask.ts): the question relayed as sb's own questionnaire, so the page or a paired device can answer it while the dialog stands in the main's pane.

export type Got = { answer: string; typed: boolean; by: "remote" | "local"; note?: string } | { cancel: true };
type Raw = { version?: unknown; id?: unknown; answerId?: unknown; digest?: unknown; answers?: { choices?: unknown; text?: unknown; note?: unknown }[]; cancel?: unknown };

/** An answer the page or a paired device sent: why it is refused, or what it says. `closed`: an answer, here or there, already won. */
function judgeAnswer(a: Raw, q: BossQuestion, digest: string, closed: boolean): string | Got {
	if (closed) return "closed";
	if (a.digest !== digest) return "digest";
	if (a.cancel === true) return { cancel: true };
	const r = Array.isArray(a.answers) && a.answers.length === 1 ? a.answers[0] : undefined;
	const pick = Array.isArray(r?.choices) && r.choices.length === 1 ? q.options?.[Number(r.choices[0])] : undefined;
	const text = typeof r?.text === "string" ? r.text.trim() : "";
	const note = typeof r?.note === "string" ? r.note.trim() : ""; // the page's note on a pick: a condition the boss adds
	if (!pick && !text) return "malformed";
	return { answer: pick ?? text, typed: !pick, by: "remote", ...(note ? { note } : {}) };
}

/** The same question relayed as sb's own questionnaire (owners.ts `bossQuestion`): published as pending, each answer judged and told accepted or refused, `won` called with the first accepted; `close` ends it with who closed it. */
export function hubRelay(bus: Bus, q: BossQuestion, title: string, callId: string | undefined, closed: () => boolean, won: (got: Got) => void) {
	const id = randomUUID(), questions: Question[] = [{ question: title, multiple: false, options: (q.options ?? []).map((title) => ({ title })) }], digest = questionsDigest(questions);
	const off = bus.on(`${BOSS_PREFIX}:answer`, (raw) => {
		const a = raw as Raw;
		if (a?.version !== 1 || a.id !== id) return;
		const judged = judgeAnswer(a, q, digest, closed()), reason = typeof judged === "string" ? judged : undefined;
		if (typeof judged !== "string") won(judged);
		bus.emit(`${BOSS_PREFIX}:answer-result`, { version: 1, id, answerId: a.answerId, accepted: !reason, ...(reason ? { reason } : {}) });
	});
	if (callId) bus.emit(`${BOSS_PREFIX}:pending`, { version: 1, id, toolCallId: callId, digest, questions });
	return {
		close(by: string) {
			off();
			if (callId) bus.emit(`${BOSS_PREFIX}:closed`, { version: 1, id, by });
		},
	};
}
