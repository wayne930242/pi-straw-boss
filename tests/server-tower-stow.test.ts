import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, until } from "./server-world.ts";
import { callControl } from "../src/server/socket.ts";
import { readRun } from "../src/server/towerrunstore.ts";
import { readService } from "../src/server/towerstore.ts";
import { type Entry, updateMemory } from "../src/server/towermemory.ts";
import { TOWER_LABEL } from "../src/herdr.ts";

// A tower's standing pane closes between runs (the boss's order of 2026-11-28, 「只在有卡片等我時才留」; src/server/towerstow.ts): once no run is live, nothing waits to wake one, and no card waits for the boss, the
// pane closes (never the tab: Herdr drops the emptied tab itself) and the service goes on with no pane. The next event, the boss's word, a card, or an ensure-tower opens it again as the first open did.
// Against the fake Herdr of the tower world, with a prompt that is a test and short stow timers.

let world: TowerWorld;
const prompts: FakePrompt[] = [];
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
	world.stowTimers = { intervalMs: 20, idleMs: 150 };
	// Herdr ends what ran in a pane it closes.
	world.herdr.onPanesGone = (ids) => prompts.filter((p) => ids.includes(p.pane)).forEach((p) => p.stop());
});
afterEach(async () => {
	for (const p of prompts.splice(0)) p.stop();
	await world.close();
});

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
/** Alpha with a main's pane in its first tab (`wA:p1`), and its tower; `alone`: the tower's pane is the workspace's only one. */
const setup = async (alone = false) => {
	if (!alone) world.herdr.addPane("wA:p1", "wA:t1", "shell");
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	return { s, pane: String(ensured.pane), tab: String(ensured.tab) };
};
const logged = (event: string, why?: string) => readFileSync(join(world.slot.dir, "server.log"), "utf8").split("\n").map((l) => l.split(" ")).some((w) => w.includes(event) && (!why || w.includes(`why=${why}`)));
const towerPane = () => world.herdr.panes.find((p) => p.tokens?.sb_role === "tower")?.pane_id;
const exit = (id: string) => world.live.delete(world.pis.get(id)!.pid);
const nthRun = async (n = 1) => {
	await until(() => world.pis.size >= n, `run ${n} to start`);
	const id = [...world.pis.keys()][n - 1]!;
	await until(() => readRun(world.slot, "wA", id)?.pid, "the run's pid to be recorded");
	return id;
};
/** The run's pi claims its run, takes every event it is offered, and ends with tower_done. */
const work = async (s: Running, id: string) => {
	const pi = world.pis.get(id)!;
	const got = await ask(s, { cmd: "claim", runId: id, pane: pi.pane, pid: pi.pid, started: `T-${pi.pid}` });
	assert.equal(got.ok, true, JSON.stringify(got));
	const token = String(got.token);
	for (;;) {
		const event = (await ask(s, { cmd: "run-poll", token, idle: true })).event as { id: string } | undefined;
		if (!event) break;
		assert.equal((await ask(s, { cmd: "run-taken", token, id: event.id })).ok, true);
	}
	assert.equal((await ask(s, { cmd: "run-done", token, note: "n" })).ok, true);
};
const card = (id: string, extra: Partial<Entry> = {}): Entry => ({ id, kind: "wait", text: `do ${id}`, by: "run", via: "run", at: new Date().toISOString(), run: "r1", for: "boss", state: "open", card: { type: "action", lang: "en", happened: "h", do: `do ${id}` }, ...extra });

/** The tower prompt as the server sees it: a process in the pane's foreground that polls (saying whether the boss has words on its line), and leaves when told to. */
class FakePrompt {
	draft = false;
	stopped = false;
	polls = 0;
	last: Reply | undefined;
	timer: ReturnType<typeof setInterval>;
	s: Running;
	pane: string;
	pid: number;
	constructor(s: Running, pane: string, pid = 6100 + prompts.length) {
		this.s = s;
		this.pane = pane;
		this.pid = pid;
		world.herdr.pane(pane).processes = [{ name: "node", argv0: "node", pid, cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace wA --state-dir "/s"` }];
		this.timer = setInterval(() => void this.poll(), 20);
		prompts.push(this);
	}
	async poll() {
		if (this.stopped) return;
		this.last = await ask(this.s, { cmd: "prompt-poll", workspace: "wA", pid: this.pid, ...(this.draft ? { draft: true } : {}) }).catch(() => undefined);
		if (this.last?.ok) this.polls++;
		if (this.last?.leave || this.last?.gone) {
			this.stop();
			if (world.herdr.panes.some((p) => p.pane_id === this.pane)) (world.herdr.pane(this.pane).processes = [], world.herdr.dropStandin(this.pane));
			if (this.last?.leave) await ask(this.s, { cmd: "prompt-gone", workspace: "wA", pid: this.pid }).catch(() => {});
		}
	}
	stop() {
		this.stopped = true;
		clearInterval(this.timer);
	}
}
/**
 * The prompt the server typed into the pane comes up there (the server types it; the test is the program). `draft`: its line holds the boss's words from its first poll. Nothing is awaited after it starts: an idle pane may close
 * at the next look once the prompt polls, so a test that needs the pane to stay sets what keeps it first.
 */
const promptIn = async (s: Running, pane: string, typings = 1, draft = false) => {
	await until(() => world.herdr.typed.filter((t) => t.pane === pane).length >= typings, `the prompt to be typed into ${pane}`);
	const prompt = new FakePrompt(s, pane);
	prompt.draft = draft;
	return prompt;
};
const stowed = async (pane: string) => {
	await until(() => world.herdr.closed.includes(pane), `the standing pane ${pane} to close`);
	await until(() => readService(world.slot, "wA")?.pane === "", "the service to stand with no pane");
};

test("a run that ends with no card waiting closes the standing pane, never its tab: the tab goes with its last pane, and the service, its identity and its token stay", async () => {
	const { s, pane, tab } = await setup();
	// No prompt polls before the run: only a polling prompt lets the pane close, so the run takes this one.
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "look at the build" });
	const id = await nthRun();
	assert.equal(world.pis.get(id)!.pane, pane);
	const typings = world.herdr.typed.filter((t) => t.pane === pane).length;
	assert.ok(!world.herdr.closed.includes(pane), "no close while the run is live");
	await work(s, id);
	exit(id);
	await until(() => readRun(world.slot, "wA", id)?.outcome === "done", "the run to end");
	// pi exited: Herdr clears the pane, and the prompt comes back before the pane closes.
	Object.assign(world.herdr.pane(pane), { agent: undefined, processes: [] });
	await promptIn(s, pane, typings + 1);
	await stowed(pane);
	assert.ok(!world.herdr.commands("tab", "close").length, "the tab is never closed: Herdr drops it with its last pane");
	assert.ok(!world.herdr.tabs.some((t) => t.tab_id === tab));
	assert.ok(world.herdr.panes.some((p) => p.pane_id === "wA:p1"), "the main's pane stays");
	assert.ok(world.herdr.workspaces.some((w) => w.workspace_id === "wA"));
	assert.equal(world.herdr.workspace("wA").tokens.tower, "sb-tower-wa", "the tower's token stays: mains still see a tower and call it");
	const identity = () => world.clients.filter((c) => c.sessionId === "sb-tower-wa").at(-1);
	await until(() => identity()?.isConnected() && identity()!.registered?.herdrPaneId === "", "the identity to stay registered, with no pane");
	assert.ok(logged("tower-stowed"));
	const status = await ask(s, { cmd: "status" });
	assert.ok(JSON.stringify(status).includes("sb-tower-wa"), "the tower is still a service of the server");
});

test("the next event opens the pane again as the first open does (a tab first, marked sb_role=tower), and its run starts there", async () => {
	const { s, pane } = await setup();
	await promptIn(s, pane);
	await stowed(pane);
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "one more thing" });
	const id = await nthRun();
	const fresh = world.pis.get(id)!.pane;
	assert.notEqual(fresh, pane);
	const made = world.herdr.panes.find((p) => p.pane_id === fresh)!;
	assert.equal(made.tokens?.sb_role, "tower");
	assert.equal(world.herdr.tabs.find((t) => t.tab_id === made.tab_id)?.label, TOWER_LABEL);
	assert.equal(world.herdr.tabs.filter((t) => t.workspace_id === "wA")[0]!.tab_id, made.tab_id, "the tower's tab is first again");
	assert.equal(readService(world.slot, "wA")?.pane, fresh);
	assert.ok(logged("tower-unstowed", "run"));
});

test("a card that appears while no pane exists opens the pane, and its row says the card waits; once it is answered and no run is live the pane closes again", async () => {
	const { s, pane } = await setup();
	await promptIn(s, pane);
	await stowed(pane);
	updateMemory(world.slot, "wA", Date.now(), (m) => void m.entries.push(card("W1")));
	await until(() => towerPane(), "a standing pane for the card");
	const fresh = towerPane()!;
	assert.ok(logged("tower-unstowed", "cards"));
	await promptIn(s, fresh);
	await until(() => world.herdr.panes.find((p) => p.pane_id === fresh)?.standinMessage === "1 card waits", "the row to say the card waits");
	assert.equal(world.herdr.pane(fresh).agent_status, "blocked");
	assert.equal(world.pis.size, 0, "a card wakes no run");
	updateMemory(world.slot, "wA", Date.now(), (m) => void (m.entries.find((e) => e.id === "W1")!.state = "resolved"));
	await stowed(fresh);
});

test("an ensure-tower of a tower with no pane (a bare /boss tower, a promotion) opens its pane and answers it", async () => {
	const { s, pane } = await setup();
	await promptIn(s, pane);
	await stowed(pane);
	const again = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(again.ok, true, JSON.stringify(again));
	assert.notEqual(again.pane, pane);
	assert.equal(world.herdr.pane(String(again.pane)).tokens?.sb_role, "tower");
	assert.equal(again.opened, false, "the tower was there: only its pane is new");
	assert.ok(logged("tower-unstowed", "ensure"));
});

test("a teammate's message for a tower with no pane opens the pane first, and its ally run's pane is split off it", async () => {
	const { s, pane } = await setup();
	await promptIn(s, pane);
	await stowed(pane);
	world.ally.add("m1", "a".repeat(26), "hello from afar");
	world.expose?.allyWaiting("sb-tower-wa");
	await nthRun();
	const [split] = world.herdr.commands("pane", "split");
	assert.equal(split![2], readService(world.slot, "wA")?.pane, "split off the new standing pane");
	assert.ok(logged("tower-unstowed", "ally"));
});

test("the pane stays while it is the workspace's last pane: closing it would close the workspace the tower's queue, memory and ledgers are kept under", async () => {
	const { s, pane } = await setup(true);
	await promptIn(s, pane);
	await until(() => logged("tower-stow-kept", "last"), "the keep to be logged");
	assert.ok(!world.herdr.closed.includes(pane));
	// Once another pane opens in the workspace, the pane closes.
	world.herdr.addPane("wA:p1", "wA:t1", "shell");
	await stowed(pane);
});

test("the pane stays while the boss has words on the prompt's line, and while a split of his shares its tab; it closes when both are gone", async () => {
	const { s, pane, tab } = await setup();
	const prompt = await promptIn(s, pane, 1, true);
	await until(() => logged("tower-stow-kept", "draft"), "the draft to keep the pane");
	world.herdr.addPane("wA:p9", tab, "shell");
	await until(() => logged("tower-stow-kept", "tab"), "the boss's split to keep the pane");
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== "wA:p9");
	prompt.draft = false;
	await stowed(pane);
});

test("a pane the boss took with Ctrl+D, or where he started pi by hand, is his: it never closes", async () => {
	const { s, pane, tab } = await setup();
	// A split of the boss's holds the pane while the prompt comes up and he takes the shell; then it goes.
	world.herdr.addPane("wA:p9", tab, "shell");
	const prompt = await promptIn(s, pane);
	await until(() => prompt.polls > 0 && logged("tower-stow-kept", "tab"), "the split to keep the pane");
	prompt.stop();
	assert.equal((await ask(s, { cmd: "prompt-leave", workspace: "wA", pid: prompt.pid })).ok, true);
	world.herdr.pane(pane).processes = [];
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== "wA:p9");
	await until(() => logged("tower-stow-kept", "parked"), "the park to keep the pane");
	Object.assign(world.herdr.pane(pane), { agent: "pi", processes: [{ argv0: "pi", name: "node", pid: 7999, cmdline: "node pi" }] });
	await until(() => logged("tower-stow-kept", "agent"), "the boss's own pi to keep the pane");
	assert.ok(!world.herdr.closed.includes(pane));
});

test("after a Herdr restart a tower with no pane is its workspace's again while the workspace keeps its label: its token is written again and its next event opens the pane there; a workspace under its id with another label is a stranger's", async () => {
	const { s, pane } = await setup();
	await promptIn(s, pane);
	await stowed(pane);
	world.herdr.restart();
	world.takeovers.forEach((cb) => cb());
	await until(() => world.herdr.workspace("wA").tokens.tower === "sb-tower-wa", "the token to be written again");
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "after the restart" });
	const id = await nthRun();
	assert.equal(world.herdr.panes.find((p) => p.pane_id === world.pis.get(id)!.pane)?.workspace_id, "wA");
});

test("after a Herdr restart that numbered a workspace of the boss's under the tower's id, the tower makes no tab there: its service ends as a stranger's and nothing is marked", async () => {
	const { s, pane } = await setup();
	await promptIn(s, pane);
	await stowed(pane);
	world.herdr.restart();
	world.herdr.workspace("wA").label = "Someone else's";
	world.takeovers.forEach((cb) => cb());
	await ask(s, { cmd: "tower-event", workspace: "wA", text: "into the wrong workspace?" }).catch(() => undefined);
	await until(() => logged("tower-closed"), "the service to end");
	assert.equal(world.herdr.panes.filter((p) => p.workspace_id === "wA").length, 1, "no tab was made in the stranger's workspace");
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined, "and no token written there");
});
