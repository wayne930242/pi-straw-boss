import { type Ctx, trusted } from "../server/client.ts";
import type { ServiceState } from "../server/runs.ts";
import { callControl, ControlError } from "../server/socket.ts";
import type { Polled, PromptSource } from "./source.ts";

// The tower prompt's source over the sb server's control socket (docs/how-it-works.md, The standing pane). It authenticates as the CLI does: the record in the state folder (read once the folder's owner is
// judged, client.ts `trusted`) gives the socket and the secret. It starts no server and holds no run token; a server that is down, restarting, or still loading is a wait, because the prompt belongs to a
// server that will be back. The boss's words go through the `tower-event` command that `/boss tower <prompt>` and the GUI's composer use.

const POLL_MS = 3000, POST_MS = 15_000, TELL_MS = 2000;
class Unreachable extends Error {}

export function serverSource(ctx: Ctx, workspace: string, pid: number = process.pid): PromptSource {
	/** One command to the server; rejects `Unreachable` when there is no server to ask, or it does not answer. */
	const ask = async (request: Record<string, unknown>, ms: number): Promise<Record<string, unknown>> => {
		let record;
		try {
			record = await trusted(ctx);
		} catch (cause) {
			throw new Unreachable((cause as Error).message);
		}
		if (!record?.socket) throw new Unreachable("the sb server is not running");
		try {
			return ((await callControl(record.socket, record.secret, request as { cmd: string }, ms)).reply ?? {}) as Record<string, unknown>;
		} catch (cause) {
			if (cause instanceof ControlError) throw new Unreachable(cause.message);
			throw cause;
		}
	};
	const tell = (cmd: "prompt-leave" | "prompt-gone") => ask({ cmd, workspace, pid }, TELL_MS).then(() => undefined, () => undefined);
	return {
		async poll(): Promise<Polled> {
			let reply;
			try {
				reply = await ask({ cmd: "prompt-poll", workspace, pid }, POLL_MS);
			} catch (cause) {
				return { kind: "wait", why: (cause as Error).message };
			}
			if (reply.ok === true && typeof reply.label === "string" && typeof reply.state === "string" && typeof reply.queued === "number" && typeof reply.leave === "boolean") {
				// SAFETY: a state word this build does not know is shown as the server sent it (prompt.ts cleans it of control characters), not made into one it does.
				return { kind: "state", answer: { label: reply.label, state: reply.state as ServiceState, queued: reply.queued, leave: reply.leave } };
			}
			const error = String(reply.error ?? "no usable answer");
			return reply.gone === true ? { kind: "gone", error } : { kind: "wait", why: error };
		},
		async post(text: string) {
			let reply;
			try {
				reply = await ask({ cmd: "tower-event", workspace, text, present: true }, POST_MS);
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
