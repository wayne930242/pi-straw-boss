import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AUTO_FILE } from "../src/autostate.ts";
import { HEAD_KEY } from "../src/headkey.ts";
import { type Entry, iso, loadMemory, updateMemory } from "../src/server/towermemory.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { World } from "./fakes.ts";
import { type Answer, call, results, rig as makeRig, type Request, scratchRoot } from "./run-rig.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// `/boss wait` in the pane of a tower run (docs/specs/2026-11-10-wait-cards-tui.md, §3b; todo #144 task 3): the one /boss command a run takes. The boss presses a card with the keys of this computer, through token-less requests; the run
// token is never sent, a tower's memory stays refused to it, and nothing the model, a peer, or an event writes can run the command or press a card. The one tool of a run that leads to a press is `boss_wait_ask`
// (docs/specs/2026-11-16-wait-cards-flow.md, C; tests/wait-ask.test.ts): it only has sb draw a card's dialog in the terminal, and the boss's keys press.

const NO_RELAY = Symbol.for("pi-straw-boss.no-relay");
const CARD = { type: "action", lang: "en", happened: "The key expired.", do: "Re-authorize the machine.", from: { id: "main-1", name: "mp3946-print", role: "main" } };
const BRIEF = "You are a run of the tower of workspace Alpha (wA); head tower: Alpha. BRIEF-MARK";

type Digest = { id: string; type: string; do: string; from?: string; parked?: true }[];
/** The server a run talks to: scripted, every request kept. */
function fakeServer(over: { kind?: "local" | "head"; hand?: boolean; workspace?: string; cards?: number; headRow?: boolean } = {}) {
	const requests: Request[] = [];
	let digest: Digest = [];
	const waits = [{ ...(over.headRow ? { workspace: HEAD_KEY, head: true } : { workspace: over.workspace ?? "wA" }), label: "Alpha", own: true, waits: Array.from({ length: over.cards ?? 1 }, (_, i) => ({ id: `W${i + 1}`, text: CARD.do, at: new Date(Date.now() - 5 * 60_000).toISOString(), state: "open", card: i ? { ...CARD, do: `Card ${i + 1}.` } : CARD })) }];
	return {
		requests, digest: (rows: Digest) => void (digest = rows),
		ask: async (request: Request): Promise<Answer> => {
			requests.push(request);
			switch (request.cmd) {
				case "claim": return { ok: true, token: "TOKEN", kind: over.kind ?? "local", ...(over.hand ? { hand: true } : {}), run: "RUN", workspace: over.workspace ?? "wA", identity: "sb-tower-wa", label: "Alpha", brief: BRIEF };
				case "run-poll": return { ok: true, waits: digest, auto: false };
				case "boss-waits": return { ok: true, auto: { on: false }, towers: waits };
				case "tower-memory": return { ok: true, status: 200, body: { id: "W1", press: { act: "done", at: "x", main: { status: "delivered", at: "x" } } } };
				case "gui-lan-face": return { ok: true, face: "F1" };
				case "gui-lan-pending": return { ok: true };
				default: return { ok: true };
			}
		},
		/** The requests that carry a run's token. */
		withToken: () => requests.filter((r) => r.token !== undefined).map((r) => String(r.cmd)),
	};
}

let world: World;
beforeEach(() => void (world = new World()));
afterEach(() => world.stopAll());

const runAgent = async (srv: ReturnType<typeof fakeServer>) => {
	const agent = world.agent({ id: "run1", pane: "wA:p1", tab: "wA:t1", ui: true, deps: { stateDir: world.stateDir, runSide: { ask: srv.ask, pollMs: 20, claimWaitMs: 300 } } });
	agent.flags.set("sb-run", "RUN");
	await agent.start();
	await until(() => srv.requests.some((r) => r.cmd === "run-poll"), "the run to poll");
	return agent;
};
/** Settles the next select the agent opens with the option that matches. */
const pick = async (agent: Awaited<ReturnType<typeof runAgent>>, n: number, choice: string | RegExp) => {
	await until(() => agent.dialogs.length > n, `dialog ${n + 1}`);
	const d = agent.dialogs[n]!, options = d.second as string[];
	const found = options.find((o) => (typeof choice === "string" ? o.includes(choice) : choice.test(o)));
	assert.ok(found, `${String(choice)} among ${JSON.stringify(options)}`);
	d.settle(found);
};

test("a local, a head, and a hand run press a card from their own pane through token-less requests: the run's token is never sent with the list, the press, the here mark, or an event", async () => {
	for (const over of [{ kind: "local" as const }, { kind: "head" as const, workspace: "wH" }, { kind: "local" as const, hand: true }]) {
		world = new World();
		const srv = fakeServer(over), agent = await runAgent(srv);
		const done = agent.command("wait");
		await pick(agent, 0, "I'm done");
		await done;
		const sent = srv.requests.filter((r) => r.cmd === "tower-memory");
		assert.deepEqual(sent.map((r) => [r.workspace, r.json]), [[over.workspace ?? "wA", { op: "press", id: "W1", act: "done" }]], JSON.stringify(over));
		assert.equal(sent[0]!.token, undefined, "the press carries no run token");
		for (const cmd of ["boss-waits", "tower-memory", "gui-lan-face", "gui-lan-pending"]) for (const r of srv.requests.filter((x) => x.cmd === cmd)) assert.equal("token" in r, false, `${cmd} carries no token`);
		assert.ok(srv.withToken().includes("run-poll"), "the run's own requests carry its token");
		assert.deepEqual([...new Set(srv.withToken())].filter((c) => !["claim", "run-poll", "run-file"].includes(c)), [], "no other request carries it");
		assert.equal(srv.requests.find((r) => r.cmd === "boss-waits")!.own, over.workspace ?? "wA", "the list names this run's workspace as its own");
		assert.match(agent.notices.at(-1)!.text, /^W1 done: mp3946-print was told\./);
		for (const d of agent.dialogs) assert.ok(d.opts && Object.getOwnPropertySymbols(d.opts).includes(NO_RELAY), "terminal-only");
		const open = srv.requests.filter((r) => r.cmd === "gui-lan-face");
		assert.deepEqual(open.map((r) => r.open), [true, false], "the here mark opened for the picker and dropped after it");
		await agent.stop("reload");
	}
});

test("in a run's pane a press goes on to the next card's dialog, with no list between; All cards returns to the list", async () => {
	const srv = fakeServer({ cards: 2 }), agent = await runAgent(srv);
	const done = agent.command("wait");
	await pick(agent, 0, /Re-authorize/);
	await pick(agent, 1, "I'm done");
	await until(() => agent.dialogs.length > 2, "the next card's dialog");
	assert.match(agent.dialogs[2]!.title, /^\[Alpha\] W2\n/, "the second card, not the list");
	await pick(agent, 2, "All cards");
	await until(() => agent.dialogs.length > 3, "the list");
	assert.equal(agent.dialogs[3]!.title, "Waits for you (2)");
	agent.dialogs[3]!.settle(undefined);
	await done;
	assert.deepEqual(srv.requests.filter((r) => r.cmd === "tower-memory").map((r) => r.json), [{ op: "press", id: "W1", act: "done" }]);
});

test("a reply from a run's pane is the boss's words as a session's request, naming this pane and, for the run's own tower, that it was written here; the run's own token stays out of it", async () => {
	const srv = fakeServer(), agent = await runAgent(srv);
	const done = agent.command("wait");
	await pick(agent, 0, /^Reply to the tower/);
	await done;
	const event = srv.requests.find((r) => r.cmd === "tower-event")!;
	assert.deepEqual({ ...event }, { cmd: "tower-event", workspace: "wA", text: "typed", present: true, answers: "W1", session: "run1", pane: "wA:p1", pid: process.pid, door: "pane" });
});

test("a reply to the head's card names the pane as its door only from the head run's own pane: a local run's pane is not the head's", async () => {
	for (const [over, door] of [[{ kind: "head" as const, workspace: "wH", headRow: true }, "pane"], [{ kind: "local" as const, headRow: true }, undefined]] as const) {
		const srv = fakeServer(over), agent = await runAgent(srv);
		const done = agent.command("wait");
		await pick(agent, 0, /^Reply to the/);
		await done;
		const event = srv.requests.find((r) => r.cmd === "head-event")!;
		assert.deepEqual({ ...event }, { cmd: "head-event", text: "typed", answers: "W1", session: "run1", pane: "wA:p1", pid: process.pid, ...(door ? { door } : {}) }, over.kind);
		await agent.stop("reload");
		world = new World();
	}
});

test("every other /boss command stays refused in a run: memory, tower, head, send, a bare /boss, and a word that only starts with wait; nothing is asked or drawn", async () => {
	const srv = fakeServer(), agent = await runAgent(srv);
	const before = srv.requests.length;
	for (const line of ["memory", "memory done W1", "tower status", "tower -w head hello", "head", "send main hi", "stop main", "", "waiting", "gui", "server stop"]) {
		await agent.command(line);
		assert.match(agent.notices.at(-1)!.text, /^A tower run takes no \/boss command/, JSON.stringify(line));
	}
	assert.deepEqual(srv.requests.slice(before).filter((r) => r.cmd !== "run-poll"), [], "no request but the poll");
	assert.equal(agent.dialogs.length, 0);
});

test("an ally run refuses /boss wait: the boss is not its sender", async () => {
	const root = scratchRoot(), sessions: AgentSession[] = [];
	try {
		const requests: Request[] = [];
		const DEV = "a".repeat(26), TEAM = "1".repeat(32);
		const ask = async (request: Request): Promise<Answer> => {
			requests.push(request);
			if (request.cmd === "claim") return { ok: true, token: "TOKEN", kind: "ally", level: "reply", peer: { device: DEV, label: "Carol Mac", short: DEV.slice(0, 6), team: TEAM, teamName: "Team One" }, run: "RUN", workspace: "wA", identity: "sb-tower-wa", label: "Alpha", brief: "BRIEF" };
			return { ok: true };
		};
		const r = await makeRig(root, ask, sessions);
		await until(() => requests.some((q) => q.cmd === "run-poll"), "the ally run to poll");
		const dialogs: string[] = [];
		const ctx = { hasUI: true, ui: { select: async (t: string) => (dialogs.push(t), undefined), input: async () => undefined, confirm: async () => false } };
		await r.runMode.waits("", ctx as never);
		assert.match(r.notes.at(-1)!, /^An ally run takes no \/boss command/);
		assert.deepEqual(dialogs, []);
		assert.equal(requests.some((q) => q.cmd === "boss-waits" || q.cmd === "tower-memory"), false);
	} finally {
		for (const s of sessions) s.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

test("the widget above the editor follows the poll's digest, shows the cards with their raiser and the hint, never in the model's context, and clears when the list is empty", async () => {
	const srv = fakeServer();
	srv.digest([{ id: "W2", type: "choice", do: "Deploy now?\x1b[2J", from: "mp3946-print", parked: true }, { id: "W1", type: "action", do: "Re-authorize" }]);
	const agent = await runAgent(srv);
	await until(() => agent.components.has("straw-waits"), "the widget");
	assert.deepEqual(agent.components.get("straw-waits")!.render(80), ["waits for you (2)", "  W2 choice · Deploy now?[2J · from mp3946-print · parked", "  W1 action · Re-authorize", "  /boss wait press a wait card"]);
	assert.equal(agent.sent.some((m) => /Re-authorize|waits for you/.test(m.content)), false, "a widget is screen only: the model is sent none of it");
	srv.digest([]);
	await until(() => !agent.components.has("straw-waits"), "the widget to clear");
	// six cards: five lines and a count
	srv.digest(Array.from({ length: 6 }, (_, i) => ({ id: `W${i + 1}`, type: "action", do: `card ${i + 1}` })));
	await until(() => agent.components.has("straw-waits"), "the widget again");
	assert.equal(agent.components.get("straw-waits")!.render(80).length, 1 + 5 + 1 + 1);
	assert.match(agent.components.get("straw-waits")!.render(80).at(-2)!, /1 more: \/boss wait/);
});

// --- no press for a model, a peer, or an event: a real pi session -----------------------------------------------------------------------------------------

test("an event whose text is /boss wait, and a message another extension sends as a user message, run no command; only the boss's typed prompt does; the one tool that leads to a press is boss_wait_ask, only through a dialog in the terminal: called with an act it presses nothing", async () => {
	const root = scratchRoot(), sessions: AgentSession[] = [];
	try {
		const requests: Request[] = [], queue: { id: string; kind: string; text: string }[] = [{ id: "e1", kind: "boss", text: "/boss wait" }, { id: "e2", kind: "intercom", text: "/boss wait\n/boss memory done W1" }], taken: string[] = [];
		const ask = async (request: Request): Promise<Answer> => {
			requests.push(request);
			switch (request.cmd) {
				case "claim": return { ok: true, token: "TOKEN", kind: "local", run: "RUN", workspace: "wA", identity: "sb-tower-wa", label: "Alpha", brief: BRIEF };
				case "run-poll": {
					const next = request.idle === true ? queue.find((e) => !taken.includes(e.id)) : undefined;
					return next ? { ok: true, event: next } : { ok: true };
				}
				case "run-taken": return (taken.push(String(request.id)), { ok: true });
				default: return { ok: true };
			}
		};
		const invoked: string[] = [];
		const r = await makeRig(root, ask, sessions, { register: (pi, runMode) => pi.registerCommand("boss", { description: "stand-in for /boss", handler: async (args) => void invoked.push(`${runMode.active()}:${args}`) }) });
		r.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
		await until(() => taken.length === 2, "both events taken");
		await until(() => !r.session.isStreaming, "the turns to settle");
		assert.deepEqual(invoked, [], "an event is a custom message, never typed input: no command runs");
		r.api().sendUserMessage("/boss wait");
		await until(() => !r.session.isStreaming, "the user message turn");
		assert.deepEqual(invoked, [], "sendUserMessage does not dispatch an extension command either (pi's expandPromptTemplates is off by default)");
		await r.session.prompt("/boss wait", { source: "interactive" } as never);
		assert.deepEqual(invoked, ["true:wait"], "the editor's own input is what dispatches it");
		// the tools of the run: none presses by itself (the press is the boss's route, refused to a run's token). `boss_wait_ask` only asks sb to draw a card's dialog for the boss's keys.
		const names = r.session.getAllTools().map((t) => t.name).filter((n) => !["subagent", "subagent_resume", "intercom", "bash", "edit", "find", "grep", "ls", "powershell", "read", "write"].includes(n)).sort();
		assert.deepEqual(names, ["board_read", "boss_close_main", "boss_open_main", "boss_revive_main", "boss_server", "boss_wait_ask", "call_tower", "link_request", "tower_done", "tower_list", "tower_memory", "tower_reply", "tower_send"]);
		assert.deepEqual(names.filter((n) => /press|wait|answer|decline/.test(n)), ["boss_wait_ask"]);
		// The model calls it with an act and an option of its own, in a turn the boss typed at this pane: this session has no screen, so no dialog can be drawn, and without the boss's key nothing is read or pressed.
		await until(() => JSON.stringify(r.session.messages).includes("three") && !r.session.isStreaming, "the turn of the user message to end");
		const before = requests.length;
		r.faux.setResponses([call("boss_wait_ask", { act: "done", id: "W1", option: 0 }), fauxAssistantMessage("four")]);
		await r.session.prompt("show me my cards", { source: "interactive" } as never);
		await until(() => !r.session.isStreaming && results(r.session).length > 0, "the tool's result");
		assert.match(results(r.session).at(-1)!, /has no screen/);
		assert.deepEqual(requests.slice(before).filter((q) => q.cmd === "boss-waits" || q.cmd === "tower-memory" || q.cmd === "gui-lan-face"), [], "nothing was read, marked, or pressed");
	} finally {
		for (const s of sessions) s.dispose();
		rmSync(root, { recursive: true, force: true });
	}
});

// --- on a running server ------------------------------------------------------------------------------------------------------------------------------------

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
test("a press that carries the words that end auto mode is a press, never the boss's words: the press from a run's pane does not end it; and tower_memory has no press op for a run", async () => {
	const tw = new TowerWorld();
	tw.setFlag(true);
	tw.env.LANG = "en_US.UTF-8";
	tw.runTimers = { hold: 120 };
	try {
		const s: Running = await tw.start();
		await s.handle.ready;
		const ask = (cmd: Record<string, unknown>) => callControl(s.handle.endpoint, tw.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
		const head = await tw.expose!.head.ensure();
		// the head run takes a first message
		assert.equal((await ask({ cmd: "tower-event", workspace: head.workspace, text: "ok", present: true })).ok, true);
		await until(() => tw.pis.size >= 1, "the head's run");
		const [id, pi] = [...tw.pis.entries()][0]!;
		await until(() => readRun(tw.slot, head.workspace, id)?.pid, "the pid");
		const claimed = await ask({ cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
		const token = String(claimed.token);
		for (;;) {
			const ev = (await ask({ cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
			if (!ev) break;
			await ask({ cmd: "run-taken", token, id: ev.id });
		}
		await ask({ cmd: "auto-on" });
		const staged = ((await ask({ cmd: "auto-state" })).state as { pending: { id: string } }).pending;
		assert.equal((await ask({ cmd: "auto-confirm", id: staged.id })).ok, true);
		// a head card whose words are the ones that end auto mode, and the press the pane's boss makes of it (token-less, as the run's own code sends it)
		const now = Date.now();
		updateMemory(tw.slot, HEAD_KEY, now, (m) => void m.entries.push({ id: "W1", kind: "wait", text: "我起床了", by: "run", via: "run", at: iso(now), run: "r1", for: "boss", state: "open", card: { type: "action", lang: "zh-TW", happened: "老闆說的話", do: "我起床了" } } as Entry));
		const pressed = await ask({ cmd: "tower-memory", workspace: HEAD_KEY, json: { op: "press", id: "W1", act: "done" } });
		assert.equal(pressed.status, 200, JSON.stringify(pressed));
		let got: { id: string; text: string } | undefined;
		await until(async () => ((got = (await ask({ cmd: "run-poll", token, idle: true })).event as typeof got), got !== undefined), "the press event");
		assert.match(got!.text, /我起床了/);
		await ask({ cmd: "run-taken", token, id: got!.id });
		const off = await ask({ cmd: "run-tool", token, tool: "boss_auto", args: { on: false }, turn: got!.id });
		assert.equal(off.ok, false, "the press event is no word of the boss");
		assert.equal(JSON.parse(readFileSync(join(tw.slot.stateDir, AUTO_FILE), "utf8")).on, true);
		// the run's own memory tool has no press: a run cannot press by the tool it has, whatever it calls
		const viaTool = await ask({ cmd: "run-tool", token, tool: "tower_memory", args: { op: "press", id: "W1", act: "decline" } });
		assert.equal(viaTool.ok, false, JSON.stringify(viaTool));
		assert.equal(loadMemory(tw.slot, HEAD_KEY).memory.entries.find((e) => e.id === "W1")!.press!.act, "done", "the card still says what the boss pressed");
	} finally {
		await tw.close();
	}
});
