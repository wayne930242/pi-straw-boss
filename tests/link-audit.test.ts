import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// G6 (docs/specs/2026-11-05-link-shared-box.md, Audit): the receiving device's link.log has one line per inbound `tower` message (sender device, team, ask id, message id) and one when an ally run takes it
// (the run id); never the text, so a shared box can answer "which device sent what to which run".

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-audit-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});

const ASK = "a".repeat(32), SECRET = "the-secret-text-of-the-message";
interface Rig { name: "a" | "b"; dir: string; project: string; store: LinkStore; holder: LinkHolder; net: NetView; open: { main: string; mainName: string; tower: string; workspace: string } | undefined }
function rig(name: "a" | "b"): Rig {
	const keys = name === "a" ? alice : bob, entries = rosterOf();
	const dir = join(root, name, "link"), project = join(root, `${name}-project`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, name === "a" ? "alice-mac" : "bob-mac");
	writeTeam(store, entries, keys);
	const stateDir = join(root, name, "state");
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(stateDir, "config.json"), JSON.stringify({ towerRuns: { enabled: true } }));
	const r = { name, dir, project, store, open: undefined } as unknown as Rig;
	r.net = netOf([]);
	r.holder = new LinkHolder({
		store, stateDir, isHolder: () => true, config: () => config(project)(), net: async () => r.net, relay: clientFor(relay),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, offerAgainMs: 60_000, postWaitMs: 2000, capsMs: 3600_000, capsMinMs: 5,
		asks: { take: () => r.open }, served: () => {},
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
async function pair() {
	const [a, b] = [rig("a"), rig("b")];
	a.net = netOf([["tower-x", "w-a", "label-a", a.project]]);
	b.net = netOf([["sb-tower-wb", "w-b", "label-b", b.project]]);
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => a.holder.capsFor(TEAM_HEX, bob.id).includes("notice.ref"), 3000, "b's caps"); // the last of the features a holder without a wait router lists
	return { a, b };
}
const sendTo = (r: Rig, text: string, over: Partial<Parameters<LinkHolder["send"]>[0]> = {}) => r.holder.send({ fromSession: r.net.sessions[0]!.id, device: r.name === "a" ? "bob-mac" : "alice-mac", text, reply: false, ...over });

test("an inbound tower message makes one link.log line with the sender device, the team, the ask id and the message id, and never the text", async () => {
	const { a, b } = await pair();
	assert.ok((await sendTo(a, SECRET, { reply: true, awaitsReply: ASK })).ok);
	assert.ok((await sendTo(a, `${SECRET} two`)).ok);
	await until(() => b.store.inboxIds().length === 2, 3000, "both in the inbox");
	const lines = events(b).filter((e) => e.event === "tower-in");
	assert.equal(lines.length, 2);
	const ids = b.store.inboxIds().map((id) => b.store.readInbox(id)!).sort((x, y) => x.seq - y.seq);
	assert.deepEqual(lines.map((l) => [l.from, l.team, l.ask, l.id, l.kind]), [
		[alice.id, TEAM_HEX, ASK, ids[0]!.id, "tower"],
		[alice.id, TEAM_HEX, undefined, ids[1]!.id, "tower"],
	]);
	assert.ok(!readFileSync(join(b.dir, "link.log"), "utf8").includes(SECRET), "the text is not in the log");
});

test("a tower-reply is logged the same way, with the ask it answers", async () => {
	const { a, b } = await pair();
	b.open = { main: "main-1", mainName: "docs-main", tower: "sb-tower-wb", workspace: "label-b" };
	assert.ok((await sendTo(a, SECRET, { inReplyTo: ASK })).ok);
	await until(() => events(b).some((e) => e.event === "tower-in"), 3000, "the line");
	const [line] = events(b).filter((e) => e.event === "tower-in");
	assert.deepEqual([line!.from, line!.team, line!.ask, line!.kind], [alice.id, TEAM_HEX, ASK, "tower-reply"]);
	assert.ok(!readFileSync(join(b.dir, "link.log"), "utf8").includes(SECRET));
});

test("the run that takes a message is logged against it: run id, sender, team, ask and message id, and not for a message the inbox no longer holds", async () => {
	const { a, b } = await pair();
	await sendTo(a, SECRET, { reply: true, awaitsReply: ASK });
	await until(() => b.holder.servedFor("sb-tower-wb").length === 1, 3000, "the message waits");
	const [item] = b.holder.servedFor("sb-tower-wb");
	b.holder.delivered(item!.id, "run-0123");
	b.holder.delivered("f".repeat(64), "run-ghost");
	const lines = events(b).filter((e) => e.event === "tower-run");
	assert.equal(lines.length, 1);
	assert.deepEqual([lines[0]!.run, lines[0]!.from, lines[0]!.team, lines[0]!.ask, lines[0]!.id], ["run-0123", alice.id, TEAM_HEX, ASK, item!.id]);
	assert.ok(!readFileSync(join(b.dir, "link.log"), "utf8").includes(SECRET));
});
