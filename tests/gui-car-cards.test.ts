import assert from "node:assert/strict";
import { test } from "node:test";
import type { Base, Unit } from "../src/net.ts";
import type { CarFact } from "../src/train/carfacts.ts";
import { El, page, sessionGlobals } from "./fake-dom.ts";
import { overwriteGetLocale } from "../gui/paraglide/runtime.js";

// Car cards on a main's unit card (docs/specs/2026-11-28-car-rows.md, The GUI): the cars it coordinates, from the net's `yards.projects[].cars`, with the ladder or the phase (the stage is the train's English id in
// every language, boss 2026-11-28), the time, what it waits on, and a button that opens the yard at its train.

sessionGlobals();
let locale: "zh-TW" | "en" = "zh-TW";
overwriteGetLocale(() => locale);
Object.assign(document, { createComment: () => new El("#comment") });
Object.assign(El.prototype, { replaceWith(this: El, node: El) { this.before(node); this.remove(); } });
const { baseEl, fillBase, useYards } = await import("../gui/render.ts");
const { carCard, carCards } = await import("../gui/trains.ts");
void page;

const MIN = 60_000, NOW = Date.parse("2026-11-27T10:00:00Z"), SHA = "a".repeat(40);
const fact = (over: Partial<CarFact> = {}): CarFact => ({ id: "mp/web-aaaaaaaaaaaa#1", project: "mp", app: "web", head: SHA, tickets: ["MP-5801"], coordinator: "m1", integrator: "i1", phase: "riding", train: "2026-11-27-l", since: NOW - 12 * MIN, stage: { kind: "merge", at: 4, of: 7, attempt: 1 }, ...over });
const unit = (key: string, role: Unit["role"]): Unit => ({ id: key, key, control: true, name: key, role, mark: "working", note: "thinking", subs: [] });
const base = (units: Unit[]): Base => ({ id: "w1", label: "Harbor", mark: "working", tower: null, tabs: [{ id: "w1:t1", label: "t", units }], outposts: [], outside: [] });

test("a car card says the ladder with the stage's English id, the time and what it waits on; the chrome follows the page's language", () => {
	locale = "zh-TW";
	assert.deepEqual(carCard(fact({ waits: [{ lane: { app: "web", holder: "2026-11-27-j" } }] }), NOW), { id: fact().id, tickets: "MP-5801", project: "mp", time: "12m", short: "1127l", mark: "🚂", tone: "wait", line: "1127l ▰▰▰▱▱▱▱ merge", wait: "等 1127j" });
	assert.equal(carCard(fact({ stage: { kind: "merge", at: 4, of: 7, attempt: 2 } }), NOW).line, "1127l ▰▰▰▱▱▱▱ merge（第 2 次）");
	assert.deepEqual(((c) => [c.mark, c.tone, c.line, c.wait])(carCard(fact({ phase: "dropped", stage: undefined, reason: "unit red" }), NOW)), ["✖", "bad", "1127l 剔除", "unit red"]);
	locale = "en";
	assert.deepEqual(((c) => [c.mark, c.tone, c.line])(carCard(fact({ phase: "landed", stage: undefined, version: "1.62.0" }), NOW)), ["✅", "ok", "1127l landed 1.62.0"]);
	assert.equal(carCard(fact({ waits: [{ lane: { app: "web", holder: "2026-11-27-j" } }] }), NOW).wait, "waits 1127j");
	const waiting = carCard(fact({ phase: "waiting", stage: undefined, train: "2026-11-27-m", departs: { maxCars: 4, maxWaitMin: 60, oldest: new Date(NOW - 37 * MIN).toISOString() } }), NOW);
	assert.deepEqual([waiting.mark, waiting.line, waiting.wait], ["🚉", "web waiting to depart", "Leaves at 4 cars or 60 min (23 min left)"]);
	assert.deepEqual([...carCards({ yards: { projects: [{ project: "mp", forming: [], trains: [], waiting: [], cars: [fact(), fact({ id: "x", coordinator: "m2" })] }] } }, NOW).keys()], ["m1", "m2"], "each card by the coordinator's unit key");
});

test("a main's unit card lists its cars, each with a button that opens the yard of its project at its train; a card with no cars shows none", () => {
	locale = "zh-TW";
	useYards(new Map(), new Map(), new Set(), carCards({ yards: { projects: [{ project: "mp", forming: [], trains: [], waiting: [], cars: [fact(), fact({ id: "r", phase: "returned", train: undefined, stage: undefined, reason: "not the tip" })] }] } }, NOW));
	const el = baseEl() as unknown as El;
	fillBase(el as unknown as HTMLElement, base([unit("m1", "main"), unit("m2", "main")]), {});
	const card = (name: string) => el.find((x) => x.classes.has("unit") && x.find((y) => y.classes.has("name"))[0]?.textContent === name)[0]!;
	const list = card("m1").find((x) => x.classes.has("cars"))[0]!, items = list.find((x) => x.classes.has("car-card"));
	assert.equal(list.hidden, false);
	assert.equal(items.length, 2);
	const text = (e: El, cls: string) => e.find((x) => x.classes.has(cls))[0]!.textContent;
	assert.deepEqual([text(items[0]!, "car-mark"), text(items[0]!, "car-tickets"), text(items[0]!, "car-step"), text(items[0]!, "car-time"), items[0]!.dataset.tone], ["🚂", "MP-5801", "1127l ▰▰▰▱▱▱▱ merge", "12m", "ok"]);
	const see = items[0]!.find((x) => x.classes.has("car-see"))[0]!;
	assert.deepEqual([see.dataset.yard, see.dataset.yardCode, see.textContent], ["mp", "1127l", "看這班火車 ›"]);
	assert.deepEqual([items[1]!.dataset.tone, text(items[1]!, "car-wait"), items[1]!.find((x) => x.classes.has("car-see"))[0]!.dataset.yardCode], ["bad", "not the tip", undefined]);
	assert.equal(card("m2").find((x) => x.classes.has("cars"))[0]!.hidden, true);
});
