import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { wireId } from "../src/board.ts";
import { capDir } from "../src/capacity.ts";
import { writeHold } from "../src/hold.ts";
import type { LinkConfig } from "../src/link/config.ts";
import { LinkHolder } from "../src/link/holder.ts";
import { endHolds, moveHolds, readHolds, setHold } from "../src/link/holds.ts";
import { type Board, decodePlaintext, encodePlaintext } from "../src/link/kinds.ts";
import { enc, list } from "../src/link/canon.ts";
import type { NetView } from "../src/link/routing.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { alice, bob, carol, clientFor, netOf, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";

// Device holds on the wire and in the controller's store (docs/specs/2026-11-26-device-hold.md): the board's third field, written only when every teammate's caps list `board.holds`, with an empty second field
// meaning no capacity row; a controller's `holds` of the boxes its live mains hold (link/holds.json), and a box's `held` echo of the hold it honours (`_hold.json`).

let root = "";
let relay: FakeRelay;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "psb-link-holds-")); relay = new FakeRelay(); });
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); rmSync(root, { recursive: true, force: true }); });

const BY = "0123456789abcdef";
test("a board's holds encode and decode with 1, 2, or 3 fields; an empty second field is no capacity; a hold of an unknown role or a bad id is left out; four fields are refused", () => {
	const cap = { at: 1, points: 100, load1: 0, cores: 4, ready: 0, open: 0, paused: [] };
	const held: Board = { entries: [], holds: [{ device: bob.id, by: BY, since: 1_800_000_000_000, until: 1_800_000_900_000, role: "holds" }, { device: carol.id, by: BY, since: 5, role: "held" }] };
	assert.deepEqual(decodePlaintext("board", encodePlaintext("board", held)), held, "holds without capacity: the second field is empty");
	assert.equal(decodePlaintext("board", encodePlaintext("board", held))!.capacity, undefined);
	const both: Board = { entries: [], capacity: cap, holds: [held.holds![0]!] };
	assert.deepEqual(decodePlaintext("board", encodePlaintext("board", both)), both);
	assert.deepEqual(decodePlaintext("board", encodePlaintext("board", { entries: [], capacity: cap })), { entries: [], capacity: cap }, "two fields as before");
	assert.equal(encodePlaintext("board", { entries: [], holds: [] }).length, encodePlaintext("board", { entries: [] }).length, "no holds, no third field");
	const raw = (role: string, device: string) => enc(list([]), enc(), list([enc(Buffer.from(device), Buffer.from(BY), Buffer.alloc(8), list([]), Buffer.from(role))]));
	assert.deepEqual(decodePlaintext("board", raw("owns", bob.id)), { entries: [] }, "an unknown role");
	assert.deepEqual(decodePlaintext("board", raw("holds", "not-an-id")), { entries: [] }, "a bad device id");
	assert.equal(decodePlaintext("board", enc(list([]), enc(), list([]), enc())), null, "four fields");
	assert.equal(decodePlaintext("board", enc(list([]), enc())), null, "an empty second field alone is no capacity row");
	assert.throws(() => encodePlaintext("board", { entries: [], holds: [{ device: bob.id, by: "xyz", since: 1, role: "holds" }] }), RangeError);
	const nine: Board = { entries: [], holds: Array.from({ length: 9 }, (_, i) => ({ device: bob.id, by: BY, since: i, role: "holds" as const })) };
	assert.equal(decodePlaintext("board", encodePlaintext("board", nine))!.holds!.length, 8, "at most 8");
});

test("the controller's store: a hold per box, ended with a reason and kept an hour, moved to a rotation's successor", () => {
	const dir = join(root, "link"), now = 1_800_000_000_000;
	setHold(dir, now, { team: TEAM_HEX, device: bob.id, session: "main-1", since: now });
	setHold(dir, now + 1, { team: TEAM_HEX, device: bob.id, session: "main-2", since: now + 1 });
	assert.deepEqual(readHolds(dir, now).holds.map((h) => h.session), ["main-2"], "a new hold of the same box replaces the earlier");
	moveHolds(dir, now, "main-2", "main-3");
	assert.deepEqual(readHolds(dir, now).holds.map((h) => [h.session, h.since]), [["main-3", now + 1]]);
	assert.deepEqual(endHolds(dir, now + 2, (h) => h.device === bob.id, "ended-there").map((h) => h.session), ["main-3"]);
	assert.deepEqual(readHolds(dir, now + 2), { v: 1, holds: [], ended: [{ team: TEAM_HEX, device: bob.id, session: "main-3", since: now + 1, at: now + 2, reason: "ended-there" }] });
	assert.deepEqual(readHolds(dir, now + 2 + 3600_000).ended, [], "an ended hold is kept an hour");
});

function rig(name: "a" | "b", o: { members?: ("bob" | "carol")[]; attended?: boolean; trust?: Map<string, string> } = {}) {
	const keys = name === "a" ? alice : bob, members = o.members ?? ["bob"], entries = rosterOf(members), dir = join(root, name, "link"), project = join(root, `${name}-project`), boardDir = join(root, name, "board");
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, name === "a" ? "alice-mac" : "bob-box");
	writeTeam(store, entries, keys);
	const net: NetView = netOf([["tower-a", "w-a", "label-a", project]]);
	const config = (): LinkConfig => ({ teams: new Map([[TEAM_HEX, { project, share: "status", name: "moldplan" }]]), trust: (o.trust ?? new Map()) as LinkConfig["trust"], problems: [] });
	const holder = new LinkHolder({ store, isHolder: () => true, config, attended: () => o.attended ?? true, net: async () => net, relay: clientFor(relay), offer: () => {}, notify: () => {}, boardDir, now: () => Date.now(), backoff: () => 5, drainMs: 20, presenceMs: 40, boardMinMs: 20, offerAgainMs: 60_000 } as never);
	stops.push(() => holder.stop());
	relay.addTeam(TEAM, [alice.id, bob.id, ...(members.includes("carol") ? [carol.id] : [])], entries);
	return { holder, net, project, boardDir, dir };
}
const live = (r: ReturnType<typeof rig>, id: string) => r.net.sessions.push({ id, name: "work-on", herdrLocation: { status: "current", workspace: { id: "w-a", label: "label-a" }, tab: { id: "w-a:t1", label: "tab" }, paneId: "m1" } });

test("a controller's hold reaches the box with the facts it judges by, and the box's echo reaches the controller", async () => {
	const a = rig("a"), b = rig("b", { attended: false, trust: new Map([[alice.id, "dispatch"]]) });
	live(a, "main-1");
	const since = Date.now();
	setHold(a.dir, since, { team: TEAM_HEX, device: bob.id, session: "main-1", since });
	writeHold(capDir(b.boardDir), { v: 1, at: Date.now(), held: { team: TEAM_HEX, device: alice.id, label: "alice-mac", short: alice.shortId, by: wireId(alice.id, "main-1"), byName: "work-on", since } });
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => b.holder.allySeen().some((x) => x.claim), 5000, "A's hold at B");
	const seen = b.holder.allySeen().find((x) => x.device === alice.id)!;
	assert.deepEqual({ ...seen.claim, ts: 0 }, { by: wireId(alice.id, "main-1"), since, ts: 0, attended: true, level: "dispatch" });
	assert.equal(seen.team, TEAM_HEX);
	await until(() => a.holder.allySeen().some((x) => x.echo), 5000, "B's echo at A");
	assert.deepEqual(a.holder.allySeen().find((x) => x.device === bob.id)!.echo, { by: wireId(alice.id, "main-1"), since });
	assert.doesNotMatch(JSON.stringify(relay.stored.map((x) => x.envelope)), /main-1/, "no session id on the wire");
});

test("no holds go while a teammate's caps do not list board.holds (an older build would refuse the board)", async () => {
	const a = rig("a", { members: ["bob", "carol"] }), b = rig("b", { members: ["bob", "carol"], attended: false, trust: new Map([[alice.id, "dispatch"]]) }); // carol never says caps
	live(a, "main-1");
	setHold(a.dir, Date.now(), { team: TEAM_HEX, device: bob.id, session: "main-1", since: Date.now() });
	await Promise.all([a.holder.start(), b.holder.start()]);
	const capsOf = (a.holder as unknown as { runs: Map<string, { caps: Map<string, { features: string[] }> }> }).runs.get(TEAM_HEX)!.caps;
	await until(() => capsOf.get(bob.id)?.features.includes("board.holds") ?? false, 5000, "bob's caps at A");
	await until(() => b.holder.allySeen().some((x) => x.device === alice.id), 5000, "A's board at B");
	assert.equal(b.holder.allySeen().find((x) => x.device === alice.id)!.claim, undefined);
});
