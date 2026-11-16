import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { aeadOpen } from "../src/link/crypto.ts";
import { encodeHeader } from "../src/link/envelope.ts";
import { decodePlaintext, type Kind } from "../src/link/kinds.ts";
import type { Share } from "../src/link/config.ts";
import { LinkStore } from "../src/link/store.ts";
import { addNote, readRun } from "../src/server/towerrunstore.ts";
import { callControl } from "../src/server/socket.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { roleEntry } from "../src/link/roster.ts";
import { alice, bob, carol, clientFor, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// What the sb server tells the controllers of an unattended device (docs/specs/2026-10-26-sb-backend.md, Unattended devices): the real link holder and reporter of the server, a policy file in a fake file system, a fake Herdr,
// and the controller's side read from the envelopes the fake relay took (bob is the attended device at dispatch; alice is the unattended one).

let world: TowerWorld, relay: FakeRelay;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	relay = new FakeRelay();
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);

/** `bobAdmin`: bob is an admin of the team (a notice of a run nobody dispatched goes to the admins); `carol`: a second controller at dispatch who is no admin. */
function unattended(share: Share, o: { bobAdmin?: boolean; carol?: boolean } = {}) {
	const home = join(world.root, "home"), project = join(home, "project"), elsewhere = join(world.root, "elsewhere");
	mkdirSync(project, { recursive: true });
	mkdirSync(elsewhere, { recursive: true });
	const real = realpathSync(project), store = new LinkStore(join(world.stateDir, "link")), entries = rosterOf(o.carol ? ["carol", "bob"] : ["bob"]);
	if (o.bobAdmin) entries.push(roleEntry({ state: stateOf(entries, alice), signer: alice, subjectId: bob.id, role: "admin" }));
	writeDevice(store, alice, "alice-mac");
	writeTeam(store, entries, alice);
	relay.addTeam(TEAM, [alice.id, bob.id, ...(o.carol ? [carol.id] : [])], entries);
	const text = JSON.stringify({ unattended: true, trust: { [bob.id]: "dispatch", ...(o.carol ? { [carol.id]: "dispatch" } : {}) }, teams: { [TEAM_HEX]: { project: real, share } } });
	const link = { tickMs: 15, drainMs: 20, presenceMs: 40, relay: clientFor(relay), home, policy: { read: () => text, stat: () => ({ uid: 0, symlink: false }), writable: () => false, uid: 1000 } };
	return { real, elsewhere, link };
}
/** What bob reads of the envelopes alice sent him of `kind` (opened with the team key, without the receive checks: the roster of this test has alice attended). */
function toBob(kind: string, who: typeof bob = bob) {
	const key = stateOf(rosterOf(), bob).keys.get(1)!, out: Record<string, unknown>[] = [];
	for (const stored of relay.stored) {
		const { header, nonce, ct } = stored.envelope;
		if (header.kind !== kind || !stored.to.has(who.id)) continue;
		const plain = aeadOpen(key, nonce, ct, encodeHeader(header));
		const message = plain && decodePlaintext(kind as Kind, plain);
		if (message) out.push(message as unknown as Record<string, unknown>);
	}
	return out;
}
const unitsSeen = () => toBob("unit-status").map((m) => (m.units as { unit: string; monitors: string[] }[]).map((u) => u.unit));

async function towers(u: ReturnType<typeof unattended>) {
	const s = await world.start({ link: u.link, unitsMs: 20 });
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	for (const p of world.herdr.panes) p.cwd = p.workspace_id === "wA" ? u.real : u.elsewhere;
	return s;
}

test("the controller is told the units whose workspace is inside the team's project, under a scrubbed label, and not the others", async () => {
	const u = unattended("status");
	await towers(u);
	await until(() => unitsSeen().some((x) => x.length > 0), "a status with units");
	for (const seen of unitsSeen().filter((x) => x.length)) assert.deepEqual(seen, ["Alpha"]);
});

test("a team that shares presence only gets no unit in the status", async () => {
	const u = unattended("presence");
	await towers(u);
	await until(() => unitsSeen().length > 0, "a status");
	assert.equal(unitsSeen().every((x) => x.length === 0), true);
});

/** A local run of workspace wA that crashes: the tower's own run, which no controller dispatched. */
async function crashLocalRun(s: Running) {
	const tower = world.client("sb-tower-wa")!;
	tower.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "poison" } });
	await until(() => world.pis.size >= 1, "a run");
	const id = [...world.pis.keys()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const pi = world.pis.get(id)!;
	const claimed = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(claimed.ok, true, JSON.stringify(claimed));
	world.live.delete(pi.pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", "the crash");
}

test("a run that crashes reaches the admin as a notice through the server's own wiring, and the test seam still hears of it", async () => {
	const u = unattended("status", { bobAdmin: true });
	const s = await towers(u);
	await crashLocalRun(s);
	await until(() => toBob("notice").length > 0, "the notice at the controller");
	assert.deepEqual(toBob("notice").map((n) => [n.kind, n.unit]), [["run-crashed", "Alpha"]]);
	assert.deepEqual(world.signals.map((x) => x.kind), ["ended"], "a seam that watches the runs hears it as well");
});

test("a run nobody dispatched tells the admin and not a controller who is no admin (G3)", async () => {
	const u = unattended("status", { bobAdmin: true, carol: true });
	const s = await towers(u);
	await crashLocalRun(s);
	await until(() => toBob("notice").length > 0, "the notice at the admin");
	// Carol is before bob in the roster, so a notice for her would have been posted before bob's.
	assert.deepEqual(toBob("notice", carol), [], "carol is at dispatch and is no admin: the tower's own run is not hers");
	assert.equal(toBob("notice").length, 1);
});

test("a controller who is no admin is told nothing of a run nobody dispatched, even alone (G3)", async () => {
	const u = unattended("status");
	const s = await towers(u);
	await crashLocalRun(s);
	// The box keeps posting presence every 40 ms: two more after the crash have gone out by the time the notice would have.
	const presences = () => relay.stored.filter((x) => x.envelope.header.kind === "presence").length, before = presences();
	await until(() => presences() >= before + 2, "two more presences");
	assert.deepEqual(toBob("notice"), []);
});

test("a unit's report comes from the workspace inside the team's project, not another with the same label", async () => {
	const u = unattended("status");
	const s = await world.start({ link: u.link, unitsMs: 20 });
	await s.handle.ready;
	// The outside workspace is made first, so a lookup by label would meet it first.
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.herdr.workspaces.find((w) => w.workspace_id === "wB")!.label = "Alpha";
	for (const p of world.herdr.panes) p.cwd = p.workspace_id === "wA" ? u.real : u.elsewhere;
	const row = (kind: "local") => ({ kind, run: "r", at: new Date().toISOString(), note: "" });
	addNote(world.slot, "wB", { ...row("local"), note: "outside note" });
	addNote(world.slot, "wA", { ...row("local"), note: "inside note" });
	await until(() => toBob("unit-status").some((m) => (m.units as { report: string }[]).length > 0), "a status with a unit");
	const reports = toBob("unit-status").flatMap((m) => (m.units as { report: string }[]).map((x) => x.report));
	assert.ok(reports.includes("inside note"), JSON.stringify(reports));
	assert.ok(!reports.includes("outside note"), JSON.stringify(reports));
});

test("R-F003: an unattended device has no boss at its prompt: a poll that says the boss is answering holds no wake there", async () => {
	const u = unattended("status");
	const s = await towers(u);
	const MAIN = { id: "main-1", name: "mp3946-print" };
	world.client("sb-tower-wa")!.incoming(MAIN, { id: "m1", content: { text: "the build is green" } });
	await until(() => world.client("sb-tower-wa") !== undefined, "the tower identity");
	const polled = await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4321, answering: true });
	assert.equal(polled.ok, true);
	assert.equal(polled.unattended, true, "the prompt is told it has no boss");
	assert.equal(polled.holding, undefined, "and holds no wake");
});
