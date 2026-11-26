import assert from "node:assert/strict";
import { test } from "node:test";
import { nextBoundary, phaseAt } from "../gui/phase.ts";
import { mountPhase, RECHECK_MS } from "../gui/phaseclock.ts";
import { manifests } from "./theme-fixture.ts";
import { mountView } from "../gui/view.ts";
import { boot } from "./bootrun.ts";
import { fakeClock } from "./fake-clock.ts";

// Storybook's day and night (docs/specs/2026-11-26-storybook-theme/spec.md §B2, §B9): the device's local hours decide (day 06:00 to 17:59), boot.js paints the first frame in the right phase with its theme-color, and the theme's clock moves the page
// at the boundary, or when the page comes back from sleep, with no reload. The clock is a fake one the test moves (tests/fake-clock.ts).

const at = (h: number, m = 0) => new Date(2026, 10, 26, h, m);

test("the phase is day from 06:00 to 17:59 and night from 18:00 to 05:59, by the local hour", () => {
	for (let h = 0; h < 24; h++) assert.equal(phaseAt(at(h, 30)), h >= 6 && h < 18 ? "day" : "night", `${h}:30`);
	assert.equal(phaseAt(at(5, 59)), "night");
	assert.equal(phaseAt(at(6, 0)), "day");
	assert.equal(phaseAt(at(17, 59)), "day");
	assert.equal(phaseAt(at(18, 0)), "night");
});

test("boot.js's phase agrees with gui/phase.ts for all 24 hours, and its first frame takes the phase and its theme-color only for Storybook", () => {
	const sb = boot(null, false, null).resolve;
	for (let h = 0; h < 24; h++) assert.equal(sb.phase(h), phaseAt(at(h)), `hour ${h}`);
	for (let h = 0; h < 24; h++) {
		const page = boot("storybook", false, null, { hours: h });
		const phase = phaseAt(at(h));
		assert.deepEqual([page.view, page.phase, page.color], ["storybook", phase, (manifests.storybook.color as Record<typeof phase, string>)[phase]], `hour ${h}`);
	}
	assert.equal(boot("storybook", false, null, { hours: 7 }).color, "#fbf5e9", "day: the cream page");
	assert.equal(boot("storybook", false, null, { hours: 22 }).color, "#111a35", "night: the night sky");
	assert.equal(boot(null, false, "storybook", { hours: 22 }).phase, "night", "the server's default Storybook too");
	assert.equal(boot("raven", false, null, { hours: 22 }).phase, undefined, "another theme has no phase");
	assert.equal(boot("storybook", false, null, { hours: 22, zen: "1" }).phase, undefined, "Zen shows: no phase on <html>");
});

test("the next boundary is the next 06:00 or 18:00", () => {
	assert.deepEqual(nextBoundary(at(3, 10)), at(6));
	assert.deepEqual(nextBoundary(at(6, 0)), at(18));
	assert.deepEqual(nextBoundary(at(17, 59)), at(18));
	assert.deepEqual(nextBoundary(at(18, 0)), new Date(2026, 10, 27, 6));
	assert.deepEqual(nextBoundary(at(23, 59)), new Date(2026, 10, 27, 6));
});

/** A fake clock with timers on it, and a page of plain objects. */
function world(start: Date) {
	const clock = fakeClock(start.getTime());
	const timers = new Map<number, { at: number; fn: () => void }>();
	let id = 0;
	const seam = {
		now: clock.now,
		setTimeout: (fn: () => void, ms: number) => (timers.set(++id, { at: clock.now() + ms, fn }), id),
		clearTimeout: (h: unknown) => void timers.delete(h as number),
	};
	/** Moves the clock, running each timer that comes due, in order. */
	const advance = (ms: number) => {
		const end = clock.now() + ms;
		for (;;) {
			const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
			if (!next || next[1].at > end) break;
			clock.advance(next[1].at - clock.now());
			timers.delete(next[0]);
			next[1].fn();
		}
		clock.advance(end - clock.now());
	};
	/** Moves the clock with no timer running (a phone asleep). */
	const sleep = (ms: number) => clock.advance(ms);
	const heard = new Map<string, (() => void)[]>();
	const on = { removeEventListener: (type: string, fn: () => void) => void heard.set(type, (heard.get(type) ?? []).filter(f => f !== fn)), addEventListener: (type: string, fn: () => void) => void heard.set(type, [...(heard.get(type) ?? []), fn]) };
	const doc = { visibilityState: "visible", ...on };
	const fire = (type: string) => heard.get(type)?.forEach((fn) => fn());
	const root = { dataset: { view: "storybook" } as Record<string, string | undefined> };
	return { seam, advance, sleep, doc, win: on, fire, root, timers };
}

test("the clock switches the phase at 18:00 on its timer, paints data-phase, and tells the page once", () => {
	const w = world(at(17, 50));
	const told: string[] = [];
	const ph = mountPhase({ clock: w.seam, root: w.root, doc: w.doc, win: w.win });
	ph.onShift((p) => told.push(p));
	assert.equal(w.root.dataset.phase, "day");
	w.advance(9 * 60_000);
	assert.deepEqual(told, [], "17:59 is still day");
	w.advance(60_000);
	assert.deepEqual([told, w.root.dataset.phase], [["night"], "night"], "18:00");
	w.advance(11.9 * 3600_000);
	assert.deepEqual(told, ["night"], "05:54: still night");
	w.advance(0.2 * 3600_000);
	assert.deepEqual([told, w.root.dataset.phase], [["night", "day"], "day"], "the next morning at 06:00");
	assert.equal(w.timers.size, 1, "one timer armed at a time");
	ph.stop();
	w.fire("pageshow"); w.fire("visibilitychange");
	assert.equal(w.timers.size, 0, "a stopped clock cannot re-arm on return");
});

test("a phone that slept through 06:00 takes the day when it is shown again, before any timer fires; pageshow does the same", () => {
	const w = world(at(23, 0));
	const told: string[] = [];
	const ph = mountPhase({ clock: w.seam, root: w.root, doc: w.doc, win: w.win });
	ph.onShift((p) => told.push(p));
	w.sleep(8 * 3600_000 + 10 * 60_000); // 07:10, no timer ran
	assert.equal(w.root.dataset.phase, "night", "nothing ran while asleep");
	w.doc.visibilityState = "hidden";
	w.fire("visibilitychange");
	assert.deepEqual(told, [], "hiding is no look");
	w.doc.visibilityState = "visible";
	w.fire("visibilitychange");
	assert.deepEqual([told, w.root.dataset.phase], [["day"], "day"]);
	w.sleep(12 * 3600_000);
	w.fire("pageshow");
	assert.deepEqual(told, ["day", "night"], "pageshow at 19:10");
});

test("a snapshot looks again at most once a minute, and a page that does not show Storybook gets no data-phase", () => {
	const w = world(new Date(2026, 10, 26, 17, 59, 30));
	const told: string[] = [];
	const ph = mountPhase({ clock: w.seam, root: w.root, doc: w.doc, win: w.win });
	ph.onShift((p) => told.push(p));
	w.root.dataset.view = "zen";
	delete w.root.dataset.phase;
	w.sleep(40_000); // 18:00:10, the timer did not run (asleep)
	ph.recheck();
	assert.deepEqual(told, [], "the last look was under a minute ago");
	w.sleep(RECHECK_MS - 40_000); // 18:00:30
	ph.recheck();
	assert.deepEqual(told, ["night"], "a minute after the last look");
	assert.equal(w.root.dataset.phase, undefined, "Zen shows: the phase is not painted on <html>");
});

test("the demo's forced phase wins over the clock", () => {
	const w = world(at(12));
	const ph = mountPhase({ clock: w.seam, root: w.root, doc: w.doc, win: w.win, forced: () => "night" });
	assert.deepEqual([ph.phase(), w.root.dataset.phase], ["night", "night"]);
});

test("view.ts paints Storybook's theme-color and data-phase by the phase, and drops data-phase for another face", () => {
	let phase: "day" | "night" = "day";
	const store = new Map<string, string>([["sb.view", "storybook"]]);
	const root = { dataset: {} as Record<string, string | undefined> }, meta = { content: "#1a1b26", dataset: {} as Record<string, string | undefined> };
	const view = mountView({ themes: manifests, root, meta, media: { matches: false, addEventListener() {} }, storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) } }, () => false, () => phase);
	assert.deepEqual([root.dataset.view, root.dataset.phase, meta.content], ["storybook", "day", "#fbf5e9"]);
	phase = "night";
	view.refresh();
	assert.deepEqual([root.dataset.phase, meta.content], ["night", "#111a35"]);
	view.set("standard");
	assert.deepEqual([root.dataset.view, root.dataset.phase, meta.content], ["standard", undefined, "#1a1b26"]);
});
