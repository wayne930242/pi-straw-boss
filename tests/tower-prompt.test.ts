import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { localeOf, textsFor } from "../src/towerprompt/messages.ts";
import { runPrompt } from "../src/towerprompt/prompt.ts";
import type { PollAnswer, Polled, PromptSource } from "../src/towerprompt/source.ts";
import { sleep, until } from "./server-world.ts";

// The tower prompt (docs/how-it-works.md, The standing pane): the small program the sb server runs in a tower's standing pane. It shows the tower's state and a hint, reads a line at `tower>`, and
// posts it as the boss's event; it polls the server, and leaves when told to (a run is starting), when the boss presses Ctrl+D, or when the tower is gone. The screen and the line input are separate
// from the state source (src/towerprompt/), so the screen can grow into a view of the tower's net later.

const STATE: PollAnswer = { label: "Alpha", state: "standing", queued: 0, leave: false };
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

test("a line is posted as the boss's event, then the prompt says it is waking the tower, tells the server it is gone, and exits 0", async () => {
	const source = new FakeSource();
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("  check the build on main  \n");
	assert.equal(await p.done, 0);
	assert.deepEqual(source.posted, ["check the build on main"]);
	assert.match(p.text(), /waking the tower…/);
	assert.equal(source.gones, 1);
	assert.equal(source.left, 0);
});

test("Enter alone wakes the tower with a line that says the boss is at the keyboard and said nothing yet", async () => {
	const source = new FakeSource();
	const p = screen(source);
	await until(() => p.text().includes("tower> "), "the prompt");
	p.input.write("\n");
	assert.equal(await p.done, 0);
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
	assert.equal(source.left, 0, "it was told to go: the park time is for Ctrl+D");
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
	assert.equal(await p.done, 0);
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
	assert.equal(await p.done, 0);
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
	assert.equal(await p.done, 0);
	assert.match(p.text(), /正在喚醒塔台…/);
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
