import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnvelope, decodeEnvelope, encodeEnvelope, openEnvelope, parseEnvelope, receiveChecks, recordTaken, type Envelope } from "../src/link/envelope.ts";
import { decodePlaintext, encodePlaintext, KINDS, LIMITS, type Kind } from "../src/link/kinds.ts";
import { dec, enc } from "../src/link/canon.ts";
import { entryHash } from "../src/link/roster.ts";
import { ASK_ID, baseState, envelopeCases, NOW, receiveState, SAMPLE } from "./link/envelope-cases.ts";
import { DEVICES, mainLog, TEAM, teamKey } from "./link/scenario.ts";

// The envelope and its six receive checks (src/link/envelope.ts).

test("every case: a named reason, or ok, and an accepted envelope opens to its plaintext", () => {
	const cases = envelopeCases();
	assert.ok(cases.length >= 40);
	for (const c of cases) {
		const opened = openEnvelope(decodeEnvelope(c.envelope), receiveState(c.state));
		assert.equal(opened.ok ? "ok" : opened.reason, c.expect, c.name);
		if (opened.ok) assert.deepEqual(opened.message, SAMPLE[opened.header.kind as Kind], c.name);
	}
});

test("the receive checks alone give the same verdict as opening, for everything that is not about the signature or the ciphertext", () => {
	for (const c of envelopeCases()) {
		if (/signature|ciphertext|changed after signing|signed by another|encrypted under|plaintext|lacks/.test(c.name)) continue;
		const v = receiveChecks(decodeEnvelope(c.envelope).header, receiveState(c.state));
		assert.equal(v.ok ? "ok" : v.reason, c.expect, c.name);
	}
});

test("an envelope is built, signed, and encrypted from a kind; the kind fixes its ephemeral flag and an ephemeral one carries seq 0", () => {
	const log = mainLog(), head = { seq: 7, hash: entryHash(log[7]!) };
	const mk = (kind: Kind, seq: number, to: string[]) => buildEnvelope({ team: TEAM, epoch: 3, teamKey: teamKey(3), head, from: DEVICES.alice, seq, ts: NOW, kind, to, plaintext: encodePlaintext(kind, SAMPLE[kind] as never), id: Buffer.alloc(16, 1), nonce: Buffer.alloc(12, 2) });
	const queued = mk("tower", 9, [DEVICES.bob.id]), presence = mk("presence", 9, []);
	assert.deepEqual([queued.header.ephemeral, queued.header.seq, presence.header.ephemeral, presence.header.seq], [false, 9, true, 0]);
	assert.deepEqual(decodeEnvelope(encodeEnvelope(queued)), queued);
	assert.equal(openEnvelope(queued, receiveState(baseState())).ok, true);
	assert.throws(() => mk("tower", 1, []), /whole team/);
	assert.throws(() => buildEnvelope({ team: TEAM, epoch: 3, teamKey: teamKey(3), head, from: DEVICES.alice, seq: 1, ts: NOW, kind: "shout" as Kind, to: [], plaintext: Buffer.alloc(1) }), /unknown kind/);
});

test("taking an envelope moves the guards: the same queued seq, and an older ephemeral ts, are refused after", () => {
	const state = receiveState(baseState()), tower = decodeEnvelope(envelopeCases()[0]!.envelope);
	const after = recordTaken(state, tower.header);
	assert.equal(openEnvelope(tower, state).ok, true, "the state it came from is untouched");
	const again = openEnvelope(tower, after);
	assert.deepEqual(again, { ok: false, reason: "stale-seq" });
	const presence = decodeEnvelope(envelopeCases().find((c) => c.name.startsWith("a presence from"))!.envelope);
	const later = recordTaken(state, presence.header);
	assert.deepEqual(openEnvelope(presence, later), { ok: false, reason: "stale-ephemeral" });
	assert.equal(openEnvelope(tower, later).ok, true, "an ephemeral kind has no effect on queued messages");
});

test("a malformed envelope is no envelope", () => {
	assert.equal(parseEnvelope(Buffer.from("junk")), null);
	const good = envelopeCases()[0]!.envelope;
	assert.equal(parseEnvelope(good.subarray(0, good.length - 1)), null);
	assert.ok(parseEnvelope(good));
});

test("each kind's plaintext round-trips, is cut to its limit, and refuses another kind's bytes", () => {
	for (const kind of Object.keys(KINDS) as Kind[]) assert.deepEqual(decodePlaintext(kind, encodePlaintext(kind, SAMPLE[kind] as never)), SAMPLE[kind], kind);
	const long = "é".repeat(200_000), cut = decodePlaintext("tower", encodePlaintext("tower", { ...SAMPLE.tower, text: long }))!;
	assert.ok(Buffer.byteLength(cut.text) <= LIMITS.towerText && cut.text.length > 90_000 && !cut.text.includes("\ufffd"), "cut on a character boundary");
	const args = decodePlaintext("confirm-request", encodePlaintext("confirm-request", { ...SAMPLE["confirm-request"], args: "😀".repeat(13_000) }))!;
	assert.equal([...args.args].length, 12_000, "characters, not bytes");
	assert.equal(decodePlaintext("notice", encodePlaintext("notice", { ...SAMPLE.notice, text: "x".repeat(5000) }))!.text.length, 1024);
	assert.equal(decodePlaintext("notice", encodePlaintext("tower", SAMPLE.tower)), null);
	assert.equal(decodePlaintext("presence", Buffer.from("x")), null);
});

test("tower: the fifth field is written only when given, a 4-field tower stays 4 fields, and the fifth is read back", () => {
	assert.equal(dec(encodePlaintext("tower", SAMPLE.tower)).length, 4);
	const asked = { ...SAMPLE.tower, awaitsReply: ASK_ID };
	assert.equal(dec(encodePlaintext("tower", asked)).length, 5);
	assert.deepEqual(decodePlaintext("tower", encodePlaintext("tower", asked)), asked);
	assert.equal("awaitsReply" in decodePlaintext("tower", encodePlaintext("tower", SAMPLE.tower))!, false);
	assert.throws(() => encodePlaintext("tower", { ...SAMPLE.tower, awaitsReply: "nope" }), /ask id/);
	assert.throws(() => encodePlaintext("tower", { ...SAMPLE.tower, awaitsReply: "" }), /ask id/);
});

test("tower-reply: sending refuses an inReplyTo that is not an ask id, receiving only cuts it", () => {
	assert.throws(() => encodePlaintext("tower-reply", { inReplyTo: "nope", text: "ok" }), /ask id/);
	assert.throws(() => encodePlaintext("tower-reply", { inReplyTo: ASK_ID.toUpperCase(), text: "ok" }), /ask id/);
	assert.deepEqual(decodePlaintext("tower-reply", encodePlaintext("tower-reply", { inReplyTo: ASK_ID, text: "ok" })), { inReplyTo: ASK_ID, text: "ok" });
});

test("caps and tower-reply: rules, round trips, limits, and refusals", () => {
	assert.deepEqual(KINDS.caps, { ephemeral: true, wholeTeam: true, sender: "any" });
	assert.deepEqual(KINDS["tower-reply"], { ephemeral: false, wholeTeam: false, sender: "any" });
	const many = decodePlaintext("caps", encodePlaintext("caps", { features: Array.from({ length: 20 }, (_, i) => `f${i}`) }))!;
	assert.equal(many.features.length, LIMITS.capsFeatures);
	const long = decodePlaintext("tower-reply", encodePlaintext("tower-reply", { ...SAMPLE["tower-reply"], text: "é".repeat(200_000) }))!;
	assert.ok(Buffer.byteLength(long.text) <= LIMITS.towerText && !long.text.includes("\ufffd"));
	assert.equal(decodePlaintext("tower-reply", encodePlaintext("tower", SAMPLE.tower)), null);
	assert.equal(decodePlaintext("caps", encodePlaintext("tower-reply", SAMPLE["tower-reply"])), null);
});

test("SLH-F006: a presence is cut to 32 workspaces of 64 tabs each when it is decoded", () => {
	const tabs = Array.from({ length: 80 }, (_, i) => ({ label: `tab ${i}`, state: "idle" }));
	const presence = { ...SAMPLE.presence, workspaces: Array.from({ length: 50 }, (_, i) => ({ label: `ws ${i}`, tower: "idle", tabs })) };
	const back = decodePlaintext("presence", encodePlaintext("presence", presence))!;
	assert.equal(back.workspaces.length, LIMITS.presenceWorkspaces);
	assert.ok(back.workspaces.every((w) => w.tabs.length === LIMITS.presenceTabs));
	assert.equal(back.workspaces[0]!.tabs.at(-1)!.label, "tab 63");
});

test("the envelope's signature binds the team: the same bytes do not verify under another team's context", () => {
	const e: Envelope = decodeEnvelope(envelopeCases()[0]!.envelope);
	const other = { ...receiveState(baseState()), team: Buffer.alloc(16, 5) };
	assert.deepEqual(openEnvelope(e, other), { ok: false, reason: "wrong-team" });
});

test("a header is signed and decrypted as it was received, never as a re-encoding of what was read from it", () => {
	// Text that is not UTF-8 reads as U+FFFD, so a re-encoded header differs from the bytes the sender signed.
	const raw = encodeEnvelope(decodeEnvelope(envelopeCases()[0]!.envelope)), [head, nonce, ct, sig] = dec(raw, 4) as Buffer[], fields = dec(head!, 12);
	fields[5] = Buffer.from([0xff]);
	const odd = enc(enc(...fields), nonce!, ct!, sig!), e = decodeEnvelope(odd);
	assert.equal(e.header.from, "\ufffd");
	assert.equal(encodeEnvelope(e).toString("hex"), odd.toString("hex"));
});
