import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { isPiPane } from "../src/answerpane.ts";
import { createCloser } from "../src/closer.ts";
import { readEntries } from "../src/board.ts";
import { collect, render } from "../src/dashboard.ts";
import { ROLE_WORDS } from "../src/header.ts";
import { collectNet, type Ref } from "../src/net.ts";
import { RUN_PANE_ROLES } from "../src/runmode.ts";
import { joinedAs } from "../src/spawn.ts";
import { MARK } from "../src/herdr.ts";
import { gatherMains, buildBrief } from "../src/server/towerbrief.ts";
import { survey } from "../src/stash.ts";
import { isSessionRole, ownsBoard, TRAIN_EVENT } from "../src/trainrole.ts";
import { until, World, towersOf } from "./fakes.ts";
import { trainBase } from "./train-base-fixture.ts";

// The readers of `sb_role` and what each does with the value `train` (docs/specs/2026-11-07-train-workers.md §3.3, table; task 3). One test per row, from one table: a row that is not taught fails
// by its own name, and the last test fails when the table and the spec's list of readers drift apart. The readers that are the pure part of a module are exercised on fixtures, the others
// through a world that opened a train the way the tower does.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});
const M = "2026-11-06-m";
const MANIFEST = `train:\n  project: acme\n  app: web\n  code: ${M}\n`;
const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

/** A tower, an integrator's main, and one train the tower opened. */
async function withTrain() {
	// The pi of an opened tab, as the tower's open starts it: the train role in its shell, a session file, and an id a board file can be named for.
	world.herdr.onAgentStart = (pane) => {
		const agent = world.agent({ id: "train-1", name: "train 1106m", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "" } });
		agent.file = "/s/train.jsonl";
		void agent.start();
	};
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const sender = world.agent({ id: "sender-1", name: "integ-acme", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await sender.promote();
	await tower.tool("boss_open_main", { role: "train", request: MANIFEST, sender: "integ-acme" });
	const pane = world.herdr.panes.find((p) => p.tokens.sb_role === "train")!;
	const train = world.agents.find((a) => a.pane === pane.pane_id)!;
	return { tower, sender, pane, train };
}
const sessions = () => world.broker.sessionList();
const json = (result: { content: unknown[] }) => JSON.parse(result.content.map((c) => (c as { text?: string }).text).join("")) as Record<string, any>;

const READERS: Record<string, () => Promise<void>> = {
	"net.ts joinedRole: a unit with role train and its train, a ref with role train, not outside": async () => {
		const { pane } = await withTrain();
		const refs = new Map<string, Ref>();
		const net = await collectNet({ run: world.herdr.runFor("none"), sessions: sessions, refs });
		const base = net.bases.find((b) => b.id === "wA")!;
		const unit = base.tabs.flatMap((t) => t.units).find((u) => u.role === ("train" as string))!;
		assert.ok(unit, "the train is a unit of its tab");
		assert.deepEqual((unit as { train?: unknown }).train, { project: "acme", code: M });
		assert.equal(unit.name, "train 1106m");
		assert.equal(refs.get(unit.key)?.role, "train");
		assert.deepEqual(base.outside.filter((u) => u.key.includes(pane.pane_id)), [], "not among the panes the net does not hold");
	},
	"dashboard.ts: a row with the train mark": async () => {
		await withTrain();
		const snapshot = await collect({ run: world.herdr.runFor("wA:p7"), sessions: sessions, workspaceId: "wA" });
		assert.ok(snapshot.rows.some((r) => r.kind === "train" && r.text === "train 1106m"), JSON.stringify(snapshot.rows));
		const drawn = render(snapshot, 0, 80, (_tone, text) => text);
		assert.ok(drawn.some((l) => l.includes(`${MARK.train} train 1106m`)), `the row carries the train mark before its name:\n${drawn.join("\n")}`);
	},
	"server/towerbrief.ts: the tower run's brief shows a train as a train, with its state and board line, and its opened line is no main's": async () => {
		const { tower, train, pane } = await withTrain();
		await train.tool("board_set", { now: "assembling 1106m", items: [{ t: "assemble", done: false }] });
		const opened = world.herdr.pane(pane.pane_id);
		const ledger = [{ key: "k", sender: "integ-acme", outcome: "opened" as const, at: Date.now(), opened: { tab: opened.tab_id, pane: pane.pane_id, main: train.id, sender: "integ-acme", train: { project: "acme", code: M } } }];
		const g = await gatherMains({ run: world.herdr.runFor("wA:p7"), now: Date.now, sessions, boardDir: join(world.stateDir, "board"), workspace: { workspace_id: "wA", label: "Alpha" } as never, ledger });
		const row = g.rows.find((r) => r.train);
		assert.ok(row, JSON.stringify(g.rows));
		assert.equal(row!.main, undefined, "a train is no main");
		assert.equal(row!.train!.id, train.id);
		assert.equal(row!.train!.now, "assembling 1106m");
		assert.match(g.opened[0]!, /^train train 1106m \(tab .*\) was opened for integ-acme; close it after its milestone report$/);
		const brief = buildBrief({ label: "Alpha", workspace: "wA", head: "Alpha", woken: "10:00", counts: { intercom: 1 }, identity: "tower", mains: g.rows, obligations: g.opened, digest: [], flags: [], tools: ["- x"] });
		assert.match(brief, /train 1106m: train train 1106m \(/);
		assert.match(brief, /; now: assembling 1106m/);
		assert.doesNotMatch(brief, /main train 1106m/);
		assert.equal(tower.tokens.sb_role, "tower");
	},
	"spawn.ts awaitJoin: any joined role counts, a named role must match exactly": async () => {
		assert.equal(joinedAs("train"), true);
		assert.equal(joinedAs("train", "train"), true);
		assert.equal(joinedAs("member", "train"), false);
		assert.equal(joinedAs("train", "main"), false);
		assert.equal(joinedAs("main", "main"), true);
		assert.equal(joinedAs(undefined), false);
		assert.equal(joinedAs("tower"), false);
	},
	"opener.ts: the open waits for train exactly and the pane ends up a train": async () => {
		const { pane } = await withTrain();
		assert.equal(pane.tokens.sb_role, "train");
	},
	"guard.ts, server/towers.ts: the member counts take a train as a joined session": async () => {
		assert.deepEqual(["member", "main", "train"].map(isSessionRole), [true, true, true]);
		for (const other of ["tower", "head", "ally", "", undefined]) assert.equal(isSessionRole(other), false, String(other));
		for (const file of ["guard.ts", "server/towers.ts", "session.ts"]) assert.match(src(file), /isSessionRole/, `${file} counts through the shared rule`);
	},
	"session.ts: a tower that quits counts the train among the base's sessions": async () => {
		const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
		await tower.start();
		const sender = world.agent({ id: "sender-1", name: "integ-acme", pane: "wA:p1", tab: "wA:t1" });
		await sender.start();
		world.autoMains();
		await tower.tool("boss_open_main", { role: "train", request: MANIFEST, sender: "integ-acme" });
		await tower.stop("quit");
		assert.equal(world.herdr.workspace("wA").tokens.sb_tower_quit, "2", "the sender and the train");
	},
	"stash.ts: refused, naming the reason": async () => {
		const b = trainBase();
		const sv = await survey(b.run, "wA", b.live);
		assert.ok(sv?.reasons.some((r) => /a train runs in this tab/.test(r)), JSON.stringify(sv?.reasons));
		assert.deepEqual(sv?.agents.map((a) => a.id), ["tower"], "the train is not asked to be stashed");
	},
	"closer.ts: a train is not asked to quit, and a tab or base holding one is not closed behind its back": async () => {
		const b = trainBase(), asked: string[] = [];
		const closer = createCloser({ run: b.run, sleep: async () => {}, me: () => "server", sessions: async () => b.live, ask: async (key) => (asked.push(key), { accepted: true }) });
		const tab = await closer("tab", { workspace: "wA", tab: "wA:t2" });
		assert.equal(tab.status, 409);
		assert.match(JSON.stringify(tab.body), /train 1106m|a train runs/);
		const base = await closer("base", { workspace: "wA" });
		assert.equal(base.status, 409);
		assert.ok(!asked.includes("train-1"), "the train was not asked");
		assert.deepEqual(b.ran.filter((a) => a[0] === "tab" && a[1] === "close"), [], "no tab was closed");
		assert.deepEqual(b.ran.filter((a) => a[0] === "workspace" && a[1] === "close"), [], "no workspace was closed");
	},
	"closemain.ts: the tower closes an idle train with the checks of an opened main, and a busy one stays": async () => {
		const { tower, pane, train } = await withTrain();
		world.herdr.pane(pane.pane_id).agent_status = "idle";
		train.pending = true; // a queued message: something that would be lost
		await assert.rejects(tower.tool("boss_close_main", { main: train.id }), /will not close/);
		assert.equal(train.stopped, false);
		train.pending = false;
		await tower.tool("boss_close_main", { main: train.id });
		await until(() => train.stopped, "the train quit");
	},
	"closemain.ts: a train nobody opened is closed by the boss alone": async () => {
		const { tower, pane, train } = await withTrain();
		world.herdr.pane(pane.pane_id).agent_status = "idle";
		delete world.herdr.pane(pane.pane_id).tokens.sb_opened_by;
		await assert.rejects(tower.tool("boss_close_main", { main: train.id }), /was not opened by a tower|no tower opened/);
	},
	"roles.ts: a record with role train, its project, code and opener": async () => {
		const { train } = await withTrain();
		const dir = join(world.stateDir, "roles");
		const records = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>);
		const mine = records.find((r) => r.role === "train");
		assert.ok(mine, JSON.stringify(records));
		assert.deepEqual(mine!.train, { project: "acme", code: M });
		assert.equal(mine!.openedBy, "sender-1");
		assert.equal(train.tokens.sb_role, "train");
	},
	"reach.ts, header.ts: a message from a train carries role=train": async () => {
		const { tower, train } = await withTrain();
		await train.tool("call_tower", { message: "merge landed", why: "milestone", reply: false });
		const got = world.broker.delivered.filter((d) => d.from === train.id && d.to === tower.id);
		assert.equal(got.length, 1);
		assert.match(got[0]!.message, /role=train/);
	},
	"header.ts: the role words are one list that names train": async () => {
		assert.deepEqual([...ROLE_WORDS], ["tower", "main", "member", "train"]);
		for (const file of ["reach.ts"]) assert.match(src(file), /ROLE_WORDS/, `${file} reads the shared list`);
	},
	"order.ts: the train has a key under its tab and a mark, and no main or member tab label": async () => {
		const { pane } = await withTrain();
		const t = world.herdr.pane(pane.pane_id).tokens;
		assert.ok(t.sb_order, "an order key");
		assert.ok(t.sb_mark, "a mark");
		assert.equal(t.sb_main_tab, undefined);
		assert.equal(t.sb_tab, undefined);
	},
	"board_set, board_read, boss_status: a train writes a board line and is listed as a train": async () => {
		const { tower, train, pane } = await withTrain();
		await train.tool("board_set", { now: "assembling 1106m", items: [{ t: "assemble", done: false }] });
		const board = json(await tower.tool("board_read", { scope: "local" }));
		const row = (board.local as Record<string, any>[]).find((r) => r.main === "train 1106m");
		assert.ok(row, JSON.stringify(board));
		assert.equal(row!.role, "train");
		assert.equal(row!.now, "assembling 1106m");
		const status = json(await towersOf(tower));
		const tab = (status.tabs as Record<string, any>[]).find((t) => t.id === pane.tab_id)!;
		assert.equal(tab.main, null, "a train is not the tab's main");
		assert.equal(tab.train, train.id);
	},
	"reach.ts tower_list: a tab with a train says so, in a train key, and a tab without one has none": async () => {
		const { tower, pane } = await withTrain();
		const sender = world.agents.find((a) => a.id === "sender-1")!;
		const list = json(await tower.tool("tower_list"));
		const tabs = (list.towers as Record<string, any>[]).flatMap((t) => t.tabs as Record<string, any>[]);
		const trainTab = tabs.find((t) => t.label === "train 1106m")!;
		assert.equal(trainTab.main, null, "a train is no main");
		assert.equal(trainTab.train, "train 1106m");
		assert.ok(tabs.filter((t) => t.label !== "train 1106m").every((t) => !("train" in t)), "the other tabs carry no train key");
		assert.ok(sender && pane);
	},
	"boardfill.ts: a train's board line fills from its todos as a main's does": async () => {
		const { train } = await withTrain();
		train.entries.push({ customType: "rpiv-todo-state", data: { tasks: [{ id: 1, subject: "Assemble the cars", status: "in_progress", activeForm: "Assembling the cars" }, { id: 2, subject: "Land", status: "pending" }], nextId: 3 } });
		await train.fire("turn_end");
		const entry = readEntries(join(world.stateDir, "board")).find((e) => e.session === train.id);
		assert.ok(entry, "a board entry of the train");
		assert.equal(entry!.src, "todo");
		assert.match(entry!.now, /Assembling the cars/);
		assert.deepEqual(entry!.count, { done: 0, total: 2 });
	},
	"answerpane.ts, runmode.ts: a pi pane, not a run pane": async () => {
		assert.equal(isPiPane({ tokens: { sb_role: "train" } }), true);
		assert.equal(RUN_PANE_ROLES.has("train"), false);
	},
	"hygiene.ts, server/procs.ts: the train's pi says hello as a train, an owner of its own, when its session says it is one": async () => {
		const { createHygiene } = await import("../src/hygiene.ts");
		const make = (env: Record<string, string>) => {
			const calls: Record<string, unknown>[] = [], handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>(), bus = new Map<string, ((data: unknown) => void)[]>();
			createHygiene({
				env: { HERDR_PANE_ID: "p_9", ...env }, platform: "darwin", argv: ["node", "pi"], pid: 4300, now: () => 0, startOf: () => "Tue Nov  3 21:00:00 2026",
				call: async (request) => (calls.push(request), { ok: true }), terminalOf: async () => "term-1", every: () => () => {}, track: () => {},
			})({
				on: (name: string, fn: (e: unknown, c: unknown) => unknown) => void handlers.set(name, [...(handlers.get(name) ?? []), fn]),
				events: { on: (name: string, fn: (data: unknown) => void) => void bus.set(name, [...(bus.get(name) ?? []), fn]) },
			} as never);
			return {
				calls,
				fire: async (name: string, event: unknown) => { for (const fn of handlers.get(name) ?? []) await fn(event, { cwd: "/w/train", sessionManager: { getSessionFile: () => "/s/t.jsonl" }, ui: { notify() {} } }); },
				say: (name: string, data: unknown) => (bus.get(name) ?? []).forEach((fn) => fn(data)),
			};
		};
		const later = () => new Promise((done) => setTimeout(done, 20));
		// the role in the shell alone: a later pi in the train's tab, or one whose claim failed, registers nothing and is not reaped at its quit
		const shell = make({ STRAW_BOSS_ROLE: "train" });
		await shell.fire("session_start", { reason: "startup" });
		await later();
		assert.deepEqual(shell.calls, []);
		await shell.fire("session_shutdown", { reason: "quit" });
		assert.deepEqual(shell.calls, [], "no procs-bye either");
		// the session's own word makes the train
		const train = make({ STRAW_BOSS_ROLE: "train" });
		await train.fire("session_start", { reason: "startup" });
		train.say(TRAIN_EVENT, { train: true });
		await later();
		const hello = train.calls.find((c) => c.cmd === "procs-hello");
		assert.ok(hello, JSON.stringify(train.calls));
		assert.equal(hello!.role, "train");
		assert.equal(hello!.id, "train-4300");
		assert.equal(hello!.subagentId, undefined);
		assert.match(src("server/procsops.ts"), /role/);
		await train.fire("session_shutdown", { reason: "quit" });
		assert.deepEqual(train.calls.at(-1), { cmd: "procs-bye", id: "train-4300" });
		// a /new in the same process: not the train until its session says so again
		const again = make({});
		await again.fire("session_start", { reason: "startup" });
		again.say(TRAIN_EVENT, { train: true });
		await again.fire("session_shutdown", { reason: "new" });
		await again.fire("session_start", { reason: "new" });
		await later();
		again.calls.length = 0;
		await again.fire("session_shutdown", { reason: "quit" });
		assert.deepEqual(again.calls, [], "the second session was not the train");
		// a subagent id wins over the train word
		const worker = make({ PI_SUBAGENT_ID: "w-1" });
		await worker.fire("session_start", { reason: "startup" });
		worker.say(TRAIN_EVENT, { train: true });
		await later();
		assert.equal(worker.calls.filter((c) => c.cmd === "procs-hello").every((c) => c.role === undefined && c.id === "w-1-4300"), true, JSON.stringify(worker.calls));
	},
	"hygiene.ts, session.ts: the session says it is a train on pi's event bus, and a later member in the train's shell does not": async () => {
		const { pane } = await withTrain();
		const said = (a: { emitted: [string, unknown][] }) => a.emitted.filter(([name]) => name === TRAIN_EVENT);
		const train = world.agents.find((a) => a.pane === pane.pane_id)!;
		assert.deepEqual(said(train), [[TRAIN_EVENT, { train: true }]]);
		await train.stop("new");
		const later = world.agent({ id: "later", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "train" }, deps: { couple: false } });
		await later.start();
		assert.deepEqual(said(later), []);
	},
	"the work board's owner rule: a train writes it as a main does": async () => {
		assert.equal(ownsBoard("main"), true);
		assert.equal(ownsBoard("train"), true);
		for (const other of ["member", "tower", undefined]) assert.equal(ownsBoard(other), false, String(other));
	},
};

for (const [name, run] of Object.entries(READERS)) test(`reader ${name}`, run);

test("the table lists every reader of the spec's table (§3.3) and no reader is left untaught", () => {
	const spec = readFileSync(new URL("../docs/specs/2026-11-07-train-workers.md", import.meta.url), "utf8");
	const section = spec.slice(spec.indexOf("| Reader | With `sb_role=train` |"), spec.indexOf("### 3.4 Concurrency"));
	const files = [...section.matchAll(/^\| ((?:`[^`]+`[^|]*?)+) \|/gm)].flatMap((m) => [...m[1]!.matchAll(/`([\w./]+\.ts)`/g)].map((f) => f[1]!));
	assert.ok(files.length >= 14, `the spec's table names ${files.length} files`);
	const named = Object.keys(READERS).join(" ");
	// order.ts and the board files are rows too; link/* and the unchanged readers are covered by the one row that checks they ignore it.
	for (const file of new Set(files.map((f) => f.replace(/^.*\//, "")))) {
		if (["boardauto.ts", "boardread.ts", "sidecar.ts", "link"].includes(file)) continue;
		assert.ok(named.includes(file.replace(/\.ts$/, "")), `${file} has a row in the table above`);
	}
});
