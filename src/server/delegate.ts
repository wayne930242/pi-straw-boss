import type { Locale } from "../locale.ts";
import { cut } from "./towermemory.ts";
import type { Card, Raiser } from "./waitcard.ts";

// The boss's delegate (docs/specs/2026-11-21-box-mac-waits.md §15, D14; boss: 「每次無人塔台幹嘛我都要核准，也太煩了吧，你不能幫我核准嗎」, 「代理人什麼都能核准，除非他覺得應該問我」): the words and rules the wait router (linkwaits.ts) uses when a card
// that would go to this device's boss's list goes to the delegate device's main first. What the delegate answers is a teammate's data: it reaches the tower as a server notice marked as the delegate's words, never as the
// boss's press or message, and a card the delegate does not approve goes to the boss's list as it would have, with the reason on it.

/** How long the delegate device has to say a main there has it (`told`) before the card goes to the boss's list. */
export const DELEGATE_TAKE_MS = 10 * 60_000;
/** The trust the delegate needs on this device: the level at which a teammate's turns run as local ones, and at which it may answer this device's questions for the boss (holder.ts `takeDialogAnswer`, `takeUnitStop`). */
export const DELEGATE_LEVEL = "dispatch";
/** The raisers whose cards stay the boss's (a strict train target's auth or approval comes from them), by the kind of their pane (unitstop.ts `kindOfPane`). */
export const BOSS_ONLY_KINDS: ReadonlySet<string> = new Set(["train", "integrator"]);
/** What a router keeps of a card it sent the delegate: the tower's card, its run and raiser and due, to raise it as it was; or the router's own wait whose card it was. */
export type Approval = { origin: "tower"; run: string; card: Omit<Card, "from">; from?: Raiser; dueMin?: number } | { origin: "router"; n: number };
/** The words a delegate's answer is shown in: cleaned to one line, as a card's text is. */
export const DELEGATE_WORDS = 120, NOTICE_WORDS = 300;

/** Why a card was not sent to the delegate or came back, in the card's language; the card's own text comes first and this follows it. */
export const NOTES = {
	en: {
		roster: (short: string) => `Not sent to the boss's delegate: ${short} is not a teammate device of this workspace's team.`,
		loop: (label: string) => `Not sent to the boss's delegate: the wait is ${label}'s own.`,
		trust: (label: string, level: string) => `Not sent to the boss's delegate: ${label} is at ${level} on this computer, and a delegate needs dispatch.`,
		caps: (label: string) => `Not sent to the boss's delegate: ${label} runs an older build or has not been heard from for 2 hours.`,
		send: (label: string, error: string) => `Not sent to the boss's delegate: the message to ${label} failed (${error}).`,
		timeout: (label: string) => `The boss's delegate on ${label} did not take it within 10 minutes.`,
		escalated: (who: string, words: string) => `The boss's delegate (${who}) asks you to decide: «${words}».`,
		declined: (who: string, words: string) => `The boss's delegate (${who}) would not approve it: «${words}».`,
		trustNow: (who: string, label: string) => `The boss's delegate (${who}) answered, but ${label} is no longer at dispatch here, so its answer does not count.`,
		withdrawn: (label: string) => `The boss's delegate on ${label} withdrew it.`,
		expired: (label: string) => `The boss's delegate on ${label} did not answer within 7 days.`,
	},
	"zh-TW": {
		roster: (short: string) => `沒有交給代理人：${short} 不是這個工作區團隊的隊友裝置。`,
		loop: (label: string) => `沒有交給代理人：這是 ${label} 自己的等待。`,
		trust: (label: string, level: string) => `沒有交給代理人：${label} 在這台電腦的信任是 ${level}，代理人需要 dispatch。`,
		caps: (label: string) => `沒有交給代理人：${label} 的版本較舊，或已兩小時沒有消息。`,
		send: (label: string, error: string) => `沒有交給代理人：送給 ${label} 的訊息失敗（${error}）。`,
		timeout: (label: string) => `${label} 的代理人 10 分鐘內沒有接手。`,
		escalated: (who: string, words: string) => `代理人（${who}）請你決定：「${words}」。`,
		declined: (who: string, words: string) => `代理人（${who}）不核准：「${words}」。`,
		trustNow: (who: string, label: string) => `代理人（${who}）回覆了，但 ${label} 在這裡已不是 dispatch，所以它的回覆不算數。`,
		withdrawn: (label: string) => `${label} 的代理人撤回了。`,
		expired: (label: string) => `${label} 的代理人 7 天內沒有回覆。`,
	},
} as const satisfies Record<Locale, Record<string, (...args: string[]) => string>>;
export type Note = (lang: Locale) => string;

/**
 * The card as the delegate reads it (D11): every field the boss would have seen, under labels the code writes, and who raised it. The fields are the tower's (or the router's) words; the delegate's `board_read` shows them as
 * a teammate's data. A command keeps its lines, indented.
 */
export function approvalText(self: string, card: Pick<Card, "type" | "happened" | "do"> & Partial<Card>, from: Raiser | undefined, by: "tower" | "router"): string {
	const rows = [
		`A card for the boss of ${self}, as its ${by === "tower" ? "tower" : "wait router"} wrote it; you decide it as the boss's delegate:`,
		`type: ${card.type}`, `happened: ${card.happened}`, `do: ${card.do}`,
		...(card.url ? [`url: ${card.url}`] : []), ...(card.command ? [`command: ${card.command.replace(/\n/g, "\n  ")}`] : []), ...(card.after ? [`after: ${card.after}`] : []),
		...(card.options ?? []).map((o, i) => `option ${i + 1}: ${o.label}: ${o.then}`),
		by === "router" ? "" : `raised by: ${from ? `${from.name} (${from.role}${from.workspace ? `, ${from.workspace}` : ""}${from.tab ? ` / ${from.tab}` : ""})` : "the tower itself"}`,
	];
	return rows.filter(Boolean).join("\n");
}
/** The delegate's words as a card or a notice quotes them. */
export const quoteOf = (words: string, max: number) => cut(words, max);
