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

test("outside Herdr nothing registers; a pi-herdr-agents worker runs only the dialog bridge; neither injects anything", async () => {
	const outside = world.agent({ id: "out", pane: "none", outsideHerdr: true });
	const worker = world.agent({ id: "worker", pane: "wA:p9", tab: "wA:t1", env: { PI_SUBAGENT_ID: "run-1" } });
	for (const agent of [outside, worker]) {
		await agent.start();
		assert.deepEqual(agent.registered, agent === worker ? ["input", "message_start", "agent_settled", "session_start", "tool_execution_start", "tool_execution_end", "session_shutdown"] : [], `${agent.id} registered handlers`);
		assert.equal(agent.tools.size, 0);
		assert.equal(agent.commands.size, 0);
		assert.deepEqual(await agent.run(), {});
	}
	assert.deepEqual(world.broker.registrations, []);
	assert.deepEqual(world.herdr.panes[0]?.tokens, {});
});

const state = (tab = "wA:t1") => world.broker.states.get(hex(tab))?.payload as { main?: string } | undefined;

test("a session joins the net as a member at start: channel, tokens, net tools and boss_promote, no entry, no reminder", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	assert.deepEqual([...a.tools.keys()].sort(), ["boss_broadcast", "boss_promote", "boss_status", "call_tower"]);
	assert.deepEqual(world.broker.registrations.map((r) => [r.id, r.namespace, r.ownerEligible]), [["a", hex("wA:t1"), true]]);
	assert.deepEqual(a.tokens, { sb_role: "member" });
	assert.deepEqual(a.entries, [], "joining writes no session entry");
	assert.equal(state(), undefined, "nobody is main");
	assert.equal((await a.run())["straw-boss"], prompt("member-no-main").replaceAll("{{tab}}", "work"));
	assert.equal(world.herdr.commands("tab", "create").length, 0, "no tower yet");
});

test("a session saved with asked: true that never joined joins on its next start", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", entries: [{ customType: "straw-boss", data: { asked: true } }] });
	await a.start();
	assert.deepEqual(a.tokens, { sb_role: "member" });
	assert.ok(a.tools.has("boss_promote"));
	assert.equal(a.entries.length, 1, "no new entry");
});

test("entries saved by 0.4.0 (asked, then joined) bring the session back as a member, never as main, and write nothing", async () => {
	const old = [{ customType: "straw-boss", data: { asked: true } }, { customType: "straw-boss", data: { asked: true, joined: true } }];
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1", entries: old });
	await a.start();
	await a.promote();
	await b.start();
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "main" }, { sb_role: "member" }], "a saved join does not take over the live main");
	assert.ok(b.tools.has("boss_promote"));
	assert.equal(b.entries.length, 2, "no new entry");
	assert.match((await b.run())["straw-boss"]!, /whose main agent is a\./);
});

test("boss_promote makes the first caller the main agent; a second caller is refused while that main lives", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "member" }, { sb_role: "member" }]);
	assert.match(await a.promote(), /now the main agent of tab work/);
	assert.match(await b.promote(), /Tab work already has a main agent, a\..*tell a through intercom first/);
	assert.match(await a.promote(), /already the main agent/);
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "main" }, { sb_role: "member" }]);
	assert.equal(state()?.main, "a");
	assert.match((await a.run())["straw-boss"]!, /^You are the main agent of Herdr tab work:/);
	assert.match((await b.run())["straw-boss"]!, /^Straw Boss: you are a member of tab work, whose main agent is a\..*Before you dispatch a subagent, tell a through intercom/);
	await assert.rejects(b.tool("boss_promote"), /already has a main agent/);
});

test("the first to promote is main even when a session that connected earlier owns the channel", async () => {
	const early = world.agent({ id: "early", pane: "wA:p1", tab: "wA:t1" });
	const late = world.agent({ id: "late", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([early.start(), late.start()]);
	await late.promote();
	assert.match(await early.promote(), /already has a main agent, late/);
	assert.equal(world.broker.owners.get(hex("wA:t1")), "early", "the broker owner follows connection order");
	assert.equal(state()?.main, "late");
	assert.deepEqual([late.tokens, early.tokens], [{ sb_role: "main" }, { sb_role: "member" }]);
});

test("two members promoting at the same moment leave one main in the tab", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	const c = world.agent({ id: "c", pane: "wA:p3", tab: "wA:t1" });
	await Promise.all([a.start(), b.start(), c.start()]);
	const results = await Promise.all([a.promote(), b.promote(), c.promote()]);
	assert.equal(results.filter((text) => /now the main agent/.test(text)).length, 1, results.join(" | "));
	assert.equal([a, b, c].filter((x) => x.tokens.sb_role === "main").length, 1);
});

test("two members that are not the owner promote at the same moment: exactly one is main and the other is refused", async () => {
	const owner = world.agent({ id: "owner", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	const c = world.agent({ id: "c", pane: "wA:p3", tab: "wA:t1" });
	await Promise.all([owner.start(), b.start(), c.start()]);
	assert.equal(world.broker.owners.get(hex("wA:t1")), "owner");
	const [rb, rc] = await Promise.all([b.promote(), c.promote()]);
	assert.deepEqual([rb, rc].filter((text) => /now the main agent/.test(text)).length, 1, `${rb} | ${rc}`);
	assert.deepEqual([rb, rc].filter((text) => /already has a main agent/.test(text)).length, 1, `${rb} | ${rc}`);
	const mains = [owner, b, c].filter((x) => x.tokens.sb_role === "main");
	assert.equal(mains.length, 1);
	assert.equal(state()?.main, mains[0]!.id, "the channel records the one that won");
});

test("/boss from a member forces a claim even when the tab has a main; the two swap their pane tokens", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	await a.promote();
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

test("/boss in the owner pins itself without a claim and writes no entry", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.command();
	await settle();
	assert.deepEqual(a.tokens, { sb_role: "main" });
	assert.deepEqual(a.entries, []);
	assert.equal(state()?.main, "a");
});

test("a main never demotes, and when it leaves the tab has no main until a member promotes", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	await a.promote();
	await b.promote();
	await settle();
	assert.deepEqual([a.tokens, b.tokens], [{ sb_role: "main" }, { sb_role: "member" }], "a refused promotion changes nothing");
	await a.stop();
	await settle();
	assert.deepEqual(b.tokens, { sb_role: "member" }, "the owner left; the member is not made main");
	assert.match((await b.run())["straw-boss"]!, /no main agent yet/);
	assert.match(await b.promote(), /now the main agent/);
	assert.equal(state()?.main, "b");
});

test("a main that leaves while it was not the owner leaves the tab without a main", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wA:p2", tab: "wA:t1" });
	await Promise.all([a.start(), b.start()]);
	await b.promote();
	await b.stop();
	await settle();
	assert.deepEqual(a.tokens, { sb_role: "member" });
	assert.match((await a.run())["straw-boss"]!, /no main agent yet/);
});

test("a session restarted with old join entries joins as a member, and a recorded main that is still live keeps its role", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", entries: [{ customType: "straw-boss", data: { asked: true, joined: true } }] });
	await a.start();
	assert.deepEqual(a.tokens, { sb_role: "member" });
	await a.promote();
	const again = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", entries: [{ customType: "straw-boss", data: { asked: true, joined: true } }] });
	await again.start();
	assert.equal(state()?.main, "a");
});

test("a tab id over 24 characters fails fast with the reason", async () => {
	assert.equal(hex("wBB:t1"), "straw-boss/tab/7742423a7431");
	assert.match(hex("wBB:t1"), /^[a-z0-9][a-z0-9._/-]{0,63}$/);
	assert.doesNotMatch(hex("w".repeat(25)), /^[a-z0-9][a-z0-9._/-]{0,63}$/);
	world.herdr.addTab(`wA:t${"9".repeat(21)}`, "long", "wA:p77");
	const a = world.agent({ id: "a", pane: "wA:p77" });
	await a.start();
	await until(() => a.notices.some((n) => n.level === "error" && /too long for an intercom namespace/.test(n.text)), "the namespace error");
	assert.deepEqual(world.broker.registrations, []);
});

test("joining without pi-intercom, or on a broker without extension-bus-v1, fails with that reason and crashes nothing", async () => {
	const bare = world.agent({ id: "bare", pane: "wA:p1", tab: "wA:t1", noIntercom: true });
	await bare.start();
	await until(() => bare.notices.some((n) => n.level === "error" && /pi-intercom is not loaded/.test(n.text)), "bare reports why it cannot join");
	world.broker.supported = false;
	const old = world.agent({ id: "old", pane: "wA:p2", tab: "wA:t1" });
	await old.start();
	await until(() => old.notices.some((n) => n.level === "error" && /The intercom broker lacks extension-bus-v1/.test(n.text)), "old reports why it cannot join");
	world.broker.supported = true;
	world.broker.connected = false;
	const offline = world.agent({ id: "offline", pane: "wA:p3", tab: "wA:t1" });
	await offline.start();
	await until(() => offline.notices.some((n) => n.level === "error" && /pi-intercom is not connected/.test(n.text)), "offline reports why it cannot join");
	assert.deepEqual([old.tokens, [...old.tools.keys()], old.entries], [{}, [], []]);
	await offline.command();
	assert.ok(offline.notices.filter((n) => /pi-intercom is not connected/.test(n.text)).length >= 2, "/boss reports the same reason");
	assert.deepEqual(await offline.run(), {});
});

test("a join that failed at start is retried when the channel reports a connection, on the channel it already has", async () => {
	world.broker.connected = false;
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await until(() => a.notices.some((n) => n.level === "error" && /not connected/.test(n.text)), "the failed join");
	assert.deepEqual(a.tokens, {});
	world.broker.connected = true;
	a.regs.get(hex("wA:t1"))!.onEvent({ type: "connection", connected: true, supported: true });
	await until(() => a.tokens.sb_role === "member", "the retried join");
	assert.equal(world.broker.registrations.length, 1, "no second registration");
	assert.ok(a.tools.has("boss_promote"));
});

test("a join that failed and retries after its tab moved registers on the tab it is in now, and does not become a second main there", async () => {
	const main = world.agent({ id: "main", pane: "wA:p2", tab: "wA:t2" });
	await main.start();
	await main.promote();
	world.broker.connected = false;
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await until(() => a.notices.some((n) => n.level === "error" && /not connected/.test(n.text)), "the failed join");
	assert.equal(a.regs.has(hex("wA:t1")), true, "it registered on the first tab before failing");
	world.herdr.pane("wA:p1").tab_id = "wA:t2"; // the pane moved to the tab that has a main
	world.broker.connected = true;
	await a.toolCall("subagent"); // the retry, then the automatic promotion
	assert.equal(a.regs.has(hex("wA:t2")), true, "it re-registered on the current tab");
	assert.deepEqual([a.tokens, main.tokens], [{ sb_role: "member" }, { sb_role: "main" }], "one main in the tab");
	assert.equal(state("wA:t2")?.main, "main");
	assert.match(await a.promote(), /already has a main agent, main/);
	// The tab it left stays registered (intercom has no unregister) and this session may own that channel: it still decides that tab's claims,
	// so a member who arrives there can promote, and this session's own role is not touched.
	const late = world.agent({ id: "late", pane: "wA:p3", tab: "wA:t1" });
	await late.start();
	assert.equal(world.broker.owners.get(hex("wA:t1")), "a", "the session that left is still the owner of its first tab's channel");
	assert.match(await late.promote(), /now the main agent of tab work/);
	assert.equal(state("wA:t1")?.main, "late");
	assert.deepEqual([a.tokens, main.tokens, late.tokens], [{ sb_role: "member" }, { sb_role: "main" }, { sb_role: "main" }], "one main per tab");
	assert.equal(state("wA:t2")?.main, "main", "the tab it is in now is untouched");
});

test("a session whose join fails on a tab, again on another, and then back on the first reuses its first channel instead of registering twice", async () => {
	world.broker.connected = false;
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await until(() => a.notices.some((n) => /not connected/.test(n.text)), "the first failure");
	world.herdr.pane("wA:p1").tab_id = "wA:t2";
	await a.toolCall("subagent");
	assert.deepEqual(world.broker.registrations.map((r) => r.namespace), [hex("wA:t1"), hex("wA:t2")], "a second tab, a second registration; still not connected");
	world.herdr.pane("wA:p1").tab_id = "wA:t1";
	world.broker.connected = true;
	await a.toolCall("subagent");
	await until(() => a.tokens.sb_role === "main", "the join on the first tab again");
	assert.deepEqual(world.broker.registrations.map((r) => r.namespace), [hex("wA:t1"), hex("wA:t2")], "the first tab's channel was reused (a second registration of it would be refused by intercom)");
	assert.equal(state("wA:t1")?.main, "a");
});

test("what a session pinned as owner of the tab it left is not carried to the tab it joins, so it can promote there", async () => {
	world.broker.connected = false;
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await until(() => a.notices.some((n) => /not connected/.test(n.text)), "the failed join");
	world.broker.connected = true;
	const m = world.agent({ id: "m", pane: "wA:p3", tab: "wA:t1" });
	await m.start();
	assert.equal(world.broker.owners.get(hex("wA:t1")), "a", "the session whose join failed owns its first tab's channel");
	assert.match(await m.promote(), /now the main agent/);
	assert.equal(state("wA:t1")?.main, "m", "it decided the claim as that channel's owner, and pinned it");
	world.herdr.pane("wA:p1").tab_id = "wA:t2"; // the pane moved to an empty tab
	await a.toolCall("subagent"); // the retry, then the automatic promotion
	assert.equal(a.tokens.sb_role, "main", "the pin of the other tab's main does not make this tab look as if it had one");
	assert.equal(state("wA:t2")?.main, "a");
	assert.equal(state("wA:t1")?.main, "m");
});

