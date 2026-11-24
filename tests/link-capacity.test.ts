import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { wireId, writeEntry } from "../src/board.ts";
import { capDir, type DeviceCap, writeDevice as writeDeviceRow } from "../src/capacity.ts";
import type { LinkConfig } from "../src/link/config.ts";
import { LinkHolder } from "../src/link/holder.ts";
import { type Board, decodePlaintext, encodePlaintext } from "../src/link/kinds.ts";
import type { NetView } from "../src/link/routing.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { alice, bob, carol, clientFor, netOf, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";

// The capacity row on the wire (docs/specs/2026-11-24-capacity.md): numbers and times only, the paused mains by the ids the board already carries; sent only when every teammate's caps list
// `board.capacity`; held by the receiver, and read by its capacity watch for a silent device.

let root = "";
let relay: FakeRelay;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "psb-link-cap-")); relay = new FakeRelay(); });
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); rmSync(root, { recursive: true, force: true }); });

test("a board's capacity field encodes and decodes, and a board of one field (an older build's) still decodes", () => {
	const board: Board = { entries: [], capacity: { at: 1_800_000_000_000, points: 650, budget: 2000, load1: 24, cores: 32, ready: 5, minReady: 50, open: 9, paused: [{ id: "00aa11bb22cc33dd", until: 1_800_000_900_000 }, { id: "ffee" }] } };
	assert.deepEqual(decodePlaintext("board", encodePlaintext("board", board)), board);
	const bare: Board = { entries: [], capacity: { at: 1, points: 0, load1: 0, cores: 1, ready: 0, open: 0, paused: [] } };
	assert.deepEqual(decodePlaintext("board", encodePlaintext("board", bare)), bare);
	assert.deepEqual(decodePlaintext("board", encodePlaintext("board", { entries: [] })), { entries: [] });
});

function rig(name: "a" | "b", members: ("bob" | "carol")[] = ["bob"]) {
	const keys = name === "a" ? alice : bob, entries = rosterOf(members), dir = join(root, name, "link"), project = join(root, `${name}-project`), boardDir = join(root, name, "board");
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, name === "a" ? "alice-mac" : "bob-mac");
	writeTeam(store, entries, keys);
	const net: NetView = netOf([["tower-a", "w-a", "label-a", project]]);
	const config = (): LinkConfig => ({ teams: new Map([[TEAM_HEX, { project, share: "status", name: "moldplan" }]]), trust: new Map(), problems: [] });
	const holder = new LinkHolder({ store, isHolder: () => true, config, net: async () => net, relay: clientFor(relay), offer: () => {}, notify: () => {}, boardDir, now: () => Date.now(), backoff: () => 5, drainMs: 20, presenceMs: 40, boardMinMs: 20, offerAgainMs: 60_000 } as never);
	stops.push(() => holder.stop());
	relay.addTeam(TEAM, [alice.id, bob.id, ...(members.includes("carol") ? [carol.id] : [])], entries);
	return { holder, net, project, boardDir };
}
function mainIn(r: ReturnType<typeof rig>, id: string, cwd: string, i: number) {
	r.net.panes.push({ pane_id: `m${i}`, tab_id: `w-a:t${i}`, workspace_id: "w-a", cwd, agent_status: "working", tokens: { sb_role: "main" } });
	r.net.sessions.push({ id, name: id, herdrLocation: { status: "current", workspace: { id: "w-a", label: "label-a" }, tab: { id: `w-a:t${i}`, label: `tab ${i}` }, paneId: `m${i}` } });
}
const row = (now: number): DeviceCap => ({
	v: 1, at: now, points: 6.5, budget: 20, load1: 0.24, cores: 32, ready: 5, minReady: 0.5, open: 9, unattended: true,
	mains: [
		{ session: "main-in", name: "api", workspace: "w-a", points: 6.5, ready: 5, minReady: 0.5, open: 9, paused: { until: now + 3600_000, detail: "weekly" } },
		{ session: "main-out", name: "private", workspace: "w-a", points: 0, ready: 0, open: 1, paused: {} },
	],
});

test("the capacity row goes to teammates whose caps list it: numbers only, the paused mains by entry id and only those the team gets; the receiver reads it and its watch sees the device", async () => {
	const [a, b] = [rig("a"), rig("b")];
	mainIn(a, "main-in", a.project, 1);
	mainIn(a, "main-out", join(root, "elsewhere"), 2);
	writeEntry(a.boardDir, "main-in", { now: "api work", items: [] }, Date.now());
	writeDeviceRow(capDir(a.boardDir), row(Date.now()));
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => b.holder.boards().ok && (b.holder.boards() as { boards: { capacity?: unknown }[] }).boards.some((x) => x.capacity), 5000, "A's capacity at B");
	const held = (b.holder.boards() as { boards: { device: { id: string }; capacity?: unknown }[] }).boards.find((x) => x.device.id === alice.id)!;
	assert.deepEqual(held.capacity, { points: 6.5, budget: 20, load1: 0.24, cores: 32, ready: 5, minReady: 0.5, open: 9, paused: [{ id: wireId(alice.id, "main-in"), until: (held.capacity as { paused: { until: string }[] }).paused[0]!.until }] });
	assert.doesNotMatch(JSON.stringify(held.capacity), /api|private|weekly|main-/, "no name, session id or detail on the wire");
	const seen = b.holder.allySeen().find((x) => x.short === alice.shortId)!;
	assert.deepEqual([seen.label, seen.timed, seen.open], ["alice-mac", true, true]);
});

test("a teammate whose caps do not list board.capacity (an older build) gets the board without it", async () => {
	const [a, b] = [rig("a", ["bob", "carol"]), rig("b", ["bob", "carol"])]; // carol never says caps
	mainIn(a, "main-in", a.project, 1);
	writeEntry(a.boardDir, "main-in", { now: "api work", items: [] }, Date.now());
	writeDeviceRow(capDir(a.boardDir), row(Date.now()));
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => (b.holder.boards() as { boards: unknown[] }).boards?.length === 1, 5000, "A's board at B");
	await new Promise((done) => setTimeout(done, 200));
	const held = (b.holder.boards() as { boards: { capacity?: unknown }[] }).boards[0]!;
	assert.equal(held.capacity, undefined);
	assert.equal(b.holder.allySeen()[0]!.timed, false);
});
