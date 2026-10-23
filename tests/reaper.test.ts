// @ts-nocheck: the plugin scripts are plain JavaScript and the fake Herdr, git and panes are loose test data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONFIRM_MS, PIN_GLYPH, PIN_TOKEN, SWEEP_INTERVAL_MS,
	applyOps, decideRemoval, emptyState, findCheckoutUser, isPinned, migratePins, noteParents, noteWorkspaces, onRename, planSweep, prunePanes, prunePins, set, shellIsIdle, togglePin,
} from "../herdr-reaper/decide.mjs";
import { createStore, gitClient, gitReason, withLock } from "../herdr-reaper/io.mjs";
import { SOURCE, runEvent, runPinToggle, runSweep } from "../herdr-reaper/sweep.mjs";

const NOW = 1_000_000_000;
const worktree = (path, linked = true, repoRoot = "/repo") => ({ checkout_path: path, is_linked_worktree: linked, repo_root: repoRoot });
const workspace = (id, label, extra = {}) => ({ workspace_id: id, label, worktree: worktree(`/wt/${label}`), ...extra });
const pane = (id, workspaceId, extra = {}) => ({ pane_id: id, terminal_id: `term_${id}`, workspace_id: workspaceId, focused: false, ...extra });
const idle = { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10, name: "zsh" }] };
const busy = { shell_pid: 10, foreground_process_group_id: 77, foreground_processes: [{ pid: 77, name: "vite" }] };
const state = (extra = {}) => ({ ...emptyState(), ...extra });
const plan = (input, infos = {}) =>
	planSweep({ now: NOW, confirmMs: 0, config: {}, state: state({ initialized: true }), ...input }, { processInfo: async (id) => infos[id] ?? idle });
const tempDir = () => mkdtemp(join(tmpdir(), "pane-reaper-"));

// Sweeps against a fake Herdr and git
function world({ workspaces, panes, infos = {}, checkouts = {} }) {
	const w = { workspaces: structuredClone(workspaces), panes: structuredClone(panes), calls: [], removed: [], logs: [], tokens: [] };
	const find = (id) => w.workspaces.find((candidate) => candidate.workspace_id === id);
	w.herdr = {
		listWorkspaces: async () => structuredClone(w.workspaces),
		listPanes: async () => structuredClone(w.panes),
		getWorkspace: async (id) => structuredClone(find(id)),
		getPane: async (id) => structuredClone(w.panes.find((candidate) => candidate.pane_id === id)),
		processInfo: async (id) => infos[id] ?? idle,
		closePane: async (id) => {
			w.calls.push(`close ${id}`);
			const closed = w.panes.find((candidate) => candidate.pane_id === id);
			w.panes = w.panes.filter((candidate) => candidate.pane_id !== id);
			// Herdr closes the tab and then the workspace with the last pane.
			if (!w.panes.some((candidate) => candidate.workspace_id === closed.workspace_id)) w.workspaces = w.workspaces.filter((candidate) => candidate.workspace_id !== closed.workspace_id);
		},
		setToken: async (id, source, name, value) => {
			w.tokens.push(["set", id, source, name, value]);
			(find(id).tokens ??= {})[name] = value;
		},
		clearToken: async (id, source, name) => {
			w.tokens.push(["clear", id, source, name]);
			delete find(id).tokens?.[name];
		},
	};
	w.git = {
		exists: (path) => path in checkouts,
		status: async (path) => checkouts[path].dirty ?? "",
		branch: async (path) => checkouts[path].branch ?? "feat",
		containedBy: async () => "",
		realpath: (path) => path,
		removeWorktree: async (repoRoot, path) => {
			w.removed.push(path);
			delete checkouts[path];
		},
	};
	w.deps = (store, now = () => NOW) => ({ herdr: w.herdr, git: w.git, store, log: (line) => w.logs.push(line), now, config: {} });
	return w;
}

test("shellIsIdle", async () => {
	assert.equal(shellIsIdle(idle), true);
	assert.equal(shellIsIdle(busy), false);
	assert.equal(shellIsIdle({ shell_pid: 10, foreground_processes: [{ pid: 10 }, { pid: 11 }] }), false, "a child beside the shell is running work");
	assert.equal(shellIsIdle(undefined), false, "unreadable process info never counts as idle");
});

test("Scope: only linked-worktree workspaces", async () => {
	const result = await plan({
		workspaces: [workspace("w1", "main-checkout", { worktree: worktree("/repo", false) }), workspace("w2", "linked"), { workspace_id: "w3", label: "plain" }],
		panes: [pane("w1:p1", "w1"), pane("w2:p1", "w2"), pane("w3:p1", "w3")],
		state: state({ initialized: true, agentSeen: { "term_w1:p1": 1, "term_w2:p1": 1, "term_w3:p1": 1 } }),
	});
	assert.deepEqual(result.closes.map((close) => close.paneId), ["w2:p1"], "a workspace that is not a linked worktree is never touched, whatever it is named");
});

test("First run: agentless panes count as exited; later runs need a recorded agent", async () => {
	const first = await plan({ workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2")], state: state() });
	assert.equal(first.closes.length, 1, "first run closes an agentless pane");
	assert.ok(first.ops.some((op) => op.path[0] === "initialized"), "first run is recorded");
	const never = await plan({ workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2")], state: state({ initialized: true }) });
	assert.equal(never.closes.length, 0, "a shell that never ran an agent is the user's");
	const ran = await plan({ workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2")], state: state({ initialized: true, agentSeen: { "term_w2:p1": 1 } }) });
	assert.equal(ran.closes.length, 1, "a pane that ran an agent is closed once the agent is gone");
	const running = await plan({ workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2", { agent: "pi" })] });
	assert.equal(running.closes.length, 0);
	assert.deepEqual(running.ops.map((op) => [op.op, op.path[0]]), [["set", "agentSeen"]], "a running agent is recorded");
});

test("Safety: focused, busy, pinned", async () => {
	const seen = state({ initialized: true, agentSeen: { "term_w2:p1": 1 } });
	const focused = await plan({ workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2", { focused: true })], state: seen });
	assert.equal(focused.closes.length, 0);
	assert.match(focused.skips[0], /focused pane/);
	const running = await plan({ workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2")], state: seen }, { "w2:p1": busy });
	assert.equal(running.closes.length, 0);
	assert.match(running.skips[0], /vite is running/);
	const tokenPinned = await plan({ workspaces: [workspace("w2", "linked", { tokens: { [PIN_TOKEN]: PIN_GLYPH } })], panes: [pane("w2:p1", "w2")], state: seen });
	assert.equal(tokenPinned.closes.length, 0);
	assert.match(tokenPinned.skips[0], /pinned/);
	const statePinned = await plan({ workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2")], state: { ...seen, pins: { "/wt/linked": {} } } });
	assert.equal(statePinned.closes.length, 0, "a pin in the state file holds even when the token was lost");
});

test("Confirmation wait", async () => {
	const seen = state({ initialized: true, agentSeen: { "term_w2:p1": 1 } });
	const input = { workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2")], confirmMs: CONFIRM_MS };
	const first = await plan({ ...input, state: seen });
	assert.equal(first.closes.length, 0);
	assert.equal(first.nextAt, NOW + CONFIRM_MS, "the next sweep is due when the wait ends");
	assert.ok(first.ops.some((op) => op.path[0] === "candidates"));
	const later = await plan({ ...input, state: { ...seen, candidates: { "term_w2:p1": NOW - CONFIRM_MS } } });
	assert.equal(later.closes.length, 1, "closed once it has qualified for the whole wait");
	const busyAgain = await plan({ ...input, state: { ...seen, candidates: { "term_w2:p1": NOW - CONFIRM_MS } } }, { "w2:p1": busy });
	assert.ok(busyAgain.ops.some((op) => op.op === "del" && op.path[0] === "candidates"), "work in the shell restarts the wait");
});

test("Scope limit and expected workspace closing", async () => {
	const seen = state({ initialized: true, agentSeen: { "term_a:p1": 1, "term_a:p2": 1 } });
	const two = { workspaces: [workspace("a", "linked")], panes: [pane("a:p1", "a"), pane("a:p2", "a", { agent: "pi" })], state: seen };
	const partial = await plan(two);
	assert.equal(partial.closes.length, 1);
	assert.deepEqual(partial.expectClosed, [], "a workspace with a live agent pane stays open");
	const whole = await plan({ ...two, panes: [pane("a:p1", "a"), pane("a:p2", "a")] });
	assert.equal(whole.expectClosed.length, 1);
	assert.equal(whole.expectClosed[0].checkout, "/wt/linked");
	const outside = await plan({ ...two, panes: [pane("a:p1", "a")], config: { only_under: ["/elsewhere"] } });
	assert.equal(outside.closes.length, 0, "only_under keeps the plugin to the listed directories");
	const inside = await plan({ ...two, panes: [pane("a:p1", "a")], config: { only_under: ["/repo"] } });
	assert.equal(inside.closes.length, 1);
});

test("Checkout removal", async () => {
	const clean = { pinned: false, exists: true, dirty: "", detached: false, containedBy: "" };
	assert.equal(decideRemoval(clean).remove, true);
	assert.equal(decideRemoval({ ...clean, dirty: " M a.txt\n?? b.txt\n" }).remove, false, "uncommitted changes keep the checkout");
	assert.match(decideRemoval({ ...clean, dirty: " M a.txt\n" }).reason, /uncommitted/);
	assert.equal(decideRemoval({ ...clean, pinned: true }).remove, false);
	assert.equal(decideRemoval({ ...clean, exists: false }).remove, false);
	assert.equal(decideRemoval({ ...clean, detached: true }).remove, false, "a detached HEAD no ref contains would be lost");
	assert.equal(decideRemoval({ ...clean, detached: true, containedBy: "abc refs/heads/main" }).remove, true);
});

test("Checkout removal with submodules", async () => {
	const clean = { pinned: false, exists: true, dirty: "", detached: false, containedBy: "" };
	const sub = { path: "community", dirty: "", hidden: "", head: "abc1234def", kept: true, ahead: false };
	assert.equal(decideRemoval({ ...clean, submodules: [sub] }).remove, true);
	assert.equal(decideRemoval({ ...clean, submodules: [sub, { ...sub, path: "a/b" }] }).remove, true);
	assert.equal(decideRemoval({ ...clean, dirty: " M community\n", submodules: [{ ...sub, dirty: " M x\n?? y\n" }] }).reason, "submodule community has 2 uncommitted paths");
	assert.match(decideRemoval({ ...clean, submodules: [{ ...sub, hidden: "x" }] }).reason, /submodule community has 1 uncommitted paths/);
	assert.equal(decideRemoval({ ...clean, submodules: [{ ...sub, kept: false }] }).reason, "submodule community HEAD abc1234 is in no ref outside this worktree (no remote-tracking ref contains it)");
	assert.match(decideRemoval({ ...clean, submodules: [{ ...sub, ahead: true }] }).reason, /local branch with commits/);
	assert.match(decideRemoval({ ...clean, submodulesError: "boom" }).reason, /submodules could not be checked \(boom\)/);
	assert.equal(decideRemoval({ ...clean, dirty: " M a\n", submodules: [sub] }).remove, false, "the checkout's own checks still apply");
});

test("Renames", async () => {
	const linked = workspace("w2", "renamed");
	const known = (label) => state({ workspaces: { w2: { label, checkout: "/wt/renamed" } } });
	const user = onRename(linked, known("orig"));
	assert.equal(user.pin, true, "every rename pins: nothing renames a workspace but the user");
	assert.deepEqual(applyOps(known("orig"), user.ops).workspaces.w2, { label: "renamed", checkout: "/wt/renamed", renamed: true });
	assert.equal(onRename(linked, state()).pin, true, "a workspace without a record is pinned too");
	assert.equal(onRename({ ...linked, worktree: worktree("/repo", false) }, known("orig")).pin, true, "a main-checkout workspace too");
	assert.equal(onRename({ workspace_id: "w9", label: "plain" }, state()).pin, true, "and one without a checkout");
	assert.equal(onRename(linked, state({ workspaces: { w2: { label: "orig", checkout: "/wt/renamed" } }, pins: { "/wt/renamed": {} } })).pin, false, "already pinned");
	assert.equal(onRename(linked, known("renamed")).pin, true, "a sweep that recorded the new label first does not swallow the rename");
});

test("Workspace records", async () => {
	const first = applyOps(state(), noteWorkspaces([workspace("w1", "a")], state()));
	assert.deepEqual(first.workspaces.w1, { label: "a", checkout: "/wt/a" });
	const later = applyOps(first, noteWorkspaces([workspace("w1", "a"), workspace("w2", "b")], first));
	assert.deepEqual(Object.keys(later.workspaces).sort(), ["w1", "w2"]);
	const gone = applyOps(later, noteWorkspaces([workspace("w1", "a")], later));
	assert.equal("w2" in gone.workspaces, false, "closed workspaces are forgotten");
	assert.deepEqual(
		prunePanes([pane("p", "w1")], state({ agentSeen: { term_p: 1, term_gone: 1 }, candidates: { term_gone: 2 } })).map((op) => op.path.join("/")),
		["agentSeen/term_gone", "candidates/term_gone"],
	);
});

test("Pin toggle", async () => {
	const linked = workspace("w2", "feat-x");
	assert.deepEqual(togglePin(linked, state(), NOW), { action: "pin", key: "/wt/feat-x", entry: { auto: false, at: NOW } });
	assert.deepEqual(togglePin(linked, state({ pins: { "/wt/feat-x": {} } }), NOW), { action: "unpin", key: "/wt/feat-x" });
	assert.deepEqual(togglePin({ ...linked, tokens: { [PIN_TOKEN]: PIN_GLYPH } }, state(), NOW), { action: "unpin", key: "/wt/feat-x" }, "the token alone pins");
	assert.deepEqual(togglePin({ workspace_id: "w9", label: "plain" }, state(), NOW).key, "workspace:w9", "a workspace without a checkout is pinned by its id");
	assert.deepEqual(togglePin(parentShell(), state(), NOW).key, "workspace:m", "so is a main checkout's: the pin goes with the workspace");
	const old = state({ pins: { "/repo": { preLabel: "repo" }, "/wt/child": {}, "/elsewhere": {} } });
	const migrated = applyOps(old, migratePins([parentShell("m"), parentShell("m2"), childOf()], old));
	assert.deepEqual(Object.keys(migrated.pins).sort(), ["/elsewhere", "/wt/child", "workspace:m", "workspace:m2"], "an old main-checkout pin moves to the ids of the workspaces on it");
});

test("State store: ops merge, locks exclude", async () => {
	const dir = await tempDir();
	try {
		const store = createStore(dir);
		await Promise.all([1, 2, 3, 4, 5].map((n) => store.apply([{ op: "set", path: ["agentSeen", `k${n}`], value: n }])));
		assert.deepEqual(Object.keys((await store.read()).agentSeen).sort(), ["k1", "k2", "k3", "k4", "k5"], "concurrent writers keep each other's keys");
		const held = await withLock(dir, "x", async () => (await withLock(dir, "x", async () => 1, { waitMs: 0 })).held);
		assert.equal(held.value, true, "a held lock is reported, not waited for");
		assert.equal((await withLock(dir, "x", async () => 1)).value, 1, "and released afterwards");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Sweeps close clean checkouts' workspaces, keep dirty ones, and skip pinned ones", async () => {
	const dir = await tempDir();
	try {
		const w = world({
			workspaces: [workspace("a", "clean"), workspace("b", "dirty"), workspace("c", "pinned"), workspace("d", "alive"), workspace("m", "main", { worktree: worktree("/repo", false) })],
			panes: [pane("a:p1", "a"), pane("b:p1", "b"), pane("c:p1", "c"), pane("d:p1", "d", { agent: "pi" }), pane("m:p1", "m")],
			checkouts: { "/wt/clean": {}, "/wt/dirty": { dirty: " M x\n" }, "/wt/pinned": {}, "/wt/alive": {} },
		});
		const store = createStore(dir);
		await store.apply([{ op: "set", path: ["pins", "/wt/pinned"], value: {} }]);

		await runSweep(w.deps(store), { confirmMs: 0, dryRun: true });
		assert.deepEqual(w.calls, [], "a dry run closes nothing");
		assert.ok(w.logs.some((line) => line.startsWith("would close a:p1")), w.logs.join("\n"));
		assert.ok(w.logs.some((line) => line.startsWith("would remove checkout /wt/clean")));
		assert.ok(w.logs.some((line) => line.startsWith("would keep checkout /wt/dirty") && line.includes("uncommitted")));
		assert.equal((await store.read()).initialized, false, "and writes no state");
		assert.equal(w.tokens.length, 0, "and touches no token");

		w.logs.length = 0;
		await runSweep(w.deps(store), { confirmMs: CONFIRM_MS });
		assert.deepEqual(w.calls, [], "the first sweep only starts the confirmation wait");
		assert.ok(w.logs.some((line) => line.startsWith("wait clean (a:p1)")));
		assert.ok(w.tokens.some((call) => call[0] === "set" && call[1] === "c" && call[3] === PIN_TOKEN), "a pinned workspace gets its token back");
		assert.ok(w.logs.some((line) => line.startsWith("skip pinned (c:p1): workspace is pinned")));
		assert.deepEqual(Object.keys((await store.read()).agentSeen).sort(), ["term_a:p1", "term_b:p1", "term_d:p1"], "the first run marks the leftovers and the running agent, not the pinned pane");
		assert.equal((await store.read()).nextSweepAt, NOW + CONFIRM_MS, "and the next sweep waits only that long");

		w.logs.length = 0;
		const later = NOW + CONFIRM_MS + 1;
		await runSweep(w.deps(store, () => later), { confirmMs: CONFIRM_MS });
		assert.deepEqual(w.calls.sort(), ["close a:p1", "close b:p1"], w.logs.join("\n"));
		assert.deepEqual(w.removed, ["/wt/clean"], "only the clean checkout goes");
		assert.ok(w.logs.some((line) => line.startsWith("keep checkout /wt/dirty") && line.includes("branch kept")));
		assert.deepEqual(w.workspaces.map((candidate) => candidate.workspace_id).sort(), ["c", "d", "m"]);
		assert.equal((await store.read()).nextSweepAt, later + SWEEP_INTERVAL_MS, "an idle sweep waits the full interval");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A workspace that does not close stays pending and is finished by a later sweep", async () => {
	const dir = await tempDir();
	try {
		const slow = world({ workspaces: [workspace("a", "slow")], panes: [pane("a:p1", "a")], checkouts: { "/wt/slow": {} } });
		slow.herdr.closePane = async (id) => {
			slow.calls.push(`close ${id}`);
			slow.panes = [];
		};
		const store = createStore(dir);
		const realNow = Date.now;
		let clock = realNow();
		Date.now = () => (clock += 3000);
		try {
			await runSweep(slow.deps(store), { confirmMs: 0 });
		} finally {
			Date.now = realNow;
		}
		assert.deepEqual(slow.removed, [], "an open workspace keeps its checkout");
		assert.ok((await store.read()).pending["/wt/slow"]);
		slow.workspaces = [];
		await runSweep(slow.deps(store, () => NOW + 1000), { confirmMs: 0 });
		assert.deepEqual(slow.removed, ["/wt/slow"], "the next sweep removes it once the workspace is gone");
		assert.equal(Object.keys((await store.read()).pending).length, 0);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("First sweep on a machine: leftovers close at once with reap-now", async () => {
	const dir = await tempDir();
	try {
		const w = world({ workspaces: [workspace("a", "left")], panes: [pane("a:p1", "a")], checkouts: { "/wt/left": {} } });
		await runSweep(w.deps(createStore(dir)), { confirmMs: 0 });
		assert.deepEqual(w.calls, ["close a:p1"]);
		assert.deepEqual(w.removed, ["/wt/left"]);
		assert.deepEqual(w.workspaces, []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Events and the pin action", async () => {
	const dir = await tempDir();
	try {
		const w = world({ workspaces: [workspace("a", "orig")], panes: [pane("a:p1", "a")] });
		let now = NOW;
		const deps = w.deps(createStore(dir), () => now);
		await runEvent(deps, "workspace.created", { workspace: { workspace_id: "a" } });
		assert.deepEqual((await deps.store.read()).workspaces.a, { label: "orig", checkout: "/wt/orig" }, "created is recorded from the event");

		now = NOW + 1000;
		w.workspaces[0].label = "my-name";
		await runEvent(deps, "workspace.renamed", { workspace_id: "a", label: "my-name" });
		assert.deepEqual(w.tokens, [["set", "a", SOURCE, PIN_TOKEN, PIN_GLYPH]], "a rename pins at once, however soon after the workspace appeared");
		assert.deepEqual((await deps.store.read()).pins["/wt/orig"], { auto: true, at: now });
		assert.ok(w.logs.some((line) => line.startsWith("auto-pin my-name")), w.logs.join("\n"));

		await runPinToggle(deps, "a");
		assert.equal(w.workspaces[0].label, "my-name", "unpin leaves the name alone");
		assert.deepEqual(w.tokens.at(-1), ["clear", "a", SOURCE, PIN_TOKEN]);
		assert.deepEqual((await deps.store.read()).pins, {});

		await runPinToggle(deps, "a");
		assert.deepEqual((await deps.store.read()).pins["/wt/orig"], { auto: false, at: now }, "pin again by hand");
		assert.equal(w.workspaces[0].tokens[PIN_TOKEN], PIN_GLYPH);

		w.workspaces[0].label = "other-name";
		await runEvent(deps, "workspace.renamed", { workspace_id: "a", label: "other-name" });
		assert.equal(w.tokens.filter((call) => call[0] === "set").length, 2, "renaming a pinned workspace pins nothing new");

		// An agent released schedules a sweep one confirmation wait later; an agent detected is recorded.
		await runEvent(deps, "pane.agent_detected", { pane_id: "a:p1", agent: "pi", released: true, final_status: "unknown" });
		const afterRelease = await deps.store.read();
	assert.equal(afterRelease.nextSweepAt, now + CONFIRM_MS + 2000);
	assert.equal(afterRelease.candidates["term_a:p1"], now, "the released pane qualifies from the release on, so the sweep due then closes it");
		await runEvent(deps, "pane.agent_detected", { pane_id: "a:p1", agent: "pi" });
		assert.ok("term_a:p1" in (await deps.store.read()).agentSeen);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A released agent's pane is closed by the sweep the release scheduled, not a wait later", async () => {
	const dir = await tempDir();
	try {
		const w = world({ workspaces: [workspace("a", "done")], panes: [pane("a:p1", "a", { agent: "pi" }), pane("a:p2", "a", { agent: "pi" })], checkouts: { "/wt/done": {} } });
		let now = NOW;
		const deps = w.deps(createStore(dir), () => now);
		await runSweep(deps, { confirmMs: CONFIRM_MS });
		assert.deepEqual(w.calls, [], "running agents are recorded and left alone");
		w.panes = w.panes.map((candidate) => ({ ...candidate, agent: undefined }));
		now = NOW + 1000;
		await runEvent(deps, "pane.agent_detected", { pane_id: "a:p1", agent: "pi", released: true, final_status: "unknown" });
		await runEvent(deps, "pane.agent_detected", { pane_id: "a:p2", agent: "pi", released: true, final_status: "unknown" });
		now = (await deps.store.read()).nextSweepAt;
		assert.equal(now, NOW + 1000 + CONFIRM_MS + 2000);
		await runSweep(deps, { confirmMs: CONFIRM_MS });
		assert.deepEqual(w.calls.sort(), ["close a:p1", "close a:p2"], w.logs.join("\n"));
		assert.deepEqual(w.removed, ["/wt/done"], "the last pane takes the workspace, and its clean checkout, with it");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A created event overrides the record of a reused workspace id", () => {
	const stale = state({ workspaces: { w2: { label: "old workspace", renamed: true } } });
	const fresh = applyOps(stale, noteWorkspaces([workspace("w2", "new")], stale, new Set(["w2"])));
	assert.deepEqual(fresh.workspaces.w2, { label: "new", checkout: "/wt/new" });
});

test("Pins of workspaces and checkouts that are gone are forgotten", () => {
	const pins = { "/wt/here": {}, "/wt/gone": {}, "workspace:w1": {}, "workspace:w9": {} };
	const ops = prunePins([workspace("w1", "x")], state({ pins }), { exists: (path) => path === "/wt/here" });
	assert.deepEqual(ops.map((op) => op.path[1]).sort(), ["/wt/gone", "workspace:w9"]);
});

test("The pin token is a Nerd Font glyph, not an emoji", () => {
	assert.equal(PIN_GLYPH.codePointAt(0), 0xf0403);
	assert.equal(PIN_TOKEN, "pin");
});

test("findCheckoutUser: a pane's cwd or foreground cwd at or below the checkout, or a workspace on it", () => {
	const roots = ["/wt/x"];
	const other = workspace("o", "other");
	assert.equal(findCheckoutUser(roots, [pane("o:p1", "o", { cwd: "/repo", foreground_cwd: "/repo" })], [other]), null);
	assert.match(findCheckoutUser(roots, [pane("o:p1", "o", { cwd: "/wt/x" })], [other]), /pane o:p1/);
	assert.match(findCheckoutUser(roots, [pane("o:p1", "o", { cwd: "/repo", foreground_cwd: "/wt/x/src" })], [other]), /pane o:p1/, "the foreground process counts too");
	assert.equal(findCheckoutUser(roots, [pane("o:p1", "o", { cwd: "/wt/xyz" })], [other]), null, "a sibling directory with the same prefix is not inside");
	assert.match(findCheckoutUser(roots, [], [workspace("n", "same", { worktree: worktree("/wt/x") })]), /workspace same/);
	assert.equal(findCheckoutUser(roots, [pane("o:p1", "o", { cwd: "/wt/x" })], [workspace("n", "same", { worktree: worktree("/wt/x") })], { panes: new Set(["o:p1"]), workspaces: new Set(["n"]) }), null, "what the run closes is ignored");
	assert.match(findCheckoutUser(["/private/wt/x", "/wt/x"], [pane("o:p1", "o", { cwd: "/private/wt/x/a" })], []), /pane o:p1/, "every spelling of the path counts");
});

test("A clean checkout another workspace's pane works in is kept, in normal, pending and dry runs", async () => {
	const dir = await tempDir();
	try {
		// The pi-herdr-agents layout: the worker's pane sits in the parent's workspace, in the linked checkout.
		const make = () =>
			world({
				workspaces: [workspace("a", "linked"), workspace("p", "parent", { worktree: worktree("/repo", false) }), workspace("q", "other-ws", { worktree: worktree("/elsewhere") })],
				panes: [pane("a:p1", "a"), pane("p:p1", "p", { agent: "pi", cwd: "/repo", foreground_cwd: "/wt/linked/app" }), pane("q:p1", "q", { agent: "pi" })],
				checkouts: { "/wt/linked": {} },
			});
		const w = make();
		const store = createStore(dir);
		await runSweep(w.deps(store), { confirmMs: 0, dryRun: true });
		assert.ok(w.logs.some((line) => line.startsWith("would keep checkout /wt/linked") && line.includes("pane p:p1")), w.logs.join("\n"));
		await runSweep(w.deps(store), { confirmMs: 0 });
		assert.deepEqual(w.calls, ["close a:p1"], "the idle leftover pane still closes");
		assert.deepEqual(w.removed, [], "but the checkout stays while that pane works in it");
		assert.ok(w.logs.some((line) => line.startsWith("keep checkout /wt/linked") && line.includes("pane p:p1")));

		// The pending path: the workspace closed in an earlier run, and by now a new workspace opened on the same checkout.
		const later = make();
		later.workspaces = [workspace("n", "reopened", { worktree: worktree("/wt/linked") })];
		later.panes = [pane("n:p1", "n", { agent: "pi" })];
		const pendingStore = createStore(await tempDir());
		await pendingStore.apply([{ op: "set", path: ["pending", "/wt/linked"], value: { workspaceId: "a", label: "linked", repoRoot: "/repo", since: NOW } }]);
		await runSweep(later.deps(pendingStore, () => NOW + 1000), { confirmMs: 0 });
		assert.deepEqual(later.removed, []);
		assert.ok(later.logs.some((line) => line.startsWith("keep checkout /wt/linked") && line.includes("workspace reopened")), later.logs.join("\n"));
		assert.equal((await pendingStore.read()).pending["/wt/linked"]?.inUse, true, "the entry stays, marked in use, until the workspace is gone");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A checkout is kept when Herdr cannot be listed again", async () => {
	const dir = await tempDir();
	try {
		const w = world({ workspaces: [workspace("a", "left")], panes: [pane("a:p1", "a")], checkouts: { "/wt/left": {} } });
		let lists = 0;
		const list = w.herdr.listPanes;
		w.herdr.listPanes = async () => {
			if (++lists > 1) throw new Error("herdr pane list failed: server gone");
			return list();
		};
		await runSweep(w.deps(createStore(dir)), { confirmMs: 0 });
		assert.deepEqual(w.removed, []);
		assert.ok(w.logs.some((line) => line.startsWith("keep checkout /wt/left") && line.includes("could not be listed")), w.logs.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// Real git, in scratch repositories: the clean check must see what a plain `git status` can be configured not to show.
const sh = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

test("Clean check sees untracked files despite status.showUntrackedFiles=no, and skip-worktree or assume-unchanged edits", async () => {
	const root = await tempDir();
	try {
		const repo = join(root, "repo");
		execFileSync("mkdir", ["-p", repo]);
		sh(repo, "init", "-q", "-b", "main");
		await writeFile(join(repo, "a.txt"), "a\n");
		await writeFile(join(repo, "b.txt"), "b\n");
		sh(repo, "add", ".");
		sh(repo, "commit", "-q", "-m", "init");
		const checkout = (name) => {
			const path = join(root, name);
			sh(repo, "worktree", "add", "-q", "-b", name, path);
			return path;
		};
		const git = gitClient();
		const clean = checkout("clean");
		assert.equal(await git.status(clean), "");
		assert.equal(await git.hidden(clean), "");

		const quiet = checkout("quiet");
		sh(repo, "config", "status.showUntrackedFiles", "no");
		await writeFile(join(quiet, "untracked.txt"), "secret\n");
		assert.equal(sh(quiet, "status", "--porcelain"), "", "a plain status is configured to say nothing");
		assert.match(await git.status(quiet), /\?\? untracked\.txt/, "the reaper's status says it");
		sh(repo, "config", "--unset", "status.showUntrackedFiles");

		const skipped = checkout("skipped");
		sh(skipped, "update-index", "--skip-worktree", "a.txt");
		await writeFile(join(skipped, "a.txt"), "edited\n");
		assert.equal(sh(skipped, "status", "--porcelain"), "", "skip-worktree hides the edit from status");
		assert.equal(await git.hidden(skipped), "a.txt");

		const sparse = checkout("sparse");
		sh(sparse, "update-index", "--skip-worktree", "b.txt");
		await rm(join(sparse, "b.txt"));
		assert.equal(await git.hidden(sparse), "", "a skip-worktree file left out of a sparse checkout hides nothing");
		assert.equal(await git.status(sparse), "");

		const assumed = checkout("assumed");
		sh(assumed, "update-index", "--assume-unchanged", "b.txt");
		await writeFile(join(assumed, "b.txt"), "edited\n");
		assert.equal(await git.hidden(assumed), "b.txt");

		// A sweep with the real git client keeps all three and removes only the clean one.
		const w = world({
			workspaces: ["clean", "quiet", "skipped", "assumed"].map((name) => workspace(`w${name}`, name, { worktree: worktree(join(root, name), true, repo) })),
			panes: ["clean", "quiet", "skipped", "assumed"].map((name) => pane(`w${name}:p1`, `w${name}`)),
		});
		w.git = { ...gitClient() };
		sh(repo, "config", "status.showUntrackedFiles", "no");
		await runSweep(w.deps(createStore(join(root, "state"))), { confirmMs: 0 });
		assert.equal(sh(repo, "worktree", "list", "--porcelain").includes(join(root, "clean")), false, "the clean checkout is removed");
		for (const name of ["quiet", "skipped", "assumed"]) assert.ok(sh(repo, "worktree", "list", "--porcelain").includes(join(root, name)), `${name} stays`);
		assert.ok(w.logs.some((line) => line.includes("keep checkout") && line.includes(join(root, "quiet")) && line.includes("uncommitted")), w.logs.join("\n"));
		assert.ok(w.logs.some((line) => line.includes(join(root, "skipped")) && line.includes("skip-worktree or assume-unchanged")), w.logs.join("\n"));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("A checkout kept for a worker pane in another workspace is removed once that pane is gone", async () => {
	const dir = await tempDir();
	try {
		const w = world({
			workspaces: [workspace("a", "linked"), workspace("p", "parent", { worktree: worktree("/repo", false) })],
			panes: [pane("a:p1", "a"), pane("p:p1", "p", { agent: "pi", cwd: "/repo", foreground_cwd: "/wt/linked/app" })],
			checkouts: { "/wt/linked": {} },
		});
		const store = createStore(dir);
		await runSweep(w.deps(store), { confirmMs: 0 });
		assert.deepEqual(w.removed, []);
		assert.equal((await store.read()).pending["/wt/linked"]?.inUse, true, "kept for a pane that works in it");
		// Hours later: the entry has not expired, and the worker is still there.
		await runSweep(w.deps(store, () => NOW + 5 * 60 * 60_000), { confirmMs: 0 });
		assert.deepEqual(w.removed, []);
		assert.equal((await store.read()).pending["/wt/linked"]?.inUse, true, "still pending, not deleted");
		w.panes = w.panes.filter((candidate) => candidate.pane_id !== "p:p1");
		await runSweep(w.deps(store, () => NOW + 6 * 60 * 60_000), { confirmMs: 0 });
		assert.deepEqual(w.removed, ["/wt/linked"]);
		assert.deepEqual((await store.read()).pending, {});
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A removal killed by its timeout is logged as possibly half-removed", async () => {
	const dir = await tempDir();
	try {
		const w = world({ workspaces: [workspace("a", "slow")], panes: [pane("a:p1", "a")], checkouts: { "/wt/slow": {} } });
		w.git.removeWorktree = async () => {
			throw Object.assign(new Error("git worktree remove did not finish within 300s"), { timedOut: true });
		};
		await runSweep(w.deps(createStore(dir)), { confirmMs: 0 });
		assert.ok(w.logs.some((line) => line.includes("/wt/slow") && line.includes("half-removed") && !line.includes("refused")), w.logs.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A failed removal logs git's own reason, and says plainly when it left a half-removed checkout", async () => {
	const cases = {
		"refused, checkout intact": ["intact", /^keep checkout \/wt\/x: git refused to remove it: fatal: working trees containing submodules cannot be moved or removed, branch feat kept$/],
		"failed partway, no longer tracked": ["half-removed", /^keep checkout \/wt\/x: git refused to remove it: error: failed to delete '\/wt\/x': Directory not empty; it is half-removed: leftover files remain at \/wt\/x, git no longer tracks it, branch feat kept; delete the directory/],
		"timed out, no longer tracked": ["half-removed", /^keep checkout \/wt\/x: removal timed out \(git worktree remove did not finish within 300s\); it is half-removed: leftover files remain at \/wt\/x, git no longer tracks it, branch feat kept; delete the directory/],
		"timed out, checkout intact": ["intact", /^keep checkout \/wt\/x: removal timed out \(git worktree remove did not finish within 300s\), branch feat kept$/],
	};
	for (const [name, [left, expected]] of Object.entries(cases)) {
		const dir = await tempDir();
		try {
			const w = world({ workspaces: [workspace("a", "x")], panes: [pane("a:p1", "a")], checkouts: { "/wt/x": {} } });
			w.git.leftover = async () => left;
			w.git.removeWorktree = async () => {
				if (name.startsWith("timed out")) throw Object.assign(new Error("git worktree remove did not finish within 300s"), { timedOut: true });
				throw new Error(name.includes("intact") ? "fatal: working trees containing submodules cannot be moved or removed" : "error: failed to delete '/wt/x': Directory not empty");
			};
			await runSweep(w.deps(createStore(dir)), { confirmMs: 0 });
			assert.ok(w.logs.some((line) => expected.test(line)), `${name}: ${w.logs.join("\n")}`);
			assert.ok(w.logs.every((line) => !line.includes("Command failed")), name);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("gitReason takes git's own fatal or error line and drops node's Command failed header", () => {
	const failed = (stderr, message = "Command failed: git -C /repo worktree remove /wt\n" + stderr) => Object.assign(new Error(message), { stderr });
	assert.equal(gitReason(failed("fatal: working trees containing submodules cannot be moved or removed\n")), "fatal: working trees containing submodules cannot be moved or removed");
	assert.equal(gitReason(failed("hint: something\nerror: failed to delete '/wt': Directory not empty\nerror: second\n")), "error: failed to delete '/wt': Directory not empty");
	assert.equal(gitReason(failed("just a line\nanother\n")), "just a line", "no fatal or error prefix: the first stderr line");
	assert.equal(gitReason(failed("", "Command failed: git -C /repo worktree remove /wt\n")), "git failed without a message");
	assert.equal(gitReason(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })), "spawn git ENOENT");
});

// A real removal git refuses (a submodule) and one it abandons partway (an unreadable directory): git's reason and what is left.
test("Real git: a submodule checkout is refused and stays; a removal that fails partway is reported half-removed and nothing is deleted", async () => {
	const root = await mkdtemp(join(tmpdir(), "pane-reaper-git-"));
	try {
		const sub = join(root, "sub");
		const repo = join(root, "repo");
		for (const path of [sub, repo]) {
			await mkdir(path);
			sh(path, "init", "-q", "-b", "main");
			await writeFile(join(path, "f.txt"), "x");
			sh(path, "add", "f.txt");
			sh(path, "commit", "-q", "-m", "init");
		}
		execFileSync("git", ["-c", "protocol.file.allow=always", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "submodule", "add", "-q", sub, "vendor"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
		sh(repo, "commit", "-q", "-m", "submodule");
		const withSub = join(root, "with-sub");
		const partial = join(root, "partial");
		sh(repo, "worktree", "add", "-q", withSub, "-b", "has-sub");
		execFileSync("git", ["-c", "protocol.file.allow=always", "-C", withSub, "submodule", "update", "--init"], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
		sh(repo, "worktree", "add", "-q", partial, "-b", "partial");
		await mkdir(join(partial, "cache", "inner"), { recursive: true });
		await writeFile(join(partial, "cache", "inner", "f"), "x");
		await writeFile(join(repo, ".git", "info", "exclude"), "cache\n");
		await chmod(join(partial, "cache", "inner"), 0o555);

		const git = gitClient();
		const submodule = await git.removeWorktree(repo, withSub).then(() => null, (error) => error);
		assert.match(submodule.message, /^fatal: .*submodules cannot be moved or removed$/, submodule.message);
		assert.equal(await git.leftover(repo, withSub), "intact");

		const half = await git.removeWorktree(repo, partial).then(() => null, (error) => error);
		assert.match(half.message, /^error: failed to delete /, half?.message);
		assert.equal(await git.leftover(repo, partial), "half-removed", "the directory is there, git no longer registers it");

		const w = world({ workspaces: [workspace("a", "x", { worktree: worktree(withSub, true, repo) }), workspace("b", "y", { worktree: worktree(partial, true, repo) })], panes: [pane("a:p1", "a"), pane("b:p1", "b")] });
		w.git = { ...git, status: async () => "", hidden: async () => "", branch: async (path) => (path === withSub ? "has-sub" : "partial"), containedBy: async () => "", submodules: async () => [] };
		await runSweep(w.deps(createStore(join(root, "state"))), { confirmMs: 0 });
		assert.ok(w.logs.some((line) => line.startsWith(`keep checkout ${withSub}: git refused to remove it: fatal: `) && line.endsWith(", branch has-sub kept")), w.logs.join("\n"));
		assert.ok(w.logs.some((line) => line.startsWith(`keep checkout ${partial}:`) && line.includes(`leftover files remain at ${partial}, git no longer tracks it, branch partial kept`)), w.logs.join("\n"));
		assert.ok(w.logs.every((line) => !line.includes("Command failed")), w.logs.join("\n"));
		assert.ok(sh(repo, "branch", "--list", "partial").includes("partial"), "the branch is kept");
		assert.ok(sh(repo, "worktree", "list", "--porcelain").includes(withSub), "the refused checkout is still registered");
	} finally {
		await chmod(join(root, "partial", "cache", "inner"), 0o755).catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
});

test("Each pane is looked at again right before it is closed", async () => {
	// Every case changes the world after the plan took its snapshot (the first pane list) and before the close.
	const cases = {
		"focused in the meantime": [(w) => (w.panes[0].focused = true), /it is focused now/],
		"an agent resumed": [(w) => (w.panes[0].agent = "pi"), /pi started in it again/],
		"the workspace got the pin token": [(w) => (w.workspaces[0].tokens = { [PIN_TOKEN]: PIN_GLYPH }), /workspace is pinned now/],
		"the pin was written to the state file": [(w, store) => store.apply([{ op: "set", path: ["pins", "/wt/left"], value: {} }]), /workspace is pinned now/],
		"a command started in the shell": [(w) => (w.busyNow = true), /shell is running something now/],
		"the pane id was reused by another terminal": [(w) => (w.panes[0].terminal_id = "term_other"), /another terminal/],
		"the pane vanished": [(w) => (w.panes = []), /could not be looked at again/],
	};
	for (const [name, [change, expected]] of Object.entries(cases)) {
		const dir = await tempDir();
		try {
			const w = world({ workspaces: [workspace("a", "left")], panes: [pane("a:p1", "a")], checkouts: { "/wt/left": {} } });
			const store = createStore(dir);
			let lists = 0;
			const list = w.herdr.listPanes;
			w.herdr.listPanes = async () => {
				const snapshot = await list();
				if (++lists === 1) await change(w, store);
				return snapshot;
			};
			// The plan's look finds the shell idle; any later look finds the command.
			let looks = 0;
			w.herdr.processInfo = async () => (w.busyNow && ++looks > 1 ? busy : idle);
			const getPane = w.herdr.getPane;
			w.herdr.getPane = async (id) => {
				const found = await getPane(id);
				if (!found) throw new Error(`herdr pane get failed: pane_not_found ${id}`);
				return found;
			};
			await runSweep(w.deps(store), { confirmMs: 0 });
			assert.deepEqual(w.calls, [], `${name}: nothing is closed`);
			assert.deepEqual(w.removed, [], `${name}: the checkout stays`);
			assert.ok(w.logs.some((line) => line.startsWith("skip left (a:p1)") && expected.test(line)), `${name}: ${w.logs.join(" | ")}`);
			assert.ok((await store.read()).pending["/wt/left"], `${name}: the checkout waits for a later sweep`);
			assert.equal((await store.read()).pending["/wt/left"].inUse, undefined, `${name}: and expires like any pending entry`);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("A reused workspace id does not inherit the closed workspace's record or pin", async () => {
	const dir = await tempDir();
	try {
		// Workspace A (id wX, checkout /wt/old, renamed and pinned by its id) closed; workspace B reuses wX.
		const record = { label: "old-label", checkout: "/wt/old", renamed: true };
		const seed = async () => {
			const store = createStore(await tempDir());
			await store.apply([{ op: "set", path: ["workspaces", "wX"], value: record }, { op: "set", path: ["pins", "workspace:wX"], value: {} }]);
			return store;
		};
		const reused = workspace("wX", "new-label", { worktree: worktree("/wt/new") });

		// With the closed hook: the record and the id-keyed pin are gone before B appears.
		const hooked = await seed();
		const w = world({ workspaces: [], panes: [] });
		await runEvent(w.deps(hooked, () => NOW), "workspace.closed", { workspace_id: "wX" });
		const afterClose = await hooked.read();
		assert.deepEqual([afterClose.workspaces.wX, afterClose.pins["workspace:wX"]], [undefined, undefined]);
		w.workspaces = [{ workspace_id: "wX", label: "no-checkout" }];
		await runEvent(w.deps(hooked, () => NOW + 1000), "workspace.created", { workspace: { workspace_id: "wX" } });
		assert.deepEqual((await hooked.read()).workspaces.wX, { label: "no-checkout", checkout: null });
		assert.equal(isPinned(w.workspaces[0], await hooked.read()), false, "B, also without a checkout, is not pinned by A's id");

		// Without the hook (it has not run yet): the record is another checkout's, so it is ignored and then replaced.
		const stale = await seed();
		const v = world({ workspaces: [reused], panes: [pane("wX:p1", "wX")] });
		assert.equal(onRename(reused, await stale.read()).ops[0].value.label, "new-label");
		await runEvent(v.deps(stale, () => NOW), "workspace.created", { workspace: { workspace_id: "wX" } });
		assert.deepEqual((await stale.read()).workspaces.wX, { label: "new-label", checkout: "/wt/new" }, "not renamed: the name is not the user's");

		// A closed event that arrives after the id was reused leaves the new workspace's record alone, and replaces a stale one.
		const late = await seed();
		await late.apply([{ op: "set", path: ["workspaces", "wX"], value: { label: "new-label", checkout: "/wt/new" } }]);
		await runEvent(v.deps(late, () => NOW + 5000), "workspace.closed", { workspace_id: "wX" });
		assert.equal((await late.read()).workspaces.wX.label, "new-label");
		await late.apply([{ op: "set", path: ["workspaces", "wX"], value: record }]);
		await runEvent(v.deps(late, () => NOW + 6000), "workspace.closed", { workspace: { workspace_id: "wX" } });
		assert.equal((await late.read()).workspaces.wX, undefined);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A sweep forgets the records of the workspaces it closed", async () => {
	const dir = await tempDir();
	try {
		const w = world({ workspaces: [workspace("a", "left"), workspace("b", "stays")], panes: [pane("a:p1", "a"), pane("b:p1", "b", { agent: "pi" })], checkouts: { "/wt/left": {}, "/wt/stays": {} } });
		const store = createStore(dir);
		await runSweep(w.deps(store), { confirmMs: 0 });
		const after = await store.read();
		assert.equal("a" in after.workspaces, false, "the closed workspace's record is gone");
		assert.equal(after.workspaces.b.checkout, "/wt/stays", "an open one keeps its record, with its checkout");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("An agent event whose terminal is not the pane's current one is ignored", async () => {
	const dir = await tempDir();
	try {
		const w = world({ workspaces: [workspace("a", "x")], panes: [pane("a:p1", "a")] });
		const deps = w.deps(createStore(dir), () => NOW);
		await runEvent(deps, "pane.agent_detected", { pane_id: "a:p1", terminal_id: "term_old", agent: "pi", released: true });
		assert.deepEqual((await deps.store.read()).agentSeen, {}, "the pane id now names another terminal");
		await runEvent(deps, "pane.agent_detected", { pane_id: "a:p1", terminal_id: "term_a:p1", agent: "pi" });
		assert.ok("term_a:p1" in (await deps.store.read()).agentSeen);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("First run: a pinned, focused or busy pane is not marked as one that ran an agent", async () => {
	const result = await plan(
		{
			workspaces: [workspace("a", "left"), workspace("b", "pinned", { tokens: { [PIN_TOKEN]: PIN_GLYPH } }), workspace("c", "busy")],
			panes: [pane("a:p1", "a"), pane("a:p2", "a", { focused: true }), pane("b:p1", "b"), pane("c:p1", "c")],
			state: state(),
		},
		{ "c:p1": busy },
	);
	assert.deepEqual(result.closes.map((close) => close.paneId), ["a:p1"]);
	assert.deepEqual(result.ops.filter((op) => op.path[0] === "agentSeen").map((op) => op.path[1]), ["term_a:p1"]);
	// Later runs: those panes are the user's shells, so unpinning or leaving the focus does not make them leftovers.
	const later = await plan({
		workspaces: [workspace("a", "left"), workspace("b", "pinned"), workspace("c", "busy")],
		panes: [pane("a:p2", "a"), pane("b:p1", "b"), pane("c:p1", "c")],
		state: applyOps(state(), result.ops),
	});
	assert.deepEqual(later.closes, []);
});

test("A pane whose process info cannot be read is skipped, and the sweep goes on", async () => {
	const seen = state({ initialized: true, agentSeen: { "term_a:p1": 1, "term_b:p1": 1 } });
	const result = await planSweep(
		{ now: NOW, confirmMs: 0, config: {}, state: seen, workspaces: [workspace("a", "x"), workspace("b", "y")], panes: [pane("a:p1", "a"), pane("b:p1", "b")] },
		{ processInfo: async (id) => (id === "a:p1" ? Promise.reject(new Error("pane_not_found")) : idle) },
	);
	assert.deepEqual(result.closes.map((close) => close.paneId), ["b:p1"]);
	assert.ok(result.skips.some((line) => line.includes("a:p1") && line.includes("process info unavailable")));
});

test("A damaged or unreadable state file fails instead of reading as empty", async () => {
	const dir = await tempDir();
	try {
		const store = createStore(dir);
		assert.equal((await store.read()).initialized, false, "no file is an empty state");
		await store.apply([{ op: "set", path: ["pins", "/wt/keep"], value: {} }, { op: "set", path: ["initialized"], value: true }]);
		await writeFile(join(dir, "state.json"), '{"pins": {"/wt/ke');
		await assert.rejects(store.read(), /damaged/);
		await writeFile(join(dir, "state.json"), "[]");
		await assert.rejects(store.read(), /damaged/);
		await rm(join(dir, "state.json"));
		execFileSync("mkdir", [join(dir, "state.json")]);
		await assert.rejects(store.read(), /cannot read the state file/, "an error other than a missing file is not an empty state");
		await rm(join(dir, "state.json"), { recursive: true });

		// A sweep over a damaged file closes nothing and says why.
		await writeFile(join(dir, "state.json"), "not json");
		const w = world({ workspaces: [workspace("a", "left")], panes: [pane("a:p1", "a")], checkouts: { "/wt/left": {} } });
		await assert.rejects(runSweep(w.deps(store), { confirmMs: 0 }), /damaged/);
		assert.deepEqual(w.calls, []);
		await assert.rejects(runEvent(w.deps(store), "workspace.created", { workspace_id: "a" }), /damaged/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A stale lock is taken over by one waiter only; a fresh lock is never removed by a late judge", async () => {
	const dir = await tempDir();
	try {
		const lock = join(dir, "race.lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner"), "dead");
		const long = new Date(Date.now() - 3_600_000);
		await utimes(lock, long, long);
		let active = 0;
		let overlaps = 0;
		let done = 0;
		await Promise.all(
			Array.from({ length: 12 }, async () => {
				const outcome = await withLock(dir, "race", async () => {
					if (++active > 1) overlaps++;
					await new Promise((resolve) => setTimeout(resolve, 15));
					active--;
					done++;
				}, { waitMs: 10_000, staleMs: 1000 });
				assert.equal(outcome.held, false);
			}),
		);
		assert.equal(done, 12);
		assert.equal(overlaps, 0, "no two holders at once");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A lock held longer than staleMs stays held while its holder works", async () => {
	const dir = await tempDir();
	try {
		let second;
		const first = await withLock(dir, "slow", async () => {
			await new Promise((resolve) => setTimeout(resolve, 500));
			second = await withLock(dir, "slow", async () => 1, { waitMs: 0, staleMs: 200 });
			return "done";
		}, { staleMs: 200 });
		assert.equal(first.value, "done");
		assert.equal(second.held, true, "the holder's heartbeat keeps the lock fresh");
		assert.equal((await withLock(dir, "slow", async () => 1)).value, 1, "and it is released at the end");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

// The empty shell Herdr opens for a repository's main checkout when a worktree workspace is grouped under it
const parentShell = (id = "m", extra = {}) => workspace(id, "repo", { worktree: worktree("/repo", false), ...extra });
function parentWorld({ workspaces, panes, infos = {} }) {
	const w = world({ workspaces, panes, infos, checkouts: { "/wt/child": {} } });
	w.closedWorkspaces = [];
	// Herdr refuses to close a workspace that still has linked worktree children unless asked to close the group.
	w.herdr.closeWorkspace = async (id, ...rest) => {
		assert.deepEqual(rest, [], "the reaper never passes a group option");
		if (w.workspaces.some((candidate) => candidate.worktree?.is_linked_worktree && candidate.worktree.repo_root === "/repo")) throw new Error("workspace_group_close_required");
		w.closedWorkspaces.push(id);
		w.workspaces = w.workspaces.filter((candidate) => candidate.workspace_id !== id);
		w.panes = w.panes.filter((candidate) => candidate.workspace_id !== id);
	};
	return w;
}
const childOf = (id = "c") => workspace(id, "child", { worktree: worktree("/wt/child") });

test("The empty parent shell closes after its last worktree is reaped, and never the checkout or a branch", async () => {
	const dir = await tempDir();
	try {
		const w = parentWorld({ workspaces: [parentShell(), childOf()], panes: [pane("m:p1", "m"), pane("c:p1", "c")] });
		const store = createStore(dir);
		await runSweep(w.deps(store), { confirmMs: 0 });
		assert.deepEqual(w.calls, ["close c:p1"]);
		assert.deepEqual(w.removed, ["/wt/child"]);
		assert.deepEqual(w.closedWorkspaces, ["m"], w.logs.join("\n"));
		assert.ok(w.logs.some((line) => line.startsWith("close parent workspace repo (workspace m)") && line.includes("idle shells")), w.logs.join("\n"));
		assert.deepEqual(w.workspaces, []);
		const kept = await store.read();
		assert.deepEqual([kept.parents, kept.parentCandidates], [{}, {}], "a closed parent is forgotten");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("The parent shell waits out the confirmation window after the child is gone", async () => {
	const dir = await tempDir();
	try {
		const w = parentWorld({ workspaces: [parentShell(), childOf()], panes: [pane("m:p1", "m"), pane("c:p1", "c", { agent: "pi" })] });
		const store = createStore(dir);
		await runSweep(w.deps(store), { confirmMs: CONFIRM_MS });
		assert.deepEqual(w.closedWorkspaces, []);
		assert.ok(w.logs.some((line) => line.startsWith("skip parent repo (workspace m): worktree workspace child is still open")), w.logs.join("\n"));
		assert.deepEqual(Object.keys((await store.read()).parents), ["m"], "seen with a worktree under it");
		// The child goes (closed by the user, say): the next sweep starts the wait, the one after closes.
		w.workspaces = w.workspaces.filter((candidate) => candidate.workspace_id !== "c");
		w.panes = w.panes.filter((candidate) => candidate.workspace_id !== "c");
		w.logs.length = 0;
		await runSweep(w.deps(store), { confirmMs: CONFIRM_MS });
		assert.ok(w.logs.some((line) => line.startsWith("wait parent repo (workspace m)") && line.includes("60s more")), w.logs.join("\n"));
		assert.deepEqual(w.closedWorkspaces, []);
		assert.equal((await store.read()).nextSweepAt, NOW + CONFIRM_MS, "the next sweep is due when the wait ends");
		await runSweep(w.deps(store, () => NOW + CONFIRM_MS + 1), { confirmMs: CONFIRM_MS });
		assert.deepEqual(w.closedWorkspaces, ["m"], w.logs.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("The parent shell stays while a worktree remains, has an agent, is pinned, renamed, busy or focused", async () => {
	const cases = [
		["a worktree remains", { children: true }, /worktree workspace child is still open/],
		["it has an agent", { parentPane: { agent: "pi" } }, /pi is running in m:p1/],
		["it is pinned by token", { parent: { tokens: { [PIN_TOKEN]: PIN_GLYPH } } }, /workspace is pinned/],
		["it is pinned in the state file", { pins: { "/repo": {} } }, /workspace is pinned/],
		["its label is not the default", { parent: { label: "my main" } }, /name was changed/],
		["its rename was the user's", { renamedRecord: true }, /name was changed/],
		["its shell runs something", { infos: { "m:p1": busy } }, /vite is running in m:p1/],
		["its pane is focused", { parentPane: { focused: true } }, /focused pane/],
		["a second pane runs something", { extraPane: true, infos: { "m:p2": busy } }, /vite is running in m:p2/],
	];
	for (const [name, setup, expected] of cases) {
		const dir = await tempDir();
		try {
			const parent = parentShell("m", setup.parent);
			const w = parentWorld({
				workspaces: [parent, ...(setup.children ? [childOf()] : [])],
				panes: [pane("m:p1", "m", setup.parentPane), ...(setup.extraPane ? [pane("m:p2", "m")] : [])],
				infos: setup.infos,
			});
			const store = createStore(dir);
			await store.apply([set(["parents", "m"], { checkout: "/repo", group: "/repo" }), ...Object.entries(setup.pins ?? {}).map(([key, value]) => set(["pins", key], value))]);
			if (setup.renamedRecord) await store.apply([set(["workspaces", "m"], { label: "repo", checkout: "/repo", renamed: true })]);
			await runSweep(w.deps(store), { confirmMs: 0 });
			assert.deepEqual(w.closedWorkspaces, [], name);
			assert.ok(w.logs.some((line) => line.startsWith("skip parent ") && expected.test(line)), `${name}: ${w.logs.join("\n")}`);
			assert.ok(w.workspaces.some((candidate) => candidate.workspace_id === "m"), name);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}
});

test("A main-checkout workspace never seen with a worktree is untouched", async () => {
	const dir = await tempDir();
	try {
		const w = parentWorld({ workspaces: [parentShell(), workspace("o", "other", { worktree: worktree("/other-wt", true, "/other") })], panes: [pane("m:p1", "m"), pane("o:p1", "o", { agent: "pi" })] });
		const store = createStore(dir);
		await runSweep(w.deps(store), { confirmMs: 0 });
		await runSweep(w.deps(store, () => NOW + 2 * CONFIRM_MS), { confirmMs: 0 });
		assert.deepEqual(w.closedWorkspaces, []);
		assert.ok(!w.logs.some((line) => line.includes("parent")), "not even mentioned");
		assert.deepEqual((await store.read()).parents, {}, "a worktree of another repository does not make it a parent");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Renaming the parent shell pins it, and renaming it back keeps it open", async () => {
	const dir = await tempDir();
	try {
		const w = parentWorld({ workspaces: [parentShell(), childOf()], panes: [pane("m:p1", "m"), pane("c:p1", "c", { agent: "pi" })] });
		const store = createStore(dir);
		await runSweep(w.deps(store), { confirmMs: 0 });
		w.workspaces.find((candidate) => candidate.workspace_id === "m").label = "mine";
		await runEvent(w.deps(store), "workspace.renamed", { workspace_id: "m" });
		w.workspaces.find((candidate) => candidate.workspace_id === "m").label = "repo";
		w.workspaces = w.workspaces.filter((candidate) => candidate.workspace_id !== "c");
		w.panes = w.panes.filter((candidate) => candidate.workspace_id !== "c");
		await runSweep(w.deps(store), { confirmMs: 0 });
		assert.deepEqual(w.closedWorkspaces, [], "renaming it back does not undo that the user named it");
		assert.ok(w.logs.some((line) => /skip parent repo.*workspace is pinned/.test(line)), w.logs.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A renamed parent shell's pin goes with it: the next parent shell on that checkout is closed as usual", async () => {
	const dir = await tempDir();
	try {
		const w = parentWorld({ workspaces: [parentShell(), childOf()], panes: [pane("m:p1", "m"), pane("c:p1", "c", { agent: "pi" })] });
		const store = createStore(dir);
		await runSweep(w.deps(store), { confirmMs: 0 });
		w.workspaces.find((candidate) => candidate.workspace_id === "m").label = "mine";
		await runEvent(w.deps(store), "workspace.renamed", { workspace_id: "m" });
		assert.deepEqual(Object.keys((await store.read()).pins), ["workspace:m"]);
		w.workspaces = w.workspaces.filter((candidate) => candidate.workspace_id !== "m");
		w.panes = w.panes.filter((candidate) => candidate.workspace_id !== "m");
		await runEvent(w.deps(store), "workspace.closed", { workspace_id: "m" });
		assert.deepEqual((await store.read()).pins, {});
		w.workspaces.push(parentShell("m2"));
		w.panes.push(pane("m2:p1", "m2"));
		await runSweep(w.deps(store), { confirmMs: 0 });
		w.workspaces = w.workspaces.filter((candidate) => candidate.workspace_id !== "c");
		w.panes = w.panes.filter((candidate) => candidate.workspace_id !== "c");
		await runSweep(w.deps(store), { confirmMs: 0 });
		assert.deepEqual(w.closedWorkspaces, ["m2"], w.logs.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("pane.exited: a workspace its last pane took is forgotten with its id pin, a linked checkout's pin stays, and another pane keeps it", async () => {
	const dir = await tempDir();
	try {
		const store = createStore(dir);
		const plain = { workspace_id: "p", label: "plain" };
		const w = world({ workspaces: [workspace("a", "kept"), plain], panes: [pane("a:p1", "a"), pane("a:p2", "a"), pane("p:p1", "p")] });
		await runSweep(w.deps(store), { confirmMs: CONFIRM_MS });
		await runPinToggle(w.deps(store), "a");
		await runPinToggle(w.deps(store), "p");
		assert.deepEqual(Object.keys((await store.read()).pins).sort(), ["/wt/kept", "workspace:p"]);
		w.panes = w.panes.filter((candidate) => candidate.pane_id !== "a:p1");
		await runEvent(w.deps(store), "pane.exited", { workspace_id: "a", pane_id: "a:p1" });
		assert.ok("a" in (await store.read()).workspaces, "another pane keeps the workspace and its record");
		w.workspaces = [workspace("a", "kept")];
		w.panes = w.panes.filter((candidate) => candidate.workspace_id !== "p");
		await runEvent(w.deps(store), "pane.exited", { workspace_id: "p", pane_id: "p:p1" });
		w.workspaces = [];
		w.panes = [];
		await runEvent(w.deps(store), "pane.exited", { workspace_id: "a", pane_id: "a:p2" });
		const after = await store.read();
		assert.deepEqual([after.workspaces.a, after.workspaces.p], [undefined, undefined]);
		assert.deepEqual(Object.keys(after.pins), ["/wt/kept"], "the id pin goes; the linked checkout's stays, so the checkout is never removed");
		assert.deepEqual(w.workspaces, [], "nothing reopens");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A worktree workspace event remembers the parent even if the worktree is gone before a sweep", async () => {
	const dir = await tempDir();
	try {
		const w = parentWorld({ workspaces: [parentShell(), childOf()], panes: [pane("m:p1", "m"), pane("c:p1", "c")] });
		const store = createStore(dir);
		await runEvent(w.deps(store), "workspace.created", { workspace_id: "c" });
		w.workspaces = w.workspaces.filter((candidate) => candidate.workspace_id !== "c");
		w.panes = w.panes.filter((candidate) => candidate.workspace_id !== "c");
		await runSweep(w.deps(store), { confirmMs: 0 });
		assert.deepEqual(w.closedWorkspaces, ["m"], w.logs.join("\n"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("Dry run shows the parent shell it would close and changes nothing", async () => {
	const dir = await tempDir();
	try {
		const w = parentWorld({ workspaces: [parentShell(), childOf()], panes: [pane("m:p1", "m"), pane("c:p1", "c")] });
		const store = createStore(dir);
		await store.apply([set(["parents", "m"], { checkout: "/repo", group: "/repo" })]);
		await runSweep(w.deps(store), { confirmMs: 0, dryRun: true });
		assert.deepEqual([w.calls, w.closedWorkspaces, w.removed], [[], [], []]);
		assert.ok(w.logs.some((line) => line.startsWith("would close c:p1")), w.logs.join("\n"));
		assert.ok(w.logs.some((line) => line.startsWith("would close parent workspace repo (workspace m)")), "the child it would close no longer counts as a child:\n" + w.logs.join("\n"));
		assert.deepEqual((await store.read()).parentCandidates, {}, "and writes no state");
		// A child that stays (an agent in it) keeps the parent, dry run included.
		const busyChild = parentWorld({ workspaces: [parentShell(), childOf()], panes: [pane("m:p1", "m"), pane("c:p1", "c", { agent: "pi" })] });
		await runSweep(busyChild.deps(store), { confirmMs: 0, dryRun: true });
		assert.ok(!busyChild.logs.some((line) => line.startsWith("would close parent")), busyChild.logs.join("\n"));
		assert.ok(busyChild.logs.some((line) => line.startsWith("skip parent repo (workspace m): worktree workspace child is still open")));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("A refused parent close is logged and the parent kept", async () => {
	const dir = await tempDir();
	try {
		const w = parentWorld({ workspaces: [parentShell()], panes: [pane("m:p1", "m")] });
		w.herdr.closeWorkspace = async () => {
			throw new Error("workspace_group_close_required");
		};
		const store = createStore(dir);
		await store.apply([set(["parents", "m"], { checkout: "/repo", group: "/repo" })]);
		await runSweep(w.deps(store), { confirmMs: 0 });
		assert.ok(w.logs.some((line) => line.startsWith("failed to close workspace m: workspace_group_close_required")), w.logs.join("\n"));
		assert.deepEqual(Object.keys((await store.read()).parents), ["m"]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("noteParents: parents are remembered by repository, in scope, and forgotten when their id changes hands", () => {
	const noted = (workspaces, current = state(), config = {}) => applyOps(current, noteParents(workspaces, current, config)).parents;
	assert.deepEqual(noted([parentShell(), childOf()]), { m: { checkout: "/repo", group: "/repo" } });
	assert.deepEqual(noted([parentShell()]), {}, "no worktree, no parent");
	assert.deepEqual(noted([parentShell(), childOf()], state(), { only_under: ["/elsewhere"] }), {}, "out of scope");
	assert.deepEqual(noted([{ workspace_id: "p", label: "plain" }, childOf()]), {}, "a workspace with no repository is never a parent");
	const remembered = state({ parents: { m: { checkout: "/repo", group: "/repo" } }, parentCandidates: { m: 1 } });
	assert.deepEqual(noted([parentShell()], remembered), { m: { checkout: "/repo", group: "/repo" } }, "kept after the worktree is gone");
	assert.deepEqual(noted([parentShell("m", { worktree: worktree("/other", false, "/other") })], remembered), {}, "another checkout on a reused id");
	assert.deepEqual(noted([], remembered), {}, "a closed workspace");
	assert.deepEqual(applyOps(remembered, noteParents([], remembered)).parentCandidates, {}, "and its wait");
});

// Real git: a worktree with submodules, one nested, through runSweep with the real git client.
const subGit = (cwd, ...args) => execFileSync("git", ["-c", "protocol.file.allow=always", "-c", "user.name=t", "-c", "user.email=t@example.com", "-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });

async function submoduleWorld(root) {
	const make = async (name) => {
		const path = join(root, name);
		await mkdir(path);
		subGit(path, "init", "-q", "-b", "main");
		await writeFile(join(path, "f.txt"), "x");
		subGit(path, "add", "f.txt");
		subGit(path, "commit", "-q", "-m", "init");
		return path;
	};
	const inner = await make("inner-origin");
	const sub = await make("community-origin");
	subGit(sub, "submodule", "add", "-q", inner, "deep");
	subGit(sub, "commit", "-q", "-m", "nested");
	const repo = await make("repo");
	subGit(repo, "submodule", "add", "-q", sub, "community");
	subGit(repo, "commit", "-q", "-m", "submodule");
	const checkout = async (name) => {
		const path = join(root, name);
		subGit(repo, "worktree", "add", "-q", path, "-b", name);
		subGit(path, "submodule", "update", "--init", "--recursive", "-q");
		return path;
	};
	const sweep = async (paths) => {
		const w = world({ workspaces: paths.map((path, i) => workspace(`w${i}`, `x${i}`, { worktree: worktree(path, true, repo) })), panes: paths.map((_, i) => pane(`w${i}:p1`, `w${i}`)) });
		w.git = gitClient();
		await runSweep(w.deps(createStore(join(root, "state"))), { confirmMs: 0 });
		return w;
	};
	return { repo, checkout, sweep };
}

test("Real git: a worktree whose submodules are clean and pushed is removed without --force; main repo and branch stay", async () => {
	const root = await mkdtemp(join(tmpdir(), "pane-reaper-sub-"));
	try {
		const { repo, checkout, sweep } = await submoduleWorld(root);
		const path = await checkout("clean");
		assert.ok(existsSync(join(path, "community", "deep", "f.txt")), "the nested submodule is checked out");
		const dry = await (async () => {
			const w = world({ workspaces: [workspace("w0", "x0", { worktree: worktree(path, true, repo) })], panes: [pane("w0:p1", "w0")] });
			w.git = gitClient();
			await runSweep(w.deps(createStore(join(root, "dry"))), { confirmMs: 0, dryRun: true });
			return w;
		})();
		assert.ok(dry.logs.includes(`would remove checkout ${path} (clean; 2 submodules deinitialized first; branch clean kept)`), dry.logs.join("\n"));
		assert.ok(existsSync(path), "a dry run removes nothing");
		const w = await sweep([path]);
		assert.ok(w.logs.includes(`remove checkout ${path} (clean; 2 submodules deinitialized first; branch clean kept)`), w.logs.join("\n"));
		assert.equal(existsSync(path), false);
		assert.ok(subGit(repo, "branch", "--list", "clean").includes("clean"), "the branch is kept");
		assert.equal(subGit(repo, "worktree", "list", "--porcelain").includes(path), false);
		assert.ok(existsSync(join(repo, "community")), "the main checkout is untouched");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Real git: a worktree with a changed, unpushed or nested-changed submodule is kept with the reason", async () => {
	const root = await mkdtemp(join(tmpdir(), "pane-reaper-sub-"));
	try {
		const { repo, checkout, sweep } = await submoduleWorld(root);
		const changed = await checkout("changed");
		await writeFile(join(changed, "community", "untracked.txt"), "u");
		await writeFile(join(changed, "community", "f.txt"), "edited");
		const local = await checkout("local");
		await writeFile(join(local, "community", "g.txt"), "g");
		subGit(join(local, "community"), "add", "g.txt");
		subGit(join(local, "community"), "commit", "-q", "-m", "local only");
		subGit(local, "add", "community");
		subGit(local, "commit", "-q", "-m", "bump community");
		const head = subGit(join(local, "community"), "rev-parse", "HEAD").trim().slice(0, 7);
		// An untracked file in the nested submodule only: the middle repository shows it too, and the reason names the submodule.
		const nested = await checkout("nested");
		await writeFile(join(nested, "community", "deep", "h.txt"), "h");
		const w = await sweep([changed, local, nested]);
		for (const path of [changed, local, nested]) assert.ok(existsSync(path), `${path} stays`);
		assert.ok(w.logs.includes(`keep checkout ${changed}: submodule community has 2 uncommitted paths, branch kept`), w.logs.join("\n"));
		assert.ok(w.logs.includes(`keep checkout ${local}: submodule community HEAD ${head} is in no ref outside this worktree (no remote-tracking ref contains it), branch kept`), w.logs.join("\n"));
		assert.ok(w.logs.includes(`keep checkout ${nested}: submodule community has 1 uncommitted paths, branch kept`), w.logs.join("\n"));
		for (const name of ["changed", "local", "nested"]) assert.ok(subGit(repo, "branch", "--list", name).includes(name));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
