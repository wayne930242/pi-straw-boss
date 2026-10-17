import type { createChat, Delta, Page } from "./chat.ts";

// Where the comms log stands and how it gets to an entry: pure rules, tested without a browser; chat.ts applies them to the scroller.

type Chat = ReturnType<typeof createChat>;

/**
 * Where the comms log stands: pinned to the newest entry (new ones keep it there), or reading (the user scrolled up, or it opened at an
 * anchor). While reading, a floating button offers the way back: "N new" once entries arrived, else "jump to latest".
 */
export function createFollow() {
	let pinned = true, unseen = 0;
	return {
		get pinned() { return pinned; },
		/** The user scrolled: at the bottom pins again. */
		scrolled(bottom: boolean) {
			pinned = bottom;
			if (bottom) unseen = 0;
		},
		/** Opening at an anchor reads from there. */
		hold: () => void (pinned = false),
		/** Entries arrived; true when the log should follow them to the bottom. */
		arrived(n: number) {
			if (!pinned) unseen += n;
			return pinned;
		},
		jump: () => void ((pinned = true), (unseen = 0)),
		/** The button's text, or undefined when it hides. A detached log (its end not mounted) always offers it. */
		button: (detached: boolean) => (pinned && !detached ? undefined : unseen && !detached ? `${unseen} new` : "jump to latest"),
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
