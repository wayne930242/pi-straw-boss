import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { rulesOf, sheetRules } from "./css-rules.ts";

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
