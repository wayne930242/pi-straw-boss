import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findIntercom } from "../agent/paths.ts";
import type { IntercomLike } from "../agent/kit.ts";
import { newer } from "../semver.ts";

// The server's way to pi-intercom (docs/specs/2026-10-26-sb-backend.md, What the server runs from). pi-intercom ships TypeScript only, so its client needs a loader; the
// server loads that and nothing else through tsx's scoped `tsImport()`, so its own prebuilt code is never transformed. tsx is resolved from this package, never from
// beside pi-intercom, and pi-intercom 0.18.1 or newer is required (its mailbox keeps mail for a disconnected id, which the tower service relies on).

export const MIN_INTERCOM = "0.18.1";

export class LoaderError extends Error {
	/** `loader`: tsx is missing. `intercom`: pi-intercom is missing or older than MIN_INTERCOM. */
	code: "loader" | "intercom";
	constructor(code: "loader" | "intercom", message: string) {
		super(message);
		this.code = code;
	}
}

type TsImport = (specifier: string, parent: string) => Promise<Record<string, unknown>>;
interface ClientModule { IntercomClient: new () => IntercomLike }
interface SpawnModule { spawnBrokerIfNeeded(command: string, args: string[]): Promise<unknown> }
interface ConfigModule { loadConfig(): { brokerCommand: string; brokerArgs: string[] } }

/** Where tsx's API is, found from this package (`from`: a file URL or path inside it). Throws a LoaderError naming the place it looked from. */
export function findTsx(from: string = import.meta.url): string {
	const place = from.startsWith("file:") ? fileURLToPath(from) : from;
	try {
		return createRequire(place).resolve("tsx/esm/api");
	} catch {
		throw new LoaderError("loader", `tsx was not found from ${place}: it is a dependency of pi-straw-boss, so reinstall the package`);
	}
}
/** The version of the pi-intercom in `dir`. */
export function intercomVersion(dir: string): string | undefined {
	try {
		const version = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: unknown }).version;
		return typeof version === "string" ? version : undefined;
	} catch {
		return undefined;
	}
}
/** pi-intercom's folder, which must hold a version that is at least MIN_INTERCOM. */
export function findIntercomDir(env: NodeJS.ProcessEnv, root: string): { dir: string; version: string } {
	let dir: string;
	try {
		// `findIntercom` looks beside the package that holds the code under `<root>/src/agent`, which is where pi installs both.
		dir = findIntercom(env, join(root, "src", "agent"));
	} catch (error) {
		throw new LoaderError("intercom", `${(error as Error).message}; the sb server needs pi-intercom ${MIN_INTERCOM} or newer`);
	}
	const version = intercomVersion(dir);
	if (!version) throw new LoaderError("intercom", `pi-intercom's version could not be read from ${dir}; the sb server needs ${MIN_INTERCOM} or newer`);
	if (newer(MIN_INTERCOM, version)) throw new LoaderError("intercom", `pi-intercom ${version} (${dir}) is older than ${MIN_INTERCOM}, which the sb server needs: update it`);
	return { dir, version };
}

export interface IntercomModule {
	dir: string;
	version: string;
	/** A client of the broker, with the broker started first when none runs. */
	connect(): Promise<IntercomLike>;
}
export interface LoadOptions {
	env: NodeJS.ProcessEnv;
	/** The package folder (version.ts `packageRoot`). */
	root: string;
	/** Where tsx is looked for from; this module's own file by default. */
	from?: string;
	tsImport?: TsImport;
}
/** Checks that the server can reach pi-intercom, and returns the way to. Throws a LoaderError when it cannot; nothing is loaded yet. */
export async function loadIntercom({ env, root, from, tsImport }: LoadOptions): Promise<IntercomModule> {
	const api = findTsx(from);
	const { dir, version } = findIntercomDir(env, root);
	let load = tsImport;
	// SAFETY: each file is one of pi-intercom's modules at the version checked above; the interfaces name only the members the server uses.
	const needed = async <T>(file: string) => {
		load ??= ((await import(pathToFileURL(api).href)) as { tsImport: TsImport }).tsImport;
		return (await load(pathToFileURL(join(dir, file)).href, import.meta.url)) as T;
	};
	return {
		dir, version,
		async connect() {
			const [client, spawn, config] = await Promise.all([needed<ClientModule>("broker/client.ts"), needed<SpawnModule>("broker/spawn.ts"), needed<ConfigModule>("config.ts")]);
			const { brokerCommand, brokerArgs } = config.loadConfig();
			await spawn.spawnBrokerIfNeeded(brokerCommand, brokerArgs);
			return new client.IntercomClient();
		},
	};
}
