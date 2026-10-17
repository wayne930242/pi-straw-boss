import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withPending } from "../src/ask.ts";
import { type Ack, type AnswerMessage, type Dialogs, guiNamespace, REGISTER } from "../src/bridge.ts";
import { createHub } from "../src/dialogs.ts";
import { canonical } from "../src/history.ts";
import type { Net, Ref } from "../src/net.ts";
import { type Dialog, selectDigest } from "../src/owners.ts";
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
	let reg: { onEvent(e: Record<string, unknown>): void } | undefined, reply: ((a: AnswerMessage) => Ack | undefined) | undefined;
	const events = { emit: (ch: string, r: never) => ch === REGISTER && ((reg = r), (r as { onReady(c: unknown): void }).onReady({ snapshot: () => ({ connected: true, owner: { sessionId: owner, epoch: "e1" } }), publish: (payload: unknown, options: unknown) => void published.push({ payload, options }) })), on: () => () => {} };
	const local = { deliver: (m: AnswerMessage, r: (a: Ack) => void) => { delivered.push(m); const a = reply?.(m); if (a) r(a); }, sync: () => {} };
	const h = createHub({ events } as unknown as ExtensionAPI, me, local);
	h.start(() => changes.push(1));
	const list = (dialogs: Dialog[], extra: Partial<Dialogs> = {}): Dialogs => ({ version: 1, type: "dialogs", bridgeId: "B", pane: "wA:p1", file: null, dialogs, closed: [], ...extra });
	return { h, published, delivered, changes, list, event: (e: Record<string, unknown>) => reg?.onEvent(e), answerWith: (f: typeof reply) => (reply = f) };
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
	assert.match(String(await why([dialog()], two)), /more than one dialog/, "the file holds two open calls");
	assert.match(String(await why([dialog({ digest: "0".repeat(64) })])), /differs from the one in the terminal/);
	assert.equal(await why([dialog()], secret), "It waits for a secret.", "a secret_drop is never answerable, whatever a bridge says");
	x.h.receive("S", x.list([dialog()], { file: robot }));
	assert.equal((await read(x, undefined)).unit.pending, undefined, "a unit without a readable session file binds no list (it cannot be answered or typed into)");
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
