import assert from "node:assert/strict";
import { test } from "node:test";
import { keyOk, newKeys, open, seal, sealedOk } from "../src/seal.ts";

// The envelope a secret travels in (src/seal.ts): sealed to one dialog's key, bound to its dialog id, digest, answerId, and bridge.

const BIND = { id: "s1", digest: "d".repeat(64), answerId: "a".repeat(20), bridgeId: "bridge-1" };
const VALUE = "tok-seal-4417-not-in-the-clear";
const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);

test("a sealed value opens with the dialog's private key for the answer it was made for, and its envelope holds nothing readable", () => {
	const { pub, priv } = newKeys(), sealed = seal(VALUE, pub, BIND);
	assert.ok(keyOk(pub) && /^[A-Za-z0-9_-]{43}$/.test(pub), "a public key is 32 bytes as base64url");
	assert.deepEqual(Object.keys(sealed).sort(), ["ct", "epk", "iv", "v"]);
	assert.equal(sealedOk(sealed), true);
	assert.equal(JSON.stringify(sealed).includes(VALUE), false);
	assert.equal(open(sealed, priv, pub, BIND), VALUE);
	assert.equal(open(JSON.parse(JSON.stringify(sealed)), priv, pub, BIND), VALUE, "after a trip through JSON, as intercom carries it");
	assert.notDeepEqual(seal(VALUE, pub, BIND), sealed, "a fresh server key and IV every time");
	assert.equal(open(seal("ünïcode 密碼 🔐", pub, BIND), priv, pub, BIND), "ünïcode 密碼 🔐");
});

test("another key, a changed ciphertext, IV, or server key, and another dialog's binding are all refused", () => {
	const mine = newKeys(), other = newKeys(), sealed = seal(VALUE, mine.pub, BIND);
	assert.equal(open(sealed, other.priv, other.pub, BIND), undefined, "a session that holds another key pair");
	assert.equal(open(sealed, other.priv, mine.pub, BIND), undefined, "the right public key with the wrong private one");
	assert.equal(open({ ...sealed, ct: flip(sealed.ct) }, mine.priv, mine.pub, BIND), undefined, "tampered ciphertext");
	assert.equal(open({ ...sealed, ct: sealed.ct.slice(0, -4) }, mine.priv, mine.pub, BIND), undefined, "truncated: the tag is gone");
	assert.equal(open({ ...sealed, iv: flip(sealed.iv) }, mine.priv, mine.pub, BIND), undefined, "tampered IV");
	assert.equal(open({ ...sealed, epk: seal(VALUE, mine.pub, BIND).epk }, mine.priv, mine.pub, BIND), undefined, "another server key");
	for (const [what, bind] of [["dialog id", { ...BIND, id: "s2" }], ["digest", { ...BIND, digest: "e".repeat(64) }], ["answerId", { ...BIND, answerId: "b".repeat(20) }], ["bridge", { ...BIND, bridgeId: "bridge-2" }]] as const)
		assert.equal(open(sealed, mine.priv, mine.pub, bind), undefined, `a ciphertext made for another ${what}`);
});

test("keys and envelopes out of shape are refused before any computing", () => {
	const { pub, priv } = newKeys(), sealed = seal(VALUE, pub, BIND);
	for (const bad of [undefined, null, "", "short", `${pub}=`, `${pub}A`, pub.slice(1), 5, `${"+".repeat(43)}`]) assert.equal(keyOk(bad), false, String(bad));
	assert.throws(() => seal(VALUE, "short", BIND));
	assert.throws(() => seal(VALUE, undefined as never, BIND));
	for (const bad of [undefined, null, "x", 5, {}, { ...sealed, v: 2 }, { ...sealed, epk: "short" }, { ...sealed, iv: "short" }, { ...sealed, ct: "" }, { ...sealed, ct: "A".repeat(11_000) }, { ...sealed, ct: "not base64!" + sealed.ct }, { ...sealed, ct: 5 }])
		assert.equal(open(bad, priv, pub, BIND), undefined, JSON.stringify(bad)?.slice(0, 40));
	assert.equal(open({ ...sealed, epk: "A".repeat(43) }, priv, pub, BIND), undefined, "a small-order server key yields no secret");
});
