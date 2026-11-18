import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { El, page } from "./fake-dom.ts";

// Copying one message on a phone (gui/copy.ts): the page served over plain http on the LAN has no `navigator.clipboard`, so the copy runs through a selected
// textarea and `execCommand("copy")`, called inside the tap (before any await, or the browser no longer counts it as the user's).

const { copyText, copyButton } = await import("../gui/copy.ts");
const { m } = await import("../gui/paraglide/messages.js");

const setNavigator = (value: unknown) => void Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
const doc = page as unknown as Record<string, unknown>;

/** A document whose textareas can be selected and whose `execCommand("copy")` reads what was selected, as the browser does. */
function rig(result = true) {
	const copied: string[] = [], seen: { value: string; sunk: boolean }[] = [], made: El[] = [];
	const create = page.createElement;
	page.createElement = (tag: string) => {
		const el = create(tag);
		if (tag === "textarea") Object.assign(el, { select() { (el as unknown as { picked: boolean }).picked = true; el.focus(); }, setSelectionRange() {} }), made.push(el);
		return el;
	};
	doc.execCommand = (cmd: string) => {
		const ta = made.at(-1)!;
		seen.push({ value: ta.value, sunk: ta.isConnected && (ta as unknown as { picked?: boolean }).picked === true });
		if (cmd === "copy" && result) copied.push(ta.value);
		return result;
	};
	return { copied, seen, made, restore: () => ((page.createElement = create), delete doc.execCommand) };
}

afterEach(() => {
	setNavigator(undefined);
	delete (globalThis as { getSelection?: unknown }).getSelection;
});

test("without navigator.clipboard (a phone on http) the text goes through a selected textarea and execCommand, in the same tick as the tap, and the textarea is gone after", async () => {
	setNavigator({});
	const r = rig();
	try {
		const pending = copyText("line one\nline two");
		assert.deepEqual(r.seen, [{ value: "line one\nline two", sunk: true }], "execCommand ran synchronously, with the text selected in an attached textarea");
		assert.equal(await pending, true);
		assert.deepEqual(r.copied, ["line one\nline two"]);
		assert.equal(r.made[0]!.isConnected, false, "the textarea is removed");
	} finally {
		r.restore();
	}
});

test("where the clipboard is there it is used, and the textarea is not", async () => {
	const wrote: string[] = [];
	setNavigator({ clipboard: { writeText: async (s: string) => void wrote.push(s) } });
	const r = rig();
	try {
		assert.equal(await copyText("whole message"), true);
		assert.deepEqual([wrote, r.made.length], [["whole message"], 0]);
	} finally {
		r.restore();
	}
});

test("a clipboard that refuses falls back to the textarea; both failing says so", async () => {
	setNavigator({ clipboard: { writeText: async () => { throw new Error("denied"); } } });
	const ok = rig();
	try {
		assert.equal(await copyText("x"), true);
		assert.deepEqual(ok.copied, ["x"]);
	} finally {
		ok.restore();
	}
	const bad = rig(false);
	try {
		assert.equal(await copyText("x"), false);
		assert.equal(bad.made[0]!.isConnected, false);
	} finally {
		bad.restore();
	}
});

test("a selection the reader had survives the copy", async () => {
	setNavigator({});
	const ranges = ["r1", "r2"], log: string[] = [];
	Object.assign(globalThis, { getSelection: () => ({ rangeCount: ranges.length, getRangeAt: (i: number) => ({ cloneRange: () => ranges[i] }), removeAllRanges: () => void log.push("clear"), addRange: (r: string) => void log.push(`add ${r}`) }) });
	const r = rig();
	try {
		await copyText("x");
		assert.deepEqual(log.slice(-3), ["clear", "add r1", "add r2"], "the ranges are put back after the textarea's own selection");
	} finally {
		r.restore();
	}
});

test("the message's Copy button copies its text, says Copied and then goes back; a failed copy selects the text and says so", async () => {
	setNavigator({});
	const timers: (() => void)[] = [], save = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
	Object.assign(globalThis, { setTimeout: (fn: () => void) => timers.push(fn), clearTimeout: () => {} });
	const r = rig();
	try {
		const body = new El("div"), picked: unknown[] = [];
		Object.assign(page, { createRange: () => ({ selectNodeContents: (el: unknown) => void picked.push(el) }) });
		const b = copyButton(() => "the whole message", () => body as unknown as HTMLElement) as unknown as El;
		assert.equal(b.tag, "button");
		assert.equal(b.getAttribute("type"), "button");
		assert.equal(b.getAttribute("aria-label"), m.chat_copy_message());
		assert.equal(b.textContent, m.chat_copy());
		b.click();
		await Promise.resolve();
		assert.deepEqual(r.copied, ["the whole message"]);
		assert.equal(b.textContent, m.chat_copied());
		timers.shift()!();
		assert.equal(b.textContent, m.chat_copy(), "the label comes back");
		Object.assign(globalThis, { getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }) });
		doc.execCommand = () => false;
		b.click();
		await Promise.resolve();
		assert.deepEqual(picked, [body], "the message is selected for the reader to copy by hand");
		assert.equal(b.textContent, m.chat_copy_select());
		assert.equal(b.getAttribute("aria-label"), m.chat_copy_select_hint(), "the state is announced through the label");
		assert.equal(m.chat_copy_select_hint().includes("phone"), false);
	} finally {
		Object.assign(globalThis, save);
		delete (page as unknown as Record<string, unknown>).createRange;
		r.restore();
	}
});

test("the copy through the textarea gives the focus back to the control that had it", () => {
	setNavigator({});
	const r = rig();
	try {
		const field = new El("input");
		page.body.append(field);
		field.focus();
		Object.assign(globalThis, { getSelection: () => ({ rangeCount: 0, removeAllRanges() {}, addRange() {} }) });
		const areaFocus = r.made;
		void copyText("x");
		assert.equal(page.focused, field);
		void areaFocus;
	} finally {
		r.restore();
	}
});
