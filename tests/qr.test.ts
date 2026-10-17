import assert from "node:assert/strict";
import { test } from "node:test";
import { qr, qrLines } from "../src/qr.ts";
import { decode } from "./fakes.ts";

test("what the encoder draws decodes to the same text, from one block to many and with version information", () => {
	const pairing = `https://box.tail1.ts.net:8443/${"0123456789abcdef".repeat(2)}/pair/AbCdEfGhIjKlMnOpQrStUv`;
	for (const [text, version] of [["hi", 1], [pairing, 6], ["中文 QR 測試 ✓", 2], ["x".repeat(300), 13], ["y".repeat(1200), 29]] as const) {
		const m = qr(text), read = decode(m);
		assert.equal(m.length, version * 4 + 17, `${text.slice(0, 12)}: the smallest version`);
		assert.equal(read?.data, text);
		assert.equal(read?.version, version);
	}
	assert.throws(() => qr("z".repeat(3000)), /too long/);
});

test("the terminal form draws light modules as blocks, two rows per line, with the quiet zone", () => {
	const m = qr("hi"), lines = qrLines(m), n = m.length + 8;
	assert.equal(lines.length, Math.ceil(n / 2));
	assert.ok(lines.every((l) => [...l].length === n));
	assert.equal(lines[0], "█".repeat(n), "the quiet zone is light");
	assert.match(lines[2]!, /^████ ▄{5} /, "after four light modules, the finder: its dark top edge, and below it the light inner ring");
});
