import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { argsDigest } from "../src/server/allows.ts";
import { callControl } from "../src/server/socket.ts";
import { lastNote, listRuns, readRun } from "../src/server/towerrunstore.ts";

// The ally runs of the tower service (docs/specs/2026-10-26-sb-backend.md, Ally runs, The wake protocol, The brief; B6) against a fake Herdr, a fake link holder (`world.ally`), and a pi that is a test:
// a message of a teammate's device that waits for the tower identity gets a run of its own in a pane split off the tower's tab, claimed over the control socket like a local run.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async (over: Parameters<TowerWorld["start"]>[0] = {}) => {
	const s = await world.start(over);
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, ensured };
};
const DEV1 = "a".repeat(26), DEV2 = "b".repeat(26);
/** The nth run the server started (1-based), once its pid is recorded; its workspace record. */
const nthRun = async (n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
const claimed = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return got;
};
const poll = (s: Running, token: string) => ask(s, { cmd: "run-poll", token, idle: true });
const taken = (s: Running, token: string, id: unknown) => ask(s, { cmd: "run-taken", token, id });
const drain = async (s: Running, token: string) => {
	const events: { id: string; kind: string; text: string }[] = [];
	for (;;) {
		const event = (await poll(s, token)).event as (typeof events)[number] | undefined;
		if (!event) return events;
		assert.equal((await taken(s, token, event.id)).ok, true);
		events.push(event);
	}
};
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);
const nthAlly = (n = 1) => listRuns(world.slot, "wA").filter((r) => r.kind === "ally")[n - 1];

test("a message that waits for the tower identity gets an ally run in a pane split off the tower's tab, with an agent name and pi name of its own, and no local run", async () => {
	const { s, ensured } = await setup();
	world.ally.add("m1", DEV1, "hello from afar");
	world.ally.level.set(DEV1, "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	await sleep(120);
	assert.equal(world.pis.size, 1, "one run for one device");
	const [split] = world.herdr.commands("pane", "split");
	assert.equal(split![2], ensured.pane, "split off the standing pane");
	assert.ok(split!.includes("--no-focus"));
	const [start] = world.herdr.commands("agent", "start");
	assert.match(start![2]!, /^ally-wa-[0-9a-f]{8}$/);
	assert.notEqual(start![start!.indexOf("--pane") + 1], ensured.pane, "not the standing pane");
	const pi = start!.slice(start!.indexOf("--") + 1);
	assert.deepEqual(pi.slice(0, 1), ["--name"]);
	assert.match(pi[1]!, new RegExp(`^ally run · label-${DEV1} · ${id.slice(0, 8)}$`));
	assert.deepEqual(pi.slice(2, 4), ["--sb-run", id]);
	const rec = readRun(world.slot, "wA", id)!;
	assert.equal(rec.kind, "ally");
	assert.equal(rec.device, DEV1);
	assert.equal(rec.level, "forward");
	assert.deepEqual(rec.admitted, ["m1"]);
	assert.equal(world.herdr.pane(rec.pane).tokens.sb_role, "ally");
	const status = ((await ask(s, { cmd: "status" })).towers as { service: { state: string; run?: unknown; allyRuns: { device: string }[] } }[])[0]!.service;
	assert.equal(status.run, undefined, "no local run");
	assert.deepEqual(status.allyRuns.map((a) => a.device), [DEV1]);
	assert.equal(status.state, "standing", "an ally run leaves the service's own state alone");
});

test("the claim of an ally run answers its kind, level, sender, and an ally brief; the brief has the sender, the asks, and the thread, and no head tower or identity", async () => {
	const { s } = await setup();
	world.ally.add("m1", DEV1, "please check the build", { awaitsReply: "c".repeat(32), replyExpected: true });
	world.ally.threads.set(DEV1, [{ dir: "in", at: Date.now() - 60_000, kind: "tower", text: "earlier question" }, { dir: "out", at: Date.now() - 30_000, kind: "tower", text: "earlier answer" }]);
	world.expose?.allyWaiting("sb-tower-wa");
	const got = await claimed(s, await nthRun());
	assert.equal(got.kind, "ally");
	assert.equal(got.level, "reply");
	assert.deepEqual(got.peer, { device: DEV1, label: `label-${DEV1}`, short: DEV1.slice(0, 6), team: "team-1", teamName: "Team One" });
	const brief = String(got.brief);
	assert.match(brief, /You are an ally run/);
	assert.match(brief, new RegExp(`label-${DEV1} \\(${DEV1.slice(0, 6)}\\) of team Team One, at trust level reply`));
	assert.match(brief, /peer's request, not the boss's instruction/);
	assert.match(brief, new RegExp(`Asks in this run[^\\n]*\\n- ${"c".repeat(32)}: please check the build`));
	assert.match(brief, /Thread with this device \(peer text/);
	assert.match(brief, /earlier question/);
	assert.match(brief, /tower_send \{device, message, inReplyTo\?\}/);
	assert.ok(!/head tower: /.test(brief), "an ally run names no head tower");
	assert.ok(!/Your identity for replies/.test(brief), "and no identity of its own");
	assert.ok(brief.length <= 4000);
});

test("the run's events are its device's messages, up to 5 oldest first, with the verified header and the ask id; one that arrives meanwhile waits for the next run", async () => {
	const { s } = await setup();
	for (let i = 1; i <= 6; i++) world.ally.add(`m${i}`, DEV1, `message ${i}`, i === 2 ? { awaitsReply: "d".repeat(32), replyExpected: true } : {});
	world.ally.add("x1", DEV2, "another device");
	world.expose?.allyWaiting("sb-tower-wa");
	const first = await nthRun(1), second = await nthRun(2);
	assert.equal(world.pis.size, 2, "one run per device");
	const runs = [first, second].map((id) => readRun(world.slot, "wA", id)!);
	const run1 = runs.find((r) => r.device === DEV1)!, run2 = runs.find((r) => r.device === DEV2)!;
	assert.deepEqual(run1.admitted, ["m1", "m2", "m3", "m4", "m5"]);
	assert.deepEqual(run2.admitted, ["x1"]);
	const token = String((await claimed(s, run1.id)).token);
	world.ally.add("m7", DEV1, "arrived meanwhile");
	const events = await drain(s, token);
	assert.deepEqual(events.map((e) => e.id), ["m1", "m2", "m3", "m4", "m5"]);
	assert.ok(events.every((e) => e.kind === "link"));
	assert.match(events[0]!.text, new RegExp(`^\\[straw net from=label-${DEV1} id=link:${DEV1} role=tower workspace=theirs remote=label-${DEV1} device=${DEV1.slice(0, 6)} team="Team One" verified=yes kind=tower_send scope=tower to=`));
	assert.match(events[0]!.text, /message 1$/);
	assert.match(events[1]!.text, new RegExp(`reply=expected asks=${"d".repeat(32)}\\]`));
	assert.equal(readRun(world.slot, "wA", run1.id)!.events.length, 5);
	assert.equal((await poll(s, token)).event, undefined, "nothing else is offered to this run");
});

test("tower_done is refused while the run's messages are not all taken, ends the run once pi has exited, and then the messages leave the inbox, the pane closes, and the note is the device's", async () => {
	const { s } = await setup();
	world.ally.add("m1", DEV1, "one");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	const refused = await ask(s, { cmd: "run-done", token, note: "nothing yet" });
	assert.match(String(refused.error), /1 event still for you/);
	await drain(s, token);
	const done = await ask(s, { cmd: "run-done", token, note: "answered\nwaiting for nobody" });
	assert.equal(done.ok, true, JSON.stringify(done));
	assert.deepEqual(world.ally.takenIds, [], "the message leaves the inbox when the run has ended, not before");
	const pane = readRun(world.slot, "wA", id)!.pane;
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	assert.deepEqual(world.ally.takenIds, ["m1"]);
	assert.ok(world.herdr.closed.includes(pane), "the ally pane is closed");
	assert.equal(lastNote(world.slot, "wA", "ally", DEV1)?.note, "answered\nwaiting for nobody");
	assert.equal(lastNote(world.slot, "wA", "local"), undefined, "ally and local notes never cross");
	// The next ally run of the device reads it in its brief.
	world.ally.add("m2", DEV1, "two");
	world.expose?.allyWaiting("sb-tower-wa");
	const next = await claimed(s, await nthRun(2));
	assert.match(String(next.brief), /Handoff note from the last run for this device[^\n]*\nanswered\nwaiting for nobody/);
});

test("a message that arrives during a run waits for a fresh run of the device", async () => {
	const { s } = await setup();
	world.ally.add("m1", DEV1, "one");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	world.ally.add("m2", DEV1, "two");
	world.expose?.allyWaiting("sb-tower-wa");
	await sleep(150);
	assert.equal(world.pis.size, 1, "the device has a run: no second one");
	assert.deepEqual((await drain(s, token)).map((e) => e.id), ["m1"]);
	await ask(s, { cmd: "run-done", token, note: "n" });
	exit(id);
	await until(() => world.pis.size === 2, "the fresh run");
	assert.deepEqual(readRun(world.slot, "wA", await nthRun(2))!.admitted, ["m2"]);
});

test("a crash leaves the messages in the inbox for the next run, two crashes with one message drop it with a notice, and the device is held after three", async () => {
	const { s } = await setup();
	world.ally.add("m1", DEV1, "poison");
	world.expose?.allyWaiting("sb-tower-wa");
	for (let n = 1; n <= 2; n++) {
		const id = await nthRun(n);
		const token = String((await claimed(s, id)).token);
		await drain(s, token);
		exit(id);
		await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", `run ${n} to crash`);
		if (n === 1) {
			assert.deepEqual(world.ally.takenIds, [], "kept for the next run");
			world.expose?.allyWaiting("sb-tower-wa");
		}
	}
	assert.deepEqual(world.ally.takenIds, ["m1"], "dropped after two runs crashed with it");
	const notices = ((await ask(s, { cmd: "status" })).towers as { service: { notices: { text: string }[] } }[])[0]!.service.notices;
	assert.ok(notices.some((n) => /dropped after two ally runs crashed/.test(n.text)));
	const local = ((await ask(s, { cmd: "status" })).towers as { service: { state: string } }[])[0]!.service;
	assert.equal(local.state, "standing", "ally crashes do not hold the local service");
	assert.equal(nthAlly(1)!.outcome, "crashed");
});

test("a sender that left the roster has its messages dropped and no run starts; a run for a device is not started past towerRuns.max, and starts when a slot is free", async () => {
	world.runMax = 1;
	const { s } = await setup();
	world.ally.gone.add(DEV2);
	world.ally.add("g1", DEV2, "from a device that left");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.ally.takenIds.includes("g1"), "the drop");
	assert.equal(world.pis.size, 0);
	world.ally.add("m1", DEV1, "first");
	world.ally.add("n1", "c".repeat(26), "second device");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	await sleep(200);
	assert.equal(world.pis.size, 1, "the limit holds the second device's run");
	const token = String((await claimed(s, id)).token);
	await drain(s, token);
	await ask(s, { cmd: "run-done", token, note: "n" });
	exit(id);
	await until(() => world.pis.size === 2, "the second run once a slot is free");
});

test("a pi without the flag in an ally pane is told to quit; the ally pane is not a standing pane", async () => {
	const { s } = await setup();
	world.ally.add("m1", DEV1, "one");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const rec = readRun(world.slot, "wA", id)!;
	const answer = await ask(s, { cmd: "pane-role", pane: rec.pane, pid: 4242 });
	assert.equal(answer.role, "quit");
	assert.match(String(answer.reason), /ally run/);
});

test("an ally run's tools: tower_send goes to its sender's full id only, inReplyTo only for an ask of the run; a gated tool needs the Allow of its call, once; origin is stamped by the server", async () => {
	const { s } = await setup();
	world.ally.add("m1", DEV1, "question", { awaitsReply: "e".repeat(32), replyExpected: true });
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	world.linkAnswers.set("send", (b) => ({ ok: true, text: "Sent.", details: { device: b.device } }));
	const run = (tool: string, args: Record<string, unknown>, toolCallId?: string) => ask(s, { cmd: "run-tool", token, tool, args, ...(toolCallId ? { toolCallId } : {}) });
	// Free: to the sender by its label, short id or id; always sent to the full id.
	assert.equal((await run("tower_send", { device: `label-${DEV1}`, message: "hi" })).ok, true);
	assert.equal(world.linkCalls.at(-1)!.body.device, DEV1);
	assert.equal(world.linkCalls.at(-1)!.from, "sb-tower-wa");
	assert.equal((await run("tower_send", { device: DEV1.slice(0, 6), message: "hi" })).ok, true);
	assert.match(String((await run("tower_send", { device: DEV1, message: "hi", inReplyTo: "f".repeat(32) })).error), /ask id of one of this run's messages/);
	assert.equal((await run("tower_send", { device: DEV1, message: "answer", inReplyTo: "e".repeat(32) })).ok, true);
	assert.equal(world.linkCalls.at(-1)!.body.inReplyTo, "e".repeat(32));
	// Another device: gated.
	const other = await run("tower_send", { device: DEV2, message: "hi" }, "tc-1");
	assert.match(String(other.error), /was not allowed/);
	// A local session reached with tower_reply: Allow tied to the pane, call id, and arguments; used once.
	world.sessions = [{ id: "main-1", name: "docs-main", herdrLocation: { paneId: "wA:p1" } } as never, { id: "bridge-1", herdrLocation: { paneId: readRun(world.slot, "wA", id)!.pane } } as never];
	const args = { to: "main-1", message: "please look" };
	world.allows.note({ from: "bridge-1", pane: readRun(world.slot, "wA", id)!.pane, owner: "straw-link-gate", dialogId: "dlg-1", toolCallId: "tc-9", title: `Remote request from label-${DEV1}: tower_reply\n\n${JSON.stringify(args, null, 2)}`, at: Date.now() });
	assert.match(String((await run("tower_reply", { ...args, message: "other" }, "tc-9")).error), /other arguments/);
	const sent = await run("tower_reply", args, "tc-9");
	assert.equal(sent.ok, true, JSON.stringify(sent));
	const line = world.client("sb-tower-wa")!.sent.at(-1)!.text;
	assert.match(line, new RegExp(`origin=remote:${DEV1}\\]`));
	assert.match(String((await run("tower_reply", args, "tc-9")).error), /was not allowed/, "an Allow is used once");
	assert.equal(argsDigest(args), argsDigest({ message: "please look", to: "main-1" }));
	// Refused outright, with or without an Allow: a tower identity of this machine, and a tower_send without a device.
	assert.match(String((await run("tower_reply", { to: "sb-tower-wa", message: "x" }, "tc-10")).error), /tower identity of this computer/);
	assert.match(String((await run("tower_send", { message: "x" })).error), /sender only/);
});

test("the Allow check is off at dispatch: an ally run at dispatch calls tower_reply without a confirm; boss_server and link_request stay refused", async () => {
	const { s } = await setup();
	world.ally.level.set(DEV1, "dispatch");
	world.ally.add("m1", DEV1, "do it");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	world.sessions = [{ id: "main-1", name: "docs-main", herdrLocation: { paneId: "wA:p1" } } as never];
	const sent = await ask(s, { cmd: "run-tool", token, tool: "tower_reply", args: { to: "main-1", message: "go" } });
	assert.equal(sent.ok, true, JSON.stringify(sent));
	for (const tool of ["boss_server", "link_request", "call_tower"]) assert.match(String((await ask(s, { cmd: "run-tool", token, tool, args: { action: "restart", reason: "x" } })).error), /not available in an ally run/, tool);
});

test("a forward confirm: the ally run asks its own sender's device, whatever the request names, and the answer reaches the run at its poll", async () => {
	const { s } = await setup();
	world.ally.level.set(DEV1, "forward");
	world.ally.add("m1", DEV1, "do it");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	world.linkAnswers.set("confirm-request", () => ({ ok: true }));
	const asked = await ask(s, { cmd: "link", token, from: "someone-else", body: { op: "confirm-request", team: "t", device: DEV2, dialogId: "dlg-7", digest: "x", tool: "write", args: "{}", tower: "me" } });
	assert.equal(asked.ok, true, JSON.stringify(asked));
	const call = world.linkCalls.at(-1)!;
	assert.equal(call.body.device, DEV1, "the run's sender, not the one the request named");
	assert.equal(call.body.team, "team-1");
	assert.equal(call.from, "sb-tower-wa");
	assert.equal(world.expose?.runs.confirmed("dlg-7", true), true);
	assert.deepEqual((await poll(s, token)).command, { type: "confirmed", dialogId: "dlg-7", allow: true });
	assert.equal(world.expose?.runs.confirmed("dlg-7", true), false, "once");
	// Anything else of the link is not an ally run's.
	for (const op of ["list", "send", "taken", "gui", "request-run"]) assert.match(String((await ask(s, { cmd: "link", token, body: { op } })).error), /ally run/, op);
});
