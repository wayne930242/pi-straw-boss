import { subagents } from "./netdata.ts";
import { ARROW, type HerdrRun, type HerdrTab, type HerdrWorld, isSub, MARK, type Pane, type Place, report, type Workspace, worldOf } from "./herdr.ts";

// Five display tokens for the sidebar plugin and for Herdr's own Agents rows, written next to `sb_role`:
//  - `sb_order`: a sort key that lays the net out as the head tower's workspace first, then the other workspaces in Herdr's order, in each the tower
//    and then the tabs in tab order, in each tab the main agent and then the members, and every subagent right after the session that launched it,
//    its own subagents after it in turn. Segments are fixed-width and `.`-separated, so plain string order is the numeric order of every segment,
//    and a subagent's key is its parent's key plus one more segment, which sorts after the parent and before the parent's next sibling.
//  - `sb_mark`: a short label that says what a net member is, a star (U+F005) alone for a main agent, a person (U+F007) alone for a member, and `[sub]` and the launcher's name for a subagent.
//    A tower has none: its tab already carries the radio tower glyph.
//  - `sb_main_tab` / `sb_tab`: a main agent's or a member's tab label, one token per role so a row can color each (a Herdr rule sees only its own token).
//    A member's keeps the `sb_tab` name it has had since 0.7.2, so a row reading it works with sessions that have not reloaded; 0.13.3's `sb_member_tab` is cleared.
//  - `sb_indent`: a tree branch on a subagent alone, like Herdr's Spaces panel draws a worktree: `├─` while a later subagent of the same launcher is marked, `└─` on the last. A row put before the state icon shows it as the
//    indent under the launcher. A tower, a main agent and a member carry none.
//  - `sb_name`: a subagent's own name, as pi-herdr-agents shows it. Herdr's pane label held it until a new server dropped the label; a row can show the token instead. A subagent alone carries one.
// A session writes them for itself and for the subagents it launched, which never join and write nothing, on the same 4 minute refresh as `sb_role`.
// A launched subagent whose pi Herdr has not detected yet is marked as soon as Herdr reports it (presence.ts), not at the next refresh.

/** What `sb_indent` holds on a subagent: the branch to it from its launcher, and `last` for the youngest marked sibling. */
export const INDENT = { more: "\u251c\u2500", last: "\u2514\u2500" } as const;
// The dashboard shows eight subagents per session, but every live one is keyed: one left out would sort outside its launcher's span. Three digits count them.
const MAX_KIDS = 999;
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

/**
 * The tokens of the live subagents below a session, each keyed after its launcher, at any depth. Subagents that finished have no pane to mark;
 * a pane already marked on the way down (a cycle in the launch records) is not marked again, which also ends the descent.
 */
export function descendants(parent: Pane | undefined, key: string, name: string, ps: Pane[], now: number, seen = new Set<string>(parent ? [parent.pane_id] : [])): Kid[] {
	if (!parent) return [];
	return subagents(parent, ps, now, MAX_KIDS).flatMap((row, i, rows) => {
		if (!row.pane || seen.has(row.pane)) return [];
		seen.add(row.pane);
		const order = `${key}.${part(i)}`, indent = rows.slice(i + 1).some((r) => r.pane && !seen.has(r.pane)) ? INDENT.more : INDENT.last;
		return [{ pane: row.pane, order, mark: `${ARROW} ${short(name)}`, indent, name: short(row.text) }, ...descendants(ps.find((p) => p.pane_id === row.pane), order, row.text, ps, now, seen)];
	});
}

/**
 * Whether a subagent below a session has no pi pane to mark yet: it launched (its activity file is there) but Herdr shows no pi on its session file, as at
 * pi's trust prompt. One whose activity says it is done is not waited for, so the wait ends with it, not 10 minutes later. Reads the records `descendants` reads.
 */
export function unplaced(parent: Pane | undefined, ps: Pane[], now: number, seen = new Set<string>(parent ? [parent.pane_id] : [])): boolean {
	if (!parent) return false;
	return subagents(parent, ps, now, MAX_KIDS).some((row) => {
		if (!row.pane) return !row.finished;
		if (seen.has(row.pane)) return false;
		seen.add(row.pane);
		return unplaced(ps.find((p) => p.pane_id === row.pane), ps, now, seen);
	});
}

/** The subagent panes a session marks: each gets `sb_order`, `sb_mark`, `sb_indent` and `sb_name`. */
export interface Kid { pane: string; order: string; mark: string; indent: string; name: string }

/**
 * What a session publishes besides its role: its own tokens (null clears them when Herdr cannot place the session, a tower has no mark, and none
 * has an indent or a name, which clears the ones a pane keeps from when it ran a subagent) and those of the subagents it launched, and whether one of those
 * has no pi pane yet (`waiting`). Reads Herdr only.
 */
export async function netTokens(run: HerdrRun, place: Place, role: "tower" | "main" | "member", name: string, now = Date.now(), world: HerdrWorld = worldOf(run)): Promise<{ own: Record<string, string | null>; kids: Kid[]; joined: Set<string>; waiting: boolean }> {
	const { panes: ps, workspaces: all, tabs: tabList } = await world(place.workspaceId);
	const pane = ps.find((p) => p.pane_id === place.paneId), key = pane && orderKey(role, pane, ps, all, tabList);
	const joined = new Set(ps.filter((p) => p.tokens?.sb_role).map((p) => p.pane_id));
	const tab = tabList.find((t) => t.tab_id === pane?.tab_id)?.label || null;
	const labels = { sb_main_tab: role === "main" ? tab : null, sb_tab: role === "member" ? tab : null, sb_member_tab: null };
	return { own: { sb_order: key ?? null, sb_mark: role === "tower" ? null : MARK[role], sb_indent: null, sb_name: null, ...labels }, kids: key ? descendants(pane, key, name, ps, now) : [], joined, waiting: Boolean(key) && unplaced(pane, ps, now) };
}

/**
 * Writes the subagents' tokens and clears those of subagent panes marked before and gone now, except a pane that has joined the net since
 * (a shell where a subagent ran can start a pi that writes its own). Returns the panes now marked. A failed write waits for the next refresh.
 */
export async function markKids(run: HerdrRun, kids: Kid[], before: Set<string>, joined = new Set<string>()): Promise<Set<string>> {
	for (const kid of kids) await report(run, "pane", kid.pane, { sb_order: kid.order, sb_mark: kid.mark, sb_indent: kid.indent, sb_name: kid.name }).catch(() => {});
	const marked = new Set(kids.map((k) => k.pane));
	await clearOrder(run, [...before].filter((id) => !marked.has(id) && !joined.has(id)));
	return marked;
}

/** Removes the four tokens from panes, ignoring a pane that has already closed. */
export const clearOrder = (run: HerdrRun, paneIds: string[]) => Promise.all(paneIds.map((id) => report(run, "pane", id, { sb_order: null, sb_mark: null, sb_indent: null, sb_name: null }).catch(() => {})));
