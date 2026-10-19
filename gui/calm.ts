// Infinite motion (spinning rings, pings, the link's blink) keeps the page producing frames for as long as one runs, which is what drains a
// phone left open. The page calms after CALM_MS without input: `data-calm` on <html> (style.css) swaps each such animation for a still sign of
// the same state, and any input restores the motion. Under prefers-reduced-motion there is no such motion to calm, and the page is left as it is.
// An IntersectionObserver would let an element off the screen rest too, but while one watches anything a running animation makes the main thread
// produce a frame every vsync (measured), so the page uses none for that: off the screen the compositor's animation costs next to nothing.

const CALM_MS = 30_000, INPUT = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"]; // not `scroll`: the log scrolls itself as entries arrive

export function mountCalm(root = document.documentElement) {
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	let last = Date.now(), timer: ReturnType<typeof setTimeout> | undefined;
	const doze = () => {
		const left = last + CALM_MS - Date.now();
		if (left > 0) timer = setTimeout(doze, left);
		else ((timer = undefined), root.toggleAttribute("data-calm", true));
	};
	const wake = () => {
		last = Date.now();
		if (timer !== undefined) return;
		root.toggleAttribute("data-calm", false);
		timer = setTimeout(doze, CALM_MS);
	};
	for (const type of INPUT) addEventListener(type, wake, { capture: true, passive: true });
	document.addEventListener("visibilitychange", () => document.hidden || wake());
	wake();
}
