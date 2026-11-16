import { createHereMark, type Here } from "../heremark.ts";
import { type Ctx, trusted } from "../server/client.ts";
import type { ServiceState } from "../server/runs.ts";
import { callControl, ControlError } from "../server/socket.ts";
import type { PickSource, Polled, PromptSource } from "./source.ts";

// The tower prompt's source over the sb server's control socket (docs/how-it-works.md, The standing pane). It authenticates as the CLI does: the record in the state folder (read once the folder's owner is
// judged, client.ts `trusted`) gives the socket and the secret. It starts no server and holds no run token; a server that is down, restarting, or still loading is a wait, because the prompt belongs to a
// server that will be back. The boss's words go through the `tower-event` command that `/boss tower <prompt>` and the GUI's composer use.

const POLL_MS = 3000, POST_MS = 15_000, TELL_MS = 2000;
class Unreachable extends Error {}
/** There is no server at all (no record, or nothing listens on its socket): the one kind of `Unreachable` that is an absence and not a failure to ask. */
class Absent extends Unreachable {}

/** Runs `fn` every `ms` until the returned function is called (the here mark's renewal). */
const every = (fn: () => void, ms: number) => {
	const timer = setInterval(fn, ms);
	timer.unref?.();
	return () => clearInterval(timer);
};

export function serverSource(ctx: Ctx, workspace: string, pid: number = process.pid, pane: string | null = process.env.HERDR_PANE_ID ?? null): PromptSource {
	/** One command to the server; rejects `Unreachable` when there is no server to ask, or it does not answer. */
	const ask = async (request: Record<string, unknown>, ms: number): Promise<Record<string, unknown>> => {
		let record;
		try {
			record = await trusted(ctx);
		} catch (cause) {
			throw new Unreachable((cause as Error).message);
		}
		if (!record?.socket) throw new Absent("the sb server is not running");
		try {
			return ((await callControl(record.socket, record.secret, request as { cmd: string }, ms)).reply ?? {}) as Record<string, unknown>;
		} catch (cause) {
			if (cause instanceof ControlError) throw cause.failure === "no-server" ? new Absent(cause.message) : new Unreachable(cause.message);
			throw cause;
		}
	};
	const tell = (cmd: "prompt-leave" | "prompt-gone") => ask({ cmd, workspace, pid }, TELL_MS).then(() => undefined, () => undefined);
	/** One request that rejects with the server's own words, or the word that it did not answer. */
	const sure = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
		let reply;
		try {
			reply = await ask(request, POST_MS);
		} catch (cause) {
			throw new Error(cause instanceof Unreachable ? `the sb server did not answer: ${cause.message}` : (cause as Error).message);
		}
		if (reply.ok !== true) throw new Error(String(reply.error ?? "the sb server gave no reason"));
		return reply;
	};
	// The picker's own asks: token-less requests with the state folder's secret, as the posts are. The here mark is asked as a session asks it (the pane's own id). Only a server that is not there marks nothing, as no page can type then; a server that is slow
	// to answer, refuses, or sits in a folder that is not the boss's refuses the mode (heremark.ts: any other refusal refuses the screen).
	const here: Here = createHereMark({ ask: (request) => ask(request, TELL_MS).then((reply) => ({ ok: reply.ok === true, ...reply }), (cause: Error) => ({ ok: false, error: cause instanceof Absent ? "no server" : cause.message })), pane, every });
	let head = false; // the last poll said this prompt stands in for the head tower
	const pick: PickSource = {
		waits: async () => {
			const reply = await sure({ cmd: "boss-waits", own: workspace });
			// SAFETY: a `boss-waits` answer carries `auto` and `towers` as waitlist.ts writes them; waitview.ts `rowsOf` cleans every row once more.
			return { auto: (reply.auto as { on?: boolean } | undefined)?.on === true, towers: (reply.towers as never[] | undefined) ?? [] };
		},
		press: async (target, json) => {
			const reply = await sure({ cmd: "tower-memory", workspace: target, json, via: "prompt" });
			return { ...(typeof reply.status === "number" ? { status: reply.status } : {}), ...(typeof reply.body === "object" && reply.body !== null ? { body: reply.body as Record<string, unknown> } : {}) };
		},
		reply: async (tower, text, answers) => {
			// `door`: a reply to this pane's own tower (the head, when the last poll said this pane is the head's) is written at its pane, as a posted line is (D4); another tower's run is in a pane the boss is not at.
			const reply = await sure(tower.head ? { cmd: "head-event", text, answers, ...(head ? { door: "pane" } : {}) } : { cmd: "tower-event", workspace: tower.workspace, text, present: true, answers, ...(tower.workspace === workspace ? { door: "pane" } : {}) });
			return typeof reply.answered === "string" ? { answered: reply.answered } : {};
		},
		here,
	};
	return {
		pick,
		async poll(answering = false): Promise<Polled> {
			let reply;
			try {
				reply = await ask({ cmd: "prompt-poll", workspace, pid, ...(answering ? { answering: true } : {}) }, POLL_MS);
			} catch (cause) {
				return { kind: "wait", why: (cause as Error).message };
			}
			if (reply.ok === true && typeof reply.label === "string" && typeof reply.state === "string" && typeof reply.queued === "number" && typeof reply.leave === "boolean") {
				head = reply.head === true;
				// SAFETY: a state word this build does not know is shown as the server sent it (prompt.ts cleans it of control characters), not made into one it does.
				return { kind: "state", answer: { label: reply.label, state: reply.state as ServiceState, queued: reply.queued, leave: reply.leave, ...(reply.head === true ? { head: true as const } : {}), ...(Array.isArray(reply.waits) ? { waits: reply.waits as never[] } : {}), ...(typeof reply.auto === "boolean" ? { auto: reply.auto } : {}), ...(reply.holding === true ? { holding: true as const } : {}), ...(reply.unattended === true ? { unattended: true as const } : {}) } };
			}
			const error = String(reply.error ?? "no usable answer");
			return reply.gone === true ? { kind: "gone", error } : { kind: "wait", why: error };
		},
		async post(text: string) {
			let reply;
			try {
				reply = await ask({ cmd: "tower-event", workspace, text, present: true, door: "pane" }, POST_MS); // `door`: written at this tower's own pane, so the run it wakes may show the boss a card here (runmode.ts, `boss_wait_ask`)
			} catch (cause) {
				throw new Error(cause instanceof Unreachable ? `the sb server did not answer: ${cause.message}` : (cause as Error).message);
			}
			if (reply.ok !== true) throw new Error(String(reply.error ?? "the sb server gave no reason"));
		},
		async fresh() {
			let reply;
			try {
				reply = await ask({ cmd: "tower-new", workspace }, POST_MS);
			} catch (cause) {
				throw new Error(cause instanceof Unreachable ? `the sb server did not answer: ${cause.message}` : (cause as Error).message);
			}
			if (reply.ok !== true) throw new Error(String(reply.error ?? "the sb server gave no reason"));
		},
		leave: () => tell("prompt-leave"),
		gone: () => tell("prompt-gone"),
	};
}
