import { CanonError, dec, enc, int, list, readBool, readInt, readList, readStr, str, bool } from "./canon.ts";
import { CONTEXT, equalBytes, openSealedKey, openUnderTeamKey, sealKey, sealUnderTeamKey, sha256, signBytes, signedBytes, verifyBytes } from "./crypto.ts";
import { decodeKeyRecord, encodeKeyRecord, labelOk, recordOf, sameRecord, type DeviceKeys, type KeyRecord } from "./device.ts";

// The roster (docs/specs/2026-10-25-straw-link.md, Roster): an append-only log of signed entries, and the verifier that replays it and
// enforces every rule. It runs on plaintext only (keys, roles, `attended`, signers, bans) unless the caller passes its own device, in which
// case it also opens the keys sealed to it and reads the label tables. Every rejection names a reason; for a client, any rejection of an
// entry is a dishonest relay (a roster fork), and a reason starting with `fork-` is one only a device holding keys can see.

export type Role = "admin" | "member";
export type Op = "create" | "add" | "remove" | "role" | "rotate";
export const OPS: readonly Op[] = ["create", "add", "remove", "role", "rotate"];

/** The first team key's epoch. Zero is never an epoch, so an unset number cannot pass for one. */
export const FIRST_EPOCH = 1;
/** The `prev` of the `create` entry, which has no predecessor. */
export const GENESIS_PREV = Buffer.alloc(32);

/** A device as an entry names it: its key record, role, and whether someone works at it. */
export interface Subject { record: KeyRecord; role: Role; attended: boolean }
export interface RosterEntry {
	seq: number;
	prev: Buffer;
	op: Op;
	/** The device the op is about; null for `rotate`. */
	subject: Subject | null;
	/** The id of the signer. */
	by: string;
	epoch: number;
	payload: Buffer;
	sig: Buffer;
}

const roleOk = (r: string): r is Role => r === "admin" || r === "member";
const encodeSubject = (s: Subject | null): Buffer => (s ? enc(encodeKeyRecord(s.record), str(s.role), bool(s.attended)) : Buffer.alloc(0));
function decodeSubject(b: Buffer): Subject | null {
	if (b.length === 0) return null;
	const [rec, role, attended] = dec(b, 3) as [Buffer, Buffer, Buffer], r = readStr(role);
	if (!roleOk(r)) throw new CanonError("unknown role");
	return { record: decodeKeyRecord(rec), role: r, attended: readBool(attended) };
}
/** The fields a signature covers. */
const entryBody = (e: Omit<RosterEntry, "sig">): Buffer => enc(int(e.seq), e.prev, str(e.op), encodeSubject(e.subject), str(e.by), int(e.epoch), e.payload);
export const entrySigned = (team: Uint8Array, e: Omit<RosterEntry, "sig">): Buffer => signedBytes(CONTEXT.roster, team, entryBody(e));
/** `enc(seq, prev, op, subject, by, epoch, payload, sig)`; its sha256 is the next entry's `prev` and the roster head hash. */
export const encodeEntry = (e: RosterEntry): Buffer => enc(int(e.seq), e.prev, str(e.op), encodeSubject(e.subject), str(e.by), int(e.epoch), e.payload, e.sig);
export const entryHash = (e: RosterEntry): Buffer => sha256(encodeEntry(e));
/** An entry, or a CanonError when the bytes are not one. */
export function decodeEntry(bytes: Uint8Array): RosterEntry {
	const [seq, prev, op, subject, by, epoch, payload, sig] = dec(bytes, 8) as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer], o = readStr(op);
	if (!(OPS as readonly string[]).includes(o)) throw new CanonError("unknown op");
	if (prev.length !== 32 || sig.length !== 64) throw new CanonError("bad prev or signature length");
	return { seq: readInt(seq), prev, op: o as Op, subject: decodeSubject(subject), by: readStr(by), epoch: readInt(epoch), payload, sig };
}

/** Signs an entry without any rule check. The builders below call it; so do tests that need an entry the rules refuse. */
export function signEntry(team: Uint8Array, signer: DeviceKeys, f: Omit<RosterEntry, "sig" | "by"> & { by?: string }): RosterEntry {
	const body = { ...f, by: f.by ?? signer.id };
	return { ...body, sig: signBytes(signer.signKey, entrySigned(team, body)) };
}

// ---- Payloads ------------------------------------------------------------------------------------------------------------------------

const labelTable = (labels: Map<string, string>) => list([...labels].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, label]) => enc(str(id), str(label))));
const tablePayload = (o: { team: Uint8Array; epoch: number; key: Uint8Array; labels: Map<string, string>; nonce?: Uint8Array }) => sealUnderTeamKey({ team: o.team, epoch: o.epoch, key: o.key, plaintext: labelTable(o.labels), nonce: o.nonce });

export interface Member extends Subject {
	/** Absent when this device cannot read it (no key, or the label table is from an epoch it never held). */
	label?: string;
	/** The entry that made the device a member. */
	since: number;
}
/** What the receive checks of an envelope need from a roster. */
export interface RosterView {
	epoch: number;
	/** The seq of the entry that started the current epoch. */
	epochStart: number;
	head: { seq: number; hash: Buffer };
	/** The hash of each entry, by seq. */
	hashes: Buffer[];
	members: Map<string, Subject>;
}
export interface RosterState extends RosterView {
	team: Buffer;
	entries: RosterEntry[];
	members: Map<string, Member>;
	/** Removed ids: no later `add` may name them. */
	banned: Set<string>;
	/** Team keys by epoch that this device holds. */
	keys: Map<number, Buffer>;
	/** The device ids that were members after each entry, by seq. */
	membersAfter: string[][];
	/** Whether the device passed to the replay was removed. */
	selfRemoved: boolean;
}

export type RosterReason =
	| "malformed" | "bad-seq" | "bad-prev" | "bad-op" | "bad-founder" | "signer-not-member" | "bad-signature" | "signer-unattended" | "not-admin"
	| "bad-epoch" | "bad-subject" | "bad-role" | "banned" | "duplicate-member" | "unknown-member" | "unattended-admin" | "no-attended-admin"
	| "bad-payload" | "sealed-set-mismatch" | "fork-sealed-key" | "fork-label";
export type RosterResult<T> = { ok: true; value: T } | { ok: false; reason: RosterReason; seq: number };
const fail = (reason: RosterReason, seq: number): { ok: false; reason: RosterReason; seq: number } => ({ ok: false, reason, seq });

export interface ReplayOptions {
	/** This device: its sealed keys are opened and its label tables read. Without it, only the rules that plaintext decides are checked. */
	self?: DeviceKeys;
	/** Team keys this device already holds (the founder's first key is in no entry). */
	keys?: Map<number, Buffer>;
}

const attendedAdmins = (members: Map<string, Subject>) => [...members.values()].filter((m) => m.role === "admin" && m.attended).length;
const copy = (s: RosterState): RosterState => ({ ...s, entries: [...s.entries], hashes: [...s.hashes], members: new Map(s.members), banned: new Set(s.banned), keys: new Map(s.keys), membersAfter: [...s.membersAfter] });

function sealedList(payload: Buffer): { sealed: Map<string, Buffer>; table: Buffer } | null {
	try {
		const [seals, table] = dec(payload, 2) as [Buffer, Buffer], sealed = new Map<string, Buffer>();
		for (const item of readList(seals)) {
			const [id, blob] = dec(item, 2) as [Buffer, Buffer], who = readStr(id);
			if (sealed.has(who)) return null;
			sealed.set(who, blob);
		}
		return { sealed, table };
	} catch {
		return null;
	}
}

/** Applies one entry to a roster (null before `create`); the returned state is a new object. */
export function applyEntry(team: Uint8Array, prior: RosterState | null, entry: RosterEntry, opts: ReplayOptions = {}): RosterResult<RosterState> {
	const seq = entry.seq, self = opts.self;
	if (seq !== (prior ? prior.head.seq + 1 : 0)) return fail("bad-seq", seq);
	if (!prior) {
		// The founder: admin, attended, signing for itself with the first epoch.
		const sub = entry.subject;
		if (entry.op !== "create" || !equalBytes(entry.prev, GENESIS_PREV)) return fail("bad-op", seq);
		if (!sub || sub.role !== "admin" || !sub.attended || entry.by !== sub.record.id || entry.epoch !== FIRST_EPOCH) return fail("bad-founder", seq);
		if (!verifyBytes(sub.record.signPub, entrySigned(team, entry), entry.sig)) return fail("bad-signature", seq);
		if (entry.payload.length < 12 + 16) return fail("bad-payload", seq);
		const keys = new Map(opts.keys ?? []), hash = entryHash(entry), members = new Map<string, Member>([[sub.record.id, { ...sub, since: 0 }]]);
		return { ok: true, value: { team: Buffer.from(team), entries: [entry], members, banned: new Set(), keys, epoch: FIRST_EPOCH, epochStart: 0, head: { seq: 0, hash }, hashes: [hash], membersAfter: [[sub.record.id]], selfRemoved: false } };
	}
	if (!equalBytes(entry.prev, prior.head.hash)) return fail("bad-prev", seq);
	if (entry.op === "create") return fail("bad-op", seq);
	const signer = prior.members.get(entry.by);
	if (!signer) return fail("signer-not-member", seq);
	if (!verifyBytes(signer.record.signPub, entrySigned(team, entry), entry.sig)) return fail("bad-signature", seq);
	if (!signer.attended) return fail("signer-unattended", seq);
	if (entry.op !== "add" && signer.role !== "admin") return fail("not-admin", seq);

	const next = copy(prior), sub = entry.subject;
	const finish = (): RosterResult<RosterState> => {
		const hash = entryHash(entry);
		next.entries.push(entry);
		next.hashes.push(hash);
		next.head = { seq, hash };
		next.membersAfter.push([...next.members.keys()].sort());
		return { ok: true, value: next };
	};
	// remove and rotate: a new key sealed to every device that remains, and the whole label table under it.
	const reKey = (remaining: Map<string, Member>): RosterReason | null => {
		if (entry.epoch !== prior.epoch + 1) return "bad-epoch";
		const list = sealedList(entry.payload);
		if (!list || list.table.length < 12 + 16) return "bad-payload";
		const have = [...list.sealed.keys()].sort(), want = [...remaining.keys()].sort();
		if (have.length !== want.length || have.some((id, i) => id !== want[i])) return "sealed-set-mismatch";
		next.epoch = entry.epoch;
		next.epochStart = seq;
		const mine = self && remaining.get(self.id)?.record;
		if (self && mine) {
			const key = openSealedKey({ team, epoch: entry.epoch, sealed: list.sealed.get(self.id)!, boxKey: self.boxKey, boxPub: self.boxPub });
			if (!key) return "fork-sealed-key";
			next.keys.set(entry.epoch, key);
		}
		return null;
	};

	switch (entry.op) {
		case "add": {
			if (!sub) return fail("bad-subject", seq);
			if (entry.epoch !== prior.epoch) return fail("bad-epoch", seq);
			if (sub.role !== "member") return fail("bad-role", seq);
			if (prior.banned.has(sub.record.id)) return fail("banned", seq);
			if (prior.members.has(sub.record.id)) return fail("duplicate-member", seq);
			let parts: Buffer[];
			try {
				parts = dec(entry.payload, 2);
			} catch {
				return fail("bad-payload", seq);
			}
			if (parts[0]!.length < 12 + 16) return fail("bad-payload", seq);
			if (self && sub.record.id === self.id) {
				const key = openSealedKey({ team, epoch: entry.epoch, sealed: parts[1]!, boxKey: self.boxKey, boxPub: self.boxPub });
				if (!key) return fail("fork-sealed-key", seq);
				next.keys.set(entry.epoch, key);
			}
			next.members.set(sub.record.id, { ...sub, since: seq });
			return finish();
		}
		case "remove": {
			const member = sub && prior.members.get(sub.record.id);
			if (!sub) return fail("bad-subject", seq);
			if (!member) return fail("unknown-member", seq);
			if (!sameRecord(sub.record, member.record) || sub.role !== member.role || sub.attended !== member.attended) return fail("bad-subject", seq);
			next.members.delete(sub.record.id);
			if (attendedAdmins(next.members) === 0) return fail("no-attended-admin", seq);
			next.banned.add(sub.record.id);
			if (self && sub.record.id === self.id) next.selfRemoved = true;
			const bad = reKey(next.members);
			return bad ? fail(bad, seq) : finish();
		}
		case "role": {
			const member = sub && prior.members.get(sub.record.id);
			if (!sub) return fail("bad-subject", seq);
			if (!member) return fail("unknown-member", seq);
			if (!sameRecord(sub.record, member.record) || sub.attended !== member.attended) return fail("bad-subject", seq);
			if (entry.epoch !== prior.epoch) return fail("bad-epoch", seq);
			try {
				if (readStr(dec(entry.payload, 1)[0]!) !== sub.role) return fail("bad-payload", seq);
			} catch {
				return fail("bad-payload", seq);
			}
			if (sub.role === "admin" && !sub.attended) return fail("unattended-admin", seq);
			next.members.set(sub.record.id, { ...member, role: sub.role });
			if (attendedAdmins(next.members) === 0) return fail("no-attended-admin", seq);
			return finish();
		}
		case "rotate": {
			if (sub) return fail("bad-subject", seq);
			const bad = reKey(next.members);
			return bad ? fail(bad, seq) : finish();
		}
		default:
			return fail("bad-op", seq);
	}
}

/** Reads the label of every member this device can: the latest table plus the `add`s after it, under keys the device holds. */
function readLabels(state: RosterState, team: Uint8Array): RosterResult<RosterState> {
	const labels = new Map<string, string>();
	for (const entry of state.entries) {
		const key = state.keys.get(entry.epoch);
		if (!key) continue;
		const hasTable = entry.op === "create" || entry.op === "remove" || entry.op === "rotate", hasLabel = entry.op === "add";
		if (!hasTable && !hasLabel) continue;
		const blob = entry.op === "add" ? dec(entry.payload, 2)[0]! : entry.op === "create" ? entry.payload : sealedList(entry.payload)!.table;
		const plain = openUnderTeamKey({ team, epoch: entry.epoch, key, sealed: blob });
		if (!plain) return fail("fork-label", entry.seq);
		try {
			if (hasLabel) {
				const label = readStr(dec(plain, 1)[0]!);
				if (!labelOk(label)) return fail("fork-label", entry.seq);
				labels.set(entry.subject!.record.id, label);
			} else {
				const table = new Map<string, string>();
				for (const item of readList(plain)) {
					const [id, label] = dec(item, 2).map(readStr) as [string, string];
					if (!labelOk(label) || table.has(id)) return fail("fork-label", entry.seq);
					table.set(id, label);
				}
				const want = state.membersAfter[entry.seq]!;
				if (table.size !== want.length || want.some((id) => !table.has(id))) return fail("fork-label", entry.seq);
				labels.clear();
				for (const [id, label] of table) labels.set(id, label);
			}
		} catch {
			return fail("fork-label", entry.seq);
		}
	}
	const members = new Map(state.members);
	for (const [id, m] of members) {
		const label = labels.get(id);
		members.set(id, label === undefined ? { ...m } : { ...m, label });
	}
	return { ok: true, value: { ...state, members } };
}

/** Replays a whole log from `create`, enforcing every rule; a failure's `seq` is the entry's position in the log. */
export function replayRoster(team: Uint8Array, entries: RosterEntry[], opts: ReplayOptions = {}): RosterResult<RosterState> {
	if (entries.length === 0) return fail("bad-seq", 0);
	let state: RosterState | null = null;
	for (const [i, entry] of entries.entries()) {
		const r = applyEntry(team, state, entry, opts);
		if (!r.ok) return fail(r.reason, i);
		state = r.value;
	}
	return state!.keys.size ? readLabels(state!, team) : { ok: true, value: state! };
}
/** The same from the entries' bytes; a malformed entry is `malformed` at its position. */
export function replayEncoded(team: Uint8Array, encoded: Uint8Array[], opts: ReplayOptions = {}): RosterResult<RosterState> {
	const entries: RosterEntry[] = [];
	for (const [i, bytes] of encoded.entries()) {
		try {
			entries.push(decodeEntry(bytes));
		} catch {
			return fail("malformed", i);
		}
	}
	return replayRoster(team, entries, opts);
}

// ---- Building entries ----------------------------------------------------------------------------------------------------------------

const next = (state: RosterState) => ({ seq: state.head.seq + 1, prev: state.head.hash });
const labelsOf = (state: RosterState): Map<string, string> => {
	const out = new Map<string, string>();
	for (const [id, m] of state.members) {
		if (m.label === undefined) throw new Error(`the label of ${id} is not readable here`);
		out.set(id, m.label);
	}
	return out;
};
const keyFor = (state: RosterState, epoch: number) => {
	const key = state.keys.get(epoch);
	if (!key) throw new Error(`no team key for epoch ${epoch}`);
	return key;
};

export interface Randomness {
	/** Fixed nonces and ephemeral seeds, for test vectors. */
	nonce?: Uint8Array;
	ephemeralSeed?: (recipientId: string) => Uint8Array | undefined;
}

/** The `create` entry of a new team; `teamKey` is its first key (epoch 1). */
export function createEntry(o: { team: Uint8Array; founder: DeviceKeys; label: string; teamKey: Uint8Array } & Randomness): RosterEntry {
	if (!labelOk(o.label)) throw new Error("not a valid label");
	return signEntry(o.team, o.founder, { seq: 0, prev: GENESIS_PREV, op: "create", subject: { record: recordOf(o.founder), role: "admin", attended: true }, epoch: FIRST_EPOCH, payload: tablePayload({ team: o.team, epoch: FIRST_EPOCH, key: o.teamKey, labels: new Map([[o.founder.id, o.label]]), nonce: o.nonce }) });
}

/** An `add` by an attended member. The inviter's client refuses a label a current member already has. */
export function addEntry(o: { state: RosterState; signer: DeviceKeys; record: KeyRecord; label: string; attended: boolean } & Randomness): RosterEntry {
	const { state } = o;
	if (!labelOk(o.label)) throw new Error("not a valid label");
	if ([...state.members.values()].some((m) => m.label === o.label)) throw new Error("a member already has this label");
	const key = keyFor(state, state.epoch);
	const payload = enc(sealUnderTeamKey({ team: state.team, epoch: state.epoch, key, plaintext: enc(str(o.label)), nonce: o.nonce }), sealKey({ team: state.team, epoch: state.epoch, key, recipientBoxPub: o.record.boxPub, ephemeralSeed: o.ephemeralSeed?.(o.record.id) }));
	return signEntry(state.team, o.signer, { ...next(state), op: "add", subject: { record: recordOf(o.record), role: "member", attended: o.attended }, epoch: state.epoch, payload });
}

const reKeyPayload = (state: RosterState, remaining: Map<string, Member>, epoch: number, newKey: Uint8Array, r: Randomness) =>
	enc(
		list([...remaining].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, m]) => enc(str(id), sealKey({ team: state.team, epoch, key: newKey, recipientBoxPub: m.record.boxPub, ephemeralSeed: r.ephemeralSeed?.(id) })))),
		tablePayload({ team: state.team, epoch, key: newKey, labels: new Map([...remaining].map(([id, m]) => [id, m.label ?? ""])), nonce: r.nonce }),
	);

/** A `remove` by an admin; `newKey` is the next epoch's team key. */
export function removeEntry(o: { state: RosterState; signer: DeviceKeys; subjectId: string; newKey: Uint8Array } & Randomness): RosterEntry {
	const { state } = o, m = state.members.get(o.subjectId);
	if (!m) throw new Error("not a member");
	labelsOf(state);
	const remaining = new Map(state.members);
	remaining.delete(o.subjectId);
	const epoch = state.epoch + 1;
	return signEntry(state.team, o.signer, { ...next(state), op: "remove", subject: { record: m.record, role: m.role, attended: m.attended }, epoch, payload: reKeyPayload(state, remaining, epoch, o.newKey, o) });
}

/** A `rotate` by an admin. */
export function rotateEntry(o: { state: RosterState; signer: DeviceKeys; newKey: Uint8Array } & Randomness): RosterEntry {
	const { state } = o;
	labelsOf(state);
	const epoch = state.epoch + 1;
	return signEntry(state.team, o.signer, { ...next(state), op: "rotate", subject: null, epoch, payload: reKeyPayload(state, state.members, epoch, o.newKey, o) });
}

/** A `role` change by an admin. */
export function roleEntry(o: { state: RosterState; signer: DeviceKeys; subjectId: string; role: Role }): RosterEntry {
	const { state } = o, m = state.members.get(o.subjectId);
	if (!m) throw new Error("not a member");
	return signEntry(state.team, o.signer, { ...next(state), op: "role", subject: { record: m.record, role: o.role, attended: m.attended }, epoch: state.epoch, payload: enc(str(o.role)) });
}
