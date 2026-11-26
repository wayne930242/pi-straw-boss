import "./raven.css";
import sprite from "./sprite.svg?raw";
import { pageThemes } from "../manifest.ts";
import type { ThemeParts } from "../theme.ts";
import { NOUNS } from "./nouns.ts";
import { SENTENCES } from "./sentences.ts";
import { loadClips, mountWeather } from "./weather.ts";

export const theme: ThemeParts = {
	sprite, nouns: NOUNS, sentences: SENTENCES,
	mount({ audio }) {
		const { ambience, sounds } = pageThemes().raven, rain = ambience!.loop!;
		return { stop: mountWeather(audio, loadClips(audio, { rain: rain.file, thunder: sounds!.thunder! }), rain.meanDbfs) };
	},
};
