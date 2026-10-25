import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEntry, encodeEntry, entryHash, replayEncoded, replayRoster, type RosterEntry } from "../src/link/roster.ts";
import { DEVICES, LABELS, mainLog, TEAM, teamKey, view } from "./link/scenario.ts";
import { rosterCases } from "./link/roster-cases.ts";

// The roster's log and its verifier (src/link/roster.ts): an honest log replays, and every rule has an entry that breaks it.

test("an honest log replays: roles, epochs, labels, bans, and keys end up as the entries say", () => {
	const log = mainLog(), s = view(log);
	assert.equal(log.length, 8);
	assert.deepEqual([...s.members.keys()].sort(), [DEVICES.alice, DEVICES.bob, DEVICES.carol, DEVICES.dave].map((d) => d.id).sort());
	assert.equal(s.members.get(DEVICES.bob.id)!.role, "admin");
	assert.equal(s.members.get(DEVICES.dave.id)!.attended, false);
	assert.deepEqual([...s.banned], [DEVICES.eve.id]);
	assert.equal(s.epoch, 3);
	assert.equal(s.epochStart, 7);
	assert.deepEqual(s.head, { seq: 7, hash: entryHash(log[7]!) });
	assert.deepEqual([...s.keys.keys()].sort(), [1, 3].sort().concat(2).sort(), "alice holds all three keys");
	for (const who of ["alice", "bob", "carol", "dave"] as const) assert.equal(s.members.get(DEVICES[who].id)!.label, LABELS[who]);
	assert.deepEqual(s.keys.get(3), teamKey(3));
});

test("entries survive their own encoding, and replaying the bytes gives the same roster", () => {
	const log = mainLog();
	for (const e of log) assert.deepEqual(decodeEntry(encodeEntry(e)), e);
	const r = replayEncoded(TEAM, log.map(encodeEntry), { self: DEVICES.alice, keys: new Map([[1, teamKey(1)]]) });
	assert.ok(r.ok);
	assert.deepEqual(r.value.head, view(log).head);
});

test("a device replays the log from its own add: it opens the key sealed to it and reads the labels it can", () => {
	const log = mainLog();
	for (const who of ["bob", "carol", "dave"] as const) {
		const s = view(log, DEVICES[who]);
		assert.deepEqual(s.keys.get(3), teamKey(3), who);
		assert.equal(s.members.get(DEVICES.alice.id)!.label, LABELS.alice, `${who} reads every label of the current epoch`);
	}
	const upTo = view(log.slice(0, 3), DEVICES.dave);
	assert.deepEqual([...upTo.keys.keys()], [1], "dave joined in epoch 1 and holds that key");
	assert.equal(upTo.members.get(DEVICES.bob.id)!.label, LABELS.bob, "a late joiner reads the add entries after the table");
});

test("a removed device stops at its removal: it holds no later key and the log still verifies for it", () => {
	const log = mainLog(), s = view(log, DEVICES.eve);
	assert.equal(s.selfRemoved, true);
	assert.deepEqual([...s.keys.keys()], [1]);
	assert.equal(s.epoch, 3, "it still sees the roster move on");
});

test("without a device the verifier checks the rules plaintext decides, and nothing more", () => {
	const r = replayRoster(TEAM, mainLog());
	assert.ok(r.ok);
	assert.equal(r.value.members.get(DEVICES.alice.id)!.label, undefined);
	assert.equal(r.value.keys.size, 0);
});

test("every rule has an entry that breaks it, with a named reason and the position it fails at", () => {
	const cases = rosterCases(), reasons = new Set(cases.map((c) => c.reason));
	assert.ok(cases.length >= 40);
	for (const reason of ["malformed", "bad-seq", "bad-prev", "bad-op", "bad-founder", "signer-not-member", "bad-signature", "signer-unattended", "not-admin", "bad-epoch", "bad-subject", "bad-role", "banned", "duplicate-member", "unknown-member", "unattended-admin", "no-attended-admin", "bad-payload", "sealed-set-mismatch", "fork-sealed-key", "fork-label"])
		assert.ok(reasons.has(reason as never), `a case for ${reason}`);
	for (const c of cases) {
		const self = c.self ? DEVICES[c.self] : undefined, r = replayEncoded(TEAM, c.entries, { self, keys: c.self === "alice" ? new Map([[1, teamKey(1)]]) : undefined });
		assert.equal(r.ok, false, c.name);
		if (!r.ok) assert.deepEqual({ reason: r.reason, seq: r.seq }, { reason: c.reason, seq: c.seq }, c.name);
	}
});

test("an entry is not an entry of another team", () => {
	const r = replayRoster(Buffer.alloc(16, 1), mainLog());
	assert.ok(!r.ok && r.reason === "bad-signature" && r.seq === 0);
});

test("the log is append-only: a changed entry changes every hash after it", () => {
	const log = mainLog(), other: RosterEntry[] = log.map((e) => ({ ...e }));
	other[3] = { ...other[3]!, epoch: 7 };
	assert.notDeepEqual(entryHash(other[3]!), entryHash(log[3]!));
	const r = replayRoster(TEAM, other, { self: DEVICES.alice });
	assert.ok(!r.ok);
});
