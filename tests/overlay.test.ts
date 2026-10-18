import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mark } from "../src/dashboard.ts";
import type { Net } from "../src/net.ts";
import { type Alert, alertsOf, arrivals } from "../gui/alerts.ts";
import { createStack, tally } from "../gui/overlay.ts";
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
	stack.close("later");
	assert.deepEqual([page.shown, page.queued, page.focus], [[], ["a", "b"], "page"]);
});

test("Later requeues an alert only while its unit still shows the state that raised it; one that moved on is stale and dropped", () => {
	const { page, stack } = harness();
	stack.arrive(alert("a", "waiting", 1));
	stack.next();
	stack.prune((key) => (key === "a" ? alert("a", "working", 5) : undefined));
	assert.equal(stack.open[0]!.mark, "working", "the open dialog shows the unit's current state");
	stack.close("later");
	assert.deepEqual([page.shown, page.queued], [[], []], "not requeued as a plain working state");
	stack.arrive(alert("b", "error", 2));
	stack.next();
	stack.arrive(alert("b", "waiting", 6));
	stack.close("later");
	assert.deepEqual(stack.queue.map((q) => [q.key, q.mark]), [["b", "waiting"]], "a new alert while open is what Later keeps");
});

test("Open comms closes the alert and reveals nothing queued over the comms the user is going to", () => {
	const { page, stack } = harness();
	stack.arrive(alert("e", "error", 1));
	stack.arrive(alert("a", "waiting", 2));
	stack.next();
	assert.deepEqual([page.shown, page.queued], [["e"], ["a"]]);
	stack.close("go");
	assert.deepEqual([page.shown, page.queued, page.focus], [[], ["a"], "page"], "the question stays queued, focus returns to where it was");
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

test("a tile hears when it closes, by its × or pushed out by a fifth, once, and not when it is opened again", () => {
	const { model } = tiles(), closed: string[] = [], watched = (id: string): Tile => ({ ...tile(id), closed: () => closed.push(id) });
	for (const id of ["a", "b", "c", "d"]) model.open(watched(id));
	model.open(watched("a"));
	assert.deepEqual(closed, [], "opening an open tile again closes nothing");
	model.close("b");
	model.close("b");
	model.open(watched("e"));
	model.open(watched("f"));
	assert.deepEqual(closed, ["b", "a"], "the terminal tile detaches its mirror on either");
});

test("a tile that arrives on its own never pushes out one the user opened: with four open it is refused, and hears so", () => {
	const { page, model } = tiles(), closed: string[] = [], watched = (id: string): Tile => ({ ...tile(id), closed: () => closed.push(id) });
	for (const id of ["term", "a", "b"]) model.open(watched(id));
	model.open(watched("doc1"), false);
	model.open(watched("doc2"), false);
	assert.deepEqual([page.tiles, page.active, closed], [["term", "a", "b", "doc1"], "b", ["doc2"]]);
	model.open(watched("doc1"), false);
	assert.deepEqual(closed, ["doc2"], "one already open is not refused");
});

test("an alert dialog tells the last assistant line and the tool call still open", () => {
	assert.deepEqual(intel([
		{ id: "1", kind: "assistant", text: "first\nI will ask now.", tools: [{ id: "c1", name: "bash", summary: "ls" }] },
		{ id: "2", kind: "result", callId: "c1" },
		{ id: "3", kind: "assistant", text: "", tools: [{ id: "c2", name: "ask_user", summary: "Which deploy window?" }] },
	]), { said: "I will ask now.", pending: "ask_user · Which deploy window?", at: "3" }, "the alert is about the reply with the open call");
	assert.deepEqual(intel([{ id: "u", kind: "user", text: "go" }, { id: "a", kind: "assistant", text: "failed" }, { id: "n", kind: "notice", text: "x" }]).at, "a", "else the last reply");
	assert.deepEqual(intel([{ id: "u", kind: "user", text: "go" }, { id: "r", kind: "result", callId: "c" }]).at, "u", "else the last entry that shows on its own");
	assert.deepEqual(intel([]), { said: undefined, pending: undefined, at: undefined });
});

test("a dialog the user did not open slides in beneath the one they read, takes no focus, and comes up when the top one closes", () => {
	const { page, stack } = harness();
	stack.show(alert("a", "waiting", 1));
	stack.show(alert("b", "error", 2), false);
	assert.deepEqual([page.shown, page.focus, page.entered], [["b", "a"], "dialog:a", ["a"]], "beneath the top dialog, focus stays where the user reads");
	stack.show(alert("a", "waiting", 1), false);
	assert.deepEqual(page.shown, ["b", "a"], "one already open stays where it is");
	stack.close();
	assert.deepEqual([page.shown, page.focus], [["b"], "page"], "closing the top reveals it");
	stack.show(alert("c", "waiting", 3));
	assert.deepEqual([page.shown, page.focus], [["b", "c"], "dialog:c"], "an explicit open still goes on top");
	stack.raise("b");
	assert.deepEqual([page.shown, page.focus], [["c", "b"], "dialog:b"], "a click on the dialog peeking out beneath brings it up");
	stack.raise("b");
	assert.deepEqual(page.shown, ["c", "b"], "raising the top one changes nothing");
	const empty = harness();
	empty.stack.show(alert("d", "waiting", 4), false);
	assert.deepEqual([empty.page.shown, empty.page.focus], [["d"], "page"], "with nothing open it covers nothing, and still takes no focus");
});

test("an alert carries the question its unit waits on, and an open dialog drops it once the unit stops waiting", () => {
	const pending = { callId: "c1", tool: "ask_user", ask: { question: "Ship it?", options: [{ title: "yes" }], multiple: false, freeform: false } };
	const net = (mark: Mark, p?: typeof pending): Net => ({ bases: [{ id: "w1", label: "w", mark, head: true, tower: null, outposts: [], outside: [], tabs: [{ id: "t", label: "t", units: [{ id: "a", key: "a", control: true, name: "a", role: "main", mark, subs: [], pending: p }] }] }] });
	const { stack } = harness();
	stack.show(alertsOf(net("waiting", pending), 1).get("a")!);
	assert.equal(stack.open[0]!.pending?.callId, "c1");
	const now = alertsOf(net("working"), 2);
	stack.prune((key) => now.get(key));
	assert.equal(stack.open[0]!.pending, undefined, "the refreshed dialog no longer shows the question");
});

test("the queue count says what is in it: one session waiting beside a unit that only finished reads as 1 needs you and 1 finished, never as two questions", () => {
	const { page, stack } = harness();
	const queue = () => stack.queue;
	// The live check: a dialog is open for one session, another asks a question, and a subagent finished earlier.
	stack.arrive(alert("scout", "done", 1));
	stack.show(alert("p2", "waiting", 2));
	stack.arrive(alert("p1", "waiting", 3));
	assert.deepEqual(page.queued, ["p1", "scout"]);
	assert.equal(tally(queue()), "1 needs you · 1 finished");
	assert.equal(tally(queue().slice(0, 1)), "1 needs you");
	assert.equal(tally(queue().slice(1)), "1 finished");
	assert.equal(tally([alert("a", "waiting", 1), alert("b", "error", 2), alert("c", "done", 3), alert("d", "done", 4)]), "2 need you · 2 finished");
	assert.equal(tally([]), "");
	// What the count promises is what the queue holds: every counted unit is a distinct alert that still shows its state, and none is the open dialog's own.
	stack.prune((key) => ({ p1: alert("p1", "waiting", 3), p2: alert("p2", "waiting", 2), scout: alert("scout", "done", 1) })[key]);
	assert.deepEqual(queue().map((a) => a.key), ["p1", "scout"]);
	stack.prune((key) => ({ p2: alert("p2", "waiting", 2), scout: alert("scout", "done", 1) })[key]);
	assert.equal(tally(queue()), "1 finished", "a question that was answered leaves the count at once");
});

test("a dialog whose unit left the net stays open without its question or actions, and shows the unit again if it comes back", () => {
	const { page, stack } = harness();
	const waiting = { ...alert("a", "waiting", 1), pending: { callId: "c1", tool: "ask_user", why: "It waits on a dialog." }, note: "waiting on a question" };
	stack.show(waiting);
	stack.prune(() => waiting);
	assert.deepEqual([stack.open[0]!.gone, stack.open[0]!.mark, stack.open[0]!.pending?.callId], [undefined, "waiting", "c1"]);
	stack.prune(() => undefined);
	assert.deepEqual([page.shown, stack.open[0]!.gone, stack.open[0]!.mark, stack.open[0]!.pending, stack.open[0]!.note], [["a"], true, "unknown", undefined, undefined], "never closed under the user");
	stack.prune(() => waiting);
	assert.deepEqual([stack.open[0]!.gone, stack.open[0]!.mark, stack.open[0]!.pending?.callId], [undefined, "waiting", "c1"], "a unit that is back shows again");
	stack.prune(() => undefined);
	stack.close("later");
	assert.deepEqual([page.shown, page.queued], [[], []], "Later on a gone unit does not put it back in the queue");
});

test("redraw draws the same models again, so the page can follow the stream state without waiting for a snapshot", () => {
	let draws = 0;
	const stack = createStack<string>({ render: () => draws++, enter() {}, focused: () => undefined, restore: () => true });
	stack.show(alert("a", "waiting", 1));
	const before = draws;
	stack.redraw();
	assert.equal(draws, before + 1);
});
