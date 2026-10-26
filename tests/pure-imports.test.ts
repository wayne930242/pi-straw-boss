import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const BANNED = ["@earendil-works/pi-tui", "typebox", "@earendil-works/pi-coding-agent"];

// The server bundle marks pi-tui, typebox, and pi-coding-agent external and fails when it still imports them, and pi's peer dependencies
// are not on disk where the server runs. What the server loads is walked from its data modules: a value import of the three anywhere in
// the graph fails here; a type import is erased, so it stays fine.

/** The module specifiers a file loads at run time: every import and re-export that is not `import type`/`export type`, nor a list of only inline `type` specifiers, and every dynamic `import("…")`. */
function valueImports(source: string): string[] {
	const code = source.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
	const found: string[] = [];
	for (const [, clause = "", specifier = ""] of code.matchAll(/(?:^|[\n;])\s*(?:import|export)\b([^"'`;]*?)\bfrom\s*["']([^"']+)["']/g)) {
		if (/^\s*type\b/.test(clause)) continue;
		const named = /^\s*\{([^}]*)\}\s*$/.exec(clause)?.[1];
		if (named?.trim() && named.split(",").every((part) => !part.trim() || /^type\s/.test(part.trim()))) continue;
		found.push(specifier);
	}
	for (const [, specifier = ""] of code.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g)) found.push(specifier);
	for (const [, specifier = ""] of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) found.push(specifier);
	return found;
}

/** Every banned package a value import reaches from `entry`, with the chain of files that leads to it. */
function bannedFrom(entry: string, read: (path: string) => string = (path) => readFileSync(join(root, path), "utf8")): string[] {
	const seen = new Set<string>(), hits: string[] = [];
	const visit = (path: string, chain: string[]) => {
		if (seen.has(path)) return;
		seen.add(path);
		for (const specifier of valueImports(read(path))) {
			if (specifier.startsWith(".")) visit(relative(root, join(root, dirname(path), specifier)), [...chain, path]);
			else if (BANNED.some((name) => specifier === name || specifier.startsWith(`${name}/`))) hits.push(`${[...chain, path].join(" -> ")} -> ${specifier}`);
		}
	};
	visit(entry, []);
	return hits;
}

test("the value-import reader tells value imports from type imports", () => {
	const source = [
		'import { a } from "./a.ts";',
		'import type { B } from "./b.ts";',
		'import { type C, type D } from "./c.ts";',
		'import { type E, f } from "./e.ts";',
		'import g, { h } from "./g.ts";',
		'import * as i from "./i.ts";',
		'import "./side.ts";',
		'export { j } from "./j.ts";',
		'export type { K } from "./k.ts";',
		'export * from "./l.ts";',
		'const m = await import("./m.ts");',
		'// import { n } from "./n.ts";',
		'/* import { o } from "./o.ts"; */',
		"import {",
		"\tp,",
		'} from "./p.ts";',
	].join("\n");
	assert.deepEqual(valueImports(source), ["./a.ts", "./e.ts", "./g.ts", "./i.ts", "./j.ts", "./l.ts", "./p.ts", "./side.ts", "./m.ts"]);
});

test("the walk finds a banned package behind a chain of relative imports, and not behind a type import", () => {
	const files: Record<string, string> = {
		"src/entry.ts": 'import { a } from "./a.ts";\nimport type { T } from "@earendil-works/pi-tui";',
		"src/a.ts": 'import { matchesKey } from "@earendil-works/pi-tui";',
		"src/clean.ts": 'import type { Tool } from "@earendil-works/pi-coding-agent";\nimport { open } from "node:fs";',
	};
	const read = (path: string) => files[path] ?? assert.fail(path);
	assert.deepEqual(bannedFrom("src/entry.ts", read), ["src/entry.ts -> src/a.ts -> @earendil-works/pi-tui"]);
	assert.deepEqual(bannedFrom("src/clean.ts", read), []);
});

// The data module is what the server loads from the dashboard; net.ts, ask.ts, and reach.ts are the modules that read it.
for (const entry of ["src/netdata.ts", "src/net.ts", "src/ask.ts", "src/reach.ts"]) {
	test(`${entry} reaches no value import of pi-tui, typebox, or pi-coding-agent`, () => {
		assert.deepEqual(bannedFrom(entry), []);
	});
}
