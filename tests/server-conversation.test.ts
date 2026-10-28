import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { BOSS_FILE_MAX, readPointer, resumable, type BossPointer, writePointer } from "../src/server/bossconv.ts";
import { addText, updateMemory } from "../src/server/towermemory.ts";
import { readNotes, readRun } from "../src/server/towerrunstore.ts";
import { callControl } from "../src/server/socket.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// The boss conversation (docs/specs/2026-10-26-sb-backend.md, The boss conversation): a boss event written at the tower prompt or in the GUI's composer, with no local run live, starts a run that resumes the boss's last
// session (`--session`), stays while the boss is there, and ends by /quit, tower_done, or the boss's silence. An event run is a fresh session and never moves the pointer. Driven over the control socket, as the pi would.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return s;
};
const tower = () => world.client("sb-tower-wa")!;
const nthRun = async (n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
const claimRun = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return { token: String(got.token), brief: String(got.brief) };
};
const poll = (s: Running, token: string, idle = true) => ask(s, { cmd: "run-poll", token, idle });
const drain = async (s: Running, token: string) => {
	for (;;) {
		const event = (await poll(s, token)).event as { id: string } | undefined;
		if (!event) return;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
};
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);
const argsOf = (id: string) => world.pis.get(id)!.args.slice(world.pis.get(id)!.args.indexOf("--") + 1);
const sessions = () => join(world.env.PI_CODING_AGENT_DIR!, "sessions", "--proj--");
const sessionFile = (name: string, bytes = 200) => {
	mkdirSync(sessions(), { recursive: true });
	const file = join(sessions(), name);
	writeFileSync(file, "x".repeat(bytes));
	return file;
};
/** A boss event at the prompt (present) and the run it wakes, claimed and drained, reporting `file` as its session. */
const conversation = async (s: Running, n: number, file: string, text = "hello") => {
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text, present: true })).ok, true);
	const id = await nthRun(n);
	const { token, brief } = await claimRun(s, id);
	await ask(s, { cmd: "run-file", token, file });
	await drain(s, token);
	return { id, token, brief };
};
const quit = async (s: Running, run: { id: string; token: string }) => {
	assert.equal((await ask(s, { cmd: "run-done", token: run.token, note: "ignored", left: true })).ok, true);
	exit(run.id);
	await until(() => readRun(world.slot, "wA", run.id)?.outcome === "done", "the conversation to end as done");
};
const service = async (s: Running) => ((await ask(s, { cmd: "status" })).towers as { service: Record<string, any> }[])[0]!.service;

test("a boss event at the prompt with no run live starts a conversation: a boss-named run with no --session the first time, the brief says why it is new, and its session file becomes the boss session", async () => {
	const s = await setup();
	const file = sessionFile("2026-10-28_aaa.jsonl");
	const c = await conversation(s, 1, file);
	const args = argsOf(c.id);
	assert.deepEqual(args.slice(0, 4), ["--name", "tower · boss · Alpha", "--sb-run", c.id]);
	assert.ok(!args.includes("--session"), "nothing to resume yet");
	assert.deepEqual(readRun(world.slot, "wA", c.id)?.conversation, { resumed: false, turns: 0, why: "no earlier boss session" });
	assert.match(c.brief, /Boss conversation: the boss is at this pane\. New session: no earlier boss session\./);
	const pointer = readPointer(world.slot, "wA")!;
	assert.equal(pointer.file, realpathSync(file));
	assert.equal(pointer.run, c.id);
	assert.equal(pointer.turns, 1, "the boss event the run took is one boss turn");
	// The boss is in it from the claim: tower_done stays.
	assert.equal((await ask(s, { cmd: "run-done", token: c.token, note: "n" })).stay, true);
});

test("the next conversation resumes that session (--session), says so in its brief with the date and the turns, and keeps the session's start; an event run in between is fresh and moves nothing", async () => {
	const s = await setup();
	const file = sessionFile("2026-10-28_aaa.jsonl");
	const first = await conversation(s, 1, file);
	const began = readPointer(world.slot, "wA")!.startedAt;
	await quit(s, first);
	assert.equal(readNotes(world.slot, "wA").at(-1)!.note, "(boss quit)");
	// An event run: an agent's message, no boss.
	tower().incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "build is green" } });
	const eventRun = await nthRun(2);
	assert.ok(!argsOf(eventRun).includes("--session"), "an event run starts fresh");
	assert.equal(readRun(world.slot, "wA", eventRun)?.conversation, undefined);
	const ev = await claimRun(s, eventRun);
	assert.doesNotMatch(ev.brief, /Boss conversation/);
	await ask(s, { cmd: "run-file", token: ev.token, file: sessionFile("2026-10-28_eee.jsonl") });
	await drain(s, ev.token);
	assert.equal(readPointer(world.slot, "wA")!.file, realpathSync(file), "an event run never moves the pointer");
	assert.equal((await ask(s, { cmd: "run-done", token: ev.token, note: "routed the green build to docs" })).ok, true);
	exit(eventRun);
	await until(() => readRun(world.slot, "wA", eventRun)?.outcome === "done", "the event run to end");
	// The second conversation.
	const second = await conversation(s, 3, file, "again");
	const args = argsOf(second.id);
	assert.equal(args[args.indexOf("--session") + 1], realpathSync(file));
	assert.deepEqual(readRun(world.slot, "wA", second.id)?.conversation?.resumed, true);
	assert.match(second.brief, /Boss conversation: the boss is at this pane\. Resumed session from \d{4}-\d\d-\d\d, 1 boss turn\./);
	assert.match(second.brief, /Since you last talked with the boss:\n- \d+m ago: routed the green build to docs/);
	const pointer = readPointer(world.slot, "wA")!;
	assert.equal(pointer.run, second.id);
	assert.equal(pointer.startedAt, began, "a resumed session keeps its start");
	assert.equal(pointer.turns, 2);
});

test("/new (tower-new) makes the next conversation a new session and says why; the new one's file replaces the pointer and the mark", async () => {
	const s = await setup();
	const file = sessionFile("2026-10-28_aaa.jsonl");
	await quit(s, await conversation(s, 1, file));
	const reply = await ask(s, { cmd: "tower-new", workspace: "wA" });
	assert.equal(reply.ok, true, JSON.stringify(reply));
	assert.equal(reply.left, false, "nothing was live");
	assert.equal(readPointer(world.slot, "wA")!.fresh, true);
	const next = sessionFile("2026-10-28_bbb.jsonl");
	const second = await conversation(s, 2, next);
	assert.ok(!argsOf(second.id).includes("--session"));
	assert.match(second.brief, /New session: the boss asked for a new one \(\/new\)\./);
	const pointer = readPointer(world.slot, "wA")!;
	assert.equal(pointer.file, realpathSync(next));
	assert.equal(pointer.fresh, undefined);
	assert.equal(pointer.turns, 1);
});

test("/new in a live conversation ends it as /quit does and marks the pointer; /new typed in the conversation's own pi (a released session) does the same", async () => {
	const s = await setup();
	const live = await conversation(s, 1, sessionFile("2026-10-28_aaa.jsonl"));
	const reply = await ask(s, { cmd: "tower-new", workspace: "wA" });
	assert.equal(reply.left, true);
	assert.equal(readPointer(world.slot, "wA")!.fresh, true);
	assert.equal(((await poll(s, live.token)).command as { type: string }).type, "quit");
	exit(live.id);
	await until(() => readRun(world.slot, "wA", live.id)?.outcome === "done", "the conversation to end");
	// The pi's own /new: the run is released, and the next conversation is new.
	const next = await conversation(s, 2, sessionFile("2026-10-28_bbb.jsonl"));
	assert.equal(readPointer(world.slot, "wA")!.fresh, undefined);
	assert.equal((await ask(s, { cmd: "run-release", token: next.token, reason: "new" })).ok, true);
	await until(() => readRun(world.slot, "wA", next.id)?.outcome === "quit", "the released run");
	assert.equal(readPointer(world.slot, "wA")!.fresh, true);
});

test("leave (tower-leave) ends a live conversation as done with the note (boss quit); with no conversation live, or an event run, it is refused", async () => {
	const s = await setup();
	assert.match(String((await ask(s, { cmd: "tower-leave", workspace: "wA" })).error), /No boss conversation is live/);
	tower().incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "hello" } });
	const eventRun = await nthRun(1);
	await claimRun(s, eventRun);
	assert.match(String((await ask(s, { cmd: "tower-leave", workspace: "wA" })).error), /No boss conversation is live/, "an event run is not the boss's conversation");
	exit(eventRun);
	await until(() => readRun(world.slot, "wA", eventRun)?.outcome !== undefined, "the event run to end");
	const c = await conversation(s, 2, sessionFile("2026-10-28_aaa.jsonl"));
	assert.equal((await ask(s, { cmd: "tower-leave", workspace: "wA" })).left, true);
	assert.equal((await service(s)).conversation.closing, true);
	assert.equal(((await poll(s, c.token)).command as { type: string }).type, "quit", "the pi is told to quit");
	exit(c.id);
	await until(() => readRun(world.slot, "wA", c.id)?.outcome === "done", "the conversation to end as done");
	assert.equal(readNotes(world.slot, "wA").at(-1)!.note, "(boss quit)");
	assert.equal((await ask(s, { cmd: "tower-leave", workspace: "wA" })).ok, false, "nothing live any more");
});

test("the status says the conversation: since, resumed, turns, the idle wait with its deadline, and the hard cap; a conversation that waits for the boss is idle", async () => {
	world.runTimers = { bossAway: 60_000, bossMax: 3_600_000 };
	const s = await setup();
	const c = await conversation(s, 1, sessionFile("2026-10-28_aaa.jsonl"));
	let svc = await service(s);
	assert.equal(svc.run.id, c.id);
	assert.equal(svc.conversation.resumed, false);
	assert.equal(svc.conversation.why, "no earlier boss session");
	assert.equal(svc.conversation.turns, 1);
	assert.equal(svc.conversation.idleMs, 60_000);
	assert.equal(typeof svc.conversation.capAt, "number");
	assert.equal(svc.conversation.idle, true, "the drain polled idle with nothing queued");
	assert.ok(svc.conversation.idleAt > Date.now() + 50_000 && svc.conversation.idleAt <= Date.now() + 60_000, `idle deadline ${svc.conversation.idleAt - Date.now()}`);
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "more", present: true });
	const event = (await poll(s, c.token)).event as { id: string };
	svc = await service(s);
	assert.equal(svc.conversation.idle, false, "an event is with the run");
	assert.equal(svc.localRuns.at(-1).kind, "conversation");
	await ask(s, { cmd: "run-taken", token: c.token, id: event.id });
});

test("the boss's silence ends a conversation with a steer that says so and the note (ended idle), recorded quit, not a crash; the 4 h cap does the same with its own note and is no timeout", async () => {
	world.runTimers = { bossAway: 150, idleSteer: 100, idleEnd: 200, bossMax: 60_000, steerAt: 60_000, quitAt: 120_000, quitGrace: 60, signal: 60 };
	const s = await setup();
	const c = await conversation(s, 1, sessionFile("2026-10-28_aaa.jsonl"));
	const seen: { type: string; text?: string }[] = [];
	for (const end = Date.now() + 1200; Date.now() < end && !seen.some((x) => x.type === "quit"); await sleep(15)) {
		const command = (await poll(s, c.token)).command as { type: string; text?: string } | undefined;
		if (command) seen.push(command);
	}
	assert.equal(seen.find((x) => x.type === "steer")?.text, "The boss has left: call tower_done with your handoff note.");
	assert.ok(seen.some((x) => x.type === "quit"), JSON.stringify(seen));
	exit(c.id);
	await until(() => readRun(world.slot, "wA", c.id)?.outcome === "quit", "quit, not crashed");
	assert.equal(readNotes(world.slot, "wA").at(-1)!.note, "(ended idle)");
});

test("the 4 h cap of a conversation is a wrap-up, not a timeout", async () => {
	world.runTimers = { bossAway: 600_000, idleSteer: 100, idleEnd: 200, bossMax: 150, steerAt: 60_000, quitAt: 120_000, quitGrace: 60, signal: 60 };
	const s = await setup();
	const c = await conversation(s, 1, sessionFile("2026-10-28_aaa.jsonl"));
	const seen: string[] = [];
	for (const end = Date.now() + 1500; Date.now() < end && !seen.includes("quit"); await sleep(15)) {
		const command = (await poll(s, c.token)).command as { type: string } | undefined;
		if (command) seen.push(command.type);
	}
	assert.deepEqual(seen, ["steer", "quit"]);
	exit(c.id);
	await until(() => readRun(world.slot, "wA", c.id)?.outcome === "quit", "quit at the cap");
	assert.equal(readNotes(world.slot, "wA").at(-1)!.note, "(ended at the 4 h cap)");
});

test("a conversation whose boss quit after a long silence is done, not a crash: their /quit is theirs", async () => {
	world.runTimers = { bossAway: 100, idleSteer: 60_000, idleEnd: 60_000, quitGrace: 60, signal: 60 };
	const s = await setup();
	const c = await conversation(s, 1, sessionFile("2026-10-28_aaa.jsonl"));
	await sleep(400); // away: the boss mark is gone
	assert.equal((await service(s)).conversation.idleAt, undefined);
	await quit(s, c);
});

test("the pointer is written only for a file under pi's sessions folder, and only a conversation writes it", async () => {
	const s = await setup();
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "x", present: true })).ok, true);
	const id = await nthRun(1);
	const { token } = await claimRun(s, id);
	const outside = join(world.root, "elsewhere.jsonl");
	writeFileSync(outside, "x");
	await ask(s, { cmd: "run-file", token, file: outside });
	assert.equal(readPointer(world.slot, "wA"), undefined, "a file outside the sessions folder is not kept as the boss session");
	await ask(s, { cmd: "run-file", token, file: sessionFile("not-a-session.txt") });
	assert.equal(readPointer(world.slot, "wA"), undefined, "nor a file that is not a .jsonl");
});

test("whoever the comms show: the boss session is the tower unit's file while it lasts, and an event run is listed apart with its note", async () => {
	const s = await setup();
	const file = sessionFile("2026-10-28_aaa.jsonl");
	await quit(s, await conversation(s, 1, file));
	tower().incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "hello" } });
	const eventRun = await nthRun(2);
	const ev = await claimRun(s, eventRun);
	const evFile = sessionFile("2026-10-28_eee.jsonl");
	await ask(s, { cmd: "run-file", token: ev.token, file: evFile });
	await drain(s, ev.token);
	await ask(s, { cmd: "run-done", token: ev.token, note: "routed it\nand more" });
	exit(eventRun);
	await until(() => readRun(world.slot, "wA", eventRun)?.outcome === "done", "the event run to end");
	const svc = await service(s);
	assert.deepEqual(svc.localRuns.map((r: { kind: string }) => r.kind), ["conversation", "event"]);
	assert.equal(svc.localRuns[1].note, "routed it");
	assert.equal(svc.localRuns[0].note, "(boss quit)");
	const view = world.expose!.runs.view("wA")!;
	assert.equal(view.file, realpathSync(file), "the tower's comms are the boss session");
	assert.deepEqual(view.eventFiles, { [eventRun]: evFile });
});

test("a live run is given a newer brief when the memory moved, once", async () => {
	const s = await setup();
	const c = await conversation(s, 1, sessionFile("2026-10-28_aaa.jsonl"));
	assert.equal((await poll(s, c.token)).brief, undefined, "nothing moved");
	updateMemory(world.slot, "wA", Date.now(), (m) => void addText(m, Date.now(), "gui", "standing", "Never deploy on Fridays"));
	const got = await poll(s, c.token);
	assert.match(String(got.brief), /Never deploy on Fridays/);
	assert.match(String(got.brief), /newest brief, refreshed while you run/);
	assert.equal((await poll(s, c.token)).brief, undefined, "once");
});

test("a run token cannot start, leave, or restart a boss conversation, or write as the boss: tower-event, tower-leave, tower-new are the boss's", async () => {
	const s = await setup();
	const c = await conversation(s, 1, sessionFile("2026-10-28_aaa.jsonl"));
	for (const cmd of ["tower-event", "tower-leave", "tower-new"]) {
		const got = await ask(s, { cmd, token: c.token, workspace: "wA", text: "t", present: true });
		assert.equal(got.ok, false, cmd);
		assert.match(String(got.error), /run token/, cmd);
	}
	assert.equal(readPointer(world.slot, "wA")!.fresh, undefined);
	// A local run may sign the boss's presence only in its own session (the extension's `run-boss`); a made-up token may not.
	assert.equal((await ask(s, { cmd: "run-boss", token: "nope" })).ok, false);
});

test("an ally run never resumes the boss session", async () => {
	const s = await setup();
	await quit(s, await conversation(s, 1, sessionFile("2026-10-28_aaa.jsonl")));
	world.ally.add("a1", "a".repeat(26), "hello from a teammate");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun(2);
	assert.ok(!argsOf(id).includes("--session"));
	assert.equal(readRun(world.slot, "wA", id)?.kind, "ally");
	assert.equal(readRun(world.slot, "wA", id)?.conversation, undefined);
});

// --- bossconv.ts: when a session may be resumed ---

const pointer = (file: string, over: Partial<BossPointer> = {}): BossPointer => ({ file, run: "r1", startedAt: "2026-10-20T10:00:00.000Z", lastAt: new Date(Date.now() - 3600_000).toISOString(), turns: 4, ...over });

test("resumable: a regular .jsonl under the sessions folder, small and recent, not open in a pane; else the reason", () => {
	const root = join(world.root, "agent", "sessions");
	const file = sessionFile("a.jsonl"), env = { now: Date.now(), root, live: [] as string[], ...(process.getuid ? { uid: process.getuid() } : {}) };
	assert.deepEqual(resumable(pointer(file), env), { ok: true, file: realpathSync(file) });
	assert.match((resumable(undefined, env) as { why: string }).why, /no earlier boss session/);
	assert.match((resumable(pointer(file, { fresh: true }), env) as { why: string }).why, /asked for a new one/);
	assert.match((resumable(pointer(file, { lastAt: new Date(Date.now() - 8 * 86_400_000).toISOString() }), env) as { why: string }).why, /over 7 days/);
	assert.match((resumable(pointer(file), { ...env, live: [file] }) as { why: string }).why, /open in another pane/);
	assert.match((resumable(pointer(join(sessions(), "gone.jsonl")), env) as { why: string }).why, /gone/);
	const big = sessionFile("big.jsonl", BOSS_FILE_MAX + 1);
	assert.match((resumable(pointer(big), env) as { why: string }).why, /grew past 4 MB/);
	assert.equal(resumable(pointer(sessionFile("edge.jsonl", BOSS_FILE_MAX)), env).ok, true, "4 MB exactly is still small enough");
	const outside = join(world.root, "outside.jsonl");
	writeFileSync(outside, "x");
	assert.match((resumable(pointer(outside), env) as { why: string }).why, /not under pi's sessions folder/);
	const link = join(sessions(), "link.jsonl");
	symlinkSync(outside, link);
	assert.match((resumable(pointer(link), env) as { why: string }).why, /not under pi's sessions folder/, "a link out of the folder is not followed");
	assert.match((resumable(pointer(sessionFile("c.jsonl")), { ...env, uid: (env.uid ?? 0) + 1 }) as { why: string }).why, /not the boss's/, "a file of another user");
	writePointer(world.slot, "wA", pointer(file));
	assert.equal(readPointer(world.slot, "wA")?.turns, 4);
	writeFileSync(join(world.slot.dir, "tower", "wA", "boss-session.json"), "{not json");
	assert.equal(readPointer(world.slot, "wA"), undefined, "a pointer that cannot be read is no pointer");
	assert.equal(readFileSync(join(world.slot.dir, "tower", "wA", "boss-session.json"), "utf8"), "{not json");
});
