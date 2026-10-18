import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import type { Pane, Session } from "../src/herdr.ts";
import { type Entry, orphans, tracked } from "../src/orphan.ts";
import { until, World } from "./fakes.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-orphan-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
// pi-herdr-agents' process-wide slot; its `runningSubagents` map is the registry of the children this process's watchers deliver.
const SLOT = Symbol.for("pi-subagents/runtime");
const global = globalThis as Record<symbol, unknown>;
const registry = (...ids: string[]) => (global[SLOT] = { runningSubagents: new Map(ids.map((id) => [id, {}])) });
afterEach(() => void delete global[SLOT]);
let count = 0;

/** The launcher's session file and the activity file of one child under its artifacts, as pi-herdr-agents lays them out, and the child's own session file. */
function layout(phase = "waiting", kid = "kid-1") {
	const dir = join(scratch, `s${++count}`), activity = join(dir, "artifacts", "launcher-1", "subagent-activity");
	mkdirSync(activity, { recursive: true });
	writeFileSync(join(activity, `${kid}.json`), JSON.stringify({ version: 1, runningChildId: kid, createdAt: 111, phase }));
	const script = (launcher: string, run: string) => join(dir, "artifacts", launcher, "subagent-scripts", `kid-one-${run}.sh`);
	return { activity: join(activity, `${kid}.json`), launcher: join(dir, "2026-10-18T00-00-00-000Z_launcher-1.jsonl"), kidFile: join(dir, `2026-10-18T00-00-01-000Z_${kid}-0a1b2c3d-4e5f6a7b-8c9d.jsonl`), script };
}

/** An orphans() watcher over a launcher whose one child is finished and waiting, with everything it touches recorded. */
function rig(phase = "waiting", status = "done") {
	const files = layout(phase), kidId = "kid-1";
	const state = {
		panes: [{ pane_id: "w:p2", tab_id: "w:t1", label: "kid-one", agent: "pi", agent_status: status, agent_session: { value: files.kidFile } }] as Pane[],
		sessions: [{ id: "launcher-1", name: "boss", status: "thinking", herdrLocation: { status: "current", paneId: "w:p1" } }, { id: "kid-session", name: "kid", status: "idle", herdrLocation: { status: "current", paneId: "w:p2" } }] as Session[],
		/** What `herdr pane process-info` lists for the child's pane: pi, and the launch script that started it. */
		processes: [{ argv0: "pi", name: "node" }, { argv: ["bash", files.script("launcher-1", kidId)], argv0: "bash", name: "bash" }] as { argv?: string[]; argv0?: string; name?: string }[],
		infos: 0,
		hold: undefined as Promise<void> | undefined,
		transcript: [] as Entry[],
		sent: [] as { to: string; message: string }[],
		notes: [] as { text: string; level?: string }[],
		lists: 0,
		sendStatus: "sent",
		delay: undefined as Promise<void> | undefined,
	};
	const watch = () => orphans({
		run: async (args) => {
			if (args[1] === "process-info") return state.infos++, await state.hold, JSON.stringify({ result: { process_info: { foreground_processes: state.processes } } });
			return state.lists++, JSON.stringify({ result: { panes: state.panes } });
		},
		file: () => files.launcher,
		entries: () => state.transcript,
		sessions: async () => state.sessions,
		send: async (to, message) => (state.sent.push({ to, message }), await state.delay, { status: state.sendStatus }),
		type: "straw-boss",
		remember: (key) => state.transcript.push({ type: "custom", customType: "straw-boss", data: { nudged: key } }),
		me: () => "launcher-1",
		tell: (text, level) => state.notes.push({ text, level }),
	});
	const watcher = watch();
	/** n polls in a row. */
	const polls = async (n: number, w = watcher) => {
		for (let i = 0; i < n; i++) await w.poll();
	};
	/** The nudges written down in the session. */
	const transcript = () => state.transcript.filter((e) => e.type === "custom");
	return { ...files, state, watch, watcher, polls, transcript };
}

test("a finished child whose launcher no longer tracks it is asked once to report to the launcher over intercom, on the second look", async () => {
	registry();
	const { state, polls, watcher } = rig();
	await polls(1);
	assert.equal(state.sent.length, 0, "the first look only notes it: a delivery just going out must not be mistaken for a lost one");
	await polls(1);
	assert.equal(state.sent.length, 1);
	assert.equal(state.sent[0]!.to, "kid-session", "to the intercom session in the child's own pane");
	assert.match(state.sent[0]!.message, /intercom session launcher-1/);
	assert.match(state.sent[0]!.message, /to "launcher-1"/);
	assert.deepEqual(state.transcript.filter((e) => e.type === "custom").map((e) => e.data), [{ nudged: "kid-1" }]);
	assert.deepEqual(state.notes.map((n) => n.level), [undefined]);
	assert.match(state.notes[0]!.text, /asked kid-one to send its report/, "named as the pane is, not as its intercom session is");
	await polls(5, watcher);
	assert.equal(state.sent.length, 1, "once per run");
});

test("a restarted launcher does not ask again, and neither does a child that reloaded itself and so re-created its activity file", async () => {
	registry();
	const { state, polls, watch, activity } = rig();
	await polls(2);
	assert.equal(state.sent.length, 1);
	await polls(3, watch()); // the nudge is read back from the session
	assert.equal(state.sent.length, 1);
	writeFileSync(activity, JSON.stringify({ version: 1, runningChildId: "kid-1", createdAt: 222, phase: "waiting" }));
	await polls(3, watch());
	await polls(3);
	assert.equal(state.sent.length, 1, "the run is the child id: its recorder starts again, with a new createdAt, at each of the child's own reloads");
});

test("a pane that only reuses the child's session file is not the child: a run another session resumed, a pi someone started on it, a script of another launcher", async () => {
	registry();
	const { state, polls, script } = rig();
	const other = [
		[{ argv0: "pi", name: "node" }, { argv: ["bash", script("launcher-1", "resume-1760000000000")], argv0: "bash", name: "bash" }], // a resumed run's script is named by the resume time, not by the run it resumes
		[{ argv0: "pi", name: "node" }, { argv: ["bash", script("someone-else", "kid-1")], argv0: "bash", name: "bash" }], // the same run id under another session's artifacts
		[{ argv0: "pi", name: "node" }, { argv: ["pi", "--session", "/s/x.jsonl"], argv0: "pi" }], // a pi someone started on the file
		[{ argv0: "pi", name: "node" }, { argv: ["bash", script("launcher-1", "kid-1").replace("kid-one-", "kid-one-x")], argv0: "bash", name: "bash" }], // another run whose id ends like this one
		[],
	];
	for (const processes of other) {
		state.processes = processes;
		await polls(3);
		assert.equal(state.sent.length, 0, JSON.stringify(processes));
	}
	assert.ok(state.infos >= 1, "it was asked");
});

test("a pane whose processes cannot be listed is not the child either, and the child is asked once they can", async () => {
	registry();
	const { state, polls, watcher } = rig();
	const processes = state.processes;
	state.processes = undefined as never; // Herdr answers without the field
	await polls(3);
	assert.equal(state.sent.length, 0);
	state.processes = processes;
	await polls(1, watcher);
	assert.equal(state.sent.length, 1, "a miss is only a count, and the child had not been given up on yet");
});

test("a child the launcher still tracks is never asked, and Herdr is not even read", async () => {
	registry("kid-1");
	const { state, polls } = rig();
	await polls(6);
	assert.equal(state.sent.length, 0);
	assert.equal(state.lists, 0);
	assert.equal(state.infos, 0);
});

test("without a readable registry nothing is known to be lost, so nothing is sent", async () => {
	const { state, polls } = rig();
	await polls(4);
	global[SLOT] = { runningSubagents: ["kid-1"] };
	await polls(4);
	global[SLOT] = {};
	await polls(4);
	assert.equal(state.sent.length, 0);
	assert.equal(tracked(), undefined);
	registry("a");
	assert.deepEqual([...tracked()!], ["a"]);
});

test("a child whose result is already in the transcript is not asked, and one with a similar id does not hide it", async () => {
	registry();
	const { state, polls, kidFile } = rig();
	for (const customType of ["subagent_result", "subagent_ping"]) {
		state.transcript.length = 0;
		state.transcript.push({ type: "custom_message", customType, details: { sessionFile: kidFile } });
		await polls(4);
		assert.equal(state.sent.length, 0, customType);
	}
	state.transcript.length = 0;
	state.transcript.push({ type: "custom_message", customType: "subagent_result", details: { sessionFile: kidFile.replace("kid-1-", "kid-10-") } }, { type: "custom_message", customType: "subagent_status", details: { sessionFile: kidFile } });
	await polls(2);
	assert.equal(state.sent.length, 1);
});

test("a child that is still working, asking a question, or has not started is not asked; it is once it has finished", async () => {
	registry();
	const { state, polls, activity } = rig("active", "working");
	await polls(4);
	state.panes[0]!.agent_status = "done";
	await polls(4);
	assert.equal(state.sent.length, 0, "its own activity says it is working");
	writeFileSync(activity, JSON.stringify({ version: 1, runningChildId: "kid-1", createdAt: 111, phase: "waiting" }));
	state.panes[0]!.agent_status = "blocked";
	await polls(4);
	state.panes[0]!.agent_status = "working";
	await polls(4);
	assert.equal(state.sent.length, 0);
	writeFileSync(activity, JSON.stringify({ version: 1, runningChildId: "kid-1", createdAt: 111, phase: "starting" }));
	state.panes[0]!.agent_status = "done";
	await polls(4);
	assert.equal(state.sent.length, 0, "a child that has not started yet is idle too");
	writeFileSync(activity, JSON.stringify({ version: 1, runningChildId: "kid-1", createdAt: 111, phase: "waiting" }));
	await polls(2);
	assert.equal(state.sent.length, 1);
});

test("a finished child has to be seen finished twice in a row", async () => {
	registry();
	const { state, polls } = rig();
	await polls(1);
	state.panes[0]!.agent_status = "working";
	await polls(1);
	state.panes[0]!.agent_status = "done";
	await polls(1);
	assert.equal(state.sent.length, 0);
	await polls(1);
	assert.equal(state.sent.length, 1);
});

test("a pane someone has looked at (idle) still counts as finished", async () => {
	registry();
	const { state, polls } = rig("waiting", "idle");
	await polls(2);
	assert.equal(state.sent.length, 1);
});

test("a child whose intercom session says it is busy is not asked until it is idle, and a session of another pane is never the target", async () => {
	registry();
	const { state, polls } = rig();
	const kid = state.sessions[1]!;
	kid.status = "thinking";
	await polls(4);
	assert.equal(state.sent.length, 0);
	kid.status = "idle";
	state.sessions.push({ id: "other", status: "idle", herdrLocation: { status: "current", paneId: "w:p9" } });
	await polls(2);
	assert.deepEqual(state.sent.map((s) => s.to), ["kid-session"]);
});

test("the launcher itself is never the target", async () => {
	registry();
	const { state, polls } = rig();
	Object.assign(state.sessions[0]!, { status: "idle", herdrLocation: { status: "current", paneId: "w:p2" } });
	state.sessions.pop();
	await polls(8);
	assert.equal(state.sent.length, 0, "only the launcher itself sits in that pane");
});

test("without the broker listing the launcher under its own id nothing is sent or written down, and the child is asked once the broker does", async () => {
	registry();
	const { state, polls, transcript } = rig();
	const [self] = state.sessions.splice(0, 1);
	await polls(8);
	assert.equal(state.sent.length, 0);
	assert.equal(transcript().length, 0);
	assert.equal(state.lists, 0, "Herdr is not read before the broker lists the launcher; and the child is not given up on, the broker may only be slow");
	state.sessions.unshift(self!);
	await polls(2);
	assert.equal(state.sent.length, 1);
});

test("a child whose pane is gone, or now runs another session, is given up on after a few looks and Herdr is left alone", async () => {
	registry();
	const { state, polls, watcher } = rig();
	state.panes[0]!.agent_session = { value: "/s/2026-10-18T00-00-09-000Z_someone-else.jsonl" };
	await polls(12, watcher);
	assert.equal(state.sent.length, 0);
	assert.equal(state.lists, 4);
	state.panes[0]!.agent = undefined;
	state.panes[0]!.agent_session = undefined;
	const second = rig();
	second.state.panes.length = 0;
	await second.polls(12);
	assert.equal(second.state.lists, 4);
});

test("a child with no intercom session is given up on too", async () => {
	registry();
	const { state, polls } = rig();
	state.sessions.pop();
	await polls(12);
	assert.equal(state.sent.length, 0);
	assert.equal(state.lists, 5, "the first look, then four misses");
});

test("a send that fails is warned about and not tried again", async () => {
	registry();
	const { state, polls } = rig();
	state.sendStatus = "failed";
	await polls(8);
	assert.equal(state.sent.length, 1);
	assert.deepEqual(state.notes.map((n) => n.level), ["warning"]);
	assert.match(state.notes[0]!.text, /could not ask kid-one/);
});

test("a watcher stopped while Herdr is asked about the pane asks no more and writes nothing down", async () => {
	registry();
	const { state, polls, watcher, transcript } = rig();
	await polls(1);
	let release!: () => void;
	state.hold = new Promise<void>((resolve) => (release = resolve));
	const second = watcher.poll();
	await until(() => state.infos === 1, "the process listing");
	watcher.stop();
	release();
	await second;
	assert.equal(state.sent.length, 0);
	assert.equal(transcript().length, 0);
});

test("two polls at once ask once, and a stopped watcher asks no more", async () => {
	registry();
	const { state, polls, watcher } = rig();
	await polls(1);
	let release!: () => void;
	state.delay = new Promise<void>((resolve) => (release = resolve));
	const both = Promise.all([watcher.poll(), watcher.poll()]);
	await until(() => state.sent.length === 1, "the send");
	release();
	await both;
	assert.equal(state.sent.length, 1);
	const again = rig();
	await again.polls(1);
	again.watcher.stop();
	await again.polls(4);
	assert.equal(again.state.sent.length, 0);
});

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

test("a session in Herdr watches for orphans on a timer from its start until it ends", async () => {
	registry();
	const files = layout();
	world.herdr.addPane("wA:p2", "wA:t1");
	Object.assign(world.herdr.pane("wA:p2"), { agent_status: "done", agent_session: { value: files.kidFile }, processes: [{ argv0: "pi" }, { argv: ["bash", files.script("launcher-1", "kid-1")], argv0: "bash" }] });
	world.agent({ id: "kid-session", name: "kid", pane: "wA:p2", env: { PI_SUBAGENT_ID: "kid-1" } });
	const boss = world.agent({ id: "launcher-1", name: "boss", pane: "wA:p1", tab: "wA:t1", deps: { nudgeMs: 5 } });
	boss.file = files.launcher;
	await boss.start();
	await until(() => world.broker.delivered.length === 1, "the nudge");
	assert.deepEqual(world.broker.delivered.map((m) => [m.from, m.to]), [["launcher-1", "kid-session"]]);
	assert.deepEqual(boss.entries.filter((e) => e.customType === "straw-boss" && (e.data as { nudged?: string }).nudged).map((e) => e.data), [{ nudged: "kid-1" }]);
	await boss.fire("session_shutdown", { reason: "reload" });
	const before = world.herdr.commands("pane", "list").length;
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(world.herdr.commands("pane", "list").length, before, "the timer stopped with the session");
	assert.equal(world.broker.delivered.length, 1);
});
