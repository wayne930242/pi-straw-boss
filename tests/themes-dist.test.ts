import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { exclusive, themeMap } from "../scripts/vite-themes.ts";
import { MODES, VIEWS } from "../src/views.ts";

// A page downloads only the files of the view it shows (docs/specs/2026-11-07-raven-view/spec.md §1.2, §6.10). No browser runs here: the built bundle (`npm run gui:build`, which `npm test` runs first) is read as files.

const dir = join(import.meta.dirname, "..", "dist", "gui");
const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).map((f) => f.split("\\").join("/")).filter((f) => statSync(join(dir, f)).isFile());
const text = (f: string) => readFileSync(join(dir, f), "utf8");
const html = text("index.html");
const map = JSON.parse(text("themes.json")) as Record<string, { css?: string; module?: string; icon: string; mode?: true }>;
const themeViews: string[] = [...VIEWS.filter((v) => v !== "standard"), ...MODES]; // the mode Zen is built as a theme of its own
/** What a file names through `src`/`href` attributes (the page's own tags, not the theme map's meta). */
const tagged = [...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!.replace(/^\.\//, ""));
/** The files a script imports statically (`import "./x.js"`, `import … from "./x.js"`, `export … from "./x.js"`), resolved against its own folder. */
const statics = (f: string) => {
	const base = f.includes("/") ? f.slice(0, f.lastIndexOf("/") + 1) : "";
	return [...text(f).matchAll(/(?:\bimport\s*(?:[\w*${},\s]+?\s*from\s*)?|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*)["'](\.[^"']+)["']/g)].map((m) => join(base, m[1]!).split("\\").join("/"));
};
const mentions = (f: string, other: string) => text(f).includes(other.slice(other.lastIndexOf("/") + 1)) && !f.endsWith(".png");

test("the built page names no theme file: index.html's tags, the entry's static import closure, and its stylesheet carry none", () => {
	assert.ok(tagged.length >= 3, "the page names its entry script, stylesheet, and boot.js");
	assert.deepEqual(tagged.filter((f) => f.startsWith("themes/")), [], "index.html's script and link tags");
	const entry = tagged.find((f) => /^assets\/index-.*\.js$/.test(f))!;
	const closure = new Set<string>();
	for (const todo = [entry]; todo.length; ) {
		const next = todo.pop()!;
		if (closure.has(next)) continue;
		closure.add(next);
		todo.push(...statics(next));
	}
	assert.ok(closure.size > 1, "the closure was followed");
	assert.deepEqual([...closure].filter((f) => f.startsWith("themes/")), [], "the entry's static imports");
	const css = tagged.find((f) => f.endsWith(".css"))!;
	assert.ok(!/data-view=["']?geek/.test(text(css)), "no Geek rule in the entry stylesheet");
	assert.ok(!/\burl\(["']?\.?\/?themes\//.test(text(css)), "and no theme asset");
	assert.ok(/<script src="\.\/assets\/boot-[\w-]+\.js"><\/script>/.test(html) && html.indexOf("boot-") > html.indexOf("<link rel=\"stylesheet\""), "boot.js is hashed and follows the entry's stylesheet");
	assert.ok(html.includes("<!--sb-theme-->"), "the marker the server fills");
});

test("each theme's files sit in themes/<view>/ and only that view's module (or the entry's import of it) reaches them; the map names them and matches index.html", () => {
	assert.deepEqual(Object.keys(map).sort(), [...themeViews].sort(), "a theme per view but Standard, and one per mode");
	assert.deepEqual(Object.keys(map).filter((v) => map[v]!.mode).sort(), [...MODES].sort(), "only a mode is marked one, so boot.js takes no mode for a view");
	assert.equal(html.match(/<meta name="sb-themes" content="([^"]*)"/)![1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&"), JSON.stringify(map), "index.html carries the same map");
	const entry = tagged.find((f) => /^assets\/index-.*\.js$/.test(f))!;
	for (const view of themeViews) {
		const own = files.filter((f) => f.startsWith(`themes/${view}/`));
		assert.ok(own.length >= 2, `${view} has its files`);
		for (const file of [map[view]!.css, map[view]!.module, map[view]!.icon]) assert.ok(file && files.includes(file), `${view}: ${file} is in the bundle`);
		for (const file of own) {
			assert.ok(/-[\w-]{8}\.\w+$/.test(file), `${file} has a hashed name`);
			// Reached by: its own folder's files, and the entry chunk (the dynamic import and its preload list). Nothing else names it.
			const by = files.filter((f) => f !== file && f.endsWith(".js") && !f.startsWith(`themes/${view}/`) && mentions(f, file));
			assert.ok(by.every((f) => f === entry), `${file} is named by ${by.join(", ")}`);
		}
		const others = files.filter((f) => f.startsWith("themes/") && !f.startsWith(`themes/${view}/`) && (f.endsWith(".js") || f.endsWith(".css")));
		for (const file of files.filter((f) => f.startsWith(`themes/${view}/`) && (f.endsWith(".js") || f.endsWith(".css"))))
			assert.deepEqual(others.filter((o) => mentions(file, o)), [], `${file} names no other theme's file`);
		for (const f of statics(map[view]!.module!)) assert.ok(!f.startsWith("themes/") || f.startsWith(`themes/${view}/`), `${view}'s module imports ${f}`);
	}
	for (const f of files.filter((f) => f.startsWith("assets/") && f.endsWith(".js") && !f.startsWith("assets/index-"))) assert.deepEqual(statics(f).filter((s) => s.startsWith("themes/")), [], `${f} imports no theme file`);
});

test("the build's ownership rule: a module belongs to a theme only when everything that imports it does", () => {
	const graph: Record<string, { imports: string[]; importers: string[] }> = {
		entry: { imports: ["z/index"], importers: [] },
		"z/index": { imports: ["z/a", "z/css", "shared"], importers: ["entry"] },
		"z/a": { imports: ["z/b", "shared"], importers: ["z/index", "z/b"] },
		"z/b": { imports: ["z/a"], importers: ["z/a"] },
		"z/css": { imports: [], importers: ["z/index"] },
		"z/leak": { imports: [], importers: ["z/a", "entry"] },
		shared: { imports: [], importers: ["z/index", "z/a", "entry"] },
		"g/index": { imports: ["shared", "both"], importers: ["entry"] },
		both: { imports: [], importers: ["z/a", "g/index"] },
	};
	graph["z/a"]!.imports.push("z/leak");
	const owned = exclusive([["zen", "z/index"], ["geek", "g/index"]], (id) => graph[id] ?? { imports: [], importers: [] });
	assert.deepEqual([...owned].sort(), [["g/index", "geek"], ["z/a", "zen"], ["z/b", "zen"], ["z/css", "zen"], ["z/index", "zen"]], "a cycle inside the theme stays; what the entry or another theme also imports goes");
});

test("the theme map names each theme's own files and falls back to Standard's icon; the mode Zen is built as a theme and marked a mode", () => {
	const list = ["assets/index-a.js", "themes/geek/geek-1.js", "themes/geek/geek-1.css", "themes/zen/zen-2.js", "themes/zen/zen-2.css", "themes/zen/favicon-zen-3.svg", "themes/raven/raven-4.js", "themes/raven/raven-4.css", "themes/raven/favicon-raven-5.svg", "themes/raven/backdrop-6.webp", "themes/storybook/storybook-7.js", "themes/storybook/storybook-7.css", "themes/storybook/favicon-storybook-8.svg"];
	assert.deepEqual(themeMap(list, () => undefined), { geek: { css: "themes/geek/geek-1.css", module: "themes/geek/geek-1.js", icon: "icon.svg" }, zen: { css: "themes/zen/zen-2.css", module: "themes/zen/zen-2.js", icon: "themes/zen/favicon-zen-3.svg", mode: true }, raven: { css: "themes/raven/raven-4.css", module: "themes/raven/raven-4.js", icon: "themes/raven/favicon-raven-5.svg" }, storybook: { css: "themes/storybook/storybook-7.css", module: "themes/storybook/storybook-7.js", icon: "themes/storybook/favicon-storybook-8.svg" } });
});

// A stylesheet that names a file (the raven backdrop) names it relative to the stylesheet itself: the page loads a theme's stylesheet from themes/<view>/, so a URL that Vite wrote for a sheet in assets/ (`../themes/raven/x.webp`) would 404 there.
test("every url() in a theme's stylesheet names a file that exists, relative to the stylesheet", () => {
	const sheets = files.filter((f) => /^themes\/[^/]+\/.*\.css$/.test(f));
	assert.ok(sheets.length >= 3, "a stylesheet per theme");
	let named = 0;
	for (const sheet of sheets) {
		for (const [, url] of text(sheet).matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/g)) {
			if (/^(data:|#|https?:)/.test(url!)) continue;
			named++;
			const target = join(sheet.slice(0, sheet.lastIndexOf("/")), url!).split("\\").join("/");
			assert.ok(files.includes(target), `${sheet} names ${url}, which resolves to ${target}`);
		}
	}
	assert.ok(named >= 1, "the raven stylesheet names its backdrop");
});
