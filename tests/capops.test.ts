import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { writeEntry } from "../src/board.ts";
import { readBudget } from "../src/capacity.ts";
import type { HerdrRun, Pane, Session } from "../src/herdr.ts";
import { MAIN_CAP_HINT } from "../src/moments.ts";
import { armedLoop, mainFacts, tellCap } from "../src/server/capops.ts";

// The server's side of the capacity watch (src/server/capops.ts): `capacity.budget`, the facts of the live mains, and where an event goes.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => (dirs.push(mkdtempSync(join(tmpdir(), "psb-capops-"))), dirs.at(-1)!);

test("only this main's active unexpired loop holds stale", () => {
	const dir = tmp();
	for (const [status, expiresAt, want] of [["active", 101, true], ["paused", 101, false], ["active", 100, false]] as const) {
		writeFileSync(join(dir, "loops-main.json"), JSON.stringify({ nextId: 2, loops: [{ id: "1", status, expiresAt }] }));
		assert.equal(armedLoop(dir, "main", 100), want);
		assert.equal(armedLoop(dir, "other", 100), false);
	}
});

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
	const facts = mainFacts([s("m1", "p1"), s("st", "p2"), s("tr", "p3"), s("tw", "p4"), s("mb", "p5")], [pane("p1", "main", { agent_session: { value: "/s/m1.jsonl" } as never, agent_status: "working" }), pane("p2", "main", { tokens: { sb_role: "main", sb_duty: "standing" } }), pane("p3", "train"), pane("p4", "tower"), pane("p5", "member")], board, 5000, (file) => (file === "/s/m1.jsonl" ? 4000 : undefined), (id, pane) => pane === "p1" || id === "st");
	assert.deepEqual(facts.filter((m) => m.background).map((m) => m.session), ["m1", "st"], "pane monitor and session watch belong to their own mains");
	assert.deepEqual(facts.map((f) => [f.session, f.role, f.duty, f.fileMtime, f.entryUpdated, f.workers]), [["m1", "main", undefined, 4000, 1000, []], ["st", "main", "standing", undefined, undefined, []], ["tr", "train", undefined, undefined, undefined, []]]);
	assert.deepEqual(facts.map((f) => [f.session, f.paneStatus]), [["m1", "working"], ["st", "idle"], ["tr", "idle"]], "each main's Herdr pane state, which stale reads");
});

test("mainFacts: every running subagent of a main is a worker, not only the first 8 a dashboard shows", () => {
	const d = tmp(), sessions = join(d, "sessions"), parent = "2026-11-24T00-00-00-000Z_main-many", artifacts = join(sessions, "artifacts", "main-many");
	mkdirSync(join(artifacts, "subagent-activity"), { recursive: true });
	mkdirSync(join(artifacts, "subagent-scripts"), { recursive: true });
	for (let i = 0; i < 10; i++) {
		writeFileSync(join(artifacts, "subagent-activity", `kid-${i}.json`), JSON.stringify({ phase: "active" }));
		writeFileSync(join(artifacts, "subagent-scripts", `w${i}-kid-${i}.sh`), "#!/bin/bash\n");
	}
	const s: Session = { id: "m1", name: "m1", status: "idle", herdrLocation: { status: "current", paneId: "p1", workspace: { id: "wA", label: "Alpha" }, tab: { id: "t1", label: "t" } } } as Session;
	const p: Pane = { pane_id: "p1", tab_id: "t1", workspace_id: "wA", agent: "pi", agent_status: "working", tokens: { sb_role: "main" }, agent_session: { value: join(sessions, `${parent}.jsonl`) } as never };
	const kids = Array.from({ length: 10 }, (_, i): Pane => ({ pane_id: `k${i}`, tab_id: "t2", workspace_id: "wA", agent: "pi", agent_status: "working", agent_session: { value: join(sessions, `2026-11-24T00-00-00-000Z_kid-${i}.jsonl`) } as never }));
	const [facts] = mainFacts([s], [p, ...kids], join(d, "board"), Date.now(), () => undefined);
	assert.equal(facts!.workers.length, 10);
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

test("an under or stale event also goes to its main's own session, once when that main is the standing main told", async () => {
	const told: [string, string][] = [];
	const run: HerdrRun = async () => JSON.stringify({ result: { workspaces: [] } });
	const o = { run, towers: () => undefined, tellSession: async (session: string, text: string) => (told.push([session, text]), session === "gone" ? "failed" : "queued") };
	assert.equal(await tellCap({ kind: "under", key: "s-a", text: "u", subject: "s-a", workspace: "w1", standing: "s-st", main: "s-a" }, o, 1), true);
	// The main's own copy carries the rule for the moment (docs/specs/2026-11-26-just-in-time-prompts.md), which main.md no longer holds.
	assert.deepEqual(told, [["s-st", "u"], ["s-a", `u${MAIN_CAP_HINT}`]]);
	assert.match(MAIN_CAP_HINT, /dispatch its ready work now, or say why not \(blocked, shared files, the boss\) on your board/);
	assert.equal(await tellCap({ kind: "under", key: "s-st", text: "v", subject: "s-st", workspace: "w0", standing: "s-st", main: "s-st" }, o, 2), true);
	assert.deepEqual(told.slice(2), [["s-st", `v${MAIN_CAP_HINT}`]], "the standing main is told once, as the main whose work it is");
	assert.equal(await tellCap({ kind: "stale", key: "gone", text: "w", subject: "gone", workspace: "w2", main: "gone" }, o, 3), false, "the main alone did not take it");
});
