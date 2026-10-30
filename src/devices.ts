import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Identity } from "./remote.ts";

// The devices paired over Tailscale, and whether remote access is wanted on, kept in paired.json (mode 600) so they outlive a /reload and
// remote off and on and a restart (not a new GUI token: a device's cookie is scoped to the token, so the server unpairs every device when the token is new). A device is only the SHA-256 of its cookie (the cookie itself is never stored) with when it was paired, last
// seen, and until when it counts. A pairing ends in four ways: the GUI gets a new token, the desktop unpairs it, the Tailscale identity it was paired under changes, or it
// goes unused for 90 days; every use renews it (the stored expiry moves at most once an hour, and that response re-issues the cookie).

export const SESSION_MS = 90 * 24 * 3600_000, RENEW_MS = 3600_000;
interface Device { until: number; label: string; paired: number; seen: number }
/** A paired device as the desktop page lists it: `id` is the start of its hash, enough to name it in an unpair. `net` says which network it was paired on, and `host` (Wi-Fi access only) the name it uses to reach this computer. */
export interface Listed { id: string; label: string; paired: number; seen: number; net: "tailnet" | "lan"; host?: string }
const num = (v: unknown, or: number) => (typeof v === "number" && Number.isFinite(v) ? v : or);

/** A short name for the device from its User-Agent (platform and browser), or "" when the header says neither. Raw header text is never kept. */
export function labelOf(ua = ""): string {
	const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
	const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
	return [os, browser].filter(Boolean).join(" · ");
}

/** A temporary file of its own name, created new (`wx`): one that was already there (another account's, with its owner) is never written to and renamed into place (R8-F002). */
function writeOwned(file: string, text: string) {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, text, { mode: 0o600, flag: "wx" });
		renameSync(temp, file);
	} catch (failure) {
		rmSync(temp, { force: true });
		throw failure;
	}
}

export function createDevices(file?: string) {
	const devices = new Map<string, Device>();
	let identity: Identity | undefined, wanted = false, error: string | undefined;
	try {
		const saved = file && JSON.parse(readFileSync(file, "utf8")), now = Date.now();
		if (saved?.host && saved.login) identity = { host: String(saved.host), login: String(saved.login) };
		// An older file (0.32.1 and earlier) kept only `sessions` (hash to expiry) and was written only while remote was on, so one with devices and no wish says remote was on.
		const old = Object.entries(saved?.sessions ?? {}).map(([h, until]): [string, Record<string, unknown>] => [h, { until }]);
		wanted = saved?.wanted === true;
		for (const [h, d] of [...old, ...Object.entries<Record<string, unknown>>(saved?.devices ?? {})]) {
			const until = num(d?.until, 0);
			if (/^[0-9a-f]{64}$/.test(h) && until > now) devices.set(h, { until, label: typeof d.label === "string" ? d.label.slice(0, 80) : "", paired: num(d.paired, 0), seen: num(d.seen, 0) });
		}
		if (typeof saved?.wanted !== "boolean") wanted = devices.size > 0; // the older file: only a session still valid says remote was on
	} catch {} // none saved
	// A file that cannot be written (a full disk, a directory that went away) must not throw out of the request that changed the state: the
	// state stays in memory for this server's life, and `error` says what failed until a save works again.
	const save = () => {
		if (!file) return;
		try {
			if (!identity || !(devices.size || wanted)) rmSync(file, { force: true });
			else writeOwned(file, JSON.stringify({ ...identity, wanted, devices: Object.fromEntries(devices) }));
			error = undefined;
		} catch (e) {
			error = (e as Error).message;
		}
	};
	return {
		/** The identity the saved devices were paired under, and whether remote access was left on. */
		get identity() { return identity; },
		get wanted() { return wanted; },
		/** Why the last save failed (the devices are then kept in memory only), or undefined. */
		get error() { return error; },
		set(next: { identity?: Identity; wanted?: boolean }) {
			({ identity = identity, wanted = wanted } = next);
			save();
		},
		add(hash: string, label: string) {
			const now = Date.now();
			devices.set(hash, { until: now + SESSION_MS, label, paired: now, seen: now });
			save();
		},
		/** Whether `hash` is a paired device that has not expired. Every use is noted as seen; one not renewed for an hour is renewed, and `renewed` says the cookie should be issued again. */
		use(hash: string): { renewed: boolean } | undefined {
			const d = devices.get(hash), now = Date.now();
			if (!d) return undefined;
			if (d.until <= now) return void (devices.delete(hash), save());
			d.seen = now;
			const renewed = d.until - now < SESSION_MS - RENEW_MS;
			if (renewed) (d.until = now + SESSION_MS, save());
			return { renewed };
		},
		/** The hashes of the devices whose id starts with `id` (none for a prefix under 8 characters). */
		match: (id: string) => (id.length >= 8 ? [...devices.keys()].filter((h) => h.startsWith(id)) : []),
		/** The full hash of the one device whose id starts with `id`, now removed. */
		remove(id: string): string | undefined {
			const found = id.length >= 8 ? [...devices.keys()].filter((h) => h.startsWith(id)) : [];
			if (found.length !== 1) return undefined;
			devices.delete(found[0]!);
			save();
			return found[0];
		},
		clear(): number {
			const n = devices.size;
			devices.clear();
			if (n) save();
			return n;
		},
		list(): Listed[] {
			return [...devices].map(([h, d]): Listed => ({ id: h.slice(0, 16), label: d.label, paired: d.paired, seen: d.seen, net: "tailnet" })).sort((a, b) => b.seen - a.seen);
		},
	};
}

/** The port Wi-Fi access asks for first, and the one lan.json is not kept for on its own. */
export const LAN_PORT = 8445;
interface LanDevice extends Device { host: string }
export type Event = (name: string, fields: Record<string, unknown>) => void;

/**
 * The devices allowed over Wi-Fi access, in lan.json (docs/specs/2026-10-30-sb-gui-lan.md, "Devices"): `{ v: 1, wanted, port, token, devices }`, written like paired.json (mode 600, a new temporary file renamed into place), a device only the
 * SHA-256 of its cookie. `token` is the SHA-256 of the GUI token the devices were allowed under: a file whose `token` is not `tokenHash` loads with no device (`devices-cleared`), so a token a build without Wi-Fi access rotated cannot leave
 * them paired. Only allowed devices are written. The file is removed once it holds no device, Wi-Fi access is not wanted, and the port is the default one.
 */
export function createLanDevices(file: string | undefined, tokenHash: string, log: Event = () => {}) {
	const devices = new Map<string, LanDevice>();
	let wanted = false, port = LAN_PORT, error: string | undefined;
	let stale = false, dropped = false;
	try {
		const saved = file && JSON.parse(readFileSync(file, "utf8")), now = Date.now();
		if (saved?.v === 1) {
			wanted = saved.wanted === true;
			if (Number.isInteger(saved.port) && saved.port > 0 && saved.port < 65536) port = saved.port;
			for (const [h, d] of Object.entries<Record<string, unknown>>(saved.devices ?? {})) {
				const until = num(d?.until, 0);
				if (/^[0-9a-f]{64}$/.test(h) && until > now) devices.set(h, { until, label: typeof d.label === "string" ? d.label.slice(0, 80) : "", paired: num(d.paired, 0), seen: num(d.seen, 0), host: typeof d.host === "string" ? d.host.slice(0, 80) : "" });
			}
			if (saved.token !== tokenHash) (stale = true, dropped = devices.size > 0, devices.clear());
		}
	} catch {} // none saved
	const save = () => {
		if (!file) return;
		try {
			if (!devices.size && !wanted && port === LAN_PORT) rmSync(file, { force: true });
			else writeOwned(file, JSON.stringify({ v: 1, wanted, port, token: tokenHash, devices: Object.fromEntries(devices) }));
			error = undefined;
		} catch (e) {
			error = (e as Error).message;
		}
	};
	if (dropped) log("devices-cleared", { net: "lan" });
	if (stale) save(); // the file is written again under the running token
	return {
		get wanted() { return wanted; },
		/** The port Wi-Fi access asks for; the one it last bound on stays here even while it is off. */
		get port() { return port; },
		/** Why the last save failed (the devices are then kept in memory only), or undefined. */
		get error() { return error; },
		set(next: { wanted?: boolean; port?: number }) {
			({ wanted = wanted, port = port } = next);
			save();
		},
		add(hash: string, label: string, host: string) {
			const now = Date.now();
			devices.set(hash, { until: now + SESSION_MS, label, paired: now, seen: now, host });
			save();
		},
		/** Whether `hash` is an allowed device that has not expired; nothing is noted. */
		has: (hash: string) => (devices.get(hash)?.until ?? 0) > Date.now(),
		/** As `createDevices(…).use`: noted as seen, renewed at most once an hour (`renewed`). */
		use(hash: string): { renewed: boolean } | undefined {
			const d = devices.get(hash), now = Date.now();
			if (!d) return undefined;
			if (d.until <= now) return void (devices.delete(hash), save());
			d.seen = now;
			const renewed = d.until - now < SESSION_MS - RENEW_MS;
			if (renewed) (d.until = now + SESSION_MS, save());
			return { renewed };
		},
		match: (id: string) => (id.length >= 8 ? [...devices.keys()].filter((h) => h.startsWith(id)) : []),
		remove(id: string): string | undefined {
			const found = id.length >= 8 ? [...devices.keys()].filter((h) => h.startsWith(id)) : [];
			if (found.length !== 1) return undefined;
			devices.delete(found[0]!);
			save();
			return found[0];
		},
		clear(): number {
			const n = devices.size;
			devices.clear();
			if (n) save();
			return n;
		},
		list(): Listed[] {
			return [...devices].filter(([, d]) => d.until > Date.now()).map(([h, d]): Listed => ({ id: h.slice(0, 16), label: d.label, paired: d.paired, seen: d.seen, net: "lan", host: d.host })).sort((a, b) => b.seen - a.seen);
		},
	};
}
