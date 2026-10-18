import assert from "node:assert/strict";
import { test } from "node:test";
import { type Asked, createKeys, PAD, type Reply, SEQUENCES } from "../src/keys.ts";
import type { Found } from "../src/net.ts";
import type { Editor } from "../src/probe.ts";

const FOUND: Found = { key: "S", base: "wA", name: "s", role: "main", file: "/s/2026_S.jsonl", pane: "wA:p1", live: true };
/** The guards with a fake clock and fakes for the mirror, the secret check, the hub's dialogs, and the bridge's editor check. */
function keys({ fresh = true, secret = false, answerable = false, editor = { editor: "empty" } as Editor | undefined } = {}) {
	const w = { t: 1_000_000, fresh, secret, answerable, editor, probes: 0, asked: [] as [string, string, string][] };
	const k = createKeys({
		fresh: (stream, key, pane) => (w.asked.push([stream, key, pane]), w.fresh),
		secret: async () => w.secret,
		answerable: async () => w.answerable,
		probe: async () => (w.probes++, w.editor),
		now: () => w.t,
	});
	/** One request through both steps, as control.ts runs them: the keys that go out, or the refusal. */
	const send = async (body: Record<string, unknown>, status = "idle"): Promise<string[] | Reply> => {
		const a = k.check("S", body);
		if ("status" in a) return a;
		try {
			const plan = await k.send("S", FOUND, { pane_id: "wA:p1", agent_status: status }, a as Asked);
			k.sent("S", plan); // Herdr took them at once
			return plan.keys;
		} catch (e) {
			return e as Reply;
		}
	};
	return { w, send, k };
}
const code = (r: string[] | Reply) => (Array.isArray(r) ? 200 : r.status);
const token = (r: string[] | Reply) => (Array.isArray(r) ? undefined : (r.body as { confirm?: string }).confirm);
const pad = (key: string, extra: Record<string, unknown> = {}) => ({ key, stream: "st", ...extra });

test("the pad sends one key of its own, never letters, /, !, Ctrl or Alt, never two at once", async () => {
	const { send, w } = keys();
	for (const key of ["a", "q", "/", "!", "ctrl+c", "ctrl+d", "ctrl+g", "alt+enter", "alt+up", "alt+o", "escape", "ENTER", "0", "f1", "esc esc", "", 1, null])
		assert.equal(code(await send(pad(key as string))), 400, JSON.stringify(key));
	for (const body of [{ keys: ["up", "enter"] }, { keys: ["enter"] }, { keys: ["esc", "esc"] }, { keys: "esc" }, { key: "esc", keys: ["esc"], stream: "st" }, { key: ["esc"], stream: "st" }])
		assert.equal(code(await send(body)), 400, JSON.stringify(body));
	assert.equal(code(await send({ key: "up" })), 400, "no stream named");
	assert.ok(!PAD.some((k) => /ctrl|alt|^[a-z/!]$/.test(k)), "nothing like that is on the pad");
	w.t += 1000;
	for (const key of PAD.filter((k) => k !== "esc" && k !== "enter")) {
		w.t += 200;
		assert.deepEqual(await send(pad(key)), [key], key);
	}
});

test("at most 8 keys a second per session", async () => {
	const { send, w } = keys();
	for (let i = 0; i < 8; i++) assert.equal(code(await send(pad("down"))), 200);
	assert.equal(code(await send(pad("down"))), 429);
	w.t += 1000;
	assert.equal(code(await send(pad("down"))), 200, "the next second");
});

test("keys go only while this page's stream holds the session's mirror on its pane, current in the last 3 s; Stop's Escape needs none", async () => {
	const { send, w } = keys({ fresh: false });
	for (const key of ["esc", "enter", "up", "1"]) assert.deepEqual([key, code(await send(pad(key)))], [key, 409]);
	assert.deepEqual(w.asked.at(-1), ["st", "S", "wA:p1"], "asked for this stream, session, and pane");
	assert.equal(w.probes, 0, "no editor check without a mirror");
	assert.deepEqual(await send({ keys: ["esc"] }, "working"), ["esc"], "the composer's Stop");
});

test("while it waits for a secret or on an answerable dialog only Escape goes; a dialog the page cannot answer takes the pad (digits included)", async () => {
	for (const which of ["secret", "answerable"] as const) {
		const { send, w } = keys({ [which]: true });
		for (const key of ["1", "enter", "up", "space", "tab"]) assert.equal(code(await send(pad(key), "blocked")), 409, `${which}: ${key}`);
		assert.equal(w.probes, 0, "Enter refused before the editor is asked");
		assert.deepEqual(await send(pad("esc"), "blocked"), ["esc"]);
	}
	const { send } = keys();
	assert.deepEqual(await send(pad("2"), "blocked"), ["2"], "pi-ask-user or a pi selector: a digit picks an option (U7)");
});

test("Enter asks the bridge every time: an ending command needs its own name, a slash command or an unread editor its confirm", async () => {
	const { send, w } = keys({ editor: { editor: "text", ending: "reload" } });
	const first = await send(pad("enter"));
	assert.deepEqual([code(first), token(first)], [409, "reload"]);
	assert.match((first as Reply & { body: { reason: string } }).body.reason, /\/reload/, "the command is named");
	for (const wrong of [true, "new", "unread", "command", "/reload", "RELOAD"]) assert.equal(code(await send(pad("enter", { confirmed: wrong }))), 409, String(wrong));
	assert.deepEqual(await send(pad("enter", { confirmed: "reload" })), ["enter"]);
	w.t += 1000; // past the rate
	w.editor = { editor: "text", ending: "quit" };
	assert.equal(token(await send(pad("enter", { confirmed: "reload" }))), "quit", "the confirm holds only while the bridge reports the same command");
	for (const [editor, need] of [[undefined, "unread"], [{ editor: "unknown" }, "unread"], [{ editor: "command" }, "command"]] as const) {
		w.t += 1000;
		w.editor = editor as Editor | undefined;
		const r = await send(pad("enter"));
		assert.deepEqual([code(r), token(r)], [409, need], JSON.stringify(editor));
		assert.deepEqual(await send(pad("enter", { confirmed: need })), ["enter"]);
	}
	for (const editor of [{ editor: "empty" }, { editor: "text" }] as Editor[]) {
		w.editor = editor;
		assert.deepEqual(await send(pad("enter")), ["enter"], editor.editor);
	}
	w.t += 1000;
	const before = w.probes;
	await send(pad("enter"));
	await send(pad("enter"));
	assert.equal(w.probes, before + 2, "no answer is reused");
});

test("up recalls /reload from history, then Enter needs the confirm", async () => {
	const { send, w } = keys();
	assert.deepEqual(await send(pad("up")), ["up"]);
	w.editor = { editor: "text", ending: "reload" }; // what the editor holds after the recall
	assert.equal(token(await send(pad("enter"))), "reload");
});

test("a second Escape within 1 s to a session that neither works nor waits asks first; confirmed, both Escapes go together", async () => {
	const { send, w } = keys();
	assert.deepEqual(await send(pad("esc")), ["esc"]);
	w.t += 400;
	const second = await send(pad("esc"));
	assert.deepEqual([code(second), token(second)], [409, "double-esc"]);
	w.t += 3000; // the user reads the confirm: pi takes two Escapes as a pair only within 500 ms
	assert.deepEqual(await send(pad("esc", { confirmed: "double-esc" })), ["esc", "esc"]);
	w.t += 300;
	assert.deepEqual(await send(pad("esc")), ["esc"], "the pair was the double: the next Escape starts afresh");
	w.t += 1500;
	assert.deepEqual(await send(pad("esc")), ["esc"], "more than a second apart");
	assert.deepEqual(await send(pad("esc", { confirmed: "double-esc" })), ["esc"], "confirmed at once: pi pairs it with the Escape before");
	w.t += 2000;
	assert.deepEqual(await send(pad("esc", { confirmed: "double-esc" })), ["esc"], "a confirm with no Escape before it sends one");
	assert.deepEqual(await send({ keys: ["esc"] }, "working"), ["esc"], "Stop while it works");
	w.t += 300;
	assert.equal(token(await send({ keys: ["esc"] })), "double-esc", "Stop again once it stopped counts as the second");
	w.t += 300;
	for (const status of ["working", "blocked"]) assert.deepEqual(await send(pad("esc"), status), ["esc"], `${status}: Escape stops or closes, nothing more`);
});

test("Home, End, Page Up, and Page Down, which Herdr cannot name, go as their fixed sequences; every other key by its Herdr name", async () => {
	const { k } = keys();
	const call = async (key: string) => (await k.send("S", FOUND, { pane_id: "wA:p1", agent_status: "idle" }, { key, stream: "st" })).calls;
	assert.deepEqual(await call("home"), [["pane.send_text", { pane_id: "wA:p1", text: "\x1b[H" }]]);
	assert.deepEqual(await call("end"), [["pane.send_text", { pane_id: "wA:p1", text: "\x1b[F" }]]);
	assert.deepEqual(await call("pageup"), [["pane.send_text", { pane_id: "wA:p1", text: "\x1b[5~" }]]);
	assert.deepEqual(await call("pagedown"), [["pane.send_text", { pane_id: "wA:p1", text: "\x1b[6~" }]]);
	assert.deepEqual(await call("up"), [["pane.send_input", { pane_id: "wA:p1", keys: ["up"] }]]);
	assert.deepEqual(Object.keys(SEQUENCES).sort(), ["end", "home", "pagedown", "pageup"]);
	assert.ok(Object.keys(SEQUENCES).every((key) => PAD.includes(key)), "only pad keys");
	assert.ok(Object.values(SEQUENCES).every((seq) => /^\x1b\[[0-9]*[~HF]$/.test(seq)), "each a single cursor or paging key, nothing that types text");
});

test("the confirmed double-Escape goes as two writes of one Escape each; the 1 s counts from when Herdr took the first", async () => {
	const { k, w } = keys();
	const pane = { pane_id: "wA:p1", agent_status: "idle" }, ask = (extra: Record<string, unknown> = {}) => k.check("S", { key: "esc", stream: "st", ...extra }) as Asked;
	const first = await k.send("S", FOUND, pane, ask());
	w.t += 800; // Herdr took a while to confirm the first Escape
	k.sent("S", first);
	w.t += 250; // the user taps again a moment after the reply: pi would see the two 250 ms apart
	await assert.rejects(k.send("S", FOUND, pane, ask()), (e: Reply) => (e.body as { confirm?: string }).confirm === "double-esc");
	w.t += 2000;
	const pair = await k.send("S", FOUND, pane, ask({ confirmed: "double-esc" }));
	assert.deepEqual(pair.calls, [["pane.send_input", { pane_id: "wA:p1", keys: ["esc"] }], ["pane.send_input", { pane_id: "wA:p1", keys: ["esc"] }]], "never one write of two ESC bytes, which reads as Ctrl+Alt+[");
	k.sent("S", pair);
	w.t += 300;
	assert.deepEqual((await k.send("S", FOUND, pane, ask())).keys, ["esc"], "after the double the next Escape starts afresh");
});

test("Enter checks the mirror, the secret, and the dialog again after the editor check, which can take a second", async () => {
	const { k, w } = keys({ editor: { editor: "empty" } });
	const slow = createKeys({ fresh: () => w.fresh, secret: async () => w.secret, answerable: async () => w.answerable, probe: async () => ((w.secret = true), { editor: "empty" }), now: () => w.t });
	await assert.rejects(slow.send("S", FOUND, { pane_id: "wA:p1", agent_status: "idle" }, slow.check("S", { key: "enter", stream: "st" }) as Asked), (e: Reply) => (e.body as { error: string }).error === "blocked", "a secret_drop opened while the bridge answered");
	w.secret = false;
	const gone = createKeys({ fresh: () => w.fresh, secret: async () => false, answerable: async () => false, probe: async () => ((w.fresh = false), { editor: "empty" }), now: () => w.t });
	await assert.rejects(gone.send("S", FOUND, { pane_id: "wA:p1", agent_status: "idle" }, gone.check("S", { key: "enter", stream: "st" }) as Asked), (e: Reply) => (e.body as { error: string }).error === "no_mirror", "the mirror went stale meanwhile");
	assert.ok(k);
});
