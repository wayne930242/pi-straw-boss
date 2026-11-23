import { homedir } from "node:os";
import { join } from "node:path";
import { childEnded, tieChild, tieQuery } from "./childtie.ts";
import type { Slot } from "./record.ts";
import type { Reply, Request } from "./socket.ts";
import { createThreads, type ThreadsDeps, type Threads } from "./threads.ts";

// The server's side of the review threads (docs/specs/2026-11-23-lite-b2-d-e-f.md §2): the control-socket commands, their requests checked, and the threads built for the server. Kept out of main.ts, which carries a line budget.
//   main side:  `thread-pair {owner, worker, reviewer, rounds?}`, `thread-read {owner, thread}`, `thread-list {owner}`
//   child side: `thread-member`, `thread-post {thread, to, tag, text, refs?}`, `thread-wait {thread, since?}`, each with the child's tie {session, child, activityFile} (childtie.ts)
// The owner a main sends is its own session id: the socket cannot check it, and a child's tie decides which threads it may speak on.

const CMDS = ["thread-pair", "thread-read", "thread-list", "thread-member", "thread-post", "thread-wait"];
const no = (error: string): Promise<Reply> => Promise.resolve({ ok: false, error });
const text = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

/** The thread commands. Undefined for a command that is not one of them. */
export function threadReply(threads: Threads | undefined, request: Request, sessionsDir: string): Promise<Reply> | undefined {
	if (!CMDS.includes(request.cmd)) return undefined;
	if (!threads) return no("the server is still starting");
	if (request.cmd === "thread-pair" || request.cmd === "thread-read" || request.cmd === "thread-list") {
		const owner = text(request.owner, 128);
		if (!owner) return no(`${request.cmd} needs owner`);
		if (request.cmd === "thread-list") return Promise.resolve(threads.list(owner));
		if (request.cmd === "thread-read") {
			const thread = text(request.thread, 40);
			return thread ? Promise.resolve(threads.read(owner, thread)) : no("thread is T<n> or <owner8>/T<n>");
		}
		const worker = text(request.worker, 200), reviewer = text(request.reviewer, 200), rounds = request.rounds;
		if (!worker || !reviewer) return no("thread-pair needs worker and reviewer");
		if (rounds !== undefined && typeof rounds !== "number") return no("rounds is 1 to 3");
		return Promise.resolve(threads.pair({ owner, worker, reviewer, ...(rounds !== undefined ? { rounds } : {}) }));
	}
	const q = tieQuery(request);
	if (!q) return no(`${request.cmd} needs session, child, and activityFile`);
	const got = tieChild(sessionsDir, q);
	if ("error" in got) return no(got.error);
	if (request.cmd === "thread-member") return Promise.resolve(threads.member(got.tie));
	if (request.cmd === "thread-wait") return threads.wait(got.tie, { thread: request.thread, since: request.since });
	return Promise.resolve(threads.post(got.tie, { thread: String(request.thread ?? ""), to: request.to, tag: request.tag, text: request.text, refs: request.refs }));
}

export interface StartThreads {
	slot: Slot;
	env: NodeJS.ProcessEnv;
	now(): number;
	log(event: string, facts: Record<string, number | string | boolean>): void;
	stops: (() => void)[];
	/** The seams of a test: the hold's length and the timer. */
	over?: Partial<Pick<ThreadsDeps, "holdMs" | "timer">>;
}
/** The threads of this server, in `threads/` of its own folder, and pi's sessions folder the children's ties are read in. Its timers stop with the server. */
export function startThreads(o: StartThreads): { threads: Threads; sessionsDir: string } {
	const timer = o.over?.timer ?? ((ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref?.(); return () => clearTimeout(t); });
	const threads = createThreads({ dir: join(o.slot.dir, "threads"), now: o.now, timer, ended: childEnded, log: o.log, ...(o.over?.holdMs !== undefined ? { holdMs: o.over.holdMs } : {}) });
	o.stops.push(threads.start());
	return { threads, sessionsDir: join(o.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions") };
}
