import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { until, World, type Agent } from "./fakes.ts";

// Herdr's restore (`herdr server stop`, then a new server with resume_agents_on_restore): every pane comes back with its pi resumed into the same session
// file, but without STRAW_BOSS_ROLE, without pane or workspace tokens, with new intercom session ids, and, for a session that had no conversation yet, with
// none of the entries the extension wrote (pi writes a session file only once it has a conversation). The roles have to come back by themselves.

let world = new World();
afterEach(async () => {
	await world.stopAll();
	world = new World();
});

const FILES = { tower: "/s/tower.jsonl", main: "/s/main.jsonl", member: "/s/member.jsonl" };
const tokens = (pane: string) => world.herdr.pane(pane).tokens;

/** A pi that has been started on a session file, as pi would: `file` is what its session manager names. */
async function pi(options: Parameters<World["agent"]>[0], file: string): Promise<Agent> {
	const agent = world.agent(options);
	agent.file = file;
	await agent.start();
	return agent;
}

/** The net as the PM left it: a tower, a main, and a member in workspace wA. */
async function net() {
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	const tower = await pi({ id: "tower-1", pane: "wA:p7", tab: "wA:t7", env: { STRAW_BOSS_ROLE: "tower" } }, FILES.tower);
	const main = await pi({ id: "main-1", pane: "wA:p1", tab: "wA:t1" }, FILES.main);
	assert.match(await main.promote(), /the main agent of tab/);
	const member = await pi({ id: "member-1", pane: "wA:p2", tab: "wA:t1" }, FILES.member);
	return { tower, main, member };
}

/** Herdr stops and a new server resumes the panes: the processes end, the panes and tabs stay, the tokens are gone. Resumed sessions start with ids of their own. */
async function restore(resumed: { id: string; pane: string; file: string; deps?: Parameters<World["agent"]>[0]["deps"] }[], afterRestart?: () => void): Promise<Agent[]> {
	const [panes, tabs] = [[...world.herdr.panes], [...world.herdr.tabs]];
	for (const agent of [...world.agents]) await agent.stop("quit");
	[world.herdr.panes, world.herdr.tabs] = [panes, tabs]; // the quit closes a tower's pane through a Herdr that is already gone
	world.herdr.restart();
	afterRestart?.();
	const back: Agent[] = [];
	for (const { id, pane, file, deps } of resumed) back.push(await pi({ id, pane, deps }, file)); // no STRAW_BOSS_ROLE: the resume starts pi in a plain shell
	await world.quiet();
	return back;
}

test("after a Herdr restore the tower is the tower again and a main is the main again, with their tokens", async () => {
	await net();
	assert.equal(tokens("wA:p1").sb_role, "main");
	const [tower, main, member] = await restore([
		{ id: "tower-2", pane: "wA:p7", file: FILES.tower },
		{ id: "main-2", pane: "wA:p1", file: FILES.main },
		{ id: "member-2", pane: "wA:p2", file: FILES.member },
	]) as [Agent, Agent, Agent];

	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2", "the tower's workspace token is back");
	assert.equal(tokens("wA:p7").sb_role, "tower");
	await until(() => tokens("wA:p1").sb_role === "main", "the main is main again");
	assert.equal(tokens("wA:p2").sb_role, "member");
	assert.deepEqual([tower.tokens, main.tokens, member.tokens].map((t) => t.sb_role), ["tower", "main", "member"]);
	assert.equal(await main.promote(), "You are already the main agent of tab work.");
	assert.match(await member.promote(), /already has a main agent/, "the tab has its main, so the member stays a member");
	assert.equal(world.herdr.commands("tab", "create").length + world.herdr.commands("agent", "start").length, 0, "no second tower opens for the restored main");
});

test("a session resumed in another pane or tab than it held stays a member", async () => {
	await net();
	world.herdr.addPane("wA:p9", "wA:t2");
	const [tower, main] = await restore([
		{ id: "tower-2", pane: "wA:p9", file: FILES.tower }, // the tower's file in an ordinary pane
		{ id: "main-2", pane: "wA:p2", file: FILES.main }, // the main's file in another pane of the same tab
	]) as [Agent, Agent];
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined);
	assert.equal(tower.tokens.sb_role, "member");
	assert.equal(main.tokens.sb_role, "member");
	assert.equal(world.herdr.pane("wA:p7").tokens.sb_role, undefined);

	const moved = world.agent({ id: "main-3", pane: "wA:p1" });
	moved.file = FILES.main;
	world.herdr.pane("wA:p1").tab_id = "wA:t2"; // the pane moved to another tab
	await moved.start();
	assert.equal(moved.tokens.sb_role, "member");
});

test("a session with no record, or one that was closed on purpose, stays a member", async () => {
	const { main } = await net();
	const roles = join(world.stateDir, "roles");
	const held = () => readdirSync(roles).map((name) => JSON.parse(readFileSync(join(roles, name), "utf8")) as { role: string; pane: string });
	assert.deepEqual(held().map((r) => `${r.role} ${r.pane}`).sort(), ["main wA:p1", "tower wA:p7"], "the tower and the main left records");
	await main.command("close");
	await until(() => main.stopped, "the main closed itself");
	await world.quiet();
	assert.ok(!held().some((r) => r.pane === "wA:p1"), "closing the main dropped its record (the member that took over the tab left its own)");
	world.herdr.addPane("wA:p1", "wA:t1"); // its pane closed with it; pi runs in a new one under the same id
	const [back, other] = await restore([
		{ id: "main-2", pane: "wA:p1", file: FILES.main },
		{ id: "tower-2", pane: "wA:p7", file: "/s/never-seen.jsonl" },
	]) as [Agent, Agent];
	assert.equal(back.tokens.sb_role, "member", "the closed main's file proves nothing");
	assert.equal(other.tokens.sb_role, "member", "a tower pane with another session file proves nothing");
});

test("a record that cannot be read, or one a session of another file left, proves nothing", async () => {
	await net();
	const roles = join(world.stateDir, "roles");
	for (const name of readdirSync(roles)) writeFileSync(join(roles, name), "{not json");
	const [tower, main] = await restore([
		{ id: "tower-2", pane: "wA:p7", file: FILES.tower },
		{ id: "main-2", pane: "wA:p1", file: FILES.main },
	]) as [Agent, Agent];
	assert.equal(tower.tokens.sb_role, "member");
	assert.equal(main.tokens.sb_role, "member");
});

test("a record untouched for 90 days is swept when another is written", async () => {
	await net();
	const roles = join(world.stateDir, "roles"), [old] = readdirSync(roles);
	const when = new Date(Date.now() - 91 * 24 * 3600_000);
	utimesSync(join(roles, old!), when, when);
	world.herdr.addTab("wA:t3", "more", "wA:p3");
	const next = await pi({ id: "main-9", pane: "wA:p3", tab: "wA:t3" }, "/s/another.jsonl");
	await next.promote();
	assert.ok(!readdirSync(roles).includes(old!), "the old record is gone");
	assert.ok(readdirSync(roles).length >= 2, "the others stay");
});

const roles = () => join(world.stateDir, "roles");
const records = () => readdirSync(roles()).filter((name) => name !== "dangling.json").map((name) => JSON.parse(readFileSync(join(roles(), name), "utf8")) as { role: string; pane: string });

test("a demoted main's record does not win its tab back: the main that took the tab does, whichever pi starts first", async () => {
	for (const order of [["main", "member"], ["member", "main"]] as const) {
		const { main, member } = await net();
		const stale = readdirSync(roles()).map((name) => [name, readFileSync(join(roles(), name), "utf8")] as const).find(([, text]) => text.includes('"pane":"wA:p1"'))!;
		await member.command(""); // /boss: forces the promotion, so the first main is demoted
		await until(() => member.tokens.sb_role === "main" && main.tokens.sb_role === "member", "the member took the tab");
		assert.deepEqual(records().map((r) => `${r.role} ${r.pane}`).sort(), ["main wA:p2", "tower wA:p7"], "one main record for the tab");
		writeFileSync(join(roles(), stale[0]), stale[1]); // and a demoted main's record from before a tab had only one, back beside it
		// Without the guard, which crowns whoever joins a tab first once the tower is back: only the records decide here.
		const deps = { couple: false };
		const files = { main: { id: "main-2", pane: "wA:p1", file: FILES.main, deps }, member: { id: "member-2", pane: "wA:p2", file: FILES.member, deps } };
		const back = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower }, ...order.map((who) => files[who])]);
		const [first, second] = back.slice(1) as [Agent, Agent], [then, now] = order[0] === "main" ? [first, second] : [second, first];
		await until(() => now.tokens.sb_role === "main", `the member is main again (${order.join(", ")} first)`);
		assert.equal(then.tokens.sb_role, "member", "the demoted main stays a member");
		await world.stopAll();
		world = new World();
	}
});

test("a tower comes back only in the pane, tab, and workspace it recorded", async () => {
	await net();
	world.herdr.pane("wA:p7").tab_id = "wA:t2"; // the pane moved to another tab of its workspace
	const [moved] = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower }]) as [Agent];
	assert.equal(moved.tokens.sb_role, "member", "same pane id, other tab");
	assert.equal(world.herdr.workspace("wA").tokens.tower, undefined);
	await world.stopAll();

	world = new World();
	await net();
	world.herdr.pane("wA:p7").tab_id = "wB:t1"; // and to another workspace
	world.herdr.pane("wA:p7").workspace_id = "wB";
	const [other] = await restore([{ id: "tower-3", pane: "wA:p7", file: FILES.tower }]) as [Agent];
	assert.equal(other.tokens.sb_role, "member", "same pane id, other workspace");
	assert.equal(world.herdr.workspace("wB").tokens.tower, undefined);
});

test("a main that quit and is resumed in the same shell takes no role from its record, which a later restore does not honor either", async () => {
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	await pi({ id: "tower-1", pane: "wA:p7", tab: "wA:t7", env: { STRAW_BOSS_ROLE: "tower" } }, FILES.tower);
	const deps = { couple: false }; // the guard would crown the one member of a tab anyway
	const main = await pi({ id: "main-1", pane: "wA:p1", tab: "wA:t1", deps }, FILES.main);
	await main.promote();
	assert.ok(records().some((r) => r.pane === "wA:p1"), "the main left a record");
	await main.stop("quit"); // /quit: the pane and its shell stay
	const again = await pi({ id: "main-2", pane: "wA:p1", deps }, FILES.main); // `pi --session` (or /resume) in that shell
	assert.equal(again.tokens.sb_role, "member", "no restore brought it, so no claim was made");
	assert.ok(!records().some((r) => r.pane === "wA:p1"), "the record is gone");
	const [back] = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower }, { id: "main-3", pane: "wA:p1", file: FILES.main, deps }]).then((all) => all.slice(1)) as [Agent];
	assert.equal(back.tokens.sb_role, "member", "and the next Herdr restore finds nothing to give back");
});

test("a restored main opens no tower, and opens one the next time it becomes the main", async () => {
	world.herdr.addTab("wA:t1", "work", "wA:p1");
	const main = world.agent({ id: "main-1", pane: "wA:p1", deps: { autoTower: true } });
	main.file = FILES.main;
	await main.start();
	await main.promote();
	await world.quiet();
	assert.equal(world.herdr.commands("tab", "create").length, 1, "the first main of a workspace opens the tower");
	// Herdr stops and a new server resumes the main alone, and the broker still knows its session id.
	const [panes, tabs] = [[...world.herdr.panes], [...world.herdr.tabs]];
	await main.stop("quit");
	[world.herdr.panes, world.herdr.tabs] = [panes.filter((p) => p.pane_id === "wA:p1"), tabs];
	world.herdr.restart();
	const back = world.agent({ id: "main-1", pane: "wA:p1", deps: { autoTower: true } });
	back.file = FILES.main;
	await back.start();
	await world.quiet();
	assert.equal(back.tokens.sb_role, "main", "it is the main again");
	assert.equal(world.herdr.commands("tab", "create").length, 0, "its tower is coming back, so it opens none");
	world.herdr.addPane("wA:p2", "wA:t1");
	const rival = world.agent({ id: "rival-1", pane: "wA:p2" });
	rival.file = FILES.member;
	await rival.start();
	await rival.command(""); // takes the tab
	await until(() => back.tokens.sb_role === "member", "the main was demoted");
	await back.command("");
	await until(() => back.tokens.sb_role === "main", "and took the tab back");
	await world.quiet();
	assert.equal(world.herdr.commands("tab", "create").length, 1, "this time it opens the tower");
});

test("a record directory entry that vanishes during the sweep does not make the write look failed", async () => {
	mkdirSync(roles(), { recursive: true });
	symlinkSync(join(world.stateDir, "nowhere"), join(roles(), "dangling.json")); // statSync of it fails with ENOENT, as a file removed between readdir and stat does
	world.herdr.addTab("wA:t7", "tower", "wA:p7");
	const main = await pi({ id: "main-1", pane: "wA:p1", tab: "wA:t1" }, FILES.main);
	await main.promote();
	assert.ok(records().some((r) => r.pane === "wA:p1"), "the record was written");
	assert.deepEqual(main.notices.filter((n) => /could not record/.test(n.text)), [], "and nothing said it was not");
});

test("the guard leaves a restored tab to the main the restore is bringing back, and crowns the member that is there once it has waited long enough", async () => {
	await net();
	let clock = Date.now();
	const deps = { now: () => clock };
	// The member's pi comes back first, with its tower: the guard would crown it as the tab's only member, but the main's pane is back in a new terminal and its pi is on the way.
	const [, member] = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower, deps }, { id: "member-2", pane: "wA:p2", file: FILES.member, deps }]) as [Agent, Agent];
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2", "the tower is back");
	await world.quiet();
	assert.equal(member.tokens.sb_role, "member", "nobody is crowned while the main is expected");
	const main = await pi({ id: "main-2", pane: "wA:p1", deps }, FILES.main);
	await until(() => main.tokens.sb_role === "main", "the main is main again");
	assert.equal(member.tokens.sb_role, "member");

	// A main whose pi never comes back (it was not running when Herdr stopped) holds the tab only for the wait.
	await world.stopAll();
	world = new World();
	await net();
	clock = Date.now();
	const [, other] = await restore([{ id: "tower-3", pane: "wA:p7", file: FILES.tower, deps }, { id: "member-3", pane: "wA:p2", file: FILES.member, deps }]) as [Agent, Agent];
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-3", "the tower is back");
	await world.quiet();
	assert.equal(other.tokens.sb_role, "member", "waiting");
	clock += 31_000;
	world.herdr.emit("pane.agent_detected", "pane_agent_detected", { pane_id: "wA:p9", workspace_id: "wA" }); // any event of the workspace makes the guard look again
	await until(() => other.tokens.sb_role === "main", "crowned after the wait");
});

test("the wait for a restored main ends by its own timer, with no event to make the guard look again", async () => {
	await net();
	const deps = { restoreMs: 300 };
	const [, member] = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower, deps }, { id: "member-2", pane: "wA:p2", file: FILES.member, deps }]) as [Agent, Agent];
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2", "the tower is back");
	assert.equal(member.tokens.sb_role, "member", "waiting for the main");
	await until(() => member.tokens.sb_role === "main", "crowned by the guard's own timer", 5000);
});

test("a pane Herdr reports without a terminal_id restores no main, waits for none, and says so once", async () => {
	await net();
	const [, member, main] = await restore(
		[{ id: "tower-2", pane: "wA:p7", file: FILES.tower }, { id: "member-2", pane: "wA:p2", file: FILES.member }, { id: "main-2", pane: "wA:p1", file: FILES.main }],
		() => world.herdr.panes.forEach((p) => delete (p as { terminal_id?: string }).terminal_id),
	) as [Agent, Agent, Agent];
	await world.quiet();
	assert.equal(main.notices.filter((n) => /no terminal_id/.test(n.text)).length, 1, "the main's session warns once");
	assert.equal(main.tokens.sb_role === "main" && member.tokens.sb_role === "main", false, "no second main");
	assert.equal([main, member].filter((a) => a.tokens.sb_role === "main").length, 1, "the guard crowned one session without waiting");
});

test("a pane list that fails does not stop the guard from crowning", async () => {
	await net();
	const [, member] = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower }, { id: "member-2", pane: "wA:p2", file: FILES.member }]) as [Agent, Agent];
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2", "the tower is back");
	await world.quiet();
	assert.equal(member.tokens.sb_role, "member", "waiting for the main");
	world.herdr.failPanes = true;
	world.herdr.emit("pane.agent_detected", "pane_agent_detected", { pane_id: "wA:p9", workspace_id: "wA" });
	await until(() => member.tokens.sb_role === "main", "crowned although the pane list failed");
});

test("the guard does not wait for a pane whose session is another than the recorded main's", async () => {
	await net();
	const [, member] = await restore([{ id: "tower-2", pane: "wA:p7", file: FILES.tower }, { id: "member-2", pane: "wA:p2", file: FILES.member }], () => {
		world.herdr.pane("wA:p1").agent_session = { value: "/s/someone-else.jsonl" }; // the pane id was reused by another session
	}) as [Agent, Agent];
	await until(() => member.tokens.sb_role === "main", "crowned at once");
});

test("a restored main whose claim times out still opens no tower once the owner confirms it later", async () => {
	world.herdr.addTab("wA:t1", "work", "wA:p1");
	world.herdr.addPane("wA:p2", "wA:t1");
	const fast = { autoTower: true, couple: false, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 2))) };
	const first = world.agent({ id: "main-1", pane: "wA:p1", deps: fast });
	first.file = FILES.main;
	await first.start();
	await first.promote();
	await first.stop("quit");
	world.herdr.commands("tab", "create").length = 0;
	world.herdr.restart();
	world.broker.dropClaims = true;
	const member = await pi({ id: "member-2", pane: "wA:p2", deps: fast }, FILES.member); // the owner of the tab channel
	const back = await pi({ id: "main-2", pane: "wA:p1", deps: fast }, FILES.main);
	await until(() => back.notices.some((n) => /did not confirm/.test(n.text)), "the claim timed out");
	assert.equal(member.tokens.sb_role, "member");
	world.broker.dropClaims = false;
	assert.match(await back.promote(), /the main agent of tab/);
	await world.quiet();
	assert.equal(back.tokens.sb_role, "main");
	assert.equal(world.herdr.commands("tab", "create").length, 0, "the restored main opens no tower, though its claim timed out first");
});

// A main the tower opened for a request is closable by that tower (closemain.ts) only while its pane carries `sb_opened_by`, which the main writes from the opener it
// saved in the session, and only for the same pi in the same pane after a /reload. A Herdr restore is a plain startup, so the record has to carry the opener too.
const OPENED = { file: "/s/opened.jsonl", pane: "wA:p101" };
const asOpened = () => {
	world.herdr.onAgentStart = (pane) => {
		const agent = world.agent({ id: "opened-1", name: "main · opened", pane: pane.pane_id, env: { STRAW_BOSS_ROLE: "main" } });
		agent.file = OPENED.file;
		void agent.start();
	};
};
const closeable = (tower: Agent, id: string) => {
	world.herdr.pane(OPENED.pane).agent_status = "idle";
	return tower.tool("boss_close_main", { main: id }).then(() => "closed", (error: Error) => error.message);
};

test("a main the tower opened is closable by the restored tower after a Herdr restore", async () => {
	const { tower } = await net();
	asOpened();
	await tower.tool("boss_open_main", { request: "Fix the export button.", sender: "member-1" });
	await until(() => world.herdr.pane(OPENED.pane).tokens.sb_role === "main", "the opened main is main");
	assert.ok(tokens(OPENED.pane).sb_opened_by, "it is marked as opened");
	assert.ok(records().some((r) => r.pane === OPENED.pane), "and left its record");
	world.herdr.onAgentStart = undefined;
	const [tower2, , back] = await restore([
		{ id: "tower-2", pane: "wA:p7", file: FILES.tower },
		{ id: "main-2", pane: "wA:p1", file: FILES.main },
		{ id: "opened-2", pane: OPENED.pane, file: OPENED.file },
	]) as [Agent, Agent, Agent];
	await until(() => world.herdr.workspace("wA").tokens.tower === "tower-2", "the tower is back");
	await until(() => tokens(OPENED.pane).sb_role === "main", "the opened main is main again");
	await until(() => Boolean(tokens(OPENED.pane).sb_opened_by), "and marked as opened again");
	assert.equal(back.regs.has("straw-boss/control"), true, "it listens for close asks");
	assert.equal(await closeable(tower2, "opened-2"), "closed");
	await until(() => back.stopped, "the restored main quit");
});

test("a restored main restored in another workspace than the one that opened it has no opener", async () => {
	const { tower } = await net();
	asOpened();
	await tower.tool("boss_open_main", { request: "Fix the export button.", sender: "member-1" });
	await until(() => world.herdr.pane(OPENED.pane).tokens.sb_role === "main", "the opened main is main");
	world.herdr.onAgentStart = undefined;
	// The main's pane moved to another workspace: its record means nothing there, and the tower of wA is not that workspace's.
	world.herdr.workspaces.push({ workspace_id: "wB", label: "Beta", tokens: {} });
	const [, , moved] = await restore([
		{ id: "tower-2", pane: "wA:p7", file: FILES.tower },
		{ id: "main-2", pane: "wA:p1", file: FILES.main },
		{ id: "opened-2", pane: OPENED.pane, file: OPENED.file },
	], () => Object.assign(world.herdr.pane(OPENED.pane), { workspace_id: "wB" })) as [Agent, Agent, Agent];
	await world.quiet();
	assert.equal(tokens(OPENED.pane).sb_role, "member");
	assert.equal(tokens(OPENED.pane).sb_opened_by, undefined, "no opener in another workspace");
	assert.equal(moved.regs.has("straw-boss/control"), false);
});

test("a main the boss opened stays the boss's after a Herdr restore", async () => {
	await net();
	assert.equal(tokens("wA:p1").sb_opened_by, undefined);
	const [tower2, , back] = await restore([
		{ id: "tower-2", pane: "wA:p7", file: FILES.tower },
		{ id: "member-2", pane: "wA:p2", file: FILES.member },
		{ id: "main-2", pane: "wA:p1", file: FILES.main },
	]) as [Agent, Agent, Agent];
	await until(() => tokens("wA:p1").sb_role === "main", "the main is main again");
	assert.equal(tokens("wA:p1").sb_opened_by, undefined);
	assert.equal(back.regs.has("straw-boss/control"), false);
	world.herdr.pane("wA:p1").agent_status = "idle";
	await assert.rejects(tower2.tool("boss_close_main", { main: "main-2" }), /was not opened by a tower/);
});
