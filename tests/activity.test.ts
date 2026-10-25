import assert from "node:assert/strict";
import { test } from "node:test";
import { TICKS, trackActivity, WINDOW_MS } from "../src/activity.ts";
import { todoOfBranch, todoOk } from "../src/todo.ts";
import type { Mark } from "../src/dashboard.ts";
import type { Net, Unit } from "../src/net.ts";

const unit = (key: string, mark: Mark, note?: string, subs: Unit[] = []): Unit => ({ id: key, key, control: true, name: `${key}-name`, role: "main", mark, ...(note && { note }), subs });
const net = (units: Unit[], outposts: Net["bases"][number]["outposts"] = []): Net => ({ bases: [{ id: "wA", label: "Alpha", mark: "idle", head: true, tower: null, tabs: [{ id: "t1", label: "1", units }], outposts, outside: [] }] });
const first = (n: Net) => n.bases[0]!.tabs[0]!.units[0]!;

test("the first reading has no events and no start times: its units were there before it", () => {
	let at = 1000;
	const track = trackActivity(() => at);
	const seen = track(net([unit("a", "working", "tool:edit")]));
	assert.equal(seen.events, undefined);
	assert.deepEqual([first(seen).since, first(seen).ticks], [undefined, undefined]);
	at = 2000;
	const again = track(net([unit("a", "working", "tool:edit")]));
	assert.deepEqual([again.events, first(again).since], [undefined, undefined], "nothing changed: nothing to tell");
});

test("a new state starts the clock, takes a tick, and is an event; a new note while in it is a tick only", () => {
	let at = 1000;
	const track = trackActivity(() => at);
	track(net([unit("a", "working", "tool:edit")]));
	at = 2000;
	const bash = track(net([unit("a", "working", "tool:bash")]));
	assert.deepEqual([first(bash).since, first(bash).ticks, bash.events], [undefined, [{ at: 2000, mark: "working" }], undefined]);
	at = 3000;
	const waits = track(net([unit("a", "waiting", "waiting on a question")]));
	assert.equal(first(waits).since, 3000);
	assert.deepEqual(first(waits).ticks, [{ at: 2000, mark: "working" }, { at: 3000, mark: "waiting" }]);
	assert.deepEqual(waits.events, [{ at: 3000, ws: "wA", key: "a", name: "a-name", mark: "waiting", kind: "mark" }]);
	at = 4000;
	assert.equal(first(track(net([unit("a", "waiting", "waiting on a question")]))).since, 3000, "the clock runs from the change");
});

test("a unit that joins after the first reading starts its clock then; one that goes is an event; subagents and outposts count", () => {
	let at = 1000;
	const track = trackActivity(() => at);
	track(net([unit("a", "idle")]));
	at = 2000;
	const joined = track(net([unit("a", "idle", undefined, [{ ...unit("s", "working"), role: "subagent" }])], [{ id: "wA2", label: "Alpha feature", mark: "working" }]));
	assert.equal(first(joined).subs[0]!.since, 2000);
	assert.equal(joined.bases[0]!.outposts[0]!.since, 2000);
	assert.deepEqual(joined.events?.map((e) => [e.kind, e.key, e.name]), [["joined", "s", "s-name"], ["joined", undefined, "Alpha feature"]]);
	at = 3000;
	const left = track(net([unit("a", "idle")]));
	assert.deepEqual(left.events?.slice(2).map((e) => [e.kind, e.name, e.at]), [["left", "s-name", 3000], ["left", "Alpha feature", 3000]]);
});

test("ticks keep the newest few, and events only the last 30 minutes", () => {
	let at = 0;
	const track = trackActivity(() => at);
	track(net([unit("a", "working", "tool:n0")]));
	for (let i = 1; i <= TICKS + 3; i++) ((at = i * 1000), track(net([unit("a", "working", `tool:n${i}`)])));
	const ticks = first(track(net([unit("a", "working", `tool:n${TICKS + 3}`)]))).ticks!;
	assert.equal(ticks.length, TICKS);
	assert.equal(ticks.at(-1)!.at, (TICKS + 3) * 1000);
	at = 100_000;
	track(net([unit("a", "error")]));
	at += WINDOW_MS + 1;
	assert.equal(track(net([unit("a", "error")])).events, undefined, "the error is older than the window");
});

test("the todo summary follows rpiv-todo's replay: state entries win over tool results, and the task in progress names itself", () => {
	const snapshot = (tasks: { id: number; subject: string; status: string; activeForm?: string }[]) => ({ tasks, nextId: tasks.length + 1 });
	const result = { type: "message", message: { role: "toolResult", toolName: "todo", details: snapshot([{ id: 1, subject: "old", status: "pending" }]) } };
	assert.deepEqual(todoOfBranch([result]), { done: 0, total: 1 });
	const entry = { type: "custom", customType: "rpiv-todo-state", data: snapshot([{ id: 1, subject: "Write tests", status: "completed" }, { id: 2, subject: "Fix rounding", status: "in_progress", activeForm: "Fixing the\nrounding" }, { id: 3, subject: "Ship", status: "pending" }]) };
	assert.deepEqual(todoOfBranch([entry, result]), { done: 1, total: 3, now: "Fixing the rounding" }, "a later tool result does not override a state entry");
	assert.equal(todoOfBranch([{ type: "custom", customType: "rpiv-todo-state", data: snapshot([]) }]), undefined, "an emptied list is none");
	assert.equal(todoOfBranch([{ type: "custom", customType: "rpiv-todo-state", data: { tasks: "x" } }]), undefined);
	assert.ok(todoOk(todoOfBranch([entry])));
});
