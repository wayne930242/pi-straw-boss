// The reaper's runs: one sweep, one event, one pin toggle. Every function takes its dependencies (herdr, git, store, log, clock)
// so tests can run them against fakes; reaper.mjs wires the real ones.
import {
	CONFIRM_MS, PIN_GLYPH, PIN_TOKEN, SWEEP_INTERVAL_MS,
	del, decideRemoval, findCheckoutUser, forgetWorkspace, inScope, isPinned, noteWorkspaces, onRename, pinKey, planSweep, prunePanes, prunePins, set, shellIsIdle, togglePin,
} from "./decide.mjs";
import { withLock } from "./io.mjs";

export const SOURCE = "wayne930242.straw-boss-reaper";
// A workspace that has lost its last pane is closed by Herdr within a moment; a checkout whose workspace stays open is retried next run.
const CLOSE_WAIT_MS = 5000;
const PENDING_GIVE_UP_MS = 60 * 60_000;
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
	const [dirty, hidden, containedBy] = await Promise.all([
		deps.git.status(checkout).catch((error) => `git status failed: ${error.message}`),
		(deps.git.hidden?.(checkout) ?? Promise.resolve("")).catch((error) => `git ls-files failed: ${error.message}`),
		branch ? "" : deps.git.containedBy(checkout).catch(() => ""),
	]);
	return { pinned, exists: true, dirty, hidden, detached: !branch, containedBy, branch };
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

/** Removes a closed workspace's checkout when it is clean, and says why when it is not. The branch is never touched. */
async function reapCheckout(entry, deps, dryRun, ignore = {}) {
	// Read the pins again: the user may have pinned the workspace while this sweep ran.
	const facts = await checkoutFacts(deps, entry.checkout, entry.checkout in (await deps.store.read()).pins);
	const decision = decideRemoval(facts);
	if (!decision.remove) {
		deps.log(`${dryRun ? "would keep" : "keep"} checkout ${entry.checkout}: ${decision.reason}${decision.gone ? "" : ", branch kept"}`);
		return;
	}
	const user = await checkoutUser(entry.checkout, deps, ignore);
	if (user) return deps.log(`${dryRun ? "would keep" : "keep"} checkout ${entry.checkout}: ${user}, branch kept`);
	if (dryRun) return deps.log(`would remove checkout ${entry.checkout} (clean; branch ${facts.branch ?? "(detached)"} kept)`);
	try {
		await deps.git.removeWorktree(entry.repoRoot, entry.checkout);
		deps.log(`remove checkout ${entry.checkout} (clean; branch ${facts.branch ?? "(detached)"} kept)`);
	} catch (error) {
		deps.log(`keep checkout ${entry.checkout}: git refused to remove it: ${error.message.split("\n")[0]}`);
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
	const bookkeeping = [...noteWorkspaces(workspaces, state, now), ...prunePanes(panes, state), ...prunePins(workspaces, state, deps.git)];
	const plan = await planSweep({ workspaces, panes, state, now, confirmMs, config: deps.config }, deps.herdr);
	const ops = [...bookkeeping, ...plan.ops];
	for (const line of plan.skips) deps.log(line);
	const label = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
	if (!dryRun) await restoreTokens(workspaces, state, deps);
	// Checkouts of workspaces closed in an earlier run come first: they never depended on this run's closes.
	const live = new Set(workspaces.map((workspace) => workspace.workspace_id));
	for (const [checkout, entry] of Object.entries(state.pending)) {
		if (live.has(entry.workspaceId)) {
			if (now - entry.since > PENDING_GIVE_UP_MS) {
				deps.log(`give up on ${checkout}: workspace ${entry.label} never closed`);
				ops.push(del(["pending", checkout]));
			}
			continue;
		}
		await reapCheckout({ ...entry, checkout }, deps, dryRun);
		if (!dryRun) ops.push(del(["pending", checkout]));
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
	if (dryRun) {
		// The panes and workspaces this sweep would close are still alive here, so they are not what keeps a checkout.
		const ignore = { panes: new Set(plan.closes.map((close) => close.paneId)), workspaces: new Set(closing.map((entry) => entry.workspaceId)) };
		for (const entry of closing) await reapCheckout(entry, deps, true, ignore);
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
				await reapCheckout(entry, deps, false);
			}
		}
	}
	const waiting = plan.nextAt ?? now + SWEEP_INTERVAL_MS;
	ops.push(set(["nextSweepAt"], Math.min(waiting, now + SWEEP_INTERVAL_MS)));
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
	// The state file first: the rename event this causes must find the label already recorded.
	const ops = [del(["pins", choice.key])];
	if (choice.restoreLabel) ops.push(set(["workspaces", workspaceId, "label"], choice.restoreLabel));
	await deps.store.apply(ops);
	await deps.herdr.clearToken(workspaceId, SOURCE, PIN_TOKEN);
	if (choice.restoreLabel) await deps.herdr.renameWorkspace(workspaceId, choice.restoreLabel);
	deps.log(`unpin ${workspace.label}${choice.restoreLabel ? `; renamed back to ${choice.restoreLabel}` : ""}`);
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
		const result = onRename(workspace, state, now);
		await deps.store.apply(result.ops);
		if (result.pin && inScope(workspace, deps.config)) {
			await pin(workspace, { preLabel: result.pin.preLabel, auto: true, at: now }, pinKey(workspace), deps);
			deps.log(result.note);
		}
		return;
	}
	if (name === "workspace.closed") {
		const id = idOf(payload);
		if (!id) return;
		// Its id may already belong to a new workspace; that one's record is kept, and a stale one (another checkout) is replaced.
		const live = (await deps.herdr.listWorkspaces()).find((candidate) => candidate.workspace_id === id);
		if (!live) return deps.store.apply(forgetWorkspace(id));
		const record = state.workspaces[id];
		if (record && (record.checkout ?? null) !== (live.worktree?.checkout_path ?? null)) await deps.store.apply(forgetWorkspace(id));
		return;
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
	await deps.store.apply(noteWorkspaces(workspaces, state, now, created));
}
