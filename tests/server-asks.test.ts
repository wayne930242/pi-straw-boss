import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { type AskEntry, createAsks } from "../src/server/asks.ts";
import { slotOf } from "../src/server/record.ts";
import { writeService } from "../src/server/towerstore.ts";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";

// The asks a local tower makes for its mains (docs/specs/2026-10-26-sb-backend.md, Replies for a main (D4)): `tower_send({ device, reply: true, for })` records an ask for 24 hours, and a `tower-reply`
// is the reply to it only from the device asked, once.

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-asks-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));
const DEV = "a".repeat(26), ASK = "b".repeat(32);
const entry = (over: Partial<AskEntry> = {}): AskEntry => ({ ask: ASK, envelope: "e".repeat(32), device: DEV, team: "t1", for: "main-1", forName: "docs-main", workspace: "wA", tower: "sb-tower-wa", at: 1000, expires: 1000 + 24 * 3600_000, ...over });
const rig = () => {
	const dir = join(root, "agent", "straw-boss");
	mkdirSync(dir, { recursive: true });
	const slot = slotOf(dir, { HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent") });
	writeService(slot, { workspace: "wA", label: "Alpha", id: "sb-tower-wa", name: "tower", pane: "wA:p1", tab: "wA:t1", created: "2026-10-28T00:00:00.000Z", seq: 0 });
	return slot;
};

test("an ask is taken by a reply from the device asked, once, for the main that asked", () => {
	let now = 2000;
	const asks = createAsks(rig(), () => now);
	asks.open(entry());
	assert.deepEqual(asks.openOf("wA").map((a) => a.ask), [ASK]);
	assert.equal(asks.take({ team: "t1", device: "c".repeat(26), ask: ASK }), undefined, "another device");
	assert.equal(asks.take({ team: "t2", device: DEV, ask: ASK }), undefined, "another team");
	assert.equal(asks.take({ team: "t1", device: DEV, ask: "f".repeat(32) }), undefined, "no such ask");
	assert.deepEqual(asks.take({ team: "t1", device: DEV, ask: ASK }), { main: "main-1", mainName: "docs-main", tower: "sb-tower-wa", workspace: "wA" });
	assert.equal(asks.take({ team: "t1", device: DEV, ask: ASK }), undefined, "once");
	assert.deepEqual(asks.openOf("wA"), []);
	now = 3000;
});

test("an ask expires after 24 hours, and the file keeps at most 50 open asks", () => {
	let now = 2000;
	const asks = createAsks(rig(), () => now);
	asks.open(entry());
	now = 1000 + 24 * 3600_000 + 1;
	assert.equal(asks.take({ team: "t1", device: DEV, ask: ASK }), undefined, "expired");
	assert.deepEqual(asks.openOf("wA"), []);
	now = 5000;
	for (let i = 0; i < 60; i++) asks.open(entry({ ask: i.toString(16).padStart(32, "0"), expires: now + 1000 }));
	assert.equal(asks.openOf("wA").length, 50);
	assert.equal(asks.openOf("wA")[0]!.ask, (10).toString(16).padStart(32, "0"), "the oldest went");
});

// --- the tool: tower_send with `for` in a local run ---------------------------------------------------------------------------------------------------------------

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
let world: TowerWorld;
const worlds: TowerWorld[] = [];
afterEach(async () => {
	for (const w of worlds.splice(0)) await w.close();
});
const ask = (w: TowerWorld, r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, w.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
async function localRun() {
	world = new TowerWorld();
	worlds.push(world);
	world.setFlag(true);
	const s = await world.start();
	await s.handle.ready;
	await ask(world, s, { cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")!.incoming({ id: "boss-1", name: "x" }, { id: "m0", content: { text: "go" } });
	await until(() => world.pis.size === 1, "the run");
	const [id, pi] = [...world.pis.entries()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	let got: Reply | undefined;
	await until(async () => ((got = await ask(world, s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	// A main in the workspace's tab, as the broker and Herdr list it.
	world.herdr.addPane("wA:p20", "wA:t1").tokens = { sb_role: "main" };
	world.sessions = [{ id: "main-1", name: "docs-main", herdrLocation: { paneId: "wA:p20", workspace: { id: "wA", label: "Alpha" } } } as never];
	return { s, token: String(got!.token) };
}

test("tower_send with for makes an ask id, sends it with the message, and records the ask for the main when the device takes ask ids", async () => {
	const { s, token } = await localRun();
	world.linkAnswers.set("send", (b) => ({ ok: true, text: "Sent.", details: { team: "t1", device: DEV, id: "e".repeat(32), asked: b.awaitsReply !== undefined } }));
	const done = await ask(world, s, { cmd: "run-tool", token, tool: "tower_send", args: { device: "someone", message: "is the deploy green?", reply: true, for: "docs-main" } });
	assert.equal(done.ok, true, JSON.stringify(done));
	const sent = world.linkCalls.at(-1)!.body;
	assert.match(String(sent.awaitsReply), /^[0-9a-f]{32}$/);
	assert.equal(sent.reply, true);
	assert.match(String(done.text), /The answer will come to docs-main directly/);
	const asks = createAsks(world.slot);
	assert.deepEqual(asks.openOf("wA").map((a) => [a.ask, a.for, a.forName, a.device, a.team, a.tower]), [[sent.awaitsReply, "main-1", "docs-main", DEV, "t1", "sb-tower-wa"]]);
	assert.deepEqual(asks.take({ team: "t1", device: DEV, ask: String(sent.awaitsReply) })?.mainName, "docs-main");
});

test("an ask to a device whose build takes no ask ids is sent plain, the answer says so, and nothing is recorded", async () => {
	const { s, token } = await localRun();
	world.linkAnswers.set("send", () => ({ ok: true, text: "Sent.", details: { team: "t1", device: DEV, id: "e".repeat(32), asked: false } }));
	const done = await ask(world, s, { cmd: "run-tool", token, tool: "tower_send", args: { device: "someone", message: "q", reply: true, for: "main-1" } });
	assert.equal(done.ok, true);
	assert.match(String(done.text), /will not come to docs-main: it will reach an ally run here/);
	assert.deepEqual(createAsks(world.slot).openOf("wA"), []);
});

test("for names a live main of the tower's workspace and needs reply: a member, a stranger, an ambiguous name, a missing reply, and for in an ally run are refused", async () => {
	const { s, token } = await localRun();
	world.herdr.addPane("wA:p21", "wA:t1").tokens = { sb_role: "member" };
	world.sessions.push({ id: "member-1", name: "plain", herdrLocation: { paneId: "wA:p21" } } as never);
	const send = (args: Record<string, unknown>) => ask(world, s, { cmd: "run-tool", token, tool: "tower_send", args: { device: "someone", message: "q", reply: true, ...args } });
	assert.match(String((await send({ for: "plain" })).error), /not a main of workspace Alpha/);
	assert.match(String((await send({ for: "ghost" })).error), /No live session/);
	assert.match(String((await send({ for: "docs-main", reply: false })).error), /has to expect a reply/);
	assert.match(String((await ask(world, s, { cmd: "run-tool", token, tool: "tower_send", args: { message: "q", for: "docs-main" } })).error), /go with a device/);
	assert.equal(world.linkCalls.length, 0, "nothing reached the holder");
});
