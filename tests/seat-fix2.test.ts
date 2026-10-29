import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { SHELL_PID } from "./fakes.ts";
import { startPi } from "../src/herdr.ts";
import { readFileSync } from "node:fs";
import { fileOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";

// RVSEAT2-F002, D2, D3: the acts that rested on a proof made earlier ask it again (startPi's retries, the ally pane's close and unmark after a Herdr restart, the boss's close of the tower tab).

test("RVSEAT2-F002: startPi asks the proof before each retry on a busy answer, and stops when it fails", async () => {
	let calls = 0, proofs = 0;
	const run = async () => { calls++; throw new Error("herdr agent start failed: agent_pane_busy: x"); };
	await assert.rejects(startPi(run, async () => {}, "n", "p1", [], async () => ++proofs < 3), /no longer proven/);
	assert.equal(calls, 3);
	assert.equal(proofs, 3);
	calls = 0;
	await assert.rejects(startPi(run, async () => {}, "n", "p1", []), /agent_pane_busy/);
	assert.equal(calls, 20, "no guard: as before");
});

let world: TowerWorld;
beforeEach(() => { world = new TowerWorld(); world.setFlag(true); });
afterEach(() => world.close());
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);

test("RVSEAT2-D3: the boss's close of the tower closes no tab that is not proven the tower's", async () => {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const h = world.herdr;
	h.restart(false);
	h.tabs.find((t) => t.tab_id === ensured.tab)!.label = "1"; // a stranger's tab under the reused id
	h.calls.length = 0;
	await ask(s, { cmd: "close-tower", workspace: "wA" });
	assert.deepEqual(h.calls.filter((a) => a[0] === "tab" && a[1] === "close"), []);
	assert.deepEqual(h.closed.filter((c) => c === ensured.tab), []);
});

test("RVSEAT2-D3 control: a proven tower's tab is closed", async () => {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "close-tower", workspace: "wA" });
	assert.ok(world.herdr.closed.includes(String(ensured.tab)));
});

// RVSEAT3-F001: after a Herdr restart the ally pane is ours to close when the tower's seat is proven again and the pane is in the tower's tab; a lost session's stranger under a reused id is not.
async function allyRun(restore: boolean, platform: "darwin" | "win32") {
	if (platform === "win32") { world.runPlatform = "win32"; world.herdr.winShell = true; }
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.ally.add("m1", "a".repeat(26), "hello");
	world.ally.level.set("a".repeat(26), "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => world.herdr.commands("pane", "split").length === 1, "the ally pane");
	await until(() => world.herdr.commands("agent", "start").length === 1, "its start");
	const h = world.herdr;
	const pane = h.panes.find((p) => p.tokens?.sb_role === "ally")?.pane_id ?? h.panes.at(-1)!.pane_id;
	if (restore) h.restart(false);
	else { h.lose(); h.addPane(pane, "wA:t999", "shell"); }
	h.calls.length = 0;
	world.takeovers.forEach((cb) => cb());
	await sleep(400);
	return { h, pane };
}
for (const platform of ["darwin", "win32"] as const) {
	test(`RVSEAT3-F001 ${platform}: a restored session closes and unmarks the live ally run's pane`, async () => {
		const { h, pane } = await allyRun(true, platform);
		assert.ok(h.closed.includes(pane), "the ally pane stays");
	});
	test(`RVSEAT3-F001 ${platform}: a lost session leaves a stranger under the old pane id untouched`, async () => {
		const { h, pane } = await allyRun(false, platform);
		assert.deepEqual(h.calls.filter((a) => a.includes(pane) && (a[1] === "close" || a[1] === "report")), []);
		assert.ok(!h.closed.includes(pane), "closed the stranger's pane");
	});
}

for (const order of ["listing-then-takeover", "events-then-takeover"] as const) test(`RVSEAT2-F001 darwin restored session, ${order}: the command is typed once into the new terminal`, async () => {
	world.herdr.shellPids = true;
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const pane = String(ensured.pane), h = world.herdr;
	await until(() => h.typed.length === 1, "first typing");
	h.restart(order === "events-then-takeover");
	Object.assign(h.pane(pane), { processes: [], agent: undefined });
	await until(() => h.typed.filter((t) => t.pane === pane).length === 2, "typed into the restored terminal", 4000);
	world.takeovers.forEach((cb) => cb());
	await sleep(150);
	assert.equal(h.typed.filter((t) => t.pane === pane).length, 2);
});

// D1 (N5): Retry on Windows while the typed prompt is still starting (the table shows it below the shell, nothing polls yet) types nothing a second time.
const typedPrompts = () => world.herdr.typed.filter((t) => /prompt --workspace/.test(t.text)).length;
test("RVSEAT2-D1 win32: Retry while the prompt typed into a fresh tab is still starting: typed once", async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	world.standingTimers = { launchMs: 60_000, launchMaxMs: 60_000 };
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => typedPrompts() === 1, "the first prompt");
	const SHELL = SHELL_PID;
	world.herdr.pane(String(ensured.pane)).processes = [{ name: "powershell.exe", argv0: "powershell.exe", pid: SHELL }];
	world.procTable = [{ pid: SHELL, ppid: 1, name: "powershell.exe", carries: false }, { pid: 6100, ppid: SHELL, name: "node.exe", carries: false, prompt: true } as never];
	await sleep(100);
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(500);
	assert.equal(typedPrompts(), 1);
});

test("RVSEAT2-F002: a run's start that waits on a busy pane asks the seat before each retry: a Herdr that comes back meanwhile ends the run, and no further start is tried", async () => {
	world.herdr.shellPids = true;
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const h = world.herdr;
	h.busy = 1000;
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "m" }, { id: "m1", content: { text: "hi" } });
	await until(() => h.commands("agent", "start").length >= 1, "the first start is refused as busy");
	h.restart(false);
	h.tabs.find((t) => t.tab_id === ensured.tab)!.label = "1"; // a stranger's tab under the reused id
	Object.assign(h.pane(String(ensured.pane)), { processes: [], agent: undefined });
	await until(() => /run-refused.*seat/.test(readFileSync(fileOf(world.slot, "log"), "utf8")), "the run is refused for its seat", 5000);
	const after = h.commands("agent", "start").length;
	await sleep(1500);
	assert.ok(h.commands("agent", "start").length <= after + 1, "no start is tried after the seat is lost");
});

test("RVSEAT3-F002 win32: Retry after the starting window, the prompt below the shell and not polling: typed once", async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	world.standingTimers = { launchMs: 200, launchMaxMs: 200 };
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => typedPrompts() === 1, "the first prompt");
	world.herdr.pane(String(ensured.pane)).processes = [{ name: "powershell.exe", argv0: "powershell.exe", pid: SHELL_PID }];
	world.procTable = [{ pid: SHELL_PID, ppid: 1, name: "powershell.exe", carries: false }, { pid: 6100, ppid: SHELL_PID, name: "node.exe", carries: false, prompt: true } as never];
	await sleep(500);
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(500);
	assert.equal(typedPrompts(), 1);
});
