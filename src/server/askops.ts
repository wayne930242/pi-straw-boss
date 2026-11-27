import { join } from "node:path";
import type { AskView } from "../asktypes.ts";
import type { Found, Net } from "../net.ts";
import { asksOfNet, countOn, rowsFor, viewsOf } from "./askmirror.ts";
import { type AnswerBy, type AskQuestion, type AskRecord, type CloseWhy, createAskStore, type Judged, oneLine } from "./askstore.ts";
import type { Reply, Request } from "./socket.ts";

// The server's side of the Asks (docs/specs/2026-11-28-boss-asks.md): the store under <state>/asks/, kept in step with every reading of the net (askmirror.ts), the control socket's commands, and the page's
// answer route. Kept out of main.ts, which carries a line budget.
//
//   ask-open {session, name, ask: {subject, questions, toolCallId?, item?}}   a blocking Ask of `call_tower`'s boss question; answers the record
//   ask-answer {id, answerId, digest, replies | cancel, by}                    one answer (`by`: terminal, gui, phone); answers {status, body} as the page's route does
//   ask-get {id}                                                               the record, which an asker looks at while its dialog is open
//   ask-close {id, session, why}                                               the asker ends its own question with no answer (esc, abort, auto)
//   asks-rows {session}                                                        the rows of `straw-boss:ask-rows:v1` for that session

/** How old the last reading may be when a session asks for its rows; an older one is read again first. */
const FRESH_MS = 10_000, SWEEP_MS = 3600_000, CLOSE_WHY = new Set<CloseWhy>(["esc", "abort", "auto"]), BY = new Set<AnswerBy>(["terminal", "gui", "phone"]);
export interface NetWatch { onRead(cb: (net: Net) => void): () => void; read(): Promise<Net>; lookup(key: string): Found | undefined }
export interface AskOpsDeps { stateDir: string; now(): number; watch(): NetWatch | undefined; log(event: string, facts: Record<string, string | number | boolean>): void }

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v : undefined);
/** The questions of an `ask-open`: one to four, each with up to eight options of one line. */
function questionsOf(raw: unknown): AskQuestion[] | undefined {
	if (!Array.isArray(raw) || !raw.length || raw.length > 4) return;
	const qs = raw.map((q) => (str(q?.question, 600) && Array.isArray(q.options) && q.options.length <= 8 && q.options.every((o: unknown) => str(o, 120)) ? { question: q.question as string, options: q.options as string[] } : undefined));
	return qs.every(Boolean) ? (qs as AskQuestion[]) : undefined;
}

export function startAsks(d: AskOpsDeps) {
	const store = createAskStore(join(d.stateDir, "asks"), d.now);
	let last: { net: Net; at: number } | undefined, off: (() => void) | undefined;
	const seenIn = (net: Net) => asksOfNet(net, { now: d.now(), paneOf: (key) => d.watch()?.lookup(key)?.pane });
	const synced = (net: Net) => {
		last = { net, at: d.now() };
		try {
			const seen = seenIn(net);
			store.sync(seen.entries, seen.live, seen.place);
		} catch (error) {
			d.log("error", { code: "asks", text: oneLine((error as Error).message) });
		}
	};
	/** The watch is the GUI host's, built before this: every reading it makes, the page's and the watchdog's, keeps the store in step. */
	const attach = () => (off ??= d.watch()?.onRead(synced));
	attach();
	const sweep = setInterval(() => { try { store.sweep(); } catch { /* the next sweep tries again */ } }, SWEEP_MS);
	sweep.unref?.();
	store.sweep();
	const fresh = async () => {
		attach();
		if (last && d.now() - last.at < FRESH_MS) return last.net;
		const w = d.watch();
		return w ? await w.read().then((net) => (synced(net), net), () => last?.net) : last?.net;
	};
	/** The page's answer route (`POST api/asks/<id>/answer`): this computer's page is `gui`, a paired device `phone`. */
	const answer = (id: string, json: Record<string, unknown>, remote: boolean): Judged => store.answer(id, { answerId: json.answerId, digest: json.digest, replies: json.replies, cancel: json.cancel, by: remote ? "phone" : "gui" });
	return {
		store,
		answer,
		/** The open Asks as the page draws them, from the reading just made. */
		view: (net: Net): AskView[] => ((views) => (countOn(net, views), views))(viewsOf(store.list({ open: true }), net)),
		stop: () => (clearInterval(sweep), off?.()),
		/** The Asks' commands; undefined for a command that is not theirs. */
		reply(request: Request): Promise<Reply> | undefined {
			const r = request as Request & Record<string, unknown>, id = str(r.id, 64);
			switch (request.cmd) {
				case "ask-open": {
					const ask = (r.ask ?? {}) as Record<string, unknown>, session = str(r.session, 128), questions = questionsOf(ask.questions), item = Number.isSafeInteger(ask.item) && (ask.item as number) > 0 ? (ask.item as number) : undefined;
					if (!session || !questions) return Promise.resolve({ ok: false, error: "ask-open needs a session and one to four questions of up to eight options" });
					const place = last ? seenIn(last.net).place(session) : undefined; // the net's name and place of the session, when the last reading has it
					const rec = store.open({ kind: "boss", asker: { session, name: str(r.name, 128) ?? session.slice(0, 8), ...place }, subject: str(ask.subject, 2000) ?? questions[0]!.question, questions, ...(str(ask.toolCallId, 128) ? { toolCallId: ask.toolCallId as string } : {}), ...(item ? { item: { session, id: item } } : {}) });
					d.log("ask-open", { n: rec.n, kind: rec.kind });
					return Promise.resolve({ ok: true, ask: rec });
				}
				case "ask-answer": {
					if (!id || !BY.has(r.by as AnswerBy)) return Promise.resolve({ ok: false, error: "ask-answer needs an id and by (terminal, gui, or phone)" });
					const judged = store.answer(id, { answerId: r.answerId, digest: r.digest, replies: r.replies, cancel: r.cancel, by: r.by as Exclude<AnswerBy, "owner"> });
					if (judged.status === 200) d.log("ask-answer", { id: id.slice(0, 8), by: String(r.by) });
					return Promise.resolve({ ok: true, status: judged.status, body: judged.body });
				}
				case "ask-get": {
					const rec = id ? store.get(id) : undefined;
					return Promise.resolve(rec ? { ok: true, ask: rec } : { ok: false, error: "not_found" });
				}
				case "ask-close": {
					const rec: AskRecord | undefined = id ? store.get(id) : undefined;
					if (!rec || !rec.blocking || rec.asker.session !== r.session || !CLOSE_WHY.has(r.why as CloseWhy)) return Promise.resolve({ ok: false, error: "ask-close is the asker's own, for its blocking Ask, with why esc, abort, or auto" });
					return Promise.resolve({ ok: true, ask: store.close(rec.id, r.why as CloseWhy) });
				}
				case "asks-rows": {
					const session = str(r.session, 128);
					if (!session) return Promise.resolve({ ok: false, error: "asks-rows needs a session" });
					return fresh().then((net) => ({ ok: true, rows: rowsFor(store.list({ open: true }), net, session) }));
				}
				default:
					return undefined;
			}
		},
	};
}
export type AskOps = ReturnType<typeof startAsks>;
