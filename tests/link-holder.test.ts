import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildEnvelope, parseEnvelope } from "../src/link/envelope.ts";
import { LinkHolder } from "../src/link/holder.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { RelayClient } from "../src/link/relay.ts";
import { removeEntry } from "../src/link/roster.ts";
import type { NetView } from "../src/link/routing.ts";
import { LinkStore, type TeamFile } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { alice, bob, carol, clientFor, config, netOf, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { teamKey, TEAM } from "./link/scenario.ts";

// The link holder against an in-memory relay (docs/specs/2026-10-25-straw-link.md, Link holder): checked messages reach the inbox before the relay
// hears an ack, the tower takes them from there, the guards fail closed, and a takeover or a crash loses nothing and delivers nothing twice.

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-holder-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});

interface Rig {
	name: string;
	dir: string;
	project: string;
	store: LinkStore;
	holder: LinkHolder;
	net: NetView;
	offers: { tower: string; id: string }[];
	notices: string[];
	displaced: number;
	isHolder: boolean;
	/** Added to the real time the holder reads. */
	skew: number;
	share: "presence" | "status";
	postWaitMs: number;
	start(): Promise<void>;
	restart(over?: { store?: LinkStore }): Promise<void>;
}

function rig(name: "a" | "b", o: { entries?: ReturnType<typeof rosterOf>; seed?: boolean; towers?: boolean } = {}): Rig {
	const keys = name === "a" ? alice : bob, entries = o.entries ?? rosterOf();
	const dir = join(root, name, "link"), project = join(root, `${name}-project`);
	mkdirSync(project, { recursive: true });
	const first = new LinkStore(dir, { alive: () => true });
	first.ensure();
	writeDevice(first, keys, name === "a" ? "alice-mac" : "bob-mac");
	if (o.seed !== false) writeTeam(first, entries, keys);
	const r = { name, dir, project, offers: [], notices: [], displaced: 0, isHolder: true, skew: 0, share: "status", postWaitMs: 3000 } as unknown as Rig;
	r.net = o.towers === false ? netOf([]) : netOf([[`tower-${name}`, `w-${name}`, `label-${name}`, project]]);
	const build = (store: LinkStore) => new LinkHolder({
		store, isHolder: () => r.isHolder, config: () => config(project, r.share)(), net: async () => r.net, relay: clientFor(relay),
		offer: (tower, id) => void r.offers.push({ tower: tower.id, id }), notify: (text) => void r.notices.push(text), onDisplaced: () => void r.displaced++,
		now: () => Date.now() + r.skew, backoff: () => 5, drainMs: 20, presenceMs: 40, offerAgainMs: 60_000, postWaitMs: r.postWaitMs, haltRetryMs: 150,
	});
	r.store = first;
	r.holder = build(first);
	r.start = async () => void (await r.holder.start());
	r.restart = async (over = {}) => {
		await r.holder.stop();
		r.store = over.store ?? new LinkStore(dir, { alive: () => true });
		r.holder = build(r.store);
		await r.holder.start();
	};
	cleanup.push(() => r.holder.stop());
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	return r;
}

const send = (r: Rig, text = "hello", over: Partial<Parameters<LinkHolder["send"]>[0]> = {}) => r.holder.send({ fromSession: `tower-${r.name}`, device: r.name === "a" ? "bob-mac" : "alice-mac", text, reply: false, ...over });
const device = (r: Rig) => JSON.parse(readFileSync(join(r.dir, "device.json"), "utf8")) as { nextSeq: number };
const teamFile = (r: Rig) => JSON.parse(readFileSync(join(r.dir, "teams", `${TEAM_HEX}.json`), "utf8")) as TeamFile;
/** The envelopes that were queued for delivery (presence is ephemeral and goes by itself). */
const queued = () => relay.stored.filter((st) => !st.ephemeral);
const events = (r: Rig) => readFileSync(join(r.dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

/** A tower message from alice, built by hand: any seq, so a replay can be tried. */
async function forge(seq: number, text: string, from = alice, head = stateOf(rosterOf(), alice).head) {
	const envelope = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from, seq, ts: Date.now(), kind: "tower", to: [bob.id], plaintext: encodePlaintext("tower", { fromWorkspace: "forged", toWorkspace: "", replyExpected: false, text }) });
	await new RelayClient({ url: "http://relay.test", device: from, fetch: relay.fetch }).postEnvelope(TEAM, envelope);
	return envelope;
}

test("a message goes from A through the relay into B's inbox and is acknowledged only once the inbox holds it; B's tower is offered it and takes it", async () => {
	const [a, b] = [rig("a"), rig("b")];
	const inboxAtAck: boolean[] = [];
	relay.onAck = (dev, ids) => dev === bob.id && inboxAtAck.push(...ids.map((id) => b.store.readInbox(id) !== undefined));
	await Promise.all([a.start(), b.start()]);
	const sent = await send(a, "ship it", { reply: true });
	assert.ok(sent.ok, sent.ok ? "" : sent.error);
	assert.match(sent.ok ? sent.text : "", /Sent to the tower of bob-mac \(/);
	await until(() => b.offers.length === 1, 3000, "B's tower to be offered the message");
	const item = b.store.readInbox(b.offers[0]!.id)!;
	assert.deepEqual([item.fromLabel, item.from, item.fromWorkspace, item.replyExpected, item.text, item.team], ["alice-mac", alice.id, "label-a", true, "ship it", TEAM_HEX]);
	assert.equal(b.offers[0]!.tower, "tower-b");
	await until(() => relay.ackedBy(bob.id).length === 1, 3000, "the ack");
	assert.deepEqual(inboxAtAck, [true], "the inbox held the message when the ack arrived");
	assert.equal(teamFile(b).lastSeq[alice.id], 1, "the high-water mark moved with the message");
	await b.holder.taken(item.id, "tower-b");
	assert.equal(b.store.readInbox(item.id), undefined, "the tower took it: it leaves the inbox");
	assert.equal(device(a).nextSeq, 2);
});

test("a tower is offered a message only if its pane is in the team's project; with no such tower the message waits in the inbox with one notice, and the next tower that opens gets it", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	await Promise.all([a.start(), b.start()]);
	await send(a, "wait for me");
	await until(() => relay.ackedBy(bob.id).length === 1, 3000, "the ack");
	await until(() => b.notices.some((n) => /waits in the inbox/.test(n)), 3000, "the inbox notice");
	assert.equal(b.offers.length, 0);
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.notices.filter((n) => /waits in the inbox/.test(n)).length, 1, "the notice is not repeated");
	assert.equal(b.store.inboxIds().length, 1);
	// A tower in some other folder is no tower of this project.
	b.net = netOf([["tower-else", "w-else", "else", join(root, "elsewhere")]]);
	await b.holder.drain();
	assert.equal(b.offers.length, 0);
	b.net = netOf([["tower-late", "w-late", "late", b.project]]);
	await until(() => b.offers.length === 1, 3000, "the late tower to be offered the message");
	assert.equal(b.offers[0]!.tower, "tower-late");
});

test("an inbox message older than 7 days is dropped", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	await Promise.all([a.start(), b.start()]);
	await send(a, "old news");
	await until(() => b.store.inboxIds().length === 1, 3000, "the message in the inbox");
	b.skew += 8 * 86_400_000;
	await b.holder.drain();
	assert.equal(b.store.inboxIds().length, 0);
});

test("the sender's next sequence number is saved before the envelope is sent", async () => {
	const a = rig("a");
	await a.start();
	let release!: () => void;
	relay.holdPosts = new Promise<void>((resolve) => (release = resolve));
	const sending = send(a, "slow");
	await until(() => device(a).nextSeq === 2, 3000, "the saved number while the post is still waiting");
	assert.equal(queued().length, 0, "nothing reached the relay yet");
	release();
	const result = await sending;
	assert.ok(result.ok);
	assert.equal(queued().length, 1);
	assert.equal(queued()[0]!.envelope.header.seq, 1);
	await send(a, "second");
	assert.equal(queued()[1]!.envelope.header.seq, 2);
	assert.equal(device(a).nextSeq, 3);
});

test("a send is refused with the reason: no such device, this device, a session that is not a tower, a folder outside the project, a message too large (a label two devices share is routing's test; a relay that is down, the queued tests below)", async () => {
	const entries = rosterOf(["bob", "carol"]);
	const a = rig("a", { entries });
	await a.start();
	const err = async (p: ReturnType<typeof send>) => {
		const r = await p;
		assert.ok(!r.ok);
		return r.error;
	};
	assert.match(await err(send(a, "x", { device: "nobody" })), /No device "nobody"/);
	assert.match(await err(send(a, "x", { device: "alice-mac" })), /this device/);
	assert.match(await err(send(a, "x", { fromSession: "someone-else" })), /Only the tower of a workspace bound to a team/);
	a.net = netOf([["tower-a", "w-a", "label-a", join(root, "elsewhere")]]);
	assert.match(await err(send(a, "x")), /not inside the project/);
	a.net = netOf([["tower-a", "w-a", "label-a", a.project]]);
	assert.match(await err(send(a, "x".repeat(200 * 1024))), /at most 196608/);
	assert.equal(queued().length, 0);
	assert.ok((await send(a, "ok", { device: "carol-pc" })).ok);
	assert.deepEqual([...queued()[0]!.to], [carol.id]);
});

test("a device is named by its label, its short id, or its id", async () => {
	const a = rig("a", { entries: rosterOf(["bob", "carol"]) });
	await a.start();
	assert.ok((await send(a, "by label", { device: "bob-mac" })).ok);
	assert.ok((await send(a, "by short id", { device: carol.shortId })).ok);
	assert.ok((await send(a, "by id", { device: bob.id })).ok);
	assert.deepEqual(queued().map((st) => [...st.to][0]), [bob.id, carol.id, bob.id]);
});

test("R-F021: an envelope whose seq is not past the sender's high-water mark is dropped and acknowledged, and never reaches the inbox", async () => {
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.start(), b.start()]);
	await send(a, "first");
	await until(() => b.offers.length === 1, 3000, "the first message");
	await forge(1, "replay of seq 1");
	await forge(1, "another seq 1");
	await until(() => relay.ackedBy(bob.id).length === 3, 3000, "all three acknowledged");
	assert.equal(b.store.inboxIds().length, 1, "only the first made the inbox");
	assert.deepEqual(events(b).filter((e) => e.event === "drop").map((e) => e.reason), ["stale-seq", "stale-seq"]);
	await forge(5, "a gap is fine");
	await until(() => b.store.inboxIds().length === 2, 3000, "seq 5");
	assert.equal(teamFile(b).lastSeq[alice.id], 5);
	await forge(3, "behind now");
	await until(() => relay.ackedBy(bob.id).length === 5, 3000);
	assert.equal(b.store.inboxIds().length, 2);
});

test("R-F021: a team file that is missing, or has lost its high-water marks, takes nothing and acknowledges nothing", async () => {
	// Missing at start: no stream, a notice, and the relay keeps the message.
	const [a, b] = [rig("a"), rig("b", { seed: false })];
	await Promise.all([a.start(), b.start()]);
	assert.ok(b.notices.some((n) => /no team file|join the team again/.test(n)), b.notices.join("\n"));
	assert.equal(relay.opened.filter((o) => o.device === bob.id).length, 0, "no stream was opened for a team this device has no file for");
	await send(a, "while you were gone");
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(relay.pendingFor(bob.id).length, 1);
	assert.equal(b.store.inboxIds().length, 0);
});

test("R-F021: a team file lost while the holder runs stops the team: the next message is kept at the relay, not acknowledged, not delivered", async () => {
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.start(), b.start()]);
	rmSync(join(b.dir, "teams", `${TEAM_HEX}.json`));
	await send(a, "after the loss");
	await until(() => b.notices.some((n) => /stopped/.test(n)), 3000, "the stop notice");
	assert.equal(relay.ackedBy(bob.id).length, 0);
	assert.equal(b.store.inboxIds().length, 0);
	assert.equal(b.offers.length, 0);
	assert.equal(relay.pendingFor(bob.id).length, 1);
});

test("R-F021: a team file without its sequence marks is corrupt, never empty", async () => {
	const [a, b] = [rig("a"), rig("b")];
	const file = join(b.dir, "teams", `${TEAM_HEX}.json`), raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	delete raw.lastSeq;
	const { writeFileSync } = await import("node:fs");
	writeFileSync(file, JSON.stringify(raw));
	await Promise.all([a.start(), b.start()]);
	assert.ok(b.notices.some((n) => /corrupt|cannot be used/.test(n)), b.notices.join("\n"));
	await send(a, "x");
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(b.store.inboxIds().length, 0);
	assert.equal(relay.ackedBy(bob.id).length, 0);
});

test("an ack that never reached the relay redelivers the message: the inbox keeps one copy, the sequence guard drops the second, the tower is offered it once", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	await Promise.all([a.start(), b.start()]);
	relay.dropAcks = true;
	await send(a, "once only");
	await until(() => b.store.inboxIds().length === 1 && relay.acks.length > 0, 3000, "the message stored and the lost ack");
	await b.holder.stop();
	assert.equal(relay.pendingFor(bob.id).length, 1, "the relay still has it");
	relay.dropAcks = false;
	b.net = netOf([["tower-b", "w-b", "label-b", b.project]]);
	await b.restart();
	await until(() => relay.ackedBy(bob.id).length === 1, 3000, "the redelivered message acknowledged");
	assert.equal(b.store.inboxIds().length, 1, "one copy");
	assert.deepEqual(events(b).filter((e) => e.event === "drop" && e.kind === "tower").map((e) => e.reason), ["stale-seq"], "the second copy was dropped by the guard");
	await until(() => b.offers.length >= 1, 3000, "the tower offered the message");
	assert.equal(b.offers.length, 1);
});

test("a crash after the inbox write but before the sequence mark is saved redelivers once and leaves one copy", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	class Crashing extends LinkStore {
		crashes = 1;
		override writeTeam(file: TeamFile) {
			if (this.crashes-- > 0 && file.lastSeq[alice.id] !== undefined) throw new Error("crash");
			super.writeTeam(file);
		}
	}
	const crashing = new Crashing(b.dir, { alive: () => true });
	await a.start();
	await b.restart({ store: crashing });
	await send(a, "survive");
	await until(() => b.store.inboxIds().length === 1, 3000, "the inbox write");
	assert.equal(relay.ackedBy(bob.id).length, 0, "not acknowledged: the mark was not saved");
	assert.equal(teamFile(b).lastSeq[alice.id], undefined);
	await b.restart();
	await until(() => relay.ackedBy(bob.id).length === 1, 3000, "the redelivery acknowledged");
	assert.equal(b.store.inboxIds().length, 1, "still one copy");
	assert.equal(teamFile(b).lastSeq[alice.id], 1);
});

test("a takeover resumes the stream from the team file's last event id and sees everything the old holder did not acknowledge", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await send(a, "two");
	await until(() => b.store.inboxIds().length === 2, 3000, "both messages");
	const saved = teamFile(b).lastEventId;
	assert.ok(saved > 0);
	relay.dropAcks = true;
	await send(a, "three");
	await until(() => b.store.inboxIds().length === 3, 3000, "the third");
	await b.holder.stop();
	relay.dropAcks = false;
	const before = relay.opened.length;
	await b.restart();
	const opening = relay.opened.slice(before).find((o) => o.device === bob.id)!;
	assert.equal(opening.lastEventId, String(teamFile(b).lastEventId || saved), "resumes after the file's last event id");
	assert.ok(Number(opening.lastEventId) >= saved);
	await until(() => relay.ackedBy(bob.id).length === 3, 3000, "the unacknowledged one acknowledged by the new holder");
	assert.equal(b.store.inboxIds().length, 3);
});

test("a holder that is no longer the one the record names acts on nothing: it keeps the envelope for the next stream and says it was displaced", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	await Promise.all([a.start(), b.start()]);
	b.isHolder = false;
	await send(a, "not yours");
	await until(() => b.displaced === 1, 3000, "the displacement");
	assert.equal(b.store.inboxIds().length, 0);
	assert.equal(relay.ackedBy(bob.id).length, 0);
	assert.equal(relay.pendingFor(bob.id).length, 1);
	assert.equal(teamFile(b).lastSeq[alice.id], undefined);
	await until(() => relay.streams.filter((st) => st.device === bob.id).every((st) => st.closed), 3000, "the displaced holder's stream to end");
	assert.equal(b.holder.active, false);
});

test("a message from a sender who has left the roster by the time a tower would get it is dropped from the inbox", async () => {
	const entries = rosterOf(["bob", "carol"]);
	const b = rig("b", { entries, towers: false });
	await b.start();
	const head = stateOf(entries, alice).head;
	await forge(1, "from carol", carol, head);
	await until(() => b.store.inboxIds().length === 1, 3000, "carol's message in the inbox");
	const removal = removeEntry({ state: stateOf(entries, alice), signer: alice, subjectId: carol.id, newKey: teamKey(2) });
	relay.pushRoster(TEAM, removal);
	await until(() => JSON.parse(readFileSync(join(b.dir, "teams", `${TEAM_HEX}.json`), "utf8")).entries.length === 4, 3000, "the removal in the team file");
	b.net = netOf([["tower-b", "w-b", "label-b", b.project]]);
	await b.holder.drain();
	await until(() => b.store.inboxIds().length === 0, 3000, "the message dropped");
	assert.equal(b.offers.length, 0);
	assert.ok(events(b).some((e) => e.event === "inbox-dropped" && e.reason === "sender-left"));
});

test("an envelope whose roster head is ahead of this device's copy makes it fetch the roster first, then take the message", async () => {
	const full = rosterOf(["bob", "carol"]);
	const a = rig("a", { entries: full });
	const b = rig("b", { entries: full.slice(0, 2), towers: false });
	relay.rosters.set(TEAM_HEX, full);
	await Promise.all([a.start(), b.start()]);
	await send(a, "with a newer roster");
	await until(() => b.store.inboxIds().length === 1, 3000, "the message after the roster fetch");
	assert.equal(teamFile(b).entries.length, 3);
	await until(() => relay.ackedBy(bob.id).length === 1, 3000, "the ack");
});

test("an entry the roster rules refuse is a fork: the team stops with a notice and nothing more is taken", async () => {
	const entries = rosterOf();
	const b = rig("b", { entries, towers: false });
	await b.start();
	const bad = { ...removeEntry({ state: stateOf(entries, alice), signer: alice, subjectId: bob.id, newKey: teamKey(2) }), by: bob.id };
	relay.pushRoster(TEAM, bad);
	await until(() => b.notices.some((n) => /stopped/.test(n)), 3000, "the fork notice");
	assert.equal(teamFile(b).entries.length, 2, "the bad entry is not kept");
	// SLH-F001: it stays stopped past several ticks (drainMs is 20 ms), here and for the next holder, until the team file is replaced.
	const a = rig("a");
	await a.start();
	const opened = relay.opened.filter((o) => o.device === bob.id).length;
	await new Promise((r) => setTimeout(r, 200));
	assert.ok((await send(a, "after the fork")).ok);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(relay.opened.filter((o) => o.device === bob.id).length, opened, "no stream was opened again");
	assert.equal(b.store.inboxIds().length, 0, "nothing was taken from a team that forked");
	assert.equal(relay.ackedBy(bob.id).length, 0);
	await b.restart();
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(relay.opened.filter((o) => o.device === bob.id).length, opened, "the next holder refuses the team too");
	assert.equal(b.store.inboxIds().length, 0);
});

test("SLH-F001: a stopped team is started again when its team file is replaced (the device joined again)", async () => {
	const b = rig("b", { towers: false });
	await b.start();
	rmSync(join(b.dir, "teams", `${TEAM_HEX}.json`));
	const a = rig("a");
	await a.start();
	await send(a, "lost");
	await until(() => b.notices.some((n) => /stopped/.test(n)), 3000, "the stop notice");
	const opened = relay.opened.filter((o) => o.device === bob.id).length;
	writeTeam(b.store, rosterOf(), bob);
	await until(() => relay.opened.filter((o) => o.device === bob.id).length > opened, 3000, "the team to start again");
	await until(() => b.store.inboxIds().length === 1, 3000, "the message the relay kept");
});

test("a relay that refuses the stream for good (the device was removed) ends the team with an error notice", async () => {
	relay.refuseStreams = 401;
	let requests = 0;
	const fetched = relay.fetch;
	relay.fetch = (input, init) => (String(input).includes("/events") && requests++, fetched(input, init));
	const b = rig("b", { towers: false });
	await b.start();
	await until(() => b.notices.some((n) => /no longer a member/.test(n)), 3000, "the removal notice");
	// SLH-F001: refused for good means no new stream every tick (drainMs is 20 ms).
	const before = requests;
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(requests, before, "a refused stream is not opened again and again");
});

test("presence: each holder tells the team it is online; share status adds the bound workspaces and their tabs, share presence only that it is online; an old presence is offline", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netOf([["tower-a", "w-a", "label-a", a.project]], { tabs: [{ tab_id: "w-a:t0", workspace_id: "w-a", label: "tower" }, { tab_id: "w-a:t1", workspace_id: "w-a", label: "api work" }], panes: [...netOf([["tower-a", "w-a", "label-a", a.project]]).panes, { pane_id: "px", tab_id: "w-a:t1", workspace_id: "w-a", agent_status: "working", tokens: { sb_role: "main" } }] });
	await Promise.all([a.start(), b.start()]);
	await until(() => b.holder.list()[0]?.devices[0]?.online, 3000, "A's presence at B");
	const [team] = b.holder.list();
	assert.equal(team!.name, "moldplan");
	const [peer] = team!.devices;
	assert.deepEqual([peer!.label, peer!.id, peer!.short], ["alice-mac", alice.id, alice.shortId]);
	assert.deepEqual(peer!.workspaces, [{ label: "label-a", tower: "idle", tabs: [{ label: "api work", state: "working" }] }]);
	b.skew += 100_000;
	assert.equal(b.holder.list()[0]!.devices[0]!.online, false, "no presence for 90 s is offline");
	// Presence only: the workspaces stay home.
	a.share = "presence";
	b.skew = 0;
	await until(() => b.holder.list()[0]?.devices[0]?.online && b.holder.list()[0]!.devices[0]!.workspaces.length === 0, 3000, "a presence without workspaces");
});

test("a presence is never queued or acknowledged, and one older than the last taken is ignored", async () => {
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.start(), b.start()]);
	await until(() => b.holder.list()[0]?.devices[0]?.online, 3000);
	assert.equal(relay.ackedBy(bob.id).length, 0);
	assert.equal(b.store.inboxIds().length, 0);
});

test("a team in config.json with no team file, and a team file with no config entry, are told once and run nothing", async () => {
	const b = rig("b");
	const lonely = new LinkHolder({ store: b.store, isHolder: () => true, config: () => ({ teams: new Map(), problems: ["team zz: it has no project"] }), net: async () => b.net, relay: clientFor(relay), offer: () => {}, notify: (t) => void b.notices.push(t), drainMs: 20 });
	cleanup.push(() => lonely.stop());
	await lonely.start();
	await lonely.refresh();
	await lonely.refresh();
	assert.equal(b.notices.filter((n) => /no entry under link\.teams/.test(n)).length, 1);
	assert.equal(b.notices.filter((n) => /no project/.test(n)).length, 1);
	assert.equal(relay.opened.length, 0);
});

test("SLH-F002: a holder whose start fails is not active, and starts again once the cause is gone", async () => {
	const b = rig("b", { towers: false });
	const file = join(b.dir, "device.json"), good = readFileSync(file, "utf8");
	const { writeFileSync } = await import("node:fs");
	writeFileSync(file, "{ not json");
	await assert.rejects(b.holder.start(), /device\.json is damaged/);
	assert.equal(b.holder.active, false, "no holder: a send says so rather than 'queued'");
	assert.deepEqual(await b.holder.send({ fromSession: "x", device: "alice-mac", text: "hi", reply: false }), { ok: false, error: "This computer's link holder is not running" });
	writeFileSync(file, good);
	await b.holder.start();
	assert.equal(b.holder.active, true);
});

test("SLH-F004: a 401 on a post halts the team's outbox for a while: the send says queued, a send meanwhile is refused up front, and the queued message lands once the halt is over", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	let refuse = 0;
	const fetched = relay.fetch;
	relay.fetch = async (input, init) => {
		if (String(input).endsWith("/envelopes") && refuse > 0) {
			const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString("utf8")) as { envelope: string };
			if (!parseEnvelope(Buffer.from(body.envelope, "base64url"))!.header.ephemeral && refuse-- > 0) return new Response(JSON.stringify({ error: "clock-skew" }), { status: 401, headers: { "content-type": "application/json" } });
		}
		return fetched(input, init);
	};
	await Promise.all([a.start(), b.start()]);
	refuse = 1;
	const first = await send(a, "one");
	assert.ok(first.ok && first.details.status === "queued", JSON.stringify(first));
	const second = await send(a, "two");
	assert.ok(!second.ok && /refusing this device/.test(second.error), JSON.stringify(second));
	await until(() => queued().length === 1, 3000, "the refused message to land after the halt");
	await until(() => b.store.inboxIds().length === 1, 3000, "it reaches B");
	const third = await send(a, "three");
	assert.ok(third.ok && third.details.status === "posted", JSON.stringify(third));
	assert.deepEqual(queued().map((st) => st.envelope.header.seq), [1, 2], "in order, no gap");
});

test("SLH-F003: an offer is sticky: a tower that opens nearer the project root does not get a message the first tower still holds; if the first goes, the new one is offered it", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	mkdirSync(join(b.project, "sub"), { recursive: true });
	const one = ["tower-1", "w1", "one", join(b.project, "sub")] as [string, string, string, string], two = ["tower-2", "w2", "two", b.project] as [string, string, string, string];
	b.net = netOf([one]);
	await Promise.all([a.start(), b.start()]);
	await send(a, "only once");
	await until(() => b.offers.length === 1, 3000, "tower-1 offered the message");
	b.net = netOf([one, two]);
	for (let i = 0; i < 5; i++) await b.holder.drain();
	await new Promise((r) => setTimeout(r, 100));
	assert.deepEqual(b.offers.map((o) => o.tower), ["tower-1"], "tower-2 is nearer the root but tower-1 still holds the message");
	b.net = netOf([two]);
	await until(() => b.offers.length === 2, 3000, "the new tower offered it once the first is gone");
	assert.equal(b.offers[1]!.tower, "tower-2");
});

const outboxFiles = (r: Rig) => {
	try {
		return readdirSync(join(r.dir, "outbox", TEAM_HEX));
	} catch {
		return [];
	}
};

test("SLH-F005: a message the relay has not taken is saved on disk before the first post, survives the holder, goes first after a restart, and leaves the disk when it lands", async () => {
	const a = rig("a");
	a.postWaitMs = 100;
	await a.start();
	relay.failPosts = 100_000;
	const first = await send(a, "keep me");
	assert.ok(first.ok && first.details.status === "queued", JSON.stringify(first));
	assert.equal(outboxFiles(a).length, 1, "the envelope is on disk");
	assert.match(outboxFiles(a)[0]!, /^000000000001-[0-9a-f]{32}\.bin$/);
	assert.equal(device(a).nextSeq, 2);
	await a.holder.stop();
	relay.failPosts = 0;
	assert.equal(queued().length, 0);
	await a.restart();
	await until(() => queued().length === 1, 3000, "the saved message to land after the restart");
	await until(() => outboxFiles(a).length === 0, 3000, "its file to be removed once it landed");
	assert.ok((await send(a, "after")).ok);
	assert.deepEqual(queued().map((st) => st.envelope.header.seq), [1, 2], "the saved one first");
	assert.equal(queued()[0]!.envelope.header.from, alice.id);
});

test("SLH-F005/F018: a refusal that arrives after the send answered queued is told to the boss, and the file goes", async () => {
	const a = rig("a");
	a.postWaitMs = 100;
	let mode: "ok" | "down" | "refuse" = "ok";
	const fetched = relay.fetch;
	relay.fetch = async (input, init) => {
		if (String(input).endsWith("/envelopes") && mode !== "ok") {
			const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString("utf8")) as { envelope: string };
			if (!parseEnvelope(Buffer.from(body.envelope, "base64url"))!.header.ephemeral) return new Response(JSON.stringify({ error: mode === "down" ? "unavailable" : "bad-envelope" }), { status: mode === "down" ? 503 : 422, headers: { "content-type": "application/json" } });
		}
		return fetched(input, init);
	};
	await a.start();
	mode = "down";
	const sent = await send(a, "doomed");
	assert.ok(sent.ok && sent.details.status === "queued");
	assert.equal(outboxFiles(a).length, 1);
	mode = "refuse";
	await until(() => a.notices.some((n) => /the relay refused the message to bob-mac/.test(n)), 3000, "the late refusal");
	await until(() => outboxFiles(a).length === 0, 3000, "the refused file removed");
});
