import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withPending } from "../src/ask.ts";
import { type Ack, type AnswerMessage, type Dialogs, type FormMessage, type FormReply, guiNamespace, REGISTER } from "../src/bridge.ts";
import type { Doc } from "../src/documents.ts";
import { createHub } from "../src/dialogs.ts";
import { canonical } from "../src/history.ts";
import type { Net, Ref } from "../src/net.ts";
import { type Dialog, secretDigest, selectDigest } from "../src/owners.ts";
import { keyOk, newKeys, open } from "../src/seal.ts";
import type { Editor } from "../src/probe.ts";
import { assistant, call, header, lines, user } from "./sessions.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-dialogs-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
let n = 0;
/** A session file whose newest assistant message has these open calls (none: the user spoke last). */
function file(calls: [string, string][]) {
	const path = join(scratch, `f${++n}_S.jsonl`);
	writeFileSync(path, lines(calls.length ? [header(), user("u1", null, "go"), assistant("a1", "u1", calls.map(([id, name]) => call(id, name, { command: "ls", reason: "r", label: "secret" })))] : [header(), user("u1", null, "go")]));
	return canonical(path)!;
}
const SELECT = { title: "Robot Hand — r\n\n  ! ls", choices: [{ label: "Run it" }, { label: "No, thanks" }] };
const dialog = (extra: Partial<Dialog> = {}): Dialog => ({ owner: "robot-hand", id: "d1", toolCallId: "c1", digest: selectDigest(SELECT), select: SELECT, ...extra });
const net = (): Net => ({ bases: [{ id: "wA", label: "Alpha", mark: "working", head: true, tower: null, outposts: [], outside: [], tabs: [{ id: "wA:t1", label: "work", units: [{ id: "S", key: "S", control: true, name: "s", role: "main", mark: "working", subs: [] }] }] }] });

/** A hub for session G with a fake intercom channel, a local bridge that records what it was handed, and session S on pane wA:p1. */
function hub({ me = "G", owner = "G" } = {}) {
	const published: { payload: unknown; options: unknown }[] = [], delivered: AnswerMessage[] = [], changes: number[] = [];
	let reg: { onEvent(e: Record<string, unknown>): void } | undefined, reply: ((a: AnswerMessage) => Ack | undefined) | undefined, editor: Editor = { editor: "empty" };
	const forms: FormMessage[] = [];
	let formReply: ((m: FormMessage) => FormReply | undefined) | undefined;
	const events = { emit: (ch: string, r: never) => ch === REGISTER && ((reg = r), (r as { onReady(c: unknown): void }).onReady({ snapshot: () => ({ connected: true, owner: { sessionId: owner, epoch: "e1" } }), publish: (payload: unknown, options: unknown) => void published.push({ payload, options }) })), on: () => () => {} };
	const local = { deliver: (m: AnswerMessage, r: (a: Ack) => void) => { delivered.push(m); const a = reply?.(m); if (a) r(a); }, sync: () => {}, probe: () => editor, commands: () => [], close: () => ({ accepted: true }), form: (m: FormMessage, r: (x: FormReply) => void) => { forms.push(m); const x = formReply?.(m); if (x) r(x); } };
	const h = createHub({ events } as unknown as ExtensionAPI, me, local);
	h.start(() => changes.push(1));
	const list = (dialogs: Dialog[], extra: Partial<Dialogs> = {}): Dialogs => ({ version: 1, type: "dialogs", bridgeId: "B", pane: "wA:p1", file: null, dialogs, closed: [], ...extra });
	return { h, published, delivered, changes, list, forms, event: (e: Record<string, unknown>) => reg?.onEvent(e), answerWith: (f: typeof reply) => (reply = f), editorIs: (e: Editor) => (editor = e), formWith: (f: typeof formReply) => (formReply = f) };
}
/** The snapshot as the server reads it: S is the unit on pane wA:p1 with session file `path`. */
async function read(x: ReturnType<typeof hub>, path: string | undefined, { pane = "wA:p1", from = "S" } = {}) {
	const refs = new Map<string, Ref>([["S", { key: "S", base: "wA", name: "s", role: "main", file: path, pane: "wA:p1" }]]);
	const out = net();
	await withPending(out, (key) => refs.get(key)?.file, x.h.relayed([{ id: from, herdrLocation: { status: "current", paneId: pane } }], refs));
	return { base: out.bases[0]!, unit: out.bases[0]!.tabs[0]!.units[0]! };
}

test("a relayed dialog binds to the unit on its pane with its file: it waits at once, and the page may answer it", async () => {
	const x = hub(), path = file([["c1", "robot_hand"]]);
	x.h.receive("S", x.list([dialog()], { file: path }));
	assert.equal(x.changes.length, 1, "a change is pushed at once");
	const { base, unit } = await read(x, path);
	assert.deepEqual([unit.mark, unit.note, base.mark], ["waiting", "waiting on a question", "waiting"], "waiting before Herdr reports the pane blocked");
	assert.deepEqual(unit.pending, { callId: "c1", tool: "robot_hand", answer: { dialog: "d1", digest: selectDigest(SELECT), select: SELECT } });
	assert.deepEqual(x.h.target("S"), { from: "S", bridgeId: "B", answer: unit.pending!.answer });
	for (const [what, opts] of [["another pane", { pane: "wA:p2" }], ["another session on the pane", { from: "T" }]] as const) {
		const other = await read(x, path, opts);
		assert.deepEqual([other.unit.mark, other.unit.pending, x.h.target("S")], ["working", undefined, undefined], what);
	}
	x.h.receive("S", x.list([dialog()], { file: join(scratch, "elsewhere_S.jsonl") }));
	assert.equal((await read(x, path)).unit.pending, undefined, "a list naming another file is not this unit's");
});

test("a relayed queue goes to its unit, oldest first; one out of shape is left out while the dialogs still go", async () => {
	const x = hub(), path = file([]);
	const queued = [{ text: "also check refunds", as: "steer" as const }, { text: "then summarize", as: "followUp" as const }];
	x.h.receive("S", x.list([], { file: path, queued }));
	assert.deepEqual((await read(x, path)).unit.queued, queued);
	for (const bad of [[{ text: "x", as: "later" }], [{ text: 1, as: "steer" }], [{ text: "x".repeat(201), as: "steer" }], Array.from({ length: 6 }, () => ({ text: "x", as: "steer" }))]) {
		x.h.receive("S", x.list([dialog()], { file: path, queued: bad as never }));
		const { unit } = await read(x, path);
		assert.deepEqual([unit.queued, unit.mark], [undefined, "waiting"], JSON.stringify(bad).slice(0, 40));
	}
	x.h.receive("S", x.list([], { file: path }));
	assert.equal((await read(x, path)).unit.queued, undefined, "an emptied queue clears");
});

test("a relayed monitor list goes to its unit; one out of shape is left out while the dialogs still go", async () => {
	const x = hub(), path = file([]);
	const monitors = [{ id: "2", what: "vite --port 5199", status: "running" as const, lines: 3, at: 2, last: "ready" }, { id: "1", what: "npm test", status: "error" as const, exit: 1, lines: 9, at: 1, ended: 5 }];
	x.h.receive("S", x.list([], { file: path, monitors }));
	assert.deepEqual(JSON.parse(JSON.stringify((await read(x, path)).unit.monitors)), monitors);
	x.h.receive("S", x.list([dialog()], { file: path, monitors: [{ ...monitors[0], status: "odd" }] as never }));
	const { unit } = await read(x, path);
	assert.deepEqual([unit.monitors, unit.mark], [undefined, "waiting"]);
});

test("each rule that keeps a dialog in the terminal says why", async () => {
	const x = hub(), robot = file([["c1", "robot_hand"]]), two = file([["c1", "robot_hand"], ["c2", "bash"]]), secret = file([["c1", "secret_drop"]]);
	const why = async (dialogs: Dialog[], path: string | undefined = robot) => {
		x.h.receive("S", x.list(dialogs, { file: path ?? robot }));
		const { unit } = await read(x, path);
		assert.equal(unit.pending?.answer, undefined);
		assert.equal(x.h.target("S"), undefined);
		return unit.pending?.why;
	};
	assert.equal(await why([dialog(), dialog({ id: "d2" })]), "It waits on more than one dialog.");
	x.h.receive("S", x.list([dialog({ busy: true })], { file: robot }));
	const busy = (await read(x, robot)).unit.pending;
	assert.deepEqual([busy?.answer, busy?.why], [undefined, "An answer is on its way; check the terminal."]);
	assert.equal(x.h.target("S")?.answer.dialog, "d1", "read-only, but an answer resent (Check again) still reaches the bridge, which replays it or says busy");
	assert.match(String(await why([{ ...dialog({ big: true }), select: undefined }])), /too long to show here/);
	assert.equal(await why([dialog({ owner: "someone-else" })]), "It waits on a dialog.", "an owner no adapter knows");
	assert.equal(await why([dialog({ toolCallId: "c9" })]), "It waits on a dialog.", "not the file's open call: the file's own reading, read-only");
	assert.match(String(await why([dialog({ toolCallId: "c2" })], two)), /more than one dialog/, "the dialog names a call that is not its owner's tool");
	assert.match(String(await why([dialog({ toolCallId: "c9" })], two)), /more than one dialog/, "the dialog names a call that is not open");
	assert.match(String(await why([dialog({ digest: "0".repeat(64) })])), /differs from the one in the terminal/);
	assert.equal(await why([dialog()], secret), "It waits for a secret.", "a secret_drop is never answerable, whatever a bridge says");
	x.h.receive("S", x.list([dialog()], { file: robot }));
	assert.equal((await read(x, undefined)).unit.pending, undefined, "a unit without a readable session file binds no list (it cannot be answered or typed into)");
});

const GATE = { title: "Allow edit?\n\n  src/a.ts", choices: [{ label: "Allow" }, { label: "Deny" }] };
const gate = (extra: Partial<Dialog> = {}): Dialog => ({ owner: "pi-code", id: "g1", toolCallId: "c2", digest: selectDigest(GATE), select: GATE, ...extra });

test("a pi-code gate dialog binds to the call it names, whatever the tool, also when the file holds several open calls", async () => {
	const x = hub(), one = file([["c2", "edit"]]), two = file([["c1", "bash"], ["c2", "edit"]]);
	x.h.receive("S", x.list([gate()], { file: one }));
	assert.deepEqual((await read(x, one)).unit.pending, { callId: "c2", tool: "edit", answer: { dialog: "g1", digest: selectDigest(GATE), select: GATE } });
	x.h.receive("S", x.list([gate()], { file: two }));
	const { unit } = await read(x, two);
	assert.deepEqual(unit.pending, { callId: "c2", tool: "edit", answer: { dialog: "g1", digest: selectDigest(GATE), select: GATE } }, "the call it gates, not the file's first");
	assert.deepEqual(x.h.target("S"), { from: "S", bridgeId: "B", answer: unit.pending!.answer });
	x.h.receive("S", x.list([gate({ toolCallId: "c1" })], { file: two }));
	assert.equal((await read(x, two)).unit.pending?.callId, "c1", "the first call too");
	const mixed = file([["c1", "robot_hand"], ["c2", "bash"]]);
	x.h.receive("S", x.list([dialog()], { file: mixed }));
	assert.equal((await read(x, mixed)).unit.pending?.answer?.dialog, "d1", "an owner of one tool binds to its own call among several");
});

test("a gate dialog stays in the terminal with two relayed dialogs, a call that is not open, a digest mismatch, no call, or a secret_drop open", async () => {
	const x = hub(), two = file([["c1", "bash"], ["c2", "edit"]]), secret = file([["c1", "bash"], ["c2", "secret_drop"]]);
	const why = async (dialogs: Dialog[], path = two) => {
		x.h.receive("S", x.list(dialogs, { file: path }));
		const { unit } = await read(x, path);
		assert.equal(unit.pending?.answer, undefined);
		assert.equal(x.h.target("S"), undefined);
		return unit.pending?.why;
	};
	assert.equal(await why([gate(), gate({ id: "g2", toolCallId: "c1" })]), "It waits on more than one dialog.");
	assert.equal(await why([gate({ toolCallId: "c9" })]), "It waits on more than one dialog.", "bound to no open call");
	assert.match(String(await why([gate({ digest: "0".repeat(64) })])), /differs from the one in the terminal/);
	assert.equal(await why([{ ...gate(), toolCallId: undefined }]), "It waits on more than one dialog.", "a gate must name its call");
	assert.equal(await why([gate({ toolCallId: "c1" })], secret), "It waits for a secret.", "secret_drop open: never answerable");
	assert.equal(await why([gate({ toolCallId: "c2" })], file([["c2", "secret_drop"]])), "It waits for a secret.");
	assert.equal(await why([gate({ toolCallId: "c9" })], file([["c1", "edit"]])), "It waits on a dialog.", "one open call, not the one named");
});

test("a dialog of no tool call (an MCP approval) answers on a unit with no open call; malformed lists are dropped; a session that leaves takes its dialogs along", async () => {
	const x = hub(), path = file([]), mcp = { ...dialog({ owner: "pi-mcp-adapter", id: "m1" }), toolCallId: undefined };
	x.h.receive("S", x.list([mcp], { file: path }));
	assert.deepEqual((await read(x, path)).unit.pending, { callId: "m1", tool: "dialog", answer: { dialog: "m1", digest: mcp.digest, select: SELECT } });
	for (const bad of [{ ...mcp, select: { title: "T", choices: "x" } }, { ...mcp, digest: "nothex" }, { ...mcp, questions: [{ question: "Q", multiple: "no", options: [] }] }, null])
		x.h.receive("S", x.list([bad as Dialog], { file: path }));
	x.h.receive("S", { ...x.list([mcp], { file: path }), version: 2 } as never);
	assert.equal(x.changes.length, 1, "nothing malformed or of another version was taken");
	x.h.receive("S", x.list([], { file: path, closed: Array(17).fill({ id: "m0", by: "local" }) }));
	assert.equal(x.changes.length, 1, "at most 16 closed dialogs");
	x.event({ type: "session_left", sessionId: "S" });
	assert.equal((await read(x, path)).unit.pending, undefined);
	assert.equal(x.changes.length, 2);
});

test("answers go to the bridge in-process or over the channel (ownerOnly, from the owner), wait for the ack, and final outcomes replay", async () => {
	const x = hub({ me: "S" }), path = file([["c1", "robot_hand"]]);
	x.h.receive("S", x.list([dialog()], { file: path }));
	await read(x, path);
	x.answerWith((m) => ({ version: 1, type: "ack", bridgeId: m.to, id: m.id, answerId: m.answerId, outcome: "accepted" }));
	const t = x.h.target("S")!, a = { id: "d1", answerId: "a".repeat(16), digest: t.answer.digest, choice: 0 };
	assert.deepEqual(await x.h.send("S", t, a), { status: 200, body: { outcome: "accepted" } });
	assert.deepEqual(x.delivered, [{ version: 1, type: "answer", to: "B", ...a }]);
	assert.deepEqual(x.h.replay("a".repeat(16), "S"), { status: 200, body: { outcome: "accepted" } });
	assert.equal(x.h.replay("a".repeat(16), "T"), undefined, "a replay is for its own session only");

	const y = hub();
	y.event({ type: "owner", owner: { sessionId: "G", epoch: "e1" } });
	const sync = y.published.find((p) => (p.payload as { type: string }).type === "sync");
	assert.deepEqual(sync?.options, { audience: "capable", ownerOnly: true }, "a sync goes out once it owns the channel");
	y.h.receive("S", y.list([dialog()], { file: path }));
	await read(y, path);
	const pending = y.h.send("S", y.h.target("S")!, a);
	const out = y.published.at(-1)!;
	assert.deepEqual(out, { payload: { version: 1, type: "answer", to: "B", ...a }, options: { audience: "capable", ownerOnly: true } });
	y.event({ type: "message", fromSessionId: "T", payload: { version: 1, type: "ack", bridgeId: "B", id: "d1", answerId: a.answerId, outcome: "accepted" } });
	y.event({ type: "message", fromSessionId: "S", payload: { version: 1, type: "ack", bridgeId: "B", id: "d1", answerId: a.answerId, outcome: "stale", by: "local" } });
	assert.deepEqual(await pending, { status: 200, body: { outcome: "stale", by: "local" } }, "only the bridge's own session can ack it");

	const z = hub({ owner: "X" });
	z.h.receive("S", z.list([dialog()], { file: path }));
	await read(z, path);
	assert.equal((await z.h.send("S", z.h.target("S")!, a)).status, 503, "not the channel's owner: nothing is sent");
	assert.equal(z.published.filter((p) => (p.payload as { type: string }).type === "answer").length, 0);
});

test("a dialog closed a moment ago tells a late answer who closed it, and a resent winning answer that it won", async () => {
	const x = hub(), path = file([["c1", "robot_hand"]]);
	x.h.receive("S", x.list([], { file: path, closed: [{ id: "d1", by: "local" }, { id: "d2", by: "remote", answerId: "w".repeat(16) }] }));
	const { unit } = await read(x, path);
	assert.deepEqual([unit.mark, unit.pending], ["working", undefined], "closed dialogs do not make it wait");
	assert.deepEqual(x.h.ended("S", "d1", "a".repeat(16)), { status: 200, body: { outcome: "stale", by: "local" } });
	assert.deepEqual(x.h.ended("S", "d2", "w".repeat(16)), { status: 200, body: { outcome: "accepted" } });
	assert.deepEqual(x.h.ended("S", "d2", "a".repeat(16)), { status: 200, body: { outcome: "stale", by: "remote" } });
	assert.equal(x.h.ended("S", "d9", "a".repeat(16)), undefined);
	assert.equal(x.h.ended("T", "d1", "a".repeat(16)), undefined);
});

test("no ack within 5 s is unknown and is not stored, so Check again asks the bridge again; stopping the server ends a wait", async () => {
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const x = hub(), path = file([["c1", "robot_hand"]]);
		x.h.receive("S", x.list([dialog()], { file: path }));
		await read(x, path);
		const a = { id: "d1", answerId: "a".repeat(16), digest: x.h.target("S")!.answer.digest, choice: 0 };
		const pending = x.h.send("S", x.h.target("S")!, a);
		mock.timers.tick(5000);
		assert.equal((await pending).status, 504);
		assert.equal(x.h.replay(a.answerId, "S"), undefined);
		const stopped = x.h.send("S", x.h.target("S")!, a);
		x.h.stop();
		assert.equal((await stopped).status, 504);
		assert.equal(x.h.running, false);
	} finally {
		mock.timers.reset();
	}
	assert.match(guiNamespace("G"), /^straw-boss\/gui\//);
});

test("probe: the hub asks the bridge bound to the unit's pane and file, a bridge with no dialog too, and takes only its matching, well-formed answer", async () => {
	const x = hub(), path = file([]);
	x.h.receive("S", x.list([], { file: path }));
	await read(x, path);
	const asked = x.h.probe("S"), sent = x.published.at(-1)!;
	const probe = sent.payload as { version: number; type: string; to: string; probeId: string };
	assert.deepEqual([probe.version, probe.type, probe.to, sent.options], [1, "probe", "B", { audience: "capable", ownerOnly: true }]);
	const result = (extra: Record<string, unknown>): Record<string, unknown> => ({ version: 1, type: "probe-result", bridgeId: "B", probeId: probe.probeId, editor: "text", ...extra });
	x.h.receive("X", result({ ending: "new" }) as never);
	x.h.receive("S", result({ bridgeId: "B2", ending: "new" }) as never);
	x.h.receive("S", result({ probeId: "other", ending: "new" }) as never);
	x.h.receive("S", result({ ending: "reload" }) as never);
	assert.deepEqual(await asked, { editor: "text", ending: "reload" }, "the answer of another session, bridge, or probe is not this one");
	for (const [bad, why] of [[{ editor: "draft" }, "an unknown class"], [{ ending: "rm" }, "an ending that is not one"], [{ editor: "empty", ending: "quit" }, "an ending on an empty editor"], [{ ending: "reload now" }, "anything beyond the name"]] as const) {
		const again = x.h.probe("S"), id = (x.published.at(-1)!.payload as { probeId: string }).probeId;
		x.h.receive("S", { ...result(bad), probeId: id } as never);
		assert.equal(await again, undefined, why);
	}
});

test("commands: the hub asks the bound bridge for a prefix and takes only its matching, well-formed list", async () => {
	const x = hub(), path = file([]);
	assert.equal(await x.h.commands("S", "re"), undefined, "no bridge at all");
	x.h.receive("S", x.list([], { file: path }));
	await read(x, path);
	const asked = x.h.commands("S", "re"), sent = x.published.at(-1)!, req = sent.payload as { type: string; to: string; reqId: string; prefix: string };
	assert.deepEqual([req.type, req.to, req.prefix, sent.options], ["commands", "B", "re", { audience: "capable", ownerOnly: true }]);
	const result = (commands: unknown, extra: Record<string, unknown> = {}) => ({ version: 1, type: "commands-result", bridgeId: "B", reqId: req.reqId, commands, ...extra }) as never;
	x.h.receive("X", result([{ name: "rm", source: "prompt" }]));
	x.h.receive("S", result([{ name: "rm", source: "prompt" }], { reqId: "other" }));
	x.h.receive("S", result([{ name: "review", source: "prompt", description: "Review it", extra: 1 }]));
	assert.deepEqual(await asked, [{ name: "review", source: "prompt", description: "Review it" }], "only its fields, and only this request's answer");
	for (const [bad, why] of [[[{ name: "a b", source: "prompt" }], "a name with a space"], [[{ name: "a", source: "builtin" }], "an unknown source"], [Array(31).fill({ name: "a", source: "skill" }), "more than 30"], ["x", "not a list"]] as const) {
		const again = x.h.commands("S", ""), id = (x.published.at(-1)!.payload as { reqId: string }).reqId;
		x.h.receive("S", { ...(result(bad) as object), reqId: id } as never);
		assert.equal(await again, undefined, why);
	}
});

test("probe: no bound bridge, another pane or file, a hub that does not own the channel, or a silent bridge is unknown; in its own session the hub asks its bridge in-process", async () => {
	const x = hub(), path = file([]);
	assert.equal(await x.h.probe("S"), undefined, "no bridge at all");
	x.h.receive("S", x.list([], { file: path }));
	await read(x, path, { pane: "wA:p9" });
	const before = x.published.length;
	assert.equal(await x.h.probe("S"), undefined, "intercom places the bridge's session on another pane");
	await read(x, file([]));
	assert.equal(await x.h.probe("S"), undefined, "the unit's file is another one");
	assert.equal(x.published.length, before, "nothing was asked");
	await read(x, path);
	const start = Date.now();
	assert.equal(await x.h.probe("S"), undefined, "a bridge that never answers");
	assert.ok(Date.now() - start >= 950, "after a second");
	const other = hub({ owner: "Z" });
	other.h.receive("S", other.list([], { file: path }));
	await read(other, path);
	assert.equal(await other.h.probe("S"), undefined, "not the channel's owner: nothing can be asked");
	const own = hub({ me: "S", owner: "S" });
	own.h.receive("S", own.list([], { file: path }));
	await read(own, path);
	own.editorIs({ editor: "text", ending: "new" });
	assert.deepEqual(await own.h.probe("S"), { editor: "text", ending: "new" });
	own.editorIs({ editor: "command" });
	assert.deepEqual(await own.h.probe("S"), { editor: "command" });
	own.h.stop();
	assert.equal(await own.h.probe("S"), undefined, "a stopped hub asks nobody");
});

/** A document as pi-herdr-doc-review 0.4.x lists it (its README's "Browser viewers"). */
const doc = (extra: Partial<Doc> = {}): Doc => ({ id: "0b5c7d0e-6a2e-4d43-9a8e-1d2f3a4b5c6d", path: "/work/docs/plan.html", kind: "html", display: "docs/plan.html", reason: "Plan ready", revision: 1, onScreen: true, ...extra });

test("documents: a bridge's list binds to the unit on its pane with its file, each by a capability; paths and owner ids never reach the snapshot", async () => {
	const x = hub(), path = file([]), two = doc({ id: "second", path: "/work/notes.md", kind: "text", display: "notes.md", revision: 3, onScreen: false });
	x.h.receive("S", x.list([], { file: path, documents: [doc(), two] }));
	const { unit } = await read(x, path);
	assert.equal(unit.docs?.length, 2);
	for (const card of unit.docs!) assert.match(card.cap, /^[0-9a-f]{32}$/, "128 random bits");
	assert.notEqual(unit.docs![0]!.cap, unit.docs![1]!.cap);
	assert.deepEqual(unit.docs!.map((card) => ({ ...card, cap: undefined })), [{ cap: undefined, display: "docs/plan.html", kind: "html", reason: "Plan ready", revision: 1, onScreen: true }, { cap: undefined, display: "notes.md", kind: "text", reason: "Plan ready", revision: 3, onScreen: false }]);
	assert.ok(!JSON.stringify(unit).includes("/work") && !JSON.stringify(unit).includes(doc().id), "no path or owner id in the snapshot");
	assert.deepEqual(x.h.doc(unit.docs![0]!.cap), { key: "S", doc: doc() }, "the server finds the document, path and all, by its capability");
	assert.equal(x.h.doc("f".repeat(32)), undefined, "an unknown capability finds nothing");
	for (const [what, opts] of [["another pane", { pane: "wA:p2" }], ["another session on the pane", { from: "T" }]] as const) {
		const other = await read(x, path, opts);
		assert.equal(other.unit.docs, undefined, what);
		assert.equal(x.h.doc(unit.docs![0]!.cap), undefined, `${what}: its capability no longer serves`);
	}
	assert.equal((await read(x, file([]))).unit.docs, undefined, "a unit with another file");
});

test("documents: capabilities stay with their document across readings and revisions, change with the bridge, and go when the list drops it, the session leaves, or the server stops", async () => {
	const x = hub(), path = file([]);
	x.h.receive("S", x.list([], { file: path, documents: [doc()] }));
	const cap = (await read(x, path)).unit.docs![0]!.cap;
	x.h.receive("S", x.list([], { file: path, documents: [doc({ revision: 2, onScreen: false })] }));
	const again = (await read(x, path)).unit.docs![0]!;
	assert.deepEqual([again.cap, again.revision, again.onScreen], [cap, 2, false], "the revision passes through, the capability stays");
	assert.equal(x.h.doc(cap)?.doc.revision, 2);
	x.h.receive("S", x.list([], { file: path, documents: [] }));
	assert.equal(x.h.doc(cap), undefined, "a list without it serves it no more, before the next reading");
	assert.equal((await read(x, path)).unit.docs, undefined);
	x.h.receive("S", x.list([], { file: path, documents: [doc()] }));
	const fresh = (await read(x, path)).unit.docs![0]!.cap;
	assert.notEqual(fresh, cap, "listed again: a new capability");
	x.h.receive("S", x.list([], { file: path, documents: [doc()], bridgeId: "B2" }));
	assert.notEqual((await read(x, path)).unit.docs![0]!.cap, fresh, "another bridge (pi restarted on the pane): another capability");
	x.event({ type: "session_left", sessionId: "S" });
	assert.equal((await read(x, path)).unit.docs, undefined, "the session left");
	x.h.receive("S", x.list([], { file: path, documents: [doc()], bridgeId: "B2" }));
	const before = (await read(x, path)).unit.docs![0]!.cap;
	x.h.stop();
	x.h.start(() => {});
	x.h.receive("S", x.list([], { file: path, documents: [doc()], bridgeId: "B2" }));
	const after = (await read(x, path)).unit.docs![0]!.cap;
	assert.notEqual(after, before, "a new server mints new capabilities");
	assert.equal(x.h.doc(before), undefined);
});

test("documents: a list that is not contract v1 drops only the documents (as if cut), the dialogs stay; a list cut for size says so on the unit", async () => {
	const x = hub(), path = file([["c1", "robot_hand"]]);
	for (const bad of [[doc({ path: "relative/plan.html" })], [doc({ kind: "pdf" as never })], [doc({ revision: 0 })], [doc(), doc()], Array.from({ length: 33 }, (_, i) => doc({ id: `d${i}` }))]) {
		x.h.receive("S", x.list([dialog()], { file: path, documents: bad }));
		const { unit } = await read(x, path);
		assert.deepEqual([unit.docs, unit.docsCut, unit.pending?.answer?.dialog], [undefined, true, "d1"], JSON.stringify(bad).slice(0, 80));
	}
	x.h.receive("S", x.list([], { file: path, documents: [], docsCut: true }));
	const { unit } = await read(x, path);
	assert.deepEqual([unit.docs, unit.docsCut], [undefined, true]);
});

test("documents: a form answer goes to the bound bridge (ownerOnly over the channel, or in-process), and only its own result counts, within 5 s", async () => {
	const x = hub(), path = file([]);
	x.h.receive("S", x.list([], { file: path, documents: [doc()] }));
	const cap = (await read(x, path)).unit.docs![0]!.cap, answerId = "n".repeat(32), fields: [string, string][] = [["choice", "b"]];
	const sent = x.h.form(cap, answerId, fields), out = x.published.at(-1)!;
	assert.deepEqual(out, { payload: { version: 1, type: "form", to: "B", id: doc().id, answerId, fields }, options: { audience: "capable", ownerOnly: true } });
	const result = (extra: Record<string, unknown> = {}) => ({ version: 1, type: "form-result", bridgeId: "B", id: doc().id, answerId, accepted: true, ...extra }) as never;
	x.h.receive("T", result());
	x.h.receive("S", result({ bridgeId: "B2" }));
	x.h.receive("S", result({ answerId: "m".repeat(32) }));
	x.h.receive("S", result({ id: "other" }));
	x.h.receive("S", result({ accepted: false, reason: "empty" }));
	assert.deepEqual(await sent, { accepted: false, reason: "empty" }, "another session's, bridge's, answer's, or document's result is not this one");
	assert.deepEqual(await x.h.form("f".repeat(32), answerId, fields), { accepted: false, reason: "closed" }, "an unknown capability sends nothing");
	const count = x.published.length;
	for (const [id, f] of [["short", fields], ["n".repeat(65), fields], [answerId, [["a", 1]]]] as const) assert.deepEqual(await x.h.form(cap, id, f as never), { accepted: false, reason: "invalid" }, `${id.slice(0, 8)} ${JSON.stringify(f)}`);
	assert.equal(x.published.length, count, "a malformed answer is refused here, not left to time out");
	mock.timers.enable({ apis: ["setTimeout"] });
	try {
		const silent = x.h.form(cap, "s".repeat(32), fields);
		mock.timers.tick(4999);
		await Promise.resolve();
		mock.timers.tick(1);
		assert.equal(await silent, undefined, "no result within 5 s: not confirmed");
	} finally {
		mock.timers.reset();
	}
	const own = hub({ me: "S", owner: "S" });
	own.h.receive("S", own.list([], { file: path, documents: [doc()] }));
	const mine = (await read(own, path)).unit.docs![0]!.cap;
	own.formWith((m) => ({ version: 1, type: "form-result", bridgeId: "B", id: m.id, answerId: m.answerId, accepted: true }));
	assert.deepEqual(await own.h.form(mine, answerId, fields), { accepted: true }, "in its own session the hub hands it to its bridge");
	assert.deepEqual(own.forms.map((m) => [m.to, m.id, m.answerId]), [["B", doc().id, answerId]]);
	const other = hub({ owner: "Z" });
	other.h.receive("S", other.list([], { file: path, documents: [doc()] }));
	assert.equal(await other.h.form((await read(other, path)).unit.docs![0]!.cap, answerId, fields), undefined, "not the channel's owner: nothing can be sent");
});

test("documents: a tower carries its documents too, in the snapshot's JSON", async () => {
	const x = hub(), path = file([]);
	x.h.receive("S", x.list([], { file: path, documents: [doc()] }));
	const refs = new Map<string, Ref>([["S", { key: "S", base: "wA", name: "tower", role: "tower", file: path, pane: "wA:p1" }]]);
	const out: Net = { bases: [{ id: "wA", label: "Alpha", mark: "idle", head: true, tower: { name: "tower", mark: "idle", key: "S", control: true }, outposts: [], outside: [], tabs: [] }] };
	await withPending(out, (key) => refs.get(key)?.file, x.h.relayed([{ id: "S", herdrLocation: { status: "current", paneId: "wA:p1" } }], refs));
	const tower = JSON.parse(JSON.stringify(out)).bases[0].tower;
	assert.deepEqual(tower.docs.map((d: { display: string }) => d.display), ["docs/plan.html"]);
	assert.equal(tower.docsCut, undefined);
});

const SECRET = { label: "Deploy token", instructions: ["Open the link.", "Create a token."], url: "https://example.com/tokens", destination: ".env.local" };
const KEYS = newKeys();
const secretDialog = (extra: Partial<Dialog> = {}): Dialog => ({ owner: "robot-hand-secret", id: "s1", toolCallId: "c1", digest: secretDigest(SECRET), secret: SECRET, key: KEYS.pub, ...extra });

test("secret_drop: its masked dialog is answerable when it is the one dialog, bound to the one open secret_drop call, with a matching digest", async () => {
	const x = hub(), one = file([["c1", "secret_drop"]]), mixed = file([["c1", "bash"], ["c2", "secret_drop"]]);
	x.h.receive("S", x.list([secretDialog()], { file: one }));
	const { unit } = await read(x, one);
	assert.deepEqual(unit.pending, { callId: "c1", tool: "secret_drop", answer: { dialog: "s1", digest: secretDigest(SECRET), secret: SECRET } });
	assert.deepEqual(x.h.target("S"), { from: "S", bridgeId: "B", answer: unit.pending!.answer, key: KEYS.pub });
	assert.deepEqual(JSON.parse(JSON.stringify(unit.pending)).answer.secret, SECRET, "the snapshot carries what it asks for, never a value");
	assert.equal(JSON.stringify(unit.pending).includes(KEYS.pub), false, "nor the key: it stays with the target the server sends to");
	x.h.receive("S", x.list([secretDialog({ toolCallId: "c2" })], { file: mixed }));
	assert.deepEqual((await read(x, mixed)).unit.pending, { callId: "c2", tool: "secret_drop", answer: { dialog: "s1", digest: secretDigest(SECRET), secret: SECRET } }, "among several open calls, the one it names");
});

test("secret_drop: every other case stays in the terminal with its reason, and the page gets no way to answer", async () => {
	const x = hub(), one = file([["c1", "secret_drop"]]), two = file([["c1", "secret_drop"], ["c2", "secret_drop"]]), hand = file([["c1", "robot_hand"], ["c2", "secret_drop"]]);
	const why = async (dialogs: Dialog[], path = one) => {
		x.h.receive("S", x.list(dialogs, { file: path }));
		const { unit } = await read(x, path);
		assert.equal(unit.pending?.answer, undefined);
		assert.equal(x.h.target("S"), undefined);
		return unit.pending?.why;
	};
	assert.equal(await why([secretDialog({ digest: "0".repeat(64) })]), "The question here differs from the one in the terminal; answer it there.");
	assert.equal(await why([secretDialog({ secret: { ...SECRET, destination: "elsewhere" } })]), "The question here differs from the one in the terminal; answer it there.", "content the digest does not cover");
	assert.equal(await why([secretDialog(), secretDialog({ id: "s2" })]), "It waits for a secret.", "two dialogs");
	assert.equal(await why([secretDialog(), dialog()]), "It waits for a secret.", "a secret beside a selector");
	assert.equal(await why([secretDialog()], two), "It waits on more than one dialog.", "two secret_drop calls: which one is it?");
	assert.equal(await why([secretDialog({ toolCallId: "c1" })], hand), "It waits for a secret.", "it names a call that is not a secret_drop");
	assert.equal(await why([secretDialog({ toolCallId: "c9" })]), "It waits for a secret.", "it names a call that is not open");
	assert.equal(await why([dialog()], hand), "It waits for a secret.", "a selector beside a secret_drop");
	assert.equal(await why([gate({ toolCallId: "c2" })], hand), "It waits for a secret.", "a gate beside a secret_drop");
	assert.match(String(await why([{ ...secretDialog({ big: true }), secret: undefined }], one)), /waits for a secret/, "too long to relay: terminal only");
	x.h.receive("S", x.list([secretDialog()], { file: one }));
	assert.equal((await read(x, undefined)).unit.pending, undefined, "no readable session file binds nothing");
	x.h.receive("S", x.list([secretDialog({ busy: true })], { file: one }));
	const busy = (await read(x, one)).unit.pending;
	assert.deepEqual([busy?.answer, busy?.why], [undefined, "An answer is on its way; check the terminal."]);
	assert.equal(x.h.target("S")?.answer.dialog, "s1", "still reachable, so an answer sent twice hears busy or its replay from the bridge");
});

const NOKEY = "It waits for a secret; its session cannot protect one on the way here, so enter it in the terminal.";

test("secret_drop: a dialog without a valid public key stays in the terminal, whatever else matches", async () => {
	const x = hub(), one = file([["c1", "secret_drop"]]);
	for (const [i, [what, key]] of ([["none (an older bridge)", undefined], ["an empty one", ""], ["a short one", "AAAA"], ["one with other characters", `${KEYS.pub.slice(1)}=`], ["a number", 5 as never], ["an object", {} as never]] as const).entries()) {
		x.h.receive("S", x.list([secretDialog({ id: `k${i}`, key })], { file: one })); // each is a new dialog: a first key is what is judged
		const { unit } = await read(x, one);
		assert.deepEqual([unit.pending?.answer, unit.pending?.why, x.h.target("S")], [undefined, NOKEY, undefined], what);
	}
	x.h.receive("S", x.list([secretDialog({ id: "ok" })], { file: one }));
	assert.equal((await read(x, one)).unit.pending?.answer?.dialog, "ok", "the same file with a good key is answerable");
});

test("secret_drop: a key that changes for the same dialog is never trusted again; a later key for a dialog first seen without one is not either; a new dialog starts afresh", async () => {
	const x = hub(), one = file([["c1", "secret_drop"]]), other = newKeys().pub;
	const why = async (d: Dialog) => (x.h.receive("S", x.list([d], { file: one })), (await read(x, one)).unit.pending?.why);
	assert.equal(await why(secretDialog()), undefined, "the first key is taken");
	assert.equal(await why(secretDialog({ key: other })), NOKEY, "another key for the same dialog: terminal only");
	assert.equal(await why(secretDialog()), NOKEY, "and the first key coming back does not undo it");
	assert.equal(await why(secretDialog({ id: "s2" })), undefined, "another dialog of the same bridge is its own");
	assert.equal(await why(secretDialog({ id: "s2", key: undefined })), NOKEY, "a key that disappears");
	x.h.receive("S", x.list([], { file: one }));
	assert.equal(await why(secretDialog({ key: other })), undefined, "a dialog that left the list and came again is a new one");
	x.h.receive("S", x.list([secretDialog({ id: "s3", key: undefined })], { file: one }));
	assert.equal(await why(secretDialog({ id: "s3" })), NOKEY, "no key first, a key later");
});

test("a secret's answer goes to its bridge sealed to its dialog's key; no plain value is delivered, published, kept, or returned, and only that dialog's private key opens it", async () => {
	const x = hub({ me: "S" }), path = file([["c1", "secret_drop"]]), value = "tok-hub-secret-value";
	x.h.receive("S", x.list([secretDialog()], { file: path }));
	await read(x, path);
	const t = x.h.target("S")!;
	x.answerWith((m) => ({ version: 1, type: "ack", bridgeId: m.to, id: m.id, answerId: m.answerId, outcome: "accepted" }));
	const sent = await x.h.send("S", t, { id: "s1", answerId: "a".repeat(16), digest: t.answer.digest, value });
	assert.deepEqual(sent, { status: 200, body: { outcome: "accepted" } });
	assert.deepEqual(x.delivered.map((m) => [m.id, "value" in m, keyOk(m.sealed?.epk)]), [["s1", false, true]], "the owner's bridge is handed a sealed value, never a plain one");
	assert.equal(open(x.delivered[0]!.sealed, KEYS.priv, KEYS.pub, { id: "s1", digest: t.answer.digest, answerId: "a".repeat(16), bridgeId: "B" }), value, "its dialog's key opens it");
	assert.equal(open(x.delivered[0]!.sealed, newKeys().priv, KEYS.pub, { id: "s1", digest: t.answer.digest, answerId: "a".repeat(16), bridgeId: "B" }), undefined, "no other key does");
	assert.equal(JSON.stringify([sent, x.h.replay("a".repeat(16), "S"), x.h.ended("S", "s1", "a".repeat(16)), x.published, x.changes, x.delivered]).includes(value), false, "no outcome, replay, published or delivered message holds the value");
});

test("a secret answered through the channel publishes only the sealed value", async () => {
	const x = hub(), path = file([["c1", "secret_drop"]]), value = "tok-on-the-wire";
	x.h.receive("S", x.list([secretDialog()], { file: path }));
	await read(x, path);
	const t = x.h.target("S")!, pending = x.h.send("S", t, { id: "s1", answerId: "a".repeat(16), digest: t.answer.digest, value });
	x.h.receive("S", { version: 1, type: "ack", bridgeId: "B", id: "s1", answerId: "a".repeat(16), outcome: "accepted" });
	assert.deepEqual(await pending, { status: 200, body: { outcome: "accepted" } });
	const msg = x.published.map((p) => p.payload as { type: string; to: string; value?: string; sealed?: { epk: string } }).find((m) => m.type === "answer")!;
	assert.deepEqual([msg.to, "value" in msg, keyOk(msg.sealed?.epk)], ["B", false, true]);
	assert.equal(JSON.stringify(x.published).includes(value), false);
	assert.equal(x.delivered.length, 0, "not the in-process path");
});

test("a secret with no key at send time is not sent at all, and the value is not echoed", async () => {
	const x = hub({ me: "S" }), path = file([["c1", "secret_drop"]]), value = "tok-never-leaves";
	x.h.receive("S", x.list([secretDialog()], { file: path }));
	await read(x, path);
	x.answerWith((m) => ({ version: 1, type: "ack", bridgeId: m.to, id: m.id, answerId: m.answerId, outcome: "accepted" }));
	const t = x.h.target("S")!, sent = await x.h.send("S", t, { id: "s1", answerId: "a".repeat(16), digest: t.answer.digest, value });
	for (const bad of [{ ...t, key: undefined }, { ...t, key: "AAAA" }]) {
		const r = await x.h.send("S", bad, { id: "s1", answerId: "b".repeat(16), digest: t.answer.digest, value });
		assert.deepEqual([r.status, r.body.outcome], [409, "unsent"]);
		assert.equal(JSON.stringify(r).includes(value), false);
	}
	assert.equal(x.delivered.length, 1, "only the first, sealed send reached a bridge");
	assert.equal(sent.status, 200);
	assert.equal(JSON.stringify([x.delivered, x.published]).includes(value), false);
});
