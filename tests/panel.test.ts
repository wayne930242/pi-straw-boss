import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { Pending } from "../src/ask.ts";
import type { Net } from "../src/net.ts";
import { questionsDigest, selectDigest } from "../src/owners.ts";
import { m } from "../gui/paraglide/messages.js";
import { El, page } from "./fake-dom.ts";

// The answer panel (gui/ask.ts) as the page drives it: the server's updates arrive while the user picks, types, and notes, and the panel
// keeps all of that for the dialog the user is filling. The updates are the ones the server really sends (dialogs.ts merge): the same
// dialog read under another call, a read-only spell while an answer is on its way, a reading where the unit shows no pending at all.

const { mountAsk } = await import("../gui/ask.ts");
const { onStep, openThen } = await import("../gui/terminalthen.ts");

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
	for (const on of page.on.pointerdown ?? []) on({ target: page.body });
	panel.update(approval("m1"), true);
	assert.equal(page.activeElement, page.body);
});

test("a read-only panel offers Show terminal (the session's mirror); a secret and an answerable dialog do not", () => {
	let shown = 0;
	const ask = mountAsk(root as unknown as HTMLElement, async () => ({ ok: true, status: 200, body: {} }), false, { key: "S", show: () => void shown++ });
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

test("two questions: arrows select in a single choice and only move in a multiple one (Space toggles), Tab and Shift+Tab walk the questions and their boxes, Enter goes on", () => {
	const panel = mount();
	panel.update(questionnaire(), true);
	const [yes, no, ops, billing, support] = choices() as [El, El, El, El, El], send = button("Send answer")!;
	assert.equal(panel.enter(), true);
	assert.equal(page.activeElement, yes);
	press(yes, "ArrowDown");
	assert.deepEqual([page.activeElement, checked()], [no, [1]]);
	const [note1, note2] = field("Note") as [El, El];
	assert.equal(press(no, "Tab").taken, false, "Tab from an option is the browser's: on to the question's own words, then its note");
	assert.equal(press(field("Your own answer")[0]!, "Tab").taken, false);
	assert.equal(press(note1, "Tab").taken, true);
	assert.equal(page.activeElement, ops, "Tab from the question's last box goes to the next question's first option");
	assert.equal(press(ops, "Tab", { shiftKey: true }).taken, true);
	assert.equal(page.activeElement, note1, "and Shift+Tab to the last box of the question before");
	assert.equal(press(note1, "Tab", { shiftKey: true }).taken, false, "from a box it is the browser's: back to the box and the option before");
	press(note1, "Tab");
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
	assert.equal(page.activeElement, note1, "Shift+Tab from the last question goes back to the one before");
	assert.equal(press(note2, "Tab").taken, false, "from the last question's note Tab is the browser's: on to Send");
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
	for (let q = 0; q < 3; q++) press(field("Note")[q]!, "Tab");
	assert.equal(page.activeElement, opts(3)[0], "Tab walked 1 to 4");
	assert.equal(press(opts(3)[0]!, "Tab").taken, false, "the last one lets Tab go on");
	for (let q = 3; q > 0; q--) press(opts(q)[0]!, "Tab", { shiftKey: true });
	assert.equal(page.activeElement, field("Note")[0], "Shift+Tab walked back to the end of 1");
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
	assert.equal(press(on(own1), "Tab").taken, false, "Tab out of the own words is the browser's: the note is next");
	press(on(field("Note")[0]!), "Tab");
	assert.equal(page.activeElement, ops, "Tab out of an earlier question's last box goes to the next question");
});

test("keys that carry Ctrl, Alt, or ⌘, a held Enter, and keys outside the form are left alone; Space's release is swallowed once it moved the focus or when the form never saw its press", () => {
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
	assert.equal(again.taken, true, "a release whose press the form never saw (it went to the page while the Zen card was inert) clicks nothing either: Firefox would pick the choice the focus just landed on (zbf-rr-F001)");
	assert.equal(press(on(field("Your own answer")[0]!), " ").taken, false, "a space typed in the box is the box's");
	const typed = { key: " ", taken: false, preventDefault() { this.taken = true; } };
	for (const on of (root.kids[0] as El).handlers.keyup ?? []) on(typed);
	assert.equal(typed.taken, false, "the release of a Space the form saw and left alone stays the browser's");
});

/** A page whose post copies the body the way a real post turns it into JSON, before the panel can touch it again. */
const mountOn = (remote: boolean) => mountAsk(root as unknown as HTMLElement, (action, body) => (sent.push({ action, body: JSON.parse(JSON.stringify(body)) }), new Promise((resolve) => replies.push(resolve))), remote);
const SECRET = { label: "Deploy token", instructions: ["Open the link."], destination: ".env.local" };
/** What an older server might still send: an answerable secret. The page draws no field for it either (SB-F001). */
const secretWait = (): Pending => ({ callId: "c1", tool: "secret_drop", answer: { dialog: "s1", digest: "0".repeat(64), secret: SECRET } as never });

test("a secret_drop wait is read-only on this computer's page: it says to enter the secret in the terminal, and draws no field, Submit, or Show terminal", () => {
	const panel = mountOn(false), terminalOnly = "A secret is entered in the terminal only, not here. Answer it in the terminal on the computer the GUI runs on.";
	for (const pending of [{ callId: "c1", tool: "secret_drop", why: "It waits for a secret." }, secretWait()]) {
		panel.update(pending, true);
		assert.equal(field("Secret").length, 0);
		assert.equal(root.all((el) => el.tagName === "input" || el.tagName === "textarea").length, 0, "nothing to type into");
		assert.match(root.textContent, new RegExp(terminalOnly.replace(/[.]/g, "\\.")));
		assert.match(root.textContent, /Answer it in the terminal\./);
		assert.doesNotMatch(root.textContent, /Deploy token|\.env\.local/, "what it asks for is not drawn");
		assert.equal(button("Submit"), undefined);
		assert.equal(button("Show terminal"), undefined, "a secret's mirror stays hidden");
		assert.equal(panel.enter(), false, "and there is nothing to put the focus on");
	}
	assert.deepEqual(sent, [], "nothing is ever posted");
});

test("a remote page keeps its wording: for security, remote entry is unsupported; it names the terminal", () => {
	const panel = mountOn(true), unsupported = "For security, entering a secret is not supported remotely. Answer it in the terminal on the computer the GUI runs on.";
	for (const pending of [{ callId: "c1", tool: "secret_drop", why: "It waits for a secret." }, secretWait()]) {
		panel.update(pending, true);
		assert.equal(field("Secret").length, 0);
		assert.match(root.textContent, new RegExp(unsupported.replace(/[.]/g, "\\.")));
		assert.match(root.textContent, /Answer it in the terminal\./);
		assert.equal(button("Submit"), undefined);
		assert.equal(button("Show terminal"), undefined);
	}
});

test("both notices are said in every locale the page ships; Traditional Chinese says 安全考量，遠端不支援 for remote and names the terminal for this computer", async () => {
	const { locales } = await import("../gui/paraglide/runtime.js");
	for (const locale of locales) for (const say of [m.secret_remote, m.secret_terminal]) assert.ok(say({}, { locale }).length > 10, locale);
	assert.match(m.secret_remote({}, { locale: "zh-TW" }), /^安全考量，遠端不支援/);
	assert.match(m.secret_terminal({}, { locale: "zh-TW" }), /終端機輸入/);
	assert.match(m.secret_terminal({}, { locale: "en" }), /terminal only/);
});

// A confirm (ctx.ui.confirm relayed as Yes and No) is answerable on this computer's page only: a paired device's page reads it and says where to answer.
const CONFIRM = { title: "mp-infra command review\n\nssh box ls", choices: [{ label: "Yes" }, { label: "No" }], confirm: true as const };
const confirming = (): Pending => ({ callId: "c1", tool: "bash", answer: { dialog: "u1", digest: selectDigest(CONFIRM), select: CONFIRM } });

test("a confirmation is answerable with Yes and No on this computer's page and on a paired device's page alike", () => {
	for (const remote of [false, true]) {
		const answering = mountAsk((root = new El("div")) as unknown as HTMLElement, (action, body) => (sent.push({ action, body }), new Promise((resolve) => replies.push(resolve))), remote);
		page.body.replaceChildren(root);
		answering.update(confirming(), true);
		assert.deepEqual(choices().map((el) => el.textContent), ["Yes", "No"], `remote ${remote}`);
		assert.ok(button("Send answer"), "and Send");
		assert.match(root.textContent, /mp-infra command review/);
		assert.equal(answering.enter(), true);
	}
});

// Cancel: a button for a dialog whose owner takes a cancel, no pick needed; it ends the dialog the way Escape does in the terminal.
const cancelling = (extra: Partial<NonNullable<Pending["answer"]>> = {}, base = approval()): Pending => ({ ...base, answer: { ...base.answer!, cancel: true, ...extra } });
const cancelButton = () => button("Cancel");

test("a dialog whose owner takes a cancel has a Cancel button beside Send, usable with nothing picked; it posts only the dialog, digest, a fresh answerId, and cancel: true, and the card says Cancelled", async () => {
	const panel = mountOn(false);
	panel.update(approval(), true);
	assert.equal(cancelButton(), undefined, "an owner with no cancel path (robot_hand, pi-code) gets none");
	panel.update(cancelling({ dialog: "m2" }), true);
	assert.ok(cancelButton(), "Cancel");
	assert.equal(button("Send answer")!.disabled, true, "Send waits for a pick");
	assert.equal(cancelButton()!.disabled, false, "Cancel needs none");
	cancelButton()!.click();
	assert.equal(sent.length, 1);
	assert.deepEqual({ ...sent[0]!.body, answerId: typeof sent[0]!.body.answerId }, { dialog: "m2", digest: selectDigest(SELECT), answerId: "string", cancel: true });
	assert.equal(cancelButton()!.disabled, true, "and nothing else is sent while it is on its way");
	await reply({ outcome: "accepted" });
	assert.equal(status(), "Cancelled.");
	assert.equal(cancelButton()!.disabled, true, "a dialog that ended takes no further answer");
	assert.equal(button("Send answer")!.disabled, true);
});

test("Cancel on a questionnaire, a confirm, and a dialog the terminal closed first: the questionnaire needs no answers; a stale cancel reads the existing closed wording", async () => {
	const panel = mountOn(false);
	panel.update(cancelling({}, questionnaire()), true);
	cancelButton()!.click();
	assert.deepEqual(Object.keys(sent[0]!.body).sort(), ["answerId", "cancel", "dialog", "digest"]);
	await reply({ outcome: "stale", by: "cancel" });
	assert.equal(status(), "It was dismissed in the terminal.");
	panel.update(undefined, true);
	panel.update(cancelling({ dialog: "u1", digest: selectDigest(CONFIRM), select: CONFIRM }, confirming()), true);
	assert.deepEqual(choices().map((el) => el.textContent), ["Yes", "No"]);
	cancelButton()!.click();
	await reply({ outcome: "accepted" });
	assert.equal(status(), "Cancelled.");
});

test("a paired device's page hides Cancel where every choice is hereOnly and shows it where it may pick some choice; a disabled page disables it", () => {
	const here = { title: "Rotate?", choices: [{ label: "Yes", hereOnly: true as const }, { label: "No", hereOnly: true as const }], confirm: true as const };
	const link = { title: "Link request", choices: [{ label: "Approve", hereOnly: true as const }, { label: "Deny" }] };
	const dialog = (select: typeof here | typeof link): Pending => ({ callId: "c1", tool: "link_request", answer: { dialog: "h1", digest: selectDigest(select), select, cancel: true } });
	const remote = mountOn(true);
	remote.update(dialog(here), true);
	assert.equal(cancelButton(), undefined, "refused by the server there (403 local_only): not drawn");
	remote.update(dialog(link), true);
	assert.ok(cancelButton(), "Deny stays pickable, so cancelling it is a refusal a paired device may give");
	remote.update(undefined, true);
	page.body.replaceChildren((root = new El("div")));
	const local = mountOn(false);
	local.update(dialog(here), true);
	assert.ok(cancelButton(), "this computer's page cancels it");
	local.update(dialog(here), false);
	assert.equal(cancelButton()!.disabled, true, "disabled while the stream is down");
});

test("Cancel is said in every locale the page ships; Traditional Chinese says 取消 and 已取消", async () => {
	const { locales } = await import("../gui/paraglide/runtime.js");
	for (const locale of locales) for (const say of [m.cancel, m.cancelled]) assert.ok(say({}, { locale }).length > 1, locale);
	assert.deepEqual([m.cancel({}, { locale: "zh-TW" }), m.cancelled({}, { locale: "zh-TW" })], ["取消", "已取消。"]);
});

test("a dialog relayed from ctx.ui says it was opened while the call ran, not that it belongs to it", () => {
	const local = mountAsk(root as unknown as HTMLElement, () => new Promise(() => {}), false);
	local.update({ ...confirming(), answer: { ...confirming().answer!, twin: true } }, true);
	assert.match(root.textContent, /Opened while bash was running; it may not be about that call\./);
	local.update({ ...confirming(), answer: { ...confirming().answer!, dialog: "u2" } }, true);
	assert.doesNotMatch(root.textContent, /Opened while/, "an owner's own dialog does not say so");
});

test("the dismiss-all button counts the finished subagents the server would dismiss, and says so in every locale", async () => {
	const { endedSubs } = await import("../gui/quit.ts");
	const { locales } = await import("../gui/paraglide/runtime.js");
	const sub = (key: string, ended?: boolean) => ({ id: key, key, control: true, name: key, role: "subagent" as const, mark: "done" as const, subs: [], ...(ended && { ended: true }) });
	const unit = (key: string, subs: ReturnType<typeof sub>[]) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "idle" as const, subs });
	const net = { bases: [
		{ id: "w1", label: "one", tower: unit("t", [sub("t-done", true)]), tabs: [{ id: "t1", label: "a", units: [unit("u1", [sub("a", true), sub("b"), sub("c", true)]), unit("u2", [])] }], outside: [unit("o", [sub("o-done", true)])] },
		{ id: "w2", label: "two", tabs: [], outside: [] },
	] } as unknown as Net;
	assert.deepEqual(endedSubs(net), ["t-done", "a", "c", "o-done"], "finished subagents only, a running one stays");
	for (const locale of locales) assert.match(m.dismiss_all({ count: 3 }, { locale }), /3/, locale);
});

test("Dismiss finished takes the ally boxes' finished subagents too: the server's all for this computer's, one key each for a live box that lists dismiss, and the count leaves out what no press can hide", async () => {
	const { endedSubs, dismissFinished } = await import("../gui/quit.ts");
	const sub = (key: string, ended?: boolean) => ({ id: key, key, control: true, name: key, role: "subagent" as const, mark: "done" as const, subs: [], ...(ended && { ended: true }) });
	const main = (key: string, subs: ReturnType<typeof sub>[]) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "idle" as const, subs });
	const box = (state: "live" | "unreachable", can: string[]) => ({ device: "d", short: "s", label: "agent-tower-01", team: "t", scope: "team", state, can });
	const base = (id: string, subs: ReturnType<typeof sub>[], b?: ReturnType<typeof box>) => ({ id, label: id, mark: "idle", tower: null, outposts: [], outside: [], tabs: [{ id: `${id}-t`, label: "a", units: [main(`${id}-m`, subs)] }], ...(b && { box: b }) });
	const net = { bases: [
		base("w1", [sub("local-done", true), sub("local-run")]),
		base("b1", [sub("ally-done-1", true), sub("ally-done-2", true), sub("ally-run")], box("live", ["dismiss", "input"])),
		base("b2", [sub("deaf-done", true)], box("live", ["input"])),
		base("b3", [sub("away-done", true)], box("unreachable", ["dismiss"])),
	] } as unknown as Net;
	assert.deepEqual(endedSubs(net), ["local-done", "ally-done-1", "ally-done-2"], "a box that does not list dismiss, or is not live, takes none: they are not counted");
	const sent: unknown[] = [];
	assert.equal(await dismissFinished(net, (body) => (sent.push(body), Promise.resolve(true))), true);
	assert.deepEqual(sent, [{ all: true }, { key: "ally-done-1" }, { key: "ally-done-2" }], "this computer's by the server's all, each ally's by its own key, as one row's Dismiss sends");
	const refused: unknown[] = [];
	assert.equal(await dismissFinished(net, (body) => (refused.push(body), Promise.resolve("key" in body ? false : true))), false, "a refusal is the answer");
	assert.deepEqual(refused, [{ all: true }, { key: "ally-done-1" }], "the first refusal says why once and stops the rest");
});

test("an accepted answer that leaves a step in a terminal opens its card (the one rule, terminalthen.ts): a prompt's for then.terminal and a pane's for then.pane, each with the command the dialog put there and the unit that asked; a pane that could not be told apart says so; a refused, stale, or unconfirmed answer opens nothing", async () => {
	const opened: unknown[] = [], note = (x: unknown) => void opened.push(x);
	onStep((step) => note(step));
	const ask = mountAsk(root as unknown as HTMLElement, (action, body) => (sent.push({ action, body }), new Promise((resolve) => replies.push(resolve))), false, { key: "k1", show: () => note("show") });
	const answerWith = async (dialog: string, body: Record<string, unknown>, status = 200, copy?: string) => {
		const p = approval(dialog);
		ask.update(copy ? { ...p, answer: { ...p.answer!, select: { ...SELECT, copy } } } : p, true);
		choices()[0]!.click();
		button("Send answer")!.click();
		await reply(body, status);
	};
	await answerWith("t1", { outcome: "accepted" });
	assert.deepEqual(opened, [], "an answer with nothing left to do opens nothing");
	await answerWith("t2", { outcome: "accepted", then: { terminal: true } });
	assert.deepEqual(opened, [{ kind: "prompt", key: "k1", asker: "k1", command: undefined }]);
	assert.equal(status(), "Answered.");
	await answerWith("t3", { outcome: "accepted", then: { pane: "a".repeat(32) } }, 200, "sudo apt update");
	assert.deepEqual(opened.at(-1), { kind: "pane", key: `grant:${"a".repeat(32)}`, asker: "k1", command: "sudo apt update" }, "the dialog's command, the grant's key, the unit that asked");
	await answerWith("t3b", { outcome: "accepted", then: { terminal: true } }, 200, "! ls -la");
	assert.deepEqual(opened.at(-1), { kind: "prompt", key: "k1", asker: "k1", command: "! ls -la" });
	const before = opened.length;
	await answerWith("t4", { outcome: "accepted", then: { pane: null } });
	assert.equal(opened.length, before, "no pane to open");
	assert.match(String(status()), /^Answered\. .*pane/i, "and the panel says a pane opened, to find in Herdr");
	await answerWith("t5", { outcome: "stale", by: "local", then: { terminal: true } });
	await answerWith("t6", { outcome: "rejected", reason: "digest", then: { terminal: true } });
	await answerWith("t7", { outcome: "unknown" }, 504);
	await answerWith("t8", { error: "x", reason: "no" }, 409);
	assert.equal(opened.length, before, "only an accepted answer opens a card");
	// A caller with no panel of its own reaches the same call.
	assert.equal(openThen({ terminal: true }, { key: "z" }), undefined);
	assert.deepEqual(opened.at(-1), { kind: "prompt", key: "z", asker: "z", command: undefined });
	assert.equal(openThen({ pane: "g".repeat(32) }, { key: "z" }), undefined);
	assert.deepEqual(opened.at(-1), { kind: "pane", key: `grant:${"g".repeat(32)}`, asker: "z", command: undefined });
	assert.ok(!opened.some((x) => x === "show"), "an accepted answer never opens the full terminal");
	onStep(undefined);
});

test("an alert's dialog closes 1.2 s after its answer landed, and at once, told so, when the answer sent the user to a terminal (nothing queued then opens over it)", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const closed: boolean[] = [];
		const ask = mountAsk(root as unknown as HTMLElement, (action, body) => (sent.push({ action, body }), new Promise((resolve) => replies.push(resolve))), false, undefined, (opened) => void closed.push(opened));
		const go = async (dialog: string, body: Record<string, unknown>) => {
			ask.update(approval(dialog), true);
			choices()[0]!.click();
			button("Send answer")!.click();
			await reply(body);
		};
		await go("c1", { outcome: "accepted" });
		mock.timers.tick(1199);
		assert.deepEqual(closed, [], "not before 1.2 s");
		mock.timers.tick(1);
		assert.deepEqual(closed, [false]);
		await go("c2", { outcome: "accepted", then: { terminal: true } });
		mock.timers.tick(0);
		assert.deepEqual(closed, [false, true], "at once");
		await go("c3", { outcome: "accepted", then: { pane: null } });
		mock.timers.tick(1199);
		assert.deepEqual(closed, [false, true], "nothing opened: the dialog stays until the note about the pane in Herdr was read");
		mock.timers.tick(1);
		assert.deepEqual(closed, [false, true, false], "and closes after 1.2 s, told nothing opened");
	} finally {
		mock.timers.reset();
	}
});
