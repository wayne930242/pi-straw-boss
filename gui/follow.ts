import type { createChat, Delta, Page } from "./chat.ts";
import { m } from "./sentences.ts";

// Where the comms log stands and how it gets to an entry: pure rules, tested without a browser; chat.ts applies them to the scroller.

type Chat = ReturnType<typeof createChat>;

/**
 * Where the comms log stands: pinned to the newest entry (new ones keep it there), or reading (the user scrolled up, or it opened at an
 * anchor). While reading, a floating button offers the way back: "N new" once entries arrived, else "jump to latest".
 */
export function createFollow() {
	let pinned = true, unseen = 0, near = true, last = 0;
	return {
		get pinned() { return pinned; },
		/** The end sentinel crossed its margin (80 px from the end): inside pins, outside reads. A report of where it already stands (an observer's first notice on connecting) is not a crossing. */
		scrolled(bottom: boolean) {
			if (bottom === near) return;
			near = pinned = bottom;
			if (bottom) unseen = 0;
		},
		/** The log put itself at `top` (following): the scroll event that lands there is not the user's. */
		parked: (top: number) => void (last = top),
		/**
		 * A scroll event at `top`; `end` reads the largest offset, and is called only when it decides. A user's move up leaves the end at once, not 80 px later when the sentinel does, so no entry pulls a reader
		 * back; any move that reaches the very end pins again. A log that shrank clamps its offset to the end, which is not a move up: a user's own move up never lands at the end, so a
		 * move up that does is the clamp, and a reader it puts there follows. True when whether the log follows changed.
		 */
		moved(top: number, end: () => number) {
			const dy = top - last;
			last = top;
			if (dy < -0.5 && pinned && end() - top > 1) return !(pinned = false);
			return dy !== 0 && !pinned && near && end() - top <= 1 && ((pinned = true), (unseen = 0), true);
		},
		/** Opening at an anchor reads from there. */
		hold: () => void (near = pinned = false),
		/** Entries arrived; true when the log should follow them to the bottom. A log `held` where it stands (the reader has text selected) counts them as unseen, though it still follows. */
		arrived(n: number, held = false) {
			if (!pinned || held) unseen += n;
			return pinned;
		},
		jump: () => void ((near = pinned = true), (unseen = 0)),
		/** The button's text, or undefined when it hides. A detached log (its end not mounted) always offers it. */
		button: (detached: boolean) => (detached ? m.jump_latest() : unseen ? m.new_entries({ count: unseen }) : pinned ? undefined : m.jump_latest()),
	};
}

/**
 * Loads older pages until the entry `at` is mounted; true when it is. An entry no longer in the history leaves the log at its newest
 * page instead (the walk back may have pushed the end out past the cap), so it opens at the end.
 */
export async function reach(chat: Pick<Chat, "items" | "before" | "prepend" | "reset">, data: { older(before: string): Promise<Page>; latest(): Promise<Page> }, at: string, painted: (d: Delta) => void) {
	const has = () => chat.items.some((i) => i.id === at);
	while (!has() && chat.before) painted(chat.prepend(await data.older(chat.before)));
	if (has()) return true;
	painted(chat.reset(await data.latest()));
	return false;
}
