import { type Choice, type Face, viewOf, type View } from "../src/views.ts";
import { createPrefs, KEYS } from "./prefs.ts";

// The page's theme: Standard (the Tokyo Night palette with its motion), Geek (black, monospace, AAA contrast, nothing moves; themes/geek), or Raven Keep (themes/raven). Zen is no theme but a mode (mode.ts,
// docs/specs/2026-11-26-storybook-theme/spec.md Part A): the page's face (`data-view` on <html>) is Zen while the mode is on and the route is not the settings page (`zen()`, which pagecore.ts says), and the theme otherwise.
// The choice is the device's: Auto, Standard, Geek, or Raven Keep in localStorage `sb.view`. An explicit theme wins; Auto (also a missing or invalid value, a legacy `zen` included)
// follows the server's default when the boss set one (`/boss gui view`), else the OS, Geek when it asks for more contrast (prefers-contrast: more).
// The server's default is not the device's to write: it comes in the page's `<meta name="sb-view">` (read here before the first paint, so a following page shows it with
// no flash), in each stream's `hello`, and in a `view` event (main.ts hands them to `setServer`), and is never stored on the device. `data-view` goes on <html> as the first
// thing main.ts does, before any render, and the browser's theme-color follows it, so an installed app's bar matches.
// A change of the theme (a pick, the server's default, the screen) never touches the mode: a page in Zen keeps its face, and the new theme shows when the boss leaves (Z-D20, 「永遠不要打斷」).

export type { Choice, View };
/** What moved the view: the person chose one (`pick`: here or on another page of this device), or the page's own Auto followed the server's default or the screen (`follow`). */
export type Cause = "pick" | "follow";
export const KEY: string = KEYS.view;
/** The theme-color of each face but Standard: Geek, Raven Keep (the near-black violet), and the mode Zen (the ink ground); Standard keeps the color the page came with (index.html). */
export const THEME: Record<Exclude<Face, "standard">, string> = { geek: "#000000", zen: "#14110e", raven: "#0d0a10" };

/** The stored value as a choice: only a named view is a choice of its own (src/views.ts), anything else (missing, invalid) is Auto. */
export const choiceOf = (stored: string | null | undefined): Choice => viewOf(stored) ?? "auto";
/** What Auto means now: the server's default when it names a view, else what the screen asks for. */
export const autoView = (contrast: boolean, server: Choice = "auto"): View => (server === "auto" ? (contrast ? "geek" : "standard") : server);
export const resolve = (choice: Choice, contrast: boolean, server: Choice = "auto"): View => (choice === "auto" ? autoView(contrast, server) : choice);

/** What the view reads and writes, as plain parts so a test can stand in for the page. */
export interface ViewEnv {
	root: { dataset: Record<string, string | undefined> };
	/** `<meta name="theme-color">`, when the page has one. */
	meta?: { content: string } | null;
	/** `<meta name="sb-view">`, the server's default as it wrote it into the page (absent from a page an older server or the demo serves: Auto). */
	server?: { content: string } | null;
	/** The `(prefers-contrast: more)` query. */
	media: { matches: boolean; addEventListener(type: "change", listener: () => void): void };
	storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

export function domEnv(): ViewEnv {
	return {
		root: document.documentElement,
		meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),
		server: document.querySelector<HTMLMetaElement>('meta[name="sb-view"]'),
		media: matchMedia("(prefers-contrast: more)"),
		storage: localStorage,
	};
}

/** `zen`: whether the page shows Zen now (the mode is on and the route is not the settings page; pagecore.ts `zenOn`). Without it the face is the theme. */
export function mountView(env: ViewEnv = domEnv(), zen: () => boolean = () => false) {
	const listeners: ((view: View, cause: Cause) => void)[] = [], serverListeners: ((server: Choice) => void)[] = [], standard = env.meta?.content ?? "";
	const prefs = createPrefs(env.storage), read = () => choiceOf(prefs.get("view")); // storage refused: the OS decides
	let choice = read(), server = choiceOf(env.server?.content), shown: View | undefined;
	const now = () => resolve(choice, env.media.matches, server);
	const face = (): Face => (zen() ? "zen" : now());
	/** A `pick` tells the listeners every time, even when the theme it resolves to is the one shown; a `follow` only when the theme changed. */
	function apply(cause?: Cause) {
		const view = now(), shows = face();
		env.root.dataset.view = shows;
		if (env.meta) env.meta.content = shows === "standard" ? standard : THEME[shows];
		const told = cause === "pick" || (cause === "follow" && shown !== undefined && shown !== view);
		shown = view; // before the listeners, which may draw the view again (viewface.ts)
		if (told) for (const fn of listeners) fn(view, cause!);
	}
	apply();
	env.media.addEventListener("change", () => apply("follow"));
	return {
		choice: () => choice,
		/** The device's theme now: what the page shows outside Zen. */
		view: now,
		/** What the page shows now (`data-view`): Zen, or the theme. */
		face,
		/** The server's default, as the page last heard it. */
		server: () => server,
		/** The server named a default (hello, a `view` event): a page that follows it takes the theme at once (under Zen it shows on leaving), one with a choice of its own stays; nothing is stored. */
		setServer(next: unknown) {
			const value = choiceOf(typeof next === "string" ? next : undefined);
			if (value === server) return;
			server = value;
			for (const fn of serverListeners) fn(server);
			apply("follow");
		},
		/** Switches the theme at once and keeps the choice for this device; a refused storage still switches this page. */
		set(next: Choice) {
			choice = next;
			prefs.set("view", next); // storage refused: the choice holds until the page closes
			apply("pick");
		},
		/** Draws the face again (the mode or the route moved, viewface.ts) without reading the storage, and tells no one. */
		refresh: () => apply(),
		/** Another tab of this device chose: read the stored value again. */
		reread() {
			choice = read();
			apply("pick");
		},
		/** Another tab of this device wrote the choice. */
		onStored: (fn: () => void) => prefs.on("view", fn),
		onChange: (fn: (view: View, cause: Cause) => void) => void listeners.push(fn),
		/** Told when the server's default changed (the settings' Auto button names it). */
		onServer: (fn: (server: Choice) => void) => void serverListeners.push(fn),
	};
}
export type PageView = ReturnType<typeof mountView>;

/** The settings' theme control: buttons `[data-choice]` in `group`, the chosen one `aria-pressed`. `label` words the Auto button for the server's default (Follow server (geek)); without one it keeps its text. */
export function mountPick(group: HTMLElement, view: PageView, label?: (server: Choice) => string) {
	const buttons = [...group.querySelectorAll<HTMLButtonElement>("button[data-choice]")];
	const auto = buttons.find((b) => b.dataset.choice === "auto");
	// With a server default the Auto button reads "Follow server (…)" and is too long for the row it shares: `data-following` gives it a row of its own.
	const words = () => {
		if (auto && label) auto.textContent = label(view.server());
		if (group.dataset) group.toggleAttribute("data-following", view.server() !== "auto");
	};
	words();
	view.onServer(words);
	const sync = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.choice === view.choice())));
	for (const b of buttons) b.addEventListener("click", () => (view.set(choiceOf(b.dataset.choice)), sync()));
	view.onStored(() => (view.reread(), sync()));
	sync();
}

/** The header's Zen button (`#zen-enter`): in every theme's header, the settings page's included, while the shell shows; a press turns the mode on (viewface.ts `enter`). */
export const mountZenEnter = (button: Pick<HTMLElement, "addEventListener">, enter: () => void) => button.addEventListener("click", () => enter());
