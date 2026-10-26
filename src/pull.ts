// Taking a session's queue back to the page's composer. The page cannot read pi's queue whole (the bridge relays the five oldest, each cut,
// bridge.ts), and pi's own Alt+Up (app.message.dequeue) already clears every queue and puts steering then follow-up messages, joined with a
// blank line, in front of whatever the editor held. So the server presses Alt+Up and the bridge reads the result off the editor: `begin` before
// the press (is anything queued, what does the editor hold now), `finish` after it (wait for the queue to be gone, split the editor into the
// pulled messages and the draft that was already there, put the draft back). The draft never leaves the session, as with the Enter guard's probe.

/** What a bridge answers to a pull request. `begin`: `pending` (something is queued) and the `ticket` for `finish`. `finish`: the pulled `text`, or `empty` when pi pulled nothing (the queue was delivered since `begin`). `reason`: why not. */
export interface Pull { pending?: boolean; ticket?: string; text?: string; empty?: true; reason?: string }
/** The most the bridge hands over; a longer text stays in pi's editor, where the terminal can edit it. */
export const MAX_PULL = 12_000;
export const WHYS = ["no_editor", "stale", "not_taken", "changed", "too_large", "not_cleared"];

/** The pulled messages out of the editor `now`, given what it held `before` the press; pi puts them in front of a non-blank draft, `\n\n` between. */
export function pulled(before: string, now: string): { text: string } | { empty: true } | { reason: "changed" } {
	if (now === before) return { empty: true };
	const tail = before.trim() ? `\n\n${before}` : "";
	return now.length > tail.length && now.endsWith(tail) && now.slice(0, now.length - tail.length).trim() ? { text: now.slice(0, now.length - tail.length) } : { reason: "changed" };
}

/** A bridge's answer as the server takes it, or undefined when it is out of shape. */
export function checkPull(p: Record<string, unknown> | undefined): Pull | undefined {
	if (!p) return undefined;
	const { pending, ticket, text, empty, reason } = p;
	if ((pending !== undefined && typeof pending !== "boolean") || (ticket !== undefined && (typeof ticket !== "string" || ticket.length > 64)) || (text !== undefined && (typeof text !== "string" || Buffer.byteLength(text) > MAX_PULL))) return undefined;
	if ((empty !== undefined && empty !== true) || (reason !== undefined && !WHYS.includes(reason as string))) return undefined;
	return { ...(pending !== undefined ? { pending } : {}), ...(ticket !== undefined ? { ticket } : {}), ...(text !== undefined ? { text } : {}), ...(empty ? { empty: true as const } : {}), ...(reason !== undefined ? { reason: reason as string } : {}) };
}
