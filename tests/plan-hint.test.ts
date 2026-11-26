import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GRAPHS } from "../src/duty.ts";
import { PLAN_HINT_END, planHint, registerPlanHint } from "../src/planhint.ts";

// The planning rule when a main plans without a graph (docs/specs/2026-11-26-plan-graph-jit.md; boss 2026-11-26 「sb 在派工當下送規則」).

const PLANNING = readFileSync(new URL("../prompts/planning.md", import.meta.url), "utf8");
type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown;
type Task = { id: number; subject: string; status: string; graph?: string; metadata?: Record<string, unknown> };

function world(kind: string | undefined) {
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (type: string, h: Handler) => void handlers.set(type, [...(handlers.get(type) ?? []), h]) };
	let k = kind;
	registerPlanHint(pi as never, () => k, () => PLANNING);
	let n = 0;
	/** A `todo` result whose details are the whole list after the call. */
	const todo = (input: Record<string, unknown>, tasks: Task[]) => {
		const event = { type: "tool_result", toolName: "todo", toolCallId: `t${++n}`, input, content: [{ type: "text", text: "ok" }], details: { tasks, nextId: tasks.length + 1 }, isError: false };
		const out = (handlers.get("tool_result") ?? []).map((h) => h(event)).find((x) => x !== undefined) as { content: { text: string }[] } | undefined;
		return out?.content.slice(1).map((c) => c.text);
	};
	return { todo, kind: (v: string | undefined) => void (k = v), start: () => (handlers.get("session_start") ?? []).forEach((h) => h({})) };
}
const plain = (id: number, status = "pending"): Task => ({ id, subject: `task ${id}`, status });
const graphed = (id: number, graph = "fan-out/fan-in"): Task => ({ ...plain(id), metadata: { graph } });

test("the block is planning.md §1 and §2 condensed from the file: every graph name exactly, the todo fields, and its end line, within 1.2 KB", () => {
	const block = planHint(PLANNING);
	for (const g of GRAPHS) assert.ok(block.includes(`- ${g}:`), `names ${g}`);
	for (const field of ["`subject`", "`owner`", "`description`", "`blockedBy`", "`metadata`", "- `graph`: a graph name from section 1, exactly."]) assert.ok(block.includes(field), `names ${field}`);
	assert.ok(block.endsWith(PLAN_HINT_END));
	assert.ok(Buffer.byteLength(block) <= 1200, `the block is ${Buffer.byteLength(block)} bytes`);
	for (const line of block.split("\n").slice(1, -1)) assert.ok(PLANNING.includes(line.replace(/^(- )?(single-loop|fan-out\/fan-in|orchestrator-worker):/, "$1**$2**:").replace(/^(Name the graph|Write the plan as todos): /, "")) || /^(- `blockedBy`|- `metadata`)/.test(line), `from the file: ${line}`);
});

test("a planning.md that lost a section or a cut text is a file error, not a silent block", () => {
	assert.throws(() => planHint(PLANNING.replace("## 2. Write the plan as todos", "## Two")), /no section 2/);
	assert.throws(() => planHint(PLANNING.replace("The page shows it beside your kind. ", "")), /no longer hold/);
});

test("a main's first create with no graph gets the block once; the next create does not", () => {
	const w = world("coordinator");
	const first = w.todo({ action: "create", subject: "task 1" }, [plain(1)]);
	assert.equal(first?.length, 1);
	assert.ok(first![0].endsWith(PLAN_HINT_END));
	assert.equal(w.todo({ action: "create", subject: "task 2" }, [plain(1), plain(2)]), undefined);
});

test("a batch create with no graph gets the block", () => {
	const w = world("standing");
	assert.equal(w.todo({ action: "create", tasks: [{ subject: "a" }, { subject: "b" }] }, [plain(1), plain(2)])?.length, 1);
});

test("a create whose open todos name a graph gets nothing, nor does a list with nothing open, nor an update", () => {
	const w = world("coordinator");
	assert.equal(w.todo({ action: "create", subject: "task 1" }, [graphed(1), plain(2)]), undefined);
	assert.equal(w.todo({ action: "create", subject: "task 1" }, [plain(1, "completed")]), undefined);
	assert.equal(w.todo({ action: "update", id: 1, status: "in_progress" }, [plain(1, "in_progress")]), undefined);
	assert.equal(w.todo({ action: "create", subject: "train" }, [{ ...plain(1), metadata: { sb: { kind: "lane" } } }]), undefined, "a train step is no plan");
});

test("a todo's own `graph` field counts (pi-todo-ledger 0.4.0), and so does a legacy metadata.graph; a graph field that is no name of section 1 does not", () => {
	assert.equal(world("coordinator").todo({ action: "create", subject: "a", graph: "orchestrator-worker" }, [{ ...plain(1), graph: "orchestrator-worker" }]), undefined);
	assert.equal(world("coordinator").todo({ action: "create", subject: "a" }, [graphed(1, "single-loop")]), undefined);
	assert.ok(world("coordinator").todo({ action: "create", subject: "a", graph: "fan-out" }, [{ ...plain(1), graph: "fan-out" }]));
});

test("once more only after the open todos named a graph and then again named none", () => {
	const w = world("coordinator");
	assert.ok(w.todo({ action: "create", subject: "a" }, [plain(1)]));
	assert.equal(w.todo({ action: "create", subject: "b" }, [plain(1), plain(2)]), undefined);
	assert.equal(w.todo({ action: "update", id: 1, metadata: { graph: "single-loop" } }, [graphed(1, "single-loop"), plain(2)]), undefined);
	assert.equal(w.todo({ action: "create", subject: "c" }, [graphed(1, "single-loop"), plain(2), plain(3)]), undefined);
	assert.ok(w.todo({ action: "create", subject: "d" }, [{ ...graphed(1), status: "completed" }, plain(2, "completed"), plain(3, "completed"), plain(4)]), "a new plan with no graph");
	assert.equal(w.todo({ action: "create", subject: "e" }, [plain(4), plain(5)]), undefined);
});

test("no member, worker, integrator, train, or tower gets it", () => {
	for (const kind of [undefined, "worker", "integrator"]) assert.equal(world(kind).todo({ action: "create", subject: "a" }, [plain(1)]), undefined, String(kind));
});
