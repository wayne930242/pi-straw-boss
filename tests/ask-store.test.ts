import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ASK_KEEP_MS, createAskStore, type MirrorEntry } from "../src/server/askstore.ts";

// The ask store (docs/specs/2026-11-28-boss-asks.md): one file per Ask under <state>/asks/, written by rename, loaded at the server's start; the first valid answer wins, a late one gets 409 naming
// where it was answered, and a resent answerId replays the first result. Mirrors are opened and closed from the net's readings and take no answer here.

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-askstore-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));
const asker = { session: "main-1", name: "docs-main", workspace: "wA", workspaceLabel: "Alpha", tab: "wA:t1", tabLabel: "docs", pane: "wA:p1" };
const boss = { kind: "boss" as const, asker, subject: "Deploy MP-1 to prod now?", questions: [{ question: "The boss decides: Deploy MP-1 to prod now?", options: ["Deploy", "Wait for QA"] }], toolCallId: "call-1" };
const ID = (n: number) => `answer-${String(n).padStart(12, "0")}`;

test("an Ask is written as its own file by rename, numbered Q<n>, and is there again after a restart", () => {
	let now = 1000;
	const store = createAskStore(join(root, "asks"), () => now);
	const a = store.open({ ...boss, item: { session: "main-1", id: 4 } });
	assert.match(a.id, /^[0-9a-f]{32}$/);
	assert.equal(a.n, 1);
	assert.equal(a.state, "open");
	assert.equal(a.blocking, true);
	assert.match(a.digest!, /^[0-9a-f]{64}$/);
	assert.deepEqual(readdirSync(join(root, "asks")).sort(), [`${a.id}.json`, "seq.json"], "no temp file is left");
	now = 2000;
	const b = store.open({ ...boss, toolCallId: "call-2" });
	assert.equal(b.n, 2);
	const again = createAskStore(join(root, "asks"), () => now);
	assert.deepEqual(again.list().map((x) => [x.n, x.state, x.item]), [[1, "open", { session: "main-1", id: 4 }], [2, "open", undefined]]);
	assert.equal(again.open({ ...boss, toolCallId: "call-3" }).n, 3, "the number goes on after a restart");
});

test("the first valid answer wins; a late one gets 409 with where it was answered; a resent answerId replays the first result", () => {
	const store = createAskStore(join(root, "asks"), () => 5000);
	const a = store.open(boss);
	assert.equal(store.answer(a.id, { answerId: ID(1), digest: "0".repeat(64), replies: [{ choices: [0] }], by: "gui" }).status, 409, "an answer for other words");
	assert.equal(store.answer(a.id, { answerId: ID(1), digest: a.digest!, replies: [{ choices: [5] }], by: "gui" }).status, 400, "no such option");
	assert.equal(store.answer(a.id, { answerId: "short", digest: a.digest!, replies: [{ choices: [0] }], by: "gui" }).status, 400, "an answer id is 16 to 64 characters");
	const won = store.answer(a.id, { answerId: ID(1), digest: a.digest!, replies: [{ choices: [1], note: "after 3 pm" }], by: "phone" });
	assert.equal(won.status, 200);
	assert.equal(won.body.outcome, "accepted");
	assert.deepEqual(store.get(a.id)?.answer, { by: "phone", at: 5000, answerId: ID(1), replies: [{ choices: [1], note: "after 3 pm" }] });
	const late = store.answer(a.id, { answerId: ID(2), digest: a.digest!, replies: [{ text: "deploy now" }], by: "terminal" });
	assert.equal(late.status, 409);
	assert.deepEqual([late.body.outcome, late.body.by, late.body.at], ["closed", "phone", 5000]);
	assert.match(String(late.body.reason), /already answered on the phone/i);
	assert.deepEqual(store.answer(a.id, { answerId: ID(1), digest: a.digest!, replies: [{ choices: [1], note: "after 3 pm" }], by: "phone" }), won, "replayed, not a second answer");
	const persisted = JSON.parse(readFileSync(join(root, "asks", `${a.id}.json`), "utf8"));
	assert.equal(persisted.state, "answered");
	assert.equal(createAskStore(join(root, "asks"), () => 6000).answer(a.id, { answerId: ID(1), digest: a.digest!, replies: [{ choices: [1], note: "after 3 pm" }], by: "phone" }).status, 200, "the replay holds across a restart");
	assert.equal(store.answer("f".repeat(32), { answerId: ID(3), digest: a.digest!, replies: [{ choices: [0] }], by: "gui" }).status, 404);
});

test("a cancel wins as an answer does; a close by the asker ends it with its reason, and a later answer is 409", () => {
	const store = createAskStore(join(root, "asks"), () => 7000);
	const a = store.open(boss), b = store.open({ ...boss, toolCallId: "call-2" });
	assert.equal(store.answer(a.id, { answerId: ID(4), digest: a.digest!, cancel: true, by: "gui" }).status, 200);
	assert.equal(store.get(a.id)?.state, "cancelled");
	assert.equal(store.close(b.id, "esc")?.state, "closed");
	assert.deepEqual(store.get(b.id)?.closed, { at: 7000, why: "esc" });
	const late = store.answer(b.id, { answerId: ID(5), digest: b.digest!, replies: [{ choices: [0] }], by: "gui" });
	assert.deepEqual([late.status, late.body.outcome, late.body.by], [409, "closed", undefined]);
	assert.match(String(late.body.reason), /closed with no answer \(esc\)/);
	assert.equal(store.close(a.id, "abort")?.state, "cancelled", "a close after the answer changes nothing");
	assert.deepEqual(store.list({ open: true }), []);
});

const wait = (over: Partial<MirrorEntry> = {}): MirrorEntry => ({ mirror: "wait:wA:W3", kind: "wait", asker, subject: "Approve the prod deploy", since: 1000, ...over });
test("mirrors open from a reading, keep their number and since, close when their owner drops them or their asker leaves, and take no answer here", () => {
	let now = 10_000;
	const store = createAskStore(join(root, "asks"), () => now);
	store.sync([wait({ item: { session: "main-1", id: 2 } }), wait({ mirror: "dialog:main-2:c9", kind: "dialog", asker: { ...asker, session: "main-2", name: "api-main" }, subject: "Which DB?" })], new Set(["main-1", "main-2"]));
	const [w, d] = store.list({ open: true });
	assert.deepEqual([w!.n, w!.kind, w!.blocking, w!.since, w!.item], [1, "wait", false, 1000, { session: "main-1", id: 2 }]);
	assert.equal(store.answer(w!.id, { answerId: ID(6), digest: "0".repeat(64), replies: [{ choices: [0] }], by: "gui" }).status, 403, "answered where it is");
	now = 11_000;
	store.sync([wait({ subject: "Approve the prod deploy today", item: { session: "main-1", id: 9 } })], new Set(["main-1"]));
	assert.deepEqual(store.get(w!.id)?.subject, "Approve the prod deploy today");
	assert.deepEqual(store.get(w!.id)?.item, { session: "main-1", id: 2 }, "bound once, at first sight");
	assert.deepEqual(store.get(d!.id)?.closed, { at: 11_000, why: "asker-ended" }, "its asker left the net");
	store.sync([], new Set(["main-1"]));
	assert.deepEqual(store.get(w!.id)?.closed, { at: 11_000, why: "owner" });
	store.sync([wait()], new Set(["main-1"]));
	assert.equal(store.list({ open: true })[0]!.n, 3, "the same card again is a new Ask");
});

test("a blocking Ask whose asker is gone from two readings a minute apart ends as asker-ended; one reading is not enough", () => {
	let now = 0;
	const store = createAskStore(join(root, "asks"), () => now);
	const a = store.open(boss);
	store.sync([], new Set());
	now = 30_000;
	store.sync([], new Set());
	assert.equal(store.get(a.id)?.state, "open", "under a minute");
	now = 40_000;
	store.sync([], new Set(["main-1"]));
	now = 120_000;
	store.sync([], new Set());
	assert.equal(store.get(a.id)?.state, "open", "seen again: the count starts over");
	now = 181_000;
	store.sync([], new Set());
	assert.deepEqual(store.get(a.id)?.closed, { at: 181_000, why: "asker-ended" });
});

test("ended Asks are kept seven days and at most 500; open ones are kept however long they wait; a broken file is skipped", () => {
	let now = 0;
	const dir = join(root, "asks"), store = createAskStore(dir, () => now);
	const old = store.open(boss), open = store.open({ ...boss, toolCallId: "call-2" });
	store.close(old.id, "esc");
	now = ASK_KEEP_MS + 1;
	store.sweep();
	assert.equal(existsSync(join(dir, `${old.id}.json`)), false);
	assert.equal(store.get(open.id)?.state, "open");
	rmSync(join(dir, `${open.id}.json`));
	writeFileSync(join(dir, `${"c".repeat(32)}.json`), "{ not json");
	assert.deepEqual(createAskStore(dir, () => now).list(), []);
});
