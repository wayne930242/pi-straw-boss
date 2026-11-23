import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LinkHolder } from "../src/link/holder.ts";
import { towerAt, towersFor, type NetView } from "../src/link/routing.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { alice, bob, clientFor, config, netOf, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";

// A tower the sb server runs with no tab (towerRuns.headless; review REV2-F001): Straw Link finds it through the server's own record of the identity (`NetView.served`), never through what a session says.
// Only a request the server made as one of its runs (`served`) may come from it; a session named like a tower, a tower identity the server did not register, and a checkout outside the team's project are refused.
// Red on fb807eea: send and requestConfirm wanted a Herdr pane, and towersFor listed none of these towers.

let root = "", project = "", outside = "", relay: FakeRelay;
const stops: LinkHolder[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-served-"));
	project = join(root, "project");
	outside = join(root, "elsewhere");
	mkdirSync(join(project, "alpha"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	relay = new FakeRelay();
	relay.addTeam(TEAM, [alice.id, bob.id], rosterOf(["bob"]));
});
afterEach(async () => {
	for (const h of stops.splice(0)) await h.stop();
	rmSync(root, { recursive: true, force: true });
});

/** The box's net: no pane holds a tower; the server registered sb-tower-wa (checkout in the project) and sb-tower-wo (checkout outside it); `sb-tower-x` is only a session. */
const net = (): NetView => ({
	...netOf([]),
	sessions: [{ id: "sb-tower-wa" }, { id: "sb-tower-wo" }, { id: "sb-tower-x" }],
	workspaces: [{ workspace_id: "wA", label: "Alpha" }, { workspace_id: "wO", label: "Out" }, { workspace_id: "wX", label: "X" }],
	served: [{ id: "sb-tower-wa", workspace: "wA", cwd: join(project, "alpha") }, { id: "sb-tower-wo", workspace: "wO", cwd: outside }],
} as NetView);
const holder = (keys: typeof alice, name: string, view: () => NetView) => {
	const store = new LinkStore(join(root, name), { alive: () => true });
	store.ensure();
	writeDevice(store, keys, `${name}-mac`);
	writeTeam(store, rosterOf(["bob"]), keys);
	const h = new LinkHolder({ store, isHolder: () => true, config: config(project), net: async () => view(), relay: clientFor(relay), offer: () => {}, notify: () => {}, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000 });
	stops.push(h);
	return h;
};
const confirm = (h: LinkHolder, fromSession: string, served: boolean, dialogId: string) => h.requestConfirm({ fromSession, served, team: TEAM_HEX, device: bob.id, dialogId, digest: "d", tool: "bash", args: "{}", tower: "Alpha" });

test("requestConfirm and send: the server's own tabless tower may, a session named like one, an unregistered identity, and a checkout outside the project may not", async () => {
	const a = holder(alice, "a", net), b = holder(bob, "b", () => netOf([]));
	await Promise.all([a.start(), b.start()]);
	assert.deepEqual(await confirm(a, "sb-tower-wa", true, "D1"), { ok: true });
	await until(() => b.confirmRequests().length === 1, 3000, "the confirm on bob");
	assert.match(String((await confirm(a, "sb-tower-wa", false, "D2") as { error?: string }).error), /Only the tower/, "the same id from a session is not the server's run");
	assert.match(String((await confirm(a, "sb-tower-x", true, "D3") as { error?: string }).error), /Only the tower/, "an identity the server did not register");
	assert.match(String((await confirm(a, "sb-tower-wo", true, "D4") as { error?: string }).error), /Only the tower/, "a checkout outside the team's project");
	const sent = await a.send({ fromSession: "sb-tower-wa", served: true, device: bob.id, text: "hello", reply: false });
	assert.equal(sent.ok, true, JSON.stringify(sent));
	assert.match(String((await a.send({ fromSession: "sb-tower-wa", device: bob.id, text: "hello", reply: false }) as { error?: string }).error), /Only the tower/);
	assert.match(String((await a.send({ fromSession: "sb-tower-x", served: true, device: bob.id, text: "hello", reply: false }) as { error?: string }).error), /Only the tower/);
	assert.match(String((await a.send({ fromSession: "sb-tower-wo", served: true, device: bob.id, text: "hello", reply: false }) as { error?: string }).error), /not inside the project/);
});

test("towersFor lists the server's tabless tower of the project, by its record's checkout, and no session that only bears a tower's name", () => {
	const picks = towersFor(net(), project);
	assert.deepEqual(picks.map((p) => [p.session.id, p.workspace.workspace_id, p.pane]), [["sb-tower-wa", "wA", undefined]]);
	assert.deepEqual(towersFor(net(), project, "Alpha").map((p) => p.session.id), ["sb-tower-wa"]);
	assert.deepEqual(towersFor(net(), project, "X"), []);
	assert.deepEqual(towersFor({ ...net(), served: [] }, project), [], "headless off: the server lists none, as in 0.84.0");
	// A pane-backed tower is found as before, and wins its pane's answer over any record.
	const both = { ...netOf([["s-pane", "wP", "Pane", join(project, "alpha")]]), served: net().served } as NetView;
	assert.deepEqual(towerAt(both, "s-pane"), { cwd: join(project, "alpha"), workspace: "wP" });
	assert.equal(towerAt(both, "sb-tower-wa"), undefined, "not served: a record is not believed");
});
