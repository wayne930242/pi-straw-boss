import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { El, page } from "./fake-dom.ts";

// The phone drawer and text selection (gui/drawer.ts). A long press selects a word at once and the finger that goes on moving drags the selection's end (iOS sends that
// drag as touchmoves of the same touch). The drawer decided at touchstart, before any text was selected, so a mostly horizontal move of such a drag pulled the drawer out
// and cancelled the selection with preventDefault. A text selected after the touch began is the page's, as one selected before it is.

const { read } = await import("../gui/swipe.ts");
const { mountDrawer } = await import("../gui/drawer.ts");

test("a move that would pull the drawer is the page's once text is selected", () => {
	assert.equal(read(40, 3, false, false), "drag", "no selection: a flat rightwards move pulls the drawer out");
	assert.equal(read(40, 3, false, true), "pass", "text selected: it is the selection's handle");
	assert.equal(read(-40, 3, true, true), "pass");
	assert.equal(read(3, 4, false, true), "pass", "selected text is not waited on either");
});

let selected = "";
Object.assign(globalThis, { matchMedia: () => ({ matches: true }), getComputedStyle: () => ({ overflowX: "visible" }), getSelection: () => ({ toString: () => selected }), performance: { now: () => 0 } });
afterEach(() => void (selected = ""));

/** One touch on the page: `start` at the finger's first contact, `move` the moves; returns what the drawer did with preventDefault and whether it came out. */
function touch(moves: [number, number][], between?: () => void) {
	const target = new El("p"), panel = page.body.find((el) => el.classes.has("drawer"))[0]!;
	let prevented = 0;
	const fire = (type: string, x: number, y: number) => page.on[type]?.forEach((on) => on({ target, touches: [{ clientX: x, clientY: y }], preventDefault: () => void prevented++ } as never));
	page.body.append(target);
	fire("touchstart", 100, 300);
	between?.();
	for (const [x, y] of moves) fire("touchmove", 100 + x, 300 + y);
	fire("touchend", 100, 300);
	target.remove();
	return { prevented, out: panel.classes.has("on") };
}

Object.assign(page, { querySelector: () => null, documentElement: new El("html") }); // the fake document cannot read the modal selector (:popover-open); no modal is open
mountDrawer();

test("text selected by a long press after the touch began keeps the finger's moves from pulling the drawer", () => {
	const r = touch([[30, 2], [60, 4]], () => (selected = "a word"));
	assert.deepEqual([r.prevented, r.out], [0, false], "no preventDefault, nothing dragged out");
});

test("a flat swipe on the page pulls the drawer out", () => {
	assert.equal(touch([[30, 2]]).prevented > 0, true);
});
