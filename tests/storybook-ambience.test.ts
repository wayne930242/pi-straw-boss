import assert from "node:assert/strict";
import { test } from "node:test";
import { ambience, audible, ambienceGain } from "../gui/ambience.ts";
import { mountPhase } from "../gui/phaseclock.ts";
import { fakeClock } from "./fake-clock.ts";

test("only Storybook map/head, visible, Background on; calm rests on coarse pointers", () => {
	for (const stage of ["map", "head", "chat", "settings"]) {
		assert.equal(audible(stage, true, false, false, false), ["map", "head"].includes(stage));
	}
	assert.equal(audible("map", false, false, false, true), false);
	assert.equal(audible("map", true, true, false, true), false);
	assert.equal(audible("map", true, false, true, false), false);
	assert.equal(audible("map", true, false, true, true), true);
});

test("only current phase loads; 18:00 cross-fades, muting stops both voices", async () => {
	const clock = fakeClock(new Date(2026, 10, 26, 17, 59, 59).getTime());
	const phase = mountPhase({ clock: { now: clock.now, setTimeout: (fn, ms) => clock.at(clock.elapsed() + ms, fn), clearTimeout() {} } });
	const log: string[] = []; let on = true;
	const refresh = ambience(() => on ? phase.phase() : undefined, async p => (log.push(`load ${p}`), {} as AudioBuffer), (_, fade) => {
		const p = phase.phase(); log.push(`play ${p} ${fade}`);
		return { fade: () => log.push(`fade ${p}`), stop: () => log.push(`stop ${p}`) };
	});
	phase.onShift(refresh); refresh(); await Promise.resolve();
	assert.deepEqual(log.splice(0), ["load day", "play day false"]);
	clock.advance(1000); await Promise.resolve();
	assert.deepEqual(log.splice(0), ["load night", "fade day", "play night true"]);
	on = false; refresh(); assert.deepEqual(log.splice(0), ["stop night", "stop day"]);
	on = true; refresh(); on = false; refresh(); await Promise.resolve();
	assert.deepEqual(log, ["load night"], "late decode after mute cannot start playback");
});

test("ambience sits near Raven's rain: about -42 dBFS mean before the Background volume", () => {
	const mean = { day: -20.9, night: -17.9 };
	for (const p of ["day", "night"] as const) assert.ok(Math.abs(mean[p] + 20 * Math.log10(ambienceGain(mean[p])) + 42) < 1, p);
});
