import { createHash, createPrivateKey, randomBytes, X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { execFileSyncExe } from "../exe.mjs";
import { renameInto } from "../server/record.ts";
import { issueCa, issueLeaf, type Constraints, type Validity } from "./x509.ts";

// The LAN CA: the policy for what the sb server signs, how long it lives, where it is kept, and what the phone is handed (docs/specs/2026-10-30-sb-gui-lan.md, "The LAN CA" and "Getting the phone to trust the CA").
// `x509.ts` writes the bytes; this file decides what goes in them. Nothing here listens, and nothing here makes a CA by itself: the caller makes one after the boss has read the warning.

export const CA_FILE = "lan-ca.json";
/** The names the public files carry, for the overlay's **f** key and the certificate page. */
export const CA_FILES = { profile: "straw-boss.mobileconfig", crt: "straw-boss-lan-ca.crt" } as const;
export const CA_MIME = { profile: "application/x-apple-aspen-config", crt: "application/x-x509-ca-cert" } as const;

const HOUR = 3_600_000, DAY = 24 * HOUR;
export const CA_DAYS = 2 * 365, LEAF_DAYS = 90, LEAF_RENEW_DAYS = 30, CA_WARN_DAYS = 60;
const NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** The private blocks the CA may sign for: all of RFC 1918, not the subnets present when the CA is made, since the CA follows the computer. */
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"];

/** What `lan-ca.json` holds. `name` is the computer's multicast DNS name without `.local`, or null when it could not be read: the CA then signs addresses only. */
export interface LanCa { v: 1; name: string | null; key: string; cert: string; created: string }

/** What reading this computer's name came to: a usable `name`, a name that fails the label check (`invalid`: the CA may go name-less), or no answer (`unreadable`: a hiccup, so no CA is made yet). */
export type LocalName = { name: string } | { invalid: string } | { unreadable: string };

/**
 * This computer's name for the CA: macOS `scutil --get LocalHostName` (by absolute path, since the server's PATH may lack /usr/sbin), elsewhere the computer name, lowercased and checked as a DNS label.
 * A program that cannot be run or times out is `unreadable`, as is scutil's exit 1 (the name is not set is told apart only by that, and a retry cannot hurt); only a name that was read and fails the check is `invalid`.
 */
export function localName(deps: { platform?: NodeJS.Platform; run?: (program: string, args: string[]) => string; hostname?: () => string } = {}): LocalName {
	const platform = deps.platform ?? process.platform;
	let raw: string;
	try {
		raw = platform === "darwin"
			? (deps.run ?? ((program, args) => String(execFileSyncExe(program, args, { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }))))("/usr/sbin/scutil", ["--get", "LocalHostName"])
			: (deps.hostname ?? hostname)();
	} catch (error) {
		return { unreadable: error instanceof Error ? error.message : String(error) };
	}
	const name = raw.trim().toLowerCase();
	return NAME.test(name) ? { name } : { invalid: raw.trim() };
}

/** The production constraint set: the exact name (`invalid` when there is none, so the DNS name form is constrained to nothing), no email address and no URI (`invalid`: Apple trusts S/MIME and code-signing leaves of a CA that leaves those forms free), every private IPv4 block, no IPv6 at all. */
export const productionConstraints = (name: string | undefined): Constraints => ({ dns: [name ? `${name}.local` : "invalid"], email: ["invalid"], uri: ["invalid"], ip: PRIVATE, excludedIp: ["::/0"] });

const parse = (cert: string) => new X509Certificate(cert);
const ms = (date: string) => Date.parse(date);
/** When the CA's certificate begins and ends, in milliseconds. */
export function caValidity(ca: Pick<LanCa, "cert">): Validity {
	const cert = parse(ca.cert);
	return { notBefore: ms(cert.validFrom), notAfter: ms(cert.validTo) };
}
/** The CA's certificate in DER: the one certificate the profile and the `.crt` hold. */
export const caDer = (ca: Pick<LanCa, "cert">): Buffer => parse(ca.cert).raw;

/** A new CA: two years from one hour before `now`, ECDSA P-256, subject `CN=Straw Boss LAN CA · <name>, O=pi-straw-boss` (no name: `CN=Straw Boss LAN CA`). */
export function createCa(name: string | undefined, now: number): LanCa {
	if (name !== undefined && !NAME.test(name)) throw new Error(`not a usable name: ${name}`);
	const from = now - HOUR, issued = issueCa({
		subject: { cn: name ? `Straw Boss LAN CA · ${name}` : "Straw Boss LAN CA", org: "pi-straw-boss" },
		validity: { notBefore: from, notAfter: from + CA_DAYS * DAY },
		constraints: productionConstraints(name),
	});
	return { v: 1, name: name ?? null, key: issued.keyPem, cert: issued.pem, created: new Date(now).toISOString() };
}

/** Where the CA is in its life: `ended` once its time has passed, `ending` in the last 60 days. */
export function caStatus(ca: Pick<LanCa, "cert">, now: number): { state: "ok" | "ending" | "ended"; daysLeft: number } {
	const left = caValidity(ca).notAfter - now;
	return { state: left <= 0 ? "ended" : left <= CA_WARN_DAYS * DAY ? "ending" : "ok", daysLeft: Math.max(0, Math.floor(left / DAY)) };
}

/** A leaf's lifetime if it were issued at `now`: 90 days from one hour before, never before the CA began or past its end; undefined once the CA has ended. */
export function leafWindow(ca: Pick<LanCa, "cert">, now: number): Validity | undefined {
	const caSpan = caValidity(ca), from = now - HOUR, notAfter = Math.min(from + LEAF_DAYS * DAY, caSpan.notAfter);
	return notAfter > now ? { notBefore: Math.max(from, caSpan.notBefore), notAfter } : undefined;
}
/** Whether a leaf that ends at `leafEnd` should be replaced: under 30 days left **and** a new one would end later (in the CA's last 30 days it would not, so it is issued once and not again every tick). */
export function leafNeedsRenewal(ca: Pick<LanCa, "cert">, leafEnd: number, now: number): boolean {
	const next = leafWindow(ca, now);
	return next !== undefined && leafEnd - now < LEAF_RENEW_DAYS * DAY && next.notAfter > leafEnd;
}

export interface Leaf { address: string; dns: string[]; certPem: string; keyPem: string; notBefore: number; notAfter: number }
/**
 * The leaf for one served address: `CN=<name>.local` with SAN the name and that address, or for a CA with no name SAN that address only and a subject that is no hostname: `CN=Straw Boss LAN (<address>)`. A new key every time. Throws when the CA has ended.
 * Not `CN=<address>` as the spec says (RVLAN3-F009): OpenSSL 3.x (Node 24's 3.5.9) reads a dotted CN as a DNS name when the leaf has no DNS SAN and checks it against the CA's permitted `invalid`, so a Node client refuses the leaf; the
 * space keeps the CN out of that check, and browsers ignore the CN either way.
 */
export function issueLeafFor(ca: LanCa, address: string, now: number): Leaf {
	const validity = leafWindow(ca, now);
	if (!validity) throw new Error("the LAN CA has ended");
	const dns = ca.name ? [`${ca.name}.local`] : [], issued = issueLeaf({ issuer: { certPem: ca.cert, keyPem: ca.key }, cn: dns[0] ?? `Straw Boss LAN (${address})`, dns, ip: [address], validity });
	return { address, dns, certPem: issued.pem, keyPem: issued.keyPem, ...validity };
}

/** What the boss compares with what the phone shows: the SHA-256's first 16 bytes as spaced uppercase pairs (Apple's and Android's format, 128 bits), and the full SHA-1 for Windows' import warning, as the groups of eight it shows. */
export function fingerprints(ca: Pick<LanCa, "cert">): { sha256: string; sha1: string; sha1Hex: string } {
	const der = caDer(ca), sha1Hex = createHash("sha1").update(der).digest("hex").toUpperCase();
	return {
		sha256: [...createHash("sha256").update(der).digest().subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(" "),
		sha1: sha1Hex.match(/.{8}/g)!.join(" "),
		sha1Hex,
	};
}

/** A UUID from a hash: the same CA always makes the same one and another CA another (`salt` tells the profile's two UUIDs apart). */
function uuidOf(ca: Pick<LanCa, "cert">, salt: string) {
	const hex = createHash("sha256").update(caDer(ca)).update(salt).digest("hex").toUpperCase();
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/**
 * The unsigned configuration profile for iOS: exactly one payload, a `com.apple.security.root` holding the CA in DER, and nothing else, so iOS shows Contains: Certificate, which the boss's check relies on.
 * Both identifiers are fixed per computer name and the UUIDs are new per CA, so a new CA's profile replaces the old one.
 */
export function mobileconfig(ca: LanCa): string {
	const id = `local.straw-boss.lan${ca.name ? `.${ca.name}` : ""}`, shown = ca.name ? ` · ${ca.name}` : "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>PayloadContent</key>
	<array>
		<dict>
			<key>PayloadCertificateFileName</key>
			<string>${CA_FILES.crt}</string>
			<key>PayloadContent</key>
			<data>${caDer(ca).toString("base64")}</data>
			<key>PayloadDisplayName</key>
			<string>${xml(`Straw Boss LAN CA${shown}`)}</string>
			<key>PayloadIdentifier</key>
			<string>${xml(id)}.ca</string>
			<key>PayloadType</key>
			<string>com.apple.security.root</string>
			<key>PayloadUUID</key>
			<string>${uuidOf(ca, "payload")}</string>
			<key>PayloadVersion</key>
			<integer>1</integer>
		</dict>
	</array>
	<key>PayloadDisplayName</key>
	<string>${xml(`Straw Boss LAN${shown}`)}</string>
	<key>PayloadIdentifier</key>
	<string>${xml(id)}</string>
	<key>PayloadOrganization</key>
	<string>pi-straw-boss</string>
	<key>PayloadRemovalDisallowed</key>
	<false/>
	<key>PayloadType</key>
	<string>Configuration</string>
	<key>PayloadUUID</key>
	<string>${uuidOf(ca, "profile")}</string>
	<key>PayloadVersion</key>
	<integer>1</integer>
</dict>
</plist>
`;
}
/** The `.crt` for Android, macOS, and Windows: the CA in DER, one certificate. */
export const crt = (ca: LanCa): Buffer => caDer(ca);

// Storage ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

export type CaLost = "missing" | "corrupt";
export interface ReadDeps { platform?: NodeJS.Platform; uid?: number | undefined }
const KEYS = ["v", "name", "key", "cert", "created"];
const one = (text: string, label: string) => text.split(`-----BEGIN ${label}-----`).length === 2;

/** The stored CA, or why there is none. A store that is present but unreadable, foreign-owned, a link, readable by group or others (POSIX), not a file, or not exactly the shape written is corrupt; only an absent file is missing. */
export function readCa(dir: string, deps: ReadDeps = {}): { ca: LanCa } | { lost: CaLost } {
	const file = join(dir, CA_FILE), platform = deps.platform ?? process.platform, uid = "uid" in deps ? deps.uid : process.getuid?.();
	let fd: number | undefined;
	try {
		try {
			if (lstatSync(file).isSymbolicLink()) return { lost: "corrupt" };
			fd = openSync(file, platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
		} catch (error) {
			return { lost: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "corrupt" };
		}
		const info = fstatSync(fd);
		if (!info.isFile() || (uid !== undefined && info.uid !== uid) || (platform !== "win32" && (info.mode & 0o077) !== 0)) return { lost: "corrupt" };
		return shaped(JSON.parse(readFileSync(fd, "utf8")));
	} catch {
		return { lost: "corrupt" };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}
function shaped(value: unknown): { ca: LanCa } | { lost: CaLost } {
	const v = value as Record<string, unknown> | null;
	if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join() !== [...KEYS].sort().join()) return { lost: "corrupt" };
	const { name, key, cert, created } = v;
	if (v.v !== 1 || !(name === null || (typeof name === "string" && NAME.test(name))) || typeof key !== "string" || typeof cert !== "string" || typeof created !== "string" || !Number.isFinite(Date.parse(created))) return { lost: "corrupt" };
	if (!one(key, "PRIVATE KEY") || !one(cert, "CERTIFICATE")) return { lost: "corrupt" };
	const x = parse(cert), privateKey = createPrivateKey(key);
	// The leaves are named from `name` and the CA's constraints permit only the name it was made with: a name the certificate does not carry would issue leaves no client accepts.
	if (x.subject.split("\n")[0] !== `CN=Straw Boss LAN CA${name === null ? "" : ` · ${name}`}`) return { lost: "corrupt" };
	if (!x.ca || privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" || !x.checkPrivateKey(privateKey)) return { lost: "corrupt" };
	return { ca: { v: 1, name, key, cert, created } };
}

/** Keeps the CA out of Time Machine: `tmutil addexclusion` marks the file itself, so the mark survives the rename. Only macOS has Time Machine. */
export function timeMachineExclude(path: string, platform: NodeJS.Platform = process.platform) {
	if (platform === "darwin") execFileSyncExe("/usr/bin/tmutil", ["addexclusion", path], { stdio: "ignore", timeout: 10_000 });
}
export interface WriteDeps {
	/** Called on the new temporary file after it exists (empty, mode 600) and before the key is written into it; a throw is logged and the file is still written. Default: `timeMachineExclude`. */
	exclude?: (path: string) => void;
	/** Gets `lan-ca-exclude` with the failure's `code`. */
	log?: (event: string, fields: Record<string, unknown>) => void;
}
let temps = 0;
/**
 * Writes `lan-ca.json` as `gui-secrets.json` is written: a new temporary file (`wx`, mode 600, a name no earlier file has) renamed into place. The temporary file is excluded from backup (`deps.exclude`) before the key bytes go into it,
 * so no backup taken between the write and the exclusion holds the key; every write (create, renew, reset) is a new file and gets the exclusion again.
 */
export function writeCa(dir: string, ca: LanCa, deps: WriteDeps = {}) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = join(dir, CA_FILE), temp = `${file}.${process.pid}.${temps++}.${randomBytes(4).toString("hex")}.tmp`;
	const fd = openSync(temp, "wx", 0o600);
	try {
		try {
			(deps.exclude ?? timeMachineExclude)(temp);
		} catch (error) {
			const e = error as { code?: unknown; status?: unknown };
			deps.log?.("lan-ca-exclude", { code: e.code ?? e.status ?? "failed" });
		}
		writeSync(fd, JSON.stringify(ca));
		closeSync(fd);
		renameInto(temp, file);
	} catch (error) {
		try { closeSync(fd); } catch {} // already closed
		rmSync(temp, { force: true });
		throw error;
	}
}
