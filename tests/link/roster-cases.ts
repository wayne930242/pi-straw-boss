import { enc, int, list, str } from "../../src/link/canon.ts";
import { sealKey, sealUnderTeamKey } from "../../src/link/crypto.ts";
import { addEntry, createEntry, encodeEntry, FIRST_EPOCH, GENESIS_PREV, removeEntry, roleEntry, rotateEntry, signEntry, type RosterEntry, type RosterReason, type Subject } from "../../src/link/roster.ts";
import { DEVICES, det, LABELS, mainLog, TEAM, teamKey, view, type Who } from "./scenario.ts";

/** A log the verifier has to refuse: the entries as bytes, who replays it, and the reason and position expected. */
export interface RosterCase { name: string; entries: Buffer[]; self?: Who; reason: RosterReason; seq: number }

const D = DEVICES;
const subject = (who: Who, role: Subject["role"], attended = true): Subject => ({ record: D[who], role, attended });
const next = (log: RosterEntry[]) => ({ seq: log.length, prev: view(log).head.hash });

export function rosterCases(): RosterCase[] {
	const log = mainLog(), upto = (n: number) => log.slice(0, n + 1), cases: RosterCase[] = [];
	const bytes = (entries: RosterEntry[]) => entries.map(encodeEntry);
	const bad = (name: string, entries: RosterEntry[], reason: RosterReason, seq: number, self?: Who) => cases.push({ name, entries: bytes(entries), self, reason, seq });
	const withLast = (n: number, build: (log: RosterEntry[]) => RosterEntry) => [...upto(n), build(upto(n))];
	const addBase = (log: RosterEntry[], who: Who, f: Partial<Parameters<typeof signEntry>[2]> & { signer?: Who; label?: string } = {}) => {
		const key = view(log).keys.get(view(log).epoch)!;
		return signEntry(TEAM, D[f.signer ?? "alice"], {
			...next(log), op: "add", subject: subject(who, "member"), epoch: view(log).epoch,
			payload: enc(sealUnderTeamKey({ team: TEAM, epoch: view(log).epoch, key, plaintext: enc(str(f.label ?? LABELS[who])), ...det(`x-${who}`) }), sealKey({ team: TEAM, epoch: view(log).epoch, key, recipientBoxPub: D[who].boxPub, ephemeralSeed: det(`x-${who}`).ephemeralSeed(D[who].id) })),
			...f,
		});
	};

	// The first entry and the sequence.
	bad("the first entry is not a create", [addBase(upto(0), "bob", { seq: 0, prev: GENESIS_PREV })], "bad-op", 0);
	bad("a second create signed correctly", withLast(2, (l) => signEntry(TEAM, D.alice, { ...next(l), op: "create", subject: subject("alice", "admin"), epoch: FIRST_EPOCH, payload: log[0]!.payload })), "bad-op", 3);
	bad("a create whose founder is not an attended admin", [signEntry(TEAM, D.alice, { seq: 0, prev: GENESIS_PREV, op: "create", subject: subject("alice", "member"), epoch: FIRST_EPOCH, payload: log[0]!.payload })], "bad-founder", 0);
	bad("a create that starts at another epoch", [signEntry(TEAM, D.alice, { seq: 0, prev: GENESIS_PREV, op: "create", subject: subject("alice", "admin"), epoch: 2, payload: log[0]!.payload })], "bad-founder", 0);
	bad("a create signed by someone else", [signEntry(TEAM, D.mallory, { seq: 0, prev: GENESIS_PREV, op: "create", subject: subject("alice", "admin"), epoch: FIRST_EPOCH, payload: log[0]!.payload, by: D.alice.id })], "bad-signature", 0);
	bad("a gap in seq", withLast(1, (l) => addBase(l, "dave", { seq: 3 })), "bad-seq", 2);
	bad("a repeated seq", withLast(2, (l) => addBase(l, "carol", { seq: 2 })), "bad-seq", 3);
	bad("a prev that is not the head's hash", withLast(1, (l) => addBase(l, "dave", { prev: GENESIS_PREV })), "bad-prev", 2);
	bad("an unknown op", withLast(1, (l) => ({ ...addBase(l, "dave"), op: "promote" as never })), "malformed", 2);

	// Signatures and signers.
	bad("a flipped signature", [...upto(1), { ...log[2]!, sig: Buffer.from(log[2]!.sig.map((b, i) => (i === 0 ? b ^ 1 : b))) }], "bad-signature", 2);
	bad("a field changed after signing", [...upto(1), { ...log[2]!, epoch: 9 }], "bad-signature", 2);
	bad("an entry naming one signer and signed by another", withLast(1, (l) => signEntry(TEAM, D.mallory, { ...addBase(l, "dave"), by: D.alice.id })), "bad-signature", 2);
	bad("a signer that is not a member", withLast(1, (l) => addBase(l, "dave", { signer: "mallory" })), "signer-not-member", 2);
	bad("a removed member signing", withLast(6, (l) => addBase(l, "mallory", { signer: "eve" })), "signer-not-member", 7);
	bad("an unattended device signing", withLast(2, (l) => addBase(l, "mallory", { signer: "dave" })), "signer-unattended", 3);

	// Authority.
	bad("a member rotating", withLast(3, (l) => signEntry(TEAM, D.carol, { ...next(l), op: "rotate", subject: null, epoch: 2, payload: rotateEntry({ state: view(l), signer: D.alice, newKey: teamKey(2), ...det("x-rot") }).payload })), "not-admin", 4);
	bad("a member removing", withLast(3, (l) => signEntry(TEAM, D.carol, { ...removeEntry({ state: view(l), signer: D.alice, subjectId: D.dave.id, newKey: teamKey(2), ...det("x-rm") }), by: D.carol.id })), "not-admin", 4);
	bad("a member changing a role", withLast(3, (l) => signEntry(TEAM, D.carol, { ...roleEntry({ state: view(l), signer: D.alice, subjectId: D.carol.id, role: "admin" }), by: D.carol.id })), "not-admin", 4);

	// Epochs and subjects.
	bad("an add at the next epoch", withLast(1, (l) => addBase(l, "dave", { epoch: 2 })), "bad-epoch", 2);
	bad("a remove that keeps the epoch", withLast(2, (l) => signEntry(TEAM, D.alice, { ...removeEntry({ state: view(l), signer: D.alice, subjectId: D.dave.id, newKey: teamKey(2), ...det("x-rm") }), epoch: 1 })), "bad-epoch", 3);
	bad("a rotate that skips an epoch", withLast(2, (l) => signEntry(TEAM, D.alice, { ...rotateEntry({ state: view(l), signer: D.alice, newKey: teamKey(2), ...det("x-rot") }), epoch: 3 })), "bad-epoch", 3);
	bad("an add with no subject", withLast(1, (l) => signEntry(TEAM, D.alice, { ...addBase(l, "dave"), subject: null })), "bad-subject", 2);
	bad("an add of a member again", withLast(2, (l) => addBase(l, "bob")), "duplicate-member", 3);
	bad("an add as admin", withLast(1, (l) => signEntry(TEAM, D.alice, { ...addBase(l, "dave"), subject: subject("dave", "admin", false) })), "bad-role", 2);
	bad("an add of a removed device", withLast(7, (l) => addBase(l, "eve", { signer: "alice", label: "eve-again" })), "banned", 8);
	bad("a remove of a stranger", withLast(2, (l) => signEntry(TEAM, D.alice, { ...removeEntry({ state: view(l), signer: D.alice, subjectId: D.dave.id, newKey: teamKey(2), ...det("x-rm") }), subject: subject("mallory", "member") })), "unknown-member", 3);
	bad("a remove that gets the role wrong", withLast(4, (l) => signEntry(TEAM, D.alice, { ...removeEntry({ state: view(l), signer: D.alice, subjectId: D.bob.id, newKey: teamKey(2), ...det("x-rm") }), subject: subject("bob", "member") })), "bad-subject", 5);
	bad("a rotate with a subject", withLast(2, (l) => signEntry(TEAM, D.alice, { ...rotateEntry({ state: view(l), signer: D.alice, newKey: teamKey(2), ...det("x-rot") }), subject: subject("bob", "member") })), "bad-subject", 3);
	bad("a role change to the same keys but another attended flag", withLast(2, (l) => signEntry(TEAM, D.alice, { ...roleEntry({ state: view(l), signer: D.alice, subjectId: D.bob.id, role: "admin" }), subject: subject("bob", "admin", false) })), "bad-subject", 3);
	bad("an unattended device made admin", withLast(2, (l) => roleEntry({ state: view(l), signer: D.alice, subjectId: D.dave.id, role: "admin" })), "unattended-admin", 3);
	bad("a role whose payload names another role", withLast(2, (l) => signEntry(TEAM, D.alice, { ...roleEntry({ state: view(l), signer: D.alice, subjectId: D.bob.id, role: "admin" }), payload: enc(str("member")) })), "bad-payload", 3);

	// The last attended admin.
	bad("removing the last attended admin", withLast(2, (l) => removeEntry({ state: view(l), signer: D.alice, subjectId: D.alice.id, newKey: teamKey(2), ...det("x-rm") })), "no-attended-admin", 3);
	bad("demoting the last attended admin", withLast(2, (l) => roleEntry({ state: view(l), signer: D.alice, subjectId: D.alice.id, role: "member" })), "no-attended-admin", 3);

	// Payloads.
	bad("an add with a payload that is no pair", withLast(1, (l) => addBase(l, "dave", { payload: Buffer.from("junk") })), "bad-payload", 2);
	bad("an add with a label cut short", withLast(1, (l) => addBase(l, "dave", { payload: enc(Buffer.alloc(5), Buffer.alloc(5)) })), "bad-payload", 2);
	const noCarol = removeEntry({ state: view(upto(5)), signer: D.alice, subjectId: D.carol.id, newKey: teamKey(2), ...det("x-rm") });
	bad("a rotate that seals to fewer devices than remain", withLast(5, (l) => signEntry(TEAM, D.alice, { ...next(l), op: "rotate", subject: null, epoch: 2, payload: noCarol.payload })), "sealed-set-mismatch", 6);
	const stray = signEntry(TEAM, D.alice, { ...next(upto(5)), op: "rotate", subject: null, epoch: 2, payload: enc(list([...[D.alice, D.bob, D.carol, D.dave, D.eve, D.mallory].map((d) => enc(str(d.id), Buffer.alloc(1)))]), Buffer.alloc(40)) });
	bad("a rotate that seals to a stranger", [...upto(5), stray], "sealed-set-mismatch", 6);
	bad("a rotate with no table", withLast(2, (l) => signEntry(TEAM, D.alice, { ...next(l), op: "rotate", subject: null, epoch: 2, payload: Buffer.from("x") })), "bad-payload", 3);

	// What only the device that holds the keys can see.
	const forgedAdd = (to: Who, key = teamKey(1), label = LABELS.bob) => signEntry(TEAM, D.alice, {
		...next(upto(0)), op: "add", subject: subject("bob", "member"), epoch: 1,
		payload: enc(sealUnderTeamKey({ team: TEAM, epoch: 1, key, plaintext: enc(str(label)), ...det("x-bob") }), sealKey({ team: TEAM, epoch: 1, key: teamKey(1), recipientBoxPub: D[to].boxPub, ephemeralSeed: det("x-bob").ephemeralSeed(D[to].id) })),
	});
	bad("a team key sealed to another device", [log[0]!, forgedAdd("carol")], "fork-sealed-key", 1, "bob");
	bad("a label under another key", [log[0]!, forgedAdd("bob", teamKey(9))], "fork-label", 1, "alice");
	bad("a label that is not a label", [log[0]!, forgedAdd("bob", teamKey(1), "bad/label")], "fork-label", 1, "alice");
	const oldTable = removeEntry({ state: view(upto(5)), signer: D.alice, subjectId: D.eve.id, newKey: teamKey(2), ...det("x-rm") });
	const tableLess = signEntry(TEAM, D.alice, { ...oldTable, ...next(upto(5)), payload: enc(list([D.alice, D.bob, D.carol, D.dave].map((d) => enc(str(d.id), sealKey({ team: TEAM, epoch: 2, key: teamKey(2), recipientBoxPub: d.boxPub, ephemeralSeed: det("x-rm").ephemeralSeed(d.id) })))), sealUnderTeamKey({ team: TEAM, epoch: 2, key: teamKey(2), plaintext: list([enc(str(D.alice.id), str("alice-mac"))]), ...det("x-rm") })) });
	bad("a remove whose label table lacks a remaining member", [...upto(5), tableLess], "fork-label", 6, "alice");
	const toWrong = signEntry(TEAM, D.alice, { ...next(upto(5)), op: "rotate", subject: null, epoch: 2, payload: enc(list([D.alice, D.bob, D.carol, D.dave, D.eve].map((d) => enc(str(d.id), sealKey({ team: TEAM, epoch: 2, key: teamKey(2), recipientBoxPub: (d === D.alice ? D.mallory : d).boxPub, ephemeralSeed: det("x-rot").ephemeralSeed(d.id) })))), sealUnderTeamKey({ team: TEAM, epoch: 2, key: teamKey(2), plaintext: list([D.alice, D.bob, D.carol, D.dave, D.eve].map((d) => enc(str(d.id), str(LABELS[(Object.keys(D) as Who[]).find((k) => D[k] === d)!])))), ...det("x-rot") })) });
	bad("a rotate whose key sealed to this device does not open", [...upto(5), toWrong], "fork-sealed-key", 6, "alice");

	// Bytes that are not an entry at all.
	cases.push({ name: "an entry that is not an entry", entries: [...bytes(upto(2)), Buffer.from("not an entry")], reason: "malformed", seq: 3 });
	cases.push({ name: "an entry with a signature of the wrong length", entries: [...bytes(upto(1)), enc(int(2), Buffer.alloc(32), str("add"), Buffer.alloc(0), str("x"), int(1), Buffer.alloc(0), Buffer.alloc(3))], reason: "malformed", seq: 2 });
	return cases;
}
