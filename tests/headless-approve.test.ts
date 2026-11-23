import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinkHolder } from "../src/link/holder.ts";
import type { NetView } from "../src/link/routing.ts";
import { LinkStore } from "../src/link/store.ts";
import { callControl } from "../src/server/socket.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until as untilLink } from "./link/fakes.ts";
import { alice, bob, clientFor, config, netOf, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { type FakeKid, TowerWorld } from "./tower-world.ts";

// Approvals and the drain of headless runs (review REV-F002, REV-F003, REV-F004). A headless run has no pane and no bridge, so the hub never sees its approval close: the server raises the approval itself
// (`run-approve`), from what it holds of the call, and the boss's yes in a viewer or on this computer's page is that call's one Allow; so is the sender's device's yes to an ally run's `forward` confirm. A restart
// that drains its runs still takes their own requests. A select is answered with one of its options. Red on 3d38d3b6: `run-approve` was unknown, a forward yes noted nothing, and every run request during the drain
// was refused `restarting`.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true, undefined, true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }, 15_000).then((x) => x.reply as Reply);
const started = async () => {
	const s = await world.start();
	await s.handle.ready;
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA", view: false })).ok, true);
	await until(() => world.client("sb-tower-wa"), "the tower identity");
	return s;
};
const kid = async (n = 1): Promise<FakeKid> => {
	await until(() => world.kids.size >= n, `headless run ${n} to spawn`);
	return [...world.kids.values()][n - 1]!;
};
const claim = async (s: Running, k: FakeKid) => {
	const got = await ask(s, { cmd: "claim", runId: k.run, pane: "", pid: k.pid, nonce: k.nonce, liveBrief: true });
	assert.equal(got.ok, true, JSON.stringify(got));
	assert.equal(got.headless, true, "the claim tells the run it is headless");
	return String(got.token);
};
const approvals = () => world.expose!.runs.kids()!.dialogs().filter((d) => d.approval);

test("a headless run's link_request: the server raises the approval from the lines it holds, only the boss answers it, and his yes is one Allow for that call", async () => {
	world.linkAnswers.set("request-open", () => ({ ok: true, id: "r1", lines: ["Add device Bob to team One"], reason: "the boss asked" }));
	world.linkAnswers.set("request-run", () => ({ ok: true, text: "Bob was added" }));
	const s = await started();
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "add Bob", present: true });
	const k = await kid();
	const token = await claim(s, k);
	const opened = await ask(s, { cmd: "run-tool", token, tool: "link_request", toolCallId: "call-1", args: { phase: "open", action: "team-add", args: {}, reason: "the boss asked" } });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	const approving = ask(s, { cmd: "run-approve", token, toolCallId: "call-1", kind: "request", id: "r1" });
	await until(() => approvals().length === 1, "the approval as the run's dialog");
	const d = approvals()[0]!;
	assert.equal(d.method, "confirm");
	assert.match(String(d.message), /^Add device Bob to team One\nAsked by session: tower run of Alpha/);
	assert.match(String((await ask(s, { cmd: "run-dialog", key: d.key, confirmed: true, token })).error), /token may not/, "the run cannot answer its own approval");
	assert.match(String((await ask(s, { cmd: "run-tool", token, tool: "link_request", toolCallId: "call-1", args: { phase: "run", id: "r1" } })).error), /no approval/, "nothing is run before the boss's yes");
	assert.equal((await ask(s, { cmd: "run-dialog", key: d.key, confirmed: true })).ok, true);
	assert.equal((await approving).approved, true);
	assert.deepEqual(k.written, [], "the server's own dialog writes nothing to the run's stdin");
	assert.match(String((await ask(s, { cmd: "run-tool", token, tool: "link_request", toolCallId: "call-2", args: { phase: "run", id: "r1" } })).error), /no approval for tool call call-2/, "the Allow is the call's, not another's");
	const ran = await ask(s, { cmd: "run-tool", token, tool: "link_request", toolCallId: "call-1", args: { phase: "run", id: "r1" } });
	assert.equal(ran.ok, true, JSON.stringify(ran));
	assert.equal(ran.text, "Bob was added");
	// A no, a withdrawn approval, and one for a request the run never opened give nothing.
	world.linkAnswers.set("request-open", () => ({ ok: true, id: "r2", lines: ["Remove device Bob"], reason: "x" }));
	await ask(s, { cmd: "run-tool", token, tool: "link_request", toolCallId: "call-3", args: { phase: "open", action: "team-remove", args: {}, reason: "x" } });
	const refused = ask(s, { cmd: "run-approve", token, toolCallId: "call-3", kind: "request", id: "r2" });
	await until(() => approvals().length === 1, "the second approval");
	assert.equal((await ask(s, { cmd: "run-dialog", key: approvals()[0]!.key, confirmed: false })).ok, true);
	assert.equal((await refused).approved, false);
	const dropped = ask(s, { cmd: "run-approve", token, toolCallId: "call-3", kind: "request", id: "r2" });
	await until(() => approvals().length === 1, "the third approval");
	assert.equal((await ask(s, { cmd: "run-approve", token, toolCallId: "call-3", drop: true })).ok, true);
	assert.equal((await dropped).approved, false);
	assert.match(String((await ask(s, { cmd: "run-tool", token, tool: "link_request", toolCallId: "call-3", args: { phase: "run", id: "r2" } })).error), /no approval/);
	assert.match(String((await ask(s, { cmd: "run-approve", token, toolCallId: "call-4", kind: "request", id: "nope" })).error), /no such request/);
});

test("a headless ally run's gated call: the boss's yes to the server's approval, or the sender's device's yes to its forward confirm, is the Allow of that call and those arguments only", async () => {
	world.serverAllows = false;
	const s = await started();
	world.ally.add("m1", "a".repeat(26), "please close it");
	world.expose?.allyWaiting("sb-tower-wa");
	const k = await kid();
	const token = await claim(s, k);
	const run = k.run, args = { main: "docs-main" };
	const approving = ask(s, { cmd: "run-approve", token, toolCallId: "g1", kind: "gate", tool: "boss_close_main", args });
	await until(() => approvals().length === 1, "the gate's approval");
	assert.match(approvals()[0]!.title, /^Remote request from label-a+ \(a{6}, trust reply\): boss_close_main$/);
	assert.equal((await ask(s, { cmd: "run-dialog", key: approvals()[0]!.key, confirmed: true })).ok, true);
	assert.equal((await approving).approved, true);
	assert.deepEqual(world.allows.takeRun({ run, toolCallId: "g1", tool: "boss_close_main", args: { main: "other" } }), { ok: false, reason: "the approval was given for another call than this one" });
	assert.deepEqual(world.allows.takeRun({ run, toolCallId: "g1", tool: "boss_close_main", args }), { ok: true });
	assert.equal(world.allows.takeRun({ run, toolCallId: "g1", tool: "boss_close_main", args }).ok, false, "used once");
	assert.match(String((await ask(s, { cmd: "run-approve", token, toolCallId: "g4", kind: "request", id: "r1" })).error), /an ally run for a gated call/, "an ally run approves no link_request");
});

test("a tabless headless tower's forward confirm goes through the real holder to the sender's device, and that device's yes is the Allow of the call the run named (REV2-F001)", async () => {
	// Red on fb807eea: the holder looked for the tower's Herdr pane, which a headless service with no viewer tab has none of, and refused the request.
	const root = mkdtempSync(join(tmpdir(), "psb-headless-forward-")), project = join(root, "project"), relay = new FakeRelay();
	mkdirSync(join(project, "alpha"), { recursive: true });
	world.herdr.workspaces[0]!.worktree = { checkout_path: join(project, "alpha") };
	relay.addTeam(TEAM, [alice.id, bob.id], rosterOf(["bob"]));
	const holders: LinkHolder[] = [], got: [string, string, boolean][] = [];
	const holder = (keys: typeof alice, name: string, net: () => Promise<NetView>, confirmed?: (tower: string, id: string, allow: boolean) => void) => {
		const store = new LinkStore(join(root, name), { alive: () => true });
		store.ensure();
		writeDevice(store, keys, `${name}-mac`);
		writeTeam(store, rosterOf(["bob"]), keys);
		const h = new LinkHolder({ store, isHolder: () => true, config: config(project), net, relay: clientFor(relay), offer: () => {}, notify: () => {}, ...(confirmed ? { confirmed } : {}), backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000 });
		holders.push(h);
		return h;
	};
	try {
		world.serverAllows = false;
		const s = await started();
		// The box's holder reads the server's own served towers, as service.ts does; no pane holds sb-tower-wa.
		const a = holder(alice, "a", async () => ({ ...netOf([]), sessions: [{ id: "sb-tower-wa" }], workspaces: [{ workspace_id: "wA", label: "Alpha" }], served: world.expose!.servedTowers() }), (tower, id, allow) => void (got.push([tower, id, allow]), world.expose!.confirmed(id, allow)));
		const b = holder(bob, "b", async () => netOf([]));
		await Promise.all([a.start(), b.start()]);
		world.linkAnswers.set("confirm-request", (body, from, served) => a.requestConfirm({ fromSession: from, served, team: TEAM_HEX, device: bob.id, dialogId: String(body.dialogId), digest: String(body.digest), tool: String(body.tool), args: String(body.args), tower: String(body.tower) }));
		world.ally.add("m1", "a".repeat(26), "please close it");
		world.expose?.allyWaiting("sb-tower-wa");
		const k = await kid();
		const token = await claim(s, k);
		const args = { main: "docs-main" };
		const sent = await ask(s, { cmd: "link", token, body: { op: "confirm-request", dialogId: "dlg-1", digest: "x", tool: "boss_close_main", args: JSON.stringify(args, null, 2), tower: "Alpha", toolCallId: "g2" } });
		assert.deepEqual(sent.answer, { ok: true }, JSON.stringify(sent));
		await untilLink(() => b.confirmRequests().length === 1, 3000, "the confirm on the sender's device");
		assert.deepEqual(await b.answerConfirm("dlg-1", true), { ok: true });
		await untilLink(() => got.length === 1, 3000, "the device's yes back on the box");
		assert.deepEqual(got, [["sb-tower-wa", "dlg-1", true]]);
		assert.deepEqual(world.allows.takeRun({ run: k.run, toolCallId: "g2", tool: "boss_close_main", args }), { ok: true });
		// A no gives nothing.
		await ask(s, { cmd: "link", token, body: { op: "confirm-request", dialogId: "dlg-2", digest: "x", tool: "boss_close_main", args: JSON.stringify(args), tower: "Alpha", toolCallId: "g3" } });
		await untilLink(() => b.confirmRequests().length === 1, 3000, "the second confirm");
		await b.answerConfirm("dlg-2", false);
		await untilLink(() => got.length === 2, 3000, "the no");
		assert.equal(world.allows.takeRun({ run: k.run, toolCallId: "g3", tool: "boss_close_main", args }).ok, false, "a device's no gives nothing");
		// A session that names the tower over the control socket is not the server's run: refused.
		const forged = await ask(s, { cmd: "link", from: "sb-tower-wa", body: { op: "confirm-request", team: TEAM_HEX, device: bob.id, dialogId: "dlg-3", digest: "x", tool: "t", args: "{}", tower: "Alpha" } });
		assert.match(String((forged.answer as Reply).error), /Only the tower/);
	} finally {
		for (const h of holders) await h.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test("a restart drains a headless run through the control socket: its own poll and tower_done are taken, a session's request is refused, and no new run starts", async () => {
	const s = await started();
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "one" } });
	const k = await kid();
	const token = await claim(s, k);
	const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string };
	await ask(s, { cmd: "run-taken", token, id: event.id });
	assert.equal((await ask(s, { cmd: "run-poll", token, idle: false })).ok, true);
	assert.equal((await ask(s, { cmd: "restart", reason: "test drain" })).ok, true);
	await until(() => world.record()?.restarting, "the restart to begin");
	const polled = await ask(s, { cmd: "run-poll", token, idle: false });
	assert.equal(polled.ok, true, `a draining run's poll is taken: ${JSON.stringify(polled)}`);
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wB", view: false })).error, "restarting", "a session's request waits for the next server");
	assert.match(String((await ask(s, { cmd: "run-dialog", key: "x:1", token })).error), /token may not/, "a run token still asks only its own");
	const done = await ask(s, { cmd: "run-done", token, note: "finished before the restart" });
	assert.equal(done.ok, true, JSON.stringify(done));
	await until(() => k.stdinEnded, "the drained run's stdin to close");
	k.exit(0);
	await until(() => readRun(world.slot, "wA", k.run)?.outcome, "the run's end");
	assert.equal(readRun(world.slot, "wA", k.run)!.outcome, "done");
	assert.equal(world.kids.size, 1, "no run starts while it drains");
});

test("a select is answered with one of its options or cancelled: an answer with no value or another value is refused and nothing is written", async () => {
	const s = await started();
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "hello", present: true });
	const k = await kid();
	await claim(s, k);
	k.say({ type: "extension_ui_request", id: "s1", method: "select", title: "Which one?", options: ["red", "blue"] });
	const kids = world.expose!.runs.kids()!;
	await until(() => kids.dialogs().length === 1, "the select");
	const key = kids.dialogs()[0]!.key;
	assert.match(String((await ask(s, { cmd: "run-dialog", key, confirmed: true })).error), /not waiting|not one/i);
	assert.match(String((await ask(s, { cmd: "run-dialog", key, value: "green" })).error), /not waiting|not one/i);
	assert.deepEqual(k.written, []);
	assert.equal((await ask(s, { cmd: "run-dialog", key, value: "blue" })).ok, true);
	assert.deepEqual(k.written, [{ type: "extension_ui_response", id: "s1", value: "blue" }]);
});
