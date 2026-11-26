import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildEnvelope, parseEnvelope } from "../src/link/envelope.ts";
import { CAPS_FEATURES, capsList, LinkHolder } from "../src/link/holder.ts";
import { decodePlaintext, encodePlaintext } from "../src/link/kinds.ts";
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
	/** What the open-a-tower seam was asked, and whether it fails; `level` is what config.json (the policy file, unattended) gives alice. */
	opens: { project: string; toWorkspace: string | undefined; from?: string; mode?: string }[];
	openFails: boolean | "service";
	/** What a wake of an existing workspace answers when there is none to wake. */
	noWorkspace: boolean;
	/** Holds a wake open until it is called, to see the holder while one is in flight. */
	hold?: Promise<void>;
	level: "reply" | "forward" | "dispatch" | undefined;
	start(): Promise<void>;
	restart(over?: { store?: LinkStore }): Promise<void>;
}

function rig(name: "a" | "b", o: { entries?: ReturnType<typeof rosterOf>; seed?: boolean; towers?: boolean; runs?: boolean; unattended?: boolean } = {}): Rig {
	const keys = name === "a" ? alice : bob, entries = o.entries ?? rosterOf();
	const dir = join(root, name, "link"), project = join(root, `${name}-project`);
	mkdirSync(project, { recursive: true });
	const first = new LinkStore(dir, { alive: () => true });
	first.ensure();
	writeDevice(first, keys, name === "a" ? "alice-mac" : "bob-mac");
	if (o.seed !== false) writeTeam(first, entries, keys);
	const r = { name, dir, project, offers: [], notices: [], displaced: 0, isHolder: true, skew: 0, share: "status", postWaitMs: 3000, opens: [], openFails: false, noWorkspace: false, level: undefined } as unknown as Rig;
	r.net = o.towers === false ? netOf([]) : netOf([[`tower-${name}`, `w-${name}`, `label-${name}`, project]]);
	const stateDir = join(root, name, "state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: Boolean(o.runs) } }));
	const build = (store: LinkStore) => new LinkHolder({
		store, stateDir, isHolder: () => r.isHolder, config: () => { const c = config(project, r.share)(); if (r.level) c.trust.set(alice.id, r.level); return c; }, net: async () => r.net, relay: clientFor(relay),
		offer: (tower, id) => void r.offers.push({ tower: tower.id, id }), notify: (text) => void r.notices.push(text), onDisplaced: () => void r.displaced++,
		...(o.unattended === undefined ? {} : { attended: () => !o.unattended, openTower: async (p: string, w: string | undefined, from: string, mode: string) => { r.opens.push({ project: p, toWorkspace: w, from, mode }); await r.hold; if (r.openFails) throw Object.assign(new Error("herdr said no"), r.openFails === "service" ? { code: "service" } : {}); return mode === "wake" && r.noWorkspace ? "no-workspace" as const : undefined; } }),
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
async function forge(seq: number, text: string, from = alice, head = stateOf(rosterOf(), alice).head, toWorkspace = "") {
	const envelope = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from, seq, ts: Date.now(), kind: "tower", to: [bob.id], plaintext: encodePlaintext("tower", { fromWorkspace: "forged", toWorkspace, replyExpected: false, text }) });
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
	await until(() => b.notices.some((n) => /is not delivered yet; it waits for the tower of/.test(n)), 3000, "the inbox notice");
	assert.equal(b.offers.length, 0);
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.notices.filter((n) => /is not delivered yet; it waits for the tower of/.test(n)).length, 1, "the notice is not repeated");
	assert.equal(b.store.inboxIds().length, 1);
	// A tower in some other folder is no tower of this project.
	b.net = netOf([["tower-else", "w-else", "else", join(root, "elsewhere")]]);
	await b.holder.drain();
	assert.equal(b.offers.length, 0);
	b.net = netOf([["tower-late", "w-late", "late", b.project]]);
	await until(() => b.offers.length === 1, 3000, "the late tower to be offered the message");
	assert.equal(b.offers[0]!.tower, "tower-late");
});

test("an unattended device opens a tower for a dispatch sender whose message finds none; the drain runs again after the open and the message then waits for the server's tower", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: true })];
	b.level = "dispatch";
	await Promise.all([a.start(), b.start()]);
	await send(a, "build it", { reply: true });
	await until(() => b.opens.length === 1, 3000, "the open");
	assert.deepEqual(b.opens[0], { project: b.project, toWorkspace: undefined, from: alice.id, mode: "open" }, "the open names the controller whose message found no tower: a failure is told to it");
	assert.deepEqual(events(b).filter((e) => /^tower-open/.test(String(e.event))).map((e) => e.event), ["tower-open", "tower-opened"]);
	// The server's tower is there now: the message is served by it, and the open is not asked again.
	b.net = netOf([["sb-tower-w-b", "w-b", "label-b", b.project]]);
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 1);
	assert.equal(b.offers.length, 0, "nothing is offered to the server's identity");
});

test("an open that works but whose tower does not show in the net is not repeated at once", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: true })];
	b.level = "dispatch";
	await Promise.all([a.start(), b.start()]);
	await send(a, "build it");
	await until(() => b.opens.length === 1, 3000, "the open");
	await until(() => events(b).some((e) => e.event === "tower-opened"), 3000, "the open to end");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 1, "within the 60 s");
	b.skew = 61_000;
	await b.holder.drain();
	await until(() => b.opens.length === 2, 3000, "another open after the 60 s");
});

test("the notice for messages with no tower open says who sent them, how many, how long they have waited, which tower they wait for, and when the oldest is dropped (todo #122)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	// A workspace that is open and has no tower in it: a message for it by id names it by its label; one for a workspace that is not open names the project.
	withWorkspace(b, "w-live", "MP Center");
	await Promise.all([a.start(), b.start()]);
	const inbox = () => b.holder.summary().alerts.filter((x) => x.kind === "inbox").sort((x, y) => (x.id < y.id ? -1 : 1));
	await send(a, "one", { workspace: "w-live" });
	await send(a, "two", { workspace: "w-live" });
	await send(a, "three", { workspace: "w-gone" });
	await until(() => b.store.inboxIds().length === 3 && b.notices.length === 3, 3000, "three notices");
	await b.holder.drain();
	const [live, gone] = ((alerts) => [alerts.find((x) => x.data.workspace !== undefined)!, alerts.find((x) => x.data.workspace === undefined)!])(inbox());
	assert.equal(inbox().length, 2, "one notice per team and tower asked for, not one per message");
	assert.notEqual(live.id, gone.id);
	const since = Math.min(...b.store.inboxIds().map((id) => b.store.readInbox(id)!.received));
	assert.deepEqual({ ...live.data, since: undefined, drop: undefined }, { count: 2, from: "alice-mac", others: 0, workspace: "MP Center", project: basename(b.project), since: undefined, drop: undefined, ageMin: 1 });
	assert.deepEqual([gone.data.count, gone.data.project, gone.data.workspace], [1, basename(b.project), undefined], "a workspace that is not open is not named: its id is no word for the boss");
	assert.ok(Number(live.data.since) >= since && Number(live.data.since) <= since + 5000, "the oldest message's arrival, epoch ms");
	assert.equal(Number(live.data.drop) - Number(live.data.since), 7 * 24 * 3600_000, "the store's 7 days");
	b.skew = 3 * 3600_000 + 20 * 60_000;
	await b.holder.drain();
	assert.equal(inbox().find((x) => x.id === live.id)!.data.ageMin, 180, "whole hours once an hour has passed, so the notice changes only when its words do");
	b.skew = 2 * 24 * 3600_000 + 5 * 3600_000;
	await b.holder.drain();
	assert.equal(inbox().find((x) => x.id === live.id)!.data.ageMin, 2 * 1440);
});

test("no tower is opened below dispatch on an unattended device, or when the seam is absent; an attended device only wakes (todo #122)", async () => {
	for (const [level, unattended] of [["forward", true], [undefined, true], ["dispatch", undefined]] as const) {
		const a = rig("a"), b = rig("b", { towers: false, ...(unattended === undefined ? {} : { unattended }) });
		b.level = level;
		await Promise.all([a.start(), b.start()]);
		await send(a, "build it");
		await until(() => b.notices.some((n) => /is not delivered yet; it waits for the tower of/.test(n)), 3000, `the inbox notice at ${String(level)}/${String(unattended)}`);
		for (let i = 0; i < 3; i++) await b.holder.drain();
		assert.equal(b.opens.length, 0, `${String(level)}/${String(unattended)}`);
		await Promise.all([a.holder.stop(), b.holder.stop()]);
	}
});

// An attended device wakes the tower of a workspace it already has for a teammate's message (docs/specs/2026-10-26-sb-backend.md, No tower service for the team's project; the boss's ruling of 2026-11-07).
const inboxAlerts = (r: Rig) => r.holder.summary().alerts.filter((x) => x.kind === "inbox");
const woken = (r: Rig) => events(r).filter((e) => /^tower-wake|^tower-woke/.test(String(e.event)));

for (const level of [undefined, "reply", "forward", "dispatch"] as const) {
	test(`an attended device wakes the tower of its existing workspace for a teammate at ${String(level)}; the notice stays away while the wake works (todo #122)`, async () => {
		const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
		b.level = level;
		withWorkspace(b, "w-live", "MP Center");
		await Promise.all([a.start(), b.start()]);
		await send(a, "wake up", { workspace: "w-live" });
		await until(() => b.opens.length === 1, 3000, "the wake");
		assert.deepEqual(b.opens[0], { project: b.project, toWorkspace: "w-live", from: alice.id, mode: "wake" });
		await until(() => events(b).some((e) => e.event === "tower-woke"), 3000, "the wake to end");
		assert.deepEqual(woken(b).map((e) => e.event), ["tower-wake", "tower-woke"]);
		assert.ok(woken(b).every((e) => !JSON.stringify(e).includes("wake up")), "no message content in the log");
		for (let i = 0; i < 3; i++) await b.holder.drain();
		assert.deepEqual(inboxAlerts(b), [], "no alert while the woken tower is about to take the message");
		assert.equal(b.notices.some((n) => /is not delivered yet/.test(n)), false, "no pi notice either");
		// The woken tower shows in the net: the message is the server's tower's, as for any message.
		b.net = netOf([["sb-tower-w-live", "w-live", "MP Center", b.project]]);
		await b.holder.drain();
		assert.equal(b.opens.length, 1);
	});
}

test("a message from a device that is no member of the team wakes nothing", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	await Promise.all([a.start(), b.start()]);
	await forge(1, "let me in", carol);
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 0);
	assert.deepEqual(woken(b), []);
});

test("an attended device with no workspace to wake makes none, and the notice says what the boss can do", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	b.noWorkspace = true;
	await Promise.all([a.start(), b.start()]);
	await send(a, "anyone there");
	await until(() => events(b).some((e) => e.event === "tower-wake-none"), 3000, "the outcome");
	assert.deepEqual(woken(b).map((e) => e.event), ["tower-wake", "tower-wake-none"]);
	await until(() => b.notices.length === 1, 3000, "the notice");
	assert.match(b.notices[0]!, /no workspace is open for it/);
	assert.equal(inboxAlerts(b).length, 1);
	assert.equal(inboxAlerts(b)[0]!.data.wake, "none");
	assert.equal(b.opens.length, 1, "backed off, and nothing is made");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 1);
});

test("a failed wake is logged with its reason, shown in the notice in plain words, and not tried again for 60 s", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	b.openFails = true;
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => events(b).some((e) => e.event === "tower-wake-failed"), 3000, "the failure line");
	assert.equal(events(b).find((e) => e.event === "tower-wake-failed")!.error, "herdr said no", "the log keeps the server's own words");
	await until(() => b.notices.length === 1, 3000, "the notice");
	assert.match(b.notices[0]!, /waking its tower did not work \(something went wrong; link\.log has the details\)/);
	assert.doesNotMatch(b.notices[0]!, /herdr said no/, "no raw server English for the boss");
	assert.deepEqual([inboxAlerts(b)[0]!.data.wake, inboxAlerts(b)[0]!.data.reason], ["failed", "other"], "the page gets a reason it has words for");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 1, "backed off");
	b.openFails = false;
	b.skew = 61_000;
	await b.holder.drain();
	await until(() => b.opens.length === 2, 3000, "the wake after the backoff");
	await until(() => events(b).filter((e) => e.event === "tower-woke").length === 1, 3000, "the second wake to work");
	assert.deepEqual(inboxAlerts(b), [], "the alert goes when the wake works");
});

test("a wake that failed because the tower service is not there yet says so in plain words (IWR-F007)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	b.openFails = "service";
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => b.notices.length === 1, 3000, "the notice");
	assert.match(b.notices[0]!, /waking its tower did not work \(the tower service is still starting\)/);
	assert.deepEqual([inboxAlerts(b)[0]!.data.wake, inboxAlerts(b)[0]!.data.reason], ["failed", "service"]);
});

test("a failed wake stays on the notice while it is tried again (IWR-F006, M15)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	b.openFails = true;
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => inboxAlerts(b).length === 1, 3000, "the failed wake's alert");
	let release!: () => void;
	b.hold = new Promise<void>((resolve) => (release = resolve));
	b.skew = 61_000;
	await b.holder.drain();
	await until(() => b.opens.length === 2, 3000, "the retry in flight");
	assert.equal(inboxAlerts(b)[0]?.data.wake, "failed", "the failure is not hidden by the retry");
	release();
	await until(() => events(b).filter((e) => e.event === "tower-wake-failed").length >= 1 && b.opens.length === 2, 3000, "the retry to end");
});

test("messages that arrive together wake the tower once, and one in flight is not doubled", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	let release!: () => void;
	b.hold = new Promise<void>((resolve) => (release = resolve));
	await Promise.all([a.start(), b.start()]);
	for (const text of ["one", "two", "three"]) await send(a, text);
	await until(() => b.store.inboxIds().length === 3 && b.opens.length === 1, 3000, "three messages and the wake");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.deepEqual(inboxAlerts(b), [], "no alert while the wake is in flight");
	release();
	await until(() => events(b).some((e) => e.event === "tower-woke"), 3000, "the wake to end");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 1);
	assert.equal(woken(b).length, 2);
});

test("a wake that worked but whose tower never takes the message stops hiding the notice after two minutes, on the page and in pi (IWR-F004)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => events(b).some((e) => e.event === "tower-woke"), 3000, "the wake");
	assert.deepEqual(inboxAlerts(b), []);
	await b.holder.drain();
	assert.deepEqual(b.notices, [], "no pi notice inside the two minutes");
	b.skew = 121_000;
	assert.equal(inboxAlerts(b).length, 1);
	assert.equal(inboxAlerts(b)[0]!.data.wake, undefined, "the plain copy: it goes through when the tower can take it");
	await b.holder.drain();
	assert.equal(b.notices.length, 1, "the pi notice comes with the page's");
	assert.match(b.notices[0]!, /is not delivered yet; it waits for the tower of/);
});

/** A workspace of the net that has a pane inside the project and no tower. */
const withWorkspace = (r: Rig, id: string, label = id, extra: Record<string, unknown> = {}) => {
	r.net = { ...r.net, workspaces: [...r.net.workspaces, { workspace_id: id, label, tokens: {}, ...extra }], panes: [...r.net.panes, { pane_id: `px-${id}`, tab_id: `${id}:t0`, workspace_id: id, cwd: r.project, agent_status: "idle", tokens: {} }] } as NetView;
};

test("a workspace name that matches no workspace of this computer costs no wake, and ghost names make one notice, not one each (IWR-F002, IWR-F005)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	await Promise.all([a.start(), b.start()]);
	for (let i = 0; i < 20; i++) await send(a, `ghost ${i}`, { workspace: `ghost-${i}` });
	await until(() => b.store.inboxIds().length === 20, 5000, "twenty messages");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 0, "no wake for a name that is no workspace here");
	assert.deepEqual(woken(b), [], "and nothing in the log");
	assert.equal(inboxAlerts(b).length, 1, "one notice for all the ghost names");
	assert.deepEqual([inboxAlerts(b)[0]!.data.count, inboxAlerts(b)[0]!.data.wake, inboxAlerts(b)[0]!.data.workspace], [20, "none", undefined]);
	assert.equal(b.notices.length, 1, "one pi notice for them");
	assert.match(b.notices[0]!, /no workspace is open for it on this computer/);
	// The workspace the name stands for opens later: the message is woken for it, by its id.
	withWorkspace(b, "w-real", "ghost-3");
	await b.holder.drain();
	await until(() => b.opens.length === 1, 3000, "the wake once the workspace exists");
	assert.equal(b.opens[0]!.toWorkspace, "w-real");
});

test("a sender wakes at most three towers at once; the rest wait their turn without a notice (IWR-F002)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	let release!: () => void;
	b.hold = new Promise<void>((resolve) => (release = resolve));
	for (let i = 0; i < 6; i++) withWorkspace(b, `w${i}`);
	await Promise.all([a.start(), b.start()]);
	for (let i = 0; i < 6; i++) await send(a, `to ${i}`, { workspace: `w${i}` });
	await until(() => b.store.inboxIds().length === 6 && b.opens.length === 3, 5000, "three wakes");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 3, "the cap holds while they are in flight");
	assert.deepEqual(inboxAlerts(b), [], "the ones that wait are not a notice");
	release();
	await until(() => b.opens.length === 6, 5000, "the rest after the first three ended");
});

test("a head or sub workspace named as the target is no tower to wake: the notice names the project, with no contradiction (IWR-F007)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	withWorkspace(b, "w-head", "Head", { tokens: { sb_head: "1" } });
	withWorkspace(b, "w-sub", "Feature", { worktree: { checkout_path: "/w/f", is_linked_worktree: true, repo_key: "/r" } });
	await Promise.all([a.start(), b.start()]);
	await send(a, "to the head", { workspace: "w-head" });
	await send(a, "to a sub", { workspace: "Feature" });
	await until(() => b.store.inboxIds().length === 2, 3000, "two messages");
	for (let i = 0; i < 2; i++) await b.holder.drain();
	assert.equal(b.opens.length, 0);
	assert.equal(inboxAlerts(b).length, 1);
	assert.deepEqual([inboxAlerts(b)[0]!.data.workspace, inboxAlerts(b)[0]!.data.wake, inboxAlerts(b)[0]!.data.count], [undefined, "none", 2]);
	assert.ok(b.notices.every((n) => /tower of project/.test(n) && !/workspace “?(Head|Feature)/.test(n)), b.notices.join("|"));
});

test("when tower runs are switched off nothing is woken and the notice says so at once (IWR-F003)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false })];
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => b.notices.length === 1, 3000, "the notice");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 0);
	assert.deepEqual(woken(b), []);
	assert.equal(inboxAlerts(b)[0]!.data.wake, "off");
	assert.match(b.notices[0]!, /tower runs are switched off on this computer/);
	writeFileSync(join(root, "b", "state", "config.json"), JSON.stringify({ towerRuns: { enabled: true } }));
	await b.holder.drain();
	await until(() => b.opens.length === 1, 3000, "the wake once they are on");
});

test("a wake with no workspace backs off longer each time, wakes again at once when a workspace of the project appears, and logs only when the state changes (IWR-F003)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	b.noWorkspace = true;
	await Promise.all([a.start(), b.start()]);
	await send(a, "anyone there");
	await until(() => events(b).some((e) => e.event === "tower-wake-none"), 3000, "the first outcome");
	const calls = async (skew: number) => ((b.skew = skew), await b.holder.drain(), await new Promise((r) => setTimeout(r, 60)), b.opens.length);
	assert.equal(await calls(30_000), 1, "not inside the first minute");
	assert.equal(await calls(61_000), 2);
	assert.equal(await calls(150_000), 2, "the second wait is two minutes");
	assert.equal(await calls(183_000), 3);
	assert.equal(await calls(183_000 + 3 * 60_000), 3, "four minutes the third time");
	assert.equal(await calls(183_000 + 4 * 60_000 + 1000), 4);
	assert.deepEqual(woken(b).map((e) => e.event), ["tower-wake", "tower-wake-none"], "four wakes, two lines: the log changes with the state, not with the clock");
	// A workspace with a pane inside the project shows up: that is a change the wake could not have seen, so it goes at once.
	withWorkspace(b, "w-new");
	await b.holder.drain();
	await until(() => b.opens.length === 5, 3000, "the wake for the new workspace");
});

test("a failed wake is tried again after a minute, then after longer ones, and the log has it once (IWR-F003)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	b.openFails = true;
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => events(b).some((e) => e.event === "tower-wake-failed"), 3000, "the failure");
	const calls = async (skew: number) => ((b.skew = skew), await b.holder.drain(), await new Promise((r) => setTimeout(r, 60)), b.opens.length);
	assert.equal(await calls(61_000), 2, "after a minute");
	assert.equal(await calls(100_000), 2, "then two minutes");
	assert.equal(await calls(183_000), 3);
	assert.equal(events(b).filter((e) => e.event === "tower-wake-failed").length, 1, "the same failure is one line");
	assert.equal(events(b).filter((e) => e.event === "tower-wake").length, 1);
});

test("a wake that works but whose tower the net never shows is not repeated every minute, and its log lines do not repeat (IWR-F003)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => events(b).some((e) => e.event === "tower-woke"), 3000, "the wake");
	const calls = async (skew: number) => ((b.skew = skew), await b.holder.drain(), await new Promise((r) => setTimeout(r, 60)), b.opens.length);
	assert.equal(await calls(61_000), 2);
	assert.equal(await calls(150_000), 2, "the second wait is two minutes");
	assert.equal(await calls(183_000), 3);
	assert.deepEqual(woken(b).map((e) => e.event), ["tower-wake", "tower-woke"]);
});

test("a failed open is logged and not tried again for 60 s; one in flight is not doubled", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: true })];
	b.level = "dispatch";
	b.openFails = true;
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => b.opens.length === 1, 3000, "the first open");
	await until(() => events(b).some((e) => e.event === "tower-open-failed"), 3000, "the failure line");
	assert.equal(events(b).find((e) => e.event === "tower-open-failed")!.error, "herdr said no");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 1, "backed off");
	b.skew = 61_000;
	await b.holder.drain();
	await until(() => b.opens.length === 2, 3000, "the open after the backoff");
});

test("a tower the sb server runs takes no offer: the message waits in the inbox for an ally run, the boss hears of it after 10 minutes, and nothing is offered to the identity", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	await Promise.all([a.start(), b.start()]);
	b.net = netOf([["sb-tower-wb", "w-b", "label-b", b.project]]);
	await send(a, "for the served tower");
	await until(() => relay.ackedBy(bob.id).length === 1, 3000, "the ack");
	await until(() => b.store.inboxIds().length === 1 && b.holder.servedFor("sb-tower-wb").length === 1, 3000, "the message to be waiting for the identity");
	assert.ok(!b.holder.summary().alerts.some((x) => x.kind === "served"), "no notice while an ally run may still take it");
	b.skew += 11 * 60_000;
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.offers.length, 0, "an offer to a tower that is no session would go nowhere");
	assert.equal(b.store.inboxIds().length, 1, "the message stays in the inbox");
	const served = b.holder.summary().alerts.filter((x) => x.kind === "served");
	assert.equal(served.length, 1);
	assert.equal(served[0]!.data.count, 1);
	assert.ok(!b.holder.summary().alerts.some((x) => x.kind === "inbox" || x.kind === "held"), "it is not told as a missing tower or an idle one");
});

async function runPi(runs: boolean) {
	const [a, b] = [rig("a"), rig("b", { towers: false, runs })];
	await Promise.all([a.start(), b.start()]);
	b.net = netOf([["pi-run", "w-b", "label-b", b.project]]);
	(b.net.sessions[0] as { name?: string }).name = "tower run · label-b · 1a2b3c4d";
	await send(a, "for the run's pi");
	await until(() => relay.ackedBy(bob.id).length === 1, 3000, "the ack");
	return b;
}

test("B5R3-F006: the pi of a tower run takes no offer when the tower runs are on", async () => {
	const b = await runPi(true);
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.offers.length, 0, "the run's pi is served by the server");
	await until(() => b.holder.servedFor("pi-run").length === 1, 3000, "the message to wait in the inbox");
	b.skew += 11 * 60_000;
	assert.ok(b.holder.summary().alerts.some((x) => x.kind === "served"), "the served notice after 10 minutes");
});

test("B5R3-F006: with the tower runs off a session of that name is an ordinary tower and is offered the message", async () => {
	const b = await runPi(false);
	await until(() => b.offers.length === 1, 3000, "an offer to the session");
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
	a.net = netOf([["tower-a", "w-a", "label-a", a.project]], { tabs: [{ tab_id: "w-a:t0", workspace_id: "w-a", label: "tower" }, { tab_id: "w-a:t1", workspace_id: "w-a", label: "api work" }], panes: [...netOf([["tower-a", "w-a", "label-a", a.project]]).panes, { pane_id: "px", tab_id: "w-a:t1", workspace_id: "w-a", cwd: a.project, agent_status: "working", tokens: { sb_role: "main" } }] });
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
	const lonely = new LinkHolder({ store: b.store, isHolder: () => true, config: () => ({ teams: new Map(), trust: new Map(), problems: ["team zz: it has no project"] }), net: async () => b.net, relay: clientFor(relay), offer: () => {}, notify: (t) => void b.notices.push(t), drainMs: 20 });
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
	// SLH-F018: nothing is kept for a send that stopped waiting.
	const runs = (a.holder as unknown as { runs: Map<string, { settled: Map<string, unknown>; gone: Map<string, string> }> }).runs;
	assert.equal([...runs.values()].reduce((n, r) => n + r.settled.size + r.gone.size, 0), 0, "no outcome and no waiting mark left behind");
});

test("SLH-F019: the inbox is capped per sender and in all: past the cap the envelope stays at the relay, unacknowledged, with one notice", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false })];
	await Promise.all([a.start(), b.start()]);
	await b.holder.stop();
	const full = new LinkHolder({
		store: b.store, isHolder: () => true, config: config(b.project), net: async () => b.net, relay: clientFor(relay), offer: () => {}, notify: (t) => void b.notices.push(t),
		backoff: () => 5, drainMs: 20, presenceMs: 100_000, inboxPerSender: 2,
	});
	cleanup.push(() => full.stop());
	await full.start();
	for (const text of ["one", "two", "three", "four"]) assert.ok((await send(a, text)).ok);
	await until(() => b.store.inboxIds().length === 2, 3000, "two messages in the inbox");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(b.store.inboxIds().length, 2, "the cap holds");
	assert.equal(relay.ackedBy(bob.id).length, 2);
	assert.equal(relay.pendingFor(bob.id).length, 2, "the rest wait at the relay");
	assert.equal(b.notices.filter((n) => /too many messages/.test(n)).length, 1);
});

test("SLH-F019: an unreadable inbox file is dropped, and the inbox is ordered by when the messages came", async () => {
	const { writeFileSync } = await import("node:fs");
	const b = rig("b", { towers: false });
	await b.start();
	const damaged = "09".repeat(16);
	writeFileSync(join(b.dir, "inbox", `${damaged}.json`), "garbage");
	await b.holder.drain();
	assert.deepEqual(b.store.inboxIds(), []);
	assert.ok(events(b).some((e) => e.event === "inbox-dropped" && e.reason === "damaged"));
});

/** A workspace of the net whose panes are all outside the project. */
const withOutsideWorkspace = (r: Rig, id: string, label = id) => {
	r.net = { ...r.net, workspaces: [...r.net.workspaces, { workspace_id: id, label, tokens: {} }], panes: [...r.net.panes, { pane_id: `px-${id}`, tab_id: `${id}:t0`, workspace_id: id, cwd: join(root, "elsewhere"), agent_status: "idle", tokens: {} }] } as NetView;
};
const wakesOf = (r: Rig) => (r.holder as unknown as { wakes: Map<string, unknown> }).wakes;

test("a name that matches a workspace with no pane inside the project is a ghost: no wake, one notice for the project (IWR-F008)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	for (let i = 0; i < 5; i++) withOutsideWorkspace(b, `w-out${i}`, `Out${i}`);
	await Promise.all([a.start(), b.start()]);
	for (let i = 0; i < 20; i++) await send(a, `out ${i}`, { workspace: i % 2 ? `w-out${i % 5}` : `Out${i % 5}` });
	await until(() => b.store.inboxIds().length === 20, 5000, "twenty messages");
	for (let i = 0; i < 3; i++) await b.holder.drain();
	assert.equal(b.opens.length, 0, "no wake for a workspace outside the project");
	assert.equal(inboxAlerts(b).length, 1, "one card, none of its own for each outside workspace");
	assert.equal(inboxAlerts(b)[0]!.data.workspace, undefined);
	assert.equal(b.notices.length, 1);
	assert.match(b.notices[0]!, /tower of project/);
	assert.doesNotMatch(b.notices[0]!, /workspace “?Out/);
});

test("the ghost pi notice comes again for a ghost that arrives after the earlier ghost messages are gone (IWR-F010)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	await Promise.all([a.start(), b.start()]);
	await send(a, "first", { workspace: "ghost-1" });
	await until(() => b.notices.length === 1, 3000, "the first notice");
	for (const id of b.store.inboxIds()) await b.holder.taken(id, "tower-b");
	await b.holder.drain();
	assert.equal(b.store.inboxIds().length, 0);
	await send(a, "second", { workspace: "ghost-2" });
	await until(() => b.notices.length === 2, 3000, "a notice for the later ghost");
});

test("one sender's wakes in flight do not hold back another sender's (IWR-F011 N04)", async () => {
	const entries = rosterOf(["bob", "carol"]);
	const b = rig("b", { entries, towers: false, unattended: false, runs: true });
	let release!: () => void;
	b.hold = new Promise<void>((resolve) => (release = resolve));
	for (let i = 0; i < 5; i++) withWorkspace(b, `w${i}`);
	await b.start();
	const head = stateOf(entries, alice).head;
	for (let i = 0; i < 4; i++) await forge(i + 1, `alice ${i}`, alice, head, `w${i}`);
	await until(() => b.store.inboxIds().length === 4 && b.opens.length === 3, 5000, "alice's three wakes in flight");
	await forge(1, "carol", carol, head, "w4");
	await until(() => b.opens.length === 4, 5000, "carol's wake starts while alice's three hang");
	assert.equal(b.opens[3]!.from, carol.id);
	release();
});

test("a failed wake is never retried less often than every 10 minutes (IWR-F011 N13)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	b.openFails = true;
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => events(b).some((e) => e.event === "tower-wake-failed"), 3000, "the failure");
	const calls = async (skew: number) => ((b.skew = skew), await b.holder.drain(), await new Promise((r) => setTimeout(r, 60)), b.opens.length);
	let at = 0, n = 1;
	// Backoff doubles from 1 minute: 1, 2, 4, 8, then the cap of 10, so after 20 more minutes at most 2 further calls.
	for (const step of [61, 183, 427, 915]) { at = step * 1000; n = await calls(at); }
	assert.equal(n, 5);
	assert.equal(await calls(at + 9 * 60_000), 5, "inside the cap nothing goes");
	assert.equal(await calls(at + 10 * 60_000 + 1000), 6, "10 minutes after the last try");
	assert.equal(await calls(at + 20 * 60_000 + 2000), 7, "and again after 10, not 30");
});

test("wake records leave with the messages that wanted them (IWR-F011 N15)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	withWorkspace(b, "w1");
	await Promise.all([a.start(), b.start()]);
	await send(a, "one", { workspace: "w1" });
	await until(() => events(b).some((e) => e.event === "tower-woke"), 3000, "the wake");
	assert.equal(wakesOf(b).size, 1);
	for (const id of b.store.inboxIds()) await b.holder.taken(id, "tower-b");
	await b.holder.drain();
	assert.equal(wakesOf(b).size, 0);
});

test("a wake retry that worked again does not restart the two minutes the notice stays away (IWR-F011 N17)", async () => {
	const [a, b] = [rig("a"), rig("b", { towers: false, unattended: false, runs: true })];
	await Promise.all([a.start(), b.start()]);
	await send(a, "one");
	await until(() => events(b).some((e) => e.event === "tower-woke"), 3000, "the wake");
	b.skew = 61_000;
	await b.holder.drain();
	await until(() => b.opens.length === 2, 3000, "the retry");
	await new Promise((r) => setTimeout(r, 60));
	b.skew = 125_000;
	assert.equal(inboxAlerts(b).length, 1, "past two minutes from the first wake that worked, the retry did not hide it again");
});

test("caps list hello first and the resume feature with tower.worker; a decoder that keeps 16 still sees hello and every feature it knew", () => {
	const all = { hello: true, unitStop: true, operate: true, waits: true, workers: true };
	const list = capsList(all);
	assert.equal(list[0], "hello");
	assert.ok(list.includes("tower.worker.resume") && list.includes("tower.worker"));
	for (const off of [{ ...all, workers: false }]) assert.ok(!capsList(off).some((f) => f.startsWith("tower.worker")), "the resume cap follows tower.worker's condition");
	const decoded = decodePlaintext("caps", encodePlaintext("caps", { features: list })) as { features: string[] };
	assert.deepEqual(decoded.features, list, "a new decoder reads them all");
	const old = decoded.features.slice(0, 16), known = CAPS_FEATURES.filter((f) => f !== "tower.worker.resume");
	assert.ok(old.includes("hello") && known.every((f) => old.includes(f)), "the 16 an older decoder keeps hold hello and all 14 features it knows");
});
