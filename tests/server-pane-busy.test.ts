import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { programsIn } from "../src/server/standing.ts";
import type { Proc } from "../src/server/lineage.ts";
import { SHELL_PID } from "./fakes.ts";

// A program of the boss's in the standing pane (B6 VM round 2: a node.exe there made every run crash at its start, a new run every 30 s). The failed start is the crash-loop rule's: the service is held
// after the limit with one notice that names the program, the pane is not replaced, and the service starts again by itself when the pane is back at its shell.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const tower = () => world.client("sb-tower-wa")!;
const from = { id: "main-1", name: "docs-main" };
const status = async (s: Running) => ((await ask(s, { cmd: "status" })).towers as { service: { state: string; crashes?: number; notices: { id: string; kind: string; text: string }[] } }[])[0]!.service;
const starts = () => world.herdr.commands("agent", "start").length;
let real: typeof world.herdr.onAgentStart;
const mine = { name: "node.exe", argv0: "node.exe", pid: 7777, cmdline: "node server.js" };

const setup = async () => {
	const s = await world.start();
	real = world.herdr.onAgentStart;
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, pane: String(ensured.pane) };
};

test("programsIn: the boss's programs in the foreground, not a shell and not the tower prompt", () => {
	assert.deepEqual(programsIn(undefined), []);
	assert.deepEqual(programsIn({ foreground_processes: [{ name: "powershell.exe", argv0: "powershell.exe" }] }), []);
	assert.deepEqual(programsIn({ foreground_processes: [{ name: "node", cmdline: 'node "/p/cli.mjs" prompt --workspace wA --state-dir "/s"' }] }), []);
	assert.deepEqual(programsIn({ foreground_processes: [{ name: "zsh" }, { name: "node.exe", argv0: "node.exe" }] }), ["node.exe"]);
});

test("a start that fails with a program of the boss's in the pane is held after the limit with one notice naming it, and starts again by itself when the pane is free", async () => {
	world.herdr.shellPids = true;
	const { s, pane } = await setup();
	world.herdr.pane(pane).processes = [mine];
	world.herdr.onAgentStart = () => {
		throw new Error("herdr agent start failed: not_available: the pane's foreground is not a shell");
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal(starts() >= 3, true);
	const held = await status(s);
	assert.equal(held.crashes, 3);
	assert.deepEqual(held.notices.filter((n) => n.kind === "start").map((n) => n.text.includes("node.exe")), [true], "one start notice, naming the program");
	assert.equal(held.notices.filter((n) => n.kind === "loop").length, 1);
	assert.equal(readQueue(world.slot, "wA").length, 1, "the event waits, untouched");
	assert.deepEqual(readQueue(world.slot, "wA", true), [], "and is not parked");
	const before = starts();
	await sleep(300);
	assert.equal(starts(), before, "nothing starts while the program runs");
	// The program ends: the pane is back at its shell, and the service starts again without a word from the boss.
	world.herdr.pane(pane).processes = [];
	world.herdr.onAgentStart = real;
	await until(() => world.pis.size === 1, "a run to start once the pane is free");
	const after = await status(s);
	assert.equal(after.notices.some((n) => n.kind === "start" || n.kind === "loop"), false, "the notices are gone");
});

test("win32: the same hold, with nothing closed: the pane and its tab stay, and the service starts again when the foreground is back at the shell", async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	const { s, pane } = await setup();
	world.herdr.pane(pane).processes = [mine];
	world.herdr.onAgentStart = () => {
		throw new Error("herdr agent start failed: not_available: the pane is not an available shell");
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal(starts(), 3, "one start per run: no retry in a fresh pane");
	assert.deepEqual(world.herdr.closed, [], "no pane closed");
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).pane, pane);
	world.herdr.onAgentStart = real;
	world.herdr.pane(pane).processes = [];
	await until(() => world.pis.size === 1, "a run to start once the pane is free");
});

test("Retry or a word from the boss still wakes a service held for a busy pane, and the busy mark goes with the hold", async () => {
	world.herdr.shellPids = true;
	const { s, pane } = await setup();
	world.herdr.pane(pane).processes = [mine];
	world.herdr.onAgentStart = () => {
		throw new Error("herdr agent start failed: not_available: the pane's foreground is not a shell");
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	assert.equal((await status(s)).notices.some((n) => n.kind === "start"), false, "Retry clears the start notice with the loop's");
});

// Windows lists the shell alone in the foreground whatever runs under it (B6 VM round 3b, N1: `node` typed in the standing pane, `run-start-pane foreground="powershell.exe 8464"`), so the program is found in the process
// table, below the pane's shell. The service started no run again after that program ended, and the notice said `agent_pane_busy`.
const row = (pid: number, ppid: number, name: string, carries = false): Proc => ({ pid, ppid, name, carries });
const paneBusyError = () => Object.assign(new Error("herdr agent start failed"), { stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "agent target pane is not an available shell" } }) });
const winSetup = async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	const got = await setup();
	world.live.add(7777);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(1234, SHELL_PID, "conhost.exe"), row(7777, SHELL_PID, "node.exe")];
	world.herdr.onAgentStart = () => {
		throw paneBusyError();
	};
	return got;
};

test("win32, the VM's shape (the foreground lists the shell alone): a hold caused by a program below the pane's shell names it in the one start notice and ends by itself once the program has gone", async () => {
	const { s, pane } = await winSetup();
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	const held = await status(s);
	assert.equal(starts(), 3, "one start per run");
	assert.deepEqual(held.notices.filter((n) => n.kind === "start").map((n) => n.text), ["A run could not start: the standing pane is busy with node.exe; the tower starts again when it has ended, or on Retry"], "one notice, naming the program (not the console host)");
	assert.equal(held.notices.filter((n) => n.kind === "loop").length, 1);
	const before = starts();
	await sleep(400);
	assert.equal(starts(), before, "held while the program runs");
	assert.equal((await status(s)).state, "held");
	assert.deepEqual(world.herdr.closed, [], "nothing closed");
	// The program ends. The hold is not Retry's alone: the service starts again by itself.
	world.live.delete(7777);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(1234, SHELL_PID, "conhost.exe")];
	world.herdr.onAgentStart = real;
	await until(() => world.pis.size === 1, "a run to start once the program has gone");
	assert.equal((await status(s)).notices.some((n) => n.kind === "start" || n.kind === "loop"), false);
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).pane, pane);
});

test("win32: a crash-loop hold with another cause (the pane has no program below its shell) stays held until Retry, whatever the list shows", async () => {
	const { s } = await winSetup();
	world.live.delete(7777);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	const held = await status(s);
	assert.equal(held.notices.filter((n) => n.kind === "start").every((n) => !/busy with/.test(n.text)), true, "no program to name");
	world.herdr.onAgentStart = real;
	const before = starts();
	await sleep(500);
	assert.equal(starts(), before, "still held: nothing frees it by itself");
	assert.equal((await status(s)).state, "held");
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await until(() => world.pis.size === 1, "Retry starts a run");
});

test("the notice names the program by its executable's name only: no path, no arguments", async () => {
	world.herdr.shellPids = true;
	const { s, pane } = await setup();
	world.herdr.pane(pane).processes = [{ name: "node", argv0: "C:\\Users\\me\\tools\\node.exe", pid: 7777, cmdline: "C:\\Users\\me\\tools\\node.exe C:\\me\\secret-server.js --token abc" }];
	world.herdr.onAgentStart = () => {
		throw new Error("herdr agent start failed: not_available: the pane's foreground is not a shell");
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	const texts = (await status(s)).notices.filter((n) => n.kind === "start").map((n) => n.text);
	assert.deepEqual(texts, ["A run could not start: the standing pane is busy with node.exe; the tower starts again when it has ended, or on Retry"]);
});
