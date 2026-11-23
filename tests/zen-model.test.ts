import assert from "node:assert/strict";
import { test } from "node:test";
import type { Mark } from "../src/netdata.ts";
import type { Net, Unit } from "../src/net.ts";
import { type Alert, alertsOf, ownOpenings } from "../gui/alerts.ts";
import type { BossCard } from "../gui/cardalerts.ts";
import { blocks, createZen, HOLD_MS, OUTCOME_MS, PAUSE_MS, REST_MS, type Screen } from "../gui/zenmodel.ts";

const al = (key: string, mark: Mark, since?: number, extra: Partial<Alert> = {}): Alert => ({ key, ws: "w", name: key, role: "main", mark, at: 0, since, ...extra });
const map = (...a: Alert[]) => new Map(a.map((x) => [x.key, x]));
const dlg = (digest: string) => ({ callId: "c", tool: "ask_user", answer: { dialog: "d", digest } });
/** No card takes the screen by itself (Z-D20): a test that wants one on the screen takes it, as Enter does (`z.take()`). */
function rig() {
	let t = 1_000_000;
	const z = createZen({ now: () => t });
	return { z, at: (ms: number) => (t += ms), now: () => t };
}
const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
const net = (units: Unit[], trust: Net["trust"] = []): Net => ({ bases: [{ id: "w", label: "w", mark: "idle", tower: { name: "tower", mark: "idle", key: "t", control: true, subs: [{ ...unit("sub", "waiting", { role: "subagent", since: 5 }) }] }, tabs: [{ id: "t1", label: "t", units }], outposts: [], outside: [] }], trust });

test("items are the rank 0 alerts: a waiting unit, a pending dialog, a tower's and a subagent's, a trust question; not an error, a failed monitor, a finished unit", () => {
	const n = net([unit("a", "waiting"), unit("b", "working", { pending: dlg("x") as never }), unit("e", "error"), unit("d", "done"), unit("m", "working", { monitors: [{ id: "1", status: "error", what: "w", at: 1 } as never] })], [{ id: "tr", digest: "g", folder: "/x/proj", found: [], agents: [{ pane: "p", role: "main", at: 7 }] }]);
	n.bases[0]!.tower!.mark = "waiting";
	const seen: string[] = [];
	for (let i = 0; i < 6; i++) {
		const { z, at } = rig(), all = alertsOf(n, 0);
		z.update(all);
		const r = z.take();
		assert.equal(r.screen.kind, "item");
		const order = [(r.screen as { item: Alert }).item.key];
		for (let k = 0; k < 5 + i; k++) { z.skip(); at(PAUSE_MS); z.tick(); const s = z.take().screen; if (s.kind !== "item") break; order.push(s.item.key); }
		seen.splice(0, seen.length, ...order);
	}
	assert.deepEqual([...seen].sort(), ["a", "b", `trust\u001f/x/proj\u001fg`, "sub", "t"].sort());
});

test("an own opening is no item", () => {
	const n = net([]);
	n.bases[0]!.tower!.subs = [];
	const { z } = rig();
	ownOpenings.add("o");
	assert.equal(z.update(alertsOf({ ...n, trust: [{ id: "tr", digest: "g", folder: "/x", found: [], agents: [], opening: "o" }] }, 0)).screen.kind, "companion");
});

test("the order: since, then first seen, then key; a trust question by its earliest agent", () => {
	const { z } = rig();
	z.update(map(al("c", "waiting", 30), al("b", "waiting", 10), al("a", "waiting", 10), al("n", "waiting")));
	assert.equal((z.take().screen as { item: Alert }).item.key, "a", "equal since goes by key; an item with no since is newest");
	const s = alertsOf({ bases: [], trust: [{ id: "t", digest: "d", folder: "/f", found: [], agents: [{ pane: "1", role: "m", at: 9 }, { pane: "2", role: "m", at: 4 }] }] }, 0);
	assert.equal([...s.values()][0]!.since, 4);
});

test("an item without since takes the time this page first saw it", () => {
	const { z, at } = rig();
	z.update(map(al("late", "waiting", 5_000_000)));
	z.take();
	z.accepted("late");
	at(OUTCOME_MS);
	z.tick();
	at(PAUSE_MS);
	z.update(map(al("zz", "waiting"), al("late2", "waiting", 5_000_000)));
	at(1);
	z.update(map(al("zz", "waiting"), al("late2", "waiting", 5_000_000), al("aa", "waiting")));
	const r = z.take();
	assert.equal((r.screen as { item: Alert }).item.key, "zz", "seen earlier than aa, older than late2's since? no: zz first seen now < 5e6, so it is older");
});

test("a current item is not replaced by an older arrival, which makes no sound and changes nothing visible", () => {
	const { z } = rig();
	z.update(map(al("b", "waiting", 20)));
	const first = z.take();
	assert.deepEqual([first.screen.kind, first.sound], ["item", "bowl"]);
	const r = z.update(map(al("b", "waiting", 20), al("a", "waiting", 1)));
	assert.deepEqual([JSON.stringify(r.screen), r.sound], [JSON.stringify(first.screen), undefined]);
});

test("the five exits: one sound at most; the boss's answer shows 1.2 s and then the pause, and a card whose question ended stays until the boss closes it (Z-D20)", () => {
	const exits: [string, (z: ReturnType<typeof rig>) => unknown, string | undefined, string][] = [
		["accepted", (r) => r.z.accepted("a"), "knock", "answered"],
		["stopped waiting", (r) => r.z.update(map(al("a", "working", 1))), "knock", "elsewhere"],
		["unit gone", (r) => r.z.update(map()), undefined, "gone"],
		["pane closed", (r) => r.z.update(map(al("a", "idle", 1, { closed: true }))), undefined, "gone"],
		["failed", (r) => r.z.update(map(al("a", "error", 1))), "low", "error"],
	];
	for (const [name, act, sound, outcome] of exits) {
		const r = rig();
		r.z.update(map(al("a", "waiting", 1)));
		r.z.take();
		const got = act(r) as { screen: { kind: string; outcome?: string }; sound?: string };
		assert.equal(got.sound, sound, name);
		assert.deepEqual([got.screen.kind, got.screen.outcome], ["item", outcome], name);
		r.at(OUTCOME_MS - 1);
		assert.equal(r.z.tick().screen.kind, "item", `${name}: the card holds 1.2 s`);
		r.at(1);
		assert.equal(r.z.tick().screen.kind, outcome === "answered" ? "pause" : "item", name);
		if (outcome !== "answered") {
			r.at(60 * 60_000);
			assert.equal(r.z.tick().screen.kind, "item", `${name}: and an hour later, until the boss closes it`);
			assert.equal(r.z.skip().screen.kind, "pause", name);
		}
	}
});

test("an error outcome keeps the card with the low bowl; the exit after it is silent", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.take();
	const bad = r.z.refused("a");
	assert.deepEqual([bad.screen.kind, bad.sound], ["item", "low"]);
	assert.equal(r.z.refused("a").sound, undefined, "one sound per thing the boss did");
	const gone = r.z.update(map(al("a", "working", 1)));
	assert.deepEqual([gone.screen.kind, gone.sound], ["item", undefined]);
	assert.equal((gone.screen as { outcome?: string }).outcome, "elsewhere");
});

test("a refusal then an accepted retry still knocks", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.take();
	r.z.refused("a");
	assert.equal(r.z.accepted("a").sound, "knock");
});

test("the pause lasts 3 s, then Zen rests; an item that arrived meanwhile takes the screen when the boss takes it, with the bowl", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.take();
	r.z.accepted("a");
	r.at(OUTCOME_MS);
	assert.equal(r.z.tick().screen.kind, "pause");
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2))); // b arrives during the pause: it waits for it (with b queued at the answer, Z-D22 takes it at once)
	r.at(PAUSE_MS - 1);
	assert.equal(r.z.tick().screen.kind, "pause");
	r.at(1);
	const rest = r.z.tick();
	assert.deepEqual([rest.screen.kind, rest.sound], ["companion", undefined], "the next one does not follow by itself");
	const next = r.z.take();
	assert.deepEqual([next.screen.kind, next.sound, (next.screen as { item: Alert }).item.key], ["item", "bowl", "b"]);
});

test("after an accepted answer the item stays down while its snapshot lingers, then the next comes by Enter", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	r.z.take();
	r.z.accepted("a");
	r.at(OUTCOME_MS);
	r.z.tick();
	r.at(PAUSE_MS);
	r.z.tick();
	const s = r.z.take();
	assert.equal((s.screen as { item: Alert }).item.key, "b");
});

test("a tap skips the pause; the last item leaves the companion silently", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.take();
	r.z.skip();
	assert.equal(r.z.tick().screen.kind, "pause");
	const t = r.z.tap();
	assert.deepEqual([t.screen.kind, t.sound], ["companion", undefined], "the rested lone item leaves the companion");
});

test("Not now rests 10 minutes, then the item is in the queue again; it does not take the screen by itself", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.take();
	assert.equal(r.z.skip().sound, undefined, "no sound for Not now");
	r.z.tap();
	r.at(REST_MS - 1);
	assert.equal(r.z.update(map(al("a", "waiting", 1))).screen.kind, "companion");
	assert.deepEqual(r.z.queued(), [], "still resting");
	assert.equal(r.z.due(), 1_000_000 + REST_MS);
	r.at(1);
	const back = r.z.tick();
	assert.deepEqual([back.screen.kind, back.sound, r.z.queued().map((a) => a.key)], ["companion", undefined, ["a"]]);
	const taken = r.z.take();
	assert.deepEqual([taken.screen.kind, taken.sound], ["item", "bowl"]);
});

test("a rest ends early on a new dialog, or when the unit stops waiting and waits again: the item is in the queue again", () => {
	for (const change of [(z: ReturnType<typeof rig>["z"]) => z.update(map(al("a", "waiting", 1, { pending: dlg("two") as never }))), (z: ReturnType<typeof rig>["z"]) => (z.update(map(al("a", "working", 1))), z.update(map(al("a", "waiting", 9, { pending: dlg("one") as never }))))]) {
		const r = rig();
		r.z.update(map(al("a", "waiting", 1, { pending: dlg("one") as never })));
		r.z.take();
		r.z.skip();
		r.z.tap();
		assert.equal(r.z.update(map(al("a", "waiting", 1, { pending: dlg("one") as never }))).screen.kind, "companion");
		assert.deepEqual(r.z.queued(), []);
		const back = change(r.z);
		assert.deepEqual([back.screen.kind, back.sound, r.z.queued().map((a) => a.key)], ["companion", undefined, ["a"]]);
		assert.deepEqual([r.z.take().sound], ["bowl"]);
	}
});

test("a hidden page keeps a pause that nothing waits behind until it is shown, then ends it at once", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.take();
	r.z.skip();
	r.z.visible(false);
	r.at(PAUSE_MS * 5);
	assert.equal(r.z.tick().screen.kind, "pause", "no one is there to breathe, and nothing waits");
	const s = r.z.visible(true);
	assert.equal(s.screen.kind, "companion", "shown: the pause that would have ended ends at once");
});

test("a question that waits ends the pause of a hidden page at once, and waits in the queue where the page's reminder counts it (trial11); a card that ended stays for the boss", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	r.z.take();
	r.z.skip();
	const s = r.z.visible(false);
	assert.deepEqual([s.screen.kind, s.sound, r.z.queued().map((x) => x.key)], ["companion", undefined, ["b"]], "b was behind a, which rests: the pause ends as the page is hidden, and b waits for Enter");
	// A card that ended stays on the screen: the next question lands while the page is hidden and queues behind it.
	const t = rig();
	t.z.update(map(al("c", "waiting", 1)));
	t.z.take();
	t.z.update(map());
	t.z.visible(false);
	assert.equal(t.z.tick().screen.kind, "item", "the card that ended is the boss's to close");
	const arrived = t.z.update(map(al("d", "waiting", 5)));
	assert.deepEqual([arrived.screen.kind, arrived.sound, t.z.queued().map((x) => x.key)], ["item", undefined, ["d"]]);
	// A rested item is not what ends it.
	const u = rig();
	u.z.update(map(al("e", "waiting", 1)));
	u.z.take();
	u.z.skip();
	u.z.visible(false);
	assert.equal(u.z.update(map(al("e", "waiting", 1))).screen.kind, "pause");
});

test("an item waits while the boss types in the companion's box, and after he stops: it waits for Enter (Z-D20)", () => {
	const r = rig();
	assert.equal(r.z.update(map(al("a", "waiting", 1))).screen.kind, "companion");
	r.at(60_000);
	const s = r.z.tick();
	assert.deepEqual([s.screen.kind, s.sound], ["companion", undefined]);
});

test("the render input carries no count of what waits: the same with one other item as with many", () => {
	const view = (others: number) => {
		const r = rig();
		r.z.update(map(al("a", "waiting", 1), ...Array.from({ length: others }, (_, i) => al(`o${i}`, "waiting", 10 + i))));
		const out = r.z.take();
		const p = r.z.skip();
		return JSON.stringify([out.screen, p.screen, r.z.tap().screen]);
	};
	assert.equal(view(0).replace(/"key":"o\d"/g, ""), view(0));
	const [one, many] = [JSON.parse(view(1)), JSON.parse(view(9))];
	assert.equal(JSON.stringify(one[0]), JSON.stringify(many[0]), "the item screen is the same");
	assert.equal(JSON.stringify(one[1]), JSON.stringify(many[1]));
	assert.deepEqual(Object.keys(one[1]), ["kind"], "the pause carries nothing else");
	assert.deepEqual(one[2], { kind: "companion" }, "the screen after the pause is the breath, never a list");
	const typing = rig();
	typing.z.update(map());
	assert.deepEqual(typing.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2))).screen, { kind: "companion" }, "the companion carries nothing about what waits");
	assert.deepEqual(Object.keys(one[0]).sort(), ["item", "kind"]);
});

test("a trust question that is gone from the net was settled elsewhere: the knock and the line, not a silent exit; a unit that left stays silent", () => {
	const a = { ...al("trust\u001f/x\u001fg", "waiting", 5), name: "x", trust: { id: "t", digest: "g", folder: "/x", found: [], agents: [] } as Alert["trust"] };
	const { z, at } = rig();
	z.update(map(a));
	z.take();
	const r = z.update(map());
	assert.deepEqual([r.sound, (r.screen as { outcome?: string }).outcome], ["knock", "elsewhere"]);
	const unitGone = rig();
	unitGone.z.update(map(al("u", "waiting", 5)));
	unitGone.z.take();
	assert.equal(unitGone.z.update(map()).sound, undefined, "a unit that left the net plays nothing");
	at(0);
});

test("due is the soonest moment ahead: a time that has passed is not due again, so the layer's one timer does not spin", () => {
	const { z, at } = rig();
	z.update(map(al("a", "waiting", 5, { pending: dlg("x") as never })));
	z.take();
	z.skip();
	assert.equal(z.due(), 1_000_000 + PAUSE_MS, "the pause ends first");
	at(PAUSE_MS + 1);
	z.tick();
	assert.equal(z.due(), 1_000_000 + REST_MS, "the pause is over: only the rest is ahead");
	at(REST_MS);
	z.tick();
	assert.equal(z.due(), undefined, "nothing ahead");
});

test("an answer's reply that comes after the snapshot that already dropped the item makes it answered, not answered elsewhere, and rings no second knock", () => {
	const { z } = rig();
	z.update(map(al("a", "waiting", 1, { card: { kind: "pair", request: { id: "a", label: "x", peer: "p", age: "" } } })));
	z.take();
	const gone = z.update(map());
	assert.deepEqual([gone.sound, (gone.screen as { outcome?: string }).outcome], ["knock", "elsewhere"]);
	const late = z.accepted("a");
	assert.deepEqual([late.sound, (late.screen as { outcome?: string }).outcome], [undefined, "answered"]);
});

test("T1: Zen shown again after Standard had the page: an item still on the screen from before that the snapshot no longer has is dropped with no outcome, no knock, and no pause; one it still has stays", () => {
	for (const card of [false, true]) {
		const { z } = rig(), gone = al(card ? "link-dialog\u001fd1" : "a", "waiting", 5, card ? { card: { kind: "dialog", device: "d", dialogId: "x", digest: "f", line: "" } as never, closed: false } : {});
		z.update(map(gone));
		assert.equal(z.take().screen.kind, "item");
		const back = z.update(map(), true);
		assert.deepEqual(back, { screen: { kind: "companion" }, sound: undefined }, card ? "a card the link closed" : "a unit that was answered");
		assert.equal(z.due(), undefined, "no outcome and no pause to wait for");
	}
	const { z } = rig(), keep = al("a", "waiting", 5);
	z.update(map(keep));
	z.take();
	const still = z.update(map(keep), true);
	assert.equal(still.screen.kind, "item", "an item that still waits is still the screen");
	assert.equal(still.sound, undefined, "and is not announced a second time");
	const live = rig(), card = al("link-dialog\u001fd2", "waiting", 5, { card: { kind: "dialog", device: "d", dialogId: "y", digest: "f", line: "" } as never, closed: false });
	live.z.update(map(card));
	live.z.take();
	const settled = live.z.update(map());
	assert.equal(settled.screen.kind === "item" && settled.screen.outcome, "elsewhere", "a question that is settled while Zen shows is still the knock and the line");
	assert.equal(settled.sound, "knock");
});

// Z-D18 (docs/specs/2026-11-01-zen-view.md, Blocking first): a question that blocks an agent outranks a tower wait or a notice-type card, and takes the screen from one the boss has not touched.
const WAIT = (since = 1) => al(`wait\u001fw\u001fW1`, "waiting", since, { unit: "t", role: "tower", wait: { id: "W1", text: "Boss token needed" } });
const BOX = (since = 100, id = "d1") => al(`link-dialog\u001f${id}`, "waiting", since, { ws: "", role: "none", pending: dlg(id) as never, card: { kind: "dialog", device: "dev", dialogId: id, digest: id, line: "asks" } });
const CONFIRM = (since = 1) => al("link-confirm\u001fc1", "waiting", since, { ws: "", role: "none", card: { kind: "confirm", confirm: {} as never } });
const PAIR = (since = 1) => al("pair\u001fp1", "waiting", since, { ws: "", role: "none", card: { kind: "pair", request: {} as never } });
const PROPOSAL = (since = 1) => al("proposal\u001fw\u001fP1", "waiting", since, { unit: "t", role: "tower", card: { kind: "proposal", ws: "w", tower: "t", proposal: {} as never, rev: 1 } });
const held = (r: { screen: Screen }) => (r.screen.kind === "item" ? r.screen.outcome : undefined);
const keyOf = (r: { screen: Screen }) => (r.screen.kind === "item" ? r.screen.item.key : r.screen.kind);

test("Z-D19 (replaces Z-D18's preemption): a question that blocks an agent does not take the screen from a tower wait; it comes next, once the wait is done (Z-D22: the boss's own answer is followed by it directly)", () => {
	const { z, at } = rig();
	z.update(map(WAIT()));
	assert.equal(keyOf(z.take()), WAIT().key);
	const r = z.update(map(WAIT(), BOX()));
	assert.deepEqual([keyOf(r), r.sound], [WAIT().key, undefined]);
	z.accepted(WAIT().key);
	at(OUTCOME_MS);
	const taken = z.tick();
	assert.deepEqual([keyOf(taken), taken.sound], [BOX().key, "bowl"], "Z-D22: the wait's answer is followed by the question, as if Enter had taken it: no pause");
});

test("Z-D18: every kind that blocks an agent comes before every kind that blocks none, by Enter", () => {
	const blocking: [string, Alert][] = [
		["a waiting unit", al("u", "waiting", 100)],
		["a unit with a dialog", al("d", "working", 100, { pending: dlg("x") as never })],
		["a trust question", al("trust\u001f/x\u001fg", "waiting", 100, { ws: "", trust: { id: "t", digest: "g", folder: "/x", found: [], agents: [] } as never })],
		["a question a box forwarded", BOX()],
		["a teammate's confirm (its tool call waits up to ten minutes)", CONFIRM(100)],
	];
	const lower: [string, Alert][] = [["a tower wait", WAIT()], ["a pair request", PAIR()], ["a memory proposal", PROPOSAL()]];
	for (const [bn, b] of blocking) for (const [ln, l] of lower) {
		const { z } = rig();
		assert.equal(keyOf(z.update(map(l, b))), "companion", `${bn}: waits for Enter`);
		assert.deepEqual(z.queued().map((a) => a.key), [b.key, l.key], `${bn} is before ${ln}, however old the other is`);
		assert.equal(keyOf(z.take()), b.key);
	}
});

test("Z-D18: a teammate's confirm is blocking: it keeps the screen against an older wait, and comes before it", () => {
	const a = rig();
	a.z.update(map(CONFIRM(100)));
	assert.equal(keyOf(a.z.take()), CONFIRM().key);
	assert.equal(keyOf(a.z.update(map(CONFIRM(100), WAIT(1)))), CONFIRM().key);
	const b = rig();
	b.z.update(map(WAIT(1), CONFIRM(100)));
	assert.equal(keyOf(b.z.take()), CONFIRM().key);
});

test("Z-D18: a lower item never preempts a blocking one, however old it is", () => {
	for (const l of [WAIT(1), PAIR(1), PROPOSAL(1)]) {
		const { z } = rig();
		z.update(map(BOX()));
		assert.equal(keyOf(z.take()), BOX().key);
		const r = z.update(map(BOX(), l));
		assert.deepEqual([keyOf(r), r.sound], [BOX().key, undefined], l.key);
	}
});

test("Z-D19: a card on the screen is never interrupted: a blocking question that arrives behind a lower one waits for it", () => {
	const { z, at } = rig();
	z.update(map(WAIT()));
	z.take();
	const r = z.update(map(WAIT(), BOX()));
	assert.deepEqual([keyOf(r), r.sound], [WAIT().key, undefined], "Z-D18's preemption is gone");
	at(60_000);
	assert.equal(keyOf(z.tick()), WAIT().key, "however long it has been on the screen");
	z.skip();
	at(PAUSE_MS);
	assert.equal(keyOf(z.tick()), "companion", "it waits for Enter after the pause");
	assert.equal(keyOf(z.take()), BOX().key);
});

test("Z-D18: a card whose answer was just accepted is not preempted; a blocking question that comes during the outcome waits for Enter (Z-D22, ZCR-F002)", () => {
	const { z, at } = rig();
	z.update(map(WAIT()));
	z.take();
	z.accepted(WAIT().key);
	assert.equal(keyOf(z.update(map(WAIT(), BOX()))), WAIT().key, "the outcome is on the screen");
	at(OUTCOME_MS);
	assert.deepEqual([keyOf(z.tick()), z.queued().map((x) => x.key)], ["pause", [BOX().key]], "the question came after the answer: the pause, and it waits for Enter");
});

test("Z-D18: a question that arrives during a pause waits for the pause, like any arrival, and then for Enter", () => {
	const { z, at } = rig();
	z.update(map(PAIR()));
	z.take();
	z.skip();
	assert.equal(z.tick().screen.kind, "pause");
	at(1000);
	assert.equal(keyOf(z.update(map(PAIR(), BOX()))), "pause");
	at(PAUSE_MS);
	assert.equal(keyOf(z.tick()), "companion");
	assert.equal(keyOf(z.take()), BOX().key);
});

test("Z-D18: blocking questions come oldest first and before an older wait; then the lower ones, oldest first", () => {
	const { z, at } = rig();
	const all = map(WAIT(1), BOX(60, "late"), BOX(50, "early"), PAIR(2));
	assert.equal(keyOf(z.update(all)), "companion");
	assert.equal(keyOf(z.take()), BOX(50, "early").key);
	z.skip();
	at(PAUSE_MS);
	z.update(all);
	assert.equal(keyOf(z.take()), BOX(60, "late").key);
	z.skip();
	at(PAUSE_MS);
	z.update(all);
	assert.equal(keyOf(z.take()), WAIT().key);
});

test("Z-D18: with a wait on the screen, two blocking questions arriving together wait for it, then come oldest first", () => {
	const { z, at } = rig();
	z.update(map(WAIT(1)));
	z.take();
	assert.equal(keyOf(z.update(map(WAIT(1), BOX(60, "late"), BOX(50, "early")))), WAIT().key);
	z.skip();
	at(PAUSE_MS);
	z.tick();
	assert.equal(keyOf(z.take()), BOX(50, "early").key);
});

test("Z-D18/Z-D19: a question that waits behind the card on the screen says so in why()", () => {
	const { z } = rig();
	z.update(map(WAIT()));
	z.take();
	z.update(map(WAIT(), BOX()));
	assert.match(z.why(BOX().key) ?? "", /is on the screen/);
});

test("Z-D18: every kind of card has a rank, and a kind nobody ranked blocks (a question that waits is not buried)", () => {
	const ranked: Record<BossCard["kind"], boolean> = { dialog: true, confirm: true, pair: false, proposal: false, run: true }; // a new kind in BossCard fails the type check here until it is ranked in `blocks`
	for (const [kind, rank] of Object.entries(ranked)) assert.equal(blocks({ ...al("k", "waiting"), card: { kind } as never }), rank, kind);
	assert.equal(blocks({ ...al("k", "waiting"), card: { kind: "from-the-future" } as never }), true, "unknown at run time: blocking");
	assert.equal(blocks(WAIT()), false);
	assert.equal(blocks(al("u", "waiting")), true);
});

// Z-D19 (boss 2026-11-06: 「如果 user 還在呼吸，下一張卡片也可以先 hold on，除非 user enter 願意去接卡片」, then 「全部都等 Enter」): on the breathing circle no card takes the screen.
test("Z-D19: on the breathing circle no card takes the screen, whatever its kind; they queue, blocking first, and a snapshot changes nothing", () => {
	const { z, at } = rig();
	for (const all of [map(BOX()), map(WAIT(1), PAIR(2), PROPOSAL(3), BOX(60, "late"), BOX(50, "early")), map(CONFIRM())]) {
		const r = z.update(all);
		assert.deepEqual([r.screen.kind, r.sound], ["companion", undefined], "no card, no bowl");
		at(60_000);
		assert.equal(z.tick().screen.kind, "companion", "and it stays so");
	}
	z.update(map(WAIT(1), PAIR(2), PROPOSAL(3), BOX(60, "late"), BOX(50, "early")));
	assert.deepEqual(z.queued().map((a) => a.key), [BOX(50, "early"), BOX(60, "late"), WAIT(1), PAIR(2), PROPOSAL(3)].map((a) => a.key), "the queue is the cards that wait, blocking first, the one that has waited longest first");
	assert.match(z.why(BOX(50, "early").key) ?? "", /waits for Enter/);
});

test("Z-D19: Enter takes the next card, blocking first and oldest first, with the bowl; one card at a time; the answer is followed by the next that waits (Z-D22), and Not now returns to the breath", () => {
	const { z, at } = rig();
	z.update(map(WAIT(1), BOX(60, "late"), BOX(50, "early")));
	const first = z.take();
	assert.deepEqual([keyOf(first), first.sound], [BOX(50, "early").key, "bowl"]);
	assert.deepEqual(z.queued().map((a) => a.key), [BOX(60, "late").key, WAIT(1).key], "the cue counts the cards behind the one on the screen, not that one");
	assert.equal(keyOf(z.take()), BOX(50, "early").key, "a second Enter changes nothing");
	z.skip();
	assert.equal(z.tick().screen.kind, "pause", "Not now is the breath, not a chain");
	at(PAUSE_MS);
	assert.equal(z.tick().screen.kind, "companion", "back to the breath");
	assert.deepEqual(z.queued().map((a) => a.key), [BOX(60, "late").key, WAIT(1).key], "the rest still wait");
	assert.equal(keyOf(z.take()), BOX(60, "late").key, "the next one waits for Enter, not for the pause");
	z.accepted(BOX(60, "late").key);
	at(OUTCOME_MS);
	assert.equal(keyOf(z.tick()), WAIT(1).key, "after the boss's answer the next that waits follows (Z-D22)");
});

test("Z-D19: Enter during the pause takes the next card at once; with none waiting it changes nothing", () => {
	const { z, at } = rig();
	z.update(map(BOX(50, "a"), BOX(60, "b")));
	z.take();
	z.skip();
	at(OUTCOME_MS);
	assert.equal(z.tick().screen.kind, "pause");
	assert.equal(keyOf(z.take()), BOX(60, "b").key);
	const none = rig();
	none.z.update(new Map());
	assert.deepEqual([none.z.take().screen.kind, none.z.queued()], ["companion", []]);
});

test("Z-D19: a card put aside (Maybe later) is not in the queue until its rest ends; a skipped card does not come back by itself", () => {
	const { z, at } = rig();
	z.update(map(WAIT(1), PAIR(2)));
	z.take();
	z.skip();
	at(PAUSE_MS);
	z.tick();
	assert.deepEqual(z.queued().map((a) => a.key), [PAIR(2).key], "the one put aside is not counted");
	at(REST_MS);
	assert.equal(z.tick().screen.kind, "companion", "no card takes the screen when its rest ends");
	assert.equal(z.queued().length, 2);
});

// Z-D20 (boss 2026-11-06 on 0.60.2: 「我正在操作的時候，被強制切呼吸打斷」, 「新進來的卡片也是，應該放在背景等候排隊，永遠不要打斷使用者正在進行的操作」): a new card never takes the screen by itself, in any state, and a card on the screen is never replaced or pulled away.
const ASK = (digest: string, o: Partial<Alert> = {}) => al("a", "waiting", 1, { pending: dlg(digest) as never, ...o });
{
	test("Z-D20: a card that arrives queues and takes the screen only when taken: no bowl, however long it waits and whatever Zen shows (the breath, a session for company, the head's history)", () => {
		const { z, at } = rig();
		const r = z.update(map(al("a", "waiting", 1)));
		assert.deepEqual([r.screen.kind, r.sound], ["companion", undefined]);
		assert.deepEqual(z.queued().map((a) => a.key), ["a"], "the cue counts it");
		at(60_000);
		assert.deepEqual([z.tick().screen.kind, z.tick().sound], ["companion", undefined], "a minute later: still waiting for Enter");
		assert.equal(keyOf(z.take()), "a", "taken: the card");
		assert.equal(z.take().sound, undefined, "one bowl, for the take");
	});

	test("Z-D20: a card that is settled while it queues never shows and never sounds", () => {
		const { z, at } = rig();
		z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
		for (const next of [map(al("b", "waiting", 2)), map(al("a", "working", 1), al("b", "waiting", 2)), map(al("a", "idle", 1, { closed: true }), al("b", "waiting", 2))]) {
			const r = z.update(next);
			assert.deepEqual([r.screen.kind, r.sound], ["companion", undefined], "the card that resolved while queued: no card, no bowl, no knock");
			assert.deepEqual(z.queued().map((a) => a.key), ["b"]);
			at(5_000);
			assert.deepEqual([z.tick().screen.kind, z.tick().sound], ["companion", undefined]);
			z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
		}
	});
}

test("Z-D20: the unit's next question never replaces the card on the screen: the card stays, says it was answered elsewhere, and the knock rings once; the new question queues behind it and comes by Enter after the boss closes the card", () => {
	const { z, at } = rig();
	z.update(map(ASK("d1")));
	z.take();
	const r = z.update(map(ASK("d2")));
	assert.deepEqual([r.screen.kind, held(r), r.sound], ["item", "elsewhere", "knock"], "the old question stays, settled");
	assert.equal((r.screen as { item: Alert }).item.pending?.answer?.digest, "d1", "it is still the question the boss was reading");
	assert.deepEqual(z.queued(), [], "the unit's new question is not counted while its card is shown");
	at(3_600_000);
	assert.deepEqual([z.tick().screen.kind, held(z.tick()), z.due()], ["item", "elsewhere", undefined], "an hour later it is still there, and no timer is set for it");
	assert.equal(z.update(map(ASK("d2"))).sound, undefined, "no second knock");
	assert.equal(z.skip().screen.kind, "pause", "closing it is the boss's");
	at(PAUSE_MS);
	assert.equal(z.tick().screen.kind, "companion", "the new question does not take the screen after the pause");
	assert.deepEqual(z.queued().map((a) => a.key), ["a"]);
	const next = z.take();
	assert.equal((next.screen as { item: Alert }).item.pending?.answer?.digest, "d2");
});

test("Z-D20: every way the card's question can end under the boss keeps the card: stopped waiting, gone, closed, a rank change; an error is the low bowl; none pulls the screen to the pause", () => {
	const ways: [string, ReturnType<typeof map>, string | undefined, string][] = [
		["the unit works again", map(al("a", "working", 1)), "knock", "elsewhere"],
		["the unit is gone from the snapshot", map(), undefined, "gone"],
		["its pane closed", map(al("a", "idle", 1, { closed: true })), undefined, "gone"],
		["it failed", map(al("a", "error", 1)), "low", "error"],
	];
	for (const [name, next, sound, outcome] of ways) {
		const { z, at } = rig();
		z.update(map(al("a", "waiting", 1)));
		z.take();
		const r = z.update(next);
		assert.deepEqual([r.screen.kind, held(r), r.sound], ["item", outcome, sound], name);
		at(10 * 60_000);
		assert.deepEqual([z.tick().screen.kind, held(z.tick())], ["item", outcome], `${name}: stays until closed`);
		assert.equal(z.skip().screen.kind, "pause", `${name}: closed by the boss`);
		assert.deepEqual(z.queued(), [], `${name}: Maybe later is not set on what ended`);
	}
});

test("Z-D20: a card held after its question ended is brought back to life when the same question is listed again (a snapshot gap), with no second knock", () => {
	const { z } = rig();
	z.update(map(ASK("d1")));
	z.take();
	z.update(map());
	const r = z.update(map(ASK("d1")));
	assert.deepEqual([r.screen.kind, held(r), r.sound], ["item", undefined, undefined]);
});

test("Z-D20: an answer the server accepted after the snapshot that settled the card is still the boss's answer: answered, then the pause after 1.2 s, not held for ever", () => {
	const { z, at } = rig();
	z.update(map(al("a", "waiting", 1)));
	z.take();
	z.update(map(al("a", "working", 1)));
	const r = z.accepted("a");
	assert.equal(held(r), "answered");
	at(OUTCOME_MS);
	assert.equal(z.tick().screen.kind, "pause");
});

test("Z-D20: Zen shown again after Standard: a held card is not shown again (the boss has seen it end), and a card that is still live comes back as it was", () => {
	const a = rig();
	a.z.update(map(al("a", "waiting", 1)));
	a.z.take();
	a.z.update(map(al("a", "working", 1)));
	assert.equal(a.z.update(map(al("a", "working", 1)), true).screen.kind, "companion");
	const b = rig();
	b.z.update(map(al("a", "waiting", 1)));
	b.z.take();
	assert.equal(keyOf(b.z.update(map(al("a", "waiting", 1)), true)), "a");
});

test("Z-D20: the cue counts the cards behind the one on the screen, and not that one", () => {
	const { z } = rig();
	z.update(map(al("a", "waiting", 1), al("b", "waiting", 2), al("c", "waiting", 3)));
	z.take();
	assert.deepEqual(z.queued().map((x) => x.key), ["b", "c"]);
	assert.deepEqual(z.listed(), ["a", "b", "c"], "the page's reminders are counted against all of them");
});

test("ZNI-F002: the knock rings once for a card, however many times a snapshot drops it and lists it again", () => {
	const { z } = rig(), box = BOX();
	z.update(map(box));
	z.take();
	const sounds = [z.update(map()).sound, z.update(map(box)).sound, z.update(map()).sound, z.update(map(box)).sound, z.update(map()).sound];
	assert.deepEqual(sounds, ["knock", undefined, undefined, undefined, undefined]);
	const pair = rig(), req = PAIR();
	pair.z.update(map(req));
	pair.z.take();
	assert.deepEqual([pair.z.update(map()).sound, pair.z.update(map(req)).sound, pair.z.update(map()).sound], ["knock", undefined, undefined]);
});

test("ZNI-F007: a unit that left or closed is held as gone, not as answered elsewhere; a unit that works again is answered elsewhere; a reply that comes after settles either as answered", () => {
	for (const [name, next, outcome] of [["left", map(), "gone"], ["closed", map(al("a", "idle", 1, { closed: true })), "gone"], ["works again", map(al("a", "working", 1)), "elsewhere"]] as const) {
		const { z } = rig();
		z.update(map(al("a", "waiting", 1)));
		z.take();
		assert.equal(held(z.update(next)), outcome, name);
		assert.equal(held(z.accepted("a")), "answered", `${name}: the boss's own answer still counts`);
	}
});

test("ZNR-F001: one knock per card, but a refused answer and a unit failure after the card was revived still play the low bowl", () => {
	// a unit card: the unit works again (knock), the same question is listed again (revived), then the boss's answer is refused
	const a = rig();
	a.z.update(map(ASK("d1")));
	a.z.take();
	assert.equal(a.z.update(map(al("a", "working", 1))).sound, "knock");
	assert.deepEqual([held(a.z.update(map(ASK("d1")))), a.z.refused("a").sound], [undefined, "low"], "revived, then refused: the low bowl");
	assert.equal(a.z.refused("a").sound, undefined, "once");
	// ...or the unit fails after the revival
	const c = rig();
	c.z.update(map(ASK("d1")));
	c.z.take();
	c.z.update(map(al("a", "working", 1)));
	c.z.update(map(ASK("d1")));
	assert.equal(c.z.update(map(al("a", "error", 1))).sound, "low", "the failure after a revival: the low bowl");
	// a link-dialog card: gap (knock), revive, refused
	const d = rig(), box = BOX();
	d.z.update(map(box));
	d.z.take();
	assert.equal(d.z.update(map()).sound, "knock");
	d.z.update(map(box));
	assert.equal(d.z.refused(box.key).sound, "low");
	// the boss's own answer after a flap still knocks
	const e = rig();
	e.z.update(map(ASK("d1")));
	e.z.take();
	e.z.update(map(al("a", "working", 1)));
	e.z.update(map(ASK("d1")));
	assert.equal(e.z.accepted("a").sound, "knock", "the boss's own answer is its own knock");
	// and still one knock for the flaps themselves
	const f = rig(), box2 = BOX();
	f.z.update(map(box2));
	f.z.take();
	assert.deepEqual([f.z.update(map()).sound, f.z.update(map(box2)).sound, f.z.update(map()).sound], ["knock", undefined, undefined]);
});

test("ZNR-F005: a card taken before the relay, whose tool call then gains its relayed answer, is the same question: it becomes answerable, with no ended words and no knock", () => {
	const callOnly = () => al("a", "waiting", 1, { pending: { callId: "c1", tool: "ask_user" } as never });
	const withAnswer = (callId = "c1", digest = "d1") => al("a", "waiting", 1, { pending: { callId, tool: "ask_user", answer: { dialog: "d", digest } } as never });
	const { z } = rig();
	z.update(map(callOnly()));
	z.take();
	const r = z.update(map(withAnswer()));
	assert.deepEqual([r.screen.kind, held(r), r.sound], ["item", undefined, undefined], "same call, now answerable: the same card, live");
	assert.equal((r.screen as { item: Alert }).item.pending?.answer?.digest, "d1", "the card shows the question with its answer path");
	assert.deepEqual(z.queued(), [], "and the cue does not count it twice");
	// another call is another question: the old card is settled
	const o = rig();
	o.z.update(map(callOnly()));
	o.z.take();
	const w = o.z.update(map(withAnswer("c2")));
	assert.deepEqual([held(w), w.sound], ["elsewhere", "knock"]);
	// a card that already had an answer that changes is still another question
	const p = rig();
	p.z.update(map(withAnswer()));
	p.z.take();
	assert.equal(held(p.z.update(map(withAnswer("c1", "d2")))), "elsewhere");
});

// Z-D22 (docs/specs/2026-11-01-zen-view.md, Chain): after the boss's own accepted answer, a queued card is taken directly once the outcome has shown: no pause, no breath.
const chained = (r: object) => (r as { chained?: boolean }).chained;

test("Z-D22: after the boss's accepted answer the outcome shows 1.2 s, then the next queued card takes the screen with the bowl: no pause, no breath; the cue's count drops by one per card", () => {
	const { z, at } = rig();
	z.update(map(al("a", "waiting", 1), al("b", "waiting", 2), al("c", "waiting", 3)));
	z.take();
	assert.deepEqual(z.queued().map((x) => x.key), ["b", "c"]);
	assert.equal(z.accepted("a").sound, "knock", "the answer knocks as before");
	at(OUTCOME_MS - 1);
	assert.equal(held(z.tick()), "answered", "the outcome still holds 1.2 s");
	at(1);
	const next = z.tick();
	assert.deepEqual([keyOf(next), held(next), next.sound, chained(next)], ["b", undefined, "bowl", true], "b rings as a taken card does: the bowl, and no knock besides");
	assert.deepEqual(z.queued().map((x) => x.key), ["c"], "one fewer waits");
	assert.equal(z.due(), 1_000_000 + HOLD_MS, "no pause timer: the one thing due is the answered card's hold ending, 30 s from its answer");
	assert.equal(z.tick().sound, undefined, "and it rings once");
	z.accepted("b");
	at(OUTCOME_MS);
	assert.deepEqual([keyOf(z.tick()), z.queued().length], ["c", 0]);
	z.accepted("c");
	at(OUTCOME_MS);
	const last = z.tick();
	assert.deepEqual([last.screen.kind, chained(last)], ["pause", undefined], "the queue is empty: the pause, as before");
	at(PAUSE_MS);
	assert.equal(z.tick().screen.kind, "companion", "and then the breath");
});

test("Z-D22: the chain takes the cards in Blocking-first order, the one that has waited longest first within a rank", () => {
	const { z, at } = rig(), all = () => map(al("a", "waiting", 0), WAIT(1), CONFIRM(2), BOX(50), PAIR(3));
	z.update(all());
	z.take();
	const order: string[] = [];
	for (let i = 0; i < 4; i++) {
		z.accepted(keyOf({ screen: z.tick().screen }));
		at(OUTCOME_MS);
		order.push(keyOf(z.update(all())));
	}
	assert.deepEqual(order, [CONFIRM().key, BOX().key, WAIT().key, PAIR().key]);
});

test("Z-D22: no chain after Not now, after closing a card that ended (elsewhere, gone, error), or with an empty queue: the pause and the breath, as before", () => {
	const ends: [string, (z: ReturnType<typeof rig>["z"]) => unknown][] = [
		["elsewhere", (z) => z.update(map(al("a", "working", 1), al("b", "waiting", 2)))],
		["gone", (z) => z.update(map(al("b", "waiting", 2)))],
		["error", (z) => z.update(map(al("a", "error", 1), al("b", "waiting", 2)))],
	];
	for (const [name, end] of ends) {
		const r = rig();
		r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
		r.z.take();
		end(r.z);
		r.at(OUTCOME_MS * 10);
		assert.equal(held(r.z.tick()) !== undefined, true, `${name}: the card stays until the boss closes it`);
		const closed = r.z.skip();
		assert.deepEqual([closed.screen.kind, chained(closed), r.z.queued().map((x) => x.key)], ["pause", undefined, ["b"]], `${name}: closing it is the pause, and b waits for Enter`);
		r.at(PAUSE_MS);
		assert.equal(r.z.tick().screen.kind, "companion", name);
	}
	const notNow = rig();
	notNow.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	notNow.z.take();
	const skipped = notNow.z.skip();
	assert.deepEqual([skipped.screen.kind, chained(skipped), notNow.z.queued().map((x) => x.key)], ["pause", undefined, ["b"]], "Not now (Esc) is the pause");
	notNow.at(PAUSE_MS);
	assert.deepEqual([notNow.z.tick().screen.kind, notNow.z.tick().sound], ["companion", undefined]);
	const alone = rig();
	alone.z.update(map(al("a", "waiting", 1)));
	alone.z.take();
	alone.z.accepted("a");
	alone.at(OUTCOME_MS);
	assert.equal(alone.z.tick().screen.kind, "pause", "nothing queued: the pause");
});

test("Z-D22: a card that resolved while it queued is never drawn: the chain skips it, and with none left it is the pause", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2), al("c", "waiting", 3)));
	r.z.take();
	r.z.accepted("a");
	r.z.update(map(al("a", "waiting", 1), al("b", "working", 2), al("c", "waiting", 3)));
	r.at(OUTCOME_MS);
	const next = r.z.tick();
	assert.deepEqual([keyOf(next), next.sound, chained(next)], ["c", "bowl", true], "b was answered in the terminal: c is next, b is never drawn");
	r.z.accepted("c");
	r.z.update(map(al("b", "working", 2)));
	r.at(OUTCOME_MS);
	assert.equal(r.z.tick().screen.kind, "pause");
});

test("Z-D22: the unit's own next question, listed under the card the boss just answered, is not chained into: it waits for Enter like any other", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1, { pending: dlg("one") as never })));
	r.z.take();
	r.z.accepted("a");
	r.z.update(map(al("a", "waiting", 9, { pending: dlg("two") as never })));
	r.at(OUTCOME_MS * 40);
	const s = r.z.tick();
	assert.deepEqual([s.screen.kind, chained(s)], ["pause", undefined]);
});

test("Z-D22: a hidden page, or something the boss opened over the card (the terminal layer, the palette, the menu), does not chain: the pause and the breath as before, and the card waits for Enter", () => {
	let covered = false, t = 1_000_000;
	const z = createZen({ now: () => t, covered: () => covered });
	const all = () => map(al("a", "waiting", 1), al("b", "waiting", 2));
	z.update(all());
	z.take();
	z.accepted("a");
	covered = true;
	t += OUTCOME_MS;
	assert.equal(z.tick().screen.kind, "pause", "the terminal layer is open over the card");
	t += PAUSE_MS;
	assert.equal(z.tick().screen.kind, "companion");
	assert.deepEqual(z.queued().map((x) => x.key), ["b"], "b is in the cue");
	covered = false;
	const hid = rig();
	hid.z.update(all());
	hid.z.take();
	hid.z.accepted("a");
	hid.z.visible(false);
	hid.at(OUTCOME_MS);
	const s = hid.z.tick();
	assert.deepEqual([s.screen.kind, s.sound, chained(s), hid.z.queued().map((x) => x.key)], ["companion", undefined, undefined, ["b"]], "a page nobody looks at is not made to ring a second card: the pause ends at once, as a hidden page's does, and b waits for Enter");
});

test("Z-D22: a reply that came after the snapshot (the card ended elsewhere first) is still the boss's answer: it chains", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	r.z.take();
	r.z.update(map(al("a", "working", 1), al("b", "waiting", 2)));
	assert.equal(held(r.z.tick()), "elsewhere");
	r.z.accepted("a");
	r.at(OUTCOME_MS);
	const first = r.z.tick();
	assert.deepEqual([keyOf(first), first.sound, chained(first)], ["b", "bowl", true], "taken, and its bowl rings with the tick that took it");
	assert.equal(r.z.tick().sound, undefined, "and only once");
});

test("Z-D22 (ZCR-F002, boss 2026-11-07): only a card that was already queued when the answer was accepted is chained into; one that arrives during the 1.2 s outcome waits for Enter", () => {
	const r = rig();
	r.z.update(map(al("a", "waiting", 1)));
	r.z.take();
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2))); // b came while a was open: queued when the answer is accepted
	r.z.accepted("a");
	r.at(600);
	r.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2), al("c", "waiting", 3))); // c comes in the outcome
	r.at(OUTCOME_MS - 600);
	assert.deepEqual([keyOf(r.z.tick()), chained(r.z.tick())], ["b", undefined], "b was queued at the answer: it is taken (chained reports once, on the call that took it)");
	r.z.accepted("b"); // c is queued by now: it is queued at b's answer, so it follows b
	r.at(OUTCOME_MS);
	assert.equal(keyOf(r.z.tick()), "c", "c was queued when b's answer was accepted");
	// the arrival alone, with nothing else queued
	const only = rig();
	only.z.update(map(al("a", "waiting", 1)));
	only.z.take();
	only.z.accepted("a");
	only.at(600);
	only.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	only.at(OUTCOME_MS - 600);
	const t = only.z.tick();
	assert.deepEqual([t.screen.kind, t.sound, chained(t), only.z.queued().map((x) => x.key)], ["pause", undefined, undefined, ["b"]], "the one waiting card arrived after the answer: the pause, the cue counts it");
	// a reply that follows the snapshot snapshots the queue at the reply, not at the first Enter
	const late = rig();
	late.z.update(map(al("a", "waiting", 1)));
	late.z.take();
	late.z.update(map(al("a", "working", 1), al("b", "waiting", 2)));
	late.z.accepted("a");
	late.at(OUTCOME_MS);
	assert.equal(keyOf(late.z.tick()), "b", "b was queued when the reply was accepted");
});

test("Z-D22 (ZCR-F001, Z-D16): Zen shown again never starts on a chained card: a return after the outcome ended, or one inside the outcome, is the pause and the breath", () => {
	const after = rig();
	after.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	after.z.take();
	after.z.accepted("a");
	after.at(300); // Zen was left here (the layer cancels its timer) ...
	after.at(60_000);
	const back = after.z.update(map(al("a", "working", 1), al("b", "waiting", 2)), true); // ... and shown again a minute later
	assert.deepEqual([back.screen.kind, back.sound, chained(back)], ["pause", undefined, undefined], "the visit does not start on b");
	after.at(PAUSE_MS);
	assert.equal(after.z.tick().screen.kind, "companion");
	assert.deepEqual(after.z.queued().map((x) => x.key), ["b"]);
	const inside = rig();
	inside.z.update(map(al("a", "waiting", 1), al("b", "waiting", 2)));
	inside.z.take();
	inside.z.accepted("a");
	inside.at(300);
	inside.z.update(map(al("a", "working", 1), al("b", "waiting", 2)), true); // back inside the outcome
	inside.at(OUTCOME_MS);
	const s = inside.z.tick();
	assert.deepEqual([s.screen.kind, s.sound, chained(s)], ["pause", undefined, undefined], "the outcome that was interrupted by a visit does not chain at its end");
	// the next answer of the next visit chains again
	inside.at(PAUSE_MS);
	inside.z.tick();
	inside.z.take();
	inside.z.update(map(al("b", "waiting", 2), al("c", "waiting", 3)));
	inside.z.accepted("b");
	inside.at(OUTCOME_MS);
	assert.deepEqual([keyOf(inside.z.tick())], ["c"], "a fresh answer chains as before");
});

// Headless runs (docs/specs/2026-11-24-zen-f.md §2.2, §8.2): a run's dialog is blocking, and so is a wait a run's boss_wait_ask shows now; within blocking the oldest first; a run card never takes the screen by itself, and Z-D22 chains into one.
const RUNCARD = (key: string, since: number): Alert => al(`run\u001f${key}`, "waiting", since, { card: { kind: "run", dialog: { key, workspace: "w", method: "confirm", title: "t", at: since } } });
const ASKED = (since: number, asked: boolean): Alert => al("wait\u001fw\u001fW3", "waiting", since, { unit: "t", role: "tower", wait: { id: "W3", text: "x", ...(asked ? { asked: true as const } : {}) } });

test("ZF: a run card and an asked wait block; a wait that is not asked does not", () => {
	assert.equal(blocks(RUNCARD("r:1", 5)), true);
	assert.equal(blocks(ASKED(5, true)), true, "a run's turn holds on it");
	assert.equal(blocks(ASKED(5, false)), false);
});

test("ZF: a run card queues behind the circle and behind a card on the screen, the oldest blocking first, ahead of an older card that blocks no one; Z-D22 chains into a queued run card", () => {
	const { z, at } = rig();
	const proposal = al("p", "waiting", 1, { card: { kind: "proposal", ws: "w", tower: "t", proposal: { id: "P1" } as never, rev: 1 } });
	assert.equal(z.update(map(proposal, RUNCARD("r:2", 30), RUNCARD("r:1", 20))).screen.kind, "companion", "nothing takes the circle by itself");
	assert.deepEqual(z.queued().map((a) => a.key), ["run\u001fr:1", "run\u001fr:2", "p"], "blocking first, the oldest of them first; the older proposal after");
	const first = z.take().screen as Extract<Screen, { kind: "item" }>;
	assert.equal(first.item.key, "run\u001fr:1");
	z.update(map(proposal, RUNCARD("r:2", 30), RUNCARD("r:1", 20), RUNCARD("r:3", 40)));
	assert.equal((z.tick().screen as Extract<Screen, { kind: "item" }>).item.key, "run\u001fr:1", "a new run card does not replace the one on the screen");
	z.accepted("run\u001fr:1");
	z.update(map(proposal, RUNCARD("r:2", 30), RUNCARD("r:3", 40)));
	at(OUTCOME_MS);
	const next = z.tick();
	assert.equal(next.chained, true, "the accepted answer is followed by the next queued card (Z-D22)");
	assert.equal((next.screen as Extract<Screen, { kind: "item" }>).item.key, "run\u001fr:2");
});

test("ZF §2.3: a run card the server stopped listing ends as `ended` or `expired` when endOf says so, with no knock; otherwise it was answered elsewhere and knocks", () => {
	for (const [why, sound] of [["ended", undefined], ["expired", undefined], [undefined, "knock"]] as const) {
		const z = createZen({ now: () => 1_000_000, endOf: () => why });
		z.update(map(RUNCARD("r:1", 5)));
		z.take();
		const r = z.update(map());
		assert.equal((r.screen as Extract<Screen, { kind: "item" }>).outcome, why ?? "elsewhere");
		assert.equal(r.sound, sound);
	}
});
