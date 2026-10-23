import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { agentFiles, ask, liveHeld } from "../src/agent/paths.ts";
import { type AgentDeps, type Sidecar, startSidecar } from "../src/agent/sidecar.ts";
import { netMembers } from "../src/reach.ts";
import { FakeClient } from "./agent-fakes.ts";
import { until, World } from "./fakes.ts";

let world = new World();
const started: Sidecar[] = [], scratch: string[] = [];
afterEach(async () => {
	for (const sidecar of started.splice(0)) await sidecar.stop("test over");
	await world.stopAll();
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
	world = new World();
});
const SESSION = "085ff3b1-aaaa-bbbb-cccc-111122223333";
const fast = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2)));

/** A Claude Code pane in tab wA:t1 and the sidecar that is its presence in the net. */
async function claude(over: { pane?: string; session?: string; record?: string; kind?: "claude" | "codex"; deps?: AgentDeps; wait?: boolean } = {}) {
	const pane = over.pane ?? "wA:p3", clients: FakeClient[] = [], log: string[] = [];
	if (!world.herdr.panes.some((p) => p.pane_id === pane)) Object.assign(world.herdr.addPane(pane, "wA:t1", over.kind ?? "claude"), { agent_status: "idle" });
	const sidecar = await startSidecar({
		pane, kind: over.kind ?? "claude", session: over.session ?? SESSION, record: over.record, cli: "/x/straw-net.py",
		deps: { run: world.herdr.runFor(pane), api: world.herdr.api, events: world.herdr.events, watch: world.watch, stateDir: world.stateDir, sleep: fast, autoTower: false, pollMs: 150, recordMs: 10, log: (line) => log.push(line), connect: () => (clients[clients.push(new FakeClient(world.broker, pane)) - 1]!), ...over.deps },
	});
	started.push(sidecar);
	if (over.wait !== false) await sidecar.ready;
	await world.quiet();
	return { sidecar, clients, log, pane };
}
const roleOf = (pane: string) => world.herdr.pane(pane).tokens.sb_role;
const lines = () => world.broker.delivered;

test("a sidecar joins its tab as a member beside a pi, with the tokens, the name, and the digest line of a pi member", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	const { sidecar } = await claude();
	assert.equal(sidecar.id, `claude-${SESSION}`);
	assert.equal(sidecar.name, "claude-085ff3b1");
	const members = netMembers(await world.broker.sessionList() as never, world.herdr.panes as never);
	assert.deepEqual(members.map((m) => [m.s.id, m.role, m.tab.label]).sort(), [["a", "member", "work"], [sidecar.id, "member", "work"]]);
	const tokens = world.herdr.pane("wA:p3").tokens;
	assert.equal(tokens.sb_role, "member");
	assert.ok(tokens.sb_order && tokens.sb_mark && tokens.sb_tab === "work", JSON.stringify(tokens));
	assert.ok(Object.entries(world.herdr.workspace("wA").tokens).some(([k, v]) => k.startsWith("sbd_") && v.endsWith("claude-085ff3b1 joined tab work")), JSON.stringify(world.herdr.workspace("wA").tokens));
	const held = liveHeld(agentFiles(world.stateDir, "wA:p3"));
	assert.deepEqual([held?.session, held?.kind, held?.id, held?.pid], [SESSION, "claude", sidecar.id, process.pid]);
	assert.deepEqual(world.broker.registrations.filter((r) => r.id === sidecar.id).map((r) => [r.namespace.split("/").slice(0, 2).join("/"), r.ownerEligible]), [["straw-boss/tab", true]], "only the tab channel, owner-eligible: no GUI channel, so no GUI takeover can pick it");
	assert.equal(existsSync(join(world.stateDir, "gui.json")), false, "it hosts no GUI server");
});

test("variables a pi session sets in the inherited environment do not make the sidecar a tower or give it another id", async () => {
	const { sidecar } = await claude({ deps: { env: { PI_INTERCOM_SESSION_ID: "someone-else", PI_SUBAGENT_ID: "sub", STRAW_BOSS_ROLE: "tower", HERDR_PANE_ID: "wA:p3" } } });
	assert.equal(sidecar.id, `claude-${SESSION}`);
	assert.equal(roleOf("wA:p3"), "member");
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined);
});

test("a pane in a sub workspace never joins: the sidecar says so and leaves", async () => {
	world.herdr.workspace("wA").worktree = { checkout_path: "/w/alpha", is_linked_worktree: true, repo_key: "/r/alpha" };
	const { sidecar, log } = await claude({ wait: false });
	await assert.rejects(sidecar.ready, /Alpha is a sub workspace/);
	await sidecar.done;
	assert.deepEqual(world.broker.registrations, []);
	assert.equal(roleOf("wA:p3"), undefined);
	assert.equal(existsSync(agentFiles(world.stateDir, "wA:p3").state), false);
	assert.ok(log.some((l) => /sub workspace/.test(l)));
});

test("a second sidecar for a pane that has one is refused, and a state file of a dead process does not hold the pane", async () => {
	await claude();
	await assert.rejects(claude({ session: "other-session-id" }), /already held/);
	const files = agentFiles(world.stateDir, "wA:p4");
	world.herdr.addPane("wA:p4", "wA:t1", "claude");
	writeFileSync(files.state, JSON.stringify({ pid: 2 ** 22 + 1, session: "dead", kind: "claude", pane: "wA:p4", id: "claude-dead", name: "x", startedAt: 0 }));
	const { sidecar } = await claude({ pane: "wA:p4", session: "fresh-session-id" });
	assert.equal(liveHeld(files)?.session, "fresh-session-id");
	assert.equal(roleOf("wA:p4"), "member");
	await sidecar.stop("done");
});

test("the orchestrator record promotes the sidecar when it appears or changes, and a tab that has a live main refuses it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-record-"));
	scratch.push(dir);
	const record = join(dir, `claude-${SESSION}.json`);
	const { sidecar, log } = await claude({ record });
	assert.equal(roleOf("wA:p3"), "member");
	writeFileSync(record, "{}");
	await until(() => roleOf("wA:p3") === "main", "the main role");
	assert.equal(((await sidecar.request({ cmd: "status" })) as unknown as { me: { role: string } }).me.role, "main");
	// A tab with a main already: another sidecar's record changes and it stays a member.
	const other = await claude({ pane: "wA:p5", session: "second-session-id", record: join(dir, "second.json") });
	writeFileSync(join(dir, "second.json"), "{}");
	await until(() => other.log.some((l) => /already has a main agent/.test(l)), "the refusal in the log");
	assert.equal(roleOf("wA:p5"), "member");
	// A changed mtime promotes again only when the sidecar is a member (here it is not): nothing breaks.
	utimesSync(record, new Date(), new Date(Date.now() + 5000));
	await world.quiet();
	assert.equal(roleOf("wA:p3"), "main");
	assert.ok(!log.some((l) => /error/i.test(l)), log.join("\n"));
});

test("a record that was there before the sidecar started promotes nothing until it changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-record-"));
	scratch.push(dir);
	const record = join(dir, "r.json");
	writeFileSync(record, "{}");
	await claude({ record });
	await world.quiet();
	assert.equal(roleOf("wA:p3"), "member");
	utimesSync(record, new Date(), new Date(Date.now() + 5000));
	await until(() => roleOf("wA:p3") === "main", "the main role after the change");
});

test("a sidecar that owns the tab channel decides a pi's claim and records the main", async () => {
	const { sidecar } = await claude();
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	assert.equal(world.broker.owners.get(world.broker.registrations.find((r) => r.id === sidecar.id)!.namespace), sidecar.id, "the sidecar registered first and owns the channel");
	assert.match(await a.promote(), /now the main agent/);
	assert.equal(a.tokens.sb_role, "main");
	assert.equal(roleOf("wA:p3"), "member");
	const state = [...world.broker.states.values()][0]?.payload as { main?: string };
	assert.equal(state.main, "a");
});

test("a message sent to the sidecar is typed into its pane as one straw net line, once, and a blocked pane holds it until Herdr says otherwise", async () => {
	const a = world.agent({ id: "a", name: "Pi One", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	const { sidecar } = await claude();
	const send = (text: string, requestId = `r-${Math.random()}`) => world.broker.outbox(a, { requestId, to: sidecar.id, message: text });
	send("hello\n  there\u001b[31m you");
	await until(() => world.herdr.prompts.length === 1, "the prompt");
	const [typed] = world.herdr.prompts;
	assert.equal(typed?.pane, "wA:p3");
	assert.equal(typed?.text, `[straw net from="Pi One" id=a role=member reply="/x/straw-net.py send --to a --message '…'"] hello there [31m you`);
	assert.deepEqual(typed?.args, ["--wait", "--until", "working", "--until", "blocked", "--timeout", "8000"]);
	// Working: a plain submission, no gate (the provider queues it).
	world.herdr.pane("wA:p3").agent_status = "working";
	send("while working");
	await until(() => world.herdr.prompts.length === 2, "the second prompt");
	assert.deepEqual(world.herdr.prompts[1]?.args, []);
	// Blocked: held, in order.
	world.herdr.pane("wA:p3").agent_status = "blocked";
	send("first held");
	send("second held");
	await world.quiet();
	assert.equal(world.herdr.prompts.length, 2);
	world.herdr.pane("wA:p3").agent_status = "idle";
	world.herdr.emit("pane.agent_status_changed", "pane_agent_status_changed", { pane_id: "wA:p3", agent_status: "idle" });
	await until(() => world.herdr.prompts.length === 4, "the held prompts");
	assert.deepEqual(world.herdr.prompts.slice(2).map((p) => p.text.replace(/^.*\] /, "")), ["first held", "second held"]);
});

test("the sender's role is read from its pane: a tower is a tower, a session outside the net is a session; a repeated message id is typed once", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const { sidecar, clients } = await claude();
	world.broker.outbox(tower, { requestId: "t1", to: sidecar.id, message: "from above" });
	await until(() => world.herdr.prompts.length === 1, "the prompt");
	assert.match(world.herdr.prompts[0]!.text, /^\[straw net from="tower · tower-wA" id=tower-wA role=tower reply=/);
	for (let i = 0; i < 2; i++) clients[0]!.emit("message", { id: "cli-1", name: "cli" }, { id: "dup", content: { text: "again" } });
	await world.quiet();
	assert.match(world.herdr.prompts.at(-1)!.text, /^\[straw net from=cli id=cli-1 role=session reply=/);
	assert.equal(world.herdr.prompts.filter((p) => p.text.endsWith("] again")).length, 1);
});

test("when the pane's agent is gone the sidecar clears its tokens, then leaves the broker, and removes its files", async () => {
	const { sidecar, clients, log } = await claude();
	const seen: (string | undefined)[] = [];
	const disconnect = clients[0]!.disconnect.bind(clients[0]);
	clients[0]!.disconnect = async () => (seen.push(roleOf("wA:p3")), disconnect());
	world.herdr.pane("wA:p3").agent = undefined;
	world.herdr.emit("pane.updated", "pane_updated", { pane_id: "wA:p3" });
	await sidecar.done;
	assert.deepEqual(seen, [undefined], "no role token is left when the broker hears the sidecar go");
	assert.equal(world.broker.sessions.has(sidecar.id), false);
	assert.deepEqual(world.herdr.pane("wA:p3").tokens, {});
	assert.equal(existsSync(agentFiles(world.stateDir, "wA:p3").state), false);
	assert.ok(log.some((l) => /left: the pane no longer runs claude/.test(l)), log.join("\n"));
});

test("a pane that closes, a pane whose agent is another one, and an agent that is only not detected yet are told apart", async () => {
	const closing = await claude({ pane: "wA:p8" });
	world.herdr.runFor("wA:p8")(["pane", "close", "wA:p8"]);
	await closing.sidecar.done;
	assert.equal(world.broker.sessions.has(closing.sidecar.id), false);
	const swapped = await claude({ pane: "wA:p9", session: "swapped-session-id" });
	world.herdr.pane("wA:p9").agent = "codex";
	world.herdr.emit("pane.agent_detected", "pane_agent_detected", { pane_id: "wA:p9", workspace_id: "wA", agent: "codex" });
	await swapped.sidecar.done;
	// Not detected yet at the start: the sidecar waits for the agent to show.
	world.herdr.addPane("wA:p10", "wA:t1", "shell");
	const early = await claude({ pane: "wA:p10", session: "early-session-id", deps: { graceMs: 10_000 } });
	await world.quiet();
	assert.equal(world.broker.sessions.has(early.sidecar.id), true);
	world.herdr.pane("wA:p10").agent = "claude";
	world.herdr.emit("pane.agent_detected", "pane_agent_detected", { pane_id: "wA:p10", workspace_id: "wA", agent: "claude" });
	await world.quiet();
	world.herdr.pane("wA:p10").agent = undefined;
	world.herdr.emit("pane.updated", "pane_updated", { pane_id: "wA:p10" });
	await early.sidecar.done;
});

test("control: status, promote, rename, send, and stop reach the sidecar's modules", async () => {
	const a = world.agent({ id: "a", name: "Pi One", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.promote();
	const { sidecar } = await claude();
	const status = (await sidecar.request({ cmd: "status" })) as { ok: true; me: { id: string; role: string }; tabs: { main: string | null; sessions: number }[] };
	assert.deepEqual([status.me, status.tabs[0]?.main, status.tabs[0]?.sessions], [{ id: sidecar.id, role: "member" }, "a", 2]);
	const refused = await sidecar.request({ cmd: "promote" });
	assert.equal(refused.ok, false);
	assert.match((refused as { error: string }).error, /already has a main agent, Pi One/);
	const renamed = await sidecar.request({ cmd: "rename", name: "MP-3584 cost mask" });
	assert.equal(renamed.ok, true);
	await until(() => Object.values(world.herdr.workspace("wA").tokens).some((v) => /renamed itself "MP-3584 cost mask"/.test(v)), "the digest line");
	assert.equal((await world.broker.sessionList()).find((s) => s.id === sidecar.id)?.name, "MP-3584 cost mask");
	assert.equal(((await sidecar.request({ cmd: "rename", name: "  " })) as { error: string }).error, "The name is empty");
	const sent = await sidecar.request({ cmd: "send", to: "a", message: "ping" });
	assert.equal(sent.ok, true);
	assert.deepEqual(lines().filter((l) => l.from === sidecar.id).map((l) => [l.to, l.message]), [["a", "ping"]]);
	const lost = await sidecar.request({ cmd: "send", to: "nobody", message: "x" });
	assert.equal(lost.ok, false);
	assert.match((lost as { error: string }).error, /target_not_found/);
	assert.equal(((await sidecar.request({ cmd: "frobnicate" })) as { error: string }).error, "unknown command frobnicate");
	assert.equal((await sidecar.request({ cmd: "stop" })).ok, true);
	await sidecar.done;
	assert.equal(world.broker.sessions.has(sidecar.id), false);
});

test("control: broadcast reaches the pi sessions in scope, and call-tower needs a tower, or a main that may open one", async () => {
	const a = world.agent({ id: "a", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", pane: "wB:p1", tab: "wB:t1" });
	await Promise.all([a.start(), b.start()]);
	const { sidecar } = await claude();
	const tab = (await sidecar.request({ cmd: "broadcast", message: "tab note", scope: "tab" })) as { text: string };
	assert.match(tab.text, /Broadcast to 1 session/);
	await sidecar.request({ cmd: "broadcast", message: "default note" });
	await sidecar.request({ cmd: "broadcast", message: "all note", scope: "all" });
	assert.deepEqual(lines().filter((l) => l.from === sidecar.id).map((l) => [l.to, l.message]), [["a", "tab note"], ["a", "default note"], ["a", "all note"], ["b", "all note"]]);
	const none = await sidecar.request({ cmd: "call-tower", message: "help" });
	assert.equal(none.ok, false);
	assert.match((none as { error: string }).error, /has no tower yet: it opens when a member there promotes itself to main/);
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	world.herdr.workspace("wA").tokens.tower = "tower-wA";
	const called = (await sidecar.request({ cmd: "call-tower", message: "help" })) as { text: string };
	assert.match(called.text, /^Sent to the tower of Alpha/);
	assert.deepEqual(lines().filter((l) => l.to === "tower-wA").map((l) => [l.from, l.message]), [[sidecar.id, "help"]]);
});

test("a main sidecar opens the tower itself for call-tower", async () => {
	world.autoTowers();
	const { sidecar } = await claude({ deps: { autoTower: false } });
	await sidecar.request({ cmd: "promote" });
	assert.equal(roleOf("wA:p3"), "main");
	const called = (await sidecar.request({ cmd: "call-tower", message: "open up" })) as { text?: string; error?: string };
	assert.match(called.text ?? called.error ?? "", /Sent to the tower of Alpha \(opened it\)/);
	await world.quiet();
	assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-wA");
});

test("the control socket answers a request line with one JSON line", async () => {
	const { sidecar } = await claude();
	const reply = await ask(agentFiles(world.stateDir, "wA:p3").socket, { cmd: "status" });
	assert.equal(reply.ok, true);
	assert.equal(((reply as unknown) as { me: { id: string } }).me.id, sidecar.id);
	assert.equal(statSync(agentFiles(world.stateDir, "wA:p3").socket).mode & 0o077, 0, "only its owner may connect");
	assert.equal(statSync(agentFiles(world.stateDir, "wA:p3").dir).mode & 0o077, 0);
	await sidecar.request({ cmd: "stop" });
	await sidecar.done;
	assert.equal(existsSync(agentFiles(world.stateDir, "wA:p3").socket), false);
});

test("a broker that goes away is reconnected to, and the sidecar keeps its role and its place", async () => {
	const { sidecar, clients } = await claude();
	await sidecar.request({ cmd: "promote" });
	assert.equal(roleOf("wA:p3"), "main");
	clients[0]!.drop();
	await until(() => clients.length === 2 && world.broker.sessions.has(sidecar.id), "the new connection");
	await world.quiet();
	assert.equal(roleOf("wA:p3"), "main");
	assert.equal(((await sidecar.request({ cmd: "status" })) as unknown as { me: { role: string } }).me.role, "main");
});

test("Herdr's new server gets the tokens written again", async () => {
	const { sidecar } = await claude();
	await world.takeover();
	await until(() => roleOf("wA:p3") === "member", "the role token again");
	assert.ok(world.herdr.pane("wA:p3").tokens.sb_order);
	assert.equal(sidecar.id.startsWith("claude-"), true);
});

test("a broker without the extension bus makes the join fail loudly and the sidecar leave", async () => {
	const { sidecar, log } = await claude({ wait: false, deps: { connect: () => Object.assign(new FakeClient(world.broker, "wA:p3"), { bus: false }) } });
	await assert.rejects(sidecar.ready, /lacks extension-bus-v1/);
	await sidecar.done;
	assert.ok(log.some((l) => /join failed/.test(l)), log.join("\n"));
	assert.equal(existsSync(agentFiles(world.stateDir, "wA:p3").state), false);
});
