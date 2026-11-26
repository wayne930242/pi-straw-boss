// The device's preferences: one typed store over localStorage for the keys the page keeps (view, Zen mode, language, the two sound classes' switches and volumes, Remind, Enlarge, Zen's last talk, Home Screen hint, music switch and track).
// A refused storage reads as the default (zenHint: as already told, so no hint) and a write it refuses is dropped; `on` hears another tab's write (the `storage` event) for one name.
type Store = { getItem?(key: string): string | null; setItem?(key: string, value: string): void };
type Raw = string | null | undefined; // a stored string; null: none; undefined: the storage refused
export const KEYS = { view: "sb.view", zen: "sb.zen", locale: "sb-locale", effects: "sb.effects", effectsVolume: "sb.effects.volume", background: "sb.background", backgroundVolume: "sb.background.volume", remind: "sb.remind", wide: "sb.dialog-wide", zenHint: "sb.zen.homehint", zenMusic: "sb.zen.music", zenTrack: "sb.zen.track" } as const;
export type Name = keyof typeof KEYS;
/** The keys that came before: the one Sound switch and Volume before the two classes (todo #139), so the old on is both on at the old Volume and the old off is both off, and the view before Zen was a mode (`sb.view` = `zen`: the mode is on, docs/specs/2026-11-26-storybook-theme/spec.md A2). A key with nothing stored of its own reads them. They are never written, so an older build on the same browser still finds what it wrote. */
export const LEGACY: Partial<Record<Name, string>> = { zen: "sb.view", effects: "sb.sound", background: "sb.sound", effectsVolume: "sb.volume", backgroundVolume: "sb.volume" };
/** How a legacy value reads as the new key's (none: as it is): only `sb.view` = `zen` means the mode is on, any other view is off. */
const LEGACY_AS: Partial<Record<Name, (v: Raw) => Raw>> = { zen: (v) => (v === undefined ? v : v === "zen" ? "1" : "0") };
const volume = (v: Raw) => Math.min(100, Math.max(0, Number(v ?? "60") || 0));
/** How each stored string reads. A value is written as its string, a boolean as 1 or 0 (Zen's hint, true: 1). */
const READ = {
	view: (v: Raw) => v ?? "auto", zen: (v: Raw) => v === "1", locale: (v: Raw) => v ?? null, effects: (v: Raw) => v === "1", background: (v: Raw) => v === "1", effectsVolume: (v: Raw) => volume(v), backgroundVolume: (v: Raw) => volume(v),
	remind: (v: Raw) => (v ?? "1") === "1", wide: (v: Raw) => v === "1", zenHint: (v: Raw) => v !== null, zenMusic: (v: Raw) => v === "1", zenTrack: (v: Raw) => v ?? null,
};
type Value<N extends Name> = ReturnType<(typeof READ)[N]>;

export function createPrefs(store: Store) {
	const heard = new Set<[string, () => void]>();
	let listening = false;
	return {
		get<N extends Name>(name: N) {
			let raw: Raw;
			try {
				raw = store.getItem?.(KEYS[name]);
				if (raw === null && LEGACY[name]) raw = (LEGACY_AS[name] ?? ((v: Raw) => v))(store.getItem?.(LEGACY[name]!));
			} catch {} // storage refused: the default holds for this page
			return READ[name](raw) as Value<N>;
		},
		/** False when the storage refused: the value holds for this page only. */
		set<N extends Name>(name: N, value: Value<N>) {
			try {
				store.setItem!(KEYS[name], typeof value === "boolean" ? (value ? "1" : "0") : String(value));
				return true;
			} catch {
				return false;
			}
		},
		/** Another tab of this device wrote `name`. */
		on(name: Name, fn: () => void) {
			if (!listening) { addEventListener("storage", (e) => heard.forEach(([key, f]) => e.key === key && f())); listening = true; }
			const entry: [string, () => void] = [KEYS[name], fn];
			heard.add(entry);
			return () => heard.delete(entry);
		},
	};
}
/** The page's own: localStorage, looked up at each use (a page that refuses it throws there, which reads as refused). */
export const prefs = createPrefs({ getItem: (k) => localStorage.getItem(k), setItem: (k, v) => localStorage.setItem(k, v) });
