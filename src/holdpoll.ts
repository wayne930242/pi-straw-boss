import type { Reply } from "./server/socket.ts";

// A child's long poll on the sb server (docs/specs/2026-11-23-lite-b2-d-e-f.md §2.3), the loop the retired `watch_read` ran (0.80.0 to 0.82.x), kept for `thread_wait` (threadtools.ts). The server holds each request up to 45 s and
// answers early with what ends the call; the loop asks again until `waitMs`:
//   - every re-poll calls `onUpdate`, which moves the child's activity file, so pi-herdr-agents' hang advisory stays quiet through a long wait;
//   - an abort ends the call at once, not at the end of a hold;
//   - a message that arrives during the call ends it (one already waiting at its start is a follow-up, which waits);
//   - a server that does not answer, restarts, or is older is asked again every 2 s within the wait, and the answer says `server: unreachable|outdated`;
//   - a server that holds nothing is asked every 2 s, not in a tight loop.

export const WAIT_MAX_MS = 3_000_000, REQUEST_MS = 55_000, RETRY_MS = 2_000;
const ABORTED = "Operation aborted";

export interface HoldPollDeps {
	/** One request to the live sb server; undefined when none runs or it does not answer in `timeoutMs`. */
	call(request: Record<string, unknown>, timeoutMs: number): Promise<Reply | undefined>;
	now(): number;
	sleep(ms: number): Promise<void>;
}
export interface Trouble { server: "unreachable" | "outdated"; error?: string }
export interface HoldPoll<C> {
	/** The request of one hold, from the cursor the last reply left. */
	request(cursor: C): Record<string, unknown>;
	cursor: C;
	/** Whether an `ok` reply ends the call; one that does not is a hold that saw nothing. */
	ends(reply: Reply): boolean;
	/** The cursor after a hold that saw nothing. */
	next(reply: Reply, cursor: C): C;
	/** A refusal that ends the call with its error at once (the caller is not who it should be); any other error is the server's trouble, asked again. */
	fatal(error: string): boolean;
	waitMs: number;
	/** An absolute time in ms: the call ends there as `expired`. */
	deadline?: number;
	signal?: AbortSignal;
	onUpdate?(polls: number, trouble?: Trouble): void;
	/** pi's `ctx.hasPendingMessages()`. */
	pending(): boolean;
}
export interface Held<C> { reply?: Reply; last?: Reply; cursor: C; trouble?: Trouble; expired: boolean }

/** Polls until a reply ends the call, `waitMs` or the deadline passes, or a message arrives. Throws on an abort and on a fatal refusal. */
export async function holdPoll<C>(d: HoldPollDeps, o: HoldPoll<C>): Promise<Held<C>> {
	if (!(o.waitMs <= WAIT_MAX_MS)) throw new Error(`waitMs is at most ${WAIT_MAX_MS} (50 minutes)`);
	const end = Math.min(d.now() + o.waitMs, o.deadline ?? Infinity), pendingAtStart = o.pending(), signal = o.signal;
	const aborted = new Promise<never>((_resolve, reject) => (signal?.aborted ? reject(new Error(ABORTED)) : signal?.addEventListener("abort", () => reject(new Error(ABORTED)), { once: true })));
	aborted.catch(() => {});
	let cursor = o.cursor, last: Reply | undefined, trouble: Trouble | undefined;
	for (let polls = 0; d.now() < end; polls++) {
		if (signal?.aborted) throw new Error(ABORTED);
		if (polls) o.onUpdate?.(polls, trouble);
		const left = end - d.now(), began = d.now();
		const reply = await Promise.race([d.call(o.request(cursor), Math.min(REQUEST_MS, left)).catch(() => undefined), aborted]);
		if (reply?.ok) {
			if (o.ends(reply)) return { reply, last: reply, cursor, expired: false };
			[last, trouble, cursor] = [reply, undefined, o.next(reply, cursor)];
			if (!pendingAtStart && o.pending()) break;
			if (d.now() - began < RETRY_MS && d.now() < end) await Promise.race([d.sleep(Math.min(RETRY_MS, end - d.now())), aborted]);
			continue;
		}
		const error = typeof reply?.error === "string" ? reply.error : undefined;
		if (error !== undefined && o.fatal(error)) throw new Error(error);
		// A hold cut short at `end` by this call's own timeout is no failure of the server.
		if (reply || left >= REQUEST_MS || d.now() - began < left) trouble = error?.startsWith("unknown command") ? { server: "outdated" } : { server: "unreachable", ...(error ? { error } : {}) };
		if (!pendingAtStart && o.pending()) break;
		if (d.now() < end) await Promise.race([d.sleep(Math.min(RETRY_MS, end - d.now())), aborted]);
	}
	return { ...(last ? { last } : {}), cursor, ...(trouble ? { trouble } : {}), expired: o.deadline !== undefined && d.now() >= o.deadline };
}
