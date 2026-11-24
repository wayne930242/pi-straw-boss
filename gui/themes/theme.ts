import type { NounPack } from "../nouns.ts";
import type { SentencePack } from "../sentencepack.ts";
import type { ThemeSounds } from "../themesounds.ts";

/** What a theme's entry module exports as `theme` besides its code: the parts the page takes from it (gui/themes/registry.ts). All optional: Zen adds nothing yet, Geek only its stylesheet and the work board's plain words, and a missing part is Standard's. */
export interface ThemeParts {
	/** The icon sprite's symbols, with ids prefixed by the view (`raven-tower`). */
	sprite?: string;
	/** The role nouns by locale. */
	nouns?: NounPack;
	/** The sentences, by locale, that the view says in its own words (gui/sentences.ts): the ones that embed a role word, as the pack above cannot reach them. */
	sentences?: SentencePack;
	/** The clips for a question, a finish, and a failure (URLs of files in the theme's folder); a missing kind plays Standard's clip. */
	sounds?: ThemeSounds;
	/** The tab icon's waiting badge: the dot, its ring, and the count (Standard's by default). */
	badge?: { dot: string; ring: string; text: string };
}
