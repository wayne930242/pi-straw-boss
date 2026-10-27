import type { Control } from "./closemain.ts";
import { collect, startDashboard } from "./dashboard.ts";
import type { Digest } from "./digest.ts";
import { answersLive, readRecord, urlOf } from "./handover.ts";
import { watchHead } from "./headwatch.ts";
import { headOf, report, waitFor, workspaces, panes, place } from "./herdr.ts";
import type { Membership } from "./membership.ts";
import type { Presence } from "./presence.ts";
import type { Reach } from "./reach.ts";
import type { Roles } from "./roles.ts";
import { towerRunsEnabled } from "./server/towerruns.ts";
import { ENTRY, type Kit } from "./state.ts";
import type { Tools } from "./tools.ts";

const SETTLE_MS = 2000, HANDOVER_RETRY_MS = 1000;
// What Herdr reports that changes the dashboard: panes (their agent status and tokens), tabs, and workspaces (their tokens and labels), coming, going, moving, and taking focus (the spinner runs only on screen).
const SCREEN_EVENTS = ["pane.created", "pane.closed", "pane.updated", "pane.moved", "pane.exited", "pane.agent_detected", "tab.created", "tab.closed", "tab.renamed", "tab.moved", "tab.focused", "workspace.focused", "workspace.created", "workspace.updated", "workspace.metadata_updated", "workspace.renamed", "workspace.moved", "workspace.reordered", "workspace.closed"];

/** A session that is a tower (`STRAW_BOSS_ROLE=tower`, or marked so in its session) takes the role: its marks, its tools, its dashboard. */
export function createTower({ pi, cfg, s, guiDir, me, tell }: Kit, { membership, presence, tools, control, digest, roles, reach }: { membership: Membership; presence: Presence; tools: Tools; control: Control; digest: Digest; roles: Roles; reach: Reach }) {
	const { run, world, sleep, events } = cfg;
	return async function startTower() {
		s.at = await place(run);
		// With the tower service on, a resident tower of this build (opened by an older session, or brought back by a Herdr restore) hands its workspace to the sb server at its start,
		// before any agent learns its id, and quits; its pane becomes the standing pane (docs/specs/2026-10-26-sb-backend.md, Migration from resident towers). A server that cannot
		// take it, or a workspace another tower holds, leaves it resident as before.
		if (towerRunsEnabled(guiDir)) {
			try {
				// The server may have adopted the pane while the reply was lost; `ensure-tower` is idempotent, so one more ask tells (and a server that really failed fails again).
				const got = await reach.handOver(s.at.workspaceId, s.at.paneId).catch(async (cause: Error) => (await sleep(HANDOVER_RETRY_MS), reach.handOver(s.at.workspaceId, s.at.paneId).catch(() => Promise.reject(cause))));
				if (!got.resident) {
					s.isTower = false; // nothing of this session's role is cleared at its shutdown: the server owns the marks now
					s.closing = { keepPane: true }; // the pane stays, at its shell prompt, as the standing pane
					roles.forget();
					tell("Straw Boss: the sb server stands in for this workspace's tower now; this resident tower hands over and quits.");
					return void s.quit?.();
				}
			} catch (error) {
				tell(`Straw Boss: the sb server could not take over this tower, so it stays resident: ${(error as Error).message}`, "warning");
			}
		}
		membership.connect(false);
		await membership.connected();
		if (!s.saved.tower) pi.appendEntry(ENTRY, { tower: true, workspaceId: s.at.workspaceId });
		await report(run, "pane", s.at.paneId, { sb_role: "tower" });
		await sleep(SETTLE_MS);
		const all = await workspaces(run);
		const [ps, sessions] = [await panes(run, s.at.workspaceId), await s.c.listSessions()];
		if (s.stopped) return; // a shutdown during the waits: nothing may start after it
		const ws = all.find((w) => w.workspace_id === s.at.workspaceId);
		const holder = ws?.tokens?.tower;
		const rival = ps.find((p) => p.pane_id !== s.at.paneId && p.agent === "pi" && p.tokens?.sb_role === "tower");
		// A second tower in one workspace yields before it publishes: the live token holder wins, otherwise the lower tab id.
		if ((holder && holder !== me() && sessions.some((x) => x.id === holder)) || (rival && rival.tab_id < s.at.tabId)) {
			await report(run, "pane", s.at.paneId, { sb_role: null });
			s.closing = { keepPane: true }; // its tab goes with it already
			roles.forget();
			await run(["tab", "close", s.at.tabId]);
			return;
		}
		s.holdsTower = true;
		roles.remember("tower");
		s.info = { workspace: ws?.label ?? s.at.workspaceId, head: headOf(all)?.label ?? "" };
		tools.addNetTools();
		tools.addOpenMain();
		tools.addTowerComms();
		control.register();
		s.headWatch = watchHead({ run, events, digest, workspaceId: s.at.workspaceId });
		presence.keepFresh();
		await presence.publish();
		// The dashboard lives exactly as long as this session holds the tower role.
		if (s.hasUI) s.dashboard = startDashboard({ ui: s.ui!, watch: (refresh) => events(SCREEN_EVENTS, () => refresh()), collect: () => collect({ run, world, sessions: () => s.c.listSessions(), workspaceId: s.at.workspaceId, tabId: s.at.tabId, gui: async () => { const r = readRecord(guiDir); return r && (await answersLive(r)) ? urlOf(r) : undefined; } }) });
	};
}
