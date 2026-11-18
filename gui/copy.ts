import { h } from "./dom.ts";
import { m } from "./sentences.ts";

// Copying text out of the page on a phone. The async clipboard exists only in a secure context, and the GUI is often served over plain http on the LAN, where `navigator.clipboard`
// is undefined: there the text goes through a selected textarea and `execCommand("copy")`, which a page may call from a tap. That call must run in the tap itself, so the fallback
// never waits for the clipboard's refusal first when the clipboard is not there at all.

/** Selects the contents of `el`, for the reader to copy by hand (the platform's own Copy). */
export const selectText = (el: Node) => {
	const sel = globalThis.getSelection?.(), range = globalThis.document.createRange?.();
	if (!sel || !range) return;
	range.selectNodeContents(el);
	sel.removeAllRanges();
	sel.addRange(range);
};

/** `execCommand("copy")` over an off-screen textarea holding `text` (16 px, or iOS zooms in on it); the reader's own selection is put back. */
function viaTextarea(text: string) {
	const sel = globalThis.getSelection?.(), kept = sel ? Array.from({ length: sel.rangeCount }, (_, i) => sel.getRangeAt(i).cloneRange()) : [], focus = globalThis.document.activeElement as HTMLElement | null;
	const area = h("textarea", { readonly: "", "aria-hidden": "true", tabindex: "-1", style: "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;pointer-events:none" });
	area.value = text;
	document.body.append(area);
	let ok = false;
	try {
		area.select();
		area.setSelectionRange(0, text.length);
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	}
	area.remove();
	if (sel && kept.length) (sel.removeAllRanges(), kept.forEach((r) => sel.addRange(r)));
	if (focus && focus !== globalThis.document.activeElement && focus.isConnected) focus.focus({ preventScroll: true }); // the textarea took the focus; it goes back where it was
	return ok;
}

/** Puts `text` on the clipboard: the browser's, or the textarea's copy where it has none or refuses. True when it was copied. */
export function copyText(text: string): Promise<boolean> {
	const clipboard = globalThis.navigator?.clipboard;
	if (!clipboard?.writeText) return Promise.resolve(viaTextarea(text));
	return clipboard.writeText(text).then(() => true, () => viaTextarea(text));
}

/**
 * A message's Copy button: it copies `text()` whole and says Copied for a moment. Where nothing can copy, it selects `body()` (the message's text) and says so, for the reader to copy by hand.
 * Its own label is not selectable, so it never joins a selection that runs across the message.
 */
export function copyButton(text: () => string, body?: () => Node | null | undefined): HTMLButtonElement {
	const button = h("button", { type: "button", class: "tx-copy", "aria-label": m.chat_copy_message(), "aria-live": "polite" }, m.chat_copy());
	let timer: ReturnType<typeof setTimeout> | undefined;
	button.addEventListener("click", () => void copyText(text()).then((ok) => {
		const target = ok ? undefined : body?.();
		if (target) selectText(target);
		// The label is short (a phone's header has no room); the aria-label carries the state so the live region announces it, and the title the longer hint.
		button.textContent = ok ? m.chat_copied() : m.chat_copy_select();
		button.setAttribute("aria-label", ok ? m.chat_copied() : m.chat_copy_select_hint());
		if (!ok) button.title = m.chat_copy_select_hint();
		button.dataset.state = ok ? "copied" : "select";
		clearTimeout(timer);
		timer = setTimeout(() => ((button.textContent = m.chat_copy()), button.setAttribute("aria-label", m.chat_copy_message()), button.removeAttribute("title"), delete button.dataset.state), 1800);
	}));
	return button;
}
