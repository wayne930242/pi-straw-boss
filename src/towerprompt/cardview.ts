import { memoryWords, type ViewEntry } from "../memorycmd.ts";
import { actsOf, rowsOf, type Tower, towerWord, WORDS } from "../waitview.ts";
import type { Kind } from "./look.ts";
import type { Locale } from "./messages.ts";
import type { PickSource } from "./source.ts";
import { plain } from "./waitblock.ts";

// The card view of the tower prompt (docs/specs/2026-11-16-wait-cards-flow.md, A): on a terminal that reports keys, the open wait cards are drawn one after another under the state line, with no command typed, and the boss answers each with the
// arrows or a digit (which mark a row) and Enter (which presses the marked row), as `ask_user_question` is answered. After a press the next card is drawn; left and right go to another card without pressing; Esc gives the keys back to the message
// line. This file holds what is shown and what a key does; prompt.ts owns the terminal (which keys reach the view, the rows drawn in place, the line of a field) and pick.ts stays the numbered picker where keys are not reported.
// What may be pressed is the server's to say, as for the picker: the presses are `tower-memory { op: "press" }` and the replies the composer's route, asked with the state folder's secret. Only a single typed key presses: prompt.ts hands a key
// over only when its read was one key and no paste is open, and a paste that reaches a marked row or the confirm ends the view with nothing pressed. The here mark (heremark.ts) opens at the first card key and not when a card is drawn, so a
// paired phone's key pad keeps writing to the tower while the boss has not touched the cards; from that key until the boss is done (the last card, Esc, a message, `QUIET_MS` without a card key) the view is engaged: the mark is held and the
// polls say `answering`, which holds the tower's wake (runs.ts). Plain Node and no pi package, like the rest of towerprompt/; every text of a card is cleaned again before it is written.

/** Without a card key for this long the boss is no longer answering: the polls stop saying so and the pane's mark is dropped. The card stays, and the next card key engages again. */
export const QUIET_MS = 60_000;

const VIEW = {
	en: {
		head: (i: number, n: number) => `Waits for you ${i}/${n}`, type: { action: "action", choice: "choice", secret: "secret", legacy: "old" } as Record<string, string>, from: (who: string) => `from ${who}`, parked: "parked",
		keys: (many: boolean, ascii: boolean) => (ascii ? `Up/Down or 1-9 marks, Enter sends${many ? ", Left/Right other card" : ""}, Esc: message line` : `↑↓ or a number marks · Enter sends${many ? " · ←→ other card" : ""} · Esc: message line`),
		released: "the keys are the message line's; /wait brings the cards back",
		reason: "Reason for skipping (optional): Enter goes on, Esc cancels", confirm: (body: string) => `Skip this? ${body} Enter confirms, Esc cancels`, reply: (tower: string) => `Reply to ${tower}: Enter sends, an empty line or Esc cancels`,
		fields: { reason: "reason", confirm: "skip", reply: "reply" },
		elsewhere: (id: string) => `${id} was answered elsewhere.`, left: "No wait card is left for you.", pasted: "a paste is not a pick; nothing was pressed", read: (why: string) => `The cards could not be read: ${why}`,
		markRefused: (why: string) => `The cards need this pane marked as local-only, and it could not be (${why}); nothing was pressed. /wait tries again.`,
	},
	"zh-TW": {
		head: (i: number, n: number) => `等你處理 ${i}/${n}`, type: { action: "動作", choice: "選擇", secret: "密鑰", legacy: "舊式" } as Record<string, string>, from: (who: string) => `由 ${who}`, parked: "已暫放",
		keys: (many: boolean, ascii: boolean) => (ascii ? `Up/Down 或數字選擇, Enter 送出${many ? ", Left/Right 換張" : ""}, Esc 回到輸入列` : `↑↓ 或數字選擇 · Enter 送出${many ? " · ←→ 換張" : ""} · Esc 回到輸入列`),
		released: "按鍵回到輸入列；/wait 可回到卡片",
		reason: "略過的原因（選填）：Enter 繼續，Esc 取消", confirm: (body: string) => `確定略過？${body}Enter 確定略過，Esc 取消`, reply: (tower: string) => `回覆${tower}：Enter 送出，空行或 Esc 取消`,
		fields: { reason: "原因", confirm: "略過", reply: "回覆" },
		elsewhere: (id: string) => `${id} 已在別處處理。`, left: "沒有等你處理的卡片了。", pasted: "貼上的文字不算選擇，沒有按下任何東西", read: (why: string) => `讀不到卡片：${why}`,
		markRefused: (why: string) => `卡片需要把這個窗格標成只有本機能操作，但標不起來（${why}）；沒有按下任何東西。/wait 可再試一次。`,
	},
};
/** The English words of the fields' prompts, for a look that draws nothing outside ASCII. */
const FIELD_PLAIN = VIEW.en.fields;

/** East Asian Wide and Fullwidth characters (UAX #11), as first and last of each range: one of them takes two columns. The prompt's bundle cannot hold pi-tui's width function, so the table is here. */
const WIDE = [0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615, 0x2648, 0x2653, 0x267f, 0x267f, 0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c, 0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55, 0x2e80, 0x303e, 0x3041, 0x33ff, 0x3400, 0x4dbf, 0x4e00, 0xa4cf, 0xa960, 0xa97f, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe6f, 0xff01, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x18aff, 0x1b000, 0x1b2ff, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f251, 0x1f300, 0x1f64f, 0x1f680, 0x1f6ff, 0x1f900, 0x1f9ff, 0x1fa70, 0x1faff, 0x20000, 0x3fffd];
/** Characters that take no column: combining marks, variation selectors, the joiner. */
const ZERO = [0x0300, 0x036f, 0x1ab0, 0x1aff, 0x1dc0, 0x1dff, 0x200d, 0x200d, 0x20d0, 0x20ff, 0xfe00, 0xfe0f, 0xfe20, 0xfe2f, 0xe0100, 0xe01ef];
const within = (ranges: number[], code: number) => {
	for (let i = 0; i < ranges.length; i += 2) if (code >= ranges[i]! && code <= ranges[i + 1]!) return true;
	return false;
};
/** How many terminal columns a text takes. */
export function cellsOf(text: string): number {
	let n = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0)!;
		n += within(ZERO, code) ? 0 : within(WIDE, code) ? 2 : 1;
	}
	return n;
}
/** The text cut to `max` columns, an ellipsis in the last when it was longer: a row that wrapped could not be drawn again in place. */
export function fit(text: string, max: number): string {
	if (cellsOf(text) <= max) return text;
	let kept = "", n = 0;
	for (const ch of text) {
		const w = cellsOf(ch);
		if (n + w > max - 1) break;
		kept += ch;
		n += w;
	}
	return `${kept}…`;
}

/** What the view draws on and asks of the prompt. */
export interface ViewIo {
	source: PickSource;
	locale: Locale;
	/** The look: nothing outside ASCII, the mark of the marked row, and the style of a row. */
	ascii: boolean;
	pointer: string;
	paint(text: string, kind: "marked" | "plain" | "hint"): string;
	/** One line of its own; a plain one carries no glyph. */
	say(line: string, kind?: Kind | "plain"): void;
	/** The rows under the card (its acts and the key hint), each one terminal line: drawn over the rows it drew last while they still stand right above the message line, else as new lines. */
	rows(lines: string[]): void;
	/** The rows drawn last are of a card that is no longer the one shown: what is said next comes under them, and the next rows are new lines. */
	fresh(): void;
	/** A field has the message line (the word of its prompt, and its ASCII twin); none: the message line is the boss's again, and what a field left on it is dropped. */
	field(prompt?: { word: string; plain: string }): void;
	/** The boss is no longer answering: the next poll says so at once, and does not wait for its turn. */
	idle(): void;
	now(): number;
	/** The terminal's width. */
	columns(): number;
}
type Row = { tower: Tower; wait: ViewEntry };
type Step = "card" | "reason" | "confirm" | "reply";
/** Controls and invisible formatting characters out of a line; a card's own line breaks make lines of their own. */
const safe = (text: string): string[] => text.split("\n").map((l) => plain(l, 4000));
const keyOf = (r: Row) => `${r.tower.workspace}\n${r.wait.id}`;
/** A card the boss has still to answer: open, and not pressed (a secret's first step is no answer yet). A card they replied to waits for the tower. */
const pending = (w: ViewEntry) => w.state !== "answered" && (!w.press || w.press.act === "secret");
const CARD_KEYS = ["up", "down", "left", "right", "escape"];

export function createCardView(io: ViewIo) {
	const w = VIEW[io.locale], v = WORDS[io.locale], m = memoryWords(io.locale), source = io.source;
	let rows: Row[] = [], auto = false, at = 0, mark: number | undefined, step: Step = "card", reason = "";
	/** The card on screen (its key), and its state as drawn (a press changes its acts); none: the view shows no card. */
	let cur: string | undefined, drawn = "";
	/** The device has no boss at it: a card is shown only when `/wait` asks. And the keys are the message line's (Esc, a paste, a refused mark, or such a device) until `/wait`. */
	let manual = false, released = false;
	/** The boss is at the cards: the pane's mark is open (`release` drops it), since the last card key at `lastKey`. */
	let engaged = false, lastKey = -Infinity, release: (() => void) | undefined, closed: Promise<unknown> | undefined;
	/** A press or a reply is on its way; cards this view answered leave the list without the line that says so. */
	let sending = false;
	/** The pane's mark is being opened for the first card key: an Enter that comes meanwhile was typed before the pane was this computer's alone, and presses nothing (as the picker drops the lines typed while it starts). */
	let opening = false;
	const settled = new Set<string>();
	let busy: Promise<unknown> = Promise.resolve();
	/** One operation at a time, in the order the keys came. */
	const run = <T>(fn: () => Promise<T>, otherwise: T): Promise<T> => {
		const next = busy.then(fn).catch((cause: Error) => (out(cause.message, "bad"), otherwise));
		busy = next;
		return next;
	};
	const out = (text: string, kind: Kind | "plain" = "plain") => void safe(text).forEach((line, i) => io.say(line, i === 0 ? kind : "plain"));
	const row = () => (cur === undefined ? undefined : rows[at]);
	const acts = (r: Row) => actsOf(io.locale, auto, r.tower, r.wait).filter((a) => a.act.kind === "press" || a.act.kind === "skip" || a.act.kind === "reply");
	const stateOf = (r: Row) => `${keyOf(r)}\n${r.wait.press?.act ?? ""}\n${auto}`;

	/** The rows under the card: its acts, numbered, the marked one pointed at, and the keys. */
	const region = (): string[] => {
		const r = row();
		if (!r) return [];
		const max = Math.max(20, io.columns() - 2);
		const list = acts(r).map((a, i) => io.paint(fit(`  ${i === mark ? io.pointer : " "} ${i + 1}. ${plain(a.label, 400)}`, max), i === mark ? "marked" : "plain"));
		return [...list, io.paint(fit(`  ${released ? w.released : w.keys(rows.length > 1, io.ascii)}`, max), "hint")];
	};
	/** A card drawn as the one on screen: its place among the cards, who raised it and when, what it says, then its rows with none marked. */
	const show = (i: number) => {
		at = i;
		const r = rows[i]!, c = r.wait.card, ms = Math.max(0, io.now() - Date.parse(r.wait.at ?? ""));
		cur = keyOf(r);
		drawn = stateOf(r);
		mark = undefined;
		dropField();
		io.fresh();
		const head = [w.head(i + 1, rows.length), `${v.tag(r.tower.label).trim()} ${r.wait.id} ${w.type[c?.type ?? "legacy"] ?? c?.type}`, ...(c?.from?.name ? [w.from(c.from.name)] : []), ...(Number.isFinite(ms) ? [v.ago(ms)] : []), ...(r.wait.parked ? [w.parked] : [])];
		const line = (k: string, value: string) => `  ${k}: ${value}`;
		const body = !c ? [`  ${r.wait.text}`, `  ${v.legacy}`] : [
			...(c.happened ? [line(v.happened, c.happened)] : []), line(v.do, c.do), ...(c.url ? [line(v.where, c.url)] : []), ...(c.command ? [`  ${v.run}:`, ...c.command.split("\n").map((l) => `    ${l}`)] : []),
			...(c.after ? [line(v.after, c.after)] : []), ...(c.secret ? [line(v.secret, c.secret.name)] : []), ...(auto && c.type === "secret" && !r.wait.press?.secretAsked ? [`  ${v.autoSecret}`] : []),
		];
		out(head.join(" · "), "ask");
		for (const l of body) out(l);
		io.rows(region());
	};
	/** The field, if one has the line, gives it back: the card's own step again. */
	function dropField() {
		if (step === "card") return;
		step = "card";
		reason = "";
		io.field();
	}
	/** The boss is at the cards: the pane is marked for this computer's keys before any key of theirs counts. False when it cannot be marked: the view lets go, and says so. */
	const engage = async (): Promise<boolean> => {
		if (engaged) return true;
		const held = new Promise<void>((resolve) => (release = resolve));
		try {
			await new Promise<void>((ok, bad) => void (closed = source.here(() => (ok(), held)).catch(bad)));
		} catch (cause) {
			release = undefined;
			closed = undefined;
			released = true;
			out(w.markRefused((cause as Error).message), "bad");
			io.rows(region());
			return false;
		}
		engaged = true;
		return true;
	};
	/** The boss is done with the cards for now: the mark is dropped and the polls stop saying they answer. */
	const disengage = async () => {
		if (!engaged) return;
		engaged = false;
		release?.();
		release = undefined;
		await closed?.catch(() => {});
		closed = undefined;
		io.idle();
	};
	/** The view shows no card any more. */
	const close = async (line?: string) => {
		cur = undefined;
		rows = [];
		mark = undefined;
		dropField();
		io.fresh();
		released = manual;
		if (line) out(line, "info");
		await disengage();
	};
	/** The keys go back to the message line (Esc, a paste, a mark that could not be opened); the card stays on screen, and `/wait` brings the view back. */
	const letGo = async (line?: string) => {
		released = true;
		mark = undefined;
		dropField();
		if (line) out(line, "warn");
		await disengage();
		io.rows(region());
	};
	/**
	 * The cards read again, and the screen made to follow: nothing shown and a card of this pane's own tower open (or `open`: `/wait` asked), the first card is drawn; the card on screen gone from the list, the line that says so (unless this
	 * view answered it) and the next; its state changed (a secret's first step), the card again; else nothing is drawn.
	 */
	const sync = async (open = false) => {
		let next: Row[];
		try {
			const got = await source.waits();
			auto = got.auto;
			next = rowsOf(got.towers).filter((r) => pending(r.wait));
		} catch (cause) {
			// What is shown stays, and the next poll reads again; `/wait` is told.
			if (open) out(w.read((cause as Error).message), "bad");
			return;
		}
		const was = cur;
		rows = next;
		if (was === undefined) {
			if (!open && (manual || released || !rows.some((r) => r.tower.own))) return void (rows = []);
			if (!rows.length) return void (open ? out(v.none, "info") : undefined);
			return show(0);
		}
		const i = rows.findIndex((r) => keyOf(r) === was);
		if (i >= 0) return stateOf(rows[i]!) === drawn ? void (at = i) : show(i);
		io.fresh();
		if (!settled.has(was)) out(w.elsewhere(was.split("\n")[1]!), "info");
		if (!rows.length) return close(w.left);
		show(at >= rows.length ? 0 : at);
	};
	/** A press of the card on screen: the server's answer as a line, then the list again (the next card; or the same one, when the server still lists it: after a refusal that card is passed). */
	const send = async (r: Row, what: () => Promise<string>) => {
		const key = keyOf(r);
		sending = true;
		let refused = false;
		try {
			out(await what(), "ok");
		} catch (cause) {
			refused = true;
			out((cause as Error).message, "bad");
		}
		settled.add(key);
		lastKey = io.now();
		await sync();
		sending = false;
		if (refused && cur === key) rows.length > 1 ? show((at + 1) % rows.length) : ((mark = undefined), io.rows(region()));
	};
	const press = (r: Row, json: Record<string, unknown>, what: string) => send(r, async () => {
		const got = await source.press(r.tower.workspace, json);
		if (got.status !== 200) throw new Error(String(got.body?.reason ?? got.body?.error ?? got.status));
		const name = r.wait.card?.from?.name ?? "", status = (got.body?.press as { main?: { status: string } } | undefined)?.main?.status;
		return m.pressed(r.wait.id, what, !name || !status ? "" : status === "delivered" || status === "queued" ? m.told(name) : m.notReached(name, status));
	});
	/** A field takes the message line: its hint as a line, its word as the prompt. */
	const ask = (next: Exclude<Step, "card">, hint: string) => {
		step = next;
		out(hint, "ask");
		io.field({ word: w.fields[next], plain: FIELD_PLAIN[next] });
	};
	/** Back from a field to the card's rows, with none marked. */
	const back = () => {
		dropField();
		mark = undefined;
		io.rows(region());
	};

	return {
		/** Whether the view shows the cards itself (it has a card on screen and the keys, or would draw one on its own); else the prompt prints the block of the digest, as where keys are not reported. */
		shows: () => !released && (cur !== undefined || !manual),
		/** Whether the boss is at the cards (the mark is open): what is on the line is then never their words to the tower. */
		engaged: () => engaged,
		/** A field has the message line: its keys are text, and Esc and Enter are the view's. */
		field: () => cur !== undefined && step !== "card",
		/** Whether this key, typed alone on an empty message line, is the view's: an arrow, Esc, or the number of a row. */
		takes(name: string): boolean {
			const r = row();
			if (!r || released || step !== "card") return false;
			return CARD_KEYS.includes(name) || (/^[1-9]$/.test(name) && Number(name) <= acts(r).length);
		},
		/** A card key: an arrow or a digit marks a row (the first one opens the pane's mark), left and right draw another card, Esc gives the keys back. Nothing here presses. */
		key(name: string) {
			if (!engaged && name !== "escape") opening = true;
			return run(async () => {
				try {
					if (!row() || released || step !== "card") return;
					if (name === "escape") return await letGo();
					if (!(await engage())) return;
				} finally {
					opening = false;
				}
				// The card may be another one than when the key came (the list is read while the mark opens): the key counts for the card on screen, and a number it has no row for is no key.
				const r = row();
				if (!r) return;
				lastKey = io.now();
				const n = acts(r).length;
				if (name === "left" || name === "right") return rows.length > 1 ? show((at + (name === "right" ? 1 : rows.length - 1)) % rows.length) : undefined;
				if (/^\d$/.test(name) && Number(name) > n) return;
				mark = name === "up" ? ((mark ?? n) + n - 1) % n : name === "down" ? ((mark ?? -1) + 1) % n : Number(name) - 1;
				io.rows(region());
			}, undefined);
		},
		/** The pane's mark is being opened: an Enter that arrives now is told to `entered` as `early`. */
		opening: () => opening,
		/** A key in a field: the boss is still answering. */
		touch() {
			lastKey = io.now();
		},
		/** Esc in a field: back to the card, nothing pressed. */
		escape: () => run(async () => void (step !== "card" && back()), undefined),
		/** A typed key left text on the message line while a card had the keys: the boss is writing to the tower, so the mark of a row goes and the view is no longer engaged. (Pasted text leaves the mark: its Enter then ends the view, `entered`.) */
		typed: () => (cur !== undefined && step === "card" && (engaged || mark !== undefined) ? run(async () => {
			if (step !== "card") return;
			mark = undefined;
			await disengage();
			io.rows(region());
		}, undefined) : undefined),
		/**
		 * Enter: what was entered (`lines`, more than one or `pasted` for a paste). True when it was the view's: a marked row is pressed (or its field opened), a field's text is taken. False when it is the message line's: no card has the
		 * keys, or no row is marked (an empty Enter then wakes the tower, as ever). An Enter that came while a press was on its way, or while the pane's mark was still opening (`early`), is dropped: it is no press and no wake.
		 */
		entered(lines: string[], pasted: boolean, early = false): Promise<boolean> {
			const during = sending || early;
			return run(async (): Promise<boolean> => {
				const r = row();
				if (!r || released) return false;
				const text = lines.join("\n").trim();
				if (step === "card") {
					if (during) return true;
					if (mark === undefined || !engaged) return false;
					// Only a typed Enter presses: a paste that reaches a marked row ends the view.
					if (pasted || text !== "") return letGo(w.pasted).then(() => true);
					const act = acts(r)[mark]?.act;
					if (!act) return false;
					lastKey = io.now();
					if (act.kind === "press") await press(r, act.json, act.what);
					else if (act.kind === "skip") ask("reason", w.reason);
					else if (act.kind === "reply") ask("reply", w.reply(towerWord(io.locale, r.tower)));
					return true;
				}
				lastKey = io.now();
				if (step === "reason") {
					reason = lines.map((l) => l.trim()).filter(Boolean).join(" ");
					ask("confirm", w.confirm(v.skipBody(towerWord(io.locale, r.tower), r.wait.card?.from?.name)));
				} else if (step === "confirm") {
					if (pasted) return letGo(w.pasted).then(() => true);
					const why = reason;
					if (text !== "" && !/^y(es)?$/i.test(text)) return (back(), true);
					dropField();
					await press(r, { op: "press", id: r.wait.id, act: "decline", ...(why ? { reason: why } : {}) }, m.didDecline);
				} else if (text === "") back();
				else {
					dropField();
					await send(r, async () => v.replied2(towerWord(io.locale, r.tower), (await source.reply(r.tower, text, r.wait.id)).answered ?? "", r.wait.id));
				}
				return true;
			}, true);
		},
		/** The device has no boss at it (the poll says so): no card is shown on its own. */
		attend(attended: boolean) {
			manual = !attended;
			if (manual && cur === undefined) released = true;
		},
		/** The digest of a poll changed, or the boss is answering: the cards are read again. */
		sync: () => run(() => sync(), undefined),
		/** `/wait`: the view takes the keys again, from the first card. */
		focus: () => run(async () => {
			released = false;
			cur = undefined;
			io.fresh();
			await sync(true);
			// No card to show: the keys stay the message line's, and a mark that was open is dropped.
			if (cur === undefined) (released = manual), await disengage();
		}, undefined),
		/**
		 * Whether the boss is answering, for the poll: at the cards, with a card key in the last `QUIET_MS`. Past that the view is no longer engaged (the mark is dropped, a field and a mark with it), and the next card key engages again.
		 */
		answering(): boolean {
			if (!engaged) return false;
			if (io.now() - lastKey <= QUIET_MS) return true;
			void run(async () => {
				if (!engaged || io.now() - lastKey <= QUIET_MS) return;
				mark = undefined;
				dropField();
				await disengage();
				io.rows(region());
			}, undefined);
			return false;
		},
		/** The prompt posts the boss's words: they are no longer at the cards. */
		wrote: () => run(async () => {
			if (!engaged && mark === undefined) return;
			mark = undefined;
			await disengage();
		}, undefined),
		/** The view ends without a word (the prompt leaves, or a run starts): the mark is dropped. */
		stop: () => run(async () => {
			cur = undefined;
			rows = [];
			step = "card";
			await disengage();
		}, undefined),
		/** An operation that is under way (a press whose answer is not in yet) is waited for, so its result is printed before the prompt leaves. */
		whenIdle: () => busy,
	};
}
export type CardView = ReturnType<typeof createCardView>;
