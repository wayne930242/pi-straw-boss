import type { Cause, PageView } from "./view.ts";
import type { PageMode } from "./mode.ts";

// What the page's face does when something moves it (docs/specs/2026-11-26-storybook-theme/spec.md Part A): the one place that knows. Two axes: the device's theme (view.ts) and the Zen mode (mode.ts). The face is Zen while the mode is on
// and the route is not the settings page, and the theme otherwise. Everything that moves the face goes through `faceAfter`, so the rules are one table (tests/viewface.test.ts walks it for every state).
//
//   enter    the header's Zen button: the mode goes on, and Zen shows at once; on the settings page it first leaves the page (its Back), as the settings route is never covered.
//   leave    Esc Esc, the corner control, the palette's way out, an item's or a session's exit: the mode goes off and the device's theme shows.
//   pick     the person chose a theme (the settings page, or another page of this device): the theme changes, the mode is not touched.
//   follow   Auto followed the server's default or the screen: the same, the mode is not touched (a page in Zen keeps its face: Z-D20).
//   route    the page opened or left the settings route: the settings page suspends Zen (it shows the theme's page), and leaving it shows Zen again while the mode is on.

export type Move = { on: "enter" } | { on: "leave" } | { on: "pick" } | { on: "follow" } | { on: "route"; settings: boolean };
export interface At {
	/** The Zen mode is on. */
	mode: boolean;
	/** The route is the settings page. */
	settings: boolean;
}
export interface Next extends At {
	/** The page must go back off the settings route so Zen can show (the Zen button pressed there). */
	leaveSettings: boolean;
}

/** The state after a move from `at`. The theme plays no part: no move of the theme touches the mode, and no move of the mode touches the theme. */
export function faceAfter(move: Move, at: At): Next {
	switch (move.on) {
		case "enter":
			return { mode: true, settings: at.settings, leaveSettings: at.settings };
		case "leave":
			return { mode: false, settings: at.settings, leaveSettings: false };
		case "pick":
		case "follow":
			return { ...at, leaveSettings: false };
		case "route":
			return { mode: at.mode, settings: move.settings, leaveSettings: false };
	}
}
/** Whether a page in this state shows Zen. */
export const zenShows = (at: At) => at.mode && !at.settings;

/** The page's hooks, as plain parts so a test can stand in for it. */
export interface FaceDeps {
	view: Pick<PageView, "refresh" | "onChange">;
	mode: Pick<PageMode, "on" | "enter" | "leave">;
	/** The route is the settings page now. */
	settings(): boolean;
	/** Go back off the settings page (the page's own Back). */
	leaveSettings(): void;
	/** Draw what the face now is: the Zen layer or the theme's page, the theme's parts, the tab icon, the stream's watch. */
	draw(): void;
}

export function mountFace(d: FaceDeps) {
	function move(m: Move) {
		const next = faceAfter(m, { mode: d.mode.on(), settings: d.settings() });
		if (next.mode !== d.mode.on()) (next.mode ? d.mode.enter() : d.mode.leave());
		d.view.refresh();
		d.draw();
		if (next.leaveSettings) d.leaveSettings();
	}
	d.view.onChange((_view, cause: Cause) => move({ on: cause }));
	return {
		/** The header's Zen button. */
		enter: () => move({ on: "enter" }),
		/** Esc Esc, the corner control, the palette, or an item's or a session's exit: this page shows the device's theme. */
		leave: () => move({ on: "leave" }),
		/** The route moved onto or off the settings page (`settings` is where it is now). */
		route: (settings: boolean) => move({ on: "route", settings }),
	};
}
