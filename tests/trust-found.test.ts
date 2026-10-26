import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hasTrustRequiringProjectResources } from "@earendil-works/pi-coding-agent";
import { foundIn, MAX_FOUND, MAX_ITEM, MAX_ITEMS } from "../src/trust/found.ts";

// What trusting a folder would load (src/trust/found.ts), pinned against pi's own list of protected resources.

const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-trust-found-")));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let n = 0;
const folder = (setup: (dir: string) => void) => {
	const dir = join(root, `f${n++}`);
	mkdirSync(join(dir, "work"), { recursive: true });
	setup(join(dir, "work"));
	return join(dir, "work");
};
const home = join(root, "home");
mkdirSync(home);

const FIXTURES: [string, string, (dir: string) => void, (g: ReturnType<typeof foundIn>) => void][] = [
	["settings.json", "settings", (d) => (mkdirSync(join(d, ".pi")), writeFileSync(join(d, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:demo", { source: "git:github.com/x/y" }], extensions: ["./ext.ts"], theme: "dark", quietStartup: true }))),
		(g) => assert.deepEqual(g[0], { kind: "settings", path: ".pi/settings.json", items: ["package: npm:demo", "package: git:github.com/x/y", "extensions: ./ext.ts", "2 other settings"], more: 0 })],
	["mcp.json", "mcp", (d) => (mkdirSync(join(d, ".pi")), writeFileSync(join(d, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "files-mcp"] }, web: { url: "https://example.com/mcp" } } }))),
		(g) => assert.deepEqual(g[0]!.items, ["files: npx -y files-mcp", "web: https://example.com/mcp"])],
	["extensions", "extensions", (d) => (mkdirSync(join(d, ".pi", "extensions"), { recursive: true }), writeFileSync(join(d, ".pi", "extensions", "hello.ts"), "")), (g) => assert.deepEqual(g[0]!.items, ["hello.ts"])],
	["skills", "skills", (d) => mkdirSync(join(d, ".pi", "skills", "review"), { recursive: true }), (g) => assert.deepEqual(g[0]!.items, ["review"])],
	["prompts", "prompts", (d) => (mkdirSync(join(d, ".pi", "prompts"), { recursive: true }), writeFileSync(join(d, ".pi", "prompts", "fix.md"), "")), (g) => assert.deepEqual(g[0]!.items, ["fix.md"])],
	["themes", "themes", (d) => (mkdirSync(join(d, ".pi", "themes"), { recursive: true }), writeFileSync(join(d, ".pi", "themes", "x.json"), "")), (g) => assert.deepEqual(g[0]!.items, ["x.json"])],
	["SYSTEM.md", "system", (d) => (mkdirSync(join(d, ".pi")), writeFileSync(join(d, ".pi", "SYSTEM.md"), "x")), (g) => assert.deepEqual(g[0], { kind: "system", path: ".pi/SYSTEM.md", items: [], more: 0 })],
	["APPEND_SYSTEM.md", "append-system", (d) => (mkdirSync(join(d, ".pi")), writeFileSync(join(d, ".pi", "APPEND_SYSTEM.md"), "x")), (g) => assert.equal(g[0]!.path, ".pi/APPEND_SYSTEM.md")],
	[".agents/skills", "agents-skills", (d) => mkdirSync(join(d, ".agents", "skills", "demo"), { recursive: true }), (g) => assert.deepEqual(g[0], { kind: "agents-skills", path: ".agents/skills", items: ["demo"], more: 0 })],
];
for (const [name, kind, setup, check] of FIXTURES) {
	test(`${name} in the folder is a group of its own, and pi's own check calls the folder protected`, () => {
		const dir = folder(setup);
		assert.equal(hasTrustRequiringProjectResources(dir), true, "pins the list against pi's");
		const found = foundIn(dir, home);
		assert.equal(found[0]!.kind, kind);
		check(found);
	});
}

test("a folder with nothing protected has no group; .agents/skills in an ancestor is found with its relative path, ~/.agents/skills is not", () => {
	const plain = folder(() => {});
	assert.deepEqual(foundIn(plain, home), []);
	const nested = folder((d) => {
		mkdirSync(join(d, "..", ".agents", "skills", "up"), { recursive: true });
		mkdirSync(join(d, "sub"), { recursive: true });
	});
	assert.equal(hasTrustRequiringProjectResources(join(nested, "sub")), true);
	assert.deepEqual(foundIn(join(nested, "sub"), home).map((g) => [g.kind, g.path, g.items]), [["agents-skills", "../../.agents/skills", ["up"]]]);
	const user = join(home, ".agents", "skills", "mine");
	mkdirSync(user, { recursive: true });
	assert.deepEqual(foundIn(home, home), [], "the user's own skills are always trusted");
});

test("the caps: 20 items a group, 120 characters an item, `more` counts what was cut, and the whole stays under 32 KB", () => {
	const many = folder((d) => (mkdirSync(join(d, ".pi", "extensions"), { recursive: true }), [...Array(25).keys()].forEach((i) => writeFileSync(join(d, ".pi", "extensions", `e${String(i).padStart(2, "0")}-${"x".repeat(200)}.ts`), ""))));
	const [g] = foundIn(many, home);
	assert.equal(g!.items.length, MAX_ITEMS);
	assert.equal(g!.more, 5);
	assert.ok(g!.items.every((i) => [...i].length <= MAX_ITEM));
	assert.ok(g!.items[0]!.endsWith("…"));
	const huge = folder((d) => {
		mkdirSync(join(d, ".pi"), { recursive: true });
		for (const kind of ["extensions", "skills", "prompts", "themes"]) {
			mkdirSync(join(d, ".pi", kind));
			for (let i = 0; i < 20; i++) writeFileSync(join(d, ".pi", kind, `${kind}${i}-${"y".repeat(100)}`), "");
		}
		writeFileSync(join(d, ".pi", "settings.json"), JSON.stringify({ packages: [...Array(60).keys()].map((i) => `npm:${"p".repeat(100)}${i}`) }));
	});
	assert.ok(Buffer.byteLength(JSON.stringify(foundIn(huge, home))) <= MAX_FOUND);
});

test("a settings.json or mcp.json that cannot be read or parsed is listed as unreadable", () => {
	const bad = folder((d) => (mkdirSync(join(d, ".pi")), writeFileSync(join(d, ".pi", "settings.json"), "{nope"), writeFileSync(join(d, ".pi", "mcp.json"), "[]garbage")));
	assert.deepEqual(foundIn(bad, home), [
		{ kind: "settings", path: ".pi/settings.json", items: [], more: 0, unreadable: true },
		{ kind: "mcp", path: ".pi/mcp.json", items: [], more: 0, unreadable: true },
	]);
});
