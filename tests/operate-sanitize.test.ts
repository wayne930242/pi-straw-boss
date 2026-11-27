import assert from "node:assert/strict";
import { test } from "node:test";
import { createControl, type Reply } from "../src/control.ts";
import type { Net, Unit } from "../src/net.ts";
import { keyOk, plain, type Rewrite, sanitizeCards, sanitizeHistory, sanitizeImage, sanitizeMirror, sanitizeNet, sanitizeReply } from "../src/server/operatesanitize.ts";
import { baseOf, dave, hostWorld, netOf, unit } from "./operate-host-world.ts";

// The controller treats the box as hostile (docs/specs/2026-11-07-link-operate.md §6.4, §10: "A malicious box"): everything it sends is rebuilt from a schema before any page sees it. Unknown fields are dropped, a key that could walk a path is
// refused, labels are plain text, an answer's `then` never opens a pane, an image is one of four types under 1 MB, and a reply is a status of 200 to 599 with a body under 1 MB. What is refused is counted in link.log, never with its content.

const LOCAL: Net = { bases: [] };
const flags = { remote: false, secure: false };
const control = (w: ReturnType<typeof hostWorld>) => createControl({ bridge: w.host.bridge, lookup: () => undefined, csrf: "c", canonical: () => undefined });
const unitsOf = (net: Net) => net.bases.flatMap((b) => b.tabs.flatMap((t) => t.units));
const flat = (u: Unit): Unit[] => [u, ...u.subs.flatMap(flat)];
const keyOf = (w: ReturnType<typeof hostWorld>, name: string) => unitsOf(w.host.merge(LOCAL)).flatMap(flat).find((u) => u.name === name)!.key;
const bads = (w: ReturnType<typeof hostWorld>) => w.logs.filter((l) => l.event === "operate-bad-frame");
const settled = async <T>(p: Promise<T>): Promise<T | "pending"> => Promise.race([p, new Promise<"pending">((r) => setImmediate(() => r("pending")))]);
const png = (extra = 0) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra, 1)]);

/** A world with one page, the box showing `net` (arbitrary JSON: the box's own words). */
async function shown(net: unknown) {
	const w = hostWorld();
	await w.page();
	w.box().snap(net);
	await w.pump();
	return w;
}
/** The rewrite of a bare sanitizer test: keys keep their text so what survives can be read. */
const rw = (told: string[] = []): Rewrite => ({ key: (k) => `K:${k}`, base: (k) => `B:${k}`, tab: (w, k) => `T:${w}:${k}`, bad: (why) => void told.push(why) });

// ---- a snapshot ------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("a snapshot keeps its known fields and nothing else: link, head, stashed, trust, paths, capabilities and every extra field are dropped", async () => {
	const doc = { cap: "SECRET-CAPABILITY", display: "plan.html", kind: "html", reason: "why", revision: 1, onScreen: false, path: "/etc/passwd", extra: 1 };
	const hostile = { ...unit("a-main"), file: "/home/agent/session.jsonl", token: "T", path: "/etc/passwd", docs: [doc as never], docsCut: true as const };
	const bases = [{ ...baseOf("wA", [["t1", [hostile]]]), secret: "S", file: "/x", box: { state: "ended", can: ["tower", "close-base"], device: "someone-else", why: "forged" } }], events = [{ at: 1, ws: "wA", name: "a-main", mark: "idle", kind: "joined", key: "a-main", extra: 1 }];
	// `__proto__` as an own key, as JSON.parse makes it (an object literal would set the prototype instead).
	const w = await shown(JSON.parse(`{"bases": ${JSON.stringify(bases)}, "link": {"allies": [{"id": "x"}], "alerts": [], "confirms": [], "units": []}, "head": {"key": "h"}, "stashed": [], "trust": [], "events": ${JSON.stringify(events)}, "__proto__": {"polluted": true}}`));
	const merged = w.host.merge(LOCAL), text = JSON.stringify(merged);
	assert.equal(merged.bases[0]!.box!.state, "live");
	assert.deepEqual([merged.bases[0]!.box!.device, merged.bases[0]!.box!.can.includes("close-base")], [dave.id, false], "the `box` field is the host's, never the box's");
	for (const gone of ["SECRET-CAPABILITY", "/etc/passwd", "session.jsonl", '"token"', '"secret"', '"link"', '"head"', '"stashed"', '"trust"', "polluted"]) assert.ok(!text.includes(gone), `${gone} reached the page`);
	assert.equal(({} as Record<string, unknown>).polluted, undefined);
	const u = unitsOf(merged)[0]!;
	assert.deepEqual(u.docs, [{ display: "plan.html", kind: "html", reason: "why", revision: 1, onScreen: false, cap: "" }], "the card keeps its names; nothing opens a document");
	assert.equal(u.docsCut, true);
	const blocks = await shown({ bases: [baseOf("wA", [["t1", [{ ...unit("a-main"), docs: [{ cap: "X", display: "plan.md", kind: "blocks", reason: "why", revision: 2, onScreen: true } as never] }]]])] } as never);
	assert.deepEqual(unitsOf(blocks.host.merge(LOCAL))[0]!.docs, [{ display: "plan.md", kind: "blocks", reason: "why", revision: 2, onScreen: true, cap: "" }], "a box that lists a pi-better-show document is understood");
	assert.deepEqual(merged.events!.map((e) => Object.keys(e).sort()), [["at", "key", "kind", "mark", "name", "ws"]]);
	assert.equal(merged.link, undefined);
});

test("a unit with a key that could walk a path is refused with everything under it, and each refusal is counted without its text", async () => {
	const sub = (key: string) => unit(key, { role: "subagent" });
	const bad = ["../../etc/passwd", "a/../b", "..", ".", "ok/./x", "a\\b", "a\u0000b", "a\nb", "x".repeat(201), "", "a/..", "../a"];
	const w = await shown(netOf(baseOf("wA", [["t1", [unit("fine"), ...bad.map((k) => unit(k, { name: `bad:${k.slice(0, 6)}` })), unit("parent", { subs: [sub("parent/helper with spaces"), sub("../up")] }), unit("../parent2", { subs: [sub("orphan")] })]]])));
	const names = unitsOf(w.host.merge(LOCAL)).flatMap(flat).map((u) => u.name);
	assert.deepEqual(names.sort(), ["fine", "parent", "parent/helper with spaces"], "a subagent key holds a slash and free text; `..` anywhere is refused");
	assert.ok(bads(w).length > 0 && bads(w).every((l) => l.why === "key" || l.why === "session"));
	assert.ok(!JSON.stringify(w.logs).includes("etc/passwd"));
});

test("a base, a tab or a workspace id with `..` is refused: the base or the tab goes", async () => {
	const w = await shown({ bases: [baseOf("../w", [["t1", [unit("u1")]]]), baseOf("wB", [["../t", [unit("u2")]], ["t2", [unit("u3")]]], { label: "b" })] });
	const merged = w.host.merge(LOCAL);
	assert.deepEqual(merged.bases.map((b) => b.label), ["b"]);
	assert.deepEqual(unitsOf(merged).map((u) => u.name), ["u3"]);
});

test("labels are plain text: controls, escapes and bidi overrides go, markup stays inert text, lengths are cut", async () => {
	const script = "<script>alert(document.cookie)</script><img src=x onerror=alert(1)>";
	const hostile = `\u001b[31mred\u001b[0m \u202eevil\u202c \u0000nul\u0007bell\r\n${script} \u200bzw`;
	const w = await shown(netOf(baseOf("wA", [["t1", [unit("u1", { name: hostile, note: script + "x".repeat(1000) })]]], { label: hostile })));
	const merged = w.host.merge(LOCAL), u = unitsOf(merged)[0]!, b = merged.bases[0]!;
	for (const text of [u.name, b.label]) {
		assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u200b]/u);
		assert.ok(text.includes(script), "markup is kept as text: the page draws text nodes, never HTML");
	}
	assert.ok(u.note!.length <= 300);
	assert.equal(plain("x".repeat(500), 200).length, 200);
	assert.equal(plain("a\nb\tc\u0007\r\nd", 100, true), "a\nb\tc\nd", "a multi-line text keeps its breaks and tabs only");
});

test("a mark, a role, or a state outside its set refuses the unit; an optional field outside it is left out", async () => {
	const w = await shown(netOf(baseOf("wA", [["t1", [
		unit("ok"), unit("badmark", { mark: "<b>" as never }), unit("badrole", { role: "root" as never }),
		unit("badtodo", { todo: { done: -1, total: "x" } as never, ticks: [{ at: 1, mark: "idle" }, { at: 1, mark: "nope" }] as never, queued: [{ text: "t", as: "steer" }, { text: "u", as: "rm -rf" }] as never }),
	]]])));
	const u = Object.fromEntries(unitsOf(w.host.merge(LOCAL)).map((x) => [x.name, x]));
	assert.deepEqual(Object.keys(u).sort(), ["badtodo", "ok"]);
	assert.deepEqual([u.badtodo!.todo, u.badtodo!.ticks, u.badtodo!.queued], [undefined, [{ at: 1, mark: "idle" }], [{ text: "t", as: "steer" }]]);
});

test("R-F002: a box's queued rows keep `start` and a `why` of the set; a `why` outside it is left out and the row stays", async () => {
	const w = await shown(netOf(baseOf("wA", [["t1", [
		unit("q", { queued: [{ text: "a", as: "start" }, { text: "b", as: "followUp", why: "off" }, { text: "c", as: "followUp", why: "rm -rf" as never }] }),
	]]])));
	const u = Object.fromEntries(unitsOf(w.host.merge(LOCAL)).map((x) => [x.name, x]));
	assert.deepEqual(u.q!.queued, [{ text: "a", as: "start" }, { text: "b", as: "followUp", why: "off" }, { text: "c", as: "followUp" }]);
});

test("a net shaped to exhaust the page is cut: many bases, deep subagents, long lists", async () => {
	const deep = (n: number): Unit => unit(`d${n}`, { subs: n > 0 ? [deep(n - 1)] : [] });
	const w = await shown({ bases: [...Array.from({ length: 200 }, (_, i) => baseOf(`w${i}`, [["t", [unit(`u${i}`)]]])), baseOf("deep", [["t", [deep(30)]]])], events: Array.from({ length: 500 }, (_, i) => ({ at: i, ws: "w0", name: "n", mark: "idle", kind: "mark" })) });
	const merged = w.host.merge(LOCAL);
	assert.ok(merged.bases.length <= 65);
	assert.ok(merged.events!.length <= 160);
	const depthOf = (u: Unit): number => 1 + Math.max(0, ...u.subs.map(depthOf));
	for (const u of unitsOf(merged)) assert.ok(depthOf(u) <= 3);
});

test("a snapshot that is not a net is dropped and counted, and the box's earlier one stands", async () => {
	const w = await shown(netOf(baseOf("wA", [["t1", [unit("u1")]]])));
	for (const junk of [null, 7, "str", [], {}, { bases: "x" }]) { w.box().snap(junk); await w.run(300, 300); }
	assert.deepEqual(unitsOf(w.host.merge(LOCAL)).map((u) => u.name), ["u1"]);
	assert.ok(bads(w).length >= 4);
});

// ---- replies ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

async function answered(w: ReturnType<typeof hostWorld>, parts: string[], json: Record<string, unknown>, status: unknown, body: unknown, kind = "post"): Promise<Reply> {
	const c = control(w), p = kind === "get" ? w.host.bridge.claim("GET", parts)!.send() : c.run(parts, json, flags);
	await w.pump();
	const ask = w.box().reqs().at(-1)!;
	w.box().rep(ask.id as string, status, body);
	await w.pump();
	return p;
}
const calm = () => shown(netOf(baseOf("wA", [["t1", [unit("a-main")]]])));

test("an answer's `then` opens a terminal or runs a command, never a pane; the pane is stripped and counted", async () => {
	const w = await calm(), key = keyOf(w, "a-main"), ask = { dialog: "d1", digest: "a".repeat(64), answerId: "a".repeat(16), choice: 0 };
	const pane = await answered(w, ["sessions", key, "answer"], ask, 200, { outcome: "accepted", then: { pane: "grant-1" } });
	assert.deepEqual(pane, { status: 200, body: { outcome: "accepted" } });
	const both = await answered(w, ["sessions", key, "answer"], ask, 200, { outcome: "accepted", then: { terminal: true, run: true, pane: "grant-1" } });
	assert.deepEqual(both.body, { outcome: "accepted", then: { terminal: true, run: true } });
	const junk = await answered(w, ["sessions", key, "answer"], ask, 200, { outcome: "accepted", then: "pane", by: "remote", extra: "x" });
	assert.deepEqual(junk.body, { outcome: "accepted", by: "remote" });
	assert.ok(bads(w).some((l) => l.why === "then"));
});

test("a reply's status is a whole number from 200 to 599; anything else is a 502 of this computer's own words", async () => {
	const w = await calm(), key = keyOf(w, "a-main");
	for (const status of [99, 600, 700, -1, 200.5, "200", null, undefined, NaN, {}]) {
		const r = await answered(w, ["sessions", key, "input"], { text: "x", as: "send" }, status, { accepted: true });
		assert.deepEqual([r.status, (r.body as { error: string }).error], [502, "bad_reply"], String(status));
	}
	assert.ok(bads(w).filter((l) => l.why === "status").length >= 5);
});

test("a reply over 1 MB is refused whole, whatever it holds: a 2 MB history page, a 2 MB error text", async () => {
	const w = await calm(), key = keyOf(w, "a-main");
	const big = await answered(w, ["history", key], {}, 200, { items: [{ id: "e1", kind: "assistant", text: "x".repeat(2 * 1024 * 1024) }] }, "get");
	assert.deepEqual([big.status, (big.body as { error: string }).error], [502, "bad_reply"]);
	const err = await answered(w, ["sessions", key, "input"], { text: "x", as: "send" }, 409, { error: "e", reason: "r".repeat(2 * 1024 * 1024) });
	assert.equal(err.status, 502);
	assert.ok(bads(w).filter((l) => l.why === "size").length >= 2);
	const ok = await answered(w, ["history", key], {}, 200, { items: [{ id: "e1", kind: "assistant", text: "x".repeat(200_000) }] }, "get");
	assert.equal(ok.status, 200, "a large page under the limit passes");
});

test("a refusal keeps the error shape only, with its words as plain text; a body that is no refusal at all is refused", async () => {
	const w = await calm(), key = keyOf(w, "a-main");
	const r = await answered(w, ["sessions", key, "input"], { text: "x", as: "send" }, 403, { error: "operate_refused", reason: "no\u0007 <b>way</b>", why: "route", secret: "S", nested: { a: 1 } });
	assert.deepEqual(r, { status: 403, body: { error: "operate_refused", reason: "no <b>way</b>", why: "route" } });
	const none = await answered(w, ["sessions", key, "input"], { text: "x", as: "send" }, 500, "just a string");
	assert.equal(none.status, 502);
});

test("a reply of the wrong shape for its route is refused: unknown fields go, wrong types refuse", async () => {
	const w = await calm(), key = keyOf(w, "a-main");
	const input = await answered(w, ["sessions", key, "input"], { text: "x", as: "send" }, 200, { accepted: true, woke: true, answered: "W3", leak: "/home/agent" });
	assert.deepEqual(input.body, { accepted: true, woke: true, answered: "W3" });
	const wrong = await answered(w, ["sessions", key, "input"], { text: "x", as: "send" }, 200, { accepted: "yes" });
	assert.equal(wrong.status, 502);
	const upload = await answered(w, ["sessions", key, "upload"], {}, 200, { path: "/tmp/f" }).catch(() => undefined);
	void upload;
});

// ---- images ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("an image is png, jpeg, gif or webp under 1 MB with the bytes its type says; a huge one, a wrong type, wrong bytes and bad base64 are refused", async () => {
	const w = await calm(), key = keyOf(w, "a-main");
	const pic = (type: string, bytes: Buffer | string) => ({ type, base64: typeof bytes === "string" ? bytes : bytes.toString("base64") });
	const ok = await answered(w, ["image", key, "e1", "0"], {}, 200, pic("image/png", png(100)), "get");
	assert.equal(ok.status, 200);
	const refused: [string, unknown][] = [
		["a 1 MB+ image", pic("image/png", png(1024 * 1024))],
		["svg", pic("image/svg+xml", Buffer.from("<svg onload=alert(1)/>"))],
		["html as an image", pic("text/html", Buffer.from("<script>1</script>"))],
		["png bytes under a jpeg type", pic("image/jpeg", png(10))],
		["not base64", pic("image/png", "!!not base64!!")],
		["a prototype name", { type: "__proto__", base64: "" }],
		["Object.prototype's own names (a lookup that finds a function)", { type: "constructor", base64: png(4).toString("base64") }],
		["toString", { type: "toString", base64: png(4).toString("base64") }],
		["no bytes", pic("image/png", "")],
		["extra shape", { type: "image/png", base64: png(4).toString("base64"), url: "http://x" }],
	];
	for (const [what, body] of refused) {
		const r = await answered(w, ["image", key, "e1", "0"], {}, 200, body, "get");
		// Extra fields of an otherwise good image are dropped, not refused: it is the same picture.
		assert.equal(r.status, what === "extra shape" ? 200 : 502, what);
	}
	assert.ok(sanitizeImage({ type: "image/webp", base64: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]).toString("base64") }));
	assert.ok(sanitizeImage({ type: "image/gif", base64: Buffer.from("GIF89a").toString("base64") }));
	assert.ok(sanitizeImage({ type: "image/jpeg", base64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString("base64") }));
	assert.equal(sanitizeImage(pic("image/png", png(10))!)?.bytes.length, 18);
});

test("a history item's pictures are those four types under 1 MB; others are dropped from the item, which stays", () => {
	const told: string[] = [];
	const good = `data:image/png;base64,${png(10).toString("base64")}`, huge = `data:image/png;base64,${png(1024 * 1024).toString("base64")}`;
	const out = sanitizeHistory({ key: "k", reset: true, items: [{ id: "e", kind: "user", text: "t", pics: [good, huge, "data:image/svg+xml;base64,PHN2Zz4=", "data:text/html;base64,PHNjcmlwdD4=", "javascript:alert(1)", `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`] }] }, rw(told)) as { items: { pics: string[] }[] };
	assert.deepEqual(out.items[0]!.pics, [good]);
});

// ---- streams ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("a history event is rebuilt: unknown kinds and fields go, text loses its controls, the unit's key is the page's", () => {
	const told: string[] = [];
	const out = sanitizeHistory({ key: "k1", state: "live", reset: true, successor: "../x", base: "wA", name: "n\u0007", role: "main", before: "e0", header: { id: "i", cwd: "/home/agent", extra: 1 }, unreadable: 0, todos: [{ id: 1, subject: "do", status: "pending", points: 2, anchor: "private", evidence: [{ command: "private", result: "pass" }], extra: 1 }, { id: 2, subject: "x", status: "weird" }, { id: 3, subject: "plan", status: "in_progress", owner: "w\u0007eb", blockedBy: [1, -1, "2", 1.5], graph: "fan-out/fan-in", waitsOn: "boss", until: "2026-11-27T14:00:00+08:00" }, { id: 4, subject: "odd", status: "pending", graph: "star", until: "<b>soon</b>", blockedBy: "1" }], leak: "x",
		items: [{ id: "e1", kind: "assistant", text: "hi\u001b[31m", tools: [{ id: "t", name: "bash", summary: "ls", args: "{}", extra: 1 }], model: "m", leak: "/etc/shadow" }, { id: "e2", kind: "rm" }, { kind: "user" }, "junk"] }, rw(told)) as Record<string, unknown>;
	const items = out.items as Record<string, unknown>[];
	assert.equal(out.key, "K:k1");
	assert.equal(out.successor, undefined, "a successor key with `..` is left out");
	assert.deepEqual(items.map((i) => i.id), ["e1"]);
	assert.equal(items[0]!.text, "hi[31m");
	assert.deepEqual(Object.keys((items[0]!.tools as object[])[0]!).sort(), ["args", "id", "name", "summary"]);
	assert.deepEqual(out.todos, [{ id: 1, subject: "do", status: "pending" }, { id: 3, subject: "plan", status: "in_progress", owner: "w eb", blockedBy: [1], graph: "fan-out/fan-in", waitsOn: "boss", until: "2026-11-27T06:00:00.000Z" }, { id: 4, subject: "odd", status: "pending" }], "a todo's plan fields pass, checked; an unknown graph, a free-text until, and a blockedBy that is no list do not");
	assert.ok(!JSON.stringify(out).includes("/etc/shadow") && !JSON.stringify(out).includes("leak"));
	assert.equal(sanitizeHistory({ key: "../k", items: [], reset: true }, rw()), undefined, "an event for a key with `..` is refused");
});

test("the cards of a workspace keep keys that are safe, as plain one-line-or-more text", () => {
	const out = sanitizeCards({ ok: "last\u0007 line", "../bad": "x", "a/../b": "y", "": "z", num: 5 }, rw());
	assert.deepEqual(out, { "K:ok": "last line" });
	assert.equal(sanitizeCards("nope", rw()), undefined);
});

test("a terminal frame is SGR text only: OSC, other escapes and controls go; the shape is held", () => {
	const row = "\u001b]52;c;c2VjcmV0\u0007\u001b[31mred\u001b[0m\u001b[2J\u001b]0;title\u001b\\\u0007z";
	const frame = sanitizeMirror({ key: "k", seq: 3, rows: 2, cols: 80, whole: true, set: [[0, row], [1, "ok"]], extra: 1 }, rw())!;
	assert.deepEqual(frame, { key: "K:k", seq: 3, rows: 2, cols: 80, whole: true, set: [[0, "\u001b[31mred\u001b[0mz"], [1, "ok"]] });
	for (const bad of [{ key: "../k", seq: 1, rows: 1, cols: 1, set: [] }, { key: "k", seq: 1, rows: 1000, cols: 1, set: [] }, { key: "k", seq: 1, rows: 1, cols: 1, set: [[500, "x"]] }, { key: "k", seq: 1, rows: 1, cols: 1, set: [[0, 5]] }, { key: "k", seq: -1, rows: 1, cols: 1, set: [] }, { key: "k", seq: 1, rows: 1, cols: 1, set: Array.from({ length: 121 }, (_, i) => [i % 120, "x"]) }, null, "x"]) {
		assert.equal(sanitizeMirror(bad, rw()), undefined, JSON.stringify(bad).slice(0, 60));
	}
	assert.deepEqual(sanitizeMirror({ key: "k", ended: "The pane\u0007 closed.", set: "x" }, rw()), { key: "K:k", ended: "The pane  closed." });
	assert.deepEqual(sanitizeMirror({ key: "k", hidden: true, rows: 9999 }, rw()), { key: "K:k", hidden: true });
});

test("a terminal frame the box sends for another unit than the one asked for is dropped and counted", async () => {
	const w = await shown(netOf(baseOf("wA", [["t1", [unit("a-main"), unit("other")]]])));
	const got: unknown[] = [];
	w.host.bridge.mirrorOpen("s1", (_e, d) => void got.push(d));
	const p = control(w).run(["sessions", keyOf(w, "a-main"), "mirror"], { stream: "s1", on: true }, flags);
	await w.pump();
	w.box().rep(w.box().reqs().at(-1)!.id as string, 200, { attached: true });
	await w.pump();
	await p;
	w.box().ev("m:a-main", "mirror", { key: "other", seq: 1, rows: 1, cols: 1, set: [[0, "x"]] });
	await w.pump();
	assert.equal(got.length, 0);
	assert.ok(bads(w).some((l) => l.why === "ev"));
});

// ---- the pieces ------------------------------------------------------------------------------------------------------------------------------------------------------------------

test("keyOk: what may name a unit", () => {
	for (const ok of ["a", "main-1", "parent/helper with spaces", "ally-run1", "x".repeat(200), "ünï"]) assert.equal(keyOk(ok), true, ok);
	for (const bad of ["", "..", ".", "a/../b", "../a", "a/..", "a/./b", "a\\b", "a\u0000", "a\u001bb", "a\u202eb", "a\nb", "x".repeat(201), 5, null, undefined, {}]) assert.equal(keyOk(bad), false, String(bad));
});

test("sanitizeNet on a net that is not one names the shape in `bad`", () => {
	const told: string[] = [];
	assert.equal(sanitizeNet({ bases: 5 }, rw(told)), undefined);
	assert.deepEqual(told, ["shape"]);
	assert.deepEqual(sanitizeNet({ bases: [] }, rw()), { bases: [] });
});

test("sanitizeReply: the status and the size are checked before the body is read", () => {
	assert.deepEqual(sanitizeReply("keys", 200, { accepted: true }, rw()), { ok: true, status: 200, body: { accepted: true } });
	assert.deepEqual(sanitizeReply("keys", 199, { accepted: true }, rw()), { ok: false, why: "status" });
	assert.deepEqual(sanitizeReply("keys", 200, { accepted: true, pad: "x".repeat(1024 * 1024) }, rw()), { ok: false, why: "size" });
	const cyc: Record<string, unknown> = {};
	cyc.self = cyc;
	assert.deepEqual(sanitizeReply("keys", 200, cyc, rw()), { ok: false, why: "shape" });
});

test("a tower's memory reply (a shape the controller does not know) is bounded: depth, widths, key names and text", async () => {
	const w = await shown(netOf(baseOf("wA", [["t1", [unit("a-main")]]], { tower: { name: "t", mark: "idle", key: "tw", control: true, subs: [] } })));
	const ws = w.host.merge(LOCAL).bases[0]!.id, deep: Record<string, unknown> = {};
	let at = deep;
	for (let i = 0; i < 20; i++) at = (at.n = {}) as Record<string, unknown>;
	const r = await answered(w, ["tower", ws, "memory"], { op: "read" }, 200, { rev: 1, standing: [{ id: "S1", text: "a\u0007b" }], "bad key!": 1, __proto__x: 2, deep });
	assert.equal(r.status, 200);
	const body = r.body as Record<string, unknown>;
	assert.equal(body["bad key!"], undefined);
	assert.deepEqual(body.standing, [{ id: "S1", text: "ab" }]);
	let depth = 0;
	for (let o = body.deep as Record<string, unknown> | undefined; o; o = o.n as Record<string, unknown> | undefined) depth++;
	assert.ok(depth <= 5);
	void settled;
});

test("RR disposition: a box's train unit and its subagents reach the controller with their train id; a train id that is no project and code is left out", async () => {
	const w = await shown(netOf(baseOf("wA", [["t1", [
		unit("train 1106m", { role: "train" as never, train: { project: "moldplan", code: "2026-11-06-m" } as never, subs: [unit("helper", { role: "subagent" })] }),
		unit("badtrain", { role: "train" as never, train: { project: "../x", code: "nope" } as never }),
		unit("odd", { role: "member", train: "moldplan/2026-11-06-m" as never }),
	]]])));
	const u = Object.fromEntries(unitsOf(w.host.merge(LOCAL)).flatMap(flat).map((x) => [x.name, x]));
	assert.deepEqual(Object.keys(u).sort(), ["badtrain", "helper", "odd", "train 1106m"]);
	assert.equal(u["train 1106m"]!.role, "train");
	assert.deepEqual(u["train 1106m"]!.train, { project: "moldplan", code: "2026-11-06-m" });
	assert.deepEqual(u["train 1106m"]!.subs.map((s) => s.name), ["helper"]);
	assert.equal(u.badtrain!.train, undefined);
	assert.equal(u.odd!.train, undefined);
});

test("task 5 of the train workers: a box's monitor keeps its progress load (two plain numbers); its yards and its load are the box's own and never reach the controller", async () => {
	const gate = { id: "3", what: "train 1106m #4 full-check", status: "running", lines: 5, at: 3, last: "waiting: load <=30 (now 42)" };
	const hostile = { yards: { projects: [{ project: "acme", trains: [{ code: "2026-11-06-m", key: "k" }] }] }, load: { now: 99, cores: 1 } };
	const w = await shown({ ...netOf(baseOf("wA", [["t1", [unit("a-main", { monitors: [{ ...gate, load: { max: 30, now: 42, x: 1 } }, { ...gate, id: "4", load: { max: "30", now: 1 } }] as never })]]])), ...hostile } as never);
	const merged = w.host.merge(LOCAL), [main] = unitsOf(merged);
	assert.deepEqual(main!.monitors!.map((m) => [m.id, m.load]), [["3", { max: 30, now: 42 }], ["4", undefined]], "the load is rebuilt from its numbers; a bad one is left out and the monitor stays");
	assert.ok(!("yards" in merged) && !("load" in merged) && !JSON.stringify(merged).includes("2026-11-06-m"), "nothing of a box's yards or load reaches the page");
});
