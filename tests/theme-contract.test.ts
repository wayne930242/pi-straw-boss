import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MODES, VIEWS } from "../src/views.ts";
import type { ThemeManifest } from "../gui/themes/manifest.ts";
import { declarations, rulesOf, sheetRules } from "./css-rules.ts";
import { reach, selectors, subject } from "./theme-selectors.ts";
import { v1 } from "./theme-v1.ts";
import contract from "../gui/themes/contract.json" with { type: "json" };

const root = join(import.meta.dirname, "..");
const sheets = (dir: string) => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" }).map(f => f.replaceAll("\\", "/")).filter(f => f.endsWith(".css"));

const gui = (file: string) => readFileSync(join(root, "gui", file), "utf8");
const standard = rulesOf(gui("style.css"));
const skins = sheets("gui/themes").map(file => `themes/${file}`);
const palette = (css: ReturnType<typeof rulesOf>, selector: string) => new Map(css.filter(r => r.parts.includes(selector)).flatMap(r => declarations(r.body)));
const subset = (required: readonly string[], actual: readonly string[], label: string) => {
	for (const name of required) assert.ok(actual.includes(name), `${label}: missing ${name}`);
};

test("1. v1 grows by addition: every frozen name, value and containment fact remains", () => {
	assert.equal(contract.version, 1);
	subset(v1.tokens, [...contract.tokens.required, ...contract.tokens.optional, ...Object.keys(contract.tokens.deprecated)], "tokens");
	for (const key of ["classes", "ids", "markProperties", "reservedPseudo", "parts", "slots", "manifest"] as const) subset(v1[key], contract[key], key);
	for (const [name, values] of Object.entries(v1.attributes)) subset(values, contract.attributes[name as keyof typeof contract.attributes] ?? [], name);
	for (const key of ["ancestors", "fixed"] as const) subset(v1.containment[key], contract.containment[key], key);
	for (const [sel, fact] of Object.entries(v1.containment.facts)) assert.equal(contract.containment.facts[sel as keyof typeof contract.containment.facts], fact);
});

test("2. Standard defines all tokens; each theme palette, including night and Zen, sets each required token", () => {
	const tokens = [...contract.tokens.required, ...contract.tokens.optional, ...Object.keys(contract.tokens.deprecated)];
	const rootTokens = [...palette(standard, ":root").keys()].filter(p => p.startsWith("--"));
	assert.deepEqual([...new Set(tokens)].sort(), rootTokens.sort(), "every :root token is public");
	for (const file of [...skins, "zen.css"]) {
		const view = file.split("/").at(-1)!.replace(".css", ""), base = `[data-view="${view}"]`;
		const roots = [view === "zen" ? `${base} :is(#zen, .connect)` : base];
		const rules = rulesOf(gui(file));
		if (source(view).phases === "day-night") roots.push(`${base}[data-phase="night"]`);
		for (const r of rules) for (const part of r.parts) if (part.startsWith(`${base}[data-phase=`) && /^\[data-view="[\w-]+"\]\[data-phase="[\w-]+"\]$/.test(part)) roots.push(part);
		for (const sel of new Set(roots)) subset(contract.tokens.required, [...palette(rules, sel).keys()], `${file}: ${sel}`);
	}
	subset(contract.markProperties, standard.filter(r => r.selector.startsWith("[data-mark")).flatMap(r => declarations(r.body).map(([p]) => p)), "mark palette");
});

test("3. Register every slot exposed by markup; showing a slot must keep it out of flow", () => {
	const markup = ["index.html", "chat.ts", "composer.ts"].map(gui).join("\n");
	const names = [...markup.matchAll(/data-slot="([\w-]+)"|["']data-slot["']:\s*["']([\w-]+)["']/g)].map(m => m[1] ?? m[2]!);
	assert.deepEqual([...new Set(names)].sort(), [...contract.slots].sort());
	for (const file of skins) selectors(gui(file), (sel, props, line) => {
		const target = subject(sel);
		if (target.includes("[data-slot]") && !target.some(n => n.startsWith("::")) && props.has("display") && !props.get("display")!.includes('"none"'))
			assert.match(props.get("position") ?? "", /"(?:fixed|absolute)"/, `${file}:${line}: visible slot in flow`);
	});
});

test("4. Standard never supplies content on a theme's reserved pseudo-elements", () => {
	selectors(gui("style.css"), (sel, props, line) => {
		if (!props.has("content")) return;
		const target = subject(sel);
		for (const reserved of contract.reservedPseudo) {
			const [owner, pseudo] = reserved.split("::");
			assert.ok(!(target.includes(owner!) && target.includes(`::${pseudo}`)), `style.css:${line}: ${reserved}`);
		}
	});
});

test("5. Each attribute has a writer in the named source (not just a theme selector)", () => {
	assert.deepEqual(Object.keys(contract.attributes).sort(), Object.keys(contract.writers).sort());
	for (const [attr, writers] of Object.entries(contract.writers)) {
		assert.ok(writers.length, attr);
		const key = attr.slice(5).replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
		for (const writer of writers) {
			const text = gui(writer);
			const write = writer.endsWith(".html") ? new RegExp(`<[^>]*\\s${attr}(?:=|\\s|>)`) : new RegExp(`dataset\\.${key}\\s*(?:=(?!=)|\\])|["']${attr}["']\\s*[:,]`);
			// composer sets these two as a pair through dataset[name].
			const pair = writer === "composer.ts" && text.includes(`["${key}", doing?.`) && text.includes("form.dataset[name] = value");
			assert.ok(write.test(text) || pair, `${writer}: ${attr}`);
		}
	}
});

test("6. Built-in skins select only registered classes, ids and attributes (including nested selectors)", () => {
	const allowed = new Set([...contract.classes.map(c => `.${c}`), ...contract.ids.map(id => `#${id}`), ...Object.keys(contract.attributes).map(a => `[${a}]`)]);
	for (const file of skins) selectors(gui(file), (sel, _, line) => {
		for (const ref of reach(sel)) if (/^[.#\[]/.test(ref)) assert.ok(allowed.has(ref), `${file}:${line}: unregistered ${ref}`);
	}); // zen.css is the mode's own UI, not a skin on Standard (§7).
});

test("8. Manifest keys and implemented code parts belong to the contract", () => {
	const manifests = readdirSync(join(root, "gui/themes"), { recursive: true, encoding: "utf8" }).filter(f => f.endsWith("theme.json"));
	const keys = new Set<string>();
	for (const file of manifests) {
		const m: ThemeManifest = JSON.parse(gui(`themes/${file}`));
		assert.equal(m.contract, contract.version, file);
		Object.keys(m).forEach(k => keys.add(k));
		const face = file.split(/[\\/]/)[0]!;
		for (const [key, path] of [...Object.entries(m.sounds ?? {}), ...Object.entries(m.ambience ?? {}).map(([phase, clip]) => [`ambience.${phase}`, clip.file] as const)]) {
			const shared = contract.sharedAssets.find(a => a.face === face && a.key === `sounds.${key}` && a.path === path);
			assert.ok(shared || (!path.startsWith("/") && !path.includes("..") && !path.includes(":")), `${file}: ${key} outside its theme: ${path}`);
		}
	}
	assert.deepEqual([...keys].sort(), [...contract.manifest].sort());
	if (contract.manifest.length) for (const face of [...VIEWS, ...MODES]) assert.ok(manifests.includes(join(face, "theme.json")), face);
	const parts = gui("themes/theme.ts").split("interface ThemeParts {")[1]!;
	for (const part of contract.parts) assert.match(parts, new RegExp(`^\\s*${part}\\?[:(]`, "m"));
});

test("9. Zen first paint matches its loaded palette; only the documented legacy paint sites may carry literals", () => {
	const zen = rulesOf(gui("zen.css"));
	const colors = palette(zen, '[data-view="zen"] :is(#zen, .connect)');
	const frame = 'html[data-view="zen"]', ring = `${frame} #zen:empty:not([hidden])::after`;
	const first = palette(standard, frame), circle = palette(standard, ring);
	assert.equal(first.get("background"), colors.get("--zen-ground")); assert.equal(first.get("color"), colors.get("--zen-paper"));
	assert.equal(circle.get("border"), `1px solid ${colors.get("--zen-line")}`);
	assert.ok(palette(zen, '[data-view="zen"] .zen-circle i').get("background")?.includes("rgba(150, 136, 116, 0.14)"));
	// §4.3 rows 8–40 exist before the token phase only. Exempt exact selector + property
	// + value, never an entire rule or colour; the token phase removes these sites.
	const ansi = ["414868", "f7768e", "9ece6a", "e0af68", "7aa2f7", "bb9af7", "7dcfff", "a9b1d6", "545c7e", "ff899d", "9fe044", "faba4a", "8db0ff", "c7a9ff", "a4daff", "c0caf5"];
	for (const r of standard.filter(r => r.selector !== ":root")) for (const [p, value] of declarations(r.body)) for (const [literal] of value.matchAll(/#[\da-f]{3,8}\b|\brgba?\([^)]*\)/gi)) {
		const ansiIndex = /^\.[ck](\d+)(?:,\s*\.kz)?$/.exec(r.selector)?.[1];
		const original = ansiIndex && literal === `#${ansi[Number(ansiIndex)]}` && p === (r.selector.startsWith(".c") ? "color" : "background");
		const wash = ['.link-alert[data-level="error"]', '.link-team[data-status="stopped"]'].includes(r.selector) && p === "background" && literal === "#f7768e";
		const allowed = original || wash || (r.parts.includes(frame) && [first.get("background"), first.get("color")].includes(literal)) ||
			(r.selector === ring && [colors.get("--zen-line"), "rgba(150, 136, 116, 0.14)"].includes(literal)) || (p.endsWith("mask") && literal === "#000" && r.selector === ".composer[data-activity] .cmp-row::before") || (r.selector === ".doc-frame" && p === "background" && literal === "#fff");
		assert.ok(allowed, `${r.selector}: ${p}: ${literal}`);
	}
});

test("10. Themes do not trap fixed descendants; Standard keeps its containment facts", () => {
	for (const [sel, fact] of Object.entries(contract.containment.facts)) {
		const [prop, value] = fact.split(": ");
		const actual = palette(standard, sel).get(prop!);
		if (value === "<non-none>") assert.ok(actual && actual !== "none", sel);
		else assert.equal(actual, value, sel);
	}
	// Only this closed-picker selector is safe: a closed or absent veil needs no viewport.
	let closedPicker: string;
	selectors('html[data-view="raven"] .comms-in:where(:not(:has(> .target-veil:not([hidden])))) {}', sel => { closedPicker = JSON.stringify(sel); });
	for (const file of [...skins, "zen.css"]) selectors(gui(file), (sel, props, line) => {
		const names = subject(sel);
		if (names.some(n => n.startsWith("::")) || !names.some(n => contract.containment.ancestors.includes(n))) return;
		for (const prop of ["transform", "filter", "backdrop-filter", "contain", "container-type", "perspective"]) assert.ok(!props.has(prop) || (prop === "backdrop-filter" && JSON.stringify(sel) === closedPicker), `${file}:${line}: ${prop} on ${names}`);
		assert.doesNotMatch(props.get("will-change") ?? "", /"transform"/, `${file}:${line}: will-change on ${names}`);
	});
});

// Contract §7.7: every possible first sheet establishes both layers, even a lazy chunk.
for (const dir of ["gui", "dist/gui"]) test(`${dir}: rules stay in their sheet's declared layer`, () => {
	const files = sheets(dir);
	assert.ok(files.length >= 6, `missing page or theme sheets: ${files.join(", ")}`);
	for (const file of files) {
		const layer = file.startsWith("themes/") || file === "zen.css" ? "theme" : "standard";
		const [order, ...blocks] = sheetRules(readFileSync(join(root, dir, file), "utf8"));
		assert.match(order?.prelude ?? "", /^@layer\s+standard\s*,\s*theme$/, file);
		assert.equal(order?.body, undefined, `expected layer statement in ${file}`);
		const layers = blocks.flatMap(b => b.prelude === "@media all" && b.body !== undefined ? [...sheetRules(b.body)] : [b]);
		assert.ok(layers.length, `empty sheet: ${file}`);
		for (const rule of layers) {
			assert.equal(rule.prelude, `@layer ${layer}`, file);
			assert.ok(rule.body?.trim(), `expected layer block in ${file}`);
		}
	}
});

test("a layer order statement does not swallow the next selector", () => {
	assert.deepEqual(rulesOf('@layer standard, theme; :root { --a: 1 }').map(r => r.selector), [":root"]);
});

const source = (view: string): ThemeManifest => JSON.parse(readFileSync(new URL(`../gui/themes/${view}/theme.json`, import.meta.url), "utf8"));

test("each face names contract 1 and a theme colour; Standard supplies the first paint and default badge", () => {
	for (const view of [...VIEWS, ...MODES]) {
		const m = source(view);
		assert.equal(m.contract, 1, view);
		for (const p of ["day", "night"] as const) assert.match(typeof m.color === "string" ? m.color : m.color[p], /^#[\da-f]{6}$/i);
	}
	assert.ok(source("standard").badge);
	const page = readFileSync(new URL("../gui/index.html", import.meta.url), "utf8");
	assert.equal(page.match(/name="theme-color" content="([^"]+)"/)?.[1], source("standard").color);
});

test("manifest loops reproduce the old gains within 0.5 dB and every effect records its measured peak", async () => {
	const { ambienceGain } = await import("../gui/ambience.ts");
	const gains: Record<string, number> = { "raven/loop": 0.045, "storybook/day": 0.089, "storybook/night": 0.063 };
	const seen: string[] = [];
	for (const view of [...VIEWS, ...MODES]) {
		const m = source(view);
		for (const [key, clip] of Object.entries(m.ambience ?? {})) {
			const id = `${view}/${key}`, gain = ambienceGain(clip.meanDbfs);
			assert.ok(Math.abs(20 * Math.log10(gain / gains[id]!)) < 0.5, id);
			assert.ok(Math.abs(clip.meanDbfs + 20 * Math.log10(gain) + 42) < 1e-6, id);
			seen.push(id);
		}
		assert.deepEqual(Object.keys(m.sounds ?? {}).sort(), Object.keys(m.soundPeaks ?? {}).sort(), view);
		for (const peak of Object.values(m.soundPeaks ?? {})) assert.ok(Number.isFinite(peak) && peak <= 0);
	}
	assert.deepEqual(seen.sort(), Object.keys(gains).sort());
});
