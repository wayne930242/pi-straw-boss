import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Pane, Session } from "../src/herdr.ts";
import { createCloser } from "../src/closer.ts";
import { closeAll, listStashes, nameOk, popBase, type Stash, stashBase, stashFile } from "../src/stash.ts";

// Stash and pop (docs/specs/2026-10-22-stash/spec.md): a base is checked before anything closes, recorded, then closed; a pop resumes
// each pi from its session file, the tower first and each tab's main before its members, and closes what it opened when one fails.

const at = (id: string, name: string, paneId: string): Session => ({ id, name, herdrLocation: { status: "ok", paneId, workspace: { id: paneId.split(":")[0]!, label: "" } } as Session["herdrLocation"] });

function world() {
	const dir = mkdtempSync(join(tmpdir(), "sb-stash-"));
	const file = (n: string) => ((p) => (writeFileSync(p, "{}\n"), p))(join(dir, `${n}.jsonl`));
	const pi = (id: string, tab: string, role: string, status = "idle"): Pane => ({ pane_id: id, tab_id: tab, workspace_id: "wA", agent: "pi", agent_status: status, agent_session: { value: file(id.replace(":", "-")) }, cwd: dir, tokens: { sb_role: role } });
	const panes: Pane[] = [pi("wA:p2", "wA:t2", "main"), pi("wA:p3", "wA:t2", "member"), { pane_id: "wA:p4", tab_id: "wA:t2", workspace_id: "wA", cwd: dir }, pi("wA:p1", "wA:t1", "tower")];
	const tabs = [{ tab_id: "wA:t2", workspace_id: "wA", label: "work" }, { tab_id: "wA:t1", workspace_id: "wA", label: "T" }];
	const all = [{ workspace_id: "wA", label: "Base A" }] as { workspace_id: string; label: string; worktree?: Record<string, unknown> }[];
	const fg: Record<string, string[]> = { "wA:p4": ["zsh"] };
	const ran: string[][] = [];
	const run = async (args: string[]) => {
		ran.push(args);
		const [group, cmd] = args;
		const ok = (result: unknown) => JSON.stringify({ result });
		if (group === "workspace" && cmd === "list") return ok({ workspaces: all });
		if (group === "tab" && cmd === "list") return ok({ tabs });
		if (group === "pane" && cmd === "list") return ok({ panes: args[3] ? panes.filter((p) => p.workspace_id === args[3]) : panes });
		if (group === "pane" && cmd === "process-info") return ok({ process_info: { foreground_processes: (fg[args[3]!] ?? []).map((name) => ({ name, argv0: name })) } });
		return "{}";
	};
	const live = [at("tower", "tower · A", "wA:p1"), at("m", "main · A", "wA:p2"), at("b", "member · A", "wA:p3")];
	return { dir, panes, tabs, all, fg, ran, run, live };
}

function stasher(w: ReturnType<typeof world>, { answers = {} as Record<string, { reason?: string } | undefined>, close = { status: 200, body: { closed: 3 } as Record<string, unknown> } } = {}) {
	const checked: string[] = [], closed: string[] = [];
	const deps = { run: w.run, sleep: async () => {}, sessions: async () => w.live, check: async (key: string) => (checked.push(key), key in answers ? answers[key] : {}), stateDir: w.dir, now: () => new Date("2026-10-22T10:00:00Z") };
	return { checked, closed, go: (name = "A") => stashBase(deps, { workspace: "wA", name }, async (ws) => (closed.push(ws), close)) };
}

test("a stash checks every session, records the base with its tower tab first, then closes it", async () => {
	const w = world(), s = stasher(w);
	const r = await s.go();
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.deepEqual(s.checked.sort(), ["b", "m", "tower"]);
	assert.deepEqual(s.closed, ["wA"]);
	const st = JSON.parse(readFileSync(stashFile(w.dir, "A"), "utf8")) as Stash;
	assert.equal(st.label, "Base A");
	assert.deepEqual(st.tabs.map((t) => [t.label, t.panes.map((p) => p.kind)]), [["T", ["tower"]], ["work", ["main", "member", "shell"]]]);
	assert.equal(st.tabs[1]!.panes[0]!.name, "main · A");
	assert.match(st.tabs[1]!.panes[0]!.session!, /wA-p2\.jsonl$/);
	assert.deepEqual(listStashes(w.dir), ["A"]);
});

test("anything a resume would lose refuses the stash, names every reason, and closes nothing", async () => {
	const w = world();
	w.panes[0]!.agent_status = "working";
	w.panes.push({ pane_id: "wA:p5", tab_id: "wA:t2", workspace_id: "wA", agent: "pi", agent_status: "idle", agent_session: { value: "/nope" }, cwd: w.dir, tokens: {} });
	w.fg["wA:p4"] = ["zsh", "node"];
	const s = stasher(w, { answers: { b: { reason: "a background monitor is running" }, tower: undefined } });
	const r = await s.go();
	assert.equal(r.status, 409);
	const reason = String((r.body as { reason: string }).reason);
	for (const bit of [/main · A is working/, /pane wA:p5 is a subagent/, /pane wA:p4 runs node/, /member · A: a background monitor is running/, /tower · A did not answer the check/]) assert.match(reason, bit);
	assert.deepEqual(s.closed, []);
	assert.equal(existsSync(stashFile(w.dir, "A")), false);
});

test("a session that has not told the server about itself yet gets more rounds before it counts as silent", async () => {
	const w = world();
	let calls = 0;
	const refreshed: number[] = [];
	const deps = { run: w.run, sleep: async () => {}, sessions: async () => w.live, check: async (key: string) => (key === "b" && ++calls < 3 ? undefined : {}), stateDir: w.dir };
	const r = await stashBase(deps, { workspace: "wA", name: "A" }, async () => ({ status: 200, body: {} }), async () => refreshed.push(1));
	assert.equal(r.status, 200);
	assert.equal(refreshed.length, 2);
});

test("a sub workspace, a running agent in one of its sub workspaces, a taken or bad name are refused", async () => {
	const w = world();
	w.all[0]!.worktree = { repo_key: "r" };
	w.all.push({ workspace_id: "wB", label: "B-wt", worktree: { repo_key: "r", is_linked_worktree: true } });
	w.panes.push({ pane_id: "wB:p1", tab_id: "wB:t1", workspace_id: "wB", agent: "pi", agent_status: "working", cwd: w.dir }, { pane_id: "wB:p2", tab_id: "wB:t1", workspace_id: "wB", cwd: w.dir });
	w.fg["wB:p2"] = ["zsh", "vite"];
	const s = stasher(w);
	const why = String(((await s.go()).body as { reason: string }).reason);
	assert.match(why, /sub workspace B-wt runs 1 agent/);
	assert.match(why, /pane wB:p2 in its sub workspace B-wt runs something/);
	mkdirSync(join(w.dir, "stash"), { recursive: true });
	writeFileSync(stashFile(w.dir, "taken"), "{}");
	assert.equal((await s.go("taken")).status, 409);
	for (const bad of ["", ".hidden", "a/b", "x".repeat(65), " pad"]) assert.equal(nameOk(bad), false, bad);
	assert.equal(nameOk("Agent Root 2"), true);
});

test("through the closer, a stash quits each session only while it can still be stashed; a base's close asks plainly", async () => {
	const w = world(), flags: [string, boolean | undefined][] = [];
	let live = w.live;
	const close = createCloser({ run: w.run, sleep: async () => {}, me: () => "gui", sessions: async () => live, check: async () => ({}), stateDir: w.dir, ask: async (key, _keep, ifStashable) => (flags.push([key, ifStashable]), (live = live.filter((s) => s.id !== key)), { accepted: true }) });
	assert.equal((await close("stash", { workspace: "wA", name: "A" })).status, 200);
	assert.deepEqual(flags.map(([, f]) => f), [true, true, true]);
	assert.deepEqual(listStashes(w.dir), ["A"]);
	[live, flags.length] = [w.live, 0];
	await close("base", { workspace: "wA" });
	assert.ok(flags.every(([, f]) => !f));
});

test("a pi that never replied (Herdr names a file pi has not written yet) is stashed without one and starts fresh at pop", async () => {
	const w = world();
	w.panes[3]!.agent_session = { value: join(w.dir, "never-written.jsonl") };
	assert.equal((await stasher(w).go()).status, 200);
	const st = JSON.parse(readFileSync(stashFile(w.dir, "A"), "utf8")) as Stash;
	assert.equal(st.tabs[0]!.panes[0]!.session, undefined);
	const p = popper(w);
	assert.equal((await p.pop()).sessions, 3);
	const tower = p.ran.find((a) => a[0] === "agent" && a[2]!.startsWith("tower"))!;
	assert.ok(!tower.includes("--session") && tower.includes("tower · A"), "the tower starts fresh under its name");
});

test("a shell Herdr knows no folder of refuses the stash: a pop could not reopen it", async () => {
	const w = world();
	delete w.panes[2]!.cwd;
	const r = await stasher(w).go();
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /pane wA:p4 has no folder Herdr knows of/);
});

test("a shell job started while the sessions were asked refuses the stash before anything closes", async () => {
	const w = world(), s = stasher(w);
	let asked = 0;
	const deps = { run: w.run, sleep: async () => {}, sessions: async () => w.live, check: async () => (++asked === 3 && (w.fg["wA:p4"] = ["zsh", "make"]), {}), stateDir: w.dir };
	const r = await stashBase(deps, { workspace: "wA", name: "A" }, async (ws) => (s.closed.push(ws), { status: 200, body: {} }));
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /pane wA:p4 runs make/);
	assert.deepEqual(s.closed, []);
});

test("a close that stops half way keeps nothing stashed and says how each session resumes", async () => {
	const w = world(), s = stasher(w, { close: { status: 409, body: { error: "refused", reason: "Nothing was closed: b (busy)." } } });
	const r = await s.go();
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /Nothing is stashed; .*pi --session .*wA-p2\.jsonl/);
	assert.equal(existsSync(stashFile(w.dir, "A")), false);
});

// Pop: a fake Herdr that answers creates, splits, and starts, and lets each started pi take its role a moment later.
function popper(w: ReturnType<typeof world>, { fail = "" } = {}) {
	const made: Pane[] = [], ran: string[][] = [];
	let n = 0, towerToken: string | undefined;
	const pane = (tab: string, env: string[]) => ((p) => (made.push(p), p))({ pane_id: `wN:p${++n}`, tab_id: tab, workspace_id: "wN", tokens: { env: env.join(",") } } as Pane);
	const envs = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));
	const run = async (args: string[]) => {
		ran.push(args);
		const ok = (result: unknown) => JSON.stringify({ result });
		const [group, cmd] = args;
		if (group === "workspace" && cmd === "create") return ok({ workspace: { workspace_id: "wN" }, tab: { tab_id: "wN:t0" }, root_pane: pane("wN:t0", envs(args)) });
		if (group === "tab" && cmd === "create") return ok({ tab: { tab_id: `wN:t${n + 1}` }, root_pane: pane(`wN:t${n + 1}`, envs(args)) });
		if (group === "pane" && cmd === "split") return ok({ pane: pane("split", envs(args)) });
		if (group === "agent" && cmd === "start") {
			const p = made.find((x) => x.pane_id === args[args.indexOf("--pane") + 1])!, role = /STRAW_BOSS_ROLE=(\w+)/.exec(p.tokens!.env!)?.[1] ?? "";
			if (fail && args[2]!.startsWith(fail)) throw new Error("agent did not start");
			if (role === "tower") towerToken = "T1";
			else p.tokens!.sb_role = role;
			return "{}";
		}
		if (group === "workspace" && cmd === "list") return ok({ workspaces: [{ workspace_id: "wN", label: "Base A", tokens: towerToken ? { tower: towerToken } : {} }] });
		if (group === "pane" && cmd === "list") return ok({ panes: made });
		return "{}";
	};
	return { ran, made, pop: (name = "A", agentDir?: string) => popBase({ run, sleep: async () => {}, stateDir: w.dir, live: async (id) => id === "T1", agentDir, now: () => new Date("2026-10-22T11:00:00Z") }, name) };
}

test("a pop resumes the tower first, then each tab's main before its members, and files the stash away", async () => {
	const w = world();
	await stasher(w).go();
	const p = popper(w);
	const r = await p.pop("A", "/agent");
	assert.deepEqual(r, { workspace: "wN", label: "Base A", sessions: 3 });
	const starts = p.ran.filter((a) => a[0] === "agent").map((a) => [a[2]!.split("-")[0], a[a.indexOf("--session") + 1]!.split("/").pop(), a[a.indexOf("--name") + 1]]);
	assert.deepEqual(starts, [["tower", "wA-p1.jsonl", "tower · A"], ["main", "wA-p2.jsonl", "main · A"], ["member", "wA-p3.jsonl", "member · A"]]);
	assert.deepEqual(p.ran.find((a) => a[0] === "workspace" && a[1] === "create")!.slice(-4), ["--env", "STRAW_BOSS_ROLE=tower", "--env", "PI_CODING_AGENT_DIR=/agent"]);
	assert.ok(p.ran.filter((a) => a[1] === "split" || (a[0] === "tab" && a[1] === "create")).every((a) => a.includes("PI_CODING_AGENT_DIR=/agent")), "every pane runs under the same agent dir");
	assert.ok(p.ran.some((a) => a.join(" ") === "tab rename wN:t0 T"), "the tower tab keeps its label");
	assert.ok(p.ran.some((a) => a[1] === "report-metadata" && a.includes("sb_open_main=1")), "the main may promote itself");
	assert.equal(p.made.filter((x) => !x.tokens?.env?.includes("STRAW_BOSS_ROLE")).length, 1, "the shell comes back without a role");
	assert.deepEqual(listStashes(w.dir), []);
	assert.deepEqual(readdirSync(join(w.dir, "stash", "popped")), ["A-2026-10-22T11-00-00-000Z.json"]);
});

test("a pop that fails closes the new workspace and keeps the stash; a missing session file opens nothing", async () => {
	const w = world();
	await stasher(w).go();
	const p = popper(w, { fail: "member" });
	await assert.rejects(p.pop(), /agent did not start/);
	assert.ok(p.ran.some((a) => a.join(" ") === "workspace close wN"));
	assert.deepEqual(listStashes(w.dir), ["A"]);
	const st = JSON.parse(readFileSync(stashFile(w.dir, "A"), "utf8")) as Stash;
	st.tabs[1]!.panes[0]!.session = join(w.dir, "gone.jsonl");
	writeFileSync(stashFile(w.dir, "A"), JSON.stringify(st));
	const q = popper(w);
	await assert.rejects(q.pop(), /Nothing was opened: .*gone\.jsonl/);
	assert.equal(q.ran.length, 0);
	await assert.rejects(q.pop("nope"), /Nothing is stashed as "nope"/);
});

test("two pops of one stash: the first claims it on disk, the second opens nothing", async () => {
	const w = world();
	await stasher(w).go();
	const p = popper(w), q = popper(w);
	const first = p.pop();
	await assert.rejects(q.pop(), /another session is popping it/);
	assert.equal(q.ran.length, 0);
	await first;
	assert.deepEqual(listStashes(w.dir), []);
});

// Close all: every base of the net, checked first as a stash checks it, minus what only a pop needs.
function twoBases() {
	const w = world();
	w.all.push({ workspace_id: "wC", label: "Base C" }, { workspace_id: "wD", label: "Shells only" });
	w.panes.push({ pane_id: "wC:p1", tab_id: "wC:t1", workspace_id: "wC", agent: "pi", agent_status: "idle", agent_session: { value: "/not-yet.jsonl" }, tokens: { sb_role: "member" } }, { pane_id: "wD:p1", tab_id: "wD:t1", workspace_id: "wD", cwd: w.dir });
	w.live.push(at("c", "member · C", "wC:p1"), at("gui", "gui", "wA:p2"));
	const run = w.run;
	w.run = async (args: string[]) => (args[0] === "tab" && args[1] === "list" && args[3] !== "wA" ? JSON.stringify({ result: { tabs: [{ tab_id: `${args[3]}:t1`, workspace_id: args[3] }] } }) : run(args));
	const closed: string[] = [];
	const go = (check: (key: string) => Promise<{ reason?: string } | undefined> = async () => ({}), by?: string, onClose = (_ws: string) => {}) => closeAll({ run: w.run, sleep: async () => {}, sessions: async () => w.live, check }, "gui", async (ws) => (closed.push(ws), onClose(ws), { status: 200, body: {} }), undefined, by);
	return { w, closed, go };
}

test("close all checks every base of the net, then closes each, the server's own base last; a workspace outside the net is left alone", async () => {
	const t = twoBases();
	const r = await t.go();
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.deepEqual(t.closed, ["wC", "wA"]);
	assert.deepEqual((r.body as { closed: string[] }).closed, ["Base C", "Base A"]);
});

test("one refusal anywhere closes nothing and lists every reason, base by base", async () => {
	const t = twoBases();
	t.w.fg["wA:p4"] = ["zsh", "vite"];
	const r = await t.go(async (key) => (key === "c" ? { reason: "a background monitor is running" } : {}));
	assert.equal(r.status, 409);
	const why = String((r.body as { reason: string }).reason);
	assert.match(why, /Base A: pane wA:p4 runs vite/);
	assert.match(why, /member · C: a background monitor is running/);
	assert.deepEqual(t.closed, []);
});

test("a base that stops half way leaves the rest open and says which closed", async () => {
	const t = twoBases();
	const r = await closeAll({ run: t.w.run, sleep: async () => {}, sessions: async () => t.w.live, check: async () => ({}) }, "gui", async (ws) => (t.closed.push(ws), ws === "wA" ? { status: 409, body: { reason: "Nothing was closed: b (busy)." } } : { status: 200, body: {} }));
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /busy.*Closed before it: Base C; the rest stay open/);
});

test("close all closes the invoker's base after the others and the server's last; a stale role token puts no workspace on the net", async () => {
	const t = twoBases();
	t.w.all.push({ workspace_id: "wE", label: "Stale" });
	t.w.panes.push({ pane_id: "wE:p1", tab_id: "wE:t1", workspace_id: "wE", cwd: t.w.dir, tokens: { sb_role: "member" } });
	const r = await t.go(async () => ({}), "c");
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.deepEqual(t.closed, ["wC", "wA"], "wE (stale token) is not on the net; the invoker's base wC before the server's wA");
});

test("a base is looked at again just before it closes: a job started meanwhile stops the run and names what closed", async () => {
	const t = twoBases();
	t.w.all.push({ workspace_id: "wF", label: "Base F" });
	t.w.panes.push({ pane_id: "wF:p1", tab_id: "wF:t1", workspace_id: "wF", agent: "pi", agent_status: "idle", agent_session: { value: "/x.jsonl" }, tokens: { sb_role: "main" } });
	t.w.live.push(at("f", "main · F", "wF:p1"));
	const r = await t.go(async () => ({}), undefined, (ws) => ws === "wC" && (t.w.panes.find((p) => p.pane_id === "wF:p1")!.agent_status = "working"));
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /Base F cannot close now: main · F is working.*Closed before it: Base C/);
	assert.deepEqual(t.closed, ["wC"]);
});

test("the server's own session is asked again before its base closes with it", async () => {
	const t = twoBases();
	let asked = 0;
	const r = await t.go(async (key) => (key === "gui" && ++asked >= 1 ? { reason: "a turn is running" } : {}));
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /Base A cannot close now: a turn is running/);
	assert.deepEqual(t.closed, ["wC"]);
});
