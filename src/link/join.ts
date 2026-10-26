import { CanonError, dec, enc, exact, readStr, str } from "./canon.ts";
import { aeadOpen, aeadSeal, equalBytes, joinKey, joinMac, NONCE_BYTES, randomNonce, sha256 } from "./crypto.ts";
import { decodeKeyRecord, encodeKeyRecord, idOk, keyRecordHash, labelOk, sameRecord, type DeviceKeys, type KeyRecord } from "./device.ts";
import { BIP39_ENGLISH } from "./bip39-english.ts";
import { replayRoster, type RosterEntry, type RosterReason, type RosterState } from "./roster.ts";

// Joining (docs/specs/2026-10-25-straw-link.md, Joining with a QR code): the invite text, the join request under the invite secret, the safety
// words both screens show, and the joiner's check that the roster it fetched is the inviter's, not a relay's.

const PREFIX = "strawlink1:";

/** What an invite carries. */
export interface Invite {
	relay: string;
	team: Buffer;
	/** 32 random bytes; the relay only ever sees `sha256(secret)`. */
	secret: Buffer;
	inviterId: string;
	/** sha256 of the inviter's key record: what the joiner pins the team to. */
	inviterKeyHash: Buffer;
	/** The one device id that may use the invite (an unattended device's); empty for any device. */
	forDevice: string;
}
export const inviteHash = (secret: Uint8Array): Buffer => sha256(secret);

/** `strawlink1:` + base64url of `enc(relay URL, team, secret, inviter id, sha256(inviter key record), device id or empty)`. */
export const encodeInvite = (i: Invite): string => PREFIX + enc(str(i.relay), i.team, i.secret, str(i.inviterId), i.inviterKeyHash, str(i.forDevice)).toString("base64url");

export const relayOk = (url: string) => {
	try {
		const u = new URL(url);
		return url.length <= 2048 && (u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)));
	} catch {
		return false;
	}
};
/** An invite from its text, or null: wrong prefix, base64url that is not canonical, a malformed structure, or a field out of shape. */
export function decodeInvite(text: string): Invite | null {
	const t = text.trim();
	if (!t.startsWith(PREFIX)) return null;
	const body = t.slice(PREFIX.length), raw = Buffer.from(body, "base64url");
	if (raw.toString("base64url") !== body) return null;
	try {
		const [relay, team, secret, inviterId, hash, forDevice] = dec(raw, 6) as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
		const i: Invite = { relay: readStr(relay), team: exact(team, 16, "a team id"), secret: exact(secret, 32, "a secret"), inviterId: readStr(inviterId), inviterKeyHash: exact(hash, 32, "a hash"), forDevice: readStr(forDevice) };
		return relayOk(i.relay) && idOk(i.inviterId) && (i.forDevice === "" || idOk(i.forDevice)) ? i : null;
	} catch (error) {
		if (error instanceof CanonError) return null;
		throw error;
	}
}

// ---- The join request ----------------------------------------------------------------------------------------------------------------

const requestFields = (record: KeyRecord, label: string) => enc(encodeKeyRecord(record), str(label));
/** The joiner's key record and label, MACed with the invite secret and encrypted under HKDF(secret): `nonce ‖ ct ‖ tag`. */
export function buildJoinRequest(o: { team: Uint8Array; secret: Uint8Array; record: KeyRecord; label: string; nonce?: Uint8Array }): Buffer {
	if (!labelOk(o.label)) throw new Error("not a valid label");
	const fields = requestFields(o.record, o.label), mac = joinMac(o.secret, o.team, fields), nonce = Buffer.from(o.nonce ?? randomNonce());
	return Buffer.concat([nonce, aeadSeal(joinKey(o.secret, o.team), nonce, enc(encodeKeyRecord(o.record), str(o.label), mac))]);
}

export type JoinReason = "bad-ciphertext" | "bad-request" | "bad-record" | "bad-mac" | "bad-label" | "wrong-device" | "banned" | "already-member" | "label-taken";
export type JoinOpened = { ok: true; record: KeyRecord; label: string } | { ok: false; reason: JoinReason };
/**
 * What the inviter does with a join request (`forDevice` is the invite's pinned device id, "" when it is not pinned): decrypt, check the MAC, the record, the label, the invite's pinned device, and (with the
 * roster) the id ban, an existing member, and a label a member already has.
 */
export function openJoinRequest(o: { team: Uint8Array; secret: Uint8Array; blob: Uint8Array; forDevice: string; roster?: RosterState }): JoinOpened {
	const no = (reason: JoinReason): JoinOpened => ({ ok: false, reason });
	if (o.blob.length < NONCE_BYTES) return no("bad-ciphertext");
	const plain = aeadOpen(joinKey(o.secret, o.team), o.blob.subarray(0, NONCE_BYTES), o.blob.subarray(NONCE_BYTES));
	if (!plain) return no("bad-ciphertext");
	let rec: Buffer, label: Buffer, mac: Buffer;
	try {
		[rec, label, mac] = dec(plain, 3) as [Buffer, Buffer, Buffer];
	} catch {
		return no("bad-request");
	}
	let record: KeyRecord;
	try {
		record = decodeKeyRecord(rec);
	} catch {
		return no("bad-record");
	}
	const text = readStr(label);
	if (!equalBytes(mac, joinMac(o.secret, o.team, requestFields(record, text)))) return no("bad-mac");
	if (!labelOk(text)) return no("bad-label");
	if (o.forDevice !== "" && record.id !== o.forDevice) return no("wrong-device");
	if (o.roster) {
		if (o.roster.banned.has(record.id)) return no("banned");
		if (o.roster.members.has(record.id)) return no("already-member");
		if ([...o.roster.members.values()].some((m) => m.label === text)) return no("label-taken");
	}
	return { ok: true, record, label: text };
}

// ---- Safety words --------------------------------------------------------------------------------------------------------------------

/**
 * `sha256("straw-link/safety/1" ‖ team ‖ sha256(inviter key record) ‖ joiner key record ‖ invite secret)`, the first 44 bits as 4 words of
 * the BIP-39 English list (11 bits each, most significant first).
 */
export function safetyWords(o: { team: Uint8Array; inviterKeyHash: Uint8Array; joiner: KeyRecord; secret: Uint8Array }): string[] {
	const h = sha256(Buffer.from("straw-link/safety/1", "utf8"), o.team, o.inviterKeyHash, encodeKeyRecord(o.joiner), o.secret);
	const bits = h.readBigUInt64BE(0) >> 20n;
	return [3n, 2n, 1n, 0n].map((i) => BIP39_ENGLISH[Number((bits >> (i * 11n)) & 0x7ffn)]!);
}

// ---- The joiner's check --------------------------------------------------------------------------------------------------------------

export type JoinerReason = RosterReason | "not-added" | "wrong-device" | "inviter-mismatch" | "inviter-key-mismatch" | "label-mismatch";
export type JoinerResult = { ok: true; state: RosterState } | { ok: false; reason: JoinerReason; seq?: number };
/**
 * The joiner's check of the roster it fetched: every entry back to `create` replays under the rules, its own `add` is signed by the QR's
 * inviter id, and that inviter's key record hashes to the QR's value. A relay that wanted to enroll the joiner into a team of its own
 * cannot satisfy the last two, because the inviter's key is pinned by the QR and the relay does not hold it.
 */
export function checkJoiner(o: { invite: Invite; self: DeviceKeys; entries: RosterEntry[]; label?: string }): JoinerResult {
	const { invite, self } = o;
	if (invite.forDevice && invite.forDevice !== self.id) return { ok: false, reason: "wrong-device" };
	const replay = replayRoster(invite.team, o.entries, { self });
	if (!replay.ok) return { ok: false, reason: replay.reason, seq: replay.seq };
	const state = replay.value, me = state.members.get(self.id);
	if (!me || state.selfRemoved) return { ok: false, reason: "not-added" };
	const add = o.entries[me.since]!;
	if (add.by !== invite.inviterId) return { ok: false, reason: "inviter-mismatch", seq: me.since };
	const inviter = o.entries.slice(0, me.since).find((e) => e.subject?.record.id === invite.inviterId)?.subject?.record;
	if (!inviter || !equalBytes(keyRecordHash(inviter), invite.inviterKeyHash)) return { ok: false, reason: "inviter-key-mismatch", seq: me.since };
	if (!sameRecord(add.subject!.record, self)) return { ok: false, reason: "not-added", seq: me.since };
	if (o.label !== undefined && me.label !== o.label) return { ok: false, reason: "label-mismatch", seq: me.since };
	return { ok: true, state };
}
