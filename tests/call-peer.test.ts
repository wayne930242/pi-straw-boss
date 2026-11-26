import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { PEER_TOOL } from "../src/callpeer.ts";
import { recordPath } from "../src/roles.ts";
import { type Agent, PROMPT_DIR, World } from "./fakes.ts";

// call_peer (src/callpeer.ts, src/peertargets.ts): a session of the sb net reaches a peer through sb, which finds it when the tool is called: the last writer (sender), its opener (caller), its tab's main or another by
// name, todo item, or tab (main, of), and its project's integrator. A target whose work went on by handover is reached at its successor.
let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const hex = (id: string) => `straw-boss/tab/${Buffer.from(id).toString("hex")}`;
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const toolBytes = (agent: Agent, names: string[]) => names.map((name) => agent.tools.get(name)!).reduce((n, t) => n + Buffer.byteLength(t.name + t.description + JSON.stringify(t.parameters)), 0);
const tab = async (...ids: string[]) => {
	const agents = ids.map((id, i) => world.agent({ id, pane: `wA:p${i + 1}`, tab: "wA:t1" }));
	await Promise.all(agents.map((a) => a.start()));
	return agents;
};
const sentBy = (id: string) => world.broker.delivered.filter((x) => x.from === id).map((x) => [x.to, x.message.split("] ")[1]]);
/** An intercom message from `from` as pi-intercom leaves it on the receiver's branch. */
const wrote = (to: Agent, from: string) => to.transcript.push({ type: "custom_message", customType: "intercom_message", details: { from: { id: from, name: from }, message: { id: `m-${from}` }, bodyText: "hi" } });
/** The role record of a main that handed its work over to `to` (roles.ts `handedOver`). */
const handed = (from: string, to: string) => {
	const file = `/sessions/2026-11-26T00-00-00-000Z_${from}.jsonl`;
	mkdirSync(join(world.stateDir, "roles"), { recursive: true });
	writeFileSync(recordPath(world.stateDir, file), JSON.stringify({ role: "main", pane: "wA:p90", tab: "wA:t90", workspace: "wA", file, at: 1, handedOver: { at: 2, to } }));
};
/** Live sessions with these ids, members of Beta's tab ops: the sessions a target names. */
let panes = 0;
const live = async (...ids: string[]) => {
	for (const id of ids) await world.agent({ id, pane: `wB:p${50 + panes++}`, tab: "wB:t1" }).start();
};
/** A main of its own in tab `tabId`. */
const mainIn = async (id: string, pane: string, tabId: string, name = id) => {
	const m = world.agent({ id, name, pane, tab: tabId });
	await m.start();
	await m.promote();
	return m;
};

test("a member's call_peer reaches the tab's main under the usual header; ask stamps reply expected", async () => {
	const [a, b] = await tab("a", "b");
	await a.promote();
	const sent = await b.tool(PEER_TOOL, { to: "main", message: "dispatching a scout on port 5173" });
	assert.match(textOf(sent), /^Sent to a, the main of tab work\. No reply is expected\./);
	const [d] = world.broker.delivered.filter((x) => x.from === "b");
	assert.equal(d?.to, "a");
	assert.match(d!.message, /^\[straw net from=b id=b role=member workspace=Alpha kind=call_peer scope=tab to="a \(main of Alpha\)" reply=none\] dispatching a scout on port 5173$/);
	const asked = await b.tool(PEER_TOOL, { to: "main", message: "may I take db fixture 2?", ask: true });
	assert.match(textOf(asked), /Its reply comes by intercom\./);
	assert.match(world.broker.delivered.at(-1)!.message, /reply=expected\] may I take db fixture 2\?$/);
});

test("call_peer reads the tab's main at the call: a successor recorded since the member last looked gets the message", async () => {
	const [a, b, c] = await tab("a", "b", "c");
	await a.promote();
	await c.tool(PEER_TOOL, { to: "main", message: "one" });
	// The main handed over to b: the broker's record moves, and c has seen no state event since.
	world.broker.states.set(hex("wA:t1"), { revision: 99, payload: { main: "b" } });
	await c.tool(PEER_TOOL, { to: "main", message: "two" });
	assert.deepEqual(sentBy("c"), [["a", "one"], ["b", "two"]]);
	void b;
});

test("a tab with no main refuses call_peer and names boss_promote; nothing is sent", async () => {
	const [, b] = await tab("a", "b");
	await assert.rejects(b.tool(PEER_TOOL, { to: "main", message: "hello" }), /has no main agent\. When your work grows, call boss_promote/);
	assert.deepEqual(sentBy("b"), []);
});

test("sender: the session that last wrote to me, reached at its successor once it handed over; none is a refusal", async () => {
	const [a, b] = await tab("a", "b");
	await a.promote();
	await assert.rejects(b.tool(PEER_TOOL, { to: "sender", message: "x" }), /No session has written to you/);
	await live("c1", "c2", "c3");
	wrote(b, "c1");
	wrote(b, "c2");
	const sent = await b.tool(PEER_TOOL, { to: "sender", message: "done" });
	assert.match(textOf(sent), /^Sent to c2, who last wrote to you\./);
	handed("c2", "c3");
	assert.match(textOf(await b.tool(PEER_TOOL, { to: "sender", message: "again" })), /who last wrote to you \(the successor of c2\)/);
	// A main has it too.
	wrote(a, "c1");
	await a.tool(PEER_TOOL, { to: "sender", message: "main's answer" });
	assert.deepEqual([...sentBy("b"), ...sentBy("a")], [["c2", "done"], ["c3", "again"], ["c1", "main's answer"]]);
	assert.match(world.broker.delivered.at(-1)!.message, /kind=call_peer scope=sender /);
});

test("caller: an opened main reaches its opener (its successor after a handover); a member, a device's main, and none are refused", async () => {
	world.herdr.addTab("wA:t5", "opened");
	world.herdr.addPane("wA:p5", "wA:t5").tokens = { sb_open_main: "1", sb_opened_by: "s1" };
	const m = world.agent({ id: "opened-1", pane: "wA:p5", tab: "wA:t5", env: { STRAW_BOSS_ROLE: "main" } });
	await m.start();
	await live("s1", "s1b");
	assert.match(textOf(await m.tool(PEER_TOOL, { to: "caller", message: "outcome" })), /^Sent to s1, who opened you\./);
	handed("s1", "s1b");
	await m.tool(PEER_TOOL, { to: "caller", message: "later" });
	assert.deepEqual(sentBy("opened-1"), [["s1", "outcome"], ["s1b", "later"]]);
	const [, b] = await tab("a", "b");
	await assert.rejects(b.tool(PEER_TOOL, { to: "caller", message: "x" }), /No session opened you: you have no caller \(a member was started by the boss\)/);
	world.herdr.addTab("wA:t6", "peer");
	world.herdr.addPane("wA:p6", "wA:t6").tokens = { sb_open_main: "1", sb_opened_by: "link:DEVICE01" };
	const p = world.agent({ id: "peer-main", pane: "wA:p6", tab: "wA:t6", env: { STRAW_BOSS_ROLE: "main" } });
	await p.start();
	await assert.rejects(p.tool(PEER_TOOL, { to: "caller", message: "x" }), /opened for a teammate's device.*call_tower/);
});

test("caller: a successor reaches the main that handed over to it until it took over", async () => {
	world.herdr.addTab("wA:t5", "next");
	world.herdr.addPane("wA:p5", "wA:t5").tokens = { sb_open_main: "1", sb_handover_from: "old-main", sb_opened_by: "s1" };
	const m = world.agent({ id: "next-1", pane: "wA:p5", tab: "wA:t5", env: { STRAW_BOSS_ROLE: "main" } });
	await m.start();
	await live("old-main");
	handed("old-main", "next-1"); // its own handover mark never sends it to itself
	const sent = await m.tool(PEER_TOOL, { to: "caller", message: "took over" });
	assert.match(textOf(sent), /^Sent to old-main, the main that handed its work to you\./);
	assert.equal((sent as { details: { id: string } }).details.id, "old-main");
});

test("main with of: another main by exact name, tab label or id, todo item key; its successor; ambiguity and none refused with candidates", async () => {
	const [a, b] = await tab("a", "b");
	await a.promote();
	const x = await mainIn("x9f3c2d1", "wA:p3", "wA:t2", "docs writer");
	await b.tool(PEER_TOOL, { to: "main", of: "docs writer", message: "by name" });
	await b.tool(PEER_TOOL, { to: "main", of: "docs", message: "by tab label" });
	await a.tool(PEER_TOOL, { to: "main", of: "wA:t2", message: "by tab id" });
	await a.tool(PEER_TOOL, { to: "main", of: "x9f3c2d1#4", message: "by item" });
	handed("gone7777", "x9f3c2d1");
	await a.tool(PEER_TOOL, { to: "main", of: "gone7777#2", message: "by handed item" });
	const file = join(mkdtempSync(join(tmpdir(), "psb-peer-")), "2026-11-26T00-00-00-000Z_x9f3c2d1.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "message" })}\n${JSON.stringify({ type: "custom", customType: "todo/v1", data: { v: 1, nextId: 2, tasks: [{ id: 1, uid: "t_abcdefghij", subject: "docs", status: "in_progress" }] } })}\n${JSON.stringify({ type: "message" })}\n`);
	world.herdr.pane("wA:p3").agent_session = { value: file };
	const got = await a.tool(PEER_TOOL, { to: "main", of: "t_abcdefghij", message: "by uid" });
	assert.match(textOf(got), /^Sent to docs writer, the main of tab docs\./);
	assert.deepEqual([...sentBy("b"), ...sentBy("a")].map(([to]) => to), Array(6).fill(x.id));
	await assert.rejects(a.tool(PEER_TOOL, { to: "main", message: "x" }), /You are your tab's main: name another main with of/);
	await assert.rejects(a.tool(PEER_TOOL, { to: "main", of: "work", message: "x" }), /main of tab work is you/);
	await assert.rejects(b.tool(PEER_TOOL, { to: "main", of: "nobody", message: "x" }), /No live main matches "nobody".*Mains: (a \(tab work, a\); docs writer \(tab docs, x9f3c2d1\)|docs writer \(tab docs, x9f3c2d1\); a \(tab work, a\))\./);
	await mainIn("y", "wB:p1", "wB:t1", "work");
	await assert.rejects(b.tool(PEER_TOOL, { to: "main", of: "work", message: "x" }), /2 mains match "work".*Matches: .*\(tab work, a\).*work \(tab ops, y\)|2 mains match "work".*work \(tab ops, y\).*\(tab work, a\)/);
	await assert.rejects(b.tool(PEER_TOOL, { to: "sender", of: "work", message: "x" }), /of names a main: use it with to: main/);
});

test("integrator: the one integrator of the checkout's project; none or two refused with what was found", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-peer-proj-"));
	mkdirSync(join(dir, ".straw-boss"));
	writeFileSync(join(dir, ".straw-boss", "apps.json"), JSON.stringify({ integration: { project: "acme" }, apps: [] }));
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", deps: { cwd: () => dir } });
	await a.start();
	await a.promote();
	await assert.rejects(a.tool(PEER_TOOL, { to: "integrator", message: "x" }), /Project acme \(integration\.project in .*\) has no live integrator/);
	const i = await mainIn("integ-1", "wA:p3", "wA:t2", "integ acme");
	world.herdr.pane("wA:p3").tokens.sb_duty = "integrator";
	assert.match(textOf(await a.tool(PEER_TOOL, { to: "integrator", message: "slip lost?" })), /^Sent to integ acme, the integrator of project acme\./);
	assert.deepEqual(sentBy("a"), [[i.id, "slip lost?"]]);
	await mainIn("integ-2", "wB:p1", "wB:t1", "integ acme");
	world.herdr.pane("wB:p1").tokens.sb_duty = "integrator";
	await assert.rejects(a.tool(PEER_TOOL, { to: "integrator", message: "x" }), /Project acme has 2 integrators/);
});

test("a member, a main, and a train have call_peer in their active tools; a tower's call is refused, a subagent has no such tool", async () => {
	const [a, b] = await tab("a", "b");
	await a.promote();
	await Promise.all([a.run(), b.run()]);
	assert.ok(b.active?.includes(PEER_TOOL), "the member has it");
	assert.ok(a.active?.includes(PEER_TOOL), "the main has it");
	world.herdr.addTab("wA:t9", "train 1106m", "wA:p9");
	Object.assign(world.herdr.pane("wA:p9").tokens, { sb_open_main: "1", sb_train: "acme/2026-11-06-m", sb_opened_by: "integ-x" });
	const train = world.agent({ id: "t", pane: "wA:p9", tab: "wA:t9", env: { STRAW_BOSS_ROLE: "train" } });
	await train.start();
	await train.run();
	await live("integ-x");
	assert.ok(train.active?.includes(PEER_TOOL), "the train has it");
	await train.tool(PEER_TOOL, { to: "caller", message: "landed" });
	assert.deepEqual(sentBy("t"), [["integ-x", "landed"]], "a train's caller is the integrator that sent its manifest");
	await assert.rejects(train.tool(PEER_TOOL, { to: "main", message: "x" }), /A train's tab has no main/);
	const tower = world.tower("tower-wB", "wB:t9", "wB:p9");
	await tower.start();
	await tower.run();
	assert.ok(!tower.active?.includes(PEER_TOOL), "a tower does not");
	if (tower.tools.has(PEER_TOOL)) await assert.rejects(tower.tool(PEER_TOOL, { to: "sender", message: "x" }), /this session is tower\. Use tower_send or tower_reply/);
	const child = world.agent({ id: "k", pane: "wA:p8", tab: "wA:t1", env: { PI_SUBAGENT_ID: "run-1" } });
	await child.start();
	await child.run();
	assert.ok(!child.tools.has(PEER_TOOL), "a subagent never registers it");
});

test("tool text: call_peer is at most 450 bytes (444 measured), all of it new to a main and a train, 146 more than 0.102.0's to a member", async () => {
	const [a, b] = await tab("a", "b");
	await a.promote();
	await Promise.all([a.run(), b.run()]);
	const bytes = toolBytes(b, [PEER_TOOL]);
	assert.ok(bytes <= 450, `call_peer is ${bytes} bytes (298 in 0.102.0, a member's only)`);
});

test("member.md sends the member to call_peer, not to a board_read lookup and intercom", () => {
	const text = readFileSync(`${PROMPT_DIR}/member.md`, "utf8");
	assert.match(text, /Before you dispatch a subagent, tell it with `call_peer` \(to: main\) what you will do and which resources \(ports, databases, files, branches\) it uses; take other shared-resource questions there too\./);
	assert.doesNotMatch(text, /board_read|through intercom/);
});
