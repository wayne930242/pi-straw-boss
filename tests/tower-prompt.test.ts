import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mock, test } from "node:test";
import { localeOf, textsFor } from "../src/towerprompt/messages.ts";
import { runPrompt } from "../src/towerprompt/prompt.ts";
import type { PollAnswer, Polled, PromptSource } from "../src/towerprompt/source.ts";
import { sleep, until } from "./server-world.ts";

// The tower prompt (docs/how-it-works.md, The standing pane): the small program the sb server runs in a tower's standing pane. It shows the tower's state and a hint, reads a line at `tower>`, and
// posts it as the boss's event; it polls the server, and leaves when told to (a run is starting), when the boss presses Ctrl+D, or when the tower is gone. The screen and the line input are separate
// from the state source (src/towerprompt/), so the screen can grow into a view of the tower's net later.

const STATE: PollAnswer = { label: "Alpha", state: "standing", queued: 0, leave: false };
const starting = (source: FakeSource) => void (source.answers = [{ kind: "state", answer: { ...STATE, state: "waking", leave: true } }]);

class FakeSource implements PromptSource {
	answers: Polled[] = [{ kind: "state", answer: STATE }];
	polls = 0;
	posted: string[] = [];
	left = 0;
	gones = 0;
	failPost: Error | undefined;
	async poll(): Promise<Polled> {
		this.polls++;
		return this.answers.length > 1 ? this.answers.shift()! : this.answers[0]!;
	}
	async post(text: string) {
		if (this.failPost) throw this.failPost;
		this.posted.push(text);
	}
	freshed = 0;
	failFresh: Error | undefined;
	async fresh() {
		if (this.failFresh) throw this.failFresh;
		this.freshed++;
	}
	async leave() {
		this.left++;
	}
	async gone() {
		this.gones++;
	}
}
function screen(source: PromptSource, over: { locale?: "en" | "zh-TW"; pollMs?: number } = {}) {
	const input = new PassThrough(), output = new PassThrough();
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const done = runPrompt({ workspace: "wA", source, input, output, locale: over.locale ?? "en", pollMs: over.pollMs ?? 15 });
	return { input, done, text: () => text };
}

/** The prompt's end, or a failure after 3 s: an exception inside readline's event leaves the promise unsettled and would hang the suite. */
const ended = (done: Promise<number>) => Promise.race([done, new Promise<number>((_, reject) => setTimeout(() => reject(new Error("the prompt did not end")), 3000).unref())]);

/** A screen that is a terminal: readline then edits the line itself, and the prompt must never touch it after it closed. */
function terminal(source: PromptSource) {
	const input = new PassThrough(), output = Object.assign(new PassThrough(), { isTTY: true, columns: 80, rows: 24 });
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const done = runPrompt({ workspace: "wA", source, input, output, locale: "en", pollMs: 15 });
	return { input, done, text: () => text };
}

test("on a terminal, Ctrl+D leaves the pane to the shell without touching the closed line (a real pane threw ERR_USE_AFTER_CLOSE and exited 1)", async () => {
	const source = new FakeSource();
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("\x04");
	assert.equal(await ended(p.done), 0);
	assert.equal(source.left, 1);
	assert.match(p.text(), /leaving this pane to your shell/);
});

test("on a terminal, Ctrl+C leaves the pane to the shell the same way, and says it once", async () => {
	const source = new FakeSource();
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("\x03");
	assert.equal(await ended(p.done), 0);
	assert.equal(source.left, 1);
	assert.equal(p.text().match(/leaving this pane/g)?.length, 1);
});

test("on a terminal, a line wakes the tower and a state change redraws the prompt with what the boss had typed", async () => {
	const source = new FakeSource();
	source.answers = [{ kind: "state", answer: STATE }, { kind: "state", answer: STATE }, { kind: "state", answer: { ...STATE, queued: 3 } }];
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("half a mess");
	await until(() => /3 queued/.test(p.text()), "the changed state");
	assert.match(p.text().slice(p.text().lastIndexOf("3 queued")), /tower> half a mess/, "the prompt comes back with the typed text");
	p.input.write("age\r");
	await until(() => source.posted.length === 1, "the post");
	starting(source);
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, ["half a message"]);
});

test("a run that starts while the boss is typing at `tower>` gets the boss's half-written line as the boss's event, and nothing is lost (SR-F001)", async () => {
	const source = new FakeSource();
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("rm the old branch"); // no Enter
	await until(() => p.text().includes("rm the old branch"), "the typed text to be echoed");
	source.answers = [{ kind: "state", answer: { ...STATE, state: "waking", leave: true } }];
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, ["rm the old branch"]);
	assert.equal(source.gones, 1);
	assert.equal(source.left, 0);
});

test("a line the boss has entered but the prompt has not posted yet (the paste window) is posted once when the run starts", async () => {
	const source = new FakeSource();
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("one\n");
	source.answers = [{ kind: "state", answer: { ...STATE, state: "waking", leave: true } }];
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, ["one"], "once, not by both the paste timer and the leave");
});

test("when the server does not take the half-written line at the start of a run, the prompt shows it so the boss can send it again", async () => {
	const source = new FakeSource();
	source.failPost = new Error("no server");
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("keep this safe");
	await until(() => p.text().includes("keep this safe"), "the echo");
	source.answers = [{ kind: "state", answer: { ...STATE, state: "waking", leave: true } }];
	assert.equal(await ended(p.done), 0);
	assert.match(p.text().slice(p.text().indexOf("did not take it")), /keep this safe/);
});

test("the prompt shows the tower's state and a hint, and waits at `tower>`", async () => {
	const source = new FakeSource();
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	assert.match(p.text(), /tower · Alpha: standing by/);
	assert.match(p.text(), /Enter/);
	assert.match(p.text(), /Ctrl\+D/);
	assert.match(p.text(), /\/boss tower <message>/);
	assert.equal(source.posted.length, 0);
	p.input.end();
	await p.done;
});

test("a line is posted as the boss's event and the prompt says it is waking the tower; it stays until the run starts, then tells the server it is gone and exits 0", async () => {
	const source = new FakeSource();
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("  check the build on main  \n");
	await until(() => /waking the tower…/.test(p.text()), "the waking line");
	assert.deepEqual(source.posted, ["check the build on main"]);
	await sleep(100);
	assert.equal(source.gones, 0, "the prompt is still there: keys typed now would land in the shell's line");
	starting(source);
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, ["check the build on main"]);
	assert.equal(source.gones, 1);
	assert.equal(source.left, 0);
	assert.equal(p.text().match(/waking the tower…/g)?.length, 1, "said once");
});

test("keys typed after Enter, before the run starts, are held by the prompt and go to the tower when it is told to leave (B6 VM round 2: they landed in the shell line and the first start timed out)", async () => {
	const source = new FakeSource();
	const p = terminal(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("first\r");
	await until(() => source.posted.length === 1, "the first post");
	p.input.write("and then this");
	await until(() => p.text().includes("and then this"), "the typed text to be held by the prompt");
	assert.equal(source.gones, 0);
	starting(source);
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, ["first", "and then this"]);
	assert.equal(source.gones, 1);
});

test("a second line after the first is posted as a second event, and the prompt asks fast while a wake is pending, however long the start takes, and slow again when nothing is", async () => {
	const source = new FakeSource();
	const waking: Polled = { kind: "state", answer: { ...STATE, state: "waking", queued: 1 } };
	const p = (() => {
		const input = new PassThrough(), output = new PassThrough();
		let text = "";
		output.on("data", (chunk) => void (text += String(chunk)));
		return { input, text: () => text, done: runPrompt({ workspace: "wA", source, input, output, locale: "en", pollMs: 5000, wakingPollMs: 10 }) };
	})();
	await until(() => p.text().includes("tower> "), "the prompt");
	const before = source.polls;
	source.answers = [waking];
	p.input.write("one\n");
	await until(() => source.posted.length === 1, "the post");
	await until(() => source.polls >= before + 5, "fast polls after the post, though the pace is 5 s");
	// A start that takes long (a Windows claim: 10 to 46 s) is no reason to stop asking: the clock is moved 20 s and the prompt still asks fast and has not exited.
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		mock.timers.tick(20_000);
		const mark = source.polls;
		await until(() => source.polls >= mark + 5, "still fast polls 20 s later");
		p.input.write("two\n");
		await until(() => source.posted.length === 2, "the second post");
		starting(source);
		assert.equal(await ended(p.done), 0);
	} finally {
		mock.timers.reset();
	}
	assert.deepEqual(source.posted, ["one", "two"]);
	assert.equal(source.gones, 1);
});

test("a post that leaves the tower standing with nothing queued ends the fast asking after the grace, so a run that never comes costs the server no more than the slow poll", async () => {
	const source = new FakeSource();
	const input = new PassThrough(), output = new PassThrough();
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const done = runPrompt({ workspace: "wA", source, input, output, locale: "en", pollMs: 5000, wakingPollMs: 10 });
	await until(() => text.includes("tower> "), "the prompt");
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		input.write("hello\n");
		await until(() => source.posted.length === 1, "the post");
		mock.timers.tick(4000);
		await until(() => source.polls >= 8, "polls");
		const mark = source.polls;
		await sleep(150);
		assert.ok(source.polls - mark <= 2, `slow again: ${source.polls - mark} polls in 150 ms`);
	} finally {
		mock.timers.reset();
	}
	starting(source);
	input.write("\n");
	assert.equal(await ended(done), 0);
});

/** A prompt that has just posted a line while the server shows `answer`: the fast asking has started. Returns what a test needs to watch it. */
async function afterPost(answer: PollAnswer) {
	const source = new FakeSource();
	const input = new PassThrough(), output = new PassThrough();
	let text = "";
	output.on("data", (chunk) => void (text += String(chunk)));
	const done = runPrompt({ workspace: "wA", source, input, output, locale: "en", pollMs: 5000, wakingPollMs: 10 });
	await until(() => text.includes("tower> "), "the prompt");
	source.answers = [{ kind: "state", answer }];
	input.write("hello\n");
	await until(() => source.posted.length === 1, "the post");
	return { source, input, done };
}

test("RV7-F006: a held service starts no run, so the prompt does not ask fast for it: back to the slow poll at the first held answer", async () => {
	const { source, input, done } = await afterPost({ ...STATE, state: "waking", queued: 1 });
	const fast = source.polls;
	await until(() => source.polls >= fast + 5, "fast polls while the wake is pending");
	source.answers = [{ kind: "state", answer: { ...STATE, state: "held", queued: 1 } }];
	await until(() => source.answers[0]!.kind === "state" && source.polls > fast + 5, "polls");
	await sleep(50); // the held answer is seen by the next poll at the latest
	const mark = source.polls;
	await sleep(150);
	assert.ok(source.polls - mark <= 1, `slow again: ${source.polls - mark} polls in 150 ms`);
	starting(source);
	input.write("\n");
	assert.equal(await ended(done), 0);
});

test("RV7-F006: a wake that is queued and never starts (a settings refusal keeps the queue and the standing state) is asked for fast for a bounded time only", async () => {
	const { source, input, done } = await afterPost({ ...STATE, state: "standing", queued: 1 });
	mock.timers.enable({ apis: ["Date"], now: Date.now() });
	try {
		const mark = source.polls;
		await until(() => source.polls >= mark + 5, "fast polls while it may still start");
		mock.timers.tick(100_000);
		await until(() => source.polls >= mark + 10, "polls past the cap");
		await sleep(50);
		const slow = source.polls;
		await sleep(150);
		assert.ok(source.polls - slow <= 1, `slow again: ${source.polls - slow} polls in 150 ms`);
	} finally {
		mock.timers.reset();
	}
	starting(source);
	input.write("\n");
	assert.equal(await ended(done), 0);
});

test("Enter alone wakes the tower with a line that says the boss is at the keyboard and said nothing yet", async () => {
	const source = new FakeSource();
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("\n");
	await until(() => source.posted.length === 1, "the post");
	starting(source);
	assert.equal(await ended(p.done), 0);
	assert.equal(source.posted.length, 1);
	assert.match(source.posted[0]!, /at the keyboard/);
	assert.match(source.posted[0]!, /without a message/);
});

test("Ctrl+D leaves the pane to the boss: the server is told, nothing is posted, the exit is 0", async () => {
	const source = new FakeSource();
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.end(); // the end of the input is what Ctrl+D sends to a terminal
	assert.equal(await p.done, 0);
	assert.equal(source.left, 1);
	assert.equal(source.posted.length, 0);
	assert.match(p.text(), /shell/);
});

test("when the server says a run is starting, the prompt says it is waking the tower, reports itself gone, and exits 0 without posting", async () => {
	const source = new FakeSource();
	source.answers = [{ kind: "state", answer: STATE }, { kind: "state", answer: { ...STATE, state: "waking", leave: true } }];
	const p = screen(source);
	assert.equal(await p.done, 0);
	assert.match(p.text(), /waking the tower…/);
	assert.equal(source.gones, 1);
	assert.equal(source.left, 0, "it was told to go: the park is for Ctrl+D");
	assert.equal(source.posted.length, 0);
});

test("a workspace that has no tower any more ends the prompt with a line saying so", async () => {
	const source = new FakeSource();
	source.answers = [{ kind: "state", answer: STATE }, { kind: "gone" }];
	const p = screen(source);
	assert.equal(await p.done, 0);
	assert.match(p.text(), /has no tower/);
	assert.equal(source.left, 0);
	assert.equal(source.gones, 0, "the server has nothing of it");
});

test("a server that does not answer is waited for, said once, and said again when it answers; the prompt is usable meanwhile", async () => {
	const source = new FakeSource();
	source.answers = [{ kind: "wait", why: "no server" }, { kind: "wait", why: "no server" }, { kind: "wait", why: "no server" }, { kind: "state", answer: STATE }];
	const p = screen(source);
	await until(() => /answers again/.test(p.text()), "the server to come back");
	assert.equal(p.text().match(/does not answer/g)?.length, 1, "said once");
	assert.match(p.text(), /tower> /);
	p.input.write("hello\n");
	await until(() => source.posted.length === 1, "the post");
	starting(source);
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, ["hello"]);
});

test("a post the server refuses is told and the prompt stays for the next line", async () => {
	const source = new FakeSource();
	source.failPost = new Error("The sb server stands in for no tower of workspace wA");
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("one\n");
	await until(() => /did not take it/.test(p.text()), "the refusal");
	assert.match(p.text(), /stands in for no tower/);
	source.failPost = undefined;
	p.input.write("two\n");
	await until(() => source.posted.length === 1, "the post");
	starting(source);
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, ["two"]);
});

test("a change of the tower's state while the prompt waits is shown as a line of its own", async () => {
	const source = new FakeSource();
	source.answers = [{ kind: "state", answer: STATE }, { kind: "state", answer: { ...STATE, queued: 2 } }];
	const p = screen(source);
	await until(() => /2 queued/.test(p.text()), "the new queue");
	assert.equal(p.text().match(/standing by/g)?.length, 1, "the unchanged state is not printed again");
	p.input.end();
	await p.done;
});

test("the words follow the boss's language: Traditional Chinese for zh-TW, English otherwise", async () => {
	const source = new FakeSource();
	const p = screen(source, { locale: "zh-TW" });
	await until(() => p.text().includes("tower> "), "the prompt");
	assert.match(p.text(), /塔台 · Alpha：待命中/);
	assert.match(p.text(), /Ctrl\+D/);
	p.input.write("好\n");
	await until(() => /正在喚醒塔台…/.test(p.text()), "the waking line");
	starting(source);
	assert.equal(await ended(p.done), 0);
	assert.equal(textsFor("en").waking, "waking the tower…");
});

test("localeOf: zh-TW or a Traditional script is Traditional Chinese; every other language, Simplified Chinese included, is English", () => {
	assert.equal(localeOf({ LANG: "zh_TW.UTF-8" }), "zh-TW");
	assert.equal(localeOf({ LC_ALL: "zh-Hant-TW" }), "zh-TW");
	assert.equal(localeOf({ LC_MESSAGES: "zh_HK.UTF-8" }), "zh-TW");
	assert.equal(localeOf({ LANG: "zh_CN.UTF-8" }), "en");
	assert.equal(localeOf({ LANG: "en_US.UTF-8" }), "en");
	assert.equal(localeOf({ LC_ALL: "C", LANG: "zh_TW.UTF-8" }), "en", "LC_ALL wins, as in a shell");
	assert.ok(["en", "zh-TW"].includes(localeOf({})), "without a variable the system's language is used");
});

test("an unexpected state word is shown as it is, and nothing the server sends is run as a command", async () => {
	const source = new FakeSource();
	source.answers = [{ kind: "state", answer: { ...STATE, state: "odd\u001b[2J" as never, label: "A\u001b]0;x\u0007b" } }];
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	assert.ok(!p.text().includes("\u001b"), "terminal escapes of a label or a state never reach the screen");
	await sleep(30);
	p.input.end();
	await p.done;
});

test("`/new` alone at the prompt asks the server for a new boss session and goes on waiting; it is no message, and in the middle of a message it is a word like any other", async () => {
	const source = new FakeSource();
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("/new\n");
	await until(() => source.freshed === 1, "the server to be asked");
	await until(() => /next conversation with the tower is a new session/.test(p.text()), "the confirmation");
	assert.deepEqual(source.posted, [], "nothing was posted to the tower");
	assert.equal(source.gones, 0, "the prompt stays");
	source.failFresh = new Error("the server is busy");
	p.input.write("/new\n");
	await until(() => /the tower did not take it: the server is busy/.test(p.text()), "the refusal is shown");
	assert.deepEqual(source.posted, []);
	p.input.write("please /new that\n");
	await until(() => source.posted.length === 1, "the post");
	starting(source);
	assert.equal(await ended(p.done), 0);
	assert.deepEqual(source.posted, ["please /new that"], "only a line that is exactly /new is the command");
});
