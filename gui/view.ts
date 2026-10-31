// The page's view: Standard (the Tokyo Night palette with its motion) or Geek (black, monospace, AAA contrast, nothing moves; style.css `[data-view="geek"]`).
// The choice is the device's: Auto, Standard, or Geek in localStorage `sb.view`. An explicit Standard or Geek wins; Auto (also a missing or invalid value)
// follows the OS, Geek when it asks for more contrast (prefers-contrast: more). `data-view` goes on <html> as the first thing main.ts does, before any render,
// and the browser's theme-color follows it, so an installed app's bar matches. A default from the server (step 3) slots in under `auto`: `autoView`.

export type Choice = "auto" | "standard" | "geek";
export type View = "standard" | "geek";
export const KEY = "sb.view";
/** The theme-color of the Geek view; Standard keeps the color the page came with (index.html). */
export const THEME = { geek: "#000000" } as const;

/** The stored value as a choice: only the two views are choices of their own, anything else (missing, invalid) is Auto. */
export const choiceOf = (stored: string | null | undefined): Choice => (stored === "standard" || stored === "geek" ? stored : "auto");
/** What Auto means now. */
export const autoView = (contrast: boolean): View => (contrast ? "geek" : "standard");
export const resolve = (choice: Choice, contrast: boolean): View => (choice === "auto" ? autoView(contrast) : choice);

/** What the view reads and writes, as plain parts so a test can stand in for the page. */
export interface ViewEnv {
	root: { dataset: Record<string, string | undefined> };
	/** `<meta name="theme-color">`, when the page has one. */
	meta?: { content: string } | null;
	/** The `(prefers-contrast: more)` query. */
	media: { matches: boolean; addEventListener(type: "change", listener: () => void): void };
	storage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}

export function domEnv(): ViewEnv {
	return {
		root: document.documentElement,
		meta: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]'),
		media: matchMedia("(prefers-contrast: more)"),
		storage: localStorage,
	};
}

export function mountView(env: ViewEnv = domEnv()) {
	const listeners: ((view: View) => void)[] = [], standard = env.meta?.content ?? "";
	const read = () => {
		try {
			return choiceOf(env.storage.getItem(KEY));
		} catch {
			return "auto"; // storage refused: the OS decides
		}
	};
	let choice = read(), shown: View | undefined;
	function apply() {
		const view = resolve(choice, env.media.matches);
		env.root.dataset.view = view;
		if (env.meta) env.meta.content = view === "geek" ? THEME.geek : standard;
		if (shown !== undefined && shown !== view) for (const fn of listeners) fn(view);
		shown = view;
	}
	apply();
	env.media.addEventListener("change", apply);
	return {
		choice: () => choice,
		view: () => resolve(choice, env.media.matches),
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
	};
}
export type PageView = ReturnType<typeof mountView>;

/** The settings' three-way control: buttons `[data-choice]` in `group`, the chosen one `aria-pressed`. */
export function mountPick(group: HTMLElement, view: PageView) {
	const buttons = [...group.querySelectorAll<HTMLButtonElement>("button[data-choice]")];
	const sync = () => buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.choice === view.choice())));
	for (const b of buttons) b.addEventListener("click", () => (view.set(choiceOf(b.dataset.choice)), sync()));
	addEventListener("storage", (e) => e.key === KEY && (view.reread(), sync()));
	sync();
}
