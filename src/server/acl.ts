import { execFile } from "node:child_process";
import { powershellPath, system32 } from "../winpath.ts";

// The Windows ACL of the state directory (docs/specs/2026-10-26-sb-backend.md, The control socket). A named pipe is not protected by its name or by a file mode, so the
// secret that opens a connection lives in server.json, and server.json is only as private as the folder it is in. The folder `straw-boss/` (never the agent directory
// above it) gets a protected DACL with the owner and SYSTEM only. Accounts are named by SID, never by a localized name, and the check reads the SDDL
// (`(Get-Acl).Sddl`), never icacls' localized text. Reading the owner's SID, this process's start time, setting the ACL, and reading every SDDL back run in one PowerShell start, which
// answers one JSON line (a PowerShell start costs 2 to 3 s on a slow machine, and the server asks for nothing else of it).

export const SYSTEM_SID = "S-1-5-18";
const ACL_MS = 20_000;

/**
 * The PowerShell script: the folder and the server's pid come in the environment (SB_ACL_DIR, SB_ACL_PID), so no path is ever quoted into the script.
 *
 * The folder is protected first, without `/T`. `/T` there would strip the inherited ACEs of the files already in it (server.lock is taken by the starter, server.log is opened by the
 * server itself, both before this runs) and a `(OI)(CI)` grant does not land on a file, so they ended with an empty DACL that not even their owner could read. What is there is then
 * reset to inherit from the folder by one `icacls <dir>\* /reset /T /C /Q`, whatever the number of items (a call per item took a process each, link/inbox alone holds up to 500); a file
 * created later inherits the owner and SYSTEM from the folder.
 */
export const ACL_SCRIPT = [
	// Windows PowerShell 5.1 writes redirected output in the OEM code page (CP950, CP932, …) and Node reads UTF-8. The answer is also pure ASCII (below), because in those code pages
	// the second byte of some characters (Big5 許 and 功, Shift-JIS ソ and 表) is 0x5C, a backslash that would land inside a JSON string. The setting may fail where no console is attached.
	"try { [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false) } catch { }",
	"$ErrorActionPreference = 'Stop'",
	"$dir = $env:SB_ACL_DIR",
	"$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
	// The start time of the server (Win32_Process.CreationDate, as startof.ts reads every process's), so its own PowerShell start is not made; a failure leaves it null.
	"$started = $null",
	"try { $started = (Get-CimInstance Win32_Process -Filter \"ProcessId=$($env:SB_ACL_PID -as [int])\").CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [cultureinfo]::InvariantCulture) } catch { }",
	// `${sid}:` and not `$sid:`: PowerShell reads the latter as a variable in a scope named sid.
	"$icacls = Join-Path ([Environment]::SystemDirectory) 'icacls.exe'",
	"& $icacls $dir /inheritance:r /grant:r \"*${sid}:(OI)(CI)F\" '*S-1-5-18:(OI)(CI)F' | Out-Null",
	"if ($LASTEXITCODE -ne 0) { throw \"icacls failed with exit code $LASTEXITCODE\" }",
	// Everything already below the folder (server.lock the starter took, server.log, the link and stash folders, a secondary slot's files) is reset in ONE call: its explicit ACEs go and it
	// inherits the folder's owner and SYSTEM grant again, which an (OI)(CI) grant hands to files and folders alike. `/C` goes on past an item that vanishes meanwhile (a temp file renamed into
	// place), and the exit code is not the check, since an empty folder has nothing to match: the read-back below is. A call per item would start a process for each of them (link/inbox holds up to 500).
	"& $icacls \"$dir\\*\" /reset /T /C /Q | Out-Null",
	"$files = @()",
	"foreach ($name in 'server.json', 'server.lock', 'server.log', 'gui.json', 'paired.json') { $p = Join-Path $dir $name; if (Test-Path -LiteralPath $p) { $files += $p } }",
	"$link = Join-Path $dir 'link'",
	"if (Test-Path -LiteralPath $link) { $files += @(Get-ChildItem -LiteralPath $link -Recurse -File | ForEach-Object { $_.FullName }) }",
	// A secondary slot's folder holds that slot's secret in its server.json.
	"$servers = Join-Path $dir 'servers'",
	"if (Test-Path -LiteralPath $servers) { foreach ($slotDir in @(Get-ChildItem -LiteralPath $servers -Directory)) { $p = Join-Path $slotDir.FullName 'server.json'; if (Test-Path -LiteralPath $p) { $files += $p } } }",
	"$read = @(foreach ($p in $files) { try { [ordered]@{ path = $p; sddl = (Get-Acl -LiteralPath $p).Sddl } } catch { if (Test-Path -LiteralPath $p) { throw } } })",
	"$out = [ordered]@{ sid = $sid; started = $started; dir = (Get-Acl -LiteralPath $dir).Sddl; files = $read }",
	"$json = $out | ConvertTo-Json -Compress -Depth 4",
	// Every character above 0x7F becomes \uXXXX (a UTF-16 unit at a time), which JSON.parse reads back as it was.
	"[regex]::Replace($json, '[^\\x00-\\x7F]', [System.Text.RegularExpressions.MatchEvaluator]{ param($m) ('\\u{0:x4}' -f [int][char]$m.Value) })",
].join("\n");

/** The PowerShell call: `-EncodedCommand` (UTF-16LE base64) so no quoting of the script can go wrong; `windowsHide` keeps its console off the desktop. */
export function aclCommand(dir: string, env: NodeJS.ProcessEnv = process.env, timeout = ACL_MS, pid: number = process.pid) {
	return {
		file: powershellPath(env),
		args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ACL_SCRIPT, "utf16le").toString("base64")],
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

export interface AclResult { sid: string; dir: string; files: { path: string; sddl: string }[]; started?: string }
/** The answer line of the script, as a value; throws when it is not what the script prints. */
export function parseAclOutput(stdout: string): AclResult {
	const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`PowerShell answered ${line.slice(0, 120) || "nothing"}`);
	}
	const { sid, dir, files, started } = (parsed ?? {}) as Partial<AclResult> & { files?: unknown };
	if (typeof sid !== "string" || !/^S-1-[0-9-]+$/.test(sid) || typeof dir !== "string") throw new Error(`PowerShell's answer has no SID and SDDL: ${line.slice(0, 120)}`);
	// PowerShell turns a one-item array into the item itself in some versions.
	const list = Array.isArray(files) ? files : files && typeof files === "object" ? [files] : [];
	// The start time is kept only in the one form startof.ts writes, so a record never carries text the other readers would not compare equal.
	return { sid, dir, files: list.filter((f): f is { path: string; sddl: string } => typeof f?.path === "string" && typeof f?.sddl === "string"), ...(typeof started === "string" && START_TEXT.test(started) ? { started } : {}) };
}
/** Every problem in a result: the folder's, and each secret file's. */
export const aclProblems = ({ sid, dir, files }: AclResult) => [...folderProblems(dir, sid), ...files.flatMap((f) => fileProblems(f.sddl, sid, f.path))];

const START_TEXT = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

export class AclError extends Error {
	sddl: string | undefined;
	constructor(message: string, sddl?: string) {
		super(message);
		this.sddl = sddl;
	}
}
export type Exec = (file: string, args: string[], options: ReturnType<typeof aclCommand>["options"], done: (error: Error | null, stdout: string) => void) => unknown;
const run: Exec = (file, args, options, done) => execFile(file, args, options, (error, stdout) => done(error, String(stdout)));

/** Sets the ACL of the state directory and checks it, in one PowerShell start that also tells the start time of `pid`. Throws an AclError (with the SDDL it read) when setting or checking fails. */
export function applyAcl(dir: string, exec: Exec = run, env: NodeJS.ProcessEnv = process.env, pid: number = process.pid): Promise<{ sid: string; started?: string }> {
	const { file, args, options } = aclCommand(dir, env, ACL_MS, pid);
	return new Promise((resolve, reject) => {
		exec(file, args, options, (error, stdout) => {
			if (error) return reject(new AclError(`could not set the ACL of ${dir}: ${error.message}`));
			let result: AclResult;
			try {
				result = parseAclOutput(stdout);
			} catch (failure) {
				return reject(new AclError(`could not read the ACL of ${dir}: ${(failure as Error).message}`));
			}
			const problems = aclProblems(result);
			if (problems.length) return reject(new AclError(`the ACL of ${dir} is not owner and SYSTEM only: ${problems.join("; ")}`, [result.dir, ...result.files.map((f) => `${f.path}: ${f.sddl}`)].join("\n")));
			resolve({ sid: result.sid, ...(result.started ? { started: result.started } : {}) });
		});
	});
}
