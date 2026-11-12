import { boundedWait } from "../handover.ts";
import { canonical } from "./found.ts";

// The boss's intent behind a pane (docs/specs/2026-11-09-auto-mode.md, D3 note of 11/12): a pane the page's `open/base` started carries an explicit user action, so under auto mode its pi's
// trust question is asked as usual instead of being answered "not trusted" at once. The list of such panes is the sb server's, in its memory only: the pane it started, with the folder it
// started pi in, from before pi starts until the open's start and join have ended, however they end. The pane's pi runs in another process, so it asks the server over the control socket
// (`open-intent`, with its own pane id, Herdr's, and its own folder) and takes only the server's yes. No server, no answer in time, an older server, or one that started again (its memory is
// new) is a no, and the question is answered as before. No listing is written to or read from disk for it (review R156-F001: a file is not proof of who wrote it), and no request field, flag, or
// environment variable can add a pane to the list. The asker finds the server through its record (`server.json`), as every control request does, so a same-uid process that writes that record and
// answers the socket can say yes (review R0752-F001); that grants no trust, D3 becomes a question that waits for a person.

export interface Intents {
	/** Lists `pane`, whose pi starts in `cwd`; returns the call that takes it off again. */
	grant(pane: string, cwd: string): () => void;
	/** Whether `pane` is listed for `cwd` now. Whatever is not a listed pane id and its folder says no. */
	has(pane: unknown, cwd: unknown): boolean;
}

/** The server's side: one list per server process. */
export function createIntents(): Intents {
	const live = new Set<{ pane: string; cwd: string }>();
	return {
		grant(pane, cwd) {
			const entry = { pane, cwd: canonical(cwd) };
			live.add(entry);
			return () => void live.delete(entry);
		},
		has: (pane, cwd) => typeof cwd === "string" && [...live].some((e) => e.pane === pane && e.cwd === canonical(cwd)),
	};
}

/** One request to the live sb server (traincar.ts `callServer`): undefined when none runs or it does not answer. */
export type IntentCall = (request: { cmd: "open-intent"; pane: string; cwd: string }, timeoutMs: number) => Promise<{ ok: boolean; error?: string; opened?: unknown } | undefined>;
/** The call's own time limit, and the limit of the whole ask: before the call the state folder's owner is checked, which on Windows is a PowerShell start of seconds. */
const CALL_MS = 3000, ASK_MS = 10_000;

/** The pane's side: whether the server says it started this pane's pi, in this folder, for an open/base that is still starting. Whatever is not that answer, in time, says no. */
export const askOpened = (call: IntentCall, env: NodeJS.ProcessEnv, ms = ASK_MS) => async (cwd: string): Promise<boolean> => {
	const pane = env.HERDR_PANE_ID;
	if (!pane) return false;
	const reply = await boundedWait(call({ cmd: "open-intent", pane, cwd }, Math.min(CALL_MS, ms)), ms);
	return reply?.ok === true && reply.opened === true;
};
