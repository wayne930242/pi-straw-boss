import assert from "node:assert/strict";
import { test } from "node:test";
import type { Net, Unit } from "../src/net.ts";
import type { Mark } from "../src/netdata.ts";
import { RULES, rulesOf } from "../gui/faces.ts";
import { activityOf } from "../gui/zenunits.ts";
import { type Face, MODES, VIEWS } from "../src/views.ts";

// The rules table (gui/faces.ts) is the one place that says what a view does beyond its skin, as typegate.test.ts is for the server's typing rule: each row is written out in full, so a changed cell fails here and nowhere else.
const STANDARD = { count: true, signal: true, announce: "arrivals", keys: "dialogs", drawer: true, calm: true, chime: true, escape: "stay" } as const;

test("Standard: the tab icon counts, arrivals make the clips and reminders, the dialog keys and the drawer are on, the page calms, new link notices chime, Esc stays in a filled field", () => {
	assert.deepEqual(RULES.standard, STANDARD);
});

test("Geek is Standard's behavior with one difference: its stylesheet keeps the still signs always, so the page never calms", () => {
	assert.deepEqual(RULES.geek, { ...STANDARD, calm: false });
});

test("Zen: no count, no clip, no Standard keys, no drawer, no chime; it announces the current item itself; calm on; Esc blurs a filled field first", () => {
	assert.deepEqual(RULES.zen, { count: false, signal: false, announce: "current", keys: "zen", drawer: false, calm: true, chime: false, escape: "blur" });
});

test("Zen shows no count anywhere: every rule that could carry one is off", () => {
	const z = RULES.zen;
	assert.equal(z.count, false, "the tab icon");
	assert.equal(z.signal, false, "the clips and the system notifications");
	assert.equal(z.chime, false, "the link bar's chime");
	assert.equal(z.drawer, false, "the drawer's per-unit list");
	assert.equal(z.announce, "current", "one item at a time, not every arrival");
});

test("rulesOf reads the face's row: Zen's while it shows, the theme's otherwise (a page that left Zen, or sits on the settings page, shows its theme)", () => {
	for (const face of ["standard", "geek", "raven", "zen"] as const) assert.equal(rulesOf(face), RULES[face]);
	assert.equal(RULES.raven, RULES.standard, "Raven Keep is a skin of Standard");
});

test("every face (each theme and the mode Zen) has a row, and no row has a field another lacks", () => {
	const views: Face[] = [...VIEWS, ...MODES];
	assert.deepEqual(Object.keys(RULES).sort(), [...views].sort());
	for (const v of views) assert.deepEqual(Object.keys(RULES[v]).sort(), Object.keys(STANDARD).sort(), v);
});

// Z4b: the status strip is the one new place Zen could leak the number of waiting items through (Z-D3).
test("Zen's status strip counts working and idle units only: what waits changes neither number, and the selector hands out no other field", () => {
	const unit = (key: string, mark: Mark, o: Partial<Unit> = {}): Unit => ({ id: key, key, control: true, name: key, role: "main", mark, subs: [], ...o });
	const net = (units: Unit[]): Net => ({ bases: [{ id: "w", label: "w", mark: "idle", outposts: [], outside: [], tower: null, tabs: [{ id: "t", label: "t", units }] }] });
	const base = [unit("a", "working"), unit("b", "idle")];
	const seen = new Set<string>();
	for (const waiting of [0, 1, 2, 5]) {
		const units = [...base, ...Array.from({ length: waiting }, (_, i) => unit(`w${i}`, i % 2 ? "waiting" : "idle", { pending: { callId: `c${i}` } as never }))];
		const strip = activityOf(net(units));
		assert.deepEqual(Object.keys(strip).sort(), ["idle", "working"]);
		assert.ok(!JSON.stringify(strip).includes("wait"), "no waiting field");
		seen.add(JSON.stringify(strip));
	}
	assert.equal(seen.size, 1, "the strip is the same with none, one, two, and five waiting");
	assert.equal(RULES.zen.count, false, "and the tab icon's count stays off");
});
