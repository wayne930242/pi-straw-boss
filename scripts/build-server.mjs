// Bundles the sb server (docs/specs/2026-10-26-sb-backend.md, What the server runs from): src/server/main.ts and cli.ts become dist/server/main.mjs and cli.mjs, ES
// modules for Node 22 that run under plain `node`. pi provides @earendil-works/pi-tui, typebox, and @earendil-works/pi-coding-agent in its own process only, so
// the server must not load them: they are marked external, and the build fails when the bundle still imports one (type imports are fine, esbuild drops them).
// tsx stays external too: the server resolves it at runtime from this package, for pi-intercom's TypeScript client only.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN = ["@earendil-works/pi-tui", "typebox", "@earendil-works/pi-coding-agent"];
const here = dirname(fileURLToPath(import.meta.url));

const forbidden = (path) => FORBIDDEN.some((name) => path === name || path.startsWith(`${name}/`));

/** Builds the entries and checks the bundle; resolves with esbuild's metafile, rejects with the inputs that import a forbidden package. */
export async function buildServer({ root = join(here, ".."), entries = { main: "src/server/main.ts", cli: "src/server/cli.ts" }, outdir = join(root, "dist", "server") } = {}) {
	rmSync(outdir, { recursive: true, force: true });
	const result = await build({
		absWorkingDir: root, entryPoints: entries, outdir, entryNames: "[name]", chunkNames: "chunk-[hash]", outExtension: { ".js": ".mjs" },
		bundle: true, splitting: true, format: "esm", platform: "node", target: "node22", legalComments: "none", metafile: true, logLevel: "warning",
		external: [...FORBIDDEN, ...FORBIDDEN.map((name) => `${name}/*`), "tsx", "tsx/*"],
		// cli.mjs loads main.mjs beside it by a computed URL, which is the point: `status`, `stop`, and `logs` need not load the server.
		logOverride: { "unsupported-dynamic-import": "silent" },
	});
	const bad = [];
	for (const [file, input] of Object.entries(result.metafile.inputs)) {
		for (const imported of input.imports) if (imported.external && forbidden(imported.path)) bad.push(`${file} imports ${imported.path}`);
	}
	if (bad.length) {
		rmSync(outdir, { recursive: true, force: true });
		throw new Error(`the sb server must not load pi's own packages (they are not on disk when pi installs this package); a value import of one reaches the server from:\n  ${bad.join("\n  ")}`);
	}
	return result.metafile;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	buildServer().then(
		(meta) => console.log(`dist/server: ${Object.keys(meta.outputs).map((file) => file.replace(/^.*dist\/server\//, "")).join(", ")}`),
		(error) => { console.error(error.message); process.exit(1); },
	);
}
