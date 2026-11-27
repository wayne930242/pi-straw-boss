import assert from "node:assert/strict";
import { test } from "node:test";
import type { Base, Net, Unit } from "../src/net.ts";
import { sliceNet } from "../src/operateslice.ts";
import { scopeOf, unit, world } from "./operate-world.ts";

// docs/specs/2026-11-07-link-operate.md §6.2: the box filters its net down to the session's scope before anything leaves it.

const doc = { cap: "c1", display: "plan.md", kind: "text" as const, reason: "r", revision: 1, onScreen: false };
const tower = (key: string, over: Record<string, unknown> = {}) => ({ name: "tower", mark: "idle" as const, key, control: true, subs: [] as Unit[], docs: [doc], ...over });
/** A base the box's tower stands in, holding units of two teams (a-*, b-*), the box's own (box-*), a subagent under each of a-1 and b-1, an outpost, and an outside pane. */
const net = (): Net => ({
	bases: [{
		id: "w1", label: "work", mark: "waiting", tower: tower("tw", { subs: [unit("box-sub", { role: "subagent" })], service: { state: "standing", queued: 0, allyRuns: [{ id: "r1", device: "d", label: "run", startedAt: "t", key: "ally-r1" }], notices: [], parked: [] } }) as Base["tower"],
		tabs: [
			{ id: "t1", label: "a", units: [unit("a-1", { docs: [doc], docsCut: true, mark: "working", subs: [unit("a-sub", { role: "subagent" }), unit("b-sub", { role: "subagent" })] }), unit("a-2", { role: "member", queued: [{ text: "later", as: "followUp" }] })] },
			{ id: "t2", label: "b", units: [unit("b-1", { mark: "waiting", subs: [unit("b-sub2", { role: "subagent" })] })] },
			{ id: "t3", label: "box", units: [unit("box-1")] },
		],
		outposts: [{ id: "x1", label: "sub", mark: "working" }], outside: [unit("out-a", { role: "outside" }), unit("out-box", { role: "outside" })],
	}, {
		id: "w2", label: "other", mark: "working", tower: tower("tw2") as Base["tower"], tabs: [{ id: "t4", label: "b", units: [unit("b-2")] }], outposts: [], outside: [],
	}],
	head: { key: "hd" } as unknown as Net["head"], stashed: [{ name: "s" }] as unknown as Net["stashed"], trust: [{ id: "t" }] as unknown as Net["trust"], link: { teams: [] } as unknown as Net["link"],
	events: [{ at: 1, ws: "w1", key: "a-1", name: "a-1", mark: "idle", kind: "joined" }, { at: 2, ws: "w1", key: "b-1", name: "b-1", mark: "idle", kind: "joined" }, { at: 3, ws: "w1", name: "sub", mark: "idle", kind: "joined" }, { at: 4, ws: "w1", key: "tw", name: "tower", mark: "idle", kind: "mark" }],
});
const A = ["a-1", "a-2", "a-sub", "out-a"];
const keysOf = (n: Net) => n.bases.flatMap((b) => [...(b.tower ? [b.tower.key, ...b.tower.subs.map((s) => s.key)] : []), ...b.tabs.flatMap((t) => t.units.flatMap((u) => [u.key, ...u.subs.map((s) => s.key)])), ...b.outside.map((u) => u.key)]);

test("a team's session sees its own units only: the other team's units, and the box's tower, subagents and outpost, never leave", () => {
	const out = sliceNet(net(), scopeOf(A));
	assert.deepEqual(keysOf(out), ["a-1", "a-sub", "a-2", "out-a"], "b-sub (under a-1) and every b-* and box-* unit are gone");
	assert.equal(out.bases.length, 1, "the other workspace holds nothing in scope");
	assert.deepEqual(out.bases[0]!.tabs.map((t) => t.id), ["t1"], "a tab with no unit in scope is dropped");
	assert.equal(out.bases[0]!.tower, null, "the box's tower is not in scope: tower null, the tabs stay");
	assert.deepEqual(out.bases[0]!.outposts, [], "an outpost belongs to nobody: the box part only");
});

test("what is not the session's never travels: link, stashed, trust, head, other units' events, every document's capability", () => {
	const out = sliceNet(net(), scopeOf(A));
	for (const field of ["link", "stashed", "trust", "head"]) assert.equal(field in out, false, field);
	assert.deepEqual(out.events?.map((e) => e.key), ["a-1"], "events of units out of scope, and of an outpost, are gone");
	const a1 = out.bases[0]!.tabs[0]!.units[0]!;
	assert.deepEqual([a1.docs, a1.docsCut], [[{ display: "plan.md", kind: "text", reason: "r", revision: 1, onScreen: false }], true], "decision 12: the names stay, `cap` never leaves");
	assert.deepEqual(out.bases[0]!.tabs[0]!.units[1]!.queued, [{ text: "later", as: "followUp" }], "queued messages, todos, monitors of an in-scope unit stay");
	assert.equal(JSON.stringify(out).includes('"cap"'), false, "no capability anywhere");
});

test("the Asks never cross: neither the net's list nor a unit's, a subagent's or a tower's count (asks-r3-F002)", () => {
	const input = net(), b = input.bases[0]!;
	input.asks = [{ id: "k1", n: 1, kind: "boss", subject: "Deploy?", asker: "a-1", where: "work", since: 1, ws: "w1", unit: "a-1" }] as Net["asks"];
	(b.tower!.asks = 2), (b.tower!.subs[0]!.asks = 1), (b.tabs[0]!.units[0]!.asks = 1), (b.tabs[0]!.units[0]!.subs[0]!.asks = 1), (b.outside[0]!.asks = 1);
	for (const out of [sliceNet(input, scopeOf(A)), sliceNet(input, scopeOf(["tw", "box-sub", "out-a"], true))]) {
		assert.equal("asks" in out, false, "the list");
		assert.equal(JSON.stringify(out).includes('"asks"'), false, "no count anywhere");
	}
	assert.equal(b.tabs[0]!.units[0]!.asks, 1, "the input net keeps its counts");
});

test("the box part: with `box` the box's tower and its outpost stay, the tower with its document names and no capability", () => {
	const out = sliceNet(net(), scopeOf(["tw", "tw2", "box-sub", "box-1", "out-box"], true));
	assert.deepEqual(keysOf(out), ["tw", "box-sub", "box-1", "out-box", "tw2"], "both towers, whatever workspace");
	assert.equal(out.bases.length, 2);
	assert.deepEqual(out.bases[0]!.outposts.map((o) => o.id), ["x1"]);
	assert.deepEqual(out.bases[0]!.tower!.docs, [{ display: "plan.md", kind: "text", reason: "r", revision: 1, onScreen: false }]);
	assert.deepEqual(out.bases[0]!.tower!.service?.allyRuns.map((r) => r.id), ["r1"], "the box owner sees its tower's runs");
	assert.deepEqual(out.events?.map((e) => e.key ?? "-"), ["-", "tw"], "events of the box's units, and of an outpost");
});

test("a base's mark is recomputed from what is left: the other team's waiting unit does not show through", () => {
	const out = sliceNet(net(), scopeOf(["b-1", "b-sub2"]));
	assert.equal(out.bases[0]!.mark, "waiting", "b-1 waits");
	const a = sliceNet(net(), scopeOf(["a-2"]));
	assert.notEqual(a.bases[0]!.mark, "waiting", "a-2 is idle; b-1's wait (the base's mark in the full net) stays behind");
	assert.notEqual(a.bases[0]!.mark, "working");
});

test("an empty scope leaves an empty net, and the input net is not changed", () => {
	const input = net(), before = JSON.stringify(input);
	assert.deepEqual(sliceNet(input, scopeOf([])), { bases: [] });
	sliceNet(input, scopeOf(A));
	assert.equal(JSON.stringify(input), before);
});

test("a subagent is shown only when its own key is in scope, under a unit that is", () => {
	const out = sliceNet(net(), scopeOf(["a-sub", "b-sub", "b-1"]));
	assert.deepEqual(keysOf(out), ["b-1"], "a-sub's parent a-1 is out of scope, so is everything under it; b-1 is in");
});

test("the snapshot of a running server is the sliced net: gui.operate.snapshot(scope)", async () => {
	const x = await world();
	const snap = await x.operate.snapshot(scopeOf(["sess-1"]));
	assert.deepEqual(keysOf(snap), ["sess-1", "sess-1"], "t1 and t3 each hold sess-1; other-1 is out of scope");
	assert.deepEqual(snap.bases[0]!.tabs.map((t) => t.id), ["t1", "t3"]);
	const heard: number[] = [];
	const off = x.operate.changed(() => void heard.push(1));
	assert.equal(typeof off, "function");
	off();
});
