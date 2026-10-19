import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ENDING as SERVER_ENDING, MAX_TEXT } from "../src/control.ts";
import type { Hub, Target } from "../src/dialogs.ts";
import { startGui, type Gui } from "../src/gui.ts";
import { HerdrError } from "../src/herdr.ts";
import { canonical } from "../src/history.ts";
import type { Editor } from "../src/probe.ts";
import type { Found } from "../src/net.ts";
import { blocked, ENDING as PAGE_ENDING, MAX_TEXT as PAGE_MAX, settle } from "../gui/composer.ts";
import { assistant, call as toolCall, header, lines, user } from "./sessions.ts";

const scratch = mkdtempSync(join(tmpdir(), "psb-control-test-"));
mkdirSync(join(scratch, "bundle"));
writeFileSync(join(scratch, "bundle", "index.html"), "<!doctype html><html><head><title>Straw Net</title></head><body></body></html>");
const running: Gui[] = [];
after(async () => {
	await Promise.all(running.map((g) => g.stop()));
	rmSync(scratch, { recursive: true, force: true });
});

const FILE = "/s/2026_sess-1.jsonl";
interface Pane { pane_id: string; agent?: string; agent_status?: string; agent_session?: { value: string } }
/** A server with one live session (sess-1 in pane wA:p1) and a fake Herdr socket that records every call. */
async function setup({ pane = {}, found = {}, fail }: { pane?: Partial<Pane>; found?: Partial<Found>; fail?: (method: string) => Error | undefined } = {}) {
	const calls: [string, Record<string, unknown>][] = [];
	let hold: Promise<void> | undefined;
	const state: Pane = { pane_id: "wA:p1", agent: "pi", agent_status: "idle", agent_session: { value: FILE }, ...pane };
	const call = async (method: string, params: Record<string, unknown>) => {
		calls.push([method, params]);
		const error = fail?.(method);
		if (error) throw error;
		if (method === "pane.get") return { pane: state };
		await hold;
		return {};
	};
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file: FILE, pane: "wA:p1", live: true, ...found } : undefined);
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	return { gui, calls, state, typed: () => calls.filter(([m]) => m !== "pane.get"), holdWith: (p: Promise<void>) => (hold = p) };
}
/** One request with the page's own headers unless told otherwise. */
function send(gui: Gui, path: string, body: unknown, headers: Record<string, string | undefined> = {}, method = "POST") {
	const data = typeof body === "string" ? body : JSON.stringify(body);
	const all: Record<string, string> = Object.fromEntries(Object.entries({ host: `127.0.0.1:${gui.port}`, origin: `http://127.0.0.1:${gui.port}`, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": gui.csrf, "content-length": String(Buffer.byteLength(data)), ...headers }).filter((e): e is [string, string] => e[1] !== undefined));
	return new Promise<{ status: number; body: { accepted?: boolean; error?: string; reason?: string; url?: string; rows?: string[] } }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: gui.port, path: `/${gui.token}/api/${path}`, method, headers: all, agent: false }, (res) => {
			let text = "";
			// A refusal before the API (token, Host) is plain text.
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, body: /^application\/json/.test(String(res.headers["content-type"])) ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(method === "GET" ? undefined : data);
	});
}
const input = (gui: Gui, text: string, as = "send", extra: Record<string, unknown> = {}) => send(gui, "sessions/sess-1/input", { text, as, ...extra });

test("send types the text with agent.prompt on the session's pane; a follow-up while it works uses Alt+Enter, while idle a prompt", async () => {
	const { gui, typed, state } = await setup();
	assert.deepEqual((await input(gui, "hello\r\nthere")).body, { accepted: true });
	assert.deepEqual((await input(gui, "later", "followUp")).body, { accepted: true }, "idle: a follow-up is just a prompt");
	state.agent_status = "working";
	assert.equal((await input(gui, "steer me")).status, 200);
	assert.equal((await input(gui, "after the task", "followUp")).status, 200);
	assert.deepEqual(typed().map(([m, p]) => [m, p.target ?? p.pane_id, p.text, p.keys]), [
		["agent.prompt", "wA:p1", "hello\nthere", undefined],
		["agent.prompt", "wA:p1", "later", undefined],
		["agent.prompt", "wA:p1", "steer me", undefined],
		["pane.send_input", "wA:p1", "after the task", ["alt+enter"]],
	], "CRLF becomes LF, and the text goes out exactly once each");
});

test("a session waiting on a dialog, a pane that left pi, and a pane reused by another session get nothing typed", async () => {
	for (const [pane, error] of [[{ agent_status: "blocked" }, "blocked"], [{ agent: "shell" }, "not_pi"], [{ agent_session: { value: "/s/2026_other.jsonl" } }, "moved"]] as const) {
		const { gui, typed } = await setup({ pane });
		const r = await input(gui, "hi");
		assert.deepEqual([r.status, r.body.error], [409, error]);
		assert.deepEqual(typed(), [], `${error}: nothing typed`);
	}
	const gone = await setup({ found: { live: false } });
	assert.deepEqual([(await input(gone.gui, "hi")).status, gone.calls.length], [409, 0], "a key that left the net does not reach Herdr");
	assert.equal((await send(gone.gui, "sessions/nobody/input", { text: "hi", as: "send" })).status, 404);
});

test("Stop sends Escape alone with no mirror, never Ctrl+C or Ctrl+D; any other key needs the pad's form", async () => {
	const { gui, typed, state } = await setup();
	for (const keys of [["ctrl+c"], ["ctrl+d"], ["esc", "ctrl+c"], [], ["x"], ["up", "enter"], ["enter"], ["down", "enter"], ["esc", "esc"], Array(17).fill("esc"), "esc"]) assert.equal((await send(gui, "sessions/sess-1/keys", { keys })).status, 400, JSON.stringify(keys));
	state.agent_status = "working";
	assert.equal((await send(gui, "sessions/sess-1/keys", { keys: ["esc"] })).status, 200);
	state.agent_status = "blocked";
	assert.equal((await send(gui, "sessions/sess-1/keys", { keys: ["esc"] })).status, 200, "also while it waits on a dialog");
	assert.equal((await send(gui, "sessions/sess-1/focus", {})).status, 200);
	assert.deepEqual(typed().map(([m, p]) => [m, p.keys ?? p.target]), [["pane.send_input", ["esc"]], ["pane.send_input", ["esc"]], ["agent.focus", "wA:p1"]]);
});

/** A server with a mirror on sess-1, whose session file is `entries`, the hub's dialog `target` and editor check `editor`, and a stream that said hello. */
async function padded({ entries = [header(), user("u1", null, "go")] as unknown[], editor = { editor: "empty" } as Editor | undefined, answerable = false } = {}) {
	const path = join(scratch, `pad-${Math.random().toString(36).slice(2)}_sess-1.jsonl`);
	writeFileSync(path, lines(entries));
	const file = canonical(path)!, calls: [string, Record<string, unknown>][] = [], w = { editor, answerable, status: "idle", probes: 0, moveDuringProbe: false, moved: false };
	const call = async (method: string, params: Record<string, unknown>) => {
		calls.push([method, { ...params, ...(method === "pane.send_input" && { at: Date.now() }) }]);
		if (method === "pane.get") return { pane: { pane_id: "wA:p1", agent: "pi", agent_status: w.status, agent_session: { value: w.moved ? "/s/other_sess-9.jsonl" : file } } };
		if (method === "pane.layout") return { layout: { panes: [{ pane_id: "wA:p1", rect: { width: 40 } }] } };
		return method === "pane.read" ? { read: { text: "pi\r\n> " } } : {};
	};
	const target = { from: "S", bridgeId: "B", answer: { dialog: "d1", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "A" }] } } } as Target;
	const hub = { running: true, me: "G", start() {}, stop() {}, receive() {}, relayed: () => ({ dialogsOf: () => undefined, merge: () => ({ callId: "", tool: "" }) }), replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: {} }), target: () => (w.answerable ? target : undefined), probe: async () => (w.probes++, (w.moved = w.moveDuringProbe), w.editor) };
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file, pane: "wA:p1", live: true } : undefined);
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, hub: hub as unknown as Hub, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	const events: string[] = [];
	const req = get(`${gui.url}events`, { headers: { host: `127.0.0.1:${gui.port}` } }, (res) => res.setEncoding("utf8").on("data", (c: string) => events.push(c)));
	const wait = async (what: () => boolean) => { for (let i = 0; i < 100 && !what(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(what()); };
	await wait(() => events.join("").includes("event: hello"));
	const stream = /"stream":"([0-9a-f]+)"/.exec(events.join(""))![1]!;
	const sentKeys = () => calls.filter(([m]) => m === "pane.send_input").map(([, p]) => p.keys);
	// (each send_input is recorded with the time Herdr got it)
	return { gui, w, calls, stream, events, wait, sentKeys, close: () => req.destroy(), key: (key: string, extra: Record<string, unknown> = {}) => send(gui, "sessions/sess-1/keys", { key, stream, ...extra }), attach: async () => (assert.equal((await send(gui, "sessions/sess-1/mirror", { stream, on: true })).status, 200), await wait(() => events.join("").includes("event: mirror"))) };
}

test("the pad: one key per request, only with this page's mirror attached and current, and exactly that key reaches Herdr", async () => {
	const p = await padded();
	assert.equal((await p.key("up")).body.error, "no_mirror", "before the mirror is attached");
	await p.attach();
	assert.equal((await p.key("up", { stream: "f".repeat(32) })).body.error, "no_mirror", "another stream");
	// A desktop's chords go (keys.test.ts); a letter alone, Ctrl+Z, and anything Herdr would read otherwise never do.
	for (const k of ["a", "/", "!", "ctrl+z", "ctrl+shift+a", "meta+v", "alt+up"]) assert.equal((await p.key(k)).status, 400, k);
	assert.equal((await send(p.gui, "sessions/sess-1/keys", { keys: ["up"], stream: p.stream })).status, 400, "the old form carries only Stop's Escape");
	assert.equal((await p.key("up", { keys: ["enter"] })).status, 400, "one key per request");
	for (const k of ["up", "down", "tab", "3"]) assert.deepEqual((await p.key(k)).body, { accepted: true });
	assert.deepEqual(p.sentKeys(), [["up"], ["down"], ["tab"], ["3"]], "exactly pane.send_input {keys: [key]}");
	assert.deepEqual((await p.key("pagedown")).body, { accepted: true });
	assert.deepEqual(p.calls.filter(([m]) => m === "pane.send_text"), [["pane.send_text", { pane_id: "wA:p1", text: "\x1b[6~" }]], "a key Herdr cannot name goes as its fixed sequence");
	assert.deepEqual((await p.key("enter")).body, { accepted: true }, "an empty editor: Enter goes");
	await new Promise((r) => setTimeout(r, 1000)); // a fresh second
	let ok = 0, last = await p.key("down");
	for (; last.status === 200 && ok < 9; last = await p.key("down")) ok++;
	assert.deepEqual([ok, last.status, last.body.error], [8, 429, "rate"], "8 keys a second");
	assert.equal((await send(p.gui, "sessions/sess-1/mirror", { stream: p.stream, on: false })).status, 200);
	await new Promise((r) => setTimeout(r, 1100));
	assert.equal((await p.key("down")).body.error, "no_mirror", "detached");
	p.close();
});

test("the pad: up recalls /reload, then Enter needs the confirm that names it; an unread editor and a slash command need theirs", async () => {
	const p = await padded();
	await p.attach();
	assert.equal((await p.key("up")).status, 200);
	p.w.editor = { editor: "text", ending: "reload" };
	const asked = await p.key("enter");
	assert.deepEqual([asked.status, asked.body.error, (asked.body as { confirm?: string }).confirm], [409, "confirm", "reload"]);
	assert.match(String(asked.body.reason), /\/reload/);
	assert.equal((await p.key("enter", { confirmed: true })).status, 409);
	assert.equal((await p.key("enter", { confirmed: "reload" })).status, 200);
	p.w.editor = undefined;
	assert.equal(((await p.key("enter")).body as { confirm?: string }).confirm, "unread", "no bridge, or no answer in 1 s");
	p.w.editor = { editor: "command" };
	assert.equal(((await p.key("enter")).body as { confirm?: string }).confirm, "command");
	assert.deepEqual(p.sentKeys(), [["up"], ["enter"]], "nothing unconfirmed reached Herdr");
	p.w.editor = { editor: "empty" };
	p.w.moveDuringProbe = true; // the pane switched to another session file while the bridge answered
	assert.equal((await p.key("enter")).body.error, "moved");
	assert.deepEqual(p.sentKeys(), [["up"], ["enter"]]);
	p.close();
});

test("the pad: while the open call is secret_drop the mirror is hidden and only Escape goes; an answerable dialog takes only Escape too", async () => {
	const p = await padded({ entries: [header(), user("u1", null, "go"), assistant("a1", "u1", [toolCall("c1", "secret_drop", { label: "token" })])] });
	await p.attach();
	await p.wait(() => p.events.join("").includes('"hidden":true'));
	assert.ok(!/"set"/.test(p.events.join("")), "no rows were sent");
	for (const k of ["1", "enter", "up"]) assert.equal((await p.key(k)).body.error, "blocked", k);
	assert.equal(p.w.probes, 0);
	assert.equal((await p.key("esc")).status, 200);
	p.close();
	const q = await padded({ answerable: true });
	await q.attach();
	q.w.status = "blocked";
	assert.equal((await q.key("1")).body.error, "blocked");
	assert.equal((await q.key("esc")).status, 200);
	q.w.answerable = false;
	assert.equal((await q.key("1")).status, 200, "a dialog the page cannot answer takes digits (U7)");
	assert.deepEqual(q.sentKeys(), [["esc"], ["1"]]);
	q.close();
});

test("the pad: a second Escape within 1 s to an idle session asks first; confirmed, pi gets its pair", async () => {
	const p = await padded();
	await p.attach();
	assert.equal((await p.key("esc")).status, 200);
	const second = await p.key("esc");
	assert.deepEqual([second.status, (second.body as { confirm?: string }).confirm], [409, "double-esc"]);
	await new Promise((r) => setTimeout(r, 600));
	assert.equal((await p.key("esc", { confirmed: "double-esc" })).status, 200);
	assert.deepEqual(p.sentKeys(), [["esc"], ["esc"], ["esc"]], "the pair as two writes of one Escape");
	const [a, b] = p.calls.filter(([m]) => m === "pane.send_input").slice(-2).map(([, q]) => q.at as number);
	assert.ok(b! - a! >= 50 && b! - a! < 400, `apart, and within pi's 500 ms (${b! - a!} ms)`);
	p.close();
});

/** A server whose hub answers for sess-1 with `target`; `send` records what reached the bridge and answers with `reply`. */
async function answering({ reply = { status: 200, body: { outcome: "accepted" } } as { status: number; body: { outcome: string } } | Promise<{ status: number; body: { outcome: string } }>, pane = {} as Partial<Pane> } = {}) {
	const calls: [string, Record<string, unknown>][] = [], sent: unknown[] = [], stored = new Map<string, { status: number; body: unknown }>();
	const state: Pane = { pane_id: "wA:p1", agent: "pi", agent_status: "blocked", agent_session: { value: FILE }, ...pane };
	const call = async (method: string, params: Record<string, unknown>) => (calls.push([method, params]), method === "pane.get" ? { pane: state } : {});
	const answer = { dialog: "d1", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "Run it" }, { label: "Copy", localOnly: true as const }] } };
	const hub = {
		target: { from: "S", bridgeId: "B", answer } as Target | undefined,
		running: true, me: "G", start() {}, stop() {}, receive() {}, relayed: () => ({ dialogsOf: () => undefined, merge: () => ({ callId: "", tool: "" }) }),
		replay: (id: string, key: string) => (key === "sess-1" ? stored.get(id) : undefined),
		ended: (key: string, dialog: string) => (key === "sess-1" && dialog === "d-closed" ? { status: 200, body: { outcome: "stale", by: "local" } } : undefined),
		send: async (_key: string, t: Target, a: { answerId: string }) => (sent.push({ to: t.bridgeId, ...a }), stored.set(a.answerId, await reply), reply),
		commands: async (_key: string, prefix: string) => (prefix === "silent" ? undefined : [{ name: `${prefix}x`, source: "skill" }]),
	};
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file: FILE, pane: "wA:p1", live: true } : undefined);
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, hub: { ...hub, target: () => hub.target } as unknown as Hub, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	return { gui, calls, sent, hub, answer, state, typed: () => calls.filter(([m]) => m !== "pane.get") };
}
const body = (extra: Record<string, unknown> = {}) => ({ dialog: "d1", digest: "a".repeat(64), answerId: "a".repeat(16), choice: 0, ...extra });

test("commands: the session's matching commands come from its bridge with no Herdr call; a prefix that is no name start is refused, and a silent session gives null", async () => {
	const { gui, calls } = await answering();
	assert.deepEqual(await send(gui, "sessions/sess-1/commands", { prefix: "re" }), { status: 200, body: { commands: [{ name: "rex", source: "skill" }] } });
	assert.deepEqual(await send(gui, "sessions/sess-1/commands", { prefix: "silent" }), { status: 200, body: { commands: null } });
	for (const prefix of ["a b", "x".repeat(65), 3, undefined]) assert.equal((await send(gui, "sessions/sess-1/commands", { prefix })).status, 400, String(prefix));
	assert.equal((await send(gui, "sessions/nope/commands", { prefix: "" })).status, 404);
	assert.deepEqual(calls, [], "no Herdr call");
});

test("answer: the bridge gets the checked answer, nothing is typed into Herdr, and the same answer again replays its outcome", async () => {
	const { gui, sent, typed, calls } = await answering();
	assert.deepEqual(await send(gui, "sessions/sess-1/answer", body()), { status: 200, body: { outcome: "accepted" } });
	assert.deepEqual(sent, [{ to: "B", id: "d1", answerId: "a".repeat(16), digest: "a".repeat(64), choice: 0 }]);
	assert.deepEqual(await send(gui, "sessions/sess-1/answer", body()), { status: 200, body: { outcome: "accepted" } });
	assert.equal(sent.length, 1, "a replay never reaches the bridge again");
	assert.deepEqual(typed(), [], "no key and no text reach Herdr");
	assert.deepEqual(calls.map(([m]) => m), ["pane.get"], "only the pane check");
});

test("answer: the write guards, then the body, then the dialog it names must still be the one open here", async () => {
	const { gui, sent, hub, state } = await answering();
	assert.equal((await send(gui, "sessions/sess-1/answer", body(), { origin: "http://evil.test" })).status, 403);
	assert.equal((await send(gui, "sessions/sess-1/answer", body(), { "x-sb-csrf": "nope" })).status, 403);
	assert.equal((await send(gui, "sessions/sess-1/answer", body(), { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await send(gui, "sessions/sess-1/answer", body(), { "content-type": "text/plain" })).status, 415);
	assert.equal((await send(gui, "sessions/sess-1/answer", body(), {}, "GET")).status, 405);
	for (const bad of [{ dialog: undefined }, { dialog: "x".repeat(65) }, { digest: "A".repeat(64) }, { digest: "a" }, { answerId: "short" }, { answerId: "a".repeat(15) + "!" }]) assert.equal((await send(gui, "sessions/sess-1/answer", body(bad))).status, 400, JSON.stringify(bad));
	assert.equal((await send(gui, "sessions/sess-1/answer", body({ choice: 2, answerId: "b".repeat(16) }))).body.error, "bad_answer");
	assert.equal((await send(gui, "sessions/sess-1/answer", body({ choice: 0, answers: [], answerId: "b".repeat(16) }))).body.error, "bad_answer");
	assert.equal((await send(gui, "sessions/sess-1/answer", body({ digest: "b".repeat(64), answerId: "c".repeat(16) }))).body.error, "changed");
	assert.equal((await send(gui, "sessions/sess-1/answer", body({ dialog: "d0", answerId: "c".repeat(16) }))).body.error, "changed");
	assert.deepEqual(await send(gui, "sessions/sess-1/answer", body({ dialog: "d-closed", answerId: "c".repeat(16) })), { status: 200, body: { outcome: "stale", by: "local" } }, "answered in the terminal a moment ago");
	hub.target = undefined;
	assert.equal((await send(gui, "sessions/sess-1/answer", body({ answerId: "d".repeat(16) }))).status, 409, "no answerable dialog (a secret_drop has none)");
	state.agent_session = { value: "/s/other.jsonl" };
	assert.equal((await send(gui, "sessions/sess-1/answer", body({ answerId: "e".repeat(16) }))).body.error, "moved");
	assert.equal((await send(gui, "sessions/nobody/answer", body({ answerId: "e".repeat(16) }))).status, 404);
	assert.deepEqual(sent, []);
});

test("answer: one at a time per session; a bridge that never confirms is 504 unknown, and Check again asks once more", async () => {
	let release!: (r: { status: number; body: { outcome: string } }) => void;
	const { gui, sent } = await answering({ reply: new Promise((resolve) => (release = resolve)) });
	const first = send(gui, "sessions/sess-1/answer", body());
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal((await send(gui, "sessions/sess-1/answer", body({ answerId: "b".repeat(16) }))).status, 429);
	release({ status: 504, body: { outcome: "unknown" } });
	assert.deepEqual(await first, { status: 504, body: { outcome: "unknown" } });
	assert.equal(sent.length, 1);
});

test("commands that end or replace the session need confirmed, and the page and the server agree on which they are", async () => {
	const { gui, typed } = await setup();
	for (const text of ["/quit", " /exit", "/new", "/resume abc", "/fork", "/clone", "/import ~/old.jsonl", "/reload"]) {
		assert.equal((await input(gui, text)).body.error, "confirm", text);
		assert.ok(PAGE_ENDING.test(text));
	}
	assert.deepEqual(typed(), []);
	assert.equal((await input(gui, "/quit", "send", { confirmed: true })).status, 200);
	for (const text of ["/quitter", "/model", "please /quit", "! ls"]) assert.equal((await input(gui, text)).status, 200, text);
	assert.equal(PAGE_ENDING.source, SERVER_ENDING.source);
	assert.equal(PAGE_MAX, MAX_TEXT);
});

test("text with control characters, empty text, text over 16 KB, and a bad body are refused before Herdr", async () => {
	const { gui, calls } = await setup();
	for (const text of ["a\x1b[201~\x03", "\x04", "a\u009bb", "   "]) assert.equal((await input(gui, text)).status, 400, JSON.stringify(text));
	assert.equal((await input(gui, "é".repeat(MAX_TEXT / 2 + 1))).status, 413, "16 KB counts bytes");
	assert.equal((await input(gui, "tab\tand\nline")).status, 200);
	assert.equal((await input(gui, "x", "push")).status, 400);
	assert.equal((await send(gui, "sessions/sess-1/input", "not json")).status, 400);
	assert.equal((await send(gui, "sessions/sess-1/input", { text: "x".repeat(70_000), as: "send" })).status, 413, "the body is capped at 64 KB");
	assert.equal(calls.length, 2, "only the good input reached Herdr (pane.get, agent.prompt)");
});

test("writes need the page's origin, same-origin fetch metadata, JSON, the CSRF secret, and POST", async () => {
	const { gui, calls } = await setup();
	const body = { text: "hi", as: "send" };
	assert.equal((await send(gui, "sessions/sess-1/input", body, { origin: undefined })).status, 403, "no Origin");
	assert.equal((await send(gui, "sessions/sess-1/input", body, { origin: "http://evil.example" })).status, 403);
	assert.equal((await send(gui, "sessions/sess-1/input", body, { origin: `http://localhost:${gui.port}` })).status, 403);
	assert.equal((await send(gui, "sessions/sess-1/input", body, { "sec-fetch-site": "cross-site" })).status, 403);
	assert.equal((await send(gui, "sessions/sess-1/input", body, { "x-sb-csrf": undefined })).status, 403);
	assert.equal((await send(gui, "sessions/sess-1/input", body, { "x-sb-csrf": "0".repeat(32) })).status, 403);
	assert.equal((await send(gui, "sessions/sess-1/input", body, { "content-type": "text/plain" })).status, 415);
	assert.equal((await send(gui, "sessions/sess-1/input", body, { host: "evil.example" })).status, 403, "a rebound Host");
	assert.equal((await send(gui, "sessions/sess-1/input", body, {}, "GET")).status, 405);
	assert.equal(calls.length, 0);
	assert.equal((await send(gui, "sessions/sess-1/input", body, { "sec-fetch-site": undefined, "content-type": "application/json; charset=utf-8" })).status, 200, "a client without fetch metadata, and a charset, are fine");
});

test("one input per session at a time; a Herdr timeout is reported, not retried, and Herdr's own refusals keep their code", async () => {
	let release!: () => void;
	const busy = await setup();
	busy.holdWith(new Promise<void>((resolve) => (release = resolve)));
	const first = input(busy.gui, "one");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal((await input(busy.gui, "two")).status, 429);
	release();
	assert.equal((await first).status, 200);
	const slow = await setup({ fail: (m) => (m === "agent.prompt" ? new HerdrError("timeout", "no answer") : undefined) });
	const r = await input(slow.gui, "hi");
	assert.deepEqual([r.status, r.body.error], [504, "timeout"]);
	assert.match(r.body.reason!, /Check the terminal/);
	assert.equal(slow.typed().length, 1, "sent once");
	const refused = await setup({ fail: (m) => (m === "agent.prompt" ? new HerdrError("agent_blocked", "blocked") : undefined) });
	assert.deepEqual([(await input(refused.gui, "hi")).status, (await input(refused.gui, "hi")).body.error], [409, "agent_blocked"]);
});

test("a pairing code is refused while remote access is off", async () => {
	const { gui } = await setup();
	const r = await send(gui, "remote/pair", {});
	assert.deepEqual([r.status, r.body.error], [409, "remote_off"]);
});

test("the composer clears only what was confirmed, and says why it cannot send", () => {
	assert.equal(settle("hello", "hello"), "");
	assert.equal(settle("hello\nmore", "hello"), "more", "text typed after the send stays");
	assert.equal(settle("hellO", "hello"), "hellO", "an edit inside the sent text keeps everything");
	const unit = { name: "u", control: true, live: true, mark: "idle" as const, online: true };
	assert.equal(blocked(unit), undefined);
	assert.match(blocked({ ...unit, online: false })!, /stream is down/);
	assert.match(blocked({ ...unit, live: false })!, /no longer live/);
	assert.match(blocked({ ...unit, control: false })!, /No live pi pane/);
	assert.match(blocked({ ...unit, mark: "waiting" })!, /dialog/);
});
