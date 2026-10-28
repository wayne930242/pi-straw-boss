import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { fileOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { deleteService } from "../src/server/towerstore.ts";
import { standinMessage } from "../src/server/standing.ts";

// The standing pane between runs (docs/specs/2026-10-26-sb-backend.md, The tower service, The standing pane): the sb server types the tower prompt's command into the pane's shell, and while that
// prompt polls, it reports a stand-in agent `tower` on the pane, so the tower keeps its row in Herdr's Agents list (the net view). The prompt leaves before a run starts and comes back after it.
// Against a fake Herdr that models what the real one was seen to do (tests/fakes.ts), and a prompt that is a test.

let world: TowerWorld;
const prompts: FakePrompt[] = [];
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(async () => {
	for (const p of prompts.splice(0)) p.stop();
	await world.close();
});

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, ensured, pane: String(ensured.pane) };
};
const nthRun = async (n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);
/** The run's pi claims its run, takes every event it is offered, and ends with tower_done: the run a boss event wakes, to its end (the exit of pi is the test's). */
const work = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	const token = String(got.token);
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
	assert.equal((await ask(s, { cmd: "run-done", token, note: "n" })).ok, true);
};
const COMMAND = /^node "[^"]+cli\.(ts|mjs)" prompt --workspace wA --state-dir "[^"]+"$/;

/** The prompt program as the server sees it: a process in the pane's foreground that polls, and leaves when told to or when it is stopped. */
class FakePrompt {
	left = false;
	exited = false;
	polls = 0;
	/** Ignores the order to leave (a prompt that hangs): only Ctrl+C ends it. */
	stubborn = false;
	last: Reply | undefined;
	s: Running;
	pane: string;
	pid: number;
	timer: ReturnType<typeof setInterval>;
	constructor(s: Running, pane: string, pid = 6100 + prompts.length) {
		this.s = s;
		this.pane = pane;
		this.pid = pid;
		world.herdr.pane(pane).processes = [{ name: "node", argv0: "node", pid, cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace wA --state-dir "/s"` }];
		this.timer = setInterval(() => void this.poll(), 20);
		prompts.push(this);
	}
	async poll() {
		if (this.exited) return;
		try {
			this.last = await ask(this.s, { cmd: "prompt-poll", workspace: "wA", pid: this.pid });
		} catch {
			return; // the server went away with the test: a prompt retries, this one is done
		}
		this.polls++;
		if (this.last.leave && !this.stubborn) await this.exit(true);
	}
	async exit(told = false) {
		if (this.exited) return;
		this.exited = true;
		this.left = told;
		clearInterval(this.timer);
		world.herdr.pane(this.pane).processes = [];
		world.herdr.dropStandin(this.pane); // Herdr clears the label about a second after the prompt is gone
		if (told) await ask(this.s, { cmd: "prompt-gone", workspace: "wA", pid: this.pid }).catch(() => {});
	}
	stop() {
		this.exited = true;
		clearInterval(this.timer);
	}
}
const reports = () => world.herdr.agentCalls.filter((c) => c.method === "pane.report_agent");
const releases = () => world.herdr.agentCalls.filter((c) => c.method === "pane.release_agent");

test("the standing pane's shell gets the prompt's command typed once, and a stand-in agent `tower` is reported only while the prompt polls, with no resume command and no session", async () => {
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the prompt's command to be typed");
	assert.equal(world.herdr.typed[0]!.pane, pane);
	assert.match(world.herdr.typed[0]!.text, COMMAND);
	await sleep(150);
	assert.equal(world.herdr.typed.length, 1, "not typed again while the prompt may still be starting");
	assert.equal(world.herdr.pane(pane).agent, undefined, "no stand-in before the prompt says it is there");
	assert.equal(reports().length, 0);
	new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	assert.equal(world.herdr.pane(pane).agent_status, "idle");
	assert.equal(world.herdr.pane(pane).standinMessage, "standing by");
	const { seq, ...rest } = reports()[0]!.params;
	assert.deepEqual(rest, { pane_id: pane, source: "straw-boss", agent: "tower", state: "idle", message: "standing by" });
	assert.equal(typeof seq, "number");
	assert.ok(Number(seq) > Date.now() * 100, "a seq in Herdr's pi integration's space (the clock in microseconds)");
	for (const call of world.herdr.agentCalls) assert.ok(!("resume_argv" in call.params) && !("agent_session_id" in call.params) && !("agent_session_path" in call.params), "Herdr never relaunches the stand-in after a restart");
});

test("the prompt's poll answers the state; a workspace without a tower is refused; the stand-in's message follows the queue", async () => {
	const { s, pane } = await setup();
	const prompt = new FakePrompt(s, pane);
	await until(() => prompt.last?.ok, "the first poll");
	assert.deepEqual({ ...prompt.last }, { ok: true, label: "Alpha", state: "standing", queued: 0, leave: false });
	const none = await ask(s, { cmd: "prompt-poll", workspace: "wB", pid: 1 });
	assert.equal(none.ok, false);
	assert.equal(none.gone, true, "the prompt leaves for good only on this answer");
	assert.match(String(none.error), /stands in for no tower/);
	assert.equal((await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 0 })).ok, false, "a pid is needed");
	// A settings refusal keeps an event queued: the message says how many wait.
	world.settingsError = new Error("refused");
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "look at the build" });
	await until(() => world.herdr.pane(pane).standinMessage === "1 queued", "the message to name the queue");
	await until(() => prompt.last?.queued === 1, "the poll to say what waits");
	world.settingsError = undefined;
});

test("standinMessage: standing by, N queued, or held", () => {
	const base = { state: "standing" as const, queued: 0, allyRuns: [], notices: [], parked: [] };
	assert.equal(standinMessage(base), "standing by");
	assert.equal(standinMessage({ ...base, queued: 3 }), "3 queued");
	assert.equal(standinMessage({ ...base, state: "held", queued: 3 }), "held");
});

test("a run's start tells the prompt to leave and takes the stand-in away first; pi starts once the prompt is gone, and the prompt is typed again and reported after the run", async () => {
	const { s, pane } = await setup();
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "hello", present: true });
	const id = await nthRun();
	assert.equal(prompt.left, true, "the prompt was told to leave and said it was gone");
	assert.equal(releases().length, 1, "the stand-in was released before pi started");
	assert.equal(world.herdr.pane(pane).agent, "pi");
	const startAt = world.herdr.calls.findIndex((c) => c[0] === "agent" && c[1] === "start");
	assert.ok(startAt >= 0);
	assert.equal(world.herdr.typed.length, 1, "while the run holds the pane, no prompt is typed");
	await sleep(120);
	assert.equal(world.herdr.typed.length, 1);
	// The run does its work and pi exits; Herdr clears the pane: the prompt comes back.
	await work(s, id);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	const pi = world.herdr.pane(pane);
	pi.agent = undefined;
	pi.processes = [];
	await until(() => world.herdr.typed.length === 2, "the prompt to be typed again");
	assert.match(world.herdr.typed[1]!.text, COMMAND);
	new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in again");
});

test("a prompt that does not leave is stopped with Ctrl+C when it is the pane's foreground, and the key is not sent when the foreground is something else", async () => {
	const { s, pane } = await setup();
	const stuck = new FakePrompt(s, pane);
	stuck.stubborn = true;
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "hello" });
	await until(() => world.herdr.keys.some((k) => k[1] === "send-keys" && k[2] === pane && k.includes("ctrl+c")), "Ctrl+C to the prompt");
	await stuck.exit(true); // the key ended it
	await nthRun();
});

test("Ctrl+C is not sent when what the pane runs is not the prompt that polled", async () => {
	const { s, pane } = await setup();
	const stuck = new FakePrompt(s, pane);
	stuck.stubborn = true;
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	world.herdr.pane(pane).processes = [{ name: "vim", argv0: "vim", pid: 77, cmdline: "vim notes.md" }]; // the boss started something in the pane meanwhile
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "hello" });
	await sleep(1200);
	assert.ok(!world.herdr.keys.some((k) => k.includes("ctrl+c")), "never a key into someone else's program");
	stuck.stop();
});

test("Ctrl+D leaves the pane to the boss: the stand-in goes, the prompt is not typed again for the park time, and a run's end or the park time brings it back", async () => {
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the prompt's command");
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	assert.equal((await ask(s, { cmd: "prompt-leave", workspace: "wA", pid: prompt.pid })).ok, true);
	await prompt.exit();
	await until(() => releases().length === 1, "the stand-in to be released");
	assert.equal(world.herdr.pane(pane).agent, undefined);
	await sleep(250);
	assert.equal(world.herdr.typed.length, 1, "parked: the shell is the boss's");
	await until(() => world.herdr.typed.length === 2, "the prompt after the park time", 2000);
});

test("nothing is typed into a pane that runs something, or that has an agent, and no stand-in is reported over another agent", async () => {
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the prompt's command");
	const busy = world.herdr.pane(pane);
	busy.processes = [{ name: "vim", argv0: "vim", pid: 77, cmdline: "vim notes.md" }];
	await sleep(400);
	assert.equal(world.herdr.typed.length, 1, "a foreground job is the boss's");
	busy.processes = [];
	busy.agent = "pi"; // a pi of the boss's own
	await sleep(400);
	assert.equal(world.herdr.typed.length, 1, "an agent holds the pane");
	assert.equal(reports().length, 0);
	await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4 });
	await sleep(120);
	assert.equal(reports().length, 0, "a stand-in is never reported over another agent");
	assert.equal(busy.agent, "pi");
});

test("when Herdr clears the stand-in while the prompt still polls, the next look reports it again; a Herdr that does not keep the label is told once and not asked over and over", async () => {
	const { s, pane } = await setup();
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	world.herdr.dropStandin(pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in to come back");
	assert.equal(reports().length, 2);
	world.herdr.refuseStandin = true;
	world.herdr.dropStandin(pane);
	await sleep(500);
	const lines = readFileSync(fileOf(world.slot, "log"), "utf8").split("\n").filter((l) => /standin-unsupported/.test(l));
	assert.equal(lines.length, 1, lines.join("\n"));
	assert.ok(reports().length <= 4, `${reports().length} reports for a label Herdr does not keep`);
	prompt.stop();
});

test("after a Herdr restart the pane is bare and its prompt gone: the prompt is typed again and the stand-in reported once it polls", async () => {
	const { s, pane } = await setup();
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	prompt.stop();
	world.herdr.restart();
	world.herdr.pane(pane).processes = [];
	world.herdr.pane(pane).agent = undefined;
	world.takeovers.forEach((cb) => cb());
	await until(() => world.herdr.typed.length === 2, "the prompt typed again");
	new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in again");
});

test("a tower tab whose tokens lapsed but whose pane still shows the stand-in is reused, not replaced by a new tab", async () => {
	const { s, pane } = await setup();
	new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	await s.handle.shutdown(0);
	// The tokens' ten minutes ran out while no server lived; the prompt goes on, and so does Herdr's label.
	world.herdr.pane(pane).tokens = {};
	world.herdr.workspace("wA").tokens = {};
	deleteService(world.slot, "wA"); // and the server that comes has no record of the tower: it finds its tab by what the pane shows
	const tabsBefore = world.herdr.tabs.length;
	const again = await world.start();
	await again.handle.ready;
	const ensured = await ask(again, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(ensured.ok, true);
	assert.equal(ensured.pane, pane, "the same pane stands in");
	assert.equal(world.herdr.tabs.length, tabsBefore, "no new tab");
});
