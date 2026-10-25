// Straw Link's canonical encoding (docs/specs/2026-10-25-straw-link.md, Cryptography). Everything that is signed, MACed, hashed, or used as
// AEAD associated data is built here; JSON is only a wire wrapper and never what is signed.
//
//   structure = field*          field = length (4 bytes, big-endian) ‖ bytes
//   integer   = 8 bytes big-endian (as the bytes of one field)
//   list      = count (4 bytes, big-endian) ‖ item field* (as the bytes of one field)
//   bool      = 1 byte, 0 or 1 (as the bytes of one field)

/** A malformed or non-canonical encoding. */
export class CanonError extends Error {}

const MAX_FIELD = 0xffff_ffff;

/** A structure: each field behind its 4-byte big-endian length. */
export function enc(...fields: Uint8Array[]): Buffer {
	const parts: Uint8Array[] = [];
	for (const f of fields) {
		if (f.length > MAX_FIELD) throw new RangeError("field too long");
		const head = Buffer.alloc(4);
		head.writeUInt32BE(f.length);
		parts.push(head, f);
	}
	return Buffer.concat(parts);
}

/** An 8-byte big-endian unsigned integer; wrap it with `enc` as a field. */
export function int(n: number | bigint): Buffer {
	if (typeof n === "number" && !Number.isSafeInteger(n)) throw new RangeError("not a safe integer");
	const v = BigInt(n);
	if (v < 0n || v >= 2n ** 64n) throw new RangeError("not an unsigned 64-bit integer");
	const out = Buffer.alloc(8);
	out.writeBigUInt64BE(v);
	return out;
}

export const str = (s: string): Buffer => Buffer.from(s, "utf8");
export const bool = (b: boolean): Buffer => Buffer.from([b ? 1 : 0]);

/** A list: the item count, then each item as a field. An item that is itself a structure is `enc(...)`. */
export function list(items: Uint8Array[]): Buffer {
	const head = Buffer.alloc(4);
	head.writeUInt32BE(items.length);
	return Buffer.concat([head, enc(...items)]);
}

/** The fields of a structure; with `count`, exactly that many. Throws on a cut field, trailing bytes, or a different count. */
export function dec(bytes: Uint8Array, count?: number): Buffer[] {
	const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), out: Buffer[] = [];
	let at = 0;
	while (at < buf.length) {
		if (buf.length - at < 4) throw new CanonError("cut length");
		const n = buf.readUInt32BE(at);
		at += 4;
		if (buf.length - at < n) throw new CanonError("cut field");
		out.push(Buffer.from(buf.subarray(at, at + n)));
		at += n;
	}
	if (count !== undefined && out.length !== count) throw new CanonError(`expected ${count} fields, got ${out.length}`);
	return out;
}

export function readInt(field: Uint8Array): number {
	if (field.length !== 8) throw new CanonError("an integer is 8 bytes");
	const v = Buffer.from(field).readBigUInt64BE();
	if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CanonError("integer beyond 2^53 - 1");
	return Number(v);
}

export function readBool(field: Uint8Array): boolean {
	if (field.length !== 1 || field[0]! > 1) throw new CanonError("a bool is one byte, 0 or 1");
	return field[0] === 1;
}

/** Text as it travels; invalid UTF-8 comes out as U+FFFD, so reading never throws on text and a decoded string never differs from what a cut gives. */
export const readStr = (field: Uint8Array): string => Buffer.from(field).toString("utf8");

/** The items of a list field; the count has to match the items exactly. */
export function readList(field: Uint8Array): Buffer[] {
	if (field.length < 4) throw new CanonError("cut list");
	const count = Buffer.from(field.buffer, field.byteOffset, field.length).readUInt32BE(0);
	return dec(field.subarray(4), count);
}

/** Bytes of exactly `n`, or a CanonError naming `what`. */
export function exact(field: Uint8Array, n: number, what: string): Buffer {
	if (field.length !== n) throw new CanonError(`${what} is ${n} bytes`);
	return Buffer.from(field);
}

/** `text` cut to at most `bytes` UTF-8 bytes without splitting a character. */
export function cutBytes(text: string, bytes: number): string {
	const buf = Buffer.from(text, "utf8");
	if (buf.length <= bytes) return text;
	let end = bytes;
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
	return buf.subarray(0, end).toString("utf8");
}

/** `text` cut to at most `chars` characters (code points). */
export const cutChars = (text: string, chars: number): string => {
	const all = [...text];
	return all.length <= chars ? text : all.slice(0, chars).join("");
};
