import { randomBytes } from "node:crypto";
import { bool, CanonError, dec, enc, exact, int, keepRaw, list, rawOr, readBool, readInt, readList, readStr, str } from "./canon.ts";
import { aeadOpen, aeadSeal, CONTEXT, randomNonce, signBytes, signedBytes, verifyBytes } from "./crypto.ts";
import { idOk, type DeviceKeys } from "./device.ts";
import { decodePlaintext, KINDS, kindOk, type Kind, type Plaintexts } from "./kinds.ts";
import type { RosterView } from "./roster.ts";

// The envelope (docs/specs/2026-10-25-straw-link.md, Envelope): a signed, encrypted message of one kind, and the receive checks that decide
// whether this device takes it. The checks are a function of the envelope and an explicit state, and return ok or a named reason.

export const VERSION = 1;
/** An envelope may be dated up to this far ahead of the receiver's clock, and no further behind than the relay keeps it. */
export const MAX_FUTURE_MS = 10 * 60_000, MAX_AGE_MS = 7 * 24 * 3600_000;

export interface Header {
	v: number;
	team: Buffer;
	epoch: number;
	/** The sender's roster head when it wrote this. */
	head: { seq: number; hash: Buffer };
	from: string;
	/** Per sender, +1 for each queued envelope; 0 for an ephemeral one. */
	seq: number;
	id: Buffer;
	ts: number;
	kind: string;
	/** Device ids; empty means the whole team. */
	to: string[];
	/** Fixed by the kind; a receiver drops an envelope whose flag disagrees. */
	ephemeral: boolean;
}
export interface Envelope { header: Header; nonce: Buffer; ct: Buffer; sig: Buffer }

/** The header's canonical bytes: the AEAD's associated data and part of what the signature covers. */
export const encodeHeader = (h: Header): Buffer =>
	enc(int(h.v), h.team, int(h.epoch), int(h.head.seq), h.head.hash, str(h.from), int(h.seq), h.id, int(h.ts), str(h.kind), list(h.to.map(str)), bool(h.ephemeral));
export function decodeHeader(bytes: Uint8Array): Header {
	const [v, team, epoch, hseq, hhash, from, seq, id, ts, kind, to, eph] = dec(bytes, 12) as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
	return keepRaw({
		v: readInt(v), team: exact(team, 16, "a team id"), epoch: readInt(epoch), head: { seq: readInt(hseq), hash: exact(hhash, 32, "a roster hash") },
		from: readStr(from), seq: readInt(seq), id: exact(id, 16, "an envelope id"), ts: readInt(ts), kind: readStr(kind), to: readList(to).map(readStr), ephemeral: readBool(eph),
	}, bytes);
}
/** The header's bytes as received, or its encoding for a header built here. */
const headerBytesOf = (h: Header): Buffer => rawOr(h, () => encodeHeader(h));
export const encodeEnvelope = (e: Envelope): Buffer => enc(headerBytesOf(e.header), e.nonce, e.ct, e.sig);
/** An envelope, or a CanonError when the bytes are not one. */
export function decodeEnvelope(bytes: Uint8Array): Envelope {
	const [header, nonce, ct, sig] = dec(bytes, 4) as [Buffer, Buffer, Buffer, Buffer];
	return { header: decodeHeader(header), nonce: exact(nonce, 12, "a nonce"), ct, sig: exact(sig, 64, "a signature") };
}

const signedOf = (h: Header, nonce: Uint8Array, ct: Uint8Array, headerBytes = headerBytesOf(h)) => signedBytes(CONTEXT.envelope, h.team, headerBytes, nonce, ct);

export interface BuildOptions {
	team: Uint8Array;
	epoch: number;
	teamKey: Uint8Array;
	head: { seq: number; hash: Buffer };
	from: DeviceKeys;
	/** The sender's next seq; ignored (0) for an ephemeral kind. */
	seq: number;
	ts: number;
	kind: Kind;
	to: string[];
	plaintext: Uint8Array;
	id?: Uint8Array;
	nonce?: Uint8Array;
}
/** Builds, encrypts, and signs an envelope; the ephemeral flag and seq 0 for an ephemeral kind come from the kind, not from the caller. */
export function buildEnvelope(o: BuildOptions): Envelope {
	const rule = KINDS[o.kind];
	if (!rule) throw new Error(`unknown kind ${o.kind}`);
	if (o.to.length === 0 && !rule.wholeTeam) throw new Error(`${o.kind} is not for the whole team`);
	const header: Header = { v: VERSION, team: exact(o.team, 16, "a team id"), epoch: o.epoch, head: o.head, from: o.from.id, seq: rule.ephemeral ? 0 : o.seq, id: Buffer.from(o.id ?? randomBytes(16)), ts: o.ts, kind: o.kind, to: o.to, ephemeral: rule.ephemeral };
	const headerBytes = encodeHeader(header), nonce = Buffer.from(o.nonce ?? randomNonce()), ct = aeadSeal(o.teamKey, nonce, o.plaintext, headerBytes);
	return { header, nonce, ct, sig: signBytes(o.from.signKey, signedOf(header, nonce, ct, headerBytes)) };
}

/** What a receiver keeps and knows when an envelope arrives. */
export interface ReceiveState {
	team: Uint8Array;
	/** This device's id. */
	self: string;
	roster: RosterView;
	/** Team keys by epoch. */
	keys: Map<number, Uint8Array>;
	/** The last queued `seq` taken from each sender. */
	lastSeq: Map<string, number>;
	/** The newest `ts` taken from each sender for each ephemeral kind, keyed `<sender>/<kind>`. */
	lastEphemeral: Map<string, number>;
	now: number;
}

export type ReceiveReason =
	| "bad-header" | "bad-version" | "wrong-team" | "unknown-kind" | "ephemeral-mismatch"
	| "not-member" | "kind-not-allowed" | "bad-epoch" | "not-addressed" | "whole-team-not-allowed" | "bad-seq" | "stale-seq" | "stale-ephemeral"
	| "roster-ahead" | "roster-mismatch" | "future-ts" | "old-ts" | "bad-signature" | "no-key" | "bad-ciphertext" | "bad-plaintext";
export type Verdict = { ok: true } | { ok: false; reason: ReceiveReason };
const no = (reason: ReceiveReason): { ok: false; reason: ReceiveReason } => ({ ok: false, reason });
const OK: Verdict = { ok: true };

/** The key of `lastEphemeral`. */
export const ephemeralKey = (from: string, kind: string) => `${from}/${kind}`;

/** The header's shape: version, team, a kind this code knows, and the ephemeral flag the kind fixes. */
function headerChecks(h: Header, state: ReceiveState): Verdict {
	if (h.v !== VERSION) return no("bad-version");
	if (!Buffer.from(state.team).equals(h.team)) return no("wrong-team");
	if (!kindOk(h.kind)) return no("unknown-kind");
	if (h.ephemeral !== KINDS[h.kind].ephemeral) return no("ephemeral-mismatch");
	if (!idOk(h.from) || h.to.some((id) => !idOk(id))) return no("bad-header");
	return OK;
}

/** The six receive checks of the spec, in its order, after the header's shape. Nothing here mutates the state; `recordTaken` does that once the envelope is accepted. */
export function receiveChecks(h: Header, state: ReceiveState): Verdict {
	const shape = headerChecks(h, state);
	if (!shape.ok) return shape;
	const kind = h.kind as Kind, rule = KINDS[kind], roster = state.roster, sender = roster.members.get(h.from);
	// 1. The sender is a member of the current roster, and the kind is one it may send.
	if (!sender) return no("not-member");
	if (rule.sender !== "any" && (rule.sender === "attended") !== sender.attended) return no("kind-not-allowed");
	// 2. The current epoch, or the one before it when the sender wrote it before it knew of the rotation.
	if (h.epoch !== roster.epoch && !(h.epoch === roster.epoch - 1 && h.head.seq < roster.epochStart)) return no("bad-epoch");
	// 3. It names this device, or the whole team when the kind allows that.
	if (h.to.length === 0 ? !rule.wholeTeam : !h.to.includes(state.self)) return no(h.to.length === 0 ? "whole-team-not-allowed" : "not-addressed");
	// 4. A queued kind's seq is past the last one taken; an ephemeral kind's ts is newer than the last one taken for that kind.
	if (rule.ephemeral) {
		if (h.seq !== 0) return no("bad-seq");
		if (h.ts <= (state.lastEphemeral.get(ephemeralKey(h.from, kind)) ?? 0)) return no("stale-ephemeral");
	} else if (h.seq <= (state.lastSeq.get(h.from) ?? 0)) return no("stale-seq");
	// 5. The sender's roster head is not ahead of this device's copy (and, if it is within it, is a head of this copy).
	if (h.head.seq > roster.head.seq) return no("roster-ahead");
	if (!roster.hashes[h.head.seq]?.equals(h.head.hash)) return no("roster-mismatch");
	// 6. Not more than 10 minutes ahead, not older than 7 days.
	if (h.ts > state.now + MAX_FUTURE_MS) return no("future-ts");
	if (h.ts < state.now - MAX_AGE_MS) return no("old-ts");
	return OK;
}

/** The state after taking an envelope with this header. */
export function recordTaken(state: ReceiveState, h: Header): ReceiveState {
	const lastSeq = new Map(state.lastSeq), lastEphemeral = new Map(state.lastEphemeral);
	if (h.ephemeral) lastEphemeral.set(ephemeralKey(h.from, h.kind), h.ts);
	else lastSeq.set(h.from, h.seq);
	return { ...state, lastSeq, lastEphemeral };
}

export type Opened = { ok: true; header: Header; plaintext: Buffer; message: Plaintexts[Kind] } | { ok: false; reason: ReceiveReason };
/** Checks, verifies the signature, decrypts, and decodes. Cheap checks come first; the AEAD runs only for an envelope that passed them all. */
export function openEnvelope(e: Envelope, state: ReceiveState): Opened {
	const h = e.header, shape = headerChecks(h, state);
	if (!shape.ok) return shape;
	const sender = state.roster.members.get(h.from);
	if (!sender) return no("not-member");
	if (!verifyBytes(sender.record.signPub, signedOf(h, e.nonce, e.ct), e.sig)) return no("bad-signature");
	const checked = receiveChecks(h, state);
	if (!checked.ok) return no(checked.reason);
	const key = state.keys.get(h.epoch);
	if (!key) return no("no-key");
	const plaintext = aeadOpen(key, e.nonce, e.ct, headerBytesOf(h));
	if (!plaintext) return no("bad-ciphertext");
	const message = decodePlaintext(h.kind as Kind, plaintext);
	return message ? { ok: true, header: h, plaintext, message } : no("bad-plaintext");
}

/** A CanonError-safe decode for bytes off the wire. */
export function parseEnvelope(bytes: Uint8Array): Envelope | null {
	try {
		return decodeEnvelope(bytes);
	} catch (error) {
		if (error instanceof CanonError || error instanceof RangeError) return null;
		throw error;
	}
}
