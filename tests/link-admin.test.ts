import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { decoyWords, shuffled } from "../src/link/admin.ts";
import { editLinkConfig, readLinkConfig } from "../src/link/config.ts";
import { safetyWords } from "../src/link/join.ts";
import { LinkHolder } from "../src/link/holder.ts";
import { LinkStore } from "../src/link/store.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { until } from "./link/fakes.ts";
import { clientFor, netOf } from "./link/holder-world.ts";

// What the GUI does to teams, in the link holder (docs/specs/2026-10-25-straw-link.md, GUI, Joining with a QR code, Roster): create, invite, the join request
// and its safety words, join, the roster's admin actions, trust, leave, and the notices. Two holders (two computers) share one in-memory relay.

let root = "";
let relay: FakeRelay;
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-admin-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	rmSync(root, { recursive: true, force: true });
});

interface Computer { name: string; dir: string; stateDir: string; home: string; project: string; store: LinkStore; holder: LinkHolder; notices: string[]; clock: { skew: number }; config(): ReturnType<typeof readLinkConfig> }

async function computer(name: string, label: string): Promise<Computer> {
	const stateDir = join(root, name), home = join(root, `${name}-home`), project = join(home, "project"), dir = join(stateDir, "link");
	mkdirSync(project, { recursive: true });
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	const store = new LinkStore(dir, { alive: () => true }), notices: string[] = [], clock = { skew: 0 };
	const agentDir = join(home, ".pi", "agent");
	const config = () => readLinkConfig(stateDir, { home, agentDir });
	const holder = new LinkHolder({
		store, isHolder: () => true, config, stateDir, home, agentDir, net: async () => netOf([]), relay: clientFor(relay),
		offer: () => {}, notify: (text) => void notices.push(text), now: () => Date.now() + clock.skew, backoff: () => 5, drainMs: 20, presenceMs: 60_000, postWaitMs: 2000,
	});
	await store.withLock(() => (store.enable(), store.ensureDevice()));
	// The label this computer goes by in a team.
	const file = JSON.parse(readFileSync(join(dir, "device.json"), "utf8")) as { label: string };
	writeFileSync(join(dir, "device.json"), JSON.stringify({ ...file, label }), { mode: 0o600 });
	await holder.start();
	stops.push(() => holder.stop());
	return { name, dir, stateDir, home, project, store, holder, notices, clock, config };
}

const TOKEN = "srt1_test";
async function team(a: Computer): Promise<string> {
	relay.tokens.add(TOKEN);
	const made = await a.holder.admin.createTeam({ relay: "http://127.0.0.1:9", token: TOKEN, project: a.project, label: "alice-mac" });
	assert.ok(made.ok, made.ok ? "" : made.error);
	return made.team;
}
/** A joins B through an invite: B pastes it, A taps `pick` ("right" or a wrong index), B names its project. */
async function pair(a: Computer, b: Computer, teamId: string, o: { forDevice?: string; wrong?: boolean } = {}) {
	const invite = await a.holder.admin.invite({ team: teamId, ...(o.forDevice ? { forDevice: o.forDevice } : {}) });
	assert.ok(invite.ok, invite.ok ? "" : invite.error);
	await until(() => relay.streams.some((s) => s.team === teamId && s.device === a.holder.deviceId), 3000, "A's stream");
	const started = await b.holder.admin.joinStart({ text: invite.text });
	assert.ok(started.ok, started.ok ? "" : started.error);
	const request = await until(() => a.holder.admin.joinRequests()[0], 3000, "the join request at A");
	return { invite, started, request };
}
const rightPick = (a: Computer, words: string[]) => {
	const req = a.holder.admin.joinRequests()[0]!;
	return req.sets.findIndex((s) => s.join(" ") === words.join(" "));
};

test("a team is made on the relay with its token, written to the team file and config.json, and started; a used token, a bad relay, and the home folder are refused", async () => {
	const a = await computer("a", "alice-mac");
	relay.tokens.add(TOKEN);
	writeFileSync(join(a.stateDir, "config.json"), JSON.stringify({ towerModel: "keep-me", link: { trust: {} } }));
	assert.equal((await a.holder.admin.createTeam({ relay: "http://example.org", token: TOKEN, project: a.project })).ok, false, "plain http only on this computer");
	assert.equal((await a.holder.admin.createTeam({ relay: "https://example.org/path", token: TOKEN, project: a.project })).ok, false, "a relay URL is an origin");
	const home = await a.holder.admin.createTeam({ relay: "http://127.0.0.1:9", token: TOKEN, project: a.home });
	assert.deepEqual(home, { ok: false, error: "The project may not be the home folder" });
	assert.equal((await a.holder.admin.createTeam({ relay: "http://127.0.0.1:9", token: "wrong", project: a.project })).ok, false);
	const made = await a.holder.admin.createTeam({ relay: "http://127.0.0.1:9", token: TOKEN, project: a.project, share: "presence" });
	assert.ok(made.ok);
	const config = JSON.parse(readFileSync(join(a.stateDir, "config.json"), "utf8")) as { towerModel: string; link: { relay: string; teams: Record<string, { project: string; share: string }> } };
	assert.equal(config.towerModel, "keep-me", "the rest of config.json is kept");
	assert.deepEqual(config.link.teams[made.team], { project: a.project, share: "presence" });
	assert.equal(config.link.relay, "http://127.0.0.1:9", "the first relay becomes the default");
	assert.deepEqual(a.store.teamIds(), [made.team]);
	const view = a.holder.view();
	assert.equal(view.teams.length, 1);
	assert.deepEqual(view.teams[0]!.members.map((m) => [m.label, m.role, m.attended, m.self]), [["alice-mac", "admin", true, true]]);
	assert.equal((await a.holder.admin.createTeam({ relay: "http://127.0.0.1:9", token: TOKEN, project: a.project })).ok, false, "the token worked once");
});

test("an invite becomes a join request with three sets of words; the right set adds the joiner, who reads every label (R-F016)", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "bob-mac");
	const id = await team(a);
	const { started, request } = await pair(a, b, id);
	assert.equal(request.sets.length, 3);
	assert.equal(new Set(request.sets.map((s) => s.join(" "))).size, 3, "three different sets");
	assert.equal(request.label, "bob-mac");
	assert.ok(request.sets.some((s) => s.join(" ") === started.words.join(" ")), "one is the set on B's screen");
	assert.equal(a.holder.view().alerts.filter((x) => x.kind === "join-request").length, 1, "a notice while it waits");
	const done = await a.holder.admin.decide({ id: request.id, pick: rightPick(a, started.words) });
	assert.deepEqual(done, { ok: true, joined: true });
	assert.equal(a.holder.admin.joinRequests().length, 0);
	assert.equal(a.store.invites().length, 0, "an invite works once");
	// B names its project; the join completes and the team starts there.
	assert.equal((await b.holder.admin.joinProject({ project: b.project })).ok, true);
	await until(() => b.holder.admin.joinView()?.state === "done", 3000, "B's join");
	const bob = b.holder.view().teams[0]!;
	assert.deepEqual(bob.members.map((m) => [m.label, m.role, m.attended]).sort(), [["alice-mac", "admin", true], ["bob-mac", "member", true]]);
	assert.ok(bob.members.every((m) => m.labelKnown), "the late joiner reads both labels");
	assert.equal(b.config().teams.get(id)?.project, b.project);
	assert.equal(a.holder.view().teams[0]!.members.length, 2);
});

test("a wrong set ends the invite and adds nobody; a second request to it is refused by the relay", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "bob-mac");
	const id = await team(a);
	const { started, request } = await pair(a, b, id);
	const right = rightPick(a, started.words), wrong = (right + 1) % 3;
	const out = await a.holder.admin.decide({ id: request.id, pick: wrong });
	assert.equal(out.ok, false);
	assert.match(out.ok ? "" : out.error, /invite is ended/);
	assert.equal(a.holder.view().teams[0]!.members.length, 1, "nobody joined");
	assert.equal(a.store.invites().length, 0);
	assert.equal(a.holder.admin.joinRequests().length, 0);
	// B asked once; the relay took that request and holds no other for this invite, so B cannot ask again.
	const text = (await a.holder.admin.invite({ team: id }));
	assert.ok(text.ok);
	assert.equal((await b.holder.admin.joinStart({ text: text.text })).ok, true, "a fresh invite takes one request");
	assert.equal((await b.holder.admin.joinStart({ text: text.text })).ok, false, "and no second");
});

test("an unattended device joins by a pinned invite that only its id fits, and A approves without words; it joins unattended", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box");
	const id = await team(a);
	assert.equal((await a.holder.admin.invite({ team: id, forDevice: "nope" })).ok, false);
	const wrongId = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
	const other = await a.holder.admin.invite({ team: id, forDevice: wrongId });
	assert.ok(other.ok);
	const refused = await b.holder.admin.joinStart({ text: other.text });
	assert.equal(refused.ok, false, "B is not the pinned device");
	const { request } = await pair(a, b, id, { forDevice: b.holder.deviceId });
	assert.equal(request.unattended, true);
	assert.deepEqual(request.sets, [], "no words: the pinned id stands in for them");
	assert.equal((await a.holder.admin.decide({ id: request.id, pick: 0 })).ok, true, "a pick is not an approval");
	assert.equal(a.holder.view().teams[0]!.members.length, 1);
});

test("an unattended joiner approved by A is in the roster as unattended", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "ci-box");
	const id = await team(a);
	const { request } = await pair(a, b, id, { forDevice: b.holder.deviceId });
	assert.deepEqual(await a.holder.admin.decide({ id: request.id, approve: true }), { ok: true, joined: true });
	const ci = a.holder.view().teams[0]!.members.find((m) => m.label === "ci-box")!;
	assert.equal(ci.attended, false);
	assert.equal(ci.role, "member");
});

test("an admin removes a device, changes a role, and rotates; a member cannot; the last attended admin stays", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "bob-mac");
	const id = await team(a);
	const { started, request } = await pair(a, b, id);
	await a.holder.admin.decide({ id: request.id, pick: rightPick(a, started.words) });
	await b.holder.admin.joinProject({ project: b.project });
	await until(() => b.holder.admin.joinView()?.state === "done", 3000, "B's join");
	await until(() => b.holder.view().teams[0]?.members.length === 2, 3000, "B's roster");
	assert.equal(a.holder.view().teams[0]!.secondAdmin.length, 1, "A is told to make a second attended admin");
	const bobId = b.holder.deviceId!;
	assert.match(JSON.stringify(await b.holder.admin.rotate({ team: id })), /Only an admin/);
	assert.match(JSON.stringify(await a.holder.admin.remove({ team: id, device: a.holder.deviceId! })), /cannot remove itself/);
	assert.equal((await a.holder.admin.role({ team: id, device: bobId, role: "admin" })).ok, true);
	assert.equal(a.holder.view().teams[0]!.secondAdmin.length, 0);
	assert.equal(a.holder.view().teams[0]!.onlyAdmin, false);
	assert.equal((await a.holder.admin.rotate({ team: id })).ok, true);
	assert.equal(a.holder.view().teams[0]!.epoch, 2);
	await until(() => b.holder.view().teams[0]?.epoch === 2, 3000, "B follows the rotation");
	assert.equal((await a.holder.admin.role({ team: id, device: bobId, role: "member" })).ok, true, "A stays an attended admin");
	assert.match(JSON.stringify(await a.holder.admin.role({ team: id, device: a.holder.deviceId!, role: "member" })), /without an attended admin/);
	assert.equal((await a.holder.admin.remove({ team: id, device: bobId })).ok, true);
	assert.equal(a.holder.view().teams[0]!.members.length, 1);
	assert.equal(a.holder.view().teams[0]!.epoch, 3);
});

test("trust is written to config.json for a member of a team and lapses to reply when set back; leaving forgets the team here", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "bob-mac");
	const id = await team(a);
	const { started, request } = await pair(a, b, id);
	await a.holder.admin.decide({ id: request.id, pick: rightPick(a, started.words) });
	const bobId = b.holder.deviceId!;
	assert.equal((await a.holder.admin.trust({ device: "a".repeat(26), level: "dispatch" })).ok, false, "a stranger");
	assert.equal((await a.holder.admin.trust({ device: bobId, level: "forward" })).ok, true);
	assert.equal(a.config().trust.get(bobId), "forward");
	assert.equal(a.holder.view().teams[0]!.members.find((m) => m.id === bobId)!.trust, "forward");
	assert.equal((await a.holder.admin.trust({ device: bobId, level: "reply" })).ok, true);
	assert.equal(a.config().trust.has(bobId), false);
	// The only attended admin does not leave a team with others unless it says so.
	const refused = await a.holder.admin.leave({ team: id });
	assert.match(refused.ok ? "" : refused.error, /only attended admin/);
	assert.equal((await a.holder.admin.leave({ team: id, force: true })).ok, true);
	assert.deepEqual(a.store.teamIds(), []);
	assert.equal(a.config().teams.size, 0);
	assert.equal(a.holder.view().teams.length, 0);
});

test("notices: the relay down for 2 minutes, a teammate on another roster head for 2 minutes, and a stopped team", async () => {
	const a = await computer("a", "alice-mac");
	const id = await team(a);
	assert.deepEqual(a.holder.view().alerts, []);
	relay.dropStreams();
	relay.refuseStreams = 503;
	await until(() => a.holder.view().alerts.length === 0 && true, 500).catch(() => undefined);
	a.clock.skew = 3 * 60_000;
	await until(() => a.holder.view().alerts.some((x) => x.kind === "unreachable"), 3000, "the relay-unreachable notice");
	assert.equal(a.holder.view().alerts.find((x) => x.kind === "unreachable")!.team, id);
});

test("the invite text of one still on disk can be shown again, and a cancelled invite is gone", async () => {
	const a = await computer("a", "alice-mac");
	const id = await team(a);
	const made = await a.holder.admin.invite({ team: id });
	assert.ok(made.ok);
	const again = a.holder.admin.inviteText(made.hash);
	assert.ok(again.ok);
	assert.equal(again.text, made.text);
	assert.equal(a.holder.view().invites.length, 1);
	await a.holder.admin.cancelInvite(made.hash);
	assert.equal(a.holder.admin.inviteText(made.hash).ok, false);
});

test("R5-F008: a lapsed invite file, with its secret, is deleted on the purge", async () => {
	const a = await computer("a", "alice-mac");
	const id = await team(a);
	const made = await a.holder.admin.invite({ team: id });
	assert.ok(made.ok);
	assert.equal(a.store.invites().length, 1);
	await a.store.withLock(() => a.holder.admin.purgeInvites());
	assert.equal(a.store.invites().length, 1, "a live invite stays");
	a.clock.skew = 11 * 60_000;
	assert.equal(await a.store.withLock(() => a.holder.admin.purgeInvites()), 1);
	assert.equal(a.store.invites().length, 0);
});

test("R5-F009: cancelling an invite also ends the join request waiting on it", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "bob-mac");
	const id = await team(a);
	const { started, request } = await pair(a, b, id);
	const pick = rightPick(a, started.words);
	await a.holder.admin.cancelInvite(request.id);
	assert.equal(a.holder.admin.joinRequests().length, 0);
	const late = await a.holder.admin.decide({ id: request.id, pick });
	assert.equal(late.ok, false, "nothing to approve");
});

test("R5-F010: the decoys and the order of the sets come from the invite secret, so a re-delivered request shows the same three sets", async () => {
	const a = await computer("a", "alice-mac"), b = await computer("b", "bob-mac");
	const id = await team(a);
	const { invite, started, request } = await pair(a, b, id);
	assert.ok(invite.ok);
	const secret = Buffer.from(a.store.readInvite(invite.hash)!.secret, "hex");
	assert.notDeepEqual(decoyWords(secret, 0), decoyWords(secret, 1));
	assert.deepEqual(decoyWords(secret, 0), decoyWords(Buffer.from(secret), 0));
	assert.notDeepEqual(decoyWords(secret, 0), decoyWords(Buffer.alloc(32, 1), 0));
	assert.deepEqual(request.sets, shuffled([started.words, decoyWords(secret, 0), decoyWords(secret, 1)], secret));
	assert.deepEqual(shuffled([1, 2, 3, 4, 5, 6], secret), shuffled([1, 2, 3, 4, 5, 6], secret));
	assert.ok(safetyWords);
});

test("R5-F011: editing config.json writes through a symlink and leaves the link in place", async () => {
	const real = join(root, "dotfiles");
	mkdirSync(real, { recursive: true });
	writeFileSync(join(real, "config.json"), JSON.stringify({ towerModel: "keep-me" }));
	const stateDir = join(root, "state");
	mkdirSync(stateDir);
	symlinkSync(join(real, "config.json"), join(stateDir, "config.json"));
	editLinkConfig(stateDir, (link) => void (link.relay = "http://127.0.0.1:9"));
	assert.ok(lstatSync(join(stateDir, "config.json")).isSymbolicLink(), "still a link");
	assert.deepEqual(JSON.parse(readFileSync(join(real, "config.json"), "utf8")), { towerModel: "keep-me", link: { relay: "http://127.0.0.1:9" } });
});
