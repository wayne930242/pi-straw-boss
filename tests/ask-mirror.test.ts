import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { Net, Unit } from "../src/net.ts";
import { asksOfNet, rowsFor, viewsOf } from "../src/server/askmirror.ts";
import { createAskStore } from "../src/server/askstore.ts";

// The questions sb can see, mirrored as Asks (docs/specs/2026-11-28-boss-asks.md, Questions recorded as mirrors; The todo an Ask blocks): wait cards, a teammate's wait raised to the boss, and units that wait on
// ask_user_question; each bound once to the todo it blocks: an explicit item, a subagent's launcher's todo bound to its run, else the asker's todo in progress.

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-askmirror-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const unit = (over: Partial<Unit>): Unit => ({ id: over.key!, key: "k", control: true, name: "n", role: "main", mark: "idle", subs: [], ...over });
function net(): Net {
	const worker = unit({ key: "run-w1", name: "worker-1", role: "subagent", mark: "waiting", since: 3000, pending: { callId: "c2", tool: "ask_user_question", ask: { question: "Use Postgres or SQLite?", options: [], multiple: false, freeform: true } } });
	const main = unit({ key: "main-1", name: "docs-main", mark: "commanding", subs: [worker], todo: { done: 1, total: 3, doing: 2, runs: [{ id: 3, run: "run-w1" }] } });
	const other = unit({ key: "main-2", name: "api-main", mark: "waiting", since: 4000, todo: { done: 0, total: 2, doing: 5 }, pending: { callId: "c9", tool: "ask_user_question", item: 1, asks: [{ question: "Ship today?", options: [], multiple: false, freeform: true }, { question: "Tag?", options: [], multiple: false, freeform: true }] } });
	const busy = unit({ key: "main-3", name: "ops-main", mark: "waiting", pending: { callId: "c7", tool: "robot_hand", why: "x" } });
	const boss = unit({ key: "main-4", name: "boss-main", mark: "waiting", pending: { callId: "c8", tool: "call_tower", why: "x" } });
	return {
		bases: [{
			id: "wA", label: "Alpha", mark: "waiting", outposts: [], outside: [],
			tower: { name: "tower", key: "tower-wA", mark: "idle", control: true, subs: [], service: { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [], memory: { rev: 1, standing: 0, decisions: 0, waits: 3, proposals: [], bossWaits: [
				{ id: "W3", text: "Approve the prod deploy\nmore", at: "1970-01-01T00:00:01.000Z", card: { type: "action", lang: "en", happened: "built", do: "Approve the prod deploy", from: { key: "main-1", name: "docs-main", role: "main" } } },
				{ id: "W4", text: "Teammate box wants a key", at: "1970-01-01T00:00:02.000Z", card: { type: "action", lang: "en", happened: "h", do: "Give box-2 the deploy key", from: { id: "dev-2", name: "box-2", role: "device" } } },
				{ id: "W5", text: "done one", at: "1970-01-01T00:00:02.000Z", state: "resolved" },
				{ id: "W6", text: "answered one", at: "1970-01-01T00:00:02.000Z", answered: "1970-01-01T00:00:03.000Z" },
			] } } },
			tabs: [{ id: "wA:t1", label: "docs", units: [main] }, { id: "wA:t2", label: "api", units: [other, busy, boss] }],
		}],
	};
}

test("a reading's mirrors: open wait cards (a device's is a link), units waiting on ask_user_question with their place, bound to the todo each blocks", () => {
	const { entries, live } = asksOfNet(net(), { now: 9000, paneOf: (key) => (key === "main-2" ? "wA:p2" : undefined) });
	const by = Object.fromEntries(entries.map((e) => [e.mirror, e]));
	assert.deepEqual(Object.keys(by).sort(), ["dialog:main-2:c9", "dialog:run-w1:c2", "wait:wA:W3", "wait:wA:W4"], "no resolved or answered card, no other tool, no call_tower");
	assert.deepEqual(by["wait:wA:W3"], { mirror: "wait:wA:W3", kind: "wait", subject: "Approve the prod deploy", since: 1000, asker: { session: "main-1", name: "docs-main", role: "main", workspace: "wA", workspaceLabel: "Alpha", tab: "wA:t1", tabLabel: "docs" }, item: { session: "main-1", id: 2 } });
	assert.deepEqual(by["wait:wA:W4"]!.asker, { session: "device:dev-2", name: "box-2", device: "box-2" });
	assert.equal(by["wait:wA:W4"]!.kind, "link");
	assert.deepEqual(by["dialog:run-w1:c2"]!.item, { session: "main-1", id: 3 }, "a subagent's question blocks its launcher's todo bound to its run");
	assert.deepEqual([by["dialog:run-w1:c2"]!.subject, by["dialog:run-w1:c2"]!.since], ["Use Postgres or SQLite?", 3000]);
	assert.deepEqual(by["dialog:main-2:c9"]!.item, { session: "main-2", id: 1 }, "the call's own item before the todo in progress");
	assert.equal(by["dialog:main-2:c9"]!.asker.pane, "wA:p2");
	assert.equal(by["dialog:main-2:c9"]!.subject, "Ship today? (+1)");
	assert.ok(live.has("main-1") && live.has("run-w1") && live.has("tower-wA"));
});

test("rows for a session: every open Ask, the oldest first, `mine` for its own and its subagents'; the page's views count on the asker's unit and name a wait's card", () => {
	const store = createAskStore(join(root, "asks"), () => 9000);
	const n = net(), { entries, live } = asksOfNet(n, { now: 9000 });
	store.sync(entries, live);
	store.open({ kind: "boss", asker: { session: "main-4", name: "boss-main", workspace: "wA", workspaceLabel: "Alpha", tabLabel: "api" }, subject: "Go?", questions: [{ question: "Go?", options: [] }] });
	const rows = rowsFor(store.list({ open: true }), n, "main-1");
	assert.deepEqual(rows.map((r) => [r.id, r.kind, r.mine, r.where]), [["Q1", "wait", true, "Alpha › docs"], ["Q2", "link", false, "box-2"], ["Q3", "dialog", true, "Alpha › docs"], ["Q4", "dialog", false, "Alpha › api"], ["Q5", "boss", false, "Alpha › api"]]);
	assert.deepEqual(Object.keys(rows[0]!).sort(), ["asker", "id", "item", "kind", "mine", "since", "subject", "where"]);
	const views = viewsOf(store.list({ open: true }), n);
	const w = views.find((v) => v.kind === "wait")!, link = views.find((v) => v.kind === "link")!, d = views.find((v) => v.subject.startsWith("Use"))!;
	assert.deepEqual([w.unit, w.wait, w.ws], ["main-1", "W3", "wA"]);
	assert.deepEqual([link.unit, link.wait], ["tower-wA", "W4"], "a device's card counts on the tower");
	assert.equal(d.unit, "run-w1");
});

test("a bridge's todo summary carries the todo in progress and the open todos' Herdr runs, which the hub takes", async () => {
	const { todoOfBranch, todoOk } = await import("../src/todo.ts");
	const tasks = [
		{ id: 1, subject: "done", status: "completed", metadata: { herdr: { id: "run-old", name: "w0" } } },
		{ id: 2, subject: "build", status: "in_progress", owner: "w2", metadata: { herdr: { id: "run-b", name: "w2", runs: [{ id: "run-a", name: "w1" }, { id: "run-b", name: "w2" }] } } },
		{ id: 3, subject: "review", status: "pending" },
		{ id: 4, subject: "handed on", status: "pending", owner: "w5", metadata: { herdr: { id: "run-c", name: "w4" } } },
	];
	const sum = todoOfBranch([{ type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks, nextId: 5 } } }])!;
	assert.equal(sum.doing, 2);
	// A run binds the todo only while it is its owner's (asks-r2-F006): w1's run-a was the todo's before w2 took it over, and #4's owner changed alone, so w4's run-c is no longer its.
	assert.deepEqual(sum.runs, [{ id: 2, run: "run-b" }], "a completed todo binds no question, nor a run of a former owner");
	assert.equal(todoOk(sum), true);
	assert.equal(todoOk({ ...sum, runs: [{ id: 2, run: "bad\nrun" }] }), false);
});

test("the head tower's own waits are mirrored too, opened on the head's card, a main's on its raiser (asks-r2-F005)", () => {
	const n = net(), service = n.bases[0]!.tower!.service!;
	n.head = { key: "sb-head", name: "head tower", mark: "idle", state: "standing", asks: [], service: { ...service, memory: { ...service.memory!, bossWaits: [
		{ id: "W1", text: "Merge the train?", at: "1970-01-01T00:00:01.000Z" },
		{ id: "W2", text: "Rotate the key", at: "1970-01-01T00:00:02.000Z", card: { type: "action", lang: "en", happened: "h", do: "Rotate the key", from: { key: "main-2", name: "api-main", role: "main" } } },
		{ id: "W3", text: "resolved", at: "1970-01-01T00:00:02.000Z", state: "resolved" },
	] } } };
	const seen = asksOfNet(n, { now: 9000 }), by = Object.fromEntries(seen.entries.map((e) => [e.mirror, e]));
	assert.deepEqual(Object.keys(by).filter((k) => k.startsWith("wait:@head:")).sort(), ["wait:@head:W1", "wait:@head:W2"]);
	assert.deepEqual([by["wait:@head:W1"]!.asker.session, by["wait:@head:W1"]!.kind], ["sb-head", "wait"]);
	assert.equal(by["wait:@head:W2"]!.asker.session, "main-2");
	assert.ok(seen.live.has("sb-head"), "the head is on the net");
	const store = createAskStore(join(root, "asks"), () => 9000);
	store.sync(seen.entries, seen.live);
	const views = viewsOf(store.list({ open: true }), n), head = views.find((v) => v.wait === "W1" && v.ws === "@head")!;
	assert.deepEqual([head.unit, head.ws, head.wait], ["sb-head", "@head", "W1"], "its card is the head's");
	store.sync(asksOfNet(net(), { now: 9500 }).entries, asksOfNet(net(), { now: 9500 }).live);
	assert.equal(store.list({ open: true }).some((r) => r.mirror?.startsWith("wait:@head:")), false, "gone with the head's waits");
});
