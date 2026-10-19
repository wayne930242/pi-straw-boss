import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { Pending } from "../src/ask.ts";
import { questionsDigest, secretDigest, selectDigest } from "../src/owners.ts";
import { m } from "../gui/paraglide/messages.js";

// The answer panel (gui/ask.ts) as the page drives it: the server's updates arrive while the user picks, types, and notes, and the panel
// keeps all of that for the dialog the user is filling. The updates are the ones the server really sends (dialogs.ts merge): the same
// dialog read under another call, a read-only spell while an answer is on its way, a reading where the unit shows no pending at all.

/** The few DOM calls the panel makes: elements with attributes, children, value, disabled, handlers, and focus. */
class El {
	attrs = new Map<string, string>();
	kids: (El | string)[] = [];
	parent: El | undefined;
	dataset: Record<string, string> = {};
	onclick: (() => void) | null = null;
	oninput: (() => void) | null = null;
	private off = false;
	value = "";
	selectionStart = 0;
	selectionEnd = 0;
	handlers: Record<string, ((e: unknown) => void)[]> = {};
	readonly tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, String(value));
	}
	addEventListener(type: string, on: (e: unknown) => void) {
		(this.handlers[type] ??= []).push(on);
	}
	getAttribute(name: string) {
		return this.attrs.get(name) ?? null;
	}
	append(...kids: (El | string)[]) {
		for (const kid of kids) {
			if (kid instanceof El) {
				kid.parent?.kids.splice(kid.parent.kids.indexOf(kid), 1);
				kid.parent = this;
			}
			this.kids.push(kid);
		}
	}
	replaceChildren(...kids: (El | string)[]) {
		for (const kid of this.kids) if (kid instanceof El) kid.parent = undefined;
		this.kids = [];
		this.append(...kids);
	}
	contains(other: unknown) {
		for (let at = other as El | undefined; at; at = at.parent) if (at === this) return true;
		return false;
	}
	focus() {
		page.focused = this;
		this.bubble("focusin");
	}
	/** An event that rises from this element through its ancestors' listeners. */
	bubble(type: string) {
		for (let at: El | undefined = this; at; at = at.parent) for (const on of at.handlers[type] ?? []) on({ target: this });
	}
	/** A browser drops the focus from a control that becomes disabled (to the body). */
	get disabled() {
		return this.off;
	}
	set disabled(v: boolean) {
		this.off = v;
		if (v && page.focused === this) page.focused = undefined;
	}
	scrollIntoView() {}
	get textContent(): string {
		return this.kids.map((kid) => (typeof kid === "string" ? kid : kid.textContent)).join("");
	}
	/** A click the way a browser takes it: a disabled control ignores it. */
	click() {
		if (this.disabled) return;
		this.onclick?.();
		this.bubble("click");
	}
	type(text: string) {
		[this.value, this.selectionStart, this.selectionEnd] = [text, text.length, text.length];
		this.oninput?.();
	}
	all(match: (el: El) => boolean): El[] {
		return this.kids.flatMap((kid) => (kid instanceof El ? [...(match(kid) ? [kid] : []), ...kid.all(match)] : []));
	}
}
const page = { addEventListener: (type: string, on: (e: { target: unknown }) => void) => (page.on[type] = on), on: {} as Record<string, (e: { target: unknown }) => void>, body: new El("body"), focused: undefined as El | undefined, createElement: (tag: string) => new El(tag), get activeElement() { return page.focused && page.body.contains(page.focused) ? page.focused : page.body; } };
Object.assign(globalThis, { document: page });
const { mountAsk } = await import("../gui/ask.ts");

const SELECT = { title: "MCP: scratch wants to run echo", choices: [{ label: "Allow once" }, { label: "Allow for session", note: "This exact call" }, { label: "Deny" }] };
const QUESTIONS = [{ question: "Ship it tonight?", header: "Ship", multiple: false, options: [{ title: "Yes" }, { title: "No" }] }, { question: "Who hears about it?", header: "Notify", multiple: true, options: [{ title: "ops" }, { title: "billing" }, { title: "support" }] }];
const approval = (dialog = "m1", callId = dialog): Pending => ({ callId, tool: "dialog", answer: { dialog, digest: selectDigest(SELECT), select: SELECT } });
const questionnaire = (dialog = "q1"): Pending => ({ callId: "c1", tool: "ask_user_question", answer: { dialog, digest: questionsDigest(QUESTIONS), questions: QUESTIONS } });
/** What the server shows for the call while an answer is with its owner (from this page or another one). */
const onItsWay = (callId: string): Pending => ({ callId, tool: "dialog", why: "An answer is on its way; check the terminal." });

let root: El, sent: { action: string; body: Record<string, unknown> }[], replies: ((r: { ok: boolean; status: number; body: Record<string, unknown> }) => void)[];
beforeEach(() => {
	page.body.replaceChildren((root = new El("div")));
	page.focused = undefined;
	[sent, replies] = [[], []];
});
const mount = () => mountAsk(root as unknown as HTMLElement, (action, body) => (sent.push({ action, body }), new Promise((resolve) => replies.push(resolve))), false);
const reply = async (body: Record<string, unknown>, status = 200) => (replies.shift()!({ ok: status < 400, status, body }), await new Promise((done) => setImmediate(done)));
const choices = () => root.all((el) => ["radio", "checkbox"].includes(el.getAttribute("role") ?? ""));
const checked = () => choices().flatMap((el, i) => (el.getAttribute("aria-checked") === "true" ? [i] : []));
const field = (label: string) => root.all((el) => el.getAttribute("aria-label") === label);
const button = (text: string) => root.all((el) => el.tagName === "button" && el.textContent === text)[0];
const status = () => root.all((el) => el.getAttribute("role") === "status")[0]?.textContent;

test("a select keeps its choice and focus through updates for the same dialog: read under another call, or missing from one reading", () => {
	const panel = mount();
	panel.update(approval("m1"), true);
	choices()[1]!.click();
	choices()[1]!.focus();
	// An MCP approval names no tool call: the server reads it under the dialog's id, or under the open call the session file shows.
	panel.update(approval("m1", "toolu_1"), true);
	assert.deepEqual(checked(), [1], "the choice stays");
	assert.equal(page.activeElement, choices()[1], "and so does the focus");
	// A reading where the unit shows no pending (its pane was not bound for a moment), then the same dialog again.
	panel.update(undefined, true);
	panel.update(approval("m1", "toolu_1"), true);
	assert.deepEqual(checked(), [1], "the choice comes back with the dialog");
	assert.equal(page.activeElement, choices()[1], "and the focus with it");
	button("Send answer")!.click();
	assert.deepEqual(sent.map((s) => ({ ...s.body, answerId: typeof s.body.answerId })), [{ dialog: "m1", digest: selectDigest(SELECT), answerId: "string", choice: 1 }]);
});

test("a questionnaire keeps its picks, own words, and notes while another answer is on its way, and gets them back with its focus when the dialog is open again", () => {
	const panel = mount();
	panel.update(questionnaire(), true);
	choices()[0]!.click();
	choices()[3]!.click();
	choices()[4]!.click();
	field("Your own answer")[1]!.type("and the on-call");
	field("Note")[1]!.type("after 22:00");
	field("Note")[1]!.focus();
	panel.update(onItsWay("c1"), true);
	assert.equal(choices().length, 0, "the page shows the dialog read-only meanwhile");
	panel.update(questionnaire(), true);
	assert.deepEqual(checked(), [0, 3, 4]);
	assert.deepEqual(field("Your own answer").map((f) => f.value), ["", "and the on-call"]);
	assert.deepEqual(field("Note").map((f) => f.value), ["", "after 22:00"]);
	assert.equal(page.activeElement, field("Note")[1], "the focus goes back where it was");
	assert.equal(button("Send answer")!.disabled, false);
	button("Send answer")!.click();
	assert.deepEqual(sent[0]!.body.answers, [{ choices: [0] }, { choices: [1, 2], text: "and the on-call", note: "after 22:00" }]);
});

test("a refused answer leaves the panel as the user filled it, with the refusal, whether the reply or the server's read-only echo comes first", async () => {
	const panel = mount();
	panel.update(approval("m1", "toolu_1"), true);
	choices()[2]!.click();
	button("Send answer")!.click();
	panel.update(onItsWay("toolu_1"), true);
	assert.equal(status(), "Sending…", "its own answer on its way keeps the panel");
	await reply({ outcome: "rejected", reason: "not-allowed" });
	panel.update(approval("m1", "toolu_1"), true);
	assert.deepEqual(checked(), [2]);
	assert.equal(status(), "That answer does not fit the question.");
	assert.equal(choices()[2]!.disabled, false, "it can be answered again");
	// Now the echo comes after the reply.
	button("Send answer")!.click();
	await reply({ outcome: "rejected", reason: "digest" });
	panel.update(onItsWay("toolu_1"), true);
	panel.update(approval("m1", "toolu_1"), true);
	assert.deepEqual(checked(), [2]);
	assert.equal(status(), "The question changed; read it again.");
	assert.equal(new Set(sent.map((s) => s.body.answerId)).size, 2, "each Send is its own answer");
});

test("an answer that is not confirmed stays on show through the echo, Check again resends that same answer, and the panel leaves a moment after the unit moves on", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const panel = mount();
		panel.update(approval("m1", "toolu_1"), true);
		choices()[0]!.click();
		button("Send answer")!.click();
		await reply({ outcome: "unknown" });
		panel.update(onItsWay("toolu_1"), true);
		assert.equal(status(), "Not confirmed. Check the terminal.Check again");
		button("Check again")!.click();
		assert.equal(sent[1]!.body.answerId, sent[0]!.body.answerId, "the same answer, never a second one");
		await reply({ outcome: "accepted" });
		assert.equal(status(), "Answered.");
		panel.update(undefined, true);
		assert.equal(status(), "Answered.", "its outcome can still be read");
		mock.timers.tick(6000);
		assert.equal(root.kids.length, 0);
	} finally {
		mock.timers.reset();
	}
});

test("an answer still on its way when another dialog arrives settles on its own panel: the new dialog stays empty and answerable", async () => {
	const panel = mount();
	panel.update(approval("m1"), true);
	choices()[0]!.click();
	button("Send answer")!.click();
	panel.update(approval("m2"), true);
	assert.deepEqual(checked(), []);
	await reply({ outcome: "accepted" });
	assert.equal(status(), "", "m1's outcome is not said under m2");
	assert.equal(choices()[2]!.disabled, false, "nor does it close m2");
	choices()[2]!.click();
	button("Send answer")!.click();
	assert.deepEqual(sent.map((s) => [s.body.dialog, s.body.choice]), [["m1", 0], ["m2", 2]]);
});

test("a different dialog, or the same one with another digest, starts empty, and Send answers the dialog on show", () => {
	const panel = mount();
	panel.update(approval("m1"), true);
	choices()[2]!.click();
	panel.update(approval("m2"), true);
	assert.deepEqual(checked(), [], "nothing picked carries over");
	assert.equal(button("Send answer")!.disabled, true);
	choices()[0]!.click();
	panel.update(onItsWay("m2"), true);
	panel.update(approval("m3"), true);
	assert.deepEqual(checked(), [], "not after a read-only spell either");
	choices()[1]!.click();
	const changed = { ...SELECT, title: "MCP: scratch wants to run echo again" };
	panel.update({ callId: "m3", tool: "dialog", answer: { dialog: "m3", digest: selectDigest(changed), select: changed } }, true);
	assert.deepEqual(checked(), [], "a new digest is a new question");
	choices()[0]!.click();
	button("Send answer")!.click();
	assert.deepEqual([sent[0]!.body.dialog, sent[0]!.body.digest, sent[0]!.body.choice], ["m3", selectDigest(changed), 0]);
});

test("an answer refused as busy closes the panel only while the other answer is on its way: when the dialog is answerable again, so is the panel, with its choice", async () => {
	const panel = mount();
	panel.update(approval("m1"), true);
	choices()[1]!.click();
	button("Send answer")!.click();
	await reply({ outcome: "busy" });
	assert.equal(choices()[0]!.disabled, true, "another answer is on its way");
	panel.update(onItsWay("m1"), true);
	panel.update(approval("m1"), true);
	assert.equal(choices()[0]!.disabled, false, "the other answer was refused: it can be answered here again");
	assert.deepEqual(checked(), [1]);
	button("Send answer")!.click();
	assert.equal(sent.length, 2);
	assert.notEqual(sent[1]!.body.answerId, sent[0]!.body.answerId, "a new answer, since the first was never taken");
});

test("the outcome lingers six seconds after the unit moves on, however often the net updates meanwhile", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const panel = mount();
		panel.update(approval("m1"), true);
		choices()[0]!.click();
		button("Send answer")!.click();
		await reply({ outcome: "accepted" });
		for (let i = 0; i < 3; i++) (panel.update(undefined, true), mock.timers.tick(2000));
		assert.equal(root.kids.length, 0, "cleared six seconds after the unit moved on");
	} finally {
		mock.timers.reset();
	}
});

test("the focus comes back to the control that had it after a brief disconnect, and to Send after a refusal", async () => {
	const panel = mount();
	panel.update(approval("m1"), true);
	choices()[1]!.click();
	choices()[1]!.focus();
	panel.update(approval("m1"), false);
	assert.equal(page.activeElement, page.body, "a disabled control loses the focus");
	panel.update(approval("m1"), true);
	assert.equal(page.activeElement, choices()[1], "and gets it back on reconnecting");
	button("Send answer")!.focus();
	button("Send answer")!.click();
	assert.equal(page.activeElement, page.body);
	await reply({ outcome: "rejected", reason: "not-allowed" });
	assert.equal(page.activeElement, button("Send answer"), "Send has it again after the refusal");
	page.focused = undefined; // the user clicks elsewhere on the page
	panel.update(approval("m1"), true);
	assert.equal(page.activeElement, page.body, "a focus the user moved away is not taken back by the next update");
});

test("busy after the other answer's read-only echo came before the reply still lets the panel answer again once the dialog is open", async () => {
	const panel = mount();
	panel.update(approval("m1"), true);
	choices()[0]!.click();
	button("Send answer")!.click();
	panel.update(onItsWay("m1"), true);
	await reply({ outcome: "busy" });
	panel.update(approval("m1"), true);
	assert.equal(choices()[0]!.disabled, false);
	assert.deepEqual(checked(), [0]);
});

test("a click on the page outside the panel keeps the focus where the user put it when the panel is enabled again", () => {
	const panel = mount();
	panel.update(approval("m1"), true);
	choices()[1]!.focus();
	panel.update(approval("m1"), false);
	page.on.pointerdown!({ target: page.body });
	panel.update(approval("m1"), true);
	assert.equal(page.activeElement, page.body);
});

test("a read-only panel offers Show terminal (the session's mirror); a secret and an answerable dialog do not", () => {
	let shown = 0;
	const ask = mountAsk(root as unknown as HTMLElement, async () => ({ ok: true, status: 200, body: {} }), false, () => void shown++);
	const button = () => root.all((el) => el.textContent === "Show terminal")[0];
	ask.update({ callId: "c1", tool: "ask_user", why: "It waits on a dialog." }, true);
	button()!.click();
	assert.equal(shown, 1);
	ask.update({ callId: "c2", tool: "secret_drop", why: "It waits for a secret." }, true);
	assert.equal(button(), undefined, "a secret's screen stays hidden");
	ask.update(approval(), true);
	assert.equal(button(), undefined, "an answerable dialog answers itself");
});

// The keyboard: which control takes the focus on opening, and where the arrows, Tab, Shift+Tab, Enter, and Space go (gui/askkeys.ts).
const four = [1, 2, 3, 4].map((n) => ({ question: `Q${n}?`, header: `Q${n}`, multiple: n === 4, options: [{ title: `a${n}` }, { title: `b${n}` }, { title: `c${n}` }] }));
const asking = (questions: typeof QUESTIONS): Pending => ({ callId: "c9", tool: "ask_user_question", answer: { dialog: "k1", digest: questionsDigest(questions), questions } });
const focused = () => (page.activeElement as El).getAttribute("aria-label") ?? (page.activeElement as El).textContent;
/** One keydown the way the page takes it: the panel's listeners, then the browser's own activation (a click) when nobody took Enter or Space on a button. */
function press(target: El, key: string, over: Record<string, unknown> = {}) {
	const e = { key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, repeat: false, target, taken: false, ...over, preventDefault() { this.taken = true; } };
	for (const on of (root.kids[0] as El).handlers.keydown ?? []) on(e);
	if (!e.taken && target.tagName === "button" && [" ", "Enter"].includes(key)) target.click();
	return e;
}
const on = (el: El) => (el.focus(), el);
const tabs = () => choices().map((el) => el.getAttribute("tabindex"));

test("a panel with a question takes the focus on its first option, or the chosen one; a read-only or finished panel does not", async () => {
	const panel = mount();
	panel.update(approval("m1"), true);
	assert.equal(panel.enter(), true);
	assert.equal(page.activeElement, choices()[0], "the first choice");
	choices()[2]!.click();
	assert.equal(panel.enter(), true);
	assert.equal(page.activeElement, choices()[2], "the chosen one");
	panel.update(questionnaire("q1"), true);
	choices()[1]!.click();
	choices()[3]!.focus();
	assert.equal(panel.enter(), true);
	assert.equal(page.activeElement, choices()[1], "the first question's chosen option, not the second question's");
	page.focused = undefined;
	panel.update(onItsWay("c1"), true);
	assert.equal(panel.enter(), false, "a read-only panel has nothing to answer");
	assert.equal(page.activeElement, page.body);
	panel.update(approval("m2"), false);
	assert.equal(panel.enter(), false, "its controls are disabled while the stream is down");
	panel.update(approval("m3"), true);
	choices()[0]!.click();
	button("Send answer")!.click();
	await reply({ outcome: "accepted" });
	assert.equal(panel.enter(), false, "an answered one takes no more");
	assert.equal(mount().enter(), false, "nothing on show");
});

test("a select: arrows move and select (a radio group), Enter or Space confirms and goes to Send, Tab is the browser's", () => {
	const panel = mount();
	panel.update(approval(), true);
	const [a, b, c] = choices() as [El, El, El], send = button("Send answer")!;
	assert.deepEqual(tabs(), ["0", "-1", "-1"], "one tab stop in the group");
	on(a);
	assert.equal(press(a, "ArrowDown").taken, true);
	assert.deepEqual([page.activeElement, checked()], [b, [1]], "moving selects");
	assert.deepEqual(tabs(), ["-1", "0", "-1"], "the tab stop follows");
	press(b, "ArrowRight");
	assert.deepEqual([page.activeElement, checked()], [c, [2]]);
	assert.equal(press(c, "ArrowDown").taken, true, "the end is taken, so the page does not scroll");
	assert.deepEqual([page.activeElement, checked()], [c, [2]]);
	press(c, "ArrowLeft");
	press(b, "ArrowUp");
	assert.deepEqual([page.activeElement, checked()], [a, [0]]);
	assert.equal(press(a, "Tab").taken, false, "Tab goes on in the page's order");
	assert.equal(press(a, "Tab", { shiftKey: true }).taken, false);
	press(a, "Enter");
	assert.deepEqual([page.activeElement, checked()], [send, [0]], "Enter confirms the option and goes to Send");
	on(b);
	assert.equal(press(b, " ").taken, true);
	assert.deepEqual([page.activeElement, checked()], [send, [1]], "so does Space");
	assert.equal(press(send, "Enter").taken, false, "Enter on Send is the button's own");
	assert.deepEqual(sent.map((s) => s.body.choice), [1]);
});

test("two questions: arrows select in a single choice and only move in a multiple one (Space toggles), Tab and Shift+Tab walk the questions, Enter goes on", () => {
	const panel = mount();
	panel.update(questionnaire(), true);
	const [yes, no, ops, billing, support] = choices() as [El, El, El, El, El], send = button("Send answer")!;
	assert.equal(panel.enter(), true);
	assert.equal(page.activeElement, yes);
	press(yes, "ArrowDown");
	assert.deepEqual([page.activeElement, checked()], [no, [1]]);
	assert.equal(press(no, "Tab").taken, true);
	assert.equal(page.activeElement, ops, "Tab goes to the next question's first option");
	assert.equal(press(ops, "Tab", { shiftKey: true }).taken, true);
	assert.equal(page.activeElement, no, "and Shift+Tab to the previous one's chosen option");
	press(no, "Tab");
	press(ops, "ArrowDown");
	assert.deepEqual([page.activeElement, checked()], [billing, [1]], "a multiple choice moves the focus without choosing");
	press(billing, "Enter");
	assert.deepEqual([page.activeElement, checked()], [billing, [1]], "Enter on it chooses nothing, and with nothing else unanswered Send is still disabled, so the focus stays");
	assert.equal(press(billing, " ").taken, false, "Space is the button's own: it toggles");
	assert.deepEqual(checked(), [1, 3]);
	press(support, "Enter");
	assert.deepEqual(checked(), [1, 3], "Enter does not toggle");
	assert.equal(page.activeElement, send, "all answered: Enter goes on to Send");
	assert.equal(press(on(support), "Tab").taken, false, "from the last question Tab is the browser's: its own words, then Send");
	assert.equal(press(support, "Tab", { shiftKey: true }).taken, true);
	assert.equal(page.activeElement, no, "Shift+Tab from the last question goes back to the one before");
	press(on(yes), "Enter");
	assert.deepEqual([page.activeElement, checked()], [send, [0, 3]], "Enter on a single choice confirms it, and with nothing left unanswered goes to Send");
	press(yes, "Tab", { shiftKey: true });
	assert.equal(press(yes, "Tab", { shiftKey: true }).taken, false, "Shift+Tab leaves the first question the browser's way");
});

test("four questions: Enter goes to the next unanswered one (round the end too), then Send; Tab and Shift+Tab walk all four", () => {
	const panel = mount();
	panel.update(asking(four), true);
	const opts = (q: number) => choices().slice(q * 3, q * 3 + 3);
	assert.equal(panel.enter(), true);
	assert.equal(page.activeElement, opts(0)[0]);
	for (let q = 0; q < 3; q++) press(opts(q)[0]!, "Tab");
	assert.equal(page.activeElement, opts(3)[0], "Tab walked 1 to 4");
	assert.equal(press(opts(3)[0]!, "Tab").taken, false, "the last one lets Tab go on");
	for (let q = 3; q > 0; q--) press(opts(q)[0]!, "Tab", { shiftKey: true });
	assert.equal(page.activeElement, opts(0)[0], "Shift+Tab walked back to 1");
	// Question 3 is answered first: Enter on 1 goes to 2, Enter on 2 skips 3 to 4.
	opts(2)[1]!.click();
	press(opts(0)[1]!, "Enter");
	assert.deepEqual([page.activeElement, checked()], [opts(1)[0], [1, 7]]);
	press(opts(1)[0]!, "Enter");
	assert.equal(page.activeElement, opts(3)[0], "question 3 is skipped");
	opts(3)[2]!.click();
	press(opts(3)[2]!, "Enter");
	assert.equal(page.activeElement, button("Send answer"), "after the last, Send");
	assert.equal(button("Send answer")!.disabled, false);
});

test("Enter on a later question goes back round to an earlier unanswered one while Send is disabled", () => {
	const panel = mount();
	panel.update(asking(four), true);
	const opts = (q: number) => choices().slice(q * 3, q * 3 + 3);
	for (const q of [1, 2]) opts(q)[0]!.click();
	opts(3)[0]!.click();
	press(on(opts(3)[0]!), "Enter");
	assert.equal(page.activeElement, opts(0)[0], "question 1 is still open");
	assert.equal(button("Send answer")!.disabled, true);
	press(opts(0)[2]!, "Enter");
	assert.equal(page.activeElement, button("Send answer"));
});

test("the own-words box: Enter goes on like Enter on an option, Shift+Enter is a new line, the caret keeps its keys, and Down past the last option reaches it", () => {
	const panel = mount();
	panel.update(questionnaire(), true);
	const [, , ops, , support] = choices() as [El, El, El, El, El], [own1, own2] = field("Your own answer") as [El, El];
	assert.equal(own1.tagName, "textarea", "a box that holds a line break");
	on(support);
	assert.equal(press(support, "ArrowDown").taken, true);
	assert.equal(page.activeElement, own2, "Down from the last option reaches the question's own words");
	assert.equal(press(own2, "ArrowUp").taken, true);
	assert.equal(page.activeElement, support, "Up goes back to its last option");
	on(own2);
	own2.type("both");
	assert.equal(press(own2, "ArrowLeft").taken, false);
	assert.equal(press(own2, "ArrowRight").taken, false);
	assert.equal(press(own2, "ArrowUp").taken, false, "Up with the caret at the end is the caret's");
	own2.type("one\ntwo");
	own2.selectionStart = own2.selectionEnd = 0;
	assert.equal(press(own2, "ArrowDown").taken, false, "so is Down away from the end");
	own2.selectionStart = own2.selectionEnd = own2.value.length;
	assert.equal(press(own2, "ArrowDown").taken, true);
	assert.equal(page.activeElement, field("Note")[1], "Down at the end goes to the note");
	assert.equal(press(field("Note")[1]!, "ArrowUp").taken, true);
	assert.equal(page.activeElement, own2);
	assert.equal(press(own2, "Enter", { shiftKey: true }).taken, false, "Shift+Enter is the box's own new line");
	assert.equal(press(own2, "Enter", { isComposing: true }).taken, false, "an input method's Enter is its own");
	assert.equal(page.activeElement, own2);
	choices()[1]!.click();
	press(on(own2), "Enter");
	assert.equal(page.activeElement, button("Send answer"), "Enter in the box with every question answered goes to Send");
	assert.deepEqual(own1.value, "");
	on(own1).type("first");
	press(own1, "Enter");
	assert.equal(page.activeElement, button("Send answer"));
	press(on(own1), "Tab");
	assert.equal(page.activeElement, ops, "Tab out of an earlier question's box goes to the next question");
});

test("keys that carry Ctrl, Alt, or ⌘, a held Enter, and keys outside the form are left alone; Space's release is swallowed once it moved the focus", () => {
	const panel = mount();
	panel.update(asking(four), true);
	const a1 = on(choices()[0]!);
	for (const over of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]) assert.equal(press(a1, "ArrowDown", over).taken, false);
	assert.equal(press(a1, "ArrowDown", { shiftKey: true }).taken, false, "Shift with an arrow is not ours");
	assert.deepEqual([page.activeElement, checked()], [a1, []]);
	assert.equal(press(button("Send answer")!, "ArrowDown").taken, false, "Send is the browser's");
	for (const target of [a1, field("Your own answer")[0]!, field("Note")[0]!]) assert.equal(press(target, "Escape").taken, false, "Escape stays the page's: it closes the card");
	assert.equal(press(a1, "Enter", { repeat: true }).taken, true);
	assert.deepEqual([page.activeElement, checked()], [a1, []], "a held Enter does not carry on through the questions");
	assert.equal(press(a1, " ").taken, true);
	assert.deepEqual([page.activeElement, checked()].map(String), [String(choices()[3]), "0"]);
	const up = { key: " ", taken: false, preventDefault() { this.taken = true; } };
	for (const on of (root.kids[0] as El).handlers.keyup ?? []) on(up);
	assert.equal(up.taken, true, "the release of the Space that moved on does not click anything");
	const again = { key: " ", taken: false, preventDefault() { this.taken = true; } };
	for (const on of (root.kids[0] as El).handlers.keyup ?? []) on(again);
	assert.equal(again.taken, false);
});

const SECRET = { label: "Deploy token", instructions: ["Open the link.", "Create a token with the deploy scope."], url: "https://example.com/tokens", destination: ".env.local (DEPLOY_TOKEN)" };
const secretWait = (dialog = "s1", secret = SECRET): Pending => ({ callId: "c1", tool: "secret_drop", answer: { dialog, digest: secretDigest(secret), secret } });
/** A page whose post copies the body the way a real post turns it into JSON, before the panel can touch it again. */
const mountOn = (remote: boolean) => mountAsk(root as unknown as HTMLElement, (action, body) => (sent.push({ action, body: JSON.parse(JSON.stringify(body)) }), new Promise((resolve) => replies.push(resolve))), remote);
const secretField = () => field("Secret")[0]!;
/** The page's whole text and attributes, to look for a value anywhere in it. */
const dump = (el: El): string => `${[...el.attrs.values()].join("|")}|${el.value}|${el.kids.map((k) => (typeof k === "string" ? k : dump(k))).join("|")}`;

test("a secret: the label, steps, link, and destination show with a masked field; Submit sends the value once, the field is cleared before the reply, and it is never shown back", async () => {
	const panel = mountOn(false), value = "tok-panel-5521-not-shown";
	panel.update(secretWait(), true);
	assert.equal(panel.enter(), true);
	assert.equal(page.activeElement, secretField(), "the card opens on the masked field");
	assert.deepEqual([secretField().getAttribute("type"), secretField().getAttribute("data-masked"), secretField().getAttribute("autocomplete"), secretField().getAttribute("spellcheck"), secretField().getAttribute("autocorrect")], ["text", "true", "off", "false", "off"], "dots drawn by CSS: never type=password or new-password, which make a browser offer to save or suggest a password");
	assert.match(root.textContent, /Deploy token/);
	assert.match(root.textContent, /Create a token with the deploy scope\./);
	assert.match(root.textContent, /\.env\.local \(DEPLOY_TOKEN\)/);
	const link = root.all((el) => el.tagName === "a")[0]!;
	assert.deepEqual([link.getAttribute("href"), link.getAttribute("rel"), link.getAttribute("target")], ["https://example.com/tokens", "noopener noreferrer", "_blank"]);
	assert.equal(button("Submit")!.disabled, true, "nothing typed yet");
	secretField().type("   ");
	assert.equal(button("Submit")!.disabled, true, "blank is nothing");
	secretField().type(value);
	assert.equal(button("Submit")!.disabled, false);
	button("Submit")!.click();
	assert.deepEqual(sent.map((s) => s.body), [{ dialog: "s1", digest: secretDigest(SECRET), answerId: sent[0]!.body.answerId, value }]);
	assert.equal(secretField().value, "", "cleared as soon as it is sent, before the reply");
	assert.equal(secretField().disabled, true, "and locked while the answer is on its way");
	assert.equal(dump(root).includes(value), false);
	await reply({ outcome: "accepted" });
	assert.equal(status(), "Answered.");
	assert.equal(dump(root).includes(value), false, "nothing on the page holds it after the reply");
	assert.equal(button("Submit")!.disabled, true, "answered: nothing more from here");
});

test("a secret refused stays answerable with an empty field; one not confirmed offers no Check again, since the value is gone", async () => {
	const panel = mountOn(false);
	panel.update(secretWait(), true);
	secretField().type("first-try");
	button("Submit")!.click();
	await reply({ outcome: "rejected", reason: "digest" });
	assert.equal(status(), "The question changed; read it again.");
	assert.equal(secretField().value, "");
	assert.equal(secretField().disabled, false, "it can be typed again");
	secretField().type("second-try");
	button("Submit")!.click();
	assert.deepEqual(sent.map((s) => s.body.value), ["first-try", "second-try"]);
	assert.notEqual(sent[0]!.body.answerId, sent[1]!.body.answerId, "each Submit is its own answer");
	await reply({ outcome: "unknown" });
	assert.equal(status(), "Not confirmed. Check the terminal.", "no Check again");
	assert.equal(button("Check again"), undefined);
	assert.equal(button("Submit")!.disabled, true);
	assert.equal(sent.length, 2, "nothing is ever resent");
});

test("a secret that failed to send (a network error) says it is not confirmed and holds no value", async () => {
	const panel = mountAsk(root as unknown as HTMLElement, async () => { throw new Error("offline"); }, false);
	panel.update(secretWait(), true);
	secretField().type("lost-in-transit");
	button("Submit")!.click();
	await new Promise((done) => setImmediate(done));
	assert.equal(status(), "Not confirmed. Check the terminal.");
	assert.equal(dump(root).includes("lost-in-transit"), false);
});

test("Show reveals the field and Hide masks it again; Answer in the terminal instead clears it, sends nothing, and locks the panel", () => {
	const panel = mountOn(false);
	panel.update(secretWait(), true);
	secretField().type("peek");
	button("Show")!.click();
	assert.deepEqual([secretField().getAttribute("type"), secretField().getAttribute("data-masked")], ["text", "false"]);
	assert.equal(button("Hide")!.getAttribute("aria-pressed"), "true");
	button("Hide")!.click();
	assert.deepEqual([secretField().getAttribute("type"), secretField().getAttribute("data-masked")], ["text", "true"]);
	button("Show")!.click();
	button("Answer in the terminal instead")!.click();
	assert.deepEqual([secretField().value, secretField().getAttribute("data-masked"), sent.length], ["", "true", 0], "cleared and masked again");
	assert.match(status() ?? "", /Nothing was sent/);
	assert.deepEqual([secretField().disabled, button("Submit")!.disabled], [true, true]);
});

test("the Enter key in the field submits, an input method's composing Enter does not", () => {
	const panel = mountOn(false);
	panel.update(secretWait(), true);
	const keys = secretField() as unknown as { onkeydown: (e: { key: string; isComposing?: boolean }) => void };
	secretField().type("by-keyboard");
	keys.onkeydown({ key: "Enter", isComposing: true });
	keys.onkeydown({ key: "a" });
	assert.equal(sent.length, 0);
	keys.onkeydown({ key: "Enter" });
	assert.deepEqual(sent.map((s) => s.body.value), ["by-keyboard"]);
});

test("a remote page shows no field: for security, remote entry is unsupported; it names the terminal, even if an answerable secret reached it", () => {
	const panel = mountOn(true), unsupported = "For security, entering a secret is not supported remotely. Answer it in the terminal on the computer the GUI runs on.";
	panel.update({ callId: "c1", tool: "secret_drop", why: "Entering a secret is not supported from a remote page; answer it in the terminal." }, true);
	assert.equal(field("Secret").length, 0);
	assert.match(root.textContent, new RegExp(unsupported.replace(/[.]/g, "\\.")));
	assert.match(root.textContent, /Answer it in the terminal\./);
	assert.equal(button("Submit"), undefined);
	panel.update(secretWait("s2"), true);
	assert.equal(field("Secret").length, 0, "whatever it was sent, a remote page does not draw the field");
	assert.equal(panel.enter(), false, "and has nothing to put the focus on");
	assert.equal(button("Show terminal"), undefined, "a secret's mirror stays hidden");
});

test("the remote notice is said in every locale the page ships, and Traditional Chinese says 安全考量，遠端不支援", async () => {
	const { locales } = await import("../gui/paraglide/runtime.js");
	for (const locale of locales) assert.ok(m.secret_remote({}, { locale }).length > 10, locale);
	assert.match(m.secret_remote({}, { locale: "zh-TW" }), /^安全考量，遠端不支援/);
});
