import { lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_READ, UnsafeFile, withPlain } from "./found.ts";

// Before pi starts in a folder: is the folder's .pi/settings.json one pi can read without harm? pi 1.4.0 reads it at startup, before any extension loads and
// before the trust question (SettingsManager.create in dist/main.js, upstream issue https://github.com/earendil-works/pi/issues/11421), whole and with no limit: a
// link to /dev/zero grows pi's memory without bound, a link to /dev/stdin or a FIFO blocks it for good. No extension runs yet to stop that, so whoever starts pi looks first.
// It is the bounded read the trust question uses (found.ts withPlain), without the reading: a plain file of at most 256 KB, checked through its descriptor.
// An absent file is fine (so is a link that leads nowhere: pi's existsSync is false for it), and so is a link that ends at a plain small file: pi follows links, and what it reads then is the same bounded file.

/** `special`: no plain file; `large`: over the cap (`size` bytes, `limit` the cap); `unreadable`: it could not be looked at (`code`). `path` is the file, `target` where a link of it ends. */
export interface SettingsRefusal { path: string; why: "special" | "large" | "unreadable"; target?: string; size?: number; limit?: number; code?: string }

// What pi itself treats as no file: existsSync is false for these, so it reads nothing.
const ABSENT = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);
/** Where a link ends, for the words only: a /proc or /dev/fd link may not resolve. */
const endOf = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return undefined;
	}
};
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Why pi must not start in `dir`, or undefined when it may. One lstat when there is no file (or a plain one is only opened and measured). */
export function settingsRefusal(dir: string): SettingsRefusal | undefined {
	const path = join(dir, ".pi", "settings.json");
	let linked = false;
	try {
		const seen = lstatSync(path);
		linked = seen.isSymbolicLink();
		// A link is judged by what it leads to (stat follows it, a /proc or /dev/fd link too), and opened the same way: pi follows it as well.
		withPlain(path, () => undefined, linked ? statSync(path) : seen, linked);
	} catch (error) {
		const target = linked ? endOf(path) : undefined;
		if (error instanceof UnsafeFile) return { path, why: error.why, ...(target && { target }), ...(error.size !== undefined && { size: error.size, limit: MAX_READ }) };
		const code = codeOf(error);
		if (code && ABSENT.has(code)) return;
		return { path, why: "unreadable", ...(target && { target }), ...(code && { code }) };
	}
}

/** The refusal in words for a tool, a log, or a thrown error: the file, the reason, and what was not started. */
export function refusalText(r: SettingsRefusal, what = "pi"): string {
	const file = r.target ? `${r.path} (a link to ${r.target})` : r.path;
	const why = r.why === "special" ? "is not a plain file (a device, pipe, or socket, or a link to one), and pi reads it whole when it starts, so it could hang or never finish"
		: r.why === "large" ? `is ${r.size} bytes, over the ${MAX_READ / 1024} KB limit, and pi reads it whole when it starts`
		: `cannot be read${r.code ? ` (${r.code})` : ""}`;
	return `${what} was not started: ${file} ${why}. Make it a plain file under ${MAX_READ / 1024} KB or remove it, then try again.`;
}

/** An error that carries the refusal, so a caller further out can show it in the page's language. */
export class SettingsRefused extends Error {
	readonly refusal: SettingsRefusal;
	constructor(refusal: SettingsRefusal, what?: string) {
		super(refusalText(refusal, what));
		this.refusal = refusal;
	}
}

/** Throws SettingsRefused for the first of `dirs` whose settings pi must not read. Call it before anything is created for the new pi. */
export function assertSettingsSafe(dirs: Iterable<string | undefined>, what?: string): void {
	for (const dir of new Set(dirs)) {
		const refusal = dir ? settingsRefusal(dir) : undefined;
		if (refusal) throw new SettingsRefused(refusal, what);
	}
}
