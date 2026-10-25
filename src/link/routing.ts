import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSub, type HerdrTab, type Pane, type Session, type Workspace } from "../herdr.ts";
import { shortId } from "./device.ts";

// Where a Straw Link message goes, and who a `device` argument means (docs/specs/2026-10-25-straw-link.md, Addressing and delivery).

/** One reading of Herdr and pi-intercom: the live sessions, every pane, the workspaces in Herdr's order, and their tabs. */
export interface NetView { sessions: Session[]; panes: Pane[]; workspaces: Workspace[]; tabs: HerdrTab[] }

const real = (path: string): string | undefined => {
	try {
		return realpathSync.native(path);
	} catch {
		return undefined;
	}
};
const within = (child: string, parent: string): string | undefined => {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? rel : undefined;
};

/** Whether `dir` is `project` or below it, where each really is (a symlink is followed, so a link inside the project that leads out is out). A path that does not exist is not inside. */
export function inside(dir: string, project: string): boolean {
	if (!isAbsolute(dir) || !isAbsolute(project)) return false;
	const [d, p] = [real(dir), real(project)];
	return d !== undefined && p !== undefined && within(d, p) !== undefined;
}
/** How many directories below the project root `dir` is (0 for the root itself); undefined when it is not inside. */
function depth(dir: string, project: string): number | undefined {
	const [d, p] = [real(dir), real(project)];
	const rel = d !== undefined && p !== undefined ? within(d, p) : undefined;
	return rel === undefined ? undefined : rel === "" ? 0 : rel.split(sep).length;
}

/**
 * Why a directory cannot be a team's project, or undefined when it can. A project may not be the home folder or contain `~/.pi` (or be inside it),
 * because everything under it would be reachable by a remote turn (spec, Addressing and delivery).
 */
export function projectProblem(project: string, { home, agentDir }: { home: string; agentDir: string }): string | undefined {
	if (!isAbsolute(project)) return "The project has to be an absolute path";
	const dir = real(project);
	if (dir === undefined) return "The project directory does not exist";
	const realHome = real(home) ?? resolve(home);
	if (dir === realHome) return "The project may not be the home folder";
	const pi = real(join(home, ".pi")) ?? join(realHome, ".pi");
	if (within(pi, dir) !== undefined) return "The project may not contain ~/.pi";
	if (within(dir, pi) !== undefined) return "The project may not be inside ~/.pi";
	const agent = existsSync(agentDir) ? real(agentDir) : undefined;
	if (agent && (within(agent, dir) !== undefined || within(dir, agent) !== undefined)) return "The project may not contain or be inside the pi agent folder";
	return undefined;
}

export interface TowerPick { session: Session; pane: Pane; workspace: Workspace }
/**
 * The tower a delivery for `project` goes to: a live tower session whose pane's cwd is inside the project. With several, the one whose cwd is
 * closest to the project root, then the first in Herdr's workspace order. Mains and members never receive link deliveries. `toWorkspace`, when
 * the sender named one, restricts the choice to the workspace with that label, and a message with no tower there waits instead of going to another.
 */
export function towerFor(view: NetView, project: string, toWorkspace?: string): TowerPick | undefined {
	return towersFor(view, project, toWorkspace)[0];
}
/** Every tower `towerFor` could pick, in the order it would pick them. */
export function towersFor(view: NetView, project: string, toWorkspace?: string): TowerPick[] {
	const picks = view.panes.flatMap((pane) => {
		if (pane.tokens?.sb_role !== "tower" || !pane.cwd) return [];
		const workspace = view.workspaces.find((w) => w.workspace_id === pane.workspace_id);
		const session = view.sessions.find((x) => x.herdrLocation?.paneId === pane.pane_id);
		const depthIn = depth(pane.cwd, project);
		if (!workspace || isSub(workspace) || !session || depthIn === undefined) return [];
		if (toWorkspace && workspace.label !== toWorkspace) return [];
		return [{ session, pane, workspace, depthIn, order: view.workspaces.indexOf(workspace) }];
	});
	picks.sort((a, b) => a.depthIn - b.depthIn || a.order - b.order);
	return picks.map((p) => ({ session: p.session, pane: p.pane, workspace: p.workspace }));
}

export interface MemberRef { team: string; id: string; label?: string }
export type Resolved = { ok: true; team: string; id: string } | { ok: false; error: string };
const describe = (m: MemberRef) => `${m.label ?? "unnamed"} (${shortId(m.id)})`;
/**
 * The device `query` names among `members` (every team the sender's tower belongs to): an id, a short id (its first 6 characters), or a label.
 * Anything that fits more than one device is an error that lists the candidates (R-F020), and so is this device itself.
 */
export function resolveDevice(query: string, members: MemberRef[], self: string): Resolved {
	const q = query.trim();
	if (!q) return { ok: false, error: "Name a device by its short id, its id, or its label" };
	const id = q.toLowerCase();
	const hits = members.filter((m) => m.id === id || shortId(m.id) === id || m.label === q);
	const seen = new Set<string>(), unique = hits.filter((m) => !seen.has(`${m.team}/${m.id}`) && !!seen.add(`${m.team}/${m.id}`));
	if (unique.length > 1) return { ok: false, error: `"${q}" fits ${unique.length} devices: ${unique.map(describe).join(", ")}. Name one by its short id` };
	const [only] = unique;
	if (!only) {
		const others = members.filter((m) => m.id !== self);
		return { ok: false, error: `No device "${q}" in the team. Devices: ${others.map(describe).join(", ") || "none besides this one"}` };
	}
	if (only.id === self) return { ok: false, error: "That is this device; use call_tower or tower_send without a device for a local tower" };
	return { ok: true, team: only.team, id: only.id };
}
