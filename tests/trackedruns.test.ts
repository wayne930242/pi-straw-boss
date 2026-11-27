import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readRuns, runCount, tracked } from "../src/trackedruns.ts";
import { replyBus, runBus, runRow } from "./run-probe.ts";

// The host's tracked-run snapshot (`pi-herdr-agents:runs:v1`) is believed only whole: every row a complete v1 run, the array without holes. Anything else is unknown: never empty, never the legacy Map.
const SLOT = Symbol.for("pi-subagents/runtime"), global = globalThis as Record<symbol, unknown>;
afterEach(() => void delete global[SLOT]);

test("snapshot-F005: a v1 answer with an incomplete row or a hole is unknown, not empty, and never falls back to the legacy Map", () => {
	global[SLOT] = { runningSubagents: new Map([["legacy", { name: "legacy", agent: "worker" }]]) };
	const { persistent: _p, ...noPersistent } = runRow("a"), { delivery: _d, ...noDelivery } = runRow("a"), sparse: unknown[] = [runRow("a")];
	sparse.length = 2;
	for (const runs of [[noPersistent], [noDelivery], [{ ...runRow("a"), delivery: "lost" }], [{ ...runRow("a"), persistent: "no" }], [{ ...runRow("a"), name: 7 }], sparse, new Array(1)]) {
		const bus = replyBus(() => ({ version: 1, runs }));
		assert.deepEqual(readRuns(bus), { source: "unknown" }, JSON.stringify(runs));
		assert.deepEqual(runCount(bus), { source: "unknown" }, "the doctor says unknown, not a count");
		assert.equal(tracked(bus), undefined);
	}
	const whole = replyBus(() => ({ version: 1, runs: [runRow("a"), { ...runRow("b", "reviewer"), persistent: true, delivery: "suppressed" }, { id: "c", name: "c", persistent: false, delivery: "delivered" }] }));
	assert.deepEqual(readRuns(whole).runs?.map((r) => r.id), ["a", "b", "c"], "every delivery state, and a run without an agent, is a run");
	assert.deepEqual(runCount(replyBus(() => ({ version: 1, runs: [] }))), { source: "snapshot", count: 0 });
	assert.deepEqual(runCount(replyBus()), { source: "legacy", count: 1 }, "only no answer reads the Map");
});

test("F009: a script folder that cannot be listed (ENOTDIR) is unknown, not no owner; one that is not there is no owner", async () => {
	const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path"), { sessionRuns } = await import("../src/trackedruns.ts");
	const dir = mkdtempSync(join(tmpdir(), "psb-trackedruns-")), id = "7a7a7a7a-0000-4000-8000-000000000009", launcher = join(dir, `2026-11-24T00-10-00-000Z_${id}.jsonl`);
	const bus = runBus(() => []), file = join(dir, "2026-11-24T00-11-00-000Z_r1-aaaaaaaa-bbbbbbbb-cccc.jsonl");
	assert.equal(sessionRuns(launcher, file, bus).owner, undefined, "no artifacts folder: no script");
	mkdirSync(join(dir, "artifacts", id), { recursive: true });
	writeFileSync(join(dir, "artifacts", id, "subagent-scripts"), "not a folder");
	assert.equal(sessionRuns(launcher, file, bus).owner, null);
});
