import assert from "node:assert/strict";
import { test } from "node:test";
import { aftermath, blocked, confirmed, recall, withPulled } from "../gui/composer.ts";
import { m } from "../gui/paraglide/messages.js";
import { closed } from "../gui/scene.ts";
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

test("a finished subagent whose pi has exited has a closed channel and a composer that says so; one whose pi still runs keeps both", () => {
	assert.equal(closed({ control: false, ended: true }, "live"), true, "finished, and no pane runs pi on its session");
	assert.equal(closed({ control: true, ended: true }, "live"), false, "finished, but pi still runs (interactive, not auto-exited): it keeps its composer");
	assert.equal(closed({ control: false }, "live"), false, "a unit that has not finished keeps the rule it had (no pane is said by the composer)");
	assert.equal(closed({ control: true }, undefined), false, "the history has not said yet: the unit in the net decides");
	assert.equal(closed(undefined, undefined), true, "neither a unit nor a state");
	for (const unit of [undefined, { control: true }]) assert.equal(closed(unit, "recent"), true, "a session that left the net");
	const gone = { name: "kid", control: false, live: !closed({ control: false, ended: true }, "live"), mark: "done" as const, online: true };
	assert.equal(blocked(gone), m.blocked_ended(), "the existing ended reason, not the pane one");
	assert.equal(blocked({ ...gone, control: true, live: !closed({ control: true, ended: true }, "live") }), undefined, "and an interactive finished subagent can be typed to");
});

test("the queue taken back goes in front of what is already in the box, a blank line between; an empty or blank box takes it as it is", () => {
	assert.equal(withPulled("one\n\ntwo", ""), "one\n\ntwo");
	assert.equal(withPulled("one", "  \n"), "one");
	assert.equal(withPulled("one", "my draft"), "one\n\nmy draft");
});
