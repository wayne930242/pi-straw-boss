import assert from "node:assert/strict";
import { test } from "node:test";
import { CanonError } from "../src/link/canon.ts";
import { aeadOpen, aeadSeal, CONTEXT, openSealedKey, privateKeyOf, publicBytes, sealKey, signBytes, signedBytes, verifyBytes } from "../src/link/crypto.ts";
import { base32, decodeKeyRecord, deviceFromSeeds, encodeKeyRecord, labelOk, shortId } from "../src/link/device.ts";

const hex = (s: string) => Buffer.from(s, "hex");

test("the key conversions agree with RFC 8032 and RFC 7748", () => {
	const ed = privateKeyOf("ed25519", hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
	assert.equal(publicBytes(ed).toString("hex"), "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
	assert.equal(signBytes(ed, Buffer.alloc(0)).toString("hex"), "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
	assert.equal(publicBytes(privateKeyOf("x25519", hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"))).toString("hex"), "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
});

test("an id is 26 base32 characters of the signing key's hash, its short id the first 6, and its key record round-trips", () => {
	assert.equal(base32(hex("00")), "aa");
	assert.equal(base32(hex("ffffffffff")), "77777777");
	const d = deviceFromSeeds(Buffer.alloc(32, 1), Buffer.alloc(32, 2));
	assert.match(d.id, /^[a-z2-7]{26}$/);
	assert.equal(d.shortId, shortId(d.id));
	assert.equal(d.shortId.length, 6);
	assert.deepEqual(decodeKeyRecord(encodeKeyRecord(d)), { id: d.id, signPub: d.signPub, boxPub: d.boxPub });
	const forged = encodeKeyRecord({ ...d, id: "a".repeat(26) });
	assert.throws(() => decodeKeyRecord(forged), CanonError, "an id that is not the hash of the signing key");
});

test("a label is 1 to 40 characters of letters, digits, space, dot, underscore, and hyphen", () => {
	for (const ok of ["a", "Wei-Hung's".replace("'", ""), "mac mini 2.0_b", "x".repeat(40)]) assert.equal(labelOk(ok), true, ok);
	for (const bad of ["", "x".repeat(41), "a/b", "a\nb", " lead", "trail ", "café", "a\u202eb", 5]) assert.equal(labelOk(bad), false, String(bad));
});

test("sign and verify cover the context and the team; an AEAD opens only with its key, nonce, and associated data", () => {
	const d = deviceFromSeeds(Buffer.alloc(32, 1), Buffer.alloc(32, 2)), team = Buffer.alloc(16, 9);
	const msg = signedBytes(CONTEXT.envelope, team, Buffer.from("body")), sig = signBytes(d.signKey, msg);
	assert.equal(verifyBytes(d.signPub, msg, sig), true);
	assert.equal(verifyBytes(d.signPub, signedBytes(CONTEXT.roster, team, Buffer.from("body")), sig), false, "another context");
	assert.equal(verifyBytes(d.signPub, signedBytes(CONTEXT.envelope, Buffer.alloc(16, 8), Buffer.from("body")), sig), false, "another team");
	assert.equal(verifyBytes(d.signPub, msg, sig.subarray(1)), false);
	const key = Buffer.alloc(32, 3), nonce = Buffer.alloc(12, 4), ct = aeadSeal(key, nonce, Buffer.from("hi"), Buffer.from("aad"));
	assert.equal(aeadOpen(key, nonce, ct, Buffer.from("aad"))?.toString(), "hi");
	for (const [k, n, c, a] of [[Buffer.alloc(32, 5), nonce, ct, "aad"], [key, Buffer.alloc(12, 5), ct, "aad"], [key, nonce, ct, "aae"], [key, nonce, Buffer.concat([ct.subarray(0, 1), Buffer.from([ct[1]! ^ 1]), ct.subarray(2)]), "aad"]] as const)
		assert.equal(aeadOpen(k, n, c, Buffer.from(a)), null);
});

test("a sealed key opens for its recipient, in its team and epoch, and for nobody else", () => {
	const a = deviceFromSeeds(Buffer.alloc(32, 1), Buffer.alloc(32, 2)), b = deviceFromSeeds(Buffer.alloc(32, 3), Buffer.alloc(32, 4)), team = Buffer.alloc(16, 9), key = Buffer.alloc(32, 7);
	const sealed = sealKey({ team, epoch: 2, key, recipientBoxPub: a.boxPub });
	const open = (who: typeof a, t = team, epoch = 2, s = sealed) => openSealedKey({ team: t, epoch, sealed: s, boxKey: who.boxKey, boxPub: who.boxPub });
	assert.deepEqual(open(a), key);
	assert.equal(open(b), null);
	assert.equal(open(a, Buffer.alloc(16, 8)), null);
	assert.equal(open(a, team, 3), null);
	assert.equal(open(a, team, 2, sealed.subarray(0, 40)), null);
	assert.notDeepEqual(sealKey({ team, epoch: 2, key, recipientBoxPub: a.boxPub }), sealed, "a fresh ephemeral key every time");
});
