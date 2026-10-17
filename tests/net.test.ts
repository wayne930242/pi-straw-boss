import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { PROMPT_DIR, settle, until, World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const prompt = (name: string) => readFileSync(`${PROMPT_DIR}/${name}.md`, "utf8").trim();
const hex = (id: string) => `straw-boss/tab/${Buffer.from(id).toString("hex")}`;

test("outside Herdr and in a pi-herdr-agents worker nothing registers and nothing is injected", async () => {
	const outside = world.agent({ id: "out", pane: "none", outsideHerdr: true });
	const worker = world.agent({ id: "worker", pane: "wA:p9", tab: "wA:t1", env: { PI_SUBAGENT_ID: "run-1" } });
	for (const agent of [outside, worker]) {
		await agent.start();
		assert.deepEqual(agent.registered, [], `${agent.id} registered handlers`);
		assert.equal(agent.tools.size, 0);
		assert.equal(agent.commands.size, 0);
		assert.deepEqual(await agent.run(), {});
	}
	assert.deepEqual(world.broker.registrations, []);
	assert.deepEqual(world.herdr.panes[0]?.tokens, {});
});

test("a session that has not joined gets the join reminder once, only boss_join, and no channel or tokens", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	assert.deepEqual([...a.tools.keys()], ["boss_join"]);
	const first = await a.run();
	assert.equal(first["straw-boss"], prompt("reminder"));
	assert.deepEqual(a.entries, [{ customType: "straw-boss", data: { asked: true } }]);
	assert.deepEqual(await a.run(), {}, "the reminder is injected once");
	assert.deepEqual(world.broker.registrations, []);
	assert.deepEqual(a.tokens, {});
});

test("the reminder is not repeated after a resume that carries the asked entry", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", entries: [{ customType: "straw-boss", data: { asked: true } }] });
	await a.start();
	assert.deepEqual(await a.run(), {});
	assert.deepEqual([...a.tools.keys()], ["boss_join"]);
});

test("the first joiner becomes the main agent, a later joiner is a member, and boss_join registers the net tools", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	assert.match(await a.join(), /main agent of tab work/);
	assert.match(await b.join(), /member; its main agent is a/);
	assert.deepEqual([...a.tools.keys()].sort(), ["boss_broadcast", "boss_join", "boss_status", "call_tower"]);
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "main" }, { sb_role: "member" }]);
	assert.deepEqual(world.broker.registrations.map((r) => [r.id, r.namespace, r.ownerEligible]), [["a", hex("wA:t1"), true], ["b", hex("wA:t1"), true]]);
	assert.deepEqual(a.entries.at(-1), { customType: "straw-boss", data: { asked: true, joined: true } });
	assert.match((await a.run())["straw-boss"]!, /^You are the main agent of Herdr tab work:/);
	assert.match((await b.run())["straw-boss"]!, /^Straw Boss: you joined the net of tab work, whose main agent is a\./);
});

test("the first joiner stays main even when a session that connected earlier joins later and owns the channel", async () => {
	const early = world.agent({ id: "early", pane: "wA:p1", tab: "wA:t1" });
	const late = world.agent({ id: "late", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([early.start(), late.start()]);
	await late.join();
	await early.join();
	assert.equal(world.broker.owners.get(hex("wA:t1")), "early", "the broker owner follows connection order");
	await until(() => (world.broker.states.get(hex("wA:t1"))?.payload as { main?: string })?.main === "late", "late pinned as main");
	await settle();
	assert.deepEqual([late.tokens, early.tokens], [{ sb_role: "main" }, { sb_role: "member" }]);
});

test("/boss from a member publishes a claim, the owner commits, and the two swap their pane tokens at the next run", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	await a.join();
	await b.join();
	await a.run();
	await b.run();
	await b.command();
	await settle();
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "member" }, { sb_role: "main" }]);
	assert.match((await b.run())["straw-boss"]!, /^You are the main agent/);
	assert.match((await a.run())["straw-boss"]!, /whose main agent is b\./);
	assert.deepEqual(a.notices.map((n) => n.text), ["This session is now the main agent of work", "This session is no longer the main agent of work"]);
	assert.ok(b.notices.some((n) => n.text === "This session is now the main agent of work"));
});

test("/boss in the owner pins itself without a claim, and /boss in an unjoined session joins first", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.command();
	await settle();
	assert.deepEqual(a.tokens, { sb_role: "main" });
	assert.deepEqual(a.entries.at(-1), { customType: "straw-boss", data: { asked: true, joined: true } });
	assert.equal((world.broker.states.get(hex("wA:t1"))?.payload as { main?: string }).main, "a");
});

test("an override main that leaves is cleared: the owner pins itself again", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	await a.join();
	await b.join();
	await b.command();
	await settle();
	await b.stop();
	await until(() => (world.broker.states.get(hex("wA:t1"))?.payload as { main?: string }).main === "a", "owner re-pinned itself");
	await settle();
	assert.deepEqual(a.tokens, { sb_role: "main" });
});

test("when the owner leaves with a stale main, the new owner clears it by pinning itself", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	await a.join();
	await b.join();
	await a.stop();
	await until(() => (world.broker.states.get(hex("wA:t1"))?.payload as { main?: string }).main === "b", "new owner pinned itself");
	await settle();
	assert.deepEqual(b.tokens, { sb_role: "main" });
	assert.match((await b.run())["straw-boss"]!, /^You are the main agent/);
});

test("a session that joined before a restart rejoins from its entry without a new entry or reminder", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", entries: [{ customType: "straw-boss", data: { asked: true, joined: true } }] });
	await a.start();
	await settle();
	assert.deepEqual(a.tokens, { sb_role: "main" });
	assert.equal(a.entries.length, 1);
	assert.match((await a.run())["straw-boss"]!, /^You are the main agent/);
});

test("a tab id over 24 characters fails fast with the reason", async () => {
	assert.equal(hex("wBB:t1"), "straw-boss/tab/7742423a7431");
	assert.match(hex("wBB:t1"), /^[a-z0-9][a-z0-9._/-]{0,63}$/);
	assert.doesNotMatch(hex("w".repeat(25)), /^[a-z0-9][a-z0-9._/-]{0,63}$/);
	world.herdr.addTab(`wA:t${"9".repeat(21)}`, "long", "wA:p77");
	const a = world.agent({ id: "a", pane: "wA:p77" });
	await a.start();
	await assert.rejects(a.tool("boss_join"), /too long for an intercom namespace/);
	assert.deepEqual(world.broker.registrations, []);
});

test("joining without pi-intercom, or on a broker without extension-bus-v1, fails with that reason", async () => {
	const bare = world.agent({ id: "bare", pane: "wA:p1", tab: "wA:t1", noIntercom: true });
	await bare.start();
	await assert.rejects(bare.tool("boss_join"), /pi-intercom is not loaded/);
	world.broker.supported = false;
	const old = world.agent({ id: "old", pane: "wA:p2", tab: "wA:t1" });
	await old.start();
	await assert.rejects(old.tool("boss_join"), /The intercom broker lacks extension-bus-v1/);
	world.broker.supported = true;
	world.broker.connected = false;
	const offline = world.agent({ id: "offline", pane: "wA:p3", tab: "wA:t1" });
	await offline.start();
	await assert.rejects(offline.tool("boss_join"), /pi-intercom is not connected/);
	assert.deepEqual(old.tokens, {});
	assert.deepEqual(old.entries, []);
});
