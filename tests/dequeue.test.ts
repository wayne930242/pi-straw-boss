import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { guiNamespace, REGISTER, startBridge, type ToHub } from "../src/bridge.ts";
import type { Hub, Target } from "../src/dialogs.ts";
import { startGui, type Gui } from "../src/gui.ts";
import type { Found } from "../src/net.ts";
import { defaultDequeue, dequeueKey, keyLabel, validKeyId, windowsKeys } from "../src/dequeuekey.ts";
import { checkPull, joined, MAX_PULL, type Pull, pulled } from "../src/pull.ts";

// Taking the queue back (pull.ts): the server presses pi's Alt+Up between a `begin` and a `finish` at the bridge, and the page gets only the
// pulled messages; what pi's editor held before stays there.

const scratch = mkdtempSync(join(tmpdir(), "psb-dequeue-test-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [], bridgeDirs: string[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	for (const dir of [scratch, ...bridgeDirs]) rmSync(dir, { recursive: true, force: true });
});

test("pulled: pi puts the queued messages in front of a non-blank draft with a blank line; the draft is cut off, and anything but exactly the mirror's messages in front of it is refused", () => {
	assert.deepEqual(pulled("", "one\n\ntwo", "one\n\ntwo"), { text: "one\n\ntwo" });
	assert.deepEqual(pulled("my draft", "one\n\ntwo\n\nmy draft", "one\n\ntwo"), { text: "one\n\ntwo" });
	assert.deepEqual(pulled("   ", "one", "one"), { text: "one" }, "a blank draft is dropped by pi");
	assert.deepEqual(pulled("draft", "draft", "one"), { empty: true }, "nothing was pulled");
	assert.deepEqual(pulled("", "", "one"), { empty: true });
	assert.deepEqual(pulled("draft", "other", "one"), { reason: "changed" });
	assert.deepEqual(pulled("draft", "\n\ndraft", "one"), { reason: "changed" }, "no messages in front");
	assert.deepEqual(pulled("draft", "one\n\nsomething else", "one"), { reason: "changed" });
	assert.deepEqual(pulled("draft", "one\n\ndraft", ""), { reason: "changed" }, "a queue the mirror does not know is not handed over");
});

test("pulled (R-F003): with a blank draft at begin, what was typed in the terminal before the key is not taken for a queued message", () => {
	assert.deepEqual(pulled("", "queued\n\ntyped in terminal", "queued"), { reason: "changed" });
	assert.deepEqual(pulled("", "typed", "queued"), { reason: "changed" });
	assert.deepEqual(pulled("", "queued\n\nmore", "queued\n\nmore"), { text: "queued\n\nmore" }, "the mirror's own blank line is part of a message");
	assert.deepEqual(pulled("draft", "one\n\ndraft and more", "one"), { reason: "changed" }, "typing after the draft too");
});

test("joined: steering messages first, then follow-ups, each in the order they came, as pi's Alt+Up joins them", () => {
	assert.equal(joined([{ text: "f1", as: "followUp" }, { text: "s1", as: "steer" }, { text: "f2", as: "followUp" }, { text: "s2", as: "steer" }]), "s1\n\ns2\n\nf1\n\nf2");
	assert.equal(joined([]), "");
});

test("pulled (R-F004): pi's setText forgets a pasted block's content; the editor is given back whole, the messages then the draft with the content", () => {
	assert.deepEqual(pulled("see\nline one\nline two", "q\n\nsee [paste #1 +2 lines]", "q"), { reason: "changed", restore: "q\n\nsee\nline one\nline two" });
	assert.deepEqual(pulled("see 12345", "q\n\nsee [paste #2 5 chars]", "q"), { reason: "changed", restore: "q\n\nsee 12345" });
	assert.deepEqual(pulled("typed", "q\n\ntyped more", "q"), { reason: "changed" }, "an edit without a paste marker restores nothing");
	assert.deepEqual(pulled("x", "other [paste #1 +2 lines]", "q"), { reason: "changed" }, "nor when the messages are not in front");
});

test("checkPull takes only the fields of the protocol, in shape", () => {
	assert.deepEqual(checkPull({ pending: true, ticket: "t", extra: 1 }), { pending: true, ticket: "t" });
	assert.deepEqual(checkPull({ text: "a" }), { text: "a" });
	assert.deepEqual(checkPull({ empty: true }), { empty: true });
	assert.deepEqual(checkPull({ reason: "not_taken" }), { reason: "not_taken" });
	assert.deepEqual(checkPull({ reason: "no_key" }), { reason: "no_key" });
	assert.deepEqual(checkPull({ pending: true, ticket: "t", key: "alt+q" }), { pending: true, ticket: "t", key: "alt+q" });
	for (const key of ["ctrl+d", "ctrl+c", "ctrl+z", "escape", "alt+shift+q", "q", "", 3, "alt+q\n"]) assert.deepEqual(checkPull({ pending: true, ticket: "t", key } as never), { reason: "no_key" }, `key ${JSON.stringify(key)}`);
	assert.equal(checkPull({ text: "a", key: "ctrl+d" } as never), undefined, "a key on a reply that is not a begin stays out of shape");
	for (const bad of [undefined, { pending: "yes" }, { ticket: 3 }, { ticket: "x".repeat(65) }, { text: 3 }, { text: "x".repeat(MAX_PULL + 1) }, { empty: false }, { reason: "whatever" }]) assert.equal(checkPull(bad as never), undefined, JSON.stringify(bad));
});

/** One session's bridge with an editor and a queue the test drives; `press` is what pi does on Alt+Up. */
function session({ platform = "darwin", env = {}, keybindings }: { platform?: string; env?: Record<string, string>; keybindings?: unknown } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "psb-dequeue-bridge-"));
	bridgeDirs.push(dir);
	const agentDir = join(dir, "agent"); // pi's agent directory: its keybindings.json says where the dequeue key is
	mkdirSync(agentDir);
	if (keybindings !== undefined) writeFileSync(join(agentDir, "keybindings.json"), typeof keybindings === "string" ? keybindings : JSON.stringify(keybindings));
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
	const bridge = startBridge(pi, { env: { HERDR_PANE_ID: "wA:p1", PI_INTERCOM_SESSION_ID: "S", PI_CODING_AGENT_DIR: agentDir, ...env }, dir, local: () => undefined, close: () => undefined, platform });
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

/** Messages queued while the agent works: pi's queue count and the `input` events the bridge mirrors. */
const queue = (s: ReturnType<typeof session>, ...messages: [text: string, as: "steer" | "followUp"][]) => {
	s.st.queued += messages.length;
	for (const [text, as] of messages) s.fire("input", { text, streamingBehavior: as });
};

test("pull: begin says whether anything waits and remembers the editor; finish hands over the messages, leaves the draft in the editor, and never carries the draft", async () => {
	const s = session();
	s.st.editor = "private draft sk-123";
	assert.deepEqual(await s.bridge.pull("begin"), { pending: false }, "nothing queued: no key should go");
	queue(s, ["then follow", "followUp"], ["steer me", "steer"]);
	const begun = await s.bridge.pull("begin");
	assert.equal(begun.pending, true);
	s.press(["steer me", "then follow"]); // pi joins the steering messages first, then the follow-ups
	const done = await s.bridge.pull("finish", begun.ticket);
	assert.deepEqual(done, { text: "steer me\n\nthen follow" });
	assert.equal(s.st.editor, "private draft sk-123", "the draft stays, the messages are gone from pi's editor");
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "stale" }, "a ticket is spent once");
});

test("pull: begin names the key pi binds to dequeue: Alt+Up, Alt+Q on Windows and WSL, or what keybindings.json says", async () => {
	const key = async (options?: Parameters<typeof session>[0]) => {
		const s = session(options);
		queue(s, ["q", "steer"]);
		return await s.bridge.pull("begin");
	};
	const keyOf = async (options?: Parameters<typeof session>[0]) => (await key(options)).key;
	assert.equal(await keyOf(), "alt+up", "macOS");
	assert.equal(await keyOf({ platform: "linux" }), "alt+up");
	assert.equal(await keyOf({ platform: "win32" }), "alt+q", "Windows");
	assert.equal(await keyOf({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } }), "alt+q", "WSL");
	assert.equal(await keyOf({ platform: "linux", env: { WSL_INTEROP: "/run/WSL/1_interop" } }), "alt+q");
	assert.equal(await keyOf({ platform: "darwin", env: { WSL_DISTRO_NAME: "Ubuntu" } }), "alt+up", "WSL is a Linux thing");
	assert.equal(await keyOf({ platform: "win32", keybindings: {} }), "alt+q", "a keybindings.json that says nothing about it");
	assert.equal(await keyOf({ platform: "win32", keybindings: { "app.message.followUp": "ctrl+x" } }), "alt+q");
	assert.equal(await keyOf({ platform: "win32", keybindings: "{ not json" }), "alt+q", "one pi cannot read either: its defaults");
	assert.equal(await keyOf({ platform: "win32", keybindings: "\ufeff" + JSON.stringify({ "app.message.dequeue": "ctrl+x" }) }), "ctrl+x", "a BOM is skipped as pi skips it");
	// a remap, whatever the platform
	assert.equal(await keyOf({ keybindings: { "app.message.dequeue": "alt+q" } }), "alt+q");
	assert.equal(await keyOf({ platform: "win32", keybindings: { "app.message.dequeue": "alt+up" } }), "alt+up");
	// pi's KeyIdSchema is case-sensitive and strict: a value with any invalid id is dropped whole, and pi's default stands
	for (const value of ["Alt+Q", " alt+q", "alt+K", ["alt+x", "Alt+Q"], ["alt+x", " alt+q"], "alt+q ", "alt+\u212a", "ctrl+ctrl+x", "alt+nosuchkey", 7, ["alt+x", 7]]) assert.equal(await keyOf({ keybindings: { "app.message.dequeue": value } }), "alt+up", `invalid ${JSON.stringify(value)}: the default`);
	assert.equal(await keyOf({ keybindings: { "app.message.dequeue": "ctrl+x" } }), "ctrl+x");
	assert.equal(await keyOf({ keybindings: { "app.message.dequeue": ["ctrl+shift+x", "alt+d"] } }), "alt+d", "the first of several the server can press");
	assert.equal(await keyOf({ keybindings: { dequeue: "alt+e" } }), "alt+e", "pi's old name for it");
	assert.equal(await keyOf({ keybindings: { dequeue: "alt+e", "app.message.dequeue": "alt+f" } }), "alt+f", "the new name wins, as in pi's migration");
	// bound to nothing the server presses: no key goes, and the page is told
	for (const bound of [[], "ctrl+d", ["ctrl+c", "escape"], "ctrl+shift+x", "ctrl+alt+x", "f5", ["shift+up"]]) assert.deepEqual(await key({ keybindings: { "app.message.dequeue": bound } }), { reason: "no_key" }, JSON.stringify(bound));
	assert.deepEqual(await keyOf({ keybindings: { "app.message.dequeue": 7 } }), "alt+up", "a value pi drops (wrong shape) leaves the default");
	const idle = session({ keybindings: { "app.message.dequeue": [] } });
	assert.deepEqual(await idle.bridge.pull("begin"), { pending: false }, "nothing queued: nothing to complain about");
});

test("dequeuekey: pi's live bindings win over the file; a manager that lacks the id leaves the file to speak", () => {
	const manager = (defs: Record<string, string[]>) => ({ getDefinition: (id: string) => (id in defs ? {} : undefined), getKeys: (id: string) => defs[id] ?? [] });
	const dir = join(scratch, "live-dir");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "keybindings.json"), JSON.stringify({ "app.message.dequeue": "alt+f" }));
	const env = { PI_CODING_AGENT_DIR: dir };
	const withLive = (defs: Record<string, string[]>) => { setKeybindings(manager(defs) as never); try { return dequeueKey({ platform: "darwin", env }); } finally { setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS)); } };
	assert.equal(dequeueKey({ platform: "darwin", env }), "alt+f", "pi-tui's own default manager lacks the id: the file");
	assert.equal(withLive({ "app.message.dequeue": ["alt+q"] }), "alt+q", "the live binding, not the file");
	assert.equal(withLive({ "app.message.dequeue": ["ctrl+shift+x", "alt+d"] }), "alt+d", "the first the server can press");
	assert.equal(withLive({ "app.message.dequeue": ["Alt+Q"] }), undefined, "no case folding of a live key");
	assert.equal(withLive({ "app.message.dequeue": [] }), undefined, "unbound live: no key, the file is not consulted");
	assert.equal(withLive({ "app.message.dequeue": ["ctrl+d", "escape"] }), undefined);
	assert.equal(dequeueKey({ platform: "darwin", env, bindings: () => ["alt+z"] }), "alt+z");
	assert.equal(dequeueKey({ platform: "darwin", env, bindings: () => undefined }), "alt+f");
	assert.deepEqual(["alt+q", "ctrl+shift+x", "alt+k", "super+alt+x", "alt+Q", " alt+q", "alt+alt+q", "ctrl+f5", "up", "alt+nope"].map(validKeyId), [true, true, true, true, false, false, false, true, true, false]);
});

test("pull: a bridge's key outside the server's allowlist answers no_key through checkPull, not an unusable reply", () => {
	assert.deepEqual(checkPull({ pending: true, ticket: "t", key: "ctrl+shift+x" }), { reason: "no_key" });
	assert.deepEqual(checkPull({ pending: true, ticket: "t", key: "alt+Q" }), { reason: "no_key" });
});

test("dequeuekey: pi's Windows key set is Windows and WSL; the label is how a person writes the key", () => {
	assert.deepEqual([windowsKeys("win32", {}), windowsKeys("darwin", {}), windowsKeys("linux", {}), windowsKeys("linux", { WSL_DISTRO_NAME: "U" }), windowsKeys("linux", { WSL_INTEROP: "x" }), windowsKeys("darwin", { WSL_DISTRO_NAME: "U" })], [true, false, false, true, true, false]);
	assert.deepEqual([defaultDequeue("win32", {}), defaultDequeue("darwin", {}), defaultDequeue("linux", { WSL_DISTRO_NAME: "U" })], ["alt+q", "alt+up", "alt+q"]);
	assert.deepEqual(["alt+q", "alt+up", "ctrl+left"].map(keyLabel), ["Alt+Q", "Alt+Up", "Ctrl+Left"]);
	assert.equal(dequeueKey({ platform: "win32", env: { PI_CODING_AGENT_DIR: join(scratch, "no-such-agent-dir") } }), "alt+q", "no keybindings.json at all");
});

test("pull: the key comes with begin each time, so a keybindings.json changed meanwhile is followed", async () => {
	const s = session({ platform: "win32" });
	queue(s, ["q", "steer"]);
	assert.equal((await s.bridge.pull("begin")).key, "alt+q");
	writeFileSync(join(s.dir, "agent", "keybindings.json"), JSON.stringify({ "app.message.dequeue": "alt+w" }));
	assert.equal((await s.bridge.pull("begin")).key, "alt+w");
});

test("pull over the channel: begin's result carries the key", async () => {
	const s = session({ platform: "win32" });
	queue(s, ["hi", "steer"]);
	s.message({ version: 1, type: "pull", to: s.to, reqId: "k1", step: "begin" });
	await after_(10);
	assert.equal(s.results().at(-1)!.key, "alt+q");
});

test("pull: the queue the bridge mirrors is gone from what it relays as soon as pi has taken it back", async () => {
	const s = session();
	queue(s, ["queued one", "steer"]);
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
	queue(s, ["a", "steer"]);
	const begun = await s.bridge.pull("begin");
	s.st.queued = 0; // delivered meanwhile; pi's Alt+Up then restores nothing
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { empty: true });
	assert.equal(s.st.editor, "draft");
});

test("pull: a queue pi did not take back, an editor that changed, a text too long, and an editor that will not clear leave the editor as pi has it", async () => {
	const s = session();
	queue(s, ["q", "steer"]);
	let begun = await s.bridge.pull("begin");
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "not_taken" }, "the key did nothing: the queue is still there");
	s.st.editor = "draft";
	s.st.queued = 0;
	queue(s, ["a", "steer"]);
	begun = await s.bridge.pull("begin");
	s.press(["a"]);
	s.st.editor = "a\n\ndraft, edited in the terminal meanwhile";
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "changed" });
	assert.equal(s.st.editor, "a\n\ndraft, edited in the terminal meanwhile");
	s.st.editor = "";
	s.st.queued = 0;
	queue(s, ["x".repeat(MAX_PULL + 10), "steer"]);
	begun = await s.bridge.pull("begin");
	s.press(["x".repeat(MAX_PULL + 10)]);
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "too_large" });
	assert.equal(s.st.editor.length, MAX_PULL + 10, "it stays in the terminal's editor");
	s.st.editor = "";
	s.st.queued = 0;
	queue(s, ["keep", "steer"]);
	begun = await s.bridge.pull("begin");
	s.press(["keep"]);
	s.st.failSet = true;
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "not_cleared" }, "never handed over while it would stay in the editor too");
	assert.equal(s.st.editor, "keep");
});

test("pull (R-F003): a blank draft at begin and terminal typing before the key: nothing leaves the session, and the terminal's text stays in its editor", async () => {
	const s = session();
	queue(s, ["queued", "steer"]);
	const begun = await s.bridge.pull("begin");
	s.st.editor = "xyz sk-secret"; // typed in the terminal after begin, before the key
	s.press(["queued"]);
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "changed" });
	assert.equal(s.st.editor, "queued\n\nxyz sk-secret", "pi's editor is left as it is: the messages and the typing, both still in the terminal");
});

test("pull (R-F004): a draft with a pasted block comes out of a refused take-back whole, the paste's content back in place of its marker", async () => {
	const s = session();
	s.st.editor = "see\nline one\nline two"; // getEditorText expands the paste marker
	queue(s, ["q", "steer"]);
	const begun = await s.bridge.pull("begin");
	s.st.queued = 0;
	s.st.editor = "q\n\nsee [paste #1 +2 lines]"; // pi's own restore: its setText forgot the content
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "changed" });
	assert.equal(s.st.editor, "q\n\nsee\nline one\nline two");
});

test("pull (R-F002): past the deadline the editor is not cleared, and a deadline shortens the wait for pi", async () => {
	const s = session();
	s.st.editor = "draft";
	queue(s, ["m", "steer"]);
	let begun = await s.bridge.pull("begin");
	s.press(["m"]);
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket, Date.now() + 100), { reason: "not_cleared" }, "the answer would reach nobody: the messages stay where pi put them");
	assert.equal(s.st.editor, "m\n\ndraft");
	s.st.editor = "draft";
	s.st.queued = 0;
	queue(s, ["m2", "steer"]);
	begun = await s.bridge.pull("begin");
	const t0 = Date.now();
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket, t0 + 450), { reason: "not_taken" });
	assert.ok(Date.now() - t0 < 450, `it gave up before the deadline, after ${Date.now() - t0} ms`);
	s.st.editor = "draft";
	s.st.queued = 0;
	s.fire("agent_settled"); // pi emptied its queue another way: the mirror follows
	queue(s, ["m3", "steer"]);
	begun = await s.bridge.pull("begin");
	s.press(["m3"]);
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket, Date.now() + 2500), { text: "m3" }, "in time: handed over as before");
	assert.equal(s.st.editor, "draft");
});

test("pull (R-F001): the messages handed over are kept for the same take-back asked again, until ten minutes pass or the session changes; another take-back gets none of them", async () => {
	const s = session();
	s.st.editor = "draft";
	queue(s, ["gone from pi", "steer"]);
	const begun = await s.bridge.pull("begin", "take-one-aaaaaaaaaa");
	s.press(["gone from pi"]);
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { text: "gone from pi" });
	assert.equal(s.st.editor, "draft");
	assert.deepEqual(await s.bridge.pull("begin", "take-one-aaaaaaaaaa"), { text: "gone from pi" }, "the answer got lost: asked again, it is still there");
	assert.deepEqual(await s.bridge.pull("begin", "take-one-aaaaaaaaaa"), { text: "gone from pi" }, "and again");
	assert.equal(s.st.editor, "draft", "no key is needed for it and the editor is untouched");
	assert.deepEqual(await s.bridge.pull("begin", "take-two-bbbbbbbbbb"), { pending: false }, "another take-back is a new question");
	const now = Date.now, realNow = now.bind(Date);
	Date.now = () => realNow() + 601_000;
	try {
		assert.deepEqual(await s.bridge.pull("begin", "take-one-aaaaaaaaaa"), { pending: false }, "after ten minutes the session no longer keeps them");
	} finally {
		Date.now = now;
	}
	s.fire("session_start");
	assert.deepEqual(await s.bridge.pull("begin", "take-one-aaaaaaaaaa"), { pending: false });
	queue(s, ["not cleared one", "steer"]);
	const b2 = await s.bridge.pull("begin", "take-three-cccccccc");
	s.press(["not cleared one"]);
	s.st.failSet = true;
	assert.deepEqual(await s.bridge.pull("finish", b2.ticket), { reason: "not_cleared" });
	s.st.failSet = false;
	assert.deepEqual(await s.bridge.pull("begin", "take-three-cccccccc"), { pending: false }, "what stayed in pi's editor is not also kept: it would come twice");
});

test("pull: a session without a UI has no editor; an old ticket is stale", async () => {
	const s = session();
	s.st.hasUI = false;
	assert.deepEqual(await s.bridge.pull("begin"), { reason: "no_editor" });
	s.st.hasUI = true;
	queue(s, ["q", "steer"]);
	const begun = await s.bridge.pull("begin");
	assert.deepEqual(await s.bridge.pull("finish", "other"), { reason: "stale" });
	assert.deepEqual(await s.bridge.pull("finish", begun.ticket), { reason: "not_taken" }, "a wrong ticket spends nothing");
});

test("pull over the channel: only G for this bridge is answered, with the result under the request's id", async () => {
	const s = session();
	queue(s, ["hi", "steer"]);
	s.message({ version: 1, type: "pull", to: s.to, reqId: "r1", step: "begin", take: "take-chan-aaaaaaaaaa" });
	await after_(10);
	const [first] = s.results();
	assert.equal(first!.reqId, "r1");
	assert.equal(first!.pending, true);
	s.press(["hi"]);
	s.message({ version: 1, type: "pull", to: s.to, reqId: "r2", step: "finish", ticket: first!.ticket, deadline: Date.now() + 2500 });
	await after_(20);
	assert.deepEqual(s.results().at(-1), { version: 1, type: "pull-result", bridgeId: s.to, reqId: "r2", text: "hi" });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "r3", step: "begin", take: "take-chan-aaaaaaaaaa" });
	await after_(10);
	assert.deepEqual(s.results().at(-1), { version: 1, type: "pull-result", bridgeId: s.to, reqId: "r3", text: "hi" }, "the take id travels with begin");
	const n = s.results().length;
	s.message({ version: 1, type: "pull", to: s.to, reqId: "x", step: "begin" }, "X");
	s.message({ version: 1, type: "pull", to: "someone", reqId: "y", step: "begin" });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "z".repeat(65), step: "begin" });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "w", step: "finish", deadline: Date.now() + 1000 });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "w2", step: "finish", ticket: "t" });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "w3", step: "finish", ticket: "t", deadline: "soon" });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "w4", step: "begin", take: 3 });
	s.message({ version: 1, type: "pull", to: s.to, reqId: "v", step: "nope" });
	await after_(20);
	assert.equal(s.results().length, n);
});

// ---- the server's dequeue action ----

const FILE = "/s/2026_sess-1.jsonl", TAKE = { take: "take-0123456789abcdef" };
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
async function served({ pull, status = "working", dialog = false, secret = false }: { pull: (step: string, ref?: string) => Pull | undefined | Promise<Pull | undefined>; status?: string; dialog?: boolean; secret?: boolean }) {
	const calls: [string, Record<string, unknown>][] = [], steps: [string, string | undefined][] = [], state = { pane_id: "wA:p1", agent: "pi", agent_status: status, agent_session: { value: FILE } };
	const call = async (method: string, params: Record<string, unknown>) => (calls.push([method, params]), steps.push(["call:" + method, undefined]), method === "pane.get" ? { pane: state } : {});
	const target = { from: "S", bridgeId: "B", answer: { dialog: "d1", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "A" }] } } } as Target;
	const hub = { running: true, me: "G", start() {}, stop() {}, receive() {}, relayed: () => ({ dialogsOf: () => undefined, merge: () => ({ callId: "", tool: "" }) }), replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: {} }), target: () => (dialog ? target : undefined), probe: async () => ({ editor: "empty" as const }), pull: async (_k: string, step: string, ref?: string) => (steps.push([step, ref]), pull(step, ref)) };
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file: FILE, pane: "wA:p1", live: true } : undefined);
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, hub: hub as unknown as Hub, dir: join(scratch, "bundle"), pollMs: 50, ...(secret ? { secret: undefined } : {}) } as never);
	running.push(gui);
	return { gui, calls, steps, state, keys: () => calls.filter(([m]) => m === "pane.send_input").map(([, p]) => p.keys) };
}

test("dequeue: begin, then Alt+Up on the pane, then finish with the ticket; the page gets the pulled text", async () => {
	const x = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T1", key: "alt+up" } : { text: "one\n\ntwo" }) });
	assert.deepEqual(await send(x.gui, "sessions/sess-1/dequeue", TAKE), { status: 200, body: { text: "one\n\ntwo" } });
	assert.deepEqual(x.steps, [["call:pane.get", undefined], ["begin", TAKE.take], ["call:pane.get", undefined], ["call:pane.send_input", undefined], ["finish", "T1"]], "begin (with the page's take id) before the key, the pane looked at again, finish after it");
	assert.deepEqual(x.keys(), [["alt+up"]]);
});

test("dequeue: the key that goes is the one the session's bridge names (Windows' Alt+Q, a remap), an older bridge's silence means pi's default on this platform, and a key the server will not press never goes", async () => {
	const named = async (key: string | undefined) => {
		const x = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T", ...(key ? { key } : {}) } : { text: "t" }) });
		return [(await send(x.gui, "sessions/sess-1/dequeue", TAKE)).status, x.keys()];
	};
	assert.deepEqual(await named("alt+q"), [200, [["alt+q"]]], "Windows and WSL");
	assert.deepEqual(await named("ctrl+x"), [200, [["ctrl+x"]]], "a remap");
	assert.deepEqual(await named("alt+up"), [200, [["alt+up"]]]);
	assert.deepEqual(await named(undefined), [200, [[defaultDequeue()]]], "a bridge that names none: the default of the server's own platform");
	const stuck = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T", key: "alt+q" } : { reason: "not_taken" }) });
	const r = await send(stuck.gui, "sessions/sess-1/dequeue", TAKE);
	assert.deepEqual([r.status, r.body.error, (r.body as { key?: string }).key], [409, "not_taken", "alt+q"]);
	assert.match(r.body.reason!, /Alt\+Q/, "the message names the key that went");
	for (const bad of ["ctrl+d", "ctrl+c", "ctrl+z", "escape", "alt+shift+q", "enter", "q"]) {
		const x = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T", key: bad } : { text: "t" }) });
		const refused = await send(x.gui, "sessions/sess-1/dequeue", TAKE);
		assert.deepEqual([refused.status, refused.body.error], [409, "no_key"], `${bad}: the server checks the key again, whatever the bridge says`);
		assert.deepEqual(x.keys(), [], `${bad} is never pressed`);
	}
	const unbound = await served({ pull: () => ({ reason: "no_key" }) });
	const none = await send(unbound.gui, "sessions/sess-1/dequeue", TAKE);
	assert.deepEqual([none.status, none.body.error], [409, "no_key"]);
	assert.match(none.body.reason!, /keybindings/);
	assert.deepEqual(unbound.keys(), [], "bound to a key the server will not press: nothing goes");
});

test("dequeue: an empty queue sends no key; one delivered between begin and the key says empty", async () => {
	const none = await served({ pull: () => ({ pending: false }) });
	assert.deepEqual(await send(none.gui, "sessions/sess-1/dequeue", TAKE), { status: 200, body: { empty: true } });
	assert.deepEqual(none.keys(), [], "no Alt+Up when nothing waits");
	const late = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T", key: "alt+up" } : { empty: true }) });
	assert.deepEqual(await send(late.gui, "sessions/sess-1/dequeue", TAKE), { status: 200, body: { empty: true } });
	assert.deepEqual(late.keys(), [["alt+up"]]);
});

test("dequeue: refusals keep the editor and the key from going when they come before it, and say why after it", async () => {
	for (const [why, status] of [["no_editor", 409], ["stale", 409]] as const) {
		const x = await served({ pull: () => ({ reason: why }) });
		const r = await send(x.gui, "sessions/sess-1/dequeue", TAKE);
		assert.deepEqual([r.status, r.body.error], [status, why]);
		assert.deepEqual(x.keys(), []);
	}
	const silent = await served({ pull: () => undefined });
	assert.equal((await send(silent.gui, "sessions/sess-1/dequeue", TAKE)).status, 504, "a bridge that never answers");
	assert.deepEqual(silent.keys(), []);
	const stuck = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T", key: "alt+up" } : { reason: "not_taken" }) });
	const r = await send(stuck.gui, "sessions/sess-1/dequeue", TAKE);
	assert.deepEqual([r.status, r.body.error], [409, "not_taken"]);
	assert.match(r.body.reason!, /Alt\+Up/);
	assert.deepEqual([(r.body as { key?: string }).key, (r.body as { label?: string }).label], ["alt+up", "Alt+Up"], "the page is told which key went, to say it in its own language");
	const lost = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : undefined) });
	const unsure = await send(lost.gui, "sessions/sess-1/dequeue", TAKE);
	assert.equal(unsure.status, 504, "unsure: pi may have taken the messages");
	assert.match(unsure.body.reason!, /terminal's editor/);
	assert.match(unsure.body.reason!, /Fetch again/, "R-F002: the 504 tells the truth, where the messages are and how to get them");
	assert.doesNotMatch(unsure.body.reason!, /nothing was taken/i);
	const late = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : { reason: "stale" }) });
	const aged = await send(late.gui, "sessions/sess-1/dequeue", TAKE);
	assert.deepEqual([aged.status, aged.body.error], [409, "stale"]);
	assert.match(aged.body.reason!, /terminal's editor/, "R-F005: after the key went the messages are in the terminal, not for a retry");
	assert.doesNotMatch(aged.body.reason!, /try again/);
	const big = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : { reason: "too_large" }) });
	assert.equal((await send(big.gui, "sessions/sess-1/dequeue", TAKE)).body.error, "too_large");
});

test("dequeue: nothing is asked or pressed while the session waits on a dialog or a question the page answers", async () => {
	const waiting = await served({ pull: () => ({ pending: true, ticket: "T" }), status: "blocked" });
	assert.equal((await send(waiting.gui, "sessions/sess-1/dequeue", TAKE)).body.error, "blocked");
	assert.deepEqual(waiting.steps.map(([s]) => s), ["call:pane.get"], "the bridge was not asked and no key went");
	const asking = await served({ pull: (step) => (step === "begin" ? { pending: true, ticket: "T" } : { text: "x" }), dialog: true });
	assert.equal((await send(asking.gui, "sessions/sess-1/dequeue", TAKE)).body.error, "blocked", "like any key but Escape");
	assert.deepEqual(asking.keys(), []);
});

test("dequeue: one at a time per session, the session and the pane are checked as for typing, and the body is not read", async () => {
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const x = await served({ pull: async (step) => (step === "begin" ? (await gate, { pending: true, ticket: "T" }) : { text: "t" }) });
	const first = send(x.gui, "sessions/sess-1/dequeue", TAKE);
	await after_(30);
	assert.equal((await send(x.gui, "sessions/sess-1/dequeue", TAKE)).status, 429);
	release();
	assert.equal((await first).status, 200);
	assert.equal((await send(x.gui, "sessions/nope/dequeue")).status, 404);
	x.state.agent = "zsh";
	assert.equal((await send(x.gui, "sessions/sess-1/dequeue", TAKE)).body.error, "not_pi");
});

test("dequeue (R-F001): the same take id asked again gets the text the session kept, and no key goes; a take id is required and well-formed", async () => {
	const kept = await served({ pull: (step) => (step === "begin" ? { text: "kept text" } : { reason: "stale" }) });
	assert.deepEqual(await send(kept.gui, "sessions/sess-1/dequeue", TAKE), { status: 200, body: { text: "kept text" } });
	assert.deepEqual(kept.keys(), [], "pi's Alt+Up is not pressed again for a take-back that was done");
	assert.deepEqual(kept.steps.filter(([s]) => s === "finish"), [], "and there is no finish");
	for (const bad of [{}, { take: 3 }, { take: "short" }, { take: "x".repeat(65) }, { take: "has space in the id 123" }]) {
		const r = await send(kept.gui, "sessions/sess-1/dequeue", bad);
		assert.deepEqual([r.status, r.body.error], [400, "bad_request"], JSON.stringify(bad));
	}
});

test("dequeue (R-F006): the pane is looked at again right before the key; a session that changed while the guard ran gets none", async () => {
	const x = await served({ pull: (step) => (step === "begin" ? ((x.state.agent = "zsh"), { pending: true, ticket: "T" }) : { text: "t" }) });
	const r = await send(x.gui, "sessions/sess-1/dequeue", TAKE);
	assert.equal(r.body.error, "not_pi");
	assert.deepEqual(x.keys(), [], "no Alt+Up into another program");
});
