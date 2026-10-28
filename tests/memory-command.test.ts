import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { memoryLang, type MemoryCmdDeps, parseMemoryArgs, runMemoryCommand } from "../src/memorycmd.ts";
import { memoryParameters } from "../src/memorytool.ts";
import { TOOLS } from "../src/server/runtools.ts";
import type { Slot } from "../src/server/record.ts";
import { addText, addWait, loadMemory, memoryRequest, memoryTool, updateMemory } from "../src/server/towermemory.ts";
import { readQueue } from "../src/server/towerstore.ts";
import { until, World } from "./fakes.ts";
import { TowerWorld } from "./tower-world.ts";

// `/boss memory` (docs/specs/2026-10-26-sb-backend.md, Tower memory): the boss's pi interface to the memory is the first one, and the GUI mirrors it. Every operation (list, confirm or reject a proposal, add, edit, delete,
// resolve) is a request to the same server route the GUI posts to, with the rev it read; the text it prints comes in English and Traditional Chinese. Only boss-typed input reaches it: no tool of a run exposes it.

const NOW = Date.parse("2026-10-28T10:00:00Z");
const slotIn = () => ({ dir: mkdtempSync(join(tmpdir(), "psb-memcmd-")) }) as Slot;
const toolEnv = (slot: Slot) => ({ slot, workspace: "wA", run: "r1", now: () => NOW, bossEvents: () => [{ id: "e1", text: "Standing: ship the beta.67 build to ws01.\nYes." }], session: async (q: string) => ({ id: q, name: q }), log: { line() {}, hide() {} } });

/** The command against a memory file, through the very function the server's route calls; `sent` is what went over. */
function harness(over: { own?: string; lang?: "en" | "zh-TW" } = {}) {
	const slot = slotIn(), told: { text: string; level: string }[] = [], sent: Record<string, unknown>[] = [];
	const deps: MemoryCmdDeps = {
		lang: over.lang ?? "en", own: "own" in over ? over.own : "wA",
		ask: async (workspace, json) => (sent.push(json), { ok: true, ...memoryRequest(slot, workspace, NOW, json) }),
		workspaces: async () => [{ workspace_id: "wA", label: "Alpha" }, { workspace_id: "wB", label: "Beta" }],
		tell: (text, level = "info") => void told.push({ text, level }),
	};
	return { slot, told, sent, run: (args: string, d = deps) => runMemoryCommand(args, d), deps, last: () => told.at(-1)! };
}
const seed = (h: ReturnType<typeof harness>) => updateMemory(h.slot, "wA", NOW, (m) => (addText(m, NOW, "gui", "standing", "Never deploy to production without asking me"), addText(m, NOW, "gui", "decision", "ws01 beta.67 first"), addWait(m, NOW, "r1", { text: "api-fix asks: deploy ws01?", for: "boss" })));
const propose = async (h: ReturnType<typeof harness>, args: Record<string, unknown>) => memoryTool(toolEnv(h.slot), args);

test("the arguments: nothing or list shows the memory; confirm and reject name a proposal; add takes a kind and the text; edit, delete and resolve name an entry; -w picks the workspace", () => {
	assert.deepEqual(parseMemoryArgs(""), { op: "list" });
	assert.deepEqual(parseMemoryArgs("list"), { op: "list" });
	assert.deepEqual(parseMemoryArgs("confirm p3"), { op: "confirm", id: "P3" });
	assert.deepEqual(parseMemoryArgs("reject P12"), { op: "reject", id: "P12" });
	assert.deepEqual(parseMemoryArgs("add standing  Never force push to main. "), { op: "add", kind: "standing", text: "Never force push to main." });
	assert.deepEqual(parseMemoryArgs("add decision 部署等週一"), { op: "add", kind: "decision", text: "部署等週一" });
	assert.deepEqual(parseMemoryArgs("edit S2 new words here"), { op: "edit", id: "S2", text: "new words here" });
	assert.deepEqual(parseMemoryArgs("delete d4"), { op: "delete", id: "D4" });
	assert.deepEqual(parseMemoryArgs("resolve W1"), { op: "resolve", id: "W1" });
	assert.deepEqual(parseMemoryArgs("resolve W1 boss said go"), { op: "resolve", id: "W1", outcome: "boss said go" });
	assert.deepEqual(parseMemoryArgs("-w Beta confirm P1"), { workspace: "Beta", op: "confirm", id: "P1" });
	assert.deepEqual(parseMemoryArgs("-w Beta"), { workspace: "Beta", op: "list" });
	for (const bad of ["confirm", "confirm S1", "confirm P1 P2", "reject D1", "add", "add wait x", "add standing", "edit S2", "edit P1 x", "delete P1", "delete", "resolve D1", "resolve", "-w", "frobnicate", "list extra"]) assert.equal("usage" in parseMemoryArgs(bad), true, bad);
});

test("the words follow the locale: Traditional Chinese for a zh-TW, zh-HK, zh-MO or zh-Hant locale, English otherwise", () => {
	assert.equal(memoryLang({ LANG: "zh_TW.UTF-8" }), "zh-TW");
	assert.equal(memoryLang({ LC_ALL: "zh_HK.UTF-8", LANG: "en_US.UTF-8" }), "zh-TW", "LC_ALL wins");
	assert.equal(memoryLang({ LC_MESSAGES: "zh-Hant-TW" }), "zh-TW");
	assert.equal(memoryLang({ LANG: "en_US.UTF-8" }), "en");
	assert.equal(memoryLang({ LANG: "zh_CN.UTF-8" }), "en");
	assert.equal(memoryLang({}), "en");
});

test("/boss memory lists the memory: proposals first with what they cite, then standing instructions, decisions and waits", async () => {
	const h = harness();
	seed(h);
	await propose(h, { op: "add", kind: "standing", text: "Always run the tests first.", event: "e1" });
	await propose(h, { op: "retire", id: "D1" });
	await h.run("");
	const text = h.last().text;
	assert.equal(h.last().level, "info");
	const rows = text.split("\n");
	assert.match(rows[0]!, /^Memory \(wA\): 1 standing · 1 decisions · 1 waits · 2 proposals to confirm/);
	const at = (id: string) => text.search(new RegExp(`^${id}  ?`, "m"));
	assert.ok(at("P1") < at("S1") && at("S1") < at("D1") && at("D1") < at("W1"), "proposals, standing, decisions, waits");
	assert.match(text, /P1 add standing: Always run the tests first\./);
	assert.match(text, /from your message: Standing: ship the beta\.67 build to ws01\. Yes\./);
	assert.match(text, /P2 retire D1: ws01 beta\.67 first/);
	assert.match(text, /S1 {2}Never deploy to production without asking me/);
	assert.match(text, /W1 {2}for you: api-fix asks: deploy ws01\?/);
	assert.match(text, /\/boss memory confirm P1/, "it says how to answer");
	assert.deepEqual(h.sent, [{ op: "read" }]);
	await h.run("list", { ...h.deps, lang: "zh-TW" });
	assert.match(h.last().text, /^記憶（wA）：1 常駐指示・1 決定・1 等待・2 則待你確認/);
	assert.match(h.last().text, /P1 新增常駐指示：Always run the tests first\./);
	assert.match(h.last().text, /你的訊息：Standing: ship the beta\.67 build to ws01\. Yes\./);
	assert.match(h.last().text, /P2 撤掉 D1：ws01 beta\.67 first/);
	const empty = harness();
	await empty.run("");
	assert.match(empty.last().text, /Nothing is kept\./);
});

test("confirm and reject answer a proposal: the confirm goes to the server's route with the rev just read, and says what became of it", async () => {
	const h = harness();
	seed(h);
	await propose(h, { op: "add", kind: "standing", text: "Always run the tests first." });
	await propose(h, { op: "retire", id: "D1" });
	await propose(h, { op: "add", kind: "decision", text: "beta.67 second" });
	const rev = loadMemory(h.slot, "wA").memory.rev;
	await h.run("confirm P1");
	assert.deepEqual(h.sent, [{ op: "read" }, { op: "confirm", proposal: "P1", rev }]);
	assert.deepEqual([h.last().level, h.last().text], ["info", "P1 confirmed: S2 kept: Always run the tests first."]);
	await h.run("confirm P2");
	assert.equal(h.last().text, "P2 confirmed: D1 retired: ws01 beta.67 first");
	await h.run("reject P3");
	assert.deepEqual(h.sent.at(-1), { op: "reject", proposal: "P3" }, "a reject changes nothing live and takes no rev");
	assert.equal(h.last().text, "P3 rejected.");
	const memory = loadMemory(h.slot, "wA").memory;
	assert.deepEqual([memory.entries.map((e) => e.id), memory.proposals], [["S1", "W1", "S2"], []]);
	await h.run("confirm P9");
	assert.deepEqual([h.last().level, h.last().text], ["error", "No such proposal P9: /boss memory shows the ones that wait"]);
	await h.run("confirm P1", { ...h.deps, lang: "zh-TW" });
	assert.equal(h.last().text, "沒有這則提議 P1：/boss memory 會列出等你確認的");
});

test("add, edit, delete and resolve are the boss's own writes, each with the rev read; a refusal of the server is printed as an error", async () => {
	const h = harness();
	await h.run("add standing Never force push to main.");
	assert.deepEqual(h.sent, [{ op: "read" }, { op: "add", kind: "standing", text: "Never force push to main.", rev: 0 }]);
	assert.equal(h.last().text, "S1 kept: Never force push to main.");
	assert.deepEqual(loadMemory(h.slot, "wA").memory.entries.map((e) => [e.id, e.by, e.via]), [["S1", "boss", "gui"]]);
	await h.run("add decision beta.67 first");
	assert.equal(h.last().text, "D1 kept: beta.67 first");
	await h.run("edit S1 Never force push to main or release.");
	assert.deepEqual(h.sent.at(-1), { op: "edit", id: "S1", text: "Never force push to main or release.", rev: 2 });
	assert.equal(h.last().text, "S1 edited.");
	updateMemory(h.slot, "wA", NOW, (m) => addWait(m, NOW, "r1", { text: "api-fix asks", for: "boss" }));
	await h.run("resolve W1 handled in the terminal");
	assert.deepEqual(h.sent.at(-1), { op: "resolve", id: "W1", outcome: "handled in the terminal", rev: loadMemory(h.slot, "wA").memory.rev - 1 });
	assert.equal(h.last().text, "W1 resolved.");
	await h.run("delete D1");
	assert.equal(h.last().text, "D1 deleted.");
	await h.run("delete D1");
	assert.deepEqual([h.last().level, h.last().text], ["error", "No such entry D1"]);
	updateMemory(h.slot, "wA", NOW, (m) => { for (let n = 2; n <= 12; n++) addText(m, NOW, "gui", "standing", `rule ${n}`); });
	await h.run("add standing one too many");
	assert.equal(h.last().level, "error");
	assert.match(h.last().text, /12 standing instructions are kept already: delete one first/);
	await h.run("edit S1 x", { ...h.deps, lang: "zh-TW" });
	assert.equal(h.last().text, "S1 已改。");
});

test("a bad command prints the usage as a warning and asks the server nothing; an unknown workspace, an ambiguous one, a missing own workspace, and a server with no tower are told plainly", async () => {
	const h = harness();
	await h.run("confirm");
	assert.equal(h.last().level, "warning");
	assert.match(h.last().text, /Usage: \/boss memory/);
	assert.deepEqual(h.sent, []);
	await h.run("-w Nowhere confirm P1");
	assert.deepEqual([h.last().level, h.last().text], ["error", 'No workspace matches "Nowhere". Workspaces: wA (Alpha), wB (Beta)']);
	assert.deepEqual(h.sent, []);
	await h.run("-w Beta confirm P1");
	assert.deepEqual([h.sent, h.last().text], [[{ op: "read" }], "No such proposal P1: /boss memory shows the ones that wait"], "the label picked workspace wB, and an unknown proposal sends no write");
	await h.run("-w wB add decision for beta");
	assert.equal(loadMemory(h.slot, "wB").memory.entries[0]!.text, "for beta");
	const noOwn = harness({ own: undefined });
	await noOwn.run("");
	assert.equal(noOwn.last().level, "error");
	assert.match(noOwn.last().text, /not in a Herdr workspace/);
	const down = { ...h.deps, ask: async () => ({ ok: false, error: "The sb server stands in for no tower of workspace wA" }) };
	await h.run("", down);
	assert.deepEqual([h.last().level, h.last().text], ["error", "No tower memory for wA: The sb server stands in for no tower of workspace wA"]);
});

test("no tool of a run exposes the memory's confirm: tower_memory's ops are add, retire, read, resolve and drop, and no tool is named for a confirm", () => {
	const ops = JSON.stringify(memoryParameters().properties.op);
	for (const op of ["add", "retire", "read", "resolve", "drop"]) assert.ok(ops.includes(`"${op}"`), op);
	for (const op of ["confirm", "reject", "edit", "delete", "undo", "ack", "dismiss"]) assert.ok(!ops.includes(`"${op}"`), op);
	assert.deepEqual(TOOLS.filter((t) => /confirm|reject|memory/.test(t)), ["tower_memory"]);
	assert.equal(Object.keys(memoryParameters().properties).some((k) => /confirm|reject|proposal|rev/.test(k)), false);
});

// --- against the real server: the slash command and the GUI's route are the same server op ------------------------------------------------------------------------------------------------

let sw: TowerWorld, world: World;
beforeEach(() => {
	sw = new TowerWorld();
	sw.setFlag(true);
	world = new World();
	world.stateDir = sw.stateDir;
});
afterEach(async () => {
	await world.stopAll();
	await sw.close();
});
const envOf = () => Object.fromEntries(Object.entries(sw.env).filter((e): e is [string, string] => e[1] !== undefined));

test("/boss memory in a joined pi session reaches the server's memory route: list, confirm, reject, add; and a session of another workspace names its own", async () => {
	const a = world.agent({ id: "a", name: "docs", pane: "wA:p1", tab: "wA:t1", env: envOf(), deps: { server: { ctx: sw.ctx(), cli: "/fake/cli.mjs" } } });
	await a.start();
	await a.command("tower");
	updateMemory(sw.slot, "wA", Date.now(), (m) => addText(m, Date.now(), "gui", "standing", "Never deploy on Friday"));
	await memoryTool({ slot: sw.slot, workspace: "wA", run: "r1", now: () => Date.now(), bossEvents: () => [], session: async (q) => ({ id: q, name: q }), log: { line() {}, hide() {} } }, { op: "add", kind: "decision", text: "beta.67 first" });
	await memoryTool({ slot: sw.slot, workspace: "wA", run: "r1", now: () => Date.now(), bossEvents: () => [], session: async (q) => ({ id: q, name: q }), log: { line() {}, hide() {} } }, { op: "add", kind: "decision", text: "beta.67 second" });
	const said = () => a.notices.map((n) => n.text);
	await a.command("memory");
	assert.match(said().at(-1)!, /Memory \(wA\): 1 standing · 0 decisions · 0 waits · 2 proposals to confirm[\s\S]*P1 add decision: beta\.67 first[\s\S]*S1 {2}Never deploy on Friday/);
	await a.command("memory confirm P1");
	assert.match(said().at(-1)!, /P1 confirmed: D1 kept: beta\.67 first/);
	await a.command("memory reject P2");
	assert.equal(said().at(-1), "P2 rejected.");
	await a.command("memory add standing Always run the tests first.");
	assert.equal(said().at(-1), "S2 kept: Always run the tests first.");
	assert.deepEqual(loadMemory(sw.slot, "wA").memory.entries.map((e) => [e.id, e.text, e.by, e.via]), [["S1", "Never deploy on Friday", "boss", "gui"], ["D1", "beta.67 first", "boss", "proposal"], ["S2", "Always run the tests first.", "boss", "gui"]]);
	assert.equal(loadMemory(sw.slot, "wA").memory.proposals.length, 0);
	assert.equal(a.notices.filter((n) => n.level === "error").length, 0, JSON.stringify(a.notices));
	assert.equal(readQueue(sw.slot, "wA").length, 0, "the command wrote no event to the tower");
	await until(async () => true, "settled");
});
