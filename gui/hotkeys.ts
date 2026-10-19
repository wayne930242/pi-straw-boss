// The page's keys for the alert dialogs: Space opens the next alert (what the HUD alert button does), F enlarges or shrinks the top dialog
// (what its ⤢ does); Escape closes the top dialog (main.ts). They are the page's own and yield to everything else that takes keys: a box
// being typed in (an input, the composer, its `/` menu, the terminal mirror's key sink), a Ctrl, Alt, or ⌘ combination, an input method
// composing, and a modal (a confirmation, the lightbox, an open popover). Space on a button or a link stays that control's own.

export type Hotkey = "next" | "zoom";
/** The few fields of a keydown the routing reads. */
export interface Pressed { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing: boolean; defaultPrevented: boolean; target: unknown }
interface Reach { isContentEditable?: boolean; closest?(selector: string): object | null }
const TYPING = "input, textarea, select, [role=textbox], [role=combobox], [role=listbox], .term-scroll";
const NATIVE = "button, a, summary, [role=button], [role=link]";
/** What owns the keyboard while it is open. */
export const MODAL = "dialog.sheet[open], dialog.lightbox[open], [popover]:popover-open";

/** What a keydown asks for, or undefined when the key is not the page's to take. `owned`: a modal is open. */
export function hotkeyOf(e: Pressed, owned: boolean): Hotkey | undefined {
	if (owned || e.defaultPrevented || e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
	const at = e.target as Reach | null;
	if (at?.isContentEditable || at?.closest?.(TYPING)) return;
	if (e.key === "f" || e.key === "F") return "zoom";
	if (e.key === " " && !at?.closest?.(NATIVE)) return "next";
}

/**
 * Listens for the keys. `act` does the hotkey and says whether it did anything: only then is the key taken, so Space with nothing queued
 * still scrolls the page. A held key acts once, and its repeats are taken without acting again.
 */
export function mountHotkeys(act: (hotkey: Hotkey) => boolean, owned = () => document.querySelector(MODAL) !== null, win: Pick<Window, "addEventListener"> = window) {
	let held: Hotkey | undefined;
	win.addEventListener("keydown", (e) => {
		const hotkey = hotkeyOf(e, owned());
		if (!hotkey) return;
		if (e.repeat) return held === hotkey ? e.preventDefault() : undefined;
		if (act(hotkey)) (held = hotkey), e.preventDefault();
	});
	win.addEventListener("keyup", () => (held = undefined));
}
