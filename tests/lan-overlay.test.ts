import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createControl, type ControlDeps, type Reply } from "../src/control.ts";
import { createFaces, LEASE_MS, SETTLE_MS } from "../src/lan/faces.ts";
import type { Found } from "../src/net.ts";
import { fakeClock } from "./fake-clock.ts";

// Writes while the /boss gui lan overlay is open (docs/specs/2026-10-30-sb-gui-lan.md, *Not from a paired device*, D9; Tests, "Writes while the overlay is open"; Steps L5). A paired device may write into a session's pane by the composer
// (`input`), the key pad and paste (`keys`), and the queue's take-back (`dequeue`); while a face holds a mark on that pane all of them answer 409 `lan_overlay_open` with no Herdr call made, except Escape on `keys`. The routes are
// driven through `createControl` directly, with a fake Herdr that records every call.

const ORIGIN = "https://weis-mbp.local:8445", CSRF = "c".repeat(32), FILE = "/s/2026_sess-1.jsonl", PANE = "wA:p1", TAKE = "0000000000000001";
const found = (over: Partial<Found> = {}): Found => ({ key: "sess-1", base: "wA", name: "billing", role: "main", file: FILE, pane: PANE, live: true, ...over });

function world(over: Partial<ControlDeps> = {}) {
	const clock = fakeClock(5_000_000), faces = createFaces(clock.now);
	const calls: [string, Record<string, unknown>][] = [];
	const hooks: { onGet?: () => void; onProbe?: () => void; markAtHas?: number } = {};
	let has = 0;
	const call = async (method: string, params: Record<string, unknown>) => {
		calls.push([method, params]);
		if (method === "pane.get") {
			hooks.onGet?.();
			return { pane: { pane_id: PANE, agent: "pi", agent_status: "idle", agent_session: { value: FILE } } };
		}
		return {};
	};
	const answers: NonNullable<ControlDeps["answers"]> = {
		has: () => (++has === hooks.markAtHas && void faces.open(PANE), false), replay: () => undefined, ended: () => undefined, send: async () => ({ status: 200, body: { outcome: "accepted" } }), commands: async () => undefined, target: async () => undefined,
		probe: async () => (hooks.onProbe?.(), { editor: "empty" as const }),
		pull: async (_key, phase) => (phase === "begin" ? { pending: true, ticket: "t1", key: "alt+up" } : { text: "queued" }),
	};
	const handle = createControl({ lookup: (k) => (k === "sess-1" ? found() : undefined), call, csrf: CSRF, canonical: (f) => f, secret: async () => false, mirrors: { fresh: () => true, toggle: async () => ({ status: 200, body: {} }) } as never, answers, overlay: faces, ...over });
	const post = (action: string, body: unknown, remote = true): Promise<Reply> => {
		const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sb-csrf": CSRF } }) as unknown as IncomingMessage;
		return handle(req, ORIGIN, ["sessions", "sess-1", action], remote);
	};
	/** What was written into a pane: every call but the pane look. */
	const written = () => calls.filter(([m]) => m !== "pane.get").map(([m, p]) => [m, p.keys ?? p.text ?? p.target]);
	return { clock, faces, calls, hooks, post, written };
}
const STREAM = "stream-1";
const refused = (r: Reply) => [r.status, (r.body as { error?: string }).error];

test("with a mark on the pane, a paired device's composer text, Enter, and follow-up are refused 409 lan_overlay_open and nothing reaches Herdr", async () => {
	const w = world();
	w.faces.open(PANE);
	for (const body of [{ text: "4821", as: "send" }, { text: "y", as: "send" }, { text: "yes", as: "followUp" }]) assert.deepEqual(refused(await w.post("input", body)), [409, "lan_overlay_open"], JSON.stringify(body));
	assert.deepEqual(w.written(), [], "no Herdr write of any kind");
});

test("with a mark, a paired device's pad keys, digits, Enter, typed text, and paste are refused; Escape (a key or Stop's) goes through", async () => {
	// The key pad takes 8 keys a second per session, so the bodies are shared out over two servers.
	for (const bodies of [[{ key: "1" }, { key: "9" }, { key: "enter" }, { key: "tab" }, { text: "y" }], [{ text: "n" }, { text: "r" }, { text: "u" }, { paste: "4821\n" }]]) {
		const w = world();
		w.faces.open(PANE);
		for (const body of bodies) assert.deepEqual(refused(await w.post("keys", { stream: STREAM, ...body })), [409, "lan_overlay_open"], JSON.stringify(body));
		assert.deepEqual(w.written(), [], "the editor was not even asked, and nothing was written");
	}
	// (a second Escape within a second asks to be confirmed, as it does without a mark: two servers again)
	for (const body of [{ stream: STREAM, key: "esc" }, { keys: ["esc"] }]) {
		const w = world();
		w.faces.open(PANE);
		assert.deepEqual((await w.post("keys", body)).body, { accepted: true }, JSON.stringify(body));
		assert.deepEqual(w.written(), [["pane.send_input", ["esc"]]]);
	}
});

test("with a mark, a paired device's take-back (dequeue) is refused and no key is sent", async () => {
	const w = world();
	w.faces.open(PANE);
	assert.deepEqual(refused(await w.post("dequeue", { take: TAKE })), [409, "lan_overlay_open"]);
	assert.deepEqual(w.written(), []);
	const none = world();
	assert.deepEqual((await none.post("dequeue", { take: TAKE })).body, { text: "queued" }, "with no mark it takes the queue back");
	assert.deepEqual(none.written(), [["pane.send_input", ["alt+up"]]]);
});

test("this computer's own page is not refused by the mark", async () => {
	const w = world();
	w.faces.open(PANE);
	assert.deepEqual((await w.post("input", { text: "hello", as: "send" }, false)).body, { accepted: true });
	assert.deepEqual((await w.post("keys", { stream: STREAM, key: "enter" }, false)).body, { accepted: true });
	assert.equal(w.written().length, 2);
});

test("after the face closes, or 5 s after its last renewal, the writes go through again; a close or renewal with another id changes nothing", async () => {
	const w = world();
	const id = w.faces.open(PANE)!;
	w.faces.close("0".repeat(32));
	w.faces.renew("0".repeat(32));
	assert.deepEqual(refused(await w.post("input", { text: "x", as: "send" })), [409, "lan_overlay_open"], "another face's id closed nothing");
	assert.equal(w.faces.close(id), true);
	assert.deepEqual((await w.post("input", { text: "x", as: "send" })).body, { accepted: true }, "closed");
	const lapsing = w.faces.open(PANE)!;
	w.clock.advance(LEASE_MS - 1);
	assert.equal(w.faces.renew(lapsing), true);
	w.clock.advance(LEASE_MS - 1);
	assert.deepEqual(refused(await w.post("input", { text: "y", as: "send" })), [409, "lan_overlay_open"], "renewed, still marked");
	w.clock.advance(2);
	assert.deepEqual((await w.post("input", { text: "z", as: "send" })).body, { accepted: true }, "5 s after the last renewal a pi that hung no longer holds the pane");
});

test("an open naming another pane marks only that pane", async () => {
	const w = world();
	w.faces.open("wA:p9");
	assert.deepEqual((await w.post("input", { text: "x", as: "send" })).body, { accepted: true });
});

test("the mark is looked at right before each write: one set during the pane look refuses the prompt, and one set during the editor probe refuses Enter", async () => {
	const prompt = world();
	prompt.hooks.onGet = () => void prompt.faces.open(PANE);
	assert.deepEqual(refused(await prompt.post("input", { text: "4821", as: "send" })), [409, "lan_overlay_open"], "set while the pane was being looked at");
	assert.deepEqual(prompt.written(), []);

	const enter = world();
	enter.hooks.onProbe = () => void enter.faces.open(PANE);
	assert.deepEqual(refused(await enter.post("keys", { stream: STREAM, key: "enter" })), [409, "lan_overlay_open"], "set while the editor was probed");
	assert.deepEqual(enter.written(), []);

	// The last look is the one that counts: the link_request check right before each write of a key (`answers.has`, 2nd call for a pad key and a take-back: the guard made the 1st) is the last thing awaited, and a face that opened during it still refuses the write.
	for (const [action, body] of [["keys", { stream: STREAM, key: "1" }], ["dequeue", { take: TAKE }]] as const) {
		const late = world();
		late.hooks.markAtHas = 2;
		assert.deepEqual(refused(await late.post(action, body)), [409, "lan_overlay_open"], `${action}: a mark set between the last check and the write`);
		assert.deepEqual(late.written(), [], `${action}: no key went`);
	}
	// The one plan with two writes is a confirmed double Escape, which the mark never refuses; every other key is one write, checked right before it.
});

test("a paired device's write is noted at the write, so a face that opens within 1.5 s refuses its own answers; Escape and this computer's page leave no note", async () => {
	const w = world();
	assert.deepEqual((await w.post("input", { text: "4821", as: "send" })).body, { accepted: true });
	w.clock.advance(SETTLE_MS - 1);
	assert.deepEqual(w.faces.accepts(w.faces.open(PANE)), { ok: false, error: "typed_into" });
	w.clock.advance(SETTLE_MS * 3);
	assert.deepEqual(w.faces.accepts(w.faces.open(PANE)), { ok: true }, "a write long before is past");

	const esc = world();
	await esc.post("keys", { keys: ["esc"] });
	await esc.post("keys", { stream: STREAM, key: "esc" });
	assert.deepEqual(esc.faces.accepts(esc.faces.open(PANE)), { ok: true }, "Escape is not noted");

	const local = world();
	await local.post("input", { text: "hello", as: "send" }, false);
	assert.deepEqual(local.faces.accepts(local.faces.open(PANE)), { ok: true }, "this computer's page is not a paired device");

	const refusedWrite = world();
	const id = refusedWrite.faces.open(PANE)!;
	await refusedWrite.post("input", { text: "y", as: "send" });
	refusedWrite.faces.close(id);
	assert.deepEqual(refusedWrite.faces.accepts(refusedWrite.faces.open(PANE)), { ok: true }, "a write the mark refused wrote nothing, so it taints nothing");
});
