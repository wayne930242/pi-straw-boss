import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { listRuns, readRun } from "../src/server/towerrunstore.ts";

// RVVM-A3 / RVVM-A6 (Windows VM recheck of 51a5256): a run whose pi died because Herdr went away ends `herdr-restart` and never counts as a crash (A3); an ally run that ends takes its messages out before the device
// may be served again, and an item that was taken is never admitted a second time (A6).
let world: TowerWorld;
beforeEach(() => { world = new TowerWorld(); world.setFlag(true); });
afterEach(() => world.close());
type Reply = Record<string, unknown> & { ok: boolean };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV = "a".repeat(26), DEV1 = DEV, DEV2 = "b".repeat(26), FILE = "/fake/2026-10-29T00-00-00Z_sess1.jsonl";
const outcome = (id: string) => readRun(world.slot, "wA", id)?.outcome;
const allyRuns = () => listRuns(world.slot, "wA").filter((r) => r.kind === "ally");
async function claimedAlly() {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.add("m1", DEV, "hello");
	world.ally.level.set(DEV, "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	const token = String(got.token);
	await ask(s, { cmd: "run-file", token, file: FILE, session: "sess1" });
	return { s, id, pane: pi.pane, pid: pi.pid, token };
}
/** The pi takes every message it is offered and ends the run with its note. */
async function finishRun(s: Running, token: string) {
	for (;;) {
		const ev = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!ev) break;
		await ask(s, { cmd: "run-taken", token, id: ev.id });
	}
	assert.equal((await ask(s, { cmd: "run-done", token, note: "done" })).ok, true);
}
const lose = () => { for (const cb of world.losts) cb(); };
const takeover = () => { for (const cb of world.takeovers) cb(); };
const crashes = async (s: Running) => ((await ask(s, { cmd: "status" })).towers as { service: { crashes?: number; notices: { kind: string }[] } }[])[0]!.service;

// --- A6 ---------------------------------------------------------------------------------------------------------------------------------------------------------

test("A6: a poke while an ending ally run is still handing its message back starts no second run for it", async () => {
	const { s, id, pid, token } = await claimedAlly();
	let release!: () => void;
	world.ally.takenGate = new Promise<void>((r) => (release = r));
	await finishRun(s, token);
	world.live.delete(pid); // the pi leaves; the run's end goes on to tell the holder the message is taken, which takes its time
	await until(() => world.ally.takenCalls > 0, "the end to reach the holder");
	world.expose!.runs.pokeAllies("sb-tower-wa"); // the holder's drain tells the server a message waits, as it does at every pass
	await sleep(250);
	assert.equal(world.settingsCalls, 1, "no second run was begun for the message while the first run's end still holds it");
	release();
	await until(() => outcome(id) === "done", "done");
	await sleep(300);
	assert.equal(allyRuns().length, 1, JSON.stringify(allyRuns().map((r) => [r.id, r.admitted, r.events])));
	assert.equal(world.pis.size, 1, "one pi was started for the one message");
	assert.deepEqual(world.ally.takenIds, ["m1"]);
});

test("A6: the holder still lists the message after the server said it was taken (its inbox file goes under a lock): no second run for it", async () => {
	world.ally.lingering = true;
	const { s, id, pid, token } = await claimedAlly();
	await finishRun(s, token);
	world.live.delete(pid);
	await until(() => outcome(id) === "done", "done");
	world.expose!.runs.pokeAllies("sb-tower-wa");
	await sleep(400);
	assert.equal(world.settingsCalls, 1, "no run was begun for it");
	assert.equal(allyRuns().length, 1, JSON.stringify(allyRuns().map((r) => [r.id, r.admitted, r.events])));
	assert.equal(world.pis.size, 1);
	// A message that arrives later is served as usual.
	world.ally.add("m2", DEV, "again");
	world.expose!.runs.pokeAllies("sb-tower-wa");
	await until(() => world.pis.size === 2, "the run for the new message");
	assert.deepEqual(allyRuns().map((r) => r.admitted), [["m1"], ["m2"]]);
});

test("A6: an item that is gone from the holder's list by the time the run's pane is ready starts no run (nothing is left to give it)", async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const h = world.herdr;
	let release!: () => void;
	world.settingsHold = new Promise<void>((r) => (release = r));
	world.ally.add("m1", DEV, "hello");
	world.ally.level.set(DEV, "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await sleep(250); // the run is admitted and waits for the settings check
	world.ally.takenIds.push("m1"); // another server took it meanwhile
	release();
	await sleep(400);
	assert.equal(world.pis.size, 0, "no pi for a message that is not there");
	assert.equal(h.commands("pane", "split").length, 0, "no pane was split for it");
	assert.equal(allyRuns().length, 0);
});

// --- A3 ---------------------------------------------------------------------------------------------------------------------------------------------------------

test("A3: Herdr's socket closed, then the ally pi died with it: the run waits for the takeover and ends herdr-restart, and no crash is counted", async () => {
	const { id, pid } = await claimedAlly();
	lose();
	world.live.delete(pid);
	await sleep(400); // many watch ticks
	assert.equal(outcome(id), undefined, "the run is not ended as a crash before the takeover decides");
	world.herdr.restart(false);
	takeover();
	await until(() => outcome(id) === "herdr-restart", "herdr-restart", 3000);
	assert.equal(readRun(world.slot, "wA", id)?.detail, undefined);
	assert.equal(world.ally.takenIds.length, 0, "the message stays for the run that follows");
});

test("A3: the pi died at once and the socket closed a little later (a clean stop): the verdict is not taken at the first tick", async () => {
	const { id, pid } = await claimedAlly();
	let seen = 0;
	world.aliveHook = (p) => {
		if (p === pid && !world.live.has(p) && ++seen === 2) lose();
	};
	world.live.delete(pid);
	await until(() => seen >= 3, "ticks after the loss", 3000);
	assert.equal(outcome(id), undefined);
	takeover();
	await until(() => outcome(id) === "herdr-restart", "herdr-restart", 3000);
});

test("A3: the pi died while a Herdr takeover is under way (its look is not done): the takeover ends the run, not the watch tick", async () => {
	const { id, pid } = await claimedAlly();
	const h = world.herdr;
	let release!: () => void;
	h.paneListGate = new Promise<void>((r) => (release = r));
	takeover();
	await until(() => h.gated > 0, "the takeover's look");
	world.live.delete(pid);
	await sleep(300);
	assert.equal(outcome(id), undefined);
	release();
	await until(() => outcome(id) === "herdr-restart", "herdr-restart", 3000);
});

test("A3: three runs in a row whose pi died with Herdr hold nothing: the next message still gets a run", async () => {
	const { s } = await claimedAlly();
	for (let n = 1; n <= 3; n++) {
		const id = [...world.pis.keys()][n - 1]!, pid = world.pis.get(id)!.pid;
		await until(() => readRun(world.slot, "wA", id)?.claimed === true || n === 1, "claimed");
		lose();
		world.live.delete(pid);
		await sleep(150);
		takeover();
		await until(() => outcome(id) === "herdr-restart", `run ${n} herdr-restart`, 3000);
		if (n < 3) {
			await until(() => world.pis.size === n + 1, `the redelivery run ${n + 1}`, 5000);
			const next = [...world.pis.keys()][n]!, pi = world.pis.get(next)!;
			await until(() => readRun(world.slot, "wA", next)?.pid, "pid");
			assert.equal((await ask(s, { cmd: "claim", runId: next, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })).ok, true);
		}
	}
	await until(() => world.pis.size === 4, "a run after three restarts", 5000);
	const status = await crashes(s);
	assert.ok(!status.notices.some((n) => n.kind === "loop"), "no crash loop notice");
});

test("A3: the loss is forgotten when the takeover is done: a pi that dies after it is a crash", async () => {
	const { s, id, pid } = await claimedAlly();
	lose();
	world.live.delete(pid);
	takeover();
	await until(() => outcome(id) === "herdr-restart", "herdr-restart", 3000);
	await until(() => world.pis.size === 2, "the redelivery run", 5000);
	const next = [...world.pis.keys()][1]!, pi = world.pis.get(next)!;
	await until(() => readRun(world.slot, "wA", next)?.pid, "pid");
	assert.equal((await ask(s, { cmd: "claim", runId: next, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })).ok, true);
	world.live.delete(pi.pid);
	await until(() => outcome(next) === "crashed", "crashed", 3000);
});

test("A3: a pi that dies while Herdr is up is still a crash (two ticks later, with the lost signal absent)", async () => {
	const { id, pid } = await claimedAlly();
	world.live.delete(pid);
	await until(() => outcome(id) === "crashed", "crashed", 3000);
	assert.match(String(readRun(world.slot, "wA", id)?.detail), /pi exited without tower_done/);
});

test("A3: Herdr is lost and never comes back: after the run timers' `lost` the pi's death is a crash again", async () => {
	world.runTimers = { lost: 600 };
	const { id, pid } = await claimedAlly();
	lose();
	world.live.delete(pid);
	await sleep(250);
	assert.equal(outcome(id), undefined);
	await until(() => outcome(id) === "crashed", "crashed", 3000);
});

test("A3: a local run too: its pi died with Herdr, the lost signal came first: herdr-restart, no crash counted", async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "one" } });
	await until(() => world.pis.size >= 1, "the local run");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "pid");
	assert.equal((await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })).ok, true);
	lose();
	world.live.delete(pi.pid);
	await sleep(300);
	assert.equal(outcome(id), undefined);
	world.herdr.restart(false);
	takeover();
	await until(() => outcome(id) === "herdr-restart", "herdr-restart", 3000);
	assert.equal((await crashes(s)).crashes ?? 0, 0);
});

test("RVAE-F001 (A6 double start): two devices waiting, a poke while the first device's run starts: the second device gets two runs for one message", async () => {
	world.runMax = 6;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	let release!: () => void;
	world.settingsHold = new Promise<void>((r) => (release = r));
	world.ally.add("m1", DEV1, "one");
	world.ally.add("m2", DEV2, "two");
	world.ally.level.set(DEV1, "forward");
	world.ally.level.set(DEV2, "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.settingsCalls >= 1, "the first begin (DEV1) waits on settings");
	world.expose!.runs.pokeAllies("sb-tower-wa"); // the holder's drain pass, every 5 s in production
	await until(() => world.settingsCalls >= 2, "a second beginAllies begins DEV2");
	release();
	await sleep(1500);
	const runs = allyRuns().map((r) => ({ device: r.device === DEV1 ? "DEV1" : "DEV2", admitted: r.admitted }));
	const dev2 = runs.filter((r) => r.device === "DEV2");
	assert.equal(dev2.length, 1, `DEV2 must have one run for m2, got ${JSON.stringify(dev2)}`);
});

test("RVAE-F002 (A3 stale goneSeen): a one-tick gone sighting long before; later the pi dies a tick before the socket closes: ended crashed, not herdr-restart", async () => {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.add("m1", DEV1, "hello");
	world.ally.level.set(DEV1, "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	await ask(s, { cmd: "run-file", token: String(got.token), file: FILE, session: "sess1" });
	// One sighting of the pid as not alive (a transient misread), then alive again.
	let n = 0;
	world.aliveHook = (p) => {
		if (p !== pi.pid) return;
		n++;
		if (n === 1) world.live.delete(p);
		else if (n === 2) world.live.add(p);
	};
	await until(() => n >= 4, "ticks after the blip");
	assert.equal(outcome(id), undefined, "the run lived through the blip");
	// Now the A3 clean stop: the pi dies, the socket closes at the second sighting.
	let seen = 0;
	world.aliveHook = (p) => {
		if (p === pi.pid && !world.live.has(p) && ++seen === 2) lose();
	};
	world.live.delete(pi.pid);
	await until(() => seen >= 2 || outcome(id) !== undefined, "sightings", 3000);
	await sleep(100);
	takeover();
	await until(() => outcome(id) !== undefined, "an outcome", 3000);
	assert.equal(outcome(id), "herdr-restart");
});

test("RVAE-F003 (ally-gone frees a slot without release): max 1, an ally run admitted, a local event blocked; the ally run finds nothing left: the local event waits", async () => {
	world.runMax = 1;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	let release!: () => void;
	world.settingsHold = new Promise<void>((r) => (release = r));
	world.ally.add("m1", DEV1, "hello");
	world.ally.level.set(DEV1, "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.settingsCalls >= 1, "the ally run waits on settings");
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, { id: "e1", content: { text: "one" } });
	await sleep(300); // the local wake finds no slot: blocked
	world.ally.takenIds.push("m1"); // another server took the message
	release();
	await sleep(1500);
	assert.equal(world.pis.size, 1, "the local event got its run once the slot was free");
});
