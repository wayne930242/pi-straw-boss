// The reaper's decisions, with no I/O: which panes of a linked-worktree workspace to close, whether a closed workspace's checkout
// may be removed, which empty parent shell of a worktree group to close, when a rename is the user's, and what pinning does. sweep.mjs gathers Herdr's and git's state, calls these, and
// carries the results out.
//
// State is one JSON object the plugin keeps between runs; changes to it are returned as ops ({ op: "set" | "del", path, value }) so
// concurrent runs merge instead of overwriting each other.

/** A rename this long after a workspace appeared is the user's; pi-herdr-agents names its workspaces within seconds. */
export const RENAME_GRACE_MS = 60_000;
/** A pane must qualify for this long before it is closed, so an agent restarting in the same pane is not caught between runs. */
export const CONFIRM_MS = 60_000;
export const SWEEP_INTERVAL_MS = 10 * 60_000;
export const PIN_TOKEN = "pin";
// Nerd Font nf-md-pin (U+F0403), the same family as the tower icon in the sidebar.
export const PIN_GLYPH = String.fromCodePoint(0xf0403);

export const emptyState = () => ({
	initialized: false,
	seeded: false,
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
/** The key a pin is stored under: the checkout survives a workspace being reopened, the workspace id does not. */
export const pinKey = (workspace) => worktreeOf(workspace).checkout_path ?? `workspace:${workspace.workspace_id}`;
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
 * What a `workspace.renamed` event means. The user's rename pins the workspace, remembering the label it had before; a rename
 * soon after the workspace appeared is pi-herdr-agents naming it and changes nothing but the remembered label.
 * @returns {{ ops: object[], pin: { preLabel: string } | null, note: string | null }}
 */
export function onRename(workspace, state, now) {
	const record = recordOf(workspace, state);
	const remember = (createdAt) => set(["workspaces", workspace.workspace_id], { createdAt, label: workspace.label, checkout: checkoutOf(workspace) });
	if (!record) return { ops: [remember(0)], pin: null, note: null };
	if (record.label === workspace.label) return { ops: [], pin: null, note: null };
	const age = now - record.createdAt;
	if (record.createdAt !== 0 && age <= RENAME_GRACE_MS) {
		return { ops: [set(["workspaces", workspace.workspace_id], { ...record, label: workspace.label })], pin: null, note: null };
	}
	// The record keeps that the user renamed it: a parent shell with a name of the user's is never closed.
	const ops = [set(["workspaces", workspace.workspace_id], { ...record, label: workspace.label, renamed: true })];
	if (!isLinked(workspace) || isPinned(workspace, state)) return { ops, pin: null, note: null };
	return { ops, pin: { preLabel: record.label }, note: `auto-pin ${workspace.label}: renamed by the user (was "${record.label}")` };
}

/** Keeps a created/label record for every workspace; a workspace first seen after the first call is new, one from before is old. */
export function noteWorkspaces(workspaces, state, now, createdIds = new Set()) {
	const ops = state.seeded ? [] : [set(["seeded"], true)];
	for (const workspace of workspaces) {
		const record = recordOf(workspace, state);
		const checkout = checkoutOf(workspace);
		if (createdIds.has(workspace.workspace_id)) {
			// A created event is the word on a workspace's age, even over an older record: Herdr reuses ids of closed workspaces, and a
			// rename event may have made the record first.
			ops.push(set(["workspaces", workspace.workspace_id], { createdAt: now, label: workspace.label, checkout }));
		} else if (!record) {
			ops.push(set(["workspaces", workspace.workspace_id], { createdAt: state.seeded ? now : 0, label: workspace.label, checkout }));
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

/** Forgets the pins of workspaces that can no longer come back: a workspace id that is gone, and a checkout that is no longer on disk. */
export function prunePins(workspaces, state, git) {
	const live = new Set(workspaces.map((workspace) => workspace.workspace_id));
	return Object.keys(state.pins)
		.filter((key) => (key.startsWith("workspace:") ? !live.has(key.slice("workspace:".length)) : !git.exists(key)))
		.map((key) => del(["pins", key]));
}

/** The pin action toggles: unpinning renames the workspace back to the label it had before the pin. */
export function togglePin(workspace, state, now) {
	const key = pinKey(workspace);
	if (isPinned(workspace, state)) {
		// Without a record the checkout's name is the best guess for a linked worktree; any other workspace keeps its name.
		const basename = isLinked(workspace) ? worktreeOf(workspace).checkout_path?.split("/").filter(Boolean).at(-1) : undefined;
		const label = state.pins[key]?.preLabel ?? basename;
		return { action: "unpin", key, restoreLabel: label && label !== workspace.label ? label : null };
	}
	return { action: "pin", key, entry: { preLabel: workspace.label, auto: false, at: now } };
}
