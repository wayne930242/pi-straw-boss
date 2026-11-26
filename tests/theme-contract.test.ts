import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rulesOf, sheetRules } from "./css-rules.ts";
import { MODES, VIEWS } from "../src/views.ts";
import type { ThemeManifest } from "../gui/themes/manifest.ts";

const root = join(import.meta.dirname, "..");
const sheets = (dir: string) => readdirSync(join(root, dir), { recursive: true, encoding: "utf8" }).map(f => f.replaceAll("\\", "/")).filter(f => f.endsWith(".css"));

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
