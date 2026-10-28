import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FakeHerdr } from "./fakes.ts";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { TOWER_LABEL, type Session } from "../src/herdr.ts";
import { fileOf, slotOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { listServices, readLedger, readQueue, readService, towerDir, writeService } from "../src/server/towerstore.ts";

// The tower service without runs (docs/specs/2026-10-26-sb-backend.md, The tower service; B4): the server stands in for a workspace's tower with a fake Herdr and fake
// pi-intercom clients, one per identity. Every test turns `towerRuns.enabled` on in the state directory's config.json unless it says otherwise.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);
const started = async (over: Parameters<TowerWorld["start"]>[0] = {}) => {
	const s = await world.start(over);
	await s.handle.ready;
	return s;
};
const pane = (id: string) => world.herdr.pane(id);
const tokens = (workspace = "wA") => world.herdr.workspace(workspace).tokens;
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");

test("ensure-tower makes the tower tab (no env, no pi), marks the standing pane, registers the identity with its own cwd and pane, and writes the token and service.json", async () => {
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(reply.ok, true, JSON.stringify(reply));
	assert.equal(reply.id, "sb-tower-wa");
	assert.equal(reply.opened, true);
	assert.equal(reply.live, true);
	assert.deepEqual(world.herdr.commands("tab", "create"), [["tab", "create", "--workspace", "wA", "--label", TOWER_LABEL, "--cwd", "/w/alpha", "--no-focus"]]);
	assert.deepEqual(world.herdr.commands("agent", "start"), [], "no pi is started");
	const standing = pane(String(reply.pane));
	assert.equal(standing.tokens.sb_role, "tower");
	assert.equal(tokens().tower, "sb-tower-wa");
	assert.deepEqual(world.herdr.moves, [{ tab_id: reply.tab, insert_index: 0 }], "the tower tab goes first");
	const tower = world.client("sb-tower-wa")!;
	assert.equal(tower.registered?.name, "tower · Alpha");
	assert.equal(tower.registered?.cwd, join(world.slot.dir, "tower", "wA"));
	assert.equal(tower.registered?.herdrPaneId, reply.pane);
	assert.ok(existsSync(tower.registered!.cwd), "its folder is there");
	const record = readService(world.slot, "wA")!;
	assert.deepEqual({ id: record.id, pane: record.pane, tab: record.tab, seq: record.seq }, { id: "sb-tower-wa", pane: reply.pane, tab: reply.tab, seq: 0 });
	assert.deepEqual(world.herdr.tabs.find((t) => t.tab_id === reply.tab)?.label, TOWER_LABEL);
	// A second ask finds it.
	const again = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.deepEqual({ id: again.id, opened: again.opened, tab: again.tab }, { id: "sb-tower-wa", opened: false, tab: reply.tab });
	assert.equal(world.herdr.commands("tab", "create").length, 1);
	assert.equal(world.clients.length, 2, "the server's own session and the one identity");
	assert.deepEqual((await ask(s, { cmd: "status" })).towers, [{ workspace: "wA", label: "Alpha", id: "sb-tower-wa", state: "live", queue: 0, service: { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] } }]);
	assert.ok(!logText().includes("sb-tower-wa") || !/token|secret/i.test(logText().split("\n").filter((l) => l.includes("tower-")).join("\n")));
});

test("a marked tower tab is reused and a bare one (the glyph, one shell pane) too; leftovers are closed, and both are moved first", async () => {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7", "shell");
	world.herdr.addTab("wA:t8", TOWER_LABEL, "wA:p8", "shell");
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(reply.pane, "wA:p7");
	assert.equal(reply.opened, true);
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
	assert.deepEqual(world.herdr.commands("tab", "close"), [["tab", "close", "wA:t8"]]);
	assert.equal(pane("wA:p7").tokens.sb_role, "tower");
	assert.deepEqual(world.herdr.moves, [{ tab_id: "wA:t7", insert_index: 0 }]);
	// A tab only labelled like a tower, with an agent in it, is someone else's.
	world.herdr.addTab("wB:t7", TOWER_LABEL, "wB:p7", "pi");
	const other = await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	assert.notEqual(other.pane, "wB:p7");
	assert.equal(world.herdr.commands("tab", "create").length, 1);
});

test("a pane given (a resident tower handing over) becomes the standing pane, and its tab takes the glyph label", async () => {
	world.herdr.addTab("wA:t5", "work", "wA:p5", "pi");
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA", pane: "wA:p5" });
	assert.deepEqual({ ok: reply.ok, pane: reply.pane, tab: reply.tab }, { ok: true, pane: "wA:p5", tab: "wA:t5" });
	assert.deepEqual(world.herdr.commands("tab", "create"), []);
	assert.deepEqual(world.herdr.commands("tab", "rename"), [["tab", "rename", "wA:t5", TOWER_LABEL]]);
	assert.equal(tokens().tower, "sb-tower-wa");
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA", pane: "wA:nope" })).ok, true, "an existing service answers before the pane is looked at");
	const bad = await ask(s, { cmd: "ensure-tower", workspace: "wB", pane: "wA:p5" });
	assert.equal(bad.ok, false);
	assert.match(String(bad.error), /not in workspace/);
});

test("a sub workspace has no tower: the parent's answers", async () => {
	world.herdr.workspaces[0]!.worktree = { checkout_path: "/w/alpha", repo_key: "r" };
	world.herdr.workspaces.push({ workspace_id: "wS", label: "Alpha sub", tokens: {}, worktree: { checkout_path: "/w/alpha-sub", repo_key: "r", is_linked_worktree: true } });
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wS" });
	assert.equal(reply.workspace, "wA");
	assert.equal(reply.id, "sb-tower-wa");
	assert.equal(readService(world.slot, "wS"), undefined);
	world.herdr.workspaces.push({ workspace_id: "wT", label: "Lone sub", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "other" } });
	const lone = await ask(s, { cmd: "ensure-tower", workspace: "wT" });
	assert.equal(lone.ok, false);
	assert.match(String(lone.error), /sub workspace with no open parent/);
});

test("with towerRuns.enabled off nothing happens: ensure-tower is refused, no identity registers, and resident-tower records are not converted", async () => {
	world.setFlag(false);
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7", "pi");
	const roles = join(world.stateDir, "roles");
	mkdirSync(roles, { recursive: true });
	writeFileSync(join(roles, "a.json"), JSON.stringify({ role: "tower", pane: "wA:p7", tab: "wA:t7", workspace: "wA", at: 1 }));
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(reply.ok, false);
	assert.match(String(reply.error), /towerRuns\.enabled is off/);
	assert.equal(world.clients.length, 1, "only the server's own session");
	assert.deepEqual(readdirSync(roles), ["a.json"]);
	assert.deepEqual(listServices(world.slot), []);
	assert.deepEqual(world.herdr.calls.filter((c) => c[1] === "report-metadata"), []);
	// The switch is read at each ask: turning it on needs no restart.
	world.setFlag(true);
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "wA" })).ok, true);
});

test("a tab closed in Herdr ends the service: the identity leaves, the marks go with sb_tower_quit, service.json goes, and the queue stays", async () => {
	world.herdr.addTab("wA:t1b", "mine", "wA:p9", "shell");
	pane("wA:p9").tokens.sb_role = "member";
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const tower = world.client("sb-tower-wa")!;
	const from = { id: "main-1", name: "docs-main" };
	tower.incoming(from, { id: "m1", content: { text: "hello tower" } });
	await until(() => readQueue(world.slot, "wA").length === 1, "the event queued");
	await world.herdr.runFor("x")(["tab", "close", String(reply.tab)]);
	world.herdr.emit("tab.closed", "tab_closed", { tab_id: reply.tab, workspace_id: "wA" });
	await until(() => !readService(world.slot, "wA"), "the service to end");
	assert.equal(tower.connected, false);
	assert.equal(tokens().tower, undefined);
	assert.equal(tokens().sb_tower_quit, "1");
	assert.equal(readQueue(world.slot, "wA").length, 1, "the queue is kept for a reopened tower");
	assert.deepEqual((await ask(s, { cmd: "status" })).towers, []);
	// A reopened tower gets the kept queue and goes on counting from it.
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")?.incoming(from, { id: "m2", content: { text: "again" } });
	await until(() => readQueue(world.slot, "wA").length === 2, "the second event");
	assert.deepEqual(readQueue(world.slot, "wA").map((e) => e.seq), [0, 1]);
});

test("close-tower closes the tab and the service", async () => {
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const closed = await ask(s, { cmd: "close-tower", workspace: "wA" });
	assert.deepEqual({ ok: closed.ok, id: closed.id }, { ok: true, id: "sb-tower-wa" });
	assert.ok(!world.herdr.tabs.some((t) => t.tab_id === reply.tab));
	assert.equal(readService(world.slot, "wA"), undefined);
	assert.equal((await ask(s, { cmd: "close-tower", workspace: "wA" })).ok, false);
});

test("what reaches the identity is queued on disk with the text as received, and the log holds no text", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.client("sb-tower-wa")!.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "[straw net from=docs-main] secret plan" } });
	await until(() => readQueue(world.slot, "wA").length === 1, "the event");
	const [event] = readQueue(world.slot, "wA");
	assert.deepEqual({ kind: event!.kind, text: event!.text, from: event!.from, messageId: event!.messageId, seq: event!.seq }, { kind: "intercom", text: "[straw net from=docs-main] secret plan", from: { id: "main-1", name: "docs-main" }, messageId: "m1", seq: 0 });
	assert.equal(readService(world.slot, "wA")!.seq, 1);
	assert.ok(!logText().includes("secret plan"));
	assert.equal((await ask(s, { cmd: "status" })).towers && ((await ask(s, { cmd: "status" })).towers as { queue: number }[])[0]!.queue, 1);
});

test("a server that starts with service.json registers every identity and writes the tokens before it answers as ready (a restart or an upgrade)", async () => {
	const first = await started();
	await ask(first, { cmd: "ensure-tower", workspace: "wA" });
	const record = readService(world.slot, "wA")!;
	await first.handle.shutdown(0);
	await first.handle.done;
	assert.equal(world.client("sb-tower-wa")!.connected, false, "stopping releases the identity");
	assert.equal(readService(world.slot, "wA")?.id, "sb-tower-wa", "the file stays");
	assert.equal(tokens().tower, "sb-tower-wa", "and so do the tokens: the guard's grace covers the gap");
	delete tokens().tower;
	delete pane(record.pane).tokens.sb_role;
	world.clients.length = 0;
	world.connectMs = 0;
	const second = await world.start();
	assert.equal(await second.handle.ready, true);
	const tower = world.clients.find((c) => c.sessionId === "sb-tower-wa");
	assert.equal(tower?.connected, true, "registered by the time the server is ready");
	assert.equal(tower?.registered?.herdrPaneId, record.pane);
	assert.equal(tokens().tower, "sb-tower-wa");
	assert.equal(pane(record.pane).tokens.sb_role, "tower");
});

test("a Herdr restart: the tokens are written again for the tab Herdr kept", async () => {
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.herdr.restart();
	assert.equal(tokens().tower, undefined, "a new Herdr server has no tokens");
	world.takeovers.forEach((cb) => cb());
	await until(() => tokens().tower === "sb-tower-wa" && pane(String(reply.pane)).tokens.sb_role === "tower", "the marks");
	assert.equal(readService(world.slot, "wA")!.pane, reply.pane);
});

test("a Herdr restart that gave the tower tab other ids: it is found by the glyph label with one pane, the record follows, and the identity registers with the new pane", async () => {
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	// The restored Herdr has the tower tab under other ids (and the old ones gone).
	await world.herdr.runFor("x")(["tab", "close", String(reply.tab)]);
	world.herdr.restart();
	world.herdr.addTab("wA:t55", TOWER_LABEL, "wA:p55", "shell");
	world.takeovers.forEach((cb) => cb());
	await until(() => readService(world.slot, "wA")?.pane === "wA:p55", "the record to follow");
	assert.equal(readService(world.slot, "wA")!.tab, "wA:t55");
	await until(() => world.clients.filter((c) => c.sessionId === "sb-tower-wa" && c.connected && c.registered?.herdrPaneId === "wA:p55").length === 1, "the identity registered with the new pane");
	await until(() => tokens().tower === "sb-tower-wa" && pane("wA:p55").tokens.sb_role === "tower", "the marks on the found pane");
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-tower-wa" && c.connected).length, 1, "the old connection left");
});

test("a tab that is not back within the minute after a Herdr restart ends the service; within it, it is only looked for", async () => {
	const s = await started({ towers: { recoverMs: 400, registerMs: 500, residentMs: 20, retryMs: [20] } });
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await world.herdr.runFor("x")(["tab", "close", String(reply.tab)]);
	world.herdr.restart();
	world.takeovers.forEach((cb) => cb());
	await sleep(150);
	assert.ok(readService(world.slot, "wA"), "still looked for");
	assert.equal(world.client("sb-tower-wa")?.connected, true);
	await until(() => !readService(world.slot, "wA"), "the service to end once the minute is over", 3000);
});

test("Herdr not answering loses nothing", async () => {
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.herdr.failReads = true;
	world.herdr.emit("pane.closed", "pane_closed", { pane_id: "wA:p1", workspace_id: "wA" });
	await sleep(120);
	world.herdr.failReads = false;
	assert.ok(readService(world.slot, "wA"));
	assert.equal(reply.ok, true);
});

test("resident towers: a record in roles/ whose pane is in this Herdr becomes service.json and is deleted, a main's record and another Herdr's are left", async () => {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7", "shell");
	const roles = join(world.stateDir, "roles");
	mkdirSync(roles, { recursive: true });
	writeFileSync(join(roles, "tower.json"), JSON.stringify({ role: "tower", pane: "wA:p7", tab: "wA:t7", workspace: "wA", at: 1 }));
	writeFileSync(join(roles, "main.json"), JSON.stringify({ role: "main", pane: "wA:p1", tab: "wA:t1", workspace: "wA", at: 1 }));
	writeFileSync(join(roles, "elsewhere.json"), JSON.stringify({ role: "tower", pane: "wZ:p1", tab: "wZ:t1", workspace: "wZ", at: 1 }));
	const s = await started();
	assert.deepEqual(readdirSync(roles).sort(), ["elsewhere.json", "main.json"]);
	const record = readService(world.slot, "wA")!;
	assert.deepEqual({ id: record.id, pane: record.pane, tab: record.tab, label: record.label }, { id: "sb-tower-wa", pane: "wA:p7", tab: "wA:t7", label: "Alpha" });
	assert.equal(world.client("sb-tower-wa")?.connected, true);
	assert.equal(tokens().tower, "sb-tower-wa");
	assert.equal(pane("wA:p7").tokens.sb_role, "tower");
	assert.equal(s.client.connected, true);
});

test("a live resident tower of an older build keeps its workspace: the service waits, writes nothing, and registers once that session leaves", async () => {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7", "pi");
	world.herdr.workspace("wA").tokens.tower = "old-tower";
	world.sessions = [{ id: "old-tower", name: "tower · Alpha" }];
	writeService(world.slot, { workspace: "wA", label: "Alpha", id: "sb-tower-wa", name: "tower · Alpha", pane: "wA:p7", tab: "wA:t7", created: "x", seq: 0 });
	await started();
	await sleep(120);
	assert.equal(world.client("sb-tower-wa"), undefined, "no identity while the resident lives");
	assert.equal(tokens().tower, "old-tower");
	assert.deepEqual((await callControl(world.record()!.socket, world.record()!.secret, { cmd: "status" })).reply?.towers, [{ workspace: "wA", label: "Alpha", id: "sb-tower-wa", state: "waiting", queue: 0, service: { state: "standing", queued: 0, allyRuns: [], notices: [], parked: [] } }]);
	// An ask for the workspace gets the resident, and creates nothing.
	const s = world.running[0]!;
	world.herdr.workspaces.push({ workspace_id: "wC", label: "C", tokens: { tower: "old-tower" } });
	const asked = await ask(s, { cmd: "ensure-tower", workspace: "wC" });
	assert.deepEqual({ id: asked.id, resident: asked.resident, opened: asked.opened }, { id: "old-tower", resident: true, opened: false });
	// The resident quits and leaves its pane: the service takes the workspace.
	world.sessions = [];
	delete world.herdr.workspace("wA").tokens.tower;
	pane("wA:p7").agent = undefined;
	await until(() => world.client("sb-tower-wa")?.connected === true && tokens().tower === "sb-tower-wa", "the service to take over");
});

test("a resident tower that closed its tab when it left ends the waiting service", async () => {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7", "pi");
	world.herdr.workspace("wA").tokens.tower = "old-tower";
	world.sessions = [{ id: "old-tower" }];
	writeService(world.slot, { workspace: "wA", label: "Alpha", id: "sb-tower-wa", name: "tower · Alpha", pane: "wA:p7", tab: "wA:t7", created: "x", seq: 0 });
	await started();
	await sleep(60);
	world.sessions = [];
	await world.herdr.runFor("x")(["tab", "close", "wA:t7"]);
	delete world.herdr.workspace("wA").tokens.tower;
	await until(() => !readService(world.slot, "wA"), "the service to end");
	assert.equal(world.client("sb-tower-wa"), undefined);
});

test("the head tower changing is noted in the digest of every tower workspace, once", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await ask(s, { cmd: "ensure-tower", workspace: "wB" });
	await sleep(50);
	const [a, b] = world.herdr.workspaces;
	world.herdr.workspaces = [b!, a!];
	world.herdr.emit("workspace.moved", "workspace_moved", { workspace_id: "wB" });
	await until(() => Object.keys(tokens("wA")).some((k) => k.startsWith("sbd_")) && Object.keys(tokens("wB")).some((k) => k.startsWith("sbd_")), "the digest lines");
	for (const ws of ["wA", "wB"]) {
		const lines = Object.entries(tokens(ws)).filter(([k]) => k.startsWith("sbd_")).map(([, v]) => v);
		assert.equal(lines.length, 1);
		assert.match(lines[0]!, /head tower is now Beta$/);
	}
});

test("the identities of two Herdr servers on one broker do not collide: the secondary slot's carry its slot", async () => {
	const second = slotOf(world.stateDir, { ...world.env, HERDR_SOCKET_PATH: join(world.root, "other-herdr.sock") });
	assert.equal(second.primary, false);
	const herdr2 = new FakeHerdr();
	const a = await started();
	const b = await world.start({ slot: second, herdr: { run: herdr2.runFor("none"), events: herdr2.events, api: herdr2.api, watch: () => () => {} } });
	await b.handle.ready;
	const ra = await ask(a, { cmd: "ensure-tower", workspace: "wA" });
	const rb = await callControl(b.handle.endpoint, JSON.parse(readFileSync(fileOf(second, "record"), "utf8")).secret, { cmd: "ensure-tower", workspace: "wA" }).then((x) => x.reply!);
	assert.equal(ra.id, "sb-tower-wa");
	assert.equal(rb.id, `sb-tower-${second.slot8}-wa`);
	assert.equal(herdr2.workspace("wA").tokens.tower, rb.id);
	assert.equal(world.herdr.workspace("wA").tokens.tower, ra.id);
	assert.deepEqual(world.clients.map((c) => c.sessionId).filter((id) => id?.startsWith("sb-tower")).sort(), [ra.id, rb.id].sort());
	assert.ok(existsSync(towerDir(second, "wA")) && towerDir(second, "wA").includes("servers"));
	assert.equal(world.client(String(rb.id))?.registered?.name, `tower · Alpha · ${second.slot8}`);
});

test("the opener's ledger is kept on disk: a request already tried is not tried again after the service restarts, and a refused one may be asked again", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.sessions = [{ id: "sender-1", name: "docs-main", herdrLocation: { status: "current", paneId: "wA:p1" } as never }];
	world.herdr.onAgentStart = (p) => {
		p.tokens.sb_role = "main";
		world.sessions.push({ id: "opened-1", name: "main", herdrLocation: { status: "current", paneId: p.pane_id } as never });
	};
	const request = { cmd: "open-main", workspace: "wA", request: "Fix the export button", sender: "docs-main", label: "export" };
	const opened = await ask(s, request);
	assert.equal(opened.ok, true, JSON.stringify(opened));
	assert.equal((opened.opened as { main: string }).main, "opened-1");
	assert.equal(world.herdr.commands("tab", "create").length, 2, "the tower tab and the main's");
	assert.equal(world.client("sb-tower-wa")!.sent.length, 1, "the handoff left under the tower identity");
	assert.equal(world.client("sb-tower-wa")!.sent[0]!.to, "opened-1");
	assert.equal(readLedger(world.slot, "wA", Date.now()).length, 1);
	assert.equal(JSON.stringify(readLedger(world.slot, "wA", Date.now())).includes("Fix the export"), false, "the ledger holds a hash, not the request");
	await s.handle.shutdown(0);
	await s.handle.done;
	world.clients.length = 0;
	const again = await world.start();
	await again.handle.ready;
	const repeated = await ask(again, request);
	assert.equal(repeated.ok, true);
	assert.equal((repeated.opened as { repeated?: boolean }).repeated, true);
	assert.equal(world.herdr.commands("tab", "create").length, 2, "no second main");
});

test("close-main goes out from the tower identity on straw-boss/control, and the main's answer is taken", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.herdr.addTab("wA:t9", "export", "wA:p9", "pi");
	Object.assign(pane("wA:p9"), { agent_status: "idle" });
	Object.assign(pane("wA:p9").tokens, { sb_role: "main", sb_opened_by: "sender-1" });
	const main: Session = { id: "opened-1", name: "main", herdrLocation: { status: "current", paneId: "wA:p9" } as never };
	world.sessions = [main];
	const tower = world.client("sb-tower-wa")!;
	const pending = ask(s, { cmd: "close-main", workspace: "wA", query: "opened-1" });
	await until(() => tower.frames.some((f) => f.namespace === "straw-boss/control" && (f.payload as { type?: string }).type === "close-main"), "the ask");
	const frame = tower.frames.find((f) => f.namespace === "straw-boss/control" && (f.payload as { type?: string }).type === "close-main")!;
	assert.equal((frame.payload as { to: string }).to, "opened-1");
	tower.broker({ type: "extension_message", namespace: "straw-boss/control", fromSessionId: "opened-1", payload: { version: 1, type: "close-main-result", to: "sb-tower-wa", reqId: (frame.payload as { reqId: string }).reqId, accepted: true } });
	world.sessions = [];
	const closed = await pending;
	assert.equal(closed.ok, true, JSON.stringify(closed));
	assert.equal((closed.closed as { closed: boolean }).closed, true);
});

test("a server stopped on purpose releases the identities and leaves tokens and files", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const stop = await ask(s, { cmd: "stop", by: "test" });
	assert.equal(stop.ok, true);
	await s.handle.done;
	assert.equal(world.client("sb-tower-wa")!.connected, false);
	assert.ok(readService(world.slot, "wA"));
	assert.equal(tokens().tower, "sb-tower-wa");
	assert.equal(listServices(world.slot).length, 1);
});

test("the tokens are written again every few minutes (their TTL is ten)", async () => {
	const s = await started({ towers: { recoverMs: 150, registerMs: 500, residentMs: 20, retryMs: [20], refreshMs: 60 } });
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const before = world.herdr.commands("workspace", "report-metadata").length;
	await until(() => world.herdr.commands("workspace", "report-metadata").length > before, "a refresh");
	assert.equal(tokens().tower, "sb-tower-wa");
});

test("an identity whose broker connection drops registers again", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const first = world.client("sb-tower-wa")!;
	first.drop();
	await until(() => world.clients.some((c) => c !== first && c.sessionId === "sb-tower-wa" && c.connected), "the identity registered again");
	assert.equal((await ask(s, { cmd: "status" })).towers && ((await ask(s, { cmd: "status" })).towers as { state: string }[])[0]!.state, "live");
});

// --- the review of B4 (B4R-F001 to F010) -----------------------------------------------------------------------------------------------------------------------------------

const resident = (id = "old-tower") => {
	world.herdr.workspace("wA").tokens.tower = id;
	world.sessions = [{ id, name: "tower · Alpha" }];
};
const standing = () => writeService(world.slot, { workspace: "wA", label: "Alpha", id: "sb-tower-wa", name: "tower · Alpha", pane: "wA:p7", tab: "wA:t7", created: "x", seq: 0 });

test("VM #35: a service whose pane is gone when it publishes (the pane a handover replaced, a closed workspace) logs no tokens error: the stale report is dropped with a debug line", async () => {
	standing(); // wA:p7 is in no tab of this Herdr
	const s = await world.start({ towers: { recoverMs: 5000, registerMs: 500, residentMs: 20, retryMs: [20] } });
	await s.handle.ready;
	await until(() => /tower-registered/.test(logText()) && /tokens-dropped/.test(logText()), "the registration and the dropped report");
	assert.doesNotMatch(logText(), /code=tokens/, "no error line for a pane that is not there");
	assert.match(logText(), /tokens-dropped[^\n]*pane=wA:p7/);
	assert.ok(readService(world.slot, "wA"), "the service stays: the tab is looked for within the recovery window");
});

test("B4R-F001: a failed pane list is unknown, not a lost tab: the service, the identity and the tokens stay, and ensure fails instead of reopening", async () => {
	const s = await started();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await sleep(300); // past the recovery window of the start
	world.herdr.failPanes = true;
	world.herdr.emit("pane.closed", "pane_closed", { pane_id: "wA:p999", workspace_id: "wA" });
	await sleep(200);
	const failed = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	world.herdr.failPanes = false;
	assert.equal(failed.ok, false, "an ask that cannot see the panes fails");
	assert.ok(readService(world.slot, "wA"), "service.json stays");
	assert.equal(tokens().tower, "sb-tower-wa");
	assert.equal(tokens().sb_tower_quit, undefined, "no sb_tower_quit: no main is demoted");
	assert.equal(world.client("sb-tower-wa")?.connected, true);
	assert.equal(pane(String(reply.pane)).tokens.sb_role, "tower");
	// With the panes readable again and the tab really gone, the service ends.
	world.herdr.tabs = world.herdr.tabs.filter((t) => t.tab_id !== reply.tab);
	world.herdr.panes = world.herdr.panes.filter((p) => p.tab_id !== reply.tab);
	world.herdr.emit("pane.closed", "pane_closed", { pane_id: String(reply.pane), workspace_id: "wA" });
	await until(() => !readService(world.slot, "wA"), "the service to end on a successful read");
});

test("B4R-F002: a failed session list keeps the service waiting beside a live resident", async () => {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7", "pi");
	resident();
	standing();
	let calls = 0;
	await started({ towers: { recoverMs: 150, registerMs: 500, residentMs: 20, retryMs: [20], sessions: async () => { if (calls++ < 3) throw new Error("pi-intercom is not connected"); return world.sessions; } } });
	await sleep(200);
	assert.equal(world.client("sb-tower-wa"), undefined, "no identity beside a live resident");
	assert.equal(tokens().tower, "old-tower");
});

test("B4R-F002: a waiting service whose pane Herdr renumbered after a restart publishes nothing over the live resident", async () => {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7", "pi");
	resident();
	standing();
	await started();
	await sleep(100);
	world.herdr.tabs = world.herdr.tabs.filter((t) => t.tab_id !== "wA:t7");
	world.herdr.panes = world.herdr.panes.filter((p) => p.tab_id !== "wA:t7");
	world.herdr.addTab("wA:t55", TOWER_LABEL, "wA:p55", "shell");
	world.takeovers.forEach((cb) => cb());
	await until(() => readService(world.slot, "wA")?.pane === "wA:p55", "the record to follow the pane");
	await sleep(100);
	assert.equal(tokens().tower, "old-tower", "the resident's token is not overwritten");
	assert.equal(pane("wA:p55").tokens.sb_role, undefined);
	assert.equal(world.client("sb-tower-wa"), undefined);
});

test("B4R-F002: a live service yields to a resident that holds the workspace at its next refresh, and registers again once it leaves", async () => {
	const s = await started({ towers: { recoverMs: 150, registerMs: 500, residentMs: 20, retryMs: [20], refreshMs: 60 } });
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const first = world.client("sb-tower-wa")!;
	assert.equal(first.connected, true);
	resident(); // a resident tower took the token (a lost hand-over reply: it stayed and published its own)
	await until(() => first.connected === false, "the identity to leave");
	await sleep(150);
	assert.equal(tokens().tower, "old-tower", "the resident keeps its token");
	world.sessions = [];
	delete world.herdr.workspace("wA").tokens.tower;
	await until(() => tokens().tower === "sb-tower-wa" && world.clients.some((c) => c !== first && c.sessionId === "sb-tower-wa" && c.connected), "the service to take the workspace again");
});

test("B4R-F003: a roles/ record whose pane id only collides with a main here (another tab, no matching session) is left alone", async () => {
	world.herdr.addTab("wA:t5", "work-main", "wA:p5", "pi");
	pane("wA:p5").tokens.sb_role = "main";
	const roles = join(world.stateDir, "roles");
	mkdirSync(roles, { recursive: true });
	writeFileSync(join(roles, "stale.json"), JSON.stringify({ role: "tower", pane: "wA:p5", tab: "wA:t99", workspace: "wA", at: 1 }));
	// Same tab id, but the tab is no tower tab and its pane runs another session.
	world.herdr.addTab("wA:t6", "work-two", "wA:p6", "pi");
	pane("wA:p6").agent_session = { value: "/sessions/main.jsonl" };
	writeFileSync(join(roles, "other.json"), JSON.stringify({ role: "tower", pane: "wA:p6", tab: "wA:t6", workspace: "wA", file: "/sessions/tower.jsonl", at: 1 }));
	await started();
	await sleep(150);
	assert.equal(readService(world.slot, "wA"), undefined);
	assert.equal(pane("wA:p5").tokens.sb_role, "main");
	assert.equal(pane("wA:p6").tokens.sb_role, undefined);
	assert.deepEqual(readdirSync(roles).sort(), ["other.json", "stale.json"]);
});

test("B4R-F003: a record whose pane runs its own session file converts even when the tab has no tower label", async () => {
	world.herdr.addTab("wA:t6", "renamed", "wA:p6", "pi");
	pane("wA:p6").agent_session = { value: "/sessions/tower.jsonl" };
	const roles = join(world.stateDir, "roles");
	mkdirSync(roles, { recursive: true });
	writeFileSync(join(roles, "mine.json"), JSON.stringify({ role: "tower", pane: "wA:p6", tab: "wA:t6", workspace: "wA", file: "/sessions/tower.jsonl", at: 1 }));
	await started();
	assert.equal(readService(world.slot, "wA")?.pane, "wA:p6");
	assert.deepEqual(readdirSync(roles), []);
});

for (const order of ["events first", "takeover first"] as const) {
	test(`B4R-F004: a Herdr restart that gave the tab other ids is followed whichever reconnects first (${order})`, async () => {
		const s = await started();
		const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
		await sleep(300); // past the start's recovery window
		world.herdr.tabs = world.herdr.tabs.filter((t) => t.tab_id !== reply.tab);
		world.herdr.panes = world.herdr.panes.filter((p) => p.tab_id !== reply.tab);
		if (order === "takeover first") world.takeovers.forEach((cb) => cb());
		world.herdr.restart(); // the events connection is acknowledged again
		if (order === "events first") {
			await sleep(100);
			world.takeovers.forEach((cb) => cb());
		}
		await sleep(30);
		assert.ok(readService(world.slot, "wA"), "not ended before the tab is restored");
		world.herdr.addTab("wA:t55", TOWER_LABEL, "wA:p55", "shell");
		world.herdr.emit("pane.closed", "pane_closed", { pane_id: "wA:p999", workspace_id: "wA" }); // a look, as the restore's events bring
		await until(() => readService(world.slot, "wA")?.pane === "wA:p55", "the record to follow");
		assert.equal(tokens().sb_tower_quit, undefined);
	});
}

test("B4R-F006: with the flag turned off the server releases its identities and purges service.json, the queue, and the ledger; a start with the flag off purges leftovers too", async () => {
	const s = await started({ towers: { recoverMs: 150, registerMs: 500, residentMs: 20, retryMs: [20], refreshMs: 60 } });
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const tower = world.client("sb-tower-wa")!;
	tower.incoming({ id: "x" }, { id: "m1", content: { text: "hello" } });
	await until(() => readQueue(world.slot, "wA").length === 1, "the event to be queued");
	world.setFlag(false);
	await until(() => tower.connected === false && !readService(world.slot, "wA") && readQueue(world.slot, "wA").length === 0, "the identity to leave and the files to go");
	assert.equal(tokens().tower, undefined);
	assert.equal(pane(String(reply.pane)).tokens.sb_role, "tower", "the standing pane stays as a bare tower tab");
	// Leftovers of an earlier run found by a server that starts with the flag off.
	standing();
	const dir = join(towerDir(world.slot, "wA"), "queue");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "0000000000-aa.json"), JSON.stringify({ text: "old" }));
	await world.close();
	world = new TowerWorld();
	world.setFlag(false);
	standing();
	mkdirSync(join(towerDir(world.slot, "wA"), "queue"), { recursive: true });
	writeFileSync(join(towerDir(world.slot, "wA"), "queue", "0000000000-aa.json"), JSON.stringify({ text: "old" }));
	await started();
	await until(() => !readService(world.slot, "wA") && readQueue(world.slot, "wA").length === 0, "the leftovers to go");
});

test("B4R-F009: a waiting service gets no head-change digest line (the resident notes it itself)", async () => {
	world.herdr.addTab("wA:t7", TOWER_LABEL, "wA:p7", "pi");
	resident();
	standing();
	await started();
	await sleep(100);
	const [a, b] = world.herdr.workspaces;
	world.herdr.workspaces = [b!, a!];
	world.herdr.emit("workspace.moved", "workspace_moved", { workspace_id: "wB" });
	await sleep(150);
	assert.deepEqual(Object.keys(tokens("wA")).filter((k) => k.startsWith("sbd_")), []);
});

test("B4R-F010: a start that failed once is tried again by the next ensure", async () => {
	let failed = false;
	const h = world.herdr;
	await started({ herdr: { run: h.runFor("none"), api: h.api, watch: (cb: () => void) => (world.takeovers.push(cb), () => {}), events: (types: string[], on: Parameters<typeof h.events>[1]) => {
		if (!failed) throw (failed = true, new Error("events.subscribe refused"));
		return h.events(types, on);
	} } });
	const s = world.running[0]!;
	// The server's own start failed (recorded, not fatal); the first ask starts the service again from scratch.
	const first = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(first.ok, true, JSON.stringify(first));
	assert.equal(first.live, true);
});
