import { realpathSync } from "node:fs";
import { win32 } from "node:path";
import { execFileExe } from "../exe.mjs";
import { asciiJson, CLM_CHECK, CLM_TEXT, CLM_WORD, execFailure, POWERSHELL_FLAGS, PROGRESS_OFF, UTF8_OUT } from "../server/acl.ts";
import { powershellPath, system32 } from "../winpath.ts";

// What the desktop firewall says about Wi-Fi access (docs/specs/2026-10-30-sb-gui-lan.md, "Firewalls" and "Windows"; Steps L8). The server never changes a firewall and runs nothing elevated: it reads the state a
// plain account can read, and the notes it returns name the commands the boss can run. Everything here is a function of the text a read command printed, so the parsers are tested on recorded and synthetic
// outputs; `readFirewall` is the one function that starts a program (through `execFileExe`, by absolute path), and a test hands it a stand-in.

/** Which addresses Wi-Fi access serves (the interface is the name `os.networkInterfaces()` gives, which on Windows is the adapter's alias) and the port. */
export interface FirewallInput { port: number; served: { address: string; iface: string }[] }
/** `notes` are what the boss sees (none when nothing blocks or the platform has no check); `summary` is one line for the server's log. */
export interface FirewallRead { notes: string[]; summary: string; coded?: FwNote[] }
/** A note with the code the page translates it by and the params it fills in (the commands among them, verbatim); `text` is the English the TUI shows. */
export interface FwNote { text: string; code: string; params?: Record<string, string | number> }
const fw = (code: string, text: string, params?: FwNote["params"]): FwNote => ({ text, code, ...(params ? { params } : {}) });
const texts = (list: FwNote[]) => list.map((n) => n.text);
/** Runs a program with arguments and answers its stdout; rejects when it fails, with `stderr` on the error when there is one. */
export type FirewallExec = (file: string, args: string[], options: { timeout: number; env: NodeJS.ProcessEnv; cwd?: string }) => Promise<string>;
export interface FirewallDeps { platform?: NodeJS.Platform; execPath?: string; env?: NodeJS.ProcessEnv; exec?: FirewallExec; realpath?: (path: string) => string }

const READ_MS = 60_000;
const MAX_BUFFER = 32 * 1024 * 1024;
const run: FirewallExec = (file, args, options) =>
	new Promise((resolve, reject) => {
		execFileExe(file, args, { ...options, encoding: "utf8", windowsHide: true, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
			if (!error) return resolve(stdout);
			reject(Object.assign(error, { stderr, stdout }));
		});
	});
/** Why a run failed. A child killed by `execFile`'s timeout has no exit code (`killed`, a signal): that is a timeout, not a refusal. */
const reasonOf = (error: unknown, timeoutMs: number) => {
	const e = error as Error & { stderr?: string; stdout?: string; killed?: boolean; signal?: string | null; code?: unknown };
	if (e.killed && e.signal) return `timed out after ${Math.round(timeoutMs / 1000)} s`;
	return execFailure(e, e.stderr, e.stdout) || "it failed";
};

/** Reads the firewall of this computer for the served addresses. A platform with no check, or a read that failed, is a result; only a port that is not one throws. */
export async function readFirewall(input: FirewallInput, deps: FirewallDeps = {}): Promise<FirewallRead> {
	const platform = deps.platform ?? process.platform, execPath = deps.execPath ?? process.execPath, exec = deps.exec ?? run, env = deps.env ?? process.env;
	if (platform === "darwin") return readMac(execPath, exec, env);
	if (platform === "win32") return readWindows(input, execPath, exec, env, deps.realpath ?? ((p) => realpathSync.native(p)));
	return { notes: [], summary: "no firewall check on this platform" };
}

// --- macOS ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const SOCKETFILTERFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";
export type MacApp = "blocked" | "permitted" | "unlisted";
export interface MacFirewall { on: boolean; blockAll: boolean; app: MacApp | undefined }

/** `--getglobalstate`: "Firewall is enabled. (State = 1)", "Firewall is disabled. (State = 0)", and on older systems "(State = 2)" for block all. Undefined when the text is neither. */
export function parseMacState(text: string): { on: boolean; blockAll: boolean } | undefined {
	const state = /\(State\s*=\s*(\d+)\)/i.exec(text)?.[1];
	if (state !== undefined) return { on: state !== "0", blockAll: state === "2" };
	if (/\bis\s+enabled\b/i.test(text)) return { on: true, blockAll: false };
	if (/\bis\s+disabled\b/i.test(text)) return { on: false, blockAll: false };
	return undefined;
}
/** `--getblockall`: "Firewall has block all state set to enabled." (newer) or "Block all ENABLED!" (older). */
export function parseMacBlockAll(text: string): boolean | undefined {
	const word = /block all state set to (enabled|disabled)/i.exec(text)?.[1] ?? /\bblock all (enabled|disabled)\b/i.exec(text)?.[1];
	return word === undefined ? undefined : word.toLowerCase() === "enabled";
}
/** `--getappblocked <path>`: "Incoming connection to <path> is blocked." / "is permitted.", or the program is not in the firewall's list. Only the end of the line is read: the path may hold either word. */
export function parseMacApp(text: string): MacApp | undefined {
	const line = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
	const verdict = /^Incoming connections? to .* (?:is|are) (blocked|permitted)\.?$/i.exec(line)?.[1];
	if (verdict) return verdict.toLowerCase() === "blocked" ? "blocked" : "permitted";
	return /\bnot part of the firewall\b/i.test(line) ? "unlisted" : undefined;
}
/** The notes: only when the firewall is on, and it blocks all incoming connections or blocks node. */
export const macNotes = (f: MacFirewall): string[] => texts(macCoded(f));
export function macCoded(f: MacFirewall): FwNote[] {
	const out: FwNote[] = [];
	if (!f.on) return out;
	if (f.blockAll) out.push(fw("fw_block_all", "macOS firewall blocks all incoming connections, so a phone cannot connect: turn off \"Block all incoming connections\" in System Settings, Network, Firewall, Options."));
	if (f.app === "blocked") out.push(fw("fw_block_node", "macOS firewall blocks node: allow it in System Settings, Network, Firewall, Options."));
	return out;
}
async function readMac(execPath: string, exec: FirewallExec, env: NodeJS.ProcessEnv): Promise<FirewallRead> {
	const ask = (arg: string, ...more: string[]) => exec(SOCKETFILTERFW, [arg, ...more], { timeout: 10_000, env });
	try {
		const state = parseMacState(await ask("--getglobalstate"));
		if (!state) return { notes: [], summary: "macOS firewall: the state could not be read (unexpected text)" };
		// Nothing below matters while it is off, and the reads stay read-only: no sudo, no setting changed.
		if (!state.on) return { notes: [], summary: "macOS firewall: off" };
		const blockAll = state.blockAll || (parseMacBlockAll(await ask("--getblockall")) ?? false), app = parseMacApp(await ask("--getappblocked", execPath));
		const coded = macCoded({ on: true, blockAll, app });
		return { notes: texts(coded), coded, summary: `macOS firewall: on, block all ${blockAll ? "on" : "off"}, node ${app ?? "unknown"}` };
	} catch (error) {
		return { notes: [], summary: `macOS firewall: the state could not be read (${reasonOf(error, 10_000)})` };
	}
}

// --- Windows --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type Profile = "Domain" | "Private" | "Public";
const PROFILES: readonly Profile[] = ["Domain", "Private", "Public"];
/** One enabled inbound rule, as the notes need it. `program` is `"any"`, `"system"`, or the expanded path in full-path form and lower case (`""` when the stored path could not be made one: it matches nothing). */
export interface WinRule {
	name: string; display: string; action: "allow" | "block";
	profiles: Set<Profile>; program: string; tcp: boolean; ports: "any" | [number, number][];
	/** The scope: the remote and local address entries (empty = any) and the interface types (empty = any), as the firewall prints them. */
	remote: string[]; local: string[]; ifTypes: string[];
}
export interface WinRead { networks: { alias: string; category: Profile | undefined; type?: "wired" | "wireless" }[]; firewallOn: Partial<Record<Profile, boolean>>; rules: WinRule[] }

/** The steps of the read, from the networks to `$out`. ASCII only; nothing is quoted into them (the port and the path are compared in JavaScript). */
export const WINDOWS_STEPS = [
	// The category of each network, by the adapter's alias (what `os.networkInterfaces()` calls the interface): a failure here leaves the categories unknown, which the notes read strictly.
	"$adapters = @{}; try { foreach ($a in Get-NetAdapter) { $adapters[[string]$a.Name] = [string]$a.InterfaceType } } catch { }",
	"$networks = @(); try { $networks = @(Get-NetConnectionProfile | ForEach-Object { [ordered]@{ alias = [string]$_.InterfaceAlias; category = [string]$_.NetworkCategory; type = [string]$adapters[[string]$_.InterfaceAlias] } }) } catch { }",
	"$profiles = @(); try { $profiles = @(Get-NetFirewallProfile | ForEach-Object { [ordered]@{ name = [string]$_.Name; enabled = [string]$_.Enabled } }) } catch { }",
	// The filters of every rule at once (a filter's InstanceID is its rule's Name): a call per rule takes minutes on a machine with hundreds of rules. The program is never matched by `Get-NetFirewallApplicationFilter -Program`,
	// which compares the stored text exactly (RVLAN2-F015); each stored program is expanded here and compared in JavaScript after full-path normalisation and case folding.
	// The port, address, and interface-type filters are asked for through the enabled inbound rules (one pipeline each): called with no rule piped in, a filtered (non-elevated) token is answered "Access is denied" (VM 1, F1).
	// With no rule there is nothing to pipe, and the bare call would be that same refusal. A rule of a packaged app (an Owner or a PackageFamilyName) counts for nothing here, so its filters are not asked for: each rule costs a call of its own (a fifth of the
	// rules on a stock Windows 11).
	"$er = @(Get-NetFirewallRule -Direction Inbound -Enabled True); $fr = @($er | Where-Object { -not $_.Owner -and -not $_.PackageFamilyName })",
	"$apps = @{}; foreach ($f in Get-NetFirewallApplicationFilter) { $apps[[string]$f.InstanceID] = $f }",
	"$ports = @{}; if ($fr.Count -gt 0) { foreach ($f in ($fr | Get-NetFirewallPortFilter)) { $ports[[string]$f.InstanceID] = $f } }",
	"$addrs = @{}; if ($fr.Count -gt 0) { foreach ($f in ($fr | Get-NetFirewallAddressFilter)) { $addrs[[string]$f.InstanceID] = $f } }",
	"$types = @{}; if ($fr.Count -gt 0) { foreach ($f in ($fr | Get-NetFirewallInterfaceTypeFilter)) { $types[[string]$f.InstanceID] = $f } }",
	// `owner` and `family` (the rule's Owner and PackageFamilyName) are set on a packaged app's rule, which applies to that package only (VM 1, F2).
	"$rules = @(foreach ($r in $er) { $a = $apps[[string]$r.Name]; $p = $ports[[string]$r.Name]; $ad = $addrs[[string]$r.Name]; $ty = $types[[string]$r.Name]; $prog = 'Any'; $svc = 'Any'; $pkg = 'Any'; if ($a) { $prog = [string]$a.Program; $svc = [string]$a.Service; $pkg = [string]$a.Package }; [ordered]@{ name = [string]$r.Name; display = [string]$r.DisplayName; owner = [string]$r.Owner; family = [string]$r.PackageFamilyName; action = [string]$r.Action; direction = [string]$r.Direction; enabled = [string]$r.Enabled; profile = [string]$r.Profile; program = $prog; expanded = [Environment]::ExpandEnvironmentVariables($prog); service = $svc; package = $pkg; protocol = $(if ($p) { [string]$p.Protocol } else { 'Any' }); localPort = $(if ($p) { @($p.LocalPort | ForEach-Object { [string]$_ }) } else { @('Any') }); remote = $(if ($ad) { @($ad.RemoteAddress | ForEach-Object { [string]$_ }) } else { @('Any') }); local = $(if ($ad) { @($ad.LocalAddress | ForEach-Object { [string]$_ }) } else { @('Any') }); ifType = $(if ($ty) { @($ty.InterfaceType | ForEach-Object { [string]$_ }) } else { @('Any') }) } })",
	"$out = [ordered]@{ networks = $networks; profiles = $profiles; rules = $rules }",
];
export const WINDOWS_SCRIPT = [UTF8_OUT, PROGRESS_OFF, CLM_CHECK, "$ErrorActionPreference = 'Stop'", ...WINDOWS_STEPS, "$json = $out | ConvertTo-Json -Compress -Depth 5", asciiJson("$json")].join("\n");
/** The PowerShell call: `-EncodedCommand` so no quoting of the script can go wrong; no elevation is asked for. */
export function windowsCommand(env: NodeJS.ProcessEnv = process.env) {
	return { file: powershellPath(env), args: [...POWERSHELL_FLAGS, "-EncodedCommand", Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64")], options: { timeout: READ_MS, env, cwd: system32(env) } };
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value]);
const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "");
/** The profiles a rule applies to: "Any", a list such as "Domain, Private", or the enum's number (Domain 1, Private 2, Public 4, Any 0). */
function profilesOf(value: unknown): Set<Profile> {
	if (typeof value === "number") return value === 0 ? new Set(PROFILES) : new Set(PROFILES.filter((_, i) => value & (1 << i)));
	const words = text(value).split(/[\s,]+/).filter(Boolean).map((w) => w.toLowerCase());
	if (!words.length || words.includes("any") || words.includes("all")) return new Set(PROFILES);
	return new Set(PROFILES.filter((p) => words.includes(p.toLowerCase())));
}
/** A network category: "Public", "Private", "DomainAuthenticated", or the enum's number (Public 0, Private 1, DomainAuthenticated 2). */
function categoryOf(value: unknown): Profile | undefined {
	const word = text(value).toLowerCase();
	return word === "private" || word === "1" ? "Private" : word === "public" || word === "0" ? "Public" : word === "domainauthenticated" || word === "domain" || word === "2" ? "Domain" : undefined;
}
/** The interface type of an adapter by its `ifType` number (71 is IEEE 802.11; 6, 62, 69, and 117 are Ethernet kinds); undefined for anything else. */
function adapterType(value: unknown): "wired" | "wireless" | undefined {
	const n = Number(text(value).trim());
	return n === 71 ? "wireless" : [6, 62, 69, 117].includes(n) ? "wired" : undefined;
}
/** The words of a filter's list value ("Any", "Domain, Private", an array): empty when it is any. */
function wordsOf(value: unknown): string[] {
	const words = asList(value).flatMap((v) => text(v).split(",")).map((w) => w.trim()).filter(Boolean);
	return words.length === 0 || words.some((w) => ["any", "*"].includes(w.toLowerCase())) ? [] : words;
}
/** An IPv4 or IPv6 address as a number with its bit length; undefined for text that is neither. */
function ipOf(text_: string): { n: bigint; bits: number } | undefined {
	const t = text_.trim().replace(/%.*$/, "");
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(t);
	if (v4) {
		const o = v4.slice(1).map(Number);
		return o.some((x) => x > 255) ? undefined : { n: o.reduce((a, x) => (a << 8n) | BigInt(x), 0n), bits: 32 };
	}
	if (!/^[0-9a-f:]+$/i.test(t) || !t.includes(":") || t.split("::").length > 2) return undefined;
	const [head = "", tail = ""] = t.split("::"), h = head ? head.split(":") : [], k = tail ? tail.split(":") : [];
	const groups = t.includes("::") ? [...h, ...Array(8 - h.length - k.length).fill("0"), ...k] : h;
	if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return undefined;
	return { n: groups.reduce((a, g) => (a << 16n) | BigInt(Number.parseInt(g, 16)), 0n), bits: 128 };
}
/** Whether one address entry of a rule ("10.0.0.0/8", "10.0.0.0/255.0.0.0", "a-b", one address, or `LocalSubnet`) covers the address. Other keywords (DefaultGateway, Internet, …) cover nothing. */
export function entryCovers(entry: string, address: string): boolean {
	const e = entry.trim(), me = ipOf(address);
	if (/^localsubnet$/i.test(e)) return true;
	if (!me) return false;
	const range = /^([^/-]+)-([^/-]+)$/.exec(e);
	if (range) {
		const lo = ipOf(range[1]!), hi = ipOf(range[2]!);
		return Boolean(lo && hi && lo.bits === me.bits && hi.bits === me.bits && lo.n <= me.n && me.n <= hi.n);
	}
	const [base, len] = e.split("/") as [string, string | undefined], b = ipOf(base);
	if (!b || b.bits !== me.bits) return false;
	if (len === undefined) return b.n === me.n;
	const m = /^\d+$/.test(len) ? Number(len) : undefined, mask = m === undefined ? ipOf(len) : undefined;
	const prefix = m !== undefined ? m : mask && mask.bits === b.bits ? mask.n.toString(2).split("1").length - 1 : undefined;
	if (prefix === undefined || prefix > b.bits) return false;
	const shift = BigInt(b.bits - prefix);
	return b.n >> shift === me.n >> shift;
}

/** A path in full-path form for comparison: slashes made backslashes, `.` and `..` and doubled separators resolved, no trailing separator, `\\?\` dropped, lower case. `""` for anything that is not a drive or UNC path (a relative path, or an unexpanded `%variable%`). */
export function comparable(path: string): string {
	let p = path.trim().replace(/^"(.*)"$/, "$1").replace(/\//g, "\\");
	if (p.startsWith("\\\\?\\UNC\\")) p = `\\\\${p.slice(8)}`;
	else if (p.startsWith("\\\\?\\")) p = p.slice(4);
	if (!/^[A-Za-z]:\\/.test(p) && !/^\\\\[^\\]+\\[^\\]+/.test(p)) return "";
	if (p.includes("%")) return "";
	return win32.normalize(p).replace(/[\\]+$/, "").toLowerCase();
}
function portsOf(value: unknown): "any" | [number, number][] {
	const items = asList(value).flatMap((v) => text(v).split(",")).map((s) => s.trim()).filter(Boolean);
	if (!items.length || items.some((s) => s.toLowerCase() === "any")) return "any";
	const out: [number, number][] = [];
	// A keyword such as RPC or IPHTTPSIn names no port this server could be listening on.
	for (const item of items) {
		const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(item);
		if (m) out.push([Number(m[1]), Number(m[2] ?? m[1])]);
	}
	return out;
}
const tcpOf = (value: unknown) => {
	const word = text(value).trim().toLowerCase();
	return word === "" || word === "any" || word === "256" || word === "tcp" || word === "6";
};
/** The answer line of the script as a value; throws when it is not what the script prints. */
export function parseWindows(stdout: string): WinRead {
	const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		throw new Error(`PowerShell answered ${line.slice(0, 120) || "nothing"}`);
	}
	const body = (parsed ?? {}) as { networks?: unknown; profiles?: unknown; rules?: unknown };
	if (!parsed || typeof parsed !== "object" || !("rules" in body)) throw new Error(`PowerShell's answer has no rules: ${line.slice(0, 120)}`);
	const networks = asList(body.networks).map((n) => n as Record<string, unknown>).map((n) => ({ alias: text(n.alias), category: categoryOf(n.category), ...(adapterType(n.type) ? { type: adapterType(n.type)! } : {}) }));
	const firewallOn: Partial<Record<Profile, boolean>> = {};
	for (const p of asList(body.profiles).map((p) => p as Record<string, unknown>)) {
		const profile = categoryOf(p.name);
		if (profile) firewallOn[profile] = !/^(false|0)$/i.test(text(p.enabled).trim());
	}
	const rules: WinRule[] = [];
	for (const r of asList(body.rules).map((r) => r as Record<string, unknown>)) {
		const action = /^(block|4)$/i.test(text(r.action).trim()) ? "block" : /^(allow|2)$/i.test(text(r.action).trim()) ? "allow" : undefined;
		const inbound = /^(inbound|1)$/i.test(text(r.direction).trim()), enabled = /^(true|1)$/i.test(text(r.enabled).trim());
		if (!action || !inbound || !enabled || !text(r.name)) continue;
		// A rule for a service or a packaged app is not a program rule for node. A filter left unset prints empty on this build (not "Any", VM 1), so empty is Any. A rule with an Owner or a PackageFamilyName (a packaged app's
		// `…-In-Allow-ServerCapability`, with Program Any, TCP, ports Any) applies to that package alone, so it is neither an allow nor a block rule for node.
		const special = (v: unknown) => !["", "any", "*"].includes(text(v).trim().toLowerCase());
		const program = text(r.program).trim().toLowerCase();
		const stored = text(r.expanded) || text(r.program);
		rules.push({
			remote: wordsOf(r.remote), local: wordsOf(r.local), ifTypes: wordsOf(r.ifType).flatMap((w) => w.split(/\s+/)).map((w) => w.toLowerCase()),
			name: text(r.name), display: text(r.display), action, profiles: profilesOf(r.profile), tcp: tcpOf(r.protocol), ports: portsOf(r.localPort),
			program: special(r.service) || special(r.package) || special(r.owner) || special(r.family) ? "" : program === "" || program === "any" ? "any" : program === "system" ? "system" : comparable(stored),
		});
	}
	return { networks, firewallOn, rules };
}

const covers = (ports: "any" | [number, number][], port: number) => ports === "any" || ports.some(([lo, hi]) => port >= lo && port <= hi);
/** PowerShell reads `'` and these four as a single quote, inside a single-quoted string and as its delimiter. */
const QUOTES = /['\u2018\u2019\u201A\u201B]/g;
/** A control character, a bidi or invisible format character (it reorders or hides text the boss reads), or a wildcard of `-Name` (`*`, `?`, `[`, `]`: a match of more or other rules than the one that was found, or none). */
const UNQUOTABLE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF*?[\]]/;
/** The text of a name for the boss: a control or format character as `\uXXXX`. */
const shown = (name: string) => name.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** A rule name as a PowerShell literal string (RVLAN3-F011): wrapped in `'`, every quote character doubled, a backtick and `$` left as they are (literal in single quotes). */
export const psLiteral = (name: string) => `'${name.replace(QUOTES, (q) => q + q)}'`;
/** The command that disables rules by name (to run in an elevated PowerShell), and the names that cannot go in it. `command` is undefined when no name is left. */
export function disableCommand(names: string[]): { command: string | undefined; left: string[] } {
	const ok = names.filter((n) => !UNQUOTABLE.test(n)), left = names.filter((n) => UNQUOTABLE.test(n));
	return { command: ok.length ? `Disable-NetFirewallRule -Name ${ok.map(psLiteral).join(",")}` : undefined, left };
}
export const allowCommand = (port: number) => `New-NetFirewallRule -DisplayName "Straw Boss Wi-Fi (TCP ${port})" -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -RemoteAddress LocalSubnet -Profile Private`;
const listCommand = "Get-NetFirewallRule -Direction Inbound -Action Block -Enabled True | Get-NetFirewallApplicationFilter | Where-Object { $_.Program -like '*node.exe' } | Select-Object InstanceID, Program";

/** The notes for what the read found: rules that block, no rule that allows, a Public network (in that order). A firewall that is off for a network's profile has none for it. */
export const windowsNotes = (read: WinRead, input: FirewallInput, execPath: string, realPath?: string): string[] => texts(windowsCoded(read, input, execPath, realPath));
export function windowsCoded(read: WinRead, input: FirewallInput, execPath: string, realPath?: string): FwNote[] {
	// Node started through a link (nvm-windows, Scoop, fnm) is a rule's program by the link or by its target, depending on how it was started: both are compared.
	const nodes = new Set([comparable(execPath), realPath ? comparable(realPath) : ""].filter(Boolean)), port = input.port;
	const byAlias = new Map(read.networks.map((n) => [n.alias.toLowerCase(), n.category]));
	// The profile of each served address; unknown (the category could not be read) is read strictly: every profile for the block rules, any allow rule for the allow check.
	const typeOf = new Map(read.networks.map((n) => [n.alias.toLowerCase(), n.type]));
	const addresses = input.served.map((s) => ({ ...s, profile: byAlias.get(s.iface.toLowerCase()), type: typeOf.get(s.iface.toLowerCase()) }));
	const live = (p: Profile) => read.firewallOn[p] !== false;
	// Whether a rule's scope (remote and local address, interface type) takes in a served address. An interface type that is not known is read strictly: it counts for a block and not for an allow. No served address: no scope to test.
	const scoped = (r: WinRule, a: { address?: string; type?: "wired" | "wireless" | undefined }, strict: boolean) => {
		if (a.address !== undefined && ((r.remote.length && !r.remote.some((e) => entryCovers(e, a.address!))) || (r.local.length && !r.local.some((e) => entryCovers(e, a.address!))))) return false;
		if (!r.ifTypes.length) return true;
		return a.type === undefined ? strict : r.ifTypes.includes(a.type);
	};
	const forNode = (r: WinRule) => r.program === "any" || nodes.has(r.program);
	const fits = (r: WinRule) => r.tcp && covers(r.ports, port) && forNode(r);
	const blocks = read.rules.filter((r) => r.action === "block" && fits(r) && (r.program !== "any" || r.ports !== "any") && (addresses.length ? addresses : [{ profile: undefined, address: undefined, type: undefined }]).some((a) => (a.profile ? [a.profile] : PROFILES).some((p) => live(p) && r.profiles.has(p)) && scoped(r, a, true)));
	const out: FwNote[] = [];
	if (blocks.length) {
		const names = blocks.map((r) => r.name), { command, left } = disableCommand(names);
		const what = blocks.some((r) => r.program !== "any") ? "node.exe" : `TCP port ${port}`;
		const parts = [`Windows Firewall has rules that block ${what} (${names.map(shown).join(", ")}); they win over any allow rule.`];
		if (command) parts.push(`In an elevated PowerShell: \`${command}\`.`);
		if (left.length) parts.push(`${command ? "Of these, " : ""}${left.map(shown).join(", ")} cannot go in a command (the name holds a control character, an invisible or direction-changing character, or a wildcard): disable ${left.length === 1 ? "it" : "them"} in wf.msc (Inbound Rules, the rule, Disable Rule).`);
		out.push(fw("fw_win_block", parts.join(" "), { what: what === "node.exe" ? "node.exe" : "", port, names: names.map(shown).join(", "), command: command ?? "", left: left.map(shown).join(", "), leftCount: left.length }));
	}
	// An address is allowed when some allow rule fits its profile; a Public network counts a Private rule too, since the note below sends the boss to make it Private.
	const allowed = (a: { profile: Profile | undefined; address?: string; type?: "wired" | "wireless" | undefined }) => {
		if (a.profile && !live(a.profile)) return true;
		const wants: Profile[] = a.profile === undefined ? [...PROFILES] : a.profile === "Public" ? ["Public", "Private"] : [a.profile];
		return read.rules.some((r) => r.action === "allow" && fits(r) && wants.some((p) => r.profiles.has(p)) && scoped(r, a, false));
	};
	if (!addresses.length ? !allowed({ profile: undefined }) : addresses.some((a) => !allowed(a))) {
		out.push(fw("fw_win_noallow", `No Windows Firewall rule allows incoming connections to TCP port ${port}, so a phone cannot connect. In an elevated PowerShell: \`${allowCommand(port)}\`. A port rule survives node upgrades, which a program rule does not.`, { port, command: allowCommand(port) }));
	}
	const publics = addresses.filter((a) => a.profile === "Public" && live("Public"));
	if (publics.length) {
		const where = publics.map((a) => `${a.address} (${a.iface})`).join(", ");
		out.push(fw("fw_win_public", `Windows calls the network of ${where} Public, which blocks incoming connections: Settings, Network & internet, Wi-Fi, the network, Network profile type, Private.`, { where }));
	}
	return out;
}
/** The note for a read that failed: the state is unknown, so both commands are given. */
export const windowsUnknown = (port: number, why: string) =>
	`Windows Firewall could not be read (${why}). If a phone cannot connect, in an elevated PowerShell allow the port with \`${allowCommand(port)}\`, and list rules that block node.exe with \`${listCommand}\`; disable one by its InstanceID with \`Disable-NetFirewallRule -Name '<InstanceID>'\`.`;

async function readWindows(input: FirewallInput, execPath: string, exec: FirewallExec, env: NodeJS.ProcessEnv, realpath: (path: string) => string): Promise<FirewallRead> {
	if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error(`not a port: ${input.port}`);
	const { file, args, options } = windowsCommand(env);
	try {
		let real: string | undefined;
		try { real = realpath(execPath); } catch { /* a path that cannot be resolved is compared as it is */ }
		const read = parseWindows(await exec(file, args, options)), coded = windowsCoded(read, input, execPath, real), notes = texts(coded);
		return { notes, coded, summary: `Windows Firewall: ${read.rules.length} enabled inbound rules read, ${notes.length} note${notes.length === 1 ? "" : "s"}` };
	} catch (error) {
		const e = error as Error & { stderr?: string };
		// Our own parse failure has a plain message; a failed run is told by `execFailure`, and Constrained Language Mode by its sentence.
		const why = e.stderr !== undefined || (e as { code?: unknown }).code !== undefined || (e as { killed?: boolean }).killed ? reasonOf(error, options.timeout) : e.message.slice(0, 160);
		const clm = why.includes(CLM_WORD) ? CLM_TEXT : why;
		return { notes: [windowsUnknown(input.port, clm)], coded: [fw("fw_win_unknown", windowsUnknown(input.port, clm), { why: clm, port: input.port, allow: allowCommand(input.port), list: listCommand })], summary: `Windows Firewall: the state could not be read (${clm})` };
	}
}
