import { lstatSync, readlinkSync, readSync, type Stats } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { clean, MAX_READ, UnsafeFile, withPlain } from "./found.ts";

// Before pi starts in a folder: is the folder's .pi/settings.json one pi can read without harm? pi 1.4.0 reads it at startup, before any extension loads and
// before the trust question (SettingsManager.create in dist/main.js, upstream issue https://github.com/earendil-works/pi/issues/11421), whole and with no limit: a
// link to /dev/zero grows pi's memory without bound, a link to /dev/stdin or a FIFO blocks it for good. No extension runs yet to stop that, so whoever starts pi looks first.
// pi builds the path from its own folder with no realpath, so the check walks it the same way, every link hop by hop (walk below), and refuses any that leads into /proc, /dev, or /sys.
// The end of the walk gets the bounded read the trust question uses (found.ts withPlain): a plain file of at most 256 KB, checked through its descriptor.
// An absent file is fine (so is a link that leads nowhere: pi's existsSync is false for it), and so is a link that ends at a plain small file: pi follows links, and what it reads then is the same bounded file.

/** `special`: no plain file; `large`: over the cap (`size` bytes, `limit` the cap); `unreadable`: it could not be looked at (`code`). `path` is the file, `target` where a link of it ends. */
export interface SettingsRefusal { path: string; why: "special" | "large" | "unreadable"; target?: string; size?: number; limit?: number; code?: string }

// What pi itself treats as no file: existsSync is false for these, so it reads nothing. Only the walk and the lstat answer this; an error from the open refuses.
// (EACCES: a .pi that cannot be searched. A directory at the path is no file either: pi catches EISDIR.)
const ABSENT = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EACCES"]);
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code;
/** Places a link may never lead into, on any OS: /proc and /sys files report size 0 and never end (/proc/self/pagemap), /dev holds devices, pipes, and /dev/fd. */
const pseudo = (path: string) => /^\/(proc|dev|sys)(\/|$)/.test(path);
/** The most links followed on the way to the file. The kernel stops at 40 too; a longer chain is refused, not guessed at. */
export const MAX_HOPS = 40;
type Reader = (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number;
type Link = (path: string) => string;
type Walked = { end: string; linked: boolean } | { absent: true } | { refusal: SettingsRefusal };
interface Step { name: string; own: boolean }

/**
 * Resolves the way the kernel does for pi (pi builds the path from its working directory with no realpath): component by component from the root, and every symlink
 * met, in `dir` or below it, is followed hop by hop with `link` (readlink), a relative target against the folder the link lies in. Each target, lexically normalized, and each
 * place the walk stands in after a hop must lie outside /proc, /dev, and /sys, so `.pi -> /proc/self/cwd` (which /proc resolves against whoever looks, not against `dir`) never
 * passes. `end` is the physical path of the file, `linked` is whether a link below `dir` led there. A missing component, or one that cannot be searched, is "absent".
 */
function walk(dir: string, shown: string, link: Link): Walked {
	const refuse = (r: Omit<SettingsRefusal, "path">): Walked => ({ refusal: { path: shown, ...r } });
	// a stack, popped from its end: the first component to meet is last
	const todo: Step[] = [...(isAbsolute(dir) ? dir : `${process.cwd()}/${dir}`).split("/").map((name) => ({ name, own: false })), { name: ".pi", own: true }, { name: "settings.json", own: true }].reverse();
	const done: string[] = [];
	let hops = 0, linked = false, below = false;
	while (todo.length) {
		const { name, own } = todo.pop()!;
		if (own) below = true;
		if (name === "" || name === ".") continue;
		if (name === "..") {
			done.pop();
			continue;
		}
		const here = `/${[...done, name].join("/")}`;
		if (hops && pseudo(here)) return refuse({ why: "special", target: here });
		let target: string;
		try {
			target = link(here);
		} catch (error) {
			const code = codeOf(error);
			if (code === "EINVAL") { // not a link
				done.push(name);
				continue;
			}
			if (code && ABSENT.has(code)) return { absent: true };
			return refuse({ why: "unreadable", ...(code && { code }) });
		}
		if (++hops > MAX_HOPS) return refuse({ why: "unreadable", code: "ELOOP" });
		if (below) linked = true;
		const absolute = target.startsWith("/");
		const lexical = normalize(absolute ? target : `/${done.join("/")}/${target}`);
		if (pseudo(lexical)) return refuse({ why: "special", target: lexical });
		if (absolute) done.length = 0;
		for (const part of target.split("/").reverse()) todo.push({ name: part, own: false });
	}
	return { end: `/${done.join("/")}`, linked };
}

/** Reads through the descriptor, never trusting its size: more than MAX_READ bytes arriving refuses it as large (the size is then what was read, at least MAX_READ + 1). */
function bounded(fd: number, read: Reader): void {
	const buffer = Buffer.allocUnsafe(65_536);
	let total = 0;
	for (;;) {
		const n = read(fd, buffer, 0, buffer.length, null);
		if (n <= 0) return;
		total += n;
		if (total > MAX_READ) throw new UnsafeFile("large", "not a plain small file", total);
	}
}

/** Why pi must not start in `dir`, or undefined when it may. Nothing is read unless the file is there (a plain one is only opened and measured). `read` and `link` (readlink) are for tests. */
export function settingsRefusal(dir: string, read: Reader = readSync, link: Link = (path) => readlinkSync(path)): SettingsRefusal | undefined {
	const path = join(dir, ".pi", "settings.json");
	const walked = walk(dir, path, link);
	if ("absent" in walked) return;
	if ("refusal" in walked) return walked.refusal;
	const { end, linked } = walked;
	const target = linked ? end : undefined;
	let seen: Stats;
	try {
		seen = lstatSync(end);
	} catch (error) {
		const code = codeOf(error);
		if (code && ABSENT.has(code)) return;
		return { path, why: "unreadable", ...(code && { code }) };
	}
	if (seen.isDirectory()) return; // pi's read fails with EISDIR and it carries on
	try {
		withPlain(end, (fd) => (linked ? bounded(fd, read) : undefined), seen);
	} catch (error) {
		if (error instanceof UnsafeFile) return { path, why: error.why, ...(target && { target }), ...(error.size !== undefined && { size: error.size, limit: MAX_READ }) };
		const code = codeOf(error);
		return { path, why: "unreadable", ...(target && { target }), ...(code && { code }) };
	}
}

/** The refusal in words for a tool, a log, or a thrown error: the file, the reason, and what was not started. */
export function refusalText(r: SettingsRefusal, what = "pi"): string {
	const file = r.target ? `${clean(r.path)} (a link to ${clean(r.target)})` : clean(r.path);
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
