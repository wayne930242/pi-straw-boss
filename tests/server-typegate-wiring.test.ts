import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readQueue, removeEvent } from "../src/server/towerstore.ts";
import { stamp } from "../src/header.ts";
import type { Proc } from "../src/server/lineage.ts";
import { SHELL_PID } from "./fakes.ts";

// The facts runs.ts hands retryGate (RVTG-F004). A table read Retry asks for is a read whose run id is no run's.
let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.runTimers = { hold: 60_000 };
});
afterEach(() => world.close());
type Reply = Record<string, unknown> & { ok: boolean };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const tower = () => world.client("sb-tower-wa")!;
const from = { id: "main-1", name: "docs-main" };
const status = async (s: Running) => ((await ask(s, { cmd: "status" })).towers as { service: { state: string } }[])[0]!.service;
const row = (pid: number, ppid: number, name: string): Proc => ({ pid, ppid, name, carries: false });
const tower0 = { name: "tower", id: "sb-tower-wa", role: "tower" as const, workspace: "Alpha" };
const milestone = (id: string) => ({ id, content: { text: stamp({ from: { name: "docs-main", id: "main-1", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [tower0], reply: false, why: "milestone" }, "landed") } });
const paneBusyError = () => Object.assign(new Error("herdr agent start failed"), { stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "agent target pane is not an available shell" } }) });
const retryReads: string[] = [];
const winHeld = async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	const s = await world.start();
	const real = world.herdr.onAgentStart;
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	world.procGate = (runId) => (world.pis.has(runId) ? undefined : void retryReads.push(runId));
	world.herdr.onAgentStart = () => {
		throw paneBusyError();
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "held");
	for (const e of readQueue(world.slot, "wA")) removeEvent(world.slot, "wA", e);
	world.herdr.onAgentStart = real;
	return s;
};

test("Retry with a milestone waiting (wake far off) reads no table", async () => {
	const s = await winHeld();
	tower().incoming(from, milestone("ms1"));
	await until(() => readQueue(world.slot, "wA").length === 1, "queued");
	retryReads.length = 0;
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(300);
	assert.equal(retryReads.length, 0);
});

test("Retry while a run is live reads no table", async () => {
	const s = await winHeld();
	tower().incoming(from, { id: "m2", content: { text: "two" } });
	await ask(s, { cmd: "tower-retry", workspace: "wA" }); // ends the hold: the run starts
	await until(() => world.pis.size === 1, "a run");
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	let token = "";
	await until(async () => { const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` }); token = String(got.token); return got.ok; }, "claimed");
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		await ask(s, { cmd: "run-taken", token, id: event.id });
	}
	retryReads.length = 0;
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(300);
	assert.equal(retryReads.length, 0);
});

test("an event that comes while Retry reads the table leaves the pane to its run: nothing is typed", async () => {
	const s = await winHeld();
	const typedPrompts = () => world.herdr.typed.filter((t) => /prompt --workspace/.test(t.text)).length;
	const before = typedPrompts();
	let open!: () => void;
	const gate = new Promise<void>((r) => (open = r));
	world.procGate = (runId) => (world.pis.has(runId) ? undefined : gate);
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(50);
	tower().incoming(from, milestone("ms2"));
	await until(() => readQueue(world.slot, "wA").length === 1, "queued");
	open();
	await sleep(400);
	assert.equal(typedPrompts(), before);
});
