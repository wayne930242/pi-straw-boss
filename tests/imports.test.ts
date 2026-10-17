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

test("the manifest ships only src, the built GUI bundle, prompts, README, and LICENSE, has no runtime dependencies, builds the bundle before packing and testing, and points at a real entry", () => {
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.files, ["src", "dist/gui", "prompts", "README.md", "LICENSE"]);
	assert.equal(manifest.dependencies, undefined);
	assert.ok(manifest.devDependencies.vite, "the page is built with Vite, as a development dependency only");
	assert.equal(manifest.scripts.prepack, "npm run gui:build");
	assert.equal(manifest.scripts.pretest, "npm run gui:build");
	assert.ok(manifest.keywords.includes("pi-package"));
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
	for (const entry of manifest.pi.extensions) assert.ok(existsSync(join(root, entry)), entry);
});

test("the TypeScript source stays within its size budgets", () => {
	const count = (path: string) => readFileSync(join(root, path), "utf8").trimEnd().split("\n").length;
	const names = (dir: string) => readdirSync(join(root, dir)).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"));
	// The dashboard and the browser view's server and data code each have a budget of their own so the coordination code stays readable on its own.
	assert.ok(count("src/dashboard.ts") <= 200, `src/dashboard.ts has ${count("src/dashboard.ts")} lines`);
	const server = ["net.ts", "gui.ts"].reduce((sum, name) => sum + count(`src/${name}`), 0);
	assert.ok(server <= 250, `src/net.ts and src/gui.ts have ${server} lines`);
	const rest = names("src").filter((name) => !["dashboard.ts", "net.ts", "gui.ts"].includes(name)).reduce((sum, name) => sum + count(`src/${name}`), 0);
	assert.ok(rest <= 540, `the rest of src has ${rest} lines`);
	const page = names("gui").reduce((sum, name) => sum + count(`gui/${name}`), 0);
	assert.ok(page <= 520, `the page's TypeScript has ${page} lines`);
});

test("the built page is small, self-contained (no remote URLs, fonts, or imports), and carries no demo fixture", { skip: !existsSync(join(root, "dist/gui/index.html")) && "run npm run gui:build first" }, () => {
	const dir = join(root, "dist/gui");
	const files = [join(dir, "index.html"), ...readdirSync(join(dir, "assets")).map((name) => join(dir, "assets", name))];
	const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
	const remote = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((url) => url !== "http://www.w3.org/2000/svg");
	assert.deepEqual(remote, [], "nothing is fetched from elsewhere");
	assert.ok(!/@import|<link[^>]+href="https?:/.test(text));
	assert.ok(!text.includes("Harbor API") && !text.includes("demo fixture"), "the demo fixture stays out of the bundle");
	assert.ok(/EventSource/.test(text), "the built page reads the live stream");
	const js = readdirSync(join(dir, "assets")).filter((name) => name.endsWith(".js")).reduce((sum, name) => sum + readFileSync(join(dir, "assets", name)).length, 0);
	assert.ok(js < 40_000, `the page's JavaScript is ${js} bytes`);
});
