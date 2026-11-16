import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";
import type { ViewEntry } from "../src/memorycmd.ts";
import { createPick } from "../src/towerprompt/pick.ts";
import { type Locale, textsFor } from "../src/towerprompt/messages.ts";
import { NO_MESSAGE, runPrompt } from "../src/towerprompt/prompt.ts";
import type { PickSource, PollAnswer, Polled, PromptSource } from "../src/towerprompt/source.ts";
import type { Tower } from "../src/waitview.ts";
import { until } from "./server-world.ts";

// The tower prompt's block and its picker (docs/specs/2026-11-10-wait-cards-tui.md, §3a; todo #144 task 4): the cards that wait for the boss are shown under the state line, `/wait` takes the keyboard to press one with numbers, and only
// typed keys press: a paste, a run that starts, and a pane that cannot be marked press nothing and post nothing. A fake source and real short timers, as tests/tower-prompt.test.ts has them.

const STATE: PollAnswer = { label: "Alpha", state: "standing", queued: 0, leave: false };
const stops: AbortController[] = [];
afterEach(() => void stops.splice(0).forEach((c) => c.abort()));
const stop = () => {
	const c = new AbortController();
	stops.push(c);
	return c.signal;
};
const NOW = Date.parse("2026-11-10T10:00:00Z");

class FakePick implements PickSource {
	towers: Tower[] = [];
	auto = false;
	pressed: { workspace: string; json: Record<string, unknown> }[] = [];
	replies: { workspace: string; head?: true; text: string; answers: string }[] = [];
	reads = 0;
	opened = 0;
	closed = 0;
	refuse: Error | undefined;
	/** The mark is not open until this is released. */
	gate: Promise<void> | undefined;
	/** A press waits for this before it answers. */
	hold: Promise<void> | undefined;
	pressStatus = 200;
	pressBody: Record<string, unknown> = { press: { main: { status: "delivered" } } };
	/** The list follows the presses and replies, as the server's does: a press is recorded on its wait, and a reply marks it answered. */
	live = false;
	/** Reading the cards fails with this. */
	readError: Error | undefined;
	private find(workspace: string, id: unknown) {
		return this.towers.find((t) => t.workspace === workspace)?.waits.find((w) => w.id === id);
	}
	async waits() {
		this.reads++;
		if (this.readError) throw this.readError;
		return { auto: this.auto, towers: structuredClone(this.towers) };
	}
	async press(workspace: string, json: Record<string, unknown>) {
		this.pressed.push({ workspace, json });
		await this.hold;
		const wait = this.live && this.pressStatus === 200 ? this.find(workspace, json.id) : undefined;
		if (wait) Object.assign(wait, { press: { act: String(json.act), at: "x", ...(json.act === "secret" ? { secretAsked: "x" } : {}) } }, json.act === "secret" ? {} : { state: "answered" });
		return { status: this.pressStatus, body: this.pressBody };
	}
	async reply(tower: { workspace: string; head?: true }, text: string, answers: string) {
		this.replies.push({ workspace: tower.workspace, ...(tower.head ? { head: true as const } : {}), text, answers });
		const wait = this.live ? this.find(tower.workspace, answers) : undefined;
		if (wait) wait.state = "answered";
		return { answered: answers };
	}
	async here<T>(fn: () => Promise<T>): Promise<T> {
		await this.gate;
		if (this.refuse) throw this.refuse;
		this.opened++;
		try {
			return await fn();
		} finally {
			this.closed++;
		}
	}
}
class FakeSource implements PromptSource {
	answers: Polled[] = [{ kind: "state", answer: STATE }];
	pick: FakePick | undefined = new FakePick();
	posted: string[] = [];
	left = 0;
	gones = 0;
	/** What each poll said of the boss: whether they are answering cards. */
	answerings: boolean[] = [];
	async poll(answering?: boolean): Promise<Polled> {
		this.answerings.push(answering === true);
		const polled = this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
		// A live picker's own tower is the digest the polls carry, as the server's poll carries its tower's.
		if (!this.pick?.live || polled.kind !== "state" || polled.answer.leave) return polled;
		const own = this.pick.towers.find((t) => t.own);
		return { kind: "state", answer: { ...polled.answer, waits: (own?.waits ?? []).map((w) => ({ id: w.id, type: w.card?.type ?? "legacy", do: w.card?.do ?? w.text, ...(w.press ? { pressed: w.press.act } : {}) })) } };
	}
	async post(text: string) {
		this.posted.push(text);
	}
	async fresh() {}
	async leave() {
		this.left++;
	}
	async gone() {
		this.gones++;
	}
	/** The digest the polls carry from now on. */
	digest(waits: PollAnswer["waits"], extra: Partial<PollAnswer> = {}) {
		this.answers = [{ kind: "state", answer: { ...STATE, waits, ...extra } }];
	}
	waking() {
		this.answers = [{ kind: "state", answer: { ...STATE, state: "waking", leave: true } }];
	}
}
const card = (id: string, over: Partial<NonNullable<ViewEntry["card"]>> = {}, extra: Partial<ViewEntry> = {}): ViewEntry => ({
	id, kind: "wait", text: `do ${id}`, at: new Date(NOW - 12 * 60_000).toISOString(), state: "open",
	card: { type: "action", lang: "en", happened: `${id} happened`, do: `do ${id}`, from: { id: "m1", name: "mp3946-print", role: "main" }, ...over }, ...extra,
});
const tower = (waits: ViewEntry[], over: Partial<Tower> = {}): Tower => ({ workspace: "wA", label: "Alpha", own: true, waits, ...over });

/** A screen that is not a terminal: nothing but the prompt's own lines. */
function screen(source: PromptSource, over: { locale?: Locale; look?: boolean } = {}) {
	const input = new PassThrough(), output = new PassThrough();
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const done = runPrompt({ workspace: "wA", source, input, output, signal: stop(), locale: over.locale ?? "en", pollMs: 15, clock: { now: () => NOW, after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as NodeJS.Timeout) } });
	return { input, done, text: () => text };
}
/** A terminal: readline edits the line and reports keys, so a bracketed paste is seen as one. */
function terminal(source: PromptSource, over: { locale?: Locale } = {}) {
	const input = new PassThrough(), output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const done = runPrompt({ workspace: "wA", source, input, output, signal: stop(), locale: over.locale ?? "en", pollMs: 15, clock: { now: () => NOW, after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as NodeJS.Timeout) } });
	// What readline wrote to move the cursor and clear the line is not text: what is left reads as the lines do.
	return { input, done, text: () => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") };
}
const ended = (done: Promise<number>) => Promise.race([done, new Promise<number>((_, reject) => setTimeout(() => reject(new Error("the prompt did not end")), 3000).unref())]);
type Screen = ReturnType<typeof screen>;
/** The keys of a typed line: its characters, then Enter, as separate reads (a person's keys). */
const typed = async (p: Screen, line: string) => {
	for (const ch of line) p.input.write(ch);
	p.input.write("\r");
};
const count = (text: string, part: string) => text.split(part).length - 1;

test("the block of waiting cards is printed under the state line when the digest changes, once, with the tag, what you do, the raiser, and parked; five lines and a count; empty says so; no bell", async () => {
	const source = new FakeSource();
	source.digest([{ id: "W2", type: "choice", do: "Deploy now?", from: "mp3946-print", parked: true }, { id: "W1", type: "action", do: "Re-authorize" }]);
	const p = screen(source);
	await until(() => p.text().includes("waits for you (2)"), "the block");
	const text = p.text();
	assert.ok(text.indexOf("standing by") < text.indexOf("waits for you (2)"), "under the state line");
	assert.match(text, /\? waits for you \(2\)\n {2}W2 choice · Deploy now\? · from mp3946-print · parked\n {2}W1 action · Re-authorize\n/);
	await until(() => count(p.text(), "standing by") >= 1, "a poll");
	await new Promise((r) => setTimeout(r, 80)); // several polls with the same digest
	assert.equal(count(p.text(), "waits for you (2)"), 1, "the same digest is not printed again");
	source.digest([{ id: "W1", type: "action", do: "Re-authorize" }]);
	await until(() => p.text().includes("waits for you (1)"), "the changed digest");
	source.digest(Array.from({ length: 8 }, (_, i) => ({ id: `W${i + 1}`, type: "secret", do: `card ${i + 1}` })));
	await until(() => p.text().includes("waits for you (8)"), "eight cards");
	const block = p.text().slice(p.text().indexOf("waits for you (8)"));
	assert.equal(count(block, " secret · "), 5, "at most five lines");
	assert.match(block, /3 more: \/wait/);
	source.digest([]);
	await until(() => p.text().includes(textsFor("en").waitsNone), "the empty note");
	assert.equal(p.text().includes("\x07"), false, "no bell");
	source.waking();
	assert.equal(await ended(p.done), 0);
});

test("the block speaks Traditional Chinese for a zh-TW boss, and a prompt of an older server (no digest) shows none", async () => {
	const source = new FakeSource();
	source.digest([{ id: "W1", type: "action", do: "重新授權", from: "mp3946-print", parked: true }, ...Array.from({ length: 5 }, (_, i) => ({ id: `W${i + 2}`, type: "secret", do: `卡片 ${i + 2}` }))]);
	const p = screen(source, { locale: "zh-TW" });
	await until(() => p.text().includes("等你處理（6）"), "the block");
	assert.match(p.text(), /W1 動作 · 重新授權 · 由 mp3946-print · 已暫放/);
	assert.match(p.text(), /還有 1 張：\/wait/);
	assert.match(p.text(), /\/wait\s+處理等你的卡片/, "the hint row");
	source.waking();
	await ended(p.done);
	const old = new FakeSource();
	const q = screen(old);
	await until(() => q.text().includes("standing by"), "the state");
	assert.equal(q.text().includes("waits for you"), false);
	old.waking();
	await ended(q.done);
});

test("an escape or a control character in a card's text is not written to the terminal: the block, the list, and the card are cleaned again", async () => {
	const source = new FakeSource();
	source.digest([{ id: "W1", type: "action", do: "fix\x1b[2J\x1b]0;x\x07 it", from: "ma\x1bin" }]);
	source.pick!.towers = [tower([card("W1", { do: "fix\x1b[2J it", happened: "bad\x1b[31m news\x07", from: { id: "m1", name: "ma\x1bin", role: "main" }, command: "echo \x1b[1mhi" })])];
	const p = screen(source);
	await until(() => p.text().includes("waits for you (1)"), "the block");
	await typed(p, "/wait");
	await until(() => p.text().includes("What happened"), "the card");
	assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(p.text()), false, JSON.stringify(p.text()));
	assert.match(p.text(), /W1 action · fix\[2J\]0;x it · from main/);
	source.waking();
	await ended(p.done);
});

test("/wait and /boss wait take the keyboard: the cards are listed (this tower's first), a number picks a card and a number its act, and the press is the server's own; the mark is held for the whole mode and the prompt comes back", async () => {
	for (const word of ["/wait", "/boss wait"]) {
		const source = new FakeSource(), pick = source.pick!;
		pick.towers = [tower([card("W1"), card("W2", { do: "Second thing" })]), { workspace: "wB", label: "Beta", waits: [card("W1", { do: "Beta thing" })] }];
		const p = terminal(source);
		await until(() => p.text().includes("tower> "), "the prompt");
		p.input.write(`${word}\r`);
		await until(() => p.text().includes("Waits for you (3)"), "the list");
		assert.equal(pick.opened, 1, "the mark opens before the cards are asked");
		assert.equal(pick.closed, 0, "and stays");
		const text = p.text();
		assert.match(text, /1\. \[Alpha\] Needs you: do W1 · from mp3946-print · 12 min ago/);
		assert.match(text, /3\. \[Beta\] Needs you: Beta thing/);
		assert.ok(text.slice(text.lastIndexOf("Waits for you (3)")).includes("wait> "), "the prompt becomes wait>");
		await typed(p as Screen, "9");
		await until(() => p.text().includes("That is not one of the numbers above."), "a number that is none");
		await typed(p as Screen, "1");
		await until(() => p.text().includes("1. I'm done"), "the card's acts");
		const card1 = p.text().slice(p.text().lastIndexOf("[Alpha] W1")).replace(/^wait> /gm, "");
		assert.match(card1, /What happened: W1 happened\nWhat you do: do W1\nRaised by: mp3946-print/);
		assert.match(card1, /1\. I'm done\n {2}2\. Skip\n {2}3\. Reply to the tower\n {2}4\. Back/, "no switch of tabs in the prompt: it has no Herdr to focus with");
		await typed(p as Screen, "1");
		await until(() => pick.pressed.length === 1, "the press");
		assert.deepEqual(pick.pressed, [{ workspace: "wA", json: { op: "press", id: "W1", act: "done" } }]);
		await until(() => p.text().includes("W1 done: mp3946-print was told."), "the result line");
		await until(() => pick.reads === 2, "the list is read again after a press");
		await typed(p as Screen, "");
		await until(() => pick.closed === 1, "an empty line at the list leaves the mode and drops the mark");
		await until(() => p.text().slice(p.text().lastIndexOf("W1 done")).includes("tower> "), "the prompt comes back");
		assert.deepEqual(source.posted, [], "nothing the boss typed in the mode was posted");
		p.input.write("\x04");
		assert.equal(await ended(p.done), 0);
	}
});

test("a choice card presses the option by its index, a legacy wait asks the tower to restate, the secret's first step and its end are the two presses; a single card skips the list and ends the mode after its press", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1", { type: "choice", do: "Deploy now?", options: [{ label: "Deploy", then: "The main deploys." }, { label: "Hold", then: "The main waits." }] })])];
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("2. 2) Hold — The main waits."), "the options as acts");
	assert.equal(p.text().includes("Waits for you (1)"), false, "one card: no list");
	await typed(p, "2");
	await until(() => pick.pressed.length === 1, "the press");
	assert.deepEqual(pick.pressed[0]!.json, { op: "press", id: "W1", act: "choose", option: 1 });
	await until(() => pick.closed === 1, "the mode ends after a single card's press");
	// a legacy wait
	pick.towers = [tower([{ id: "W2", kind: "wait", text: "old words", at: new Date(NOW).toISOString(), state: "open" }])];
	await typed(p, "/wait");
	await until(() => p.text().includes("Ask the tower to rewrite it as a card"), "legacy acts");
	await typed(p, "1");
	await until(() => pick.pressed.length === 2, "restate");
	assert.deepEqual(pick.pressed[1]!.json, { op: "press", id: "W2", act: "restate" });
	// a secret
	pick.towers = [tower([card("W3", { type: "secret", secret: { name: "the auth key" } })])];
	await typed(p, "/wait");
	await until(() => p.text().includes("Start entering (asks mp3946-print"), "start entering");
	await typed(p, "1");
	await until(() => pick.pressed.length === 3, "the first step");
	assert.deepEqual(pick.pressed[2]!.json, { op: "press", id: "W3", act: "secret" });
	pick.towers = [tower([card("W3", { type: "secret", secret: { name: "the auth key" } }, { press: { act: "secret", at: "x", secretAsked: "x" } })])];
	await typed(p, "/wait");
	await until(() => p.text().includes("1. I entered it"), "the end of the secret");
	await typed(p, "1");
	await until(() => pick.pressed.length === 4, "done");
	assert.deepEqual(pick.pressed[3]!.json, { op: "press", id: "W3", act: "done" });
	assert.deepEqual(source.posted, []);
	source.waking();
	await ended(p.done);
});

test("skip asks a reason line, then y/N; only a y presses, with the reason; anything else goes back to the card and presses nothing; a reply is the next line, an empty one cancels", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1")])];
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("2. Skip"), "the card");
	await typed(p, "2");
	await until(() => p.text().includes("Reason (optional; Enter for none):"), "the reason line");
	await typed(p, "no time this week");
	await until(() => p.text().includes("Skip this? the tower and mp3946-print will know you will not do this. (y/N)"), "the confirm");
	await typed(p, "n");
	await until(() => count(p.text(), "1. I'm done") === 2, "back to the card");
	assert.equal(pick.pressed.length, 0, "an N presses nothing");
	await typed(p, "2");
	await until(() => count(p.text(), "Reason (optional; Enter for none):") === 2, "the reason line again");
	await typed(p, "");
	await until(() => count(p.text(), "(y/N)") === 2, "the confirm after no reason");
	await typed(p, "y");
	await until(() => pick.pressed.length === 1, "the decline");
	assert.deepEqual(pick.pressed[0]!.json, { op: "press", id: "W1", act: "decline" }, "an empty reason is no reason");
	await until(() => pick.closed === 1, "the mode ended");
	// with a reason and a y
	await typed(p, "/wait");
	await until(() => count(p.text(), "2. Skip") === 3, "the card again");
	await typed(p, "2");
	await until(() => count(p.text(), "Reason (optional; Enter for none):") === 3, "the reason line a third time");
	await typed(p, "no time this week");
	await until(() => count(p.text(), "(y/N)") === 3, "the confirm with a reason");
	await typed(p, "yes");
	await until(() => pick.pressed.length === 2, "the second decline");
	assert.deepEqual(pick.pressed[1]!.json, { op: "press", id: "W1", act: "decline", reason: "no time this week" });
	// a reply
	await typed(p, "/wait");
	await until(() => count(p.text(), "3. Reply to the tower") === 4, "the card for a reply");
	await typed(p, "3");
	await until(() => p.text().includes("Reply to the tower (an empty line cancels):"), "the reply line");
	await typed(p, "on Monday, please");
	await until(() => pick.replies.length === 1, "the reply");
	assert.deepEqual(pick.replies, [{ workspace: "wA", text: "on Monday, please", answers: "W1" }]);
	assert.equal(pick.pressed.length, 2, "a reply is no press");
	assert.deepEqual(source.posted, [], "nor a post of the boss's words");
	source.waking();
	await ended(p.done);
});

test("a refusal of the server is shown with its reason and the list is read again", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	pick.pressStatus = 409;
	pick.pressBody = { error: "refused", reason: "W1 was pressed already: I'm done at 10:00" };
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("Waits for you (2)"), "the list");
	await typed(p, "1");
	await until(() => p.text().includes("1. I'm done"), "the card");
	await typed(p, "1");
	await until(() => p.text().includes("W1 was pressed already: I'm done at 10:00 (the list is read again)"), "the refusal");
	await until(() => pick.reads === 2, "read again");
	assert.equal(count(p.text(), "Waits for you (2)"), 2, "the list is drawn again");
	source.waking();
	await ended(p.done);
});

test("a paste is no pick: a bracketed paste, or lines that arrive together, end the mode with nothing pressed or posted, and the prompt says so", async () => {
	for (const paste of ["\x1b[200~1\x1b[201~\r", "\x1b[200~1\r", "1\n1\n"]) {
		const source = new FakeSource(), pick = source.pick!;
		pick.towers = [tower([card("W1"), card("W2")])];
		const p = terminal(source);
		await until(() => p.text().includes("tower> "), "the prompt");
		p.input.write("/wait\r");
		await until(() => p.text().includes("Waits for you (2)"), "the list");
		p.input.write(paste);
		await until(() => p.text().includes("a paste is not a pick; nothing was pressed"), `the paste (${JSON.stringify(paste)})`);
		await until(() => pick.closed === 1, "the mark is dropped");
		assert.deepEqual(pick.pressed, [], JSON.stringify(paste));
		assert.deepEqual(source.posted, [], "and nothing is posted");
		await until(() => p.text().slice(p.text().lastIndexOf("a paste is not a pick")).includes("tower> "), "the prompt comes back");
		await new Promise((r) => setTimeout(r, 60));
		assert.deepEqual(source.posted, [], "not later either");
		p.input.write("\x04");
		await ended(p.done);
	}
});

test("a paste or a leave while the mark is still opening ends the mode for good: no list, no key is taken, the mark is dropped, and the boss's next line is a message", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1", { type: "secret", secret: { name: "KEY" } }), card("W2")])];
	let open!: () => void;
	pick.gate = new Promise<void>((resolve) => (open = resolve));
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/wait\r");
	await new Promise((r) => setTimeout(r, 40)); // the mark is being opened
	p.input.write("\x1b[200~1\x1b[201~\r");
	await new Promise((r) => setTimeout(r, 40));
	open();
	await until(() => p.text().includes("a paste is not a pick; nothing was pressed"), "the paste");
	await until(() => pick.closed === 1, "the mark is dropped");
	await until(() => p.text().slice(p.text().lastIndexOf("a paste is not a pick")).includes("tower> "), "the prompt comes back");
	assert.equal(pick.reads, 0, "the cards are never listed");
	assert.equal(p.text().includes("Waits for you"), false);
	p.input.write("1\r");
	await until(() => source.posted.length === 1, "a digit is a message again");
	p.input.write("1\r");
	await until(() => source.posted.length === 2, "and again");
	assert.deepEqual(pick.pressed, [], "nothing is pressed without the mark");
	assert.equal(pick.opened, 1);
	assert.equal(pick.closed, 1);
	p.input.write("\x04");
	await ended(p.done);
});

test("stop while the mark is still opening: the mode stays ended, the cards are not read or listed, and the mark is dropped", async () => {
	const pick = new FakePick(), lines: string[] = [], modes: boolean[] = [];
	pick.towers = [tower([card("W1"), card("W2")])];
	let open!: () => void;
	pick.gate = new Promise<void>((resolve) => (open = resolve));
	const mode = createPick({ source: pick, locale: "en", say: (l) => void lines.push(l), mode: (on) => void modes.push(on), now: () => NOW });
	const started = mode.start();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(mode.active(), true);
	const stopped = mode.stop();
	open();
	await Promise.all([started, stopped]);
	assert.equal(mode.active(), false);
	assert.equal(pick.reads, 0);
	assert.deepEqual(lines, []);
	assert.deepEqual(modes, [true, false]);
	assert.equal(pick.closed, 1);
	await mode.line("1");
	assert.deepEqual(pick.pressed, []);
});

test("a run that starts in pick mode drops it: what is on the line is not posted, the prompt says where the cards are now, and the pane is given up; the mark is dropped", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/wait\r");
	await until(() => p.text().includes("Waits for you (2)"), "the list");
	p.input.write("1"); // a digit on the line, not entered
	await until(() => p.text().slice(p.text().lastIndexOf("Waits for you (2)")).includes("wait> 1"), "the digit on the line");
	source.waking();
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, [], "digits typed in the mode are never posted as the boss's words");
	assert.equal(source.gones, 1);
	assert.match(p.text(), new RegExp(textsFor("en").pickWoke.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
	assert.equal(pick.closed, 1);
	// the same in Traditional Chinese
	const zh = new FakeSource();
	zh.pick!.towers = [tower([card("W1"), card("W2")])];
	const q = terminal(zh, { locale: "zh-TW" });
	await until(() => q.text().includes("待命中"), "the prompt");
	q.input.write("/wait\r");
	await until(() => q.text().includes("等你處理（2）"), "the list");
	zh.waking();
	await ended(q.done);
	assert.match(q.text(), /塔台醒了，到執行中的窗格用 \/boss wait 處理/);
});

test("a press already sent is answered first: its result line is printed before the pane is given up", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	let release!: () => void;
	pick.hold = new Promise<void>((resolve) => (release = resolve));
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("Waits for you (2)"), "the list");
	await typed(p, "1");
	await until(() => p.text().includes("1. I'm done"), "the card");
	await typed(p, "1");
	await until(() => pick.pressed.length === 1, "the press is on its way");
	source.waking(); // the press woke the tower
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(source.gones, 0, "the prompt waits for the answer of the press");
	release();
	assert.equal(await ended(p.done), 0);
	const text = p.text();
	assert.ok(text.indexOf("W1 done: mp3946-print was told.") > 0 && text.indexOf("W1 done: mp3946-print was told.") < text.indexOf(textsFor("en").pickWoke), "the result comes before the leave");
	assert.deepEqual(source.posted, []);
});

test("a pane that cannot be marked refuses the mode: nothing is read, nothing is asked, and the next /wait works once it can", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	pick.refuse = new Error("the pane could not be marked (no answer)");
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/wait\r");
	await until(() => p.text().includes("Pick mode needs this pane marked as local-only"), "the refusal");
	assert.match(p.text(), /the pane could not be marked \(no answer\)/);
	assert.equal(pick.reads, 0, "nothing was read");
	assert.deepEqual(pick.pressed, []);
	// lines typed after it are the boss's own words again, not the picker's
	p.input.write("hello\r");
	await until(() => source.posted.length === 1, "an ordinary message");
	assert.deepEqual(source.posted, ["hello"]);
	pick.refuse = undefined;
	p.input.write("/wait\r");
	await until(() => p.text().includes("Waits for you (2)"), "the list once it can be marked");
	p.input.write("\x04");
	await ended(p.done);
});

test("Ctrl+D in pick mode leaves the pane as ever and drops the mark; a source with no way to press says so", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.towers = [tower([card("W1"), card("W2")])];
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/wait\r");
	await until(() => p.text().includes("Waits for you (2)"), "the list");
	p.input.write("\x04");
	assert.equal(await ended(p.done), 0);
	assert.equal(source.left, 1);
	assert.equal(pick.closed, 1);
	assert.deepEqual(source.posted, []);
	const bare = new FakeSource();
	bare.pick = undefined;
	const q = screen(bare);
	await until(() => q.text().includes("standing by"), "the prompt");
	await typed(q, "/wait");
	await until(() => q.text().includes("cannot press cards"), "the refusal");
	assert.deepEqual(bare.posted, []);
	bare.waking();
	await ended(q.done);
});

test("auto mode: parked cards are listed and pressable, and the secret's start is not offered, with the line", async () => {
	const source = new FakeSource(), pick = source.pick!;
	pick.auto = true;
	pick.towers = [tower([card("W1", { type: "secret", secret: { name: "the key" } }, { parked: true })])];
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("Start entering is off while auto mode is on: /boss auto off first."), "the line");
	const shown = p.text().slice(p.text().lastIndexOf("[Alpha] W1"));
	assert.equal(shown.includes("Start entering ("), false, "no start of the secret");
	assert.match(shown, /1\. Skip\n {2}2\. Reply to the tower\n {2}3\. Back/);
	assert.match(shown, /Parked for your return\./);
	source.waking();
	await ended(p.done);
	// a parked plain card is pressable
	const plain = new FakeSource();
	plain.pick!.auto = true;
	plain.pick!.towers = [tower([card("W1", {}, { parked: true })])];
	const q = screen(plain);
	await until(() => q.text().includes("standing by"), "the prompt");
	await typed(q, "/wait");
	await until(() => q.text().includes("1. I'm done"), "the card");
	await typed(q, "1");
	await until(() => plain.pick!.pressed.length === 1, "pressed");
	plain.waking();
	await ended(q.done);
});

test("no cards: the mode says so and ends, with the mark dropped, and a typed digit afterwards is an ordinary message", async () => {
	const source = new FakeSource(), pick = source.pick!;
	const p = screen(source);
	await until(() => p.text().includes("standing by"), "the prompt");
	await typed(p, "/wait");
	await until(() => p.text().includes("No wait card is open for you."), "the note");
	await until(() => pick.closed === 1, "the mark dropped");
	await typed(p, "1");
	await until(() => source.posted.length === 1, "a message");
	assert.deepEqual(source.posted, ["1"]);
	source.waking();
	await ended(p.done);
});

// --- The card view (docs/specs/2026-11-16-wait-cards-flow.md, A; src/towerprompt/cardview.ts): on a terminal that reports keys the open cards are drawn one after another with no command typed, and answered with the arrows, a digit, and Enter. ---

const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", paste: (text: string) => `\x1b[200~${text}\x1b[201~` };
/** A terminal whose input reports keys (a TTY in raw mode): the card view takes them. The clock is the test's (`time.now`), the look plain unless an environment is given. */
function keyboard(source: PromptSource, over: { locale?: Locale; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; columns?: number } = {}) {
	const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input }), output = Object.assign(new PassThrough(), { isTTY: true, columns: over.columns ?? 80, rows: 24 });
	let raw = "";
	output.on("data", (chunk) => void (raw += String(chunk)));
	const time = { now: NOW };
	const done = runPrompt({ workspace: "wA", source, input, output, signal: stop(), locale: over.locale ?? "en", pollMs: 15, escapeMs: 10, platform: over.platform ?? "darwin", ...(over.env ? { env: over.env } : {}), clock: { now: () => time.now, after: (fn, ms) => setTimeout(fn, ms), cancel: (h) => clearTimeout(h as NodeJS.Timeout) } });
	// The screen as lines: what a line held before it was cleared (the prompt, before a line is said over it or readline draws it again) is gone, and the rows drawn again in place read as rows that follow.
	return { input, done, time, raw: () => raw, text: () => raw.replace(/[^\n]*(?:\x1b\[1G\x1b\[(?:2K|0J)|\x1b\[\d+A\r)/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") };
}
type Keyboard = ReturnType<typeof keyboard>;
/** The text since the last time `part` was written. */
const since = (p: { text(): string }, part: string) => p.text().slice(p.text().lastIndexOf(part));
/** One key, and the row it leaves marked (`> n. `), once the view has drawn it. */
const marks = async (p: Keyboard, key: string, row: string) => {
	const before = count(p.text(), `> ${row}`);
	p.input.write(key);
	await until(() => count(p.text(), `> ${row}`) > before, `the mark on ${row}`);
};
/** A live source with these towers: the digest of the polls and the list follow the presses. */
const live = (towers: Tower[], auto = false) => {
	const source = new FakeSource(), pick = source.pick!;
	Object.assign(pick, { live: true, towers, auto });
	return { source, pick };
};
const CHOICE = { type: "choice", do: "Deploy now?", options: [{ label: "Deploy", then: "The main deploys." }, { label: "Hold", then: "The main waits." }] };
const HINT = "Up/Down or 1-9 marks, Enter sends";

test("auto-focus: open cards of this tower are drawn with no command typed, one card with its place among them, what happened, what you do, the acts as rows with none marked, and the keys; no block, no mark, no answering yet", async () => {
	const { source, pick } = live([tower([card("W1"), card("W2", CHOICE, { parked: true })]), { workspace: "wB", label: "Beta", waits: [card("W1", { do: "Beta thing" })] }]);
	const p = keyboard(source);
	await until(() => p.text().includes(HINT), "the card");
	const text = p.text();
	assert.match(text, /\? Waits for you 1\/3 · \[Alpha\] W1 action · from mp3946-print · 12 min ago\n {2}What happened: W1 happened\n {2}What you do: do W1\n {4}1\. I'm done\n {4}2\. Skip\n {4}3\. Reply to the tower\n {2}Up\/Down or 1-9 marks, Enter sends, Left\/Right other card, Esc: message line\n/);
	assert.equal(text.includes("waits for you (2)"), false, "the block is not printed beside the card");
	assert.equal(text.includes("> 1."), false, "no row is marked at first");
	assert.ok(text.indexOf("standing by") < text.indexOf("Waits for you 1/3") && text.indexOf("/wait") < text.indexOf("Waits for you 1/3"), "under the state line and the hints");
	assert.ok(since(p, HINT).includes("tower> "), "the message line is under the card");
	assert.equal(pick.opened, 0, "the pane is not marked while the boss has not touched the cards");
	await until(() => source.answerings.length >= 3, "polls");
	assert.equal(source.answerings.includes(true), false, "and the polls do not say answering");
	assert.deepEqual(source.posted, []);
	p.input.write("\x04");
	assert.equal(await ended(p.done), 0);
});

test("the arrows and a digit mark a row and press nothing; the mark of the pane opens at the first card key; Enter presses the marked row, the next card is drawn, and after the last the view says so and a digit is a message again", async () => {
	const { source, pick } = live([tower([card("W1"), card("W2", CHOICE)]), { workspace: "wB", label: "Beta", waits: [card("W7", { do: "Beta thing" })] }]);
	const p = keyboard(source);
	await until(() => p.text().includes(HINT), "card 1");
	await marks(p, KEY.down, "1. I'm done");
	assert.equal(pick.opened, 1, "the first card key marks the pane for this computer's keys");
	assert.match(p.raw(), /\x1b\[4A\r\x1b\[2K {2}> 1\. I'm done\n\x1b\[2K {4}2\. Skip\n/, "the rows are drawn again in place: up over the three acts and the hint");
	assert.equal(count(p.text(), "What happened: W1 happened"), 1, "the card's body is printed once");
	await marks(p, KEY.down, "2. Skip");
	await marks(p, KEY.up, "1. I'm done");
	await marks(p, KEY.up, "3. Reply to the tower");
	await marks(p, "2", "2. Skip");
	await marks(p, "1", "1. I'm done");
	assert.equal(pick.pressed.length, 0, "marking presses nothing");
	await until(() => source.answerings.at(-1) === true, "the polls say the boss is answering");
	p.input.write(KEY.enter);
	await until(() => p.text().includes("W1 done: mp3946-print was told."), "the result of the press");
	assert.deepEqual(pick.pressed, [{ workspace: "wA", json: { op: "press", id: "W1", act: "done" } }]);
	await until(() => p.text().includes("Waits for you 1/2 · [Alpha] W2 choice"), "the next card, with no command typed");
	assert.equal(/> \d\./.test(since(p, "Waits for you 1/2")), false, "nothing is marked on the new card");
	await marks(p, "2", "2. 2) Hold — The main waits.");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 2, "the option");
	assert.deepEqual(pick.pressed[1], { workspace: "wA", json: { op: "press", id: "W2", act: "choose", option: 1 } });
	await until(() => p.text().includes("Waits for you 1/1 · [Beta] W7 action"), "the other tower's card comes after this tower's");
	await marks(p, KEY.down, "1. I'm done");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 3, "the last press");
	assert.deepEqual(pick.pressed[2], { workspace: "wB", json: { op: "press", id: "W7", act: "done" } }, "pressed on its own tower");
	await until(() => p.text().includes("No wait card is left for you."), "the end of the cards");
	await until(() => pick.closed === 1, "the mark is dropped");
	assert.equal(pick.opened, 1, "one mark for the whole of the answering");
	await until(() => source.answerings.at(-1) === false, "the polls say the boss is done");
	assert.deepEqual(source.posted, [], "no key of the cards was posted");
	for (const ch of "1") p.input.write(ch);
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 1, "a digit is a message again");
	assert.deepEqual(source.posted, ["1"]);
	p.input.write("\x04");
	await ended(p.done);
});

test("left and right go to another card without pressing; a secret's first step keeps the card, with its second act; auto mode offers no start", async () => {
	const { source, pick } = live([tower([card("W1"), card("W2", { type: "secret", secret: { name: "the auth key" } }), card("W3")])]);
	const p = keyboard(source);
	await until(() => p.text().includes("Waits for you 1/3 · [Alpha] W1"), "card 1");
	p.input.write(KEY.right);
	await until(() => p.text().includes("Waits for you 2/3 · [Alpha] W2 secret"), "card 2");
	assert.match(since(p, "Waits for you 2/3"), / {2}Secret: the auth key\n {4}1\. Start entering \(asks mp3946-print to open the entry box\)\n {4}2\. Skip/);
	p.input.write(KEY.left);
	await until(() => count(p.text(), "Waits for you 1/3 · [Alpha] W1") === 2, "back to card 1");
	p.input.write(KEY.left);
	await until(() => p.text().includes("Waits for you 3/3 · [Alpha] W3"), "left of the first is the last");
	p.input.write(KEY.left);
	await until(() => count(p.text(), "Waits for you 2/3 · [Alpha] W2") === 2, "card 2 again");
	assert.equal(pick.pressed.length, 0, "moving presses nothing");
	await marks(p, "1", "1. Start entering");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 1, "the first step");
	assert.deepEqual(pick.pressed[0]!.json, { op: "press", id: "W2", act: "secret" });
	await until(() => since(p, "asked mp3946-print to open the entry box").includes("1. I entered it"), "the same card, with the act that ends it");
	assert.match(since(p, "asked mp3946-print to open the entry box"), /Waits for you 2\/3 · \[Alpha\] W2 secret/);
	await marks(p, "1", "1. I entered it");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 2, "the end of the secret");
	assert.deepEqual(pick.pressed[1]!.json, { op: "press", id: "W2", act: "done" });
	source.waking();
	await ended(p.done);
	// auto mode: the start is not offered, with the line that says why
	const auto = live([tower([card("W1", { type: "secret", secret: { name: "the key" } }, { parked: true })])], true);
	const q = keyboard(auto.source);
	await until(() => q.text().includes(HINT), "the parked card");
	assert.match(q.text(), /W1 secret · from mp3946-print · 12 min ago · parked\n/);
	assert.match(q.text(), /Start entering is off while auto mode is on: \/boss auto off first\.\n {4}1\. Skip\n {4}2\. Reply to the tower\n/);
	auto.source.waking();
	await ended(q.done);
});

test("skip opens a reason field, then Enter confirms and Esc cancels: only the confirm presses decline, with the reason; a paste is text in the reason field", async () => {
	const { source, pick } = live([tower([card("W1"), card("W2")])]);
	const p = keyboard(source);
	await until(() => p.text().includes(HINT), "card 1");
	await marks(p, "2", "2. Skip");
	p.input.write(KEY.enter);
	await until(() => p.text().includes("Reason for skipping (optional): Enter goes on, Esc cancels"), "the reason field");
	await until(() => since(p, "Reason for skipping").includes("reason> "), "its prompt");
	for (const ch of "no time") p.input.write(ch);
	p.input.write(KEY.esc);
	await until(() => since(p, "Reason for skipping").includes(HINT), "Esc goes back to the card's rows");
	assert.equal(pick.pressed.length, 0);
	assert.equal(since(p, "Reason for skipping").includes("> 2."), false, "with no row marked");
	await marks(p, "2", "2. Skip");
	p.input.write(KEY.enter);
	await until(() => count(p.text(), "Reason for skipping (optional)") === 2, "the reason field again");
	p.input.write(KEY.paste("no time\nthis week"));
	p.input.write(KEY.enter);
	await until(() => p.text().includes("Skip this? the tower and mp3946-print will know you will not do this. Enter confirms, Esc cancels"), "the confirm");
	assert.equal(pick.pressed.length, 0, "the reason's Enter presses nothing");
	p.input.write(KEY.esc);
	await until(() => since(p, "Skip this?").includes(HINT), "Esc at the confirm cancels");
	assert.equal(pick.pressed.length, 0);
	await marks(p, "2", "2. Skip");
	p.input.write(KEY.enter);
	await until(() => count(p.text(), "Reason for skipping (optional)") === 3, "the reason field a third time");
	for (const ch of "not today") p.input.write(ch);
	p.input.write(KEY.enter);
	await until(() => count(p.text(), "Skip this?") === 2, "the confirm again");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 1, "the decline");
	assert.deepEqual(pick.pressed[0]!.json, { op: "press", id: "W1", act: "decline", reason: "not today" });
	await until(() => p.text().includes("Waits for you 1/1 · [Alpha] W2"), "the next card");
	// no reason: Enter, Enter
	await marks(p, "2", "2. Skip");
	p.input.write(KEY.enter);
	await until(() => count(p.text(), "Reason for skipping (optional)") === 4, "the reason field of card 2");
	p.input.write(KEY.enter);
	await until(() => count(p.text(), "Skip this?") === 3, "the confirm of card 2");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 2, "the second decline");
	assert.deepEqual(pick.pressed[1]!.json, { op: "press", id: "W2", act: "decline" }, "an empty reason is no reason");
	assert.deepEqual(source.posted, [], "nothing typed in the fields was posted");
	p.input.write("\x04");
	await ended(p.done);
});

test("reply opens a text field: Enter sends it to the card's tower with `answers` and the next card is drawn; an empty line or Esc cancels; pasted lines are one reply", async () => {
	const { source, pick } = live([tower([card("W1")]), { workspace: "head", label: "head tower", head: true, waits: [card("W4")] }]);
	const p = keyboard(source);
	await until(() => p.text().includes(HINT.slice(0, 20)), "card 1");
	await marks(p, "3", "3. Reply to the tower");
	p.input.write(KEY.enter);
	await until(() => p.text().includes("Reply to the tower: Enter sends, an empty line or Esc cancels"), "the reply field");
	await until(() => since(p, "Reply to the tower: Enter").includes("reply> "), "its prompt");
	p.input.write(KEY.enter);
	await until(() => since(p, "Reply to the tower: Enter sends").includes(HINT.slice(0, 20)), "an empty line goes back to the card's rows");
	assert.equal(/> \d\./.test(since(p, "Reply to the tower: Enter sends")), false, "with none marked");
	assert.equal(pick.replies.length, 0);
	await marks(p, "3", "3. Reply to the tower");
	p.input.write(KEY.enter);
	await until(() => count(p.text(), "Reply to the tower: Enter sends") === 2, "the reply field again");
	p.input.write("x");
	p.input.write(KEY.esc);
	await until(() => since(p, "Reply to the tower: Enter sends").includes(HINT.slice(0, 20)), "Esc goes back to the card's rows");
	assert.equal(pick.replies.length, 0, "and what was typed is not sent");
	await marks(p, "3", "3. Reply to the tower");
	p.input.write(KEY.enter);
	await until(() => count(p.text(), "Reply to the tower: Enter sends") === 3, "the reply field a third time");
	p.input.write(KEY.paste("on Monday,\nplease"));
	p.input.write(KEY.enter);
	await until(() => pick.replies.length === 1, "the reply");
	assert.deepEqual(pick.replies, [{ workspace: "wA", text: "on Monday,\nplease", answers: "W1" }]);
	await until(() => p.text().includes("Handed to the tower. W1 is marked answered."), "the result");
	await until(() => p.text().includes("Waits for you 1/1 · [head tower] W4"), "the head's card is next");
	await marks(p, "3", "3. Reply to the head tower");
	p.input.write(KEY.enter);
	await until(() => p.text().includes("Reply to the head tower: Enter sends"), "the head's reply field");
	for (const ch of "ok") p.input.write(ch);
	p.input.write(KEY.enter);
	await until(() => pick.replies.length === 2, "the reply to the head");
	assert.deepEqual(pick.replies[1], { workspace: "head", head: true, text: "ok", answers: "W4" });
	assert.equal(pick.pressed.length, 0, "a reply is no press");
	assert.deepEqual(source.posted, [], "nor a post of the boss's words");
	p.input.write("\x04");
	await ended(p.done);
});

test("a paste is no pick: with a row marked, or at the confirm, a bracketed paste or pasted lines end the view with nothing pressed or posted; a phone's stray Enter with no row marked presses nothing", async () => {
	for (const paste of [KEY.paste("\r"), `${KEY.paste("1")}\r`, "\n\n"]) {
		const { source, pick } = live([tower([card("W1"), card("W2")])]);
		const p = keyboard(source);
		await until(() => p.text().includes(HINT), "card 1");
		await marks(p, KEY.down, "1. I'm done");
		p.input.write(paste);
		await until(() => p.text().includes("a paste is not a pick; nothing was pressed"), `the paste (${JSON.stringify(paste)})`);
		await until(() => pick.closed === 1, "the mark is dropped");
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(pick.pressed.length, 0, JSON.stringify(paste));
		assert.deepEqual(source.posted, [], "and nothing is posted");
		assert.ok(since(p, "a paste is not a pick").includes("/wait brings the cards back"), "the view says how to come back");
		p.input.write("\x04");
		await ended(p.done);
	}
	// at the confirm
	const { source, pick } = live([tower([card("W1")])]);
	const p = keyboard(source);
	await until(() => p.text().includes(HINT.slice(0, 20)), "the card");
	await marks(p, "2", "2. Skip");
	p.input.write(KEY.enter);
	await until(() => p.text().includes("Reason for skipping"), "the reason");
	p.input.write(KEY.enter);
	await until(() => p.text().includes("Skip this?"), "the confirm");
	p.input.write(KEY.paste("y\r"));
	await until(() => p.text().includes("a paste is not a pick; nothing was pressed"), "the paste at the confirm");
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(pick.pressed.length, 0);
	assert.deepEqual(source.posted, []);
	p.input.write("\x04");
	await ended(p.done);
});

test("a pane that cannot be marked refuses the cards at the first card key: no row is marked, nothing is pressed, and the keys are the message line's until /wait", async () => {
	const { source, pick } = live([tower([card("W1")])]);
	pick.refuse = new Error("the pane could not be marked (no answer)");
	const p = keyboard(source);
	await until(() => p.text().includes(HINT.slice(0, 20)), "the card");
	p.input.write(KEY.down);
	await until(() => p.text().includes("The cards need this pane marked as local-only, and it could not be (the pane could not be marked (no answer)); nothing was pressed."), "the refusal");
	assert.equal(p.text().includes("> 1."), false, "no row was marked");
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 1, "Enter is the message line's: it wakes the tower");
	assert.equal(pick.pressed.length, 0);
	pick.refuse = undefined;
	for (const ch of "/wait") p.input.write(ch);
	p.input.write(KEY.enter);
	await until(() => count(p.text(), "Waits for you 1/1") === 2, "/wait brings the card back");
	await marks(p, KEY.down, "1. I'm done");
	p.input.write("\x04");
	await ended(p.done);
});

test("an Enter typed while the pane's mark is still opening presses nothing and wakes nothing: only keys that come once the pane is this computer's alone press", async () => {
	const { source, pick } = live([tower([card("W1")])]);
	let open!: () => void;
	pick.gate = new Promise<void>((resolve) => (open = resolve));
	const p = keyboard(source);
	await until(() => p.text().includes(HINT.slice(0, 20)), "the card");
	p.input.write(KEY.down); // the first card key: the mark is asked for
	p.input.write(KEY.enter); // and an Enter before it is open (a paired phone's pad could send both)
	await new Promise((r) => setTimeout(r, 80)); // past the paste window: the Enter is held behind the opening
	open();
	await until(() => p.text().includes("> 1. I'm done"), "the row is marked once the mark is open");
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(pick.pressed.length, 0, "the early Enter pressed nothing");
	assert.deepEqual(source.posted, [], "and woke nothing");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 1, "an Enter typed under the mark presses");
	p.input.write("\x04");
	await ended(p.done);
});

test("a press the server refuses (pressed elsewhere first) shows its reason and the next card is drawn; a refusal that leaves the card open moves on too", async () => {
	const { source, pick } = live([tower([card("W1"), card("W2")])]);
	Object.assign(pick, { pressStatus: 409, pressBody: { error: "refused", reason: "W1 was pressed already: I'm done at 10:00" } });
	const p = keyboard(source);
	await until(() => p.text().includes("Waits for you 1/2 · [Alpha] W1"), "card 1");
	await marks(p, "1", "1. I'm done");
	p.input.write(KEY.enter);
	await until(() => p.text().includes("x W1 was pressed already: I'm done at 10:00"), "the server's reason");
	await until(() => since(p, "W1 was pressed already").includes("Waits for you 2/2 · [Alpha] W2"), "the next card (W1 is still listed here, so it is passed)");
	assert.equal(count(p.text(), "answered elsewhere"), 0);
	p.input.write("\x04");
	await ended(p.done);
});

test("a card that leaves the list while it is shown (pressed in the GUI) is replaced at the next poll with a line that says so; when none is left the view says that", async () => {
	const { source, pick } = live([tower([card("W1"), card("W2")])]);
	const p = keyboard(source);
	await until(() => p.text().includes("Waits for you 1/2 · [Alpha] W1"), "card 1");
	Object.assign(pick.towers[0]!.waits[0]!, { state: "answered", press: { act: "done", at: "x" } }); // the GUI pressed W1
	await until(() => p.text().includes("W1 was answered elsewhere."), "the note");
	await until(() => since(p, "answered elsewhere").includes("Waits for you 1/1 · [Alpha] W2"), "the next card");
	assert.equal(pick.opened, 0, "nothing of this marked the pane");
	pick.towers[0]!.waits = [];
	await until(() => p.text().includes("W2 was answered elsewhere."), "the second note");
	await until(() => p.text().includes("No wait card is left for you."), "none left");
	p.input.write("\x04");
	await ended(p.done);
});

test("a run that starts while the boss answers drops the view: a press already sent is answered first, nothing on the line or in a field is posted, and the prompt says where the cards are now", async () => {
	const { source, pick } = live([tower([card("W1"), card("W2")])]);
	let release!: () => void;
	pick.hold = new Promise<void>((resolve) => (release = resolve));
	const p = keyboard(source);
	await until(() => p.text().includes(HINT), "card 1");
	await marks(p, "1", "1. I'm done");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 1, "the press is on its way");
	p.input.write(KEY.enter); // an impatient second Enter
	source.waking();
	await new Promise((r) => setTimeout(r, 80));
	assert.equal(source.gones, 0, "the prompt waits for the answer of the press");
	release();
	assert.equal(await ended(p.done), 0);
	const text = p.text();
	assert.ok(text.indexOf("W1 done: mp3946-print was told.") > 0 && text.indexOf("W1 done: mp3946-print was told.") < text.indexOf(textsFor("en").pickWoke), "the result comes before the leave");
	assert.deepEqual(source.posted, [], "the second Enter woke nothing and posted nothing");
	assert.equal(pick.closed, 1);
	// in a field: the reason typed is not the boss's words to the tower
	const again = live([tower([card("W1")])]);
	const q = keyboard(again.source);
	await until(() => q.text().includes(HINT.slice(0, 20)), "the card");
	await marks(q, "2", "2. Skip");
	q.input.write(KEY.enter);
	await until(() => since(q, "Reason for skipping").includes("reason> "), "the reason field");
	for (const ch of "secret words") q.input.write(ch);
	await until(() => since(q, "Reason for skipping").includes("secret words"), "typed");
	again.source.waking();
	assert.equal(await ended(q.done), 0);
	assert.deepEqual(again.source.posted, [], "a field's text is never posted");
	assert.equal(again.pick.pressed.length, 0);
	assert.equal(again.pick.closed, 1);
});

test("a printable key goes to the message line with the key kept, and its Enter posts the message; an empty Enter with no row marked wakes the tower; a digit beyond the rows is text; typing drops a mark", async () => {
	const { source, pick } = live([tower([card("W1")])]);
	const p = keyboard(source);
	await until(() => p.text().includes(HINT.slice(0, 20)), "the card");
	for (const ch of "hi there") p.input.write(ch);
	await until(() => since(p, HINT.slice(0, 20)).includes("tower> hi there"), "the keys are on the line");
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 1, "the message");
	assert.deepEqual(source.posted, ["hi there"]);
	assert.equal(pick.opened, 0, "typing a message never marks the pane");
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 2, "an empty Enter");
	assert.equal(source.posted[1], NO_MESSAGE, "wakes the tower without words, as before");
	p.input.write("9");
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 3, "a digit beyond the rows");
	assert.equal(source.posted[2], "9");
	// a row is marked, then the boss types: the mark goes, and Enter sends the words
	await marks(p, KEY.down, "1. I'm done");
	p.input.write("o");
	await until(() => pick.closed === 1, "typing lets go of the cards");
	p.input.write("k");
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 4, "the words");
	assert.equal(source.posted[3], "ok");
	assert.equal(pick.pressed.length, 0, "nothing was pressed");
	assert.equal(source.answerings.at(-1), false);
	p.input.write("\x04");
	await ended(p.done);
});

test("the keys the view takes are never the boss's words: an arrow up does not recall the last message into the line, and a digit is not left on it", async () => {
	const { source, pick } = live([tower([])]);
	const p = keyboard(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	for (const ch of "hello") p.input.write(ch);
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 1, "a message, kept in the line's history");
	pick.towers = [tower([card("W1")])];
	await until(() => p.text().includes(HINT.slice(0, 20)), "the card");
	await marks(p, KEY.up, "3. Reply to the tower");
	await marks(p, "1", "1. I'm done");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 1, "the press");
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(source.posted, ["hello"], "neither the recalled message nor the digit was posted");
	p.input.write("\x04");
	await ended(p.done);
});

test("Esc gives the keys back to the message line: arrows and digits are the line's, changes show as the block, and /wait brings the cards back", async () => {
	const { source, pick } = live([tower([card("W1"), card("W2")])]);
	const p = keyboard(source);
	await until(() => p.text().includes(HINT), "card 1");
	await marks(p, KEY.down, "1. I'm done");
	p.input.write(KEY.esc);
	await until(() => p.text().includes("the keys are the message line's; /wait brings the cards back"), "the view lets go");
	await until(() => pick.closed === 1, "the mark is dropped");
	assert.equal(since(p, "the keys are the message line's").includes("> 1."), false);
	p.input.write("1");
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 1, "a digit is a message");
	assert.deepEqual(source.posted, ["1"]);
	assert.equal(pick.pressed.length, 0);
	pick.towers[0]!.waits.push(card("W3"));
	await until(() => p.text().includes("waits for you (3)"), "a new card shows as the block, and takes no key");
	for (const ch of "/wait") p.input.write(ch);
	p.input.write(KEY.enter);
	await until(() => p.text().includes("Waits for you 1/3 · [Alpha] W1"), "the cards again, from the first");
	await marks(p, KEY.down, "1. I'm done");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 1, "pressed");
	p.input.write("\x04");
	await ended(p.done);
});

test("60 s without a card key: the polls stop saying answering and the mark is dropped, with the card still shown; the next card key opens the mark again", async () => {
	const { source, pick } = live([tower([card("W1")])]);
	const p = keyboard(source);
	await until(() => p.text().includes(HINT.slice(0, 20)), "the card");
	await marks(p, KEY.down, "1. I'm done");
	await until(() => source.answerings.at(-1) === true, "answering");
	p.time.now += 59_000;
	const polls = source.answerings.length;
	await until(() => source.answerings.length >= polls + 2, "polls");
	assert.equal(source.answerings.at(-1), true, "59 s after the key the boss is still answering");
	assert.equal(pick.closed, 0);
	p.time.now += 2000;
	await until(() => source.answerings.at(-1) === false, "the polls stop saying it");
	await until(() => pick.closed === 1, "the mark is dropped");
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 1, "the row is no longer marked: Enter wakes the tower");
	assert.equal(pick.pressed.length, 0);
	await marks(p, KEY.down, "1. I'm done");
	assert.equal(pick.opened, 2, "a new mark");
	await until(() => source.answerings.at(-1) === true, "answering again");
	p.input.write("\x04");
	await ended(p.done);
});

test("the state line says when the tower's wake is held for the boss's answering", async () => {
	const { source } = live([tower([card("W1")])]);
	source.answers = [{ kind: "state", answer: { ...STATE, queued: 2, holding: true } }];
	const p = keyboard(source);
	await until(() => p.text().includes("2 queued (they wait until you finish the cards)"), "the held count");
	source.waking();
	await ended(p.done);
	const zh = live([tower([card("W1")])]);
	zh.source.answers = [{ kind: "state", answer: { ...STATE, queued: 1, holding: true } }];
	const q = keyboard(zh.source, { locale: "zh-TW" });
	await until(() => q.text().includes("1 則待處理（等你回答完卡片）"), "in Traditional Chinese");
	zh.source.waking();
	await ended(q.done);
});

test("an unattended device shows no card on its own: the block as before, and /wait opens the card view", async () => {
	const { source, pick } = live([tower([card("W1")])]);
	source.answers = [{ kind: "state", answer: { ...STATE, unattended: true } }];
	const p = keyboard(source);
	await until(() => p.text().includes("waits for you (1)"), "the block");
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(p.text().includes("Waits for you 1/1"), false, "no card takes the keys");
	p.input.write(KEY.down);
	p.input.write(KEY.enter);
	await until(() => source.posted.length === 1, "an arrow and Enter are the message line's");
	assert.equal(pick.pressed.length, 0);
	for (const ch of "/wait") p.input.write(ch);
	p.input.write(KEY.enter);
	await until(() => p.text().includes("Waits for you 1/1 · [Alpha] W1"), "the card view");
	pick.towers[0]!.waits.push(card("W2"));
	Object.assign(pick.towers[0]!.waits[0]!, { state: "answered", press: { act: "done", at: "x" } }); // the GUI pressed W1 while it is shown
	await until(() => p.text().includes("W1 was answered elsewhere."), "the open view follows the list on such a device too");
	await until(() => p.text().includes("Waits for you 1/1 · [Alpha] W2"), "the next card");
	await marks(p, KEY.down, "1. I'm done");
	p.input.write(KEY.enter);
	await until(() => pick.pressed.length === 1, "pressed");
	await until(() => p.text().includes("No wait card is left for you."), "the end");
	pick.towers[0]!.waits.push(card("W3"));
	await until(() => p.text().includes("waits for you (3)"), "a card that comes later is the block again");
	await new Promise((r) => setTimeout(r, 60));
	assert.equal(p.text().includes("[Alpha] W3"), false, "not a card that takes the keys");
	p.input.write("\x04");
	await ended(p.done);
});

test("where keys are not reported the numbered picker stays: Windows (until its console is checked), TERM=dumb, and an input that is no terminal", async () => {
	for (const over of [{ platform: "win32" as const }, { env: { TERM: "dumb", STRAW_BOSS_ASCII: "1" } }]) {
		const { source, pick } = live([tower([card("W1"), card("W2")])]);
		const p = keyboard(source, over);
		await until(() => p.text().includes("waits for you (2)"), `the block (${JSON.stringify(over)})`);
		assert.equal(p.text().includes("Waits for you 1/2"), false);
		for (const ch of "/wait") p.input.write(ch);
		p.input.write(KEY.enter);
		await until(() => p.text().includes("Waits for you (2)"), "the numbered list");
		p.input.write("1");
		p.input.write(KEY.enter);
		await until(() => p.text().includes("1. I'm done"), "the card's acts");
		p.input.write("1");
		p.input.write(KEY.enter);
		await until(() => pick.pressed.length === 1, "the press");
		p.input.write("\x04");
		await ended(p.done);
	}
});

test("Ctrl+C and Ctrl+D in the view leave the pane as ever: the mark is dropped, nothing is pressed or posted", async () => {
	for (const key of ["\x03", "\x04"]) {
		const { source, pick } = live([tower([card("W1")])]);
		const p = keyboard(source);
		await until(() => p.text().includes(HINT.slice(0, 20)), "the card");
		await marks(p, KEY.down, "1. I'm done");
		p.input.write(key);
		assert.equal(await ended(p.done), 0);
		assert.equal(source.left, 1, JSON.stringify(key));
		assert.equal(pick.closed, 1);
		assert.equal(pick.pressed.length, 0);
		assert.deepEqual(source.posted, []);
	}
});

test("the view speaks Traditional Chinese, draws the glyphs of a look that has them, and cuts a row to the terminal's width by its cells, a CJK character counting two", async () => {
	const { source } = live([tower([card("W1", { ...CHOICE, do: "選一個部署方式", options: [{ label: "先部署 staging", then: "之後塔台叫 main 驗證，再決定要不要上正式區，這一行很長很長很長" }, { label: "直接上正式區", then: "不驗證" }] }, { parked: true })])]);
	const p = keyboard(source, { locale: "zh-TW", env: { STRAW_BOSS_ASCII: "0", NO_COLOR: "1" }, columns: 40 });
	await until(() => p.text().includes("↑↓ 或數字選擇"), "the card");
	const text = p.text();
	assert.match(text, /等你處理 1\/1 · ［Alpha］ W1 選擇 · 由 mp3946-print · 12 分前 · 已暫放\n {2}發生了什麼: W1 happened\n {2}你要做的: 選一個部署方式\n/);
	assert.match(text, /\n {4}3\. 略過\n {4}4\. 回覆塔台\n {2}↑↓ 或數字選擇 · Enter 送出 · Esc 回…\n/, "one card: no ←→; the hint is cut too, at 38 columns");
	const row = /\n( {4}1\. .*)\n/.exec(text)![1]!;
	const cells = [...row].reduce((n, ch) => n + (ch.codePointAt(0)! >= 0x2e80 ? 2 : 1), 0);
	assert.ok(row.endsWith("…") && cells <= 38, `the long row fits 40 columns (${cells}: ${row})`);
	await marks({ ...p, text: () => p.text().replaceAll("❯", ">") } as Keyboard, KEY.down, "1. 1) 先部署 staging");
	assert.ok(p.text().includes("  ❯ 1. 1) 先部署 staging"), "the glyph of the marked row");
	p.input.write("\x04");
	await ended(p.done);
});

test("an escape or a control character in a card's text never reaches the terminal from the card view", async () => {
	const { source } = live([tower([card("W1", { type: "choice", do: "fix\x1b[2J it", happened: "bad\x1b[31m news\x07", from: { id: "m1", name: "ma\x1bin", role: "main" }, command: "echo \x1b[1mhi", options: [{ label: "go\x1b[2J", then: "then\x07" }] })])]);
	const p = keyboard(source);
	await until(() => p.raw().includes(HINT), "the card");
	const drawn = p.raw().slice(p.raw().indexOf("Waits for you 1/1"));
	assert.equal(/\x1b\[(2J|31m|1m)|\x07/.test(drawn), false, JSON.stringify(drawn));
	source.waking();
	await ended(p.done);
});
