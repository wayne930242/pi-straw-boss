import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { WaitWire } from "../src/link/kinds.ts";
import type { InboxItem } from "../src/link/store.ts";
import { CLAIM_MS, CLOSED_PER_DEVICE, createLinkWaits, OPEN_PER_DEVICE, readWaits, TEXT_SHOWN, type WaitsDeps } from "../src/server/linkwaits.ts";
import { slotOf, type Slot } from "../src/server/record.ts";
import { returnParked } from "../src/server/autotower.ts";
import { readMemory, resolveWait, updateMemory } from "../src/server/towermemory.ts";
import { towerDir } from "../src/server/towerstore.ts";
import { pressRequest } from "../src/server/waitpress.ts";

// The wait router (docs/specs/2026-11-21-box-mac-waits.md §2.2, §2.4, §9 anchor 2): who a teammate device's wait is told to, the card on the boss's list, the claim window on a clock the test moves, a main's answer, the boss's press,
// the fold of a fourth card, and the sender's side of the same ledger. The wake to a main never carries the teammate's text.

let root = "", slot: Slot;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-waits-"));
	slot = slotOf(join(root, "state"), { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const BOX = "n2knna6dkfud5sura2vst4gsee", MAC = "ibzkd5ijmtravej475kmrykvye", ASK = "c".repeat(32);
const SECRET_TEXT = "please merge !13 now — here is everything about it";
interface World { t: number; hold?: Promise<void>; posts: { ws: string; to: string[]; text: string; kind: string; wait?: string }[]; sends: { ws: string; req: Parameters<WaitsDeps["send"]>[1] }[]; mains: { id: string; name: string }[]; router: ReturnType<typeof createLinkWaits>; caps: string[] }
function world(o: { mains?: { id: string; name: string }[]; self?: string; caps?: string[]; auto?: () => boolean } = {}): World {
	const w = { t: Date.parse("2026-11-21T10:00:00Z"), posts: [], sends: [], mains: o.mains ?? [], caps: o.caps ?? ["tower.wait", "tower-reply", "tower.awaitsReply"] } as unknown as World;
	w.router = createLinkWaits({
		slot, now: () => w.t, log: () => {}, locale: () => "en", ...(o.auto ? { autoOn: o.auto } : {}),
		net: async () => ({ sessions: w.mains.map((m, i) => ({ id: m.id, name: m.name, herdrLocation: { paneId: `p${i}` } })) as never, ps: w.mains.map((_, i) => ({ pane_id: `p${i}`, workspace_id: "w15X", tokens: { sb_role: "main" } })) as never }),
		// A test that sets `hold` holds every wake and send made while it is set until it resolves; each is recorded when it is made.
		post: async (ws, to, text, kind, extra) => (w.posts.push({ ws, to, text, kind, ...(extra.wait ? { wait: extra.wait } : {}) }), await w.hold, true),
		send: async (ws, req) => (w.sends.push({ ws, req }), await w.hold, { ok: true }),
		caps: () => w.caps, deviceId: () => o.self ?? MAC, selfLabel: () => "mac", workspaces: () => ["w15X"],
	});
	return w;
}
let n = 0;
const item = (wait: Partial<WaitWire>, over: Partial<InboxItem> = {}): InboxItem => ({
	v: 1, id: (++n).toString(16).padStart(32, "0"), team: "t1", from: BOX, fromLabel: "waydosoft", fromShort: "n2knna", seq: n, sentAt: 1, received: 1, fromWorkspace: "box", toWorkspace: "", replyExpected: true, text: SECRET_TEXT, awaitsReply: ASK,
	wait: { id: n.toString(16).padStart(32, "a"), state: "open", owner: "", what: "merge !13", handle: "0123456789abcdef", ...wait }, ...over,
});
const ledger = () => readWaits(slot, "w15X").entries;
const cards = () => readMemory(slot, "w15X", Date.now()).memory.entries.filter((e) => e.kind === "wait" && e.card?.from?.id === `link:${BOX}`);

test("a wait that names a live main by name is told to that main alone, in a code-written line with no peer text; the sender is told who has it", async () => {
	const w = world({ mains: [{ id: "s-work", name: "work-on" }, { id: "s-integ", name: "integ moldplan-center" }] });
	assert.equal(await w.router.take(item({ owner: "Work-On" }), "w15X"), true);
	assert.equal(w.posts.length, 1);
	const [wake] = w.posts;
	assert.deepEqual([wake!.to, wake!.kind, wake!.wait], [["s-work"], "link_wait", "L1"]);
	assert.doesNotMatch(wake!.text, /merge|please|!13/, "no word of the teammate's reaches the wake");
	assert.match(wake!.text, /waydosoft waits on this workspace \(wait L1, owner asked: you\)\. Read it with board_read/);
	assert.deepEqual(ledger().map((e) => [e.dir, e.state, e.toldTo?.map((m) => m.name)]), [["in", "told", ["work-on"]]]);
	const ack = w.sends.at(-1)!.req;
	assert.deepEqual([ack.device, ack.wait?.state, ack.wait?.owner], [BOX, "told", "work-on"]);
	assert.match(ack.text, /^told work-on \(main on mac\)$/);
	// A copy of the same envelope's wait is taken and nothing more happens.
	const again = item({}, {});
	again.wait!.id = ledger()[0]!.wait!;
	assert.equal(await w.router.take(again, "w15X"), true);
	assert.equal(w.posts.length, 1);
	// The board shows it in full to a reader of the workspace, and only to its team from a remote turn.
	assert.deepEqual(w.router.view({ workspaces: ["w15X"] }).map((r) => [r.id, r.dir, r.text, r.toldTo]), [["L1", "in", SECRET_TEXT, ["work-on"]]]);
	assert.deepEqual(w.router.view({ teams: ["other"] }), []);
});

test("no owner and two mains: one wake whose to lists both; no main: a card on the boss's list with code-written fields", async () => {
	const two = world({ mains: [{ id: "s-a", name: "alpha" }, { id: "s-b", name: "beta" }] });
	await two.router.take(item({ owner: "" }), "w15X");
	assert.deepEqual(two.posts.map((p) => p.to), [["s-a", "s-b"]]);
	assert.match(two.posts[0]!.text, /owner asked: anyone here/);
	rmSync(join(root, "state"), { recursive: true, force: true });
	const none = world();
	await none.router.take(item({ owner: "work-on" }), "w15X");
	assert.equal(none.posts.length, 0);
	const [card] = cards();
	assert.ok(card, "a card");
	assert.equal(card!.card!.type, "action");
	assert.equal(card!.card!.from!.id, `link:${BOX}`);
	assert.match(card!.card!.happened, /^waydosoft \(teammate device\) waits on this computer: «merge !13» \(the teammate's words\)\.$/);
	assert.match(card!.card!.do, /Find who here owns it and have them answer the wait, or decline it so waydosoft stops waiting/);
	assert.deepEqual(ledger().map((e) => [e.state, e.card]), [["open", card!.id]]);
	assert.match(none.sends.at(-1)!.req.text, /^on the boss's list of mac \(W1\)$/);
});

test("a told wait no main takes within 30 minutes becomes a card; one a main takes never does, and its done answers the sender's ask and closes it", async () => {
	const w = world({ mains: [{ id: "s-work", name: "work-on" }] });
	await w.router.take(item({ owner: "work-on" }), "w15X");
	w.t += CLAIM_MS - 1000;
	await w.router.tick();
	assert.equal(cards().length, 0, "not before the window ends");
	w.t += 2000;
	await w.router.tick();
	assert.equal(cards().length, 1, "a card once it ends");

	rmSync(join(root, "state"), { recursive: true, force: true });
	const k = world({ mains: [{ id: "s-work", name: "work-on" }] });
	await k.router.take(item({ owner: "work-on" }), "w15X");
	assert.match(await k.router.act("s-work", "L1", "taken"), /L1 is yours/);
	assert.deepEqual([k.sends.at(-1)!.req.wait?.state, k.sends.at(-1)!.req.wait?.owner], ["taken", "work-on"]);
	k.t += 2 * CLAIM_MS;
	await k.router.tick();
	assert.equal(cards().length, 0, "a taken wait raises no card");
	await assert.rejects(k.router.act("s-other", "L1", "done", "x"), /Only a main of this computer answers a link wait/);
	assert.match(await k.router.act("s-work", "L1", "done", "merged as 4d2a1f"), /L1 is done\. Your message leaves this computer as written/);
	const [answer, state] = k.sends.slice(-2).map((x) => x.req);
	assert.deepEqual([answer!.inReplyTo, answer!.text, answer!.wait], [ASK, "merged as 4d2a1f", undefined], "a tower-reply to the sender's ask");
	assert.deepEqual([state!.inReplyTo, state!.wait?.state, state!.text], [undefined, "done", "done on mac"], "then the wait's state, which closes it there after the ask's 24 hours too (BMWR-F008)");
	assert.equal(ledger()[0]!.state, "done");
	await assert.rejects(k.router.act("s-work", "L1", "declined"), /L1 is done already/);
});

test("the boss declines a link card: the device gets the code-written words, the wait closes, and the tower's event says the device got it", async () => {
	const w = world();
	await w.router.take(item({}), "w15X");
	const card = cards()[0]!;
	const events: string[] = [];
	const pressed = await pressRequest({ slot, now: () => w.t, log: { line() {}, hide() {} } as never, locale: "en", live: async () => false, send: async () => ({ status: "failed" }), boss: (text) => void events.push(text), linkPress: (id, act) => w.router.pressed("w15X", id, act) }, "w15X", { op: "press", id: card.id, act: "decline" });
	assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
	const [answer, state] = w.sends.slice(-2).map((x) => x.req);
	assert.deepEqual([answer!.inReplyTo, answer!.text], [ASK, "declined by the boss on mac"]);
	assert.equal(state!.wait?.state, "declined", "the sender's wait says declined, not done");
	assert.equal(ledger()[0]!.state, "declined");
	assert.match(events[0]!, /waydosoft got it\./);
});

test("a fourth open card of one device folds into the third: three cards, the third says how many more", async () => {
	const w = world();
	for (let i = 0; i < 4; i++) await w.router.take(item({ what: `step ${i}` }), "w15X");
	const shown = cards();
	assert.equal(shown.length, 3);
	assert.match(shown[2]!.card!.happened, / And 1 more; see board_read\.$/);
	assert.deepEqual(ledger().map((e) => [e.card, e.folded ?? false]), [[shown[0]!.id, false], [shown[1]!.id, false], [shown[2]!.id, false], [shown[2]!.id, true]]);
});

test("the sender's side: a wait it sent hears each state in a code-written line to its raiser, closes when its ask is answered, and a raiser gone for two sweeps cancels it", async () => {
	const box = world({ self: BOX, mains: [{ id: "raiser-1", name: "box main" }] });
	const id = box.router.sent("w15X", { wait: "d".repeat(32), ask: ASK, device: MAC, team: "t1", label: "mac", short: "ibzkd5", raiser: { id: "raiser-1", name: "box main" }, owner: "work-on", what: "merge !13", event: "e1", plain: false });
	assert.equal(id, "L1");
	const told = item({ id: "d".repeat(32), state: "told", owner: "work-on" }, { from: MAC, fromLabel: "mac", fromShort: "ibzkd5", text: "told work-on (main on mac)" });
	assert.equal(await box.router.take(told, "w15X"), true);
	assert.equal(ledger()[0]!.state, "told");
	assert.deepEqual([box.posts.at(-1)!.to, box.posts.at(-1)!.kind], [["raiser-1"], "link_wait_state"]);
	assert.match(box.posts.at(-1)!.text, /^mac \(ibzkd5\): your wait L1 \(merge !13\) is told to a main there\.$/);
	box.router.answered(ASK);
	assert.equal(ledger()[0]!.state, "done");
	box.router.sent("w15X", { wait: "e".repeat(32), device: MAC, team: "t1", label: "mac", short: "ibzkd5", raiser: { id: "raiser-2", name: "gone main" }, owner: "", what: "a review", event: "e2", plain: false });
	await box.router.tick();
	assert.equal(ledger()[1]!.state, "open", "one sweep is not enough");
	await box.router.tick();
	assert.equal(ledger()[1]!.state, "cancelled");
	assert.deepEqual([box.sends.at(-1)!.req.wait?.state, box.sends.at(-1)!.req.text], ["cancelled", "withdrawn: raiser gone"]);
});

test("waits older than 7 days expire on both ends; a C2 reply with no live main goes to the boss's list, never anywhere else", async () => {
	const w = world({ mains: [{ id: "s-work", name: "work-on" }] });
	await w.router.take(item({}), "w15X");
	w.t += 7 * 86_400_000;
	await w.router.tick();
	assert.equal(ledger()[0]!.state, "expired");
	assert.equal(w.sends.at(-1)!.req.wait?.state, "expired");
	rmSync(join(root, "state"), { recursive: true, force: true });
	const none = world();
	assert.equal(await none.router.orphan({ ...item({}), wait: undefined, reply: { ask: ASK, main: "gone", mainName: "work-on", tower: "sb-tower-w15x" } } as InboxItem, "work-on", "w15X"), true);
	assert.deepEqual(ledger().map((e) => [e.kind, e.owner, e.what]), [["reply", "work-on", "answer to work-on's ask"]]);
	assert.equal(cards().length, 1);
	assert.equal(await none.router.orphan({ ...item({}), wait: undefined } as InboxItem, "x", undefined), false, "no workspace: it stays in the inbox");
});

test("the router never lets a card's close end a wait: a link card auto mode's end gives back (no session raiser: gone) is raised again at the next sweep, and the wait stays open", async () => {
	let auto = true;
	const w = world({ auto: () => auto });
	await w.router.take(item({}), "w15X");
	const [parked] = cards();
	assert.equal(parked!.parked, true, "parked under auto mode, like every card");
	auto = false;
	const back = returnParked(slot, w.t, [{ workspace: "w15X", label: "MP Center" }], () => "gone");
	assert.deepEqual(back.map((b) => [b.entry.id, b.to]), [[parked!.id, "gone"]]);
	assert.equal(cards().find((c) => c.id === parked!.id)!.state, "resolved");
	w.t += 60_000;
	await w.router.tick();
	const open = cards().filter((c) => c.state === "open");
	assert.equal(open.length, 1, "a card again");
	assert.notEqual(open[0]!.id, parked!.id);
	assert.deepEqual(ledger().map((e) => [e.state, e.card]), [["open", open[0]!.id]], "the wait is still open and names the new card");
	assert.equal(w.sends.some((x) => /declined|done/.test(x.req.text)), false, "the device is told nothing closed it");
});

// BMWR-F001: the router's changes run one at a time, so a sweep, a main's answer, and a new wait never act on the same wait at once. Each case holds a wake or a send on a promise the test resolves.
const settle = () => new Promise<void>((r) => setImmediate(r));
async function until(f: () => boolean, what: string) {
	for (let i = 0; i < 200 && !f(); i++) await settle();
	assert.ok(f(), what);
}
const gate = (w: World) => {
	let release!: () => void;
	w.hold = new Promise<void>((r) => (release = r));
	return () => (w.hold = undefined, release());
};

test("BMWR-F001: a sweep while a new wait's wake is under way waits its turn: one wake, and the wait is told once", async () => {
	const w = world({ mains: [{ id: "s-work", name: "work-on" }] });
	const release = gate(w);
	const taking = w.router.take(item({ owner: "work-on" }), "w15X");
	await until(() => w.posts.length === 1, "the wake is under way");
	w.hold = undefined;
	const sweeping = w.router.tick();
	await settle();
	release();
	await Promise.all([taking, sweeping]);
	assert.equal(w.posts.length, 1, "one wake");
	assert.deepEqual(ledger().map((e) => [e.state, e.card]), [["told", undefined]]);
	assert.equal(cards().length, 0);
});

test("BMWR-F001: a main takes a wait while the sweep is under way: the sweep acts on the wait as it is now, so no card comes back for a taken wait and no told goes after taken", async () => {
	const w = world({ mains: [{ id: "s-work", name: "work-on" }] });
	await w.router.take(item({ owner: "work-on", what: "one" }), "w15X");
	await w.router.take(item({ owner: "work-on", what: "two" }), "w15X");
	w.t += CLAIM_MS;
	await w.router.tick();
	const [c1, c2] = cards();
	assert.deepEqual(ledger().map((e) => e.card), [c1!.id, c2!.id]);
	// L1's card is closed by hand, so the sweep raises it again and its ack to the device is held.
	updateMemory(slot, "w15X", w.t, (m) => void resolveWait(m, c1!.id, "dropped", w.t));
	const release = gate(w), before = w.sends.length;
	const sweeping = w.router.tick();
	await until(() => w.sends.length > before, "the sweep's ack is under way");
	w.hold = undefined;
	const taking = w.router.act("s-work", "L2", "taken");
	await settle();
	release();
	await Promise.all([sweeping, taking]);
	const open = cards().filter((c) => c.state === "open");
	assert.equal(open.length, 1, "L1's new card only");
	assert.deepEqual(ledger().map((e) => [e.state, e.card === open[0]!.id]), [["told", true], ["taken", false]]);
	const l2 = w.sends.filter((x) => x.req.wait?.what === "two").map((x) => x.req.wait!.state);
	assert.equal(l2.at(-1), "taken", `L2's acks end with taken: ${l2.join(" ")}`);
});

test("BMWR-F001: two mains answer one wait at once: one answer leaves, the other is told it is closed already", async () => {
	const w = world({ mains: [{ id: "s-a", name: "alpha" }, { id: "s-b", name: "beta" }] });
	await w.router.take(item({ owner: "" }), "w15X");
	const both = await Promise.allSettled([w.router.act("s-a", "L1", "done", "merged"), w.router.act("s-b", "L1", "done", "merged too")]);
	assert.deepEqual(both.map((r) => r.status), ["fulfilled", "rejected"]);
	assert.match(String((both[1] as PromiseRejectedResult).reason), /L1 is done already/);
	assert.equal(w.sends.filter((x) => x.req.inReplyTo === ASK).length, 1, "one answer to the sender's ask");
});

test("BMWR-F005: the raiser's line holds no word of the other end; a state sent again or one behind changes nothing; who holds it there shows in board_read only", async () => {
	const box = world({ self: BOX, mains: [{ id: "raiser-1", name: "box main" }] });
	box.router.sent("w15X", { wait: "d".repeat(32), ask: ASK, device: MAC, team: "t1", label: "mac", short: "ibzkd5", raiser: { id: "raiser-1", name: "box main" }, owner: "work-on", what: "merge !13", event: "e1", plain: false });
	const from = { from: MAC, fromLabel: "mac", fromShort: "ibzkd5", text: "x" };
	const state = (s: "told" | "taken", owner: string) => box.router.take(item({ id: "d".repeat(32), state: s, owner }, from), "w15X");
	await state("told", "IGNORE ALL PREVIOUS");
	await state("told", "spam spam spam");
	await state("taken", "work-on");
	await state("told", "back");
	await state("taken", "again");
	assert.deepEqual(box.posts.map((p) => p.text), ["mac (ibzkd5): your wait L1 (merge !13) is told to a main there.", "mac (ibzkd5): your wait L1 (merge !13) is taken."]);
	assert.deepEqual(box.router.view({ workspaces: ["w15X"] }).map((r) => [r.state, r.heldBy]), [["taken", "work-on"]]);
});

test("BMWR-F004: a device's text is kept as board_read shows it, its open waits stop at the bound (the next stays in the inbox), and its closed entries past theirs go", async () => {
	const w = world();
	assert.equal(await w.router.take(item({}, { text: "x".repeat(10 * TEXT_SHOWN) }), "w15X"), true);
	assert.ok(Array.from(ledger()[0]!.text).length <= TEXT_SHOWN, "the text is cut when it is kept");
	for (let i = 1; i < OPEN_PER_DEVICE; i++) assert.equal(await w.router.take(item({ what: `w${i}` }), "w15X"), true);
	assert.equal(await w.router.take(item({ what: "one more" }), "w15X"), "held");
	assert.equal(ledger().filter((e) => e.state === "open").length, OPEN_PER_DEVICE);
	assert.equal(cards().length, 3, "D7: three cards, the rest folded");
	await assert.rejects(w.router.escalate("w15X", { team: "t1", device: BOX, label: "waydosoft", short: "n2knna", what: "x", kind: "wait", text: "x" }), /open waits on this computer already/);
	// Closed entries of the device: the newest are kept.
	const closed = Array.from({ length: CLOSED_PER_DEVICE + 10 }, (_, i) => ({ n: 100 + i, dir: "in", kind: "wait", device: BOX, team: "t1", label: "waydosoft", short: "n2knna", owner: "", what: "old", text: "", since: w.t, at: w.t + i, state: "done" }));
	writeFileSync(join(towerDir(slot, "w15X"), "linkwaits.json"), JSON.stringify({ v: 1, next: 200, entries: closed }));
	await w.router.take(item({ what: "new" }), "w15X");
	const kept = ledger();
	assert.equal(kept.filter((e) => e.state === "done").length, CLOSED_PER_DEVICE);
	assert.equal(Math.min(...kept.filter((e) => e.state === "done").map((e) => e.n)), 110, "the oldest went");
	assert.deepEqual(kept.filter((e) => e.state !== "done").map((e) => e.n), [200]);
});

test("BMWR-F011: a ledger that cannot be read is never written over; the next id is past every id the ledger holds", async () => {
	const w = world();
	const at = join(towerDir(slot, "w15X"), "linkwaits.json");
	mkdirSync(towerDir(slot, "w15X"), { recursive: true });
	writeFileSync(at, "{ not json");
	await assert.rejects(w.router.take(item({}), "w15X"), /linkwaits\.json is unreadable/);
	assert.equal(readFileSync(at, "utf8"), "{ not json", "left as it was");
	writeFileSync(at, JSON.stringify({ v: 1, next: 1, entries: [{ n: 5, dir: "in", kind: "wait", device: BOX, team: "t1", label: "waydosoft", short: "n2knna", owner: "", what: "old", text: "", since: w.t, at: w.t, state: "done" }] }));
	await w.router.take(item({}), "w15X");
	assert.deepEqual(ledger().map((e) => e.n), [5, 6]);
});

test("BMWR-F002: the server's hand-off routes an open wait only in a workspace whose tower it runs; a resident pi tower's workspace is no place for it", async () => {
	const { startLinkWaits } = await import("../src/server/linkwaitsops.ts");
	let identity: string | undefined;
	const hub = startLinkWaits({ slot, env: {}, now: () => Date.parse("2026-11-21T10:00:00Z"), log: () => {}, run: async () => { throw new Error("no Herdr in this test"); }, sessions: async () => [], towers: () => ({ identityOf: () => identity, post: async () => false }) as never, link: () => undefined, stops: [], tickMs: false });
	assert.equal(await hub.holder.take(item({}), "w15X"), false, "a resident tower: the holder treats it as a message that found no tower");
	assert.deepEqual(ledger(), []);
	assert.equal(await hub.holder.orphan!({ ...item({}), wait: undefined } as InboxItem, "work-on", "w15X"), false);
	identity = "sb-tower-w15x";
	assert.equal(await hub.holder.take(item({}), "w15X"), true);
	assert.deepEqual(ledger().map((e) => [e.state, !!e.card]), [["open", true]], "routed: no main, so a card");
});
