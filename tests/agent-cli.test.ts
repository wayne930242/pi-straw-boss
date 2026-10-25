import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ASK_MS, parseArgs, run, type SpawnSpec, UsageError } from "../src/agent/cli.ts";
import { agentFiles, alive, type Held, readHeld } from "../src/agent/paths.ts";

const dirs: string[] = [], servers: Server[] = [];
afterEach(() => {
	servers.splice(0).forEach((server) => server.close());
	dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
const PANE = "wA:p3", SESSION = "085ff3b1-aaaa", cliPath = fileURLToPath(new URL("../src/agent/cli.ts", import.meta.url));
const scratch = () => {
	const stateDir = mkdtempSync(join(tmpdir(), "psb-cli-"));
	dirs.push(stateDir);
	const files = agentFiles(stateDir, PANE);
	mkdirSync(files.dir, { recursive: true });
	return { stateDir, files };
};
const held = (over: Partial<Held> = {}): Held => ({ pid: process.pid, session: SESSION, kind: "claude", pane: PANE, id: `claude-${SESSION}`, name: "claude-085ff3b1", startedAt: 1, ...over });
const output = () => {
	const out: string[] = [], err: string[] = [];
	return { out, err, deps: { out: (text: string) => void out.push(text), err: (text: string) => void err.push(text) } };
};
/** A sidecar's control socket that answers each request with `answer` and records what it was asked. */
async function sidecarAt(files: ReturnType<typeof agentFiles>, answer: (request: Record<string, unknown>) => Record<string, unknown>, hello: (held: Held) => Record<string, unknown> = () => ({})) {
	mkdirSync(files.dir, { recursive: true });
	const asked: Record<string, unknown>[] = [];
	const server = createServer((conn) => {
		let line = "";
		conn.setEncoding("utf8").on("data", (chunk) => {
			line += chunk;
			if (!line.includes("\n")) return;
			const request = JSON.parse(line);
			// Who it is: what a sidecar answers before anything else, from the state file it would have written.
			if (request.cmd === "hello") {
				const held = readHeld(files);
				return void conn.end(`${JSON.stringify(held && alive(held.pid) ? { ok: true, pid: held.pid, session: held.session, ...hello(held) } : { ok: false, error: "no state" })}\n`);
			}
			asked.push(request);
			conn.end(`${JSON.stringify(answer(request))}\n`);
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(files.socket, resolve));
	return asked;
}

test("arguments: each command takes its own flags, the pane defaults to the one the process runs in, and anything else is a usage error", () => {
	assert.deepEqual(parseArgs(["join", "--pane", PANE, "--kind", "codex", "--session", "s1", "--record", "/r.json", "--cli", "/x/straw-net.py"], {}), { command: "join", pane: PANE, kind: "codex", session: "s1", record: "/r.json", cli: "/x/straw-net.py" });
	assert.deepEqual(parseArgs(["status"], { HERDR_PANE_ID: "wB:p1" }), { command: "status", pane: "wB:p1" });
	assert.deepEqual(parseArgs(["call-tower", "--message", "help", "--workspace", "Beta"], { HERDR_PANE_ID: PANE }), { command: "call-tower", pane: PANE, message: "help", workspace: "Beta" });
	assert.deepEqual(parseArgs(["broadcast", "--message", "hi"], { HERDR_PANE_ID: PANE }), { command: "broadcast", pane: PANE, message: "hi" });
	assert.deepEqual(parseArgs(["broadcast", "--message", "hi", "--scope", "all"], { HERDR_PANE_ID: PANE }), { command: "broadcast", pane: PANE, message: "hi", scope: "all" });
	assert.deepEqual(parseArgs(["send", "--to", "tower", "--message", "ok", "--pane", "wZ:p9"], {}), { command: "send", pane: "wZ:p9", to: "tower", message: "ok" });
	assert.deepEqual(parseArgs(["rename", "--name", "MP-1"], { HERDR_PANE_ID: PANE }), { command: "rename", pane: PANE, name: "MP-1" });
	assert.deepEqual(parseArgs(["promote"], { HERDR_PANE_ID: PANE }), { command: "promote", pane: PANE });
	assert.deepEqual(parseArgs(["stop"], { HERDR_PANE_ID: PANE }), { command: "stop", pane: PANE });
	const env = { HERDR_PANE_ID: PANE };
	for (const [argv, own, message] of [
		[[], env, /usage:/],
		[["frobnicate"], env, /unknown command frobnicate/],
		[["toString"], env, /unknown command toString/],
		[["status"], {}, /--pane or HERDR_PANE_ID/],
		[["join", "--pane", PANE, "--kind", "gemini", "--session", "s"], {}, /--kind must be claude or codex/],
		[["join", "--pane", PANE, "--kind", "claude"], {}, /--session is required/],
		[["broadcast", "--message", "x", "--scope", "galaxy"], env, /--scope must be tab, workspace, towers, or all/],
		[["broadcast"], env, /--message is required/],
		[["send", "--message", "x"], env, /--to is required/],
		[["status", "--bogus", "1"], env, /unknown option --bogus/],
		[["status", "--pane"], env, /--pane needs a value/],
	] as [string[], NodeJS.ProcessEnv, RegExp][]) assert.throws(() => parseArgs(argv, own), (error: Error) => error instanceof UsageError && message.test(error.message), `${argv.join(" ")} → ${message}`);
});

test("a pane with no sidecar is exit 2 for every command that talks to one, with the reason on stderr", async () => {
	const { stateDir } = scratch();
	for (const argv of [["status"], ["promote"], ["call-tower", "--message", "m"], ["broadcast", "--message", "m"], ["send", "--to", "t", "--message", "m"], ["rename", "--name", "n"], ["stop"]]) {
		const o = output();
		assert.equal(await run([...argv, "--pane", PANE], { stateDir, ...o.deps }), 2, argv[0]);
		assert.match(o.err.join(""), /no net sidecar for pane wA:p3/);
		assert.deepEqual(o.out, []);
	}
});

test("a state file of a process that has ended, or a socket nobody listens on, is no sidecar either", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held({ pid: 2 ** 22 + 1 })));
	const gone = output();
	assert.equal(await run(["status", "--pane", PANE], { stateDir, ...gone.deps }), 2);
	writeFileSync(files.state, JSON.stringify(held()));
	const silent = output();
	assert.equal(await run(["status", "--pane", PANE], { stateDir, ...silent.deps }), 2);
	assert.match(silent.err.join(""), /no net sidecar for pane wA:p3/);
});

test("R-F005: a sidecar that is connected to and does not answer in time is exit 1 (it may still act), not 2 (no sidecar); call-tower is given longer than the rest", { timeout: 4000 }, async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	const server = createServer(() => {});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(files.socket, resolve));
	const o = output();
	assert.equal(await run(["call-tower", "--message", "m", "--pane", PANE], { stateDir, askMs: 150, ...o.deps }), 1);
	assert.match(o.err.join(""), /did not answer within 0\.15 s/);
	assert.ok(ASK_MS["call-tower"]! >= 120_000 && ASK_MS["call-tower"]! > ASK_MS.default!, JSON.stringify(ASK_MS));
});

test("a command sends one request and prints the reply: the text, or the status as JSON; a refusal is exit 1 with its reason", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	const asked = await sidecarAt(files, (request) => {
		if (request.cmd === "status") return { ok: true, me: { id: "claude-x", role: "member" }, tabs: [] };
		if (request.cmd === "promote") return { ok: false, error: "Tab work already has a main agent, Pi One." };
		return { ok: true, text: `done ${String(request.cmd)}` };
	});
	const status = output();
	assert.equal(await run(["status", "--pane", PANE], { stateDir, ...status.deps }), 0);
	assert.deepEqual(JSON.parse(status.out.join("")), { me: { id: "claude-x", role: "member" }, tabs: [] });
	const refused = output();
	assert.equal(await run(["promote", "--pane", PANE], { stateDir, ...refused.deps }), 1);
	assert.equal(refused.err.join("").trim(), "Tab work already has a main agent, Pi One.");
	const call = output();
	assert.equal(await run(["call-tower", "--message", "help", "--workspace", "Beta", "--pane", PANE], { stateDir, ...call.deps }), 0);
	assert.equal(call.out.join("").trim(), "done call-tower");
	await run(["broadcast", "--message", "b", "--pane", PANE], { stateDir, ...output().deps });
	await run(["send", "--to", "t", "--message", "s", "--pane", PANE], { stateDir, ...output().deps });
	await run(["rename", "--name", "n", "--pane", PANE], { stateDir, ...output().deps });
	assert.deepEqual(asked, [{ cmd: "status" }, { cmd: "promote" }, { cmd: "call-tower", message: "help", workspace: "Beta" }, { cmd: "broadcast", message: "b" }, { cmd: "send", to: "t", message: "s" }, { cmd: "rename", name: "n" }]);
});

test("a usage error is exit 2 with the usage on stderr", async () => {
	const o = output();
	assert.equal(await run(["send", "--message", "x"], { stateDir: scratch().stateDir, env: { HERDR_PANE_ID: PANE }, ...o.deps }), 2);
	assert.match(o.err.join(""), /--to is required/);
});

const spawner = (files: ReturnType<typeof agentFiles>, write: boolean) => {
	const spawned: SpawnSpec[] = [];
	return { spawned, spawn: (spec: SpawnSpec) => {
		spawned.push(spec);
		if (write) writeFileSync(files.state, JSON.stringify(held({ session: spec.args[spec.args.indexOf("--session") + 1]!, startedAt: Date.now() })));
		return { exited: new Promise<number | null>(() => {}) };
	} };
};
const joinArgs = ["join", "--pane", PANE, "--kind", "claude", "--session", SESSION, "--record", "/home/r/claude-x.json", "--cli", "/x/straw-net.py"];

test("join starts one detached sidecar with the tsx loader, the pane in its environment, and every flag, and returns once its state file exists", async () => {
	const { stateDir, files } = scratch();
	mkdirSync(files.dir, { recursive: true });
	const { spawned, spawn } = spawner(files, true);
	const o = output();
	assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/n/tsx/dist/loader.mjs", env: { HERDR_PANE_ID: "wX:p0", PI_INTERCOM_SESSION_ID: "pi-session" }, ...o.deps }), 0);
	assert.equal(spawned.length, 1);
	assert.deepEqual(spawned[0]!.args, ["--import", pathToFileURL("/n/tsx/dist/loader.mjs").href, cliPath, "serve", "--pane", PANE, "--kind", "claude", "--session", SESSION, "--record", "/home/r/claude-x.json", "--cli", "/x/straw-net.py"]);
	assert.equal(spawned[0]!.command, process.execPath);
	assert.equal(spawned[0]!.env.HERDR_PANE_ID, PANE);
	assert.equal(spawned[0]!.log, files.log);
	assert.match(o.out.join(""), /^joining as claude-085ff3b1/);
});

test("join is idempotent: a live sidecar of the same session is left alone, a dead one's leftover is replaced", async () => {
	const { stateDir, files } = scratch();
	mkdirSync(files.dir, { recursive: true });
	writeFileSync(files.state, JSON.stringify(held()));
	await sidecarAt(files, () => ({ ok: true }));
	const same = spawner(files, true);
	assert.equal(await run(joinArgs, { stateDir, spawn: same.spawn, loader: "/l.mjs", ...output().deps }), 0);
	assert.deepEqual(same.spawned, []);
	writeFileSync(files.state, JSON.stringify(held({ pid: 2 ** 22 + 1 })));
	const dead = spawner(files, true);
	assert.equal(await run(joinArgs, { stateDir, spawn: dead.spawn, loader: "/l.mjs", ...output().deps }), 0);
	assert.equal(dead.spawned.length, 1);
});

test("join for another session in a pane that has a sidecar (a /clear) stops the old one, waits for it to leave, then starts the new one", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held({ session: "old-session" })));
	const order: string[] = [];
	await sidecarAt(files, (request) => {
		order.push(String(request.cmd));
		setTimeout(() => rmSync(files.state, { force: true }), 30); // it leaves a moment after it answers
		return { ok: true, text: "Left the net." };
	});
	const spawned: SpawnSpec[] = [];
	const spawnNew = (spec: SpawnSpec) => (order.push("spawn"), writeFileSync(files.state, JSON.stringify(held({ startedAt: Date.now() }))), spawned.push(spec), { exited: new Promise<number | null>(() => {}) });
	assert.equal(await run(joinArgs, { stateDir, spawn: spawnNew, loader: "/l.mjs", ...output().deps }), 0);
	assert.deepEqual(order, ["stop", "spawn"]);
	assert.equal(spawned.length, 1);
});

test("join says so, with exit 1, when the sidecar's state file does not appear in time or the process ends first", async () => {
	const { stateDir, files } = scratch();
	const slow = output();
	assert.equal(await run(joinArgs, { stateDir, spawn: () => ({ exited: new Promise<number | null>(() => {}) }), loader: "/l.mjs", joinMs: 100, ...slow.deps }), 1);
	assert.match(slow.err.join(""), /did not start within 0\.1 s; see .*\.log/);
	const dies = output();
	assert.equal(await run(joinArgs, { stateDir, spawn: () => ({ exited: Promise.resolve(1) }), loader: "/l.mjs", joinMs: 2000, ...dies.deps }), 1);
	assert.match(dies.err.join(""), /exited with code 1; see .*\.log/);
	const noLoader = output();
	// Nowhere to find pi-intercom: not in the agent directory, and not beside the package (a checkout may sit next to a pi-intercom checkout).
	assert.equal(await run(joinArgs, { stateDir, env: { PI_CODING_AGENT_DIR: stateDir }, here: join(stateDir, "a", "b", "c"), spawn: () => ({ exited: new Promise<number | null>(() => {}) }), ...noLoader.deps }), 1);
	assert.match(noLoader.err.join(""), /pi-intercom/);
});

test("R-F002: join never signals a process the sidecar's socket has not confirmed: a state file naming an unrelated live pid is a leftover", async () => {
	const { stateDir, files } = scratch();
	const victim = spawnChild("sleep", ["60"], { stdio: "ignore" });
	try {
		writeFileSync(files.state, JSON.stringify(held({ pid: victim.pid!, session: "old-session", startedAt: Date.now() - 3_600_000 })));
		const { spawned, spawn } = spawner(files, true);
		assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/l.mjs", stopMs: 100, ...output().deps }), 0);
		assert.equal(spawned.length, 1);
		assert.equal(alive(victim.pid!), true);
		assert.equal(victim.exitCode, null, "it was not sent SIGTERM");
	} finally {
		victim.kill("SIGKILL");
	}
});

test("R-F002: a sidecar that answers on its socket and does not leave when asked is stopped by SIGTERM", async () => {
	const { stateDir, files } = scratch();
	const stubborn = spawnChild("sleep", ["60"], { stdio: "ignore" });
	stubborn.once("exit", () => rmSync(files.state, { force: true }));
	try {
		writeFileSync(files.state, JSON.stringify(held({ pid: stubborn.pid!, session: "old-session" })));
		await sidecarAt(files, () => ({ ok: true, text: "Left the net." }));
		const { spawned, spawn } = spawner(files, true);
		assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/l.mjs", stopMs: 150, ...output().deps }), 0);
		assert.equal(spawned.length, 1);
		assert.notEqual(stubborn.exitCode ?? stubborn.signalCode, null, "it was sent SIGTERM");
	} finally {
		stubborn.kill("SIGKILL");
	}
});

test("R-F007: a join for the session whose sidecar is leaving waits for it to be gone, then starts a new one, and does not say it is already joined", async () => {
	const { stateDir, files } = scratch();
	writeFileSync(files.state, JSON.stringify(held()));
	await sidecarAt(files, () => ({ ok: true, text: "Left the net." }), (held) => ({ leaving: held.startedAt === 1 })); // the one that is leaving is the file as it was written; the new sidecar's is not
	setTimeout(() => rmSync(files.state, { force: true }), 120);
	const { spawned, spawn } = spawner(files, true);
	const o = output();
	assert.equal(await run(joinArgs, { stateDir, spawn, loader: "/l.mjs", ...o.deps }), 0);
	assert.equal(spawned.length, 1);
	assert.doesNotMatch(o.out.join(""), /already joined/);
});
