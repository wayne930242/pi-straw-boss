import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseArgs, run, UsageError } from "../src/server/cli.ts";
import { ATTEMPTS, type PaneClosed, type PaneDeps } from "../src/server/panecli.ts";
import type { Proc, Ref } from "../src/procs/table.ts";

// `cli.mjs pane close` (docs/how-it-works.md#a-checked-pane-close; troubleshoot kit §4): a close that is looked for in Herdr's list and tried again, then the kill sequence for what the pane left, and `left` for what
// survives. Herdr and the process table are fakes: nothing here closes a pane or signals a process of the machine.

const stateDir = mkdtempSync(join(tmpdir(), "sb-pane-"));
after(() => rmSync(stateDir, { recursive: true, force: true }));
const UID = process.getuid?.() ?? 501;
const P = (pid: number, ppid: number, comm: string): Proc => ({ pid, ppid, pgid: pid, uid: UID, started: `t${pid}`, cpu: 0, comm, zombie: false });
const PANE = "w9:p2AZ", SELF = 400;

/**
 * A pane whose pi (200) runs a poll loop (`sleep`, 201) under the pane's shell (100); the command runs as 400 under a shell (399) of a session's pi (398); 300 is an orphan. A close takes `closesNeeded` closes to remove the pane, and then takes the
 * shell and the pi with it, as Herdr's close does, while the loop is adopted by init and goes on. `stubborn` processes outlive the kill sequence.
 */
function world({ closesNeeded = 1, stubborn = [] as number[], cwds = {} as Record<number, string>, server = "reaps" as "reaps" | "down" } = {}) {
	const table: Proc[] = [P(50, 1, "/opt/homebrew/bin/herdr"), P(100, 50, "-zsh"), P(200, 100, "node"), P(201, 200, "/bin/sleep"), P(300, 1, "node"), P(398, 50, "node"), P(399, 398, "-zsh"), P(SELF, 399, "node")];
	const calls: string[][] = [], reaped: number[][] = [], checkouts: string[] = [];
	let closes = 0;
	const listed = () => closes < closesNeeded;
	const herdr = async (args: string[]) => {
		calls.push(args);
		if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes: [{ pane_id: "w9:p1", tab_id: "w9:t1" }, ...(listed() ? [{ pane_id: PANE, tab_id: "w9:t2" }] : [])] } });
		if (args[0] === "pane" && args[1] === "process-info") return JSON.stringify({ result: { process_info: { shell_pid: 100, foreground_processes: [{ pid: 200, name: "pi" }] } } });
		if (args[0] === "pane" && args[1] === "close") {
			closes++;
			if (!listed()) {
				for (const gone of [100, 200]) table.splice(table.findIndex((p) => p.pid === gone), 1);
				table.find((p) => p.pid === 201)!.ppid = 1;
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
		cwds: async (pids) => new Map(pids.filter((pid) => cwds[pid] !== undefined).map((pid) => [pid, { path: cwds[pid]! }])),
		reap: async (refs) => {
			reaped.push(refs.map((r) => r.pid));
			drop(refs);
			const left = refs.filter((r) => stubborn.includes(r.pid)).map((r) => ({ pid: r.pid, program: "sleep" }));
			return { termed: refs.length, killed: left.length, skipped: 0, groups: 0, left };
		},
		reapCheckout: async (path) => {
			checkouts.push(path);
			if (server === "down") return { ok: false, error: "no sb server is running, so there is no owner registry to ask" };
			const here = table.filter((p) => p.ppid === 1 && cwds[p.pid] !== undefined && cwds[p.pid]!.startsWith(path));
			drop(here.map((p) => ({ pid: p.pid, started: p.started })));
			return { ok: true, reply: { owner: "(checkout)", reason: "reap", targets: here.length, left: [] } };
		},
	};
	return { table, calls, reaped, checkouts, herdr, pane, closes: () => closes };
}

async function close(w: ReturnType<typeof world>, argv: string[], env: NodeJS.ProcessEnv = { ...process.env }) {
	let out = "", err = "";
	const code = await run(["pane", "close", ...argv], { env, stateDir, herdrCli: w.herdr, pane: w.pane, out: (t) => void (out += t), err: (t) => void (err += t) });
	return { code, out, err, result: out ? (JSON.parse(out) as PaneClosed) : undefined };
}

test("cli: pane close takes the pane after the word and an optional --checkout", () => {
	assert.deepEqual(parseArgs(["pane", "close", "w9:p2AZ", "--checkout", "/wt"]).flags, { pane: "w9:p2AZ", checkout: "/wt" });
	for (const bad of [["pane"], ["pane", "close"], ["pane", "open", "w9:p2AZ"], ["pane", "close", "--checkout", "/wt"], ["pane", "close", "w9:p2AZ", "w9:p3"], ["pane", "close", "w9:p2AZ", "--owner", "x"]]) assert.throws(() => parseArgs(bad), UsageError, bad.join(" "));
});

test("a close that leaves the pane listed is tried again; once it is gone, the loop its pi left is reaped and nothing is left (exit 0)", async () => {
	const w = world({ closesNeeded: 2 });
	const { code, err, result } = await close(w, [PANE]);
	assert.equal(code, 0, err);
	assert.equal(w.closes(), 2);
	assert.equal(result!.closed, true);
	assert.equal(result!.attempts, 2);
	assert.deepEqual(result!.noops, [{ attempt: 1, at: "2026-11-27T01:00:00.000Z", foreground: ["pi"] }], "the no-op close is recorded with what ran in the pane");
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

test("--checkout asks the server's reap and lists what still works there, never this command or the shell it runs under", async () => {
	const cwds = { 300: "/wt/app", 398: "/wt", 399: "/wt", [SELF]: "/wt" };
	const reaped = world({ cwds });
	const ok = await close(reaped, [PANE, "--checkout", "/wt"]);
	assert.equal(ok.code, 0, ok.out);
	assert.deepEqual(reaped.checkouts, ["/wt"]);
	assert.deepEqual(ok.result!.reaped?.checkout, { owner: "(checkout)", reason: "reap", targets: 1, left: [] });
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
	assert.deepEqual(result!.left.map((l) => l.pid), [100, 200, 201]);
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
	const mine = await close(own, [PANE], { ...process.env, HERDR_PANE_ID: PANE });
	assert.equal(mine.code, 1);
	assert.match(mine.err, /does not close its own pane/);
	const missing = world();
	const none = await close(missing, ["w9:p404"]);
	assert.equal(none.code, 1);
	assert.match(none.err, /no pane w9:p404 in Herdr's list; nothing was closed/);
	const windows = world();
	windows.pane.platform = "win32";
	assert.equal((await close(windows, [PANE])).code, 1);
	for (const w of [own, missing, windows]) assert.ok(!w.calls.some((c) => c[1] === "close"), "no close was sent");
	assert.equal(mine.out + none.out, "");
});
