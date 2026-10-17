import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
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
	const sum = (dir: string, list: string[]) => list.reduce((total, name) => total + count(`${dir}/${name}`), 0);
	// The dashboard, the browser view's server and data code, and the session reader each have a budget of their own so the coordination code stays readable on its own.
	assert.ok(count("src/dashboard.ts") <= 200, `src/dashboard.ts has ${count("src/dashboard.ts")} lines`);
	assert.ok(sum("src", ["net.ts", "gui.ts"]) <= 300, `src/net.ts and src/gui.ts have ${sum("src", ["net.ts", "gui.ts"])} lines`);
	assert.ok(count("src/history.ts") <= 250, `src/history.ts has ${count("src/history.ts")} lines`);
	// The item mapping and the stream glue came out of the reader to keep it within its budget; the spec sets no figure for them.
	assert.ok(count("src/items.ts") <= 100, `src/items.ts has ${count("src/items.ts")} lines`);
	assert.ok(count("src/watch.ts") <= 90, `src/watch.ts has ${count("src/watch.ts")} lines`);
	// Pane balance is a separate extension entry with its plain-JavaScript helper.
	assert.ok(count("src/balance.ts") + count("src/balance.mjs") <= 220, "src/balance.ts and src/balance.mjs stay small");
	const apart = ["dashboard.ts", "net.ts", "gui.ts", "history.ts", "items.ts", "watch.ts", "balance.ts"];
	const rest = sum("src", names("src").filter((name) => !apart.includes(name)));
	assert.ok(rest <= 540, `the rest of src has ${rest} lines`);
	// The page: the files the spec budgets one by one, then this round's own figures (no figure in the spec): the focus views, the overlay
	// layer (alert spotting and the stack model in the map's chunk, the layer's DOM and tiles in a chunk of their own), the dev-only demo, and everything else.
	for (const [name, max] of [["router.ts", 80], ["chat.ts", 250], ["markdown.ts", 180], ["views.ts", 240], ["layer.ts", 150]] as const) assert.ok(count(`gui/${name}`) <= max, `gui/${name} has ${count(`gui/${name}`)} lines`);
	const overlay = sum("gui", ["alerts.ts", "overlay.ts"]);
	assert.ok(overlay <= 110, `the overlay model has ${overlay} lines`);
	const demo = sum("gui", ["fixture.ts", "demo-chat.ts"]);
	assert.ok(demo <= 160, `the demo fixture has ${demo} lines`);
	const shipped = new Set(["router.ts", "chat.ts", "markdown.ts", "views.ts", "layer.ts", "alerts.ts", "overlay.ts", "fixture.ts", "demo-chat.ts"]);
	const page = sum("gui", names("gui").filter((name) => !shipped.has(name)));
	assert.ok(page <= 540, `the page's TypeScript has ${page} lines`);
});

test("the built page is small, self-contained (no remote URLs, fonts, or imports), and carries no demo fixture", { skip: !existsSync(join(root, "dist/gui/index.html")) && "run npm run gui:build first" }, () => {
	const dir = join(root, "dist/gui");
	const files = [join(dir, "index.html"), ...readdirSync(join(dir, "assets")).map((name) => join(dir, "assets", name))];
	const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
	const remote = [...text.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]).filter((url) => url !== "http://www.w3.org/2000/svg");
	assert.deepEqual(remote, [], "nothing is fetched from elsewhere");
	assert.ok(!/@import|<link[^>]+href="https?:/.test(text));
	assert.ok(!text.includes("Harbor API") && !text.includes("demo fixture") && !text.includes("harbor-1"), "the demo fixture stays out of the bundle");
	assert.ok(/EventSource/.test(text), "the built page reads the live stream");
	assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML/.test(text), "no page code writes markup");
	// Budgets from the spec: the map's JavaScript, the lazy chunks together (views, chat with markdown, the overlay layer), and the stylesheet, raw and gzipped.
	const assets = readdirSync(join(dir, "assets")), size = (name: string) => readFileSync(join(dir, "assets", name)), gz = (name: string) => gzipSync(size(name)).length;
	const entry = /assets\/(index-[\w-]+\.js)/.exec(readFileSync(join(dir, "index.html"), "utf8"))?.[1];
	assert.ok(entry, "index.html loads one entry script");
	const chunks = assets.filter((name) => name.endsWith(".js") && name !== entry), css = assets.filter((name) => name.endsWith(".css"));
	const total = (list: string[], measure: (name: string) => number) => list.reduce((sum, name) => sum + measure(name), 0);
	assert.ok(size(entry).length <= 15_000 && gz(entry) <= 6_000, `the map chunk is ${size(entry).length} bytes (${gz(entry)} gzipped)`);
	assert.ok(chunks.length >= 1 && total(chunks, (n) => size(n).length) <= 35_000 && total(chunks, gz) <= 12_000, `the chat chunks are ${total(chunks, (n) => size(n).length)} bytes (${total(chunks, gz)} gzipped)`);
	assert.ok(total(css, (n) => size(n).length) <= 22_000 && total(css, gz) <= 6_000, `the stylesheet is ${total(css, (n) => size(n).length)} bytes (${total(css, gz)} gzipped)`);
});
