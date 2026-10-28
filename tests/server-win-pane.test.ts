import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { type Proc } from "../src/server/lineage.ts";
import { runTimersFor } from "../src/server/runs.ts";
import { TIMERS } from "../src/server/runs.ts";
import { TOWER_LABEL } from "../src/herdr.ts";

// Windows (VM pass B6, x6a-x6i): a pi ended with TerminateProcess leaves the console input mode of its pane broken, and `herdr agent start` into the same pane then types a mangled command and times out. So on Windows
// the server ends a run by asking (the quit command at the run's poll, then Escape and /quit through Herdr) and waits longer, never kills a pi of a stopping server, and does not reuse a pane after a forced kill.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.runPlatform = "win32";
	world.herdr.winShell = true;
	world.herdr.shellForeground = true;
});
afterEach(() => world.close());

type Reply = Record<string, unknown> & { ok: boolean; error?: string; token?: string; command?: { type: string }; tab?: string; pane?: string; opened?: boolean };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const from = { id: "main-1", name: "docs-main" };
const msg = (id: string, text: string) => ({ id, content: { text } });
/** The tower's client: the identity registers again when its pane is renewed, and the newest connection is the live one. */
const tower = () => world.clients.filter((c) => c.sessionId === "sb-tower-wa").at(-1)!;
const setup = async () => {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, ensured };
};
const nthRun = async (n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
/** The run's claim, once the renewed identity is registered (a claim is held until it is). */
const claimed = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	let token: string | undefined;
	await until(async () => {
		const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
		assert.equal(got.ok, true, JSON.stringify(got));
		token = got.token;
		return Boolean(token);
	}, "the claim to pass");
	return token!;
};
/** Takes every event the run is offered, as a run does before its tower_done. */
const drain = async (s: Running, token: string) => {
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) return;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
};
/** What Herdr's `agent start` says when the agent does not come up: JSON on stderr with the code (VM ev x6e, x6h), and the command line (with its own `--timeout 30000`) in the message. */
const startTimeout = () => Object.assign(new Error("herdr agent start --kind pi --timeout 30000 failed: timeout: timed out waiting for agent startup"), { stderr: JSON.stringify({ error: { code: "timeout", message: "timed out waiting for agent startup" }, id: "cli:agent:start" }) });
/** The plain-text form (`timeout: ...`) some Herdr versions print. */
const plainTimeout = () => Object.assign(new Error("herdr agent start failed"), { stderr: "timeout: timed out waiting for agent startup" });
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);

test("win32: a stop tells the run to quit at its poll and waits for pi to leave; a pi that leaves is not killed", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await until(async () => (await ask(s, { cmd: "run-poll", token, idle: true })).command?.type === "quit", "the quit command at the run's poll");
	exit(id);
	await s.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "quit");
	assert.deepEqual(world.kills, []);
});

test("win32: a pi that stays after the stop's grace is not killed: the run is left unfinished, for the next server to reclaim or for pi to end itself", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await claimed(s, id);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.deepEqual(world.kills, [], "no TerminateProcess: it breaks the pane for the next pi");
	assert.equal(readRun(world.slot, "wA", id)?.outcome, undefined, "no outcome: the next server finds the run and its pi reclaims it");
});

test("elsewhere a pi that stays after the stop's grace is signalled, and the signal is sent before the server exits however long the process table takes", async () => {
	world.runPlatform = undefined;
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await claimed(s, id);
	const pi = world.pis.get(id)!.pid;
	world.procGate = () => sleep(2500);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.deepEqual(world.kills, [[pi, "SIGTERM"]], "the exit waited for the signal");
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "quit");
});

test("win32: a pi that leaves by itself after tower_done leaves the standing pane as it is", async () => {
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	assert.deepEqual(world.herdr.closed, []);
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).pane, ensured.pane);
});

test("win32: after a forced kill the standing pane is closed and a fresh one stands in before the next run, which starts there", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	const pi = world.pis.get(id)!.pid;
	// pi hands in its note and stays: Escape and /quit, then the signal.
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	assert.deepEqual(world.kills, [[pi, "SIGTERM"]]);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	await until(() => world.herdr.closed.includes(ensured.pane!), "the old standing pane to be closed");
	const again = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(again.opened, false, "the service stands: only its pane is new");
	assert.notEqual(again.pane, ensured.pane);
	assert.equal(world.herdr.panes.find((p) => p.pane_id === again.pane)?.tokens.sb_role, "tower");
	tower().incoming(from, msg("m2", "two"));
	const second = await nthRun(2);
	assert.equal(world.pis.get(second)!.pane, again.pane, "the next run starts in the fresh pane");
	assert.ok(!world.herdr.panes.some((p) => p.pane_id === ensured.pane), "the old pane is gone");
});

test("win32: a start that times out is tried once more in a fresh pane, and the first timeout is not counted as a crash", async () => {
	const { s, ensured } = await setup();
	const base = world.herdr.onAgentStart!;
	let first = true;
	world.herdr.onAgentStart = (pane, args) => {
		if (first) {
			first = false;
			throw startTimeout();
		}
		base(pane, args);
	};
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	assert.notEqual(world.pis.get(id)!.pane, ensured.pane, "the retry runs in a fresh pane");
	assert.ok(world.herdr.closed.includes(ensured.pane!), "the old standing pane is closed");
	assert.ok(!world.herdr.tabs.some((t) => t.tab_id === ensured.tab), "and its tab went with it, being empty");
	assert.equal(readRun(world.slot, "wA", id)?.pane, world.pis.get(id)!.pane, "the record names the pane it runs in");
	await claimed(s, id);
	const service = ((await ask(s, { cmd: "status" })).towers as { service: { crashes?: number; notices: { kind: string }[] } }[])[0]!.service;
	assert.equal(service.crashes, undefined);
	assert.ok(!service.notices.some((n) => n.kind === "start"));
});

const status = async (s: Running) => ((await ask(s, { cmd: "status" })).towers as { service: { state: string; crashes?: number } }[])[0]!.service;
const starts = () => world.herdr.commands("agent", "start").length;

test("win32: a start that times out twice is one crash of its run: three runs hold the service after six starts", async () => {
	const { s } = await setup();
	world.herdr.onAgentStart = () => {
		throw startTimeout();
	};
	tower().incoming(from, msg("m1", "one"));
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal(starts(), 6, "each run started twice");
	assert.equal((await status(s)).crashes, 3);
});

test("elsewhere a start that times out ends the run as before: one start per run, three runs hold the service, no new pane", async () => {
	world.runPlatform = undefined;
	const { s, ensured } = await setup();
	world.herdr.onAgentStart = () => {
		throw startTimeout();
	};
	tower().incoming(from, msg("m1", "one"));
	await until(async () => (await status(s)).state === "held", "the service to be held");
	assert.equal(starts(), 3);
	assert.deepEqual(world.herdr.closed, []);
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).pane, ensured.pane);
});

test("win32: the fresh standing pane made after a forced kill gets the tower prompt typed (Herdr gives no foreground group there, so only a pane known fresh is typed into)", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const { s, ensured } = await setup();
	await until(() => world.herdr.typed.some((t) => t.pane === ensured.pane), "the prompt typed into the first standing pane");
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	exit(id);
	await until(() => world.herdr.closed.includes(ensured.pane!), "the old standing pane to be closed");
	const again = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.notEqual(again.pane, ensured.pane);
	await until(() => world.herdr.typed.some((t) => t.pane === again.pane && /prompt --workspace wA/.test(t.text)), "the prompt typed into the renewed pane");
});

// --- review 2 (sb-wincmd-review2) ---------------------------------------------------------------------------------------------------------------------------------

const proc = (pid: number, ppid: number, name: string, carries: boolean, started?: string): Proc => ({ pid, ppid, name, carries, ...(started ? { started } : {}) });
const outcomeOf = async (s: Running) => ((await ask(s, { cmd: "status" })).towers as { service?: { lastRun?: { outcome: string } } }[])[0]?.service?.lastRun?.outcome;

test("RV2-F001: a failed start that is not Herdr's timeout code ends nothing: a busy standing pane running the user's program keeps its pane and its tab, and the message's own `--timeout` is not a timeout", async () => {
	const { s, ensured } = await setup();
	world.herdr.pane(ensured.pane!).processes = [{ name: "node.exe", argv0: "node", pid: 4242, cmdline: "node C:\\me\\devserver.js" }];
	world.herdr.busy = 999;
	tower().incoming(from, msg("m1", "one"));
	await until(async () => (await outcomeOf(s)) === "crashed", "the run to end", 30_000);
	assert.deepEqual(world.herdr.closed, [], "nothing of the user's is closed");
	assert.deepEqual(world.kills, []);
	assert.equal(starts(), 20, "Herdr's own busy retries, and no second start of the run in a new pane");
});

test("RV2-F001: a start that fails with another code than timeout (its message still holds --timeout) is not retried and no pane is renewed", async () => {
	const { s } = await setup();
	world.herdr.onAgentStart = () => {
		throw Object.assign(new Error("herdr agent start --kind pi --timeout 30000 failed: agent_name_taken: that name is in use"), { stderr: "agent_name_taken: that name is in use" });
	};
	tower().incoming(from, msg("m1", "one"));
	await until(async () => (await outcomeOf(s)) === "crashed", "the run to end");
	assert.equal(starts(), 1);
	assert.deepEqual(world.herdr.closed, []);
});

const retriedOnce = async (failure: () => Error) => {
	{
		const { s, ensured } = await setup();
		const base = world.herdr.onAgentStart!;
		const seen: { id: string; pane: string }[] = [];
		let first = true;
		world.herdr.onAgentStart = (pane, args) => {
			seen.push({ id: args[args.indexOf("--sb-run") + 1]!, pane: pane.pane_id });
			if (first) {
				first = false;
				throw failure();
			}
			base(pane, args);
		};
		tower().incoming(from, msg("m1", "one"));
		await nthRun();
		assert.equal(starts(), 2);
		assert.equal(seen[0]!.id, seen[1]!.id, "the second start is the same run's");
		assert.equal(seen[0]!.pane, ensured.pane);
		assert.notEqual(seen[1]!.pane, ensured.pane, "in a new pane");
		const service = (await status(s)) as { crashes?: number; notices?: { kind: string }[] };
		assert.equal(service.crashes, undefined);
		assert.ok(!service.notices?.some((n) => n.kind === "start"));
	}
};
test("RV2-F001: a timeout reported as JSON on stderr (the format real Herdr prints) is retried once in a new pane of the same run, without a crash", () => retriedOnce(startTimeout));
test("RV2-F001: a timeout reported as plain text on stderr is retried the same way", () => retriedOnce(plainTimeout));

test("RV2-F001: a start timeout renews the pane, but a pane running the user's program (not a shell, not this run's pi) is kept: it loses the tower marks and its tab the tower label, and the run starts in a new pane", async () => {
	const { ensured } = await setup();
	const base = world.herdr.onAgentStart!;
	let first = true;
	world.herdr.onAgentStart = (pane, args) => {
		if (first) {
			first = false;
			pane.processes = [{ name: "node.exe", argv0: "node", pid: 4242, cmdline: "node C:\\me\\devserver.js" }];
			throw startTimeout();
		}
		base(pane, args);
	};
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	assert.notEqual(world.pis.get(id)!.pane, ensured.pane);
	assert.ok(world.herdr.panes.some((p) => p.pane_id === ensured.pane), "the user's pane is still there");
	assert.ok(!world.herdr.closed.includes(ensured.pane!) && !world.herdr.closed.includes(ensured.tab!));
	assert.equal(world.herdr.pane(ensured.pane!).tokens.sb_role, undefined, "it no longer carries the tower mark");
	assert.notEqual(world.herdr.tabs.find((t) => t.tab_id === ensured.tab)?.label, TOWER_LABEL, "its tab is not taken for the tower's");
});

test("RV2-F002: a renew closes the standing pane only: another pane in the tab stays, and the tab is no longer the tower's", async () => {
	const { ensured } = await setup();
	const other = world.herdr.addPane("wA:p990", ensured.tab!, "shell");
	other.processes = [{ name: "node.exe", argv0: "node", pid: 4343, cmdline: "node C:\\me\\watch.js" }];
	const base = world.herdr.onAgentStart!;
	let first = true;
	world.herdr.onAgentStart = (p, args) => {
		if (first) {
			first = false;
			throw startTimeout();
		}
		base(p, args);
	};
	tower().incoming(from, msg("m1", "one"));
	await nthRun();
	assert.ok(world.herdr.panes.some((p) => p.pane_id === "wA:p990"), "the other pane stays");
	assert.ok(!world.herdr.closed.includes(ensured.tab!), "no tab close");
	assert.ok(world.herdr.closed.includes(ensured.pane!), "the standing pane (a bare shell) is closed");
	assert.notEqual(world.herdr.tabs.find((t) => t.tab_id === ensured.tab)?.label, TOWER_LABEL);
});

test("RV2-F002: after a forced kill the leftover pi's pane is closed (the run's own carrier counts as the run's), and an ally pane split off it stays", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	const ally = world.herdr.addPane("wA:p991", ensured.tab!, "shell");
	ally.processes = [{ name: "node", argv0: "pi", pid: 7777, cmdline: "node pi --sb-run other" }];
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	exit(id);
	await until(() => world.herdr.closed.includes(ensured.pane!), "the standing pane to be closed");
	assert.ok(world.herdr.panes.some((p) => p.pane_id === "wA:p991"), "the ally pane stays");
	assert.ok(!world.herdr.closed.includes(ensured.tab!));
});

test("RV2-F002: a forced kill whose pane now runs the user's program renews around it: the pane is kept", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	exit(id);
	world.herdr.pane(ensured.pane!).processes = [{ name: "node.exe", argv0: "node", pid: 4242, cmdline: "node C:\\me\\devserver.js" }];
	await until(async () => (await ask(s, { cmd: "ensure-tower", workspace: "wA" })).pane !== ensured.pane, "the new standing pane");
	assert.ok(world.herdr.panes.some((p) => p.pane_id === ensured.pane), "the user's pane is kept");
	assert.deepEqual(world.herdr.closed, []);
});

test("RV2-F003: a pi the boss starts by hand in a pane being renewed is told to quit, not admitted", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const orig = world.herdr.api;
	let gate: Promise<void> | undefined, open!: () => void, held = false;
	world.herdr.api = async (method, params) => {
		if (gate) (held = true, await gate);
		return orig(method, params);
	};
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	gate = new Promise<void>((done) => (open = done));
	exit(id);
	world.herdr.pane(ensured.pane!).processes = [];
	await until(() => held, "the renew to reach tab.move", 5000);
	world.herdr.pane(ensured.pane!).processes = [{ name: "node", argv0: "pi", pid: 9100, cmdline: "node pi" }];
	world.live.add(9100);
	const role = await ask(s, { cmd: "pane-role", pane: ensured.pane, pid: 9100, started: "T-9100" });
	gate = undefined;
	open();
	await until(async () => (await ask(s, { cmd: "ensure-tower", workspace: "wA" })).pane !== ensured.pane, "the renew to end");
	assert.equal(role.role, "quit", JSON.stringify(role));
	assert.ok(world.herdr.panes.some((p) => p.pane_id === ensured.pane), "the pane of the hand pi is not closed under it (a pi, not a shell)");
});

test("RV2-F004: the failed-start kill re-checks a listed carrier in the table it read: a PID the table shows as another program is not signalled", async () => {
	world.runPlatform = undefined;
	const base = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (pane, args) => {
		base(pane, args);
		const id = args[args.indexOf("--sb-run") + 1]!;
		pane.processes = [{ name: "cmd.exe", argv0: "cmd.exe", pid: 900, cmdline: `cmd.exe /c pi.cmd --sb-run ${id}` }];
		world.procTable = [proc(900, 1, "calc.exe", false, "2026-10-28T11:00:00.000Z")];
		throw new Error("herdr agent start failed: agent_name_taken");
	};
	await setup();
	tower().incoming(from, msg("m1", "one"));
	await until(() => world.pis.size >= 1, "the run to start");
	const id = [...world.pis.keys()][0]!;
	await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", "the run to end crashed");
	assert.deepEqual(world.kills, [], "900 is not the run's in the table read for the kill");
});

test("RV2-F004: a listed carrier the table confirms is still ended, and so is one when the table cannot be read", async () => {
	world.runPlatform = undefined;
	const base = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (pane, args) => {
		base(pane, args);
		const id = args[args.indexOf("--sb-run") + 1]!;
		pane.processes = [{ name: "cmd.exe", argv0: "cmd.exe", pid: 900, cmdline: `cmd.exe /c pi.cmd --sb-run ${id}` }];
		world.live.add(900);
		world.procTable = [proc(900, 1, "cmd.exe", true, "2026-10-28T11:00:00.000Z")];
		throw new Error("herdr agent start failed: agent_name_taken");
	};
	await setup();
	tower().incoming(from, msg("m1", "one"));
	await until(() => world.kills.length >= 1, "the kill");
	assert.deepEqual(world.kills[0], [900, "SIGTERM"]);
});

test("RV2-F005: a tower closed while its pane is being renewed does not stand again in a new tab", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const orig = world.herdr.api;
	let gate: Promise<void> | undefined, open!: () => void, held = false;
	world.herdr.api = async (method, params) => {
		if (gate) (held = true, await gate);
		return orig(method, params);
	};
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	gate = new Promise<void>((done) => (open = done));
	exit(id);
	await until(() => held, "the renew to reach tab.move", 5000);
	const closing = ask(s, { cmd: "close-tower", workspace: "wA" });
	await sleep(100);
	gate = undefined;
	open();
	await closing;
	await sleep(400);
	assert.deepEqual(world.herdr.tabs.filter((t) => t.workspace_id === "wA" && t.label === TOWER_LABEL && t.tab_id !== ensured.tab), [], "no new tower tab stands");
	assert.equal(((await ask(s, { cmd: "status" })).towers as unknown[]).length, 0);
});

test("RV2-F006: a run a win32 stop left is recorded quit by the next server, with its events returned and no crash counted", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, undefined);
	exit(id);
	world.clients.length = 0;
	const second = await world.start();
	await second.handle.ready;
	await until(() => readRun(world.slot, "wA", id)?.outcome === "quit", "the left run to end quit");
	assert.equal(readQueue(world.slot, "wA")[0]?.flag, "crash");
	assert.equal(readQueue(world.slot, "wA")[0]?.crashes, undefined, "no crash counted");
	assert.equal((await status(second)).crashes, undefined);
});

test("RV2-F006: a left run whose pi reclaims it from the next server is a live run again, not a quit one", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	await claimed(s, id);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	world.clients.length = 0;
	const second = await world.start();
	await second.handle.ready;
	const again = await claimed(second, id);
	assert.ok(again);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "crashed", "pi leaves without tower_done: crashed, as any run");
});

test("RV2-M12: while the pane is renewed the identity is not live, so no wake starts a run in the old pane", async () => {
	world.runTimers = { quitGrace: 60, signal: 60 };
	const orig = world.herdr.api;
	let gate: Promise<void> | undefined, open!: () => void, held = false;
	world.herdr.api = async (method, params) => {
		if (gate) (held = true, await gate);
		return orig(method, params);
	};
	const { s, ensured } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => world.kills.length >= 1, "the signal");
	gate = new Promise<void>((done) => (open = done));
	exit(id);
	await until(() => held, "the renew to reach tab.move", 5000);
	const fresh = world.herdr.panes.find((p) => p.pane_id !== ensured.pane && p.workspace_id === "wA" && world.herdr.tabs.find((t) => t.tab_id === p.tab_id)?.label === TOWER_LABEL);
	assert.equal(fresh?.tokens.sb_role, "tower", "the new pane is marked before the record moves to it");
	tower().incoming(from, msg("m2", "two"));
	await sleep(300);
	assert.equal(world.pis.size, 1, "no run starts while the pane is renewed");
	gate = undefined;
	open();
	await nthRun(2);
	assert.notEqual([...world.pis.values()][1]!.pane, ensured.pane);
});

// --- survivors of the review's mutations ---------------------------------------------------------------------------------------------------------------------------

test("RV2-M1: Windows waits are longer than the others', and only Windows has them", () => {
	const win = runTimersFor("win32");
	assert.deepEqual([win.quitGrace, win.signal, win.stopGrace], [30_000, 20_000, 8000]);
	assert.ok(win.quitGrace > TIMERS.quitGrace && win.signal > TIMERS.signal && win.stopGrace > TIMERS.stopGrace);
	assert.deepEqual(runTimersFor("linux"), TIMERS);
	assert.deepEqual(runTimersFor("darwin"), TIMERS);
});

test("RV2-M7: a run started again after a timeout whose leftovers were signalled ends cleanly without renewing the pane a second time", async () => {
	const { s } = await setup();
	const base = world.herdr.onAgentStart!;
	let first = true;
	world.herdr.onAgentStart = (pane, args) => {
		if (first) {
			first = false;
			const id = args[args.indexOf("--sb-run") + 1]!;
			pane.processes = [{ name: "cmd.exe", argv0: "cmd.exe", pid: 900, cmdline: `cmd.exe /c pi.cmd --sb-run ${id}` }];
			world.live.add(900);
			throw startTimeout();
		}
		base(pane, args);
	};
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	assert.deepEqual(world.kills, [[900, "SIGTERM"]], "the leftover of the first start was ended");
	const closedBefore = world.herdr.closed.length;
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	await sleep(200);
	assert.equal(world.herdr.closed.length, closedBefore, "the new pane was not used up by the run's clean end");
});

test("RV2-M8: a claim that does not come in time is the run's crash, not a start to try again in another pane", async () => {
	world.runTimers = { claim: 150 };
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	await until(async () => (await outcomeOf(s)) === "crashed", "the run to end");
	assert.equal(starts(), 1);
});

test("RV2-M15: a win32 stop records a run whose tower_done is in as done, and signals nothing", async () => {
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	await drain(s, token);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	assert.equal((await ask(s, { cmd: "stop" })).ok, true);
	await s.handle.done;
	assert.equal(readRun(world.slot, "wA", id)?.outcome, "done");
	assert.equal(readRun(world.slot, "wA", id)?.left, undefined);
	assert.deepEqual(world.kills, []);
});

test("RV2-M23: with no process table to read, a pi that is gone by the time of the signal (its PID may be another program's) is not signalled", async () => {
	world.runPlatform = undefined;
	world.runTimers = { quitGrace: 60, signal: 60 };
	const { s } = await setup();
	tower().incoming(from, msg("m1", "one"));
	const id = await nthRun();
	const token = await claimed(s, id);
	const pi = world.pis.get(id)!.pid;
	// Herdr lists pi without the run id in its command line, so only the recorded PID can name it.
	world.herdr.pane(world.pis.get(id)!.pane).processes = [{ name: "node", argv0: "pi", pid: pi, cmdline: "node pi" }];
	await drain(s, token);
	let open!: () => void, reached = false;
	const gate = new Promise<void>((done) => (open = done));
	world.procGate = async () => (reached = true, await gate);
	assert.equal((await ask(s, { cmd: "run-done", token, note: "ok" })).ok, true);
	await until(() => reached, "the signal to wait for the process table");
	world.live.delete(pi);
	open();
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	assert.deepEqual(world.kills, [], "the dead pi's PID is not signalled");
});

test("RV2-M24: a start that fails does not get Escape and /quit typed into the pane while its leftovers are ended", async () => {
	world.runPlatform = undefined;
	world.runTimers = { quitGrace: 50 };
	const base = world.herdr.onAgentStart!;
	world.herdr.onAgentStart = (pane, args) => {
		base(pane, args);
		const id = args[args.indexOf("--sb-run") + 1]!;
		pane.processes = [{ name: "cmd.exe", argv0: "cmd.exe", pid: 900, cmdline: `cmd.exe /c pi.cmd --sb-run ${id}` }];
		world.live.add(900);
		world.procTable = [proc(900, 1, "cmd.exe", true, "2026-10-28T11:00:00.000Z")];
		throw new Error("herdr agent start failed: agent_name_taken");
	};
	world.procGate = () => sleep(500);
	await setup();
	tower().incoming(from, msg("m1", "one"));
	await until(() => world.kills.length >= 1, "the leftover to be ended", 10_000);
	await sleep(100);
	assert.deepEqual(world.herdr.keys, [], "nothing is typed into a pane whose pi never claimed");
});

// --- review 3 (sb-wincmd-review3) ---------------------------------------------------------------------------------------------------------------------------------

const renewOnTimeout = (pane: string, processes: { name?: string; argv0?: string; pid?: number; cmdline?: string }[] | "unreadable") => {
	const base = world.herdr.onAgentStart!;
	let first = true;
	world.herdr.onAgentStart = (p, args) => {
		if (first) {
			first = false;
			if (processes === "unreadable") Object.defineProperty(world.herdr.pane(pane), "processes", { get: () => { throw new Error("herdr pane process-info failed: not answering"); }, configurable: true });
			else p.processes = processes;
			throw startTimeout();
		}
		base(p, args);
	};
};

test("RV3-F002: an interpreter in the standing pane is not its shell: `pwsh -File x.ps1` and `bash x.sh` keep the pane, only the process Herdr names as the pane's shell_pid counts", async () => {
	for (const user of [{ name: "pwsh.exe", argv0: "pwsh.exe", pid: 5151, cmdline: "pwsh.exe -File C:\\me\\build.ps1" }, { name: "bash", argv0: "bash", pid: 5152, cmdline: "bash deploy.sh" }]) {
		await world.close();
		world = new TowerWorld();
		world.setFlag(true);
		world.runPlatform = "win32";
		world.herdr.shellForeground = true;
		const { ensured } = await setup();
		renewOnTimeout(ensured.pane!, [user]);
		tower().incoming(from, msg("m1", "one"));
		await nthRun();
		assert.ok(!world.herdr.closed.includes(ensured.pane!), `${user.cmdline} keeps its pane`);
	}
});

test("RV3-F004: a pane whose foreground is empty or cannot be read is kept (unknown is not a shell)", async () => {
	for (const processes of [[], "unreadable"] as ("unreadable" | never[])[]) {
		await world.close();
		world = new TowerWorld();
		world.setFlag(true);
		world.runPlatform = "win32";
		world.herdr.shellForeground = true;
		const { ensured } = await setup();
		renewOnTimeout(ensured.pane!, processes);
		tower().incoming(from, msg("m1", "one"));
		await nthRun();
		assert.ok(!world.herdr.closed.includes(ensured.pane!), `${JSON.stringify(processes)} keeps its pane`);
	}
});

test("RV3-F003: a server stop that lands after the record moved to the new tab leaves the new tab for the next server", async () => {
	const { s, ensured } = await setup();
	let open!: () => void;
	const base = world.herdr.onAgentStart!;
	let first = true;
	world.herdr.onAgentStart = (p, args) => {
		if (first) {
			first = false;
			// The first read of the old pane by renew's closable (the record already names the new pane) holds the next pane list.
			Object.defineProperty(world.herdr.pane(ensured.pane!), "processes", {
				get: () => {
					world.herdr.paneListGate = new Promise<void>((resolve) => (open = resolve));
					return undefined;
				},
				configurable: true,
			});
			throw startTimeout();
		}
		base(p, args);
	};
	tower().incoming(from, msg("m1", "one"));
	await until(() => world.herdr.gated > 0, "renew to reach the pane list after its close", 5000);
	const stopping = ask(s, { cmd: "stop" });
	await sleep(100);
	world.herdr.paneListGate = undefined;
	open();
	await stopping;
	await s.handle.done;
	await sleep(300); // renew resumes after the gate opened
	const tabs = world.herdr.tabs.filter((t) => t.workspace_id === "wA" && t.label === TOWER_LABEL);
	assert.equal(tabs.length, 1, "the tower's new tab is still there");
	assert.notEqual(tabs[0]!.tab_id, ensured.tab);
});

test("N13: a second renew while one is running is refused and makes no tab of its own", async () => {
	const s = await world.start();
	await s.handle.ready;
	let ref: { renewPane?(runId: string): Promise<string | undefined> } | undefined;
	const runs = world.expose!.runs;
	const attach = runs.attach.bind(runs);
	runs.attach = (r) => ((ref = r), attach(r));
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.ok(ref?.renewPane, "the service's ref was seen");
	let open!: () => void;
	// The first read of the old pane by renew's closable (the record already names the new pane) holds the next pane list: the first renew is in flight.
	Object.defineProperty(world.herdr.pane(ensured.pane!), "processes", {
		get: () => {
			world.herdr.paneListGate = new Promise<void>((resolve) => (open = resolve));
			return undefined;
		},
		configurable: true,
	});
	const first = ref!.renewPane!("run-1");
	await until(() => world.herdr.gated > 0, "the first renew to reach the pane list after its close", 5000);
	const second = await Promise.race([ref!.renewPane!("run-2"), sleep(2000).then(() => "still running" as const)]);
	assert.equal(second, undefined, "the second renew is refused at once");
	assert.equal(world.herdr.tabs.filter((t) => t.workspace_id === "wA" && t.label === TOWER_LABEL).length, 1, "the refused renew made no tab");
	world.herdr.paneListGate = undefined;
	open();
	const pane = await first;
	assert.ok(pane && pane !== ensured.pane, "the first renew finished in a new pane");
});
