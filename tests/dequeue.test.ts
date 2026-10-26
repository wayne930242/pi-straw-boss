import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guiNamespace, REGISTER, startBridge, type ToHub } from "../src/bridge.ts";
import type { Hub, Target } from "../src/dialogs.ts";
import { startGui, type Gui } from "../src/gui.ts";
import type { Found } from "../src/net.ts";
import { checkPull, MAX_PULL, type Pull, pulled } from "../src/pull.ts";

// Taking the queue back (pull.ts): the server presses pi's Alt+Up between a `begin` and a `finish` at the bridge, and the page gets only the
// pulled messages; what pi's editor held before stays there.

const scratch = mkdtempSync(join(tmpdir(), "psb-dequeue-test-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

test("pulled: pi puts the queued messages in front of a non-blank draft with a blank line; the draft is cut off, and anything else is refused", () => {
	assert.deepEqual(pulled("", "one\n\ntwo"), { text: "one\n\ntwo" });
	assert.deepEqual(pulled("my draft", "one\n\ntwo\n\nmy draft"), { text: "one\n\ntwo" });
	assert.deepEqual(pulled("   ", "one"), { text: "one" }, "a blank draft is dropped by pi");
	assert.deepEqual(pulled("draft", "draft"), { empty: true }, "nothing was pulled");
	assert.deepEqual(pulled("", ""), { empty: true });
	assert.deepEqual(pulled("draft", "other"), { reason: "changed" });
	assert.deepEqual(pulled("draft", "\n\ndraft"), { reason: "changed" }, "no messages in front");
	assert.deepEqual(pulled("draft", "one\n\nsomething else"), { reason: "changed" });
});

test("checkPull takes only the fields of the protocol, in shape", () => {
	assert.deepEqual(checkPull({ pending: true, ticket: "t", extra: 1 }), { pending: true, ticket: "t" });
	assert.deepEqual(checkPull({ text: "a" }), { text: "a" });
	assert.deepEqual(checkPull({ empty: true }), { empty: true });
	assert.deepEqual(checkPull({ reason: "not_taken" }), { reason: "not_taken" });
	for (const bad of [undefined, { pending: "yes" }, { ticket: 3 }, { ticket: "x".repeat(65) }, { text: 3 }, { text: "x".repeat(MAX_PULL + 1) }, { empty: false }, { reason: "whatever" }]) assert.equal(checkPull(bad as never), undefined, JSON.stringify(bad));
});

/** One session's bridge with an editor and a queue the test drives; `press` is what pi does on Alt+Up. */
function session() {
	const dir = mkdtempSync(join(tmpdir(), "psb-dequeue-bridge-"));
	writeFileSync(join(dir, "gui.json"), JSON.stringify({ pid: process.pid, port: 1, token: "t", owner: "x", ownerSession: "G" }));
	const handlers = new Map<string, ((e: unknown, ctx: unknown) => void)[]>(), regs: { namespace: string; onEvent(e: Record<string, unknown>): void }[] = [], published: ToHub[] = [];
	const bus = new Map<string, ((d: unknown) => void)[]>();
	const events = { on: (ch: string, h: (d: unknown) => void) => (bus.set(ch, [...(bus.get(ch) ?? []), h]), () => {}), emit: (ch: string, d: unknown) => (bus.get(ch) ?? []).forEach((h) => h(d)) };
	events.on(REGISTER, (raw) => {
		const r = raw as (typeof regs)[0] & { onReady(c: unknown): void };
		regs.push(r);
		r.onReady({ snapshot: () => ({ connected: true, owner: { sessionId: "G", epoch: "e1" } }), publish: (p: ToHub) => void published.push(p) });
	});
	const pi = { events, getCommands: () => [], on: (t: string, h: (e: unknown, c: unknown) => void) => handlers.set(t, [...(handlers.get(t) ?? []), h]) } as unknown as ExtensionAPI;
	const bridge = startBridge(pi, { env: { HERDR_PANE_ID: "wA:p1", PI_INTERCOM_SESSION_ID: "S" }, dir, local: () => undefined, close: () => undefined });
	const st = { editor: "", queued: 0, failSet: false, hasUI: true };
	const ctx = {
		get hasUI() { return st.hasUI; },
		ui: { notify() {}, getEditorText: () => st.editor, setEditorText: (t: string) => { if (st.failSet) throw new Error("no"); st.editor = t; } },
		sessionManager: { getSessionFile: () => "/s/2026_S.jsonl" },
		hasPendingMessages: () => st.queued > 0,
	};
	(handlers.get("session_start") ?? []).forEach((h) => h({ type: "session_start" }, ctx));
	const to = (published.find((p) => p.type === "dialogs") as { bridgeId: string }).bridgeId;
	/** pi's Alt+Up: the queue clears and the editor gets the messages in front of its text. */
	const press = (messages: string[]) => { st.queued = 0; st.editor = [messages.join("\n\n"), st.editor].filter((t) => t.trim()).join("\n\n"); };
	const message = (payload: Record<string, unknown>, from = "G") => regs.find((r) => r.namespace === guiNamespace("G"))!.onEvent({ type: "message", fromSessionId: from, owner: { sessionId: "G", epoch: "e1" }, payload });
	const fire = (type: string, e: Record<string, unknown> = {}) => (handlers.get(type) ?? []).forEach((h) => h({ type, ...e }, ctx));
	return { dir, st, bridge, press, to, published, message, fire, results: () => published.filter((p) => p.type === "pull-result") as unknown as ({ reqId: string } & Pull)[] };
}
const after_ = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("pull: begin says whether anything waits and remembers the editor; finish hands over the messages, leaves the draft in the editor, and never carries the draft", async () => {
	const s = session();
	s.st.editor = "private draft sk-123";
	assert.deepEqual(await s.bridge.pull("begin"), { pending: false }, "nothing queued: no key should go");
	s.st.queued = 2;
	const begun = await s.bridge.pull("begin");
	assert.equal(begun.pending, true);
	s.press(["steer me", "then follow"]);
	const done = await s.bridge.pull("finish", begun.ticket);
	assert.deepEqual(done, { text: "steer me\n\nthen follow" });
	assert.equal(s.st.editor, "private draft sk-123", "the draft stays, the messages are gone from pi's editor");
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "stale" }, "a ticket is spent once");
});

test("pull: the queue the bridge mirrors is gone from what it relays as soon as pi has taken it back", async () => {
	const s = session();
	s.st.queued = 1;
	s.fire("input", { text: "queued one", streamingBehavior: "steer" });
	const lastQueue = () => (s.published.filter((p) => p.type === "dialogs").at(-1) as { queued?: unknown[] }).queued;
	assert.equal(lastQueue()?.length, 1);
	const begun = await s.bridge.pull("begin");
	s.press(["queued one"]);
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { text: "queued one" });
	assert.equal(lastQueue(), undefined, "no waiting for the next 2 s check");
});

test("pull: the queue delivered between begin and the key gives empty, and nothing changes in the editor", async () => {
	const s = session();
	s.st.editor = "draft";
	s.st.queued = 1;
	const begun = await s.bridge.pull("begin");
	s.st.queued = 0; // delivered meanwhile; pi's Alt+Up then restores nothing
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { empty: true });
	assert.equal(s.st.editor, "draft");
});

test("pull: a queue pi did not take back, an editor that changed, a text too long, and an editor that will not clear leave the editor as pi has it", async () => {
	const s = session();
	s.st.queued = 1;
	let begun = await s.bridge.pull("begin");
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "not_taken" }, "the key did nothing: the queue is still there");
	s.st.editor = "draft";
	s.st.queued = 1;
	begun = await s.bridge.pull("begin");
	s.press(["a"]);
	s.st.editor = "a\n\ndraft, edited in the terminal meanwhile";
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "changed" });
	assert.equal(s.st.editor, "a\n\ndraft, edited in the terminal meanwhile");
	s.st.editor = "";
	s.st.queued = 1;
	begun = await s.bridge.pull("begin");
	s.press(["x".repeat(MAX_PULL + 10)]);
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "too_large" });
	assert.equal(s.st.editor.length, MAX_PULL + 10, "it stays in the terminal's editor");
	s.st.editor = "";
	s.st.queued = 1;
	begun = await s.bridge.pull("begin");
	s.press(["keep"]);
	s.st.failSet = true;
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "not_cleared" }, "never handed over while it would stay in the editor too");
	assert.equal(s.st.editor, "keep");
});

test("pull: a session without a UI has no editor; an old ticket is stale", async () => {
	const s = session();
	s.st.hasUI = false;
	assert.deepEqual(await s.bridge.pull("begin"), { reason: "no_editor" });
	s.st.hasUI = true;
	s.st.queued = 1;
	const begun = await s.bridge.pull("begin");
	assert.deepEqual(await s.bridge.pull("finish", "other"), { reason: "stale" });
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "not_taken" }, "a wrong ticket spends nothing");
});

test("pull over the channel: only G for this bridge is answered, with the result under the request's id", async () => {
	const s = session();
	s.st.queued = 1;
	s.message({ version: 1, type: "pull", to: s.to, reqId: "r1", step: "begin" });
	await after_(10);
	const [first] = s.results();
	assert.equal(first!.reqId, "r1");
	assert.equal(first!.pending, true);
	s.press(["hi"]);
	s.message({ version: 1, type: "pull", to: s.to, reqId: "r2", step: "finish", ticket: first!.ticket });
	await after_(20);
	assert.deepEqual(s.results().at(-1), { version: 1, type: "pull-result", bridgeId: s.to, reqId: "r2", text: "hi" });
	const n = s.results().length;
	s.message({ version: 1, type: "pull", to: s.to, reqId: "x", step: "begin" }, "X");
	s.message({ version: 1, type: "pull", to: "someone", reqId: "y", step: "begin" });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "z".repeat(65), step: "begin" });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "w", step: "finish" });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "v", step: "nope" });
	await after_(20);
	assert.equal(s.results().length, n);
});

// ---- the server's dequeue action ----

const FILE = "/s/2026_sess-1.jsonl";
function send(gui: Gui, path: string, body: unknown = {}) {
	const data = JSON.stringify(body);
	return new Promise<{ status: number; body: { text?: string; empty?: boolean; error?: string; reason?: string } }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/api/${path}`, method: "POST", agent: false, headers: { host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf, "content-length": String(Buffer.byteLength(data)) } }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
		});
		req.on("error", reject).end(data);
	});
}
async function served({ pull, status = "working", dialog = false, secret = false }: { pull: (step: string, ticket?: string) => Pull | undefined | Promise<Pull | undefined>; status?: string; dialog?: boolean; secret?: boolean }) {
	const calls: [string, Record<string, unknown>][] = [], steps: [string, string | undefined][] = [], state = { pane_id: "wA:p1", agent: "pi", agent_status: status, agent_session: { value: FILE } };
	const call = async (method: string, params: Record<string, unknown>) => (calls.push([method, params]), steps.push(["call:" + method, undefined]), method === "pane.get" ? { pane: state } : {});
	const target = { from: "S", bridgeId: "B", answer: { dialog: "d1", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "A" }] } } } as Target;
	const hub = { running: true, me: "G", start() {}, stop() {}, receive() {}, relayed: () => ({ dialogsOf: () => undefined, merge: () => ({ callId: "", tool: "" }) }), replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: {} }), target: () => (dialog ? target : undefined), probe: async () => ({ editor: "empty" as const }), pull: async (_k: string, step: string, ticket?: string) => (steps.push([step, ticket]), pull(step, ticket)) };
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file: FILE, pane: "wA:p1", live: true } : undefined);
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, hub: hub as unknown as Hub, dir: join(scratch, "bundle"), pollMs: 50, ...(secret ? { secret: undefined } : {}) } as never);
	running.push(gui);
	return { gui, calls, steps, state, keys: () => calls.filter(([m]) => m === "pane.send_input").map(([, p]) => p.keys) };
}

test("dequeue: begin, then Alt+Up on the pane, then finish with the ticket; the page gets the pulled text", async () => {
	const x = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T1" } : { text: "one\n\ntwo" }) });
	assert.deepEqual(await send(x.gui, "sessions/sess-1/dequeue"), { status: 200, body: { text: "one\n\ntwo" } });
	assert.deepEqual(x.steps, [["call:pane.get", undefined], ["begin", undefined], ["call:pane.send_input", undefined], ["finish", "T1"]].filter(Boolean), "begin before the key, finish after it");
	assert.deepEqual(x.keys(), [["alt+up"]]);
});

test("dequeue: an empty queue sends no key; one delivered between begin and the key says empty", async () => {
	const none = await served({ pull: () => ({ pending: false }) });
	assert.deepEqual(await send(none.gui, "sessions/sess-1/dequeue"), { status: 200, body: { empty: true } });
	assert.deepEqual(none.keys(), [], "no Alt+Up when nothing waits");
	const late = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : { empty: true }) });
	assert.deepEqual(await send(late.gui, "sessions/sess-1/dequeue"), { status: 200, body: { empty: true } });
	assert.deepEqual(late.keys(), [["alt+up"]]);
});

test("dequeue: refusals keep the editor and the key from going when they come before it, and say why after it", async () => {
	for (const [why, status] of [["no_editor", 409], ["stale", 409]] as const) {
		const x = await served({ pull: () => ({ reason: why }) });
		const r = await send(x.gui, "sessions/sess-1/dequeue");
		assert.deepEqual([r.status, r.body.error], [status, why]);
		assert.deepEqual(x.keys(), []);
	}
	const silent = await served({ pull: () => undefined });
	assert.equal((await send(silent.gui, "sessions/sess-1/dequeue")).status, 504, "a bridge that never answers");
	assert.deepEqual(silent.keys(), []);
	const stuck = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : { reason: "not_taken" }) });
	const r = await send(stuck.gui, "sessions/sess-1/dequeue");
	assert.deepEqual([r.status, r.body.error], [409, "not_taken"]);
	assert.match(r.body.reason!, /Alt\+Up/);
	const lost = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : undefined) });
	assert.equal((await send(lost.gui, "sessions/sess-1/dequeue")).status, 504, "unsure: pi may have taken the messages");
	const big = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : { reason: "too_large" }) });
	assert.equal((await send(big.gui, "sessions/sess-1/dequeue")).body.error, "too_large");
});

test("dequeue: nothing is asked or pressed while the session waits on a dialog or a question the page answers", async () => {
	const waiting = await served({ pull: () => ({ pending: true, ticket: "T" }), status: "blocked" });
	assert.equal((await send(waiting.gui, "sessions/sess-1/dequeue")).body.error, "blocked");
	assert.deepEqual(waiting.steps.map(([s]) => s), ["call:pane.get"], "the bridge was not asked and no key went");
	const asking = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : { text: "x" }), dialog: true });
	assert.equal((await send(asking.gui, "sessions/sess-1/dequeue")).body.error, "blocked", "like any key but Escape");
	assert.deepEqual(asking.keys(), []);
});

test("dequeue: one at a time per session, the session and the pane are checked as for typing, and the body is not read", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const x = await served({ pull: async (step) => (step === "begin" ? (await gate, { pending: true, ticket: "T" }) : { text: "t" }) });
	const first = send(x.gui, "sessions/sess-1/dequeue");
	await after_(30);
	assert.equal((await send(x.gui, "sessions/sess-1/dequeue")).status, 429);
	release();
	assert.equal((await first).status, 200);
	assert.equal((await send(x.gui, "sessions/nope/dequeue")).status, 404);
	x.state.agent = "zsh";
	assert.equal((await send(x.gui, "sessions/sess-1/dequeue")).body.error, "not_pi");
});
