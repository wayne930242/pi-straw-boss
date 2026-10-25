import { sha256 } from "../../src/link/crypto.ts";
import { deviceFromSeeds, type DeviceKeys } from "../../src/link/device.ts";
import { addEntry, createEntry, removeEntry, replayRoster, rotateEntry, roleEntry, type Randomness, type RosterEntry, type RosterState } from "../../src/link/roster.ts";

// Fixed keys, team, and randomness for Straw Link's tests and test vectors: nothing here is random, so every byte repeats on every run.

const dev = (n: number) => deviceFromSeeds(Buffer.alloc(32, n), Buffer.alloc(32, n + 0x40));
export const DEVICES = { alice: dev(1), bob: dev(2), carol: dev(3), dave: dev(4), eve: dev(5), mallory: dev(6) } satisfies Record<string, DeviceKeys>;
export type Who = keyof typeof DEVICES;
export const TEAM = Buffer.alloc(16, 0x0f);
/** The team key of epoch `n`. */
export const teamKey = (n: number) => Buffer.alloc(32, 0x60 + n);
/** A nonce and ephemeral seeds derived from `tag`. */
export const det = (tag: string): Required<Randomness> => ({
	nonce: sha256(Buffer.from(`nonce/${tag}`)).subarray(0, 12),
	ephemeralSeed: (id) => sha256(Buffer.from(`eph/${tag}/${id}`)),
});
export const LABELS: Record<Who, string> = { alice: "alice-mac", bob: "bob-mac", carol: "carol-pc", dave: "ci-box", eve: "eve-pc", mallory: "mallory" };

/** Alice's view of a log: she holds the first key, opens every key sealed to her, and reads the labels. */
export const view = (entries: RosterEntry[], self: DeviceKeys = DEVICES.alice): RosterState => {
	const r = replayRoster(TEAM, entries, { self, keys: self.id === DEVICES.alice.id ? new Map([[1, teamKey(1)]]) : undefined });
	if (!r.ok) throw new Error(`replay failed: ${r.reason} at ${r.seq}`);
	return r.value;
};

/** The log most tests start from, one entry per step; `steps[i]` is the state after entry i. */
export function mainLog(): RosterEntry[] {
	const log: RosterEntry[] = [createEntry({ team: TEAM, founder: DEVICES.alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	const push = (build: (state: RosterState) => RosterEntry) => void log.push(build(view(log)));
	const add = (signer: Who, who: Who, attended = true) => push((state) => addEntry({ state, signer: DEVICES[signer], record: DEVICES[who], label: LABELS[who], attended, ...det(`add-${who}`) }));
	add("alice", "bob");
	add("alice", "dave", false);
	add("bob", "carol");
	push((state) => roleEntry({ state, signer: DEVICES.alice, subjectId: DEVICES.bob.id, role: "admin" }));
	add("carol", "eve");
	push((state) => removeEntry({ state, signer: DEVICES.bob, subjectId: DEVICES.eve.id, newKey: teamKey(2), ...det("remove-eve") }));
	push((state) => rotateEntry({ state, signer: DEVICES.alice, newKey: teamKey(3), ...det("rotate") }));
	return log;
}
