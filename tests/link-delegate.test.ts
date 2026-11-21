import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { InboxItem } from "../src/link/store.ts";
import { createLinkWaits, readWaits, type WaitsDeps } from "../src/server/linkwaits.ts";
import { slotOf, type Slot } from "../src/server/record.ts";
import { loadMemory, memoryTool } from "../src/server/towermemory.ts";
import type { Raiser } from "../src/server/waitcard.ts";

// The delegate approver (docs/specs/2026-11-21-box-mac-waits.md §15, D14): a device that names a delegate sends a card that would go to its boss's list to the delegate device's standing main first, as a link wait of kind
// `approval` through the wait router. Two routers stand for the two devices here (the box raises, the Mac decides); what one sends the other takes, as the holder hands a `tower` with a wait field to its router.
// Boss quotes: 「每次無人塔台幹嘛我都要核准，也太煩了吧，你不能幫我核准嗎」, 「代理人什麼都能核准，除非他覺得應該問我」.

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-link-delegate-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));

const BOX = "n2knna6dkfud5sura2vst4gsee", MAC = "ibzkd5ijmtravej475kmrykvye", THIRD = "q3knna6dkfud5sura2vst4gsee";
const RAISER = "4f1c9a20-1111-4222-8333-444455556666";
const raiserRow: Raiser = { id: RAISER, name: "mp5166-perf", role: "main", workspace: "MP Center", tab: "MP-5166" };
const APPROVAL_CAPS = ["tower.wait", "tower-reply", "tower.awaitsReply", "tower.standing", "tower.approval"];
type Send = Parameters<WaitsDeps["send"]>[1];
interface Side {
	slot: Slot; ws: string; t: { now: number }; sends: Send[]; posts: { to: string[]; text: string; kind: string; wait?: string }[]; notices: { text: string; key: string }[]; logs: string[];
	mains: { id: string; name: string; standing?: boolean }[]; router: ReturnType<typeof createLinkWaits>;
}
interface Opts { self: string; label: string; ws: string; mains?: Side["mains"]; delegate?: { device: string; owner?: string }; level?: string; caps?: string[]; member?: (device: string) => { team: string; label: string; short: string } | undefined }
const t = { now: Date.parse("2026-11-21T15:00:00Z") };
function side(o: Opts): Side {
	const slot = slotOf(join(root, o.label), { HOME: join(root, `${o.label}-home`), PI_CODING_AGENT_DIR: join(root, `${o.label}-agent`) });
	const s = { slot, ws: o.ws, t, sends: [], posts: [], notices: [], logs: [], mains: o.mains ?? [] } as unknown as Side;
	s.router = createLinkWaits({
		slot, now: () => t.now, log: (event) => void s.logs.push(event), locale: () => "en",
		net: async () => ({ sessions: s.mains.map((m, i) => ({ id: m.id, name: m.name, herdrLocation: { paneId: `p${i}` } })) as never, ps: s.mains.map((m, i) => ({ pane_id: `p${i}`, workspace_id: o.ws, tokens: { sb_role: "main", ...(m.standing ? { sb_duty: "standing" } : {}) } })) as never }),
		post: async (_ws, to, text, kind, extra) => (s.posts.push({ to, text, kind, ...(extra.wait ? { wait: extra.wait } : {}) }), true),
		send: async (_ws, req) => (s.sends.push(req), { ok: true, details: { waited: true } }),
		caps: () => o.caps ?? APPROVAL_CAPS, deviceId: () => o.self, selfLabel: () => o.label, workspaces: () => [o.ws],
		...(o.delegate ? { delegate: () => o.delegate } : {}),
		level: () => o.level ?? "dispatch",
		member: o.member ?? ((device: string) => (device === MAC ? { team: "t1", label: "mac", short: "ibzkd5" } : device === THIRD ? { team: "t1", label: "third", short: "q3knna" } : device === BOX ? { team: "t1", label: "waydosoft", short: "n2knna" } : undefined)),
		notify: (_ws, text, key) => void s.notices.push({ text, key }),
	});
	return s;
}
const box = (o: Partial<Opts> = {}) => side({ self: BOX, label: "waydosoft", ws: "wBox", delegate: { device: MAC }, ...o });
const mac = (o: Partial<Opts> = {}) => side({ self: MAC, label: "mac", ws: "w15X", mains: [{ id: "s-work", name: "work-on", standing: true }], ...o });
let seq = 0;
/** What `from` sent reaches `to` as its holder hands it over: the sends not delivered yet, in order. */
async function pump(from: Side, fromId: string, fromLabel: string, to: Side): Promise<void> {
	for (const req of from.sends.splice(0)) {
		const item: InboxItem = { v: 1, id: (++seq).toString(16).padStart(32, "0"), team: "t1", from: fromId, fromLabel, fromShort: fromId.slice(0, 6), seq, sentAt: 1, received: 1, fromWorkspace: "x", toWorkspace: "", replyExpected: false, text: req.text, ...(req.wait ? { wait: req.wait } : {}) };
		if (req.wait) await to.router.take(item, to.ws);
	}
}
const toolEnv = (s: Side, over: Partial<Parameters<typeof memoryTool>[0]> = {}): Parameters<typeof memoryTool>[0] => ({
	slot: s.slot, workspace: s.ws, run: "r1", now: () => t.now, bossEvents: () => [], session: async (q: string) => ({ id: `id-${q}`, name: q }), log: { line() {}, hide() {} } as never,
	intercomEvents: () => [{ id: "e1", from: { id: RAISER, name: "mp5166-perf" } }], raiser: async (id: string) => (id === RAISER ? raiserRow : undefined), locale: () => "en" as const,
	delegate: (c) => s.router.delegateCard(s.ws, { run: "r1", ...c }), ...over,
});
const CARD_ARGS = { op: "add", kind: "wait", for: "boss", type: "action", from: RAISER, happened: "The perf box's disk trim job is ready to switch on.", do: "Approve switching on the weekly fstrim on ci-sandbox-01.", command: "mpi ssh ci-sandbox-01 sudo systemctl enable --now fstrim.timer", after: "The tower asks mp5166-perf to apply it." };
const cards = (s: Side) => loadMemory(s.slot, s.ws).memory.entries.filter((e) => e.kind === "wait" && e.for === "boss");
const ledger = (s: Side) => readWaits(s.slot, s.ws).entries;

test("(a) a box boss wait with a live delegate becomes a link wait to the Mac's standing main, and no card reaches the boss's list", async () => {
	const b = box(), m = mac();
	const got = await memoryTool(toolEnv(b), CARD_ARGS);
	assert.match(got.text, /^Sent to the boss's delegate on mac as L1, not to the boss's list/);
	assert.deepEqual(cards(b), [], "no card on the box's list");
	assert.deepEqual(ledger(b).map((w) => [w.dir, w.kind, w.state, w.device]), [["out", "approval", "open", MAC]]);
	const [sent] = b.sends;
	assert.deepEqual([sent!.device, sent!.wait?.kind, sent!.wait?.state, sent!.inReplyTo], [MAC, "approval", "open", undefined]);
	assert.match(sent!.text, /Approve switching on the weekly fstrim on ci-sandbox-01\./, "the card's content travels (D11)");
	assert.match(sent!.text, /command: mpi ssh ci-sandbox-01 sudo systemctl enable --now fstrim\.timer/);
	await pump(b, BOX, "waydosoft", m);
	assert.deepEqual(ledger(m).map((w) => [w.dir, w.kind, w.state, w.toldTo?.map((x) => x.name)]), [["in", "approval", "told", ["work-on"]]]);
	const [wake] = m.posts;
	assert.deepEqual([wake!.to, wake!.kind, wake!.wait], [["s-work"], "link_wait", "L1"]);
	assert.match(wake!.text, /You may approve anything on the boss's behalf/);
	assert.match(wake!.text, /call_tower why=blocked with linkWait \{id: "L1", state: "escalated"\}/);
	assert.doesNotMatch(wake!.text, /fstrim/, "the wake carries no teammate text (D1)");
	assert.deepEqual(cards(m), [], "no card on the Mac's list either");
	await pump(m, MAC, "mac", b);
	assert.equal(ledger(b)[0]!.state, "told", "the box hears the Mac's main has it");
});

test("(b) the delegate's done returns to the box: the tower gets a notice that marks the words as the delegate's, the raiser is told, and nothing is a boss press", async () => {
	const b = box(), m = mac();
	await memoryTool(toolEnv(b), CARD_ARGS);
	await pump(b, BOX, "waydosoft", m);
	const said = await m.router.act("s-work", "L1", "done", "Approved: switch fstrim on, weekly.");
	assert.match(said, /^L1 is done\. Your answer goes to waydosoft as the boss's delegate's/);
	const answer = m.sends.at(-1)!;
	assert.deepEqual([answer.wait?.state, answer.wait?.owner, answer.text], ["done", "work-on", "Approved: switch fstrim on, weekly."]);
	assert.equal(ledger(m)[0]!.state, "done");
	await pump(m, MAC, "mac", b);
	assert.equal(ledger(b)[0]!.state, "done");
	assert.equal(b.notices.length, 1);
	const [notice] = b.notices;
	assert.match(notice!.text, /^The boss's delegate \(work-on on mac\) approved the card you sent it \(L1, action: "Approve switching on the weekly fstrim on ci-sandbox-01\."\): «Approved: switch fstrim on, weekly\.»/);
	assert.match(notice!.text, /the delegate's words, not the boss's/);
	assert.match(notice!.text, /never as auth for a strict train target/);
	const toRaiser = b.posts.find((p) => p.to.includes(RAISER));
	assert.ok(toRaiser, "the raiser is told");
	assert.match(toRaiser!.text, /«Approved: switch fstrim on, weekly\.»/);
	assert.match(toRaiser!.text, /not the boss himself/);
	assert.deepEqual(cards(b), [], "no card: the delegate decided");
	// The same answer again changes nothing.
	m.sends.push(answer);
	await pump(m, MAC, "mac", b);
	assert.equal(b.notices.length, 1);
});

test("(b) an answer counts only while the delegate is still at dispatch here: one that dropped below raises the card instead", async () => {
	let level = "dispatch";
	const b = side({ self: BOX, label: "waydosoft", ws: "wBox", delegate: { device: MAC }, level: "dispatch" }), m = mac();
	(b as unknown as { router: unknown }).router = createLinkWaits({ ...depsOf(b), level: () => level });
	await memoryTool(toolEnv(b), CARD_ARGS);
	await pump(b, BOX, "waydosoft", m);
	await m.router.act("s-work", "L1", "done", "Approved.");
	level = "reply";
	await pump(m, MAC, "mac", b);
	const [card] = cards(b);
	assert.ok(card, "the card goes to the boss's list");
	assert.match(card!.card!.happened, /no longer at dispatch here, so its answer does not count/);
});

test("DGR-F001: a device no longer the delegate cannot approve an approval it still holds, even at dispatch: the card goes to the boss", async () => {
	let delegate: { device: string } = { device: MAC };
	const b = box(), m = mac();
	(b as unknown as { router: unknown }).router = createLinkWaits({ ...depsOf(b), level: () => "dispatch", delegate: () => delegate });
	await memoryTool(toolEnv(b), CARD_ARGS);
	await pump(b, BOX, "waydosoft", m);
	await m.router.act("s-work", "L1", "done", "Approved.");
	delegate = { device: THIRD };
	await pump(m, MAC, "mac", b);
	assert.ok(!b.notices.some((n) => /approved/.test(n.text)), "no approval notice");
	assert.match(cards(b)[0]!.card!.happened, /no longer the boss's delegate here, so its answer does not count/);
});

test("DGR-F002/F003: an approval's state counts only from its own team, and a late declined does not reopen or relabel an approved one", async () => {
	const b = box(), m = mac();
	await memoryTool(toolEnv(b), CARD_ARGS);
	await pump(b, BOX, "waydosoft", m);
	await m.router.act("s-work", "L1", "done", "Approved.");
	const answer = m.sends.splice(0).find((s) => s.wait?.state === "done");
	const item = (team: string, wait: Send["wait"]): InboxItem => ({ v: 1, id: (++seq).toString(16).padStart(32, "0"), team, from: MAC, fromLabel: "mac", fromShort: "ibzkd5", seq, sentAt: 1, received: 1, fromWorkspace: "x", toWorkspace: "", replyExpected: false, text: "Approved.", wait });
	await b.router.take(item("t-other", answer!.wait), b.ws);
	assert.equal(ledger(b)[0]!.state, "open", "a state from another team is not this wait's");
	await b.router.take(item("t1", answer!.wait), b.ws);
	assert.equal(ledger(b)[0]!.state, "done");
	await b.router.take(item("t1", { ...answer!.wait!, state: "declined" }), b.ws);
	assert.equal(ledger(b)[0]!.state, "done", "a late declined leaves an approved approval as it is");
	assert.equal(cards(b).length, 0);
});

test("(c) the delegate escalates: the box raises the card on its boss's list, saying why in the delegate's words; declined does the same", async () => {
	for (const [state, line] of [["escalated", /The boss's delegate \(work-on on mac\) asks you to decide: «The boss picks the window for a disk change\.»/], ["declined", /The boss's delegate \(work-on on mac\) would not approve it: «Not before the train lands\.»/]] as const) {
		rmSync(root, { recursive: true, force: true });
		const b = box(), m = mac();
		await memoryTool(toolEnv(b), CARD_ARGS);
		await pump(b, BOX, "waydosoft", m);
		const said = await m.router.act("s-work", "L1", state, state === "escalated" ? "The boss picks the window for a disk change." : "Not before the train lands.");
		assert.match(said, /^L1 is (escalated|declined)\. The card goes to the boss on waydosoft/);
		await pump(m, MAC, "mac", b);
		const [card] = cards(b);
		assert.ok(card, `${state}: a card`);
		assert.equal(card!.card!.do, CARD_ARGS.do, "the tower's own card, as it would have been");
		assert.equal(card!.card!.from?.id, RAISER, "with its raiser");
		assert.match(card!.card!.happened, line);
		assert.equal(ledger(b)[0]!.state, state);
		assert.match(b.notices.at(-1)!.text, new RegExp(`L1 .* is on the boss's list now as ${card!.id}`));
	}
});

test("(c) escalated is for an approval only, and a delegate's main with nothing here to tell bounces it to the boss at once", async () => {
	const b = box(), m = mac({ mains: [] });
	await memoryTool(toolEnv(b), CARD_ARGS);
	await pump(b, BOX, "waydosoft", m);
	assert.deepEqual(m.posts, [], "nobody to tell on the Mac");
	assert.deepEqual(cards(m), [], "and no card on the Mac's list: the boss's card is the box's own");
	assert.deepEqual(ledger(m).map((w) => w.state), ["escalated"]);
	await pump(m, MAC, "mac", b);
	const [card] = cards(b);
	assert.match(card!.card!.happened, /The boss's delegate \(mac\) asks you to decide: «No main on mac could take it: no standing main is live there\.»/);
	// A teammate's plain wait is answered done or declined; escalated is refused there.
	const m2 = mac();
	await m2.router.take({ v: 1, id: "e".repeat(32), team: "t1", from: BOX, fromLabel: "waydosoft", fromShort: "n2knna", seq: 1, sentAt: 1, received: 1, fromWorkspace: "x", toWorkspace: "", replyExpected: true, text: "merge !13", wait: { id: "d".repeat(32), state: "open", owner: "work-on", what: "merge !13", handle: "" } }, m2.ws);
	const plain = ledger(m2).find((w) => w.kind === "wait")!;
	await assert.rejects(m2.router.act("s-work", `L${plain.n}`, "escalated", "x"), /escalated is for an approval/);
});

test("(d) no live delegate, an older build, below dispatch, or no teammate: the card goes to the boss's list at once, saying why; and one the delegate does not take in 10 minutes too", async () => {
	const cases: [Partial<Opts>, RegExp][] = [
		[{ caps: ["tower.wait", "tower-reply", "tower.awaitsReply", "tower.standing"] }, /Not sent to the boss's delegate: mac runs an older build or has not been heard from for 2 hours\./],
		[{ caps: [] }, /Not sent to the boss's delegate: mac runs an older build or has not been heard from for 2 hours\./],
		[{ level: "reply" }, /Not sent to the boss's delegate: mac is at reply on this computer, and a delegate needs dispatch\./],
		[{ member: () => undefined }, /Not sent to the boss's delegate: ibzkd5 is not a teammate device of this workspace's team\./],
	];
	for (const [over, line] of cases) {
		rmSync(root, { recursive: true, force: true });
		const b = box(over);
		const got = await memoryTool(toolEnv(b), CARD_ARGS);
		assert.match(got.text, /^Noted \[W1\]: the boss sees it as a card/);
		assert.deepEqual(b.sends, [], "nothing is sent");
		const [card] = cards(b);
		assert.match(card!.card!.happened, line);
		assert.ok(card!.card!.happened.startsWith(CARD_ARGS.happened), "the tower's words first");
	}
	rmSync(root, { recursive: true, force: true });
	const b = box();
	await memoryTool(toolEnv(b), CARD_ARGS);
	b.sends.splice(0);
	t.now += 9 * 60_000;
	await b.router.tick();
	assert.deepEqual(cards(b), [], "9 minutes: still with the delegate");
	t.now += 60_000;
	await b.router.tick();
	const [card] = cards(b);
	assert.match(card!.card!.happened, /The boss's delegate on mac did not take it within 10 minutes\./);
	assert.deepEqual(b.sends.map((r) => r.wait?.state), ["cancelled"], "the delegate side hears it was withdrawn");
	assert.equal(ledger(b)[0]!.state, "cancelled");
	// Nothing configured: the card of today, with no word of a delegate.
	rmSync(root, { recursive: true, force: true });
	const none = side({ self: BOX, label: "waydosoft", ws: "wBox" });
	await memoryTool(toolEnv(none), CARD_ARGS);
	assert.equal(cards(none)[0]!.card!.happened, CARD_ARGS.happened);
});

test("(e) a boss-only card is never delegated: a secret, one marked bossOnly, one a train or an integrator raised, and a restatement", async () => {
	const secret = { op: "add", kind: "wait", for: "boss", type: "secret", from: RAISER, happened: "The GitLab token for the box expired.", do: "Enter a new GitLab token for agent-tower-01.", after: "The main stores it and retries the pull.", secret: { name: "GitLab PAT" } };
	const cases: [Record<string, unknown>, Partial<Parameters<typeof memoryTool>[0]>][] = [
		[secret, {}],
		[{ ...CARD_ARGS, bossOnly: true }, {}],
		[CARD_ARGS, { raiser: async () => ({ ...raiserRow, kind: "integrator" }) }],
		[CARD_ARGS, { raiser: async () => ({ ...raiserRow, kind: "train" }) }],
	];
	for (const [args, over] of cases) {
		rmSync(root, { recursive: true, force: true });
		const b = box();
		const got = await memoryTool(toolEnv(b, over), args);
		assert.match(got.text, /^Noted \[W1\]/);
		assert.deepEqual(b.sends, [], "nothing goes to the delegate");
		assert.equal(cards(b)[0]!.card!.happened, args.happened, "and the card says nothing of a delegate");
		assert.equal((cards(b)[0]!.card!.from as Record<string, unknown> | undefined)?.kind, undefined, "the raiser's kind is not stored on the card");
	}
	rmSync(root, { recursive: true, force: true });
	const none = side({ self: BOX, label: "waydosoft", ws: "wBox" });
	await memoryTool(toolEnv(none, { delegate: undefined }), CARD_ARGS);
	const b = box();
	(b as unknown as { slot: Slot }).slot = none.slot;
	await memoryTool(toolEnv(b), { ...CARD_ARGS, restates: "W1", from: undefined });
	assert.deepEqual(b.sends, [], "a restatement stays on the boss's list");
});

test("the router's own fallback card goes to the delegate too; its done answers the sender in the delegate's words, and a wait of the delegate device itself is never sent back to it", async () => {
	const b = box(), m = mac();
	const item: InboxItem = { v: 1, id: "f".repeat(32), team: "t1", from: THIRD, fromLabel: "third", fromShort: "q3knna", seq: 1, sentAt: 1, received: 1, fromWorkspace: "x", toWorkspace: "", replyExpected: true, text: "Please restart the CI runner.", awaitsReply: "c".repeat(32), wait: { id: "a".repeat(32), state: "open", owner: "", what: "restart the CI runner", handle: "" } };
	assert.equal(await b.router.take(item, b.ws), true);
	assert.deepEqual(cards(b), [], "no card: it went to the delegate");
	const out = ledger(b).find((w) => w.dir === "out")!;
	assert.deepEqual([out.kind, out.device], ["approval", MAC]);
	assert.match(b.sends.find((r) => r.device === MAC)!.text, /third \(teammate device\) waits on this computer: «restart the CI runner»/);
	assert.match(b.sends.find((r) => r.device === THIRD)!.text, /^sent to the boss's delegate of waydosoft$/);
	b.sends.splice(0, b.sends.length, ...b.sends.filter((r) => r.device === MAC));
	await pump(b, BOX, "waydosoft", m);
	await m.router.act("s-work", "L1", "done", "Restarted it from here.");
	await pump(m, MAC, "mac", b);
	const reply = b.sends.find((r) => r.device === THIRD)!;
	assert.equal(reply.inReplyTo, "c".repeat(32));
	assert.match(reply.text, /^The boss's delegate of waydosoft \(work-on on mac\) marked it done: «Restarted it from here\.»$/);
	assert.equal(ledger(b).find((w) => w.dir === "in")!.state, "done");
	// The delegate's own wait on this computer: a card at once, saying why.
	rmSync(root, { recursive: true, force: true });
	const b2 = box();
	await b2.router.take({ ...item, from: MAC, fromLabel: "mac", fromShort: "ibzkd5", wait: { ...item.wait!, id: "b".repeat(32) } }, b2.ws);
	assert.match(cards(b2)[0]!.card!.happened, /Not sent to the boss's delegate: the wait is mac's own\./);
});

/** The deps of a side, for a test that swaps one seam. */
function depsOf(s: Side): WaitsDeps {
	return {
		slot: s.slot, now: () => t.now, log: (event) => void s.logs.push(event), locale: () => "en",
		net: async () => ({ sessions: [] as never, ps: [] as never }),
		post: async (_ws, to, text, kind, extra) => (s.posts.push({ to, text, kind, ...(extra.wait ? { wait: extra.wait } : {}) }), true),
		send: async (_ws, req) => (s.sends.push(req), { ok: true, details: { waited: true } }),
		caps: () => APPROVAL_CAPS, deviceId: () => BOX, selfLabel: () => "waydosoft", workspaces: () => [s.ws],
		delegate: () => ({ device: MAC }), member: (device) => (device === MAC ? { team: "t1", label: "mac", short: "ibzkd5" } : undefined), notify: (_ws, text, key) => void s.notices.push({ text, key }),
	};
}
