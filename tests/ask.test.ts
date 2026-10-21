import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { askOf, openCalls, pendingOf, questionsOf, waitsForSecret, withPending } from "../src/ask.ts";
import type { Net } from "../src/net.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-ask-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** The open calls; a window that could not decide ("cut") fails the test. */
const calls = async (f: string) => {
	const found = await openCalls(f);
	if (found === "cut") throw new Error("the window could not decide");
	return found;
};
const ARGS = { question: "Pick a color", context: "Which theme to ship.", options: [{ title: "red", description: "warm" }, { title: "green" }, { title: "blue" }], allowFreeform: true };
// Session entries as pi writes them (one per line).
const user = (text: string) => JSON.stringify({ type: "message", id: `u-${text}`, message: { role: "user", content: [{ type: "text", text }] } });
const asked = (id: string, args: unknown = ARGS, name = "ask_user", more: { id: string; name: string }[] = []) => JSON.stringify({ type: "message", id: `a-${id}`, message: { role: "assistant", content: [{ type: "text", text: "Asking." }, { type: "toolCall", id, name, arguments: args }, ...more.map((m) => ({ type: "toolCall", id: m.id, name: m.name, arguments: {} }))] } });
const result = (id: string, text: string) => JSON.stringify({ type: "message", id: `r-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "ask_user", content: [{ type: "text", text }] } });
let n = 0;
/** A session file whose entries link to the one before them (type, id, parentId first, as pi writes them), unless an entry names its parent. */
const file = (...lines: string[]) => {
	const f = join(scratch, `2026_s${++n}.jsonl`);
	let before: string | null = null;
	const body = lines.map((l) => {
		const { type, id, parentId = before, ...rest } = JSON.parse(l);
		before = id;
		return `${JSON.stringify({ type, id, parentId, ...rest })}\n`;
	});
	writeFileSync(f, `${JSON.stringify({ type: "session", id: `s${n}` })}\n${body.join("")}`);
	return f;
};
/** The same entry written under `parent`, which is how a move to an earlier entry shows in the file. */
const under = (parent: string, line: string) => JSON.stringify({ ...JSON.parse(line), parentId: parent });

test("the pending call is the one unanswered tool call of the newest assistant message, and none once the user spoke after it", async () => {
	assert.deepEqual((await calls(file(user("hi"), asked("c1")))).map((c) => [c.id, c.name]), [["c1", "ask_user"]]);
	assert.deepEqual(await calls(file(user("hi"), asked("c1"), result("c1", "User answered: red"))), []);
	assert.deepEqual(await calls(file(asked("c1"), user("never mind"))), [], "a newer user message means the turn ended");
	assert.deepEqual((await calls(file(asked("c1", ARGS, "ask_user", [{ id: "c2", name: "bash" }]), result("c2", "ok")))).map((c) => c.id), ["c1"], "a sibling call that finished does not count");
	assert.equal((await pendingOf(file(asked("c1", ARGS, "ask_user", [{ id: "c2", name: "ask_user" }]))))?.why, "It waits on more than one dialog.");
	assert.deepEqual(await pendingOf(file(asked("s1", { label: "Token" }, "secret_drop"))), { callId: "s1", tool: "secret_drop", why: "It waits for a secret." }, "a secret's label is not carried");
	assert.equal(await pendingOf(join(scratch, "missing.jsonl")), undefined);
});

test("an ask_user question is read for display: question, context, options as pi-ask-user coerces them, and how it is answered", () => {
	assert.deepEqual(askOf(ARGS), { ask: { question: "Pick a color", context: "Which theme to ship.", options: [{ title: "red", description: "warm" }, { title: "green" }, { title: "blue" }], multiple: false, freeform: true } });
	assert.deepEqual(askOf({ question: "Name a fruit" }), { ask: { question: "Name a fruit", options: [], multiple: false, freeform: true } });
	assert.deepEqual(askOf({ question: "Q", options: ["a", { label: "b" }, 3, "", {}], allowFreeform: false, allowMultiple: true }), { ask: { question: "Q", options: [{ title: "a" }, { title: "b" }, { title: "3" }], multiple: true, freeform: false } });
	assert.equal((askOf({ question: "Q".repeat(5000), options: Array.from({ length: 80 }, (_, i) => `o${i}`) }) as { ask: { question: string; options: unknown[] } }).ask.question.length, 2000, "clipped");
	assert.equal((askOf({ question: "Q", options: Array.from({ length: 80 }, (_, i) => `o${i}`) }) as { ask: { options: unknown[] } }).ask.options.length, 50);
	for (const [args, why] of [[{ questions: [{ question: "a" }, { question: "b" }] }, /several questions/], [{ options: ["a"] }, /could not be read/], [{ question: "  " }, /could not be read/]] as const) assert.match((askOf(args) as { why: string }).why, why);
	for (const odd of [null, 3, "x", [], { question: 1 }]) assert.doesNotThrow(() => askOf((odd ?? {}) as Record<string, unknown>), "any JSON value");
});

test("a snapshot carries what each waiting unit waits on; others carry nothing", async () => {
	const waiting = file(asked("c9")), idle = file(asked("c8"));
	const unit = (key: string, mark: "waiting" | "idle") => ({ id: key, key, control: true, name: key, role: "main" as const, mark, subs: [] });
	const net: Net = { bases: [{ id: "w", label: "w", mark: "waiting", head: true, tower: null, outposts: [], outside: [], tabs: [{ id: "t", label: "t", units: [unit("a", "waiting"), unit("b", "idle")] }] }] };
	await withPending(net, (key) => ({ a: waiting, b: idle })[key]);
	const [a, b] = net.bases[0]!.tabs[0]!.units;
	assert.deepEqual([a!.pending?.callId, a!.pending?.ask?.question, b!.pending], ["c9", "Pick a color", undefined]);
});

test("an idle unit with a running monitor shows as working, its base too; a finished monitor leaves it idle", async () => {
	const unit = (key: string) => ({ id: key, key, control: true, name: key, role: "main" as const, mark: "idle" as const, subs: [] });
	const net: Net = { bases: [{ id: "w", label: "w", mark: "idle", head: true, tower: null, outposts: [], outside: [], tabs: [{ id: "t", label: "t", units: [unit("a"), unit("b")] }] }] };
	const mon = (status: "running" | "done") => [{ id: "m", what: "npm run dev", status, lines: 0, at: 0 }];
	await withPending(net, () => undefined, { dialogsOf: () => undefined, merge: () => ({}) as never, monitorsOf: (key) => mon(key === "a" ? "running" : "done") });
	const [a, b] = net.bases[0]!.tabs[0]!.units;
	assert.deepEqual([a!.mark, a!.note, b!.mark, net.bases[0]!.mark], ["working", "watching a monitor", "idle", "working"]);
});

test("only the current branch counts: a call left on a branch the user moved away from shows nothing, and the new branch's call shows", async () => {
	const moved = JSON.stringify({ type: "model_change", id: "m1", provider: "p", modelId: "m" });
	assert.deepEqual(await calls(file(user("hi"), asked("c1"), under("u-hi", moved))), [], "the leaf's path ends at the user message, not at the old branch's call");
	assert.deepEqual((await calls(file(user("hi"), asked("c1"), user("never mind"), under("u-hi", asked("c2"))))).map((c) => c.id), ["c2"], "the newest branch's call, not the old branch's, and not the user message that followed the old one");
	const custom = JSON.stringify({ type: "custom", customType: "straw-boss", data: { tower: true }, id: "k1", parentId: "a-c1", timestamp: "2026-10-17T00:00:00.000Z" });
	assert.deepEqual((await calls(file(user("hi"), asked("c1"), custom))).map((c) => c.id), ["c1"], "entries that end with their id and parent are links of the path too");
	assert.deepEqual(await calls(file(user("hi"), asked("c1"), under("a-c1", result("c1", "red")), under("u-hi", user("again")))), [], "a move back to the user message");
});

test("a call longer than the 256 KB window is still read: its question shows clipped, and a call past 16 MB says it is too long instead of showing nothing", async () => {
	const context = "ctx ".repeat(100_000);
	const big = await pendingOf(file(user("hi"), asked("big", { ...ARGS, context })));
	assert.equal(big?.ask?.question, "Pick a color");
	assert.equal(big?.ask?.context?.length, 8000, "the context is clipped, not dropped");
	assert.equal((await pendingOf(file(user("hi"), asked("big2", { ...ARGS, context }), result("big2", "red"))))?.callId, undefined, "answered, so nothing waits");
	const cut = file(user("hi"), asked("huge", { question: "Q", context: "x".repeat(17_000_000) })), huge = await pendingOf(cut);
	assert.deepEqual([huge?.tool, huge?.why, huge?.ask], ["dialog", "Its call is too long to read here.", undefined]);
	assert.equal(await waitsForSecret(cut), true, "a call too long to read might be a secret: the terminal mirror hides");
});

test("a session file whose entries point at each other in a loop is read as undecided, not forever", async () => {
	const loop = (id: string, parentId: string) => JSON.stringify({ type: "model_change", id, parentId, provider: "p", modelId: "m" });
	assert.deepEqual(await calls(file(loop("m1", "m1"))), [], "an entry that is its own parent");
	assert.deepEqual(await calls(file(loop("a", "b"), loop("b", "a"))), [], "two that point at each other");
	assert.equal(await pendingOf(file(user("hi"), asked("c1"), loop("a", "b"), loop("b", "a"))), undefined, "nothing waits that can be shown");
});

// @juicesharp/rpiv-ask-user-question 2.13.9 (tool/types.ts): 1 to 4 questions, each {question, header, options[2-4]{label, description, preview?}, multiSelect?}; "Type something." is always offered.
const Q1 = { question: "Which library should we use for dates?", header: "Library", options: [{ label: "date-fns", description: "Small and tree-shakeable.", preview: "import { format } from 'date-fns'" }, { label: "dayjs", description: "Moment-like API." }], multiSelect: false };
const Q2 = { question: "Which features do you want?", header: "Features", options: [{ label: "tz", description: "Time zones." }, { label: "i18n", description: "Locales." }, { label: "rrule", description: "Recurrence." }], multiSelect: true };

test("an ask_user_question call shows its questions: one reads like an ask_user question, several come as a list with header, options with descriptions, and multi-select; its own words are always taken", async () => {
	assert.deepEqual(questionsOf({ questions: [Q1] }), { ask: { question: Q1.question, header: "Library", options: [{ title: "date-fns", description: "Small and tree-shakeable." }, { title: "dayjs", description: "Moment-like API." }], multiple: false, freeform: true } }, "a preview is not shown");
	const two = questionsOf({ questions: [Q1, Q2] }) as { asks: { header?: string; multiple: boolean; options: unknown[] }[] };
	assert.deepEqual(two.asks.map((a) => [a.header, a.multiple, a.options.length]), [["Library", false, 2], ["Features", true, 3]]);
	assert.equal((questionsOf({ questions: Array.from({ length: 6 }, () => Q1) }) as { asks: unknown[] }).asks.length, 4, "at most four, as the tool allows");
	assert.equal((questionsOf({ questions: [{ ...Q1, header: "H".repeat(100), question: "Q".repeat(5000) }] }) as { ask: { header: string; question: string } }).ask.header.length, 40, "clipped");
	assert.deepEqual(Object.keys((questionsOf({ questions: [{ question: "Bare?", options: [] }] }) as { ask: object }).ask), ["question", "options", "multiple", "freeform"], "a missing header is simply absent");
	for (const bad of [{}, { questions: [] }, { questions: "x" }, { questions: [Q1, { header: "x" }] }, { questions: [null] }, { questions: [{ question: " " }] }]) assert.match((questionsOf(bad as never) as { why: string }).why, /could not be read/);
	// From a session file, through the snapshot's reader; a single question looks like pi-ask-user's, two or more come as `asks`; answered, it waits for nothing.
	const one = await pendingOf(file(user("hi"), asked("q1", { questions: [Q1] }, "ask_user_question")));
	assert.deepEqual([one?.callId, one?.tool, one?.ask?.header, one?.asks, one?.why], ["q1", "ask_user_question", "Library", undefined, undefined]);
	const many = await pendingOf(file(user("hi"), asked("q2", { questions: [Q1, Q2] }, "ask_user_question")));
	assert.deepEqual([many?.tool, many?.ask, many?.asks?.map((a) => a.question)], ["ask_user_question", undefined, [Q1.question, Q2.question]]);
	assert.equal(await pendingOf(file(user("hi"), asked("q3", { questions: [Q1] }, "ask_user_question"), result("q3", "User answered"))), undefined);
	assert.equal((await pendingOf(file(user("hi"), asked("q4", { questions: [Q1] }, "ask_user_question", [{ id: "q5", name: "ask_user_question" }]))))?.why, "It waits on more than one dialog.");
	assert.deepEqual((await pendingOf(file(user("hi"), asked("q6", { questions: [{ question: "" }] }, "ask_user_question"))))?.why, "Its question could not be read.");
	// pi-ask-user's own tool stays readable: older session files hold it.
	assert.equal((await pendingOf(file(user("hi"), asked("old", ARGS))))?.ask?.question, "Pick a color");
});


test("the answer panel's pure rules: the body it sends, what it says for each outcome, every choice offered on every page, controls drawn as U+FFFD", async () => {
	const { bodyOf, offered, replyOf, said, visible } = await import("../gui/ask.ts");
	const a = { dialog: "d1", digest: "f".repeat(64), select: { title: "T", choices: [{ label: "Run" }, { label: "Copy", localOnly: true as const }, { label: "No" }] } };
	assert.deepEqual(bodyOf(a, { choice: 2 }, "id-1234567890abcdef"), { dialog: "d1", digest: "f".repeat(64), answerId: "id-1234567890abcdef", choice: 2 });
	assert.deepEqual(offered(a).map((c) => [c.label, c.i]), [["Run", 0], ["Copy", 1], ["No", 2]], "a choice that acts on the computer is offered on a paired device's page too");
	assert.deepEqual(replyOf(new Set([2, 0]), "  ", "note"), { choices: [0, 2], note: "note" });
	assert.deepEqual(replyOf(new Set(), "own words", " "), { text: "own words" });
	assert.equal(visible("a\u001b[31mb\tc\nd\u009be"), "a\ufffd[31mb\tc\nd\ufffde");
	assert.equal(visible("rm\u202e -rf\u2066\u200b\u061c x"), "rm\ufffd -rf\ufffd\ufffd\ufffd x", "bidi overrides and zero-width marks are drawn, not obeyed");
	const r = (status: number, body: Record<string, unknown>) => ({ ok: status < 300, status, body });
	assert.deepEqual(said(r(200, { outcome: "accepted" })), ["ok", "Answered."]);
	assert.deepEqual(said(r(200, { outcome: "stale", by: "local" })), ["error", "It was already answered in the terminal."]);
	assert.deepEqual(said(r(200, { outcome: "stale", by: "cancel" })), ["error", "It was dismissed in the terminal."]);
	assert.deepEqual(said(r(200, { outcome: "stale", by: "gone" })), ["error", "It is no longer open."]);
	assert.deepEqual(said(r(200, { outcome: "rejected", reason: "digest" })), ["error", "The question changed; read it again."]);
	assert.deepEqual(said(r(200, { outcome: "busy" })), ["error", "Another answer is on its way; check the terminal."]);
	assert.deepEqual(said(r(200, { outcome: "unknown" })), ["error", "Not confirmed. Check the terminal.", true]);
	assert.deepEqual(said(r(504, { outcome: "unknown" })), ["error", "Not confirmed. Check the terminal.", true], "only an unknown outcome offers Check again");
	assert.deepEqual(said(r(409, { error: "changed", reason: "The question changed or is no longer open here; read it again." })), ["error", "The question changed or is no longer open here; read it again."]);
	const { blocked } = await import("../gui/composer.ts");
	const unit = { name: "u", control: true, live: true, mark: "waiting" as const, online: true };
	assert.equal(blocked({ ...unit, answerable: true }), "It waits on a dialog: answer it above, or in its terminal.");
	assert.equal(blocked(unit), "It waits on a dialog; answer it in its terminal.");
});

test("waitsForSecret: any open call of secret_drop, and a file that cannot be read through; a missing file (a new session) is not", async () => {
	assert.equal(await waitsForSecret(file(user("hi"), asked("c1", {}, "secret_drop"))), true);
	assert.equal(await waitsForSecret(file(user("hi"), asked("c1", ARGS, "ask_user", [{ id: "c2", name: "secret_drop" }]))), true, "the second of two open calls");
	assert.equal(await waitsForSecret(file(user("hi"), asked("c1"))), false);
	assert.equal(await waitsForSecret(file(user("hi"), asked("c1", {}, "secret_drop"), result("c1", "done"))), false, "answered");
	assert.equal(await waitsForSecret(join(scratch, "missing.jsonl")), false);
	assert.equal(await waitsForSecret(scratch), true, "a path that cannot be read as a file hides the mirror");
});
