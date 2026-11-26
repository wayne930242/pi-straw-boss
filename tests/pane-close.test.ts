import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgs, run, UsageError } from "../src/server/cli.ts";
import { askBounded, ATTEMPTS, OLD_SERVER_TEXT, type PaneClosed, type PaneDeps, serverLacksBounded } from "../src/server/panecli.ts";
import type { Proc, Ref } from "../src/procs/table.ts";

// `cli.mjs pane close` (docs/how-it-works.md#a-checked-pane-close; troubleshoot kit §4): a close the deadpane.ts table allows (or the boss's --force), looked for in Herdr's list and tried again on the same
// target only, then the kill sequence for what the pane left, one verified pid at a time, and `left` for what survives. Herdr and the process table are fakes: nothing here closes a pane or signals a process of the machine.

const stateDir = mkdtempSync(join(tmpdir(), "sb-pane-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));
const UID = process.getuid?.() ?? 501;
const P = (pid: number, ppid: number, comm: string, started = `t${pid}`): Proc => ({ pid, ppid, pgid: pid, uid: UID, started, cpu: 0, comm, zombie: false });
const PANE = "w9:p2AZ", HERE = "w9:p1", SELF = 400;
type Info = { shell_pid?: number; foreground_processes?: { pid?: number; name?: string }[] };
type Listed = { pane_id: string; tab_id: string; workspace_id?: string; terminal_id?: string; agent?: string; tokens?: Record<string, string> };

/**
 * The pane's shell (100) runs a poll loop in the background (`sleep`, 201); with `live` a pi (200) runs in its foreground and the loop is the pi's. The command runs as 400 under a shell (399) of a session's pi
 * (398) in pane w9:p1; 300 is an orphan. A close takes `closesNeeded` closes to remove the pane, and then takes the shell and the pi with it, as Herdr's close does, while the loop is adopted by init and goes on.
 * `stubborn` processes outlive the kill sequence. `info(n)` answers the n-th process-info (0 first).
 */
function world({ closesNeeded = 1, stubborn = [] as number[], cwds = {} as Record<number, string>, server = "reaps" as "reaps" | "down", live = false } = {}) {
	const table: Proc[] = [P(50, 1, "/opt/homebrew/bin/herdr"), P(100, 50, "-zsh"), ...(live ? [P(200, 100, "node")] : []), P(201, live ? 200 : 100, "/bin/sleep"), P(300, 1, "node"), P(398, 50, "node"), P(399, 398, "-zsh"), P(SELF, 399, "node")];
	const calls: string[][] = [], reaped: number[][] = [], checkouts: [string, Ref][] = [];
	const target: Listed = { pane_id: PANE, tab_id: "w9:t2", workspace_id: "w9", terminal_id: "term-2", tokens: { piha_child: "w1" } };
	const others: Listed[] = [{ pane_id: HERE, tab_id: "w9:t1", workspace_id: "w9", terminal_id: "term-1" }];
	let closes = 0, infos = 0;
	const w = {
		table, calls, reaped, checkouts, target, others, closes: () => closes,
		info: (_n: number): Info => ({ shell_pid: 100, foreground_processes: live ? [{ pid: 200, name: "pi" }] : [{ pid: 100, name: "zsh" }] }),
		/** What Herdr lists at the target's id once it is gone (another terminal under a reused id), if anything. */
		after: undefined as Listed | undefined,
		onClose: () => {},
	};
	const listed = () => closes < closesNeeded;
	const herdr = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [...w.others, ...(listed() ? [w.target] : w.after ? [w.after] : [])] } });
		if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: w.info(infos++) } });
		if (args[0] === "pane" && args[1] === "close") {
			closes++;
			w.onClose();
			if (!listed()) {
				for (const gone of [100, 200]) if (table.some((p) => p.pid === gone)) table.splice(table.findIndex((p) => p.pid === gone), 1);
				for (const p of table) if (p.ppid === 100 || p.ppid === 200) p.ppid = 1;
			}
			return "{}";
		}
		throw new Error(`unexpected herdr ${args.join(" ")}`);
	};
	const drop = (refs: readonly Ref[]) => {
		for (const ref of refs) {
			const at = table.findIndex((p) => p.pid === ref.pid && p.started === ref.started);
			if (at >= 0 && !stubborn.includes(ref.pid)) table.splice(at, 1);
		}
	};
	const pane: Partial<PaneDeps> = {
		read: async () => table.map((p) => ({ ...p })), sleep: async () => {}, now: () => Date.parse("2026-11-27T01:00:00Z"), self: SELF, platform: "darwin", real: (path) => path, protect: async () => [{ pid: 50, why: "herdr" }],
		probe: (pid) => table.find((p) => p.pid === pid)?.started, reviving: () => false, socket: "/fake/herdr.sock", oldServer: async () => false,
		checkout: (path) => (path === "/wt" ? { kind: "linked", root: "/wt", gitdir: "/repo/.git/worktrees/wt" } : path.startsWith("/wt/") ? { kind: "linked", root: "/wt", gitdir: "/repo/.git/worktrees/wt" } : path === "/repo" ? { kind: "main", root: "/repo" } : { kind: "none" }),
		cwds: async (pids) => new Map(pids.filter((pid) => cwds[pid] !== undefined).map((pid) => [pid, { path: cwds[pid]! }])),
		reap: async (refs) => {
			reaped.push(refs.map((r) => r.pid));
			drop(refs);
			const left = refs.filter((r) => stubborn.includes(r.pid)).map((r) => ({ pid: r.pid, program: "sleep" }));
			return { termed: refs.length, killed: left.length, skipped: 0, groups: 0, left };
		},
		reapCheckout: async (path, caller) => {
			checkouts.push([path, caller]);
			if (server === "down") return { ok: false, error: "no sb server is running, so there is no owner registry to ask" };
			const here = table.filter((p) => p.ppid === 1 && cwds[p.pid] !== undefined && cwds[p.pid]!.startsWith(path));
			drop(here.map((p) => ({ pid: p.pid, started: p.started })));
			return { ok: true, reply: { owner: "(checkout)", reason: "pane-close", targets: here.length, left: [] } };
		},
	};
	return Object.assign(w, { herdr, pane });
}

async function close(w: ReturnType<typeof world>, argv: string[], env: NodeJS.ProcessEnv = { ...process.env, HERDR_PANE_ID: HERE }) {
	let out = "", err = "";
	const code = await run(["pane", "close", ...argv], { env, stateDir, herdrCli: w.herdr, pane: w.pane, out: (t) => void (out += t), err: (t) => void (err += t) });
	return { code, out, err, result: out ? (JSON.parse(out) as PaneClosed) : undefined };
}
const outside = () => { const env = { ...process.env }; delete env.HERDR_PANE_ID; return env; };
const noClose = (w: ReturnType<typeof world>) => assert.ok(!w.calls.some((c) => c[1] === "close"), "no close was sent");

test("cli: pane close takes the pane after the word, an optional --checkout and --force", () => {
	assert.deepEqual(parseArgs(["pane", "close", "w9:p2AZ", "--checkout", "/wt", "--force"]).flags, { pane: "w9:p2AZ", checkout: "/wt", force: true });
	for (const bad of [["pane"], ["pane", "close"], ["pane", "open", "w9:p2AZ"], ["pane", "close", "--checkout", "/wt"], ["pane", "close", "w9:p2AZ", "w9:p3"], ["pane", "close", "w9:p2AZ", "--owner", "x"]]) assert.throws(() => parseArgs(bad), UsageError, bad.join(" "));
});

test("a close that leaves the pane listed is tried again; once it is gone, the loop it left is reaped and nothing is left (exit 0)", async () => {
	const w = world({ closesNeeded: 2 });
	const { code, err, result } = await close(w, [PANE]);
	assert.equal(code, 0, err);
	assert.equal(w.closes(), 2);
	assert.equal(result!.closed, true);
	assert.equal(result!.attempts, 2);
	assert.deepEqual(result!.target, { socket: "/fake/herdr.sock", workspace: "w9", terminal: "term-2", shell: { pid: 100, started: "t100" } });
	assert.deepEqual(result!.noops, [{ attempt: 1, at: "2026-11-27T01:00:00.000Z", foreground: ["zsh"] }], "the no-op close is recorded with what ran in the pane");
	assert.deepEqual(w.reaped, [[201]], "only the pane's own tree, adopted by init, is signalled: never the caller, the other orphan, or Herdr");
	assert.deepEqual(result!.reaped?.tree, { targets: 1, termed: 1, killed: 0, spared: 0 });
	assert.deepEqual(result!.left, []);
	assert.equal(w.checkouts.length, 0, "no --checkout: the server is not asked");
});

test("a process that outlives the kill sequence is left: exit 1 with it listed", async () => {
	const w = world({ stubborn: [201] });
	const { code, result } = await close(w, [PANE]);
	assert.equal(code, 1);
	assert.equal(result!.closed, true);
	assert.equal(result!.attempts, 1);
	assert.deepEqual(result!.left, [{ pid: 201, program: "sleep", where: "tree" }]);
});

test("--checkout asks the server's bounded reap with this command as its caller, and lists what still works there, never this command or the shell it runs under", async () => {
	const cwds = { 300: "/wt/app", 398: "/wt", 399: "/wt", [SELF]: "/wt" };
	const reaped = world({ cwds });
	const ok = await close(reaped, [PANE, "--checkout", "/wt"]);
	assert.equal(ok.code, 0, ok.out);
	assert.deepEqual(reaped.checkouts, [["/wt", { pid: SELF, started: `t${SELF}` }]]);
	assert.deepEqual(ok.result!.reaped?.checkout, { owner: "(checkout)", reason: "pane-close", targets: 1, left: [] });
	assert.deepEqual(ok.result!.left, []);
	const down = world({ cwds, server: "down" });
	const failed = await close(down, [PANE, "--checkout", "/wt"]);
	assert.equal(failed.code, 1);
	assert.deepEqual(failed.result!.reaped?.checkout, { error: "no sb server is running, so there is no owner registry to ask" });
	assert.deepEqual(failed.result!.left, [{ pid: 300, program: "node", where: "checkout" }]);
});

test("a pane still listed after every close is not reaped: its processes are left, exit 1", async () => {
	const w = world({ closesNeeded: Number.POSITIVE_INFINITY });
	const { code, result } = await close(w, [PANE]);
	assert.equal(code, 1);
	assert.equal(result!.closed, false);
	assert.equal(result!.attempts, ATTEMPTS);
	assert.equal(result!.noops.length, ATTEMPTS);
	assert.deepEqual(w.reaped, [], "nothing is signalled while the pane stands");
	assert.deepEqual(result!.left.map((l) => l.pid), [100, 201]);
});

test("a step that fails after the close keeps the answer: closed, with the error, exit 1", async () => {
	const w = world();
	const read = w.pane.read!;
	w.pane.read = async () => { if (w.closes() > 0) throw new Error("ps failed"); return read(); };
	const { code, result } = await close(w, [PANE]);
	assert.equal(code, 1);
	assert.equal(result!.closed, true);
	assert.equal(result!.error, "ps failed; what is left is not known");
});

test("refused before any close: its own pane, a pane Herdr does not list, and Windows", async () => {
	const own = world();
	const mine = await close(own, [HERE]);
	assert.equal(mine.code, 1);
	assert.match(mine.err, /does not close its own pane/);
	const missing = world();
	const none = await close(missing, ["w9:p404"]);
	assert.equal(none.code, 1);
	assert.match(none.err, /no pane w9:p404 in Herdr's list; nothing was closed/);
	const windows = world();
	windows.pane.platform = "win32";
	assert.equal((await close(windows, [PANE])).code, 1);
	for (const w of [own, missing, windows]) noClose(w);
	assert.equal(mine.out + none.out, "");
});

test("kit2-F001: without --force only a dead agent pane of the caller's workspace is closed; a live pi, another workspace, a plain shell, a revive, or a caller outside Herdr is refused", async () => {
	const cases: [string, (w: ReturnType<typeof world>) => void, RegExp, NodeJS.ProcessEnv?][] = [
		["live pi", () => {}, /is not at a bare shell: pi runs in it/],
		["another workspace", (w) => (w.target.workspace_id = "w8"), /is not in this workspace/],
		["Herdr reports an agent", (w) => (w.target.agent = "pi"), /runs pi, so it is not dead/],
		["a plain shell", (w) => (w.target.tokens = {}), /carries no mark of an agent/],
		["a revive", (w) => (w.pane.reviving = () => true), /is being revived right now/],
		["outside Herdr", () => {}, /runs in no pane Herdr lists/, outside()],
		["a program as its shell", (w) => { w.table.find((p) => p.pid === 100)!.comm = "node"; w.info = () => ({ shell_pid: 100, foreground_processes: [{ pid: 100, name: "node" }] }); }, /runs node in place of a shell/],
	];
	for (const [name, setup, why, env] of cases) {
		const w = world({ live: name === "live pi" });
		setup(w);
		const r = await close(w, [PANE], env);
		assert.equal(r.code, 1, name);
		assert.match(r.err, why, name);
		assert.match(r.err, /nothing was closed/, name);
		noClose(w);
		assert.deepEqual(w.reaped, [], name);
	}
});

test("kit2-F001: the boss's --force closes a live pi's pane, also from outside Herdr, and reaps what it left", async () => {
	const w = world({ live: true });
	w.target.workspace_id = "w8";
	const { code, err, result } = await close(w, [PANE, "--force"], outside());
	assert.equal(code, 0, err);
	assert.equal(result!.closed, true);
	assert.deepEqual(w.reaped, [[201]]);
});

test("kit2-F001: a retry goes only to the same target: a pane whose shell changed is not closed again, and an id that now names another terminal is a pane gone", async () => {
	const changed = world({ closesNeeded: 3 });
	changed.info = (n) => ({ shell_pid: n < 2 ? 100 : 101, foreground_processes: [{ pid: n < 2 ? 100 : 101, name: "zsh" }] });
	const a = await close(changed, [PANE]);
	assert.equal(a.code, 1);
	assert.equal(changed.closes(), 1, "one close only");
	assert.equal(a.result!.closed, false);
	assert.match(a.result!.error!, /no longer runs the shell it ran \(pid 100\), so it was not closed again/);
	assert.deepEqual(changed.reaped, [], "nothing is reaped while a pane stands");
	// The first close takes the pane, and Herdr gives its id to a new terminal at once.
	const reused = world();
	reused.after = { ...reused.target, terminal_id: "term-9" };
	const b = await close(reused, [PANE]);
	assert.equal(b.code, 0, b.err);
	assert.equal(reused.closes(), 1, "the id names another terminal after the first close: ours is gone, and the other is never closed");
	assert.equal(b.result!.closed, true);
});

test("kit2-F002: the tree is read from the pane's shell, never by a foreground pid an unrelated process held before", async () => {
	// 210 was an unrelated process with a child 211; it ended, 211 was adopted by init, and the pane's new foreground took pid 210.
	const w = world({ live: true });
	w.table.push(P(210, 1, "node", "old"), P(211, 210, "/bin/sleep"));
	w.info = (n) => {
		if (n === 0) {
			w.table.splice(w.table.findIndex((p) => p.pid === 210), 1);
			w.table.find((p) => p.pid === 211)!.ppid = 1;
			w.table.push(P(210, 100, "node", "new"));
		}
		return { shell_pid: 100, foreground_processes: [{ pid: 210, name: "pi" }] };
	};
	const { code, err } = await close(w, [PANE, "--force"]);
	assert.equal(code, 0, err);
	assert.ok(!w.reaped.flat().includes(211), "the child of the old holder of the pid is not the pane's");
	assert.ok(w.table.some((p) => p.pid === 211));
});

test("kit2-F002 and F004: a shell that cannot be verified closes nothing: another shell in the second answer, none at all, or one the process table does not have", async () => {
	const cases: [string, (n: number) => Info, RegExp][] = [
		["another shell", (n) => ({ shell_pid: n === 0 ? 100 : 101, foreground_processes: [{ pid: 100 }] }), /Herdr named pid 100, then another/],
		["no shell", () => ({ foreground_processes: [{ pid: 100 }] }), /Herdr named none/],
		["not in the table", () => ({ shell_pid: 150, foreground_processes: [{ pid: 150 }] }), /pid 150, which the process table does not have/],
	];
	for (const [name, info, why] of cases) {
		for (const force of [false, true]) {
			const w = world();
			w.info = info;
			const r = await close(w, [PANE, ...(force ? ["--force"] : [])]);
			assert.equal(r.code, 1, name);
			assert.match(r.err, why, name);
			assert.match(r.err, /could not be verified .*nothing was closed/, name);
			noClose(w);
		}
	}
});

test("kit2-F003: --checkout must be the root of a linked worktree, checked before anything is closed", async () => {
	for (const path of ["/wt/sub", "/repo", "/", "/elsewhere"]) {
		const w = world();
		const r = await close(w, [PANE, "--checkout", path]);
		assert.equal(r.code, 1, path);
		assert.match(r.err, /is not the root of a linked worktree.*nothing was closed/, path);
		noClose(w);
		assert.deepEqual(w.checkouts, [], path);
	}
});

test("kit2-F004: what a reap says it left is left while that pid still runs, wherever it works: exit 1", async () => {
	// 202 starts under the loop after the tree was read: the reap reaches it as the loop's child, and it outlives the kill sequence. It works in no checkout.
	const tree = world({ stubborn: [202] });
	tree.onClose = () => void (tree.closes() === 1 && tree.table.push(P(202, 201, "node")));
	const a = await close(tree, [PANE]);
	assert.equal(a.code, 1);
	assert.deepEqual(tree.reaped, [[201, 202]]);
	assert.deepEqual(a.result!.left, [{ pid: 202, program: "node", where: "tree" }]);
	// The server's reap of the checkout left 300, which no longer works there.
	const server = world({ cwds: {} });
	server.pane.reapCheckout = async () => ({ ok: true, reply: { owner: "(checkout)", reason: "pane-close", targets: 1, left: [{ pid: 300, program: "node" }, { pid: 999, program: "gone" }] } });
	const b = await close(server, [PANE, "--checkout", "/wt"]);
	assert.equal(b.code, 1);
	assert.deepEqual(b.result!.left, [{ pid: 300, program: "node", where: "checkout" }], "300 still runs; 999 is gone");
});

test("kit2-F003: --checkout with a server too old for the bounded reap is refused before the close, and a server that went old meanwhile reaps nothing in its place", async () => {
	const w = world();
	w.pane.oldServer = async () => true;
	const r = await close(w, [PANE, "--checkout", "/wt"]);
	assert.equal(r.code, 1);
	assert.equal(r.err, `${OLD_SERVER_TEXT}; nothing was closed\n`);
	noClose(w);
	assert.deepEqual(w.checkouts, []);
	// The wire: the bounded reap is its own command, which an old server answers `unknown command` (and runs nothing), never `procs-reap`.
	const sent: unknown[] = [];
	const old = async (request: { cmd: string }) => (sent.push(request), { ok: false as const, error: `unknown command ${request.cmd}` });
	assert.equal(await serverLacksBounded(old), true);
	assert.deepEqual(await askBounded(old, "/wt", { pid: SELF, started: "t400" }), { ok: false, error: `${OLD_SERVER_TEXT}; nothing in the checkout was signalled` });
	assert.deepEqual(sent, [{ cmd: "procs-reap-bounded" }, { cmd: "procs-reap-bounded", checkout: "/wt", caller: { pid: SELF, started: "t400" } }]);
	const current = async () => ({ ok: false as const, error: "procs-reap-bounded needs a checkout and its caller { pid, started }" });
	assert.equal(await serverLacksBounded(current), false, "a server that has it refuses the empty probe and runs nothing");
});
