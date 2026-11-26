import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type CliDeps, parseArgs, run, UsageError } from "../src/server/cli.ts";
import { protectedSet, serverPids } from "../src/server/procs.ts";
import { callControl } from "../src/server/socket.ts";
import type { Proc } from "../src/procs/table.ts";
import { ServerWorld, until } from "./server-world.ts";

// The registry behind the control socket: procs-hello / bye / list / reap on a server of the world, and the registry file kept across a restart.

// The server reaps only its own account's processes (`ownUid` is the real uid), so the fake table is the account of whoever runs the test: 501 is the dev Mac's user, not the Linux runner's.
const UID = process.getuid?.() ?? 501;
const P = (pid: number, ppid: number): Proc => ({ pid, ppid, pgid: pid, uid: UID, started: `t${pid}`, cpu: 0, comm: "/usr/bin/node", zombie: false });
let world: ServerWorld;
beforeEach(() => void (world = new ServerWorld()));
afterEach(() => world.close());
const ask = (cmd: Record<string, unknown>) => callControl(world.record()!.socket, world.record()!.secret, cmd as { cmd: string }).then((r) => r.reply!);

test("a worker's hello, bye, and the list go through the socket; the owner is kept across a server restart", async () => {
	const table = [P(100, 1), P(101, 100)];
	const reaped: number[][] = [];
	const procs = { read: async () => table, startOf: (pid: number) => table.find((p) => p.pid === pid)?.started, cwds: async () => new Map(), markers: async () => new Map(), reap: async (refs: readonly { pid: number }[]) => (reaped.push(refs.map((r) => r.pid)), { termed: refs.length, killed: 0, skipped: 0, groups: 0, left: [] }) };
	const first = await world.start({ procs });
	await first.handle.ready;
	assert.deepEqual(await ask({ cmd: "procs-hello", pid: 100, id: "w1", started: "t100" }), { ok: true, id: "w1" });
	assert.equal((await ask({ cmd: "procs-hello", pid: 4242 })).ok, false, "a pid the table does not list is refused");
	assert.equal((await ask({ cmd: "procs-beat", id: "w1" })).known, true);
	assert.equal((await ask({ cmd: "procs-list" })).owners instanceof Array, true);
	assert.ok(existsSync(join(world.slot.dir, "procs", "owners.json")));
	await first.handle.shutdown(0);
	await first.handle.done;
	// restart: the second server loads the owner back
	const second = await world.start({ procs });
	await second.handle.ready;
	const listed = (await ask({ cmd: "procs-list" })).owners as { id: string; live: boolean }[];
	assert.deepEqual(listed.map((o) => [o.id, o.live]), [["w1", true]]);
	assert.equal((await ask({ cmd: "procs-reap", owner: "w1" })).ok, false, "reap of a live owner is refused");
	assert.equal((await ask({ cmd: "procs-reap", owner: "w1", checkout: "/x" })).ok, false);
	assert.deepEqual(await ask({ cmd: "procs-bye", id: "w1" }), { ok: true, known: true });
	await until(() => reaped.length > 0, "the reap of the ended owner");
	assert.deepEqual(reaped, [[101]]);
});

test("cli: procs takes list (default) or reap with exactly one of --owner and --checkout", () => {
	assert.equal(parseArgs(["procs"]).flags.sub, "list");
	assert.deepEqual(parseArgs(["procs", "reap", "--owner", "w1"]).flags, { sub: "reap", owner: "w1" });
	for (const bad of [["procs", "reap"], ["procs", "reap", "--owner", "a", "--checkout", "/b"], ["procs", "list", "--owner", "a"], ["procs", "kill"], ["procs", "--owner", "a", "--checkout", "/b"], ["procs", "list", "--checkout", "/b"], ["procs", "list", "--owner", "a", "--checkout", "/b"]]) assert.throws(() => parseArgs(bad), UsageError, bad.join(" "));
});

async function cli(argv: string[], over: Partial<CliDeps> = {}) {
	const { by: _by, ...requester } = world.ctx({ version: "0.44.0" });
	let out = "", err = "";
	const code = await run(argv, { env: world.env, stateDir: world.stateDir, version: "0.44.0", cli: "/fake/cli.mjs", ctx: { ...requester, env: world.env }, herdrListens: async () => true, out: (t) => void (out += t), err: (t) => void (err += t), ...over });
	return { code, out, err };
}

test("T2R-F010 and F001: cli procs exits 1 when a reap leaves a process alive or the server refuses a path, and 0 with the list; a refused path says why", async () => {
	const table = [P(100, 1), P(101, 100)];
	const procs = { read: async () => table, startOf: (pid: number) => table.find((p) => p.pid === pid)?.started, cwds: async () => new Map(), markers: async () => new Map([[101, "w1"]]), reap: async (refs: readonly { pid: number }[]) => ({ termed: refs.length, killed: refs.length, skipped: 0, groups: 0, left: [{ pid: 101, program: "node" }] }) };
	const running = await world.start({ procs });
	await running.handle.ready;
	assert.equal((await ask({ cmd: "procs-hello", pid: 100, id: "w1", started: "t100" })).ok, true);
	await ask({ cmd: "procs-beat", id: "w1" });
	const listed = await cli(["procs"]);
	assert.equal(listed.code, 0, listed.err);
	assert.deepEqual((JSON.parse(listed.out) as { owners: { id: string }[] }).owners.map((o) => o.id), ["w1"]);
	assert.deepEqual(await ask({ cmd: "procs-bye", id: "w1" }), { ok: true, known: true });
	await until(async () => (await ask({ cmd: "procs-list" })).owners instanceof Array && ((await ask({ cmd: "procs-list" })).owners as { id: string; live: boolean }[]).every((o) => !o.live), "the owner to have ended");
	const left = await cli(["procs", "reap", "--owner", "w1"]);
	assert.equal(left.code, 1, left.err || "something stayed alive");
	assert.equal(left.err, "");
	assert.deepEqual((JSON.parse(left.out) as { left: unknown[] }).left, [{ pid: 101, program: "node" }]);
	const root = await cli(["procs", "reap", "--checkout", "/"]);
	assert.equal(root.code, 1);
	assert.match(root.err, /in no checkout: reap --checkout takes a linked worktree/);
	assert.equal(root.out, "");
});

test("pane close --checkout asks the running server's registry for its bounded reap once the pane is gone: the checkout's orphan goes, the caller and what it runs under stay", async () => {
	// 600 is a shell init adopted that works in the checkout and runs this test's process (the caller); 300 is the loop the pane left there.
	const me = process.pid, table = [P(600, 1), { ...P(me, 600), started: "me" }, P(300, 1)], reaped: number[][] = [];
	const procs = {
		read: async () => table, startOf: (pid: number) => table.find((p) => p.pid === pid)?.started, markers: async () => new Map(), protect: async () => [], real: (path: string) => path, exists: () => true, inode: () => "1",
		checkout: () => ({ kind: "linked" as const, root: "/wt", gitdir: "/repo/.git/worktrees/wt" }), cwds: async (pids: readonly number[]) => new Map(pids.filter((pid) => [300, 600, me].includes(pid)).map((pid) => [pid, { path: "/wt/app" }])),
		reap: async (refs: readonly { pid: number }[]) => (reaped.push(refs.map((r) => r.pid)), { termed: refs.length, killed: 0, skipped: 0, groups: 0, left: [] }),
	};
	const running = await world.start({ procs });
	await running.handle.ready;
	let closed = false;
	const herdr = async (args: string[]) => (args[1] === "list" ? JSON.stringify({ result: { panes: closed ? [] : [{ pane_id: "w9:p2", tab_id: "w9:t2", workspace_id: "w9", terminal_id: "term-2" }] } }) : args[1] === "close" ? ((closed = true), "{}") : JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_processes: [{ pid: 100 }] } } }));
	// The pane's shell (100) goes with the close; the tree's reap is a fake here, so no real kill sequence runs.
	const pane = { read: async () => [...(closed ? [] : [P(100, 1)]), ...table], cwds: async () => new Map(), sleep: async () => {}, protect: async () => [], platform: "darwin" as const, real: (path: string) => path, checkout: procs.checkout, probe: () => undefined, reap: async () => ({ termed: 0, killed: 0, skipped: 0, groups: 0, left: [] }) };
	const done = await cli(["pane", "close", "w9:p2", "--checkout", "/wt", "--force"], { herdrCli: herdr, pane });
	assert.equal(done.code, 0, done.err || done.out);
	assert.deepEqual(reaped, [[300]], "the orphan in the checkout went through the server's kill sequence; not the caller or the shell it runs under");
	assert.deepEqual((JSON.parse(done.out) as { reaped: { checkout: unknown } }).reaped.checkout, { owner: "(checkout)", reason: "pane-close", targets: 1, termed: 1, killed: 0, skipped: 0, left: [], spared: 1 });
});

test("T2R-F007: an sb server's record protects the process with its start time only; a reused pid is not spared", async () => {
	const dir = mkdtempSync(join(tmpdir(), "psb-prot-"));
	try {
		mkdirSync(join(dir, "servers", "ab"), { recursive: true });
		writeFileSync(join(dir, "server.json"), JSON.stringify({ pid: 4000, started: "Tue Nov  4 03:50:02 2026" }));
		writeFileSync(join(dir, "servers", "ab", "server.json"), JSON.stringify({ pid: 4001 }));
		assert.deepEqual(serverPids(dir), [{ pid: 4000, started: "Tue Nov  4 03:50:02 2026" }, { pid: 4001 }]);
		const protect = await protectedSet([P(4000, 1)], { stateDir: dir, agentDir: dir, self: 9000 });
		assert.deepEqual(protect.filter((p) => p.why === "sb-server" && p.pid !== 9000), [{ pid: 4000, started: "Tue Nov  4 03:50:02 2026", why: "sb-server", tree: true }, { pid: 4001, why: "sb-server", tree: true }]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
