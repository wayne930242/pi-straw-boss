// @ts-nocheck: the plugin scripts are plain JavaScript and the fake Herdr, git and panes are loose test data.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONFIRM_MS, PIN_GLYPH, PIN_TOKEN, RENAME_GRACE_MS, SWEEP_INTERVAL_MS,
	applyOps, decideRemoval, emptyState, noteWorkspaces, onRename, planSweep, prunePanes, prunePins, shellIsIdle, togglePin,
} from "../herdr-reaper/decide.mjs";
import { createStore, withLock } from "../herdr-reaper/io.mjs";
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
	const w = { workspaces: structuredClone(workspaces), panes: structuredClone(panes), calls: [], removed: [], logs: [], tokens: [], renamed: [] };
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
		renameWorkspace: async (id, label) => {
			w.renamed.push([id, label]);
			find(id).label = label;
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
	const statePinned = await plan({ workspaces: [workspace("w2", "linked")], panes: [pane("w2:p1", "w2")], state: { ...seen, pins: { "/wt/linked": { preLabel: "x" } } } });
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

test("Renames", async () => {
	const linked = workspace("w2", "renamed");
	const known = (createdAt, label = "orig") => state({ seeded: true, workspaces: { w2: { createdAt, label } } });
	const soon = onRename(linked, known(NOW - RENAME_GRACE_MS + 1000), NOW);
	assert.equal(soon.pin, null, "a rename within the grace is pi-herdr-agents naming");
	assert.equal(applyOps(known(NOW - 1000), soon.ops).workspaces.w2.label, "renamed", "the new label is remembered");
	const user = onRename(linked, known(NOW - RENAME_GRACE_MS - 1), NOW);
	assert.deepEqual(user.pin, { preLabel: "orig" });
	assert.match(user.note, /auto-pin renamed.*was "orig"/);
	assert.deepEqual(onRename(linked, known(0), NOW).pin, { preLabel: "orig" }, "a workspace from before the plugin started is old");
	assert.equal(onRename({ ...linked, worktree: worktree("/repo", false) }, known(0), NOW).pin, null, "only linked worktrees are pinned");
	assert.equal(onRename(linked, state({ seeded: true, workspaces: { w2: { createdAt: 0, label: "orig" } }, pins: { "/wt/renamed": {} } }), NOW).pin, null, "already pinned");
	assert.equal(onRename(linked, state({ seeded: true, workspaces: { w2: { createdAt: 0, label: "renamed" } } }), NOW).pin, null, "no label change, no pin");
	assert.equal(onRename(linked, state(), NOW).pin, null, "an unknown workspace has no earlier label to restore");
});

test("Workspace records", async () => {
	const first = noteWorkspaces([workspace("w1", "a")], state(), NOW);
	const seeded = applyOps(state(), first);
	assert.equal(seeded.workspaces.w1.createdAt, 0, "workspaces present at the first call are old");
	assert.equal(seeded.seeded, true);
	const later = applyOps(seeded, noteWorkspaces([workspace("w1", "a"), workspace("w2", "b")], seeded, NOW));
	assert.equal(later.workspaces.w2.createdAt, NOW, "a workspace first seen later is new");
	const created = applyOps(state(), noteWorkspaces([workspace("w1", "a")], state(), NOW, new Set(["w1"])));
	assert.equal(created.workspaces.w1.createdAt, NOW, "a created event marks it new even before the first call");
	const gone = applyOps(later, noteWorkspaces([workspace("w1", "a")], later, NOW));
	assert.equal("w2" in gone.workspaces, false, "closed workspaces are forgotten");
	assert.deepEqual(
		prunePanes([pane("p", "w1")], state({ agentSeen: { term_p: 1, term_gone: 1 }, candidates: { term_gone: 2 } })).map((op) => op.path.join("/")),
		["agentSeen/term_gone", "candidates/term_gone"],
	);
});

test("Pin toggle", async () => {
	const linked = workspace("w2", "feat-x");
	assert.deepEqual(togglePin(linked, state(), NOW), { action: "pin", key: "/wt/feat-x", entry: { preLabel: "feat-x", auto: false, at: NOW } });
	const withRecord = state({ pins: { "/wt/feat-x": { preLabel: "orig" } } });
	assert.deepEqual(togglePin(linked, withRecord, NOW), { action: "unpin", key: "/wt/feat-x", restoreLabel: "orig" });
	const tokenOnly = togglePin({ ...linked, label: "mine", tokens: { [PIN_TOKEN]: PIN_GLYPH } }, state(), NOW);
	assert.deepEqual(tokenOnly, { action: "unpin", key: "/wt/feat-x", restoreLabel: "feat-x" }, "without a record the checkout's name is restored");
	assert.equal(togglePin({ ...linked, tokens: { [PIN_TOKEN]: PIN_GLYPH } }, state(), NOW).restoreLabel, null, "nothing to rename when the name already matches");
	const plain = togglePin({ workspace_id: "w9", label: "plain", tokens: { [PIN_TOKEN]: PIN_GLYPH } }, state(), NOW);
	assert.equal(plain.restoreLabel, null, "a workspace with no checkout keeps its name");
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
		await store.apply([{ op: "set", path: ["pins", "/wt/pinned"], value: { preLabel: "pinned" } }]);

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
		assert.equal((await store.read()).nextSweepAt, NOW + CONFIRM_MS, "and the next sweep waits only that long");

		w.logs.length = 0;
		const later = NOW + CONFIRM_MS + 1;
		await runSweep(w.deps(store, () => later), { confirmMs: CONFIRM_MS });
		assert.deepEqual(w.calls.sort(), ["close a:p1", "close b:p1"], w.logs.join("\n"));
		assert.deepEqual(w.removed, ["/wt/clean"], "only the clean checkout goes");
		assert.ok(w.logs.some((line) => line.startsWith("keep checkout /wt/dirty") && line.includes("branch kept")));
		assert.ok(w.logs.some((line) => line.startsWith("skip pinned (c:p1): workspace is pinned")));
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
		assert.equal((await deps.store.read()).workspaces.a.createdAt, NOW, "created is recorded from the event");

		now = NOW + 5000;
		w.workspaces[0].label = "named-by-pi";
		await runEvent(deps, "workspace.renamed", { workspace_id: "a", label: "named-by-pi" });
		assert.deepEqual(w.tokens, [], "a rename right after creation is not the user's");
		assert.equal((await deps.store.read()).workspaces.a.label, "named-by-pi");

		now = NOW + RENAME_GRACE_MS + 10_000;
		w.workspaces[0].label = "my-name";
		await runEvent(deps, "workspace.renamed", { workspace_id: "a", label: "my-name" });
		assert.deepEqual(w.tokens, [["set", "a", SOURCE, PIN_TOKEN, PIN_GLYPH]], "a later rename pins");
		assert.deepEqual((await deps.store.read()).pins["/wt/orig"], { preLabel: "named-by-pi", auto: true, at: now });
		assert.ok(w.logs.some((line) => line.startsWith("auto-pin my-name")), w.logs.join("\n"));

		await runPinToggle(deps, "a");
		assert.deepEqual(w.renamed, [["a", "named-by-pi"]], "unpin renames the workspace back");
		assert.deepEqual(w.tokens.at(-1), ["clear", "a", SOURCE, PIN_TOKEN]);
		assert.deepEqual((await deps.store.read()).pins, {});
		await runEvent(deps, "workspace.renamed", { workspace_id: "a", label: "named-by-pi" });
		assert.deepEqual((await deps.store.read()).pins, {}, "the rename unpin made is not taken for the user's");

		await runPinToggle(deps, "a");
		assert.deepEqual((await deps.store.read()).pins["/wt/orig"], { preLabel: "named-by-pi", auto: false, at: now }, "pin again by hand");
		assert.equal(w.workspaces[0].tokens[PIN_TOKEN], PIN_GLYPH);

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

test("A created event that follows the rename event still marks the workspace new", () => {
	const afterRename = applyOps(state({ seeded: true }), onRename(workspace("w2", "named"), state({ seeded: true }), NOW).ops);
	assert.equal(afterRename.workspaces.w2.createdAt, 0);
	const created = applyOps(afterRename, noteWorkspaces([workspace("w2", "named")], afterRename, NOW + 5000, new Set(["w2"])));
	assert.deepEqual(created.workspaces.w2, { createdAt: NOW + 5000, label: "named" });
});

test("A created event overrides the record of a reused workspace id", () => {
	const stale = state({ seeded: true, workspaces: { w2: { createdAt: 5, label: "old workspace" } } });
	const fresh = applyOps(stale, noteWorkspaces([workspace("w2", "new")], stale, NOW, new Set(["w2"])));
	assert.deepEqual(fresh.workspaces.w2, { createdAt: NOW, label: "new" });
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
