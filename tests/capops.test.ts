import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { writeEntry } from "../src/board.ts";
import type { HerdrRun, Pane, Session } from "../src/herdr.ts";
import { mainFacts, readBudget, tellCap } from "../src/server/capops.ts";

// The server's side of the capacity watch (src/server/capops.ts): `capacity.budget`, the facts of the live mains, and where an event goes.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "psb-capops-"))), dirs.at(-1)!);

test("capacity.budget: a number of points over 0 and at most 1000; anything else is unset", () => {
	const d = tmp();
	assert.equal(readBudget(d), undefined, "no config.json");
	for (const [budget, want] of [[20, 20], [0.5, 0.5], [0, undefined], [-1, undefined], [1001, undefined], ["20", undefined], [null, undefined]] as const) {
		writeFileSync(join(d, "config.json"), JSON.stringify({ capacity: { budget } }));
		assert.equal(readBudget(d), want, String(budget));
	}
	writeFileSync(join(d, "config.json"), "{ not json");
	assert.equal(readBudget(d), undefined);
});

test("mainFacts: the live mains and trains with their duty, session file time and board entry time; towers and members are none", () => {
	const d = tmp(), board = join(d, "board");
	writeEntry(board, "m1", { now: "x", items: [] }, 1000);
	const s = (id: string, p: string): Session => ({ id, name: `${id}-name`, status: "idle", herdrLocation: { status: "current", paneId: p, workspace: { id: "wA", label: "Alpha" }, tab: { id: `t-${id}`, label: "t" } } } as Session);
	const pane = (id: string, role: string, more: Partial<Pane> = {}): Pane => ({ pane_id: id, tab_id: "t", workspace_id: "wA", agent: "pi", agent_status: "idle", tokens: { sb_role: role }, ...more });
	const facts = mainFacts([s("m1", "p1"), s("st", "p2"), s("tr", "p3"), s("tw", "p4"), s("mb", "p5")], [pane("p1", "main", { agent_session: { value: "/s/m1.jsonl" } as never }), pane("p2", "main", { tokens: { sb_role: "main", sb_duty: "standing" } }), pane("p3", "train"), pane("p4", "tower"), pane("p5", "member")], board, 5000, (file) => (file === "/s/m1.jsonl" ? 4000 : undefined));
	assert.deepEqual(facts.map((f) => [f.session, f.role, f.duty, f.fileMtime, f.entryUpdated, f.workers]), [["m1", "main", undefined, 4000, 1000, []], ["st", "main", "standing", undefined, undefined, []], ["tr", "train", undefined, undefined, undefined, []]]);
});

test("an event goes to the tower of the main's workspace and to the standing main; an ally device's to the head tower", async () => {
	const notices: [string, string, string][] = [], told: [string, string][] = [];
	const run: HerdrRun = async () => JSON.stringify({ result: { workspaces: [{ workspace_id: "w1", label: "one" }, { workspace_id: "w2", label: "two" }] } });
	const towers = { status: () => [{ workspace: "w1" }], head: { status: () => ({ workspace: "wH" }) }, runs: { notice: (ws: string, text: string, key: string) => (notices.push([ws, text, key]), true) } } as never;
	const o = { run, towers: () => towers, tellSession: async (session: string, text: string) => (told.push([session, text]), "delivered") };
	assert.equal(await tellCap({ kind: "quota", key: "s-a", text: "capacity quota · main \"api\"", subject: "s-a", workspace: "w1", standing: "s-st" }, o, 7), true);
	assert.deepEqual(notices, [["w1", "capacity quota · main \"api\"", "capacity:quota:s-a:7"]]);
	assert.deepEqual(told, [["s-st", "capacity quota · main \"api\""]]);
	assert.equal(await tellCap({ kind: "silent", key: "t:d1", text: "silent" }, o, 8), true);
	assert.deepEqual(notices[1]!.slice(0, 1), ["wH"], "no workspace: the head tower");
	assert.equal(await tellCap({ kind: "stale", key: "s-b", text: "x", workspace: "w2" }, { ...o, towers: () => undefined }, 9), false, "no tower service and no standing main: nobody took it");
});
