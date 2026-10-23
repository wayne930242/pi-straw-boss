import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Ack, type Dialogs, guiNamespace, type LocalHub, REGISTER, startBridge, type ToHub } from "../src/bridge.ts";
import { secretDigest, selectDigest } from "../src/owners.ts";
import { newKeys, seal } from "../src/seal.ts";

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
	const cmds: { name: string; source: string; description?: string }[] = [];
	const pi = { events, getCommands: () => cmds, on: (type: string, h: (e: unknown, ctx: unknown) => void) => handlers.set(type, [...(handlers.get(type) ?? []), h]) } as unknown as ExtensionAPI;
	const hub: { current?: LocalHub & { got: [string, ToHub][] } } = {};
	const closes: boolean[] = [];
	let closeWhy: string | undefined;
	const bridge = startBridge(pi, { env: { HERDR_PANE_ID: "wA:p1", PI_INTERCOM_SESSION_ID: me, ...env }, dir, local: () => hub.current, close: (keepPane) => (closes.push(keepPane), closeWhy) });
	const ctx = { hasUI: true, ui: { notify: (t: string) => notices.push(t) }, sessionManager: { getSessionFile: () => "/s/2026_S.jsonl" }, signal: undefined as AbortSignal | undefined };
	const fire = (type: string, e: Record<string, unknown> = {}) => (handlers.get(type) ?? []).forEach((h) => h({ type, ...e }, ctx));
	const record = (ownerSession?: string, pid = process.pid) => writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid, port: 1, token: "t", owner: "x", ...(ownerSession ? { ownerSession } : {}) }));
	if (gui) record(gui);
	fire("session_start");
	const count = () => [...bus.values()].reduce((n, hs) => n + hs.length, 0);
	const s = {
		dir, regs, published, owners, notices, ctx, hub, bridge, fire, record, count, events, cmds,
		closes, set closeWhy(v: string | undefined) { closeWhy = v; },
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

test("G's channel from the start when gui.json names another session (the server may probe the editor); the list goes to G only while G owns the channel", async () => {
	const s = session();
	assert.deepEqual(s.regs.map((r) => [r.namespace, r.ownerEligible]), [[guiNamespace("G"), false]], "registered at start, never owner-eligible");
	s.open();
	assert.equal(s.regs.length, 1, "a dialog adds no channel");
	assert.match(guiNamespace("G"), /^straw-boss\/gui\/[0-9a-f]{32}$/);
	assert.equal(s.published.length, 0, "no owner yet: nothing sent");
	s.own();
	assert.deepEqual(s.published.map((p) => [p.ns, p.audience]), [[guiNamespace("G"), "owner"]]);
	const list = s.published[0]!.payload as Dialogs;
	assert.deepEqual({ ...list, bridgeId: "" }, { version: 1, type: "dialogs", bridgeId: "", pane: "wA:p1", file: "/s/2026_S.jsonl", dialogs: [{ owner: "robot-hand", id: "d1", toolCallId: "c1", digest: DIGEST, select: SELECT }], closed: [], documents: [] });
	s.regs[0]!.onEvent({ type: "connection", connected: true });
	assert.equal(s.lists().length, 2, "resent when the connection comes back");
	s.events.emit("robot-hand:closed", { version: 1, id: "d1", by: "local" });
	assert.deepEqual(s.lists().at(-1), [], "a close sends the empty list");
	assert.deepEqual((s.published.at(-1)!.payload as Dialogs).closed, [{ id: "d1", by: "local" }], "with who closed it");
});

test("the session's queue goes with the dialogs: messages typed while it works, until their turn takes them or pi empties the queue", () => {
	const s = session();
	s.own();
	let waiting = true;
	(s.ctx as unknown as { hasPendingMessages(): boolean }).hasPendingMessages = () => waiting;
	const queued = () => (s.published.filter((p) => p.payload.type === "dialogs").at(-1)!.payload as Dialogs).queued;
	s.fire("input", { text: "check refunds too", source: "interactive", streamingBehavior: "steer" });
	s.fire("input", { text: "then summarize", source: "interactive", streamingBehavior: "followUp" });
	s.fire("input", { text: "a prompt while idle", source: "interactive" });
	assert.deepEqual(queued(), [{ text: "check refunds too", as: "steer" }, { text: "then summarize", as: "followUp" }]);
	s.fire("message_start", { message: { role: "assistant", content: [] } });
	s.fire("message_start", { message: { role: "user", content: [{ type: "text", text: "check refunds too" }] } });
	assert.deepEqual(queued(), [{ text: "then summarize", as: "followUp" }], "its user message took the steer");
	s.fire("message_start", { message: { role: "user", content: "changed by another extension" } });
	assert.equal(queued(), undefined, "a text that matches nothing takes the oldest");
	for (let i = 0; i < 7; i++) s.fire("input", { text: i ? `m${i}` : "x".repeat(300), source: "interactive", streamingBehavior: "steer" });
	assert.deepEqual([queued()!.length, queued()![0]!.text.length, queued()![0]!.text.endsWith("…"), queued()![4]!.text], [5, 200, true, "m4"], "the five oldest, each cut");
	s.bridge.sync();
	assert.equal(queued()!.length, 5, "kept while pi says messages wait");
	waiting = false;
	s.bridge.sync();
	assert.equal(queued(), undefined, "cleared once pi's queue is empty (Esc, Alt+Up)");
});

test("the session's monitors go with the dialogs, from pi-loop-monitor's events, and stop going when the session ends", () => {
	const s = session();
	s.own();
	const monitors = () => (s.published.filter((p) => p.payload.type === "dialogs").at(-1)!.payload as Dialogs).monitors;
	s.events.emit("monitor:started", { monitorId: "1", command: "npm test", description: "unit tests" });
	assert.deepEqual(monitors()?.map((m) => [m.id, m.what, m.status]), [["1", "unit tests", "running"]]);
	s.events.emit("monitor:finished", { monitorId: "1", status: "error", exitCode: 1 });
	assert.deepEqual(monitors()?.map((m) => [m.status, m.exit]), [["error", 1]]);
	s.fire("session_shutdown");
	assert.equal(monitors(), undefined, "the last list is empty");
	s.events.emit("monitor:started", { monitorId: "2", command: "x" });
	assert.equal(monitors(), undefined, "no longer listening");
});

test("pendings are taken only for a call of the owner's own tool in flight, in contract v1", () => {
	const s = session();
	s.own();
	s.events.emit("robot-hand:pending", { version: 1, id: "x1", toolCallId: "never-started", digest: DIGEST, select: SELECT });
	s.fire("tool_execution_start", { toolCallId: "c9", toolName: "bash", args: {} });
	s.events.emit("robot-hand:pending", { version: 1, id: "x2", toolCallId: "c9", digest: DIGEST, select: SELECT });
	s.open("x3", "c1", { version: 2 });
	assert.deepEqual(s.lists(), [[]], "nothing taken, so nothing relayed but the empty list of the start");
	s.open("d1", "c2");
	s.own();
	assert.deepEqual(s.lists().at(-1)!.map((d) => d.id), ["d1"]);
	s.fire("tool_execution_end", { toolCallId: "c2", toolName: "robot_hand" });
	assert.deepEqual(s.lists().at(-1), [], "the end of its call closes a dialog its owner never closed");
});

test("a gate's dialog (pi-code's hook confirmation) is taken for any tool's call in flight, and only for one", () => {
	const s = session(), select = { title: "Allow edit?", choices: [{ label: "Allow" }, { label: "Deny" }] };
	s.own();
	const gate = (id: string, call: string) => s.events.emit("pi-code:dialog:pending", { version: 1, id, toolCallId: call, digest: selectDigest(select), select });
	gate("g0", "never-started");
	s.fire("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} });
	s.fire("tool_execution_start", { toolCallId: "c2", toolName: "edit", args: {} });
	gate("g1", "c2");
	assert.deepEqual(s.lists().at(-1)!.map((d) => [d.owner, d.id, d.toolCallId]), [["pi-code", "g1", "c2"]]);
	s.fire("tool_execution_end", { toolCallId: "c2", toolName: "edit" });
	assert.deepEqual(s.lists().at(-1), [], "the end of the gated call closes it");
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

test("a sync from G resends; a gui.json naming another server is followed; past 16 servers the session stays read-only and says so once", async () => {
	const s = session();
	s.open();
	s.own();
	s.message({ version: 1, type: "sync" });
	assert.equal(s.lists().length, 2);
	for (let i = 1; i <= 17; i++) {
		await new Promise((resolve) => setTimeout(resolve, 5));
		s.record(`G${i}`);
		s.bridge.sync();
	}
	assert.equal(s.regs.length, 16, "intercom has no unregister, so every host the session joined stays registered; 16 of its 32 channels are for hosts");
	assert.deepEqual(s.notices.length, 1);
	assert.match(s.notices[0]!, /answer its dialogs in the terminal/);
});

test("no channel is joined for a server whose process is already gone: the survivor that takes over rewrites gui.json within moments, and that one is joined", async () => {
	const s = session({ gui: "" }); // gui.json does not exist yet
	s.record("D", 2 ** 22 + 7);
	s.bridge.sync();
	assert.equal(s.regs.length, 0, "a host that is gone is not worth one of the session's channels");
	await new Promise((resolve) => setTimeout(resolve, 5));
	s.record("E");
	s.bridge.sync();
	assert.deepEqual(s.regs.map((r) => r.namespace), [guiNamespace("E")]);
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

test("a probe from G for this bridge is answered with what Enter would submit, as a class and at most a command name, never the draft", () => {
	const s = session(), drafts: [string | undefined, Record<string, unknown>][] = [["/reload", { editor: "text", ending: "reload" }], ["  /new  please", { editor: "text", ending: "new" }], ["fix the secret token sk-123", { editor: "text" }], ["", { editor: "empty" }], ["   \n ", { editor: "empty" }], ["/re", { editor: "command" }], ["/re ", { editor: "command" }], ["/", { editor: "command" }], ["/model x", { editor: "command" }], ["/reloaded", { editor: "command" }]];
	s.own();
	const to = bridgeIdOf(s), ui = s.ctx.ui as Record<string, unknown>;
	for (const [i, [draft, want]] of drafts.entries()) {
		ui.getEditorText = () => draft;
		s.message({ version: 1, type: "probe", to, probeId: `p${i}` });
		const got = s.published.at(-1)!;
		assert.deepEqual([got.audience, got.payload], ["owner", { version: 1, type: "probe-result", bridgeId: to, probeId: `p${i}`, ...want }], JSON.stringify(draft));
		if (draft && want.editor === "text" && !want.ending) assert.ok(!JSON.stringify(got.payload).includes("secret"), "the draft never leaves");
	}
	ui.getEditorText = () => { throw new Error("no editor"); };
	s.message({ version: 1, type: "probe", to, probeId: "t" });
	assert.equal((s.published.at(-1)!.payload as { editor: string }).editor, "unknown", "an editor that cannot be read");
	s.ctx.hasUI = false;
	s.message({ version: 1, type: "probe", to, probeId: "u" });
	assert.equal((s.published.at(-1)!.payload as { editor: string }).editor, "unknown", "no UI (print mode)");
	assert.deepEqual(s.bridge.probe(), { editor: "unknown" }, "the hub of this session asks in-process");
	s.ctx.hasUI = true;
	ui.getEditorText = () => "/fork";
	assert.deepEqual(s.bridge.probe(), { editor: "text", ending: "fork" });
});

test("a commands request from G for this bridge is answered with the session's commands that match, and only from G for this bridge", () => {
	const s = session();
	s.own();
	s.cmds.push({ name: "review", source: "prompt", description: "Review the diff" }, { name: "skill:release", source: "skill" }, { name: "boss", source: "extension", description: "x".repeat(400) });
	const to = bridgeIdOf(s), results = () => s.published.filter((p) => p.payload.type === "commands-result").map((p) => p.payload as unknown as { reqId: string; commands: { name: string }[] });
	s.message({ version: 1, type: "commands", to, reqId: "r1", prefix: "re" });
	assert.deepEqual(results().map((r) => [r.reqId, r.commands.map((c) => c.name)]), [["r1", ["review", "skill:release"]]], "names that start with it, then names that contain it");
	s.message({ version: 1, type: "commands", to, reqId: "r2", prefix: "" });
	assert.equal(results().at(-1)!.commands.length, 3);
	s.message({ version: 1, type: "commands", to, reqId: "a", prefix: "re" }, { from: "X" });
	s.message({ version: 1, type: "commands", to: "someone-else", reqId: "b", prefix: "re" });
	s.message({ version: 1, type: "commands", to, reqId: "c", prefix: "x".repeat(65) });
	s.message({ version: 1, type: "commands", to, reqId: "d" });
	s.message({ version: 1, type: "commands", to, reqId: "x".repeat(65), prefix: "" });
	assert.equal(results().length, 2, "another sender, another bridge, a prefix too long or missing, an id too long");
	assert.deepEqual(s.bridge.commands("bo").map((c) => c.name), ["boss"], "the hub of this session asks in-process");
});

test("a stash check from G for this bridge says what a resume would lose, quits nothing, and only answers G", () => {
	const s = session();
	s.own();
	let idle = true, pending = false;
	Object.assign(s.ctx, { isIdle: () => idle, hasPendingMessages: () => pending });
	const to = bridgeIdOf(s), results = () => s.published.filter((p) => p.payload.type === "stash-check-result").map((p) => p.payload as unknown as { reqId: string; reason?: string });
	s.message({ version: 1, type: "stash-check", to, reqId: "r1" });
	assert.deepEqual(results().map((r) => [r.reqId, r.reason]), [["r1", undefined]], "an idle session with nothing open can go");
	[idle, pending] = [false, true];
	s.open();
	s.events.emit("monitor:started", { monitorId: "1", command: "npm run dev" });
	s.message({ version: 1, type: "stash-check", to, reqId: "r2" });
	assert.equal(results().at(-1)!.reason, "a turn is running, messages wait in its queue, a dialog is open, a background monitor is running");
	s.message({ version: 1, type: "stash-check", to, reqId: "a" }, { from: "X" });
	s.message({ version: 1, type: "stash-check", to: "someone-else", reqId: "b" });
	s.message({ version: 1, type: "stash-check", to, reqId: "x".repeat(65) });
	assert.equal(results().length, 2, "another sender, another bridge, an id too long");
	assert.deepEqual(s.closes, [], "a check never quits the session");
	assert.match(String(s.bridge.stashCheck()), /a turn is running/, "the hub of this session asks in-process");
	s.message({ version: 1, type: "close", to, reqId: "c1", keepPane: true, ifStashable: true });
	assert.deepEqual(s.published.filter((p) => p.payload.type === "close-result").map((p) => (p.payload as unknown as { accepted: boolean }).accepted), [false]);
	assert.deepEqual(s.closes, [], "a stash's close is refused while the session is not stashable");
	[idle, pending] = [true, false];
	s.events.emit("robot-hand:closed", { version: 1, id: "d1", by: "local" });
	s.events.emit("monitor:finished", { monitorId: "1", status: "done", exitCode: 0 });
	s.message({ version: 1, type: "close", to, reqId: "c2", keepPane: true, ifStashable: true });
	assert.deepEqual(s.closes, [true], "and taken once it is again");
});

test("a probe counts only from G as the channel's current owner, at its epoch, for this bridge, from the server gui.json names now", () => {
	const s = session();
	s.own();
	(s.ctx.ui as Record<string, unknown>).getEditorText = () => "/quit";
	const to = bridgeIdOf(s), results = () => s.published.filter((p) => p.payload.type === "probe-result").length;
	s.message({ version: 1, type: "probe", to, probeId: "a" }, { from: "X" });
	s.message({ version: 1, type: "probe", to, probeId: "b" }, { epoch: "e0" });
	s.message({ version: 1, type: "probe", to: "someone-else", probeId: "c" });
	s.message({ version: 2, type: "probe", to, probeId: "d" });
	s.message({ version: 1, type: "probe", to, probeId: "x".repeat(65) });
	s.message({ version: 1, type: "probe", to });
	assert.equal(results(), 0);
	s.record("H");
	s.bridge.sync();
	s.message({ version: 1, type: "probe", to, probeId: "e" });
	assert.equal(results(), 0, "a server gui.json no longer names");
	s.record("G");
	s.bridge.sync();
	s.record("H");
	utimesSync(join(s.dir, "gui.json"), new Date(), new Date(Date.now() + 5000));
	s.message({ version: 1, type: "probe", to, probeId: "e2" });
	assert.equal(results(), 0, "gui.json was rewritten a moment ago, before the 2 s check: the probe reads it first");
	s.record("G");
	s.bridge.sync();
	s.message({ version: 1, type: "probe", to, probeId: "f" });
	assert.equal(results(), 1);
	s.record("G", 2 ** 22 + 7);
	s.bridge.sync();
	s.message({ version: 1, type: "probe", to, probeId: "g" });
	assert.equal(results(), 1, "gui.json names a server whose process is gone");
	rmSync(join(s.dir, "gui.json"));
	s.bridge.sync();
	s.message({ version: 1, type: "probe", to, probeId: "h" });
	assert.equal(results(), 1, "no gui.json: no server");
});

test("a bridge follows gui.json from the start: a server that starts later is joined within 2 s, and /new tells it the new file at once", () => {
	mock.timers.enable({ apis: ["setInterval"] });
	try {
		const s = session({ gui: "" });
		assert.equal(s.regs.length, 0, "no server yet");
		s.record("G");
		mock.timers.tick(2000);
		assert.deepEqual(s.regs.map((r) => r.namespace), [guiNamespace("G")]);
		s.own();
		const n = s.lists().length;
		s.ctx.sessionManager.getSessionFile = () => "/s/2026_new.jsonl";
		s.fire("session_start");
		assert.equal(s.lists().length, n + 1);
		assert.equal((s.published.at(-1)!.payload as Dialogs).file, "/s/2026_new.jsonl");
		s.fire("session_shutdown");
	} finally {
		mock.timers.reset();
	}
});

test("the gui.json check keeps no process alive: a session with a bridge and no server exits on its own", () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-bridge-test-"));
	dirs.push(dir);
	const code = `import { startBridge } from ${JSON.stringify(new URL("../src/bridge.ts", import.meta.url).href)};
const hs = new Map(), pi = { events: { on: () => () => {}, emit: () => {} }, on: (t, h) => hs.set(t, h) };
startBridge(pi, { env: { HERDR_PANE_ID: "wA:p1", PI_INTERCOM_SESSION_ID: "S" }, dir: ${JSON.stringify(dir)}, local: () => undefined });
hs.get("session_start")({}, { hasUI: false, ui: {}, sessionManager: { getSessionFile: () => undefined } });`;
	const start = Date.now(), run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { timeout: 10_000 });
	assert.equal(run.status, 0, String(run.stderr));
	assert.ok(Date.now() - start < 5000, "it did not wait for the 2 s timer");
});

/** pi-herdr-doc-review 0.4.x on the bus, as its README's "Browser viewers" describes it: the list, the request, and a form with its result. */
const DOC = { id: "6f1e2d3c-4b5a-4968-8776-655443322110", path: "/work/docs/plan.html", kind: "html", display: "docs/plan.html", reason: "Plan ready", revision: 1, onScreen: true };
function docReview(s: ReturnType<typeof session>, documents: Record<string, unknown>[] = [DOC]) {
	const forms: Record<string, unknown>[] = [], requests: unknown[] = [];
	const offs = [
		s.events.on("doc-review:documents-request", (r) => (requests.push(r), s.events.emit("doc-review:documents", { version: 1, documents }))),
		s.events.on("doc-review:form", (raw) => {
			const f = raw as Record<string, unknown>;
			forms.push(f);
			s.events.emit("doc-review:form-result", { version: 1, id: "other", answerId: f.answerId, accepted: true });
			s.events.emit("doc-review:form-result", { version: 1, id: f.id, answerId: f.answerId, accepted: f.fields instanceof Array && f.fields.length > 0, ...(f.fields instanceof Array && f.fields.length ? {} : { reason: "empty" }) });
		}),
	];
	return { forms, requests, publish: (docs: Record<string, unknown>[]) => s.events.emit("doc-review:documents", { version: 1, documents: docs }), off: () => offs.forEach((off) => off()) };
}
const docsSent = (s: ReturnType<typeof session>) => s.published.filter((p) => p.payload.type === "dialogs").map((p) => p.payload as Dialogs);

test("documents: the owner's list goes to G with the dialogs, asked for at the session's start, so a reloaded bridge sees the documents already open", () => {
	const s = session(), owner = docReview(s);
	s.own();
	assert.equal(docsSent(s).at(-1)!.documents?.length, 0, "the owner was not listening before this bridge started");
	s.fire("session_start");
	assert.deepEqual(owner.requests, [{ version: 1 }], "the list is asked for once per start");
	assert.deepEqual(docsSent(s).at(-1)!.documents, [DOC]);
	owner.publish([{ ...DOC, revision: 2 }]);
	assert.equal(docsSent(s).at(-1)!.documents![0]!.revision, 2, "a new revision goes at once");
	s.events.emit("doc-review:documents", { version: 2, documents: [] });
	assert.equal(docsSent(s).at(-1)!.documents![0]!.revision, 2, "a list of another version is ignored");
	owner.publish([{ ...DOC, reason: "r".repeat(5000) }]);
	assert.equal(docsSent(s).at(-1)!.documents![0]!.reason.length, 2048, "a long reason (show_doc sets no limit) is cut, not refused");
	owner.publish([{ ...DOC, revision: "3" }]);
	assert.deepEqual(docsSent(s).at(-1)!.documents, [], "a v1 list out of shape counts as none: the older list never stays");
	owner.publish(Array.from({ length: 32 }, (_, i) => ({ ...DOC, id: `doc-${i}`, display: "d".repeat(400), reason: "r".repeat(400) })));
	const cut = docsSent(s).at(-1)!;
	assert.deepEqual([cut.documents, cut.docsCut], [[], true], "a list over the 15 KiB message cap goes as none, with the reason");
	const cjk = Array.from({ length: 20 }, (_, i) => ({ ...DOC, id: `doc-${i}`, display: `文件/規格-${i}.html`, reason: "請審閱這份規格".repeat(40) }));
	assert.ok(JSON.stringify(cjk).length < 14 * 1024 && Buffer.byteLength(JSON.stringify(cjk)) > 15 * 1024, "under the cap in characters, over it in bytes");
	owner.publish(cjk);
	assert.equal(docsSent(s).at(-1)!.docsCut, true, "the cap counts bytes: CJK text is three bytes a character");
	owner.publish([DOC]);
	assert.deepEqual([docsSent(s).at(-1)!.documents, docsSent(s).at(-1)!.docsCut], [[DOC], undefined]);
	s.open();
	assert.equal(docsSent(s).at(-1)!.dialogs.length, 1, "the dialogs still go");
	s.fire("session_shutdown");
	assert.deepEqual([docsSent(s).at(-1)!.documents, docsSent(s).at(-1)!.dialogs], [[], []], "the session's end sends none");
	owner.off();
});

test("documents: a form answer from G for this bridge reaches the owner as doc-review:form, and its own result goes back; anyone else's is ignored", () => {
	const s = session(), owner = docReview(s);
	s.fire("session_start");
	s.own();
	const to = bridgeIdOf(s), form = (extra: Record<string, unknown> = {}) => ({ version: 1, type: "form", to, id: DOC.id, answerId: "n".repeat(32), fields: [["choice", "b"]], ...extra });
	const results = () => s.published.filter((p) => p.payload.type === "form-result").map((p) => [p.audience, p.payload]);
	s.message(form(), { from: "X" });
	s.message(form(), { epoch: "e0" });
	s.message(form({ to: "someone-else" }));
	s.message(form({ version: 2 }));
	s.message(form({ fields: [["a", 1]] }));
	s.message(form({ fields: Array.from({ length: 65 }, () => ["a", "b"]) }));
	s.message(form({ answerId: "x".repeat(65) }));
	assert.deepEqual([owner.forms.length, results().length], [0, 0], "another sender, epoch, bridge, version, or a malformed form reaches nobody");
	s.message(form());
	assert.deepEqual(owner.forms, [{ version: 1, id: DOC.id, answerId: "n".repeat(32), fields: [["choice", "b"]] }]);
	assert.deepEqual(results(), [["owner", { version: 1, type: "form-result", bridgeId: to, id: DOC.id, answerId: "n".repeat(32), accepted: true }]], "its own document's result only");
	s.message(form({ answerId: "e".repeat(32), fields: [] }));
	assert.deepEqual(results().at(-1)![1], { version: 1, type: "form-result", bridgeId: to, id: DOC.id, answerId: "e".repeat(32), accepted: false, reason: "empty" });
	s.message(form({ id: "not-listed" }));
	assert.deepEqual(results().at(-1)![1], { version: 1, type: "form-result", bridgeId: to, id: "not-listed", answerId: "n".repeat(32), accepted: false, reason: "closed" }, "a document this session does not list: closed, and the owner hears nothing");
	owner.publish([{ ...DOC, kind: "text" }]);
	s.message(form({ answerId: "t".repeat(32) }));
	assert.equal((results().at(-1)![1] as { reason?: string }).reason, "closed", "a text document takes no form");
	assert.equal(owner.forms.length, 2);
	owner.off();
	s.fire("session_shutdown");
});

test("documents: an owner that never answers a form leaves it unanswered here (the server says not confirmed) and its listener goes after 4 s", () => {
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	try {
		const s = session(), owner = docReview(s);
		s.fire("session_start");
		owner.off();
		s.own();
		const listeners = s.count();
		s.message({ version: 1, type: "form", to: bridgeIdOf(s), id: DOC.id, answerId: "n".repeat(32), fields: [["a", "b"]] });
		assert.equal(s.count(), listeners + 1, "waiting for the result");
		mock.timers.tick(4000);
		assert.equal(s.count(), listeners, "the result listener is gone");
		assert.equal(s.published.filter((p) => p.payload.type === "form-result").length, 0);
		s.fire("session_shutdown");
	} finally {
		mock.timers.reset();
	}
});

/** The secret dialog "s1" open in a session whose bridge G owns the channel for. */
function secretSession() {
	const s = session(), SECRET = { label: "Deploy token", instructions: ["Create one."], destination: ".env.local" }, digest = secretDigest(SECRET), seen: unknown[] = [];
	s.fire("tool_execution_start", { toolCallId: "c1", toolName: "secret_drop", args: {} });
	s.events.emit("robot-hand:secret:pending", { version: 1, id: "s1", toolCallId: "c1", digest, secret: SECRET });
	s.own();
	s.events.on("robot-hand:secret:answer", (raw) => seen.push(raw));
	return { s, SECRET, digest, seen, to: bridgeIdOf(s) };
}

test("secret_drop (SB-F001): a secret dialog is never relayed to the GUI, with or without a key; a call of another tool's is not taken for one", () => {
	const s = session(), SECRET = { label: "Deploy token", instructions: ["Create one."], destination: ".env.local" };
	s.fire("tool_execution_start", { toolCallId: "c9", toolName: "bash", args: {} });
	s.events.emit("robot-hand:secret:pending", { version: 1, id: "s0", toolCallId: "c9", digest: secretDigest(SECRET), secret: SECRET });
	assert.equal(s.lists().length, 0, "a call of another tool is not a secret_drop's");
	const x = secretSession();
	assert.deepEqual(x.s.lists().at(-1), [], "the secret's label, steps, and destination do not leave the session either");
	assert.equal(JSON.stringify(x.s.published).includes('"key"'), false, "no public key is made or relayed");
});

test("secret_drop (SB-F001): whatever an answer to the secret dialog carries (a plain value, a sealed one, nothing) is refused and nothing reaches the owner", () => {
	const x = secretSession(), value = "tok-refuse-me", sealed = seal(value, newKeys().pub, { id: "s1", digest: x.digest, answerId: "a".repeat(16), bridgeId: x.to });
	const answer = (extra: Record<string, unknown>, answerId = "a".repeat(16)) => x.s.message({ version: 1, type: "answer", to: x.to, id: "s1", answerId, digest: x.digest, ...extra });
	answer({ value });
	answer({ sealed });
	answer({ value, sealed: "garbage" });
	answer({});
	assert.deepEqual(x.seen, [], "the owner never heard of any of them");
	assert.deepEqual([...new Set(x.s.acks().map((a) => `${a.outcome}/${a.reason}`))], ["rejected/terminal_only"]);
	assert.equal(x.s.acks().length, 4);
	assert.equal(JSON.stringify([x.s.published, x.s.notices]).includes(value), false);
});

test("a dialog other than a secret carries no key", () => {
	const s = session();
	s.open();
	s.own();
	assert.equal(JSON.stringify(s.lists().at(-1)).includes("\"key\""), false);
});

test("a twin (the wrap of ctx.ui) yields to a contract owner's dialog on the same tool call, whichever opens first; on another call it is relayed", () => {
	const twin = { version: 1, id: "t1", toolCallId: "c1", digest: selectDigest({ title: "T", choices: [{ label: "Yes" }, { label: "No" }], confirm: true }), select: { title: "T", choices: [{ label: "Yes" }, { label: "No" }], confirm: true } };
	const owners = (s: ReturnType<typeof session>) => s.lists().at(-1)!.map((d) => d.owner);
	// The owner first (robot_hand announces its dialog, then opens pi's selector): the twin never joins.
	const a = session();
	a.own();
	a.open("d1", "c1");
	a.events.emit("straw-boss:ui:pending", twin);
	assert.deepEqual(owners(a), ["robot-hand"]);
	// The twin first: it is not relayed, the owner's dialog is, and the twin's late close and answer find nothing.
	const b = session();
	b.own();
	b.fire("tool_execution_start", { toolCallId: "c1", toolName: "robot_hand", args: {} });
	b.events.emit("straw-boss:ui:pending", twin);
	assert.deepEqual(owners(b), [], "a tool with a contract owner is never relayed as a twin, so its localOnly choices and notes cannot be lost");
	b.events.emit("robot-hand:pending", { version: 1, id: "d1", toolCallId: "c1", digest: DIGEST, select: SELECT });
	assert.deepEqual(owners(b), ["robot-hand"]);
	b.events.emit("straw-boss:ui:closed", { version: 1, id: "t1", by: "local" });
	assert.deepEqual(owners(b), ["robot-hand"], "the withdrawn twin's close changes nothing");
	// Another tool call's twin is its own dialog.
	const c = session();
	c.own();
	c.open("d1", "c1");
	c.fire("tool_execution_start", { toolCallId: "c2", toolName: "bash", args: {} });
	c.events.emit("straw-boss:ui:pending", { ...twin, toolCallId: "c2" });
	assert.deepEqual(owners(c).sort(), ["pi-ui", "robot-hand"]);
	// A twin that names no call is not relayed at all (a gate must name one).
	const d = session();
	d.own();
	d.events.emit("straw-boss:ui:pending", { ...twin, toolCallId: undefined });
	assert.equal(d.lists().at(-1)?.length ?? 0, 1, "the bridge keeps it for the hub, which leaves it in the terminal");
});
