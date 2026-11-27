import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The Maestro build sb's host runs, for sb_doctor: its version and root, and the commit npm resolved for the git dependency. maestroBuildInfo() names no
// commit, so the commit is read where npm wrote it: the hidden lock of an npm install (`<prefix>/node_modules/.package-lock.json`, the file
// engine-build.ts keys on), else the package-lock.json of a checkout. Nothing of Maestro is imported.

export interface MaestroPin { version?: string; root?: string; sha?: string; /** The lock the commit came from. */ lock?: string; error?: string }

const read = (file: string) => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return undefined;
	}
};

export function maestroPin(sbRoot = fileURLToPath(new URL("../../", import.meta.url))): MaestroPin {
	let root: string;
	try {
		root = dirname(createRequire(join(sbRoot, "package.json")).resolve("@nubl/maestro/package.json"));
	} catch (error) {
		return { error: `@nubl/maestro does not resolve from ${sbRoot}: ${(error as Error).message.split("\n")[0]}` };
	}
	const version = read(join(root, "package.json"))?.version as string | undefined;
	for (const lock of [join(root, "..", "..", ".package-lock.json"), join(sbRoot, "package-lock.json")]) {
		const entry = (read(lock)?.packages as Record<string, { resolved?: string }> | undefined)?.["node_modules/@nubl/maestro"];
		const sha = entry?.resolved?.match(/#([0-9a-f]{40})$/)?.[1];
		if (sha) return { ...(version ? { version } : {}), root, sha, lock };
	}
	return { ...(version ? { version } : {}), root, error: "no lock names its commit" };
}

export const pinText = (p: MaestroPin) => (p.root ? `Maestro ${p.version ?? "?"} @${p.sha?.slice(0, 7) ?? "?"} (${p.root}${p.lock ? `; ${p.lock}` : ""})${p.error ? `: ${p.error}` : ""}` : `Maestro: ${p.error}`);
