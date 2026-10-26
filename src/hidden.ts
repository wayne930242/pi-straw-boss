import { execFile } from "node:child_process";
import { system32, system32Path } from "./winpath.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// What Windows hides. A dot makes a folder hidden on macOS and Linux; Windows marks it with the Hidden or System file attribute, and a fresh profile holds a
// dozen such entries in the home folder: AppData, and the compatibility junctions of the old profile layout (Application Data, Cookies, Local Settings,
// My Documents, NetHood, PrintHood, Recent, SendTo, Templates, and the localised Start Menu), which Explorer never shows and most of which deny access.
// Node has no call for the attributes (`fs.lstat` carries none, and a junction is a link like any other), so one cmd.exe call per listed folder reads them:
// `dir /a:h` and `dir /a:s` list the Hidden and the System entries. cmd rather than PowerShell, whose start alone took 1.9 s (2.8 s a call) on a Windows 11 ARM
// machine where cmd takes 150-200 ms, and a pick walks several folders. `/u` makes cmd print UTF-16LE whatever the console's OEM code page, so the localised
// names survive; Node's own argument quoting broke the command line (empty output), hence windowsVerbatimArguments. Hidden or System alone decides: the
// compatibility junctions have both, and an ordinary link or a OneDrive folder has neither, so it stays.
// The folder name travels in the environment and cmd expands %SB_DIR% once, inside quotes, so `& ^ % ! ) (` in it stay plain text (a Windows name cannot hold
// a quote); `/v:off` keeps `!` from expanding whatever the machine's delayed-expansion default is, and `/d` skips AutoRun.
// A failed call is an error, not "nothing hidden", but `dir` cannot tell us: it exits 1 for "no match" and for "cannot read" alike, so the line discards its
// exit codes and the folder is read with `readdir` first, which does fail (not found, access denied) with a code of its own.
// The picker asks for a folder at a time and the answer is kept for a few seconds, so a navigation costs one call.

/** The names in `dir` (lower case: Windows paths are case-insensitive) that carry the Hidden or System attribute. */
export type Hidden = (dir: string) => Promise<ReadonlySet<string>>;
export class HiddenError extends Error {}

const COMMAND = '/d /v:off /u /c "dir /b /a:h "%SB_DIR%" 2>nul & dir /b /a:s "%SB_DIR%" 2>nul & exit /b 0"';

/** The names `cmd /u` printed (UTF-16LE, one per line), lower case and without repeats. */
export const parseNames = (stdout: Buffer): Set<string> => new Set(stdout.toString("utf16le").split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean));

/** The call that lists a folder's hidden and system entries: cmd by absolute path, from System32 (a bare `cmd.exe` is looked for in the current folder first). */
export const hiddenCommand = (dir: string, env: NodeJS.ProcessEnv = process.env) => ({
	file: system32Path("cmd.exe", env), args: [COMMAND],
	options: { env: { ...env, SB_DIR: dir }, encoding: "buffer" as const, windowsHide: true, windowsVerbatimArguments: true, timeout: 20_000, maxBuffer: 8 << 20, cwd: system32(env) },
});

export const cmdHidden: Hidden = async (dir) => {
	try {
		await readdir(dir);
	} catch (error) {
		throw new HiddenError(`Windows could not say which folders in ${dir} are hidden: ${(error as Error).message}`);
	}
	return new Promise((done, fail) => {
		const { file, args, options } = hiddenCommand(dir);
		execFile(file, args, options, (error, stdout) =>
			error ? fail(new HiddenError(`Windows could not say which folders in ${dir} are hidden: ${error.message}`)) : done(parseNames(stdout)));
	});
};

/** `read`, asked once per folder for `ttl` ms; a failure is not kept. */
export function cached(read: Hidden, ttl = 10_000, now = Date.now): Hidden {
	const seen = new Map<string, { at: number; value: Promise<ReadonlySet<string>> }>();
	return (dir) => {
		const key = dir.toLowerCase(), hit = seen.get(key);
		if (hit && now() - hit.at < ttl) return hit.value;
		const value = read(dir);
		value.catch(() => seen.get(key)?.value === value && seen.delete(key));
		if (seen.size >= 256) seen.clear();
		seen.set(key, { at: now(), value });
		return value;
	};
}

/** The reader of this platform: cmd's on Windows, none elsewhere, where a dot is all that hides a folder. */
export const platformHidden: Hidden | undefined = process.platform === "win32" ? cached(cmdHidden) : undefined;

/** Whether one of `parts` (the folders from `root` down) is hidden, each looked up in its parent and the walk stopped at the first one, so nothing inside a hidden folder is read. */
export async function hasHidden(root: string, parts: string[], hidden: Hidden): Promise<boolean> {
	for (const [i, part] of parts.entries()) if ((await hidden(join(root, ...parts.slice(0, i)))).has(part.toLowerCase())) return true;
	return false;
}
