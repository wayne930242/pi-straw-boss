import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ANSWER_ID, checkAnswer } from "../dialogs.ts";
import { type Question, questionsDigest, type Reply } from "../owners.ts";
import type { AskItem, AskKind } from "../asktypes.ts";
import { writeDurable } from "./towerstore.ts";

// The Ask store (docs/specs/2026-11-28-boss-asks.md): every open question to the boss, one file per Ask under the slot's asks/ (askops.ts), written by this server only and each write a rename, loaded at the start so an
// open Ask outlives a restart. The store owns the answer path of the questions it owns (`call_tower`'s boss question): the first valid answer wins, a late one gets 409 naming where it was answered,
// and a resent answerId replays the first result. The other questions sb can see are mirrors (askmirror.ts): opened and closed from the net's readings, never answered here.

export type { AskItem, AskKind };
export type AnswerBy = "terminal" | "gui" | "phone" | "owner";
export type CloseWhy = "esc" | "abort" | "auto" | "owner" | "asker-ended";
export interface Asker { session: string; name: string; role?: string; workspace?: string; workspaceLabel?: string; tab?: string; tabLabel?: string; pane?: string; device?: string }
export interface AskQuestion { question: string; options: string[] }
export interface AskAnswer { by: AnswerBy; at: number; answerId: string; replies?: Reply[]; cancel?: true }
export interface AskRecord {
	v: 1; id: string; n: number; kind: AskKind; blocking: boolean; mirror?: string; asker: Asker; subject: string; questions?: AskQuestion[]; digest?: string; toolCallId?: string; item?: AskItem; since: number;
	state: "open" | "answered" | "cancelled" | "closed"; answer?: AskAnswer; closed?: { at: number; why: CloseWhy };
}
/** A question the store owns (`ask-open`). */
export interface OpenInput { kind: "boss"; asker: Asker; subject: string; questions: AskQuestion[]; toolCallId?: string; item?: AskItem }
/** A question its owner holds, as one reading of the net sees it (askmirror.ts). */
export interface MirrorEntry { mirror: string; kind: Exclude<AskKind, "boss">; asker: Asker; subject: string; since: number; item?: AskItem }
export interface AnswerIn { answerId: unknown; digest: unknown; replies?: unknown; cancel?: unknown; by: Exclude<AnswerBy, "owner"> }
export interface Judged { status: number; body: Record<string, unknown> }

/** An ended Ask is kept this long (a resent answer, the list of what was asked), and at most this many; an open one however long it waits (the boss chose no timeout). */
export const ASK_KEEP_MS = 7 * 86_400_000, ENDED_MAX = 500, SUBJECT_MAX = 200;
/** A blocking Ask's asker is gone when two readings at least this far apart found no unit of its session. */
export const GONE_MS = 60_000;
const WHERE: Record<AnswerBy, string> = { terminal: "in the asker's terminal", gui: "on this computer's page", phone: "on the phone", owner: "where it was asked" };
const HEX = /^[0-9a-f]{32}$/;
export const oneLine = (v: string, max = SUBJECT_MAX) => v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
/** The questions as the dialog contract hashes them (owners.ts), so the store's digest is the relay's. */
export const asQuestions = (qs: AskQuestion[]): Question[] => qs.map((q) => ({ question: q.question, multiple: false, options: q.options.map((title) => ({ title })) }));
const valid = (r: Partial<AskRecord> | null): r is AskRecord => Boolean(r && r.v === 1 && typeof r.id === "string" && HEX.test(r.id) && Number.isSafeInteger(r.n) && typeof r.kind === "string" && typeof r.subject === "string" && typeof r.asker?.session === "string" && Number.isFinite(r.since) && ["open", "answered", "cancelled", "closed"].includes(r.state as string));

export function createAskStore(dir: string, now: () => number = Date.now) {
	const asks = new Map<string, AskRecord>(), missed = new Map<string, number>();
	let next = 1;
	try {
		for (const name of readdirSync(dir)) {
			if (name === "seq.json") { try { next = Math.max(next, Number(JSON.parse(readFileSync(join(dir, name), "utf8")).next) || 1); } catch { /* the records' numbers stand in */ } continue; }
			if (!/^[0-9a-f]{32}\.json$/.test(name)) continue;
			try { const r = JSON.parse(readFileSync(join(dir, name), "utf8")) as AskRecord; if (valid(r) && `${r.id}.json` === name) asks.set(r.id, r); } catch { /* a broken file is skipped and left for the boss to look at */ }
		}
	} catch { /* no folder yet */ }
	for (const r of asks.values()) next = Math.max(next, r.n + 1);
	const save = (r: AskRecord) => {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeDurable(join(dir, `${r.id}.json`), r);
		asks.set(r.id, r);
		return r;
	};
	const number = () => {
		const n = next++;
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeDurable(join(dir, "seq.json"), { next });
		return n;
	};
	const create = (r: Omit<AskRecord, "v" | "id" | "n" | "state">): AskRecord => save({ v: 1, id: randomBytes(16).toString("hex"), n: number(), state: "open", ...r });
	const end = (r: AskRecord, why: CloseWhy) => (missed.delete(r.id), save({ ...r, state: "closed", closed: { at: now(), why } }));
	/** Why an answer is not taken now, in words that name where the winner came from. */
	const late = (r: AskRecord): Judged => ({ status: 409, body: { outcome: "closed", ...(r.answer ? { by: r.answer.by, at: r.answer.at } : { at: r.closed?.at }), reason: r.answer ? `Q${r.n} was already ${r.answer.cancel ? "cancelled" : "answered"} ${WHERE[r.answer.by]}.` : `Q${r.n} closed with no answer (${r.closed?.why}).`, ask: r } });
	return {
		get: (id: string) => asks.get(id),
		/** Every Ask, the oldest first; `open` only those that still wait. */
		list: ({ open = false } = {}) => [...asks.values()].filter((r) => !open || r.state === "open").sort((a, b) => a.n - b.n),
		open(input: OpenInput): AskRecord {
			const questions = input.questions.map((q) => ({ question: oneLine(q.question, 500), options: q.options.map((o) => oneLine(o, 120)) }));
			return create({ kind: input.kind, blocking: true, asker: input.asker, subject: oneLine(input.subject) || questions[0]?.question || "?", questions, digest: questionsDigest(asQuestions(questions)), ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}), ...(input.item ? { item: input.item } : {}), since: now() });
		},
		/** One answer, judged against the Ask as it stands now (docs/specs/2026-11-28-boss-asks.md, The answer path). */
		answer(id: string, a: AnswerIn): Judged {
			const r = asks.get(id);
			if (!r) return { status: 404, body: { outcome: "refused", reason: "No such question." } };
			if (typeof a.answerId !== "string" || !ANSWER_ID.test(a.answerId)) return { status: 400, body: { outcome: "refused", reason: "The answer has no answer id." } };
			if (r.answer?.answerId === a.answerId) return { status: 200, body: { outcome: "accepted", ask: r } }; // the same answer sent again
			if (r.state !== "open") return late(r);
			if (!r.questions || r.mirror) return { status: 403, body: { outcome: "refused", code: "owner", reason: `Q${r.n} is answered where it was asked: its pane or its card.` } };
			if (a.digest !== r.digest) return { status: 409, body: { outcome: "changed", reason: "The question is not the one asked; read it again." } };
			const checked = checkAnswer({ dialog: r.id, digest: r.digest!, questions: asQuestions(r.questions), cancel: true }, { ...(a.replies !== undefined ? { answers: a.replies } : {}), ...(a.cancel !== undefined ? { cancel: a.cancel } : {}) });
			if (typeof checked === "string") return { status: 400, body: { outcome: "refused", reason: checked } };
			const answer: AskAnswer = { by: a.by, at: now(), answerId: a.answerId, ...("answers" in checked ? { replies: checked.answers } : { cancel: true as const }) };
			missed.delete(r.id);
			return { status: 200, body: { outcome: "accepted", ask: save({ ...r, state: answer.cancel ? "cancelled" : "answered", answer }) } };
		},
		/** The asker ends its own question with no answer: the pane's Escape, its turn stopped, auto mode. An Ask that already ended stays as it is. */
		close(id: string, why: CloseWhy): AskRecord | undefined {
			const r = asks.get(id);
			return r && r.state === "open" ? end(r, why) : r;
		},
		/**
		 * One reading of the net: the mirrors it saw are opened or refreshed (their subject and place; never their number, since or item), an open mirror it did not see is closed (`owner`, or `asker-ended` when its
		 * asker's session is not on the net), and a blocking Ask whose asker is missing from two readings `GONE_MS` apart ends as `asker-ended`. `place` fills a blocking Ask's place from the net once it is known.
		 */
		sync(seen: MirrorEntry[], live: Set<string>, place?: (session: string) => Partial<Asker> | undefined): void {
			const by = new Map(seen.map((e) => [e.mirror, e]));
			for (const r of [...asks.values()].filter((x) => x.state === "open")) {
				if (r.mirror) {
					const e = by.get(r.mirror);
					by.delete(r.mirror);
					if (!e) { end(r, live.has(r.asker.session) || r.asker.device ? "owner" : "asker-ended"); continue; } // a teammate device is never on the net: its card ended
					const subject = oneLine(e.subject) || r.subject;
					if (subject !== r.subject || JSON.stringify(e.asker) !== JSON.stringify(r.asker)) save({ ...r, subject, asker: e.asker });
					continue;
				}
				if (live.has(r.asker.session)) {
					missed.delete(r.id);
					const p = place?.(r.asker.session), filled = p && { ...r.asker, ...p, session: r.asker.session };
					if (filled && JSON.stringify(filled) !== JSON.stringify(r.asker)) save({ ...r, asker: filled });
					continue;
				}
				const first = missed.get(r.id);
				if (first === undefined) missed.set(r.id, now());
				else if (now() - first >= GONE_MS) end(r, "asker-ended");
			}
			for (const e of by.values()) create({ kind: e.kind, blocking: false, mirror: e.mirror, asker: e.asker, subject: oneLine(e.subject) || "?", ...(e.item ? { item: e.item } : {}), since: e.since });
		},
		/** Drops the ended Asks older than seven days, and the oldest beyond 500. */
		sweep(): void {
			const ended = [...asks.values()].filter((r) => r.state !== "open").sort((a, b) => endOf(b) - endOf(a));
			for (const [i, r] of ended.entries()) if (i >= ENDED_MAX || now() - endOf(r) > ASK_KEEP_MS) (asks.delete(r.id), rmSync(join(dir, `${r.id}.json`), { force: true }));
		},
	};
}
const endOf = (r: AskRecord) => r.answer?.at ?? r.closed?.at ?? r.since;
export type AskStore = ReturnType<typeof createAskStore>;
