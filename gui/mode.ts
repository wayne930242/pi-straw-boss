import { createPrefs, KEYS } from "./prefs.ts";

// Zen as a mode of the page (docs/specs/2026-11-26-storybook-theme/spec.md Part A): on or off on this device whatever its theme. The header's Zen button turns it on, Esc Esc, the corner control, the palette, and an item's or a session's exit
// turn it off (viewface.ts says when). It is kept as `sb.zen` (1 or 0); with none stored, the legacy `sb.view` = `zen` of a build where Zen was a view means on, and that key is never written (prefs.ts LEGACY), so an older build on the same
// browser still finds Zen. The key is read when the page loads only: there is no `storage` listener, so another tab of this device is never pulled into Zen or out of it (Z-D20, 「永遠不要打斷」). A refused storage reads off, and a write
// it refuses is dropped: the mode holds until the page closes.

export interface ModeStore { getItem(key: string): string | null; setItem(key: string, value: string): void }

export function mountMode(storage: ModeStore) {
	const prefs = createPrefs(storage);
	let on = prefs.get("zen");
	const set = (next: boolean) => {
		on = next;
		prefs.set("zen", next);
	};
	// A legacy Zen device writes the mode once under its own key, so a theme pick (which writes `sb.view`) does not drop it on the next load (review RV-F001).
	if (on && stored(storage) === null) set(true);
	return {
		/** The mode is on for this page. */
		on: () => on,
		/** The header's Zen button. */
		enter: () => set(true),
		/** Esc Esc, the corner control, the palette's way out, an exit. */
		leave: () => set(false),
	};
}
/** `sb.zen` as stored, null when none or the storage refused. */
function stored(storage: ModeStore): string | null {
	try {
		return storage.getItem(KEYS.zen);
	} catch {
		return null;
	}
}
export type PageMode = ReturnType<typeof mountMode>;
