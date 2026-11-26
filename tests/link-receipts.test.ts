import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LinkHolder, STUCK_MS } from "../src/link/holder.ts";
import { addEntry, createEntry, type RosterEntry } from "../src/link/roster.ts";
import { LinkStore } from "../src/link/store.ts";
import { answeredAsks, routedAsk } from "../src/server/allyroute.ts";
import { allyReceipts } from "../src/server/linkreceipts.ts";
import { slotOf } from "../src/server/record.ts";
import { addNote } from "../src/server/towerrunstore.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { clientFor, netOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./link/scenario.ts";

// The box's receipts (docs/specs/2026-11-21-box-mac-waits.md §4 C4, §9 anchor 7; boss decision D6): an ally run that ends without answering an ask answers it with code text and its own note; a message with an ask that waits 10 minutes with
// no run started makes the box send a notice whose ref names the ask, once; on the controller that notice reaches the main that asked.

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-receipts-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});
const ASK = "c".repeat(32);

test("an ally run that ends without answering its ask answers it with code text, its note when it ended done, and nothing for an ask it answered or on an attended computer", () => {
	const slot = slotOf(join(root, "state"), { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
	const sent: { ws: string; device: string; text: string; ask: string }[] = [];
	let box = true;
	const receipt = allyReceipts({ slot, now: () => Date.parse("2026-11-21T09:30:00Z"), unattended: () => box, answered: (_run, ask) => ask === "d".repeat(32), label: () => "waydosoft", log: () => {}, send: async (ws, device, text, ask) => void sent.push({ ws, device, text, ask }) });
	addNote(slot, "wA", { kind: "ally", device: "dev", run: "run12345abc", at: "2026-11-21T09:29:00Z", note: "No Mac main owns MSSQL→PG work here; told nobody" });
	receipt({ run: "run12345abc", workspace: "wA", device: "dev", outcome: "done", asks: [ASK, "d".repeat(32)] });
	assert.deepEqual(sent.map((x) => [x.device, x.ask]), [["dev", ASK]], "one reply, to the ask the run did not answer");
	assert.equal(sent[0]!.text, "waydosoft took your message in ally run run12345 at 09:30 UTC and it ended done without an answer. Its note: «No Mac main owns MSSQL→PG work here; told nobody».");
	receipt({ run: "run2", workspace: "wA", device: "dev", outcome: "crashed", asks: [ASK] });
	assert.match(sent[1]!.text, /ended crashed without an answer\.$/, "a crash has no note of its own run");
	box = false;
	receipt({ run: "run3", workspace: "wA", device: "dev", outcome: "done", asks: [ASK] });
	assert.equal(sent.length, 2, "an attended computer sends none");
});

test("the ask an opened main's route takes is the main's to answer: the run's end sends no receipt for it", () => {
	const slot = slotOf(join(root, "state"), { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
	const sent: string[] = [], answered = answeredAsks(() => 1);
	const receipt = allyReceipts({ slot, now: () => 1, unattended: () => true, answered: (run, ask) => answered.has(run, ask), label: () => "box", log: () => {}, send: async (_ws, _device, _text, ask) => void sent.push(ask) });
	assert.equal(routedAsk(answered, "run1", [ASK]), ASK, "the one open ask goes to the route");
	assert.equal(routedAsk(answered, "run1", [ASK]), undefined, "and is taken: a second open does not carry it");
	assert.equal(routedAsk(answered, "run2", [ASK, "d".repeat(32)]), undefined, "two open asks name none");
	receipt({ run: "run1", workspace: "wA", device: "dev", outcome: "done", asks: [ASK] });
	assert.deepEqual(sent, [], "no receipt answers the ask the main now holds");
});

// dave is the unattended box, alice the attended controller (founder).
const { alice, dave } = DEVICES;
const entries: RosterEntry[] = (() => {
	const log: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	log.push(addEntry({ state: view(log), signer: alice, record: dave, label: LABELS.dave, attended: false, ...det("add-dave") }));
	return log;
})();
let skew = 0;
function rig(who: "alice" | "dave", seen: { ref: string; kind: string }[] = []) {
	const keys = DEVICES[who], dir = join(root, who, "link"), project = join(root, `${who}-project`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, LABELS[who]);
	writeTeam(store, entries, keys);
	const holder = new LinkHolder({
		store, isHolder: () => true, attended: () => who !== "dave", net: async () => netOf([[`tower-${who}`, `w-${who}`, `label-${who}`, project]]), relay: clientFor(relay),
		config: () => ({ teams: new Map([[TEAM_HEX, { project, share: "status" as const, name: "moldplan" }]]), trust: new Map(), problems: [] }),
		offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000, now: () => Date.now() + skew,
		...(who === "alice" ? { waits: { take: async () => true, notice: (n: { ref: string; kind: string }) => void seen.push({ ref: n.ref, kind: n.kind }) } } : {}),
	});
	cleanup.push(() => holder.stop());
	return { holder, store };
}

test("a message with an ask that waits 10 minutes on the box with no run started makes one notice whose ref names the ask; the controller hands it to the main that asked", async () => {
	relay.addTeam(TEAM, [alice.id, dave.id], entries);
	const seen: { ref: string; kind: string }[] = [];
	const [a, d] = [rig("alice", seen), rig("dave")];
	await Promise.all([a.holder.start(), d.holder.start()]);
	// Caps both ways: alice writes the ask id only to a box whose caps she holds (else the message goes plain and no notice can name it), and the box writes the ref only to a controller whose caps it holds.
	await until(() => a.holder.capsFor(TEAM_HEX, dave.id).includes("tower.awaitsReply") && d.holder.capsFor(TEAM_HEX, alice.id).includes("notice.ref"), 3000, "caps both ways");
	const sent = await a.holder.send({ fromSession: "tower-alice", device: LABELS.dave, text: "run trial 7", reply: true, awaitsReply: ASK });
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.equal(sent.ok && (sent.details as { asked?: boolean }).asked, true, "the message carries the ask");
	await until(() => d.store.inboxIds().length === 1, 3000, "the message in the box's inbox");
	const told = () => readFileSync(join(d.store.dir, "link.log"), "utf8").trim().split("\n").filter((l) => JSON.parse(l).event === "stuck-notice").length;
	skew = STUCK_MS - 60_000;
	await d.holder.drain();
	assert.equal(told(), 0, "not before 10 minutes");
	skew = STUCK_MS + 1000;
	await d.holder.drain();
	await until(() => told() >= 1, 3000, "the stuck notice in the box's log");
	assert.equal(told(), 1);
	await until(() => seen.length === 1, 3000, "the notice at the controller's main");
	assert.deepEqual(seen[0], { ref: ASK, kind: "inbox-stuck" });
	const notice = a.holder.summary().alerts.find((x) => x.kind === "notice");
	assert.match(String(notice?.data.text), /^Your message has waited 10 min here and no run took it yet: the tower here was offered it and has not taken it yet\.$/);
	await d.holder.drain();
	assert.equal(told(), 1, "once per message and reason");
});
