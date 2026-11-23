import { Type } from "typebox";
import type { Ask } from "./host.ts";
import { framed } from "./threadtools.ts";
import type { Kit } from "./state.ts";

// `boss_pair` (docs/specs/2026-11-23-lite-b2-d-e-f.md §2.3; boss decisions d_attach=main_pairs, d_rounds=per_thread): a main pairs a worker and a reviewer on a review thread before it dispatches them, and writes both briefs. The sb
// server opens thread T<n> for this session (server/threads.ts); the two children talk on it (threadtools.ts) and the main is woken only by their two results when it closes. The tool is registered with the net tools at the join,
// so the main has it from its session start; a role or a turn that may not pair is refused at the call. `board_read thread` reads a thread through `read` here.

export const PAIR_DESCRIPTION = "A reviewed change: before dispatching, pair a worker and a reviewer on review thread T<n>. Then dispatch both with subagent under these names, each task with the line `Thread: T<n>`; you write both briefs. They post to each other (at most rounds repair rounds) and you are woken only by their two results when the thread closes; do not relay. board_read thread reads it.";

export function createBossPair({ pi, s, me, role }: Kit, d: { ask?: Ask; remote(): boolean }) {
	const ask = async (request: Record<string, unknown>, start: "auto" | "never" = "auto") => {
		if (!d.ask) throw new Error("No sb server answers this session");
		const reply = await d.ask(request, { start });
		if (!reply.ok) throw new Error(String(reply.error ?? "the sb server refused"));
		return reply;
	};
	const refuse = (what: string) => {
		if (s.remoteOrigin || d.remote()) throw new Error(`A teammate's turn cannot ${what} review threads`);
		if (s.isTower || role() === "tower") throw new Error("A tower does not pair: a main pairs the worker and the reviewer it dispatches");
		if (role() !== "main" && role() !== "train") throw new Error("Only a tab's main or a train pairs and reads review threads; call boss_promote first if your work grows");
	};
	return {
		addTool() {
			pi.registerTool({
				name: "boss_pair", label: "boss_pair", description: PAIR_DESCRIPTION,
				parameters: Type.Object({
					worker: Type.String({ minLength: 1, maxLength: 64, description: "Its subagent name." }),
					reviewer: Type.String({ minLength: 1, maxLength: 64, description: "Its subagent name." }),
					rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "Default 3." })),
				}),
				execute: async (_id, { worker, reviewer, rounds }) => {
					refuse("open");
					const r = await ask({ cmd: "thread-pair", owner: me(), worker, reviewer, ...(rounds !== undefined ? { rounds } : {}) });
					const text = `Thread ${r.thread}: worker ${JSON.stringify(worker)}, reviewer ${JSON.stringify(reviewer)}, up to ${r.rounds} repair round${r.rounds === 1 ? "" : "s"}. Dispatch both now with subagent under these names, each task with the line "Thread: ${r.thread}". Their two results come when the thread closes; do not relay between them. board_read thread ${r.thread} shows the posts.`;
					return { content: [{ type: "text" as const, text }], details: { thread: r.thread, worker: r.worker, reviewer: r.reviewer, rounds: r.rounds } };
				},
			});
		},
		/** `board_read thread`: a thread's posts, framed, newest last within 16 KB. */
		async read(ref: string): Promise<{ text: string; details: unknown }> {
			refuse("read");
			const r = await ask({ cmd: "thread-read", owner: me(), thread: ref });
			const posts = (r.list ?? []) as Parameters<typeof framed>[1], closed = r.closed as { by: string; tag: string; at: number; reason?: string } | undefined;
			const head = `Thread ${r.ref}: worker ${r.worker}, reviewer ${r.reviewer}, ${r.fixes}/${r.rounds} repair rounds, ${r.posts} post${r.posts === 1 ? "" : "s"}${r.cut ? ` (the oldest ${r.cut} not shown)` : ""}; ${closed ? `closed: ${closed.tag} by ${closed.by} at #${closed.at}` : "open"}.`;
			return { text: [head, posts.length ? framed(String(r.thread), posts) : "No post yet."].join("\n"), details: { ...r, ok: undefined } };
		},
		/** This session's threads for board_read, or undefined when there are none or no server answers. */
		async list(): Promise<unknown[] | undefined> {
			if (!d.ask || s.remoteOrigin || d.remote() || (role() !== "main" && role() !== "train")) return undefined;
			const r = await d.ask({ cmd: "thread-list", owner: me() }, { start: "never" }).catch(() => undefined);
			const rows = r?.ok && Array.isArray(r.threads) ? r.threads.slice(0, 10) : [];
			return rows.length ? rows : undefined;
		},
	};
}
export type BossPair = ReturnType<typeof createBossPair>;
