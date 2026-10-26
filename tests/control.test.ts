import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { get, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ENDING as SERVER_ENDING, MAX_TEXT } from "../src/control.ts";
import { withPending } from "../src/ask.ts";
import { createHub, type Hub, type Target } from "../src/dialogs.ts";
import { startGui, type Gui } from "../src/gui.ts";
import { HerdrError } from "../src/herdr.ts";
import { createApproval } from "../src/link/approval.ts";
import { ACTIONS, HERE_ONLY } from "../src/link/request.ts";
import { canonical } from "../src/history.ts";
import type { Editor } from "../src/probe.ts";
import type { Found, Net, Ref } from "../src/net.ts";
import { type Dialog, linkRequest } from "../src/owners.ts";
import { REGISTER } from "../src/bridge.ts";
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
async function setup({ pane = {}, found = {}, fail, link }: { pane?: Partial<Pane>; found?: Partial<Found>; fail?: (method: string) => Error | undefined; link?: import("../src/control.ts").LinkPort } = {}) {
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
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [] }, call, link, dir: join(scratch, "bundle"), pollMs: 50 });
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

const HOST = "box.tail1.ts.net:8443", LOGIN = "me@example.com";
/** A device paired to `gui` through its remote listener, as tailscale serve forwards it: `post` is a write from its page. */
async function paired(gui: Gui) {
	const tailnet = { host: HOST, "tailscale-user-login": LOGIN, "x-forwarded-for": "100.87.7.97" };
	gui.access.enable({ host: HOST, login: LOGIN });
	const ask = (path: string, headers: Record<string, string>, method: string, payload?: unknown) => new Promise<{ status: number; headers: Record<string, unknown>; body: { error?: string; reason?: string; outcome?: string; accepted?: boolean } }>((resolve, reject) => {
		const data = payload === undefined ? "{}" : JSON.stringify(payload);
		const req = request({ host: "127.0.0.1", port: gui.remotePort, path, method, headers: { ...headers, ...(method === "POST" ? { "content-length": String(Buffer.byteLength(data)) } : {}) }, agent: false }, (res) => {
			let text = "";
			res.on("data", (c) => (text += c)).on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: /^application\/json/.test(String(res.headers["content-type"])) ? JSON.parse(text) : {} }));
		});
		req.on("error", reject).end(method === "POST" ? data : undefined);
	});
	const cookie = String((await ask(`/${gui.token}/pair/${gui.access.pair()}`, tailnet, "GET")).headers["set-cookie"]).split(";")[0]!;
	return { cookie, post: (path: string, payload?: unknown) => ask(`/${gui.token}/api/${path}`, { ...tailnet, cookie, origin: `https://${HOST}`, "content-type": "application/json", "x-sb-csrf": gui.csrf }, "POST", payload) };
}

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
	const file = canonical(path)!, calls: [string, Record<string, unknown>][] = [], w = { editor, answerable, status: "idle", probes: 0, moveDuringProbe: false, moved: false, armed: false, afterProbe: false, opens: undefined as (() => void) | undefined, relayedRequest: false };
	const call = async (method: string, params: Record<string, unknown>) => {
		calls.push([method, { ...params, ...(method === "pane.send_input" && { at: Date.now() }) }]);
		if (method === "pane.get" && w.armed) {
			w.armed = false;
			w.opens?.();
		}
		if (method === "pane.get") return { pane: { pane_id: "wA:p1", agent: "pi", agent_status: w.status, agent_session: { value: w.moved ? "/s/other_sess-9.jsonl" : file } } };
		if (method === "pane.layout") return { layout: { panes: [{ pane_id: "wA:p1", rect: { width: 40 } }] } };
		return method === "pane.read" ? { read: { text: "pi\r\n> " } } : {};
	};
	const target = { from: "S", bridgeId: "B", answer: { dialog: "d1", digest: "a".repeat(64), select: { title: "T", choices: [{ label: "A" }] } } } as Target;
	const hub = { running: true, me: "G", start() {}, stop() {}, receive() {}, relayed: () => ({ dialogsOf: () => undefined, merge: () => ({ callId: "", tool: "" }) }), has: (_key: string, owner: string) => w.relayedRequest && owner === "straw-link-request", replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: {} }), target: () => (w.answerable ? target : undefined), probe: async () => (w.probes++, (w.moved = w.moveDuringProbe), (w.armed = w.afterProbe), w.editor) };
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
	return { gui, w, path, calls, stream, events, wait, sentKeys, close: () => req.destroy(), key: (key: string, extra: Record<string, unknown> = {}) => send(gui, "sessions/sess-1/keys", { key, stream, ...extra }), attach: async () => (assert.equal((await send(gui, "sessions/sess-1/mirror", { stream, on: true })).status, 200), await wait(() => events.join("").includes("event: mirror"))) };
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
		pull: async (_key: string, step: string) => (step === "begin" ? { pending: true, ticket: "T" } : { text: "queued text" }),
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
	assert.match(blocked({ ...unit, control: false, agent: "claude" })!, /This is a Claude session\. It is in the net, but this page cannot type into it/, "an agent that is not pi says what it is, not that a pi pane is missing");
	assert.match(blocked({ ...unit, mark: "waiting" })!, /dialog/);
});

test("answer: a paired device answers a confirmation and a local-only choice as this computer's page does; a secret's value is still refused", async () => {
	const { gui, sent, hub } = await answering();
	const confirm = { title: "mp-infra command review\n\nssh box ls", choices: [{ label: "Yes" }, { label: "No" }], confirm: true as const };
	const phone = await paired(gui);
	hub.target = { from: "S", bridgeId: "B", answer: { dialog: "d1", digest: "a".repeat(64), select: confirm } } as Target;
	const taken = await phone.post("sessions/sess-1/answer", body());
	assert.deepEqual([taken.status, taken.body.outcome], [200, "accepted"], "a confirm is answered from a paired device");
	assert.equal(sent.length, 1);
	assert.deepEqual(await send(gui, "sessions/sess-1/answer", body({ answerId: "b".repeat(16) })), { status: 200, body: { outcome: "accepted" } }, "and from this computer's page");
	hub.target = { from: "S", bridgeId: "B", answer: { dialog: "d1", digest: "a".repeat(64), select: { title: "Which?", choices: [{ label: "Run it" }, { label: "Copy", localOnly: true as const }] } } } as Target;
	const copy = await phone.post("sessions/sess-1/answer", body({ answerId: "c".repeat(16), choice: 1 }));
	assert.deepEqual([copy.status, copy.body.outcome], [200, "accepted"], "a choice that acts on the computer is taken from a paired device too");
	assert.equal(sent.length, 3);
	const secret = await phone.post("sessions/sess-1/answer", body({ answerId: "d".repeat(16), value: "s3cr3t" }));
	assert.deepEqual([secret.status, secret.body.error], [403, "local_only"], "a secret is entered in the terminal only");
	assert.equal(sent.length, 3);
});

test("answer: a link_request approval of trust, remove, role, rotate, or leave is refused from a paired device and given from this computer's page; Deny and every other action's Approve are taken from both", async () => {
	const { gui, sent, hub } = await answering();
	const phone = await paired(gui);
	let n = 0;
	const answerId = () => String(++n).padStart(16, "0");
	for (const action of ACTIONS) {
		// the real dialog the approval publishes for this action, as the bridge would hand it to the page
		const handlers = new Map<string, (d: unknown) => void>(), published: { digest: string; select: Target["answer"]["select"] }[] = [];
		const bus = { emit: (channel: string, data: unknown) => (channel.endsWith(":pending") && published.push(data as (typeof published)[number]), undefined), on: (channel: string, h: (d: unknown) => void) => (handlers.set(channel, h), () => handlers.delete(channel)) };
		const approval = createApproval({ bus });
		const verdict = approval.approve({ toolCallId: "tc", lines: [`Action: ${action}`], asker: "s", hereOnly: (HERE_ONLY as readonly string[]).includes(action), signal: AbortSignal.timeout(2000) });
		verdict.catch(() => undefined);
		const { digest, select } = published[0]!;
		hub.target = { from: "S", bridgeId: "B", answer: { dialog: "d1", digest, select } } as Target;
		type Out = { status: number; body: { error?: string; outcome?: string } };
		const post = async (who: typeof phone | undefined, choice: number) => (await (who ? who.post("sessions/sess-1/answer", body({ digest, answerId: answerId(), choice })) : send(gui, "sessions/sess-1/answer", body({ digest, answerId: answerId(), choice })))) as Out;
		const before = sent.length, here = (HERE_ONLY as readonly string[]).includes(action);
		const remoteApprove = await post(phone, 0);
		if (here) assert.deepEqual([remoteApprove.status, remoteApprove.body.error, sent.length], [403, "local_only", before], `${action}: a paired device cannot approve`);
		else assert.deepEqual([remoteApprove.status, remoteApprove.body.outcome, sent.length], [200, "accepted", before + 1], `${action}: a paired device approves`);
		const remoteDeny = await post(phone, 1);
		assert.deepEqual([remoteDeny.status, remoteDeny.body.outcome], [200, "accepted"], `${action}: a paired device can deny`);
		const localApprove = await post(undefined, 0);
		assert.deepEqual([localApprove.status, localApprove.body.outcome], [200, "accepted"], `${action}: this computer's page approves`);
		assert.equal(sent.length, before + (here ? 2 : 3), `${action}: what reached the bridge`);
	}
});

test("while a link_request call is open (two dialogs, so none is answerable), a paired device's keys, typed text, paste, and prompts are refused except Escape; this computer's page and a session with no link_request open are not limited", async () => {
	const open = [header(), user("u1", null, "go"), assistant("a1", "u1", [toolCall("c1", "link_request", { action: "trust" }), toolCall("c2", "ask_user", { question: "Also?" })])];
	const p = await padded({ entries: open });
	await p.attach();
	const phone = await paired(p.gui), keys = (payload: Record<string, unknown>) => phone.post("sessions/sess-1/keys", { stream: p.stream, ...payload });
	p.w.status = "blocked"; // pi shows its terminal confirm: Enter there is Yes
	for (const k of ["enter", "1", "up", "tab", "space"]) {
		const r = await keys({ key: k });
		assert.deepEqual([r.status, r.body.error], [403, "local_only"], `remote ${k}`);
	}
	assert.deepEqual([(await keys({ key: "enter", confirmed: "unread" })).status, (await keys({ text: "y" })).status, (await keys({ paste: "yes" })).status], [403, 403, 403], "confirming the probe, typing, and pasting do not get past it");
	assert.equal(p.w.probes, 0, "the editor was never probed for a remote Enter");
	assert.deepEqual(p.sentKeys(), [], "nothing reached Herdr");
	p.w.status = "idle";
	const prompt = await phone.post("sessions/sess-1/input", { text: "go", as: "send" });
	assert.deepEqual([prompt.status, prompt.body.error], [403, "local_only"], "a prompt ends in Enter too");
	assert.equal(p.calls.filter(([m]) => m === "agent.prompt").length, 0);
	p.w.status = "blocked";
	await new Promise((r) => setTimeout(r, 1100)); // a fresh second for the rate
	assert.deepEqual((await keys({ key: "esc" })).body, { accepted: true }, "Escape (No) is allowed");
	assert.deepEqual((await phone.post("sessions/sess-1/keys", { keys: ["esc"] })).body, { accepted: true }, "and Stop's");
	assert.deepEqual((await p.key("enter")).body, { accepted: true }, "this computer's page may press Enter");
	assert.deepEqual((await p.key("1")).body, { accepted: true });
	assert.deepEqual(p.sentKeys(), [["esc"], ["esc"], ["enter"], ["1"]]);
	p.close();
	const q = await padded({ entries: [header(), user("u1", null, "go"), assistant("a1", "u1", [toolCall("c1", "ask_user", { question: "A?" }), toolCall("c2", "ask_user", { question: "B?" })])] });
	await q.attach();
	const other = await paired(q.gui);
	q.w.status = "blocked";
	for (const k of ["enter", "1"]) assert.deepEqual((await other.post("sessions/sess-1/keys", { key: k, stream: q.stream })).body, { accepted: true }, `no link_request open: remote ${k}`);
	q.close();
});

test("RR-F001: a link_request call that opens after the guard looked (Enter: during the last pane look after the editor probe) still stops a paired device's Enter, typed text, and prompt before they are written; this computer's page is not limited", async () => {
	const opened = [header(), user("u1", null, "go"), assistant("a1", "u1", [toolCall("c1", "link_request", { action: "trust" })])];
	const p = await padded();
	await p.attach();
	const phone = await paired(p.gui);
	p.w.opens = () => writeFileSync(p.path, lines(opened));
	const close = () => { p.w.armed = p.w.afterProbe = false; writeFileSync(p.path, lines([header(), user("u1", null, "go")])); };
	p.w.afterProbe = true; // the next pane look after the probe is where the call opens
	const enter = await phone.post("sessions/sess-1/keys", { key: "enter", stream: p.stream });
	assert.deepEqual([enter.status, enter.body.error, p.sentKeys()], [403, "local_only", []], "Enter");
	close();
	await new Promise((r) => setTimeout(r, 1100));
	p.w.armed = true; // the pane look that comes first
	const typed = await phone.post("sessions/sess-1/keys", { text: "y", stream: p.stream });
	assert.deepEqual([typed.status, typed.body.error, p.calls.filter(([m]) => m === "pane.send_text").length], [403, "local_only", 0], "typed text");
	close();
	p.w.armed = true;
	const prompt = await phone.post("sessions/sess-1/input", { text: "go", as: "send" });
	assert.deepEqual([prompt.status, prompt.body.error, p.calls.filter(([m]) => m === "agent.prompt").length], [403, "local_only", 0], "a prompt");
	close();
	await new Promise((r) => setTimeout(r, 1100));
	p.w.afterProbe = true;
	assert.deepEqual((await p.key("enter")).body, { accepted: true }, "this computer's page: Enter goes");
	assert.deepEqual(p.sentKeys(), [["enter"]]);
	p.close();
});

test("RR2-F001: while the owner relays an open link_request dialog, a paired device's Enter, typed text, and prompt are refused even when the session file shows no link_request call (a call nested in codemode is not in the file); Escape and this computer's page are not limited", async () => {
	const p = await padded();
	await p.attach();
	const phone = await paired(p.gui);
	p.w.status = "blocked";
	p.w.relayedRequest = true;
	const enter = await phone.post("sessions/sess-1/keys", { key: "enter", stream: p.stream });
	assert.deepEqual([enter.status, enter.body.error, p.sentKeys()], [403, "local_only", []], "Enter");
	const prompt = await phone.post("sessions/sess-1/input", { text: "go", as: "send" });
	assert.deepEqual([prompt.status, prompt.body.error], [403, "local_only"], "a prompt");
	await new Promise((r) => setTimeout(r, 1100));
	assert.deepEqual((await phone.post("sessions/sess-1/keys", { key: "esc", stream: p.stream })).body, { accepted: true }, "Escape");
	assert.deepEqual((await p.key("enter")).body, { accepted: true }, "this computer's page");
	p.w.relayedRequest = false;
	await new Promise((r) => setTimeout(r, 1100));
	assert.deepEqual((await phone.post("sessions/sess-1/keys", { key: "enter", stream: p.stream })).body, { accepted: true }, "closed: Enter goes");
	p.close();
});

test("RC-F004: a link_request approval a bridge relays (the owner's listener, the hub's checks, the net's binding) keeps hereOnly end to end: a paired device's Approve gets 403 and never reaches the bridge, Deny and this computer's Approve do", async () => {
	const path = join(scratch, `relay-${Math.random().toString(36).slice(2)}_sess-1.jsonl`);
	writeFileSync(path, lines([header(), user("u1", null, "go"), assistant("a1", "u1", [toolCall("c1", "link_request", { action: "trust" })])]));
	const file = canonical(path)!;
	// the real approval dialog of a trust request, as the owner's adapter reads it off the bus into the dialog the bridge relays
	const handlers = new Map<string, (d: unknown) => void>(), published: unknown[] = [];
	const bus = { emit: (channel: string, data: unknown) => (channel.endsWith(":pending") && published.push(data), undefined), on: (channel: string, h: (d: unknown) => void) => (handlers.set(channel, h), () => handlers.delete(channel)) };
	const verdict = createApproval({ bus }).approve({ toolCallId: "c1", lines: ["Action: trust"], asker: "s", hereOnly: true, signal: AbortSignal.timeout(3000) });
	verdict.catch(() => undefined);
	const dialogs: Dialog[] = [];
	linkRequest.listen({ emit() {}, on: (channel: string, h: (d: unknown) => void) => (channel.endsWith(":pending") && h(published[0]), () => {}) } as never, { open: (_o, d) => void dialogs.push(d), closed() {} });
	assert.equal(dialogs.length, 1, "the owner's adapter read the dialog");
	assert.deepEqual(dialogs[0]!.select!.choices.map((c) => [c.label, c.hereOnly]), [["Approve", true], ["Deny", undefined]], "the adapter kept the flag");
	// the hub, with this session as the bridge's own (answers are delivered in-process)
	const delivered: unknown[] = [];
	const events = { emit: (ch: string, r: never) => ch === REGISTER && (r as { onReady(c: unknown): void }).onReady({ snapshot: () => ({ connected: true, owner: { sessionId: "S", epoch: "e1" } }), publish() {} }), on: () => () => {} };
	let hub: Hub;
	const local = { deliver: (m: { id: string; answerId: string; to: string }, r: (a: unknown) => void) => { delivered.push(m); r({ version: 1, type: "ack", bridgeId: m.to, id: m.id, answerId: m.answerId, outcome: "accepted" }); }, sync() {}, probe: () => ({ editor: "empty" }), commands: () => [], close: () => ({ accepted: true }), stashCheck: () => undefined, form() {} };
	hub = createHub({ events } as never, "S", local as never);
	const refs = new Map<string, Ref>([["sess-1", { key: "sess-1", base: "wA", name: "billing", role: "main", file, pane: "wA:p1" }]]);
	const read = async (): Promise<Net> => {
		const net: Net = { bases: [{ id: "wA", label: "Alpha", mark: "working", head: true, tower: null, outposts: [], outside: [], tabs: [{ id: "wA:t1", label: "work", units: [{ id: "sess-1", key: "sess-1", control: true, name: "billing", role: "main", mark: "working", subs: [] }] }] }] };
		await withPending(net, (key) => refs.get(key)?.file, hub.relayed([{ id: "S", herdrLocation: { status: "current", paneId: "wA:p1" } }] as never, refs));
		return net;
	};
	const call = async (method: string) => (method === "pane.get" ? { pane: { pane_id: "wA:p1", agent: "pi", agent_status: "blocked", agent_session: { value: file } } } : {});
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file, pane: "wA:p1", live: true } : undefined);
	const gui = await startGui({ read, net: { lookup, workspace: () => [] }, call, hub, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	hub.receive("S", { version: 1, type: "dialogs", bridgeId: "B", pane: "wA:p1", file, dialogs, closed: [] } as never);
	const unit = (await read()).bases[0]!.tabs[0]!.units[0]!;
	assert.deepEqual([unit.pending?.answer?.select?.choices.map((c) => c.hereOnly)], [[true, undefined]], "the flag reached the page's unit");
	const answer = unit.pending!.answer!, phone = await paired(gui);
	const post = (who: typeof phone | undefined, choice: number, id: string) => (who ? who.post("sessions/sess-1/answer", { dialog: answer.dialog, digest: answer.digest, answerId: id.repeat(16), choice }) : send(gui, "sessions/sess-1/answer", { dialog: answer.dialog, digest: answer.digest, answerId: id.repeat(16), choice }));
	const remote = await post(phone, 0, "a");
	assert.deepEqual([remote.status, remote.body.error, delivered.length], [403, "local_only", 0], "a paired device cannot approve, and nothing reached the bridge");
	assert.deepEqual([(await post(phone, 1, "b")).status, delivered.length], [200, 1], "it can deny");
	assert.deepEqual([(await post(undefined, 0, "c")).status, delivered.length], [200, 2], "this computer's page approves");
});

test("the pad from a paired device follows the local page's rule: any pad key goes while a dialog the page cannot answer is open, and only Escape while one it can answer is", async () => {
	const p = await padded();
	await p.attach();
	const phone = await paired(p.gui);
	p.w.status = "blocked";
	for (const k of ["1", "up", "enter"]) assert.deepEqual((await phone.post("sessions/sess-1/keys", { key: k, stream: p.stream })).body, { accepted: true }, `remote ${k}`);
	assert.deepEqual(p.sentKeys(), [["1"], ["up"], ["enter"]]);
	p.w.answerable = true;
	assert.equal((await phone.post("sessions/sess-1/keys", { key: "1", stream: p.stream })).body.error, "blocked", "a dialog the page answers takes only Escape, here too");
	assert.deepEqual((await phone.post("sessions/sess-1/keys", { key: "esc", stream: p.stream })).body, { accepted: true });
	p.close();
});

test("dequeue: this computer's page and a paired device take the queue back alike, as they type alike; Alt+Up reaches the pane without a mirror", async () => {
	const { gui, hub, typed } = await answering({ pane: { agent_status: "working" } });
	hub.target = undefined; // no dialog waits
	assert.deepEqual(await send(gui, "sessions/sess-1/dequeue", { take: "take-0123456789abcdef" }), { status: 200, body: { text: "queued text" } } as never);
	const phone = await paired(gui);
	assert.deepEqual((await phone.post("sessions/sess-1/dequeue", { take: "take-0123456789abcdef" })).body, { text: "queued text" });
	assert.deepEqual(typed().map(([m, p]) => [m, p.keys]), [["pane.send_input", ["alt+up"]], ["pane.send_input", ["alt+up"]]]);
});

test("dismiss: one key hides that subagent, all:true hides every finished one through the net, from this computer's page and a paired device alike; anything else is refused", async () => {
	const dismissed: string[] = [];
	let finished = 2;
	const lookup = (key: string): Found | undefined => (key === "sess-1" ? { key, base: "wA", name: "billing", role: "main", file: FILE, pane: "wA:p1", live: true } : undefined);
	const gui = await startGui({ read: async () => ({ bases: [] }), net: { lookup, workspace: () => [], dismiss: (key) => (dismissed.push(key), key === "kid-done"), dismissAll: () => finished }, dir: join(scratch, "bundle"), pollMs: 50 });
	running.push(gui);
	assert.equal((await send(gui, "dismiss", { key: "kid-done" })).status, 200);
	assert.equal((await send(gui, "dismiss", { key: "kid-live" })).status, 404, "a running subagent cannot be dismissed");
	assert.deepEqual(await send(gui, "dismiss", { all: true }), { status: 200, body: { dismissed: 2 } });
	finished = 0;
	assert.deepEqual(await send(gui, "dismiss", { all: true }), { status: 200, body: { dismissed: 0 } }, "another page got there first: nothing is an error");
	for (const bad of [{}, { all: "yes" }, { all: false }, { key: 3 }]) assert.equal((await send(gui, "dismiss", bad)).status, 404, JSON.stringify(bad));
	const phone = await paired(gui);
	finished = 3;
	assert.deepEqual([(await phone.post("dismiss", { all: true })).status, (await phone.post("dismiss", { key: "kid-done" })).status], [200, 200], "a paired device dismisses as the page does");
	assert.deepEqual(dismissed, ["kid-done", "kid-live", "kid-done"]);
});

test("a finished subagent whose pi exited (no pane backs it) is refused input and keys with 409 not_live and Herdr is not asked; one whose pi still runs is typed to", async () => {
	const gone = await setup({ found: { role: "subagent", pane: undefined } });
	for (const [path, payload] of [["sessions/sess-1/input", { text: "hi", as: "send" }], ["sessions/sess-1/keys", { keys: ["esc"] }]] as const) {
		const r = await send(gone.gui, path, payload);
		assert.deepEqual([r.status, r.body.error], [409, "not_live"], path);
	}
	assert.deepEqual(gone.calls, [], "Herdr was not asked");
	const alive = await setup({ found: { role: "subagent" } });
	assert.equal((await send(alive.gui, "sessions/sess-1/input", { text: "hi", as: "send" })).status, 200, "pi still runs in its pane");
	assert.equal(alive.typed().length, 1);
});

test("Straw Link's team settings: this computer's page asks the holder by name (an invite comes back as QR rows); a paired device reads the state and answers a confirm, and does nothing else", async () => {
	const seen: [string, Record<string, unknown>][] = [];
	let enabled = 0;
	const link = {
		enable: async () => void enabled++,
		call: async (name: string, args: Record<string, unknown>) => {
			seen.push([name, args]);
			if (name === "invite") return { ok: true, text: "strawlink1:abc", expires: 1, hash: "h" };
			if (name === "state") return { ok: true, view: { teams: [], prefill: { kind: "join", text: "strawlink1:secret", reason: "r", session: "s" } } };
			return name === "trust" ? { ok: false, error: "That device is in none of this computer's teams" } : { ok: true };
		},
	};
	const { gui } = await setup({ link });
	const invite = await send(gui, "link/invite", { team: "t1" });
	assert.equal(invite.status, 200);
	assert.equal((invite.body as { text?: string }).text, "strawlink1:abc");
	assert.ok(Array.isArray(invite.body.rows) && invite.body.rows.length > 20 && invite.body.rows.every((r) => /^[01]+$/.test(r)), "drawn as QR rows from the text");
	const refused = await send(gui, "link/trust", { device: "x", level: "dispatch" });
	assert.deepEqual([refused.status, refused.body.error, refused.body.reason], [409, "link_failed", "That device is in none of this computer's teams"]);
	assert.equal((await send(gui, "link/enable", {})).status, 200);
	assert.equal(enabled, 1);
	assert.equal((await send(gui, "link/explode", {})).status, 404);
	assert.equal((await send(gui, "link/invite", { team: "t1" }, { "x-sb-csrf": "wrong" })).status, 403, "the page's secret is needed");
	assert.deepEqual(seen.map(([n]) => n), ["invite", "trust"]);
	const phone = await paired(gui);
	const state = await phone.post("link/state", {});
	assert.equal(state.status, 200);
	assert.deepEqual((state.body as { view: { prefill: Record<string, unknown> } }).view.prefill, { kind: "join", reason: "r", session: "s" }, "a pending invite text is not shown to a paired device");
	assert.equal((await phone.post("link/confirm-answer", { dialogId: "d", allow: true })).status, 200);
	for (const name of ["create", "invite", "decide", "join-start", "trust", "remove", "role", "rotate", "leave", "enable", "invite-text"]) {
		const r = await phone.post(`link/${name}`, {});
		assert.deepEqual([name, r.status, r.body.error], [name, 403, "local_only"], `${name} is this computer's own page's`);
	}
	assert.deepEqual(seen.map(([n]) => n), ["invite", "trust", "state", "confirm-answer"], "the holder heard nothing from the paired device but those two");
});
