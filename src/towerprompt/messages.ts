import type { Hint } from "./look.ts";
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
	/** The title: `tower · Alpha`. */
	title(label: string): string;
	/** The head tower's title. */
	head: string;
	/** The tower's state in words: `standing by`, `3 queued`, `running, 2 queued`. */
	state(answer: Pick<PollAnswer, "state" | "queued">): string;
	/** The key rows under the first state line. */
	hints: Hint[];
	waking: string;
	/** `/new` was taken. */
	fresh: string;
	leaving: string;
	noTower: string;
	silent(why: string): string;
	back: string;
	refused(error: string): string;
	/** A first line that starts with `/` and is none of the prompt's commands: said on the spot, and not posted. `word` is the first word as typed. */
	unknownCommand(word: string): string;
	/** The word before the pick mode's prompt mark (`wait ❯`). */
	pickWord: string;
	/** A run starts while the boss is picking: pick mode is dropped, the line is discarded, and the pane's own pi has the cards. */
	pickWoke: string;
	/** The block of cards that wait for the boss emptied: its last print is out of date. */
	waitsNone: string;
	/** After the queued count, while the server holds the tower's wake because the boss is answering cards here. */
	holding: string;
}

const EN: Texts = {
	title: (label) => `tower · ${label}`,
	head: "head tower",
	state: (a) => stateWord(a, { standing: "standing by", waking: "waking up", running: "running", closing: "closing", held: "held" }, (n) => `${n} queued`),
	hints: [
		{ keys: "⏎", plain: "Enter", text: "wake the tower with your message; alone, without one" },
		{ keys: "/new", plain: "/new", text: "the next conversation is a new session" },
		{ keys: "/wait", plain: "/wait", text: "press a wait card" },
		{ keys: "/quit ⌃D", plain: "/quit, Ctrl+D", text: "leave this pane to your shell" },
		{ keys: "/boss tower <message>", plain: "/boss tower <message>", text: "wake the tower from any pi session" },
	],
	waking: "waking the tower…",
	fresh: "the next conversation with the tower is a new session.",
	leaving: "leaving this pane to your shell; this prompt comes back when a tower run ends (wake the tower from any pi session with /boss tower <message>).",
	noTower: "the sb server has no tower for this workspace any more; this pane is yours.",
	silent: (why) => `the sb server does not answer (${why}); waiting for it.`,
	back: "the sb server answers again.",
	refused: (error) => `the tower did not take it: ${error}`,
	unknownCommand: (word) => `${word} is not a command here; this prompt takes /new (the next conversation is a new session), /quit (leave this pane to your shell), /wait (press a wait card) and messages; start a message that begins with / with a space.`,
	pickWord: "wait",
	pickWoke: "the tower woke: press the cards in the pane's running pi with /boss wait.",
	waitsNone: "no wait card is open for you now.",
	holding: " (they wait until you finish the cards)",
};
const ZH: Texts = {
	title: (label) => `塔台 · ${label}`,
	head: "主塔台",
	state: (a) => stateWord(a, { standing: "待命中", waking: "喚醒中", running: "執行中", closing: "收尾中", held: "已擱置" }, (n) => `${n} 則待處理`),
	hints: [
		{ keys: "⏎", plain: "Enter", text: "連同你輸入的訊息喚醒塔台；單按則不帶訊息" },
		{ keys: "/new", plain: "/new", text: "下一次對話成為新的工作階段" },
		{ keys: "/wait", plain: "/wait", text: "處理等你的卡片" },
		{ keys: "/quit ⌃D", plain: "/quit, Ctrl+D", text: "把這個窗格還給你的 shell" },
		{ keys: "/boss tower <訊息>", plain: "/boss tower <訊息>", text: "在任何 pi 工作階段喚醒塔台" },
	],
	waking: "正在喚醒塔台…",
	fresh: "下一次和塔台的對話會是新的工作階段。",
	leaving: "把這個窗格還給你的 shell；塔台的一次執行結束後，這個提示會回來（在任何 pi 工作階段用 /boss tower <訊息> 即可喚醒塔台）。",
	noTower: "sb 伺服器已不再為這個工作區執行塔台，這個窗格歸你了。",
	silent: (why) => `sb 伺服器沒有回應（${why}），等它回來。`,
	back: "sb 伺服器又回應了。",
	refused: (error) => `塔台沒有收下：${error}`,
	unknownCommand: (word) => `${word} 不是這裡的指令；這個提示只接受 /new（下一次對話成為新的工作階段）、/quit（把這個窗格還給你的 shell）、/wait（處理等你的卡片）和訊息；以 / 開頭的訊息請先打一個空格。`,
	pickWord: "等待",
	pickWoke: "塔台醒了，到執行中的窗格用 /boss wait 處理。",
	waitsNone: "目前沒有等你處理的卡片。",
	holding: "（等你回答完卡片）",
};

/** The state in words: what stands alone says it; a tower that waits with events says how many, and a running one adds them. A word this build does not know is shown as the server sent it. */
function stateWord(a: Pick<PollAnswer, "state" | "queued">, words: Record<string, string>, queued: (n: number) => string): string {
	const word = words[a.state] ?? String(a.state);
	if (a.queued <= 0) return word;
	return a.state === "standing" ? queued(a.queued) : `${word}, ${queued(a.queued)}`;
}

export const textsFor = (locale: Locale): Texts => (locale === "zh-TW" ? ZH : EN);
