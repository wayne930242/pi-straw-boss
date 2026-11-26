import type { Net, Unit } from "../src/net.ts";

// Who sent a message, as the net lists it (docs/specs/2026-11-26-storybook-theme/spec.md §B11): the chat's notices take the sender's icon from it where the view draws senders (icons.ts `senderRef`). Loaded with the chat.

/** The unit a message's sender names, by its key or else its name, anywhere in the net: the head (its crown), a tower, a unit, or a subagent; undefined for a name the net does not list (a teammate's, a session gone). */
export function senderIn(net: Net | undefined, name: string, id?: string): { role: string; duty?: string } | undefined {
	if (!net || !(name || id)) return undefined;
	const all = (us: Unit[]): Unit[] => us.flatMap((u) => [u, ...all(u.subs)]);
	const towers = net.bases.flatMap((b) => (b.tower ? [{ key: b.tower.key, name: b.tower.name, role: "tower" }, ...all(b.tower.subs)] : []));
	const known: { key: string; name: string; role: string; duty?: string }[] = [...(net.head ? [{ key: net.head.key, name: net.head.name, role: "crown" }] : []), ...towers, ...net.bases.flatMap((b) => all([...b.tabs.flatMap((t) => t.units), ...b.outside]))];
	const hit = (id && known.find((u) => u.key === id)) || (name && known.find((u) => u.name === name));
	return hit ? { role: hit.role, ...(hit.duty ? { duty: hit.duty } : {}) } : undefined;
}
