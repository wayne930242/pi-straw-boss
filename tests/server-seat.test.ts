import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
import { settle } from "./fakes.ts";
import { TOWER_LABEL } from "../src/herdr.ts";
import { fileOf } from "../src/server/record.ts";
import { callControl } from "../src/server/socket.ts";
import { readQueue, readService } from "../src/server/towerstore.ts";

// F10 after Herdr comes back (VM pass B7, recheck of 36ee14b, case 6): Herdr lost its saved session, the boss made a workspace of their own, and it got the id the tower's workspace had. The service still named that
// workspace, tab, and pane, so the takeover typed the tower prompt's command into the boss's shell and marked it as the tower's. A recorded service must prove the pane is still its own seat (typegate.ts `seatGate`:
// the tab it made, still labelled with the tower glyph) before it types, marks, or wakes a run there; a lost session's reused id is a stranger and the service ends as a quit tower's does, touching nothing of the stranger.

let world: TowerWorld;
beforeEach(() => {
	world = new TowerWorld();
	world.setFlag(true);
});
afterEach(() => world.close());

const ask = (r: Running, cmd: Record<string, unknown>) => callControl(r.handle.endpoint, world.record()!.secret, cmd as { cmd: string }).then((x) => x.reply!);
const logText = () => readFileSync(fileOf(world.slot, "log"), "utf8");
const from = { id: "main-1", name: "docs-main" };
const msg = (id: string, text: string) => ({ id, content: { text } });
const platforms = ["darwin", "win32"] as const;
/** The Herdr the platform's panes answer as: macOS gives the shell's pid and the foreground group; Windows lists the shell alone whatever runs under it. */
const platformWorld = (platform: (typeof platforms)[number]) => {
	if (platform === "win32") Object.assign(world, { runPlatform: "win32" as const }), Object.assign(world.herdr, { winShell: true, shellForeground: true });
	else world.herdr.shellPids = true;
};
/** The prompt the typed command starts, as the server sees it: a process in the pane's foreground that polls. `stop` is the prompt gone with its terminal (Herdr killed). */
const prompts: { stop(): void }[] = [];
const prompt = (s: Running, pane: string, pid = 6100 + prompts.length) => {
	world.herdr.pane(pane).processes = [{ name: "node", argv0: "node", pid, cmdline: `node "/pkg/dist/server/cli.mjs" prompt --workspace wA --state-dir "/s"` }];
	const timer = setInterval(() => void ask(s, { cmd: "prompt-poll", workspace: "wA", pid }).catch(() => {}), 20);
	const one = { stop: () => clearInterval(timer) };
	prompts.push(one);
	return one;
};
afterEach(() => prompts.splice(0).forEach((p) => p.stop()));
const started = async () => {
	const s = await world.start();
	await s.handle.ready;
	const ensured = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	await until(() => world.herdr.typed.length === 1, "the first typing into the new tab");
	const first = prompt(s, String(ensured.pane));
	return { s, tab: String(ensured.tab), pane: String(ensured.pane), first };
};
const takeover = () => world.takeovers.forEach((cb) => cb());
/** What was written to a pane or workspace, or typed into a pane, since the new Herdr started (its call list starts empty). */
const touched = (pane: string, workspace: string) => world.herdr.calls.filter((args) => args.includes(pane) || args.includes(workspace) || (args[0] === "pane" && args[1] === "run"));

for (const platform of platforms) {
	// What tells the server a new Herdr is there: its watch (the takeover), its events connection acknowledged again, or both. Each alone voids the proof.
	for (const [trigger, message] of [["takeover", false], ["events", false], ["both", false], ["both", true]] as const) {
		test(`${platform}: a lost session whose workspace id the boss's own shell took (${trigger}${message ? ", with a message waiting" : ""}): nothing is typed or marked there${message ? ", no run starts in it" : ""}, and the service ends with its queue kept`, async () => {
			platformWorld(platform);
			const { s, tab, pane, first } = await started();
			const h = world.herdr, typedBefore = h.typed.length;
			first.stop();
			// Herdr is killed and its saved session is gone: the new server has the boss's workspace under the old ids, a plain shell in another folder.
			h.restart(trigger !== "takeover");
			h.workspace("wA").label = "boss-project";
			h.tabs.find((t) => t.tab_id === tab)!.label = "1";
			Object.assign(h.pane(pane), { cwd: "/boss/project", processes: [], agent: undefined });
			if (message) world.client("sb-tower-wa")!.incoming(from, msg("m1", "a message while the stranger's shell stands in the tower's place"));
			if (trigger !== "events") takeover();
			const untouched = () => {
				assert.equal(h.typed.length, typedBefore, "the command was not typed into the boss's shell");
				assert.deepEqual(touched(pane, "wA").filter((args) => args[1] !== "list" && args[1] !== "process-info"), [], "nothing was written to the boss's pane or workspace, nothing run in it, no run started");
				assert.deepEqual(h.pane(pane).tokens, {});
				assert.deepEqual(h.workspace("wA").tokens, {});
				assert.equal(h.pane(pane).agent, undefined);
			};
			await sleep(600); // past the minute after the restart (150 ms here) and many looks of the standing pane (30 ms)
			untouched();
			await until(() => !readService(world.slot, "wA"), "the service to end once the minute after the restart is over", 4000);
			await sleep(100);
			untouched(); // the end of the service marks nothing of the stranger's either, not even as a quit tower's
			assert.equal(readQueue(world.slot, "wA").length, message ? 1 : 0, "the queue is kept, as a quit tower's is");
			assert.match(logText(), /tower-closed/);
			assert.equal(world.client("sb-tower-wa")?.connected, false, "the identity left");
			assert.deepEqual((await ask(s, { cmd: "status" })).towers, []);
		});
	}

	test(`${platform}: a restored session keeps the tower tab: the command is typed again exactly once and the marks are written again`, async () => {
		platformWorld(platform);
		const { s, pane, first } = await started();
		const h = world.herdr;
		first.stop();
		h.restart();
		Object.assign(h.pane(pane), { processes: [], agent: undefined });
		takeover();
		await until(() => h.typed.length === 2, "the command typed again");
		prompt(s, pane);
		await until(() => h.workspace("wA").tokens.tower === "sb-tower-wa" && h.pane(pane).tokens.sb_role === "tower", "the marks written again");
		await sleep(400);
		assert.equal(h.typed.length, 2, "once");
		assert.equal(h.typed[1]!.pane, pane);
		assert.ok(readService(world.slot, "wA"));
	});

	test(`${platform}: ids that collide with the boss's pane after a restore: the service follows its tower tab, and the boss's pane is left alone`, async () => {
		platformWorld(platform);
		const { s, tab, pane, first } = await started();
		const h = world.herdr;
		first.stop();
		await h.runFor("x")(["tab", "close", tab]);
		h.restart();
		// The restored Herdr numbered the boss's tab with the old ids and the tower tab with others.
		h.addTab(tab, "work", pane, "shell");
		h.addTab("wA:t55", TOWER_LABEL, "wA:p55", "shell");
		takeover();
		await until(() => readService(world.slot, "wA")?.pane === "wA:p55", "the record to follow the tower tab");
		await until(() => h.typed.length === 2 && h.typed[1]!.pane === "wA:p55", "the command typed into the tower's pane");
		prompt(s, "wA:p55");
		await until(() => h.pane("wA:p55").tokens.sb_role === "tower", "its marks");
		await sleep(300);
		assert.equal(h.typed.length, 2, "once");
		assert.deepEqual(touched(pane, "nothing").filter((args) => args[1] !== "list" && args[1] !== "process-info" && args[1] !== "run"), [], "the boss's pane was not written to");
		assert.equal(h.typed.filter((t) => t.pane === pane).length, 1, "only the first typing, before the restore, went to that id");
		assert.deepEqual(h.pane(pane).tokens, {});
	});
}

// --- the seat review of 602c8e6 and the merge 19c68d5 (RVSEAT-F001 to F004) ------------------------------------------------------------------------------------------------------------

/** Standing looks that ran: each reads the whole pane list once (the call carries no workspace). */
const looks = () => world.herdr.calls.filter((a) => a[0] === "pane" && a[1] === "list" && a.length === 2).length;
/** Waits for `n` more looks of the standing panes (30 ms apart here): a bound that moves with the looks, not with the clock. */
const afterLooks = async (n: number) => {
	const was = looks();
	await until(() => looks() >= was + n, `${n} more looks of the standing panes`, 15_000);
};
/** The new Herdr's workspace under the old ids is the boss's own: its tab is no tower's, and the pane a plain shell in another folder. */
const stranger = (tab: string, pane: string) => {
	const h = world.herdr;
	h.workspace("wA").label = "boss-project";
	h.tabs.find((t) => t.tab_id === tab)!.label = "1";
	Object.assign(h.pane(pane), { cwd: "/boss/project", processes: [], agent: undefined });
};
const agentStarts = () => world.herdr.calls.filter((a) => a[0] === "agent" && a[1] === "start");

for (const platform of platforms) {
	// F001: the unseat happened only when the watch or the events connection was acknowledged again (up to 2 s after the new Herdr answers). Until then the old proof was believed for whatever Herdr listed under the id.
	test(`${platform}: RVSEAT-F001 a new Herdr answers before any connection is acknowledged again: nothing is typed, marked, or started in the stranger's shell standing under the recorded ids`, async () => {
		platformWorld(platform);
		const { tab, pane, first } = await started();
		const h = world.herdr, typedBefore = h.typed.length;
		first.stop();
		h.restart(false); // no connection is acknowledged again: nothing but what Herdr lists says a new Herdr is there
		stranger(tab, pane);
		world.client("sb-tower-wa")!.incoming(from, msg("m1", "a message while the stranger's shell stands in the tower's place"));
		await afterLooks(25); // past the time the old prompt counts as there (400 ms), and the wake of the message (40 ms)
		assert.equal(h.typed.length, typedBefore, "the command was not typed into the boss's shell");
		assert.deepEqual(agentStarts(), [], "no run started in the boss's shell");
		assert.deepEqual(h.pane(pane).tokens, {}, "the boss's pane was not marked");
		assert.deepEqual(h.workspace("wA").tokens, {});
		assert.doesNotMatch(logText(), /run-start/);
		await until(() => !readService(world.slot, "wA"), "the service to end once the minute is over", 6000);
		assert.equal(h.typed.length, typedBefore);
		assert.equal(readQueue(world.slot, "wA").length, 1, "the message waits in the kept queue");
	});

	test(`${platform}: RVSEAT-F001 a wake that comes before the Herdr is seen to have changed starts no pi: the run's own start asks Herdr`, async () => {
		platformWorld(platform);
		world.standingTimers = { intervalMs: 3_600_000 }; // no look of the standing pane: only the run's own start can notice
		const { tab, pane, first } = await started();
		const h = world.herdr;
		first.stop();
		h.restart(false);
		stranger(tab, pane);
		world.client("sb-tower-wa")!.incoming(from, msg("m1", "hi"));
		await until(() => /run-start|run-refused/.test(logText()), "the wake to begin or to be refused");
		assert.match(logText(), /run-refused/);
		assert.doesNotMatch(logText(), /run-start/, "no run is recorded for a pane that is not proven");
		assert.deepEqual(agentStarts(), []);
		assert.deepEqual(h.pane(pane).tokens, {});
	});

	test(`${platform}: RVSEAT-F001 the service's refresh writes no marks into a stranger's pane before any connection is acknowledged again`, async () => {
		platformWorld(platform);
		world.refreshMs = 40;
		world.standingTimers = { intervalMs: 3_600_000 };
		const { tab, pane, first } = await started();
		const h = world.herdr;
		first.stop();
		h.restart(false);
		stranger(tab, pane);
		await until(() => /tower-unseated/.test(logText()) || Object.keys(h.pane(pane).tokens).length > 0, "the refresh to notice the new Herdr or to mark the pane");
		assert.deepEqual(h.pane(pane).tokens, {});
		assert.deepEqual(h.workspace("wA").tokens, {});
		assert.match(logText(), /tower-unseated/);
	});
}

test("RVSEAT-F001 launch: a run that began on a proven seat starts no pi when the Herdr changed while its start waited for the prompt to leave; the pane is not given back as a fresh shell", async () => {
	platformWorld("darwin");
	world.standingTimers = { intervalMs: 3_600_000, leaveMs: 600 };
	const { tab, pane } = await started(); // the prompt keeps polling: the start waits for it to leave
	const h = world.herdr, typedBefore = h.typed.length;
	world.client("sb-tower-wa")!.incoming(from, msg("m1", "hi"));
	await until(() => /run-start/.test(logText()), "the run to begin and wait for the prompt");
	h.restart(false);
	stranger(tab, pane);
	await until(() => /run-end/.test(logText()), "the run to end without starting pi");
	assert.deepEqual(agentStarts(), [], "pi was not started in the stranger's shell");
	assert.match(logText(), /run-refused[^\n]* run=/, "refused by the run's own start, after it was recorded");
	assert.match(logText(), /run-end[^\n]*herdr-restart/);
	assert.equal(h.typed.length, typedBefore);
	assert.deepEqual(h.pane(pane).tokens, {});
	assert.equal(world.expose!.status().find((x) => x.workspace === "wA")?.service?.state, "standing", "the service is not held: no crash was counted");
});

// F002: the desk's relaunch after a lost session. The old service proves the new base by its glyph and types; the claim must not make the pane a fresh shell again.
/** Herdr killed with its session unsaved; the desk's relaunch made the base: a workspace under the lost one's id, its tab labelled with the glyph, its root pane marked, within the minute a restart gives. */
const lostSessionBase = () => {
	const h = world.herdr;
	h.lose();
	h.workspaces.push({ workspace_id: "wA", label: "Desk", tokens: {} } as never);
	h.addTab("wA:t1", TOWER_LABEL, "wA:p1", "shell");
	Object.assign(h.pane("wA:p1"), { tokens: { sb_role: "tower" }, processes: [], cwd: "/home/Straw Boss" });
	h.restart();
	takeover();
};
const typedInto = (pane: string) => world.herdr.typed.filter((t) => t.pane === pane).length;

test("RVSEAT-F002 win32: the old service types into the desk's new base before the claim; the claim does not make the pane fresh again: the prompt is typed into it once", async () => {
	platformWorld("win32");
	const { s, first } = await started();
	first.stop();
	const at = Date.now(); // the desk made the base now, and tells the server so once it is marked: the old service may have typed in between
	lostSessionBase();
	await until(() => typedInto("wA:p1") === 1, "the old service to type into the base it proved by the glyph", 4000);
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA", made: { pane: "wA:p1", at } });
	assert.equal(reply.opened, true);
	assert.match(logText(), /tower-closed[^\n]*made again/);
	await afterLooks(25);
	assert.equal(typedInto("wA:p1"), 1, "once per pane");
});

test("RVSEAT-F002 win32: a look of the old service that is in flight when the claim ends it types nothing, and the new service types once", async () => {
	platformWorld("win32");
	const h = world.herdr;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	let gating = true, held = 0;
	const inner = h.runFor.bind(h);
	h.runFor = (self: string) => {
		const run = inner(self);
		return async (args: string[]) => {
			if (gating && args[0] === "pane" && args[1] === "process-info" && args.includes("wA:p1")) (held++, await gate);
			return run(args);
		};
	};
	const { s, first } = await started();
	first.stop();
	lostSessionBase();
	await until(() => held > 0, "the old service's look to wait on the process table of the base", 4000);
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA", made: { pane: "wA:p1", at: Date.now() } });
	assert.equal(reply.opened, true);
	gating = false;
	release();
	await afterLooks(25);
	assert.equal(typedInto("wA:p1"), 1, "the look that was in flight when the service ended typed nothing");
});

test("RVSEAT-F002 win32 control: a claim for a base nothing was typed into makes it a fresh shell: the prompt is typed into it once", async () => {
	platformWorld("win32");
	const { s, first } = await started();
	first.stop();
	const h = world.herdr;
	h.lose();
	h.workspaces.push({ workspace_id: "wA", label: "Desk", tokens: {} } as never);
	h.addTab("wA:t1", TOWER_LABEL, "wA:p1", "shell");
	Object.assign(h.pane("wA:p1"), { tokens: { sb_role: "tower" }, processes: [], cwd: "/home/Straw Boss" });
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA", made: { pane: "wA:p1", at: Date.now() } });
	assert.equal(reply.opened, true);
	await until(() => typedInto("wA:p1") === 1, "the prompt typed into the base");
	await afterLooks(25);
	assert.equal(typedInto("wA:p1"), 1);
});

// F003: the glyph proves "a tower tab", not "this service's". The claim ends the lost workspace's service even when its stand-in already shows in the base.
test("RVSEAT-F003: the desk's base under a lost workspace's id: the claim makes a new service for the base, with the base's label and folder, even when the old service's stand-in shows there", async () => {
	platformWorld("darwin");
	const { s, first } = await started();
	first.stop();
	const was = readService(world.slot, "wA");
	assert.equal(was?.label, "Alpha");
	lostSessionBase();
	await until(() => readService(world.slot, "wA")?.pane === "wA:p1", "the old service to follow the glyph tab into the base", 4000);
	await until(() => typedInto("wA:p1") >= 1, "the base typed into");
	world.herdr.pane("wA:p1").agent = "tower"; // the prompt's stand-in, about a second after the typing
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA", made: { pane: "wA:p1", at: Date.now() } });
	const now = readService(world.slot, "wA");
	assert.equal(reply.opened, true, "a new service, not the lost workspace's");
	assert.equal(reply.label, "Desk");
	assert.equal(now?.label, "Desk");
	assert.equal(now?.pane, "wA:p1");
	assert.equal(now?.cwd, "/home/Straw Boss", "the base's folder, not the lost workspace's checkout");
	assert.match(logText(), /tower-closed[^\n]*made again/);
	await afterLooks(25);
	assert.equal(typedInto("wA:p1"), 1, "the new service does not type again either");
});

// F004: guards the review found unpinned.
test("RVSEAT-F004 (the stranger proof of an ask): an ensure-tower during the minute after a restart for a workspace whose recorded ids a stranger took opens a new tower; the stranger's pane is left alone", async () => {
	platformWorld("darwin");
	const { s, tab, pane, first } = await started();
	const h = world.herdr, strangerTyped = () => typedInto(pane);
	first.stop();
	h.restart(); // the events are acknowledged again: the proof is void
	stranger(tab, pane);
	const reply = await ask(s, { cmd: "ensure-tower", workspace: "wA" });
	assert.equal(reply.opened, true, "a stale service is not answered for a stranger's pane");
	assert.notEqual(reply.tab, tab);
	assert.notEqual(reply.pane, pane);
	await until(() => typedInto(String(reply.pane)) === 1, "the new tab typed into");
	assert.equal(strangerTyped(), 1, "only the first typing, before the restart");
	assert.deepEqual(h.pane(pane).tokens, {}, "the stranger's pane was not marked, not even as a quit tower's");
	assert.equal(h.pane(String(reply.pane)).tokens.sb_role, "tower");
});

test("RVSEAT-F004 (the epoch of a proof): a proof read before the connections were acknowledged again is not believed after it", async () => {
	platformWorld("darwin");
	const h = world.herdr;
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => (release = resolve));
	let gating = false, held = false;
	const inner = h.runFor.bind(h);
	// The tab list a proof reads is answered with what it listed, and kept from the proof until the test lets it go.
	h.runFor = (self: string) => {
		const run = inner(self);
		return async (args: string[]) => {
			const out = await run(args);
			if (gating && args[0] === "tab" && args[1] === "list") (held = true, await gate);
			return out;
		};
	};
	const { tab, pane, first } = await started();
	first.stop();
	gating = true;
	h.restart(); // a restore that kept the tab: the proof is read, and says the tower's glyph
	await until(() => held, "the proof to wait with the tab list it read");
	gating = false;
	stranger(tab, pane); // the Herdr changed after the proof read the tab
	const typedBefore = h.typed.length;
	takeover(); // the connections are acknowledged again: what was proven is void
	release();
	await afterLooks(25);
	assert.equal(h.typed.length, typedBefore, "the stale proof seated nothing: nothing was typed into the stranger's shell");
	assert.deepEqual(h.pane(pane).tokens, {});
	assert.deepEqual(h.workspace("wA").tokens, {});
});

test("RVSEAT-F001: a wake that was refused because Herdr's listing failed is made again at the service's next refresh, not left in the queue until the next event", async () => {
	platformWorld("darwin");
	const h = world.herdr;
	let failing = false;
	const inner = h.runFor.bind(h);
	h.runFor = (self: string) => {
		const run = inner(self);
		return async (args: string[]) => {
			if (failing && args[0] === "pane" && args[1] === "list" && args[2] === "--workspace") throw new Error("herdr pane list failed: not answering");
			return run(args);
		};
	};
	world.refreshMs = 100;
	const { first } = await started();
	first.stop();
	failing = true;
	world.client("sb-tower-wa")!.incoming(from, msg("m1", "hi"));
	await until(() => /run-refused/.test(logText()), "the wake to be refused: the seat could not be read");
	failing = false;
	await until(() => /run-start/.test(logText()), "the next refresh to wake the run again");
	assert.equal(agentStarts().length, 1);
});

test("RVSEAT-F001: a message of a teammate's device that waits before the Herdr is seen to have changed splits no pane off the stranger's tab and starts no ally run", async () => {
	platformWorld("darwin");
	world.standingTimers = { intervalMs: 3_600_000 };
	const { tab, pane, first } = await started();
	const h = world.herdr, device = "a".repeat(26);
	first.stop();
	h.restart(false);
	stranger(tab, pane);
	world.ally.add("m1", device, "hello from afar");
	world.ally.level.set(device, "forward");
	world.expose?.allyWaiting("sb-tower-wa");
	await until(() => /run-refused[^\n]*kind=ally/.test(logText()), "the ally wake to be refused");
	assert.deepEqual(h.commands("pane", "split"), [], "no pane was split off the boss's tab");
	assert.deepEqual(agentStarts(), []);
});

test("RVSEAT-F001: a new Herdr noticed from a listing opens the minute a restore needs: the tower's tab that comes back under other ids afterwards is followed, the stranger's pane is left alone", async () => {
	platformWorld("darwin");
	const { tab, pane, first } = await started();
	const h = world.herdr;
	first.stop();
	h.restart(false); // no connection is acknowledged again; the boss's tab was restored first, under the tower's ids
	stranger(tab, pane);
	await until(() => /tower-unseated/.test(logText()), "the standing look to notice the new Herdr");
	assert.ok(readService(world.slot, "wA"), "the service waits for its tab: the minute is open");
	h.addTab("wA:t77", TOWER_LABEL, "wA:p77", "shell"); // the restore brings the tower's tab back
	h.emit("workspace.created", "workspace_created", { workspace_id: "wA" });
	await until(() => readService(world.slot, "wA")?.pane === "wA:p77", "the service to follow the tower's tab");
	await until(() => typedInto("wA:p77") === 1, "the command typed into the restored tab", 4000);
	assert.equal(typedInto(pane), 1, "only the first typing, before the restart, went to the stranger's id");
	assert.deepEqual(h.pane(pane).tokens, {});
});

test("RVSEAT-F002: a service that is lost writes no marks from a publish it had in flight: its seat is void from the moment it is lost, not from the moment it is released", async () => {
	platformWorld("darwin");
	world.refreshMs = 40;
	const h = world.herdr;
	let holdPublish = false, holdStandin = false, publishHeld = false, standinHeld = false, inWorldRead = false;
	let releasePublish: () => void = () => {}, releaseStandin: () => void = () => {};
	const publishGate = new Promise<void>((resolve) => (releasePublish = resolve)), standinGate = new Promise<void>((resolve) => (releaseStandin = resolve));
	const inner = h.runFor.bind(h);
	h.runFor = (self: string) => {
		const run = inner(self);
		return async (args: string[]) => {
			// A look of the standing panes lists the panes and the workspaces in one burst; the publish of the refresh reads the workspaces alone, to see who holds the token. The first such read after the test asks waits.
			if (args[0] === "pane" && args[1] === "list" && args.length === 2) (inWorldRead = true, queueMicrotask(() => (inWorldRead = false)));
			if (holdPublish && !inWorldRead && args[0] === "workspace" && args[1] === "list") (holdPublish = false, publishHeld = true, await publishGate);
			return run(args);
		};
	};
	const api = h.api;
	h.api = async (method: string, params: object) => {
		// The stand-in is taken away when the service is lost: that is where `lose` waits here, before it is released.
		if (holdStandin && method === "pane.release_agent") (holdStandin = false, standinHeld = true, await standinGate);
		return api(method, params);
	};
	const { s, pane } = await started(); // the prompt polls: the stand-in is reported
	await until(() => h.pane(pane).agent === "tower", "the stand-in to be reported");
	holdPublish = true;
	await until(() => publishHeld, "the refresh's publish to wait on the workspaces");
	holdStandin = true;
	// The desk says it made this pane a moment ago: the service standing for the workspace is lost (the pane stays, so only the seat can stop the publish).
	const closing = ask(s, { cmd: "ensure-tower", workspace: "wA", made: { pane, at: Date.now() } });
	await until(() => standinHeld, "the loss of the service to wait on the stand-in's release");
	const tokenWrites = h.wsTokenHistory.length;
	releasePublish();
	await settle(); // the fake Herdr answers in microtasks: the publish has gone on to its end, or to its writes
	assert.equal(h.wsTokenHistory.length, tokenWrites, "the lost service wrote no workspace mark");
	releaseStandin();
	await closing;
});
