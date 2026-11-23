import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { type FakeKid, TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { listRuns, readRun } from "../src/server/towerrunstore.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { lfSplitter, runEnv, shimTarget, stdinRecord } from "../src/server/runchild.ts";

// Headless tower runs (docs/specs/2026-11-23-lite-b2-d-e-f.md §4.8, test 1; behind `towerRuns.headless`): every run is a `pi --mode rpc` child of the server, claimed by its PID and nonce with no pane. The world's spawn
// makes a FakeKid; the test claims, polls, and ends it over the control socket as the run's extension does. Red on 0.84.0: no run is spawned, a run starts with `herdr agent start` in the standing pane.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true, undefined, true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const tower = (ws = "wa") => world.client(`sb-tower-${ws}`)!;
const from = { id: "main-1", name: "docs-main" };
const msg = (id: string, text: string) => ({ id, content: { text } });
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA", view: false });
	assert.equal(ensured.ok, true, JSON.stringify(ensured));
	await until(() => tower(), "the tower identity to register");
	return s;
};
const kid = async (n = 1): Promise<FakeKid> => {
	await until(() => world.kids.size >= n, `headless run ${n} to spawn`);
	return [...world.kids.values()][n - 1]!;
};
const claim = (s: Running, k: FakeKid, over: Record<string, unknown> = {}) => ask(s, { cmd: "claim", runId: k.run, pane: "", pid: k.pid, nonce: k.nonce, liveBrief: true, ...over });
const poll = (s: Running, token: string, idle = true) => ask(s, { cmd: "run-poll", token, idle });

test("a headless run is pi in RPC mode as the server's child: no pane, no Herdr start, a clean environment with its nonce, and a claim by PID and nonce", async () => {
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const k = await kid();
	assert.equal(k.file, "/fake/node");
	assert.deepEqual(k.args.slice(0, 3), ["/fake/pi/dist/cli.js", "--mode", "rpc"]);
	assert.ok(k.args.includes("--sb-run") && k.args.includes("--tools"), k.args.join(" "));
	assert.deepEqual(world.herdr.commands("agent", "start"), [], "no pi started in a pane");
	assert.deepEqual(world.herdr.commands("tab", "create"), [], "and no tab made for the service or the run");
	assert.match(k.nonce, /^[0-9a-f]{32}$/);
	assert.equal(Object.keys(k.env).filter((key) => /^(HERDR_|PI_SUBAGENT_|PI_INTERCOM_SESSION_ID$)/.test(key) || (key.startsWith("STRAW_BOSS_") && key !== "STRAW_BOSS_RUN_NONCE")).length, 0, "none of the server's own, Herdr's, or a subagent's names");
	assert.match(String((await claim(s, k, { pid: k.pid + 1 })).error), /PID or the nonce/, "a claim from another process is refused");
	assert.match(String((await claim(s, k, { nonce: "0".repeat(32) })).error), /PID or the nonce/, "a claim without the nonce is refused");
	const got = await claim(s, k);
	assert.equal(got.ok, true, JSON.stringify(got));
	assert.match(String((await claim(s, k)).error), /claimed already/, "a second claim is refused");
	const rec = readRun(world.slot, "wA", k.run)!;
	assert.equal(rec.headless, true);
	assert.equal(rec.pid, k.pid);
	assert.equal(rec.pane, "");
});

test("events reach a headless run at its idle poll, and tower_done then its exit end it done", async () => {
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const k = await kid();
	const token = String((await claim(s, k)).token);
	const event = (await poll(s, token)).event as { id: string; text: string };
	assert.match(event.text, /one/);
	assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "handled one" })).ok, true);
	k.exit(0);
	await until(() => readRun(world.slot, "wA", k.run)?.outcome, "the run to end");
	assert.equal(readRun(world.slot, "wA", k.run)!.outcome, "done");
	assert.equal(readQueue(world.slot, "wA").length, 0, "the event it handled is gone");
});

test("a headless run that exits non-zero without tower_done crashed: its events come back flagged, seen at the exit", async () => {
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const k = await kid();
	const token = String((await claim(s, k)).token);
	const event = (await poll(s, token)).event as { id: string };
	await ask(s, { cmd: "run-taken", token, id: event.id });
	k.exit(1);
	await until(() => readRun(world.slot, "wA", k.run)?.outcome, "the run to end");
	assert.equal(readRun(world.slot, "wA", k.run)!.outcome, "crashed");
	const back = readQueue(world.slot, "wA").find((e) => e.id === event.id)!;
	assert.equal(back.flag, "crash");
	assert.equal(back.taken, undefined);
});

for (const platform of ["darwin", "win32"] as const) {
	test(`a headless run that stops polling is killed by ${platform === "win32" ? "taskkill /T /F" : "its process group"} and ends crashed`, async () => {
		world.runTimers = { lost: 300 };
		world.kidPlatform = platform;
		const s = await setup();
		tower().incoming(from, msg("m1", "one"));
		const k = await kid();
		await claim(s, k);
		await until(() => world.kidKills.length > 0, "the hung run to be killed");
		assert.deepEqual(world.kidKills[0], [k.pid, platform === "win32" ? "taskkill" : "group"]);
		await until(() => readRun(world.slot, "wA", k.run)?.outcome, "the run to end");
		assert.equal(readRun(world.slot, "wA", k.run)!.outcome, "crashed");
	});
}

test("a server restart drains headless runs: no new run starts, an idle one's stdin closes, and its untaken events stay queued", async () => {
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const k = await kid();
	const token = String((await claim(s, k)).token);
	await poll(s, token, false);
	const runs = world.expose!.runs;
	const draining = runs.drain(5000);
	await poll(s, token, true); // the run settles (idle), with the event still untaken
	await until(() => k.stdinEnded, "the drained run's stdin to close");
	k.exit(0);
	assert.equal(await draining, 1);
	assert.equal(readRun(world.slot, "wA", k.run)!.outcome, "quit");
	tower().incoming(from, msg("m2", "two"));
	await new Promise((r) => setTimeout(r, 200));
	assert.equal(world.kids.size, 1, "no run starts while the server drains");
	assert.ok(readQueue(world.slot, "wA").some((e) => e.text.includes("one")), "the untaken event waits for the next server");
	assert.equal(listRuns(world.slot, "wA").length, 1);
});

test("the stdin writer takes abort, extension_ui_response and get_state only; stdout splits on LF alone; the env drops the server's names; an npm shim names its JS", () => {
	assert.equal(stdinRecord({ type: "abort" }), '{"type":"abort"}\n');
	for (const type of ["prompt", "steer", "follow_up", "bash", "new_session", "switch_session", "set_model"]) assert.throws(() => stdinRecord({ type } as never), /writes no/);
	const got: string[] = [];
	const split = lfSplitter((l) => got.push(l));
	split.push('{"a":"x\u2028y"}\r\n{"b"');
	split.push(":1}\n");
	assert.deepEqual(got, ['{"a":"x\u2028y"}', '{"b":1}']);
	const env = runEnv({ PATH: "/bin", HERDR_PANE_ID: "p1", STRAW_BOSS_ROLE: "tower", PI_SUBAGENT_ID: "s", PI_INTERCOM_SESSION_ID: "i", HOME: "/h" }, "n1");
	assert.deepEqual(env, { PATH: "/bin", HOME: "/h", STRAW_BOSS_RUN_NONCE: "n1" });
	assert.equal(shimTarget("C:/npm/pi.cmd", '@IF EXIST "%dp0%\\node.exe" (\r\n  "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js" %*\r\n)'), "C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js");
});

test("an ally run is headless too: no pane split, its sender's gate (no --tools); a boss event for the workspace is never delivered into it, and waits for a local run", async () => {
	const s = await setup();
	world.ally.add("m1", "a".repeat(26), "hello from afar");
	world.expose?.allyWaiting("sb-tower-wa");
	const k = await kid();
	assert.deepEqual(world.herdr.commands("pane", "split"), [], "no pane split off a tab");
	assert.ok(!k.args.includes("--tools"), "an ally run keeps its sender's gate");
	const got = await claim(s, k);
	assert.equal(got.ok, true, JSON.stringify(got));
	assert.equal(got.kind, "ally");
	const token = String(got.token);
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "boss words", present: true })).ok, true);
	const offered: string[] = [];
	for (let event = (await poll(s, token)).event as { id: string; kind: string } | undefined; event; event = (await poll(s, token)).event as typeof event) {
		offered.push(event.kind);
		await ask(s, { cmd: "run-taken", token, id: event.id });
	}
	assert.deepEqual(offered, ["link"], "the ally run gets its device's message only");
	const local = await kid(2);
	assert.ok(local.args.includes("--tools"), "the boss's words woke a local run");
});

test("a Herdr restart leaves a headless run going: it is no process of Herdr's, so nothing ends it and its claim is not held", async () => {
	const s = await setup();
	tower().incoming(from, msg("m1", "one"));
	const k = await kid();
	const token = String((await claim(s, k)).token);
	world.losts.forEach((lost) => lost());
	world.takeovers.forEach((take) => take());
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(readRun(world.slot, "wA", k.run)!.outcome, undefined, "still running");
	assert.equal((await poll(s, token)).ok, true);
	assert.equal(k.stdinEnded, false);
});
