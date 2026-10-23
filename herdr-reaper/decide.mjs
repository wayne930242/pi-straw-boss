// The reaper's decisions, with no I/O: which panes of a linked-worktree workspace to close, whether a closed workspace's checkout
// may be removed, which empty parent shell of a worktree group to close, and what a rename and the pin toggle do. sweep.mjs gathers Herdr's and git's state, calls these, and
// carries the results out.
//
// State is one JSON object the plugin keeps between runs; changes to it are returned as ops ({ op: "set" | "del", path, value }) so
// concurrent runs merge instead of overwriting each other.

/** A pane must qualify for this long before it is closed, so an agent restarting in the same pane is not caught between runs. */
export const CONFIRM_MS = 60_000;
export const SWEEP_INTERVAL_MS = 10 * 60_000;
export const PIN_TOKEN = "pin";
// Nerd Font nf-md-pin (U+F0403), the same family as the tower icon in the sidebar.
export const PIN_GLYPH = String.fromCodePoint(0xf0403);

export const emptyState = () => ({
	initialized: false,
	nextSweepAt: 0,
	agentSeen: {},
	candidates: {},
	workspaces: {},
	pins: {},
	pending: {},
	// Main-checkout workspaces a linked worktree was once seen under, and when each began to qualify for closing.
	parents: {},
	parentCandidates: {},
});

export const set = (path, value) => ({ op: "set", path, value });
export const del = (path) => ({ op: "del", path });

/** Applies ops to a copy of the state; a set creates the objects on the way. */
export function applyOps(state, ops) {
	const next = structuredClone(state);
	for (const { op, path, value } of ops) {
		let node = next;
		for (const key of path.slice(0, -1)) {
			if (typeof node[key] !== "object" || node[key] === null) node[key] = {};
			node = node[key];
		}
		const last = path.at(-1);
		if (op === "set") node[last] = value;
		else delete node[last];
	}
	return next;
}

const worktreeOf = (workspace) => workspace.worktree ?? {};
const checkoutOf = (workspace) => worktreeOf(workspace).checkout_path ?? null;
/**
 * The record kept for a workspace id, unless it belongs to another workspace: Herdr reuses the ids of closed workspaces, and a
 * record whose checkout differs from the live workspace's is the earlier one's.
 */
const recordOf = (workspace, state) => {
	const record = state.workspaces[workspace.workspace_id];
	return record && (record.checkout ?? null) === checkoutOf(workspace) ? record : undefined;
};
export const isLinked = (workspace) => worktreeOf(workspace).is_linked_worktree === true;
/**
 * The key a pin is stored under. A linked worktree's pin is its checkout's, which outlives the workspace so a pinned checkout is never
 * removed; any other workspace's pin is its id's and goes with it, so a later workspace on the same main checkout starts unpinned.
 */
export const pinKey = (workspace) => (isLinked(workspace) && checkoutOf(workspace)) || `workspace:${workspace.workspace_id}`;
export const isPinned = (workspace, state) => Boolean(workspace.tokens?.[PIN_TOKEN]) || pinKey(workspace) in state.pins;

/** `only_under` limits the plugin to repositories below the listed directories; empty means every repository. */
export function inScope(workspace, config) {
	const roots = config.only_under ?? [];
	if (roots.length === 0) return true;
	const { repo_root: repoRoot, checkout_path: checkout } = worktreeOf(workspace);
	return roots.some((root) => [repoRoot, checkout].some((path) => path && (path === root || path.startsWith(`${root.replace(/\/$/, "")}/`))));
}

/** True when the pane's shell is the only foreground process: nothing is running in it. */
export function shellIsIdle(info) {
	if (!info || typeof info.shell_pid !== "number") return false;
	const processes = info.foreground_processes ?? [];
	return processes.every((process) => process.pid === info.shell_pid) && (info.foreground_process_group_id === undefined || info.foreground_process_group_id === info.shell_pid);
}

const describeForeground = (info) =>
	info ? (info.foreground_processes ?? []).filter((process) => process.pid !== info.shell_pid).map((process) => process.name ?? process.argv0).join(", ") || "unknown process" : "process info unavailable";

/** Process info, or undefined when it cannot be read (a pane that vanished mid-sweep must not abort the sweep). */
async function readProcessInfo(deps, paneId) {
	try {
		return await deps.processInfo(paneId);
	} catch {
		return undefined;
	}
}

/**
 * Decides which panes to close. `deps.processInfo(paneId)` resolves to Herdr's process info or undefined when it cannot be read.
 * @returns {Promise<{ closes: object[], skips: string[], ops: object[], nextAt: number | null, expectClosed: object[] }>}
 */
export async function planSweep({ workspaces, panes, state, now, confirmMs = CONFIRM_MS, config = {} }, deps) {
	const closes = [];
	const skips = [];
	const ops = [];
	const firstRun = !state.initialized;
	let nextAt = null;
	const later = (at) => {
		nextAt = nextAt === null ? at : Math.min(nextAt, at);
	};
	const byWorkspace = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace]));
	for (const pane of panes) {
		const workspace = byWorkspace.get(pane.workspace_id);
		if (!workspace || !isLinked(workspace) || !inScope(workspace, config)) continue;
		const key = pane.terminal_id ?? pane.pane_id;
		if (pane.agent) {
			ops.push(set(["agentSeen", key], now));
			if (key in state.candidates) ops.push(del(["candidates", key]));
			continue;
		}
		// A pane that never ran an agent is the user's shell. On the first run every agentless pane counts as one that did, but only
		// a pane the run treats as a leftover is marked: a pinned, focused or busy one stays the user's, for later runs too.
		const unseen = !(key in state.agentSeen);
		if (unseen && !firstRun) continue;
		const subject = `${workspace.label} (${pane.pane_id})`;
		if (isPinned(workspace, state)) {
			skips.push(`skip ${subject}: workspace is pinned`);
			continue;
		}
		if (pane.focused) {
			skips.push(`skip ${subject}: focused pane`);
			continue;
		}
		const info = await readProcessInfo(deps, pane.pane_id);
		if (!shellIsIdle(info)) {
			skips.push(`skip ${subject}: ${describeForeground(info)} is running`);
			if (key in state.candidates) ops.push(del(["candidates", key]));
			continue;
		}
		if (unseen) ops.push(set(["agentSeen", key], now));
		const since = state.candidates[key] ?? now;
		if (!(key in state.candidates)) ops.push(set(["candidates", key], now));
		if (now - since < confirmMs) {
			skips.push(`wait ${subject}: no agent and an idle shell, confirming for ${Math.ceil((confirmMs - (now - since)) / 1000)}s more`);
			later(since + confirmMs);
		} else {
			closes.push({ paneId: pane.pane_id, workspaceId: workspace.workspace_id, key, reason: "agent exited and the shell is idle" });
		}
	}
	if (firstRun) ops.push(set(["initialized"], true));
	// A workspace whose every pane is being closed ends up closed, and its checkout is then up for removal.
	const closing = new Map();
	for (const close of closes) closing.set(close.workspaceId, [...(closing.get(close.workspaceId) ?? []), close]);
	const expectClosed = [];
	for (const [workspaceId, list] of closing) {
		const workspace = byWorkspace.get(workspaceId);
		const total = panes.filter((pane) => pane.workspace_id === workspaceId).length;
		if (list.length === total) expectClosed.push({ workspaceId, label: workspace.label, checkout: workspace.worktree.checkout_path, repoRoot: workspace.worktree.repo_root });
	}
	return { closes, skips, ops, nextAt, expectClosed };
}

const within = (path, root) => typeof path === "string" && root.length > 0 && (path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`));

/**
 * What still uses a checkout: a live pane whose cwd or foreground cwd is the checkout or below it, or a live workspace on the same
 * checkout. `roots` lists the spellings of the checkout path (the path itself and its real path). Panes and workspaces in `ignore`
 * are the ones this run is closing; a dry run needs them left out because they are still alive.
 * @returns {string | null} the reason to keep the checkout, or null when nothing uses it
 */
export function findCheckoutUser(roots, panes, workspaces, ignore = {}) {
	for (const pane of panes) {
		if (ignore.panes?.has(pane.pane_id)) continue;
		const path = [pane.cwd, pane.foreground_cwd].find((cwd) => roots.some((root) => within(cwd, root)));
		if (path) return `pane ${pane.pane_id} is working in it (${path})`;
	}
	for (const workspace of workspaces) {
		if (ignore.workspaces?.has(workspace.workspace_id)) continue;
		if (roots.includes(worktreeOf(workspace).checkout_path)) return `workspace ${workspace.label} is open on it`;
	}
	return null;
}

/** How long a parent pi session that is not open in any pane may be silent before the worktrees its children left are no longer held for it. */
export const RETAIN_IDLE_HOURS = 72;
const HOUR_MS = 3_600_000;
/** The `retain_idle_hours` setting in milliseconds; a value that is not a positive number falls back to the default, never to no protection. */
export const retainIdleMs = (config = {}) => (typeof config.retain_idle_hours === "number" && Number.isFinite(config.retain_idle_hours) && config.retain_idle_hours > 0 ? config.retain_idle_hours : RETAIN_IDLE_HOURS) * HOUR_MS;

/**
 * The pane in which pi runs the session `sessionId`, from Herdr's pane list: Herdr reports a pi pane's session as the path of its
 * session file (`<time>_<session id>.jsonl`). A pane whose agent has exited, another agent, or a session reported any other way is
 * not matched.
 * @returns {string | undefined} the pane id
 */
export function findSessionPane(panes, sessionId) {
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	const tail = `_${sessionId}.jsonl`;
	return panes.find((pane) => pane.agent === "pi" && pane.agent_session?.kind === "path" && typeof pane.agent_session.value === "string" && pane.agent_session.value.split("/").at(-1).endsWith(tail))?.pane_id;
}

/**
 * Whether pi-herdr-agents still holds a checkout for the session that launched it. It never removes a worktree by itself: the
 * parent session does, with `worktree_remove`, which marks the child's manifest `removed`. Until then the checkout belongs to the
 * parent, so a manifest that names it and is not `removed` holds it while the parent is alive: its session is open in a pane of
 * `panes` (Herdr's pane list, however long it has been idle), or else it showed activity within `idleMs` (a parent that wrote
 * nothing for that long, and is open nowhere, has ended). `panes` is null when Herdr could not be asked, and the idle limit alone
 * decides then. `manifests` come from io.managedClient: `{ file, name, state, createdAt, activityAt, paths, parentId }`, or
 * `{ file, unreadable }` for a record that names the checkout but could not be read, which holds it (fail closed). A newer
 * `removed` manifest on the same path means the owner took the checkout away since.
 * @returns {string | null} why the checkout stays, or null when no live parent holds it
 */
export function findRetainer(roots, manifests, now, idleMs, panes = null) {
	const mine = manifests.filter((entry) => entry.unreadable !== undefined || (entry.paths ?? []).some((path) => roots.includes(path)));
	for (const entry of mine) {
		if (entry.unreadable !== undefined) return `a pi-herdr-agents record (${entry.file}) names it but could not be read (${entry.unreadable})`;
	}
	for (const entry of mine) {
		if (entry.state === "removed") continue;
		if (mine.some((other) => other.state === "removed" && other.createdAt > entry.createdAt)) continue;
		const idle = now - entry.activityAt;
		const label = `pi-herdr-agents child ${entry.name ?? entry.file} (${entry.state ?? "state unknown"})`;
		const open = panes ? findSessionPane(panes, entry.parentId) : undefined;
		if (open) return `${label} holds it: its parent session is open in pane ${open}; it stays until the parent runs worktree_remove or the session is closed and idle for ${Math.round((idleMs / HOUR_MS) * 10) / 10}h`;
		if (!Number.isFinite(idle)) return `${label} holds it, and its parent session's activity time is unknown`;
		if (idle <= idleMs) return `${label} holds it for its parent session, last active ${Math.round((Math.max(idle, 0) / HOUR_MS) * 10) / 10}h ago; it stays until the parent runs worktree_remove or is idle for ${Math.round((idleMs / HOUR_MS) * 10) / 10}h`;
	}
	return null;
}

/**
 * The first process whose cwd is the checkout or below it. `processes` are `{ pid, name, cwd }` for the user's processes anywhere on
 * the machine, not only Herdr's panes; `ignorePids` are the idle shells of panes this run closes (a dry run).
 * @returns {string | null}
 */
export function findProcessHolder(roots, processes, ignorePids = new Set()) {
	for (const process of processes) {
		if (ignorePids.has(process.pid) || !roots.some((root) => within(process.cwd, root))) continue;
		return `process ${process.name ?? "unknown"} (pid ${process.pid}) is working in it (${process.cwd})`;
	}
	return null;
}

/**
 * Whether a checkout may be removed after its workspace closed. A dirty tree stays on disk; so does a detached HEAD no branch
 * or tag contains, because removing the checkout would be the last place those commits live.
 * `submodules` are the initialized ones (recursively) with `dirty`, `hidden`, `head`, `kept` (a ref outside the worktree contains HEAD) and `ahead`.
 * `hidden` lists tracked files git was told not to look at (skip-worktree, assume-unchanged): their edits are invisible to `status`.
 * @param {{ pinned: boolean, exists: boolean, dirty: string, hidden?: string, detached: boolean, containedBy: string }} facts
 */
export function decideRemoval({ pinned, exists, dirty, hidden = "", detached, containedBy, submodules = [], submodulesError = "" }) {
	if (pinned) return { remove: false, reason: "workspace is pinned" };
	if (!exists) return { remove: false, reason: "checkout is already gone", gone: true };
	// Named before the checkout's own status, which shows a dirty submodule only as one path of its own.
	for (const sub of submodules) {
		const changed = [sub.dirty, sub.hidden].map((text) => (text ?? "").trim()).filter(Boolean).flatMap((text) => text.split("\n")).length;
		if (changed) return { remove: false, reason: `submodule ${sub.path} has ${changed} uncommitted paths` };
	}
	if (dirty.trim()) return { remove: false, reason: `uncommitted changes (${dirty.trim().split("\n").length} paths)` };
	if (hidden.trim()) return { remove: false, reason: `${hidden.trim().split("\n").length} files marked skip-worktree or assume-unchanged, which git cannot show as changed` };
	if (detached && !containedBy.trim()) return { remove: false, reason: "detached HEAD with commits no branch or tag contains" };
	if (submodulesError) return { remove: false, reason: `submodules could not be checked (${submodulesError})` };
	for (const sub of submodules) {
		const head = String(sub.head).slice(0, 7);
		if (!sub.kept) return { remove: false, reason: `submodule ${sub.path} HEAD ${head} is in no ref outside this worktree (no remote-tracking ref contains it)` };
		if (sub.ahead) return { remove: false, reason: `submodule ${sub.path} has a local branch with commits no remote-tracking ref contains` };
	}
	return { remove: true, reason: "clean" };
}

/**
 * What a `workspace.renamed` event means. Nothing renames a workspace but the user (pi-herdr-agents names its worktree workspaces
 * when it creates them), so every rename pins the workspace and records that its name is the user's.
 * @returns {{ ops: object[], pin: boolean }}
 */
export function onRename(workspace, state) {
	// The record keeps that the user renamed it: a parent shell with a name of the user's is never closed.
	const ops = [set(["workspaces", workspace.workspace_id], { label: workspace.label, checkout: checkoutOf(workspace), renamed: true })];
	return { ops, pin: !isPinned(workspace, state) };
}

/** Keeps a label record for every live workspace and drops the records of workspaces that are gone. */
export function noteWorkspaces(workspaces, state, createdIds = new Set()) {
	const ops = [];
	for (const workspace of workspaces) {
		const record = recordOf(workspace, state);
		const checkout = checkoutOf(workspace);
		if (createdIds.has(workspace.workspace_id) || !record) {
			// A created event starts a fresh record, even over an older one: Herdr reuses ids of closed workspaces.
			ops.push(set(["workspaces", workspace.workspace_id], { label: workspace.label, checkout }));
		} else if (record.label !== workspace.label) {
			// A label change no rename event reported is not attributed to the user.
			ops.push(set(["workspaces", workspace.workspace_id, "label"], workspace.label));
		}
	}
	const live = new Set(workspaces.map((workspace) => workspace.workspace_id));
	for (const id of Object.keys(state.workspaces)) if (!live.has(id)) ops.push(del(["workspaces", id]));
	return ops;
}

/** What a closed workspace leaves behind that its id's next holder must not inherit: its record, and a pin keyed by the id. */
export const forgetWorkspace = (workspaceId) => [
	del(["workspaces", workspaceId]),
	del(["pins", `workspace:${workspaceId}`]),
	del(["parents", workspaceId]),
	del(["parentCandidates", workspaceId]),
];

/** The repository a workspace belongs to, the same for a main checkout and its linked worktrees. */
const groupOf = (workspace) => worktreeOf(workspace).repo_key ?? worktreeOf(workspace).repo_root ?? null;

/**
 * Remembers a main-checkout workspace as a parent once a linked-worktree workspace of the same repository is open: that is when
 * Herdr groups the worktree under it. A workspace never seen with a worktree is never remembered, so it is never closed. Entries
 * of workspaces that are gone, or whose id now belongs to another checkout, are dropped.
 */
export function noteParents(workspaces, state, config = {}) {
	const ops = [];
	const groupsWithWorktree = new Set(workspaces.filter((workspace) => isLinked(workspace) && groupOf(workspace)).map(groupOf));
	const live = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace]));
	const kept = new Set();
	for (const [id, entry] of Object.entries(state.parents)) {
		const workspace = live.get(id);
		if (workspace && !isLinked(workspace) && entry.checkout === checkoutOf(workspace) && entry.group === groupOf(workspace)) kept.add(id);
		else ops.push(del(["parents", id]));
	}
	for (const workspace of workspaces) {
		const group = groupOf(workspace);
		if (isLinked(workspace) || !group || !groupsWithWorktree.has(group) || !inScope(workspace, config)) continue;
		if (!kept.has(workspace.workspace_id)) ops.push(set(["parents", workspace.workspace_id], { checkout: checkoutOf(workspace), group }));
		kept.add(workspace.workspace_id);
	}
	for (const id of Object.keys(state.parentCandidates)) if (!kept.has(id)) ops.push(del(["parentCandidates", id]));
	return ops;
}

/** The label Herdr gives a workspace it opens for a repository's main checkout. */
const hasDefaultLabel = (workspace) => {
	const { repo_name: repoName, checkout_path: checkout } = worktreeOf(workspace);
	return workspace.label === repoName || workspace.label === checkout?.split("/").filter(Boolean).at(-1);
};

/**
 * Decides which remembered parent shells to close: the workspace of a main checkout that a worktree was grouped under, once none is
 * left in its repository, when every pane is an idle shell and the user neither pinned nor renamed it. `ignore` lists workspaces
 * that are about to close and no longer count as children (a dry run). A parent must qualify for `confirmMs` before it is closed.
 * `state.parents` is the remembered set (apply noteParents first).
 * @returns {Promise<{ closes: object[], skips: string[], ops: object[], nextAt: number | null }>}
 */
export async function planParents({ workspaces, panes, state, now, confirmMs = CONFIRM_MS, config = {}, ignore = new Set() }, deps) {
	const closes = [];
	const skips = [];
	const ops = [];
	let nextAt = null;
	for (const [id, entry] of Object.entries(state.parents)) {
		const parent = workspaces.find((workspace) => workspace.workspace_id === id);
		if (!parent || isLinked(parent) || entry.checkout !== checkoutOf(parent) || !inScope(parent, config)) continue;
		const subject = `${parent.label} (workspace ${id})`;
		const children = workspaces.filter((workspace) => isLinked(workspace) && groupOf(workspace) === entry.group && !ignore.has(workspace.workspace_id));
		const mine = panes.filter((pane) => pane.workspace_id === id);
		let reason = null;
		if (children.length > 0) reason = `worktree workspace ${children.map((child) => child.label).join(", ")} is still open`;
		else if (isPinned(parent, state)) reason = "workspace is pinned";
		else if (recordOf(parent, state)?.renamed || !hasDefaultLabel(parent)) reason = "its name was changed";
		else if (mine.length === 0) reason = "it has no panes";
		else if (mine.some((pane) => pane.agent)) reason = `${mine.find((pane) => pane.agent).agent} is running in ${mine.find((pane) => pane.agent).pane_id}`;
		else if (mine.some((pane) => pane.focused)) reason = "focused pane";
		else {
			for (const pane of mine) {
				const info = await readProcessInfo(deps, pane.pane_id);
				if (!shellIsIdle(info)) {
					reason = `${describeForeground(info)} is running in ${pane.pane_id}`;
					break;
				}
			}
		}
		if (reason) {
			skips.push(`skip parent ${subject}: ${reason}`);
			if (id in state.parentCandidates) ops.push(del(["parentCandidates", id]));
			continue;
		}
		const since = state.parentCandidates[id] ?? now;
		if (!(id in state.parentCandidates)) ops.push(set(["parentCandidates", id], now));
		if (now - since < confirmMs) {
			skips.push(`wait parent ${subject}: no worktree workspace left and only idle shells, confirming for ${Math.ceil((confirmMs - (now - since)) / 1000)}s more`);
			nextAt = nextAt === null ? since + confirmMs : Math.min(nextAt, since + confirmMs);
		} else {
			closes.push({ workspaceId: id, label: parent.label, reason: "no worktree workspace left and only idle shells" });
		}
	}
	return { closes, skips, ops, nextAt };
}

/** Drops the agent and candidate records of panes that no longer exist. */
export function prunePanes(panes, state) {
	const live = new Set(panes.map((pane) => pane.terminal_id ?? pane.pane_id));
	return ["agentSeen", "candidates"].flatMap((name) => Object.keys(state[name]).filter((key) => !live.has(key)).map((key) => del([name, key])));
}

/** Forgets the pins nothing can match any more: a workspace id that is gone, and a checkout that is no longer on disk. */
export function prunePins(workspaces, state, git) {
	const live = new Set(workspaces.map((workspace) => workspace.workspace_id));
	return Object.keys(state.pins)
		.filter((key) => (key.startsWith("workspace:") ? !live.has(key.slice("workspace:".length)) : !git.exists(key)))
		.map((key) => del(["pins", key]));
}

/**
 * Moves the pins older versions keyed by a main checkout's path to the id of each live workspace on that checkout: only a linked
 * worktree's pin is kept by its checkout. A path no live workspace is on stays until one opens there or prunePins drops it.
 */
export function migratePins(workspaces, state) {
	const ops = [];
	for (const key of Object.keys(state.pins)) {
		if (key.startsWith("workspace:")) continue;
		const on = workspaces.filter((workspace) => checkoutOf(workspace) === key);
		if (on.length === 0 || on.some(isLinked)) continue;
		for (const workspace of on) ops.push(set(["pins", `workspace:${workspace.workspace_id}`], state.pins[key]));
		ops.push(del(["pins", key]));
	}
	return ops;
}

/** The pin action toggles the pin and nothing else: the name stays as it is. */
export function togglePin(workspace, state, now) {
	const key = pinKey(workspace);
	if (isPinned(workspace, state)) return { action: "unpin", key };
	return { action: "pin", key, entry: { auto: false, at: now } };
}
