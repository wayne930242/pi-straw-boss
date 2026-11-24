// The page's one playback core: every view's sounds (the question clip, Zen's later sounds and music, Raven's weather) play through one AudioContext and one gain for each of the two classes (todo #139).
// A sound is one of two classes: `effects` (the cues of events: the clips, Zen's bowl and knock) and `background` (what plays under the page: Zen's music, Raven's rain and thunder). Each class has its own gain,
// which follows the square of that class's Volume (0 to 100; an iPhone honours a gain); a class's switch is the source's own check, so a source asks the core for its class by name and no sound reaches the output without one.
// The context is made at the first play or unlock and resumed at each (a browser that blocks sound before any press keeps it suspended).
// `out(class)` is for the views' own nodes (Zen's effects, its music bus in audiobus.ts); `running()` says whether a sound due now would be heard (a suspended context queues it; Zen drops an effect instead).
type Ctx = Pick<AudioContext, "createGain" | "createBufferSource" | "createOscillator" | "createBuffer" | "createBiquadFilter" | "sampleRate" | "createMediaElementSource" | "decodeAudioData" | "resume" | "destination" | "currentTime" | "state">;
export type SoundClass = "effects" | "background";
/** `play`: a short clip (an effect), decoded whole and kept (the Standard sounds, Zen's effects), never music; `fallback` is the clip to play instead when this one fails to fetch or decode (a theme's clip, Standard's). `unlock`: called from a user gesture; false when the browser refused to resume. */
export interface Audio { play(url: string, fallback?: string): void; volume(cls: SoundClass, v: number): void; unlock(): Promise<boolean>; out(cls: SoundClass): { c: Ctx; g: GainNode }; running(): boolean }

export function createAudio(make: () => Ctx = () => new AudioContext(), bytes: (url: string) => Promise<ArrayBuffer> = (u) => fetch(u).then((r) => r.arrayBuffer())): Audio {
	let ac: Ctx | undefined;
	const gains: Partial<Record<SoundClass, GainNode>> = {}, levels: Record<SoundClass, number> = { effects: 1, background: 1 };
	const clips = new Map<string, Promise<AudioBuffer>>();
	const out = (cls: SoundClass) => {
		ac ??= make();
		if (!gains[cls]) (gains[cls] = ac.createGain()).connect(ac.destination), (gains[cls]!.gain.value = levels[cls]);
		return { c: ac, g: gains[cls]! };
	};
	return {
		volume: (cls, v) => void ((levels[cls] = (v / 100) ** 2), gains[cls] && (gains[cls]!.gain.value = levels[cls])),
		unlock: () => out("effects").c.resume().then(() => out("effects").c.state === "running", () => false),
		out,
		running: () => ac?.state === "running",
		play(url, fallback) {
			const { c, g } = out("effects");
			if (!clips.has(url)) clips.set(url, bytes(url).then((b) => c.decodeAudioData(b)));
			void Promise.all([c.resume(), clips.get(url)!]).then(([, clip]) => {
				const s = c.createBufferSource();
				s.buffer = clip;
				s.connect(g);
				s.start();
			}).catch(() => (clips.delete(url), fallback && fallback !== url && this.play(fallback)));
		},
	};
}
/** The page's own. */
export const audio = createAudio();
