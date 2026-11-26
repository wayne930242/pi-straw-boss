import assert from "node:assert/strict";
import { test } from "node:test";
import "./pbs-loader.ts";
import { commandLine, deliverToDoc, deliverToUnit } from "../gui/blockanswer.ts";
import { fieldsOf } from "../src/docs.ts";
import { answerOfFields } from "../src/documents.ts";
import { hasBlocks } from "../gui/mdbody.ts";
import type { Answer as Posted } from "../gui/post.ts";

// How a block's answer leaves the page: the hint that decides whether the block code loads at all, the text a chat block sends as the boss's message (its guards), and the Answer a document block's answer goes out as.

const { BLOCK_KINDS, encodeAnswer } = await import("pi-better-show");
const ok = (body: Record<string, unknown> = { accepted: true }): Posted => ({ ok: true, status: 200, body });
const refuse = (status: number, error: string, reason?: string): Posted => ({ ok: false, status, body: { error, ...(reason ? { reason } : {}) } });

test("the hint finds exactly the texts the block parser would split: a fence of a block kind (any fence length, either marker, up to three spaces in) or a GitHub alert", () => {
	for (const kind of BLOCK_KINDS.filter((k) => k !== "alert")) {
		assert.ok(hasBlocks(`text\n\n\`\`\`${kind}\nx\n\`\`\``), kind);
		assert.ok(hasBlocks(`~~~${kind.toUpperCase()}\nx\n~~~`), `${kind} in capitals`);
		assert.ok(hasBlocks(`  \`\`\`\`${kind} extra words\nx\n\`\`\`\``), `${kind} in a long fence with words after`);
	}
	for (const alert of ["NOTE", "tip", "IMPORTANT", "Warning", "CAUTION"]) assert.ok(hasBlocks(`> [!${alert}] t\n> body`), alert);
	assert.ok(hasBlocks("> [!NOTE]"), "an alert with no title");
	assert.ok(hasBlocks("Files:\n\n```tree\nrepo/\n  a.ts\n```"), "a tree alone loads the block code (0.4.0)");
	for (const none of ["plain **text**", "```js\nlet a\n```", "```formal\nx\n```", "```treehouse\nx\n```", "```trees\nx\n```", "    ```form\nx\n```", "> a quote\n> [!NOTES]\n", "> text [!NOTE]", "`form`", "form\n```\nx\n```"]) assert.ok(!hasBlocks(none), none);
});

test("an HTML review form keeps group names, repeated picks, and a review with no checkbox ticked", () => {
	for (const [query, lines] of [
		["picked%3AHeader=Compact&picked%3AChangelog=List", "\nPicked (Header): Compact\nPicked (Changelog): List"],
		["picked=Desktop&picked=Phone", "\nPicked: Desktop\nPicked: Phone"],
		["", ""],
	]) {
		const fields = fieldsOf(`pi-kind=review&title=Release&${query}`);
		assert.ok(Array.isArray(fields));
		assert.equal(encodeAnswer(answerOfFields(fields)), `User reviewed "Release":${lines}`);
	}
});

test("a command line is a text beginning with ! or /, after any space: a block never sends one", () => {
	for (const line of ["/quit", "  /boss gui stop", "!rm -rf x", "\n!ls", "/new"]) assert.ok(commandLine(line), line);
	for (const text of ["Go ahead", "User picked \"A\".", "a / b", "ok!", "https://x/y"]) assert.ok(!commandLine(text), text);
});

test("a chat block's answer goes to the unit as the boss's message through the composer's input route, held to a paired device's guards", async () => {
	const posts: Record<string, unknown>[] = [];
	const to = deliverToUnit(async (body) => (posts.push(body), ok()), { entry: "e7", index: 2, fields: [["text", "Go ahead"]] });
	assert.deepEqual(await to("Go ahead"), { ok: true });
	assert.deepEqual(posts, [{ text: "Go ahead", as: "send", guarded: true, block: { entry: "e7", index: 2, fields: [["text", "Go ahead"]] } }], "guarded: the server's local-only /boss refusal applies here too; the block names itself so the server can record that it was answered");
	assert.equal(posts.length, 1);
});

test("a chat block never sends a command line, and nothing is posted for one", async () => {
	const posts: unknown[] = [];
	const to = deliverToUnit(async (body) => (posts.push(body), ok()), { entry: "e", index: 0, fields: [] });
	for (const line of ["/quit", "/boss gui stop", "!rm -rf ~"]) {
		const r = await to(line);
		assert.equal(r.ok, false, line);
		assert.ok(!r.ok && r.reason.length > 0);
	}
	assert.deepEqual(posts, []);
});

test("what the server refuses is said in its words (or the page's), an unconfirmed send as unsure, a network failure as unsure", async () => {
	const to = (r: Posted | Error) => deliverToUnit(async () => { if (r instanceof Error) throw r; return r; }, { entry: "e", index: 0, fields: [] });
	assert.deepEqual(await to(refuse(409, "not_live", "This session is no longer live in a pane."))("x"), { ok: false, reason: "This session is no longer live in a pane." });
	const local = await to(refuse(403, "local_only", "A /boss send is held to the guards of a remote write."))("x");
	assert.ok(!local.ok && /remote write/.test(local.reason));
	const unsure = await to(refuse(504, "timeout"))("x");
	assert.ok(!unsure.ok && /Not confirmed/.test(unsure.reason));
	const down = await to(new Error("network"))("x");
	assert.ok(!down.ok && /Not confirmed/.test(down.reason));
});

test("a chat block already answered elsewhere comes back as the fields that went, so the page locks it", async () => {
	const had: Posted = { ok: false, status: 409, body: { error: "answered", reason: "This block was answered already.", fields: [["text", "Go"]] } };
	const r = await deliverToUnit(async () => had, { entry: "e", index: 0, fields: [["text", "Later"]] })("Later");
	assert.deepEqual(r, { ok: false, reason: "This block was answered already.", answered: [["text", "Go"]] });
});

test("only the server's `answered` 409 locks a block: any other refusal, even one that carries fields, leaves it open", async () => {
	const other: Posted = { ok: false, status: 409, body: { error: "blocked", reason: "It is waiting on a dialog.", fields: [["text", "Go"]] } };
	const r = await deliverToUnit(async () => other, { entry: "e", index: 0, fields: [] })("Later");
	assert.deepEqual(r, { ok: false, reason: "It is waiting on a dialog." });
});

test("a document block\'s answer is posted to the document's answer route as the Answer, with the hash of the text it drew and one answer id of its own", async () => {
	const posts: [string, Record<string, unknown>][] = [];
	const to = deliverToDoc(async (path, body) => (posts.push([path, body]), ok()), "cap/with space", "0123456789abcdef");
	const answer = { kind: "form" as const, fields: [["a", "1"]] as [string, string][], ref: { doc: "cap/with space", block: 3 } };
	assert.deepEqual(await to(answer), { ok: true });
	const [[path, body]] = posts as [[string, { answerId: string; answer: unknown; rev: string }]];
	assert.equal(path, "doc/cap%2Fwith%20space/answer");
	assert.match(body.answerId, /^[A-Za-z0-9_-]{16,64}$/);
	assert.deepEqual([body.answer, body.rev], [answer, "0123456789abcdef"]);
	await to(answer);
	assert.notEqual((posts[1]![1] as { answerId: string }).answerId, body.answerId, "each answer has an id of its own");
	const gone = await deliverToDoc(async () => refuse(409, "closed", "The document is no longer open in its session."), "c", "0123456789abcdef")(answer);
	assert.deepEqual(gone, { ok: false, reason: "The document is no longer open in its session." });
	const lost = await deliverToDoc(async () => refuse(504, "not_confirmed", "Check the terminal."), "c", "0123456789abcdef")(answer);
	assert.ok(!lost.ok && /Check the terminal|Not confirmed/.test(lost.reason));
	const had = await deliverToDoc(async () => ({ ok: false, status: 409, body: { error: "answered", reason: "This block was answered already.", fields: [["a", "0"]] } }), "c", "0123456789abcdef")(answer);
	assert.deepEqual(had, { ok: false, reason: "This block was answered already.", answered: [["a", "0"]] });
});
