import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { argsDigest } from "../src/server/allows.ts";
import { callControl } from "../src/server/socket.ts";
import { existsSync } from "node:fs";
import { guiNamespace } from "../src/bridgewire.ts";
import { selectDigest } from "../src/owners.ts";
import { lastNote, listRuns, readExpects, readRun } from "../src/server/towerrunstore.ts";
import { readLedger, readQueue } from "../src/server/towerstore.ts";

// The ally runs of the tower service (docs/specs/2026-10-26-sb-backend.md, Ally runs, The wake protocol, The brief; B6) against a fake Herdr, a fake link holder (`world.ally`), and a pi that is a test:
// a message of a teammate's device that waits for the tower identity gets a run of its own in a pane split off the tower's tab, claimed over the control socket like a local run.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const setup = async (over: Parameters<TowerWorld["start"]>[0] = {}) => {
	const s = await world.start(over);
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, ensured };
};
const DEV1 = "a".repeat(26), DEV2 = "b".repeat(26);
/** The nth run the server started (1-based), once its pid is recorded; its workspace record. */
const nthRun = async (n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
const claimed = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	return got;
};
const poll = (s: Running, token: string) => ask(s, { cmd: "run-poll", token, idle: true });
const taken = (s: Running, token: string, id: unknown) => ask(s, { cmd: "run-taken", token, id });
const drain = async (s: Running, token: string) => {
	const events: { id: string; kind: string; text: string }[] = [];
	for (;;) {
		const event = (await poll(s, token)).event as (typeof events)[number] | undefined;
		if (!event) return events;
		assert.equal((await taken(s, token, event.id)).ok, true);
		events.push(event);
	}
};
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);
const require_ = (f: string) => readFileSync(join(world.slot.dir, f), "utf8");
const nthAlly = (n = 1) => listRuns(world.slot, "wA").filter((r) => r.kind === "ally")[n - 1];


test("RV7 e2e: no gui.json (gui: false): a gated ally call allowed by the terminal's yes relayed to the server's own hub is taken by the server's own Allows", async () => {
	world.serverAllows = true;
	const { s } = await setup({ gui: false });
	assert.equal(existsSync(join(world.slot.dir, "gui.json")), false, "no gui.json");
	const hub = JSON.parse(require_("hub.json"));
	const serverSession = world.record()!.intercomId!;
	assert.equal(hub.ownerSession, serverSession);
	world.ally.add("m1", DEV1, "question", { awaitsReply: "e".repeat(32), replyExpected: true });
	world.expose?.allyWaiting("sb-tower-wa");
	const id = await nthRun();
	const token = String((await claimed(s, id)).token);
	const pane = readRun(world.slot, "wA", id)!.pane;
	world.sessions = [{ id: "main-1", name: "docs-main", herdrLocation: { paneId: "wA:p1" } } as never, { id: "bridge-1", herdrLocation: { paneId: pane } } as never];
	const run = (tool: string, args: Record<string, unknown>, toolCallId?: string) => ask(s, { cmd: "run-tool", token, tool, args, ...(toolCallId ? { toolCallId } : {}) });
	const args = { to: "main-1", message: "please look" };
	assert.match(String((await run("tower_reply", args, "tc-9")).error), /not allowed|no Allow/, "no yes yet: refused");
	const main = world.client(serverSession)!;
	assert.ok(main, "server main client");
	const select = { title: `Remote request from label-${DEV1}: tower_reply\n\n${JSON.stringify(args, null, 2)}`, choices: [{ label: "Allow" }, { label: "Deny" }] };
	const gate = { owner: "straw-link-gate", id: "dlg-1", toolCallId: "tc-9", digest: selectDigest(select), select };
	const send = (payload: unknown) => main.broker({ type: "extension_message", namespace: guiNamespace(serverSession), fromSessionId: "bridge-1", payload } as never);
	send({ version: 1, type: "dialogs", bridgeId: "B", pane, file: null, dialogs: [gate], closed: [] });
	send({ version: 1, type: "dialogs", bridgeId: "B", pane, file: null, dialogs: [], closed: [{ id: "dlg-1", by: "terminal", allow: true }] });
	const sent = await run("tower_reply", args, "tc-9");
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.match(String((await run("tower_reply", args, "tc-9")).error), /was not allowed/, "used once");
	// a terminal close without allow is no Allow
	const gate2 = { ...gate, id: "dlg-2", toolCallId: "tc-10" };
	send({ version: 1, type: "dialogs", bridgeId: "B", pane, file: null, dialogs: [gate2], closed: [] });
	send({ version: 1, type: "dialogs", bridgeId: "B", pane, file: null, dialogs: [], closed: [{ id: "dlg-2", by: "terminal" }] });
	assert.equal((await run("tower_reply", args, "tc-10")).ok, false, "a close with no yes");
});
