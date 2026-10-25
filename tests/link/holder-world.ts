import { Buffer } from "node:buffer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinkConfig } from "../../src/link/config.ts";
import type { DeviceKeys } from "../../src/link/device.ts";
import { encodeEntry, replayRoster, type RosterEntry, type RosterState, addEntry, createEntry } from "../../src/link/roster.ts";
import { RelayClient } from "../../src/link/relay.ts";
import type { NetView } from "../../src/link/routing.ts";
import type { LinkStore, TeamFile } from "../../src/link/store.ts";
import { DEVICES, det, LABELS, TEAM, teamKey, view } from "./scenario.ts";
import type { FakeRelay } from "./fake-relay.ts";

// Two devices of one team on disk, as a holder finds them: device.json, device.id, and a team file with the roster copy and the keys.

export const TEAM_HEX = TEAM.toString("hex");
export const alice = DEVICES.alice, bob = DEVICES.bob, carol = DEVICES.carol;

/** The roster of alice (founder), with bob and, when asked, carol added by alice. */
export function rosterOf(members: ("bob" | "carol")[] = ["bob"]): RosterEntry[] {
	const log: RosterEntry[] = [createEntry({ team: TEAM, founder: alice, label: LABELS.alice, teamKey: teamKey(1), ...det("create") })];
	for (const who of members) log.push(addEntry({ state: view(log), signer: alice, record: DEVICES[who], label: LABELS[who], attended: true, ...det(`add-${who}`) }));
	return log;
}

export function writeDevice(store: LinkStore, keys: DeviceKeys, label: string) {
	store.ensure();
	writeFileSync(join(store.dir, "device.json"), JSON.stringify({ v: 1, signSeed: keys.signSeed.toString("hex"), boxSeed: keys.boxSeed.toString("hex"), label, nextSeq: 1 }), { mode: 0o600 });
	writeFileSync(join(store.dir, "device.id"), `${keys.id}\n`, { mode: 0o600 });
}

/** The state of `self` after replaying `entries` (the founder holds the first key; the rest open it from their add). */
export function stateOf(entries: RosterEntry[], self: DeviceKeys): RosterState {
	const r = replayRoster(TEAM, entries, { self, keys: self.id === alice.id ? new Map([[1, teamKey(1)]]) : undefined });
	if (!r.ok) throw new Error(`replay failed: ${r.reason} at ${r.seq}`);
	return r.value;
}

export function writeTeam(store: LinkStore, entries: RosterEntry[], self: DeviceKeys, over: Partial<TeamFile> = {}) {
	const state = stateOf(entries, self);
	mkdirSync(join(store.dir, "teams"), { recursive: true });
	const file: TeamFile = { v: 1, team: TEAM_HEX, relay: "http://relay.test", entries: entries.map((e) => Buffer.from(encodeEntry(e)).toString("base64url")), keys: Object.fromEntries([...state.keys].map(([epoch, key]) => [String(epoch), key.toString("hex")])), lastEventId: 0, lastSeq: {}, ...over };
	writeFileSync(join(store.dir, "teams", `${TEAM_HEX}.json`), JSON.stringify(file), { mode: 0o600 });
}

export const config = (project: string, share: "presence" | "status" = "status"): (() => LinkConfig) => () => ({ teams: new Map([[TEAM_HEX, { project, share, name: "moldplan" }]]), trust: new Map(), problems: [] });

/** A net with the given towers: [session id, workspace id, workspace label, cwd]. */
export function netOf(towers: [string, string, string, string][], extra: Partial<NetView> = {}): NetView {
	const workspaces = towers.map(([, id, label]) => ({ workspace_id: id, label, tokens: {} }));
	const panes = towers.map(([, ws, , cwd], i) => ({ pane_id: `p${i}`, tab_id: `${ws}:t0`, workspace_id: ws, cwd, agent_status: "idle", tokens: { sb_role: "tower" } }));
	const sessions = towers.map(([id], i) => ({ id, herdrLocation: { status: "current", paneId: `p${i}` } }));
	const tabs = towers.map(([, ws]) => ({ tab_id: `${ws}:t0`, workspace_id: ws, label: "tower" }));
	return { workspaces, panes, sessions, tabs, ...extra };
}

export const clientFor = (relay: FakeRelay) => (url: string, device: DeviceKeys) => new RelayClient({ url, device, fetch: relay.fetch, timeoutMs: 2000 });
