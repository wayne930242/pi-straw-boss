import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import strawBoss, { createStrawBoss } from "../src/index.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// Pi reloads extension TypeScript on /reload, but Node caches native .js/.mjs modules for the
// life of the process. A relative JavaScript import would keep an old version after an upgrade.
test("extension code imports relative modules only as .ts", () => {
	for (const name of readdirSync(join(root, "src")).filter((file) => file.endsWith(".ts"))) {
		for (const [, specifier] of readFileSync(join(root, "src", name), "utf8").matchAll(/from\s+["'](\.[^"']*)["']/g)) {
			assert.match(specifier ?? "", /\.ts$/, `src/${name} imports ${specifier}`);
		}
	}
});

test("the module loads, its factory runs, and outside Herdr it registers nothing", () => {
	assert.equal(typeof strawBoss, "function");
	const registered: string[] = [];
	const pi = { on: (type: string) => registered.push(type), registerTool: () => registered.push("tool"), registerCommand: () => registered.push("command") };
	createStrawBoss({ env: {} })(pi as never);
	assert.deepEqual(registered, []);
});

test("the manifest ships only src, prompts, README, and LICENSE, has no runtime dependencies, and points at a real entry", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.files, ["src", "prompts", "README.md", "LICENSE"]);
	assert.equal(manifest.dependencies, undefined);
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
	for (const entry of manifest.pi.extensions) assert.ok(existsSync(join(root, entry)), entry);
});

test("the TypeScript source stays within its size budgets", () => {
	const count = (name: string) => readFileSync(join(root, "src", name), "utf8").trimEnd().split("\n").length;
	const names = readdirSync(join(root, "src")).filter((file) => file.endsWith(".ts"));
	// The dashboard has a budget of its own so the coordination code stays readable on its own.
	assert.ok(count("dashboard.ts") <= 200, `src/dashboard.ts has ${count("dashboard.ts")} lines`);
	const rest = names.filter((name) => name !== "dashboard.ts").reduce((sum, name) => sum + count(name), 0);
	assert.ok(rest <= 500, `the rest of src has ${rest} lines`);
});
