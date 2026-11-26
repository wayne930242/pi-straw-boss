import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { addRoute, answeredAsks, dropOpened, MAX_OPENED, MAX_OPENED_PER_DEVICE, openedFor, openedRoom, readAnswers, readRoutes, routeOf } from "../src/server/allyroute.ts";
import { ALLY_FILES, KEEP_MS, towerDir } from "../src/server/towerstore.ts";
import { readRun } from "../src/server/towerrunstore.ts";

// A main an ally run opens for the device it serves (docs/specs/2026-11-04-link-relay.md, Gap 2): the sender is the device, named `link:<id>` as the run's header names it, and the main's report goes back to
// that device through a run of the same device, with the ask the run was answering. Straw Link is a trust boundary, so this file also holds the refusals: another device, a device that left, a level that needs the
// boss's Allow, and a report that must not reach another device's run.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV1 = "a".repeat(26), DEV2 = "b".repeat(26), ASK = "c".repeat(32);
const poll = (s: Running, token: string) => ask(s, { cmd: "run-poll", token, idle: true });
const drain = async (s: Running, token: string) => {
	const events: { id: string; kind: string; text: string }[] = [];
	for (;;) {
		const event = (await poll(s, token)).event as (typeof events)[number] | undefined;
		if (!event) return events;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
		events.push(event);
	}
};
const runIds = () => [...world.pis.keys()].filter((k) => /^[0-9a-f]{16}$/.test(k));
const towerClient = () => world.client("sb-tower-wa")!;
const claim = async (s: Running, n: number) => {
	await until(() => runIds().length >= n, `run ${n} to start`);
	const id = runIds()[n - 1]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return { id, token: String(got.token) };
};
/** An ally run for DEV1 (at `level`, with the message `text`), claimed, and an opener that makes a main `opened-1` the way Herdr and pi would. */
async function allyRun(level = "dispatch", over: Parameters<TowerWorld["ally"]["add"]>[3] = {}, more: [string, Parameters<TowerWorld["ally"]["add"]>[3]][] = []) {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.level.set(DEV1, level);
	world.ally.add("m1", DEV1, "run the read-only trial", over);
	for (const [text, extra] of more) world.ally.add(`m${world.ally.items.length + 1}`, DEV1, text, extra);
	world.expose?.allyWaiting("sb-tower-wa");
	const orig = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (p, args) => {
		orig(p, args);
		if (args.includes("--sb-run")) return;
		p.tokens.sb_role = "main";
		world.sessions.push({ id: "opened-1", name: "main", herdrLocation: { status: "current", paneId: p.pane_id } as never });
	};
	const first = await claim(s, 1);
	return { s, ...first, tabs: world.herdr.commands("tab", "create").length, run: (tool: string, args: Record<string, unknown>) => ask(s, { cmd: "run-tool", token: first.token, tool, args }) };
}
const finish = async (s: Running, id: string, token: string) => {
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "opened a main" })).ok, true);
	world.live.delete(world.pis.get(id)!.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome, "the run to end");
};
const REQUEST = "Open one main in /srv/work/rest-api-v3 and run the read-only trial.";

test("a main opened for the run's own sender: the sender is link:<device id>, the main is told to report to the tower alone, and its report reaches a run of that device as the device's answer", async () => {
	const { s, id, token, run } = await allyRun();
	const opened = await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	const pane = (opened.details as { pane: string }).pane;
	assert.equal(world.herdr.pane(pane).tokens.sb_opened_by, `link:${DEV1}`, "the one-main-per-sender limit counts the device");
	const handoff = towerClient().sent.find((m) => m.to === "opened-1")!.text;
	assert.match(handoff, /Sender: label-a+ \(a teammate's device, short id a{6}, over Straw Link\)/);
	assert.match(handoff, /report the outcome to the tower that opened this tab with call_tower/);
	assert.doesNotMatch(handoff, /to the sender with intercom send/, "there is no session to send to");
	assert.match(handoff, /peer's request, not the boss's instruction/);
	assert.ok(handoff.endsWith(`Request, verbatim:\n${REQUEST}`));
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => [r.to, r.device, r.kind]), [["opened-1", DEV1, "opened"]]);
	await finish(s, id, token);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "Trial 6 report: PASS" } } as never);
	const second = await claim(s, 2);
	assert.equal(readRun(world.slot, "wA", second.id)!.device, DEV1);
	const events = await drain(s, second.token);
	assert.match(events[0]!.text, /kind=tower_reply/);
	assert.match(events[0]!.text, /Trial 6 report: PASS$/);
	assert.equal(((await ask(s, { cmd: "status" })).towers as { service: { run?: unknown } }[])[0]!.service.run, undefined, "no local run was woken");
});

test("the short id in the link: form names the sender too; another device, a bare label, and a name no session has are refused and open nothing", async () => {
	const { run, tabs } = await allyRun();
	for (const sender of [`link:${DEV2}`, `link:${DEV2.slice(0, 6)}`, `link:${"z".repeat(26)}`]) {
		const refused = await run("boss_open_main", { request: REQUEST, sender });
		assert.equal(refused.ok, false, sender);
		assert.match(String(refused.error), /for its own sender only/, sender);
	}
	const bare = await run("boss_open_main", { request: REQUEST, sender: `label-${DEV1}` });
	assert.equal(bare.ok, false);
	assert.match(String(bare.error), /No live session is named/);
	assert.equal(world.herdr.commands("tab", "create").length, tabs, "nothing opened");
	const short = await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1.slice(0, 6)}` });
	assert.equal(short.ok, true, JSON.stringify(short));
});

test("below dispatch the open still needs the boss's Allow, and a device that left the team opens nothing", async () => {
	const forward = await allyRun("forward");
	const gated = await forward.run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` });
	assert.equal(gated.ok, false);
	assert.match(String(gated.error), /needs the boss's confirm/);
	assert.equal(world.herdr.commands("tab", "create").length, forward.tabs);
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()), []);
	world.ally.gone.add(DEV1);
	const left = await forward.run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` });
	assert.equal(left.ok, false);
	assert.match(String(left.error), /no longer a member/);
	assert.equal(world.herdr.commands("tab", "create").length, forward.tabs);
});

test("a report goes to the device the main was opened for and to no other: a run of another device is not given it", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	// Another device has a message waiting, and its run starts first: it must not be given the report.
	world.ally.add("m2", DEV2, "hello from the other device");
	world.expose?.allyWaiting("sb-tower-wa");
	const other = await claim(s, 2);
	assert.equal(readRun(world.slot, "wA", other.id)!.device, DEV2);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "Trial 6 report: PASS" } } as never);
	const mine = await claim(s, 3);
	assert.equal(readRun(world.slot, "wA", mine.id)!.device, DEV1);
	assert.ok((await drain(s, other.token)).every((e) => !/Trial 6 report/.test(e.text)), "the other device's run does not see it");
	assert.match((await drain(s, mine.token))[0]!.text, /Trial 6 report: PASS$/);
});

test("a device that left the team never hears the report: it is dropped and no run is begun for it", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	world.ally.gone.add(DEV1);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "Trial 6 report: PASS" } } as never);
	await sleep(400);
	assert.deepEqual(readAnswers(world.slot, "wA", Date.now()), [], "the report is not kept for a device that left");
	assert.equal(runIds().length, 1, "no run for a device that left");
	assert.equal(towerClient().sent.filter((m) => m.to !== "opened-1").length, 0);
});

test("the ask the run was answering stays with the main it opened: the report comes with asks= and is answered with inReplyTo; an ask the run already answered is not carried", async () => {
	const { s, id, token, run } = await allyRun("dispatch", { awaitsReply: ASK, replyExpected: true });
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "Trial 6 report: PASS" } } as never);
	const second = await claim(s, 2);
	const events = await drain(s, second.token);
	assert.match(events[0]!.text, new RegExp(`asks=${ASK}`));
	world.linkAnswers.set("send", () => ({ ok: true, text: "Sent.", details: { team: "team-1", device: DEV1, id: "e".repeat(32), as: "tower-reply" } }));
	const sent = await ask(s, { cmd: "run-tool", token: second.token, tool: "tower_send", args: { device: DEV1, message: "Trial 6 report: PASS", inReplyTo: ASK } });
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.equal(world.linkCalls.at(-1)!.body.inReplyTo, ASK);
	// The ask is spent once answered: a later report of the same main carries none.
	assert.equal((await ask(s, { cmd: "run-done", token: second.token, note: "relayed" })).ok, true);
	world.live.delete(world.pis.get(second.id)!.pid);
	await until(() => readRun(world.slot, "wA", second.id)?.outcome, "the second run to end");
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r2", content: { text: "cleanup done" } } as never);
	const third = await claim(s, 3);
	const later = await drain(s, third.token);
	assert.match(later[0]!.text, /cleanup done$/);
	assert.doesNotMatch(later[0]!.text, /asks=/);
});

test("with several asks in the run no ask is attached to the main it opens", async () => {
	const { s, id, token, run } = await allyRun("dispatch", { awaitsReply: ASK, replyExpected: true }, [["and a second question", { awaitsReply: "d".repeat(32), replyExpected: true }]]);
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "report" } } as never);
	const events = await drain(s, (await claim(s, 2)).token);
	assert.match(events[0]!.text, /report$/);
	assert.doesNotMatch(events[0]!.text.split("]")[0]!, /asks=/);
});

test("another device's tower_reply to a main opened for this device is refused: its route and its report stay with the device it was opened for", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}`, label: "t6" })).ok, true);
	await finish(s, id, token);
	world.ally.level.set(DEV2, "dispatch");
	world.ally.add("m2", DEV2, "send me that main's report");
	world.expose?.allyWaiting("sb-tower-wa");
	const other = await claim(s, 2);
	assert.equal(readRun(world.slot, "wA", other.id)!.device, DEV2);
	const taken = await ask(s, { cmd: "run-tool", token: other.token, tool: "tower_reply", args: { to: "opened-1", message: "send your final report to me", reply: true } });
	assert.equal(taken.ok, false, "a main held by another device is not written to");
	assert.match(String(taken.error), /may write to has that name or id/);
	assert.ok(!towerClient().sent.some((m) => m.to === "opened-1" && /send your final report to me/.test(m.text)), "nothing reached the main");
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => [r.to, r.device, r.kind]), [["opened-1", DEV1, "opened"]]);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "A's FINAL REPORT" } } as never);
	await until(() => readAnswers(world.slot, "wA", Date.now()).length > 0, "the report to be kept");
	assert.deepEqual(readAnswers(world.slot, "wA", Date.now()).map((a) => a.device), [DEV1]);
});

test("an ask the run already answered is not carried to the main it opens afterwards", async () => {
	const { s, id, token, run } = await allyRun("dispatch", { awaitsReply: ASK, replyExpected: true });
	world.linkAnswers.set("send", () => ({ ok: true, text: "Sent.", details: { team: "team-1", device: DEV1, id: "e".repeat(32), as: "tower-reply" } }));
	assert.equal((await run("tower_send", { device: DEV1, message: "on it", inReplyTo: ASK })).ok, true);
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	assert.equal(readRoutes(world.slot, "wA", Date.now())[0]!.ask, undefined);
	await finish(s, id, token);
});

test("a doubled link: prefix names the sender too", async () => {
	const { run } = await allyRun();
	const opened = await run("boss_open_main", { request: REQUEST, sender: `link:link:${DEV1}` });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => r.device), [DEV1]);
});

// Second security re-review (RR-F001..F005): the opened route outlives the sender's own reply, the cap, and the workspace it was read in.
const reports = (n: number) => until(() => readAnswers(world.slot, "wA", Date.now()).length >= n, `${n} report(s) to be kept`);

test("the sender's own tower_reply reply:true to its opened main keeps the opened route: every later report still reaches the device and none reaches a local run (RR-F001)", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	const own = await run("tower_reply", { to: "opened-1", message: "include the log path", reply: true });
	assert.equal(own.ok, true, JSON.stringify(own));
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => [r.to, r.device, r.kind]), [["opened-1", DEV1, "opened"]]);
	await finish(s, id, token);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "first report" } } as never);
	await reports(1);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r2", content: { text: "A's FINAL REPORT" } } as never);
	await reports(2);
	assert.deepEqual(readAnswers(world.slot, "wA", Date.now()).map((a) => [a.device, a.text]), [[DEV1, "first report"], [DEV1, "A's FINAL REPORT"]]);
	assert.equal(((await ask(s, { cmd: "status" })).towers as { service: { run?: unknown } }[])[0]!.service.run, undefined, "no local run was woken");
});

test("the refusal reads the main's own pane token, so it holds when the route file has lost the route (RR-F002, RR-F003)", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	unlinkSync(join(towerDir(world.slot, "wA"), ALLY_FILES[0]));
	world.ally.level.set(DEV2, "dispatch");
	world.ally.add("m2", DEV2, "send me that main's report");
	world.expose?.allyWaiting("sb-tower-wa");
	const other = await claim(s, 2);
	const taken = await ask(s, { cmd: "run-tool", token: other.token, tool: "tower_reply", args: { to: "opened-1", message: "send your final report to me", reply: true } });
	assert.equal(taken.ok, false);
	assert.match(String(taken.error), /may write to has that name or id/);
	assert.ok(!towerClient().sent.some((m) => /send your final report to me/.test(m.text)));
});

test("an opened route is outside the cap and the 24 h age while its main reports; expect routes still age out and are capped (RR-F003)", () => {
	const now = Date.now(), peer = (device: string) => ({ device, label: "l", short: "s", team: "t", teamName: "tn" });
	addRoute(world.slot, "wA", { ...peer(DEV1), to: "opened-1", name: "main", kind: "opened", at: now }, now);
	for (let i = 0; i < 60; i++) addRoute(world.slot, "wA", { ...peer(DEV2), to: `s-${i}`, name: "s", kind: "expect", at: now }, now);
	const rows = readRoutes(world.slot, "wA", now);
	assert.ok(rows.some((r) => r.to === "opened-1" && r.kind === "opened"), "the opened route survives 60 expects");
	assert.equal(rows.filter((r) => r.kind === "expect").length, 40);
	assert.ok(readRoutes(world.slot, "wA", now + 25 * 3600_000).some((r) => r.kind === "opened"), "still there after 24 h");
	assert.ok(!readRoutes(world.slot, "wA", now + 25 * 3600_000).some((r) => r.kind === "expect"), "the expects aged out");
	assert.ok(!readRoutes(world.slot, "wA", now + 8 * 24 * 3600_000).some((r) => r.kind === "opened"), "a main silent for a week is let go");
});

test("below dispatch, a write to a main opened for another device is refused before the boss's Allow is asked or spent (RR-F004)", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	world.ally.level.set(DEV2, "forward");
	world.ally.add("m2", DEV2, "send me that main's report");
	world.expose?.allyWaiting("sb-tower-wa");
	const other = await claim(s, 2);
	const taken = await ask(s, { cmd: "run-tool", token: other.token, tool: "tower_reply", args: { to: "opened-1", message: "x", reply: true }, toolCallId: "call-1" });
	assert.equal(taken.ok, false);
	assert.match(String(taken.error), /may write to has that name or id/);
	assert.doesNotMatch(String(taken.error), /confirm|not allowed/);
});

test("the asks a run answered are forgotten after their lifetime (RR-F005)", () => {
	let t = 1000;
	const seen = answeredAsks(() => t);
	seen.add("run-1", "ask-1");
	assert.equal(seen.has("run-1", "ask-1"), true);
	assert.equal(seen.has("run-2", "ask-1"), false);
	t += KEEP_MS + 1;
	seen.add("run-2", "ask-2");
	assert.equal(seen.has("run-1", "ask-1"), false, "pruned");
	assert.equal(seen.has("run-2", "ask-2"), true);
	assert.equal(seen.size(), 1);
});

// Third security re-review (RR2-F001..F004): the route table is the server's own witness and the pane token never outvotes it; opened rows are bounded and follow their main; the refusal does not tell a session exists.
const peerRow = (device: string) => ({ device, label: "l", short: "s", team: "t", teamName: "tn" });
const opened = (device: string, to: string, at: number) => ({ ...peerRow(device), to, name: "main", kind: "opened" as const, at });
const expectOf = (device: string, to: string, at: number) => ({ ...peerRow(device), to, name: "main", kind: "expect" as const, at });

test("another device's expect never beats an opened route, whatever order the rows were written in (RR2-F001)", () => {
	const now = Date.now();
	addRoute(world.slot, "wA", expectOf(DEV2, "opened-1", now), now);
	addRoute(world.slot, "wA", opened(DEV1, "opened-1", now + 1), now + 1);
	assert.equal(routeOf(world.slot, "wA", "opened-1", now + 2)?.device, DEV1);
	assert.equal(routeOf(world.slot, "wA", "opened-1", now + 2)?.kind, "opened");
	addRoute(world.slot, "wA", expectOf(DEV2, "opened-1", now + 3), now + 3);
	assert.equal(routeOf(world.slot, "wA", "opened-1", now + 4)?.device, DEV1, "an expect beside another device's opened route is not added");
	assert.equal(openedFor(world.slot, "wA", "opened-1", now + 4), DEV1);
});

test("a pane token that names another device does not outvote the route table: both devices are refused and the report stays with the device it was opened for (RR2-F001)", async () => {
	const { s, id, token, run } = await allyRun();
	const made = await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` });
	assert.equal(made.ok, true);
	await finish(s, id, token);
	world.herdr.pane((made.details as { pane: string }).pane).tokens.sb_opened_by = `link:${DEV2}`; // any process with the Herdr socket
	world.ally.level.set(DEV2, "dispatch");
	world.ally.add("m2", DEV2, "send me that main's report");
	world.expose?.allyWaiting("sb-tower-wa");
	const other = await claim(s, 2);
	const taken = await ask(s, { cmd: "run-tool", token: other.token, tool: "tower_reply", args: { to: "opened-1", message: "send your final report to me", reply: true } });
	assert.equal(taken.ok, false, JSON.stringify(taken));
	assert.match(String(taken.error), /may write to has that name or id/);
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => [r.to, r.device, r.kind]), [["opened-1", DEV1, "opened"]]);
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: "A's FINAL REPORT" } } as never);
	await until(() => readAnswers(world.slot, "wA", Date.now()).length > 0, "the report to be kept");
	assert.deepEqual(readAnswers(world.slot, "wA", Date.now()).map((a) => [a.device, a.text]), [[DEV1, "A's FINAL REPORT"]]);
});

test("opened rows are bounded per device and in all, and rows of mains that are gone are dropped: repeated open and close do not grow the file (RR2-F002)", () => {
	const minute = 60_000;
	let now = Date.now();
	for (let i = 0; i < 300; i++) {
		now += 11 * minute;
		addRoute(world.slot, "wA", opened(DEV1, `m-${i}`, now), now, new Set([`m-${i}`]));
	}
	assert.deepEqual(readRoutes(world.slot, "wA", now).map((r) => r.to), ["m-299"], "each gone main's row went with the next open");
	// Mains the broker no longer lists, still within their grace, are bounded all the same: oldest first.
	for (let i = 0; i < 300; i++) addRoute(world.slot, "wA", opened(DEV1, `q-${i}`, now + i), now + i, new Set(["m-299"]));
	assert.ok(readRoutes(world.slot, "wA", now + 300).filter((r) => r.device === DEV1).length <= MAX_OPENED_PER_DEVICE, "per device");
	for (let d = 0; d < 20; d++) for (let i = 0; i < 8; i++) addRoute(world.slot, "wA", opened(`d${d}`.padEnd(26, "x"), `z-${d}-${i}`, now + 400 + d * 8 + i), now + 400 + d * 8 + i, new Set(), new Set());
	const rows = readRoutes(world.slot, "wA", now + 1000);
	assert.ok(rows.length <= MAX_OPENED, `in all: ${rows.length}`);
	assert.ok(rows.some((r) => r.to === "z-19-7"), "the newest is kept");
	assert.ok(!rows.some((r) => r.to === "z-0-0"), "the oldest went first");
});

test("a dead main's row is evicted before a live one's when the cap is reached, and closing a main drops its row (RR2-F002)", () => {
	const now = Date.now();
	for (let i = 0; i < MAX_OPENED_PER_DEVICE; i++) addRoute(world.slot, "wA", opened(DEV1, `s-${i}`, now + i), now + i);
	addRoute(world.slot, "wA", opened(DEV1, "s-new", now + 30), now + 30, new Set(["s-0", "s-new"]));
	const rows = readRoutes(world.slot, "wA", now + 31).map((r) => r.to);
	assert.ok(rows.includes("s-0") && rows.includes("s-new"), "the oldest row is live, so it stays while a dead one goes");
	assert.ok(rows.length <= MAX_OPENED_PER_DEVICE);
	// A live row is never trimmed (boss 2026-11-26): past the cap with every main listed, every row stays, and the next open is refused instead.
	const all = new Set(readRoutes(world.slot, "wA", now + 31).map((r) => r.to).concat("s-more"));
	addRoute(world.slot, "wA", opened(DEV1, "s-more", now + 32), now + 32, all);
	assert.equal(readRoutes(world.slot, "wA", now + 33).length, MAX_OPENED_PER_DEVICE + 1);
	assert.match(openedRoom(world.slot, "wA", DEV1, now + 33, all)!, /already has 24 mains and workers/);
	assert.equal(openedRoom(world.slot, "wA", "other".padEnd(26, "x"), now + 33, all), undefined, "another device has room");
	dropOpened(world.slot, "wA", "s-0", now + 11);
	assert.ok(!readRoutes(world.slot, "wA", now + 12).some((r) => r.to === "s-0"));
	assert.equal(openedFor(world.slot, "wA", "s-new", now + 12), DEV1, "other rows stay");
});

test("below dispatch, with no Allow, a session that does not exist and a writable local session get the same answer, and neither says whether it exists (RR3-F002)", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	world.sessions.push({ id: "local-1", name: "docs-main" });
	world.ally.level.set(DEV2, "reply");
	world.ally.add("m2", DEV2, "probe");
	world.expose?.allyWaiting("sb-tower-wa");
	const other = await claim(s, 2);
	const errors: string[] = [];
	for (const to of ["local-1", "docs-main", "no-such-session"]) for (const extra of [{}, { toolCallId: "call-1" }]) {
		const r = await ask(s, { cmd: "run-tool", token: other.token, tool: "tower_reply", args: { to, message: "x", reply: false }, ...extra });
		assert.equal(r.ok, false);
		errors.push(String(r.error).replace(to, "<to>"));
	}
	assert.equal(new Set(errors.filter((_, i) => i % 2 === 0)).size, 1, errors.join(" | "));
	assert.equal(new Set(errors.filter((_, i) => i % 2 === 1)).size, 1, errors.join(" | "));
	assert.match(errors[0]!, /needs the boss's confirm/);
	const held = await ask(s, { cmd: "run-tool", token: other.token, tool: "tower_reply", args: { to: "opened-1", message: "x", reply: false }, toolCallId: "call-2" });
	assert.match(String(held.error), /may write to has that name or id/, "a main another device holds is still refused, with no Allow spent");
});

test("a working main that one broker read misses keeps its row while Herdr still shows its pane; it goes when both say gone (RR3-F001)", () => {
	const t0 = Date.now(), min = 60_000, panes = new Set(["pane-M"]);
	addRoute(world.slot, "wA", { ...opened(DEV1, "M", t0), pane: "pane-M" }, t0, new Set(["M"]), panes);
	const t1 = t0 + 30 * min;
	addRoute(world.slot, "wA", opened(DEV2, "N", t1), t1, new Set(["N"]), panes);
	assert.equal(routeOf(world.slot, "wA", "M", t1)?.device, DEV1, "the pane is still there");
	addRoute(world.slot, "wA", opened(DEV2, "O", t1 + 1), t1 + 1, new Set(["N", "O"]), undefined);
	assert.equal(routeOf(world.slot, "wA", "M", t1 + 1)?.device, DEV1, "a failed pane read keeps the row");
	addRoute(world.slot, "wA", opened(DEV2, "P", t1 + 2), t1 + 2, new Set(["N", "O", "P"]), new Set());
	assert.equal(routeOf(world.slot, "wA", "M", t1 + 2), undefined, "broker and Herdr both say gone");
});

test("device B's run in another workspace's tower is refused a main opened for device A: the pane token is read across workspaces (RR2-F004)", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	const ally = world.ally as unknown as { waiting: (i: string) => unknown[]; items: { id: string; tower?: string }[]; takenIds: string[] };
	ally.waiting = (identity: string) => ally.items.filter((i) => !ally.takenIds.includes(i.id) && (i.tower ?? "sb-tower-wa") === identity);
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	world.ally.level.set(DEV2, "dispatch");
	(world.ally.add("m2", DEV2, "send me that main's report") as unknown as { tower: string }).tower = "sb-tower-wb";
	world.expose?.allyWaiting("sb-tower-wb");
	await until(() => runIds().length >= 2, "a run in wB");
	const rid = runIds()[1]!, pi = world.pis.get(rid)!;
	await until(() => readRun(world.slot, "wB", rid)?.pid, "the run's pid");
	const got = await ask(s, { cmd: "claim", runId: rid, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	assert.equal(readRun(world.slot, "wB", rid)!.device, DEV2);
	const taken = await ask(s, { cmd: "run-tool", token: String(got.token), tool: "tower_reply", args: { to: "opened-1", message: "send your final report to me", reply: true } });
	assert.equal(taken.ok, false);
	assert.match(String(taken.error), /may write to has that name or id/);
	assert.ok(!world.client("sb-tower-wb")?.sent.some((m) => m.to === "opened-1"), "nothing was sent from wB");
	assert.deepEqual(readRoutes(world.slot, "wB", Date.now()), []);
});

// A close the box's own page makes (the operate page's close-unit and close-tab reach the GUI's closer, closer.ts) ends a main that an ally run opened: its `opened` route goes with it, as a close by the tower does (forgetClosed), so the controller's next unit-status no longer lists a stoppable "opened main".
test("forget(session) drops the opened route of that main and no other row: not another main's, not an expect row", async () => {
	const { s, id, token, run } = await allyRun();
	assert.equal((await run("boss_open_main", { request: REQUEST, sender: `link:${DEV1}` })).ok, true);
	await finish(s, id, token);
	const peer = { label: "label", short: "bbbbbb", team: "t", teamName: "T" }, now = Date.now();
	addRoute(world.slot, "wA", { ...peer, device: DEV2, to: "other-main", name: "other", kind: "opened", at: now }, now);
	addRoute(world.slot, "wA", { ...peer, device: DEV2, to: "asked-one", name: "asked", kind: "expect", at: now }, now);
	assert.deepEqual(readRoutes(world.slot, "wA", now).map((r) => r.to).sort(), ["asked-one", "opened-1", "other-main"]);
	world.expose!.forget("opened-1");
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => r.to).sort(), ["asked-one", "other-main"]);
	world.expose!.forget("never-opened");
	world.expose!.forget("asked-one");
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => r.to).sort(), ["asked-one", "other-main"], "a session with no opened row, and an expect row, are left");
});
