import assert from "node:assert/strict";
import { test } from "node:test";
import { aftermath, confirmed, recall } from "../gui/composer.ts";
import type { Answer } from "../gui/post.ts";

const answer = (status: number, reason?: string): Answer => ({ ok: status < 400, status, body: reason ? { reason } : {} });

test("an answer that arrives while the composer is gone leaves its reason for the next one: a refusal says why, a timeout says it is unconfirmed", () => {
	assert.deepEqual(aftermath(answer(409, "It waits on a dialog; answer it in its terminal."), "hello", "hello"), ["error", "It waits on a dialog; answer it in its terminal."]);
	assert.deepEqual(aftermath(answer(429), "hello", "hello"), ["error", "Refused (429)."], "a refusal with no reason still says it was refused");
	assert.match(aftermath(answer(504, "Herdr did not confirm it in time."), "hello", "hello")![1], /^Not confirmed\. Check the terminal/);
});

test("text edited after it was sent, while away, says the original already went; an untouched or emptied draft says nothing", () => {
	assert.deepEqual(aftermath(answer(200), "hellp", "hello"), ["ok", "The original already went to the session; what is here is your edited copy, unsent."]);
	assert.equal(aftermath(answer(200), "hello", "hello"), undefined);
	assert.equal(aftermath(answer(200), "hello\nmore", "hello"), undefined, "text typed after it is not an edit of it");
	assert.equal(aftermath(answer(200), "", "hello"), undefined, "the user cleared the box");
	assert.equal(aftermath(answer(200), undefined, "hello"), undefined, "the browser refused storage: there is no draft to describe");
});

test("a composer claims 'your edits stayed' only when its box really holds edits, not when the browser refused storage and the box is empty", () => {
	assert.match(confirmed("hellp", "hello"), /your edits stayed here, unsent/);
	assert.equal(confirmed("hello", "hello"), "", "a plain send says nothing: it shows in the log");
	assert.equal(confirmed("hello more", "hello"), "");
	assert.equal(confirmed("", "hello"), "", "an empty box (nothing could be stored) holds no edits");
});


test("a stored note is read back as written: ours as [tone, text], a plain-text one from 0.5.0 as an error line, nothing as nothing", () => {
	assert.deepEqual(recall(JSON.stringify(["ok", "Sent."])), ["ok", "Sent."]);
	assert.deepEqual(recall("Not confirmed. Check the terminal before sending again."), ["error", "Not confirmed. Check the terminal before sending again."], "left behind by 0.5.0");
	assert.deepEqual(recall("[broken"), ["error", "[broken"], "a damaged note still says something");
	assert.equal(recall(null), undefined);
	assert.equal(recall(""), undefined);
});
