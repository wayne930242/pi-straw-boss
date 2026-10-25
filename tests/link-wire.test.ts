import assert from "node:assert/strict";
import { test } from "node:test";
import { CHUNK, chunks, Reassembler } from "../src/link/wire.ts";

// The tower ↔ holder requests on `straw-boss/link`: pi-intercom refuses an extension payload over 16 KiB, so a body travels in chunks.

const sizeOf = (payload: unknown) => Buffer.byteLength(JSON.stringify(payload), "utf8");

test("a small body is one chunk; a 190 KB message is several, each well under the broker's 16 KiB payload limit, and they reassemble to the same body in any order", () => {
	const small = chunks("req", "holder", "r1", { op: "list" });
	assert.equal(small.length, 1);
	const body = { op: "send", device: "bob-mac", text: "知".repeat(60_000) + "x".repeat(10_000), reply: false };
	const parts = chunks("req", "holder", "r2", body);
	assert.ok(parts.length > 10, `${parts.length} chunks`);
	for (const part of parts) assert.ok(sizeOf(part) < 16 * 1024 - 1024, `${sizeOf(part)} bytes`);
	const r = new Reassembler();
	const order = [...parts.keys()].sort((a, b) => ((a * 7) % parts.length) - ((b * 7) % parts.length));
	let done: ReturnType<Reassembler["push"]>;
	for (const [n, i] of order.entries()) {
		done = r.push("tower-1", parts[i], 1000);
		if (n < order.length - 1) assert.equal(done, undefined);
	}
	assert.deepEqual(done, { reqId: "r2", body });
});

test("chunks of different senders or requests never mix, and a request completes once", () => {
	const a = chunks("req", "h", "same", { who: "a".repeat(20_000) }), b = chunks("req", "h", "same", { who: "b".repeat(20_000) });
	const r = new Reassembler();
	const out: unknown[] = [];
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		for (const [from, list] of [["s1", a], ["s2", b]] as const) {
			const got = r.push(from, list[i], 1);
			if (got) out.push(got.body);
		}
	}
	assert.deepEqual(out, [{ who: "a".repeat(20_000) }, { who: "b".repeat(20_000) }]);
	assert.equal(r.push("s1", a.at(-1), 1), undefined, "a repeated last chunk starts a new, incomplete request");
});

test("malformed chunks are ignored: a bad index, a count past 40, oversize data, a mismatching count, a body that is not JSON, one that is too large", () => {
	const r = new Reassembler();
	const ok = chunks("req", "h", "x", { a: 1 })[0]!;
	for (const bad of [{ ...ok, i: 1 }, { ...ok, n: 41 }, { ...ok, n: 0 }, { ...ok, data: "a".repeat(CHUNK + 1) }, { ...ok, reqId: "r".repeat(81) }, { ...ok, i: -1 }, { ...ok, data: 5 }, null, "text"]) assert.equal(r.push("s", bad, 1), undefined);
	assert.equal(r.push("s", { ...ok, data: Buffer.from("not json").toString("base64") }, 1), undefined);
	const first = chunks("req", "h", "m", { t: "x".repeat(CHUNK * 2) });
	assert.equal(r.push("s", first[0], 1), undefined);
	assert.equal(r.push("s", { ...first[1]!, n: first[1]!.n + 1 }, 1), undefined, "a chunk that disagrees about the count drops the request");
	assert.deepEqual(r.push("s", ok, 1), { reqId: "x", body: { a: 1 } });
});

test("a body that would need more than 40 chunks is refused when it is built, not lost on the way", () => {
	assert.throws(() => chunks("req", "h", "big", { text: "\u0001".repeat(190 * 1024) }), /too large/);
});

test("an incomplete request is forgotten after its time to live", () => {
	const r = new Reassembler(1000), parts = chunks("req", "h", "late", { t: "x".repeat(CHUNK * 2) });
	assert.ok(parts.length >= 3);
	assert.equal(r.push("s", parts[0], 0), undefined);
	const rest = parts.slice(1).map((p) => r.push("s", p, 5000));
	assert.ok(rest.every((x) => x === undefined), "the first part expired, so the others complete nothing");
	assert.equal(r.push("s", parts[0], 5001)?.reqId, "late", "with the first part sent again the request completes");
});
