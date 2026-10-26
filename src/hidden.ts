import { execFile } from "node:child_process";
import { join } from "node:path";

// What Windows hides. A dot makes a folder hidden on macOS and Linux; Windows marks it with the Hidden or System file attribute, and a fresh profile holds a
// dozen such entries in the home folder: AppData, and the compatibility junctions of the old profile layout (Application Data, Cookies, Local Settings,
// My Documents, NetHood, PrintHood, Recent, SendTo, Templates, and the localised Start Menu), which Explorer never shows and most of which deny access.
// Node has no call for the attributes (`fs.lstat` carries none, and a junction is a link like any other), so one PowerShell call per listed folder reads them.
// PowerShell rather than `attrib`: attrib prints names in the console's OEM code page, which mangles the localised ones, while this prints each name as base64
// of UTF-8. Hidden or System alone decides: the compatibility junctions have both, and an ordinary link or a OneDrive folder has neither, so it stays.
// The picker asks for a folder at a time and the answer is kept for a few seconds, so a navigation costs one call. A failed call is an error, not "nothing hidden".

/** The names in `dir` (lower case: Windows paths are case-insensitive) that carry the Hidden or System attribute. */
export type Hidden = (dir: string) => Promise<ReadonlySet<string>>;
export class HiddenError extends Error {}

const SCRIPT = "$ErrorActionPreference='Stop'; Get-ChildItem -LiteralPath $env:SB_DIR -Force | Where-Object { ([int]$_.Attributes -band 6) -ne 0 } | ForEach-Object { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Name)) }";

/** The names a PowerShell listing printed, one base64 line each. */
export const decodeNames = (stdout: string): Set<string> => new Set(stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => Buffer.from(line.trim(), "base64").toString("utf8").toLowerCase()));

export const powershell: Hidden = (dir) =>
	new Promise((done, fail) => {
		execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], { env: { ...process.env, SB_DIR: dir }, windowsHide: true, timeout: 20_000, maxBuffer: 8 << 20 }, (error, stdout, stderr) =>
			error ? fail(new HiddenError(`Windows could not say which folders in ${dir} are hidden: ${stderr.trim().split(/\r?\n/)[0] || error.message}`)) : done(decodeNames(stdout)));
	});

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

/** The reader of this platform: PowerShell's on Windows, none elsewhere, where a dot is all that hides a folder. */
export const platformHidden: Hidden | undefined = process.platform === "win32" ? cached(powershell) : undefined;

/** Whether one of `parts` (the folders from `root` down) is hidden, each looked up in its parent and the walk stopped at the first one, so nothing inside a hidden folder is read. */
export async function hasHidden(root: string, parts: string[], hidden: Hidden): Promise<boolean> {
	for (const [i, part] of parts.entries()) if ((await hidden(join(root, ...parts.slice(0, i)))).has(part.toLowerCase())) return true;
	return false;
}
