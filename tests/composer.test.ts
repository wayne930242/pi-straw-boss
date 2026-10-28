import assert from "node:assert/strict";
import { test } from "node:test";
import { aftermath, blocked, confirmed, deposit, endTake, recall, recallTake, rescue, settleTake, startTake, takeWhy, typable, withPulled } from "../gui/composer.ts";
import { m } from "../gui/paraglide/messages.js";
import { channelOf, closed } from "../gui/scene.ts";
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

test("an ally run's comms say a teammate's message drives them and take no typing; a tower with only an ally run working still says a message wakes a run of the boss's own", () => {
	const unit = { name: "Laptop", control: false, live: true, mark: "unknown" as const, online: true };
	assert.equal(blocked({ ...unit, ally: true }), m.blocked_ally());
	assert.equal(blocked(unit), m.blocked_no_pane(), "any other unit with no pane keeps its reason");
	assert.notEqual(m.blocked_ally(), m.blocked_no_pane());
	assert.match(m.placeholder_ally(), /ally run/);
	assert.notEqual(m.placeholder_ally(), m.placeholder_wake());
});

test("an ally run's comms are not an open channel and take no typing: the header says read only, the box and attach are off, and the reason is the ally one (GR-F002)", () => {
	const unit = { name: "Laptop", control: false, live: true, mark: "unknown" as const, online: true };
	assert.equal(channelOf(undefined, "live", true), "readonly");
	assert.equal(channelOf(undefined, "recent", true), "readonly", "a run that left the net is still not written to");
	assert.equal(channelOf({ control: true }, "live", false), "live");
	assert.equal(channelOf(undefined, undefined, false), "none");
	assert.equal(channelOf({ control: false, ended: true }, "live", false), "closed");
	assert.notEqual(m.channel_readonly(), m.channel_open());
	assert.equal(typable({ ...unit, ally: true }), false);
	assert.equal(typable(unit), true, "any other live unit is typed to");
	assert.equal(typable({ ...unit, live: false }), false);
	assert.equal(blocked({ ...unit, ally: true }), m.blocked_ally(), "the reason shown is the ally one");
});

test("the queue taken back goes in front of what is already in the box, a blank line between; an empty or blank box takes it as it is", () => {
	assert.equal(withPulled("one\n\ntwo", ""), "one\n\ntwo");
	assert.equal(withPulled("one", "  \n"), "one");
	assert.equal(withPulled("one", "my draft"), "one\n\nmy draft");
});

/** A sessionStorage the test can make refuse, installed for the module under test. */
const storage = (() => {
	const map = new Map<string, string>();
	const refuse = { on: false };
	Object.defineProperty(globalThis, "sessionStorage", {
		configurable: true,
		value: {
			getItem: (k: string) => { if (refuse.on) throw new Error("denied"); return map.get(k) ?? null; },
			setItem: (k: string, v: string) => { if (refuse.on) throw new Error("denied"); map.set(k, v); },
			removeItem: (k: string) => { if (refuse.on) throw new Error("denied"); map.delete(k); },
		},
	});
	return { map, refuse };
})();

test("a take-back's reply is stored in the draft of a session whose composer is gone (R-F001), in front of the draft, with a note for the composer that comes back", () => {
	storage.map.clear();
	const key = "sess-gone";
	storage.map.set(`sb-draft:${key}`, "typed meanwhile");
	const id = startTake(key);
	settleTake(key, { ok: true, status: 200, body: { text: "one\n\ntwo" } }); // no composer on the page: `into` is not given
	assert.equal(storage.map.get(`sb-draft:${key}`), "one\n\ntwo\n\ntyped meanwhile", "nothing is lost with the composer");
	assert.deepEqual(recall(storage.map.get(`sb-draft:${key}:note`) ?? null), ["ok", m.edit_taken()]);
	assert.equal(recallTake(key), undefined, "an answer settles the take-back: its id is dropped");
	assert.ok(id.length >= 16 && id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(id), "an id the server accepts");
});

test("a take-back's reply goes into the box of the composer still on the page, and is saved", () => {
	storage.map.clear();
	const box = { value: "draft" };
	let saved = 0;
	startTake("sess-here");
	settleTake("sess-here", { ok: true, status: 200, body: { text: "queued" } }, { box, save: () => saved++ });
	assert.equal(box.value, "queued\n\ndraft");
	assert.equal(saved, 1);
	assert.equal(storage.map.has("sb-draft:sess-here"), false, "stored by the composer's own save, not twice");
});

test("a storage that refuses still keeps the reply for the next composer of the session", () => {
	storage.map.clear();
	storage.refuse.on = true;
	try {
		deposit("sess-deny", "lost?");
		deposit("sess-deny", "also");
	} finally {
		storage.refuse.on = false;
	}
	assert.equal(rescue("sess-deny", "draft"), "also\n\nlost?\n\ndraft");
	assert.equal(rescue("sess-deny", "draft"), "draft", "handed over once");
});

test("the take-back's id outlives the answer that is unsure (504, busy, no answer) and is dropped by any other; the same id comes back until then, and for ten minutes", () => {
	storage.map.clear();
	const key = "sess-id", id = startTake(key);
	assert.equal(recallTake(key), id);
	for (const status of [504, 429]) {
		settleTake(key, { ok: false, status, body: {} });
		assert.equal(recallTake(key), id, `${status} keeps it: the session may still hold the messages`);
	}
	assert.equal(storage.map.get(`sb-draft:${key}:take`)?.endsWith(`:${id}`), true, "and it survives a reload of the page");
	assert.equal(recallTake(key, Date.now() + 541_000), undefined, "past the time the session keeps them it is no use");
	assert.equal(storage.map.has(`sb-draft:${key}:take`), false);
	const next = startTake(key);
	assert.notEqual(next, id);
	for (const [status, error] of [[409, "blocked"], [409, "moved"], [502, "herdr"], [403, "csrf"]] as const) {
		settleTake(key, { ok: false, status, body: { error, reason: "no" } });
		assert.equal(recallTake(key), next, `${status} ${error} keeps it: a lost reply may still be kept by the session`);
	}
	settleTake(key, { ok: false, status: 409, body: { error: "changed", reason: "no" } });
	assert.equal(recallTake(key), undefined, "the bridge's own refusal settles it");
	startTake(key);
	settleTake(key, { ok: false, status: 400, body: { error: "bad_request", reason: "no" } });
	assert.equal(recallTake(key), undefined, "a bad request settles it");
	startTake(key);
	settleTake(key, { ok: true, status: 200, body: { empty: true } });
	assert.equal(recallTake(key), undefined);
	endTake(key);
});

test("a take-back's refusal is worded in the page's language, by the server's code; the key that went is named; an unsure answer and any other refusal keep the server's reason", () => {
	const refusal = (error: string, extra = {}) => ({ ok: false, status: 409, body: { error, reason: "English from the server", ...extra } });
	for (const error of ["no_key", "no_editor", "stale", "not_taken", "changed", "too_large", "not_cleared", "blocked", "local_only", "rate", "busy"]) {
		const en = takeWhy(refusal(error, { label: "Alt+Q" }), "en"), zh = takeWhy(refusal(error, { label: "Alt+Q" }), "zh-TW");
		assert.ok(en && zh && en !== zh, error);
		assert.match(zh, /[\u4e00-\u9fff]/, `${error} is Chinese under zh-TW`);
		assert.doesNotMatch(zh, /\b(?:the|and|its)\b/, `${error} has no English words left`);
	}
	assert.match(takeWhy(refusal("not_taken", { key: "alt+q", label: "Alt+Q" }), "en")!, /Alt\+Q/);
	assert.match(takeWhy(refusal("not_taken", { key: "alt+q", label: "Alt+Q" }), "zh-TW")!, /Alt\+Q/);
	assert.equal(takeWhy({ ok: false, status: 504, body: { error: "unsure", reason: "x" } }, "zh-TW"), undefined, "504 has its own note");
	assert.equal(takeWhy({ ok: false, status: 409, body: { error: "moved", reason: "x" } }, "zh-TW"), undefined, "anything else shows what the server said");
	assert.equal(takeWhy({ ok: true, status: 200, body: { text: "t" } }, "zh-TW"), undefined);
	settleTake("sess-nokey", { ok: false, status: 409, body: { error: "no_key", reason: "x" } });
	assert.equal(recallTake("sess-nokey"), undefined);
});
