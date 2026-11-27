import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

// Who else hosts subagents in this pi (docs/specs host-switch F015). sb registers its host only at session start, after every extension's factory has run,
// so what other extensions registered is complete by then whatever the load order. The evidence is Pi's own record of each registration:
// - `pi.getCommands()` lists every extension's commands before any dedupe (a second `/subagent` is listed as `subagent:2`), each with the resolved path of
//   the extension that registered it;
// - `pi.getAllTools()` names the extension whose `subagent` tool won.
// A path resolves to its package by the nearest package.json above it (symlinks resolved), so a checkout, an npm install and a `-e` path all name
// pi-herdr-agents the same way. Load order, the shared load stamp and the runtime slot a previous load left are never read.

export interface Registered { name: string; source?: string; sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string } }
export interface Rival { /** The registering extension's resolved path. */ path: string; /** Its package's name, when a package.json above it has one. */ pkg?: string; configured?: { source: string; local: boolean }; via: ("tool" | "command")[] }

const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

/** The name of the package that holds `path`: the nearest package.json above it that names one. */
export function packageOf(path: string): string | undefined {
	let dir = dirname(real(path));
	for (let i = 0; i < 12; i++) {
		try {
			const name = (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown }).name;
			if (typeof name === "string" && name) return name;
		} catch { /* none here */ }
		const up = dirname(dir);
		if (up === dir) return undefined;
		dir = up;
	}
	return undefined;
}

const COMMAND = /^subagent(:\d+)?$/;

/** The extensions other than this package (`selfRoot`) that registered `subagent`, as a tool or the `/subagent` command. */
export function rivalsOf(commands: readonly Registered[], tools: readonly Registered[], selfRoot: string): Rival[] {
	const self = real(selfRoot), mine = (path: string) => real(path) === self || real(path).startsWith(self + sep);
	const found = new Map<string, Rival>();
	const add = (info: Registered["sourceInfo"], via: "tool" | "command") => {
		const path = info?.path;
		if (!path || path.startsWith("builtin:") || path.startsWith("<") || mine(path)) return;
		const key = real(path), was = found.get(key);
		if (was) return void (was.via.includes(via) || was.via.push(via));
		const pkg = packageOf(path);
		// Pi's package resolver records the verbatim settings entry (including version/ref) and its scope.
		const configured = info.origin === "package" && info.source && (info.scope === "user" || info.scope === "project") ? { source: info.source, local: info.scope === "project" } : undefined;
		found.set(key, { path: key, ...(configured ? { configured } : {}), ...(pkg ? { pkg } : {}), via: [via] });
	};
	for (const c of commands) if (c.source === "extension" && COMMAND.test(c.name)) add(c.sourceInfo, "command");
	for (const t of tools) if (t.name === "subagent") add(t.sourceInfo, "tool");
	return [...found.values()];
}

/** The sentence a stand-down reports, naming each rival by its package and path. */
export const rivalText = (rivals: readonly Rival[]) =>
	rivals.map((r) => `${r.pkg ?? "an extension"} registered ${r.via.map((v) => (v === "command" ? "/subagent" : "the subagent tool")).join(" and ")} (${r.path})`).join("; ");
