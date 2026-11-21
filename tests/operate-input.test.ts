import assert from "node:assert/strict";
import { test } from "node:test";
import { createControl, type ControlDeps, type Reply } from "../src/control.ts";
import { createFaces } from "../src/lan/faces.ts";
import { checkProbe, probeEditor, type Editor } from "../src/probe.ts";
import { BOSS_LINE, SHELL_LINE } from "../src/operateroutes.ts";
import type { Found } from "../src/net.ts";
import { fakeClock } from "./fake-clock.ts";
import { scopeOf, world } from "./operate-world.ts";

// docs/specs/2026-11-07-link-operate.md §7: input safety on a box. Every operate request runs as a paired device's would (remote guards kept) and the box refuses more, from its own state: shell lines, /boss commands, an unreadable editor.

const Q = new URLSearchParams(), scope = scopeOf(["sess-1"]);
const refusal = (r: Reply) => [r.status, (r.body as { error?: string }).error, (r.body as { why?: string }).why];
const SHELL: Editor = { editor: "command", shell: true, boss: false }, BOSS: Editor = { editor: "command", shell: false, boss: true }, PLAIN: Editor = { editor: "command", shell: false, boss: false };

test("the composer: a text that starts with `!` (after any blanks, a newline, a no-break space) or is a /boss command is refused, and nothing reaches Herdr or the probe", async () => {
	const x = await world();
	for (const text of ["!echo x", "  !ls", "\n!ls", "\u00a0!ls", "\t\t!!ls", "!", "/boss send other hi", "/boss", " /boss status", "\n/boss\topen main x", "/boss  gui view geek"]) {
		const done = await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text, as: "send" }, scope);
		assert.deepEqual(refusal(done), [403, "operate_refused", SHELL_LINE.test(text) ? "shell" : "boss-command"], JSON.stringify(text));
	}
	assert.deepEqual([x.calls, x.probes], [[], []]);
});

test("the composer: other texts go through, among them ones that only look alike (`!` or /boss inside, /bossy, /boss-x)", async () => {
	const x = await world();
	for (const text of ["hello!", "echo !x", "a\n!b", "/bossy hi", "/boss-x go", "/bosses"]) {
		const done = await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text, as: "send" }, scope);
		assert.equal(done.status, 200, JSON.stringify(text));
	}
	assert.equal(x.typed().length, 6);
	assert.deepEqual(x.typed()[0], ["agent.prompt", { target: "wA:p1", text: "hello!" }]);
});

test("the composer under operate looks at the editor first and sends only into an empty one (the text joins any draft, OR-F001): shell, /boss, other `/` drafts, text drafts and an unreadable editor are refused", async () => {
	for (const [editor, want] of [[SHELL, [403, "operate_refused", "shell"]], [BOSS, [403, "operate_refused", "boss-command"]], [PLAIN, [403, "operate_refused", "command"]], [{ editor: "text" }, [403, "operate_refused", "draft"]], [{ editor: "text", ending: "reload" }, [403, "operate_refused", "draft"]], [undefined, [403, "operate_refused", "noanswer"]], [{ editor: "unknown" }, [403, "operate_refused", "unread"]], [{ editor: "command" }, [403, "operate_refused", "unread"]]] as const) {
		const x = await world({ editor: editor as Editor | undefined });
		assert.deepEqual(refusal(await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "echo x", as: "send" }, scope)), want, JSON.stringify(editor));
		assert.deepEqual(x.typed(), [], "no prompt typed");
		assert.deepEqual(x.probes.map((p) => [p.nonce, p.flags]), [[undefined, true]], "the probe asks for the flags, and says nothing of any line");
	}
	const x = await world({ editor: { editor: "empty" } });
	assert.equal((await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: "fine", as: "send" }, scope)).status, 200, "an empty editor takes it");
});

test("OR-F001: a draft the pad left (a bare `/`, `boss`, a `/bos`) is never joined by a text that completes it into a /boss line", async () => {
	for (const [editor, text] of [[PLAIN, "boss status MARKER"], [PLAIN, "oss status MARKER"], [{ editor: "text" }, "/bos"], [{ editor: "text" }, "/boss status MARKER"], [{ editor: "text" }, " status MARKER"]] as [Editor, string][]) {
		const x = await world({ editor });
		const done = await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text, as: "send" }, scope);
		assert.equal(done.status, 403, JSON.stringify([editor, text]));
		assert.deepEqual(x.typed(), [], "nothing reached the prompt");
	}
});

test("the pad: `!` typed or pasted is allowed (a text may hold one), but the Enter that would run it is refused by the probe, and sends nothing", async () => {
	const x = await world(), key = (k: string, extra: Record<string, unknown> = {}) => x.key(x.session, scope, k, extra);
	await x.attach(scope);
	assert.equal((await x.session.request("POST", ["sessions", "sess-1", "keys"], Q, { text: "!", stream: "page" }, scope)).status, 200, "typed");
	assert.equal((await x.session.request("POST", ["sessions", "sess-1", "keys"], Q, { paste: "!rm -rf build", stream: "page" }, scope)).status, 200, "pasted");
	x.w.editor = SHELL; // what pi's editor holds now
	assert.deepEqual(refusal(await key("enter")), [403, "operate_refused", "shell"]);
	assert.deepEqual(refusal(await key("enter", { confirmed: "command" })), [403, "operate_refused", "shell"], "no confirm lets it through");
	assert.deepEqual(x.typed().map(([m]) => m), ["pane.send_text", "pane.send_text"], "the typed text and the paste went; no Enter did");
	assert.deepEqual(x.probes.at(-1)!.flags, true);
});

test("the pad: a /boss line is refused at Enter; an unreadable editor, or a bridge that does not tell the flags, is refused (no `unread` or `command` confirm)", async () => {
	const x = await world(), key = (k: string, extra: Record<string, unknown> = {}) => x.key(x.session, scope, k, extra);
	await x.attach(scope);
	x.w.editor = BOSS;
	assert.deepEqual(refusal(await key("enter")), [403, "operate_refused", "boss-command"]);
	x.w.editor = undefined; // the session did not answer: told apart from an editor it answered it cannot read
	assert.deepEqual(refusal(await key("enter", { confirmed: "unread" })), [403, "operate_refused", "noanswer"]);
	assert.deepEqual(refusal(await key("up")), [403, "operate_refused", "noanswer"], "a key probed for its binding too");
	x.w.editor = { editor: "unknown" };
	assert.deepEqual(refusal(await key("enter", { confirmed: "unread" })), [403, "operate_refused", "unread"]);
	x.w.editor = { editor: "command" }; // an older bridge: a `command` that tells nothing of its line
	assert.deepEqual(refusal(await key("enter", { confirmed: "command" })), [403, "operate_refused", "unread"]);
	assert.equal(x.typed().length, 0);
});

test("the pad: what a paired device gets stays where it is safe: an empty editor goes and /reload asks its own confirm; any `/` draft is refused (OR-F003: the command menu's completion decides what Enter runs), with no confirm lifting it", async () => {
	const x = await world(), key = (k: string, extra: Record<string, unknown> = {}) => x.key(x.session, scope, k, extra);
	await x.attach(scope);
	for (const [editor, confirmed] of [[PLAIN, undefined], [PLAIN, "command"]] as [Editor, string | undefined][]) {
		x.w.editor = editor;
		assert.deepEqual(refusal(await key("enter", { confirmed })), [403, "operate_refused", "command"], "a bare `/`, `/b` and `/bos` are all this class: the menu may turn them into /boss");
	}
	x.w.editor = { editor: "empty" };
	assert.equal((await key("enter")).status, 200);
	x.w.editor = { editor: "text", ending: "reload" };
	assert.equal(((await key("enter")).body as { confirm?: string }).confirm, "reload");
	assert.deepEqual(x.typed().map(([m, p]) => [m, p.keys]), [["pane.send_input", ["enter"]]]);
});

test("the pad: Alt+Enter acts as Enter on an idle session in pi, so under operate it is probed and refused the same; Ctrl+M is Enter with no probe and is never sent", async () => {
	const x = await world(), key = (k: string, extra: Record<string, unknown> = {}) => x.key(x.session, scope, k, extra);
	await x.attach(scope);
	x.w.editor = SHELL;
	assert.deepEqual(refusal(await key("alt+enter")), [403, "operate_refused", "shell"]);
	assert.deepEqual(refusal(await key("ctrl+m")), [403, "operate_refused", "enter-chord"]);
	assert.deepEqual(x.typed(), []);
	x.w.editor = { editor: "empty" };
	assert.equal((await key("alt+enter")).status, 200);
	assert.deepEqual(x.typed().map(([m, p]) => [m, p.keys]), [["pane.send_input", ["alt+enter"]]]);
});

test("the pad needs the session's own live mirror: the page's stream id is replaced by the box's, so keys go only while the mirror runs", async () => {
	const x = await world(), key = (k: string) => x.key(x.session, scope, k);
	assert.equal((await key("up")).status, 409, "no mirror attached yet");
	await x.attach(scope);
	assert.equal((await key("up")).status, 200);
	assert.equal((await x.session.mirror("sess-1", false, scope)).status, 200);
	assert.equal((await key("up")).status, 409, "detached: not fresh");
	assert.equal((await x.session.mirror("other-1", true, scope)).status, 403, "a mirror of a unit out of scope");
});

test("Stop (Escape alone) needs no mirror, and probes for the key's binding, and for raw once more right before the write (rr-f002, RR4-F003); a text that is not a string is the page's bad request, not a crash", async () => {
	const x = await world();
	assert.equal((await x.session.request("POST", ["sessions", "sess-1", "keys"], Q, { keys: ["esc"] }, scope)).status, 200);
	assert.deepEqual(x.probes.map((p) => [p.nonce, p.flags]), [[undefined, true], [undefined, true]]);
	assert.equal((await x.session.request("POST", ["sessions", "sess-1", "input"], Q, { text: 5, as: "send" }, scope)).status, 400);
});

// The probe itself: the flags come only when asked, so a local Enter's probe tells exactly what it told before.
const ui = (text: unknown) => ({ hasUI: true, ui: { getEditorText: () => text } }) as never;
test("probe.ts: with the flags asked, a `command` draft says whether it is a shell line or a /boss command; without them nothing changes", () => {
	const cases: [string, Editor][] = [["!rm -rf build", SHELL], [" !ls", SHELL], ["\n!x", SHELL], ["/boss send a b", BOSS], ["  /boss", BOSS], ["/model x", PLAIN], ["/bossy", PLAIN], ["/boss-x", PLAIN], ["/re", PLAIN]];
	for (const [text, want] of cases) assert.deepEqual(probeEditor(ui(text), undefined, true), want, JSON.stringify(text));
	for (const [text] of cases) assert.equal("shell" in probeEditor(ui(text)), false, `${JSON.stringify(text)}: not asked, not told`);
	assert.deepEqual(probeEditor(ui("hello"), undefined, true), { editor: "text" }, "no flags on another class");
	assert.deepEqual(probeEditor(ui(""), undefined, true), { editor: "empty" });
	assert.deepEqual(probeEditor(ui("/reload"), undefined, true), { editor: "text", ending: "reload" });
	assert.deepEqual(checkProbe({ editor: "command", shell: true, boss: false }), SHELL);
	assert.deepEqual(checkProbe({ editor: "command", shell: "yes", boss: 1 }), { editor: "command" }, "a flag that is not a boolean is none");
	assert.deepEqual(checkProbe({ editor: "text", shell: true }), { editor: "text" }, "flags on another class are dropped");
	assert.ok(BOSS_LINE.test("/boss") && !BOSS_LINE.test("/bossy"));
});

// The control split: the very guards of remote mode run for an operate request, driven through `control.run` as the seam does.
const FILE = "/s/2026_sess-1.jsonl", PANE = "wA:p1", FLAGS = { remote: true, secure: true, operate: true as const, foreground: async () => true };
const found = (): Found => ({ key: "sess-1", base: "wA", name: "billing", role: "main", file: FILE, pane: PANE, live: true });
function direct(over: Partial<ControlDeps> = {}, editor: Editor | undefined = { editor: "empty", keys: [], holds: {}, raw: true }) {
	const faces = createFaces(fakeClock(5_000_000).now), calls: [string, Record<string, unknown>][] = [];
	const call = async (method: string, params: Record<string, unknown>) => (calls.push([method, params]), method === "pane.get" ? { pane: { pane_id: PANE, agent: "pi", agent_status: "idle", agent_session: { value: FILE } } } : {});
	const answers: NonNullable<ControlDeps["answers"]> = { has: () => false, replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: { outcome: "accepted" } }), commands: async () => undefined, target: async () => undefined, probe: async () => editor, pull: async () => ({ pending: false }) };
	const handle = createControl({ lookup: (k) => (k === "sess-1" ? found() : undefined), call, csrf: "c".repeat(32), canonical: (f) => f, secret: async () => false, mirrors: { fresh: () => true, toggle: async () => ({ status: 200, body: {} }) } as never, answers, overlay: faces, ...over });
	return { faces, calls, run: handle.run, written: () => calls.filter(([m]) => m !== "pane.get").map(([m, p]) => [m, p.keys ?? p.text ?? p.target]) };
}
test("control.run with operate flags: a /boss gui lan screen on the pane leaves Escape only, as for a paired device; the same through `input`", async () => {
	const w = direct();
	w.faces.open(PANE);
	for (const [action, body] of [["input", { text: "4821", as: "send" }], ["keys", { key: "enter", stream: "s" }], ["keys", { text: "y", stream: "s" }]] as const) assert.deepEqual(refusal(await w.run(["sessions", "sess-1", action], body, FLAGS)).slice(0, 2), [409, "lan_overlay_open"], action);
	assert.equal((await w.run(["sessions", "sess-1", "keys"], { keys: ["esc"] }, FLAGS)).status, 200, "Escape goes");
	assert.deepEqual(w.written(), [["pane.send_input", ["esc"]]]);
});

test("control.run with operate flags: a link request open on the session leaves Escape only", async () => {
	const w = direct({ linkRequest: async () => true });
	assert.deepEqual(refusal(await w.run(["sessions", "sess-1", "input"], { text: "hi", as: "send" }, FLAGS)).slice(0, 2), [403, "local_only"]);
	assert.deepEqual(refusal(await w.run(["sessions", "sess-1", "keys"], { key: "enter", stream: "s" }, FLAGS)).slice(0, 2), [403, "local_only"]);
	assert.equal((await w.run(["sessions", "sess-1", "keys"], { keys: ["esc"] }, FLAGS)).status, 200);
});

test("control.run: the flags decide `remote` and the secret's status; without `operate` nothing of the above applies (a local page's `!` and probe are as before)", async () => {
	const local = direct({}, { editor: "command" });
	assert.deepEqual((await local.run(["sessions", "sess-1", "input"], { text: "!ls", as: "send" }, { remote: false, secure: false })).body, { accepted: true }, "the boss's own page may type a shell line");
	assert.equal((await local.run(["sessions", "sess-1", "keys"], { key: "ctrl+m", stream: "s" }, { remote: false, secure: false })).status, 200, "and a local Ctrl+M still goes");
	assert.equal(((await local.run(["sessions", "sess-1", "keys"], { key: "enter", stream: "s" }, { remote: false, secure: false })).body as { confirm?: string }).confirm, "command", "a local Enter on a command asks its confirm, no flags needed");
});
