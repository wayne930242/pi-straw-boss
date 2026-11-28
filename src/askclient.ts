import type { Got } from "./bossrelay.ts";
import type { BossQuestion } from "./bossask.ts";
import type { ServerCall } from "./traincar.ts";

// The asker's side of a blocking Ask (docs/specs/2026-11-28-boss-asks.md, `call_tower` boss questions): the sb server's commands as bossask.ts uses them, and an answer turned between the store's replies and the dialog's result.

/**
 * The sb server's Asks as the asker uses them (server/askops.ts); every call answers undefined when no server does. Once the Ask is open, an answer or a close with no reply is sent again, the same request:
 * `ask-answer` keeps its answerId, so a resend replays the first verdict; `ask-close` answers the Ask as it stands, the winner when an answer came first (asks-r2-F001, F002). `ask-open` is sent once: with no reply the
 * question is asked as before the store, and an Ask the server opened meanwhile is closed when its tool call ends (askops.ts).
 */
export interface AskClient {
	open(a: { subject: string; questions: { question: string; options: string[] }[]; toolCallId?: string; item?: number; itemUid?: string }): Promise<{ id: string; digest: string } | undefined>;
	answer(id: string, a: { answerId: string; digest: string; replies?: { choices?: number[]; text?: string; note?: string }[]; cancel?: true; by: "terminal" | "gui" | "phone" }): Promise<{ status: number; body: Record<string, unknown> } | undefined>;
	get(id: string): Promise<AskState | undefined>;
	close(id: string, why: "esc" | "abort" | "auto"): Promise<AskState | undefined>;
}
export type AskState = { state: string; answer?: { by: string; answerId?: string; replies?: { choices?: number[]; text?: string; note?: string }[]; cancel?: true } };
/** How often a request with no reply is sent, and the pause between two sends. */
export const ASK_TRIES = 3, ASK_PAUSE_MS = 1000;
export function askClient(call: ServerCall, me: () => string, name: () => string | undefined, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): AskClient {
	const asked = async (r: Record<string, unknown>, tries = ASK_TRIES) => {
		for (let i = 0; i < tries; i++) {
			if (i) await sleep(ASK_PAUSE_MS);
			const reply = await call(r, 5000).catch(() => undefined);
			if (reply) return reply.ok ? reply : undefined; // a refusal is an answer: sent again, it would be refused again
		}
		return undefined;
	};
	return {
		open: async (a) => ((r) => (r && typeof (r.ask as { id?: unknown })?.id === "string" ? (r.ask as { id: string; digest: string }) : undefined))(await asked({ cmd: "ask-open", session: me(), name: name(), ask: a }, 1)),
		answer: async (id, a) => ((r) => (r ? { status: Number(r.status), body: (r.body ?? {}) as Record<string, unknown> } : undefined))(await asked({ cmd: "ask-answer", id, ...a })),
		get: async (id) => (await asked({ cmd: "ask-get", id }, 1))?.ask as AskState | undefined,
		close: async (id, why) => (await asked({ cmd: "ask-close", id, session: me(), why }))?.ask as AskState | undefined,
	};
}
/** The winner the store holds, as the dialog's result. */
export function gotOf(q: BossQuestion, a: NonNullable<AskState["answer"]>): Got {
	if (a.cancel) return { cancel: true };
	const r = a.replies?.[0], pick = r?.choices?.length ? q.options?.[r.choices[0]!] : undefined;
	return { answer: pick ?? r?.text ?? "", typed: !pick, by: a.by === "terminal" ? "local" : "remote", ...(r?.note ? { note: r.note } : {}) };
}
export const repliesOf = (q: BossQuestion, g: Exclude<Got, { cancel: true }>) => [{ ...(g.typed ? { text: g.answer } : { choices: [q.options!.indexOf(g.answer)] }), ...(g.note ? { note: g.note } : {}) }];
