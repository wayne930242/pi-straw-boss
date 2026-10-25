import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { buildEnvelope } from "../src/link/envelope.ts";
import { LinkHolder } from "../src/link/holder.ts";
import { encodePlaintext } from "../src/link/kinds.ts";
import { RelayClient } from "../src/link/relay.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until as untilAsync } from "./fakes.ts";
import { until } from "./link/fakes.ts";
import { alice, bob, carol, clientFor, config, netOf, rosterOf, stateOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM, teamKey } from "./link/scenario.ts";
import { computer, remoteMessage, type Computer } from "./link/remote-world.ts";

// `forward` (docs/specs/2026-10-25-straw-link.md, The gate, Message kinds): the tower of one device asks the sender's device to confirm a call, and takes
// the answer only from that device, with the dialog's id and digest, once.

let root = "";
let relay: FakeRelay;
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-confirm-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of cleanup.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});

const entries = rosterOf(["bob", "carol"]);
interface Rig { holder: LinkHolder; store: LinkStore; notices: string[]; got: [string, string, boolean][] }
function rig(name: "a" | "b"): Rig {
	const keys = name === "a" ? alice : bob, dir = join(root, name, "link"), project = join(root, `${name}-project`);
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, name === "a" ? "alice-mac" : "bob-mac");
	writeTeam(store, entries, keys);
	const r = { store, notices: [], got: [] } as unknown as Rig;
	r.holder = new LinkHolder({
		store, isHolder: () => true, config: () => config(project)(), net: async () => netOf([[`tower-${name}`, `w-${name}`, `label-${name}`, project]]), relay: clientFor(relay),
		offer: () => {}, notify: (text) => void r.notices.push(text), confirmed: (tower, id, allow) => void r.got.push([tower, id, allow]), backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000,
	});
	cleanup.push(() => r.holder.stop());
	return r;
}
const events = (r: Rig) => {
	try {
		return readFileSync(join(r.store.dir, "link.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
	} catch {
		return [];
	}
};
const ask = (a: Rig, over: Partial<Parameters<LinkHolder["requestConfirm"]>[0]> = {}) => a.holder.requestConfirm({ fromSession: "tower-a", team: TEAM_HEX, device: bob.id, dialogId: "D1", digest: "digest-one", tool: "bash", args: '{\n  "command": "ls"\n}', tower: "tower tower-a", ...over });
/** A confirm-answer built by hand, from any device, with any seq. */
async function forgeAnswer(from: typeof alice, seq: number, fields: { dialogId: string; digest: string; allow: boolean }) {
	const envelope = buildEnvelope({ team: TEAM, epoch: 1, teamKey: teamKey(1), head: stateOf(entries, alice).head, from, seq, ts: Date.now(), kind: "confirm-answer", to: [alice.id], plaintext: encodePlaintext("confirm-answer", { ...fields, answerId: `forged-${seq}` }) });
	await new RelayClient({ url: "http://relay.test", device: from, fetch: relay.fetch }).postEnvelope(TEAM, envelope);
}
const world = () => relay.addTeam(TEAM, [alice.id, bob.id, carol.id], entries);

test("round trip: the request reaches the sender's device with its tool and full arguments; its allow comes back to the asking tower, once", async () => {
	world();
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.holder.start(), b.holder.start()]);
	assert.deepEqual(await ask(a), { ok: true });
	await until(() => b.holder.confirmRequests().length === 1, 3000, "the request on B");
	const seen = b.holder.confirmRequests()[0]!;
	assert.deepEqual([seen.dialogId, seen.fromLabel, seen.tool, seen.args, seen.tower, seen.team], ["D1", "alice-mac", "bash", '{\n  "command": "ls"\n}', "tower tower-a", TEAM_HEX]);
	assert.ok(b.notices.some((n) => /alice-mac asks you to confirm a bash call/.test(n)));
	assert.deepEqual(await b.holder.answerConfirm("D1", true), { ok: true });
	await until(() => a.got.length === 1, 3000, "the answer on A");
	assert.deepEqual(a.got, [["tower-a", "D1", true]]);
	assert.equal(b.holder.confirmRequests().length, 0, "answered requests are used up");
	assert.equal((await b.holder.answerConfirm("D1", true)).ok, false);
});

test("a deny comes back as a deny", async () => {
	world();
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.holder.start(), b.holder.start()]);
	await ask(a);
	await until(() => b.holder.confirmRequests().length === 1, 3000, "the request on B");
	await b.holder.answerConfirm("D1", false);
	await until(() => a.got.length === 1, 3000, "the answer on A");
	assert.deepEqual(a.got[0], ["tower-a", "D1", false]);
});

test("an answer with the wrong digest, from the wrong device, or for a dialog nobody asked is dropped and does not use the dialog up; the right one still counts, once", async () => {
	world();
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.holder.start(), b.holder.start()]);
	await ask(a);
	await forgeAnswer(bob, 50, { dialogId: "D1", digest: "not-the-digest", allow: true });
	await forgeAnswer(carol, 51, { dialogId: "D1", digest: "digest-one", allow: true });
	await forgeAnswer(bob, 52, { dialogId: "never-asked", digest: "digest-one", allow: true });
	await until(() => events(a).filter((e) => e.reason === "confirm-answer-unexpected").length === 3, 3000, "three drops");
	assert.deepEqual(a.got, [], "nothing reached the tower");
	await forgeAnswer(bob, 53, { dialogId: "D1", digest: "digest-one", allow: false });
	await until(() => a.got.length === 1, 3000, "the right answer");
	assert.deepEqual(a.got[0], ["tower-a", "D1", false]);
	await forgeAnswer(bob, 54, { dialogId: "D1", digest: "digest-one", allow: true });
	await until(() => events(a).filter((e) => e.reason === "confirm-answer-unexpected").length === 4, 3000, "the replay dropped");
	assert.equal(a.got.length, 1, "a second answer for the same dialog is a replay");
});

test("only a tower of a bound workspace can ask, and only a device of the team; a dialog the tower forgot cannot be answered later", async () => {
	world();
	const [a, b] = [rig("a"), rig("b")];
	await Promise.all([a.holder.start(), b.holder.start()]);
	assert.match((await ask(a, { fromSession: "someone-else" }) as { error: string }).error, /Only the tower of a workspace bound/);
	assert.match((await ask(a, { device: "z".repeat(26) }) as { error: string }).error, /not in the team/);
	assert.match((await ask(a, { team: "0".repeat(32) }) as { error: string }).error, /not running/);
	assert.deepEqual(await ask(a), { ok: true });
	a.holder.forgetConfirm("D1");
	await until(() => b.holder.confirmRequests().length === 1, 3000, "the request on B");
	await b.holder.answerConfirm("D1", true);
	await until(() => events(a).some((e) => e.reason === "confirm-answer-unexpected"), 3000, "the answer for a forgotten dialog dropped");
	assert.deepEqual(a.got, []);
});

// ---- Through two pi sessions -------------------------------------------------------------------------------------------------------------

const computers: Computer[] = [];
afterEach(async () => {
	for (const c of computers.splice(0)) await c.world.stopAll();
});
type Blocked = { block?: boolean; reason?: string } | undefined;
async function twoTowers(trust: Record<string, string>) {
	const a = computer(root, relay, "a", { ui: true, gateMs: 8000, trust });
	const b = computer(root, relay, "b", { ui: true });
	computers.push(a, b);
	await Promise.all([a.tower.start(), b.tower.start()]);
	await until(() => a.link.holding && b.link.holding, 3000, "both holders");
	const pending: { id: string }[] = [], closed: { by: string }[] = [];
	a.tower.on("straw-link:gate:pending", (d) => void pending.push(d as { id: string }));
	a.tower.on("straw-link:gate:closed", (d) => void closed.push(d as { by: string }));
	await a.tower.fire("message_start", { message: remoteMessage(bob, "bob-mac") });
	return { a, b, pending, closed };
}

test("at forward the sender's device is asked too: its allow lets the call run on this computer and closes the terminal's confirm; the page and terminal stay open until then", async () => {
	const { a, b, pending, closed } = await twoTowers({ [bob.id]: "forward" });
	const held = a.tower.fireResult("tool_call", { toolName: "bash", toolCallId: "tc-1", input: { command: "ls" } }) as Promise<Blocked>;
	await until(() => pending.length === 1 && a.tower.dialogs.length === 1, 3000, "the local dialogs");
	await untilAsync(async () => (await b.link.confirms()).length === 1, "the confirm on bob's device", 5000);
	const [req] = await b.link.confirms();
	assert.deepEqual([req!.dialogId === pending[0]!.id, req!.tool, req!.fromLabel], [true, "bash", "alice-mac"]);
	assert.match(req!.args, /"command": "ls"/);
	await b.link.answerConfirm(req!.dialogId, true);
	assert.equal(await held, undefined, "allowed by the sender's device");
	assert.deepEqual(closed.map((x) => x.by), ["forward"]);
	assert.equal(a.tower.dialogs[0]!.opts?.signal?.aborted, true);
});

test("at forward the sender's deny blocks the call", async () => {
	const forwardRun = await twoTowers({ [bob.id]: "forward" });
	const held = forwardRun.a.tower.fireResult("tool_call", { toolName: "bash", toolCallId: "tc-1", input: { command: "ls" } }) as Promise<Blocked>;
	await untilAsync(async () => (await forwardRun.b.link.confirms()).length === 1, "the confirm on bob's device", 5000);
	await forwardRun.b.link.answerConfirm((await forwardRun.b.link.confirms())[0]!.dialogId, false);
	assert.match((await held)!.reason!, /declined a remote request/);
});

test("the terminal's answer at forward ends the dialog: a late answer from the sender's device is dropped", async () => {
	const { a, b, pending } = await twoTowers({ [bob.id]: "forward" });
	const held = a.tower.fireResult("tool_call", { toolName: "bash", toolCallId: "tc-1", input: { command: "ls" } }) as Promise<Blocked>;
	await untilAsync(async () => (await b.link.confirms()).length === 1 && a.tower.dialogs.length === 1, "both asked", 5000);
	a.tower.dialogs[0]!.settle(false);
	assert.match((await held)!.reason!, /declined/);
	await b.link.answerConfirm(pending[0]!.id, true);
	const log = () => { try { return readFileSync(join(a.dir, "link.log"), "utf8"); } catch { return ""; } };
	await until(() => /confirm-answer-unexpected/.test(log()), 5000, "the late answer dropped on A");
});

test("at reply the gate stays on this computer: no request goes to the sender's device", async () => {
	const { a, b, pending } = await twoTowers({});
	const held = a.tower.fireResult("tool_call", { toolName: "bash", toolCallId: "tc-1", input: { command: "ls" } }) as Promise<Blocked>;
	await until(() => pending.length === 1 && a.tower.dialogs.length === 1, 3000, "the local dialogs");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal((await b.link.confirms()).length, 0);
	a.tower.dialogs[0]!.settle(true);
	assert.equal(await held, undefined);
});
