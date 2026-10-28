import type { AllyTeam } from "./holder.ts";
import { restrictLabel } from "./text.ts";

// The ally towers `tower_list` adds (docs/specs/2026-10-25-straw-link.md): kept apart from runtime.ts so the sb server's tool for a run can list them without the session's hooks.

export interface RemoteTower {
	remote: true;
	team: string;
	device: { id: string; shortId: string; label: string };
	online: boolean;
	seenSecondsAgo: number | null;
	workspace: string | null;
	tower: string;
	tabs: { label: string; state: string }[];
}
/** The ally towers `tower_list` adds: one row per workspace a teammate's presence names, or one row for a device whose presence says none. What a presence says is cut to the label character set. */
export function remoteTowers(teams: AllyTeam[]): RemoteTower[] {
	return teams.flatMap((team) => team.devices.flatMap((d): RemoteTower[] => {
		const base = { remote: true as const, team: team.name, device: { id: d.id, shortId: d.short, label: d.label }, online: d.online, seenSecondsAgo: d.ageMs === null ? null : Math.round(d.ageMs / 1000) };
		if (d.workspaces.length === 0) return [{ ...base, workspace: null, tower: "unknown", tabs: [] }];
		return d.workspaces.map((w) => ({ ...base, workspace: restrictLabel(w.label), tower: restrictLabel(w.tower), tabs: w.tabs.map((t) => ({ label: restrictLabel(t.label), state: restrictLabel(t.state) })) }));
	}));
}
