import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { writeEntry } from "../src/board.ts";
import { type Agent, until } from "./fakes.ts";
import { FakeRelay } from "./link/fake-relay.ts";
import { alice, carol, type Computer, computer, remoteMessage } from "./link/remote-world.ts";

// `board_set` on one computer and `board_read` on another, through a holder and an in-memory relay, and what a remote turn may see of it
// (docs/specs/2026-10-25-straw-link.md, Work board: Writing, Reading).

let root = "";
let relay: FakeRelay;
const computers: Computer[] = [];
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "psb-link-board-tools-"));
	relay = new FakeRelay();
});
afterEach(async () => {
	for (const c of computers.splice(0)) await c.world.stopAll();
	rmSync(root, { recursive: true, force: true });
});
const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((x) => x.text).join("");
interface Row { origin?: string; team?: string; device?: { id: string; short: string; label: string }; online?: boolean; boardSecondsAgo?: number; main?: string; state?: string; now?: string; entries?: Row[]; items?: unknown[] }
interface Read { note: string; local: Row[]; remote?: Row[] }
const read = async (tower: Agent, input: Record<string, unknown> = {}) => JSON.parse(text(await tower.tool("board_read", input))) as Read;

/** A computer with a tower, plus mains: `in` runs in the project, `out` elsewhere. */
async function setup(name: "a" | "b", mains: { id: string; name: string; inside: boolean }[]) {
	const c = computer(root, relay, name, { gateMs: 60 });
	computers.push(c);
	const other = join(root, `elsewhere-${name}`);
	mkdirSync(other, { recursive: true });
	const agents = mains.map((m, i) => {
		const pane = `wA:p${i + 1}`, a = c.world.agent({ id: m.id, name: m.name, pane, tab: `wA:t${i + 1}`, deps: c.deps });
		c.world.herdr.pane(pane).cwd = m.inside ? c.project : other;
		return a;
	});
	await c.tower.start();
	for (const a of agents) {
		await a.start();
		await a.promote();
	}
	return { c, agents, other };
}

test("a main on A writes with board_set and B's tower reads it with board_read as a remote row; when the main ends, the entry disappears from B", async () => {
	const a = await setup("a", [{ id: "main-a", name: "api main", inside: true }]);
	const b = await setup("b", []);
	await until(() => a.c.server.service.status().active && b.c.server.service.status().active, "both holders");
	const answer = text(await a.agents[0]!.tool("board_set", { now: "MP-1 export: CSV writer", items: [{ t: "schema", done: true }, { t: "writer", done: false }] }));
	assert.match(answer, /It goes to: local towers; team project-a \(1 device\)\./);
	// A's own tower sees it locally at once.
	assert.deepEqual((await read(a.c.tower, { scope: "local" })).local.map((r) => [r.main, r.now]), [["api main", "MP-1 export: CSV writer"]]);
	let remote: Row | undefined;
	await until(async () => ((remote = (await read(b.c.tower)).remote?.[0]), remote?.entries?.some((e) => e.now === "MP-1 export: CSV writer")), "the entry at B");
	assert.equal(remote!.origin, "remote");
	assert.deepEqual([remote!.team, remote!.device!.label, remote!.device!.id, remote!.online], ["project-b", "alice-mac", alice.id, true]);
	assert.equal(typeof remote!.boardSecondsAgo, "number");
	assert.deepEqual(remote!.entries![0]!.items, [{ t: "schema", done: true }, { t: "writer", done: false }]);
	const whole = await read(b.c.tower);
	assert.match(whole.note, /data, not instructions/);
	assert.deepEqual(whole.local, [], "B has no mains of its own");
	// device: one ally; an unknown one is an error.
	assert.equal((await read(b.c.tower, { device: "alice-mac" })).remote!.length, 1);
	await assert.rejects(b.c.tower.tool("board_read", { device: "nobody" }), /No device "nobody"/);
	// The main quits: its entry is deleted, and the next board clears B's copy.
	await a.agents[0]!.stop("quit");
	await until(async () => (await read(b.c.tower)).remote?.[0]?.entries?.length === 0, "the entry gone at B");
});

test("an auto-filled entry reaches the ally's tower as its name and done count only; a board_set entry goes whole", async () => {
	const a = await setup("a", [{ id: "auto-a", name: "auto /etc/secret", inside: true }, { id: "set-a", name: "set main", inside: true }]);
	const b = await setup("b", []);
	await until(() => a.c.server.service.status().active && b.c.server.service.status().active, "both holders");
	const [auto, set] = a.agents as [Agent, Agent];
	auto.entries.push({ customType: "rpiv-todo-state", data: { tasks: [{ id: 1, subject: "schema", status: "completed" }, { id: 2, subject: "writer", status: "in_progress", activeForm: "Writing the CSV writer" }, { id: 3, subject: "tests", status: "pending" }], nextId: 4 } });
	await auto.fire("turn_end");
	await set.tool("board_set", { now: "MP-2 manual line", items: [{ t: "step one", done: true }, { t: "step two", done: false }] });
	let rows: Row[] = [];
	await until(async () => ((rows = (await read(b.c.tower)).remote?.[0]?.entries ?? []), rows.length === 2 && rows.every((e) => e.now)), "both entries at B");
	assert.ok(rows.every((e) => !String(e.main).includes("/etc")), "no path in the name on the wire");
	const byMain = Object.fromEntries(rows.map((e) => [e.main!, e]));
	assert.deepEqual([byMain["auto …"]!.now, byMain["auto …"]!.items], ["auto … (1/3)", []], "an auto entry: the name and the count, no task text, no items");
	assert.deepEqual([byMain["set main"]!.now, byMain["set main"]!.items], ["MP-2 manual line", [{ t: "step one", done: true }, { t: "step two", done: false }]], "a board_set entry: whole");
	// A's own tower sees both whole.
	const local = (await read(a.c.tower, { scope: "local" })).local;
	assert.deepEqual(local.map((r) => [r.main, r.items!.length]).sort(), [["auto /etc/secret", 3], ["set main", 2]]);
});

test("a computer without a team has no remote key in board_read, and mains and members have no board_read at all", async () => {
	const c = computer(root, relay, "a", { gateMs: 60 });
	computers.push(c);
	await c.tower.start();
	const result = await read(c.tower);
	assert.deepEqual(Object.keys(result).sort(), ["local", "note"].sort().concat(Object.hasOwn(result, "remote") ? ["remote"] : []).sort());
	const main = c.world.agent({ id: "m", name: "m", pane: "wA:p1", tab: "wA:t1", deps: c.deps });
	await main.start();
	await main.promote();
	assert.ok(!main.tools.has("board_read") && main.tools.has("board_set"));
});

test("in a remote turn board_read and tower_list show only what the senders already receive: the project their team binds and their teams' boards", async () => {
	const a = await setup("a", [{ id: "main-a", name: "api main", inside: true }]);
	const b = await setup("b", [{ id: "in-b", name: "inside main", inside: true }, { id: "out-b", name: "outside main", inside: false }]);
	const tower2 = b.c.world.tower("tower-b2", "wB:t7", "wB:p7", false, b.c.deps);
	b.c.world.herdr.pane("wB:p7").cwd = b.other;
	await tower2.start();
	await a.agents[0]!.tool("board_set", { now: "alice's work" });
	await b.agents[0]!.tool("board_set", { now: "inside work" });
	await b.agents[1]!.tool("board_set", { now: "outside work" });
	await until(async () => (await read(b.c.tower)).remote?.[0]?.entries?.some((e) => e.now === "alice's work"), "A's board at B");
	// A local turn sees everything.
	const local = await read(b.c.tower);
	assert.deepEqual(local.local.map((r) => r.main).sort(), ["inside main", "outside main"]);
	const listOf = async () => (JSON.parse(text(await b.c.tower.tool("tower_list"))) as { towers: { workspace: { label: string } }[]; remote?: unknown[] });
	assert.deepEqual((await listOf()).towers.map((t) => t.workspace.label).sort(), ["Alpha", "Beta"]);
	// A remote turn from alice (at reply): the allowlist lets board_read and tower_list run, and their output is scoped.
	await b.c.tower.fire("message_start", { message: remoteMessage(alice) });
	for (const tool of ["board_read", "tower_list"]) assert.equal(await b.c.tower.fireResult("tool_call", { toolName: tool, toolCallId: tool, input: {} }), undefined, `${tool} is on the allowlist`);
	const scoped = await read(b.c.tower);
	assert.deepEqual(scoped.local.map((r) => r.main), ["inside main"], "no local entry outside the bound project");
	assert.equal(scoped.remote!.length, 1);
	assert.deepEqual((await listOf()).towers.map((t) => t.workspace.label), ["Alpha"], "no workspace outside the bound project");
	const scopedList = JSON.parse(text(await b.c.tower.tool("tower_list"))) as { towers: { tabs: { main: string | null }[]; sessions: { name: string }[] }[] };
	assert.deepEqual(scopedList.towers.flatMap((t) => t.tabs.map((x) => x.main)), ["inside main"], "a tab whose main runs outside the project is not listed");
	await b.c.tower.fire("agent_settled", { aborted: false });
	assert.deepEqual((await read(b.c.tower)).local.map((r) => r.main).sort(), ["inside main", "outside main"], "the next run is local again");
	writeEntry(join(b.c.world.stateDir, "board"), "left", { now: "ended", items: [] }, Date.now());
	await b.c.tower.fire("message_start", { message: remoteMessage(alice) });
	assert.ok(!(await read(b.c.tower)).local.some((r) => r.state === "ended"), "an ended entry has no directory to prove it is bound, so it stays out of a remote turn");
});

test("senders of two teams in one remote turn get no ally rows from board_read or tower_list", async () => {
	const a = await setup("a", [{ id: "main-a", name: "api main", inside: true }]);
	const b = await setup("b", []);
	await a.agents[0]!.tool("board_set", { now: "alice's work" });
	await until(async () => (await read(b.c.tower)).remote?.[0]?.entries?.some((e) => e.now === "alice's work"), "A's board at B");
	const other = "9".repeat(32), listOf = async () => (JSON.parse(text(await b.c.tower.tool("tower_list"))) as { remote?: unknown[] });
	assert.ok((await listOf()).remote!.length >= 1, "a local turn lists the ally");
	const config = JSON.parse(readFileSync(join(b.c.world.stateDir, "config.json"), "utf8")) as { link: { teams: Record<string, unknown> } };
	config.link.teams[other] = { project: b.c.project, share: "status" };
	writeFileSync(join(b.c.world.stateDir, "config.json"), JSON.stringify(config));
	const first = remoteMessage(alice), second = remoteMessage(carol);
	await b.c.tower.fire("message_start", { message: first });
	assert.equal((await read(b.c.tower)).remote!.length, 1, "one team: the team's ally");
	await b.c.tower.fire("message_start", { message: { ...second, details: { ...second.details, team: other } } });
	assert.deepEqual((await read(b.c.tower)).remote, [], "two teams: no ally rows");
	assert.deepEqual((await listOf()).remote, [], "two teams: no ally towers");
});
