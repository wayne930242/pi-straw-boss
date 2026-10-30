// RVSEAT6-F002, F003, F004, F006: an ally pane or workspace is touched only with a fact a lost session's stranger lacks (the terminal of the split, the seat on this Herdr).
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { TOWER_LABEL } from "../src/herdr.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun, writeRun } from "../src/server/towerrunstore.ts";

let world: TowerWorld;
beforeEach(() => { world = new TowerWorld(); world.setFlag(true); });
afterEach(() => world.close());
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);
const FILE = "/fake/2026-10-29T00-00-00Z_sess1.jsonl", BOSS = "/fake/2026-10-30T00-00-00Z_boss.jsonl";
const runOf = (pane: string) => [...world.pis.entries()].find(([, p]) => p.pane === pane)?.[0];

async function ownSession(s: Running, h: TowerWorld["herdr"], pane: string) {
	await until(() => runOf(pane) !== undefined, "the ally pi");
	const id = runOf(pane)!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await callControl(s.handle.endpoint, world.record()!.secret, { cmd: "claim", runId: id, pane, pid: pi.pid, started: `T-${pi.pid}` } as { cmd: string });
	const token = String((got.reply as { token?: string }).token);
	await callControl(s.handle.endpoint, world.record()!.secret, { cmd: "run-file", token, file: FILE, session: "sess1" } as { cmd: string });
	h.pane(pane).agent_session = { value: FILE };
}
async function liveAlly(platform: "darwin" | "win32", opts: { busy?: number; own?: boolean; beforePoke?: () => void } = {}) {
	if (platform === "win32") { world.runPlatform = "win32"; world.herdr.winShell = true; }
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	if (opts.busy) world.herdr.busy = opts.busy;
	opts.beforePoke?.();
	world.ally.add("m1", "a".repeat(26), "hello");
	world.ally.level.set("a".repeat(26), "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.herdr.commands("pane", "split").length >= 1, "the ally pane");
	await until(() => world.herdr.commands("agent", "start").length >= 1, "its start");
	const h = world.herdr;
	const pane = h.panes.find((p) => p.tokens?.sb_role === "ally")?.pane_id ?? h.panes.at(-1)!.pane_id;
	if (opts.own) await ownSession(s, h, pane);
	return { s, h, pane, tab: String(ensured.tab), tower: String(ensured.pane) };
}
const touches = (h: TowerWorld["herdr"], pane: string) => h.calls.filter((a) => a.includes(pane) && (a[1] === "close" || a[1] === "report" || a[1] === "report-metadata" || a[1] === "clear-token" || a[1] === "send-keys" || a[1] === "send-text" || a[1] === "run" || (a[0] === "agent" && a[1] === "start")));
const short = (cs: string[][]) => JSON.stringify(cs.map((a) => a.slice(0, 3).concat(a.find((x) => x.startsWith("sb_role=")) ?? [])));
/** The desk's base at the recorded ids after a lost session, and a pane of the boss's at the old ally id in that tab. */
function lostS1(h: TowerWorld["herdr"], tab: string, tower: string, pane: string, agent = "shell") {
	h.lose();
	h.workspaces.push({ workspace_id: "wA", label: "Desk", tokens: {} } as never);
	h.addTab(tab, TOWER_LABEL, tower, "shell");
	h.addPane(pane, tab, agent);
}

// --- N5: the terminal is not known after the split (the listing failed) ---
/** The listing fails `times` times after the pane split (the run's split read is retried 3 times, so 3 leaves its terminal unknown). */
function failListAfterSplit(h: TowerWorld["herdr"], times = 1) {
	let left = 0;
	const push = h.calls.push.bind(h.calls);
	h.calls.push = (...a: string[][]) => {
		const r = push(...a);
		if (a[0]?.[0] === "pane" && a[0][1] === "split") (left = times, (h.failPanes = true));
		else if (left > 0 && a[0]?.[0] === "pane" && a[0][1] === "list" && --left === 0) queueMicrotask(() => (h.failPanes = false));
		return r;
	};
}
test("F003 N5a: the listing after the split fails once, and the first start meets a busy pane: one split, the run starts", async () => {
	const { h, pane } = await liveAlly("darwin", { busy: 2, beforePoke: () => failListAfterSplit(world.herdr) });
	await sleep(2500);
	const id = [...world.pis.keys()][0];
	assert.equal(h.commands("pane", "split").length, 1, "one pane");
	assert.ok(!h.closed.includes(pane) && h.panes.some((p) => p.pane_id === pane));
	await until(() => world.pis.size >= 1, "the ally pi");
	assert.ok(id === undefined || !readRun(world.slot, "wA", id)?.outcome);
});
test("F002 N5b: the listing after the split fails once; a lost session's stranger at the ally id during the run", async () => {
	const { h, pane, tab, tower } = await liveAlly("darwin", { own: true, beforePoke: () => failListAfterSplit(world.herdr, 3) });
	const id = runOf(pane)!;
	console.log("N5b record terminal:", readRun(world.slot, "wA", id)?.terminal ?? "(none)");
	lostS1(h, tab, tower, pane, "shell");
	world.takeovers.forEach((cb) => cb());
	await sleep(1500);
	console.log("N5b touches:", short(touches(h, pane)), "closed:", h.closed.includes(pane), "stranger tokens:", JSON.stringify(h.panes.find((p) => p.pane_id === pane)?.tokens));
	assert.deepEqual(touches(h, pane), []);
});
test("F003 N5c: a Herdr that lists no terminal ids, and each new split is busy at its first start", async () => {
	const h = world.herdr;
	const add = h.addPane.bind(h);
	h.addPane = (...a: Parameters<typeof add>) => {
		const p = add(...a);
		delete (p as { terminal_id?: string }).terminal_id;
		return p;
	};
	const push = h.calls.push.bind(h.calls);
	h.calls.push = (...a: string[][]) => {
		if (a[0]?.[0] === "pane" && a[0][1] === "split") h.busy = 1;
		return push(...a);
	};
	await liveAlly("darwin");
	await sleep(3000);
	assert.equal(h.commands("pane", "split").length, 1, "one pane");
	assert.equal(h.commands("pane", "close").length, 0);
	assert.equal(world.pis.size, 1, "the run started");
});

// --- N6: other server acts on a new Herdr ---
test("F006 N6a: lost session, the boss's workspace has the recorded id but no pane at the recorded pane id: no tokens written to it", async () => {
	world.refreshMs = 100;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const h = world.herdr;
	h.lose();
	h.workspaces.push({ workspace_id: "wA", label: "Mine", tokens: {} } as never);
	h.addTab("wA:t1", "work", "wA:p1", "pi");
	h.calls.length = 0;
	world.takeovers.forEach((cb) => cb());
	await sleep(3000);
	const writes = h.calls.filter((a) => a[0] === "workspace" && a[1] === "report-metadata" && a[2] === "wA");
	console.log("N6a workspace writes:", JSON.stringify(writes), "tokens:", JSON.stringify(h.workspace("wA")?.tokens));
	assert.deepEqual(writes, []);
});
test("F004 N6b: server restart + lost session, the recovered ally run's pi still alive by pid: keys into the stranger", async () => {
	world.runTimers = { lost: 300 } as never;
	const { s, h, pane, tab, tower } = await liveAlly("darwin", { own: true });
	await s.handle.shutdown(0);
	lostS1(h, tab, tower, pane, "pi");
	h.pane(pane).agent_session = { value: BOSS };
	h.calls.length = 0;
	const s2 = await world.start();
	await s2.handle.ready;
	await sleep(2000);
	const keys = h.calls.filter((a) => a.includes(pane) && (a[1] === "send-keys" || a[1] === "send-text"));
	console.log("N6b keys into the stranger:", JSON.stringify(keys), "kills:", JSON.stringify(world.kills));
	assert.deepEqual(keys, []);
});

for (const takeover of [false, true]) test(`F002 N5d (terminal unknown) takeover=${takeover}: the listing after the split failed; Herdr lost, its pi died with it, a stranger at the ally id before the takeover's end`, async () => {
	const { h, pane, tab, tower } = await liveAlly("darwin", { own: true, beforePoke: () => failListAfterSplit(world.herdr, 3) });
	const id = runOf(pane)!;
	console.log("N5d record terminal:", readRun(world.slot, "wA", id)?.terminal ?? "(none)");
	lostS1(h, tab, tower, pane, "shell");
	for (const p of world.pis.values()) world.live.delete(p.pid);
	if (takeover) world.takeovers.forEach((cb) => cb());
	await sleep(1500);
	console.log("N5d", takeover, "outcome:", readRun(world.slot, "wA", id)?.outcome, "touches:", short(touches(h, pane)), "closed:", h.closed.includes(pane));
	assert.ok(!h.closed.includes(pane), "closed the stranger's shell");
});
