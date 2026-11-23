import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileOf } from "../src/server/record.ts";
import { TowerWorld } from "./tower-world.ts";
import { readEntries } from "../src/board.ts";
import { callControl } from "../src/server/socket.ts";
import { HEAD_KEY, readQueue } from "../src/server/towerstore.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { until } from "./server-world.ts";

const morning = (d: number, minute: number) => new Date(2026, 10, d, 6, minute).getTime();

test("a morning start without ledger.janitor records a skipped sweep, not a wake", async () => {
	const w = new TowerWorld();
	try {
		await w.start({ gui: false, now: () => morning(23, 31) });
		assert.match(readFileSync(fileOf(w.slot, "log"), "utf8"), /ledger-sweep.*ledger\.janitor is unset/);
		assert.equal(w.pis.size, 0);
		assert.match(readFileSync(join(w.stateDir, "ledger-sweep-date.json"), "utf8"), /2026-11-23/);
	} finally { await w.close(); }
});

test("the morning uses the existing head notice; only a head run that took it may start the fixed job", async () => {
	const w = new TowerWorld(), calls: string[][] = [];
	let now = morning(23, 29), tick = () => {};
	try {
		w.setFlag(true);
		const repo = join(w.stateDir, "alpha"), inRepo = join(repo, "scratch", "keep.md");
		mkdirSync(join(repo, ".git"), { recursive: true });
		w.herdr.workspaces[0]!.worktree = { checkout_path: repo };
		writeFileSync(join(w.stateDir, "config.json"), JSON.stringify({ ledger: { janitor: join(w.stateDir, "my janitor") } }));
		const server = await w.start({ gui: false, now: () => now, ledgerSweep: { every: (fn, ms) => { assert.equal(ms, 60_000); tick = fn; return () => {}; }, exec: async (file, args) => {
			calls.push([file, ...args]);
			return JSON.stringify({ actions: [], left: [{ repo: "alpha", path: inRepo, reason: "open work" }, { repo: null, path: "/fully/unmatched/session.jsonl", reason: "no live workspace" }] });
		} } });
		const ask = async (cmd: string, fields: Record<string, unknown> = {}) => (await callControl(server.handle.endpoint, w.record()!.secret, { cmd, ...fields })).reply!;
		assert.equal((await ask("ensure-tower", { workspace: "wA" })).ok, true);
		const head = await w.expose!.head.ensure();
		tick();
		assert.deepEqual(readQueue(w.slot, HEAD_KEY), []);
		now = morning(23, 47); // the Mac woke after 06:30
		tick();
		tick();
		const queued = readQueue(w.slot, HEAD_KEY);
		assert.equal(queued.length, 1);
		assert.match(queued[0]!.text, /ledger_sweep.*prune.*ledger-janitor --apply --json.*tower_send.*head work board.*Never ask the boss/);
		await until(() => [...w.pis.keys()].some((id) => readRun(w.slot, head.workspace, id)?.pid !== undefined), "the head run starts");
		const [id, pi] = [...w.pis.entries()][0]!;
		const claim = await ask("claim", { runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
		assert.equal(claim.kind, "head");
		const tool = (turn: string, args: object = {}) => ask("run-tool", { token: claim.token, tool: "ledger_sweep", turn, args });
		const poll = await ask("run-poll", { token: claim.token, idle: true });
		const event = poll.event as { id: string };
		assert.equal((await tool(event.id)).ok, false, "an offered but untaken event has no authority");
		assert.equal((await ask("run-taken", { token: claim.token, id: event.id })).ok, true);
		assert.equal((await tool("wrong")).ok, false);
		assert.equal((await tool(event.id, { executable: "/bin/true" })).ok, false);
		const result = await tool(event.id);
		assert.equal(result.ok, true, JSON.stringify(result));
		assert.deepEqual((result.details as { matched: unknown }).matched, [{ workspace: "wA", repo: "alpha", path: inRepo, reason: "open work" }]);
		assert.equal((await tool(event.id)).ok, true, "repeated tool calls see the same result");
		assert.deepEqual(calls, [[join(w.stateDir, "my janitor"), "--apply", "--json"]]);
		assert.deepEqual(readEntries(join(w.stateDir, "board")).map((row) => row.now), ["session.jsonl: no live workspace"]);
		tick();
		assert.equal(readQueue(w.slot, HEAD_KEY).length, 1);
		now = morning(24, 29); tick();
		assert.equal(readQueue(w.slot, HEAD_KEY).length, 1);
		now = morning(24, 30); tick();
		assert.deepEqual(readQueue(w.slot, HEAD_KEY).map((event) => event.messageId), ["ledger_sweep:2026-11-23", "ledger_sweep:2026-11-24"]);
	} finally { await w.close(); }
});
