import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Plugin } from "vite";
import { MODES, VIEWS } from "../src/views.ts";

// The theme build (docs/specs/2026-11-07-raven-view/spec.md §6.1 to §6.3). A view other than Standard is a theme: `gui/themes/<view>/index.ts` is its entry, reached only through `import()` in registry.ts, and every chunk and asset that only
// that entry reaches is written under `themes/<view>/` with a hashed name, so the sb server can leave the folder unread until a page asks for it (src/gui.ts) and a page on another view never requests it.
// Zen is a mode, not a view (docs/specs/2026-11-26-storybook-theme/spec.md Part A), but its code is built as a theme all the same, under `themes/zen/`; its entry in the map says `mode: true`, so boot.js never takes it for a view name.
// The same pass writes `themes.json` (per view: its stylesheet, entry module, and tab icon) and the same map into index.html as <meta name="sb-themes">, and emits `gui/boot.js` hashed with its script tag after the entry's stylesheet.

/** One theme in the map: paths relative to the bundle's root, as the page's `<base>` resolves them. */
export interface ThemeFiles { css?: string; module?: string; icon: string; /** A mode (Zen), which no device or server picks as its view. */ mode?: true }
export type ThemeMap = Record<string, ThemeFiles>;

export const THEME_VIEWS: string[] = [...VIEWS.filter((view) => view !== "standard"), ...MODES];
export const THEMES_DIR = "themes";
/** The marker the server replaces with the default view's stylesheet link (src/gui.ts); it sits after the entry's own stylesheet, so the theme's rules come later in the cascade, as the Geek block always did. */
export const MARKER = "<!--sb-theme-->";

/** A module id without its query, as a path. */
const clean = (id: string) => id.split("?")[0]!.replace(/\\/g, "/");

/** What the module graph says of one module: what it imports and what imports it (static or dynamic alike). */
export interface Edges { imports: string[]; importers: string[] }

/** The modules only one theme's entry reaches, by id: what the entry reaches, less every module that something outside that set also imports (taken away until none is left, so a cycle that leaks out leaves entirely). Entries are `[view, id]`. */
export function exclusive(entries: [string, string][], edges: (id: string) => Edges): Map<string, string> {
	const owned = new Map<string, string>();
	for (const [view, entry] of entries) {
		const set = new Set([entry]);
		for (const id of set) for (const next of edges(id).imports) set.add(next);
		for (let changed = true; changed; ) {
			changed = false;
			for (const id of set) if (id !== entry && (edges(id).importers.length === 0 || edges(id).importers.some((from) => !set.has(from)))) changed = set.delete(id) || changed;
		}
		for (const id of set) owned.set(id, view);
	}
	return owned;
}

/** The theme map of a finished build: `files` are the bundle's file names. A theme's own favicon.svg is its icon; one without keeps Standard's. */
export function themeMap(files: Iterable<string>, find: (view: string, file: string) => string | undefined): ThemeMap {
	const list = [...files];
	const map: ThemeMap = {};
	for (const view of THEME_VIEWS) {
		const own = (re: RegExp) => list.find((f) => f.startsWith(`${THEMES_DIR}/${view}/`) && re.test(f));
		const css = find(view, "css") ?? own(/\.css$/), module = find(view, "module") ?? own(/\.js$/), icon = own(/favicon.*\.svg$/);
		map[view] = { ...(css ? { css } : {}), ...(module ? { module } : {}), icon: icon ?? "icon.svg", ...((MODES as readonly string[]).includes(view) ? { mode: true as const } : {}) };
	}
	return map;
}

export function themes(root: string): Plugin {
	let owned = new Map<string, string>(), boot = "";
	const entries = new Map(THEME_VIEWS.map((view) => [join(root, "themes", view, "index.ts").replace(/\\/g, "/"), view]));
	const dirOf = (view: string | undefined) => (view ? `${THEMES_DIR}/${view}/` : "assets/");
	return {
		name: "sb-themes",
		apply: "build",
		buildStart() {
			boot = this.emitFile({ type: "asset", name: "boot.js", source: readFileSync(join(root, "boot.js")) });
			for (const view of THEME_VIEWS) {
				const favicon = join(root, "themes", view, "favicon.svg");
				if (existsSync(favicon)) this.emitFile({ type: "asset", name: `favicon-${view}.svg`, originalFileName: favicon, source: readFileSync(favicon) });
			}
		},
		buildEnd() {
			owned = exclusive([...entries].map(([id, view]) => [view, id]), (id) => {
				const info = this.getModuleInfo(id);
				return { imports: info ? [...info.importedIds, ...info.dynamicallyImportedIds] : [], importers: info ? [...info.importers, ...info.dynamicImporters] : [] };
			});
		},
		outputOptions(options) {
			// A chunk or asset belongs to a theme only when every module in it does, and to the same one.
			const viewOfAll = (ids: string[], home: (id: string) => string | undefined = (id) => owned.get(id)) => {
				const views = new Set(ids.map(home));
				return views.size === 1 ? [...views][0] : undefined;
			};
			// A file only a stylesheet or the build names (the backdrop, a favicon) is no module the graph knows: it is the theme's when it lies in the theme's own folder.
			const folderOf = (path: string) => owned.get(path) ?? THEME_VIEWS.find((view) => path.startsWith(`${join(root, "themes", view).replace(/\\/g, "/")}/`));
			return {
				...options,
				// A theme's entry chunk is the theme's, with whatever rolldown merged into it (message modules only themes load); any other chunk is when every module in it is.
				chunkFileNames: (chunk) => {
					const own = entries.get(clean(chunk.facadeModuleId ?? ""));
					return `${dirOf(own ?? viewOfAll(chunk.moduleIds))}${own ?? "[name]"}-[hash].js`;
				},
				assetFileNames: (asset) => {
					const origin = (asset.originalFileNames ?? []).map((f) => join(root, f).replace(/\\/g, "/"));
					const favicon = THEME_VIEWS.find((view) => (asset.names ?? []).includes(`favicon-${view}.svg`)); // emitted above, under that name
					return `${dirOf(favicon ?? (origin.length ? viewOfAll(origin, folderOf) : undefined))}[name]-[hash][extname]`;
				},
			};
		},
		generateBundle: {
			order: "post",
			handler(_options, bundle) {
				const chunkOf = (view: string, kind: "css" | "module") => {
					for (const file of Object.values(bundle)) {
						if (file.type !== "chunk" || !file.facadeModuleId || entries.get(clean(file.facadeModuleId)) !== view) continue;
						return kind === "module" ? file.fileName : [...((file.viteMetadata as { importedCss?: Set<string> } | undefined)?.importedCss ?? [])][0];
					}
					return undefined;
				};
				// Vite writes a stylesheet's url() as if the sheet sat in assets/ (`../themes/raven/x.webp`); a theme's sheet is loaded from themes/<view>/, so each url is made relative to the sheet's own folder.
				for (const file of Object.values(bundle)) {
					if (file.type !== "asset" || !new RegExp(`^${THEMES_DIR}/[^/]+/.+\\.css$`).test(file.fileName)) continue;
					const from = posix.dirname(file.fileName);
					file.source = String(file.source).replace(/url\((["']?)(\.{1,2}\/[^)"']+)\1\)/g, (_all, quote: string, url: string) => `url(${quote}${posix.relative(from, posix.join("assets", url))}${quote})`);
				}
				const map = themeMap(Object.keys(bundle), (view, kind) => chunkOf(view, kind as "css" | "module"));
				this.emitFile({ type: "asset", fileName: "themes.json", source: `${JSON.stringify(map, null, "\t")}\n` });
				const page = bundle["index.html"];
				if (page?.type !== "asset") return;
				const source = String(page.source), sheet = /[ \t]*<link rel="stylesheet"[^>]*>\n?/.exec(source);
				const attr = JSON.stringify(map).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
				const link = sheet ? sheet[0].trim() : "";
				page.source = source.replace(sheet?.[0] ?? "", "").replace("</head>", `  <meta name="sb-themes" content="${attr}">\n  ${link ? `${link}\n  ` : ""}${MARKER}\n  <script src="./${this.getFileName(boot)}"></script>\n</head>`);
			},
		},
	};
}
