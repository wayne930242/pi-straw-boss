import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bool, enc, int, list, str } from "../../src/link/canon.ts";
import { CONTEXT, openSealedKey, operateEphemeral, operateKeys, operateOpen, operateSeal, requestBytes, sealKey, signBytes, sha256 } from "../../src/link/crypto.ts";
import { base32, encodeKeyRecord, keyRecordHash } from "../../src/link/device.ts";
import { buildEnvelope, encodeEnvelope, encodeHeader } from "../../src/link/envelope.ts";
import { BIP39_ENGLISH, BIP39_ENGLISH_SHA256 } from "../../src/link/bip39-english.ts";
import { buildJoinRequest, checkJoiner, encodeInvite, inviteHash, openJoinRequest, safetyWords, type Invite } from "../../src/link/join.ts";
import { encodePlaintext, KINDS, operateBody, type Kind, type OperateMessage } from "../../src/link/kinds.ts";
import { addEntry, encodeEntry, entryHash } from "../../src/link/roster.ts";
import { ASK_ID, envelopeCases, HANDLE, NOW, operateJson, SAMPLE } from "./envelope-cases.ts";
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
	if (kind === "operate") return operateJson(SAMPLE.operate);
	return kind === "presence" ? { ...SAMPLE.presence, headHash: hex(SAMPLE.presence.headHash) } : p;
}

const boardEntry = (n: number) => ({ id: `${n}`.padStart(16, "0"), workspace: "w", tab: "t", name: "n", now: "x", updated: NOW + n, items: [] as { t: string; done: boolean }[] });
const HOLD_DEVICE = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const hold = (role: "holds" | "held", until?: number) => ({ device: HOLD_DEVICE, by: HANDLE, since: NOW, ...(until !== undefined ? { until } : {}), role });
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
		// Holds (docs/specs/2026-11-26-device-hold.md): the third field, beside an empty second field (no capacity row); a hold of a role this build does not know is left out, and a fourth field is refused.
		mk("holds beside an empty capacity field", encodePlaintext("board", { entries: [], holds: [hold("holds", NOW + 60_000), hold("held")] }), { entries: [], holds: [hold("holds", NOW + 60_000), hold("held")] }),
		mk("a hold of an unknown role is left out", enc(list([]), enc(), list([enc(str(HOLD_DEVICE), str(HANDLE), int(NOW), list([]), str("owns"))])), { entries: [] }),
		mk("a board of four fields", enc(list([]), enc(), list([]), enc()), null),
	];
}

/** `tower` with 4 fields (the old shape) and with the optional fifth, `awaitsReply`: plaintext in, what a decoder gives back out (null for a structure it refuses). */
function towerCases() {
	const mk = (name: string, plaintext: Buffer, expect: unknown) => ({ name, plaintext: hex(plaintext), expect });
	const four = [str("main"), str(""), bool(true), str("Please look.")];
	const base = { fromWorkspace: "main", toWorkspace: "", replyExpected: true, text: "Please look." };
	return [
		mk("four fields, as before the fifth existed", enc(...four), base),
		mk("five fields, the fifth an ask id", enc(...four, str(ASK_ID)), { ...base, awaitsReply: ASK_ID }),
		mk("a fifth field that is empty", enc(...four, str("")), null),
		mk("a fifth field that is not 32 lowercase hex digits", enc(...four, str(ASK_ID.toUpperCase())), null),
		mk("a fifth field of the wrong length", enc(...four, str(ASK_ID.slice(2))), null),
		mk("six fields", enc(...four, str(ASK_ID), str("x")), null),
		mk("three fields", enc(...four.slice(0, 3)), null),
		// The sixth field, a link wait (docs/specs/2026-11-21-box-mac-waits.md §2.3), written only to a device whose caps list tower.wait; the fifth may then be empty.
		mk("six fields, an ask and a wait", enc(...four, str(ASK_ID), wait(WAIT_ID, "open", "work-on", "merge !13", HANDLE)), { ...base, awaitsReply: ASK_ID, wait: { id: WAIT_ID, state: "open", owner: "work-on", what: "merge !13", handle: HANDLE } }),
		mk("six fields, no ask (an empty fifth) and a wait with no handle", enc(...four, str(""), wait(WAIT_ID, "told", "", "told work-on", "")), { ...base, wait: { id: WAIT_ID, state: "told", owner: "", what: "told work-on", handle: "" } }),
		mk("a wait's owner is cut to 40 characters and its what to one line of 200 bytes", enc(...four, str(""), wait(WAIT_ID, "open", "o".repeat(50), `a\nb${"x".repeat(300)}`, "")), { ...base, wait: { id: WAIT_ID, state: "open", owner: "o".repeat(40), what: `a b${"x".repeat(197)}`, handle: "" } }),
		mk("a wait with a state this build does not know", enc(...four, str(""), wait(WAIT_ID, "lost", "", "x", "")), null),
		mk("a wait whose id is not 32 lowercase hex digits", enc(...four, str(""), wait(WAIT_ID.toUpperCase(), "open", "", "x", "")), null),
		mk("a wait with a handle of 15 digits", enc(...four, str(""), wait(WAIT_ID, "open", "", "x", HANDLE.slice(1))), null),
		mk("a wait with four fields", enc(...four, str(""), enc(str(WAIT_ID), str("open"), str(""), str("x"))), null),
		mk("seven fields", enc(...four, str(""), wait(WAIT_ID, "open", "", "x", ""), str("x")), null),
	];
}
const WAIT_ID = "7a".repeat(16);
const wait = (id: string, state: string, owner: string, what: string, handle: string) => enc(str(id), str(state), str(owner), str(what), str(handle));

/** `caps` and `tower-reply` limits and refusals. */
function capsReplyCases() {
	const mk = (name: string, kind: Kind, plaintext: Buffer, expect: unknown) => ({ name, kind, plaintext: hex(plaintext), expect });
	return [
		mk("an empty caps", "caps", enc(list([])), { features: [] }),
		mk("caps cut to 32 features", "caps", enc(list(Array.from({ length: 34 }, (_, i) => str(`f${i}`)))), { features: Array.from({ length: 32 }, (_, i) => `f${i}`) }),
		mk("caps with a trailing field", "caps", enc(list([]), str("x")), null),
		mk("caps with a cut list", "caps", enc(Buffer.from([0, 0])), null),
		mk("a tower-reply", "tower-reply", enc(str(ASK_ID), str("ok")), { inReplyTo: ASK_ID, text: "ok" }),
		mk("a tower-reply with an id of 300 bytes is cut to 256", "tower-reply", enc(str("a".repeat(300)), str("ok")), { inReplyTo: "a".repeat(256), text: "ok" }),
		mk("a tower-reply with one field", "tower-reply", enc(str(ASK_ID)), null),
		mk("a tower-reply with three fields", "tower-reply", enc(str(ASK_ID), str("ok"), str("x")), null),
		// A notice's optional fourth field, the ask it is about (docs/specs/2026-11-21-box-mac-waits.md §4, C4), written only to a device whose caps list notice.ref.
		mk("a notice with three fields, as before the ref existed", "notice", enc(str("ally-run-ended"), str("Beta"), str("ended")), { kind: "ally-run-ended", unit: "Beta", text: "ended" }),
		mk("a notice with a ref", "notice", enc(str("inbox-stuck"), str("Beta"), str("waits"), str(ASK_ID)), { kind: "inbox-stuck", unit: "Beta", text: "waits", ref: ASK_ID }),
		mk("a notice whose ref is not an ask id", "notice", enc(str("inbox-stuck"), str("Beta"), str("waits"), str("x")), null),
		mk("a notice with five fields", "notice", enc(str("k"), str("u"), str("t"), str(ASK_ID), str("x")), null),
	];
}

/** `unit-stop` (a stop's ids, mode, and one-line reason) and `unit-status` with an optional second field `mains` (docs/specs/2026-11-07-link-remote-stop.md §3): plaintext in, what a decoder gives back out (null for a structure it refuses). */
function unitStopCases() {
	const mk = (name: string, kind: Kind, plaintext: Buffer, expect: unknown) => ({ name, kind, plaintext: hex(plaintext), expect });
	const stop = (id: string, handle: string, mode: string, reason: string) => enc(str(id), str(handle), str(mode), str(reason));
	const unit = enc(str("build"), str("working"), list([]), str("r")), units = list([unit]), unitJson = { unit: "build", state: "working", monitors: [] as string[], report: "r" };
	const main = (handle: string, name: string, stopping: boolean) => enc(str(handle), str("build"), str(name), str("idle"), str(DEVICES.alice.id), bool(stopping));
	const mainJson = (handle: string, name: string, stopping: boolean) => ({ handle, unit: "build", name, state: "idle", by: DEVICES.alice.id, stopping });
	return [
		mk("a unit-stop", "unit-stop", stop(ASK_ID, HANDLE, "quit", "forgotten idle main"), { stopId: ASK_ID, handle: HANDLE, mode: "quit", reason: "forgotten idle main" }),
		mk("a unit-stop with an empty reason", "unit-stop", stop(ASK_ID, HANDLE, "interrupt", ""), { stopId: ASK_ID, handle: HANDLE, mode: "interrupt", reason: "" }),
		mk("a unit-stop with a mode this build does not know is still decoded (the box refuses it)", "unit-stop", stop(ASK_ID, HANDLE, "kill", ""), { stopId: ASK_ID, handle: HANDLE, mode: "kill", reason: "" }),
		mk("a unit-stop reason is cut to 200 bytes", "unit-stop", stop(ASK_ID, HANDLE, "quit", "a".repeat(300)), { stopId: ASK_ID, handle: HANDLE, mode: "quit", reason: "a".repeat(200) }),
		mk("a unit-stop reason loses its line breaks", "unit-stop", stop(ASK_ID, HANDLE, "quit", "one\ntwo\r\tthree"), { stopId: ASK_ID, handle: HANDLE, mode: "quit", reason: "one two  three" }),
		mk("a unit-stop reason loses C1 controls (NEL, the 8-bit CSI)", "unit-stop", stop(ASK_ID, HANDLE, "quit", "x\u0085y\u009b31mz"), { stopId: ASK_ID, handle: HANDLE, mode: "quit", reason: "x y 31mz" }),
		mk("a unit-stop reason loses U+2028 and U+2029", "unit-stop", stop(ASK_ID, HANDLE, "quit", "a\u2028b\u2029c"), { stopId: ASK_ID, handle: HANDLE, mode: "quit", reason: "a b c" }),
		mk("a unit-stop reason loses bidi overrides, embeddings, and isolates", "unit-stop", stop(ASK_ID, HANDLE, "quit", "a\u202ab\u202ec\u2066d\u2069e\u200ef\u061cg"), { stopId: ASK_ID, handle: HANDLE, mode: "quit", reason: "a b c d e f g" }),
		mk("a unit-stop reason loses invisible characters", "unit-stop", stop(ASK_ID, HANDLE, "quit", "a\u200bb\u2060c\ufeffd\u00ade\u{e0041}f"), { stopId: ASK_ID, handle: HANDLE, mode: "quit", reason: "a b c d e f" }),
		mk("a unit-stop reason cut at 200 bytes inside a multibyte character keeps whole characters", "unit-stop", stop(ASK_ID, HANDLE, "quit", "a" + "中".repeat(80)), { stopId: ASK_ID, handle: HANDLE, mode: "quit", reason: "a" + "中".repeat(66) }),
		mk("a unit-stop with an upper-case stop id", "unit-stop", stop(ASK_ID.toUpperCase(), HANDLE, "quit", ""), null),
		mk("a unit-stop with a stop id of 31 digits", "unit-stop", stop(ASK_ID.slice(1), HANDLE, "quit", ""), null),
		mk("a unit-stop with a handle of 15 digits", "unit-stop", stop(ASK_ID, HANDLE.slice(1), "quit", ""), null),
		mk("a unit-stop with an upper-case handle", "unit-stop", stop(ASK_ID, HANDLE.toUpperCase(), "quit", ""), null),
		mk("a unit-stop with three fields", "unit-stop", enc(str(ASK_ID), str(HANDLE), str("quit")), null),
		mk("a unit-stop with five fields", "unit-stop", enc(str(ASK_ID), str(HANDLE), str("quit"), str(""), str("x")), null),
		mk("a unit-status with one field, as before mains existed", "unit-status", enc(units), { units: [unitJson] }),
		mk("a unit-status with two fields, the second the mains", "unit-status", enc(units, list([main(HANDLE, "docs", false), main("fedcba9876543210", "api", true)])), { units: [unitJson], mains: [mainJson(HANDLE, "docs", false), mainJson("fedcba9876543210", "api", true)] }),
		mk("a unit-status with an empty mains list", "unit-status", enc(units, list([])), { units: [unitJson], mains: [] }),
		mk("a unit-status cuts its mains to 20", "unit-status", enc(units, list(Array.from({ length: 22 }, (_, i) => main(HANDLE, `m${i}`, false)))), { units: [unitJson], mains: Array.from({ length: 20 }, (_, i) => mainJson(HANDLE, `m${i}`, false)) }),
		mk("a main name is cut to 40 characters", "unit-status", enc(units, list([main(HANDLE, "n".repeat(50), false)])), { units: [unitJson], mains: [mainJson(HANDLE, "n".repeat(40), false)] }),
		mk("a unit-status with three fields", "unit-status", enc(units, list([]), str("x")), null),
		mk("a unit-status with no field", "unit-status", enc(), null),
		mk("a main with five fields", "unit-status", enc(units, list([enc(str(HANDLE), str("build"), str("docs"), str("idle"), str(DEVICES.alice.id))])), null),
	];
}

/**
 * `operate` (docs/specs/2026-11-07-link-operate.md §5.2): the outer structure (plaintext in, what a decoder gives back out, null for a refusal; bytes as hex), the session key derivation
 * from fixed ephemeral seeds, and a frame's AEAD in both directions. The relay replays only `structure`.
 */
function operateCases() {
	const session = Buffer.alloc(16, 0x11), eph = Buffer.alloc(32, 0x22), hash = Buffer.alloc(32, 0x33);
	const mk = (name: string, plaintext: Buffer, expect: OperateMessage | null) => ({ name, plaintext: hex(plaintext), expect: expect === null ? null : operateJson(expect) });
	const outer = (v: number, sid: Buffer, type: string, body: Buffer) => enc(int(v), sid, str(type), body);
	const open: OperateMessage = { session, type: "open", eph, caps: ["operate/1"], want: "team" };
	const accept: OperateMessage = { session, type: "accept", eph, openHash: hash, scope: { teams: [TEAM], box: true }, limits: { mirrors: 2, watches: 4, budget: 900 } };
	const frame = (ctr: number, ct: Buffer): OperateMessage => ({ session, type: "frame", ctr, ct });
	const openBody = (e: Buffer, w: string) => enc(e, list([str("operate/1")]), str(w));
	const acceptBody = (e: Buffer, h: Buffer, ids: Buffer[]) => enc(e, h, enc(list(ids), bool(true)), enc(int(2), int(4), int(900)));
	const structure = [
		mk("an open", encodePlaintext("operate", open), open),
		mk("an open for the box", encodePlaintext("operate", { ...open, want: "box" }), { ...open, want: "box" }),
		mk("an accept", encodePlaintext("operate", accept), accept),
		mk("an accept naming no team", encodePlaintext("operate", { ...accept, scope: { teams: [], box: false } } as OperateMessage), { ...accept, scope: { teams: [], box: false } } as OperateMessage),
		mk("a refuse", encodePlaintext("operate", { session, type: "refuse", reason: "not-admin" }), { session, type: "refuse", reason: "not-admin" }),
		mk("a frame", encodePlaintext("operate", frame(1, Buffer.alloc(40, 7))), frame(1, Buffer.alloc(40, 7))),
		mk("a frame of 200 KB", outer(1, session, "frame", enc(int(2), Buffer.alloc(200 * 1024, 1))), frame(2, Buffer.alloc(200 * 1024, 1))),
		mk("a close", encodePlaintext("operate", { session, type: "close", reason: "roster" }), { session, type: "close", reason: "roster" }),
		mk("an open with 18 caps is cut to 16", outer(1, session, "open", enc(eph, list(Array.from({ length: 18 }, (_, i) => str(`c${i}`))), str("team"))), { ...open, caps: Array.from({ length: 16 }, (_, i) => `c${i}`) } as OperateMessage),
		mk("an accept with 10 teams is cut to 8", outer(1, session, "accept", acceptBody(eph, hash, Array.from({ length: 10 }, (_, i) => Buffer.alloc(16, i)))), { ...accept, scope: { teams: Array.from({ length: 8 }, (_, i) => Buffer.alloc(16, i)), box: true } } as OperateMessage),
		mk("version 2", outer(2, session, "open", openBody(eph, "team")), null),
		mk("a session id of 15 bytes", outer(1, session.subarray(1), "open", openBody(eph, "team")), null),
		mk("a type this build does not know", outer(1, session, "req", openBody(eph, "team")), null),
		mk("an open that wants neither team nor box", outer(1, session, "open", openBody(eph, "all")), null),
		mk("an open with an ephemeral key of 31 bytes", outer(1, session, "open", openBody(eph.subarray(1), "team")), null),
		mk("an open with a field too many", outer(1, session, "open", enc(eph, list([]), str("box"), str("x"))), null),
		mk("an accept with an open hash of 31 bytes", outer(1, session, "accept", acceptBody(eph, hash.subarray(1), [TEAM])), null),
		mk("an accept naming a team of 15 bytes", outer(1, session, "accept", acceptBody(eph, hash, [TEAM.subarray(1)])), null),
		mk("a frame with counter 0", outer(1, session, "frame", enc(int(0), Buffer.alloc(40))), null),
		mk("a frame too short to hold a tag", outer(1, session, "frame", enc(int(1), Buffer.alloc(15))), null),
		mk("a frame over 200 KB", outer(1, session, "frame", enc(int(1), Buffer.alloc(200 * 1024 + 1))), null),
		mk("a refuse with two fields", outer(1, session, "refuse", enc(str("a"), str("b"))), null),
		mk("trailing bytes after the structure", Buffer.concat([encodePlaintext("operate", open), Buffer.from([0])]), null),
	];
	// The key derivation: both ends from fixed ephemeral seeds, operator = alice, box = dave.
	const op = operateEphemeral(sha256(Buffer.from("operate-op"))), box = operateEphemeral(sha256(Buffer.from("operate-box")));
	const common = { team: TEAM, session, operator: DEVICES.alice.id, box: DEVICES.dave.id, ephOp: op.pub, ephBox: box.pub };
	const k = operateKeys({ ...common, mine: op.key, theirs: box.pub });
	const keys = [{
		team: hex(TEAM), session: hex(session), operator: "alice", operatorId: DEVICES.alice.id, box: "dave", boxId: DEVICES.dave.id,
		ephOpSeed: hex(sha256(Buffer.from("operate-op"))), ephBoxSeed: hex(sha256(Buffer.from("operate-box"))), ephOp: hex(op.pub), ephBox: hex(box.pub),
		toBox: hex(k.toBox), toOperator: hex(k.toOperator), boxSide: hex(operateKeys({ ...common, mine: box.key, theirs: op.pub }).toBox),
	}];
	const frames = (["toBox", "toOperator"] as const).flatMap((dir) => [1, 258].map((ctr) => {
		const plaintext = Buffer.from(`{"t":"ping"}#${dir}${ctr}`), key = k[dir], ct = operateSeal({ key, dir, session, ctr, plaintext });
		return { dir, key: hex(key), session: hex(session), ctr, plaintext: hex(plaintext), nonce: hex(Buffer.concat([Buffer.from(dir === "toBox" ? [0, 0, 0, 1] : [0, 0, 0, 2]), int(ctr)])), aad: hex(Buffer.concat([session, int(ctr)])), ct: hex(ct), opensWrongDir: operateOpen({ key, dir: dir === "toBox" ? "toOperator" : "toBox", session, ctr, ct }) === null ? null : "opened" };
	}));
	return { structure, keys, frames, openHash: hex(sha256(operateBody(open))) };
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
			"operate (a live kind, docs/specs/2026-11-07-link-operate.md §5.2): the outer plaintext is enc(int version 1, 16 session bytes, type text, body); a body is enc of its fields, an `accept` scope is enc(list of 16-byte team ids, bool box) and its limits enc(mirrors, watches, budget as ints). The session keys are HKDF-SHA256(X25519, empty salt, info 'straw-link/operate/1' ‖ team ‖ session ‖ operator id text ‖ box id text ‖ ephOp ‖ ephBox) of 64 bytes, the first 32 operator → box. A frame's nonce is a 4-byte direction tag (00000001 operator → box, 00000002 box → operator) ‖ 8-byte ctr; its AAD is session ‖ 8-byte ctr. Both device ids in that info are 26-character ids, so it needs no length prefixes.",
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
		towerCases: towerCases(),
		capsReplyCases: capsReplyCases(),
		unitStopCases: unitStopCases(),
		operateCases: operateCases(),
		limits: [
			{ kind: "tower", field: "text", unit: "bytes", max: 192 * 1024 },
			{ kind: "confirm-request", field: "args", unit: "characters", max: 12_000 },
			{ kind: "unit-status", field: "report", unit: "bytes", max: 4096 },
			{ kind: "notice", field: "text", unit: "bytes", max: 1024 },
			{ kind: "tower-reply", field: "text", unit: "bytes", max: 192 * 1024 },
			{ kind: "caps", field: "features", unit: "features", max: 16 },
			{ kind: "unit-stop", field: "reason", unit: "bytes", max: 200 },
			{ kind: "unit-status", field: "mains", unit: "entries", max: 20 },
			{ kind: "unit-status", field: "main name", unit: "characters", max: 40 },
			{ kind: "operate", field: "frame ciphertext", unit: "bytes", max: 200 * 1024 },
			{ kind: "operate", field: "open caps", unit: "entries", max: 16 },
			{ kind: "operate", field: "accept teams", unit: "entries", max: 8 },
			{ kind: "board", field: "entries", unit: "entries", max: 24 },
			{ kind: "board", field: "workspace, tab, name", unit: "characters", max: 40 },
			{ kind: "board", field: "now", unit: "characters", max: 120 },
			{ kind: "board", field: "items", unit: "items", max: 8 },
			{ kind: "board", field: "item text", unit: "characters", max: 80 },
		],
		envelopes: [built("tower", "alice", [DEVICES.bob.id], 1, "tower"), built("presence", "alice", [], 0, "presence"), built("board", "alice", [], 0, "board"), built("dialog-open", "dave", [DEVICES.alice.id, DEVICES.bob.id], 4, "dialog"), built("operate", "alice", [DEVICES.dave.id], 0, "operate")],
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
