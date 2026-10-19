import { collect, startDashboard } from "./dashboard.ts";
import { answers, readRecord, urlOf } from "./handover.ts";
import { headOf, report, waitFor, workspaces, panes, place } from "./herdr.ts";
import type { Membership } from "./membership.ts";
import type { Presence } from "./presence.ts";
import { ENTRY, type Kit } from "./state.ts";
import type { Tools } from "./tools.ts";

const SETTLE_MS = 2000;
// What Herdr reports that changes the dashboard: panes (their agent status and tokens), tabs, and workspaces (their tokens and labels), coming, going, and moving.
const SCREEN_EVENTS = ["pane.created", "pane.closed", "pane.updated", "pane.moved", "pane.exited", "pane.agent_detected", "tab.created", "tab.closed", "tab.renamed", "tab.moved", "workspace.created", "workspace.updated", "workspace.metadata_updated", "workspace.renamed", "workspace.moved", "workspace.closed"];

/** A session that is a tower (`STRAW_BOSS_ROLE=tower`, or marked so in its session) takes the role: its marks, its tools, its dashboard. */
export function createTower({ pi, cfg, s, guiDir, me }: Kit, { membership, presence, tools }: { membership: Membership; presence: Presence; tools: Tools }) {
	const { run, world, sleep, events } = cfg;
	return async function startTower() {
		s.at = await place(run);
		membership.connect(false);
		await membership.connected();
		if (!s.saved.tower) pi.appendEntry(ENTRY, { tower: true, workspaceId: s.at.workspaceId });
		await report(run, "pane", s.at.paneId, { sb_role: "tower" });
		await sleep(SETTLE_MS);
		const all = await workspaces(run);
		const [ps, sessions] = [await panes(run, s.at.workspaceId), await s.c.listSessions()];
		const ws = all.find((w) => w.workspace_id === s.at.workspaceId);
		const holder = ws?.tokens?.tower;
		const rival = ps.find((p) => p.pane_id !== s.at.paneId && p.agent === "pi" && p.tokens?.sb_role === "tower");
		// A second tower in one workspace yields before it publishes: the live token holder wins, otherwise the lower tab id.
		if ((holder && holder !== me() && sessions.some((x) => x.id === holder)) || (rival && rival.tab_id < s.at.tabId)) {
			await report(run, "pane", s.at.paneId, { sb_role: null });
			s.closing = { keepPane: true }; // its tab goes with it already
			await run(["tab", "close", s.at.tabId]);
			return;
		}
		s.holdsTower = true;
		s.info = { workspace: ws?.label ?? s.at.workspaceId, head: headOf(all)?.label ?? "" };
		tools.addNetTools();
		tools.addOpenMain();
		presence.keepFresh();
		await presence.publish();
		// The dashboard lives exactly as long as this session holds the tower role.
		if (s.hasUI) s.dashboard = startDashboard({ ui: s.ui!, watch: (refresh) => events(SCREEN_EVENTS, () => refresh()), collect: () => collect({ run, world, sessions: () => s.c.listSessions(), workspaceId: s.at.workspaceId, gui: async () => { const r = readRecord(guiDir); return r && (await answers(r)) ? urlOf(r) : undefined; } }) });
	};
}
