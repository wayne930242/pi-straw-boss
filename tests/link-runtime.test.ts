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
import { chunks, Reassembler } from "../src/link/wire.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, clientFor, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { linkServer } from "./link/service-world.ts";
import { Agent, type Registration, until, World } from "./fakes.ts";
import { teamKey, TEAM } from "./link/scenario.ts";

// Straw Link between pi sessions and the sb server (docs/specs/2026-10-26-sb-backend.md, B3): the link holder runs in the server (src/link/service.ts), a tower asks it
// for tower_send with `device`, tower_list's remote towers, and the rest, and takes the inbox messages it offers on the `straw-boss/link` channel when idle, entering its
// session as a `straw-link` message sent with triggerTurn.

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

/** One computer: its own Herdr, intercom broker, state directory, and link files, and the link holder of its sb server (`start: false` leaves the server's first look to the test). */
function computer(name: "a" | "b", o: { configured?: boolean; entries?: ReturnType<typeof rosterOf>; start?: boolean } = {}) {
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
		writeFileSync(join(world.stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: false }, link: { relay: "http://relay.test", teams: { [TEAM_HEX]: { project, share: "status" } } } }));
	}
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	const service = { ...FAST, home, relay: clientFor(relay), alive: (r: { session: string }) => !world.gone.has(r.session) };
	const server = linkServer(world, { deps: service, start: o.start });
	const deps = { link: { ...service, ask: server.ask } };
	const tower = (id: string, ws = "wA") => {
		const t = world.tower(id, `${ws}:t7`, `${ws}:p7`, false, deps);
		world.herdr.pane(`${ws}:p7`).cwd = project;
		return t;
	};
	const member = (id: string, pane = "wA:p1", tab = "wA:t1") => world.agent({ id, name: id, pane, tab, deps });
	return { world, project, home, tower, member, server, service, dir: join(world.stateDir, "link"), deps };
}
const holderOf = (c: ReturnType<typeof computer>) => new LinkStore(c.dir).readHolder();
/** The server's holder has started its streams: a request is answered. */
const holding = (c: ReturnType<typeof computer>) => until(() => c.server.service.status().active, "the server's link holder");
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((x) => x.text).join("");
const linkMessages = (a: Agent) => a.sent.filter((m) => m.customType === MESSAGE_TYPE);

test("a computer with no team set up has no link channel, no election, and no link files", async () => {
	const c = computer("a", { configured: false });
	const tower = c.tower("tower-a");
	await tower.start();
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(c.server.service.status().inUse, false);
	assert.ok(!world(c).broker.registrations.some((x) => x.namespace === "straw-boss/link"));
	assert.ok(!existsSync(c.dir));
	await assert.rejects(tower.tool("tower_send", { message: "hi", device: "bob-mac" }), /not set up on this computer/);
	const list = await tower.tool("tower_list");
	assert.ok(!("remote" in (list.details as object)), "no remote section");
});
const world = (c: ReturnType<typeof computer>) => c.world;

test("the sb server is the link holder: holder.json names it, the stream starts, and a tower registers the channel for offers only", async () => {
	const a = computer("a"), tower = a.tower("tower-a");
	await tower.start();
	await until(() => holderOf(a)?.session === a.server.id, "the holder record");
	assert.equal(holderOf(a)!.tower, true);
	assert.equal(holderOf(a)!.version, "0.46.0");
	assert.ok(a.world.broker.registrations.some((x) => x.id === "tower-a" && x.namespace === "straw-boss/link" && !x.ownerEligible), "the tower takes offers on the channel");
	assert.ok(a.world.broker.registrations.some((x) => x.id === a.server.id && x.namespace === "straw-boss/link" && !x.ownerEligible), "so does the server, for the previous build's requests");
	await until(() => relay.opened.some((o) => o.device === alice.id), "the relay stream");
	await holding(a);
	assert.deepEqual(a.server.service.status().session, a.server.id);
});

test("sessions are no candidates: with the server down a tower and a member of this build leave the record alone, and the server takes it when it is back", async () => {
	const a = computer("a", { start: false }), tower = a.tower("tower-a");
	const member = a.member("member-a");
	await Promise.all([tower.start(), member.start()]);
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(holderOf(a), undefined, "nobody takes the record");
	assert.equal(relay.opened.length, 0, "and no stream is open");
	await assert.rejects(tower.tool("tower_send", { message: "hi", device: "bob-mac" }), /No link holder is running/);
	await a.server.service.start();
	await until(() => holderOf(a)?.session === a.server.id, "the server as holder");
	await holding(a);
	assert.match(text(await tower.tool("tower_send", { message: "now", device: "bob-mac" })), /Sent to the tower of bob-mac/);
});

test("tower_send with a device goes through the holder to the relay; without a device it stays local", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	await Promise.all([ta.start(), tb.start()]);
	await Promise.all([holding(a), holding(b)]);
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

test("a tower hands its send and its list to the server's holder, a 180 KB message included, and finds no holder once the server has gone", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [tower, tb] = [a.tower("tower-1", "wA"), b.tower("tower-b")];
	await Promise.all([tower.start(), tb.start()]);
	await Promise.all([holding(a), holding(b)]);
	const big = "知識庫 ".repeat(18_000);
	const sent = await tower.tool("tower_send", { message: big, device: "bob-mac" });
	assert.match(text(sent), /Sent to the tower of bob-mac/);
	await until(() => linkMessages(tb).length === 1, "the big message at B");
	assert.ok(linkMessages(tb)[0]!.content.endsWith(big), "all of it arrived");
	assert.equal(relay.stored.filter((st) => !st.ephemeral).length, 1);
	await assert.rejects(tower.tool("tower_send", { message: "x".repeat(200 * 1024), device: "bob-mac" }), /at most 196608|too large/);
	const list = (await tower.tool("tower_list")).details as { remote?: unknown[] };
	assert.ok(Array.isArray(list.remote), "the list came back through the holder");
	// The server ends: a request now finds no live holder and says so at once.
	await a.server.stop();
	await assert.rejects(tower.tool("tower_send", { message: "hi", device: "bob-mac" }), /No link holder is running/);
});

test("a delivery waits while the tower is busy, is sent when it is idle in that same tick, one at a time, and leaves the inbox once it is in the session", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	await Promise.all([ta.start(), tb.start()]);
	await Promise.all([holding(a), holding(b)]);
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
	await Promise.all([holding(a), holding(b)]);
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

test("a tower takes an offer only from the session holder.json names, and a member of this build is no holder", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const ta = a.tower("tower-a"), tb = b.tower("tower-b");
	// A member of this build is no holder, whatever its version: it takes nothing and offers nothing.
	const member = b.world.agent({ id: "member-b", name: "member-b", pane: "wA:p1", tab: "wA:t1", deps: { ...b.deps, version: "9.9.9" } });
	await Promise.all([ta.start(), tb.start(), member.start()]);
	await Promise.all([holding(a), holding(b)]);
	assert.equal(holderOf(b)!.session, b.server.id);
	await ta.tool("tower_send", { message: "through the server", device: "bob-mac" });
	await until(() => linkMessages(tb).length === 1, "the tower got the server's offer");
	assert.match(linkMessages(tb)[0]!.content, /through the server$/);
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

test("the channel is kept for the previous build: a request of a session of that build is answered in chunks, and its `taken` removes the message from the inbox", async () => {
	const b = computer("b");
	await holding(b);
	const old = { id: "old-build-tower", name: "old build", pane: "wA:p9", regs: new Map<string, Registration>() };
	const got = new Reassembler();
	let answer: { ok: boolean; teams?: unknown[] } | undefined, chan!: { publish(payload: unknown, options?: { audience?: string }): void };
	b.world.broker.connect(old);
	b.world.broker.register(old, {
		namespace: "straw-boss/link", ownerEligible: false, onReady: (c) => (chan = c as typeof chan),
		onEvent: (e) => {
			const p = (e as { payload?: { to?: string; type?: string } }).payload;
			if (p?.to === old.id && p.type === "res") answer ??= got.push("res", p, Date.now())?.body as typeof answer;
		},
	});
	for (const c of chunks("req", b.server.id, "r1", { op: "list" })) chan.publish({ ...c }, { audience: "capable" });
	await until(() => answer, "the server's answer on the channel");
	assert.equal(answer!.ok, true);
	assert.equal(answer!.teams!.length, 1);
	// Its `taken`: the holder takes the message off the inbox for the tower the old session says has it.
	const item: InboxItem = { v: 1, id: "ab".repeat(16), team: TEAM_HEX, from: alice.id, fromLabel: "alice-mac", fromShort: alice.shortId, seq: 9, sentAt: 1, received: Date.now(), fromWorkspace: "Alpha", toWorkspace: "", replyExpected: false, text: "old tower has it" };
	const store = new LinkStore(b.dir);
	b.world.herdr.panes = b.world.herdr.panes.filter((p) => p.pane_id !== "wA:p7"); // no tower of this build to offer it to
	await store.withLock(() => store.putInbox(item));
	chan.publish({ version: 1, type: "taken", to: b.server.id, id: item.id }, { audience: "capable" });
	await until(() => store.inboxIds().length === 0, "the inbox emptied by the previous build's `taken`");
});

test("a holder of the previous build that is alive is displaced by the server (a newer build), and a record of a dead one is taken at once", async () => {
	const b = computer("b", { start: false });
	const store = new LinkStore(b.dir);
	await store.withLock(() => store.writeHolder({ session: "old-session", version: "0.45.0", pid: process.pid, tower: false, since: Date.now() }));
	await b.server.service.start();
	await until(() => holderOf(b)?.session === b.server.id, "the server over a live holder of the previous build", 3000);
	const dead = computer("a", { start: false });
	const deadStore = new LinkStore(dead.dir);
	await deadStore.withLock(() => deadStore.writeHolder({ session: "gone-tower", version: "0.45.0", pid: 999_999, tower: true, since: Date.now() }));
	dead.world.gone.add("gone-tower");
	await dead.server.service.start();
	await until(() => holderOf(dead)?.session === dead.server.id, "the server over a record whose process is gone");
});

test("when the server ends, its record goes and the next server takes it within a few ticks: the stream continues from the team file", async () => {
	const b = computer("b"), tower = b.tower("tower-1", "wA");
	await tower.start();
	await until(() => holderOf(b)?.session === b.server.id, "the first holder");
	const second = linkServer(b.world, { id: "sb-server-2", deps: b.service });
	await new Promise((r) => setTimeout(r, 100));
	assert.equal(holderOf(b)!.session, b.server.id, "a live holder of equal rank is left alone");
	const opened = relay.opened.length;
	await b.server.stop();
	assert.equal(holderOf(b), undefined, "the server took its record with it");
	await until(() => holderOf(b)?.session === second.id, "the second takes over", 4000);
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

test("SLH-F006: a teammate's presence too large for the channel's answer does not take the server down: a session gets the whole list on the socket, the previous build a short error at once", async () => {
	const a = computer("a"), holder = a.tower("tower-1", "wA"), other = a.tower("tower-2", "wB");
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => void rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	try {
		await holder.start();
		await holding(a);
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
		assert.ok((list.remote ?? []).length >= 32, "the control socket has no size limit: the whole list comes back");
		// A session of the previous build asks on the channel, whose answer is bounded: it gets the short error, and the server goes on.
		const old = { id: "old-build-tower", name: "old build", pane: "wA:p9", regs: new Map<string, Registration>() };
		const got = new Reassembler();
		let answer: { ok: boolean; error?: string } | undefined, chan!: { publish(payload: unknown, options?: { audience?: string }): void };
		a.world.broker.connect(old);
		a.world.broker.register(old, { namespace: "straw-boss/link", ownerEligible: false, onReady: (c) => (chan = c as typeof chan), onEvent: (e) => {
			const p = (e as { payload?: { to?: string; type?: string } }).payload;
			if (p?.to === old.id && p.type === "res") answer ??= got.push("res", p, Date.now())?.body as typeof answer;
		} });
		for (const c of chunks("req", a.server.id, "big", { op: "list" })) chan.publish({ ...c }, { audience: "capable" });
		await until(() => answer, "the previous build's answer");
		assert.equal(answer!.ok, false);
		assert.match(answer!.error!, /too large/);
		await new Promise((r) => setTimeout(r, 50));
		assert.deepEqual(rejections, [], "no unhandled rejection");
		assert.equal(holderOf(a)?.session, a.server.id);
	} finally {
		process.off("unhandledRejection", onRejection);
	}
});

test("SLH-F002: a server that cannot start the link holder tells the boss once, and keeps trying", async () => {
	const a = computer("a", { start: false }), tower = a.tower("tower-a");
	writeFileSync(join(a.dir, "device.json"), "{ not json");
	void a.server.service.start();
	await tower.start();
	await until(() => a.server.notices.some((n) => /could not start: device\.json is damaged/.test(n.text)), "the notice");
	await new Promise((r) => setTimeout(r, 120));
	assert.equal(a.server.notices.filter((n) => /could not start/.test(n.text)).length, 1, "told once");
	assert.equal(a.server.service.status().notices.length, 1, "and kept for status");
	assert.equal(holderOf(a), undefined, "no record kept for a holder that does not run");
});

test("SLH-F003/F015: a message a busy tower holds is not sent once its inbox file is gone (another tower took it, or its sender left the team), and not by a session that stopped being a tower", async () => {
	const [a, b] = [computer("a"), computer("b")];
	const [ta, tb] = [a.tower("tower-a"), b.tower("tower-b")];
	await Promise.all([ta.start(), tb.start()]);
	await Promise.all([holding(a), holding(b)]);
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
	await Promise.all([holding(a), holding(b)]);
	const item: InboxItem = { v: 1, id: "ef".repeat(16), team: TEAM_HEX, from: alice.id, fromLabel: "alice-mac", fromShort: alice.shortId, seq: 9, sentAt: 1, received: Date.now(), fromWorkspace: "Alpha", toWorkspace: "", replyExpected: false, text: "crashed in between" };
	const store = new LinkStore(b.dir);
	await store.withLock(() => store.putInbox(item));
	tb.transcript.push({ type: "custom_message", customType: MESSAGE_TYPE, details: { id: item.id } });
	await tb.fire("session_start", { reason: "resume" });
	await until(() => store.inboxIds().length === 0, "the message in the transcript confirmed and removed without being sent");
	assert.equal(linkMessages(tb).length, 0);
});

test("R5-F003: the GUI's summary read gives up on a holder that stops answering after its own short wait and serves the last reading", async () => {
	const r = await summaryRig(60_000);
	r.deaf();
	const t0 = Date.now();
	assert.deepEqual(await r.link.summary(), r.first, "the last reading");
	assert.ok(Date.now() - t0 < ASK_MS / 4, `gave up after ${Date.now() - t0} ms`);
});

/** A computer whose tower-2 is the GUI's host, with `summaryKeepMs`, and a way to make the holder stop answering. */
async function summaryRig(keepMs: number) {
	const a = computer("a");
	let link: Link | undefined, deaf = false;
	const deps = { link: { ...a.deps.link, summaryMs: 150, summaryKeepMs: keepMs, ask: (op: Record<string, unknown>, from: string) => (deaf ? new Promise<never>(() => undefined) : a.server.ask(op, from)), created: (l: Link) => void (link = l) } };
	const other = a.world.tower("tower-2", "wB:t7", "wB:p7", false, deps);
	a.world.herdr.pane("wB:p7").cwd = a.project;
	writeFileSync(join(a.world.stateDir, "gui.json"), JSON.stringify({ ownerSession: "tower-2" }));
	await holding(a);
	await other.start();
	const first = await link!.summary();
	assert.ok(first, "the holder answers");
	return { a, link: link!, first, deaf: () => void (deaf = true) };
}

test("RC-F003: the last summary stands in for a slow holder only while it is fresh; after that, and when the holder is gone, the GUI shows nothing", async () => {
	const slow = await summaryRig(1500); // the fresh read waits 150 ms for the deaf holder: the keep time leaves a loaded machine plenty of room
	slow.deaf();
	assert.deepEqual(await slow.link.summary(), slow.first, "slow and fresh: the last reading");
	await new Promise((r) => setTimeout(r, 1400)); // with the 150 ms waits on both sides of it, the reading is older than 1.5 s
	assert.equal(await slow.link.summary(), undefined, "slow and old: nothing");
	const gone = await summaryRig(60_000);
	assert.deepEqual(await gone.link.summary(), gone.first);
	await gone.a.server.stop();
	assert.equal(holderOf(gone.a), undefined, "no holder record");
	assert.equal(await gone.link.summary(), undefined, "NO_HOLDER is not covered by the last reading");
});
