import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { powershellPath, system32 } from "../winpath.ts";

// The Windows ACL of the state directory (docs/specs/2026-10-26-sb-backend.md, The control socket). A named pipe is not protected by its name or by a file mode, so the
// secret that opens a connection lives in server.json, and server.json is only as private as the folder it is in. The folder `straw-boss/` (never the agent directory
// above it) gets a protected DACL with the owner and SYSTEM only. Accounts are named by SID, never by a localized name, and the check reads the SDDL
// (`(Get-Acl).Sddl`), never icacls' localized text. Reading the owner's SID, this process's start time, setting the ACL, and reading every SDDL back run in one PowerShell start, which
// answers one JSON line (a PowerShell start costs 2 to 3 s on a slow machine, and the server asks for nothing else of it).

export const SYSTEM_SID = "S-1-5-18";
const ACL_MS = 20_000;

/**
 * Every character above 0x7F of a JSON text in `variable` becomes \uXXXX (a UTF-16 unit at a time), which JSON.parse reads back as it was. Windows PowerShell 5.1 writes redirected output in the OEM
 * code page (CP950, CP932, …) and Node reads UTF-8, and in those code pages the second byte of some characters (Big5 許 and 功, Shift-JIS ソ and 表) is 0x5C, a backslash that would land inside a JSON
 * string: what PowerShell prints or writes here is pure ASCII (sbr-F007).
 */
export const asciiJson = (variable: string) => `[regex]::Replace(${variable}, '[^\\x00-\\x7F]', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) ('\\u{0:x4}' -f [int][char]$m.Value) })`;
/**
 * How every PowerShell call of the package is started. `-OutputFormat Text` keeps the answer plain; and Windows PowerShell 5.1 started with `-EncodedCommand` and a redirected stderr still writes
 * CLIXML (`#< CLIXML` + `<Objs …>`) to stderr on a successful run (the progress records of preparing its modules the first time), so a script also turns its progress stream off, and a failure text
 * read from stderr goes through `plainStderr`.
 */
export const POWERSHELL_FLAGS = ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text"];
export const PROGRESS_OFF = "$ProgressPreference = 'SilentlyContinue'";
/** What the walk below the state folder throws for a link or junction: the word and the path. */
export const REPARSE_WORD = "sb-reparse-point";
/**
 * Under Constrained Language Mode (a machine policy: AppLocker, WDAC, `__PSLockdownPolicy`) the scripts' .NET calls fail with a localized text that comes out as `?`s. A script says so first, in ASCII:
 * a fixed word that `execFailure` turns into one clear sentence (VM pass 5, F12).
 */
export const CLM_WORD = "sb-constrained-language";
export const CLM_CHECK = `if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw '${CLM_WORD}' }`;
export const CLM_TEXT = "PowerShell runs in Constrained Language Mode (likely a policy); pi-straw-boss needs FullLanguage for its permission check";
/** The first line of every script that prints an answer: the console's output encoding, which may fail where no console is attached. */
export const UTF8_OUT = "try { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false) } catch { }";

/** BUILTIN\Administrators: the default owner of what an elevated token creates. */
export const ADMINS_SID = "S-1-5-32-544";
/**
 * The owners that are accepted besides the user, by ONE rule in every check (`ownerProblems`, both scripts' owner walks, the launch script's check before the create): BUILTIN\Administrators and SYSTEM.
 * Both are made by an administrator's elevated token or by SYSTEM, which can read the folder whatever its owner or DACL; no account gains anything from them owning an entry.
 */
const OWNER_OK_SIDS = [SYSTEM_SID, ADMINS_SID];
/** The same list as a PowerShell array body: `'S-1-5-18','S-1-5-32-544'`. */
export const OWNER_OK_PS = OWNER_OK_SIDS.map((sid) => `'${sid}'`).join(",");
/** The steps of the check, from the folder to `$out` (sid, start time of `$env:SB_ACL_PID`, the folder's SDDL, each secret file's): the server's own script and the starter's launch script both run them. */
export const ACL_STEPS = [
	"$dir = $env:SB_ACL_DIR",
	"$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
	// The start time of the server (Win32_Process.CreationDate, as startof.ts reads every process's), so its own PowerShell start is not made; a failure leaves it null.
	"$started = $null",
	"try { $started = (Get-CimInstance Win32_Process -Filter \"ProcessId=$($env:SB_ACL_PID -as [int])\").CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [cultureinfo]::InvariantCulture) } catch { }",
	// `${sid}:` and not `$sid:`: PowerShell reads the latter as a variable in a scope named sid.
	"$icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'",
	// ONE owner rule everywhere (R11-F004): the user, BUILTIN\Administrators and SYSTEM (`OWNER_OK_SIDS`, as `ownerProblems`, the launch script's check before the create, and `takeOwnership`). Owners are read as SIDs through .NET.
	`$okOwners = @(${OWNER_OK_PS})`,
	"function OwnerOf($p) { $s = [Security.AccessControl.AccessControlSections]::Owner; if ([IO.Directory]::Exists($p)) { $a = [IO.Directory]::GetAccessControl($p, $s) } else { $a = [IO.File]::GetAccessControl($p, $s) }; return $a.GetOwner([Security.Principal.SecurityIdentifier]).Value }",
	"function CheckOwner($p) { $who = OwnerOf $p; if ($who -ne $sid -and $okOwners -notcontains $who) { throw ('the ' + $p + ' belongs to another account (' + $who + '), not to ' + $sid + ' (nothing was changed)') } }",
	// The folder's own owner is read BEFORE anything changes it (R11-F001): the native step that comes before this script never takes the ownership of an existing folder (an attacker's folder that
	// grants the user WRITE_OWNER would be taken over, and its secret-bearing files written by the user), so this is the gate for a folder that was already there. `/setowner` below only turns
	// BUILTIN\Administrators- and SYSTEM-owned entries into the user's.
	"CheckOwner $dir",
	"& $icacls $dir /inheritance:r /grant:r \"*${sid}:(OI)(CI)F\" '*S-1-5-18:(OI)(CI)F' | Out-Null",
	"if ($LASTEXITCODE -ne 0) { throw \"icacls failed with exit code $LASTEXITCODE\" }",
	// Only name-surrogate links (junction, mount point, symbolic link: `LinkType`) are refused; other reparse points (OneDrive and other cloud placeholders, dedup) are ordinary files and folders, walked as such (R9). A folder that
	// vanishes between being listed and being walked (the link stale-lock guard, `outbox/<team>`) is skipped; one that is there and cannot be listed is thrown.
	// The entries below are listed WITHOUT following links (Windows PowerShell 5.1's Get-ChildItem follows junctions): a link or junction anywhere below the folder is refused, before any icacls call
	// acts below it and again when the SDDLs are read back (R8-F003). `Walk` returns every file and every folder below.
	"function Walk($root) { $f = New-Object System.Collections.Generic.List[string]; $d = New-Object System.Collections.Generic.List[string]; $todo = New-Object System.Collections.Generic.Stack[string]; $todo.Push($root); while ($todo.Count -gt 0) { $here = $todo.Pop(); try { $names = [IO.Directory]::GetFileSystemEntries($here) } catch { if (Test-Path -LiteralPath $here) { throw }; continue }; foreach ($e in $names) { try { $a = [IO.File]::GetAttributes($e) } catch { continue }; if (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $kind = $null; try { $kind = (Get-Item -LiteralPath $e -Force -ErrorAction Stop).LinkType } catch { throw ('sb-reparse-point ' + $e) }; if ($kind -eq 'Junction' -or $kind -eq 'SymbolicLink') { throw ('sb-reparse-point ' + $e) } }; if (($a -band [IO.FileAttributes]::Directory) -ne 0) { $d.Add($e); $todo.Push($e) } else { $f.Add($e) } } }; return @{ files = $f; folders = $d } }",
	// Every entry's owner is read and a foreign one refused BEFORE `/setowner` and `/reset` (R11-F001; VM pass 5b): `/setowner /C` would take an entry another account made and granted the user WRITE_OWNER on
	// (and a reset, WRITE_DAC through a grant that account made, would rewrite the DACL of an entry it still owns). A foreign entry is refused with nothing below the folder changed.
	// The gap between this walk and the calls below (an entry planted in it) is known and bounded by the folder's own protection (R11-F003).
	"$pre = Walk $dir",
	"foreach ($p in @($pre.folders) + @($pre.files)) { try { CheckOwner $p } catch { if (Test-Path -LiteralPath $p) { throw }; continue } }",
	// Everything below the folder is then made the user's, in ONE call (`/C` goes on past an item it may not change; the read-back below is the check): /reset and /inheritance replace DACLs and
	// never owners, so what an elevated run made (BUILTIN\Administrators) or SYSTEM made would keep that implicit WRITE_DAC; as the owner the user can then reset it.
	"& $icacls \"$dir\\*\" /setowner \"*${sid}\" /T /C /L /Q | Out-Null",
	// Then everything already below the folder (server.lock the starter took, server.log, the link and stash folders, a secondary slot's files) is reset in ONE call: its explicit ACEs go and it
	// inherits the folder's owner and SYSTEM grant again, which an (OI)(CI) grant hands to files and folders alike. `/C` goes on past an item that vanishes meanwhile (a temp file renamed into
	// place), and the exit code is not the check, since an empty folder has nothing to match: the read-back below is. A call per item would start a process for each of them (link/inbox holds up to 500).
	"& $icacls \"$dir\\*\" /reset /T /C /L /Q | Out-Null",
	"$tree = Walk $dir",
	"$files = @()",
	"foreach ($name in 'server.json', 'server.lock', 'server.log', 'gui.json', 'paired.json') { $p = Join-Path $dir $name; if (Test-Path -LiteralPath $p) { $files += $p } }",
	"$link = Join-Path $dir 'link'",
	"$files += @($tree.files | Where-Object { $_.StartsWith($link + '\\') })",
	// A secondary slot's folder holds that slot's secret in its server.json.
	"$servers = Join-Path $dir 'servers'",
	"$files += @($tree.files | Where-Object { $_.StartsWith($servers + '\\') -and [IO.Path]::GetFileName($_) -eq 'server.json' })",
	"$read = @(foreach ($p in $files) { try { [ordered]@{ path = $p; sddl = (Get-Acl -LiteralPath $p).Sddl } } catch { if (Test-Path -LiteralPath $p) { throw } } })",
	// Every folder below, with its SDDL read back: each must be the user's with allow ACEs for the user and SYSTEM only (`aclProblems`).
	"$readFolders = @(foreach ($p in $tree.folders) { try { [ordered]@{ path = $p; sddl = (Get-Acl -LiteralPath $p).Sddl } } catch { if (Test-Path -LiteralPath $p) { throw } } })",
	"$out = [ordered]@{ sid = $sid; started = $started; dir = (Get-Acl -LiteralPath $dir).Sddl; files = $read; folders = $readFolders }",
];
/**
 * The PowerShell script: the folder and the server's pid come in the environment (SB_ACL_DIR, SB_ACL_PID), so no path is ever quoted into the script.
 *
 * The folder is protected first, without `/T`. `/T` there would strip the inherited ACEs of the files already in it (server.lock is taken by the starter, server.log is opened by the
 * server itself, both before this runs) and a `(OI)(CI)` grant does not land on a file, so they ended with an empty DACL that not even their owner could read. What is there is then
 * reset to inherit from the folder by one `icacls <dir>\* /reset /T /C /Q`, whatever the number of items (a call per item took a process each, link/inbox alone holds up to 500); a file
 * created later inherits the owner and SYSTEM from the folder.
 */
export const ACL_SCRIPT = [UTF8_OUT, PROGRESS_OFF, CLM_CHECK, "$ErrorActionPreference = 'Stop'", ...ACL_STEPS, "$json = $out | ConvertTo-Json -Compress -Depth 4", asciiJson("$json")].join("\n");

/** The PowerShell call: `-EncodedCommand` (UTF-16LE base64) so no quoting of the script can go wrong; `windowsHide` keeps its console off the desktop. */
export function aclCommand(dir: string, env: NodeJS.ProcessEnv = process.env, timeout = ACL_MS, pid: number = process.pid) {
	return {
		file: powershellPath(env),
		args: [...POWERSHELL_FLAGS, "-EncodedCommand", Buffer.from(ACL_SCRIPT, "utf16le").toString("base64")],
		options: { encoding: "utf8" as const, timeout, windowsHide: true, cwd: system32(env), env: { ...env, SB_ACL_DIR: dir, SB_ACL_PID: String(pid) } },
	};
}

export interface Ace { type: string; flags: string[]; rights: string; sid: string }
export interface Sddl { owner?: string; daclFlags: string[]; aces: Ace[] }

// An SDDL string is `O:<sid>G:<sid>D:<flags>(ace)(ace)…S:…`; a SID is `S-1-…` or a two-letter alias.
const sidToken = (text: string, at: number) => {
	const rest = text.slice(at);
	const found = /^S-[0-9-]+/.exec(rest) ?? /^[A-Z]{2}/.exec(rest);
	return found?.[0] ?? "";
};
/** Reads an SDDL string; throws on anything that is not one, so a check never passes on text it did not understand. */
export function parseSddl(text: string): Sddl {
	const out: Sddl = { daclFlags: [], aces: [] };
	let i = 0, sawDacl = false;
	while (i < text.length) {
		const tag = text[i], colon = text[i + 1];
		if (!tag || colon !== ":" || !"OGDS".includes(tag)) throw new Error(`unexpected SDDL text at ${i}: ${text.slice(i, i + 12)}`);
		i += 2;
		if (tag === "O" || tag === "G") {
			const sid = sidToken(text, i);
			if (!sid) throw new Error(`no SID after ${tag}:`);
			if (tag === "O") out.owner = sid;
			i += sid.length;
			continue;
		}
		const flags = /^[A-Za-z_]*/.exec(text.slice(i))![0];
		i += flags.length;
		const aces: string[] = [];
		while (text[i] === "(") {
			const close = text.indexOf(")", i);
			if (close < 0) throw new Error("an ACE is not closed");
			aces.push(text.slice(i + 1, close));
			i = close + 1;
		}
		if (tag === "D") {
			sawDacl = true;
			out.daclFlags = flags.match(/NO_ACCESS_CONTROL|AR|AI|P/g) ?? [];
			out.aces = aces.map((raw) => {
				const parts = raw.split(";");
				if (parts.length < 6) throw new Error(`an ACE has ${parts.length} fields: ${raw}`);
				return { type: parts[0]!, flags: parts[1]!.match(/[A-Z]{2}/g) ?? [], rights: parts[2]!, sid: parts[5]! };
			});
		}
	}
	if (!sawDacl) throw new Error("the SDDL has no DACL");
	return out;
}

/** A SID as `S-1-…`: SYSTEM's alias, and the aliases SDDL gives the built-in accounts (local Administrator and Guest, domain Admins and Users) when they are this owner's. */
function canon(sid: string, owner: string): string {
	const s = sid.toUpperCase();
	if (s === "SY") return SYSTEM_SID;
	const rid = { LA: "-500", LG: "-501", DA: "-512", DU: "-513" }[s];
	return rid && owner.endsWith(rid) ? owner : s;
}

/** What is wrong with a folder's SDDL: it must be protected (no inheritance), with exactly the owner and SYSTEM as allow ACEs, none inherited. Empty when it is right. */
export function folderProblems(sddl: string, owner: string): string[] {
	let parsed: Sddl;
	try {
		parsed = parseSddl(sddl);
	} catch (error) {
		return [`the folder's SDDL cannot be read: ${(error as Error).message}`];
	}
	const problems: string[] = [];
	if (!parsed.daclFlags.includes("P")) problems.push("the folder's DACL is not protected (it inherits)");
	if (parsed.daclFlags.includes("NO_ACCESS_CONTROL")) problems.push("the folder has a null DACL");
	const want = new Set([owner.toUpperCase(), SYSTEM_SID]);
	const seen = parsed.aces.map((ace) => canon(ace.sid, owner));
	for (const ace of parsed.aces) {
		if (ace.type !== "A") problems.push(`the folder has an ACE of type ${ace.type} for ${ace.sid}`);
		if (ace.flags.includes("ID")) problems.push(`the folder has an inherited ACE for ${ace.sid}`);
	}
	for (const sid of seen) if (!want.has(sid)) problems.push(`the folder grants ${sid}, who is neither the owner nor SYSTEM`);
	for (const sid of want) if (!seen.includes(sid)) problems.push(`the folder grants nothing to ${sid}`);
	if (parsed.aces.length !== want.size) problems.push(`the folder has ${parsed.aces.length} ACEs, not ${want.size}`);
	return problems;
}
/** The same for a secret file: allow ACEs for the owner and SYSTEM only, explicit or inherited (a file written by rename after the icacls run inherits exactly those two). */
export function fileProblems(sddl: string, owner: string, path = "a file"): string[] {
	let parsed: Sddl;
	try {
		parsed = parseSddl(sddl);
	} catch (error) {
		return [`${path}: the SDDL cannot be read: ${(error as Error).message}`];
	}
	const want = new Set([owner.toUpperCase(), SYSTEM_SID]), seen = new Set<string>(), problems: string[] = [];
	for (const ace of parsed.aces) {
		if (ace.type !== "A") problems.push(`${path}: an ACE of type ${ace.type} for ${ace.sid}`);
		const sid = canon(ace.sid, owner);
		seen.add(sid);
		if (!want.has(sid)) problems.push(`${path}: grants ${sid}, who is neither the owner nor SYSTEM`);
	}
	for (const sid of want) if (!seen.has(sid)) problems.push(`${path}: grants nothing to ${sid}`);
	return problems;
}

export interface AclResult { sid: string; dir: string; files: { path: string; sddl: string }[]; folders?: { path: string; sddl: string }[]; started?: string }
/** The answer line of the script, as a value; throws when it is not what the script prints. */
export function parseAclOutput(stdout: string): AclResult {
	const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`PowerShell answered ${line.slice(0, 120) || "nothing"}`);
	}
	const { sid, dir, files, folders, started } = (parsed ?? {}) as Partial<AclResult> & { files?: unknown; folders?: unknown };
	if (typeof sid !== "string" || !/^S-1-[0-9-]+$/.test(sid) || typeof dir !== "string") throw new Error(`PowerShell's answer has no SID and SDDL: ${line.slice(0, 120)}`);
	// PowerShell turns a one-item array into the item itself in some versions.
	const listOf = (value: unknown): { path: string; sddl: string }[] => (Array.isArray(value) ? value : value && typeof value === "object" ? [value] : []).filter((f): f is { path: string; sddl: string } => typeof f?.path === "string" && typeof f?.sddl === "string");
	// The start time is kept only in the one form startof.ts writes, so a record never carries text the other readers would not compare equal.
	return { sid, dir, files: listOf(files), folders: listOf(folders), ...(typeof started === "string" && START_TEXT.test(started) ? { started } : {}) };
}
/**
 * The folder's owner must be the user: the exact `O:` of `(Get-Acl).Sddl`, which PowerShell's read-back has and `icacls /save` has not. A folder another account owns keeps an owner's implicit
 * WRITE_DAC whatever its DACL says now, so it is refused before any secret is written ("belongs to another account"; the native owner read can only say "not known" for a long account name).
 */
export function ownerProblems(sddl: string, owner: string, path = "the folder", kind = "folder"): string[] {
	let found: string | undefined;
	try {
		found = parseSddl(sddl).owner;
	} catch {
		return []; // folderProblems says the SDDL cannot be read
	}
	if (!found) return [`${path}: the SDDL names no owner`];
	// BUILTIN\Administrators is accepted as an owner as well as the user (VM pass 5b): an elevated token's default owner is BA, and the server it starts writes `server.json` while the launch script
	// is still running. BA-owned objects are made by an administrator's elevated token, by SYSTEM, and by holders of SeRestorePrivilege (Backup Operators), who pass this gate anyway: an administrator and
	// SYSTEM can read the folder whatever its owner or DACL, and a backup operator can read and write any file, so BA ownership gives no account anything it lacks; the
	// threat this gate stops is another standard account owning an entry. BA is NOT accepted as an ACE (`folderProblems` and `fileProblems` still allow the owner and SYSTEM only).
	const who = canon(found, owner);
	return who === owner.toUpperCase() || OWNER_OK_SIDS.includes(who) || who === "BA" ? [] : [`${path === "the folder" ? path : `the ${kind} ${path}`} belongs to another account (${found}), not to ${owner}`];
}
/** Every problem in a result: the folder's owner, its DACL, and each secret file's. */
export const aclProblems = ({ sid, dir, files, folders = [] }: AclResult) => [
	...ownerProblems(dir, sid), ...folderProblems(dir, sid),
	// Every folder and file below: the user's, with allow ACEs for the user and SYSTEM only (inherited ones allowed). An owner that was not taken (`/setowner` refused) or a DACL that was not reset
	// (`/reset` refused, `/C` going on) is refused here, whichever of the two the other call fixed (R8-F001, R8-F002).
	...folders.flatMap((f) => [...ownerProblems(f.sddl, sid, f.path), ...fileProblems(f.sddl, sid, f.path)]),
	...files.flatMap((f) => [...ownerProblems(f.sddl, sid, f.path, "file"), ...fileProblems(f.sddl, sid, f.path)]),
];

const START_TEXT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export class AclError extends Error {
	sddl: string | undefined;
	constructor(message: string, sddl?: string) {
		super(message);
		this.sddl = sddl;
	}
}
export type Exec = (file: string, args: string[], options: ReturnType<typeof aclCommand>["options"], done: (error: Error | null, stdout: string, stderr?: string) => void) => unknown;
const run: Exec = (file, args, options, done) => execFile(file, args, options, (error, stdout, stderr) => done(error, String(stdout), String(stderr)));

/** The scripts' own words (a link or junction found, Constrained Language Mode) as sentences; any other text as it is. Used for what a script prints on stderr and for what the launch script writes in the marker. */
export function scriptWords(text: string): string {
	if (text.startsWith(REPARSE_WORD)) return `a link or junction was found inside the state folder, which is refused (${text.slice(REPARSE_WORD.length).trim()})`;
	// Constrained Language Mode: the script's own word, or the English text of the engine's refusal (a localized one is `?`s, which is why the script says it first).
	if (text.includes(CLM_WORD) || /only core types are supported in this language mode|supported only on core types in this language mode|constrained language mode/i.test(text)) return CLM_TEXT;
	return text;
}
/**
 * Why a program failed, for a person: its stderr's message line (see `messageLine`), else the last line of its stdout, and its exit code. Never `error.message`, which for a failed
 * child process begins with the whole command line (an `-EncodedCommand` of 2 KB of base64) and so fills any short cut of it.
 */
export function execFailure(error: Error & { code?: unknown; status?: unknown }, stderr?: unknown, stdout?: unknown): string {
	// Where stderr has no message (progress records only, or nothing) the last line of stdout stands; the exit code always follows.
	let last = messageLine(stderr) || asciiLine(stdout);
	last = scriptWords(last);
	const code = typeof error.code === "number" ? error.code : typeof error.status === "number" ? error.status : undefined;
	const first = error.message.split(/\r?\n/)[0] ?? "";
	const text = last || (/^Command failed:/.test(first) ? "" : asciiLine(first));
	const reason = text || (code !== undefined ? "" : typeof error.code === "string" ? error.code : "it failed");
	return [reason, code !== undefined ? `exit code ${code}` : undefined].filter(Boolean).join(", ").slice(0, 300);
}
const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" };
/** One CLIXML string as text: XML entities, then the `_xHHHH_` escapes (`_x000D__x000A_` is a line break, `_x005F_` an underscore). */
const clixmlString = (raw: string) =>
	raw
		.replace(/&(?:#x([0-9a-fA-F]+)|#(\d+)|(lt|gt|quot|apos|amp));/g, (match, hex?: string, dec?: string, name?: string) => {
			if (name) return XML_ENTITIES[name]!;
			const code = Number.parseInt(hex ?? dec!, hex ? 16 : 10);
			// A reference past U+10FFFF (or a surrogate) is no character: kept as written, and the decode never throws inside an exec callback.
			return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
		})
		.replace(/_x([0-9a-fA-F]{4})_/g, (_m, code: string) => String.fromCharCode(Number.parseInt(code, 16)));
/**
 * The text of a PowerShell stderr. When it is CLIXML (it starts with `#< CLIXML`) the text is the `<S S="Error">` strings, decoded and joined; progress records and the rest of the XML are
 * not text, so a successful run's progress alone gives "". Anything else is returned as it is.
 */
export function plainStderr(text: unknown): string {
	const raw = String(text ?? "");
	if (!/^\s*#< CLIXML/.test(raw)) return raw;
	return [...raw.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) => clixmlString(m[1]!)).join("");
}
/**
 * The message of an error PowerShell 5.1 printed: its first non-empty line that does not start with `At line`, `+` or `~` (the position, the source line, the markers, and the
 * `+ CategoryInfo` / `+ FullyQualifiedErrorId` lines that follow the message), as `asciiLine` cuts it. Where every line is one of those, the last line stands.
 */
export function messageLine(text: unknown): string {
	const lines = plainStderr(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	return asciiLine(lines.find((l) => !/^(At line|[+~])/.test(l)) ?? lines.at(-1));
}
/**
 * The last non-empty line of a program's output, cut to printable ASCII (anything else becomes `?`) and to 120 characters. A console prints in its code page (CP950, CP932, …) and Node reads UTF-8,
 * so the text of a localized message comes out half garbled; what is kept is safe to put in a JSON line and a log, and the message that matters is a fixed one.
 */
export function asciiLine(text: unknown): string {
	const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	return (lines.at(-1) ?? "").replace(/[^\x20-\x7E]+/g, "?").slice(0, 120);
}

/** The answer of the script as a verified result: throws an AclError (with the SDDL it read) when the folder or a secret file is not owner and SYSTEM only. */
const PROBLEMS_SHOWN = 5;
function verified(result: AclResult, dir: string): { sid: string; started?: string } {
	const problems = aclProblems(result);
	// A check that fails on hundreds of files (an inbox no call could fix) names the first few; the remedy follows once.
	const shown = problems.length > PROBLEMS_SHOWN ? [...problems.slice(0, PROBLEMS_SHOWN), `and ${problems.length - PROBLEMS_SHOWN} more`] : problems;
	const remedy = problems.some((p) => /belongs to another account/.test(p)) ? ` (Run pi as that account, an elevated shell for an administrator's, or delete ${dir}.)` : "";
	if (problems.length) throw new AclError(`the ACL of ${dir} is not owner and SYSTEM only: ${shown.join("; ")}${remedy}`, [result.dir, ...(result.folders ?? []).map((f) => `${f.path}: ${f.sddl}`), ...result.files.map((f) => `${f.path}: ${f.sddl}`)].join("\n"));
	return { sid: result.sid, ...(result.started ? { started: result.started } : {}) };
}

/** Sets the ACL of the state directory and checks it, in one PowerShell start that also tells the start time of `pid`. Throws an AclError (with the SDDL it read) when setting or checking fails. */
export function applyAcl(dir: string, exec: Exec = run, env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): Promise<{ sid: string; started?: string }> {
	const { file, args, options } = aclCommand(dir, env, ACL_MS, pid);
	return new Promise((resolve, reject) => {
		exec(file, args, options, (error, stdout, stderr) => {
			if (error) return reject(new AclError(`could not set the ACL of ${dir}: ${execFailure(error, stderr, stdout)}`));
			try {
				resolve(verified(parseAclOutput(stdout), dir));
			} catch (failure) {
				reject(failure instanceof AclError ? failure : new AclError(`could not read the ACL of ${dir}: ${(failure as Error).message}`));
			}
		});
	});
}

// --- the check made by the process that started the server ---
//
// The starter's launch PowerShell (breakaway.ts) creates the server and, in the same PowerShell start, makes the check this module's script makes: it knows the new pid at once, so the server's
// own PowerShell start (4 to 15 s on the Windows VM) is not made. It leaves its answer in a file in the protected state folder named by a token only the server's command line carries; the server
// reads it, checks the SDDLs itself (`aclProblems`), and only then writes its secret. A `serve` server, and one started by the plain spawn, have no token and make the check themselves.

export const ACL_TOKEN = /^[0-9a-f]{32}$/;
export const aclMarkerPath = (dir: string, token: string) => join(dir, `acl.${token}.json`);
const MARKER_MS = 70_000;

/** The marker's text as a verified result. An `error` marker (the starter could not make the check, or never finished it) is an AclError; so is an answer made for another pid. */
export function readMarker(text: string, dir: string, pid: number): { sid: string; started?: string } {
	let parsed: { pid?: unknown; error?: unknown };
	try {
		parsed = JSON.parse(text) as typeof parsed;
	} catch {
		throw new AclError(`the ACL check of ${dir} left by the process that started this server cannot be read`);
	}
	if (typeof parsed.error === "string" && parsed.error) throw new AclError(`could not set the ACL of ${dir}: ${scriptWords(asciiLine(parsed.error))}`);
	if (parsed.pid !== pid) throw new AclError(`the ACL check of ${dir} was made for pid ${String(parsed.pid)}, not for this server (pid ${pid})`);
	try {
		return verified(parseAclOutput(text), dir);
	} catch (failure) {
		throw failure instanceof AclError ? failure : new AclError(`could not read the ACL of ${dir}: ${(failure as Error).message}`);
	}
}
/** Waits for the starter's marker (its file appears whole, by rename), removes it, and checks it. Throws an AclError when it does not come within `waitMs`. */
export async function awaitAclMarker(dir: string, token: string, pid: number, deps: { waitMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ sid: string; started?: string }> {
	if (!ACL_TOKEN.test(token)) throw new AclError("the token of the ACL check is not 32 hex digits");
	const now = deps.now ?? Date.now, sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))), waitMs = deps.waitMs ?? MARKER_MS;
	const file = aclMarkerPath(dir, token), end = now() + waitMs;
	for (;;) {
		let text: string | undefined;
		try {
			text = readFileSync(file, "utf8");
		} catch { /* not there yet */ }
		if (text !== undefined) {
			rmSync(file, { force: true });
			return readMarker(text, dir, pid);
		}
		if (now() >= end) throw new AclError(`the ACL check of ${dir} did not arrive from the process that started this server within ${Math.round(waitMs / 1000)} s`);
		await sleep(50);
	}
}
