import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LinkHolder } from "../src/link/holder.ts";
import { LinkStore } from "../src/link/store.ts";
import type { NetView } from "../src/link/routing.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { alice, bob, clientFor, config, netOf, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";

// The holder's part of the ally runs and of replies for a main (docs/specs/2026-10-26-sb-backend.md, Ally runs, Replies for a main (D4)): `caps` is sent and kept, the fifth field of `tower` and the kind
// `tower-reply` go only against a peer's fresh `caps` and fall back to the plain `tower`, a reply is taken only against an open ask, a message for a tower identity the server runs waits for an ally run,
// and the thread store keeps both directions.

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-ally-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});

const ASK = "a".repeat(32);
type Take = { team: string; device: string; ask: string };
interface Rig {
	name: "a" | "b";
	dir: string;
	project: string;
	store: LinkStore;
	holder: LinkHolder;
	net: NetView;
	offers: { tower: string; id: string }[];
	served: string[];
	taken: Take[];
	/** What `asks.take` answers: set by a test. */
	open: { main: string; mainName: string; tower: string; workspace: string } | undefined;
	skew: number;
}
function rig(name: "a" | "b", o: { entries?: ReturnType<typeof rosterOf>; capsMs?: number } = {}): Rig {
	const keys = name === "a" ? alice : bob, entries = o.entries ?? rosterOf();
	const dir = join(root, name, "link"), project = join(root, `${name}-project`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, name === "a" ? "alice-mac" : "bob-mac");
	writeTeam(store, entries, keys);
	const stateDir = join(root, name, "state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: true } }));
	const r = { name, dir, project, store, offers: [], served: [], taken: [], open: undefined, skew: 0 } as unknown as Rig;
	r.net = netOf([]);
	r.holder = new LinkHolder({
		store, stateDir, isHolder: () => true, config: () => config(project)(), net: async () => r.net, relay: clientFor(relay),
		offer: (tower, id) => void r.offers.push({ tower: tower.id, id }), notify: () => {}, now: () => Date.now() + r.skew, backoff: () => 5, drainMs: 20, presenceMs: 60_000, offerAgainMs: 60_000, postWaitMs: 2000,
		capsMs: o.capsMs ?? 3600_000, capsMinMs: 5,
		asks: { take: (q) => (r.taken.push(q), r.open) },
		served: (identity) => void r.served.push(identity),
	});
	cleanup.push(() => r.holder.stop());
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	return r;
}
const events = (r: Rig) => {
	try {
		return readFileSync(join(r.dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
};
const sendTo = (r: Rig, text: string, over: Partial<Parameters<LinkHolder["send"]>[0]> = {}) => r.holder.send({ fromSession: r.net.sessions[0]!.id, device: r.name === "a" ? "bob-mac" : "alice-mac", text, reply: false, ...over });
/** Both holders with a tower pane each, so either can send; `b` is a tower identity the server runs unless told otherwise. */
async function pair(o: { served?: boolean } = {}) {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netOf([["tower-x", "w-a", "label-a", a.project]]);
	b.net = netOf([[o.served === false ? "tower-b" : "sb-tower-wb", "w-b", "label-b", b.project]]);
	await Promise.all([a.holder.start(), b.holder.start()]);
	return { a, b };
}
const details = (r: Awaited<ReturnType<LinkHolder["send"]>>) => (r.ok ? r.details : {}) as { asked?: boolean; as?: string };
const textOf = (r: Awaited<ReturnType<LinkHolder["send"]>>) => (r.ok ? r.text : r.error);
const capsOf = (r: Rig, device: string) => r.holder.capsFor(TEAM_HEX, device);

test("caps: each holder sends its features at its stream start, keeps the peer's, and counts one older than 2 hours as none", async () => {
	const { a, b } = await pair();
	await until(() => capsOf(a, bob.id).length === 2 && capsOf(b, alice.id).length === 2, 3000, "both caps");
	assert.deepEqual(capsOf(a, bob.id), ["tower.awaitsReply", "tower-reply"]);
	a.skew += 3 * 3600_000;
	assert.deepEqual(capsOf(a, bob.id), [], "stale");
	assert.deepEqual(capsOf(a, "x".repeat(26)), [], "a device that sent none");
});

test("a relay that refuses the caps kind is logged once and left alone for an hour; caps come once it is over", async () => {
	relay.rejectKinds.add("caps");
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => events(a).some((e) => e.event === "caps-unsupported"), 3000, "the refusal");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(events(a).filter((e) => e.event === "caps-unsupported").length, 1);
	assert.deepEqual(capsOf(b, alice.id), []);
	relay.rejectKinds.clear();
	a.skew += 90 * 60_000;
	b.skew = a.skew;
	await until(() => capsOf(b, alice.id).length === 2, 3000, "caps once the hour is over");
});

test("an ask id is written as the fifth field only to a device whose caps list it; to any other the tower goes plain and the answer says so", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netOf([["tower-x", "w-a", "label-a", a.project]]);
	b.net = netOf([["sb-tower-wb", "w-b", "label-b", b.project]]);
	await a.holder.start();
	const plain = await sendTo(a, "ask without caps", { reply: true, awaitsReply: ASK });
	assert.ok(plain.ok);
	assert.equal(details(plain).asked, false);
	assert.match(textOf(plain), /does not take ask ids/);
	await b.holder.start();
	await until(() => capsOf(a, bob.id).length === 2, 3000, "b's caps");
	const asked = await sendTo(a, "ask with caps", { reply: true, awaitsReply: ASK });
	assert.equal(details(asked).asked, true);
	await until(() => b.holder.servedFor("sb-tower-wb").length === 2, 3000, "both messages");
	const [first, second] = b.holder.servedFor("sb-tower-wb");
	assert.equal(first!.text, "ask without caps");
	assert.equal(first!.awaitsReply, undefined, "a 4-field tower decodes");
	assert.equal(second!.awaitsReply, ASK, "a 5-field tower decodes");
	assert.equal((await sendTo(a, "bad", { awaitsReply: "nope" })).ok, false);
});

test("a message for a tower identity the server runs stays in the inbox, is told to the server, and is listed for it oldest first; the boss hears of it only after 10 minutes", async () => {
	const { a, b } = await pair();
	await sendTo(a, "one");
	await sendTo(a, "two");
	await until(() => b.holder.servedFor("sb-tower-wb").length === 2, 3000, "both waiting");
	assert.ok(b.served.includes("sb-tower-wb"), "the server is told");
	assert.deepEqual(b.holder.servedFor("sb-tower-wb").map((i) => i.text), ["one", "two"]);
	assert.deepEqual(b.holder.servedFor("sb-tower-other"), []);
	assert.equal(b.offers.length, 0);
	assert.ok(!b.holder.summary().alerts.some((x) => x.kind === "served"), "not yet");
	b.skew += 11 * 60_000;
	assert.ok(b.holder.summary().alerts.some((x) => x.kind === "served"), "after 10 minutes");
	const [one] = b.holder.servedFor("sb-tower-wb");
	await b.holder.taken(one!.id, "sb-tower-wb");
	assert.deepEqual(b.holder.servedFor("sb-tower-wb").map((i) => i.text), ["two"]);
});

test("a reply goes as a tower-reply to a device whose caps list it; otherwise, and when the relay refuses the kind, as the plain tower, logged once", async () => {
	const { a, b } = await pair({ served: false });
	await until(() => capsOf(a, bob.id).length === 2, 3000, "caps");
	const reply = await sendTo(a, "the answer", { inReplyTo: ASK });
	assert.equal(details(reply).as, "tower-reply");
	assert.ok(relay.stored.some((s) => s.envelope.header.kind === "tower-reply"));
	relay.rejectKinds.add("tower-reply");
	const fallback = await sendTo(a, "again", { inReplyTo: ASK });
	assert.equal(details(fallback).as, "tower", "the refusal falls back at once");
	assert.match(textOf(fallback), /plain message/);
	await sendTo(a, "and again", { inReplyTo: ASK });
	assert.equal(events(a).filter((e) => e.event === "tower-reply-fallback").length, 1, "logged once per device and hour");
	assert.equal(relay.stored.filter((s) => s.envelope.header.kind === "tower").length, 2, "the two fallbacks went as towers");
	await until(() => b.taken.length === 1, 3000, "the first reached b as a reply");
	assert.equal((await sendTo(a, "x", { inReplyTo: "short" })).ok, false);
});

test("a tower-reply is the reply to an ask only when the server has the ask open: then it waits for the main, is offered to it, and no run gets it; any other is a plain tower for an ally run", async () => {
	const { a, b } = await pair({ served: false });
	await until(() => capsOf(a, bob.id).length === 2, 3000, "caps");
	await sendTo(a, "unasked", { inReplyTo: ASK });
	await until(() => b.store.inboxIds().length === 1, 3000, "the message");
	assert.deepEqual(b.taken, [{ team: TEAM_HEX, device: alice.id, ask: ASK }]);
	const plain = b.store.readInbox(b.store.inboxIds()[0]!)!;
	assert.equal(plain.reply, undefined);
	assert.equal(plain.text, "unasked");
	await b.holder.taken(plain.id, "tower-b");
	b.open = { main: "main-1", mainName: "docs-main", tower: "sb-tower-wb", workspace: "label-b" };
	b.net = { ...netOf([["tower-b", "w-b", "label-b", b.project]]), sessions: [{ id: "tower-b", herdrLocation: { status: "current", paneId: "p0" } }, { id: "main-1", name: "docs-main", herdrLocation: { status: "current", paneId: "p9" } }] as never };
	b.net.panes.push({ pane_id: "p9", tab_id: "w-b:t1", workspace_id: "w-b", cwd: b.project, agent_status: "idle", tokens: { sb_role: "main" } } as never);
	await sendTo(a, "the real answer", { inReplyTo: ASK });
	await until(() => b.offers.some((x) => x.tower === "main-1"), 3000, "the offer to the main");
	const item = b.store.readInbox(b.offers.find((x) => x.tower === "main-1")!.id)!;
	assert.deepEqual(item.reply, { ask: ASK, main: "main-1", mainName: "docs-main", tower: "sb-tower-wb" });
	assert.equal(b.holder.servedFor("sb-tower-wb").length, 0, "no run gets it");
	// The main is no longer its tab's main: the reply falls back to an ally message that says who asked.
	b.net.panes.find((p) => p.pane_id === "p9")!.tokens = { sb_role: "member" };
	void b.holder.drain();
	await until(() => b.store.readInbox(item.id)?.reply === undefined, 3000, "the fallback");
	assert.equal(b.store.readInbox(item.id)!.askedBy, "docs-main");
});

test("a reply offered to a main that does not take it (an older build, a main that never connects to the channel) falls back to an ally run after 5 minutes, not before (RV6-F005)", async () => {
	const { a, b } = await pair({ served: false });
	await until(() => capsOf(a, bob.id).length === 2, 3000, "caps");
	b.open = { main: "main-1", mainName: "docs-main", tower: "sb-tower-wb", workspace: "label-b" };
	b.net = { ...netOf([["tower-b", "w-b", "label-b", b.project]]), sessions: [{ id: "tower-b", herdrLocation: { status: "current", paneId: "p0" } }, { id: "main-1", name: "docs-main", herdrLocation: { status: "current", paneId: "p9" } }] as never };
	b.net.panes.push({ pane_id: "p9", tab_id: "w-b:t1", workspace_id: "w-b", cwd: b.project, agent_status: "idle", tokens: { sb_role: "main" } } as never);
	await sendTo(a, "the answer", { inReplyTo: ASK });
	await until(() => b.offers.some((x) => x.tower === "main-1"), 3000, "the offer to the main");
	const item = b.store.readInbox(b.offers.find((x) => x.tower === "main-1")!.id)!;
	// The offer is made again, and the main never takes it: still a reply for the main at 4 minutes.
	b.skew += 4 * 60_000;
	void b.holder.drain();
	await until(() => b.offers.filter((x) => x.tower === "main-1").length >= 2, 3000, "the offer again");
	assert.deepEqual(b.store.readInbox(item.id)!.reply, { ask: ASK, main: "main-1", mainName: "docs-main", tower: "sb-tower-wb" });
	b.skew += 2 * 60_000;
	void b.holder.drain();
	await until(() => b.store.readInbox(item.id)?.reply === undefined, 3000, "the fallback");
	assert.equal(b.store.readInbox(item.id)!.askedBy, "docs-main", "the ally run is told which main asked");
	assert.ok(events(b).some((e) => e.event === "reply-fallback" && e.why === "not-taken"));
});

test("the thread store keeps both directions per device, mode 600, the last 20 messages, none older than 7 days", async () => {
	const { a, b } = await pair({ served: false });
	await until(() => capsOf(a, bob.id).length === 2, 3000, "caps");
	for (let i = 0; i < 12; i++) await sendTo(a, `to bob ${i}`);
	await until(() => b.store.inboxIds().length === 12, 5000, "the messages");
	const mine = a.store.readThread(bob.id);
	assert.equal(mine.length, 12);
	assert.deepEqual([mine[0]!.dir, mine[0]!.kind], ["out", "tower"]);
	const theirs = b.store.readThread(alice.id);
	assert.equal(theirs.length, 12);
	assert.equal(theirs[0]!.dir, "in");
	for (let i = 0; i < 12; i++) await sendTo(b, `to alice ${i}`);
	await until(() => a.store.inboxIds().length === 12, 5000, "the answers");
	await until(() => a.store.readThread(bob.id).length === 20, 5000, `20 rows, have ${a.store.readThread(bob.id).length}`);
	assert.equal(a.store.readThread(bob.id).at(-1)!.text, "to alice 11");
	assert.equal(statSync(join(a.dir, "threads", `${bob.id}.jsonl`)).mode & 0o777, 0o600);
	assert.equal(a.store.readThread(bob.id, Date.now() + 8 * 24 * 3600_000).length, 0);
});

test("a device that is no member of any team file loses its thread at the next pass", async () => {
	const { a } = await pair({ served: false });
	await until(() => capsOf(a, bob.id).length === 2, 3000, "caps");
	await sendTo(a, "hello");
	assert.equal(a.store.threadDevices().length, 1);
	await a.store.withLock(() => a.store.appendThread("b".repeat(26), { dir: "in", at: Date.now(), id: "1", kind: "tower", text: "stranger" }));
	assert.equal(a.store.threadDevices().length, 2);
	await a.holder.drain();
	assert.deepEqual(a.store.threadDevices(), [bob.id], "the stranger's thread went");
});
