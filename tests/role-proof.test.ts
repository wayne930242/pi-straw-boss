import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TOWER_LABEL } from "../src/herdr.ts";
import { until, World, type Agent } from "./fakes.ts";

// A role record (`roles/<hash>.json` of the state folder) and the saved `straw-boss` entry of a session file are files the session's own shell can write. They claim a role;
// they never prove one (docs/specs/2026-11-07-train-workers.md §29, review SB4R-F003). A tower's and a train's proof is Herdr's: the tab the pane sits in carries the tower glyph,
// or the train's `train <MMDDx>`. These tests forge the files as a session's model could before a /reload, a /resume, or a Herdr restore, and keep the real restores working.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

const FILES = { tower: "/s/tower.jsonl", main: "/s/main.jsonl", member: "/s/member.jsonl" };
const tokens = (pane: string) => world.herdr.pane(pane).tokens;
const roles = () => join(world.stateDir, "roles");
/** The path roles.ts keeps a session file's record under. */
const recordOf = (file: string) => join(roles(), `${createHash("sha256").update(file).digest("hex").slice(0, 32)}.json`);
/** What a session's shell can do: write a record for its own session file. */
const forge = (file: string, record: Record<string, unknown>) => {
	mkdirSync(roles(), { recursive: true });
	writeFileSync(recordOf(file), JSON.stringify({ file, at: Date.now(), ...record }));
};
const TOWER_ENTRY = { customType: "straw-boss", data: { tower: true, workspaceId: "wA" } };
const told = (agent: Agent, what: RegExp) => agent.notices.some((n) => what.test(n.text));

async function pi(options: Parameters<World["agent"]>[0], file: string, reason = "startup"): Promise<Agent> {
	const agent = world.agent(options);
	agent.file = file;
	await agent.fire("session_start", { reason });
	await world.quiet();
	return agent;
}

/** The net as the PM left it: a tower in its glyph tab (as towertab.ts and the sb server make it), a main, and a member in workspace wA. */
async function net(label = TOWER_LABEL) {
	world.herdr.addTab("wA:t7", label, "wA:p7");
	const tower = await pi({ id: "tower-1", pane: "wA:p7", tab: "wA:t7", env: { STRAW_BOSS_ROLE: "tower" } }, FILES.tower);
	const main = await pi({ id: "main-1", pane: "wA:p1", tab: "wA:t1" }, FILES.main);
	assert.match(await main.promote(), /the main agent of tab/);
	const member = await pi({ id: "member-1", pane: "wA:p2", tab: "wA:t1" }, FILES.member);
	return { tower, main, member };
}

/** Herdr stops and a new server resumes the panes: the processes end, the panes and tabs (and their labels) stay, the tokens are gone. */
async function restore(resumed: { id: string; pane: string; file: string; entries?: Agent["entries"]; deps?: Parameters<World["agent"]>[0]["deps"] }[], afterRestart?: () => void): Promise<Agent[]> {
	const [panes, tabs] = [[...world.herdr.panes], [...world.herdr.tabs]];
	for (const agent of [...world.agents]) await agent.stop("quit");
	[world.herdr.panes, world.herdr.tabs] = [panes, tabs];
	world.herdr.restart();
	afterRestart?.();
	const back: Agent[] = [];
	for (const { id, pane, file, entries, deps } of resumed) back.push(await pi({ id, pane, entries, deps }, file)); // no STRAW_BOSS_ROLE: the resume starts pi in a plain shell
	await world.quiet();
	return back;
}

for (const reason of ["reload", "resume", "startup"] as const) {
	test(`a member that writes {role:"tower"} into its own role record does not start as a tower (${reason})`, async () => {
		const { member } = await net();
		forge(FILES.member, { role: "tower", pane: "wA:p2", tab: "wA:t1", workspace: "wA" });
		await member.stop(reason === "startup" ? "quit" : reason);
		const again = await pi({ id: "member-2", pane: "wA:p2" }, FILES.member, reason);
		// Asked first: a session that started as a tower beside the live one yields by closing its own tab, and its pane is gone with it.
		assert.equal(world.herdr.commands("tab", "close").length, 0, "nothing closed a tab as a yielding tower would");
		assert.equal(again.tokens.sb_role, "member", "it joins as the member it was");
		assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-1", "the workspace's tower is untouched");
		assert.equal(again.tools.has("boss_open_main"), false, "and it holds no tower tool");
		assert.ok(told(again, /role record says it was a tower.*not in a tower tab.*starts as a member/), "the refusal is told");
	});

	test(`a member whose session file gains a tower entry does not start as a tower (${reason})`, async () => {
		const { member } = await net();
		await member.stop(reason === "startup" ? "quit" : reason);
		const again = await pi({ id: "member-2", pane: "wA:p2", entries: [...member.entries, TOWER_ENTRY] }, FILES.member, reason);
		assert.equal(world.herdr.commands("tab", "close").length, 0, "nothing closed a tab as a yielding tower would");
		assert.equal(again.tokens.sb_role, "member");
		assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-1");
		assert.equal(again.tools.has("boss_open_main"), false);
		assert.ok(told(again, /saved entry says it was a tower.*not in a tower tab.*starts as a member/), "the refusal is told");
	});
}

// RP131-F001: the glyph proves the tab, not the pane. A session in a second pane of the tower's own tab (the boss split it) forges the same claim;
// beside a live tower a tower that starts yields by closing its tab, which here is the real tower's.
for (const how of ["entry", "record"] as const) {
	test(`a session in a second pane of the tower's tab is no tower by its ${how}, and closes nothing: the tab has another agent's pane`, async () => {
		await net();
		const guest = await pi({ id: "guest-1", pane: "wA:p9", tab: "wA:t7" }, "/s/guest.jsonl");
		if (how === "record") forge("/s/guest.jsonl", { role: "tower", pane: "wA:p9", tab: "wA:t7", workspace: "wA" });
		await guest.stop("reload");
		const again = await pi({ id: "guest-2", pane: "wA:p9", entries: [...guest.entries, ...(how === "entry" ? [TOWER_ENTRY] : [])] }, "/s/guest.jsonl", "reload");
		assert.equal(world.herdr.commands("tab", "close").length, 0, "the shared tab is not closed");
		assert.ok(world.herdr.panes.some((p) => p.pane_id === "wA:p7"), "the real tower's pane stays");
		assert.equal(world.herdr.workspace("wA").tokens.tower, "tower-1", "the workspace's tower is untouched");
		assert.notEqual(again.tokens.sb_role, "tower", "it joins the net as any session in that tab would");
		assert.equal(again.tools.has("boss_open_main"), false);
		assert.ok(told(again, new RegExp(`${how === "entry" ? "saved entry" : "role record"} says it was a tower.*shares the tower tab with another agent's pane.*starts as a member`)), "the refusal is told");
	});
}

test("a forged tower record proves nothing in a tab that is only named like a tower's: the glyph is the proof, not the word", async () => {
	world.herdr.addTab("wA:t8", "tower", "wA:p8");
	const first = await pi({ id: "plain-1", pane: "wA:p8", tab: "wA:t8" }, "/s/plain.jsonl");
	assert.equal(first.tokens.sb_role, "member");
	forge("/s/plain.jsonl", { role: "tower", pane: "wA:p8", tab: "wA:t8", workspace: "wA" });
	await first.stop("reload");
	const again = await pi({ id: "plain-2", pane: "wA:p8", entries: [TOWER_ENTRY] }, "/s/plain.jsonl", "reload");
	assert.equal(again.tokens.sb_role, "member");
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined);
});

test("the real restores still give the tower back: by its record alone (a session with no conversation yet), by its entry alone, and at a /reload of the restored tower", async () => {
	await net();
	// The record alone: pi had not written the session file, so the resumed session has no entry.
	const [byRecord] = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower }]) as [Agent];
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2", "the tower is back by its record");
	assert.equal(tokens("wA:p7").sb_role, "tower");
	assert.equal(told(byRecord, /starts as a member/), false);
	// A /reload of that restored tower: no STRAW_BOSS_ROLE in its process, its entry and record claim, its tab proves.
	await byRecord.stop("reload");
	const reloaded = await pi({ id: "tower-2", pane: "wA:p7", entries: byRecord.entries }, FILES.tower, "reload");
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2" && tokens("wA:p7").sb_role === "tower", "the tower is the tower after its /reload");
	assert.equal(reloaded.tools.has("boss_open_main"), true);
	// The entry alone: the record is gone (another state folder, a sweep), the session file kept the mark.
	const entries = reloaded.entries;
	const [panes, tabs] = [[...world.herdr.panes], [...world.herdr.tabs]];
	for (const agent of [...world.agents]) await agent.stop("quit");
	[world.herdr.panes, world.herdr.tabs] = [panes, tabs];
	world.herdr.restart();
	for (const name of readdirSync(roles())) if (readFileSync(join(roles(), name), "utf8").includes('"tower"')) writeFileSync(join(roles(), name), "{gone");
	const byEntry = await pi({ id: "tower-3", pane: "wA:p7", entries }, FILES.tower);
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-3", "the tower is back by its entry");
	assert.equal(byEntry.tokens.sb_role, "tower");
});

test("a /reload in a tower's pane keeps the tower by its process, whatever its tab is called", async () => {
	const { tower } = await net("my tower"); // the boss renamed the tab: the process was still started as a tower
	await tower.stop("reload");
	const again = await pi({ id: "tower-1", pane: "wA:p7", env: { STRAW_BOSS_ROLE: "tower" }, entries: tower.entries }, FILES.tower, "reload");
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-1" && tokens("wA:p7").sb_role === "tower", "the tower is the tower after its /reload");
	assert.equal(again.tools.has("boss_open_main"), true);
});

test("a tower whose tab the boss renamed away from the glyph is not proven after a restore: it comes back a member, and says why", async () => {
	await net("my tower");
	const [back] = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower, entries: [TOWER_ENTRY] }]) as [Agent];
	assert.equal(back.tokens.sb_role, "member");
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined);
	assert.ok(told(back, /Herdr lists its pane in "my tower", not in a tower tab/));
});

test("a Herdr that cannot list the tabs proves nothing: the claimed tower is neither a tower nor a member until it answers, and a /boss that waited for the answer joins nothing", async () => {
	await net();
	const [panes, tabs] = [[...world.herdr.panes], [...world.herdr.tabs]];
	for (const agent of [...world.agents]) await agent.stop("quit");
	[world.herdr.panes, world.herdr.tabs] = [panes, tabs];
	world.herdr.restart();
	world.herdr.failReads = true;
	const back = await pi({ id: "tower-2", pane: "wA:p7" }, FILES.tower);
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined, "no tower on a claim Herdr did not prove");
	assert.equal(tokens("wA:p7").sb_role, undefined, "and no member either: the start is asked again");
	assert.ok(told(back, /could not tell whether this is a sub workspace/));
	world.herdr.failReads = false;
	await back.command(""); // /boss: its promotion waits for the answer, which proves the tower
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2", "the tower took its role once Herdr answered");
	assert.equal(tokens("wA:p7").sb_role, "tower", "never a member or a main of its tab");
	assert.ok(told(back, /This session is the tower of its workspace, not a member/), "the /boss that waited is refused");
	assert.equal(back.regs.has(`straw-boss/tab/${Buffer.from("wA:t7").toString("hex")}`) && back.tools.has("boss_promote"), false, "it registered no member's tools");
});

// --- trains ----------------------------------------------------------------------------------------------------------------------------------------------------------

const TRAIN = { file: "/s/train.jsonl", pane: "wA:p101" };
const MANIFEST = "train:\n  project: acme\n  app: web\n  code: 2026-11-06-m\n";
const ID = { project: "acme", code: "2026-11-06-m" };
const openTrain = async (tower: Agent) => {
	world.herdr.onAgentStart = (pane) => {
		const agent = world.agent({ id: "train-1", name: "train 1106m", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "train" } });
		agent.file = TRAIN.file;
		void agent.start();
	};
	await tower.tool("boss_open_main", { role: "train", request: MANIFEST, sender: "member-1" });
	await until(() => world.herdr.pane(TRAIN.pane).tokens.sb_role === "train", "the opened train is a train");
	world.herdr.onAgentStart = undefined;
};

for (const reason of ["reload", "resume"] as const) test(`a member whose session file gains a train entry for its own pane is no train at its ${reason}: its tab is not that train's`, async () => {
	const { member } = await net();
	await member.stop(reason);
	const again = await pi({ id: "member-2", pane: "wA:p2", entries: [...member.entries, { customType: "straw-boss", data: { openedBy: "tower-1", openedPane: "wA:p2", train: ID } }] }, FILES.member, reason);
	assert.equal(again.tokens.sb_role, "member");
	assert.equal(again.tokens.sb_train, undefined);
	assert.ok(told(again, /saved entry names train 1106m.*not in that train's tab.*no train/), "the refusal is told");
});

test("a member that writes a train record for its own pane is no train after a Herdr restore, though the terminal is new", async () => {
	await net();
	forge(FILES.member, { role: "train", pane: "wA:p2", tab: "wA:t1", workspace: "wA", terminal: "term_forged", train: ID, openedBy: "tower-1" });
	const [, , back] = await restore([
		{ id: "tower-2", pane: "wA:p7", file: FILES.tower },
		{ id: "main-2", pane: "wA:p1", file: FILES.main },
		{ id: "member-2", pane: "wA:p2", file: FILES.member },
	]) as [Agent, Agent, Agent];
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2", "the tower is back");
	assert.equal(back.tokens.sb_role, "member");
	assert.equal(back.tokens.sb_train, undefined);
	assert.equal(back.tokens.sb_opened_by, undefined, "and it carries no opener a tower could close it by");
	assert.ok(told(back, /role record names train 1106m.*not in that train's tab.*no train/), "the refusal is told");
});

test("a real train comes back after a Herdr restore and after a /reload, in the tab that carries its code; in a tab renamed away from it, it does not", async () => {
	const { tower } = await net();
	await openTrain(tower);
	const tab = world.herdr.pane(TRAIN.pane).tab_id;
	assert.equal(world.herdr.tabs.find((t) => t.tab_id === tab)?.label, "train 1106m", "the open labels the tab with the train's code");
	const [, back] = await restore([
		{ id: "tower-2", pane: "wA:p7", file: FILES.tower },
		{ id: "train-2", pane: TRAIN.pane, file: TRAIN.file },
	]) as [Agent, Agent];
	await until(() => tokens(TRAIN.pane).sb_role === "train" && tokens(TRAIN.pane).sb_train === "acme/2026-11-06-m", "the train is a train again");
	await back.stop("reload");
	const reloaded = await pi({ id: "train-2", pane: TRAIN.pane, entries: back.entries, deps: { couple: false } }, TRAIN.file, "reload");
	assert.equal(tokens(TRAIN.pane).sb_role, "train", "and after its /reload");
	// The same reload in a tab that no longer carries the code.
	await reloaded.stop("reload");
	world.herdr.tabs.find((t) => t.tab_id === tab)!.label = "something else";
	const renamed = await pi({ id: "train-2", pane: TRAIN.pane, entries: reloaded.entries, deps: { couple: false } }, TRAIN.file, "reload");
	assert.notEqual(tokens(TRAIN.pane).sb_role, "train");
	assert.ok(told(renamed, /not in that train's tab/));
});

// RP131-F003: the tab's label carries the short code only (`train 1106m`), not the project or the year. At a /reload the pane still carries the train's own `sb_train` (presence.ts keeps it),
// so an entry that names another train of the same short code is not taken.
test("a train that rewrites its saved entry to another project and year of the same short code is not that train at its /reload: the pane's kept sb_train says which it was", async () => {
	const { tower } = await net();
	await openTrain(tower);
	const train = world.agents.find((a) => a.file === TRAIN.file)!;
	await train.stop("reload");
	assert.equal(tokens(TRAIN.pane).sb_train, "acme/2026-11-06-m", "the reload keeps the pane's train token");
	const forged = { customType: "straw-boss", data: { openedBy: "tower-1", openedPane: TRAIN.pane, train: { project: "other", code: "2025-11-06-m" } } };
	const again = await pi({ id: "train-1", pane: TRAIN.pane, entries: [...train.entries, forged], deps: { couple: false } }, TRAIN.file, "reload");
	assert.notEqual(tokens(TRAIN.pane).sb_train, "other/2025-11-06-m", "the forged train is not published");
	assert.notEqual(tokens(TRAIN.pane).sb_role, "train");
	assert.ok(told(again, /saved entry names other\/2025-11-06-m, but its pane carries acme\/2026-11-06-m.*no train/), "the refusal is told");
});

// --- the labels are Straw Boss's own -----------------------------------------------------------------------------------------------------------------------------------

test("no session names its tab into a tower's or a train's: boss_rename refuses the tower glyph, the head glyph, and a train's label", async () => {
	const { main } = await net();
	for (const name of [TOWER_LABEL, ` ${TOWER_LABEL} `, "\u{f01a5}", "train 1106m", "train  0101ab"]) {
		await assert.rejects(main.tool("boss_rename", { name }), /label of a tower's or a train's tab/, JSON.stringify(name));
	}
	assert.equal(world.herdr.tabs.find((t) => t.tab_id === "wA:t1")?.label, "work", "the tab kept its label");
	await main.tool("boss_rename", { name: "train 1106m fix" }); // a phrase about a train is a name like any other
	assert.equal(world.herdr.tabs.find((t) => t.tab_id === "wA:t1")?.label, "train 1106m fix");
});

test("a tower's boss_open_main gives a main's tab no tower's or train's label, while a train's own label is its code's", async () => {
	const { tower } = await net();
	for (const label of [TOWER_LABEL, "train 1106m", ` ${TOWER_LABEL} `, "train 1106m\n"]) { // padded: Herdr shows the trimmed label
		await assert.rejects(tower.tool("boss_open_main", { request: "Fix the export button.", sender: "member-1", label }), /label of a tower's or a train's tab/, label);
	}
	assert.equal(world.herdr.commands("tab", "create").length, 0, "nothing was opened");
	await openTrain(tower); // `label: "train 1106m"` is what the tower sends for a train (§3.3), and the open sets it from the code whatever was sent
});
