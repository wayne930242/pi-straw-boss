import { aeadSeal, CONTEXT, signBytes, signedBytes } from "../../src/link/crypto.ts";
import { encodeEnvelope, encodeHeader, ephemeralKey, type Envelope, type Header, type ReceiveReason, type ReceiveState } from "../../src/link/envelope.ts";
import { encodePlaintext, KINDS, type Kind, type Plaintexts } from "../../src/link/kinds.ts";
import { replayRoster, entryHash } from "../../src/link/roster.ts";
import { DEVICES, mainLog, TEAM, teamKey, type Who } from "./scenario.ts";

export const NOW = 1_800_000_000_000;
const MIN = 60_000, DAY = 24 * 3600_000;

/** What a receiving device knows, in a form that survives JSON: its roster is the first `entries` entries of the main log. */
export interface StateSpec {
	self: Who;
	entries: number;
	now: number;
	keys: Record<number, string>;
	lastSeq: Record<string, number>;
	lastEphemeral: Record<string, number>;
}
export interface EnvelopeCase { name: string; envelope: Buffer; state: StateSpec; expect: "ok" | ReceiveReason }

const D = DEVICES;
export const baseState = (over: Partial<StateSpec> = {}): StateSpec => ({ self: "bob", entries: 8, now: NOW, keys: { 1: teamKey(1).toString("hex"), 2: teamKey(2).toString("hex"), 3: teamKey(3).toString("hex") }, lastSeq: {}, lastEphemeral: {}, ...over });

export function receiveState(spec: StateSpec): ReceiveState {
	const r = replayRoster(TEAM, mainLog().slice(0, spec.entries));
	if (!r.ok) throw new Error(`roster: ${r.reason}`);
	return {
		team: TEAM, self: D[spec.self].id, roster: r.value, now: spec.now,
		keys: new Map(Object.entries(spec.keys).map(([e, k]) => [Number(e), Buffer.from(k, "hex")])),
		lastSeq: new Map(Object.entries(spec.lastSeq)),
		lastEphemeral: new Map(Object.entries(spec.lastEphemeral)),
	};
}

export const SAMPLE: { [K in Kind]: Plaintexts[K] } = {
	tower: { fromWorkspace: "main", toWorkspace: "", replyExpected: true, text: "Please look at the failing build." },
	presence: { label: "alice-mac", headSeq: 7, headHash: entryHash(mainLog()[7]!), workspaces: [{ label: "moldplan", tower: "idle", tabs: [{ label: "tower", state: "idle" }, { label: "api", state: "working" }] }] },
	"confirm-request": { dialogId: "d1", digest: "ab".repeat(16), tool: "bash", args: "ls -la", tower: "moldplan" },
	"confirm-answer": { dialogId: "d1", digest: "ab".repeat(16), allow: false, answerId: "a1" },
	"dialog-open": { dialogId: "d2", digest: "cd".repeat(16), owner: "pi-7", dialog: '{"type":"select","options":["a","b"]}' },
	"dialog-answer": { dialogId: "d2", digest: "cd".repeat(16), answer: "a", answerId: "a2" },
	"dialog-close": { dialogId: "d2", by: "alice-mac" },
	"unit-status": { units: [{ unit: "build", state: "working", monitors: ["npm test"], report: "Compiled 12 files." }] },
	notice: { kind: "failure", unit: "build", text: "The build turn failed." },
};

interface Forge {
	from?: Who;
	kind?: Kind;
	header?: Partial<Header>;
	/** Defaults to the main roster's head. */
	key?: Buffer;
	plaintext?: Buffer;
	signer?: Who;
	nonce?: string;
}
/** An envelope the library's builder would refuse to make: any header, any key, any signer. */
export function forge(f: Forge = {}): Envelope {
	const kind = f.kind ?? "tower", rule = KINDS[kind], from = f.from ?? "alice", log = mainLog();
	const header: Header = {
		v: 1, team: TEAM, epoch: 3, head: { seq: 7, hash: entryHash(log[7]!) }, from: D[from].id, seq: rule.ephemeral ? 0 : 1, id: Buffer.alloc(16, 0xe1), ts: NOW - MIN,
		kind, to: rule.wholeTeam ? [] : [D.bob.id], ephemeral: rule.ephemeral, ...f.header,
	};
	const nonce = Buffer.from(f.nonce ?? "00112233445566778899aabb", "hex"), bytes = encodeHeader(header);
	const ct = aeadSeal(f.key ?? teamKey(header.epoch), nonce, f.plaintext ?? encodePlaintext(kind, SAMPLE[kind] as never), bytes);
	return { header, nonce, ct, sig: signBytes(D[f.signer ?? from].signKey, signedBytes(CONTEXT.envelope, TEAM, bytes, nonce, ct)) };
}

export function envelopeCases(): EnvelopeCase[] {
	const log = mainLog(), cases: EnvelopeCase[] = [];
	const add = (name: string, e: Envelope, expect: EnvelopeCase["expect"], state: StateSpec = baseState()) => cases.push({ name, envelope: encodeEnvelope(e), state, expect });
	const wrongHash = Buffer.alloc(32, 0xaa);

	for (const kind of Object.keys(KINDS) as Kind[]) {
		const sender: Who = KINDS[kind].sender === "unattended" ? "dave" : "alice";
		add(`a ${kind} from ${sender} is taken`, forge({ kind, from: sender }), "ok");
	}
	add("a presence carries no seq and still passes beside queued seqs", forge({ kind: "presence" }), "ok", baseState({ lastSeq: { [D.alice.id]: 40 } }));
	add("the epoch before the current one, written before the rotation was known", forge({ header: { epoch: 2, head: { seq: 6, hash: entryHash(log[6]!) } }, from: "carol" }), "ok");
	add("a seq just past the last one taken", forge({ header: { seq: 6 } }), "ok", baseState({ lastSeq: { [D.alice.id]: 5 } }));
	add("a ts just inside the future allowance", forge({ header: { ts: NOW + 10 * MIN } }), "ok");
	add("a ts just inside the age limit", forge({ header: { ts: NOW - 7 * DAY } }), "ok");
	add("an envelope for several devices that names this one", forge({ header: { to: [D.carol.id, D.bob.id] } }), "ok");
	add("a roster head behind this device's", forge({ header: { head: { seq: 3, hash: entryHash(log[3]!) } } }), "ok");

	add("another protocol version", forge({ header: { v: 2 } }), "bad-version");
	add("another team", forge({ header: { team: Buffer.alloc(16, 1) } }), "wrong-team");
	add("a kind that does not exist", forge({ header: { kind: "shout" } }), "unknown-kind");
	add("a presence marked queued", forge({ kind: "presence", header: { ephemeral: false, seq: 1 } }), "ephemeral-mismatch");
	add("a tower message marked ephemeral", forge({ header: { ephemeral: true, seq: 0 } }), "ephemeral-mismatch");
	add("a recipient that is not an id", forge({ header: { to: ["Not An Id"] } }), "bad-header");
	add("a sender that was removed", forge({ from: "eve", header: { epoch: 2, head: { seq: 5, hash: entryHash(log[5]!) } }, key: teamKey(2) }), "not-member");
	add("a sender that never was a member", forge({ from: "mallory" }), "not-member");
	add("an attended device sending a kind only unattended devices send", forge({ kind: "dialog-open", from: "alice" }), "kind-not-allowed");
	add("an unattended device sending a kind only attended devices send", forge({ kind: "dialog-answer", from: "dave" }), "kind-not-allowed");
	add("the epoch two behind", forge({ header: { epoch: 1 }, key: teamKey(1) }), "bad-epoch");
	add("the previous epoch, from a sender that knew of the rotation", forge({ header: { epoch: 2 }, key: teamKey(2) }), "bad-epoch");
	add("an epoch ahead of this device's", forge({ header: { epoch: 4 }, key: teamKey(4) }), "bad-epoch");
	add("an envelope for another device", forge({ header: { to: [D.carol.id] } }), "not-addressed");
	add("a kind that cannot go to the whole team, sent to it", forge({ header: { to: [] } }), "whole-team-not-allowed");
	add("a presence with a seq", forge({ kind: "presence", header: { seq: 3 } }), "bad-seq");
	add("a seq equal to the last one taken", forge({ header: { seq: 5 } }), "stale-seq", baseState({ lastSeq: { [D.alice.id]: 5 } }));
	add("a seq below the last one taken", forge({ header: { seq: 4 } }), "stale-seq", baseState({ lastSeq: { [D.alice.id]: 5 } }));
	add("a seq of 0 for a queued kind", forge({ header: { seq: 0 } }), "stale-seq");
	add("a presence no newer than the last", forge({ kind: "presence" }), "stale-ephemeral", baseState({ lastEphemeral: { [ephemeralKey(D.alice.id, "presence")]: NOW - MIN } }));
	add("a roster head ahead of this device's", forge({ header: { head: { seq: 8, hash: wrongHash } } }), "roster-ahead");
	add("a roster head this device's copy does not have", forge({ header: { head: { seq: 3, hash: wrongHash } } }), "roster-mismatch");
	add("a roster head that is ahead of a device holding a shorter copy", forge({ header: { epoch: 2 }, key: teamKey(2) }), "roster-ahead", baseState({ entries: 7 }));
	add("a ts too far ahead", forge({ header: { ts: NOW + 10 * MIN + 1 } }), "future-ts");
	add("a ts older than the relay keeps", forge({ header: { ts: NOW - 7 * DAY - 1 } }), "old-ts");

	const ok = forge(), bad = Buffer.from(ok.sig);
	bad[0] = bad[0]! ^ 1;
	add("a flipped signature", { ...ok, sig: bad }, "bad-signature");
	add("a header changed after signing", { ...ok, header: { ...ok.header, ts: ok.header.ts + 1 } }, "bad-signature");
	add("a ciphertext changed after signing", { ...ok, ct: Buffer.from(ok.ct.map((b, i) => (i === 0 ? b ^ 1 : b))) }, "bad-signature");
	add("signed by another device", forge({ signer: "bob" }), "bad-signature");
	add("encrypted under another key", forge({ key: teamKey(9) }), "bad-ciphertext");
	add("a plaintext that is not that kind's structure", forge({ plaintext: Buffer.from("not a structure") }), "bad-plaintext");
	add("an epoch whose key this device lacks", forge({}), "no-key", baseState({ keys: { 2: teamKey(2).toString("hex") } }));
	return cases;
}
