import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createLifecycle } from "@nubl/maestro/core/lifecycle";
import { createHost } from "../src/host/index.ts";
import { __test__ } from "../src/host/engine.ts";
import { fakePi } from "./host-fake.ts";

// `pi-herdr-agents:run-rows:v1` is a contract with pi-todo-ledger (0.7.1 draws each claimed row under its todo, and a run with no todo in its
// "other workers" group): the event name, the payload and the claim semantics are pi-herdr-agents 2045e55's, unchanged. sb's Subagents box is the
// fallback: it shows only the rows no presenter claimed, one row each, name · model · state · time, and is gone when every row is claimed.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EVENT = "pi-herdr-agents:run-rows:v1";

interface Probe { claim?: { by: string; ids: string[] }; rows?: unknown }

async function world() {
	const f = fakePi(`${ROOT}src/host/index.ts`);
	createHost({ choice: () => ({ host: "sb", from: "default" }), root: ROOT })(f.pi);
	await f.emit("session_start");
	const probe = (claim?: Probe["claim"]) => {
		const p: Probe = claim ? { claim } : {};
		f.pi.events.emit(EVENT, p);
		return p.rows;
	};
	return { ...f, probe };
}

const run = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, task: "", surface: "s1", startTime: 1000, sessionFile: "unused", interactive: false, lifecycle: createLifecycle(1000), runtimePlan: undefined, ...extra });

test("the payload is exactly pi-herdr-agents 2045e55's: version 1, one detached snapshot row per run, with or without a todo", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 5000 });
	const w = await world();
	assert.deepEqual(w.probe(), { version: 1, rows: [] }, "an answer with no runs");
	const runs = [run("a1", "scout-1", { agent: "scout", runtimePlan: { modelId: "openai-codex/gpt-6.2-astra", thinking: "low" } }), run("b2", "build-api", { cancelState: "requested" })];
	for (const r of runs) __test__.runningSubagents.set(r.id, r as never);
	t.after(() => __test__.runningSubagents.clear());
	assert.deepEqual(w.probe(), {
		version: 1,
		rows: [
			{ id: "a1", name: "scout-1", agent: "scout", model: "openai-codex/gpt-6.2-astra", thinking: "low", startedAt: 1000, phase: { kind: "starting" } },
			{ id: "b2", name: "build-api", startedAt: 1000, phase: { kind: "starting" }, cancel: "requested" },
		],
	});
});

test("a worker launched with no todo is a normal row: in the box when nobody claims it, gone from it when a ledger claims it for its other-workers group", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: 61_000 });
	const w = await world();
	const runs = [run("u1", "scout-quick", { runtimePlan: { modelId: "openai-codex/gpt-6.2-astra", thinking: "low" } }), run("t1", "login-api")];
	for (const r of runs) __test__.runningSubagents.set(r.id, r as never);
	t.after(() => __test__.runningSubagents.clear());
	const draw = () => __test__.renderSubagentWidgetLines(runs as never, 100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
	assert.match(draw(), /│ scout-quick +· openai-codex\/gpt-6\.2-astra · starting… · 01:00 │/, "one row: name · model · state · time");
	assert.doesNotMatch(draw(), /orphan|unbound|no todo|not on a todo/i, "nothing calls it an error");
	w.probe({ by: "ledger", ids: ["t1"] });
	assert.match(draw(), /1 on todos/);
	assert.match(draw(), /scout-quick/);
	assert.doesNotMatch(draw(), /login-api/);
	w.probe({ by: "ledger", ids: ["t1", "u1"] });
	assert.equal(draw(), "", "every row claimed: no box at all");
	w.probe({ by: "ledger", ids: [] });
	assert.match(draw(), /scout-quick[\s\S]*login-api/, "a released claim brings the rows back at once");
});

test("a claim lasts three seconds: a ledger that stops drawing gives its rows back to the box", async (t) => {
	let now = 10_000;
	t.mock.method(performance, "now", () => now);
	const w = await world();
	const runs = [run("x", "worker-1")];
	__test__.runningSubagents.set("x", runs[0] as never);
	t.after(() => __test__.runningSubagents.clear());
	w.probe({ by: "ledger", ids: ["x"] });
	assert.equal(__test__.renderSubagentWidgetLines(runs as never, 80).length, 0);
	now += 3001;
	assert.match(__test__.renderSubagentWidgetLines(runs as never, 80).join("\n"), /worker-1/);
});
