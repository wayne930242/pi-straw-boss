import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createWeather, FLASH, RAIN, THUNDER, type WeatherEnv } from "../gui/themes/raven/weather.ts";
import { declarations, rulesOf } from "./css-rules.ts";

// Raven's weather (gui/themes/raven/weather.ts) on a fake audio core and fake timers: the rain loop under the backdrop, one thunder 1 to 2 s after each flash, and every condition that silences them. No sound is made.
interface Param { value: number; ev: [string, number, number][]; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void; setTargetAtTime(v: number, t: number, k: number): void; cancelScheduledValues(t: number): void }
const param = (): Param => { const p: Param = { value: 0, ev: [], setValueAtTime: (v, t) => void p.ev.push(["set", v, t]), linearRampToValueAtTime: (v, t) => void p.ev.push(["lin", v, t]), exponentialRampToValueAtTime: (v, t) => void p.ev.push(["exp", v, t]), setTargetAtTime: (v, t) => void p.ev.push(["target", v, t]), cancelScheduledValues: () => void p.ev.push(["cancel", 0, 0]) }; return p; };

function rig() {
	const sources: { loop: boolean; started: number[]; stopped: number[]; len: number }[] = [], oscs: { started: number[] }[] = [], gains: { gain: Param; to?: unknown }[] = [], filters: { type: string; frequency: Param & { value: number } }[] = [];
	const master = { gain: param() }, asked: string[] = [];
	const ac = {
		currentTime: 100, sampleRate: 1000,
		createBuffer: (_c: number, len: number) => ({ len, getChannelData: () => new Float32Array(len) }),
		createBufferSource: () => { const s = { buffer: null as { len: number } | null, loop: false, started: [] as number[], stopped: [] as number[], get len() { return s.buffer?.len ?? 0; }, connect() {}, start: (t = 100) => void s.started.push(t), stop: (t: number) => void s.stopped.push(t) }; sources.push(s); return s; },
		createBiquadFilter: () => { const f = { type: "", frequency: Object.assign(param(), { value: 0 }), connect() {} }; filters.push(f); return f; },
		createGain: () => { const n = { gain: param(), to: undefined as unknown, connect(t: unknown) { n.to = t; } }; gains.push(n); return n; },
		createOscillator: () => { const o = { type: "", frequency: param(), started: [] as number[], connect() {}, start: (t: number) => void o.started.push(t), stop() {} }; oscs.push(o); return o; },
	};
	const env = { background: true, hidden: false, backdrop: true, calm: false, fine: false, motion: true, running: true, random: 0.5 };
	const timers: { fn: () => void; ms: number; live: boolean }[] = [];
	const e: WeatherEnv = {
		audio: { out: (cls) => (asked.push(cls), { c: ac, g: master }) as never, running: () => env.running },
		backdrop: () => env.backdrop, background: () => env.background, hidden: () => env.hidden, calm: () => env.calm, fine: () => env.fine, motion: () => env.motion, random: () => env.random,
		set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
		clear: (h) => void ((h as { live: boolean }).live = false),
	};
	const w = createWeather(e);
	/** Runs every live timer (what the passing of 2 s does). */
	const wait = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
	return { asked, w, env, ac, sources, oscs, gains, filters, master, timers, wait, rainsLive: () => sources.filter((s) => s.loop && s.stopped.length === 0).length };
}

test("rain starts when Background is on, the page is visible, the browser let it play, and the backdrop shows; it is one loop of noise through a band-pass, faded in, at the stated level", () => {
	const r = rig();
	r.w.refresh();
	assert.equal(r.sources.length, 1);
	const s = r.sources[0]!;
	assert.ok(s.loop && s.started.length === 1 && s.len === RAIN.loop * 1000);
	assert.deepEqual(r.filters.map((f) => [f.type, f.frequency.value]), [["highpass", RAIN.high], ["lowpass", RAIN.low]]);
	const g = r.gains[0]!;
	assert.equal(g.to, r.master, "into the page's background gain, which the Background volume and the square law govern");
	assert.deepEqual(g.gain.ev, [["set", 0, 100], ["lin", RAIN.gain, 100 + RAIN.fadeIn]]);
	r.w.refresh();
	assert.equal(r.sources.length, 1, "a second refresh does not start a second loop");
});

test("no rain with Background off, on a hidden tab, before the browser allows audio, off the backdrop, or under calm (RS-F002: the brief says no audio when calm; a page left open stops working)", () => {
	for (const off of [{ background: false }, { hidden: true }, { running: false }, { backdrop: false }, { calm: true }] as const) {
		const r = rig();
		Object.assign(r.env, off);
		r.w.refresh();
		assert.equal(r.sources.length, 0, JSON.stringify(off));
	}
});

test("rain stops, with a short fade, when the view or the page leaves the backdrop, Sound goes off, the tab hides, or the page goes calm, and returns with the backdrop (or when calm ends)", () => {
	for (const off of [{ backdrop: false }, { background: false }, { hidden: true }, { calm: true }] as const) {
		const r = rig();
		r.w.refresh();
		Object.assign(r.env, off);
		r.w.refresh();
		const s = r.sources[0]!;
		assert.deepEqual(s.stopped, [100 + RAIN.fadeOut], JSON.stringify(off));
		assert.ok(r.gains[0]!.gain.ev.some((e) => e[0] === "target" && e[1] === 0), "faded to 0 first");
		Object.assign(r.env, { backdrop: true, background: true, hidden: false, calm: false });
		r.w.refresh();
		assert.equal(r.rainsLive(), 1, "a new loop after the return");
	}
});

test("RS-F007: rain stopped during its fade-in holds the level it reached and falls from there, so the stop is a fade and not a click", () => {
	const r = rig();
	r.w.refresh();
	const g = r.gains[0]!;
	g.gain.value = 0.012; // the level the fade-in has reached 1 s in
	g.gain.ev.length = 0;
	r.env.backdrop = false;
	r.w.refresh();
	assert.deepEqual(g.gain.ev, [["cancel", 0, 0], ["set", 0.012, 100], ["target", 0, 100]], "cancel the ramp, hold where it was, then fall to 0");
});

test("a flash makes one thunder after 1 to 2 s: the wait is a point of [1000, 2000] ms and the thunder plays once, when the wait ends", () => {
	for (const [random, ms] of [[0, 1000], [0.5, 1500], [0.999, 1999]] as const) {
		const r = rig();
		Object.assign(r.env, { random });
		r.w.flash();
		assert.equal(r.timers.length, 1);
		assert.ok(Math.abs(r.timers[0]!.ms - ms) < 1.5, `${r.timers[0]!.ms} for random ${random}`);
		assert.ok(r.timers[0]!.ms >= THUNDER.delay[0] && r.timers[0]!.ms <= THUNDER.delay[1]);
		assert.equal(r.oscs.length, 0, "nothing sounds at the flash itself");
		r.wait();
		assert.equal(r.oscs.length, 1, "one thunder");
		assert.equal(r.sources.filter((s) => !s.loop).length, 1);
		assert.deepEqual(r.oscs[0]!.started, [100]);
	}
});

test("each flash has its own thunder, and the waits vary within the window", () => {
	const r = rig();
	const seen = new Set<number>();
	for (const random of [0.1, 0.4, 0.8]) (r.env.random = random), r.w.flash();
	r.timers.forEach((t) => seen.add(Math.round(t.ms)));
	assert.equal(seen.size, 3);
	r.wait();
	assert.equal(r.oscs.length, 3);
});

test("no thunder with Background off, a hidden tab, calm, reduced motion, before audio is allowed, or off the backdrop", () => {
	for (const off of [{ background: false }, { hidden: true }, { calm: true }, { motion: false }, { running: false }, { backdrop: false }] as const) {
		const r = rig();
		Object.assign(r.env, off);
		r.w.flash();
		assert.equal(r.timers.length, 0, `no wait is set: ${JSON.stringify(off)}`);
		r.wait();
		assert.equal(r.oscs.length, 0);
	}
});

test("on a fine pointer calm does not stop the thunder (the lightning goes on there; boss 2026-11-09), and rain keeps playing; on a coarse pointer calm still stops both", () => {
	const r = rig();
	Object.assign(r.env, { calm: true, fine: true });
	r.w.refresh();
	assert.equal(r.rainsLive(), 1, "rain keeps playing under calm on a fine pointer (boss 2026-11-12)");
	Object.assign(r.env, { calm: false });
	r.w.refresh();
	assert.equal(r.rainsLive(), 1, "calm ending does not restart it");
	Object.assign(r.env, { calm: true, fine: false });
	r.w.refresh();
	assert.equal(r.rainsLive(), 0, "the pointer turning coarse under calm stops it");
	Object.assign(r.env, { fine: true });
	r.w.refresh();
	assert.equal(r.rainsLive(), 1);
	r.w.flash();
	assert.equal(r.timers.length, 1, "a wait is set under calm on a fine pointer");
	r.wait();
	assert.equal(r.oscs.length, 1, "the thunder sounds");
	for (const off of [{ background: false }, { hidden: true }, { motion: false }, { running: false }, { backdrop: false }] as const) {
		const q = rig();
		Object.assign(q.env, { calm: true, fine: true }, off);
		q.w.flash();
		assert.equal(q.timers.length, 0, `fine and calm, still silent for ${JSON.stringify(off)}`);
	}
	const coarse = rig();
	Object.assign(coarse.env, { calm: true, fine: false });
	coarse.w.flash();
	assert.equal(coarse.timers.length, 0, "calm on a coarse pointer: no thunder (battery)");
});

test("a condition that turns up during the wait drops the thunder: calm, a hidden tab, Background off, or the page leaving the backdrop", () => {
	for (const off of [{ calm: true }, { hidden: true }, { background: false }, { backdrop: false }] as const) {
		const r = rig();
		r.w.flash();
		Object.assign(r.env, off);
		r.wait();
		assert.equal(r.oscs.length, 0, JSON.stringify(off));
	}
});

test("stop cancels a thunder that waits and stops the rain", () => {
	const r = rig();
	r.w.refresh();
	r.w.flash();
	r.w.stop();
	r.wait();
	assert.equal(r.oscs.length, 0);
	assert.equal(r.sources[0]!.stopped.length, 1);
});

test("the thunder is soft and low: its two peaks add to at most 0.15 of the background gain (measured -25 dBFS against the caw's -16.6), and its low-pass falls from under 400 Hz", () => {
	const r = rig();
	r.w.flash();
	r.wait();
	const noise = r.gains.find((g) => g.gain.ev.some((e) => e[0] === "lin" && e[1] === THUNDER.noise))!;
	assert.ok(noise && THUNDER.noise + THUNDER.hum <= 0.15, "the two peaks add to at most 0.15 of the master");
	const low = r.filters.find((f) => f.type === "lowpass")!;
	assert.deepEqual(low.frequency.ev.map((e) => [e[0], e[1]]), [["set", THUNDER.from], ["exp", THUNDER.to]]);
	assert.ok(THUNDER.from <= 400, "a low rumble: the low-pass starts under 400 Hz");
});

const root = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(root, "gui/themes/raven/raven.css"), "utf8");
const rules = rulesOf(css);

test("raven.css clocks the weather on the strike: rk-clap (61 s, delayed 7 s) runs on the layers of rk-bolt and of rk-rest, whose cycles start 50.584 s in, so the first flash and its event come 7 s after the layer shows, and rk-clap changes only `scale`", () => {
	assert.equal(FLASH, "rk-clap");
	const anims = rules.flatMap((r) => declarations(r.body).filter(([p]) => p === "animation").map(([, v]) => ({ selector: r.selector, v })));
	const FLASH_AT = 61 * 0.944;
	assert.ok(Math.abs(FLASH_AT - 57.584) < 1e-9, "57.584 s is 94.4 % of 61 s");
	for (const host of ["rk-bolt", "rk-rest"]) {
		const layers = anims.filter((x) => x.v.includes(`${host} 61s`));
		assert.equal(layers.length, 2, `${host} runs under motion and under calm on a fine pointer`);
		for (const a of layers) {
			const start = Number(new RegExp(`${host} 61s linear (-[\\d.]+)s infinite`).exec(a.v)?.[1]), clap = Number(/rk-clap 61s linear ([\d.]+)s infinite/.exec(a.v)?.[1]);
			assert.ok(start < 0, `${host}'s layer starts partway into its cycle: ${a.v}`);
			assert.ok(Math.abs(FLASH_AT + start - clap) < 1e-9, `the clock's delay ${clap} s is the instant the layer reaches its flash (${(FLASH_AT + start).toFixed(3)} s)`);
			assert.ok(clap >= 6 && clap <= 8, `the first strike is ${clap} s after the layer shows (boss 2026-11-09: a few seconds, not 57.6)`);
		}
	}
	// the perched raven takes the light on the same cycle, from the same start, and turns its head a few seconds after it shows
	for (const a of anims.filter((x) => x.v.includes("rk-perch-dark"))) assert.match(a.v, /rk-perch-dark 61s linear -50\.584s infinite/, "the raven's light shares the strike's start");
	for (const a of anims.filter((x) => x.v.includes("rk-perch-turn"))) {
		const start = Number(/rk-perch-turn 17s linear (-[\d.]+)s infinite/.exec(a.v)?.[1]);
		assert.ok(start < 0, a.v);
		const frames = [...(/@keyframes rk-perch-turn \{(.*)\}\n/.exec(css)?.[1] ?? "").matchAll(/(\d+)%(?:, (\d+)%)? \{ opacity: ([\d.]+)/g)];
		const turnedAt = Number(frames.find((f) => f[3] === "1")![1]) / 100 * 17 + start;
		assert.ok(turnedAt >= 2 && turnedAt <= 6, `the head is turned ${turnedAt.toFixed(1)} s after the raven shows`);
	}
	for (const name of ["rk-bolt", "rk-rest"]) assert.match(css, new RegExp(`@keyframes ${name} \\{ 0%, 94\\.3% \\{`), `${name} flashes at 94.3 to 94.4 % (a tenth of a second's rise, round 3)`);
	assert.match(css, /@keyframes rk-clap \{ from, to \{ scale: 1; \} \}/);
	// the clock sits inside the no-preference blocks: not under calm unless the pointer is fine (the strike's own block), never under reduced motion
	const start = css.indexOf("@media (prefers-reduced-motion: no-preference)");
	for (const line of css.split("\n").filter((l) => l.includes("rk-clap 61s"))) assert.ok(css.indexOf(line) > start && (line.includes(":not([data-calm])") || (line.includes("[data-calm]") && line.trimStart().startsWith("html[data-view=\"raven\"][data-calm]"))), "inside the motion block, and under calm only in the fine-pointer block");
	assert.match(css, /@media \(prefers-reduced-motion: no-preference\) and \(pointer: fine\) \{[^@]*rk-clap 61s linear 7s infinite/, "the calm exemption is for a fine pointer");
});

test("the rain and the thunder are background sound: every node they take from the core is the background class's, and the sound effects' switch is not theirs to read", () => {
	const r = rig();
	r.w.refresh();
	r.w.flash();
	r.wait();
	assert.ok(r.asked.length >= 2 && r.asked.every((c) => c === "background"), `asked ${[...new Set(r.asked)]}`);
	assert.ok(r.oscs.length >= 1, "the thunder sounded");
	assert.doesNotMatch(readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "gui/themes/raven/weather.ts"), "utf8"), /prefs\.(get|on)\("effects/, "the weather reads no effects pref");
});
