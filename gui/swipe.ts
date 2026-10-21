// The phone drawer's gesture rules (drawer.ts runs them on touch events), apart from the DOM so they can be tested. A swipe from anywhere pulls the
// drawer out; it must not fight the page: a touch that starts in a text box, in the composer or terminal's key sink, in something that scrolls
// sideways (a code block, a table, the terminal), or on selected text is the page's, and so is any movement that is not mostly horizontal. Vertical
// scrolling is never cancelled: the drawer calls preventDefault only once a drag is under way.

/** Movement before a touch is read, in px; how much wider than tall a horizontal drag must be; a flick's speed in px/ms; and how far (of its width) the drawer must be pulled to stay. */
export const SLOP = 10, RATIO = 1.7, FLICK = 0.45, HALF = 0.4;
export type Intent = "wait" | "drag" | "pass";

/**
 * What a touch's movement so far (`dx` right, `dy` down, from where it began) decides. Nothing until it has moved SLOP px; then a drag when it is
 * mostly horizontal (RATIO) and goes the way the drawer moves (rightwards to open it, leftwards to close it), else the page's.
 */
export function intent(dx: number, dy: number, open: boolean): Intent {
	const [ax, ay] = [Math.abs(dx), Math.abs(dy)];
	if (Math.max(ax, ay) < SLOP) return "wait";
	return ax >= RATIO * ay && (open ? dx < 0 : dx > 0) ? "drag" : "pass";
}

/** Whether the drawer settles open once let go: its visible part `x` of `width` past HALF, unless a flick (`v` px/ms, rightwards positive) says otherwise. */
export const settles = (x: number, width: number, v: number) => (Math.abs(v) >= FLICK ? v > 0 : x >= width * HALF);

/** What a swipe needs to know about an element on the way up from where the touch began. */
export interface Probe { tag: string; editable?: boolean; scrollsX?: boolean; sink?: boolean }
/** Whether a touch beginning in `chain` (the target first, then its ancestors) or on selected text is not for the drawer. */
export const ignored = (chain: Probe[], selecting: boolean) => selecting || chain.some((p) => p.editable || p.sink || p.scrollsX || ["input", "textarea", "select"].includes(p.tag));

/** A DOM element as a probe: editable, the composer or the terminal's key sink, or scrolling sideways with something to scroll to. */
export function probe(el: Element): Probe {
	const html = el as HTMLElement, overflow = getComputedStyle(el).overflowX;
	return { tag: el.tagName.toLowerCase(), editable: html.isContentEditable, sink: el.matches(".composer, .term-sink"), scrollsX: (overflow === "auto" || overflow === "scroll") && el.scrollWidth > el.clientWidth + 1 };
}
export const chainOf = (el: Element | null): Probe[] => {
	const chain: Probe[] = [];
	for (let e = el; e; e = e.parentElement) chain.push(probe(e));
	return chain;
};
