import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Pane, Session } from "../src/herdr.ts";
import { createCloser } from "../src/closer.ts";
import { requestFile, trustDir, writeAtomic } from "../src/trust/files.ts";
import { digestOf } from "../src/trust/found.ts";
import { closeAll, listStashes, nameFor, nameOk, stashedList, popBase, type Stash, stashBase, stashFile } from "../src/stash.ts";

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

test("the stand-in agent of a tower the sb server runs is the standing pane's shell with the tower prompt in it, not an agent that blocks the stash", async () => {
	const w = world();
	// The server's tower: no pi session, a standing pane that shows the stand-in `tower` while the prompt (a node process) runs there.
	w.panes.splice(w.panes.findIndex((p) => p.pane_id === "wA:p1"), 1, { pane_id: "wA:p1", tab_id: "wA:t1", workspace_id: "wA", agent: "tower", agent_status: "idle", cwd: w.dir, tokens: { sb_role: "tower" } });
	w.fg["wA:p1"] = ["node"];
	w.live.splice(0, 1);
	const s = stasher(w);
	const r = await s.go();
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.deepEqual(s.checked.sort(), ["b", "m"], "no session is asked for the tower");
	const st = JSON.parse(readFileSync(stashFile(w.dir, "A"), "utf8")) as Stash;
	assert.deepEqual(st.tabs.map((t) => [t.label, t.panes.map((p) => p.kind)]), [["work", ["main", "member", "shell"]], ["T", ["shell"]]]);
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
/** `trust`: each pi it starts (but the tower) first asks a trust question that goes after `after` sleeps of the wait, and takes its role then. */
function popper(w: ReturnType<typeof world>, { fail = "", trust }: { fail?: string; trust?: { after: number } } = {}) {
	const made: Pane[] = [], ran: string[][] = [];
	let n = 0, towerToken: string | undefined, slept = 0, release: (() => void) | undefined;
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
			else if (trust) {
				const found = [{ kind: "settings", path: ".pi/settings.json", items: [], more: 0 }], dir = trustDir(w.dir), id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
				mkdirSync(dir, { recursive: true, mode: 0o700 });
				writeAtomic(dir, requestFile(id), { version: 1, id, pid: process.pid, herdr: "h", pane: p.pane_id, role, cwd: "/work/demo", at: 1, found, digest: digestOf("/work/demo", found) });
				[slept, release] = [0, () => (rmSync(join(dir, requestFile(id))), (p.tokens!.sb_role = role))];
			} else p.tokens!.sb_role = role;
			return "{}";
		}
		if (group === "workspace" && cmd === "list") return ok({ workspaces: [{ workspace_id: "wN", label: "Base A", tokens: towerToken ? { tower: towerToken } : {} }] });
		if (group === "pane" && cmd === "list") return ok({ panes: made });
		return "{}";
	};
	return { ran, made, pop: (name = "A", agentDir?: string) => popBase({ run, sleep: async () => void (trust && ++slept === trust.after && release?.()), trustDir: trust && trustDir(w.dir), stateDir: w.dir, live: async (id) => id === "T1", agentDir, now: () => new Date("2026-10-22T11:00:00Z") }, name) };
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

test("close all closes only the invoker's own base; the other bases of the net are not checked or touched", async () => {
	const t = twoBases();
	t.w.fg["wA:p4"] = ["zsh", "vite"];
	const asked: string[] = [];
	const r = await t.go(async (key) => (asked.push(key), {}), "c");
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.deepEqual(t.closed, ["wC"]);
	assert.deepEqual(asked, ["c"], "only the sessions of its own base are asked");
});

test("one refusal in the base closes nothing and lists every reason", async () => {
	const t = twoBases();
	t.w.fg["wA:p4"] = ["zsh", "vite"];
	const r = await t.go(async (key) => (key === "b" ? { reason: "a background monitor is running" } : {}), "m");
	assert.equal(r.status, 409);
	const why = String((r.body as { reason: string }).reason);
	assert.match(why, /Base A: pane wA:p4 runs vite/);
	assert.match(why, /member · A: a background monitor is running/);
	assert.doesNotMatch(why, /Base C/);
	assert.deepEqual(t.closed, []);
});

test("a session outside the net, or in a workspace that is not a base, closes nothing", async () => {
	const t = twoBases();
	assert.equal((await t.go(async () => ({}), "nobody")).status, 400);
	t.w.live.push(at("d", "shell user", "wD:p1"));
	assert.equal((await t.go(async () => ({}), "d")).status, 404, "a workspace with only shells is not on the net");
	assert.deepEqual(t.closed, []);
});

test("the base is looked at again just before it closes, and the server's own session is asked again when it sits there", async () => {
	const t = twoBases();
	let asked = 0;
	const r = await t.go(async (key) => (key === "gui" && ++asked >= 1 ? { reason: "a turn is running" } : {}), "m");
	assert.equal(r.status, 409);
	assert.match(String((r.body as { reason: string }).reason), /Base A cannot close now: a turn is running/);
	const u = twoBases();
	let calls = 0;
	const late = await u.go(async () => (++calls === 3 && (u.w.panes.find((p) => p.pane_id === "wA:p2")!.agent_status = "working"), {}), "m");
	assert.equal(late.status, 409);
	assert.match(String((late.body as { reason: string }).reason), /main · A is working/);
	assert.deepEqual([...t.closed, ...u.closed], []);
});

test("the page's Quit names its base: close all closes that base alone, checked first", async () => {
	const t = twoBases();
	const r = await closeAll({ run: t.w.run, sleep: async () => {}, sessions: async () => t.w.live, check: async () => ({}) }, "gui", async (ws) => (t.closed.push(ws), { status: 200, body: {} }), undefined, undefined, "wC");
	assert.equal(r.status, 200, JSON.stringify(r.body));
	assert.deepEqual(t.closed, ["wC"]);
});

test("the page's Pop goes through the closer: a bad name is refused, a failure says why, a success says what came back", async () => {
	const w = world(), popped: string[] = [];
	const close = createCloser({ run: w.run, sleep: async () => {}, me: () => "gui", sessions: async () => [], ask: async () => ({ accepted: true }), check: async () => ({}), stateDir: w.dir, pop: async (name) => { popped.push(name); if (name === "bad") throw new Error("Nothing is stashed as \"bad\""); return { workspace: "wN", label: "Base A", sessions: 3 }; } });
	assert.equal((await close("pop", { name: "../x" })).status, 400);
	const failed = await close("pop", { name: "bad" });
	assert.equal(failed.status, 409);
	assert.match(String((failed.body as { reason: string }).reason), /Nothing is stashed as "bad"/);
	assert.deepEqual((await close("pop", { name: "A" })).body, { workspace: "wN", label: "Base A", sessions: 3 });
	assert.deepEqual(popped, ["bad", "A"]);
});

test("the page lists each stash with its label; a manifest that does not read is left out", async () => {
	const w = world();
	await stasher(w).go();
	writeFileSync(stashFile(w.dir, "broken"), "{");
	assert.deepEqual(stashedList(w.dir), [{ name: "A", label: "Base A", at: "2026-10-22T10:00:00.000Z" }]);
});

test("the page's Stash sends no name: the label names it, made valid and free when it is not", async () => {
	assert.equal(nameFor("feat/x\tbranch", "/nonexistent"), "feat-x-branch");
	assert.equal(nameFor("..hidden", "/nonexistent"), "hidden");
	assert.equal(nameFor(" / ", "/nonexistent"), "-");
	assert.ok(nameOk(nameFor("x".repeat(200), "/nonexistent")));
	const w = world();
	w.all[0]!.label = "feat/x";
	const deps = { run: w.run, sleep: async () => {}, sessions: async () => w.live, check: async () => ({}), stateDir: w.dir };
	const first = await stashBase(deps, { workspace: "wA" }, async () => ({ status: 200, body: {} }));
	assert.deepEqual(first.body, { stashed: "feat-x", sessions: 3 });
	const second = await stashBase(deps, { workspace: "wA" }, async () => ({ status: 200, body: {} }));
	assert.deepEqual(second.body, { stashed: "feat-x 2", sessions: 3 });
});

test("a stash of the server's own base asks the server's session once more before anything is recorded", async () => {
	const w = world(), asked: string[] = [];
	w.live.push(at("gui", "gui", "wA:p2"));
	const deps = { run: w.run, sleep: async () => {}, sessions: async () => w.live, check: async (key: string) => (asked.push(key), key === "gui" ? { reason: "gui is working" } : {}), stateDir: w.dir, me: "gui" };
	const r = await stashBase(deps, { workspace: "wA", name: "A" }, async () => ({ status: 200, body: {} }));
	assert.equal(r.status, 409);
	assert.equal(asked.at(-1), "gui");
	assert.equal((await stashBase({ ...deps, me: "elsewhere" }, { workspace: "wA", name: "B" }, async () => ({ status: 200, body: {} }))).status, 200);
	assert.match(String((r.body as { reason: string }).reason), /gui is working/);
	assert.equal(existsSync(stashFile(w.dir, "A")), false);
});

test("a pop that fails while something was stashed under its name meanwhile comes back under a free name, over nothing", async () => {
	const w = world();
	await stasher(w).go();
	const p = popper(w, { fail: "member" });
	const popping = p.pop();
	writeFileSync(stashFile(w.dir, "A"), "{}");
	await assert.rejects(popping, /stashed again as "A 2"/);
	assert.deepEqual(listStashes(w.dir), ["A", "A 2"]);
	assert.equal(readFileSync(stashFile(w.dir, "A"), "utf8"), "{}");
	assert.equal(existsSync(join(w.dir, "stash", ".popping", "A.json")), false);
});

test("a pop does not count the time a resumed pi waits on a trust question, and still brings every pane back", async () => {
	const w = world();
	await stasher(w).go();
	const slow = popper(w, { trust: { after: 400 } }); // a question open for 400 waits of 500 ms: more than the 60 s
	assert.deepEqual(await slow.pop(), { workspace: "wN", label: "Base A", sessions: 3 });
	const plain = world();
	await stasher(plain).go();
	const never = popper(plain, { trust: { after: 100_000_000 } });
	await assert.rejects(never.pop(), /No trust decision for \/work\/demo within 10 minutes/);
	assert.ok(never.ran.some((a) => a.join(" ") === "workspace close wN"), "what the pop opened is closed again, and the stash is kept");
	assert.deepEqual(listStashes(plain.dir), ["A"]);
});

test("a pop into a folder whose .pi/settings.json pi must not read opens nothing, keeps the stash, and the closer answers it for the page", async () => {
	const w = world();
	await stasher(w).go();
	mkdirSync(join(w.dir, ".pi"));
	symlinkSync("/dev/zero", join(w.dir, ".pi", "settings.json"));
	const p = popper(w);
	await assert.rejects(p.pop(), (error: Error) => error.message.startsWith("The stash was not started: ") && error.message.includes(join(w.dir, ".pi", "settings.json")));
	assert.deepEqual(p.ran, [], "no workspace, tab, pane, or pi was made");
	assert.deepEqual(listStashes(w.dir), ["A"], "the stash is back under its name");
	const close = createCloser({ run: w.run, sleep: async () => {}, me: () => "gui", sessions: async () => w.live, ask: async () => ({ accepted: true }), stateDir: w.dir, pop: (name) => p.pop(name) });
	const reply = await close("pop", { name: "A" });
	assert.deepEqual([reply.status, (reply.body as { error: string }).error, (reply.body as { settings: { why: string } }).settings.why], [409, "settings_unsafe", "special"]);
	rmSync(join(w.dir, ".pi", "settings.json"));
	writeFileSync(join(w.dir, ".pi", "settings.json"), "{}");
	assert.equal((await popper(w).pop()).sessions, 3, "fixed, it pops");
});
