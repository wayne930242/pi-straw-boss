import type { PollAnswer } from "./source.ts";

// The words of the tower prompt. English, and Traditional Chinese for a boss whose shell says so; every other language, Simplified Chinese included, gets English.

export type Locale = "en" | "zh-TW";

/** The prompt's language from the environment as a shell reads it (LC_ALL, then LC_MESSAGES, then LANG); with none set, from the system's own language. */
export function localeOf(env: NodeJS.ProcessEnv): Locale {
	const set = env.LC_ALL || env.LC_MESSAGES || env.LANG || systemLanguage();
	return /^zh[_-](tw|hk|mo|hant)/i.test(set) ? "zh-TW" : "en";
}
function systemLanguage(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().locale;
	} catch {
		return "en";
	}
}

export interface Texts {
	/** The line of the tower's state: `tower · Alpha: standing by`. */
	header(label: string, answer: Pick<PollAnswer, "state" | "queued">): string;
	/** The lines under the first state line. */
	hint: string[];
	waking: string;
	leaving: string;
	noTower: string;
	silent(why: string): string;
	back: string;
	refused(error: string): string;
}

const EN: Texts = {
	header: (label, a) => `tower · ${label}: ${stateWord(a, { standing: "standing by", waking: "waking up", running: "running", closing: "closing", held: "held" }, (n) => `${n} queued`)}`,
	hint: [
		"Type a message and press Enter to wake the tower with it; Enter alone wakes it without one.",
		"Ctrl+D leaves this pane to your shell. From any pi session: /boss tower <message>.",
	],
	waking: "waking the tower…",
	leaving: "leaving this pane to your shell; this prompt comes back when a tower run ends, or after 30 minutes.",
	noTower: "the sb server has no tower for this workspace any more; this pane is yours.",
	silent: (why) => `the sb server does not answer (${why}); waiting for it.`,
	back: "the sb server answers again.",
	refused: (error) => `the tower did not take it: ${error}`,
};
const ZH: Texts = {
	header: (label, a) => `塔台 · ${label}：${stateWord(a, { standing: "待命中", waking: "喚醒中", running: "執行中", closing: "收尾中", held: "已擱置" }, (n) => `${n} 則待處理`)}`,
	hint: [
		"輸入訊息後按 Enter，連同訊息喚醒塔台；直接按 Enter 則不帶訊息。",
		"Ctrl+D 把這個窗格還給你的 shell。在任何 pi 工作階段都可用：/boss tower <訊息>。",
	],
	waking: "正在喚醒塔台…",
	leaving: "把這個窗格還給你的 shell；塔台執行結束或 30 分鐘後，這個提示會回來。",
	noTower: "sb 伺服器已不再為這個工作區執行塔台，這個窗格歸你了。",
	silent: (why) => `sb 伺服器沒有回應（${why}），等它回來。`,
	back: "sb 伺服器又回應了。",
	refused: (error) => `塔台沒有收下：${error}`,
};

/** The state in words: what stands alone says it; a tower that waits with events says how many, and a running one adds them. A word this build does not know is shown as the server sent it. */
function stateWord(a: Pick<PollAnswer, "state" | "queued">, words: Record<string, string>, queued: (n: number) => string): string {
	const word = words[a.state] ?? String(a.state);
	if (a.queued <= 0) return word;
	return a.state === "standing" ? queued(a.queued) : `${word}, ${queued(a.queued)}`;
}

export const textsFor = (locale: Locale): Texts => (locale === "zh-TW" ? ZH : EN);
