import type { Net, Unit } from "./net.ts";

// Who works on a todo, found on the net (pi-todo-ledger 0.5.0: a todo launched with a subagent names that child in `owner`, the full pi-herdr-agents name, and `metadata.herdr.id`, its run id, which is the net's key of that subagent,
// src/net.ts). The id is looked for first, then the full name, under the main first; the 24-character `sb_name` token Herdr's rows show is cosmetic and never a key. Pure, and free of Node: the page (gui/plangraph.ts) and
// `/boss send #<id>` (bosspaths.ts) read the same answer.

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
function places(net: Pick<Net, "bases"> | undefined): Place[] {
	return (net?.bases ?? []).flatMap((b) => [...(b.tower?.subs ?? []).flatMap((s) => flat(s, b.id)), ...b.tabs.flatMap((t) => t.units.flatMap((u) => flat(u, b.id))), ...b.outside.flatMap((u) => flat(u, b.id))]);
}
const hitOf = ({ u, ws }: Place): OwnerHit => ({ key: u.key, name: u.name, ws, live: u.control && !u.ended });

/**
 * The owner of a todo on the net: by `agent` (the Herdr child's run id) when the todo names one, and then `gone` when no unit has that key, since the child it names has left the net; else by the full `owner` name, a unit under `main`
 * first (its own subagents, the nearest), then anywhere; of two of one name, the one that runs. Undefined when nothing on the net bears the name: an owner that is no agent (a person, a team) is text.
 */
export function ownerOf(net: Pick<Net, "bases"> | undefined, main: string | undefined, ref: { owner?: string | undefined; agent?: string | undefined }): OwnerHit | "gone" | undefined {
	const all = places(net);
	if (ref.agent) {
		const hit = all.find((p) => p.u.key === ref.agent);
		return hit ? hitOf(hit) : "gone";
	}
	if (!ref.owner) return undefined;
	const named = (p: Place) => p.u.name === ref.owner && p.u.key !== main, top = all.find((p) => p.u.key === main);
	const mine = top ? flat(top.u, top.ws).filter(named) : [], found = mine.length ? mine : all.filter(named), live = found.filter((p) => hitOf(p).live);
	const pick = found.length === 1 ? found[0] : live.length === 1 ? live[0] : undefined; // a name launched again: the one that runs
	return pick && hitOf(pick);
}
