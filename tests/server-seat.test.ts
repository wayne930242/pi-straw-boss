import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { TowerWorld } from "./tower-world.ts";
import { type Running, sleep, until } from "./server-world.ts";
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
