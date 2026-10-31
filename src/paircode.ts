import { createHash, randomBytes, randomInt } from "node:crypto";

// The short pairing code a person types into the installed app's entry (appentry.ts), beside the QR's long one-time link (remote.ts). 8 characters of 5 bits (40 bits) from an
// alphabet without I, L, O, and U, shown as ABCD EFGH (two groups of four with a space: a hyphen made people wonder whether to type it). Only a hash is kept. Five wrong codes void every waiting code and lock the typing until `issue` runs again, which only this computer's
// own commands do, so a device on the tailnet gets five guesses per code the boss asks for and cannot grind through the space.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", LENGTH = 8, MAX_MISSES = 5;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");
export type Typed = "ok" | "wrong" | "locked";
const SHAPE = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`);

/** What was typed, as the 8 characters it stands for: NFKC (full-width letters and digits, an ideographic space), every space, dash, and invisible mark dropped (a phone keyboard offers －, –, —, ‐), and the look-alikes I, L, O read as 1, 1, 0. */
export const cleaned = (text: string) => text.normalize("NFKC").toUpperCase().replace(/[\p{White_Space}\p{Pd}\p{Cf}\u2212]/gu, "").replace(/[IL]/g, "1").replace(/O/g, "0");
/** The typed text of a form post: the single `code` field, or the entry's eight boxes `c1` to `c8` joined (a page without script posts those). */
export const typedText = (form: URLSearchParams) => form.get("code") || Array.from({ length: LENGTH }, (_, i) => form.get(`c${i + 1}`) ?? "").join("");

/** `ms` is how long a code works, `max` how many wait at once (the oldest goes first). */
export function createTypedCodes(ms: number, max: number) {
	const codes = new Map<string, number>();
	let misses = 0;
	return {
		/** A new code; the five tries start over. */
		issue(): string {
			const code = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""), now = Date.now();
			for (const [old, until] of codes) if (until < now) codes.delete(old);
			codes.set(hash(code), now + ms);
			for (const old of codes.keys()) if (codes.size > max) codes.delete(old);
			misses = 0;
			return `${code.slice(0, 4)} ${code.slice(4)}`;
		},
		/** Uses `text` up if it is a waiting code (case, width, spaces, any dash, and the look-alikes O, I, and L are forgiven); a wrong one counts, and the fifth voids them all. */
		take(text: string): Typed {
			if (misses >= MAX_MISSES) return "locked";
			const code = cleaned(text), key = hash(code), until = SHAPE.test(code) ? (codes.get(key) ?? 0) : 0;
			codes.delete(key);
			if (until >= Date.now()) return "ok";
			if (++misses >= MAX_MISSES) codes.clear();
			return "wrong";
		},
		clear: () => codes.clear(),
	};
}

/** Wrong typed tries one peer address may make, and in all per issued code, on the LAN (docs/specs/2026-10-30-sb-gui-lan.md, "Codes and limits"). */
export const LAN_PEER_MISSES = 5, LAN_CODE_MISSES = 200;
/** A LAN code's two kinds are told apart by length: the QR's is 22 characters, the typed code at most 9 (with a hyphen if one is typed). */
const QR_MIN = 20;
export interface LanTaken { result: Typed; /** This peer's wrong tries so far, after a wrong one. */ misses?: number; /** Set when this wrong try was the one that voided every typed code: the number of peer addresses that guessed. */ voided?: number }

/**
 * The LAN's codes: one-time QR codes (128 bits) and typed codes (40 bits), `ms` each, at most `max` of each waiting. Each surface that shows codes (an overlay face, a tile) holds at most one unredeemed code, QR or typed:
 * minting another on the same surface voids the one before it. A QR code is never locked. A wrong typed try cannot say which code it aimed at, so it counts against every live typed code, each with counts of its own: five wrong tries
 * from one peer address lock that address out while any live code holds them, and 200 wrong tries from all peers void the code that has seen them. A newly issued code starts with no counts, and gives back none of another code's.
 * Only hashes are kept.
 */
export function createLanCodes(ms: number, max: number, now: () => number = Date.now) {
	type Tries = { until: number; surface: string; misses?: Map<string, number>; total?: number };
	const kinds = { qr: new Map<string, Tries>(), typed: new Map<string, Tries>() }, mine = new Map<string, { kind: "qr" | "typed"; key: string }>();
	const forget = (kind: "qr" | "typed", key: string) => {
		const held = kinds[kind].get(key);
		kinds[kind].delete(key);
		if (held && mine.get(held.surface)?.key === key) mine.delete(held.surface);
	};
	const mint = (kind: "qr" | "typed", surface: string, code: string) => {
		const was = mine.get(surface);
		if (was) forget(was.kind, was.key);
		for (const [old, v] of kinds[kind]) if (v.until < now()) forget(kind, old);
		const key = hash(code);
		kinds[kind].set(key, { until: now() + ms, surface, ...(kind === "typed" && { misses: new Map<string, number>(), total: 0 }) });
		mine.set(surface, { kind, key });
		for (const old of kinds[kind].keys()) if (kinds[kind].size > max) forget(kind, old);
	};
	const spend = (kind: "qr" | "typed", key: string) => {
		const until = kinds[kind].get(key)?.until ?? 0;
		forget(kind, key);
		return until >= now();
	};
	return {
		/** A new one-time QR code for `surface`. */
		qr(surface: string): string {
			const code = randomBytes(16).toString("base64url");
			mint("qr", surface, code);
			return code;
		},
		/** A new typed code for `surface`, with no wrong tries counted against it; the tries other codes have seen stay. */
		typed(surface: string): string {
			const code = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
			mint("typed", surface, code);
			return `${code.slice(0, 4)} ${code.slice(4)}`;
		},
		/** Which kind `text` is by its length, so a form post can carry either. */
		kindOf: (text: string): "qr" | "typed" => (text.replace(/\s/g, "").length >= QR_MIN ? "qr" : "typed"),
		/** Uses a QR code up; true when it was waiting and not expired. */
		takeQr: (text: string) => spend("qr", hash(text.trim())),
		takeTyped(text: string, peer: string): LanTaken {
			const live = [...kinds.typed.entries()].filter(([, v]) => v.until >= now());
			if (live.some(([, v]) => (v.misses!.get(peer) ?? 0) >= LAN_PEER_MISSES)) return { result: "locked" };
			const code = cleaned(text);
			if (SHAPE.test(code) && spend("typed", hash(code))) return { result: "ok" };
			let worst = 1, voided: number | undefined;
			for (const [key, v] of live) {
				const tries = (v.misses!.get(peer) ?? 0) + 1;
				v.misses!.set(peer, tries);
				worst = Math.max(worst, tries);
				if (++v.total! >= LAN_CODE_MISSES) (voided = Math.max(voided ?? 0, v.misses!.size), forget("typed", key));
			}
			return { result: "wrong", misses: worst, ...(voided !== undefined && { voided }) };
		},
		clear() {
			kinds.qr.clear();
			kinds.typed.clear();
			mine.clear();
		},
	};
}
