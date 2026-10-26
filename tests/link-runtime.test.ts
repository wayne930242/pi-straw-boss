import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildEnvelope } from "../src/link/envelope.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { RelayClient } from "../src/link/relay.ts";
import { type InboxItem, LinkStore, LOCK_WAIT_MS } from "../src/link/store.ts";
import { POST_WAIT_MS } from "../src/link/holder.ts";
import { ASK_MS, type Link, MESSAGE_TYPE, remoteTowers } from "../src/link/runtime.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, clientFor, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { Agent, type Registration, until, World } from "./fakes.ts";
import { teamKey, TEAM } from "./link/scenario.ts";

// Straw Link inside pi sessions: the election among the sessions of a computer, the `straw-boss/link` channel, tower_send with `device`, tower_list's
// remote towers, and a delivery that waits for an idle tower and enters its session as a `straw-link` message sent with triggerTurn.

let root = "";
let relay: FakeRelay;
const worlds: World[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-runtime-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.stopAll();
	rmSync(root, { recursive: true, force: true });
});

const FAST = { tickMs: 15, drainMs: 20, presenceMs: 40, pumpMs: 10, offerAgainMs: 60_000 };

/** One computer: its own Herdr, intercom broker, state directory, and link files. */
function computer(name: "a" | "b", o: { configured?: boolean; entries?: ReturnType<typeof rosterOf> } = {}) {
	const world = new World();
	worlds.push(world);
	const keys = name === "a" ? alice : bob, home = join(root, `home-${name}`), project = join(root, `project-${name}`);
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(project, { recursive: true });
	const entries = o.entries ?? rosterOf();
	if (o.configured !== false) {
		const store = new LinkStore(join(world.stateDir, "link"));
		writeDevice(store, keys, name === "a" ? "alice-mac" : "bob-mac");
		writeTeam(store, entries, keys);
		writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ link: { relay: "http://relay.test", teams: { [TEAM_HEX]: { project, share: "status" } } } }));
	}
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	const deps = { link: { ...FAST, home, relay: clientFor(relay), alive: (r: { session: string }) => !world.gone.has(r.session) } };
	const tower = (id: string, ws = "wA") => {
		const t = world.tower(id, `${ws}:t7`, `${ws}:p7`, false, deps);
		world.herdr.pane(`${ws}:p7`).cwd = project;
		return t;
	};
	const member = (id: string, pane = "wA:p1", tab = "wA:t1") => world.agent({ id, name: id, pane, tab, deps });
	return { world, project, home, tower, member, dir: join(world.stateDir, "link"), deps };
}
const holderOf = (c: ReturnType<typeof computer>) => new LinkStore(c.dir).readHolder();
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((x) => x.text).join("");
const linkMessages = (a: Agent) => a.sent.filter((m) => m.customType === MESSAGE_TYPE);

test("a computer with no team set up has no link channel, no election, and no link files", async () => {
	const c = computer("a", { configured: false });
	const tower = c.tower("tower-a");
	await tower.start();
	await new Promise((r) => setTimeout(r, 100));
	assert.ok(!world(c).broker.registrations.some((x) => x.namespace === "straw-boss/link"));
	assert.ok(!existsSync(c.dir));
	await assert.rejects(tower.tool("tower_send", { message: "hi", device: "bob-mac" }), /not set up on this computer/);
	const list = await tower.tool("tower_list");
	assert.ok(!("remote" in (list.details as object)), "no remote section");
});
const world = (c: ReturnType<typeof computer>) => c.world;

test("one long-lived tower, the only candidate, becomes the link holder and starts the stream; its record is the tower's session", async () => {
	const a = computer("a"), tower = a.tower("tower-a");
	await tower.start();
	await until(() => holderOf(a)?.session === "tower-a", "the holder record");
	assert.equal(holderOf(a)!.tower, true);
	assert.ok(a.world.broker.registrations.some((x) => x.id === "tower-a" && x.namespace === "straw-boss/link" && !x.ownerEligible));
	await until(() => relay.opened.some((o) => o.device === alice.id), "the relay stream");
});

test("tower_send with a device goes through the holder to the relay; without a device it stays local", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	await Promise.all([ta.start(), tb.start()]);
	await until(() => holderOf(a)?.session === "tower-a" && holderOf(b)?.session === "tower-b", "both holders");
	const sent = await ta.tool("tower_send", { message: "ship it", device: "bob-mac", reply: true });
	assert.match(text(sent), /Sent to the tower of bob-mac \(/);
	assert.equal(a.world.broker.delivered.length, 0, "nothing went through the local intercom");
	await until(() => linkMessages(tb).length === 1, "the delivery in B's tower");
	const [m] = linkMessages(tb);
	assert.equal(m!.triggerTurn, true, "sent with triggerTurn");
	assert.match(m!.content, new RegExp(`^\\[straw net from=alice-mac id=link:${alice.id} role=tower workspace=Alpha remote=alice-mac device=${alice.shortId} team=project-b verified=yes kind=tower_send scope=tower to="tower · tower-b \\(tower of [^"]*\\)" reply=expected\\] ship it$`));
	// A local tower_send is unchanged.
	b.world.herdr.workspaces.push({ workspace_id: "wZ", label: "Z", tokens: {} });
	await assert.rejects(ta.tool("tower_send", { message: "x", workspace: "Nowhere" }), /No workspace matches/);
	await assert.rejects(ta.tool("tower_send", { message: "x", device: "carol" }), /No device "carol"/);
});

test("a tower that is not the holder hands its send and its list to the holder over the channel, a 180 KB message included", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [holder, other, tb] = [a.tower("tower-1", "wA"), a.tower("tower-2", "wB"), b.tower("tower-b")];
	await holder.start();
	await until(() => holderOf(a)?.session === "tower-1", "tower-1 as holder");
	await Promise.all([other.start(), tb.start()]);
	await until(() => holderOf(b)?.session === "tower-b", "B's holder");
	const big = "知識庫 ".repeat(18_000);
	const sent = await other.tool("tower_send", { message: big, device: "bob-mac" });
	assert.match(text(sent), /Sent to the tower of bob-mac/);
	await until(() => linkMessages(tb).length === 1, "the big message at B");
	assert.ok(linkMessages(tb)[0]!.content.endsWith(big), "all of it arrived");
	assert.equal(relay.stored.filter((st) => !st.ephemeral).length, 1);
	await assert.rejects(other.tool("tower_send", { message: "x".repeat(200 * 1024), device: "bob-mac" }), /at most 196608|too large/);
	const list = (await other.tool("tower_list")).details as { remote?: unknown[] };
	assert.ok(Array.isArray(list.remote), "the list came back through the holder");
	// The holder ends: a request now finds no live holder and says so at once.
	await holder.stop();
	await assert.rejects(other.tool("tower_send", { message: "hi", device: "bob-mac" }), /No link holder is running/);
});

test("a delivery waits while the tower is busy, is sent when it is idle in that same tick, one at a time, and leaves the inbox once it is in the session", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	await Promise.all([ta.start(), tb.start()]);
	await until(() => holderOf(a) && holderOf(b), "holders");
	tb.idle = false;
	await ta.tool("tower_send", { message: "first", device: "bob-mac" });
	await ta.tool("tower_send", { message: "second", device: "bob-mac" });
	await until(() => new LinkStore(b.dir).inboxIds().length === 2, "both in B's inbox");
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(linkMessages(tb).length, 0, "busy: nothing is sent");
	tb.idle = true;
	await until(() => linkMessages(tb).length === 1, "the first message");
	assert.match(linkMessages(tb)[0]!.content, /first$/);
	tb.idle = false; // the run it started is busy
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(linkMessages(tb).length, 1, "the second waits for the run to end");
	tb.idle = true;
	await tb.fire("agent_end");
	await until(() => linkMessages(tb).length === 2, "the second message");
	assert.match(linkMessages(tb)[1]!.content, /second$/);
	await until(() => new LinkStore(b.dir).inboxIds().length === 0, "the inbox emptied");
	assert.equal(tb.entries.filter((e) => e.customType === "straw-link-seen").length, 2);
});

test("a message taken before a restart is not taken again by the same session", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	await Promise.all([ta.start(), tb.start()]);
	await until(() => holderOf(a) && holderOf(b), "holders");
	await ta.tool("tower_send", { message: "once", device: "bob-mac" });
	await until(() => linkMessages(tb).length === 1, "taken");
	await until(() => new LinkStore(b.dir).inboxIds().length === 0, "confirmed");
	// The same inbox file offered again (the holder crashed between sending the offer and removing the file): the session saw it already.
	const item: InboxItem = { v: 1, id: "ab".repeat(16), team: TEAM_HEX, from: alice.id, fromLabel: "alice-mac", fromShort: alice.shortId, seq: 9, sentAt: 1, received: Date.now(), fromWorkspace: "Alpha", toWorkspace: "", replyExpected: false, text: "again" };
	const store = new LinkStore(b.dir);
	await store.withLock(() => store.putInbox(item));
	tb.entries.push({ customType: "straw-link-seen", data: { id: item.id } });
	await tb.fire("session_start", { reason: "reload" });
	await until(() => store.inboxIds().length === 0, "the seen message confirmed and removed without being sent");
	assert.equal(linkMessages(tb).length, 1);
});

test("a holder that is a plain member runs the stream and offers deliveries over the link channel; a tower takes an offer only from the session holder.json names", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const ta = a.tower("tower-a"), tb = b.tower("tower-b");
	// A session on a newer pi-straw-boss takes the record from a tower: the holder here is not a tower.
	const member = b.world.agent({ id: "member-b", name: "member-b", pane: "wA:p1", tab: "wA:t1", deps: { ...b.deps, version: "9.9.9" } });
	await Promise.all([ta.start(), tb.start()]);
	await until(() => holderOf(a)?.session === "tower-a", "A's holder");
	await member.start();
	await until(() => holderOf(b)?.session === "member-b", "the newer member as holder", 4000);
	assert.equal(holderOf(b)!.tower, false);
	await ta.tool("tower_send", { message: "through the member", device: "bob-mac" });
	await until(() => linkMessages(tb).length === 1, "the tower got it through the member's offer");
	assert.match(linkMessages(tb)[0]!.content, /through the member$/);
	assert.equal(linkMessages(member).length, 0, "the member is no tower: it takes nothing into its session");
	await until(() => new LinkStore(b.dir).inboxIds().length === 0, "the tower confirmed it to the holder");

	// A session that is not the holder offers the tower a message that is in the inbox: ignored.
	const store = new LinkStore(b.dir);
	const item: InboxItem = { v: 1, id: "cd".repeat(16), team: TEAM_HEX, from: alice.id, fromLabel: "alice-mac", fromShort: alice.shortId, seq: 9, sentAt: 1, received: Date.now(), fromWorkspace: "Alpha", toWorkspace: "", replyExpected: false, text: "forged" };
	b.world.herdr.panes = b.world.herdr.panes.filter((p) => p.pane_id !== "wA:p7"); // no tower pane in the project: the holder offers nothing
	await store.withLock(() => store.putInbox(item));
	const intruder = { id: "intruder", name: "intruder", pane: "wA:p9", regs: new Map<string, Registration>() };
	let chan!: { publish(payload: unknown, options?: { audience?: string }): void };
	b.world.broker.connect(intruder);
	b.world.broker.register(intruder, { namespace: "straw-boss/link", ownerEligible: false, onReady: (c) => (chan = c as typeof chan), onEvent: () => {} });
	chan.publish({ version: 1, type: "offer", to: "tower-b", id: item.id }, { audience: "capable" });
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(linkMessages(tb).length, 1, "an offer from a session the record does not name is not taken");
	assert.equal(store.readInbox(item.id)?.text, "forged", "and the message stays where it was");
});

test("when the holder's session ends, the next candidate takes the record within a few ticks and the stream continues from the team file", async () => {
	const b = computer("b"), first = b.tower("tower-1", "wA"), second = b.tower("tower-2", "wB");
	await first.start();
	await until(() => holderOf(b)?.session === "tower-1", "the first holder");
	await second.start();
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(holderOf(b)!.session, "tower-1", "a live holder of equal rank is left alone");
	const opened = relay.opened.length;
	await first.stop();
	await until(() => holderOf(b)?.session === "tower-2", "the second takes over", 4000);
	await until(() => relay.opened.length > opened, "the new holder's stream");
	assert.equal(relay.opened.at(-1)!.device, bob.id);
});

test("tower_list adds the teammates' towers from their presence: label and id, online, workspaces and tabs with restricted text; share presence sends no workspaces", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	a.world.herdr.pane("wA:p7").agent_status = "idle";
	await Promise.all([ta.start(), tb.start()]);
	await until(async () => {
		const list = (await tb.tool("tower_list")).details as { remote?: { online: boolean; workspace: string | null }[] };
		return list.remote?.[0]?.online && list.remote[0].workspace === "Alpha";
	}, "A's presence in B's tower_list", 4000);
	const list = (await tb.tool("tower_list")).details as { towers: unknown[]; remote: ReturnType<typeof remoteTowers> };
	assert.equal(list.towers.length >= 1, true, "the local list is still there");
	assert.deepEqual(list.remote.map((r) => [r.remote, r.team, r.device.label, r.device.id, r.device.shortId, r.online, r.workspace, r.tower]), [[true, "project-b", "alice-mac", alice.id, alice.shortId, true, "Alpha", "idle"]]);
});

test("remoteTowers cuts what a presence says to the label character set, and lists a device whose presence names no workspace", () => {
	const rows = remoteTowers([{ team: "t", name: "moldplan", devices: [
		{ id: bob.id, short: bob.shortId, label: "bob-mac", online: true, ageMs: 4200, roster: 1, workspaces: [{ label: 'evil"]\nkind=x', tower: "idle", tabs: [{ label: "知識庫", state: "working" }] }] },
		{ id: alice.id, short: alice.shortId, label: "alice-mac", online: false, ageMs: null, roster: null, workspaces: [] },
	] }]);
	assert.equal(rows[0]!.workspace, "evil___kind_x");
	assert.deepEqual(rows[0]!.tabs, [{ label: "___", state: "working" }]);
	assert.deepEqual([rows[1]!.workspace, rows[1]!.online, rows[1]!.seenSecondsAgo], [null, false, null]);
});

test("SLH-F006: a teammate's presence too large for an answer does not take the holder's process down; the tower that asked gets a short error at once", async () => {
	const a = computer("a"), holder = a.tower("tower-1", "wA"), other = a.tower("tower-2", "wB");
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => void rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		await holder.start();
		await until(() => holderOf(a)?.session === "tower-1", "tower-1 as holder");
		await other.start();
		await until(() => relay.opened.some((o) => o.device === alice.id), "the holder's stream");
		const tabs = Array.from({ length: 64 }, (_, i) => ({ label: `a tab with a rather long label ${i} `.padEnd(100, "x"), state: "working".padEnd(60, "y") }));
		const workspaces = Array.from({ length: 32 }, (_, i) => ({ label: `workspace ${i}`, tower: "idle", tabs }));
		const state = stateOf(rosterOf(), bob);
		const big = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: state.head, from: bob, seq: 0, ts: Date.now(), kind: "presence", to: [], plaintext: encodePlaintext("presence", { label: "bob-mac", headSeq: state.head.seq, headHash: state.head.hash, workspaces }) });
		await new RelayClient({ url: "http://relay.test", device: bob, fetch: relay.fetch }).postEnvelope(TEAM, big);
		await until(async () => ((await holder.tool("tower_list")).details as { remote?: { workspace: string | null }[] }).remote?.some((r) => r.workspace !== null), "the big presence at the holder");
		const started = Date.now();
		const list = (await other.tool("tower_list")).details as { remote?: unknown[] };
		assert.ok(Date.now() - started < 5000, "answered, not timed out");
		assert.deepEqual(list.remote ?? [], [], "the list is empty rather than a crash");
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(rejections, [], "no unhandled rejection");
		assert.equal(holderOf(a)?.session, "tower-1");
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

test("SLH-F002: a session that cannot start the link holder tells the boss once, and keeps trying", async () => {
	const a = computer("a"), tower = a.tower("tower-a");
	writeFileSync(join(a.dir, "device.json"), "{ not json");
	await tower.start();
	await until(() => tower.notices.some((n) => /could not start the link holder: device\.json is damaged/.test(n.text)), "the notice");
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(tower.notices.filter((n) => /could not start the link holder/.test(n.text)).length, 1, "told once");
	assert.equal(holderOf(a), undefined, "no record kept for a holder that does not run");
});

test("SLH-F003/F015: a message a busy tower holds is not sent once its inbox file is gone (another tower took it, or its sender left the team), and not by a session that stopped being a tower", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	await Promise.all([ta.start(), tb.start()]);
	await until(() => holderOf(a) && holderOf(b), "holders");
	tb.idle = false;
	await ta.tool("tower_send", { message: "taken elsewhere", device: "bob-mac" });
	const store = new LinkStore(b.dir);
	await until(() => store.inboxIds().length === 1, "in B's inbox");
	await new Promise((r) => setTimeout(r, 120));
	const [id] = store.inboxIds();
	await store.withLock(() => store.removeInbox(id!));
	tb.idle = true;
	await tb.fire("agent_end");
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(linkMessages(tb).length, 0, "the held copy is not sent after the file is gone");
	assert.equal(tb.entries.filter((e) => e.customType === "straw-link-seen").length, 0);
});

test("SLH-F013: a tower waits for the holder longer than the holder's worst case for a send, so it never gives up on a message that went out", () => {
	assert.ok(ASK_MS > LOCK_WAIT_MS + POST_WAIT_MS + 15_000, `${ASK_MS} against ${LOCK_WAIT_MS} + ${POST_WAIT_MS} + a reading of Herdr`);
});

test("SLH-F014: a message already in the session as a straw-link message (the seen entry was lost in a crash, or sits on another branch) is not taken again", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	await Promise.all([ta.start(), tb.start()]);
	await until(() => holderOf(a) && holderOf(b), "holders");
	const item: InboxItem = { v: 1, id: "ef".repeat(16), team: TEAM_HEX, from: alice.id, fromLabel: "alice-mac", fromShort: alice.shortId, seq: 9, sentAt: 1, received: Date.now(), fromWorkspace: "Alpha", toWorkspace: "", replyExpected: false, text: "crashed in between" };
	const store = new LinkStore(b.dir);
	await store.withLock(() => store.putInbox(item));
	tb.transcript.push({ type: "custom_message", customType: MESSAGE_TYPE, details: { id: item.id } });
	await tb.fire("session_start", { reason: "resume" });
	await until(() => store.inboxIds().length === 0, "the message in the transcript confirmed and removed without being sent");
	assert.equal(linkMessages(tb).length, 0);
});

test("R5-F003: the GUI's summary read gives up on a holder that stops answering after its own short wait and serves the last reading", async () => {
	const a = computer("a");
	let link: Link | undefined;
	const deps = { link: { ...a.deps.link, summaryMs: 150, created: (l: Link) => void (link = l) } };
	const holder = a.tower("tower-1", "wA");
	const other = a.world.tower("tower-2", "wB:t7", "wB:p7", false, deps);
	a.world.herdr.pane("wB:p7").cwd = a.project;
	writeFileSync(join(a.world.stateDir, "gui.json"), JSON.stringify({ ownerSession: "tower-2" }));
	await holder.start();
	await until(() => holderOf(a)?.session === "tower-1", "tower-1 as holder");
	await other.start();
	const first = await link!.summary();
	assert.ok(first, "the holder answers");
	const broker = a.world.broker as unknown as { deliver: (id: string, ...rest: unknown[]) => void };
	const deliver = broker.deliver.bind(broker);
	broker.deliver = (id, ...rest) => (id === "tower-1" ? undefined : deliver(id, ...rest)); // the holder is alive but hears nothing
	const t0 = Date.now();
	assert.deepEqual(await link!.summary(), first, "the last reading");
	assert.ok(Date.now() - t0 < ASK_MS / 4, `gave up after ${Date.now() - t0} ms`);
});
