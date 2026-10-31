import assert from "node:assert/strict";
import { test } from "node:test";
import { page, SCRIPT } from "../src/entryform.ts";

const inputs = (html: string) => [...html.matchAll(/<input [^>]*>/g)].map((m) => m[0]);

for (const [zh, hint, gap] of [[false, /No hyphen needed/, /8 characters/], [true, /不需要輸入連字號/, /8 個字元/]] as const) {
	test(`the entry page (${zh ? "zh" : "en"}) is eight one-character boxes under one label, and says plainly that no hyphen is needed`, () => {
		const html = page(zh), boxes = inputs(html);
		assert.equal(boxes.length, 8, "eight boxes and no hyphen box");
		boxes.forEach((box, i) => {
			assert.match(box, new RegExp(`name="c${i + 1}"`));
			assert.match(box, zh ? new RegExp(`aria-label="第 ${i + 1} 碼，共 8 碼"`) : new RegExp(`aria-label="character ${i + 1} of 8"`));
			for (const part of ['maxlength="1"', 'autocapitalize="characters"', 'autocorrect="off"', 'spellcheck="false"', 'autocomplete="off"', 'inputmode="text"', "required"]) assert.ok(box.includes(part), `${part} in ${box}`);
			assert.equal(box.includes("autofocus"), i === 0);
		});
		assert.equal(html.match(/<legend>/g)?.length, 1, "one label for the group");
		assert.match(html, /<fieldset><legend>[^<]+<\/legend>/);
		assert.match(html, hint);
		assert.match(html, gap);
		assert.match(html, /nth-child\(5\)\{margin-left/, "the gap between box 4 and 5 is spacing, not a character");
		assert.match(html, /<form method="post" action="\/sb-app\/pair">/);
		assert.match(html, /<script src="\/sb-app\/entry\.js"><\/script>/);
		assert.ok(!/<script(?![^>]* src=)/.test(html) && !/ on[a-z]+=/.test(html), "no inline script or handler");
		assert.ok(!/<form/.test(page(zh, "locked")) && /role="alert"/.test(page(zh, "locked")), "locked: no boxes, a note");
		assert.match(page(zh, "wrong"), /role="alert"[^>]*>[^<]+<\/p><form/);
	});
}

// A hand-made page: just what the script touches.
class Box {
	value = ""; selected = false; handlers: Record<string, ((e: any) => void)[]> = {};
	world: { active?: Box };
	constructor(world: { active?: Box }) { this.world = world; }
	addEventListener(type: string, fn: (e: any) => void) { (this.handlers[type] ??= []).push(fn); }
	focus() { this.world.active = this; }
	select() { this.selected = true; }
}
function world() {
	const w: { active?: Box } = {}, boxes = Array.from({ length: 8 }, () => new Box(w)), go = { disabled: false }, formHandlers: Record<string, ((e: any) => void)[]> = {};
	const form = { querySelector: () => go, querySelectorAll: () => boxes, addEventListener: (type: string, fn: (e: any) => void) => (formHandlers[type] ??= []).push(fn) };
	new Function("document", "window", SCRIPT)({ querySelector: () => form }, {});
	const fire = (target: { handlers?: Record<string, ((e: any) => void)[]> }, type: string, event: Record<string, unknown> = {}) => {
		const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...event };
		for (const fn of (target === form ? formHandlers : target.handlers!)[type] ?? []) fn(e);
		return e;
	};
	/** What the browser does for a typed character: it lands in the box, then `input` fires. */
	const type = (i: number, text: string) => (boxes[i]!.value = text, fire(boxes[i]!, "input", { isComposing: false }));
	const at = () => boxes.indexOf(w.active!);
	return { boxes, go, fire, type, at, form, values: () => boxes.map((b) => b.value).join("") };
}

test("the script: a character moves on, upper-cased and in half width; Backspace on an empty box goes back; the button waits for eight", () => {
	const w = world();
	assert.equal(w.go.disabled, true);
	w.type(0, "a");
	assert.deepEqual([w.boxes[0]!.value, w.at()], ["A", 1]);
	w.type(1, "Ｂ");
	assert.deepEqual([w.boxes[1]!.value, w.at()], ["B", 2], "full width becomes half width");
	w.type(2, "-");
	assert.deepEqual([w.boxes[2]!.value, w.at()], ["", 2], "a hyphen is not a character: the box stays empty and focus stays");
	for (let i = 2; i < 8; i++) w.type(i, "CDEFGH"[i - 2]!);
	assert.equal(w.values(), "ABCDEFGH");
	assert.equal(w.go.disabled, false, "eight filled");
	const back = w.fire(w.boxes[7]!, "keydown", { key: "Backspace" });
	assert.equal(back.defaultPrevented, false, "a filled box deletes by itself");
	w.boxes[7]!.value = "";
	w.fire(w.boxes[7]!, "input", { isComposing: false });
	assert.equal(w.go.disabled, true);
	const empty = w.fire(w.boxes[7]!, "keydown", { key: "Backspace" });
	assert.deepEqual([empty.defaultPrevented, w.boxes[6]!.value, w.at()], [true, "", 6], "an empty box clears the one before and goes there");
	assert.equal(w.fire(w.boxes[0]!, "keydown", { key: "Backspace" }).defaultPrevented, false, "nothing before the first");
});

test("the script: arrows walk, a composition waits for its end, typing over a filled box replaces it", () => {
	const w = world();
	w.boxes[3]!.value = "X";
	w.fire(w.boxes[3]!, "beforeinput", { inputType: "insertText" });
	assert.equal(w.boxes[3]!.selected, true, "the next character replaces it");
	w.fire(w.boxes[3]!, "keydown", { key: "ArrowRight" });
	assert.equal(w.at(), 4);
	w.fire(w.boxes[4]!, "keydown", { key: "ArrowLeft" });
	w.fire(w.boxes[3]!, "keydown", { key: "ArrowLeft" });
	assert.equal(w.at(), 2);
	w.fire(w.boxes[2]!, "keydown", { key: "End" });
	assert.equal(w.at(), 7);
	w.fire(w.boxes[7]!, "keydown", { key: "ArrowRight" });
	assert.equal(w.at(), 7, "no box after the last");
	w.fire(w.boxes[7]!, "keydown", { key: "Home" });
	assert.equal(w.at(), 0);
	w.boxes[0]!.value = "ㄅ";
	w.fire(w.boxes[0]!, "input", { isComposing: true });
	assert.deepEqual([w.boxes[0]!.value, w.at()], ["ㄅ", 0], "mid-composition nothing is touched");
	w.boxes[0]!.value = "a";
	w.fire(w.boxes[0]!, "compositionend");
	assert.deepEqual([w.boxes[0]!.value, w.at()], ["A", 1]);
});

test("the script: a pasted code fills all eight with or without a hyphen or spaces, a short paste fills from its box, and the form does not go with empty boxes", () => {
	const paste = (w: ReturnType<typeof world>, i: number, text: string) => w.fire(w.boxes[i]!, "paste", { clipboardData: { getData: () => text } });
	for (const text of ["abcd-efgh", "ABCD EFGH", "ABCDEFGH", "ａｂｃｄ－ｅｆｇｈ", " abcd\u3000efgh\n"]) {
		const w = world();
		w.type(5, "Z");
		assert.equal(paste(w, 5, text).defaultPrevented, true);
		assert.deepEqual([w.values(), w.at(), w.go.disabled], ["ABCDEFGH", 7, false], JSON.stringify(text));
	}
	const w = world();
	paste(w, 4, "ef");
	assert.deepEqual([w.values(), w.at(), w.go.disabled], ["EF", 6, true]);
	paste(w, 6, "x");
	assert.equal(w.at(), 7);
	const held = w.fire(w.form as never, "submit");
	assert.deepEqual([held.defaultPrevented, w.at()], [true, 0], "submit with empty boxes goes to the first empty one");
	paste(w, 0, "abcdefgh");
	assert.equal(w.fire(w.form as never, "submit").defaultPrevented, false);
	assert.equal(paste(w, 0, "---").defaultPrevented, true);
	assert.equal(w.values(), "ABCDEFGH", "a paste with nothing in it changes nothing");
});
