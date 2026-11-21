import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { stamp } from "../src/header.ts";
import type { WaitWire } from "../src/link/kinds.ts";
import type { InboxItem } from "../src/link/store.ts";
import { addRoute } from "../src/server/allyroute.ts";
import { createAsks } from "../src/server/asks.ts";
import { createLinkWaits, readWaits, type WaitsDeps } from "../src/server/linkwaits.ts";
import { startLinkWaits } from "../src/server/linkwaitsops.ts";
import { slotOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { writeService } from "../src/server/towerstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// D13 (docs/specs/2026-11-21-box-mac-waits.md, 0.81.3): a tower or a main of one device asks a teammate device's standing main a question, or tells it something. The code sends it as the workspace's tower identity with the wait field and
// its kind; the receiving router tells the standing main in a code-written line (D1), the text waits in board_read, and the standing main's linkWait answer comes back to the main that asked. A notice gets nothing back and no card.

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const worlds: TowerWorld[] = [], dirs: string[] = [];
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const MAC = "ibzkd5ijmtravej475kmrykvye", BOX = "n2knna6dkfud5sura2vst4gsee", ENVELOPE = "e".repeat(32);
const ask = (w: TowerWorld, r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, w.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const QUESTION = "Is approval-api !13 safe to merge before the box train 1121?";

/** The box: a claimed local run of workspace wA that took main-1's blocked call_tower, and a holder that answers a send as a Mac build that lists tower.standing would. */
async function boxRun() {
	const world = new TowerWorld();
	worlds.push(world);
	world.setFlag(true);
	const s = await world.start();
	await s.handle.ready;
	await ask(world, s, { cmd: "ensure-tower", workspace: "wA" });
	world.herdr.addPane("wA:p20", "wA:t1").tokens = { sb_role: "main" };
	world.sessions = [{ id: "main-1", name: "work-on", herdrLocation: { paneId: "wA:p20", workspace: { id: "wA", label: "Alpha" } } } as never];
	const call = stamp({ from: { id: "main-1", name: "work-on", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [{ id: "sb-tower-wa", name: "tower", role: "tower", workspace: "Alpha" }], reply: true, why: "blocked" }, "ask the Mac's standing main whether !13 can merge");
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "work-on" }, { id: "m0", content: { text: call } } as never);
	await until(() => world.pis.size === 1, "the run");
	const [id, pi] = [...world.pis.entries()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	let got: Reply | undefined;
	await until(async () => ((got = await ask(world, s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	const token = String(got!.token);
	for (;;) {
		const event = (await ask(world, s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		await ask(world, s, { cmd: "run-taken", token, id: event.id });
	}
	world.linkAnswers.set("device-resolve", (b) => (b.device === "mac" ? { ok: true, id: MAC, short: "ibzkd5", label: "mac", team: "t1" } : { ok: false, error: `no device ${String(b.device)}` }));
	world.linkAnswers.set("send", (b) => ({ ok: true, text: "Sent.", details: { team: "t1", device: MAC, id: ENVELOPE, asked: b.awaitsReply !== undefined, waited: b.wait !== undefined } }));
	return { world, send: (args: Record<string, unknown>) => ask(world, s, { cmd: "run-tool", token, tool: "tower_send", args: { device: "mac", ...args } }) };
}

/** The Mac: a wait router with one coordinator and the standing main work-on in workspace w15X. */
function macRouter() {
	const root = mkdtempSync(join(tmpdir(), "psb-link-standing-"));
	dirs.push(root);
	const slot = slotOf(join(root, "state"), { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
	const mains = [{ id: "s-gma", name: "GMA" }, { id: "s-work", name: "work-on", standing: true }];
	const posts: { to: string[]; text: string; kind: string }[] = [], sends: Parameters<WaitsDeps["send"]>[1][] = [];
	const router = createLinkWaits({
		slot, now: Date.now, log: () => {}, locale: () => "en",
		net: async () => ({ sessions: mains.map((m, i) => ({ id: m.id, name: m.name, herdrLocation: { paneId: `p${i}` } })) as never, ps: mains.map((m, i) => ({ pane_id: `p${i}`, workspace_id: "w15X", tokens: { sb_role: "main", ...(m.standing ? { sb_duty: "standing" } : {}) } })) as never }),
		post: async (_ws, to, text, kind) => (posts.push({ to, text, kind }), true), send: async (_ws, req) => (sends.push(req), { ok: true }),
		caps: () => ["tower.wait", "tower-reply", "tower.awaitsReply", "tower.standing"], deviceId: () => MAC, selfLabel: () => "mac", workspaces: () => ["w15X"],
	});
	return { router, posts, sends };
}
/** What the Mac's holder hands its router for the box's send. */
const arrived = (body: Record<string, unknown>): InboxItem => ({ v: 1, id: "1".repeat(32), team: "t1", from: BOX, fromLabel: "waydosoft", fromShort: "n2knna", seq: 1, sentAt: 1, received: 1, fromWorkspace: "box", toWorkspace: "", replyExpected: body.reply === true, text: String(body.text), ...(body.awaitsReply ? { awaitsReply: String(body.awaitsReply) } : {}), wait: body.wait as WaitWire });

test("D13: a tower run's question for the Mac's standing main: the wait goes with kind question and the asking main's ask; the standing main is woken with no peer text, reads it in board_read, and its answer reaches the box main", async () => {
	const { world, send } = await boxRun();
	const done = await send({ standing: "question", message: QUESTION });
	assert.equal(done.ok, true, JSON.stringify(done));
	assert.match(String(done.text), /^Your question L1 went to the standing main of mac \(ibzkd5\)\. Its answer comes to work-on directly, and each step is told to it\./);
	const body = world.linkCalls.filter((c) => c.body.op === "send").at(-1)!.body, wire = body.wait as WaitWire;
	assert.deepEqual([body.device, body.text, body.reply, wire.kind, wire.owner, wire.what, wire.state], [MAC, QUESTION, true, "question", "", QUESTION, "open"]);
	assert.match(String(body.awaitsReply), /^[0-9a-f]{32}$/);
	assert.deepEqual(createAsks(world.slot).openOf("wA").map((a) => [a.ask, a.for, a.device]), [[body.awaitsReply, "main-1", MAC]], "the asking main's ask, by the code");
	assert.deepEqual(readWaits(world.slot, "wA").entries.map((e) => [e.dir, e.kind, e.state, e.wait, e.raiser?.id]), [["out", "question", "open", wire.id, "main-1"]]);
	// The Mac's side.
	const mac = macRouter();
	assert.equal(await mac.router.take(arrived(body), "w15X"), true);
	assert.deepEqual(mac.posts.map((p) => [p.to, p.kind]), [[["s-work"], "link_wait"]], "the standing main alone");
	assert.match(mac.posts[0]!.text, /asks you, a standing main of this workspace, a question \(L1\)/);
	assert.doesNotMatch(mac.posts[0]!.text, /approval-api|!13|train/, "no word of the box's (D1)");
	assert.deepEqual(mac.router.view({ workspaces: ["w15X"] }).map((r) => [r.id, r.kind, r.text]), [["L1", "question", QUESTION]]);
	await mac.router.act("s-work", "L1", "done", "Yes: merge it, the Mac train is clear.");
	const [answer, state] = mac.sends.slice(-2);
	assert.deepEqual([answer!.inReplyTo, answer!.text], [body.awaitsReply, "Yes: merge it, the Mac train is clear."]);
	// Back on the box: the reply goes to the main that asked (the holder's asks.take), the ask closes the out wait, and the done state is told to the main in a code-written line.
	assert.equal(createAsks(world.slot).take({ team: "t1", device: MAC, ask: String(body.awaitsReply) })?.main, "main-1");
	const box = createLinkWaits({ slot: world.slot, now: Date.now, log: () => {}, locale: () => "en", net: async () => ({ sessions: [], ps: [] }), post: (ws, to, text, kind, extra) => world.expose!.post(ws, to, text, kind, extra), send: async () => ({ ok: true }), caps: () => ["tower.wait", "tower-reply"], deviceId: () => BOX, selfLabel: () => "box", workspaces: () => ["wA"] });
	assert.equal(await box.take({ ...arrived({ text: state!.text }), from: MAC, fromLabel: "mac", fromShort: "ibzkd5", id: "2".repeat(32), wait: state!.wait! }, "wA"), true);
	await until(() => world.client("sb-tower-wa")!.sent.some((m) => m.to === "main-1" && /your question L1 .* is done\. It is closed\./.test(m.text)), "the done state at the box main");
	assert.deepEqual(readWaits(world.slot, "wA").entries.map((e) => [e.dir, e.state]), [["out", "done"]]);
});

test("D13: a notice goes with no ask and is recorded nowhere; a question needs a main to answer to; an ally run sends notices only", async () => {
	const { world, send } = await boxRun();
	const told = await send({ standing: "notice", message: "The box train 1121 landed." });
	assert.equal(told.ok, true, JSON.stringify(told));
	assert.match(String(told.text), /^Your notice went to the standing main of mac \(ibzkd5\)\. Nothing comes back for it\./);
	const body = world.linkCalls.filter((c) => c.body.op === "send").at(-1)!.body;
	assert.deepEqual([body.reply, body.awaitsReply, (body.wait as WaitWire).kind], [false, undefined, "notice"]);
	assert.deepEqual([readWaits(world.slot, "wA").entries, createAsks(world.slot).openOf("wA")], [[], []]);
	assert.match(String((await send({ standing: "notice", reply: true, message: "x" })).error), /A question expects a reply and a notice none/);
	assert.match(String((await send({ standing: "question", for: "nobody", message: "x" })).error), /./, "a for that names no main is refused");
	// The Mac's router: a notice is told as information and nothing goes back.
	const mac = macRouter();
	await mac.router.take(arrived(body), "w15X");
	assert.match(mac.posts[0]!.text, /information only, with nothing to answer and no card for the boss/);
	assert.deepEqual(mac.sends, []);
});

test("D13: a main's call_tower standing (standing-send): the code sends it as the workspace's tower identity with the main's ask and records the question; a notice carries none; an opened main reaches only its opener, and a member is refused", async () => {
	const root = mkdtempSync(join(tmpdir(), "psb-link-standing-op-"));
	dirs.push(root);
	const slot = slotOf(join(root, "state"), { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
	const requests: { body: Record<string, unknown>; from: string }[] = [], asks = createAsks(slot);
	const devices: Record<string, { ok: true; id: string; short: string; label: string; team: string }> = { mac: { ok: true, id: MAC, short: "ibzkd5", label: "mac", team: "t1" }, other: { ok: true, id: "b".repeat(26), short: "bbbbbb", label: "other", team: "t1" } };
	const link = { holder: { resolveTeammate: (d: string) => devices[d] ?? { ok: false, error: `no device ${d}` } }, request: async (body: Record<string, unknown>, from: string) => (requests.push({ body, from }), { ok: true, text: "Sent.", details: { team: "t1", device: MAC, id: ENVELOPE, asked: body.awaitsReply !== undefined, waited: true } }) };
	const panes = [{ pane_id: "p1", workspace_id: "wA", tokens: { sb_role: "main" } }, { pane_id: "p2", workspace_id: "wA", tokens: { sb_role: "member" } }];
	const hub = startLinkWaits({ slot, env: {}, now: Date.now, log: () => {}, run: (async () => JSON.stringify({ result: { panes } })) as never, sessions: async () => [{ id: "main-1", name: "work-on", herdrLocation: { paneId: "p1" } }, { id: "member-1", name: "helper", herdrLocation: { paneId: "p2" } }] as never, towers: () => ({ identityOf: (ws: string) => (ws === "wA" ? "sb-tower-wa" : undefined) }) as never, link: () => link as never, stops: [], asks, tickMs: false });
	const asked = await hub.op({ op: "standing-send", device: "mac", kind: "question", what: "", message: QUESTION }, "main-1");
	assert.equal(asked.ok, true, JSON.stringify(asked));
	const [q] = requests, wire = q!.body.wait as WaitWire;
	assert.deepEqual([q!.from, q!.body.op, q!.body.device, q!.body.reply, wire.kind, wire.owner], ["sb-tower-wa", "send", MAC, true, "question", ""]);
	assert.deepEqual(asks.openOf("wA").map((a) => [a.ask, a.for, a.tower]), [[q!.body.awaitsReply, "main-1", "sb-tower-wa"]]);
	assert.deepEqual(readWaits(slot, "wA").entries.map((e) => [e.dir, e.kind, e.raiser?.id, e.ask]), [["out", "question", "main-1", q!.body.awaitsReply]]);
	assert.equal((await hub.op({ op: "standing-send", device: "mac", kind: "notice", what: "", message: "landed" }, "main-1")).ok, true);
	assert.deepEqual([requests[1]!.body.reply, requests[1]!.body.awaitsReply, (requests[1]!.body.wait as WaitWire).kind], [false, undefined, "notice"]);
	assert.equal(readWaits(slot, "wA").entries.length, 1, "a notice is recorded nowhere");
	assert.match(String((await hub.op({ op: "standing-send", device: "mac", kind: "question", message: "x" }, "member-1")).error), /Only a main of this computer/);
	writeService(slot, { workspace: "wA", label: "Alpha", id: "sb-tower-wa", name: "tower", pane: "wA:p0", tab: "wA:t0", created: new Date().toISOString(), seq: 1 });
	addRoute(slot, "wA", { device: MAC, label: "mac", short: "ibzkd5", team: "t1", teamName: "MP", to: "main-1", name: "work-on", kind: "opened", at: Date.now() }, Date.now());
	assert.match(String((await hub.op({ op: "standing-send", device: "other", kind: "notice", message: "x" }, "main-1")).error), /^An ally run of mac \(ibzkd5\) opened you, so a wait from you goes to that device only, not to other \(bbbbbb\)/);
	assert.equal(requests.length, 2, "nothing was sent to the other device");
	assert.equal((await hub.op({ op: "standing-send", device: "mac", kind: "notice", message: "x" }, "main-1")).ok, true, "its opener it reaches");
});
