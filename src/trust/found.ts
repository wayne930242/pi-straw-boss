import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
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
export const MAX_READ = 262_144;
/** Text for the page: control characters are removed and Unicode format characters (bidi overrides, zero-width marks) drawn as U+FFFD. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, "\ufffd");
export const cleanGroup = (g: TrustGroup): TrustGroup => ({ ...g, kind: clean(g.kind), path: clean(g.path), items: g.items.map(clean) });
/** Why a folder's own file is not one to read: it is no plain file (a device, pipe, or socket could block or never end) or it is over the cap. */
export class UnsafeFile extends Error {
	readonly why: "special" | "large";
	readonly size?: number;
	constructor(why: "special" | "large", message: string, size?: number) {
		super(message);
		this.why = why;
		this.size = size;
	}
}
/**
 * Runs `use` on a folder's own file opened with care: a plain file (no link, no device or pipe) of at most 256 KB, checked through the descriptor that is used and closed on every path.
 * `seen` is the file's lstat when the caller already took it (so the common path is one lstat). `follow` lets a link lead to the file (pi itself follows links): `seen` is then the
 * stat of what it leads to, and the descriptor is still checked, so a link to a device, a pipe, or a file that grew past the cap is refused all the same.
 */
export function withPlain<T>(file: string, use: (fd: number) => T, seen: Stats = lstatSync(file), follow = false): T {
	if (!seen.isFile()) throw new UnsafeFile("special", "not a plain file");
	const fd = openSync(file, constants.O_RDONLY | (follow ? 0 : (constants.O_NOFOLLOW ?? 0)) | (constants.O_NONBLOCK ?? 0));
	try {
		const st = fstatSync(fd);
		if (!st.isFile()) throw new UnsafeFile("special", "not a plain file");
		if (st.size > MAX_READ) throw new UnsafeFile("large", "not a plain small file", st.size);
		return use(fd);
	} finally {
		closeSync(fd);
	}
}
/** A folder's own file, read with care (withPlain). */
const readSmall = (file: string) => withPlain(file, (fd) => readFileSync(fd, "utf8").replace(/^\uFEFF/, ""));

/** .pi/settings.json: the packages pi would install, the paths it adds, and a count of its other keys. */
function settings(file: string): TrustGroup {
	const parsed: unknown = JSON.parse(readSmall(file));
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
	const parsed: unknown = JSON.parse(readSmall(file));
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
 * The result is capped at `max` bytes (32 KB, or less when the whole request must fit its file): when it is larger, the last groups give up their items (counted in `more`) until it fits.
 * pi looks for ancestors' .agents/skills from its working directory as it was given, so `from` (that path, when it is not the canonical one) is where the walk starts.
 */
export function foundIn(cwd: string, home: string = canonical(homedir()), { max = MAX_FOUND, from = cwd }: { max?: number; from?: string } = {}): TrustGroup[] {
	const out: TrustGroup[] = [], pi = join(cwd, ".pi");
	if (existsSync(join(pi, "settings.json"))) out.push(tryRead("settings", ".pi/settings.json", () => settings(join(pi, "settings.json"))));
	if (existsSync(join(pi, "mcp.json"))) out.push(tryRead("mcp", ".pi/mcp.json", () => mcp(join(pi, "mcp.json"))));
	for (const dir of DIRS) if (existsSync(join(pi, dir))) out.push(tryRead(dir, `.pi/${dir}`, () => group(dir, `.pi/${dir}`, names(join(pi, dir)))));
	for (const [file, kind] of FILES) if (existsSync(join(pi, file))) out.push({ kind, path: `.pi/${file}`, items: [], more: 0 });
	const user = join(home, ".agents", "skills");
	for (let dir = from; ; dir = dirname(dir)) {
		const skills = join(dir, ".agents", "skills");
		if (existsSync(skills) && canonical(skills) !== canonical(user)) {
			const path = relative(from, skills).split(sep).join("/");
			out.push(tryRead("agents-skills", path, () => group("agents-skills", path, names(skills))));
		}
		if (dirname(dir) === dir) break;
	}
	for (let i = out.length - 1; i >= 0 && Buffer.byteLength(JSON.stringify(out)) > max; i--) {
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
