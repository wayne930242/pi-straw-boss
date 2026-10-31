// The page's view: Standard (the Tokyo Night palette with its motion) or Geek (black, monospace, AAA contrast, nothing moves; style.css `[data-view="geek"]`).
// The choice is the device's: Auto, Standard, or Geek in localStorage `sb.view`. An explicit Standard or Geek wins; Auto (also a missing or invalid value)
// follows the server's default when the boss set one (`/boss gui view`: Standard or Geek), else the OS, Geek when it asks for more contrast (prefers-contrast: more).
// The server's default is not the device's to write: it comes in the page's `<meta name="sb-view">` (read here before the first paint, so a following page shows it with
// no flash), in each stream's `hello`, and in a `view` event (main.ts hands them to `setServer`), and is never stored on the device. `data-view` goes on <html> as the first
// thing main.ts does, before any render, and the browser's theme-color follows it, so an installed app's bar matches.

export type Choice = "auto" | "standard" | "geek";
export type View = "standard" | "geek";
export const KEY = "sb.view";
/** The theme-color of the Geek view; Standard keeps the color the page came with (index.html). */
export const THEME = { geek: "#000000" } as const;

/** The stored value as a choice: only the two views are choices of their own, anything else (missing, invalid) is Auto. */
export const choiceOf = (stored: string | null | undefined): Choice => (stored === "standard" || stored === "geek" ? stored : "auto");
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

export function mountView(env: ViewEnv = domEnv()) {
	const listeners: ((view: View) => void)[] = [], serverListeners: ((server: Choice) => void)[] = [], standard = env.meta?.content ?? "";
	const read = () => {
		try {
			return choiceOf(env.storage.getItem(KEY));
		} catch {
			return "auto"; // storage refused: the OS decides
		}
	};
	let choice = read(), server = choiceOf(env.server?.content), shown: View | undefined;
	function apply() {
		const view = resolve(choice, env.media.matches, server);
		env.root.dataset.view = view;
		if (env.meta) env.meta.content = view === "geek" ? THEME.geek : standard;
		if (shown !== undefined && shown !== view) for (const fn of listeners) fn(view);
		shown = view;
	}
	apply();
	env.media.addEventListener("change", apply);
	return {
		choice: () => choice,
		view: () => resolve(choice, env.media.matches, server),
		/** The server's default, as the page last heard it. */
		server: () => server,
		/** The server named a default (hello, a `view` event): a page that follows it switches at once, one with a choice of its own stays; nothing is stored. */
		setServer(next: unknown) {
			const value = choiceOf(typeof next === "string" ? next : undefined);
			if (value === server) return;
			server = value;
			for (const fn of serverListeners) fn(server);
			apply();
		},
		/** Switches at once and keeps the choice for this device; a refused storage still switches this page. */
		set(next: Choice) {
			choice = next;
			try {
				env.storage.setItem(KEY, next);
			} catch {} // the choice holds until the page closes
			apply();
		},
		/** Another tab of this device chose: read the stored value again. */
		reread() {
			choice = read();
			apply();
		},
		onChange: (fn: (view: View) => void) => void listeners.push(fn),
		/** Told when the server's default changed (the settings' Auto button names it). */
		onServer: (fn: (server: Choice) => void) => void serverListeners.push(fn),
	};
}
export type PageView = ReturnType<typeof mountView>;

/** The settings' three-way control: buttons `[data-choice]` in `group`, the chosen one `aria-pressed`. `label` words the Auto button for the server's default (Follow server (geek)); without one it keeps its text. */
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
	addEventListener("storage", (e) => e.key === KEY && (view.reread(), sync()));
	sync();
}
