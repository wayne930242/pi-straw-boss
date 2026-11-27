import type { Net, Unit } from "./net.ts";

// Who works on a todo, found on the net (pi-todo-ledger 0.5.0: a todo launched with a subagent names that child in `owner`, the full pi-herdr-agents name, and `metadata.herdr.id`, its run id, which is the net's key of that subagent,
// src/net.ts; items.ts keeps the id only while the binding's name is still the owner). The id is the identity; a name is only a fallback, and only for an exact full name under the todo's own main, one unit and no other: never across
// mains, devices, or a box, never from the board's cut and scrubbed label, never a guess between two of one name (T1-F002). The 24-character `sb_name` token Herdr's rows show is cosmetic and never a key. Pure, and free of Node: the page
// (gui/plangraph.ts) and `/boss send #<id>` (bosspaths.ts) read the same answer.

/** A todo named in a command: `#63` (its id) or its uid (`t_` and ten base32 characters). */
export function todoRef(q: string): { id: number } | { uid: string } | undefined {
	const id = /^#(\d{1,9})$/.exec(q.trim())?.[1];
	return id !== undefined ? { id: Number(id) } : /^t_[a-z2-7]{10}$/.test(q.trim()) ? { uid: q.trim() } : undefined;
}
/** The unit that owns a todo, with its workspace (the route's), and whether it runs in a pane now. */
export interface OwnerHit { key: string; name: string; ws: string; live: boolean }
type Place = { u: Unit; ws: string };
const flat = (u: Unit, ws: string): Place[] => [{ u, ws }, ...u.subs.flatMap((s) => flat(s, ws))];
/** Every unit of the net with its workspace: the towers' subagents, the tabs' units and theirs, and the base's other panes. */
const places = (net: Pick<Net, "bases"> | undefined): Place[] => (net?.bases ?? []).flatMap((b) => [...(b.tower?.subs ?? []).flatMap((s) => flat(s, b.id)), ...b.tabs.flatMap((t) => t.units.flatMap((u) => flat(u, b.id))), ...b.outside.flatMap((u) => flat(u, b.id))]);
const hitOf = ({ u, ws }: Place): OwnerHit => ({ key: u.key, name: u.name, ws, live: u.control && !u.ended });

/**
 * The owner of a todo on the net: by `agent` (the Herdr child's run id) when the todo names one, `gone` when no unit has that key (the child left the net); else, with `byName`, by the exact `owner` among the subagents under `main` (a row name, or the
 * launch name, `Unit.alias`, when the row shows the script's file name): the one unit of that name, `ambiguous` for two or more (an old run and its successor too). Undefined otherwise: the owner is text.
 */
export function ownerOf(net: Pick<Net, "bases"> | undefined, main: string | undefined, ref: { owner?: string | undefined; agent?: string | undefined }, byName = true): OwnerHit | "gone" | "ambiguous" | undefined {
	const all = places(net);
	if (ref.agent) {
		const hit = all.find((p) => p.u.key === ref.agent);
		return hit ? hitOf(hit) : "gone";
	}
	const top = main ? all.find((p) => p.u.key === main) : undefined;
	if (!byName || !ref.owner || !top) return undefined;
	const found = flat(top.u, top.ws).filter((p) => p.u.key !== main && (p.u.name === ref.owner || p.u.alias === ref.owner));
	return found.length === 1 ? hitOf(found[0]!) : found.length ? "ambiguous" : undefined;
}
