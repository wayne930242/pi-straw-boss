import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { every } from "./lanface.ts";
import { AUTO_NOTE } from "./moments.ts";
import { type Got, hubRelay } from "./bossrelay.ts";
import type { Bus } from "./owners.ts";
import type { Kit } from "./state.ts";
import { todosOfBranch } from "./todo.ts";
import { callServer } from "./traincar.ts";
import { type AskClient, askClient, type AskState, gotOf, repliesOf } from "./askclient.ts";

// A decision only the boss can make, asked by code (docs/specs/2026-11-25-idle-wrap-up.md part 2; boss 2026-11-25: 「「自己問我」應該做成程式碼，直接從程式碼發出」). `call_tower` with `why: blocked` and `boss`
// draws the question in this main's own pane with pi's dialog (a select with the options and a typed answer, or an input), so Herdr shows the pane waiting and the GUI relays the select as any dialog; the answer is the tool's
// result and nothing goes to the tower. Under auto mode, in a teammate's turn, on an unattended device, without a terminal, and for any session that is no tab's main (a member, a train, a tower), nothing is drawn:
// the question goes to the tower as `blocked`, as before 0.91.0. A dialog open when auto mode starts is ended here, and the question goes to the tower: the watch looks at auto.json more often than auto mode's
// own transition does, so the dialog is usually gone before that transition would cancel it (auto.ts leaves a cancelled `call_tower` its own result).
// The question is a blocking Ask of the sb server (docs/specs/2026-11-28-boss-asks.md): the store decides which answer won, the pane's, the page's or the phone's, and the others close. No server: asked as before, unrecorded.

/** `item`: the id of the asker's todo the question blocks (else its todo in progress). */
export interface BossQuestion { question: string; options?: string[]; item?: number }
const QUESTION_MAX = 500, OPTION_MAX = 120, OPTIONS_MAX = 8, WATCH_MS = 500, LOOK_MS = 1000;
/** The select's last row: the boss types his own answer instead. */
export const OWN_ANSWER = "Type another answer…";
/** No descriptions: `call_tower`'s own clause names it, and the limits are checked here (a tool's size is paid on every turn: tests/tools-budget.test.ts). */
export const bossParameter = () => Type.Optional(Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())), item: Type.Optional(Type.Integer()) }));

/** The question checked and folded: one line each, the options without blanks or repeats. */
export function bossOf(raw: BossQuestion): BossQuestion {
	const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
	const question = line(raw.question);
	if (!question || question.length > QUESTION_MAX) throw new Error(`boss.question is required: one question of 1 to ${QUESTION_MAX} characters`);
	const options = [...new Set((raw.options ?? []).map(line).filter((o) => o && o !== OWN_ANSWER))];
	if (options.length > OPTIONS_MAX || options.some((o) => o.length > OPTION_MAX)) throw new Error(`boss.options: at most ${OPTIONS_MAX}, each at most ${OPTION_MAX} characters`);
	if (raw.item !== undefined && !(Number.isSafeInteger(raw.item) && raw.item > 0)) throw new Error("boss.item is the id of your todo the question blocks");
	return { question, ...(options.length ? { options } : {}), ...(raw.item ? { item: raw.item } : {}) };
}
/** What the tower gets when the boss is not asked here: the message, then the question and its options. */
export const withBoss = (message: string, q: BossQuestion) => `${message}\nFor the boss: ${q.question}${q.options ? `\nOptions: ${q.options.join(" | ")}` : ""}`;

/** `unconfirmed`: an answer the store, once the Ask was open, never confirmed as the first: not the boss's decision to act on (asks-r2-F002). */
export type Asked = { kind: "answered"; text: string } | { kind: "unconfirmed"; text: string } | { kind: "none"; text: string } | { kind: "tower"; note?: string };
export type BossAsk = (q: BossQuestion, signal: AbortSignal | undefined, ctx: Pick<ExtensionContext, "hasUI" | "ui"> | undefined, callId?: string) => Promise<Asked>;
type Opts = { signal: AbortSignal };
type Took = "won" | "lost" | "unconfirmed";
/** The answerId bridge.ts gives the cancel auto mode's transition sends to every open dialog. */
const AUTO_CANCEL = "auto-";

/** The dialog in this pane: a select with the options and a typed answer, or an input. Auto mode starting between the pick and the typed answer opens no input (it would be answered as Escape and marked refused). */
async function paneDialog(ui: ExtensionContext["ui"], q: BossQuestion, title: string, opts: Opts, away: () => boolean): Promise<Got | undefined> {
	const pick = q.options ? await ui.select(title, [...q.options, OWN_ANSWER], opts) : OWN_ANSWER;
	const typed = pick === OWN_ANSWER;
	const answer = !typed ? pick : opts.signal.aborted || away() ? undefined : await ui.input(title, "Your answer", opts);
	return answer?.trim() ? { answer: answer.trim(), typed, by: "local" } : undefined;
}

export function createBossAsk(kit: Kit, d: { attended(): boolean; remote(): boolean; asks?: AskClient }): BossAsk {
	const { pi, cfg, s, role } = kit, watch = cfg.face?.every ?? every, bus = pi.events as unknown as Bus;
	const asks = d.asks ?? askClient(cfg.server ? callServer(cfg.env, kit.guiDir) : async () => undefined, kit.me, () => (pi as { getSessionName?: () => string | undefined }).getSessionName?.());
	const todos = () => { try { return todosOfBranch(s.branch()) ?? []; } catch { return []; } };
	return async (q, signal, ctx, callId) => {
		if (role() !== "main" || s.isTrain || s.isTower || s.remoteOrigin || d.remote() || !d.attended() || !ctx?.hasUI) return { kind: "tower" };
		if (s.autoOn()) return { kind: "tower", note: AUTO_NOTE };
		const title = `The boss decides: ${q.question}`, ac = new AbortController(), stop = watch(() => void (s.autoOn() && ac.abort()), WATCH_MS);
		const opts = { signal: signal ? AbortSignal.any([signal, ac.signal]) : ac.signal };
		// The first answer, here or there, wins: the store decides between the pane, the page and the phone; one from the page or a paired device ends the dialog here.
		let got: Got | undefined, looking = false, unconfirmed = false, autoCancel = false, won: string | undefined; // `won`: the answerId the store (else the relay) took, which the close names (asks-r3-F001)
		// The todo it blocks, by id and uid (carrows-review-F001): a reader tells it from a todo that takes the id after `clear`.
		const list = todos(), item = q.item ?? list.find((t) => t.status === "in_progress")?.id, itemUid = item ? list.find((t) => t.id === item)?.uid : undefined;
		const ask = await asks.open({ subject: q.question, questions: [{ question: title, options: q.options ?? [] }], ...(callId ? { toolCallId: callId } : {}), ...(item ? { item, ...(itemUid ? { itemUid } : {}) } : {}) }).catch(() => undefined);
		const winner = (a: NonNullable<AskState["answer"]>) => void (!got && ((got = gotOf(q, a)), (won = a.answerId), ac.abort()));
		const judged = (r: Awaited<ReturnType<AskClient["answer"]>>): Took | undefined => (!r ? undefined : r.status === 200 ? "won" : (r.status === 409 && (r.body.ask as AskState | undefined)?.answer && winner((r.body.ask as AskState).answer!), "lost"));
		/**
		 * Takes an answer to the store: whether it won. A 409 means another came first, and that one is the result. No server at `ask-open` lets it stand, as before the store; once the Ask is open, an answer with no
		 * reply is sent again with the same answerId and the Ask read back after each send (asks-r2-F002). Only an answer the store confirms is the boss's: one it never confirmed is `unconfirmed`, never delivered as his.
		 */
		const take = async (g: Got, by: "terminal" | "gui" | "phone", given?: string): Promise<{ took: Took; id: string }> => {
			const answerId = given && given.length >= 16 ? given : randomUUID();
			if (!ask) return { took: "won", id: answerId };
			const send = () => asks.answer(ask.id, { answerId, digest: ask.digest, by, ...("cancel" in g ? { cancel: true as const } : { replies: repliesOf(q, g) }) }).catch(() => undefined);
			const readBack = async (): Promise<Took | "open"> => {
				const now = await asks.get(ask.id).catch(() => undefined);
				if (!now) return "unconfirmed";
				if (now.state === "open") return "open";
				if (now.answer?.answerId === answerId) return "won";
				return (now.answer && winner(now.answer), "lost");
			};
			const first = judged(await send()) ?? (await readBack());
			const took = first !== "open" ? first : ((again) => (again === "open" ? "unconfirmed" : again))(judged(await send()) ?? (await readBack()));
			return { took, id: answerId };
		};
		/** An answer taken to the store becomes the result unless another came first: one the store never confirmed is `unconfirmed`. */
		const settle = (g: Got, t: { took: Took; id: string }) => void (t.took !== "lost" && !got && ((got = g), (unconfirmed = t.took === "unconfirmed"), (won = unconfirmed ? undefined : t.id)));
		// One relayed answer is taken to the store at a time: a second that comes meanwhile hears the dialog closed, as it did before the store.
		let claiming = false;
		const relay = hubRelay(bus, q, title, callId, () => got !== undefined || claiming, async (g, answerId) => {
			if ("cancel" in g && answerId.startsWith(AUTO_CANCEL)) return void ((autoCancel = true), ac.abort()); // auto mode's own cancel (bridge.ts cancelWaits): the Ask closes as auto, not as the page's cancel (asks-r2-F004)
			claiming = true;
			const t = await take(g, g.phone ? "phone" : "gui", answerId);
			claiming = false;
			if (t.took === "lost" || got) return "closed";
			settle(g, t);
			ac.abort();
			return unconfirmed ? "unconfirmed" : undefined; // bridge.ts tells the page it is not known whether it stands
		});
		// An answer through the page's own route (api/asks/<id>/answer) reaches the store only: the asker looks once a second while the dialog is open.
		const look = ask ? watch(() => {
			if (looking || got) return;
			looking = true;
			void asks.get(ask.id).then((r) => { if (r?.answer && r.state !== "open") winner(r.answer); }, () => {}).finally(() => void (looking = false));
		}, LOOK_MS) : () => {};
		try {
			const local = await paneDialog(ctx.ui, q, title, opts, () => s.autoOn());
			if (!got && local) settle(local, await take(local, "terminal"));
		} finally {
			stop();
			look();
			// Ended with no answer here: the close answers the Ask as it stands, so an answer the store took first (the phone's before Escape) is the result (asks-r2-F001).
			const ended = ask && !got ? await asks.close(ask.id, signal?.aborted ? "abort" : autoCancel || s.autoOn() ? "auto" : "esc").catch(() => undefined) : undefined;
			if (ended?.answer && ended.state !== "open") winner(ended.answer);
			// The close names the winner's answerId, so the page's answer is told accepted only when it is the one that won (asks-r3-F001); an unconfirmed one is never told so.
			relay.close(unconfirmed ? "unconfirmed" : got && "by" in got ? got.by : got ? "cancel" : signal?.aborted ? "abort" : autoCancel || s.autoOn() ? "auto" : "local", won);
		}
		if (got && unconfirmed) return { kind: "unconfirmed", text: `Not confirmed: the sb server that records the question did not confirm ${"answer" in got ? `the answer ${JSON.stringify(got.answer)}` : "the cancel"} as the boss's first answer, and he may have answered first on the page or the phone. It is not his decision: do not act on it. Go on with work that does not need it; once sb_doctor finds the server, ask again with call_tower boss. Nothing was sent to the tower.` };
		if (got && "answer" in got) return { kind: "answered", text: `The boss ${got.typed ? "answered" : "chose"}: ${JSON.stringify(got.answer)}${got.note ? `. His note: ${JSON.stringify(got.note)}` : ""}. This is the boss's answer, asked in this pane; nothing was sent to the tower.` };
		if (autoCancel || s.autoOn()) return { kind: "tower", note: `Auto mode started while the boss was asked, so the dialog closed. ${AUTO_NOTE}` };
		return { kind: "none", text: `The boss did not answer (${signal?.aborted ? "the turn was stopped" : "Esc"}): nothing was sent to the tower. Go on with work that does not need it; ask again only if it still blocks you.` };
	};
}
