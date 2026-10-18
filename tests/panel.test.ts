import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
import type { Pending } from "../src/ask.ts";
import { questionsDigest, selectDigest } from "../src/owners.ts";

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
	readonly tagName: string;
	constructor(tagName: string) {
		this.tagName = tagName;
	}
	setAttribute(name: string, value: string) {
		this.attrs.set(name, String(value));
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
		if (!this.disabled) this.onclick?.();
	}
	type(text: string) {
		this.value = text;
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
