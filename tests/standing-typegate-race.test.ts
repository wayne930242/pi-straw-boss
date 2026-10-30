import assert from "node:assert/strict";
import { test } from "node:test";
import { createStanding, type StandingTarget } from "../src/server/standing.ts";
import type { Pane } from "../src/herdr.ts";
import { fakeClock } from "./fake-clock.ts";

// A poll that arrives while the look awaits the stand-in's release (RVTG-F001, RVTG-F002).
function rig(fresh: boolean, runSoon: boolean) {
	const clock = fakeClock(1_000_000);
	const typed: string[] = [], lines: string[] = [];
	let standing!: ReturnType<typeof createStanding>;
	let pollOnRelease = false;
	const target: StandingTarget = {
		workspace: "wA", label: () => "Alpha", pane: () => "p1", live: () => true, status: () => ({ state: "standing", queued: 0 }) as never,
		runWithin: () => runSoon,
	};
	const run = async (args: string[]) => {
		if (args[1] === "process-info") return JSON.stringify({ result: { process_info: { shell_pid: 900, foreground_process_group_id: 900, foreground_processes: [{ pid: 900, name: "powershell.exe" }] } } });
		if (args[1] === "run") typed.push(args[3]!);
		return "{}";
	};
	const api = async (method: string) => {
		if (method === "pane.release_agent" && pollOnRelease) {
			await new Promise((r) => setImmediate(r));
			standing.poll("wA", 4321); // the prompt's poll lands while Herdr answers the release
		}
	};
	standing = createStanding({
		run, api, world: async () => ({ panes: [{ pane_id: "p1", tab_id: "t1" } as Pane], workspaces: [], tabs: [] }), // Herdr did not keep the stand-in label
		sleep: clock.sleep, now: clock.now, log: { line: (event) => void lines.push(event), hide: () => {} },
		command: () => "node prompt", platform: "win32", alive: () => false, timers: { launchMs: 250, handMs: 10_000 },
	});
	standing.attach(target, fresh);
	return { standing, clock, typed, lines, arm: () => (pollOnRelease = true) };
}

// RVTG-F001: the one behaviour change of the typegate refactor. The run-soon rule no longer re-reads `present` after the release, so a poll that lands then says "run-soon" and logs no spurious prompt-lost.
test("a poll that lands while the stand-in is released, with a run due within seconds: nothing is typed and no prompt-lost is logged", async () => {
	const r = rig(false, true);
	r.standing.poll("wA", 4321);
	await r.standing.tick(); // reports the stand-in
	r.clock.advance(7000); // the prompt's polls stall past presentMs
	r.arm();
	await r.standing.tick();
	assert.equal(r.lines.filter((l) => l === "prompt-lost").length, 0);
	assert.equal(r.typed.length, 0);
});

// RVTG-F002: a fresh Windows pane whose prompt polls again during the release is not typed into.
test("a fresh pane whose prompt polls while the stand-in is released is not typed into", async () => {
	const r = rig(true, false);
	r.standing.poll("wA", 4321);
	await r.standing.tick();
	r.clock.advance(7000);
	r.arm();
	await r.standing.tick();
	assert.equal(r.typed.length, 0);
});
