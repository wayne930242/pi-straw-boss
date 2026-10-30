import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";

// RVAC-F001..F003: a finished ally run closes its pane on the same Herdr whatever the listing, and after a restart only a pi whose own session file is a recorded ally run's is told to quit.
let world: TowerWorld;
beforeEach(() => { world = new TowerWorld(); world.setFlag(true); });
afterEach(() => world.close());
type Reply = Record<string, unknown> & { ok: boolean };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const DEV = "a".repeat(26), FILE = "/fake/2026-10-29T00-00-00Z_sess1.jsonl", BOSS = "/fake/2026-10-30T00-00-00Z_boss.jsonl";
const touches = (h: TowerWorld["herdr"], pane: string) => h.calls.filter((a) => a.includes(pane) && (a[1] === "close" || a[1] === "report" || a[1] === "report-metadata" || a[1] === "clear-token" || a[1] === "send-keys" || a[1] === "send-text" || a[1] === "run" || (a[0] === "agent" && a[1] === "start")));
function noTerminalIds(h: TowerWorld["herdr"]) {
	const add = h.addPane.bind(h);
	h.addPane = (...a: Parameters<typeof add>) => {
		const p = add(...a);
		delete (p as { terminal_id?: string }).terminal_id;
		return p;
	};
}
async function claimedAlly(opts: { before?: () => void } = {}) {
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	opts.before?.();
	world.ally.add("m1", DEV, "hello");
	world.ally.level.set(DEV, "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.pis.size >= 1, "the ally pi");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the pid");
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	const token = String(got.token);
	await ask(s, { cmd: "run-file", token, file: FILE, session: "sess1" });
	world.herdr.pane(pi.pane).agent_session = { value: FILE };
	return { s, id, pane: pi.pane, pid: pi.pid, token, h: world.herdr };
}
async function drainDone(s: Running, token: string) {
	for (;;) {
		const ev = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!ev) break;
		await ask(s, { cmd: "run-taken", token, id: ev.id });
	}
	return ask(s, { cmd: "run-done", token, note: "done" });
}

for (const ids of [true, false]) test(`RVAC-F001 ids=${ids}: same Herdr, the ally run ends done: its pane is closed`, async () => {
	const { s, id, pane, pid, token, h } = await claimedAlly({ before: ids ? undefined : () => noTerminalIds(world.herdr) });
	assert.equal((await drainDone(s, token)).ok, true);
	world.live.delete(pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "done", 3000);
	await sleep(200);
	assert.ok(h.closed.includes(pane), "the ally pane of a finished run stays open");
});

test("RVAC-F001: where Herdr lists terminal ids, a pane in another terminal than the split's is not closed", async () => {
	const { s, pane, pid, token, h, id } = await claimedAlly();
	h.pane(pane).terminal_id = "t-stranger";
	assert.equal((await drainDone(s, token)).ok, true);
	world.live.delete(pid);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "done", 3000);
	await sleep(200);
	assert.ok(!h.closed.includes(pane), "closed a stranger's pane");
});

for (const platform of ["darwin", "win32"] as const) for (const when of ["before-takeover", "during-takeover", "after-takeover"] as const) test(`RVAC-F002/F003 ${platform} ${when}: only the pi whose own session file is the ally run's is told to quit; no keys, no pane writes`, async () => {
	if (platform === "win32") { world.runPlatform = "win32"; world.herdr.winShell = true; }
	const { s, id, pane, h } = await claimedAlly();
	h.restart(false);
	h.calls.length = 0;
	const roles = async () => ({
		resumed: (await ask(s, { cmd: "pane-role", pane, pid: 4242, file: FILE })).role,
		boss: (await ask(s, { cmd: "pane-role", pane, pid: 4243, file: BOSS })).role,
		bare: (await ask(s, { cmd: "pane-role", pane, pid: 4244 })).role,
	});
	let got: Awaited<ReturnType<typeof roles>>;
	if (when === "before-takeover") {
		got = await roles();
		world.takeovers.forEach((cb) => cb());
	} else if (when === "during-takeover") {
		let release!: () => void;
		h.paneListGate = new Promise<void>((r) => (release = r));
		world.takeovers.forEach((cb) => cb());
		await sleep(100);
		got = await roles();
		h.paneListGate = undefined;
		release();
	} else {
		world.takeovers.forEach((cb) => cb());
		await until(() => readRun(world.slot, "wA", id)?.outcome === "herdr-restart", "herdr-restart", 3000);
		got = await roles();
	}
	await until(() => readRun(world.slot, "wA", id)?.outcome === "herdr-restart", "herdr-restart", 3000);
	await sleep(300);
	assert.deepEqual(got, { resumed: "quit", boss: "none", bare: "none" });
	assert.deepEqual(touches(h, pane), []);
});
