import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BRIEF_MARK } from "../src/eventmarks.ts";
import { buildHeadBrief, buildHeadSplit, type HeadBriefInput, headTools } from "../src/server/headbrief.ts";
import { openAsk } from "../src/server/headasks.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { callControl } from "../src/server/socket.ts";
import { addText, updateMemory } from "../src/server/towermemory.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The head's brief in two texts (src/server/headbrief.ts `buildHeadSplit`). Every run of the head resumes the one session, so what the run puts in its system section is read against the whole conversation: a section
// that names a main's state, an ask's age, or the time the run was woken is rewritten at every run and at every refresh, and each rewrite reads the conversation uncached (41 strict cache misses and 6.9M tokens in the
// head's session, 2026-11-13 to 11-16). A run that says `liveBrief` at its claim gets `brief`, the same bytes for every run, and `live`, which it is given as a message.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.env.LANG = "en_US.UTF-8";
	world.runTimers = { hold: 120 };
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const MAIN = { id: "main-1", name: "docs-main", herdrLocation: { status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId: "wA:p1" } };
const setup = async () => {
	world.herdr.addPane("wA:p1", "wA:t1", "pi").tokens.sb_role = "main";
	world.sessions = [{ ...MAIN, status: "idle" }];
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const head = await world.expose!.head.ensure();
	return { s, ws: head.workspace };
};
const nthRun = async (ws: string, n: number) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, ws, id)?.pid, "the run's pid to be recorded");
	return id;
};
const poll = (s: Running, token: string, idle = true) => ask(s, { cmd: "run-poll", token, idle });
const drain = async (s: Running, token: string) => {
	for (;;) {
		const event = (await poll(s, token)).event as { id: string } | undefined;
		if (!event) return;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
};
const sessionFile = () => {
	const dir = join(world.env.PI_CODING_AGENT_DIR!, "sessions", "--head--");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "2026-11-16_aaa.jsonl");
	writeFileSync(file, "x".repeat(200));
	return file;
};
/** The boss writes to the head and the run it wakes claims: with `liveBrief` as a pi of this build does, without it as an older one. */
const talk = async (s: Running, ws: string, n: number, liveBrief: boolean) => {
	assert.equal((await ask(s, { cmd: "tower-event", workspace: ws, text: "hello", present: true })).ok, true);
	const id = await nthRun(ws, n), pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}`, ...(liveBrief ? { liveBrief } : {}) });
	assert.equal(got.ok, true, JSON.stringify(got));
	const token = String(got.token);
	await ask(s, { cmd: "run-file", token, file: sessionFile() });
	await drain(s, token);
	return { id, token, brief: String(got.brief), live: got.live as string | undefined };
};
const quit = async (s: Running, ws: string, run: { id: string; token: string }) => {
	assert.equal((await ask(s, { cmd: "run-done", token: run.token, note: "routed the docs work", left: true })).ok, true);
	world.live.delete(world.pis.get(run.id)!.pid);
	await until(() => readRun(world.slot, ws, run.id)?.outcome === "done", "the conversation to end as done");
};

test("another main's state flip between two runs of the head leaves the section's brief the same bytes: the workspaces now, the asks, the memory, the note, and who woke the run are the message's", async () => {
	const { s, ws } = await setup();
	const first = await talk(s, ws, 1, true);
	await quit(s, ws, first);
	// Everything a brief is made of moves: the main works, the head has an ask open and a standing instruction, and the first run left a note.
	world.sessions = [{ ...MAIN, status: "thinking" }];
	openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "start MP-4129" });
	updateMemory(world.slot, ws, Date.now(), (m) => void addText(m, Date.now(), "gui", "standing", "Always forward MP work to MP Center"));
	const second = await talk(s, ws, 2, true);
	assert.equal(second.brief, first.brief, "the section's part is the same bytes in the second run");
	assert.match(first.live!, /Workspaces now:\n- Alpha \(wA\), \/w\/alpha: tower standing by\n {2}work: main docs-main idle/);
	assert.match(second.live!, / {2}work: main docs-main working/);
	assert.match(second.live!, /Open asks:\n- H1 Alpha, \d+m: start MP-4129/);
	assert.match(second.live!, /Always forward MP work to MP Center/);
	assert.match(second.live!, /Handoff note from the last run \(\d+m ago\):\n\(boss quit\)/);
	assert.match(second.live!, /^Your conversation with the boss: chapter 1, since \d{4}-\d\d-\d\d, 1 boss turn\. The boss is at this pane now\. Woken \d\d:\d\d\./);
	assert.match(second.live!, /The boss is in this run: stay and answer them/);
	// The section's part: who it is, where its brief comes from, and its tools, and nothing that a run or another session can move.
	assert.match(first.brief, /^You are the head tower: the boss's own tower, in no workspace\. This session is your one conversation with the boss\. Your identity is sb-head; everything you send leaves under it\./);
	assert.ok(first.brief.includes(`a message whose first line is \`${BRIEF_MARK}\``));
	assert.match(first.brief, /Tools:\n- tower_send/);
	assert.match(first.brief, /Call tower_done with a handoff note when nothing is left for you\.$/);
	assert.doesNotMatch(first.brief, /Workspaces now:|Open asks:|docs-main|Woken|chapter \d|Handoff note from|The boss is (at|away|in this run)|\d\d:\d\d/);
	assert.ok(first.brief.length + second.live!.length <= 8000 + 600, "the two texts together stay a brief's size");
});

test("a run of an older build says nothing at its claim and gets the whole brief in one text, which does change with a main's state", async () => {
	const { s, ws } = await setup();
	const first = await talk(s, ws, 1, false);
	assert.equal(first.live, undefined);
	assert.match(first.brief, /^You are the head tower: the boss's own tower, in no workspace\. This session is your one conversation with the boss \(chapter 1, since \d{4}-\d\d-\d\d, 0 boss turns\)\./);
	assert.match(first.brief, / {2}work: main docs-main idle/);
	await quit(s, ws, first);
	world.sessions = [{ ...MAIN, status: "thinking" }];
	const second = await talk(s, ws, 2, false);
	assert.notEqual(second.brief, first.brief);
	assert.match(second.brief, / {2}work: main docs-main working/);
});

test("a live run that takes its brief as a message is given a new one when its memory moved, and none for its own asks or their answers; a run of an older build is refreshed for both", async () => {
	for (const liveBrief of [true, false]) {
		world = new TowerWorld();
		world.setFlag(true);
		world.env.LANG = "en_US.UTF-8";
		world.runTimers = { hold: 120 };
		const { s, ws } = await setup();
		const run = await talk(s, ws, 1, liveBrief);
		assert.equal((await poll(s, run.token)).brief, undefined, "nothing moved");
		// The head forwards an instruction (an ask opens), and the tower answers it.
		const opened = openAsk(world.slot, Date.now(), { workspace: "wA", label: "Alpha", first: "start MP-4129" });
		const afterAsk = await poll(s, run.token);
		world.client("sb-head")!.incoming({ id: "sb-tower-wa", name: "tower · Alpha" }, { id: "a1", content: { text: `[straw net from="tower · Alpha" id=sb-tower-wa role=tower workspace=Alpha kind=tower_send scope=tower to="head tower (head tower of head)" reply=none in-reply-to=${opened.id}] landed` } } as never);
		await until(() => readQueue(world.slot, ws).some((e) => !e.taken && /landed/.test(e.text)), "the answer to be queued");
		if (liveBrief) {
			assert.equal(afterAsk.brief, undefined, "an ask the run opened itself moves no brief");
			const answer = await poll(s, run.token);
			assert.equal(answer.brief, undefined, "nor does its answer");
			assert.match(String((answer.event as { text: string } | undefined)?.text), /in-reply-to=H1\] landed/, "which reaches the run as an event");
			assert.equal((await ask(s, { cmd: "run-taken", token: run.token, id: (answer.event as { id: string }).id })).ok, true);
		} else assert.match(String(afterAsk.brief), /Open asks:\n- H1 Alpha/, "the whole brief is refreshed for it, as before");
		updateMemory(world.slot, ws, Date.now(), (m) => void addText(m, Date.now(), "gui", "standing", "Never deploy on Fridays"));
		let fresh = await poll(s, run.token);
		while (fresh.brief === undefined && fresh.event) {
			await ask(s, { cmd: "run-taken", token: run.token, id: (fresh.event as { id: string }).id });
			fresh = await poll(s, run.token);
		}
		if (liveBrief) {
			assert.equal(fresh.brief, run.brief, "the section's part is the same bytes in the refresh");
			assert.match(String(fresh.live), /Never deploy on Fridays/);
			assert.match(String(fresh.live), /Open asks:\n- H1 Alpha, \d+m: start MP-4129 → landed/, "the newest brief has the asks as they stand");
		} else {
			assert.match(String(fresh.brief), /Never deploy on Fridays/);
			assert.equal(fresh.live, undefined);
		}
		assert.equal((await poll(s, run.token)).brief, undefined, "once");
		await world.close();
	}
	world = new TowerWorld();
});

test("the two texts of one input: the same parts as the whole brief, cut as it is, and a fixed text that no input but the identity and the tools can move", () => {
	const input = (over: Partial<HeadBriefInput> = {}): HeadBriefInput => ({
		identity: "sb-head", woken: "09:41", boss: false, chapter: { n: 2, since: "2026-11-10T00:00:00Z", turns: 7, resumed: true },
		workspaces: [{ label: "Alpha", id: "wA", folder: "/w/alpha", tower: "running", rows: [{ tab: "work", main: { name: "docs-main", id: "main-1", state: "working", now: "docs: ship the guide", open: 2 }, members: 0 }] }],
		asks: [{ id: "H3", label: "Alpha", age: "4m", first: "start MP-4129", answer: "landed" }], memory: "Memory:\n- [S1] Standing: forward MP work to MP Center", lapsed: ["W2"],
		note: { text: "routed two", age: "12m" }, auto: "Auto mode: on since 23:10", tools: headTools("en"), flags: [], ...over,
	});
	const whole = buildHeadBrief(input()), { fixed, live } = buildHeadSplit(input());
	for (const part of ["Workspaces now:\n- Alpha (wA), /w/alpha: tower running\n  work: main docs-main working; now: docs: ship the guide (2 open)", "Open asks:\n- H3 Alpha, 4m: start MP-4129 → landed", "Memory:\n- [S1] Standing: forward MP work to MP Center", "Lapsed waits (the boss no longer sees them on the page): W2.", "Handoff note from the last run (12m ago):\nrouted two", "Auto mode: on since 23:10", "A run woken by a tower's answer ends after 20 minutes"]) {
		assert.ok(whole.includes(part), `the whole brief has: ${part}`);
		assert.ok(live.includes(part), `the live text has: ${part}`);
		assert.ok(!fixed.includes(part), `the fixed text has not: ${part}`);
	}
	assert.match(live, /^Your conversation with the boss: chapter 2, since 2026-11-10, 7 boss turns\. The boss is away: a tower's answer woke you\. Woken 09:41\.\nAuto mode: on since 23:10/);
	assert.ok(fixed.includes(headTools("en").join("\n")) && whole.includes(headTools("en").join("\n")) && !live.includes("Tools:"), "the tools are the fixed text's");
	// Whatever the run and the workspaces are, the fixed text is the same.
	const other = buildHeadSplit(input({ woken: "23:59", boss: true, chapter: { n: 3, since: "2026-11-16T00:00:00Z", turns: 0, resumed: false, why: "the boss asked for a new conversation", recap: ["boss: hello"] }, workspaces: [], asks: [], memory: "", lapsed: [], note: undefined, auto: undefined, flags: ["a flag"] }));
	assert.equal(other.fixed, fixed);
	assert.match(other.live, /New chapter 3: the boss asked for a new conversation\./);
	assert.match(other.live, /The last lines between you and the boss, oldest first:\n- boss: hello/);
	assert.match(other.live, /a flag\nThe boss is in this run/);
	// A memory that does not fit is cut in the live text as in the whole brief.
	const long = input({ memory: ["Memory:", ...Array.from({ length: 400 }, (_, n) => `- [S${n}] Standing: ${"x".repeat(40)}`)].join("\n") });
	const cut = buildHeadSplit(long);
	assert.ok(cut.fixed.length + cut.live.length <= 8000 + 600);
	assert.match(cut.live, /\(\+\d+ more lines in memory: tower_memory read\)/);
	assert.equal(cut.fixed, fixed);
});
