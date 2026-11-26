import { readFileSync } from "node:fs";
import vm from "node:vm";

// gui/boot.js run in a page of plain objects (tests/view.test.ts, tests/zen-mode.test.ts): what it did to <html>, the theme-color, the icon, and what it wrote.
const BOOT = readFileSync(new URL("../gui/boot.js", import.meta.url), "utf8");
/** The build's map as the build writes it: Zen is a mode (`mode: true`), built as a theme. */
export const MAP = JSON.stringify({ geek: { css: "themes/geek/geek-x.css", icon: "icon.svg" }, raven: { css: "themes/raven/raven-x.css", icon: "themes/raven/favicon-x.svg" }, zen: { css: "themes/zen/zen-x.css", icon: "themes/zen/favicon-x.svg", mode: true } });

export interface BootOptions { /** `sb.zen` as stored (none: null). */ zen?: string | null; linked?: boolean; refuse?: boolean; standardMark?: string; icon?: string; map?: string }
export interface SbBoot { resolve(stored: unknown, contrast: boolean, server: unknown): string; face(stored: unknown, zen: unknown, contrast: boolean, server: unknown): string; colors: Record<string, string> }

/** `stored` is `sb.view`, `server` the `<meta name="sb-view">` (none: null). */
export function boot(stored: string | null, contrast: boolean, server: string | null, o: BootOptions = {}) {
	const metas: Record<string, { content: string } | undefined> = { "sb-themes": { content: o.map ?? MAP }, "theme-color": { content: "#1a1b26" }, ...(server !== null ? { "sb-view": { content: server } } : {}) };
	const attrs = new Map<string, string>([["href", o.icon ?? "./icon.svg"], ...(o.standardMark ? [["data-standard", o.standardMark] as [string, string]] : [])]);
	const wrote: string[] = [];
	const dataset: Record<string, string> = {};
	const document = {
		documentElement: { dataset },
		querySelector: (sel: string) => {
			const meta = /^meta\[name="([\w-]+)"\]$/.exec(sel);
			if (meta) return metas[meta[1]!] ? { getAttribute: () => metas[meta[1]!]!.content, setAttribute: (_: string, v: string) => (metas[meta[1]!]!.content = v) } : null;
			if (sel === 'link[rel="icon"]') return { getAttribute: (k: string) => attrs.get(k) ?? null, hasAttribute: (k: string) => attrs.has(k), setAttribute: (k: string, v: string) => void attrs.set(k, v) };
			return /^link\[data-theme=/.test(sel) && o.linked ? {} : null;
		},
		write: (markup: string) => void wrote.push(markup),
	};
	const getItem = (key: string) => {
		if (o.refuse) throw new Error("denied");
		return key === "sb.view" ? stored : key === "sb.zen" ? (o.zen ?? null) : null;
	};
	const context: Record<string, unknown> = { document, matchMedia: () => ({ matches: contrast }), localStorage: { getItem } };
	context.globalThis = context;
	vm.runInNewContext(BOOT, context);
	return { view: dataset.view, color: metas["theme-color"]!.content, icon: attrs.get("href"), standard: attrs.get("data-standard"), wrote, resolve: context.sbBoot as SbBoot };
}
