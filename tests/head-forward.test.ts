import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fieldsOf } from "../src/header.ts";
import { openAsk, readAsks } from "../src/server/headasks.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The head tower's forwards and the towers' answers (docs/specs/2026-11-04-head-tower.md, Forwarding, and the answers; H2): the head's tower_send opens the target's tower when it has none, opens an ask, and writes the header
// with `relay=boss:<event id>` only for a turn a boss event started; a tower answers with `tower_send {head: true, inReplyTo}` only to an open ask.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
	// The broker lists the identities that registered, each in its pane.
	Object.defineProperty(world, "sessions", {
		configurable: true,
		set() {},
		get: () => world.clients.filter((c) => c.registered && c.connected).map((c) => {
			const pane = world.herdr.panes.find((p) => p.pane_id === c.registered!.herdrPaneId), ws = world.herdr.workspaces.find((w) => w.workspace_id === pane?.workspace_id), tab = world.herdr.tabs.find((t) => t.tab_id === pane?.tab_id);
			return { id: c.sessionId!, name: c.registered!.name, herdrLocation: { status: "ok", workspace: { id: ws?.workspace_id, label: ws?.label }, tab: { id: tab?.tab_id, label: tab?.label }, paneId: pane?.pane_id } };
		}),
	});
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	const head = await world.expose!.head.ensure();
	return { s, head };
};
const claimed = async (s: Running, ws: string, n = 1) => {
	await until(() => world.pis.size >= n, "the run");
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, ws, id)?.pid, "the pid");
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return { id, token: String(got.token) };
};
/** A head run the boss woke, with the boss event taken: the token and the id of that event. */
const bossRun = async (s: Running, ws: string, text = "start MP-4129 in Alpha") => {
	assert.equal((await ask(s, { cmd: "tower-event", workspace: ws, text, present: true })).ok, true);
	const run = await claimed(s, ws);
	const e = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: run.token, id: e.id })).ok, true);
	return { ...run, event: e.id };
};
const tool = (s: Running, token: string, name: string, args: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ask(s, { cmd: "run-tool", token, tool: name, args, ...over });
const sentBy = (id: string) => world.client(id)!.sent;

test("tower_send in a head run: a workspace with no tower is given one, the message goes under the head's header with the ask, and the answer says so; the ask is on file", async () => {
	const { s, head } = await setup();
	const run = await bossRun(s, head.workspace);
	const done = await tool(s, run.token, "tower_send", { workspace: "Beta", message: "run the nightly check" });
	assert.equal(done.ok, true, JSON.stringify(done));
	assert.match(String(done.text), /^sent to the tower of Beta as ask H1 \(its tower was opened\)$/);
	const tower = world.client("sb-tower-wb")!;
	assert.ok(tower.registered, "the tower service of Beta was made");
	const sent = sentBy("sb-head").at(-1)!;
	assert.equal(sent.to, "sb-tower-wb");
	const f = fieldsOf(sent.text)!;
	assert.deepEqual({ from: f.from, id: f.id, role: f.role, head: f.head, workspace: f.workspace, kind: f.kind, scope: f.scope, reply: f.reply, ask: f.ask, relay: f.relay }, { from: "head tower", id: "sb-head", role: "tower", head: "yes", workspace: "head", kind: "tower_send", scope: "tower", reply: "expected", ask: "H1", relay: undefined });
	assert.match(f.to!, /^tower · Beta \(tower of Beta\)$/);
	assert.ok(sent.text.endsWith("] run the nightly check"));
	assert.deepEqual(readAsks(world.slot, Date.now()).map((a) => [a.id, a.workspace, a.label, a.first]), [["H1", "wB", "Beta", "run the nightly check"]]);
	// A second forward to the same workspace: its tower is there, and it is a new ask.
	const again = await tool(s, run.token, "tower_send", { workspace: "wB", message: "and report", reply: false });
	assert.match(String(again.text), /^sent to the tower of Beta as ask H2$/);
	assert.equal(fieldsOf(sentBy("sb-head").at(-1)!.text)!.reply, "none");
});

test("relay=boss:<event id> only when the run's turn was started by a boss event this run took: a turn an answer started, a made-up starter, another kind of event, and no starter send none", async () => {
	const { s, head } = await setup();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const run = await bossRun(s, head.workspace);
	await tool(s, run.token, "tower_send", { workspace: "wA", message: "from the boss's turn" }, { turn: run.event });
	assert.equal(fieldsOf(sentBy("sb-head").at(-1)!.text)!.relay, `boss:${run.event}`);
	// A starter the run made up, or one that is not a boss event it took.
	const wa = openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "x" });
	world.client("sb-head")!.incoming({ id: "sb-tower-wa", name: "tower · Alpha" }, { id: "a1", content: { text: `[straw net from="tower · Alpha" id=sb-tower-wa role=tower workspace=Alpha kind=tower_send scope=tower to=x reply=none in-reply-to=${wa.id}] done` } } as never);
	let answerEvent = "";
	await until(async () => ((await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string } | undefined)?.id !== undefined && ((answerEvent = ((await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string }).id), true), "the answer offered to the run", 6000);
	await ask(s, { cmd: "run-taken", token: run.token, id: answerEvent });
	for (const turn of ["forged-id", answerEvent, undefined]) {
		await tool(s, run.token, "tower_send", { workspace: "wA", message: `turn ${String(turn)}` }, turn ? { turn } : {});
		assert.equal(fieldsOf(sentBy("sb-head").at(-1)!.text)!.relay, undefined, `no relay for ${String(turn)}`);
	}
	// The model cannot say it in the arguments.
	const forged = await tool(s, run.token, "tower_send", { workspace: "wA", message: "x", relay: `boss:${run.event}`, turn: undefined });
	assert.equal(fieldsOf(sentBy("sb-head").at(-1)!.text)!.relay, undefined, String(forged.error));
});

test("the head forwards to one workspace at a time: a sub workspace goes to its parent, the head's own workspace is never a target, and a device, a broadcast, or a missing workspace is refused", async () => {
	const { s, head } = await setup();
	world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha-sub", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } } as never);
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", repo_key: "/r/alpha" } as never;
	const run = await bossRun(s, head.workspace);
	const sub = await tool(s, run.token, "tower_send", { workspace: "wS", message: "in the worktree" });
	assert.equal(sub.ok, true, JSON.stringify(sub));
	assert.match(String(sub.text), /^sent to the tower of Alpha \(Alpha-sub is a sub workspace\) as ask H1/);
	assert.equal(sentBy("sb-head").at(-1)!.to, "sb-tower-wa");
	for (const [args, why] of [[{ workspace: head.workspace, message: "x" }, /head tower's own workspace/], [{ message: "to everyone" }, /workspace has to be text/], [{ workspace: "wA", message: "x", device: "abc" }, /device is not for the head tower/], [{ workspace: "nowhere", message: "x" }, /No workspace matches/], [{ workspace: "wA", message: "" }, /message has to be text/]] as const) {
		const r = await tool(s, run.token, "tower_send", args as never);
		assert.equal(r.ok, false);
		assert.match(String(r.error), why);
	}
	assert.equal(readAsks(world.slot, Date.now()).length, 1, "a refused forward opens no ask");
});

test("a failed delivery closes the ask again and tells the head; the head has no tool to open a main, call a tower, broadcast, or answer a peer", async () => {
	const { s, head } = await setup();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const run = await bossRun(s, head.workspace);
	world.client("sb-head")!.deliver = { delivered: false, reason: "gone" };
	const failed = await tool(s, run.token, "tower_send", { workspace: "wA", message: "x" });
	assert.equal(failed.ok, false);
	assert.equal(readAsks(world.slot, Date.now()).every((a) => a.closed), true);
	for (const name of ["boss_open_main", "boss_close_main", "call_tower", "boss_status", "tower_reply", "link_request", "boss_broadcast"]) assert.equal((await tool(s, run.token, name, {})).ok, false, name);
	for (const cmd of ["open-main", "close-main"]) assert.equal((await ask(s, { cmd, workspace: head.workspace, token: run.token, request: "x", sender: "y", query: "z" })).ok, false, `${cmd} with the head's token`);
	assert.equal((await tool(s, run.token, "tower_list")).ok, true);
	const list = (await tool(s, run.token, "tower_list")).details as { head: { id: string }; towers: { workspace: { id: string }; folder: string | null }[] };
	assert.equal(list.head.id, "sb-head");
	assert.deepEqual(list.towers.map((t) => t.workspace.id), ["wA", "wB"], "the head workspace is never a row");
	assert.equal(list.towers[0]!.folder, "/w/alpha");
});

/** A workspace tower's local run, claimed. */
const towerRun = async (s: Running, ws = "wA") => {
	world.client(`sb-tower-${ws.toLowerCase()}`)!.incoming({ id: "main-1", name: "docs-main" }, { id: "m0", content: { text: "go" } } as never);
	const before = world.pis.size;
	await until(() => world.pis.size > before || world.pis.size >= 1, "the tower's run");
	const id = [...world.pis.keys()].at(-1)!;
	await until(() => readRun(world.slot, ws, id)?.pid, "pid");
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return String(got.token);
};

test("a workspace tower answers the head with tower_send {head: true, inReplyTo}: to an open ask of its own workspace only, under its header with in-reply-to; an ally run is refused it", async () => {
	const { s } = await setup();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	const mine = openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "do it" });
	const theirs = openAsk(world.slot, Date.now(), { workspace: "wB", label: "Beta", first: "other" });
	const token = await towerRun(s);
	const ok = await tool(s, token, "tower_send", { head: true, inReplyTo: mine.id, message: "landed in MP-4129" });
	assert.equal(ok.ok, true, JSON.stringify(ok));
	const sent = sentBy("sb-tower-wa").at(-1)!;
	assert.equal(sent.to, "sb-head");
	const f = fieldsOf(sent.text)!;
	assert.deepEqual({ id: f.id, kind: f.kind, scope: f.scope, "in-reply-to": f["in-reply-to"], role: f.role, head: f.head }, { id: "sb-tower-wa", kind: "tower_send", scope: "tower", "in-reply-to": mine.id, role: "tower", head: undefined });
	assert.match(f.to!, /^head tower \(head tower of /);
	assert.ok(sent.text.endsWith("] landed in MP-4129"));
	assert.match(String((await tool(s, token, "tower_send", { head: true, inReplyTo: theirs.id, message: "x" })).error), /no open ask H2 to this workspace/);
	assert.match(String((await tool(s, token, "tower_send", { head: true, message: "x" })).error), /inReplyTo/);
	assert.match(String((await tool(s, token, "tower_send", { head: true, inReplyTo: "nope", message: "x" })).error), /inReplyTo/);
	const ally = world.expose!.runs.mint("wA", { kind: "ally", device: "d1", level: "dispatch", team: "team-1" });
	assert.match(String((await tool(s, ally, "tower_send", { head: true, inReplyTo: mine.id, message: "x" })).error), /ally run does not answer the head/);
});

test("0.77.3 A5: a workspace tower's tower_send that names the head tower by its workspace id, its label, or its session id is told to use head: true, never that it has no tower", async () => {
	const { s } = await setup();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const token = await towerRun(s);
	const headWs = world.herdr.workspaces.find((w) => w.tokens?.sb_head)!;
	assert.ok(headWs, "the head has a workspace");
	for (const workspace of [headWs.workspace_id, headWs.label, "sb-head"]) {
		const r = await tool(s, token, "tower_send", { workspace, message: "routed MP-4129" });
		assert.equal(r.ok, false);
		assert.match(String(r.error), /is the head tower: use head: true/, `${workspace}: ${String(r.error)}`);
	}
});

test("the head's header names the head and nothing else does: a workspace tower's messages carry no head=yes, whatever the order of workspaces", async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	const token = await towerRun(s);
	await tool(s, token, "tower_send", { workspace: "wB", message: "hello" });
	const f = fieldsOf(sentBy("sb-tower-wa").at(-1)!.text)!;
	assert.equal(f.head, undefined);
	assert.equal(f.role, "tower");
	const list = (await tool(s, token, "tower_list")).details as { head: { id: string } | null; towers: { workspace: { id: string }; head?: boolean }[] };
	assert.equal(list.head, null, "no head tower yet");
	assert.ok(list.towers.every((t) => t.head === undefined));
	await world.expose!.head.ensure();
	const after = (await tool(s, token, "tower_list")).details as { head: { id: string; state: string } | null; towers: { workspace: { id: string } }[] };
	assert.equal(after.head?.id, "sb-head");
	assert.deepEqual(after.towers.map((t) => t.workspace.id), ["wA", "wB"]);
});
