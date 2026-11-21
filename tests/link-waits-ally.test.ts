import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { stamp } from "../src/header.ts";
import { addRoute, readAnswers } from "../src/server/allyroute.ts";
import { raiserRefusal } from "../src/server/allywait.ts";
import { createAsks } from "../src/server/asks.ts";
import { createLinkWaits, readWaits } from "../src/server/linkwaits.ts";
import { startLinkWaits } from "../src/server/linkwaitsops.ts";
import { callControl } from "../src/server/socket.ts";
import { readMemory } from "../src/server/towermemory.ts";
import { addExpect, readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// `ally_escalate` (docs/specs/2026-11-21-box-mac-waits.md §3, §9 anchor 6): an ally run at `reply` hands an item of its sender's message to the wait router with no gate and no Allow, the first line `[waits on you: …]` gives `what`, a
// run may escalate at most 5 items and each once, the run still ends with `tower_done`, and its brief lists the mains here.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV = "a".repeat(26), ASK = "c".repeat(32);

test("ally_escalate runs at reply with no gate, opens L1 from the message's first line with its one ask, refuses a repeat and a sixth item, and the run still ends with tower_done", async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.add("m1", DEV, "[waits on you: merge approval-api !13]\nThe box main work-on hands off !13 to the Mac.", { awaitsReply: ASK, replyExpected: true });
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	assert.equal(got.level, "reply");
	const brief = String(got.brief);
	assert.match(brief, /Mains here \(your sender may see them too; name one as the owner of an ally_escalate\):/);
	assert.match(brief, /- ally_escalate \{what, owner\?, kind\?\}/);
	const token = String(got.token);
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
	const escalate = (args: Record<string, unknown>) => ask(s, { cmd: "run-tool", token, tool: "ally_escalate", args });
	// No toolCallId: a gated tool would be refused for want of one, so this passes only because the server holds it free.
	const first = await escalate({ owner: "work-on" });
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.match(String(first.text), /^Escalated as L1/);
	const [w] = readWaits(world.slot, "wA").entries;
	assert.deepEqual([w!.dir, w!.kind, w!.device, w!.owner, w!.what, w!.ask], ["in", "wait", DEV, "work-on", "merge approval-api !13", ASK]);
	assert.match(w!.text, /hands off !13/);
	const again = await escalate({ what: "merge approval-api !13" });
	assert.equal(again.ok, false);
	assert.match(String(again.error), /escalated already/);
	for (const n of [2, 3, 4, 5]) assert.equal((await escalate({ what: `item ${n}`, kind: "incident" })).ok, true, `item ${n}`);
	const sixth = await escalate({ what: "item 6" });
	assert.equal(sixth.ok, false);
	assert.match(String(sixth.error), /escalated 5 items already/);
	assert.equal(readWaits(world.slot, "wA").entries.length, 5);
	const done = await ask(s, { cmd: "run-done", token, note: "escalated the box's handoff of !13" });
	assert.equal(done.ok, true, JSON.stringify(done));
});

test("D12 (0.81.3): an ally run's escalation of a message that expects no answer and does not say it waits here is a notice whatever kind the run names: no wait, no card, nothing back", async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	// The live check's shape: a plain tower with no ask that reports work done (the L6 done answer that came back as two incident cards).
	world.ally.add("m1", DEV, "Live check: the Mac received L6 and is marking it done. No other action.");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const token = String((await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })).token);
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		await ask(s, { cmd: "run-taken", token, id: event.id });
	}
	const up = await ask(s, { cmd: "run-tool", token, tool: "ally_escalate", args: { kind: "incident", what: "live check L6 marked done" } });
	assert.equal(up.ok, true, JSON.stringify(up));
	assert.match(String(up.text), /^Noted as L1, a notice: the message expects no answer/);
	assert.deepEqual(readWaits(world.slot, "wA").entries.map((w) => [w.kind, w.state, w.card]), [["notice", "open", undefined]], "no main here and still no card");
	assert.deepEqual(readMemory(world.slot, "wA", Date.now()).memory.entries.filter((e) => e.kind === "wait"), [], "nothing on the boss's list");
	assert.equal((await ask(s, { cmd: "run-done", token, note: "noted the Mac's notice" })).ok, true);
});

test("BMWR-F006: on an unattended box an ask the run escalated is the router's to answer: the run's end sends no receipt for it", async () => {
	world.unattended = () => true;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.linkAnswers.set("send", () => ({ ok: true, text: "Sent." }));
	world.ally.add("m1", DEV, "[waits on you: merge approval-api !13]\nThe box main work-on hands off !13 to the Mac.", { awaitsReply: ASK, replyExpected: true });
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const token = String((await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })).token);
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		await ask(s, { cmd: "run-taken", token, id: event.id });
	}
	const up = await ask(s, { cmd: "run-tool", token, tool: "ally_escalate", args: {} });
	assert.equal(up.ok, true, JSON.stringify(up));
	assert.equal((await ask(s, { cmd: "run-done", token, note: "escalated !13" })).ok, true);
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome, "the run's end");
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(world.linkCalls.filter((c) => c.body.op === "send" && c.body.inReplyTo === ASK), [], "no receipt burns the ask");
});

// Live-check fix A (0.81.3, docs/specs/2026-11-21-box-mac-waits.md §14): a main an ally run opened for device D (an `opened` route) that calls `call_tower` blocked with `waitsOn` D gets what a local main gets. The code forwards it as a wait
// with the raiser's ask, records the out wait, and the device's states and reply reach the raiser; nothing enters a run, ally or local, so the isolation rule of allyroute.ts holds. A wait on any other device is refused.
const OPENER = "a".repeat(26), OTHER = "b".repeat(26), ENVELOPE = "e".repeat(32), TEAM = "t".repeat(32);
const raised = (short: string, what = "sb 0.81.3 live check: mark this wait done") =>
	stamp({ from: { id: "opened-1", name: "main", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [], reply: true, why: "blocked", waitsOn: { short, owner: "work-on", what } }, "live check: please mark it done");
async function openedMain() {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const now = Date.now();
	addRoute(world.slot, "wA", { device: OPENER, label: "mac", short: "aaaaaa", team: TEAM, teamName: "MP", to: "opened-1", name: "main", kind: "opened", at: now }, now);
	world.herdr.addTab("wA:t5", "main", "wA:p5", "pi");
	world.herdr.pane("wA:p5").tokens.sb_role = "main";
	world.sessions.push({ id: "opened-1", name: "main", herdrLocation: { status: "current", paneId: "wA:p5" } as never });
	world.linkAnswers.set("send", () => ({ ok: true, text: "Sent to the tower of mac (aaaaaa) through the relay.", details: { team: TEAM, device: OPENER, id: ENVELOPE, asked: true, waited: true } }));
	return s;
}
const tower = () => world.client("sb-tower-wa")!;
const toRaiser = () => tower().sent.filter((m) => m.to === "opened-1");
const ranAny = () => [...world.pis.keys()].length;

test("live-check A: an opened main's waitsOn its opener goes out as a wait with the raiser's ask, and the device's told and reply reach the raiser; no run starts and no incident wait opens", async () => {
	await openedMain();
	tower().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: raised("aaaaaa") } } as never);
	await until(() => world.linkCalls.some((c) => c.body.op === "send"), "the forward to the opener");
	const send = world.linkCalls.find((c) => c.body.op === "send")!;
	const wire = send.body.wait as { id: string; state: string; owner: string; what: string; handle: string };
	assert.equal(send.from, "sb-tower-wa", "sent as the workspace's tower identity");
	assert.deepEqual([send.body.device, send.body.text, send.body.reply, wire.state, wire.owner, wire.what], [OPENER, "live check: please mark it done", true, "open", "work-on", "sb 0.81.3 live check: mark this wait done"]);
	assert.match(String(send.body.awaitsReply), /^[0-9a-f]{32}$/);
	assert.match(wire.id, /^[0-9a-f]{32}$/);
	const ledger = readWaits(world.slot, "wA").entries;
	assert.deepEqual(ledger.map((w) => [w.dir, w.state, w.device, w.wait, w.ask, w.raiser?.id, w.event]), [["out", "open", OPENER, wire.id, send.body.awaitsReply, "opened-1", "r1"]]);
	const asks = createAsks(world.slot).openOf("wA");
	assert.deepEqual(asks.map((a) => [a.ask, a.for, a.device, a.envelope]), [[send.body.awaitsReply, "opened-1", OPENER, ENVELOPE]]);
	await until(() => toRaiser().length >= 1, "the raiser told");
	assert.match(toRaiser()[0]!.text, /kind=link_wait_state .*wait=L1/);
	assert.match(toRaiser()[0]!.text, /Your wait L1 .* went to mac \(aaaaaa\)/);
	assert.deepEqual(readAnswers(world.slot, "wA", Date.now()), [], "nothing waits for an ally run");
	// The opener's states and its reply come back the way the holder hands them over (main.ts: `waits.take`, then `asks.take` and `answered`); the same ledger and the same tower identity.
	const router = createLinkWaits({ slot: world.slot, now: Date.now, log: () => {}, locale: () => "en", net: async () => ({ sessions: [], ps: [] }), post: (ws, to, text, kind, extra) => world.expose!.post(ws, to, text, kind, extra), send: async () => ({ ok: true }), caps: () => ["tower.wait", "tower-reply"], deviceId: () => "n2knna6dkfud5sura2vst4gsee", selfLabel: () => "box", workspaces: () => ["wA"] });
	const from = { v: 1, team: TEAM, from: OPENER, fromLabel: "mac", fromShort: "aaaaaa", seq: 1, sentAt: 1, received: 1, fromWorkspace: "MP", toWorkspace: "", replyExpected: false, text: "told work-on (main on mac)" } as const;
	assert.equal(await router.take({ ...from, id: "1".repeat(32), wait: { id: wire.id, state: "told", owner: "work-on", what: wire.what, handle: "" } } as never, "wA"), true);
	await until(() => toRaiser().length >= 2, "the told state at the raiser");
	assert.match(toRaiser()[1]!.text, /kind=link_wait_state .*your wait L1 \(.*\) is told to a main there\./);
	const taken = createAsks(world.slot).take({ team: TEAM, device: OPENER, ask: String(send.body.awaitsReply) });
	assert.equal(taken?.main, "opened-1", "the device's tower-reply goes to the raiser");
	router.answered(String(send.body.awaitsReply));
	assert.deepEqual(readWaits(world.slot, "wA").entries.map((w) => [w.dir, w.state]), [["out", "done"]], "the out wait closed, and no incident wait opened");
	assert.equal(ranAny(), 0, "no ally run and no local run started");
});

test("live-check A: an opened main's waitsOn another device is refused with a message to it; nothing is sent, recorded, or relayed to an ally run", async () => {
	await openedMain();
	tower().incoming({ id: "opened-1", name: "main" }, { id: "r2", content: { text: raised("bbbbbb") } } as never);
	await until(() => toRaiser().length >= 1, "the refusal");
	assert.match(toRaiser()[0]!.text, /not forwarded: an ally run of mac \(aaaaaa\) opened you, so a wait from you goes to that device only, not to bbbbbb/);
	assert.deepEqual(world.linkCalls.filter((c) => c.body.op === "send"), []);
	assert.deepEqual(readWaits(world.slot, "wA").entries, []);
	assert.deepEqual(readAnswers(world.slot, "wA", Date.now()), []);
	assert.equal(ranAny(), 0);
});

test("live-check A: the call itself is refused for an opened main whose waitsOn names a device other than its opener (device-resolve with raise)", async () => {
	await openedMain();
	const now = Date.now();
	assert.equal(raiserRefusal(world.slot, "main-9", { id: OTHER, short: "bbbbbb", label: "other" }, now), undefined, "a main nobody opened is not refused here");
	assert.equal(raiserRefusal(world.slot, "opened-1", { id: OPENER, short: "aaaaaa", label: "mac" }, now), undefined);
	assert.match(String(raiserRefusal(world.slot, "opened-1", { id: OTHER, short: "bbbbbb", label: "other" }, now)), /^An ally run of mac \(aaaaaa\) opened you, so a wait from you goes to that device only, not to other \(bbbbbb\)/);
	// The op a main's call_tower asks (waitcall.ts): with `raise` it refuses the other device before anything is sent; without it (a cancel, a run's resolve) it only resolves.
	const devices: Record<string, { ok: true; id: string; short: string; label: string; team: string }> = { mac: { ok: true, id: OPENER, short: "aaaaaa", label: "mac", team: TEAM }, other: { ok: true, id: OTHER, short: "bbbbbb", label: "other", team: TEAM } };
	const hub = startLinkWaits({ slot: world.slot, env: {}, now: Date.now, log: () => {}, run: (async () => "[]") as never, sessions: async () => [], towers: () => undefined, link: () => ({ holder: { resolveTeammate: (d: string) => devices[d] } }) as never, stops: [], tickMs: false });
	assert.match(String((await hub.op({ op: "device-resolve", device: "other", raise: true }, "opened-1")).error), /^An ally run of mac \(aaaaaa\) opened you/);
	assert.equal((await hub.op({ op: "device-resolve", device: "mac", raise: true }, "opened-1")).id, OPENER);
	assert.equal((await hub.op({ op: "device-resolve", device: "other" }, "opened-1")).id, OTHER);
});

test("WR3-F003: a newer local ask of an opened main does not bring its waitsOn call into a local run: the code still forwards it to the opener", async () => {
	await openedMain();
	const now = Date.now();
	addExpect(world.slot, "wA", { to: "opened-1", name: "main", at: now + 1000, first: "a local run asked it" }, now);
	tower().incoming({ id: "opened-1", name: "main" }, { id: "r3", content: { text: raised("aaaaaa") } } as never);
	await until(() => world.linkCalls.some((c) => c.body.op === "send"), "the forward to the opener");
	assert.equal(world.linkCalls.find((c) => c.body.op === "send")!.body.device, OPENER);
	assert.deepEqual(readWaits(world.slot, "wA").entries.map((w) => [w.dir, w.raiser?.id, w.event]), [["out", "opened-1", "r3"]]);
	assert.equal(ranAny(), 0, "no local run took it");
});
