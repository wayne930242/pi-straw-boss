import { panes, workspaces } from "./herdr.ts";
import { FRESH_MS, readRecord, restartingFresh, slotOf, towerId } from "./server/record.ts";
import type { Election } from "./election.ts";
import type { Reach } from "./reach.ts";
import type { Roles } from "./roles.ts";
import type { Kit } from "./state.ts";

// The tower and the mains go together (guard below): Herdr's events start each check, and a sweep every GUARD_MS catches what no event tells; how
// long a tower may be gone (a /reload) before the mains are cleared, and how long a fresh main's tower may take to open.
export const GUARD_MS = 4 * 60_000;
const TOWER_GRACE_MS = 15_000, TOWER_OPEN_MS = 60_000;
/** A tower identity of the sb server counts as live through a restart of the server that is under way, for this long from the restart's beginning (docs/specs/2026-10-26-sb-backend.md, Restarts and upgrades). */
const RESTART_COVER_MS = 30_000;
// How long the guard leaves a tab without a main for the one a Herdr restore is bringing back (roles.ts), before it crowns whoever is there.
export const RESTORE_WAIT_MS = 30_000;

/** The tab channel owner's check that a base has mains only while it has a tower. */
export function createGuard({ cfg, s, me, guiDir }: Kit, { claim, pin, openTower, roles }: Election & Pick<Reach, "openTower"> & { roles: Roles }) {
	const { run, autoTower, couple, guardMs, events, now, restoreMs } = cfg;
	// A base has mains only while it has a tower. The owner of each tab channel, its earliest member, checks when Herdr says a workspace's tokens
	// or this workspace's panes changed, and every guardMs: with a live tower and no live main it promotes itself; with no tower for
	// TOWER_GRACE_MS (at once when the tower quit) it clears the tab's main, unless that main is younger than TOWER_OPEN_MS and its tower may
	// still be opening. A check that has to wait for either sets one timer for it. A demoted main keeps its subagents.
	let missing: number | undefined, guardTimer: ReturnType<typeof setInterval> | undefined, unlisten: (() => void) | undefined;
	let soon: ReturnType<typeof setTimeout> | undefined, soonAt = Infinity, checking = false, again: boolean | undefined;
	// When the guard first held back for the pane of a main a restore has yet to bring back.
	const awaited = new Map<string, number>();
	/** The time until which the tab waits for the main a Herdr restore is bringing back: its pane runs in a new terminal, and its pi, joined or not, has not taken the tab yet. */
	const restoring = async () => {
		const record = roles.mainOf(s.at.tabId, s.at.workspaceId);
		if (!record?.terminal) return undefined;
		let pane;
		try {
			pane = (await panes(run, s.at.workspaceId)).find((p) => p.pane_id === record.pane);
		} catch {
			return undefined; // a pane list that cannot be had is no reason to hold the crown back
		}
		if (!pane?.terminal_id || pane.terminal_id === record.terminal) return undefined;
		// A pane id can be reused: where Herdr names the pane's session, it must be the recorded main's.
		if (pane.agent_session?.value && record.file && pane.agent_session.value !== record.file) return undefined;
		const until = awaited.get(record.pane) ?? now();
		awaited.set(record.pane, until);
		return now() < until + restoreMs ? until + restoreMs : undefined;
	};
	const guard = async (joining = false) => {
		const owner = s.c.snapshot().owner?.sessionId === me();
		if (!s.joined || s.isTower || s.stopped || (!owner && !joining)) return void (missing = undefined);
		const sessions = await s.c.listSessions(), all = await workspaces(run), ws = all.find((w) => w.workspace_id === s.at.workspaceId);
		const live = (id?: string) => Boolean(id && sessions.some((x) => x.id === id));
		// The sb server restarting (an upgrade, a restart) has its tower identities off the broker for a moment. The workspace's own slot's identity counts as live while the slot's server.json
		// has a fresh `restarting` that began less than 30 s ago, so a slow restart demotes no main; a longer one falls back to the grace below. Only this Herdr's server counts.
		const covered = (id?: string) => {
			if (!id || !ws || id !== towerId(slotOf(cfg.stateDir ?? guiDir, cfg.env), ws.workspace_id)) return false;
			const restarting = readRecord(slotOf(cfg.stateDir ?? guiDir, cfg.env))?.restarting, began = restarting ? Date.parse(restarting.began) : NaN;
			if (!restartingFresh({ restarting }, now()) || !(now() - began < RESTART_COVER_MS)) return false;
			wake(Math.min(Date.parse(restarting!.since) + FRESH_MS, began + RESTART_COVER_MS) + 100);
			return true;
		};
		const towerLive = (id?: string) => live(id) || covered(id);
		const state = s.c.snapshot().state?.payload as { main?: string; since?: number } | undefined, main = s.pinned ?? state?.main;
		if (towerLive(ws?.tokens?.tower)) {
			missing = undefined;
			if (owner && !live(main)) {
				// Whoever joins a restored tab first would be crowned over the main the restore is bringing back.
				const waitUntil = await restoring();
				if (waitUntil === undefined) await claim(s.c, me(), false);
				else wake(waitUntil);
			}
			return;
		}
		// A tower opens by itself when this base has two members while another base already has one: they start to collide (the other rule, a
		// member dispatching a subagent, promotes it in tool_call, and a promotion opens the tower). A member that joins checks it too.
		// A tower closed on purpose stays closed until the base grows past the members it had then (a subagent or /boss tower opens it any time).
		if (autoTower && all.some((w) => w.workspace_id !== s.at.workspaceId && live(w.tokens?.tower))) {
			const members = (await panes(run, s.at.workspaceId)).filter((p) => ["member", "main"].includes(p.tokens?.sb_role ?? "")).length;
			if (members >= 2 && members > Number(ws?.tokens?.sb_tower_quit ?? -1)) return void (await openTower(undefined, true));
		}
		if (!owner) return;
		missing ??= now();
		if (!live(main) || (s.pinned && s.pinned !== state?.main)) return;
		if (now() - (state?.since ?? 0) < TOWER_OPEN_MS) return wake((state?.since ?? 0) + TOWER_OPEN_MS);
		if (ws?.tokens?.sb_tower_quit !== undefined || now() - missing >= TOWER_GRACE_MS) pin(s.c);
		else wake(missing + TOWER_GRACE_MS);
	};
	/** One check at a time, queued with the claims; a request during a check runs once more after it. */
	const check = (joining = false) => {
		if (!couple) return;
		if (checking) return void (again = Boolean(again) || joining);
		checking = true;
		s.queue = s.queue.then(() => guard(joining).catch(() => {})).finally(() => {
			checking = false;
			const next = again;
			again = undefined;
			if (next !== undefined) check(next);
		});
	};
	/** A check at `when` (on the clock `now`), keeping only the earliest one asked for. */
	const wake = (when: number) => {
		if (when >= soonAt) return;
		clearTimeout(soon);
		soonAt = when;
		(soon = setTimeout(() => ((soonAt = Infinity), check()), Math.max(0, when - now()) + 50)).unref();
	};
	return {
		check,
		keep() {
			if (!couple) return;
			if (guardMs && !guardTimer) (guardTimer = setInterval(() => check(), guardMs)).unref();
			unlisten ??= events(["workspace.metadata_updated", "pane.closed", "pane.agent_detected"], (e) => {
				const ws = e && (e.event === "workspace_metadata_updated" ? undefined : String(e.data.workspace_id ?? (e.data.pane as { workspace_id?: string } | undefined)?.workspace_id ?? ""));
				if (!e || ws === undefined || ws === s.at.workspaceId) check(); // any workspace's tokens (its tower), this one's panes, or a reconnection
			});
			check(true);
		},
		stop() {
			clearInterval(guardTimer);
			clearTimeout(soon);
			unlisten?.();
			[guardTimer, unlisten, soonAt] = [undefined, undefined, Infinity];
		},
	};
}
export type Guard = ReturnType<typeof createGuard>;
