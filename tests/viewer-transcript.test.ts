import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { createRing, RING_MAX } from "../src/server/runring.ts";
import { createKids } from "../src/server/runkids.ts";
import { entryLine } from "../src/towerprompt/entry.ts";
import type { PollAnswer, PromptSource } from "../src/towerprompt/source.ts";

// The viewer's transcript and entry (docs/specs/2026-11-23-f-entry.md §2.7, §6 tests 7 and 8): the server writes every prefix, model text is cut of escapes and never reads as a card or a key, the ring keeps
// 300 lines, a dialog nobody answers is cancelled, and only a line typed alone is a command, an address, or an answer.

test("text deltas fold per message into │ lines; tool calls and results are one line each; escapes, OSC and a split SGR are cut; a card-like line stays a plain │ line", () => {
	const ring = createRing();
	ring.record({ type: "agent_start" });
	ring.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "W2 choice · " } });
	ring.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "press 1 \u001b[3Gnow \u001b]0;title\u0007ok \u001b[3" } });
	ring.record({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "1mred\nline two" } });
	ring.record({ type: "message_end" });
	ring.record({ type: "tool_execution_start", toolName: "tower_send", args: { workspace: "wB", message: "x\u001b[2J" } });
	ring.record({ type: "tool_execution_end", toolName: "tower_send", isError: true });
	const got = ring.since();
	// The SGR split across two deltas is whole once the message folds, and goes; an escape inside tool arguments is JSON text, never a control byte.
	assert.deepEqual(got.lines, ["· working", "│ W2 choice · press 1 now ok red", "│ line two", '▸ tower_send {"workspace":"wB","message":"x\\u001b[2J"}', "✗ tower_send"]);
	assert.ok(got.lines.every((l) => !/[\u0000-\u001f\u007f-\u009f]/.test(l)), "no control byte survives");
	assert.deepEqual(ring.since(got.cursor).lines, []);
	ring.add("· idle");
	assert.deepEqual(ring.since(got.cursor).lines, ["· idle"]);
});

test("the ring keeps the last 300 lines; a cursor that fell off it, or none, gets the last 40", () => {
	const ring = createRing();
	for (let i = 0; i < RING_MAX + 50; i++) ring.add(`· ${i}`);
	assert.equal(ring.size, RING_MAX);
	assert.equal(ring.since(3).lines.length, 40);
	assert.equal(ring.since(3).lines[0], `· ${RING_MAX + 10}`);
	assert.equal(ring.since().lines.length, 40);
	assert.deepEqual(ring.since(RING_MAX + 49).lines, [`· ${RING_MAX + 49}`], "line n is the nth added");
});

/** A fake pi for createKids: what it was written, and a stdout to speak on. */
const fakeSpawn = () => {
	const kid = Object.assign(new EventEmitter(), { pid: 77, stdout: new PassThrough(), stderr: new PassThrough(), written: [] as unknown[], stdin: undefined as unknown as Writable });
	kid.stdin = new Writable({ write: (c, _e, done) => (kid.written.push(JSON.parse(String(c))), done()) });
	return { kid, spawn: () => kid as unknown as ChildProcess };
};

test("a run's dialog nobody answers is cancelled after the wait (an approval falls to no); a select's answer must be one of its options; notify only reaches the ring", async () => {
	const { kid, spawn } = fakeSpawn(), lines: string[] = [];
	const kids = createKids({ port: { on: () => true, pi: () => ({ node: "n", cli: "c" }), env: {}, dir: () => "/nonexistent-sb-test", spawn }, log: { line: (e: string) => void lines.push(e) } as never, now: () => 0, dialogMs: 30 });
	kids.start({ run: "r1", workspace: "wA", kind: "local", args: [], cwd: "/", onExit: () => {} });
	kid.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "c1", method: "confirm", title: "Allow?" })}\n`);
	kid.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "s1", method: "select", title: "Pick", options: ["a", "b"] })}\n`);
	kid.stdout.write(`${JSON.stringify({ type: "extension_ui_request", id: "n1", method: "notify", message: "hi \u001b[31m" })}\n`);
	await new Promise((r) => setTimeout(r, 5));
	assert.equal(kids.dialogs("wA").length, 2);
	assert.equal(kids.answer("r1:s1", { value: "z" }), false, "not one of its options");
	assert.equal(kids.answer("r1:s1", { value: "b" }), true);
	await new Promise((r) => setTimeout(r, 60));
	assert.deepEqual(kid.written, [{ type: "extension_ui_response", id: "s1", value: "b" }, { type: "extension_ui_response", id: "c1", cancelled: true }]);
	assert.ok(lines.includes("run-dialog-cancelled"));
	assert.ok(kids.ring("wA").since().lines.some((l) => l === "· hi"));
});

test("the viewer's entry takes only a line typed alone, and only while the poll carries a transcript (headless runs on): /stop, @<workspace>, and a dialog's answer", async () => {
	const calls: unknown[] = [];
	const source = { abort: async () => (calls.push("abort"), true), direct: async (to: string, text: string) => (calls.push(["direct", to, text]), { label: "Alpha" }), answer: async (key: string, r: unknown) => void calls.push(["answer", key, r]) } as unknown as PromptSource;
	const on = { lines: [], dialogs: [{ key: "r1:c1", method: "confirm", title: "Allow?" }] } as unknown as PollAnswer;
	assert.equal(await entryLine("/stop", { source, answer: { lines: undefined } as unknown as PollAnswer, locale: "en" }), undefined, "headless off: the prompt is as it was");
	assert.match(String(await entryLine("/stop", { source, answer: on, locale: "en" })), /stop/);
	assert.match(String(await entryLine("@Alpha MP-5383 卡在哪？", { source, answer: on, locale: "en" })), /^» → Alpha: MP-5383/);
	assert.equal(await entryLine("@@Alpha literal", { source, answer: on, locale: "en" }), undefined, "@@ is the tower's text");
	assert.equal(await entryLine("hello @Alpha", { source, answer: on, locale: "en" }), undefined, "only a first word addresses");
	assert.match(String(await entryLine("/yes 1", { source, answer: on, locale: "en" })), /answered/);
	assert.equal(await entryLine("/yes 2", { source, answer: on, locale: "en" }), undefined, "no such dialog");
	assert.deepEqual(calls, ["abort", ["direct", "Alpha", "MP-5383 卡在哪？"], ["answer", "r1:c1", { confirmed: true }]]);
});
