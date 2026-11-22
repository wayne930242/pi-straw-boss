import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { World } from "./fakes.ts";
import { readLedger, updateLedger } from "../src/revive.ts";
import { recordPath } from "../src/roles.ts";
import { ENTRY } from "../src/state.ts";
import { noteSignal } from "../src/signalseen.ts";

// The tower's revive of a dead main (docs/specs/2026-11-23-tower-revive.md §4, §5): a crash leaves a role record with no `ended` mark, its board entry, and its session file, and no pane; the tower's
// boss_revive_main brings the same session back in a new tab as the same identity, or refuses with the reason and opens nothing.

let world = new World();
afterEach(async () => {
	noteSignal(undefined);
	await world.stopAll();
	world = new World();
});
const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((c) => c.text).join("");
const DEAD = "a1b2c3d4-0000-4000-8000-00000000d1ad";

/** A computer with a tower in wA and pi's sessions folder of its own; the workspace's checkout is a real folder, as a revived session's working folder must be inside it. */
async function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "psb-revive-")));
	const agentDir = join(root, "agent"), checkout = join(root, "alpha");
	mkdirSync(checkout, { recursive: true });
	world.herdr.workspaces[0]!.worktree = { checkout_path: checkout };
	const env = { PI_CODING_AGENT_DIR: agentDir };
	world.herdr.addTab("wA:t7", "🗼 tower", undefined);
	world.herdr.addPane("wA:p7", "wA:t7");
	const tower = world.agent({ id: "tower-wA", name: "tower · wA", pane: "wA:p7", tab: "wA:t7", env: { STRAW_BOSS_ROLE: "tower", ...env } });
	await tower.start();
	const sender = world.agent({ id: "sender-1", name: "docs-main", pane: "wA:p1", tab: "wA:t1" });
	await sender.start();
	await sender.promote();
	return { root, agentDir, checkout, env, tower, sender };
}
type Setup = Awaited<ReturnType<typeof setup>>;
/** What a crash of a main leaves behind: its session file (header, name, sb entries), its role record without `ended`, and its board entry; no pane runs it and the broker does not list it. */
function crashed(w: Setup, o: { id?: string; name?: string; record?: Record<string, unknown>; entries?: Record<string, unknown>[]; cwd?: string; ageMs?: number; file?: string } = {}) {
	const id = o.id ?? DEAD, dir = join(w.agentDir, "sessions", "--alpha--");
	mkdirSync(dir, { recursive: true });
	const file = o.file ?? join(dir, `2026-11-23T00-14-00-000Z_${id}.jsonl`);
	const rows = [{ type: "session", version: 3, id, timestamp: "2026-11-23T00:14:00.000Z", cwd: o.cwd ?? w.checkout }, { type: "session_info", name: o.name ?? "dnd main" }, ...(o.entries ?? []).map((data) => ({ type: "custom", customType: ENTRY, data }))];
	writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
	const at = Date.now() - (o.ageMs ?? 5 * 60_000);
	mkdirSync(join(world.stateDir, "roles"), { recursive: true });
	writeFileSync(recordPath(world.stateDir, file), JSON.stringify({ role: "main", pane: "wA:p40", tab: "wA:t40", workspace: "wA", terminal: "term-old", file, at, ...o.record }));
	mkdirSync(join(world.stateDir, "board"), { recursive: true });
	writeFileSync(join(world.stateDir, "board", `${id}.json`), JSON.stringify({ v: 1, session: id, updated: at, src: "set", now: "wiring the character sheet", items: [] }));
	// The file has not moved for a while: no live pi writes it.
	utimesSync(file, at / 1000, at / 1000);
	return file;
}
/** `herdr agent start ... -- --session <file>` starts that session again: the revived pi has the dead id, its file, and its entries. */
function revives(w: Setup, entries: Record<string, unknown>[] = [], name = "dnd main") {
	const started: string[][] = [];
	world.herdr.onAgentStart = (pane, args) => {
		started.push(args);
		const file = args[args.indexOf("--session") + 1]!;
		const id = /_([0-9a-f-]+)\.jsonl$/.exec(file)![1]!;
		const role = pane.env?.find((e) => e.startsWith("STRAW_BOSS_ROLE="))?.slice(16) ?? "";
		const a = world.agent({ id, name, pane: pane.pane_id, env: { STRAW_BOSS_ROLE: role, ...w.env }, entries: entries.map((data) => ({ customType: ENTRY, data })) });
		a.file = file;
		void a.start();
	};
	return started;
}
const NEW = { tab: "wA:t100", pane: "wA:p101" };

test("a tower revives a crashed main: a new tab with the main's role, the opener's mark, the one-time claim and the revive token; pi --session with no --name; the same id joins as the tab's main with its kind, gets the handoff, and the ledger says so", async () => {
	const w = await setup();
	const file = crashed(w, { record: { openedBy: "sender-1" }, entries: [{ duty: "standing", dutyFrom: null, dutyWhy: "mind the box", dutyAt: 1 }] });
	const started = revives(w, [{ duty: "standing", dutyFrom: null, dutyWhy: "mind the box", dutyAt: 1 }]);
	const listed = await w.tower.tool("boss_revive_main", { action: "list" });
	assert.match(textOf(listed), /main "dnd main" \(session a1b2c3d4, kind standing, tab wA:t40, opened by sender-1\): dead: it ended with no shutdown/);
	assert.match(textOf(listed), /board: wiring the character sheet/);
	const result = await w.tower.tool("boss_revive_main", { action: "revive", session: "dnd main", reason: "its watch is not done" });
	assert.deepEqual(world.herdr.commands("tab", "create"), [["tab", "create", "--workspace", "wA", "--label", "dnd main", "--cwd", w.checkout, "--no-focus", "--env", "STRAW_BOSS_ROLE=main"]]);
	assert.equal(started.length, 1);
	assert.deepEqual(started[0]!.slice(-2), ["--session", file], "pi resumes the session file, and gets no --name: pi restores its own");
	assert.ok(!started[0]!.includes("--name"));
	const report = world.herdr.calls.find((c) => c[1] === "report-metadata" && c[2] === NEW.pane && c.includes("sb_open_main=1"))!;
	assert.ok(report.includes("sb_opened_by=sender-1"), "the opener's mark comes back: the tower closes it and counts it as before");
	assert.ok(report.some((a) => a.startsWith("sb_revive=")), "the revive token tells the pi it was revived");
	const revived = world.agents.find((a) => a.id === DEAD)!;
	assert.equal(revived.tokens.sb_role, "main", "it joined as the tab's main");
	assert.equal(world.herdr.pane(NEW.pane).tokens.sb_duty, "standing", "with its kind");
	assert.equal(revived.tokens.sb_opened_by, "sender-1");
	assert.equal(revived.tokens.sb_revive, undefined, "the claim consumed the revive token");
	assert.ok(revived.entries.some((e) => typeof (e.data as { revived?: unknown }).revived === "number"), "the session records that it was revived");
	const handoff = world.broker.delivered.filter((d) => d.to === DEAD);
	assert.equal(handoff.length, 1);
	assert.match(handoff[0]!.message, /this session ended with no shutdown .* without a close\. Tower tower · wA \(session tower-wA\) revived it in tab wA:t100 of workspace Alpha; its reason: its watch is not done\./s);
	assert.match(handoff[0]!.message, /Recreate the monitors, loops, and watches/);
	assert.match(handoff[0]!.message, /Tell sender-1 \(the session that asked for your work\) that you are back/);
	assert.match(textOf(result), /Revived main dnd main \(session a1b2c3d4-.*\) in tab wA:t100 as the same session, kind standing, and handed it what it held/);
	const ledger = readLedger(world.stateDir, file);
	assert.deepEqual(ledger.attempts.map((a) => [a.outcome, a.by, a.tab]), [["revived", "tower-wA", NEW.tab]]);
	// The record is the revived main's now: its new pane and tab, no `ended` mark.
	const record = JSON.parse(readFileSync(recordPath(world.stateDir, file), "utf8"));
	assert.deepEqual([record.role, record.pane, record.tab, record.openedBy, record.duty, record.ended], ["main", NEW.pane, NEW.tab, "sender-1", "standing", undefined]);
	// The board row is the same session's: board_read shows it live, with its kind.
	const board = (await w.sender.tool("board_read", { scope: "local" })).details as { local: { main: string; kind?: string; now?: string; state: string }[] };
	const row = board.local.find((r) => r.main === "dnd main");
	assert.notEqual(row?.state, "ended", "the row is live again");
	assert.equal(row?.now, "wiring the character sheet");
	assert.equal(row?.kind, "standing");
});

test("a second try of one death is refused, and so is a revive while the revived main runs", async () => {
	const w = await setup();
	crashed(w, { record: { openedBy: "sender-1" } });
	revives(w);
	await w.tower.tool("boss_revive_main", { action: "revive", session: DEAD, reason: "first" });
	await assert.rejects(w.tower.tool("boss_revive_main", { action: "revive", session: DEAD.slice(0, 8), reason: "again" }), /Not revived: it is live: (a pane runs its session file|the broker lists its session)/);
	assert.equal(world.herdr.commands("tab", "create").length, 1);
});

test("each refusal names its reason and creates nothing: a member, a tower, a mark of a quit is no death, a link-opened main, a live holder, a bad path, a subagent file, the sender's cap, a live integrator, a tried death, the crash-loop guard", async () => {
	const w = await setup();
	revives(w);
	const refused = async (query: string, reason: RegExp) => {
		await assert.rejects(w.tower.tool("boss_revive_main", { action: "revive", session: query, reason: "try" }), reason);
		assert.equal(world.herdr.commands("tab", "create").length, 0, String(reason));
	};
	// A member has no record.
	await refused("someone-else", /A member has no role record and holds nothing a tower restores: resume it with pi --session/);
	// A tower comes back by itself: its record is not a candidate.
	crashed(w, { id: "b0000000-0000-4000-8000-000000000001", name: "old tower", record: { role: "tower" } });
	await refused("old tower", /A member has no role record/);
	// Opened for a teammate's device.
	crashed(w, { id: "b0000000-0000-4000-8000-000000000002", name: "peer main", record: { openedBy: "link:DEVICE01" } });
	await refused("peer main", /opened for a teammate's device \(link:DEVICE01\): its route has lapsed/);
	// A live holder: a pane runs the file.
	const held = crashed(w, { id: "b0000000-0000-4000-8000-000000000003", name: "held main" });
	world.herdr.addPane("wA:p60", "wA:t60", "pi").agent_session = { value: held };
	await refused("held main", /it is live: a pane runs its session file/);
	// A session file outside pi's sessions folder (a forged record).
	const outside = join(w.root, "elsewhere");
	mkdirSync(outside, { recursive: true });
	crashed(w, { id: "b0000000-0000-4000-8000-000000000004", name: "outside main", file: join(outside, "2026-11-23T00-14-00-000Z_b0000000-0000-4000-8000-000000000004.jsonl") });
	await refused("outside main", /it is invalid: its session file is outside pi's sessions folder/);
	// A link to a file.
	const real = crashed(w, { id: "b0000000-0000-4000-8000-000000000005", name: "linked main" });
	const link = join(w.agentDir, "sessions", "--alpha--", "2026-11-23T00-15-00-000Z_b0000000-0000-4000-8000-000000000006.jsonl");
	symlinkSync(real, link);
	writeFileSync(recordPath(world.stateDir, link), JSON.stringify({ role: "main", pane: "wA:p41", tab: "wA:t41", workspace: "wA", file: link, at: Date.now() - 600_000 }));
	await refused("b0000000-0000-4000-8000-000000000006", /no regular file/);
	// A subagent's session file.
	const sub = crashed(w, { id: "b0000000-0000-4000-8000-000000000007", name: "sub run" });
	writeFileSync(`${sub}.pi-herdr-subagent-policy.json`, "{}");
	await refused("sub run", /a subagent's \(it has pi-herdr-agents' policy sidecar\)/);
	// A working folder outside the checkout.
	crashed(w, { id: "b0000000-0000-4000-8000-000000000008", name: "far main", cwd: w.root });
	await refused("far main", /its working folder .* is outside the workspace's checkout/);
	// A quit is listed, and revived only when a request names it: the tool takes it.
	// The sender already has another opened main.
	crashed(w, { id: "b0000000-0000-4000-8000-000000000009", name: "capped main", record: { openedBy: "sender-1" } });
	world.herdr.addPane("wA:p70", "wA:t70", "pi").tokens = { sb_role: "main", sb_opened_by: "sender-1" };
	await refused("capped main", /its sender sender-1 already has an opened main running .*: close one first/);
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== "wA:p70");
	// A project with a live integrator.
	crashed(w, { id: "b0000000-0000-4000-8000-00000000000a", name: "integ skald", record: { openedBy: "integ:skald" } });
	world.herdr.addPane("wA:p71", "wA:t71", "pi").tokens = { sb_role: "main", sb_duty: "integrator", sb_opened_by: "integ:skald" };
	await refused("integ skald", /project skald has a live integrator \(pane wA:p71\); a project has one/);
	world.herdr.panes = world.herdr.panes.filter((p) => p.pane_id !== "wA:p71");
	// A death already tried, and the crash-loop guard.
	const tried = crashed(w, { id: "b0000000-0000-4000-8000-00000000000b", name: "tried main" });
	const { deathKey } = await import("../src/revive.ts");
	updateLedger(world.stateDir, tried, Date.now(), (l) => void l.attempts.push({ at: Date.now() - 1000, key: deathKey(tried)!, by: "tower-wA", outcome: "failed", error: "did not join" }));
	await refused("tried main", /this death was already tried at .* \(failed: did not join\); a tower tries each death once/);
	const looping = crashed(w, { id: "b0000000-0000-4000-8000-00000000000c", name: "loop main" });
	updateLedger(world.stateDir, looping, Date.now(), (l) => void l.attempts.push({ at: Date.now() - 3 * 3600_000, key: "k1", by: "tower-wA", outcome: "revived" }, { at: Date.now() - 3600_000, key: "k2", by: "tower-wA", outcome: "revived" }));
	await refused("loop main", /revived 2 times in the last 24 h \(the limit is 2\)/);
	// Another workspace's main is its own tower's.
	crashed(w, { id: "b0000000-0000-4000-8000-00000000000d", name: "beta main", record: { workspace: "wB" } });
	await refused("beta main", /it is a session of workspace wB; that workspace's tower revives it/);
});

test("a main that quit is listed as quit; a revive is still the run's call when a request names it", async () => {
	const w = await setup();
	crashed(w, { record: { ended: { at: Date.now() - 60_000, reason: "quit" } } });
	revives(w);
	assert.match(textOf(await w.tower.tool("boss_revive_main", { action: "list" })), /quit: it quit \(quit\)/);
	await w.tower.tool("boss_revive_main", { action: "revive", session: DEAD, reason: "the sender asked for it by name" });
	assert.equal(world.herdr.commands("tab", "create").length, 1);
});

test("D3: the old tab closes when the tower opened it and its one pane is the dead pane at a bare shell, and stays otherwise", async () => {
	const w = await setup();
	world.herdr.shellPids = true;
	revives(w);
	// Tower-opened, one pane, a bare shell: closed.
	crashed(w, { record: { openedBy: "sender-1" } });
	world.herdr.addPane("wA:p40", "wA:t40");
	const first = await w.tower.tool("boss_revive_main", { action: "revive", session: DEAD, reason: "back" });
	assert.equal((first.details as { closedOld?: string }).closedOld, "wA:t40");
	assert.ok(world.herdr.commands("tab", "close").some((c) => c[2] === "wA:t40"));
	// The boss opened it: its old tab stays.
	crashed(w, { id: "c0000000-0000-4000-8000-000000000001", name: "boss main", record: { tab: "wA:t41", pane: "wA:p41" } });
	world.herdr.addPane("wA:p41", "wA:t41");
	const second = await w.tower.tool("boss_revive_main", { action: "revive", session: "boss main", reason: "back" });
	assert.equal((second.details as { closedOld?: string }).closedOld, undefined);
	// Tower-opened, but something runs in the old pane: it stays.
	crashed(w, { id: "c0000000-0000-4000-8000-000000000002", name: "busy main", record: { openedBy: "sender-2", tab: "wA:t42", pane: "wA:p42" } });
	world.herdr.addPane("wA:p42", "wA:t42").processes = [{ pid: 77, name: "vim", argv0: "vim", argv: ["vim"] }];
	const sessionsBefore = world.broker.sessions.size;
	await world.agent({ id: "sender-2", name: "other", pane: "wA:p2", tab: "wA:t1" }).start();
	assert.ok(world.broker.sessions.size > sessionsBefore);
	const third = await w.tower.tool("boss_revive_main", { action: "revive", session: "busy main", reason: "back" });
	assert.equal((third.details as { closedOld?: string }).closedOld, undefined);
	assert.ok(!world.herdr.commands("tab", "close").some((c) => c[2] === "wA:t41" || c[2] === "wA:t42"));
});

test("the ended mark: a /quit writes quit, a signal writes signal, a reload none, and a close on purpose forgets the record", async () => {
	const w = await setup();
	const make = (id: string, pane: string, tab: string) => {
		const a = world.agent({ id, name: id, pane, tab, env: w.env });
		a.file = join(w.agentDir, "sessions", `x_${id}.jsonl`);
		return a;
	};
	const read = (file: string) => (existsSync(recordPath(world.stateDir, file)) ? JSON.parse(readFileSync(recordPath(world.stateDir, file), "utf8")) : undefined);
	const quitter = make("q1", "wA:p20", "wA:t20");
	await quitter.start();
	await quitter.promote();
	assert.ok(read(quitter.file!), "a main has a record");
	await quitter.stop("quit");
	assert.equal(read(quitter.file!).ended.reason, "quit");
	const signalled = make("s1", "wA:p21", "wA:t21");
	await signalled.start();
	await signalled.promote();
	noteSignal("SIGHUP");
	await signalled.stop("quit");
	assert.equal(read(signalled.file!).ended.reason, "signal", "a SIGHUP turned into a quit is told apart");
	noteSignal(undefined);
	const reloaded = make("r1", "wA:p22", "wA:t22");
	await reloaded.start();
	await reloaded.promote();
	await reloaded.stop("reload");
	assert.equal(read(reloaded.file!).ended, undefined, "a reload keeps the session going");
	const closed = make("c1", "wA:p23", "wA:t23");
	await closed.start();
	await closed.promote();
	await closed.command("close");
	for (let i = 0; i < 400 && !closed.stopped; i++) await new Promise((r) => setTimeout(r, 5));
	await world.quiet();
	assert.equal(read(closed.file!), undefined, "a close on purpose forgets the record");
});

test("an ally run never gets the tool: it is not in its set, and a pi tower session's head-free registration names it in PARENT_ONLY", async () => {
	const { PARENT_ONLY } = await import("../src/tools.ts");
	const { RUN_TOWER_TOOLS, HEAD_TOWER_TOOLS } = await import("../src/runallow.ts");
	assert.ok(PARENT_ONLY.includes("boss_revive_main"));
	assert.ok((RUN_TOWER_TOOLS as readonly string[]).includes("boss_revive_main"));
	assert.ok(!(HEAD_TOWER_TOOLS as readonly string[]).includes("boss_revive_main"), "the head opens no mains (HH1-F006)");
});

test("the revived main picks up its own orphans at its claim: a finished run's result comes to it encoded, once (O1)", async () => {
	const w = await setup();
	const REGISTRY = Symbol.for("pi-subagents/runtime");
	(globalThis as Record<symbol, unknown>)[REGISTRY] = { runningSubagents: new Map() };
	try {
		const file = crashed(w, { record: { openedBy: "sender-1" } });
		const art = join(w.agentDir, "sessions", "--alpha--", "artifacts", DEAD);
		for (const sub of ["subagent-activity", "subagent-scripts"]) mkdirSync(join(art, sub), { recursive: true });
		const kid = join(w.agentDir, "sessions", "--alpha--", "2026-11-23T00-15-00-000Z_k1-aaaaaaaa-bbbbbbbb-cccc.jsonl");
		writeFileSync(kid, [{ type: "session", id: "k1" }, { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "zhr3 done: 12 files" }] } }].map((r) => JSON.stringify(r)).join("\n"));
		writeFileSync(`${kid}.exit`, JSON.stringify({ type: "done" }));
		writeFileSync(join(art, "subagent-activity", "k1.json"), "{}");
		writeFileSync(join(art, "subagent-scripts", `x-k1.sh`), `# Subagent launch script for zhr3-a\n# Session: ${kid}\n# Surface: wA:p9\n`);
		assert.ok(existsSync(file));
		revives(w);
		await w.tower.tool("boss_revive_main", { action: "revive", session: DEAD, reason: "back" });
		await world.quiet();
		const revived = world.agents.find((a) => a.id === DEAD)!;
		const told = revived.sent.filter((m) => m.customType === "straw-boss-orphan-result");
		assert.equal(told.length, 1);
		assert.match(told[0]!.content, /Finished: zhr3-a \(run k1, .*\n<<< .*\n\| zhr3 done: 12 files\n>>>/);
		assert.equal(told[0]!.triggerTurn, true);
	} finally {
		(globalThis as Record<symbol, unknown>)[REGISTRY] = undefined;
	}
});

test("subagent_resume is refused for a session file a live pane runs: two pis on one file", async () => {
	const w = await setup();
	world.herdr.addPane("wA:p66", "wA:t66", "pi").agent_session = { value: "/s/child.jsonl" };
	const block = await w.sender.fireResult("tool_call", { toolName: "subagent_resume", toolCallId: "c", input: { sessionPath: "/s/child.jsonl" } }) as { block?: boolean; reason?: string } | undefined;
	assert.equal(block?.block, true);
	assert.match(String(block?.reason), /pane wA:p66 runs that session file now, and two pis on one file corrupt it/);
	const free = await w.sender.fireResult("tool_call", { toolName: "subagent_resume", toolCallId: "c", input: { sessionPath: "/s/other.jsonl" } }) as { block?: boolean } | undefined;
	assert.notEqual(free?.block, true);
});
