import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { stamp } from "../src/header.ts";
import { addRoute, readRoutes, type Route } from "../src/server/allyroute.ts";
import { slotOf } from "../src/server/record.ts";
import { createRevoker } from "../src/server/revoke.ts";
import { createWorkerEnds, WORKER_STOP_MS, workerReport, type WorkerRow } from "../src/server/workerrelay.ts";
import { putBook, readBook } from "../src/server/workerbook.ts";
import { fakeClock } from "./fake-clock.ts";

// A worker's endings (docs/specs/2026-11-26-ally-workers.md, Relay and end): its first call_tower milestone goes to the device's ask by code; the sweep closes it after, sends a code receipt for a worker gone or idle
// 60 minutes without a report, and a revoke interrupts a worker.

let root = "";
beforeEach(() => void (root = mkdtempSync(join(tmpdir(), "psb-worker-relay-"))));
afterEach(() => rmSync(root, { recursive: true, force: true }));
const ASK = "c".repeat(32), DEV = "d".repeat(26);
const WORKER = { points: 1, branch: "feat/x", path: "/nowhere/feat-x", base: "origin/main", baseSha: "0".repeat(40), label: "MP-1" };
const route = (over: Partial<Route> = {}): Route => ({ device: DEV, label: "mac", short: "dddddd", team: "t", teamName: "T", to: "w-1", name: "worker MP-1", kind: "opened", at: Date.now(), pane: "p1", ask: ASK, worker: WORKER, ...over });
const milestone = (text: string) => stamp({ from: { name: "worker", id: "w-1", role: "main", workspace: "Alpha" }, kind: "call_tower", scope: "tower", to: [{ name: "tower", id: "t", role: "tower" }], reply: false, why: "milestone" }, text);

test("the worker's first milestone goes to the ask by code and marks the row final; another message, or a later milestone, goes the ally-run way", async () => {
	const slot = slotOf(join(root, "state"), { HOME: root }), sent: { device: string; text: string; ask: string }[] = [];
	addRoute(slot, "wA", route(), Date.now());
	let kept = 0, swept = 0;
	const deps = { slot, workspace: "wA", now: Date.now, log: () => {}, sweep: () => void swept++, send: async (device: string, text: string, ask: string) => void sent.push({ device, text, ask }) };
	assert.equal(workerReport(deps, readRoutes(slot, "wA", Date.now())[0]!, "plain intercom", () => void kept++), false);
	const text = milestone("Done: feat/x at abc123, pushed.");
	assert.equal(workerReport(deps, readRoutes(slot, "wA", Date.now())[0]!, text, () => void kept++), true);
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(sent.map((s) => [s.device, s.ask]), [[DEV, ASK]]);
	assert.match(sent[0]!.text, /^Worker MP-1 \(branch feat\/x\) final report:\nDone: feat\/x at abc123, pushed\.$/);
	const row = readRoutes(slot, "wA", Date.now())[0]!;
	assert.ok(row.final !== undefined && row.ask === undefined, "final, and the ask is spent");
	assert.equal(workerReport(deps, row, text, () => void kept++), false, "one final report only");
	assert.deepEqual([kept, swept], [0, 1]);
});

test("a send that fails keeps the report for the next ally run", async () => {
	const slot = slotOf(join(root, "state"), { HOME: root });
	addRoute(slot, "wA", route(), Date.now());
	let kept = 0;
	workerReport({ slot, workspace: "wA", now: Date.now, log: () => {}, sweep: () => {}, send: async () => ({ ok: false, error: "too long" }) }, readRoutes(slot, "wA", Date.now())[0]!, milestone("x"), () => void kept++);
	await new Promise((r) => setImmediate(r));
	assert.equal(kept, 1);
});

function ends(rows: WorkerRow[], look: { listed: boolean; pane: boolean | undefined; working: boolean }) {
	const clock = fakeClock(), calls: string[] = [];
	const e = createWorkerEnds({
		rows: () => rows, now: clock.now, look: async () => look, log: () => {}, notice: (_w, text) => void calls.push(`notice ${text.slice(0, 20)}`),
		close: async (_w, main, mode) => void calls.push(`close ${main} ${mode}`), send: async (_w, device, text, ask) => void calls.push(`send ${device === DEV} ${ask === ASK} ${text}`),
		forget: (_w, main) => void calls.push(`forget ${main}`), stopped: (_w, main) => void calls.push(`stopped ${main}`),
	});
	return { e, clock, calls };
}
/** Awake idle time: sweeps a minute apart, as the 15-s timer's are close enough; one step past `SWEEP_SLEPT_MS` would be the computer asleep. */
const idleFor = async (h: { e: { sweep(): Promise<void> }; clock: ReturnType<typeof fakeClock> }, ms: number) => {
	for (let left = ms; left > 0; left -= 60_000) (h.clock.advance(Math.min(60_000, left)), await h.e.sweep());
};

test("a final row is closed and forgotten; a worker gone two sweeps in a row gets a receipt; one idle 60 minutes is interrupted with a receipt and kept", async () => {
	const done = ends([{ workspace: "wA", route: route({ final: 1 }) }], { listed: true, pane: true, working: false });
	await done.e.sweep();
	assert.deepEqual(done.calls.filter((c) => !c.startsWith("notice")), ["close w-1 quit", "forget w-1"]);
	const gone = ends([{ workspace: "wA", route: route() }], { listed: false, pane: false, working: false });
	await gone.e.sweep();
	assert.equal(gone.calls.length, 0, "one sweep is no proof");
	await gone.e.sweep();
	assert.match(gone.calls.find((c) => c.startsWith("send"))!, /^send true true Worker MP-1 is gone \(its pi ended\) without a final report: branch feat\/x; its worktree was kept on the box \(the worktree is gone already\)\.$/);
	assert.ok(gone.calls.includes("forget w-1"));
	const idle = ends([{ workspace: "wA", route: route() }], { listed: true, pane: true, working: false });
	await idle.e.sweep();
	await idleFor(idle, WORKER_STOP_MS - 1);
	assert.equal(idle.calls.length, 0);
	idle.clock.advance(1);
	await idle.e.sweep();
	assert.deepEqual(idle.calls.slice(0, 2), ["close w-1 interrupt", "stopped w-1"]);
	assert.match(idle.calls[2]!, /idle 60 minutes without a final report: the box stopped it; its worktree \/nowhere\/feat-x stays unless it is clean and pushed\.$/);
});

test("the computer slept: a worker idle when the lid closed is not stopped at the wake, since the time asleep is no idle time of its own; awake, its 60 minutes still run out", async () => {
	const idle = ends([{ workspace: "wA", route: route() }], { listed: true, pane: true, working: false });
	await idle.e.sweep();
	await idleFor(idle, 10 * 60_000);
	idle.clock.advance(2 * 3600_000);
	await idle.e.sweep();
	assert.deepEqual(idle.calls, [], "ten minutes idle and two hours asleep: not stopped");
	await idleFor(idle, WORKER_STOP_MS - 10 * 60_000 - 60_000);
	assert.deepEqual(idle.calls, [], "59 minutes idle awake");
	await idleFor(idle, 60_000);
	assert.deepEqual(idle.calls.slice(0, 2), ["close w-1 interrupt", "stopped w-1"], "60 minutes idle awake: stopped");
});

test("a revoke ends a worker with interrupt", async () => {
	const modes: string[] = [];
	const r = createRevoker({
		opened: () => [{ workspace: "wA", label: "A", main: "w-1", name: "worker", device: DEV, deviceLabel: "mac", team: "t", worker: true }],
		known: () => true, standing: () => undefined, close: async (_w, _m, mode) => void modes.push(String(mode)), paneGone: async () => false, forget: () => {}, signal: () => true, log: () => {},
	});
	await r.sweep();
	await r.sweep();
	assert.deepEqual(modes, ["interrupt"]);
});

const SID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
test("the final report, the gone receipt and the idle receipt end with the Session line; the book is marked with the end, the head and the file", async () => {
	const slot = slotOf(join(root, "state"), { HOME: root }), sent: string[] = [];
	addRoute(slot, "wA", route({ to: SID }), Date.now());
	putBook(slot.stateDir, Date.now() - 1000, { ask: ASK, main: SID, at: Date.now() - 1000, device: DEV, branch: "feat/x" });
	workerReport({ slot, workspace: "wA", now: Date.now, log: () => {}, sweep: () => {}, send: async (_d: string, text: string) => void sent.push(text) }, readRoutes(slot, "wA", Date.now())[0]!, milestone("done"), () => {});
	await new Promise((r) => setImmediate(r));
	const line = `Session: ${SID} · resume: call_tower worker {device: <this box>, resume: "${SID}", message: <the follow-up>} (kept 7 days)`;
	assert.ok(sent[0]!.endsWith(`\n${line}`), sent[0]);
	assert.equal(readBook(slot.stateDir, Date.now())[0]!.ended?.how, "report");
	const marks: string[] = [];
	const mk = (look: { listed: boolean; pane: boolean | undefined; working: boolean; file?: string }) => {
		const clock = fakeClock(), calls: string[] = [];
		const e = createWorkerEnds({ rows: () => [{ workspace: "wA", route: route({ to: SID }) }], now: clock.now, look: async () => look, log: () => {}, notice: () => {}, close: async () => {}, send: async (_w, _d, text) => void calls.push(text), forget: () => {}, stopped: () => {}, book: (main, patch, renew) => void marks.push(`${main === SID} ${JSON.stringify(patch)} ${renew === true}`) });
		return { e, clock, calls };
	};
	const gone = mk({ listed: false, pane: false, working: false });
	await gone.e.sweep();
	await gone.e.sweep();
	assert.ok(gone.calls[0]!.endsWith(line));
	assert.ok(marks.some((m) => /^true \{"ended":\{"at":\d+,"how":"gone"\}\} true$/.test(m)), marks.join("; "));
	const idle = mk({ listed: true, pane: true, working: false, file: "/s/x.jsonl" });
	await idle.e.sweep();
	await idleFor(idle, WORKER_STOP_MS);
	assert.ok(idle.calls[0]!.endsWith(line));
	assert.ok(marks.includes('true {"file":"/s/x.jsonl"} false'));
	assert.ok(marks.some((m) => m.includes('"how":"idle"') && m.endsWith("true")));
	const plain = route();
	assert.equal(plain.to, "w-1", "an id that is no uuid gets no Session line (the tests above end without one)");
});
