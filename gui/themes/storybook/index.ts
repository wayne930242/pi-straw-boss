// The Storybook theme (繪本, docs/specs/2026-11-26-storybook-theme/spec.md Part B): a picture-book skin of Standard, a pressed-flower notebook (washi tape, paper grain, ruled lines) on a cream day and a storybook night.
// Its stylesheet and the phase clock load together the first time a page shows the view (gui/themes/registry.ts), or boot.js links the stylesheet and sets `data-phase` before the first frame.
// No nouns and no sentences: every word is Standard's (SB-D4). Its woodcut animals use the page's role colours.
import "./storybook.css";
import sprite from "./sprite.svg?raw";
import { forcedPhase } from "../../phase.ts";
import type { Badge, ThemeParts } from "../theme.ts";
import { mountPhase } from "./phase.ts";

const BADGES: Record<"day" | "night", Badge> = { day: { dot: "#e0902b", ring: "#fbf5e9", text: "#3a3150" }, night: { dot: "#ffd37e", ring: "#111a35", text: "#111a35" } };

const clock = typeof document !== "undefined" ? mountPhase({ doc: document, win: window, forced: forcedPhase }) : undefined;

export const theme: ThemeParts = {
	// The waiting badge over the bunny: honey on the cream page by day, lamp gold on the night sky.
	sprite,
	badge: () => BADGES[clock?.phase() ?? "day"],
	onShift: (fn) => clock?.onShift(() => fn()),
	recheck: () => clock?.recheck(),
};
