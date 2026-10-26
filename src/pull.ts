// Taking a session's queue back to the page's composer. The page cannot read pi's queue whole (the bridge relays the five oldest, each cut,
// bridge.ts), and pi's own dequeue key (app.message.dequeue: Alt+Up, Alt+Q on Windows and WSL, or what keybindings.json says; dequeuekey.ts) already clears
// every queue and puts steering then follow-up messages, joined with a
// blank line, in front of whatever the editor held. So the server presses that key and the bridge reads the result off the editor: `begin` before
// the press (is anything queued, what does the editor hold now), `finish` after it (wait for the queue to be gone, split the editor into the
// pulled messages and the draft that was already there, put the draft back). The draft never leaves the session, as with the Enter guard's probe.
import { DEQUEUE_KEY } from "./dequeuekey.ts";

/** What a bridge answers to a pull request. `begin`: `pending` (something is queued), the `ticket` for `finish`, and the `key` pi's dequeue is bound to (one the server presses, dequeuekey.ts). `finish`: the pulled `text`, or `empty` when pi pulled nothing (the queue was delivered since `begin`). `reason`: why not. */
export interface Pull { pending?: boolean; ticket?: string; key?: string; text?: string; empty?: true; reason?: string }
/** The most the bridge hands over; a longer text stays in pi's editor, where the terminal can edit it. */
export const MAX_PULL = 12_000;
export const WHYS = ["no_editor", "stale", "not_taken", "changed", "too_large", "not_cleared", "no_key"];

const PASTE = /\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]/;
/** What pi's Alt+Up pulls out of a queue, as the bridge's mirror has it: steering messages first, then follow-ups, each in the order they came, `\n\n` between. */
export const joined = (queued: { text: string; as: string }[]) => [...queued.filter((q) => q.as === "steer"), ...queued.filter((q) => q.as !== "steer")].map((q) => q.text).join("\n\n");

/**
 * The pulled messages out of the editor `now`, given what it held `before` the press and the messages the bridge's own mirror says were queued (`expected`, the
 * full texts): pi puts them in front of a non-blank draft, `\n\n` between. Anything else is `changed`, and nothing leaves the session: a draft typed in the terminal
 * between begin and the key, a message pi expanded or an extension rewrote, a queue that moved. pi's setText forgets the content of a pasted block in the draft
 * (only its marker stays, and `before` holds the content): then `restore` is the editor as it should be, the messages and the whole draft.
 */
export function pulled(before: string, now: string, expected: string): { text: string } | { empty: true } | { reason: "changed"; restore?: string } {
	if (now === before) return { empty: true };
	const tail = before.trim() ? `\n\n${before}` : "";
	if (expected && now === expected + tail) return { text: expected };
	return { reason: "changed", ...(expected && before.trim() && now.startsWith(`${expected}\n\n`) && PASTE.test(now.slice(expected.length + 2)) ? { restore: `${expected}\n\n${before}` } : {}) };
}

/** A bridge's answer as the server takes it, or undefined when it is out of shape. */
export function checkPull(p: Record<string, unknown> | undefined): Pull | undefined {
	if (!p) return undefined;
	const { pending, ticket, key, text, empty, reason } = p;
	if (key !== undefined && (typeof key !== "string" || !DEQUEUE_KEY.test(key))) return pending === true ? { reason: "no_key" } : undefined; // a key the server will not press: no key goes, and the page is told
	if ((pending !== undefined && typeof pending !== "boolean") || (ticket !== undefined && (typeof ticket !== "string" || ticket.length > 64)) || (text !== undefined && (typeof text !== "string" || Buffer.byteLength(text) > MAX_PULL))) return undefined;
	if ((empty !== undefined && empty !== true) || (reason !== undefined && !WHYS.includes(reason as string))) return undefined;
	return { ...(pending !== undefined ? { pending } : {}), ...(ticket !== undefined ? { ticket } : {}), ...(key !== undefined ? { key } : {}), ...(text !== undefined ? { text } : {}), ...(empty ? { empty: true as const } : {}), ...(reason !== undefined ? { reason: reason as string } : {}) };
}
