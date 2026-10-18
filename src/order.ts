import { subagents } from "./dashboard.ts";
import { type HerdrRun, type HerdrTab, isSub, type Pane, panes, type Place, report, tabs, workspaces, type Workspace } from "./herdr.ts";

// Two display tokens for the sidebar plugin and for Herdr's own Agents rows, written next to `sb_role`:
//  - `sb_order`: a sort key that lays the net out as the head tower's workspace first, then the other workspaces in Herdr's order, in each the tower
//    and then the tabs in tab order, in each tab the main agent and then the members, and every subagent right after the session that launched it,
//    its own subagents after it in turn. Segments are fixed-width and `.`-separated, so plain string order is the numeric order of every segment,
//    and a subagent's key is its parent's key plus one more segment, which sorts after the parent and before the parent's next sibling.
//  - `sb_mark`: a short label that says what a net member is, a star for a main agent, a dot for a member, and an arrow and the launcher's name for a subagent.
//    A tower has none: its tab already carries the lighthouse glyph.
// A session writes them for itself and for the subagents it launched, which never join and write nothing, on the same 4 minute refresh as `sb_role`.

/** The glyphs sit in Hack Nerd Font and MesloLGS NF: Font Awesome's star (U+F005), the middle dot, and the down-right arrow. */
export const MARK = { main: "\uf005 main", member: "\u00b7 member" } as const;
export const ARROW = "\u21b3";
const MAX_DEPTH = 3;
const NAME_MAX = 24;
const part = (n: number, width = 3) => String(n).padStart(width, "0");
const short = (name: string) => (name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name);

/**
 * The key of a session that is in the net, or undefined when Herdr cannot place it. Workspaces count among the base ones (a sub workspace is a
 * linked worktree whose sessions hang under their launcher), the head tower's workspace being the first of them; a pane's slot is its place among
 * its tab's panes, so every member has a key of its own.
 */
export function orderKey(role: "tower" | "main" | "member", pane: Pane, ps: Pane[], all: Workspace[], tabList: HerdrTab[]): string | undefined {
	const base = all.filter((w) => !isSub(w)).findIndex((w) => w.workspace_id === pane.workspace_id);
	if (base < 0) return undefined;
	if (role === "tower") return `${part(base)}.0`;
	const tab = tabList.findIndex((t) => t.tab_id === pane.tab_id), slot = ps.filter((p) => p.tab_id === pane.tab_id).findIndex((p) => p.pane_id === pane.pane_id);
	return tab < 0 || slot < 0 ? undefined : `${part(base)}.1.${part(tab)}.${role === "main" ? 0 : 1}.${part(slot)}`;
}

/** The tokens of the live subagents below a session, each keyed after its launcher. Subagents that finished have no pane to mark. */
export function descendants(parent: Pane | undefined, key: string, name: string, ps: Pane[], now: number, depth = 1): Kid[] {
	if (!parent) return [];
	return subagents(parent, ps, now).flatMap((row, i) => {
		if (!row.pane) return [];
		const order = `${key}.${part(i, 2)}`;
		return [{ pane: row.pane, order, mark: `${ARROW} ${short(name)}` }, ...(depth < MAX_DEPTH ? descendants(ps.find((p) => p.pane_id === row.pane), order, row.text, ps, now, depth + 1) : [])];
	});
}

/** The subagent panes a session marks: each gets `sb_order` and `sb_mark`. */
export interface Kid { pane: string; order: string; mark: string }

/**
 * What a session publishes besides its role: its own two tokens (null clears them when Herdr cannot place the session, and a tower has no
 * mark) and those of the subagents it launched. Reads Herdr only.
 */
export async function netTokens(run: HerdrRun, place: Place, role: "tower" | "main" | "member", name: string, now = Date.now()): Promise<{ own: Record<string, string | null>; kids: Kid[] }> {
	const [ps, all, tabList] = [await panes(run), await workspaces(run), await tabs(run, place.workspaceId)];
	const pane = ps.find((p) => p.pane_id === place.paneId), key = pane && orderKey(role, pane, ps, all, tabList);
	return { own: { sb_order: key ?? null, sb_mark: role === "tower" ? null : MARK[role] }, kids: key ? descendants(pane, key, name, ps, now) : [] };
}

/** Writes the subagents' tokens and clears those of subagent panes marked before and gone now. Returns the panes now marked. A failed write waits for the next refresh. */
export async function markKids(run: HerdrRun, kids: Kid[], before: Set<string>): Promise<Set<string>> {
	for (const kid of kids) await report(run, "pane", kid.pane, { sb_order: kid.order, sb_mark: kid.mark }).catch(() => {});
	const marked = new Set(kids.map((k) => k.pane));
	await clearOrder(run, [...before].filter((id) => !marked.has(id)));
	return marked;
}

/** Removes both tokens from panes, ignoring a pane that has already closed. */
export const clearOrder = (run: HerdrRun, paneIds: string[]) => Promise.all(paneIds.map((id) => report(run, "pane", id, { sb_order: null, sb_mark: null }).catch(() => {})));
