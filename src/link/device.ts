import { randomBytes, type KeyObject } from "node:crypto";
import { CanonError, dec, enc, exact, readStr, str } from "./canon.ts";
import { equalBytes, privateKeyOf, publicBytes, sha256 } from "./crypto.ts";

// A device's identity (docs/specs/2026-10-25-straw-link.md, Terms): an Ed25519 signing key and an X25519 encryption key, a 26-character id
// derived from the signing key, and the key record the roster and the invite pin.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** RFC 4648 base32 in lower case, without padding. */
export function base32(bytes: Uint8Array): string {
	let out = "", acc = 0, bits = 0;
	for (const b of bytes) {
		acc = (acc << 8) | b;
		bits += 8;
		while (bits >= 5) out += ALPHABET[(acc >>> (bits - 5)) & 31], (bits -= 5);
		acc &= (1 << bits) - 1;
	}
	return bits ? out + ALPHABET[(acc << (5 - bits)) & 31] : out;
}

export const ID_CHARS = 26, SHORT_ID_CHARS = 6;
/** A device's id: the first 16 bytes of sha256(signing public key) in base32 (26 characters). */
export const deviceId = (signPub: Uint8Array): string => base32(sha256(signPub).subarray(0, 16));
export const shortId = (id: string): string => id.slice(0, SHORT_ID_CHARS);
export const idOk = (id: unknown): id is string => typeof id === "string" && /^[a-z2-7]{26}$/.test(id);

/** The public half of a device: what the roster stores and an invite pins. */
export interface KeyRecord { id: string; signPub: Buffer; boxPub: Buffer }
/** `enc(id, signing public key, encryption public key)`. */
export const encodeKeyRecord = (r: KeyRecord): Buffer => enc(str(r.id), r.signPub, r.boxPub);
/** A key record, or a CanonError when the bytes are malformed or the id is not the hash of the signing key. */
export function decodeKeyRecord(bytes: Uint8Array): KeyRecord {
	const [id, signPub, boxPub] = dec(bytes, 3) as [Buffer, Buffer, Buffer];
	const r = { id: readStr(id), signPub: exact(signPub, 32, "a signing key"), boxPub: exact(boxPub, 32, "an encryption key") };
	if (r.id !== deviceId(r.signPub)) throw new CanonError("the id is not the hash of the signing key");
	return r;
}
export const keyRecordHash = (r: KeyRecord): Buffer => sha256(encodeKeyRecord(r));

/** A device with its private keys. */
export interface DeviceKeys extends KeyRecord { shortId: string; signKey: KeyObject; boxKey: KeyObject; signSeed: Buffer; boxSeed: Buffer }

/** The device whose keys come from these two 32-byte seeds (the form `device.json` stores). */
export function deviceFromSeeds(signSeed: Uint8Array, boxSeed: Uint8Array): DeviceKeys {
	const signKey = privateKeyOf("ed25519", signSeed), boxKey = privateKeyOf("x25519", boxSeed), signPub = publicBytes(signKey).subarray();
	const id = deviceId(signPub);
	return { id, shortId: shortId(id), signPub: Buffer.from(signPub), boxPub: Buffer.from(publicBytes(boxKey)), signKey, boxKey, signSeed: Buffer.from(signSeed), boxSeed: Buffer.from(boxSeed) };
}
export const newDeviceKeys = (): DeviceKeys => deviceFromSeeds(randomBytes(32), randomBytes(32));
export const recordOf = (d: KeyRecord): KeyRecord => ({ id: d.id, signPub: d.signPub, boxPub: d.boxPub });
export const sameRecord = (a: KeyRecord, b: KeyRecord) => a.id === b.id && equalBytes(a.signPub, b.signPub) && equalBytes(a.boxPub, b.boxPub);

const LABEL = /^[A-Za-z0-9 ._-]{1,40}$/;
/** A label is 1 to 40 characters of ASCII letters, digits, space, `.`, `_`, `-`, with no space at either end (two labels differing by one would pass for each other). */
export const labelOk = (label: unknown): label is string => typeof label === "string" && LABEL.test(label) && label === label.trim();
