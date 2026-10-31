import { createHash, randomInt } from "node:crypto";

// The short pairing code a person types into the installed app's entry (appentry.ts), beside the QR's long one-time link (remote.ts). 8 characters of 5 bits (40 bits) from an
// alphabet without I, L, O, and U, shown as ABCD EFGH (two groups of four with a space: a hyphen made people wonder whether to type it). Only a hash is kept. Five wrong codes void every waiting code and lock the typing until `issue` runs again, which only this computer's
// own commands do, so a device on the tailnet gets five guesses per code the boss asks for and cannot grind through the space.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", LENGTH = 8, MAX_MISSES = 5;
const hash = (code: string) => createHash("sha256").update(code).digest("hex");
export type Typed = "ok" | "wrong" | "locked";

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
			const code = cleaned(text), key = hash(code), until = new RegExp(`^[${ALPHABET}]{${LENGTH}}$`).test(code) ? (codes.get(key) ?? 0) : 0;
			codes.delete(key);
			if (until >= Date.now()) return "ok";
			if (++misses >= MAX_MISSES) codes.clear();
			return "wrong";
		},
		clear: () => codes.clear(),
	};
}
