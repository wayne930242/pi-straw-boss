import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { towerModel } from "../src/herdr.ts";
import { bare, settle, until, World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	mock.timers.reset();
	await world.stopAll();
	world = new World();
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");

async function main(id = "main-1", pane = "wA:p1", tab = "wA:t1") {
	const agent = world.agent({ id, pane, tab });
	await agent.start();
	await agent.promote();
	return agent;
}

test("call_tower with a live tower sends one outbox request and opens nothing", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const a = await main();
	const result = await a.tool("call_tower", { message: "port 3000 is taken" });
	assert.deepEqual(world.broker.delivered.map((d) => [d.from, d.to, bare(d.message)]), [["main-1", "tower-wA", "port 3000 is taken"]]);
	assert.equal(world.herdr.commands("tab", "create").length + world.herdr.commands("agent", "start").length, 0);
	assert.deepEqual(result.details, { workspace: "wA", towerId: "tower-wA", opened: false, status: "sent" });
});

test("call_tower without a tower opens a tower tab without focus, starts pi in it, and sends once the token appears", async () => {
	world.autoTowers();
	const a = await main();
	const result = await a.tool("call_tower", { message: "need the tower" });
	const [create] = world.herdr.commands("tab", "create");
	assert.deepEqual(create, ["tab", "create", "--workspace", "wA", "--label", "\u{f043b}", "--cwd", "/w/alpha", "--no-focus", "--env", "STRAW_BOSS_ROLE=tower"]);
	const [start] = world.herdr.commands("agent", "start");
	assert.deepEqual(start?.slice(0, 7), ["agent", "start", "tower-wa", "--kind", "pi", "--pane", world.herdr.panes.find((p) => p.tab_id === "wA:t100")?.pane_id]);
	assert.deepEqual(start?.slice(-2), ["--name", "tower · Alpha"]);
	assert.ok(world.herdr.calls.indexOf(create!) < world.herdr.calls.indexOf(start!), "tab create comes before agent start");
	const [delivery] = world.broker.delivered;
	assert.equal(delivery?.to, "tower-wA");
	assert.equal(JSON.parse(delivery!.tokens)[0], "tower-wA", "the message is sent only after the workspace token exists");
	assert.equal((result.details as { opened: boolean }).opened, true);
	assert.match(textOf(result), /opened it/);
	assert.deepEqual(world.herdr.commands("tab", "focus"), []);
});

test("the tower starts with the user's towerModel from config.json, and with pi's default model without one", async () => {
	world.autoTowers();
	writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, towerModel: " claude-bridge/claude-sonnet-5-5 " }));
	const a = await main();
	await a.tool("call_tower", { message: "need the tower" });
	assert.deepEqual(world.herdr.commands("agent", "start")[0]?.slice(-4), ["--name", "tower · Alpha", "--model", "claude-bridge/claude-sonnet-5-5"]);
	assert.equal(towerModel(join(world.stateDir, "missing")), undefined, "no config file means pi's default");
	writeFileSync(join(world.stateDir, "config.json"), "{ not json");
	assert.equal(towerModel(world.stateDir), undefined, "an unreadable file means pi's default");
});

test("a leftover tower tab with a shell prompt is reused: pi starts in its pane and no new tab opens", async () => {
	world.autoTowers();
	world.herdr.addTab("wA:t8", "tower", "wA:p8", "shell");
	world.herdr.pane("wA:p8").tokens.sb_role = "tower";
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
	assert.deepEqual(world.herdr.commands("agent", "start").map((args) => args[5] + " " + args[6]), ["--pane wA:p8"]);
	assert.equal(world.broker.delivered[0]?.to, "tower-wA");
});

test("a tab merely labelled tower (a subagent can be named so) is not a tower tab: a new one opens and the other is left alone", async () => {
	world.autoTowers();
	world.herdr.addTab("wA:t8", "tower", "wA:p8", "shell");
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	assert.equal(world.herdr.commands("tab", "create").length, 1, "its own tab was created");
	assert.ok(world.herdr.commands("agent", "start").every((args) => args[5] === "--pane" && args[6] !== "wA:p8"), "pi never started in the foreign tab");
	assert.deepEqual(world.herdr.pane("wA:p8").tokens, {});
	assert.ok(!world.herdr.moves.some((m) => m.tab_id === "wA:t8"));
});

test("a leftover tab with the tower glyph, no token and no agent is reused: marked, moved first, pi started in it, no new tab", async () => {
	world.autoTowers();
	world.herdr.addTab("wA:t8", "\u{f043b}", "wA:p8", "shell");
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
	assert.deepEqual(world.herdr.commands("agent", "start").map((args) => args[5] + " " + args[6]), ["--pane wA:p8"]);
	assert.ok(world.herdr.moves.some((m) => m.tab_id === "wA:t8" && m.insert_index === 0));
	assert.equal(world.broker.delivered[0]?.to, "tower-wA");
	assert.deepEqual(world.herdr.commands("tab", "focus"), []);
});

test("several leftover glyph tabs: one is reused and the other shell-only ones are closed", async () => {
	world.autoTowers();
	world.herdr.addTab("wA:t8", "\u{f043b}", "wA:p8", "shell");
	world.herdr.addTab("wA:t9", "\u{f043b}", "wA:p9", "shell");
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
	assert.deepEqual(world.herdr.commands("agent", "start").map((args) => args[6]), ["wA:p8"]);
	assert.deepEqual(world.herdr.closed, ["wA:t9"]);
});

test("a glyph tab that runs an agent or holds other panes is not a leftover: it is never typed into and a new tab opens", async () => {
	world.autoTowers();
	world.herdr.addTab("wA:t8", "\u{f043b}", "wA:p8", "pi");
	world.herdr.addTab("wA:t9", "\u{f043b}", "wA:p9", "shell");
	world.herdr.addPane("wA:p10", "wA:t9", "shell");
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	assert.equal(world.herdr.commands("tab", "create").length, 1);
	assert.ok(world.herdr.commands("agent", "start").every((args) => !["wA:p8", "wA:p9", "wA:p10"].includes(args[6]!)));
	assert.deepEqual(world.herdr.closed, []);
});

test("a tower that quits closes its own pane, which closes a tab it emptied", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await tower.stop();
	assert.deepEqual(world.herdr.closed, ["wA:p7"]);
	assert.deepEqual(world.herdr.panes.filter((p) => p.tab_id === "wA:t7"), []);
	assert.ok(!world.herdr.tabs.some((t) => t.tab_id === "wA:t7"));
	assert.deepEqual(world.herdr.workspace("wA").tokens, { sb_tower_quit: "0" }, "the token goes, and the quit says so with the members it leaves: the mains are cleared at once");
});

test("reload, new, resume and fork keep the tower's tab", async () => {
	for (const reason of ["reload", "new", "resume", "fork"]) {
		const tower = world.tower(`tower-${reason}`, `wA:t7${reason}`, `wA:p7${reason}`);
		await tower.start();
		await tower.fire("session_shutdown", { reason });
		assert.deepEqual(world.herdr.closed, [], reason);
	}
});

test("a tower that quits closes its pane but leaves the other panes of its tab", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	world.herdr.addPane("wA:p77", "wA:t7", "shell");
	await tower.stop();
	assert.deepEqual(world.herdr.closed, ["wA:p7"]);
	assert.ok(world.herdr.panes.some((p) => p.pane_id === "wA:p77"));
});

test("a new tower tab is marked as a tower tab right after it is created, before pi starts in it", async () => {
	world.autoTowers();
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	const create = world.herdr.commands("tab", "create")[0]!;
	const marks = world.herdr.commands("pane", "report-metadata").filter((args) => args.includes("sb_role=tower"));
	const start = world.herdr.commands("agent", "start")[0]!;
	assert.ok(marks.length >= 1);
	assert.ok(world.herdr.calls.indexOf(create) < world.herdr.calls.indexOf(marks[0]!) && world.herdr.calls.indexOf(marks[0]!) < world.herdr.calls.indexOf(start));
});

test("a leftover tab that already runs pi is only waited on, and a tower that never publishes fails with the pane", async () => {
	world.herdr.addTab("wA:t8", "tower", "wA:p8", "pi");
	world.herdr.pane("wA:p8").tokens.sb_role = "tower";
	const a = await main();
	await assert.rejects(a.tool("call_tower", { message: "hi" }), /did not publish its token within 60 s \(pane wA:p8\)/);
	assert.deepEqual(world.herdr.commands("agent", "start"), []);
	assert.deepEqual(world.broker.delivered, []);
});

test("a failing agent start reports the herdr command and its pane, and is not retried", async () => {
	world.herdr.onAgentStart = () => {
		throw new Error("herdr agent start failed: readiness timeout");
	};
	const a = await main();
	await assert.rejects(a.tool("call_tower", { message: "hi" }), /readiness timeout/);
	assert.equal(world.herdr.commands("agent", "start").length, 1);
});

test("a new tab whose shell is not at its prompt yet is retried until herdr accepts the start", async () => {
	world.autoTowers();
	world.herdr.busy = 2;
	const a = await main();
	await a.tool("call_tower", { message: "hi" });
	assert.equal(world.herdr.commands("agent", "start").length, 3, "two busy answers, then the start");
	assert.equal(world.broker.delivered[0]?.to, "tower-wA");
});

test("an adopted glyph tab whose shell stays busy gives its tower token back, so the next open does not count it as the tower", async () => {
	world.herdr.addTab("wA:t8", "\u{f043b}", "wA:p8", "shell");
	world.herdr.busy = 1000;
	const a = await main();
	await assert.rejects(a.tool("call_tower", { message: "hi" }), /agent_pane_busy/);
	assert.equal(world.herdr.pane("wA:p8").tokens.sb_role, undefined);
	assert.deepEqual(world.herdr.commands("tab", "close"), [], "the user's tab stays");
});

test("a shell that never becomes available fails with the busy answer and its pane", async () => {
	world.herdr.busy = 1000;
	const a = await main();
	await assert.rejects(a.tool("call_tower", { message: "hi" }), /agent_pane_busy.*--pane|--pane.*agent_pane_busy/s);
});

test("two callers racing to open the tower open one tab", async () => {
	world.autoTowers();
	const a = await main("a", "wA:p1", "wA:t1");
	const b = await main("b", "wA:p2", "wA:t2");
	await Promise.all([a.tool("call_tower", { message: "from a" }), b.tool("call_tower", { message: "from b" })]);
	assert.equal(world.herdr.commands("tab", "create").length, 1);
	assert.deepEqual(world.broker.delivered.map((d) => d.to), ["tower-wA", "tower-wA"]);
});

test("the tower registers its tab channel as not owner-eligible, writes both tokens, and keeps its role from the entry on resume", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	assert.deepEqual(world.broker.registrations.map((r) => [r.id, r.namespace.split("/").slice(0, 2).join("/"), r.ownerEligible]), [["tower-wA", "straw-boss/tab", false], ["tower-wA", "straw-boss/control", false]], "its tab channel, and the control channel a main it opened answers on");
	assert.deepEqual([tower.tokens, world.herdr.workspace("wA").tokens], [{ sb_role: "tower" }, { tower: "tower-wA" }]);
	assert.deepEqual([...tower.tools.keys()].sort(), ["board_read", "boss_broadcast", "boss_close_main", "boss_open_main", "boss_status", "call_tower", "link_request", "tower_list", "tower_send"]);
	assert.deepEqual(tower.entries, [{ customType: "straw-boss", data: { tower: true, workspaceId: "wA" } }]);
	assert.match((await tower.run())["straw-boss"]!, /^You are the tower of Herdr workspace Alpha;/);

	world.herdr.addTab("wB:t7", "tower", "wB:p7");
	const resumed = world.agent({ id: "tower-wB", pane: "wB:p7", entries: [{ customType: "straw-boss", data: { tower: true, workspaceId: "wB" } }] });
	await resumed.start();
	assert.equal(world.herdr.workspace("wB").tokens.tower, "tower-wB");
	const prompt = (await resumed.run())["straw-boss"]!;
	assert.match(prompt, /^You are the tower of Herdr workspace Beta;/);
	assert.match(prompt, /head tower, the tower of workspace Alpha/);
	assert.equal(resumed.entries.length, 1, "no second role entry on resume");
});

test("a second tower yields: the lower tab id wins a race, and its tab closes before it publishes", async () => {
	const first = world.tower("first", "wA:t5", "wA:p5");
	const second = world.tower("second", "wA:t9", "wA:p9");
	await Promise.all([first.start(), second.start()]);
	await settle();
	assert.deepEqual(world.herdr.closed, ["wA:t9"]);
	assert.equal(world.herdr.workspace("wA").tokens.tower, "first");
	assert.ok(!world.herdr.wsTokenHistory.includes("second"), "the yielding tower never wrote the workspace token");
	assert.equal(second.stopped, true);
	assert.equal(world.herdr.workspace("wA").tokens.tower, "first", "its shutdown left the holder's token alone");
});

test("an existing token holder wins even when the newcomer has the lower tab id", async () => {
	const old = world.tower("old", "wA:t9", "wA:p9");
	await old.start();
	const fresh = world.tower("fresh", "wA:t5", "wA:p5");
	await fresh.start();
	await settle();
	assert.deepEqual(world.herdr.closed, ["wA:t5"]);
	assert.equal(world.herdr.workspace("wA").tokens.tower, "old");
});

test("session_shutdown stops the refresh timer and clears this session's tokens, idempotently", async () => {
	mock.timers.enable({ apis: ["setInterval"] });
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	world.herdr.calls.length = 0;
	mock.timers.tick(4 * 60_000);
	await settle();
	assert.equal(world.herdr.commands("pane", "report-metadata").length, 1, "tokens refresh every 4 minutes");
	assert.equal(world.herdr.commands("workspace", "report-metadata").length, 1);
	assert.ok(world.herdr.commands("pane", "report-metadata")[0]?.includes("--ttl-ms"));

	await tower.fire("session_shutdown");
	await tower.fire("session_shutdown");
	assert.deepEqual([tower.tokens, world.herdr.workspace("wA").tokens], [{}, {}]);
	world.herdr.calls.length = 0;
	mock.timers.tick(8 * 60_000);
	await settle();
	assert.deepEqual(world.herdr.calls, [], "no refresh after shutdown");
});

test("boss_status names the main agent of each tab, this workspace's tower, and marks the head tower", async () => {
	const towerA = world.tower("tower-wA", "wA:t7", "wA:p7");
	const towerB = world.tower("tower-wB", "wB:t7", "wB:p7");
	await Promise.all([towerA.start(), towerB.start()]);
	const a = await main("a", "wA:p1", "wA:t1");
	const b = await main("b", "wA:p2", "wA:t1");
	const status = (await a.tool("boss_status")).details as Record<string, any>;
	assert.deepEqual(status.me, { id: "a", role: "main" });
	assert.deepEqual(status.tabs, [{ id: "wA:t1", label: "work", main: "a", sessions: 2 }]);
	assert.equal(status.head, "wA");
	assert.deepEqual([status.tower.id, status.tower.head, status.towers.map((t: any) => [t.id, t.head])], ["tower-wA", true, [["tower-wB", false]]]);
	assert.equal(((await b.tool("boss_status")).details as any).me.role, "member");
	const fromB = (await towerB.tool("boss_status")).details as Record<string, any>;
	assert.deepEqual([fromB.me.role, fromB.tower.head, fromB.towers.map((t: any) => [t.id, t.head])], ["tower", false, [["tower-wA", true]]]);
});

test("call_tower resolves a workspace by id or exact label; towers reach the head tower; ambiguity and self-calls are errors", async () => {
	const towerA = world.tower("tower-wA", "wA:t7", "wA:p7");
	const towerB = world.tower("tower-wB", "wB:t7", "wB:p7");
	await Promise.all([towerA.start(), towerB.start()]);
	const a = await main();
	await a.tool("call_tower", { message: "by label", workspace: "Beta" });
	await a.tool("call_tower", { message: "by id", workspace: "wB" });
	await towerB.tool("call_tower", { message: "to the head tower", workspace: "Alpha" });
	assert.deepEqual(world.broker.delivered.map((d) => [d.to, bare(d.message)]), [["tower-wB", "by label"], ["tower-wB", "by id"], ["tower-wA", "to the head tower"]]);
	await assert.rejects(towerA.tool("call_tower", { message: "me" }), /tower of that workspace/);
	await assert.rejects(a.tool("call_tower", { message: "x", workspace: "Gamma" }), /No workspace matches "Gamma"\. Workspaces: wA \(Alpha\), wB \(Beta\)/);
	world.herdr.workspaces.push({ workspace_id: "wC", label: "Beta", tokens: {}, worktree: undefined } as never);
	await assert.rejects(a.tool("call_tower", { message: "x", workspace: "Beta" }), /Several workspaces match "Beta"/);
	world.broker.failing.add("tower-wA");
	await assert.rejects(a.tool("call_tower", { message: "x" }), /did not take the message: failed delivery_failed/);
});

test("/boss tower opens the workspace tower by hand and focuses its tab, call_tower from a member opens nothing; /boss status shows the coordinators", async () => {
	world.autoTowers();
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.command("status");
	assert.match(a.notices.at(-1)!.text, /"role": "member"/);
	await assert.rejects(a.tool("call_tower", { message: "x" }), /no tower yet/, "call_tower from a member opens no tower");
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
	await a.command("tower");
	await until(() => world.herdr.commands("tab", "focus").length === 1, "tab focus");
	assert.deepEqual(world.herdr.commands("tab", "focus"), [["tab", "focus", "wA:t100"]]);
	await a.command("status");
	assert.match(a.notices.at(-1)!.text, /"tower-wA"/);
	const tower = world.agents.find((x) => x.id === "tower-wA")!;
	await tower.command();
	assert.equal(tower.notices.at(-1)?.text, "This session is the tower, not a main agent");
});

test("a tower waits for intercom to connect before it writes any token, as a freshly started pi does", async () => {
	world.broker.connected = false;
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual([tower.tokens, world.herdr.workspace("wA").tokens], [{}, {}], "nothing is published before intercom connects");
	world.broker.connected = true;
	await until(() => world.herdr.workspace("wA").tokens.tower, "the tower token");
	await world.quiet();
	assert.deepEqual([tower.tokens, world.herdr.workspace("wA").tokens], [{ sb_role: "tower" }, { tower: "tower-wA" }]);
});

test("a tower that never gets intercom reports the reason and leaves no token behind", async () => {
	world.broker.connected = false;
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	await until(() => tower.notices.length, "the connection failure notice");
	assert.deepEqual([tower.tokens, world.herdr.workspace("wA").tokens], [{}, {}]);
	assert.deepEqual(tower.notices, [{ text: "Straw Boss: pi-intercom is not connected", level: "error" }]);
});

test("session_start returns at once, so pi-intercom's own session_start is not held up behind it", async () => {
	world.broker.connected = false;
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	const rejoining = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1", entries: [{ customType: "straw-boss", data: { asked: true, joined: true } }] });
	for (const agent of [tower, rejoining]) {
		const begun = Date.now();
		await agent.fire("session_start");
		assert.ok(Date.now() - begun < 100, `${agent.id} held session_start for ${Date.now() - begun} ms`);
	}
	await world.quiet();
});

test("towers of different workspaces start under different lowercase Herdr agent names", async () => {
	world.autoTowers();
	const a = await main("a", "wA:p1", "wA:t1");
	const b = await main("b", "wB:p1", "wB:t1");
	await a.tool("call_tower", { message: "from a" });
	await b.tool("call_tower", { message: "from b" });
	assert.deepEqual(world.herdr.commands("agent", "start").map((args) => args[2]), ["tower-wa", "tower-wb"]);
	assert.deepEqual(world.broker.delivered.map((d) => d.to), ["tower-wA", "tower-wB"]);
});

// D19 (docs/specs/2026-10-26-sb-backend.md, Wake triggers): a main calls the tower for a milestone, before it touches something shared, or when it is blocked, and the code-written header says which.

const headerOf = (message: string) => /^\[straw net [^\]]*\]/.exec(message)?.[0] ?? "";

test("D19: call_tower requires why (milestone, shared, or blocked) in pi's tool, and the header carries it", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const a = await main();
	const schema = a.tools.get("call_tower")!.parameters as { required?: string[]; properties: Record<string, { anyOf?: { const: string }[] }> };
	assert.ok(schema.required?.includes("why"), "why is required");
	assert.deepEqual(schema.properties.why!.anyOf?.map((x) => x.const), ["milestone", "shared", "blocked"]);
	for (const why of ["milestone", "shared", "blocked"]) await a.tool("call_tower", { message: `m ${why}`, why, reply: why !== "milestone" });
	assert.deepEqual(world.broker.delivered.map((d) => /reply=(\w+) why=(\w+)\]$/.exec(headerOf(d.message))?.slice(1)), [["none", "milestone"], ["expected", "shared"], ["expected", "blocked"]]);
});

test("D19: a call_tower without why (an older caller, a run's tool) is sent with why=unspecified, and a word outside the set is refused", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const a = await main();
	await a.tool("call_tower", { message: "no reason given" });
	assert.match(headerOf(world.broker.delivered[0]!.message), / reply=expected why=unspecified\]$/);
	await assert.rejects(a.tool("call_tower", { message: "x", why: "progress" }), /why/);
	assert.equal(world.broker.delivered.length, 1, "nothing went out for the refused word");
});
