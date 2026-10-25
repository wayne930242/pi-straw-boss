import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BIP39_ENGLISH, BIP39_ENGLISH_SHA256 } from "../src/link/bip39-english.ts";
import { enc, str } from "../src/link/canon.ts";
import { aeadSeal, joinKey, joinMac } from "../src/link/crypto.ts";
import { encodeKeyRecord, keyRecordHash } from "../src/link/device.ts";
import { buildJoinRequest, checkJoiner, decodeInvite, encodeInvite, inviteHash, openJoinRequest, safetyWords, type Invite } from "../src/link/join.ts";
import { addEntry, createEntry, replayRoster, signEntry, type RosterEntry } from "../src/link/roster.ts";
import { DEVICES, det, LABELS, mainLog, TEAM, teamKey, view } from "./link/scenario.ts";

const D = DEVICES, SECRET = Buffer.alloc(32, 0x5c), RELAY = "https://link.example.org";
const invite = (over: Partial<Invite> = {}): Invite => ({ relay: RELAY, team: TEAM, secret: SECRET, inviterId: D.alice.id, inviterKeyHash: keyRecordHash(D.alice), forDevice: "", ...over });
const REQ_NONCE = Buffer.alloc(12, 7);

test("the word list is the BIP-39 English list: 2048 words, the published hash", () => {
	assert.equal(BIP39_ENGLISH.length, 2048);
	assert.equal(createHash("sha256").update(BIP39_ENGLISH.join("\n") + "\n").digest("hex"), BIP39_ENGLISH_SHA256);
	assert.deepEqual([BIP39_ENGLISH[0], BIP39_ENGLISH[1], BIP39_ENGLISH[2047]], ["abandon", "ability", "zoo"]);
	assert.equal(new Set(BIP39_ENGLISH).size, 2048);
});

test("the safety words are the first 44 bits of the transcript hash as 4 words, and move with every input", () => {
	const words = safetyWords({ team: TEAM, inviter: D.alice, joiner: D.mallory, secret: SECRET });
	const h = createHash("sha256").update("straw-link/safety/1").update(TEAM).update(keyRecordHash(D.alice)).update(encodeKeyRecord(D.mallory)).update(SECRET).digest();
	const bits = [...h.subarray(0, 6)].map((b) => b.toString(2).padStart(8, "0")).join("").slice(0, 44);
	assert.deepEqual(words, [0, 11, 22, 33].map((i) => BIP39_ENGLISH[parseInt(bits.slice(i, i + 11), 2)]));
	assert.equal(words.length, 4);
	const others = [
		safetyWords({ team: Buffer.alloc(16, 1), inviter: D.alice, joiner: D.mallory, secret: SECRET }),
		safetyWords({ team: TEAM, inviter: D.bob, joiner: D.mallory, secret: SECRET }),
		safetyWords({ team: TEAM, inviter: D.alice, joiner: D.eve, secret: SECRET }),
		safetyWords({ team: TEAM, inviter: D.alice, joiner: D.mallory, secret: Buffer.alloc(32, 1) }),
	];
	for (const o of others) assert.notDeepEqual(o, words);
});

test("an invite is strawlink1: and the base64url of its canonical fields, and only that decodes", () => {
	const text = encodeInvite(invite());
	assert.match(text, /^strawlink1:[A-Za-z0-9_-]+$/);
	assert.deepEqual(decodeInvite(text), invite());
	assert.deepEqual(decodeInvite(`  ${text}\n`), invite(), "pasted with whitespace around it");
	assert.deepEqual(decodeInvite(encodeInvite(invite({ forDevice: D.dave.id }))), invite({ forDevice: D.dave.id }));
	for (const bad of ["", "strawlink2:" + text.slice(11), text.slice(11), text + "A", text.slice(0, -4), text.slice(0, 20) + "!" + text.slice(21), encodeInvite(invite({ relay: "ftp://x" })), encodeInvite(invite({ relay: "http://example.org" })), encodeInvite(invite({ inviterId: "short" })), encodeInvite(invite({ forDevice: "nope" }))])
		assert.equal(decodeInvite(bad), null, bad.slice(0, 30));
	assert.ok(decodeInvite(encodeInvite(invite({ relay: "http://127.0.0.1:8080" }))), "a relay on this machine may be plain http");
	assert.equal(inviteHash(SECRET).length, 32);
});

test("a join request opens only with the invite secret, and carries the joiner's record and label", () => {
	const blob = buildJoinRequest({ team: TEAM, secret: SECRET, record: D.mallory, label: "new-laptop", nonce: REQ_NONCE });
	const opened = openJoinRequest({ team: TEAM, secret: SECRET, blob });
	assert.ok(opened.ok && opened.label === "new-laptop" && opened.record.id === D.mallory.id);
	assert.equal(openJoinRequest({ team: TEAM, secret: Buffer.alloc(32, 1), blob }).ok, false, "another secret");
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: Buffer.alloc(32, 1), blob }), { ok: false, reason: "bad-ciphertext" });
	assert.deepEqual(openJoinRequest({ team: Buffer.alloc(16, 2), secret: SECRET, blob }), { ok: false, reason: "bad-ciphertext" }, "another team");
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: Buffer.concat([blob.subarray(0, 20), Buffer.from([blob[20]! ^ 1]), blob.subarray(21)]) }), { ok: false, reason: "bad-ciphertext" });
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: blob.subarray(0, 5) }), { ok: false, reason: "bad-ciphertext" });
	assert.throws(() => buildJoinRequest({ team: TEAM, secret: SECRET, record: D.mallory, label: "bad/label" }), /label/);
});

test("the inviter refuses a request for another device, a banned id, a member, or a label a member has", () => {
	const state = view(mainLog()), mk = (record = D.mallory, label = "new-laptop") => buildJoinRequest({ team: TEAM, secret: SECRET, record, label, nonce: REQ_NONCE });
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: mk(), forDevice: D.dave.id, roster: state }), { ok: false, reason: "wrong-device" });
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: mk(D.eve), roster: state }), { ok: false, reason: "banned" });
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: mk(D.bob, "other") , roster: state }), { ok: false, reason: "already-member" });
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: mk(D.mallory, LABELS.alice), roster: state }), { ok: false, reason: "label-taken" });
	assert.equal(openJoinRequest({ team: TEAM, secret: SECRET, blob: mk(), forDevice: D.mallory.id, roster: state }).ok, true);
});

test("a join request whose MAC does not match its fields is refused even when it decrypts", () => {
	// Whoever holds the secret can encrypt; the MAC is what ties the record and the label together.
	const rec = encodeKeyRecord(D.mallory), nonce = REQ_NONCE;
	const forge = (label: string, macOf: string) => Buffer.concat([nonce, aeadSeal(joinKey(SECRET, TEAM), nonce, enc(rec, str(label), joinMac(SECRET, TEAM, enc(rec, str(macOf)))))]);
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: forge("one", "two") }), { ok: false, reason: "bad-mac" });
	assert.equal(openJoinRequest({ team: TEAM, secret: SECRET, blob: forge("one", "one") }).ok, true);
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: Buffer.concat([nonce, aeadSeal(joinKey(SECRET, TEAM), nonce, Buffer.from("junk"))]) }), { ok: false, reason: "bad-request" });
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: Buffer.concat([nonce, aeadSeal(joinKey(SECRET, TEAM), nonce, enc(Buffer.from("x"), str("l"), Buffer.alloc(32)))]) }), { ok: false, reason: "bad-record" });
	const bad = enc(rec, str("bad/label"), joinMac(SECRET, TEAM, enc(rec, str("bad/label"))));
	assert.deepEqual(openJoinRequest({ team: TEAM, secret: SECRET, blob: Buffer.concat([nonce, aeadSeal(joinKey(SECRET, TEAM), nonce, bad)]) }), { ok: false, reason: "bad-label" });
});

/** The main log plus alice's add of mallory under the invite. */
const joined = (inviter = D.alice) => {
	const log = mainLog(), state = view(log, D.alice);
	return [...log, addEntry({ state, signer: inviter, record: D.mallory, label: "new-laptop", attended: true, ...det("add-new") })];
};

test("the joiner accepts the roster when its add is signed by the QR's inviter and that inviter's key record matches", () => {
	const r = checkJoiner({ invite: invite(), self: D.mallory, entries: joined(), label: "new-laptop" });
	assert.ok(r.ok);
	assert.deepEqual(r.state.keys.get(3), teamKey(3));
	assert.equal(r.state.members.get(D.alice.id)!.label, LABELS.alice);
});

test("the joiner refuses every roster that is not its inviter's", () => {
	const log = joined(), fail = (over: Parameters<typeof checkJoiner>[0], reason: string) => assert.equal((checkJoiner(over) as { reason: string }).reason, reason);
	fail({ invite: invite(), self: D.mallory, entries: joined(D.bob) }, "inviter-mismatch");
	fail({ invite: invite({ inviterKeyHash: keyRecordHash(D.bob) }), self: D.mallory, entries: log }, "inviter-key-mismatch");
	fail({ invite: invite(), self: D.mallory, entries: log, label: "another" }, "label-mismatch");
	fail({ invite: invite(), self: D.mallory, entries: mainLog() }, "not-added");
	fail({ invite: invite({ forDevice: D.dave.id }), self: D.mallory, entries: log }, "wrong-device");
	fail({ invite: invite({ team: Buffer.alloc(16, 3) }), self: D.mallory, entries: log }, "bad-signature");
	// A relay-made team: the founder is the relay's own device, the add is signed by it, and the QR's inviter is not there.
	const relay = D.eve, fake: RosterEntry[] = [createEntry({ team: TEAM, founder: relay, label: "relay", teamKey: teamKey(1), ...det("fake") })];
	const fakeState = (replayRoster(TEAM, fake, { self: relay, keys: new Map([[1, teamKey(1)]]) }) as { ok: true; value: Parameters<typeof addEntry>[0]["state"] }).value;
	fake.push(addEntry({ state: fakeState, signer: relay, record: D.mallory, label: "new-laptop", attended: true, ...det("fake-add") }));
	fail({ invite: invite(), self: D.mallory, entries: fake }, "inviter-mismatch");
	// A relay that also claims the inviter's id with its own key: the key record cannot be formed.
	const forged = signEntry(TEAM, relay, { ...fake[1]!, by: D.alice.id });
	fail({ invite: invite(), self: D.mallory, entries: [fake[0]!, forged] }, "signer-not-member");
});
