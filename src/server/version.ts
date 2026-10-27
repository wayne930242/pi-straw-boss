import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Where the server runs from and which version it is: the same code runs from src/server/ in a checkout and from dist/server/ once built.

export const PACKAGE = "pi-straw-boss";

/** The folder of this package: the nearest one up from `from` whose package.json names it. */
export function packageRoot(from: string = import.meta.url): string {
	let dir = dirname(fileURLToPath(from));
	for (let up = 0; up < 6; up++, dir = dirname(dir)) {
		try {
			if ((JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name === PACKAGE) return dir;
		} catch { /* not this folder */ }
	}
	throw new Error(`${PACKAGE}'s package.json was not found above ${fromHere(from)}`);
}
const fromHere = (from: string) => { try { return fileURLToPath(from); } catch { return from; } };

/** The version of the package the server runs from. */
export const VERSION: string = (JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { version: string }).version;

/** The file the server is started from: the built `dist/server/cli.mjs` of this package, or `src/server/cli.ts` in a checkout (Node runs it as it is). */
export function serverCli(root: string = packageRoot()): string {
	const built = join(root, "dist", "server", "cli.mjs");
	return existsSync(built) ? built : join(root, "src", "server", "cli.ts");
}
