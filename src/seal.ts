import { createCipheriv, createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, type KeyObject, randomBytes } from "node:crypto";

// A secret's value never crosses intercom in the clear: the bridge of the session that owns a secret_drop dialog makes a key pair for that
// dialog, relays the public half with the dialog, and the GUI server seals the value to it (X25519 ECDH with a fresh server key per answer,
// HKDF-SHA256, AES-256-GCM). Only that bridge holds the private half, so a session that reads the channel (the broker hands every message
// to every capable session) sees only ciphertext. The dialog id, its digest, the answerId, and the bridge id are the GCM's associated data,
// so a ciphertext opens only for the answer it was made for. Keys are base64url of the 32 raw bytes; nothing here logs or stores anything.

/** What travels in place of a `value`: the server's one-time public key, the 96-bit IV, and the ciphertext with its 128-bit tag. */
export interface Sealed { v: 1; epk: string; iv: string; ct: string }
/** What a ciphertext is bound to. */
export interface Binding { id: string; digest: string; answerId: string; bridgeId: string }

const INFO = "pi-straw-boss/secret/1", B64 = /^[A-Za-z0-9_-]+$/, PUB = /^[A-Za-z0-9_-]{43}$/, IV = /^[A-Za-z0-9_-]{16}$/;
/** The largest ciphertext a secret (8 KiB of text, up to 4 bytes a character cut off at the byte limit) and its tag can make, as base64url. */
export const MAX_SEALED = Math.ceil(((8192 + 16) * 4) / 3) + 4;
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const aad = (x: Binding) => Buffer.from(JSON.stringify([INFO, x.id, x.digest, x.answerId, x.bridgeId]), "utf8");
const publicOf = (key: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: key }, format: "jwk" });
const keyFor = (shared: Buffer, server: string, bridge: string) => Buffer.from(hkdfSync("sha256", shared, Buffer.concat([Buffer.from(server, "base64url"), Buffer.from(bridge, "base64url")]), INFO, 32));

/** Whether `key` is the base64url of a 32-byte value (an X25519 public key's size); the curve accepts any 32 bytes. */
export const keyOk = (key: unknown): key is string => typeof key === "string" && PUB.test(key);
/** A fresh key pair for one dialog: the private half as an object that exports nowhere here, the public half as it is relayed. */
export function newKeys(): { pub: string; priv: KeyObject } {
	const { publicKey, privateKey } = generateKeyPairSync("x25519");
	return { pub: String(publicKey.export({ format: "jwk" }).x), priv: privateKey };
}

/** Seals `value` to the bridge's public key for one answer; throws when the key is not usable. */
export function seal(value: string, bridge: string, bind: Binding): Sealed {
	if (!keyOk(bridge)) throw new Error("not a public key");
	const { publicKey, privateKey } = generateKeyPairSync("x25519"), epk = String(publicKey.export({ format: "jwk" }).x), iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", keyFor(diffieHellman({ privateKey, publicKey: publicOf(bridge) }), epk, bridge), iv, { authTagLength: 16 });
	cipher.setAAD(aad(bind));
	return { v: 1, epk, iv: b64(iv), ct: b64(Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()])) };
}

/** What a relayed `sealed` has to look like before anything is computed from it. */
export const sealedOk = (s: unknown): s is Sealed => {
	const x = s as Sealed | null;
	return typeof x === "object" && x !== null && x.v === 1 && keyOk(x.epk) && typeof x.iv === "string" && IV.test(x.iv) && typeof x.ct === "string" && x.ct.length >= 22 && x.ct.length <= MAX_SEALED && B64.test(x.ct);
};

/** The value, or undefined when this is not the ciphertext for these keys and this binding (wrong key, altered, or made for another answer). */
export function open(sealed: unknown, priv: KeyObject, pub: string, bind: Binding): string | undefined {
	if (!sealedOk(sealed)) return undefined;
	try {
		const raw = Buffer.from(sealed.ct, "base64url"), decipher = createDecipheriv("aes-256-gcm", keyFor(diffieHellman({ privateKey: priv, publicKey: publicOf(sealed.epk) }), sealed.epk, pub), Buffer.from(sealed.iv, "base64url"), { authTagLength: 16 });
		decipher.setAAD(aad(bind));
		decipher.setAuthTag(raw.subarray(raw.length - 16));
		return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString("utf8");
	} catch {
		return undefined;
	}
}
