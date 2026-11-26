import type { Audio } from "../audio.ts";
import type { NounPack } from "../nouns.ts";
import type { Phase } from "../phase.ts";
import type { SentencePack } from "../sentencepack.ts";

/** Built-in theme code, contract 1. Importing an entry must not start it: the registry may preload it under another face. */
export interface ThemeParts {
	sprite?: string;
	nouns?: NounPack;
	sentences?: SentencePack;
	mount?(env: { audio: Audio; phase(): Phase | undefined }): { stop(): void };
}
