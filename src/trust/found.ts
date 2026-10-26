import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import type { TrustGroup } from "./types.ts";

// What trusting a folder would load, read by the asking pi from its own folder: the same resources pi's `hasTrustRequiringProjectResources` looks at
// (.pi/settings.json, mcp.json, extensions, skills, prompts, themes, SYSTEM.md, APPEND_SYSTEM.md, and .agents/skills in the folder or any ancestor
// but ~/.agents/skills), one group each. The caps keep a request small: 20 items a group, 120 characters an item, 32 KB in all.

export const MAX_ITEMS = 20, MAX_ITEM = 120, MAX_FOUND = 32_768;
const DIRS = ["extensions", "skills", "prompts", "themes"] as const, FILES = [["SYSTEM.md", "system"], ["APPEND_SYSTEM.md", "append-system"]] as const;
const cut = (text: string) => ([...text].length > MAX_ITEM ? `${[...text].slice(0, MAX_ITEM - 1).join("")}…` : text);
const group = (kind: string, path: string, all: string[]): TrustGroup => ({ kind, path, items: all.slice(0, MAX_ITEMS).map(cut), more: Math.max(0, all.length - MAX_ITEMS) });
const unreadable = (kind: string, path: string): TrustGroup => ({ kind, path, items: [], more: 0, unreadable: true });
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const names = (dir: string) => readdirSync(dir).sort();

/** .pi/settings.json: the packages pi would install, the paths it adds, and a count of its other keys. */
function settings(file: string): TrustGroup {
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	if (!object(parsed)) throw new Error("not an object");
	const items: string[] = [];
	for (const p of Array.isArray(parsed.packages) ? parsed.packages : []) {
		const source = typeof p === "string" ? p : object(p) && typeof p.source === "string" ? p.source : undefined;
		if (source) items.push(`package: ${source}`);
	}
	for (const key of ["extensions", "skills", "prompts", "themes"]) for (const path of strings(parsed[key])) items.push(`${key}: ${path}`);
	const other = Object.keys(parsed).filter((k) => !["packages", "extensions", "skills", "prompts", "themes"].includes(k)).length;
	if (other) items.push(`${other} other setting${other === 1 ? "" : "s"}`);
	return group("settings", ".pi/settings.json", items);
}
/** .pi/mcp.json: each server as `name: command args` or `name: url`. */
function mcp(file: string): TrustGroup {
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
	const servers = object(parsed) && object(parsed.mcpServers) ? parsed.mcpServers : {};
	const items = Object.entries(servers).map(([name, s]) => {
		const c = object(s) ? s : {};
		return `${name}: ${typeof c.url === "string" ? c.url : [typeof c.command === "string" ? c.command : "?", ...strings(c.args)].join(" ")}`;
	});
	return group("mcp", ".pi/mcp.json", items);
}
const tryRead = (kind: string, path: string, read: () => TrustGroup) => {
	try {
		return read();
	} catch {
		return unreadable(kind, path);
	}
};

/**
 * The folder's resources as groups, in the order pi lists them. `cwd` is the canonical folder; `home` is where ~/.agents/skills lives.
 * The result is capped at 32 KB: when it is larger, the last groups give up their items (counted in `more`) until it fits.
 */
export function foundIn(cwd: string, home: string = canonical(process.env.HOME || homedir())): TrustGroup[] {
	const out: TrustGroup[] = [], pi = join(cwd, ".pi");
	if (existsSync(join(pi, "settings.json"))) out.push(tryRead("settings", ".pi/settings.json", () => settings(join(pi, "settings.json"))));
	if (existsSync(join(pi, "mcp.json"))) out.push(tryRead("mcp", ".pi/mcp.json", () => mcp(join(pi, "mcp.json"))));
	for (const dir of DIRS) if (existsSync(join(pi, dir))) out.push(tryRead(dir, `.pi/${dir}`, () => group(dir, `.pi/${dir}`, names(join(pi, dir)))));
	for (const [file, kind] of FILES) if (existsSync(join(pi, file))) out.push({ kind, path: `.pi/${file}`, items: [], more: 0 });
	const user = join(home, ".agents", "skills");
	for (let dir = cwd; ; dir = dirname(dir)) {
		const skills = join(dir, ".agents", "skills");
		if (skills !== user && existsSync(skills)) {
			const path = relative(cwd, skills).split(sep).join("/");
			out.push(tryRead("agents-skills", path, () => group("agents-skills", path, names(skills))));
		}
		if (dirname(dir) === dir) break;
	}
	for (let i = out.length - 1; i >= 0 && Buffer.byteLength(JSON.stringify(out)) > MAX_FOUND; i--) {
		const g = out[i]!;
		out[i] = { ...g, items: [], more: g.more + g.items.length };
	}
	return out;
}

export const canonical = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};
/** The digest an answer must carry: it covers the folder and what was found in it, so an answer is for exactly the question that was asked. */
export const digestOf = (cwd: string, found: TrustGroup[]) => createHash("sha256").update(JSON.stringify(["pi-trust/1", cwd, found])).digest("hex");
