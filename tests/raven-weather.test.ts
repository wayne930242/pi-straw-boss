import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ambienceGain } from "../gui/ambience.ts";
import { createWeather, FLASH, loadClips, loopEdges, THUNDER, type Clip, type WeatherEnv } from "../gui/themes/raven/weather.ts";
import { declarations, rulesOf } from "./css-rules.ts";

// Raven's weather (gui/themes/raven/weather.ts) on a fake audio core and fake timers: the recorded rain loop under the backdrop, the recorded thunder 1 to 2 s after each flash, and every condition that silences them. No sound is made.
interface Param { value: number; ev: [string, number, number][]; setValueAtTime(v: number, t: number): void; linearRampToValueAtTime(v: number, t: number): void; exponentialRampToValueAtTime(v: number, t: number): void; setTargetAtTime(v: number, t: number, k: number): void; cancelScheduledValues(t: number): void }
const param = (): Param => { const p: Param = { value: 0, ev: [], setValueAtTime: (v, t) => void p.ev.push(["set", v, t]), linearRampToValueAtTime: (v, t) => void p.ev.push(["lin", v, t]), exponentialRampToValueAtTime: (v, t) => void p.ev.push(["exp", v, t]), setTargetAtTime: (v, t) => void p.ev.push(["target", v, t]), cancelScheduledValues: () => void p.ev.push(["cancel", 0, 0]) }; return p; };
/** A decoded clip: `lead` and `tail` samples of silence around a body of sound (an MP3 decoder's padding). */
const clipOf = (name: Clip, rate = 1000, lead = 0, tail = 0, body = 4000) => ({ name, sampleRate: rate, duration: (lead + body + tail) / rate, getChannelData: () => Float32Array.from({ length: lead + body + tail }, (_, i) => (i >= lead && i < lead + body ? 0.3 : 0)) });
type Src = { buffer: { name?: Clip } | null; loop: boolean; loopStart: number; loopEnd: number; started: [number, number?][]; stopped: number[] };

function rig(o: { decoded?: boolean } = {}) {
	const sources: Src[] = [], gains: { gain: Param; to?: unknown }[] = [];
	const master = { gain: param() }, asked: string[] = [];
	const ac = {
		currentTime: 100, sampleRate: 1000,
		createBufferSource: () => { const s = { buffer: null, loop: false, loopStart: 0, loopEnd: 0, started: [] as [number, number?][], stopped: [] as number[], connect() {}, start: (t = 100, off?: number) => void s.started.push(off === undefined ? [t] : [t, off]), stop: (t: number) => void s.stopped.push(t) }; sources.push(s); return s; },
		createGain: () => { const n = { gain: param(), to: undefined as unknown, connect(t: unknown) { n.to = t; } }; gains.push(n); return n; },
	};
	const env = { background: true, hidden: false, backdrop: true, calm: false, fine: false, motion: true, running: true, random: 0.5 };
	// The clips: decoded at once, or on their way until `arrive` (the fetch and the decode ending).
	const clips = { rain: clipOf("rain", 1000, 30, 20), thunder: clipOf("thunder", 1000, 0, 0, 3500) }, decoded = new Set<Clip>(o.decoded === false ? [] : ["rain", "thunder"]), waits: [Clip, () => void][] = [], wanted: Clip[] = [];
	const timers: { fn: () => void; ms: number; live: boolean }[] = [];
	const e: WeatherEnv = {
		meanDbfs: -14.9,
		audio: { out: (cls) => (asked.push(cls), { c: ac, g: master }) as never, running: () => env.running },
		clip: (name, ready) => (wanted.push(name), decoded.has(name) ? (clips[name] as never) : void waits.push([name, ready])),
		backdrop: () => env.backdrop, background: () => env.background, hidden: () => env.hidden, calm: () => env.calm, fine: () => env.fine, motion: () => env.motion, random: () => env.random,
		set: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
		clear: (h) => void ((h as { live: boolean }).live = false),
	};
	const w = createWeather(e);
	/** Runs every live timer (what the passing of 2 s does). */
	const wait = () => timers.filter((t) => t.live).forEach((t) => ((t.live = false), t.fn()));
	const arrive = (name: Clip) => (decoded.add(name), waits.splice(0).forEach(([n, f]) => (n === name ? f() : waits.push([n, f]))));
	const thunders = () => sources.filter((s) => s.buffer?.name === "thunder" && s.started.length === 1);
	return { asked, w, env, ac, sources, gains, master, timers, wait, arrive, wanted, thunders, rainsLive: () => sources.filter((s) => s.loop && s.stopped.length === 0).length };
}

test("rain starts when Background is on, the page is visible, the browser let it play, and the backdrop shows; it is the recorded clip looped as one buffer source, faded in, at the stated level", () => {
	const r = rig();
	r.w.refresh();
	assert.equal(r.sources.length, 1);
	const s = r.sources[0]!;
	assert.ok(s.loop && s.buffer?.name === "rain" && s.started.length === 1, "a looping buffer source of the rain clip: no gap at the seam, as an <audio> element's loop would leave");
	const g = r.gains[0]!;
	assert.equal(g.to, r.master, "into the page's background gain, which the Background volume and the square law govern");
	assert.deepEqual(g.gain.ev, [["set", 0, 100], ["lin", ambienceGain(-14.9), 102.5]]);
	r.w.refresh();
	assert.equal(r.sources.length, 1, "a second refresh does not start a second loop");
});

test("the loop runs between the clip's first and last sound, so a decoder's silent padding is no gap at the seam, and it starts at the first sound", () => {
	const r = rig();
	r.w.refresh();
	const s = r.sources[0]!;
	assert.deepEqual([s.loopStart, s.loopEnd], [0.03, 4.03], "30 ms of lead and 20 ms of tail are cut");
	assert.deepEqual(s.started, [[100, 0.03]]);
	assert.deepEqual(loopEdges(clipOf("rain", 1000, 0, 0)), [0, 0], "a clip with no padding: the whole buffer");
	assert.deepEqual(loopEdges({ sampleRate: 1000, getChannelData: () => new Float32Array(500) }), [0, 0], "silence throughout: the whole buffer");
});

test("the rain is fetched the first time it is due and starts when it arrives, if it is still due then; nothing is fetched before", () => {
	const r = rig({ decoded: false });
	r.env.background = false;
	r.w.refresh();
	assert.deepEqual(r.wanted, [], "not due: no fetch");
	r.env.background = true;
	r.w.refresh();
	assert.deepEqual([r.wanted, r.sources.length], [["rain"], 0], "asked for, nothing plays yet");
	r.arrive("rain");
	assert.equal(r.rainsLive(), 1, "it starts on arrival");
	const late = rig({ decoded: false });
	late.w.refresh();
	late.env.hidden = true;
	late.w.refresh();
	late.arrive("rain");
	assert.equal(late.sources.length, 0, "the tab hid while it was on its way: no rain");
	const gone = rig({ decoded: false });
	gone.w.refresh();
	gone.w.stop();
	gone.arrive("rain");
	assert.equal(gone.sources.length, 0, "stopped for good: a clip that arrives later starts nothing");
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
		assert.deepEqual(s.stopped, [100.8], JSON.stringify(off));
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

test("a flash makes one thunder after 1 to 2 s: the wait is a point of [1000, 2000] ms and the recorded thunder plays once, when the wait ends", () => {
	for (const [random, ms] of [[0, 1000], [0.5, 1500], [0.999, 1999]] as const) {
		const r = rig();
		Object.assign(r.env, { random });
		r.w.flash();
		assert.equal(r.timers.length, 1);
		assert.ok(Math.abs(r.timers[0]!.ms - ms) < 1.5, `${r.timers[0]!.ms} for random ${random}`);
		assert.ok(r.timers[0]!.ms >= THUNDER.delay[0] && r.timers[0]!.ms <= THUNDER.delay[1]);
		assert.equal(r.thunders().length, 0, "nothing sounds at the flash itself");
		r.wait();
		assert.equal(r.thunders().length, 1, "one thunder");
		assert.ok(!r.thunders()[0]!.loop);
		assert.deepEqual(r.thunders()[0]!.started, [[100]]);
	}
});

test("the thunder clip is asked for at the flash, so the first one is on its way during the wait; one that arrives after the wait plays then if it is still due, and not if the page went calm", () => {
	const r = rig({ decoded: false });
	r.w.flash();
	assert.deepEqual(r.wanted, ["thunder"], "the fetch starts at the flash");
	r.wait();
	assert.equal(r.thunders().length, 0);
	r.arrive("thunder");
	assert.equal(r.thunders().length, 1, "it plays on arrival");
	const calm = rig({ decoded: false });
	calm.w.flash();
	calm.wait();
	calm.env.calm = true;
	calm.arrive("thunder");
	assert.equal(calm.thunders().length, 0);
});

test("each flash has its own thunder, and the waits vary within the window", () => {
	const r = rig();
	const seen = new Set<number>();
	for (const random of [0.1, 0.4, 0.8]) (r.env.random = random), r.w.flash();
	r.timers.forEach((t) => seen.add(Math.round(t.ms)));
	assert.equal(seen.size, 3);
	r.wait();
	assert.equal(r.thunders().length, 3);
});

test("no thunder with Background off, a hidden tab, calm, reduced motion, before audio is allowed, or off the backdrop", () => {
	for (const off of [{ background: false }, { hidden: true }, { calm: true }, { motion: false }, { running: false }, { backdrop: false }] as const) {
		const r = rig();
		Object.assign(r.env, off);
		r.w.flash();
		assert.equal(r.timers.length, 0, `no wait is set: ${JSON.stringify(off)}`);
		r.wait();
		assert.equal(r.thunders().length, 0);
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
	assert.equal(r.thunders().length, 1, "the thunder sounds");
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
		assert.equal(r.thunders().length, 0, JSON.stringify(off));
	}
});

test("stop cancels a thunder that waits and stops the rain", () => {
	const r = rig();
	r.w.refresh();
	r.w.flash();
	r.w.stop();
	r.wait();
	assert.equal(r.thunders().length, 0);
	assert.equal(r.sources[0]!.stopped.length, 1);
});

// Both quiet (boss, 2026-11-08: 「兩個都不要太大聲」). Measured on the shipped files (ffmpeg volumedetect): rain.mp3 mean -14.9 dBFS, thunder.mp3 peak -3.8 dBFS, mean -21.9.
test("the rain and the thunder are quiet: the rain's level puts its -15 dBFS mean near -42 dBFS before the Background volume, the thunder's level keeps its -3.8 dBFS peak under -20 dBFS, and the thunder plays at that level from its start", () => {
	const db = (g: number) => 20 * Math.log10(g);
	assert.ok(-14.9 + db(ambienceGain(-14.9)) <= -40);
	assert.ok(-3.8 + db(THUNDER.gain) <= -20, `thunder peak at ${(-3.8 + db(THUNDER.gain)).toFixed(1)} dBFS`);
	const r = rig();
	r.w.flash();
	r.wait();
	const g = r.gains.at(-1)!;
	assert.deepEqual(g.gain.ev, [["set", THUNDER.gain, 100]]);
	assert.equal(g.to, r.master);
});

test("the clips are small mono MP3s: the rain a 4 s loop, the thunder 3.5 s, each at most 30 KB", () => {
	const dir = join(fileURLToPath(new URL("..", import.meta.url)), "gui/themes/raven/sounds");
	for (const name of ["rain.mp3", "thunder.mp3"]) {
		const buf = readFileSync(join(dir, name));
		assert.ok(statSync(join(dir, name)).size <= 30_000, name);
		// The first MPEG frame header after any ID3 tag: its channel-mode bits (the top two of byte 3) are 11 for mono.
		let i = buf.subarray(0, 3).toString() === "ID3" ? 10 + ((buf[6]! << 21) | (buf[7]! << 14) | (buf[8]! << 7) | buf[9]!) : 0;
		while (!(buf[i] === 0xff && (buf[i + 1]! & 0xe0) === 0xe0)) i++;
		assert.equal(buf[i + 3]! >> 6, 3, `${name} is mono`);
	}
});

test("loadClips fetches and decodes a clip once, on the background class's context, tells every caller that waited, and tries again after a failure", async () => {
	const fetched: string[] = [], decodedOn: string[] = [];
	let fail = true;
	const a = { out: (cls: string) => ({ c: { decodeAudioData: async (b: ArrayBuffer) => (decodedOn.push(cls), { bytes: b.byteLength }) } }) } as never;
	const src = loadClips(a, { rain: "/r.mp3", thunder: "/t.mp3" }, async (u) => (fetched.push(u), fail ? Promise.reject(new Error("503")) : new ArrayBuffer(7)));
	const told: string[] = [];
	assert.equal(src("rain", () => told.push("x")), undefined);
	await new Promise((r) => setImmediate(r));
	assert.deepEqual([fetched, told], [["/r.mp3"], []], "a failed fetch tells nobody");
	fail = false;
	src("rain", () => told.push("a"));
	src("rain", () => told.push("b"));
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(fetched, ["/r.mp3", "/r.mp3"], "tried again, once for the two asks");
	assert.deepEqual(told, ["a", "b"]);
	assert.deepEqual(src("rain", () => told.push("c")), { bytes: 7 }, "decoded: given at once");
	assert.deepEqual([fetched.length, decodedOn], [2, ["background"]]);
});

const root = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(join(root, "gui/themes/raven/raven.css"), "utf8");
const rules = rulesOf(css);

test("raven.css clocks the weather on the strike: rk-clap (61 s, delayed 7 s) runs on the head and map rest layers, whose cycles start 50.584 s in, so the first flash and its event come 7 s after the layer shows, and rk-clap changes only `scale`", () => {
	assert.equal(FLASH, "rk-clap");
	const anims = rules.flatMap((r) => declarations(r.body).filter(([p]) => p === "animation").map(([, v]) => ({ selector: r.selector, v })));
	const FLASH_AT = 61 * 0.944;
	assert.ok(Math.abs(FLASH_AT - 57.584) < 1e-9, "57.584 s is 94.4 % of 61 s");
	for (const route of ["head", "map"]) {
		const host = "rk-rest";
		const layers = anims.filter((x) => x.v.includes(`${host} 61s`) && x.selector.includes(`#stage[data-view="${route}"]`));
		assert.equal(layers.length, 2, `${route}: strike runs under motion and under calm on a fine pointer`);
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
	for (const name of ["rk-strike", "rk-rest"]) assert.match(css, new RegExp(`@keyframes ${name} \\{ 0%, 94\\.3% \\{`), `${name} flashes at 94.3 to 94.4 % (a tenth of a second's rise, round 3)`);
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
	assert.ok(r.thunders().length >= 1, "the thunder sounded");
	assert.doesNotMatch(readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), "gui/themes/raven/weather.ts"), "utf8"), /prefs\.(get|on)\("effects/, "the weather reads no effects pref");
});
