import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEnvelope, decodeEnvelope, encodeEnvelope, openEnvelope, parseEnvelope, receiveChecks, recordTaken, type Envelope } from "../src/link/envelope.ts";
import { decodePlaintext, encodePlaintext, KINDS, LIMITS, type Kind } from "../src/link/kinds.ts";
import { entryHash } from "../src/link/roster.ts";
import { baseState, envelopeCases, NOW, receiveState, SAMPLE } from "./link/envelope-cases.ts";
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

test("the envelope's signature binds the team: the same bytes do not verify under another team's context", () => {
	const e: Envelope = decodeEnvelope(envelopeCases()[0]!.envelope);
	const other = { ...receiveState(baseState()), team: Buffer.alloc(16, 5) };
	assert.deepEqual(openEnvelope(e, other), { ok: false, reason: "wrong-team" });
});
