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
