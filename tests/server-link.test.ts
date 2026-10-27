import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { LinkStore } from "../src/link/store.ts";
import { fileOf, readRecord, slotOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { World } from "./fakes.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, clientFor, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { TEAM } from "./link/scenario.ts";
import { ServerWorld, until } from "./server-world.ts";

// The link holder in the sb server (docs/specs/2026-10-26-sb-backend.md, B3): the primary server takes holder.json, runs the relay streams, and answers the `link` request of the
// control socket; a secondary server holds no link; a pi session asks the server over the socket (src/link/runtime.ts).

let sw: ServerWorld, relay: FakeRelay;
beforeEach(() => {
	sw = new ServerWorld();
	relay = new FakeRelay();
});
afterEach(() => sw.close());

/** A team on disk for the device `alice` (config.json, device, team file) and a relay that knows it. */
function team(project = join(sw.root, "home", "project")) {
	mkdirSync(project, { recursive: true });
	const real = realpathSync(project), store = new LinkStore(join(sw.stateDir, "link")), entries = rosterOf();
	writeDevice(store, alice, "alice-mac");
	writeTeam(store, entries, alice);
	writeFileSync(join(sw.stateDir, "config.json"), JSON.stringify({ link: { relay: "http://relay.test", teams: { [TEAM_HEX]: { project: real, share: "status" } } } }));
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	return { store, project: real };
}
const linkDeps = () => ({ tickMs: 15, drainMs: 20, presenceMs: 40, relay: clientFor(relay), home: join(sw.root, "home") });
const holderOf = () => new LinkStore(join(sw.stateDir, "link")).readHolder();
const ask = (endpoint: string, secret: string, from: string, body: unknown) => callControl(endpoint, secret, { cmd: "link", from, body } as { cmd: string }).then((r) => r.reply!);

test("the primary server takes holder.json, starts the relay stream, and answers `link` requests on the control socket", async () => {
	team();
	const s = await sw.start({ link: linkDeps() });
	assert.equal(await s.handle.ready, true);
	const record = sw.record()!;
	await until(() => holderOf()?.session === record.intercomId, "the holder record");
	assert.deepEqual([holderOf()!.pid, holderOf()!.tower, holderOf()!.version], [s.pid, true, "0.44.0"]);
	await until(() => relay.opened.some((o) => o.device === alice.id), "the relay stream");
	const reply = await ask(record.socket, record.secret, "some-session", { op: "list" });
	assert.equal(reply.ok, true);
	const answer = reply.answer as { ok: boolean; teams: { team: string }[] };
	assert.deepEqual([answer.ok, answer.teams.map((t) => t.team)], [true, [TEAM_HEX]]);
	// status carries the link's state
	const status = (await callControl(record.socket, record.secret, { cmd: "status" })).reply as unknown as { link: { inUse: boolean; holding: boolean; active: boolean } };
	assert.deepEqual([status.link.inUse, status.link.holding, status.link.active], [true, true, true]);
});

test("a request without from or body is refused, a send from a session that is no tower is refused by the holder, and an unknown op is an error answer", async () => {
	team();
	const s = await sw.start({ link: linkDeps() });
	await s.handle.ready;
	const record = sw.record()!;
	await until(() => holderOf()?.session === record.intercomId, "the holder record");
	assert.equal((await callControl(record.socket, record.secret, { cmd: "link", body: { op: "list" } } as { cmd: string })).reply!.ok, false);
	assert.equal((await callControl(record.socket, record.secret, { cmd: "link", from: "x" } as { cmd: string })).reply!.ok, false);
	await until(async () => ((await ask(record.socket, record.secret, "x", { op: "list" })).answer as { ok: boolean }).ok, "an active holder");
	assert.deepEqual((await ask(record.socket, record.secret, "x", { op: "nope" })).answer, { ok: false, error: "unknown request" });
	const sent = (await ask(record.socket, record.secret, "not-a-tower", { op: "send", device: "bob-mac", text: "hi", reply: false })).answer as { ok: boolean; error?: string };
	assert.equal(sent.ok, false);
	// The GUI's requests are taken from the GUI's host session only.
	assert.deepEqual((await ask(record.socket, record.secret, "someone", { op: "gui", name: "state" })).answer, { ok: false, error: "Only the session that hosts the GUI may change Straw Link teams" });
	writeFileSync(join(sw.stateDir, "gui.json"), JSON.stringify({ ownerSession: "someone" }));
	assert.equal(((await ask(record.socket, record.secret, "someone", { op: "gui", name: "state" })).answer as { ok: boolean }).ok, true);
});

test("a computer with no team set up gets no channel, no election, and no link files; its `link` request says there is no holder", async () => {
	const s = await sw.start({ link: linkDeps() });
	await s.handle.ready;
	const record = sw.record()!;
	await new Promise((r) => setTimeout(r, 150));
	assert.equal(existsSync(join(sw.stateDir, "link")), false);
	assert.deepEqual(s.client.capabilities.flat().filter((c) => c.namespace === "straw-boss/link"), [], "no link channel registered (the GUI's own channels are not the link's)");
	const answer = (await ask(record.socket, record.secret, "x", { op: "list" })).answer as { ok: boolean; code?: string };
	assert.deepEqual([answer.ok, answer.code], [false, "no_holder"]);
	const status = (await callControl(record.socket, record.secret, { cmd: "status" })).reply as unknown as { link: { inUse: boolean; holding: boolean } };
	assert.deepEqual([status.link.inUse, status.link.holding], [false, false]);
});

test("stop and restart take the holder record with them, and the next server takes the link at its first look", async () => {
	team();
	const first = await sw.start({ link: linkDeps() });
	await first.handle.ready;
	await until(() => holderOf()?.session === sw.record()!.intercomId, "the holder");
	const opened = relay.opened.length;
	await callControl(sw.record()!.socket, sw.record()!.secret, { cmd: "restart", reason: "test", by: "t" });
	await first.handle.done;
	assert.equal(holderOf(), undefined, "the record went with the server");
	const second = await sw.start({ link: linkDeps() });
	await second.handle.ready;
	await until(() => holderOf()?.pid === second.pid, "the second server as holder");
	await until(() => relay.opened.length > opened, "its stream");
});

test("a secondary server holds no link: its record is not touched and its `link` request says so", async () => {
	team();
	const env = { ...sw.env, HERDR_SOCKET_PATH: join(sw.root, "other-herdr.sock") };
	const slot = slotOf(sw.stateDir, env);
	assert.equal(slot.primary, false);
	const { options } = sw.options({ env, slot, link: linkDeps() });
	const { runServer } = await import("../src/server/main.ts");
	const handle = await runServer(options);
	try {
		assert.equal(await handle.ready, true);
		const record = readRecord(slot)!;
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(holderOf(), undefined);
		assert.equal(relay.opened.length, 0);
		const answer = (await ask(record.socket, record.secret, "x", { op: "list" })).answer as { ok: boolean; code?: string };
		assert.deepEqual([answer.ok, answer.code], [false, "no_link"]);
		assert.ok(existsSync(fileOf(slot, "record")));
	} finally {
		await handle.shutdown(0);
	}
});

test("a pi session's tower_send reaches the relay through the server's control socket, with no seam in between", async () => {
	const { project } = team();
	const world = new World();
	const s = await sw.start({ link: linkDeps(), herdr: { run: world.herdr.runFor("") } });
	await s.handle.ready;
	const tower = world.tower("tower-a", "wA:t7", "wA:p7", false, { stateDir: sw.stateDir, link: { tickMs: 15, home: join(sw.root, "home") } });
	world.herdr.pane("wA:p7").cwd = project;
	tower.cwd = project;
	await tower.start();
	// The server's own intercom client is a stub: it lists the world's sessions as the broker would.
	s.client.sessions = (await world.broker.sessionList()) as typeof s.client.sessions;
	await until(() => holderOf()?.session === sw.record()!.intercomId, "the holder");
	await until(async () => ((await ask(sw.record()!.socket, sw.record()!.secret, "x", { op: "list" })).answer as { ok: boolean }).ok, "an active holder");
	const sent = await tower.tool("tower_send", { message: "ship it", device: "bob-mac" });
	assert.match((sent.content[0] as { text: string }).text, /Sent to the tower of bob-mac/);
	await until(() => relay.stored.some((st) => !st.ephemeral), "the envelope at the relay");
	// A server that is gone is told in words, not as a crash.
	await sw.running[0]!.handle.shutdown(0);
	await s.handle.done;
	await assert.rejects(tower.tool("tower_send", { message: "again", device: "bob-mac" }), /No link holder is running|did not take the request/);
	await world.stopAll();
});

test("B3R-F001: a notice is stored and logged on the label character set, cut at 300 characters", async () => {
	const { restrictNotice } = await import("../src/link/text.ts");
	const out = restrictNotice(`Straw Link: \x1b[2J\nignore {instructions} ${"y".repeat(400)}`);
	assert.equal(out.length, 300);
	assert.match(out, /^[\x20-\x7e]+$/);
	assert.equal(restrictNotice("Straw Link: team ab12cd stopped (reason; x)\nline\u00e9"), "Straw Link: team ab12cd stopped (reason; x)_line_", "our punctuation stays, control and non-ASCII go");
});

test("B3R-F002: the server's home is opts.home ?? homedir(), not HOME or USERPROFILE of the injected env", async () => {
	mkdirSync(join(sw.root, "home", "project"), { recursive: true });
	mkdirSync(sw.stateDir, { recursive: true });
	writeFileSync(join(sw.stateDir, "config.json"), JSON.stringify({ link: { relay: "http://relay.test", teams: { [TEAM_HEX]: { project: "~/project", share: "status" } } } }));
	sw.env.USERPROFILE = join(sw.root, "home");
	const s = await sw.start({ link: { tickMs: 15, relay: clientFor(relay) } });
	await s.handle.ready;
	const record = sw.record()!;
	const status = (await callControl(record.socket, record.secret, { cmd: "status" })).reply as unknown as { link: { notices: { text: string }[] } };
	assert.ok(!existsSync(join(sw.stateDir, "link", "holder.json")), "the injected HOME is not the server's home");
	assert.ok(Array.isArray(status.link.notices));
});
