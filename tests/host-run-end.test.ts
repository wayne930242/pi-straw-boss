import assert from "node:assert/strict";
import { test } from "node:test";
import { RUN_END_EVENT } from "../src/host/run-end.ts";
import { simpleApi } from "../src/host/surface.ts";

// A run's end as sb's host tells it (docs/specs/2026-11-28-todo-preflight.md B, S6): Maestro's `subagent_result` and `subagent_ping` name the run's session file, and a result its
// `elapsed`; neither names the run id, and a ping no time. The host notes each launch and resume it acknowledged, and on each end adds the run id and a ping's elapsed to the details
// and sends `subagent:run-end` on pi.events, so pi-todo-ledger counts the end once even when its message never reaches the model.

/** `registry`, when given, is Maestro's live rows: a run leaves it just before its end is sent. */
function world(registry?: Set<string>) {
	let clock = 1_000_000;
	const sent: { customType: string; details: Record<string, unknown> }[] = [], events: unknown[] = [], tools = new Map<string, { execute: (...a: unknown[]) => Promise<unknown> }>();
	const pi = {
		registerTool: (t: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => void tools.set(t.name, t),
		registerCommand() {},
		sendMessage: (m: { customType: string; details: Record<string, unknown> }) => void sent.push(m),
		events: { emit: (channel: string, data: unknown) => void (channel === RUN_END_EVENT && events.push(data)), on: () => () => {} },
	};
	const api = simpleApi(pi as never, { persistentRole: () => false, now: () => clock, startOf: () => undefined, ...(registry ? { live: (id: string) => registry.has(id) } : {}) });
	let reply: unknown;
	api.registerTool({ name: "subagent", parameters: {}, execute: async () => reply } as never);
	api.registerTool({ name: "subagent_resume", parameters: {}, execute: async () => reply } as never);
	const call = async (name: string, details: Record<string, unknown>) => ((reply = { content: [], details }), tools.get(name)!.execute("c", {}, undefined, undefined, {}));
	return { api, sent, events, call, tick: (ms: number) => void (clock += ms) };
}

test("a ping gets its run id and the time since its launch; the event names the same", async () => {
	const w = world();
	await w.call("subagent", { status: "started", id: "run-1", name: "w", item: "t_aaaaaaaaaa", sessionFile: "/s/w.jsonl" });
	w.tick(600_400);
	w.api.sendMessage({ customType: "subagent_ping", content: "help", display: true, details: { name: "w", item: "t_aaaaaaaaaa", message: "help", sessionFile: "/s/w.jsonl" } } as never);
	assert.deepEqual(w.sent[0]!.details, { name: "w", item: "t_aaaaaaaaaa", message: "help", sessionFile: "/s/w.jsonl", id: "run-1", elapsed: 600 });
	assert.deepEqual(w.events, [{ v: 1, id: "run-1", kind: "ping", name: "w", item: "t_aaaaaaaaaa", sessionFile: "/s/w.jsonl", elapsed: 600 }]);
});

test("a resume is a run of its own: its result keeps Maestro's elapsed and names the resume's run id; an end the host never launched passes as it came", async () => {
	const w = world();
	await w.call("subagent", { status: "started", id: "run-1", name: "w", sessionFile: "/s/w.jsonl" });
	w.api.sendMessage({ customType: "subagent_ping", details: { name: "w", sessionFile: "/s/w.jsonl" } } as never);
	await w.call("subagent_resume", { status: "started", id: "run-2", name: "w", sessionPath: "/s/w.jsonl" });
	w.tick(5000);
	w.api.sendMessage({ customType: "subagent_result", details: { name: "w", sessionFile: "/s/w.jsonl", exitCode: 0, elapsed: 120 } } as never);
	assert.deepEqual(w.sent[1]!.details, { name: "w", sessionFile: "/s/w.jsonl", exitCode: 0, elapsed: 120, id: "run-2" });
	assert.deepEqual((w.events[1] as { id: string; elapsed: number; kind: string }), { v: 1, id: "run-2", kind: "result", name: "w", sessionFile: "/s/w.jsonl", elapsed: 120 });
	w.api.sendMessage({ customType: "subagent_result", details: { name: "x", sessionFile: "/s/other.jsonl", elapsed: 3 } } as never);
	w.api.sendMessage({ customType: "intercom_message", details: { sessionFile: "/s/w.jsonl" } } as never);
	assert.deepEqual(w.sent.slice(2).map((m) => m.details), [{ name: "x", sessionFile: "/s/other.jsonl", elapsed: 3 }, { sessionFile: "/s/w.jsonl" }]);
	assert.equal(w.events.length, 2, "an unknown run and another message send no event");
	await w.call("subagent", { status: "uncertain", id: "run-3", sessionFile: "/s/u.jsonl" });
	w.api.sendMessage({ customType: "subagent_result", details: { sessionFile: "/s/u.jsonl", elapsed: 1 } } as never);
	assert.equal(w.events.length, 2, "an uncertain launch is noted by nobody");
});

test("an end is the run Maestro just removed from its registry: a failed result without a session file and a fallback's new path are both told, by the run id", async () => {
	const registry = new Set<string>(), w = world(registry);
	registry.add("run-1"), registry.add("run-2");
	await w.call("subagent", { status: "started", id: "run-1", name: "w", item: "aaaa1111#1", sessionFile: "/s/w.jsonl" });
	await w.call("subagent", { status: "started", id: "run-2", name: "v", sessionFile: "/s/v.jsonl" });
	registry.delete("run-1");
	w.api.sendMessage({ customType: "subagent_result", details: { name: "w", item: "aaaa1111#1", exitCode: 1, elapsed: 63, errorMessage: "no access" } } as never);
	assert.equal(w.sent[0]!.details.id, "run-1");
	assert.deepEqual(w.events, [{ v: 1, id: "run-1", kind: "result", name: "w", item: "aaaa1111#1", elapsed: 63 }], "no session file, still an end");
	registry.delete("run-2");
	w.api.sendMessage({ customType: "subagent_result", details: { name: "v", sessionFile: "/s/v-fallback.jsonl", exitCode: 0, elapsed: 9 } } as never);
	assert.deepEqual(w.events[1], { v: 1, id: "run-2", kind: "result", name: "v", sessionFile: "/s/v-fallback.jsonl", elapsed: 9 }, "the fallback's file is the one read");
	w.api.sendMessage({ customType: "subagent_result", details: { name: "v", sessionFile: "/s/v-fallback.jsonl", exitCode: 0, elapsed: 9 } } as never);
	assert.equal(w.events.length, 2, "an end closes its run");
});

test("a run still in Maestro's registry is not the end, and two ended runs the end cannot tell apart send no event", async () => {
	const registry = new Set(["run-1", "run-2", "run-3"]), w = world(registry);
	await w.call("subagent", { status: "started", id: "run-1", name: "w", sessionFile: "/s/a.jsonl" });
	await w.call("subagent", { status: "started", id: "run-2", name: "w", sessionFile: "/s/b.jsonl" });
	await w.call("subagent", { status: "started", id: "run-3", name: "w", sessionFile: "/s/c.jsonl" });
	registry.delete("run-2");
	w.api.sendMessage({ customType: "subagent_result", details: { name: "w", sessionFile: "/s/a.jsonl", elapsed: 1 } } as never);
	assert.equal((w.events[0] as { id: string }).id, "run-2", "run-1 is still running: the gone run-2 ended, whatever file its result names");
	registry.delete("run-1"), registry.delete("run-3");
	w.api.sendMessage({ customType: "subagent_result", details: { name: "w", sessionFile: "/s/new.jsonl", elapsed: 1 } } as never);
	assert.equal(w.events.length, 1, "run-1 or run-3: neither file names it");
	w.api.sendMessage({ customType: "subagent_result", details: { name: "w", sessionFile: "/s/c.jsonl", elapsed: 1 } } as never);
	assert.equal((w.events[1] as { id: string }).id, "run-3", "among ended runs, the file still tells");
});
