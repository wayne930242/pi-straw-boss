import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LinkHolder } from "../src/link/holder.ts";
import { type InboxItem, LinkStore } from "../src/link/store.ts";
import type { NetView } from "../src/link/routing.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { alice, bob, clientFor, config, netOf, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";

// The holder's part of the box ↔ Mac waits (docs/specs/2026-11-21-box-mac-waits.md §2.3, §4 C2): a holder with a wait router lists tower.wait, a wait goes as the sixth field only to a peer that lists it and as
// `[waits on you: …]` text to any other, the receiving holder hands it to the router and never to an ally run, and a reply for a busy main is held until its ask ends while one whose main is gone goes to the router.

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-waits-holder-"));
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
	waited: { item: InboxItem; ws: string | undefined }[];
	orphans: { item: InboxItem; asker: string; ws: string | undefined }[];
	notices: string[];
	/** What the router's take answers (true by default); `false` is a wait no tower here routes. */
	takes: (ws: string | undefined) => boolean | "held";
}
function rig(name: "a" | "b", o: { entries?: ReturnType<typeof rosterOf>; capsMs?: number; waits?: boolean } = {}): Rig {
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
	const r = { name, dir, project, store, offers: [], served: [], taken: [], open: undefined, skew: 0, waited: [], orphans: [], notices: [], takes: () => true } as unknown as Rig;
	r.net = netOf([]);
	r.holder = new LinkHolder({
		store, stateDir, isHolder: () => true, config: () => config(project)(), net: async () => r.net, relay: clientFor(relay),
		offer: (tower, id) => void r.offers.push({ tower: tower.id, id }), notify: (text) => void r.notices.push(text), now: () => Date.now() + r.skew, backoff: () => 5, drainMs: 20, presenceMs: 60_000, offerAgainMs: 60_000, postWaitMs: 2000,
		capsMs: o.capsMs ?? 3600_000, capsMinMs: 5,
		asks: { take: (q) => (r.taken.push(q), r.open) },
		served: (identity) => void r.served.push(identity),
		...(o.waits ? { waits: { take: async (item: InboxItem, ws: string | undefined) => (r.waited.push({ item, ws }), r.takes(ws)), orphan: async (item: InboxItem, asker: string, ws: string | undefined) => (r.orphans.push({ item, asker, ws }), true) } } : {}),
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
async function pair(o: { served?: boolean; waits?: { a?: boolean; b?: boolean } } = {}) {
	const [a, b] = [rig("a", { waits: o.waits?.a ?? false }), rig("b", { waits: o.waits?.b ?? false })];
	a.net = netOf([["tower-x", "w-a", "label-a", a.project]]);
	b.net = netOf([[o.served === false ? "tower-b" : "sb-tower-wb", "w-b", "label-b", b.project]]);
	await Promise.all([a.holder.start(), b.holder.start()]);
	return { a, b };
}
const details = (r: Awaited<ReturnType<LinkHolder["send"]>>) => (r.ok ? r.details : {}) as { asked?: boolean; as?: string };
const textOf = (r: Awaited<ReturnType<LinkHolder["send"]>>) => (r.ok ? r.text : r.error);
const capsOf = (r: Rig, device: string) => r.holder.capsFor(TEAM_HEX, device);


const WAIT = { id: "7a".repeat(16), state: "open" as const, owner: "work-on", what: "merge !13", handle: "0123456789abcdef" };

test("a holder with a wait router lists tower.wait; a wait to it goes as the sixth field, the router takes it, and no ally run or tower is offered it", async () => {
	const { a, b } = await pair({ waits: { b: true } });
	await until(() => capsOf(a, bob.id).includes("tower.wait"), 3000, "b lists tower.wait");
	assert.ok(!capsOf(b, alice.id).includes("tower.wait"), "a, with no router, does not");
	const sent = await sendTo(a, "please merge !13", { reply: true, awaitsReply: ASK, wait: WAIT });
	assert.equal(sent.ok, true, textOf(sent));
	assert.equal((details(sent) as { waited?: boolean }).waited, true);
	await until(() => b.waited.length === 1, 3000, "the router to take it");
	const got = b.waited[0]!;
	assert.deepEqual(got.item.wait, WAIT);
	assert.equal(got.item.text, "please merge !13", "the text is the message's own; no first line is added");
	assert.equal(got.item.awaitsReply, ASK);
	assert.equal(got.ws, "w-b", "the workspace delivery picks");
	await until(() => b.store.inboxIds().length === 0, 3000, "it leaves the inbox");
	assert.equal(b.holder.servedFor("sb-tower-wb").length, 0, "no ally run is told of it");
	assert.equal(b.offers.length, 0);
});

test("a wait to a build that takes none goes as text whose first line says so, for its ally run; a state of a wait is not sent to it at all", async () => {
	const { a, b } = await pair({ waits: { a: true } });
	await until(() => capsOf(b, alice.id).includes("tower.wait") && capsOf(a, bob.id).length === 5, 3000, "both caps");
	const plain = await sendTo(a, "please merge !13", { wait: WAIT });
	assert.equal(plain.ok, true, textOf(plain));
	assert.equal((details(plain) as { waited?: boolean }).waited, false, "the tool says it went plain");
	await until(() => b.store.inboxIds().length === 1, 3000, "the plain message in b's inbox");
	const item = b.store.readInbox(b.store.inboxIds()[0]!)!;
	assert.equal(item.wait, undefined);
	assert.equal(item.text, "[waits on you: merge !13]\nplease merge !13");
	assert.equal(b.holder.servedFor("sb-tower-wb").length, 1, "an ally run gets it, as before");
	const state = await sendTo(a, "told", { wait: { ...WAIT, state: "told" } });
	assert.equal(state.ok, false);
	// The other way: b, with no router, gets a's open wait to it as the sixth field because a lists tower.wait.
	const back = await sendTo(b, "the Mac waits on the box", { wait: WAIT });
	assert.equal((details(back) as { waited?: boolean }).waited, true);
	await until(() => a.waited.length === 1, 3000, "a's router to take it");
});

/** Makes `r` hold `device`'s last caps without `feature`, as a build before it lists them (0.81.2 lists tower.wait but not tower.standing). */
const withoutCap = (r: Rig, device: string, feature: string) => {
	for (const run of (r.holder as unknown as { runs: Map<string, { caps: Map<string, { features: string[] }> }> }).runs.values()) {
		const seen = run.caps.get(device);
		if (seen) seen.features = seen.features.filter((f) => f !== feature);
	}
};

test("D13: a wait for the standing main goes with its kind to a build that lists tower.standing, and its router takes it; to a 0.81.2 build (tower.wait, no tower.standing) it is the plain tower of before: no wait field, no lead line, the ask kept", async () => {
	const { a, b } = await pair({ waits: { b: true } });
	await until(() => capsOf(a, bob.id).includes("tower.standing"), 3000, "b lists tower.standing");
	const question = { ...WAIT, owner: "", what: "merge !13 before the train?", kind: "question" as const };
	const sent = await sendTo(a, "Is !13 safe to merge before the train?", { reply: true, awaitsReply: ASK, wait: question });
	assert.equal((details(sent) as { waited?: boolean }).waited, true, textOf(sent));
	await until(() => b.waited.length === 1, 3000, "the router to take it");
	assert.deepEqual([b.waited[0]!.item.wait, b.waited[0]!.item.awaitsReply], [question, ASK]);
	assert.equal(b.holder.servedFor("sb-tower-wb").length, 0, "no ally run is told of it");
	withoutCap(a, bob.id, "tower.standing");
	const old = await sendTo(a, "Is !13 safe to merge before the train?", { reply: true, awaitsReply: ASK, wait: { ...question, id: "7b".repeat(16) } });
	assert.equal(old.ok, true, textOf(old));
	assert.equal((details(old) as { waited?: boolean }).waited, false, "the tool says it went plain");
	await until(() => b.store.inboxIds().length === 1, 3000, "the plain message in b's inbox");
	const item = b.store.readInbox(b.store.inboxIds()[0]!)!;
	assert.deepEqual([item.wait, item.text, item.awaitsReply, item.replyExpected], [undefined, "Is !13 safe to merge before the train?", ASK, true]);
	assert.equal(b.waited.length, 1, "the router never saw it");
	assert.equal(b.holder.servedFor("sb-tower-wb").length, 1, "an ally run gets it, as before 0.81.3");
});

test("C2: a reply for a live main that does not take it stays offered for hours (no fallback); once the main is gone it goes to the router, never to an ally run", async () => {
	const { a, b } = await pair({ served: false, waits: { b: true } });
	await until(() => capsOf(a, bob.id).includes("tower-reply"), 3000, "caps");
	b.open = { main: "main-1", mainName: "docs-main", tower: "sb-tower-wb", workspace: "label-b" };
	b.net = { ...netOf([["tower-b", "w-b", "label-b", b.project]]), sessions: [{ id: "tower-b", herdrLocation: { status: "current", paneId: "p0" } }, { id: "main-1", name: "docs-main", herdrLocation: { status: "current", paneId: "p9" } }] as never };
	b.net.panes.push({ pane_id: "p9", tab_id: "w-b:t1", workspace_id: "w-b", cwd: b.project, agent_status: "working", tokens: { sb_role: "main" } } as never);
	await sendTo(a, "the answer", { inReplyTo: ASK });
	await until(() => b.offers.some((x) => x.tower === "main-1"), 3000, "the offer to the main");
	const id = b.offers.find((x) => x.tower === "main-1")!.id;
	for (const hours of [1, 2]) {
		b.skew = hours * 3600_000;
		const before = b.offers.length;
		void b.holder.drain();
		await until(() => b.offers.length > before, 3000, `the offer again at ${hours} h`);
		assert.ok(b.store.readInbox(id)?.reply, `still the main's reply at ${hours} h`);
	}
	assert.ok(!events(b).some((e) => e.event === "reply-fallback"), "no fallback while the main is live");
	b.net = { ...b.net, sessions: b.net.sessions.filter((s) => s.id !== "main-1") };
	void b.holder.drain();
	await until(() => b.orphans.length === 1, 3000, "the router to get it");
	assert.deepEqual([b.orphans[0]!.asker, b.orphans[0]!.item.text, b.orphans[0]!.ws], ["docs-main", "the answer", "w-b"]);
	await until(() => b.store.inboxIds().length === 0, 3000, "it leaves the inbox");
	assert.ok(events(b).some((e) => e.event === "reply-routed" && e.why === "gone"));
	assert.equal(b.holder.servedFor("tower-b").length, 0);
});

test("BMWR-F002: an open wait no tower here routes is a tower message that found no tower (the boss is told), goes to a tower the server does not run, and never to an ally run", async () => {
	const { a, b } = await pair({ waits: { b: true } });
	await until(() => capsOf(a, bob.id).includes("tower.wait"), 3000, "b lists tower.wait");
	// No tower is open on b: the router takes nothing, and the boss hears a message waits for the project's tower.
	b.takes = (ws) => (ws === undefined ? false : true);
	b.net = netOf([]);
	assert.equal((await sendTo(a, "please merge !13", { wait: WAIT })).ok, true);
	await until(() => b.notices.some((t) => /a message from alice-mac is not delivered yet/.test(t)), 3000, "the boss's notice");
	assert.equal(b.store.inboxIds().length, 1, "it stays in the inbox");
	// A resident pi tower (no identity of the server's: the router answers false) is offered it as a tower message.
	b.net = netOf([["tower-b", "w-b", "label-b", b.project]]);
	b.takes = () => false;
	void b.holder.drain();
	await until(() => b.offers.some((o) => o.tower === "tower-b"), 3000, "the offer to the resident tower");
	// A tower the server runs whose router does not take it yet: it waits for the router, never for an ally run.
	b.net = netOf([["sb-tower-wb", "w-b", "label-b", b.project]]);
	const before = b.offers.length;
	void b.holder.drain();
	await until(() => b.waited.at(-1)?.ws === "w-b", 3000, "the router asked again");
	await b.holder.drain();
	assert.equal(b.holder.servedFor("sb-tower-wb").length, 0, "no ally run is told of it");
	assert.equal(b.offers.length, before);
	// Held by the router (its device's bound): it stays, and nothing else gets it.
	b.takes = () => "held";
	await b.holder.drain();
	assert.equal(b.store.inboxIds().length, 1);
	assert.equal(b.holder.servedFor("sb-tower-wb").length, 0);
	b.takes = () => true;
	await b.holder.drain();
	await until(() => b.store.inboxIds().length === 0, 3000, "taken at last");
});
