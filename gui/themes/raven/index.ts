// The Raven Keep theme (鴉閣, docs/specs/2026-11-07-raven-view/spec.md §1.5): a gothic skin of Standard. Its stylesheet (raven.css: the palette, the fog, flicker, bats, and raven of the head page's backdrop, all CSS), its
// role icons (sprite.svg, ids `raven-<role>`), its role nouns, its question bell, and the weather's code and clips load together the first time a page shows the view (gui/themes/registry.ts), or boot.js links the stylesheet before the first frame.
// The backdrop and the sounds are files in this folder (the stylesheet and the sound URLs name them), fetched when first drawn or played.
import "./raven.css";
import sprite from "./sprite.svg?raw";
import bell from "./sounds/bell.mp3";
import rain from "./sounds/rain.mp3";
import thunder from "./sounds/thunder.mp3";
import { audio } from "../../audio.ts";
import type { ThemeParts } from "../theme.ts";
import { NOUNS } from "./nouns.ts";
import { SENTENCES } from "./sentences.ts";
import { loadClips, mountWeather } from "./weather.ts";

// The rain and the thunder (weather.ts) belong to the view: they start when the page first shows it, and sound only while its backdrop is on the page.
if (typeof document !== "undefined") mountWeather(undefined, undefined, undefined, undefined, loadClips(audio, { rain, thunder }));

export const theme: ThemeParts = {
	sprite,
	nouns: NOUNS,
	sentences: SENTENCES,
	// Only what waits on the boss rings (boss, 2026-11-24: 「我們應該只需要 需要使用者注意 的時候放音效（背景音）除外」): a question is the clock-tower bell; a finish and a failure have no clip.
	sounds: { waiting: bell },
	// The waiting badge over the crest: candle gold on the keep's ground.
	badge: { dot: "#e3b04b", ring: "#0d0a10", text: "#0d0a10" },
};
