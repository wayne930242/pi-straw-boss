import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FakeHerdr, settle } from "./fakes.ts";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { BOSS_MARK, CRASH_FLAG } from "../src/eventmarks.ts";
import { recapOf } from "../src/server/headchapters.ts";
import { HEAD_LABEL, headTowerOf, isHead, TOWER_LABEL, type Workspace } from "../src/herdr.ts";
import { fileOf, slotOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { fakeClock } from "./fake-clock.ts";
import { HEAD_KEY, headDir, listServices, readQueue, readService, towerDir } from "../src/server/towerstore.ts";
import { addWait, updateMemory } from "../src/server/towermemory.ts";

// The head service (docs/specs/2026-11-04-head-tower.md, H1; src/server/head.ts): a tower service of its own kind in a Herdr workspace the server makes on first use, with its state in `head/`.
// A fake Herdr and fake pi-intercom clients, as the tower service's tests have (tests/server-towers.test.ts). No run is started: runs, the gate, and forwards are H2.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.env.LANG = "en_US.UTF-8"; // the head workspace's label is by the server's locale: the machine's own must not decide it
	world.setFlag(true);
});
afterEach(() => world.close());

const started = async (over: Parameters<TowerWorld["start"]>[0] = {}) => {
	const s = await world.start(over);
	await s.handle.ready;
	return s;
};
/** A server whose clock the test owns (HH1-F007): the minute a Herdr restart is given to bring the tabs back ends when the test moves the clock, not when a sleep happens to be long enough. */
const clocked = async () => {
	const clock = fakeClock();
	const s = await world.start({ herdr: { run: world.herdr.runFor("none"), events: world.herdr.events, api: world.herdr.api, watch: (cb: () => void, lost?: () => void) => (world.takeovers.push(cb), lost && world.losts.push(lost), () => {}), now: clock.now } });
	await s.handle.ready;
	return { s, clock };
};
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);
const head = () => world.expose!.head;
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");
const folder = () => join(world.env.PI_CODING_AGENT_DIR!, "straw-boss-head");
const createCalls = () => world.herdr.commands("workspace", "create");
/** How many workspaces the server made for a head (a Herdr restart clears the fake's call log, so the workspaces are counted). */
const headWorkspaces = () => world.herdr.workspaces.filter((w) => w.label === "Head tower").length;
const mode = (path: string) => statSync(path).mode & 0o777;

test("head chapter recaps leave out the boss event ID and crash flag, including across an upgrade", async () => {
	const file = join(world.slot.dir, "recap.jsonl");
	mkdirSync(world.slot.dir, { recursive: true });
	const entries = [
		`${BOSS_MARK}\nOld boss message.`,
		`${BOSS_MARK} [event id: 0123456789abcdef]\n${CRASH_FLAG}\nNew boss message.`,
	];
	writeFileSync(file, entries.map((content, i) => JSON.stringify({ type: "custom_message", id: `e${i}`, customType: "straw-tower", content, display: true, details: { kind: "boss" } })).join("\n"));
	assert.deepEqual(await recapOf(file), ["boss: Old boss message.", "boss: New boss message."]);
});

test("nothing is made before the head is first needed: a server with the tower service on shows no head workspace, no identity, no folder", async () => {
	await started();
	assert.deepEqual(createCalls(), []);
	assert.equal(head().status(), undefined);
	assert.equal(world.client("sb-head"), undefined);
	assert.equal(existsSync(folder()), false);
	assert.equal(existsSync(headDir(world.slot)), false);
});

test("ensure makes the head workspace: its folder, a label by locale, the crown tab, the marks, the token, first place, and the identity sb-head named `head tower` with its own cwd", async () => {
	await started();
	const got = await head().ensure();
	assert.deepEqual(createCalls(), [["workspace", "create", "--cwd", folder(), "--label", "Head tower", "--no-focus"]]);
	assert.equal(got.opened, true);
	assert.equal(got.id, "sb-head");
	assert.equal(got.live, true);
	assert.equal(mode(folder()), 0o700, "an empty folder only the server makes");
	assert.deepEqual(readdirSync(folder()), []);
	// The crown tab, the pane's marks, and the workspace's token.
	assert.equal(world.herdr.tabs.find((t) => t.tab_id === got.tab)?.label, HEAD_LABEL);
	assert.equal(HEAD_LABEL, "\u{f01a5}", "Nerd Font md-crown (checked against Hack Nerd Font's glyph names: U+F01A5 is md-crown, U+F043B md-radio_tower)");
	const pane = world.herdr.pane(got.pane);
	assert.equal(pane.tokens.sb_role, "head");
	assert.equal(pane.tokens.sb_order, "000.0");
	assert.equal(world.herdr.workspace(got.workspace).tokens.sb_head, "sb-head");
	assert.equal(world.herdr.workspace(got.workspace).tokens.tower, undefined, "it is no workspace tower");
	assert.deepEqual(world.herdr.workspaceMoves, [{ workspace_id: got.workspace, insert_index: 0 }], "moved to the first place");
	assert.equal(world.herdr.workspaces[0]!.workspace_id, got.workspace);
	assert.deepEqual(world.herdr.commands("tab", "focus"), [], "without focus");
	const client = world.client("sb-head")!;
	assert.equal(client.registered?.name, "head tower");
	assert.equal(client.registered?.cwd, headDir(world.slot));
	assert.equal(client.registered?.herdrPaneId, got.pane);
	assert.equal(world.client("sb-tower-" + got.workspace.toLowerCase()), undefined, "no tower identity for the head workspace");
	// head/ and its service record.
	assert.equal(mode(headDir(world.slot)), 0o700);
	assert.equal(mode(join(headDir(world.slot), "service.json")), 0o600);
	const record = readService(world.slot, got.workspace)!;
	assert.deepEqual({ workspace: record.workspace, id: record.id, name: record.name, pane: record.pane, tab: record.tab, label: record.label, kind: record.kind }, { workspace: got.workspace, id: "sb-head", name: "head tower", pane: got.pane, tab: got.tab, label: "Head tower", kind: "head" });
	assert.deepEqual(listServices(world.slot), [], "head/ is no workspace tower's folder: the tower listing does not find it");
	assert.equal(head().status()?.state, "live");
});

test("the head's snapshot summary leaves out a boss wait the boss no longer sees (past its due, or a day old with none) (docs/specs/2026-11-06-head-page-minimal.md)", async () => {
	await started();
	const got = await head().ensure();
	const now = Date.now();
	const waits = (workspace: string) => updateMemory(world.slot, workspace, now, (m) => {
		addWait(m, now - 30 * 3_600_000, "r1", { text: "a day old, no due", for: "boss" });
		addWait(m, now, "r1", { text: "fresh", for: "boss" });
	});
	waits(HEAD_KEY);
	const shown = () => world.expose!.runs.view(got.workspace)?.memory?.bossWaits.map((w) => w.text);
	assert.deepEqual(shown(), ["fresh"], "the head's summary");
	assert.equal(readFileSync(join(headDir(world.slot), "memory.json"), "utf8").includes("a day old, no due"), true, "the file keeps it (the server drops it after 7 days)");
});

test("HM-F005: a workspace tower's summary keeps a boss wait a day old with no due: only the head's leaves it out", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const now = Date.now();
	updateMemory(world.slot, "wA", now, (m) => {
		addWait(m, now - 30 * 3_600_000, "r1", { text: "a day old, no due", for: "boss" });
		addWait(m, now - 3_600_000, "r1", { text: "due long ago", for: "boss", dueMin: 5 });
	});
	assert.deepEqual(world.expose!.runs.view("wA")?.memory?.bossWaits.map((w) => w.text), ["a day old, no due", "due long ago"], "a workspace tower shows what it showed");
	assert.equal(world.expose!.runs.view("wA")?.memory?.waits, 2);
});

test("the label is 主塔台 when the server's locale says zh_TW, zh_HK, zh_MO, or zh-Hant (LC_ALL first), else Head tower", async () => {
	world.env.LC_ALL = "zh_TW.UTF-8";
	await started();
	await head().ensure();
	assert.equal(createCalls()[0]![5], "主塔台");
	assert.equal(world.herdr.workspace(world.herdr.workspaces[0]!.workspace_id).label, "主塔台");
});

test("ensure is idempotent: a second ask finds the workspace, and concurrent asks make one", async () => {
	await started();
	const [a, b] = await Promise.all([head().ensure(), head().ensure()]);
	assert.equal(a.workspace, b.workspace);
	const again = await head().ensure();
	assert.deepEqual({ workspace: again.workspace, opened: again.opened, tab: again.tab }, { workspace: a.workspace, opened: false, tab: a.tab });
	assert.equal(createCalls().length, 1);
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-head").length, 1);
});

test("a failed workspace.move is a warning: the head is made all the same", async () => {
	world.herdr.failWorkspaceMove = true;
	await started();
	const got = await head().ensure();
	assert.equal(got.live, true);
	assert.match(logText(), /workspace-move/);
	assert.equal(world.herdr.workspace(got.workspace).tokens.sb_head, "sb-head");
});

test("a workspace of the boss's with the same label is never taken for the head: it keeps its tokens and its tabs, and a head is made beside it", async () => {
	world.herdr.workspaces.unshift({ workspace_id: "wH", label: "Head tower", tokens: {} });
	world.herdr.addTab("wH:t1", HEAD_LABEL, "wH:p1", "shell");
	const s = await started();
	assert.equal(head().status(), undefined, "known by its record and token, never by label");
	const got = await head().ensure();
	assert.notEqual(got.workspace, "wH");
	assert.deepEqual(world.herdr.workspace("wH").tokens, {});
	assert.deepEqual(world.herdr.pane("wH:p1").tokens, {});
	assert.deepEqual(world.herdr.commands("tab", "rename").filter((c) => c[2]?.startsWith("wH:")), []);
	// The same for a restart of the server: only the recorded workspace is adopted.
	await s.handle.shutdown(0);
	const again = await started();
	await until(() => head().status()?.state === "live", "the head to be adopted");
	assert.equal(head().status()?.workspace, got.workspace);
	assert.equal(createCalls().length, 1);
	void again;
});

test("headTowerOf and isHead: the workspace that carries sb_head, nothing else; the first workspace is not it", () => {
	const all: Workspace[] = [{ workspace_id: "w1", label: "Head tower", tokens: {} }, { workspace_id: "w2", label: "Beta", tokens: { sb_head: "sb-head" } }, { workspace_id: "w3", label: "Gamma", tokens: { tower: "sb-tower-w3" } }];
	assert.equal(headTowerOf(all)?.workspace_id, "w2");
	assert.equal(isHead(all[1]!), true);
	assert.equal(isHead(all[0]!), false);
	assert.equal(isHead(all[2]!), false);
	assert.equal(headTowerOf([all[0]!, all[2]!]), undefined, "undefined until the head exists");
	assert.equal(isHead({ workspace_id: "w4", label: "x" }), false, "a workspace with no tokens");
});

test("close ends the service and keeps the conversation, the memory, the asks, and the chapters; the next ensure makes the workspace again in the same head/ and resumes", async () => {
	await started();
	const first = await head().ensure();
	const kept = ["boss-session.json", "chapters.json", "asks.json", "memory.json"];
	for (const name of kept) writeFileSync(join(headDir(world.slot), name), JSON.stringify({ name }));
	const client = world.client("sb-head")!;
	const closed = await head().close();
	assert.deepEqual(closed, { workspace: first.workspace, id: "sb-head" });
	assert.deepEqual(world.herdr.commands("tab", "close"), [["tab", "close", first.tab]]);
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), false);
	assert.equal(head().status(), undefined);
	assert.equal(client.connected, false, "the identity left the broker");
	assert.equal(world.herdr.workspace(first.workspace)?.tokens.sb_head, undefined);
	for (const name of kept) assert.deepEqual(JSON.parse(readFileSync(join(headDir(world.slot), name), "utf8")), { name }, `${name} stays`);
	assert.equal((await head().close()), undefined, "closing a head that is not there is nothing");
	// Made again: a new workspace, the same state folder.
	const second = await head().ensure();
	assert.equal(second.opened, true);
	assert.notEqual(second.workspace, first.workspace);
	assert.equal(createCalls().length, 2);
	assert.equal(readService(world.slot, second.workspace)?.workspace, second.workspace);
	for (const name of kept) assert.equal(existsSync(join(headDir(world.slot), name)), true);
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-head").length, 2, "a new connection for the new service");
});

test("a head tab closed in Herdr ends the service as a tower's does: the identity leaves, service.json goes, the files stay", async () => {
	await started();
	const got = await head().ensure();
	writeFileSync(join(headDir(world.slot), "memory.json"), "{}");
	await world.herdr.runFor("x")(["tab", "close", got.tab]);
	world.herdr.emit("tab.closed", "tab_closed", { tab_id: got.tab });
	await until(() => head().status() === undefined, "the service to end");
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), false);
	assert.equal(existsSync(join(headDir(world.slot), "memory.json")), true);
	assert.match(logText(), /tower-closed/);
});

test("the head is adopted from head/service.json when the server starts again: the same workspace, no new one, the identity registers again", async () => {
	const s = await started();
	const got = await head().ensure();
	await s.handle.shutdown(0);
	await started();
	await until(() => head().status()?.state === "live", "the head to register again");
	assert.equal(head().status()?.workspace, got.workspace);
	assert.equal(createCalls().length, 1);
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-head").length, 2);
	assert.equal(world.clients.filter((c) => c.sessionId === "sb-head").at(-1)!.registered?.cwd, headDir(world.slot), "the adopted service's folder is head/ too");
	assert.equal(existsSync(join(world.slot.dir, "tower", got.workspace)), false, "and nothing is made under tower/ for it");
	assert.equal((await head().ensure()).opened, false);
});

test("the tokens are written again at the refresh: a lapsed token comes back, on the workspace and the pane", async () => {
	world.refreshMs = 60;
	await started();
	const got = await head().ensure();
	const ws = world.herdr.workspace(got.workspace), pane = world.herdr.pane(got.pane);
	delete ws.tokens.sb_head;
	delete pane.tokens.sb_order;
	await until(() => ws.tokens.sb_head === "sb-head" && pane.tokens.sb_order === "000.0", "the refresh to write the marks again");
});

test("after a Herdr restart the head is seated only in a tab with the crown: the crown tab is marked again, a tab with the radio tower glyph is a stranger's and ends the service", async () => {
	const { s, clock } = await clocked();
	const got = await head().ensure();
	world.herdr.restart();
	for (const cb of world.takeovers) cb();
	await until(() => world.herdr.workspace(got.workspace).tokens.sb_head === "sb-head", "the tokens to be written again in the crown tab");
	assert.equal(world.herdr.pane(got.pane).tokens.sb_role, "head");
	// The restored session names the same ids for a tab that is not the head's: the radio tower glyph is a tower's.
	world.herdr.restart();
	world.herdr.tabs.find((t) => t.tab_id === got.tab)!.label = TOWER_LABEL;
	for (const cb of world.takeovers) cb();
	await settle(); // the events connection is acknowledged again (it opens the minute once more) before the clock moves
	clock.advance(1000); // the minute a restore needs (150 ms in this world) is over on the server's clock: a tab that is not found now is lost
	world.herdr.emit("workspace.moved", "workspace_moved", {});
	await until(() => head().status() === undefined, "the stranger's tab to end the service");
	assert.deepEqual(world.herdr.pane(got.pane).tokens, {}, "nothing is marked in a pane that is not the head's");
	void s;
});

test("a message to the head identity is refused in H1: nothing is queued, nothing wakes, and the sender gets a receipt that is not `queued`", async () => {
	await started();
	const got = await head().ensure();
	const client = world.client("sb-head")!;
	client.incoming({ id: "main-1", name: "docs-main" }, { id: "m1", content: { text: "do the thing" } } as never);
	await until(() => client.receipts.length === 1, "a receipt");
	assert.notEqual(client.receipts[0]!.status, "queued");
	assert.deepEqual(readQueue(world.slot, got.workspace), []);
	assert.match(logText(), /head-refused/);
	assert.equal(logText().includes("do the thing"), false, "no text in the log");
	assert.deepEqual(world.herdr.commands("agent", "start"), []);
});

test("the head workspace has no workspace tower: ensure-tower for it is refused, and the tower listing does not list the head", async () => {
	const s = await started();
	const got = await head().ensure();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: got.workspace });
	assert.equal(reply.ok, false);
	assert.match(String(reply.error), /head tower/i);
	assert.equal(world.client("sb-tower-" + got.workspace.toLowerCase()), undefined);
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.deepEqual(((await ask(s, { cmd: "status" })).towers as { workspace: string }[]).map((t) => t.workspace), ["wA"]);
	assert.equal(world.expose!.owns("sb-head"), true, "the session id is a service's identity: it is ended, not asked to quit");
});

test("the head's standing pane gets the tower prompt's command typed once, as a tower's does", async () => {
	await started();
	const got = await head().ensure();
	await until(() => world.herdr.typed.some((t) => t.pane === got.pane), "the prompt's command to be typed");
	assert.match(world.herdr.typed.find((t) => t.pane === got.pane)!.text, new RegExp(`^node "[^"]+cli\\.(ts|mjs)" prompt --workspace ${got.workspace} --state-dir "[^"]+"$`));
});

test("a secondary slot's head is sb-head-<slot8>, named `head tower · <slot8>`, with its state in that slot's head/", async () => {
	const second = slotOf(world.stateDir, { ...world.env, HERDR_SOCKET_PATH: join(world.root, "other-herdr.sock") });
	assert.equal(second.primary, false);
	const herdr2 = new FakeHerdr();
	await started();
	const b = await world.start({ slot: second, herdr: { run: herdr2.runFor("none"), events: herdr2.events, api: herdr2.api, watch: () => () => {} } });
	await b.handle.ready;
	// The expose seam is the last server's: the second slot's.
	const got = await world.expose!.head.ensure();
	assert.equal(got.id, `sb-head-${second.slot8}`);
	assert.equal(world.client(got.id)?.registered?.name, `head tower · ${second.slot8}`);
	assert.equal(world.client(got.id)?.registered?.cwd, headDir(second));
	assert.ok(headDir(second).includes("servers"));
	assert.equal(herdr2.workspace(got.workspace).tokens.sb_head, got.id);
	assert.equal(existsSync(headDir(world.slot)), false, "the primary slot has none");
});

test("with towerRuns.enabled off there is no head tower: ensure is refused with the sentence every channel gives, and nothing is made", async () => {
	world.setFlag(false);
	await started();
	await assert.rejects(head().ensure(), /The head tower needs the tower service \(towerRuns\)/);
	assert.deepEqual(createCalls(), []);
	assert.equal(world.clients.length, 1, "only the server's own session");
	assert.equal(existsSync(folder()), false);
	// The switch is read at each ask.
	world.setFlag(true);
	assert.equal((await head().ensure()).live, true);
});

test("turning the tower service off retires the head too: the identity leaves, the token goes, and service.json is purged with the queues; the conversation files stay", async () => {
	world.refreshMs = 60;
	await started();
	const got = await head().ensure();
	writeFileSync(join(headDir(world.slot), "memory.json"), "{}");
	mkdirSync(join(headDir(world.slot), "queue"), { recursive: true });
	writeFileSync(join(headDir(world.slot), "queue", "0000000000-aa.json"), JSON.stringify({ text: "old" }));
	world.setFlag(false);
	await until(() => head().status() === undefined, "the head to be retired at the next refresh");
	assert.equal(world.herdr.workspace(got.workspace).tokens.sb_head, undefined);
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), false);
	assert.equal(existsSync(join(headDir(world.slot), "queue")), false, "message text stays on disk with no time limit otherwise");
	assert.equal(existsSync(join(headDir(world.slot), "memory.json")), true);
});

test("the prompt's poll answers as the head's (head: true), and the stand-in is reported under the label `head`, not `tower`", async () => {
	const s = await started();
	const got = await head().ensure();
	const pid = 6100;
	world.herdr.pane(got.pane).processes = [{ name: "node", argv0: "node", pid, cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace ${got.workspace} --state-dir "/s"` }];
	let last: Record<string, unknown> = {};
	const timer = setInterval(() => void ask(s, { cmd: "prompt-poll", workspace: got.workspace, pid }).then((r) => (last = r), () => {}), 20);
	try {
		await until(() => world.herdr.pane(got.pane).agent === "head", "the stand-in under the head's label");
		assert.deepEqual({ ...last }, { ok: true, label: "Head tower", state: "standing", queued: 0, leave: false, head: true, waits: [], auto: false });
		assert.equal(world.herdr.pane(got.pane).standinMessage, "standing by");
		assert.deepEqual(world.herdr.agentCalls.filter((c) => c.method === "pane.report_agent").map((c) => c.params.agent), ["head"]);
	} finally {
		clearInterval(timer);
	}
});

test("AR-D2: the head's stand-in is blocked only while its own wait card waits for the boss; a tower's card is a note on it, not a wait", async () => {
	const s = await started();
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	const got = await head().ensure();
	const pid = 6100, at = new Date().toISOString();
	world.herdr.pane(got.pane).processes = [{ name: "node", argv0: "node", pid, cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace ${got.workspace} --state-dir "/s"` }];
	const timer = setInterval(() => void ask(s, { cmd: "prompt-poll", workspace: got.workspace, pid }).catch(() => {}), 20);
	const wait = (id: string) => ({ id, kind: "wait" as const, text: `do ${id}`, by: "run" as const, via: "run" as const, at, run: "r1", for: "boss" as const, state: "open" as const, card: { type: "action" as const, lang: "en" as const, happened: "h", do: `do ${id}` } });
	try {
		await until(() => world.herdr.pane(got.pane).agent_status === "idle", "the head's stand-in, idle");
		updateMemory(world.slot, "wA", Date.now(), (m) => void m.entries.push(wait("W1")));
		await until(() => world.herdr.pane(got.pane).standinMessage === "standing by · 1 card waits at another tower", "a tower's card, noted on the head's stand-in");
		assert.equal(world.herdr.pane(got.pane).agent_status, "idle", "a tower's card does not make the head wait");
		updateMemory(world.slot, HEAD_KEY, Date.now(), (m) => void m.entries.push(wait("W1")));
		await until(() => world.herdr.pane(got.pane).standinMessage === "1 card waits · 1 card waits at another tower", "and its own");
		assert.equal(world.herdr.pane(got.pane).agent_status, "blocked", "the head's own card is a wait of the head");
	} finally {
		clearInterval(timer);
	}
});

// --- the findings of the H1 review (HH1-F001 to F007) ------------------------------------------------------------------------------------------------------------------------------

test("HH1-F001: a workspace id a stale tower service still holds is never bound to head/: ensure ends the stranger first, and the head comes up as sb-head with its files in head/", async () => {
	const s = await started();
	world.herdr.workspaces.push({ workspace_id: "w100", label: "Proj", tokens: {} });
	world.herdr.addTab("w100:t1", "", "w100:p1", "shell");
	assert.equal((await ask(s, { cmd: "ensure-tower", workspace: "w100" })).id, "sb-tower-w100");
	// Herdr lost its session and numbers from the start again: the new head workspace gets the id the tower's workspace had.
	world.herdr.lose();
	const got = await head().ensure();
	assert.equal(got.workspace, "w100");
	assert.equal(got.id, "sb-head", "the head's identity, not the tower's");
	assert.equal(got.opened, true);
	assert.equal(world.client("sb-head")?.registered?.name, "head tower");
	assert.equal(head().status()?.id, "sb-head");
	assert.equal(world.expose!.status().length, 0, "the stranger's tower service is gone");
	assert.equal(world.client("sb-tower-w100")?.connected, false);
	// A look after it (the stale service must not be lost later and take the head's record with it).
	world.herdr.emit("workspace.moved", "workspace_moved", {});
	await world.expose!.takeover();
	assert.equal(head().status()?.state, "live");
	assert.equal(readService(world.slot, "w100")?.kind, "head");
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), true);
	// The tower's files never went into head/.
	assert.equal((await world.expose!.memory("w100", { op: "read" })).status, 200);
	assert.equal(existsSync(join(world.slot.dir, "tower", "w100", "memory.json")), false);
});

test("HH1-F001: a head workspace is crowned only by the head: a tower cannot be given to it, and nothing is made under tower/ for it", async () => {
	const s = await started();
	const got = await head().ensure();
	const reply = await ask(s, { cmd: "ensure-tower", workspace: got.workspace });
	assert.equal(reply.ok, false);
	assert.equal(towerDir(world.slot, got.workspace), headDir(world.slot));
	assert.equal(existsSync(join(world.slot.dir, "tower", got.workspace)), false);
});

test("HH1-F002: the workspace carries sb_head from the moment it is made, before it is moved to the first place, so no reader takes it for a base while the identity registers", async () => {
	const seen: (string | undefined)[] = [];
	const api = world.herdr.api;
	world.herdr.api = async (method: string, params: object) => {
		if (method === "workspace.move") seen.push(world.herdr.workspace((params as { workspace_id: string }).workspace_id).tokens.sb_head);
		return api(method, params);
	};
	await started();
	await head().ensure();
	assert.deepEqual(seen, ["sb-head"]);
});

test("HH1-F003: an ask during the minute after a Herdr restart finds the head's crown tab under other ids and keeps the service: no new workspace, no lost conversation", async () => {
	await clocked();
	const got = await head().ensure();
	world.herdr.restart();
	for (const cb of world.takeovers) cb();
	// The restored session names the crown tab's pane by another id.
	world.herdr.pane(got.pane).pane_id = `${got.workspace}:p900`;
	const again = await head().ensure();
	assert.equal(again.opened, false, "the same service answers");
	assert.equal(again.workspace, got.workspace);
	assert.equal(headWorkspaces(), 1, "no second workspace");
	// The record follows the crown tab (the look registers the identity again with the pane it stands in now).
	await until(() => readService(world.slot, got.workspace)?.pane === `${got.workspace}:p900` && head().status()?.state === "live", "the record to follow the crown tab");
});

test("HH1-F003: an ask during the minute after a restart, with the head's tab not back yet, is refused as `being restored`: the service stays and nothing is made; after the minute a head that is not found is lost and made again", async () => {
	const { clock } = await clocked();
	const got = await head().ensure();
	world.herdr.restart();
	for (const cb of world.takeovers) cb();
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== got.pane);
	world.herdr.tabs = world.herdr.tabs.filter((t) => t.tab_id !== got.tab);
	await assert.rejects(head().ensure(), /being restored/);
	assert.equal(head().status() !== undefined, true, "the service is not lost");
	assert.equal(headWorkspaces(), 1);
	assert.equal(readService(world.slot, got.workspace)?.id, "sb-head");
	await settle();
	clock.advance(1000);
	const made = await head().ensure();
	assert.equal(made.opened, true, "the minute is over: the head is made again");
	assert.equal(headWorkspaces(), 2);
});

test("HH1-F005: with the head workspace not first (the move failed, or the boss dragged it), the first base's tower is keyed after the head, never tied with it", async () => {
	world.herdr.failWorkspaceMove = true;
	const s = await started();
	const got = await head().ensure();
	assert.notEqual(world.herdr.workspaces[0]!.workspace_id, got.workspace, "the head workspace is last");
	await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => world.herdr.panes.find((p) => p.workspace_id === "wA" && p.tokens.sb_role === "tower" && p.tokens.sb_order), "the tower's key");
	const keys = world.herdr.panes.filter((p) => p.tokens.sb_role === "tower" || p.tokens.sb_role === "head").map((p) => [p.tokens.sb_role, p.tokens.sb_order]);
	assert.deepEqual(keys.sort(), [["head", "000.0"], ["tower", "001.0"]]);
});

test("HH1-F006: the head's workspace takes no main: `open-main` and `close-main` for it are refused by the tower service", async () => {
	const s = await started();
	const got = await head().ensure();
	const opened = await ask(s, { cmd: "open-main", workspace: got.workspace, request: "work on it", sender: "x" });
	assert.equal(opened.ok, false);
	assert.match(String(opened.error), /head tower/i);
	const closed = await ask(s, { cmd: "close-main", workspace: got.workspace, query: "x" });
	assert.equal(closed.ok, false);
	assert.match(String(closed.error), /head tower/i);
	assert.deepEqual(world.herdr.commands("tab", "create").filter((c) => c.includes(got.workspace)), [], "no tab was opened in the head workspace");
});

test("HH1 (H3's way in): head/ is reachable by the constant key while no head service stands: the store resolves it, and the memory request writes there", async () => {
	await started();
	assert.equal(head().status(), undefined);
	assert.equal(towerDir(world.slot, HEAD_KEY), headDir(world.slot));
	const read = await world.expose!.memory(HEAD_KEY, { op: "read" });
	assert.equal(read.status, 200);
	const added = await world.expose!.memory(HEAD_KEY, { op: "add", kind: "standing", text: "forward by project", rev: (read.body as { rev: number }).rev });
	assert.equal(added.status, 200);
	assert.equal(existsSync(join(headDir(world.slot), "memory.json")), true);
	assert.equal(existsSync(join(world.slot.dir, "tower", HEAD_KEY)), false);
});

test("HH1-F004: a look that was asking Herdr when the head closed does not write the record again: head/service.json stays gone, and the next start adopts nothing", async () => {
	await clocked();
	const got = await head().ensure();
	world.herdr.restart();
	for (const cb of world.takeovers) cb();
	await settle();
	// The look will find the crown tab under another id (Herdr kept neither id), and is held while it asks for the pane list.
	world.herdr.pane(got.pane).pane_id = `${got.workspace}:p901`;
	let release!: () => void;
	world.herdr.paneListGate = new Promise<void>((resolve) => (release = resolve));
	world.herdr.emit("workspace.moved", "workspace_moved", {});
	await settle();
	world.herdr.paneListGate = undefined; // the look in flight stays held on the promise it already awaits
	await head().close();
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), false);
	release();
	await settle();
	assert.equal(existsSync(join(headDir(world.slot), "service.json")), false, "the look's late write is not made");
	assert.equal(head().status(), undefined);
	assert.deepEqual(listServices(world.slot), []);
});
