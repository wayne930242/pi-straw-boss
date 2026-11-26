import type { Face } from "../../src/views.ts";
import { retranslate } from "../i18n.ts";
import { useIcons } from "../icons.ts";
import { usePack } from "../nouns.ts";
import { getLocale } from "../paraglide/runtime.js";
import { useSentences } from "../sentencepack.ts";
import { useSounds } from "../themesounds.ts";
import type { ThemeParts } from "./theme.ts";

// The theme registry (docs/specs/2026-11-07-raven-view/spec.md §1.2, §6.1): every face but Standard is a theme (the mode Zen included: its layer and sheet are built as one), one entry module `gui/themes/<view>/index.ts` with its stylesheet, parts, and code, reached only through the
// `import()` here. A theme loads the first time the page shows its view and stays loaded, so switching back costs no request. Standard is the base the page entry carries.

export type ThemeView = Exclude<Face, "standard">;
const LOADERS = { geek: () => import("./geek/index.ts"), zen: () => import("./zen/index.ts"), raven: () => import("./raven/index.ts"), storybook: () => import("./storybook/index.ts") } satisfies Record<ThemeView, () => Promise<{ theme: ThemeParts }>>;
export const isTheme = (view: Face): view is ThemeView => view in LOADERS;

const loaded = new Map<ThemeView, Promise<unknown>>();
/** A theme's entry module, fetched once; a failed fetch (the build changed under the page: the stream's hello reloads it) is tried again next time. */
export function loadTheme<V extends ThemeView>(view: V): Promise<Awaited<ReturnType<(typeof LOADERS)[V]>>> {
	let hit = loaded.get(view);
	if (!hit) loaded.set(view, (hit = LOADERS[view]().catch((error) => (loaded.delete(view), Promise.reject(error)))));
	return hit as Promise<Awaited<ReturnType<(typeof LOADERS)[V]>>>;
}

const heard: ((view: Face, parts?: ThemeParts) => void)[] = [];
/** Told after a view's theme parts (nouns, sprite, badge) took effect, so the page draws its words and icons again and the tab takes the view's icon. */
export const onTheme = (fn: (view: Face, parts?: ThemeParts) => void) => void heard.push(fn);

let wanted: Face = "standard";
/** The page shows `view` now: load its theme and take its parts (nouns, sentences, sprite); Standard takes none. A view that changed while the theme was on its way is left alone. */
export async function showTheme(view: Face): Promise<void> {
	wanted = view;
	const parts = isTheme(view) ? (await loadTheme(view).catch(() => undefined))?.theme : undefined;
	if (wanted !== view) return;
	usePack(parts?.nouns);
	useSentences(parts?.sentences, getLocale);
	useSounds(parts?.sounds);
	useIcons(view, parts?.sprite);
	retranslate();
	for (const fn of heard) fn(view, parts);
}
