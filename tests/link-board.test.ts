import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { removeEntry as removeBoardEntry, wireId, writeEntry } from "../src/board.ts";
import type { LinkConfig, TeamPolicy } from "../src/link/config.ts";
import { buildEnvelope } from "../src/link/envelope.ts";
import { type AllyBoard, LinkHolder } from "../src/link/holder.ts";
import { type Board, encodePlaintext, KINDS } from "../src/link/kinds.ts";
import { RelayClient } from "../src/link/relay.ts";
import { addEntry, createEntry, encodeEntry, removeEntry, replayRoster, type RosterEntry } from "../src/link/roster.ts";
import type { NetView } from "../src/link/routing.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { MAX_BODY_BYTES, chunks } from "../src/link/wire.ts";
import { alice, bob, carol, clientFor, netOf, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, teamKey, TEAM } from "./link/scenario.ts";

// The holder's half of the work board (docs/specs/2026-10-25-straw-link.md, Work board: Sharing with allies, Holding allies' boards).

let root = "";
let relay: FakeRelay;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-board-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});
const MIN = 60_000;

interface Main { id: string; name?: string; cwd: string; tab?: string }
/** A net with a tower and the given mains (each in its own tab of workspace `label-a`). */
function netWith(project: string, mains: Main[]): NetView {
	const net = netOf([["tower-a", "w-a", "label-a", project]]);
	mains.forEach((m, i) => {
		net.panes.push({ pane_id: `m${i}`, tab_id: `w-a:t${i + 1}`, workspace_id: "w-a", cwd: m.cwd, agent_status: "working", tokens: { sb_role: "main" } });
		net.sessions.push({ id: m.id, ...(m.name !== undefined ? { name: m.name } : {}), herdrLocation: { status: "current", workspace: { id: "w-a", label: "label-a" }, tab: { id: `w-a:t${i + 1}`, label: m.tab ?? `tab ${i + 1}` }, paneId: `m${i}` } });
	});
	return net;
}

type Teams = Map<string, TeamPolicy>;
interface Rig {
	name: "a" | "b";
	dir: string;
	boardDir: string;
	project: string;
	other: string;
	store: LinkStore;
	holder: LinkHolder;
	net: NetView;
	netDelayMs: number;
	skew: number;
	share: "presence" | "status";
	notices: string[];
	offers: string[];
}
function rig(name: "a" | "b", o: { entries?: RosterEntry[]; teams?: (r: Rig) => Teams } = {}): Rig {
	const keys = name === "a" ? alice : bob, entries = o.entries ?? rosterOf();
	const dir = join(root, name, "link"), project = join(root, `${name}-project`), other = join(root, `${name}-elsewhere`);
	mkdirSync(project, { recursive: true });
	mkdirSync(other, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, name === "a" ? "alice-mac" : "bob-mac");
	writeTeam(store, entries, keys);
	const r = { name, dir, boardDir: join(root, name, "board"), project, other, store, netDelayMs: 0, skew: 0, share: "status", notices: [], offers: [], net: netWith(project, []) } as unknown as Rig;
	const config = (): LinkConfig => ({ teams: o.teams?.(r) ?? new Map([[TEAM_HEX, { project, share: r.share, name: "moldplan" }]]), trust: new Map(), problems: [] });
	r.holder = new LinkHolder({
		store, isHolder: () => true, config, net: async () => (r.netDelayMs ? await new Promise((done) => setTimeout(done, r.netDelayMs)) : undefined, r.net), relay: clientFor(relay), offer: (tower) => void r.offers.push(tower.id), notify: (t) => void r.notices.push(t),
		boardDir: r.boardDir, now: () => Date.now() + r.skew, backoff: () => 5, drainMs: 20, presenceMs: 40, offerAgainMs: 60_000,
	});
	stops.push(() => r.holder.stop());
	relay.addTeam(TEAM, [alice.id, bob.id, ...(entries.length > 2 ? [carol.id] : [])], entries);
	return r;
}
const boardsFrom = (device: string) => relay.stored.filter((s) => s.envelope.header.kind === "board" && s.envelope.header.from === device);
const mine = () => boardsFrom(alice.id);
/** The board B holds of a device, as a tower would read it. */
function held(b: Rig, device = alice.id, only?: string[]): AllyBoard | undefined {
	const answer = b.holder.boards(only ? { only } : {});
	assert.ok(answer.ok);
	return answer.boards.find((x) => x.device.id === device);
}
const events = (r: Rig): Record<string, unknown>[] => {
	try {
		return readFileSync(join(r.dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return []; // nothing was logged yet
	}
};
const idOf = (session: string) => wireId(alice.id, session);

test("the entries a team gets: live mains whose pane cwd is inside the team's project, with the entries they wrote; a main outside the project stays home, and no session id leaves", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "main-in", name: "api main", cwd: a.project, tab: "api" }, { id: "main-out", name: "other main", cwd: a.other }, { id: "main-bare", name: "no entry", cwd: a.project, tab: "docs" }]);
	writeEntry(a.boardDir, "main-in", { now: "MP-1 export: CSV writer", items: [{ t: "schema", done: true }, { t: "writer", done: false }] }, Date.now() - 40_000);
	writeEntry(a.boardDir, "main-out", { now: "private work", items: [] }, Date.now());
	writeEntry(a.boardDir, "gone-session", { now: "ended work", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => held(b)?.entries.length === 2, 3000, "A's board at B");
	const board = held(b)!;
	assert.deepEqual(board.entries.map((e) => [e.id, e.workspace, e.tab, e.main, e.now]).sort(), [
		[idOf("main-bare"), "label-a", "docs", "no entry", ""],
		[idOf("main-in"), "label-a", "api", "api main", "MP-1 export: CSV writer"],
	].sort());
	assert.deepEqual(board.entries.find((e) => e.main === "api main")!.items, [{ t: "schema", done: true }, { t: "writer", done: false }]);
	assert.ok(board.entries.find((e) => e.main === "api main")!.updatedSecondsAgo! >= 40);
	assert.ok(board.entries.every((e) => !e.id.includes("main-")), "the entry id is a hash of the device and session, never the session id");
	assert.equal(board.origin, "remote");
	assert.deepEqual([board.device.label, board.device.id, board.device.short], ["alice-mac", alice.id, alice.shortId], "the label is the roster's");
	assert.equal(board.team, "moldplan");
	assert.equal(mine().length, 1, "one board went out");
});

test("share presence sends no board; a team set to presence after a board went out gets one empty board so its allies' copy clears", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.share = "presence";
	a.net = netWith(a.project, [{ id: "m1", name: "api main", cwd: a.project }]);
	writeEntry(a.boardDir, "m1", { now: "work", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => b.holder.list()[0]?.devices[0]?.online, 3000, "A's presence");
	a.skew += 20_000;
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(mine().length, 1, "with presence a team gets no entries: only the one empty board every start sends");
	assert.deepEqual(held(b)?.entries, []);
	a.share = "status";
	a.skew += 20_000;
	await until(() => held(b)?.entries.length === 1, 3000, "the board once the team is at status");
	a.share = "presence";
	a.skew += 20_000;
	await until(() => held(b)?.entries.length === 0, 3000, "an empty board after the switch to presence");
	assert.equal(mine().length, 3, "the empty one at the start, the board, then the empty one");
});

test("send on change at most once per 15 seconds, a change inside the window goes out at its end, once at a stream start, and hourly unchanged", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "m1", name: "api main", cwd: a.project }]);
	writeEntry(a.boardDir, "m1", { now: "step one", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => held(b)?.entries[0]?.now === "step one", 3000, "the first board");
	assert.equal(mine().length, 1, "once at the start");
	writeEntry(a.boardDir, "m1", { now: "step two", items: [] }, Date.now());
	a.skew += 5_000;
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(mine().length, 1, "a change inside the 15 second window waits");
	a.skew += 12_000;
	await until(() => held(b)?.entries[0]?.now === "step two", 3000, "the change at the end of the window");
	assert.equal(mine().length, 2);
	// Unchanged: nothing for an hour, then one more.
	a.skew += 30 * MIN;
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(mine().length, 2, "unchanged for half an hour sends nothing");
	a.skew += 31 * MIN;
	await until(() => mine().length === 3, 3000, "the hourly resend");
	// A stream that restarts is a reason to send once more (after the spacing).
	relay.dropStreams();
	await until(() => relay.opened.filter((o) => o.device === alice.id).length >= 2, 3000, "A's stream to reopen");
	a.skew += 16_000;
	await until(() => mine().length === 4, 3000, "a board after the stream restarted");
	// The ts rises with every board, so an equal clock reading never loses one to the receiver's guard.
	const ts = mine().map((s) => s.envelope.header.ts);
	assert.ok(ts.every((t, i) => i === 0 || t > ts[i - 1]!), JSON.stringify(ts));
});

test("an empty board goes out when the last bound entry goes, and clears the allies' copy", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "m1", name: "api main", cwd: a.project }]);
	writeEntry(a.boardDir, "m1", { now: "work", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => held(b)?.entries.length === 1, 3000, "the board");
	a.net = netWith(a.project, []);
	removeBoardEntry(a.boardDir, "m1");
	a.skew += 20_000;
	await until(() => held(b)?.entries.length === 0, 3000, "the empty board");
});

test("an older ts is ignored, so an older board never replaces a newer one", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "m1", name: "api main", cwd: a.project }]);
	writeEntry(a.boardDir, "m1", { now: "newest", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => held(b)?.entries[0]?.now === "newest", 3000, "the board");
	const head = stateOf(rosterOf(), alice).head;
	const forged = (ts: number, now: string) => buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from: alice, seq: 0, ts, kind: "board", to: [], plaintext: encodePlaintext("board", { entries: [{ id: "0123456789abcdef", workspace: "w", tab: "t", name: "n", now, updated: ts, items: [] }] }) });
	const client = new RelayClient({ url: "http://relay.test", device: alice, fetch: relay.fetch });
	await client.postEnvelope(TEAM, forged(Date.now() - 60_000, "older"));
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(held(b)!.entries[0]!.now, "newest");
	assert.ok(events(b).some((e) => e.event === "drop" && e.reason === "stale-ephemeral" && e.kind === "board"));
	await client.postEnvelope(TEAM, forged(Date.now() + 5_000, "newer"));
	await until(() => held(b)?.entries[0]?.now === "newer", 3000, "a newer board");
});

test("a device removed from the roster loses its board at once", async () => {
	const entries = rosterOf(["bob", "carol"]);
	const b = rig("b", { entries });
	await b.holder.start();
	const head = stateOf(entries, alice).head;
	const board = (now: string): Board => ({ entries: [{ id: "0123456789abcdef", workspace: "w", tab: "t", name: "n", now, updated: Date.now(), items: [] }] });
	await new RelayClient({ url: "http://relay.test", device: carol, fetch: relay.fetch }).postEnvelope(TEAM, buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from: carol, seq: 0, ts: Date.now(), kind: "board", to: [], plaintext: encodePlaintext("board", board("carol's work")) }));
	await until(() => held(b, carol.id)?.entries.length === 1, 3000, "carol's board");
	assert.equal(held(b, carol.id)!.device.label, LABELS.carol);
	relay.pushRoster(TEAM, removeEntry({ state: stateOf(entries, alice), signer: alice, subjectId: carol.id, newKey: teamKey(2) }));
	await until(() => JSON.parse(readFileSync(join(b.dir, "teams", `${TEAM_HEX}.json`), "utf8")).entries.length === 4, 3000, "the removal");
	assert.equal(held(b, carol.id), undefined);
});

test("a board from a device offline for more than 2 hours, or older than 7 days, is not shown", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "m1", name: "api main", cwd: a.project }]);
	writeEntry(a.boardDir, "m1", { now: "work", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => held(b)?.entries.length === 1, 3000, "the board");
	assert.equal(held(b)!.online, true);
	await a.holder.stop();
	b.skew += 100_000;
	assert.deepEqual([held(b)?.online, held(b)?.entries.length], [false, 1], "offline but recent: shown, marked offline");
	b.skew += 2 * 3600_000;
	assert.equal(held(b), undefined, "offline for over 2 hours");
});

test("remote text keeps its characters but loses escapes, bidi overrides, and newlines, and is cut again on the way out", async () => {
	const b = rig("b");
	await b.holder.start();
	const head = stateOf(rosterOf(), alice).head;
	const nasty: Board = { entries: [{ id: "0123456789abcdef", workspace: "wé\x1b[3G密", tab: "a\x1b[1;3", name: "x\n‮y", now: "\x1b[31mred\x1b[0m and\nnewline‮evil", updated: Date.now(), items: [{ t: "split \x1b[4", done: false }, { t: "密碼 stays", done: true }] }] };
	await new RelayClient({ url: "http://relay.test", device: alice, fetch: relay.fetch }).postEnvelope(TEAM, buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from: alice, seq: 0, ts: Date.now(), kind: "board", to: [], plaintext: encodePlaintext("board", nasty) }));
	await until(() => held(b)?.entries.length === 1, 3000, "the board");
	const [e] = held(b)!.entries;
	const bad = /[\p{Cc}\p{Cf}]/u;
	for (const text of [e!.workspace, e!.tab, e!.main, e!.now, ...e!.items.map((i) => i.t)]) assert.ok(!bad.test(text), JSON.stringify(text));
	assert.equal(e!.now, "[31mred[0m and newlineevil");
	assert.equal(e!.workspace, "wé[3G密");
	assert.equal(e!.main, "x y");
	assert.deepEqual(e!.items.map((i) => i.t), ["split [4", "密碼 stays"]);
});

test("a relay without the kind refuses the post: the holder logs it once, sends that team no board for an hour, and tells nobody", async () => {
	relay.rejectKinds.add("board");
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "m1", name: "api main", cwd: a.project }]);
	writeEntry(a.boardDir, "m1", { now: "work", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => events(a).some((e) => e.event === "board-unsupported"), 3000, "the refusal in the log");
	a.skew += 40 * MIN;
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(events(a).filter((e) => e.event === "board-unsupported").length, 1, "left alone for the hour");
	assert.deepEqual(a.notices, [], "no notice for anybody");
	assert.equal(mine().length, 0);
	relay.rejectKinds.clear();
	a.skew += 30 * MIN;
	b.skew = a.skew; // B's clock follows, or it drops a board dated an hour ahead
	await until(() => held(b)?.entries.length === 1, 3000, "a board once the hour is over");
});

test("a board never starts a turn, enters the inbox, or offers anything to a tower", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "m1", name: "api main", cwd: a.project }]);
	b.net = netOf([["tower-b", "w-b", "label-b", b.project]]);
	writeEntry(a.boardDir, "m1", { now: "work", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => held(b)?.entries.length === 1, 3000, "the board");
	await b.holder.drain();
	assert.deepEqual([b.offers, b.store.inboxIds(), relay.ackedBy(bob.id)], [[], [], []]);
	assert.ok(!events(b).some((e) => e.event === "unhandled-kind"), "taken as a board, not as an unknown kind");
});

test("two teams: each gets its own board, by project and share; a device in both never sends one team the other's entries; allies' boards are read per team", async () => {
	const TEAM2 = Buffer.alloc(16, 0x1f), hex2 = TEAM2.toString("hex");
	const log2: RosterEntry[] = [createEntry({ team: TEAM2, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create2") })];
	const v2 = () => { const r = replayRoster(TEAM2, log2, { self: alice, keys: new Map([[1, teamKey(1)]]) }); if (!r.ok) throw new Error(r.reason); return r.value; };
	log2.push(addEntry({ state: v2(), signer: alice, record: bob, label: LABELS.bob, attended: true, ...det("add2-bob") }));
	const projects = (r: Rig): Teams => new Map([[TEAM_HEX, { project: r.project, share: "status", name: "alpha" }], [hex2, { project: r.other, share: "status", name: "beta" }]]);
	const [a, b] = [rig("a", { teams: projects }), rig("b", { teams: projects })];
	for (const [r, keys] of [[a, alice], [b, bob]] as const) {
		const state = replayRoster(TEAM2, log2, { self: keys, keys: keys === alice ? new Map([[1, teamKey(1)]]) : undefined });
		if (!state.ok) throw new Error(state.reason);
		writeFileTeam(r, hex2, log2, state.value.keys);
	}
	relay.addTeam(TEAM2, [alice.id, bob.id], log2);
	a.net = netWith(a.project, [{ id: "m-alpha", name: "alpha main", cwd: a.project }, { id: "m-beta", name: "beta main", cwd: a.other }]);
	writeEntry(a.boardDir, "m-alpha", { now: "alpha work", items: [] }, Date.now());
	writeEntry(a.boardDir, "m-beta", { now: "beta work", items: [] }, Date.now());
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => held(b, alice.id, [TEAM_HEX])?.entries.length === 1 && held(b, alice.id, [hex2])?.entries.length === 1, 3000, "both teams' boards");
	assert.deepEqual(held(b, alice.id, [TEAM_HEX])!.entries.map((e) => e.now), ["alpha work"]);
	assert.deepEqual(held(b, alice.id, [hex2])!.entries.map((e) => e.now), ["beta work"]);
	assert.deepEqual([held(b, alice.id, [TEAM_HEX])!.team, held(b, alice.id, [hex2])!.team], ["alpha", "beta"]);
	const all = b.holder.boards();
	assert.ok(all.ok && all.boards.length === 2);
	assert.equal(b.holder.boards({ only: ["no-such-team"] }).ok && (b.holder.boards({ only: ["no-such-team"] }) as { boards: unknown[] }).boards.length, 0);
});

/** A team file for a second team, as writeTeam writes the first. */
function writeFileTeam(r: Rig, team: string, entries: RosterEntry[], keys: Map<number, Buffer>) {
	mkdirSync(join(r.store.dir, "teams"), { recursive: true });
	const file = { v: 1, team, relay: "http://relay.test", entries: entries.map((e) => Buffer.from(encodeEntry(e)).toString("base64url")), keys: Object.fromEntries([...keys].map(([epoch, key]) => [String(epoch), key.toString("hex")])), lastEventId: 0, lastSeq: {} };
	writeFileSync(join(r.store.dir, "teams", `${team}.json`), JSON.stringify(file));
}

test("board_read of one device asks for it as tower_send does: an ambiguous or unknown device is an error that says so", async () => {
	const b = rig("b");
	await b.holder.start();
	const err = b.holder.boards({ device: "nobody" });
	assert.ok(!err.ok);
	assert.match(err.error, /No device "nobody"/);
	const ok = b.holder.boards({ device: "alice-mac" });
	assert.ok(ok.ok);
});

test("a main without a name goes to allies with an empty name, a main with no entry has no age and no now, and no field holds a local session id", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "main-unnamed", cwd: a.project, tab: "docs" }]);
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => held(b)?.entries.length === 1, 3000, "the board");
	const board = held(b)!, [e] = board.entries;
	assert.equal(e!.main, "");
	assert.ok(!JSON.stringify(board).includes("main-unnamed"), "no field holds the session id");
	assert.ok(!("updatedSecondsAgo" in e!) && e!.now === "", JSON.stringify(e));
});

test("a team that was set to presence while pi was closed gets one empty board at the first start, so the allies' copy clears", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.share = "presence";
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => mine().length === 1, 3000, "one empty board at the start");
	assert.deepEqual(held(b)?.entries, []);
	a.skew += 20_000;
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(mine().length, 1, "and no more");
});

test("ticks that overlap while the net is slow send one board, not two", async () => {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netWith(a.project, [{ id: "m1", name: "api main", cwd: a.project }]);
	writeEntry(a.boardDir, "m1", { now: "work", items: [] }, Date.now());
	a.netDelayMs = 150;
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => mine().length >= 1, 3000, "the board");
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(mine().length, 1);
	assert.ok(!events(a).some((e) => e.event === "board-failed"), JSON.stringify(events(a).filter((e) => e.event === "board-failed")));
});

test("the answer of boards() fits the channel by bytes: CJK boards from five devices are cut to the rows that fit, and the answer can be chunked", async () => {
	const entries = rosterOf(["bob", "carol", "dave", "eve", "mallory"]);
	const b = rig("b", { entries });
	relay.addTeam(TEAM, ["alice", "bob", "carol", "dave", "eve", "mallory"].map((w) => DEVICES[w as keyof typeof DEVICES].id), entries);
	await b.holder.start();
	const head = stateOf(entries, alice).head, long = (n: number) => "あ".repeat(n);
	const full: Board = { entries: Array.from({ length: 24 }, (_, i) => ({ id: `${i}`.padStart(16, "0"), workspace: long(40), tab: long(40), name: long(40), now: long(120), updated: Date.now(), items: Array.from({ length: 8 }, () => ({ t: long(80), done: false })) })) };
	for (const who of ["alice", "carol", "dave", "eve", "mallory"] as const) {
		const keys = DEVICES[who];
		await new RelayClient({ url: "http://relay.test", device: keys, fetch: relay.fetch }).postEnvelope(TEAM, buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from: keys, seq: 0, ts: Date.now(), kind: "board", to: [], plaintext: encodePlaintext("board", full) }));
	}
	await until(() => { const answer = b.holder.boards(); return answer.ok && answer.boards.length >= 1 && new Set(relay.stored.filter((s) => s.envelope.header.kind === "board").map((s) => s.envelope.header.from)).size === 5; }, 3000, "the boards at B");
	await new Promise((r) => setTimeout(r, 200));
	const answer = b.holder.boards();
	assert.ok(answer.ok);
	assert.ok(answer.boards.length >= 1 && answer.boards.length < 5, `${answer.boards.length} rows`);
	assert.ok(Buffer.byteLength(JSON.stringify({ ok: true, boards: answer.boards }), "utf8") <= MAX_BODY_BYTES);
	assert.doesNotThrow(() => chunks("res", "tower", "req", { ok: true, boards: answer.boards }));
});

test("a decoder from before the board kind drops a board as an unknown kind while presence keeps working", async () => {
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => b.holder.list()[0]?.devices[0]?.online, 3000, "A's presence");
	const head = stateOf(rosterOf(), alice).head;
	const board = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from: alice, seq: 0, ts: Date.now() + 1000, kind: "board", to: [], plaintext: encodePlaintext("board", { entries: [] }) });
	const saved = KINDS.board;
	delete (KINDS as Partial<typeof KINDS>).board; // what a build without the kind knows
	try {
		await new RelayClient({ url: "http://relay.test", device: alice, fetch: relay.fetch }).postEnvelope(TEAM, board);
		await until(() => events(b).some((e) => e.event === "drop" && e.reason === "unknown-kind"), 3000, "the drop");
		const before = b.holder.list()[0]!.devices[0]!.ageMs!;
		await new Promise((r) => setTimeout(r, 250));
		assert.ok(b.holder.list()[0]!.devices[0]!.online && b.holder.list()[0]!.devices[0]!.ageMs! < before + 250, "presence still arrives");
	} finally {
		KINDS.board = saved;
	}
});

test("a decoder from before caps and tower-reply drops both as an unknown kind while presence keeps working", async () => {
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => b.holder.list()[0]?.devices[0]?.online, 3000, "A's presence");
	const head = stateOf(rosterOf(), alice).head;
	const ts = Date.now() + 1000, askId = "00112233445566778899aabbccddeeff";
	const caps = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from: alice, seq: 0, ts, kind: "caps", to: [], plaintext: encodePlaintext("caps", { features: ["tower-reply"] }) });
	const reply = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head, from: alice, seq: 1, ts, kind: "tower-reply", to: [bob.id], plaintext: encodePlaintext("tower-reply", { inReplyTo: askId, text: "done" }) });
	const saved = { caps: KINDS.caps, reply: KINDS["tower-reply"] };
	delete (KINDS as Partial<typeof KINDS>).caps; // what a build without the kinds knows
	delete (KINDS as Partial<typeof KINDS>)["tower-reply"];
	try {
		const client = new RelayClient({ url: "http://relay.test", device: alice, fetch: relay.fetch });
		await client.postEnvelope(TEAM, caps);
		await client.postEnvelope(TEAM, reply);
		await until(() => events(b).filter((e) => e.event === "drop" && e.reason === "unknown-kind").length >= 2, 3000, "both drops");
		const before = b.holder.list()[0]!.devices[0]!.ageMs!;
		await new Promise((r) => setTimeout(r, 250));
		assert.ok(b.holder.list()[0]!.devices[0]!.online && b.holder.list()[0]!.devices[0]!.ageMs! < before + 250, "presence still arrives");
	} finally {
		KINDS.caps = saved.caps;
		KINDS["tower-reply"] = saved.reply;
	}
});
