import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { bodyOf, fieldsOf } from "../src/header.ts";
import { addRoute, readRoutes } from "../src/server/allyroute.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";
import { SHA_A, SHA_B, SHA_C, slip } from "./train-fixtures.ts";

// The door of a project's integrator in the sb server (todo #151; the boss's choice of 2026-11-10: the box's tower opens the integrator itself, and an ally sends only the car slip): `boss_open_main` with `role: "integrator"` in a
// tower run. The run names a slip by its sender and its head; the server finds the `call_tower` (why=shared) it came in among the messages the run took, finds or opens the project's one integrator as the tower's own main, and
// forwards the slip as its sender wrote it. A main an ally run opened sends its slips to the ally runs of its device (allyroute.ts), so the door is the same there, and it is the only way an ally run reaches an integrator.

let world: TowerWorld;
let dir = "";
const noted: { fwd: string; from: string; to: string[]; text: string }[] = [];
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	noted.length = 0;
	dir = realpathSync(mkdtempSync(join(tmpdir(), "psb-integ-run-")));
	mkdirSync(join(dir, ".straw-boss"));
	mkdirSync(join(dir, ".git"));
	world.ally.projects.set("team-1", dir);
	writeFileSync(join(dir, ".straw-boss", "apps.json"), JSON.stringify({ integration: { project: "acme" }, apps: [{ name: "web", dir: "apps/web", integration: { base: "develop" } }, { name: "docs", dir: "docs" }] }));
	world.herdr.workspace("wA").worktree = { checkout_path: dir };
});
afterEach(async () => {
	await world.close();
	rmSync(dir, { recursive: true, force: true });
});

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV1 = "a".repeat(26), DEV2 = "b".repeat(26);
const PEER = { device: DEV1, label: `label-${DEV1}`, short: DEV1.slice(0, 6), team: "team-1", teamName: "Team One" };
const towerClient = () => world.client("sb-tower-wa")!;
const loc = (paneId: string) => ({ status: "ok", workspace: { id: "wA", label: "Alpha" }, tab: { id: "wA:t1", label: "work" }, paneId });
const callTower = (from: { id: string; name: string }, text: string, why = "shared") => `[straw net from=${from.name} id=${from.id} role=main workspace=Alpha kind=call_tower scope=tower to=x reply=expected why=${why}] ${text}`;
const COORD1 = { id: "main-1", name: "docs-main" }, COORD2 = { id: "main-2", name: "api-main" };
const slipA = slip({ coordinator: "main-1", accept: "none" }), slipB = slip({ coordinator: "main-2", head: SHA_B, tickets: "T-16", branch: "fix/t-16", accept: "none" });

/** A server whose tower opens tabs the way Herdr and pi would: the pi of a new tab joins under the name `--name` gave it, as a main, and as an integrator when that name is an integrator's. */
async function started(over: { startedAt?: number } = {}) {
	const s = await world.start({ towers: { ...world.options().options.towers, ...over, cars: { noteForward: (f: never) => void noted.push(f), noteTrain() {}, remoteOf: async () => undefined } as never } });
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const orig = world.herdr.onAgentStart!;
	let n = 0;
	world.herdr.onAgentStart = (p, args) => {
		orig(p, args);
		if (args.includes("--sb-run")) return;
		const name = args[args.indexOf("--name") + 1]!;
		p.tokens.sb_role = "main";
		if (/^integ \S+$/.test(name)) p.tokens.sb_duty = "integrator";
		world.sessions.push({ id: `opened-${++n}`, name, herdrLocation: loc(p.pane_id) as never });
	};
	return s;
}
const runIds = () => [...world.pis.keys()].filter((k) => /^[0-9a-f]{16}$/.test(k));
/** The nth run of this world, claimed, with every event waiting for it taken: its token and the ids of those events in order. */
async function claimed(s: Running, n: number, take = true) {
	await until(() => runIds().length >= n, `run ${n} to start`);
	const id = runIds()[n - 1]!, pi = world.pis.get(id)!;
	let got: Reply | undefined;
	await until(async () => ((got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })), got.ok && !got.wait), "the claim");
	const token = String(got!.token), ids: string[] = [], texts: string[] = [];
	while (take) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string; text: string } | undefined;
		if (!event) break;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
		ids.push(event.id);
		texts.push(event.text);
	}
	return { id, token, ids, texts, tool: (name: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) => ask(s, { cmd: "run-tool", token, tool: name, args, ...extra }) };
}
const finish = async (s: Running, run: { id: string; token: string }) => {
	assert.equal((await ask(s, { cmd: "run-done", token: run.token, note: "done" })).ok, true);
	world.live.delete(world.pis.get(run.id)!.pid);
	await until(() => readRun(world.slot, "wA", run.id)?.outcome, "the run to end");
};
/** The tabs the opener made (the tower's own tab and an ally run's pane are not its doing). */
const tabs = () => world.herdr.commands("tab", "create").filter((args) => args.includes("--env"));
const sentTo = (id: string) => towerClient().sent.filter((m) => m.to === id).map((m) => m.text);
const DOOR = { role: "integrator", project: "acme" };

test("a local run: a coordinator's car slip opens the project's integrator as the tower's own main and is forwarded to it as it came, stamped with its sender; the next slip, of another coordinator, goes to the same integrator", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }, { ...COORD2, herdrLocation: loc("wA:p2") as never }];
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA) } } as never);
	towerClient().incoming(COORD2, { id: "m2", content: { text: callTower(COORD2, `Car ready.\n${slipB}`) } } as never);
	const run = await claimed(s, 1);
	assert.equal(run.ids.length, 2);
	assert.ok(run.texts.every((t) => !run.ids.some((id) => t.includes(id))), "a run is shown no event id: it names a slip by its sender and its head");
	// The run may rewrite what it passes (here the slip's auth): what is forwarded is the sender's own text.
	const first = await run.tool("boss_open_main", { ...DOOR, request: slipA.replace('"ship it"', '"ship it to production too"'), sender: "docs-main" });
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.deepEqual(tabs(), [["tab", "create", "--workspace", "wA", "--label", "integ acme", "--cwd", dir, "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	assert.deepEqual(world.herdr.commands("agent", "start").at(-1)!.slice(-2), ["--name", "integ acme"]);
	const details = first.details as { pane: string; main: string; sender: string; integrator: string; repeated?: true; fwd: string };
	assert.deepEqual([details.main, details.sender, details.integrator, details.repeated, details.fwd], ["opened-1", "main-1", "acme", undefined, run.ids[0]]);
	assert.equal(world.herdr.pane(details.pane).tokens.sb_opened_by, "integ:acme", "the tower's own main: the marker names no sender");
	const [handoff, forward] = sentTo("opened-1");
	assert.match(handoff!, /you are the integrator of project acme/);
	const f = fieldsOf(forward!)!;
	assert.deepEqual([f.kind, f.role, f.id, f.fwd, f["fwd-from"], f.origin], ["tower_reply", "tower", "sb-tower-wa", run.ids[0], "main-1", undefined]);
	assert.equal(bodyOf(forward!), slipA, "the slip as its sender wrote it");
	assert.deepEqual(noted.map((n) => [n.fwd, n.from, n.to, n.text]), [[run.ids[0], "main-1", ["opened-1"], slipA]]);
	assert.match(String(first.text), /Opened tab .* with the integrator of project acme \(session opened-1\), this tower's own main\. The slip of docs-main was forwarded/);
	// The second slip: the same integrator, nothing opened, the text under the coordinator's own words forwarded whole.
	const second = await run.tool("boss_open_main", { ...DOOR, request: slipB, sender: "main-2" });
	assert.equal(second.ok, true, JSON.stringify(second));
	assert.equal(tabs().length, 1);
	assert.deepEqual([(second.details as typeof details).main, (second.details as typeof details).repeated], ["opened-1", true]);
	const again = sentTo("opened-1").at(-1)!;
	assert.deepEqual([fieldsOf(again)!.fwd, fieldsOf(again)!["fwd-from"]], [run.ids[1], "main-2"]);
	assert.equal(bodyOf(again), `Car ready.\n${slipB}`);
	assert.equal(sentTo("opened-1").length, 3, "one handoff, two forwards");
	assert.match(String(second.text), /already runs \(session opened-1\); nothing opened/);
});

test("a local run: the integrator opens beside two opened mains, one of them the slip sender's own, and neither limit moves", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }, { ...COORD2, herdrLocation: loc("wA:p2") as never }];
	for (const [tab, pane, by] of [["wA:t11", "wA:p11", "main-1"], ["wA:t12", "wA:p12", "main-2"]] as const) {
		world.herdr.addTab(tab, "main", pane);
		Object.assign(world.herdr.pane(pane).tokens, { sb_role: "main", sb_opened_by: by });
	}
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA) } } as never);
	const run = await claimed(s, 1);
	const full = await run.tool("boss_open_main", { request: "more work", sender: "api-main" });
	assert.match(String(full.error), /already has an opened main running/);
	const opened = await run.tool("boss_open_main", { ...DOOR, request: slipA, sender: "main-1" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal(tabs().length, 1);
	world.sessions.push({ id: "main-3", name: "third", herdrLocation: loc("wA:p3") as never });
	assert.match(String((await run.tool("boss_open_main", { request: "more work", sender: "third" })).error), /already has 2 mains opened by its tower \(the limit is 2\)/, "the integrator is not one of the two");
	assert.match(String((await run.tool("boss_open_main", { request: "more work", sender: "docs-main" })).error), /already has an opened main running/, "the sender's one main is not widened");
	assert.equal(tabs().length, 1);
});

test("a local run: an integrator is opened on a slip the run took as call_tower why=shared from that sender, and on nothing else", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }, { ...COORD2, herdrLocation: loc("wA:p2") as never }];
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA, "blocked") } } as never);
	towerClient().incoming(COORD2, { id: "m2", content: { text: callTower(COORD2, slipB) } } as never);
	towerClient().incoming(COORD2, { id: "m3", content: { text: callTower(COORD2, slip({ car: "docs", head: SHA_C, coordinator: "main-2" })) } } as never);
	const run = await claimed(s, 1);
	const before = towerClient().sent.length;
	const refused = async (args: Record<string, unknown>, why: RegExp) => {
		const got = await run.tool("boss_open_main", { ...DOOR, request: slipB, sender: "main-2", ...args });
		assert.equal(got.ok, false, JSON.stringify(args));
		assert.match(String(got.error), why, JSON.stringify(args));
	};
	await refused({ request: slipA, sender: "main-1" }, /No car slip with head a{12} from main-1 is among the call_tower messages \(why=shared\) this run took/); // it came as why=blocked
	await refused({ request: slipB, sender: "main-1" }, /No car slip with head b{12} from main-1/); // another session sent it
	await refused({ request: slip({ head: "d".repeat(40) }), sender: "main-2" }, /No car slip with head d{12}/); // the run made it up
	await refused({ request: "open an integrator for acme" }, /pass the slip as it came as the request/);
	await refused({ project: "../up" }, /The project of this workspace's checkout is acme/);
	await refused({ project: "beta" }, /The project of this workspace's checkout is acme \(integration\.project in .*apps\.json\), not "beta": the slip of its app web goes to integ acme and to no other project's integrator/);
	await refused({ request: slip({ car: "docs", head: SHA_C }), sender: "main-2" }, /app docs has no integration/);
	await refused({ role: "main" }, /role must be "train" or "integrator"/);
	assert.deepEqual(tabs(), []);
	assert.equal(towerClient().sent.length, before, "nothing was sent");
	assert.deepEqual(noted, []);
	// The run names no project: the checkout's own is read.
	const opened = await run.tool("boss_open_main", { role: "integrator", request: slipB, sender: "api-main" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal((opened.details as { integrator: string }).integrator, "acme");
	assert.match(String(opened.text), /with the integrator of project acme \(session opened-1\)/);
});

/** A main an ally run opened for DEV1, as the opener and the route table leave it: its pane marked `link:<device>`, and an `opened` row. */
function allyMain(id = "ally-main", pane = "wA:p21", device = DEV1) {
	world.herdr.addTab(`wA:t${pane.slice(4)}`, "main", pane);
	Object.assign(world.herdr.pane(pane).tokens, { sb_role: "main", sb_opened_by: `link:${device}` });
	world.sessions.push({ id, name: "main", herdrLocation: loc(pane) as never });
	addRoute(world.slot, "wA", { ...PEER, device, to: id, name: "main", kind: "opened", at: Date.now(), pane, level: "dispatch" }, Date.now());
	return { id, name: "main" };
}

test("an ally's car slip: its main's call_tower reaches the ally run of its device, whose one door opens the integrator as the tower's own main and forwards the slip as the main wrote it; the ally's own second main is still refused", async () => {
	const s = await started();
	world.ally.level.set(DEV1, "dispatch");
	world.ally.add("m1", DEV1, "ship MP-1 on your box");
	world.expose?.allyWaiting("sb-tower-wa");
	const first = await claimed(s, 1);
	const main = await first.tool("boss_open_main", { request: "ship MP-1 on your box", sender: `link:${DEV1}` });
	assert.equal(main.ok, true, JSON.stringify(main));
	assert.equal(world.herdr.pane((main.details as { pane: string }).pane).tokens.sb_opened_by, `link:${DEV1}`);
	await finish(s, first);
	// The ally's main (opened-1) finished its work and sends its car: the slip goes to its device's next ally run, never to a local run.
	const mine = slip({ coordinator: "opened-1", accept: "none" });
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r1", content: { text: callTower({ id: "opened-1", name: "main" }, mine) } } as never);
	const run = await claimed(s, 2);
	assert.equal(readRun(world.slot, "wA", run.id)!.device, DEV1);
	assert.equal(run.ids.length, 1);
	// What the ally asked for on 2026-11-10, a second main to be its integrator, stays refused: one main per sender.
	const second = await run.tool("boss_open_main", { request: "open a main tab `train integrator`", sender: `link:${DEV1}` });
	assert.match(String(second.error), /already has an opened main running in workspace Alpha; a sender gets one at a time/);
	assert.equal(tabs().length, 1);
	const opened = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: "opened-1" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal(tabs().length, 2);
	assert.equal(tabs()[1]![5], "integ acme");
	const details = opened.details as { pane: string; main: string; sender: string; integrator: string; fwd: string };
	assert.deepEqual([details.main, details.sender, details.integrator], ["opened-2", "opened-1", "acme"]);
	assert.equal(world.herdr.pane(details.pane).tokens.sb_opened_by, "integ:acme", "the tower's own main, not the device's");
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()).map((r) => [r.to, r.kind]), [["opened-1", "opened"]], "the integrator has no ally route: its reports reach the local runs");
	const [handoff, forward] = sentTo("opened-2");
	assert.match(handoff!, /you are the integrator of project acme/);
	assert.doesNotMatch(handoff!, /teammate|Straw Link/);
	const f = fieldsOf(forward!)!;
	assert.match(f.fwd!, /^[0-9a-f]{16}$/);
	assert.deepEqual([f.kind, f.role, f.id, f["fwd-from"], f.origin, f.fwd], ["tower_reply", "tower", "sb-tower-wa", "opened-1", `remote:${DEV1}`, details.fwd]);
	assert.equal(bodyOf(forward!), mine);
	assert.deepEqual(noted.map((n) => [n.fwd, n.from, n.to, n.text]), [[details.fwd, "opened-1", ["opened-2"], mine]]);
	await finish(s, run);
	// The next car of the same main, in the next run of the device: the same integrator.
	const next = slip({ coordinator: "opened-1", head: SHA_B, tickets: "T-16", branch: "fix/t-16", accept: "none" });
	towerClient().incoming({ id: "opened-1", name: "main" }, { id: "r2", content: { text: callTower({ id: "opened-1", name: "main" }, next) } } as never);
	const third = await claimed(s, 3);
	const same = await third.tool("boss_open_main", { ...DOOR, request: next, sender: "opened-1" });
	assert.equal(same.ok, true, JSON.stringify(same));
	assert.deepEqual([(same.details as { main: string }).main, (same.details as { repeated?: true }).repeated], ["opened-2", true]);
	assert.equal(tabs().length, 2, "no second integrator");
	assert.equal(bodyOf(sentTo("opened-2").at(-1)!), next);
	assert.notEqual(fieldsOf(sentTo("opened-2").at(-1)!)!.fwd, details.fwd);
});

test("a peer's main is no project's integrator: one that carries the name and the kind gets no slip, by its pane token (the tower opens its own) and by the route table (nothing is sent)", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }];
	// A main an ally run opened renamed itself and declared the kind.
	allyMain("ally-main", "wA:p21");
	world.sessions.find((x) => x.id === "ally-main")!.name = "integ acme";
	world.herdr.pane("wA:p21").tokens.sb_duty = "integrator";
	Object.assign(world.herdr.pane("wA:p21"), { cwd: dir }); // it works in this checkout, as the main of this workspace it is
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA) } } as never);
	const run = await claimed(s, 1);
	// Its pane token cleared (a process of the same user can write it): the route table still says whose it is.
	world.herdr.pane("wA:p21").tokens.sb_opened_by = "";
	const held = await run.tool("boss_open_main", { ...DOOR, request: slipA, sender: "main-1" });
	assert.match(String(held.error), /was opened for a teammate's device, so no slip goes to it/);
	assert.deepEqual(tabs(), []);
	assert.equal(sentTo("ally-main").length, 0);
	assert.deepEqual(noted, []);
	// With its token in place it is not taken for the integrator at all, and the tower opens its own.
	world.herdr.pane("wA:p21").tokens.sb_opened_by = `link:${DEV1}`;
	const opened = await run.tool("boss_open_main", { ...DOOR, request: slipA, sender: "main-1" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal((opened.details as { main: string }).main, "opened-1");
	assert.equal(tabs().length, 1);
	assert.equal(sentTo("ally-main").length, 0);
});

test("an ally run has no other door to an integrator: a slip it made up, a slip of a session not opened for its device, a main whose pane names another device, a train, and a forward are refused before the gate, and nothing opens", async () => {
	const s = await started();
	const main = allyMain();
	world.sessions.push({ ...COORD1, herdrLocation: loc("wA:p1") as never });
	// A local main an ally run wrote to (an `expect` route): its next message to the tower reaches the device's run too, and is no door.
	addRoute(world.slot, "wA", { ...PEER, to: "main-1", name: "docs-main", kind: "expect", at: Date.now() }, Date.now());
	world.ally.level.set(DEV1, "forward");
	const mine = slip({ coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "r1", content: { text: callTower(main, mine) } } as never);
	towerClient().incoming(COORD1, { id: "r2", content: { text: callTower(COORD1, slipB.replace("main-2", "main-1")) } } as never);
	world.expose?.allyWaiting("sb-tower-wa");
	const run = await claimed(s, 1);
	assert.equal(run.ids.length, 2);
	const refused = async (args: Record<string, unknown>, why: RegExp) => {
		for (const extra of [{}, { toolCallId: "tc-1" }]) {
			const got = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id, ...args }, extra);
			assert.equal(got.ok, false, JSON.stringify(args));
			assert.match(String(got.error), why, JSON.stringify(args));
		}
	};
	const NONE = /No car slip with head [0-9a-f]{12} from .* is among the call_tower messages \(why=shared\) this run took from a main opened for its sender/;
	await refused({ request: slip({ head: SHA_C, coordinator: main.id }) }, NONE);
	await refused({ request: slipB, sender: "main-1" }, NONE);
	await refused({ request: "open a main tab `train integrator`" }, /pass the slip as it came as the request/);
	await refused({ role: "train", request: "project: acme\ncode: 2026-11-10-a" }, /An ally run opens no train/);
	await refused({ forward: "0123456789abcdef" }, /An ally run forwards no car slip/);
	world.herdr.pane("wA:p21").tokens.sb_opened_by = `link:${DEV2}`;
	await refused({}, NONE);
	world.herdr.pane("wA:p21").tokens.sb_opened_by = `link:${DEV1}`;
	// The real slip, below `dispatch`: the open waits for the boss's Allow like any main an ally run opens.
	const gated = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id });
	assert.match(String(gated.error), /needs the boss's confirm/);
	assert.deepEqual(tabs(), []);
	assert.deepEqual(noted, []);
	assert.equal(sentTo("main-1").length + sentTo(main.id).length, 0);
});

test("an ally run at dispatch: a slip of a main opened for another device's sender is no door, and its own main's is", async () => {
	const s = await started();
	const main = allyMain(), other = allyMain("other-main", "wA:p22", DEV2);
	world.ally.level.set(DEV1, "dispatch");
	const mine = slip({ coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "r1", content: { text: callTower(main, mine) } } as never);
	world.expose?.allyWaiting("sb-tower-wa");
	// A slip that waits for the run but that the run has not taken is not yet its to name.
	const run = await claimed(s, 1, false);
	assert.equal(readRun(world.slot, "wA", run.id)!.device, DEV1);
	assert.match(String((await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id })).error), /No car slip with head/);
	const offered = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: run.token, id: offered.id })).ok, true);
	const got = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: other.id });
	assert.match(String(got.error), /No car slip with head/);
	assert.deepEqual(tabs(), []);
	const opened = await run.tool("boss_open_main", { ...DOOR, request: mine, sender: "main" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal((opened.details as { sender: string }).sender, main.id);
	assert.equal(tabs().length, 1);
});

// --- review fixes (R151-F001, F004, F005) ---------------------------------------------------------------------------------------------------------------------

test("a local run: a slip that waits in the queue is no door until this run took it", async () => {
	const s = await started();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }];
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipA) } } as never);
	const run = await claimed(s, 1, false);
	assert.match(String((await run.tool("boss_open_main", { ...DOOR, request: slipA, sender: "main-1" })).error), /No car slip with head a{12} from main-1 is among the call_tower messages \(why=shared\) this run took/);
	assert.deepEqual(tabs(), []);
	const offered = (await ask(s, { cmd: "run-poll", token: run.token, idle: true })).event as { id: string };
	assert.equal((await ask(s, { cmd: "run-taken", token: run.token, id: offered.id })).ok, true);
	assert.equal((await run.tool("boss_open_main", { ...DOOR, request: slipA, sender: "main-1" })).ok, true);
});

test("a main opened for a teammate's device has no local door: its slip that reached a local run is refused by its pane token, and by a route table of any workspace when the token is gone; nothing opens and nothing is forwarded", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	// Opened for DEV1 by the tower of workspace wB: wA's table has no row for it, so its call_tower to wA's tower is a plain local event there (as when its route aged out, or a local run's newer expectation outranked it).
	const main = { id: "ally-main", name: "main" };
	world.herdr.addTab("wA:t21", "main", "wA:p21");
	Object.assign(world.herdr.pane("wA:p21").tokens, { sb_role: "main", sb_opened_by: `link:${DEV1}` });
	world.sessions = [{ ...main, herdrLocation: loc("wA:p21") as never }, { ...COORD1, herdrLocation: loc("wA:p1") as never }];
	const mine = slip({ coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "m1", content: { text: callTower(main, mine) } } as never);
	towerClient().incoming(COORD1, { id: "m2", content: { text: callTower(COORD1, slipB.replace("main-2", "main-1")) } } as never);
	const run = await claimed(s, 1);
	assert.equal(readRun(world.slot, "wA", run.id)!.device, undefined, "a local run took it");
	assert.equal(run.ids.length, 2);
	const before = towerClient().sent.length;
	const PEERS = /main \(session ally-main\) was opened for a teammate's device, so its slip is a peer's: it reaches the integrator through the ally run of its device, which marks it origin=remote and asks the boss below dispatch, and never through a local run/;
	// The pane token is the first witness.
	assert.match(String((await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id })).error), PEERS);
	// The 0.73 forward has the same two witnesses: the id of a peer's slip stamps nothing (RR151-F002).
	assert.match(String((await run.tool("tower_reply", { to: "main-1", message: mine, forward: run.ids[0] })).error), PEERS);
	// A token a process of the same user cleared: the route table of the workspace that opened it still says whose it is.
	world.herdr.pane("wA:p21").tokens.sb_opened_by = "";
	addRoute(world.slot, "wB", { ...PEER, to: main.id, name: "main", kind: "opened", at: Date.now(), pane: "wA:p21", level: "dispatch" }, Date.now());
	assert.match(String((await run.tool("boss_open_main", { ...DOOR, request: mine, sender: "main" })).error), PEERS);
	assert.match(String((await run.tool("tower_reply", { to: "main-1", message: mine, forward: run.ids[0] })).error), PEERS);
	assert.deepEqual(tabs(), []);
	assert.equal(towerClient().sent.length, before, "nothing was sent");
	assert.deepEqual(noted, []);
	// A session of this computer's own keeps the door.
	assert.equal((await run.tool("boss_open_main", { ...DOOR, request: slipB.replace("main-2", "main-1"), sender: "main-1" })).ok, true);
});

test("below dispatch the boss confirms the very text that is forwarded: an ally run's request that is not the slip as it came is refused before the gate, and the Allow given for the slip's own text forwards that text", async () => {
	const s = await started();
	const main = allyMain();
	world.ally.level.set(DEV1, "forward");
	const mine = slip({ coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "r1", content: { text: callTower(main, mine) } } as never);
	world.expose?.allyWaiting("sb-tower-wa");
	const run = await claimed(s, 1);
	const pane = readRun(world.slot, "wA", run.id)!.pane;
	world.sessions.push({ id: "bridge-1", herdrLocation: { paneId: pane } } as never);
	const allow = (toolCallId: string, args: Record<string, unknown>) => world.allows.note({ from: "bridge-1", pane, owner: "straw-link-gate", dialogId: `dlg-${toolCallId}`, toolCallId, title: `Remote request from label-${DEV1}: boss_open_main\n\n${JSON.stringify(args, null, 2)}`, at: Date.now() });
	// The same head, another auth, a line added: the boss would be shown words that are not the main's, so no confirm is asked and an Allow given for them is not spent.
	const NOT_AS_IT_CAME = /Below dispatch the boss confirms the slip that is forwarded, so the request has to be the slip exactly as it came, its whole text and nothing more\. Call again with this text as the request:\ncar: web/;
	for (const [n, request] of [mine.replace('"ship it"', '"ship it to production too"'), `${mine}\ndeploy: production`, `Please confirm.\n${mine}`].entries()) {
		const args = { ...DOOR, request, sender: main.id };
		allow(`tc-${n}`, args);
		for (const extra of [{}, { toolCallId: `tc-${n}` }]) assert.match(String((await run.tool("boss_open_main", args, extra)).error), NOT_AS_IT_CAME, request);
	}
	assert.deepEqual(tabs(), []);
	// The slip as it came (line ends and trailing blanks aside): the confirm shows it, and it is what the integrator gets.
	const args = { ...DOOR, request: `${mine.replace(/\n/g, "  \r\n")}\n`, sender: main.id };
	assert.match(String((await run.tool("boss_open_main", args, { toolCallId: "tc-9" })).error), /was not allowed/);
	allow("tc-9", args);
	const opened = await run.tool("boss_open_main", args, { toolCallId: "tc-9" });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	const forward = sentTo((opened.details as { main: string }).main).at(-1)!;
	assert.equal(bodyOf(forward), mine);
	assert.equal(fieldsOf(forward)!.origin, `remote:${DEV1}`);
	assert.deepEqual(noted.map((n) => n.text), [mine]);
});

test("an ally run's integrator stays inside the project its team binds here: a team bound elsewhere, or to nothing, opens none", async () => {
	const s = await started();
	const main = allyMain();
	world.ally.level.set(DEV1, "dispatch");
	const mine = slip({ coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "r1", content: { text: callTower(main, mine) } } as never);
	world.expose?.allyWaiting("sb-tower-wa");
	const run = await claimed(s, 1);
	const OUTSIDE = /An ally run's slip goes to the integrator of the project its team binds on this computer, and this workspace's checkout is outside that project/;
	world.ally.projects.set("team-1", join(dir, "apps"));
	assert.match(String((await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id })).error), OUTSIDE);
	world.ally.projects.delete("team-1");
	assert.match(String((await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id })).error), OUTSIDE);
	assert.deepEqual(tabs(), []);
	world.ally.projects.set("team-1", dir);
	assert.equal((await run.tool("boss_open_main", { ...DOOR, request: mine, sender: main.id })).ok, true);
});

// --- a project that already runs integrators of its own (0.73: the boss's, one per app) ---------------------------------------------------------------------------------------

/** A checkout like the boss's MP Center: the folder `moldplan-center`, apps.json under `.claude/straw-boss` with a top-level `integration` that names no project, and two apps that take the train. */
function mpCenter(): string {
	const repo = join(dir, "moldplan-center");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, ".claude", "straw-boss"), { recursive: true });
	writeFileSync(join(repo, ".claude", "straw-boss", "apps.json"), JSON.stringify({ integration: { skill: "integrate", maxCars: 4, maxWaitMin: 60 }, apps: [{ name: "rest-api-v3", dir: "apps/rest-api-v3", integration: { base: "develop" } }, { name: "moldplan-frontend-2", dir: "apps/moldplan-frontend-2", integration: { base: "develop" } }, { name: "docs", dir: "docs" }] }));
	world.herdr.workspace("wA").worktree = { checkout_path: repo };
	return repo;
}
/** A main of kind integrator the boss opened under a name of its own: no tower marked its pane. */
function bossIntegrator(id: string, name: string, pane: string, cwd?: string) {
	world.herdr.addTab(`wA:t${pane.slice(4)}`, name, pane);
	Object.assign(world.herdr.pane(pane).tokens, { sb_role: "main", sb_duty: "integrator" });
	if (cwd !== undefined) Object.assign(world.herdr.pane(pane), { cwd });
	world.sessions.push({ id, name, herdrLocation: loc(pane) as never });
}

test("a project that already runs integrators of its own, one per app (integ FE2 and integ v3 in the checkout moldplan-center): the door opens nothing, names both and the slip's event id, and tower_reply with that forward stamps the slip and reaches the one the run picks", async () => {
	const s = await started();
	const repo = mpCenter(), slipFE = slip({ car: "moldplan-frontend-2", coordinator: "main-1", accept: "none" });
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }];
	// One works in a folder outside the checkout (a train's worktree, say), the other in its app's own repository below it; both are in the tower's workspace, which is what places them in the project.
	mkdirSync(join(repo, "apps", "rest-api-v3", ".git"), { recursive: true });
	bossIntegrator("integ-fe2", "integ FE2", "wA:p31", dir);
	bossIntegrator("integ-v3", "integ v3", "wA:p32", join(repo, "apps", "rest-api-v3"));
	// Each kept integrator's ledger folder carries its own word (integ FE2 keeps trains/FE2): the ledger rule is about what the door opens, so it does not stand before the kept ones (RR151-F001).
	mkdirSync(join(world.stateDir, "trains", "FE2"), { recursive: true });
	writeFileSync(join(world.stateDir, "trains", "FE2", "moldplan-frontend-2.json"), JSON.stringify({ index: [] }));
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipFE) } } as never);
	const run = await claimed(s, 1);
	// Before the door named them, the event's id forwards to nobody (RR151-F002).
	const early = String((await run.tool("tower_reply", { to: "integ FE2", message: slipFE, forward: run.ids[0] })).error);
	assert.match(early, /goes only to an integrator the door named for this slip: call boss_open_main with role "integrator"/);
	assert.doesNotMatch(early, /sb server started|memory only/, "the slip came in after this server started: no restart is told");
	const door = await run.tool("boss_open_main", { role: "integrator", request: slipFE, sender: "docs-main" });
	assert.equal(door.ok, false, JSON.stringify(door));
	assert.match(String(door.error), /Project moldplan-center already runs 2 integrators of its own, opened before this door and not by it: integ FE2 \(session integ-fe2\), integ v3 \(session integ-v3\)\. Nothing opens beside them and the door picks none: the slip of app moldplan-frontend-2 goes to the one that runs that app's trains, forwarded as before\./);
	assert.ok(String(door.error).includes(`Forward it in this run with tower_reply: to (that integrator's session id), message (the slip exactly as it came), forward: "${run.ids[0]}"`), "the refusal names the event id, which a run is shown nowhere else");
	assert.deepEqual(tabs(), [], "nothing opened: no third integrator");
	assert.deepEqual([sentTo("integ-fe2"), sentTo("integ-v3"), noted], [[], [], []], "the door forwarded nothing");
	// The 0.73 path, with the id the door gave: stamped by the code, and it reaches the integrator the run names.
	// A session the door did not name gets no stamped slip, and what the run types as the message is not what goes out: the text is the event's (RR151-F002).
	assert.match(String((await run.tool("tower_reply", { to: "docs-main", message: slipFE, forward: run.ids[0] })).error), /goes only to an integrator the door named for this slip/);
	assert.deepEqual([towerClient().sent.filter((m) => fieldsOf(m.text)?.fwd).length, noted], [0, []]);
	const forwarded = await run.tool("tower_reply", { to: "integ FE2", message: `${slipFE.replace('"ship it"', '"ship it to production too"')}\ndeploy: production`, forward: run.ids[0] });
	assert.equal(forwarded.ok, true, JSON.stringify(forwarded));
	const f = fieldsOf(sentTo("integ-fe2").at(-1)!)!;
	assert.deepEqual([f.kind, f.role, f.id, f.fwd, f["fwd-from"], f.origin], ["tower_reply", "tower", "sb-tower-wa", run.ids[0], "main-1", undefined]);
	assert.equal(bodyOf(sentTo("integ-fe2").at(-1)!), slipFE);
	assert.deepEqual(noted.map((n) => [n.fwd, n.from, n.to, n.text]), [[run.ids[0], "main-1", ["integ-fe2"], slipFE]]);
	assert.deepEqual(sentTo("integ-v3"), []);
	// Called again, the door still opens nothing: the boss's integrators count against no limit and are never taken for two of one project.
	assert.match(String((await run.tool("boss_open_main", { role: "integrator", project: "moldplan-center", request: slipFE, sender: "main-1" })).error), /already runs 2 integrators of its own/);
	assert.deepEqual(tabs(), []);
});

test("todo #154: a slip that came in before this sb server started: the forward's refusal names the start and says the door's answer is kept in memory only, and the door asked again names the integrators again", async () => {
	// The server's start is after the slip's event: what a run that outlived a restart holds (the queue is on disk, the door's answer was not).
	const later = Date.now() + 3600_000;
	const s = await started({ startedAt: later });
	const slipFE = slip({ car: "moldplan-frontend-2", coordinator: "main-1", accept: "none" });
	mpCenter();
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }];
	bossIntegrator("integ-fe2", "integ FE2", "wA:p31", dir);
	// A message id of this test's own: the door's answers live in the module for the process's life, and an event's id follows from its message's.
	towerClient().incoming(COORD1, { id: "m154", content: { text: callTower(COORD1, slipFE) } } as never);
	const run = await claimed(s, 1);
	const refusal = String((await run.tool("tower_reply", { to: "integ FE2", message: slipFE, forward: run.ids[0] })).error);
	assert.match(refusal, /goes only to an integrator the door named for this slip: call boss_open_main with role "integrator"/);
	assert.ok(refusal.includes(`The sb server started at ${new Date(later).toISOString()}, after this slip came in, and keeps the door's answer in memory only: if the door named this slip's integrators before that, its answer is gone with the restart, so ask the door again the same way and forward then.`), refusal);
	assert.deepEqual([sentTo("integ-fe2"), noted], [[], []], "nothing was forwarded");
	// Asked again, the door names the kept integrator and the forward goes through.
	assert.match(String((await run.tool("boss_open_main", { role: "integrator", request: slipFE, sender: "docs-main" })).error), /forwarded as before/);
	assert.equal((await run.tool("tower_reply", { to: "integ FE2", message: slipFE, forward: run.ids[0] })).ok, true);
	assert.deepEqual(noted.map((n) => [n.fwd, n.to]), [[run.ids[0], ["integ-fe2"]]]);
});

test("a box-like checkout of the same shape with no integrator yet still opens one, named after its folder, and the slip is forwarded to it by the door", async () => {
	const s = await started();
	const repo = mpCenter(), slipFE = slip({ car: "moldplan-frontend-2", coordinator: "main-1", accept: "none" });
	world.sessions = [{ ...COORD1, herdrLocation: loc("wA:p1") as never }];
	towerClient().incoming(COORD1, { id: "m1", content: { text: callTower(COORD1, slipFE) } } as never);
	const run = await claimed(s, 1);
	const door = await run.tool("boss_open_main", { role: "integrator", request: slipFE, sender: "docs-main" });
	assert.equal(door.ok, true, JSON.stringify(door));
	assert.deepEqual(tabs(), [["tab", "create", "--workspace", "wA", "--label", "integ moldplan-center", "--cwd", repo, "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	const main = (door.details as { main: string }).main;
	assert.deepEqual([fieldsOf(sentTo(main).at(-1)!)!.fwd, fieldsOf(sentTo(main).at(-1)!)!["fwd-from"]], [run.ids[0], "main-1"]);
});

test("an ally run in a project that runs integrators of its own: the door opens nothing and gives no event id, since an ally run forwards no slip; a main opened for a device that answers as such an integrator is named as a peer's and gets none", async () => {
	const s = await started();
	const repo = mpCenter(), main = allyMain();
	world.ally.projects.set("team-1", repo);
	world.ally.level.set(DEV1, "dispatch");
	bossIntegrator("integ-fe2", "integ FE2", "wA:p31", repo);
	const mine = slip({ car: "moldplan-frontend-2", coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "r1", content: { text: callTower(main, mine) } } as never);
	world.expose?.allyWaiting("sb-tower-wa");
	const run = await claimed(s, 1);
	assert.equal(readRun(world.slot, "wA", run.id)!.device, DEV1);
	const door = await run.tool("boss_open_main", { role: "integrator", request: mine, sender: main.id });
	assert.match(String(door.error), /Project moldplan-center already runs an integrator of its own, opened before this door and not by it: integ FE2 \(session integ-fe2\)\. Nothing opens beside it and the door picks none.* An ally run forwards no slip: tell the sender that its car waits for the boss of this computer/);
	assert.doesNotMatch(String(door.error), /forward: "/, "no event id for a run that may not forward");
	assert.deepEqual(tabs(), []);
	assert.deepEqual([sentTo("integ-fe2"), noted], [[], []]);
	// A second main of that device calls itself an integrator and cleared its pane token: the route table still says whose it is, so it is not offered as a target.
	const peers = allyMain("peer-integ", "wA:p22");
	world.sessions.find((x) => x.id === peers.id)!.name = "integ web";
	Object.assign(world.herdr.pane("wA:p22").tokens, { sb_duty: "integrator", sb_opened_by: "" });
	const held = await run.tool("boss_open_main", { role: "integrator", request: mine, sender: main.id });
	assert.match(String(held.error), /integ web \(session peer-integ\) answers as an integrator of this project and was opened for a teammate's device, so no slip goes to it and nothing opens beside it/);
	assert.deepEqual(tabs(), []);
});

test("an ally run below dispatch in a project that runs integrators of its own is refused before the gate: the boss is asked nothing for a call the opener refuses (RR151-F005)", async () => {
	const s = await started();
	const repo = mpCenter(), main = allyMain();
	world.ally.projects.set("team-1", repo);
	world.ally.level.set(DEV1, "forward");
	bossIntegrator("integ-fe2", "integ FE2", "wA:p31", repo);
	const mine = slip({ car: "moldplan-frontend-2", coordinator: main.id, accept: "none" });
	towerClient().incoming(main, { id: "r1", content: { text: callTower(main, mine) } } as never);
	world.expose?.allyWaiting("sb-tower-wa");
	const run = await claimed(s, 1);
	// With no tool call id and no Allow the answer is already the opener's: the gate was not reached.
	for (const extra of [{}, { toolCallId: "tc-1" }]) {
		const door = await run.tool("boss_open_main", { role: "integrator", request: mine, sender: main.id }, extra);
		assert.match(String(door.error), /Project moldplan-center already runs an integrator of its own.* An ally run forwards no slip/);
		assert.doesNotMatch(String(door.error), /confirm|not allowed|forward: "/);
	}
	assert.deepEqual([tabs(), sentTo("integ-fe2"), noted], [[], [], []]);
});
