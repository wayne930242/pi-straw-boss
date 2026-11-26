import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { PEER_TOOL } from "../src/callpeer.ts";
import { PROMPT_DIR, World } from "./fakes.ts";

// call_peer (src/callpeer.ts): a member reaches its tab's main through sb, which finds the main when the tool is called.
let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const hex = (id: string) => `straw-boss/tab/${Buffer.from(id).toString("hex")}`;
const textOf = (result: { content: unknown[] }) => (result.content[0] as { text: string }).text;
const toolBytes = (agent: ReturnType<World["agent"]>, names: string[]) => names.map((name) => agent.tools.get(name)!).reduce((n, t) => n + Buffer.byteLength(t.name + t.description + JSON.stringify(t.parameters)), 0);
const tab = async (...ids: string[]) => {
	const agents = ids.map((id, i) => world.agent({ id, pane: `wA:p${i + 1}`, tab: "wA:t1" }));
	await Promise.all(agents.map((a) => a.start()));
	return agents;
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
	assert.deepEqual(world.broker.delivered.filter((x) => x.from === "c").map((x) => [x.to, x.message.split("] ")[1]]), [["a", "one"], ["b", "two"]]);
	void b;
});

test("a tab with no main refuses call_peer and names boss_promote; nothing is sent", async () => {
	const [, b] = await tab("a", "b");
	await assert.rejects(b.tool(PEER_TOOL, { to: "main", message: "hello" }), /has no main agent\. When your work grows, call boss_promote/);
	assert.deepEqual(world.broker.delivered.filter((x) => x.from === "b"), []);
});

test("only a member has call_peer in its active tools; a main's call is refused, and a subagent has no such tool", async () => {
	const [a, b] = await tab("a", "b");
	await a.promote();
	await Promise.all([a.run(), b.run()]);
	assert.ok(b.active?.includes(PEER_TOOL), "the member has it");
	assert.ok(!a.active?.includes(PEER_TOOL), "the main does not");
	await assert.rejects(a.tool(PEER_TOOL, { to: "main", message: "x" }), /call_peer is for a tab's members; this session is main/);
	const child = world.agent({ id: "k", pane: "wA:p9", tab: "wA:t1", env: { PI_SUBAGENT_ID: "run-1" } });
	await child.start();
	await child.run();
	assert.ok(!child.tools.has(PEER_TOOL), "a subagent never registers it");
	// A member promoted mid-session loses it at its next run.
	await a.stop();
	await b.promote();
	await b.run();
	assert.ok(!b.active?.includes(PEER_TOOL), "promoted: gone");
});

test("tool text: call_peer adds at most 300 bytes to a member and nothing to a main", async () => {
	const [a, b] = await tab("a", "b");
	await a.promote();
	await Promise.all([a.run(), b.run()]);
	const bytes = toolBytes(b, [PEER_TOOL]);
	assert.ok(bytes <= 300, `call_peer is ${bytes} bytes`);
	assert.ok(!a.active?.includes(PEER_TOOL));
});

test("member.md sends the member to call_peer, not to a board_read lookup and intercom", () => {
	const text = readFileSync(`${PROMPT_DIR}/member.md`, "utf8");
	assert.match(text, /Before you dispatch a subagent, tell it with `call_peer` \(to: main\) what you will do and which resources \(ports, databases, files, branches\) it uses; take other shared-resource questions there too\./);
	assert.doesNotMatch(text, /board_read|through intercom/);
});
