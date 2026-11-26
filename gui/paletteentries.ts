import { m } from "./sentences.ts";
import type { Entry } from "./palette.ts";
import type { MenuDeps } from "./zenmenu.ts";

// What Zen puts in the palette: the page's actions it can do now, then the preferences the corner menu has (no theme: it is the settings page's, O4) (the same functions, so the two never disagree), and Music when a switch for it is given.
/** The page's actions; one left out is one the page cannot do now (no companion, nothing to step to). */
export interface Acts {
	/** Leave Zen: the device's theme shows. */
	leave(): void;
	settings?(): void;
	companion?: { name: string; session(): void; terminal?(): void; /** Back to the breathing circle (Z-D16). */ rest(): void };
	cycle?: { prev(): void; next(): void };
	/** The head tower, on the circle screen: talk to it, read the whole conversation, or open its page in Standard. */
	head?: { talk(): void; history(): void; page(): void };
}
export interface Prefs extends MenuDeps { music?: { on(): boolean; set(on: boolean): void } }
const STEP = 10;

export function entriesOf(a: Acts, p: Prefs): Entry[] {
	const out: Entry[] = [], add = (id: string, label: string, run: () => void, o: Partial<Entry> = {}) => void out.push({ id, label, run, ...o });
	const here = (on: boolean) => (on ? { hint: m.pal_current() } : {});
	const onoff = (on: boolean) => (on ? m.state_on() : m.state_off());
	if (a.companion) (add("session", m.pal_session({ name: a.companion.name }), a.companion.session), a.companion.terminal && add("terminal", m.pal_terminal({ name: a.companion.name }), a.companion.terminal), add("rest", m.zen_rest(), a.companion.rest));
	if (a.cycle) (add("prev", m.pal_prev(), a.cycle.prev), add("next", m.pal_next(), a.cycle.next));
	if (a.head) (add("head-talk", m.palette_head_talk(), a.head.talk), add("head-history", m.palette_head_history(), a.head.history), add("head-page", m.palette_head_page(), a.head.page));
	if (a.settings) add("settings", m.pal_settings(), a.settings);
	add("leave", m.pal_leave(), a.leave);
	const { language, sound, music } = p, pick = (what: string, choice: string) => m.pal_pick({ what, choice });
	if (language) for (const l of language.names()) add(`language:${l.id}`, pick(m.language(), l.name), () => language.set(l.id), here(language.get() === l.id));
	if (sound) {
		// Each class has its switch and two volume steps: Sound effects (ids effects, effects-louder, effects-quieter) and Background sound (background, background-louder, background-quieter).
		const strip = (id: "effects" | "background", label: string, louder: string, quieter: string) => {
			const cls = sound[id], volume = (by: number) => () => (cls.setVolume(Math.min(100, Math.max(0, cls.volume() + by))), cls.try());
			add(id, label, () => cls.set(!cls.on()), { hint: onoff(cls.on()), keep: true });
			add(`${id}-louder`, louder, volume(STEP), { hint: String(cls.volume()), keep: true });
			add(`${id}-quieter`, quieter, volume(-STEP), { hint: String(cls.volume()), keep: true });
		};
		strip("effects", m.sound_effects(), m.pal_effects_louder(), m.pal_effects_quieter());
		strip("background", m.sound_background(), m.pal_background_louder(), m.pal_background_quieter());
	}
	if (music) add("music", m.pal_music(), () => music.set(!music.on()), { hint: onoff(music.on()), keep: true });
	return out;
}
