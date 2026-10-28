import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { deriveBoard } from "../src/boardauto.ts";
import { writeEntry } from "../src/board.ts";
import { workspaces } from "../src/herdr.ts";
import { gatherMains } from "../src/server/towerbrief.ts";
import { LinkHolder } from "../src/link/holder.ts";
import type { LinkConfig } from "../src/link/config.ts";
import type { NetView } from "../src/link/routing.ts";
import { LinkStore } from "../src/link/store.ts";
import { callControl } from "../src/server/socket.ts";
import { until as untilAsync } from "./fakes.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, bob, clientFor, netOf, rosterOf, TEAM_HEX, writeDevice, writeTeam } from "./link/holder-world.ts";
import { until } from "./link/fakes.ts";
import { TEAM } from "./link/scenario.ts";
import { computer, type Computer, remoteMessage } from "./link/remote-world.ts";
import { type Running } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// Everything that leaves this computer for an ally, driven through its real entry point with poison in every label a person can type: a workspace label, a tab label, a session name, an
// opened-by name and the text of a todo. One table of paths; each output is searched for the poison (a path, a token, an email address), and the local view of the same data stays raw.
// The poison starts early in each label so that cutting before scrubbing would leave a piece of it (the token straddles the 40-character cut).

const PATH = "/etc/secret", MAIL = "me@corp.example", TOKEN = `ghp_${"A1b2C3d4E".repeat(4)}`;
const POISON = [PATH, "ghp_", MAIL, "me@", "corp.example"];
const poisoned = (tag: string) => `${tag} ${PATH} ${MAIL} ${TOKEN}`;
const WS = poisoned("ws"), TAB = poisoned("tab"), NAME = poisoned("nm"), BY = poisoned("by"), TODO = poisoned("todo");
const OUTSIDE = "OutsideWorkspaceZ", OUTSIDE_NAME = "OutsideTowerNameZ";
const leaks = (text: string) => POISON.filter((p) => text.includes(p));
const raw = (text: string) => [WS, TAB, NAME, BY].some((x) => text.includes(x.slice(0, 40)));

let root = "";
let relay: FakeRelay;
let world: TowerWorld | undefined;
const stops: (() => Promise<void>)[] = [];
const computers: Computer[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-ally-egress-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const stop of stops.splice(0)) await stop();
	for (const c of computers.splice(0)) await c.world.stopAll();
	await world?.close();
	world = undefined;
	rmSync(root, { recursive: true, force: true });
});

const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((x) => x.text).join("");

// --- the link holder: the board, the presence, the tower message, and the confirm request on the wire ---------------------------------------------------------------------------

interface Rig { holder: LinkHolder; store: LinkStore; net: NetView; boardDir: string; project: string; offers: { tower: string; id: string }[] }
function rig(name: "a" | "b"): Rig {
	const keys = name === "a" ? alice : bob, entries = rosterOf();
	const dir = join(root, name, "link"), project = join(root, `${name}-project`), boardDir = join(root, name, "board");
	mkdirSync(project, { recursive: true });
	const store = new LinkStore(dir, { alive: () => true });
	store.ensure();
	writeDevice(store, keys, name === "a" ? "alice-mac" : "bob-mac");
	writeTeam(store, entries, keys);
	const r = { store, boardDir, project, offers: [], net: netOf([[`tower-${name}`, `w-${name}`, `label-${name}`, project]]) } as unknown as Rig;
	const config = (): LinkConfig => ({ teams: new Map([[TEAM_HEX, { project, share: "status", name: "moldplan" }]]), trust: new Map(), problems: [] });
	r.holder = new LinkHolder({
		store, isHolder: () => true, config, net: async () => r.net, relay: clientFor(relay), offer: (tower, id) => void r.offers.push({ tower: tower.id, id }), notify: () => {},
		boardDir, backoff: () => 5, drainMs: 20, presenceMs: 40, boardMinMs: 20, offerAgainMs: 60_000, postWaitMs: 3000,
	});
	stops.push(() => r.holder.stop());
	relay.addTeam(TEAM, [alice.id, bob.id], entries);
	return r;
}

/** Computer A's Herdr: a tower, and one main in the project in a tab of its own, with a poisoned workspace label, tab label, session name and todo list. */
function poisonedNet(a: Rig): void {
	const tower = a.net.workspaces[0]!;
	tower.label = WS;
	a.net.panes.push({ pane_id: "m0", tab_id: "w-a:t1", workspace_id: "w-a", cwd: a.project, agent_status: "working", tokens: { sb_role: "main", sb_opened_by: BY } });
	a.net.tabs.push({ tab_id: "w-a:t1", workspace_id: "w-a", label: TAB });
	a.net.sessions.push({ id: "main-1", name: NAME, herdrLocation: { status: "current", workspace: { id: "w-a", label: WS }, tab: { id: "w-a:t1", label: TAB }, paneId: "m0" } });
	// The entry the main's todo list makes (the real derivation): its tasks must never reach an ally, and its name only scrubbed.
	const derived = deriveBoard({ name: NAME, todos: [{ id: 1, subject: TODO, status: "in_progress" }, { id: 2, subject: `${TODO} 2`, status: "pending" }], root: a.project })!;
	writeEntry(a.boardDir, "main-1", derived.text, Date.now(), { src: "todo", ...(derived.count ? { count: derived.count } : {}), ...(derived.who ? { who: derived.who } : {}) });
}

/** The paths of the holder: what computer B holds of computer A after A has sent its board and its presence, and what B's tower and B's confirm list hold of A's messages. */
async function holderPaths(): Promise<Path[]> {
	const [a, b] = [rig("a"), rig("b")];
	poisonedNet(a);
	await Promise.all([a.holder.start(), b.holder.start()]);
	await until(() => {
		const board = b.holder.boards({});
		return board.ok && board.boards.some((x) => x.entries.length > 0) && b.holder.list().some((t) => t.devices.some((d) => d.workspaces.length > 0));
	}, 5000, "A's board and presence at B");
	const sent = await a.holder.send({ fromSession: "tower-a", device: "bob-mac", text: "hello", reply: false });
	assert.ok(sent.ok, sent.ok ? "" : sent.error);
	await until(() => b.offers.length === 1, 5000, "the tower message at B");
	const confirm = await a.holder.requestConfirm({ fromSession: "tower-a", team: TEAM_HEX, device: bob.id, dialogId: "D1", digest: "d1", tool: "bash", args: "{}", tower: poisoned("tw") });
	assert.deepEqual(confirm, { ok: true });
	await until(() => b.holder.confirmRequests().length === 1, 5000, "the confirm request at B");
	// Read now, while A's board and presence are the poisoned ones.
	const snap = (read: () => unknown) => ((json) => async () => json)(JSON.stringify(read()));
	return [
		{ name: "holder board wire (workspace, tab, name, now, items)", out: snap(() => b.holder.boards({})) },
		{ name: "holder presence (workspace and tab labels)", out: snap(() => b.holder.list()) },
		{ name: "holder tower message (fromWorkspace)", out: snap(() => b.store.readInbox(b.offers[0]!.id)) },
		{ name: "holder confirm request (tower)", out: snap(() => b.holder.confirmRequests()) },
	];
}

// --- a remote turn of a tower's pi (the extension), and an ally run of the sb server ----------------------------------------------------------------------------------------------

interface Path { name: string; out: () => Promise<string>; local?: () => Promise<string> }

/** Computer A, whose tower is in a remote turn from bob: board_read, tower_list and boss_status as the senders may read them; and the same tools in a local turn. */
async function remoteTurnPaths(): Promise<Path[]> {
	const a = computer(root, relay, "a", { gateMs: 60 });
	computers.push(a);
	const herdr = a.world.herdr;
	herdr.workspaces.find((w) => w.workspace_id === "wA")!.label = WS;
	herdr.tabs.find((t) => t.tab_id === "wA:t1")!.label = TAB;
	// A second workspace with a tower, outside the project: no ally path may name it.
	herdr.workspaces.find((w) => w.workspace_id === "wB")!.label = OUTSIDE;
	herdr.workspaces.find((w) => w.workspace_id === "wB")!.tokens.tower = "tower-b";
	const other = a.world.agent({ id: "tower-b", name: OUTSIDE_NAME, pane: "wB:p1", tab: "wB:t1", deps: a.deps });
	await other.start();
	const main = a.world.agent({ id: "main-1", name: NAME, pane: "wA:p1", tab: "wA:t1", deps: a.deps });
	herdr.pane("wA:p1").cwd = a.project;
	herdr.pane("wA:p1").tokens.sb_opened_by = BY;
	await a.tower.start();
	await main.start();
	await main.promote();
	main.entries.push({ customType: "rpiv-todo-state", data: { tasks: [{ id: 1, subject: TODO, status: "in_progress", activeForm: TODO }, { id: 2, subject: `${TODO} 2`, status: "pending" }], nextId: 3 } });
	await main.fire("turn_end");
	await untilAsync(async () => text(await a.tower.tool("board_read", { scope: "local" })).includes('"t"'), "the auto entry");
	const call = (name: string) => async () => text(await a.tower.tool(name, {}));
	const remote = async (name: string) => {
		await a.tower.fire("message_start", { message: remoteMessage(bob, "bob-mac") });
		try {
			return await call(name)();
		} finally {
			await a.tower.fire("agent_settled", { aborted: false });
		}
	};
	return ["board_read", "tower_list", "boss_status"].map((name) => ({ name: `remote turn ${name}`, out: () => remote(name), local: call(name) }));
}

type Reply = Record<string, unknown> & { ok: boolean; error?: string; details?: unknown; brief?: unknown };
/** The sb server with a tower, and an ally run of team-1 whose sender's team binds `proj`: the run's tools and its brief. */
async function allyRunPaths(): Promise<Path[]> {
	world = new TowerWorld();
	world.setFlag(true);
	const s: Running = await world.start();
	await s.handle.ready;
	const ask = (cmd: Record<string, unknown>) => callControl(s.handle.endpoint, world!.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
	// The workspace label before the tower is ensured: the service records it, and the brief names it.
	world.herdr.workspaces.find((w) => w.workspace_id === "wA")!.label = WS;
	world.herdr.workspaces.find((w) => w.workspace_id === "wB")!.label = OUTSIDE;
	await ask({ cmd: "ensure-tower", workspace: "wA" });
	const proj = join(world.stateDir, "proj");
	mkdirSync(join(proj, "app"), { recursive: true });
	world.ally.projects.set("team-1", proj);
	const herdr = world.herdr;
	herdr.tabs.find((t) => t.tab_id === "wA:t1")!.label = TAB;
	herdr.addPane("wA:p71", "wA:t1", "pi").tokens.sb_role = "main";
	herdr.pane("wA:p71").cwd = join(proj, "app");
	herdr.pane("wA:p71").tokens.sb_opened_by = BY;
	// A member in the same tab, and the tower of another workspace: their names are in tower_list and boss_status.
	herdr.addPane("wA:p72", "wA:t1", "pi").tokens.sb_role = "member";
	herdr.pane("wA:p72").cwd = join(proj, "app");
	herdr.workspaces.find((w) => w.workspace_id === "wB")!.tokens.tower = "tower-b";
	const at = (paneId: string, workspace: { id: string; label: string }, tab: { id: string; label: string }) => ({ status: "ok" as const, workspace, tab, paneId });
	world.sessions = [
		{ id: "main-1", name: NAME, herdrLocation: at("wA:p71", { id: "wA", label: WS }, { id: "wA:t1", label: TAB }) },
		{ id: "member-1", name: poisoned("mem"), herdrLocation: at("wA:p72", { id: "wA", label: WS }, { id: "wA:t1", label: TAB }) },
		{ id: "tower-b", name: OUTSIDE_NAME, herdrLocation: at("wB:p1", { id: "wB", label: OUTSIDE }, { id: "wB:t1", label: "ops" }) },
	];
	const derived = deriveBoard({ name: NAME, todos: [{ id: 1, subject: TODO, status: "in_progress" }], root: proj })!;
	mkdirSync(join(world.stateDir, "board"), { recursive: true });
	writeEntry(join(world.stateDir, "board"), "main-1", derived.text, Date.now(), { src: "todo", ...(derived.count ? { count: derived.count } : {}), ...(derived.who ? { who: derived.who } : {}) });
	const allyToken = world.expose!.runs.mint("wA", { kind: "ally", device: "d1", level: "reply", team: "team-1" });
	// A local run's token comes from a claimed run; the ally's token is minted, and a local one is minted the same way.
	const localToken = world.expose!.runs.mint("wA", { kind: "local" });
	const tool = async (token: unknown, name: string) => {
		const got = await ask({ cmd: "run-tool", token, tool: name, args: {} });
		assert.equal(got.ok, true, `${name}: ${JSON.stringify(got)}`);
		return JSON.stringify(got);
	};
	const brief = async () => {
		world!.ally.add("m1", "a".repeat(26), "hello");
		world!.expose?.allyWaiting("sb-tower-wa");
		await untilAsync(() => world!.pis.size >= 1, "the ally run");
		const [id, pi] = [...world!.pis.entries()][0]!;
		await untilAsync(() => readdirSync(join(world!.stateDir)).length > 0, "the state");
		const got = await ask({ cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
		assert.equal(got.ok, true, JSON.stringify(got));
		return JSON.stringify(got.brief);
	};
	// What the brief is built from, with the fields it does not print yet (opened-by, the ledger's lines, the head's label): a later brief change must not leak them.
	const gather = async (within?: { project: string }) => {
		const workspace = (await workspaces(world!.herdr.runFor("none"))).find((w) => w.workspace_id === "wA")!;
		const ledger = [{ key: "k", sender: BY, outcome: "opened" as const, at: 1, opened: { tab: TAB, pane: "wA:p71", main: "main-1", sender: BY } }];
		return JSON.stringify(await gatherMains({ run: world!.herdr.runFor("none"), now: Date.now, sessions: async () => world!.sessions, boardDir: join(world!.stateDir, "board"), workspace, ledger, ...(within ? { within } : {}) }));
	};
	return [
		{ name: "ally run gatherMains (tab, main, opened-by, ledger lines, head)", out: () => gather({ project: proj }), local: () => gather() },
		...["boss_status", "tower_list", "board_read"].map((name) => ({ name: `ally run ${name}`, out: () => tool(allyToken, name), local: () => tool(localToken, name) })),
		{ name: "ally run brief (the mains it may see, its workspace label)", out: brief },
	];
}

test("no path that leaves for an ally carries a path, a token, or an email address from a label, a name, or a todo; the local views keep them raw", async () => {
	const paths = [...(await holderPaths()), ...(await remoteTurnPaths()), ...(await allyRunPaths())];
	const found: string[] = [];
	for (const p of paths) {
		const out = await p.out();
		if (out.includes(OUTSIDE) || out.includes(OUTSIDE_NAME)) found.push(`${p.name}: a workspace outside the project`);
		for (const l of leaks(out)) found.push(`${p.name}: ${l}`);
		// A path that carried no label at all would pass for the wrong reason: a scrubbed label shows the mark.
		if (!out.includes("…")) found.push(`${p.name}: no scrubbed label in the output`);
	}
	assert.deepEqual(found, [], "poison reached an ally");
	// The local view of the same data is untouched.
	const rawMissing: string[] = [];
	for (const p of paths) if (p.local && !raw(await p.local())) rawMissing.push(p.name);
	assert.deepEqual(rawMissing, [], "a local view lost its raw label");
});

test("only boardauto.ts calls scrubBoard: every other place that sends a label to an ally goes through allyLabel", () => {
	const callers: string[] = [];
	const walk = (dir: string) => {
		for (const f of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, f.name);
			if (f.isDirectory()) walk(path);
			else if (f.name.endsWith(".ts") && /\bscrubBoard\(/.test(readFileSync(path, "utf8"))) callers.push(path);
		}
	};
	walk(join(import.meta.dirname, "..", "src"));
	assert.deepEqual(callers.map((c) => c.slice(c.lastIndexOf("src/"))), ["src/boardauto.ts"]);
});
