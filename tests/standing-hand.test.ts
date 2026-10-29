import assert from "node:assert/strict";
import { test } from "node:test";
import { idleShell, createStanding, type StandingTarget } from "../src/server/standing.ts";
import type { Pane } from "../src/herdr.ts";
import { fakeClock } from "./fake-clock.ts";

// The standing pane after a resident tower handed it over (RV7-F003/F004, VM round 3): on Windows the server types the prompt's command only into a pane it has proof is a bare shell, and a typing
// Herdr refuses is logged in full and tried again. These run the standing logic itself against a clock the test moves (no server, no sleeps).

interface Rig {
	standing: ReturnType<typeof createStanding>;
	clock: ReturnType<typeof fakeClock>;
	typed: string[];
	lines: { event: string; facts: Record<string, unknown> }[];
	/** Processes Herdr lists in the pane's foreground; the pane's agent record. */
	pane: { agent?: string; processes: { pid: number; name: string; cmdline?: string }[] };
	/** Pids that run. */
	live: Set<number>;
	/** The refusal Herdr gives to the next `pane run`s, if any. */
	refuse: (Error & { stderr?: string; code?: unknown; killed?: boolean; signal?: string })[];
	/** How many `pane run` calls reached Herdr (refused or not). */
	attempts: number;
	freed: number;
	busy: boolean;
	/** The state the service reports (`held`: its start failed and it waits). */
	state: "standing" | "held";
	/** The PIDs of the boss's programs that held the pane when the start failed. */
	busyPids: number[];
}
const SHELL = { pid: 900, name: "powershell.exe", cmdline: "powershell.exe -NoExit" };

function rig(platform: NodeJS.Platform = "win32", timers: Record<string, number> = {}): Rig {
	const clock = fakeClock(1_000_000);
	const r: Rig = { clock, typed: [], lines: [], pane: { processes: [SHELL] }, live: new Set(), refuse: [], attempts: 0, freed: 0, busy: false, state: "standing", busyPids: [] } as unknown as Rig;
	const target: StandingTarget = {
		workspace: "wA", label: () => "Alpha", pane: () => "p1", live: () => true, status: () => ({ state: r.state, queued: 0 }) as never,
		paneBusy: () => r.busy, busyPids: () => r.busyPids, paneFree: () => void r.freed++,
	};
	const run = async (args: string[]) => {
		if (args[1] === "process-info") {
			const win = platform === "win32";
			return JSON.stringify({ result: { process_info: { shell_pid: 900, foreground_process_group_id: win || r.pane.processes.every((p) => p.pid === 900) ? 900 : 7777, foreground_processes: r.pane.processes } } });
		}
		if (args[1] === "run") {
			r.attempts++;
			const refusal = r.refuse.shift();
			if (refusal) throw refusal;
			r.typed.push(args[3]!);
			return "{}";
		}
		return "{}";
	};
	r.standing = createStanding({
		run, api: async () => undefined, world: async () => ({ panes: [{ pane_id: "p1", tab_id: "t1", ...(r.pane.agent ? { agent: r.pane.agent } : {}) } as Pane], workspaces: [], tabs: [] }),
		sleep: clock.sleep, now: clock.now, log: { line: (event, facts = {}) => void r.lines.push({ event, facts }), hide: () => {} },
		command: () => "node prompt", platform, alive: (pid) => r.live.has(pid), timers: { launchMs: 250, handMs: 10_000, ...timers },
	});
	r.standing.attach(target);
	return r;
}
/** Looks at the pane `n` times, a second apart on the clock. */
const looks = async (r: Rig, n: number, ms = 1000) => {
	for (let i = 0; i < n; i++) {
		r.clock.advance(ms);
		await r.standing.tick();
	}
};
const said = (r: Rig, event: string) => r.lines.filter((l) => l.event === event);

test("RV7-F004: a resident's hand-over marks the pane fresh only once that pi's process is gone: a shells-only list while it runs (the cmd wrapper reads as a shell) types nothing and says nothing is lost", async () => {
	const r = rig();
	r.live.add(7001);
	r.standing.handed("wA", 7001);
	await looks(r, 5);
	assert.deepEqual(r.typed, [], "the pi still runs: nothing is typed, whatever the list says");
	assert.equal(said(r, "prompt-lost").length + said(r, "prompt-not-starting").length, 0, "and nothing is said about a lost prompt");
	r.live.delete(7001);
	await looks(r, 1);
	assert.equal(r.typed.length, 1, "typed once the process is gone");
	await looks(r, 3);
	assert.equal(r.typed.length, 1, "and the fresh mark is spent by the typing");
});

test("RV7-F004: the hand-over's word is not believed for ever: a resident that is still there when handMs is over leaves the pane unproven, so a later empty list types nothing", async () => {
	const r = rig();
	r.live.add(7001);
	r.standing.handed("wA", 7001);
	await looks(r, 12); // 12 s on the clock, past the 10 s
	r.live.delete(7001);
	await looks(r, 5);
	assert.deepEqual(r.typed, [], "the mark lapsed with its time");
});

test("RV7-F004: a fresh mark that came from a hand-over lapses after handMs if nothing was typed: a program the boss started right after is not typed over when the list later shows the shell alone", async () => {
	const r = rig();
	r.pane.processes = [SHELL, { pid: 5000, name: "node.exe", cmdline: "node build.js" }];
	r.standing.handed("wA", 7001); // the pi has left (7001 is not alive), and the boss's build already runs there
	await looks(r, 3);
	assert.deepEqual(r.typed, [], "a program runs: nothing typed");
	r.clock.advance(20_000);
	r.pane.processes = [SHELL]; // Windows lists the shell alone while the build goes on
	await looks(r, 3);
	assert.deepEqual(r.typed, [], "the hand-over is old: the pane is no longer believed to be a bare shell");
});

test("VM round 3: Herdr refusing `pane run` once is logged with its code and its whole stderr (not cut at 300 characters), and the command is typed again one launchMs later, not reported as a prompt that does not start", async () => {
	const r = rig();
	r.standing.handed("wA", 7001);
	r.refuse.push(Object.assign(new Error(`herdr pane run p1 node prompt failed: ${"x".repeat(100)}`), { stderr: `pane_not_ready: ${"herdr said this ".repeat(60)}END`, code: 1 }));
	await r.standing.tick(); // the look `handed` asked for has run before this one ends
	assert.deepEqual(r.typed, [], "refused");
	const err = said(r, "error").find((l) => l.facts.code === "prompt-typed");
	assert.ok(err, JSON.stringify(r.lines));
	assert.match(String(err.facts.text), /\(exit 1\)/);
	assert.match(String(err.facts.text), /pane_not_ready/);
	assert.match(String(err.facts.text), /END$/, "the end of a long stderr is kept");
	assert.ok(String(err.facts.text).length > 800);
	await looks(r, 1, 100);
	assert.deepEqual(r.typed, [], "not before launchMs");
	await looks(r, 1, 1000);
	assert.equal(r.typed.length, 1, "typed again");
	assert.equal(said(r, "prompt-not-starting").length + said(r, "prompt-lost").length, 0, "a refusal is neither");
});

test("VM round 3: three refusals in a row end the retries with one line, and the pane is not typed into again until a run frees it", async () => {
	const r = rig();
	r.standing.handed("wA");
	for (let i = 0; i < 5; i++) r.refuse.push(Object.assign(new Error("herdr failed"), { stderr: "pane_busy", code: 2 }));
	await r.standing.tick();
	await looks(r, 10);
	assert.deepEqual(r.typed, []);
	assert.equal(said(r, "error").filter((l) => l.facts.code === "prompt-typed").length, 3, "three tries");
	assert.equal(said(r, "prompt-not-typed").length, 1);
	assert.equal(said(r, "prompt-lost").length, 0, "and no second story about it");
	r.standing.freed("wA");
	r.refuse.length = 0;
	await looks(r, 2);
	assert.equal(r.typed.length, 1, "a run's end gives the pane back");
});

test("RV8-F001: a `pane run` killed by the timeout (no exit code, no stderr) may have typed the command: it counts as typed and is not typed again, said once", async () => {
	const r = rig();
	r.standing.handed("wA");
	r.refuse.push(Object.assign(new Error("herdr pane run p1 node prompt failed: Command failed"), { stderr: "", code: undefined, killed: true, signal: "SIGTERM" }));
	await r.standing.tick();
	await looks(r, 10);
	assert.equal(r.attempts, 1, "the command is not typed a second time into a prompt that may be running");
	assert.deepEqual(r.typed, []);
	const err = said(r, "error").filter((l) => l.facts.code === "prompt-typed");
	assert.equal(err.length, 1, "said once");
	assert.match(String(err[0]!.facts.text), /SIGTERM|killed/);
	assert.equal(said(r, "prompt-not-typed").length, 0, "that is no run of refusals");
});

test("RV8-F001: a kill with no signal name (killed alone) and a refusal Herdr coded as a non-zero exit are told apart", async () => {
	const killed = rig();
	killed.standing.handed("wA");
	killed.refuse.push(Object.assign(new Error("failed"), { stderr: "", killed: true }));
	await killed.standing.tick();
	await looks(killed, 5);
	assert.equal(killed.attempts, 1);
	const refused = rig();
	refused.standing.handed("wA");
	refused.refuse.push(Object.assign(new Error("failed"), { stderr: "pane_busy", code: 3 }));
	await refused.standing.tick();
	await looks(refused, 2);
	assert.equal(refused.typed.length, 1, "a coded refusal is tried again");
});

test("RV10-F004 (M11): a hand-over after three refusals ends the give-up: the resident's pi is gone, so the pane is typed into again", async () => {
	const r = rig();
	r.standing.handed("wA");
	for (let i = 0; i < 3; i++) r.refuse.push(Object.assign(new Error("herdr failed"), { stderr: "pane_busy", code: 2 }));
	await r.standing.tick();
	await looks(r, 10);
	assert.equal(said(r, "prompt-not-typed").length, 1, "gave up");
	assert.equal(r.attempts, 3);
	r.standing.handed("wA");
	await looks(r, 3);
	assert.equal(r.typed.length, 1, "a resident handed the pane over again: the give-up is over");
});

test("RV10-F004 (M12): a `pane run` that failed with a string code (ENOENT: the CLI was not found; a full output buffer) and no kill is not a refusal Herdr gave: it counts as typed and is not typed again", async () => {
	const r = rig();
	r.standing.handed("wA");
	r.refuse.push(Object.assign(new Error("spawn herdr ENOENT"), { stderr: "", code: "ENOENT" }));
	await r.standing.tick();
	await looks(r, 10);
	assert.equal(r.attempts, 1, "no second typing into a pane the first may have reached");
	assert.deepEqual(r.typed, []);
	assert.equal(said(r, "prompt-not-typed").length, 0, "that is no run of refusals");
});

test("RV8-F003: where Herdr gives the foreground group (macOS, Linux) three refusals end the typing too: one line, and no more attempts, until a run frees the pane", async () => {
	const r = rig("darwin");
	for (let i = 0; i < 50; i++) r.refuse.push(Object.assign(new Error("herdr failed"), { stderr: "pane_busy", code: 2 }));
	await looks(r, 40);
	assert.equal(r.attempts, 3, "three tries, then nothing");
	assert.equal(said(r, "error").filter((l) => l.facts.code === "prompt-typed").length, 3);
	assert.equal(said(r, "prompt-not-typed").length, 1);
	assert.match(String(said(r, "prompt-not-typed")[0]!.facts.text), /until a run frees the pane/);
	r.standing.freed("wA");
	r.refuse.length = 0;
	await r.standing.tick();
	assert.equal(r.typed.length, 1, "a run's end gives the pane back");
});

test("RV7-F003: a held service on Windows starts again by itself only when the programs that held the pane are gone themselves (not alive, not listed) and the list shows the shell alone at two looks in a row", async () => {
	const r = rig("win32");
	r.busy = true;
	r.busyPids = [5000];
	r.live.add(5000);
	r.pane.processes = [SHELL]; // Windows lists the shell alone while the boss's build goes on
	await looks(r, 4);
	assert.equal(r.freed, 0, "the program lives: a shells-only list is no proof that it ended");
	r.live.delete(5000);
	r.pane.processes = [SHELL, { pid: 5000, name: "node.exe" }];
	await looks(r, 3);
	assert.equal(r.freed, 0, "still listed");
	r.pane.processes = [SHELL];
	await looks(r, 1);
	assert.equal(r.freed, 0, "one look is not two");
	await looks(r, 1);
	assert.equal(r.freed, 1, "gone, and the shell alone twice");
	const none = rig("win32");
	none.busy = true;
	none.pane.processes = [SHELL];
	await looks(none, 4);
	assert.equal(none.freed, 0, "a hold that named no PID is left to Retry or a word to the tower");
});

test("RV7-F003: where Herdr gives the foreground group the held service starts again as soon as the group is the shell's", async () => {
	const unix = rig("darwin");
	unix.busy = true;
	await looks(unix, 2);
	assert.ok(unix.freed > 0);
});

// RV10-F002 (the boss's rule F10: never type into a pane that runs a program). The run whose agent start Herdr refused frees its pane, and the service is held with no busy list (the process table did not answer, the program
// is a nested shell, Herdr's code was another one): the list of shells the look sees is the one a running program leaves too.
test("RV10-F002: a held service on Windows with no busy proof types nothing, however fresh the pane is marked; Retry (the service no longer held) gives the pane back", async () => {
	const r = rig("win32");
	r.state = "held";
	r.standing.freed("wA");
	await looks(r, 5);
	assert.deepEqual(r.typed, [], "held, no busy list: no typing into the boss's program");
	r.state = "standing";
	await looks(r, 1);
	assert.equal(r.typed.length, 1, "the service is no longer held: the fresh pane is typed into");
	const unix = rig("darwin");
	unix.state = "held";
	await looks(unix, 1);
	assert.equal(unix.typed.length, 1, "where Herdr gives the foreground group the group decides, held or not");
});

test("RV10-F002: a pane freed by a run whose pi never started in it is not marked fresh: on Windows the prompt is not typed into it, and the next run's end that did start pi marks it fresh again", async () => {
	const r = rig("win32");
	r.standing.freed("wA", false);
	await looks(r, 5);
	assert.deepEqual(r.typed, [], "the shells-only list is no proof that nothing runs below the shell");
	assert.equal(said(r, "prompt-lost").length, 1, "said once");
	r.standing.freed("wA");
	await looks(r, 1);
	assert.equal(r.typed.length, 1);
	const unix = rig("darwin");
	unix.standing.freed("wA", false);
	await looks(unix, 1);
	assert.equal(unix.typed.length, 1, "where Herdr gives the foreground group the group decides");
});

test("idleShell is unchanged: a shells-only list is idle only for a pane known fresh", () => {
	const info = { foreground_processes: [{ name: "powershell.exe" }] };
	assert.equal(idleShell(info, false, false), false);
	assert.equal(idleShell(info, true, false), true);
});
