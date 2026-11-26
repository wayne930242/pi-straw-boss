import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { opener, OpenLimitError } from "../src/opener.ts";
import { until, World } from "./fakes.ts";

// The opener's worker (docs/specs/2026-11-26-ally-workers.md, Device side): a tab in the worktree with `--model`, kind worker from its claim, the handoff with the brief verbatim, outside the mains' limits by its route's witness, and refused without a peer.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const handed: { to: string; message: string }[] = [];
const PEER = { id: "link:dev123", label: "mac", short: "dev123" };
const WORKER = { dir: "/w/alpha-wt/feat-x", branch: "feat/x", base: "origin/develop", model: "openai-codex/gpt-6.2-astra", points: 2, label: "MP-1" };
const open = (workerPanes: Set<string> = new Set()) => opener({
	run: world.herdr.runFor("wA:p7"), sleep: (ms) => sleep(Math.min(ms, 2)), workspaceId: "wA", cwd: "/w/alpha", sessions: () => world.broker.sessionList() as never,
	send: async (to, message) => (handed.push({ to, message }), { status: "sent" }), tower: () => ({ id: "tower-wA", name: "tower · wA" }), stateDir: world.stateDir, workerPanes: () => workerPanes,
});

test("a worker opens in its worktree with --model and kind worker, the brief verbatim in its handoff, and two opened mains of its sender do not stop it", async () => {
	handed.length = 0;
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	world.autoMains();
	const o = open(new Set());
	const first = await o({ request: "brief one", sender: PEER.id, peer: PEER, role: "worker", worker: { ...WORKER } });
	const second = await open(new Set([first.pane]))({ request: "brief two", sender: PEER.id, peer: PEER, role: "worker", worker: { ...WORKER, branch: "feat/y", dir: "/w/alpha-wt/feat-y" } });
	const creates = world.herdr.commands("tab", "create");
	assert.deepEqual(creates.map((c) => c[c.indexOf("--cwd") + 1]), ["/w/alpha-wt/feat-x", "/w/alpha-wt/feat-y"]);
	const start = world.herdr.commands("agent", "start")[0]!;
	assert.deepEqual(start.slice(-4), ["--name", "worker · MP-1", "--model", "openai-codex/gpt-6.2-astra"]);
	await until(() => world.herdr.pane(first.pane).tokens.sb_duty === "worker", "the opened pi runs as a worker");
	assert.equal(world.herdr.pane(first.pane).tokens.sb_opened_by, PEER.id);
	const h = handed.find((x) => x.to === first.main)!.message;
	assert.match(h, /Work in \/w\/alpha-wt\/feat-x on branch feat\/x only \(started from origin\/develop\)/);
	assert.ok(h.endsWith("Brief, verbatim:\nbrief one"));
	assert.notEqual(second.main, first.main);
	await assert.rejects(open(new Set())({ request: "a main", sender: PEER.id, peer: PEER }), /already has/, "without the routes' witness the worker panes would count as its opened mains");
	const main = await open(new Set([first.pane, second.pane]))({ request: "a main", sender: PEER.id, peer: PEER });
	assert.ok(main.main, "the workers take none of the mains' places");
	const agent = world.agents.find((a) => a.id === first.main)!;
	assert.match((await agent.run())["straw-boss"] ?? "", /## Kind: worker/, "its prompt is worker.md");
	await assert.rejects(agent.tool("boss_duty", { duty: "coordinator", reason: "switch" }), /A worker's kind is fixed/);
	await assert.rejects(agent.tool("boss_wrap", { summary: "done" }), /A worker ends with its one call_tower/);
});

test("role worker without a peer or with a duty, and duty worker alone, open nothing", async () => {
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	const o = open();
	await assert.rejects(o({ request: "x", sender: "sender-1", role: "worker", worker: { ...WORKER } }), OpenLimitError);
	await assert.rejects(o({ request: "x", sender: PEER.id, peer: PEER, role: "worker" }), OpenLimitError);
	await assert.rejects(o({ request: "x", sender: PEER.id, peer: PEER, duty: "worker" }), /duty must be/);
	assert.equal(world.herdr.commands("tab", "create").length, 0);
});

test("a resume starts pi --session <file> with no --name (and --model only when given), refuses a pi that joins as another session or a twin pane on the file, and closes its tab then", async () => {
	handed.length = 0;
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	const SID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", file = "/s/--wt--/x_0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl";
	let joinAs = SID;
	world.herdr.onAgentStart = (pane) => void world.agent({ id: joinAs, name: "worker", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "main" } }).start();
	const resume = (model?: string) => open()({ request: "follow-up", sender: PEER.id, peer: PEER, role: "worker", worker: { ...WORKER, resume: { file, session: SID, came: "the worktree was kept on the box", ...(model ? { model } : {}) } } });
	const first = await resume();
	assert.deepEqual(world.herdr.commands("agent", "start").at(-1)!.slice(-2), ["--session", file]);
	assert.ok(handed.at(-1)!.message.endsWith("Follow-up, verbatim:\nfollow-up"));
	assert.match(handed.at(-1)!.message, /the worktree was kept on the box/);
	await world.herdr.runFor("wA:p7")(["tab", "close", first.tab]);
	for (const a of world.agents.filter((x) => x.id === SID)) await a.stop();
	await resume("m/x");
	assert.deepEqual(world.herdr.commands("agent", "start").at(-1)!.slice(-4), ["--session", file, "--model", "m/x"]);
	for (const a of world.agents.filter((x) => x.id === SID)) await a.stop();
	joinAs = "0199a1b2-0000-7000-8000-000000000009";
	const tabs = world.herdr.commands("tab", "close").length;
	await assert.rejects(resume(), /joined as session 0199a1b2, not 0199a1b2: it is no resume of that worker/);
	assert.equal(world.herdr.commands("tab", "close").length, tabs + 1, "its tab was closed");
	for (const a of world.agents) await a.stop();
	joinAs = SID;
	world.herdr.addTab("wA:t90", "busy", "wA:p90");
	world.herdr.pane("wA:p90").agent_session = { value: file };
	await assert.rejects(resume(), /another pane runs this session file now/);
});
