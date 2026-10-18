import assert from "node:assert/strict";
import { test } from "node:test";
import { type Item, toItem } from "../src/items.ts";
import { assistant, call, compaction, custom, message, result, text, user } from "./sessions.ts";

const item = (entry: object, full = false) => toItem(entry as never, 100, full);

test("a user message is text and an image count; system and unknown kinds are hidden", () => {
	assert.deepEqual(item(user("u1", null, "hello\nworld")), { id: "u1", at: "2026-10-17T08:00:01.000Z", kind: "user", text: "hello\nworld", images: 0 });
	const withImage = item(message("u2", null, { role: "user", content: [text("see"), { type: "image", data: "AAAA", mimeType: "image/png" }] })) as Item;
	assert.deepEqual([withImage.images, withImage.pics], [1, undefined], "images are a count until asked for");
	assert.deepEqual((item(message("u2", null, { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }, { type: "image", data: "x", mimeType: "image/svg+xml" }] }), true) as Item).pics, ["data:image/png;base64,AAAA"], "only raster images load");
	for (const hidden of [message("s", null, { role: "system", content: "" }), { type: "custom", id: "c", parentId: null, customType: "ttsr_injection", data: {} }, { type: "label", id: "l" }, { type: "usage", id: "u" }, { type: "context_edit", id: "e" }]) assert.equal(item(hidden), undefined, JSON.stringify(hidden).slice(0, 40));
});

test("an assistant message has markdown text, thinking as a size, one summary line per tool call, and a badge only for error, aborted, or length", () => {
	const a = item(assistant("a1", "u1", [
		{ type: "thinking", thinking: "let me think", thinkingSignature: "sig" }, text("Done."),
		call("t1", "bash", { command: "git status\nsecond line" }), call("t2", "read", { path: "/a/b.ts" }), call("t3", "edit", { path: "/a/c.ts", edits: [] }),
		call("t4", "subagent", { name: "lint", agent: "worker" }), call("t5", "intercom", { action: "send", to: "main", message: "hi\nthere" }), call("t6", "ask_user", { questions: [{ question: "Which?" }] }), call("t11", "ask_user_question", { questions: [{ question: "Which lib?" }, { question: "Which tz?" }, { question: "Which locale?" }] }), call("t12", "ask_user_question", { questions: [{ question: "Only one?" }] }),
		call("t7", "show_doc", { paths: ["/a/x.html", "/a/y.md"] }), call("t8", "todo", { action: "create", subject: "write tests" }), call("t9", "MonitorCreate", { description: "wait for deploy", command: "x" }), call("t10", "mystery", { first: "arg", second: 2 }),
	], { stopReason: "toolUse" })) as Item;
	assert.deepEqual([a.kind, a.text, a.thought, a.model, a.ctx, a.stop], ["assistant", "Done.", 12, "m-1", 1234, undefined]);
	assert.deepEqual(a.tools!.map((t) => [t.name, t.summary]), [
		["bash", "git status"], ["read", "/a/b.ts"], ["edit", "/a/c.ts"], ["subagent", "lint · worker"], ["intercom", "send main hi"], ["ask_user", "Which?"], ["ask_user_question", "Which lib? (+2 more)"], ["ask_user_question", "Only one?"],
		["show_doc", "/a/x.html, /a/y.md"], ["todo", "create write tests"], ["MonitorCreate", "wait for deploy"], ["mystery", "(first: arg)"],
	]);
	assert.equal(a.thoughtText, undefined, "thinking text is fetched on click");
	assert.ok(a.tools!.every((t) => t.args?.startsWith("{")), "the arguments stay whole inside the card");
	assert.equal((item(assistant("a1", "u1", [{ type: "thinking", thinking: "let me think" }]), true) as Item).thoughtText, "let me think");
	for (const stop of ["error", "aborted", "length"]) assert.equal((item(assistant("a", null, [], { stopReason: stop, errorMessage: "boom" })) as Item).stop, stop);
	assert.equal((item(assistant("a", null, [], { stopReason: "aborted", errorMessage: "Operation aborted" })) as Item).error, "Operation aborted");
	assert.equal((item(assistant("a", null, [{ type: "thinking", thinking: "", redacted: true }])) as Item).thought, -1, "redacted thinking is marked");
});

test("a question tool's summary is its questions' headers, short enough for a phone; a tool with only structured arguments names them instead of printing objects", () => {
	const two = [{ question: "Ship the phone check?", header: "Phone\nextra line", options: [{ label: "Yes" }] }, { question: "Which channels?", header: " Channels ", multiSelect: true, options: [{ label: "email", description: "Mail" }] }];
	const a = item(assistant("a1", "u1", [
		call("t1", "ask_user_question", { questions: two }), call("t2", "ask_user_question", { questions: [two[0]] }), call("t3", "ask_user_question", { questions: [two[0], { question: "No header?" }] }),
		call("t4", "ask_user", { question: "Which?\nmore context", options: ["a", "b"] }),
		call("t5", "mystery", { config: { deep: true }, items: [{ a: 1 }] }), call("t6", "mystery", { config: { deep: true }, path: "src/a.ts" }), call("t7", "mystery", {}),
		call("t8", "ask_user_question", { questions: JSON.stringify(two) }), call("t9", "ask_user_question", { questions: "not json" }), call("t10", "ask_user_question", { questions: JSON.stringify({ question: "Solo?" }) }), call("t11", "ask_user_question", { questions: "42" }),
	])) as Item;
	assert.deepEqual(a.tools!.map((t) => t.summary), ["Phone · Channels", "Phone", "Ship the phone check? (+1 more)", "Which?", "(config, items)", "(path: src/a.ts)", "()", "Phone · Channels", "not json", "Solo?", "42"]);
	assert.ok(!a.tools!.some((t) => /[{}[\]]|\[object/.test(t.summary)), "no summary is raw JSON");
	assert.match(a.tools![0]!.args!, /"Which channels\?"/, "the full questions stay reachable inside the card");
});

test("a tool call's arguments past 1500 characters are marked cut, and the full entry carries them whole", () => {
	const long = assistant("a1", "u1", [call("t1", "write", { path: "a.ts", content: "x".repeat(4000) }), call("t2", "bash", { command: "ls" })]);
	const [cut, short] = (item(long) as Item).tools!;
	assert.deepEqual([cut!.args!.length, cut!.cut, short!.cut], [1500, true, undefined]);
	const whole = (item(long, true) as Item).tools![0]!;
	assert.deepEqual([whole.args!.length > 4000, whole.cut], [true, undefined]);
});

test("a tool result carries its call id, a 2 KB preview, and its size; the full entry lifts the cap", () => {
	const big = "x".repeat(5000);
	const r = item(result("r1", "a1", "t1", big, true)) as Item;
	assert.deepEqual([r.kind, r.callId, r.isError, r.text!.length, r.more, r.bytes, r.name], ["result", "t1", true, 2048, true, 100, "bash"]);
	const whole = item(result("r1", "a1", "t1", big), true) as Item;
	assert.deepEqual([whole.text!.length, whole.more], [5000, false]);
	assert.equal((item(result("r2", "a1", "t1", "x".repeat(2_000_000)), true) as Item).text!.length, 1 << 20, "a full entry is capped at 1 MB");
});

test("bash executions, displayed custom messages, compactions, branch summaries, and meta entries each have an item; hidden custom messages do not", () => {
	assert.deepEqual(item(message("b1", null, { role: "bashExecution", command: "ls\nmore", output: "a b", exitCode: 2 })), { id: "b1", at: "2026-10-17T08:00:01.000Z", kind: "bash", command: "ls", exit: 2, text: "a b", more: false });
	const sub = item(custom("n1", null, "subagent_result", "done", true, { name: "lint", sessionFile: "/s/2026-10-17T00-00-00Z_child-9.jsonl" })) as Item;
	assert.deepEqual([sub.kind, sub.type, sub.from, sub.link], ["notice", "subagent_result", "lint", "child-9"], "a subagent result links the child's session");
	assert.equal((item(custom("n2", null, "intercom_message", "hi", true, { from: { name: "ops" } })) as Item).from, "ops");
	assert.equal(item(custom("n3", null, "memory-context", "secret", false)), undefined);
	const k = item(compaction("k1", "a1", "## Goal")) as Item;
	assert.deepEqual([k.kind, k.type, k.tokens, k.text], ["divider", "compaction", 90_000, "## Goal"]);
	assert.deepEqual([(item({ type: "branch_summary", id: "bs", parentId: null, summary: "side quest" }) as Item).type, (item({ type: "model_change", id: "m", provider: "p", modelId: "x" }) as Item).text, (item({ type: "thinking_level_change", id: "t", thinkingLevel: "high" }) as Item).text, (item({ type: "session_info", id: "i", name: "Work" }) as Item).text], ["branch", "model p/x", "thinking high", "session named Work"]);
});
