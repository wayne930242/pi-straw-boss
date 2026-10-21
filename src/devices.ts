import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { Identity } from "./remote.ts";

// The devices paired over Tailscale, and whether remote access is wanted on, kept in paired.json (mode 600) so they outlive a /reload, a restart,
// remote off and on, and a takeover. A device is only the SHA-256 of its cookie (the cookie itself is never stored) with when it was paired, last
// seen, and until when it counts. A pairing ends in three ways: the desktop unpairs it, the Tailscale identity it was paired under changes, or it
// goes unused for 90 days; every use renews it (the stored expiry moves at most once an hour, and that response re-issues the cookie).

export const SESSION_MS = 90 * 24 * 3600_000, RENEW_MS = 3600_000;
interface Device { until: number; label: string; paired: number; seen: number }
/** A paired device as the desktop page lists it: `id` is the start of its hash, enough to name it in an unpair. */
export interface Listed { id: string; label: string; paired: number; seen: number }

/** A short name for the device from its User-Agent (platform and browser), or "" when the header says neither. Raw header text is never kept. */
export function labelOf(ua = ""): string {
	const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
	const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
	return [os, browser].filter(Boolean).join(" · ");
}

export function createDevices(file?: string) {
	const devices = new Map<string, Device>();
	let identity: Identity | undefined, wanted = false;
	const num = (v: unknown, or: number) => (typeof v === "number" && Number.isFinite(v) ? v : or);
	try {
		const saved = file && JSON.parse(readFileSync(file, "utf8")), now = Date.now();
		if (saved?.host && saved.login) identity = { host: String(saved.host), login: String(saved.login) };
		wanted = saved?.wanted === true;
		// An older file kept only `sessions` (hash to expiry).
		const old = Object.entries(saved?.sessions ?? {}).map(([h, until]): [string, Record<string, unknown>] => [h, { until }]);
		for (const [h, d] of [...old, ...Object.entries<Record<string, unknown>>(saved?.devices ?? {})]) {
			const until = num(d?.until, 0);
			if (/^[0-9a-f]{64}$/.test(h) && until > now) devices.set(h, { until, label: typeof d.label === "string" ? d.label.slice(0, 80) : "", paired: num(d.paired, 0), seen: num(d.seen, 0) });
		}
	} catch {} // none saved
	const save = () => {
		if (!file) return;
		if (!identity || !(devices.size || wanted)) return rmSync(file, { force: true });
		writeFileSync(`${file}.tmp`, JSON.stringify({ ...identity, wanted, devices: Object.fromEntries(devices) }), { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	};
	return {
		/** The identity the saved devices were paired under, and whether remote access was left on. */
		get identity() { return identity; },
		get wanted() { return wanted; },
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
			return [...devices].map(([h, d]) => ({ id: h.slice(0, 16), label: d.label, paired: d.paired, seen: d.seen })).sort((a, b) => b.seen - a.seen);
		},
	};
}
