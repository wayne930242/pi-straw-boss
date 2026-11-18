// The reader's text selection, as the comms log reads it. On a phone a long press selects a word and the handles that follow move its ends; the browser sends the page no touch event for them,
// so nothing in the page can tell a selection being adjusted from a finger at rest. The page's own writes (scrolling the log to its end, redrawing a message) are what break it, and they
// wait for the selection to go.

/** Whether text is selected and touches `el`: the selection's start or its end is inside it. */
export function selectedIn(el: Node): boolean {
	const sel = globalThis.getSelection?.();
	return Boolean(sel && !sel.isCollapsed && ((sel.anchorNode && el.contains(sel.anchorNode)) || (sel.focusNode && el.contains(sel.focusNode))));
}

/** Calls `ended` each time a selection that touched `root` is gone (the document's `selectionchange`); it stops listening once `root` has left the page. */
export function onSelectionEnd(root: Node, ended: () => void) {
	let was = false;
	const on = () => {
		if (!root.isConnected) return document.removeEventListener("selectionchange", on);
		const now = selectedIn(root);
		if (was && !now) ended();
		was = now;
	};
	document.addEventListener("selectionchange", on);
}
