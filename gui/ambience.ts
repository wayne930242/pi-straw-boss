import type { Audio } from "./audio.ts";
import type { Phase } from "./phase.ts";
import { prefs } from "./prefs.ts";
import type { LoopClip } from "./themes/manifest.ts";

const AMBIENCE_DBFS = -42;
export const ambienceGain = (meanDbfs: number) => 10 ** ((AMBIENCE_DBFS - meanDbfs) / 20);

export function audible(stage: string | undefined, background: boolean, hidden: boolean, calm: boolean, fine: boolean) {
	return (stage === "map" || stage === "head") && background && !hidden && (!calm || fine);
}

interface Voice { fade(): void; stop(): void }
/** Both kinds of loop feed the Background bus. A single loop keeps its trimmed edges and short fades; phase changes cross-fade the two full clips. */
export function playLoop(audio: Pick<Audio, "out">, buffer: AudioBuffer, meanDbfs: number, fadeIn: number, edges?: [number, number]): Voice {
	const { c, g } = audio.out("background"), source = c.createBufferSource(), gain = c.createGain(), level = ambienceGain(meanDbfs), start = c.currentTime;
	source.buffer = buffer; source.loop = true; source.connect(gain); gain.connect(g);
	if (edges && edges[1] > edges[0]) [source.loopStart, source.loopEnd] = edges;
	gain.gain.setValueAtTime(fadeIn ? 0 : level, start);
	if (fadeIn) gain.gain.linearRampToValueAtTime(level, start + fadeIn);
	source.onended = () => { source.disconnect(); gain.disconnect(); };
	source.start(start, edges?.[0] ?? 0);
	return {
		fade() {
			const now = c.currentTime;
			gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(fadeIn ? level * Math.min(1, (now - start) / fadeIn) : level, now);
			gain.gain.linearRampToValueAtTime(0, now + 3); source.stop(now + 3);
		},
		stop() {
			if (!edges) { source.stop(); return; }
			const now = c.currentTime, held = gain.gain.value;
			gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(held, now);
			gain.gain.setTargetAtTime(0, now, 0.8 / 4); source.stop(now + 0.8);
		},
	};
}

export function ambience(due: () => Phase | undefined, load: (phase: Phase) => Promise<AudioBuffer>, play: (buffer: AudioBuffer, fadeIn: boolean, phase: Phase) => Voice) {
	let phase: Phase | undefined, generation = 0, current: Voice | undefined, fading: Voice | undefined;
	return function refresh() {
		const next = due();
		if (next === phase) return;
		phase = next;
		const ticket = ++generation;
		if (!next) { current?.stop(); fading?.stop(); current = fading = undefined; return; }
		void load(next).then(buffer => {
			if (ticket !== generation || due() !== next) return;
			fading?.stop(); fading = current; fading?.fade();
			current = play(buffer, !!fading, next);
		}).catch(() => { if (ticket === generation) { current?.stop(); fading?.stop(); current = fading = phase = undefined; } });
	};
}

export function mountAmbience(audio: Audio, phase: () => Phase | undefined, clips: Partial<Record<Phase, LoopClip>>) {
	let live = true;
	const cache = new Map<Phase, Promise<AudioBuffer>>(), fine = matchMedia("(pointer: fine)");
	const eligible = () => live && audible(document.getElementById("stage")?.dataset.view, prefs.get("background"), document.hidden, document.documentElement.hasAttribute("data-calm"), fine.matches);
	const refresh = ambience(() => eligible() && audio.running() ? phase() : undefined, p => {
		if (!cache.has(p)) cache.set(p, fetch(clips[p]!.file).then(r => { if (!r.ok) throw Error(String(r.status)); return r.arrayBuffer(); }).then(b => audio.out("background").c.decodeAudioData(b)).catch(e => { cache.delete(p); throw e; }));
		return cache.get(p)!;
	}, (buffer, crossfade, p) => playLoop(audio, buffer, clips[p]!.meanDbfs, crossfade ? 3 : 0));
	const press = () => { if (eligible() && !audio.running()) void audio.unlock().then(refresh); else refresh(); };
	const switched = () => { if (navigator.userActivation?.isActive) press(); else refresh(); };
	const sw = document.getElementById("background"), toggle = new MutationObserver(switched), marks = new MutationObserver(refresh);
	if (sw) toggle.observe(sw, { attributes: true, attributeFilter: ["data-state"] });
	marks.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-calm", "data-view", "data-phase"] });
	for (const event of ["pointerdown", "keydown"]) document.addEventListener(event, press, true);
	const off = prefs.on("background", switched); fine.addEventListener("change", refresh); document.addEventListener("visibilitychange", refresh);
	refresh();
	return { stop() {
		live = false; refresh(); marks.disconnect(); toggle.disconnect(); off();
		for (const event of ["pointerdown", "keydown"]) document.removeEventListener(event, press, true);
		fine.removeEventListener("change", refresh); document.removeEventListener("visibilitychange", refresh);
	} };
}
