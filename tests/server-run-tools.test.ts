import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { bundle, noLink, noTailscale } from "./gui-fakes.ts";
import { type Running, until } from "./server-world.ts";
import { updateRecord } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import type { Towers } from "../src/server/towers.ts";

// The tower tools in a run and the run-token checks on the control socket (docs/specs/2026-10-26-sb-backend.md, Tower tools in a run, The control socket, B3R-F003; B5): every tool a run calls is a thin
// client of the server, authenticated by the run token, and the server enforces the run's kind on every request. An ally run (B6 starts them; `mint` stands in for one here) gets almost nothing.

let world: TowerWorld;
let towers: Towers | undefined;
const restarts: string[] = [];
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	towers = undefined;
	restarts.length = 0;
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const started = async () => {
	const s = await world.start({
		gui: { bundle, tailscale: noTailscale, link: noLink, bindWaitMs: 200, restart: (reason: string) => (restarts.push(reason), { status: 202, body: { restarting: true } }) },
		towers: { ...world.options().options.towers, expose: (t: Towers) => (towers = t) },
	});
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
const from = { id: "main-1", name: "docs-main" };
const msg = (id: string, text: string) => ({ id, content: { text } });
/** A local run's token: an event makes the server start a run, and the test claims it. */
const localToken = async (s: Running) => {
	world.client("sb-tower-wa")!.incoming(from, msg("m0", "go"));
	await until(() => world.pis.size === 1, "the run");
	const [id, pi] = [...world.pis.entries()][0]!;
	let got: Reply | undefined;
	await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	return String(got!.token);
};
const tool = (s: Running, token: unknown, name: string, args: Record<string, unknown> = {}) => ask(s, { cmd: "run-tool", token, tool: name, args });
const ally = () => towers!.runs.mint("wA", { kind: "ally", device: "d1", level: "reply", team: "team-1" });

test("a run-tool request needs a token the server issued; boss_status answers under the tower identity", async () => {
	const s = await started();
	assert.equal((await tool(s, undefined, "boss_status")).error, "unknown_token");
	assert.equal((await tool(s, "nope", "boss_status")).error, "unknown_token");
	const token = await localToken(s);
	const status = await tool(s, token, "boss_status");
	assert.equal(status.ok, true, JSON.stringify(status));
	assert.deepEqual((status.details as { me: { id: string; role: string } }).me, { id: "sb-tower-wa", role: "tower" });
	assert.equal((await tool(s, token, "no_such_tool")).ok, false);
});

test("tower_reply sends one message to one local session, by id or name, under the tower identity's header; the intercom id of the run is never used", async () => {
	world.sessions = [{ id: "main-1", name: "docs-main", herdrLocation: { status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId: "wA:p1" } }];
	const s = await started();
	const token = await localToken(s);
	const done = await tool(s, token, "tower_reply", { to: "docs-main", message: "ship it", reply: false });
	assert.equal(done.ok, true, JSON.stringify(done));
	const sent = world.client("sb-tower-wa")!.sent.at(-1)!;
	assert.equal(sent.to, "main-1");
	assert.match(sent.text, /^\[straw net from="tower · Alpha" id=sb-tower-wa role=tower( head=yes)? workspace=Alpha kind=tower_reply scope=session to=.* reply=none\] ship it$/);
	assert.equal((await tool(s, token, "tower_reply", { to: "nobody", message: "x" })).ok, false);
	assert.equal((await tool(s, token, "tower_reply", { to: "main-1", message: "" })).ok, false);
});

test("a failed send that finishes after the run ended becomes a notice event for the next run, once", async () => {
	world.sessions = [{ id: "main-1", name: "docs-main" }];
	const s = await started();
	const token = await localToken(s);
	const client = world.client("sb-tower-wa")!;
	let inFlight!: () => void, open!: () => void;
	const reached = new Promise<void>((resolve) => (inFlight = resolve)), gate = new Promise<void>((resolve) => (open = resolve));
	client.send = async (to: string, options: { text: string; messageId?: string }) => (client.sent.push({ to, text: options.text, messageId: options.messageId }), inFlight(), await gate, { id: options.messageId ?? "m", delivered: false, reason: "gone" });
	const pending = tool(s, token, "tower_reply", { to: "main-1", message: "x" });
	await reached;
	// The run is gone before the answer is written.
	await towers!.runs.release({ token, reason: "test" });
	open();
	const answer = await pending;
	assert.equal(answer.ok, false);
	await until(() => towers!.runs.queue("wA").some((e) => e.kind === "notice"), "a notice event");
	assert.equal(towers!.runs.queue("wA").filter((e) => e.kind === "notice").length, 1);
});

test("boss_close_main and boss_open_main relay the opener's and the control channel's own refusals", async () => {
	const s = await started();
	const token = await localToken(s);
	const closed = await tool(s, token, "boss_close_main", { main: "ghost" });
	assert.equal(closed.ok, false);
	assert.match(String(closed.error), /No live session is named or has the id "ghost"/);
});

test("boss_server: status, logs, and a restart with a reason once a minute, decided by the server; the reason and the run go to the log", async () => {
	const s = await started();
	const token = await localToken(s);
	const status = await tool(s, token, "boss_server", { action: "status" });
	assert.equal(status.ok, true);
	assert.equal((status.details as { state: string }).state, "live");
	const logs = await tool(s, token, "boss_server", { action: "logs", lines: 5 });
	assert.equal(logs.ok, true);
	assert.ok(String(logs.text).split("\n").length <= 5);
	assert.match(String((await tool(s, token, "boss_server", { action: "restart" })).error), /reason/);
	assert.equal((await tool(s, token, "boss_server", { action: "restart", reason: "pi-intercom looks wedged" })).ok, true);
	assert.deepEqual(restarts, ["pi-intercom looks wedged"]);
	const again = await tool(s, token, "boss_server", { action: "restart", reason: "again" });
	assert.equal(again.ok, false);
	assert.match(String(again.error), /once a minute/);
	assert.equal(restarts.length, 1);
});

test("an ally run's token: the free reads, tower_send to its sender, and the gate's other tools only against an Allow; no call_tower, boss_server, link_request, local tower_send, or wakeAfter", async () => {
	const s = await started();
	const token = ally();
	for (const name of ["boss_status", "tower_list", "board_read"]) assert.equal((await tool(s, token, name)).ok, true, name);
	for (const name of ["call_tower", "boss_server", "link_request"]) assert.match(String((await tool(s, token, name, { message: "x", action: "restart", reason: "x" })).error), /not available in an ally run/, name);
	assert.match(String((await tool(s, token, "tower_send", { message: "x" })).error), /sender only/, "a local target is refused outright");
	for (const [name, args] of [["tower_reply", { to: "x", message: "x" }], ["boss_open_main", { request: "x", sender: "x" }], ["boss_close_main", { main: "x" }]] as const) {
		const got = await tool(s, token, name, { ...args });
		assert.equal(got.ok, false, name);
		assert.match(String(got.error), /needs the boss's confirm/, name);
		const withId = await ask(s, { cmd: "run-tool", token, tool: name, args, toolCallId: "tc-1" });
		assert.match(String(withId.error), /was not allowed/, `${name}: no Allow was given`);
	}
	// RV6-F007: a device other than the sender is refused outright, with or without a call id, so no Allow can turn it into a send to the sender.
	for (const extra of [{}, { toolCallId: "tc-2" }]) {
		const other = await ask(s, { cmd: "run-tool", token, tool: "tower_send", args: { device: "someone-else", message: "x" }, ...extra });
		assert.equal(other.ok, false);
		assert.match(String(other.error), /sender only/);
	}
	assert.equal(restarts.length, 0);
	assert.match(String((await ask(s, { cmd: "run-done", token, note: "n", wakeAfter: 10 })).error), /ally run schedules no wake/);
});

test("run tokens on other requests: an ally token is refused link, the gui, the opener, the tower's closing, status and restart; a local token is refused what a tower never does", async () => {
	const s = await started();
	const a = ally();
	for (const cmd of ["link", "gui", "gui-stop", "gui-remote", "gui-pair", "gui-rotate", "open-main", "close-main", "close-tower", "ensure-tower", "status", "restart", "stop", "tower-event", "tower-memory", "tower-retry", "tower-deliver", "tower-drop", "tower-leave", "tower-new", "prompt-poll", "prompt-leave", "prompt-gone"]) {
		const got = await ask(s, { cmd, token: a, workspace: "wA", from: "x", body: { op: "list" }, request: "r", sender: "s", query: "q", text: "t", pid: 4242 });
		assert.equal(got.ok, false, cmd);
		assert.match(String(got.error), /ally run|run token/, cmd);
	}
	assert.equal((await ask(s, { cmd: "link", token: "bogus", from: "x", body: { op: "list" } })).error, "unknown_token");
	const token = await localToken(s);
	for (const cmd of ["gui", "gui-stop", "gui-remote", "gui-pair", "gui-rotate", "close-tower", "ensure-tower", "stop", "restart", "tower-event", "tower-retry", "tower-deliver", "tower-drop", "tower-leave", "tower-new", "tower-memory", "prompt-poll", "prompt-leave", "prompt-gone"]) {
		const got = await ask(s, { cmd, token, workspace: "wA", on: true, text: "t", pid: 4242, json: { op: "confirm", proposal: "P1", rev: 0 } });
		assert.equal(got.ok, false, cmd);
		assert.match(String(got.error), /run token/, cmd);
	}
	assert.equal((await ask(s, { cmd: "status", token })).ok, true, "a local run may read the status");
});

test("a local run's link requests are limited to what a tower asks, and always go out as its own identity", async () => {
	const s = await started();
	const token = await localToken(s);
	for (const op of ["list", "board-read", "send"]) {
		const got = await ask(s, { cmd: "link", token, from: "someone-else", body: { op, device: "d", text: "t", id: "x", action: "create", args: {} } });
		assert.equal(got.ok, true, `${op}: ${JSON.stringify(got)}`);
	}
	for (const op of ["gui", "taken", "answer-confirm", "forget-confirm", "confirm-request", "confirms", "request-open", "request-run", "request-drop", "nonsense"]) {
		const got = await ask(s, { cmd: "link", token, from: "x", body: { op, name: "create", id: "x", dialogId: "d", allow: true } });
		assert.equal(got.ok, false, op);
		assert.match(String(got.error), /run token/, op);
	}
});

test("open-main and close-main with a local token are for the run's own workspace only", async () => {
	const s = await started();
	const token = await localToken(s);
	const other = await ask(s, { cmd: "open-main", token, workspace: "wB", request: "r", sender: "s" });
	assert.equal(other.ok, false);
	assert.match(String(other.error), /own workspace/);
	const own = await ask(s, { cmd: "close-main", token, workspace: "wA", query: "ghost" });
	assert.match(String(own.error), /No live session/, "reaches the tower's control channel");
});

test("the server keeps the once-a-minute restart limit itself: a restart that asks to be limited is refused when the last one that counts was less than a minute ago", async () => {
	const s = await started();
	updateRecord(world.slot, (r) => ({ ...r, lastRestart: { at: new Date().toISOString(), reason: "earlier", by: "someone" } }));
	const refused = await ask(s, { cmd: "restart", reason: "again", by: "a session", limit: true });
	assert.equal(refused.ok, false);
	assert.match(String(refused.error), /^rate: .*once a minute/);
	assert.equal(world.record()?.restarting, undefined, "nothing began");
});

test("view: the GUI's reading of a service is its state, its waiting events as queued rows (kind, sender, first line), the run, and the file of the run's comms", async () => {
	const s = await started();
	world.client("sb-tower-wa")!.incoming(from, msg("m0", "[straw net from=docs-main] first line\nsecond line"));
	const before = towers!.runs.view("wA")!;
	assert.equal(before.queued, 1);
	assert.deepEqual(before.queue, [{ text: "intercom · docs-main: [straw net from=docs-main] first line", as: "followUp" }]);
	assert.equal(towers!.runs.view("wZ"), undefined);
	const token = await localToken(s);
	await ask(s, { cmd: "run-file", token, file: "/s/run.jsonl" });
	const during = towers!.runs.view("wA")!;
	assert.equal(during.state, "running");
	assert.equal(during.run?.kind, "local");
	assert.equal(during.file, "/s/run.jsonl");
});
