import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { fileOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { deleteService } from "../src/server/towerstore.ts";
import { TOWER_LABEL } from "../src/herdr.ts";
import { idleShell, standinMessage } from "../src/server/standing.ts";

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
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "hello" }); // not `present`: this test is about the pane, and a run the boss is in does not end at tower_done (server-tower-runs.test.ts)
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

test("Ctrl+D leaves the pane to the boss for good: the stand-in goes and nothing is typed on a timer, however long the boss stays; a run's end brings the prompt back (SR-F002)", async () => {
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the prompt's command");
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	assert.equal((await ask(s, { cmd: "prompt-leave", workspace: "wA", pid: prompt.pid })).ok, true);
	await prompt.exit();
	await until(() => releases().length === 1, "the stand-in to be released");
	assert.equal(world.herdr.pane(pane).agent, undefined);
	world.herdr.shellPids = true; // a shell at its idle prompt, which is where the boss's own commands would be typed
	await sleep(2500); // five times the old park time of these tests, ten times the launch wait
	assert.equal(world.herdr.typed.length, 1, "parked: the shell is the boss's, and no clock gives it back");
	// An explicit action brings the prompt back: a run takes the pane, and the prompt comes back when it ends.
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "wake" });
	const id = await nthRun();
	await work(s, id);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	const pi = world.herdr.pane(pane);
	pi.agent = undefined;
	pi.processes = [];
	await until(() => world.herdr.typed.length === 2, "the prompt after the run");
});

test("B6 VM F6: when the next run is about to start (its event waits and the wake is due within a few seconds), the pane freed by a run gets no prompt typed, since the run would wait for it to start and leave", async () => {
	world.runTimers = { wake: 900 };
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the first typing");
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "first" });
	await prompt.exit(true); // the prompt leaves for the run
	const id = await nthRun();
	await work(s, id);
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "second", present: false }); // arrives as the first run ends
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	const pi = world.herdr.pane(pane);
	pi.agent = undefined;
	pi.processes = [];
	await sleep(500);
	assert.equal(world.herdr.typed.length, 1, "no prompt into the pane the next run is about to take");
	await nthRun(2);
});

test("a Herdr restart ends the boss's Ctrl+D too: every pane is a fresh shell", async () => {
	const { s, pane } = await setup();
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	await ask(s, { cmd: "prompt-leave", workspace: "wA", pid: prompt.pid });
	await prompt.exit();
	await sleep(300);
	assert.equal(world.herdr.typed.length, 1);
	world.herdr.restart();
	world.herdr.pane(pane).processes = [];
	world.herdr.pane(pane).agent = undefined;
	world.takeovers.forEach((cb) => cb());
	await until(() => world.herdr.typed.length === 2, "the prompt typed again");
});

test("where Herdr cannot tell a bare shell from a build (no pgid, as on Windows), the prompt is typed only into a pane the server knows is fresh, and never on a later look (SR-F003)", async () => {
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the first typing into the new tab");
	// The prompt dies (or never started) and the boss runs a build in the shell: Herdr lists the shell alone.
	new FakePrompt(s, pane).stop();
	world.herdr.pane(pane).processes = [];
	await sleep(1500);
	assert.equal(world.herdr.typed.length, 1, "nothing is typed on a later look: the shell may be busy");
});

test("Windows gives shell_pid and a foreground group that are always the shell's: a program the boss runs there is never typed into, however often the look comes (B6 F10)", async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the first typing into the new tab");
	// The prompt is gone and `ping -t localhost` runs in the shell: process-info lists the shell alone, the group is the shell's pid.
	const prompt = new FakePrompt(s, pane);
	await until(() => prompt.polls > 0, "the prompt to poll");
	prompt.stop();
	await sleep(1500);
	assert.equal(world.herdr.typed.length, 1, "the pane is not fresh: no typing, whatever the group says");
	const lost = () => readFileSync(fileOf(world.slot, "log"), "utf8").split("\n").filter((l) => /prompt-lost/.test(l));
	assert.equal(lost().length, 1, "said once, not at every look");
});

test("a resident tower's hand-over frees its own pane: on Windows the prompt is typed once when the resident pi has quit, and never while it still runs there (VM round 2)", async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	const s = await world.start();
	await s.handle.ready;
	// The resident's pi runs in its pane (a node program in the foreground); it hands the pane over and quits.
	world.herdr.addTab("wA:t9", TOWER_LABEL, "wA:p9", "shell");
	world.herdr.pane("wA:p9").processes = [{ name: "node.exe", argv0: "node.exe", pid: 7001, cmdline: "node pi" }];
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA", pane: "wA:p9" });
	assert.equal(ensured.ok, true);
	assert.equal(ensured.pane, "wA:p9");
	await sleep(300);
	assert.equal(world.herdr.typed.length, 0, "nothing is typed while the resident pi runs in the pane");
	world.herdr.pane("wA:p9").processes = [];
	await until(() => world.herdr.typed.length === 1, "the prompt typed into the freed pane");
	assert.equal(world.herdr.typed[0]!.pane, "wA:p9");
	await sleep(300);
	assert.equal(world.herdr.typed.length, 1, "typed once");
	assert.doesNotMatch(readFileSync(fileOf(world.slot, "log"), "utf8"), /prompt-lost/);
});

test("a hand-over that finds the service already adopted (a retry, or a server that waited for the resident) still marks the freed pane fresh, and does not disturb a prompt that polls", async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the first typing");
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA", pane })).ok, true);
	await sleep(300);
	assert.equal(world.herdr.pane(pane).agent, "tower", "the stand-in stays");
	assert.equal(world.herdr.typed.length, 1, "the prompt that polls is not typed over");
	prompt.stop();
});

test("on Windows a prompt that was typed once and never started is logged prompt-not-starting, not prompt-lost (RV-F002)", async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	await setup();
	await until(() => world.herdr.typed.length === 1, "the first typing");
	await sleep(1500);
	const log = readFileSync(fileOf(world.slot, "log"), "utf8");
	assert.equal(world.herdr.typed.length, 1, "typed once");
	assert.match(log, /prompt-not-starting/);
	assert.doesNotMatch(log, /prompt-lost/);
});

test("where Herdr gives the shell's pid and the foreground group, a prompt that died is typed again when the foreground is the shell itself, and not while something else holds it (SR-F003)", async () => {
	world.herdr.shellPids = true;
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the first typing");
	new FakePrompt(s, pane).stop();
	world.herdr.pane(pane).processes = [{ name: "make", argv0: "make", pid: 88 }];
	await sleep(500);
	assert.equal(world.herdr.typed.length, 1, "a foreground group that is not the shell's is the boss's work");
	world.herdr.pane(pane).processes = [];
	await until(() => world.herdr.typed.length === 2, "typed again at the idle shell");
});

test("idleShell: a process list alone is never an idle shell unless the pane is known fresh and every process is a shell; an empty or missing list is unknown", () => {
	const shell = { foreground_processes: [{ name: "zsh" }] };
	assert.equal(idleShell(undefined, true), false);
	assert.equal(idleShell({}, true), false, "no list is unknown");
	assert.equal(idleShell({ foreground_processes: [] }, true), false, "an empty list is unknown, not idle");
	assert.equal(idleShell(shell), false, "not fresh and no pgid: unknown");
	assert.equal(idleShell(shell, true), true);
	assert.equal(idleShell({ foreground_processes: [{ name: "zsh" }, { name: "vim" }] }, true), false);
	assert.equal(idleShell({ shell_pid: 5, foreground_process_group_id: 5, foreground_processes: [] }), true, "with the pgid pair the groups decide");
	assert.equal(idleShell({ shell_pid: 5, foreground_process_group_id: 9 }, true), false);
	const win = { shell_pid: 5, foreground_process_group_id: 5, foreground_processes: [{ pid: 5, name: "powershell.exe" }] };
	assert.equal(idleShell(win, false, false), false, "Windows: the group is the shell's whatever runs, so it proves nothing");
	assert.equal(idleShell(win, true, false), true, "Windows, a pane known fresh");
});

test("between the prompt's post and the wake the next look does not type the prompt again (SR-F004)", async () => {
	world.herdr.shellPids = true;
	world.runTimers = { wake: 200 }; // 1 s in production, against the 15 s wait of a typing
	const { s, pane } = await setup();
	await until(() => world.herdr.typed.length === 1, "the first typing");
	const prompt = new FakePrompt(s, pane);
	await until(() => world.herdr.pane(pane).agent === "tower", "the stand-in");
	await sleep(300); // longer than the launch wait since the typing (250 ms here)
	// What the prompt does when the boss writes: posts a present boss event, tells the server it is gone, exits.
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "hello", present: true })).ok, true);
	await prompt.exit(true);
	await sleep(120);
	assert.equal(world.herdr.typed.length, 1, `the command was typed ${world.herdr.typed.length} times while the wake was coming`);
	await nthRun();
});

test("a prompt that cannot start is typed again less and less often, up to a cap, and the server says so once; a poll ends the backoff (SR-F007)", async () => {
	world.herdr.shellPids = true;
	const { s, pane } = await setup();
	await sleep(3000);
	const typed = world.herdr.typed.length;
	assert.ok(typed >= 3 && typed <= 6, `${typed} typings in 3 s (250, 500, then 1000 ms apart)`);
	const lines = () => readFileSync(fileOf(world.slot, "log"), "utf8").split("\n").filter((l) => /prompt-not-starting/.test(l));
	assert.equal(lines().length, 1, lines().join("\n"));
	await sleep(1500);
	assert.equal(lines().length, 1, "said once");
	// The prompt starts at last; when it dies the next typing comes after the short wait again.
	const prompt = new FakePrompt(s, pane);
	await until(() => prompt.polls > 0, "a poll");
	await prompt.exit();
	const before = world.herdr.typed.length;
	await until(() => world.herdr.typed.length === before + 1, "typed again", 600);
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
