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
	for (const entry of manifest.pi.extensions) assert.ok(existsSync(join(root, entry)), entry);
});

test("the TypeScript source stays within the size budget", () => {
	const lines = readdirSync(join(root, "src")).reduce((sum, name) => sum + readFileSync(join(root, "src", name), "utf8").trimEnd().split("\n").length, 0);
	assert.ok(lines <= 430, `src has ${lines} lines`);
});
