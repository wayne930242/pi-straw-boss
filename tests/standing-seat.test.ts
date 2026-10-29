import assert from "node:assert/strict";
import { test } from "node:test";
import { createStanding, type StandingTarget } from "../src/server/standing.ts";
import type { Pane } from "../src/herdr.ts";
import { fakeClock } from "./fake-clock.ts";

// What the standing look does about the seat (RVSEAT-F001, F002): the proof is asked of a listing read just before the typing, a service that is lost types nothing from a look it had in flight, and the pane is
// typed into once whoever stands for it. These run the standing logic itself against a clock the test moves (no server, no sleeps).

function rig() {
	const clock = fakeClock(1_000_000);
	const typed: string[] = [], lines: string[] = [];
	/** The terminal each successive listing of the pane answers; the last one repeats. */
	let terminals: (string | undefined)[] = ["term_1"];
	let reads = 0;
	/** While set, the process table read waits for it, and `reached` says it has been asked. */
	let gate: Promise<void> | undefined;
	let reached: () => void = () => {};
	const arrived = new Promise<void>((resolve) => (reached = resolve));
	let refuse = false;
	const run = async (args: string[]) => {
		if (args[1] === "process-info") {
			reached();
			await gate;
			return JSON.stringify({ result: { process_info: { shell_pid: 900, foreground_process_group_id: 900, foreground_processes: [{ pid: 900, name: "zsh" }] } } });
		}
		if (args[1] === "run") {
			if (refuse) throw Object.assign(new Error("refused"), { code: 1, stderr: "refused" });
			typed.push(args[3]!);
		}
		return "{}";
	};
	const world = async () => {
		const terminal = terminals[Math.min(reads++, terminals.length - 1)];
		return { panes: [{ pane_id: "p1", tab_id: "t1", ...(terminal ? { terminal_id: terminal } : {}) } as Pane], workspaces: [], tabs: [] };
	};
	const standing = createStanding({
		run, api: async () => undefined, world, sleep: clock.sleep, now: clock.now, log: { line: (event) => void lines.push(event), hide: () => {} },
		command: () => "node prompt", platform: "darwin", alive: () => false, timers: { launchMs: 250 },
	});
	const target = (over: Partial<StandingTarget> = {}): StandingTarget => ({ workspace: "wA", label: () => "Alpha", pane: () => "p1", live: () => true, status: () => ({ state: "standing", queued: 0 }) as never, ...over });
	return {
		standing, clock, typed, lines, target, arrived,
		terminals: (...t: (string | undefined)[]) => ((terminals = t), (reads = 0)),
		hold: () => { let release: () => void = () => {}; gate = new Promise<void>((resolve) => (release = resolve)); return () => { gate = undefined; release(); }; },
		refuse: (on: boolean) => (refuse = on),
	};
}

test("RVSEAT-F001: the seat is asked of a listing read just before the typing, not of the tick's: a pane that is in another terminal by then is not typed into", async () => {
	const r = rig();
	r.standing.attach(r.target({ seated: (pane) => pane?.terminal_id === "term_1" }));
	r.terminals("term_1", "term_2"); // the tick's listing, then the one read with the process table
	await r.standing.tick();
	assert.deepEqual(r.typed, []);
	const control = rig();
	control.standing.attach(control.target({ seated: (pane) => pane?.terminal_id === "term_1" }));
	await control.standing.tick();
	assert.equal(control.typed.length, 1, "the same pane in the proven terminal is typed into");
});

test("RVSEAT-F001: a listing that fails when the typing is about to be made proves nothing: nothing is typed", async () => {
	const r = rig();
	let reads = 0;
	r.standing.attach(r.target({ seated: (pane) => (reads++, pane !== undefined) }));
	const failing = createStanding({
		run: async (args) => (args[1] === "process-info" ? JSON.stringify({ result: { process_info: { shell_pid: 900, foreground_process_group_id: 900, foreground_processes: [{ pid: 900, name: "zsh" }] } } }) : (r.typed.push("typed"), "{}")),
		api: async () => undefined, sleep: r.clock.sleep, now: r.clock.now, log: { line: () => {}, hide: () => {} }, command: () => "node prompt", platform: "darwin", alive: () => false,
		world: (() => { let n = 0; return async () => { if (n++ > 0) throw new Error("Herdr does not answer"); return { panes: [{ pane_id: "p1", tab_id: "t1" } as Pane], workspaces: [], tabs: [] }; }; })(),
	});
	failing.attach(r.target({ seated: (pane) => pane !== undefined }));
	await failing.tick();
	assert.deepEqual(r.typed, []);
});

test("RVSEAT-F002: a look that is in flight when its service is detached types nothing", async () => {
	const r = rig();
	r.standing.attach(r.target({ seated: () => true }));
	const release = r.hold();
	const looking = r.standing.tick();
	await r.arrived; // the look waits on the process table
	await r.standing.detach("wA");
	release();
	await looking;
	assert.deepEqual(r.typed, []);
});

test("RVSEAT-F002: the pane is typed into once whoever stands for it: a service that takes the pane over waits for the command to start, as the first would, and typedSince tells the desk", async () => {
	const r = rig();
	r.standing.attach(r.target({ seated: () => true }), true);
	const began = r.clock.now();
	await r.standing.tick();
	assert.equal(r.typed.length, 1);
	assert.equal(r.standing.typedSince("p1", "term_1", began + 1_000), true, "in this terminal, whenever the claim says the pane was made");
	assert.equal(r.standing.typedSince("p1", "term_2", began), false, "another terminal under the same pane id has not been typed into");
	assert.equal(r.standing.typedSince("p2", "term_1", began), false);
	await r.standing.detach("wA");
	r.standing.attach(r.target({ seated: () => true }), true); // the service of the lost workspace is replaced by one for the base
	r.clock.advance(100);
	await r.standing.tick();
	assert.equal(r.typed.length, 1, "the command typed by the first service is waited on");
	r.clock.advance(300); // the command did not start (nothing polls): typed again after the wait, as one service alone would
	await r.standing.tick();
	assert.equal(r.typed.length, 2);
});

test("RVSEAT-F002: a typing on record belongs to its terminal: a new service for the same pane id in another terminal is not made to wait, and a new Herdr clears the record", async () => {
	const r = rig();
	r.standing.attach(r.target({ seated: () => true }), true);
	await r.standing.tick();
	assert.equal(r.typed.length, 1);
	await r.standing.detach("wA");
	r.standing.attach(r.target({ seated: () => true }), true);
	r.terminals("term_9"); // the pane id was given to another terminal
	r.clock.advance(10);
	await r.standing.tick();
	assert.equal(r.typed.length, 2, "nothing was typed into this terminal yet");
	r.standing.reset();
	assert.equal(r.standing.typedSince("p1", "term_9", 0), false);
});

test("RVSEAT-F002: a typing Herdr refuses is no typing: it is not on record, and the desk's claim is not told the pane was typed into", async () => {
	const r = rig();
	r.standing.attach(r.target({ seated: () => true }), true);
	r.refuse(true);
	await r.standing.tick();
	assert.deepEqual(r.typed, []);
	assert.equal(r.standing.typedSince("p1", "term_1", 0), false);
	r.refuse(false);
	r.clock.advance(300);
	await r.standing.tick();
	assert.equal(r.typed.length, 1);
	assert.equal(r.standing.typedSince("p1", "term_1", 0), true);
});

test("RVSEAT-F002: a give-back (a run's end, Retry) ends the wait on the command typed before it, for the pane as for the service: the prompt is typed again at once", async () => {
	const r = rig();
	r.standing.attach(r.target({ seated: () => true }), true);
	await r.standing.tick();
	assert.equal(r.typed.length, 1);
	r.clock.advance(10); // inside the wait on the command typed
	await r.standing.tick();
	assert.equal(r.typed.length, 1, "waited on");
	r.standing.freed("wA");
	await r.standing.tick();
	assert.equal(r.typed.length, 2, "given back: typed again inside the wait");
});
