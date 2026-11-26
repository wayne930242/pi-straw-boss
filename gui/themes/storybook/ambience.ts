import { audio } from "../../audio.ts";
import type { Phase } from "../../phase.ts";
import { prefs } from "../../prefs.ts";

export function audible(view: string | undefined, stage: string | undefined, background: boolean, hidden: boolean, calm: boolean, fine: boolean) {
	return view === "storybook" && (stage === "map" || stage === "head") && background && !hidden && (!calm || fine);
}

interface Voice { fade(): void; stop(): void }
export function ambience(due: () => Phase | undefined, load: (phase: Phase) => Promise<AudioBuffer>, play: (buffer: AudioBuffer, fadeIn: boolean) => Voice) {
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
			current = play(buffer, !!fading);
		}).catch(() => { if (ticket === generation) { current?.stop(); fading?.stop(); current = fading = phase = undefined; } });
	};
}

export function mountAmbience(phase: () => Phase, urls: Record<Phase, string>) {
	const cache = new Map<Phase, Promise<AudioBuffer>>(), fine = matchMedia("(pointer: fine)");
	const eligible = () => audible(document.documentElement.dataset.view, document.getElementById("stage")?.dataset.view, prefs.get("background"), document.hidden, document.documentElement.hasAttribute("data-calm"), fine.matches);
	const refresh = ambience(() => eligible() && audio.running() ? phase() : undefined, p => {
		if (!cache.has(p)) cache.set(p, fetch(urls[p]).then(r => { if (!r.ok) throw Error(String(r.status)); return r.arrayBuffer(); }).then(b => audio.out("background").c.decodeAudioData(b)).catch(e => { cache.delete(p); throw e; }));
		return cache.get(p)!;
	}, (buffer, crossfade) => {
		const { c, g } = audio.out("background"), source = c.createBufferSource(), gain = c.createGain(), level = 10 ** (-12 / 20);
		source.buffer = buffer; source.loop = true; source.connect(gain); gain.connect(g);
		gain.gain.setValueAtTime(crossfade ? 0 : level, c.currentTime);
		if (crossfade) gain.gain.linearRampToValueAtTime(level, c.currentTime + 3);
		source.onended = () => { source.disconnect(); gain.disconnect(); };
		const started = c.currentTime;
		source.start();
		return { fade() { const now = c.currentTime; gain.gain.cancelScheduledValues(now); gain.gain.setValueAtTime(crossfade ? level * Math.min(1, (now - started) / 3) : level, now); gain.gain.linearRampToValueAtTime(0, now + 3); source.stop(now + 3); }, stop() { source.stop(); } };
	});
	const press = () => { if (eligible() && !audio.running()) void audio.unlock().then(refresh); else refresh(); };
	for (const event of ["pointerdown", "keydown"]) document.addEventListener(event, press, true);
	const switched = () => { if (navigator.userActivation?.isActive) press(); else refresh(); };
	const sw = document.getElementById("background");
	if (sw) new MutationObserver(switched).observe(sw, { attributes: true, attributeFilter: ["data-state"] });
	new MutationObserver(refresh).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-calm", "data-view"] });
	prefs.on("background", switched); fine.addEventListener("change", refresh); document.addEventListener("visibilitychange", refresh);
	refresh(); return refresh;
}
