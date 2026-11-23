import type { Locale } from "../locale.ts";
import type { PollAnswer, PromptSource } from "./source.ts";

// The viewer's part of the entry under headless runs (docs/specs/2026-11-23-f-entry.md, at the boss's minimum): the live transcript the poll carries, `@<workspace>` straight to that tower, `/stop`, and the
// answers to a run's dialogs. Only a line typed on its own counts: a paste is never a command, an address, or an answer. The server writes every transcript line's prefix and cleans it; this side cleans it again.

/** One line from the server, with no control or escape left. */
export const shown = (line: unknown, max = 400) => String(line).replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g, "").replace(/(?:\u001b\]|\u009d)[^\u0007\u001b\u009c]*(?:\u0007|\u001b\\|\u009c)?/g, "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, max);

const EN = {
	stopped: "asked the tower to stop its turn.",
	noTurn: "no headless run is live here to stop.",
	to: (label: string, first: string) => `» → ${label}: ${first}`,
	dialog: (n: number, title: string) => `? [${n}] ${title}`,
	answerHow: "answer with /yes N, /no N, or /pick N <choice>; a paste answers nothing.",
	answered: "answered.",
};
const ZH: typeof EN = {
	stopped: "已請塔台停下這一輪。",
	noTurn: "這裡沒有正在執行的無介面 run 可以停。",
	to: (label, first) => `» → ${label}：${first}`,
	dialog: (n, title) => `? [${n}] ${title}`,
	answerHow: "用 /yes N、/no N 或 /pick N <選項> 回答；貼上的文字不算回答。",
	answered: "已回答。",
};

/** The dialogs as the viewer numbers them, and the lines that show them when they changed. */
export function dialogLines(answer: PollAnswer, locale: Locale, last: string): { key: string; lines: string[] } {
	const words = locale === "zh-TW" ? ZH : EN, dialogs = answer.dialogs ?? [], key = JSON.stringify(dialogs.map((d) => d.key));
	if (key === last || !dialogs.length) return { key, lines: [] };
	return { key, lines: [...dialogs.flatMap((d, i) => [words.dialog(i + 1, shown(d.title, 160)), ...(d.message ? d.message.split("\n").slice(0, 200).map((l) => `  ${shown(l, 2000)}`) : []), ...(d.options ?? []).map((o, j) => `  ${j + 1}. ${shown(o, 80)}`)]), words.answerHow] };
}

/**
 * A single typed line the entry takes: `/stop`, `/yes N`, `/no N`, `/pick N <choice>`, or `@<workspace> <text>` (`@@` keeps a literal `@` for the tower). Returns the line to say, or undefined when the line is not one of
 * these (it goes on as the prompt's own command or the boss's words). Throws with the server's words when it refused.
 */
export async function entryLine(line: string, o: { source: PromptSource; answer: PollAnswer | undefined; locale: Locale }): Promise<string | undefined> {
	const words = o.locale === "zh-TW" ? ZH : EN, s = o.source, trimmed = line.trim();
	if (!s.abort || o.answer?.lines === undefined) return undefined; // an older server, or headless runs off (the poll carries no transcript): the prompt is as it was
	if (trimmed === "/stop") return (await s.abort()) ? words.stopped : words.noTurn;
	const reply = /^\/(yes|no|pick)\s+(\d+)(?:\s+(.+))?$/.exec(trimmed);
	if (reply) {
		const d = o.answer?.dialogs?.[Number(reply[2]) - 1];
		if (!d || !s.answer) return undefined;
		const pick = reply[3]?.trim();
		const choice = pick && /^\d+$/.test(pick) ? d.options?.[Number(pick) - 1] : pick;
		await s.answer(d.key, reply[1] === "pick" ? { value: choice ?? "" } : d.method === "confirm" ? { confirmed: reply[1] === "yes" } : reply[1] === "no" ? { cancelled: true } : { value: choice ?? "yes" });
		return words.answered;
	}
	const at = /^@([^\s@][^\s]*)\s+([\s\S]+)$/.exec(line.trimStart());
	if (at && s.direct) {
		const got = await s.direct(at[1]!, at[2]!.trim());
		return words.to(shown(got.label, 60), shown(at[2]!.trim().split("\n")[0], 60));
	}
	return undefined;
}
