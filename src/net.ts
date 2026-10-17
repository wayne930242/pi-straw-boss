import { type Mark, markOf, type Row, sessionMark, subagents } from "./dashboard.ts";
import { headOf, type HerdrRun, isSub, type Pane, panes, parentOf, type Session, workspaces, type Workspace } from "./herdr.ts";

// The whole straw net as one JSON-able snapshot for the browser view: every workspace as a base with its tower, tabs, agents,
// and subagents (linked to their launcher the way the tower dashboard links them), and sub workspaces as outposts.

export interface Unit { id: string; name: string; role: "main" | "member" | "subagent"; mark: Mark; note?: string; subs: Unit[] }
export interface Tab { id: string; label: string; units: Unit[] }
export interface Outpost { id: string; label: string; mark: Mark }
export interface Base { id: string; label: string; mark: Mark; head: boolean; tower: { name: string; mark: Mark } | null; tabs: Tab[]; outposts: Outpost[] }
export interface Net { bases: Base[] }
export interface NetInput { sessions: Session[]; panes: Pane[]; workspaces: Workspace[]; children(pane: Pane | undefined): Row[] }

const joinedRole = (token?: string): "main" | "member" | undefined => (token === "main" || token === "member" ? token : undefined);

/**
 * The pure half: sessions, panes, and workspaces in, the net out. Sessions that did not join (no main or member token) are left out,
 * and so are workspaces with no part in the net (no live tower, nobody joined): a base is a workspace the net reaches.
 */
export function buildNet({ sessions, panes: ps, workspaces: all, children }: NetInput): Net {
	const paneOf = (s: Session) => ps.find((p) => p.pane_id === s.herdrLocation?.paneId);
	const note = (mark: Mark, status?: string) => ({ working: status, waiting: "waiting on a question" })[mark as "working"];
	const joined = sessions.flatMap((s) => {
		const pane = paneOf(s), role = joinedRole(pane?.tokens?.sb_role);
		return role ? [{ s, pane, role, base: s.herdrLocation?.workspace?.id, tab: s.herdrLocation?.tab }] : [];
	});
	const rowsOf = new Map(joined.map(({ s, pane }) => [s.id, children(pane)]));
	// A sub workspace that already shows as a launched subagent is not an outpost as well.
	const claimed = new Set([...rowsOf.values()].flat().map((r) => r.workspace));
	const bases = all.filter((w) => !isSub(w)).flatMap((w): Base[] => {
		const mine = joined.filter((j) => j.base === w.workspace_id && j.tab);
		const tabs = Object.values(Object.groupBy(mine, (j) => j.tab!.id)).map((group = []): Tab => ({
			id: group[0]!.tab!.id,
			label: group[0]!.tab!.label,
			units: group.toSorted((a, b) => Number(b.role === "main") - Number(a.role === "main")).map(({ s, pane, role }): Unit => {
				const mark = sessionMark(s, pane);
				const subs = (rowsOf.get(s.id) ?? []).map((r): Unit => ({ id: `${s.id}/${r.text}`, name: r.text, role: "subagent", mark: r.mark, note: r.note, subs: [] }));
				return { id: s.id, name: s.name ?? s.id, role, mark, note: note(mark, s.status), subs };
			}),
		}));
		const outposts = all.filter((x) => isSub(x) && parentOf(all, x) === w && !claimed.has(x.workspace_id)).map((x): Outpost => ({ id: x.workspace_id, label: x.label, mark: markOf(x.agent_status) }));
		const tower = sessions.find((s) => s.id === w.tokens?.tower);
		const marks = [...tabs.flatMap((t) => t.units.flatMap((u) => [u.mark, ...u.subs.map((c) => c.mark)])), ...outposts.map((o) => o.mark)];
		// A base shows what needs attention most: a waiting unit, then a working one, else the workspace's own status.
		const mark = (["waiting", "working"] as const).find((m) => marks.includes(m)) ?? markOf(w.agent_status);
		if (!tower && !tabs.length) return [];
		return [{ id: w.workspace_id, label: w.label, mark, head: w === headOf(all), tower: tower ? { name: tower.name ?? tower.id, mark: sessionMark(tower, paneOf(tower)) } : null, tabs, outposts }];
	});
	return { bases };
}

/** One reading of Herdr and intercom as a net. */
export async function collectNet({ run, sessions, now = Date.now() }: { run: HerdrRun; sessions(): Promise<Session[]>; now?: number }): Promise<Net> {
	const [live, ps, all] = [await sessions(), await panes(run), await workspaces(run)];
	return buildNet({ sessions: live, panes: ps, workspaces: all, children: (pane) => subagents(pane, ps, now) });
}
