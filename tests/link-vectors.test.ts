import assert from "node:assert/strict";
import { createDecipheriv, createHmac, createPublicKey, hkdfSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CanonError, dec, enc, readBool, readInt } from "../src/link/canon.ts";
import { CONTEXT, openSealedKey, requestBytes, sealKey, signBytes } from "../src/link/crypto.ts";
import { base32, deviceFromSeeds, encodeKeyRecord, keyRecordHash, labelOk, type DeviceKeys } from "../src/link/device.ts";
import { buildEnvelope, decodeEnvelope, encodeEnvelope, encodeHeader, openEnvelope } from "../src/link/envelope.ts";
import { BIP39_ENGLISH, BIP39_ENGLISH_SHA256 } from "../src/link/bip39-english.ts";
import { buildJoinRequest, checkJoiner, decodeInvite, encodeInvite, inviteHash, openJoinRequest, safetyWords, type Invite } from "../src/link/join.ts";
import { decodePlaintext, encodePlaintext, KINDS, type Kind } from "../src/link/kinds.ts";
import { decodeEntry, encodeEntry, entryHash, replayEncoded } from "../src/link/roster.ts";
import { encodeTyped, generateVectors, VECTORS_PATH, type Typed } from "./link/generate-vectors.ts";
import type { StateSpec } from "./link/envelope-cases.ts";
import type { ReceiveState } from "../src/link/envelope.ts";

// Replays tests/link/vectors.json against the library, using the file's own inputs: this is what a Go implementation has to reproduce.

const V = JSON.parse(readFileSync(VECTORS_PATH, "utf8")), h = (s: string) => Buffer.from(s, "hex");
const dev = (name: string): DeviceKeys => deviceFromSeeds(h(V.devices[name].signSeed), h(V.devices[name].boxSeed));
const TEAM = h(V.team), key = (n: number) => h(V.teamKeys[n]);

test("the committed file is what the generator produces, byte for byte", () => {
	assert.equal(readFileSync(VECTORS_PATH, "utf8"), JSON.stringify(generateVectors(), null, "\t") + "\n");
});

test("contexts, canonical encoding, base32, labels, and devices", () => {
	assert.deepEqual(V.contexts, CONTEXT);
	for (const c of V.canon) assert.equal(enc(...(c.fields as Typed[]).map(encodeTyped)).toString("hex"), c.hex, c.name);
	for (const c of V.canonInvalid) {
		const read = () => {
			const f = dec(h(c.hex), c.count ?? undefined);
			if (c.read === "int") readInt(f[0]!);
			if (c.read === "bool") readBool(f[0]!);
		};
		assert.throws(read, CanonError, c.name);
	}
	for (const b of V.base32) assert.equal(base32(h(b.hex)), b.text);
	for (const l of V.labels.valid) assert.equal(labelOk(l), true, l);
	for (const l of V.labels.invalid) assert.equal(labelOk(l), false, l);
	for (const [name, d] of Object.entries(V.devices) as [string, Record<string, string>][]) {
		const k = dev(name);
		assert.deepEqual([k.id, k.shortId, k.signPub.toString("hex"), k.boxPub.toString("hex"), encodeKeyRecord(k).toString("hex"), keyRecordHash(k).toString("hex")], [d.id, d.shortId, d.signPub, d.boxPub, d.keyRecord, d.keyRecordHash], name);
	}
});

test("sealed keys: the bytes open for the recipient only, in that team and epoch; a fresh seal with the same ephemeral seed matches", () => {
	for (const s of V.seals) {
		const to = dev(s.recipient), open = (who: DeviceKeys, epoch: number, team = TEAM) => openSealedKey({ team, epoch, sealed: h(s.sealed), boxKey: who.boxKey, boxPub: who.boxPub })?.toString("hex") ?? null;
		assert.equal(open(to, s.epoch), s.key);
		assert.equal(open(to, s.epoch), s.opens[s.recipient]);
		assert.equal(open(Object.keys(V.devices).map(dev).find((d) => d.id !== to.id)!, s.epoch), s.opens.wrongRecipient);
		assert.equal(open(to, s.epoch + 1), s.opens.wrongEpoch);
		assert.equal(open(to, s.epoch, Buffer.alloc(16, 1)), s.opens.wrongTeam);
		assert.equal(sealKey({ team: TEAM, epoch: s.epoch, key: h(s.key), recipientBoxPub: to.boxPub, ephemeralSeed: h(s.ephemeralSeed) }).toString("hex"), s.sealed);
	}
});

test("a relay request signature covers context, team, method, path, time, and the body's hash", () => {
	const r = V.request;
	const bytes = requestBytes({ team: h(r.team), method: r.method, path: r.path, time: r.time, body: h(r.body) });
	assert.equal(bytes.toString("hex"), r.signed);
	assert.equal(signBytes(dev(r.signer).signKey, bytes).toString("hex"), r.sig);
});

test("every kind's plaintext encodes to the vector's bytes and decodes back", () => {
	assert.deepEqual(V.kinds.map((k: { kind: string }) => k.kind), Object.keys(KINDS));
	for (const k of V.kinds) {
		const value = k.kind === "presence" ? { ...k.value, headHash: h(k.value.headHash) } : k.value;
		assert.equal(encodePlaintext(k.kind as Kind, value).toString("hex"), k.plaintext, k.kind);
		assert.deepEqual(decodePlaintext(k.kind as Kind, h(k.plaintext)), value, k.kind);
		assert.deepEqual(k.rule, KINDS[k.kind as Kind]);
	}
});

test("envelopes: built from the inputs they reproduce the bytes, and an independent reading with plain Node crypto agrees", () => {
	for (const e of V.envelopes) {
		const built = buildEnvelope({ team: h(e.team), epoch: e.epoch, teamKey: h(e.teamKey), head: { seq: e.head.seq, hash: h(e.head.hash) }, from: dev(e.from), seq: e.seq, ts: e.ts, kind: e.kind, to: e.to, plaintext: h(e.plaintext), id: h(e.id), nonce: h(e.nonce) });
		assert.equal(encodeHeader(built.header).toString("hex"), e.header);
		assert.equal(built.header.ephemeral, e.ephemeral);
		assert.equal(encodeEnvelope(built).toString("hex"), e.envelope);
		assert.deepEqual(decodeEnvelope(h(e.envelope)), built);
		// Second reading: signature over context ‖ team ‖ header ‖ nonce ‖ ct, and the AEAD with the header as associated data.
		const signPub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: h(V.devices[e.from].signPub).toString("base64url") }, format: "jwk" });
		const message = Buffer.concat([Buffer.from("straw-link/envelope/1"), h(e.team), h(e.header), h(e.nonce), h(e.ct)]);
		assert.equal(verify(null, message, signPub, h(e.sig)), true);
		const d = createDecipheriv("chacha20-poly1305", h(e.teamKey), h(e.nonce), { authTagLength: 16 });
		d.setAAD(h(e.header), { plaintextLength: h(e.ct).length - 16 });
		d.setAuthTag(h(e.ct).subarray(-16));
		assert.equal(Buffer.concat([d.update(h(e.ct).subarray(0, -16)), d.final()]).toString("hex"), e.plaintext);
		const fields = dec(h(e.header), 12);
		assert.equal(readInt(fields[0]!), 1);
		assert.equal(fields[5]!.toString(), V.devices[e.from].id);
	}
});

const roster = (entries: string[], self?: string) => replayEncoded(TEAM, entries.map(h), { self: self ? dev(self) : undefined, keys: self === "alice" ? new Map([[1, key(1)]]) : undefined });

test("roster: the honest log replays to the stated head and members, and every entry survives its encoding", () => {
	const r = roster(V.roster.log, "alice");
	assert.ok(r.ok);
	V.roster.log.forEach((x: string, i: number) => {
		const e = decodeEntry(h(x));
		assert.equal(encodeEntry(e).toString("hex"), x);
		assert.deepEqual({ seq: e.seq, hash: entryHash(e).toString("hex") }, V.roster.heads[i]);
	});
	assert.equal(r.value.epoch, V.roster.final.epoch);
	assert.equal(r.value.epochStart, V.roster.final.epochStart);
	assert.deepEqual([...r.value.members.values()].map((m) => ({ id: m.record.id, role: m.role, attended: m.attended, label: m.label })).sort((a, b) => (a.id < b.id ? -1 : 1)), V.roster.final.members);
	assert.deepEqual([...r.value.banned], V.roster.final.banned);
});

test("roster: every invalid log fails with the named reason at the named position", () => {
	assert.ok(V.roster.invalid.length >= 40);
	for (const c of V.roster.invalid) {
		const r = roster(c.entries, c.self ?? undefined);
		assert.ok(!r.ok, c.name);
		if (!r.ok) assert.deepEqual({ reason: r.reason, seq: r.seq }, { reason: c.reason, seq: c.seq }, c.name);
	}
});

test("envelope receive cases: ok or the named reason", () => {
	assert.ok(V.receive.length >= 40);
	for (const c of V.receive) {
		const s: StateSpec = c.state, r = roster(V.roster.log.slice(0, s.entries));
		assert.ok(r.ok);
		const state: ReceiveState = { team: TEAM, self: dev(s.self).id, roster: r.value, now: s.now, keys: new Map(Object.entries(s.keys).map(([e, k]) => [Number(e), h(k)])), lastSeq: new Map(Object.entries(s.lastSeq)), lastEphemeral: new Map(Object.entries(s.lastEphemeral)) };
		const o = openEnvelope(decodeEnvelope(h(c.envelope)), state);
		assert.equal(o.ok ? "ok" : o.reason, c.expect, c.name);
	}
});

test("joining: invite text, join request, the word list and safety words, and the joiner's checks", () => {
	const j = V.join, inv = (i: Record<string, string>): Invite => ({ relay: i.relay!, team: h(i.team!), secret: h(i.secret!), inviterId: i.inviterId!, inviterKeyHash: h(i.inviterKeyHash!), forDevice: i.forDevice! });
	assert.equal(encodeInvite(inv(j.invite)), j.invite.text);
	assert.deepEqual(decodeInvite(j.invite.text), inv(j.invite));
	assert.equal(inviteHash(h(j.invite.secret)).toString("hex"), j.invite.inviteHash);
	assert.deepEqual(decodeInvite(j.pinnedInvite.text), inv(j.pinnedInvite));
	for (const t of j.invalidInvites) assert.equal(decodeInvite(t), null, t.slice(0, 24));
	const r = j.request, blob = buildJoinRequest({ team: h(r.team), secret: h(r.secret), record: dev(r.joiner), label: r.label, nonce: h(r.nonce) });
	assert.equal(blob.toString("hex"), r.blob);
	const opened = openJoinRequest({ team: h(r.team), secret: h(r.secret), blob });
	assert.ok(opened.ok && opened.label === r.label && opened.record.id === V.devices[r.joiner].id);
	// An independent reading of the key: HKDF-SHA256 of the secret, info "straw-link/join-key/1" ‖ team, and the MAC as HMAC-SHA256.
	const k = Buffer.from(hkdfSync("sha256", h(r.secret), Buffer.alloc(0), Buffer.concat([Buffer.from("straw-link/join-key/1"), h(r.team)]), 32));
	const d = createDecipheriv("chacha20-poly1305", k, h(r.nonce), { authTagLength: 16 }), ct = blob.subarray(12);
	d.setAAD(Buffer.alloc(0), { plaintextLength: ct.length - 16 });
	d.setAuthTag(ct.subarray(-16));
	const [rec, label, mac] = dec(Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]), 3);
	assert.equal(rec!.toString("hex"), V.devices[r.joiner].keyRecord);
	assert.equal(mac!.toString("hex"), createHmac("sha256", h(r.secret)).update(Buffer.concat([Buffer.from(CONTEXT.join), h(r.team), enc(rec!, label!)])).digest("hex"));
	for (const x of j.requestRefusals) assert.deepEqual(openJoinRequest({ team: TEAM, secret: h(x.secret), blob }), x.expect, x.name);
	assert.deepEqual(j.wordList, { count: 2048, sha256: BIP39_ENGLISH_SHA256, first: "abandon", last: "zoo" });
	assert.equal(BIP39_ENGLISH.length, 2048);
	for (const w of j.safetyWords) assert.deepEqual(safetyWords({ team: h(w.team), inviter: dev(w.inviter), joiner: dev(w.joiner), secret: h(w.secret) }), w.words);
	for (const c of j.joiner) {
		const x = checkJoiner({ invite: inv(c.invite), self: dev(c.self), entries: c.entries.map((e: string) => decodeEntry(h(e))), label: c.label ?? undefined });
		assert.equal(x.ok ? "ok" : x.reason, c.expect, c.name);
	}
	assert.ok(j.joiner.some((c: { expect: string }) => c.expect === "ok") && j.joiner.length >= 6);
});
