import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { agentFiles, alive, ask, holder, type Held, liveHeld, readHeld } from "../src/agent/paths.ts";
import { type AgentDeps, type Sidecar, startSidecar } from "../src/agent/sidecar.ts";
import { netMembers } from "../src/reach.ts";
import { FakeClient } from "./agent-fakes.ts";
import { bare, until, World } from "./fakes.ts";

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
async function claude(over: { pane?: string; session?: string; record?: string; kind?: "claude" | "codex"; deps?: AgentDeps; wait?: boolean; cli?: string } = {}) {
	const pane = over.pane ?? "wA:p3", clients: FakeClient[] = [], log: string[] = [];
	if (!world.herdr.panes.some((p) => p.pane_id === pane)) Object.assign(world.herdr.addPane(pane, "wA:t1", over.kind ?? "claude"), { agent_status: "idle" });
	const sidecar = await startSidecar({
		pane, kind: over.kind ?? "claude", session: over.session ?? SESSION, record: over.record, cli: over.cli ?? "/x/straw-net.py",
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
	const held = await liveHeld(agentFiles(world.stateDir, "wA:p3"));
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
	assert.equal((await liveHeld(files))?.session, "fresh-session-id");
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

test("a record that was there before the sidecar started promotes it at the join, as a resumed main agent", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-record-"));
	scratch.push(dir);
	const record = join(dir, "r.json");
	writeFileSync(record, "{}");
	await claude({ record });
	await until(() => roleOf("wA:p3") === "main", "the main role from the existing record");
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

test("board: a sidecar main writes its entry as its own session id, a member is refused, and leaving deletes the entry", async () => {
	const a = world.agent({ id: "a", name: "Pi One", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	await a.promote();
	const { sidecar } = await claude();
	const refused = (await sidecar.request({ cmd: "board", now: "I am a member" })) as { ok: boolean; error: string };
	assert.equal(refused.ok, false);
	assert.match(refused.error, /Only the main agent of a tab writes/);
	await a.stop("quit");
	await world.quiet();
	assert.equal((await sidecar.request({ cmd: "promote" })).ok, true);
	const done = (await sidecar.request({ cmd: "board", now: "MP-1 export", item: ["[x] schema", "[ ] writer", "plain step"] })) as { ok: boolean; text: string };
	assert.equal(done.ok, true);
	assert.match(done.text, /It goes to: local towers\./);
	const file = join(world.stateDir, "board", `${sidecar.id}.json`);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).items, [{ t: "schema", done: true }, { t: "writer", done: false }, { t: "plain step", done: false }]);
	assert.equal(((await sidecar.request({ cmd: "board", now: "bad\u001b[31m" })) as { error: string }).error.includes("control or format"), true);
	// RV-F007: a sidecar main clears its own line
	const cleared = (await sidecar.request({ cmd: "board", clear: "true" })) as { ok: boolean; text: string };
	assert.equal(cleared.ok, true);
	assert.match(cleared.text, /cleared/);
	assert.equal(existsSync(file), false, "board --clear deletes the entry");
	await sidecar.request({ cmd: "board", now: "again" });
	assert.equal(existsSync(file), true);
	assert.equal((await sidecar.request({ cmd: "stop" })).ok, true);
	await sidecar.done;
	assert.equal(existsSync(file), false, "the session is done, so is its entry");
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
	assert.deepEqual(lines().filter((l) => l.from === sidecar.id).map((l) => [l.to, bare(l.message)]), [["a", "tab note"], ["a", "default note"], ["a", "all note"], ["b", "all note"]]);
	assert.match(lines().find((l) => l.from === sidecar.id && bare(l.message) === "tab note")!.message, /^\[straw net from=claude-\w+ id=claude-\S+ role=member workspace=Alpha kind=broadcast scope=tab to="a \(member of Alpha\)" reply=none\] tab note$/, "a sidecar's message opens with the same header a pi's does");
	const none = await sidecar.request({ cmd: "call-tower", message: "help" });
	assert.equal(none.ok, false);
	assert.match((none as { error: string }).error, /has no tower yet: it opens when a member there promotes itself to main/);
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	world.herdr.workspace("wA").tokens.tower = "tower-wA";
	const called = (await sidecar.request({ cmd: "call-tower", message: "help" })) as { text: string };
	assert.match(called.text, /^Sent to the tower of Alpha/);
	assert.deepEqual(lines().filter((l) => l.to === "tower-wA").map((l) => [l.from, bare(l.message)]), [[sidecar.id, "help"]]);
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


// ── review findings (R-F001 … R-F008) ──

const staleHeld = (pane: string, over: Partial<Held> = {}): Held => ({ pid: 2 ** 22 + 1, session: "stale-session", kind: "claude", pane, id: "claude-stale-session", name: "x", startedAt: Date.now() - 3_600_000, ...over });
const sleeper = () => {
	const child = spawn("sleep", ["60"], { stdio: "ignore" });
	return { child, stop: () => void child.kill("SIGKILL") };
};

test("R-F001: a message that says agent_blocked, typed into a pane whose prompt then stalls, is dropped once and does not hold the queue", async () => {
	const a = world.agent({ id: "a", name: "Pi One", pane: "wA:p1", tab: "wA:t1" });
	await a.start();
	const { sidecar, log } = await claude({ deps: { pollMs: 40 } });
	world.herdr.failPrompt = (text) => (text.includes("why does herdr answer agent_blocked") ? "agent_prompt_stalled" : undefined);
	world.broker.outbox(a, { requestId: "r1", to: sidecar.id, message: "why does herdr answer agent_blocked here?" });
	world.broker.outbox(a, { requestId: "r2", to: sidecar.id, message: "a plain one behind it" });
	await until(() => world.herdr.prompts.length === 1, "the plain message behind the stalled one");
	await new Promise((resolve) => setTimeout(resolve, 300)); // several polls
	assert.equal(world.herdr.promptTries.filter((t) => t.includes("agent_blocked here")).length, 1, "the stalled line is typed once");
	assert.match(world.herdr.prompts[0]!.text, /a plain one behind it$/);
	assert.ok(log.some((l) => /could not type a message/.test(l)), log.join("\n"));
});

test("R-F002: a state file whose pid is alive but is not a sidecar (nothing answers on the socket) does not hold the pane, and is never signalled", async () => {
	const victim = sleeper();
	try {
		world.herdr.addPane("wA:p4", "wA:t1", "claude");
		const files = agentFiles(world.stateDir, "wA:p4");
		mkdirSync(files.dir, { recursive: true });
		writeFileSync(files.state, JSON.stringify(staleHeld("wA:p4", { pid: victim.child.pid! })));
		const { sidecar } = await claude({ pane: "wA:p4", session: "fresh-session-id" });
		assert.equal((await liveHeld(files))?.session, "fresh-session-id");
		assert.equal(victim.child.exitCode, null);
		assert.equal(alive(victim.child.pid!), true, "the unrelated process is untouched");
		await sidecar.stop("done");
	} finally {
		victim.stop();
	}
});

test("R-F002: EPERM is not ours, so a state file naming pid 1 does not lock the pane", async () => {
	assert.equal(alive(1), false);
	world.herdr.addPane("wA:p4", "wA:t1", "claude");
	const files = agentFiles(world.stateDir, "wA:p4");
	mkdirSync(files.dir, { recursive: true });
	writeFileSync(files.state, JSON.stringify(staleHeld("wA:p4", { pid: 1 })));
	const { sidecar } = await claude({ pane: "wA:p4", session: "fresh-session-id" });
	assert.equal(readHeld(files)?.pid, process.pid);
	await sidecar.stop("done");
});

test("R-F002: a holder that is still starting (alive, young, not listening yet) holds the pane; one that answers for another session does too", async () => {
	world.herdr.addPane("wA:p4", "wA:t1", "claude");
	const files = agentFiles(world.stateDir, "wA:p4");
	mkdirSync(files.dir, { recursive: true });
	writeFileSync(files.state, JSON.stringify(staleHeld("wA:p4", { pid: process.pid, startedAt: Date.now() })));
	assert.equal((await holder(files))?.state, "starting");
	await assert.rejects(claude({ pane: "wA:p4", session: "fresh-session-id" }), /already held/);
});

test("R-F003: sidecars racing for one pane that has a leftover state file: exactly one wins, and the leftover's removal never takes the winner's file", async () => {
	world.herdr.addPane("wA:p4", "wA:t1", "claude");
	const files = agentFiles(world.stateDir, "wA:p4");
	mkdirSync(files.dir, { recursive: true });
	writeFileSync(files.state, JSON.stringify(staleHeld("wA:p4")));
	const results = await Promise.allSettled([1, 2, 3, 4].map((i) => claude({ pane: "wA:p4", session: `racer-${i}`, wait: false })));
	const won = results.filter((r) => r.status === "fulfilled");
	assert.equal(won.length, 1, results.map((r) => (r.status === "rejected" ? String(r.reason) : "won")).join(" | "));
	const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof claude>>>).value.sidecar;
	await winner.ready;
	assert.equal(readHeld(files)?.session, winner.id.replace(/^claude-/, ""));
	assert.equal((await holder(files))?.state, "up");
});

test("R-F003: leaving removes the state file only while it is this sidecar's own", async () => {
	const { sidecar } = await claude();
	const files = agentFiles(world.stateDir, "wA:p3");
	writeFileSync(files.state, JSON.stringify(staleHeld("wA:p3", { session: SESSION, pid: process.pid + 1 })));
	await sidecar.stop("done");
	assert.equal(readHeld(files)?.pid, process.pid + 1, "another process's file is left alone");
});

test("R-F007: while a sidecar is leaving its socket says so, and it is no live holder of the pane", async () => {
	const { sidecar, clients } = await claude();
	const files = agentFiles(world.stateDir, "wA:p3");
	assert.equal((await holder(files))?.state, "up");
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve)), disconnect = clients[0]!.disconnect.bind(clients[0]);
	clients[0]!.disconnect = async () => (await gate, disconnect());
	const stopped = sidecar.stop("test");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.equal((await holder(files))?.state, "leaving");
	assert.equal(await liveHeld(files), undefined);
	release();
	await stopped;
	assert.equal(await holder(files), undefined);
});

test("R-F004: a rename survives the broker connection being made again", async () => {
	const { sidecar, clients } = await claude();
	await sidecar.request({ cmd: "rename", name: "MP-3584 cost mask" });
	clients[0]!.drop();
	await until(() => clients.length === 2 && world.broker.sessions.has(sidecar.id), "the new connection");
	await world.quiet();
	assert.equal((await world.broker.sessionList()).find((x) => x.id === sidecar.id)?.name, "MP-3584 cost mask");
});

test("R-F006: a pane that now runs another agent keeps the tokens its new owner wrote when the sidecar leaves", async () => {
	const { sidecar } = await claude();
	Object.assign(world.herdr.pane("wA:p3"), { agent: "pi" });
	Object.assign(world.herdr.pane("wA:p3").tokens, { sb_role: "main", sb_order: "0010", sb_mark: "★" });
	world.herdr.emit("pane.updated", "pane_updated", { pane_id: "wA:p3" });
	await sidecar.done;
	const { sb_role, sb_order, sb_mark } = world.herdr.pane("wA:p3").tokens;
	assert.deepEqual({ sb_role, sb_order, sb_mark }, { sb_role: "main", sb_order: "0010", sb_mark: "★" });
	assert.equal(existsSync(agentFiles(world.stateDir, "wA:p3").state), false);
});

test("R-F006: a new Herdr server does not get tokens written into a pane that runs another agent now", async () => {
	const { sidecar } = await claude({ deps: { pollMs: 100_000 } });
	Object.assign(world.herdr.pane("wA:p3"), { agent: "pi" });
	await world.takeover();
	await world.quiet();
	assert.deepEqual(world.herdr.pane("wA:p3").tokens, {});
	await sidecar.stop("done");
});

test("R-F008: the reply hint is shell-quoted, and a sender id or a --cli path with spaces and quotes stays one word each", async () => {
	const { clients } = await claude({ cli: "/My Tools/straw net.py" });
	clients[0]!.incoming({ id: "a b", name: "cli" } as never, { id: "m0", content: { text: "one" } });
	clients[0]!.incoming({ id: `we ird'id "x"`, name: "cli" } as never, { id: "m1", content: { text: "two" } });
	await until(() => world.herdr.prompts.length === 2, "the prompts");
	const hints = world.herdr.prompts.map((p) => /reply="([^"]*)"/.exec(p.text)![1]);
	assert.deepEqual(hints, [String.raw`'/My Tools/straw net.py' send --to 'a b' --message '…'`, String.raw`'/My Tools/straw net.py' send --to $'we ird\'id \x22x\x22' --message '…'`]);
});

test("R-F008: a cross-machine message carries pi's unverified marker, and attachments are noted", async () => {
	const { clients } = await claude();
	clients[0]!.incoming({ id: "relay-1", name: "pi-intercom-cli" } as never, { id: "m2", content: { text: "from afar", attachments: [{ type: "file", name: "notes.md", content: "SECRET BODY" }] }, crossMachine: { type: "ssh-relay", origin: { name: "Mac", machine: "studio" } } } as never);
	await until(() => world.herdr.prompts.length === 1, "the prompt");
	const typed = world.herdr.prompts[0]!.text;
	assert.match(typed, /^\[straw net from="Mac@studio · unverified cross-machine" id=relay-1 role=session\] from afar/);
	assert.match(typed, /1 attachment: notes\.md/);
	assert.ok(!typed.includes("SECRET BODY"));
	assert.ok(!typed.includes("reply="), "a sidecar cannot answer across machines");
});

test("R-F008: the inherited PI_INTERCOM_* and PI_SUBAGENT_* variables reach neither the sidecar's environment nor its broker client", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-fake-intercom-"));
	scratch.push(dir);
	mkdirSync(join(dir, "broker"));
	writeFileSync(join(dir, "package.json"), "{}");
	writeFileSync(join(dir, "config.ts"), `export const loadConfig = () => ({ brokerCommand: "x", brokerArgs: [] });`);
	writeFileSync(join(dir, "broker", "spawn.ts"), `export const spawnBrokerIfNeeded = async () => void ((globalThis as any).__seen.push(["spawn", process.env.PI_INTERCOM_SCOPE_ID, process.env.PI_SUBAGENT_RUN_ID]));`);
	writeFileSync(join(dir, "broker", "client.ts"), `export class IntercomClient { constructor() { (globalThis as any).__seen.push(["client", process.env.PI_INTERCOM_SCOPE_ID, process.env.PI_SUBAGENT_RUN_ID]); return (globalThis as any).__client(); } }`);
	const seen: unknown[][] = [], g = globalThis as Record<string, unknown>, saved = { ...process.env };
	g.__seen = seen;
	g.__client = () => new FakeClient(world.broker, "wA:p3");
	Object.assign(process.env, { PI_INTERCOM_SCOPE_ID: "other-pool", PI_SUBAGENT_RUN_ID: "run-1", STRAW_BOSS_INTERCOM: dir });
	try {
		const inherited = { PI_INTERCOM_SCOPE_ID: "other-pool", PI_SUBAGENT_RUN_ID: "run-1", STRAW_BOSS_INTERCOM: dir, PI_CODING_AGENT_DIR: "/agent" };
		const { sidecar } = await claude({ deps: { connect: undefined, env: inherited } });
		assert.deepEqual(seen, [["spawn", undefined, undefined], ["client", undefined, undefined]]);
		await sidecar.stop("done");
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		delete g.__seen;
		delete g.__client;
	}
});

test("a sidecar that becomes its tab's main deletes the record of the pi main it replaced, so a restore does not give the tab back to that pi", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-record-"));
	scratch.push(dir);
	const roles = join(world.stateDir, "roles"), held = () => (existsSync(roles) ? readdirSync(roles) : []);
	world.herdr.addTab("wA:t1", "work", "wA:p1");
	const agent = world.agent({ id: "pi-main", pane: "wA:p1", tab: "wA:t1" });
	agent.file = "/s/main.jsonl";
	await agent.start();
	await agent.promote();
	await agent.stop("quit"); // a quit keeps the record
	assert.equal(held().length, 1, "the pi main left its record");
	const record = join(dir, "r.json");
	await claude({ record });
	writeFileSync(record, "{}");
	await until(() => roleOf("wA:p3") === "main", "the sidecar is the main");
	assert.deepEqual(held(), [], "the pi main's record is gone, and the sidecar, which has no session file, wrote none");
});

test("D19: call-tower writes why and reply into the header, why=unspecified without one, and refuses a word outside the set", async () => {
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	world.herdr.workspace("wA").tokens.tower = "tower-wA";
	const { sidecar } = await claude();
	await sidecar.request({ cmd: "call-tower", message: "landed", why: "milestone", reply: "false" });
	await sidecar.request({ cmd: "call-tower", message: "stuck", why: "blocked" });
	await sidecar.request({ cmd: "call-tower", message: "old caller" });
	const bad = (await sidecar.request({ cmd: "call-tower", message: "x", why: "progress" })) as { ok: boolean; error?: string };
	assert.equal(bad.ok, false);
	assert.match(bad.error ?? "", /why/);
	assert.deepEqual(lines().filter((l) => l.to === "tower-wA").map((l) => /kind=call_tower .* (reply=\w+ why=\w+)\] /.exec(l.message)?.[1]), ["reply=none why=milestone", "reply=expected why=blocked", "reply=expected why=unspecified"]);
});
