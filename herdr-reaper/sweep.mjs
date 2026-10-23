// The reaper's runs: one sweep, one event, one pin toggle. Every function takes its dependencies (herdr, git, store, log, clock)
// so tests can run them against fakes; reaper.mjs wires the real ones.
import {
	CONFIRM_MS, PIN_GLYPH, PIN_TOKEN, SWEEP_INTERVAL_MS,
	applyOps, del, decideRemoval, findCheckoutUser, forgetWorkspace, inScope, isPinned, noteParents, noteWorkspaces, onRename, pinKey, planParents, planSweep, prunePanes, prunePins, set, shellIsIdle, togglePin,
} from "./decide.mjs";
import { withLock } from "./io.mjs";

export const SOURCE = "wayne930242.straw-boss-reaper";
// A workspace that has lost its last pane is closed by Herdr within a moment; a checkout whose workspace stays open is retried next run.
const CLOSE_WAIT_MS = 5000;
const PENDING_GIVE_UP_MS = 60 * 60_000;
// After a pane exits, how long to wait for Herdr to remove a workspace that has no other pane.
const EXIT_WAIT_MS = 3000;
// A sweep scheduled for the end of a confirmation wait runs this much later, so the pane has surely qualified for the whole wait.
const SWEEP_SLACK_MS = 2000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Puts the pin token back on pinned workspaces that lost it: tokens do not survive a Herdr restart. */
async function restoreTokens(workspaces, state, deps) {
	for (const workspace of workspaces) {
		if (workspace.tokens?.[PIN_TOKEN] || !(pinKey(workspace) in state.pins)) continue;
		await deps.herdr.setToken(workspace.workspace_id, SOURCE, PIN_TOKEN, PIN_GLYPH);
		deps.log(`pin token restored on ${workspace.label}`);
	}
}

async function checkoutFacts(deps, checkout, pinned) {
	if (!deps.git.exists(checkout)) return { pinned, exists: false, dirty: "", hidden: "", detached: false, containedBy: "", branch: null };
	const branch = await deps.git.branch(checkout);
	const [dirty, hidden, containedBy, found] = await Promise.all([
		deps.git.status(checkout).catch((error) => `git status failed: ${error.message}`),
		(deps.git.hidden?.(checkout) ?? Promise.resolve("")).catch((error) => `git ls-files failed: ${error.message}`),
		branch ? "" : deps.git.containedBy(checkout).catch(() => ""),
		(deps.git.submodules?.(checkout) ?? Promise.resolve([])).then((submodules) => ({ submodules }), (error) => ({ submodules: [], submodulesError: error.message.split("\n")[0] })),
	]);
	return { pinned, exists: true, dirty, hidden, detached: !branch, containedBy, branch, ...found };
}

/**
 * Looks at Herdr again, right before a removal, for anything still using the checkout: another workspace's pane (the normal
 * layout of an agent and its workers) or another workspace on it. Fails closed: a list that cannot be read keeps the checkout.
 */
async function checkoutUser(checkout, deps, ignore) {
	try {
		const [panes, workspaces] = await Promise.all([deps.herdr.listPanes(), deps.herdr.listWorkspaces()]);
		const roots = [...new Set([checkout, deps.git.realpath?.(checkout) ?? checkout])];
		return findCheckoutUser(roots, panes, workspaces, ignore);
	} catch (error) {
		return `Herdr could not be listed again (${error.message.split("\n")[0]})`;
	}
}

/**
 * Removes a closed workspace's checkout when it is clean, and says why when it is not. The branch is never touched.
 * @returns {Promise<"removed" | "in-use" | "kept">} "in-use" means a pane or workspace still uses a clean checkout: worth retrying later
 */
async function reapCheckout(entry, deps, dryRun, ignore = {}) {
	// Read the pins again: the user may have pinned the workspace while this sweep ran.
	const facts = await checkoutFacts(deps, entry.checkout, entry.checkout in (await deps.store.read()).pins);
	const decision = decideRemoval(facts);
	if (!decision.remove) {
		deps.log(`${dryRun ? "would keep" : "keep"} checkout ${entry.checkout}: ${decision.reason}${decision.gone ? "" : ", branch kept"}`);
		return "kept";
	}
	const user = await checkoutUser(entry.checkout, deps, ignore);
	if (user) {
		deps.log(`${dryRun ? "would keep" : "keep"} checkout ${entry.checkout}: ${user}, branch kept`);
		return "in-use";
	}
	const clean = facts.submodules.length ? `clean; ${facts.submodules.length} submodule${facts.submodules.length === 1 ? "" : "s"} deinitialized first` : "clean";
	if (dryRun) {
		deps.log(`would remove checkout ${entry.checkout} (${clean}; branch ${facts.branch ?? "(detached)"} kept)`);
		return "removed";
	}
	try {
		if (facts.submodules.length) {
			try {
				await deps.git.deinitSubmodules(entry.checkout);
			} catch (error) {
				deps.log(`keep checkout ${entry.checkout}: submodules could not be deinitialized: ${error.message.split("\n")[0]}, branch kept`);
				return "kept";
			}
		}
		await deps.git.removeWorktree(entry.repoRoot, entry.checkout);
		deps.log(`remove checkout ${entry.checkout} (${clean}; branch ${facts.branch ?? "(detached)"} kept)`);
		return "removed";
	} catch (error) {
		const failure = error.timedOut ? `removal timed out (${error.message})` : `git refused to remove it: ${error.message.split("\n")[0]}`;
		const branch = facts.branch ? `branch ${facts.branch} kept` : "branch kept";
		const left = (await deps.git.leftover?.(entry.repoRoot, entry.checkout).catch(() => "unknown")) ?? "unknown";
		if (left === "half-removed") deps.log(`keep checkout ${entry.checkout}: ${failure}; it is half-removed: leftover files remain at ${entry.checkout}, git no longer tracks it, ${branch}; delete the directory yourself when you do not need it`);
		else if (left === "gone") deps.log(`keep checkout ${entry.checkout}: ${failure}, but the directory is gone now; ${branch}`);
		else if (left === "unknown" && error.timedOut) deps.log(`keep checkout ${entry.checkout}: ${failure}; the checkout may be half-removed, run \`git worktree prune\` or check ${entry.checkout}; ${branch}`);
		else deps.log(`keep checkout ${entry.checkout}: ${failure}${left === "intact" ? "" : " (could not check what is left)"}, ${branch}`);
		return "kept";
	}
}

/**
 * Looks at a pane again right before it is closed. The plan is older than that by a git status or two, and in the meantime a
 * person may have focused the pane, an agent may have resumed in it, or the workspace may have been pinned.
 * @returns {Promise<string | null>} why the pane must stay, or null when it is still a leftover
 */
async function changedSince(close, deps) {
	try {
		const pane = await deps.herdr.getPane(close.paneId);
		if ((pane.terminal_id ?? pane.pane_id) !== close.key) return "the pane id now belongs to another terminal";
		if (pane.agent) return `${pane.agent} started in it again`;
		if (pane.focused) return "it is focused now";
		const [workspace, state] = [await deps.herdr.getWorkspace(close.workspaceId), await deps.store.read()];
		if (isPinned(workspace, state)) return "its workspace is pinned now";
		if (!shellIsIdle(await deps.herdr.processInfo(close.paneId))) return "its shell is running something now";
		return null;
	} catch (error) {
		return `it could not be looked at again (${error.message.split("\n")[0]})`;
	}
}

/**
 * Closes the shell Herdr opened for a repository's main checkout once the worktrees grouped under it are gone. Runs after the
 * sweep's own closes, on a fresh look at Herdr, so a worktree workspace closed this run no longer counts as a child; a dry run
 * has not closed anything, so `ignore` names the workspaces it would close. Only the workspace is closed (its panes with it):
 * never with the group form, and never the checkout or a branch.
 * @returns {Promise<{ ops: object[], nextAt: number | null }>}
 */
async function reapParents(deps, state, bookkeeping, { now, confirmMs, dryRun, ignore }) {
	let workspaces, panes;
	try {
		[workspaces, panes] = await Promise.all([deps.herdr.listWorkspaces(), deps.herdr.listPanes()]);
	} catch (error) {
		// Fails closed, and the sweep's other results are still saved.
		deps.log(`skip parent shells: Herdr could not be listed again (${error.message.split("\n")[0]})`);
		return { ops: [], nextAt: null };
	}
	const view = applyOps(state, bookkeeping);
	const noted = noteParents(workspaces, view, deps.config);
	const plan = await planParents({ workspaces, panes, state: applyOps(view, noted), now, confirmMs, config: deps.config, ignore }, deps.herdr);
	for (const line of plan.skips) deps.log(line);
	const ops = [...noted, ...plan.ops];
	for (const close of plan.closes) {
		deps.log(`${dryRun ? "would close" : "close"} parent workspace ${close.label} (workspace ${close.workspaceId}): ${close.reason}`);
		if (dryRun) continue;
		try {
			await deps.herdr.closeWorkspace(close.workspaceId);
			ops.push(...forgetWorkspace(close.workspaceId));
		} catch (error) {
			deps.log(`failed to close workspace ${close.workspaceId}: ${error.message}`);
		}
	}
	return { ops, nextAt: plan.nextAt };
}

/**
 * One sweep. `confirmMs` is how long a pane must have qualified before it is closed (0 for "reap now"); `dryRun` prints what
 * would happen and changes nothing, not even the state file.
 */
export async function runSweep(deps, { confirmMs = CONFIRM_MS, dryRun = false } = {}) {
	if (dryRun) return sweepLocked(deps, confirmMs, true);
	const outcome = await withLock(deps.store.dir, "sweep", () => sweepLocked(deps, confirmMs, false), { waitMs: 0, staleMs: 10 * 60_000 });
	if (outcome.held) deps.log("a sweep is already running; skipped");
}

async function sweepLocked(deps, confirmMs, dryRun) {
	const now = deps.now();
	const state = await deps.store.read();
	const [workspaces, panes] = await Promise.all([deps.herdr.listWorkspaces(), deps.herdr.listPanes()]);
	const bookkeeping = [...noteWorkspaces(workspaces, state), ...prunePanes(panes, state), ...prunePins(workspaces, state, deps.git), ...noteParents(workspaces, state, deps.config)];
	const plan = await planSweep({ workspaces, panes, state, now, confirmMs, config: deps.config }, deps.herdr);
	const ops = [...bookkeeping, ...plan.ops];
	for (const line of plan.skips) deps.log(line);
	const label = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
	if (!dryRun) await restoreTokens(workspaces, state, deps);
	// Checkouts of workspaces closed in an earlier run come first: they never depended on this run's closes.
	const live = new Set(workspaces.map((workspace) => workspace.workspace_id));
	for (const [checkout, entry] of Object.entries(state.pending)) {
		if (live.has(entry.workspaceId)) {
			// A checkout kept for a pane that works in it waits as long as that pane does: workers run for hours.
			if (!entry.inUse && now - entry.since > PENDING_GIVE_UP_MS) {
				deps.log(`give up on ${checkout}: workspace ${entry.label} never closed`);
				ops.push(del(["pending", checkout]));
			}
			continue;
		}
		const result = await reapCheckout({ ...entry, checkout }, deps, dryRun);
		if (dryRun) continue;
		if (result === "in-use") ops.push(set(["pending", checkout], { ...entry, inUse: true }));
		else ops.push(del(["pending", checkout]));
	}
	// A workspace keeps its checkout for this run when any of its panes stayed open.
	const stayed = new Set();
	for (const close of plan.closes) {
		if (!dryRun) {
			const changed = await changedSince(close, deps);
			if (changed) {
				deps.log(`skip ${label.get(close.workspaceId)} (${close.paneId}): ${changed}`);
				stayed.add(close.workspaceId);
				continue;
			}
		}
		deps.log(`${dryRun ? "would close" : "close"} ${close.paneId} in ${label.get(close.workspaceId)}: ${close.reason}`);
		if (dryRun) continue;
		try {
			await deps.herdr.closePane(close.paneId);
			ops.push(del(["agentSeen", close.key]), del(["candidates", close.key]));
		} catch (error) {
			deps.log(`failed to close ${close.paneId}: ${error.message}`);
			stayed.add(close.workspaceId);
		}
	}
	const closing = plan.expectClosed.filter((entry) => !stayed.has(entry.workspaceId));
	// A workspace whose pane stayed open keeps its checkout for now; once it closes, a later sweep takes it.
	if (!dryRun) {
		for (const entry of plan.expectClosed.filter((candidate) => stayed.has(candidate.workspaceId))) {
			if (entry.checkout in state.pending) continue;
			ops.push(set(["pending", entry.checkout], { workspaceId: entry.workspaceId, label: entry.label, repoRoot: entry.repoRoot, since: now }));
		}
	}
	if (dryRun) {
		// The panes and workspaces this sweep would close are still alive here, so they are not what keeps a checkout.
		const ignore = { panes: new Set(plan.closes.map((close) => close.paneId)), workspaces: new Set(closing.map((entry) => entry.workspaceId)) };
		for (const entry of closing) await reapCheckout(entry, deps, true, ignore);
		await reapParents(deps, state, bookkeeping, { now, confirmMs, dryRun: true, ignore: ignore.workspaces });
		return;
	}
	if (closing.length > 0) {
		const deadline = Date.now() + CLOSE_WAIT_MS;
		let remaining = new Set(closing.map((entry) => entry.workspaceId));
		while (remaining.size > 0 && Date.now() < deadline) {
			await pause(250);
			const open = new Set((await deps.herdr.listWorkspaces()).map((workspace) => workspace.workspace_id));
			remaining = new Set([...remaining].filter((id) => open.has(id)));
		}
		const records = (await deps.store.read()).workspaces;
		for (const entry of closing) {
			// A record already there for another checkout is a new workspace's on a reused id, and stays.
			const record = records[entry.workspaceId];
			if (!remaining.has(entry.workspaceId) && (!record || record.checkout === entry.checkout)) ops.push(...forgetWorkspace(entry.workspaceId));
			if (remaining.has(entry.workspaceId)) {
				ops.push(set(["pending", entry.checkout], { workspaceId: entry.workspaceId, label: entry.label, repoRoot: entry.repoRoot, since: now }));
				deps.log(`workspace ${entry.label} is still open; its checkout ${entry.checkout} is retried next run`);
			} else {
				const result = await reapCheckout(entry, deps, false);
				if (result === "in-use") ops.push(set(["pending", entry.checkout], { workspaceId: entry.workspaceId, label: entry.label, repoRoot: entry.repoRoot, since: now, inUse: true }));
			}
		}
	}
	const parents = await reapParents(deps, state, bookkeeping, { now, confirmMs, dryRun: false, ignore: new Set() });
	ops.push(...parents.ops);
	const waiting = Math.min(plan.nextAt ?? Infinity, parents.nextAt ?? Infinity, now + SWEEP_INTERVAL_MS);
	ops.push(set(["nextSweepAt"], waiting));
	await deps.store.apply(ops);
}

/** Pins a workspace: the token shows it in the sidebar, the state file keeps it across restarts. */
async function pin(workspace, entry, key, deps) {
	await deps.store.apply([set(["pins", key], entry)]);
	await deps.herdr.setToken(workspace.workspace_id, SOURCE, PIN_TOKEN, PIN_GLYPH);
}

/** The pin action: toggles the workspace the action was invoked in. */
export async function runPinToggle(deps, workspaceId) {
	const [workspace, state] = [await deps.herdr.getWorkspace(workspaceId), await deps.store.read()];
	const choice = togglePin(workspace, state, deps.now());
	if (choice.action === "pin") {
		await pin(workspace, choice.entry, choice.key, deps);
		return deps.log(`pin ${workspace.label}`);
	}
	await deps.store.apply([del(["pins", choice.key])]);
	await deps.herdr.clearToken(workspaceId, SOURCE, PIN_TOKEN);
	deps.log(`unpin ${workspace.label}`);
}

/**
 * A workspace that is no longer open: forget its record and any pin keyed by its id, so a workspace that later gets the id inherits
 * neither. A checkout-keyed pin stays: the checkout of a pinned workspace is never removed, closed or not.
 */
async function workspaceGone(deps, id) {
	await deps.store.apply(forgetWorkspace(id));
}

const idOf = (payload) => payload.workspace_id ?? payload.workspace?.workspace_id;

/**
 * An event hook. Each does only bookkeeping: what is current comes from Herdr's lists, so a payload that is shaped differently
 * from what this expects costs precision, not correctness.
 */
export async function runEvent(deps, name, payload) {
	const now = deps.now();
	const state = await deps.store.read();
	if (name === "workspace.renamed") {
		const workspaces = await deps.herdr.listWorkspaces();
		const workspace = workspaces.find((candidate) => candidate.workspace_id === idOf(payload));
		if (!workspace) return;
		const result = onRename(workspace, state);
		await deps.store.apply(result.ops);
		if (result.pin && inScope(workspace, deps.config)) {
			await pin(workspace, { auto: true, at: now }, pinKey(workspace), deps);
			deps.log(`auto-pin ${workspace.label}: renamed`);
		}
		return;
	}
	if (name === "workspace.closed") {
		const id = idOf(payload);
		if (!id) return;
		// Its id may already belong to a new workspace; that one's record is kept, and a stale one (another checkout) is replaced.
		const live = (await deps.herdr.listWorkspaces()).find((candidate) => candidate.workspace_id === id);
		if (!live) return workspaceGone(deps, id);
		const record = state.workspaces[id];
		if (record && (record.checkout ?? null) !== (live.worktree?.checkout_path ?? null)) await deps.store.apply(forgetWorkspace(id));
		return;
	}
	if (name === "pane.exited") {
		// Herdr removes a workspace whose last pane exits without a workspace.closed event; this is the only word of that close.
		const id = payload.workspace_id;
		if (!id) return;
		const deadline = deps.now() + EXIT_WAIT_MS;
		for (;;) {
			const [workspaces, panes] = await Promise.all([deps.herdr.listWorkspaces(), deps.herdr.listPanes()]);
			if (!workspaces.some((candidate) => candidate.workspace_id === id)) return workspaceGone(deps, id);
			// Another pane keeps the workspace open: an ordinary pane exit.
			if (panes.some((candidate) => candidate.workspace_id === id && candidate.pane_id !== payload.pane_id)) return;
			if (deps.now() >= deadline) return;
			await pause(250);
		}
	}
	if (name === "pane.agent_detected") {
		const released = payload.released === true;
		const pane = payload.pane_id ? await deps.herdr.getPane(payload.pane_id).catch(() => null) : null;
		if (!pane) return;
		// A pane id can be reused within the hook's latency; when the event names its terminal, it must still be this pane's.
		if (payload.terminal_id && pane.terminal_id && payload.terminal_id !== pane.terminal_id) return;
		const key = pane.terminal_id ?? pane.pane_id;
		if (!released) return deps.store.apply([set(["agentSeen", key], now)]);
		// The agent is gone: the pane has qualified from now on, and a sweep is due when the confirmation wait ends.
		const due = now + CONFIRM_MS + SWEEP_SLACK_MS;
		const ops = [set(["agentSeen", key], now), set(["candidates", key], now)];
		if (!(state.nextSweepAt > now && state.nextSweepAt < due)) ops.push(set(["nextSweepAt"], due));
		return deps.store.apply(ops);
	}
	// workspace.created
	const workspaces = await deps.herdr.listWorkspaces();
	const created = new Set([idOf(payload)].filter(Boolean));
	// A worktree workspace may be gone again before a sweep sees it, so the parent is remembered when the worktree appears.
	await deps.store.apply([...noteWorkspaces(workspaces, state, created), ...noteParents(workspaces, state, deps.config)]);
}
