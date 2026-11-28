import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_END_EVENT } from "../src/host/run-end.ts";
import { simpleApi } from "../src/host/surface.ts";

// A run's end as sb's host tells it (docs/specs/2026-11-28-todo-preflight.md B): Maestro names the run id (`details.id`), its elapsed and its spawned attempts on every
// `subagent_result` and `subagent_ping`; as the end goes out the host sends `subagent:run-end` with them, so pi-todo-ledger counts the end once even when its message
// never reaches the model. The host never guesses a run from its name or its session file.

function world(listener?: (data: unknown) => void) {
	const sent: { customType: string; details?: unknown }[] = [], events: unknown[] = [];
	const pi = {
		registerTool() {},
		registerCommand() {},
		sendMessage: (m: { customType: string; details?: unknown }) => void sent.push(m),
		events: { emit: (channel: string, data: unknown) => { if (channel !== RUN_END_EVENT) return; events.push(data); listener?.(data); }, on: () => () => {} },
	};
	const api = simpleApi(pi as never, { persistentRole: () => false });
	const send = (customType: string, details: Record<string, unknown>) => api.sendMessage({ customType, content: "x", display: true, details } as never);
	return { api, sent, events, send };
}

test("an end goes out as Maestro sent it, then its event names the run id, its elapsed and its attempts", () => {
	const w = world();
	const attempts = [{ model: "anthropic/one", sessionFile: "/s/a1.jsonl", elapsed: 40 }, { model: "anthropic/two", sessionFile: "/s/a2.jsonl", elapsed: 20 }];
	const details = { id: "run-1", name: "w", item: "t_aaaaaaaaaa", sessionFile: "/s/a2.jsonl", exitCode: 0, elapsed: 20, attempts };
	w.send("subagent_result", details);
	assert.deepEqual(w.sent[0]!.details, details, "the message is Maestro's, unchanged");
	assert.deepEqual(w.events, [{ v: 1, id: "run-1", kind: "result", name: "w", item: "t_aaaaaaaaaa", sessionFile: "/s/a2.jsonl", elapsed: 20, attempts }]);
});

test("a ping's event carries the elapsed Maestro names on it (F003)", () => {
	const w = world();
	w.send("subagent_ping", { id: "run-1", name: "w", message: "help", sessionFile: "/s/w.jsonl", elapsed: 600, attempts: [{ model: "m", sessionFile: "/s/w.jsonl", elapsed: 600 }] });
	assert.deepEqual(w.events, [{ v: 1, id: "run-1", kind: "ping", name: "w", sessionFile: "/s/w.jsonl", elapsed: 600, attempts: [{ model: "m", sessionFile: "/s/w.jsonl", elapsed: 600 }] }]);
});

test("two runs of one name: each end is the run its id names, even after an earlier end of the other went unsent (F011)", () => {
	const w = world();
	// Run A's resume ended without a delivered message (its read failed); run B, of the same name, ends next. B's time is B's.
	w.send("subagent_result", { id: "run-b", name: "w", item: "t_bbbbbbbbbb", sessionFile: "/s/b.jsonl", exitCode: 0, elapsed: 91 });
	assert.deepEqual(w.events, [{ v: 1, id: "run-b", kind: "result", name: "w", item: "t_bbbbbbbbbb", sessionFile: "/s/b.jsonl", elapsed: 91 }]);
	w.send("subagent_result", { id: "run-a", name: "w", exitCode: 1, elapsed: 63, errorMessage: "no access" });
	assert.deepEqual(w.events[1], { v: 1, id: "run-a", kind: "result", name: "w", elapsed: 63 }, "a failed run without a session file still ends, by its id");
});

test("an end that names no run id, and any other message, send no event: the host does not guess", () => {
	const w = world();
	w.send("subagent_result", { name: "w", sessionFile: "/s/w.jsonl", exitCode: 0, elapsed: 3 });
	w.send("subagent_ping", { name: "w", message: "help", sessionFile: "/s/w.jsonl" });
	w.send("intercom_message", { id: "run-1", sessionFile: "/s/w.jsonl" });
	assert.equal(w.sent.length, 3);
	assert.deepEqual(w.events, []);
});

test("a listener that throws does not reach Maestro, which would retry the send and deliver the end twice (F008)", () => {
	const warn = console.warn;
	console.warn = () => {};
	try {
		const w = world(() => { throw new Error("ledger bug"); });
		assert.doesNotThrow(() => w.send("subagent_result", { id: "run-1", name: "w", exitCode: 0, elapsed: 1 }));
		assert.equal(w.sent.length, 1);
		assert.equal(w.events.length, 1);
	} finally {
		console.warn = warn;
	}
});

test("through Maestro's own delivery: a result and a ping reach the ledger's event with the run id Maestro names", async () => {
	const { createDelivery } = await import("@nubl/maestro/pi/subagents/delivery");
	const w = world();
	const deliver = createDelivery({ runtime: { runningSubagents: new Map(), liveApi: w.api } as never, updateWidget() {}, startPersistentStopTimeout() {} }).deliverPiCompletion;
	const record = (id: string) => ({ id, name: "w", agent: "worker", lifecycle: { delivery: "pending" } }) as never;
	const task = { id: "t", name: "w", prompt: "task", role: "worker", cwd: "/", item: "t_bbbbbbbbbb" } as never;
	const attempts = [{ model: "anthropic/one", sessionFile: "/s/b1.jsonl", elapsed: 40 }, { model: "anthropic/two", sessionFile: "/s/b2.jsonl", elapsed: 51 }];
	await deliver(record("run-b"), { run: {}, name: "w", task: "task", summary: "done", summarySource: "child", sessionFile: "/s/b2.jsonl", exitCode: 0, elapsed: 51, attempts } as never, task, {} as never);
	await deliver(record("run-c"), { run: {}, name: "w", task: "task", summary: "", summarySource: "child", sessionFile: "/s/c.jsonl", exitCode: 0, elapsed: 600, ping: { name: "w", message: "help" }, attempts: [{ sessionFile: "/s/c.jsonl", elapsed: 600 }] } as never, task, {} as never);
	assert.deepEqual(w.events, [
		{ v: 1, id: "run-b", kind: "result", name: "w", item: "t_bbbbbbbbbb", sessionFile: "/s/b2.jsonl", elapsed: 51, attempts },
		{ v: 1, id: "run-c", kind: "ping", name: "w", item: "t_bbbbbbbbbb", sessionFile: "/s/c.jsonl", elapsed: 600, attempts: [{ sessionFile: "/s/c.jsonl", elapsed: 600 }] },
	]);
});
