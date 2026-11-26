import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The bundle's files in the GUI server's memory, all read at start, `themes/**` included (docs/specs/2026-11-07-raven-view/spec.md §1.2, §6.5): a package update replaces dist/gui under a running server, whose page names the old assets, so
// nothing is read from disk later. A name not in the bundle is `undefined` (a 404); no request path is ever joined to the folder. `themes.json` (the build's map, names only) lets the page's first frame link the default view's stylesheet and icon.

type Theme = { css?: string; icon?: string };

export function listBundle(dir: string) {
	const bundle = new Map(readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile()).map((f) => [f.split("\\").join("/"), readFileSync(join(dir, f))] as const));
	const map = ((): Record<string, Theme | undefined> => {
		try {
			return JSON.parse(bundle.get("themes.json")?.toString("utf8") ?? "{}");
		} catch {
			return {};
		}
	})();
	return {
		bundle,
		fileOf: (file: string): Buffer | undefined => bundle.get(file),
		/** The page for a default view: when it is a theme, its stylesheet link goes where the build left the marker (after the entry's own stylesheet, so the cascade is as it was) and the tab icon is its icon. Standard and Auto add nothing. */
		page(html: string, view: string): string {
			const theme = Object.hasOwn(map, view) ? map[view] : undefined;
			if (!theme || view === "standard") return html;
			return html.replace("<!--sb-theme-->", theme.css ? `<link rel="stylesheet" data-theme="${view}" href="${theme.css}">` : "").replace(/(<link rel="icon"[^>]*?) href="[^"]*"/, theme.icon ? `$1 href="${theme.icon}" data-standard="./icon.svg"` : "$&");
		},
	};
}
