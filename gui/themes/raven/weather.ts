import { audio, type Audio } from "../../audio.ts";
import { prefs } from "../../prefs.ts";

// The keep's weather (boss, 2026-11-08: 「背景的雨聲和閃電的雷聲（兩個都不要太大聲），雷聲要比閃電慢一兩秒」): a quiet rain loop under the backdrop (the map and the head page) and a low thunder 1 to 2 s after each lightning flash.
// Both are synthesized on the page's one audio core (audio.ts; background sound: the Background switch and volume govern them, the sound effects' do not), no files: rain is a looped noise through a band-pass, thunder a low-passed brown noise that falls in pitch and rolls twice.
// The flash is the stylesheet's own clock: raven.css runs a no-op `rk-clap` animation beside the strike on the same layer, 61 s long and delayed to the strike's instant (94.4 % of the cycle), so its `animationstart` / `animationiteration` is the flash itself, whichever page shows it.
// Nothing sounds with Background off, on a hidden tab, before the browser let the page play (the first press), or off the backdrop; no thunder under prefers-reduced-motion either, where the lightning is off.
// Calm (no input for 30 s) stops the rain, the lightning, and its thunder on a coarse pointer (a phone: battery). On a fine pointer (boss, 2026-11-09: a boss watching untouched never saw a flash; 2026-11-12: the rain stopped mid-play) the rain plays on and raven.css keeps the strike running, so the thunder sounds: the strike is
// one animation of its own layer, first a few seconds after the backdrop shows and then every 61 s, so under calm nothing else moves.
type Ctx = ReturnType<Audio["out"]>["c"];

/** Rain: seconds of noise in the loop, the band-pass edges (Hz), the level at the master gain (the noise's RMS is about a quarter of it), and the fades in seconds. */
export const RAIN = { loop: 4, high: 700, low: 5200, gain: 0.03, fadeIn: 2.5, fadeOut: 0.8 };
/** Thunder: the wait after the flash (ms, a random point of it each time), the noise's low-pass falling from `from` to `to` Hz over `fall` s, the noise's peak gain, a low sine's (gain, Hz), the rise, the main decay and the two rolls (offset s, share of the peak), and the length in seconds. */
export const THUNDER = { delay: [1000, 2000] as const, from: 380, to: 90, fall: 3, noise: 0.1, hum: 0.01, hz: 46, attack: 0.4, tau: 1.5, rolls: [[1.1, 0.55], [2.3, 0.35]] as const, length: 6 };
export const FLASH = "rk-clap";

export interface WeatherEnv {
	audio: Pick<Audio, "out" | "running">;
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

const noise = (c: Ctx, seconds: number, brown: boolean) => {
	const buf = c.createBuffer(1, Math.max(1, Math.round(c.sampleRate * seconds)), c.sampleRate), d = buf.getChannelData(0);
	let last = 0;
	for (let i = 0; i < d.length; i++) {
		const white = Math.random() * 2 - 1;
		d[i] = brown ? (last = (last + 0.02 * white) / 1.02) * 3.5 : white; // brown noise for the rumble: its energy sits low
	}
	return buf;
};

/** Schedules one thunder into `dest` starting at `t`; returns its end. */
export function thunder(c: Ctx, dest: AudioNode, t: number): number {
	const T = THUNDER, src = c.createBufferSource();
	src.buffer = noise(c, T.length, true);
	const low = c.createBiquadFilter();
	low.type = "lowpass";
	low.frequency.setValueAtTime(T.from, t);
	low.frequency.exponentialRampToValueAtTime(T.to, t + T.fall);
	const env = c.createGain();
	env.gain.setValueAtTime(0, t);
	env.gain.linearRampToValueAtTime(T.noise, t + T.attack);
	env.gain.setTargetAtTime(0, t + T.attack, T.tau);
	for (const [at, share] of T.rolls) {
		env.gain.setTargetAtTime(T.noise * share, t + at, 0.25);
		env.gain.setTargetAtTime(0, t + at + 0.4, T.tau * 0.7);
	}
	src.connect(low);
	low.connect(env);
	env.connect(dest);
	src.start(t);
	src.stop(t + T.length);
	const hum = c.createOscillator(), hg = c.createGain();
	hum.type = "sine";
	hum.frequency.setValueAtTime(T.hz, t);
	hum.frequency.linearRampToValueAtTime(T.hz * 0.7, t + T.length);
	hg.gain.setValueAtTime(0, t);
	hg.gain.linearRampToValueAtTime(T.hum, t + T.attack);
	hg.gain.setTargetAtTime(0, t + T.attack, T.tau);
	hum.connect(hg);
	hg.connect(dest);
	hum.start(t);
	hum.stop(t + T.length);
	return t + T.length;
}

/** The weather on `env`: `refresh` after anything that changes whether rain is due, `flash` at each lightning flash, `stop` for good. */
export function createWeather(env: WeatherEnv) {
	let rain: { src: AudioBufferSourceNode; gain: GainNode } | undefined, buffer: AudioBuffer | undefined, owner: Ctx | undefined;
	const pending = new Set<unknown>();
	const heard = () => env.background() && !env.hidden() && env.backdrop() && env.audio.running();
	const rainDue = () => heard() && (!env.calm() || env.fine());
	const stopRain = () => {
		if (!rain) return;
		const { c } = env.audio.out("background"), { src, gain } = rain;
		rain = undefined;
		// A stop within the fade-in cancels its ramp, which would drop the level to 0 at once: hold the level reached, then fall from it.
		const level = gain.gain.value;
		gain.gain.cancelScheduledValues(c.currentTime);
		gain.gain.setValueAtTime(level, c.currentTime);
		gain.gain.setTargetAtTime(0, c.currentTime, RAIN.fadeOut / 4);
		src.stop(c.currentTime + RAIN.fadeOut);
	};
	const startRain = () => {
		const { c, g } = env.audio.out("background");
		if (owner !== c) (owner = c), (buffer = noise(c, RAIN.loop, false));
		const src = c.createBufferSource(), hp = c.createBiquadFilter(), lp = c.createBiquadFilter(), gain = c.createGain();
		src.buffer = buffer!;
		src.loop = true;
		hp.type = "highpass";
		hp.frequency.value = RAIN.high;
		lp.type = "lowpass";
		lp.frequency.value = RAIN.low;
		gain.gain.setValueAtTime(0, c.currentTime);
		gain.gain.linearRampToValueAtTime(RAIN.gain, c.currentTime + RAIN.fadeIn);
		src.connect(hp);
		hp.connect(lp);
		lp.connect(gain);
		gain.connect(g);
		src.start();
		rain = { src, gain };
	};
	const thunderDue = () => heard() && (!env.calm() || env.fine()) && env.motion();
	return {
		refresh() {
			if (rainDue()) rain || startRain();
			else stopRain();
		},
		/** The lightning flashed: a thunder follows after 1 to 2 s if every condition still holds then. */
		flash() {
			if (!thunderDue()) return;
			const [lo, hi] = THUNDER.delay, handle = env.set(() => {
				pending.delete(handle);
				if (!thunderDue()) return;
				const { c, g } = env.audio.out("background");
				thunder(c, g, c.currentTime);
			}, lo + env.random() * (hi - lo));
			pending.add(handle);
		},
		stop() {
			for (const h of pending) env.clear(h);
			pending.clear();
			stopRain();
		},
	};
}

/**
 * Wires the weather to the page: the view and calm marks on <html>, the stage's view, the Background switch, visibility, the first press, and the stylesheet's flash clock. Returns what undoes it.
 * The press, key, and animation listeners are on the document only while the weather can sound (Background on, tab visible, backdrop shown): Raven's code stays loaded for the page's life, and the other views must not pay for it (a press would make the audio context, an animation listener makes the browser report every iteration of every animation).
 * `now` is the clock the late-event check reads.
 */
export function mountWeather(root: HTMLElement = document.documentElement, a: Audio = audio, now: () => number = () => performance.now(), frame: (fn: () => void) => void = (fn) => void requestAnimationFrame(fn)): () => void {
	const env: WeatherEnv = {
		audio: a,
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
		if (!live) return; // the Background pref's listener cannot be taken off
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
	prefs.on("background", switched);
	document.addEventListener("visibilitychange", seen);
	refresh();
	return () => {
		live = false;
		watch.disconnect();
		swatch.disconnect();
		document.removeEventListener("visibilitychange", seen);
		hook(false);
		w.stop();
	};
}
