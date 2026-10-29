import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Pane } from "../src/herdr.ts";
import type { Entry } from "../src/orphan.ts";
import { FOLLOW_UP, message, restored } from "../src/restored.ts";
import { until, World } from "./fakes.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-restored-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// pi-herdr-agents' process-wide slot; its `runningSubagents` map is the registry of the children this process's watchers deliver.
const SLOT = Symbol.for("pi-subagents/runtime");
const global = globalThis as Record<symbol, unknown>;
const registry = (...ids: string[]) => (global[SLOT] = { runningSubagents: new Map(ids.map((id) => [id, {}])) });
afterEach(() => void delete global[SLOT]);
let count = 0;

const KID = "kid-1";
/** The launcher's session file, one child's activity file, launch script (header as pi-herdr-agents writes it) and session file, laid out as pi-herdr-agents does. */
function layout(extra = "") {
	const dir = join(scratch, `s${++count}`), art = join(dir, "artifacts", "launcher-1");
	mkdirSync(join(art, "subagent-activity"), { recursive: true });
	mkdirSync(join(art, "subagent-scripts"), { recursive: true });
	const kidFile = join(dir, `2026-10-18T00-00-01-000Z_${KID}-0a1b2c3d-4e5f6a7b-8c9d.jsonl`);
	writeFileSync(join(art, "subagent-activity", `${KID}.json`), JSON.stringify({ version: 1, runningChildId: KID, createdAt: 111, phase: "active" }));
	const script = join(art, "subagent-scripts", `kid-one-${KID}.sh`);
	const header = (surface: string, session = kidFile, flags = "") => writeFileSync(script, `#!/bin/bash\n# Subagent launch script for kid-one\n# Generated: 2026-10-18T00:00:01.000Z\n# Session: ${session}\n# Surface: ${surface}\ncd '/x' && PI_SUBAGENT_NAME='kid-one' ${flags}PI_SUBAGENT_ID='${KID}' pi --session '${session}' -e '/p/subagent-done.ts'${extra}; echo '__SUBAGENT_DONE_'$?'__'\n`);
	header("w:p2");
	return { dir, art, kidFile, script, header, launcher: join(dir, "2026-10-18T00-00-00-000Z_launcher-1.jsonl"), exit: `${kidFile}.exit` };
}

function rig(options: { tower?: boolean; platform?: string } = {}) {
	const files = layout();
	const state = {
		// The restored pane: Herdr's pane id of the launch script's surface, the child's session file, an idle pi on its own.
		panes: [{ pane_id: "w:p2", tab_id: "w:t1", label: "kid-one", agent: "pi", agent_status: "idle", agent_session: { value: files.kidFile }, terminal_id: "t1" }] as Pane[],
		processes: [{ argv0: "pi", name: "node" }] as { argv?: string[]; argv0?: string; name?: string }[] | undefined,
		infos: 0,
		lists: 0,
		// The terminal the child was seen in while it ran as pi-herdr-agents started it; a restore gave the pane another one.
		transcript: [{ type: "custom", customType: "straw-boss", data: { seen: KID, terminal: "t0" } }] as Entry[],
		commands: [] as string[][],
		resumed: [] as { text: string; details: unknown }[],
		notes: [] as { text: string; level?: string }[],
		closeFails: false,
		closeKeeps: false,
		onClose: undefined as (() => void) | undefined,
		resumeFails: false,
		tower: Boolean(options.tower),
	};
	const watch = () => restored({
		run: async (args) => {
			state.commands.push(args);
			if (args[1] === "process-info") return state.infos++, JSON.stringify({ result: { process_info: { foreground_processes: state.processes } } });
			if (args[1] === "close") {
				state.onClose?.();
				if (state.closeFails) throw new Error("herdr: pane_not_found");
				if (!state.closeKeeps) state.panes = state.panes.filter((p) => p.pane_id !== args[2]);
				return "{}";
			}
			return state.lists++, JSON.stringify({ result: { panes: state.panes } });
		},
		sleep: async () => {},
		file: () => files.launcher,
		entries: () => state.transcript,
		active: () => !state.tower,
		type: "straw-boss",
		remember: (data) => state.transcript.push({ type: "custom", customType: "straw-boss", data }),
		platform: options.platform,
		resume: (text, details) => {
			if (state.resumeFails) throw new Error("stale context");
			state.resumed.push({ text, details });
		},
		tell: (text, level) => state.notes.push({ text, level }),
	});
	const watcher = watch();
	const polls = async (n: number, w = watcher) => {
		for (let i = 0; i < n; i++) await w.poll();
	};
	const closes = () => state.commands.filter((c) => c[1] === "close");
	return { ...files, state, watch, watcher, polls, closes };
}

test("a restored plain pi in the pane of a lost run is closed and its launcher is asked once, on the second look, to resume it", async () => {
	registry();
	const { state, polls, watcher, closes, kidFile } = rig();
	await polls(1);
	assert.equal(closes().length, 0, "the first look only notes it: a pane still coming up must not be closed");
	assert.equal(state.resumed.length, 0);
	await polls(1);
	assert.deepEqual(closes(), [["pane", "close", "w:p2"]], "only that pane");
	assert.equal(state.resumed.length, 1);
	const { text, details } = state.resumed[0]!;
	assert.match(text, /subagent_resume/);
	assert.match(text, new RegExp(`sessionPath ${kidFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	assert.match(text, /kid-one \(run kid-1\)/);
	assert.ok(text.includes(JSON.stringify(FOLLOW_UP)), "the follow-up that tells the child to finish and report is quoted for the launcher to pass");
	assert.deepEqual(details, { runs: [{ id: KID, name: "kid-one", sessionPath: kidFile, pane: "w:p2" }] });
	assert.deepEqual(state.transcript.slice(1).map((e) => e.data), [{ closing: KID }, { resumed: KID }]);
	assert.deepEqual(state.notes.map((n) => n.level), [undefined]);
	await polls(5, watcher);
	assert.equal(state.resumed.length, 1, "once per run");
	assert.equal(closes().length, 1);
});

test("the run is written to the session before the pane is closed, so a failing step is never repeated", async () => {
	registry();
	const { state, polls, watcher, watch } = rig();
	state.closeFails = true;
	await polls(2);
	assert.equal(state.resumed.length, 0, "nothing is resumed while the old pi may still hold the session file");
	assert.deepEqual(state.transcript.slice(1).map((e) => e.data), [{ closing: KID }, { gaveUp: KID }]);
	assert.deepEqual(state.notes.map((n) => n.level), ["warning"]);
	assert.match(state.notes[0]!.text, /could not close the restored pane w:p2 of kid-one/);
	state.closeFails = false;
	await polls(5, watcher);
	await polls(5, watch()); // a reload or restart reads the record back
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 1);
	assert.equal(state.resumed.length, 0);
});

test("a pane that stays open after the close is not resumed", async () => {
	registry();
	const { state, polls } = rig();
	state.closeKeeps = true;
	await polls(2);
	assert.equal(state.resumed.length, 0);
	assert.match(state.notes[0]!.text, /the pane is still open/);
	assert.equal(state.notes[0]!.level, "warning");
});

test("a request the session cannot take is shown as a warning that names the runs, and is not tried again", async () => {
	registry();
	const { state, polls, kidFile } = rig();
	state.resumeFails = true;
	await polls(8);
	assert.equal(state.notes.length, 1);
	assert.equal(state.notes[0]!.level, "warning");
	assert.match(state.notes[0]!.text, new RegExp(`kid-one \\(${kidFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`));
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 1);
});

test("a pane that still runs the launch script is not a restored one", async () => {
	registry();
	const { state, polls, script } = rig();
	state.processes = [{ argv0: "pi", name: "node" }, { argv: ["bash", script], argv0: "bash", name: "bash" }];
	await polls(6);
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 0);
	assert.equal(state.resumed.length, 0);
});

test("a run another session resumed (a resume script, a pane of its own) is not touched", async () => {
	registry();
	const { state, polls, art } = rig();
	// The resumed run sits in a new pane, running a script named by the resume time.
	state.panes[0]!.pane_id = "w:p9";
	state.processes = [{ argv0: "pi", name: "node" }, { argv: ["bash", join(art, "subagent-scripts", "kid-one-resume-1760000000000.sh")], argv0: "bash", name: "bash" }];
	await polls(10);
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 0);
	// And even a plain pi in a pane the launch script never named is somebody else's.
	state.processes = [{ argv0: "pi", name: "node" }];
	await polls(2);
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 0);
	assert.equal(state.resumed.length, 0);
});

test("a pane that now holds another session, or is not an agent, is left alone", async () => {
	registry();
	const { state, polls } = rig();
	state.panes[0]!.agent_session = { value: "/s/2026-10-18T00-00-09-000Z_someone-else.jsonl" };
	await polls(4);
	state.panes[0]!.agent_session = undefined;
	state.panes[0]!.agent = undefined;
	await polls(4);
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 0);
	assert.equal(state.infos, 0, "its processes are not even read");
});

test("a run the launcher still tracks is never touched, and Herdr is not even read", async () => {
	registry(KID);
	const { state, polls } = rig();
	await polls(6);
	assert.equal(state.lists, 0);
	assert.equal(state.commands.length, 0);
});

test("without a readable registry nothing is known to be lost, so nothing is done", async () => {
	const { state, polls } = rig();
	await polls(4);
	global[SLOT] = { runningSubagents: [KID] };
	await polls(4);
	assert.equal(state.commands.length, 0);
});

test("a run whose result is already in the transcript is not touched, and one with a similar id does not hide it", async () => {
	registry();
	const { state, polls, kidFile } = rig();
	for (const customType of ["subagent_result", "subagent_ping"]) {
		state.transcript.length = 0;
		state.transcript.push({ type: "custom_message", customType, details: { sessionFile: kidFile } });
		await polls(4);
		assert.equal(state.commands.length, 0, customType);
	}
	state.transcript.length = 0;
	state.transcript.push({ type: "custom_message", customType: "subagent_result", details: { sessionFile: kidFile.replace("kid-1-", "kid-10-") } }, { type: "custom_message", customType: "subagent_status", details: { sessionFile: kidFile } });
	await polls(2);
	assert.equal(state.resumed.length, 1);
});

test("a run that already wrote its exit sidecar, one that was asked to report, and one that was resumed are left alone", async () => {
	registry();
	const first = rig();
	writeFileSync(first.exit, JSON.stringify({ type: "done" }));
	await first.polls(6);
	assert.equal(first.state.commands.length, 0, "the sidecar is read from the disk, and Herdr is not asked");
	assert.equal(first.state.resumed.length, 0);
	const second = rig();
	second.state.transcript.push({ type: "custom", customType: "straw-boss", data: { nudged: KID } });
	await second.polls(4, second.watch()); // a session start reads the record back
	assert.equal(second.state.commands.length, 0);
	const third = rig();
	third.state.transcript.push({ type: "custom", customType: "straw-boss", data: { resumed: KID } }, { type: "custom", customType: "other", data: { resumed: KID } });
	await third.polls(4, third.watch());
	assert.equal(third.state.commands.length, 0);
});

test("a persistent specialist, which pi-herdr-agents cannot resume, is left alone", async () => {
	registry();
	const persistent = rig(), ordinary = rig();
	persistent.header("w:p2", persistent.kidFile, "PI_SUBAGENT_PERSISTENT=1 ");
	await persistent.polls(6);
	assert.equal(persistent.closes().length, 0);
	assert.equal(persistent.state.resumed.length, 0);
	await ordinary.polls(2);
	assert.equal(ordinary.state.resumed.length, 1, "an ordinary run in the same circumstances is resumed");
});

test("a child that is still working or asking a question is not stranded, and one that is idle again is", async () => {
	registry();
	const { state, polls } = rig();
	for (const status of ["working", "blocked", "unknown"]) {
		state.panes[0]!.agent_status = status;
		await polls(3);
	}
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 0);
	state.panes[0]!.agent_status = "done";
	await polls(2);
	assert.equal(state.resumed.length, 1);
});

test("a pane has to be seen restored twice in a row", async () => {
	registry();
	const { state, polls } = rig();
	await polls(1);
	state.panes[0]!.agent_status = "working";
	await polls(1);
	state.panes[0]!.agent_status = "idle";
	await polls(1);
	assert.equal(state.resumed.length, 0);
	await polls(1);
	assert.equal(state.resumed.length, 1);
});

test("a pane whose processes cannot be read is unknown, not restored, and is looked at again", async () => {
	registry();
	const { state, polls } = rig();
	const processes = state.processes;
	for (const unreadable of [undefined, []]) {
		state.processes = unreadable;
		await polls(3);
		assert.equal(state.resumed.length, 0);
	}
	state.processes = processes;
	await polls(2);
	assert.equal(state.resumed.length, 1, "a miss is only a count, and the run had not been given up on");
});

test("RV2-F003: a run that can never qualify does not keep the pane list read, one that can still be noted does", async () => {
	registry(KID);
	const persistent = rig(), ordinary = rig();
	persistent.header("w:p2", persistent.kidFile, "PI_SUBAGENT_PERSISTENT=1 ");
	for (const r of [persistent, ordinary]) {
		r.state.panes.length = 0;
		r.state.transcript.length = 0; // never seen running
	}
	await persistent.polls(10, persistent.watch());
	await ordinary.polls(10, ordinary.watch());
	assert.equal(persistent.state.lists, 0, "a persistent specialist cannot be resumed, so no sighting of it is worth a list");
	assert.equal(ordinary.state.lists, 10, "a running child not yet seen is looked for on every look");
	const foreign = rig();
	foreign.header("w:p2", "/elsewhere/not-this-run.jsonl");
	foreign.state.transcript.length = 0;
	await foreign.polls(10, foreign.watch());
	assert.equal(foreign.state.lists, 0, "a script that names another run's session is no run");
});

test("a run without a restored pane is given up on after a few looks", async () => {
	registry();
	const { state, polls } = rig();
	state.panes.length = 0;
	await polls(20);
	assert.equal(state.lists, 8);
});

test("a tower never acts, and a launch script the session did not write is no run", async () => {
	registry();
	const { state, polls } = rig({ tower: true });
	await polls(6);
	assert.equal(state.commands.length, 0);
	const other = rig();
	other.header("w:p2", other.kidFile.replace("kid-1-", "kid-2-"));
	await other.polls(6);
	assert.equal(other.state.commands.filter((c) => c[1] === "close").length, 0);
});

test("a managed-worktree run keeps its pane and the launcher is told that subagent_resume is no way back for it", async () => {
	registry();
	const { state, polls, art, kidFile } = rig();
	mkdirSync(join(art, "worktree-runs"), { recursive: true });
	writeFileSync(join(art, "worktree-runs", `${KID}.json`), JSON.stringify({ state: "running", id: KID, path: "/wt/feat", branch: "feat/x" }));
	await polls(2);
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 0, "the pane is the retained workspace's");
	assert.equal(state.resumed.length, 1);
	const { text, details } = state.resumed[0]!;
	assert.match(text, /managed-worktree runs/);
	assert.match(text, /does not reattach a worktree run's lifecycle/);
	assert.match(text, /do not call it for them/);
	assert.match(text, /pane w:p2, worktree \/wt\/feat, branch feat\/x/);
	assert.doesNotMatch(text, /Resume each one now/);
	assert.deepEqual(details, { runs: [{ id: KID, name: "kid-one", sessionPath: kidFile, pane: "w:p2", worktree: { path: "/wt/feat", branch: "feat/x" } }] });
	await polls(5);
	assert.equal(state.resumed.length, 1);
});

test("two polls at once act once, and a stopped watcher acts no more", async () => {
	registry();
	const { state, polls, watcher } = rig();
	await polls(1);
	await Promise.all([watcher.poll(), watcher.poll()]);
	assert.equal(state.resumed.length, 1);
	const again = rig();
	await again.polls(1);
	again.watcher.stop();
	await again.polls(4);
	assert.equal(again.state.resumed.length, 0);
	assert.equal(again.closes().length, 0);
});

test("RV-F001: a launch script on a Windows path is still a script, and on Windows a pane with no script in view is not plain", async () => {
	registry();
	const first = rig();
	first.state.processes = [{ argv0: "pi", name: "node" }, { argv: ["bash", "C:\\Users\\x\\artifacts\\l\\subagent-scripts\\kid-one-kid-1.sh"], argv0: "bash", name: "bash" }];
	await first.polls(6);
	assert.equal(first.closes().length, 0);
	const win = rig({ platform: "win32" });
	await win.polls(6);
	assert.equal(win.closes().length, 0, "the list of a Windows pane cannot prove that no script runs");
	assert.equal(win.state.resumed.length, 0);
});

test("RV-F002: plain needs exactly one pi and an argv for every other process", async () => {
	registry();
	const cases: [string, { argv?: string[]; argv0?: string; name?: string }[], boolean][] = [
		["two pi", [{ argv0: "pi" }, { argv0: "pi" }], false],
		["no pi", [{ argv0: "node", argv: ["node", "x.js"] }], false],
		["an unreadable other process", [{ argv0: "pi" }, { argv0: "bash", name: "bash" }], false],
		["an empty argv", [{ argv0: "pi" }, { argv0: "bash", argv: [] }], false],
		["a readable other process", [{ argv0: "pi" }, { argv0: "claude", argv: ["claude", "--x"] }], true],
	];
	for (const [label, processes, closes] of cases) {
		const r = rig();
		r.state.processes = processes;
		await r.polls(3);
		assert.equal(r.closes().length, closes ? 1 : 0, label);
	}
});

test("RV-F003: a pane is restored only when its terminal differs from the one the running child was seen in", async () => {
	registry();
	const same = rig();
	same.state.transcript[0] = { type: "custom", customType: "straw-boss", data: { seen: KID, terminal: "t1" } };
	await same.polls(8, same.watch());
	assert.equal(same.closes().length, 0, "the same terminal: a pi someone started by hand in the pane");
	const none = rig();
	none.state.transcript.length = 0;
	await none.polls(8, none.watch());
	assert.equal(none.closes().length, 0, "never seen as a running child: unknown");
	assert.equal(none.state.resumed.length, 0);
	const noTerminal = rig();
	delete noTerminal.state.panes[0]!.terminal_id;
	await noTerminal.polls(8, noTerminal.watch());
	assert.equal(noTerminal.closes().length, 0, "a Herdr that reports no terminal proves nothing");
});

test("RV-F003: the terminal of a child that runs as started is noted once, in the session", async () => {
	registry(KID);
	const { state, polls, script, watch } = rig();
	state.transcript.length = 0;
	const w = watch();
	state.processes = [{ argv0: "pi" }, { argv: ["bash", script], argv0: "bash", name: "bash" }];
	await polls(4, w);
	assert.deepEqual(state.transcript.map((e) => e.data), [{ seen: KID, terminal: "t1" }]);
	state.processes = [{ argv0: "pi" }];
	await polls(2, w);
	assert.equal(state.transcript.length, 1, "a plain pi's terminal is no sighting of the child");
});

test("RV-F004: a run cut off between the close and the request is asked for by the next instance, once", async () => {
	registry();
	const { state, polls, watch } = rig();
	state.transcript.push({ type: "custom", customType: "straw-boss", data: { closing: KID } });
	state.panes.length = 0; // the pane was closed
	await polls(1, watch());
	assert.equal(state.resumed.length, 1);
	assert.equal(state.commands.filter((c) => c[1] === "close").length, 0);
	assert.deepEqual(state.transcript.slice(-1).map((e) => e.data), [{ resumed: KID }]);
	await polls(3, watch());
	assert.equal(state.resumed.length, 1);
});

test("RV2-F002: a closing record whose pane is still open was never closed, so the run goes through the proof of a restore again", async () => {
	registry();
	const { state, polls, watch, closes } = rig();
	state.transcript.push({ type: "custom", customType: "straw-boss", data: { closing: KID } });
	await polls(1, watch());
	assert.equal(state.resumed.length, 0, "the first look only notes it, as for any run");
	assert.deepEqual(state.transcript.slice(-1).map((e) => e.data), [{ unclosed: KID }]);
	await polls(2, watch()); // a reload reads `unclosed` back and does not take the run for cut off
	assert.deepEqual(closes(), [["pane", "close", "w:p2"]], "the restored pane is closed now, once");
	assert.equal(state.resumed.length, 1);
	assert.deepEqual(state.transcript.slice(-2).map((e) => e.data), [{ closing: KID }, { resumed: KID }]);
	assert.deepEqual(state.notes.map((n) => n.level), [undefined]);
});

test("RV2-F002: a closing record whose pane no longer qualifies is given up on with one warning that names the session", async () => {
	registry();
	const { state, polls, watch, kidFile, closes } = rig();
	state.transcript.length = 0; // the restart came before the first look: nothing proves a restore
	state.transcript.push({ type: "custom", customType: "straw-boss", data: { closing: KID } });
	await polls(20, watch());
	assert.equal(closes().length, 0);
	assert.equal(state.resumed.length, 0);
	assert.deepEqual(state.notes.map((n) => n.level), ["warning"]);
	assert.ok(state.notes[0]!.text.includes(kidFile));
	assert.equal(state.lists, 8, "eight looks, then it is left alone");
});

test("RV-F004: a watcher stopped during the close sends nothing, and leaves `closing` without `resumed`", async () => {
	registry();
	const { state, polls, watcher } = rig();
	state.onClose = () => watcher.stop();
	await polls(2);
	assert.equal(state.resumed.length, 0);
	assert.deepEqual(state.transcript.slice(1).map((e) => e.data), [{ closing: KID }]);
});

test("RV-F005: a session that is itself a subagent never acts for runs", async () => {
	registry();
	const { state, polls, launcher } = rig();
	writeFileSync(`${launcher}.pi-herdr-subagent-policy.json`, JSON.stringify({ version: 2, owner: "public", persistent: false }));
	await polls(8);
	assert.equal(state.commands.length, 0);
});

test("RV-F006: a run launched with auto-exit off is resumed with autoExit false; the policy sidecar decides worktree and persistent", async () => {
	registry();
	const off = rig();
	off.header("w:p2", off.kidFile, "PI_SUBAGENT_AUTO_EXIT=0 ");
	await off.polls(2);
	assert.match(off.state.resumed[0]!.text, /autoExit false/);
	assert.deepEqual(off.state.resumed[0]!.details, { runs: [{ id: KID, name: "kid-one", sessionPath: off.kidFile, pane: "w:p2", autoExit: false }] });
	const wt = rig();
	writeFileSync(`${wt.kidFile}.pi-herdr-subagent-policy.json`, JSON.stringify({ version: 2, owner: "managed-worktree", persistent: false }));
	await wt.polls(2);
	assert.equal(wt.closes().length, 0);
	assert.match(wt.state.resumed[0]!.text, /managed-worktree runs/);
	const pers = rig();
	writeFileSync(`${pers.kidFile}.pi-herdr-subagent-policy.json`, JSON.stringify({ version: 2, owner: "public", persistent: true }));
	await pers.polls(4);
	assert.equal(pers.closes().length, 0);
	assert.equal(pers.state.resumed.length, 0);
});

test("a request the session cannot take is recorded as given up, not as resumed", async () => {
	registry();
	const { state, polls } = rig();
	state.resumeFails = true;
	await polls(2);
	assert.deepEqual(state.transcript.slice(1).map((e) => e.data), [{ closing: KID }, { gaveUp: KID }]);
});

test("the message lists both kinds of run", () => {
	const run = { id: "a", name: "A", session: "/s/a.jsonl", surface: "w:p1", pane: "w:p1" };
	const text = message([run], [{ ...run, id: "b", name: "B", worktree: {} }]);
	assert.match(text, /- A \(run a\): sessionPath \/s\/a\.jsonl/);
	assert.match(text, /- B \(run b\): pane w:p1, worktree unknown, branch unknown/);
});

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

test("a session in Herdr closes a restored subagent pane and hands its model one steering request, from its start until it ends", async () => {
	registry(KID); // the launcher tracks the child while it runs
	const files = layout();
	files.header("wA:p2");
	world.herdr.addPane("wA:p2", "wA:t1");
	Object.assign(world.herdr.pane("wA:p2"), { agent: "pi", agent_status: "idle", agent_session: { value: files.kidFile }, processes: [{ argv0: "pi", name: "node" }, { argv: ["bash", files.script], argv0: "bash", name: "bash" }] });
	const boss = world.agent({ id: "launcher-1", name: "boss", pane: "wA:p1", tab: "wA:t1", deps: { nudgeMs: 5 } });
	boss.file = files.launcher;
	await boss.start();
	// The child runs as pi-herdr-agents started it: its terminal is noted. Then a restore: a new terminal, a plain pi.
	await until(() => boss.entries.some((e) => (e.data as { seen?: string } | undefined)?.seen === KID), "the terminal noted");
	assert.equal(boss.sent.length, 0);
	registry(); // the restart: the restored launcher tracks nothing
	Object.assign(world.herdr.pane("wA:p2"), { terminal_id: "term_restored", processes: [{ argv0: "pi", name: "node" }] });
	await until(() => boss.sent.length === 1, "the request");
	assert.deepEqual(world.herdr.closed, ["wA:p2"]);
	const sent = boss.sent[0]!;
	assert.equal(sent.customType, "straw-boss-resume");
	assert.equal(sent.triggerTurn, true);
	assert.equal(sent.deliverAs, "steer");
	assert.match(sent.content, /subagent_resume/);
	assert.deepEqual(boss.entries.filter((e) => (e.data as { resumed?: string } | undefined)?.resumed).map((e) => e.data), [{ resumed: KID }]);
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(boss.sent.length, 1, "once per run");
	await boss.fire("session_shutdown", { reason: "reload" });
	const before = world.herdr.commands("pane", "list").length;
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(world.herdr.commands("pane", "list").length, before, "the timer stopped with the session");
});
