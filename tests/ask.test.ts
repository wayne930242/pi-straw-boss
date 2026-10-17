import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { askOf, openCalls, pendingOf, withPending } from "../src/ask.ts";
import type { Net } from "../src/net.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-ask-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const ARGS = { question: "Pick a color", context: "Which theme to ship.", options: [{ title: "red", description: "warm" }, { title: "green" }, { title: "blue" }], allowFreeform: true };
// Session entries as pi writes them (one per line).
const user = (text: string) => JSON.stringify({ type: "message", id: `u-${text}`, message: { role: "user", content: [{ type: "text", text }] } });
const asked = (id: string, args: unknown = ARGS, name = "ask_user", more: { id: string; name: string }[] = []) => JSON.stringify({ type: "message", id: `a-${id}`, message: { role: "assistant", content: [{ type: "text", text: "Asking." }, { type: "toolCall", id, name, arguments: args }, ...more.map((m) => ({ type: "toolCall", id: m.id, name: m.name, arguments: {} }))] } });
const result = (id: string, text: string) => JSON.stringify({ type: "message", id: `r-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "ask_user", content: [{ type: "text", text }] } });
let n = 0;
const file = (...lines: string[]) => {
	const f = join(scratch, `2026_s${++n}.jsonl`);
	writeFileSync(f, `${JSON.stringify({ type: "session", id: `s${n}` })}\n${lines.map((l) => `${l}\n`).join("")}`);
	return f;
};

test("the pending call is the one unanswered tool call of the newest assistant message, and none once the user spoke after it", async () => {
	assert.deepEqual((await openCalls(file(user("hi"), asked("c1")))).map((c) => [c.id, c.name]), [["c1", "ask_user"]]);
	assert.deepEqual(await openCalls(file(user("hi"), asked("c1"), result("c1", "User answered: red"))), []);
	assert.deepEqual(await openCalls(file(asked("c1"), user("never mind"))), [], "a newer user message means the turn ended");
	assert.deepEqual((await openCalls(file(asked("c1", ARGS, "ask_user", [{ id: "c2", name: "bash" }]), result("c2", "ok")))).map((c) => c.id), ["c1"], "a sibling call that finished does not count");
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
