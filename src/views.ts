// The page's themes and its one mode, named once: the server (the stored default, `/boss gui view`, the gui.json record), the page (gui/view.ts, the settings control, the palette, the demo fixture) and the build (the theme map) all read these lists.
// Names only: no theme code or asset belongs here, since the sb server imports this file. A new theme is one more name here and a folder under gui/themes/.

/** The themes a device can show; Standard is the base the page entry carries, the others are themes (gui/themes/). Raven Keep (鴉閣) is the gothic one, Storybook (繪本) the picture book with a day and a night. */
export const VIEWS = ["standard", "geek", "raven", "storybook"] as const;
export type View = (typeof VIEWS)[number];
/** The page's modes, on or off on a device whatever its theme (docs/specs/2026-11-26-storybook-theme/spec.md Part A): Zen, entered by the header's Zen button. A mode is no view: the server cannot default a page into it. Its code lives in a theme folder of its own all the same (gui/themes/zen/). */
export const MODES = ["zen"] as const;
export type Mode = (typeof MODES)[number];
/** What the page shows (`data-view` on <html>): Zen while the mode is on and the route is not the settings page, else the device's theme. */
export type Face = View | Mode;
/** What a device or the server can choose: Auto leaves it to the screen (or, for a device, to the server's default). */
export const CHOICES = ["auto", ...VIEWS] as const;
export type Choice = (typeof CHOICES)[number];
export const isChoice = (value: unknown): value is Choice => typeof value === "string" && (CHOICES as readonly string[]).includes(value);
/** The view this value names, `undefined` for anything else (Auto and a mode included). */
export const viewOf = (value: unknown): View | undefined => (typeof value === "string" && (VIEWS as readonly string[]).includes(value) ? (value as View) : undefined);
/** The names as prose for an error text: `standard, geek, or raven`. */
export const said = (names: readonly string[]) => `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
