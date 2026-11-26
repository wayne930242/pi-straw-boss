import { playLoop } from "../../ambience.ts";
import { type Audio } from "../../audio.ts";
import { prefs } from "../../prefs.ts";

// The keep's weather (boss, 2026-11-08: 「背景的雨聲和閃電的雷聲（兩個都不要太大聲），雷聲要比閃電慢一兩秒」): a quiet rain loop under the backdrop (the map and the head page) and a low thunder 1 to 2 s after each lightning flash.
// Both are recorded clips (sounds/rain.mp3, a seamless 4 s loop, and sounds/thunder.mp3, a distant roll; Casper's free sound effects, NOTICE.md) played on the page's one audio core (audio.ts; background sound: the Background switch and volume govern them,
// the sound effects' do not). Each clip is fetched and decoded the first time it is due (`loadClips`), and the rain loops as one buffer source (`loop`, its edges trimmed of the encoder's silence), so it repeats with no gap.
// The flash is the stylesheet's own clock: raven.css runs a no-op `rk-clap` animation beside the strike on the same layer, 61 s long and delayed to the strike's instant (94.4 % of the cycle), so its `animationstart` / `animationiteration` is the flash itself, whichever page shows it.
// Nothing sounds with Background off, on a hidden tab, before the browser let the page play (the first press), or off the backdrop; no thunder under prefers-reduced-motion either, where the lightning is off.
// Calm (no input for 30 s) stops the rain, the lightning, and its thunder on a coarse pointer (a phone: battery). On a fine pointer (boss, 2026-11-09: a boss watching untouched never saw a flash; 2026-11-12: the rain stopped mid-play) the rain plays on and raven.css keeps the strike running, so the thunder sounds: the strike is
// one animation of its own layer, first a few seconds after the backdrop shows and then every 61 s, so under calm nothing else moves.
/** Thunder: the wait after the flash (ms, a random point of it each time) and the level at the background gain (the clip peaks at -3.8 dBFS: about -22 dBFS, a mean near -40, before the Background volume). */
export const THUNDER = { delay: [1000, 2000] as const, gain: 0.12 };
export const FLASH = "rk-clap";

export type Clip = "rain" | "thunder";
/** A clip when it is decoded; else undefined, and `ready` is told once it can play (the first ask starts the fetch). */
export type ClipSource = (name: Clip, ready: () => void) => AudioBuffer | undefined;

export interface WeatherEnv {
	audio: Pick<Audio, "out" | "running">;
	clip: ClipSource;
	meanDbfs: number;
	/** Raven's backdrop is on the page: the view is Raven and the stage is the map or the head page. */
	backdrop(): boolean;
	/** The Background switch (the rain and the thunder are background sound). */
	background(): boolean;
	hidden(): boolean;
	/** The page is calm (no input for a while): the rain and the lightning rest unless the pointer is fine. */
	calm(): boolean;
	/** The primary pointer is fine (a mouse or a trackpad): calm leaves the rain and the lightning running there. */
	fine(): boolean;
	/** prefers-reduced-motion: no-preference. */
	motion(): boolean;
	random(): number;
	set(fn: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

/** The clips from `urls`, fetched and decoded on the background class's context the first time each is asked for; a failed fetch or decode is tried again at the next ask. */
export function loadClips(a: Pick<Audio, "out">, urls: Record<Clip, string>, bytes: (url: string) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))): ClipSource {
	const got = new Map<Clip, AudioBuffer>(), waiting = new Map<Clip, (() => void)[]>();
	return (name, ready) => {
		const hit = got.get(name);
		if (hit) return hit;
		const queue = waiting.get(name);
		if (queue) return void queue.push(ready);
		waiting.set(name, [ready]);
		const { c } = a.out("background");
		void bytes(urls[name]).then((b) => c.decodeAudioData(b)).then((buf) => void got.set(name, buf), () => {}).finally(() => {
			const told = waiting.get(name) ?? [];
			waiting.delete(name);
			if (got.has(name)) for (const fn of told) fn();
		});
		return undefined;
	};
}

/** The loop's edges in seconds: the clip's first and last samples above silence, so the decoder's padding (an MP3 encoder's delay, where a browser keeps it) is no gap in the loop; [0, 0] (the whole buffer) when none is found. */
export function loopEdges(buf: Pick<AudioBuffer, "sampleRate"> & { getChannelData?(i: number): Float32Array }): [number, number] {
	const d = buf.getChannelData?.(0), max = Math.round(buf.sampleRate * 0.2), loud = (i: number) => Math.abs(d![i]!) >= 1e-4;
	if (!d?.length) return [0, 0];
	let a = 0, b = d.length - 1;
	while (a < max && a < d.length && !loud(a)) a++;
	while (b > d.length - 1 - max && b > 0 && !loud(b)) b--;
	if (a >= d.length || !loud(a)) a = 0; // no sound within the first 200 ms: keep the start
	if (b <= 0 || !loud(b)) b = d.length - 1;
	return b > a && (a > 0 || b < d.length - 1) ? [a / buf.sampleRate, (b + 1) / buf.sampleRate] : [0, 0];
}

/** The weather on `env`: `refresh` after anything that changes whether rain is due, `flash` at each lightning flash, `stop` for good. */
export function createWeather(env: WeatherEnv) {
	let rain: ReturnType<typeof playLoop> | undefined, over = false;
	const pending = new Set<unknown>(), rolls = new Set<AudioBufferSourceNode>();
	const heard = () => !over && env.background() && !env.hidden() && env.backdrop() && env.audio.running();
	const rainDue = () => heard() && (!env.calm() || env.fine());
	const stopRain = () => {
		rain?.stop(); rain = undefined;
	};
	const startRain = () => {
		const buf = env.clip("rain", refresh); // not decoded yet: the rain starts at the refresh its arrival makes, if it is still due
		if (!buf) return;
		rain = playLoop(env.audio, buf, env.meanDbfs, 2.5, loopEdges(buf));
	};
	function refresh() {
		if (rainDue()) rain || startRain();
		else stopRain();
	}
	const thunderDue = () => heard() && (!env.calm() || env.fine()) && env.motion();
	/** One thunder now, if it is still due; a clip still on its way plays when it arrives, if it is due then. */
	const boom = () => {
		if (!thunderDue()) return;
		const buf = env.clip("thunder", boom);
		if (!buf) return;
		const { c, g } = env.audio.out("background"), src = c.createBufferSource(), gain = c.createGain();
		src.buffer = buf;
		gain.gain.setValueAtTime(THUNDER.gain, c.currentTime);
		src.connect(gain);
		gain.connect(g);
		rolls.add(src);
		src.onended = () => { rolls.delete(src); src.disconnect(); gain.disconnect(); };
		src.start(c.currentTime);
	};
	return {
		refresh,
		/** The lightning flashed: a thunder follows after 1 to 2 s if every condition still holds then (its clip is asked for now, so the first one is decoded in time). */
		flash() {
			if (!thunderDue()) return;
			env.clip("thunder", () => {});
			const [lo, hi] = THUNDER.delay, handle = env.set(() => (pending.delete(handle), boom()), lo + env.random() * (hi - lo));
			pending.add(handle);
		},
		stop() {
			for (const h of pending) env.clear(h);
			pending.clear();
			for (const src of rolls) src.stop();
			rolls.clear();
			stopRain();
			over = true; // a clip that arrives later starts nothing
		},
	};
}

/**
 * Wires the weather to the page: the view and calm marks on <html>, the stage's view, the Background switch, visibility, the first press, and the stylesheet's flash clock. Returns what undoes it.
 * The press, key, and animation listeners are on the document only while the weather can sound (Background on, tab visible, backdrop shown): Raven's code stays loaded for the page's life, and the other views must not pay for it (a press would make the audio context, an animation listener makes the browser report every iteration of every animation).
 * `now` is the clock the late-event check reads; `clip` gives the rain and the thunder (index.ts passes `loadClips` over the theme's two files; with none the weather is silent).
 */
export function mountWeather(a: Audio, clip: ClipSource, meanDbfs: number, root: HTMLElement = document.documentElement, now: () => number = () => performance.now(), frame: (fn: () => void) => void = (fn) => void requestAnimationFrame(fn)): () => void {
	const env: WeatherEnv = {
		audio: a,
		clip, meanDbfs,
		backdrop: () => root.dataset.view === "raven" && ["map", "head"].includes(document.getElementById("stage")?.dataset.view ?? ""),
		background: () => prefs.get("background"),
		hidden: () => document.hidden,
		calm: () => root.hasAttribute("data-calm"),
		fine: () => matchMedia("(pointer: fine)").matches,
		motion: () => matchMedia("(prefers-reduced-motion: no-preference)").matches,
		random: Math.random,
		set: (fn, ms) => setTimeout(fn, ms),
		clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
	};
	const w = createWeather(env);
	let live = true, hooked = false, shown = -Infinity, back = false;
	// A press or key lets the browser play: the context is resumed then.
	const press = () => void a.unlock().then(refresh);
	const flash = (e: Event) => {
		// A late event is not the flash: a stamp from long ago (a stalled page), or one in the catch-up after a hidden tab came back, when Blink stamps the event as it creates it: until the first frame after the return has run (under load it can take over a second), and for a second after it (RS2-F001).
		if ((e as AnimationEvent).animationName === FLASH && !back && now() - e.timeStamp < 1000 && now() - shown >= 1000) w.flash();
	};
	const hook = (on: boolean) => {
		if (on === hooked) return;
		hooked = on;
		for (const type of ["pointerdown", "keydown"]) document[on ? "addEventListener" : "removeEventListener"](type, press, true);
		for (const type of ["animationstart", "animationiteration"]) document[on ? "addEventListener" : "removeEventListener"](type, flash, true);
	};
	function refresh() {
		if (!live) return; // an unlock or observer callback may already be queued
		hook(env.background() && !env.hidden() && env.backdrop());
		w.refresh();
	}
	const seen = () => {
		if (!document.hidden) {
			shown = now();
			back = true;
			frame(() => ((back = false), (shown = now())));
		}
		refresh();
	};
	// The Background switch turned on is a press the hooks above were not on for: unlock in that gesture, when the page has one (a switch drawn at load has none).
	const switched = () => {
		refresh();
		if (live && hooked && !a.running() && navigator.userActivation?.isActive) press();
	};
	const watch = new MutationObserver(refresh);
	watch.observe(root, { attributes: true, subtree: true, attributeFilter: ["data-view", "data-calm"] });
	// notify.ts redraws the Background switch (`data-state`) when it changes in this tab; another tab's change arrives as a storage event.
	const sw = document.getElementById("background"), swatch = new MutationObserver(switched);
	if (sw) swatch.observe(sw, { attributes: true, attributeFilter: ["data-state"] });
	const off = prefs.on("background", switched);
	document.addEventListener("visibilitychange", seen);
	refresh();
	return () => {
		live = false; off();
		watch.disconnect();
		swatch.disconnect();
		document.removeEventListener("visibilitychange", seen);
		hook(false);
		w.stop();
	};
}
