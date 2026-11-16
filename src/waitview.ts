import { type Lang, memoryWords, tidy, type View, type ViewEntry, type ViewFrom } from "./memorycmd.ts";

// How a wait card reads in a terminal (docs/specs/2026-11-10-wait-cards-tui.md, §2 and §3): the words, a row of the list, the card as a block of lines, and the acts it offers by its kind and state. Pure: `/boss wait` (waitcmd.ts) draws them
// in pi's dialogs, and the tower prompt's picker (towerprompt/pick.ts) as numbered lines. Plain Node and no pi package, so the prompt's bundle can hold it.

/** The cards of a `boss-waits` answer, cleaned once more as `/boss memory` cleans what it prints, as rows in the order the server gave. */
export function rowsOf(towers: Tower[]): { tower: Tower; wait: ViewEntry }[] {
	// SAFETY: a `boss-waits` row is what `View` repeats (waitlist.ts); `tidy` cleans it.
	return towers.flatMap((t) => tidy({ rev: 0, entries: t.waits.map((x) => ({ ...x, kind: "wait" as const })), proposals: [] } as View).entries.map((wait) => ({ tower: { ...t, label: cleanLabel(t.label) }, wait })));
}
const cleanLabel = (label: unknown) => String(label ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "").slice(0, 200);

export interface Tower { workspace: string; label: string; head?: true; own?: true; waits: ViewEntry[]; problem?: string }
export interface Listed { auto: boolean; rows: { tower: Tower; wait: ViewEntry }[] }

export const WORDS = {
	en: {
		usage: "Usage: /boss wait [-w <workspace id | label | head>]",
		noUi: "/boss wait presses a card only in a pi session with a screen (a person at the keyboard): this one has none.",
		none: "No wait card is open for you.",
		title: (n: number) => `Waits for you (${n})`,
		needs: "Needs you: ", from: (who: string) => ` · from ${who}`, sep: " · ", parked: "[parked] ", replied: " (you replied)",
		ago: (ms: number) => (ms < 60_000 ? "just now" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} min ago` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} h ago` : `${Math.floor(ms / 86_400_000)} d ago`),
		tag: (label: string) => `[${label}] `,
		happened: "What happened", do: "What you do", where: "Where", run: "Run", after: "After that", secret: "Secret", raised: "Raised by", legacy: "An old free-text wait: it has no buttons.",
		stateParked: "Parked for your return.", stateReplied: "You replied; the tower has not resolved it yet.", statePressed: (what: string) => `Pressed: ${what}.`,
		done: "I'm done", skip: "Skip", back: "Back", next: "Next card", all: "All cards", restate: (tower: string) => `Ask ${tower} to rewrite it as a card`,
		secretStart: (name: string) => `Start entering (asks ${name} to open the entry box)`, secretDone: "I entered it",
		reply: (tower: string) => `Reply to ${tower}`, switchTo: (name: string) => `Switch to ${name}'s tab`,
		tower: "the tower", head: "the head tower", raiserFallback: "the raiser",
		autoSecret: "Start entering is off while auto mode is on: /boss auto off first.",
		reason: "Reason (optional)", skipTitle: "Skip this?", skipBody: (tower: string, who: string | undefined) => `${tower}${who ? ` and ${who}` : ""} will know you will not do this.`,
		replyTitle: (tower: string) => `Reply to ${tower}`, replied2: (tower: string, answered: string, id: string) => `Handed to ${tower}.${answered === id ? ` ${id} is marked answered.` : ` ${id} was not marked answered: the memory no longer has it as a wait for you.`}`,
		didSecret: (name: string) => `asked ${name} to open the entry box`,
		noWorkspace: "This session is not in a Herdr workspace: name one with -w <workspace id | label | head>.",
		noMatch: (q: string) => `No workspace matches "${q}".`, many: (q: string) => `"${q}" names more than one workspace; nothing was done: name the id.`,
		refused: (why: string) => `${why} (the list is read again)`,
		tabNone: (name: string) => `${name}'s tab was not found: it may have been closed or renamed.`, tabMany: (name: string) => `More than one tab looks like ${name}'s: nothing was switched.`,
	},
	"zh-TW": {
		usage: "用法：/boss wait [-w <workspace id | 名稱 | head>]",
		noUi: "/boss wait 只在有畫面的 pi session（有人在鍵盤前）裡按卡片：這個 session 沒有畫面。",
		none: "沒有等你處理的卡片。",
		title: (n: number) => `等你處理（${n}）`,
		needs: "需要你處理：", from: (who: string) => `・由 ${who}`, sep: "・", parked: "［已暫放］", replied: "（你已回覆）",
		ago: (ms: number) => (ms < 60_000 ? "剛剛" : ms < 3_600_000 ? `${Math.floor(ms / 60_000)} 分前` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)} 小時前` : `${Math.floor(ms / 86_400_000)} 天前`),
		tag: (label: string) => `［${label}］`,
		happened: "發生了什麼", do: "你要做的", where: "在哪裡", run: "指令", after: "做完之後", secret: "密鑰", raised: "提出者", legacy: "舊式的自由文字等待：沒有按鈕。",
		stateParked: "已暫放，等你回來。", stateReplied: "你已回覆，塔台還沒結案。", statePressed: (what: string) => `已按下：${what}。`,
		done: "我做完了", skip: "略過", back: "返回", next: "下一張", all: "全部卡片", restate: (tower: string) => `請${tower}重寫成卡片`,
		secretStart: (name: string) => `開始輸入（請 ${name} 開啟輸入框）`, secretDone: "我輸入好了",
		reply: (tower: string) => `回覆${tower}`, switchTo: (name: string) => `切到 ${name} 的分頁`,
		tower: "塔台", head: "主塔台", raiserFallback: "提出者",
		autoSecret: "自動模式開著時不能開始輸入密鑰：先 /boss auto off。",
		reason: "原因（選填）", skipTitle: "確定略過？", skipBody: (tower: string, who: string | undefined) => `${tower}${who ? `和 ${who}` : ""}會知道你不做這件事。`,
		replyTitle: (tower: string) => `回覆${tower}`, replied2: (tower: string, answered: string, id: string) => `已交給${tower}。${answered === id ? `${id} 已標為回覆。` : `${id} 沒有標為回覆：記憶裡已經沒有這個等你的等待。`}`,
		didSecret: (name: string) => `請 ${name} 開啟輸入框`,
		noWorkspace: "這個 session 不在任何 Herdr workspace 裡：用 -w <workspace id | 名稱 | head> 指定。",
		noMatch: (q: string) => `沒有符合「${q}」的 workspace。`, many: (q: string) => `「${q}」對到不只一個 workspace，什麼都沒做：請指明 id。`,
		refused: (why: string) => `${why}（清單已重新讀取）`,
		tabNone: (name: string) => `找不到 ${name} 的分頁：它可能已關閉或改名。`, tabMany: (name: string) => `不只一個分頁像是 ${name} 的：什麼都沒切換。`,
	},
};

export const raiserOf = (e: ViewEntry) => e.card?.from?.name;
/** A card the boss can still press: it carries no press that is the last word (a secret card's first step is not one). */
export const pending = (e: ViewEntry) => !(e.press && e.press.act !== "secret");
export const towerWord = (lang: Lang, t: Tower) => (t.head ? WORDS[lang].head : WORDS[lang].tower);

/** One row of the list: `［主塔台］需要你處理：<do>・由 <raiser>・12 分前`, with `［已暫放］` and `（你已回覆）` where they hold. */
export function rowText(lang: Lang, now: number, n: number, tower: Tower, e: ViewEntry): string {
	const w = WORDS[lang], ms = Math.max(0, now - Date.parse(e.at ?? ""));
	const who = raiserOf(e), replied = e.state === "answered" && !e.press;
	return `${n}. ${w.tag(tower.label)}${e.parked ? w.parked : ""}${w.needs}${e.card?.do ?? e.text}${who ? w.from(who) : ""}${Number.isFinite(ms) ? `${w.sep}${w.ago(ms)}` : ""}${replied ? w.replied : ""}`;
}

/** The card as the title of its second select: what happened, what you do, where, after that, who raised it. */
export function cardTitle(lang: Lang, auto: boolean, tower: Tower, e: ViewEntry): string {
	const w = WORDS[lang], c = e.card, line = (k: string, v: string) => `${k}: ${v}`;
	const state = e.press && e.press.act !== "secret" ? [w.statePressed(pressedWord(lang, e))] : e.state === "answered" ? [w.stateReplied] : [];
	const head = `${w.tag(tower.label).trim()} ${e.id}${e.parked ? ` ${w.parked.trim()}` : ""}`;
	if (!c) return [head, e.text, w.legacy, ...state].join("\n");
	return [
		head, ...(c.happened ? [line(w.happened, c.happened)] : []), line(w.do, c.do), ...(c.url ? [line(w.where, c.url)] : []),
		...(c.command ? [`${w.run}:`, ...c.command.split("\n").map((l) => `  ${l}`)] : []), ...(c.after ? [line(w.after, c.after)] : []), ...(c.secret ? [line(w.secret, c.secret.name)] : []),
		...(c.options ?? []).map((o, i) => `${i + 1}) ${o.label} — ${o.then}`), ...(c.from ? [line(w.raised, c.from.name)] : []),
		...(e.parked ? [w.stateParked] : []), ...state, ...(auto && c.type === "secret" && !e.press?.secretAsked ? [w.autoSecret] : []),
	].join("\n");
}
/** What the press on a card says it did: the option chosen, done, declined, or restated. */
export function pressedWord(lang: Lang, e: ViewEntry): string {
	const m = memoryWords(lang), p = e.press!;
	return p.act === "choose" ? m.didChose(e.card?.options?.[p.option ?? -1]?.label ?? "?") : p.act === "decline" ? m.didDecline : p.act === "restate" ? m.didRestate : m.didDone;
}

export type Act = { kind: "press"; json: Record<string, unknown>; what: string } | { kind: "skip" } | { kind: "reply" } | { kind: "switch"; from: ViewFrom } | { kind: "next" } | { kind: "back" };
/** Where a card's dialog leads besides its own acts: `next` adds the way to the next card that waits, `all` names the way back as the list of all cards, and `ask` (sb drew the card for an agent, waitask.ts) leaves only the card's own acts and the reply. */
export interface Nav { next?: boolean; all?: boolean; ask?: boolean }
/** The acts the card offers, by its kind and state (the table of §2): a card already pressed keeps only the reply, the switch, and the way back. */
export function actsOf(lang: Lang, auto: boolean, tower: Tower, e: ViewEntry, nav: Nav = {}): { label: string; act: Act }[] {
	const w = WORDS[lang], m = memoryWords(lang), c = e.card, who = c?.from?.name ?? w.raiserFallback, tw = towerWord(lang, tower);
	const pressed = e.press !== undefined && e.press.act !== "secret";
	const press = (label: string, json: Record<string, unknown>, what: string) => ({ label, act: { kind: "press" as const, json: { op: "press", id: e.id, ...json }, what } });
	const own: { label: string; act: Act }[] = [];
	if (!pressed) {
		if (!c) own.push(press(w.restate(tw), { act: "restate" }, m.didRestate));
		else if (c.type === "choice") (c.options ?? []).forEach((o, i) => own.push(press(`${i + 1}) ${o.label} — ${o.then}`, { act: "choose", option: i }, m.didChose(o.label))));
		else if (c.type === "secret") {
			if (e.press?.secretAsked) own.push(press(w.secretDone, { act: "done" }, m.didDone));
			else if (!auto) own.push(press(w.secretStart(who), { act: "secret" }, w.didSecret(who)));
		} else own.push(press(w.done, { act: "done" }, m.didDone));
		own.push({ label: w.skip, act: { kind: "skip" } });
	}
	const there = c?.from?.tab && !c.from.gone && !nav.ask ? c.from : undefined;
	return [...own, { label: w.reply(tw), act: { kind: "reply" } }, ...(there ? [{ label: w.switchTo(who), act: { kind: "switch" as const, from: there } }] : []), ...(nav.next ? [{ label: w.next, act: { kind: "next" as const } }] : []), ...(nav.ask ? [] : [{ label: nav.all ? w.all : w.back, act: { kind: "back" as const } }])];
}
