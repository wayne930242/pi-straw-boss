import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bool, enc, int, list, str } from "../../src/link/canon.ts";
import { CONTEXT, openSealedKey, requestBytes, sealKey, signBytes, sha256 } from "../../src/link/crypto.ts";
import { base32, encodeKeyRecord, keyRecordHash } from "../../src/link/device.ts";
import { buildEnvelope, encodeEnvelope, encodeHeader } from "../../src/link/envelope.ts";
import { BIP39_ENGLISH, BIP39_ENGLISH_SHA256 } from "../../src/link/bip39-english.ts";
import { buildJoinRequest, checkJoiner, encodeInvite, inviteHash, openJoinRequest, safetyWords, type Invite } from "../../src/link/join.ts";
import { encodePlaintext, KINDS, type Kind } from "../../src/link/kinds.ts";
import { addEntry, encodeEntry, entryHash } from "../../src/link/roster.ts";
import { envelopeCases, NOW, SAMPLE } from "./envelope-cases.ts";
import { rosterCases } from "./roster-cases.ts";
import { DEVICES, det, mainLog, TEAM, teamKey, view, type Who } from "./scenario.ts";

// Writes tests/link/vectors.json: every input and expected byte of Straw Link's core, from fixed keys, nonces, secrets, and times, so another
// implementation (the relay in Go) can replay it. `node tests/link/generate-vectors.ts` rewrites the file; tests/link-vectors.test.ts
// fails when the committed file differs from what this produces, and replays it against the library.

export const VECTORS_PATH = fileURLToPath(new URL("./vectors.json", import.meta.url));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const WHO = Object.keys(DEVICES) as Who[];

/** A canonical-encoding input: each field typed, so a replay builds the same bytes. */
export type Typed = { t: "str"; v: string } | { t: "int"; v: number } | { t: "bool"; v: boolean } | { t: "bytes"; v: string } | { t: "list"; v: Typed[] } | { t: "struct"; v: Typed[] };
export function encodeTyped(x: Typed): Buffer {
	switch (x.t) {
		case "str": return str(x.v);
		case "int": return int(x.v);
		case "bool": return bool(x.v);
		case "bytes": return Buffer.from(x.v, "hex");
		case "list": return list(x.v.map(encodeTyped));
		case "struct": return enc(...x.v.map(encodeTyped));
	}
}
const canonCases: { name: string; fields: Typed[] }[] = [
	{ name: "empty structure", fields: [] },
	{ name: "text, integer, bool, bytes", fields: [{ t: "str", v: "héllo 密碼" }, { t: "int", v: 258 }, { t: "bool", v: true }, { t: "bytes", v: "" }, { t: "bytes", v: "00ff" }] },
	{ name: "a list of text and a list of structures", fields: [{ t: "list", v: [{ t: "str", v: "a" }, { t: "str", v: "" }] }, { t: "list", v: [{ t: "struct", v: [{ t: "int", v: 1 }, { t: "str", v: "x" }] }] }, { t: "list", v: [] }] },
	{ name: "the largest integer a JavaScript number holds exactly", fields: [{ t: "int", v: Number.MAX_SAFE_INTEGER }] },
];

function plainJson(kind: Kind): unknown {
	const p = SAMPLE[kind];
	return kind === "presence" ? { ...SAMPLE.presence, headHash: hex(SAMPLE.presence.headHash) } : p;
}

const boardEntry = (n: number) => ({ id: `${n}`.padStart(16, "0"), workspace: "w", tab: "t", name: "n", now: "x", updated: NOW + n, items: [] as { t: string; done: boolean }[] });
/** The limits of a board's plaintext, as another implementation has to cut them: plaintext in, what a decoder gives back out (null for a structure it refuses). */
function boardCases() {
	const long = (n: number, c = "あ") => c.repeat(n);
	const full = { entries: [{ id: "0123456789abcdef", workspace: long(45), tab: long(45), name: long(45), now: long(130), updated: NOW, items: Array.from({ length: 10 }, (_, i) => ({ t: long(90), done: i % 2 === 0 })) }] };
	const cut = { entries: [{ ...full.entries[0]!, workspace: long(40), tab: long(40), name: long(40), now: long(120), items: full.entries[0]!.items.slice(0, 8).map((i) => ({ ...i, t: long(80) })) }] };
	// Built with the raw canonical encoders, not encodePlaintext (which cuts), so the plaintext really holds what the case says it cuts.
	const rawEntry = (e: { id: string; workspace: string; tab: string; name: string; now: string; updated: number; items: { t: string; done: boolean }[] }) =>
		enc(str(e.id), str(e.workspace), str(e.tab), str(e.name), str(e.now), int(e.updated), list(e.items.map((i) => enc(str(i.t), bool(i.done)))));
	const rawBoard = (entries: Parameters<typeof rawEntry>[0][]) => enc(list(entries.map(rawEntry)));
	const mk = (name: string, plaintext: Buffer, expect: unknown) => ({ name, plaintext: hex(plaintext), expect });
	const good = encodePlaintext("board", SAMPLE.board);
	const entryFields = (...extra: Buffer[]) => enc(str("0123456789abcdef"), str("w"), str("t"), str("n"), str("x"), int(NOW), list([]), ...extra);
	return [
		mk("an empty board", encodePlaintext("board", { entries: [] }), { entries: [] }),
		mk("a sample board", good, SAMPLE.board),
		mk("long labels, a long now, and too many items are cut", rawBoard(full.entries), cut),
		mk("26 entries are cut to 24", rawBoard(Array.from({ length: 26 }, (_, i) => boardEntry(i))), { entries: Array.from({ length: 24 }, (_, i) => boardEntry(i)) }),
		mk("a truncated entry", good.subarray(0, good.length - 3), null),
		mk("trailing bytes", Buffer.concat([good, Buffer.from([0])]), null),
		mk("an entry with a field too many", enc(list([entryFields(str("extra"))])), null),
		mk("an entry with a field missing", enc(list([enc(str("0123456789abcdef"), str("w"), str("t"), str("n"), str("x"), int(NOW))])), null),
		mk("an item whose done flag is 2", enc(list([enc(str("0123456789abcdef"), str("w"), str("t"), str("n"), str("x"), int(NOW), list([enc(str("a"), Buffer.from([2]))]))])), null),
	];
}

export function generateVectors() {
	const devices = Object.fromEntries(WHO.map((w) => {
		const d = DEVICES[w];
		return [w, { signSeed: hex(d.signSeed), boxSeed: hex(d.boxSeed), id: d.id, shortId: d.shortId, signPub: hex(d.signPub), boxPub: hex(d.boxPub), keyRecord: hex(encodeKeyRecord(d)), keyRecordHash: hex(keyRecordHash(d)) }];
	}));
	const log = mainLog(), logHex = log.map((e) => hex(encodeEntry(e)));
	const final = view(log);

	// Seals: a fixed ephemeral key each, and the way each fails to open.
	const sealCase = (to: Who, epoch: number, key: Buffer, seed: string) => {
		const ephemeralSeed = sha256(Buffer.from(seed)), sealed = sealKey({ team: TEAM, epoch, key, recipientBoxPub: DEVICES[to].boxPub, ephemeralSeed });
		const opens = (who: Who, ep: number, team = TEAM) => openSealedKey({ team, epoch: ep, sealed, boxKey: DEVICES[who].boxKey, boxPub: DEVICES[who].boxPub })?.toString("hex") ?? null;
		return { team: hex(TEAM), epoch, key: hex(key), recipient: to, ephemeralSeed: hex(ephemeralSeed), sealed: hex(sealed), opens: { [to]: opens(to, epoch), wrongRecipient: opens(WHO.find((w) => w !== to)!, epoch), wrongEpoch: opens(to, epoch + 1), wrongTeam: opens(to, epoch, Buffer.alloc(16, 1)) } };
	};

	// Envelopes built from inputs.
	const head = final.head;
	const built = (kind: Kind, from: Who, to: string[], seq: number, tag: string) => {
		const plaintext = encodePlaintext(kind, SAMPLE[kind] as never), id = sha256(Buffer.from(`id/${tag}`)).subarray(0, 16), nonce = sha256(Buffer.from(`n/${tag}`)).subarray(0, 12);
		const env = buildEnvelope({ team: TEAM, epoch: 3, teamKey: teamKey(3), head, from: DEVICES[from], seq, ts: NOW, kind, to, plaintext, id, nonce });
		return { team: hex(TEAM), epoch: 3, teamKey: hex(teamKey(3)), head: { seq: head.seq, hash: hex(head.hash) }, from, seq, ts: NOW, kind, to, plaintext: hex(plaintext), id: hex(id), nonce: hex(nonce), header: hex(encodeHeader(env.header)), ephemeral: env.header.ephemeral, ct: hex(env.ct), sig: hex(env.sig), envelope: hex(encodeEnvelope(env)) };
	};

	// A join: alice invites mallory; a pinned invite for dave's id.
	const secret = Buffer.alloc(32, 0x5c), invite: Invite = { relay: "https://link.example.org", team: TEAM, secret, inviterId: DEVICES.alice.id, inviterKeyHash: keyRecordHash(DEVICES.alice), forDevice: "" };
	const inviteJson = (i: Invite) => ({ relay: i.relay, team: hex(i.team), secret: hex(i.secret), inviterId: i.inviterId, inviterKeyHash: hex(i.inviterKeyHash), forDevice: i.forDevice });
	const reqNonce = Buffer.alloc(12, 7), blob = buildJoinRequest({ team: TEAM, secret, record: DEVICES.mallory, label: "new-laptop", nonce: reqNonce });
	const opened = openJoinRequest({ forDevice: "", team: TEAM, secret, blob });
	const joinedLog = [...log, addEntry({ state: view(log), signer: DEVICES.alice, record: DEVICES.mallory, label: "new-laptop", attended: true, ...det("add-new") })];
	const viaBob = [...log, addEntry({ state: view(log), signer: DEVICES.bob, record: DEVICES.mallory, label: "new-laptop", attended: true, ...det("add-new") })];
	const joiner = (name: string, i: Invite, entries: typeof log, label?: string) => {
		const r = checkJoiner({ invite: i, self: DEVICES.mallory, entries, label });
		return { name, invite: inviteJson(i), self: "mallory", entries: entries.map((e) => hex(encodeEntry(e))), label: label ?? null, expect: r.ok ? "ok" : r.reason };
	};
	const requestOf = { team: TEAM, method: "POST", path: "/v1/teams/abc/envelopes?x=1", time: NOW, body: Buffer.from('{"a":1}') };

	return {
		format: 1,
		choices: [
			"A list is one length-prefixed field holding a 4-byte count followed by each item as a field (so every value is a field).",
			"A device id is the lower-case RFC 4648 base32 of sha256(signing public key)[0..16], no padding: 26 characters. It is written as its ASCII text in key records and headers.",
			"Context ‖ team ‖ ... is plain concatenation of the context's ASCII bytes, the 16 team bytes, then the rest.",
			"The first epoch is 1. A roster entry's hash (prev, head hash) is sha256 of its full encoding including the signature; create's prev is 32 zero bytes.",
			"HKDF-SHA256 uses an empty salt. A seal is enc(ephemeral public key, ciphertext ‖ tag) with AEAD associated data empty and a zero nonce. A label or table under a team key is nonce ‖ ciphertext ‖ tag with associated data 'straw-link/labels/1' ‖ team ‖ 8-byte epoch.",
			"A join request is nonce ‖ AEAD(join key, enc(key record, label, mac)) with empty associated data; mac = HMAC-SHA256(secret, 'straw-link/join/1' ‖ team ‖ enc(key record, label)).",
			"A relay request signs 'straw-link/request/1' ‖ team ‖ enc(method, path with query, time, sha256(body)).",
			"A failed replay reports the position of the entry in the log (the index equals its seq in an honest log).",
		],
		notes: "Straw Link core vectors (docs/specs/2026-10-25-straw-link.md). All bytes are hex. Integers are 8-byte big-endian inside a length-prefixed field; a list is a field holding count ‖ item fields. See src/link/*.ts for the reference implementation; where the spec leaves a choice, vectors fix it.",
		contexts: CONTEXT,
		canon: canonCases.map((c) => ({ name: c.name, fields: c.fields, hex: hex(enc(...c.fields.map(encodeTyped))) })),
		canonInvalid: [
			{ name: "a cut length", hex: "000000", count: null },
			{ name: "a cut field", hex: "0000000500", count: null },
			{ name: "a different field count", hex: hex(enc(str("a"), str("b"))), count: 3 },
			{ name: "an integer of 7 bytes read as an integer", hex: "00000007" + "00".repeat(7), count: 1, read: "int" },
			{ name: "a bool of 2", hex: hex(enc(Buffer.from([2]))), count: 1, read: "bool" },
		],
		base32: [{ hex: "00", text: "aa" }, { hex: "ffffffffff", text: "77777777" }, { hex: "0123456789abcdef0123456789abcdef", text: base32(Buffer.from("0123456789abcdef0123456789abcdef", "hex")) }],
		devices,
		labels: {
			valid: ["a", "mac mini 2.0_b", "x".repeat(40)],
			invalid: ["", "x".repeat(41), "a/b", "a\nb", " lead", "trail ", "café"],
		},
		team: hex(TEAM),
		teamKeys: { 1: hex(teamKey(1)), 2: hex(teamKey(2)), 3: hex(teamKey(3)) },
		seals: [sealCase("bob", 1, teamKey(1), "seal-1"), sealCase("carol", 3, teamKey(3), "seal-2")],
		request: { team: hex(TEAM), method: requestOf.method, path: requestOf.path, time: requestOf.time, body: hex(requestOf.body), signed: hex(requestBytes(requestOf)), signer: "alice", sig: hex(signBytes(DEVICES.alice.signKey, requestBytes(requestOf))) },
		kinds: (Object.keys(KINDS) as Kind[]).map((kind) => ({ kind, rule: KINDS[kind], value: plainJson(kind), plaintext: hex(encodePlaintext(kind, SAMPLE[kind] as never)) })),
		boardCases: boardCases(),
		limits: [
			{ kind: "tower", field: "text", unit: "bytes", max: 192 * 1024 },
			{ kind: "confirm-request", field: "args", unit: "characters", max: 12_000 },
			{ kind: "unit-status", field: "report", unit: "bytes", max: 4096 },
			{ kind: "notice", field: "text", unit: "bytes", max: 1024 },
			{ kind: "board", field: "entries", unit: "entries", max: 24 },
			{ kind: "board", field: "workspace, tab, name", unit: "characters", max: 40 },
			{ kind: "board", field: "now", unit: "characters", max: 120 },
			{ kind: "board", field: "items", unit: "items", max: 8 },
			{ kind: "board", field: "item text", unit: "characters", max: 80 },
		],
		envelopes: [built("tower", "alice", [DEVICES.bob.id], 1, "tower"), built("presence", "alice", [], 0, "presence"), built("board", "alice", [], 0, "board"), built("dialog-open", "dave", [DEVICES.alice.id, DEVICES.bob.id], 4, "dialog")],
		receive: envelopeCases().map((c) => ({ name: c.name, envelope: hex(c.envelope), state: c.state, expect: c.expect })),
		roster: {
			log: logHex,
			heads: log.map((e) => ({ seq: e.seq, hash: hex(entryHash(e)) })),
			final: { epoch: final.epoch, epochStart: final.epochStart, members: [...final.members.values()].map((m) => ({ id: m.record.id, role: m.role, attended: m.attended, label: m.label })).sort((a, b) => (a.id < b.id ? -1 : 1)), banned: [...final.banned] },
			invalid: rosterCases().map((c) => ({ name: c.name, entries: c.entries.map(hex), self: c.self ?? null, reason: c.reason, seq: c.seq })),
		},
		join: {
			invite: { ...inviteJson(invite), text: encodeInvite(invite), inviteHash: hex(inviteHash(secret)) },
			pinnedInvite: { ...inviteJson({ ...invite, forDevice: DEVICES.dave.id }), text: encodeInvite({ ...invite, forDevice: DEVICES.dave.id }) },
			invalidInvites: [encodeInvite(invite).replace("strawlink1:", "strawlink2:"), encodeInvite(invite) + "A", "strawlink1:", encodeInvite({ ...invite, relay: "http://example.org" }), encodeInvite({ ...invite, forDevice: "nope" })],
			request: { team: hex(TEAM), secret: hex(secret), joiner: "mallory", label: "new-laptop", nonce: hex(reqNonce), blob: hex(blob), opens: opened.ok },
			requestRefusals: [
				{ name: "another secret", secret: hex(Buffer.alloc(32, 1)), forDevice: "", expect: openJoinRequest({ forDevice: "", team: TEAM, secret: Buffer.alloc(32, 1), blob }) },
				{ name: "an invite pinned to another device", secret: hex(secret), forDevice: DEVICES.dave.id, expect: openJoinRequest({ forDevice: DEVICES.dave.id, team: TEAM, secret, blob }) },
			],
			invalidIds: ["", "short", DEVICES.alice.id.toUpperCase(), DEVICES.alice.id + "a", DEVICES.alice.id.slice(0, 25) + "b", DEVICES.bob.id.slice(0, 25) + "7", DEVICES.alice.id.slice(0, 25) + "1"],
			safetyWords: [
				{ team: hex(TEAM), inviter: "alice", joiner: "mallory", secret: hex(secret), words: safetyWords({ team: TEAM, inviterKeyHash: keyRecordHash(DEVICES.alice), joiner: DEVICES.mallory, secret }) },
				{ team: hex(TEAM), inviter: "bob", joiner: "eve", secret: hex(Buffer.alloc(32, 1)), words: safetyWords({ team: TEAM, inviterKeyHash: keyRecordHash(DEVICES.bob), joiner: DEVICES.eve, secret: Buffer.alloc(32, 1) }) },
			],
			wordList: { count: BIP39_ENGLISH.length, sha256: BIP39_ENGLISH_SHA256, first: BIP39_ENGLISH[0], last: BIP39_ENGLISH.at(-1) },
			joiner: [
				joiner("the roster of the inviter", invite, joinedLog, "new-laptop"),
				joiner("an add signed by another member", invite, viaBob),
				joiner("an inviter key record that does not match the QR", { ...invite, inviterKeyHash: keyRecordHash(DEVICES.bob) }, joinedLog),
				joiner("a label that is not the one asked for", invite, joinedLog, "another"),
				joiner("a roster without the joiner", invite, log),
				joiner("an invite pinned to another device", { ...invite, forDevice: DEVICES.dave.id }, joinedLog),
			],
		},
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	writeFileSync(VECTORS_PATH, JSON.stringify(generateVectors(), null, "\t") + "\n");
	console.log(`wrote ${VECTORS_PATH}`);
}
