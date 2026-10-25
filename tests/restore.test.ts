import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
async function restore(resumed: { id: string; pane: string; file: string }[]): Promise<Agent[]> {
	const [panes, tabs] = [[...world.herdr.panes], [...world.herdr.tabs]];
	for (const agent of [...world.agents]) await agent.stop("quit");
	[world.herdr.panes, world.herdr.tabs] = [panes, tabs]; // the quit closes a tower's pane through a Herdr that is already gone
	world.herdr.restart();
	const back: Agent[] = [];
	for (const { id, pane, file } of resumed) back.push(await pi({ id, pane }, file)); // no STRAW_BOSS_ROLE: the resume starts pi in a plain shell
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
