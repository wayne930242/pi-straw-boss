import assert from "node:assert/strict";
import { test } from "node:test";
import { type Hotkey, hotkeyOf, mountHotkeys, type Pressed } from "../gui/hotkeys.ts";

// The page's keys for the alert dialogs (gui/hotkeys.ts): which key asks for what, and every case where the key is not the page's.

/** An element that answers `closest` for the simple selectors the module uses (tag, .class, [attr], [attr=value]), itself and its ancestors. */
class El {
	tag: string;
	cls: string[];
	attrs: Record<string, string>;
	parent?: El;
	isContentEditable: boolean;
	constructor(tag: string, cls: string[] = [], attrs: Record<string, string> = {}, parent?: El, editable = false) {
		[this.tag, this.cls, this.attrs, this.parent, this.isContentEditable] = [tag, cls, attrs, parent, editable];
	}
	private is(selector: string) {
		const [, tag = "", cls, attr, value] = /^([a-z]*)(?:\.([\w-]+))?(?:\[([\w-]+)(?:=([\w-]+))?\])?$/.exec(selector.trim()) ?? [];
		return (!tag || tag === this.tag) && (!cls || this.cls.includes(cls)) && (!attr || (attr in this.attrs && (value === undefined || this.attrs[attr] === value)));
	}
	closest(selector: string): El | null {
		for (let el: El | undefined = this; el; el = el.parent) if (selector.split(",").some((s) => el!.is(s))) return el;
		return null;
	}
}
const dialog = new El("section", ["dialog"]);
const press = (key: string, target: unknown = new El("body"), over: Partial<Pressed> = {}): Pressed => ({ key, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, defaultPrevented: false, target, ...over });

test("Space asks for the next alert and F for the zoom, from the page and from a plain element", () => {
	for (const target of [new El("body"), null, {}, new El("div", [], {}, dialog), new El("h3", [], {}, dialog)]) {
		assert.equal(hotkeyOf(press(" ", target), false), "next");
		assert.equal(hotkeyOf(press("f", target), false), "zoom");
		assert.equal(hotkeyOf(press("F", target), false), "zoom");
	}
});

test("other keys are not the page's, Escape included (main.ts closes the dialog)", () => {
	for (const key of ["Escape", "Enter", "g", "x", "Tab", "ArrowDown", "Spacebar", "ff"]) assert.equal(hotkeyOf(press(key), false), undefined, key);
});

test("none fires while the user types: inputs, textareas, selects, contenteditable, the composer's menu, the terminal's key sink and scroll", () => {
	const typing = [
		new El("input", [], { type: "text" }), new El("textarea"), new El("select"), new El("div", [], {}, undefined, true),
		new El("span", [], {}, new El("textarea")), new El("li", [], { role: "option" }, new El("ul", ["slash"], { role: "listbox" })),
		new El("textarea", ["term-sink"]), new El("div", ["term-scroll"], { tabindex: "0" }), new El("span", [], {}, new El("div", ["term-scroll"])),
		new El("div", [], { role: "textbox" }), new El("div", [], { role: "combobox" }),
	];
	for (const target of typing) for (const key of [" ", "f", "F"]) assert.equal(hotkeyOf(press(key, target), false), undefined, `${key} in ${target.tag}.${target.cls.join(".")}`);
});

test("in an answer form: Space and F in the own-words or note box only type, and Space on an option stays the option's (its radio or checkbox button)", () => {
	const form = new El("section", ["ask"]), own = new El("textarea", ["ask-own"], {}, form), note = new El("input", ["ask-own"], { type: "text" }, form);
	for (const box of [own, note]) for (const key of [" ", "f", "F"]) assert.equal(hotkeyOf(press(key, box), false), undefined, `${key} in ${box.tag}`);
	for (const role of ["radio", "checkbox"]) assert.equal(hotkeyOf(press(" ", new El("button", ["ask-opt"], { role }, form)), false), undefined, `Space on a ${role}`);
	for (const key of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab", "Enter"]) for (const target of [own, note, new El("button", ["ask-opt"], { role: "radio" }, form)]) assert.equal(hotkeyOf(press(key, target), false), undefined, `${key} is the form's`);
});

test("none fires with Ctrl, Alt, or ⌘ held, while an input method composes, or when another listener took the key", () => {
	for (const over of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { defaultPrevented: true }])
		for (const key of [" ", "f"]) assert.equal(hotkeyOf(press(key, undefined, over), false), undefined, `${key} ${Object.keys(over)}`);
	assert.equal(hotkeyOf(press("F", undefined, { shiftKey: true } as Partial<Pressed>), false), "zoom", "Shift (a capital F) is allowed");
});

test("none fires while a modal owns the keyboard", () => {
	for (const key of [" ", "f", "F"]) assert.equal(hotkeyOf(press(key), true), undefined, key);
});

test("Space on a focused button or link keeps its own activation; F on one still zooms", () => {
	const natives = [new El("button"), new El("a", ["go"]), new El("summary"), new El("div", [], { role: "button" }), new El("div", [], { role: "link" }), new El("span", [], {}, new El("button", ["zoom"]))];
	for (const target of natives) {
		assert.equal(hotkeyOf(press(" ", target), false), undefined, `Space on ${target.tag}`);
		assert.equal(hotkeyOf(press("f", target), false), "zoom", `F on ${target.tag}`);
	}
});

/** The module's listeners on a fake window, and what `act` was asked and answered. */
function page({ handled = true, owned = false } = {}) {
	const on: Record<string, (e: never) => void> = {}, asked: Hotkey[] = [], state = { handled, owned };
	mountHotkeys((k) => (asked.push(k), state.handled), () => state.owned, { addEventListener: (type: string, fn: (e: never) => void) => (on[type] = fn) } as unknown as Window);
	const down = (key: string, over: Partial<Pressed> & { repeat?: boolean } = {}) => {
		const e = { ...press(key, undefined, over), repeat: false, ...over, taken: false, preventDefault() { this.taken = true; } };
		on.keydown!(e as never);
		return e;
	};
	return { asked, state, down, up: () => on.keyup!({} as never) };
}

test("a handled key is taken (no page scroll for Space); one that had nothing to do is left to the page", () => {
	const p = page();
	assert.equal(p.down(" ").taken, true);
	assert.equal(p.down("f").taken, true);
	assert.deepEqual(p.asked, ["next", "zoom"]);
	const idle = page({ handled: false });
	assert.equal(idle.down(" ").taken, false, "nothing queued: Space scrolls as before");
	assert.equal(idle.down("f").taken, false);
	assert.deepEqual(idle.asked, ["next", "zoom"]);
});

test("a key the page does not own is neither acted on nor taken", () => {
	const p = page();
	assert.equal(p.down(" ", { target: new El("textarea") }).taken, false);
	assert.equal(p.down("f", { ctrlKey: true }).taken, false);
	p.state.owned = true;
	assert.equal(p.down(" ").taken, false);
	assert.equal(p.down("Escape").taken, false);
	assert.deepEqual(p.asked, []);
});

test("a held key acts once; its repeats are taken without acting, and the next press acts again", () => {
	const p = page();
	p.down("f");
	assert.equal(p.down("f", { repeat: true }).taken, true);
	assert.equal(p.down("f", { repeat: true }).taken, true);
	assert.deepEqual(p.asked, ["zoom"]);
	p.up();
	p.down("f");
	assert.deepEqual(p.asked, ["zoom", "zoom"]);
	const idle = page({ handled: false });
	idle.down(" ");
	assert.equal(idle.down(" ", { repeat: true }).taken, false, "a repeat of a key that did nothing scrolls on");
	assert.deepEqual(idle.asked, ["next"]);
});
