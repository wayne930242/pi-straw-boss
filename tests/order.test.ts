import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, mock, test } from "node:test";
import { ARROW, descendants, MARK, markKids, netTokens, orderKey } from "../src/order.ts";
import type { HerdrTab, Pane, Workspace } from "../src/herdr.ts";
import { settle, until, World } from "./fakes.ts";

let world = new World();
afterEach(async () => {
	mock.timers.reset();
	await world.stopAll();
	world = new World();
});
const scratch = mkdtempSync(join(tmpdir(), "psb-order-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

const ws = (id: string, linked = false): Workspace => ({ workspace_id: id, label: id, tokens: {}, worktree: linked ? { is_linked_worktree: true, repo_key: "/r/alpha" } : undefined });
const pane = (id: string, tab: string, extra: Partial<Pane> = {}): Pane => ({ pane_id: id, tab_id: tab, workspace_id: tab.split(":")[0], agent: "pi", ...extra });
const tab = (id: string): HerdrTab => ({ tab_id: id, workspace_id: id.split(":")[0]! });
const byKey = (keys: Record<string, string | undefined>) => Object.entries(keys).filter(([, key]) => key).sort(([, a], [, b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)).map(([name]) => name);

test("keys put the head tower's workspace first, then its tower, its tabs in order, each tab's main before its members, then the other workspaces", () => {
	// A sub workspace (a linked worktree) listed first does not count: the head tower's workspace is the first base one.
	const all = [ws("wS", true), ws("wA"), ws("wB")];
	const ps = [
		pane("A-tower", "wA:t0"), pane("A-member", "wA:t1"), pane("A-main", "wA:t1"), pane("A-tab2", "wA:t2"),
		pane("B-tower", "wB:t0"), pane("B-main", "wB:t1"), pane("S-pane", "wS:t1"),
	];
	const tabsA = ["wA:t0", "wA:t1", "wA:t2"].map(tab), tabsB = ["wB:t0", "wB:t1"].map(tab);
	const keys = {
		"A-tower": orderKey("tower", ps[0]!, ps, all, tabsA),
		"A-member": orderKey("member", ps[1]!, ps, all, tabsA),
		"A-main": orderKey("main", ps[2]!, ps, all, tabsA),
		"A-tab2": orderKey("main", ps[3]!, ps, all, tabsA),
		"B-tower": orderKey("tower", ps[4]!, ps, all, tabsB),
		"B-main": orderKey("main", ps[5]!, ps, all, tabsB),
	};
	assert.deepEqual(keys, {
		"A-tower": "000.0", "A-member": "000.1.001.1.000", "A-main": "000.1.001.0.001", "A-tab2": "000.1.002.0.000",
		"B-tower": "001.0", "B-main": "001.1.001.0.000",
	});
	assert.deepEqual(byKey(keys), ["A-tower", "A-main", "A-member", "A-tab2", "B-tower", "B-main"], "the main sits before the member that has the lower slot");
	assert.equal(orderKey("main", ps[6]!, ps, all, [tab("wS:t1")]), undefined, "a session Herdr cannot place in a base workspace has no key");
	assert.equal(orderKey("member", pane("lost", "wA:t9"), [...ps, pane("lost", "wA:t9")], all, tabsA), undefined, "nor one whose tab is not listed");
});

test("segments are fixed-width, so tab ten and slot ten sort after tab two and slot nine as plain strings", () => {
	const tabs = Array.from({ length: 12 }, (_, i) => tab(`wA:t${i}`));
	const all = [ws("wA")];
	const ps = Array.from({ length: 12 }, (_, i) => pane(`slot${i}`, "wA:t2")).concat(pane("tab10", "wA:t10"), pane("tab2", "wA:t2", { pane_id: "tab2" }));
	const keys = Object.fromEntries(ps.map((p) => [p.pane_id, orderKey("member", p, ps, all, tabs)]));
	assert.deepEqual(byKey(keys), ["slot0", "slot1", "slot2", "slot3", "slot4", "slot5", "slot6", "slot7", "slot8", "slot9", "slot10", "slot11", "tab2", "tab10"]);
});

/** Lays out the artifacts pi-herdr-agents writes for a session file named `<timestamp>_<id>.jsonl`, and returns that file. */
function launch(id: string, children: { id: string; name: string }[]): string {
	const dir = join(scratch, "sessions", "artifacts", id, "subagent-activity");
	mkdirSync(dir, { recursive: true });
	for (const child of children) writeFileSync(join(dir, `${child.id}.json`), JSON.stringify({ phase: "active" }));
	return join(scratch, "sessions", `2026-10-18T00-00-00-000Z_${id}.jsonl`);
}
const kidFile = (id: string) => join(scratch, "sessions", `2026-10-18T00-00-01-000Z_${id}-1a2b3c4d-5e6f7a8b-9c0d.jsonl`);
const kidPane = (paneId: string, tab: string, id: string, label: string) => pane(paneId, tab, { agent_status: "working", label, agent_session: { value: kidFile(id) } });

test("a subagent's key is its launcher's key plus one segment, so it sorts right after the launcher and before the launcher's next sibling, wherever its pane runs", () => {
	const file = launch("parent-1", [{ id: "kid-a", name: "aaa" }, { id: "kid-b", name: "bbb" }, { id: "kid-gone", name: "zzz" }]);
	const grand = launch("kid-a-1a2b3c4d-5e6f7a8b-9c0d", [{ id: "grand", name: "ggg" }]);
	assert.ok(grand.includes("kid-a-1a2b3c4d-5e6f7a8b-9c0d"));
	const parent = pane("wA:p1", "wA:t1", { agent_session: { value: file } });
	const sibling = pane("wA:p2", "wA:t1");
	const ps = [
		parent, sibling,
		kidPane("wS:p1", "wS:t1", "kid-a", "aaa"), // a worktree sub workspace
		kidPane("wA:p20", "wA:t1", "kid-b", "bbb"),
		kidPane("wS:p2", "wS:t1", "grand", "ggg"),
	];
	const kids = descendants(parent, "000.1.001.0.000", "Parent session", ps, Date.now());
	assert.deepEqual(kids, [
		{ pane: "wS:p1", order: "000.1.001.0.000.000", mark: `${ARROW} Parent session` },
		{ pane: "wS:p2", order: "000.1.001.0.000.000.000", mark: `${ARROW} aaa` },
		{ pane: "wA:p20", order: "000.1.001.0.000.001", mark: `${ARROW} Parent session` },
	], "the finished subagent has no pane and gets nothing, a subagent's own subagent hangs under it");
	const order = byKey({ parent: "000.1.001.0.000", sibling: "000.1.001.1.001", ...Object.fromEntries(kids.map((k) => [k.pane, k.order])) });
	assert.deepEqual(order, ["parent", "wS:p1", "wS:p2", "wA:p20", "sibling"]);
});

/** A chain of `levels` subagents, each launched by the one before; pane `p0` is the session at the top. */
function chain(levels: number): Pane[] {
	const ids = Array.from({ length: levels }, (_, i) => `c${i + 1}`);
	const ps = [pane("p0", "wA:t1", { agent_session: { value: launch("chain-0", [{ id: "c1", name: "c1" }]) } })];
	for (const [i, id] of ids.entries()) {
		ps.push(pane(`p${i + 1}`, "wA:t1", { agent_status: "working", label: id, agent_session: { value: kidFile(id) } }));
		if (i + 1 < levels) launch(`${id}-1a2b3c4d-5e6f7a8b-9c0d`, [{ id: ids[i + 1]!, name: ids[i + 1]! }]);
	}
	return ps;
}

test("nesting is followed at any depth, and a long launcher name is cut to fit the sidebar", () => {
	const ps = chain(8);
	const kids = descendants(ps[0], "000.0", "x".repeat(40), ps, Date.now());
	assert.deepEqual(kids.map((k) => k.pane), ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
	assert.deepEqual(kids.map((k) => k.order), Array.from({ length: 8 }, (_, i) => `000.0${".000".repeat(i + 1)}`));
	assert.deepEqual(byKey(Object.fromEntries(kids.map((k) => [k.pane, k.order]))), kids.map((k) => k.pane), "each level sorts after the one that launched it");
	assert.equal(kids[0]!.mark, `${ARROW} ${"x".repeat(23)}…`);
	assert.equal(kids[1]!.mark, `${ARROW} c1`, "a nested subagent names its own launcher");
	assert.deepEqual(descendants(undefined, "000.0", "x", [], 0), []);
});

test("every live subagent gets a key, past the eight the dashboard lists, so none sorts outside its launcher's span; a launch record that leads back to the launcher is ignored", () => {
	const names = Array.from({ length: 12 }, (_, i) => `k${String(i).padStart(2, "0")}`);
	const file = launch("crowd", names.map((name) => ({ id: name, name })));
	const parent = pane("p0", "wA:t1", { agent_session: { value: file } });
	const ps = [parent, ...names.map((name, i) => kidPane(`kid${i}`, "wA:t1", name, name))];
	const kids = descendants(parent, "000.0", "Crowd", ps, Date.now());
	assert.deepEqual(kids.map((k) => k.pane), names.map((_, i) => `kid${i}`));
	assert.deepEqual(kids.map((k) => k.order.slice(-4)), names.map((_, i) => `.${String(i).padStart(3, "0")}`));
	assert.deepEqual(byKey(Object.fromEntries(kids.map((k) => [k.pane, k.order]))), kids.map((k) => k.pane), "string order is launch order");

	// The first subagent's launch records name a child whose session file is the launcher's own, a cycle that must neither loop nor mark the launcher.
	launch("k00-1a2b3c4d-5e6f7a8b-9c0d", [{ id: "crowd", name: "crowd" }]);
	assert.deepEqual(descendants(parent, "000.0", "Crowd", [parent, kidPane("kid0", "wA:t1", "k00", "k00")], Date.now()).map((k) => k.pane), ["kid0"]);
});

test("netTokens reads Herdr for a session's own tokens (a tower has no mark) and its subagents'; markKids writes them and clears the panes it no longer marks", async () => {
	world.herdr.workspaces.unshift({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "child", "wS:p1");
	world.herdr.addPane("wA:p1", "wA:t1").agent_session = { value: launch("parent-2", [{ id: "kid-a", name: "aaa" }]) };
	Object.assign(world.herdr.pane("wS:p1"), { agent_status: "working", label: "aaa", agent_session: { value: kidFile("kid-a") } });
	const run = world.herdr.runFor("wA:p1"), place = { paneId: "wA:p1", tabId: "wA:t1", workspaceId: "wA" };

	const main = await netTokens(run, place, "main", "Main");
	assert.equal(MARK.main, "\uf005", "a main agent is marked by the star alone");
	assert.equal(ARROW, "[subagent]", "a subagent is tagged in words, then its launcher");
	assert.deepEqual(main, { own: { sb_order: "000.1.000.0.000", sb_mark: MARK.main }, kids: [{ pane: "wS:p1", order: "000.1.000.0.000.000", mark: `${ARROW} Main` }], joined: new Set() });
	assert.deepEqual((await netTokens(run, place, "tower", "Main")).own, { sb_order: "000.0", sb_mark: null }, "a tower's tab already carries the glyph");
	assert.deepEqual((await netTokens(run, { ...place, paneId: "wA:p99" }, "member", "Main")).own, { sb_order: null, sb_mark: MARK.member }, "a pane Herdr does not list has no key");

	const marked = await markKids(run, main.kids, new Set(["wS:old"]));
	assert.deepEqual([...marked], ["wS:p1"]);
	assert.deepEqual(world.herdr.pane("wS:p1").tokens, { sb_order: "000.1.000.0.000.000", sb_mark: `${ARROW} Main` });
	world.herdr.addPane("wS:old", "wS:t1").tokens = { sb_order: "x", sb_mark: "y" };
	await markKids(run, [], new Set(["wS:old", "wS:gone"])); // a pane that already closed is no error
	assert.deepEqual(world.herdr.pane("wS:old").tokens, {});
});

/** A main agent in wA:t1 whose subagent runs in a worktree sub workspace; the main has published, so both carry tokens. */
async function launcher() {
	world.herdr.workspaces.unshift({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "child", "wS:p1");
	const a = world.agent({ id: "a", name: "Solo", pane: "wA:p1", tab: "wA:t1" });
	world.herdr.pane("wA:p1").agent_session = { value: launch("a", [{ id: "kid-a", name: "aaa" }]) };
	Object.assign(world.herdr.pane("wS:p1"), { agent: "pi", agent_status: "working", label: "aaa", agent_session: { value: kidFile("kid-a") } });
	await a.start();
	await a.promote();
	return { a, raw: (id: string) => world.herdr.pane(id).tokens };
}

test("markKids leaves a pane alone when it has joined the net since it ran a subagent: its tokens are its own now", async () => {
	world.herdr.addPane("wA:p1", "wA:t1");
	world.herdr.addPane("wA:p9", "wA:t1").tokens = { sb_role: "member", sb_order: "000.1.000.1.001", sb_mark: MARK.member };
	world.herdr.addPane("wA:p8", "wA:t1").tokens = { sb_order: "000.1.000.0.000.000", sb_mark: `${ARROW} Main` };
	const run = world.herdr.runFor("wA:p1");
	await markKids(run, [], new Set(["wA:p9", "wA:p8"]), new Set(["wA:p9"]));
	assert.deepEqual(world.herdr.pane("wA:p9").tokens, { sb_role: "member", sb_order: "000.1.000.1.001", sb_mark: MARK.member });
	assert.deepEqual(world.herdr.pane("wA:p8").tokens, {}, "a pane that is still no more than a former subagent is cleared");
	assert.deepEqual((await netTokens(run, { paneId: "wA:p1", tabId: "wA:t1", workspaceId: "wA" }, "member", "x")).joined, new Set(["wA:p9"]));
});

test("a session publishes its key and mark with its role, rewrites them when it is promoted, and the subagents it launched get theirs on the 4 minute refresh", async () => {
	mock.timers.enable({ apis: ["setInterval"] });
	world.herdr.workspaces.unshift({ workspace_id: "wS", label: "Alpha feature", tokens: {}, worktree: { is_linked_worktree: true, repo_key: "/r/alpha" } });
	world.herdr.addTab("wS:t1", "child", "wS:p1");
	const tower = world.tower("tower-wA", "wA:t7", "wA:p7");
	await tower.start();
	const a = world.agent({ id: "a", name: "Solo", pane: "wA:p1", tab: "wA:t1" });
	const b = world.agent({ id: "b", name: "Other", pane: "wA:p2", tab: "wA:t1" });
	const c = world.agent({ id: "c", name: "Docs", pane: "wA:p3", tab: "wA:t2" });
	world.herdr.pane("wA:p1").agent_session = { value: launch("a", [{ id: "kid-a", name: "aaa" }]) };
	await Promise.all([a.start(), b.start(), c.start()]);
	const raw = (id: string) => world.herdr.pane(id).tokens;
	await until(() => raw("wA:p3").sb_order, "every session's key");
	assert.deepEqual(raw("wA:p7"), { sb_role: "tower", sb_order: "000.0" }, "the tower: first, and no mark");
	assert.deepEqual(raw("wA:p1"), { sb_role: "member", sb_order: "000.1.000.1.000", sb_mark: MARK.member });
	assert.deepEqual(raw("wA:p3"), { sb_role: "member", sb_order: "000.1.001.1.000", sb_mark: MARK.member });
	assert.equal(raw("wS:p1").sb_order, undefined, "a subagent is marked only once its pane runs it");

	Object.assign(world.herdr.pane("wS:p1"), { agent: "pi", agent_status: "working", label: "aaa", agent_session: { value: kidFile("kid-a") } });
	await a.promote();
	assert.deepEqual(raw("wA:p1"), { sb_role: "main", sb_order: "000.1.000.0.000", sb_mark: MARK.main }, "promotion rewrites both");
	assert.deepEqual(raw("wS:p1"), { sb_order: "000.1.000.0.000.000", sb_mark: `${ARROW} Solo` }, "the subagent in the worktree workspace hangs under its launcher");
	assert.deepEqual(byKey(Object.fromEntries(["wA:p7", "wA:p1", "wS:p1", "wA:p2", "wA:p3"].map((id) => [id, raw(id).sb_order]))), ["wA:p7", "wA:p1", "wS:p1", "wA:p2", "wA:p3"]);

	// The subagent finishes: its pane is back at a shell, and the next refresh takes its tokens away.
	world.herdr.pane("wS:p1").agent = undefined;
	world.herdr.calls.length = 0;
	mock.timers.tick(4 * 60_000);
	await settle();
	assert.deepEqual(raw("wS:p1"), {});
	assert.ok(world.herdr.commands("pane", "report-metadata").some((args) => args.includes("--ttl-ms")), "tokens still carry the TTL");

	await a.fire("session_shutdown");
	assert.deepEqual(raw("wA:p1"), {}, "shutdown clears the role, the key and the mark");
});

test("a refresh that cannot read Herdr keeps the subagents' tokens instead of clearing them", async () => {
	mock.timers.enable({ apis: ["setInterval"] });
	const { raw } = await launcher();
	const marked = { sb_order: "000.1.000.0.000.000", sb_mark: `${ARROW} Solo` };
	assert.deepEqual(raw("wS:p1"), marked);
	world.herdr.failReads = true;
	mock.timers.tick(4 * 60_000);
	await settle();
	assert.deepEqual(raw("wS:p1"), marked, "the subagent keeps its place until a refresh can say it is gone");
	assert.equal(raw("wA:p1").sb_role, "main");
	world.herdr.failReads = false;
	mock.timers.tick(4 * 60_000);
	await settle();
	assert.deepEqual(raw("wS:p1"), marked);
});

test("shutdown waits for a publish in flight, so no token is written after it clears them", async () => {
	mock.timers.enable({ apis: ["setInterval"] });
	const { a, raw } = await launcher();
	mock.timers.tick(4 * 60_000); // a refresh starts, and has not finished
	await a.fire("session_shutdown");
	await settle();
	assert.deepEqual([raw("wA:p1"), raw("wS:p1")], [{}, {}]);
});

test("a refresh already running when the session shuts down writes no token after the clear", async () => {
	const { a, raw } = await launcher();
	const b = world.agent({ id: "b", name: "Other", pane: "wA:p2", tab: "wA:t1" });
	await b.start();
	await settle();
	world.broker.disconnect(b); // a's channel hears session_left and starts a refresh
	await a.fire("session_shutdown");
	await settle();
	assert.deepEqual([raw("wA:p1"), raw("wS:p1")], [{}, {}]);
});
