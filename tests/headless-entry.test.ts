import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { readAsks } from "../src/server/headasks.ts";
import { callControl } from "../src/server/socket.ts";
import { readQueue, readService } from "../src/server/towerstore.ts";
import { type Running, until } from "./server-world.ts";
import { type FakeKid, TowerWorld } from "./tower-world.ts";

// The entry under headless runs (docs/specs/2026-11-23-f-entry.md §6, the boss's minimum; docs/specs/2026-11-23-lite-b2-d-e-f.md §4.8 test 2): a service needs no tab, a viewer tab is typed into once with `exec`,
// the head parks a notice to a workspace nobody is in, `@<workspace>` goes straight to that tower, and a run's dialog is answered from a viewer only. Red on 0.84.0: ensure-tower always made a tab and a standing
// pane it types into again after every run, the head's forward opened a tower and a run, and `head-event` had no `to`.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true, undefined, true);
	world.env.LANG = "en_US.UTF-8";
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const started = async () => {
	const s = await world.start();
	await s.handle.ready;
	return s;
};
const kid = async (n = 1): Promise<FakeKid> => {
	await until(() => world.kids.size >= n, `headless run ${n} to spawn`);
	return [...world.kids.values()][n - 1]!;
};
const claim = async (s: Running, k: FakeKid) => {
	const got = await ask(s, { cmd: "claim", runId: k.run, pane: "", pid: k.pid, nonce: k.nonce, liveBrief: true });
	assert.equal(got.ok, true, JSON.stringify(got));
	return String(got.token);
};
const typed = () => world.herdr.typed.map((t) => t.text);

test("ensure-tower with no view makes the service with no tab; with view it makes one tab and types into it once, with exec, and never again after the viewer polled", async () => {
	const s = await started();
	const plain = await ask(s, { cmd: "ensure-tower", workspace: "wA", view: false });
	assert.equal(plain.ok, true, JSON.stringify(plain));
	assert.equal(plain.pane, "");
	assert.deepEqual(world.herdr.commands("tab", "create"), [], "no tab for the service");
	assert.equal(readService(world.slot, "wA")!.pane, "");
	const viewed = await ask(s, { cmd: "ensure-tower", workspace: "wA", view: true });
	assert.equal(viewed.ok, true, JSON.stringify(viewed));
	assert.equal(world.herdr.commands("tab", "create").length, 1, "one viewer tab");
	assert.ok(world.herdr.moves.some((m) => m.tab_id === viewed.tab && m.insert_index === 0), "the viewer tab is moved first");
	await until(() => typed().length >= 1, "the one typing");
	assert.match(typed()[0]!, /^exec node ".*" prompt --workspace wA --state-dir /, "the viewer replaces the shell");
	// The viewer polls: from now on the server types into that pane at no look, Retry, or run end.
	assert.equal((await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4242 })).ok, true);
	await ask(s, { cmd: "tower-retry", workspace: "wA" });
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "hello", present: true })).ok, true);
	const k = await kid();
	await claim(s, k);
	k.exit(1);
	await new Promise((r) => setTimeout(r, 400));
	assert.equal(typed().length, 1, "typed exactly once");
	assert.deepEqual(world.herdr.commands("agent", "start"), [], "no pi in any pane");
});

test("a viewer that ended (its pane closed) leaves the service standing with no tab; a session's ensure-tower on an attended device asks for a viewer, an unattended one does not", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(world.herdr.commands("tab", "create").length, 1, "attended: a promotion's open gets a viewer (FE-2)");
	const pane = readService(world.slot, "wA")!.pane;
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== pane);
	await until(() => readService(world.slot, "wA")?.pane === "", "the service to go on with no tab");
	assert.ok(world.expose!.identityOf("wA"), "the tower is still served");
});

test("an unattended device's ensure-tower makes no viewer tab", async () => {
	world.unattended = () => true;
	const s = await started();
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).ok, true);
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
});

test("@<workspace> from a viewer is the boss's words at that tower (head-event with to): by id or label, a sub workspace to its parent; a shared label, the head's workspace, and an unknown name are refused", async () => {
	world.herdr.workspaces.push({ workspace_id: "wC", label: "Beta", tokens: {} });
	const s = await started();
	const head = await world.expose!.head.ensure();
	const byLabel = await ask(s, { cmd: "head-event", to: "Alpha", text: "MP-5383 卡在哪？", door: "pane" });
	assert.equal(byLabel.ok, true, JSON.stringify(byLabel));
	assert.equal(byLabel.workspace, "wA");
	const queued = readQueue(world.slot, "wA");
	assert.equal(queued.length, 1);
	assert.equal(queued[0]!.kind, "boss");
	assert.equal(queued[0]!.door, "pane");
	assert.equal(readQueue(world.slot, head.workspace).length, 0, "the head's queue sees nothing of it");
	assert.equal(readAsks(world.slot, Date.now()).length, 0, "and opens no ask");
	assert.equal((await ask(s, { cmd: "head-event", to: "wA", text: "again" })).workspace, "wA");
	assert.match(String((await ask(s, { cmd: "head-event", to: "Beta", text: "x" })).error), /Several workspaces.*wB, wC/);
	assert.match(String((await ask(s, { cmd: "head-event", to: head.workspace, text: "x" })).error), /head tower's own workspace/);
	assert.match(String((await ask(s, { cmd: "head-event", to: "Nowhere", text: "x" })).error), /No workspace matches/);
	// `@x` in the text with no `to` is the head's: the server never reads an address out of the text.
	assert.equal((await ask(s, { cmd: "head-event", text: "@Alpha hi" })).ok, true);
	assert.ok(readQueue(world.slot, head.workspace).some((e) => e.text === "@Alpha hi"));
});

test("with towerRuns.headless off, head-event's `to`, run-abort and run-dialog are refused and prompt-poll carries no transcript: the switch off is 0.84.0", async () => {
	world.setFlag(true);
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	for (const cmd of [{ cmd: "head-event", to: "wA", text: "x" }, { cmd: "run-abort", workspace: "wA" }, { cmd: "run-dialog", key: "r:1" }]) assert.match(String((await ask(s, cmd)).error), /towerRuns\.headless/, cmd.cmd);
	const polled = await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4242 });
	assert.equal(polled.lines, undefined);
	assert.equal(world.herdr.commands("tab", "create").length, 1, "the pane path's tab, as before");
});

test("a run's dialog reaches the viewer's poll and is answered only by the boss's run-dialog; a run token is refused it; prompt-poll carries the transcript after the cursor; /stop aborts the turn", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA", view: false });
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "hello", present: true });
	const k = await kid();
	const token = await claim(s, k);
	k.say({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } });
	k.say({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo \u001b[3Gthere\nW2 choice · press 1" } });
	k.say({ type: "message_end" });
	k.say({ type: "extension_ui_request", id: "d1", method: "confirm", title: "Allow link_request to Bob?", message: "open a main" });
	let polled: Reply = { ok: false };
	await until(async () => ((polled = await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4242 })), Array.isArray(polled.dialogs)), "the dialog in the poll");
	assert.deepEqual(polled.lines, ["│ hello there", "│ W2 choice · press 1", "? Allow link_request to Bob? · answer in the viewer's card view or on this computer's page"]);
	const again = await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4242, cursor: polled.cursor });
	assert.deepEqual(again.lines, [], "nothing new after the cursor");
	const key = (polled.dialogs as { key: string }[])[0]!.key;
	assert.match(String((await ask(s, { cmd: "run-dialog", key, confirmed: true, token })).error), /token may not/, "a run cannot answer its own dialog");
	assert.equal(k.written.length, 0);
	assert.equal((await ask(s, { cmd: "run-dialog", key, confirmed: true })).ok, true);
	assert.deepEqual(k.written, [{ type: "extension_ui_response", id: "d1", confirmed: true }]);
	assert.match(String((await ask(s, { cmd: "run-dialog", key, confirmed: true })).error), /not waiting/);
	assert.equal((await ask(s, { cmd: "run-abort", workspace: "wA" })).aborted, true);
	assert.deepEqual(k.written.at(-1), { type: "abort" });
	for (const cmd of ["head-event", "tower-event", "run-abort", "prompt-poll", "ensure-tower"]) assert.match(String((await ask(s, { cmd, token, workspace: "wA", text: "x", to: "wA", pid: 1, view: true })).error), /token may not/, cmd);
});

test("the head parks a notice to a workspace nobody is in: no service, no tab, no run; the ask reads parked; the same text replaces it; the next run there takes it with the boss's event", async () => {
	const s = await started();
	const head = await world.expose!.head.ensure();
	assert.equal((await ask(s, { cmd: "tower-event", workspace: head.workspace, text: "sweep", present: true })).ok, true);
	const hk = await kid();
	const token = await claim(s, hk);
	const e = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string };
	await ask(s, { cmd: "run-taken", token, id: e.id });
	// A tool call in this turn names no boss event as its starter, so it carries no relay: a notice.
	const parked = await ask(s, { cmd: "run-tool", token, tool: "tower_send", args: { workspace: "Beta", message: "dirty worktree left", reply: false } });
	assert.equal(parked.ok, true, JSON.stringify(parked));
	assert.match(String(parked.text), /^parked at Beta as ask H1/);
	assert.equal(readService(world.slot, "wB"), undefined, "no service");
	assert.deepEqual(world.herdr.commands("tab", "create").filter((c) => c.includes("wB")), [], "no tab");
	assert.equal(world.kids.size, 1, "no run");
	assert.equal(readAsks(world.slot, Date.now())[0]!.parked !== undefined, true);
	await ask(s, { cmd: "run-tool", token, tool: "tower_send", args: { workspace: "Beta", message: "dirty worktree left", reply: false } });
	const quiet = readQueue(world.slot, "wB");
	assert.equal(quiet.length, 1, "the same text replaces the one parked");
	assert.equal(quiet[0]!.quiet, true);
	// The boss writes there: one run, which takes the boss's words and the parked notice.
	assert.equal((await ask(s, { cmd: "head-event", to: "Beta", text: "what is left?" })).ok, true);
	const bk = await kid(2);
	const bt = await claim(s, bk);
	const first = (await ask(s, { cmd: "run-poll", token: bt, idle: true })).event as { id: string; kind: string; text: string };
	assert.equal(first.kind, "boss");
	await ask(s, { cmd: "run-taken", token: bt, id: first.id });
	const second = (await ask(s, { cmd: "run-poll", token: bt, idle: true })).event as { text: string };
	assert.match(second.text, /^\[parked notice from the head \(no one was here when it came\) · ask H\d\]\ndirty worktree left$/);
	assert.equal(world.kids.size, 2);
});

test("what the boss addressed from the head's viewer comes back there: the run's start, each finished message as one line, its end; and every run's dialog is listed in the head's viewer, its own first", async () => {
	const s = await started();
	const head = await world.expose!.head.ensure();
	assert.equal((await ask(s, { cmd: "head-event", to: "Alpha", text: "MP-5383?", door: "pane" })).ok, true);
	const k = await kid();
	await claim(s, k);
	k.say({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "MP-5383 waits on\nthe review" } });
	k.say({ type: "message_end" });
	k.say({ type: "extension_ui_request", id: "d9", method: "confirm", title: "Allow?" });
	let polled: Reply = { ok: false };
	await until(async () => ((polled = await ask(s, { cmd: "prompt-poll", workspace: head.workspace, pid: 4343 })), Array.isArray(polled.dialogs)), "the head's poll to list the dialog");
	assert.deepEqual(polled.lines, ["↳ Alpha run", "[Alpha] MP-5383 waits on the review"]);
	assert.equal((polled.dialogs as { key: string }[])[0]!.key, `${k.run}:d9`);
	k.exit(0);
	await until(async () => ((polled = await ask(s, { cmd: "prompt-poll", workspace: head.workspace, pid: 4343, cursor: polled.cursor })), (polled.lines as string[]).length > 0), "the end line");
	assert.deepEqual(polled.lines, ["✓ Alpha done"]);
});
