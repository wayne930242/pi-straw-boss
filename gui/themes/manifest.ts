import type { Face } from "../../src/views.ts";
import type { Phase } from "../phase.ts";

export interface Badge { dot: string; ring: string; text: string }
export interface LoopClip { file: string; meanDbfs: number }
export interface ThemeManifest {
	contract: 1;
	color: string | Record<Phase, string>;
	phases?: "day-night";
	badge?: Badge | Record<Phase, Badge>;
	senders?: boolean;
	ambience?: Partial<Record<Phase | "loop", LoopClip>>;
	sounds?: Partial<Record<"waiting" | "thunder", string>>;
	soundPeaks?: Partial<Record<"waiting" | "thunder", number>>;
}
export interface ThemeEntry extends ThemeManifest { icon?: string; css?: string; module?: string; mode?: true }
export type ManifestMap = Record<Face, ThemeEntry>;
/** The build writes one map for the whole document. Paths resolve against the page's base, including on nested routes. */
let bundled: ManifestMap | undefined;
export function pageThemes(): ManifestMap {
	return bundled ??= JSON.parse(document.querySelector<HTMLMetaElement>('meta[name="sb-themes"]')!.content);
}
