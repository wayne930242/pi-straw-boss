import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanPlan, forAllies, readEntries, writeEntry } from "../src/board.ts";
import { PLAN } from "../src/boardplan.ts";
import { deriveBoard } from "../src/boardauto.ts";
import { seedBoard } from "../src/boardseed.ts";
import { boardRows } from "../src/boardview.ts";
import { capOfTodos } from "../src/capacity.ts";
import { type Todo, todosOf } from "../src/items.ts";

// The plan an auto entry carries beside its checklist (src/boardplan.ts): the open todos as graph data, capped, the defer read from `metadata.waitsOn`/`metadata.until`, scrubbed as the items are, kept local (allies get none), and read
// by old and new builds alike: a file without a plan is a checklist, and a file with one keeps every field an older reader checks.

const todo = (id: number, subject: string, status: Todo["status"], over: Partial<Todo> = {}): Todo => ({ id, subject, status, ...over });
const ROOT = "/work/app", NOW = Date.parse("2026-11-27T08:00:00Z");
const dirOf = () => mkdtempSync(join(tmpdir(), "sb-plan-"));

test("the plan: open todos only, in progress first then pending in id order; after names open blockers only; owner, graph, and the defer go with it", () => {
	const list = [
		todo(1, "Survey", "completed"),
		todo(4, "Merge", "pending", { blockedBy: [2, 3, 1], graph: "fan-out/fan-in" }),
		todo(3, "Build web", "in_progress", { blockedBy: [1], owner: "worker-web" }),
		todo(2, "Build api", "pending", { blockedBy: [1], owner: "worker-api" }),
		todo(5, "Boss sign-off", "pending", { blockedBy: [4], waitsOn: "boss", until: "2026-11-27T14:00:00.000Z" }),
	];
	const plan = deriveBoard({ name: "MP-1", todos: list, root: ROOT })!.plan!;
	assert.deepEqual(plan, {
		graph: "fan-out/fan-in",
		nodes: [
			{ id: 3, t: "Build web", status: "in_progress", owner: "worker-web" },
			{ id: 2, t: "Build api", status: "pending", owner: "worker-api" },
			{ id: 4, t: "Merge", status: "pending", after: [2, 3] },
			{ id: 5, t: "Boss sign-off", status: "pending", after: [4], wait: { on: "boss", until: "2026-11-27T14:00:00.000Z" } },
		],
	});
	assert.equal(deriveBoard({ name: "MP-1", todos: [todo(1, "a", "completed")] })!.plan, undefined, "a finished list has no plan");
});

test("the plan is capped at PLAN.nodes; cut says how many open todos were left out, and a node blocked by a cut one still lists it", () => {
	const list = Array.from({ length: 26 }, (_, i) => todo(i + 1, `step ${i + 1}`, "pending", i ? { blockedBy: [i] } : {}));
	list.push(todo(40, "late", "pending", { blockedBy: [25] }));
	const plan = deriveBoard({ name: "n", todos: list })!.plan!;
	assert.equal(plan.nodes.length, PLAN.nodes);
	assert.equal(plan.cut, 27 - PLAN.nodes);
	assert.deepEqual(plan.nodes.map((n) => n.id), Array.from({ length: PLAN.nodes }, (_, i) => i + 1));
	const many = deriveBoard({ name: "n", todos: [todo(99, "join", "in_progress", { blockedBy: Array.from({ length: 30 }, (_, i) => 30 - i) }), ...Array.from({ length: 30 }, (_, i) => todo(i + 1, `x${i}`, "pending"))] })!.plan!;
	const join = many.nodes.find((n) => n.id === 99)!;
	assert.equal(join.after!.length, PLAN.after, "a node's blockers are capped");
	assert.deepEqual(join.after!.slice(0, 19).sort((a, b) => a - b), Array.from({ length: 19 }, (_, i) => i + 1), "the shown blockers come first, so the cap never drops one that places the node");
	const fanIn = deriveBoard({ name: "n", todos: [...Array.from({ length: 9 }, (_, i) => todo(i + 1, `p${i}`, "pending", i === 8 ? { blockedBy: [10] } : {})), todo(10, "first", "in_progress"), todo(11, "merge", "pending", { blockedBy: [1, 2, 3, 4, 5, 6, 7, 8, 9] })] })!.plan!;
	assert.deepEqual(fanIn.nodes.find((n) => n.id === 11)!.after, [1, 2, 3, 4, 5, 6, 7, 8, 9], "a fan-in's ninth predecessor stays: the merge sits below the deepest");
});

test("the plan's text goes through the board's scrub: paths outside the project, secrets, and addresses never leave; a mostly hidden subject is a hidden node", () => {
	const plan = deriveBoard({ name: "n", root: ROOT, todos: [
		todo(1, "edit /work/app/src/a.ts and ~/.ssh/id_rsa", "in_progress", { owner: "me@example.com", waitsOn: "ghp_abcdefghijklmnopqrstuvwx" }),
		todo(2, "ghp_abcdefghijklmnopqrstuvwx sk-abcdefghijklmn", "pending"),
	] })!.plan!;
	assert.equal(plan.nodes[0]!.t, "edit src/a.ts and …");
	assert.equal(plan.nodes[0]!.owner, "…");
	assert.equal(plan.nodes[0]!.wait!.on, "…");
	assert.equal(plan.nodes[1]!.t, "…", "the node stays, its text does not");
	assert.ok(!JSON.stringify(plan).includes("ghp_") && !JSON.stringify(plan).includes("example.com"));
});

test("todosOf reads the defer from metadata.waitsOn and metadata.until; an until that is no date is left out", () => {
	const list = todosOf({ nextId: 4, tasks: [
		{ id: 1, subject: "wait", status: "pending", metadata: { waitsOn: "  boss  ", until: "2026-11-27T14:00:00+08:00" } },
		{ id: 2, subject: "bad", status: "pending", metadata: { waitsOn: 7, until: "tomorrow-ish" } },
		{ id: 3, subject: "none", status: "pending" },
	] })!;
	assert.deepEqual([list[0]!.waitsOn, list[0]!.until], ["boss", "2026-11-27T06:00:00.000Z"]);
	assert.deepEqual([list[1]!.waitsOn, list[1]!.until, list[2]!.waitsOn], [undefined, undefined, undefined]);
});

test("todosOf keeps a todo's open blockers before it caps the ids at 50: 50 done ones and a 51st still open leave it blocked on the plan and out of capacity's ready", () => {
	const done = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, subject: `done ${i + 1}`, status: "completed" }));
	const list = todosOf({ nextId: 101, tasks: [...done, { id: 51, subject: "still open", status: "in_progress" }, { id: 100, subject: "join", status: "pending", blockedBy: Array.from({ length: 51 }, (_, i) => i + 1) }] })!;
	assert.equal(list.find((t) => t.id === 100)!.blockedBy!.length, 50, "still capped at 50");
	assert.ok(list.find((t) => t.id === 100)!.blockedBy!.includes(51), "the open blocker survives the cap");
	assert.deepEqual(deriveBoard({ name: "n", todos: list })!.plan!.nodes.find((n) => n.id === 100)!.after, [51]);
	assert.deepEqual(capOfTodos(list).ready, [], "a todo that waits on an open one is not ready");
});

test("the file carries the plan for an auto entry only; a board_set entry never does, and the reader cuts a hostile plan again", () => {
	const dir = dirOf();
	try {
		const d = deriveBoard({ name: "n", todos: [todo(1, "a", "in_progress"), todo(2, "b", "pending", { blockedBy: [1] })] })!;
		writeEntry(dir, "s-auto", d.text, NOW, { src: "todo", plan: d.plan! });
		writeEntry(dir, "s-set", { now: "by hand", items: [] }, NOW, { src: "set", plan: d.plan! });
		const read = new Map(readEntries(dir).map((e) => [e.session, e]));
		assert.deepEqual(read.get("s-auto")!.plan, d.plan);
		assert.equal(read.get("s-set")!.plan, undefined);
		assert.equal(JSON.parse(readFileSync(join(dir, "s-set.json"), "utf8")).plan, undefined);
		// A file another process wrote: too many nodes, bad fields, controls, a free-text until.
		const nodes = Array.from({ length: 40 }, (_, i) => ({ id: i, t: `n‮${i}`, status: i === 3 ? "completed" : "pending", owner: "x".repeat(99), after: [1, 1, -2, 1.5, "3"], wait: { on: "boss", until: "<b>soon</b>" } }));
		writeFileSync(join(dir, "s-bad.json"), JSON.stringify({ v: 1, session: "s-bad", updated: NOW, now: "x", items: [], src: "todo", plan: { nodes, graph: "star", cut: -1, extra: "x" } }));
		const bad = readEntries(dir).find((e) => e.session === "s-bad")!.plan!;
		assert.equal(bad.nodes.length, PLAN.nodes - 1, "cut to the cap first, then the completed node left out");
		assert.deepEqual(bad.nodes[0], { id: 0, t: "n0", status: "pending", owner: "x".repeat(PLAN.label), after: [1], wait: { on: "boss" } });
		assert.deepEqual(Object.keys(bad), ["nodes"], "no unknown graph, no negative cut, no extra field");
		assert.equal(cleanPlan({ nodes: [] }), undefined);
		assert.equal(cleanPlan("plan"), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("old and new builds read each other: a file without a plan is a checklist row; a file with one keeps every field an older reader checks, and v stays 1", () => {
	const dir = dirOf();
	try {
		writeFileSync(join(dir, "s-old.json"), JSON.stringify({ v: 1, session: "s-old", updated: NOW, now: "n: a", items: [{ t: "a", done: false }], src: "todo", count: { done: 0, total: 1 }, who: "n" }));
		const d = deriveBoard({ name: "n", todos: [todo(1, "a", "in_progress")] })!;
		writeEntry(dir, "s-new", d.text, NOW, { src: "todo", plan: d.plan!, ...(d.count ? { count: d.count } : {}) });
		const raw = JSON.parse(readFileSync(join(dir, "s-new.json"), "utf8"));
		assert.equal(raw.v, 1);
		assert.deepEqual([typeof raw.updated, typeof raw.now, Array.isArray(raw.items), raw.session], ["number", "string", true, "s-new"], "the fields an older reader requires");
		const mains = [{ session: "s-old", name: "old", workspaceId: "w", workspace: "W", tab: "t", state: "working" }, { session: "s-new", name: "new", workspaceId: "w", workspace: "W", tab: "t", state: "working" }];
		const rows = new Map(boardRows(readEntries(dir), mains, NOW).map((r) => [r.session, r]));
		assert.equal(rows.get("s-old")!.plan, undefined, "an older main's line: the page shows its checklist");
		assert.deepEqual(rows.get("s-old")!.items, [{ t: "a", done: false }]);
		assert.deepEqual(rows.get("s-new")!.plan, d.plan, "a newer main's line carries its plan to the page");
		// An older main's own line after an upgrade: it said what the list says, but has no plan, so the auto-fill writes it again.
		const old = readEntries(dir).find((e) => e.session === "s-old")!, derived = deriveBoard({ name: "n", todos: [todo(1, "a", "in_progress")] })!;
		assert.deepEqual(seedBoard({ own: old, derived, key: "k", withdrawn: undefined }), {});
		assert.deepEqual(seedBoard({ own: readEntries(dir).find((e) => e.session === "s-new")!, derived, key: "k", withdrawn: undefined }), { last: "k" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("allies get no plan: an auto entry leaves as the name and count only, whatever its plan says", () => {
	const d = deriveBoard({ name: "MP-1", todos: [todo(1, "secret customer work", "in_progress", { owner: "w" })] })!;
	const shown = forAllies({ ...d.text, src: "todo", ...(d.count ? { count: d.count } : {}), who: d.who, plan: d.plan } as Parameters<typeof forAllies>[0]);
	assert.deepEqual(shown, { now: "MP-1 (0/1)", items: [] });
});
