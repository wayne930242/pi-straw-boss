import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { callControl } from "../src/server/socket.ts";
import { readService } from "../src/server/towerstore.ts";
import { type Entry, updateMemory } from "../src/server/towermemory.ts";
import { type Running, until } from "./server-world.ts";
import { TowerWorld } from "./tower-world.ts";

// A headless viewer closes when nothing waits for the boss (his order of 2026-11-28, 「只在有卡片等我時才留」; src/server/towerstow.ts): with `towerRuns.headless` on, the viewer tab closes after the same idle time
// as a standing pane, and comes back as a fresh viewer when a card opens or a run starts, on an attended device only. A viewer the boss ended himself does not come back, and the last pane of a workspace stays.
// Red on 0.113.0: `idleGate` kept every pane while headless runs were on (`headless`), so no viewer ever closed.

let world: TowerWorld;
let unattended = false;
const prompts: FakeViewer[] = [];
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true, undefined, true);
	world.stowTimers = { intervalMs: 20, idleMs: 150 };
	unattended = false;
	world.unattended = () => unattended;
	world.herdr.onPanesGone = (ids) => prompts.filter((p) => ids.includes(p.pane)).forEach((p) => p.stop());
});
afterEach(async () => {
	for (const p of prompts.splice(0)) p.stop();
	await world.close();
});

type Reply = Record<string, unknown> & { ok: boolean; error?: string };
const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply as Reply);
const logged = (event: string, why?: string) => readFileSync(join(world.slot.dir, "server.log"), "utf8").split("\n").map((l) => l.split(" ")).some((w) => w.includes(event) && (!why || w.includes(`why=${why}`)));
const viewerPane = () => world.herdr.panes.find((p) => p.tokens?.sb_role === "tower")?.pane_id;
const card = (id: string): Entry => ({ id, kind: "wait", text: `do ${id}`, by: "run", via: "run", at: new Date().toISOString(), run: "r1", for: "boss", state: "open", card: { type: "action", lang: "en", happened: "h", do: `do ${id}` } });

/** The viewer the server typed into the pane (`exec node … prompt`): the pane's foreground is the prompt alone, and it polls. */
class FakeViewer {
	stopped = false;
	timer: ReturnType<typeof setInterval>;
	s: Running;
	pane: string;
	pid: number;
	constructor(s: Running, pane: string, pid = 7100 + prompts.length) {
		this.s = s;
		this.pane = pane;
		this.pid = pid;
		world.herdr.pane(pane).processes = [{ name: "node", argv0: "node", pid, cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace wA --state-dir "/s"` }];
		this.timer = setInterval(() => void ask(this.s, { cmd: "prompt-poll", workspace: "wA", pid: this.pid }).catch(() => undefined), 20);
		prompts.push(this);
	}
	stop() {
		this.stopped = true;
		clearInterval(this.timer);
	}
}
/** A viewer is typed into `pane` (once, with exec) and comes up there. */
const viewerIn = async (s: Running, pane: string) => {
	await until(() => world.herdr.typed.some((t) => t.pane === pane && /^exec node /.test(t.text)), `the viewer to be typed into ${pane}`);
	assert.equal(world.herdr.typed.filter((t) => t.pane === pane).length, 1, "typed into once");
	return new FakeViewer(s, pane);
};
/** Alpha with a main's pane in its first tab (`wA:p1`) unless `alone`, its tower, and the viewer an attended session's ensure-tower asked for. */
const setup = async (alone = false) => {
	if (!alone) world.herdr.addPane("wA:p1", "wA:t1", "shell");
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(ensured.ok, true, JSON.stringify(ensured));
	const pane = String(ensured.pane);
	assert.ok(pane, "an attended session's ensure-tower makes a viewer");
	return { s, pane, viewer: await viewerIn(s, pane) };
};
const closed = async (pane: string) => {
	await until(() => world.herdr.closed.includes(pane), `the viewer ${pane} to close`);
	await until(() => readService(world.slot, "wA")?.pane === "", "the service to stand with no tab");
};

test("an idle headless viewer with no card waiting closes after the idle time; the service, its identity and its token stay", async () => {
	const { s, pane } = await setup();
	await closed(pane);
	assert.ok(logged("tower-stowed"));
	assert.ok(!world.herdr.commands("tab", "close").length, "the tab is never closed: Herdr drops it with its last pane");
	assert.ok(world.herdr.panes.some((p) => p.pane_id === "wA:p1"), "the main's pane stays");
	assert.equal(world.herdr.workspace("wA").tokens.tower, "sb-tower-wa", "the tower's token stays");
	assert.ok(world.expose!.identityOf("wA"), "the tower is still served");
	assert.ok(JSON.stringify(await ask(s, { cmd: "status" })).includes("sb-tower-wa"));
});

test("a card that opens for a tower whose viewer closed brings a fresh viewer back, typed into once; once it is answered the viewer closes again", async () => {
	const { s, pane } = await setup();
	await closed(pane);
	updateMemory(world.slot, "wA", Date.now(), (m) => void m.entries.push(card("W1")));
	await until(() => viewerPane(), "a viewer for the card");
	const fresh = viewerPane()!;
	assert.notEqual(fresh, pane);
	assert.ok(logged("tower-unstowed", "cards"));
	await viewerIn(s, fresh);
	await new Promise((r) => setTimeout(r, 400));
	assert.ok(!world.herdr.closed.includes(fresh), "the viewer stays while the card waits");
	assert.equal(world.kids.size, 0, "a card wakes no run");
	updateMemory(world.slot, "wA", Date.now(), (m) => void (m.entries.find((e) => e.id === "W1")!.state = "resolved"));
	await closed(fresh);
});

// Seen 2026-11-28 06:41:36 (server.log): a session's plain ensure-tower came 0.2 s after the idle close stowed wJ's viewer, while the service registered again with no pane, and got a fresh viewer that the idle close took
// again 35 s later. Red before 0.116.2: `openHeadless` made a viewer for every attended ensure that found the service with no tab.
test("a plain ensure-tower finds the service whose viewer closed and makes no viewer: only a card or a run brings it back, or the boss's own Open viewer", async () => {
	const { s, pane } = await setup();
	await closed(pane);
	const tabs = world.herdr.commands("tab", "create").length;
	const plain = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(plain.ok, true, JSON.stringify(plain));
	assert.equal(plain.pane, "", "no viewer for a plain ensure");
	assert.equal(world.herdr.commands("tab", "create").length, tabs, "no tab");
	assert.equal(readService(world.slot, "wA")?.stowed, true, "still a viewer the idle close took");
	updateMemory(world.slot, "wA", Date.now(), (m) => void m.entries.push(card("W1")));
	await until(() => viewerPane(), "a viewer for the card");
	assert.ok(logged("tower-unstowed", "cards"));
	const fresh = viewerPane()!;
	await viewerIn(s, fresh);
	updateMemory(world.slot, "wA", Date.now(), (m) => void (m.entries.find((e) => e.id === "W1")!.state = "resolved"));
	await closed(fresh);
	const asked = await ask(s, { cmd: "ensure-tower", workspace: "wA", view: true });
	assert.equal(asked.ok, true, JSON.stringify(asked));
	assert.ok(asked.pane, "Open viewer makes one");
});

test("a run that starts for a tower whose viewer closed brings a fresh viewer back first, and the run itself stays headless", async () => {
	const { s, pane } = await setup();
	await closed(pane);
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "look at the build" })).ok, true);
	await until(() => world.kids.size >= 1, "the headless run to spawn");
	const fresh = viewerPane();
	assert.ok(fresh && fresh !== pane, "a fresh viewer");
	assert.ok(logged("tower-unstowed", "run"));
	assert.deepEqual(world.herdr.commands("agent", "start"), [], "no pi in any pane: the run is the server's child");
});

test("on an unattended device a viewer that closed never comes back: neither a card nor a run makes a tab", async () => {
	const { s, pane } = await setup();
	await closed(pane);
	unattended = true;
	const tabs = world.herdr.commands("tab", "create").length;
	updateMemory(world.slot, "wA", Date.now(), (m) => void m.entries.push(card("W1")));
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "look at the build" })).ok, true);
	await until(() => world.kids.size >= 1, "the headless run to spawn with no viewer");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(world.herdr.commands("tab", "create").length, tabs, "no tab");
	assert.equal(readService(world.slot, "wA")?.pane, "");
});

test("a viewer that cannot be made again holds no run back: the run starts with no tab, and the service stops waiting for a viewer", async () => {
	const { s, pane } = await setup();
	await closed(pane);
	const fake = world.herdr as unknown as { handle(self: string, args: string[]): string };
	const handle = fake.handle.bind(world.herdr);
	fake.handle = (self, args) => {
		if (args[0] === "tab" && args[1] === "create") throw new Error("herdr tab create failed: not answering");
		return handle(self, args);
	};
	assert.equal((await ask(s, { cmd: "tower-event", workspace: "wA", text: "look at the build" })).ok, true);
	await until(() => world.kids.size >= 1, "the headless run to spawn with no viewer");
	assert.ok(logged("tower-unstow-failed"));
	assert.equal(readService(world.slot, "wA")?.stowed, undefined);
	assert.equal(readService(world.slot, "wA")?.pane, "");
});

test("a viewer the boss ended himself does not come back for a card: only a viewer the idle close took is reopened", async () => {
	world.stowTimers = { intervalMs: 20, idleMs: 3_600_000 }; // the idle close takes nothing first
	const { pane, viewer } = await setup();
	// The boss leaves the viewer before the idle time: its pane closes (exec), and the service goes on with no tab.
	viewer.stop();
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== pane);
	await until(() => readService(world.slot, "wA")?.pane === "", "the service to go on with no tab");
	const tabs = world.herdr.commands("tab", "create").length;
	updateMemory(world.slot, "wA", Date.now(), (m) => void m.entries.push(card("W1")));
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(world.herdr.commands("tab", "create").length, tabs, "no tab");
});

test("a viewer that is the last pane of its workspace stays: closing it would close the workspace", async () => {
	const { s, pane } = await setup(true);
	await until(() => logged("tower-stow-kept", "last"), "the keep to be logged");
	assert.ok(!world.herdr.closed.includes(pane));
	world.herdr.addPane("wA:p1", "wA:t1", "shell");
	await closed(pane);
	void s;
});
