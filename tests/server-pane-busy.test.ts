import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readQueue, removeEvent } from "../src/server/towerstore.ts";
import { programsIn } from "../src/server/standing.ts";
import { cimCommand, parseCim, parsePs, type Proc } from "../src/server/lineage.ts";
import { FAKE_SHELL, SHELL_PID } from "./fakes.ts";

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
	// Only the first word of a name, so that a name that holds arguments (some platforms list the command line as the name) never reaches the notice (RV10-F004, M5).
	assert.deepEqual(programsIn({ foreground_processes: [{ name: "node secret-server.js --token abc" }] }), ["node"]);
	assert.deepEqual(programsIn({ foreground_processes: [{ argv0: "C:\\tools\\my tool.exe", name: "my tool.exe" }] }), ["my"]);
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

test("RV11-F001 win32: Retry with no event waiting gives the unstarted run's pane back, and the prompt is typed again", async () => {
	const { s } = await winSetup();
	world.live.delete(7777);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	for (const e of readQueue(world.slot, "wA")) removeEvent(world.slot, "wA", e);
	world.herdr.onAgentStart = real;
	const typed = () => world.herdr.commands("pane", "run").length;
	const before = typed();
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await until(() => typed() > before, "the prompt typed again with no run to start");
	assert.equal(world.pis.size, 0, "no run started");
});

// RV12-F001 (rule F10): an empty busy list is not the proof that the pane holds nothing. Retry on Windows types the prompt command again only after a fresh read of the process table that succeeds and finds no program
// below the shell; a read that fails or finds a program types nothing, and the service says why, once.
const startNotices = async (s: Running) => (await status(s)).notices.filter((n) => n.kind === "start").map((n) => n.text);
/** A Windows service whose start was refused and whose event is gone, so Retry has no run to start; `table` is what the process table answers when the start fails, `after` when Retry reads it. */
const retryRig = async (table: Proc[] | undefined, after: Proc[] | undefined, code?: string) => {
	const { s } = await winSetup();
	world.procTable = table;
	if (code) {
		world.herdr.onAgentStart = () => {
			throw Object.assign(new Error("herdr agent start failed"), { stderr: JSON.stringify({ error: { code, message: "the pane is not an available shell" } }) });
		};
	}
	await until(() => typedPrompts() === 1, "the first prompt typed into the new pane");
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	for (const e of readQueue(world.slot, "wA")) removeEvent(world.slot, "wA", e);
	world.herdr.onAgentStart = real;
	world.procTable = after;
	return s;
};
const afterRetry = async (s: Running) => {
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(600);
	return typedPrompts();
};

test("RV12-F001 win32 (a): the process table cannot be read when Retry looks: nothing is typed, and the notice says the pane could not be checked", async () => {
	const s = await retryRig(undefined, undefined);
	assert.equal(await afterRetry(s), 1, "nothing typed after the first prompt");
	const texts = await startNotices(s);
	assert.equal(texts.length, 1);
	assert.match(texts[0]!, /could not check the standing pane/);
	assert.equal((await status(s)).state, "standing");
	assert.equal(world.pis.size, 0);
});

test("RV12-F001 win32 (b): a nested shell holds a node (the first read named nothing): Retry types nothing and names node.exe", async () => {
	const nested = row(5555, SHELL_PID, "bash.exe");
	const s = await retryRig([row(SHELL_PID, 1, "powershell.exe"), nested], [row(SHELL_PID, 1, "powershell.exe"), nested, row(7777, 5555, "node.exe")]);
	assert.equal(await afterRetry(s), 1, "nothing typed into the node");
	const texts = await startNotices(s);
	assert.equal(texts.length, 1);
	assert.match(texts[0]!, /busy with node\.exe/);
});

test("RV12-F001 win32 (c): Herdr's code was not agent_pane_busy (no program looked for at the start) and node runs: Retry types nothing", async () => {
	const table = [row(SHELL_PID, 1, "powershell.exe"), row(7777, SHELL_PID, "node.exe")];
	const s = await retryRig(table, table, "not_available");
	assert.equal(await afterRetry(s), 1, "nothing typed into the node");
	assert.match((await startNotices(s)).join("\n"), /busy with node\.exe/);
});

test("RV12-F001 win32 (d): a clean read below the shell (the tower prompt aside): Retry types the prompt command once", async () => {
	const prompt: Proc = { ...row(6666, SHELL_PID, "node.exe"), prompt: true };
	const s = await retryRig(undefined, [row(SHELL_PID, 1, "powershell.exe"), row(1234, SHELL_PID, "conhost.exe"), prompt]);
	assert.equal(await afterRetry(s), 2, "typed once");
	assert.deepEqual(await startNotices(s), []);
});

test("RV12-F001 win32: Retry while a program is found holds the service on the program, and its end (gone and the shell alone at two looks) gives the pane back by itself", async () => {
	const s = await retryRig([row(SHELL_PID, 1, "powershell.exe")], [row(SHELL_PID, 1, "powershell.exe"), row(7777, SHELL_PID, "node.exe")]);
	world.live.add(7777);
	assert.equal(await afterRetry(s), 1);
	assert.equal((await status(s)).state, "held");
	world.live.delete(7777);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	await until(() => typedPrompts() === 2, "the pane given back once the program has gone");
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

// RV10-F002 (the boss's rule F10: never type into a pane that runs a program): a start Herdr refused leaves no pi in the pane, so the run's end must not mark the pane a fresh shell, and a held service on Windows whose
// busy list is empty or unreadable types nothing: the list of shells it would see is the one a running program leaves too.
const typedPrompts = () => world.herdr.typed.filter((t) => /prompt --workspace/.test(t.text)).length;
const heldWithNoProof = async (table: Proc[] | undefined) => {
	const { s, pane } = await winSetup();
	world.procTable = table;
	await until(() => typedPrompts() === 1, "the first prompt typed into the new pane");
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal(starts(), 3);
	await sleep(500);
	return { s, pane, held: await status(s) };
};

test("RV10-F002 win32: the process table cannot be read (CIM failed), the start was refused as busy: the service is held and the prompt command is not typed into the boss's program", async () => {
	const { held } = await heldWithNoProof(undefined);
	assert.equal(held.notices.filter((n) => n.kind === "start").every((n) => !/busy with/.test(n.text)), true, "no program could be named");
	assert.equal(typedPrompts(), 1, "nothing typed after the first prompt");
});

test("RV10-F002 win32: the program below the shell is a nested shell (bash.exe, which is no program to name): held, and nothing is typed into it", async () => {
	const { held } = await heldWithNoProof([row(SHELL_PID, 1, "powershell.exe"), row(1234, SHELL_PID, "conhost.exe"), row(7777, SHELL_PID, "bash.exe")]);
	assert.equal(held.notices.filter((n) => n.kind === "start").every((n) => !/busy with/.test(n.text)), true);
	assert.equal(typedPrompts(), 1);
});

// B6 VM round 3c: with a nested shell (cmd, git-bash) in the standing pane Herdr refuses `agent start` (agent_pane_busy, "not an available shell") and no program is named, so the notice was Herdr's raw error.
const NOT_AT_SHELL = "The standing pane is not at its own shell: a nested shell or a program runs there. Leave it, then press Retry";

test("VM 3c win32: a nested shell in the standing pane: Herdr's refusal becomes one plain notice (no raw error, no program named) with Retry, translated; the hold and F10 stay", async () => {
	const { noticeRows } = await import("../gui/towermodel.ts");
	const { s } = await winSetup();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(1234, SHELL_PID, "conhost.exe"), row(7777, SHELL_PID, "bash.exe")];
	await until(() => typedPrompts() === 1, "the first prompt typed into the new pane");
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	const service = await status(s);
	assert.equal(starts(), 3);
	assert.deepEqual(service.notices.filter((n) => n.kind === "start").map((n) => n.text), [NOT_AT_SHELL]);
	assert.ok(!service.notices.some((n) => /agent_pane_busy|busy with/.test(n.text)));
	await sleep(300);
	assert.equal(typedPrompts(), 1, "F10: nothing typed into the nested shell");
	for (const o of [undefined, { locale: "zh-TW" }] as const) {
		const rows = noticeRows(service as never, o as never).filter((r) => r.id === "start");
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0]!.actions, ["retry"]);
		if (o) assert.ok(!/press Retry|nested shell/.test(rows[0]!.text) && /[\u4e00-\u9fff]/.test(rows[0]!.text), "translated");
		else assert.equal(rows[0]!.text, NOT_AT_SHELL);
	}
});

// RV16-F004: Herdr also calls the pane busy while the tower's own prompt or its stand-in label is still there (the yield failed, or a slow prompt outlived its time); no nested shell is seen then, and the notice must not say there is one.
test("RV16-F004 win32: Herdr refuses the start as busy and the process table shows the pane's shell alone: no nested-shell notice, Herdr's own message is shown", async () => {
	const { s } = await winSetup();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(1234, SHELL_PID, "conhost.exe"), { ...row(4321, SHELL_PID, "node.exe"), prompt: true }];
	await until(() => typedPrompts() === 1, "the first prompt typed into the new pane");
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	const texts = (await status(s)).notices.filter((n) => n.kind === "start").map((n) => n.text);
	assert.deepEqual(texts, ["A run could not start: herdr agent start failed"]);
});

test("RV16-F004 darwin: a nested shell in the foreground (besides the pane's own) gets the nested-shell notice", async () => {
	world.herdr.shellPids = true;
	const { s, pane } = await setup();
	world.herdr.onAgentStart = () => {
		throw paneBusyError();
	};
	world.herdr.pane(pane).processes = [{ name: "zsh", argv0: "zsh", pid: 9999 }];
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.deepEqual((await status(s)).notices.filter((n) => n.kind === "start").map((n) => n.text), [NOT_AT_SHELL]);
});

test("RV16-F004 darwin: Herdr says busy and the foreground shows the pane's own shell alone (the tower prompt or its label is what Herdr means): Herdr's own message, no nested shell", async () => {
	world.herdr.shellPids = true;
	const { s, pane } = await setup();
	world.herdr.onAgentStart = () => {
		throw paneBusyError();
	};
	world.herdr.pane(pane).processes = [{ name: "zsh", argv0: "zsh", pid: FAKE_SHELL }];
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).notices.some((n) => n.kind === "start"), "the start notice");
	assert.deepEqual((await status(s)).notices.filter((n) => n.kind === "start").map((n) => n.text), ["A run could not start: herdr agent start failed"]);
});

test("VM 3c: a program that is named keeps its own notice, not the nested-shell one", async () => {
	const { s } = await winSetup();
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.deepEqual((await status(s)).notices.filter((n) => n.kind === "start").map((n) => n.text), ["A run could not start: the standing pane is busy with node.exe; the tower starts again when it has ended, or on Retry"]);
});

test("RV10-F002 win32: Herdr refused the start with a code other than agent_pane_busy: held, nothing typed", async () => {
	const { s } = await winSetup();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(7777, SHELL_PID, "node.exe")];
	world.herdr.onAgentStart = () => {
		throw Object.assign(new Error("herdr agent start failed"), { stderr: JSON.stringify({ error: { code: "not_available", message: "the pane is not an available shell" } }) });
	};
	await until(() => typedPrompts() === 1, "the first prompt typed into the new pane");
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	await sleep(500);
	assert.equal(typedPrompts(), 1);
});

test("RV10-F002 win32: with the program found (node.exe below the shell) nothing is typed either, and the pane is not marked fresh by the runs that never started pi in it", async () => {
	const { s } = await winSetup();
	await until(() => typedPrompts() === 1, "the first prompt typed into the new pane");
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	await sleep(500);
	assert.equal(typedPrompts(), 1);
	assert.equal((await status(s)).state, "held");
});

test("RV10-F002 win32: a refused start leaves no pi in the fake's pane (the stock fake used to keep `agent: pi` there and hide the path)", async () => {
	const { s, pane } = await winSetup();
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal(world.herdr.pane(pane).agent, undefined);
});

test("RV10-F002 win32: a refused start whose event is gone leaves the service standing (one crash, not held): the pane it ended in is not marked fresh, so the prompt command is not typed into the boss's program", async () => {
	await winSetup();
	world.procTable = undefined;
	await until(() => typedPrompts() === 1, "the first prompt typed into the new pane");
	world.herdr.onAgentStart = () => {
		for (const e of readQueue(world.slot, "wA")) removeEvent(world.slot, "wA", e);
		throw paneBusyError();
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(() => starts() === 1, "the start");
	await until(() => readQueue(world.slot, "wA").length === 0, "the queue to be empty");
	await sleep(700);
	assert.equal(starts(), 1, "no second run: the service stands, not held");
	assert.equal(typedPrompts(), 1, "nothing typed after the run that never started pi");
});

// RV10-F003: what the notice names. The process table carries the tower prompt's mark (the table has no command line to filter by), a program that starts others is named once, and the list is capped.
const promptRow = (pid: number, ppid: number): Proc => ({ ...row(pid, ppid, "node.exe"), prompt: true });
const startNotice = async (s: Running) => (await status(s)).notices.filter((n) => n.kind === "start").map((n) => n.text);

test("RV10-F003 win32: the tower prompt that is still in the pane (and what it started) is not the boss's program: it is not named and does not keep the hold; the boss's program is, and its end frees the service", async () => {
	const { s } = await winSetup();
	world.live.add(5000);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), promptRow(5000, SHELL_PID), row(5001, 5000, "esbuild.exe"), row(7777, SHELL_PID, "python.exe")];
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.deepEqual(await startNotice(s), ["A run could not start: the standing pane is busy with python.exe; the tower starts again when it has ended, or on Retry"]);
	// The program ends while the (hung) prompt lives: the prompt is not in the busy list, so it does not hold the pane.
	world.live.delete(7777);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), promptRow(5000, SHELL_PID), row(5001, 5000, "esbuild.exe")];
	world.herdr.onAgentStart = real;
	await until(() => world.pis.size === 1, "a run to start once the program has gone");
});

test("RV10-F003 win32: only the tower prompt below the shell: no program to name, and the hold waits for Retry", async () => {
	const { s } = await winSetup();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), promptRow(5000, SHELL_PID)];
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal((await startNotice(s)).every((t) => !/busy with/.test(t)), true);
});

test("RV10-F003 win32: a program that starts others is named once, and at most three programs are named, the rest counted", async () => {
	const { s } = await winSetup();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(7001, SHELL_PID, "node.exe"), row(7002, 7001, "node.exe"), row(7003, 7002, "esbuild.exe"), row(7004, 7001, "python.exe"), row(7005, 7001, "cl.exe"), row(7006, 7001, "git.exe")];
	for (const pid of [7001, 7002, 7003, 7004, 7005, 7006]) world.live.add(pid);
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.deepEqual(await startNotice(s), ["A run could not start: the standing pane is busy with node.exe, esbuild.exe, python.exe and 2 more; the tower starts again when it has ended, or on Retry"]);
	// All of them keep the hold, not only the named ones.
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(7006, SHELL_PID, "git.exe")];
	world.herdr.onAgentStart = real;
	for (const pid of [7001, 7002, 7003, 7004, 7005]) world.live.delete(pid);
	const before = starts();
	await sleep(400);
	assert.equal(starts(), before, "git.exe, the sixth, still holds the pane");
	world.live.delete(7006);
	await until(() => world.pis.size === 1, "a run to start once every program has gone");
});

test("RV10-F004 win32 (M1): a leftover of the failed run itself below the shell (it carries the run id), and what it started, is not the boss's program: not named, and no busy list", async () => {
	const { s } = await winSetup();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(7001, SHELL_PID, "cmd.exe", true), row(7002, 7001, "node.exe")];
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal((await startNotice(s)).every((t) => !/busy with/.test(t)), true, "the run's own processes are not the boss's");
});

test("RV10-F004 win32 (M3): the process table is read only when Herdr says the pane is busy: another code names no program below the shell", async () => {
	const { s } = await winSetup();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(7777, SHELL_PID, "node.exe")];
	world.herdr.onAgentStart = () => {
		throw Object.assign(new Error("herdr agent start failed"), { stderr: JSON.stringify({ error: { code: "not_available", message: "the pane is not an available shell" } }) });
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal((await startNotice(s)).every((t) => !/busy with/.test(t)), true);
});

test("RV10-F004 (M4): where Herdr lists the foreground (not Windows) the process table is not read for a pane that is busy: a node below the shell is not named from it", async () => {
	world.herdr.shellPids = true;
	const { s } = await setup();
	world.procTable = [row(FAKE_SHELL, 1, "zsh"), row(7777, FAKE_SHELL, "node")];
	world.herdr.onAgentStart = () => {
		throw paneBusyError();
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal((await startNotice(s)).every((t) => !/busy with/.test(t)), true, "the foreground list is the source there");
});

test("RV10-F003: the process table marks the tower prompt (CIM's sixth field, `ps`'s command line); an older five-field row has no mark", () => {
	const [prompt, plain, old] = parseCim(["5000\t900\t2026-10-28T09:40:00.123Z\tnode.exe\t0\t1", "7777\t900\t2026-10-28T09:40:01.123Z\tnode.exe\t0\t0", "7778\t900\t2026-10-28T09:40:02.123Z\tnode.exe\t0"].join("\r\n"));
	assert.equal(prompt!.prompt, true);
	assert.equal(plain!.prompt, undefined);
	assert.equal(old!.prompt, undefined);
	const ps = parsePs([" 4000 1 Wed Oct 28 09:40:00 2026 node /p/cli.mjs prompt --workspace wA --state-dir /s", " 4001 1 Wed Oct 28 09:40:01 2026 node server.js --prompt"].join("\n"), "abc");
	assert.deepEqual(ps.map((p) => p.prompt), [true, undefined]);
	const cim = cimCommand("abc").args.join(" ");
	assert.match(cim, /Contains\(' prompt --workspace '\)/);
	// The flag is set by that test and is the sixth column of the row (RV11-F003, mutation N9: `$q='1'` to `$q='0'` survived).
	assert.match(cim, /Contains\(' prompt --workspace '\)\) \{ \$q='1' \}/);
	assert.match(cim, /\$c,\$q\) -join/);
});

// RV13-F001/F002: Retry and the hold's proof never type into a pane that runs a program or that the boss parked with Ctrl+D.
const winFirst = async () => {
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => typedPrompts() === 1, "the first prompt");
	return s;
};
const park = async (s: Running) => {
	assert.equal((await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4321 })).ok, true);
	assert.equal((await ask(s, { cmd: "prompt-leave", workspace: "wA", pid: 4321 })).ok, true);
};

test("RV13-A win32: the boss parked the pane with Ctrl+D and runs node there; Retry with nothing queued reads the table, holds, and types nothing", async () => {
	const s = await winFirst();
	await park(s);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(7777, SHELL_PID, "node.exe")];
	world.live.add(7777);
	await sleep(400);
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await until(async () => (await status(s)).state === "held", "held on the program found");
	await sleep(400);
	assert.equal(typedPrompts(), 1, "F10: nothing typed into node");
	assert.ok((await startNotices(s)).some((t) => /node\.exe/.test(t)), "the notice names node.exe");
});

test("RV13-A win32: parked pane, clean table: Retry keeps the park and types nothing", async () => {
	const s = await winFirst();
	await park(s);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(700);
	assert.equal(typedPrompts(), 1, "the boss's park is not ended by Retry");
});

test("RV13-A2 darwin: parked pane at an idle shell; Retry does not give the shell back", async () => {
	world.herdr.shellPids = true;
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => typedPrompts() === 1, "the first prompt");
	await park(s);
	await sleep(400);
	assert.equal(typedPrompts(), 1);
	await ask(s, { cmd: "tower-retry", workspace: "wA" });
	await sleep(600);
	assert.equal(typedPrompts(), 1, "parked: Retry types nothing");
});

test("darwin: Retry with nothing queued on a pane that is not parked gives it back, and the prompt is typed again inside the launch backoff (mutation M1)", async () => {
	world.herdr.shellPids = true;
	world.standingTimers = { launchMs: 60_000, launchMaxMs: 60_000 };
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => typedPrompts() === 1, "the first prompt");
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await until(() => typedPrompts() === 2, "the prompt typed again after Retry");
});

test("RV13-C win32: Retry with an unreadable table (nothing believed of the pane) types nothing and says so with a Retry", async () => {
	const s = await winFirst();
	world.procTable = undefined;
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await until(async () => (await startNotices(s)).length > 0, "the notice");
	await sleep(400);
	assert.equal(typedPrompts(), 1, "nothing typed on a failed read");
});

test("win32: Retry with nothing queued and a clean table read types the prompt again once", async () => {
	const s = await winFirst();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await until(() => typedPrompts() === 2, "typed after the proof");
	await sleep(400);
	assert.equal(typedPrompts(), 2);
});

test("RV13-B win32: the hold ends by the two-look proof with an event waiting and its run refused; nothing is typed on the look's mark", async () => {
	const s = await winFirst();
	world.live.add(7777);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(7777, SHELL_PID, "node.exe")];
	world.herdr.onAgentStart = () => { throw paneBusyError(); };
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await status(s)).state === "held", "held");
	assert.ok(readQueue(world.slot, "wA").length >= 1, "an event waits");
	world.settingsError = new Error("refused");
	world.live.delete(7777);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(8888, SHELL_PID, "node.exe")];
	world.live.add(8888);
	await until(async () => (await status(s)).state !== "held", "the hold ends", 5000);
	await sleep(1500);
	assert.equal(typedPrompts(), 1, "F10: nothing typed into node 8888");
});

test("RV13-F003: the proveEmpty notices carry a Retry the GUI shows, and their text is translated", async () => {
	const { noticeRows } = await import("../gui/towermodel.ts");
	const s = await winFirst();
	world.procTable = undefined;
	await ask(s, { cmd: "tower-retry", workspace: "wA" });
	await until(async () => (await startNotices(s)).length > 0, "the notice");
	const service = await status(s);
	for (const o of [undefined, { locale: "zh-TW" }] as const) {
		const rows = noticeRows(service as never, o as never).filter((r) => r.id === "start");
		assert.equal(rows.length, 1);
		assert.deepEqual(rows[0]!.actions, ["retry"]);
		if (o) assert.ok(!/press Retry/.test(rows[0]!.text), "translated");
	}
});

test("win32: two Retries while the table read is pending make one read (mutation M7)", async () => {
	const s = await winFirst();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	let release!: () => void;
	world.procGate = () => new Promise<void>((done) => (release = done));
	const before = world.procReads;
	await ask(s, { cmd: "tower-retry", workspace: "wA" });
	await until(() => world.procReads === before + 1, "the read to begin");
	await ask(s, { cmd: "tower-retry", workspace: "wA" });
	await sleep(200);
	assert.equal(world.procReads, before + 1, "the second Retry waits for the first proof");
	world.procGate = undefined;
	release();
	await until(() => typedPrompts() === 2, "typed once after the proof");
});

test("RV14-A win32: Retry with nothing queued while the tower prompt runs and polls in the pane types nothing into the prompt", async () => {
	const s = await winFirst();
	assert.equal((await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4321 })).ok, true);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), { ...row(4321, SHELL_PID, "node.exe"), prompt: true }];
	world.live.add(4321);
	await sleep(300);
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(800);
	console.log("RV14-A typed:", typedPrompts(), "reads:", world.procReads);
	assert.equal(typedPrompts(), 1, "the prompt that runs is not typed into");
});

test("RV14-A2 win32: the same with a Herdr that does not keep the stand-in label", async () => {
	world.herdr.refuseStandin = true;
	const s = await winFirst();
	assert.equal((await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4321 })).ok, true);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), { ...row(4321, SHELL_PID, "node.exe"), prompt: true }];
	world.live.add(4321);
	await sleep(300);
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(800);
	console.log("RV14-A2 typed:", typedPrompts(), "reads:", world.procReads);
	assert.equal(typedPrompts(), 1, "the prompt that runs is not typed into");
});

test("RV14-C win32: a parked pane's clean Retry leaves a fresh mark that outlives the park", async () => {
	const s = await winFirst();
	await park(s);
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(700);
	assert.equal(typedPrompts(), 1, "parked");
	// the boss later starts the prompt by hand; it polls once and then dies without Ctrl+D (a crash)
	assert.equal((await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 5555 })).ok, true);
	await sleep(8000);
	console.log("RV14-C typed:", typedPrompts());
	assert.equal(typedPrompts(), 1, "no type on a mark from before the boss's own prompt");
});

test("RV14-F001 darwin: Retry with nothing queued while the tower prompt polls gives nothing back and types nothing", async () => {
	world.herdr.shellPids = true;
	world.herdr.refuseStandin = true;
	world.standingTimers = { launchMs: 60_000, launchMaxMs: 60_000 };
	const s = await world.start();
	await s.handle.ready;
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => typedPrompts() === 1, "the first prompt");
	assert.equal((await ask(s, { cmd: "prompt-poll", workspace: "wA", pid: 4321 })).ok, true);
	assert.equal((await ask(s, { cmd: "tower-retry", workspace: "wA" })).ok, true);
	await sleep(800);
	assert.equal(typedPrompts(), 1, "the prompt that runs is not typed into");
});

test("RV14-F001 win32: a start notice from an earlier failed run does not outlive a run that claims", async () => {
	const s = await winFirst();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe")];
	const real = world.herdr.onAgentStart;
	let failed = false;
	world.herdr.onAgentStart = (pane, args) => {
		if (!failed) {
			failed = true;
			throw new Error("boom");
		}
		return real?.(pane, args);
	};
	tower().incoming(from, { id: "m1", content: { text: "one" } });
	await until(async () => (await startNotices(s)).length > 0, "the start notice");
	await until(() => world.pis.size >= 1, "the next run to start", 8000);
	const id = [...world.pis.keys()][0]!, pi = world.pis.get(id)!;
	await until(async () => (await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` })).ok === true, "the claim", 5000);
	assert.deepEqual(await startNotices(s), [], "no stale start notice with a Retry");
});

test("RV14-F004: the program-found notice is translated too", async () => {
	const { noticeRows } = await import("../gui/towermodel.ts");
	const s = await winFirst();
	world.procTable = [row(SHELL_PID, 1, "powershell.exe"), row(7777, SHELL_PID, "node.exe")];
	world.live.add(7777);
	await ask(s, { cmd: "tower-retry", workspace: "wA" });
	await until(async () => (await status(s)).state === "held", "held on the program found");
	const service = await status(s);
	for (const o of [undefined, { locale: "zh-TW" }] as const) {
		const rows = noticeRows(service as never, o as never).filter((r) => r.id === "start");
		assert.equal(rows.length, 1);
		if (o) assert.ok(!/The tower types nothing/.test(rows[0]!.text) && /node\.exe/.test(rows[0]!.text), rows[0]!.text);
		else assert.match(rows[0]!.text, /The tower types nothing/);
	}
});
