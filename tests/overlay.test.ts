import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mark } from "../src/dashboard.ts";
import type { Net } from "../src/net.ts";
import { type Alert, alertsOf, arrivals } from "../gui/alerts.ts";
import { createStack } from "../gui/overlay.ts";
import { createTiles, intel, MAX_TILES, type Tile } from "../gui/layer.ts";

const alert = (key: string, mark: Mark, at: number): Alert => ({ key, ws: "w1", name: key, role: "main", mark, at });
/** A stack with a fake page: `focus` is where focus is now, `entered` the dialogs focus moved into, `shown` the open dialogs. */
function harness() {
	const page = { focus: "page" as string | undefined, entered: [] as string[], restored: [] as (string | undefined)[], shown: [] as string[], queued: [] as string[] };
	const stack = createStack<string>({
		render: (open, queue) => ((page.shown = open.map((a) => a.key)), (page.queued = queue.map((a) => a.key))),
		enter: (a) => (page.entered.push(a.key), (page.focus = `dialog:${a.key}`)),
		focused: () => page.focus,
		restore: (target) => (page.restored.push(target), (page.focus = target), target !== undefined),
	});
	return { page, stack };
}

test("an alert that arrives while a dialog is open queues behind it: the open dialog keeps its place and focus", () => {
	const { page, stack } = harness();
	stack.show(alert("a", "waiting", 1));
	assert.deepEqual([page.shown, page.focus], [["a"], "dialog:a"]);
	stack.arrive(alert("b", "waiting", 2));
	stack.arrive(alert("c", "error", 3));
	assert.deepEqual([page.shown, page.queued, page.focus, page.entered], [["a"], ["b", "c"], "dialog:a", ["a"]], "nothing opened on top, focus did not move");
	stack.arrive(alert("a", "error", 4));
	assert.deepEqual([page.shown, page.queued, stack.open[0]!.mark], [["a"], ["b", "c"], "error"], "a unit already open refreshes its dialog instead of queueing");
});

test("questions and errors queue ahead of plain state changes, oldest first in each", () => {
	const { page, stack } = harness();
	stack.arrive(alert("done1", "done", 1));
	stack.arrive(alert("q2", "waiting", 5));
	stack.arrive(alert("e1", "error", 3));
	stack.arrive(alert("done0", "done", 0));
	assert.deepEqual(page.queued, ["e1", "q2", "done0", "done1"]);
	stack.arrive(alert("e1", "error", 9));
	assert.deepEqual(page.queued, ["e1", "q2", "done0", "done1"], "a repeated arrival keeps its place");
});

test("closing reveals the dialog beneath; with none beneath, the next queued question; plain state changes wait for the user", () => {
	const { page, stack } = harness();
	stack.show(alert("a", "waiting", 1));
	stack.show(alert("b", "waiting", 2));
	stack.arrive(alert("q", "waiting", 3));
	stack.arrive(alert("f", "done", 4));
	assert.deepEqual(page.shown, ["a", "b"]);
	assert.equal(stack.close(), true);
	assert.deepEqual([page.shown, page.queued], [["a"], ["q", "f"]], "the dialog beneath comes back, the queue stays queued");
	stack.close();
	assert.deepEqual([page.shown, page.queued], [["q"], ["f"]], "the question that waited behind it shows next");
	stack.close();
	assert.deepEqual([page.shown, page.queued], [[], ["f"]], "a plain state change does not open by itself");
	assert.equal(stack.close(), false, "nothing left to close");
	stack.next();
	assert.deepEqual([page.shown, page.queued], [["f"], []], "the user opens it from the queue");
});

test("Later puts the alert back in the queue and reveals nothing queued", () => {
	const { page, stack } = harness();
	stack.arrive(alert("a", "waiting", 1));
	stack.arrive(alert("b", "waiting", 2));
	stack.next();
	stack.close(true);
	assert.deepEqual([page.shown, page.queued, page.focus], [[], ["a", "b"], "page"]);
});

test("Escape closes the top dialog only, and focus goes back to where it was before each one opened", () => {
	const { page, stack } = harness();
	page.focus = "unit-link";
	stack.show(alert("a", "waiting", 1));
	page.focus = "dialog:a:later-button";
	stack.show(alert("b", "error", 2));
	assert.deepEqual([page.shown, page.focus], [["a", "b"], "dialog:b"]);
	const escape = () => stack.close();
	escape();
	assert.deepEqual([page.shown, page.focus], [["a"], "dialog:a:later-button"], "one press closes one dialog, focus returns inside the one beneath");
	escape();
	assert.deepEqual([page.shown, page.focus], [[], "unit-link"], "and then to the page element that opened the first");
});

test("focus that cannot be restored moves into the dialog beneath", () => {
	const { page, stack } = harness();
	page.focus = undefined;
	stack.show(alert("a", "waiting", 1));
	page.focus = undefined;
	stack.show(alert("b", "waiting", 2));
	stack.close();
	assert.equal(page.focus, "dialog:a");
});

test("a dialog the user opens again comes to the top instead of opening twice, and leaves the queue", () => {
	const { page, stack } = harness();
	stack.arrive(alert("a", "waiting", 1));
	stack.show(alert("a", "waiting", 1));
	stack.show(alert("b", "waiting", 2));
	stack.show(alert("a", "waiting", 1));
	assert.deepEqual([page.shown, page.queued], [["b", "a"], []]);
});

test("a queued alert leaves the queue by itself once its unit no longer needs attention; an open dialog stays and shows the new state", () => {
	const { page, stack } = harness();
	stack.show(alert("open", "waiting", 0));
	stack.arrive(alert("q", "waiting", 1));
	stack.arrive(alert("gone", "error", 2));
	stack.arrive(alert("f", "done", 3));
	const now = new Map([["open", alert("open", "idle", 9)], ["q", alert("q", "working", 9)], ["f", alert("f", "done", 9)]]);
	stack.prune((key) => now.get(key));
	assert.deepEqual([page.shown, page.queued, stack.open[0]!.mark], [["open"], ["f"], "idle"]);
});

test("alerts come from towers, agents, subagents, and units outside the net; the first snapshot raises only questions and errors", () => {
	const net: Net = { bases: [{ id: "w1", label: "W", mark: "working", head: true, tower: { name: "tower", mark: "waiting", key: "t", control: true }, outposts: [], tabs: [{ id: "t1", label: "a", units: [{ id: "m", key: "m", control: true, name: "m", role: "main", mark: "idle", subs: [{ id: "s", key: "s", control: true, name: "s", role: "subagent", mark: "done", subs: [] }] }] }], outside: [{ id: "o", key: "o", control: true, name: "o", role: "outside", mark: "error", subs: [] }] }] };
	const first = alertsOf(net, 1);
	assert.deepEqual([...first.keys()].sort(), ["m", "o", "s", "t"]);
	assert.deepEqual(arrivals(undefined, first).map((a) => a.key).sort(), ["o", "t"], "a finished subagent at load is not news");
	net.bases[0]!.tabs[0]!.units[0]!.mark = "waiting";
	net.bases[0]!.tabs[0]!.units[0]!.subs[0]!.mark = "working";
	const second = alertsOf(net, 2);
	assert.deepEqual(arrivals(first, second).map((a) => a.key), ["m"]);
	net.bases[0]!.tabs[0]!.units[0]!.subs[0]!.mark = "done";
	assert.deepEqual(arrivals(second, alertsOf(net, 3)).map((a) => [a.key, a.mark]), [["s", "done"]], "a unit that finishes later raises a plain alert");
});

const tile = (id: string): Tile => ({ id, title: id, body: () => ({}) as HTMLElement });
function tiles() {
	const page = { tiles: [] as string[], active: undefined as string | undefined, entered: [] as string[] };
	const model = createTiles({ render: (list, active) => ((page.tiles = list.map((t) => t.id)), (page.active = active)), enter: (t) => page.entered.push(t.id) });
	return { page, model };
}

test("tiles open side by side; one that arrives on its own takes neither focus nor the active tab", () => {
	const { page, model } = tiles();
	model.open(tile("doc1"));
	assert.deepEqual([page.tiles, page.active, page.entered], [["doc1"], "doc1", ["doc1"]]);
	model.open(tile("doc2"), false);
	assert.deepEqual([page.tiles, page.active, page.entered], [["doc1", "doc2"], "doc1", ["doc1"]], "the arrival shows beside, focus and the active tab stay");
	model.open(tile("doc1"));
	assert.deepEqual(page.tiles, ["doc1", "doc2"], "an open document is not opened twice");
});

test("closing a tile activates its neighbour, and past four tiles the oldest closes", () => {
	const { page, model } = tiles();
	for (const id of ["a", "b", "c"]) model.open(tile(id));
	model.activate("b");
	model.close("b");
	assert.deepEqual([page.tiles, page.active], [["a", "c"], "c"]);
	model.close("c");
	assert.deepEqual([page.tiles, page.active], [["a"], "a"]);
	for (const id of ["b", "c", "d", "e"]) model.open(tile(id));
	assert.equal(page.tiles.length, MAX_TILES);
	assert.deepEqual(page.tiles, ["b", "c", "d", "e"]);
});

test("an alert dialog tells the last assistant line and the tool call still open", () => {
	assert.deepEqual(intel([
		{ id: "1", kind: "assistant", text: "first\nI will ask now.", tools: [{ id: "c1", name: "bash", summary: "ls" }] },
		{ id: "2", kind: "result", callId: "c1" },
		{ id: "3", kind: "assistant", text: "", tools: [{ id: "c2", name: "ask_user", summary: "Which deploy window?" }] },
	]), { said: "I will ask now.", pending: "ask_user · Which deploy window?" });
	assert.deepEqual(intel([]), { said: undefined, pending: undefined });
});
