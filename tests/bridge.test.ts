import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Ack, type Dialogs, guiNamespace, type LocalHub, REGISTER, startBridge, type ToHub } from "../src/bridge.ts";
import { selectDigest } from "../src/owners.ts";

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const SELECT = { title: "Robot Hand — Run it?\n\n  ! ls", choices: [{ label: "Run it" }, { label: "No, thanks" }] };
const DIGEST = selectDigest(SELECT);
type Reg = { namespace: string; ownerEligible: boolean; onEvent(e: Record<string, unknown>): void };

/** One session in Herdr with the bridge, a synchronous event bus, pi-intercom's register event, and a robot_hand-like owner the test drives. */
function session({ me = "S", gui = "G" as string | undefined, env = {} as Record<string, string>, intercom = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "psb-bridge-test-"));
	dirs.push(dir);
	const handlers = new Map<string, ((e: unknown, ctx: unknown) => void)[]>(), bus = new Map<string, ((d: unknown) => void)[]>();
	const regs: Reg[] = [], published: { ns: string; payload: ToHub; audience?: string }[] = [], owners = new Map<string, { sessionId: string; epoch: string }>(), notices: string[] = [];
	const events = {
		on: (ch: string, h: (d: unknown) => void) => (bus.set(ch, [...(bus.get(ch) ?? []), h]), () => bus.set(ch, (bus.get(ch) ?? []).filter((x) => x !== h))),
		emit: (ch: string, d: unknown) => [...(bus.get(ch) ?? [])].forEach((h) => h(d)),
	};
	let connected = true;
	if (intercom) events.on(REGISTER, (raw) => {
		const r = raw as Reg & { onReady(c: unknown): void };
		regs.push(r);
		r.onReady({ snapshot: () => ({ connected, owner: owners.get(r.namespace) }), publish: (payload: ToHub, o?: { audience?: string }) => void published.push({ ns: r.namespace, payload, audience: o?.audience }) });
	});
	const pi = { events, on: (type: string, h: (e: unknown, ctx: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), h]) } as unknown as ExtensionAPI;
	const hub: { current?: LocalHub & { got: [string, ToHub][] } } = {};
	const bridge = startBridge(pi, { env: { HERDR_PANE_ID: "wA:p1", PI_INTERCOM_SESSION_ID: me, ...env }, dir, local: () => hub.current });
	const ctx = { hasUI: true, ui: { notify: (t: string) => notices.push(t) }, sessionManager: { getSessionFile: () => "/s/2026_S.jsonl" }, signal: undefined as AbortSignal | undefined };
	const fire = (type: string, e: Record<string, unknown> = {}) => (handlers.get(type) ?? []).forEach((h) => h({ type, ...e }, ctx));
	const record = (ownerSession?: string) => writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid: 1, port: 1, token: "t", owner: "x", ...(ownerSession ? { ownerSession } : {}) }));
	if (gui) record(gui);
	fire("session_start");
	const count = () => [...bus.values()].reduce((n, hs) => n + hs.length, 0);
	const s = {
		dir, regs, published, owners, notices, ctx, hub, bridge, fire, record, count, events,
		set connected(v: boolean) { connected = v; },
		/** G becomes the owner of its channel, with an epoch, as the broker announces it. */
		own(g = "G", epoch = "e1") {
			owners.set(guiNamespace(g), { sessionId: g, epoch });
			regs.find((r) => r.namespace === guiNamespace(g))?.onEvent({ type: "owner", owner: { sessionId: g, epoch } });
		},
		/** A message on G's channel as the broker delivers it. */
		message(payload: unknown, { g = "G", from, epoch = "e1" }: { g?: string; from?: string; epoch?: string } = {}) {
			regs.find((r) => r.namespace === guiNamespace(g))!.onEvent({ type: "message", fromSessionId: from ?? g, owner: { sessionId: g, epoch }, payload });
		},
		lists: () => published.filter((p) => p.payload.type === "dialogs").map((p) => (p.payload as Dialogs).dialogs),
		acks: () => published.filter((p) => p.payload.type === "ack").map((p) => p.payload as Ack),
		/** robot_hand opens its selector inside tool call `call`. */
		open(id = "d1", call = "c1", extra: Record<string, unknown> = {}) {
			fire("tool_execution_start", { toolCallId: call, toolName: "robot_hand", args: {} });
			events.emit("robot-hand:pending", { version: 1, id, toolCallId: call, digest: DIGEST, select: SELECT, ...extra });
		},
		/** The owner's side: how it answers the next answer events. */
		owner(verdict: (a: { id: string; answerId: string }) => Record<string, unknown> | undefined) {
			return events.on("robot-hand:answer", (raw) => {
				const a = raw as { id: string; answerId: string }, v = verdict(a);
				if (v) events.emit("robot-hand:answer-result", { version: 1, id: a.id, answerId: a.answerId, ...v });
				if (v?.accepted) events.emit("robot-hand:closed", { version: 1, id: a.id, by: "remote", answerId: a.answerId });
			});
		},
	};
	return s;
}
const answer = (answerId = "a".repeat(16), extra: Record<string, unknown> = {}) => ({ version: 1, type: "answer", to: "", id: "d1", answerId, digest: DIGEST, choice: 0, ...extra });
const bridgeIdOf = (s: ReturnType<typeof session>) => (s.published.find((p) => p.payload.type === "dialogs")!.payload as Dialogs).bridgeId;

test("no channel until a dialog opens and gui.json names another session; then the list goes to G only while G owns the channel", async () => {
	const s = session();
	assert.equal(s.regs.length, 0, "nothing registered at start");
	s.open();
	assert.deepEqual(s.regs.map((r) => [r.namespace, r.ownerEligible]), [[guiNamespace("G"), false]]);
	assert.match(guiNamespace("G"), /^straw-boss\/gui\/[0-9a-f]{32}$/);
	assert.equal(s.published.length, 0, "no owner yet: nothing sent");
	s.own();
	assert.deepEqual(s.published.map((p) => [p.ns, p.audience]), [[guiNamespace("G"), "owner"]]);
	const list = s.published[0]!.payload as Dialogs;
	assert.deepEqual({ ...list, bridgeId: "" }, { version: 1, type: "dialogs", bridgeId: "", pane: "wA:p1", file: "/s/2026_S.jsonl", dialogs: [{ owner: "robot-hand", id: "d1", toolCallId: "c1", digest: DIGEST, select: SELECT }], closed: [] });
	s.regs[0]!.onEvent({ type: "connection", connected: true });
	assert.equal(s.lists().length, 2, "resent when the connection comes back");
	s.events.emit("robot-hand:closed", { version: 1, id: "d1", by: "local" });
	assert.deepEqual(s.lists().at(-1), [], "a close sends the empty list");
	assert.deepEqual((s.published.at(-1)!.payload as Dialogs).closed, [{ id: "d1", by: "local" }], "with who closed it");
});

test("pendings are taken only for a call of the owner's own tool in flight, in contract v1", () => {
	const s = session();
	s.own();
	s.events.emit("robot-hand:pending", { version: 1, id: "x1", toolCallId: "never-started", digest: DIGEST, select: SELECT });
	s.fire("tool_execution_start", { toolCallId: "c9", toolName: "bash", args: {} });
	s.events.emit("robot-hand:pending", { version: 1, id: "x2", toolCallId: "c9", digest: DIGEST, select: SELECT });
	s.open("x3", "c1", { version: 2 });
	assert.equal(s.regs.length, 0, "nothing taken, so nothing relayed");
	s.open("d1", "c2");
	s.own();
	assert.deepEqual(s.lists().at(-1)!.map((d) => d.id), ["d1"]);
	s.fire("tool_execution_end", { toolCallId: "c2", toolName: "robot_hand" });
	assert.deepEqual(s.lists().at(-1), [], "the end of its call closes a dialog its owner never closed");
});

test("an answer counts only from G as the channel's current owner, at the owner's epoch, for this bridge", () => {
	const s = session(), seen: string[] = [];
	s.open();
	s.own();
	s.owner((a) => (seen.push(a.answerId), { accepted: true }));
	const to = bridgeIdOf(s);
	s.message(answer("w".repeat(16), { to }), { from: "X" });
	s.message(answer("w".repeat(17), { to }), { epoch: "e0" });
	s.message(answer("w".repeat(18), { to: "another-bridge" }));
	s.message({ ...answer("w".repeat(19), { to }), version: 2 });
	assert.deepEqual([seen, s.acks()], [[], []]);
	s.message(answer("a".repeat(16), { to }));
	assert.deepEqual(seen, ["a".repeat(16)]);
	assert.deepEqual(s.acks().map((a) => [a.outcome, a.answerId, a.bridgeId === to]), [["accepted", "a".repeat(16), true]]);
	s.message(answer("a".repeat(16), { to }));
	assert.deepEqual(s.acks().at(-1)!.outcome, "accepted", "the same answer again is a replay: accepted, and not applied twice");
	assert.equal(seen.length, 1);
	s.message(answer("b".repeat(16), { to }));
	assert.deepEqual([s.acks().at(-1)!.outcome, s.acks().at(-1)!.by], ["stale", "remote"]);
	s.message(answer("c".repeat(16), { to, id: "gone" }));
	assert.deepEqual([s.acks().at(-1)!.outcome, s.acks().at(-1)!.by], ["stale", "gone"]);
});

test("refused answers reopen the dialog; the terminal first makes an answer stale; an owner that settled already says closed", () => {
	const s = session();
	s.open();
	s.own();
	const to = bridgeIdOf(s);
	let verdict: Record<string, unknown> | undefined = { accepted: false, reason: "digest" };
	s.owner(() => verdict);
	s.message(answer("a".repeat(16), { to }));
	assert.deepEqual([s.acks().at(-1)!.outcome, s.acks().at(-1)!.reason], ["rejected", "digest"]);
	assert.equal(s.lists().at(-1)![0]!.busy, undefined, "open again, answerable");
	verdict = { accepted: false, reason: "closed" };
	s.message(answer("b".repeat(16), { to }));
	assert.deepEqual([s.acks().at(-1)!.outcome, s.acks().at(-1)!.by], ["stale", "local"]);
	const t = session();
	t.open();
	t.own();
	t.events.emit("robot-hand:closed", { version: 1, id: "d1", by: "local" });
	t.message(answer("a".repeat(16), { to: bridgeIdOf(t) }));
	assert.deepEqual([t.acks().at(-1)!.outcome, t.acks().at(-1)!.by], ["stale", "local"], "answered in the terminal first");
});

test("an owner that stays silent leaves the answer unknown after 2 s; meanwhile and after, the same answer waits or replays and another is busy", async () => {
	const s = session();
	s.open();
	s.own();
	const to = bridgeIdOf(s);
	s.owner(() => undefined);
	s.message(answer("a".repeat(16), { to }));
	assert.equal(s.lists().at(-1)![0]!.busy, true, "the list says an answer is on its way");
	s.message(answer("a".repeat(16), { to }));
	s.message(answer("b".repeat(16), { to }));
	assert.deepEqual(s.acks().map((a) => a.outcome), ["busy"], "the same answer waits for the verdict; another is busy");
	await new Promise((resolve) => setTimeout(resolve, 2100));
	assert.deepEqual(s.acks().map((a) => [a.outcome, a.answerId[0]]), [["busy", "b"], ["unknown", "a"], ["unknown", "a"]]);
	s.message(answer("c".repeat(16), { to }));
	assert.equal(s.acks().at(-1)!.outcome, "busy", "until the owner closes it");
	s.events.emit("robot-hand:closed", { version: 1, id: "d1", by: "remote", answerId: "a".repeat(16) });
	s.message(answer("a".repeat(16), { to }));
	assert.equal(s.acks().at(-1)!.outcome, "accepted", "the owner took it after all");
	assert.deepEqual((s.published.filter((p) => p.payload.type === "dialogs").at(-1)!.payload as Dialogs).closed, [{ id: "d1", by: "remote", answerId: "a".repeat(16) }]);
});

test("when G is this session the hub is called in-process; a sync resends; the session's end sends an empty list and drops every listener", () => {
	const s = session({ me: "G" }), got: [string, ToHub][] = [];
	s.hub.current = { receive: (from, msg) => void got.push([from, msg]), got } as LocalHub & { got: [string, ToHub][] };
	s.open();
	assert.equal(s.regs.length + s.published.length, 0, "no channel for its own server");
	assert.deepEqual(got.map(([from, m]) => [from, (m as Dialogs).dialogs.length]), [["G", 1]]);
	s.owner(() => ({ accepted: true }));
	const acks: Ack[] = [];
	s.bridge.deliver({ ...answer(), to: (got[0]![1] as Dialogs).bridgeId } as never, (a) => acks.push(a));
	assert.deepEqual(acks.map((a) => a.outcome), ["accepted"]);
	s.bridge.sync();
	assert.equal(got.length >= 3, true);
	s.fire("session_shutdown");
	assert.deepEqual((got.at(-1)![1] as Dialogs).dialogs, []);
	assert.equal(s.count(), 2, "only intercom's register listener and the test's owner are left: the bridge's own are gone");
});

test("a sync from G resends; a gui.json naming another server is followed; past 8 servers the session stays read-only and says so once", async () => {
	const s = session();
	s.open();
	s.own();
	s.message({ version: 1, type: "sync" });
	assert.equal(s.lists().length, 2);
	for (let i = 1; i <= 9; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		s.record(`G${i}`);
		s.bridge.sync();
	}
	assert.equal(s.regs.length, 8);
	assert.deepEqual(s.notices.length, 1);
	assert.match(s.notices[0]!, /answer its dialogs in the terminal/);
});

test("once gui.json names another server, the one it named before can no longer answer, even while it still owns its channel", async () => {
	const s = session(), seen: string[] = [];
	s.open();
	s.own();
	s.owner((a) => (seen.push(a.answerId), { accepted: true }));
	await new Promise((resolve) => setTimeout(resolve, 5));
	s.record("G2");
	s.bridge.sync();
	s.own("G2");
	const to = bridgeIdOf(s);
	s.message(answer("o".repeat(16), { to }));
	assert.deepEqual([seen, s.acks()], [[], []], "the former server is ignored");
	s.message(answer("n".repeat(16), { to }), { g: "G2" });
	assert.deepEqual(seen, ["n".repeat(16)]);
});

test("rpiv-ask-user-question: a questionnaire relays; the bridge's digest check stands in for the owner's; an abort of its call cancels it", () => {
	const s = session(), abort = new AbortController();
	s.own();
	s.ctx.signal = abort.signal;
	s.fire("tool_execution_start", { toolCallId: "q1", toolName: "ask_user_question", args: {} });
	s.events.emit("rpiv:ask-user:prompt", { toolCallId: "q1", questions: [{ question: "Go?", header: "Go", multiSelect: false, options: [{ label: "Yes", description: "" }, { label: "No", description: "" }] }] });
	s.own();
	const d = s.lists().at(-1)![0]!, sent: unknown[] = [];
	s.events.on("rpiv:ask-user:answer", (p) => sent.push(p));
	s.message({ version: 1, type: "answer", to: bridgeIdOf(s), id: d.id, answerId: "a".repeat(16), digest: "0".repeat(64), answers: [{ choices: [0] }] });
	assert.deepEqual([s.acks().at(-1)!.outcome, s.acks().at(-1)!.reason, sent], ["rejected", "digest", []]);
	abort.abort();
	assert.deepEqual(sent, [{ toolCallId: "q1", requestId: `cancel-${d.id}`, cancel: true }]);
	s.events.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "q1" });
	s.fire("tool_execution_end", { toolCallId: "q1", toolName: "ask_user_question" });
	abort.signal.dispatchEvent(new Event("abort"));
	assert.equal(sent.length, 1, "the abort listener left with its call");
});

test("without pi-intercom, or with a broker that drops, nothing breaks and the dialog stays terminal-only", () => {
	const s = session({ intercom: false });
	s.open();
	assert.equal(s.published.length, 0);
	const t = session();
	t.open();
	t.own();
	t.connected = false;
	t.events.emit("robot-hand:closed", { version: 1, id: "d1", by: "local" });
	assert.equal(t.lists().length, 1, "nothing sent while disconnected");
});
