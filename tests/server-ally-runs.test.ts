import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { argsDigest } from "../src/server/allows.ts";
import { callControl } from "../src/server/socket.ts";
import { lastNote, listRuns, readExpects, readRun } from "../src/server/towerrunstore.ts";
import { readLedger, readQueue } from "../src/server/towerstore.ts";

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

test("the ally brief shows the mains inside the project the sender's team binds and no other tab of the workspace; with no project bound it shows none (RV6-F001)", async () => {
	const place = (id: string, name: string, pane: string, tab: string, label: string, cwd: string) => {
		world.herdr.addPane(pane, tab, "pi").tokens.sb_role = "main";
		world.herdr.pane(pane).cwd = cwd;
		return { id, name, herdrLocation: { status: "ok" as const, workspace: { id: "wA", label: "Alpha" }, tab: { id: tab, label }, paneId: pane } };
	};
	const proj = join(world.stateDir, "proj"), elsewhere = join(world.stateDir, "elsewhere");
	mkdirSync(join(proj, "app"), { recursive: true });
	mkdirSync(elsewhere, { recursive: true });
	world.sessions = [place("in-main-1", "inside-main", "wA:p71", "wA:t1", "work", join(proj, "app")), place("out-main-1", "outside-main", "wA:p72", "wA:t2", "docs", elsewhere)];
	const briefFor = async (device: string, project: string | undefined) => {
		if (project) world.ally.projects.set("team-1", project);
		else world.ally.projects.delete("team-1");
		world.ally.add(`m-${device}`, device, "hello");
		world.expose?.allyWaiting("sb-tower-wa");
		const got = await claimed(s, await nthRun(world.pis.size + 1));
		return String(got.brief);
	};
	const { s } = await setup();
	const bound = await briefFor(DEV1, proj);
	assert.match(bound, /inside-main/);
	assert.doesNotMatch(bound, /outside-main|docs: /, "a tab outside the project shows nothing of itself");
	const none = await briefFor(DEV2, undefined);
	assert.doesNotMatch(none, /inside-main|outside-main/);
	assert.match(none, /What your sender may see[^]*no tab of this workspace has joined/);
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
	// Another device: refused outright, whatever the call id (RV6-F007).
	const other = await run("tower_send", { device: DEV2, message: "hi" }, "tc-1");
	assert.match(String(other.error), /sender only/);
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

test("a sender that leaves the roster during a run gets the run ended with quit and its tools refused (RV6-F002)", async () => {
	const { s } = await setup();
	world.ally.add("m1", DEV1, "hello");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	assert.equal((await ask(s, { cmd: "run-tool", token, tool: "boss_status", args: {} })).ok, true);
	world.ally.gone.add(DEV1);
	const refused = await ask(s, { cmd: "run-tool", token, tool: "boss_status", args: {} });
	assert.equal(refused.ok, false);
	assert.match(String(refused.error), /no longer a member/);
	await until(async () => (await poll(s, token)).command !== undefined, "the quit command");
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome, "the run to end");
	assert.equal(readRun(world.slot, "wA", id)!.outcome, "quit");
});

test("the server's level for an ally run is the lower of the claimed level and the device's level now: lowering trust from dispatch makes the gate apply at once (RV6-F002)", async () => {
	const { s } = await setup();
	world.ally.level.set(DEV1, "dispatch");
	world.ally.add("m1", DEV1, "do it");
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	world.sessions = [{ id: "main-1", name: "docs-main", herdrLocation: { paneId: "wA:p1" } } as never];
	assert.equal((await ask(s, { cmd: "run-tool", token, tool: "tower_reply", args: { to: "main-1", message: "go" } })).ok, true, "at dispatch there is no gate");
	world.ally.level.set(DEV1, "reply");
	const gated = await ask(s, { cmd: "run-tool", token, tool: "tower_reply", args: { to: "main-1", message: "go" } });
	assert.match(String(gated.error), /needs the boss's confirm/);
	// Back at dispatch (what the run was claimed at): the gate is off again; a run is never above its claim.
	world.ally.level.set(DEV1, "dispatch");
	assert.equal((await ask(s, { cmd: "run-tool", token, tool: "tower_reply", args: { to: "main-1", message: "go" } })).ok, true);
});

test("a forward confirm is the requester's: another run's forget-confirm is refused, a failed request and an ended run leave nothing behind (RV6-F011)", async () => {
	const { s } = await setup();
	world.ally.level.set(DEV1, "forward");
	world.ally.level.set(DEV2, "forward");
	world.ally.add("m1", DEV1, "one");
	world.ally.add("x1", DEV2, "two");
	world.expose?.allyWaiting("sb-tower-wa");
	const ids = [await nthRun(1), await nthRun(2)];
	const tokens = new Map<string, string>();
	for (const id of ids) tokens.set(readRun(world.slot, "wA", id)!.device!, String((await claimed(s, id)).token));
	const [t1, t2] = [tokens.get(DEV1)!, tokens.get(DEV2)!];
	const confirm = (token: string, dialogId: string) => ask(s, { cmd: "link", token, body: { op: "confirm-request", dialogId, digest: "x", tool: "write", args: "{}", tower: "me", team: "t", device: "d" } });
	const forget = (token: string, dialogId: string) => ask(s, { cmd: "link", token, body: { op: "forget-confirm", dialogId } });
	world.linkAnswers.set("confirm-request", () => ({ ok: true }));
	world.linkAnswers.set("forget-confirm", () => ({ ok: true }));
	assert.equal((await confirm(t1, "dlg-1")).ok, true);
	// Another run cannot make the server forget it, and the holder is not asked to.
	const before = world.linkCalls.length;
	assert.equal((await forget(t2, "dlg-1")).ok, false);
	assert.equal(world.linkCalls.length, before, "the holder heard nothing of it");
	assert.equal((await forget(t1, "dlg-1")).ok, true, "the requester may");
	assert.equal(world.expose?.runs.confirmed("dlg-1", true), false, "forgotten");
	// A request the holder refused is not kept.
	world.linkAnswers.set("confirm-request", () => ({ ok: false, error: "no such device" }));
	await confirm(t1, "dlg-2");
	assert.equal(world.expose?.runs.confirmed("dlg-2", true), false);
	// A run that ends takes its waits with it.
	world.linkAnswers.set("confirm-request", () => ({ ok: true }));
	assert.equal((await confirm(t2, "dlg-3")).ok, true);
	await world.expose!.runs.release({ token: t2, reason: "test" });
	assert.equal(world.expose?.runs.confirmed("dlg-3", true), false);
});

/** An ally run for DEV1 at dispatch, claimed; and the main `main-1` it may write to. */
const dispatchRun = async () => {
	const { s } = await setup();
	world.ally.level.set(DEV1, "dispatch");
	world.ally.add("m1", DEV1, "ask the main for the status");
	world.expose?.allyWaiting("sb-tower-wa");
	world.sessions = [{ id: "main-1", name: "docs-main", herdrLocation: { status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId: "wA:p1" } } as never];
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	return { s, id, token, run: (tool: string, args: Record<string, unknown>) => ask(s, { cmd: "run-tool", token, tool, args }) };
};
const finish = async (s: Running, id: string, token: string) => {
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "asked the main" })).ok, true);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome, "the run to end");
};
const towerClient = () => world.client("sb-tower-wa")!;
/** The run ids Herdr was asked to start pi for (a main the opener starts has no `--sb-run`, and the fake keys it by a placeholder). */
const runIds = () => [...world.pis.keys()].filter((k) => /^[0-9a-f]{16}$/.test(k));

test("what an ally run waits for from a local session is its device's, not the local run's: no expectation reaches the local brief, and the session's answer goes to the device's next ally run, never to a local run (RV6-F003)", async () => {
	const { s, id, token, run } = await dispatchRun();
	const sent = await run("tower_reply", { to: "main-1", message: "what is the status of the export?", reply: true });
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.deepEqual(readExpects(world.slot, "wA", Date.now()), [], "the local run's expectations stay its own");
	await finish(s, id, token);
	towerClient().incoming({ id: "main-1", name: "docs-main" }, { id: "a1", content: { text: "the export is green" } } as never);
	await until(() => world.pis.size === 2, "an ally run for the answer");
	assert.deepEqual(readQueue(world.slot, "wA"), [], "nothing entered the local queue");
	const second = [...world.pis.keys()][1]!;
	await until(() => readRun(world.slot, "wA", second)?.pid, "the second run's pid");
	assert.equal(readRun(world.slot, "wA", second)!.kind, "ally");
	assert.equal(readRun(world.slot, "wA", second)!.device, DEV1);
	const token2 = String((await claimed(s, second)).token);
	const events = await drain(s, token2);
	assert.equal(events.length, 1);
	assert.match(events[0]!.text, /kind=tower_reply/);
	assert.match(events[0]!.text, /the export is green$/);
	const status = ((await ask(s, { cmd: "status" })).towers as { service: { run?: unknown } }[])[0]!.service;
	assert.equal(status.run, undefined, "no local run was woken");
	// The answer is delivered once: it left the store with the run.
	assert.equal((await ask(s, { cmd: "run-done", token: token2, note: "relayed" })).ok, true);
	exit(second);
	await until(() => readRun(world.slot, "wA", second)?.outcome, "the second run to end");
	await sleep(150);
	assert.equal(world.pis.size, 2, "and no third run");
});

test("a main an ally run opened is the device's: the ledger of the local run holds nothing of it, and the main's report goes to the device's next ally run (RV6-F003)", async () => {
	const { s, id, token, run } = await dispatchRun();
	const orig = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (p, args) => {
		orig(p, args);
		if (args.includes("--sb-run")) return;
		p.tokens.sb_role = "main";
		world.sessions.push({ id: "opened-1", name: "main", herdrLocation: { status: "current", paneId: p.pane_id } as never });
	};
	const opened = await run("boss_open_main", { request: "Fix the export button", sender: "docs-main" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal(readLedger(world.slot, "wA", Date.now()).length, 0, "the local run's ledger (its brief's opened lines) is untouched");
	await finish(s, id, token);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "done: the button is fixed" } } as never);
	await until(() => runIds().length === 2, "an ally run for the report");
	assert.deepEqual(readQueue(world.slot, "wA"), []);
	const second = runIds()[1]!;
	await until(() => readRun(world.slot, "wA", second)?.pid, "the second run's pid");
	const events = await drain(s, String((await claimed(s, second)).token));
	assert.match(events[0]!.text, /done: the button is fixed$/);
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

// The net view sorts the Agents list by `sb_order` and draws the branches from `sb_indent` (herdr-plugin/net-view.mjs): an ally run's pane is a row among the tower's, keyed after the tower like a subagent
// is after its launcher. Its tokens last 10 minutes and a run may last 20, so the tower's 4 minute publish writes them again.
const cut = (v: string) => (v.length > 24 ? `${v.slice(0, 23)}…` : v);
const NET = ["sb_role", "sb_order", "sb_mark", "sb_indent", "sb_name"] as const;
const netTokens = (pane: string) => Object.fromEntries(NET.flatMap((k) => (world.herdr.pane(pane).tokens[k] === undefined ? [] : [[k, world.herdr.pane(pane).tokens[k]]])));

test("an ally run's pane is keyed after its tower, marked [ally] with the device's label, drawn as a branch among its siblings, written again with the tower's publish, and cleared when the run ends", async () => {
	world.refreshMs = 100;
	const { s, ensured } = await setup();
	await until(() => world.herdr.pane(ensured.pane as string).tokens.sb_order, "the tower's order key");
	const tower = world.herdr.pane(ensured.pane as string).tokens.sb_order!;
	world.ally.add("m1", DEV1, "one");
	world.expose?.allyWaiting("sb-tower-wa");
	const id1 = await nthRun();
	const pane1 = readRun(world.slot, "wA", id1)!.pane;
	assert.deepEqual(netTokens(pane1), { sb_role: "ally", sb_order: `${tower}.000`, sb_mark: `[ally] ${cut(`label-${DEV1}`)}`, sb_indent: "└─", sb_name: "ally run" }, "one ally: the last branch");
	// A second device's run is a sibling after it, and the first gets the branch that has a later sibling.
	world.ally.add("m2", DEV2, "two");
	world.expose?.allyWaiting("sb-tower-wa");
	const id2 = await nthRun(2);
	const pane2 = readRun(world.slot, "wA", id2)!.pane;
	assert.deepEqual(netTokens(pane2), { sb_role: "ally", sb_order: `${tower}.001`, sb_mark: `[ally] ${cut(`label-${DEV2}`)}`, sb_indent: "└─", sb_name: "ally run" });
	await until(() => world.herdr.pane(pane1).tokens.sb_indent === "├─", "the first ally to show a later sibling");
	// Herdr lets the tokens lapse after 10 minutes: the tower's publish writes them again.
	for (const k of NET) delete world.herdr.pane(pane1).tokens[k];
	await until(() => world.herdr.pane(pane1).tokens.sb_order === `${tower}.000`, "the refresh to write the ally pane's tokens again");
	assert.equal(world.herdr.pane(pane1).tokens.sb_role, "ally");
	// The first run ends: its tokens are cleared before its pane closes, and the sibling takes its place in the order.
	const token = String((await claimed(s, id1)).token);
	await drain(s, token);
	await ask(s, { cmd: "run-done", token, note: "n" });
	exit(id1);
	await until(() => readRun(world.slot, "wA", id1)?.outcome === "done", "the first run to end");
	const calls = world.herdr.calls;
	const cleared = calls.findIndex((c) => c[0] === "pane" && c[1] === "report-metadata" && c[2] === pane1 && c.includes("--clear-token") && c.includes("sb_order"));
	const closed = calls.findIndex((c) => c[0] === "pane" && c[1] === "close" && c[2] === pane1);
	assert.ok(cleared >= 0 && closed > cleared, `cleared ${cleared}, closed ${closed}`);
	await until(() => world.herdr.pane(pane2).tokens.sb_order === `${tower}.000`, "the remaining ally to move up");
	assert.equal(world.herdr.pane(pane2).tokens.sb_indent, "└─");
});
