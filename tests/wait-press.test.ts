import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { addWait, loadMemory, updateMemory } from "../src/server/towermemory.ts";
import { deliveryOf, pressRequest } from "../src/server/waitpress.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { fieldsOf } from "../src/header.ts";

// The press of a wait card (docs/specs/2026-11-07-wait-cards.md, The press): the boss's button changes the wait, tells the raising main by session id, and only then wakes the tower with an event that says whether the raiser got the notice.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string; status?: number; body?: Record<string, unknown> };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const from = { id: "main-1", name: "mp3946-print" };
const msg = (id: string, text: string) => ({ id, content: { text } });
const tower = () => world.client("sb-tower-wa")!;
const memory = () => loadMemory(world.slot, "wA").memory;
const MAIN = { id: "main-1", name: "mp3946-print", herdrLocation: { status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "MP-3946" }, paneId: "wA:p1" } };
const setup = async () => {
	world.sessions = [MAIN] as never;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
const claim = async (s: Running) => {
	await until(() => world.pis.size >= 1, "the run");
	const id = [...world.pis.keys()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const pi = world.pis.get(id)!;
	let got: Reply | undefined;
	await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	return { id, token: String(got!.token) };
};
const drain = async (s: Running, token: string) => {
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) return;
		await ask(s, { cmd: "run-taken", token, id: event.id });
	}
};
const CARD = { op: "add", kind: "wait", for: "boss", type: "action", from: "main-1", happened: "The key of fonstar-staging expired and the machine is offline.", do: "Re-authorize fonstar-staging in the Tailscale admin page.", url: "https://login.tailscale.com/admin/machines", after: "The tower asks the main to test the print feature." };
const CHOICE = { op: "add", kind: "wait", for: "boss", type: "choice", from: "main-1", happened: "The build is ready for ws01.", do: "Deploy the build to ws01 now?", options: [{ label: "Deploy", then: "The main deploys at once." }, { label: "Hold", then: "The main waits for Monday." }] };
const SECRET = { op: "add", kind: "wait", for: "boss", type: "secret", from: "main-1", happened: "The deploy to fonstar-staging needs a new auth key.", do: "Create a Tailscale auth key and enter it when asked.", after: "The main stores it and deploys.", secret: { name: "the Tailscale auth key for fonstar-staging" } };
/** A run that took the main's message adds the waits; the run is left standing so the queue holds only what the press adds. */
const waits = async (s: Running, ...cards: Record<string, unknown>[]) => {
	tower().incoming(from, msg("m0", "the print deploy is blocked"));
	const run = await claim(s);
	await drain(s, run.token);
	for (const card of cards) {
		const done = await ask(s, { cmd: "run-tool", token: run.token, tool: "tower_memory", args: card });
		assert.equal(done.ok, true, JSON.stringify(done));
	}
	assert.equal((await ask(s, { cmd: "run-done", token: run.token, note: "n" })).ok, true);
	world.live.delete(world.pis.get(run.id)!.pid);
	await until(() => readRun(world.slot, "wA", run.id)?.outcome, "the run to end");
};
const press = (s: Running, json: Record<string, unknown>) => ask(s, { cmd: "tower-memory", workspace: "wA", json });
const bossEvents = () => readQueue(world.slot, "wA").filter((e) => e.kind === "boss");

test("done on an action card: one notice to the raiser by id, under a wait_card header, then the tower's event (marked press) says the raiser got it; the wait is answered with its press", async () => {
	const s = await setup();
	await waits(s, CARD);
	const before = tower().sent.length;
	const done = await press(s, { op: "press", id: "W1", act: "done" });
	assert.equal(done.ok, true, JSON.stringify(done));
	assert.equal(done.status, 200, JSON.stringify(done.body));
	const notices = tower().sent.slice(before);
	assert.equal(notices.length, 1, "one notice per press");
	assert.equal(notices[0]!.to, "main-1", "by id");
	const f = fieldsOf(notices[0]!.text)!;
	assert.deepEqual({ kind: f.kind, reply: f.reply, wait: f.wait, why: f.why, id: f.id }, { kind: "wait_card", reply: "none", wait: "W1", why: undefined, id: "sb-tower-wa" });
	assert.match(notices[0]!.text, /\] The boss did what wait W1 asked: Re-authorize fonstar-staging in the Tailscale admin page\. This is the boss's answer to your wait: act on it\.$/); // main.md's wait_card line moved here (docs/specs/2026-11-26-just-in-time-prompts.md)
	const [w] = memory().entries;
	assert.equal(w!.state, "answered");
	assert.deepEqual([w!.press!.act, w!.press!.main!.status], ["done", "delivered"]);
	const [event] = bossEvents();
	assert.equal((event as { press?: boolean }).press, true, "the event is marked as a press's text");
	assert.match(event!.text, /^The boss pressed "我做完了|I'm done" on wait W1 \(Re-authorize fonstar-staging in the Tailscale admin page\.\)\. Check it, then resolve W1: The tower asks the main to test the print feature\. mp3946-print got it\.$/);
	assert.equal(event!.from?.name, "the boss (wait card)");
});

test("the notice goes to the id and never to a name: a subagent shows on intercom under another name", async () => {
	world.sessions = [{ ...MAIN, name: "subagent-chat-7f3a" }, { id: "main-2", name: "main-1" }] as never;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await waits(s, CARD);
	await press(s, { op: "press", id: "W1", act: "done" });
	assert.deepEqual(tower().sent.filter((m) => fieldsOf(m.text)?.kind === "wait_card").map((m) => m.to), ["main-1"]);
});

test("a raiser that left the net is gone: nothing is sent, and the tower's event says so; a failed delivery says failed", async () => {
	const s = await setup();
	await waits(s, CARD, CARD);
	world.sessions = [];
	const before = tower().sent.length;
	await press(s, { op: "press", id: "W1", act: "done" });
	assert.equal(tower().sent.length, before, "nothing is sent to a session that is not live");
	assert.equal(memory().entries[0]!.press!.main!.status, "gone");
	assert.match(bossEvents()[0]!.text, /mp3946-print was not reached \(gone\): tell it yourself, or tell its owner if it is gone\.$/);
	world.sessions = [MAIN] as never;
	tower().deliver = { delivered: false, reason: "broker said no" };
	await press(s, { op: "press", id: "W2", act: "done" });
	assert.equal(memory().entries[1]!.press!.main!.status, "failed");
	assert.match(bossEvents()[1]!.text, /was not reached \(failed\)/);
});

test("deliveryOf names the intercom result: sent is delivered, queued stays queued, the rest failed", () => {
	assert.deepEqual(["sent", "delivered", "queued", "failed", "blocked", "rejected", undefined].map((x) => deliveryOf(x)), ["delivered", "delivered", "queued", "failed", "failed", "failed", "failed"]);
});

test("a self card has no raiser to tell: the event carries no delivery sentence and nothing is sent", async () => {
	const s = await setup();
	await waits(s, { ...CARD, from: "self" });
	const before = tower().sent.length;
	await press(s, { op: "press", id: "W1", act: "done" });
	assert.equal(tower().sent.length, before);
	assert.doesNotMatch(bossEvents()[0]!.text, /got it|not reached/);
	assert.equal(memory().entries[0]!.press!.main, undefined);
});

test("choose on a choice card: the option is kept by index, the event and the notice name the label and what it leads to; the wrong act or option is refused", async () => {
	const s = await setup();
	await waits(s, CHOICE, CARD);
	const why = async (json: Record<string, unknown>) => { const r = await press(s, json); assert.equal(r.status, 409, JSON.stringify(r.body)); return String(r.body!.reason); };
	assert.match(await why({ op: "press", id: "W1", act: "done" }), /W1 is a choice: press one of its options/);
	assert.match(await why({ op: "press", id: "W1", act: "choose", option: 5 }), /W1 has no option 5/);
	assert.match(await why({ op: "press", id: "W2", act: "choose", option: 0 }), /W2 is not a choice/);
	assert.match(await why({ op: "press", id: "W2", act: "secret" }), /W2 is not a secret card/);
	assert.match(await why({ op: "press", id: "W2", act: "restate" }), /W2 is a card already/);
	assert.equal(memory().entries[0]!.state, "open");
	const before = tower().sent.length;
	assert.equal((await press(s, { op: "press", id: "W1", act: "choose", option: 1 })).status, 200);
	assert.equal(memory().entries[0]!.press!.option, 1);
	assert.match(tower().sent[before]!.text, /\] The boss chose "Hold" on wait W1: The main waits for Monday\. This is the boss's answer to your wait: act on it\.$/);
	assert.match(bossEvents()[0]!.text, /^The boss chose "Hold" on wait W1 \(Deploy the build to ws01 now\?\): The main waits for Monday\.\. Act on it, then resolve W1\. mp3946-print got it\.$|^The boss chose "Hold" on wait W1 \(Deploy the build to ws01 now\?\): The main waits for Monday\. Act on it, then resolve W1\./);
});

test("a second press is refused 409 with the first one's time; decline is the exception", async () => {
	const s = await setup();
	await waits(s, CARD);
	await press(s, { op: "press", id: "W1", act: "done" });
	const again = await press(s, { op: "press", id: "W1", act: "done" });
	assert.equal(again.status, 409);
	assert.equal(again.body!.error, "refused");
	assert.match(String(again.body!.reason), /^W1 was pressed already: (我做完了|I'm done) at \d\d:\d\d$/);
	assert.equal(bossEvents().length, 1, "no second event");
	const declined = await press(s, { op: "press", id: "W1", act: "decline", reason: "not today" });
	assert.equal(declined.status, 200);
	assert.equal(memory().entries[0]!.state, "resolved");
});

test("decline resolves the wait with its reason, kept 24 h, and tells the raiser and the tower; a reason with a secret in it is refused", async () => {
	const s = await setup();
	await waits(s, CARD);
	const refused = await press(s, { op: "press", id: "W1", act: "decline", reason: "use sk-abcdefghijklmnop1234 instead" });
	assert.equal(refused.status, 409);
	assert.match(String(refused.body!.reason), /a reason never carries a secret/);
	assert.equal(memory().entries[0]!.state, "open");
	assert.equal((await press(s, { op: "press", id: "W1", act: "decline", reason: "x".repeat(121) })).status, 400);
	const before = tower().sent.length;
	assert.equal((await press(s, { op: "press", id: "W1", act: "decline", reason: "not today" })).status, 200);
	const [w] = memory().entries;
	assert.deepEqual([w!.state, w!.outcome, w!.press!.reason, typeof w!.ended], ["resolved", "declined by the boss: not today", "not today", "string"]);
	assert.match(tower().sent[before]!.text, /\] The boss will not do what wait W1 asked \(Re-authorize fonstar-staging in the Tailscale admin page\.\): "not today"\. The tower decides what comes next\.$/);
	assert.match(bossEvents()[0]!.text, /^The boss declined wait W1 \(Re-authorize fonstar-staging in the Tailscale admin page\.\): "not today"\. Do not ask again unless something changed; tell the raiser what happens instead\. mp3946-print got it\.$/);
	await press(s, { op: "press", id: "W1", act: "decline" });
});

test("a secret card: the first step tells the raiser to call secret_drop and keeps the wait open; done is refused before it and allowed after", async () => {
	const s = await setup();
	await waits(s, SECRET);
	assert.equal((await press(s, { op: "press", id: "W1", act: "done" })).status, 409, "enter the secret first");
	const before = tower().sent.length;
	assert.equal((await press(s, { op: "press", id: "W1", act: "secret" })).status, 200);
	const [w] = memory().entries;
	assert.equal(w!.state, "open");
	assert.equal(typeof w!.press!.secretAsked, "string");
	assert.match(tower().sent[before]!.text, /\] The boss is at this computer to enter the Tailscale auth key for fonstar-staging \(wait W1\): call secret_drop now for it, in this session\. Tell the tower with call_tower when it is stored\.$/);
	assert.match(bossEvents()[0]!.text, /^The boss is ready to enter the Tailscale auth key for fonstar-staging for wait W1; mp3946-print was told to call secret_drop now\. mp3946-print got it\.$/);
	assert.equal((await press(s, { op: "press", id: "W1", act: "secret" })).status, 409, "the first step is taken once");
	assert.equal((await press(s, { op: "press", id: "W1", act: "done" })).status, 200);
	assert.equal(memory().entries[0]!.state, "answered");
	assert.equal(memory().entries[0]!.press!.act, "done");
});

test("a legacy wait: restate asks the tower to record it again (no notice, there is no raiser); decline works too", async () => {
	const s = await setup();
	updateMemory(world.slot, "wA", Date.now(), (m) => (addWait(m, Date.now(), "r0", { text: "Re-auth fonstar-staging (old text)", for: "boss" }), addWait(m, Date.now(), "r0", { text: "Another old one", for: "boss" })));
	const before = tower().sent.length;
	assert.equal((await press(s, { op: "press", id: "W1", act: "restate" })).status, 200);
	assert.equal(tower().sent.length, before);
	assert.equal(memory().entries[0]!.state, "answered");
	assert.match(bossEvents()[0]!.text, /^The boss asks you to record wait W1 again as a card \(tower_memory add kind wait with restates: "W1"\); its old text: Re-auth fonstar-staging \(old text\)$/);
	assert.equal((await press(s, { op: "press", id: "W2", act: "decline" })).status, 200);
	assert.equal(memory().entries[1]!.outcome, "declined by the boss");
	assert.equal((await press(s, { op: "press", id: "W2", act: "restate" })).status, 409, "restate is for an open legacy wait");
	updateMemory(world.slot, "wA", Date.now(), (m) => addWait(m, Date.now(), "r0", { text: "a third old one", for: "boss" }));
	const done = await press(s, { op: "press", id: "W3", act: "done" });
	assert.equal(done.status, 409);
	assert.match(String(done.body!.reason), /W3 is an old free-text wait: it has no buttons/);
});

test("a run token cannot press, and a wait that is not there is refused", async () => {
	const s = await setup();
	await waits(s, CARD);
	tower().incoming(from, msg("m1", "again"));
	const run = await claim(s).catch(() => undefined);
	const token = world.expose!.runs.mint("wA", { kind: "local" });
	assert.match(String((await ask(s, { cmd: "tower-memory", token, workspace: "wA", json: { op: "press", id: "W1", act: "done" } })).error), /run token may not ask for tower-memory/);
	assert.equal(memory().entries[0]!.state, "open");
	assert.equal((await press(s, { op: "press", id: "W9", act: "done" })).status, 409);
	assert.equal((await press(s, { op: "press", id: "W1", act: "fly" })).status, 400);
	void run;
});

test("the order: the raiser's notice is sent and answered before the tower's event is queued; a notice that hangs is cut at the wait", async () => {
	const order: string[] = [];
	let release: (() => void) | undefined;
	const deps = {
		slot: world.slot, now: () => Date.parse("2026-11-07T10:58:00Z"), log: { line() {}, hide() {} }, locale: "en" as const, waitMs: 20,
		live: async () => true,
		send: (_to: string, _text: string, _wait: string) => new Promise<{ status: string }>((resolve) => { order.push("notice"); release = () => resolve({ status: "sent" }); }),
		boss: (_text: string) => void order.push("event"),
	};
	updateMemory(world.slot, "wA", Date.parse("2026-11-07T10:41:00Z"), (m) => void m);
	const card = { type: "action", lang: "en", happened: "h", do: "Do the thing", after: "Next", url: "https://example.org/", from: { id: "main-1", name: "mp3946-print", role: "main" } };
	const { mkdirSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	mkdirSync(join(world.slot.dir, "tower", "wA"), { recursive: true });
	writeFileSync(join(world.slot.dir, "tower", "wA", "memory.json"), JSON.stringify({ v: 1, rev: 1, next: { S: 1, D: 1, W: 2, P: 1 }, entries: [{ id: "W1", kind: "wait", text: "Do the thing", by: "run", via: "run", at: "2026-11-07T10:41:00Z", run: "r1", for: "boss", state: "open", card }], proposals: [] }));
	const done = await pressRequest(deps, "wA", { op: "press", id: "W1", act: "done" });
	assert.equal(done.status, 200, JSON.stringify(done.body));
	assert.deepEqual(order, ["notice", "event"], "the event comes after the notice's answer or its timeout");
	assert.equal(memory().entries[0]!.press!.main!.status, "failed", "a notice that did not answer in time is not recorded as delivered");
	release?.();
});
