import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { wireId } from "../src/board.ts";
import { createCloser } from "../src/closer.ts";
import { selectDigest } from "../src/owners.ts";
import { addRoute, dropOpened, readRoutes, setStop, spendRoute } from "../src/server/allyroute.ts";
import { createRevoker, type OpenedMain } from "../src/server/revoke.ts";
import { mainsOf } from "../src/server/unitstop.ts";
import type { RunSignal } from "../src/server/runs.ts";
import { callControl } from "../src/server/socket.ts";
import { towerPanel } from "../src/server/towerpanel.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { until as untilWorld, World } from "./fakes.ts";

// Todo #100 task 3 (docs/specs/2026-11-07-link-remote-stop.md, section 5): a stop the box accepted is written on the route row and carried out by the revoker as a second reason, on its first sweep and whatever
// the device's level is; the main of this build answers an `interrupt` by aborting its turn; the route keeps the stop through renewals, restarts, and the row caps.

const DEV = "n".repeat(26), ADM = "m".repeat(26), OTHER = "o".repeat(26), T = "t".repeat(16), BOX = "x".repeat(26);
const STOP = { by: ADM, at: 1_000, stopId: "0".repeat(32), mode: "quit" };
const main = (over: Partial<OpenedMain> = {}): OpenedMain => ({ workspace: "wA", label: "Alpha", main: "m-1", name: "main", device: DEV, team: T, deviceLabel: "dev-mac", level: "dispatch", stop: STOP, ...over });
const stopSignals = (signals: RunSignal[]) => signals.flatMap((s) => (s.kind === "main-stop" ? [[s.outcome, s.main, s.stopId, s.device, s.team] as const] : []));

function rig(rows: OpenedMain[], levels: Record<string, string | undefined> = {}) {
	const closes: string[] = [], forgot: string[] = [], signals: RunSignal[] = [], logs: Record<string, unknown>[] = [], audits: Record<string, unknown>[] = [];
	const world = { rows, levels, closeError: undefined as string | undefined, known: true, paneGone: true, errors: [] as (string | undefined)[], told: true };
	const revoker = createRevoker({
		opened: () => world.rows, known: () => world.known,
		standing: (device) => (world.levels[device] ? { level: world.levels[device]! } : undefined),
		close: async (workspace, m, mode) => {
			closes.push(`${workspace}/${m}/${mode ?? "quit"}`);
			const next = world.errors.length ? world.errors.shift() : world.closeError;
			if (next) throw new Error(next);
		},
		paneGone: async () => world.paneGone,
		forget: (workspace, m) => void (forgot.push(`${workspace}/${m}`), (world.rows = world.rows.filter((x) => !(x.workspace === workspace && x.main === m)))),
		label: (_team, device) => (device === ADM ? "admin-mac" : "dev-mac"),
		signal: (s) => (signals.push(s), world.told), log: (e) => void logs.push(e), audit: (e) => void audits.push(e),
	});
	return { revoker, closes, forgot, signals, logs, audits, world };
}

test("a stopped main is asked on the first sweep, whatever the device's level and whether or not the holder can read the roster; the mode goes with the ask", async () => {
	const r = rig([main(), main({ main: "m-2", stop: { ...STOP, mode: "interrupt", stopId: "1".repeat(32) } })], { [DEV]: "dispatch" });
	r.world.known = false;
	await r.revoker.sweep();
	assert.deepEqual(r.closes, ["wA/m-1/quit", "wA/m-2/interrupt"], "a signed stop is no read of the policy: no second look, no level");
});

test("a main with no stop on it keeps the revoke rules: a device still at dispatch ends nothing", async () => {
	const r = rig([main({ stop: undefined })], { [DEV]: "dispatch" });
	await r.revoker.sweep();
	await r.revoker.sweep();
	assert.deepEqual(r.closes, []);
});

test("a stop that is busy is told once as pending, asked again at every sweep, and a quit ends it with main-stopped, the route let go, and a unit-stop-done line", async () => {
	const r = rig([main()], { [DEV]: "dispatch" });
	r.world.closeError = "main is working; try again when it is idle";
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	assert.equal(r.closes.length, 3);
	assert.deepEqual(stopSignals(r.signals), [["pending", "m-1", STOP.stopId, DEV, T]], "told once");
	const pending = r.signals[0]!;
	assert.ok(pending.kind === "main-stop" && /admin-mac/.test(pending.text) && /busy|working/.test(pending.text));
	r.world.closeError = undefined;
	await r.revoker.sweep();
	assert.deepEqual(stopSignals(r.signals).map((s) => s[0]), ["pending", "stopped"]);
	assert.deepEqual(r.forgot, ["wA/m-1"]);
	assert.deepEqual(r.audits.map((a) => [a.event, a.stopId, a.workspace, a.main]), [["unit-stop-done", STOP.stopId, "wA", "m-1"]]);
	await r.revoker.sweep();
	assert.equal(r.closes.length, 4, "a forgotten main is asked no more");
});

test("a stopped main that is gone needs two sweeps and its pane absent, then goes (told as gone); a pane Herdr still lists keeps it, and the admins are told it still runs", async () => {
	const gone = rig([main({ pane: "p-1" })]);
	gone.world.closeError = "No live session is named or has the id \"m-1\"";
	await gone.revoker.sweep();
	assert.deepEqual(gone.forgot, [], "one miss forgets nothing");
	await gone.revoker.sweep();
	assert.deepEqual(gone.forgot, ["wA/m-1"]);
	assert.deepEqual(stopSignals(gone.signals).map((x) => x[0]), ["stopped"], "told as gone, since the requester sees the main leave the list");
	const still = rig([main({ pane: "p-1" })]);
	still.world.closeError = "No live session is named or has the id \"m-1\"";
	still.world.paneGone = false;
	for (let i = 0; i < 4; i++) await still.revoker.sweep();
	assert.deepEqual(still.forgot, []);
	assert.deepEqual(stopSignals(still.signals).map((s) => s[0]), ["pending"]);
});

test("a main the box cannot end (the boss opened it) is told once as main-stop-manual, not as pending", async () => {
	const r = rig([main({ pane: "p-1" })]);
	r.world.closeError = "main was not opened by a tower (the boss opened it), so only the boss closes it";
	r.world.paneGone = false;
	for (let i = 0; i < 4; i++) await r.revoker.sweep();
	assert.deepEqual(stopSignals(r.signals).map((s) => s[0]), ["manual"]);
	assert.match((r.signals[0] as { text: string }).text, /Close it by hand/);
});

test("a notice nobody could be told of is sent again at a later sweep", async () => {
	const r = rig([main()]);
	r.world.closeError = "main is working; try again when it is idle";
	r.world.told = false;
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	assert.equal(r.signals.length, 3, "asked again each sweep while nobody was told");
	r.world.told = true;
	for (let i = 0; i < 3; i++) await r.revoker.sweep();
	assert.equal(r.signals.length, 4, "once told, never again");
});

test("a main that lost its device's dispatch and has a stop is told by the stop's notices, not the revoke's", async () => {
	const r = rig([main()], { [DEV]: "reply" });
	r.world.closeError = "main is working; try again when it is idle";
	await r.revoker.sweep();
	await r.revoker.sweep();
	assert.deepEqual(r.signals.map((s) => s.kind), ["main-stop"]);
});

test("USB-F001: the requester's label and reason are in the pending, manual and stopped notices, never in a key or an audit line", async () => {
	const stop = { ...STOP, reason: "the build is wedged" };
	const r = rig([main({ stop })]);
	r.world.closeError = "main is working; try again when it is idle";
	await r.revoker.sweep();
	r.world.closeError = undefined;
	await r.revoker.sweep();
	const texts = r.signals.map((x) => (x as { text: string }).text);
	assert.equal(texts.length, 2);
	for (const text of texts) assert.match(text, /admin-mac|Reason: the build is wedged/);
	assert.ok(texts.every((t) => /Reason: the build is wedged$/.test(t)), texts.join("|"));
	assert.ok(!JSON.stringify([r.audits, r.logs]).includes("wedged"), "link.log and the server log hold no reason");
	const manual = rig([main({ stop, pane: "p-1" })]);
	manual.world.closeError = "main was not opened by a tower (the boss opened it), so only the boss closes it";
	manual.world.paneGone = false;
	await manual.revoker.sweep();
	await manual.revoker.sweep();
	assert.match((manual.signals[0] as { text: string }).text, /Close it by hand\. Reason: the build is wedged$/);
	const none = rig([main()]);
	await none.revoker.sweep();
	assert.ok(!/Reason/.test((none.signals[0] as { text: string }).text), "a stop with no reason says none");
});

test("USB-F003: a notice never carries the raw session id the broker's miss names", async () => {
	for (const stop of [STOP, undefined]) {
		const r = rig([main({ main: "sess-secret-id", ...(stop ? { stop } : { stop: undefined }) })], { [DEV]: "reply" });
		r.world.closeError = 'No live session is named or has the id "sess-secret-id"';
		r.world.paneGone = false;
		for (let i = 0; i < 4; i++) await r.revoker.sweep();
		assert.ok(r.signals.length >= 1);
		assert.ok(!r.signals.map((x) => (x as { text: string }).text).join("|").includes("sess-secret-id"));
		assert.ok(r.signals.every((x) => /pane is still open/.test((x as { text: string }).text)));
		assert.ok(!r.signals.some((x) => /busy/.test((x as { text: string }).text)), "nothing is busy");
	}
});

test("USB-F004: a stop that ends as gone is audited as unit-stop-done (outcome gone) and told as main-stopped", async () => {
	const r = rig([main({ pane: "p-1", stop: { ...STOP, reason: "why" } })]);
	r.world.closeError = 'No live session is named or has the id "m-1"';
	await r.revoker.sweep();
	assert.deepEqual([r.audits, r.signals], [[], []], "one miss ends nothing");
	await r.revoker.sweep();
	assert.deepEqual(r.audits.map((a) => [a.event, a.stopId, a.main, a.outcome]), [["unit-stop-done", STOP.stopId, "m-1", "gone"]]);
	assert.deepEqual(stopSignals(r.signals), [["stopped", "m-1", STOP.stopId, DEV, T]]);
	assert.match((r.signals[0] as { text: string }).text, /gone.*Reason: why/);
	assert.ok(!JSON.stringify(r.audits).includes("why"));
	const plain = rig([main({ pane: "p-1", stop: undefined })], { [DEV]: undefined });
	plain.world.closeError = 'No live session is named or has the id "m-1"';
	for (let i = 0; i < 3; i++) await plain.revoker.sweep();
	assert.deepEqual([plain.audits, plain.signals], [[], []], "a revoke that ends as gone is as it was");
});

test("USB-F005: a revoke's pending notice does not swallow the stop's pending notice", async () => {
	const r = rig([main({ stop: undefined })], { [DEV]: "reply" });
	r.world.closeError = "main is working; try again when it is idle";
	await r.revoker.sweep();
	await r.revoker.sweep();
	assert.deepEqual(r.signals.map((x) => x.kind), ["revoked"]);
	r.world.rows = [main()];
	await r.revoker.sweep();
	await r.revoker.sweep();
	assert.deepEqual(r.signals.map((x) => x.kind), ["revoked", "main-stop"]);
});

test("USB-F006: a stop written while a sweep is in flight is followed by one more pass that reads it; a plain sweep joins as before", async () => {
	let release!: () => void;
	const gate = new Promise<void>((res) => (release = res));
	const closes: string[] = [];
	const world = { rows: [main({ main: "other" })] };
	const revoker = createRevoker({
		opened: () => world.rows.slice(), known: () => true, standing: () => ({ level: "dispatch" }),
		close: async (_w, m) => { closes.push(m); if (m === "other" && closes.length === 1) await gate; throw new Error("main is working; try again when it is idle"); },
		paneGone: async () => false, forget: () => {}, signal: () => true, log: () => {},
	});
	const first = revoker.sweep();
	world.rows.push(main({ main: "new" }));
	assert.equal(revoker.sweep(), first, "a timer sweep joins the pass in flight and adds none");
	const followed = revoker.sweep(true);
	assert.equal(followed, first, "the one chain of passes");
	release();
	await followed;
	assert.deepEqual(closes, ["other", "other", "new"], "the second pass read the row written after the first began");
	await revoker.sweep();
	assert.equal(closes.length, 5, "an idle revoker starts a pass at once");
});

test("USB-F008: a stop ignores the device's level: a row opened at reply, held at reply, is asked on the first sweep", async () => {
	const r = rig([main({ level: "reply" })], { [DEV]: "reply" });
	await r.revoker.sweep();
	assert.deepEqual(r.closes, ["wA/m-1/quit"]);
	const plain = rig([main({ level: "reply", stop: undefined })], { [DEV]: "reply" });
	await plain.revoker.sweep();
	await plain.revoker.sweep();
	assert.deepEqual(plain.closes, [], "without a stop a row opened below dispatch is left alone");
});

test("USB-F008: mains is empty unless the box is known, the tower service stands, and the team shares status", async () => {
	const facts = async () => [{ row: main({ stop: undefined }), name: "tester", state: "idle" }];
	const ask = (over: Partial<Parameters<typeof mainsOf>[1]>) => mainsOf({ team: T, device: DEV }, { box: BOX, share: "status", admin: () => false, facts, ...over });
	assert.equal((await ask({})).length, 1);
	assert.deepEqual(await ask({ share: "none" }), []);
	assert.deepEqual(await ask({ share: undefined }), []);
	assert.deepEqual(await ask({ box: undefined }), []);
	assert.deepEqual(await ask({ facts: undefined }), []);
});

// The route row: the stop is written on it and outlives a server restart (it is on the file), a report that renews the row, a re-add, and the caps.
let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());
const peer = (device: string) => ({ device, label: "l", short: "s", team: T, teamName: "tn" });
const opened = (device: string, to: string, at: number) => ({ ...peer(device), to, name: "opened main", kind: "opened" as const, at });

test("setStop writes the stop on the opened row, once: a second stop of the same main changes nothing and answers the first", () => {
	const now = 10_000;
	addRoute(world.slot, "wA", opened(DEV, "m-1", now), now);
	assert.deepEqual(setStop(world.slot, "wA", "m-1", STOP, now, "tester"), { set: true });
	const again = setStop(world.slot, "wA", "m-1", { ...STOP, stopId: "9".repeat(32) }, now + 1);
	assert.deepEqual(again, { set: false, stop: STOP });
	const row = readRoutes(world.slot, "wA", now + 2)[0]!;
	assert.deepEqual([row.stop, row.name], [STOP, "tester"], "the row's name is the main's real one");
	assert.throws(() => setStop(world.slot, "wA", "no-such", STOP, now), /no opened route/);
});

test("the stop stays through a report that renews the row, an opened row written again for the same main, and a main's closing takes it with the row", () => {
	const now = 10_000;
	addRoute(world.slot, "wA", opened(DEV, "m-1", now), now);
	setStop(world.slot, "wA", "m-1", STOP, now);
	spendRoute(world.slot, "wA", readRoutes(world.slot, "wA", now)[0]!, now + 5000);
	assert.deepEqual(readRoutes(world.slot, "wA", now + 5000)[0]!.stop, STOP);
	assert.equal(readRoutes(world.slot, "wA", now + 5000)[0]!.at, now + 5000, "renewed");
	addRoute(world.slot, "wA", opened(DEV, "m-1", now + 6000), now + 6000);
	assert.deepEqual(readRoutes(world.slot, "wA", now + 6000)[0]!.stop, STOP);
	dropOpened(world.slot, "wA", "m-1", now + 7000);
	assert.deepEqual(readRoutes(world.slot, "wA", now + 7000), []);
});

test("the row caps never drop a row with a pending stop before rows without one, even the oldest and a dead one", () => {
	const now = 1_000_000_000;
	addRoute(world.slot, "wA", opened(DEV, "stopped", now), now);
	setStop(world.slot, "wA", "stopped", STOP, now);
	// 24 more rows of the same device, each newer, none listed by the broker (dead, within their grace): the per-device cap of 24 drops one, and it is not the stopped one. A live row is never dropped (ally workers, boss 2026-11-26).
	for (let i = 0; i < 24; i++) addRoute(world.slot, "wA", opened(DEV, `m-${i}`, now + 1 + i), now + 1 + i, new Set(), new Set());
	const kept = readRoutes(world.slot, "wA", now + 30).map((r) => r.to);
	assert.equal(kept.length, 24);
	assert.ok(kept.includes("stopped"), "the oldest row has a stop, so another row goes");
	assert.ok(!kept.includes("m-0"), "the oldest row without one went");
	// And among rows that are all dead, the one with a stop is last to go.
	const live = new Set<string>();
	addRoute(world.slot, "wA", opened(DEV, "late", now + 30), now + 30, live, new Set());
	assert.ok(readRoutes(world.slot, "wA", now + 40).some((r) => r.to === "stopped"));
});

test("USB-F008: a server restart keeps the stop: a revoker with no memory, reading the same route file, asks the main with the stop's mode on its first sweep", async () => {
	const now = Date.now();
	addRoute(world.slot, "wA", opened(DEV, "m-1", now), now);
	setStop(world.slot, "wA", "m-1", { ...STOP, mode: "interrupt", at: now }, now, "tester");
	const closes: string[] = [];
	const restarted = createRevoker({
		opened: () => readRoutes(world.slot, "wA", Date.now()).filter((r) => r.kind === "opened").map((r) => ({ workspace: "wA", label: "Alpha", main: r.to, name: r.name, device: r.device, deviceLabel: r.label, team: r.team, ...(r.stop ? { stop: r.stop } : {}) })),
		known: () => false, standing: () => undefined, close: async (_w, m, mode) => void closes.push(`${m}/${mode}`), paneGone: async () => false,
		forget: (w, m) => dropOpened(world.slot, w, m, Date.now()), signal: () => true, log: () => {},
	});
	await restarted.sweep();
	assert.deepEqual(closes, ["m-1/interrupt"]);
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()), [], "and the route goes with the quit");
});

// The end of the chain on the box: the sink of the holder, the route, the immediate sweep, the ask with its mode, and the notices.
type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
async function boxWithMain() {
	world.ally.self = BOX;
	world.ally.admins.add(`${T}\n${ADM}`);
	world.ally.labels.set(ADM, "admin-mac");
	world.ally.projects.set(T, "/proj");
	world.ally.level.set(DEV, "dispatch");
	world.ally.level.set(ADM, "dispatch");
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.add("m1", DEV, "run it", { team: T });
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	const token = String(got.token);
	const orig = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (p, args) => {
		orig(p, args);
		if (args.includes("--sb-run")) return;
		p.tokens.sb_role = "main";
		p.tokens.sb_opened_by = `link:${DEV}`;
		Object.assign(p, { agent_status: "working" });
		world.sessions.push({ id: "opened-1", name: "tester", herdrLocation: { status: "current", paneId: p.pane_id } as never });
	};
	const opened = await ask(s, { cmd: "run-tool", token, tool: "boss_open_main", args: { request: "Open one main and run the trial.", sender: `link:${DEV}` } });
	assert.equal(opened.ok, true, JSON.stringify(opened));
	return { s };
}
const closeAsks = () => world.client("sb-tower-wa")!.frames.filter((f) => f.namespace === "straw-boss/control" && (f.payload as { type?: string }).type === "close-main").map((f) => f.payload as { to: string; reqId: string; interrupt?: boolean });
const accept = (reqId: string) => world.client("sb-tower-wa")!.broker({ type: "extension_message", namespace: "straw-boss/control", fromSessionId: "opened-1", payload: { version: 1, type: "close-main-result", to: "sb-tower-wa", reqId, accepted: true } });
const HANDLE = () => wireId(BOX, "opened-1");

test("an accepted stop goes on the row, sweeps at once (no wait for the 15 s), asks a working main with interrupt, and quitting ends it with the notices and the audit lines", async () => {
	await boxWithMain();
	const sink = world.expose!.unitStop!;
	await sink({ team: T, from: ADM, stopId: "a".repeat(32), handle: HANDLE(), mode: "interrupt", reason: "the stuck main", at: Date.now() });
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now())[0]!.stop && [readRoutes(world.slot, "wA", Date.now())[0]!.stop!.by, readRoutes(world.slot, "wA", Date.now())[0]!.stop!.mode], [ADM, "interrupt"]);
	await until(() => closeAsks().length >= 1, "the ask, before any 15 s sweep");
	assert.equal(closeAsks()[0]!.interrupt, true, "the main is working and the tower asks anyway");
	assert.equal(closeAsks()[0]!.to, "opened-1");
	accept(closeAsks()[0]!.reqId);
	world.sessions = [];
	await until(() => world.signals.some((x) => x.kind === "main-stop" && x.outcome === "stopped"), "the stopped notice");
	await until(() => readRoutes(world.slot, "wA", Date.now()).length === 0, "the route to go");
	assert.deepEqual(world.ally.audits.map((a) => a.event), ["unit-stop-pending", "unit-stop-done"]);
	assert.ok(!JSON.stringify(world.ally.audits).includes("the stuck main"), "no reason text in link.log");
	assert.match((world.signals.find((x) => x.kind === "main-stop" && x.outcome === "stopped") as { text: string }).text, /admin-mac.*Reason: the stuck main/s, "the notice names the requester and the reason");
	assert.equal(readRoutes(world.slot, "wA", Date.now()).length, 0);
});

test("a quit stop does not interrupt: a working main is refused before it is even asked, and the notice says it is still pending", async () => {
	await boxWithMain();
	await world.expose!.unitStop!({ team: T, from: DEV, stopId: "b".repeat(32), handle: HANDLE(), mode: "quit", reason: "", at: Date.now() });
	await until(() => world.signals.some((x) => x.kind === "main-stop" && x.outcome === "pending"), "the pending notice");
	assert.deepEqual(closeAsks(), [], "the tower's own check says the main is working");
});

// OT-F001 (todo #121): a close from the page (closer.ts → towers.forget) must not drop an opened row whose stop the box accepted, or which the revoker is pursuing: the revoker ends it, with `unit-stop-done` and its notice.
/** The main quits and its pane closes, as a page's close-unit leaves them, and the page's closer tells the service. Nothing awaits between the three, so no sweep of the revoker sees a half-way state. */
const pageCloses = () => {
	const pane = world.sessions.find((x) => x.id === "opened-1")!.herdrLocation!.paneId!;
	world.sessions = [];
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== pane);
	world.expose!.forget("opened-1");
};
const refuseAsk = (reqId: string, reason: string) => world.client("sb-tower-wa")!.broker({ type: "extension_message", namespace: "straw-boss/control", fromSessionId: "opened-1", payload: { version: 1, type: "close-main-result", to: "sb-tower-wa", reqId, accepted: false, reason } });
const doneStops = () => world.ally.audits.filter((a) => a.event === "unit-stop-done").map((a) => [a.outcome, a.stopId]);
const stoppedNotices = () => world.signals.filter((x) => x.kind === "main-stop" && x.outcome === "stopped");

test("OT-F001: a page close of a main whose stop is pending (busy) leaves the row to the revoker, which ends the stop with the done audit and the stopped notice", async () => {
	world.revokeMs = 30;
	await boxWithMain();
	await world.expose!.unitStop!({ team: T, from: DEV, stopId: "f".repeat(32), handle: HANDLE(), mode: "quit", reason: "", at: Date.now() });
	await until(() => world.signals.some((x) => x.kind === "main-stop" && x.outcome === "pending"), "the pending notice");
	pageCloses();
	assert.equal(readRoutes(world.slot, "wA", Date.now()).length, 1, "the page's forget does not drop the row of a pending stop");
	await until(() => stoppedNotices().length === 1, "the stopped notice");
	await until(() => readRoutes(world.slot, "wA", Date.now()).length === 0, "the revoker to let the route go");
	assert.deepEqual(doneStops(), [["gone", "f".repeat(32)]]);
});

test("OT-F001: a page close of a main the box could not end (manual) leaves the row to the revoker too", async () => {
	world.revokeMs = 30;
	await boxWithMain();
	const answered = new Set<string>(), manual = "main was not opened by a tower (the boss opened it), so only the boss closes it";
	// The main answers every ask it got, to the end of the case: the revoker asks again at each sweep, so one of its asks can be out when the page closes the main, and an answer that never came would hold that
	// sweep for the close's 10 s (closemain.ts ASK_MS), past this wait for the stopped notice. Once the main has left the broker's list no ask is sent.
	const answering = setInterval(() => closeAsks().filter((a) => !answered.has(a.reqId)).forEach((a) => (answered.add(a.reqId), refuseAsk(a.reqId, manual))), 5);
	try {
		await world.expose!.unitStop!({ team: T, from: ADM, stopId: "a1".repeat(16), handle: HANDLE(), mode: "interrupt", reason: "", at: Date.now() });
		await until(() => world.signals.some((x) => x.kind === "main-stop" && x.outcome === "manual"), "the manual notice");
		pageCloses();
		assert.equal(readRoutes(world.slot, "wA", Date.now()).length, 1, "the row stays for the revoker");
		await until(() => stoppedNotices().length === 1, "the stopped notice");
		await until(() => readRoutes(world.slot, "wA", Date.now()).length === 0, "the route to go");
		assert.deepEqual(doneStops(), [["gone", "a1".repeat(16)]]);
	} finally {
		clearInterval(answering);
	}
});

test("OT-F001: the forget itself asks the revoker to sweep: a stopped main that is idle and still listed is asked at once and ends with the done audit, with no timer sweep near", async () => {
	world.revokeMs = 60_000;
	await boxWithMain();
	await world.expose!.unitStop!({ team: T, from: DEV, stopId: "b1".repeat(16), handle: HANDLE(), mode: "quit", reason: "", at: Date.now() });
	await until(() => world.signals.some((x) => x.kind === "main-stop" && x.outcome === "pending"), "the pending notice");
	const pane = world.sessions.find((x) => x.id === "opened-1")!.herdrLocation!.paneId!;
	world.herdr.pane(pane).agent_status = "idle"; // the main finished its turn and accepted the page's close; pi has not left yet
	world.expose!.forget("opened-1");
	assert.equal(readRoutes(world.slot, "wA", Date.now()).length, 1, "the row stays");
	await until(() => closeAsks().length === 1, "the sweep the forget asked for");
	accept(closeAsks()[0]!.reqId);
	world.sessions = [];
	await until(() => stoppedNotices().length === 1, "the stopped notice");
	await until(() => readRoutes(world.slot, "wA", Date.now()).length === 0, "the route to go");
	assert.deepEqual(doneStops(), [[undefined, "b1".repeat(16)]]);
});

// OT2-F001: only a row that carries a stop is the revoker's to let go. A stopless row it merely found short of dispatch has no done audit or stopped notice waiting; holding it left a closed main's route to the 7-day expiry once the device had dispatch again.
test("OT2-F001: a page close of a main the revoker found short of dispatch (no stop) drops its row at once, and nothing brings it back when the device has dispatch again", async () => {
	world.revokeMs = 30;
	await boxWithMain();
	world.ally.level.set(DEV, "reply");
	await until(() => world.signals.some((x) => x.kind === "revoked" && !x.ended), "the revoker to be at the main (could not be ended yet)");
	pageCloses();
	world.ally.level.set(DEV, "dispatch"); // a policy flip (or one bad read) before the revoker has seen the main gone twice
	assert.equal(readRoutes(world.slot, "wA", Date.now()).length, 0, "a row with no stop is dropped by the page's close");
	assert.deepEqual([doneStops(), stoppedNotices().length], [[], 0], "no stop was asked, so no done line and no stopped notice");
});

test("OT-F001: a main with no stop loses its opened row on a page close", async () => {
	await boxWithMain();
	pageCloses();
	assert.equal(readRoutes(world.slot, "wA", Date.now()).length, 0);
});

// OT-F004: the closer of the page's close buttons, given the towers panel's `forget` as guihost.ts gives it, closes a main in the world of fakes; the hub's bridge is the one part that is not here (it needs a bound pi session), so `ask` plays the main's quit.
// guihost.ts handing the closer that same hook is pinned by the source guard in server-towers.test.ts.
const pageCloser = () => createCloser({
	run: world.herdr.runFor("none"), sleep: async (ms) => void (await new Promise((done) => setTimeout(done, Math.min(ms, 5)))), me: () => "gui",
	sessions: async () => world.sessions,
	ask: async (key) => {
		const pane = world.sessions.find((x) => x.id === key)?.herdrLocation?.paneId;
		world.sessions = world.sessions.filter((x) => x.id !== key);
		world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== pane); // pi quit and its pane closed
		return { accepted: true };
	},
	forget: towerPanel(() => world.expose).forget,
});

test("OT-F004: close-unit through the closer and the towers panel drops the route of a main with no stop", async () => {
	await boxWithMain();
	const closer = pageCloser(), key = "opened-1";
	assert.equal((await closer("unit", { key })).status, 200);
	await until(() => readRoutes(world.slot, "wA", Date.now()).length === 0, "the plain main's route to go with it (after the reply, once the broker no longer lists the main)");
});

test("OT-F004: close-unit of a main whose stop is pending ends in the done audit and the stopped notice, through the closer and the panel", async () => {
	world.revokeMs = 30;
	await boxWithMain();
	await world.expose!.unitStop!({ team: T, from: DEV, stopId: "c1".repeat(16), handle: HANDLE(), mode: "quit", reason: "", at: Date.now() });
	await until(() => world.signals.some((x) => x.kind === "main-stop" && x.outcome === "pending"), "the pending notice");
	assert.equal((await pageCloser()("unit", { key: "opened-1" })).status, 200);
	await until(() => stoppedNotices().length === 1, "the stopped notice");
	await until(() => readRoutes(world.slot, "wA", Date.now()).length === 0, "the route to go");
	assert.deepEqual(doneStops(), [["gone", "c1".repeat(16)]]);
});

test("OT-F004: close-tab through the closer and the panel drops the routes of the mains of the squad", async () => {
	await boxWithMain();
	const pane = world.herdr.panes.find((p) => p.pane_id === world.sessions.find((x) => x.id === "opened-1")!.herdrLocation!.paneId)!;
	const reply = await pageCloser()("tab", { workspace: pane.workspace_id, tab: pane.tab_id });
	assert.equal(reply.status, 200, JSON.stringify(reply.body));
	assert.deepEqual(readRoutes(world.slot, "wA", Date.now()), []);
});

test("USB-F002: the pane's own token is a witness: a main whose pane names another device is refused as gone, with no stop written and no close asked", async () => {
	await boxWithMain();
	const pane = world.sessions.find((x) => x.id === "opened-1")!.herdrLocation!.paneId!;
	world.herdr.pane(pane).tokens.sb_opened_by = `link:${OTHER}`;
	await world.expose!.unitStop!({ team: T, from: DEV, stopId: "c".repeat(32), handle: HANDLE(), mode: "quit", reason: "", at: Date.now() });
	assert.deepEqual(world.ally.told.map((t) => [t.device, t.notice.kind, /refused: gone/.test(t.notice.text)]), [[DEV, "unit-stop-refused", true]]);
	assert.equal(readRoutes(world.slot, "wA", Date.now())[0]!.stop, undefined);
	assert.deepEqual([closeAsks(), world.ally.audits.map((a) => a.event)], [[], ["unit-stop-refused"]]);
	world.herdr.pane(pane).tokens.sb_opened_by = `link:${DEV}`;
	await world.expose!.unitStop!({ team: T, from: DEV, stopId: "d".repeat(32), handle: HANDLE(), mode: "quit", reason: "", at: Date.now() });
	assert.ok(readRoutes(world.slot, "wA", Date.now())[0]!.stop, "the row's own device passes");
});

test("USB-F008: two opened rows for one handle are refused as gone, and the pane's state is in mains", async () => {
	await boxWithMain();
	const now = Date.now();
	const before = (await world.expose!.mains()).map((f) => [f.row.main, f.name, f.state]);
	assert.deepEqual(before, [["opened-1", "tester", "working"]], "the pane's agent_status and the main's own name");
	addRoute(world.slot, "wA", { ...peer(OTHER), to: "opened-1", name: "twin", kind: "opened" as const, at: now }, now);
	assert.equal(readRoutes(world.slot, "wA", now).filter((r) => r.to === "opened-1").length, 2);
	await world.expose!.unitStop!({ team: T, from: DEV, stopId: "e".repeat(32), handle: HANDLE(), mode: "quit", reason: "", at: now });
	assert.deepEqual(world.ally.told.map((t) => [t.notice.kind, /refused: gone/.test(t.notice.text)]), [["unit-stop-refused", true]]);
	assert.ok(readRoutes(world.slot, "wA", now).every((r) => !r.stop));
});

test("USB-F007: mains reads the broker and Herdr once for all the opened rows, and not at all when none is opened", async () => {
	await boxWithMain();
	const now = Date.now();
	addRoute(world.slot, "wA", { ...peer(OTHER), to: "opened-2", name: "second", kind: "opened" as const, at: now }, now);
	addRoute(world.slot, "wA", { ...peer(ADM), to: "opened-3", name: "third", kind: "opened" as const, at: now }, now);
	let reads = 0, list = world.sessions;
	Object.defineProperty(world, "sessions", { configurable: true, get: () => (reads++, list), set: (v) => void (list = v) });
	const facts = await world.expose!.mains();
	assert.equal(facts.length, 3);
	assert.equal(reads, 1, "one read of the net for three rows");
	for (const r of readRoutes(world.slot, "wA", now)) dropOpened(world.slot, "wA", r.to, now);
	reads = 0;
	assert.deepEqual(await world.expose!.mains(), []);
	assert.equal(reads, 0);
});

const SELECT = { title: "Robot Hand — List it\n\n  ! ls", choices: [{ label: "Run it in a new Herdr pane" }, { label: "No, thanks" }], copy: "ls" };
// The main's side of `interrupt`: a main of this build that is not idle aborts its turn and answers busy; the next ask finds it idle.
let fake = new World();
afterEach(async () => {
	await fake.stopAll();
	fake = new World();
});
async function openedMain() {
	fake.autoMains();
	const towerA = fake.tower("tower-wA", "wA:t7", "wA:p7"), a1 = fake.agent({ id: "a1", name: "api-main", pane: "wA:p1", tab: "wA:t1" });
	await Promise.all(fake.agents.map((agent) => agent.start()));
	await a1.promote();
	await towerA.tool("boss_open_main", { request: "Fix the export button.", sender: "api-main" });
	const m = fake.agents.find((a) => a.id === "opened-wA:p101")!;
	fake.herdr.pane("wA:p101").agent_status = "idle";
	return { m };
}
const askMain = (m: { id: string; regs: Map<string, { onEvent(e: unknown): void }> }, reqId: string, extra: Record<string, unknown> = {}) => m.regs.get("straw-boss/control")!.onEvent({ type: "message", fromSessionId: "tower-wA", payload: { version: 1, type: "close-main", to: m.id, reqId, ...extra } });
const results = () => fake.broker.published.map((p) => p.payload as { type: string; reqId: string; accepted: boolean; reason?: string; busy?: boolean }).filter((p) => p.type === "close-main-result");

test("a main asked with interrupt aborts the turn it is in and answers busy; asked again, idle, it quits. Without interrupt it never aborts", async () => {
	const { m } = await openedMain();
	m.idle = false;
	askMain(m, "r0");
	await untilWorld(() => results().length === 1, "the plain refusal");
	assert.equal(m.aborted, 0, "a plain quit never aborts");
	assert.equal(results()[0]!.busy, true);
	askMain(m, "r1", { interrupt: true });
	await untilWorld(() => results().length === 2, "the interrupt's answer");
	assert.equal(m.aborted, 1);
	assert.deepEqual([results()[1]!.accepted, results()[1]!.busy], [false, true]);
	assert.match(results()[1]!.reason!, /interrupt/);
	m.idle = true;
	askMain(m, "r2", { interrupt: true });
	await untilWorld(() => results().length === 3 && m.stopped, "the quit");
	assert.equal(m.aborted, 1, "an idle main is not aborted");
	assert.equal(results()[2]!.accepted, true);
});

test("an interrupt does not end what an abort does not: a running subagent, a monitor, or an open dialog still refuse, and nothing is aborted", async () => {
	const { m } = await openedMain();
	m.idle = false;
	m.emit("monitor:started", { monitorId: "1", command: "npm run dev" });
	askMain(m, "r1", { interrupt: true });
	await untilWorld(() => results().length === 1, "the refusal");
	assert.equal(m.aborted, 0);
	assert.match(results()[0]!.reason!, /monitor/);
	assert.equal(results()[0]!.accepted, false);
});

test("an interrupt does not end a running subagent: the main refuses and nothing is aborted", async () => {
	const { m } = await openedMain();
	const file = join(tmpdir(), `sbstop-${process.pid}`, "sessions", "2026-11-07T00-00-00-000Z_parent.jsonl"), dir = join(dirname(file), "artifacts", "parent");
	mkdirSync(join(dir, "subagent-activity"), { recursive: true });
	writeFileSync(join(dir, "subagent-activity", "kid.json"), JSON.stringify({ phase: "active" }));
	writeFileSync(file, "");
	Object.assign(fake.herdr.pane("wA:p101"), { agent_session: { value: file } });
	// The child is a live pi pane whose session file is named for it (the dashboard's rule for a running subagent).
	fake.herdr.addTab("wA:t9", "kid", "wA:p9", "pi");
	Object.assign(fake.herdr.pane("wA:p9"), { agent: "pi", agent_status: "working", agent_session: { value: join(dirname(file), "2026-11-07T00-00-00-000Z_kid-1a2b3c4d-5e6f7a8b-9c0d.jsonl") } });
	m.idle = false;
	askMain(m, "r1", { interrupt: true });
	await untilWorld(() => results().length === 1, "the refusal");
	assert.equal(m.aborted, 0);
	assert.match(results()[0]!.reason!, /subagent/);
	assert.deepEqual([results()[0]!.accepted, results()[0]!.busy], [false, true]);
});

test("an interrupt does not close an open dialog: the main refuses and nothing is aborted", async () => {
	const { m } = await openedMain();
	m.idle = false;
	await m.fire("tool_execution_start", { toolCallId: "c1", toolName: "robot_hand", args: {} });
	m.emit("robot-hand:pending", { version: 1, id: "d1", toolCallId: "c1", digest: selectDigest(SELECT), select: SELECT });
	askMain(m, "r1", { interrupt: true });
	await untilWorld(() => results().length === 1, "the refusal");
	assert.equal(m.aborted, 0);
	assert.match(results()[0]!.reason!, /dialog/);
});
