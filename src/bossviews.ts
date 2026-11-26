import { type Choice, CHOICES } from "./views.ts";

/** What each `gui view <name>` completion says: one line per name of src/views.ts, so a new view cannot be left without one. Zen is a mode, entered from the page's header, and has none. */
const VIEW_ABOUT: Record<Choice, string> = {
	auto: "Default view: each device follows its screen's contrast setting",
	standard: "Default view: Standard for devices that follow the server",
	geek: "Default view: Geek (black, monospace, no motion) for devices that follow the server",
	raven: "Default view: Raven Keep (a gothic skin of Standard: castle palette, fog, bats, ravens) for devices that follow the server",
};
export const VIEW_ARGUMENTS = Object.fromEntries(CHOICES.map((view) => [`gui view ${view}`, VIEW_ABOUT[view]]));
