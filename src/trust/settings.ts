import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { clean, MAX_READ } from "./found.ts";

// Before pi starts in a folder: is the folder's .pi/settings.json one pi can read without harm? pi 1.4.0 reads it at startup, before any extension loads and
// before the trust question (SettingsManager.create in dist/main.js, upstream issue https://github.com/earendil-works/pi/issues/11421), whole and with no limit: a
// link to /dev/zero grows pi's memory without bound, a link to /dev/stdin or a FIFO blocks it for good. No extension runs yet to stop that, so whoever starts pi looks first.
// Looking at the path in this process always diverges from what the kernel does for pi (`.pi -> /proc/self/cwd`, link targets that are not UTF-8, /DEV on a case-insensitive disk,
// Windows paths), so the kernel does the resolving: a child process with `dir` as its working directory, exactly pi's, opens `.pi/settings.json` as pi would and reports what it
// is (PROBE below). The common case, no `.pi` at all, costs one lstat and no child.

/**
 * `special`: no plain file; `large`: over the cap (`size` bytes, at least the cap + 1, `limit` the cap); `unreadable`: it could not be looked at (`code`);
 * `unchecked`: the look did not finish in time or did not answer sensibly. `path` is the file.
 */
export interface SettingsRefusal { path: string; why: "special" | "large" | "unreadable" | "unchecked"; size?: number; limit?: number; code?: string }

/** What a child run came to: its one line of output, or why there is none. */
export type Ran = { out: string } | { failed: "timeout" | "crash" | "output"; code?: string };
/** Runs the probe with `dir` as the working directory. Replaced in tests. */
export type RunProbe = (dir: string) => Promise<Ran>;

/** How long the child may take, node's start included. A slow disk or a loaded machine can exceed it; the opening is then refused, not guessed. */
export const PROBE_TIMEOUT_MS = 5_000;
const MAX_OUT = 4_096;

// The child's whole program. It looks at the same relative path pi resolves (pi: resolve(process.cwd(), ".pi", "settings.json")) and says what is there. "Absent" is
// only ever said when no link is involved that the child failed to follow: a per-process magic link (/proc/self/fd/N) is ENOENT for the child but is pi's own descriptor for pi,
// so a link that cannot be followed, or opened, for any reason is refused. Otherwise what pi's own read would throw on and catch (a missing file, a folder that cannot be searched) is
// "absent". The target is stat'ed before it is opened (a FIFO or device is never opened), opened without blocking, checked again through the descriptor, and a regular file is
// read with a fixed buffer, never trusting st_size.
const PROBE = `
const fs = require("node:fs"), C = fs.constants, LIMIT = ${MAX_READ};
const say = (o) => { process.stdout.write(JSON.stringify(o) + "\\n"); process.exit(0); };
const ABSENT = ["ENOENT", "ENOTDIR", "EACCES"], code = (e) => (e && e.code) || "UNKNOWN";
const look = (p) => { try { return fs.lstatSync(p); } catch (e) { say({ r: ABSENT.includes(code(e)) ? "absent" : "unreadable", code: code(e) }); } };
const follow = (p, link) => { try { return fs.statSync(p); } catch (e) { say(link || !ABSENT.includes(code(e)) ? { r: "unreadable", code: code(e) } : { r: "absent" }); } };
const pi = look(".pi");
if (pi.isSymbolicLink()) follow(".pi", true);
const f = look(".pi/settings.json"), link = f.isSymbolicLink();
const st0 = follow(".pi/settings.json", link);
if (st0.isDirectory()) say({ r: "dir" });
if (!st0.isFile()) say({ r: "special" });
let fd;
try { fd = fs.openSync(".pi/settings.json", C.O_RDONLY | (C.O_NONBLOCK || 0)); } catch (e) { say({ r: link || !ABSENT.includes(code(e)) ? "unreadable" : "absent", code: code(e) }); }
try {
  const st = fs.fstatSync(fd);
  if (st.isDirectory()) say({ r: "dir" });
  if (!st.isFile()) say({ r: "special" });
  const buf = Buffer.allocUnsafe(65536);
  let total = 0;
  for (;;) {
    const n = fs.readSync(fd, buf, 0, buf.length, null);
    if (n <= 0) break;
    total += n;
    if (total > LIMIT) say({ r: "large", size: total });
  }
  say({ r: "ok" });
} catch (e) { say({ r: link ? "unreadable" : "absent", code: code(e) }); }
`;

const decode = (text: string): { r: string; code?: string; size?: number } | undefined => {
	try {
		const v: unknown = JSON.parse(text);
		if (v === null || typeof v !== "object" || typeof (v as { r?: unknown }).r !== "string") return;
		return v as { r: string; code?: string; size?: number };
	} catch {
		return undefined;
	}
};

/** The real runner: `process.execPath` with a small heap, no input, a hard timeout that kills the child, and its output cut at 4 KB. */
export const runChild = (dir: string, timeoutMs = PROBE_TIMEOUT_MS, node = process.execPath): Promise<Ran> =>
	new Promise((resolve) => {
		const { NODE_OPTIONS: _skip, ...env } = process.env;
		let settled = false, out = "";
		const done = (ran: Ran) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child?.kill("SIGKILL");
			resolve(ran);
		};
		const child = (() => {
			try {
				return spawn(node, ["--max-old-space-size=32", "-e", PROBE], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
			} catch (error) {
				queueMicrotask(() => done({ failed: "crash", code: (error as NodeJS.ErrnoException).code }));
			}
		})();
		const timer = setTimeout(() => done({ failed: "timeout" }), timeoutMs);
		if (!child) return;
		child.on("error", (error: NodeJS.ErrnoException) => done({ failed: "crash", ...(error.code && { code: error.code }) }));
		child.stdout.on("data", (chunk: Buffer) => {
			out += chunk.toString("latin1");
			if (out.length > MAX_OUT) done({ failed: "output" });
		});
		child.stderr.on("data", () => {}); // drained and dropped
		child.on("close", (status) => done(status === 0 ? { out } : { failed: "crash" }));
	});

/** Why pi must not start in `dir`, or undefined when it may. One lstat when `.pi` is not there; otherwise one short child process. `run` is for tests. */
export async function settingsRefusal(dir: string, run: RunProbe = runChild): Promise<SettingsRefusal | undefined> {
	const path = join(dir, ".pi", "settings.json");
	try {
		await lstat(join(dir, ".pi"));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return;
	}
	const ran = await run(dir);
	if ("failed" in ran) {
		return { path, why: "unchecked", code: ran.failed === "timeout" ? "ETIMEDOUT" : ran.failed === "output" ? "EPROBE" : (ran.code ?? "EPROBE") };
	}
	const seen = decode(ran.out.trim());
	if (!seen) return { path, why: "unchecked", code: "EPROBE" };
	switch (seen.r) {
		case "ok":
		case "absent": // nothing there, with no link the child failed to follow
		case "dir": // pi's read fails with EISDIR and it carries on
			return;
		case "special":
			return { path, why: "special" };
		case "large":
			return { path, why: "large", size: typeof seen.size === "number" ? seen.size : MAX_READ + 1, limit: MAX_READ };
		case "unreadable":
			return { path, why: "unreadable", ...(typeof seen.code === "string" && { code: seen.code }) };
		default:
			return { path, why: "unchecked", code: "EPROBE" };
	}
}

/** The refusal in words for a tool, a log, or a thrown error: the file, the reason, and what was not started. */
export function refusalText(r: SettingsRefusal, what = "pi"): string {
	const file = clean(r.path);
	const why = r.why === "special" ? "is not a plain file (a device, pipe, or socket, or a link to one), and pi reads it whole when it starts, so it could hang or never finish"
		: r.why === "large" ? `is over the ${MAX_READ / 1024} KB limit, and pi reads it whole when it starts`
		: r.why === "unchecked" ? `could not be checked in time${r.code ? ` (${clean(r.code)})` : ""}`
		: `cannot be read${r.code ? ` (${clean(r.code)})` : ""}`;
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
export async function assertSettingsSafe(dirs: Iterable<string | undefined>, what?: string, run?: RunProbe): Promise<void> {
	for (const dir of new Set(dirs)) {
		const refusal = dir ? await settingsRefusal(dir, run) : undefined;
		if (refusal) throw new SettingsRefused(refusal, what);
	}
}
