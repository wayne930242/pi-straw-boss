import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { encodePlaintext, decodePlaintext, type WaitWire } from "../src/link/kinds.ts";
import type { InboxItem } from "../src/link/store.ts";
import { createAsks } from "../src/server/asks.ts";
import { createLinkWaits, readWaits, type WaitsDeps } from "../src/server/linkwaits.ts";
import { startLinkWaits } from "../src/server/linkwaitsops.ts";
import { slotOf, type Slot } from "../src/server/record.ts";
import { writeService } from "../src/server/towerstore.ts";

// A note in a wait's thread (docs/specs/2026-11-26-standing-prompt.md, item 8). Field, 2026-11-26: the Mac's main "urgent 1124" asked box 1's standing main nine questions (L282..L314, owner ""); box 1 answered each step as a fresh
// standing notice, which named no wait, so every one reached the Mac's standing main ("it names no main here") and none reached the main that asked. Now a notice can name the wait it is about (`re`, the wire's seventh part, to a
// build that lists tower.note): the receiving router tells that wait's raiser, and only a notice about no wait that names no main goes to the standing main. The box's main sends it with `linkWait` state `note`.

let root = "", slot: Slot;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-note-"));
	slot = slotOf(join(root, "state"), { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const BOX = "n2knna6dkfud5sura2vst4gsee", MAC = "ibzkd5ijmtravej475kmrykvye", OUT = "d".repeat(32), ASK = "c".repeat(32);
const NOTE_CAPS = ["tower.wait", "tower-reply", "tower.awaitsReply", "tower.standing", "tower.note"];
type Main = { id: string; name: string; standing?: boolean };
function world(mains: Main[], caps = NOTE_CAPS) {
	const w = { posts: [] as { to: string[]; text: string; kind: string; wait?: string }[], sends: [] as Parameters<WaitsDeps["send"]>[1][], mains, caps, router: undefined as unknown as ReturnType<typeof createLinkWaits> };
	w.router = createLinkWaits({
		slot, now: () => Date.parse("2026-11-26T02:00:00Z"), log: () => {}, locale: () => "en",
		net: async () => ({ sessions: w.mains.map((m, i) => ({ id: m.id, name: m.name, herdrLocation: { paneId: `p${i}` } })) as never, ps: w.mains.map((m, i) => ({ pane_id: `p${i}`, workspace_id: "w15X", tokens: { sb_role: "main", ...(m.standing ? { sb_duty: "standing" } : {}) } })) as never }),
		post: async (_ws, to, text, kind, extra) => (w.posts.push({ to, text, kind, ...(extra.wait ? { wait: extra.wait } : {}) }), true),
		send: async (_ws, req) => (w.sends.push(req), { ok: true }),
		caps: () => w.caps, deviceId: () => MAC, selfLabel: () => "mac", workspaces: () => ["w15X"],
	});
	return w;
}
let n = 0;
const notice = (wait: Partial<WaitWire>, text = "MP-5666 car ready: agent/mp-5666 2e0de8f8a"): InboxItem => ({
	v: 1, id: (++n).toString(16).padStart(32, "0"), team: "t1", from: BOX, fromLabel: "waydosoft", fromShort: "n2knna", seq: n, sentAt: 1, received: 1, fromWorkspace: "box", toWorkspace: "", replyExpected: false, text,
	wait: { id: n.toString(16).padStart(32, "b"), state: "open", owner: "", what: "MP-5666 car ready", handle: "da07d0be22fe8f43", kind: "notice", ...wait },
});
const ledger = () => readWaits(slot, "w15X").entries;

test("a notice about a wait this computer raised goes to that wait's raiser, even when the wait names no owner; a notice about no wait still goes to the standing main", async () => {
	const w = world([{ id: "s-urgent", name: "urgent 1124" }, { id: "s-work", name: "work-on", standing: true }]);
	const out = w.router.sent("w15X", { wait: OUT, ask: ASK, device: BOX, team: "t1", label: "waydosoft", short: "n2knna", raiser: { id: "s-urgent", name: "urgent 1124" }, owner: "", what: "FE2 MP-5666 car", plain: false, kind: "question" });
	assert.equal(out, "L1");
	assert.equal(await w.router.take(notice({ re: OUT }), "w15X"), true);
	assert.deepEqual(w.posts.map((p) => [p.to, p.kind, p.wait]), [[["s-urgent"], "link_wait", "L2"]], "the raiser alone, not the standing main");
	assert.match(w.posts[0]!.text, /^waydosoft sent a note on your question L1 \(FE2 MP-5666 car\) \(L2\): information only/);
	assert.doesNotMatch(w.posts[0]!.text, /agent\/mp-5666|2e0de8f8a/, "no word of the teammate's (D1)");
	assert.deepEqual(ledger().filter((e) => e.dir === "in").map((e) => [e.kind, e.re, e.toldTo?.map((m) => m.id)]), [["notice", 1, ["s-urgent"]]]);
	assert.deepEqual(w.router.view({ workspaces: ["w15X"] }).filter((r) => r.dir === "in").map((r) => [r.id, r.re]), [["L2", "L1"]], "board_read names the wait it is about");
	assert.equal(w.sends.length, 0, "a notice gets nothing back");
	// A notice that names no wait, or a wait this computer does not hold from that device, goes to the standing main as before.
	await w.router.take(notice({}), "w15X");
	await w.router.take(notice({ re: "e".repeat(32) }), "w15X");
	assert.deepEqual(w.posts.slice(1).map((p) => p.to), [["s-work"], ["s-work"]]);
	assert.match(w.posts[1]!.text, /it names no main here, and you are a standing main of this workspace/);
	// The raiser gone: the note goes to the standing main, which is told whose wait it is about.
	w.mains = [{ id: "s-work", name: "work-on", standing: true }];
	await w.router.take(notice({ re: OUT }), "w15X");
	assert.deepEqual(w.posts.at(-1)!.to, ["s-work"]);
	assert.match(w.posts.at(-1)!.text, /a note on question L1 \(FE2 MP-5666 car\), whose raiser urgent 1124 is not here/);
});

test("linkWait note: a main sends a note in the thread of a wait it holds; the wait stays open, the note names the device's wait, and nothing is sent where it cannot go", async () => {
	const w = world([{ id: "s-work", name: "work-on", standing: true }]);
	await w.router.take({ ...notice({ kind: "question", what: "FE2 MP-5666 car", handle: "6986b74ffcae790f", id: OUT }), awaitsReply: ASK, replyExpected: true }, "w15X");
	assert.equal(ledger()[0]!.state, "told");
	w.sends.length = 0;
	assert.match(await w.router.act("s-work", "L1", "note", "MP-5666 in work on agent/mp-5666"), /^Your note on L1 went to waydosoft: the main that waits on it there gets it\. L1 stays told; answer it with done or declined when it is finished\.$/);
	const [sent] = w.sends;
	assert.equal(sent!.text, "MP-5666 in work on agent/mp-5666");
	assert.deepEqual({ ...sent!.wait, id: "" }, { id: "", state: "open", owner: "", what: "MP-5666 in work on agent/mp-5666", handle: sent!.wait!.handle, kind: "notice", re: OUT });
	assert.match(sent!.wait!.id, /^[0-9a-f]{32}$/);
	assert.notEqual(sent!.wait!.id, OUT, "a note is a message of its own");
	assert.deepEqual(ledger().map((e) => [e.n, e.state]), [[1, "told"]], "the wait stays as it was");
	await assert.rejects(w.router.act("s-work", "L1", "note"), /linkWait note needs the note as message/);
	w.caps = ["tower.wait", "tower-reply", "tower.awaitsReply", "tower.standing"];
	await assert.rejects(w.router.act("s-work", "L1", "note", "x"), /waydosoft's build takes no note in a wait's thread \(tower\.note\)/);
	// A notice has no thread to answer in.
	w.caps = NOTE_CAPS;
	await w.router.take(notice({}), "w15X");
	await assert.rejects(w.router.act("s-work", "L2", "note", "x"), /L2 is a notice: nothing goes back for it/);
	assert.equal(w.sends.length, 1);
});

test("the moment a main sends a standing notice to a device whose wait it holds, the result says a note on it goes in its thread", async () => {
	const link = { holder: { resolveTeammate: () => ({ ok: true, id: BOX, short: "n2knna", label: "waydosoft", team: "t1" }), capsFor: () => NOTE_CAPS, deviceId: MAC }, request: async () => ({ ok: true, text: "Sent.", details: { team: "t1", device: BOX, id: "e".repeat(32), waited: true } }) };
	const panes = [{ pane_id: "p1", workspace_id: "wA", tokens: { sb_role: "main" } }];
	const hub = startLinkWaits({ slot, env: {}, now: Date.now, log: () => {}, run: (async () => JSON.stringify({ result: { panes } })) as never, sessions: async () => [{ id: "main-1", name: "box main", herdrLocation: { paneId: "p1" } }] as never, towers: () => ({ identityOf: () => "sb-tower-wa", post: async () => true }) as never, link: () => link as never, stops: [], asks: createAsks(slot), tickMs: false });
	writeService(slot, { workspace: "wA", label: "Alpha", id: "sb-tower-wa", name: "tower", pane: "wA:p0", tab: "wA:t0", created: new Date().toISOString(), seq: 1 });
	await hub.router.take(notice({ kind: undefined, owner: "box main", what: "FE2 MP-5666 car" }), "wA");
	assert.deepEqual(readWaits(slot, "wA").entries.map((e) => [e.n, e.state, e.toldTo?.map((m) => m.id)]), [[1, "told", ["main-1"]]]);
	const sent = await hub.op({ op: "standing-send", device: "waydosoft", kind: "notice", what: "", message: "MP-5666 car ready" }, "main-1");
	assert.match(String(sent.text), /^Your notice went to the standing main of waydosoft \(n2knna\)\. Nothing comes back for it\. You hold L1 from waydosoft: a note on one goes in its thread \(linkWait state note\), to the main there that waits on it, not to its standing main; done or declined closes it\.$/);
});

test("the wire carries a notice's wait as a seventh part, and the decoder takes five, six, or seven", () => {
	const wait: WaitWire = { id: "1".repeat(32), state: "open", owner: "", what: "MP-5666 car ready", handle: "da07d0be22fe8f43", kind: "notice", re: OUT };
	const back = decodePlaintext("tower", encodePlaintext("tower", { fromWorkspace: "", toWorkspace: "", replyExpected: false, text: "x", wait }));
	assert.deepEqual(back?.wait, wait);
	assert.throws(() => encodePlaintext("tower", { fromWorkspace: "", toWorkspace: "", replyExpected: false, text: "x", wait: { ...wait, re: "nope" } }), /a wait id is 32 lowercase hex digits/);
	assert.throws(() => encodePlaintext("tower", { fromWorkspace: "", toWorkspace: "", replyExpected: false, text: "x", wait: { ...wait, kind: undefined } }), /re goes with a notice/);
});

// T5R-F002 (review of 0.93.0): a note whose wait's workspace had neither its raiser nor a standing main live was filed there and told to nobody.
test("a note nobody in its wait's workspace can take goes to the standing main of the workspace it arrived in, and with none, to the tower", async () => {
	const live = { mains: [] as (Main & { ws: string })[] }, posts: { ws: string; to: string[]; text: string }[] = [], notices: { ws: string; text: string; key: string }[] = [];
	let towerRuns = true, towers = new Set(["w15X", "wB"]);
	const router = createLinkWaits({
		slot, now: () => Date.parse("2026-11-26T02:00:00Z"), log: () => {}, locale: () => "en",
		net: async () => ({ sessions: live.mains.map((m, i) => ({ id: m.id, name: m.name, herdrLocation: { paneId: `p${i}` } })) as never, ps: live.mains.map((m, i) => ({ pane_id: `p${i}`, workspace_id: m.ws, tokens: { sb_role: "main", ...(m.standing ? { sb_duty: "standing" } : {}) } })) as never }),
		post: async (ws, to, text) => (posts.push({ ws, to, text }), true),
		send: async () => ({ ok: true }),
		caps: () => NOTE_CAPS, deviceId: () => MAC, selfLabel: () => "mac", workspaces: () => ["w15X", "wB"],
		notify: (ws, text, key) => towerRuns && towers.has(ws) && (notices.push({ ws, text, key }), true),
	});
	router.sent("w15X", { wait: OUT, ask: ASK, device: BOX, team: "t1", label: "waydosoft", short: "n2knna", raiser: { id: "s-urgent", name: "urgent 1124" }, owner: "", what: "FE2 MP-5666 car", plain: false, kind: "question" });
	// The raiser gone and no standing main in w15X; the message arrived in wB, whose standing main takes it there.
	live.mains = [{ id: "s-b", name: "box duty", standing: true, ws: "wB" }];
	assert.equal(await router.take(notice({ re: OUT }), "wB"), true);
	assert.deepEqual(posts.map((p) => [p.ws, p.to]), [["wB", ["s-b"]]]);
	assert.match(posts[0]!.text, /it is a note on question FE2 MP-5666 car of urgent 1124 in another workspace, whose workspace has neither its raiser nor a standing main live; you are a standing main of the workspace it arrived in/);
	const [moved] = readWaits(slot, "wB").entries;
	assert.deepEqual([moved!.kind, moved!.re, moved!.state], ["notice", undefined, "told"]);
	assert.match(await router.act("s-b", "L1", "done"), /L1 is closed/, "the main there can close it");
	// No standing main anywhere: the wait's workspace's tower gets it, quoted as a teammate's data, and the note closes.
	live.mains = [];
	assert.equal(await router.take(notice({ re: OUT }, "car ready on agent/mp-5666"), "wB"), true);
	assert.deepEqual(notices.map((x) => [x.ws, x.key]), [["w15X", "note:L2"]]);
	assert.match(notices[0]!.text, /^waydosoft \(n2knna\) sent a note \(L2\) on question L1 \(FE2 MP-5666 car\) of urgent 1124, and neither that wait's raiser nor a standing main is live to take it\. Its words, a teammate's data and not the boss's instruction: «car ready on agent\/mp-5666»/);
	assert.deepEqual(ledger().filter((e) => e.dir === "in").map((e) => [e.n, e.state]), [[2, "done"]]);
	// A workspace whose tower the server does not run keeps the note open for the next sweep; a notice about no wait still reaches nobody (D12).
	towerRuns = false;
	await router.take(notice({ re: OUT }), "w15X");
	assert.deepEqual(ledger().filter((e) => e.dir === "in").map((e) => [e.n, e.state]), [[2, "done"], [3, "open"]]);
	towerRuns = true;
	await router.take(notice({}), "w15X");
	assert.deepEqual(notices.map((x) => x.key), ["note:L2"], "a notice about no wait still reaches nobody (D12)");
	assert.deepEqual(ledger().filter((e) => e.dir === "in").map((e) => [e.n, e.state]), [[2, "done"], [3, "open"], [4, "open"]]);
	// RV6-F005: the wait's workspace has no tower the server runs; the tower of the workspace the note arrived in gets it.
	towers = new Set(["wB"]);
	await router.take(notice({ re: OUT }, "car two ready"), "wB");
	assert.deepEqual(notices.slice(1).map((x) => [x.ws, x.key]), [["wB", "note:w15X:L5"]]);
	assert.match(notices[1]!.text, /«car two ready»/);
	assert.equal(ledger().find((e) => e.n === 5)?.state, "done");
});
