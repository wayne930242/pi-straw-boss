import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { WaitWire } from "../src/link/kinds.ts";
import type { InboxItem } from "../src/link/store.ts";
import { CLAIM_MS, createLinkWaits, readWaits, type WaitsDeps } from "../src/server/linkwaits.ts";
import { slotOf, type Slot } from "../src/server/record.ts";
import { readMemory } from "../src/server/towermemory.ts";
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
interface World { t: number; posts: { ws: string; to: string[]; text: string; kind: string; wait?: string }[]; sends: { ws: string; req: Parameters<WaitsDeps["send"]>[1] }[]; mains: { id: string; name: string }[]; router: ReturnType<typeof createLinkWaits>; caps: string[] }
function world(o: { mains?: { id: string; name: string }[]; self?: string; caps?: string[] } = {}): World {
	const w = { t: Date.parse("2026-11-21T10:00:00Z"), posts: [], sends: [], mains: o.mains ?? [], caps: o.caps ?? ["tower.wait", "tower-reply", "tower.awaitsReply"] } as unknown as World;
	w.router = createLinkWaits({
		slot, now: () => w.t, log: () => {}, locale: () => "en",
		net: async () => ({ sessions: w.mains.map((m, i) => ({ id: m.id, name: m.name, herdrLocation: { paneId: `p${i}` } })) as never, ps: w.mains.map((_, i) => ({ pane_id: `p${i}`, workspace_id: "w15X", tokens: { sb_role: "main" } })) as never }),
		post: async (ws, to, text, kind, extra) => (w.posts.push({ ws, to, text, kind, ...(extra.wait ? { wait: extra.wait } : {}) }), true),
		send: async (ws, req) => (w.sends.push({ ws, req }), { ok: true }),
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
	const answer = k.sends.at(-1)!.req;
	assert.deepEqual([answer.inReplyTo, answer.text, answer.wait], [ASK, "merged as 4d2a1f", undefined], "a tower-reply to the sender's ask");
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
	const answer = w.sends.at(-1)!.req;
	assert.deepEqual([answer.inReplyTo, answer.text], [ASK, "declined by the boss on mac"]);
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
	assert.match(box.posts.at(-1)!.text, /^mac \(ibzkd5\): your wait L1 \(merge !13\) is told to a main there by work-on\.$/);
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
