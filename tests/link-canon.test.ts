import assert from "node:assert/strict";
import { test } from "node:test";
import { bool, CanonError, enc, dec, int, list, readBool, readInt, readList, readStr, str } from "../src/link/canon.ts";

// Straw Link's canonical encoding (docs/specs/2026-10-25-straw-link.md, Cryptography): 4-byte big-endian length per field, a list is a count and its items, integers are 8 bytes.

test("a structure is each field behind its 4-byte length, integers are 8 bytes big-endian, lists carry a count", () => {
	assert.equal(enc(str("ab"), int(258), bool(true)).toString("hex"), "00000002" + "6162" + "00000008" + "0000000000000102" + "00000001" + "01");
	assert.equal(list([str("a"), str("")]).toString("hex"), "00000002" + "00000001" + "61" + "00000000");
	assert.equal(enc().length, 0);
});

test("decoding returns the fields, and refuses anything not canonical", () => {
	const wire = enc(str("héllo"), int(7), list([str("x"), str("y")]), bool(false));
	const [s, n, l, b] = dec(wire, 4);
	assert.equal(readStr(s!), "héllo");
	assert.equal(readInt(n!), 7);
	assert.deepEqual(readList(l!).map(readStr), ["x", "y"]);
	assert.equal(readBool(b!), false);
	assert.throws(() => dec(wire, 3), CanonError, "a different field count");
	assert.throws(() => dec(Buffer.concat([wire, Buffer.from([0])]), 4), CanonError, "trailing bytes");
	assert.throws(() => dec(wire.subarray(0, wire.length - 1), 4), CanonError, "a cut field");
	assert.throws(() => dec(Buffer.from("ffffffff00", "hex")), CanonError, "a length past the end");
	assert.throws(() => readInt(Buffer.alloc(7)), CanonError);
	assert.throws(() => readBool(Buffer.from([2])), CanonError);
	assert.throws(() => readList(Buffer.from("0000000500000001", "hex")), CanonError, "a count larger than its items");
	assert.throws(() => readList(Buffer.concat([list([str("a")]), Buffer.from([0])])), CanonError, "trailing bytes after the items");
});

test("integers beyond 2^53 are refused, as are negative and fractional ones", () => {
	assert.equal(int(2n ** 40n).toString("hex"), "0000010000000000");
	for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 2n ** 64n]) assert.throws(() => int(bad), RangeError);
	assert.throws(() => readInt(Buffer.from("0020000000000000", "hex")), CanonError, "above 2^53 - 1 is not a safe integer");
});
