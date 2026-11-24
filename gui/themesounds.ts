// The question clip of the view the page shows: one chokepoint, `soundOf(kind, base)`. A theme (gui/themes/<view>/ exports `sounds`) answers it in its own clip; every view without
// a theme's sounds (Standard, a theme still on its way) plays the base clip. A theme's clips are files in its folder, fetched by audio.ts the first time one plays.
// Only what waits on the boss has a sound (notify.ts): a finish and a failure have none, so `waiting` is the one kind.

export type SoundKind = "waiting";
/** A theme's clips by kind. */
export type ThemeSounds = Partial<Record<SoundKind, string>>;

let sounds: ThemeSounds | undefined;
/** The clips of the view the page shows now; none for Standard. */
export const useSounds = (next: ThemeSounds | undefined) => void (sounds = next);
export const soundOf = (kind: SoundKind, base: string): string => sounds?.[kind] ?? base;
